// Deterministic backtest engine. Asymmetry-aware (loss = full stake, win =
// stake × (1-price)/price). Bankroll-aware sizing. Optional friction model.
//
// Inputs are plain arrays so callers can decide how to load from DB.

import { passesAllFilters, type Strategy } from "./strategy";

export type TradeRow = {
  id: number;
  condition_id: string;
  ts: number;
  outcome: "YES" | "NO";
  price: number;
  size: number;
  // Features used by filters + outcome determination
  mom_1h: number | null;
  mom_6h: number | null;
  mom_24h: number | null;
  mom_3d: number | null;
  vol_24h: number | null;
  hours_to_resolve: number | null;
  distance_50: number;
  market_life_pct: number | null;
  market_volume_usd: number;
  category: string;
  resolved_outcome: "YES" | "NO";
};

export type Frictions = {
  spread_bps: number;      // basis points added to entry price
  slippage_bps: number;    // basis points lost on fill
  fee_bps: number;         // basis points charged on cost
};

export const NO_FRICTIONS: Frictions = { spread_bps: 0, slippage_bps: 0, fee_bps: 0 };

export type BacktestResult = {
  strategy_id: string;
  starting_bankroll: number;
  final_bankroll: number;
  total_pnl: number;
  roi_pct: number;
  trade_count: number;
  win_count: number;
  loss_count: number;
  win_pct: number;
  payoff_ratio: number;      // avg_win_$ / avg_loss_$
  profit_factor: number;     // sum_wins_$ / sum_losses_$
  max_drawdown_pct: number;
  sharpe: number;
  distinct_markets: number;
  top5_market_concentration: number;
  // Trade ledger (capped at 2000 entries for storage sanity)
  trade_log: Array<{
    ts: number;
    market_id: string;
    outcome: "YES" | "NO";
    entry_price: number;
    stake: number;
    shares: number;
    won: boolean;
    pnl: number;
  }>;
};

