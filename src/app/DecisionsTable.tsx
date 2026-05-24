"use client";

import { useEffect, useRef, useState } from "react";
import {
  agentMeta,
  prettyReason,
  Tooltip,
  currentPrice,
  computePnl,
  derivedStatus,
  type Decision,
} from "@/lib/agents";

const PAGE_SIZE = 50;
const REFRESH_MS = 30_000;

// Truncate text to N words plus "..." if longer. Used for the Market column
// so the table stays compact and the full title is in the hover tooltip.
function firstNWords(text: string, n: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= n) return text;
  return `${words.slice(0, n).join(" ")}...`;
}

type Status = "all" | "active" | "resolved";

export function DecisionsTable({
  initial,
  initialHasMore,
  agentsFilter, // technical-name array, comma-joined for the API; null means "all"
  status,
}: {
  initial: Decision[];
  initialHasMore: boolean;
  agentsFilter: string[] | null;
  status: Status;
}) {
  const [rows, setRows] = useState<Decision[]>(initial);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Reset state when initial data changes (filter changed -> page re-rendered with fresh initial)
  useEffect(() => {
    setRows(initial);
    setHasMore(initialHasMore);
  }, [initial, initialHasMore]);

  function buildParams(offset: number, limit: number): URLSearchParams {
    const p = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    if (agentsFilter !== null) {
      p.set("agents", agentsFilter.length === 0 ? "__none__" : agentsFilter.join(","));
    }
    if (status !== "all") p.set("status", status);
    return p;
  }

  async function loadMore() {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const resp = await fetch(`/api/decisions?${buildParams(rows.length, PAGE_SIZE).toString()}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as { rows: Decision[]; hasMore: boolean };
      setRows((prev) => [...prev, ...data.rows]);
      setHasMore(data.hasMore);
    } catch (e) {
      console.error("loadMore failed:", e);
    } finally {
      setLoading(false);
    }
  }

  // Auto-load when sentinel scrolls into view
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) void loadMore(); },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, loading, rows.length]);

  // Periodic refresh: re-fetch all currently-loaded rows so prices and P&L update.
  // Uses limit = current rows.length so we get the same window back, just with fresh prices/status.
  useEffect(() => {
    const tick = async () => {
      try {
        const resp = await fetch(`/api/decisions?${buildParams(0, Math.max(rows.length, PAGE_SIZE)).toString()}`);
        if (!resp.ok) return;
        const data = (await resp.json()) as { rows: Decision[]; hasMore: boolean };
        setRows(data.rows);
        setHasMore(data.hasMore);
      } catch { /* ignore network blips */ }
    };
    const id = setInterval(tick, REFRESH_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, status, JSON.stringify(agentsFilter)]);

  return (
    <>
      <table className="w-full text-xs">
        <thead className="text-zinc-500 uppercase">
          <tr>
            <th className="text-left py-1 pr-4">When</th>
            <th className="text-left pr-4">Agent</th>
            <th className="text-right pr-4">Decision</th>
            <th className="text-right pr-4">Side</th>
            <th className="text-right pr-4">Buy price</th>
            <th className="text-right pr-4">Current price</th>
            <th className="text-right pr-4">Shares</th>
            <th className="text-right pr-4">Total</th>
            <th className="text-right pr-6">P&L</th>
            <th className="text-left pr-4">Why</th>
            <th className="text-left">Market</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d, i) => {
            const ago = Math.round((Date.now() - Number(d.ts)) / 60_000);
            const agoStr = ago < 1 ? "<1m ago" : ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
            const meta = agentMeta(d.agent_name);
            const why = prettyReason(d.reason);
            const cp = currentPrice(d);
            const pnl = computePnl(d);
            const status = derivedStatus(d);

            const pnlCents = pnl !== null ? Math.round(pnl * 100) : null;
            const pnlClass = pnlCents === null ? "text-zinc-600" : pnlCents > 0 ? "up" : pnlCents < 0 ? "down" : "text-zinc-400";
            const pnlText =
              pnlCents === null
                ? "-"
                : pnlCents === 0
                  ? "$0.00"
                  : `${pnlCents > 0 ? "+" : "-"}$${(Math.abs(pnlCents) / 100).toFixed(2)}`;

            // Decision label gets a small badge for resolved/voided/killed
            const statusBadge = status === "resolved"
              ? <span className="ml-1 px-1 rounded bg-zinc-800 text-zinc-400 text-[10px] uppercase">closed</span>
              : status === "voided"
                ? <span className="ml-1 px-1 rounded bg-zinc-800 text-zinc-500 text-[10px] uppercase">void</span>
                : null;

            return (
              <tr key={`${d.ts}-${d.agent_name}-${i}`} className="border-t border-zinc-900">
                <td className="py-1 pr-4 text-zinc-500">{agoStr}</td>
                <td className="pr-4"><Tooltip content={meta.desc}>{meta.display}</Tooltip></td>
                <td className={`text-right pr-4 whitespace-nowrap ${d.decision === "BUY" ? "up" : d.decision === "KILL" ? "down" : "text-zinc-500"}`}>
                  {d.decision}{statusBadge}
                </td>
                <td className="text-right pr-4">{d.outcome ?? "-"}</td>
                <td className="text-right num pr-4">{d.price !== null ? d.price.toFixed(3) : "-"}</td>
                <td className="text-right num pr-4 text-zinc-400">{cp !== null ? cp.toFixed(3) : "-"}</td>
                <td className="text-right num pr-4 text-zinc-400">{d.shares !== null ? d.shares.toFixed(2) : "-"}</td>
                <td className="text-right num pr-4">{d.stake !== null ? `$${d.stake.toFixed(2)}` : "-"}</td>
                <td className={`text-right num pr-6 font-semibold ${pnlClass}`}>{pnlText}</td>
                <td className="text-left text-zinc-400 truncate max-w-xs pr-4" title={d.reason}>{why}</td>
                <td className="text-left">
                  {d.slug ? (
                    <a
                      href={`https://polymarket.com/market/${d.slug}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-emerald-400 hover:text-emerald-300 hover:underline whitespace-nowrap"
                      title={d.question ?? d.slug}
                    >
                      {d.question ? firstNWords(d.question, 3) : d.slug} ↗
                    </a>
                  ) : (
                    <span className="text-zinc-600">-</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div ref={sentinelRef} className="mt-4 flex justify-center">
        {hasMore ? (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loading}
            className="px-4 py-2 text-xs rounded border border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-50"
          >
            {loading ? "Loading..." : "See more"}
          </button>
        ) : rows.length === 0 ? (
          <p className="text-xs text-zinc-500">No decisions match this filter yet.</p>
        ) : (
          <p className="text-xs text-zinc-600">end of history · {rows.length} decisions · auto-refreshes every {REFRESH_MS / 1000}s</p>
        )}
      </div>
    </>
  );
}
