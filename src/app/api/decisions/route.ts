import { NextResponse } from "next/server";
import { fetchDecisions, type StatusFilter } from "@/lib/decisions";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const offset = Math.max(0, parseInt(searchParams.get("offset") ?? "0", 10));
  const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") ?? "50", 10)));
  const agentsRaw = searchParams.get("agents");
  let agentFilter: string[] | null = null;
  if (agentsRaw !== null) {
    if (agentsRaw === "" || agentsRaw === "__none__") agentFilter = [];
    else agentFilter = agentsRaw.split(",").filter(Boolean);
  }
  const statusRaw = (searchParams.get("status") ?? "all").toLowerCase();
  const statusFilter: StatusFilter =
    statusRaw === "active" || statusRaw === "resolved" ? statusRaw : "all";
  try {
    const rows = await fetchDecisions({ agentFilter, statusFilter, limit, offset });
    return NextResponse.json({ rows, hasMore: rows.length >= limit });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
