import { NextResponse } from "next/server";
import { COMMIT_SHA, COMMIT_SHORT, SERVICE_NAME, DEPLOYMENT_ID, ENVIRONMENT, BOOTED_AT_MS } from "@/lib/version";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    service: SERVICE_NAME,
    role: "web",
    commit: COMMIT_SHA,
    commit_short: COMMIT_SHORT,
    deployment_id: DEPLOYMENT_ID,
    environment: ENVIRONMENT,
    booted_at_ms: BOOTED_AT_MS,
    uptime_seconds: Math.floor((Date.now() - BOOTED_AT_MS) / 1000),
    now_ms: Date.now(),
  });
}
