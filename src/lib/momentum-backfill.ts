// Ensures we have at least 24h of price history in live_trades for every
// active market, so ride_ryan / leap_liam's 24h-momentum filter can fire on
// day 1 instead of waiting a day. Pulls from Polymarket's CLOB prices-history
// endpoint and writes synthetic "trade" rows.
//
// Idempotent: skips any market that already has data older than 24h.

import type { Sql } from "postgres";

const GAMMA = process.env.POLYMARKET_GAMMA ?? "https://gamma-api.polymarket.com";
const CLOB = process.env.POLYMARKET_CLOB ?? "https://clob.polymarket.com";
const HOUR_MS = 3600 * 1000;
const LOOKBACK_HOURS = 30; // > 24 so the momentum window has slack

type GammaMarket = { conditionId?: string; clobTokenIds?: string };

async function fetchJson<T>(url: string, attempt = 1): Promise<T | null> {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 20_000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) {
      if ((r.status === 429 || r.status >= 500) && attempt < 4) {
        await new Promise((res) => setTimeout(res, 1000 * attempt));
        return fetchJson(url, attempt + 1);
      }
      return null;
    }
    return (await r.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

async function fetchClobTokenIds(conditionId: string): Promise<[string, string] | null> {
  const ms = await fetchJson<GammaMarket[]>(`${GAMMA}/markets?condition_ids=${conditionId}&limit=1`);
  if (!ms || ms.length === 0 || !ms[0].clobTokenIds) return null;
  try {
    const ids = JSON.parse(ms[0].clobTokenIds) as string[];
    if (ids.length !== 2) return null;
    return [ids[0], ids[1]];
  } catch {
    return null;
  }
}

type HistoryPoint = { t: number; p: number };
async function fetchPriceHistory(tokenId: string): Promise<HistoryPoint[]> {
  // interval=1w gives a week of points; fidelity=60 = sample once per hour.
  // We need points spanning at least 25h back. 1w with hourly fidelity is plenty.
  const resp = await fetchJson<{ history?: HistoryPoint[] }>(
    `${CLOB}/prices-history?market=${tokenId}&interval=1w&fidelity=60`,
  );
  return resp?.history ?? [];
}

async function processInBatches<T>(items: T[], batchSize: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    await Promise.all(items.slice(i, i + batchSize).map(fn));
  }
}

export type BackfillStats = {
  markets_checked: number;
  markets_skipped: number; // already had 24h+ data
  markets_backfilled: number;
  markets_failed: number;
  synthetic_trades_inserted: number;
};

export async function ensureMomentumHistory(sql: Sql, opts: { onlyMissing?: boolean } = {}): Promise<BackfillStats> {
  const { onlyMissing = true } = opts;
  const stats: BackfillStats = {
    markets_checked: 0,
    markets_skipped: 0,
    markets_backfilled: 0,
    markets_failed: 0,
    synthetic_trades_inserted: 0,
  };

  const cutoff = Date.now() - 24 * HOUR_MS;
  const lookbackCutoff = Date.now() - LOOKBACK_HOURS * HOUR_MS;

  // List of markets we actually care about: anything in our agents' price bands.
  // YES in [0.20, 0.30] OR [0.40, 0.80] covers both ride_ryan and leap_liam
  // regardless of which side they'd buy.
  const markets = await sql<Array<{ condition_id: string }>>`
    SELECT condition_id FROM live_market_state
    WHERE active = 1
      AND (
        current_yes_price IS NULL
        OR current_yes_price BETWEEN 0.20 AND 0.30
        OR current_yes_price BETWEEN 0.40 AND 0.80
      )
  `;
  stats.markets_checked = markets.length;

  // Skip those that already have 24h+ data (idempotency)
  const needed: string[] = [];
  if (onlyMissing) {
    for (const m of markets) {
      const has = await sql<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM live_trades
        WHERE condition_id = ${m.condition_id} AND ts <= ${cutoff} LIMIT 1
      `;
      if (has[0].n > 0) stats.markets_skipped++;
      else needed.push(m.condition_id);
    }
  } else {
    needed.push(...markets.map((m) => m.condition_id));
  }

  if (needed.length === 0) return stats;

  console.error(`[backfill] ${stats.markets_skipped} already have 24h+ data, fetching ${needed.length} markets...`);

  await processInBatches(needed, 6, async (conditionId) => {
    const tokens = await fetchClobTokenIds(conditionId);
    if (!tokens) {
      stats.markets_failed++;
      return;
    }
    const [yesToken, noToken] = tokens;
    let inserted = 0;
    for (const [outcome, token] of [["YES", yesToken], ["NO", noToken]] as const) {
      const history = await fetchPriceHistory(token);
      if (history.length === 0) continue;
      for (const point of history) {
        const tsMs = point.t * 1000;
        // Only insert points within our lookback window (avoids polluting with ancient data)
        if (tsMs < lookbackCutoff) continue;
        try {
          const r = await sql`
            INSERT INTO live_trades (condition_id, ts, outcome, side, price, size, taker)
            VALUES (${conditionId}, ${tsMs}, ${outcome}, 'BUY', ${point.p}, 0, 'backfill')
            ON CONFLICT (condition_id, ts, outcome, side, price, size, taker) DO NOTHING
          `;
          if (r.count > 0) inserted++;
        } catch { /* swallow conflicts / duplicates */ }
      }
    }
    if (inserted > 0) {
      stats.markets_backfilled++;
      stats.synthetic_trades_inserted += inserted;
    } else {
      stats.markets_failed++;
    }
  });

  return stats;
}

// On-demand single-market backfill. Called when the live bot encounters a
// trade in a market it hasn't seen before. Pulls ~30h of price history so
// mom_24h becomes computable immediately rather than waiting 24h of live
// observation. Idempotent: returns 0 if recent data already exists.
const onDemandSeenMarkets = new Set<string>();
export async function ensureMomentumHistoryForMarket(sql: Sql, conditionId: string): Promise<number> {
  // Memoize in-process so we don't re-fetch the same market repeatedly.
  if (onDemandSeenMarkets.has(conditionId)) return 0;
  onDemandSeenMarkets.add(conditionId);

  const cutoff = Date.now() - 24 * HOUR_MS;
  const has = await sql<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM live_trades
    WHERE condition_id = ${conditionId} AND ts <= ${cutoff} LIMIT 1
  `;
  if (has[0].n > 0) return 0;

  const tokens = await fetchClobTokenIds(conditionId);
  if (!tokens) return 0;
  const [yesToken, noToken] = tokens;
  const lookbackCutoff = Date.now() - LOOKBACK_HOURS * HOUR_MS;
  let inserted = 0;
  for (const [outcome, token] of [["YES", yesToken], ["NO", noToken]] as const) {
    const history = await fetchPriceHistory(token);
    if (history.length === 0) continue;
    for (const point of history) {
      const tsMs = point.t * 1000;
      if (tsMs < lookbackCutoff) continue;
      try {
        const r = await sql`
          INSERT INTO live_trades (condition_id, ts, outcome, side, price, size, taker)
          VALUES (${conditionId}, ${tsMs}, ${outcome}, 'BUY', ${point.p}, 0, 'backfill')
          ON CONFLICT (condition_id, ts, outcome, side, price, size, taker) DO NOTHING
        `;
        if (r.count > 0) inserted++;
      } catch { /* shouldn't happen with ON CONFLICT, but be safe */ }
    }
  }
  return inserted;
}
