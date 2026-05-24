// Backtest the CURRENTLY-DEPLOYED live portfolio against specific historical
// 90-day windows of real Polymarket data.
//
// Loads the 3 live agents from the DB (so it tracks exactly what's running),
// pulls every qualifying historical trade in each window, and runs a
// deterministic replay with mark-to-market killswitch.
//
// Run: tsx scripts/backtest-live-windows.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
import { resolve as pathResolve } from "path";
import { runWindow, fullKelly, type Entry, type EngineConfig, type AgentConfig, type PriceLookup } from "../src/lib/backtest-engine";
import { buildPriceCache, lookupPriceAt } from "../src/lib/price-cache";

const PROJECT_ROOT = pathResolve(__dirname, "..");
dotenv.config({ path: pathResolve(PROJECT_ROOT, ".env.local") });
const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

const STARTING_BANKROLL = 1000;
const KILLSWITCH_DD_PCT = 25;

const WINDOWS = [
  { label: "Window A: Nov 2025 -> Feb 2026", start: "2025-11-01T00:00:00Z", end: "2026-02-01T00:00:00Z" },
  { label: "Window B: Feb 2026 -> May 2026", start: "2026-02-01T00:00:00Z", end: "2026-05-01T00:00:00Z" },
];

type LiveAgent = AgentConfig & {
  price_min: number; price_max: number;
  htr_min: number; htr_max: number;
  mom_min: number; mom_max: number;
  spec_wr: number; spec_avg_price: number;
};

async function loadLiveAgents(): Promise<LiveAgent[]> {
  const rows = await sql<Array<{
    name: string; starting_bankroll: number; kelly_mult: number;
    max_pct_per_trade: number; max_concurrent_positions: number;
    strategy_spec_json: unknown;
  }>>`
    SELECT name, starting_bankroll, kelly_mult, max_pct_per_trade, max_concurrent_positions, strategy_spec_json
    FROM paper_agents WHERE status='active' ORDER BY starting_bankroll DESC
  `;
  if (rows.length === 0) throw new Error("no active live agents");
  const totalStart = rows.reduce((s, r) => s + Number(r.starting_bankroll), 0);
  return rows.map((r) => {
    const spec = typeof r.strategy_spec_json === "string"
      ? JSON.parse(r.strategy_spec_json) as Record<string, unknown>
      : r.strategy_spec_json as Record<string, unknown>;
    const price_min = Number(spec.price_min ?? 0);
    const price_max = Number(spec.price_max ?? 1);
    const spec_avg_price = (price_min + price_max) / 2;
    const spec_wr = typeof spec.wr_prior === "number" ? spec.wr_prior : 0.5;
    return {
      name: r.name,
      alloc_pct: Number(r.starting_bankroll) / totalStart,
      kelly_mult: Number(r.kelly_mult),
      max_pct_per_trade: Number(r.max_pct_per_trade),
      max_concurrent: Number(r.max_concurrent_positions),
      kelly_full: fullKelly(spec_wr, spec_avg_price),
      price_min, price_max,
      htr_min: Number(spec.hours_to_resolve_min ?? 0),
      htr_max: Number(spec.hours_to_resolve_max ?? 672),
      mom_min: Number(spec.mom_24h_min ?? -10),
      mom_max: Number(spec.mom_24h_max ?? 10),
      spec_wr, spec_avg_price,
    };
  });
}

async function loadEntriesForWindow(agents: LiveAgent[], startTs: number, endTs: number) {
  type Row = {
    agent_idx: number; ts: number; entry_price: number; duration_h: number;
    won: number; condition_id: string; outcome: string;
  };
  const all: Row[] = [];
  for (let ai = 0; ai < agents.length; ai++) {
    const a = agents[ai];
    const rows = await sql<Array<{ ts: number; entry_price: number; duration_h: number; won: number; condition_id: string; outcome: string }>>`
      SELECT DISTINCT ON (t.condition_id)
        t.ts::bigint AS ts,
        t.price::float8 AS entry_price,
        tf.hours_to_resolve::float8 AS duration_h,
        tf.won::int AS won,
        t.condition_id,
        t.outcome
      FROM trades t JOIN trade_features tf ON tf.trade_id = t.id
      WHERE t.side='BUY'
        AND t.price >= ${a.price_min} AND t.price <= ${a.price_max}
        AND tf.hours_to_resolve >= ${a.htr_min} AND tf.hours_to_resolve <= ${a.htr_max}
        AND tf.mom_24h >= ${a.mom_min} AND tf.mom_24h <= ${a.mom_max}
        AND t.ts >= ${startTs} AND t.ts < ${endTs}
      ORDER BY t.condition_id, t.ts ASC
    `;
    for (const r of rows) {
      all.push({
        agent_idx: ai,
        ts: Number(r.ts),
        entry_price: r.entry_price,
        duration_h: r.duration_h,
        won: r.won,
        condition_id: r.condition_id,
        outcome: r.outcome,
      });
    }
  }
  return all.sort((a, b) => a.ts - b.ts);
}

