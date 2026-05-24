// Tiny migration runner. Apply NNNN_*.sql files in order; track in _migrations.

import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

const MIGRATIONS_DIR = path.join(process.cwd(), "src", "db", "migrations");
const DB_URL = process.env.POLYWORK_DB_URL ?? "postgresql:///polywork";

async function main(): Promise<void> {
  const sql = postgres(DB_URL);
  await sql`CREATE TABLE IF NOT EXISTS _migrations (id integer PRIMARY KEY, name text NOT NULL, applied_at bigint NOT NULL)`;
  const applied = await sql<Array<{ id: number }>>`SELECT id FROM _migrations`;
  const appliedIds = new Set(applied.map((r) => r.id));

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();

  let appliedCount = 0;
  let skippedCount = 0;
  for (const f of files) {
    const m = /^(\d+)_/.exec(f)!;
    const id = Number(m[1]);
    if (appliedIds.has(id)) {
      skippedCount++;
      continue;
    }
    console.log(`[migrate] applying ${f}`);
    const body = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
    await sql.unsafe(body);
    await sql`INSERT INTO _migrations (id, name, applied_at) VALUES (${id}, ${f}, ${Date.now()})`;
    appliedCount++;
  }
  console.log(`[migrate] done: applied=${appliedCount} skipped=${skippedCount}`);
  await sql.end();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
