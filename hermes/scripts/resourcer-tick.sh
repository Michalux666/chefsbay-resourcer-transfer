#!/bin/sh
# Hermes no-agent cron wrapper: one bounded supervision tick. Silent on success, one line on failure.
# The node process writes only to logs/, so nothing long-lived can hold this job's stdout/stderr pipes.
set -u

SELF_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || { echo "resourcer-tick: cannot resolve the script directory"; exit 90; }
# Hermes keeps every cron script in <profile>/scripts, so the script location decides the profile; an inherited HERMES_HOME
# (it can be the host default home) must not select another profile's .env and tools.
PROFILE_HOME=$(dirname "$SELF_DIR")
HERMES_HOME_SEEN=${HERMES_HOME:-}
HERMES_HOME=$PROFILE_HOME
export HERMES_HOME
RESOURCER_HOME=${RESOURCER_HOME:-$PROFILE_HOME/workspace/resourcer}
export RESOURCER_HOME

[ -f "$RESOURCER_HOME/scripts/pipeline-watchdog.js" ] || { echo "resourcer-tick: $RESOURCER_HOME/scripts/pipeline-watchdog.js not found"; exit 90; }
NODE=$(command -v node) || { echo "resourcer-tick: node is not on PATH"; exit 91; }

mkdir -p "$RESOURCER_HOME/logs" "$RESOURCER_HOME/runtime" 2>/dev/null
if [ -z "${TMPDIR:-}" ] || [ ! -d "$TMPDIR" ] || [ ! -w "$TMPDIR" ]; then
  TMPDIR=$RESOURCER_HOME/state/t
  mkdir -p "$TMPDIR" 2>/dev/null && chmod 700 "$TMPDIR" 2>/dev/null
  export TMPDIR
fi
LOG="$RESOURCER_HOME/logs/tick-$(date -u +%Y%m%d).log"
cd "$RESOURCER_HOME" || exit 90
[ -z "$HERMES_HOME_SEEN" ] || [ "$HERMES_HOME_SEEN" = "$PROFILE_HOME" ] || echo "note: HERMES_HOME=$HERMES_HOME_SEEN differs from the script location; using $PROFILE_HOME" >>"$LOG"

# The bound comes from RESOURCER_MAX_TICK_MIN only when the cron environment carries it; otherwise the script reads the profile .env
# (default 55). Passing the flag unconditionally would make the .env value unreachable.
set -- --tick
if [ -n "${RESOURCER_MAX_TICK_MIN:-}" ]; then set -- --tick --max-minutes "$RESOURCER_MAX_TICK_MIN"; fi
# Backstop against a runaway writer: no single file written by the tick or its children may pass 1 GiB (512-byte blocks).
ulimit -f 2097152 2>/dev/null || true
TIMEOUT=$(command -v timeout || true)
if [ -n "$TIMEOUT" ]; then
  "$TIMEOUT" -k 30 3450 "$NODE" scripts/pipeline-watchdog.js "$@" >>"$LOG" 2>&1 </dev/null
else
  "$NODE" scripts/pipeline-watchdog.js "$@" >>"$LOG" 2>&1 </dev/null
fi
rc=$?

if [ "$rc" -ne 0 ]; then
  last=$(tail -n 40 "$LOG" 2>/dev/null | grep -v -e '^Node\.js v' -e '^[[:space:]]*at ' -e '^[[:space:]]*$' | tail -n 1 | cut -c1-200)
  echo "resourcer-tick failed rc=$rc: $last"
  exit "$rc"
fi
exit 0
