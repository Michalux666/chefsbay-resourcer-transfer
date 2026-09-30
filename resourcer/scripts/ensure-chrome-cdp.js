#!/usr/bin/env node
'use strict';

// Reed browser launcher: system chromium under xvfb-run with a persistent profile in state/,
// a CDP readiness probe, whole-tree shutdown, and the shared browser.lock protocol.
//
// CLI exit codes: 0 CDP ready (or stop done), 1 failed (legacy), 4 blocked by a live browser.lock holder.
// Stdout markers (legacy): CDP_READY CDP_KILLING CDP_LAUNCHING CDP_NO_CHROME CDP_LAUNCH_FAILED CDP_TIMEOUT
// New markers: CDP_LOCKED CDP_STOPPED CDP_NOT_RUNNING CDP_BUSY_SKIP

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const paths = require('./lib/paths');
const env = require('./lib/env');
const fsx = require('./lib/fsx');
const browserEnv = require('./lib/browser-env');

const DEFAULT_TARGET_URL = 'https://www.reed.co.uk/recruiter/v2/candidates/search/results';
const LOCK_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const CACHE_DIRS = [
  'Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 'GrShaderCache', 'ShaderCache',
  'component_crx_cache', 'Default/Service Worker/CacheStorage', 'Default/Service Worker/ScriptCache',
  'Default/History', 'Default/History-journal',
];

const sleep = fsx.sleep;
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(sleepBuf, 0, 0, ms); }

function config() {
  const num = (name, dflt) => {
    const n = Number(env.get(name, String(dflt)));
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  const chrome = browserEnv.resolveChromium({ reed: true });
  return {
    host: '127.0.0.1',
    port: num('REED_CDP_PORT', 9222),
    chrome: chrome.path,
    chromeSource: chrome.source,
    safetyArgs: browserEnv.reedSafetyArgs(),
    profile: env.get('REED_CHROME_PROFILE') || path.join(paths.STATE, 'chrome-reed'),
    targetUrl: env.get('REED_TARGET_URL') || DEFAULT_TARGET_URL,
    waitSec: num('REED_CDP_WAIT_S', 30),
    pollMs: num('REED_CDP_POLL_MS', 1000),
    closeWaitMs: num('REED_CDP_CLOSE_WAIT_MS', 10000),
    xvfbRun: env.get('REED_XVFB_RUN') || 'xvfb-run',
    log: path.join(paths.LOGS, 'reed-chrome.log'),
    pidFile: path.join(paths.STATE, 'reed-chrome.pid'),
    launchLock: path.join(paths.STATE, 'reed-chrome-launch.lock'),
  };
}

// ---------------------------------------------------------------- process table (/proc, no ps dependency)

function readProc(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'latin1');
    const close = stat.lastIndexOf(')');
    const rest = stat.slice(close + 2).split(' ');
    let args = [];
    try { args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { /* kernel thread or gone */ }
    // Chromium rewrites its process title, so /proc/<pid>/cmdline is ONE space-joined element there while ordinary processes have
    // NUL-separated arguments: everything below matches on the joined string, never on exact elements.
    return { pid, ppid: Number(rest[1]), state: rest[0], args, cmd: args.join(' ') };
  } catch {
    return null;
  }
}

function listProcs() {
  if (process.platform !== 'linux') return [];
  const out = [];
  let names = [];
  try { names = fs.readdirSync('/proc'); } catch { return out; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const p = readProc(Number(n));
    if (p && p.state !== 'Z') out.push(p);
  }
  return out;
}

function isAlive(pid) {
  if (!fsx.pidAlive(pid)) return false;
  if (process.platform === 'linux') {
    const p = readProc(pid);
    return !!p && p.state !== 'Z';
  }
  return true;
}

