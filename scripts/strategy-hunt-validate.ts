// Backtests the 5 strategies from the regime hunt + a combined top-3
// portfolio, each running as if it had been started at the same moment with
// $1000. Uses the exact same engine that drives /rolling, with the live
// killswitch threshold (25%). Reports full-period stats, per-quarter
// breakdowns, and side-by-side comparison vs the current live portfolio.
//
// IMPORTANT: the strategies were mined from data through 2026-05-17, so
// running them over the same window is partly in-sample. The honest test
// is whether they hold up in the OLDER quarters (Jan-Sep 2025) where the
// hunt couldn't peek.
//
// Run: tsx scripts/strategy-hunt-validate.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
import { runWindow, fullKelly, type Entry, type EngineConfig, type AgentConfig, type PriceLookup } from "../src/lib/backtest-engine";
import { buildPriceCache, lookupPriceAt } from "../src/lib/price-cache";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

const STARTING_BANKROLL = 1000;
// Run each scenario at multiple killswitch thresholds so we can see whether
// the 25% live threshold is what's killing portfolios or whether the
// strategies themselves are at fault.
const KILLSWITCH_THRESHOLDS = [25, 50, 9999];   // 9999 = effectively off
const WINDOW_START = new Date("2025-01-01T00:00:00Z").getTime();
const WINDOW_END = Date.now();
const WINDOW_DAYS = Math.floor((WINDOW_END - WINDOW_START) / 86400_000);

type StrategySpec = {
  name: string;
  price_min: number;
  price_max: number;
  mom_min: number;
  mom_max: number;
  htr_min: number;
  htr_max: number;
  wr_prior: number;
  max_pct_per_trade: number;
  max_concurrent: number;
  kelly_mult: number;
};

// Top 5 from the regime hunt (de-duplicated to one market per entry). WR
// prior uses L90 win rate. Per-market counts are MUCH smaller than the
// per-trade version implied - this is the more honest picture.
const TOP5: StrategySpec[] = [
  // #1: 0.50-0.55, any momentum, 24-72h. L30 81.0% (n=21) / L90 65.0% (n=60).
  { name: "midband_medium",       price_min: 0.50, price_max: 0.55, mom_min: -10,    mom_max: 10,    htr_min: 24, htr_max: 72,  wr_prior: 0.650, max_pct_per_trade: 0.15, max_concurrent: 10, kelly_mult: 1.0 },
  // #2: 0.55-0.60, rising momentum, <6h. L30 65.7% (n=35) / L90 59.2% (n=76).
  { name: "near_coin_rising_flash", price_min: 0.55, price_max: 0.60, mom_min: 0.02, mom_max: 10,    htr_min: 0,  htr_max: 6,   wr_prior: 0.592, max_pct_per_trade: 0.15, max_concurrent: 10, kelly_mult: 1.0 },
  // #3: 0.60-0.65, rising momentum, <6h. L30 66.7% (n=39) / L90 63.4% (n=82).
  { name: "low_fav_rising_flash", price_min: 0.60, price_max: 0.65, mom_min: 0.02,   mom_max: 10,    htr_min: 0,  htr_max: 6,   wr_prior: 0.634, max_pct_per_trade: 0.20, max_concurrent: 10, kelly_mult: 1.0 },
  // #4: 0.70-0.75, any momentum, 72h+. L30 81.8% (n=22) / L90 77.4% (n=84).
  { name: "mid_fav_longhold",     price_min: 0.70, price_max: 0.75, mom_min: -10,    mom_max: 10,    htr_min: 72, htr_max: 9999, wr_prior: 0.774, max_pct_per_trade: 0.25, max_concurrent: 10, kelly_mult: 1.0 },
  // #5: 0.80-0.85, any momentum, 72h+. L30 90.9% (n=22) / L90 88.2% (n=93).
  { name: "strong_fav_longhold",  price_min: 0.80, price_max: 0.85, mom_min: -10,    mom_max: 10,    htr_min: 72, htr_max: 9999, wr_prior: 0.882, max_pct_per_trade: 0.25, max_concurrent: 10, kelly_mult: 1.0 },
];

