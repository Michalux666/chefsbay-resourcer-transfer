#!/bin/bash
# tests/e2e-linux.sh - the end-to-end rehearsal of the whole resourcer on Linux, fakes only. ONE command runs everything:
#
#     bash tests/e2e-linux.sh                 all scenarios (about 20 minutes), then a summary table
#     bash tests/e2e-linux.sh --only 02,05    just those scenarios
#     bash tests/e2e-linux.sh --unit          also the whole unit suite afterwards (node --test "tests/**/*.test.js"; better-sqlite3 and E2E_PYTHON are made visible so only the real-Chromium tests skip)
#     bash tests/e2e-linux.sh --keep          keep every simulated profile under $E2E_ROOT/worlds for inspection
#
# What it builds (under $E2E_ROOT, default ~/hermes-sim): a simulated Hermes profile
#     $E2E_ROOT/opt-data/profiles/resourcer                 HERMES_HOME  (.env with fake secrets, scripts/, bin/agent-browser)
#     $E2E_ROOT/opt-data/profiles/resourcer/workspace/resourcer   RESOURCER_HOME (npm install, bundle restore, migrate)
# and, per scenario, a fresh copy of that layout under $E2E_ROOT/worlds/<name>. The cron wrapper scripts are installed
# exactly as the install runbook will and are run the way Hermes runs a no-agent cron job: executed directly, cwd = the
# job's workdir, environment scrubbed with env -i (PATH and HOME only; the profile .env is read by the code itself).
# The world outside is fake: a fake agent-browser that serves deterministic Caterer pages (the REAL scripts/extract-js.b64
# runs against them), credits, unlocks and CV downloads; a fake Zoho Recruit and postcode service; the fake AI gateway
# (Jev and LLM); a fake Reed site and API served by a stand-in chromium under the real xvfb-run. A preload
# (tests/e2e/lib/preload.js, via NODE_OPTIONS) redirects the known hosts to those fakes and throws for any other host.
# Test-only switches that reach the code: RESOURCER_TEST_NOW (the operating-window / quiet-hours clock only) and speed
# knobs (settle and pause times). Nothing touches a live site, the internet or the legacy workspace.
#
# Scenarios (tests/e2e/NN-*.e2e.js): 01 install path, 02 happy path, 03 screening outage, 04 Caterer session paths,
# 05 kill -9 recovery, 06 suspend/resume, 07 Reed off/on, 08 dashboard, 09 backup, 10 retention and maintenance,
# 11 secrets hygiene, 12 missing database guard, 13 the Jev-only default engine, 14 CV screening after the unlock (shadow by default, on, off),
# 15 CV_SCREEN=on with the CV route refusing while the snippet route is healthy (one hold, the halt stays, no unlock after it, the recovery completes the queue),
# 16 the Reed first-page failure (HTTP 400, code 50010): failed attempt, recovery, transient faults, an unsearchable place, no search page fetched,
# 17 the re-screen of the pre-unlock rejections that Update A's review policy made because Jev was uncertain (tools/rescreen-policy-rejects.js): dry run, apply, queue, the next run, undo,
# 18 the role-scoped second look at people rejected after an unlock (docs/RESURFACE.md): CV_SCREEN=on, a charging fake Caterer, seven searches; the standard world with the feature on and off in shadow and off mode.
# 20 the search window and the CV limit reach both sources (docs/ACTIVITY.md): the read-only probe, a one-off request for 12 months and 30 CVs (the Caterer URL carries the mapped id and the fake page echoes it; Reed gets year and 30), a scheduled territory (the URL of main, byte for byte; Reed month and 20), CATERER_ACTIVITY_FILTER all and off, a window with no Caterer id, a page that echoes another window (one alert a day).
#
# Environment: E2E_ROOT (default ~/hermes-sim), E2E_PYTHON (a python with fastapi and httpx; when unset a venv is created
# at $E2E_VENV, default ~/hermes-sim-venv, and filled with pip), E2E_SEED (random-kill seed, default 20260929),
# E2E_KEEP=1 (same as --keep), E2E_LOGS (per-scenario logs, default $E2E_ROOT/logs).
# Needs: Linux, Node >= 22, npm, rsync, python3 with venv, xvfb-run and xauth (Reed scenario). A repo on a Windows drive
# mount is copied to $E2E_REPO_COPY (default ~/hermes-sim-repo) first: permissions, locks and signals need a real Linux filesystem.
# Exit code: the number of failed scenarios (0 = all passed).
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
ONLY=""
UNIT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --unit) UNIT=1; shift ;;
    --keep) export E2E_KEEP=1; shift ;;
    -h|--help) sed -n '2,35p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

fail() { echo "e2e-linux: $*" >&2; exit 90; }