export function backtest(
  strategy: Strategy,
  trades: TradeRow[],
  starting_bankroll: number,
  frictions: Frictions = NO_FRICTIONS,
): BacktestResult {
  // Sort chronologically; strategy reads trades in order.
  const sorted = trades.slice().sort((a, b) => a.ts - b.ts);

  // First pass: filter to qualifying trades AND figure out the direction policy.
  type Candidate = TradeRow & { picked_outcome: "YES" | "NO" };
  const candidates: Candidate[] = [];
  for (const t of sorted) {
    const ctx: Record<string, number | string> = {
      price: t.price,
      hours_to_resolve: t.hours_to_resolve ?? Infinity,
      mom_1h: t.mom_1h ?? 0,
      mom_6h: t.mom_6h ?? 0,
      mom_24h: t.mom_24h ?? 0,
      mom_3d: t.mom_3d ?? 0,
      vol_24h: t.vol_24h ?? 0,
      distance_50: t.distance_50,
      market_life_pct: t.market_life_pct ?? 0,
      market_volume_usd: t.market_volume_usd,
      category: t.category,
    };
    if (!passesAllFilters(strategy.entry_filters, ctx)) continue;

    // Direction: how do we translate a filter-passing trade into a side bought?
    let picked_outcome: "YES" | "NO";
    if (strategy.direction.kind === "buy_yes") {
      picked_outcome = "YES";
    } else if (strategy.direction.kind === "buy_no") {
      picked_outcome = "NO";
    } else {
      // buy_priced_side: only fire if the trade's outcome side has price in band
      const d = strategy.direction;
      if (t.price < d.min_price || t.price > d.max_price) continue;
      picked_outcome = t.outcome;
    }
    candidates.push({ ...t, picked_outcome });
  }

  // Second pass: walk chronologically, size with Kelly, simulate.
  let bankroll = starting_bankroll;
  let peak = starting_bankroll;
  let maxDd = 0;
  const log: BacktestResult["trade_log"] = [];

  // Kelly inputs derived from the FULL set of candidates (in-sample estimate).
  // For now we use the universe-wide WR; future versions can use rolling estimates.
  const wins_in_sample = candidates.filter((c) => c.resolved_outcome === c.picked_outcome).length;
  const wr_estimate = candidates.length > 0 ? wins_in_sample / candidates.length : 0;
  const avg_price_estimate = candidates.length > 0
    ? candidates.reduce((s, c) => s + c.price, 0) / candidates.length
    : 0.5;
  const b_estimate = avg_price_estimate > 0 ? (1 - avg_price_estimate) / avg_price_estimate : 0;
  const kelly_full = b_estimate > 0 ? Math.max(0, (wr_estimate * b_estimate - (1 - wr_estimate)) / b_estimate) : 0;

  const dailyPnl: number[] = [];
  let lastDay = -1;
  let dayPnl = 0;

  for (const c of candidates) {
    if (bankroll < 1) break;

    let stake: number;
    if (strategy.sizing.kind === "fixed") {
      stake = strategy.sizing.stake_usd ?? 10;
    } else {
      const f = kelly_full * (strategy.sizing.kelly_mult ?? 0.25);
      stake = bankroll * f;
    }
    // Caps
    stake = Math.min(stake, strategy.sizing.max_per_trade_usd);
    stake = Math.min(stake, bankroll * strategy.sizing.max_pct_bankroll);
    stake = Math.min(stake, bankroll * 0.99);
    if (stake < 1) continue;

    // Frictions: bump effective entry price up by spread+slippage, then fee on cost.
    const friction_mult = 1 + (frictions.spread_bps + frictions.slippage_bps) / 10_000;
    const entryPrice = Math.min(0.999, c.price * friction_mult);
    const fee = stake * (frictions.fee_bps / 10_000);
    const effectiveStake = stake - fee;
    if (effectiveStake < 1) continue;

    const shares = effectiveStake / entryPrice;
    bankroll -= stake;
    const won = c.resolved_outcome === c.picked_outcome;
    const proceeds = won ? shares * 1.0 : 0;
    bankroll += proceeds;
    const pnl = proceeds - stake;
    log.push({
      ts: c.ts,
      market_id: c.condition_id,
      outcome: c.picked_outcome,
      entry_price: entryPrice,
      stake,
      shares,
      won,
      pnl,
    });
    if (bankroll > peak) peak = bankroll;
    const dd = peak > 0 ? ((peak - bankroll) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;

    const day = Math.floor(c.ts / 86_400_000);
    if (lastDay === -1) lastDay = day;
    if (day !== lastDay) {
      dailyPnl.push(dayPnl);
      dayPnl = 0;
      lastDay = day;
    }
    dayPnl += pnl;
  }
  if (lastDay !== -1) dailyPnl.push(dayPnl);

  // Aggregate
  const wins = log.filter((t) => t.won);
  const losses = log.filter((t) => !t.won);
  const sum_wins = wins.reduce((s, t) => s + t.pnl, 0);
  const sum_losses = -losses.reduce((s, t) => s + t.pnl, 0);
  const avg_win = wins.length > 0 ? sum_wins / wins.length : 0;
  const avg_loss = losses.length > 0 ? sum_losses / losses.length : 0;
  const payoff = avg_loss > 0 ? avg_win / avg_loss : wins.length > 0 ? Infinity : 0;
  const profit_factor = sum_losses > 0 ? sum_wins / sum_losses : wins.length > 0 ? Infinity : 0;

  // Sharpe = mean(dailyPnl) / stddev(dailyPnl) × sqrt(365)
  const mean = dailyPnl.length > 0 ? dailyPnl.reduce((s, v) => s + v, 0) / dailyPnl.length : 0;
  const variance = dailyPnl.length > 1
    ? dailyPnl.reduce((s, v) => s + (v - mean) ** 2, 0) / (dailyPnl.length - 1)
    : 0;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;

  // Market concentration
  const byMarket = new Map<string, number>();
  for (const t of log) byMarket.set(t.market_id, (byMarket.get(t.market_id) ?? 0) + t.pnl);
  const positives = [...byMarket.values()].filter((v) => v > 0).sort((a, b) => b - a);
  const totalPos = positives.reduce((s, v) => s + v, 0);
  const top5 = positives.slice(0, 5).reduce((s, v) => s + v, 0);
  const top5_pct = totalPos > 0 ? (top5 / totalPos) * 100 : 0;

  return {
    strategy_id: strategy.id,
    starting_bankroll,
    final_bankroll: bankroll,
    total_pnl: bankroll - starting_bankroll,
    roi_pct: ((bankroll - starting_bankroll) / starting_bankroll) * 100,
    trade_count: log.length,
    win_count: wins.length,
    loss_count: losses.length,
    win_pct: log.length > 0 ? (wins.length / log.length) * 100 : 0,
    payoff_ratio: payoff,
    profit_factor,
    max_drawdown_pct: maxDd,
    sharpe,
    distinct_markets: byMarket.size,
    top5_market_concentration: top5_pct,
    trade_log: log.slice(0, 2000),
  };
}
