// Realistic backtest for the CURRENT LIVE bot's strategies (mid_fav_day,
// mid_fav_flash, mid_lottery). Uses scheduled end_date for the strategy htr
// filter (matches live behavior) and actual resolution_ts for engine duration.
//
// Companion variants: also runs with the pocket-capital fix and with mildly
// wider htr filters, so we can see whether either helps the live portfolio
// in a way they didn't help the whales. Most informative is the comparison
// against the previous biased "live portfolio at ks=50% = +745%" claim.
//
// Run: tsx scripts/strategy-hunt-live-validate-realistic.ts

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
  htr_min: number;
  htr_max: number;
  wr_prior: number;
  max_pct_per_trade: number;
  max_concurrent: number;
  kelly_mult: number;
};

// EXACT specs from seed-agents.ts for the current live bots.
const LIVE_STRATEGIES: StrategySpec[] = [
  { name: "mid_fav_day",   price_min: 0.70, price_max: 0.75, mom_min: -0.02, mom_max: 0.02, htr_min: 12,  htr_max: 24, wr_prior: 0.947, max_pct_per_trade: 0.25, max_concurrent: 12, kelly_mult: 1.0 },
  { name: "mid_fav_flash", price_min: 0.70, price_max: 0.75, mom_min: -0.02, mom_max: 0.02, htr_min: 0.5, htr_max: 6,  wr_prior: 0.961, max_pct_per_trade: 0.25, max_concurrent: 10, kelly_mult: 1.0 },
  { name: "mid_lottery",   price_min: 0.20, price_max: 0.25, mom_min: 0.02,  mom_max: 10,   htr_min: 6,   htr_max: 12, wr_prior: 0.378, max_pct_per_trade: 0.10, max_concurrent: 8,  kelly_mult: 1.0 },
];

// Production allocations from seed-agents.ts: $500/$300/$200 on $1000.
const LIVE_COMBO: Array<{ spec: StrategySpec; alloc_pct: number }> = [
  { spec: LIVE_STRATEGIES[0], alloc_pct: 0.50 },
  { spec: LIVE_STRATEGIES[1], alloc_pct: 0.30 },
  { spec: LIVE_STRATEGIES[2], alloc_pct: 0.20 },
];

type Variant = {
  id: string;
  label: string;
  htr_widening_factor: number;   // multiplier on each strategy's htr window (1 = original)
  pocket_enabled: boolean;
};

const VARIANTS: Variant[] = [
  { id: "A", label: "original htr,    no pocket   (live-equivalent)", htr_widening_factor: 1, pocket_enabled: false },
  { id: "B", label: "original htr,    with pocket",                   htr_widening_factor: 1, pocket_enabled: true  },
  { id: "C", label: "2x wider htr,    with pocket",                   htr_widening_factor: 2, pocket_enabled: true  },
];

