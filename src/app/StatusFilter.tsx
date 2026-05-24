"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const OPTIONS: Array<{ value: "all" | "active" | "resolved"; label: string }> = [
  { value: "all", label: "All decisions" },
  { value: "active", label: "Active only" },
  { value: "resolved", label: "Resolved only" },
];

export function StatusFilter() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = (searchParams.get("status") ?? "all").toLowerCase();
  const currentOpt = OPTIONS.find((o) => o.value === current) ?? OPTIONS[0];

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  function select(value: string): void {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "all") params.delete("status");
    else params.set("status", value);
    const qs = params.toString();
    router.push(qs ? `/?${qs}` : "/");
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative inline-block text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="px-3 py-1 rounded border border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-500 flex items-center gap-2"
      >
        <span>{currentOpt.label}</span>
        <span className="text-zinc-500">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-2 z-30 w-44 bg-zinc-900 border border-zinc-700 rounded shadow-2xl p-1">
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => select(o.value)}
              className={`w-full text-left px-2 py-1 rounded hover:bg-zinc-800 ${
                current === o.value ? "text-emerald-400" : "text-zinc-200"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
