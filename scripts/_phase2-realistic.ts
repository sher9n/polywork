// Phase 2 redo with REALISTIC friction parameters:
//   - Polymarket fee on winnings: 0% (CLOB has no trading fee)
//   - Slippage: 0.1% (liquid markets have tight spreads)
//   - Lag: 0 (assumes WebSocket activated)
// Plus comparison against the prior CONSERVATIVE friction so we see the spread.

import postgres from "postgres";
import * as dotenv from "dotenv";
import { runWindow, fullKelly, type Entry, type EngineConfig, type AgentConfig, type PriceLookup } from "../src/lib/backtest-engine";
import { buildPriceCache, lookupPriceAt } from "../src/lib/price-cache";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

const STARTING_BANKROLL = 1000;
const KILLSWITCH_DD_PCT = 50;
const MS_PER_DAY = 86400 * 1000;
const NOW_MS = Date.now();
const WINDOW_DAYS = 90;
const ROLL_START_MS = new Date("2024-08-01T00:00:00Z").getTime();
const ROLL_END_MS = NOW_MS - WINDOW_DAYS * MS_PER_DAY;
const PRIOR_BUFFER_DAYS = 180;
const MIN_PRIOR_SAMPLES = 20;
const DEFAULT_PRIOR_WR = 0.5;
const POCKET_PIN_THRESHOLD = 0.98;
const MIN_PRE_VOL_24H_USD = 5000;

type Cell = { name: string; alloc_pct: number; price_min: number; price_max: number; mom_min: number; mom_max: number; htr_min: number; htr_max: number; size_min: number; size_max: number; max_pct_per_trade: number; max_concurrent: number; spec_wr_prior: number };

const CURRENT: Cell[] = [
  { name: "r1_longmid_any_dayplus_large", alloc_pct: 0.25, price_min: 0.30, price_max: 0.35, mom_min: -10,   mom_max: 10,  htr_min: 24, htr_max: 72,    size_min: 200, size_max: 9e12, max_pct_per_trade: 0.10, max_concurrent: 10, spec_wr_prior: 0.523 },
  { name: "r3_midfav_rising_day_any",     alloc_pct: 0.25, price_min: 0.55, price_max: 0.60, mom_min: 0.02,  mom_max: 10,  htr_min: 6,  htr_max: 24,    size_min: 0,   size_max: 9e12, max_pct_per_trade: 0.15, max_concurrent: 10, spec_wr_prior: 0.792 },
  { name: "r7_midfav_rising_slow_large",  alloc_pct: 0.25, price_min: 0.50, price_max: 0.55, mom_min: 0.02,  mom_max: 10,  htr_min: 72, htr_max: 99999, size_min: 200, size_max: 9e12, max_pct_per_trade: 0.15, max_concurrent: 10, spec_wr_prior: 0.626 },
  { name: "r9_heavyfav_flat_slow_large",  alloc_pct: 0.25, price_min: 0.70, price_max: 0.75, mom_min: -0.02, mom_max: 0.02, htr_min: 72, htr_max: 99999, size_min: 200, size_max: 9e12, max_pct_per_trade: 0.20, max_concurrent: 10, spec_wr_prior: 0.833 },
];

