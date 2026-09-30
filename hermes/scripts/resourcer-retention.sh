#!/bin/sh
# Hermes no-agent cron wrapper: the daily data-lifecycle retention sweep (downloads/ queue and result files,
# CVs, runs/, logs/, the shadow screening log). Its JSON summary goes to logs/retention-<date>.log, so a good
# night prints nothing; a non-zero exit prints exactly one line. Alerts about refusals and deletions are
# raised by the sweep itself through the outbox.
set -u

SELF_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || { echo "resourcer-retention: cannot resolve the script directory"; exit 90; }
# Hermes keeps every cron script in <profile>/scripts, so the script location decides the profile; an inherited HERMES_HOME
# (it can be the host default home) must not select another profile's .env and tools.
PROFILE_HOME=$(dirname "$SELF_DIR")
HERMES_HOME_SEEN=${HERMES_HOME:-}
HERMES_HOME=$PROFILE_HOME
export HERMES_HOME
RESOURCER_HOME=${RESOURCER_HOME:-$PROFILE_HOME/workspace/resourcer}
export RESOURCER_HOME

[ -f "$RESOURCER_HOME/scripts/retention-sweep.js" ] || { echo "resourcer-retention: $RESOURCER_HOME/scripts/retention-sweep.js not found"; exit 90; }
NODE=$(command -v node) || { echo "resourcer-retention: node is not on PATH"; exit 91; }

mkdir -p "$RESOURCER_HOME/logs" "$RESOURCER_HOME/runtime" "$RESOURCER_HOME/outbox" 2>/dev/null
LOG="$RESOURCER_HOME/logs/retention-$(date -u +%Y%m%d).log"
cd "$RESOURCER_HOME" || exit 90
[ -z "$HERMES_HOME_SEEN" ] || [ "$HERMES_HOME_SEEN" = "$PROFILE_HOME" ] || echo "note: HERMES_HOME=$HERMES_HOME_SEEN differs from the script location; using $PROFILE_HOME" >>"$LOG"

"$NODE" scripts/retention-sweep.js >>"$LOG" 2>&1 </dev/null
rc=$?

if [ "$rc" -ne 0 ]; then
  last=$(tail -n 40 "$LOG" 2>/dev/null | grep -v -e '^Node\.js v' -e '^[[:space:]]*at ' -e '^[[:space:]]*$' | tail -n 1 | cut -c1-200)
  echo "resourcer-retention failed rc=$rc: $last"
  exit "$rc"
fi
exit 0
