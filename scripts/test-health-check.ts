// Quick sanity check: invoke checkAgentHealth on each active agent and
// verify it runs without throwing, plus check the side effects (health_log
// rows, last_health_check_at updated).
//
// Run: tsx scripts/test-health-check.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
import { checkAgentHealth, loadAgents } from "../src/lib/live-runtime";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

(async () => {
  console.log("[test] loading active agents...");
  const agents = await loadAgents(sql);
  console.log(`[test]   ${agents.length} active`);
  for (const a of agents) {
    console.log(`\n[test] checkAgentHealth(${a.name})...`);
    const r = await checkAgentHealth(sql, a);
    console.log(`[test]   -> ${r.health} (changed=${r.changed})`);
  }
  console.log("\n[test] state after:");
  const rows = await sql<Array<{ name: string; health: string; last_health_check_at: number | null; watch_since: number | null; broken_since: number | null }>>`
    SELECT name, health, last_health_check_at, watch_since, broken_since
    FROM paper_agents WHERE status = 'active' ORDER BY name
  `;
  for (const r of rows) {
    console.log(`  ${r.name}: health=${r.health} last_check=${r.last_health_check_at ? new Date(Number(r.last_health_check_at)).toISOString() : 'never'} watch_since=${r.watch_since ?? 'n/a'} broken_since=${r.broken_since ?? 'n/a'}`);
  }
  const logRows = await sql<Array<{ id: number; agent_id: string; prev_health: string; new_health: string }>>`
    SELECT id, agent_id, prev_health, new_health FROM strategy_health_log ORDER BY ts DESC LIMIT 5
  `;
  console.log(`\n[test] recent health_log entries: ${logRows.length}`);
  for (const r of logRows) console.log(`  ${r.agent_id}: ${r.prev_health} -> ${r.new_health}`);
  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
