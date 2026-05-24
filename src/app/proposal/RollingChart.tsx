"use client";

import { useState, useMemo, useRef, useEffect } from "react";

export type WindowResult = {
  start_ts: number;
  start_date: string;
  end_date: string;
  n_entries: number;
  final_equity: number;
  return_pct: number;
  killed: boolean;
  killed_day: number;
  killed_by_mtm: boolean;
  max_drawdown_pct: number;
  lowest_equity: number;
  highest_equity: number;
  agent_entries: number[];
  agent_wins: number[];
  agent_losses: number[];
  agent_pnl: number[];
  // In-flight projection fields (omitted = treated as complete for back-compat).
  in_flight?: boolean;
  days_observed?: number;
  observed_equity?: number;
  observed_return_pct?: number;
  projection_p10_pct?: number | null;
  projection_p50_pct?: number | null;
  projection_p90_pct?: number | null;
};

export type Scenario = {
  key: string;
  label: string;
  ks_pct: number;
  is_live: boolean;
  results: WindowResult[];
};

export type FilteredSummary = {
  n: number;
  positive: number;
  doubled: number;
  killed: number;
  median: number;
  mean: number;
};

type Props = {
  scenarios: Scenario[];          // 1+ killswitch scenarios; chart toggle switches between them
  startingBankroll: number;
  agentNames: string[];
  agentAllocations: number[];   // alloc fraction per agent, same index as agentNames
  windowDays?: number;            // shown in title and axis labels; defaults to 60 to match /rolling
  onSummaryChange?: (s: FilteredSummary | null) => void;   // emits when filters change
};

const MONTH_NAMES: Record<string, string> = {
  "01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr", "05": "May", "06": "Jun",
  "07": "Jul", "08": "Aug", "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec",
};
function fmtMonth(ym: string): string {
  const [y, m] = ym.split("-");
  return `${MONTH_NAMES[m] ?? m} ${y}`;
}

