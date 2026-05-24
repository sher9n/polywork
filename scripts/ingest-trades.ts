// Pull up to N trades per ingested market via Polymarket Data API. Tags
// each trade with `market_life_pct` (0.0=first trade, 1.0=last trade) so we
// can slice discovery vs mop-up phase later.
//
// Skips markets that already have trades >= cap (idempotent re-runs).
//
// Run: tsx scripts/ingest-trades.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const DB_URL = process.env.POLYWORK_DB_URL ?? "postgresql:///polywork";
const DATA = process.env.POLYMARKET_DATA ?? "https://data-api.polymarket.com";
const MAX_PER_MARKET = Number(process.env.INGEST_MAX_TRADES_PER_MARKET ?? 3000);
const CONCURRENCY = Number(process.env.INGEST_CONCURRENCY ?? 4);
const PAGE = 500;

type DataTrade = {
  proxyWallet?: string;
  side: "BUY" | "SELL";
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  outcome: "Yes" | "No";
};

class PaginationExhaustedError extends Error {}
class TooManyRetriesError extends Error {}

// 429 retries with exponential backoff + jitter + Retry-After header support.
// Bumped to 8 attempts so we ride out short rate-limit windows. Returns null
// only when pagination is exhausted; throws for everything else so the caller
// records a real failure (not silently empty trades).
async function fetchJson<T>(url: string, attempt = 1, maxAttempts = 8): Promise<T> {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 30_000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) {
      if (r.status === 400) throw new PaginationExhaustedError();
      if ((r.status === 429 || r.status >= 500) && attempt < maxAttempts) {
        // Honor Retry-After header if present; else exponential backoff with jitter.
        const ra = r.headers.get("retry-after");
        const headerMs = ra ? Math.max(1000, parseInt(ra, 10) * 1000) : 0;
        const expMs = Math.min(30_000, 500 * Math.pow(2, attempt - 1));
        const jitter = Math.floor(Math.random() * 500);
        const waitMs = Math.max(headerMs, expMs) + jitter;
        await new Promise((res) => setTimeout(res, waitMs));
        return fetchJson(url, attempt + 1, maxAttempts);
      }
      if (r.status === 429 || r.status >= 500) {
        throw new TooManyRetriesError(`${url} gave up after ${maxAttempts} attempts (last status ${r.status})`);
      }
      throw new Error(`${url} -> HTTP ${r.status}`);
    }
    return (await r.json()) as T;
  } finally {
    clearTimeout(to);
  }
}

async function pullTrades(cid: string, cap: number): Promise<DataTrade[]> {
  const all: DataTrade[] = [];
  for (let offset = 0; all.length < cap; offset += PAGE) {
    const url = `${DATA}/trades?market=${cid}&limit=${PAGE}&offset=${offset}`;
    let page: DataTrade[];
    try {
      page = await fetchJson<DataTrade[]>(url);
    } catch (e) {
      if (e instanceof PaginationExhaustedError) break;
      throw e;
    }
    if (page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE) break;
  }
  return all.slice(0, cap);
}

