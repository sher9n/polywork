// Backtest multiple candidate strategies on historical 5-day rolling windows.
// Each strategy: filter spec -> dedup to one entry per market -> run portfolio.
//
// Run: tsx scripts/backtest-candidates.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

const STARTING_BANKROLL = 1000;
const KILLSWITCH_DD_PCT = 25;
const WINDOW_DAYS = 5;
const STEP_DAYS = 1;

type Spec = {
  name: string;
  price_min: number; price_max: number;
  htr_min: number; htr_max: number;
  mom_min: number; mom_max: number;
  max_pct_per_trade: number;
  max_concurrent: number;
};

const CANDIDATES: Spec[] = [
  // The sim winner (low coverage, high edge per trade)
  { name: "A7_flat_premium",   price_min: 0.70, price_max: 0.75, htr_min: 2, htr_max: 24, mom_min: -0.02, mom_max: 0.02, max_pct_per_trade: 0.22, max_concurrent: 10 },
  // High-coverage candidates
  { name: "A1_near_skim",      price_min: 0.90, price_max: 0.95, htr_min: 1, htr_max: 120, mom_min: -10, mom_max: 10, max_pct_per_trade: 0.25, max_concurrent: 12 },
  { name: "B2_broad_skim",     price_min: 0.85, price_max: 0.95, htr_min: 1, htr_max: 72, mom_min: -10, mom_max: 10, max_pct_per_trade: 0.25, max_concurrent: 12 },
  { name: "B1_broad_premium",  price_min: 0.65, price_max: 0.80, htr_min: 2, htr_max: 48, mom_min: -0.05, mom_max: 0.05, max_pct_per_trade: 0.20, max_concurrent: 10 },
  { name: "A2_flash_heavy",    price_min: 0.80, price_max: 0.85, htr_min: 6, htr_max: 12, mom_min: -10, mom_max: 10, max_pct_per_trade: 0.25, max_concurrent: 8 },
  // Existing live agents (each tested alone for reference)
  { name: "ex_near_skim",      price_min: 0.90, price_max: 0.95, htr_min: 1, htr_max: 120, mom_min: -10, mom_max: 10, max_pct_per_trade: 0.25, max_concurrent: 12 },
  { name: "ex_rising_mid",     price_min: 0.40, price_max: 0.80, htr_min: 24, htr_max: 168, mom_min: 0.02, mom_max: 10, max_pct_per_trade: 0.18, max_concurrent: 16 },
];

type Market = { condition_id: string; entry_ts: number; entry_price: number; resolve_ts: number; won: number };

async function loadMarkets(spec: Spec): Promise<Market[]> {
  const rows = await sql<Array<{ condition_id: string; entry_ts: number; entry_price: number; duration_h: number; won: number }>>`
    SELECT DISTINCT ON (t.condition_id)
      t.condition_id,
      t.ts::bigint AS entry_ts,
      t.price::float8 AS entry_price,
      tf.hours_to_resolve::float8 AS duration_h,
      tf.won::int AS won
    FROM trades t JOIN trade_features tf ON tf.trade_id = t.id
    WHERE t.side='BUY'
      AND t.price >= ${spec.price_min} AND t.price <= ${spec.price_max}
      AND tf.hours_to_resolve >= ${spec.htr_min} AND tf.hours_to_resolve <= ${spec.htr_max}
      AND tf.mom_24h >= ${spec.mom_min} AND tf.mom_24h <= ${spec.mom_max}
    ORDER BY t.condition_id, t.ts ASC
  `;
  return rows.map((r) => ({
    condition_id: r.condition_id,
    entry_ts: Number(r.entry_ts),
    entry_price: r.entry_price,
    resolve_ts: Number(r.entry_ts) + r.duration_h * 3600_000,
    won: r.won,
  })).sort((a, b) => a.entry_ts - b.entry_ts);
}

type WindowResult = { start_ts: number; n_entries: number; n_wins: number; n_losses: number; final_equity: number; killed: boolean };

