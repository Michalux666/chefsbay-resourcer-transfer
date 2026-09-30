'use strict';
// Shared helpers for the supervision tests: temp homes, fixture installation, process helpers.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SRC_SCRIPTS = path.join(REPO, 'resourcer', 'scripts');
const IS_LINUX = process.platform === 'linux';
const IS_WIN = process.platform === 'win32';

// Zero network: anything but loopback throws (the port must never call out in tests).
function installNetworkGuard() {
  const isLoopback = (h) => !h || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  const realFetch = globalThis.fetch;
  if (realFetch) {
    globalThis.fetch = function guardedFetch(input, init) {
      const url = new URL(typeof input === 'string' ? input : (input.url || String(input)));
      if (!isLoopback(url.hostname)) throw new Error(`network guard: blocked fetch to ${url.hostname}`);
      return realFetch(input, init);
    };
  }
  const realRequest = http.request;
  http.request = function guardedRequest(...args) {
    const a = args[0];
    const host = typeof a === 'string' ? new URL(a).hostname : (a && (a.hostname || a.host)) || (args[1] && args[1].hostname);
    if (!isLoopback(host && String(host).split(':')[0])) throw new Error(`network guard: blocked request to ${host}`);
    return realRequest.apply(http, args);
  };
}

function tmpRoot() {
  return process.env.SUP_TEST_TMP || os.tmpdir();
}

function mkHome(t, name, opts) {
  const dir = fs.mkdtempSync(path.join(tmpRoot(), `sup-${name || 'home'}-`));
  for (const d of ['runs', 'logs', 'runtime', 'pending-searches', 'outbox', 'scripts', 'scripts/lib', 'state', 'backups', 'downloads', 'ctl', 'markers']) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  }
  if (t && t.after) {
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ } });
  }
  if (opts && opts.db) seedDb(dir);
  return dir;
}

// The tick fails closed on candidates.db (missing, empty, corrupt or driver-less holds every run), so a home that launches
// real runs (mkHome opts.db) gets one row and a node_modules link that lets the copied scripts load the same driver.
// Where no driver exists at all (a bare Windows checkout) nothing is created and the tests that need it are skipped.
function findDriver() {
  for (const spec of ['better-sqlite3', path.join(REPO, 'resourcer', 'node_modules', 'better-sqlite3')]) {
    try {
      const Database = require(spec);
      const file = require.resolve(spec);
      const marker = `${path.sep}node_modules${path.sep}`;
      const i = file.lastIndexOf(marker);
      if (i >= 0) return { Database, nodeModules: file.slice(0, i + marker.length - 1) };
    } catch { /* try the next place */ }
  }
  return null;
}