function ancestorPids() {
  const set = new Set([process.pid]);
  if (process.platform === 'linux') {
    let pid = process.ppid;
    for (let i = 0; i < 64 && pid > 1; i++) {
      set.add(pid);
      const p = readProc(pid);
      if (!p) break;
      pid = p.ppid;
    }
  } else if (process.ppid) {
    set.add(process.ppid);
  }
  const envPid = Number(process.env.RESOURCER_BROWSER_LOCK_HOLDER_PID);
  if (Number.isInteger(envPid) && envPid > 0) set.add(envPid);
  return set;
}

function descendantsOf(rootPids, procs) {
  const kids = new Map();
  for (const p of procs) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
  }
  const seen = new Set();
  const queue = [...rootPids];
  while (queue.length) {
    const pid = queue.shift();
    for (const k of kids.get(pid) || []) {
      if (!seen.has(k)) { seen.add(k); queue.push(k); }
    }
  }
  return seen;
}

// Always the space-joined command line: a process record may carry only argv (tests, other callers).
const cmdOf = (p) => (typeof p.cmd === 'string' ? p.cmd : (Array.isArray(p.args) ? p.args : []).join(' '));

const isXvfbRun = (p) => cmdOf(p).split(' ').some((t) => path.basename(t) === 'xvfb-run');
const isXvfbProc = (p) => path.basename(cmdOf(p).split(' ')[0]) === 'Xvfb';

// True when cmd carries flag as a whole argument (not as a prefix of a longer path).
function hasFlag(cmd, flag) {
  let i = cmd.indexOf(flag);
  while (i !== -1) {
    const end = i + flag.length;
    if ((i === 0 || cmd[i - 1] === ' ') && (end === cmd.length || cmd[end] === ' ')) return true;
    i = cmd.indexOf(flag, i + 1);
  }
  return false;
}

// ---------------------------------------------------------------- browser lock (shared with the Caterer side)

function lockFile() { return path.join(paths.RUNTIME, 'browser.lock'); }

function readLock() {
  const j = fsx.readJson(lockFile(), null);
  if (!j || typeof j !== 'object' || !Number.isInteger(j.pid)) return null;
  return j;
}

function lockState(opts = {}) {
  const maxAgeMs = opts.maxAgeMs || LOCK_MAX_AGE_MS;
  const holder = readLock();
  if (!holder) return { held: false, holder: null };
  const ageMs = Date.now() - Date.parse(holder.startedAt || '');
  const alive = isAlive(holder.pid);
  const expired = !(ageMs < maxAgeMs);
  const mine = holder.pid === process.pid;
  const ancestor = !mine && ancestorPids().has(holder.pid);
  return { held: alive && !expired, holder, alive, stale: !alive || expired, mine, ancestor, ageMs };
}

function releaseBrowserLock(rec) {
  const cur = readLock();
  if (cur && cur.pid === process.pid && (!rec || cur.startedAt === rec.startedAt)) fsx.safeUnlink(lockFile());
}

// Returns {acquired, borrowed, reentrant, holder, release}. borrowed = a live ancestor process owns it (hand-off), release is a no-op.
function acquireBrowserLock(owner, opts = {}) {
  fsx.ensureDir(paths.RUNTIME);
  const file = lockFile();
  const rec = { owner, pid: process.pid, startedAt: new Date().toISOString(), purpose: opts.purpose || null };
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o644);
      try { fs.writeSync(fd, JSON.stringify(rec, null, 2)); } finally { fs.closeSync(fd); }
      return { acquired: true, borrowed: false, reentrant: false, holder: rec, release: () => releaseBrowserLock(rec) };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const st = lockState(opts);
    if (st.holder && st.mine) return { acquired: true, borrowed: false, reentrant: true, holder: st.holder, release: () => {} };
    if (st.held && st.ancestor) return { acquired: true, borrowed: true, reentrant: false, holder: st.holder, release: () => {} };
    if (st.held) return { acquired: false, holder: st.holder, reason: 'busy' };
    if (!st.holder) {
      let young = false;
      try { young = Date.now() - fs.statSync(file).mtimeMs < 5000; } catch { young = false; }
      if (young) return { acquired: false, holder: null, reason: 'busy' };
      fsx.safeUnlink(file);
      continue;
    }
    const cur = readLock();
    if (cur && cur.pid === st.holder.pid && cur.startedAt === st.holder.startedAt) fsx.safeUnlink(file);
  }
  return { acquired: false, holder: readLock(), reason: 'contended' };
}

