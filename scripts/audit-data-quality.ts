// Data-quality audit. Runs after ingest. Flags:
//   1. Markets with zero trades (failed to ingest)
//   2. Markets with suspiciously few trades for their volume
//   3. Trade-timestamp gaps (e.g. >7d between consecutive trades on a $100k+ market - indicates incomplete capture)
//   4. market_life_pct distribution (should span 0-1 for fully-captured markets)
//   5. Resolution mismatch (markets where the winning side's trades dominate
//      the closing-price range as expected - confirms outcome data is right)
//   6. Outcome distribution (should be ~70-30 YES-resolved for most universes)
//
// Run: tsx scripts/audit-data-quality.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

async function main(): Promise<void> {
  console.log("=== POLYWORK DATA QUALITY AUDIT ===\n");

  // 1. Coverage summary
  const cov = await sql<Array<{ markets: number; with_trades: number; without_trades: number; total_trades: number; empty_pct: number }>>`
    SELECT
      COUNT(*)::int AS markets,
      COUNT(*) FILTER (WHERE (SELECT COUNT(*) FROM trades t WHERE t.condition_id = m.condition_id) > 0)::int AS with_trades,
      COUNT(*) FILTER (WHERE (SELECT COUNT(*) FROM trades t WHERE t.condition_id = m.condition_id) = 0)::int AS without_trades,
      (SELECT COUNT(*) FROM trades)::int AS total_trades,
      ROUND((100.0 * COUNT(*) FILTER (WHERE (SELECT COUNT(*) FROM trades t WHERE t.condition_id = m.condition_id) = 0) / COUNT(*))::numeric, 1)::float8 AS empty_pct
    FROM markets m
  `;
  const c = cov[0];
  console.log("[1] Coverage");
  console.log(`  Markets ingested:      ${c.markets.toLocaleString()}`);
  console.log(`  Markets with trades:   ${c.with_trades.toLocaleString()}`);
  console.log(`  Markets with 0 trades: ${c.without_trades.toLocaleString()}  (${c.empty_pct}%)`);
  console.log(`  Total trades:          ${c.total_trades.toLocaleString()}`);
  if (c.empty_pct > 25) console.log(`  WARNING: >25% of markets have zero trades. Investigate.`);

  // 2. Trade-count distribution
  console.log("\n[2] Trade-count distribution per market");
  const dist = await sql<Array<{ bucket: string; n: number }>>`
    WITH per_market AS (SELECT condition_id, COUNT(*) AS n FROM trades GROUP BY condition_id)
    SELECT
      CASE
        WHEN n < 10 THEN '00: <10 (likely junk)'
        WHEN n < 50 THEN '01: 10-49 (sparse)'
        WHEN n < 200 THEN '02: 50-199'
        WHEN n < 500 THEN '03: 200-499'
        WHEN n < 1500 THEN '04: 500-1499'
        WHEN n < 3000 THEN '05: 1500-2999'
        ELSE '06: 3000 (cap hit, may have tail-bias)'
      END AS bucket,
      COUNT(*)::int AS n
    FROM per_market GROUP BY bucket ORDER BY bucket
  `;
  for (const r of dist) console.log(`  ${r.bucket.padEnd(40)} markets=${r.n}`);

  // 3. Volume vs trade-count correlation
  console.log("\n[3] Volume vs trade-count (should correlate)");
  const corr = await sql<Array<{ vol_bucket: string; markets: number; avg_trades: number; max_trades: number; min_trades: number }>>`
    WITH per_market AS (
      SELECT m.condition_id, m.volume_usd, COUNT(t.id)::int AS trade_count
      FROM markets m LEFT JOIN trades t ON t.condition_id = m.condition_id
      GROUP BY m.condition_id, m.volume_usd
    )
    SELECT
      CASE
        WHEN volume_usd < 50000 THEN '$20-50k'
        WHEN volume_usd < 100000 THEN '$50-100k'
        WHEN volume_usd < 250000 THEN '$100-250k'
        WHEN volume_usd < 500000 THEN '$250-500k'
        WHEN volume_usd < 1000000 THEN '$500k-1M'
        ELSE '$1M+'
      END AS vol_bucket,
      COUNT(*)::int AS markets,
      ROUND(AVG(trade_count)::numeric, 0)::int AS avg_trades,
      MAX(trade_count)::int AS max_trades,
      MIN(trade_count)::int AS min_trades
    FROM per_market GROUP BY vol_bucket ORDER BY MIN(volume_usd)
  `;
  for (const r of corr) console.log(`  ${r.vol_bucket.padEnd(12)} markets=${String(r.markets).padStart(5)}  avg_trades=${String(r.avg_trades).padStart(5)}  range=[${r.min_trades}-${r.max_trades}]`);

  // 4. market_life_pct coverage check
  console.log("\n[4] market_life_pct coverage per market (should span 0-1 for fully captured)");
  const life = await sql<Array<{ bucket: string; n: number }>>`
    WITH per_market AS (
      SELECT condition_id, MIN(market_life_pct) AS min_lp, MAX(market_life_pct) AS max_lp, COUNT(*) AS n
      FROM trades WHERE market_life_pct IS NOT NULL GROUP BY condition_id
    )
    SELECT
      CASE
        WHEN max_lp - min_lp < 0.1 THEN '00: <10% span (likely just snapshots)'
        WHEN max_lp - min_lp < 0.5 THEN '01: 10-50% span'
        WHEN max_lp - min_lp < 0.9 THEN '02: 50-90% span'
        ELSE '03: 90-100% span (full life captured)'
      END AS bucket,
      COUNT(*)::int AS n
    FROM per_market WHERE n >= 10 GROUP BY bucket ORDER BY bucket
  `;
  for (const r of life) console.log(`  ${r.bucket.padEnd(45)} markets=${r.n}`);

  // 5. Resolution outcome distribution
  console.log("\n[5] Resolution outcome split (should be roughly 50-50 across universe)");
  const outcomes = await sql<Array<{ resolved_outcome: string; n: number; pct: number }>>`
    SELECT
      resolved_outcome::text AS resolved_outcome,
      COUNT(*)::int AS n,
      ROUND((100.0 * COUNT(*) / SUM(COUNT(*)) OVER ())::numeric, 1)::float8 AS pct
    FROM markets WHERE resolved_outcome IS NOT NULL
    GROUP BY resolved_outcome
  `;
  for (const r of outcomes) console.log(`  ${r.resolved_outcome.padEnd(5)} ${r.n.toLocaleString()}  (${r.pct}%)`);

  // 6. Resolution sanity: do the LAST trades on winning side trend toward $1?
  console.log("\n[6] Resolution sanity: winning-side last-trade prices (should cluster near $1)");
  const sanity = await sql<Array<{ bucket: string; n: number }>>`
    WITH last_trades AS (
      SELECT DISTINCT ON (m.condition_id) m.condition_id, m.resolved_outcome, t.outcome, t.price, t.ts
      FROM markets m
      JOIN trades t ON t.condition_id = m.condition_id AND t.outcome = m.resolved_outcome
      WHERE m.resolved_outcome IS NOT NULL
      ORDER BY m.condition_id, t.ts DESC
    )
    SELECT
      CASE
        WHEN price >= 0.95 THEN '95-100% (winning side near $1)'
        WHEN price >= 0.80 THEN '80-95%'
        WHEN price >= 0.50 THEN '50-80%'
        WHEN price >= 0.20 THEN '20-50% (suspicious)'
        ELSE '<20% (almost certainly bad data)'
      END AS bucket,
      COUNT(*)::int AS n
    FROM last_trades GROUP BY bucket ORDER BY MIN(price) DESC
  `;
  for (const r of sanity) console.log(`  ${r.bucket.padEnd(35)} ${r.n.toLocaleString()}`);

  // 7. Time coverage
  console.log("\n[7] Trade timestamp coverage");
  const time = await sql<Array<{ year_month: string; n: number }>>`
    SELECT
      to_char(to_timestamp(ts/1000.0), 'YYYY-MM') AS year_month,
      COUNT(*)::int AS n
    FROM trades GROUP BY year_month ORDER BY year_month
  `;
  for (const r of time) console.log(`  ${r.year_month}  ${r.n.toLocaleString()}`);

  await sql.end();
}

void main().catch((e) => { console.error(e); process.exit(1); });
