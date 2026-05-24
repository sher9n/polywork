"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type AgentRow = {
  id: string; name: string; status: string; phase: string; health: string;
  starting_bankroll: number; current_bankroll: number; peak_bankroll: number;
  trades_count: number; wins_count: number; losses_count: number;
  kelly_mult: number; max_pct_per_trade: number;
  wr_prior_initial: number | null;
  phase_entered_at: number; paused_at: number | null; paused_reason: string | null;
  watch_since: number | null; broken_since: number | null;
  last_health_check_at: number | null;
  strategy: { description?: string; wr_prior?: number };
  open_count: number; committed: number; unrealized: number;
};

export type HuntRunRow = {
  id: number; ts: number; hunt_type: string;
  n_phase1_pass: number; n_final_pass: number;
  result_json: { winners?: Array<unknown>; phase1_top?: Array<unknown> };
  notes: string | null;
};

export type HealthLogRow = {
  id: number; agent_id: string; ts: number;
  prev_health: string | null; new_health: string;
  actual_wr: number | null; prior_wr: number | null;
  n_settled: number | null; drawdown_pct: number | null;
  reason: string | null;
};

type Props = {
  agents: AgentRow[];
  hunts: HuntRunRow[];
  healthLog: HealthLogRow[];
};

const IST_TZ = "Asia/Kolkata";
function fmtIst(ts: number): string {
  if (!ts) return "n/a";
  return new Date(ts).toLocaleString("en-IN", { timeZone: IST_TZ, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" });
}

function HealthBadge({ health }: { health: string }) {
  const color = health === "healthy" ? "bg-emerald-700/40 text-emerald-200 border-emerald-700/60"
              : health === "watch"   ? "bg-amber-700/40 text-amber-200 border-amber-700/60"
              : health === "broken"  ? "bg-rose-700/40 text-rose-200 border-rose-700/60"
              : "bg-zinc-700/40 text-zinc-300 border-zinc-700/60";
  return <span className={`inline-block text-[10px] uppercase tracking-wider font-mono px-2 py-0.5 rounded border ${color}`}>{health}</span>;
}

function PhaseBadge({ phase }: { phase: string }) {
  const color = phase === "live_full" ? "bg-emerald-700/30 text-emerald-200 border-emerald-700/50"
              : phase === "live_small" ? "bg-emerald-900/40 text-emerald-300 border-emerald-800/50"
              : phase === "paper" ? "bg-blue-700/30 text-blue-200 border-blue-700/50"
              : phase === "watch" ? "bg-zinc-700/30 text-zinc-300 border-zinc-700/50"
              : "bg-zinc-800/30 text-zinc-400 border-zinc-800/50";
  return <span className={`inline-block text-[10px] uppercase tracking-wider font-mono px-2 py-0.5 rounded border ${color}`}>{phase}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const color = status === "active" ? "bg-emerald-700/40 text-emerald-200 border-emerald-700/60"
              : status === "paused" ? "bg-amber-700/40 text-amber-200 border-amber-700/60"
              : status === "killed" ? "bg-rose-700/40 text-rose-200 border-rose-700/60"
              : "bg-zinc-700/40 text-zinc-400 border-zinc-700/60";
  return <span className={`inline-block text-[10px] uppercase tracking-wider font-mono px-2 py-0.5 rounded border ${color}`}>{status}</span>;
}

export function LabClient({ agents, hunts, healthLog }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function act(agentId: string, action: string) {
    setBusy(`${agentId}:${action}`);
    try {
      const res = await fetch(`/api/lab/agent/${agentId}/action`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const txt = await res.text();
        alert(`Action failed: ${txt}`);
      } else {
        router.refresh();
      }
    } catch (e) {
      alert(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const active = agents.filter((a) => a.status === "active");
  const paused = agents.filter((a) => a.status === "paused");
  const archived = agents.filter((a) => a.status === "archived" || a.status === "killed");

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">Live agent lab</h1>
        <p className="text-sm text-zinc-400 leading-relaxed">
          Live agent health, lifecycle controls (paper -&gt; live_small -&gt; live_full), and nightly-hunt inventory. Health is auto-computed every 10 min from rolling-30d actual WR vs prior. Agents in BROKEN state for 14+ days auto-pause. Health changes are logged; emails fire if POLYWORK_EMAIL_ENABLED is on.
        </p>
      </div>

      {/* Active agents */}
      <div className="mb-8">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400 mb-3">Active ({active.length})</h2>
        {active.length === 0 ? (
          <div className="text-zinc-500 text-sm font-mono py-4">No active agents.</div>
        ) : (
          <div className="space-y-3">
            {active.map((a) => <AgentCard key={a.id} agent={a} onAction={act} busy={busy} />)}
          </div>
        )}
      </div>

      {/* Paused agents */}
      {paused.length > 0 && (
        <div className="mb-8">
          <h2 className="text-sm font-bold uppercase tracking-wider text-amber-400 mb-3">Paused ({paused.length})</h2>
          <div className="space-y-3">
            {paused.map((a) => <AgentCard key={a.id} agent={a} onAction={act} busy={busy} />)}
          </div>
        </div>
      )}

      {/* Archived / killed (collapsed by default) */}
      {archived.length > 0 && (
        <div className="mb-8">
          <details>
            <summary className="text-sm font-bold uppercase tracking-wider text-zinc-500 mb-3 cursor-pointer hover:text-zinc-300">Archived / killed ({archived.length})</summary>
            <div className="space-y-2 mt-3">
              {archived.map((a) => (
                <div key={a.id} className="border border-zinc-800/50 rounded bg-zinc-900/20 px-3 py-2 text-xs font-mono text-zinc-500 flex items-center gap-3">
                  <span className="font-bold">{a.name}</span>
                  <StatusBadge status={a.status} />
                  <span className="text-zinc-600">trades {a.trades_count} &middot; W/L {a.wins_count}/{a.losses_count}</span>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}

      {/* Recent health changes */}
      <div className="mb-8">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400 mb-3">Recent health transitions</h2>
        {healthLog.length === 0 ? (
          <div className="text-zinc-500 text-sm font-mono py-4">No transitions yet. Health is checked every 10 min by the runtime; first checks need 15+ settled positions per agent.</div>
        ) : (
          <div className="border border-zinc-800 rounded-md bg-zinc-900/40 overflow-auto" style={{ maxHeight: 360 }}>
            <table className="text-xs w-full font-mono">
              <thead className="sticky top-0 bg-zinc-900 z-10">
                <tr className="text-[10px] uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
                  <th className="text-left py-2 px-2">when</th>
                  <th className="text-left py-2 px-2">agent</th>
                  <th className="text-left py-2 px-2">transition</th>
                  <th className="text-right py-2 px-2">actual WR</th>
                  <th className="text-right py-2 px-2">prior WR</th>
                  <th className="text-right py-2 px-2">n</th>
                  <th className="text-right py-2 px-2">DD%</th>
                  <th className="text-left py-2 px-2">reason</th>
                </tr>
              </thead>
              <tbody>
                {healthLog.map((h) => (
                  <tr key={h.id} className="border-b border-zinc-800/50">
                    <td className="py-1 px-2 text-zinc-500">{fmtIst(h.ts)}</td>
                    <td className="py-1 px-2">{h.agent_id}</td>
                    <td className="py-1 px-2 font-bold">
                      {h.prev_health ?? "-"} <span className="text-zinc-600">-&gt;</span> {h.new_health}
                    </td>
                    <td className="py-1 px-2 text-right">{h.actual_wr !== null ? (h.actual_wr * 100).toFixed(1) + "%" : "-"}</td>
                    <td className="py-1 px-2 text-right text-zinc-500">{h.prior_wr !== null ? (h.prior_wr * 100).toFixed(1) + "%" : "-"}</td>
                    <td className="py-1 px-2 text-right text-zinc-500">{h.n_settled ?? "-"}</td>
                    <td className="py-1 px-2 text-right text-zinc-500">{h.drawdown_pct !== null ? h.drawdown_pct.toFixed(1) + "%" : "-"}</td>
                    <td className="py-1 px-2 text-zinc-400">{h.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Hunt inventory */}
      <div>
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400 mb-3">Recent hunt runs</h2>
        {hunts.length === 0 ? (
          <div className="text-zinc-500 text-sm font-mono py-4">No hunt runs logged yet. Schedule the nightly cron to populate.</div>
        ) : (
          <div className="space-y-2">
            {hunts.map((h) => (
              <div key={h.id} className="border border-zinc-800 rounded-md bg-zinc-900/30 px-3 py-2 text-xs font-mono text-zinc-300">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-bold text-emerald-300">{h.hunt_type}</span>
                  <span className="text-zinc-500">{fmtIst(h.ts)}</span>
                </div>
                <div className="text-zinc-400">phase1 pass: {h.n_phase1_pass} &middot; final pass: {h.n_final_pass}</div>
                {h.notes && <div className="text-zinc-500 mt-1">{h.notes}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentCard({ agent, onAction, busy }: { agent: AgentRow; onAction: (id: string, action: string) => void; busy: string | null }) {
  const equity = agent.current_bankroll + agent.committed + agent.unrealized;
  const pnl = equity - agent.starting_bankroll;
  const pnlPct = agent.starting_bankroll > 0 ? (pnl / agent.starting_bankroll) * 100 : 0;
  const wr = (agent.wins_count + agent.losses_count) > 0
    ? (agent.wins_count / (agent.wins_count + agent.losses_count)) * 100
    : null;
  const priorWr = agent.strategy?.wr_prior;
  const isBusy = (action: string) => busy === `${agent.id}:${action}`;
  const anyBusy = busy !== null;

  return (
    <div className={`border rounded-md p-4 ${agent.health === "broken" ? "border-rose-900/60 bg-rose-950/10" : agent.health === "watch" ? "border-amber-900/40 bg-amber-950/10" : "border-zinc-800 bg-zinc-900/40"}`}>
      <div className="flex items-baseline justify-between mb-2 gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-base">{agent.name}</span>
          <StatusBadge status={agent.status} />
          <PhaseBadge phase={agent.phase} />
          <HealthBadge health={agent.health} />
        </div>
        <div className="flex items-center gap-2 flex-wrap text-xs font-mono">
          {agent.phase === "watch" && (
            <button disabled={anyBusy} onClick={() => onAction(agent.id, "promote_to_paper")} className="px-2 py-1 border border-blue-700/50 text-blue-200 rounded hover:bg-blue-900/30 disabled:opacity-30">→ paper</button>
          )}
          {agent.phase === "paper" && (
            <button disabled={anyBusy} onClick={() => onAction(agent.id, "promote_to_live_small")} className="px-2 py-1 border border-emerald-800/50 text-emerald-300 rounded hover:bg-emerald-900/30 disabled:opacity-30">→ live_small</button>
          )}
          {agent.phase === "live_small" && (
            <button disabled={anyBusy} onClick={() => onAction(agent.id, "promote_to_live_full")} className="px-2 py-1 border border-emerald-700/60 text-emerald-200 rounded hover:bg-emerald-900/40 disabled:opacity-30">→ live_full</button>
          )}
          {(agent.phase === "live_full" || agent.phase === "live_small") && (
            <button disabled={anyBusy} onClick={() => onAction(agent.id, "demote")} className="px-2 py-1 border border-zinc-700 text-zinc-400 rounded hover:bg-zinc-900 disabled:opacity-30">demote</button>
          )}
          {agent.status === "active" && (
            <button disabled={anyBusy} onClick={() => onAction(agent.id, "pause")} className="px-2 py-1 border border-amber-700/50 text-amber-200 rounded hover:bg-amber-900/30 disabled:opacity-30">pause</button>
          )}
          {agent.status === "paused" && (
            <button disabled={anyBusy} onClick={() => onAction(agent.id, "resume")} className="px-2 py-1 border border-emerald-700/50 text-emerald-200 rounded hover:bg-emerald-900/30 disabled:opacity-30">resume</button>
          )}
          {agent.phase !== "retired" && (
            <button disabled={anyBusy} onClick={() => { if (confirm(`Retire ${agent.name}?`)) onAction(agent.id, "retire"); }} className="px-2 py-1 border border-rose-800/50 text-rose-300 rounded hover:bg-rose-900/30 disabled:opacity-30">retire</button>
          )}
        </div>
      </div>

      <div className="text-xs text-zinc-400 mb-2 font-mono">{agent.strategy?.description ?? "(no description)"}</div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-xs font-mono">
        <Stat label="Cash" value={`$${agent.current_bankroll.toFixed(2)}`} />
        <Stat label="Committed" value={`$${agent.committed.toFixed(2)}`} />
        <Stat label="Unrealized" value={`${agent.unrealized >= 0 ? "+" : "-"}$${Math.abs(agent.unrealized).toFixed(2)}`} valueColor={agent.unrealized >= 0 ? "text-emerald-300" : "text-rose-300"} />
        <Stat label="Equity" value={`$${equity.toFixed(2)}`} />
        <Stat label="P&L" value={`${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`} valueColor={pnl >= 0 ? "text-emerald-300" : "text-rose-300"} />
        <Stat label="Open / settled" value={`${agent.open_count} / ${agent.wins_count + agent.losses_count}`} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-xs font-mono mt-2">
        <Stat label="W / L" value={`${agent.wins_count} / ${agent.losses_count}`} />
        <Stat label="Actual WR" value={wr !== null ? `${wr.toFixed(1)}%` : "-"} valueColor={wr !== null && priorWr !== undefined ? (Math.abs(wr / 100 - priorWr) <= 0.03 ? "text-emerald-300" : wr / 100 < priorWr ? "text-rose-300" : "text-zinc-200") : "text-zinc-500"} />
        <Stat label="Prior WR" value={priorWr !== undefined ? `${(priorWr * 100).toFixed(1)}%` : "-"} />
        <Stat label="Kelly mult" value={agent.kelly_mult.toFixed(2)} />
        <Stat label="Max % / trade" value={`${(agent.max_pct_per_trade * 100).toFixed(0)}%`} />
        <Stat label="Last check" value={fmtIst(agent.last_health_check_at ?? 0)} />
      </div>

      {agent.paused_reason && (
        <div className="mt-2 text-xs text-amber-300 font-mono">paused: {agent.paused_reason}</div>
      )}
      {agent.broken_since && (
        <div className="mt-1 text-xs text-rose-400 font-mono">BROKEN since {fmtIst(agent.broken_since)} - auto-pause at 14 days if not recovered</div>
      )}
      {agent.watch_since && agent.health === "watch" && (
        <div className="mt-1 text-xs text-amber-400 font-mono">WATCH since {fmtIst(agent.watch_since)} - position sizing halved</div>
      )}
    </div>
  );
}

function Stat({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="border border-zinc-800/50 rounded bg-zinc-950/40 px-2 py-1">
      <div className="text-[9px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`text-xs font-bold ${valueColor ?? "text-zinc-200"}`}>{value}</div>
    </div>
  );
}
