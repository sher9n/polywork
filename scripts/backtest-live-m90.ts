// Backtest the LIVE 4-agent portfolio against historical 90-day rolling windows.
//
// Live config (read from seed-agents.ts, NOT modified):
//   near_resolution_skim:  $0.90-0.95, 1-120h, no mom filter,  $400, kelly 0.40x, cap 12, max_pct 0.25
//   heavy_favorite_steady: $0.80-0.90, 168-672h, no mom filter, $250, kelly 0.40x, cap 16, max_pct 0.25
//   mom_rising_mid:        $0.40-0.80, 24-168h, mom>=+0.02,     $150, kelly 0.40x, cap 16, max_pct 0.18
//   mom_rising_longshot:   $0.20-0.30, 1-24h,   mom>=+0.02,     $200, kelly 0.40x, cap 8,  max_pct 0.05
//   killswitch: -25% from starting total bankroll
//
// Each agent maintains its own cash bucket. They share the same start time,
// each filters its own markets, settles independently. Killswitch fires on
// TOTAL equity drop >= 25%.
//
// Run: tsx scripts/backtest-live-m90.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

const STARTING_BANKROLL = 1000;
const KILLSWITCH_DD_PCT = 25;
const WINDOW_DAYS = 90;
const STEP_DAYS = 7; // weekly step - 90d windows shift weekly

type Spec = {
  name: string;
  price_min: number; price_max: number;
  htr_min: number; htr_max: number;
  mom_min: number; mom_max: number;
  alloc_pct: number;
  kelly_mult: number;
  max_pct_per_trade: number;
  max_concurrent: number;
  full_kelly: number;       // derived
  spec_wr: number;          // for full_kelly calc
  spec_avg_price: number;   // for full_kelly calc
};

function fullKelly(wr: number, price: number): number {
  const b = (1 - price) / price;
  return Math.max(0, (wr * b - (1 - wr)) / b);
}

const AGENTS: Spec[] = [
  { name: "near_skim",     price_min: 0.90, price_max: 0.95, htr_min: 1,    htr_max: 120, mom_min: -10,  mom_max: 10,
    alloc_pct: 0.40, kelly_mult: 0.40, max_pct_per_trade: 0.25, max_concurrent: 12,
    spec_wr: 0.96, spec_avg_price: 0.92, full_kelly: 0 },
  { name: "heavy_fav",     price_min: 0.80, price_max: 0.90, htr_min: 168,  htr_max: 672, mom_min: -10,  mom_max: 10,
    alloc_pct: 0.25, kelly_mult: 0.40, max_pct_per_trade: 0.25, max_concurrent: 16,
    spec_wr: 0.88, spec_avg_price: 0.85, full_kelly: 0 },
  { name: "rising_mid",    price_min: 0.40, price_max: 0.80, htr_min: 24,   htr_max: 168, mom_min: 0.02, mom_max: 10,
    alloc_pct: 0.15, kelly_mult: 0.40, max_pct_per_trade: 0.18, max_concurrent: 16,
    spec_wr: 0.67, spec_avg_price: 0.60, full_kelly: 0 },
  { name: "longshot",      price_min: 0.20, price_max: 0.30, htr_min: 1,    htr_max: 24,  mom_min: 0.02, mom_max: 10,
    alloc_pct: 0.20, kelly_mult: 0.40, max_pct_per_trade: 0.05, max_concurrent: 8,
    spec_wr: 0.32, spec_avg_price: 0.25, full_kelly: 0 },
];
for (const a of AGENTS) a.full_kelly = fullKelly(a.spec_wr, a.spec_avg_price);

type Entry = { agent_idx: number; condition_id: string; entry_ts: number; entry_price: number; resolve_ts: number; won: number };

async function loadAgentEntries(): Promise<Entry[]> {
  const all: Entry[] = [];
  for (let ai = 0; ai < AGENTS.length; ai++) {
    const a = AGENTS[ai];
    const rows = await sql<Array<{ condition_id: string; entry_ts: number; entry_price: number; duration_h: number; won: number }>>`
      SELECT DISTINCT ON (t.condition_id)
        t.condition_id,
        t.ts::bigint AS entry_ts,
        t.price::float8 AS entry_price,
        tf.hours_to_resolve::float8 AS duration_h,
        tf.won::int AS won
      FROM trades t JOIN trade_features tf ON tf.trade_id = t.id
      WHERE t.side='BUY'
        AND t.price >= ${a.price_min} AND t.price <= ${a.price_max}
        AND tf.hours_to_resolve >= ${a.htr_min} AND tf.hours_to_resolve <= ${a.htr_max}
        AND tf.mom_24h >= ${a.mom_min} AND tf.mom_24h <= ${a.mom_max}
      ORDER BY t.condition_id, t.ts ASC
    `;
    for (const r of rows) {
      all.push({
        agent_idx: ai,
        condition_id: r.condition_id,
        entry_ts: Number(r.entry_ts),
        entry_price: r.entry_price,
        resolve_ts: Number(r.entry_ts) + r.duration_h * 3600_000,
        won: r.won,
      });
    }
    console.log(`  ${a.name.padEnd(15)} ${rows.length.toLocaleString()} markets`);
  }
  return all.sort((a, b) => a.entry_ts - b.entry_ts);
}