function seedDb(dir) {
  const driver = findDriver();
  if (!driver) return;
  const db = new driver.Database(path.join(dir, 'candidates.db'));
  db.exec('CREATE TABLE candidates (id INTEGER PRIMARY KEY, caterer_id INTEGER UNIQUE); INSERT INTO candidates (caterer_id) VALUES (1);');
  db.close();
  try { fs.symlinkSync(driver.nodeModules, path.join(dir, 'node_modules'), 'junction'); } catch { /* the scripts then run without a driver */ }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

const COPY_REAL = [
  'pending-gate.js', 'run-lock.js', 'constants.js', 'create-init-status.js', 'build-caterer-results-url.js',
  'cull-ghost-phase1.js', 'recover-stranded-phase1.js', 'preflight-db.js',
  'pipeline-watchdog.js', 'watchdog-runner.js', 'maintenance.js', 'backup-db.js', 'alerts-deliver.js',
  'lib/paths.js', 'lib/env.js', 'lib/fsx.js', 'lib/notify.js', 'lib/time.js', 'lib/tick.js', 'lib/pipeline-halt.js', 'lib/browser-env.js',
  'ensure-chrome-cdp.js',
];

const FAKE = {
  'phase1.js': `'use strict';
const fs = require('fs');
const path = require('path');
const HOME = process.env.RESOURCER_HOME;
const ctl = (() => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'ctl', 'phase1.json'), 'utf8')); } catch { return {}; } })();
const pi = process.argv.indexOf('--params-file');
const params = JSON.parse(fs.readFileSync(process.argv[pi + 1], 'utf8'));
const marker = path.join(HOME, 'markers', 'phase1-' + Date.now() + '-' + process.pid + '.json');
const lockNow = () => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime', 'browser.lock'), 'utf8')); } catch { return null; } };
const env0 = { holderPid: process.env.RESOURCER_BROWSER_LOCK_HOLDER_PID || null, browserLock: lockNow() };
const status = params.INIT_STATUS_FILE;
const upd = (patch) => { if (!status) return; let d = {}; try { d = JSON.parse(fs.readFileSync(status, 'utf8')); } catch {} fs.writeFileSync(status, JSON.stringify(Object.assign(d, patch, { updatedAt: new Date().toISOString() }))); };
fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, start: Date.now(), job: params.JOB_TITLE, location: params.LOCATION, sources: params.SOURCES, ...env0 }));
console.log('PARAMS_FILE_LOADED: ' + process.argv[pi + 1]);
console.log('FAKE_PHASE1_START job=' + params.JOB_TITLE);
upd({ status: 'phase1_running' });
if (ctl.grandchild) {
  const { spawn } = require('child_process');
  const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: !!ctl.grandchildDetached });
  fs.writeFileSync(path.join(HOME, 'markers', 'grandchild.pid'), String(gc.pid));
  if (ctl.grandchildDetached) gc.unref();
}
setTimeout(() => {
  const poison = Array.isArray(ctl.failLocations) && ctl.failLocations.includes(params.LOCATION);
  const code = poison ? (ctl.failExit || 5) : (ctl.exit === undefined ? 0 : ctl.exit);
  const final = Object.assign({ status: 'complete', pool: 10, approved: 3, skippedDb: 5, errors: 0, phase2Status: 'done' }, ctl.final || {});
  if (!poison && (ctl.exit === 0 || ctl.exit === undefined)) upd(final);
  if (!poison && code === 0 && ctl.consumePending) {
    const dir = path.join(HOME, 'pending-searches');
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (d.location === params.LOCATION) fs.unlinkSync(path.join(dir, f));
      }
    } catch {}
  }
  fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, start: JSON.parse(fs.readFileSync(marker, 'utf8')).start, end: Date.now(), job: params.JOB_TITLE, location: params.LOCATION, sources: params.SOURCES, ...env0 }));
  process.exit(code);
}, ctl.sleepMs === undefined ? 300 : ctl.sleepMs);
`,
  'caterer-login.js': `'use strict';
const fs = require('fs');
const path = require('path');
exports.ensureLoggedIn = async () => {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(path.join(process.env.RESOURCER_HOME, 'ctl', 'session.json'), 'utf8')); } catch {}
  return c.state || 'ok';
};
`,
  'caterer-preflight.js': `'use strict';
const fs = require('fs');
const path = require('path');
let c = {};
try { c = JSON.parse(fs.readFileSync(path.join(process.env.RESOURCER_HOME, 'ctl', 'preflight.json'), 'utf8')); } catch {}
fs.appendFileSync(path.join(process.env.RESOURCER_HOME, 'markers', 'preflight.calls'), process.argv.slice(2).join(' ') + '\\n');
if (c.exit) { console.error('CATERER_SAFELIST_BLOCKED simulated'); process.exit(c.exit); }
`,
  'queue-due-territories.js': `'use strict';
const fs = require('fs');
const path = require('path');
let c = {};
try { c = JSON.parse(fs.readFileSync(path.join(process.env.RESOURCER_HOME, 'ctl', 'queue-due.json'), 'utf8')); } catch {}
fs.appendFileSync(path.join(process.env.RESOURCER_HOME, 'markers', 'queue-due.calls'), Date.now() + '\\n');
if (c.fail) { console.error('boom'); process.exit(1); }
console.log(JSON.stringify(c.summary || { status: 'nothing_to_queue', due: 0, queued: 0 }));
`,
  'lib/screening-health.js': `'use strict';
const fs = require('fs');
const path = require('path');
exports.check = async ({ deep } = {}) => {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(path.join(process.env.RESOURCER_HOME, 'ctl', 'screening.json'), 'utf8')); } catch {}
  if (c.ok === false) return { ok: false, reason: c.reason || 'screening gateway unreachable', ms: 1 };
  if (deep && c.deepOk === false) return { ok: false, reason: c.reason || 'screening gateway error', ms: 1 };
  return { ok: true, reason: null, ms: 1 };
};
`,
};

function installScripts(home) {
  for (const rel of COPY_REAL) {
    const from = path.join(SRC_SCRIPTS, rel);
    if (!fs.existsSync(from)) throw new Error(`test dependency missing in the repo: ${rel}`);
    fs.copyFileSync(from, path.join(home, 'scripts', rel));
  }
  for (const [rel, body] of Object.entries(FAKE)) {
    fs.writeFileSync(path.join(home, 'scripts', rel), body);
  }
  return home;
}

function setCtl(home, name, obj) {
  writeJson(path.join(home, 'ctl', `${name}.json`), obj);
}

function pendingFile(home, name, extra) {
  const data = Object.assign({
    jobTitle: 'Chef', location: 'AB1', distance: 20, keywords: '', priority: 'low', sources: 'caterer', cvLimit: 20,
    requestedAt: new Date().toISOString(), source: 'territory-scheduler',
  }, extra);
  writeJson(path.join(home, 'pending-searches', name), data);
  return data;
}

// A pid that is certainly dead: start a short process and wait for it to exit.
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', '0']);
  return r.pid;
}

