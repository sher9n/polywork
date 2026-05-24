import { sql } from "@/lib/db";

// Mark-to-market agent snapshot used by both the server-rendered first paint
// and the /api/agents endpoint for periodic refresh.
export type AgentState = {
  id: string;
  name: string;
  status: string;
  starting_bankroll: number;
  current_bankroll: number;
  peak_bankroll: number;
  open_positions: number;
  committed: number;
  // Unrealized P&L on currently-open positions, marked to live market prices.
  // = sum over open positions of (shares * current_price - stake)
  // Falls back to entry_price when current_price is null (unfetched market),
  // which makes that position's contribution exactly 0 - safer than treating
  // unknown prices as zero.
  unrealized_pnl: number;
  equity: number;
  trades_count: number;
  wins_count: number;
  losses_count: number;
};

export async function fetchAgentStates(): Promise<AgentState[]> {
  return await sql<AgentState[]>`
    WITH pos AS (
      SELECT
        pp.agent_id,
        COUNT(*) FILTER (WHERE pp.status = 'open')::int AS open_count,
        COALESCE(SUM(pp.stake) FILTER (WHERE pp.status = 'open'), 0)::float8 AS committed,
        COALESCE(SUM(
          CASE WHEN pp.status = 'open' THEN
            pp.shares * COALESCE(
              CASE pp.outcome
                WHEN 'YES' THEN lms.current_yes_price
                ELSE lms.current_no_price
              END,
              pp.entry_price
            ) - pp.stake
          ELSE 0 END
        ), 0)::float8 AS unrealized
      FROM paper_positions pp
      LEFT JOIN live_market_state lms ON lms.condition_id = pp.condition_id
      GROUP BY pp.agent_id
    )
    SELECT
      pa.id, pa.name, pa.status,
      pa.starting_bankroll::float8,
      pa.current_bankroll::float8,
      pa.peak_bankroll::float8,
      COALESCE(pos.open_count, 0) AS open_positions,
      COALESCE(pos.committed, 0)::float8 AS committed,
      COALESCE(pos.unrealized, 0)::float8 AS unrealized_pnl,
      (pa.current_bankroll + COALESCE(pos.committed, 0))::float8 AS equity,
      pa.trades_count::int,
      pa.wins_count::int,
      pa.losses_count::int
    FROM paper_agents pa
    LEFT JOIN pos ON pos.agent_id = pa.id
    WHERE pa.status IN ('active', 'killed')
    ORDER BY pa.starting_bankroll DESC
  `;
}
