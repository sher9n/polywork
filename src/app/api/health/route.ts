import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { COMMIT_SHORT, BOOTED_AT_MS } from "@/lib/version";

export const dynamic = "force-dynamic";

// Liveness + freshness check. Returns 200 when:
//   - DB is reachable
//   - The worker has written an equity snapshot in the last STALE_THRESHOLD_MS
//     (proxy for "polling loop is alive").
// Returns 503 with diagnostics when stale or DB is unreachable.
//
// Railway uses this for healthcheck on the web service. The threshold is
// generous (15 minutes) because the worker snapshots every 60 minutes and
// we don't want the web to flap if the worker is briefly slow.
const STALE_THRESHOLD_MS = 90 * 60_000; // 90 minutes (snapshot cadence is 60m)

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
    checks.last_snapshot_ts_ms = lastSnapTs;
    checks.last_snapshot_age_s = lastSnapTs > 0 ? Math.floor((Date.now() - lastSnapTs) / 1000) : null;

    const decisionRows = await sql<Array<{ ts: number }>>`
      SELECT COALESCE(MAX(ts), 0)::bigint AS ts FROM paper_decisions
    `;
    const lastDecisionTs = Number(decisionRows[0]?.ts ?? 0);
    checks.last_decision_ts_ms = lastDecisionTs;
    checks.last_decision_age_s = lastDecisionTs > 0 ? Math.floor((Date.now() - lastDecisionTs) / 1000) : null;

    const stale = lastSnapTs > 0 && (Date.now() - lastSnapTs) > STALE_THRESHOLD_MS;
    if (stale) {
      return NextResponse.json({ status: "stale", ...checks }, { status: 503 });
    }
    return NextResponse.json({ status: "ok", ...checks });
  } catch (e) {
    checks.error = (e as Error).message;
    return NextResponse.json({ status: "db_error", ...checks }, { status: 503 });
  }
}
