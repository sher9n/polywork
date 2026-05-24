import { sql } from "@/lib/db";
import type { Decision } from "@/lib/agents";

// Query paper_decisions joined with paper_positions and live_market_state.
// Used by both the server-rendered page and the API route for infinite scroll.
export type StatusFilter = "all" | "active" | "resolved";

export async function fetchDecisions(opts: {
  agentFilter: string[] | null;
  statusFilter: StatusFilter;
  limit: number;
  offset: number;
}): Promise<Decision[]> {
  const { agentFilter, statusFilter, limit, offset } = opts;

  // Pull every column we need to compute status / current price / P&L on the client.
  // status filter expressed as SQL so we paginate correctly.
  const statusWhere =
    statusFilter === "active"
      ? sql`(pp.status = 'open' OR (pd.decision = 'SKIP' AND lms.resolved_outcome IS NULL))`
      : statusFilter === "resolved"
        ? sql`(pp.status IN ('closed', 'voided') OR (pd.decision = 'SKIP' AND lms.resolved_outcome IS NOT NULL))`
        : sql`true`;

  return await sql<Decision[]>`
    SELECT pd.ts, pa.name AS agent_name, pd.decision, pd.outcome,
           pd.price::float8, pd.reason,
           lms.slug, lms.question,
           lms.current_yes_price::float8 AS current_yes_price,
           lms.current_no_price::float8 AS current_no_price,
           lms.resolved_outcome,
           pp.shares::float8 AS shares,
           pp.stake::float8 AS stake,
           pp.status AS position_status,
           pp.exit_price::float8 AS exit_price,
           pp.realized_pnl::float8 AS realized_pnl
    FROM paper_decisions pd
    JOIN paper_agents pa ON pa.id = pd.agent_id
    LEFT JOIN live_market_state lms ON lms.condition_id = pd.condition_id
    LEFT JOIN LATERAL (
      SELECT shares, stake, status, exit_price, realized_pnl FROM paper_positions
      WHERE agent_id = pd.agent_id
        AND condition_id = pd.condition_id
        AND outcome = pd.outcome
        AND entry_ts BETWEEN pd.ts - 10000 AND pd.ts + 10000
      ORDER BY ABS(entry_ts - pd.ts) ASC LIMIT 1
    ) pp ON true
    WHERE ${agentFilter !== null ? sql`pa.name = ANY(${agentFilter})` : sql`true`}
      AND ${statusWhere}
    ORDER BY pd.ts DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}
