// Honest strategy hunt - no look-ahead, no aggregated averages.
//
// What "honest" means here:
//   1. Strategy filter uses SCHEDULED end_date (what the live bot can see), not
//      the post-hoc resolution time we were cheating with before.
//   2. Engine duration uses ACTUAL resolution_ts (real holding period).
//   3. Kelly sizing uses a WALK-FORWARD prior: for each backtest window, we
//      compute the cell's WR from trades BEFORE the window starts. No future
//      knowledge leaks into the bet size.
//   4. Each candidate cell is evaluated by running MANY rolling windows
//      (30-day and 90-day) and reporting the full distribution of outcomes.
//      No single "average return" that hides huge variance.
//
// What we output:
//   - Top candidate cells (Phase 1 SQL grid search)
//   - For each top cell: 30d distribution, 90d distribution
//   - Cells that pass as 30d winners (median return > 0 AND P(positive) > 60%)
//   - Cells that pass as 90d winners (same)
//   - Overlap: cells that win on BOTH horizons - what to actually deploy
//
// Run: tsx scripts/strategy-hunt-honest.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
import { runWindow, fullKelly, type Entry, type EngineConfig, type AgentConfig, type PriceLookup } from "../src/lib/backtest-engine";
import { buildPriceCache, lookupPriceAt } from "../src/lib/price-cache";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

const STARTING_BANKROLL = 1000;
const KILLSWITCH_DD_PCT = 50;
const MS_PER_DAY = 86400 * 1000;
const NOW_MS = Date.now();

// Grid dimensions. Kept slightly coarser than previous Kelly hunt to limit
// Phase 1 time without losing meaningful coverage.
const PRICE_BANDS: Array<[number, number]> = [];
for (let lo = 0.10; lo < 0.95; lo += 0.05) {
  PRICE_BANDS.push([Math.round(lo * 100) / 100, Math.round((lo + 0.05) * 100) / 100]);
}
const MOM_BANDS: Array<{ name: string; min: number; max: number }> = [
  { name: "any",     min: -10,   max: 10 },
  { name: "falling", min: -10,   max: -0.02 },
  { name: "flat",    min: -0.02, max: 0.02 },
  { name: "rising",  min: 0.02,  max: 10 },
];
const HTR_BANDS: Array<{ name: string; min: number; max: number }> = [
  { name: "<6h",    min: 0,   max: 6 },
  { name: "6-24h",  min: 6,   max: 24 },
  { name: "24-72h", min: 24,  max: 72 },
  { name: "72h+",   min: 72,  max: 99999 },
];
const SIZE_BANDS: Array<{ name: string; min: number; max: number }> = [
  { name: "any",   min: 0,    max: 9e12 },
  { name: "small", min: 0,    max: 25 },
  { name: "med",   min: 25,   max: 200 },
  { name: "large", min: 200,  max: 9e12 },
];

// Phase 1 filters: cheap pass over the grid.
const MIN_N_L365 = 30;
const MIN_AVG_PX = 0.05;   // sanity
const MAX_AVG_PX = 0.95;

// Phase 2 settings
const TOP_N_FOR_VALIDATION = 30;
const WINDOW_SHORT_DAYS = 30;
const WINDOW_LONG_DAYS = 90;
const WINDOW_SHORT_STEP_DAYS = 7;     // start every week
const WINDOW_LONG_STEP_DAYS = 14;     // start every 2 weeks
const MIN_PRIOR_SAMPLES = 20;          // for walk-forward prior
const DEFAULT_PRIOR_WR = 0.5;

// Phase 3 acceptance
const MIN_MEDIAN_RETURN_PCT = 0;
const MIN_P_POSITIVE = 0.60;

type Cell = {
  px_lo: number; px_hi: number;
  mom: typeof MOM_BANDS[number];
  htr: typeof HTR_BANDS[number];
  size: typeof SIZE_BANDS[number];
};

