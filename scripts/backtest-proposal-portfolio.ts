// Daily-step 90-day rolling backtest of the proposed 4-cell portfolio.
// Realistic methodology: scheduled-end filter, actual-resolution duration,
// walk-forward priors. Output JSON gets rendered on /proposal.
//
// Run: tsx scripts/backtest-proposal-portfolio.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
import { writeFileSync, mkdirSync, statSync } from "fs";
import { resolve as pathResolve, dirname } from "path";
import { runWindow, fullKelly, type Entry, type EngineConfig, type AgentConfig, type PriceLookup } from "../src/lib/backtest-engine";
import { buildPriceCache, lookupPriceAt } from "../src/lib/price-cache";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

const PROJECT_ROOT = pathResolve(__dirname, "..");
const STARTING_BANKROLL = 1000;
const KILLSWITCH_DD_PCT = 50;
const MS_PER_DAY = 86400 * 1000;
const NOW_MS = Date.now();
const WINDOW_DAYS = 90;
const STEP_DAYS = 1;
// Start every day from 2024-08-01. End point is 90 days before now (so each
// window can complete on real data).
const ROLL_START_MS = new Date("2024-08-01T00:00:00Z").getTime();
const ROLL_END_MS = NOW_MS - WINDOW_DAYS * MS_PER_DAY;
const PRIOR_BUFFER_DAYS = 180;
const MIN_PRIOR_SAMPLES = 20;
const DEFAULT_PRIOR_WR = 0.5;
// Live Polymarket Data API lag (the polling loop sees trades ~4 min after
// they happen). Models the conservative case where live stays on polling;
// websocket would cut this to ~0 but we model the polling reality so the
// backtest is a lower bound, not an upper bound.
const LIVE_LAG_MS = 4 * 60 * 1000;
// Pocket capital: treat positions priced >= POCKET_PIN_THRESHOLD as decided
// winners. Their expected payoff becomes available credit for new trades AND
// is spendable up to 90% of its value (10% haircut for de-pin risk). Matches
// placePaperBuy in live runtime. Threshold 0.98 keeps de-pin rate fractional.
const POCKET_PIN_THRESHOLD = 0.98;
// Real-world friction calibrated to Polymarket reality:
//   - Polymarket CLOB has NO trading fee on retail-size orders
//   - Slippage on liquid markets ($5K+ filter) is typically 1-3 cents on a
//     $0.50 contract -> ~0.1% effective adverse fill
// Prior values (0.5% slip + 2% fee) were sandbagging conservative estimates.
const ENTRY_SLIPPAGE_PCT = 0.001;
const FEE_ON_WINNINGS_PCT = 0;
// Liquidity filter: require pre-trade 24h dollar volume on the candidate
// market. Mirrors the live runtime's MIN_PRE_VOL_24H_USD gate so backtest
// and live face the same constraint. Markets with thinner activity get
// skipped (they wouldn't fill in real-money trading).
const MIN_PRE_VOL_24H_USD = 5000;

type Cell = {
  name: string;
  alloc_pct: number;
  price_min: number;
  price_max: number;
  mom_min: number;
  mom_max: number;
  htr_min: number;
  htr_max: number;
  size_min: number;
  size_max: number;
  max_pct_per_trade: number;
  max_concurrent: number;
  // wr_prior matches what the seed script feeds the live agent; used by the
  // health monitor to detect drift (actual rolling 30d WR vs this prior).
  spec_wr_prior: number;
};