const PROPOSED: Cell[] = [
  { name: "midfav_any_fast_large",        alloc_pct: 0.30, price_min: 0.40, price_max: 0.45, mom_min: -10,   mom_max: 10,  htr_min: 0, htr_max: 6,     size_min: 200, size_max: 9e12, max_pct_per_trade: 0.15, max_concurrent: 10, spec_wr_prior: 0.470 },
  { name: "midhigh_any_fast_large",       alloc_pct: 0.25, price_min: 0.60, price_max: 0.65, mom_min: -10,   mom_max: 10,  htr_min: 0, htr_max: 6,     size_min: 200, size_max: 9e12, max_pct_per_trade: 0.15, max_concurrent: 10, spec_wr_prior: 0.653 },
  { name: "heavyfav_rising_slow_any",     alloc_pct: 0.25, price_min: 0.75, price_max: 0.80, mom_min: 0.02,  mom_max: 10,  htr_min: 72, htr_max: 99999, size_min: 0,   size_max: 9e12, max_pct_per_trade: 0.20, max_concurrent: 10, spec_wr_prior: 0.820 },
  { name: "veryfav_falling_slow_large",   alloc_pct: 0.20, price_min: 0.80, price_max: 0.85, mom_min: -10,   mom_max: -0.02, htr_min: 72, htr_max: 99999, size_min: 200, size_max: 9e12, max_pct_per_trade: 0.20, max_concurrent: 10, spec_wr_prior: 0.911 },
];

type Trade = { ts: number; price: number; size: number; resolution_ts: number; won: 0 | 1; condition_id: string; outcome: "YES" | "NO" };

async function loadTradesForCell(c: Cell): Promise<Trade[]> {
  const ts_min = ROLL_START_MS - PRIOR_BUFFER_DAYS * MS_PER_DAY;
  const anyMom = c.mom_min <= -10 && c.mom_max >= 10;
  const rows = await sql<Array<{ ts: number; price: number; size: number; resolution_ts: number; won: number; condition_id: string; outcome: string }>>`
    WITH eligible AS (
      SELECT t.id, t.condition_id, t.ts::bigint AS ts, t.price::float8 AS price, t.size::float8 AS size,
        m.resolution_ts::bigint AS resolution_ts, tf.won::int AS won, t.outcome,
        COALESCE(
          SUM(t.price * t.size) OVER (
            PARTITION BY t.condition_id ORDER BY t.ts
            RANGE BETWEEN 86400000 PRECEDING AND CURRENT ROW
          ) - (t.price * t.size), 0
        )::float8 AS pre_vol_24h
      FROM trades t JOIN trade_features tf ON tf.trade_id = t.id JOIN markets m ON m.condition_id = t.condition_id
      WHERE t.side = 'BUY'
        AND t.price >= ${c.price_min} AND t.price < ${c.price_max}
        AND (${anyMom}::boolean OR (COALESCE(tf.mom_24h, tf.mom_6h, tf.mom_1h) BETWEEN ${c.mom_min} AND ${c.mom_max}))
        AND t.size >= ${c.size_min} AND t.size < ${c.size_max}
        AND m.end_date IS NOT NULL AND m.resolution_ts IS NOT NULL
        AND t.ts >= ${ts_min}
        AND (EXTRACT(EPOCH FROM m.end_date) * 1000 - t.ts) / 3600000.0 BETWEEN ${c.htr_min} AND ${c.htr_max}
    )
    SELECT DISTINCT ON (condition_id) ts, price, size, resolution_ts, won, condition_id, outcome
    FROM eligible WHERE pre_vol_24h >= ${MIN_PRE_VOL_24H_USD}
    ORDER BY condition_id, ts ASC
  `;
  return rows.map((r) => ({ ts: Number(r.ts), price: r.price, size: r.size, resolution_ts: Number(r.resolution_ts), won: r.won === 1 ? 1 : 0, condition_id: r.condition_id, outcome: (r.outcome === "YES" ? "YES" : "NO") as "YES" | "NO" })).sort((a, b) => a.ts - b.ts);
}

function walkForwardPrior(trades: Trade[], windowStartMs: number): number {
  let n = 0, w = 0;
  for (const t of trades) { if (t.ts >= windowStartMs) break; n++; w += t.won; }
  if (n < MIN_PRIOR_SAMPLES) return DEFAULT_PRIOR_WR;
  return w / n;
}

type FrictionConfig = { label: string; lag_ms: number; slippage: number; fee: number };

