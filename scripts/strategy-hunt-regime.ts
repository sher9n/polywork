// Regime-aware strategy hunt. Searches across (price band) × (momentum band)
// × (hours-to-resolve band) cells, computing WR/EV separately on L30d and
// L90d slices, and keeps only cells where:
//
//   - L30d sample is large enough to trust (n >= 50)
//   - L90d sample is large enough to compare against (n >= 150)
//   - L30d WR clears a minimum threshold (>= 0.55)
//   - L30d WR is not collapsing vs L90d (L30 >= L90 - 5pp)
//   - Expected value at the cell's average price is positive
//
// Why this hunt instead of the long-history one: the existing strategies
// (mid_fav_day, mid_fav_flash, mid_lottery) were chosen on multi-year WR
// averages of ~95% / 96% / 38%, but their L30d WRs have collapsed to
// 74% / 52% / 0%. The L30+L90 stability filter is designed to reject that
// exact failure pattern. See conversation around 2026-05-17 for context.
//
// Run: tsx scripts/strategy-hunt-regime.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

// 5c-wide price bands from $0.05 to $0.95. Non-overlapping, so each trade
// falls in exactly one band.
const PRICE_BANDS: Array<[number, number]> = [];
for (let lo = 0.05; lo < 0.95; lo += 0.05) {
  PRICE_BANDS.push([Math.round(lo * 100) / 100, Math.round((lo + 0.05) * 100) / 100]);
}

// Momentum buckets on 24h price change. "Flat" matches the production strategy
// shape; "rising" / "falling" / "any" diversify across signals.
const MOM_BANDS: Array<{ name: string; min: number; max: number }> = [
  { name: "any",     min: -10,   max: 10 },
  { name: "falling", min: -10,   max: -0.02 },
  { name: "flat",    min: -0.02, max: 0.02 },
  { name: "rising",  min: 0.02,  max: 10 },
];

// Hours-to-resolve buckets. Live bot uses scheduled end_date; backtest uses
// actual resolution time. There's a known look-ahead bias here but we accept
// it for now since the goal is to surface regime-stable cells, not to
// produce a perfectly unbiased EV estimate.
const HTR_BANDS: Array<{ name: string; min: number; max: number }> = [
  { name: "<6h",    min: 0,   max: 6 },
  { name: "6-12h",  min: 6,   max: 12 },
  { name: "12-24h", min: 12,  max: 24 },
  { name: "24-72h", min: 24,  max: 72 },
  { name: "72h+",   min: 72,  max: 99999 },
];

// Cut-offs for what counts as a "viable" candidate. Tunable.
// IMPORTANT: these are PER-MARKET counts after de-dup, not raw trade counts.
// We expect ~10-100x fewer than the per-trade version of this hunt, so the
// thresholds are commensurately lower.
const MIN_N_L30 = 20;
const MIN_N_L90 = 60;
const MIN_WR_L30 = 0.55;
const MAX_REGRESSION_PP = 5;   // L30 WR must be within 5pp of L90 WR
const MS_PER_DAY = 86400 * 1000;

type CellResult = {
  px_lo: number; px_hi: number;
  mom_name: string; htr_name: string;
  // L30d
  n_l30: number; w_l30: number; wr_l30: number; avg_px_l30: number;
  // L90d
  n_l90: number; w_l90: number; wr_l90: number; avg_px_l90: number;
  // L365d
  n_l365: number; wr_l365: number; avg_px_l365: number;
  // EV across all three windows. Per $1 staked at the average price.
  ev_l30: number;
  ev_l90: number;
  ev_l365: number;
  trades_per_day_l30: number;
  score: number;
  passes: boolean;
  why_fail?: string;
};

function ev(wr: number, avgPrice: number): number {
  if (avgPrice <= 0 || avgPrice >= 1) return 0;
  // Buy-at-price-p, payoff is $1 if win else $0. Stake is $p per share.
  // Per $1 staked: shares = 1/p; expected proceeds = wr/p; expected PnL = wr/p - 1.
  return wr / avgPrice - 1;
}

