# polywork

Polymarket strategy research lab. Paper-money simulation only.

## What this is

A self-contained backtest + strategy-evolution framework for Polymarket binary markets, designed to find robust positive-edge strategies via:

- Stratified universe of ~10,000 liquid 2024+ markets
- Deterministic backtest engine with friction modeling
- Grid search across a strategy DSL
- Genetic-algorithm evolution (no LLM costs)
- Kelly + bankroll management
- Bootstrap-by-market robustness scoring
- Walk-forward train/test validation
- Single-page dashboard

Real-money deployment is NOT implemented and not on the roadmap for this phase.

## Setup

```bash
# 1. Install deps
npm install

# 2. Set up local Postgres
createdb polywork
cp .env.example .env.local

# 3. Apply schema
npm run migrate

# 4. Ingest market universe (~30 min)
npm run ingest:markets

# 5. Ingest trades for all markets (~hours)
npm run ingest:trades

# 6. Inspect what landed
npm run ingest:status

# 7. Run the dashboard
npm run dev
```

## Data layout

`markets` — stratified universe of resolved Polymarket markets, 2024+, lifetime volume $50k-$500k

`trades` — trade-by-trade history (capped at 3,000 per market via Polymarket Data API)

`trade_features` — pre-computed signals per trade (momentum, volatility, hours-to-resolve, market-life-pct)

`strategies` — strategy specs (entry filters + sizing + exits, JSON DSL)

`backtest_runs` — per-strategy results with full metrics + robustness scores

## Status

Phase 1: bootstrap + data ingest. In progress.
