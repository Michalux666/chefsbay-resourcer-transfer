#!/usr/bin/env bash
# smoke-linux.sh - credential-free smoke tests for the browser stack on the Hermes instance.
#
#   bash tests/browser/smoke-linux.sh            run everything that can run here
#   SMOKE_NET=1   also run the egress-country check (one request to a third-party IP echo service)
#   SMOKE_LONG=1  also run the 10 minute idle/reaper coexistence check
#   SMOKE_KEEP=1  keep the temp dir for inspection
#
# What it proves (numbers follow research/agent-browser-linux.md section 8): the pinned agent-browser 0.21.0
# and the system chromium work together, every call form the pipeline uses behaves as documented, one backend
# only, the daemon survives its parent and a timed-out CLI, state save/load round-trips, the wrapper
# (scripts/lib/browser.js) pins its environment, and (when the Reed launcher exists) chromium under xvfb
# serves CDP on loopback only.
#
# It never contacts Caterer, Reed or any credentialed service, uses an isolated socket dir, session names
# and temp dir (the production caterer session is not touched) and cleans up after itself.
# Exit 0: all pass (skips and warnings allowed, including "chromium absent"). Exit 1: at least one FAIL.
# Needs only bash, node, coreutils and /proc (no ps or pgrep). The temp dir is always a short /tmp path: Chromium's singleton
# socket sits at TMPDIR + 46 characters and the kernel allows 107, so a long scratch directory would fail for the wrong reason.