async function waitBrowserLock(owner, opts = {}) {
  const deadline = Date.now() + (opts.waitMs || 0);
  const pollMs = opts.pollMs || 2000;
  for (;;) {
    const r = acquireBrowserLock(owner, opts);
    if (r.acquired || Date.now() >= deadline) return r;
    await sleep(Math.min(pollMs, Math.max(50, deadline - Date.now())));
  }
}

// May the Reed side drive the browser right now? Only a live foreign non-Reed holder (a Caterer run) blocks it.
function reedMayUseBrowser() {
  const st = lockState();
  if (!st.held || st.mine || st.ancestor) return { ok: true, state: st };
  if (st.holder.owner === 'reed') return { ok: true, state: st };
  return { ok: false, state: st, holder: st.holder };
}

// ---------------------------------------------------------------- CDP http helpers

function cdpHttp(c, method, pathname, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.request({ host: c.host, port: c.port, path: pathname, method, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let body = null;
        try { body = data ? JSON.parse(data) : null; } catch { body = data; }
        finish({ status: res.statusCode, body });
      });
      res.on('error', () => finish(null));
    });
    req.on('error', () => finish(null));
    req.on('timeout', () => { req.destroy(); finish(null); });
    req.end();
  });
}

async function probe(c) {
  const r = await cdpHttp(c, 'GET', '/json/version');
  if (!r || r.status !== 200) return { ok: false };
  return { ok: true, version: r.body && typeof r.body === 'object' ? r.body : null };
}

async function listTargets(c) {
  const r = await cdpHttp(c, 'GET', '/json', 5000);
  return r && r.status === 200 && Array.isArray(r.body) ? r.body : null;
}

async function ensureReedTab(c, graceMs) {
  const deadline = Date.now() + graceMs;
  for (;;) {
    const t = await listTargets(c);
    if (t && t.some((x) => x.type === 'page' && String(x.url || '').includes('reed.co.uk'))) return true;
    if (Date.now() >= deadline) break;
    await sleep(500);
  }
  const r = await cdpHttp(c, 'PUT', `/json/new?${encodeURIComponent(c.targetUrl)}`, 5000);
  return !!r && r.status >= 200 && r.status < 300;
}

// ---------------------------------------------------------------- shutdown

// Real Chromium rewrites /proc/<pid>/cmdline into ONE space-joined element, so the flag is matched on the joined line, never on argv elements.
function profileProcs(c, procs) {
  const flag = `--user-data-dir=${c.profile}`;
  return procs.filter((p) => hasFlag(cmdOf(p), flag));
}

function readPidFile(c) {
  const j = fsx.readJson(c.pidFile, null);
  return j && Number.isInteger(j.pid) ? j : null;
}

// A CDP endpoint on our port is only adopted when a process of the Reed profile is running (or the pid file is live);
// otherwise it is another browser and driving it would be wrong. REED_CDP_TRUST_EXISTING=1 skips the check (tests, exotic setups).
function cdpIsOurs(c) {
  if (process.platform !== 'linux' || env.get('REED_CDP_TRUST_EXISTING', '0') === '1') return true;
  if (profileProcs(c, listProcs()).length) return true;
  const rec = readPidFile(c);
  return !!rec && isAlive(rec.pid);
}

function foreignResult(c) {
  return { ok: false, exit: 1, marker: 'CDP_LAUNCH_FAILED', message: `port ${c.port} is served by a browser that is not the Reed profile (${c.profile}); set REED_CDP_PORT to a free port or stop the other browser.` };
}

