// Strategy hunt v3: adds trade-size dimension + Kelly-growth ranking.
//
// Two improvements over strategy-hunt-regime.ts:
//
// 1. NEW DIMENSION: trade-size tier at entry. The hypothesis is that the
//    size of the trade triggering a buy carries information about who's
//    on the other side. Small trades ($1-$25) likely come from retail
//    noise traders; large trades ($200+) often come from sharp money.
//    Whether following a sharp trade is positive or negative EV is an
//    empirical question - the hunt will tell us per cell.
//
// 2. KELLY-AWARE RANKING: instead of ev_per_dollar × frequency, we rank
//    by expected log-growth per trade with Kelly sizing × trades_per_day.
//    This captures the right compounding behavior: a small per-dollar EV
//    on a cell with the right WR/price ratio can compound to enormous
//    annual returns under Kelly, while a high per-dollar EV with a tiny
//    Kelly fraction barely moves the needle.
//
// Filter still requires durable edge: positive EV at L30, L90, AND L365.
//
// Run: tsx scripts/strategy-hunt-kelly.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

const PRICE_BANDS: Array<[number, number]> = [];
for (let lo = 0.05; lo < 0.95; lo += 0.05) {
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
  { name: "6-12h",  min: 6,   max: 12 },
  { name: "12-24h", min: 12,  max: 24 },
  { name: "24-72h", min: 24,  max: 72 },
  { name: "72h+",   min: 72,  max: 99999 },
];

// Trade size tier at entry. Cutoffs at ~p33 and ~p75 of last-year BUY-side
// trade size distribution: p25=$9, p50=$30, p75=$125, p90=$530. Three tiers
// keeps the grid manageable (1080 cells total).
const SIZE_BANDS: Array<{ name: string; min: number; max: number }> = [
  { name: "any",   min: 0,    max: 9e12 },
  { name: "small", min: 0,    max: 25 },
  { name: "med",   min: 25,   max: 200 },
  { name: "large", min: 200,  max: 9e12 },
];

const MIN_N_L30 = 20;
const MIN_N_L90 = 60;
const MIN_WR_L30 = 0.55;
const MAX_REGRESSION_PP = 5;
const KELLY_CAP = 0.25;          // matches live max_pct_per_trade
const MS_PER_DAY = 86400 * 1000;

type CellResult = {
  px_lo: number; px_hi: number;
  mom_name: string; htr_name: string; size_name: string;
  n_l30: number; w_l30: number; wr_l30: number; avg_px_l30: number;
  n_l90: number; w_l90: number; wr_l90: number; avg_px_l90: number;
  n_l365: number; wr_l365: number; avg_px_l365: number;
  ev_l30: number; ev_l90: number; ev_l365: number;
  kelly_f: number;                 // capped Kelly fraction at L365 WR/price
  log_growth_per_trade: number;    // expected log-growth using capped Kelly at L365 stats
  annual_log_growth: number;       // log_growth × tpd × 365
  trades_per_day_l30: number;
  score: number;
  passes: boolean;
  why_fail?: string;
};

function ev(wr: number, avgPrice: number): number {
  if (avgPrice <= 0 || avgPrice >= 1) return 0;
  return wr / avgPrice - 1;
}

// Optimal Kelly fraction for a binary YES/NO contract at given WR and price.
// Cap at KELLY_CAP to match live behavior (max_pct_per_trade=0.25).
function kellyFraction(wr: number, price: number): number {
  if (price <= 0 || price >= 1) return 0;
  // f* = WR - (1-WR) × price/(1-price). Clip to [0, KELLY_CAP].
  const fStar = wr - (1 - wr) * price / (1 - price);
  return Math.max(0, Math.min(KELLY_CAP, fStar));
}

// Expected log-growth per trade with the given Kelly fraction.
//   Win:  bankroll grows by (1 - f + f/price)
//   Loss: bankroll shrinks to (1 - f)
function expectedLogGrowth(wr: number, price: number, f: number): number {
  if (f <= 0 || price <= 0 || price >= 1) return 0;
  const winMult = 1 - f + f / price;
  const lossMult = 1 - f;
  if (winMult <= 0 || lossMult <= 0) return -Infinity;
  return wr * Math.log(winMult) + (1 - wr) * Math.log(lossMult);
}

