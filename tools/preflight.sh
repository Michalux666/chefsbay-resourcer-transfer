#!/bin/sh
# Read-only environment probes for the resourcer install (docs/INSTALL.md step 1; rerun at steps 4, 6, 9, 10; --final at go-live).
# POSIX sh, no root, no secrets printed (names, paths, modes, counts, versions only). Exit 0 when there is no FAIL, 1 otherwise, 2 usage.
set -u

usage() {
  cat <<'EOF'
Usage: sh tools/preflight.sh [options]
  --offline      skip every network probe
  --no-browser   skip the real Chromium and xvfb-run launches
  --reed         also start a headed Chromium under xvfb-run for a few seconds
  --final        items that only a later install step can fix become FAIL instead of WARN
  --cron-report  print what a cron run sees (names and paths only); used by the throwaway env-probe job
  -h, --help     show this text
Output: one line per probe, PASS / WARN / FAIL / INFO, then PREFLIGHT_RESULT pass=N warn=N fail=N.
A WARN ending in [needs step N] is expected until install step N is done.
EOF
}

OFFLINE=0; BROWSER=1; REED=0; FINAL=0; MODE=check
for a in "$@"; do
  case "$a" in
    --offline) OFFLINE=1 ;;
    --no-browser) BROWSER=0 ;;
    --reed) REED=1 ;;
    --final) FINAL=1 ;;
    --cron-report) MODE=cron ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown option %s\n' "$a"; usage; exit 2 ;;
  esac
done
case "$(basename "$0")" in resourcer-envprobe.sh) MODE=cron ;; esac

