// Live paper-trading runtime. Polls Polymarket Data API every 30s for the
// global trade stream, computes momentum signals inline, dispatches to
// agents that match, places paper buys, periodically settles positions when
// markets resolve. Pure simulation - no real money, no actual orders sent.

import postgres from "postgres";
import type { Sql } from "postgres";
import { notify } from "./email";
import { ensureMomentumHistoryForMarket } from "./momentum-backfill";

export type Agent = {
  id: string;
  name: string;
  strategy: {
    price_min: number;
    price_max: number;
    mom_24h_min?: number;
    mom_24h_max?: number;
    // Volatility filter. vol_24h is the population stddev of the last 24h of
    // same-side prices (matches scripts/compute-features.ts:49). Used to
    // distinguish stable-pinned markets ("calm") from flickering ones
    // ("choppy"); the cell search showed strong WR boosts when restricting
    // to calm bands. Trades with insufficient history (<4 samples in 24h)
    // return null and fail any vol filter that's set.
    vol_24h_min?: number;
    vol_24h_max?: number;
    hours_to_resolve_min?: number;
    hours_to_resolve_max?: number;
    size_min?: number;          // trade-size filter at entry; 0 = no filter
    size_max?: number;          // upper bound; large = no filter
    direction: "buy_priced_side";
    description: string;
    wr_prior?: number;
  };
  current_bankroll: number;
  peak_bankroll: number;
  starting_bankroll: number;
  kelly_mult: number;
  max_pct_per_trade: number;
  max_concurrent_positions: number;
  max_drawdown_pct: number;
  status: "active" | "paused" | "killed" | "archived";
  trades_count: number;
  wins_count: number;
  losses_count: number;
  health?: "healthy" | "watch" | "broken";
  phase?: "watch" | "paper" | "live_small" | "live_full" | "retired";
};

type LiveTrade = {
  conditionId: string;
  outcome: "Yes" | "No";
  side: "BUY" | "SELL";
  price: number;
  size: number;
  timestamp: number;
  proxyWallet?: string;
};

type GammaMarket = {
  conditionId?: string;
  question?: string;
  slug?: string;
  category?: string;
  endDate?: string;
  closedTime?: string | null;
  closed?: boolean;
  outcomePrices?: string;
  volume?: string;
};

const POLL_INTERVAL_MS = 30_000;
const SETTLE_INTERVAL_MS = 5 * 60_000;
const SNAPSHOT_INTERVAL_MS = 60 * 60_000;
const DATA_API = process.env.POLYMARKET_DATA ?? "https://data-api.polymarket.com";
const GAMMA = process.env.POLYMARKET_GAMMA ?? "https://gamma-api.polymarket.com";
const HOUR_MS = 3600 * 1000;
// Liquidity gate: a candidate trade is dispatched only if the market has had
// at least this much dollar trade volume in the 24h preceding the trade.
// Matches the proposal backtest's filter so live and backtest behave the same.
const MIN_PRE_VOL_24H_USD = Number(process.env.MIN_PRE_VOL_24H_USD ?? 5000);

async function fetchJson<T>(url: string, attempt = 1): Promise<T> {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 20_000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) {
      if ((r.status === 429 || r.status >= 500) && attempt < 5) {
        await new Promise((res) => setTimeout(res, 1000 * attempt));
        return fetchJson(url, attempt + 1);
      }
      throw new Error(`${url} -> HTTP ${r.status}`);
    }
    return (await r.json()) as T;
  } finally {
    clearTimeout(to);
  }
}

function parseOutcome(raw?: string): "YES" | "NO" | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw) as string[];
    const prices = arr.map((s) => parseFloat(s));
    if (prices.length === 2 && Math.abs(prices[0] + prices[1] - 1) < 0.01) {
      return prices[0] > 0.5 ? "YES" : "NO";
    }
    return null;
  } catch { return null; }
}

function parsePrices(raw?: string): { yes: number | null; no: number | null } {
  if (!raw) return { yes: null, no: null };
  try {
    const arr = JSON.parse(raw) as string[];
    const p = arr.map((s) => parseFloat(s));
    if (p.length === 2 && p.every((x) => Number.isFinite(x))) return { yes: p[0], no: p[1] };
    return { yes: null, no: null };
  } catch { return { yes: null, no: null }; }
}

export async function loadAgents(sql: Sql): Promise<Agent[]> {
  const rows = await sql<Agent[]>`
    SELECT id, name, strategy_spec_json::jsonb AS strategy,
           current_bankroll, peak_bankroll, starting_bankroll,
           kelly_mult, max_pct_per_trade, max_concurrent_positions, max_drawdown_pct,
           status, trades_count, wins_count, losses_count,
           health, phase
    FROM paper_agents
    WHERE status = 'active'
  `;
  return rows.map((r) => ({
    ...r,
    strategy: typeof r.strategy === "string" ? JSON.parse(r.strategy) : r.strategy,
  }));
}

async function getMarketState(sql: Sql, conditionId: string): Promise<{ end_date: string | null; resolution_ts: number | null; resolved_outcome: string | null } | null> {
  const rows = await sql<Array<{ end_date: string | null; resolution_ts: number | null; resolved_outcome: string | null }>>`
    SELECT to_char(end_date, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS end_date, resolution_ts, resolved_outcome
    FROM live_market_state WHERE condition_id = ${conditionId}
  `;
  return rows[0] ?? null;
}

