-- Hourly snapshot of total live equity. Powers the /tracker page which compares
-- the live trajectory against 10,000 simulated Monte Carlo paths from the
-- pre-launch validation runs (M90 0.40x Kelly config).

CREATE TABLE IF NOT EXISTS live_equity_snapshots (
  ts BIGINT PRIMARY KEY,
  total_equity DOUBLE PRECISION NOT NULL,
  total_cash DOUBLE PRECISION NOT NULL,
  total_committed DOUBLE PRECISION NOT NULL,
  total_unrealized DOUBLE PRECISION NOT NULL,
  total_start DOUBLE PRECISION NOT NULL,
  open_positions INTEGER NOT NULL,
  active_agents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_equity_ts ON live_equity_snapshots(ts DESC);