async function evaluateCell(
  px_lo: number, px_hi: number,
  mom: typeof MOM_BANDS[number],
  htr: typeof HTR_BANDS[number],
  size: typeof SIZE_BANDS[number],
  nowMs: number,
): Promise<CellResult> {
  const ts30 = nowMs - 30 * MS_PER_DAY;
  const ts90 = nowMs - 90 * MS_PER_DAY;
  const ts365 = nowMs - 365 * MS_PER_DAY;

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
        AND t.size >= ${size.min} AND t.size < ${size.max}
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

  // Kelly sizing uses L365 WR/price (the most stable estimate). Growth
  // expectation is also computed from L365 (durable estimate, not recent
  // noise).
  const kelly_f = kellyFraction(wr_l365, avg_px_l365);
  const log_growth_per_trade = expectedLogGrowth(wr_l365, avg_px_l365, kelly_f);
  const span_days = r.earliest_ts ? Math.max(1, (nowMs - Number(r.earliest_ts)) / MS_PER_DAY) : 30;
  const tpd = r.n_l30 / span_days;
  const annual_log_growth = log_growth_per_trade * tpd * 365;

  let passes = true;
  let why: string | undefined;
  if (r.n_l30 < MIN_N_L30) { passes = false; why = `n_l30=${r.n_l30}<${MIN_N_L30}`; }
  else if (r.n_l90 < MIN_N_L90) { passes = false; why = `n_l90=${r.n_l90}<${MIN_N_L90}`; }
  else if (wr_l30 < MIN_WR_L30) { passes = false; why = `wr_l30=${(wr_l30 * 100).toFixed(1)}%<${MIN_WR_L30 * 100}%`; }
  else if (wr_l30 < wr_l90 - MAX_REGRESSION_PP / 100) { passes = false; why = `regression=${((wr_l90 - wr_l30) * 100).toFixed(1)}pp>${MAX_REGRESSION_PP}pp`; }
  else if (ev_l30 <= 0) { passes = false; why = `ev_l30=${(ev_l30 * 100).toFixed(1)}%<=0`; }
  else if (ev_l90 <= 0) { passes = false; why = `ev_l90=${(ev_l90 * 100).toFixed(1)}%<=0`; }
  else if (ev_l365 <= 0) { passes = false; why = `ev_l365=${(ev_l365 * 100).toFixed(1)}%<=0`; }
  else if (kelly_f <= 0) { passes = false; why = `kelly_f<=0 (no edge under sizing)`; }
  else if (log_growth_per_trade <= 0) { passes = false; why = `log_growth<=0`; }

  // Score is expected annual log-growth, which is what we actually care about
  // for compounding. A 1% per-trade log-growth × 1 tpd × 365 = 3.65 log-units,
  // i.e. e^3.65 ≈ 38x annual growth (theoretical max under independence).
  const score = annual_log_growth;

  return {
    px_lo, px_hi, mom_name: mom.name, htr_name: htr.name, size_name: size.name,
    n_l30: r.n_l30, w_l30: r.w_l30, wr_l30, avg_px_l30,
    n_l90: r.n_l90, w_l90: r.w_l90, wr_l90, avg_px_l90,
    n_l365: r.n_l365, wr_l365, avg_px_l365,
    ev_l30, ev_l90, ev_l365,
    kelly_f, log_growth_per_trade, annual_log_growth,
    trades_per_day_l30: tpd, score, passes, why_fail: why,
  };
}

function pad(s: string, n: number): string { return s.length >= n ? s : s + " ".repeat(n - s.length); }
function rpad(s: string, n: number): string { return s.length >= n ? s : " ".repeat(n - s.length) + s; }