// The current live portfolio for comparison.
const CURRENT_LIVE: StrategySpec[] = [
  { name: "mid_fav_day",   price_min: 0.70, price_max: 0.75, mom_min: -0.02, mom_max: 0.02, htr_min: 12,  htr_max: 24, wr_prior: 0.947, max_pct_per_trade: 0.25, max_concurrent: 12, kelly_mult: 1.0 },
  { name: "mid_fav_flash", price_min: 0.70, price_max: 0.75, mom_min: -0.02, mom_max: 0.02, htr_min: 0.5, htr_max: 6,  wr_prior: 0.961, max_pct_per_trade: 0.25, max_concurrent: 10, kelly_mult: 1.0 },
  { name: "mid_lottery",   price_min: 0.20, price_max: 0.25, mom_min: 0.02,  mom_max: 10,   htr_min: 6,   htr_max: 12, wr_prior: 0.378, max_pct_per_trade: 0.10, max_concurrent: 8,  kelly_mult: 1.0 },
];

// Combined top-3 portfolio. Weighted toward the most regime-STABLE cells
// (smallest gap between L30 and L90 WR) rather than the highest absolute EV.
//   - strong_fav_longhold (#5): 91% L30 / 88% L90 - rock solid - 40%
//   - mid_fav_longhold    (#4): 82% L30 / 77% L90 - very stable     - 35%
//   - midband_medium      (#1): 81% L30 / 65% L90 - improving       - 25%
const COMBO_TOP3: Array<{ spec: StrategySpec; alloc_pct: number }> = [
  { spec: TOP5[4], alloc_pct: 0.40 },   // strong_fav_longhold
  { spec: TOP5[3], alloc_pct: 0.35 },   // mid_fav_longhold
  { spec: TOP5[0], alloc_pct: 0.25 },   // midband_medium
];

const CURRENT_PORTFOLIO: Array<{ spec: StrategySpec; alloc_pct: number }> = [
  { spec: CURRENT_LIVE[0], alloc_pct: 0.50 },   // mid_fav_day
  { spec: CURRENT_LIVE[1], alloc_pct: 0.30 },   // mid_fav_flash
  { spec: CURRENT_LIVE[2], alloc_pct: 0.20 },   // mid_lottery
];

// Load all trades from Jan 1, 2025 to now that could match ANY of the given
// strategies. We filter per-strategy in JS afterwards. One DB round-trip beats
// N round-trips.
async function loadAllCandidateTrades(specs: StrategySpec[]) {
  // Compute the price hull of all strategies (so the DB filter is the loosest
  // possible). Per-strategy mom/htr filtering happens in JS.
  const minPx = Math.min(...specs.map((s) => s.price_min));
  const maxPx = Math.max(...specs.map((s) => s.price_max));
  return await sql<Array<{
    ts: number; entry_price: number; duration_h: number; won: number;
    mom_24h: number | null;
    condition_id: string; outcome: string;
  }>>`
    SELECT
      t.ts::bigint AS ts,
      t.price::float8 AS entry_price,
      tf.hours_to_resolve::float8 AS duration_h,
      tf.won::int AS won,
      tf.mom_24h::float8 AS mom_24h,
      t.condition_id,
      t.outcome
    FROM trades t JOIN trade_features tf ON tf.trade_id = t.id
    WHERE t.side = 'BUY'
      AND t.price >= ${minPx} AND t.price <= ${maxPx}
      AND t.ts >= ${WINDOW_START} AND t.ts < ${WINDOW_END}
    ORDER BY t.ts ASC
  `;
}

// For each strategy in `specs`, build a deduped entry list (DISTINCT ON
// condition_id - take first qualifying trade per market, matching the backtest
// convention). Returns Entry[] tagged with agent_idx into specs[].
function buildEntriesForPortfolio(allTrades: Awaited<ReturnType<typeof loadAllCandidateTrades>>, specs: StrategySpec[]): Entry[] {
  const out: Entry[] = [];
  for (let si = 0; si < specs.length; si++) {
    const s = specs[si];
    const seen = new Set<string>();
    for (const r of allTrades) {
      if (seen.has(r.condition_id)) continue;
      if (r.entry_price < s.price_min || r.entry_price > s.price_max) continue;
      if (r.mom_24h === null) continue;
      if (r.mom_24h < s.mom_min || r.mom_24h > s.mom_max) continue;
      if (r.duration_h < s.htr_min || r.duration_h > s.htr_max) continue;
      seen.add(r.condition_id);
      out.push({
        agent_idx: si,
        entry_time_h: (Number(r.ts) - WINDOW_START) / 3600_000,
        entry_price: r.entry_price,
        duration_h: r.duration_h,
        won: r.won === 1 ? 1 : 0,
        condition_id: r.condition_id,
        outcome: (r.outcome === "YES" ? "YES" : "NO") as "YES" | "NO",
        abs_entry_ts: Number(r.ts),
      });
    }
  }
  out.sort((a, b) => a.entry_time_h - b.entry_time_h);
  return out;
}