// A live helper process that sleeps; returns {child, pid, kill()}.
function sleeper(t, opts) {
  const o = Object.assign({ detached: false }, opts);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: o.detached, windowsHide: true });
  if (o.detached) child.unref();
  const kill = () => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } };
  if (t && t.after) t.after(kill);
  return { child, pid: child.pid, kill };
}

function waitFor(pred, ms, stepMs) {
  const until = Date.now() + (ms || 10000);
  return (async () => {
    while (Date.now() < until) {
      const v = pred();
      if (v) return v;
      await new Promise((r) => setTimeout(r, stepMs || 50));
    }
    return pred();
  })();
}

function pidExists(pid) {
  try { process.kill(pid, 0); } catch (e) { return e.code === 'EPERM'; }
  if (IS_LINUX) {
    try {
      const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = st.slice(st.lastIndexOf(')') + 2, st.lastIndexOf(')') + 3);
      if (state === 'Z') return false;
    } catch { return false; }
  }
  return true;
}

// London wall-clock -> epoch ms (inverse of Intl), good enough for tests: search the UTC offset.
function londonEpoch(y, mo, d, h, mi) {
  for (const offsetH of [0, 1]) {
    const ms = Date.UTC(y, mo - 1, d, h - offsetH, mi || 0);
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
    const o = {};
    for (const p of parts) o[p.type] = p.value;
    if (+o.hour === h && +o.minute === (mi || 0) && +o.day === d) return ms;
  }
  throw new Error('no such London time');
}

function collectNotifier() {
  const list = [];
  const fn = (a) => { list.push(a); return true; };
  fn.list = list;
  fn.keys = () => list.map((x) => x.key);
  return fn;
}

module.exports = {
  REPO, SRC_SCRIPTS, IS_LINUX, IS_WIN, installNetworkGuard, mkHome, seedDb, writeJson, readJson, readLines,
  installScripts, setCtl, pendingFile, deadPid, sleeper, waitFor, pidExists, londonEpoch, collectNotifier, tmpRoot,
};