async function evaluateCell(
  px_lo: number, px_hi: number,
  mom: typeof MOM_BANDS[number],
  htr: typeof HTR_BANDS[number],
  nowMs: number,
): Promise<CellResult> {
  const ts30 = nowMs - 30 * MS_PER_DAY;
  const ts90 = nowMs - 90 * MS_PER_DAY;
  const ts365 = nowMs - 365 * MS_PER_DAY;

  // Critical fix vs the previous version: we de-dup to one trade per market
  // (the first qualifying trade chronologically). Without this, a market with
  // 50 falling-momentum trades in a price band was counted as 50 separate
  // "opportunities" - but the bot can only enter ONCE per market+outcome,
  // both in backtest and in live. Inflating trade counts inflated trade-per-
  // day rates by 10-100x and biased WR toward markets with lots of qualifying
  // trades. Now we count one entry per market, matching engine behavior.
  const rows = await sql<Array<{
    n_l30: number; w_l30: number; avg_px_l30: number | null;
    n_l90: number; w_l90: number; avg_px_l90: number | null;
    n_l365: number; w_l365: number; avg_px_l365: number | null;
    earliest_ts: number | null;
  }>>`
    WITH first_per_market AS (
      SELECT DISTINCT ON (t.condition_id)
        t.ts, t.price, tf.won
      FROM trades t
      JOIN trade_features tf ON tf.trade_id = t.id
      WHERE t.side = 'BUY'
        AND t.price >= ${px_lo} AND t.price < ${px_hi}
        AND tf.mom_24h >= ${mom.min} AND tf.mom_24h <= ${mom.max}
        AND tf.hours_to_resolve >= ${htr.min} AND tf.hours_to_resolve <= ${htr.max}
        AND t.ts >= ${ts365}
      ORDER BY t.condition_id, t.ts ASC
    )
    SELECT
      (COUNT(*) FILTER (WHERE ts >= ${ts30}))::int                                 AS n_l30,
      (COUNT(*) FILTER (WHERE ts >= ${ts30} AND won = 1))::int                     AS w_l30,
      (AVG(price) FILTER (WHERE ts >= ${ts30}))::float8                            AS avg_px_l30,
      (COUNT(*) FILTER (WHERE ts >= ${ts90}))::int                                 AS n_l90,
      (COUNT(*) FILTER (WHERE ts >= ${ts90} AND won = 1))::int                     AS w_l90,
      (AVG(price) FILTER (WHERE ts >= ${ts90}))::float8                            AS avg_px_l90,
      COUNT(*)::int                                                                AS n_l365,
      (COUNT(*) FILTER (WHERE won = 1))::int                                       AS w_l365,
      AVG(price)::float8                                                           AS avg_px_l365,
      (MIN(ts) FILTER (WHERE ts >= ${ts30}))::bigint                               AS earliest_ts
    FROM first_per_market
  `;
  const r = rows[0];
  const wr_l30 = r.n_l30 > 0 ? r.w_l30 / r.n_l30 : 0;
  const wr_l90 = r.n_l90 > 0 ? r.w_l90 / r.n_l90 : 0;
  const wr_l365 = r.n_l365 > 0 ? r.w_l365 / r.n_l365 : 0;
  const avg_px_l30 = r.avg_px_l30 ?? 0;
  const avg_px_l90 = r.avg_px_l90 ?? 0;
  const avg_px_l365 = r.avg_px_l365 ?? 0;
  const ev_l30 = ev(wr_l30, avg_px_l30);
  const ev_l90 = ev(wr_l90, avg_px_l90);
  const ev_l365 = ev(wr_l365, avg_px_l365);
  // Use the actual span of L30 trades, not 30 days flat, so cells that only
  // had data for part of the window don't get an artificially low rate.
  const span_days = r.earliest_ts ? Math.max(1, (nowMs - Number(r.earliest_ts)) / MS_PER_DAY) : 30;
  const tpd = r.n_l30 / span_days;

  // Filter: a cell must have positive EV across ALL THREE windows (L30, L90,
  // L365) so we know the edge is durable, not just a recent statistical fluke.
  // This was the bug in the previous version - "stable high-WR" cells with
  // high prices had wr_l365 ~= price (break-even), so they had effectively 0
  // long-term edge despite passing the regime-stability filter.
  let passes = true;
  let why: string | undefined;
  if (r.n_l30 < MIN_N_L30) { passes = false; why = `n_l30=${r.n_l30}<${MIN_N_L30}`; }
  else if (r.n_l90 < MIN_N_L90) { passes = false; why = `n_l90=${r.n_l90}<${MIN_N_L90}`; }
  else if (wr_l30 < MIN_WR_L30) { passes = false; why = `wr_l30=${(wr_l30 * 100).toFixed(1)}%<${MIN_WR_L30 * 100}%`; }
  else if (wr_l30 < wr_l90 - MAX_REGRESSION_PP / 100) { passes = false; why = `regression=${((wr_l90 - wr_l30) * 100).toFixed(1)}pp>${MAX_REGRESSION_PP}pp`; }
  else if (ev_l30 <= 0) { passes = false; why = `ev_l30=${(ev_l30 * 100).toFixed(1)}%<=0`; }
  else if (ev_l90 <= 0) { passes = false; why = `ev_l90=${(ev_l90 * 100).toFixed(1)}%<=0 (no L90 edge)`; }
  else if (ev_l365 <= 0) { passes = false; why = `ev_l365=${(ev_l365 * 100).toFixed(1)}%<=0 (no durable edge)`; }

  // Score: weighted toward DURABLE EV. We use the MINIMUM EV across the three
  // windows as the conservative "this is the edge in all regimes" estimate,
  // multiplied by trade frequency. A cell with high L30 EV but break-even
  // L365 EV scores 0 - it's not a real edge.
  const minEv = Math.min(ev_l30, ev_l90, ev_l365);
  const score = minEv * tpd;

  return {
    px_lo, px_hi, mom_name: mom.name, htr_name: htr.name,
    n_l30: r.n_l30, w_l30: r.w_l30, wr_l30, avg_px_l30,
    n_l90: r.n_l90, w_l90: r.w_l90, wr_l90, avg_px_l90,
    n_l365: r.n_l365, wr_l365, avg_px_l365,
    ev_l30, ev_l90, ev_l365,
    trades_per_day_l30: tpd, score, passes, why_fail: why,
  };
}