async function fetchAndCacheMarket(sql: Sql, conditionId: string): Promise<{ end_date: string | null; resolution_ts: number | null; resolved_outcome: string | null }> {
  try {
    // Gamma's default /markets query filters out closed markets. When a market
    // resolves, it disappears from the default listing and our cache would
    // stay at resolved_outcome=null forever, trapping any position on it.
    // Retry with closed=true so we always pick up the post-resolution state.
    let ms = await fetchJson<GammaMarket[]>(`${GAMMA}/markets?condition_ids=${conditionId}&limit=1`);
    if (ms.length === 0) {
      ms = await fetchJson<GammaMarket[]>(`${GAMMA}/markets?condition_ids=${conditionId}&closed=true&limit=1`);
    }
    const m = ms[0];
    if (!m) return { end_date: null, resolution_ts: null, resolved_outcome: null };
    const endMs = m.endDate ? new Date(m.endDate).getTime() : null;
    const closedMs = m.closedTime ? new Date(m.closedTime).getTime() : endMs;
    const resolved = parseOutcome(m.outcomePrices);
    const prices = parsePrices(m.outcomePrices);
    await sql`
      INSERT INTO live_market_state (condition_id, question, slug, category, end_date, resolution_ts, resolved_outcome, current_yes_price, current_no_price, volume_usd, last_polled_at)
      VALUES (${conditionId}, ${m.question ?? null}, ${m.slug ?? null}, ${m.category ?? null},
              ${m.endDate ?? null}, ${closedMs}, ${m.closed ? resolved : null},
              ${prices.yes}, ${prices.no},
              ${parseFloat(m.volume ?? "0")}, ${Date.now()})
      ON CONFLICT (condition_id) DO UPDATE SET
        resolution_ts = EXCLUDED.resolution_ts,
        resolved_outcome = EXCLUDED.resolved_outcome,
        current_yes_price = EXCLUDED.current_yes_price,
        current_no_price = EXCLUDED.current_no_price,
        volume_usd = EXCLUDED.volume_usd,
        last_polled_at = EXCLUDED.last_polled_at
    `;
    return { end_date: m.endDate ?? null, resolution_ts: closedMs, resolved_outcome: m.closed ? resolved : null };
  } catch {
    return { end_date: null, resolution_ts: null, resolved_outcome: null };
  }
}

// Computes mom over the requested window. Returns null if there's no live
// trade older than `lookbackMs` for this market+outcome.
async function computeMom(sql: Sql, conditionId: string, outcome: string, ts: number, currentPrice: number, lookbackMs: number): Promise<number | null> {
  const rows = await sql<Array<{ price: number }>>`
    SELECT price FROM live_trades
    WHERE condition_id = ${conditionId} AND outcome = ${outcome} AND ts <= ${ts - lookbackMs}
    ORDER BY ts DESC LIMIT 1
  `;
  if (rows.length === 0) return null;
  return currentPrice - rows[0].price;
}

// Population stddev of last-24h same-side prices. Matches the offline
// feature definition in scripts/compute-features.ts:49 (STDDEV_POP, requires
// at least 4 samples). Returns null when insufficient history is available.
async function computeVol24h(sql: Sql, conditionId: string, outcome: string, ts: number): Promise<number | null> {
  const rows = await sql<Array<{ stddev: number | null; n: number }>>`
    SELECT STDDEV_POP(price)::float8 AS stddev, COUNT(*)::int AS n
    FROM live_trades
    WHERE condition_id = ${conditionId} AND outcome = ${outcome}
      AND ts >= ${ts - 24 * HOUR_MS} AND ts <= ${ts}
  `;
  if (rows[0].n < 4 || rows[0].stddev === null) return null;
  return rows[0].stddev;
}

// Get mom_24h with fallback to mom_6h then mom_1h. Returns whichever is
// available, prioritizing the longest window. Strategies that filter on
// mom_24h still match on the value returned here.
async function computeMom24h(sql: Sql, conditionId: string, outcome: string, ts: number, currentPrice: number): Promise<number | null> {
  const m24 = await computeMom(sql, conditionId, outcome, ts, currentPrice, 24 * HOUR_MS);
  if (m24 !== null) return m24;
  const m6 = await computeMom(sql, conditionId, outcome, ts, currentPrice, 6 * HOUR_MS);
  if (m6 !== null) return m6;
  const m1 = await computeMom(sql, conditionId, outcome, ts, currentPrice, HOUR_MS);
  if (m1 !== null) return m1;
  return null;
}

// Dynamic Kelly WR. Returns rolling-60d actual WR if the agent has >= 20
// settled positions in that window. Otherwise falls back to the spec's
// wr_prior. Returns undefined if neither is available (very new agent with
// no spec prior - should not happen for our agents but kept for safety).
async function dynamicKellyWR(sql: Sql, agent: Agent): Promise<number | undefined> {
  const ROLLING_MS = 60 * 86400 * 1000;
  const cutoff = Date.now() - ROLLING_MS;
  const rows = await sql<Array<{ n: number; w: number }>>`
    SELECT
      COUNT(*)::int AS n,
      (COUNT(*) FILTER (WHERE realized_pnl > 0))::int AS w
    FROM paper_positions
    WHERE agent_id = ${agent.id} AND status = 'closed' AND exit_ts >= ${cutoff}
  `;
  if (rows[0].n >= 20) return rows[0].w / rows[0].n;
  const legacyPriors: Record<string, number> = {
    near_resolution_skim: 0.96,
    heavy_favorite_steady: 0.88,
    mom_rising_mid: 0.67,
    mom_rising_longshot: 0.32,
  };
  const specWr = (agent.strategy as { wr_prior?: number }).wr_prior;
  return specWr ?? legacyPriors[agent.name];
}