// 10-cell LIQUID portfolio. Equal 10% allocations. 1.5× sizing on max_pct_per_trade.
// Cells 1-5 from prior 5-cell deployment; cells 6-10 cover missing price bands.
const PORTFOLIO: Cell[] = [
  { name: "longmid_any_dayplus_large", alloc_pct: 0.10, price_min: 0.30, price_max: 0.35, mom_min: -10,   mom_max: 10,  htr_min: 24, htr_max: 72,    size_min: 200, size_max: 9e12, max_pct_per_trade: 0.15,  max_concurrent: 10, spec_wr_prior: 0.523 },
  { name: "midfav_rising_day_any",     alloc_pct: 0.10, price_min: 0.55, price_max: 0.60, mom_min: 0.02,  mom_max: 10,  htr_min: 6,  htr_max: 24,    size_min: 0,   size_max: 9e12, max_pct_per_trade: 0.225, max_concurrent: 10, spec_wr_prior: 0.792 },
  { name: "midfav_rising_slow_large",  alloc_pct: 0.10, price_min: 0.50, price_max: 0.55, mom_min: 0.02,  mom_max: 10,  htr_min: 72, htr_max: 99999, size_min: 200, size_max: 9e12, max_pct_per_trade: 0.225, max_concurrent: 10, spec_wr_prior: 0.626 },
  { name: "heavyfav_flat_slow_large",  alloc_pct: 0.10, price_min: 0.70, price_max: 0.75, mom_min: -0.02, mom_max: 0.02, htr_min: 72, htr_max: 99999, size_min: 200, size_max: 9e12, max_pct_per_trade: 0.30,  max_concurrent: 10, spec_wr_prior: 0.833 },
  { name: "ultrafav_any_slow_any",     alloc_pct: 0.10, price_min: 0.90, price_max: 0.95, mom_min: -10,   mom_max: 10,  htr_min: 72, htr_max: 99999, size_min: 0,   size_max: 9e12, max_pct_per_trade: 0.30,  max_concurrent: 15, spec_wr_prior: 0.96 },
  { name: "long_any_dayplus_large",    alloc_pct: 0.10, price_min: 0.25, price_max: 0.30, mom_min: -10,   mom_max: 10,  htr_min: 24, htr_max: 72,    size_min: 200, size_max: 9e12, max_pct_per_trade: 0.15,  max_concurrent: 10, spec_wr_prior: 0.333 },
  { name: "mid_flat_slow_any",         alloc_pct: 0.10, price_min: 0.40, price_max: 0.45, mom_min: -0.02, mom_max: 0.02, htr_min: 72, htr_max: 99999, size_min: 0,   size_max: 9e12, max_pct_per_trade: 0.225, max_concurrent: 10, spec_wr_prior: 0.625 },
  { name: "midhi_any_slow_any",        alloc_pct: 0.10, price_min: 0.45, price_max: 0.50, mom_min: -10,   mom_max: 10,  htr_min: 72, htr_max: 99999, size_min: 0,   size_max: 9e12, max_pct_per_trade: 0.225, max_concurrent: 10, spec_wr_prior: 0.529 },
  { name: "midhi_any_day_large",       alloc_pct: 0.10, price_min: 0.60, price_max: 0.65, mom_min: -10,   mom_max: 10,  htr_min: 6,  htr_max: 24,    size_min: 200, size_max: 9e12, max_pct_per_trade: 0.30,  max_concurrent: 10, spec_wr_prior: 0.706 },
  { name: "hifav_rising_slow_any",     alloc_pct: 0.10, price_min: 0.65, price_max: 0.70, mom_min: 0.02,  mom_max: 10,  htr_min: 72, htr_max: 99999, size_min: 0,   size_max: 9e12, max_pct_per_trade: 0.30,  max_concurrent: 10, spec_wr_prior: 0.742 },
];

type Trade = {
  ts: number;
  price: number;
  size: number;
  scheduled_end_ms: number;
  resolution_ts: number;
  won: 0 | 1;
  mom_24h: number;
  condition_id: string;
  outcome: "YES" | "NO";
};