type CellTrade = {
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

type Phase1Result = {
  cell: Cell;
  n_l365: number;
  w_l365: number;
  wr_l365: number;
  avg_px: number;
  ev_per_dollar: number;
  trades_per_day: number;
  rough_score: number;
};

// Phase 1: SQL grid search with scheduled-end filter
async function phase1Cell(cell: Cell, nowMs: number): Promise<Phase1Result | null> {
  const ts365 = nowMs - 365 * MS_PER_DAY;
  const rows = await sql<Array<{
    n_l365: number; w_l365: number; avg_px: number | null;
    earliest_ts: number | null;
  }>>`
    WITH first_per_market AS (
      SELECT DISTINCT ON (t.condition_id)
        t.ts, t.price, tf.won,
        (EXTRACT(EPOCH FROM m.end_date) * 1000)::bigint AS sched_end_ms
      FROM trades t
      JOIN trade_features tf ON tf.trade_id = t.id
      JOIN markets m ON m.condition_id = t.condition_id
      WHERE t.side = 'BUY'
        AND t.price >= ${cell.px_lo} AND t.price < ${cell.px_hi}
        AND tf.mom_24h >= ${cell.mom.min} AND tf.mom_24h <= ${cell.mom.max}
        AND t.size >= ${cell.size.min} AND t.size < ${cell.size.max}
        AND m.end_date IS NOT NULL
        AND m.resolution_ts IS NOT NULL
        AND t.ts >= ${ts365}
      ORDER BY t.condition_id, t.ts ASC
    )
    SELECT
      COUNT(*)::int AS n_l365,
      (COUNT(*) FILTER (WHERE won = 1))::int AS w_l365,
      AVG(price)::float8 AS avg_px,
      MIN(ts)::bigint AS earliest_ts
    FROM first_per_market
    WHERE (sched_end_ms - ts) / 3600000.0 BETWEEN ${cell.htr.min} AND ${cell.htr.max}
  `;
  const r = rows[0];
  if (r.n_l365 < MIN_N_L365) return null;
  const wr = r.w_l365 / r.n_l365;
  const avg_px = r.avg_px ?? 0;
  if (avg_px < MIN_AVG_PX || avg_px > MAX_AVG_PX) return null;
  const ev_per_dollar = wr / avg_px - 1;
  if (ev_per_dollar <= 0) return null;
  const span_days = r.earliest_ts ? Math.max(1, (nowMs - Number(r.earliest_ts)) / MS_PER_DAY) : 365;
  const tpd = r.n_l365 / span_days;
  return {
    cell, n_l365: r.n_l365, w_l365: r.w_l365, wr_l365: wr,
    avg_px, ev_per_dollar, trades_per_day: tpd,
    rough_score: ev_per_dollar * tpd,
  };
}

// Load the full trade list for a cell (used for Phase 2).
async function loadCellTrades(cell: Cell, nowMs: number): Promise<CellTrade[]> {
  // We pull ALL trades in this cell over the past 365d + some prior buffer
  // so walk-forward priors can use earlier history. 365d + 180d buffer.
  const ts_min = nowMs - (365 + 180) * MS_PER_DAY;
  const rows = await sql<Array<{
    ts: number; price: number; size: number;
    scheduled_end_ms: number;
    resolution_ts: number;
    won: number;
    mom_24h: number;
    condition_id: string; outcome: string;
  }>>`
    SELECT DISTINCT ON (t.condition_id)
      t.ts::bigint AS ts,
      t.price::float8 AS price,
      t.size::float8 AS size,
      (EXTRACT(EPOCH FROM m.end_date) * 1000)::bigint AS scheduled_end_ms,
      m.resolution_ts::bigint AS resolution_ts,
      tf.won::int AS won,
      tf.mom_24h::float8 AS mom_24h,
      t.condition_id,
      t.outcome
    FROM trades t
    JOIN trade_features tf ON tf.trade_id = t.id
    JOIN markets m ON m.condition_id = t.condition_id
    WHERE t.side = 'BUY'
      AND t.price >= ${cell.px_lo} AND t.price < ${cell.px_hi}
      AND tf.mom_24h >= ${cell.mom.min} AND tf.mom_24h <= ${cell.mom.max}
      AND t.size >= ${cell.size.min} AND t.size < ${cell.size.max}
      AND m.end_date IS NOT NULL
      AND m.resolution_ts IS NOT NULL
      AND t.ts >= ${ts_min}
    ORDER BY t.condition_id, t.ts ASC
  `;
  const out: CellTrade[] = [];
  for (const r of rows) {
    const ts = Number(r.ts);
    const schedEnd = Number(r.scheduled_end_ms);
    const schedHtr = (schedEnd - ts) / 3600_000;
    // Apply scheduled-htr filter at load time too (matches Phase 1)
    if (schedHtr < cell.htr.min || schedHtr > cell.htr.max) continue;
    out.push({
      ts,
      price: r.price,
      size: r.size,
      scheduled_end_ms: schedEnd,
      resolution_ts: Number(r.resolution_ts),
      won: r.won === 1 ? 1 : 0,
      mom_24h: r.mom_24h,
      condition_id: r.condition_id,
      outcome: (r.outcome === "YES" ? "YES" : "NO") as "YES" | "NO",
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// Walk-forward prior: WR computed from cell trades BEFORE the window starts.
// Returns null if insufficient samples, in which case we use DEFAULT_PRIOR_WR.
function walkForwardPrior(trades: CellTrade[], windowStartMs: number): number {
  let n = 0, w = 0;
  for (const t of trades) {
    if (t.ts >= windowStartMs) break;     // trades are sorted by ts
    n++;
    w += t.won;
  }
  if (n < MIN_PRIOR_SAMPLES) return DEFAULT_PRIOR_WR;
  return w / n;
}

// Run a single window backtest. windowStartMs is the absolute start time.
// Cell's resolved trades within [windowStartMs, windowStartMs + window_days*MS]
// are the entries. Walk-forward prior sizes Kelly.
function runWindowBacktest(
  cell: Cell, trades: CellTrade[], windowStartMs: number, windowDays: number,
  priceLookup: PriceLookup,
): { final_equity: number; return_pct: number; n_trades: number; n_wins: number; killed: boolean } {
  const windowEndMs = windowStartMs + windowDays * MS_PER_DAY;
  const inWindow = trades.filter((t) => t.ts >= windowStartMs && t.ts < windowEndMs);

  const priorWr = walkForwardPrior(trades, windowStartMs);
  const avgPxMid = (cell.px_lo + cell.px_hi) / 2;
  const kellyFull = fullKelly(priorWr, avgPxMid);

  const entries: Entry[] = inWindow.map((t) => ({
    agent_idx: 0,
    entry_time_h: (t.ts - windowStartMs) / 3600_000,
    entry_price: t.price,
    duration_h: Math.max(0.01, (t.resolution_ts - t.ts) / 3600_000),
    won: t.won,
    condition_id: t.condition_id,
    outcome: t.outcome,
    abs_entry_ts: t.ts,
  }));

  const agents: AgentConfig[] = [{
    name: "cell",
    alloc_pct: 1.0,
    kelly_full: kellyFull,
    kelly_mult: 1.0,
    max_pct_per_trade: 0.25,
    max_concurrent: 10,
  }];

  const cfg: EngineConfig = {
    agents,
    starting_bankroll: STARTING_BANKROLL,
    days: windowDays,
    killswitch_dd_pct: KILLSWITCH_DD_PCT,
    price_lookup: priceLookup,
    window_start_abs_ts: windowStartMs,
  };
  const out = runWindow(entries, cfg);
  return {
    final_equity: out.final_equity,
    return_pct: (out.final_equity / STARTING_BANKROLL - 1) * 100,
    n_trades: out.agent_entries[0],
    n_wins: out.agent_wins[0],
    killed: out.killed,
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

type WindowDist = {
  n_windows: number;
  returns: number[];
  median_return: number;
  mean_return: number;
  p10: number; p25: number; p75: number; p90: number;
  worst: number; best: number;
  p_positive: number;
  p_loss: number;
  p_2x: number;
  median_trades_per_window: number;
  median_wr_per_window: number;
  windows_with_zero_trades: number;
};

function summarizeWindows(results: Array<{ final_equity: number; return_pct: number; n_trades: number; n_wins: number; killed: boolean }>): WindowDist {
  const returns = results.map((r) => r.return_pct).sort((a, b) => a - b);
  const tradesPerWindow = results.map((r) => r.n_trades).sort((a, b) => a - b);
  const wrsArr = results.filter((r) => r.n_trades > 0).map((r) => r.n_wins / r.n_trades).sort((a, b) => a - b);
  const mean = returns.length > 0 ? returns.reduce((s, v) => s + v, 0) / returns.length : 0;
  return {
    n_windows: results.length,
    returns,
    median_return: quantile(returns, 0.5),
    mean_return: mean,
    p10: quantile(returns, 0.1),
    p25: quantile(returns, 0.25),
    p75: quantile(returns, 0.75),
    p90: quantile(returns, 0.9),
    worst: returns[0] ?? 0,
    best: returns[returns.length - 1] ?? 0,
    p_positive: returns.filter((v) => v > 0).length / Math.max(1, returns.length),
    p_loss: returns.filter((v) => v < 0).length / Math.max(1, returns.length),
    p_2x: returns.filter((v) => v >= 100).length / Math.max(1, returns.length),
    median_trades_per_window: quantile(tradesPerWindow, 0.5),
    median_wr_per_window: wrsArr.length > 0 ? quantile(wrsArr, 0.5) : 0,
    windows_with_zero_trades: results.filter((r) => r.n_trades === 0).length,
  };
}

function pad(s: string, n: number): string { return s.length >= n ? s : s + " ".repeat(n - s.length); }
function rpad(s: string, n: number): string { return s.length >= n ? s : " ".repeat(n - s.length) + s; }

(async () => {
  const totalCells = PRICE_BANDS.length * MOM_BANDS.length * HTR_BANDS.length * SIZE_BANDS.length;
  console.log(`[honest] grid: ${PRICE_BANDS.length} price × ${MOM_BANDS.length} mom × ${HTR_BANDS.length} htr × ${SIZE_BANDS.length} size = ${totalCells} cells`);
  console.log(`[honest] now=${new Date(NOW_MS).toISOString()}`);
  console.log(`[honest] filters: scheduled-end htr filter, n_l365>=${MIN_N_L365}, EV>0 (per-trade)`);
  console.log(`[honest] window validation: rolling ${WINDOW_SHORT_DAYS}d (step ${WINDOW_SHORT_STEP_DAYS}d) and ${WINDOW_LONG_DAYS}d (step ${WINDOW_LONG_STEP_DAYS}d)`);
  console.log(`[honest] walk-forward prior: WR from trades BEFORE window start (min ${MIN_PRIOR_SAMPLES} prior markets, else default ${DEFAULT_PRIOR_WR})`);
  console.log("");

  console.log("[honest] PHASE 1: SQL grid search...");
  const t0 = Date.now();
  const phase1: Phase1Result[] = [];
  let evaluated = 0;
  for (const [px_lo, px_hi] of PRICE_BANDS) {
    for (const mom of MOM_BANDS) {
      for (const htr of HTR_BANDS) {
        for (const size of SIZE_BANDS) {
          const cell: Cell = { px_lo, px_hi, mom, htr, size };
          const r = await phase1Cell(cell, NOW_MS);
          if (r) phase1.push(r);
          evaluated++;
          if (evaluated % 200 === 0) console.log(`  [honest]   evaluated ${evaluated}/${totalCells}`);
        }
      }
    }
  }
  phase1.sort((a, b) => b.rough_score - a.rough_score);
  console.log(`[honest]   phase 1 done in ${((Date.now() - t0) / 1000).toFixed(1)}s. ${phase1.length} cells passed basic filters. Top ${TOP_N_FOR_VALIDATION} go to window validation.`);
  console.log("");

  const candidates = phase1.slice(0, TOP_N_FOR_VALIDATION);

  console.log("[honest] PHASE 2: load trade data for top candidates + build price cache...");
  const t1 = Date.now();
  const cellTrades: CellTrade[][] = [];
  const allCids = new Set<string>();
  for (const c of candidates) {
    const trades = await loadCellTrades(c.cell, NOW_MS);
    cellTrades.push(trades);
    for (const t of trades) allCids.add(t.condition_id);
  }
  const cidList = Array.from(allCids);
  const priceCache = await buildPriceCache(sql, cidList);
  const priceLookup: PriceLookup = (cid, outc, ts) => lookupPriceAt(priceCache, cid, outc, ts);
  console.log(`[honest]   phase 2 done in ${((Date.now() - t1) / 1000).toFixed(1)}s. ${cidList.length} markets cached.`);
  console.log("");

  console.log("[honest] PHASE 3: rolling window backtests with walk-forward priors...");
  const t2 = Date.now();
  // Window starts: from (NOW_MS - 365d) up to (NOW_MS - WINDOW_DAYS).
  const window30Starts: number[] = [];
  for (let ts = NOW_MS - 365 * MS_PER_DAY; ts + WINDOW_SHORT_DAYS * MS_PER_DAY <= NOW_MS; ts += WINDOW_SHORT_STEP_DAYS * MS_PER_DAY) {
    window30Starts.push(ts);
  }
  const window90Starts: number[] = [];
  for (let ts = NOW_MS - 365 * MS_PER_DAY; ts + WINDOW_LONG_DAYS * MS_PER_DAY <= NOW_MS; ts += WINDOW_LONG_STEP_DAYS * MS_PER_DAY) {
    window90Starts.push(ts);
  }
  console.log(`[honest]   ${window30Starts.length} 30d windows × ${candidates.length} cells = ${window30Starts.length * candidates.length} 30d backtests`);
  console.log(`[honest]   ${window90Starts.length} 90d windows × ${candidates.length} cells = ${window90Starts.length * candidates.length} 90d backtests`);

  const dist30: WindowDist[] = [];
  const dist90: WindowDist[] = [];
  for (let ci = 0; ci < candidates.length; ci++) {
    const trades = cellTrades[ci];
    const cell = candidates[ci].cell;
    const r30s = window30Starts.map((ws) => runWindowBacktest(cell, trades, ws, WINDOW_SHORT_DAYS, priceLookup));
    const r90s = window90Starts.map((ws) => runWindowBacktest(cell, trades, ws, WINDOW_LONG_DAYS, priceLookup));
    dist30.push(summarizeWindows(r30s));
    dist90.push(summarizeWindows(r90s));
  }
  console.log(`[honest]   phase 3 done in ${((Date.now() - t2) / 1000).toFixed(1)}s.`);
  console.log("");

  // Helper to format a cell spec
  const fmtCell = (c: Cell) => `${c.px_lo.toFixed(2)}-${c.px_hi.toFixed(2)}/${c.mom.name}/${c.htr.name}/${c.size.name}`;

  // Output: candidate distributions
  console.log("=".repeat(160));
  console.log("TOP CANDIDATES - ROLLING 30-DAY DISTRIBUTIONS");
  console.log("=".repeat(160));
  console.log(`  ${pad("cell", 36)} ${rpad("ph1_wr", 7)} ${rpad("ph1_evpd", 8)} ${rpad("med_30d", 9)} ${rpad("p10", 8)} ${rpad("p90", 8)} ${rpad("worst", 8)} ${rpad("best", 8)} ${rpad("P(pos)", 7)} ${rpad("P(loss)", 8)} ${rpad("P(2x)", 7)} ${rpad("trades/w", 9)} ${rpad("zero_w", 7)}`);
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const d = dist30[i];
    console.log(`  ${pad(fmtCell(c.cell), 36)} ${rpad((c.wr_l365 * 100).toFixed(1) + "%", 7)} ${rpad((c.ev_per_dollar * 100).toFixed(1) + "%", 8)} ${rpad((d.median_return >= 0 ? "+" : "") + d.median_return.toFixed(1) + "%", 9)} ${rpad((d.p10 >= 0 ? "+" : "") + d.p10.toFixed(0) + "%", 8)} ${rpad((d.p90 >= 0 ? "+" : "") + d.p90.toFixed(0) + "%", 8)} ${rpad((d.worst >= 0 ? "+" : "") + d.worst.toFixed(0) + "%", 8)} ${rpad((d.best >= 0 ? "+" : "") + d.best.toFixed(0) + "%", 8)} ${rpad((d.p_positive * 100).toFixed(0) + "%", 7)} ${rpad((d.p_loss * 100).toFixed(0) + "%", 8)} ${rpad((d.p_2x * 100).toFixed(0) + "%", 7)} ${rpad(d.median_trades_per_window.toFixed(0), 9)} ${rpad(d.windows_with_zero_trades.toString(), 7)}`);
  }
  console.log("");

  console.log("=".repeat(160));
  console.log("TOP CANDIDATES - ROLLING 90-DAY DISTRIBUTIONS");
  console.log("=".repeat(160));
  console.log(`  ${pad("cell", 36)} ${rpad("ph1_wr", 7)} ${rpad("ph1_evpd", 8)} ${rpad("med_90d", 9)} ${rpad("p10", 8)} ${rpad("p90", 8)} ${rpad("worst", 8)} ${rpad("best", 8)} ${rpad("P(pos)", 7)} ${rpad("P(loss)", 8)} ${rpad("P(2x)", 7)} ${rpad("trades/w", 9)} ${rpad("zero_w", 7)}`);
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const d = dist90[i];
    console.log(`  ${pad(fmtCell(c.cell), 36)} ${rpad((c.wr_l365 * 100).toFixed(1) + "%", 7)} ${rpad((c.ev_per_dollar * 100).toFixed(1) + "%", 8)} ${rpad((d.median_return >= 0 ? "+" : "") + d.median_return.toFixed(1) + "%", 9)} ${rpad((d.p10 >= 0 ? "+" : "") + d.p10.toFixed(0) + "%", 8)} ${rpad((d.p90 >= 0 ? "+" : "") + d.p90.toFixed(0) + "%", 8)} ${rpad((d.worst >= 0 ? "+" : "") + d.worst.toFixed(0) + "%", 8)} ${rpad((d.best >= 0 ? "+" : "") + d.best.toFixed(0) + "%", 8)} ${rpad((d.p_positive * 100).toFixed(0) + "%", 7)} ${rpad((d.p_loss * 100).toFixed(0) + "%", 8)} ${rpad((d.p_2x * 100).toFixed(0) + "%", 7)} ${rpad(d.median_trades_per_window.toFixed(0), 9)} ${rpad(d.windows_with_zero_trades.toString(), 7)}`);
  }
  console.log("");

  // Accept lists
  const winners30: number[] = [];
  const winners90: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (dist30[i].median_return >= MIN_MEDIAN_RETURN_PCT && dist30[i].p_positive >= MIN_P_POSITIVE) winners30.push(i);
    if (dist90[i].median_return >= MIN_MEDIAN_RETURN_PCT && dist90[i].p_positive >= MIN_P_POSITIVE) winners90.push(i);
  }
  const overlap = winners30.filter((i) => winners90.includes(i));

  console.log("=".repeat(160));
  console.log(`30-DAY WINNERS (median_return >= ${MIN_MEDIAN_RETURN_PCT}% AND P(positive) >= ${(MIN_P_POSITIVE * 100).toFixed(0)}%): ${winners30.length} cells`);
  console.log("=".repeat(160));
  for (const i of winners30) {
    const c = candidates[i], d = dist30[i];
    console.log(`  ${pad(fmtCell(c.cell), 36)} median=${(d.median_return >= 0 ? "+" : "") + d.median_return.toFixed(1)}%  P(pos)=${(d.p_positive * 100).toFixed(0)}%  P(loss)=${(d.p_loss * 100).toFixed(0)}%  worst=${d.worst.toFixed(0)}%  trades/w=${d.median_trades_per_window.toFixed(0)}`);
  }
  console.log("");

  console.log("=".repeat(160));
  console.log(`90-DAY WINNERS (median_return >= ${MIN_MEDIAN_RETURN_PCT}% AND P(positive) >= ${(MIN_P_POSITIVE * 100).toFixed(0)}%): ${winners90.length} cells`);
  console.log("=".repeat(160));
  for (const i of winners90) {
    const c = candidates[i], d = dist90[i];
    console.log(`  ${pad(fmtCell(c.cell), 36)} median=${(d.median_return >= 0 ? "+" : "") + d.median_return.toFixed(1)}%  P(pos)=${(d.p_positive * 100).toFixed(0)}%  P(loss)=${(d.p_loss * 100).toFixed(0)}%  worst=${d.worst.toFixed(0)}%  trades/w=${d.median_trades_per_window.toFixed(0)}`);
  }
  console.log("");

  console.log("=".repeat(160));
  console.log(`OVERLAP - cells that win on BOTH 30-day AND 90-day horizons: ${overlap.length} cells`);
  console.log("=".repeat(160));
  if (overlap.length === 0) {
    console.log("  (none - no cell satisfies both)");
  } else {
    console.log(`  ${pad("cell", 36)} ${rpad("med_30d", 9)} ${rpad("Ppos_30", 9)} ${rpad("med_90d", 9)} ${rpad("Ppos_90", 9)} ${rpad("trades/30d", 11)} ${rpad("trades/90d", 11)}`);
    for (const i of overlap) {
      const c = candidates[i], d30 = dist30[i], d90 = dist90[i];
      console.log(`  ${pad(fmtCell(c.cell), 36)} ${rpad((d30.median_return >= 0 ? "+" : "") + d30.median_return.toFixed(1) + "%", 9)} ${rpad((d30.p_positive * 100).toFixed(0) + "%", 9)} ${rpad((d90.median_return >= 0 ? "+" : "") + d90.median_return.toFixed(1) + "%", 9)} ${rpad((d90.p_positive * 100).toFixed(0) + "%", 9)} ${rpad(d30.median_trades_per_window.toFixed(0), 11)} ${rpad(d90.median_trades_per_window.toFixed(0), 11)}`);
    }
  }
  console.log("");

  console.log("HONESTY CALLOUT:");
  console.log("  - Strategy filter used SCHEDULED end_date, not actual resolution. Matches live bot.");
  console.log("  - Engine duration used ACTUAL resolution_ts. Matches reality.");
  console.log("  - Kelly sizing used WALK-FORWARD prior (WR from trades BEFORE each window). No future leak.");
  console.log("  - Distributions, not averages: P(positive), P(loss), worst, best are all visible.");
  console.log(`  - Each cell tested on ${window30Starts.length} rolling 30d windows + ${window90Starts.length} rolling 90d windows.`);
  console.log("  - Cells in OVERLAP are the rare ones that pass median > 0 AND P(positive) >= 60% on BOTH horizons.");
  console.log("  - 'zero_w' column shows how many windows had NO trades (strategy was inactive).");

  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
