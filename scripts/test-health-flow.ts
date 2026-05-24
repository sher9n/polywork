// End-to-end test of the health monitor flow.
// Creates a sandbox agent, simulates settled positions in various states
// (healthy, watch-degraded, broken), verifies checkAgentHealth classifies
// correctly and that the auto-pause logic triggers when expected. Cleans up.
//
// Run: tsx scripts/test-health-flow.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
import { checkAgentHealth, loadAgents } from "../src/lib/live-runtime";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

const TEST_AGENT_ID = "agent_test_health_sandbox";

async function cleanup() {
  await sql`DELETE FROM strategy_health_log WHERE agent_id = ${TEST_AGENT_ID}`;
  await sql`DELETE FROM paper_decisions WHERE agent_id = ${TEST_AGENT_ID}`;
  await sql`DELETE FROM paper_positions WHERE agent_id = ${TEST_AGENT_ID}`;
  await sql`DELETE FROM paper_agents WHERE id = ${TEST_AGENT_ID}`;
}

async function insertAgent(): Promise<void> {
  const now = Date.now();
  await sql`
    INSERT INTO paper_agents (
      id, name, strategy_spec_json,
      starting_bankroll, current_bankroll, peak_bankroll,
      kelly_mult, max_pct_per_trade, max_concurrent_positions, max_drawdown_pct,
      status, trades_count, wins_count, losses_count,
      phase, health, wr_prior_initial, phase_entered_at,
      notify_on_health_change, created_at, updated_at
    ) VALUES (
      ${TEST_AGENT_ID}, 'test_health_sandbox',
      ${sql.json({ price_min: 0.5, price_max: 0.6, direction: "buy_priced_side", description: "test", wr_prior: 0.75 })},
      1000, 1000, 1000,
      1.0, 0.25, 10, 50,
      'active', 0, 0, 0,
      'paper', 'healthy', 0.75, ${now},
      false,
      ${now}, ${now}
    )
  `;
}

// Resets bankroll/peak/health/status to a clean baseline so each test phase
// starts isolated. Without this, lingering DD from a prior test trips the
// catastrophic-DD pause unexpectedly.
async function resetAgentBaseline(): Promise<void> {
  const now = Date.now();
  await sql`DELETE FROM paper_positions WHERE agent_id = ${TEST_AGENT_ID}`;
  await sql`
    UPDATE paper_agents
    SET current_bankroll = 1000, peak_bankroll = 1000,
        trades_count = 0, wins_count = 0, losses_count = 0,
        status = 'active', health = 'healthy',
        watch_since = NULL, broken_since = NULL,
        paused_at = NULL, paused_reason = NULL,
        last_health_check_at = NULL,
        updated_at = ${now}
    WHERE id = ${TEST_AGENT_ID}
  `;
}

// Insert N settled positions (W wins, N-W losses), all within the last 25 days
// so they fall inside the rolling 30d window.
async function insertSettled(n: number, w: number, ageDaysSpread = 25): Promise<void> {
  const now = Date.now();
  const spreadMs = ageDaysSpread * 86400 * 1000;
  for (let i = 0; i < n; i++) {
    const won = i < w ? 1 : 0;
    const ts = now - Math.floor(((i + 1) / (n + 1)) * spreadMs);
    const id = `pp_test_${i}_${Math.random().toString(36).slice(2, 8)}`;
    await sql`
      INSERT INTO paper_positions (
        id, agent_id, condition_id, outcome, entry_price, stake, shares,
        entry_ts, exit_price, exit_ts, realized_pnl, status, trigger_reason
      ) VALUES (
        ${id}, ${TEST_AGENT_ID}, ${'test_cond_' + i}, 'YES',
        0.55, 100, 181.8,
        ${ts - 12 * 3600_000}, ${won ? 1 : 0}, ${ts},
        ${won ? 81.82 : -100},
        'closed',
        ${`test settled n=${n} w=${w} won=${won}`}
      )
    `;
  }
  // Update agent's bankroll based on net P&L from these positions.
  const w_count = w;
  const l_count = n - w;
  const netPnl = (w_count * 81.82) - (l_count * 100);
  const newBankroll = Math.max(0, 1000 + netPnl);
  await sql`
    UPDATE paper_agents
    SET current_bankroll = ${newBankroll},
        trades_count = ${n}, wins_count = ${w}, losses_count = ${l_count},
        updated_at = ${now}
    WHERE id = ${TEST_AGENT_ID}
  `;
}

