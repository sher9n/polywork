// Stratified ingest of resolved Polymarket markets, 2024+, lifetime volume
// $50k-$500k (where the 3000-trade-per-market API cap usually captures full
// history). Pages Gamma in descending-volume order, filters client-side, and
// stops when we hit the target.
//
// Run: tsx scripts/ingest-markets.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
// Load .env.local (Next.js convention) with .env as fallback.
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const DB_URL = process.env.POLYWORK_DB_URL ?? "postgresql:///polywork";
const GAMMA = process.env.POLYMARKET_GAMMA ?? "https://gamma-api.polymarket.com";
const TARGET = Number(process.env.INGEST_MAX_MARKETS ?? 10000);
const MIN_VOL = Number(process.env.INGEST_MIN_VOLUME ?? 50000);
const MAX_VOL = Number(process.env.INGEST_MAX_VOLUME ?? 500000);
const MIN_RES_DATE = process.env.INGEST_MIN_RESOLUTION_DATE ?? "2024-01-01";

// Gamma silently caps limit at 100 and offset at ~10000 (HTTP 422 past that).
const PAGE = 100;
const MAX_OFFSET = 10000;

type GammaMarket = {
  conditionId?: string;
  questionID?: string;
  slug?: string;
  question?: string;
  category?: string;
  endDate?: string;
  closedTime?: string | null;
  outcomes?: string;
  outcomePrices?: string;
  volume?: string;
  liquidity?: string;
};

function parseOutcome(raw?: string): "YES" | "NO" | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw) as string[];
    const prices = arr.map((s) => parseFloat(s));
    if (prices.length === 2 && Math.abs(prices[0] + prices[1] - 1) < 0.01) {
      return prices[0] > 0.5 ? "YES" : "NO";
    }
    return null;
  } catch {
    return null;
  }
}

function volumeStratum(v: number): string {
  if (v < 100000) return "50k-100k";
  if (v < 250000) return "100k-250k";
  return "250k-500k";
}

function timeStratum(d: string | null | undefined): string {
  if (!d) return "unknown";
  const y = new Date(d).getUTCFullYear();
  const m = new Date(d).getUTCMonth() + 1;
  if (y === 2024 && m <= 6) return "2024-H1";
  if (y === 2024) return "2024-H2";
  if (y === 2025 && m <= 6) return "2025-H1";
  if (y === 2025) return "2025-H2";
  if (y >= 2026) return `${y}-${m <= 6 ? "H1" : "H2"}`;
  return "pre-2024";
}

function categoryStratum(c?: string): string {
  const cat = (c ?? "uncategorized").toLowerCase();
  if (/sport|nfl|nba|nhl|mlb|soccer|football|tennis|ufc|mma/.test(cat)) return "sports";
  if (/politic|election|trump|biden|congress|senate/.test(cat)) return "politics";
  if (/crypto|bitcoin|btc|eth|coin/.test(cat)) return "crypto";
  if (/world|geo|war|conflict|country/.test(cat)) return "world";
  if (/business|stock|earning|company/.test(cat)) return "business";
  if (/entertain|movie|music|celeb|award/.test(cat)) return "entertainment";
  if (/tech|ai|llm|sci/.test(cat)) return "tech";
  return "other";
}

class PaginationExhaustedError extends Error {}

async function fetchJson<T>(url: string, attempt = 1): Promise<T> {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 30_000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) {
      // 422 from Gamma means we walked off the end of the available pages.
      if (r.status === 422) throw new PaginationExhaustedError(`pagination exhausted at ${url}`);
      if ((r.status === 429 || r.status >= 500) && attempt < 4) {
        await new Promise((res) => setTimeout(res, 1000 * attempt));
        return fetchJson(url, attempt + 1);
      }
      throw new Error(`${url} -> HTTP ${r.status}`);
    }
    return (await r.json()) as T;
  } finally {
    clearTimeout(to);
  }
}

