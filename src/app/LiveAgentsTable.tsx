"use client";

import { useEffect, useState } from "react";
import { agentMeta, Tooltip } from "@/lib/agents";
import type { AgentState } from "@/lib/agents-data";

const REFRESH_MS = 15_000;

function pnlCellClass(cents: number): string {
  if (cents > 0) return "up";
  if (cents < 0) return "down";
  return "text-zinc-400";
}
function pnlText(cents: number): string {
  if (cents === 0) return "$0.00";
  return `${cents > 0 ? "+" : "-"}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function LiveAgentsTable({ initial }: { initial: AgentState[] }) {
  const [rows, setRows] = useState<AgentState[]>(initial);

  useEffect(() => {
    const tick = async () => {
      try {
        const resp = await fetch("/api/agents", { cache: "no-store" });
        if (!resp.ok) return;
        const data = (await resp.json()) as { rows: AgentState[] };
        if (Array.isArray(data.rows)) setRows(data.rows);
      } catch { /* ignore network blips */ }
    };
    const id = setInterval(tick, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const active = rows.filter((a) => a.status === "active").length;

  return (
    <>
      <table className="w-full text-sm">
        <thead className="text-xs text-zinc-500 uppercase">
          <tr>
            <th className="text-left py-1">Agent</th>
            <th className="text-right">Start</th>
            <th className="text-right">Cash</th>
            <th className="text-right">Open</th>
            <th className="text-right">Committed</th>
            <th className="text-right">Current</th>
            <th className="text-right">Equity</th>
            <th className="text-right">P&L</th>
            <th className="text-right">Trades</th>
            <th className="text-right">W/L</th>
            <th className="text-right">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const pnl = a.equity - a.starting_bankroll;
            const pnlCents = Math.round(pnl * 100);
            const unCents = Math.round(a.unrealized_pnl * 100);
            const meta = agentMeta(a.name);
            return (
              <tr key={a.name} className="border-t border-zinc-900">
                <td className="py-1">
                  <Tooltip content={meta.desc}>{meta.display}</Tooltip>
                </td>
                <td className="text-right num text-zinc-500">${a.starting_bankroll.toFixed(0)}</td>
                <td className="text-right num">${a.current_bankroll.toFixed(2)}</td>
                <td className="text-right num">{a.open_positions}</td>
                <td className="text-right num text-zinc-500">${a.committed.toFixed(2)}</td>
                <td className={`text-right num font-semibold ${pnlCellClass(unCents)}`}>{pnlText(unCents)}</td>
                <td className="text-right num font-semibold">${a.equity.toFixed(2)}</td>
                <td className={`text-right num font-semibold ${pnlCellClass(pnlCents)}`}>{pnlText(pnlCents)}</td>
                <td className="text-right num">{a.trades_count}</td>
                <td className="text-right num text-zinc-500">{a.wins_count}/{a.losses_count}</td>
                <td className={`text-right ${a.status === "active" ? "up" : a.status === "killed" ? "down" : "text-zinc-500"}`}>{a.status}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-xs text-zinc-500 mt-2">
        Active: {active} / {rows.length}. Polling Polymarket every 30s. Current = unrealized P&L on open positions, refreshes every {REFRESH_MS / 1000}s. Killswitch at -25% loss from starting bankroll per agent.
      </p>
    </>
  );
}
