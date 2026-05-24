#!/bin/bash
# launchd wrapper for the nightly pipeline:
#   1. ingest:markets        - discover new Polymarket markets opened since last run
#   2. ingest:status         - update resolution outcome on closed markets
#   3. ingest:trades         - pull new Polymarket trades into the trades table
#   4. features              - recompute mom_24h/mom_6h/mom_1h/won for new trades
#   5. run-nightly-hunt      - thin-market hunt (no liquidity filter)
#   6. run-nightly-hunt LIQ  - liquid-market hunt (pre-trade 24h vol >= $5K)
# Both hunts persist to strategy_hunt_runs under different hunt_types so we
# track drift in both worlds. Each step's exit code is captured so a failure
# doesn't silently skip downstream; we continue and flag it in the log.
PROJECT_ROOT="/Applications/MAMP/htdocs/polywork"
LOG_DIR="$PROJECT_ROOT/.cron-logs"
LOG_FILE="$LOG_DIR/nightly-hunt.log"

mkdir -p "$LOG_DIR"

# Load nvm node into PATH.
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi
export PATH="$HOME/.nvm/versions/node/v22.21.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

cd "$PROJECT_ROOT"

{
  echo ""
  echo "================================================================================"
  echo "[cron-nightly] $(date -u '+%Y-%m-%dT%H:%M:%SZ') BEGIN"
  echo "================================================================================"

  echo ""
  echo "--- step 1: ingest:markets ---"
  npx tsx scripts/ingest-markets.ts 2>&1
  MKT_EXIT=$?
  echo "--- ingest:markets exit code: $MKT_EXIT"

  echo ""
  echo "--- step 2: ingest:status ---"
  npx tsx scripts/ingest-status.ts 2>&1
  STAT_EXIT=$?
  echo "--- ingest:status exit code: $STAT_EXIT"

  echo ""
  echo "--- step 3: ingest:trades ---"
  npx tsx scripts/ingest-trades.ts 2>&1
  TRD_EXIT=$?
  echo "--- ingest:trades exit code: $TRD_EXIT"

  echo ""
  echo "--- step 4: features ---"
  npx tsx scripts/compute-features.ts 2>&1
  FEAT_EXIT=$?
  echo "--- features exit code: $FEAT_EXIT"

  echo ""
  echo "--- step 5: run-nightly-hunt (thin-market scan, no liquidity filter) ---"
  npx tsx scripts/run-nightly-hunt.ts 2>&1
  HUNT_EXIT=$?
  echo "--- run-nightly-hunt exit code: $HUNT_EXIT"

  echo ""
  echo "--- step 6: run-nightly-hunt (liquid-market scan, pre-trade 24h vol >= \$5K) ---"
  MIN_PRE_VOL_24H_USD=5000 npx tsx scripts/run-nightly-hunt.ts 2>&1
  HUNT_LIQ_EXIT=$?
  echo "--- run-nightly-hunt (liquid) exit code: $HUNT_LIQ_EXIT"

  echo ""
  echo "================================================================================"
  echo "[cron-nightly] $(date -u '+%Y-%m-%dT%H:%M:%SZ') END  markets=$MKT_EXIT status=$STAT_EXIT trades=$TRD_EXIT features=$FEAT_EXIT hunt=$HUNT_EXIT hunt_liq=$HUNT_LIQ_EXIT"
  echo "================================================================================"
} >> "$LOG_FILE" 2>&1