// Health monitor: classifies an agent as healthy/watch/broken based on
// rolling-30d actual WR vs prior WR and accumulated drawdown. Persists the
// new health state, logs transitions, and auto-pauses agents that have been
// BROKEN for 14+ days. Should be called periodically (every 10 min), not
// per-trade.
const HEALTH_BROKEN_PAUSE_THRESHOLD_MS = 14 * 86400 * 1000;
const HEALTH_MIN_SAMPLES = 15;

export async function checkAgentHealth(sql: Sql, agent: Agent): Promise<{ health: string; changed: boolean }> {
  const ROLLING_MS = 30 * 86400 * 1000;
  const cutoff = Date.now() - ROLLING_MS;
  const rows = await sql<Array<{ n: number; w: number }>>`
    SELECT
      COUNT(*) FILTER (WHERE exit_ts >= ${cutoff})::int AS n,
      COUNT(*) FILTER (WHERE exit_ts >= ${cutoff} AND realized_pnl > 0)::int AS w
    FROM paper_positions
    WHERE agent_id = ${agent.id} AND status = 'closed'
  `;
  const n = rows[0].n;
  const w = rows[0].w;

  // Current state from DB
  const currentRow = await sql<Array<{
    health: string; watch_since: number | null; broken_since: number | null;
    notify_on_health_change: boolean; peak_bankroll: number; current_bankroll: number;
    starting_bankroll: number; phase: string; status: string;
  }>>`
    SELECT health, watch_since, broken_since, notify_on_health_change,
           peak_bankroll, current_bankroll, starting_bankroll, phase, status
    FROM paper_agents WHERE id = ${agent.id}
  `;
  if (currentRow.length === 0) return { health: "unknown", changed: false };
  const current = currentRow[0];

  // Compute live equity (cash + committed) and drawdown from peak.
  const commit = await sql<Array<{ committed: number }>>`
    SELECT COALESCE(SUM(stake), 0)::float8 AS committed
    FROM paper_positions WHERE agent_id = ${agent.id} AND status = 'open'
  `;
  const equity = current.current_bankroll + commit[0].committed;
  const peak = Math.max(current.peak_bankroll, equity);
  const ddPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;

  // Classify health. Need enough samples for WR-based judgment.
  const specWr = (agent.strategy as { wr_prior?: number }).wr_prior ?? 0.5;
  const actualWr = n > 0 ? w / n : null;
  const delta = (actualWr !== null) ? specWr - actualWr : 0;
  let newHealth: "healthy" | "watch" | "broken" = "healthy";
  let reason = "ok";
  if (ddPct >= 25) {
    newHealth = "broken";
    reason = `DD=${ddPct.toFixed(0)}% >= 25%`;
  } else if (ddPct >= 15) {
    newHealth = "watch";
    reason = `DD=${ddPct.toFixed(0)}% >= 15%`;
  } else if (n >= HEALTH_MIN_SAMPLES) {
    if (delta >= 0.10) {
      newHealth = "broken";
      reason = `WR=${(actualWr! * 100).toFixed(0)}% << prior=${(specWr * 100).toFixed(0)}% (-${(delta * 100).toFixed(0)}pp, n=${n})`;
    } else if (delta >= 0.03) {
      newHealth = "watch";
      reason = `WR drift -${(delta * 100).toFixed(1)}pp (actual=${(actualWr! * 100).toFixed(0)}%, prior=${(specWr * 100).toFixed(0)}%, n=${n})`;
    } else {
      reason = `WR=${(actualWr! * 100).toFixed(0)}% within 3pp of prior=${(specWr * 100).toFixed(0)}% (n=${n})`;
    }
  } else {
    reason = `insufficient samples (n=${n}<${HEALTH_MIN_SAMPLES}), assumed healthy`;
  }

  const now = Date.now();
  // Update timestamps based on state transitions.
  let watchSince = current.watch_since;
  let brokenSince = current.broken_since;
  if (newHealth === "watch" && current.health !== "watch") watchSince = now;
  if (newHealth === "broken" && current.health !== "broken") brokenSince = now;
  if (newHealth === "healthy") {
    watchSince = null;
    brokenSince = null;
  }

  await sql`
    UPDATE paper_agents
    SET health = ${newHealth},
        watch_since = ${watchSince},
        broken_since = ${brokenSince},
        last_health_check_at = ${now},
        peak_bankroll = ${peak}
    WHERE id = ${agent.id}
  `;

  const changed = current.health !== newHealth;
  if (changed) {
    await sql`
      INSERT INTO strategy_health_log
        (agent_id, ts, prev_health, new_health, actual_wr, prior_wr, n_settled, drawdown_pct, reason)
      VALUES (${agent.id}, ${now}, ${current.health}, ${newHealth},
              ${actualWr}, ${specWr}, ${n}, ${ddPct}, ${reason})
    `;
    if (current.notify_on_health_change) {
      await notify(sql, {
        subject: `[polywork] ${agent.name} health: ${current.health} -> ${newHealth}`,
        body: `Agent ${agent.name} (${agent.id}) health changed: ${current.health} -> ${newHealth}\n\n` +
              `Reason: ${reason}\n` +
              `actual WR (30d): ${actualWr !== null ? (actualWr * 100).toFixed(1) + "%" : "n/a"}\n` +
              `prior WR: ${(specWr * 100).toFixed(1)}%\n` +
              `n_settled (30d): ${n}\n` +
              `drawdown from peak: ${ddPct.toFixed(1)}%\n` +
              `equity: $${equity.toFixed(2)}  peak: $${peak.toFixed(2)}\n`,
      });
    }
  }

  // Alert-only mode: notify on severe conditions but DO NOT pause the agent.
  // Kelly is already throttled by health state (WATCH 0.5x, BROKEN 0.25x) via
  // placePaperBuy's read of agent.health, so size shrinks even without pause.
  // In-memory debounce: re-alert no more than once per agent per 24h while
  // the condition persists. Resets on worker restart (acceptable; first alert
  // after restart is informative anyway).
  const brokenLongEnough = newHealth === "broken" && brokenSince !== null && (now - brokenSince) >= HEALTH_BROKEN_PAUSE_THRESHOLD_MS;
  const catastrophicDD = ddPct >= 40;
  if ((brokenLongEnough || catastrophicDD) && current.status === "active") {
    const ALERT_DEBOUNCE_MS = 24 * 3600 * 1000;
    const lastAt = healthAlertLastAt.get(agent.id) ?? 0;
    if (now - lastAt >= ALERT_DEBOUNCE_MS) {
      const alertReason = catastrophicDD
        ? `drawdown ${ddPct.toFixed(0)}% >= 40% (alert only, still trading at 0.25x Kelly)`
        : `BROKEN for >= 14 days (${reason}) (alert only, still trading at 0.25x Kelly)`;
      await notify(sql, {
        subject: `[polywork] HEALTH ALERT: ${agent.name}`,
        body: `Agent ${agent.name} (${agent.id}) hit a severe-health condition.\nReason: ${alertReason}\n\n` +
              `actual WR (30d): ${actualWr !== null ? (actualWr * 100).toFixed(1) + "%" : "n/a"}\n` +
              `prior WR: ${(specWr * 100).toFixed(1)}%\n` +
              `drawdown: ${ddPct.toFixed(1)}%\n` +
              `Agent is STILL TRADING at reduced Kelly (0.25x). Review and pause manually via /lab if you want to halt it.\n`,
      });
      healthAlertLastAt.set(agent.id, now);
    }
  }

  return { health: newHealth, changed };
}