type ScenarioResult = {
  label: string;
  strategies: Array<{ spec: StrategySpec; alloc_pct: number }>;
  entries: Entry[];
  final_equity: number;
  return_pct: number;
  killed: boolean;
  killed_day: number;
  max_drawdown_pct: number;
  agent_entries: number[];
  agent_wins: number[];
  agent_losses: number[];
  agent_pnl: number[];
  // Per-quarter aggregates
  by_quarter: Array<{ q: string; n_trades: number; n_wins: number; wr: number; pnl: number }>;
  trajectory: number[];
};

function quarterKey(absMs: number): string {
  const d = new Date(absMs);
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${y}Q${q}`;
}

async function runScenario(label: string, portfolio: Array<{ spec: StrategySpec; alloc_pct: number }>, allTrades: Awaited<ReturnType<typeof loadAllCandidateTrades>>, priceLookup: PriceLookup, killswitchDdPct: number): Promise<ScenarioResult> {
  const specs = portfolio.map((p) => p.spec);
  const allocs = portfolio.map((p) => p.alloc_pct);
  const entries = buildEntriesForPortfolio(allTrades, specs);

  const agents: AgentConfig[] = portfolio.map((p, _i) => ({
    name: p.spec.name,
    alloc_pct: p.alloc_pct,
    kelly_full: fullKelly(p.spec.wr_prior, (p.spec.price_min + p.spec.price_max) / 2),
    kelly_mult: p.spec.kelly_mult,
    max_pct_per_trade: p.spec.max_pct_per_trade,
    max_concurrent: p.spec.max_concurrent,
  }));

  const cfg: EngineConfig = {
    agents,
    starting_bankroll: STARTING_BANKROLL,
    days: WINDOW_DAYS,
    killswitch_dd_pct: killswitchDdPct,
    price_lookup: priceLookup,
    window_start_abs_ts: WINDOW_START,
  };
  const out = runWindow(entries, cfg);

  // Compute max drawdown from trajectory.
  let peak = STARTING_BANKROLL, maxDd = 0;
  for (const v of out.trajectory) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak * 100;
    if (dd > maxDd) maxDd = dd;
  }

  // Per-quarter breakdown. We use the per-trade outcome (won) and a rough
  // per-trade P&L estimate: stake = alloc_pct * starting * cappedKelly, payoff
  // = stake/price if won else 0. This is a simplification - it ignores
  // sequential bankroll compounding within a quarter - but it gives a useful
  // directional read on which periods carried the strategy.
  const quarterly = new Map<string, { n: number; w: number; pnl: number }>();
  for (const e of entries) {
    const abs = (e.abs_entry_ts ?? (WINDOW_START + e.entry_time_h * 3600_000));
    const q = quarterKey(abs);
    const cur = quarterly.get(q) ?? { n: 0, w: 0, pnl: 0 };
    cur.n++;
    cur.w += e.won;
    // Estimate P&L per trade: stake = alloc * starting * capped_kelly. Use the
    // unit-stake estimate so quarters are comparable as if equally sized.
    const spec = specs[e.agent_idx];
    const kelly = Math.min(fullKelly(spec.wr_prior, e.entry_price) * spec.kelly_mult, spec.max_pct_per_trade);
    const stake = STARTING_BANKROLL * allocs[e.agent_idx] * kelly;
    const pnl = e.won ? stake * (1 / e.entry_price - 1) : -stake;
    cur.pnl += pnl;
    quarterly.set(q, cur);
  }
  const by_quarter = Array.from(quarterly.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([q, v]) => ({
    q, n_trades: v.n, n_wins: v.w, wr: v.n > 0 ? v.w / v.n : 0, pnl: v.pnl,
  }));

  return {
    label,
    strategies: portfolio,
    entries,
    final_equity: out.final_equity,
    return_pct: (out.final_equity / STARTING_BANKROLL - 1) * 100,
    killed: out.killed,
    killed_day: out.killed_day,
    max_drawdown_pct: maxDd,
    agent_entries: out.agent_entries,
    agent_wins: out.agent_wins,
    agent_losses: out.agent_losses,
    agent_pnl: out.agent_pnl,
    by_quarter,
    trajectory: out.trajectory,
  };
}

function fmtPct(v: number, d = 1): string { return (v >= 0 ? "+" : "") + v.toFixed(d) + "%"; }
function fmt$(v: number): string { return (v >= 0 ? "+$" : "-$") + Math.abs(v).toFixed(0); }
function pad(s: string, n: number): string { return s.length >= n ? s : s + " ".repeat(n - s.length); }
function rpad(s: string, n: number): string { return s.length >= n ? s : " ".repeat(n - s.length) + s; }

(async () => {
  console.log(`[validate] running ${TOP5.length} individual strategies + 2 portfolios from ${new Date(WINDOW_START).toISOString().slice(0, 10)} to ${new Date(WINDOW_END).toISOString().slice(0, 10)} (${WINDOW_DAYS} days)`);
  console.log(`[validate] starting bankroll $${STARTING_BANKROLL}, killswitch sweep: ${KILLSWITCH_THRESHOLDS.map((k) => k === 9999 ? "off" : k + "%").join(", ")}`);
  console.log("");

  // Combined strategy set covers all unique specs we want to evaluate.
  const allSpecs = [...TOP5, ...CURRENT_LIVE];
  console.log(`[validate] loading trades from DB...`);
  const t0 = Date.now();
  const allTrades = await loadAllCandidateTrades(allSpecs);
  console.log(`[validate]   ${allTrades.length} candidate trades loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const uniqueCids = Array.from(new Set(allTrades.map((r) => r.condition_id)));
  console.log(`[validate] building price cache for ${uniqueCids.length} markets...`);
  const t1 = Date.now();
  const priceCache = await buildPriceCache(sql, uniqueCids);
  console.log(`[validate]   cache built in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  const priceLookup: PriceLookup = (cid, outc, ts) => lookupPriceAt(priceCache, cid, outc, ts);
  console.log("");

  // PART 1: each top-5 strategy alone at 100% allocation, killswitch at 25%.
  // We use the live threshold here to see whether the strategy survives at all
  // - portfolio-level threshold sweep comes in PART 2.
  console.log("=".repeat(130));
  console.log(`PART 1: Each top-5 strategy run STANDALONE at 100% of $${STARTING_BANKROLL} (live killswitch 25%)`);
  console.log("=".repeat(130));

  const standaloneResults: ScenarioResult[] = [];
  for (const s of TOP5) {
    const res = await runScenario(s.name, [{ spec: s, alloc_pct: 1.0 }], allTrades, priceLookup, 25);
    standaloneResults.push(res);
  }
  console.log("");
  console.log(`  ${pad("strategy", 26)} ${rpad("trades", 7)} ${rpad("wins", 5)} ${rpad("WR", 7)} ${rpad("final", 9)} ${rpad("return", 9)} ${rpad("maxDD", 7)} ${rpad("killed?", 8)}`);
  for (const r of standaloneResults) {
    const wr = r.agent_entries[0] > 0 ? (r.agent_wins[0] / r.agent_entries[0]) * 100 : 0;
    const killedStr = r.killed ? `day ${r.killed_day}` : "no";
    console.log(`  ${pad(r.label, 26)} ${rpad(r.agent_entries[0].toString(), 7)} ${rpad(r.agent_wins[0].toString(), 5)} ${rpad(wr.toFixed(1) + "%", 7)} ${rpad("$" + r.final_equity.toFixed(0), 9)} ${rpad(fmtPct(r.return_pct, 1), 9)} ${rpad(r.max_drawdown_pct.toFixed(1) + "%", 7)} ${rpad(killedStr, 8)}`);
  }
  console.log("");

  // Per-quarter breakdown for each standalone strategy.
  console.log("Per-quarter trade-count and WR (helps detect in-sample vs out-of-sample drift):");
  const allQuarters = Array.from(new Set(standaloneResults.flatMap((r) => r.by_quarter.map((q) => q.q)))).sort();
  console.log(`  ${pad("strategy", 26)} ${allQuarters.map((q) => rpad(q, 10)).join(" ")}`);
  for (const r of standaloneResults) {
    const qByKey = new Map(r.by_quarter.map((q) => [q.q, q]));
    const cells = allQuarters.map((q) => {
      const v = qByKey.get(q);
      if (!v || v.n_trades === 0) return rpad("-", 10);
      return rpad(`${v.n_trades}@${(v.wr * 100).toFixed(0)}%`, 10);
    });
    console.log(`  ${pad(r.label, 26)} ${cells.join(" ")}`);
  }
  console.log("");

  // PART 2: portfolio comparison across killswitch thresholds.
  console.log("=".repeat(130));
  console.log(`PART 2: Portfolios (current live vs new top-3 combo) at each killswitch threshold`);
  console.log("=".repeat(130));

  type PortfolioSpec = { name: string; portfolio: Array<{ spec: StrategySpec; alloc_pct: number }> };
  const portfoliosToTest: PortfolioSpec[] = [
    { name: "CURRENT live (mid_fav_day 50%, mid_fav_flash 30%, mid_lottery 20%)", portfolio: CURRENT_PORTFOLIO },
    { name: "NEW top-3 (strong_fav_longhold 40%, mid_fav_longhold 35%, midband_medium 25%)", portfolio: COMBO_TOP3 },
  ];

  for (const p of portfoliosToTest) {
    console.log("");
    console.log(`> ${p.name}`);
    console.log(`  ${pad("killswitch", 12)} ${rpad("final$", 9)} ${rpad("return", 9)} ${rpad("maxDD", 7)} ${rpad("killed?", 10)} ${rpad("total_trades", 13)} ${rpad("portfolio_WR", 13)}`);
    for (const ks of KILLSWITCH_THRESHOLDS) {
      const res = await runScenario(`${p.name} @ ks=${ks}%`, p.portfolio, allTrades, priceLookup, ks);
      const ksLabel = ks === 9999 ? "off" : `${ks}%`;
      const totalEntries = res.agent_entries.reduce((s, v) => s + v, 0);
      const totalWins = res.agent_wins.reduce((s, v) => s + v, 0);
      const portfolioWr = totalEntries > 0 ? (totalWins / totalEntries) * 100 : 0;
      const killedStr = res.killed ? `day ${res.killed_day}` : "no";
      console.log(`  ${pad(ksLabel, 12)} ${rpad("$" + res.final_equity.toFixed(0), 9)} ${rpad(fmtPct(res.return_pct), 9)} ${rpad(res.max_drawdown_pct.toFixed(1) + "%", 7)} ${rpad(killedStr, 10)} ${rpad(totalEntries.toString(), 13)} ${rpad(portfolioWr.toFixed(1) + "%", 13)}`);
    }
  }
  console.log("");

  // PART 3: per-quarter breakdown for the two portfolios at killswitch=off.
  // The "off" case is most informative because it shows what the strategies
  // would have done if not artificially killed - separating signal quality
  // from drawdown protection.
  console.log("=".repeat(130));
  console.log(`PART 3: Per-quarter detail @ killswitch=OFF (so we see strategy signal without the brake)`);
  console.log("=".repeat(130));

  const portQuarters: string[] = [];
  const detailRows: Array<{ portfolioName: string; res: ScenarioResult }> = [];
  for (const p of portfoliosToTest) {
    const res = await runScenario(p.name + " @ ks=off", p.portfolio, allTrades, priceLookup, 9999);
    detailRows.push({ portfolioName: p.name, res });
    for (const q of res.by_quarter) if (!portQuarters.includes(q.q)) portQuarters.push(q.q);
  }
  portQuarters.sort();
  console.log("");
  console.log(`  ${pad("portfolio", 16)} ${portQuarters.map((q) => rpad(q, 13)).join(" ")}`);
  for (const dr of detailRows) {
    const qByKey = new Map(dr.res.by_quarter.map((q) => [q.q, q]));
    const cells = portQuarters.map((q) => {
      const v = qByKey.get(q);
      if (!v || v.n_trades === 0) return rpad("-", 13);
      return rpad(`${v.n_trades}@${(v.wr * 100).toFixed(0)}% ${fmt$(v.pnl)}`, 13);
    });
    const shortLabel = dr.portfolioName.startsWith("CURRENT") ? "CURRENT live" : "NEW top-3";
    console.log(`  ${pad(shortLabel, 16)} ${cells.join(" ")}`);
  }
  console.log("");

  console.log("=".repeat(130));
  console.log("HONESTY CALLOUT");
  console.log("=".repeat(130));
  console.log(`The new strategies were chosen by the hunt looking at trades through ${new Date(WINDOW_END).toISOString().slice(0, 10)}.`);
  console.log("All 16 months are partly in-sample. The honest read is the EARLY quarters (2025Q1-Q3),");
  console.log("which the hunt could not peek at. If a strategy bombed in 2025Q1 but shines in 2026Q1, that's a flag.");
  console.log("Also: per-quarter PnL is an unit-stake estimate, NOT the engine's actual sequential compounding.");
  console.log("It shows directional contribution, not exact dollars.");

  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
