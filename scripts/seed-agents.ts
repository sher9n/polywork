// Seed the 3 paper-trading agents from the strategy-hunt winning portfolio.
//
// This replaces the previous 4-bot setup (near_resolution_skim, heavy_favorite_steady,
// mom_rising_mid, mom_rising_longshot) which the historical backtest showed lost
// money on 3 of 4 bots. The new portfolio is the top finalist from the strategy
// hunt: an asymmetric mix of mid-favorite grinders + a longshot kicker that
// historically delivers P(2x)~37% with P(loss)~9% over 90 days.
//
// Run: tsx scripts/seed-agents.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

type AgentSeed = {
  id: string;
  name: string;
  starting_bankroll: number;
  kelly_mult: number;
  max_pct_per_trade: number;
  max_concurrent_positions: number;
  max_drawdown_pct: number;
  strategy: {
    price_min: number;
    price_max: number;
    mom_24h_min?: number;
    mom_24h_max?: number;
    hours_to_resolve_min?: number;
    hours_to_resolve_max?: number;
    direction: "buy_priced_side";
    description: string;
    wr_prior: number;
  };
};

// Portfolio specs from the strategy hunt's top validated finalist:
//   Bootstrap-10K: P(2x)=36.6%, P(loss)=8.7%, median=$1769, P(kill)=6.0%
//   2026 walk-forward: P(2x)=48.9%, P(loss)=10.3%
//   Composition: 50% / 30% / 20% across three cells, full Kelly (1.0x), 90-day horizon
const AGENTS: AgentSeed[] = [
  {
    id: "agent_mid_fav_day",
    name: "mid_fav_day",
    starting_bankroll: 500,
    kelly_mult: 1.0,
    max_pct_per_trade: 0.25,
    max_concurrent_positions: 12,
    max_drawdown_pct: 50,
    strategy: {
      price_min: 0.70,
      price_max: 0.75,
      mom_24h_min: -0.02,
      mom_24h_max: 0.02,
      hours_to_resolve_min: 12,
      hours_to_resolve_max: 24,
      direction: "buy_priced_side",
      description: "Mid-favorite grinder. Buys $0.70-$0.75 when 24h momentum is flat (-2c to +2c) AND market resolves in 12-24 hours. ~95% historical WR, ~38% payoff per win. The compounding engine of the portfolio.",
      wr_prior: 0.947,
    },
  },
  {
    id: "agent_mid_fav_flash",
    name: "mid_fav_flash",
    starting_bankroll: 300,
    kelly_mult: 1.0,
    max_pct_per_trade: 0.25,
    max_concurrent_positions: 10,
    max_drawdown_pct: 50,
    strategy: {
      price_min: 0.70,
      price_max: 0.75,
      mom_24h_min: -0.02,
      mom_24h_max: 0.02,
      hours_to_resolve_min: 0.5,
      hours_to_resolve_max: 6,
      direction: "buy_priced_side",
      description: "Fast mid-favorite. Same shape as mid_fav_day but resolves in under 6 hours. Cycles 4x faster - more compounding opportunities per calendar day. ~96% historical WR.",
      wr_prior: 0.961,
    },
  },
  {
    id: "agent_mid_lottery",
    name: "mid_lottery",
    starting_bankroll: 200,
    kelly_mult: 1.0,
    max_pct_per_trade: 0.10,
    max_concurrent_positions: 8,
    max_drawdown_pct: 50,
    strategy: {
      price_min: 0.20,
      price_max: 0.25,
      mom_24h_min: 0.02,
      mom_24h_max: 10,
      hours_to_resolve_min: 6,
      hours_to_resolve_max: 12,
      direction: "buy_priced_side",
      description: "Asymmetric kicker. Buys $0.20-$0.25 longshots that are rising (24h mom > +2c) AND resolve in 6-12 hours. ~38% historical WR but 3-4x payoff per win. Covers periods when the grinders are quiet.",
      wr_prior: 0.378,
    },
  },
];

(async () => {
  for (const a of AGENTS) {
    await sql`
      INSERT INTO paper_agents (
        id, name, strategy_spec_json, starting_bankroll, current_bankroll, peak_bankroll,
        kelly_mult, max_pct_per_trade, max_concurrent_positions, max_drawdown_pct,
        status, created_at, updated_at
      )
      VALUES (
        ${a.id}, ${a.name}, ${sql.json(a.strategy)},
        ${a.starting_bankroll}, ${a.starting_bankroll}, ${a.starting_bankroll},
        ${a.kelly_mult}, ${a.max_pct_per_trade}, ${a.max_concurrent_positions}, ${a.max_drawdown_pct},
        'active', ${Date.now()}, ${Date.now()}
      )
      ON CONFLICT (id) DO UPDATE SET
        strategy_spec_json = EXCLUDED.strategy_spec_json,
        kelly_mult = EXCLUDED.kelly_mult,
        max_pct_per_trade = EXCLUDED.max_pct_per_trade,
        max_concurrent_positions = EXCLUDED.max_concurrent_positions,
        max_drawdown_pct = EXCLUDED.max_drawdown_pct,
        updated_at = ${Date.now()}
    `;
    console.log(`OK ${a.name.padEnd(18)} bankroll=$${a.starting_bankroll}  kelly=${a.kelly_mult}x  cap_per_trade=${(a.max_pct_per_trade * 100).toFixed(1)}%  max_open=${a.max_concurrent_positions}`);
  }
  const total = AGENTS.reduce((s, a) => s + a.starting_bankroll, 0);
  console.log(`\nseeded ${AGENTS.length} agents. total paper capital: $${total}`);
  console.log(`portfolio allocation: ${AGENTS.map((a) => `${(a.starting_bankroll / total * 100).toFixed(0)}% ${a.name}`).join(" + ")}`);
  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