[ "$(uname -s)" = "Linux" ] || fail "this rehearsal needs Linux"
command -v node >/dev/null || fail "node is not on PATH"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || fail "Node >= 22 is required (found $(node -v))"
command -v npm >/dev/null || fail "npm is not on PATH"
command -v rsync >/dev/null || fail "rsync is not installed"
command -v xvfb-run >/dev/null || echo "e2e-linux: WARNING xvfb-run is missing: scenario 07 (Reed) will fail" >&2

export E2E_ROOT=${E2E_ROOT:-$HOME/hermes-sim}
export E2E_LOGS=${E2E_LOGS:-$E2E_ROOT/logs}
mkdir -p "$E2E_ROOT" "$E2E_LOGS"

# a real Linux filesystem for chmod, locks and signals
case "$REPO" in
  /mnt/*)
    COPY=${E2E_REPO_COPY:-$HOME/hermes-sim-repo}
    mkdir -p "$COPY"
    rsync -a --delete --exclude node_modules --exclude .git --exclude 'data/*.enc' "$REPO/" "$COPY/" || fail "could not copy the repo to $COPY"
    find "$COPY" -name '*.sh' -exec chmod +x {} +
    REPO=$COPY
    ;;
esac
cd "$REPO" || fail "cannot enter $REPO"

if [ ! -d resourcer/node_modules/better-sqlite3 ]; then
  echo "e2e-linux: npm install in resourcer/ ..."
  (cd resourcer && npm install --no-audit --no-fund --prefer-offline >"$E2E_LOGS/npm-install.log" 2>&1) || fail "npm install failed (see $E2E_LOGS/npm-install.log)"
fi

py_ok() { [ -n "${1:-}" ] && "$1" -c 'import fastapi, httpx' >/dev/null 2>&1; }
if ! py_ok "${E2E_PYTHON:-}"; then
  VENV=${E2E_VENV:-$HOME/hermes-sim-venv}
  if ! py_ok "$VENV/bin/python"; then
    echo "e2e-linux: creating a python venv with fastapi and httpx at $VENV ..."
    python3 -m venv "$VENV" >"$E2E_LOGS/venv.log" 2>&1 && "$VENV/bin/pip" install --quiet fastapi httpx pytest >>"$E2E_LOGS/venv.log" 2>&1
  fi
  if py_ok "$VENV/bin/python"; then export E2E_PYTHON=$VENV/bin/python; else echo "e2e-linux: WARNING no python with fastapi and httpx: scenario 08 will fail (see $E2E_LOGS/venv.log)" >&2; fi
fi

wanted() { [ -z "$ONLY" ] && return 0; case ",$ONLY," in *",$1,"*) return 0 ;; esac; return 1; }

# stray browsers from a previous aborted run would disturb the process checks
pkill -9 -f "$E2E_ROOT/" 2>/dev/null

RESULTS=()
FAILED=0
T0=$(date +%s)
for file in tests/e2e/[0-9][0-9]-*.e2e.js; do
  name=$(basename "$file" .e2e.js)
  num=${name%%-*}
  wanted "$num" || continue
  s0=$(date +%s)
  echo "== scenario $name"
  node --test --test-concurrency=1 --test-reporter=spec "$file" >"$E2E_LOGS/$name.log" 2>&1
  rc=$?
  secs=$(( $(date +%s) - s0 ))
  if [ $rc -eq 0 ]; then
    RESULTS+=("PASS  $name  (${secs}s)")
    echo "   PASS (${secs}s)"
  else
    FAILED=$((FAILED + 1))
    RESULTS+=("FAIL  $name  (${secs}s)  log: $E2E_LOGS/$name.log")
    echo "   FAIL (${secs}s), first failures:"
    grep -E '^\s*(x|not ok)|Error|error:|failing tests' "$E2E_LOGS/$name.log" | head -8 | sed 's/^/     /'
  fi
done

UNIT_RC=0
if [ "$UNIT" -eq 1 ]; then
  echo "== unit suite: node --test \"tests/**/*.test.js\""
  NODE_PATH="$REPO/resourcer/node_modules" RESOURCER_PYTHON="${E2E_PYTHON:-}" node --test --test-concurrency=4 "tests/**/*.test.js" >"$E2E_LOGS/unit.log" 2>&1
  UNIT_RC=$?
  grep -E '^# (tests|pass|fail|skipped)' "$E2E_LOGS/unit.log" | sed 's/^/   /'
  if [ $UNIT_RC -eq 0 ]; then RESULTS+=("PASS  unit suite"); else RESULTS+=("FAIL  unit suite  log: $E2E_LOGS/unit.log"); FAILED=$((FAILED + 1)); fi
fi

pkill -9 -f "$E2E_ROOT/" 2>/dev/null
echo
echo "== summary ($(( $(date +%s) - T0 ))s)"
printf '   %s\n' "${RESULTS[@]}"
echo "   simulated profile: $E2E_ROOT/opt-data/profiles/resourcer   logs: $E2E_LOGS"
exit "$FAILED"