PASS=0; WARN=0; FAIL=0
pass() { PASS=$((PASS+1)); printf 'PASS %s\n' "$*"; }
warn() { WARN=$((WARN+1)); printf 'WARN %s\n' "$*"; }
fail() { FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$*"; }
info() { printf 'INFO %s\n' "$*"; }
sec() { printf '== %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
later() {
  step=$1; shift
  if [ "$FINAL" = 1 ]; then fail "$* [needs step $step]"; else warn "$* [needs step $step]"; fi
}
run_to() {
  secs=$1; shift
  if have timeout; then timeout "$secs" "$@"; else "$@"; fi
}

HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || HERE=.
if [ "$MODE" = cron ]; then
  PH=$(cd "$HERE/.." 2>/dev/null && pwd)
  RH=${RESOURCER_HOME:-$PH/workspace/resourcer}
  REPO=$(cd "$RH/.." 2>/dev/null && pwd)
else
  REPO=$(cd "$HERE/.." 2>/dev/null && pwd)
  RH=${RESOURCER_HOME:-$REPO/resourcer}
  PH=${PROFILE_HOME:-$(cd "$RH/../.." 2>/dev/null && pwd)}
fi
PN=$(basename "${PH:-x}")
ENVF=${RESOURCER_ENV_FILE:-$PH/.env}

env_has() { [ -f "$ENVF" ] && grep -Eq "^(export +)?$1=." "$ENVF"; }
env_val() { grep -E "^(export +)?$1=" "$ENVF" 2>/dev/null | head -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"; }
mode_of() { stat -c %a "$1" 2>/dev/null || echo '?'; }

if [ "$MODE" = cron ]; then
  TMPDIR_LEN_SRC=${TMPDIR:-}
  echo "ENVPROBE cwd=$PWD"
  echo "ENVPROBE id=$(id -u):$(id -g) umask=$(umask)"
  echo "ENVPROBE HOME=${HOME:-unset} exists=$([ -d "${HOME:-/nonexistent}" ] && echo yes || echo NO) writable=$([ -w "${HOME:-/nonexistent}" ] && echo yes || echo NO)"
  echo "ENVPROBE HERMES_HOME=${HERMES_HOME:-unset} derived-profile-home=$PH match=$([ "${HERMES_HOME:-}" = "$PH" ] && echo yes || echo NO)"
  echo "ENVPROBE TMPDIR=${TMPDIR:-unset (the default /tmp is used)} length=${#TMPDIR_LEN_SRC}"
  echo "ENVPROBE temp-dir=${TMPDIR:-/tmp} exists=$([ -d "${TMPDIR:-/tmp}" ] && echo yes || echo NO) writable=$([ -w "${TMPDIR:-/tmp}" ] && echo yes || echo NO)"
  echo "ENVPROBE PATH=$PATH"
  for t in node npm timeout xvfb-run xauth chromium git hermes setsid; do echo "ENVPROBE tool $t=$(command -v "$t" 2>/dev/null || echo MISSING)"; done
  echo "ENVPROBE node=$(node --version 2>&1 | head -n 1)"
  echo "ENVPROBE TZ=${TZ:-unset} date=$(date '+%Z %z') LANG=${LANG:-unset}"
  echo "ENVPROBE ulimit-n=$(ulimit -n 2>/dev/null || echo n/a) ulimit-u=$(ulimit -u 2>/dev/null || echo n/a)"
  echo "ENVPROBE profile-env-file=$([ -r "$ENVF" ] && echo readable || echo 'NOT READABLE') at $ENVF"
  echo "ENVPROBE variable NAMES matching KEY/TOKEN/SECRET/PASSWORD/RESOURCER/AGENT_BROWSER/HERMES/AI_GATEWAY/NODE/CHROM (names only):"
  env | cut -d= -f1 | grep -Ei 'KEY|TOKEN|SECRET|PASSWORD|RESOURCER|AGENT_BROWSER|HERMES|AI_GATEWAY|NODE|CHROM' | sort | tr '\n' ' '
  echo
  echo "ENVPROBE AI_GATEWAY_API_KEY in the process environment: $([ -n "${AI_GATEWAY_API_KEY:-}" ] && echo PRESENT || echo 'absent (expected: node reads the profile .env itself)')"
  echo "ENVPROBE stdout=$(readlink /proc/$$/fd/1 2>/dev/null) stdin=$(readlink /proc/$$/fd/0 2>/dev/null)"
  ST="$PH/cron-envprobe.state"
  if [ -f "$ST" ]; then
    read -r spid stok < "$ST"
    if [ -d "/proc/$spid" ] && [ "$(awk '{print $22}' "/proc/$spid/stat" 2>/dev/null)" = "$stok" ]; then
      echo "ENVPROBE DETACHED-SLEEPER pid=$spid SURVIVED the end of the previous run (parent is now $(awk '{print $4}' "/proc/$spid/stat"))"
    else
      echo "ENVPROBE DETACHED-SLEEPER pid=$spid is GONE: a process started by one cron run does not survive the run"
    fi
    rm -f "$ST"
  elif have setsid; then
    setsid sleep 600 </dev/null >/dev/null 2>&1 &
    spid=$!
    sleep 1
    echo "$spid $(awk '{print $22}' "/proc/$spid/stat" 2>/dev/null)" > "$ST"
    echo "ENVPROBE DETACHED-SLEEPER started pid=$spid; run this job a second time to see whether it survived"
  else
    echo "ENVPROBE setsid is not available: the detached-runner check was skipped"
  fi
  echo "ENVPROBE_DONE"
  exit 0
fi

PD=""
if [ -d "$RH" ] && [ -w "$RH" ]; then
  mkdir -p "$RH/state" 2>/dev/null && chmod 700 "$RH/state" 2>/dev/null
  [ -w "$RH/state" ] && PD="$RH/state/.pf-$$"
fi
[ -n "$PD" ] || PD="${TMPDIR:-/tmp}/pf-$$"
mkdir -p "$PD" 2>/dev/null || { echo "FAIL 00 cannot create a probe directory under $RH/state or ${TMPDIR:-/tmp}"; echo "PREFLIGHT_RESULT pass=0 warn=0 fail=1"; exit 1; }
chmod 700 "$PD" 2>/dev/null
trap 'rm -rf "$PD"' EXIT
trap 'exit 130' INT TERM HUP

if have node; then
  cat > "$PD/probe.js" <<'EOF'
'use strict';
const fs = require('fs');
const path = require('path');
const out = (k, v) => console.log(k + ' ' + v);
out('node', process.version + ' abi=' + process.versions.modules + ' icu=' + (process.versions.icu || 'none'));
try {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' });
  out('intl-london', 'ok hour=' + f.format(new Date()));
} catch (e) { out('intl-london', 'FAIL ' + e.message); }
const rh = process.argv[2];
const pd = process.argv[3];
let D = null;
try { D = require(path.join(rh, 'node_modules', 'better-sqlite3')); } catch (e) { out('sqlite', 'MISSING ' + String(e.message).split('\n')[0].slice(0, 100)); }
if (D) {
  try {
    const p = path.join(pd, 'wal.db');
    const a = new D(p);
    out('sqlite-journal', String(a.pragma('journal_mode = WAL', { simple: true })));
    a.exec('create table t(x); insert into t values (1)');
    const b = new D(p, { readonly: true });
    a.exec('insert into t values (2)');
    out('sqlite-second-reader', String(b.prepare('select count(*) c from t').get().c));
    b.close();
    a.close();
    out('sqlite-version', new D(':memory:').prepare('select sqlite_version() v').get().v);
  } catch (e) { out('sqlite', 'FAIL ' + String(e.message).split('\n')[0].slice(0, 120)); }
}
for (const m of ['mammoth', 'pdf-parse', 'ws']) out('dep-' + m, fs.existsSync(path.join(rh, 'node_modules', m, 'package.json')) ? 'ok' : 'MISSING');
EOF
  cat > "$PD/http.js" <<'EOF'
'use strict';
const [method, url] = process.argv.slice(2);
const headers = {};
if (process.env.PF_KEY) headers.Authorization = 'Bearer ' + process.env.PF_KEY;
fetch(url, { method, headers, redirect: 'follow', signal: AbortSignal.timeout(20000) }).then((r) => {
  console.log([r.status, r.headers.get('server') || '', r.headers.get('date') || ''].join('|'));
}, () => console.log('0||'));
EOF
fi

cat > "$PD/probe.py" <<'EOF'
import sys
def out(k, v):
    print(k, v)
out("python", sys.version.split()[0])
for m in ("fastapi", "starlette", "httpx", "uvicorn"):
    try:
        mod = __import__(m)
        out(m, getattr(mod, "__version__", "present"))
    except Exception:
        out(m, "MISSING")
try:
    import zoneinfo
    zoneinfo.ZoneInfo("Europe/London")
    out("zoneinfo-london", "ok")
except Exception:
    out("zoneinfo-london", "FAIL")
EOF

http_probe() {
  HP_CODE=""; HP_SERVER=""; HP_DATE=""
  method=$1; url=$2
  if have curl; then
    if [ "$method" = GET ]; then
      HP_CODE=$(curl -sS -L -m 20 -o /dev/null -D "$PD/h.txt" -w '%{http_code}' "$url" 2>/dev/null)
    else
      HP_CODE=$(curl -sS -I -L -m 20 -o /dev/null -D "$PD/h.txt" -w '%{http_code}' "$url" 2>/dev/null)
    fi
    HP_SERVER=$(sed -n 's/^[Ss]erver: *//p' "$PD/h.txt" 2>/dev/null | tail -n 1 | tr -d '\r' | cut -c1-40)
    HP_DATE=$(sed -n 's/^[Dd]ate: *//p' "$PD/h.txt" 2>/dev/null | tail -n 1 | tr -d '\r')
  elif have node; then
    r=$(node "$PD/http.js" "$method" "$url" 2>/dev/null)
    HP_CODE=$(printf '%s' "$r" | cut -d'|' -f1); HP_SERVER=$(printf '%s' "$r" | cut -d'|' -f2); HP_DATE=$(printf '%s' "$r" | cut -d'|' -f3)
  fi
  [ -n "$HP_CODE" ] || HP_CODE=0
}
authed_get() {
  HP_CODE=""
  url=$1
  if have curl; then
    HP_CODE=$(printf 'header = "Authorization: Bearer %s"\n' "$KEY" | curl -sS -m 20 -o /dev/null -w '%{http_code}' -K - "$url" 2>/dev/null)
  elif have node; then
    HP_CODE=$(PF_KEY=$KEY node "$PD/http.js" GET "$url" 2>/dev/null | cut -d'|' -f1)
  fi
  [ -n "$HP_CODE" ] || HP_CODE=0
}

sec "A. platform, identity, limits"
OS=$(uname -s 2>/dev/null); ARCH=$(uname -m 2>/dev/null)
PRETTY=""
[ -r /etc/os-release ] && PRETTY=$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release | head -n 1 | tr -d '"')
if [ "$OS" = Linux ]; then pass "A1 os Linux (${PRETTY:-unknown distribution})"; else fail "A1 os is ${OS:-unknown}: the instance is Linux"; fi
case "$ARCH" in
  x86_64|amd64) pass "A2 architecture $ARCH" ;;
  *) fail "A2 architecture ${ARCH:-unknown}: the pinned agent-browser build is linux-x64 only" ;;
