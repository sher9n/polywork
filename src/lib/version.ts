// Commit SHA + build/boot metadata. Railway injects RAILWAY_GIT_COMMIT_SHA
// automatically on every deploy. We read it once at module load so both
// the web service and worker can report the exact same value via /api/version
// and worker logs.

export const COMMIT_SHA =
  process.env.RAILWAY_GIT_COMMIT_SHA ??
  process.env.GIT_COMMIT_SHA ??
  process.env.VERCEL_GIT_COMMIT_SHA ??
  "unknown";

export const COMMIT_SHORT = COMMIT_SHA.slice(0, 7);

export const SERVICE_NAME =
  process.env.RAILWAY_SERVICE_NAME ?? process.env.SERVICE_NAME ?? "polywork";

export const DEPLOYMENT_ID =
  process.env.RAILWAY_DEPLOYMENT_ID ?? process.env.DEPLOYMENT_ID ?? null;

export const ENVIRONMENT =
  process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "development";

export const BOOTED_AT_MS = Date.now();
