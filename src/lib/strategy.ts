// Polywork strategy DSL. JSON-encodable so a future LLM-evolution layer can
// generate candidates; the genetic algorithm uses the same shape.
//
// Three things every strategy specifies:
//   1. entry_filters: hard gates a candidate trade must pass to qualify
//   2. direction: how to pick YES vs NO at the qualifying market
//   3. sizing: how much to stake (Kelly-derived with caps)
//
// Exits are simplified for now: hold to resolution. Future versions can add
// stop-loss / take-profit / pre-resolution-exit.

export type SignalName =
  | "price"                  // entry price (the side being bought)
  | "hours_to_resolve"
  | "mom_1h"
  | "mom_6h"
  | "mom_24h"
  | "mom_3d"
  | "vol_24h"
  | "distance_50"            // |price - 0.5|
  | "market_life_pct"        // 0=first trade in market, 1=last
  | "market_volume_usd"      // lifetime volume of the parent market
  | "category";              // string match

export type FilterOp = ">" | "<" | ">=" | "<=" | "==" | "between" | "in";

export type Filter = {
  signal: SignalName;
  op: FilterOp;
  // For numeric ops: value. For "between": {min, max}. For "in": list of strings.
  value?: number;
  min?: number;
  max?: number;
  values?: string[];
};

export type DirectionRule =
  | { kind: "buy_yes" }
  | { kind: "buy_no" }
  | { kind: "buy_priced_side"; min_price: number; max_price: number }; // buy whichever side is in [min,max]

export type SizingRule = {
  kind: "fixed" | "kelly";
  // For fixed: stake_usd per trade.
  stake_usd?: number;
  // For kelly: fraction of full Kelly (e.g. 0.25 = quarter-Kelly).
  kelly_mult?: number;
  // Hard cap absolute.
  max_per_trade_usd: number;
  // Hard cap as % of bankroll.
  max_pct_bankroll: number;
};

export type Strategy = {
  id: string;
  name: string;
  generation: number;
  parent_id?: string | null;
  hypothesis?: string;
  entry_filters: Filter[];
  direction: DirectionRule;
  sizing: SizingRule;
};

// Evaluate a single filter against a flat features object.
export function passesFilter(f: Filter, ctx: Record<string, number | string>): boolean {
  const v = ctx[f.signal];
  if (v === undefined || v === null) return false;
  if (f.op === "in") return Array.isArray(f.values) && f.values.includes(String(v));
  if (f.op === "between") {
    if (typeof v !== "number") return false;
    return v >= (f.min ?? -Infinity) && v <= (f.max ?? Infinity);
  }
  const a = typeof v === "number" ? v : Number(v);
  const b = f.value ?? 0;
  switch (f.op) {
    case ">":  return a >  b;
    case "<":  return a <  b;
    case ">=": return a >= b;
    case "<=": return a <= b;
    case "==": return a === b;
  }
}

export function passesAllFilters(filters: Filter[], ctx: Record<string, number | string>): boolean {
  for (const f of filters) if (!passesFilter(f, ctx)) return false;
  return true;
}
