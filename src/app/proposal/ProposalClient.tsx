"use client";

import { useState, useCallback, useMemo } from "react";
import { RollingChart, type WindowResult, type Scenario, type FilteredSummary } from "./RollingChart";

type Cell = {
  name: string; alloc_pct: number;
  price_min: number; price_max: number;
  mom_min: number; mom_max: number;
  htr_min: number; htr_max: number;
  size_min: number; size_max: number;
};

type Props = {
  results: WindowResult[];
  cells: Cell[];
  startingBankroll: number;
  killswitchPct: number;
  windowDays: number;
  initialSummary: {
    n_windows: number;
    median_return_pct: number;
    p_positive: number;
    p_double: number;
    p_killswitch: number;
  };
};

export function ProposalClient({ results, cells, startingBankroll, killswitchPct, windowDays, initialSummary }: Props) {
  const [live, setLive] = useState<FilteredSummary | null>(null);

  const onSummaryChange = useCallback((s: FilteredSummary | null) => setLive(s), []);

  // KPIs come from the live filtered summary when available; otherwise fall
  // back to the script-computed summary (matches what's shown before first
  // filter interaction).
  const n = live ? live.n : initialSummary.n_windows;
  const median = live ? live.median : initialSummary.median_return_pct;
  const pPos = live ? (live.positive / Math.max(1, live.n)) : initialSummary.p_positive;
  const p2x = live ? (live.doubled / Math.max(1, live.n)) : initialSummary.p_double;
  const pKil = live ? (live.killed / Math.max(1, live.n)) : initialSummary.p_killswitch;

  // CRITICAL: memoize derived arrays. Without this, every render creates new
  // array references which break RollingChart's useMemo chain (filteredBase
  // depends on agentNames; new agentNames each render = new filteredBase =
  // new filtered = new fSummary = useEffect fires = setLive = re-render =
  // loop). The infinite-render bug from before was exactly this.
  const scenarios: Scenario[] = useMemo(() => [
    { key: "proposal", label: `${killswitchPct}% (proposal)`, ks_pct: killswitchPct, is_live: true, results },
  ], [killswitchPct, results]);
  const agentNames = useMemo(() => cells.map((c) => c.name), [cells]);
  const agentAllocations = useMemo(() => cells.map((c) => c.alloc_pct), [cells]);

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <Kpi label="Windows in view" value={n.toString()} />
        <Kpi label="Median return" value={`${median >= 0 ? "+" : ""}${median.toFixed(0)}%`} subClass={median >= 0 ? "up" : "down"} />
        <Kpi label="P(positive)" value={`${(pPos * 100).toFixed(0)}%`} subClass={pPos >= 0.5 ? "up" : "down"} />
        <Kpi label="P(2x)" value={`${(p2x * 100).toFixed(0)}%`} subClass="up" />
        <Kpi label="P(killswitch)" value={`${(pKil * 100).toFixed(0)}%`} subClass={pKil > 0.1 ? "down" : ""} />
      </div>

      <RollingChart
        scenarios={scenarios}
        startingBankroll={startingBankroll}
        agentNames={agentNames}
        agentAllocations={agentAllocations}
        windowDays={windowDays}
        onSummaryChange={onSummaryChange}
      />
    </>
  );
}

function Kpi({ label, value, subClass }: { label: string; value: string; subClass?: string }) {
  return (
    <div className="border border-zinc-800 rounded-md bg-zinc-900/40 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`text-xl font-bold font-mono ${subClass ?? "text-zinc-100"}`}>{value}</div>
    </div>
  );
}