set -u
PASS=0; FAIL=0; SKIP=0; WARN=0
pass() { PASS=$((PASS+1)); printf 'PASS %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$1"; }
skip() { SKIP=$((SKIP+1)); printf 'SKIP %s\n' "$1"; }
warn() { WARN=$((WARN+1)); printf 'WARN %s\n' "$1"; }
summary() { printf 'SMOKE_RESULT: pass=%s fail=%s skip=%s warn=%s\n' "$PASS" "$FAIL" "$SKIP" "$WARN"; }
# one line per process with the arguments joined by spaces (Chromium rewrites its own into one element); no ps or pgrep needed
proc_cmds() { local f; for f in /proc/[0-9]*/cmdline; do tr '\0' ' ' < "$f" 2>/dev/null; echo; done; }
count_comm() { local f c n=0; for f in /proc/[0-9]*/comm; do read -r c < "$f" 2>/dev/null && [ "$c" = "$1" ] && n=$((n+1)); done; echo "$n"; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
RES="$REPO/resourcer"
PINNED_VERSION="0.21.0"
PINNED_SHA="c89bf341a79abc28ce527a958833f6af24641d2f5e558ce54f2f583df76961ff"
MARK_X=$'\xe2\x9c\x97'

echo "== smoke-linux: browser stack (agent-browser ${PINNED_VERSION} + chromium) =="

# ---- 0. host facts (informational) --------------------------------------------------------------
echo "-- 0 host facts"
printf '   arch=%s uid=%s node=%s\n' "$(uname -m)" "$(id -u)" "$(node -v 2>/dev/null || echo missing)"
for c in chromium chromium-browser xvfb-run xauth Xvfb python3; do
  printf '   %s=%s\n' "$c" "$(command -v "$c" 2>/dev/null || echo -)"
done
if ! command -v node >/dev/null 2>&1; then fail "0 node is not installed"; summary; exit 1; fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -ge 22 ] 2>/dev/null; then pass "0 node >= 22 ($(node -v))"; else fail "0 node >= 22 required, found $(node -v)"; fi
[ "$(uname -m)" = "x86_64" ] && pass "0 x86_64 (the pinned binary is linux-x64)" || warn "0 architecture is $(uname -m): the pinned linux-x64 binary will not run"

CHROMIUM=""
if [ -n "${CHROMIUM_PATH:-}" ] && [ -x "${CHROMIUM_PATH}" ]; then CHROMIUM="$CHROMIUM_PATH"; fi
if [ -z "$CHROMIUM" ]; then CHROMIUM="$(command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null || true)"; fi
if [ -z "$CHROMIUM" ] && [ -r /etc/hermes/agent-browser-executable-path ]; then
  REC="$(head -1 /etc/hermes/agent-browser-executable-path)"; [ -x "$REC" ] && CHROMIUM="$REC"
fi
if [ -z "$CHROMIUM" ]; then
  echo "SKIP: chromium not found (install it or set CHROMIUM_PATH). Nothing browser-related was tested."
  SKIP=$((SKIP+1)); summary; exit 0
fi
printf '   chromium=%s (%s)\n' "$CHROMIUM" "$("$CHROMIUM" --version 2>/dev/null | head -1)"
if command -v xauth >/dev/null 2>&1 || ! command -v xvfb-run >/dev/null 2>&1; then :; else warn "0 xvfb-run present but xauth missing: the Reed launcher will fail"; fi

AB="${RESOURCER_AB_BIN:-}"
if [ -z "$AB" ]; then
  LAYOUT_HOME="$(cd "$RES/../.." 2>/dev/null && pwd)"
  for c in "$LAYOUT_HOME/bin/agent-browser" "${HERMES_HOME:-$LAYOUT_HOME}/bin/agent-browser" "$RES/bin/agent-browser"; do
    if [ -x "$c" ]; then AB="$c"; break; fi
  done
fi
if [ -z "$AB" ]; then AB="$(command -v agent-browser 2>/dev/null || true)"; fi
if [ -z "$AB" ] || [ ! -x "$AB" ]; then
  fail "1 agent-browser is not installed (expected \$HERMES_HOME/bin/agent-browser or RESOURCER_AB_BIN; see docs/INSTALL.md)"
  summary; exit 1
fi
export RESOURCER_AB_BIN="$AB"

# ---- isolation ----------------------------------------------------------------------------------
SMOKE="$(mktemp -d /tmp/rsmoke.XXXXXX)" || { fail "cannot create a temp dir under /tmp"; summary; exit 1; }
LONGHOME=""
mkdir -p "$SMOKE/sock" "$SMOKE/tmp" "$SMOKE/home" "$SMOKE/hermes" "$SMOKE/srv"
SRV_PID=""; REED_STARTED=0
cleanup() {
  echo "-- 24 cleanup"
  abx close >/dev/null 2>&1
  RESOURCER_HOME="$SMOKE/home" HERMES_HOME="$SMOKE/hermes" node -e "require('$RES/scripts/lib/browser.js').reset().then(function(){process.exit(0)},function(){process.exit(0)})" >/dev/null 2>&1
  if [ "$REED_STARTED" = "1" ]; then
    RESOURCER_HOME="$SMOKE/home" HERMES_HOME="$SMOKE/hermes" REED_CDP_PORT="$REED_PORT" REED_CHROME_PROFILE="$SMOKE/chrome-reed" \
      node "$RES/scripts/ensure-chrome-cdp.js" --stop --force >/dev/null 2>&1
  fi
  if [ -n "$SRV_PID" ]; then kill "$SRV_PID" >/dev/null 2>&1; fi
  local leftover
  if [ -n "$LONGHOME" ]; then
    RESOURCER_HOME="$LONGHOME" HERMES_HOME="$SMOKE/hermes" node -e "var b=require('$RES/scripts/lib/browser.js');b.status().then(function(s){return b.reset().then(function(){require('fs').rmSync(require('path').dirname(s.tmpDir),{recursive:true,force:true});process.exit(0)})}).catch(function(){process.exit(0)})" >/dev/null 2>&1
  fi
  leftover="$(proc_cmds | grep -c -- "--user-data-dir=$SMOKE" || true)"
  if [ "${leftover:-0}" -le 1 ]; then pass "24 no browser process of this smoke run is left"; else fail "24 $leftover browser processes of this run are still alive"; fi
  if [ "${SMOKE_KEEP:-0}" = "1" ]; then echo "   kept $SMOKE"; else rm -rf "$SMOKE"; fi
  summary
  if [ "$FAIL" -gt 0 ]; then exit 1; fi
  exit 0
}
trap cleanup EXIT

# direct CLI calls: isolated socket dir, own session, chrome profile under the temp dir
abx() {
  timeout 120 env AGENT_BROWSER_SOCKET_DIR="$SMOKE/sock" AGENT_BROWSER_EXECUTABLE_PATH="$CHROMIUM" \
    AGENT_BROWSER_ARGS="--no-sandbox,--disable-dev-shm-usage" NO_COLOR=1 TMPDIR="$SMOKE/tmp" \
    "$AB" --session smoke "$@"
}
b64() { printf '%s' "$1" | base64 -w0; }
# the wrapper under test, with its own isolated RESOURCER_HOME
wrap() {
  RESOURCER_HOME="$SMOKE/home" HERMES_HOME="$SMOKE/hermes" RESOURCER_AB_NAV_GAP_MS=0 CHROMIUM_PATH="$CHROMIUM" RES="$RES" "$@"
}

# ---- 1. install integrity -----------------------------------------------------------------------
echo "-- 1 install integrity"
SHA="$(sha256sum "$AB" 2>/dev/null | cut -d' ' -f1)"
VER="$("$AB" --version 2>&1 | head -1)"
if [ "$SHA" = "$PINNED_SHA" ]; then pass "1 sha256 matches the pinned build"; else fail "1 sha256 is $SHA (pinned $PINNED_SHA)"; fi
if [ "$VER" = "agent-browser $PINNED_VERSION" ]; then pass "1 version is exactly '$VER'"; else fail "1 version is '$VER', expected 'agent-browser $PINNED_VERSION'"; fi

# ---- 2. no stray environment --------------------------------------------------------------------
echo "-- 2 stray environment"
STRAY="$(env | grep '^AGENT_BROWSER_' || true)"
PROFILES="$(grep -Rs 'AGENT_BROWSER' /etc/profile.d /etc/environment "$HOME/.profile" "$HOME/.bashrc" 2>/dev/null || true)"
if [ -z "$STRAY$PROFILES" ]; then pass "2 no AGENT_BROWSER_* settings in the environment or login profiles"
else warn "2 AGENT_BROWSER_* is set outside the wrapper (harmless: the wrapper overrides it): $(printf '%s %s' "$STRAY" "$PROFILES" | tr '\n' ' ' | cut -c1-200)"; fi

# ---- 3. test page and server --------------------------------------------------------------------
echo "-- 3 local test page"
printf '<html><body><input name=username><input type=password name=password><button type=submit>Go</button><p id=n>0 candidates</p></body></html>' > "$SMOKE/srv/t.html"
echo '{"a":1}' > "$SMOKE/srv/d.json"
head -c 5000 /dev/urandom > "$SMOKE/srv/bin.dat"
cat > "$SMOKE/server.js" <<'EOF'
const http = require('http'), fs = require('fs'), path = require('path');
const dir = process.argv[2];
const srv = http.createServer((req, res) => {
  const f = path.join(dir, path.basename(req.url.split('?')[0]));
  fs.readFile(f, (e, b) => {
    if (e) { res.statusCode = 404; return res.end('nf'); }
    res.setHeader('content-type', f.endsWith('.json') ? 'application/json' : f.endsWith('.html') ? 'text/html' : 'application/octet-stream');
    if (f.endsWith('.cv')) res.setHeader('cache-control', 'private, max-age=600');
    res.end(b);
  });
});
srv.listen(0, '127.0.0.1', () => { fs.writeFileSync(path.join(dir, '..', 'port'), String(srv.address().port)); });
EOF
node "$SMOKE/server.js" "$SMOKE/srv" >/dev/null 2>&1 &
SRV_PID=$!
for i in 1 2 3 4 5 6 7 8 9 10; do [ -s "$SMOKE/port" ] && break; sleep 0.5; done
PORT="$(cat "$SMOKE/port" 2>/dev/null || true)"
BASE="http://127.0.0.1:$PORT"
if [ -n "$PORT" ] && node -e "require('http').get('$BASE/d.json',function(r){var s='';r.on('data',function(c){s+=c});r.on('end',function(){process.exit(s.trim()==='{\"a\":1}'?0:1)})}).on('error',function(){process.exit(1)})"; then
  pass "3 test server up on 127.0.0.1:$PORT"
else
  fail "3 test server did not start"; exit 1
fi

# ---- 4-6 open / wait / get url ------------------------------------------------------------------
echo "-- 4-6 open, wait, get url"
if abx open "$BASE/t.html" >/dev/null 2>&1; then pass "4 F1 open (daemon + chromium launched)"; else fail "4 F1 open failed"; fi
if abx wait --load networkidle >/dev/null 2>&1; then pass "5 F2 wait --load networkidle"; else fail "5 F2 wait failed"; fi
[ "$(abx get url 2>/dev/null | tail -1)" = "$BASE/t.html" ] && pass "6 F4 get url" || fail "6 F4 get url did not return the test page"

# ---- 7-11 eval forms ----------------------------------------------------------------------------
echo "-- 7-11 eval"
[ "$(abx eval -b "$(b64 '1+1')" 2>/dev/null | tail -1)" = "2" ] && pass "7 F3 eval, number is printed bare" || fail "7 eval number"
OUT="$(abx eval -b "$(b64 'JSON.stringify({s:1})')" 2>/dev/null | tail -1)"
if [ "$OUT" = '"{\"s\":1}"' ]; then pass "8 F3 eval, string comes back quoted and escaped"; else fail "8 eval string form was: $OUT"; fi
JS='(async()=>{var r=await fetch("/d.json");return JSON.stringify({status:r.status,body:await r.text()})})()'
OUT="$(abx eval -b "$(b64 "$JS")" 2>/dev/null)"
if printf '%s' "$OUT" | node -e 'var s=require("fs").readFileSync(0,"utf8").trim();var a=JSON.parse(s);var b=typeof a==="string"?JSON.parse(a):a;process.exit(b.status===200&&b.body==="{\"a\":1}\n"?0:1)'; then
  pass "9 F3 async fetch (the unlock shape) double-decodes to status 200 and the body"
else fail "9 async fetch output: $OUT"; fi
BJS="$(node -e "process.stdout.write(require('$RES/scripts/caterer-browser-fetch.js').buildBinaryFetchJs('/bin.dat', 30000))")"
OUT="$(abx eval -b "$(b64 "$BJS")" 2>/dev/null)"
if printf '%s' "$OUT" | node -e '
var fs=require("fs");var s=fs.readFileSync(0,"utf8").trim();var a=JSON.parse(s);var b=typeof a==="string"?JSON.parse(a):a;
var want=fs.readFileSync(process.argv[1]);process.exit(b.size===5000&&Buffer.from(b.base64,"base64").equals(want)?0:1)' "$SMOKE/srv/bin.dat"; then
  pass "10 F3 binary fetch (the CV shape): 5000 bytes identical after base64 through the browser"
else fail "10 binary fetch did not round-trip"; fi
ERR="$(abx eval -b "$(b64 'throw new Error("x")')" 2>&1 >/dev/null)"; RC=$?
case "$ERR" in "$MARK_X"*) [ "$RC" -eq 1 ] && pass "11 error form: exit 1 and a line starting with the cross mark" || fail "11 exit code was $RC";; *) fail "11 error text did not start with the cross mark: $ERR";; esac

