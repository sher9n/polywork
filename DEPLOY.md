# Polywork deployment

## Architecture on Railway

Two long-running services + one cron, all reading the same Postgres:

| Service | Start command | What it does |
|---|---|---|
| `web` | `npm run start:web` | Next.js dashboard + API routes. Runs `npm run migrate` on boot. Healthcheck at `/api/health`. |
| `worker` | `npm run start:worker` | The 30s polling loop that ingests trades, dispatches to agents, settles resolved positions, and writes equity snapshots. |
| `cron:ingest-markets` | `npm run ingest:markets` | Weekly market universe refresh (Sun 03:00 UTC). |

Healthcheck: `/api/health` returns 200 when the DB is reachable AND the worker has written a snapshot in the last 90 minutes.

## Verifying a deploy

After `git push`, both services rebuild. Confirm the new commit is live:

```sh
curl -s https://<your-domain>/api/version | jq '{commit_short, role, environment, uptime_seconds}'
```

The `commit_short` should match `git rev-parse --short HEAD`. Until it does, the deploy is still rolling.

The worker logs its commit on boot:
```
[runtime] polywork worker booting · service=worker env=production commit=<short>
```

## Auth

All read endpoints (`/api/agents`, `/api/decisions`, `/api/version`, `/api/health`, dashboard pages) are public.

Mutating endpoints (currently just `POST /api/lab/agent/[id]/action`) require:
```
Authorization: Bearer <POLYWORK_ADMIN_TOKEN>
```

Generate the token once:
```sh
openssl rand -hex 32
```
Set it as `POLYWORK_ADMIN_TOKEN` in Railway (same value on both web and worker services, even though the worker doesn't read it — keep them aligned for consistency).

If the env var is missing or shorter than 16 chars, mutations return 503. This is intentional fail-closed behavior.

## Environment variables

See `.env.example` for the full list. Required in production:
- `POLYWORK_DB_URL` (Railway Postgres injects this; alias from `DATABASE_URL` if needed)
- `POLYWORK_ADMIN_TOKEN` (for the lab page)
- `NODE_ENV=production`

Optional:
- `POLYMARKET_WS_ENABLED=true` for real-time trade stream (lower latency, polling fallback always runs)
- `POLYWORK_EMAIL_ENABLED=true` + `RESEND_API_KEY` + `POLYWORK_EMAIL_FROM` + `POLYWORK_EMAIL_TO` for health alerts

## Database

Production DB contains only what the live runtime needs:
- `markets`, `_migrations`
- `live_trades`, `live_market_state`, `live_equity_snapshots`
- `paper_agents`, `paper_positions`, `paper_decisions`
- `strategies`, `strategy_health_log`, `strategy_hunt_runs`, `notification_log`

The large `trades` table (~9.8M rows of historical Polymarket trades used by backtest scripts) lives only on the local research DB. Backtests are research-only and run locally.

## Migrations

Idempotent: `tsx src/db/migrate.ts` reads `src/db/migrations/*.sql`, applies any whose filename isn't in `_migrations` table. The web service runs this on every boot via `start:web`.

## Operations

### View logs
Railway dashboard → service → Deployments → Logs.

### Restart the worker
Railway dashboard → worker service → Restart.

### Rotate the admin token
1. Generate new token: `openssl rand -hex 32`
2. Update `POLYWORK_ADMIN_TOKEN` in Railway (both services)
3. Both services restart automatically; old token stops working immediately

### Redeploy
`git push` to main. Railway auto-deploys both services.

### Pause trading
Set `paper_agents.status = 'paused'` for any agent, or use the lab page mutation endpoint with your admin token.

## Local development

```sh
# .env.local already configured with local Postgres
npm install
npm run dev              # web on :3000
npm run live             # worker (in a separate terminal)
```
