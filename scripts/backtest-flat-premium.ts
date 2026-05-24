// Backtest the M5 winner against actual historical 5-day windows.
// Strategy: BUY when price in [0.70, 0.75], hours_to_resolve in [2, 24],
//           24h momentum in [-0.02, 0.02] (flat).
// Sizing: min(Kelly@0.70x, max_pct_per_trade=22%) of current bankroll.
// Caps: max 10 concurrent open positions.
//
// Run: tsx scripts/backtest-flat-premium.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

const STARTING_BANKROLL = 1000;
const KILLSWITCH_DD_PCT = 25;
const MAX_PCT_PER_TRADE = 0.22;
const MAX_CONCURRENT = 10;
const WINDOW_DAYS = 5;
const STEP_DAYS = 1; // rolling 1-day step

// Strategy parameters (from the grid search winner)
const PRICE_MIN = 0.70, PRICE_MAX = 0.75;
const HTR_MIN_H = 2, HTR_MAX_H = 24;
const MOM_MIN = -0.02, MOM_MAX = 0.02;
const SPEC_WR = 0.91;
const SPEC_AVG_PRICE = 0.725;
const SPEC_PAYOFF_RATIO = (1 - SPEC_AVG_PRICE) / SPEC_AVG_PRICE;
const KELLY_MULT = 0.70;
const FULL_KELLY = Math.max(0, (SPEC_WR * SPEC_PAYOFF_RATIO - (1 - SPEC_WR)) / SPEC_PAYOFF_RATIO);
const KELLY_STAKE_FRAC = FULL_KELLY * KELLY_MULT;
const STAKE_FRAC = Math.min(KELLY_STAKE_FRAC, MAX_PCT_PER_TRADE);

console.log(`Strategy spec:`);
console.log(`  price band: $${PRICE_MIN}-$${PRICE_MAX}`);
console.log(`  hours_to_resolve: ${HTR_MIN_H}h-${HTR_MAX_H}h`);
console.log(`  mom_24h: ${MOM_MIN} to ${MOM_MAX} (flat)`);
console.log(`  full Kelly: ${FULL_KELLY.toFixed(3)}, applied at ${KELLY_MULT}x = ${KELLY_STAKE_FRAC.toFixed(3)}`);
console.log(`  effective stake frac (capped by max_pct_per_trade): ${STAKE_FRAC.toFixed(3)}\n`);

type QualifyingTrade = {
  ts: number;          // ms epoch when trade happened
  price: number;
  payoff_share: number; // 1 if won, 0 if lost - the realized per-share payout
  won: number;
  duration_h: number;   // hours_to_resolve at trade time
  condition_id: string;
};

