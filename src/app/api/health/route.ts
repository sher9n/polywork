import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { COMMIT_SHORT, BOOTED_AT_MS } from "@/lib/version";

export const dynamic = "force-dynamic";

// Liveness check for the web service. Returns 200 when:
//   - the web process is up (we got here)
//   - the DB is reachable
//
// Worker freshness (last_snapshot_age_s, last_decision_age_s) is reported in
// the body for monitoring but does NOT fail the healthcheck. Otherwise the
// web service would fail healthchecks any time the worker is briefly behind
// or being redeployed, which has nothing to do with the web's liveness.
//
// If you want stricter monitoring, alert on /api/health's last_snapshot_age_s
// field exceeding your threshold from an external monitor.
const STALE_THRESHOLD_S = 90 * 60; // 90 min — informational only.

export async function GET(): Promise<NextResponse> {
  const checks: Record<string, unknown> = {
    commit: COMMIT_SHORT,
    web_uptime_s: Math.floor((Date.now() - BOOTED_AT_MS) / 1000),
    now_ms: Date.now(),
  };

  try {
    const dbStart = Date.now();
    const rows = await sql<Array<{ ts: number }>>`
      SELECT COALESCE(MAX(ts), 0)::bigint AS ts FROM live_equity_snapshots
    `;
    checks.db_ping_ms = Date.now() - dbStart;
    const lastSnapTs = Number(rows[0]?.ts ?? 0);
    const snapAge = lastSnapTs > 0 ? Math.floor((Date.now() - lastSnapTs) / 1000) : null;
    checks.last_snapshot_ts_ms = lastSnapTs;
    checks.last_snapshot_age_s = snapAge;
    checks.worker_stale = snapAge !== null && snapAge > STALE_THRESHOLD_S;

    const decisionRows = await sql<Array<{ ts: number }>>`
      SELECT COALESCE(MAX(ts), 0)::bigint AS ts FROM paper_decisions
    `;
    const lastDecisionTs = Number(decisionRows[0]?.ts ?? 0);
    checks.last_decision_ts_ms = lastDecisionTs;
    checks.last_decision_age_s = lastDecisionTs > 0 ? Math.floor((Date.now() - lastDecisionTs) / 1000) : null;

    return NextResponse.json({ status: "ok", ...checks });
  } catch (e) {
    checks.error = (e as Error).message;
    return NextResponse.json({ status: "db_error", ...checks }, { status: 503 });
  }
}