(async () => {
  console.log(`[backtest-live-windows] start ${new Date().toISOString()}\n`);
  const agents = await loadLiveAgents();
  console.log("Live agents loaded:");
  for (const a of agents) {
    console.log(`  ${a.name.padEnd(15)} alloc=${(a.alloc_pct * 100).toFixed(0)}% kelly=${a.kelly_mult}x wr_prior=${a.spec_wr.toFixed(3)} price=$${a.price_min}-$${a.price_max} htr=${a.htr_min}-${a.htr_max}h mom=[${a.mom_min},${a.mom_max}]`);
  }
  console.log("");

  for (const w of WINDOWS) {
    const startTs = new Date(w.start).getTime();
    const endTs = new Date(w.end).getTime();
    const days = (endTs - startTs) / (86400 * 1000);
    console.log(`${"=".repeat(120)}`);
    console.log(`${w.label}  (${days.toFixed(0)} days)`);
    console.log("=".repeat(120));

    const raw = await loadEntriesForWindow(agents, startTs, endTs);
    console.log(`Pulled ${raw.length} qualifying entries from Polymarket trade history.`);
    const byAgent = [0, 0, 0];
    for (const r of raw) byAgent[r.agent_idx]++;
    for (let i = 0; i < agents.length; i++) {
      console.log(`  ${agents[i].name}: ${byAgent[i]} entries`);
    }

    // Build price cache for MTM
    const uniqueCids = Array.from(new Set(raw.map((r) => r.condition_id)));
    const priceCache = await buildPriceCache(sql, uniqueCids);
    const priceLookup: PriceLookup = (cid, outc, ts) => lookupPriceAt(priceCache, cid, outc, ts);

    // Convert to engine Entry format
    const entries: Entry[] = raw.map((r) => ({
      agent_idx: r.agent_idx,
      entry_time_h: (r.ts - startTs) / 3600_000,
      entry_price: r.entry_price,
      duration_h: r.duration_h,
      won: (r.won === 1 ? 1 : 0),
      condition_id: r.condition_id,
      outcome: (r.outcome === "YES" ? "YES" : "NO") as "YES" | "NO",
    }));

    const engineCfg: EngineConfig = {
      agents,
      starting_bankroll: STARTING_BANKROLL,
      days: Math.ceil(days),
      killswitch_dd_pct: KILLSWITCH_DD_PCT,
      price_lookup: priceLookup,
      window_start_abs_ts: startTs,
    };

    const out = runWindow(entries, engineCfg);

    console.log(`\nResult:`);
    console.log(`  Final equity: $${out.final_equity.toFixed(2)} (${((out.final_equity / STARTING_BANKROLL - 1) * 100).toFixed(2)}%)`);
    console.log(`  Killswitch fired: ${out.killed ? `YES, on day ${out.killed_day}${out.killed_by_mtm ? " (via daily MTM check)" : " (via entry/settle event)"}` : "no"}`);
    console.log(`\nPer-agent activity:`);
    for (let i = 0; i < agents.length; i++) {
      const e = out.agent_entries[i];
      const w = out.agent_wins[i];
      const l = out.agent_losses[i];
      const settled = w + l;
      const wr = settled > 0 ? (w / settled) * 100 : 0;
      const pnl = out.agent_pnl[i];
      console.log(`  ${agents[i].name.padEnd(15)} entries=${e.toString().padStart(3)}  wins=${w.toString().padStart(3)}  losses=${l.toString().padStart(3)}  WR=${wr.toFixed(1).padStart(5)}%  net P&L=$${pnl.toFixed(2)} (${pnl >= 0 ? "+" : ""}${(pnl / (agents[i].alloc_pct * STARTING_BANKROLL) * 100).toFixed(1)}% on $${(agents[i].alloc_pct * STARTING_BANKROLL).toFixed(0)} alloc)`);
    }
    // Find max drawdown from trajectory
    let peak = STARTING_BANKROLL, maxDd = 0;
    for (const v of out.trajectory) {
      if (v > peak) peak = v;
      const dd = (peak - v) / peak * 100;
      if (dd > maxDd) maxDd = dd;
    }
    const lowFromStart = ((STARTING_BANKROLL - Math.min(...out.trajectory)) / STARTING_BANKROLL) * 100;
    console.log(`\nEquity behavior:`);
    console.log(`  Lowest point: $${Math.min(...out.trajectory).toFixed(2)} (down ${lowFromStart.toFixed(1)}% from start)`);
    console.log(`  Highest point: $${Math.max(...out.trajectory).toFixed(2)}`);
    console.log(`  Max peak-to-trough drawdown: ${maxDd.toFixed(1)}%`);

    // Sample trajectory at weekly intervals
    console.log(`\nEquity trajectory (weekly samples):`);
    const weekStep = 7;
    for (let d = 0; d <= out.trajectory.length - 1; d += weekStep) {
      const bar = "#".repeat(Math.max(1, Math.floor((out.trajectory[d] / STARTING_BANKROLL) * 20)));
      console.log(`  day ${d.toString().padStart(3)}: $${out.trajectory[d].toFixed(0).padStart(5)} ${bar}`);
    }
    if ((out.trajectory.length - 1) % weekStep !== 0) {
      const last = out.trajectory.length - 1;
      const bar = "#".repeat(Math.max(1, Math.floor((out.trajectory[last] / STARTING_BANKROLL) * 20)));
      console.log(`  day ${last.toString().padStart(3)}: $${out.trajectory[last].toFixed(0).padStart(5)} ${bar}`);
    }
    console.log("");
  }

  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
