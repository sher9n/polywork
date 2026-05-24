// Honest strategy hunt v2: 2-year mining range + built-in OOS regime
// stability filter. Addresses the failure mode the 1-year honest hunt
// exposed - all 3 of its winners failed OOS because they came alive
// recently and were dormant before.
//
// Differences vs strategy-hunt-honest.ts:
//   - Mining range: 2 years (vs 1 year)
//   - Phase 1 filter requires:
//       * Minimum samples in BOTH halves (not just total)
//       * Positive EV in BOTH halves (regime stability)
//       * Less than 10pp WR delta between halves (stable WR)
//   - Phase 3 acceptance: rolling windows must show median > 0 AND
//     P(positive) >= 60% in BOTH halves on BOTH horizons.
//
// What survives this filter is genuinely durable: cells that worked
// consistently across regimes for 2 years, not just lucky in the last 12 months.
//
// Run: tsx scripts/strategy-hunt-honest-2yr.ts

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

// 2-year mining range, split into 2 halves at the midpoint.
const RANGE_DAYS = 730;
const MIDPOINT_MS = NOW_MS - (RANGE_DAYS / 2) * MS_PER_DAY;
const OLDEST_MS = NOW_MS - RANGE_DAYS * MS_PER_DAY;

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

// Phase 1 filters - REGIME STABILITY focused.
const MIN_N_PER_HALF = 15;          // each half needs activity
const MIN_AVG_PX = 0.05;
const MAX_AVG_PX = 0.95;
const MAX_WR_DELTA = 0.10;          // halves must agree within 10pp

// Phase 2 settings
const TOP_N_FOR_VALIDATION = 20;
const PRIOR_BUFFER_DAYS = 180;
const WINDOW_SHORT_DAYS = 30;
const WINDOW_LONG_DAYS = 90;
const WINDOW_SHORT_STEP_DAYS = 7;
const WINDOW_LONG_STEP_DAYS = 14;
const MIN_PRIOR_SAMPLES = 20;
const DEFAULT_PRIOR_WR = 0.5;

// Phase 3 acceptance
const MIN_MEDIAN_RETURN_PCT = 0;
const MIN_P_POSITIVE = 0.60;

type Cell = { px_lo: number; px_hi: number; mom: typeof MOM_BANDS[number]; htr: typeof HTR_BANDS[number]; size: typeof SIZE_BANDS[number] };

type Phase1Result = {
  cell: Cell;
  n_older: number; w_older: number; wr_older: number; avg_px_older: number; ev_older: number;
  n_recent: number; w_recent: number; wr_recent: number; avg_px_recent: number; ev_recent: number;
  wr_delta: number;
  rough_score: number;
};

