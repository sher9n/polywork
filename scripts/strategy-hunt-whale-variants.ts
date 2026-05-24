// Whale strategies under five variants of the realistic backtest, so we can
// see how much each fix closes the simulation gap.
//
//   A: htr 0-6h,   no pocket   (baseline realistic - what we ran before)
//   B: htr 0-24h,  no pocket   (wider htr alone)
//   C: htr 0-24h,  with pocket (wider + capital efficiency)
//   D: htr 0-72h,  with pocket (max aggression)
//   E: htr 0-6h,   with pocket (pocket alone - control)
//
// All variants use SCHEDULED end_date for the strategy htr filter (matches
// live bot) and ACTUAL resolution_ts for engine duration (matches reality).
// The optimistic "look-ahead" version we ran earlier serves as the ceiling
// that no fix can fully reach.
//
// Run: tsx scripts/strategy-hunt-whale-variants.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
import { runWindow, fullKelly, type Entry, type EngineConfig, type AgentConfig, type PriceLookup } from "../src/lib/backtest-engine";
import { buildPriceCache, lookupPriceAt } from "../src/lib/price-cache";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

const STARTING_BANKROLL = 1000;
const KILLSWITCH_DD_PCT = 50;
const NOW_MS = Date.now();
const MS_PER_DAY = 86400 * 1000;

const WINDOWS: Array<{ label: string; days: number }> = [
  { label: "30d",  days: 30 },
  { label: "90d",  days: 90 },
  { label: "365d", days: 365 },
];

type StrategySpec = {
  name: string;
  price_min: number;
  price_max: number;
  mom_min: number;
  mom_max: number;
  size_min: number;
  wr_prior: number;
  max_pct_per_trade: number;
  max_concurrent: number;
  kelly_mult: number;
};

const WHALES: StrategySpec[] = [
  { name: "whale_fav_rising",     price_min: 0.75, price_max: 0.80, mom_min: 0.02, mom_max: 10, size_min: 200, wr_prior: 0.82, max_pct_per_trade: 0.25, max_concurrent: 10, kelly_mult: 1.0 },
  { name: "whale_coin_flash",     price_min: 0.50, price_max: 0.55, mom_min: -10,  mom_max: 10, size_min: 200, wr_prior: 0.59, max_pct_per_trade: 0.13, max_concurrent: 10, kelly_mult: 1.0 },
  { name: "whale_midfav_rising",  price_min: 0.70, price_max: 0.75, mom_min: 0.02, mom_max: 10, size_min: 200, wr_prior: 0.77, max_pct_per_trade: 0.20, max_concurrent: 10, kelly_mult: 1.0 },
];

const COMBO: Array<{ spec: StrategySpec; alloc_pct: number }> = [
  { spec: WHALES[0], alloc_pct: 0.34 },
  { spec: WHALES[1], alloc_pct: 0.33 },
  { spec: WHALES[2], alloc_pct: 0.33 },
];

type Variant = {
  id: "A" | "B" | "C" | "D" | "E";
  label: string;
  htr_min: number;
  htr_max: number;
  pocket_enabled: boolean;
};

const VARIANTS: Variant[] = [
  { id: "A", label: "htr 0-6h,  no pocket",   htr_min: 0, htr_max: 6,  pocket_enabled: false },
  { id: "B", label: "htr 0-24h, no pocket",   htr_min: 0, htr_max: 24, pocket_enabled: false },
  { id: "C", label: "htr 0-24h, with pocket", htr_min: 0, htr_max: 24, pocket_enabled: true  },
  { id: "D", label: "htr 0-72h, with pocket", htr_min: 0, htr_max: 72, pocket_enabled: true  },
  { id: "E", label: "htr 0-6h,  with pocket", htr_min: 0, htr_max: 6,  pocket_enabled: true  },
];

