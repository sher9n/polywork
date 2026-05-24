import postgres from "postgres";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

(async () => {
  const r1 = await sql<Array<{ markets: number; with_trades: number; total_trades: number }>>`
    SELECT (SELECT COUNT(*)::int FROM markets) AS markets,
           (SELECT COUNT(DISTINCT condition_id)::int FROM trades) AS with_trades,
           (SELECT COUNT(*)::int FROM trades) AS total_trades
  `;
  console.log(`markets ingested:       ${r1[0].markets.toLocaleString()}`);
  console.log(`markets with trades:    ${r1[0].with_trades.toLocaleString()}`);
  console.log(`total trades:           ${r1[0].total_trades.toLocaleString()}`);

  const dist = await sql<Array<{ bucket: string; n: number }>>`
    WITH per_market AS (
      SELECT condition_id, COUNT(*) AS n FROM trades GROUP BY condition_id
    )
    SELECT
      CASE
        WHEN n < 10 THEN '00: <10'
        WHEN n < 100 THEN '01: 10-99'
        WHEN n < 500 THEN '02: 100-499'
        WHEN n < 1500 THEN '03: 500-1499'
        WHEN n < 3000 THEN '04: 1500-2999'
        ELSE '05: 3000 (cap)'
      END AS bucket,
      COUNT(*)::int AS n
    FROM per_market GROUP BY bucket ORDER BY bucket
  `;
  console.log("\ntrade-count distribution per market:");
  for (const r of dist) console.log(`  ${r.bucket.padEnd(15)} markets=${r.n}`);
  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