type WindowResult = {
  start_ts: number;
  agent_entries: number[];
  agent_wins: number[];
  agent_losses: number[];
  final_equity: number;
  killed: boolean;
  killed_day: number;
};

function simulateWindow(allEntries: Entry[], startTs: number, endTs: number): WindowResult {
  const cash = AGENTS.map((a) => STARTING_BANKROLL * a.alloc_pct);
  const kellyFracs = AGENTS.map((a) => a.full_kelly * a.kelly_mult);
  type OpenPos = { agent_idx: number; stake: number; payoff_if_win: number; resolve_ts: number; won: number };
  const open: OpenPos[] = [];
  const agent_entries = new Array(AGENTS.length).fill(0);
  const agent_wins = new Array(AGENTS.length).fill(0);
  const agent_losses = new Array(AGENTS.length).fill(0);

  // Filter entries to this window
  const inWindow = allEntries.filter((e) => e.entry_ts >= startTs && e.entry_ts < endTs);

  let killed = false, killed_day = -1;
  let i = 0;

  while (true) {
    let nextTs = Infinity, kind: "entry" | "settle" = "entry", idx = -1;
    if (i < inWindow.length) { nextTs = inWindow[i].entry_ts; kind = "entry"; idx = i; }
    for (let j = 0; j < open.length; j++) {
      if (open[j].resolve_ts < nextTs && open[j].resolve_ts <= endTs) {
        nextTs = open[j].resolve_ts; kind = "settle"; idx = j;
      }
    }
    if (nextTs === Infinity || nextTs > endTs) break;

    if (kind === "settle") {
      const o = open[idx];
      if (o.won === 1) { cash[o.agent_idx] += o.payoff_if_win; agent_wins[o.agent_idx]++; }
      else { agent_losses[o.agent_idx]++; }
      open.splice(idx, 1);
    } else {
      const e = inWindow[idx]; i++;
      const a = AGENTS[e.agent_idx];
      const myOpenCount = open.filter((o) => o.agent_idx === e.agent_idx).length;
      if (myOpenCount >= a.max_concurrent) continue;
      if (cash[e.agent_idx] < 1) continue;
      const fracBase = Math.min(kellyFracs[e.agent_idx], a.max_pct_per_trade);
      const stake = Math.min(cash[e.agent_idx] * fracBase, cash[e.agent_idx] * 0.95);
      if (stake < 0.5) continue;
      const payoff = stake * (1 + (1 - e.entry_price) / e.entry_price);
      open.push({ agent_idx: e.agent_idx, stake, payoff_if_win: payoff, resolve_ts: e.resolve_ts, won: e.won });
      cash[e.agent_idx] -= stake;
      agent_entries[e.agent_idx]++;
    }
    // killswitch check on total equity
    const totalCash = cash.reduce((s, c) => s + c, 0);
    const committed = open.reduce((s, o) => s + o.stake, 0);
    const eq = totalCash + committed;
    if (((STARTING_BANKROLL - eq) / STARTING_BANKROLL) * 100 >= KILLSWITCH_DD_PCT) {
      killed = true; killed_day = Math.floor((nextTs - startTs) / (86400 * 1000));
      break;
    }
  }
  // Settle anything resolving within window
  if (!killed) {
    for (const o of open) {
      if (o.resolve_ts <= endTs) {
        if (o.won === 1) { cash[o.agent_idx] += o.payoff_if_win; agent_wins[o.agent_idx]++; }
        else { agent_losses[o.agent_idx]++; }
      }
    }
  }
  const totalCash = cash.reduce((s, c) => s + c, 0);
  const stillOpen = open.filter((o) => o.resolve_ts > endTs);
  const stillCommitted = stillOpen.reduce((s, o) => s + o.stake, 0);
  return {
    start_ts: startTs, agent_entries, agent_wins, agent_losses,
    final_equity: totalCash + stillCommitted, killed, killed_day,
  };
}

