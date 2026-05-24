// Reset the live paper-trading state and seed the 4 proposal cells as
// fresh agents. The 3 old agents (mid_fav_day, mid_fav_flash, mid_lottery)
// are archived along with their open positions voided.
//
// SAFE TO RUN MULTIPLE TIMES - it only resets agents whose ids don't match
// the new seed set, and uses ON CONFLICT for the new ones.
//
// Run: tsx scripts/reset-and-seed-proposal.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

type Cell = {
  id: string;
  name: string;
  alloc_pct: number;        // fraction of $1000 portfolio
  price_min: number;
  price_max: number;
  mom_min: number;          // -10 means "any" lower bound
  mom_max: number;          // 10 means "any" upper bound
  htr_min: number;
  htr_max: number;
  size_min: number;
  size_max: number;
  wr_prior: number;
  max_pct_per_trade: number;
  max_concurrent: number;
  description: string;
};

// 10-cell LIQUID portfolio. Cells 1-5 are the prior 5-cell setup; cells 6-10
// are new additions from the same hunts to cover price bands the prior 5
// missed. Allocations are equal at 10% each. max_pct_per_trade keeps the 1.5x
// sizing from the prior deployment.
//
// Backtest with full live-mimicry + REALISTIC friction (0.1% slip, 0% fee):
//   median +22.6%, P(positive) 95.4%, worst -8.3%, P(killswitch) 0%.
//   ~168 entries/window (70% more than 5-cell).
const CELLS: Cell[] = [
  {
    id: "agent_longmid_any_dayplus_large", name: "longmid_any_dayplus_large",
    alloc_pct: 0.10, price_min: 0.30, price_max: 0.35,
    mom_min: -10, mom_max: 10,
    htr_min: 24, htr_max: 72,
    size_min: 200, size_max: 1e12,
    wr_prior: 0.523,
    max_pct_per_trade: 0.15, max_concurrent: 10,
    description: "Long-mid ($0.30-$0.35) at any momentum, scheduled 1-3 days, large trade size. ~52% WR.",
  },
  {
    id: "agent_midfav_rising_day_any", name: "midfav_rising_day_any",
    alloc_pct: 0.10, price_min: 0.55, price_max: 0.60,
    mom_min: 0.02, mom_max: 10,
    htr_min: 6, htr_max: 24,
    size_min: 0, size_max: 1e12,
    wr_prior: 0.792,
    max_pct_per_trade: 0.225, max_concurrent: 10,
    description: "Mid-favorite ($0.55-$0.60) with rising momentum, 6-24h hold, any trade size. ~79% WR. Catches favorites that are firming up.",
  },
  {
    id: "agent_midfav_rising_slow_large", name: "midfav_rising_slow_large",
    alloc_pct: 0.10, price_min: 0.50, price_max: 0.55,
    mom_min: 0.02, mom_max: 10,
    htr_min: 72, htr_max: 99999,
    size_min: 200, size_max: 1e12,
    wr_prior: 0.626,
    max_pct_per_trade: 0.225, max_concurrent: 10,
    description: "Coin-flip ($0.50-$0.55) with rising momentum, slow resolution (72h+), large trade size. ~63% WR.",
  },
  {
    id: "agent_heavyfav_flat_slow_large", name: "heavyfav_flat_slow_large",
    alloc_pct: 0.10, price_min: 0.70, price_max: 0.75,
    mom_min: -0.02, mom_max: 0.02,
    htr_min: 72, htr_max: 99999,
    size_min: 200, size_max: 1e12,
    wr_prior: 0.833,
    max_pct_per_trade: 0.30, max_concurrent: 10,
    description: "Heavy favorite ($0.70-$0.75) with flat momentum, slow resolution (72h+), large trade size. ~83% WR.",
  },
  {
    id: "agent_ultrafav_any_slow_any", name: "ultrafav_any_slow_any",
    alloc_pct: 0.10, price_min: 0.90, price_max: 0.95,
    mom_min: -10, mom_max: 10,
    htr_min: 72, htr_max: 99999,
    size_min: 0, size_max: 1e12,
    wr_prior: 0.96,
    max_pct_per_trade: 0.30, max_concurrent: 15,
    description: "Ultra-favorite ($0.90-$0.95) with any momentum, slow resolution (72h+). ~96% WR. Income/ballast cell.",
  },
  // NEW cells (6-10): cover price bands missed by the prior 5.
  {
    id: "agent_long_any_dayplus_large", name: "long_any_dayplus_large",
    alloc_pct: 0.10, price_min: 0.25, price_max: 0.30,
    mom_min: -10, mom_max: 10,
    htr_min: 24, htr_max: 72,
    size_min: 200, size_max: 1e12,
    wr_prior: 0.333,
    max_pct_per_trade: 0.15, max_concurrent: 10,
    description: "Long ($0.25-$0.30) at any momentum, scheduled 1-3 days, large trade size. ~33% WR. Below-r1 diversifier in longshot zone.",
  },
  {
    id: "agent_mid_flat_slow_any", name: "mid_flat_slow_any",
    alloc_pct: 0.10, price_min: 0.40, price_max: 0.45,
    mom_min: -0.02, mom_max: 0.02,
    htr_min: 72, htr_max: 99999,
    size_min: 0, size_max: 1e12,
    wr_prior: 0.625,
    max_pct_per_trade: 0.225, max_concurrent: 10,
    description: "Mid-range ($0.40-$0.45) with flat momentum, slow (72h+), any size. ~63% WR. Fills mid-low price gap; strong activity.",
  },
  {
    id: "agent_midhi_any_slow_any", name: "midhi_any_slow_any",
    alloc_pct: 0.10, price_min: 0.45, price_max: 0.50,
    mom_min: -10, mom_max: 10,
    htr_min: 72, htr_max: 99999,
    size_min: 0, size_max: 1e12,
    wr_prior: 0.529,
    max_pct_per_trade: 0.225, max_concurrent: 10,
    description: "Mid-high ($0.45-$0.50) any momentum, slow (72h+). ~53% WR. Fills coin-flip zone with patient horizon.",
  },
  {
    id: "agent_midhi_any_day_large", name: "midhi_any_day_large",
    alloc_pct: 0.10, price_min: 0.60, price_max: 0.65,
    mom_min: -10, mom_max: 10,
    htr_min: 6, htr_max: 24,
    size_min: 200, size_max: 1e12,
    wr_prior: 0.706,
    max_pct_per_trade: 0.30, max_concurrent: 10,
    description: "Mid-high ($0.60-$0.65) any momentum, day (6-24h), large size. ~71% WR. Fills gap between r3 and heavyfav.",
  },
  {
    id: "agent_hifav_rising_slow_any", name: "hifav_rising_slow_any",
    alloc_pct: 0.10, price_min: 0.65, price_max: 0.70,
    mom_min: 0.02, mom_max: 10,
    htr_min: 72, htr_max: 99999,
    size_min: 0, size_max: 1e12,
    wr_prior: 0.742,
    max_pct_per_trade: 0.30, max_concurrent: 10,
    description: "High-favorite ($0.65-$0.70) rising momentum, slow (72h+). ~74% WR. Fills gap between heavyfav and ultrafav.",
  },
];

