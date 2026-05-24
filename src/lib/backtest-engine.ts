// Reusable backtest engine. Given a list of agent configs and a list of
// real historical entries (one per qualifying market for each agent), this
// runs the portfolio through the entries chronologically and reports the
// per-day equity trajectory plus final outcome.
//
// "Entries" are real things that happened. The engine doesn't make anything
// up: it just decides what the agents would have done if they'd seen those
// signals, with their real-world Kelly sizing and caps and killswitch.
//
// Used both for deterministic replay (just sort entries by timestamp and run)
// and bootstrap (entries get repacked into a synthetic timeline first).
//
// Optional MTM mode: if you pass a price-lookup function, the engine will
// check the killswitch at daily intervals using mark-to-market portfolio
// equity. Without it, only entry/settle events trigger killswitch checks.

export type AgentConfig = {
  name: string;
  alloc_pct: number;
  kelly_full: number;          // pre-computed full-Kelly fraction (the FALLBACK / warmup prior)
  kelly_mult: number;
  max_pct_per_trade: number;
  max_concurrent: number;
  // Optional live-mimicry fields. When set on at least one agent, the engine
  // models the live runtime's:
  //   - dynamic Kelly switch (after 20+ settled in rolling 60d, use actual WR)
  //   - health monitor (WATCH 0.5x Kelly, BROKEN 0.25x, auto-pause)
  // Each agent's spec_wr_prior and avg_entry_price are needed to recompute
  // fullKelly() when the dynamic switch fires.
  live_mimicry?: boolean;
  spec_wr_prior?: number;
  avg_entry_price?: number;
};

export type Entry = {
  agent_idx: number;
  entry_time_h: number;        // hours from window start
  entry_price: number;
  duration_h: number;
  won: 0 | 1;
  // Optional fields for MTM and liquidity-capped sizing
  condition_id?: string;
  outcome?: "YES" | "NO";
  vol_24h?: number;
  abs_entry_ts?: number;       // absolute epoch ms when entry happened in source
};

export type WindowOutcome = {
  trajectory: number[];        // equity per day, length = days + 1, starts at total_start
  final_equity: number;
  killed: boolean;
  killed_day: number;          // -1 if not killed
  killed_by_mtm: boolean;      // true if killed by MTM check (not settle event)
  agent_entries: number[];
  agent_wins: number[];
  agent_losses: number[];
  agent_pnl: number[];         // per-agent net P&L over the window
  // Daily activity counters, length = days + 1.
  daily_entries: number[];     // positions opened on each day
  daily_wins: number[];        // winning settles on each day
  daily_losses: number[];      // losing settles on each day
  daily_realized_pnl: number[];// cash delta from settles on each day (stake recovered/lost)
};

// Price lookup signature: given (condition_id, outcome, absolute_ts_ms),
// return the most recent known price for that side, or null if unknown.
export type PriceLookup = (condition_id: string, outcome: "YES" | "NO", abs_ts: number) => number | null;

export type EngineConfig = {
  agents: AgentConfig[];
  starting_bankroll: number;   // total across agents
  days: number;                // window length in days
  killswitch_dd_pct: number;
  // Optional: enable MTM-aware killswitch using daily checkpoints
  price_lookup?: PriceLookup;
  window_start_abs_ts?: number;   // absolute epoch ms of window start (for price_lookup)
  // Optional: liquidity cap on stake (fraction of recent volume)
  liquidity_max_stake_frac_of_vol?: number;
  // Optional: "pocket" capital mode. When an open position has its priced
  // side pinned at >= pocket_pin_threshold, treat its expected payoff as
  // available credit for new trades and exclude the position from the
  // max_concurrent count. Models a perfect "free up decided-winning capital
  // before Polymarket officially closes" behavior. Defaults off.
  pocket_enabled?: boolean;
  pocket_pin_threshold?: number;   // default 0.97 if pocket_enabled and unset
  // Optional real-world friction. Both default to 0 (no friction).
  // entry_slippage_pct: 0.005 means actual fill price is 0.5% above signal,
  //   so the bot buys fewer shares per dollar. Hits losers and winners alike.
  // fee_on_winnings_pct: 0.02 means the bot keeps 98% of the win payoff.
  //   Only hits winning settles; losses still cost full stake.
  entry_slippage_pct?: number;
  fee_on_winnings_pct?: number;
  // Live-mimicry only: when false, agents never auto-pause on 40%+ DD or
  // 14d BROKEN. Health classification still applies (Kelly throttle on
  // WATCH/BROKEN), but the bot keeps trading at reduced size instead of
  // halting. Use for long-horizon single-window replays where the autonomous
  // pause is unrealistic (live operators would manually unpause).
  auto_pause_enabled?: boolean;
};