async function getAgent() {
  const agents = await loadAgents(sql);
  return agents.find((a) => a.id === TEST_AGENT_ID);
}

async function dumpState(label: string) {
  const a = await sql<Array<{
    status: string; phase: string; health: string;
    current_bankroll: number; peak_bankroll: number;
    watch_since: number | null; broken_since: number | null;
    paused_at: number | null; paused_reason: string | null;
  }>>`
    SELECT status, phase, health, current_bankroll, peak_bankroll,
           watch_since, broken_since, paused_at, paused_reason
    FROM paper_agents WHERE id = ${TEST_AGENT_ID}
  `;
  console.log(`\n  [${label}]`);
  console.log(`    status=${a[0].status}  phase=${a[0].phase}  health=${a[0].health}`);
  console.log(`    bankroll=$${Number(a[0].current_bankroll).toFixed(2)}  peak=$${Number(a[0].peak_bankroll).toFixed(2)}`);
  console.log(`    watch_since=${a[0].watch_since ?? "n/a"}  broken_since=${a[0].broken_since ?? "n/a"}`);
  if (a[0].paused_reason) console.log(`    paused_reason=${a[0].paused_reason}`);
}

function expect(name: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}` + (detail ? `: ${detail}` : "")); process.exitCode = 1; }
}

(async () => {
  console.log("=== Strategy Lab health-flow E2E test ===\n");

  // Always clean first to handle prior runs.
  await cleanup();
  await insertAgent();
  console.log("[setup] inserted sandbox agent with prior WR 0.75");

  // ----- TEST 1: healthy state when actual WR matches prior -----
  await resetAgentBaseline();
  console.log("\n[1] healthy: 20 trades at 75% WR (matches prior 75%)");
  await insertSettled(20, 15);
  // Restore bankroll/peak to baseline so DD doesn't trip the test
  await sql`UPDATE paper_agents SET current_bankroll = 1000, peak_bankroll = 1000 WHERE id = ${TEST_AGENT_ID}`;
  let agent = await getAgent();
  if (!agent) throw new Error("T1 agent missing");
  let r = await checkAgentHealth(sql, agent);
  await dumpState("after T1");
  expect("T1 health === 'healthy'", r.health === "healthy");

  // ----- TEST 2: drift to WATCH at 5pp below -----
  await resetAgentBaseline();
  console.log("\n[2] watch: 20 trades at 70% WR (5pp below prior)");
  await insertSettled(20, 14);
  await sql`UPDATE paper_agents SET current_bankroll = 1000, peak_bankroll = 1000 WHERE id = ${TEST_AGENT_ID}`;
  agent = await getAgent();
  if (!agent) throw new Error("T2 agent missing");
  r = await checkAgentHealth(sql, agent);
  await dumpState("after T2");
  expect("T2 health === 'watch'", r.health === "watch");

  // ----- TEST 3: WR-based BROKEN at 15pp below (NOT triggered by DD) -----
  await resetAgentBaseline();
  console.log("\n[3] broken (WR): 20 trades at 55% WR (20pp below prior)");
  await insertSettled(20, 11);
  // Keep bankroll/peak balanced so DD doesn't trip
  await sql`UPDATE paper_agents SET current_bankroll = 1000, peak_bankroll = 1000 WHERE id = ${TEST_AGENT_ID}`;
  agent = await getAgent();
  if (!agent) throw new Error("T3 agent missing");
  r = await checkAgentHealth(sql, agent);
  await dumpState("after T3");
  expect("T3 health === 'broken' (WR delta drives it)", r.health === "broken");

  // ----- TEST 4: insufficient samples is treated as healthy -----
  await resetAgentBaseline();
  console.log("\n[4] healthy (insufficient samples): only 5 trades");
  await insertSettled(5, 2);
  await sql`UPDATE paper_agents SET current_bankroll = 1000, peak_bankroll = 1000 WHERE id = ${TEST_AGENT_ID}`;
  agent = await getAgent();
  if (!agent) throw new Error("T4 agent missing");
  r = await checkAgentHealth(sql, agent);
  await dumpState("after T4");
  expect("T4 health === 'healthy' (n=5 < 15 threshold)", r.health === "healthy");

  // ----- TEST 5: drawdown-based BROKEN triggers even with healthy WR -----
  await resetAgentBaseline();
  console.log("\n[5] broken (drawdown): peak $1000 -> equity $700 (30% DD), no samples");
  await sql`UPDATE paper_agents SET peak_bankroll = 1000, current_bankroll = 700 WHERE id = ${TEST_AGENT_ID}`;
  agent = await getAgent();
  if (!agent) throw new Error("T5 agent missing");
  r = await checkAgentHealth(sql, agent);
  await dumpState("after T5");
  expect("T5 health === 'broken' (drawdown 30% >= 25%)", r.health === "broken");

  // ----- TEST 6: auto-pause when broken_since is 15 days old -----
  // Need WR-broken (not DD-broken) since DD pauses immediately and we want to
  // test the time-based pause path specifically.
  await resetAgentBaseline();
  console.log("\n[6] auto-pause: WR-broken for 15 days -> should pause");
  await insertSettled(20, 11);  // WR=55%, broken
  // Keep bankroll/peak balanced to avoid DD-based pause; backdate broken_since to 15 days ago
  const fifteenDaysAgo = Date.now() - 15 * 86400 * 1000;
  await sql`UPDATE paper_agents SET current_bankroll = 1000, peak_bankroll = 1000, health = 'broken', broken_since = ${fifteenDaysAgo}, status = 'active' WHERE id = ${TEST_AGENT_ID}`;
  agent = await getAgent();
  if (!agent) throw new Error("T6 agent missing");
  r = await checkAgentHealth(sql, agent);
  await dumpState("after T6");
  const finalRow = await sql<Array<{ status: string; paused_reason: string | null }>>`
    SELECT status, paused_reason FROM paper_agents WHERE id = ${TEST_AGENT_ID}
  `;
  expect("T6 status === 'paused' (auto-pause triggered)", finalRow[0].status === "paused");
  expect("T6 paused_reason mentions 14 days OR DD", (finalRow[0].paused_reason ?? "").includes("14 days") || (finalRow[0].paused_reason ?? "").includes("DD") || (finalRow[0].paused_reason ?? "").includes("drawdown"));

  // ----- TEST 7: catastrophic DD triggers immediate pause -----
  await resetAgentBaseline();
  console.log("\n[7] catastrophic DD: peak $1000 -> equity $500 (50% DD)");
  await sql`UPDATE paper_agents SET peak_bankroll = 1000, current_bankroll = 500 WHERE id = ${TEST_AGENT_ID}`;
  agent = await getAgent();
  if (!agent) throw new Error("T7 agent missing");
  r = await checkAgentHealth(sql, agent);
  await dumpState("after T7");
  const finalRow2 = await sql<Array<{ status: string; paused_reason: string | null }>>`
    SELECT status, paused_reason FROM paper_agents WHERE id = ${TEST_AGENT_ID}
  `;
  expect("T7 status === 'paused' (catastrophic DD triggers immediate)", finalRow2[0].status === "paused");

  // ----- TEST 8: health_log has rows for each transition -----
  const logRows = await sql<Array<{ prev_health: string | null; new_health: string }>>`
    SELECT prev_health, new_health FROM strategy_health_log WHERE agent_id = ${TEST_AGENT_ID} ORDER BY ts ASC
  `;
  console.log(`\n[8] health log: ${logRows.length} transitions recorded`);
  for (const lr of logRows) console.log(`    ${lr.prev_health ?? "-"} -> ${lr.new_health}`);
  expect("T8 at least 3 health transitions logged", logRows.length >= 3);

  // ----- TEST 9: notification_log has entries for changes -----
  const notifRows = await sql<Array<{ subject: string }>>`
    SELECT subject FROM notification_log WHERE subject LIKE '%test_health_sandbox%' ORDER BY ts ASC
  `;
  console.log(`\n[9] notifications: ${notifRows.length} log entries`);
  // Test agent has notify_on_health_change=false so transitions don't emit
  // health-change notifications. Auto-pause STILL emits a notification because
  // it's hardcoded to notify (the rationale: a paused agent is a major event).
  expect("T9 at least 2 notifications (the two auto-pauses)", notifRows.length >= 2);

  // ----- Cleanup -----
  console.log("\n[cleanup] removing sandbox agent and its data...");
  await cleanup();
  console.log("\n=== Test complete. ===");
  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
