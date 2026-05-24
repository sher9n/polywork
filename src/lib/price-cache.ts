// Pre-built lookup: for every (condition_id, outcome) we care about, store
// the daily closing prices as a sorted array. Allows O(log N) "what was this
// market priced at on day X" queries during backtest.
//
// Only fetched markets are cached. Caller passes the set of condition_ids
// they care about.

import type { Sql } from "postgres";

type DailyClose = { day_ts: number; price: number };
export type PriceCache = Map<string, DailyClose[]>; // key = `${condition_id}|${outcome}`

const dayMs = 86400 * 1000;

export async function buildPriceCache(sql: Sql, conditionIds: string[]): Promise<PriceCache> {
  const cache: PriceCache = new Map();
  if (conditionIds.length === 0) return cache;
  const unique = Array.from(new Set(conditionIds));

  // Process in batches to avoid huge IN clauses
  const BATCH = 500;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const rows = await sql<Array<{ condition_id: string; outcome: string; day_ts: number; price: number }>>`
      WITH ranked AS (
        SELECT
          t.condition_id,
          t.outcome,
          (floor(t.ts / ${dayMs}) * ${dayMs})::bigint AS day_ts,
          t.price,
          ROW_NUMBER() OVER (PARTITION BY t.condition_id, t.outcome, floor(t.ts / ${dayMs}) ORDER BY t.ts DESC) AS rn
        FROM trades t
        WHERE t.condition_id = ANY(${batch}::text[])
      )
      SELECT condition_id, outcome, day_ts::bigint, price::float8
      FROM ranked
      WHERE rn = 1
      ORDER BY condition_id, outcome, day_ts ASC
    `;
    for (const r of rows) {
      const key = `${r.condition_id}|${r.outcome}`;
      if (!cache.has(key)) cache.set(key, []);
      cache.get(key)!.push({ day_ts: Number(r.day_ts), price: r.price });
    }
  }
  return cache;
}

// Lookup the most recent known closing price at or before `abs_ts`.
// Returns null if we have no price data for that market/outcome at that time.
export function lookupPriceAt(cache: PriceCache, condition_id: string, outcome: "YES" | "NO", abs_ts: number): number | null {
  const key = `${condition_id}|${outcome}`;
  const arr = cache.get(key);
  if (!arr || arr.length === 0) return null;
  // Binary search for largest day_ts <= abs_ts
  let lo = 0, hi = arr.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].day_ts <= abs_ts) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best >= 0 ? arr[best].price : null;
}
