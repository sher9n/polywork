import { NextResponse } from "next/server";
import { fetchAgentStates } from "@/lib/agents-data";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await fetchAgentStates();
    return NextResponse.json({ rows });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
