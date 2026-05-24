import postgres from "postgres";

const DB_URL = process.env.POLYWORK_DB_URL ?? "postgresql:///polywork";

// SSL is required by Railway / most managed Postgres providers. Detect by:
//   - explicit PGSSLMODE env var, or
//   - URL pointing at anything other than localhost / a unix socket / 127.0.0.1.
// Local dev with `postgresql:///polywork` stays SSL-off.
function shouldUseSsl(url: string): boolean {
  if (process.env.PGSSLMODE === "disable") return false;
  if (process.env.PGSSLMODE && process.env.PGSSLMODE !== "disable") return true;
  try {
    const u = new URL(url);
    if (!u.hostname) return false; // unix socket
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1") return false;
    return true;
  } catch {
    return false;
  }
}

// Single shared connection; Next.js dev/prod will reuse this module.
declare global {
  var __pw_sql: ReturnType<typeof postgres> | undefined;
}

export const sql =
  globalThis.__pw_sql ??
  postgres(DB_URL, {
    max: Number(process.env.POLYWORK_DB_POOL_MAX ?? 8),
    ssl: shouldUseSsl(DB_URL) ? "require" : undefined,
    connect_timeout: 10,
    idle_timeout: 30,
  });

if (!globalThis.__pw_sql) globalThis.__pw_sql = sql;
