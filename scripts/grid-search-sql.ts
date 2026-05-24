// SQL-based grid search: aggregate per-band/time/momentum slices directly in
// Postgres. ~120 strategies in seconds instead of hours. Persists results
// into backtest_runs.
//
// Run: tsx scripts/grid-search-sql.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");
const STARTING_BANKROLL = 1000;
const STAKE = 20;
// Friction: 50bps spread + 50bps slippage = 100bps round-trip on entry.
const FRICTION_MULT = 1.01;

const PRICE_BANDS: Array<[number, number]> = [
  [0.10, 0.20], [0.20, 0.30], [0.30, 0.40], [0.40, 0.50],
  [0.50, 0.60], [0.60, 0.70], [0.70, 0.80], [0.80, 0.90],
];
const TIME_BANDS: Array<{ name: string; min: number; max: number }> = [
  { name: "any",   min: 0,    max: 99999 },
  { name: "<24h",  min: 0,    max: 24 },
  { name: "1-7d",  min: 24,   max: 168 },
  { name: "7-28d", min: 168,  max: 672 },
];
const MOM_FILTERS: Array<{ name: string; clause: string }> = [
  { name: "any",        clause: "1=1" },
  { name: "mom24h_pos", clause: "f.mom_24h > 0.02" },
  { name: "mom24h_neg", clause: "f.mom_24h < -0.02" },
];

type StratResult = {
  name: string;
  trades: number;
  wins: number;
  avg_price: number;
  win_pct: number;
  capital_deployed: number;
  cash_returned: number;
  net_pnl: number;
  roi_pct: number;
  distinct_markets: number;
  top5_concentration: number;
};

async function runStrategy(p_min: number, p_max: number, tb: typeof TIME_BANDS[number], mf: typeof MOM_FILTERS[number]): Promise<StratResult> {
  const name = `price[${p_min.toFixed(2)}-${p_max.toFixed(2)}] time[${tb.name}] mom[${mf.name}]`;
  // Stake $20 at entry × friction → effective shares = $20*(1-fee)/(price*friction)
  // Win: +1 per share. Loss: 0 per share. Net per trade = shares*won - 20.
  // We compute per-market net PnL for concentration.
  const rows = await sql<Array<{ trades: number; wins: number; avg_price: number; capital: number; cash_back: number; net_pnl: number; markets: number; top5_pos: number }>>`
    WITH ranked AS (
      SELECT
        t.condition_id,
        ${STAKE}::float8 AS stake,
        CASE WHEN m.resolved_outcome = t.outcome THEN 1 ELSE 0 END AS won,
        t.price * ${FRICTION_MULT}::float8 AS eff_price,
        CASE WHEN m.resolved_outcome = t.outcome THEN ${STAKE} * (1.0 / (t.price * ${FRICTION_MULT})) ELSE 0 END AS cash_back,
        CASE WHEN m.resolved_outcome = t.outcome THEN ${STAKE} * (1.0 / (t.price * ${FRICTION_MULT})) - ${STAKE} ELSE -${STAKE}::float8 END AS pnl
      FROM trades t
      JOIN trade_features f ON f.trade_id = t.id
      JOIN markets m ON m.condition_id = t.condition_id
      WHERE t.side = 'BUY'
        AND m.resolved_outcome IN ('YES','NO')
        AND t.price >= ${p_min} AND t.price <= ${p_max}
        AND f.hours_to_resolve >= ${tb.min} AND f.hours_to_resolve <= ${tb.max}
        AND ${sql.unsafe(mf.clause)}
        AND t.price > 0 AND t.price < 1
    ),
    per_market AS (
      SELECT condition_id, SUM(pnl) AS market_pnl FROM ranked GROUP BY condition_id
    ),
    pos_per_market AS (
      SELECT market_pnl FROM per_market WHERE market_pnl > 0 ORDER BY market_pnl DESC LIMIT 5
    )
    SELECT
      (SELECT COUNT(*)::int FROM ranked) AS trades,
      (SELECT COUNT(*) FILTER (WHERE won=1)::int FROM ranked) AS wins,
      COALESCE((SELECT AVG(eff_price)::float8 FROM ranked), 0) AS avg_price,
      COALESCE((SELECT SUM(stake)::float8 FROM ranked), 0) AS capital,
      COALESCE((SELECT SUM(cash_back)::float8 FROM ranked), 0) AS cash_back,
      COALESCE((SELECT SUM(pnl)::float8 FROM ranked), 0) AS net_pnl,
      (SELECT COUNT(*)::int FROM per_market) AS markets,
      COALESCE((SELECT SUM(market_pnl)::float8 FROM pos_per_market), 0) AS top5_pos
  `;
  const r = rows[0];
  const totalPos = await sql<Array<{ s: number }>>`
    SELECT COALESCE(SUM(market_pnl), 0)::float8 AS s
    FROM (
      SELECT t.condition_id, SUM(CASE WHEN m.resolved_outcome = t.outcome
        THEN ${STAKE} * (1.0 / (t.price * ${FRICTION_MULT})) - ${STAKE} ELSE -${STAKE}::float8 END) AS market_pnl
      FROM trades t JOIN trade_features f ON f.trade_id = t.id JOIN markets m ON m.condition_id = t.condition_id
      WHERE t.side = 'BUY' AND m.resolved_outcome IN ('YES','NO')
        AND t.price >= ${p_min} AND t.price <= ${p_max}
        AND f.hours_to_resolve >= ${tb.min} AND f.hours_to_resolve <= ${tb.max}
        AND ${sql.unsafe(mf.clause)}
        AND t.price > 0 AND t.price < 1
      GROUP BY t.condition_id HAVING SUM(CASE WHEN m.resolved_outcome = t.outcome
        THEN ${STAKE} * (1.0 / (t.price * ${FRICTION_MULT})) - ${STAKE} ELSE -${STAKE}::float8 END) > 0
    ) sub
  `;
  const top5 = totalPos[0].s > 0 ? (r.top5_pos / totalPos[0].s) * 100 : 0;
  return {
    name,
    trades: r.trades,
    wins: r.wins,
    avg_price: r.avg_price,
    win_pct: r.trades > 0 ? (r.wins / r.trades) * 100 : 0,
    capital_deployed: r.capital,
    cash_returned: r.cash_back,
    net_pnl: r.net_pnl,
    roi_pct: r.capital > 0 ? (r.net_pnl / r.capital) * 100 : 0,
    distinct_markets: r.markets,
    top5_concentration: top5,
  };
}