async function loadTrades(specs: StrategySpec[], windowStartMs: number) {
  const minPx = Math.min(...specs.map((s) => s.price_min));
  const maxPx = Math.max(...specs.map((s) => s.price_max));
  const minSize = Math.min(...specs.map((s) => s.size_min));
  return await sql<Array<{
    ts: number; entry_price: number; size: number;
    scheduled_end_ms: number | null;
    resolution_ts: number | null;
    won: number;
    mom_24h: number | null;
    condition_id: string; outcome: string;
  }>>`
    SELECT
      t.ts::bigint AS ts,
      t.price::float8 AS entry_price,
      t.size::float8 AS size,
      (EXTRACT(EPOCH FROM m.end_date) * 1000)::bigint AS scheduled_end_ms,
      m.resolution_ts::bigint AS resolution_ts,
      tf.won::int AS won,
      tf.mom_24h::float8 AS mom_24h,
      t.condition_id,
      t.outcome
    FROM trades t
    JOIN trade_features tf ON tf.trade_id = t.id
    JOIN markets m ON m.condition_id = t.condition_id
    WHERE t.side = 'BUY'
      AND t.price >= ${minPx} AND t.price <= ${maxPx}
      AND t.size >= ${minSize}
      AND t.ts >= ${windowStartMs} AND t.ts < ${NOW_MS}
      AND m.end_date IS NOT NULL
      AND m.resolution_ts IS NOT NULL
    ORDER BY t.ts ASC
  `;
}

function buildEntries(allTrades: Awaited<ReturnType<typeof loadTrades>>, specs: StrategySpec[], windowStartMs: number, htrMin: number, htrMax: number): Entry[] {
  const out: Entry[] = [];
  const seenByAgent: Set<string>[] = specs.map(() => new Set());
  for (const r of allTrades) {
    if (r.scheduled_end_ms === null || r.resolution_ts === null) continue;
    const scheduledEndMs = Number(r.scheduled_end_ms);
    const actualResMs = Number(r.resolution_ts);
    const schedHtr = (scheduledEndMs - Number(r.ts)) / 3600_000;
    const actualHtr = Math.max(0.01, (actualResMs - Number(r.ts)) / 3600_000);
    if (schedHtr < htrMin || schedHtr > htrMax) continue;

    for (let si = 0; si < specs.length; si++) {
      const s = specs[si];
      if (seenByAgent[si].has(r.condition_id)) continue;
      if (r.entry_price < s.price_min || r.entry_price > s.price_max) continue;
      if (r.size < s.size_min) continue;
      if (r.mom_24h === null) continue;
      if (r.mom_24h < s.mom_min || r.mom_24h > s.mom_max) continue;
      seenByAgent[si].add(r.condition_id);
      out.push({
        agent_idx: si,
        entry_time_h: (Number(r.ts) - windowStartMs) / 3600_000,
        entry_price: r.entry_price,
        duration_h: actualHtr,
        won: r.won === 1 ? 1 : 0,
        condition_id: r.condition_id,
        outcome: (r.outcome === "YES" ? "YES" : "NO") as "YES" | "NO",
        abs_entry_ts: Number(r.ts),
      });
    }
  }
  out.sort((a, b) => a.entry_time_h - b.entry_time_h);
  return out;
}

type ScenarioResult = {
  total_entries: number; total_wins: number;
  wr: number;
  final_equity: number; return_pct: number; max_drawdown_pct: number;
  killed: boolean; killed_day: number;
};

async function runScenario(
  portfolio: Array<{ spec: StrategySpec; alloc_pct: number }>,
  windowDays: number,
  variant: Variant,
  priceLookup: PriceLookup,
): Promise<ScenarioResult> {
  const windowStartMs = NOW_MS - windowDays * MS_PER_DAY;
  const specs = portfolio.map((p) => p.spec);
  const allTrades = await loadTrades(specs, windowStartMs);
  const entries = buildEntries(allTrades, specs, windowStartMs, variant.htr_min, variant.htr_max);

  const agents: AgentConfig[] = portfolio.map((p) => ({
    name: p.spec.name,
    alloc_pct: p.alloc_pct,
    kelly_full: fullKelly(p.spec.wr_prior, (p.spec.price_min + p.spec.price_max) / 2),
    kelly_mult: p.spec.kelly_mult,
    max_pct_per_trade: p.spec.max_pct_per_trade,
    max_concurrent: p.spec.max_concurrent,
  }));

  const cfg: EngineConfig = {
    agents,
    starting_bankroll: STARTING_BANKROLL,
    days: windowDays,
    killswitch_dd_pct: KILLSWITCH_DD_PCT,
    price_lookup: priceLookup,
    window_start_abs_ts: windowStartMs,
    pocket_enabled: variant.pocket_enabled,
  };
  const out = runWindow(entries, cfg);

  let peak = STARTING_BANKROLL, maxDd = 0;
  for (const v of out.trajectory) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak * 100;
    if (dd > maxDd) maxDd = dd;
  }

  const totalEntries = out.agent_entries.reduce((s, v) => s + v, 0);
  const totalWins = out.agent_wins.reduce((s, v) => s + v, 0);
  const wr = totalEntries > 0 ? totalWins / totalEntries : 0;

  return {
    total_entries: totalEntries, total_wins: totalWins, wr,
    final_equity: out.final_equity,
    return_pct: (out.final_equity / STARTING_BANKROLL - 1) * 100,
    max_drawdown_pct: maxDd,
    killed: out.killed, killed_day: out.killed_day,
  };
}