# ---- 12 state save schema -----------------------------------------------------------------------
echo "-- 12 state save"
abx eval -b "$(b64 'document.cookie="k=v; path=/"; localStorage.setItem("a","b"); 1')" >/dev/null 2>&1
if abx state save "$SMOKE/s.json" >/dev/null 2>&1 && node -e '
var s=require(process.argv[1]);var ok=Array.isArray(s.cookies)&&Array.isArray(s.origins);
var c=s.cookies.find(function(x){return x.name==="k"});
ok=ok&&c&&["name","value","domain","path","expires"].every(function(k){return k in c});
ok=ok&&s.origins.some(function(o){return /127\.0\.0\.1/.test(o.origin)});
process.exit(ok?0:1)' "$SMOKE/s.json"; then
  pass "12 F5 state save: keys cookies+origins, cookie fields present, origin recorded"
else fail "12 state save schema check failed"; fi

# ---- 13 one backend, also from a login shell through the wrapper --------------------------------
echo "-- 13 one backend"
profiles() { proc_cmds | grep -o -- "--user-data-dir=$SMOKE/[^ ]*agent-browser-chrome-[a-f0-9-]*" | sort -u | wc -l; }
if [ -S "$SMOKE/sock/smoke.sock" ] && [ "$(profiles)" -eq 1 ]; then pass "13 one daemon socket and one Chrome profile for the direct session"; else fail "13 sockets/profiles: $(ls "$SMOKE/sock" | tr '\n' ' ') profiles=$(profiles)"; fi
LOGIN_OUT="$(wrap bash -lc "AGENT_BROWSER_SOCKET_DIR=/tmp/login-shell-would-set-this node -e \"var b=require('$RES/scripts/lib/browser.js');b.open('$BASE/t.html').then(function(){return b.getUrl()}).then(function(u){console.log(u);process.exit(0)})\"" 2>&1 | tail -1)"
WSOCK="$(ls "$SMOKE/home/state/ab" 2>/dev/null | tr '\n' ' ')"
if [ "$LOGIN_OUT" = "$BASE/t.html" ] && [ ! -e /tmp/login-shell-would-set-this ]; then
  pass "13 wrapper called from a login shell with a hostile AGENT_BROWSER_SOCKET_DIR still used its own dir ($WSOCK)"