function trimCaches(c) {
  for (const d of CACHE_DIRS) {
    try { fs.rmSync(path.join(c.profile, d), { recursive: true, force: true }); } catch { /* best effort */ }
  }
  cleanTmpResidue();
}

// A killed Chromium leaves its socket directory and xvfb-run its auth directory behind; called only when no Reed browser process is left.
function cleanTmpResidue() {
  const dir = browserEnv.chooseTmpDir('reed').dir;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!/^\.?org\.chromium\.|^xvfb-run\./.test(n)) continue;
    try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function killPids(pids, sig) {
  for (const pid of pids) {
    try { process.kill(pid, sig); } catch { /* already gone */ }
  }
}

function waitGone(pids, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if (![...pids].some((p) => isAlive(p))) return true;
    if (Date.now() >= end) return false;
    sleepSync(100);
  }
}

// Stops the whole tree: chromium first (so the xvfb-run wrapper cleans its own Xvfb), then wrapper and Xvfb as fallbacks.
function stopChrome(opts = {}) {
  const c = config();
  const graceMs = opts.graceMs || 8000;
  const protectedPids = ancestorPids();
  const procs = listProcs();
  const wrappers = new Set();
  const rec = readPidFile(c);
  if (rec && isAlive(rec.pid)) {
    const p = readProc(rec.pid);
    if (p && isXvfbRun(p)) wrappers.add(rec.pid);
  }
  const ours = profileProcs(c, procs);
  for (const p of ours) if (isXvfbRun(p)) wrappers.add(p.pid);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  for (const p of ours) {
    if (isXvfbRun(p)) continue;
    let cur = byPid.get(p.ppid);
    for (let i = 0; cur && i < 8; i++) {
      if (isXvfbRun(cur)) { wrappers.add(cur.pid); break; }
      cur = byPid.get(cur.ppid);
    }
  }
  const roots = new Set([...wrappers, ...ours.filter((p) => !isXvfbRun(p)).map((p) => p.pid)]);
  for (const w of wrappers) roots.add(w);
  const tree = descendantsOf(roots, procs);
  for (const r of roots) tree.add(r);
  for (const pid of protectedPids) { tree.delete(pid); wrappers.delete(pid); }
  const xvfbPids = new Set([...tree].filter((pid) => byPid.get(pid) && isXvfbProc(byPid.get(pid))));
  const wrapperPids = [...wrappers];
  const chromePids = [...tree].filter((pid) => !xvfbPids.has(pid) && !wrappers.has(pid));
  const found = tree.size;
  if (!found) {
    fsx.safeUnlink(c.pidFile);
    return { stopped: false, found: 0, killed: 0 };
  }
  // Stage 1: ask the browser process ALONE to quit. Chromium then flushes cookies and session state and reaps its own children;
  // a simultaneous SIGTERM to the network-service helper loses the cookie database (login state) on the next start.
  const profileFlag = `--user-data-dir=${c.profile}`;
  const isChild = (p) => cmdOf(p).split(' ').some((t) => t.startsWith('--type='));
  const mainPids = chromePids.filter((pid) => { const p = byPid.get(pid); return !!p && hasFlag(cmdOf(p), profileFlag) && !isChild(p); });
  killPids(mainPids, 'SIGTERM');
  const watch = new Set([...chromePids, ...wrapperPids]);
  let clean = waitGone(watch, graceMs);
  let killed = mainPids.length;
  if (!clean) {
    const rest = chromePids.filter((p) => isAlive(p));
    killPids(rest, 'SIGTERM');
    killed += rest.length;
    clean = waitGone(watch, 3000);
  }
  if (!clean) {
    killPids(chromePids.filter((p) => isAlive(p)), 'SIGKILL');
    clean = waitGone(watch, 3000);
  }
  if (!clean) {
    killPids(wrapperPids.filter((p) => isAlive(p)), 'SIGTERM');
    waitGone(wrapperPids, 2000);
    killPids(wrapperPids.filter((p) => isAlive(p)), 'SIGKILL');
    waitGone(wrapperPids, 1500);
  }
  const strayX = [...xvfbPids].filter((p) => isAlive(p));
  if (strayX.length) {
    killPids(strayX, 'SIGTERM');
    if (!waitGone(strayX, 1500)) killPids(strayX.filter((p) => isAlive(p)), 'SIGKILL');
    killed += strayX.length;
  }
  for (const w of wrapperPids) {
    try { process.kill(-w, 'SIGKILL'); } catch { /* group already empty */ }
  }
  fsx.safeUnlink(c.pidFile);
  trimCaches(c);
  return { stopped: true, found, killed };
}