export function RollingChart({ scenarios, agentNames, agentAllocations, startingBankroll, windowDays = 60, onSummaryChange }: Props) {
  // Killswitch scenario selector. Defaults to the scenario flagged is_live
  // (matching the production threshold). State holds the scenario key.
  const liveScenarioKey = (scenarios.find((s) => s.is_live) ?? scenarios[0]).key;
  const [scenarioKey, setScenarioKey] = useState<string>(liveScenarioKey);
  const activeScenario = scenarios.find((s) => s.key === scenarioKey) ?? scenarios[0];
  const liveResults = activeScenario.results;
  const isLiveSelected = activeScenario.is_live;

  // All months present in data, sorted oldest -> newest
  const allMonths = useMemo(() => {
    const set = new Set<string>();
    for (const r of liveResults) set.add(r.start_date.slice(0, 7));
    return Array.from(set).sort();
  }, [liveResults]);

  // Month multi-select: default = all months selected
  const [selectedMonths, setSelectedMonths] = useState<Set<string>>(() => new Set(allMonths));
  const [monthDropdownOpen, setMonthDropdownOpen] = useState(false);
  const monthFilterRef = useRef<HTMLDivElement>(null);

  // Strategy multi-select: default = all agents selected
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(() => new Set(agentNames));
  const [agentDropdownOpen, setAgentDropdownOpen] = useState(false);
  const agentFilterRef = useRef<HTMLDivElement>(null);

  // Close dropdowns on outside click
  useEffect(() => {
    if (!monthDropdownOpen && !agentDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (monthDropdownOpen && !monthFilterRef.current?.contains(t)) setMonthDropdownOpen(false);
      if (agentDropdownOpen && !agentFilterRef.current?.contains(t)) setAgentDropdownOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [monthDropdownOpen, agentDropdownOpen]);

  const toggleMonth = (m: string) => {
    setSelectedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m); else next.add(m);
      return next;
    });
  };
  const toggleAgent = (a: string) => {
    setSelectedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(a)) next.delete(a); else next.add(a);
      return next;
    });
  };

  const allMonthsSelected = selectedMonths.size === allMonths.length;
  const noMonthsSelected = selectedMonths.size === 0;
  const monthLabel = allMonthsSelected ? `All ${allMonths.length} months` : noMonthsSelected ? "No months" : `${selectedMonths.size} of ${allMonths.length} months`;

  const allAgentsSelected = selectedAgents.size === agentNames.length;
  const noAgentsSelected = selectedAgents.size === 0;
  const agentLabel = allAgentsSelected ? `All ${agentNames.length} strategies` : noAgentsSelected ? "No strategies" : `${selectedAgents.size} of ${agentNames.length} strategies`;

  // Hover state
  const [hover, setHover] = useState<WindowResult | null>(null);
  const [hoverXY, setHoverXY] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const chartContainerRef = useRef<HTMLDivElement>(null);

  // Filtering: window passes month filter, AND at least one selected agent has entries > 0 in that window.
  const filteredBase = useMemo(() => (
    liveResults.filter((r) => {
      if (!selectedMonths.has(r.start_date.slice(0, 7))) return false;
      if (selectedAgents.size === agentNames.length) return true; // all selected = no agent constraint
      // Otherwise: at least one selected agent must have fired in this window
      for (let i = 0; i < agentNames.length; i++) {
        if (selectedAgents.has(agentNames[i]) && r.agent_entries[i] > 0) return true;
      }
      return false;
    })
  ), [liveResults, selectedMonths, selectedAgents, agentNames]);

  // Selected-agents indices and effective starting bankroll for the subset.
  // When the user unchecks strategies, we recompute returns from just the
  // selected agents' P&L slices (their bankroll buckets were independent in
  // the engine, so this is mathematically meaningful as "what if I had only
  // deployed these strategies with their allocations").
  const selectedAgentIdxs = useMemo(() => {
    const idxs: number[] = [];
    for (let i = 0; i < agentNames.length; i++) if (selectedAgents.has(agentNames[i])) idxs.push(i);
    return idxs;
  }, [selectedAgents, agentNames]);

  const effectiveStart = useMemo(() => (
    selectedAgentIdxs.reduce((s, i) => s + agentAllocations[i] * startingBankroll, 0)
  ), [selectedAgentIdxs, agentAllocations, startingBankroll]);

  // Per-window effective P&L / return for the selected subset.
  function effectiveOf(r: WindowResult): { ret_pct: number; pnl: number; final: number } {
    if (selectedAgentIdxs.length === 0 || effectiveStart === 0) return { ret_pct: 0, pnl: 0, final: 0 };
    const pnl = selectedAgentIdxs.reduce((s, i) => s + r.agent_pnl[i], 0);
    const final = effectiveStart + pnl;
    const ret_pct = (final / effectiveStart - 1) * 100;
    return { ret_pct, pnl, final };
  }

  const allAgents = selectedAgents.size === agentNames.length;

  // "Only divergent rows" filter for the per-window table - hides identical
  // rows when comparing scenarios so the user can see what actually changed.
  const [onlyDivergent, setOnlyDivergent] = useState(false);

  // For the "differs from live" highlight: a window only behaves differently
  // across scenarios if it hit the killswitch in the LIVE scenario (since alt
  // thresholds are looser, they never kill windows that live didn't kill).
  // So the set of "differing dates" is exactly the live-scenario killed dates.
  const liveScenarioForDiff = scenarios.find((s) => s.is_live) ?? scenarios[0];
  const divergentDates = useMemo(() => {
    const s = new Set<string>();
    for (const r of liveScenarioForDiff.results) if (r.killed) s.add(r.start_date);
    return s;
  }, [liveScenarioForDiff]);

  // Recompute return_pct and final_equity for the selected subset of agents.
  // This shifts the bar heights so they reflect "what would the chosen
  // strategies have done together" rather than the full portfolio total.
  // We REPLACE the `filtered` name so all downstream code (chart, summary,
  // table) automatically picks up the subset-aware values.
  const filtered = useMemo(() => (
    filteredBase.map((r) => {
      const e = effectiveOf(r);
      return { ...r, return_pct: e.ret_pct, final_equity: e.final };
    })
  ), [filteredBase, selectedAgentIdxs, effectiveStart]); // eslint-disable-line react-hooks/exhaustive-deps

  // Chart geometry
  const W = 1000, H = 460;
  const PAD_L = 60, PAD_R = 24, PAD_T = 36, PAD_B = 90;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const colW = filtered.length > 0 ? plotW / filtered.length : plotW;

  // Y-axis range needs to fit the bar tops (return_pct or projected P50) AND
  // the P10/P90 band whiskers for in-flight bars, so they aren't clipped.
  const displayValuesFor = (r: WindowResult): number[] => {
    const vs: number[] = [r.return_pct];
    if (r.in_flight && allAgents) {
      if (r.projection_p10_pct != null) vs.push(r.projection_p10_pct);
      if (r.projection_p50_pct != null) vs.push(r.projection_p50_pct);
      if (r.projection_p90_pct != null) vs.push(r.projection_p90_pct);
    }
    return vs;
  };
  const allVals = filtered.flatMap(displayValuesFor);
  const maxRet = filtered.length > 0 ? Math.max(...allVals, 50) : 200;
  const minRet = filtered.length > 0 ? Math.min(...allVals, -25) : -50;
  const yMax = Math.ceil(maxRet / 25) * 25;
  const yMin = Math.floor(minRet / 25) * 25;
  const y = (v: number) => PAD_T + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
  const yZero = y(0);

  const yTicks: number[] = [];
  for (let v = Math.ceil(yMin / 25) * 25; v <= yMax; v += 25) yTicks.push(v);

  // X-axis labels: if many windows, monthly; if few, per-day
  const xTicks = useMemo(() => {
    if (filtered.length === 0) return [] as Array<{ i: number; label: string }>;
    if (filtered.length >= 80) {
      const seen = new Set<string>();
      const ticks: Array<{ i: number; label: string }> = [];
      for (let i = 0; i < filtered.length; i++) {
        const ym = filtered[i].start_date.slice(0, 7);
        if (!seen.has(ym)) { seen.add(ym); ticks.push({ i, label: ym }); }
      }
      return ticks;
    }
    const step = Math.max(1, Math.floor(filtered.length / 8));
    const ticks: Array<{ i: number; label: string }> = [];
    for (let i = 0; i < filtered.length; i += step) ticks.push({ i, label: filtered[i].start_date.slice(5) });
    if (ticks.length > 0 && ticks[ticks.length - 1].i !== filtered.length - 1) {
      ticks.push({ i: filtered.length - 1, label: filtered[filtered.length - 1].start_date.slice(5) });
    }
    return ticks;
  }, [filtered]);

  // Summary
  const fSummary = useMemo(() => {
    if (filtered.length === 0) return null;
    const pos = filtered.filter((r) => r.return_pct > 0).length;
    const dbl = filtered.filter((r) => r.return_pct >= 100).length;
    const kil = filtered.filter((r) => r.killed).length;
    const mean = filtered.reduce((s, r) => s + r.return_pct, 0) / filtered.length;
    const sorted = filtered.map((r) => r.return_pct).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return { n: filtered.length, pos, dbl, kil, mean, median };
  }, [filtered]);

  // Emit the filtered summary to the parent so KPI cards above the chart can
  // recompute when filters change. Maps fSummary's internal naming to the
  // exported FilteredSummary shape.
  useEffect(() => {
    if (!onSummaryChange) return;
    if (fSummary == null) { onSummaryChange(null); return; }
    onSummaryChange({
      n: fSummary.n, positive: fSummary.pos, doubled: fSummary.dbl, killed: fSummary.kil,
      median: fSummary.median, mean: fSummary.mean,
    });
  }, [fSummary, onSummaryChange]);

  const bestIdx = filtered.length > 0 ? filtered.reduce((b, _r, i) => filtered[i].return_pct > filtered[b].return_pct ? i : b, 0) : -1;
  const worstIdx = filtered.length > 0 ? filtered.reduce((b, _r, i) => filtered[i].return_pct < filtered[b].return_pct ? i : b, 0) : -1;
  // Moving avg + best/worst markers always show; we compute them over the
  // currently filtered set. The legend swatch for the moving avg also always
  // shows so users know what the yellow line is.
  const showOverlays = true;

  const handleBarMouseMove = (e: React.MouseEvent, r: WindowResult) => {
    const box = chartContainerRef.current?.getBoundingClientRect();
    if (!box) return;
    setHoverXY({ x: e.clientX - box.left, y: e.clientY - box.top });
    setHover(r);
  };

  // Density classifier for the hover tooltip
  function densityLabel(n: number): { label: string; color: string } {
    if (n === 0) return { label: "dry (no trades)", color: "#71717a" };
    if (n < 10) return { label: "sparse", color: "#fb923c" };
    if (n < 30) return { label: "moderate", color: "#fbbf24" };
    return { label: "active", color: "#10b981" };
  }

  return (
    <>
      <div className="border border-zinc-800 rounded-md bg-zinc-900/40 p-4 mb-6">
        <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
          <div className="text-xs uppercase tracking-wider text-zinc-500">{windowDays}-day return by start date - daily granularity</div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Killswitch scenario toggle - one button per scenario shipped from the script. */}
            {scenarios.length > 1 && (
              <div className="flex items-center gap-1 border border-zinc-800 rounded bg-zinc-950 p-0.5">
                <span className="text-[10px] uppercase tracking-wider text-zinc-500 px-2">Killswitch DD</span>
                {scenarios.map((s) => {
                  const selected = s.key === scenarioKey;
                  const palette = s.is_live
                    ? (selected ? "bg-emerald-600/30 text-emerald-200 border border-emerald-700/60" : "text-zinc-400 hover:text-zinc-100 border border-transparent")
                    : (selected ? "bg-amber-600/30 text-amber-200 border border-amber-700/60" : "text-zinc-400 hover:text-zinc-100 border border-transparent");
                  return (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => setScenarioKey(s.key)}
                      className={`text-xs font-mono px-2.5 py-1 rounded transition-colors ${palette}`}
                    >{s.label}</button>
                  );
                })}
              </div>
            )}
            {/* Month filter */}
            <div className="relative" ref={monthFilterRef}>
              <button
                type="button"
                onClick={() => { setMonthDropdownOpen((o) => !o); setAgentDropdownOpen(false); }}
                className="bg-zinc-950 border border-zinc-800 rounded px-3 py-1.5 text-xs text-zinc-100 font-mono hover:border-zinc-600 focus:outline-none focus:border-zinc-500 flex items-center gap-2"
              >
                <span>Months: {monthLabel}</span>
                <svg width="10" height="10" viewBox="0 0 10 10" className="text-zinc-500"><path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
              </button>
              {monthDropdownOpen && (
                <div className="absolute right-0 top-full mt-1 z-30 bg-zinc-950 border border-zinc-800 rounded-md shadow-lg min-w-[220px] py-1">
                  <div className="flex items-center gap-1 px-3 py-1.5 border-b border-zinc-800">
                    <button
                      type="button"
                      onClick={() => setSelectedMonths(new Set(allMonths))}
                      className="text-[10px] text-zinc-300 hover:text-emerald-300 font-mono uppercase tracking-wider border border-zinc-700 hover:border-emerald-700 rounded px-2 py-1"
                    >Select all</button>
                    <button
                      type="button"
                      onClick={() => setSelectedMonths(new Set())}
                      className="text-[10px] text-zinc-300 hover:text-rose-300 font-mono uppercase tracking-wider border border-zinc-700 hover:border-rose-700 rounded px-2 py-1"
                    >Select none</button>
                  </div>
                  {allMonths.map((m) => {
                    const n = liveResults.filter((r) => r.start_date.startsWith(m)).length;
                    return (
                      <label key={m} className="flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-900 cursor-pointer text-xs text-zinc-200 font-mono">
                        <input type="checkbox" checked={selectedMonths.has(m)} onChange={() => toggleMonth(m)} />
                        <span>{fmtMonth(m)} <span className="text-zinc-500">({n})</span></span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Strategy filter */}
            <div className="relative" ref={agentFilterRef}>
              <button
                type="button"
                onClick={() => { setAgentDropdownOpen((o) => !o); setMonthDropdownOpen(false); }}
                className="bg-zinc-950 border border-zinc-800 rounded px-3 py-1.5 text-xs text-zinc-100 font-mono hover:border-zinc-600 focus:outline-none focus:border-zinc-500 flex items-center gap-2"
              >
                <span>Strategies: {agentLabel}</span>
                <svg width="10" height="10" viewBox="0 0 10 10" className="text-zinc-500"><path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
              </button>
              {agentDropdownOpen && (
                <div className="absolute right-0 top-full mt-1 z-30 bg-zinc-950 border border-zinc-800 rounded-md shadow-lg min-w-[260px] py-1">
                  <div className="flex items-center gap-1 px-3 py-1.5 border-b border-zinc-800">
                    <button
                      type="button"
                      onClick={() => setSelectedAgents(new Set(agentNames))}
                      className="text-[10px] text-zinc-300 hover:text-emerald-300 font-mono uppercase tracking-wider border border-zinc-700 hover:border-emerald-700 rounded px-2 py-1"
                    >Select all</button>
                    <button
                      type="button"
                      onClick={() => setSelectedAgents(new Set())}
                      className="text-[10px] text-zinc-300 hover:text-rose-300 font-mono uppercase tracking-wider border border-zinc-700 hover:border-rose-700 rounded px-2 py-1"
                    >Select none</button>
                  </div>
                  <div className="px-3 py-1.5 border-b border-zinc-800 text-[10px] text-zinc-500 font-mono leading-relaxed">
                    Show windows where AT LEAST ONE checked strategy placed at least one trade.
                  </div>
                  {agentNames.map((name) => {
                    const i = agentNames.indexOf(name);
                    const nActive = liveResults.filter((r) => r.agent_entries[i] > 0).length;
                    return (
                      <label key={name} className="flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-900 cursor-pointer text-xs text-zinc-200 font-mono">
                        <input type="checkbox" checked={selectedAgents.has(name)} onChange={() => toggleAgent(name)} />
                        <span>{name} <span className="text-zinc-500">(fired in {nActive} windows)</span></span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {!isLiveSelected && (
          <div className="text-xs text-amber-300/90 font-mono mb-2 border border-amber-900/40 bg-amber-950/15 rounded px-3 py-2 leading-relaxed">
            <span className="font-bold uppercase tracking-wider">What-if view:</span> showing {activeScenario.label} instead of the live {(scenarios.find((s) => s.is_live)?.ks_pct ?? 25)}% threshold. The bot rides through deeper dips (or any dip, in the &quot;no killswitch&quot; case) instead of cutting losses early. Not what actually ran in production.
          </div>
        )}
        {fSummary ? (
          <div className="text-xs text-zinc-400 font-mono mb-2">
            {fSummary.n} windows in current view -
            median {fSummary.median >= 0 ? "+" : ""}{fSummary.median.toFixed(1)}%,
            mean {fSummary.mean >= 0 ? "+" : ""}{fSummary.mean.toFixed(1)}%,
            {" "}positive {((fSummary.pos / fSummary.n) * 100).toFixed(0)}%,
            {" "}doubled {((fSummary.dbl / fSummary.n) * 100).toFixed(0)}%,
            {" "}killed {((fSummary.kil / fSummary.n) * 100).toFixed(0)}%
          </div>
        ) : (
          <div className="text-xs text-rose-400 font-mono mb-2">No windows in current selection. Open a filter and pick at least one.</div>
        )}

        <div className="relative" ref={chartContainerRef}>
          {filtered.length > 0 ? (
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" style={{ display: "block" }}>
              <line x1={PAD_L} y1={yZero} x2={W - PAD_R} y2={yZero} stroke="#a1a1aa" strokeWidth={1.5} strokeDasharray="4 3" />
              <text x={PAD_L - 8} y={yZero + 3} fill="#d4d4d8" fontSize={10} fontFamily="ui-monospace, monospace" textAnchor="end" fontWeight="bold">0%</text>

              <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={H - PAD_B} stroke="#52525b" />
              {yTicks.filter((v) => v !== 0).map((v) => (
                <g key={`y-${v}`}>
                  <line x1={PAD_L - 4} y1={y(v)} x2={PAD_L} y2={y(v)} stroke="#52525b" />
                  <text x={PAD_L - 8} y={y(v) + 3} fill="#71717a" fontSize={10} fontFamily="ui-monospace, monospace" textAnchor="end">{v > 0 ? "+" : ""}{v}%</text>
                  <line x1={PAD_L} y1={y(v)} x2={W - PAD_R} y2={y(v)} stroke="#27272a" strokeWidth={0.5} />
                </g>
              ))}

              {filtered.map((r, i) => {
                const cx = PAD_L + colW * (i + 0.5);
                const barW = Math.max(2, colW * 0.85);
                const isInFlight = r.in_flight ?? false;
                // For in-flight bars with all agents selected, the bar shows
                // the projection median; otherwise it shows the observed (or
                // complete-window) return.
                const displayPct = isInFlight && allAgents && r.projection_p50_pct != null
                  ? r.projection_p50_pct
                  : r.return_pct;
                const isPositive = displayPct >= 0;
                const top = isPositive ? y(displayPct) : yZero;
                const bottom = isPositive ? yZero : y(displayPct);
                const height = Math.max(0.5, bottom - top);
                const fill = r.killed ? "#a855f7" : (isPositive ? "#10b981" : "#f43f5e");
                const isHovered = hover?.start_ts === r.start_ts;
                return (
                  <rect
                    key={`b-${i}`}
                    x={cx - barW / 2}
                    y={top}
                    width={barW}
                    height={height}
                    fill={fill}
                    opacity={isInFlight ? (isHovered ? 0.7 : 0.4) : (isHovered ? 1 : 0.85)}
                    stroke={isInFlight ? "#fbbf24" : (isHovered ? "#fff" : "none")}
                    strokeWidth={isInFlight ? 1 : (isHovered ? 1.5 : 0)}
                    strokeDasharray={isInFlight && !isHovered ? "3 2" : undefined}
                    onMouseMove={(e) => handleBarMouseMove(e, r)}
                    onMouseLeave={() => setHover(null)}
                    style={{ cursor: "crosshair" }}
                  />
                );
              })}

              {/* P10-P90 confidence whiskers on in-flight bars (only meaningful when all strategies selected) */}
              {filtered.map((r, i) => {
                if (!r.in_flight || !allAgents) return null;
                if (r.projection_p10_pct == null || r.projection_p90_pct == null) return null;
                const cx = PAD_L + colW * (i + 0.5);
                const yP10 = y(r.projection_p10_pct);
                const yP90 = y(r.projection_p90_pct);
                const capW = Math.max(3, colW * 0.5);
                return (
                  <g key={`err-${i}`} pointerEvents="none" opacity={0.75}>
                    <line x1={cx} y1={yP10} x2={cx} y2={yP90} stroke="#fbbf24" strokeWidth={1.25} />
                    <line x1={cx - capW / 2} y1={yP90} x2={cx + capW / 2} y2={yP90} stroke="#fbbf24" strokeWidth={1.25} />
                    <line x1={cx - capW / 2} y1={yP10} x2={cx + capW / 2} y2={yP10} stroke="#fbbf24" strokeWidth={1.25} />
                  </g>
                );
              })}

              {showOverlays && filtered.length >= 14 && (() => {
                const win = 14;
                const path: string[] = [];
                for (let i = 0; i < filtered.length; i++) {
                  const lo = Math.max(0, i - win + 1);
                  const slice = filtered.slice(lo, i + 1);
                  const avg = slice.reduce((s, r) => s + r.return_pct, 0) / slice.length;
                  const cx = PAD_L + colW * (i + 0.5);
                  path.push(`${i === 0 ? "M" : "L"} ${cx.toFixed(1)} ${y(avg).toFixed(1)}`);
                }
                return <path d={path.join(" ")} stroke="#fbbf24" strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={0.9} pointerEvents="none" />;
              })()}

              <line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} stroke="#52525b" />
              {xTicks.map((t) => {
                const cx = PAD_L + colW * (t.i + 0.5);
                return (
                  <g key={`x-${t.i}`}>
                    <line x1={cx} y1={H - PAD_B} x2={cx} y2={H - PAD_B + 4} stroke="#a1a1aa" />
                    <text x={cx} y={H - PAD_B + 14} fill="#a1a1aa" fontSize={10} fontFamily="ui-monospace, monospace" textAnchor="middle">{t.label}</text>
                  </g>
                );
              })}
              <text x={PAD_L + plotW / 2} y={H - 14} fill="#a1a1aa" fontSize={11} fontFamily="ui-monospace, monospace" textAnchor="middle">
                Start date (each window runs {windowDays} days from this date) - hover for detail
              </text>
              <text x={16} y={PAD_T + plotH / 2} fill="#a1a1aa" fontSize={11} fontFamily="ui-monospace, monospace" textAnchor="middle" transform={`rotate(-90, 16, ${PAD_T + plotH / 2})`}>{windowDays}-day return (%)</text>

              {showOverlays && bestIdx >= 0 && (() => {
                const cxBest = PAD_L + colW * (bestIdx + 0.5);
                return (
                  <g pointerEvents="none">
                    <circle cx={cxBest} cy={y(filtered[bestIdx].return_pct)} r={4} fill="none" stroke="#fbbf24" strokeWidth={2} />
                    <text x={cxBest} y={y(filtered[bestIdx].return_pct) - 10} fill="#fde047" fontSize={10} fontFamily="ui-monospace, monospace" textAnchor="middle" fontWeight="bold">best +{filtered[bestIdx].return_pct.toFixed(0)}%</text>
                  </g>
                );
              })()}
              {showOverlays && worstIdx >= 0 && filtered[worstIdx].return_pct < 0 && (() => {
                const cxWorst = PAD_L + colW * (worstIdx + 0.5);
                return (
                  <g pointerEvents="none">
                    <circle cx={cxWorst} cy={y(filtered[worstIdx].return_pct)} r={4} fill="none" stroke="#f87171" strokeWidth={2} />
                    <text x={cxWorst} y={y(filtered[worstIdx].return_pct) + 18} fill="#fca5a5" fontSize={10} fontFamily="ui-monospace, monospace" textAnchor="middle" fontWeight="bold">worst {filtered[worstIdx].return_pct.toFixed(0)}%</text>
                  </g>
                );
              })()}
            </svg>
          ) : (
            <div className="h-[400px] flex items-center justify-center text-zinc-500 text-sm font-mono">Nothing matches the current filter. Use Select all in one of the dropdowns to reset.</div>
          )}

          {hover && (() => {
            const d = densityLabel(hover.n_entries);
            const TOOLTIP_W = 380;
            // Recompute return for selected subset (matches what the bar shows)
            const eff = effectiveOf(hover);
            const showRet = eff.ret_pct;
            const showFinal = eff.final;
            const isInFlight = hover.in_flight ?? false;
            const daysObs = hover.days_observed ?? 0;
            const daysLeft = 60 - daysObs;
            const p10 = hover.projection_p10_pct, p50 = hover.projection_p50_pct, p90 = hover.projection_p90_pct;
            const hasProjection = isInFlight && allAgents && p10 != null && p50 != null && p90 != null;
            return (
              <div
                className="absolute pointer-events-none bg-zinc-950/95 border border-zinc-700 rounded-md px-3 py-2 text-xs font-mono shadow-lg z-20 whitespace-nowrap"
                style={{
                  width: TOOLTIP_W,
                  left: Math.min(hoverXY.x + 12, (chartContainerRef.current?.clientWidth ?? 1000) - TOOLTIP_W - 10),
                  top: Math.max(0, hoverXY.y - 110),
                }}
              >
                <div className="text-zinc-100 font-bold mb-1 flex items-center gap-2">
                  <span>{hover.start_date} -&gt; {hover.end_date}</span>
                  {isInFlight && <span className="text-[10px] uppercase tracking-wider text-amber-300 bg-amber-950/40 border border-amber-700/50 rounded px-1.5 py-0.5">in flight</span>}
                </div>
                {isInFlight ? (
                  <>
                    <div className="text-amber-200/90">Day {daysObs} of 60 - {daysLeft} day{daysLeft === 1 ? "" : "s"} to go</div>
                    <div className={showRet >= 0 ? "text-emerald-400" : "text-rose-400"}>
                      Observed so far: <strong>{showRet >= 0 ? "+" : ""}{showRet.toFixed(2)}%</strong> (${showFinal.toFixed(0)}{allAgents ? "" : ` on $${effectiveStart.toFixed(0)} subset alloc`})
                    </div>
                    {hasProjection ? (
                      <div className="text-zinc-300 mt-1 leading-relaxed">
                        Projected final: <strong className={p50! >= 0 ? "text-emerald-300" : "text-rose-300"}>{p50! >= 0 ? "+" : ""}{p50!.toFixed(1)}%</strong>
                        <span className="text-zinc-500"> band P10 to P90: </span>
                        <span className={p10! >= 0 ? "text-emerald-400" : "text-rose-400"}>{p10! >= 0 ? "+" : ""}{p10!.toFixed(1)}%</span>
                        <span className="text-zinc-500"> to </span>
                        <span className={p90! >= 0 ? "text-emerald-400" : "text-rose-400"}>{p90! >= 0 ? "+" : ""}{p90!.toFixed(1)}%</span>
                      </div>
                    ) : (
                      <div className="text-zinc-500 mt-1 leading-relaxed">Projection available only with all strategies selected.</div>
                    )}
                  </>
                ) : (
                  <div className={showRet >= 0 ? "text-emerald-400" : "text-rose-400"}>
                    Return: <strong>{showRet >= 0 ? "+" : ""}{showRet.toFixed(2)}%</strong> (${showFinal.toFixed(0)}{allAgents ? "" : ` on $${effectiveStart.toFixed(0)} subset alloc`})
                  </div>
                )}
                <div className="text-zinc-400 mt-1 flex items-center gap-1.5">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: d.color }} />
                  <span>{hover.n_entries} trades ({d.label})  |  max DD {hover.max_drawdown_pct.toFixed(1)}%</span>
                </div>
                <div className="text-zinc-400">
                  Lowest equity: ${hover.lowest_equity.toFixed(0)}
                </div>
                {hover.killed && (
                  <div className="text-purple-400 font-bold mt-1">KILLSWITCH FIRED on day {hover.killed_day}{hover.killed_by_mtm ? " (MTM)" : ""}</div>
                )}
                <div className="border-t border-zinc-800 mt-1 pt-1 text-zinc-400">
                  {agentNames.map((name, k) => (
                    <div key={k}>
                      {name}: <span className={hover.agent_pnl[k] >= 0 ? "text-emerald-400" : "text-rose-400"}>{hover.agent_pnl[k] >= 0 ? "+" : ""}${hover.agent_pnl[k].toFixed(0)}</span>
                      <span className="text-zinc-600"> ({hover.agent_wins[k]}W / {hover.agent_losses[k]}L of {hover.agent_entries[k]})</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>

        <div className="flex flex-wrap gap-4 mt-3 text-xs text-zinc-400 font-mono">
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded" style={{ background: "#10b981" }} /> positive {windowDays}-day window</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded" style={{ background: "#f43f5e" }} /> negative</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded" style={{ background: "#a855f7" }} /> killswitch fired</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded border border-amber-500 border-dashed" style={{ background: "rgba(16,185,129,0.35)" }} /> in flight (projection median)</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3" style={{ borderLeft: "1.5px solid #fbbf24", borderTop: "1.5px solid #fbbf24", borderBottom: "1.5px solid #fbbf24" }} /> P10-P90 confidence band</span>
          {showOverlays && <span className="flex items-center gap-1.5"><span className="inline-block w-6 h-0.5" style={{ background: "#fbbf24" }} /> 14-day rolling average</span>}
          <span className="text-zinc-500 ml-2">- hover any bar for trade count + per-strategy P&amp;L</span>
        </div>
        <div className="flex flex-wrap gap-4 mt-2 text-xs text-zinc-400 font-mono">
          <span className="text-zinc-500 uppercase tracking-wider text-[10px]">Tooltip trade-count chip:</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: "#71717a" }} /> dry (0 trades)</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: "#fb923c" }} /> sparse (1-9)</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: "#fbbf24" }} /> moderate (10-29)</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: "#10b981" }} /> active (30+)</span>
        </div>
      </div>

      {/* Per-window detail table, also filtered */}
      <div className="border border-zinc-800 rounded-md bg-zinc-900/40 p-5 mb-6">
        <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
          <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
            Per-window detail ({filtered.length} of {liveResults.length} windows, newest first)
            <span className={`text-[10px] normal-case tracking-normal font-mono px-2 py-0.5 rounded border ${isLiveSelected ? "text-emerald-300 border-emerald-700/50 bg-emerald-950/30" : "text-amber-300 border-amber-700/50 bg-amber-950/30"}`}>
              showing {activeScenario.label}
            </span>
          </h2>
          <div className="flex items-center gap-3 text-xs font-mono">
            {!isLiveSelected && divergentDates.size > 0 && (
              <label className="flex items-center gap-1.5 text-amber-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={onlyDivergent}
                  onChange={(e) => setOnlyDivergent(e.target.checked)}
                />
                <span>Only differing rows ({divergentDates.size})</span>
              </label>
            )}
            <span className="text-zinc-500">scrollable - filtered by dropdowns above</span>
          </div>
        </div>
        {!isLiveSelected && divergentDates.size > 0 && !onlyDivergent && (
          <div className="text-xs text-zinc-500 font-mono mb-3 border-l-2 border-amber-700/50 pl-3 py-1">
            Only {divergentDates.size} of {filtered.length} rows actually differ between scenarios - those are the windows that hit the 25% killswitch. Rows below highlighted with an amber bar on the left are the ones that changed; everything else runs the same engine path regardless of threshold.
          </div>
        )}
        {filtered.length === 0 ? (
          <div className="text-zinc-500 text-sm font-mono py-6 text-center">No windows match the current filters. Use Select all in either dropdown to reset.</div>
        ) : (
          <div className="overflow-auto border border-zinc-800 rounded" style={{ maxHeight: 520 }}>
            <table className="text-xs w-full font-mono">
              <thead className="sticky top-0 bg-zinc-900 z-10">
                <tr className="text-[10px] uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
                  <th className="text-left py-2 px-2">Start</th>
                  <th className="text-left py-2 px-2">End</th>
                  <th className="text-right py-2 px-2">Trades</th>
                  <th className="text-right py-2 px-2">Final</th>
                  <th className="text-right py-2 px-2">Return</th>
                  <th className="text-right py-2 px-2">Max DD</th>
                  <th className="text-right py-2 px-2">Lowest</th>
                  <th className="text-center py-2 px-2">Killed</th>
                  {agentNames.map((n) => <th key={n} className="text-right py-2 px-2">{n}</th>)}
                </tr>
              </thead>
              <tbody>
                {filtered.slice().reverse()
                  .filter((r) => !onlyDivergent || divergentDates.has(r.start_date))
                  .map((r, i) => {
                  const isDivergent = !isLiveSelected && divergentDates.has(r.start_date);
                  const cls = r.killed ? "text-purple-300 bg-purple-950/20" : r.return_pct >= 100 ? "text-emerald-300" : r.return_pct >= 0 ? "text-zinc-200" : "text-rose-400";
                  const divergentBar = isDivergent ? "border-l-2 border-l-amber-500 bg-amber-950/10" : "";
                  return (
                    <tr key={r.start_date} className={`border-b border-zinc-800/50 ${cls} ${divergentBar}`}>
                      <td className="py-1 px-2">{r.start_date}</td>
                      <td className="py-1 px-2 text-zinc-500">{r.end_date}</td>
                      <td className="py-1 px-2 text-right">{r.n_entries}</td>
                      <td className="py-1 px-2 text-right">${r.final_equity.toFixed(0)}</td>
                      <td className={`py-1 px-2 text-right font-bold ${r.return_pct >= 0 ? "" : "text-rose-400"}`}>{r.return_pct >= 0 ? "+" : ""}{r.return_pct.toFixed(1)}%</td>
                      <td className="py-1 px-2 text-right text-zinc-500">{r.max_drawdown_pct.toFixed(1)}%</td>
                      <td className="py-1 px-2 text-right text-zinc-500">${r.lowest_equity.toFixed(0)}</td>
                      <td className="py-1 px-2 text-center">{r.killed ? "K" : ""}</td>
                      {r.agent_pnl.map((p, k) => (
                        <td key={k} className={`py-1 px-2 text-right ${p >= 0 ? "text-emerald-400" : "text-rose-400"}`}>${p.toFixed(0)}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