else fail "13 wrapper from a login shell: url='$LOGIN_OUT' dir=$WSOCK"; fi

# ---- 14 headless without a display --------------------------------------------------------------
echo "-- 14 headless"
if [ "$(env -u DISPLAY timeout 60 env AGENT_BROWSER_SOCKET_DIR="$SMOKE/sock" "$AB" --session smoke get url 2>/dev/null | tail -1)" = "$BASE/t.html" ] \
   && proc_cmds | grep -q -- "--headless=new.*$SMOKE"; then
  pass "14 works with DISPLAY unset and chromium runs --headless=new"
else fail "14 headless check failed (DISPLAY=${DISPLAY:-unset})"; fi

# ---- 15 restart persistence via state load ------------------------------------------------------
echo "-- 15 restart persistence"
abx close >/dev/null 2>&1; sleep 2
if abx state load "$SMOKE/s.json" >/dev/null 2>&1 && abx open "$BASE/t.html" >/dev/null 2>&1; then
  OUT="$(abx eval -b "$(b64 'document.cookie+"|"+localStorage.getItem("a")')" 2>/dev/null | tail -1)"
  if [ "$OUT" = '"k=v|b"' ]; then pass "15 F6 state load on a cold daemon restores the cookie and localStorage"; else fail "15 restored state was: $OUT"; fi