esac
UID_NOW=$(id -u 2>/dev/null || echo '?'); USER_NOW=$(id -un 2>/dev/null || echo '?')
if [ "$UID_NOW" = 0 ]; then warn "A3 running as root: the instance user is uid 10000, so file modes and locks proven here are not proven for that user"
else pass "A3 user $USER_NOW uid $UID_NOW (not root)"; fi
GLIBC=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')
info "A4 glibc ${GLIBC:-unknown} (the pinned agent-browser needs 2.30 or newer)"
NOFILE=$(ulimit -n 2>/dev/null || echo 0)
if [ "$NOFILE" = unlimited ] || [ "$NOFILE" -ge 4096 ] 2>/dev/null; then pass "A5 open-file limit $NOFILE"; else warn "A5 open-file limit $NOFILE is below 4096"; fi
PIDS_MAX=$(cat /sys/fs/cgroup/pids.max 2>/dev/null || echo max)
if [ "$PIDS_MAX" = max ] || [ "$PIDS_MAX" -ge 1024 ] 2>/dev/null; then pass "A6 process limit $PIDS_MAX"; else warn "A6 cgroup pids.max=$PIDS_MAX: Chromium runs 20-40 processes"; fi
if [ -n "$PH" ] && [ -n "${HERMES_HOME:-}" ] && [ "$HERMES_HOME" != "$PH" ]; then
  warn "A7 HERMES_HOME ($HERMES_HOME) differs from the profile home derived from the repo location ($PH): the code prefers HERMES_HOME, so a wrong value reads the wrong .env"
else pass "A7 HERMES_HOME (${HERMES_HOME:-unset}) agrees with the profile home $PH"; fi
if [ -d "$RH" ]; then pass "A8 RESOURCER_HOME $RH exists"; else fail "A8 RESOURCER_HOME $RH does not exist (clone the repository first, step 2)"; fi

sec "B. memory, disk, filesystem"
MEMTOTAL=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo 2>/dev/null); MEMAVAIL=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo 2>/dev/null)
SWAP=$(awk '/^SwapTotal:/{print int($2/1024)}' /proc/meminfo 2>/dev/null)
CGMAX=$(cat /sys/fs/cgroup/memory.max 2>/dev/null); CGCUR=$(cat /sys/fs/cgroup/memory.current 2>/dev/null)
AVAIL=${MEMAVAIL:-0}
case "$CGMAX:$CGCUR" in
  *[!0-9:]*|:*|*:) ;;
  *) CGHEAD=$(( (CGMAX - CGCUR) / 1048576 )); [ "$CGHEAD" -lt "$AVAIL" ] && AVAIL=$CGHEAD ;;
esac
info "B1 MemTotal ${MEMTOTAL:-?} MB, MemAvailable ${MEMAVAIL:-?} MB, cgroup headroom-limited available ${AVAIL} MB, swap ${SWAP:-0} MB"
if [ "$AVAIL" -ge 1500 ]; then pass "B2 available memory ${AVAIL} MB (a Caterer run peaks near 1.1 GB, a run with Reed near 2 GB)"
elif [ "$AVAIL" -ge 900 ]; then warn "B2 available memory ${AVAIL} MB is below 1500: one Caterer run fits, a run with Reed does not; the tick refuses to start below its own floor"
else fail "B2 available memory ${AVAIL} MB is below 900: a Caterer run will not fit next to the other profile"; fi
[ "${SWAP:-0}" -gt 0 ] || info "B3 no swap: an out-of-memory event kills a process instead of slowing down"
DFDIR=$RH; [ -d "$DFDIR" ] || DFDIR=/opt/data; [ -d "$DFDIR" ] || DFDIR=.
FREE_MB=$(df -Pm "$DFDIR" 2>/dev/null | awk 'NR==2{print $4}')
if [ "${FREE_MB:-0}" -ge 1500 ]; then pass "B4 ${FREE_MB} MB free on the volume holding $DFDIR"
elif [ "${FREE_MB:-0}" -ge 800 ]; then warn "B4 only ${FREE_MB} MB free on the volume holding $DFDIR (the first weeks need about 1.5 GB)"
else fail "B4 only ${FREE_MB:-0} MB free on the volume holding $DFDIR (node_modules, the npm cache, the browser profile and backups need about 800 MB before the first run)"; fi
if [ -d /opt/data ] && [ "$(df -Pm /opt/data 2>/dev/null | awk 'NR==2{print $1}')" != "$(df -Pm "$DFDIR" 2>/dev/null | awk 'NR==2{print $1}')" ]; then
  info "B5 /opt/data is a different volume: $(df -Pm /opt/data 2>/dev/null | awk 'NR==2{print $4}') MB free"