// In-memory debounce for health alerts. Worker-process-scoped; resets on restart.
const healthAlertLastAt = new Map<string, number>();

function strategyMatches(
  t: { price: number; size: number; mom_24h: number | null; vol_24h: number | null; hours_to_resolve: number | null },
  agent: Agent,
): boolean {
  const s = agent.strategy;
  if (t.price < s.price_min || t.price > s.price_max) return false;
  if (s.mom_24h_min !== undefined && (t.mom_24h === null || t.mom_24h < s.mom_24h_min)) return false;
  if (s.mom_24h_max !== undefined && (t.mom_24h === null || t.mom_24h > s.mom_24h_max)) return false;
  if (s.vol_24h_min !== undefined && (t.vol_24h === null || t.vol_24h < s.vol_24h_min)) return false;
  if (s.vol_24h_max !== undefined && (t.vol_24h === null || t.vol_24h > s.vol_24h_max)) return false;
  if (s.hours_to_resolve_min !== undefined && (t.hours_to_resolve === null || t.hours_to_resolve < s.hours_to_resolve_min)) return false;
  if (s.hours_to_resolve_max !== undefined && (t.hours_to_resolve === null || t.hours_to_resolve > s.hours_to_resolve_max)) return false;
  if (s.size_min !== undefined && t.size < s.size_min) return false;
  if (s.size_max !== undefined && t.size > s.size_max) return false;
  return true;
}