const FRICTION_CONFIGS: FrictionConfig[] = [
  { label: "CONSERVATIVE (old)",   lag_ms: 4 * 60_000, slippage: 0.005, fee: 0.02 },
  { label: "REALISTIC (polling)",  lag_ms: 4 * 60_000, slippage: 0.001, fee: 0    },
  { label: "REALISTIC (WS on)",    lag_ms: 0,          slippage: 0.001, fee: 0    },
];

async function runVariant(label: string, cells: Cell[], allTrades: Map<string, Trade[]>, friction: FrictionConfig): Promise<{ median: number; mean: number; pPos: number; pDouble: number; pKill: number; worst: number; best: number; avgEntries: number; perCell: Array<{ name: string; entries: number; wr: number; pnl_per_window: number }> }> {
  const cellTrades = cells.map((c) => allTrades.get(c.name)!);
  const allCids = new Set<string>();
  for (const tlist of cellTrades) for (const t of tlist) allCids.add(t.condition_id);
  const priceCache = await buildPriceCache(sql, Array.from(allCids));
  const priceLookup: PriceLookup = (cid, outc, ts) => lookupPriceAt(priceCache, cid, outc, ts);

  const windowStarts: number[] = [];
  for (let ts = ROLL_START_MS; ts <= ROLL_END_MS; ts += MS_PER_DAY) windowStarts.push(ts);

  const results: Array<{ return_pct: number; killed: boolean; agent_entries: number[]; agent_wins: number[]; agent_losses: number[]; agent_pnl: number[] }> = [];
  for (const ws of windowStarts) {
    const we = ws + WINDOW_DAYS * MS_PER_DAY;
    const entries: Entry[] = [];
    for (let ci = 0; ci < cells.length; ci++) {
      const trades = cellTrades[ci];
      const seen = new Set<string>();
      for (const t of trades) {
        const laggedTs = t.ts + friction.lag_ms;
        if (laggedTs < ws) continue;
        if (laggedTs >= we) break;
        if (seen.has(t.condition_id)) continue;
        if (t.resolution_ts <= laggedTs) continue;
        seen.add(t.condition_id);
        entries.push({ agent_idx: ci, entry_time_h: (laggedTs - ws) / 3600_000, entry_price: t.price, duration_h: Math.max(0.01, (t.resolution_ts - laggedTs) / 3600_000), won: t.won, condition_id: t.condition_id, outcome: t.outcome, abs_entry_ts: laggedTs });
      }
    }
    entries.sort((a, b) => a.entry_time_h - b.entry_time_h);

    const agents: AgentConfig[] = cells.map((c, ci) => {
      const wr = walkForwardPrior(cellTrades[ci], ws);
      const usedWr = wr === DEFAULT_PRIOR_WR ? c.spec_wr_prior : wr;
      const avgPx = (c.price_min + c.price_max) / 2;
      return { name: c.name, alloc_pct: c.alloc_pct, kelly_full: fullKelly(usedWr, avgPx), kelly_mult: 1.0, max_pct_per_trade: c.max_pct_per_trade, max_concurrent: c.max_concurrent, live_mimicry: true, spec_wr_prior: c.spec_wr_prior, avg_entry_price: avgPx };
    });
    const cfg: EngineConfig = {
      agents, starting_bankroll: STARTING_BANKROLL, days: WINDOW_DAYS, killswitch_dd_pct: KILLSWITCH_DD_PCT,
      price_lookup: priceLookup, window_start_abs_ts: ws,
      pocket_enabled: true, pocket_pin_threshold: POCKET_PIN_THRESHOLD,
      entry_slippage_pct: friction.slippage, fee_on_winnings_pct: friction.fee,
      auto_pause_enabled: false,
    };
    const out = runWindow(entries, cfg);
    results.push({ return_pct: (out.final_equity / STARTING_BANKROLL - 1) * 100, killed: out.killed, agent_entries: out.agent_entries, agent_wins: out.agent_wins, agent_losses: out.agent_losses, agent_pnl: out.agent_pnl });
  }

  const returns = results.map(r => r.return_pct).sort((a, b) => a - b);
  const perCell = cells.map((c, ci) => {
    const te = results.reduce((s, r) => s + r.agent_entries[ci], 0);
    const tw = results.reduce((s, r) => s + r.agent_wins[ci], 0);
    const tl = results.reduce((s, r) => s + r.agent_losses[ci], 0);
    const tp = results.reduce((s, r) => s + r.agent_pnl[ci], 0);
    return { name: c.name, entries: te, wr: (tw + tl) > 0 ? tw / (tw + tl) : 0, pnl_per_window: tp / results.length };
  });
  return {
    median: returns[Math.floor(returns.length / 2)],
    mean: returns.reduce((s, x) => s + x, 0) / returns.length,
    pPos: results.filter(r => r.return_pct > 0).length / results.length,
    pDouble: results.filter(r => r.return_pct >= 100).length / results.length,
    pKill: results.filter(r => r.killed).length / results.length,
    worst: returns[0],
    best: returns[returns.length - 1],
    avgEntries: results.reduce((s, r) => s + r.agent_entries.reduce((a, b) => a + b, 0), 0) / results.length,
    perCell,
  };
}

