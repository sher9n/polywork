// Nightly cron entry: re-runs the honest 2-year hunt (the one with built-in
// OOS regime-stability filter), persists the result to strategy_hunt_runs,
// and surfaces new candidates in the lab. Designed to run unattended.
//
// Run: tsx scripts/run-nightly-hunt.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
import { runWindow, fullKelly, type Entry, type EngineConfig, type AgentConfig, type PriceLookup } from "../src/lib/backtest-engine";
import { buildPriceCache, lookupPriceAt } from "../src/lib/price-cache";
import { notify } from "../src/lib/email";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

const STARTING_BANKROLL = 1000;
const KILLSWITCH_DD_PCT = 50;
const MS_PER_DAY = 86400 * 1000;
const NOW_MS = Date.now();
const RANGE_DAYS = 730;
const MIDPOINT_MS = NOW_MS - (RANGE_DAYS / 2) * MS_PER_DAY;
const OLDEST_MS = NOW_MS - RANGE_DAYS * MS_PER_DAY;
// When > 0, applies a pre-trade 24h dollar volume filter at trade load.
// Surfaces cells that work in LIQUID markets (real-money relevant). When 0,
// runs the thin-market hunt unchanged. Cron runs both: thin-market scan plus
// MIN_PRE_VOL_24H_USD=5000 scan. Tagged as 'honest_2yr' or 'honest_2yr_liquid'.
const MIN_PRE_VOL_24H_USD = Number(process.env.MIN_PRE_VOL_24H_USD ?? 0);
const HUNT_TYPE = MIN_PRE_VOL_24H_USD > 0 ? "honest_2yr_liquid" : "honest_2yr";

const PRICE_BANDS: Array<[number, number]> = [];
for (let lo = 0.10; lo < 0.95; lo += 0.05) PRICE_BANDS.push([Math.round(lo * 100) / 100, Math.round((lo + 0.05) * 100) / 100]);
const MOM_BANDS = [
  { name: "any", min: -10, max: 10 },
  { name: "falling", min: -10, max: -0.02 },
  { name: "flat", min: -0.02, max: 0.02 },
  { name: "rising", min: 0.02, max: 10 },
];
const HTR_BANDS = [
  { name: "<6h", min: 0, max: 6 },
  { name: "6-24h", min: 6, max: 24 },
  { name: "24-72h", min: 24, max: 72 },
  { name: "72h+", min: 72, max: 99999 },
];
const SIZE_BANDS = [
  { name: "any", min: 0, max: 9e12 },
  { name: "small", min: 0, max: 25 },
  { name: "med", min: 25, max: 200 },
  { name: "large", min: 200, max: 9e12 },
];

const MIN_N_PER_HALF = 15;
const MAX_WR_DELTA = 0.10;
const TOP_N_FOR_VALIDATION = 20;
const PRIOR_BUFFER_DAYS = 180;
const WINDOW_SHORT_DAYS = 30;
const WINDOW_LONG_DAYS = 90;
const WINDOW_SHORT_STEP_DAYS = 7;
const WINDOW_LONG_STEP_DAYS = 14;
const MIN_PRIOR_SAMPLES = 20;
const DEFAULT_PRIOR_WR = 0.5;
const MIN_MEDIAN_RETURN_PCT = 0;
const MIN_P_POSITIVE = 0.60;

type Cell = { px_lo: number; px_hi: number; mom: typeof MOM_BANDS[number]; htr: typeof HTR_BANDS[number]; size: typeof SIZE_BANDS[number] };

type Phase1 = {
  cell: Cell; n_older: number; w_older: number; wr_older: number; avg_px_older: number; ev_older: number;
  n_recent: number; w_recent: number; wr_recent: number; avg_px_recent: number; ev_recent: number;
  wr_delta: number; rough_score: number;
};

