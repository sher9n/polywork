// Backtests the 3 size-filtered "whale" candidates from the Kelly hunt
// across 3 lookback windows (30d, 90d, 365d). For each strategy at each
// window, reports: trade count, win rate (and 1-WR as per-trade failure
// rate), final equity, return, max drawdown, killswitch status.
//
// Also runs the 3-strategy combo portfolio (equal allocation) at each
// window so we can see whether diversification helps.
//
// Run: tsx scripts/strategy-hunt-whale-validate.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
import { runWindow, fullKelly, type Entry, type EngineConfig, type AgentConfig, type PriceLookup } from "../src/lib/backtest-engine";
import { buildPriceCache, lookupPriceAt } from "../src/lib/price-cache";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

const STARTING_BANKROLL = 1000;
const KILLSWITCH_DD_PCT = 50;      // matches live (we raised it earlier)
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
  size_min: number;            // NEW: trade size at entry must be >= this
  wr_prior: number;
  max_pct_per_trade: number;
  max_concurrent: number;
  kelly_mult: number;
};

// Top 3 from the Kelly hunt. All filter to size >= $200 (large trades).
// WR prior uses L365 (most conservative, durable estimate).
const WHALES: StrategySpec[] = [
  // #1: 0.75-0.80, rising, <6h, size=large. L365 WR 82%.
  { name: "whale_fav_rising",     price_min: 0.75, price_max: 0.80, mom_min: 0.02, mom_max: 10, htr_min: 0, htr_max: 6, size_min: 200, wr_prior: 0.82, max_pct_per_trade: 0.25, max_concurrent: 10, kelly_mult: 1.0 },
  // #2: 0.50-0.55, any, <6h, size=large. L365 WR 59%.
  { name: "whale_coin_flash",     price_min: 0.50, price_max: 0.55, mom_min: -10,  mom_max: 10, htr_min: 0, htr_max: 6, size_min: 200, wr_prior: 0.59, max_pct_per_trade: 0.13, max_concurrent: 10, kelly_mult: 1.0 },
  // #3: 0.70-0.75, rising, <6h, size=large. L365 WR 77%.
  { name: "whale_midfav_rising",  price_min: 0.70, price_max: 0.75, mom_min: 0.02, mom_max: 10, htr_min: 0, htr_max: 6, size_min: 200, wr_prior: 0.77, max_pct_per_trade: 0.20, max_concurrent: 10, kelly_mult: 1.0 },
];

const COMBO: Array<{ spec: StrategySpec; alloc_pct: number }> = [
  { spec: WHALES[0], alloc_pct: 0.34 },
  { spec: WHALES[1], alloc_pct: 0.33 },
  { spec: WHALES[2], alloc_pct: 0.33 },
];

async function loadTrades(specs: StrategySpec[], windowStartMs: number) {
  const minPx = Math.min(...specs.map((s) => s.price_min));
  const maxPx = Math.max(...specs.map((s) => s.price_max));
  const minSize = Math.min(...specs.map((s) => s.size_min));
  return await sql<Array<{
    ts: number; entry_price: number; size: number; duration_h: number; won: number;
    mom_24h: number | null;
    condition_id: string; outcome: string;
  }>>`
    SELECT
      t.ts::bigint AS ts,
      t.price::float8 AS entry_price,
      t.size::float8 AS size,
      tf.hours_to_resolve::float8 AS duration_h,
      tf.won::int AS won,
      tf.mom_24h::float8 AS mom_24h,
      t.condition_id,
      t.outcome
    FROM trades t JOIN trade_features tf ON tf.trade_id = t.id
    WHERE t.side = 'BUY'
      AND t.price >= ${minPx} AND t.price <= ${maxPx}
      AND t.size >= ${minSize}
      AND t.ts >= ${windowStartMs} AND t.ts < ${NOW_MS}
    ORDER BY t.ts ASC
  `;
}