// Asks the live browser to quit through CDP (Browser.close). This is the ONLY shutdown that reliably flushes the cookie database:
// with plain SIGTERM the login is lost on the next start (verified against a real Chromium), so every Reed run would need a new login.
async function closeViaCdp(c) {
  const pr = await probe(c);
  if (!pr.ok || !pr.version || !pr.version.webSocketDebuggerUrl) return false;
  let WebSocket;
  try { WebSocket = require('ws'); } catch { return false; }
  return new Promise((resolve) => {
    let done = false;
    let ws = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch { /* already closed */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), 5000);
    try {
      ws = new WebSocket(pr.version.webSocketDebuggerUrl);
    } catch {
      finish(false);
      return;
    }
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
    ws.on('message', () => finish(true));
    ws.on('close', () => finish(true));
    ws.on('error', () => finish(false));
  });
}

// Graceful stop: Browser.close first (cookies and session state are flushed), then the forced tree shutdown for whatever is left.
async function stopChromeGraceful(opts = {}) {
  const c = config();
  const waitMs = opts.closeWaitMs || c.closeWaitMs;
  let viaCdp = false;
  const before = process.platform === 'linux' ? profileProcs(c, listProcs()).length : 0;
  if ((await probe(c)).ok) {
    viaCdp = await closeViaCdp(c);
    if (viaCdp) {
      const end = Date.now() + waitMs;
      const running = async () => (process.platform === 'linux' ? profileProcs(c, listProcs()).length > 0 : (await probe(c)).ok);
      while (Date.now() < end && (await running())) await sleep(150);
    }
  }
  const r = stopChrome(opts);
  if (viaCdp) {
    fsx.safeUnlink(c.pidFile);
    trimCaches(c);
  }
  return { ...r, found: Math.max(r.found, before), stopped: r.stopped || viaCdp, viaCdp };
}

// ---------------------------------------------------------------- launch

async function withLaunchMutex(c, opts, fn) {
  fsx.ensureDir(path.dirname(c.launchLock));
  const deadline = Date.now() + (c.waitSec + 20) * 1000;
  for (;;) {
    try {
      const fd = fs.openSync(c.launchLock, 'wx', 0o644);
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); } finally { fs.closeSync(fd); }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const j = fsx.readJson(c.launchLock, null);
    if (!j || !isAlive(j.pid) || Date.now() - (j.at || 0) > 120000) {
      let young = false;
      if (!j) { try { young = Date.now() - fs.statSync(c.launchLock).mtimeMs < 3000; } catch { young = false; } }
      if (!young) fsx.safeUnlink(c.launchLock);
      continue;
    }
    if (Date.now() > deadline) {
      return { ok: false, exit: 1, marker: 'CDP_TIMEOUT', message: 'another launcher held the launch lock too long.' };
    }
    await sleep(300);
    if (!opts.restart && (await probe(c)).ok) {
      return { ok: true, exit: 0, marker: 'CDP_READY', message: `Chromium became ready on ${c.port} while another launcher started it.` };
    }
  }
  try {
    return await fn();
  } finally {
    fsx.safeUnlink(c.launchLock);
  }
}

function rotateLog(c) {
  try {
    if (fs.statSync(c.log).size > LOG_ROTATE_BYTES) fs.renameSync(c.log, `${c.log}.1`);
  } catch { /* no log yet */ }
}

