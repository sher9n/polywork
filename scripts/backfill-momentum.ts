// Backfill 24+ hours of price history into live_trades so the momentum-based
// agents (ride_ryan, leap_liam) can fire immediately.
//
// Run: tsx scripts/backfill-momentum.ts

import postgres from "postgres";
import * as dotenv from "dotenv";
import { ensureMomentumHistory } from "../src/lib/momentum-backfill";

dotenv.config({ path: ".env.local" });

(async () => {
  const sql = postgres(process.env.POLYWORK_DB_URL ?? "postgresql:///polywork");
  const t0 = Date.now();
  const stats = await ensureMomentumHistory(sql);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`done in ${elapsed}s:`);
  console.log(`  markets checked:      ${stats.markets_checked}`);
  console.log(`  already had 24h data: ${stats.markets_skipped}`);
  console.log(`  backfilled:           ${stats.markets_backfilled}`);
  console.log(`  failed:               ${stats.markets_failed}`);
  console.log(`  synthetic trades:     ${stats.synthetic_trades_inserted}`);
  await sql.end();
})().catch((e) => { console.error(e); process.exit(1); });