async function phase1Cell(cell: Cell): Promise<Phase1Result | null> {
  // BUGFIX: filter htr BEFORE DISTINCT ON, otherwise we drop markets whose
  // earliest qualifying-price/mom trade had wrong htr (~50-75% undercount).
  const rows = await sql<Array<{
    n_older: number; w_older: number; avg_px_older: number | null;
    n_recent: number; w_recent: number; avg_px_recent: number | null;
  }>>`
    WITH eligible AS (
      SELECT t.id, t.condition_id, t.ts, t.price, tf.won
      FROM trades t
      JOIN trade_features tf ON tf.trade_id = t.id
      JOIN markets m ON m.condition_id = t.condition_id
      WHERE t.side = 'BUY'
        AND t.price >= ${cell.px_lo} AND t.price < ${cell.px_hi}
        AND tf.mom_24h >= ${cell.mom.min} AND tf.mom_24h <= ${cell.mom.max}
        AND t.size >= ${cell.size.min} AND t.size < ${cell.size.max}
        AND m.end_date IS NOT NULL AND m.resolution_ts IS NOT NULL
        AND t.ts >= ${OLDEST_MS}
        AND (EXTRACT(EPOCH FROM m.end_date) * 1000 - t.ts) / 3600000.0
            BETWEEN ${cell.htr.min} AND ${cell.htr.max}
    ),
    first_per_market AS (
      SELECT DISTINCT ON (condition_id) ts, price, won
      FROM eligible
      ORDER BY condition_id, ts ASC
    )
    SELECT
      (COUNT(*) FILTER (WHERE ts < ${MIDPOINT_MS}))::int AS n_older,
      (COUNT(*) FILTER (WHERE ts < ${MIDPOINT_MS} AND won = 1))::int AS w_older,
      (AVG(price) FILTER (WHERE ts < ${MIDPOINT_MS}))::float8 AS avg_px_older,
      (COUNT(*) FILTER (WHERE ts >= ${MIDPOINT_MS}))::int AS n_recent,
      (COUNT(*) FILTER (WHERE ts >= ${MIDPOINT_MS} AND won = 1))::int AS w_recent,
      (AVG(price) FILTER (WHERE ts >= ${MIDPOINT_MS}))::float8 AS avg_px_recent
    FROM first_per_market
  `;
  const r = rows[0];
  if (r.n_older < MIN_N_PER_HALF || r.n_recent < MIN_N_PER_HALF) return null;
  const wr_older = r.w_older / r.n_older;
  const wr_recent = r.w_recent / r.n_recent;
  const avg_px_older = r.avg_px_older ?? 0;
  const avg_px_recent = r.avg_px_recent ?? 0;
  if (avg_px_older < MIN_AVG_PX || avg_px_older > MAX_AVG_PX) return null;
  if (avg_px_recent < MIN_AVG_PX || avg_px_recent > MAX_AVG_PX) return null;
  const ev_older = wr_older / avg_px_older - 1;
  const ev_recent = wr_recent / avg_px_recent - 1;
  if (ev_older <= 0 || ev_recent <= 0) return null;
  const wr_delta = Math.abs(wr_older - wr_recent);
  if (wr_delta > MAX_WR_DELTA) return null;
  // Score by the LESSER of the two halves' EVs (conservative: cell's edge is its worst window).
  const rough_score = Math.min(ev_older, ev_recent);
  return {
    cell,
    n_older: r.n_older, w_older: r.w_older, wr_older, avg_px_older, ev_older,
    n_recent: r.n_recent, w_recent: r.w_recent, wr_recent, avg_px_recent, ev_recent,
    wr_delta, rough_score,
  };
}

type CellTrade = { ts: number; price: number; size: number; scheduled_end_ms: number; resolution_ts: number; won: 0 | 1; mom_24h: number; condition_id: string; outcome: "YES" | "NO" };