else fail "15 state load / open failed"; fi

# ---- 16 daemon survives its parent --------------------------------------------------------------
echo "-- 16 daemon outlives the launching shell"
setsid bash -c "AGENT_BROWSER_SOCKET_DIR='$SMOKE/sock' '$AB' --session smoke get url >/dev/null 2>&1" &
wait $! 2>/dev/null; sleep 2
if [ "$(abx get url 2>/dev/null | tail -1)" = "$BASE/t.html" ]; then pass "16 daemon still answers after the shell that started a call has exited"; else fail "16 daemon did not survive"; fi

# ---- 17 timeout + kill semantics through the wrapper --------------------------------------------
echo "-- 17 wrapper timeout keeps the daemon alive"
wprofiles() { proc_cmds | grep -o -- "--user-data-dir=$SMOKE/home/[^ ]*agent-browser-chrome-[a-f0-9-]*" | sort -u | wc -l; }
WBEFORE="$(wprofiles)"
OUT="$(wrap node -e "
var b=require('$RES/scripts/lib/browser.js');
(async function(){
  await b.open('$BASE/t.html');
  var t0=Date.now();
  var r=await b.evalJs('new Promise(function(r){setTimeout(r,9000)})',{timeoutMs:3000,label:'t'});
  console.log(r.timedOut+' '+r.out+' '+(Date.now()-t0<6000?'prompt':'slow'));
  console.log(await b.getUrl({timeoutMs:40000}));
  process.exit(0);
})();" 2>&1)"
FIRST="$(printf '%s\n' "$OUT" | sed -n 1p)"; SECOND="$(printf '%s\n' "$OUT" | sed -n 2p)"
WAFTER="$(wprofiles)"
if [ "$FIRST" = "true Error: TIMEOUT after 3s (t) prompt" ] && [ "$SECOND" = "$BASE/t.html" ] && [ "$WAFTER" -eq "$WBEFORE" ] && [ "$WAFTER" -ge 1 ]; then
  pass "17 timeout returned promptly, daemon and Chrome survived, the next call answered (queued behind the abandoned eval)"
