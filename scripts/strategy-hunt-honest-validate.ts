// Deep validation of the 3 cells that passed the honest hunt's 30d+90d overlap.
// Three rigor upgrades over the original honest hunt:
//
//   1. EXTEND RANGE TO 2 YEARS. Rolling windows now span 2025-05 -> 2024-05
//      and 2024-05 -> 2026-05, doubling the sample size.
//
//   2. OUT-OF-SAMPLE SPLIT. We bisect the 2-year span at the midpoint and
//      report distributions for the OLDER half vs the RECENT half
//      separately. A cell with genuine edge should win in BOTH halves,
//      not just one. If it only wins recently, that's regime-fit and
//      likely won't generalize forward.
//
//   3. QUARTERLY BREAKDOWN. For each cell, we show rolling-30d returns
//      bucketed by calendar quarter (2024Q1 through 2026Q2). Lets us spot
//      regime-shift effects directly - a cell that bled in 2024 and only
//      shines recently is suspect.
//
// Methodology preserved from strategy-hunt-honest.ts:
//   - Strategy htr filter uses SCHEDULED end_date (matches live)
//   - Engine duration uses ACTUAL resolution_ts (matches reality)
//   - Kelly sizing uses WALK-FORWARD prior (no future leak)
//
// Run: tsx scripts/strategy-hunt-honest-validate.ts

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

const WINDOW_SHORT_DAYS = 30;
const WINDOW_LONG_DAYS = 90;
const WINDOW_SHORT_STEP_DAYS = 7;
const WINDOW_LONG_STEP_DAYS = 14;
const RANGE_DAYS = 730;
const PRIOR_BUFFER_DAYS = 180;
const MIN_PRIOR_SAMPLES = 20;
const DEFAULT_PRIOR_WR = 0.5;

type Cell = {
  label: string;
  price_min: number;
  price_max: number;
  mom_min: number;
  mom_max: number;
  htr_min: number;
  htr_max: number;
  size_min: number;
  size_max: number;
};

// The 3 winners from strategy-hunt-honest.ts overlap.
const TOP3: Cell[] = [
  // #1: 0.15-0.20 / rising / 6-24h / med
  { label: "longshot_rising_med",       price_min: 0.15, price_max: 0.20, mom_min: 0.02, mom_max: 10,    htr_min: 6, htr_max: 24, size_min: 25, size_max: 200 },
  // #2: 0.40-0.45 / falling / <6h / med  (the standout - 100% P(positive) on 90d)
  { label: "midband_falling_flash_med", price_min: 0.40, price_max: 0.45, mom_min: -10,  mom_max: -0.02, htr_min: 0, htr_max: 6,  size_min: 25, size_max: 200 },
  // #3: 0.45-0.50 / falling / <6h / med
  { label: "nearcoin_falling_flash_med",price_min: 0.45, price_max: 0.50, mom_min: -10,  mom_max: -0.02, htr_min: 0, htr_max: 6,  size_min: 25, size_max: 200 },
];

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