(async () => {
  // Pull all qualifying trades (BUY side only, in the price/HTR/mom band).
  console.log("loading qualifying trades from DB...");
  const trades = await sql<QualifyingTrade[]>`
    SELECT
      t.ts::bigint AS ts,
      t.price::float8 AS price,
      (tf.won + t.price * 0)::float8 AS payoff_share,
      tf.won::int AS won,
      tf.hours_to_resolve::float8 AS duration_h,
      t.condition_id
    FROM trades t JOIN trade_features tf ON tf.trade_id = t.id
    WHERE t.side='BUY'
      AND t.price >= ${PRICE_MIN} AND t.price <= ${PRICE_MAX}
      AND tf.hours_to_resolve >= ${HTR_MIN_H} AND tf.hours_to_resolve <= ${HTR_MAX_H}
      AND tf.mom_24h >= ${MOM_MIN} AND tf.mom_24h <= ${MOM_MAX}
    ORDER BY t.ts ASC
  `;
  console.log(`  ${trades.length.toLocaleString()} qualifying trades`);

  const earliest = Number(trades[0].ts);
  const latest = Number(trades[trades.length - 1].ts);
  const dayMs = 86400 * 1000;
  const windowMs = WINDOW_DAYS * dayMs;
  const totalDays = Math.floor((latest - earliest) / dayMs);

  // Convert ts to numbers up front.
  const T = trades.map((t) => ({ ts: Number(t.ts), price: t.price, won: t.won, duration_h: t.duration_h, condition_id: t.condition_id }));

  console.log(`\ndata span: ${new Date(earliest).toISOString().slice(0, 10)} to ${new Date(latest).toISOString().slice(0, 10)} (${totalDays} days)`);
  console.log(`window size: ${WINDOW_DAYS}d, step: ${STEP_DAYS}d\n`);

  // For each rolling window, simulate the strategy.
  type WindowResult = {
    start_ts: number;
    n_trades: number;
    n_wins: number;
    n_losses: number;
    n_open_at_end: number;
    final_equity: number;
    killed: boolean;
  };

  const results: WindowResult[] = [];
  let tradeIdx = 0;

  for (let start = earliest; start + windowMs <= latest; start += STEP_DAYS * dayMs) {
    const end = start + windowMs;
    // Find trades in [start, end). Binary-search-ish.
    while (tradeIdx < T.length && T[tradeIdx].ts < start) tradeIdx++;
    let i = tradeIdx;
    const inWindow: typeof T = [];
    while (i < T.length && T[i].ts < end) { inWindow.push(T[i]); i++; }

    // Simulate.
    let cash = STARTING_BANKROLL;
    let killed = false;
    type OpenPos = { stake: number; payoff_if_win: number; resolve_ts: number; won: number };
    const open: OpenPos[] = [];
    let nTrades = 0, nWins = 0, nLosses = 0;

    // Process events chronologically: settlements + new trades.
    // For each potential new trade, first close any positions that resolved by then.
    for (const t of inWindow) {
      // Settle anything that resolved by t.ts
      const stillOpen: OpenPos[] = [];
      for (const o of open) {
        if (o.resolve_ts <= t.ts) {
          if (o.won === 1) { cash += o.payoff_if_win; nWins++; }
          else { nLosses++; }
        } else stillOpen.push(o);
      }
      open.length = 0;
      open.push(...stillOpen);

      // Killswitch check (start-based)
      const equity = cash + open.reduce((s, o) => s + o.stake, 0);
      if (((STARTING_BANKROLL - equity) / STARTING_BANKROLL) * 100 >= KILLSWITCH_DD_PCT) {
        killed = true;
        break;
      }

      // Open new position if within caps
      if (open.length >= MAX_CONCURRENT) continue;
      if (cash < 1) continue;
      const stake = Math.min(cash * STAKE_FRAC, cash * 0.95);
      if (stake < 0.5) continue;
      const payoff_if_win = stake * (1 + (1 - t.price) / t.price);
      open.push({
        stake, payoff_if_win,
        resolve_ts: t.ts + t.duration_h * 3600_000,
        won: t.won,
      });
      cash -= stake;
      nTrades++;
    }

    // Settle anything that resolved within the window after the last trade
    if (!killed) {
      const stillOpen: OpenPos[] = [];
      for (const o of open) {
        if (o.resolve_ts <= end) {
          if (o.won === 1) { cash += o.payoff_if_win; nWins++; }
          else { nLosses++; }
        } else stillOpen.push(o);
      }
      open.length = 0;
      open.push(...stillOpen);
    }
    // Mark unsettled positions at stake (conservative: treat as MTM at entry value).
    const finalEquity = cash + open.reduce((s, o) => s + o.stake, 0);

    results.push({
      start_ts: start,
      n_trades: nTrades,
      n_wins: nWins,
      n_losses: nLosses,
      n_open_at_end: open.length,
      final_equity: finalEquity,
      killed,
    });
  }

  // Reporting.
  const withTrades = results.filter((r) => r.n_trades > 0);
  const noTrades = results.length - withTrades.length;
  const finals = results.map((r) => r.final_equity).sort((a, b) => a - b);
  const at = (q: number) => finals[Math.min(finals.length - 1, Math.floor(q * finals.length))];
  const rate = (pred: (r: WindowResult) => boolean) => results.filter(pred).length / results.length;
  const mean = finals.reduce((s, v) => s + v, 0) / finals.length;
  const geo = Math.exp(finals.reduce((s, v) => s + Math.log(Math.max(1, v) / STARTING_BANKROLL), 0) / finals.length) * STARTING_BANKROLL;

  const nWinsTotal = results.reduce((s, r) => s + r.n_wins, 0);
  const nLossesTotal = results.reduce((s, r) => s + r.n_losses, 0);
  const realizedWR = nWinsTotal / (nWinsTotal + nLossesTotal);

  console.log("=".repeat(80));
  console.log("BACKTEST RESULTS - 5-day rolling windows");
  console.log("=".repeat(80));
  console.log(`  total windows:        ${results.length.toLocaleString()}`);
  console.log(`  windows w/ trades:    ${withTrades.length.toLocaleString()}  (${(withTrades.length / results.length * 100).toFixed(1)}%)`);
  console.log(`  windows w/o trades:   ${noTrades.toLocaleString()}  (${(noTrades / results.length * 100).toFixed(1)}%)`);
  console.log(`  total wins / losses:  ${nWinsTotal.toLocaleString()} / ${nLossesTotal.toLocaleString()}`);
  console.log(`  realized WR:          ${(realizedWR * 100).toFixed(2)}%`);
  console.log("");
  console.log("OUTCOME DISTRIBUTION (all windows including no-trade ones)");
  console.log("-".repeat(80));
  const fmt = (v: number) => `$${v.toFixed(0).padStart(5)} (${(((v / STARTING_BANKROLL) - 1) * 100).toFixed(1).padStart(5)}%)`;
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
  console.log("PROBABILITIES");
  console.log("-".repeat(80));
  console.log(`  P(2x)        = ${(rate((r) => r.final_equity >= 2000) * 100).toFixed(2)}%`);
  console.log(`  P(3x)        = ${(rate((r) => r.final_equity >= 3000) * 100).toFixed(2)}%`);
  console.log(`  P(loss)      = ${(rate((r) => r.final_equity < 1000) * 100).toFixed(2)}%`);
  console.log(`  P(>30% loss) = ${(rate((r) => r.final_equity < 700) * 100).toFixed(2)}%`);
  console.log(`  P(killed)    = ${(rate((r) => r.killed) * 100).toFixed(2)}%`);
  console.log(`  P(flat day)  = ${(noTrades / results.length * 100).toFixed(2)}% (no qualifying trades)`);
  console.log("");

  // Same metrics but EXCLUDING no-trade windows
  if (withTrades.length > 0) {
    const wFinals = withTrades.map((r) => r.final_equity).sort((a, b) => a - b);
    const atW = (q: number) => wFinals[Math.min(wFinals.length - 1, Math.floor(q * wFinals.length))];
    const rateW = (pred: (r: WindowResult) => boolean) => withTrades.filter(pred).length / withTrades.length;
    console.log("OUTCOME DISTRIBUTION (excluding no-trade windows)");
    console.log("-".repeat(80));
    console.log(`  median  = ${fmt(atW(0.50))}`);
    console.log(`  p10     = ${fmt(atW(0.10))}`);
    console.log(`  p90     = ${fmt(atW(0.90))}`);
    console.log(`  P(2x)   = ${(rateW((r) => r.final_equity >= 2000) * 100).toFixed(2)}%`);
    console.log(`  P(loss) = ${(rateW((r) => r.final_equity < 1000) * 100).toFixed(2)}%`);
    console.log("");
  }

  // Year-by-year breakdown
  const byYear: Record<string, WindowResult[]> = {};
  for (const r of results) {
    const y = new Date(r.start_ts).getUTCFullYear().toString();
    byYear[y] = byYear[y] ?? [];
    byYear[y].push(r);
  }
  console.log("YEAR-BY-YEAR BREAKDOWN");
  console.log("-".repeat(80));
  for (const y of Object.keys(byYear).sort()) {
    const rs = byYear[y];
    const yFinals = rs.map((r) => r.final_equity).sort((a, b) => a - b);
    const med = yFinals[Math.floor(yFinals.length / 2)];
    const wt = rs.filter((r) => r.n_trades > 0).length;
    const p2x = rs.filter((r) => r.final_equity >= 2000).length / rs.length;
    const pLoss = rs.filter((r) => r.final_equity < 1000).length / rs.length;
    const yWins = rs.reduce((s, r) => s + r.n_wins, 0);
    const yLoss = rs.reduce((s, r) => s + r.n_losses, 0);
    const yWr = (yWins + yLoss) > 0 ? yWins / (yWins + yLoss) : 0;
    console.log(`  ${y}: ${rs.length} windows, ${wt} w/ trades, realized WR=${(yWr*100).toFixed(1)}%, median=${fmt(med)}, P(2x)=${(p2x*100).toFixed(1)}%, P(loss)=${(pLoss*100).toFixed(1)}%`);
  }
  console.log("");
  console.log("SIM (100K M5) vs BACKTEST (actual rolling 5d windows)");
  console.log("-".repeat(80));
  console.log(`  metric    | sim       | backtest  | divergence`);
  console.log(`  median    | $2,165    | ${fmt(at(0.50))}`);
  console.log(`  P(2x)     | 59.2%     | ${(rate((r) => r.final_equity >= 2000) * 100).toFixed(1)}%`);
  console.log(`  P(loss)   | 7.4%      | ${(rate((r) => r.final_equity < 1000) * 100).toFixed(1)}%`);

  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