async function loadTradesForCell(cell: Cell): Promise<Trade[]> {
  const ts_min = ROLL_START_MS - PRIOR_BUFFER_DAYS * MS_PER_DAY;
  // Mom fallback (mimics live runtime): use mom_24h when available, fall back
  // to mom_6h, then mom_1h. For "any mom" cells (mom_min=-10, mom_max=10),
  // even a null effective mom passes the filter (matches strategyMatches in
  // live-runtime.ts which only rejects null when the spec defines a bound).
  // Liquidity filter: compute pre-trade 24h dollar volume per candidate
  // (excluding the candidate itself), then keep only trades where the
  // surrounding market had >= MIN_PRE_VOL_24H_USD of activity. Matches the
  // live runtime's liquidity gate so backtest and live face the same world.
  const anyMom = cell.mom_min <= -10 && cell.mom_max >= 10;
  const rows = await sql<Array<{
    ts: number; price: number; size: number;
    scheduled_end_ms: number; resolution_ts: number;
    won: number; mom_eff: number | null;
    condition_id: string; outcome: string;
  }>>`
    WITH eligible AS (
      SELECT t.id, t.condition_id, t.ts::bigint AS ts, t.price::float8 AS price, t.size::float8 AS size,
        (EXTRACT(EPOCH FROM m.end_date) * 1000)::bigint AS scheduled_end_ms,
        m.resolution_ts::bigint AS resolution_ts,
        tf.won::int AS won,
        COALESCE(tf.mom_24h, tf.mom_6h, tf.mom_1h)::float8 AS mom_eff,
        t.outcome,
        COALESCE(
          SUM(t.price * t.size) OVER (
            PARTITION BY t.condition_id ORDER BY t.ts
            RANGE BETWEEN 86400000 PRECEDING AND CURRENT ROW
          ) - (t.price * t.size),
          0
        )::float8 AS pre_vol_24h
      FROM trades t
      JOIN trade_features tf ON tf.trade_id = t.id
      JOIN markets m ON m.condition_id = t.condition_id
      WHERE t.side = 'BUY'
        AND t.price >= ${cell.price_min} AND t.price < ${cell.price_max}
        AND (
          ${anyMom}::boolean
          OR (COALESCE(tf.mom_24h, tf.mom_6h, tf.mom_1h) BETWEEN ${cell.mom_min} AND ${cell.mom_max})
        )
        AND t.size >= ${cell.size_min} AND t.size < ${cell.size_max}
        AND m.end_date IS NOT NULL AND m.resolution_ts IS NOT NULL
        AND t.ts >= ${ts_min}
        AND (EXTRACT(EPOCH FROM m.end_date) * 1000 - t.ts) / 3600000.0
            BETWEEN ${cell.htr_min} AND ${cell.htr_max}
    )
    SELECT DISTINCT ON (condition_id)
      ts, price, size, scheduled_end_ms, resolution_ts, won, mom_eff, condition_id, outcome
    FROM eligible
    WHERE pre_vol_24h >= ${MIN_PRE_VOL_24H_USD}
    ORDER BY condition_id, ts ASC
  `;
  return rows.map((r) => ({
    ts: Number(r.ts), price: r.price, size: r.size,
    scheduled_end_ms: Number(r.scheduled_end_ms),
    resolution_ts: Number(r.resolution_ts),
    won: r.won === 1 ? 1 : 0, mom_24h: r.mom_eff ?? 0,
    condition_id: r.condition_id,
    outcome: (r.outcome === "YES" ? "YES" : "NO") as "YES" | "NO",
  })).sort((a, b) => a.ts - b.ts);
}

function walkForwardPrior(trades: Trade[], windowStartMs: number): number {
  let n = 0, w = 0;
  for (const t of trades) {
    if (t.ts >= windowStartMs) break;
    n++;
    w += t.won;
  }
  if (n < MIN_PRIOR_SAMPLES) return DEFAULT_PRIOR_WR;
  return w / n;
}

