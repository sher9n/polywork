// Compute trade features once after ingestion so the backtest grid is fast.
// For each trade we derive:
//   - mom_1h, mom_6h, mom_24h, mom_3d: price - price_at_(ts - N hours) on the
//     SAME (market, outcome side)
//   - vol_24h: stddev of last 24h prices on same side
//   - hours_to_resolve: (market.resolution_ts - trade.ts) / 1h
//   - distance_50: |price - 0.5|
//   - per_share_pnl: 1-price if we'd have won (outcome matches resolved), else -price
//   - won: 1 / 0
//
// Run: tsx scripts/compute-features.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const HOUR_MS = 3600 * 1000;
const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

type TradeRow = {
  id: number;
  ts: number;
  outcome: "YES" | "NO";
  price: number;
};

async function processMarket(condition_id: string, resolution_ts: number, resolved_outcome: "YES" | "NO"): Promise<number> {
  const trades = await sql<TradeRow[]>`
    SELECT id, ts, outcome, price FROM trades WHERE condition_id = ${condition_id} ORDER BY ts ASC
  `;
  if (trades.length === 0) return 0;

  // Split per outcome for momentum lookups.
  const yes = trades.filter((t) => t.outcome === "YES");
  const no = trades.filter((t) => t.outcome === "NO");

  function priceAt(arr: TradeRow[], idx: number, targetTs: number): number | null {
    // Binary search: largest index j <= idx where arr[j].ts <= targetTs.
    let lo = 0, hi = idx;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (arr[mid].ts <= targetTs) lo = mid;
      else hi = mid - 1;
    }
    if (arr[lo].ts > targetTs) return null;
    return arr[lo].price;
  }

  function volatility24h(arr: TradeRow[], idx: number, ts: number): number | null {
    const cutoff = ts - 24 * HOUR_MS;
    const window = arr.slice(0, idx + 1).filter((t) => t.ts >= cutoff);
    if (window.length < 4) return null;
    const mean = window.reduce((s, t) => s + t.price, 0) / window.length;
    const v = window.reduce((s, t) => s + (t.price - mean) ** 2, 0) / window.length;
    return Math.sqrt(v);
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const arr of [yes, no]) {
    for (let i = 0; i < arr.length; i++) {
      const t = arr[i];
      const p1h = priceAt(arr, i, t.ts - HOUR_MS);
      const p6h = priceAt(arr, i, t.ts - 6 * HOUR_MS);
      const p24h = priceAt(arr, i, t.ts - 24 * HOUR_MS);
      const p3d = priceAt(arr, i, t.ts - 72 * HOUR_MS);
      const v24h = volatility24h(arr, i, t.ts);
      const hoursToResolve = Math.max(0, (resolution_ts - t.ts) / HOUR_MS);
      const won = t.outcome === resolved_outcome ? 1 : 0;
      const per_share_pnl = won ? 1 - t.price : -t.price;
      rows.push({
        trade_id: t.id,
        mom_1h: p1h !== null ? t.price - p1h : null,
        mom_6h: p6h !== null ? t.price - p6h : null,
        mom_24h: p24h !== null ? t.price - p24h : null,
        mom_3d: p3d !== null ? t.price - p3d : null,
        vol_24h: v24h,
        hours_to_resolve: hoursToResolve,
        distance_50: Math.abs(t.price - 0.5),
        per_share_pnl,
        won,
      });
    }
  }
  if (rows.length === 0) return 0;
  // Bulk insert in chunks of 1000.
  for (let i = 0; i < rows.length; i += 1000) {
    const batch = rows.slice(i, i + 1000);
    await sql`
      INSERT INTO trade_features ${sql(
        batch as readonly Record<string, unknown>[],
        "trade_id", "mom_1h", "mom_6h", "mom_24h", "mom_3d", "vol_24h",
        "hours_to_resolve", "distance_50", "per_share_pnl", "won",
      )}
      ON CONFLICT (trade_id) DO NOTHING
    `;
  }
  return rows.length;
}

async function main(): Promise<void> {
  // Only process markets that have trades but no (or incomplete) features.
  const markets = await sql<Array<{ condition_id: string; resolution_ts: number; resolved_outcome: "YES" | "NO"; trade_count: number; feature_count: number }>>`
    SELECT m.condition_id, m.resolution_ts, m.resolved_outcome,
           (SELECT COUNT(*)::int FROM trades t WHERE t.condition_id = m.condition_id) AS trade_count,
           (SELECT COUNT(*)::int FROM trades t JOIN trade_features f ON f.trade_id = t.id WHERE t.condition_id = m.condition_id) AS feature_count
    FROM markets m
    WHERE m.resolved_outcome IS NOT NULL
      AND m.resolution_ts IS NOT NULL
      AND (SELECT COUNT(*) FROM trades t WHERE t.condition_id = m.condition_id) > 0
    ORDER BY m.volume_usd DESC
  `;
  const todo = markets.filter((m) => m.feature_count < m.trade_count);
  console.log(`[features] ${todo.length} of ${markets.length} markets need feature computation`);

  let done = 0;
  let totalRows = 0;
  const start = Date.now();
  for (const m of todo) {
    try {
      const n = await processMarket(m.condition_id, m.resolution_ts, m.resolved_outcome);
      totalRows += n;
    } catch (e) {
      console.error(`\nFAILED ${m.condition_id.slice(0, 10)}: ${(e as Error).message}`);
    }
    done++;
    if (done % 50 === 0 || done === todo.length) {
      const elapsed = (Date.now() - start) / 1000;
      const rate = done / elapsed;
      const eta = rate > 0 ? (todo.length - done) / rate : 0;
      process.stdout.write(`  ${done}/${todo.length} (${((done / todo.length) * 100).toFixed(1)}%)  rows=${totalRows.toLocaleString()}  rate=${rate.toFixed(1)}/s  eta=${Math.round(eta / 60)}m\r`);
    }
  }
  console.log(`\n[features] done in ${((Date.now() - start) / 60_000).toFixed(1)}min  rows=${totalRows.toLocaleString()}`);
  await sql.end();
}

void main().catch((e) => { console.error(e); process.exit(1); });