fi
SHM=$(df -Pm /dev/shm 2>/dev/null | awk 'NR==2{print $2}')
info "B6 /dev/shm ${SHM:-n/a} MB (the browser is started with --disable-dev-shm-usage, so a small value is fine)"
FSTYPE=$(stat -f -c %T "$DFDIR" 2>/dev/null)
case "$FSTYPE" in
  9p|v9fs|virtiofs|nfs*|fuse*|cifs|smb*) warn "B7 filesystem $FSTYPE: SQLite WAL and unix sockets are unreliable here (migrate-schema falls back to a rollback journal)" ;;
  *) pass "B7 filesystem ${FSTYPE:-unknown}" ;;
esac
MOUNT_OPTS=$(awk -v p="$DFDIR" '{ if (index(p, $2) == 1 && length($2) > best) { best = length($2); o = $4 } } END { print o }' /proc/self/mounts 2>/dev/null)
case ",$MOUNT_OPTS," in
  *,noexec,*) fail "B8 the volume is mounted noexec: agent-browser and the native node modules cannot load from it" ;;
  *) pass "B8 the volume allows executables" ;;
esac
for d in "${HOME:-/nonexistent}" "${TMPDIR:-/tmp}"; do
  if [ -d "$d" ] && [ -w "$d" ]; then pass "B9 $d exists and is writable"
  else fail "B9 $d is missing or not writable (xvfb-run keeps its auth file in TMPDIR and exits 1 without it)"; fi
done

sec "C. runtime and toolchain"
if have node; then
  NV=$(node --version 2>/dev/null); NM=$(printf '%s' "$NV" | sed 's/^v//' | cut -d. -f1)
  if [ "${NM:-0}" -ge 22 ] 2>/dev/null; then pass "C1 node $NV at $(command -v node)"; else fail "C1 node $NV: version 22 or newer is required"; fi
else fail "C1 node is not on PATH"; fi
have npm && pass "C2 npm $(npm --version 2>/dev/null | head -n 1)" || warn "C2 npm is not on PATH (needed for step 3)"
for t in timeout sha256sum base64 mktemp tar gzip cmp awk sed grep; do
  have "$t" || warn "C3 $t is missing"
done
have curl && pass "C4 curl present" || warn "C4 curl is missing (step 4 downloads with curl; the network probes fall back to node)"
have git && pass "C5 git present" || warn "C5 git is missing (needed for step 2 route A)"
if { have g++ || have c++; } && have make && have python3; then pass "C6 native build fallback present (C++ compiler, make, python3)"
else warn "C6 no C++ compiler, make or python3: better-sqlite3 installs from a prebuilt binary; if that download fails there is no compile fallback"; fi
if [ -f "$RH/package-lock.json" ]; then pass "C7 package-lock.json present (reproducible install)"; else warn "C7 no package-lock.json in $RH: npm resolves the dependency versions at install time"; fi
if have node && [ -d "$RH" ]; then
  node "$PD/probe.js" "$RH" "$PD" > "$PD/probe.out" 2>&1
  while read -r k rest; do
    case "$k" in
      node) info "C8 node $rest" ;;
      intl-london) case "$rest" in ok*) pass "C9 Intl knows Europe/London ($rest)" ;; *) fail "C9 Intl cannot use Europe/London: $rest" ;; esac ;;
      sqlite)
        case "$rest" in
          MISSING*) later 3 "C10 better-sqlite3 is not installed ($rest)" ;;
          *) fail "C10 better-sqlite3 did not load: $rest" ;;
        esac ;;
      sqlite-journal) [ "$rest" = wal ] && pass "C10 SQLite WAL mode can be set on this volume" || warn "C10 journal mode came back as $rest (rollback journal: correct but slower)" ;;
      sqlite-second-reader) [ "$rest" = 2 ] && pass "C11 a second read-only connection sees WAL writes" || fail "C11 a second connection saw $rest rows, expected 2" ;;
      sqlite-version) info "C12 sqlite $rest" ;;
      dep-*) if [ "$rest" = ok ]; then pass "C13 ${k#dep-} installed"; else later 3 "C13 ${k#dep-} is not installed"; fi ;;
    esac
  done < "$PD/probe.out"
fi
TZNOW=${TZ:-unset}
info "C14 TZ=$TZNOW date=$(date '+%Z %z') LANG=${LANG:-unset}"
[ -e /usr/share/zoneinfo/Europe/London ] && pass "C15 /usr/share/zoneinfo/Europe/London present" || warn "C15 /usr/share/zoneinfo/Europe/London is missing (the code uses Intl, not the OS, so this is informational)"
env | grep -q '^AGENT_BROWSER_' && warn "C16 AGENT_BROWSER_* variables are set in this shell ($(env | grep -o '^AGENT_BROWSER_[A-Z_]*' | tr '\n' ' ')): the wrapper deletes them for its own calls, but do not export them anywhere" || pass "C16 no AGENT_BROWSER_* variables in the environment"

sec "D. agent-browser, Chromium, virtual display"
PIN_SHA=c89bf341a79abc28ce527a958833f6af24641d2f5e558ce54f2f583df76961ff
AB=${RESOURCER_AB_BIN:-$PH/bin/agent-browser}
if [ -x "$AB" ]; then
  if have sha256sum; then
    [ "$(sha256sum "$AB" | cut -d' ' -f1)" = "$PIN_SHA" ] && pass "D1 agent-browser at $AB has the pinned sha256" || fail "D1 agent-browser at $AB is not the pinned build (sha256 differs)"
  fi
  V=$("$AB" --version 2>&1 | head -n 1)
  [ "$V" = "agent-browser 0.21.0" ] && pass "D2 $V" || fail "D2 agent-browser reports '$V', expected 'agent-browser 0.21.0'"
