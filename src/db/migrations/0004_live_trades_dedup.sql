-- Deduplicate live_trades and prevent future duplicates from worker restarts.
--
-- Bug: the in-memory shouldDispatch() map and the backfill's try/catch swallow
-- depend on a UNIQUE constraint that never existed. Every worker restart
-- replayed the last 10 min of trades AND re-ran momentum backfill on cold
-- markets, both producing duplicate rows. A single backfilled market had been
-- inserted 6 times by the time we noticed.

-- Step 1: drop existing duplicates, keeping the lowest id per group.
DELETE FROM live_trades
WHERE id NOT IN (
  SELECT MIN(id) FROM live_trades
  GROUP BY condition_id, ts, outcome, side, price, size, taker
);

-- Step 2: unique index. NULLS NOT DISTINCT (PG15+) so two rows that both have
-- taker=NULL still collide. Covers real trades (taker = wallet address) and
-- synthetic backfill trades (taker = 'backfill').
CREATE UNIQUE INDEX IF NOT EXISTS idx_live_trades_unique
  ON live_trades (condition_id, ts, outcome, side, price, size, taker)
  NULLS NOT DISTINCT;

-- migrate.ts records this file in _migrations after the body runs; no manual
-- INSERT needed (and it would conflict with the runner's INSERT).