else fail "17 wrapper timeout result: $OUT (wrapper Chrome profiles before=$WBEFORE after=$WAFTER)"; fi

# ---- 18 wrapper environment pinning -------------------------------------------------------------
echo "-- 18 wrapper env pinning"
OUT="$(wrap env AGENT_BROWSER_ENCRYPTION_KEY=x AGENT_BROWSER_NATIVE=0 AGENT_BROWSER_SOCKET_DIR=/nowhere node -e "
var b=require('$RES/scripts/lib/browser.js');
b._internal.ready().then(function(ctx){var e=b._internal.buildEnv(ctx);
  console.log([/state\\/ab|rab-/.test(e.AGENT_BROWSER_SOCKET_DIR),e.NO_COLOR,'AGENT_BROWSER_ENCRYPTION_KEY' in e,e.AGENT_BROWSER_NATIVE===undefined,e.AGENT_BROWSER_EXECUTABLE_PATH===process.env.CHROMIUM_PATH].join(' '));process.exit(0)})" 2>&1 | tail -1)"
if [ "$OUT" = "true 1 false true true" ]; then pass "18 socket dir forced, colour off, encryption key and native flag scrubbed, executable pinned"; else fail "18 buildEnv answered: $OUT"; fi

# ---- 18b TMPDIR budget, browser locale, and a workspace root too long for Chromium's socket ------
echo "-- 18b singleton budget, locale, long workspace root"
cat > "$SMOKE/probe-budget.js" <<'JS'
var b = require(process.env.RES + '/scripts/lib/browser.js');
b.status().then(function (s) { console.log([s.singleton.margin >= 0, s.singleton.limit, s.singleton.pathLen, s.singleton.relocated].join(' ')); process.exit(0); });
JS
cat > "$SMOKE/probe-locale.js" <<'JS'
var b = require(process.env.RES + '/scripts/lib/browser.js');
(async function () {
  await b.open(process.argv[2] + '/t.html');
  var r = await b.evalJs('Intl.DateTimeFormat().resolvedOptions().timeZone + "|" + navigator.language');
  console.log(r.out);
  process.exit(0);
})();
JS
cat > "$SMOKE/probe-long.js" <<'JS'
var b = require(process.env.RES + '/scripts/lib/browser.js');
(async function () {
  var o = await b.open(process.argv[2] + '/t.html');
  var u = await b.getUrl();
  var s = await b.status();
  console.log([u, s.singleton.relocated, s.singleton.margin, o.ok].join(' '));
  process.exit(0);
})();
JS
OUT="$(wrap node "$SMOKE/probe-budget.js" 2>&1 | tail -1)"
read -r B_OK B_LIMIT B_LEN B_MOVED <<< "$OUT"
if [ "$B_OK" = "true" ] && [ "$B_LIMIT" = "107" ]; then pass "18b the wrapper's TMPDIR leaves a singleton socket path of $B_LEN of 107 characters (moved to /tmp: $B_MOVED)"
else fail "18b singleton budget answered: $OUT"; fi
OUT="$(wrap node "$SMOKE/probe-locale.js" "$BASE" 2>&1 | tail -1)"
if [ "$OUT" = '"Europe/London|en-GB"' ]; then pass "18b the browser reports Europe/London and en-GB"
else warn "18b the browser reports $OUT (expected Europe/London and en-GB; a UTC/en-US browser behind a UK address is an avoidable bot signal; the effect on the live site is unverified)"; fi
LONGHOME="$SMOKE/a-workspace-root-with-a-deliberately-long-directory-name-to-exceed-the-socket-path-budget"
mkdir -p "$LONGHOME"
OUT="$(RESOURCER_HOME="$LONGHOME" HERMES_HOME="$SMOKE/hermes" RESOURCER_AB_NAV_GAP_MS=0 CHROMIUM_PATH="$CHROMIUM" RES="$RES" timeout 150 node "$SMOKE/probe-long.js" "$BASE" 2>&1 | tail -1)"
case "$OUT" in
  "$BASE/t.html true "*" true") pass "18b a workspace root too long for Chromium's socket path still starts the browser (TMPDIR moved to a short /tmp directory; margin ${OUT#* true })";;
  *) fail "18b long workspace root: $OUT";;
