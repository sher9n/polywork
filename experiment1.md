# Experiment 1: Polymarket signal-edge baseline (pre-polywork)

This document captures the findings from the **pre-polywork research phase**, which ran on three separate Polymarket datasets and produced the working hypotheses polywork is now testing rigorously. Cross-validate every polywork-era finding against the numbers here.

## Datasets

### Dataset A: Internal `market_price_history` (16,231 markets / 8.9M price snapshots)

- **Source**: Polymarket Gamma API (price snapshots only, not full trade data)
- **Cadence**: ~70-second sample interval per market
- **Time window**: 2026-04-19 → 2026-05-15 (27 days)
- **Markets**: top-volume sample weighted heavily to recent + popular markets
- **Limitation**: no trade-level data, only price observations. Synthesized "candidates" by treating each hourly snapshot as a potential entry point.

### Dataset B: PMK Discovery cohort (500 markets / 1.46M trades)

- **Source**: Polymarket Data API (`data-api.polymarket.com/trades`)
- **Selection**: top-500 markets by lifetime volume (closed=true, sort by volumeNum desc)
- **Per-market cap**: 3,000 trades (Polymarket Data API offset ceiling)
- **Bias**: most markets had >>3,000 lifetime trades, so we have the LAST 3,000. This biases toward end-of-life mop-up trades; the price-discovery phase is under-sampled on big markets.
- **Categories**: dominated by Trump 2024 election + major sports + crypto $X-target markets

### Dataset C: PMK Out-of-sample cohort (500 markets / 1.46M trades)

- **Source**: same Data API, same cap
- **Selection**: markets volume-rank 501-1000 (i.e. excluding the discovery cohort)
- **Validation purpose**: hold-out set to test if patterns from Dataset B generalize

### Aggregate

- **Total trades analyzed**: ~1.73M binary YES/NO trades on 1,000 PMK markets + 8.9M internal snapshots
- **Total resolved outcomes**: ~10,000 binary markets

## Key Findings

### Finding 1: Polymarket prices are calibrated at all price bands (longshots are NOT mispriced)

When binning all 1.73M trades by entry price and measuring actual win rate vs market-implied (= entry price):

| Price band | Trades | Actual WR | Implied WR | Edge (pp) |
|---|---:|---:|---:|---:|
| $0.00-$0.10 | 322,670 | 0.0% | 0.9% | -0.9 |
| $0.10-$0.20 | 8,318 | 3.4% | 13.4% | **-10.0** |
| $0.20-$0.30 | 6,757 | 12.0% | 25.6% | **-13.6** |
| $0.30-$0.40 | 8,167 | 16.6% | 34.2% | **-17.6** |
| $0.40-$0.50 | 5,839 | 29.3% | 43.9% | **-14.7** |
| $0.50-$0.60 | 5,533 | 60.5% | 56.0% | +4.6 |
| $0.60-$0.70 | 6,816 | 79.8% | 65.6% | **+14.2** |
| $0.70-$0.80 | 6,555 | 79.5% | 74.3% | +5.2 |
| $0.80-$0.90 | 9,023 | 95.9% | 86.2% | +9.6 |
| $0.90-$1.00 | 550,439 | 99.9% | 99.4% | +0.6 |

**Interpretation**: longshots ($0.10-$0.49) systematically lose money because actual WR is well below implied. Moderate-to-heavy favorites ($0.60-$0.89) systematically win because actual WR is above implied. The market is calibrated at extremes ($0.00-$0.10, $0.90-$1.00).

### Finding 2: The asymmetric long-shot strategy is REFUTED

User's original hypothesis: "buy long shots at 10-30¢ because the payoff is 3-9× and you only need 10-20% WR."

The data says: at $0.20 entry, you need ≥20% WR to break even, but actual WR is 12-18% in this band. Negative EV. Repeated bankroll experiments confirm:

- Naive $10 bet on every 0-10¢ entry: **-98.5% ROI** ($1k → $15)
- Naive $10 bet on every 10-20¢ entry: **-76.9% ROI**
- Naive $10 bet on every 30-40¢ entry: **-51.5% ROI**

### Finding 3: The "moderate favorite" edge is the only real one but it shrinks OOS

Best-band ROI per cohort:

| Band | Discovery ROI | OOS ROI | Stable? |
|---|---:|---:|---|
| $0.60-$0.69 | **+21.9%** | -7.9% | NO (lost edge) |
| $0.70-$0.79 | +7.0% | +10.7% | YES |
| $0.80-$0.89 | +11.2% | +3.9% | YES (smaller) |
| $0.90-$0.99 | +0.6% | +1.1% | YES (tiny) |

**The $0.70-$0.85 band is the only consistently positive-EV region across both cohorts.** Edge is +5 to +11pp.

### Finding 4: The "near-resolution skim" strategy works dramatically — at the cost of asymmetric risk

Strategy: buy whichever outcome is priced $0.90-$0.95.

