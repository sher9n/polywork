import "./globals.css";
import Link from "next/link";
import { sql } from "@/lib/db";

export const metadata = {
  title: "polywork",
  description: "Polymarket strategy lab",
};

async function getTotalEquity(): Promise<{ total_start: number; total_equity: number }> {
  try {
    const rows = await sql<Array<{ total_start: number; total_equity: number }>>`
      SELECT
        COALESCE(SUM(pa.starting_bankroll), 0)::float8 AS total_start,
        COALESCE(SUM(
          pa.current_bankroll
          + COALESCE((SELECT SUM(stake) FROM paper_positions WHERE agent_id = pa.id AND status = 'open'), 0)
        ), 0)::float8 AS total_equity
      FROM paper_agents pa WHERE pa.status = 'active'
    `;
    return rows[0] ?? { total_start: 0, total_equity: 0 };
  } catch {
    return { total_start: 0, total_equity: 0 };
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { total_start, total_equity } = await getTotalEquity();
  const pnl = total_equity - total_start;
  const pnlCents = Math.round(pnl * 100);
  const pnlPct = total_start > 0 ? (pnl / total_start) * 100 : 0;
  const pctRounded = Math.round(pnlPct * 10) / 10;
  const pnlClass = pnlCents > 0 ? "up" : pnlCents < 0 ? "down" : "text-zinc-400";
  const pnlText = pnlCents === 0 ? "$0.00" : `${pnlCents > 0 ? "+" : "-"}$${(Math.abs(pnlCents) / 100).toFixed(2)}`;
  const pctText = pctRounded === 0 ? "0.0%" : `${pctRounded > 0 ? "+" : ""}${pctRounded.toFixed(1)}%`;
  return (
    <html lang="en">
      <body className="bg-zinc-950 text-zinc-100 min-h-screen font-mono">
        <nav className="border-b border-zinc-800 bg-zinc-950/90 backdrop-blur sticky top-0 z-50">
          <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-6">
              <Link href="/" className="text-xl font-bold hover:text-emerald-400 transition-colors">polywork</Link>
              <div className="flex items-center gap-4 text-sm">
                <Link href="/" className="text-zinc-400 hover:text-zinc-100 transition-colors">Dashboard</Link>
                <Link href="/proposal" className="text-zinc-400 hover:text-zinc-100 transition-colors">Proposal</Link>
                <Link href="/lab" className="text-zinc-400 hover:text-zinc-100 transition-colors">Lab</Link>
                <Link href="/thoughts" className="text-zinc-400 hover:text-zinc-100 transition-colors">Thoughts</Link>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">Total equity</div>
              <div className="flex items-baseline gap-2 justify-end">
                <span className={`text-lg font-bold num ${pnlClass}`}>${total_equity.toFixed(2)}</span>
                <span className={`text-xs num ${pnlClass}`}>{pnlText} ({pctText})</span>
              </div>
            </div>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