(async () => {
  console.log("loading agent entries from historical trades...\n");
  const allEntries = await loadAgentEntries();
  const totalMarkets = new Set(allEntries.map((e) => `${e.agent_idx}-${e.condition_id}`)).size;
  console.log(`\n  total (agent, market) pairs: ${totalMarkets.toLocaleString()}`);
  console.log(`  earliest: ${new Date(allEntries[0].entry_ts).toISOString().slice(0, 10)}`);
  console.log(`  latest:   ${new Date(allEntries[allEntries.length - 1].entry_ts).toISOString().slice(0, 10)}\n`);

  const earliest = allEntries[0].entry_ts;
  const latest = allEntries[allEntries.length - 1].entry_ts;
  const dayMs = 86400 * 1000;
  const windowMs = WINDOW_DAYS * dayMs;

  console.log(`backtesting ${WINDOW_DAYS}d rolling windows, step ${STEP_DAYS}d ...\n`);
  const results: WindowResult[] = [];
  for (let s = earliest; s + windowMs <= latest + dayMs * 7; s += STEP_DAYS * dayMs) {
    results.push(simulateWindow(allEntries, s, s + windowMs));
  }
  console.log(`  ${results.length} windows simulated`);

  // Aggregate
  const finals = results.map((r) => r.final_equity).sort((a, b) => a - b);
  const at = (q: number) => finals[Math.min(finals.length - 1, Math.floor(q * finals.length))];
  const rate = (pred: (r: WindowResult) => boolean) => results.filter(pred).length / results.length;
  const mean = finals.reduce((s, v) => s + v, 0) / finals.length;
  const geo = Math.exp(finals.reduce((s, v) => s + Math.log(Math.max(1, v) / STARTING_BANKROLL), 0) / finals.length) * STARTING_BANKROLL;

  const fmt = (v: number) => `$${v.toFixed(0).padStart(5)} (${(((v / STARTING_BANKROLL) - 1) * 100).toFixed(1).padStart(6)}%)`;
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

  console.log("\n" + "=".repeat(90));
  console.log("LIVE M90 PORTFOLIO BACKTEST (against historical 90-day rolling windows)");
  console.log("=".repeat(90));
  console.log(`\nOUTCOME DISTRIBUTION:`);
  console.log(`  p5      = ${fmt(at(0.05))}`);
  console.log(`  p10     = ${fmt(at(0.10))}`);
  console.log(`  p25     = ${fmt(at(0.25))}`);
  console.log(`  median  = ${fmt(at(0.50))}`);
  console.log(`  p75     = ${fmt(at(0.75))}`);
  console.log(`  p90     = ${fmt(at(0.90))}`);
  console.log(`  p95     = ${fmt(at(0.95))}`);
  console.log(`  mean    = ${fmt(mean)}`);
  console.log(`  geomean = ${fmt(geo)}`);
  console.log(`\nPROBABILITIES:`);
  console.log(`  P(2x)        = ${pct(rate((r) => r.final_equity >= 2000))}`);
  console.log(`  P(3x)        = ${pct(rate((r) => r.final_equity >= 3000))}`);
  console.log(`  P(loss)      = ${pct(rate((r) => r.final_equity < 1000))}`);
  console.log(`  P(>30% loss) = ${pct(rate((r) => r.final_equity < 700))}`);
  console.log(`  P(killed)    = ${pct(rate((r) => r.killed))}`);

  // Per-agent breakdown
  console.log(`\nPER-AGENT ACTIVITY (across all windows):`);
  for (let ai = 0; ai < AGENTS.length; ai++) {
    const totalEntries = results.reduce((s, r) => s + r.agent_entries[ai], 0);
    const totalWins = results.reduce((s, r) => s + r.agent_wins[ai], 0);
    const totalLoss = results.reduce((s, r) => s + r.agent_losses[ai], 0);
    const wr = (totalWins + totalLoss) > 0 ? totalWins / (totalWins + totalLoss) : 0;
    const avgPerWindow = totalEntries / results.length;
    console.log(`  ${AGENTS[ai].name.padEnd(15)} entries=${totalEntries.toString().padStart(6)} (${avgPerWindow.toFixed(1)}/window)  wins=${totalWins.toString().padStart(5)}  losses=${totalLoss.toString().padStart(4)}  WR=${pct(wr)}`);
  }

  // Year-by-year
  console.log(`\nYEAR-BY-YEAR:`);
  const byYear: Record<string, WindowResult[]> = {};
  for (const r of results) {
    const y = new Date(r.start_ts).getUTCFullYear().toString();
    (byYear[y] = byYear[y] ?? []).push(r);
  }
  for (const y of Object.keys(byYear).sort()) {
    const rs = byYear[y];
    const yFin = rs.map((r) => r.final_equity).sort((a, b) => a - b);
    const med = yFin[Math.floor(yFin.length / 2)];
    const p2x = rs.filter((r) => r.final_equity >= 2000).length / rs.length;
    const pLoss = rs.filter((r) => r.final_equity < 1000).length / rs.length;
    const pKill = rs.filter((r) => r.killed).length / rs.length;
    console.log(`  ${y}: ${rs.length} windows, median=${fmt(med)}, P(2x)=${pct(p2x)}, P(loss)=${pct(pLoss)}, P(kill)=${pct(pKill)}`);
  }

  // Comparison
  console.log("\n" + "=".repeat(90));
  console.log("COMPARISON: MC sim (tracker numbers) vs HISTORICAL BACKTEST");
  console.log("=".repeat(90));
  console.log(`  metric    | MC sim 10K | backtest`);
  console.log(`  median    | $2,402     | ${fmt(at(0.50))}`);
  console.log(`  mean      | $2,?       | ${fmt(mean)}`);
  console.log(`  P(2x)     | 62.4%      | ${pct(rate((r) => r.final_equity >= 2000))}`);
  console.log(`  P(loss)   |  8.0%      | ${pct(rate((r) => r.final_equity < 1000))}`);
  console.log(`  P(kill)   |  ~6%       | ${pct(rate((r) => r.killed))}`);

  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
