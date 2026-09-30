#!/bin/sh
# Hermes no-agent cron wrapper: deliver new alerts. Whatever this script prints is the message
# Hermes sends to the configured channel; it prints nothing when there is nothing to say.
set -u

SELF_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || { echo "resourcer-alerts: cannot resolve the script directory"; exit 90; }
# Hermes keeps every cron script in <profile>/scripts, so the script location decides the profile; an inherited HERMES_HOME
# (it can be the host default home) must not select another profile's .env and tools.
PROFILE_HOME=$(dirname "$SELF_DIR")
HERMES_HOME_SEEN=${HERMES_HOME:-}
HERMES_HOME=$PROFILE_HOME
export HERMES_HOME
RESOURCER_HOME=${RESOURCER_HOME:-$PROFILE_HOME/workspace/resourcer}
export RESOURCER_HOME

[ -f "$RESOURCER_HOME/scripts/alerts-deliver.js" ] || { echo "resourcer-alerts: $RESOURCER_HOME/scripts/alerts-deliver.js not found"; exit 90; }
NODE=$(command -v node) || { echo "resourcer-alerts: node is not on PATH"; exit 91; }

mkdir -p "$RESOURCER_HOME/logs" "$RESOURCER_HOME/runtime" "$RESOURCER_HOME/outbox" 2>/dev/null
LOG="$RESOURCER_HOME/logs/alerts-$(date -u +%Y%m%d).log"
cd "$RESOURCER_HOME" || exit 90
[ -z "$HERMES_HOME_SEEN" ] || [ "$HERMES_HOME_SEEN" = "$PROFILE_HOME" ] || echo "note: HERMES_HOME=$HERMES_HOME_SEEN differs from the script location; using $PROFILE_HOME" >>"$LOG"

out=$("$NODE" scripts/alerts-deliver.js 2>>"$LOG" </dev/null)
rc=$?

if [ -n "$out" ]; then
  printf '%s\n' "$out"
fi
if [ "$rc" -ne 0 ]; then
  echo "resourcer-alerts failed rc=$rc"
  exit "$rc"
fi
exit 0