async function loadTrades(specs: StrategySpec[], windowStartMs: number) {
  const minPx = Math.min(...specs.map((s) => s.price_min));
  const maxPx = Math.max(...specs.map((s) => s.price_max));
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
      AND t.ts >= ${windowStartMs} AND t.ts < ${NOW_MS}
      AND m.end_date IS NOT NULL
      AND m.resolution_ts IS NOT NULL
    ORDER BY t.ts ASC
  `;
}

function buildEntries(allTrades: Awaited<ReturnType<typeof loadTrades>>, specs: StrategySpec[], windowStartMs: number, htrWidenFactor: number): Entry[] {
  const out: Entry[] = [];
  const seenByAgent: Set<string>[] = specs.map(() => new Set());
  for (const r of allTrades) {
    if (r.scheduled_end_ms === null || r.resolution_ts === null) continue;
    const scheduledEndMs = Number(r.scheduled_end_ms);
    const actualResMs = Number(r.resolution_ts);
    const schedHtr = (scheduledEndMs - Number(r.ts)) / 3600_000;
    const actualHtr = Math.max(0.01, (actualResMs - Number(r.ts)) / 3600_000);
    if (schedHtr < 0) continue;

    for (let si = 0; si < specs.length; si++) {
      const s = specs[si];
      if (seenByAgent[si].has(r.condition_id)) continue;
      if (r.entry_price < s.price_min || r.entry_price > s.price_max) continue;
      if (r.mom_24h === null) continue;
      if (r.mom_24h < s.mom_min || r.mom_24h > s.mom_max) continue;
      const effMin = s.htr_min / htrWidenFactor;     // wider = lower min, higher max
      const effMax = s.htr_max * htrWidenFactor;
      if (schedHtr < effMin || schedHtr > effMax) continue;
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
  total_entries: number; total_wins: number; wr: number;
  final_equity: number; return_pct: number; max_drawdown_pct: number;
  killed: boolean; killed_day: number;
  agent_entries: number[]; agent_wins: number[];
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
  const entries = buildEntries(allTrades, specs, windowStartMs, variant.htr_widening_factor);

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
    agent_entries: out.agent_entries, agent_wins: out.agent_wins,
  };
}

function pad(s: string, n: number): string { return s.length >= n ? s : s + " ".repeat(n - s.length); }
function rpad(s: string, n: number): string { return s.length >= n ? s : " ".repeat(n - s.length) + s; }

(async () => {
  console.log(`[live-realistic] CURRENT LIVE bot strategies, realistic filter, ks=${KILLSWITCH_DD_PCT}%, $${STARTING_BANKROLL}, now=${new Date(NOW_MS).toISOString()}`);
  console.log(`[live-realistic] specs: mid_fav_day (50%), mid_fav_flash (30%), mid_lottery (20%)`);
  console.log("");

  console.log("[live-realistic] building price cache...");
  const longestWindowMs = NOW_MS - WINDOWS[WINDOWS.length - 1].days * MS_PER_DAY;
  const allFor365 = await loadTrades(LIVE_STRATEGIES, longestWindowMs);
  const uniqueCids = Array.from(new Set(allFor365.map((r) => r.condition_id)));
  const cache = await buildPriceCache(sql, uniqueCids);
  const priceLookup: PriceLookup = (cid, outc, ts) => lookupPriceAt(cache, cid, outc, ts);
  console.log(`[live-realistic]   ${uniqueCids.length} markets cached`);
  console.log("");

  // PART 1: combo portfolio across variants and windows.
  console.log("=".repeat(150));
  console.log(`PART 1: LIVE combo portfolio (50/30/20) across realistic variants`);
  console.log("=".repeat(150));
  console.log("");
  console.log(`  ${pad("variant", 50)} ${pad("window", 7)} ${rpad("trades", 7)} ${rpad("WR", 7)} ${rpad("final$", 9)} ${rpad("return", 9)} ${rpad("maxDD", 7)} ${rpad("killed?", 10)}`);
  for (const v of VARIANTS) {
    for (const w of WINDOWS) {
      const res = await runScenario(LIVE_COMBO, w.days, v, priceLookup);
      const killedStr = res.killed ? `day ${res.killed_day}` : "no";
      console.log(`  ${pad(v.id + ": " + v.label, 50)} ${pad(w.label, 7)} ${rpad(res.total_entries.toString(), 7)} ${rpad((res.wr * 100).toFixed(1) + "%", 7)} ${rpad("$" + res.final_equity.toFixed(0), 9)} ${rpad((res.return_pct >= 0 ? "+" : "") + res.return_pct.toFixed(1) + "%", 9)} ${rpad(res.max_drawdown_pct.toFixed(1) + "%", 7)} ${rpad(killedStr, 10)}`);
    }
    console.log("");
  }

  // PART 2: per-agent breakdown @ 365d, original-htr no-pocket variant.
  console.log("=".repeat(150));
  console.log(`PART 2: per-agent breakdown of LIVE combo @ 365d (variant A - what the live bot would have done)`);
  console.log("=".repeat(150));
  console.log("");
  const longResA = await runScenario(LIVE_COMBO, 365, VARIANTS[0], priceLookup);
  console.log(`  ${pad("agent", 18)} ${rpad("alloc", 7)} ${rpad("trades", 7)} ${rpad("wins", 5)} ${rpad("WR", 7)} ${rpad("fail%", 7)}`);
  for (let i = 0; i < LIVE_COMBO.length; i++) {
    const n = longResA.agent_entries[i];
    const w = longResA.agent_wins[i];
    const wr = n > 0 ? (w / n) * 100 : 0;
    const fr = n > 0 ? ((n - w) / n) * 100 : 0;
    console.log(`  ${pad(LIVE_COMBO[i].spec.name, 18)} ${rpad((LIVE_COMBO[i].alloc_pct * 100).toFixed(0) + "%", 7)} ${rpad(n.toString(), 7)} ${rpad(w.toString(), 5)} ${rpad(wr.toFixed(1) + "%", 7)} ${rpad(fr.toFixed(1) + "%", 7)}`);
  }
  console.log("");

  // PART 3: reference - the optimistic (cheating) result for the same portfolio.
  console.log("=".repeat(150));
  console.log(`REFERENCE: previously-reported OPTIMISTIC (look-ahead) result for CURRENT live portfolio @ ks=50% from earlier validation:`);
  console.log("=".repeat(150));
  console.log(`  CURRENT live portfolio @ 365d, look-ahead bias on htr filter: 240 trades, 65.0% WR, final $8455, return +745.5%, maxDD 54.8%, no kill`);
  console.log(`  ^ The honest realistic numbers in PART 1 supersede this. The +745% was largely an artifact of the same look-ahead bias that fooled us on the whales.`);

  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