function pad(s: string, n: number): string { return s.length >= n ? s : s + " ".repeat(n - s.length); }
function rpad(s: string, n: number): string { return s.length >= n ? s : " ".repeat(n - s.length) + s; }

(async () => {
  const nowMs = Date.now();
  const totalCells = PRICE_BANDS.length * MOM_BANDS.length * HTR_BANDS.length;
  console.log(`[hunt] regime-aware strategy hunt`);
  console.log(`[hunt] now=${new Date(nowMs).toISOString()}`);
  console.log(`[hunt] grid: ${PRICE_BANDS.length} price × ${MOM_BANDS.length} mom × ${HTR_BANDS.length} htr = ${totalCells} cells`);
  console.log(`[hunt] filters: n_l30>=${MIN_N_L30}, n_l90>=${MIN_N_L90}, wr_l30>=${MIN_WR_L30 * 100}%, |L30-L90|<=${MAX_REGRESSION_PP}pp, ev_l30>0, ev_l90>0, ev_l365>0 (durable edge across all windows)`);
  console.log("");

  const results: CellResult[] = [];
  for (const [px_lo, px_hi] of PRICE_BANDS) {
    for (const mom of MOM_BANDS) {
      for (const htr of HTR_BANDS) {
        const cr = await evaluateCell(px_lo, px_hi, mom, htr, nowMs);
        results.push(cr);
      }
    }
  }

  // Baseline: how do the live agents' cells look right now?
  console.log("BASELINE - current live agents on the same grid:");
  const liveAgents: Array<{ name: string; px_lo: number; px_hi: number; mom: typeof MOM_BANDS[number]; htr: typeof HTR_BANDS[number] }> = [
    { name: "mid_fav_day",   px_lo: 0.70, px_hi: 0.75, mom: { name: "flat", min: -0.02, max: 0.02 }, htr: { name: "12-24h", min: 12, max: 24 } },
    { name: "mid_fav_flash", px_lo: 0.70, px_hi: 0.75, mom: { name: "flat", min: -0.02, max: 0.02 }, htr: { name: "0.5-6h", min: 0.5, max: 6 } },
    { name: "mid_lottery",   px_lo: 0.20, px_hi: 0.25, mom: { name: "rising", min: 0.02, max: 10 },  htr: { name: "6-12h",  min: 6,   max: 12 } },
  ];
  console.log(`  ${pad("agent", 15)} ${pad("price", 12)} ${pad("mom", 8)} ${pad("htr", 8)} ${rpad("n_l30", 6)} ${rpad("wr_l30", 7)} ${rpad("n_l90", 7)} ${rpad("wr_l90", 7)} ${rpad("ev_l30", 8)} ${rpad("tpd", 6)}`);
  for (const a of liveAgents) {
    const cr = await evaluateCell(a.px_lo, a.px_hi, a.mom, a.htr, nowMs);
    console.log(`  ${pad(a.name, 15)} ${pad(`${a.px_lo.toFixed(2)}-${a.px_hi.toFixed(2)}`, 12)} ${pad(a.mom.name, 8)} ${pad(a.htr.name, 8)} ${rpad(cr.n_l30.toString(), 6)} ${rpad((cr.wr_l30 * 100).toFixed(1) + "%", 7)} ${rpad(cr.n_l90.toString(), 7)} ${rpad((cr.wr_l90 * 100).toFixed(1) + "%", 7)} ${rpad((cr.ev_l30 * 100).toFixed(1) + "%", 8)} ${rpad(cr.trades_per_day_l30.toFixed(2), 6)}`);
  }
  console.log("");

  const passing = results.filter((r) => r.passes).sort((a, b) => b.score - a.score);
  const failing = results.filter((r) => !r.passes);

  console.log(`[hunt] evaluated ${results.length} cells: ${passing.length} pass, ${failing.length} fail`);
  console.log("");
  console.log(`TOP CANDIDATES (sorted by score = MIN(ev_l30, ev_l90, ev_l365) × trades_per_day - rewards durable edges):`);
  console.log(`  ${pad("rank", 4)} ${pad("price", 12)} ${pad("mom", 8)} ${pad("htr", 8)} ${rpad("wr_l30", 8)} ${rpad("wr_l90", 8)} ${rpad("wr_l365", 8)} ${rpad("ev_l30", 8)} ${rpad("ev_l90", 8)} ${rpad("ev_l365", 8)} ${rpad("tpd", 6)} ${rpad("score", 8)}`);
  for (let i = 0; i < Math.min(30, passing.length); i++) {
    const r = passing[i];
    const n30 = `${r.n_l30}`, n90 = `${r.n_l90}`, n365 = `${r.n_l365}`;
    console.log(`  ${pad("#" + (i + 1), 4)} ${pad(`${r.px_lo.toFixed(2)}-${r.px_hi.toFixed(2)}`, 12)} ${pad(r.mom_name, 8)} ${pad(r.htr_name, 8)} ${rpad(`${(r.wr_l30 * 100).toFixed(0)}%/${n30}`, 8)} ${rpad(`${(r.wr_l90 * 100).toFixed(0)}%/${n90}`, 8)} ${rpad(`${(r.wr_l365 * 100).toFixed(0)}%/${n365}`, 8)} ${rpad((r.ev_l30 * 100).toFixed(1) + "%", 8)} ${rpad((r.ev_l90 * 100).toFixed(1) + "%", 8)} ${rpad((r.ev_l365 * 100).toFixed(1) + "%", 8)} ${rpad(r.trades_per_day_l30.toFixed(2), 6)} ${rpad(r.score.toFixed(3), 8)}`);
  }

  // Diversity-aware top picks: greedy selection that skips a cell if its
  // price band already has a higher-scoring representative. This keeps the
  // portfolio from being three near-identical strategies in the same price
  // band. Mom and htr can still differ - the price band is the strongest
  // grouping in practice.
  console.log("");
  console.log(`DIVERSITY-FILTERED TOP 5 (one cell per (price band)):`);
  const seenBands = new Set<string>();
  const picked: CellResult[] = [];
  for (const r of passing) {
    const bandKey = `${r.px_lo.toFixed(2)}-${r.px_hi.toFixed(2)}`;
    if (seenBands.has(bandKey)) continue;
    seenBands.add(bandKey);
    picked.push(r);
    if (picked.length >= 5) break;
  }
  for (let i = 0; i < picked.length; i++) {
    const r = picked[i];
    console.log(`  ${pad("#" + (i + 1), 4)} ${pad(`${r.px_lo.toFixed(2)}-${r.px_hi.toFixed(2)}`, 12)} mom=${r.mom_name} htr=${r.htr_name}  WR=[L30:${(r.wr_l30 * 100).toFixed(0)}% L90:${(r.wr_l90 * 100).toFixed(0)}% L365:${(r.wr_l365 * 100).toFixed(0)}%]  EV=[L30:${(r.ev_l30 * 100).toFixed(1)}% L90:${(r.ev_l90 * 100).toFixed(1)}% L365:${(r.ev_l365 * 100).toFixed(1)}%]  tpd=${r.trades_per_day_l30.toFixed(2)}  score=${r.score.toFixed(3)}`);
  }

  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
