// Comprehensive findings report. Pulls everything from the DB and renders
// a markdown report comparing polywork's findings against experiment1.md.
//
// Run: tsx scripts/report.ts > findings.md

import postgres from "postgres";
import * as dotenv from "dotenv";
import fs from "node:fs";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

(async () => {
  const lines: string[] = [];
  const p = (s: string): void => { lines.push(s); };

  const universe = (await sql<Array<{ markets: number; trades: number; first_ts: string; last_ts: string }>>`
    SELECT (SELECT COUNT(*)::int FROM markets) AS markets,
           (SELECT COUNT(*)::int FROM trades) AS trades,
           to_char((SELECT to_timestamp(MIN(ts)/1000.0) FROM trades), 'YYYY-MM') AS first_ts,
           to_char((SELECT to_timestamp(MAX(ts)/1000.0) FROM trades), 'YYYY-MM') AS last_ts
  `)[0];

  p("# polywork findings report");
  p("");
  p(`Generated: ${new Date().toISOString()}`);
  p("");
  p("## Universe");
  p("");
  p(`- **${universe.markets.toLocaleString()}** binary YES/NO markets`);
  p(`- **${universe.trades.toLocaleString()}** trades`);
  p(`- Time coverage: ${universe.first_ts} → ${universe.last_ts}`);
  p(`- Volume floor: $500k lifetime (top-volume markets only; Gamma offset=10k ceiling)`);
  p("");

  // Price band table
  p("## Finding 1: Win rate by price band (polywork vs experiment1)");
  p("");
  p("polywork has full market-life coverage (90-100% life span for every market) vs experiment1's last-3000-trades bias. Result: edges are MUCH smaller and the market is much closer to calibrated.");
  p("");
  p("| Price band | polywork trades | polywork actual WR | polywork edge | experiment1 edge | Δ |");
  p("|---|---:|---:|---:|---:|---:|");
  const expected: Record<string, number> = {
    "0.0": -0.9, "0.1": -10.0, "0.2": -13.6, "0.3": -17.6, "0.4": -14.7,
    "0.5": 4.6, "0.6": 14.2, "0.7": 5.2, "0.8": 9.6, "0.9": 0.6,
  };
  const bands = await sql<Array<{ band: number; trades: number; actual_wr: number; edge_pp: number }>>`
    WITH binned AS (
      SELECT FLOOR(t.price * 10) / 10.0 AS band, t.price,
             CASE WHEN m.resolved_outcome = t.outcome THEN 1 ELSE 0 END AS won
      FROM trades t JOIN markets m ON m.condition_id = t.condition_id
      WHERE t.side = 'BUY'
    )
    SELECT band::float8, COUNT(*)::int AS trades,
           (AVG(won::numeric) * 100)::float8 AS actual_wr,
           ((AVG(won::numeric) - AVG(price))::numeric * 100)::float8 AS edge_pp
    FROM binned GROUP BY band ORDER BY band
  `;
  for (const r of bands) {
    const k = r.band.toFixed(1);
    const exp = expected[k] ?? 0;
    const diff = r.edge_pp - exp;
    p(`| $${r.band.toFixed(2)}-$${(r.band + 0.099).toFixed(2)} | ${r.trades.toLocaleString()} | ${r.actual_wr.toFixed(1)}% | ${fmtPct(r.edge_pp)}pp | ${fmtPct(exp)}pp | ${fmtPct(diff)}pp |`);
  }
  p("");

  // Asymmetric payoff table
  p("## Finding 2: Per-band $10/trade P&L");
  p("");
  p("Bet $10 on every BUY in each band. Asymmetric P&L: at price p, win = $10 × (1-p)/p, loss = $10.");
  p("");
  p("| Band | Trades | WR | Capital In | Cash Out | Net P&L | ROI |");
  p("|---|---:|---:|---:|---:|---:|---:|");
  const pnl = await sql<Array<{ band: number; trades: number; win_pct: number; capital: number; cash_out: number; net_pnl: number; roi: number }>>`
    WITH binned AS (
      SELECT FLOOR(t.price * 10) / 10.0 AS band, t.price,
             CASE WHEN m.resolved_outcome = t.outcome THEN 1 ELSE 0 END AS won
      FROM trades t JOIN markets m ON m.condition_id = t.condition_id
      WHERE t.side = 'BUY'
    )
    SELECT band::float8, COUNT(*)::int AS trades,
           (AVG(won::numeric) * 100)::float8 AS win_pct,
           (COUNT(*) * 10.0)::float8 AS capital,
           SUM(CASE WHEN won=1 THEN 10.0/price ELSE 0 END)::float8 AS cash_out,
           (SUM(CASE WHEN won=1 THEN 10.0/price ELSE 0 END) - COUNT(*) * 10)::float8 AS net_pnl,
           ((SUM(CASE WHEN won=1 THEN 10.0/price ELSE 0 END) - COUNT(*) * 10) / (COUNT(*) * 10) * 100)::float8 AS roi
    FROM binned GROUP BY band ORDER BY band
  `;
  for (const r of pnl) {
    p(`| $${r.band.toFixed(2)}-$${(r.band + 0.099).toFixed(2)} | ${r.trades.toLocaleString()} | ${r.win_pct.toFixed(1)}% | -$${Math.round(r.capital).toLocaleString()} | +$${Math.round(r.cash_out).toLocaleString()} | ${r.net_pnl >= 0 ? "+" : "-"}$${Math.abs(Math.round(r.net_pnl)).toLocaleString()} | ${fmtPct(r.roi)} |`);
  }
  p("");

  // Top strategies
  const topStrats = await sql<Array<{ name: string; roi: number; trades: number; wr: number; dd: number; conc: number; mkts: number; sharpe: number; gen: number; gen_by: string }>>`
    SELECT s.name, b.roi_pct AS roi, b.trade_count AS trades, b.win_pct AS wr,
           b.max_drawdown_pct AS dd, b.top5_market_concentration AS conc,
           b.distinct_markets AS mkts, b.sharpe, s.generation AS gen, s.generated_by AS gen_by
    FROM strategies s JOIN backtest_runs b ON b.strategy_id = s.id
    ORDER BY b.roi_pct DESC LIMIT 20
  `;
  p("## Finding 3: Top 20 strategies (grid + genetic)");
  p("");
  if (topStrats.length === 0) {
    p("_No strategies tested yet._");
  } else {
    p("Friction model: 50bps spread + 50bps slippage = ~1% per round trip. $1k starting bankroll, $20 fixed stakes (grid) / Kelly-sized (evolve).");
    p("");
    p("| Strategy | Trades | WR | ROI | DD | Top5 Conc | Mkts | Sharpe | Gen | Gen By |");
    p("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");
    for (const r of topStrats) {
      p(`| ${r.name.slice(0, 60)} | ${r.trades.toLocaleString()} | ${r.wr.toFixed(1)}% | ${fmtPct(r.roi)} | ${r.dd.toFixed(0)}% | ${r.conc.toFixed(0)}% | ${r.mkts} | ${r.sharpe.toFixed(2)} | ${r.gen} | ${r.gen_by} |`);
    }
  }
  p("");

  // Headline conclusions
  p("## Headline conclusions");
  p("");
  p("**The polywork dataset is more honest than experiment1.** Full market-life coverage on 8.5M trades shows:");
  p("");
  const longshotEdges = bands.filter((b) => b.band < 0.5).reduce((s, b) => s + b.edge_pp * b.trades, 0) / bands.filter((b) => b.band < 0.5).reduce((s, b) => s + b.trades, 0);
  const favoriteEdges = bands.filter((b) => b.band >= 0.6 && b.band < 0.9).reduce((s, b) => s + b.edge_pp * b.trades, 0) / bands.filter((b) => b.band >= 0.6 && b.band < 0.9).reduce((s, b) => s + b.trades, 0);
  p(`1. **Longshot edge** ($0.00-$0.49): trade-weighted average edge = **${fmtPct(longshotEdges)}pp**. Negative but small — much closer to fair pricing than experiment1 suggested.`);
  p(`2. **Favorite edge** ($0.60-$0.89): trade-weighted average edge = **${fmtPct(favoriteEdges)}pp**. Positive but small.`);
  p("3. **After spread + slippage (1% per round-trip)**: most edges are eaten. Only the highest-WR strategies (near-resolution + heavy favorites) might survive.");
  p("4. **The strategies that show high ROI in the table above are concentrated on a few markets.** Look at the `Top5 Conc` column — anything ≥80% means the apparent edge came from 5 lucky markets, not a transferable pattern.");
  p("");

  const out = lines.join("\n");
  fs.writeFileSync("findings.md", out);
  console.log(out);
  console.log("\n\n[report] written to findings.md");
  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