else later 4 "D1 no executable agent-browser at $AB"; fi
CHROMIUM=$(env_val CHROMIUM_PATH); [ -n "${CHROMIUM_PATH:-}" ] && CHROMIUM=$CHROMIUM_PATH
CHSRC=CHROMIUM_PATH
if [ -z "$CHROMIUM" ] || [ ! -x "$CHROMIUM" ]; then
  CHROMIUM=""; CHSRC=default
  for c in /usr/bin/chromium /usr/bin/chromium-browser; do [ -z "$CHROMIUM" ] && [ -x "$c" ] && CHROMIUM=$c; done
fi
if [ -z "$CHROMIUM" ] && [ -r /etc/hermes/agent-browser-executable-path ]; then
  cand=$(head -n 1 /etc/hermes/agent-browser-executable-path)
  if [ -x "$cand" ]; then
    CHROMIUM=$cand; CHSRC=image
    info "D3 Chromium found only through the image path file /etc/hermes/agent-browser-executable-path ($cand); the code reads that file too, so no setting is needed"
  fi
fi
if [ -z "$CHROMIUM" ]; then
  fail "D3 no Chromium found (looked at CHROMIUM_PATH, /usr/bin/chromium, /usr/bin/chromium-browser, the image path file)"
else
  CV=$("$CHROMIUM" --version 2>&1 | head -n 1)
  pass "D3 chromium $CHROMIUM ($CHSRC): $CV"
fi
if have xvfb-run && have xauth && have Xvfb; then pass "D4 xvfb-run, xauth and Xvfb present"
else
  MSG="D4 virtual display tools missing (xvfb-run: $(have xvfb-run && echo yes || echo NO), xauth: $(have xauth && echo yes || echo NO), Xvfb: $(have Xvfb && echo yes || echo NO)); only the Reed browser needs them"
  if [ "$REED" = 1 ]; then fail "$MSG"; else warn "$MSG"; fi
