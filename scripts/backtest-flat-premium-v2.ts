// Backtest M5 winner with MARKET-LEVEL dedup. The trades table has multiple
// fills per market; an agent enters each qualifying market once.
//
// Strategy: BUY when price [0.70, 0.75], hours_to_resolve [2, 24], mom_24h flat.
// Entry per market: at the first qualifying trade signal.
// Outcome: market resolved YES (won=1) or NO (won=0).
// Sizing: 22% of current bankroll (Kelly capped by max_pct_per_trade).
// Caps: max 10 concurrent.
//
// Run: tsx scripts/backtest-flat-premium-v2.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

const STARTING_BANKROLL = 1000;
const KILLSWITCH_DD_PCT = 25;
const MAX_PCT_PER_TRADE = 0.22;
const MAX_CONCURRENT = 10;
const WINDOW_DAYS = 5;
const STEP_DAYS = 1;

(async () => {
  console.log("loading qualifying markets (first qualifying trade per market) ...");
  const markets = await sql<Array<{ condition_id: string; entry_ts: number; entry_price: number; duration_h: number; won: number; resolution_ts: number }>>`
    SELECT DISTINCT ON (t.condition_id)
      t.condition_id,
      t.ts::bigint AS entry_ts,
      t.price::float8 AS entry_price,
      tf.hours_to_resolve::float8 AS duration_h,
      tf.won::int AS won,
      (t.ts + (tf.hours_to_resolve * 3600 * 1000)::bigint)::bigint AS resolution_ts
    FROM trades t JOIN trade_features tf ON tf.trade_id = t.id
    WHERE t.side='BUY'
      AND t.price >= 0.70 AND t.price <= 0.75
      AND tf.hours_to_resolve >= 2 AND tf.hours_to_resolve <= 24
      AND tf.mom_24h >= -0.02 AND tf.mom_24h <= 0.02
    ORDER BY t.condition_id, t.ts ASC
  `;
  console.log(`  ${markets.length} distinct qualifying markets`);

  const M = markets.map((m) => ({
    condition_id: m.condition_id,
    entry_ts: Number(m.entry_ts),
    entry_price: m.entry_price,
    duration_h: m.duration_h,
    won: m.won,
    resolution_ts: Number(m.resolution_ts),
  })).sort((a, b) => a.entry_ts - b.entry_ts);

  const earliest = M[0].entry_ts;
  const latest = M[M.length - 1].entry_ts;
  const dayMs = 86400 * 1000;
  const windowMs = WINDOW_DAYS * dayMs;
  const totalDays = Math.floor((latest - earliest) / dayMs);

  console.log(`data span: ${new Date(earliest).toISOString().slice(0, 10)} to ${new Date(latest).toISOString().slice(0, 10)} (${totalDays} days)`);
  console.log(`window size: ${WINDOW_DAYS}d, step: ${STEP_DAYS}d\n`);
  console.log(`overall realized market WR: ${(M.filter(m => m.won === 1).length / M.length * 100).toFixed(1)}%\n`);

  type WindowResult = {
    start_ts: number;
    n_entries: number;
    n_wins: number;
    n_losses: number;
    n_open_at_end: number;
    final_equity: number;
    killed: boolean;
  };
  const results: WindowResult[] = [];

  for (let start = earliest - dayMs; start + windowMs <= latest + dayMs * 30; start += STEP_DAYS * dayMs) {
    const end = start + windowMs;
    const inWindow = M.filter((m) => m.entry_ts >= start && m.entry_ts < end);

    let cash = STARTING_BANKROLL;
    let killed = false;
    type OpenPos = { stake: number; payoff_if_win: number; resolve_ts: number; won: number };
    const open: OpenPos[] = [];
    let nEntries = 0, nWins = 0, nLosses = 0;

    // Process entries chronologically, interleaving with settlements
    const events: Array<{ ts: number; kind: "entry"; idx: number } | { ts: number; kind: "settle"; pos_idx: number }> = [];
    for (let i = 0; i < inWindow.length; i++) events.push({ ts: inWindow[i].entry_ts, kind: "entry", idx: i });

    let i = 0;
    while (i < events.length || open.some((o) => o.resolve_ts < end)) {
      // Find the next event time: next entry or earliest open-position resolution
      let nextEventTs = Infinity;
      let nextKind: "entry" | "settle" = "entry";
      let nextIdx = -1;
      if (i < events.length) {
        nextEventTs = events[i].ts;
        nextKind = "entry";
        nextIdx = i;
      }
      for (let j = 0; j < open.length; j++) {
        if (open[j].resolve_ts < nextEventTs && open[j].resolve_ts <= end) {
          nextEventTs = open[j].resolve_ts;
          nextKind = "settle";
          nextIdx = j;
        }
      }
      if (nextEventTs === Infinity) break;
      if (nextEventTs > end) break;

      if (nextKind === "settle") {
        const o = open[nextIdx];
        if (o.won === 1) { cash += o.payoff_if_win; nWins++; }
        else { nLosses++; }
        open.splice(nextIdx, 1);
        const eq = cash + open.reduce((s, p) => s + p.stake, 0);
        if (((STARTING_BANKROLL - eq) / STARTING_BANKROLL) * 100 >= KILLSWITCH_DD_PCT) { killed = true; break; }
      } else {
        // Entry
        const m = inWindow[(events[i] as { ts: number; kind: "entry"; idx: number }).idx];
        i++;
        if (open.length >= MAX_CONCURRENT) continue;
        if (cash < 1) continue;
        const stake = Math.min(cash * MAX_PCT_PER_TRADE, cash * 0.95);
        if (stake < 0.5) continue;
        const payoff_if_win = stake * (1 + (1 - m.entry_price) / m.entry_price);
        open.push({ stake, payoff_if_win, resolve_ts: m.resolution_ts, won: m.won });
        cash -= stake;
        nEntries++;
        const eq = cash + open.reduce((s, p) => s + p.stake, 0);
        if (((STARTING_BANKROLL - eq) / STARTING_BANKROLL) * 100 >= KILLSWITCH_DD_PCT) { killed = true; break; }
      }
    }

    // Settle anything resolving within the window after the loop ends
    const stillOpen: OpenPos[] = [];
    for (const o of open) {
      if (o.resolve_ts <= end) {
        if (o.won === 1) { cash += o.payoff_if_win; nWins++; }
        else { nLosses++; }
      } else stillOpen.push(o);
    }

    const finalEquity = cash + stillOpen.reduce((s, o) => s + o.stake, 0);
    results.push({
      start_ts: start, n_entries: nEntries, n_wins: nWins, n_losses: nLosses,
      n_open_at_end: stillOpen.length, final_equity: finalEquity, killed,
    });
  }

  const withTrades = results.filter((r) => r.n_entries > 0);
  const finals = results.map((r) => r.final_equity).sort((a, b) => a - b);
  const at = (q: number) => finals[Math.min(finals.length - 1, Math.floor(q * finals.length))];
  const rate = (pred: (r: WindowResult) => boolean) => results.filter(pred).length / results.length;
  const mean = finals.reduce((s, v) => s + v, 0) / finals.length;
  const geo = Math.exp(finals.reduce((s, v) => s + Math.log(Math.max(1, v) / STARTING_BANKROLL), 0) / finals.length) * STARTING_BANKROLL;

  const fmt = (v: number) => `$${v.toFixed(0).padStart(5)} (${(((v / STARTING_BANKROLL) - 1) * 100).toFixed(1).padStart(6)}%)`;

  console.log("=".repeat(80));
  console.log("BACKTEST V2 - market-level dedup, 5d rolling windows");
  console.log("=".repeat(80));
  console.log(`total windows:        ${results.length.toLocaleString()}`);
  console.log(`windows w/ entries:   ${withTrades.length}  (${(withTrades.length / results.length * 100).toFixed(1)}%)`);
  console.log(`windows empty:        ${results.length - withTrades.length}  (${(1 - withTrades.length / results.length) * 100}%)`);
  console.log(`avg entries per active window: ${(withTrades.reduce((s, r) => s + r.n_entries, 0) / withTrades.length).toFixed(2)}`);
  console.log(`total entries / wins / losses: ${results.reduce((s, r) => s + r.n_entries, 0)} / ${results.reduce((s, r) => s + r.n_wins, 0)} / ${results.reduce((s, r) => s + r.n_losses, 0)}`);
  const totalWinsBT = results.reduce((s, r) => s + r.n_wins, 0);
  const totalLossesBT = results.reduce((s, r) => s + r.n_losses, 0);
  console.log(`realized WR (settled trades): ${((totalWinsBT / (totalWinsBT + totalLossesBT)) * 100).toFixed(2)}%`);
  console.log("");
  console.log("OUTCOME DISTRIBUTION (all windows)");
  console.log("-".repeat(80));
  console.log(`  p5      = ${fmt(at(0.05))}`);
  console.log(`  p10     = ${fmt(at(0.10))}`);
  console.log(`  p25     = ${fmt(at(0.25))}`);
  console.log(`  median  = ${fmt(at(0.50))}`);
  console.log(`  p75     = ${fmt(at(0.75))}`);
  console.log(`  p90     = ${fmt(at(0.90))}`);
  console.log(`  p95     = ${fmt(at(0.95))}`);
  console.log(`  mean    = ${fmt(mean)}`);
  console.log(`  geomean = ${fmt(geo)}`);
  console.log("");
  console.log("PROBABILITIES (over all windows)");
  console.log("-".repeat(80));
  console.log(`  P(2x)        = ${(rate((r) => r.final_equity >= 2000) * 100).toFixed(2)}%`);
  console.log(`  P(3x)        = ${(rate((r) => r.final_equity >= 3000) * 100).toFixed(2)}%`);
  console.log(`  P(loss)      = ${(rate((r) => r.final_equity < 1000) * 100).toFixed(2)}%`);
  console.log(`  P(>30% loss) = ${(rate((r) => r.final_equity < 700) * 100).toFixed(2)}%`);
  console.log(`  P(killed)    = ${(rate((r) => r.killed) * 100).toFixed(2)}%`);
  console.log(`  P(empty win) = ${((results.length - withTrades.length) / results.length * 100).toFixed(2)}%`);
  console.log("");
  if (withTrades.length > 0) {
    const wFinals = withTrades.map((r) => r.final_equity).sort((a, b) => a - b);
    const atW = (q: number) => wFinals[Math.min(wFinals.length - 1, Math.floor(q * wFinals.length))];
    const rateW = (pred: (r: WindowResult) => boolean) => withTrades.filter(pred).length / withTrades.length;
    console.log("WITH-ENTRIES ONLY (excludes 'flat' windows)");
    console.log("-".repeat(80));
    console.log(`  median  = ${fmt(atW(0.50))}`);
    console.log(`  p10     = ${fmt(atW(0.10))}`);
    console.log(`  p90     = ${fmt(atW(0.90))}`);
    console.log(`  P(2x)   = ${(rateW((r) => r.final_equity >= 2000) * 100).toFixed(2)}%`);
    console.log(`  P(loss) = ${(rateW((r) => r.final_equity < 1000) * 100).toFixed(2)}%`);
    console.log("");
  }
  // Year breakdown
  const byYear: Record<string, WindowResult[]> = {};
  for (const r of results) {
    const y = new Date(r.start_ts).getUTCFullYear().toString();
    byYear[y] = byYear[y] ?? [];
    byYear[y].push(r);
  }
  console.log("YEAR-BY-YEAR");
  console.log("-".repeat(80));
  for (const y of Object.keys(byYear).sort()) {
    const rs = byYear[y];
    const yFinals = rs.map((r) => r.final_equity).sort((a, b) => a - b);
    const med = yFinals[Math.floor(yFinals.length / 2)];
    const wt = rs.filter((r) => r.n_entries > 0).length;
    const p2x = rs.filter((r) => r.final_equity >= 2000).length / rs.length;
    const pLoss = rs.filter((r) => r.final_equity < 1000).length / rs.length;
    const yWins = rs.reduce((s, r) => s + r.n_wins, 0);
    const yLoss = rs.reduce((s, r) => s + r.n_losses, 0);
    const yWr = (yWins + yLoss) > 0 ? yWins / (yWins + yLoss) : 0;
    console.log(`  ${y}: ${rs.length} windows, ${wt} active, WR=${(yWr*100).toFixed(1)}%, median=${fmt(med)}, P(2x)=${(p2x*100).toFixed(1)}%, P(loss)=${(pLoss*100).toFixed(1)}%`);
  }
  console.log("");
  console.log("FINAL COMPARISON  (sim 100K M5 vs market-level historical backtest)");
  console.log("-".repeat(80));
  console.log(`  metric    | sim       | backtest`);
  console.log(`  median    | $2,165    | ${fmt(at(0.50))}`);
  console.log(`  mean      | $2,159    | ${fmt(mean)}`);
  console.log(`  P(2x)     | 59.2%     | ${(rate((r) => r.final_equity >= 2000) * 100).toFixed(1)}%`);
  console.log(`  P(loss)   | 7.4%      | ${(rate((r) => r.final_equity < 1000) * 100).toFixed(1)}%`);
  console.log(`  P(kill)   | 5.2%      | ${(rate((r) => r.killed) * 100).toFixed(1)}%`);

  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
