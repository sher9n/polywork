-- Live paper-trading system. 5 agents share the live trade feed, each runs
-- their own strategy + bankroll. No real money.

CREATE TABLE IF NOT EXISTS paper_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  strategy_spec_json JSONB NOT NULL,
  starting_bankroll DOUBLE PRECISION NOT NULL,
  current_bankroll DOUBLE PRECISION NOT NULL,
  peak_bankroll DOUBLE PRECISION NOT NULL,
  kelly_mult DOUBLE PRECISION NOT NULL,
  max_pct_per_trade DOUBLE PRECISION NOT NULL DEFAULT 0.125,
  max_concurrent_positions INTEGER NOT NULL DEFAULT 10,
  max_drawdown_pct DOUBLE PRECISION NOT NULL DEFAULT 25,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','killed')),
  trades_count INTEGER NOT NULL DEFAULT 0,
  wins_count INTEGER NOT NULL DEFAULT 0,
  losses_count INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_positions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES paper_agents(id) ON DELETE CASCADE,
  condition_id TEXT NOT NULL,
  question TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('YES','NO')),
  entry_price DOUBLE PRECISION NOT NULL,
  stake DOUBLE PRECISION NOT NULL,
  shares DOUBLE PRECISION NOT NULL,
  entry_ts BIGINT NOT NULL,
  exit_price DOUBLE PRECISION,
  exit_ts BIGINT,
  realized_pnl DOUBLE PRECISION,
  trigger_reason TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','voided'))
);
CREATE INDEX IF NOT EXISTS idx_paper_positions_agent ON paper_positions(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_paper_positions_market ON paper_positions(condition_id, status);

CREATE TABLE IF NOT EXISTS live_market_state (
  condition_id TEXT PRIMARY KEY,
  question TEXT,
  slug TEXT,
  category TEXT,
  end_date TIMESTAMPTZ,
  resolution_ts BIGINT,
  resolved_outcome TEXT CHECK (resolved_outcome IN ('YES','NO','VOIDED') OR resolved_outcome IS NULL),
  current_yes_price DOUBLE PRECISION,
  current_no_price DOUBLE PRECISION,
  volume_usd DOUBLE PRECISION,
  last_trade_ts BIGINT,
  last_polled_at BIGINT NOT NULL,
  active SMALLINT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_live_market_active ON live_market_state(active, end_date);

CREATE TABLE IF NOT EXISTS live_trades (
  id BIGSERIAL PRIMARY KEY,
  condition_id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  outcome TEXT NOT NULL,
  side TEXT NOT NULL,
  price DOUBLE PRECISION NOT NULL,
  size DOUBLE PRECISION NOT NULL,
  taker TEXT,
  -- Features computed inline as we process the feed.
  mom_24h DOUBLE PRECISION,
  hours_to_resolve DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS idx_live_trades_market_ts ON live_trades(condition_id, outcome, ts);
CREATE INDEX IF NOT EXISTS idx_live_trades_ts ON live_trades(ts DESC);

-- Append-only log of every decision (trade or skip) the agent made. Useful
-- for debugging signal vs execution mismatches.
CREATE TABLE IF NOT EXISTS paper_decisions (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES paper_agents(id) ON DELETE CASCADE,
  ts BIGINT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('BUY','SKIP','KILL')),
  condition_id TEXT,
  outcome TEXT,
  price DOUBLE PRECISION,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paper_decisions_agent ON paper_decisions(agent_id, ts DESC);
