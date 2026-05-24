import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { notify } from "@/lib/email";
import { requireAdmin } from "@/lib/auth";

type Action =
  | "promote_to_paper" | "promote_to_live_small" | "promote_to_live_full"
  | "demote"
  | "pause" | "resume"
  | "retire";

const PHASE_ORDER = ["watch", "paper", "live_small", "live_full"] as const;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  let body: { action?: Action };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const action = body.action;
  if (!action) return NextResponse.json({ error: "missing action" }, { status: 400 });

  const rows = await sql<Array<{ id: string; name: string; status: string; phase: string }>>`
    SELECT id, name, status, phase FROM paper_agents WHERE id = ${id}
  `;
  if (rows.length === 0) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  const agent = rows[0];
  const now = Date.now();

  let newPhase = agent.phase;
  let newStatus = agent.status;
  let pausedAt: number | null = null;
  let pausedReason: string | null = null;

  switch (action) {
    case "promote_to_paper":
      if (agent.phase !== "watch") return NextResponse.json({ error: `cannot promote_to_paper from ${agent.phase}` }, { status: 409 });
      newPhase = "paper";
      break;
    case "promote_to_live_small":
      if (agent.phase !== "paper") return NextResponse.json({ error: `cannot promote_to_live_small from ${agent.phase}` }, { status: 409 });
      newPhase = "live_small";
      break;
    case "promote_to_live_full":
      if (agent.phase !== "live_small") return NextResponse.json({ error: `cannot promote_to_live_full from ${agent.phase}` }, { status: 409 });
      newPhase = "live_full";
      break;
    case "demote": {
      const i = PHASE_ORDER.indexOf(agent.phase as (typeof PHASE_ORDER)[number]);
      if (i <= 0) return NextResponse.json({ error: `cannot demote from ${agent.phase}` }, { status: 409 });
      newPhase = PHASE_ORDER[i - 1];
      break;
    }
    case "pause":
      if (agent.status !== "active") return NextResponse.json({ error: `cannot pause non-active agent (${agent.status})` }, { status: 409 });
      newStatus = "paused";
      pausedAt = now;
      pausedReason = "manual pause via lab";
      break;
    case "resume":
      if (agent.status !== "paused") return NextResponse.json({ error: `cannot resume non-paused agent (${agent.status})` }, { status: 409 });
      newStatus = "active";
      pausedAt = null;
      pausedReason = null;
      break;
    case "retire":
      newPhase = "retired";
      newStatus = "archived";
      break;
    default:
      return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
  }

  await sql`
    UPDATE paper_agents
    SET phase = ${newPhase},
        status = ${newStatus},
        phase_entered_at = CASE WHEN ${newPhase} != ${agent.phase} THEN ${now} ELSE phase_entered_at END,
        paused_at = ${pausedAt},
        paused_reason = ${pausedReason},
        updated_at = ${now}
    WHERE id = ${id}
  `;

  await notify(sql, {
    channel: "log",
    subject: `[polywork] ${agent.name} ${action} (manual)`,
    body: `Manual action: ${action}\nagent: ${agent.name} (${id})\nstatus: ${agent.status} -> ${newStatus}\nphase: ${agent.phase} -> ${newPhase}\nts: ${new Date(now).toISOString()}\n`,
  });

  return NextResponse.json({ ok: true, agent: { id, name: agent.name, status: newStatus, phase: newPhase } });
}