function pad(s: string, n: number): string { return s.length >= n ? s : s + " ".repeat(n - s.length); }
function rpad(s: string, n: number): string { return s.length >= n ? s : " ".repeat(n - s.length) + s; }

(async () => {
  console.log(`[whale-variants] 5 fix variants × 3 windows × combo portfolio. now=${new Date(NOW_MS).toISOString()}, ks=${KILLSWITCH_DD_PCT}%, $${STARTING_BANKROLL} start`);
  console.log(`[whale-variants] all variants use SCHEDULED end_date for strategy htr filter (matches live)`);
  console.log("");

  console.log("[whale-variants] building price cache for longest window (365d)...");
  const longestWindowMs = NOW_MS - WINDOWS[WINDOWS.length - 1].days * MS_PER_DAY;
  const allFor365 = await loadTrades(WHALES, longestWindowMs);
  const uniqueCids = Array.from(new Set(allFor365.map((r) => r.condition_id)));
  const cache = await buildPriceCache(sql, uniqueCids);
  const priceLookup: PriceLookup = (cid, outc, ts) => lookupPriceAt(cache, cid, outc, ts);
  console.log(`[whale-variants]   ${uniqueCids.length} markets cached`);
  console.log("");

  // Header
  console.log("=".repeat(150));
  console.log(`COMBO PORTFOLIO (equal-weight 3 whales) across variants and windows`);
  console.log("=".repeat(150));
  console.log("");
  console.log(`  ${pad("variant", 32)} ${pad("window", 7)} ${rpad("trades", 7)} ${rpad("WR", 7)} ${rpad("final$", 9)} ${rpad("return", 9)} ${rpad("maxDD", 7)} ${rpad("killed?", 10)}`);
  for (const v of VARIANTS) {
    for (const w of WINDOWS) {
      const res = await runScenario(COMBO, w.days, v, priceLookup);
      const killedStr = res.killed ? `day ${res.killed_day}` : "no";
      console.log(`  ${pad(v.id + ": " + v.label, 32)} ${pad(w.label, 7)} ${rpad(res.total_entries.toString(), 7)} ${rpad((res.wr * 100).toFixed(1) + "%", 7)} ${rpad("$" + res.final_equity.toFixed(0), 9)} ${rpad((res.return_pct >= 0 ? "+" : "") + res.return_pct.toFixed(1) + "%", 9)} ${rpad(res.max_drawdown_pct.toFixed(1) + "%", 7)} ${rpad(killedStr, 10)}`);
    }
    console.log("");
  }

  // Reference: the optimistic (look-ahead) numbers we already produced -
  // hardcoded from /tmp/whale-validate.log results for the combo. These are
  // the THEORETICAL CEILING - the answer the cheating backtest gave.
  console.log("=".repeat(150));
  console.log("REFERENCE (cheating backtest, look-ahead bias on htr filter) - the theoretical ceiling no realistic fix can reach:");
  console.log("=".repeat(150));
  console.log(`  ${pad("variant", 32)} ${pad("window", 7)} ${rpad("trades", 7)} ${rpad("WR", 7)} ${rpad("final$", 9)} ${rpad("return", 9)}`);
  console.log(`  ${pad("CEILING (look-ahead htr 0-6h)", 32)} ${pad("30d", 7)} ${rpad("108", 7)} ${rpad("73.1%", 7)} ${rpad("$1320", 9)} ${rpad("+32.0%", 9)}`);
  console.log(`  ${pad("CEILING (look-ahead htr 0-6h)", 32)} ${pad("90d", 7)} ${rpad("240", 7)} ${rpad("74.6%", 7)} ${rpad("$2130", 9)} ${rpad("+113.0%", 9)}`);
  console.log(`  ${pad("CEILING (look-ahead htr 0-6h)", 32)} ${pad("365d", 7)} ${rpad("828", 7)} ${rpad("73.9%", 7)} ${rpad("$6655", 9)} ${rpad("+565.5%", 9)}`);

  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
