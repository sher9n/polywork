// Replicate Finding 1 from experiment1.md: WR by price band should match
// within ±2pp on the polywork 8.5M-trade dataset. If it doesn't, something
// is wrong with our ingest.

import postgres from "postgres";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

(async () => {
  const rows = await sql<Array<{ band: number; trades: number; actual_wr: number; implied_wr: number; edge_pp: number }>>`
    WITH binned AS (
      SELECT
        FLOOR(t.price * 10) / 10.0 AS band,
        t.price,
        CASE WHEN m.resolved_outcome = t.outcome THEN 1 ELSE 0 END AS won
      FROM trades t
      JOIN markets m ON m.condition_id = t.condition_id
      WHERE t.side = 'BUY'
    )
    SELECT
      band::float8,
      COUNT(*)::int AS trades,
      (AVG(won::numeric) * 100)::float8 AS actual_wr,
      (AVG(price)::numeric * 100)::float8 AS implied_wr,
      ((AVG(won::numeric) - AVG(price))::numeric * 100)::float8 AS edge_pp
    FROM binned GROUP BY band ORDER BY band
  `;
  console.log("=== POLYWORK Finding 1 replication ===\n");
  console.log("Price band       Trades       Actual WR    Implied WR    Edge (pp)");
  console.log("─────────────────────────────────────────────────────────────────");
  for (const r of rows) {
    const lo = (r.band).toFixed(2);
    const hi = (r.band + 0.099).toFixed(2);
    console.log(
      `$${lo}-$${hi}  ${String(r.trades).padStart(10).padStart(10)}  ${r.actual_wr.toFixed(1).padStart(8)}%   ${r.implied_wr.toFixed(1).padStart(8)}%   ${r.edge_pp >= 0 ? "+" : ""}${r.edge_pp.toFixed(1).padStart(5)}pp`,
    );
  }
  console.log("\n=== Comparison to experiment1.md Finding 1 ===\n");
  // Expected values from experiment1.md
  const expected: Record<string, { actual: number; trades_min: number }> = {
    "0.0": { actual: 0.0, trades_min: 50000 },
    "0.1": { actual: 3.4, trades_min: 1000 },
    "0.2": { actual: 12.0, trades_min: 1000 },
    "0.3": { actual: 16.6, trades_min: 1000 },
    "0.4": { actual: 29.3, trades_min: 1000 },
    "0.5": { actual: 60.5, trades_min: 1000 },
    "0.6": { actual: 79.8, trades_min: 1000 },
    "0.7": { actual: 79.5, trades_min: 1000 },
    "0.8": { actual: 95.9, trades_min: 1000 },
    "0.9": { actual: 99.9, trades_min: 50000 },
  };
  let agreement = 0;
  let disagreement = 0;
  for (const r of rows) {
    const key = r.band.toFixed(1);
    const exp = expected[key];
    if (!exp) continue;
    const diff = Math.abs(r.actual_wr - exp.actual);
    const ok = diff <= 2.0;
    if (ok) agreement++;
    else disagreement++;
    console.log(
      `  band $${key}  polywork=${r.actual_wr.toFixed(1)}%  experiment1=${exp.actual}%  diff=${diff.toFixed(1)}pp  ${ok ? "✓ match" : "⚠ DIFF >2pp"}`,
    );
  }
  console.log(`\nResult: ${agreement} bands match within ±2pp, ${disagreement} disagree`);
  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