fi
BENV="$RH/scripts/lib/browser-env.js"
TMPNAME=$(sed -n "s/.*LEAF = Object.freeze({ ab: '\([^']*\)'.*/\1/p" "$BENV" 2>/dev/null | head -n 1)
[ -n "$TMPNAME" ] || TMPNAME=t
REEDNAME=$(sed -n "s/.*LEAF = Object.freeze({ ab: '[^']*', reed: '\([^']*\)'.*/\1/p" "$BENV" 2>/dev/null | head -n 1)
[ -n "$REEDNAME" ] || REEDNAME=rt
DEFARGS=$(sed -n "s/^const DEFAULT_CHROME_ARGS = '\([^']*\)'.*/\1/p" "$BENV" 2>/dev/null | head -n 1)
[ -n "$DEFARGS" ] || DEFARGS='--no-sandbox,--disable-dev-shm-usage'
AB_TMP="$RH/state/$TMPNAME"
REED_TMP="$RH/state/$REEDNAME"
L1=$(( ${#AB_TMP} + 46 ))
if [ "$L1" -le 105 ]; then pass "D5 Chromium singleton socket path is $L1 characters (limit 107)"
elif [ "$L1" -le 107 ]; then warn "D5 Chromium singleton socket path is $L1 characters (limit 107): no slack, one more character in RESOURCER_HOME breaks it"
else warn "D5 Chromium singleton socket path would be $L1 characters (limit 107): the launch test D6 decides whether the browser still starts"; fi
L2=$(( ${#RH} + 9 + 30 ))
[ "$L2" -le 103 ] && pass "D7 agent-browser socket path is about $L2 characters (limit 103)" || info "D7 agent-browser socket path would be about $L2 characters: the code falls back to a directory under /tmp"
if [ -n "$CHROMIUM" ] && [ "$BROWSER" = 1 ]; then
  CHARGS=${RESOURCER_AB_CHROME_ARGS:-$(env_val RESOURCER_AB_CHROME_ARGS)}
  [ -n "$CHARGS" ] || CHARGS=$DEFARGS
  CHARGS=$(printf '%s' "$CHARGS" | tr ',' ' ')
  mkdir -p "$AB_TMP" "$REED_TMP" 2>/dev/null; chmod 700 "$AB_TMP" "$REED_TMP" 2>/dev/null
  # shellcheck disable=SC2086
  OUT=$(run_to 60 env TMPDIR="$AB_TMP" "$CHROMIUM" --headless=new $CHARGS --no-first-run --user-data-dir="$PD/prof" --dump-dom about:blank 2>"$PD/chrome.err"); RC=$?
  case "$OUT" in
    *"<html"*) pass "D6 headless Chromium started with the repo flags and TMPDIR=$AB_TMP" ;;
    *) fail "D6 headless Chromium failed (rc $RC) with the repo flags and TMPDIR=$AB_TMP: $(grep -m1 -iE 'socket|singleton|profile|sandbox|shared memory|error|cannot' "$PD/chrome.err" | cut -c1-160)" ;;
  esac
  if have xvfb-run && have xauth; then
    if run_to 40 xvfb-run -a true 2>"$PD/x.err"; then pass "D8 xvfb-run -a works"
    elif [ "$REED" = 1 ]; then fail "D8 xvfb-run -a failed: $(head -c 160 "$PD/x.err")"
    else warn "D8 xvfb-run -a failed (only the Reed browser needs it): $(head -c 160 "$PD/x.err")"; fi
    if [ "$REED" = 1 ]; then
      ( run_to 14 env TMPDIR="$REED_TMP" xvfb-run -a "$CHROMIUM" $CHARGS --no-first-run --user-data-dir="$PD/headed" --remote-debugging-port=0 about:blank >/dev/null 2>&1 & )
      sleep 8
      N=$(grep -la -e "[-]-user-data-dir=$PD/headed" /proc/[0-9]*/cmdline 2>/dev/null | wc -l)
      if [ "$N" -gt 0 ]; then pass "D9 headed Chromium under xvfb-run is running ($N processes after 8 s)"; else fail "D9 headed Chromium under xvfb-run did not stay up"; fi
      for p in $(grep -la -e "[-]-user-data-dir=$PD/headed" /proc/[0-9]*/cmdline 2>/dev/null | cut -d/ -f3); do kill "$p" 2>/dev/null; done
      sleep 2
    fi
  fi
elif [ "$BROWSER" = 0 ]; then info "D6 browser launch probes skipped (--no-browser)"; fi

sec "E. profile files, secrets, wrappers, repository"
if [ -f "$ENVF" ]; then
  M=$(mode_of "$ENVF")
  [ "$M" = 600 ] && pass "E1 profile .env exists, mode 600" || warn "E1 profile .env has mode $M (want 600: chmod 600 on it is safe)"
  info "E2 variable names present in the profile .env (names only): $(grep -Eo '^(export +)?[A-Za-z_][A-Za-z0-9_]*=' "$ENVF" | sed -e 's/^export *//' -e 's/=$//' | sort | tr '\n' ' ')"
else later 6 "E1 profile .env not found at $ENVF"; fi
env_has AI_GATEWAY_API_KEY && pass "E3 AI_GATEWAY_API_KEY is set in the profile .env" || later 6 "E3 AI_GATEWAY_API_KEY is not set in the profile .env"
if env_has BACKUP_PASSPHRASE || [ -s "$RH/secrets/backup-passphrase" ]; then pass "E4 backup passphrase source present"; else later 6 "E4 neither BACKUP_PASSPHRASE nor secrets/backup-passphrase exists (the nightly backup fails without it)"; fi
if [ -d "$RH/secrets" ]; then
  M=$(mode_of "$RH/secrets")
  [ "$M" = 700 ] && pass "E5 secrets/ mode 700" || warn "E5 secrets/ mode $M (want 700)"
  for f in caterer-credentials zoho-credentials; do
    if [ -s "$RH/secrets/$f.json" ]; then
      M=$(mode_of "$RH/secrets/$f.json"); [ "$M" = 600 ] && pass "E6 secrets/$f.json present, mode 600" || warn "E6 secrets/$f.json has mode $M (want 600)"
    else later 5 "E6 secrets/$f.json is missing"; fi
  done
  [ -s "$RH/secrets/reed-credentials.json" ] && info "E7 secrets/reed-credentials.json present" || info "E7 secrets/reed-credentials.json absent (only needed for step 12)"
  [ -e "$RH/secrets/bundle-passphrase" ] && warn "E8 secrets/bundle-passphrase still exists: delete it with rm once the bundle is restored"
else later 5 "E5 $RH/secrets does not exist"; fi
if [ -s "$RH/candidates.db" ]; then pass "E9 candidates.db present ($(stat -c %s "$RH/candidates.db" 2>/dev/null) bytes)"; else later 5 "E9 candidates.db is missing or empty"; fi
if [ -s "$REPO/data/resourcer-bundle.enc" ]; then pass "E9b data bundle present ($(stat -c %s "$REPO/data/resourcer-bundle.enc" 2>/dev/null) bytes)"; else later 2 "E9b $REPO/data/resourcer-bundle.enc is missing (it travels with the repository; ask the human)"; fi
if [ -d "$PH/scripts" ]; then
  n=0; missing=""; differ=""; noexec=""
  for w in "$REPO"/hermes/scripts/resourcer-*.sh; do
    [ -e "$w" ] || continue
    b=$(basename "$w"); n=$((n+1)); t="$PH/scripts/$b"
    if [ ! -f "$t" ] || [ -L "$t" ]; then missing="$missing $b"
    else
      cmp -s "$w" "$t" || differ="$differ $b"
      [ -x "$t" ] || noexec="$noexec $b"
    fi
  done
  [ -z "$missing" ] || later 9 "E10 missing from $PH/scripts or a symlink (Hermes rejects symlinks that leave that directory):$missing"
  [ -z "$differ" ] || warn "E10 differs from the repository copy (stale after a repository update: copy again):$differ"
  [ -z "$noexec" ] || fail "E10 installed wrapper is not executable (Hermes starts it directly and gets 'Permission denied', exit 126): chmod 755 on$noexec"
  [ "$n" -gt 0 ] && [ -z "$missing$differ$noexec" ] && pass "E10 all $n cron wrappers installed as executable regular files identical to the repository"
  if grep -l "$(printf '\r')" "$PH"/scripts/resourcer-*.sh >/dev/null 2>&1; then fail "E11 an installed wrapper has CRLF line endings (bash fails on them)"; else pass "E11 installed wrappers have LF endings"; fi
  GW="gate""way"
  if grep -rEiq "hermes[[:space:]]+(-p[[:space:]]+[^[:space:]]+[[:space:]]+)?${GW}[[:space:]]+(restart|stop|uninstall)" "$PH/scripts" "$REPO/hermes" 2>/dev/null; then fail "E12 text that the cron job creation scan rejects is present under scripts/ or hermes/"; else pass "E12 no text that the cron job creation scan rejects under scripts/ or hermes/"; fi
else later 9 "E10 $PH/scripts does not exist"; fi
if have git && [ -d "$REPO/.git" ]; then
  DIRTY=$(git -C "$REPO" status --porcelain 2>/dev/null | grep -v '^?? AGENTS.md$' | grep -c .)
  [ "$DIRTY" = 0 ] && pass "E13 repository has no local modifications" || warn "E13 repository has $DIRTY locally modified or untracked paths (the operator must not edit code: run git status and report)"
fi
if have node && [ -f "$REPO/tools/check-manifest.js" ]; then
  if [ -f "$REPO/MANIFEST.sha256" ]; then
    EXP=""; [ -n "${MANIFEST_EXPECT:-}" ] && EXP="--expect $MANIFEST_EXPECT"
    # shellcheck disable=SC2086
    node "$REPO/tools/check-manifest.js" --quiet $EXP > "$PD/manifest.out" 2>&1; MRC=$?
    if [ "$MRC" = 0 ]; then pass "E14 code lockdown manifest verified ($(grep -o 'MANIFEST_OK.*' "$PD/manifest.out" | head -n 1 | cut -c1-80))"
    else fail "E14 code lockdown manifest check failed (exit $MRC): $(grep -E '^(CHANGED|MISSING|UNLISTED|INSTALLED_CHANGED|MANIFEST_)' "$PD/manifest.out" | head -n 4 | tr '\n' ';' | cut -c1-300)"; fi
  else later 2 "E14 $REPO/MANIFEST.sha256 is missing: the code lockdown cannot be verified"; fi
fi

sec "F. Hermes CLI and scheduler settings"
HB=$(command -v hermes 2>/dev/null)
for c in /opt/hermes/bin/hermes /opt/hermes/.venv/bin/hermes; do [ -z "$HB" ] && [ -x "$c" ] && HB=$c; done
HPY=""
if [ -n "$HB" ]; then
  info "F1 $($HB --version 2>&1 | head -n 1 | cut -c1-80) at $HB"
  line=$(head -n 1 "$HB" 2>/dev/null | sed -n 's/^#! *//p')
  set -- $line
  if [ "${1:-}" = /usr/bin/env ]; then HPY=$(command -v "${2:-python3}" 2>/dev/null); else HPY=${1:-}; fi
  [ -x "${HPY:-/nonexistent}" ] || HPY=""
  [ -n "$HPY" ] || { [ -x /opt/hermes/.venv/bin/python ] && HPY=/opt/hermes/.venv/bin/python; }
  T=$(run_to 40 "$HB" -p "$PN" config get cron.script_timeout_seconds 2>/dev/null | grep -Eo '[0-9]+' | head -n 1)
  if [ -z "$T" ] || [ "$T" -ge 3500 ]; then pass "F2 cron.script_timeout_seconds=${T:-default 3600} (the tick wrapper bounds itself at 3450 s)"; else fail "F2 cron.script_timeout_seconds=$T is below 3500: Hermes would kill the 55 minute tick"; fi
  TZV=$(run_to 40 "$HB" -p "$PN" config get timezone 2>/dev/null | head -n 1 | cut -c1-60)
  case "$TZV" in *Europe/London*) pass "F3 Hermes timezone is Europe/London" ;; *) later 9 "F3 Hermes timezone reads '${TZV:-empty}', expected Europe/London" ;; esac
  WR=$(run_to 40 "$HB" -p "$PN" config get cron.wrap_response 2>/dev/null | head -n 1 | cut -c1-40)
  case "$WR" in *[Ff]alse*) pass "F4 cron.wrap_response is false" ;; *) later 9 "F4 cron.wrap_response reads '${WR:-empty}', expected false" ;; esac
  for k in approvals.mode terminal.backend terminal.cwd cron.provider; do info "F5 $k = $(run_to 40 "$HB" -p "$PN" config get $k 2>/dev/null | head -n 1 | cut -c1-80)"; done
  info "F6 HERMES_SCALE_TO_ZERO=${HERMES_SCALE_TO_ZERO:-unset}"
  CRON_N=$(run_to 40 "$HB" -p "$PN" cron list 2>/dev/null | grep -c 'resourcer-')
  if [ "$CRON_N" -ge 8 ]; then pass "F7 the cron list names resourcer- jobs on $CRON_N lines"; else later 9 "F7 the cron list shows $CRON_N lines naming resourcer- jobs, expected at least 8"; fi