esac

# ---- 18c a fetched CV leaves no copy in the live browser profile's HTTP cache --------------------
echo "-- 18c CV fetch and the browser cache (the daemon stays up all day, agent-browser deletes the profile only when it closes)"
cache_leak_count() {
  local mark="$1" file="$2" mode="$3" js
  printf '%s%s%s%s%s%s%s%s' "$mark" "$mark" "$mark" "$mark" "$mark" "$mark" "$mark" "$mark" > "$SMOKE/srv/$file"
  js="$(RESOURCER_FETCH_CACHE="$mode" node -e "process.stdout.write(require('$RES/scripts/caterer-browser-fetch.js').buildBinaryFetchJs('/$file', 30000))")"
  abx open "$BASE/t.html" >/dev/null 2>&1
  abx eval -b "$(b64 "$js")" >/dev/null 2>&1
  sleep 3
  grep -rl -- "$mark" "$SMOKE/tmp" 2>/dev/null | wc -l
}
LEAK_CONTROL="$(cache_leak_count "SMOKE-CV-CONTROL-$$-$RANDOM" control.cv default)"
LEAK_STORE="$(cache_leak_count "SMOKE-CV-NOSTORE-$$-$RANDOM" nostore.cv no-store)"
if [ "$LEAK_STORE" -eq 0 ]; then
  pass "18c a CV fetched with the default no-store option leaves no copy in the browser profile"
  if [ "$LEAK_CONTROL" -ge 1 ]; then pass "18c control: the same fetch without no-store DOES leave $LEAK_CONTROL cache file(s), so the check can see a leak"
  else warn "18c control: the plain fetch left no cache file either, so this browser build may not cache such responses (the no-store result proves nothing here)"; fi
else fail "18c a CV fetched with cache no-store still left $LEAK_STORE file(s) with its content in the browser profile"; fi

# ---- 19 reaper coexistence (long, opt-in) -------------------------------------------------------
echo "-- 19 reaper coexistence"
if [ "${SMOKE_LONG:-0}" = "1" ]; then
  echo "   idling 10 minutes; run a Hermes browser task now in another session"
  sleep 600
  if [ -S "$SMOKE/sock/smoke.sock" ] && [ "$(abx get url 2>/dev/null | tail -1)" = "$BASE/t.html" ]; then pass "19 daemon survived 10 idle minutes"; else fail "19 daemon was removed while idle"; fi
else skip "19 set SMOKE_LONG=1 to run the 10 minute idle check"; fi

# ---- 20-22 Reed launcher (only when the launcher exists) ----------------------------------------
echo "-- 20-22 Reed chromium under xvfb"
if [ -f "$RES/scripts/ensure-chrome-cdp.js" ] && command -v xvfb-run >/dev/null 2>&1 && command -v xauth >/dev/null 2>&1; then
  cat > "$SMOKE/cdp.js" <<'EOF'
