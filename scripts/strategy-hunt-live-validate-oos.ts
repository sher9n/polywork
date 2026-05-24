// OOS validation of the CURRENT LIVE bot's strategies.
// Question: did the live portfolio's "+158% over 365d realistic" result
// hold up before the current regime, or is it also regime-fit?
//
// Methodology: same as honest-validate (scheduled-end filter, actual-resolution
// duration, walk-forward prior, rolling windows). 2-year range, OOS-split into
// older year and recent year. Cells pass if median > 0 AND P(positive) >= 60%
// in BOTH halves on BOTH horizons.
//
// Run: tsx scripts/strategy-hunt-live-validate-oos.ts

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
const RANGE_DAYS = 730;
const PRIOR_BUFFER_DAYS = 180;
const MIN_PRIOR_SAMPLES = 20;
const DEFAULT_PRIOR_WR = 0.5;
const WINDOW_SHORT_DAYS = 30;
const WINDOW_LONG_DAYS = 90;
const WINDOW_SHORT_STEP_DAYS = 7;
const WINDOW_LONG_STEP_DAYS = 14;

type Cell = {
  label: string;
  price_min: number;
  price_max: number;
  mom_min: number;
  mom_max: number;
  htr_min: number;
  htr_max: number;
};

// Current live strategies from seed-agents.ts (no size filter in live).
const LIVE_CELLS: Cell[] = [
  { label: "mid_fav_day",   price_min: 0.70, price_max: 0.75, mom_min: -0.02, mom_max: 0.02, htr_min: 12,  htr_max: 24 },
  { label: "mid_fav_flash", price_min: 0.70, price_max: 0.75, mom_min: -0.02, mom_max: 0.02, htr_min: 0.5, htr_max: 6  },
  { label: "mid_lottery",   price_min: 0.20, price_max: 0.25, mom_min: 0.02,  mom_max: 10,   htr_min: 6,   htr_max: 12 },
];

type CellTrade = {
  ts: number; price: number; size: number;
  scheduled_end_ms: number; resolution_ts: number;
  won: 0 | 1; mom_24h: number;
  condition_id: string; outcome: "YES" | "NO";
};