async function placePaperBuy(
  sql: Sql,
  agent: Agent,
  conditionId: string,
  question: string | null,
  outcome: "YES" | "NO",
  price: number,
  reason: string,
): Promise<{ ok: boolean; reason?: string }> {
  // Re-read agent bankroll inside the function so we never act on a stale
  // value from an earlier trade in the same poll cycle.
  const fresh = await sql<Array<{ current_bankroll: number; trades_count: number; wins_count: number; losses_count: number }>>`
    SELECT current_bankroll, trades_count, wins_count, losses_count FROM paper_agents WHERE id = ${agent.id}
  `;
  if (fresh.length === 0) return { ok: false, reason: "agent missing" };
  agent.current_bankroll = fresh[0].current_bankroll;
  agent.trades_count = fresh[0].trades_count;

  // Pocket capital: positions where our side's MTM price is pinned at
  // POCKET_PIN_THRESHOLD+ are treated as effectively settled. Their expected
  // payoff (shares * pinned_price - stake) becomes "pocket credit" that
  // increases the Kelly target. They also don't count toward
  // max_concurrent_positions since the slot is functionally free.
  // Threshold 0.98: at this price level historical de-pin rate is fractional %.
  // We also let pocket credit be SPENDABLE up to POCKET_DEPLOY_FRACTION (90%)
  // of its value — the 10% haircut absorbs the rare de-pin event so we don't
  // overdraft when a pinned position fails to resolve in our favor.
  const POCKET_PIN_THRESHOLD = 0.98;
  const POCKET_DEPLOY_FRACTION = 0.90;
  const positions = await sql<Array<{ condition_id: string; outcome: string; stake: number; shares: number; current_yes_price: number | null; current_no_price: number | null }>>`
    SELECT pp.condition_id, pp.outcome, pp.stake, pp.shares,
           lms.current_yes_price, lms.current_no_price
    FROM paper_positions pp
    LEFT JOIN live_market_state lms ON lms.condition_id = pp.condition_id
    WHERE pp.agent_id = ${agent.id} AND pp.status = 'open'
  `;
  let totalCommitted = 0;
  let pocketCredit = 0;
  let pinnedCount = 0;
  let nonPinnedCount = 0;
  for (const p of positions) {
    totalCommitted += p.stake;
    const px = p.outcome === "YES" ? p.current_yes_price : p.current_no_price;
    if (px !== null && px >= POCKET_PIN_THRESHOLD) {
      pinnedCount++;
      pocketCredit += p.shares * px - p.stake;     // expected profit on this position
    } else {
      nonPinnedCount++;
    }
  }
  if (nonPinnedCount >= agent.max_concurrent_positions) {
    return { ok: false, reason: `max concurrent positions (${nonPinnedCount} non-pinned >= ${agent.max_concurrent_positions})` };
  }
  // Effective cash for Kelly sizing: real cash + expected profit on pinned
  // positions. Real cash still caps the actual stake (can't bet money the
  // ledger doesn't have).
  const effectiveCash = agent.current_bankroll + pocketCredit;
  if (effectiveCash < 1) {
    return { ok: false, reason: `effective cash exhausted (real $${agent.current_bankroll.toFixed(2)} + pocket $${pocketCredit.toFixed(2)} = $${effectiveCash.toFixed(2)})` };
  }
  // Check for duplicate (same market+outcome already open)
  const dup = await sql<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM paper_positions
    WHERE agent_id = ${agent.id} AND condition_id = ${conditionId} AND outcome = ${outcome} AND status = 'open'
  `;
  if (dup[0].n > 0) return { ok: false, reason: "already holding this market+outcome" };

  // Kelly sizing WR. Preferred: rolling-60d actual WR if we have enough live
  // history (>= 20 settled positions). Falls back to spec wr_prior. Legacy
  // hardcoded priors retained for backwards compatibility.
  const winRateEstimate = await dynamicKellyWR(sql, agent);
  if (winRateEstimate === undefined) {
    return { ok: false, reason: `no WR available (no spec.wr_prior, no live history, no legacy fallback) for ${agent.name}` };
  }
  const b = (1 - price) / price;
  const fullKelly = Math.max(0, (winRateEstimate * b - (1 - winRateEstimate)) / b);
  let kellyFraction = fullKelly * agent.kelly_mult;
  // WATCH-state attenuator: when an agent is showing signs of degradation,
  // halve its Kelly fraction. BROKEN agents shouldn't be 'active' anymore
  // (auto-paused) but if they somehow are, drop to 25% of normal.
  if (agent.health === "watch") kellyFraction *= 0.5;
  if (agent.health === "broken") kellyFraction *= 0.25;
  const cappedFraction = Math.min(kellyFraction, agent.max_pct_per_trade);
  // Stake is sized off EFFECTIVE cash (real + pocket). For paper-trading we
  // let pocket credit be spendable up to POCKET_DEPLOY_FRACTION of its value;
  // the haircut absorbs the rare de-pin risk so the ledger stays positive
  // even if a pinned position fails to settle in our favor.
  let stake = Math.min(effectiveCash * cappedFraction, effectiveCash * 0.95);
  const spendableCap = Math.max(0, agent.current_bankroll) + POCKET_DEPLOY_FRACTION * Math.max(0, pocketCredit);
  stake = Math.min(stake, spendableCap);
  if (stake < 1) return { ok: false, reason: `stake too small ($${stake.toFixed(2)})` };
  if (stake > spendableCap) {
    return { ok: false, reason: `stake $${stake.toFixed(2)} > spendable cap $${spendableCap.toFixed(2)} (real $${agent.current_bankroll.toFixed(2)} + ${(POCKET_DEPLOY_FRACTION * 100).toFixed(0)}% of pocket $${pocketCredit.toFixed(2)})` };
  }

  const shares = stake / price;
  const id = `pp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO paper_positions (id, agent_id, condition_id, question, outcome, entry_price, stake, shares, entry_ts, trigger_reason, status)
      VALUES (${id}, ${agent.id}, ${conditionId}, ${question}, ${outcome}, ${price}, ${stake}, ${shares}, ${Date.now()}, ${reason}, 'open')
    `;
    await tx`
      UPDATE paper_agents
      SET current_bankroll = current_bankroll - ${stake},
          trades_count = trades_count + 1,
          updated_at = ${Date.now()}
      WHERE id = ${agent.id}
    `;
    await tx`
      INSERT INTO paper_decisions (agent_id, ts, decision, condition_id, outcome, price, reason)
      VALUES (${agent.id}, ${Date.now()}, 'BUY', ${conditionId}, ${outcome}, ${price}, ${reason})
    `;
  });
  return { ok: true };
}

async function checkKillswitch(sql: Sql, agent: Agent): Promise<boolean> {
  // Compute drawdown from STARTING bankroll, not from peak. This matches the
  // "I want <10% chance of loss" goal - we only kill if we've lost real money
  // below the starting line, not just pulled back from a high. Equity =
  // cash + committed-to-open-positions. Re-read cash from DB - the in-memory
  // value goes stale between placePaperBuy calls in the same poll cycle.
  const fresh = await sql<Array<{ current_bankroll: number; committed: number }>>`
    SELECT
      (SELECT current_bankroll FROM paper_agents WHERE id = ${agent.id}) AS current_bankroll,
      (SELECT COALESCE(SUM(stake), 0) FROM paper_positions WHERE agent_id = ${agent.id} AND status = 'open')::float8 AS committed
  `;
  agent.current_bankroll = fresh[0].current_bankroll;
  const equity = fresh[0].current_bankroll + fresh[0].committed;
  if (equity > agent.peak_bankroll) {
    await sql`UPDATE paper_agents SET peak_bankroll = ${equity} WHERE id = ${agent.id}`;
    agent.peak_bankroll = equity;
  }
  // Get starting bankroll for the drawdown reference.
  const startRow = await sql<Array<{ starting_bankroll: number }>>`SELECT starting_bankroll FROM paper_agents WHERE id = ${agent.id}`;
  const start = startRow[0]?.starting_bankroll ?? agent.peak_bankroll;
  const loss_pct = start > 0 ? ((start - equity) / start) * 100 : 0;
  if (loss_pct >= agent.max_drawdown_pct) {
    await sql`UPDATE paper_agents SET status = 'killed', updated_at = ${Date.now()} WHERE id = ${agent.id}`;
    await sql`INSERT INTO paper_decisions (agent_id, ts, decision, reason) VALUES (${agent.id}, ${Date.now()}, 'KILL', ${`loss ${loss_pct.toFixed(1)}% from start (equity=$${equity.toFixed(2)} start=$${start.toFixed(2)})`})`;
    return true;
  }
  return false;
}

// In-memory market state cache. Keyed by condition_id. Refreshed every ~10
// minutes per market to catch newly-resolved status.
const marketCache = new Map<string, { state: { end_date: string | null; resolution_ts: number | null; resolved_outcome: string | null }; cached_at: number }>();
const MARKET_CACHE_TTL_MS = 10 * 60_000;

async function getOrFetchMarket(sql: Sql, conditionId: string): Promise<{ end_date: string | null; resolution_ts: number | null; resolved_outcome: string | null }> {
  const cached = marketCache.get(conditionId);
  if (cached && Date.now() - cached.cached_at < MARKET_CACHE_TTL_MS) return cached.state;
  const db = await getMarketState(sql, conditionId);
  if (db && db.resolution_ts !== null) {
    marketCache.set(conditionId, { state: db, cached_at: Date.now() });
    return db;
  }
  const fetched = await fetchAndCacheMarket(sql, conditionId);
  marketCache.set(conditionId, { state: fetched, cached_at: Date.now() });
  return fetched;
}

// Dedup cache for trades dispatched within the last ~10 min. Both poll and
// WS paths consult this so the same trade is never processed twice. Keyed on
// condition_id:timestamp_ms.
const recentlyDispatched = new Map<string, number>();
const DEDUP_TTL_MS = 10 * 60_000;
function shouldDispatch(cid: string, ts: number): boolean {
  const key = `${cid}:${ts}`;
  if (recentlyDispatched.has(key)) return false;
  recentlyDispatched.set(key, Date.now());
  if (recentlyDispatched.size > 5000) {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [k, t] of recentlyDispatched) if (t < cutoff) recentlyDispatched.delete(k);
  }
  return true;
}

// Single-trade dispatch. Inserts to live_trades, computes momentum, evaluates
// per-agent filters, places paper buys. Called by both the poll loop and the
// WS callback. Idempotent across both paths via shouldDispatch().
export async function dispatchOneTrade(
  sql: Sql,
  agents: Agent[],
  t: LiveTrade,
): Promise<{ buys: number; skipped: number; processed: boolean; resolvedSkipped: boolean }> {
  const ts = t.timestamp * 1000;
  if (!shouldDispatch(t.conditionId, ts)) return { buys: 0, skipped: 0, processed: false, resolvedSkipped: false };
  const outcome = t.outcome.toUpperCase() as "YES" | "NO";

  await sql`
    INSERT INTO live_trades (condition_id, ts, outcome, side, price, size, taker)
    VALUES (${t.conditionId}, ${ts}, ${outcome}, ${t.side}, ${t.price}, ${t.size}, ${t.proxyWallet ?? null})
    ON CONFLICT (condition_id, ts, outcome, side, price, size, taker) DO NOTHING
  `;

  const mstate = await getOrFetchMarket(sql, t.conditionId);
  if (mstate.resolved_outcome) return { buys: 0, skipped: 0, processed: true, resolvedSkipped: true };

  // Liquidity gate: require this market to have at least MIN_PRE_VOL_24H_USD
  // of dollar trade volume in the 24h BEFORE this candidate trade (excluding
  // the current trade itself). Matches the liquidity filter used in the
  // proposal backtest so live and backtest face the same constraint.
  // Cold-start markets (< 24h observed) will fail this until they accumulate
  // history; that's intentional - we only trade markets with proven recent
  // order-book activity. ~1ms per query, indexed lookup on (condition_id, ts).
  const cutoff = ts - 24 * HOUR_MS;
  const liqRow = await sql<Array<{ vol: number }>>`
    SELECT COALESCE(SUM(price * size), 0)::float8 AS vol
    FROM live_trades
    WHERE condition_id = ${t.conditionId} AND ts >= ${cutoff} AND ts < ${ts}
  `;
  const preVol24h = Number(liqRow[0].vol);
  if (preVol24h < MIN_PRE_VOL_24H_USD) {
    return { buys: 0, skipped: 0, processed: true, resolvedSkipped: false };
  }

  // Do NOT clamp to 0. Negative hours_to_resolve means end_date is past
  // but Polymarket hasn't reported resolution yet - we don't want to trade
  // into that gap, so let the negative value flow through and the strategy's
  // hours_to_resolve_min filter (>= 1) will reject it.
  const hoursToResolve = mstate.resolution_ts ? (mstate.resolution_ts - ts) / HOUR_MS : null;
  // Aggressive on-demand backfill: first time we see this market, fetch
  // 24h of price history so mom_24h is computable immediately. Idempotent
  // (memoized in-process), so the per-call cost is ~0 after the first hit.
  await ensureMomentumHistoryForMarket(sql, t.conditionId).catch(() => { /* swallow; mom will fall back */ });
  const mom24h = await computeMom24h(sql, t.conditionId, outcome, ts, t.price);
  // Only compute vol_24h if at least one agent has a vol filter set; avoids
  // an extra SQL round-trip per trade for agents that don't care about vol.
  const anyVolFilter = agents.some((a) =>
    a.strategy.vol_24h_min !== undefined || a.strategy.vol_24h_max !== undefined);
  const vol24h = anyVolFilter ? await computeVol24h(sql, t.conditionId, outcome, ts) : null;
  const evalCtx = { price: t.price, size: t.size, mom_24h: mom24h, vol_24h: vol24h, hours_to_resolve: hoursToResolve };

  let buys = 0, skipped = 0;
  for (const agent of agents) {
    if (agent.status !== "active") continue;
    if (await checkKillswitch(sql, agent)) continue;
    if (!strategyMatches(evalCtx, agent)) { skipped++; continue; }
    const reason = `mom=${mom24h?.toFixed(3) ?? "null"} vol=${vol24h?.toFixed(3) ?? "null"} hrs=${hoursToResolve?.toFixed(1) ?? "null"} px=${t.price.toFixed(3)}`;
    const r = await placePaperBuy(sql, agent, t.conditionId, null, outcome, t.price, reason);
    if (r.ok) buys++;
  }
  return { buys, skipped, processed: true, resolvedSkipped: false };
}

export async function pollAndDispatch(sql: Sql, agents: Agent[], lastSeenTs: number): Promise<{ newLastTs: number; newTrades: number; buys: number; skipped: number }> {
  const trades = await fetchJson<LiveTrade[]>(`${DATA_API}/trades?limit=3000`);
  // Early filter: BUY-side, binary YES/NO, in our agents' price-of-interest range, newer than lastSeenTs.
  // The price-range filter is the union of all agent price bands so we skip lookups on irrelevant trades.
  const minPrice = agents.length > 0 ? Math.min(...agents.map((a) => a.strategy.price_min)) : 0;
  const maxPrice = agents.length > 0 ? Math.max(...agents.map((a) => a.strategy.price_max)) : 1;
  const binary = trades.filter((t) => t.side === "BUY" && (t.outcome === "Yes" || t.outcome === "No"));
  const newer = binary.filter((t) => t.timestamp * 1000 > lastSeenTs);
  const recent = newer.filter((t) => t.price >= minPrice && t.price <= maxPrice);
  console.error(`[poll] api=${trades.length} binary=${binary.length} newer_than_${lastSeenTs}=${newer.length} in_price=${recent.length} agents=${agents.length} minP=${minPrice} maxP=${maxPrice}`);
  recent.sort((a, b) => a.timestamp - b.timestamp);

  let maxTs = lastSeenTs;
  let buyCount = 0;
  let skipCount = 0;
  let resolvedSkipCount = 0;
  let alreadyDispatchedCount = 0;

  // Pre-fetch market state for all unique condition_ids we haven't seen.
  const uniqueCids = [...new Set(recent.map((t) => t.conditionId))];
  for (const cid of uniqueCids) {
    if (!marketCache.has(cid) || Date.now() - (marketCache.get(cid)?.cached_at ?? 0) > MARKET_CACHE_TTL_MS) {
      await getOrFetchMarket(sql, cid);
    }
  }

  for (const t of recent) {
    const ts = t.timestamp * 1000;
    if (ts > maxTs) maxTs = ts;
    const r = await dispatchOneTrade(sql, agents, t);
    if (!r.processed) { alreadyDispatchedCount++; continue; }
    if (r.resolvedSkipped) { resolvedSkipCount++; continue; }
    buyCount += r.buys;
    skipCount += r.skipped;
  }
  console.error(`[poll] recent=${recent.length} already_seen=${alreadyDispatchedCount} resolved_skip=${resolvedSkipCount} buys=${buyCount} skips=${skipCount}`);
  return { newLastTs: maxTs, newTrades: recent.length, buys: buyCount, skipped: skipCount };
}

export async function settleResolvedMarkets(sql: Sql): Promise<number> {
  // Find all condition_ids we have open positions in.
  const openCids = await sql<Array<{ condition_id: string }>>`
    SELECT DISTINCT condition_id FROM paper_positions WHERE status = 'open'
  `;
  let settled = 0;
  for (const { condition_id } of openCids) {
    const res = await fetchAndCacheMarket(sql, condition_id);
    if (!res.resolved_outcome) continue;
    const positions = await sql<Array<{ id: string; agent_id: string; outcome: string; entry_price: number; stake: number; shares: number }>>`
      SELECT id, agent_id, outcome, entry_price, stake, shares
      FROM paper_positions WHERE condition_id = ${condition_id} AND status = 'open'
    `;
    for (const p of positions) {
      const won = p.outcome === res.resolved_outcome;
      const proceeds = won ? p.shares : 0;
      const realized = proceeds - p.stake;
      await sql.begin(async (tx) => {
        await tx`
          UPDATE paper_positions SET status = 'closed', exit_price = ${won ? 1 : 0}, exit_ts = ${Date.now()}, realized_pnl = ${realized}
          WHERE id = ${p.id}
        `;
        await tx`
          UPDATE paper_agents
          SET current_bankroll = current_bankroll + ${proceeds},
              peak_bankroll = GREATEST(peak_bankroll, current_bankroll + ${proceeds}),
              wins_count = wins_count + ${won ? 1 : 0},
              losses_count = losses_count + ${won ? 0 : 1},
              updated_at = ${Date.now()}
          WHERE id = ${p.agent_id}
        `;
      });
      settled++;
    }
  }
  return settled;
}

// Take a mark-to-market snapshot of the whole portfolio for the /tracker page.
// Identical equity formula to the dashboard so the live curve and the live
// header agree exactly. Idempotent on the ts primary key.
export async function recordEquitySnapshot(sql: Sql): Promise<void> {
  const rows = await sql<Array<{
    total_equity: number; total_cash: number; total_committed: number;
    total_unrealized: number; total_start: number;
    open_positions: number; active_agents: number;
  }>>`
    WITH pos AS (
      SELECT pp.agent_id,
        COUNT(*) FILTER (WHERE pp.status = 'open')::int AS open_count,
        COALESCE(SUM(pp.stake) FILTER (WHERE pp.status = 'open'), 0)::float8 AS committed,
        COALESCE(SUM(
          CASE WHEN pp.status = 'open' THEN
            pp.shares * COALESCE(
              CASE pp.outcome WHEN 'YES' THEN lms.current_yes_price ELSE lms.current_no_price END,
              pp.entry_price
            ) - pp.stake
          ELSE 0 END
        ), 0)::float8 AS unrealized
      FROM paper_positions pp
      LEFT JOIN live_market_state lms ON lms.condition_id = pp.condition_id
      GROUP BY pp.agent_id
    )
    SELECT
      COALESCE(SUM(pa.current_bankroll + COALESCE(pos.committed, 0) + COALESCE(pos.unrealized, 0)), 0)::float8 AS total_equity,
      COALESCE(SUM(pa.current_bankroll), 0)::float8 AS total_cash,
      COALESCE(SUM(COALESCE(pos.committed, 0)), 0)::float8 AS total_committed,
      COALESCE(SUM(COALESCE(pos.unrealized, 0)), 0)::float8 AS total_unrealized,
      COALESCE(SUM(pa.starting_bankroll), 0)::float8 AS total_start,
      COALESCE(SUM(pos.open_count), 0)::int AS open_positions,
      COUNT(*)::int AS active_agents
    FROM paper_agents pa
    LEFT JOIN pos ON pos.agent_id = pa.id
    WHERE pa.status = 'active'
  `;
  const r = rows[0];
  if (!r) return;
  await sql`
    INSERT INTO live_equity_snapshots
      (ts, total_equity, total_cash, total_committed, total_unrealized, total_start, open_positions, active_agents)
    VALUES (${Date.now()}, ${r.total_equity}, ${r.total_cash}, ${r.total_committed}, ${r.total_unrealized}, ${r.total_start}, ${r.open_positions}, ${r.active_agents})
    ON CONFLICT (ts) DO NOTHING
  `;
}

const HEALTH_CHECK_INTERVAL_MS = 10 * 60_000;

export async function runtimeLoop(sql: Sql, opts: { onTick?: () => Promise<void> } = {}): Promise<void> {
  // Polymarket's Data API has ~4-minute lag - "most recent" trades are 240s
  // old. Start 10 min back to ensure the first poll picks up trades.
  let lastSeenTs = Date.now() - 10 * 60_000;
  let lastSettleAt = 0;
  let lastSnapshotAt = 0;
  let lastHealthCheckAt = 0;
  console.log("[runtime] starting paper-trading loop. ctrl+c to stop.");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const agents = await loadAgents(sql);
      const { newLastTs, newTrades, buys } = await pollAndDispatch(sql, agents, lastSeenTs);
      lastSeenTs = Math.max(lastSeenTs, newLastTs);

      if (Date.now() - lastSettleAt > SETTLE_INTERVAL_MS) {
        const n = await settleResolvedMarkets(sql);
        if (n > 0) console.log(`[runtime] settled ${n} positions`);
        lastSettleAt = Date.now();
      }

      if (Date.now() - lastHealthCheckAt > HEALTH_CHECK_INTERVAL_MS) {
        for (const agent of agents) {
          try {
            const { health, changed } = await checkAgentHealth(sql, agent);
            if (changed) console.log(`[runtime] health: ${agent.name} -> ${health}`);
          } catch (e) {
            console.error(`[runtime] health check failed for ${agent.name}: ${(e as Error).message}`);
          }
        }
        lastHealthCheckAt = Date.now();
      }

      if (Date.now() - lastSnapshotAt > SNAPSHOT_INTERVAL_MS) {
        try { await recordEquitySnapshot(sql); } catch (e) { console.error(`[runtime] snapshot error: ${(e as Error).message}`); }
        lastSnapshotAt = Date.now();
      }

      if (opts.onTick) await opts.onTick();
      else console.log(`[runtime] tick: new_trades=${newTrades} buys=${buys} agents=${agents.length}`);
    } catch (e) {
      console.error(`[runtime] tick error: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