export function runWindow(entries: Entry[], cfg: EngineConfig): WindowOutcome {
  const nAgents = cfg.agents.length;
  const cashByAgent = cfg.agents.map((a) => cfg.starting_bankroll * a.alloc_pct);
  const startCashByAgent = cashByAgent.slice();
  const kellyStakeFrac = cfg.agents.map((a) => Math.min(a.kelly_full * a.kelly_mult, a.max_pct_per_trade));

  type OpenPos = {
    agent_idx: number;
    stake: number;
    shares: number;
    payoff_if_win: number;
    resolve_h: number;
    won: 0 | 1;
    condition_id?: string;
    outcome?: "YES" | "NO";
    entry_price: number;
  };
  const open: OpenPos[] = [];
  const agent_entries = new Array(nAgents).fill(0);
  const agent_wins = new Array(nAgents).fill(0);
  const agent_losses = new Array(nAgents).fill(0);
  const daily_entries: number[] = new Array(cfg.days + 1).fill(0);
  const daily_wins: number[] = new Array(cfg.days + 1).fill(0);
  const daily_losses: number[] = new Array(cfg.days + 1).fill(0);
  const daily_realized_pnl: number[] = new Array(cfg.days + 1).fill(0);
  const dayIdx = (h: number): number => Math.min(cfg.days, Math.max(0, Math.floor(h / 24)));

  // Live-mimicry state. Mirrors the live runtime's per-agent rolling tracking:
  // settled trades for dynamic-Kelly (60d) and health (30d), peak equity for
  // drawdown, broken_since timestamp for 14d auto-pause, paused flag.
  const WINDOW_START_MS = cfg.window_start_abs_ts ?? 0;
  const ROLLING_60D_MS = 60 * 86400 * 1000;
  const ROLLING_30D_MS = 30 * 86400 * 1000;
  const BROKEN_PAUSE_MS = 14 * 86400 * 1000;
  const HEALTH_MIN_SAMPLES = 15;
  const DYNAMIC_KELLY_MIN_SAMPLES = 20;
  const settledHistory: Array<Array<{ tsMs: number; won: 0 | 1 }>> = cfg.agents.map(() => []);
  const agentPaused: boolean[] = cfg.agents.map(() => false);
  const agentPeakEquity: number[] = cashByAgent.slice();
  const brokenSince: Array<number | null> = cfg.agents.map(() => null);
  const liveMimicryOn = cfg.agents.some((a) => a.live_mimicry === true);

  const sortedEntries = entries.slice().sort((a, b) => a.entry_time_h - b.entry_time_h);

  const trajectory: number[] = new Array(cfg.days + 1);
  trajectory[0] = cfg.starting_bankroll;
  let nextSampleDay = 1;
  const totalHours = cfg.days * 24;

  const stakeEquity = (): number =>
    cashByAgent.reduce((s, c) => s + c, 0) + open.reduce((s, o) => s + o.stake, 0);

  // MTM-aware equity at hour h within the window. If MTM lookup is available,
  // use current prices for open positions. Otherwise fall back to stake.
  const mtmEquity = (hourInWindow: number): number => {
    if (!cfg.price_lookup || !cfg.window_start_abs_ts) return stakeEquity();
    let eq = cashByAgent.reduce((s, c) => s + c, 0);
    const absTs = cfg.window_start_abs_ts + hourInWindow * 3600_000;
    for (const o of open) {
      if (!o.condition_id || !o.outcome) {
        eq += o.stake;
        continue;
      }
      const px = cfg.price_lookup(o.condition_id, o.outcome, absTs);
      if (px == null) {
        eq += o.stake;
      } else {
        eq += o.shares * px;
      }
    }
    return eq;
  };

  const sampleEquityAtH = (h: number) => {
    while (nextSampleDay <= cfg.days && nextSampleDay * 24 <= h) {
      trajectory[nextSampleDay] = mtmEquity(nextSampleDay * 24);
      nextSampleDay++;
    }
  };

  let killed = false, killed_day = -1, killed_by_mtm = false;
  let i = 0;
  // Daily MTM checkpoint walker
  let nextMtmCheckH = cfg.price_lookup ? 24 : Infinity;

  while (true) {
    // Determine next event: entry, settle, or MTM checkpoint
    let nextH = Infinity;
    let nextKind: "entry" | "settle" | "mtm" = "entry";
    let nextIdx = -1;
    if (i < sortedEntries.length) {
      nextH = sortedEntries[i].entry_time_h;
      nextKind = "entry";
      nextIdx = i;
    }
    for (let j = 0; j < open.length; j++) {
      if (open[j].resolve_h < nextH && open[j].resolve_h <= totalHours) {
        nextH = open[j].resolve_h;
        nextKind = "settle";
        nextIdx = j;
      }
    }
    if (nextMtmCheckH < nextH && nextMtmCheckH <= totalHours) {
      nextH = nextMtmCheckH;
      nextKind = "mtm";
    }
    if (nextH === Infinity || nextH > totalHours) break;

    sampleEquityAtH(nextH);

    if (nextKind === "settle") {
      const o = open[nextIdx];
      const settleDay = dayIdx(nextH);
      if (o.won === 1) {
        cashByAgent[o.agent_idx] += o.payoff_if_win;
        agent_wins[o.agent_idx]++;
        daily_wins[settleDay]++;
        daily_realized_pnl[settleDay] += o.payoff_if_win - o.stake;
      } else {
        agent_losses[o.agent_idx]++;
        daily_losses[settleDay]++;
        daily_realized_pnl[settleDay] += -o.stake;
      }
      if (liveMimicryOn) {
        const settleTsMs = WINDOW_START_MS + nextH * 3600_000;
        settledHistory[o.agent_idx].push({ tsMs: settleTsMs, won: o.won });
      }
      open.splice(nextIdx, 1);
    } else if (nextKind === "entry") {
      const e = sortedEntries[nextIdx];
      i++;
      const a = cfg.agents[e.agent_idx];
      // Live-mimicry guard: pause check + dynamic Kelly + health throttle.
      // Falls through to the legacy kellyStakeFrac when live_mimicry is off
      // for this agent.
      let liveKellyOverride: number | null = null;
      const autoPauseOn = cfg.auto_pause_enabled !== false;
      if (a.live_mimicry === true && a.spec_wr_prior !== undefined && a.avg_entry_price !== undefined) {
        if (agentPaused[e.agent_idx]) continue;
        const entryTsMs = WINDOW_START_MS + e.entry_time_h * 3600_000;
        // Equity + drawdown from peak (agent-level, not portfolio-level).
        let agentOpenStake = 0;
        for (const o of open) if (o.agent_idx === e.agent_idx) agentOpenStake += o.stake;
        const agentEquity = cashByAgent[e.agent_idx] + agentOpenStake;
        if (agentEquity > agentPeakEquity[e.agent_idx]) agentPeakEquity[e.agent_idx] = agentEquity;
        const ddPct = agentPeakEquity[e.agent_idx] > 0
          ? (agentPeakEquity[e.agent_idx] - agentEquity) / agentPeakEquity[e.agent_idx] * 100
          : 0;
        // Catastrophic DD auto-pause (matches live's >=40% rule). Skipped when
        // auto_pause_enabled is false; health throttling still applies.
        if (autoPauseOn && ddPct >= 40) { agentPaused[e.agent_idx] = true; continue; }
        // Health classification (matches live's thresholds).
        const cutoff30 = entryTsMs - ROLLING_30D_MS;
        let n30 = 0, w30 = 0;
        for (const s of settledHistory[e.agent_idx]) {
          if (s.tsMs >= cutoff30) { n30++; if (s.won === 1) w30++; }
        }
        let health: "healthy" | "watch" | "broken" = "healthy";
        if (ddPct >= 25) health = "broken";
        else if (ddPct >= 15) health = "watch";
        else if (n30 >= HEALTH_MIN_SAMPLES) {
          const actualWr = w30 / n30;
          const delta = a.spec_wr_prior - actualWr;
          if (delta >= 0.10) health = "broken";
          else if (delta >= 0.03) health = "watch";
        }
        // 14-day BROKEN auto-pause. Skipped when auto_pause_enabled is false;
        // Kelly stays throttled at 0.25x while broken.
        if (health === "broken") {
          if (brokenSince[e.agent_idx] === null) brokenSince[e.agent_idx] = entryTsMs;
          if (autoPauseOn && entryTsMs - (brokenSince[e.agent_idx] as number) >= BROKEN_PAUSE_MS) {
            agentPaused[e.agent_idx] = true;
            continue;
          }
        } else {
          brokenSince[e.agent_idx] = null;
        }
        const healthMult = health === "broken" ? 0.25 : health === "watch" ? 0.5 : 1.0;
        // Dynamic Kelly: rolling 60d, 20+ settled within window.
        const cutoff60 = entryTsMs - ROLLING_60D_MS;
        let n60 = 0, w60 = 0;
        for (const s of settledHistory[e.agent_idx]) {
          if (s.tsMs >= cutoff60) { n60++; if (s.won === 1) w60++; }
        }
        let baseKellyFull = a.kelly_full;
        if (n60 >= DYNAMIC_KELLY_MIN_SAMPLES) {
          const wr60 = w60 / n60;
          baseKellyFull = fullKelly(wr60, a.avg_entry_price);
        }
        liveKellyOverride = Math.min(baseKellyFull * a.kelly_mult * healthMult, a.max_pct_per_trade);
      }
      // Pocket-capital adjustments: when enabled, exclude pinned-winning
      // open positions from the slot count, and add their MTM value to the
      // cash basis used for Kelly sizing. Both effects only apply if we have
      // a price_lookup to detect "pinned" state.
      const pocketEnabled = cfg.pocket_enabled === true && cfg.price_lookup;
      const pinThresh = cfg.pocket_pin_threshold ?? 0.97;
      const absTs = (cfg.window_start_abs_ts ?? 0) + nextH * 3600_000;
      let myOpen = 0;
      let pocketCredit = 0;
      for (const o of open) {
        if (o.agent_idx !== e.agent_idx) continue;
        let pinned = false;
        if (pocketEnabled && o.condition_id && o.outcome) {
          const p = cfg.price_lookup!(o.condition_id, o.outcome, absTs);
          if (p !== null && p >= pinThresh) {
            pinned = true;
            pocketCredit += o.shares * p - o.stake;   // realized profit, not yet in cash
          }
        }
        if (!pinned) myOpen++;
      }
      if (myOpen >= a.max_concurrent) continue;
      const effectiveCash = cashByAgent[e.agent_idx] + pocketCredit;
      if (effectiveCash < 1) continue;
      const kellyForThisEntry = liveKellyOverride !== null ? liveKellyOverride : kellyStakeFrac[e.agent_idx];
      let stake = Math.min(effectiveCash * kellyForThisEntry, effectiveCash * 0.95);
      // Pocket deployment: stake can use up to POCKET_DEPLOY_FRACTION of the
      // pocket credit on top of real cash. The 10% haircut absorbs the rare
      // de-pin risk so the ledger stays positive even if a pinned position
      // fails to settle in our favor. Matches placePaperBuy in live runtime.
      const POCKET_DEPLOY_FRACTION = 0.90;
      const spendableCap = Math.max(0, cashByAgent[e.agent_idx]) + POCKET_DEPLOY_FRACTION * Math.max(0, pocketCredit);
      stake = Math.min(stake, spendableCap);
      // Liquidity cap: only apply when we have meaningful 24h-volume data.
      // For tiny / unknown volume markets, the cap would be unrealistically
      // tight (you'd never trade). Real Polymarket usually accepts modest
      // stakes even on small-volume markets at the quoted price.
      if (cfg.liquidity_max_stake_frac_of_vol != null && e.vol_24h != null && e.vol_24h >= 100) {
        const maxByLiquidity = e.vol_24h * cfg.liquidity_max_stake_frac_of_vol;
        stake = Math.min(stake, maxByLiquidity);
      }
      if (stake < 0.5) continue;
      // Apply entry slippage: actual fill is at signal_price * (1 + slippage).
      // Result: fewer shares for same stake, smaller payoff if won.
      const slippage = cfg.entry_slippage_pct ?? 0;
      const fillPrice = e.entry_price * (1 + slippage);
      const shares = stake / fillPrice;
      // Apply fee on winning payoff: keep (1 - fee) of the 1.0-per-share payout.
      const feeRate = cfg.fee_on_winnings_pct ?? 0;
      const payoff = shares * (1 - feeRate);
      open.push({
        agent_idx: e.agent_idx, stake, shares,
        payoff_if_win: payoff,
        resolve_h: e.entry_time_h + e.duration_h,
        won: e.won,
        condition_id: e.condition_id,
        outcome: e.outcome,
        entry_price: e.entry_price,
      });
      cashByAgent[e.agent_idx] -= stake;
      agent_entries[e.agent_idx]++;
      daily_entries[dayIdx(e.entry_time_h)]++;
    } else {
      // MTM checkpoint
      nextMtmCheckH += 24;
    }

    // Killswitch check. Use MTM if enabled, otherwise stake equity.
    const eq = (nextKind === "mtm" || cfg.price_lookup) ? mtmEquity(nextH) : stakeEquity();
    const lossPct = ((cfg.starting_bankroll - eq) / cfg.starting_bankroll) * 100;
    if (lossPct >= cfg.killswitch_dd_pct) {
      killed = true;
      killed_day = Math.floor(nextH / 24);
      killed_by_mtm = (nextKind === "mtm");
      break;
    }
  }

  // Final settlements within window
  if (!killed) {
    const still: OpenPos[] = [];
    for (const o of open) {
      if (o.resolve_h <= totalHours) {
        if (o.won === 1) { cashByAgent[o.agent_idx] += o.payoff_if_win; agent_wins[o.agent_idx]++; }
        else { agent_losses[o.agent_idx]++; }
      } else still.push(o);
    }
    open.length = 0;
    open.push(...still);
  }

  // Fill remaining trajectory slots
  while (nextSampleDay <= cfg.days) {
    trajectory[nextSampleDay] = killed ? (trajectory[nextSampleDay - 1] ?? cfg.starting_bankroll) : mtmEquity(nextSampleDay * 24);
    nextSampleDay++;
  }
  if (killed) {
    for (let d = (killed_day || 0) + 1; d <= cfg.days; d++) trajectory[d] = trajectory[killed_day];
  }

  // Per-agent net P&L = current cash - starting cash + value of any still-open positions held at stake.
  const agent_pnl = new Array(nAgents).fill(0);
  for (let ai = 0; ai < nAgents; ai++) {
    let openValue = 0;
    for (const o of open) if (o.agent_idx === ai) openValue += o.stake;
    agent_pnl[ai] = (cashByAgent[ai] + openValue) - startCashByAgent[ai];
  }

  return {
    trajectory,
    final_equity: trajectory[cfg.days] ?? stakeEquity(),
    killed,
    killed_day,
    killed_by_mtm,
    agent_entries,
    agent_wins,
    agent_losses,
    agent_pnl,
    daily_entries,
    daily_wins,
    daily_losses,
    daily_realized_pnl,
  };
}

export function fullKelly(wr_spec: number, price_spec: number): number {
  const b = (1 - price_spec) / price_spec;
  return Math.max(0, (wr_spec * b - (1 - wr_spec)) / b);
}