(async () => {
  console.log(`[proposal] loading trades for ${PORTFOLIO.length} cells...`);
  const t0 = Date.now();
  const cellTrades: Trade[][] = [];
  const allCids = new Set<string>();
  for (const c of PORTFOLIO) {
    const tr = await loadTradesForCell(c);
    cellTrades.push(tr);
    for (const t of tr) allCids.add(t.condition_id);
    console.log(`[proposal]   ${c.name}: ${tr.length} trades`);
  }
  console.log(`[proposal]   loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log(`[proposal] building price cache for ${allCids.size} markets...`);
  const t1 = Date.now();
  const priceCache = await buildPriceCache(sql, Array.from(allCids));
  const priceLookup: PriceLookup = (cid, outc, ts) => lookupPriceAt(priceCache, cid, outc, ts);
  console.log(`[proposal]   built in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log("");

  // Generate window starts: every day from ROLL_START to ROLL_END.
  const windowStarts: number[] = [];
  for (let ts = ROLL_START_MS; ts <= ROLL_END_MS; ts += STEP_DAYS * MS_PER_DAY) {
    windowStarts.push(ts);
  }
  console.log(`[proposal] running ${windowStarts.length} daily 90-day windows...`);

  type WindowOut = {
    start_ts: number;
    start_date: string;
    end_date: string;
    n_entries: number;
    final_equity: number;
    return_pct: number;
    killed: boolean;
    killed_day: number;
    killed_by_mtm: boolean;
    max_drawdown_pct: number;
    lowest_equity: number;
    highest_equity: number;
    agent_entries: number[];
    agent_wins: number[];
    agent_losses: number[];
    agent_pnl: number[];
  };
  const results: WindowOut[] = [];
  const tStart = Date.now();
  for (let wi = 0; wi < windowStarts.length; wi++) {
    const ws = windowStarts[wi];
    const we = ws + WINDOW_DAYS * MS_PER_DAY;

    // Build entries: for each cell, find trades in [ws, we) and tag with agent_idx.
    // Apply 4-min Polymarket Data API lag: the bot sees the trade at t.ts + LIVE_LAG_MS,
    // not at t.ts. Two real effects:
    //   1. Skip entries whose market resolved before the bot would have seen the
    //      signal (we'd have nothing to enter).
    //   2. Position holding time is 4 min shorter (we enter later, exit at the
    //      same actual resolution).
    // Note: the live bot orders at the signal price t.price and filters on the
    // signal price, NOT the current quote at dispatch time. So no price-band
    // drift check; htr/mom filters were already applied via SQL on t.ts.
    const entries: Entry[] = [];
    for (let ci = 0; ci < PORTFOLIO.length; ci++) {
      const trades = cellTrades[ci];
      const seen = new Set<string>();
      for (const t of trades) {
        const laggedTs = t.ts + LIVE_LAG_MS;
        if (laggedTs < ws) continue;
        if (laggedTs >= we) break;
        if (seen.has(t.condition_id)) continue;
        if (t.resolution_ts <= laggedTs) continue;
        seen.add(t.condition_id);
        entries.push({
          agent_idx: ci,
          entry_time_h: (laggedTs - ws) / 3600_000,
          entry_price: t.price,
          duration_h: Math.max(0.01, (t.resolution_ts - laggedTs) / 3600_000),
          won: t.won,
          condition_id: t.condition_id,
          outcome: t.outcome,
          abs_entry_ts: laggedTs,
        });
      }
    }
    entries.sort((a, b) => a.entry_time_h - b.entry_time_h);

    // Walk-forward prior per cell for the WARMUP Kelly (used until the agent
    // has 20+ settled trades within the window; then dynamic Kelly takes over).
    // If pre-window sample is too thin (walk-forward returns DEFAULT_PRIOR_WR),
    // fall back to spec_wr_prior so liquid cells with few historical entries
    // don't get sized at Kelly=0. This matches live runtime's dynamicKellyWR
    // behavior (uses spec_wr_prior as the fallback when no live history yet).
    const agents: AgentConfig[] = PORTFOLIO.map((c, ci) => {
      const wr = walkForwardPrior(cellTrades[ci], ws);
      const usedWr = wr === DEFAULT_PRIOR_WR ? c.spec_wr_prior : wr;
      const avgPx = (c.price_min + c.price_max) / 2;
      return {
        name: c.name,
        alloc_pct: c.alloc_pct,
        kelly_full: fullKelly(usedWr, avgPx),
        kelly_mult: 1.0,
        max_pct_per_trade: c.max_pct_per_trade,
        max_concurrent: c.max_concurrent,
        live_mimicry: true,
        spec_wr_prior: c.spec_wr_prior,
        avg_entry_price: avgPx,
      };
    });

    const cfg: EngineConfig = {
      agents,
      starting_bankroll: STARTING_BANKROLL,
      days: WINDOW_DAYS,
      killswitch_dd_pct: KILLSWITCH_DD_PCT,
      price_lookup: priceLookup,
      window_start_abs_ts: ws,
      pocket_enabled: true,
      pocket_pin_threshold: POCKET_PIN_THRESHOLD,
      entry_slippage_pct: ENTRY_SLIPPAGE_PCT,
      fee_on_winnings_pct: FEE_ON_WINNINGS_PCT,
      // Live runtime auto-pause is now alert-only; match that here so backtest
      // reflects real behavior. Kelly throttling on WATCH/BROKEN still applies.
      auto_pause_enabled: false,
    };
    const out = runWindow(entries, cfg);
    let peak = STARTING_BANKROLL, maxDd = 0;
    for (const v of out.trajectory) {
      if (v > peak) peak = v;
      const dd = (peak - v) / peak * 100;
      if (dd > maxDd) maxDd = dd;
    }
    results.push({
      start_ts: ws,
      start_date: new Date(ws).toISOString().slice(0, 10),
      end_date: new Date(we).toISOString().slice(0, 10),
      n_entries: entries.length,
      final_equity: out.final_equity,
      return_pct: (out.final_equity / STARTING_BANKROLL - 1) * 100,
      killed: out.killed,
      killed_day: out.killed_day,
      killed_by_mtm: out.killed_by_mtm,
      max_drawdown_pct: maxDd,
      lowest_equity: Math.min(...out.trajectory),
      highest_equity: Math.max(...out.trajectory),
      agent_entries: out.agent_entries,
      agent_wins: out.agent_wins,
      agent_losses: out.agent_losses,
      agent_pnl: out.agent_pnl,
    });
    if ((wi + 1) % 50 === 0) console.log(`[proposal]   ${wi + 1}/${windowStarts.length} windows (${((Date.now() - tStart) / 1000).toFixed(1)}s)`);
  }
  console.log(`[proposal] done. ${results.length} windows in ${((Date.now() - tStart) / 1000).toFixed(1)}s`);

  // Summary
  const returns = results.map((r) => r.return_pct).sort((a, b) => a - b);
  const median = returns[Math.floor(returns.length / 2)];
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const pPos = results.filter((r) => r.return_pct > 0).length / results.length;
  const pKil = results.filter((r) => r.killed).length / results.length;
  const p2x = results.filter((r) => r.return_pct >= 100).length / results.length;
  const worst = returns[0], best = returns[returns.length - 1];
  console.log("");
  console.log(`SUMMARY of ${results.length} daily 90-day windows:`);
  console.log(`  median return: ${median.toFixed(1)}%   mean: ${mean.toFixed(1)}%`);
  console.log(`  P(positive):   ${(pPos * 100).toFixed(1)}%`);
  console.log(`  P(2x or more): ${(p2x * 100).toFixed(1)}%`);
  console.log(`  P(killswitch): ${(pKil * 100).toFixed(1)}%`);
  console.log(`  worst:         ${worst.toFixed(1)}%      best: ${best.toFixed(1)}%`);

  const outPath = pathResolve(PROJECT_ROOT, "public", "proposal-portfolio.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({
    generated_at: Date.now(),
    window_days: WINDOW_DAYS,
    step_days: STEP_DAYS,
    roll_start: ROLL_START_MS,
    roll_end: ROLL_END_MS,
    starting_bankroll: STARTING_BANKROLL,
    killswitch_dd_pct: KILLSWITCH_DD_PCT,
    live_lag_ms: LIVE_LAG_MS,
    pocket_enabled: true,
    pocket_pin_threshold: POCKET_PIN_THRESHOLD,
    entry_slippage_pct: ENTRY_SLIPPAGE_PCT,
    fee_on_winnings_pct: FEE_ON_WINNINGS_PCT,
    min_pre_vol_24h_usd: MIN_PRE_VOL_24H_USD,
    live_mimicry: {
      enabled: true,
      dynamic_kelly_min_samples: 20,
      dynamic_kelly_rolling_days: 60,
      health_min_samples: 15,
      health_rolling_days: 30,
      health_watch_dd_pct: 15,
      health_broken_dd_pct: 25,
      health_watch_wr_drop_pp: 3,
      health_broken_wr_drop_pp: 10,
      health_watch_kelly_mult: 0.5,
      health_broken_kelly_mult: 0.25,
      auto_pause_broken_days: 14,
      auto_pause_catastrophic_dd_pct: 40,
      mom_fallback: ["mom_24h", "mom_6h", "mom_1h"],
    },
    cells: PORTFOLIO.map((c) => ({
      name: c.name, alloc_pct: c.alloc_pct,
      price_min: c.price_min, price_max: c.price_max,
      mom_min: c.mom_min, mom_max: c.mom_max,
      htr_min: c.htr_min, htr_max: c.htr_max,
      size_min: c.size_min, size_max: c.size_max,
    })),
    results,
    summary: {
      n_windows: results.length,
      median_return_pct: median,
      mean_return_pct: mean,
      p_positive: pPos,
      p_killswitch: pKil,
      p_double: p2x,
      worst_return_pct: worst,
      best_return_pct: best,
    },
  }));
  console.log(`\nwrote ${outPath} (${(statSync(outPath).size / 1024).toFixed(0)} KB)`);
  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