(async () => {
  const allCellNames = new Map<string, Cell>();
  for (const c of CURRENT) allCellNames.set(c.name, c);
  for (const c of PROPOSED) allCellNames.set(c.name, c);
  const allTrades = new Map<string, Trade[]>();
  for (const [name, cell] of allCellNames) {
    const tr = await loadTradesForCell(cell);
    allTrades.set(name, tr);
  }

  console.log("\n=== Phase 2 across 3 friction profiles (566 windows, $5K liquidity filter, auto-pause OFF) ===\n");
  console.log(`${"Profile".padEnd(30)} ${"Portfolio".padEnd(12)}  median   mean   P(pos)  P(2x)  worst   best     entries`);
  console.log("─".repeat(110));

  type FullResult = { profile: string; portfolio: string; r: Awaited<ReturnType<typeof runVariant>> };
  const all: FullResult[] = [];
  for (const f of FRICTION_CONFIGS) {
    for (const [pname, cells] of [["CURRENT", CURRENT], ["PROPOSED", PROPOSED]] as const) {
      const r = await runVariant(`${f.label} / ${pname}`, cells, allTrades, f);
      all.push({ profile: f.label, portfolio: pname, r });
      console.log(`${f.label.padEnd(30)} ${pname.padEnd(12)}  ${(r.median.toFixed(1)+'%').padStart(6)}  ${(r.mean.toFixed(1)+'%').padStart(5)}  ${(r.pPos*100).toFixed(1).padStart(4)}%  ${(r.pDouble*100).toFixed(2).padStart(4)}%  ${r.worst.toFixed(1).padStart(5)}%  ${r.best.toFixed(1).padStart(5)}%  ${r.avgEntries.toFixed(1)}`);
    }
  }

  console.log("\nPer-cell P&L across profiles (per window, in $):\n");
  for (const portfolio of ["CURRENT", "PROPOSED"]) {
    const portfolioRuns = all.filter(x => x.portfolio === portfolio);
    console.log(`${portfolio}:`);
    const cellNames = portfolioRuns[0].r.perCell.map(c => c.name);
    console.log(`  ${"cell".padEnd(38)} ${FRICTION_CONFIGS.map(f => f.label.padStart(22)).join(" ")}`);
    for (const cellName of cellNames) {
      const row = portfolioRuns.map(p => {
        const c = p.r.perCell.find(cc => cc.name === cellName)!;
        return ((c.pnl_per_window >= 0 ? "+" : "") + c.pnl_per_window.toFixed(2)).padStart(22);
      }).join(" ");
      console.log(`  ${cellName.padEnd(38)} ${row}`);
    }
    console.log("");
  }
  await sql.end();
})().catch(e => { console.error(e); process.exit(1); });