function buildEntries(allTrades: Awaited<ReturnType<typeof loadTrades>>, specs: StrategySpec[], windowStartMs: number): Entry[] {
  const out: Entry[] = [];
  for (let si = 0; si < specs.length; si++) {
    const s = specs[si];
    const seen = new Set<string>();
    for (const r of allTrades) {
      if (seen.has(r.condition_id)) continue;
      if (r.entry_price < s.price_min || r.entry_price > s.price_max) continue;
      if (r.size < s.size_min) continue;
      if (r.mom_24h === null) continue;
      if (r.mom_24h < s.mom_min || r.mom_24h > s.mom_max) continue;
      if (r.duration_h < s.htr_min || r.duration_h > s.htr_max) continue;
      seen.add(r.condition_id);
      out.push({
        agent_idx: si,
        entry_time_h: (Number(r.ts) - windowStartMs) / 3600_000,
        entry_price: r.entry_price,
        duration_h: r.duration_h,
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
  windowLabel: string;
  windowDays: number;
  label: string;
  total_entries: number;
  total_wins: number;
  total_losses: number;
  wr: number;
  failure_rate: number;       // 1 - wr (per-trade loss rate)
  final_equity: number;
  return_pct: number;
  max_drawdown_pct: number;
  killed: boolean;
  killed_day: number;
  agent_entries: number[];
  agent_wins: number[];
};

async function runForWindow(
  label: string,
  portfolio: Array<{ spec: StrategySpec; alloc_pct: number }>,
  windowDays: number,
  priceLookup: PriceLookup,
): Promise<ScenarioResult> {
  const windowStartMs = NOW_MS - windowDays * MS_PER_DAY;
  const specs = portfolio.map((p) => p.spec);
  const allTrades = await loadTrades(specs, windowStartMs);
  const entries = buildEntries(allTrades, specs, windowStartMs);

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
  const totalLosses = out.agent_losses.reduce((s, v) => s + v, 0);
  const wr = totalEntries > 0 ? totalWins / totalEntries : 0;

  return {
    windowLabel: `${windowDays}d`,
    windowDays,
    label,
    total_entries: totalEntries,
    total_wins: totalWins,
    total_losses: totalLosses,
    wr,
    failure_rate: 1 - wr,
    final_equity: out.final_equity,
    return_pct: (out.final_equity / STARTING_BANKROLL - 1) * 100,
    max_drawdown_pct: maxDd,
    killed: out.killed,
    killed_day: out.killed_day,
    agent_entries: out.agent_entries,
    agent_wins: out.agent_wins,
  };
}

function pad(s: string, n: number): string { return s.length >= n ? s : s + " ".repeat(n - s.length); }
function rpad(s: string, n: number): string { return s.length >= n ? s : " ".repeat(n - s.length) + s; }

(async () => {
  console.log(`[whale-validate] now=${new Date(NOW_MS).toISOString()}, ks=${KILLSWITCH_DD_PCT}%, starting=$${STARTING_BANKROLL}`);
  console.log(`[whale-validate] candidates: ${WHALES.map((w) => w.name).join(", ")}`);
  console.log(`[whale-validate] windows: ${WINDOWS.map((w) => w.label).join(", ")}`);
  console.log("");

  // Need the price cache covering ALL trades across the longest window.
  console.log("[whale-validate] building price cache...");
  const longestWindowMs = NOW_MS - WINDOWS[WINDOWS.length - 1].days * MS_PER_DAY;
  const allFor365 = await loadTrades(WHALES, longestWindowMs);
  const uniqueCids = Array.from(new Set(allFor365.map((r) => r.condition_id)));
  const cache = await buildPriceCache(sql, uniqueCids);
  const priceLookup: PriceLookup = (cid, outc, ts) => lookupPriceAt(cache, cid, outc, ts);
  console.log(`[whale-validate]   ${uniqueCids.length} markets cached`);
  console.log("");

  // PART 1: each whale standalone @ each window
  console.log("=".repeat(140));
  console.log(`PART 1: each whale strategy standalone at $${STARTING_BANKROLL} (ks=${KILLSWITCH_DD_PCT}%)`);
  console.log("=".repeat(140));
  console.log("");
  console.log(`  ${pad("strategy", 22)} ${pad("window", 7)} ${rpad("trades", 7)} ${rpad("wins", 5)} ${rpad("WR", 7)} ${rpad("fail%", 7)} ${rpad("final$", 9)} ${rpad("return", 9)} ${rpad("maxDD", 7)} ${rpad("killed?", 10)}`);
  for (const whale of WHALES) {
    for (const w of WINDOWS) {
      const res = await runForWindow(whale.name, [{ spec: whale, alloc_pct: 1.0 }], w.days, priceLookup);
      const killedStr = res.killed ? `day ${res.killed_day}` : "no";
      console.log(`  ${pad(whale.name, 22)} ${pad(w.label, 7)} ${rpad(res.total_entries.toString(), 7)} ${rpad(res.total_wins.toString(), 5)} ${rpad((res.wr * 100).toFixed(1) + "%", 7)} ${rpad((res.failure_rate * 100).toFixed(1) + "%", 7)} ${rpad("$" + res.final_equity.toFixed(0), 9)} ${rpad((res.return_pct >= 0 ? "+" : "") + res.return_pct.toFixed(1) + "%", 9)} ${rpad(res.max_drawdown_pct.toFixed(1) + "%", 7)} ${rpad(killedStr, 10)}`);
    }
    console.log("");
  }

  // PART 2: equal-weight combo @ each window
  console.log("=".repeat(140));
  console.log(`PART 2: 3-whale combo (equal allocation) at $${STARTING_BANKROLL} (ks=${KILLSWITCH_DD_PCT}%)`);
  console.log("=".repeat(140));
  console.log("");
  console.log(`  ${pad("window", 7)} ${rpad("trades", 7)} ${rpad("wins", 5)} ${rpad("WR", 7)} ${rpad("fail%", 7)} ${rpad("final$", 9)} ${rpad("return", 9)} ${rpad("maxDD", 7)} ${rpad("killed?", 10)}`);
  for (const w of WINDOWS) {
    const res = await runForWindow("combo", COMBO, w.days, priceLookup);
    const killedStr = res.killed ? `day ${res.killed_day}` : "no";
    console.log(`  ${pad(w.label, 7)} ${rpad(res.total_entries.toString(), 7)} ${rpad(res.total_wins.toString(), 5)} ${rpad((res.wr * 100).toFixed(1) + "%", 7)} ${rpad((res.failure_rate * 100).toFixed(1) + "%", 7)} ${rpad("$" + res.final_equity.toFixed(0), 9)} ${rpad((res.return_pct >= 0 ? "+" : "") + res.return_pct.toFixed(1) + "%", 9)} ${rpad(res.max_drawdown_pct.toFixed(1) + "%", 7)} ${rpad(killedStr, 10)}`);
  }
  console.log("");

  // PART 3: per-strategy breakdown of the combo @ 365d (so we see who's
  // contributing what within the portfolio).
  console.log("=".repeat(140));
  console.log(`PART 3: per-strategy breakdown of the combo @ 365d`);
  console.log("=".repeat(140));
  console.log("");
  const comboRes = await runForWindow("combo", COMBO, 365, priceLookup);
  console.log(`  ${pad("agent", 22)} ${rpad("alloc", 7)} ${rpad("trades", 7)} ${rpad("wins", 5)} ${rpad("WR", 7)} ${rpad("fail%", 7)}`);
  for (let i = 0; i < COMBO.length; i++) {
    const n = comboRes.agent_entries[i];
    const w = comboRes.agent_wins[i];
    const wr = n > 0 ? (w / n) * 100 : 0;
    const fr = n > 0 ? ((n - w) / n) * 100 : 0;
    console.log(`  ${pad(COMBO[i].spec.name, 22)} ${rpad((COMBO[i].alloc_pct * 100).toFixed(0) + "%", 7)} ${rpad(n.toString(), 7)} ${rpad(w.toString(), 5)} ${rpad(wr.toFixed(1) + "%", 7)} ${rpad(fr.toFixed(1) + "%", 7)}`);
  }
  console.log("");

  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