else warn "F1 the hermes CLI was not found on PATH or under /opt/hermes: settings and cron checks skipped"; fi

sec "G. Python and dashboard plugin"
[ -n "$HPY" ] || { have python3 && HPY=$(command -v python3); }
if [ -n "$HPY" ]; then
  "$HPY" "$PD/probe.py" > "$PD/py.out" 2>&1
  while read -r k rest; do
    case "$k" in
      python) info "G1 dashboard interpreter $HPY is python $rest" ;;
      fastapi) [ "$rest" = MISSING ] && warn "G2 fastapi is not importable by $HPY (the plugin needs it; the dashboard itself uses it)" || pass "G2 fastapi $rest" ;;
      httpx) [ "$rest" = MISSING ] && info "G3 httpx is not importable (only the offline TestClient check needs it)" || info "G3 httpx $rest" ;;
      zoneinfo-london) [ "$rest" = ok ] && pass "G4 zoneinfo knows Europe/London" || warn "G4 zoneinfo cannot load Europe/London" ;;
    esac
  done < "$PD/py.out"
else warn "G1 no python interpreter found for the dashboard plugin checks"; fi
PL=/opt/data/plugins/resourcer
if [ -f "$PL/dashboard/manifest.json" ]; then
  if cmp -s "$PL/dashboard/plugin_api.py" "$REPO/plugin/resourcer/dashboard/plugin_api.py"; then pass "G5 plugin installed and identical to the repository copy"; else warn "G5 plugin installed but plugin_api.py differs from the repository copy (needs a dashboard restart after copying)"; fi
else later 10 "G5 plugin not installed at $PL"; fi
if have curl; then
  DC=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:9119/api/plugins/resourcer/health 2>/dev/null)
  case "$DC" in
    200|401) pass "G6 dashboard route /api/plugins/resourcer/health is mounted (HTTP $DC)" ;;
    404) later 10 "G6 dashboard route /api/plugins/resourcer/health answers 404 (not enabled or the dashboard was not restarted)" ;;
    *) info "G6 dashboard on 127.0.0.1:9119 answered '${DC:-no connection}'" ;;
  esac