| Universe | Trades | WR | Final $ from $1k | Max DD |
|---|---:|---:|---:|---:|
| PMK Discovery | 14,294 | 97.6% | **+$74,300** | 44% |
| PMK OOS | 31,224 | 98.8% | **+$198,700** | 21% |
| Internal | 743 | 96.9% | +$4,300 | 94% |

This is **the best-performing strategy** in the entire study. But it has heavy asymmetric risk: at $0.92 entry, **one loss = -$100 per $100 stake, but one win = +$8.70**. Survivability depends on WR holding above ~91%.

### Finding 5: Asymmetry matters more than people think

At $0.92 entry with 97.6% WR:
- Expected per-trade profit: +$8.44 on $100 stake
- Per-trade variance: 9.5 — meaning one loss = ~9 wins of loss
- Worst observed consecutive-loss streak in data: **89 losses in a row** on one market that resolved the wrong way (this is the same market giving 89 "loss" trades because the price stayed at $0.92 throughout)

Bankroll-sizing rule that emerged: **fixed-stake (not percentage-of-bankroll) at $20-$100/trade on $1k**, no compounding, no Martingale.

### Finding 6: Trade distribution is heavily concentrated at extremes (potential sampling artifact)

Of the 1.73M PMK trades:
- 322k trades at $0.00-$0.10 (19%)
- 550k trades at $0.90-$1.00 (32%)
- Combined: **~51% of all trades happen at price extremes**

Most of these extreme-price trades happen 1-4 WEEKS before resolution — Polymarket markets typically resolve "in practice" weeks before officially. Bots scoop pennies on already-decided markets.

**This is partly real (Polymarket dynamics) and partly sampling artifact** (we only have the last 3,000 trades per market via the Data API; high-volume markets' early-life trades are under-sampled).

The "interesting" trading from a strategy perspective is the **30-80¢ band** — ~115k of the 1.73M trades — where real price discovery happens.

### Finding 7: Bootstrap-by-market reveals concentrated "edges"

Of the top-100 strategies from grid search:
- 4 combinations had positive Kelly-sized PnL on the full universe
- ALL 4 had **100% of positive PnL concentrated in 1-5 markets**
- ALL 4 failed bootstrap-by-market (0/100 resamples remained profitable)
- Translation: the apparent "winning" strategies were 1-2 lucky markets, not transferable patterns

The two strategies that survived bootstrap stability:
1. `$0.70-$0.80 entries with quarter-Kelly` (+7-11% ROI in both cohorts)
2. `$0.90-$0.95 entries with high-Kelly` (97-99% WR, +332% to +19,768% on $1k)

### Finding 8: Capacity matters — top-50 markets test failed

When restricting strategies to the top-50 highest-volume markets (where you could actually deploy size):

- **Zero strategies had positive PnL**
- The "edges" found in the full universe disappeared when limited to the markets you'd actually trade

This is the capacity problem: the edges exist on smaller, thinner markets where you can't deploy size.

## Things this dataset did NOT test (polywork must)

1. **Stratified universe** — the PMK cohorts were top-by-volume, biasing the sample
2. **Multi-feature filters** — only price-band × time-bucket × momentum were explored; never tested categorical filters, volume tiers, taker concentration
3. **Walk-forward validation** — we did cohort split (discovery vs OOS) but not true time-series walk-forward
4. **Friction modeling** — assumed perfect fills at the trade's price; ignored spread, slippage, fees
5. **Kelly portfolio sizing** — we used per-strategy Kelly but never tested running 5-10 strategies as a portfolio
6. **Genetic strategy evolution** — only ran grid search; never let parameter-mutation explore the space
7. **Realistic capacity simulation** — assumed unlimited liquidity at the trade's exact price

## Cross-validation guarantees for polywork

When polywork produces its own findings on a stratified 6,266-market / 8.5M-trade dataset, cross-check against:

1. **Win rate by price band should match within ±2pp** — this is a structural Polymarket property
2. **$0.70-$0.85 should be the most robust positive-EV band** — survives across all cohorts
3. **Longshots should still net-lose** even with friction-aware backtest
4. **Near-resolution ($0.90-$0.95) edge should hold but with high concentration risk**
5. **Top strategies from grid search should fail bootstrap-by-market** if they're concentrated on a few markets
6. **Cross-universe stability** — strategies that work in pre-polywork data should also work in polywork's broader 2024+ universe

Any polywork finding that strongly contradicts findings 1-4 above is suspect and should be investigated as either a data bug or a regime shift.

## File structure references

- Source code: `/Applications/MAMP/htdocs/neobet/scripts/` — `backtest-polymarket.ts`, `research-longshot-edge.ts`, `simulate-strategies.ts`, `validate-oos.ts`
- Database: Railway Postgres (production), tables `polymarket_markets`, `polymarket_trades`, `backtest_runs`
- Analysis logs: `/tmp/research.log`, `/tmp/validate-oos.log`, `/tmp/sim.log`