async function loadCellTrades(cell: Cell): Promise<CellTrade[]> {
  // Pull trades over (RANGE + buffer) so walk-forward prior has history even
  // for the oldest test windows.
  const ts_min = NOW_MS - (RANGE_DAYS + PRIOR_BUFFER_DAYS) * MS_PER_DAY;
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
      AND t.price >= ${cell.price_min} AND t.price < ${cell.price_max}
      AND tf.mom_24h >= ${cell.mom_min} AND tf.mom_24h <= ${cell.mom_max}
      AND t.size >= ${cell.size_min} AND t.size < ${cell.size_max}
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
    if (schedHtr < cell.htr_min || schedHtr > cell.htr_max) continue;
    out.push({
      ts, price: r.price, size: r.size,
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

function walkForwardPrior(trades: CellTrade[], windowStartMs: number): number {
  let n = 0, w = 0;
  for (const t of trades) {
    if (t.ts >= windowStartMs) break;
    n++;
    w += t.won;
  }
  if (n < MIN_PRIOR_SAMPLES) return DEFAULT_PRIOR_WR;
  return w / n;
}

type WindowResult = {
  start_ms: number;
  final_equity: number;
  return_pct: number;
  n_trades: number;
  n_wins: number;
  killed: boolean;
};

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
    condition_id: t.condition_id,
    outcome: t.outcome,
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
    n_trades: out.agent_entries[0],
    n_wins: out.agent_wins[0],
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
    median: quantile(returns, 0.5),
    mean,
    p10: quantile(returns, 0.1),
    p25: quantile(returns, 0.25),
    p75: quantile(returns, 0.75),
    p90: quantile(returns, 0.9),
    worst: returns[0] ?? 0,
    best: returns[returns.length - 1] ?? 0,
    p_positive: wins / n,
    p_loss: losses / n,
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
  console.log(`[honest-validate] deep validation of top 3 honest-hunt cells over ${RANGE_DAYS}-day range`);
  console.log(`[honest-validate] now=${new Date(NOW_MS).toISOString()}, ks=${KILLSWITCH_DD_PCT}%, $${STARTING_BANKROLL} start`);
  console.log(`[honest-validate] rolling 30d (step ${WINDOW_SHORT_STEP_DAYS}d) and 90d (step ${WINDOW_LONG_STEP_DAYS}d)`);
  console.log(`[honest-validate] OOS split: older year vs recent year`);
  console.log("");

  // Generate window starts over 2 years
  const window30Starts: number[] = [];
  for (let ts = NOW_MS - RANGE_DAYS * MS_PER_DAY; ts + WINDOW_SHORT_DAYS * MS_PER_DAY <= NOW_MS; ts += WINDOW_SHORT_STEP_DAYS * MS_PER_DAY) {
    window30Starts.push(ts);
  }
  const window90Starts: number[] = [];
  for (let ts = NOW_MS - RANGE_DAYS * MS_PER_DAY; ts + WINDOW_LONG_DAYS * MS_PER_DAY <= NOW_MS; ts += WINDOW_LONG_STEP_DAYS * MS_PER_DAY) {
    window90Starts.push(ts);
  }
  console.log(`[honest-validate] will run ${window30Starts.length} × 30d + ${window90Starts.length} × 90d per cell`);
  const midpointMs = NOW_MS - (RANGE_DAYS / 2) * MS_PER_DAY;
  console.log(`[honest-validate] OOS split at ${new Date(midpointMs).toISOString().slice(0, 10)} (midpoint)`);
  console.log("");

  // Load trade data per cell + build price cache
  console.log("[honest-validate] loading trade data + building price cache...");
  const t0 = Date.now();
  const cellTrades: CellTrade[][] = [];
  const allCids = new Set<string>();
  for (const c of TOP3) {
    const tr = await loadCellTrades(c);
    cellTrades.push(tr);
    for (const t of tr) allCids.add(t.condition_id);
    console.log(`[honest-validate]   ${c.label}: ${tr.length} trades over loaded range`);
  }
  const cidList = Array.from(allCids);
  const cache = await buildPriceCache(sql, cidList);
  const priceLookup: PriceLookup = (cid, outc, ts) => lookupPriceAt(cache, cid, outc, ts);
  console.log(`[honest-validate]   price cache: ${cidList.length} markets, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("");

  // Run backtests per cell
  for (let ci = 0; ci < TOP3.length; ci++) {
    const cell = TOP3[ci];
    const trades = cellTrades[ci];

    const r30s = window30Starts.map((ws) => runWindowBacktest(cell, trades, ws, WINDOW_SHORT_DAYS, priceLookup));
    const r90s = window90Starts.map((ws) => runWindowBacktest(cell, trades, ws, WINDOW_LONG_DAYS, priceLookup));

    // Split: older half vs recent half
    const r30_older = r30s.filter((r) => r.start_ms + WINDOW_SHORT_DAYS * MS_PER_DAY <= midpointMs);
    const r30_recent = r30s.filter((r) => r.start_ms >= midpointMs);
    const r90_older = r90s.filter((r) => r.start_ms + WINDOW_LONG_DAYS * MS_PER_DAY <= midpointMs);
    const r90_recent = r90s.filter((r) => r.start_ms >= midpointMs);

    const s30_all = summarize(r30s);
    const s30_older = summarize(r30_older);
    const s30_recent = summarize(r30_recent);
    const s90_all = summarize(r90s);
    const s90_older = summarize(r90_older);
    const s90_recent = summarize(r90_recent);

    console.log("=".repeat(160));
    console.log(`CELL: ${cell.label}  (price ${cell.price_min}-${cell.price_max}, mom ${cell.mom_min}/${cell.mom_max}, htr ${cell.htr_min}-${cell.htr_max}h, size ${cell.size_min}-${cell.size_max})`);
    console.log("=".repeat(160));
    console.log("");

    // OOS split table
    console.log("OOS split (older year vs recent year vs combined):");
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

    // Quarterly breakdown (30d)
    const byQ = new Map<string, WindowResult[]>();
    for (const r of r30s) {
      const q = quarterKey(r.start_ms);
      const arr = byQ.get(q) ?? [];
      arr.push(r);
      byQ.set(q, arr);
    }
    const quarters = Array.from(byQ.keys()).sort();
    console.log("Quarterly breakdown (rolling 30d windows by start quarter):");
    console.log(`  ${pad("quarter", 9)} ${rpad("n_wins", 7)} ${rpad("median", 9)} ${rpad("P(pos)", 7)} ${rpad("worst", 8)} ${rpad("best", 8)}`);
    for (const q of quarters) {
      const s = summarize(byQ.get(q)!);
      console.log(`  ${pad(q, 9)} ${rpad(s.n_windows.toString(), 7)} ${rpad((s.median >= 0 ? "+" : "") + s.median.toFixed(1) + "%", 9)} ${rpad((s.p_positive * 100).toFixed(0) + "%", 7)} ${rpad((s.worst >= 0 ? "+" : "") + s.worst.toFixed(0) + "%", 8)} ${rpad((s.best >= 0 ? "+" : "") + s.best.toFixed(0) + "%", 8)}`);
    }
    console.log("");

    // Verdict
    const passes30_older = s30_older.median > 0 && s30_older.p_positive >= 0.60;
    const passes30_recent = s30_recent.median > 0 && s30_recent.p_positive >= 0.60;
    const passes90_older = s90_older.median > 0 && s90_older.p_positive >= 0.60;
    const passes90_recent = s90_recent.median > 0 && s90_recent.p_positive >= 0.60;
    const passesAll = passes30_older && passes30_recent && passes90_older && passes90_recent;
    console.log("Verdict:");
    console.log(`  30d older OOS:   ${passes30_older ? "PASS" : "FAIL"}  (median ${s30_older.median.toFixed(1)}%, P(pos) ${(s30_older.p_positive * 100).toFixed(0)}%)`);
    console.log(`  30d recent OOS:  ${passes30_recent ? "PASS" : "FAIL"}  (median ${s30_recent.median.toFixed(1)}%, P(pos) ${(s30_recent.p_positive * 100).toFixed(0)}%)`);
    console.log(`  90d older OOS:   ${passes90_older ? "PASS" : "FAIL"}  (median ${s90_older.median.toFixed(1)}%, P(pos) ${(s90_older.p_positive * 100).toFixed(0)}%)`);
    console.log(`  90d recent OOS:  ${passes90_recent ? "PASS" : "FAIL"}  (median ${s90_recent.median.toFixed(1)}%, P(pos) ${(s90_recent.p_positive * 100).toFixed(0)}%)`);
    console.log(`  OVERALL: ${passesAll ? "PASS - cell wins in BOTH halves on BOTH horizons (durable edge)" : "FAIL - cell fails at least one half/horizon (regime-fit risk)"}`);
    console.log("");
  }

  console.log("CALLOUTS:");
  console.log("  - 'OLDER half' is the year BEFORE the midpoint - data the honest hunt did NOT have when ranking these cells.");
  console.log("  - 'RECENT half' is the year of the honest hunt's mining window - in-sample, expect inflated numbers here.");
  console.log("  - A cell only deserves real money if it passes both halves. Recent-only passes are regime-fit, not edge.");
  console.log("  - Walk-forward prior protects sizing but not selection. Out-of-sample split protects selection.");

  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
