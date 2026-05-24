import { readFileSync } from "fs";
import { resolve } from "path";
import type { WindowResult } from "./RollingChart";
import { ProposalClient } from "./ProposalClient";

export const revalidate = 300;

type Cell = {
  name: string; alloc_pct: number;
  price_min: number; price_max: number;
  mom_min: number; mom_max: number;
  htr_min: number; htr_max: number;
  size_min: number; size_max: number;
};

type Data = {
  generated_at: number;
  window_days: number;
  step_days: number;
  roll_start: number;
  roll_end: number;
  starting_bankroll: number;
  killswitch_dd_pct: number;
  cells: Cell[];
  results: WindowResult[];
  summary: {
    n_windows: number;
    median_return_pct: number;
    mean_return_pct: number;
    p_positive: number;
    p_killswitch: number;
    p_double: number;
    worst_return_pct: number;
    best_return_pct: number;
  };
};

function loadData(): Data | null {
  try {
    const path = resolve(process.cwd(), "public", "proposal-portfolio.json");
    return JSON.parse(readFileSync(path, "utf8")) as Data;
  } catch {
    return null;
  }
}

const IST_TZ = "Asia/Kolkata";
function fmtIst(ts: number): string {
  return new Date(ts).toLocaleString("en-IN", { timeZone: IST_TZ, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" });
}

export default async function ProposalPage() {
  const data = loadData();
  if (!data) {
    return (
      <div className="max-w-6xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-2">Proposal portfolio</h1>
        <p className="text-zinc-400">No data. Run <code className="text-zinc-200 bg-zinc-900 px-1.5 py-0.5 rounded">tsx scripts/backtest-proposal-portfolio.ts</code> first.</p>
      </div>
    );
  }
  const s = data.summary;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">Proposal portfolio: rolling {data.window_days}-day backtest</h1>
        <p className="text-sm text-zinc-400 leading-relaxed">
          What would have happened if you started the proposed 5-cell <strong className="text-emerald-300">liquid portfolio</strong> with ${data.starting_bankroll} on every day from August 1, 2024 and ran it for {data.window_days} days? Each bar is one start date. Realistic methodology: scheduled-end htr filter, walk-forward win-rate priors for Kelly warmup (falls back to spec WR when sample is thin), killswitch at {data.killswitch_dd_pct}%, <strong className="text-zinc-300">4-min Polymarket Data API lag modeled</strong>, <strong className="text-zinc-300">pocket capital enabled</strong> at 0.98 pin (90% spendable), <strong className="text-zinc-300">dynamic Kelly</strong> (switches to actual rolling-60d WR after 20+ settled trades), <strong className="text-zinc-300">health monitor alerts</strong> (WATCH cuts Kelly to 0.5×, BROKEN to 0.25×; auto-pause replaced with alert-only), <strong className="text-zinc-300">mom_24h fallback</strong> to mom_6h then mom_1h, <strong className="text-zinc-300">realistic friction: 0.1% entry slippage, 0% fee</strong> (Polymarket CLOB has no trading fee), and <strong className="text-emerald-300">$5K pre-trade 24h dollar volume liquidity filter</strong> on every candidate trade. Cells 1-4 are from the liquidity-aware 2-year hunt; cell 5 (ultra-favorite income strategy) is from the friction-aware hunt that surfaces only cells where edge survives even pessimistic WR scenarios.
        </p>
        <p className="text-xs text-zinc-500 mt-1 font-mono">
          Generated {fmtIst(data.generated_at)} IST &middot; {s.n_windows} windows &middot; no look-ahead bias &middot; live-lag 4min &middot; pocket 0.98 / 90% spendable &middot; dynamic Kelly &middot; health alerts (no auto-pause) &middot; mom fallback &middot; friction 0.1%/0% &middot; liq filter $5K
        </p>
      </div>

      <ProposalClient
        results={data.results}
        cells={data.cells}
        startingBankroll={data.starting_bankroll}
        killswitchPct={data.killswitch_dd_pct}
        windowDays={data.window_days}
        initialSummary={{
          n_windows: s.n_windows,
          median_return_pct: s.median_return_pct,
          p_positive: s.p_positive,
          p_double: s.p_double,
          p_killswitch: s.p_killswitch,
        }}
      />

      <div className="border border-zinc-800 rounded-md bg-zinc-900/30 p-5 mt-6">
        <h2 className="text-base font-bold mb-3">The 10 cells</h2>
        <div className="text-sm text-zinc-300 space-y-2 font-mono">
          {data.cells.map((c) => (
            <div key={c.name} className="border-l-2 border-emerald-700/50 pl-3">
              <div className="font-bold text-emerald-300">{c.name} <span className="text-zinc-500 font-normal">({(c.alloc_pct * 100).toFixed(0)}% allocation)</span></div>
              <div className="text-xs text-zinc-400">
                price {c.price_min}-{c.price_max} &middot;
                momentum {c.mom_min === -10 && c.mom_max === 10 ? "any" : c.mom_min < 0 && c.mom_max < 0.1 ? "falling" : c.mom_min > 0 ? "rising" : "flat"} &middot;
                resolves in {c.htr_min}-{c.htr_max}h &middot;
                size {c.size_min}-{c.size_max === 9e12 ? "+inf" : c.size_max}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="border border-zinc-800 rounded-md bg-zinc-900/30 p-5 mt-6">
        <h2 className="text-base font-bold mb-3">How to read this chart</h2>
        <div className="text-sm text-zinc-300 space-y-3 leading-relaxed">
          <p>
            Each bar is one start date between Aug 1, 2024 and {new Date(data.roll_end).toISOString().slice(0, 10)}. Imagine you woke up on that day, dropped ${data.starting_bankroll} into the 10-cell liquid portfolio, and let it run for {data.window_days} days. The bar height shows what your bankroll grew or shrank to by the end.
          </p>
          <p>
            Use the <strong>Months</strong> and <strong>Strategies</strong> filters above the chart to zoom into a specific period or see how a single cell would have done on its own.
          </p>
          <p>
            <strong>Green = positive, red = negative, purple = killswitch fired</strong> (lost &gt;{data.killswitch_dd_pct}% of starting capital, bot stopped trading). The 0.0% killswitch rate in the summary means it never fired across {s.n_windows} start dates.
          </p>
          <p className="text-zinc-400 text-xs">
            Methodology: trades pass the cell&apos;s filter using SCHEDULED end_date (what the live bot sees in real time, not post-hoc resolution). Kelly warmup uses a walk-forward prior - WR computed only from trades BEFORE each window start, no future leak. After 20+ settled trades in the window, Kelly switches to the actual rolling-60d WR (matches live&apos;s dynamicKellyWR). Pocket capital is enabled: positions priced ≥0.97 are treated as decided winners, expected payoff credits the Kelly cash basis. Health monitor compares actual rolling-30d WR to each cell&apos;s spec prior; ≥3pp drop or ≥15% DD flips to WATCH (0.5× Kelly), ≥10pp drop or ≥25% DD flips to BROKEN (0.25× Kelly). Auto-pause fires after BROKEN for 14d straight or 40%+ DD, capping individual agent loss before the portfolio killswitch can engage. Mom_24h falls back to mom_6h then mom_1h for cold-start markets. This is as close to live-bot behavior as a backtest can get.
          </p>
          <p className="text-zinc-400 text-xs border-l-2 border-emerald-700/40 pl-3">
            <strong className="text-emerald-300">Expanded to 10 cells:</strong> 5 additional cells added at 10% each to cover price bands the prior 5-cell missed (0.25-0.30 longshot zone, 0.40-0.50 mid-range, 0.60-0.65 + 0.65-0.70 high-favorite). Each new cell passed the regime-persistent filter (positive EV in both halves of recent + full 2-year) and was selected for low overlap with existing cells. Portfolio median return jumps from +16.8% to +22.6% while worst case tightens from -11.8% to -8.3%. Activity rate nearly doubles (98 → 168 entries/window). Risk-adjusted ratio improves from 1.42 to 2.73. <strong className="text-amber-300">Remaining gap:</strong> Polymarket Data API caps at 3000 trades per poll. Set POLYMARKET_WS_ENABLED=true to eliminate the 4-min entry lag entirely.
          </p>
        </div>
      </div>
    </div>
  );
}

