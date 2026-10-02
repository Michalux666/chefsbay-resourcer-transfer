#!/bin/bash
# tests/e2e-identity.sh - the whole-pipeline comparison of the role scope with the release before it (docs/ROLESCOPE.md R-C7, section "Compared with the previous release").
#
#     bash tests/e2e-identity.sh <tree of the previous release> [<this tree>]
#
# <tree of the previous release> is a pristine checkout of that release (for example `git worktree add <dir> <commit>`, or `git archive <commit> | tar -x -C <dir>`),
# on a Linux filesystem. The same worlds (tests/e2e/identity-snapshot.js: the standard Caterer world, and Caterer plus Reed, with the role scope on and off, with
# and without the leftovers of the old system) are run on both trees, everything the pipeline leaves behind is written to one normalised JSON file per tree, and the
# files are compared (tests/e2e/lib/identity-compare.js). The snapshot file and its library (tests/e2e/identity-snapshot.js, tests/e2e/lib/identity.js) are copied into the old tree first; nothing else of it is touched.
# Environment: E2E_IDENTITY_WORK (default ~/hermes-identity-work), E2E_PYTHON as for tests/e2e-linux.sh. Exit code 0 only when every world is identical.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
NEW=$(cd "${2:-$HERE/..}" && pwd)
[ -n "${1:-}" ] || { echo "usage: bash tests/e2e-identity.sh <previous release tree> [<this tree>]" >&2; exit 64; }
OLD=$(cd "$1" && pwd)
WORK=${E2E_IDENTITY_WORK:-$HOME/hermes-identity-work}
mkdir -p "$WORK"
for T in "$OLD" "$NEW"; do
  [ -d "$T/resourcer" ] || { echo "not a tree: $T" >&2; exit 65; }
  [ -d "$T/resourcer/node_modules/better-sqlite3" ] || { [ -d "$NEW/resourcer/node_modules/better-sqlite3" ] && [ "$T" != "$NEW" ] && ln -s "$NEW/resourcer/node_modules" "$T/resourcer/node_modules"; }
  [ -d "$T/resourcer/node_modules/better-sqlite3" ] || { echo "npm install in $T/resourcer first" >&2; exit 66; }
done
cp "$NEW/tests/e2e/identity-snapshot.js" "$OLD/tests/e2e/identity-snapshot.js"
cp "$NEW/tests/e2e/lib/identity.js" "$OLD/tests/e2e/lib/identity.js"
run() {
  local tree=$1 tag=$2
  ( cd "$tree" && E2E_ROOT="$WORK/$tag" E2E_LOGS="$WORK/$tag-logs" E2E_IDENTITY_OUT="$WORK/$tag.json" E2E_PYTHON="${E2E_PYTHON:-}" node --test --test-concurrency=1 tests/e2e/identity-snapshot.js > "$WORK/$tag.log" 2>&1 ) || { echo "the worlds did not run on the $tag tree: see $WORK/$tag.log" >&2; return 1; }
}
mkdir -p "$WORK/old-logs" "$WORK/new-logs"
run "$OLD" old || exit 1
run "$NEW" new || exit 1
node "$NEW/tests/e2e/lib/identity-compare.js" "$WORK/old.json" "$WORK/new.json"
