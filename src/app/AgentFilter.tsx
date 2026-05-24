"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// Multi-select dropdown for filtering the recent-decisions table by agent.
// URL contract:
//   no `agents` param  -> all agents shown (default)
//   ?agents=a,b,c      -> only those agents shown
// Toggling brings you back to "all" when every box is checked.

export function AgentFilter({ allAgents }: { allAgents: string[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const raw = searchParams.get("agents");
  const selected = raw === null ? new Set(allAgents) : new Set(raw.split(",").filter(Boolean));

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  function setUrl(newSelected: Set<string>): void {
    const params = new URLSearchParams(searchParams.toString());
    if (newSelected.size === allAgents.length) params.delete("agents");
    else if (newSelected.size === 0) params.set("agents", "__none__"); // sentinel for "nothing"
    else params.set("agents", [...newSelected].join(","));
    const qs = params.toString();
    router.push(qs ? `/?${qs}` : "/");
  }

  function toggle(a: string): void {
    const next = new Set(selected);
    if (next.has(a)) next.delete(a);
    else next.add(a);
    setUrl(next);
  }

  function selectAll(): void { setUrl(new Set(allAgents)); }
  function selectNone(): void { setUrl(new Set()); }

  const label =
    selected.size === allAgents.length
      ? `All agents (${allAgents.length})`
      : selected.size === 0
        ? "No agents selected"
        : `${selected.size} of ${allAgents.length} agents`;

  return (
    <div ref={ref} className="relative inline-block text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="px-3 py-1 rounded border border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-500 flex items-center gap-2"
      >
        <span>{label}</span>
        <span className="text-zinc-500">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-2 z-30 w-64 bg-zinc-900 border border-zinc-700 rounded shadow-2xl p-2">
          <div className="flex items-center justify-between px-2 py-1 border-b border-zinc-800 mb-1">
            <button onClick={selectAll} className="text-emerald-400 hover:text-emerald-300">Select all</button>
            <button onClick={selectNone} className="text-zinc-400 hover:text-zinc-200">Clear</button>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {allAgents.map((a) => (
              <label
                key={a}
                className="flex items-center gap-2 px-2 py-1 hover:bg-zinc-800 rounded cursor-pointer text-zinc-200"
              >
                <input
                  type="checkbox"
                  checked={selected.has(a)}
                  onChange={() => toggle(a)}
                  className="accent-emerald-500"
                />
                <span>{a}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