// usage: node cdp.js version|protocol|listen <port>
const http = require('http'), fs = require('fs');
const [mode, portStr] = process.argv.slice(2), port = Number(portStr);
function get(p, cb) {
  http.get({ host: '127.0.0.1', port, path: p, timeout: 15000 }, (r) => { let s = ''; r.on('data', (c) => { s += c; }); r.on('end', () => cb(null, s)); })
    .on('error', (e) => cb(e)).on('timeout', function () { this.destroy(new Error('timeout')); });
}
if (mode === 'version') get('/json/version', (e, s) => { try { console.log(JSON.parse(s).Browser); } catch (x) { console.log('none'); } });
else if (mode === 'protocol') get('/json/protocol', (e, s) => {
  try {
    const n = JSON.parse(s).domains.find((d) => d.domain === 'Network');
    console.log(n.commands.some((c) => c.name === 'setRequestInterception') + ' ' + n.events.some((x) => x.name === 'requestWillBeSent'));
  } catch (x) { console.log('unavailable'); }
});
else if (mode === 'listen') {
  const found = [];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      for (const l of fs.readFileSync(f, 'utf8').split('\n').slice(1)) {
        const p = l.trim().split(/\s+/);
        if (p[3] !== '0A') continue;
        const a = p[1].split(':');
        if (parseInt(a[1], 16) !== port) continue;
        if (/^0+$/.test(a[0])) found.push('all');
        else if (a[0] === '0100007F' || a[0] === '00000000000000000000000001000000') found.push('loopback');
        else found.push('other:' + a[0]);
      }
    } catch (x) { /* not readable */ }
  }
  console.log(found.length ? found.join(',') : 'none');
}
EOF
  REED_PORT="$(node -e "var s=require('net').createServer().listen(0,'127.0.0.1',function(){console.log(s.address().port);s.close()})")"
  XBEFORE="$(count_comm Xvfb)"
  REED_STARTED=1
  ROUT="$(RESOURCER_HOME="$SMOKE/home" HERMES_HOME="$SMOKE/hermes" CHROMIUM_PATH="$CHROMIUM" REED_CDP_PORT="$REED_PORT" \
    REED_CHROME_PROFILE="$SMOKE/chrome-reed" REED_TARGET_URL=about:blank REED_CDP_WAIT_S=45 node "$RES/scripts/ensure-chrome-cdp.js" 2>&1 | tail -3)"
  VJ="$(node "$SMOKE/cdp.js" version "$REED_PORT" 2>/dev/null)"
  LISTEN="$(node "$SMOKE/cdp.js" listen "$REED_PORT" 2>/dev/null)"
  if printf '%s' "$ROUT" | grep -q 'CDP_READY' && printf '%s' "$VJ" | grep -q 'Chrome'; then pass "20 Reed chromium serves CDP under xvfb ($VJ)"; else fail "20 Reed launcher said: $ROUT (version: $VJ)"; fi
  case "$LISTEN" in
    loopback) pass "20 CDP listens on loopback only";;
    none|"") fail "20 could not find the listening socket for port $REED_PORT";;
    *) fail "20 CDP listening address is not loopback only ($LISTEN)";;
  esac
  PROTO="$(node "$SMOKE/cdp.js" protocol "$REED_PORT" 2>/dev/null)"
  if [ "$PROTO" = "false true" ]; then pass "21 CDP surface: no setRequestInterception, requestWillBeSent present (token capture must use it)"; else warn "21 CDP protocol answered '$PROTO' (expected 'false true')"; fi
  RESOURCER_HOME="$SMOKE/home" HERMES_HOME="$SMOKE/hermes" REED_CDP_PORT="$REED_PORT" REED_CHROME_PROFILE="$SMOKE/chrome-reed" node "$RES/scripts/ensure-chrome-cdp.js" --stop --force >/dev/null 2>&1
  REED_STARTED=0; sleep 4
  XAFTER="$(count_comm Xvfb)"
  LEFT="$(proc_cmds | grep -c -- "--user-data-dir=$SMOKE/chrome-reed" || true)"; LEFT="${LEFT:-0}"
  if [ "$LEFT" -le 1 ] && [ "$XAFTER" -le "$XBEFORE" ]; then pass "22 after stop: no Reed chromium and no orphaned Xvfb"; else fail "22 leftovers after stop (chromium matches=$LEFT, Xvfb before=$XBEFORE after=$XAFTER)"; fi
else
  skip "20-22 Reed launcher or xvfb-run/xauth not available here"
fi

# ---- 23 egress country (opt-in) -----------------------------------------------------------------
echo "-- 23 egress country"
if [ "${SMOKE_NET:-0}" = "1" ]; then
  C="$(node -e "require('https').get('https://ipinfo.io/country',function(r){var s='';r.on('data',function(c){s+=c});r.on('end',function(){console.log(s.trim())})}).on('error',function(){console.log('error')})" 2>/dev/null)"
  if [ "$C" = "GB" ]; then pass "23 egress country is GB"; else warn "23 egress country is '$C' (Reed needs GB; raise before go-live)"; fi
else skip "23 set SMOKE_NET=1 to check the egress country (one request to ipinfo.io)"; fi

exit 0
