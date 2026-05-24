#!/bin/bash
# Installs the nightly hunt as a launchd job, scheduled for 4 AM local time.
# Run this once; it copies the plist to ~/Library/LaunchAgents and loads it.
#
# To disable later: launchctl unload ~/Library/LaunchAgents/com.polywork.nightly-hunt.plist
set -e

PLIST_SRC="/Applications/MAMP/htdocs/polywork/scripts/com.polywork.nightly-hunt.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.polywork.nightly-hunt.plist"

if [ ! -f "$PLIST_SRC" ]; then
  echo "ERROR: plist source not found at $PLIST_SRC"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
cp "$PLIST_SRC" "$PLIST_DEST"
echo "copied plist to $PLIST_DEST"

# Unload first in case it's already loaded.
launchctl unload "$PLIST_DEST" 2>/dev/null || true

launchctl load "$PLIST_DEST"
echo "loaded. nightly hunt will run daily at 04:00 local time."
echo "to verify: launchctl list | grep polywork.nightly-hunt"
echo "to disable: launchctl unload $PLIST_DEST"