(async () => {
  console.log("[grid-sql] starting...");
  await sql`DELETE FROM backtest_runs WHERE strategy_id LIKE 'grid_%'`;
  await sql`DELETE FROM strategies WHERE id LIKE 'grid_%'`;

  const results: StratResult[] = [];
  let n = 0;
  const total = PRICE_BANDS.length * TIME_BANDS.length * MOM_FILTERS.length;
  const start = Date.now();

  for (const [p_min, p_max] of PRICE_BANDS) {
    for (const tb of TIME_BANDS) {
      for (const mf of MOM_FILTERS) {
        n++;
        const r = await runStrategy(p_min, p_max, tb, mf);
        results.push(r);
        const id = `grid_${n.toString().padStart(4, "0")}`;
        await sql`
          INSERT INTO strategies (id, name, spec_json, generation, generated_by, hypothesis, created_at)
          VALUES (${id}, ${r.name}, ${JSON.stringify({ p_min, p_max, time: tb, mom: mf })}::jsonb, 0, 'grid', ${r.name}, ${Date.now()})
          ON CONFLICT (id) DO NOTHING
        `;
        await sql`
          INSERT INTO backtest_runs (
            id, strategy_id, universe_filter, starting_bankroll, final_bankroll,
            total_pnl, roi_pct, trade_count, win_count, loss_count, win_pct,
            payoff_ratio, profit_factor, sharpe, max_drawdown_pct,
            distinct_markets, top5_market_concentration, details_json, created_at
          ) VALUES (
            ${id + "_bt"}, ${id}, ${JSON.stringify({})}::jsonb,
            ${STARTING_BANKROLL}, ${STARTING_BANKROLL + r.net_pnl},
            ${r.net_pnl}, ${r.roi_pct}, ${r.trades}, ${r.wins}, ${r.trades - r.wins},
            ${r.win_pct}, 0, 0, 0, 0,
            ${r.distinct_markets}, ${r.top5_concentration},
            ${JSON.stringify({})}::jsonb, ${Date.now()}
          )
          ON CONFLICT (id) DO NOTHING
        `;
        const elapsed = (Date.now() - start) / 1000;
        process.stdout.write(`  ${n}/${total}  elapsed=${elapsed.toFixed(0)}s  ${r.name.padEnd(48)} trades=${String(r.trades).padStart(6)} wr=${r.win_pct.toFixed(1).padStart(5)}% roi=${r.roi_pct.toFixed(1).padStart(7)}%  \n`);
      }
    }
  }

  console.log(`\n[grid-sql] done in ${((Date.now() - start) / 60_000).toFixed(1)}min, ${total} strategies tested`);

  console.log("\n=== TOP 15 BY ROI (min 100 trades, min 30 markets) ===");
  console.log("Strategy                                          Trades   Markets   WR%     ROI%     Top5%");
  console.log("─".repeat(110));
  results
    .filter((r) => r.trades >= 100 && r.distinct_markets >= 30)
    .sort((a, b) => b.roi_pct - a.roi_pct)
    .slice(0, 15)
    .forEach((r) => console.log(`${r.name.padEnd(48)} ${String(r.trades).padStart(7)} ${String(r.distinct_markets).padStart(7)} ${r.win_pct.toFixed(1).padStart(6)}% ${r.roi_pct.toFixed(1).padStart(7)}% ${r.top5_concentration.toFixed(0).padStart(5)}%`));

  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
