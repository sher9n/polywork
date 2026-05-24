// Shared agent metadata + presentation helpers used by both the server-rendered
// page.tsx and the client-side DecisionsTable component.

export const AGENT_META: Record<string, { display: string; desc: string }> = {
  near_resolution_skim: {
    display: "skim_sam",
    desc: "Buys near-certain favorites priced 90-95c within 1-5 days of resolution. Wins about 96 of every 100 trades but earns only ~9c per win. The grinder. Backtest edge: roughly 6% return per dollar staked.",
  },
  heavy_favorite_steady: {
    display: "hold_henry",
    desc: "Buys solid favorites priced 80-90c that resolve in 7-28 days. Less certain than the skimmer but pays more per win (~18c on the dollar). Wins about 88 of every 100. The slow, reliable one.",
  },
  mom_rising_mid: {
    display: "ride_ryan",
    desc: "Buys mid-priced markets (40-80c) where the price has risen 2c+ in the last 24h, resolving in 1-7 days. Wins about 67 of every 100, each win pays ~67c on the dollar. The momentum follower.",
  },
  mom_rising_longshot: {
    display: "leap_liam",
    desc: "Rare bets on cheap longshots (20-30c) trending up, resolving within 24 hours. Wins only 1 in 3, but each win pays 3x the stake. Asymmetric: small losses most of the time, occasional big wins.",
  },
};

export function agentMeta(name: string): { display: string; desc: string } {
  return AGENT_META[name] ?? { display: name, desc: "(no description)" };
}

export const DISPLAY_TO_NAME: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [tech, m] of Object.entries(AGENT_META)) map[m.display] = tech;
  return map;
})();

// Translate the internal "mom=X hrs=Y px=Z" reason into plain English.
export function prettyReason(raw: string): string {
  const mom = raw.match(/mom=([^\s]+)/)?.[1];
  const hrs = raw.match(/hrs=([^\s]+)/)?.[1];
  const parts: string[] = [];
  if (hrs && hrs !== "null") {
    const h = parseFloat(hrs);
    if (h < 1) parts.push("under 1 hour");
    else if (h < 24) parts.push(`${Math.round(h)} hours`);
    else if (h < 48) parts.push("~1 day");
    else if (h < 168) parts.push(`${Math.round(h / 24)} days`);
    else parts.push(`${Math.round(h / 168)} weeks`);
  }
  if (mom && mom !== "null") {
    const m = parseFloat(mom);
    const cents = Math.round(m * 100);
    if (cents > 0) parts.push(`>${cents}c (24h)`);
    else if (cents < 0) parts.push(`<${Math.abs(cents)}c (24h)`);
    else parts.push(`0c (24h)`);
  }
  return parts.join(" · ");
}

// CSS-only hover tooltip. Pure presentational - works in both server and client components.
export function Tooltip({ children, content }: { children: React.ReactNode; content: React.ReactNode }) {
  return (
    <span className="relative group inline-block">
      <span className="border-b border-dotted border-zinc-600">{children}</span>
      <span className="invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-opacity duration-150 absolute top-full left-0 mt-2 z-20 w-80 bg-zinc-900 border border-zinc-700 rounded p-3 text-xs text-zinc-300 shadow-2xl pointer-events-none whitespace-pre-line normal-case tracking-normal">
        {content}
      </span>
    </span>
  );
}

export type Decision = {
  ts: number;
  agent_name: string;
  decision: string;
  outcome: string | null;
  price: number | null;          // entry / "buy price"
  reason: string;
  slug: string | null;
  question: string | null;
  shares: number | null;
  stake: number | null;
  position_status: string | null;       // 'open' | 'closed' | 'voided' | null
  exit_price: number | null;
  realized_pnl: number | null;
  current_yes_price: number | null;
  current_no_price: number | null;
  resolved_outcome: string | null;
};

// Derived status used for the All / Active / Resolved filter.
//   active   = open position OR a SKIP on a market that has not resolved
//   resolved = closed position OR a SKIP on a market that HAS resolved (used to grade LLM rejections)
//   voided   = position was voided
//   killed   = the KILL row when the safety switch fired
export function derivedStatus(d: Decision): "active" | "resolved" | "voided" | "killed" {
  if (d.decision === "KILL") return "killed";
  if (d.position_status === "open") return "active";
  if (d.position_status === "closed") return "resolved";
  if (d.position_status === "voided") return "voided";
  // SKIP: derive from market resolution
  if (d.decision === "SKIP") return d.resolved_outcome ? "resolved" : "active";
  return "active";
}

// Current "fair value" of the side that was (or would have been) bought.
export function currentPrice(d: Decision): number | null {
  if (!d.outcome) return null;
  return d.outcome === "YES" ? d.current_yes_price : d.current_no_price;
}

// Unrealized or realized P&L in dollars.
//   open BUY:   shares * currentPrice - stake
//   closed BUY: realized_pnl
//   SKIP:       no P&L applicable
export function computePnl(d: Decision): number | null {
  if (d.decision === "SKIP" || d.decision === "KILL") return null;
  if (d.position_status === "closed") return d.realized_pnl;
  if (d.position_status === "voided") return 0;
  // open: mark-to-market with current price
  const cp = currentPrice(d);
  if (cp === null || d.shares === null || d.stake === null) return null;
  return d.shares * cp - d.stake;
}
