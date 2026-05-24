import { sql } from "@/lib/db";
import { AgentFilter } from "./AgentFilter";
import { StatusFilter } from "./StatusFilter";
import { DecisionsTable } from "./DecisionsTable";
import { LiveAgentsTable } from "./LiveAgentsTable";
import { agentMeta, DISPLAY_TO_NAME } from "@/lib/agents";
import { fetchDecisions } from "@/lib/decisions";
import { fetchAgentStates } from "@/lib/agents-data";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function Page({ searchParams }: { searchParams: Promise<{ agents?: string; status?: string }> }) {
  const params = await searchParams;
  const raw = params.agents;
  const statusRaw = (params.status ?? "all").toLowerCase();
  const statusFilter: "all" | "active" | "resolved" = statusRaw === "active" || statusRaw === "resolved" ? statusRaw : "all";
  // Fetch ALL agents first to know what "all" means
  const allAgentRows = await sql<Array<{ name: string }>>`SELECT name FROM paper_agents WHERE status = 'active' ORDER BY name`;
  const allDisplay = allAgentRows.map((r) => agentMeta(r.name).display).sort();

  // Parse `agents` query param. No param = no filter. Explicit empty/sentinel = show nothing.
  // Anything else = comma-separated display names; convert to technical names for the SQL.
  let filterTechnical: string[] | null = null;
  if (raw !== undefined) {
    if (raw === "__none__" || raw === "") filterTechnical = [];
    else {
      const displays = raw.split(",").filter(Boolean);
      filterTechnical = displays.map((d) => DISPLAY_TO_NAME[d]).filter(Boolean);
    }
  }

  const [initialAgents, initialDecisions] = await Promise.all([
    fetchAgentStates(),
    fetchDecisions({ agentFilter: filterTechnical, statusFilter, limit: PAGE_SIZE, offset: 0 }),
  ]);
  const initialHasMore = initialDecisions.length >= PAGE_SIZE;

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-8">

      <section>
        <h2 className="text-sm uppercase tracking-wider text-zinc-500 mb-2">Live paper-trading agents</h2>
        <LiveAgentsTable initial={initialAgents} />
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
          <h2 className="text-sm uppercase tracking-wider text-zinc-500">Recent decisions</h2>
          <div className="flex items-center gap-2 flex-wrap">
            <StatusFilter />
            <AgentFilter allAgents={allDisplay} />
          </div>
        </div>
        <DecisionsTable
          key={`${filterTechnical === null ? "all" : filterTechnical.join(",")}|${statusFilter}`}
          initial={initialDecisions}
          initialHasMore={initialHasMore}
          agentsFilter={filterTechnical}
          status={statusFilter}
        />
      </section>

    </main>
  );
}