fi

if [ "$OFFLINE" = 0 ]; then
  sec "H. network (HEAD or GET only, no login, no candidate data)"
  IPJ=""
  have curl && IPJ=$(curl -sS -m 15 https://ipinfo.io/json 2>/dev/null)
  CC=$(printf '%s\n' "$IPJ" | sed -n 's/.*"country": *"\([A-Z]*\)".*/\1/p' | head -n 1)
  IPM=$(printf '%s\n' "$IPJ" | sed -n 's/.*"ip": *"\([0-9]*\.[0-9]*\)\..*/\1.x.x/p' | head -n 1)
  ORG=$(printf '%s\n' "$IPJ" | sed -n 's/.*"org": *"\([^"]*\)".*/\1/p' | head -n 1 | cut -c1-50)
  if [ "$CC" = GB ]; then pass "H1 egress country GB (${IPM:-?}, ${ORG:-unknown network})"
  elif [ -n "$CC" ]; then warn "H1 egress country $CC (${IPM:-?}, ${ORG:-unknown network}): Reed answers HTTP 451 to a session created outside the UK"
  else warn "H1 egress country could not be read from ipinfo.io (curl missing or no answer)"; fi
  SKEW_BASE=""
  http_probe GET https://ai-gateway.vercel.sh/v1/models
  case "$HP_CODE" in 2*) pass "H2 AI Gateway model catalog reachable (HTTP $HP_CODE)"; SKEW_BASE=$HP_DATE ;; *) fail "H2 AI Gateway not reachable (HTTP $HP_CODE)" ;; esac
  KEY=$(env_val AI_GATEWAY_API_KEY)
  if [ -n "$KEY" ]; then
    authed_get https://ai-gateway.vercel.sh/v1/credits
    case "$HP_CODE" in
      200) pass "H3 AI Gateway accepts the key and reports credits (HTTP 200)" ;;
      401|403) fail "H3 AI Gateway rejected the key (HTTP $HP_CODE): wrong or revoked key" ;;
      402) fail "H3 AI Gateway says no credits (HTTP 402)" ;;
      404) info "H3 the credits endpoint answered 404 for this key type (the canary in install step 7 covers auth)" ;;
      *) warn "H3 AI Gateway credits check answered HTTP $HP_CODE" ;;
    esac
  else later 6 "H3 AI Gateway key check skipped: no AI_GATEWAY_API_KEY in the profile .env"; fi
  KEY=""
  http_probe HEAD https://accounts.zoho.eu/
  case "$HP_CODE" in [23]*|40[0-9]) pass "H4 Zoho accounts.zoho.eu reachable (HTTP $HP_CODE)" ;; *) fail "H4 Zoho accounts.zoho.eu not reachable (HTTP $HP_CODE)" ;; esac
  http_probe HEAD https://recruit.zoho.eu/
  case "$HP_CODE" in [23]*|40[0-9]) pass "H5 Zoho recruit.zoho.eu reachable (HTTP $HP_CODE)" ;; *) fail "H5 Zoho recruit.zoho.eu not reachable (HTTP $HP_CODE)" ;; esac
  http_probe HEAD https://recruiter.caterer.com/login
  case "$HP_CODE" in
    [23]*) pass "H6 Caterer login page reachable (HTTP $HP_CODE, server ${HP_SERVER:-?})" ;;
    403|429|503) warn "H6 Caterer login page answered HTTP $HP_CODE to a plain client (server ${HP_SERVER:-?}): the pipeline uses a real browser, so this alone is not a failure; step 8 decides" ;;
    *) fail "H6 Caterer login page not reachable (HTTP $HP_CODE)" ;;
  esac
  http_probe HEAD https://www.reed.co.uk/
  case "$HP_CODE" in
    [23]*) pass "H7 Reed website reachable (HTTP $HP_CODE, server ${HP_SERVER:-?})" ;;
    403|429|503) warn "H7 Reed website answered HTTP $HP_CODE to a plain client (server ${HP_SERVER:-?}): expected for a bot check; only step 12 needs Reed" ;;
    *) warn "H7 Reed website not reachable (HTTP $HP_CODE)" ;;
  esac
  http_probe GET https://api.postcodes.io/outcodes/M1
  case "$HP_CODE" in 2*) pass "H8 postcodes.io reachable (HTTP $HP_CODE)" ;; *) warn "H8 postcodes.io not reachable (HTTP $HP_CODE): territory city lookups fall back to cached data" ;; esac
  http_probe HEAD https://github.com/vercel-labs/agent-browser/releases/download/v0.21.0/agent-browser-linux-x64
  case "$HP_CODE" in [23]*) pass "H9 the agent-browser download host is reachable (HTTP $HP_CODE)" ;; *) warn "H9 the agent-browser download host is not reachable (HTTP $HP_CODE): use the npm route in install step 4" ;; esac
  http_probe HEAD https://registry.npmjs.org/better-sqlite3
  case "$HP_CODE" in [23]*) pass "H10 the npm registry is reachable (HTTP $HP_CODE)" ;; *) fail "H10 the npm registry is not reachable (HTTP $HP_CODE): step 3 cannot run" ;; esac
  if [ -n "$SKEW_BASE" ] && have date; then
    GW_T=$(date -u -d "$SKEW_BASE" +%s 2>/dev/null); NOW_T=$(date -u +%s)
    if [ -n "$GW_T" ]; then
      D=$(( NOW_T - GW_T )); [ "$D" -lt 0 ] && D=$(( -D ))
      [ "$D" -le 120 ] && pass "H11 system clock within ${D} s of the AI Gateway clock" || warn "H11 system clock differs from the AI Gateway clock by ${D} s"
    fi
  fi
else info "H. network probes skipped (--offline)"; fi

printf 'PREFLIGHT_RESULT pass=%s warn=%s fail=%s\n' "$PASS" "$WARN" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