(async () => {
  const nowMs = Date.now();
  const totalCells = PRICE_BANDS.length * MOM_BANDS.length * HTR_BANDS.length * SIZE_BANDS.length;
  console.log(`[hunt-kelly] 4D grid: ${PRICE_BANDS.length} price × ${MOM_BANDS.length} mom × ${HTR_BANDS.length} htr × ${SIZE_BANDS.length} size = ${totalCells} cells`);
  console.log(`[hunt-kelly] filters: n_l30>=${MIN_N_L30}, n_l90>=${MIN_N_L90}, wr_l30>=${MIN_WR_L30 * 100}%, |L30-L90|<=${MAX_REGRESSION_PP}pp, EV>0 at L30/L90/L365, Kelly_f>0, log_growth>0`);
  console.log(`[hunt-kelly] score = annual log-growth at L365 stats under capped Kelly (cap=${KELLY_CAP * 100}%)`);
  console.log("");

  const results: CellResult[] = [];
  let evaluated = 0;
  for (const [px_lo, px_hi] of PRICE_BANDS) {
    for (const mom of MOM_BANDS) {
      for (const htr of HTR_BANDS) {
        for (const size of SIZE_BANDS) {
          const cr = await evaluateCell(px_lo, px_hi, mom, htr, size, nowMs);
          results.push(cr);
          evaluated++;
          if (evaluated % 100 === 0) console.log(`  [hunt-kelly] evaluated ${evaluated}/${totalCells} cells`);
        }
      }
    }
  }

  const passing = results.filter((r) => r.passes).sort((a, b) => b.score - a.score);
  console.log(`\n[hunt-kelly] evaluated ${results.length} cells: ${passing.length} pass, ${results.length - passing.length} fail`);
  console.log("");

  console.log(`TOP CANDIDATES (sorted by expected annual log-growth at L365 stats):`);
  console.log(`  ${pad("rank", 4)} ${pad("price", 11)} ${pad("mom", 8)} ${pad("htr", 8)} ${pad("size", 7)} ${rpad("wr_l30/n", 10)} ${rpad("wr_l90/n", 10)} ${rpad("wr_365/n", 10)} ${rpad("ev_l365", 8)} ${rpad("kelly_f", 8)} ${rpad("tpd", 6)} ${rpad("annlog", 7)} ${rpad("eAnn", 8)}`);
  for (let i = 0; i < Math.min(30, passing.length); i++) {
    const r = passing[i];
    const eAnnual = Math.exp(r.annual_log_growth);
    console.log(`  ${pad("#" + (i + 1), 4)} ${pad(`${r.px_lo.toFixed(2)}-${r.px_hi.toFixed(2)}`, 11)} ${pad(r.mom_name, 8)} ${pad(r.htr_name, 8)} ${pad(r.size_name, 7)} ${rpad(`${(r.wr_l30 * 100).toFixed(0)}%/${r.n_l30}`, 10)} ${rpad(`${(r.wr_l90 * 100).toFixed(0)}%/${r.n_l90}`, 10)} ${rpad(`${(r.wr_l365 * 100).toFixed(0)}%/${r.n_l365}`, 10)} ${rpad((r.ev_l365 * 100).toFixed(1) + "%", 8)} ${rpad((r.kelly_f * 100).toFixed(1) + "%", 8)} ${rpad(r.trades_per_day_l30.toFixed(2), 6)} ${rpad(r.annual_log_growth.toFixed(2), 7)} ${rpad(eAnnual >= 10 ? eAnnual.toFixed(1) + "x" : (eAnnual * 100).toFixed(0) + "%", 8)}`);
  }
  console.log("");

  // Diversity dedup: keep one cell per (price band, mom, htr) since size is
  // an additional refinement. So a price/mom/htr combo can only contribute
  // once to the diversity list. This way if "any size" passes AND "large only"
  // passes for the same price/mom/htr, we keep the better of the two.
  console.log(`DIVERSITY-FILTERED TOP 5 (one cell per (price band, mom, htr) - size tier may differ):`);
  const seenKey = new Set<string>();
  const picked: CellResult[] = [];
  for (const r of passing) {
    const key = `${r.px_lo.toFixed(2)}|${r.mom_name}|${r.htr_name}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    picked.push(r);
    if (picked.length >= 5) break;
  }
  for (let i = 0; i < picked.length; i++) {
    const r = picked[i];
    const eAnnual = Math.exp(r.annual_log_growth);
    console.log(`  ${pad("#" + (i + 1), 4)} ${pad(`${r.px_lo.toFixed(2)}-${r.px_hi.toFixed(2)}`, 11)} mom=${r.mom_name} htr=${r.htr_name} size=${r.size_name}  WR[L30:${(r.wr_l30 * 100).toFixed(0)}% L90:${(r.wr_l90 * 100).toFixed(0)}% L365:${(r.wr_l365 * 100).toFixed(0)}%]  EV_L365=${(r.ev_l365 * 100).toFixed(1)}%  Kelly=${(r.kelly_f * 100).toFixed(1)}%  tpd=${r.trades_per_day_l30.toFixed(2)}  E[annual growth]=${eAnnual >= 10 ? eAnnual.toFixed(1) + "x" : ((eAnnual - 1) * 100).toFixed(0) + "%"}`);
  }

  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
