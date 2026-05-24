-- Strategy lab: lifecycle management, health monitoring, hunt history.
--
-- Phase: lifecycle stage of an agent.
--   watch       - on the bench, surfaced by hunt, not paper-trading yet
--   paper       - paper-trading to build conviction (default for new agents)
--   live_small  - real money but small stake
--   live_full   - proven, full allocation
--   retired     - wound down, kept for history
--
-- Health: current health based on rolling actual WR vs prior WR
--   healthy     - actual WR within 3pp of prior
--   watch       - actual WR 3-10pp below prior; reduce sizing
--   broken      - actual WR > 10pp below prior for 14+ days OR DD > 25%
--
-- Auto-pause: live runtime sets status='paused' when broken for >= N days.

-- Relax status check to allow 'archived' too (for resets).
ALTER TABLE paper_agents DROP CONSTRAINT IF EXISTS paper_agents_status_check;
ALTER TABLE paper_agents ADD CONSTRAINT paper_agents_status_check
  CHECK (status IN ('active','paused','killed','archived'));

-- Lifecycle and health columns.
ALTER TABLE paper_agents ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'live_full'
  CHECK (phase IN ('watch','paper','live_small','live_full','retired'));
ALTER TABLE paper_agents ADD COLUMN IF NOT EXISTS health TEXT NOT NULL DEFAULT 'healthy'
  CHECK (health IN ('healthy','watch','broken'));
ALTER TABLE paper_agents ADD COLUMN IF NOT EXISTS wr_prior_initial DOUBLE PRECISION;
ALTER TABLE paper_agents ADD COLUMN IF NOT EXISTS phase_entered_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE paper_agents ADD COLUMN IF NOT EXISTS paused_at BIGINT;
ALTER TABLE paper_agents ADD COLUMN IF NOT EXISTS paused_reason TEXT;
ALTER TABLE paper_agents ADD COLUMN IF NOT EXISTS watch_since BIGINT;
ALTER TABLE paper_agents ADD COLUMN IF NOT EXISTS broken_since BIGINT;
ALTER TABLE paper_agents ADD COLUMN IF NOT EXISTS last_health_check_at BIGINT;
ALTER TABLE paper_agents ADD COLUMN IF NOT EXISTS notify_on_health_change BOOLEAN NOT NULL DEFAULT TRUE;

-- Health log: every health-state transition is recorded for audit + charting.
CREATE TABLE IF NOT EXISTS strategy_health_log (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES paper_agents(id) ON DELETE CASCADE,
  ts BIGINT NOT NULL,
  prev_health TEXT,
  new_health TEXT NOT NULL,
  actual_wr DOUBLE PRECISION,
  prior_wr DOUBLE PRECISION,
  n_settled INTEGER,
  drawdown_pct DOUBLE PRECISION,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_health_log_agent ON strategy_health_log(agent_id, ts DESC);

-- Hunt runs: nightly cron writes results here for the lab dashboard.
CREATE TABLE IF NOT EXISTS strategy_hunt_runs (
  id BIGSERIAL PRIMARY KEY,
  ts BIGINT NOT NULL,
  hunt_type TEXT NOT NULL CHECK (hunt_type IN ('honest_2yr','honest_1yr')),
  n_phase1_pass INTEGER NOT NULL,
  n_final_pass INTEGER NOT NULL,
  result_json JSONB NOT NULL,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_hunt_runs_ts ON strategy_hunt_runs(ts DESC);

-- Notification log (emails, slack, etc). Stored even when send is disabled.
CREATE TABLE IF NOT EXISTS notification_log (
  id BIGSERIAL PRIMARY KEY,
  ts BIGINT NOT NULL,
  channel TEXT NOT NULL,           -- 'email', 'log'
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sent BOOLEAN NOT NULL DEFAULT FALSE,
  recipient TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_ts ON notification_log(ts DESC);

INSERT INTO _migrations (id, name, applied_at) VALUES (3, '0003_strategy_lab.sql', (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint)
ON CONFLICT (id) DO NOTHING;