const PORTFOLIO_TOTAL = 1000;

(async () => {
  console.log("[reset] === Strategy Lab reset + seed ===\n");

  // Step 1: void all open positions on agents that aren't in the new seed set.
  console.log("[reset] step 1: voiding open positions on agents to be archived...");
  const oldOpenRes = await sql<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM paper_positions pp
    WHERE pp.status = 'open'
      AND pp.agent_id != ALL(${CELLS.map((c) => c.id)})
  `;
  console.log(`[reset]   ${oldOpenRes[0].n} open positions to void`);
  if (oldOpenRes[0].n > 0) {
    await sql`
      UPDATE paper_positions
      SET status = 'voided',
          exit_price = entry_price,
          exit_ts = ${Date.now()},
          realized_pnl = 0
      WHERE status = 'open'
        AND agent_id != ALL(${CELLS.map((c) => c.id)})
    `;
  }

  // Step 2: archive old agents (status='archived', phase='retired').
  console.log("[reset] step 2: archiving old agents...");
  const archivedAgents = await sql<Array<{ id: string; name: string }>>`
    UPDATE paper_agents
    SET status = 'archived',
        phase = 'retired',
        phase_entered_at = ${Date.now()},
        updated_at = ${Date.now()}
    WHERE id != ALL(${CELLS.map((c) => c.id)})
      AND status != 'archived'
    RETURNING id, name
  `;
  for (const a of archivedAgents) console.log(`[reset]   archived ${a.name} (${a.id})`);

  // Step 3: upsert the 4 new agents.
  console.log("[reset] step 3: seeding 4 new proposal agents...");
  const now = Date.now();
  for (const c of CELLS) {
    const bankroll = PORTFOLIO_TOTAL * c.alloc_pct;
    const spec = {
      price_min: c.price_min, price_max: c.price_max,
      mom_24h_min: c.mom_min === -10 ? undefined : c.mom_min,
      mom_24h_max: c.mom_max === 10 ? undefined : c.mom_max,
      hours_to_resolve_min: c.htr_min,
      hours_to_resolve_max: c.htr_max,
      size_min: c.size_min === 0 ? undefined : c.size_min,
      size_max: c.size_max >= 1e12 ? undefined : c.size_max,
      direction: "buy_priced_side" as const,
      description: c.description,
      wr_prior: c.wr_prior,
    };
    await sql`
      INSERT INTO paper_agents (
        id, name, strategy_spec_json,
        starting_bankroll, current_bankroll, peak_bankroll,
        kelly_mult, max_pct_per_trade, max_concurrent_positions, max_drawdown_pct,
        status, trades_count, wins_count, losses_count,
        phase, health, wr_prior_initial, phase_entered_at,
        notify_on_health_change, last_health_check_at,
        created_at, updated_at
      ) VALUES (
        ${c.id}, ${c.name}, ${sql.json(spec)},
        ${bankroll}, ${bankroll}, ${bankroll},
        ${1.0}, ${c.max_pct_per_trade}, ${c.max_concurrent}, ${50},
        'active', 0, 0, 0,
        'paper', 'healthy', ${c.wr_prior}, ${now},
        true, NULL,
        ${now}, ${now}
      )
      ON CONFLICT (id) DO UPDATE SET
        strategy_spec_json = EXCLUDED.strategy_spec_json,
        starting_bankroll = EXCLUDED.starting_bankroll,
        current_bankroll = EXCLUDED.current_bankroll,
        peak_bankroll = EXCLUDED.peak_bankroll,
        kelly_mult = EXCLUDED.kelly_mult,
        max_pct_per_trade = EXCLUDED.max_pct_per_trade,
        max_concurrent_positions = EXCLUDED.max_concurrent_positions,
        max_drawdown_pct = EXCLUDED.max_drawdown_pct,
        status = 'active',
        trades_count = 0, wins_count = 0, losses_count = 0,
        phase = 'paper', health = 'healthy',
        wr_prior_initial = EXCLUDED.wr_prior_initial,
        phase_entered_at = EXCLUDED.phase_entered_at,
        watch_since = NULL, broken_since = NULL,
        paused_at = NULL, paused_reason = NULL,
        last_health_check_at = NULL,
        updated_at = EXCLUDED.updated_at
    `;
    console.log(`[reset]   seeded ${c.name} ($${bankroll} bankroll, WR prior ${(c.wr_prior * 100).toFixed(1)}%)`);
  }

  // Step 4: also void any open positions on the new agents (shouldn't be any
  // on a first run, but cleans state if rerunning).
  console.log("[reset] step 4: voiding any pre-existing open positions on the new agents...");
  const newOpenRes = await sql<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM paper_positions
    WHERE status = 'open' AND agent_id = ANY(${CELLS.map((c) => c.id)})
  `;
  if (newOpenRes[0].n > 0) {
    await sql`
      UPDATE paper_positions
      SET status = 'voided', exit_price = entry_price, exit_ts = ${Date.now()}, realized_pnl = 0
      WHERE status = 'open' AND agent_id = ANY(${CELLS.map((c) => c.id)})
    `;
    console.log(`[reset]   voided ${newOpenRes[0].n} stale open positions on the new agents`);
  }

  // Step 5: verify
  console.log("\n[reset] === Verification ===");
  const final = await sql<Array<{ id: string; name: string; status: string; phase: string; health: string; bankroll: number }>>`
    SELECT id, name, status, phase, health, current_bankroll AS bankroll
    FROM paper_agents
    WHERE status = 'active'
    ORDER BY name
  `;
  console.log(`Active agents (${final.length}):`);
  for (const a of final) {
    console.log(`  ${a.name.padEnd(28)} status=${a.status.padEnd(8)} phase=${a.phase.padEnd(12)} health=${a.health.padEnd(8)} bankroll=$${Number(a.bankroll).toFixed(2)}`);
  }
  const openCheck = await sql<Array<{ agent_id: string; n: number }>>`
    SELECT agent_id, COUNT(*)::int AS n
    FROM paper_positions WHERE status = 'open' GROUP BY agent_id ORDER BY agent_id
  `;
  console.log(`\nOpen positions:`);
  if (openCheck.length === 0) console.log("  (none - clean slate)");
  for (const o of openCheck) console.log(`  ${o.agent_id}: ${o.n}`);

  await sql.end();
  console.log("\n[reset] done. live-runtime will pick up the new agents on next tick.");
})().catch((e) => { console.error(e); process.exit(1); });