async function loadCellTrades(cell: Cell): Promise<CellTrade[]> {
  // BUGFIX: htr filter in SQL before DISTINCT ON.
  const ts_min = OLDEST_MS - PRIOR_BUFFER_DAYS * MS_PER_DAY;
  const rows = await sql<Array<{
    ts: number; price: number; size: number;
    scheduled_end_ms: number; resolution_ts: number;
    won: number; mom_24h: number;
    condition_id: string; outcome: string;
  }>>`
    WITH eligible AS (
      SELECT t.id, t.condition_id, t.ts::bigint AS ts, t.price::float8 AS price, t.size::float8 AS size,
        (EXTRACT(EPOCH FROM m.end_date) * 1000)::bigint AS scheduled_end_ms,
        m.resolution_ts::bigint AS resolution_ts,
        tf.won::int AS won, tf.mom_24h::float8 AS mom_24h, t.outcome
      FROM trades t
      JOIN trade_features tf ON tf.trade_id = t.id
      JOIN markets m ON m.condition_id = t.condition_id
      WHERE t.side = 'BUY'
        AND t.price >= ${cell.px_lo} AND t.price < ${cell.px_hi}
        AND tf.mom_24h >= ${cell.mom.min} AND tf.mom_24h <= ${cell.mom.max}
        AND t.size >= ${cell.size.min} AND t.size < ${cell.size.max}
        AND m.end_date IS NOT NULL AND m.resolution_ts IS NOT NULL
        AND t.ts >= ${ts_min}
        AND (EXTRACT(EPOCH FROM m.end_date) * 1000 - t.ts) / 3600000.0
            BETWEEN ${cell.htr.min} AND ${cell.htr.max}
    )
    SELECT DISTINCT ON (condition_id)
      ts, price, size, scheduled_end_ms, resolution_ts, won, mom_24h, condition_id, outcome
    FROM eligible
    ORDER BY condition_id, ts ASC
  `;
  const out: CellTrade[] = [];
  for (const r of rows) {
    out.push({
      ts: Number(r.ts), price: r.price, size: r.size,
      scheduled_end_ms: Number(r.scheduled_end_ms),
      resolution_ts: Number(r.resolution_ts),
      won: r.won === 1 ? 1 : 0, mom_24h: r.mom_24h,
      condition_id: r.condition_id,
      outcome: (r.outcome === "YES" ? "YES" : "NO") as "YES" | "NO",
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function walkForwardPrior(trades: CellTrade[], windowStartMs: number): number {
  let n = 0, w = 0;
  for (const t of trades) {
    if (t.ts >= windowStartMs) break;
    n++; w += t.won;
  }
  if (n < MIN_PRIOR_SAMPLES) return DEFAULT_PRIOR_WR;
  return w / n;
}

type WindowResult = { start_ms: number; final_equity: number; return_pct: number; n_trades: number; n_wins: number };

function runWindowBacktest(cell: Cell, trades: CellTrade[], windowStartMs: number, windowDays: number, priceLookup: PriceLookup): WindowResult {
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
    condition_id: t.condition_id, outcome: t.outcome,
    abs_entry_ts: t.ts,
  }));
  const agents: AgentConfig[] = [{
    name: "cell", alloc_pct: 1.0,
    kelly_full: kellyFull, kelly_mult: 1.0,
    max_pct_per_trade: 0.25, max_concurrent: 10,
  }];
  const cfg: EngineConfig = {
    agents, starting_bankroll: STARTING_BANKROLL,
    days: windowDays, killswitch_dd_pct: KILLSWITCH_DD_PCT,
    price_lookup: priceLookup, window_start_abs_ts: windowStartMs,
  };
  const out = runWindow(entries, cfg);
  return {
    start_ms: windowStartMs,
    final_equity: out.final_equity,
    return_pct: (out.final_equity / STARTING_BANKROLL - 1) * 100,
    n_trades: out.agent_entries[0], n_wins: out.agent_wins[0],
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function summarize(results: WindowResult[]) {
  const returns = results.map((r) => r.return_pct).sort((a, b) => a - b);
  const wins = returns.filter((v) => v > 0).length;
  const n = Math.max(1, returns.length);
  return {
    n_windows: results.length,
    median: quantile(returns, 0.5),
    p10: quantile(returns, 0.1), p90: quantile(returns, 0.9),
    worst: returns[0] ?? 0, best: returns[returns.length - 1] ?? 0,
    p_positive: wins / n,
    p_loss: returns.filter((v) => v < 0).length / n,
    p_2x: returns.filter((v) => v >= 100).length / n,
  };
}

function pad(s: string, n: number): string { return s.length >= n ? s : s + " ".repeat(n - s.length); }
function rpad(s: string, n: number): string { return s.length >= n ? s : " ".repeat(n - s.length) + s; }

(async () => {
  const totalCells = PRICE_BANDS.length * MOM_BANDS.length * HTR_BANDS.length * SIZE_BANDS.length;
  console.log(`[honest-2yr] 2-YEAR mining with OOS regime-stability filter built into Phase 1`);
  console.log(`[honest-2yr] grid: ${PRICE_BANDS.length} × ${MOM_BANDS.length} × ${HTR_BANDS.length} × ${SIZE_BANDS.length} = ${totalCells} cells`);
  console.log(`[honest-2yr] OOS midpoint: ${new Date(MIDPOINT_MS).toISOString().slice(0, 10)}`);
  console.log(`[honest-2yr] Phase 1: n>=${MIN_N_PER_HALF} per half, EV>0 in BOTH halves, |WR_delta|<=${MAX_WR_DELTA * 100}pp`);
  console.log("");

  console.log("[honest-2yr] PHASE 1: SQL grid search...");
  const t0 = Date.now();
  const phase1: Phase1Result[] = [];
  let evaluated = 0;
  for (const [px_lo, px_hi] of PRICE_BANDS) {
    for (const mom of MOM_BANDS) {
      for (const htr of HTR_BANDS) {
        for (const size of SIZE_BANDS) {
          const r = await phase1Cell({ px_lo, px_hi, mom, htr, size });
          if (r) phase1.push(r);
          evaluated++;
          if (evaluated % 200 === 0) console.log(`  [honest-2yr]   ${evaluated}/${totalCells}`);
        }
      }
    }
  }
  phase1.sort((a, b) => b.rough_score - a.rough_score);
  console.log(`[honest-2yr]   phase 1 done in ${((Date.now() - t0) / 1000).toFixed(1)}s. ${phase1.length} cells pass regime-stability check.`);
  console.log("");

  if (phase1.length === 0) {
    console.log("[honest-2yr] NO CELLS PASS PHASE 1. No regime-stable cells in the 2-year dataset.");
    console.log("[honest-2yr] This is itself a finding: the grid does not contain a durable-edge cell at this resolution.");
    await sql.end();
    return;
  }

  // Show Phase 1 winners
  console.log("=".repeat(160));
  console.log(`PHASE 1 PASSING CELLS (regime-stable per-trade): ${phase1.length}`);
  console.log("=".repeat(160));
  console.log(`  ${pad("cell", 40)} ${rpad("n_old", 6)} ${rpad("wr_old", 7)} ${rpad("ev_old", 7)} ${rpad("n_rec", 6)} ${rpad("wr_rec", 7)} ${rpad("ev_rec", 7)} ${rpad("wr_dlt", 7)} ${rpad("min_ev", 7)}`);
  for (const r of phase1.slice(0, 50)) {
    const c = r.cell;
    const lbl = `${c.px_lo.toFixed(2)}-${c.px_hi.toFixed(2)}/${c.mom.name}/${c.htr.name}/${c.size.name}`;
    console.log(`  ${pad(lbl, 40)} ${rpad(r.n_older.toString(), 6)} ${rpad((r.wr_older * 100).toFixed(1) + "%", 7)} ${rpad((r.ev_older * 100).toFixed(1) + "%", 7)} ${rpad(r.n_recent.toString(), 6)} ${rpad((r.wr_recent * 100).toFixed(1) + "%", 7)} ${rpad((r.ev_recent * 100).toFixed(1) + "%", 7)} ${rpad((r.wr_delta * 100).toFixed(1) + "pp", 7)} ${rpad((r.rough_score * 100).toFixed(1) + "%", 7)}`);
  }
  console.log("");

  const candidates = phase1.slice(0, TOP_N_FOR_VALIDATION);

  console.log(`[honest-2yr] PHASE 2: load trade data for top ${candidates.length} candidates + build price cache...`);
  const t1 = Date.now();
  const cellTrades: CellTrade[][] = [];
  const allCids = new Set<string>();
  for (const c of candidates) {
    const tr = await loadCellTrades(c.cell);
    cellTrades.push(tr);
    for (const t of tr) allCids.add(t.condition_id);
  }
  const cache = await buildPriceCache(sql, Array.from(allCids));
  const priceLookup: PriceLookup = (cid, outc, ts) => lookupPriceAt(cache, cid, outc, ts);
  console.log(`[honest-2yr]   phase 2 done in ${((Date.now() - t1) / 1000).toFixed(1)}s. ${allCids.size} markets.`);
  console.log("");

  console.log("[honest-2yr] PHASE 3: rolling windows w/ walk-forward prior + OOS split...");
  const t2 = Date.now();
  const window30Starts: number[] = [];
  for (let ts = OLDEST_MS; ts + WINDOW_SHORT_DAYS * MS_PER_DAY <= NOW_MS; ts += WINDOW_SHORT_STEP_DAYS * MS_PER_DAY) window30Starts.push(ts);
  const window90Starts: number[] = [];
  for (let ts = OLDEST_MS; ts + WINDOW_LONG_DAYS * MS_PER_DAY <= NOW_MS; ts += WINDOW_LONG_STEP_DAYS * MS_PER_DAY) window90Starts.push(ts);
  console.log(`[honest-2yr]   ${window30Starts.length} × 30d + ${window90Starts.length} × 90d per cell`);

  const winners: Array<{
    cell: Cell; p1: Phase1Result;
    s30_old: ReturnType<typeof summarize>; s30_rec: ReturnType<typeof summarize>;
    s90_old: ReturnType<typeof summarize>; s90_rec: ReturnType<typeof summarize>;
  }> = [];
  for (let ci = 0; ci < candidates.length; ci++) {
    const c = candidates[ci];
    const trades = cellTrades[ci];
    const r30s = window30Starts.map((ws) => runWindowBacktest(c.cell, trades, ws, WINDOW_SHORT_DAYS, priceLookup));
    const r90s = window90Starts.map((ws) => runWindowBacktest(c.cell, trades, ws, WINDOW_LONG_DAYS, priceLookup));
    const r30_old = r30s.filter((r) => r.start_ms + WINDOW_SHORT_DAYS * MS_PER_DAY <= MIDPOINT_MS);
    const r30_rec = r30s.filter((r) => r.start_ms >= MIDPOINT_MS);
    const r90_old = r90s.filter((r) => r.start_ms + WINDOW_LONG_DAYS * MS_PER_DAY <= MIDPOINT_MS);
    const r90_rec = r90s.filter((r) => r.start_ms >= MIDPOINT_MS);
    const s30_old = summarize(r30_old), s30_rec = summarize(r30_rec);
    const s90_old = summarize(r90_old), s90_rec = summarize(r90_rec);
    const passes = s30_old.median > MIN_MEDIAN_RETURN_PCT && s30_old.p_positive >= MIN_P_POSITIVE
                && s30_rec.median > MIN_MEDIAN_RETURN_PCT && s30_rec.p_positive >= MIN_P_POSITIVE
                && s90_old.median > MIN_MEDIAN_RETURN_PCT && s90_old.p_positive >= MIN_P_POSITIVE
                && s90_rec.median > MIN_MEDIAN_RETURN_PCT && s90_rec.p_positive >= MIN_P_POSITIVE;
    if (passes) winners.push({ cell: c.cell, p1: c, s30_old, s30_rec, s90_old, s90_rec });
  }
  console.log(`[honest-2yr]   phase 3 done in ${((Date.now() - t2) / 1000).toFixed(1)}s.`);
  console.log("");

  console.log("=".repeat(160));
  console.log(`FINAL WINNERS: ${winners.length} cells pass Phase 1 (regime-stable per-trade EV) AND Phase 3 (rolling-window medians in BOTH halves on BOTH horizons)`);
  console.log("=".repeat(160));
  if (winners.length === 0) {
    console.log("  (none)");
    console.log("");
    console.log("This means: NO cell in the entire 2-year mining grid has a durable, regime-stable edge by the rolling-window + OOS criteria.");
    console.log("The honest conclusion: the grid we searched does not contain a 'set-and-forget' strategy. Edges in this data are regime-dependent.");
  } else {
    for (const w of winners) {
      const c = w.cell;
      const lbl = `${c.px_lo.toFixed(2)}-${c.px_hi.toFixed(2)}/${c.mom.name}/${c.htr.name}/${c.size.name}`;
      console.log(`  ${lbl}`);
      console.log(`    P1: wr_older=${(w.p1.wr_older * 100).toFixed(0)}% (n=${w.p1.n_older})  wr_recent=${(w.p1.wr_recent * 100).toFixed(0)}% (n=${w.p1.n_recent})  ev_min=${(w.p1.rough_score * 100).toFixed(1)}%`);
      console.log(`    30d older:  median=${w.s30_old.median.toFixed(1)}%  P(pos)=${(w.s30_old.p_positive * 100).toFixed(0)}%`);
      console.log(`    30d recent: median=${w.s30_rec.median.toFixed(1)}%  P(pos)=${(w.s30_rec.p_positive * 100).toFixed(0)}%`);
      console.log(`    90d older:  median=${w.s90_old.median.toFixed(1)}%  P(pos)=${(w.s90_old.p_positive * 100).toFixed(0)}%`);
      console.log(`    90d recent: median=${w.s90_rec.median.toFixed(1)}%  P(pos)=${(w.s90_rec.p_positive * 100).toFixed(0)}%`);
      console.log("");
    }
  }

  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
