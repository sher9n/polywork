// Genetic algorithm strategy evolution. Seeds population from the top-N grid
// search strategies, mutates parameters, evaluates each candidate via the
// same backtest engine, keeps top survivors.
//
// Design preserves the LLM-evolution hook: every strategy carries
// generated_by + hypothesis + parent_id. A future LLM layer can replace the
// `mutate()` function and inject its own candidates without touching the
// fitness / selection logic.
//
// Run: tsx scripts/evolve.ts [GENERATIONS=3]

import postgres from "postgres";
import * as dotenv from "dotenv";
import { backtest, type TradeRow, type Frictions } from "../src/lib/backtest";
import type { Strategy, Filter } from "../src/lib/strategy";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

const STARTING_BANKROLL = 1000;
const FRICTIONS: Frictions = { spread_bps: 50, slippage_bps: 50, fee_bps: 0 };
const GENERATIONS = Number(process.argv[2] ?? 3);
const SEED_TOP_N = 10;
const CHILDREN_PER_PARENT = 4;
const SURVIVORS = 10;

type ScoredStrategy = { strategy: Strategy; fitness: number; trades: number };

function jitter(value: number, scale: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value + (Math.random() - 0.5) * scale));
}

function mutate(parent: Strategy, generation: number): Strategy {
  // Deep-clone filters, then perturb one randomly.
  const filters = parent.entry_filters.map((f) => ({ ...f }));
  const idx = Math.floor(Math.random() * filters.length);
  const f = filters[idx];
  if (f.op === "between" && f.min !== undefined && f.max !== undefined) {
    if (f.signal === "price") {
      f.min = jitter(f.min, 0.10, 0, 1);
      f.max = jitter(f.max, 0.10, 0, 1);
      if (f.min > f.max) [f.min, f.max] = [f.max, f.min];
    } else if (f.signal === "hours_to_resolve") {
      f.min = jitter(f.min, 24, 0, 9999);
      f.max = jitter(f.max, 24, 0, 9999);
      if (f.min > f.max) [f.min, f.max] = [f.max, f.min];
    }
  } else if (f.value !== undefined) {
    f.value = jitter(f.value, 0.05, -1, 1);
  }
  const id = `evo_g${generation}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  return {
    id,
    name: `${parent.name} (m${generation})`,
    generation,
    parent_id: parent.id,
    hypothesis: `Mutation of ${parent.id}: perturbed ${f.signal} ${f.op}`,
    entry_filters: filters as Filter[],
    direction: { ...parent.direction },
    sizing: { ...parent.sizing },
  } as Strategy & { generated_by: string };
}

function scoreFitness(r: ReturnType<typeof backtest>): number {
  // Robust fitness: penalize concentration + drawdown + low sample size.
  if (r.trade_count < 30) return -Infinity;
  const concPenalty = r.top5_market_concentration > 80 ? 0.3 : r.top5_market_concentration > 50 ? 0.7 : 1.0;
  const ddPenalty = r.max_drawdown_pct > 50 ? 0.5 : r.max_drawdown_pct > 25 ? 0.8 : 1.0;
  const sampleBonus = Math.min(1, r.trade_count / 200);
  return r.roi_pct * concPenalty * ddPenalty * sampleBonus;
}

async function loadTrades(): Promise<TradeRow[]> {
  return await sql<TradeRow[]>`
    SELECT t.id, t.condition_id, t.ts, t.outcome::text, t.price, t.size,
           f.mom_1h, f.mom_6h, f.mom_24h, f.mom_3d, f.vol_24h, f.hours_to_resolve,
           COALESCE(f.distance_50, ABS(t.price - 0.5)) AS distance_50,
           t.market_life_pct, m.volume_usd AS market_volume_usd,
           COALESCE(m.category_stratum, 'other') AS category,
           m.resolved_outcome::text AS resolved_outcome
    FROM trades t
    JOIN trade_features f ON f.trade_id = t.id
    JOIN markets m ON m.condition_id = t.condition_id
    WHERE t.side = 'BUY' AND m.resolved_outcome IN ('YES','NO') AND f.hours_to_resolve IS NOT NULL
  `;
}

async function persist(strategy: Strategy, result: ReturnType<typeof backtest>): Promise<void> {
  await sql`
    INSERT INTO strategies (id, name, spec_json, generation, parent_id, generated_by, hypothesis, created_at)
    VALUES (${strategy.id}, ${strategy.name}, ${JSON.stringify(strategy)}::jsonb,
            ${strategy.generation}, ${strategy.parent_id ?? null}, 'genetic',
            ${strategy.hypothesis ?? null}, ${Date.now()})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO backtest_runs (
      id, strategy_id, universe_filter, starting_bankroll, final_bankroll,
      total_pnl, roi_pct, trade_count, win_count, loss_count, win_pct,
      payoff_ratio, profit_factor, sharpe, max_drawdown_pct,
      distinct_markets, top5_market_concentration, details_json, created_at
    ) VALUES (
      ${strategy.id + "_bt"}, ${strategy.id}, ${JSON.stringify({})}::jsonb,
      ${result.starting_bankroll}, ${result.final_bankroll}, ${result.total_pnl}, ${result.roi_pct},
      ${result.trade_count}, ${result.win_count}, ${result.loss_count}, ${result.win_pct},
      ${result.payoff_ratio === Infinity ? 99 : result.payoff_ratio},
      ${result.profit_factor === Infinity ? 99 : result.profit_factor},
      ${result.sharpe}, ${result.max_drawdown_pct}, ${result.distinct_markets},
      ${result.top5_market_concentration}, ${JSON.stringify({})}::jsonb, ${Date.now()}
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

(async () => {
  console.log(`[evolve] loading trades + features...`);
  const trades = await loadTrades();
  console.log(`[evolve] ${trades.length.toLocaleString()} trades loaded`);

  // Seed from top-N grid strategies.
  const seeds = await sql<Array<{ id: string; spec: Strategy }>>`
    SELECT s.id, s.spec_json AS spec
    FROM strategies s JOIN backtest_runs b ON b.strategy_id = s.id
    WHERE s.id LIKE 'grid_%'
    ORDER BY b.roi_pct DESC LIMIT ${SEED_TOP_N}
  `;
  if (seeds.length === 0) {
    console.error("[evolve] no grid strategies found - run grid-search first");
    process.exit(1);
  }
  console.log(`[evolve] seeded ${seeds.length} top grid strategies`);

  let population: ScoredStrategy[] = seeds.map((s) => {
    const r = backtest(s.spec, trades, STARTING_BANKROLL, FRICTIONS);
    return { strategy: s.spec, fitness: scoreFitness(r), trades: r.trade_count };
  });
  population.sort((a, b) => b.fitness - a.fitness);
  console.log(`[evolve] seed fitness range: ${population[population.length - 1].fitness.toFixed(0)} to ${population[0].fitness.toFixed(0)}`);

  for (let gen = 1; gen <= GENERATIONS; gen++) {
    console.log(`\n[evolve] generation ${gen}/${GENERATIONS}...`);
    const children: ScoredStrategy[] = [];
    for (const parent of population.slice(0, SURVIVORS)) {
      for (let k = 0; k < CHILDREN_PER_PARENT; k++) {
        const c = mutate(parent.strategy, gen);
        const r = backtest(c, trades, STARTING_BANKROLL, FRICTIONS);
        const fitness = scoreFitness(r);
        await persist(c, r);
        children.push({ strategy: c, fitness, trades: r.trade_count });
      }
    }
    population = [...population, ...children].sort((a, b) => b.fitness - a.fitness).slice(0, SURVIVORS);
    console.log(`  best gen ${gen}: fitness=${population[0].fitness.toFixed(0)} (${population[0].strategy.name})`);
  }

  console.log("\n=== FINAL TOP 10 (genetic + seed grid) ===");
  for (const p of population) {
    console.log(`  fitness=${p.fitness.toFixed(0).padStart(8)} trades=${String(p.trades).padStart(6)} ${p.strategy.name}`);
  }
  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