async function main(): Promise<void> {
  const sql = postgres(DB_URL);
  console.log(`[markets] target=${TARGET}, volume range $${MIN_VOL}-$${MAX_VOL}, min resolution date=${MIN_RES_DATE}`);

  const minResMs = new Date(MIN_RES_DATE).getTime();
  let inserted = 0;
  let seen = 0;
  let skipped_volume = 0;
  let skipped_unresolved = 0;
  let skipped_date = 0;

  for (let offset = 0; inserted < TARGET && offset < MAX_OFFSET; offset += PAGE) {
    const url = `${GAMMA}/markets?closed=true&limit=${PAGE}&order=volumeNum&ascending=false&offset=${offset}`;
    let page: GammaMarket[];
    try {
      page = await fetchJson<GammaMarket[]>(url);
    } catch (e) {
      if (e instanceof PaginationExhaustedError) break;
      throw e;
    }
    if (page.length === 0) break;
    seen += page.length;

    const rows: Array<Record<string, unknown>> = [];
    for (const m of page) {
      const vol = parseFloat(m.volume ?? "0");
      if (!isFinite(vol) || vol < MIN_VOL || vol > MAX_VOL) {
        skipped_volume++;
        continue;
      }
      const resolved = parseOutcome(m.outcomePrices);
      if (!resolved || !m.conditionId) {
        skipped_unresolved++;
        continue;
      }
      const endMs = m.endDate ? new Date(m.endDate).getTime() : null;
      const closedMs = m.closedTime ? new Date(m.closedTime).getTime() : endMs;
      if (closedMs === null || closedMs < minResMs) {
        skipped_date++;
        continue;
      }
      rows.push({
        condition_id: m.conditionId,
        question_id: m.questionID ?? null,
        slug: m.slug ?? null,
        question: m.question ?? "",
        category: m.category ?? null,
        end_date: m.endDate ?? null,
        resolution_ts: closedMs,
        resolved_outcome: resolved,
        volume_usd: vol,
        liquidity_usd: parseFloat(m.liquidity ?? "0"),
        volume_stratum: volumeStratum(vol),
        category_stratum: categoryStratum(m.category),
        time_stratum: timeStratum(m.endDate),
        ingested_at: Date.now(),
      });
    }
    if (rows.length > 0) {
      await sql`
        INSERT INTO markets ${sql(
          rows as readonly Record<string, unknown>[],
          "condition_id", "question_id", "slug", "question", "category",
          "end_date", "resolution_ts", "resolved_outcome", "volume_usd",
          "liquidity_usd", "volume_stratum", "category_stratum", "time_stratum",
          "ingested_at",
        )}
        ON CONFLICT (condition_id) DO NOTHING
      `;
      inserted += rows.length;
    }
    process.stdout.write(
      `  offset=${offset + PAGE}  seen=${seen}  inserted=${inserted}/${TARGET}  ` +
      `skip_vol=${skipped_volume}  skip_unres=${skipped_unresolved}  skip_date=${skipped_date}\r`,
    );
  }
  console.log(
    `\n[markets] done: inserted=${inserted}, scanned=${seen}, ` +
    `skip(volume)=${skipped_volume}, skip(unresolved)=${skipped_unresolved}, skip(date)=${skipped_date}`,
  );

  // Stratum breakdown.
  const strata = await sql<Array<{ category_stratum: string; time_stratum: string; volume_stratum: string; n: number }>>`
    SELECT category_stratum, time_stratum, volume_stratum, COUNT(*)::int AS n
    FROM markets GROUP BY category_stratum, time_stratum, volume_stratum
    ORDER BY n DESC LIMIT 30
  `;
  console.log("\n[markets] top strata:");
  for (const s of strata) {
    console.log(`  ${s.category_stratum.padEnd(15)} ${s.time_stratum.padEnd(10)} ${s.volume_stratum.padEnd(10)} n=${s.n}`);
  }
  await sql.end();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
