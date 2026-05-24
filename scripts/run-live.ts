// Live paper-trading worker. Polls Polymarket feed, dispatches to agents,
// places paper buys, settles when markets resolve, prints a live console
// dashboard (when stdout is a TTY) or compact log lines (in Railway/prod).
//
// Run locally:  tsx scripts/run-live.ts
// Run on Railway: same command, but stdout is non-TTY so we skip the
// fullscreen render and just log per-tick stats.

import * as dotenv from "dotenv";
// Load .env.local only in dev; in Railway / prod, env vars are injected by
// the platform so this is a no-op (the file does not exist there).
dotenv.config({ path: ".env.local" });

import { sql } from "../src/lib/db";
import { runtimeLoop, loadAgents, dispatchOneTrade } from "../src/lib/live-runtime";
import { ensureMomentumHistory } from "../src/lib/momentum-backfill";
import { createWsClient } from "../src/lib/polymarket-ws";
import { COMMIT_SHORT, COMMIT_SHA, ENVIRONMENT, SERVICE_NAME } from "../src/lib/version";

const IS_TTY = Boolean(process.stdout.isTTY);

function fmt$(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}k`;
  return `${sign}$${abs.toFixed(2)}`;
}

function clearScreen(): void {
  if (!IS_TTY) return;
  process.stdout.write("\x1b[2J\x1b[H");
}

type RenderRow = {
  name: string;
  status: string;
  starting_bankroll: number;
  current_bankroll: number;   // cash only
  peak_bankroll: number;      // historical peak equity (cash + committed)
  committed: number;          // stake basis of open positions
  unrealized: number;         // MTM unrealized P&L on open positions
  trades_count: number;
  wins_count: number;
  losses_count: number;
};

async function render(): Promise<void> {
  // In Railway/prod stdout is not a TTY. Skip the fullscreen dashboard so
  // logs stay readable; runtimeLoop's per-tick log line is enough.
  if (!IS_TTY) return;
  // Equity-aware agent snapshot. peak_bankroll is the historic high of
  // (cash + committed); current equity = cash + committed + unrealized. The
  // earlier query showed only cash for "BANKROLL" / "DD%" which made open
  // positions look like losses. Same formula as recordEquitySnapshot in
  // live-runtime.ts and fetchAgentStates in src/lib/agents-data.ts.
  const all = await sql<RenderRow[]>`
    WITH pos AS (
      SELECT
        pp.agent_id,
        COALESCE(SUM(pp.stake) FILTER (WHERE pp.status='open'), 0)::float8 AS committed,
        COALESCE(SUM(
          CASE WHEN pp.status='open' THEN
            pp.shares * COALESCE(
              CASE pp.outcome WHEN 'YES' THEN lms.current_yes_price ELSE lms.current_no_price END,
              pp.entry_price
            ) - pp.stake
          ELSE 0 END
        ), 0)::float8 AS unrealized
      FROM paper_positions pp
      LEFT JOIN live_market_state lms ON lms.condition_id = pp.condition_id
      GROUP BY pp.agent_id
    )
    SELECT
      pa.name, pa.status,
      pa.starting_bankroll::float8,
      pa.current_bankroll::float8,
      pa.peak_bankroll::float8,
      COALESCE(pos.committed, 0)::float8 AS committed,
      COALESCE(pos.unrealized, 0)::float8 AS unrealized,
      pa.trades_count, pa.wins_count, pa.losses_count
    FROM paper_agents pa
    LEFT JOIN pos ON pos.agent_id = pa.id
    ORDER BY pa.name
  `;
  const totals = await sql<Array<{ open: number; closed: number }>>`
    SELECT
      (SELECT COUNT(*)::int FROM paper_positions WHERE status = 'open') AS open,
      (SELECT COUNT(*)::int FROM paper_positions WHERE status = 'closed') AS closed
  `;
  const recent = await sql<Array<{ ts: number; agent: string; decision: string; price: number; reason: string }>>`
    SELECT pd.ts, pa.name AS agent, pd.decision, pd.price, pd.reason
    FROM paper_decisions pd JOIN paper_agents pa ON pa.id = pd.agent_id
    WHERE pd.decision = 'BUY'
    ORDER BY pd.ts DESC LIMIT 12
  `;

  clearScreen();
  const now = new Date().toISOString().slice(0, 19) + "Z";
  console.log(`polywork live paper-trading · ${now}`);
  console.log("");
  console.log("AGENT                         EQUITY    CASH    OPEN    PEAK     DD%    TRADES   W/L      STATUS");
  console.log("─".repeat(110));
  for (const a of all) {
    const equity = a.current_bankroll + a.committed + a.unrealized;
    // Use the historical peak from DB, but ensure it never trails current equity.
    const effPeak = Math.max(a.peak_bankroll, equity);
    const dd = effPeak > 0 ? ((effPeak - equity) / effPeak) * 100 : 0;
    const wr = (a.wins_count + a.losses_count) > 0 ? (a.wins_count / (a.wins_count + a.losses_count)) * 100 : 0;
    const pnl = equity - a.starting_bankroll;
    const pnlStr = fmt$(pnl);
    const openCommitStr = `$${a.committed.toFixed(2)}`;
    console.log(
      `${a.name.padEnd(27)} $${equity.toFixed(2).padStart(7)} $${a.current_bankroll.toFixed(2).padStart(7)} ${openCommitStr.padStart(7)}  $${effPeak.toFixed(2).padStart(6)}  ${dd.toFixed(1).padStart(4)}%  ${String(a.trades_count).padStart(5)}  ${(a.wins_count + "/" + a.losses_count).padStart(7)}  ${a.status.padEnd(7)} (${pnlStr})`,
    );
  }
  const totalEquity = all.reduce((s, a) => s + a.current_bankroll + a.committed + a.unrealized, 0);
  const totalCash = all.reduce((s, a) => s + a.current_bankroll, 0);
  const totalCommitted = all.reduce((s, a) => s + a.committed, 0);
  const totalStart = all.reduce((s, a) => s + a.starting_bankroll, 0);
  console.log("─".repeat(110));
  console.log(`TOTAL                       $${totalEquity.toFixed(2).padStart(7)} $${totalCash.toFixed(2).padStart(7)} $${totalCommitted.toFixed(2).padStart(7)}  start=$${totalStart}  net=${fmt$(totalEquity - totalStart)}  open=${totals[0].open}  closed=${totals[0].closed}`);
  console.log("");
  console.log("RECENT BUYS:");
  for (const r of recent) {
    const ago = Math.round((Date.now() - r.ts) / 1000);
    console.log(`  ${ago}s ago  ${r.agent.padEnd(27)} @${r.price.toFixed(3)}  ${r.reason.slice(0, 60)}`);
  }
  console.log("");
  console.log("polling every 30s · ctrl+c to stop");
}

// Fail fast on missing critical env. In prod the DB URL MUST be set; the
// dev fallback (postgresql:///polywork) is a footgun if it ever ships.
if (ENVIRONMENT === "production" && !process.env.POLYWORK_DB_URL) {
  console.error("[runtime] FATAL: POLYWORK_DB_URL not set in production");
  process.exit(1);
}

// Graceful shutdown: when Railway sends SIGTERM (redeploy, restart), give
// the in-flight tick a moment to finish, then close the DB pool. Without
// this, mid-write transactions get killed and we leak a postgres connection.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[runtime] received ${signal}, shutting down...`);
  // Give the loop up to 5s to notice shuttingDown and exit cleanly.
  setTimeout(() => {
    console.error("[runtime] forced exit after 5s grace period");
    process.exit(1);
  }, 5000).unref();
  try {
    await sql.end({ timeout: 4 });
  } catch (e) {
    console.error(`[runtime] error closing DB: ${(e as Error).message}`);
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (e) => {
  console.error(`[runtime] unhandledRejection: ${(e as Error)?.message ?? e}`);
});

