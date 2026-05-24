-- polywork initial schema. Paper-money only; no wallet state.
--
-- Design principles:
--   - Every table append-only from the worker's perspective (no UPDATE except on bookkeeping fields)
--   - Foreign keys with CASCADE so wiping a market wipes its trades + features
--   - Indexed for the analytic workload, not transactional

CREATE TABLE IF NOT EXISTS _migrations (
  id integer PRIMARY KEY,
  name text NOT NULL,
  applied_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS markets (
  condition_id TEXT PRIMARY KEY,
  question_id TEXT,
  slug TEXT,
  question TEXT NOT NULL,
  category TEXT,
  end_date TIMESTAMPTZ,
  resolution_ts BIGINT,
  resolved_outcome TEXT CHECK (resolved_outcome IN ('YES','NO') OR resolved_outcome IS NULL),
  volume_usd DOUBLE PRECISION NOT NULL,
  liquidity_usd DOUBLE PRECISION,
  was_disputed SMALLINT NOT NULL DEFAULT 0,
  lifetime_trade_estimate INTEGER,
  -- Sampling stratum so we can analyze representativeness later.
  volume_stratum TEXT,
  category_stratum TEXT,
  time_stratum TEXT,
  ingested_at BIGINT NOT NULL
);
CREATE INDEX idx_markets_volume ON markets(volume_usd DESC);
CREATE INDEX idx_markets_resolved ON markets(resolved_outcome) WHERE resolved_outcome IS NOT NULL;
CREATE INDEX idx_markets_strata ON markets(volume_stratum, category_stratum, time_stratum);

CREATE TABLE IF NOT EXISTS trades (
  id BIGSERIAL PRIMARY KEY,
  condition_id TEXT NOT NULL REFERENCES markets(condition_id) ON DELETE CASCADE,
  ts BIGINT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('YES','NO')),
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  price DOUBLE PRECISION NOT NULL CHECK (price >= 0 AND price <= 1),
  size DOUBLE PRECISION NOT NULL,
  taker TEXT,
  -- Filled at ingest time: where in the market's life this trade happened.
  -- 0.0 = first trade, 1.0 = last trade before resolution. Used to slice
  -- discovery vs mop-up phase analyses.
  market_life_pct DOUBLE PRECISION
);
CREATE INDEX idx_trades_market ON trades(condition_id, ts);
CREATE INDEX idx_trades_ts ON trades(ts);
CREATE INDEX idx_trades_outcome_price ON trades(outcome, price);

-- Pre-computed features per trade. Populated lazily after trade ingestion
-- so the grid search can run without recomputing momentum signals.
CREATE TABLE IF NOT EXISTS trade_features (
  trade_id BIGINT PRIMARY KEY REFERENCES trades(id) ON DELETE CASCADE,
  mom_1h DOUBLE PRECISION,
  mom_6h DOUBLE PRECISION,
  mom_24h DOUBLE PRECISION,
  mom_3d DOUBLE PRECISION,
  vol_24h DOUBLE PRECISION,
  hours_to_resolve DOUBLE PRECISION,
  distance_50 DOUBLE PRECISION,
  -- Won by buying this side? Filled from market's resolved_outcome.
  per_share_pnl DOUBLE PRECISION,
  won SMALLINT
);
CREATE INDEX idx_trade_features_features ON trade_features(hours_to_resolve, mom_24h);

CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  spec_json JSONB NOT NULL,
  parent_id TEXT REFERENCES strategies(id) ON DELETE SET NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  generated_by TEXT NOT NULL DEFAULT 'human',  -- human | grid | genetic
  hypothesis TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX idx_strategies_generation ON strategies(generation, created_at DESC);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  universe_filter JSONB NOT NULL,    -- e.g. { volume_min: 50000, year: 2024 }
  train_window_start TIMESTAMPTZ,
  train_window_end TIMESTAMPTZ,
  starting_bankroll DOUBLE PRECISION NOT NULL,
  final_bankroll DOUBLE PRECISION NOT NULL,
  total_pnl DOUBLE PRECISION NOT NULL,
  roi_pct DOUBLE PRECISION NOT NULL,
  trade_count INTEGER NOT NULL,
  win_count INTEGER NOT NULL,
  loss_count INTEGER NOT NULL,
  win_pct DOUBLE PRECISION,
  payoff_ratio DOUBLE PRECISION,
  profit_factor DOUBLE PRECISION,
  sharpe DOUBLE PRECISION,
  max_drawdown_pct DOUBLE PRECISION,
  -- Robustness scores from bootstrap-by-market
  bootstrap_pos_pct DOUBLE PRECISION,
  top5_market_concentration DOUBLE PRECISION,
  distinct_markets INTEGER,
  -- Walk-forward result on held-out test window
  oos_roi_pct DOUBLE PRECISION,
  oos_max_dd_pct DOUBLE PRECISION,
  details_json JSONB,
  created_at BIGINT NOT NULL
);
CREATE INDEX idx_backtest_strategy ON backtest_runs(strategy_id, created_at DESC);
CREATE INDEX idx_backtest_robust ON backtest_runs(bootstrap_pos_pct, roi_pct);