async function main(): Promise<void> {
  const sql = postgres(DB_URL);

  // Find markets that don't yet have trades up to the cap.
  const markets = await sql<Array<{ condition_id: string; have: number }>>`
    SELECT m.condition_id, COALESCE((SELECT COUNT(*) FROM trades t WHERE t.condition_id = m.condition_id), 0)::int AS have
    FROM markets m
    WHERE COALESCE((SELECT COUNT(*) FROM trades t WHERE t.condition_id = m.condition_id), 0) < ${MAX_PER_MARKET}
    ORDER BY m.volume_usd DESC
  `;
  console.log(`[trades] ${markets.length} markets need trades (target ${MAX_PER_MARKET}/market, concurrency ${CONCURRENCY})`);

  let done = 0;
  let totalInserted = 0;
  let failed = 0;
  let rateLimited = 0;
  let emptyAfterFilter = 0;
  // Failed markets get retried at the end with serial-low-concurrency pass.
  const failedMarkets: Array<{ condition_id: string; have: number; reason: string }> = [];
  const queue = [...markets];
  const start = Date.now();

  async function worker(id: number): Promise<void> {
    while (true) {
      const m = queue.shift();
      if (!m) return;
      try {
        const trades = await pullTrades(m.condition_id, MAX_PER_MARKET - m.have);
        // Filter to YES/NO outcomes only. Multi-outcome markets (NCAA brackets,
        // election fields, etc.) have outcome=teamName which fails the
        // trades.outcome CHECK constraint. The market was admitted because its
        // outcomePrices parsed binary, but the underlying asset trades use
        // the named outcomes.
        const binary = trades.filter((t) => {
          const o = (t.outcome ?? "").toUpperCase();
          return o === "YES" || o === "NO";
        });
        if (binary.length === 0) {
          emptyAfterFilter++;
          done++;
          continue;
        }
        // Sort ascending so market_life_pct calc is easy.
        const sorted = binary.slice().sort((a, b) => a.timestamp - b.timestamp);
        const t0 = sorted[0].timestamp;
        const tN = sorted[sorted.length - 1].timestamp;
        const spanS = Math.max(1, tN - t0);
        const rows = sorted.map((t) => ({
          condition_id: m.condition_id,
          ts: t.timestamp * 1000,
          outcome: (t.outcome ?? "Yes").toUpperCase(),
          side: t.side,
          price: t.price,
          size: t.size,
          taker: t.proxyWallet ?? null,
          market_life_pct: (t.timestamp - t0) / spanS,
        }));
        // Bulk insert in chunks of 1000.
        for (let i = 0; i < rows.length; i += 1000) {
          const batch = rows.slice(i, i + 1000);
          await sql`INSERT INTO trades ${sql(batch as readonly Record<string, unknown>[], "condition_id", "ts", "outcome", "side", "price", "size", "taker", "market_life_pct")}`;
        }
        totalInserted += rows.length;
        done++;
      } catch (e) {
        failed++;
        done++;
        const msg = (e as Error).message;
        if (e instanceof TooManyRetriesError || msg.includes("429")) rateLimited++;
        failedMarkets.push({ condition_id: m.condition_id, have: m.have, reason: msg });
        if (failed % 20 === 1) console.error(`\n[w${id}] FAILED ${m.condition_id.slice(0, 10)}..: ${msg}`);
      }
      const pct = (done / markets.length) * 100;
      const elapsed = (Date.now() - start) / 1000;
      const rate = done / elapsed;
      const eta = rate > 0 ? (markets.length - done) / rate : 0;
      process.stdout.write(
        `  [w${id}] ${done}/${markets.length} (${pct.toFixed(1)}%)  trades=${totalInserted.toLocaleString()}  fail=${failed}  rate=${rate.toFixed(1)}/s  eta=${Math.round(eta / 60)}m\r`,
      );
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  console.log(`\n[trades] first pass: ${((Date.now() - start) / 60_000).toFixed(1)}min  inserted=${totalInserted.toLocaleString()}  failed=${failed}  rate_limited=${rateLimited}  empty_after_filter=${emptyAfterFilter}`);

  // Retry failed markets with single-worker serial pass + longer pauses.
  if (failedMarkets.length > 0) {
    console.log(`[trades] retrying ${failedMarkets.length} failed markets serially with 2s pauses...`);
    let retryDone = 0;
    let retryOk = 0;
    let retryStillFailed = 0;
    for (const m of failedMarkets) {
      try {
        await new Promise((res) => setTimeout(res, 2000));
        const trades = await pullTrades(m.condition_id, MAX_PER_MARKET - m.have);
        const binary = trades.filter((t) => {
          const o = (t.outcome ?? "").toUpperCase();
          return o === "YES" || o === "NO";
        });
        if (binary.length > 0) {
          const sorted = binary.slice().sort((a, b) => a.timestamp - b.timestamp);
          const t0 = sorted[0].timestamp;
          const tN = sorted[sorted.length - 1].timestamp;
          const spanS = Math.max(1, tN - t0);
          const rows = sorted.map((t) => ({
            condition_id: m.condition_id,
            ts: t.timestamp * 1000,
            outcome: (t.outcome ?? "Yes").toUpperCase(),
            side: t.side,
            price: t.price,
            size: t.size,
            taker: t.proxyWallet ?? null,
            market_life_pct: (t.timestamp - t0) / spanS,
          }));
          for (let i = 0; i < rows.length; i += 1000) {
            const batch = rows.slice(i, i + 1000);
            await sql`INSERT INTO trades ${sql(batch as readonly Record<string, unknown>[], "condition_id", "ts", "outcome", "side", "price", "size", "taker", "market_life_pct")}`;
          }
          totalInserted += rows.length;
          retryOk++;
        }
      } catch {
        retryStillFailed++;
      }
      retryDone++;
      process.stdout.write(`  retry ${retryDone}/${failedMarkets.length} ok=${retryOk} still_failed=${retryStillFailed}\r`);
    }
    console.log(`\n[trades] retry pass done: recovered=${retryOk} still_failed=${retryStillFailed}`);
  }

  console.log(`[trades] ALL DONE in ${((Date.now() - start) / 60_000).toFixed(1)}min  total_inserted=${totalInserted.toLocaleString()}`);
  await sql.end();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