void (async () => {
  console.log(`[runtime] polywork worker booting · service=${SERVICE_NAME} env=${ENVIRONMENT} commit=${COMMIT_SHORT} full=${COMMIT_SHA}`);
  try {
    // Make sure we have 24h+ of price history in live_trades so the
    // momentum-based agents can fire on day one. Idempotent: skips
    // markets that already have data.
    console.log("[runtime] ensuring momentum history exists...");
    const stats = await ensureMomentumHistory(sql);
    console.log(`[runtime] backfill: ${stats.markets_backfilled} backfilled, ${stats.markets_skipped} already had data, ${stats.synthetic_trades_inserted} synthetic trades inserted`);

    // Optional Polymarket CLOB WebSocket. Eliminates the ~4-min Data API lag
    // by streaming trade events in real time. Enable with POLYMARKET_WS_ENABLED=true.
    // Polling loop continues as fallback; dedup via dispatchOneTrade prevents
    // double-processing.
    if (process.env.POLYMARKET_WS_ENABLED === "true") {
      // Union of all agent price bands so the WS only subscribes to relevant markets.
      const wsAgents = await loadAgents(sql);
      const priceLow = wsAgents.length > 0 ? Math.min(...wsAgents.map((a) => a.strategy.price_min)) : 0;
      const priceHigh = wsAgents.length > 0 ? Math.max(...wsAgents.map((a) => a.strategy.price_max)) : 1;
      const ws = createWsClient(sql, {
        priceLow,
        priceHigh,
        onTrade: async (msg) => {
          try {
            const agents = await loadAgents(sql);
            await dispatchOneTrade(sql, agents, {
              conditionId: msg.conditionId,
              outcome: msg.outcome,
              side: msg.side,
              price: msg.price,
              size: msg.size,
              timestamp: msg.timestamp,
              proxyWallet: msg.proxyWallet,
            });
          } catch (e) {
            console.error(`[ws] dispatch error: ${(e as Error).message}`);
          }
        },
      });
      ws.start();
      console.log("[runtime] websocket client started (POLYMARKET_WS_ENABLED=true)");
    } else {
      console.log("[runtime] websocket disabled (set POLYMARKET_WS_ENABLED=true to enable real-time stream)");
    }

    // Restart-on-crash with exponential backoff. runtimeLoop itself catches
    // per-tick errors, so a throw here means something fundamental broke
    // (DB pool died, OOM, etc.). Railway also restarts the container if
    // we exit, but that's slower; keep the worker alive in-process when
    // possible. Cap restarts to avoid hot-looping a broken deploy.
    let restarts = 0;
    const MAX_RESTARTS = 10;
    while (!shuttingDown && restarts < MAX_RESTARTS) {
      try {
        await runtimeLoop(sql, { onTick: render });
        // runtimeLoop has an infinite inner loop, so reaching here means
        // graceful exit (shuttingDown). Break.
        break;
      } catch (e) {
        restarts++;
        const wait = Math.min(60_000, 2_000 * 2 ** Math.min(restarts, 5));
        console.error(`[runtime] loop crashed (restart ${restarts}/${MAX_RESTARTS}): ${(e as Error).message}. Sleeping ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    if (restarts >= MAX_RESTARTS) {
      console.error("[runtime] FATAL: too many restarts, exiting so Railway can restart the container");
      process.exit(1);
    }
  } catch (e) {
    console.error(`[runtime] fatal boot error: ${(e as Error)?.stack ?? e}`);
    process.exit(1);
  }
})();