function chromeFlags(c) {
  return [
    `--remote-debugging-port=${c.port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${c.profile}`,
    '--no-first-run', '--no-default-browser-check', '--restore-last-session',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    ...c.safetyArgs, '--password-store=basic',
    '--disk-cache-size=104857600', '--window-size=1920,1080', c.targetUrl,
  ];
}

// xvfb-run and Chromium's singleton socket both live under TMPDIR, which Hermes may leave missing, unwritable or too long: use our own.
function launchEnv() {
  const tmp = browserEnv.chooseTmpDir('reed');
  const e = { ...process.env };
  delete e.DISPLAY;
  e.TMPDIR = tmp.dir;
  if (!e.HOME || !browserEnv.isWritableDir(e.HOME)) e.HOME = paths.STATE;
  Object.assign(e, browserEnv.localeEnv());
  return { env: e, tmp };
}

// Plain-words causes for container launch failures, matched against what this launch wrote to the log.
const FAILURE_HINTS = [
  [/xauth[^\n]*(not found|missing)|(not found|missing)[^\n]*xauth/i, 'xauth is not installed (xvfb-run needs it)'],
  [/mktemp: failed to create directory/i, 'xvfb-run cannot create its auth directory under TMPDIR'],
  [/cannot open display|xvfb failed to start|server is already active for display|unable to create .*x11-unix|_XSERVTrans/i, 'Xvfb could not start (display number or its X11 socket directory)'],
  [/no usable sandbox|failed to move to new namespace|running as root without --no-sandbox/i, 'the sandbox is unavailable: keep --no-sandbox in REED_CHROME_ARGS'],
  [/shared memory|\/dev\/shm/i, 'shared memory is too small: keep --disable-dev-shm-usage in REED_CHROME_ARGS'],
  [/singleton|profile appears to be in use/i, 'the profile is in use or the TMPDIR is too long for the singleton socket'],
];
function launchFailureHint(logFile, fromByte, exitedInfo) {
  let tail = '';
  try {
    const st = fs.statSync(logFile);
    const start = Math.max(fromByte, st.size - 8192);
    const fd = fs.openSync(logFile, 'r');
    try {
      const buf = Buffer.alloc(Math.max(0, st.size - start));
      fs.readSync(fd, buf, 0, buf.length, start);
      tail = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { /* no log */ }
  for (const [re, text] of FAILURE_HINTS) if (re.test(tail)) return text;
  if (exitedInfo && (exitedInfo.code === 133 || exitedInfo.signal === 'SIGTRAP')) return 'the browser aborted (SIGTRAP), typical for a TMPDIR that is too long for its singleton socket';
  return '';
}

async function launch(c, opts, emit) {
  if (process.platform !== 'linux') {
    return { ok: false, exit: 1, marker: 'CDP_LAUNCH_FAILED', message: 'the Reed browser launcher only runs on Linux.' };
  }
  if (!c.chrome || !fs.existsSync(c.chrome)) {
    return { ok: false, exit: 1, marker: 'CDP_NO_CHROME', message: `browser binary not found (${c.chrome || 'none of the default paths'}); set CHROMIUM_PATH.` };
  }
  fsx.ensureDir(c.profile, 0o700);
  fsx.ensureDir(path.dirname(c.log));
  if ((await probe(c)).ok && !cdpIsOurs(c)) return foreignResult(c);
  const procs = listProcs();
  const stale = profileProcs(c, procs).filter((p) => p.pid !== process.pid);
  if (stale.length || readPidFile(c)) {
    if (stale.length) emit('CDP_KILLING', `stopping ${stale.length} stale process(es) using ${c.profile}...`);
    stopChrome();
  }
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) fsx.safeUnlink(path.join(c.profile, f));
  rotateLog(c);
  emit('CDP_LAUNCHING', `starting Chromium (${c.chromeSource}) with remote-debugging-port=${c.port} on profile ${c.profile}...`);
  let outFd;
  let child;
  let exited = null;
  let spawnError = null;
  let logStart = 0;
  let childEnv = null;
  try {
    logStart = (() => { try { return fs.statSync(c.log).size; } catch { return 0; } })();
    outFd = fs.openSync(c.log, 'a', 0o600);
    childEnv = launchEnv().env;
    child = spawn(c.xvfbRun, ['-a', '-s', '-screen 0 1920x1080x24', c.chrome, ...chromeFlags(c)], {
      detached: true, stdio: ['ignore', outFd, outFd], env: childEnv,
    });
    child.on('error', (e) => { spawnError = e; });
    child.on('exit', (code, signal) => { exited = { code, signal }; });
    child.unref();
  } catch (e) {
    return { ok: false, exit: 1, marker: 'CDP_LAUNCH_FAILED', message: e.message };
  } finally {
    if (outFd !== undefined) { try { fs.closeSync(outFd); } catch { /* ignore */ } }
  }
  fsx.writeJsonAtomic(c.pidFile, { pid: child.pid, startedAt: new Date().toISOString(), port: c.port, profile: c.profile, chrome: c.chrome });
  const start = Date.now();
  const deadline = start + c.waitSec * 1000;
  for (;;) {
    await sleep(c.pollMs);
    if (spawnError) {
      fsx.safeUnlink(c.pidFile);
      return { ok: false, exit: 1, marker: 'CDP_LAUNCH_FAILED', message: `${c.xvfbRun}: ${spawnError.message}` };
    }
    const pr = await probe(c);
    if (pr.ok) {
      const secs = Math.max(1, Math.round((Date.now() - start) / 1000));
      const label = pr.version && pr.version.Browser ? ` (${String(pr.version.Browser).slice(0, 60)})` : '';
      return { ok: true, exit: 0, marker: 'CDP_READY', message: `Chromium CDP reachable after ${secs}s.${label}`, launched: true };
    }
    if (exited) {
      fsx.safeUnlink(c.pidFile);
      const hint = launchFailureHint(c.log, logStart, exited);
      return { ok: false, exit: 1, marker: 'CDP_LAUNCH_FAILED', message: `browser exited during startup (code ${exited.code}, signal ${exited.signal})${hint ? `: ${hint}` : ''}; see ${c.log}.` };
    }
    if (Date.now() >= deadline) break;
  }
  stopChrome();
  const hint = launchFailureHint(c.log, logStart, null);
  return { ok: false, exit: 1, marker: 'CDP_TIMEOUT', message: `Chromium launched but CDP still not responding after ${c.waitSec}s${hint ? ` (${hint})` : ''}. See ${c.log}.` };
}

// opts: {restart, ensureReedTab, onMessage(marker, text)} -> {ok, exit, marker, message, launched?}
async function ensureChrome(opts = {}) {
  const c = config();
  const emit = opts.onMessage || (() => {});
  const gate = reedMayUseBrowser();
  if (!gate.ok) {
    const h = gate.holder;
    return { ok: false, exit: 4, marker: 'CDP_LOCKED', message: `browser.lock is held by ${h.owner} (pid ${h.pid}); the Reed browser never runs while a ${h.owner} browser run is active.` };
  }
  const reuse = async () => {
    if (!cdpIsOurs(c)) return foreignResult(c);
    if (opts.ensureReedTab) await ensureReedTab(c, 1500);
    return { ok: true, exit: 0, marker: 'CDP_READY', message: `Chromium already listening on ${c.port}.` };
  };
  if (!opts.restart && (await probe(c)).ok) return reuse();
  return withLaunchMutex(c, opts, async () => {
    if (!opts.restart && (await probe(c)).ok) return reuse();
    if (opts.restart) await stopChromeGraceful();
    const r = await launch(c, opts, emit);
    if (r.ok && opts.ensureReedTab) await ensureReedTab(c, 8000);
    return r;
  });
}

// ---------------------------------------------------------------- CLI

const USAGE = `Usage: node scripts/ensure-chrome-cdp.js [options]
  (no options)       make sure Chromium serves CDP on 127.0.0.1:<REED_CDP_PORT> (default 9222); reuse a live one
  --ensure-reed-tab  also make sure a reed.co.uk tab exists (opens one in the live browser, never restarts it)
  --restart          quit the Reed browser (through CDP, so the login is saved), then launch a fresh one
  --stop             quit the Reed browser through CDP (Browser.close: cookies and session are flushed), then force-stop whatever is left;
                     stops the whole Reed browser tree (exit 4 if a live foreign browser.lock holder exists, unless --force)
  --stop-if-idle     stop the tree only when no live browser.lock holder exists (safe for a supervisor tick)
  --status           print JSON status; exit 0 when CDP answers, 1 otherwise
  --wait <seconds>   readiness wait (default 30, env REED_CDP_WAIT_S)
  --force            with --stop: ignore the lock
Environment: CHROMIUM_PATH REED_CDP_PORT REED_CHROME_PROFILE REED_TARGET_URL REED_CDP_WAIT_S REED_XVFB_RUN REED_CHROME_ARGS
  RESOURCER_BROWSER_TZ RESOURCER_BROWSER_LANG
Exit codes: 0 ok, 1 failed, 4 browser.lock held by a live non-Reed run.`;

async function cli(argv) {
  const has = (f) => argv.includes(f);
  if (has('--help') || has('-h')) { process.stdout.write(`${USAGE}\n`); return 0; }
  const wi = argv.indexOf('--wait');
  if (wi >= 0 && argv[wi + 1]) process.env.REED_CDP_WAIT_S = argv[wi + 1];
  const say = (marker, text) => process.stdout.write(`${marker}: ${text}\n`);
  const c = config();
  if (has('--status')) {
    const pr = await probe(c);
    const st = lockState();
    process.stdout.write(`${JSON.stringify({ cdp: pr.ok, port: c.port, browser: pr.version ? pr.version.Browser : null, profile: c.profile, pidFile: readPidFile(c), lock: st.holder ? { ...st.holder, held: st.held } : null, chrome: c.chrome, chromeSource: c.chromeSource, singleton: browserEnv.singletonBudget(browserEnv.chooseTmpDir('reed').dir) })}\n`);
    return pr.ok ? 0 : 1;
  }
  if (has('--stop') || has('--stop-if-idle')) {
    const st = lockState();
    if (has('--stop-if-idle') && st.held && !st.mine && !st.ancestor) {
      say('CDP_BUSY_SKIP', `browser.lock held by ${st.holder.owner} (pid ${st.holder.pid}); leaving the browser alone.`);
      return 0;
    }
    if (has('--stop') && !has('--force') && st.held && !st.mine && !st.ancestor) {
      say('CDP_LOCKED', `browser.lock held by ${st.holder.owner} (pid ${st.holder.pid}); use --force to stop anyway.`);
      return 4;
    }
    const r = await stopChromeGraceful();
    if (r.stopped) say('CDP_STOPPED', `stopped ${r.found} process(es).${r.viaCdp ? ' (quit through CDP)' : ''}`);
    else say('CDP_NOT_RUNNING', 'no Reed browser processes found.');
    return 0;
  }
  const r = await ensureChrome({ restart: has('--restart'), ensureReedTab: has('--ensure-reed-tab'), onMessage: say });
  say(r.marker, r.message);
  return r.exit;
}

if (require.main === module) {
  cli(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
    process.stdout.write(`CDP_LAUNCH_FAILED: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  hasFlag, cmdOf, profileProcs, config, probe, listTargets, cdpHttp, ensureReedTab, ensureChrome, stopChrome, stopChromeGraceful, listProcs, isAlive, ancestorPids,
  browserLock: {
    file: lockFile, read: readLock, state: lockState, acquire: acquireBrowserLock, wait: waitBrowserLock,
    release: releaseBrowserLock, reedMayUse: reedMayUseBrowser,
  },
};
