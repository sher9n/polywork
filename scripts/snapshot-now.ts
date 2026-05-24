// One-shot: record a single equity snapshot right now. Useful for bootstrapping
// the /tracker page before the hourly hook in run-live.ts has fired.
//
// Run: tsx scripts/snapshot-now.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
import { recordEquitySnapshot } from "../src/lib/live-runtime";
dotenv.config({ path: ".env.local" });

const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");

(async () => {
  await recordEquitySnapshot(sql);
  const rows = await sql<Array<{ ts: number; total_equity: number; total_start: number; open_positions: number }>>`
    SELECT ts, total_equity, total_start, open_positions
    FROM live_equity_snapshots ORDER BY ts DESC LIMIT 1
  `;
  const r = rows[0];
  if (r) {
    const when = new Date(Number(r.ts)).toISOString();
    console.log(`snapshot recorded @${when}  equity=$${r.total_equity.toFixed(2)}  start=$${r.total_start.toFixed(2)}  open=${r.open_positions}`);
  }
  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