function backtest(spec: Spec, M: Market[]): WindowResult[] {
  const dayMs = 86400 * 1000;
  const windowMs = WINDOW_DAYS * dayMs;
  const earliest = M[0]?.entry_ts ?? Date.now();
  const latest = M[M.length - 1]?.entry_ts ?? Date.now();
  const results: WindowResult[] = [];

  for (let start = earliest - dayMs; start + windowMs <= latest + dayMs * 30; start += STEP_DAYS * dayMs) {
    const end = start + windowMs;
    const inWindow = M.filter((m) => m.entry_ts >= start && m.entry_ts < end);

    let cash = STARTING_BANKROLL, killed = false;
    type OpenPos = { stake: number; payoff_if_win: number; resolve_ts: number; won: number };
    const open: OpenPos[] = [];
    let nEntries = 0, nWins = 0, nLosses = 0;
    let i = 0;

    while (true) {
      // Decide next event
      let nextTs = Infinity, kind: "entry" | "settle" = "entry", idx = -1;
      if (i < inWindow.length) { nextTs = inWindow[i].entry_ts; kind = "entry"; idx = i; }
      for (let j = 0; j < open.length; j++) {
        if (open[j].resolve_ts < nextTs && open[j].resolve_ts <= end) {
          nextTs = open[j].resolve_ts; kind = "settle"; idx = j;
        }
      }
      if (nextTs === Infinity || nextTs > end) break;

      if (kind === "settle") {
        const o = open[idx];
        if (o.won === 1) { cash += o.payoff_if_win; nWins++; } else { nLosses++; }
        open.splice(idx, 1);
      } else {
        const m = inWindow[idx]; i++;
        if (open.length >= spec.max_concurrent || cash < 1) continue;
        const stake = Math.min(cash * spec.max_pct_per_trade, cash * 0.95);
        if (stake < 0.5) continue;
        const payoff = stake * (1 + (1 - m.entry_price) / m.entry_price);
        open.push({ stake, payoff_if_win: payoff, resolve_ts: m.resolve_ts, won: m.won });
        cash -= stake;
        nEntries++;
      }
      const eq = cash + open.reduce((s, p) => s + p.stake, 0);
      if (((STARTING_BANKROLL - eq) / STARTING_BANKROLL) * 100 >= KILLSWITCH_DD_PCT) { killed = true; break; }
    }
    // Settle anything within window
    for (const o of open) {
      if (o.resolve_ts <= end) {
        if (o.won === 1) { cash += o.payoff_if_win; nWins++; } else { nLosses++; }
      }
    }
    const finalEquity = cash + open.filter((o) => o.resolve_ts > end).reduce((s, o) => s + o.stake, 0);
    results.push({ start_ts: start, n_entries: nEntries, n_wins: nWins, n_losses: nLosses, final_equity: finalEquity, killed });
  }
  return results;
}

function summarize(spec: Spec, results: WindowResult[]) {
  const withTrades = results.filter((r) => r.n_entries > 0);
  const finals = results.map((r) => r.final_equity).sort((a, b) => a - b);
  const at = (q: number) => finals[Math.min(finals.length - 1, Math.floor(q * finals.length))];
  const rate = (pred: (r: WindowResult) => boolean) => results.filter(pred).length / results.length;
  const mean = finals.reduce((s, v) => s + v, 0) / finals.length;
  const totalWins = results.reduce((s, r) => s + r.n_wins, 0);
  const totalLoss = results.reduce((s, r) => s + r.n_losses, 0);
  const wr = (totalWins + totalLoss) > 0 ? totalWins / (totalWins + totalLoss) : 0;
  return {
    name: spec.name,
    n_windows: results.length,
    n_active: withTrades.length,
    coverage_pct: withTrades.length / results.length,
    avg_entries: withTrades.length > 0 ? withTrades.reduce((s, r) => s + r.n_entries, 0) / withTrades.length : 0,
    realized_wr: wr,
    median: at(0.5),
    mean,
    p10: at(0.10),
    p90: at(0.90),
    p_double: rate((r) => r.final_equity >= 2000),
    p_loss: rate((r) => r.final_equity < 1000),
    p_kill: rate((r) => r.killed),
  };
}

(async () => {
  console.log(`backtesting ${CANDIDATES.length} candidate strategies on 5-day rolling windows...\n`);
  const summaries: ReturnType<typeof summarize>[] = [];
  for (const spec of CANDIDATES) {
    const M = await loadMarkets(spec);
    console.log(`  ${spec.name.padEnd(20)} - ${M.length} markets`);
    const results = backtest(spec, M);
    summaries.push(summarize(spec, results));
  }
  console.log("");

  console.log("=".repeat(150));
  console.log("CANDIDATE BACKTEST SUMMARY (5-day rolling windows, market-level dedup)");
  console.log("=".repeat(150));
  const fmt = (v: number) => `$${v.toFixed(0).padStart(5)}`;
  const pct = (x: number) => `${(x * 100).toFixed(1).padStart(5)}%`;
  console.log(`${"strategy".padEnd(20)} ${"windows".padStart(8)} ${"active".padStart(7)} ${"coverage".padStart(9)} ${"avg/win".padStart(8)} ${"WR".padStart(6)} ${"median".padStart(7)} ${"mean".padStart(6)} ${"p10".padStart(6)} ${"p90".padStart(7)} ${"P(2x)".padStart(6)} ${"P(loss)".padStart(7)} ${"P(kill)".padStart(7)}`);
  console.log("-".repeat(150));
  const sorted = [...summaries].sort((a, b) => b.mean - a.mean);
  for (const s of sorted) {
    console.log(`${s.name.padEnd(20)} ${s.n_windows.toString().padStart(8)} ${s.n_active.toString().padStart(7)} ${pct(s.coverage_pct)} ${s.avg_entries.toFixed(2).padStart(8)} ${pct(s.realized_wr)} ${fmt(s.median)} ${fmt(s.mean)} ${fmt(s.p10)} ${fmt(s.p90)} ${pct(s.p_double)} ${pct(s.p_loss)} ${pct(s.p_kill)}`);
  }

  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