async function phase1Cell(cell: Cell): Promise<Phase1 | null> {
  // When MIN_PRE_VOL_24H_USD > 0, compute pre-trade 24h dollar volume per
  // candidate trade and filter to liquid ones. The window function adds a
  // small cost per cell but is the only honest historical proxy for
  // order-book depth at trade time.
  const rows = await sql<Array<{ n_older: number; w_older: number; avg_px_older: number | null; n_recent: number; w_recent: number; avg_px_recent: number | null }>>`
    WITH eligible AS (
      SELECT t.id, t.condition_id, t.ts, t.price, t.size, tf.won,
        COALESCE(
          SUM(t.price * t.size) OVER (
            PARTITION BY t.condition_id ORDER BY t.ts
            RANGE BETWEEN 86400000 PRECEDING AND CURRENT ROW
          ) - (t.price * t.size),
          0
        )::float8 AS pre_vol_24h
      FROM trades t JOIN trade_features tf ON tf.trade_id = t.id JOIN markets m ON m.condition_id = t.condition_id
      WHERE t.side = 'BUY'
        AND t.price >= ${cell.px_lo} AND t.price < ${cell.px_hi}
        AND tf.mom_24h >= ${cell.mom.min} AND tf.mom_24h <= ${cell.mom.max}
        AND t.size >= ${cell.size.min} AND t.size < ${cell.size.max}
        AND m.end_date IS NOT NULL AND m.resolution_ts IS NOT NULL
        AND t.ts >= ${OLDEST_MS}
        AND (EXTRACT(EPOCH FROM m.end_date) * 1000 - t.ts) / 3600000.0 BETWEEN ${cell.htr.min} AND ${cell.htr.max}
    ),
    first_per_market AS (
      SELECT DISTINCT ON (condition_id) ts, price, won
      FROM eligible
      WHERE pre_vol_24h >= ${MIN_PRE_VOL_24H_USD}
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
  const wr_o = r.w_older / r.n_older, wr_r = r.w_recent / r.n_recent;
  const ax_o = r.avg_px_older ?? 0, ax_r = r.avg_px_recent ?? 0;
  if (ax_o < 0.05 || ax_o > 0.95 || ax_r < 0.05 || ax_r > 0.95) return null;
  const ev_o = wr_o / ax_o - 1, ev_r = wr_r / ax_r - 1;
  if (ev_o <= 0 || ev_r <= 0) return null;
  const dlt = Math.abs(wr_o - wr_r);
  if (dlt > MAX_WR_DELTA) return null;
  return { cell, n_older: r.n_older, w_older: r.w_older, wr_older: wr_o, avg_px_older: ax_o, ev_older: ev_o,
           n_recent: r.n_recent, w_recent: r.w_recent, wr_recent: wr_r, avg_px_recent: ax_r, ev_recent: ev_r,
           wr_delta: dlt, rough_score: Math.min(ev_o, ev_r) };
}

type CellTrade = { ts: number; price: number; resolution_ts: number; won: 0 | 1; condition_id: string; outcome: "YES" | "NO" };

async function loadCellTrades(cell: Cell): Promise<CellTrade[]> {
  const ts_min = OLDEST_MS - PRIOR_BUFFER_DAYS * MS_PER_DAY;
  const rows = await sql<Array<{ ts: number; price: number; resolution_ts: number; won: number; condition_id: string; outcome: string }>>`
    WITH eligible AS (
      SELECT t.id, t.condition_id, t.ts::bigint AS ts, t.price::float8 AS price, t.size,
        m.resolution_ts::bigint AS resolution_ts, tf.won::int AS won, t.outcome,
        COALESCE(
          SUM(t.price * t.size) OVER (
            PARTITION BY t.condition_id ORDER BY t.ts
            RANGE BETWEEN 86400000 PRECEDING AND CURRENT ROW
          ) - (t.price * t.size),
          0
        )::float8 AS pre_vol_24h
      FROM trades t JOIN trade_features tf ON tf.trade_id = t.id JOIN markets m ON m.condition_id = t.condition_id
      WHERE t.side = 'BUY'
        AND t.price >= ${cell.px_lo} AND t.price < ${cell.px_hi}
        AND tf.mom_24h >= ${cell.mom.min} AND tf.mom_24h <= ${cell.mom.max}
        AND t.size >= ${cell.size.min} AND t.size < ${cell.size.max}
        AND m.end_date IS NOT NULL AND m.resolution_ts IS NOT NULL
        AND t.ts >= ${ts_min}
        AND (EXTRACT(EPOCH FROM m.end_date) * 1000 - t.ts) / 3600000.0 BETWEEN ${cell.htr.min} AND ${cell.htr.max}
    )
    SELECT DISTINCT ON (condition_id) ts, price, resolution_ts, won, condition_id, outcome
    FROM eligible
    WHERE pre_vol_24h >= ${MIN_PRE_VOL_24H_USD}
    ORDER BY condition_id, ts ASC
  `;
  return rows.map((r) => ({
    ts: Number(r.ts), price: r.price, resolution_ts: Number(r.resolution_ts),
    won: r.won === 1 ? 1 : 0, condition_id: r.condition_id,
    outcome: (r.outcome === "YES" ? "YES" : "NO") as "YES" | "NO",
  })).sort((a, b) => a.ts - b.ts);
}

function walkForward(trades: CellTrade[], windowStart: number): number {
  let n = 0, w = 0;
  for (const t of trades) {
    if (t.ts >= windowStart) break;
    n++; w += t.won;
  }
  if (n < MIN_PRIOR_SAMPLES) return DEFAULT_PRIOR_WR;
  return w / n;
}

function runWin(cell: Cell, trades: CellTrade[], ws: number, days: number, lookup: PriceLookup): { ret: number; n: number } {
  const we = ws + days * MS_PER_DAY;
  const inW = trades.filter((t) => t.ts >= ws && t.ts < we);
  const priorWr = walkForward(trades, ws);
  const px = (cell.px_lo + cell.px_hi) / 2;
  const kellyFull = fullKelly(priorWr, px);
  const entries: Entry[] = inW.map((t) => ({
    agent_idx: 0,
    entry_time_h: (t.ts - ws) / 3600_000,
    entry_price: t.price,
    duration_h: Math.max(0.01, (t.resolution_ts - t.ts) / 3600_000),
    won: t.won, condition_id: t.condition_id, outcome: t.outcome, abs_entry_ts: t.ts,
  }));
  const agents: AgentConfig[] = [{ name: "cell", alloc_pct: 1.0, kelly_full: kellyFull, kelly_mult: 1.0, max_pct_per_trade: 0.25, max_concurrent: 10 }];
  const cfg: EngineConfig = { agents, starting_bankroll: STARTING_BANKROLL, days, killswitch_dd_pct: KILLSWITCH_DD_PCT, price_lookup: lookup, window_start_abs_ts: ws };
  const out = runWindow(entries, cfg);
  return { ret: (out.final_equity / STARTING_BANKROLL - 1) * 100, n: out.agent_entries[0] };
}

function summarize(r: Array<{ ret: number; n: number }>): { median: number; ppos: number } {
  if (r.length === 0) return { median: 0, ppos: 0 };
  const rets = r.map((x) => x.ret).sort((a, b) => a - b);
  const median = rets[Math.floor(rets.length / 2)];
  const ppos = rets.filter((v) => v > 0).length / rets.length;
  return { median, ppos };
}

(async () => {
  const tStart = Date.now();
  console.log(`[hunt-nightly] starting hunt at ${new Date(NOW_MS).toISOString()} · type=${HUNT_TYPE} · MIN_PRE_VOL_24H_USD=$${MIN_PRE_VOL_24H_USD}`);

  // Phase 1
  let evaluated = 0;
  const phase1: Phase1[] = [];
  for (const [px_lo, px_hi] of PRICE_BANDS) {
    for (const mom of MOM_BANDS) {
      for (const htr of HTR_BANDS) {
        for (const size of SIZE_BANDS) {
          const r = await phase1Cell({ px_lo, px_hi, mom, htr, size });
          if (r) phase1.push(r);
          evaluated++;
        }
      }
    }
  }
  phase1.sort((a, b) => b.rough_score - a.rough_score);
  console.log(`[hunt-nightly] phase1: ${phase1.length} passing of ${evaluated} cells`);

  // Phase 3 validation (skip Phase 2 / 3 if too few phase1 winners)
  const candidates = phase1.slice(0, TOP_N_FOR_VALIDATION);
  const window30: number[] = [];
  for (let t = OLDEST_MS; t + WINDOW_SHORT_DAYS * MS_PER_DAY <= NOW_MS; t += WINDOW_SHORT_STEP_DAYS * MS_PER_DAY) window30.push(t);
  const window90: number[] = [];
  for (let t = OLDEST_MS; t + WINDOW_LONG_DAYS * MS_PER_DAY <= NOW_MS; t += WINDOW_LONG_STEP_DAYS * MS_PER_DAY) window90.push(t);

  const winners: Array<Phase1 & { s30_old: ReturnType<typeof summarize>; s30_rec: ReturnType<typeof summarize>; s90_old: ReturnType<typeof summarize>; s90_rec: ReturnType<typeof summarize> }> = [];
  if (candidates.length > 0) {
    const allCids = new Set<string>();
    const cellTrades: CellTrade[][] = [];
    for (const c of candidates) {
      const tr = await loadCellTrades(c.cell);
      cellTrades.push(tr);
      for (const t of tr) allCids.add(t.condition_id);
    }
    const cache = await buildPriceCache(sql, Array.from(allCids));
    const lookup: PriceLookup = (cid, outc, ts) => lookupPriceAt(cache, cid, outc, ts);

    for (let ci = 0; ci < candidates.length; ci++) {
      const c = candidates[ci]; const tr = cellTrades[ci];
      const r30 = window30.map((ws) => runWin(c.cell, tr, ws, WINDOW_SHORT_DAYS, lookup));
      const r90 = window90.map((ws) => runWin(c.cell, tr, ws, WINDOW_LONG_DAYS, lookup));
      const r30Old = r30.filter((_, i) => window30[i] + WINDOW_SHORT_DAYS * MS_PER_DAY <= MIDPOINT_MS);
      const r30Rec = r30.filter((_, i) => window30[i] >= MIDPOINT_MS);
      const r90Old = r90.filter((_, i) => window90[i] + WINDOW_LONG_DAYS * MS_PER_DAY <= MIDPOINT_MS);
      const r90Rec = r90.filter((_, i) => window90[i] >= MIDPOINT_MS);
      const s30Old = summarize(r30Old), s30Rec = summarize(r30Rec);
      const s90Old = summarize(r90Old), s90Rec = summarize(r90Rec);
      const pass =
        s30Old.median > MIN_MEDIAN_RETURN_PCT && s30Old.ppos >= MIN_P_POSITIVE &&
        s30Rec.median > MIN_MEDIAN_RETURN_PCT && s30Rec.ppos >= MIN_P_POSITIVE &&
        s90Old.median > MIN_MEDIAN_RETURN_PCT && s90Old.ppos >= MIN_P_POSITIVE &&
        s90Rec.median > MIN_MEDIAN_RETURN_PCT && s90Rec.ppos >= MIN_P_POSITIVE;
      if (pass) winners.push({ ...c, s30_old: s30Old, s30_rec: s30Rec, s90_old: s90Old, s90_rec: s90Rec });
    }
  }

  // Compare to last run of the same hunt_type: are there new or fallen winners?
  // Filter by hunt_type so the thin-market run and the liquid run don't confuse
  // each other's inventories.
  const last = await sql<Array<{ result_json: { winners?: Array<{ key: string }> } }>>`
    SELECT result_json FROM strategy_hunt_runs WHERE hunt_type = ${HUNT_TYPE} ORDER BY ts DESC LIMIT 1
  `;
  const cellKey = (c: Cell) => `${c.px_lo.toFixed(2)}-${c.px_hi.toFixed(2)}/${c.mom.name}/${c.htr.name}/${c.size.name}`;
  const currentKeys = new Set(winners.map((w) => cellKey(w.cell)));
  const previousKeys = new Set((last[0]?.result_json?.winners ?? []).map((w) => w.key));
  const newWinners = Array.from(currentKeys).filter((k) => !previousKeys.has(k));
  const lostWinners = Array.from(previousKeys).filter((k) => !currentKeys.has(k));

  const resultJson = {
    generated_at: NOW_MS,
    n_evaluated: evaluated,
    n_phase1_pass: phase1.length,
    n_final_pass: winners.length,
    phase1_top: phase1.slice(0, 50).map((p) => ({
      key: cellKey(p.cell),
      px_lo: p.cell.px_lo, px_hi: p.cell.px_hi, mom: p.cell.mom.name, htr: p.cell.htr.name, size: p.cell.size.name,
      wr_older: p.wr_older, wr_recent: p.wr_recent, ev_older: p.ev_older, ev_recent: p.ev_recent, wr_delta: p.wr_delta,
    })),
    winners: winners.map((w) => ({
      key: cellKey(w.cell),
      px_lo: w.cell.px_lo, px_hi: w.cell.px_hi, mom: w.cell.mom.name, htr: w.cell.htr.name, size: w.cell.size.name,
      wr_older: w.wr_older, wr_recent: w.wr_recent,
      med_30d_old: w.s30_old.median, med_30d_rec: w.s30_rec.median,
      med_90d_old: w.s90_old.median, med_90d_rec: w.s90_rec.median,
      ppos_30d_old: w.s30_old.ppos, ppos_30d_rec: w.s30_rec.ppos,
      ppos_90d_old: w.s90_old.ppos, ppos_90d_rec: w.s90_rec.ppos,
    })),
    new_winners: newWinners,
    lost_winners: lostWinners,
    elapsed_ms: Date.now() - tStart,
  };

  await sql`
    INSERT INTO strategy_hunt_runs (ts, hunt_type, n_phase1_pass, n_final_pass, result_json, notes)
    VALUES (${NOW_MS}, ${HUNT_TYPE}, ${phase1.length}, ${winners.length}, ${sql.json(resultJson)},
            ${`new=${newWinners.length} lost=${lostWinners.length} min_pre_vol=$${MIN_PRE_VOL_24H_USD}`})
  `;

  console.log(`[hunt-nightly] final winners: ${winners.length} (new since last run: ${newWinners.length}, lost: ${lostWinners.length})`);

  // Notify if the inventory changed.
  if (newWinners.length > 0 || lostWinners.length > 0) {
    await notify(sql, {
      subject: `[polywork] ${HUNT_TYPE} inventory changed: +${newWinners.length} new, -${lostWinners.length} lost`,
      body: `Nightly ${HUNT_TYPE} hunt complete.\n` +
            (MIN_PRE_VOL_24H_USD > 0 ? `Liquidity filter: pre-trade 24h vol >= $${MIN_PRE_VOL_24H_USD}\n` : `Liquidity filter: none (thin-market scan)\n`) +
            `\nPhase1 passing: ${phase1.length}\nFinal winners: ${winners.length}\n\nNew winners: ${newWinners.join(", ") || "(none)"}\nLost winners: ${lostWinners.join(", ") || "(none)"}\n\nReview at /lab.\n`,
    });
  }

  await sql.end();
})().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
