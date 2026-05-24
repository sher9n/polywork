import { sql } from "@/lib/db";
import { LabClient, type AgentRow, type HuntRunRow, type HealthLogRow } from "./LabClient";

export const dynamic = "force-dynamic";

async function loadAgents(): Promise<AgentRow[]> {
  const rows = await sql<Array<{
    id: string; name: string; status: string; phase: string; health: string;
    starting_bankroll: number; current_bankroll: number; peak_bankroll: number;
    trades_count: number; wins_count: number; losses_count: number;
    kelly_mult: number; max_pct_per_trade: number;
    wr_prior_initial: number | null;
    phase_entered_at: number; paused_at: number | null; paused_reason: string | null;
    watch_since: number | null; broken_since: number | null;
    last_health_check_at: number | null;
    strategy: { description?: string; wr_prior?: number };
    open_count: number; committed: number; unrealized: number;
  }>>`
    SELECT
      pa.id, pa.name, pa.status, pa.phase, pa.health,
      pa.starting_bankroll, pa.current_bankroll, pa.peak_bankroll,
      pa.trades_count, pa.wins_count, pa.losses_count,
      pa.kelly_mult, pa.max_pct_per_trade,
      pa.wr_prior_initial,
      pa.phase_entered_at, pa.paused_at, pa.paused_reason,
      pa.watch_since, pa.broken_since,
      pa.last_health_check_at,
      pa.strategy_spec_json::jsonb AS strategy,
      COALESCE(pos.open_count, 0) AS open_count,
      COALESCE(pos.committed, 0)::float8 AS committed,
      COALESCE(pos.unrealized, 0)::float8 AS unrealized
    FROM paper_agents pa
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS open_count,
        COALESCE(SUM(stake), 0)::float8 AS committed,
        COALESCE(SUM(
          pp.shares * COALESCE(
            CASE pp.outcome WHEN 'YES' THEN lms.current_yes_price ELSE lms.current_no_price END,
            pp.entry_price
          ) - pp.stake
        ), 0)::float8 AS unrealized
      FROM paper_positions pp
      LEFT JOIN live_market_state lms ON lms.condition_id = pp.condition_id
      WHERE pp.agent_id = pa.id AND pp.status = 'open'
    ) pos ON true
    ORDER BY
      CASE pa.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'killed' THEN 2 ELSE 3 END,
      pa.name
  `;
  return rows.map((r) => ({
    ...r,
    starting_bankroll: Number(r.starting_bankroll),
    current_bankroll: Number(r.current_bankroll),
    peak_bankroll: Number(r.peak_bankroll),
    committed: Number(r.committed),
    unrealized: Number(r.unrealized),
    strategy: typeof r.strategy === "string" ? JSON.parse(r.strategy as unknown as string) : r.strategy,
  }));
}

async function loadRecentHunts(): Promise<HuntRunRow[]> {
  const rows = await sql<Array<{ id: number; ts: number; hunt_type: string; n_phase1_pass: number; n_final_pass: number; result_json: { winners?: Array<unknown>; phase1_top?: Array<unknown> }; notes: string | null }>>`
    SELECT id, ts, hunt_type, n_phase1_pass, n_final_pass, result_json, notes
    FROM strategy_hunt_runs ORDER BY ts DESC LIMIT 10
  `;
  return rows.map((r) => ({ ...r, ts: Number(r.ts) }));
}

async function loadHealthLog(): Promise<HealthLogRow[]> {
  const rows = await sql<Array<{ id: number; agent_id: string; ts: number; prev_health: string | null; new_health: string; actual_wr: number | null; prior_wr: number | null; n_settled: number | null; drawdown_pct: number | null; reason: string | null }>>`
    SELECT id, agent_id, ts, prev_health, new_health, actual_wr, prior_wr, n_settled, drawdown_pct, reason
    FROM strategy_health_log ORDER BY ts DESC LIMIT 50
  `;
  return rows.map((r) => ({ ...r, ts: Number(r.ts) }));
}

export default async function LabPage() {
  const [agents, hunts, healthLog] = await Promise.all([loadAgents(), loadRecentHunts(), loadHealthLog()]);
  return <LabClient agents={agents} hunts={hunts} healthLog={healthLog} />;
}