async function loadCellTrades(cell: Cell): Promise<CellTrade[]> {
  // BUGFIX: filter htr in SQL BEFORE DISTINCT ON. Otherwise DISTINCT picks
  // the earliest qualifying-price/mom trade per market and the htr filter
  // then drops markets whose earliest such trade was outside the htr window
  // (very common - markets often have qualifying-price trades days before
  // their scheduled end). Result was an underselection of ~50-75%.
  const ts_min = NOW_MS - (RANGE_DAYS + PRIOR_BUFFER_DAYS) * MS_PER_DAY;
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
        AND t.price >= ${cell.price_min} AND t.price < ${cell.price_max}
        AND tf.mom_24h >= ${cell.mom_min} AND tf.mom_24h <= ${cell.mom_max}
        AND m.end_date IS NOT NULL AND m.resolution_ts IS NOT NULL
        AND t.ts >= ${ts_min}
        AND (EXTRACT(EPOCH FROM m.end_date) * 1000 - t.ts) / 3600000.0
            BETWEEN ${cell.htr_min} AND ${cell.htr_max}
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

type WindowResult = { start_ms: number; final_equity: number; return_pct: number; n_trades: number; n_wins: number; killed: boolean };

function runWindowBacktest(cell: Cell, trades: CellTrade[], windowStartMs: number, windowDays: number, priceLookup: PriceLookup): WindowResult {
  const windowEndMs = windowStartMs + windowDays * MS_PER_DAY;
  const inWindow = trades.filter((t) => t.ts >= windowStartMs && t.ts < windowEndMs);
  const priorWr = walkForwardPrior(trades, windowStartMs);
  const avgPxMid = (cell.price_min + cell.price_max) / 2;
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
    killed: out.killed,
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function summarize(results: WindowResult[]) {
  const returns = results.map((r) => r.return_pct).sort((a, b) => a - b);
  const mean = returns.length > 0 ? returns.reduce((s, v) => s + v, 0) / returns.length : 0;
  const wins = returns.filter((v) => v > 0).length;
  const losses = returns.filter((v) => v < 0).length;
  const n = Math.max(1, returns.length);
  return {
    n_windows: results.length,
    median: quantile(returns, 0.5), mean,
    p10: quantile(returns, 0.1), p90: quantile(returns, 0.9),
    worst: returns[0] ?? 0, best: returns[returns.length - 1] ?? 0,
    p_positive: wins / n, p_loss: losses / n,
    p_2x: returns.filter((v) => v >= 100).length / n,
  };
}

function quarterKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

function pad(s: string, n: number): string { return s.length >= n ? s : s + " ".repeat(n - s.length); }
function rpad(s: string, n: number): string { return s.length >= n ? s : " ".repeat(n - s.length) + s; }

(async () => {
  console.log(`[live-oos] OOS validation of CURRENT LIVE strategies over ${RANGE_DAYS}-day range`);
  console.log(`[live-oos] cells: ${LIVE_CELLS.map((c) => c.label).join(", ")}`);
  console.log(`[live-oos] OOS split at ${new Date(NOW_MS - (RANGE_DAYS / 2) * MS_PER_DAY).toISOString().slice(0, 10)}`);
  console.log("");

  const window30Starts: number[] = [];
  for (let ts = NOW_MS - RANGE_DAYS * MS_PER_DAY; ts + WINDOW_SHORT_DAYS * MS_PER_DAY <= NOW_MS; ts += WINDOW_SHORT_STEP_DAYS * MS_PER_DAY) window30Starts.push(ts);
  const window90Starts: number[] = [];
  for (let ts = NOW_MS - RANGE_DAYS * MS_PER_DAY; ts + WINDOW_LONG_DAYS * MS_PER_DAY <= NOW_MS; ts += WINDOW_LONG_STEP_DAYS * MS_PER_DAY) window90Starts.push(ts);

  console.log(`[live-oos] ${window30Starts.length} 30d + ${window90Starts.length} 90d windows per cell`);
  const midpointMs = NOW_MS - (RANGE_DAYS / 2) * MS_PER_DAY;

  console.log("[live-oos] loading trade data...");
  const cellTrades: CellTrade[][] = [];
  const allCids = new Set<string>();
  for (const c of LIVE_CELLS) {
    const tr = await loadCellTrades(c);
    cellTrades.push(tr);
    for (const t of tr) allCids.add(t.condition_id);
    console.log(`[live-oos]   ${c.label}: ${tr.length} trades`);
  }
  const cache = await buildPriceCache(sql, Array.from(allCids));
  const priceLookup: PriceLookup = (cid, outc, ts) => lookupPriceAt(cache, cid, outc, ts);
  console.log("");

  let nPasses = 0;
  for (let ci = 0; ci < LIVE_CELLS.length; ci++) {
    const cell = LIVE_CELLS[ci];
    const trades = cellTrades[ci];
    const r30s = window30Starts.map((ws) => runWindowBacktest(cell, trades, ws, WINDOW_SHORT_DAYS, priceLookup));
    const r90s = window90Starts.map((ws) => runWindowBacktest(cell, trades, ws, WINDOW_LONG_DAYS, priceLookup));
    const r30_older = r30s.filter((r) => r.start_ms + WINDOW_SHORT_DAYS * MS_PER_DAY <= midpointMs);
    const r30_recent = r30s.filter((r) => r.start_ms >= midpointMs);
    const r90_older = r90s.filter((r) => r.start_ms + WINDOW_LONG_DAYS * MS_PER_DAY <= midpointMs);
    const r90_recent = r90s.filter((r) => r.start_ms >= midpointMs);

    const s30_older = summarize(r30_older), s30_recent = summarize(r30_recent), s30_all = summarize(r30s);
    const s90_older = summarize(r90_older), s90_recent = summarize(r90_recent), s90_all = summarize(r90s);

    console.log("=".repeat(160));
    console.log(`CELL: ${cell.label}  (price ${cell.price_min}-${cell.price_max}, mom ${cell.mom_min}/${cell.mom_max}, htr ${cell.htr_min}-${cell.htr_max}h)`);
    console.log("=".repeat(160));
    console.log(`  ${pad("period", 22)} ${pad("horizon", 8)} ${rpad("n", 5)} ${rpad("median", 9)} ${rpad("p10", 8)} ${rpad("p90", 8)} ${rpad("worst", 8)} ${rpad("best", 8)} ${rpad("P(pos)", 7)} ${rpad("P(loss)", 8)} ${rpad("P(2x)", 7)}`);
    for (const [periodLabel, sShort, sLong] of [
      ["OLDER half (yr 1)", s30_older, s90_older],
      ["RECENT half (yr 2)", s30_recent, s90_recent],
      ["FULL 2 years", s30_all, s90_all],
    ] as const) {
      for (const [horiz, s] of [["30d", sShort], ["90d", sLong]] as const) {
        console.log(`  ${pad(periodLabel, 22)} ${pad(horiz, 8)} ${rpad(s.n_windows.toString(), 5)} ${rpad((s.median >= 0 ? "+" : "") + s.median.toFixed(1) + "%", 9)} ${rpad((s.p10 >= 0 ? "+" : "") + s.p10.toFixed(0) + "%", 8)} ${rpad((s.p90 >= 0 ? "+" : "") + s.p90.toFixed(0) + "%", 8)} ${rpad((s.worst >= 0 ? "+" : "") + s.worst.toFixed(0) + "%", 8)} ${rpad((s.best >= 0 ? "+" : "") + s.best.toFixed(0) + "%", 8)} ${rpad((s.p_positive * 100).toFixed(0) + "%", 7)} ${rpad((s.p_loss * 100).toFixed(0) + "%", 8)} ${rpad((s.p_2x * 100).toFixed(0) + "%", 7)}`);
      }
    }
    console.log("");

    // Quarterly breakdown
    const byQ = new Map<string, WindowResult[]>();
    for (const r of r30s) {
      const q = quarterKey(r.start_ms);
      const arr = byQ.get(q) ?? [];
      arr.push(r);
      byQ.set(q, arr);
    }
    const quarters = Array.from(byQ.keys()).sort();
    console.log("Quarterly breakdown (rolling 30d windows):");
    console.log(`  ${pad("quarter", 9)} ${rpad("n", 5)} ${rpad("median", 9)} ${rpad("P(pos)", 7)} ${rpad("worst", 8)} ${rpad("best", 8)}`);
    for (const q of quarters) {
      const s = summarize(byQ.get(q)!);
      console.log(`  ${pad(q, 9)} ${rpad(s.n_windows.toString(), 5)} ${rpad((s.median >= 0 ? "+" : "") + s.median.toFixed(1) + "%", 9)} ${rpad((s.p_positive * 100).toFixed(0) + "%", 7)} ${rpad((s.worst >= 0 ? "+" : "") + s.worst.toFixed(0) + "%", 8)} ${rpad((s.best >= 0 ? "+" : "") + s.best.toFixed(0) + "%", 8)}`);
    }
    console.log("");

    const passes30_older = s30_older.median > 0 && s30_older.p_positive >= 0.60;
    const passes30_recent = s30_recent.median > 0 && s30_recent.p_positive >= 0.60;
    const passes90_older = s90_older.median > 0 && s90_older.p_positive >= 0.60;
    const passes90_recent = s90_recent.median > 0 && s90_recent.p_positive >= 0.60;
    const passesAll = passes30_older && passes30_recent && passes90_older && passes90_recent;
    if (passesAll) nPasses++;
    console.log(`Verdict:`);
    console.log(`  30d older OOS:   ${passes30_older ? "PASS" : "FAIL"}  (median ${s30_older.median.toFixed(1)}%, P(pos) ${(s30_older.p_positive * 100).toFixed(0)}%)`);
    console.log(`  30d recent OOS:  ${passes30_recent ? "PASS" : "FAIL"}  (median ${s30_recent.median.toFixed(1)}%, P(pos) ${(s30_recent.p_positive * 100).toFixed(0)}%)`);
    console.log(`  90d older OOS:   ${passes90_older ? "PASS" : "FAIL"}  (median ${s90_older.median.toFixed(1)}%, P(pos) ${(s90_older.p_positive * 100).toFixed(0)}%)`);
    console.log(`  90d recent OOS:  ${passes90_recent ? "PASS" : "FAIL"}  (median ${s90_recent.median.toFixed(1)}%, P(pos) ${(s90_recent.p_positive * 100).toFixed(0)}%)`);
    console.log(`  OVERALL: ${passesAll ? "PASS - durable edge in BOTH halves on BOTH horizons" : "FAIL - regime-fit risk"}`);
    console.log("");
  }

  console.log(`SUMMARY: ${nPasses} of ${LIVE_CELLS.length} live cells pass OOS validation.`);

  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
