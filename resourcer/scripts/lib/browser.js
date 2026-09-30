'use strict';
/*
 * The ONLY place the pipeline spawns the agent-browser CLI (pinned 0.21.0).
 *
 * Replaces Invoke-AgentBrowserCmd and every legacy shell-wrapped call. Guarantees:
 *  1. ONE daemon/backend per session: the socket dir is forced on every spawn, so the kind of
 *     parent shell can never split the backend again (2026-08-02 login-shell incident).
 *  2. No shell, no quoting: argv is an array.
 *  3. Hard timeout that kills the CLI process group (never the daemon: the CLI setsid()s it).
 *  4. In-process FIFO (the daemon serialises anyway) and a cross-process 5 s gap before a
 *     navigation issued by a different process than the previous one (2026-07-10 double hit).
 *  5. The CLI re-sends a command after its own 30 s read timeout (up to 5 sends). For commands
 *     that change server state (unlock, form submit) callers pass singleAttempt:true and the
 *     wrapper kills the CLI before that timeout can fire, so a slow command is never re-sent.
 *  6. Browser profile, sockets and temp dirs live under paths.STATE, never the system tmp dir, except when
 *     Chromium's singleton-socket path would not fit (see lib/browser-env.js chooseTmpDir).
 * Nothing here runs at require time (no mkdir, no spawn).
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const paths = require('./paths');
const env = require('./env');
const fsx = require('./fsx');
const browserEnv = require('./browser-env');

const PINNED_VERSION = '0.21.0';
const IS_WIN = process.platform === 'win32';
const DEFAULT_SESSION = 'caterer';
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const MAX_ARG_CHARS = 120000;

const SITE = Object.freeze({
  BASE: 'https://recruiter.caterer.com',
  LOGIN_URL: 'https://recruiter.caterer.com/login',
  HOME_URL: 'https://recruiter.caterer.com/Home/1368655',
  HOME_ROOT: 'https://recruiter.caterer.com/Home',
  SEARCH_URL: 'https://recruiter.caterer.com/CandidateSearchWebMvc/CandidateSearch',
});
// One file for every reader and writer: env override, then constants.js (SESSION_PATH), then state/.
// The same chain phase1/session.js uses, so the login code, phase 1 and the cookie helpers never split.
function resolveSessionFile() {
  const override = env.get('CATERER_SESSION_FILE');
  if (override) return path.resolve(override);
  try {
    const c = require('../constants');
    if (c && c.SESSION_PATH) return c.SESSION_PATH;
  } catch { /* constants.js not present in this checkout */ }
  return path.join(paths.STATE, 'caterer-session.json');
}
const SESSION_FILE = resolveSessionFile();

// Default per-call budgets (ms), copied from the legacy call sites they replace.
const T = Object.freeze({
  getUrl: 20000, open: 90000, wait: 90000, eval: 60000, evalProbe: 30000,
  stateSave: 60000, stateLoad: 60000, close: 20000, version: 10000,
});

function posInt(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}
function nonNegInt(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

function cfg() {
  return {
    ipcReadMs: posInt(env.get('RESOURCER_AB_IPC_READ_MS'), 30000),
    navGapMs: nonNegInt(env.get('RESOURCER_AB_NAV_GAP_MS'), 5000),
    chromeArgs: browserEnv.chromeArgList().join(','),
    headed: env.get('RESOURCER_AB_HEADED') === '1',
  };
}

/** Longest a state-changing command may run before the CLI's own read timeout could make it re-send. */
function ipcSafeMs() { return Math.max(500, cfg().ipcReadMs - 3000); }

// tmpDir here is the preferred location only; ready() settles the real one with browserEnv.chooseTmpDir.
function dirs() {
  return {
    stateDir: paths.STATE,
    abDir: path.join(paths.STATE, 'ab'),
    tmpDir: path.join(paths.STATE, 't'),
  };
}

// ---------------------------------------------------------------- environment / setup

// The profile home comes from the install layout first: a HERMES_HOME that points at another profile must not hide ours.
function resolveBin() {
  const explicit = env.get('RESOURCER_AB_BIN');
  if (explicit) return { bin: explicit, source: 'env' };
  const homes = [path.resolve(paths.HOME, '..', '..')];
  if (process.env.HERMES_HOME && !homes.includes(path.resolve(process.env.HERMES_HOME))) homes.push(path.resolve(process.env.HERMES_HOME));
  const cands = homes.map((h) => path.join(h, 'bin', 'agent-browser')).concat([paths.p('bin', 'agent-browser')]);
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return { bin: c, source: 'file' }; } catch { /* next */ }
  }
  return { bin: 'agent-browser', source: 'path' };
}

function resolveChromiumInfo() { return browserEnv.resolveChromium(); }
function resolveChromium() { return browserEnv.resolveChromium().path; }

function semverParts(v) {
  const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function semverGte(a, b) {
  const x = semverParts(a), y = semverParts(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
  return true;
}

function canBindSocket(dir) {
  if (IS_WIN) return Promise.resolve(true);
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const p = path.join(dir, `.bt${process.pid}.sock`);
      try { fs.unlinkSync(p); } catch { /* none */ }
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(p, () => srv.close(() => resolve(true)));
    } catch { resolve(false); }
  });
}

// Deterministic across processes (no TMPDIR dependence): every process of one RESOURCER_HOME
// must pick the same directory, otherwise the backends split again.
async function chooseSockDir() {
  const { abDir } = dirs();
  if (IS_WIN) return abDir;
  const tooLong = abDir.length + 30 > 103;
  if (!tooLong && await canBindSocket(abDir)) return abDir;
  const h = crypto.createHash('sha256').update(paths.HOME).digest('hex').slice(0, 8);
  const fb = `/tmp/rab-${h}`;
  fs.mkdirSync(fb, { recursive: true, mode: 0o700 });
  return fb;
}

const isProfileDir = (n) => /^agent-browser-chrome-/.test(n);
// Chrome also leaves small org.chromium.* temp dirs behind when it dies; they go with the profiles.
const isBrowserTemp = (n) => isProfileDir(n) || /^\.?org\.chromium\./.test(n);

function probeSocket(sockPath, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; try { s.destroy(); } catch { /* ignore */ } resolve(v); } };
    const s = net.connect(sockPath);
    s.setTimeout(timeoutMs || 1000, () => fin(false));
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
  });
}

// Chrome profiles of a dead daemon are never reused; they pile up (~170 MB each). Only remove
// them when no daemon answers on any socket in our dir, no process names the dir, and they are old
// enough not to belong to a daemon that is starting right now.
async function sweepStaleProfiles(ctx) {
  let names;
  try { names = fs.readdirSync(ctx.tmpDir).filter(isBrowserTemp); } catch { return 0; }
  if (!names.length) return 0;
  if (!IS_WIN) {
    let socks = [];
    try { socks = fs.readdirSync(ctx.sockDir).filter((n) => n.endsWith('.sock')); } catch { /* none */ }
    for (const n of socks) if (await probeSocket(path.join(ctx.sockDir, n), 1000)) return 0;
  }
  // A live browser may sit on an old profile dir (its mtime only changes when entries are added), and a
  // daemon can be too busy to accept a connection in 1 s: never touch a dir that a running process names.
  const inUse = new Set(listProcs().map((p) => profileOf(p.cmd)).filter(Boolean));
  let removed = 0;
  for (const n of names) {
    const p = path.join(ctx.tmpDir, n);
    try {
      if (inUse.has(p)) continue;
      if (Date.now() - fs.statSync(p).mtimeMs < 15 * 60 * 1000) continue;
      fs.rmSync(p, { recursive: true, force: true });
      removed++;
    } catch { /* best effort */ }
  }
  return removed;
}

let readyPromise = null;
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const d = dirs();
      fsx.ensureDir(d.stateDir, 0o700);
      fsx.ensureDir(d.abDir, 0o700);
      const tmp = browserEnv.chooseTmpDir('ab');
      fsx.ensureDir(tmp.dir, 0o700);
      const sockDir = await chooseSockDir();
      const b = resolveBin();
      const ctx = { sockDir, abDir: d.abDir, tmpDir: tmp.dir, tmpInfo: tmp, bin: b.bin, binSource: b.source, idleZero: false };
      await sweepStaleProfiles(ctx);
      if (b.source === 'path') {
        const v = await verifyVersion(ctx);
        if (!v.ok) {
          process.stderr.write(`AB_VERSION_MISMATCH: found ${v.version || 'unknown'}, pinned ${PINNED_VERSION}\n`);
          try {
            require('./notify').notify({ severity: 'warn', key: 'ab-version', text: `agent-browser on PATH is ${v.version || 'unknown'}, the pipeline is pinned to ${PINNED_VERSION}. Install the pinned binary (see docs/INSTALL.md).` });
          } catch { /* alerts are best effort */ }
          if (semverGte(v.version, '0.33.1')) ctx.idleZero = true;
        }
      }
      return ctx;
    })();
    readyPromise.catch(() => { readyPromise = null; });
  }
  return readyPromise;
}

function buildEnv(ctx, extra) {
  const e = Object.assign({}, process.env, extra || {});
  for (const k of Object.keys(e)) if (k.startsWith('AGENT_BROWSER_')) delete e[k];
  const c = cfg();
  e.AGENT_BROWSER_SOCKET_DIR = ctx.sockDir;
  e.NO_COLOR = '1';
  e.TMPDIR = ctx.tmpDir;
  if (!e.HOME || !browserEnv.isWritableDir(e.HOME)) e.HOME = paths.STATE;
  Object.assign(e, browserEnv.localeEnv());
  const exe = resolveChromium();
  if (exe) e.AGENT_BROWSER_EXECUTABLE_PATH = exe;
  if (c.chromeArgs) e.AGENT_BROWSER_ARGS = c.chromeArgs;
  if (c.headed) {
    e.AGENT_BROWSER_HEADED = '1';
    const disp = env.get('RESOURCER_AB_DISPLAY') || process.env.DISPLAY;
    if (disp) e.DISPLAY = disp;
  } else {
    delete e.DISPLAY;
  }
  if (ctx.idleZero) e.AGENT_BROWSER_IDLE_TIMEOUT_MS = '0';
  return e;
}

// ---------------------------------------------------------------- process execution

function killTree(child) {
  if (!child || !child.pid) return;
  if (IS_WIN) {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

function makeResult(o) {
  return Object.assign({
    ok: false, code: null, out: '', timedOut: false, stdout: '', stderr: '',
    signal: null, elapsedMs: 0, label: '', clamped: false, retryRisk: false,
  }, o);
}

const stripAnsi = (b) => Buffer.concat(b).toString('utf8').replace(ANSI_RE, '');

function execCli(ctx, argv, o) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const outC = [], errC = [];
    let outBytes = 0, settled = false, overflow = false, exited = false, child, graceTimer = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      try { if (child && child.stdout) child.stdout.destroy(); } catch { /* ignore */ }
      try { if (child && child.stderr) child.stderr.destroy(); } catch { /* ignore */ }
      try { if (child) child.unref(); } catch { /* ignore */ }
      resolve(makeResult(Object.assign({ elapsedMs: Date.now() - t0, label: o.label, clamped: !!o.clamped }, r)));
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({
        out: `Error: TIMEOUT after ${Math.round(o.timeoutMs / 1000)}s (${o.label})`,
        stdout: stripAnsi(outC), stderr: stripAnsi(errC), timedOut: true, code: null,
      });
    }, o.timeoutMs);
    let cmd = ctx.bin, args = argv;
    if (/\.(c|m)?js$/i.test(ctx.bin)) { cmd = process.execPath; args = [ctx.bin].concat(argv); }
    try {
      child = spawn(cmd, args, {
        env: buildEnv(ctx, o.env), stdio: ['ignore', 'pipe', 'pipe'], detached: !IS_WIN, windowsHide: true,
      });
    } catch (e) { return finish({ out: `Error: spawn failed: ${e.message}` }); }
    child.on('error', (e) => finish({ out: `Error: spawn failed: ${e.message}` }));
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.stdout.on('data', (d) => {
      outBytes += d.length;
      if (outBytes > o.maxBuffer) { overflow = true; killTree(child); } else outC.push(d);
    });
    child.stderr.on('data', (d) => errC.push(d));
    const complete = (code, signal) => {
      const stdout = stripAnsi(outC), stderr = stripAnsi(errC);
      if (overflow) return finish({ out: `Error: output exceeded ${o.maxBuffer} bytes`, stdout: '', stderr, signal });
      finish({ ok: code === 0, code: code === null ? null : code, out: (stderr + stdout).trimEnd(), stdout, stderr, signal });
    };
    child.on('close', complete);
    // A grandchild can inherit our pipes and keep them open after the CLI exits; do not wait for it.
    child.on('exit', (code, signal) => {
      exited = true;
      if (settled) return;
      graceTimer = setTimeout(() => { if (exited) complete(code, signal); }, 1000);
    });
  });
}

// ---------------------------------------------------------------- queue, gap, public run()

let chain = Promise.resolve();
function enqueue(fn) {
  const p = chain.then(fn);
  chain = p.then(() => undefined, () => undefined);
  return p;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function navFile(ctx) { return path.join(ctx.abDir, 'nav.json'); }

async function navGap(ctx) {
  const gap = cfg().navGapMs;
  if (!gap) return;
  const rec = fsx.readJson(navFile(ctx), null);
  if (rec && rec.pid !== process.pid && Number.isFinite(rec.at)) {
    const wait = gap - (Date.now() - rec.at);
    if (wait > 0) await sleepMs(Math.min(wait, gap));
  }
}
function recordNav(ctx) {
  if (!cfg().navGapMs) return;
  try { fsx.writeJsonAtomic(navFile(ctx), { pid: process.pid, at: Date.now() }, 0o600); } catch { /* best effort */ }
}

function checkArgs(args) {
  if (!Array.isArray(args) || !args.length) return 'Error: args must be a non-empty array';
  for (const a of args) {
    if (typeof a !== 'string' || a.indexOf('\0') !== -1) return 'Error: args must be strings without NUL';
  }
  return null;
}

function defaultLabel(args) {
  if (args[0] === 'get' || args[0] === 'state') return `${args[0]} ${args[1] || ''}`.trim();
  return args[0];
}

/**
 * run(args, {session, timeoutMs, label, singleAttempt, maxBuffer, env})
 *   args = argv after `--session <name>`, e.g. ['open', url]. Never rejects.
 *   out = stderr then stdout (the legacy "$err$out" order); stdout/stderr are also returned.
 */
function run(args, opts) {
  const bad = checkArgs(args);
  if (bad) return Promise.resolve(makeResult({ out: bad }));
  const o = Object.assign({ session: DEFAULT_SESSION, timeoutMs: 120000, maxBuffer: 256 * 1024 * 1024, singleAttempt: false, env: null }, opts || {});
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(o.session)) return Promise.resolve(makeResult({ out: 'Error: bad session name' }));
  o.label = o.label || defaultLabel(args);
  if (!Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0) o.timeoutMs = 120000;
  o.timeoutMs = Math.min(o.timeoutMs, 2147483000);
  return enqueue(async () => {
    let ctx;
    try { ctx = await ready(); } catch (e) { return makeResult({ out: `Error: browser setup failed: ${e.message}`, label: o.label }); }
    const c = cfg();
    if (o.singleAttempt) {
      const safe = ipcSafeMs();
      if (o.timeoutMs > safe) { o.timeoutMs = safe; o.clamped = true; }
    }
    if (args[0] === 'open') await navGap(ctx);
    const r = await execCli(ctx, ['--session', o.session, ...args], o);
    if (args[0] === 'open' || args[0] === 'wait') recordNav(ctx);
    if (!o.singleAttempt && r.elapsedMs > c.ipcReadMs) r.retryRisk = true;
    return r;
  });
}

// ---------------------------------------------------------------- the six call forms

const ALLOWED_URL_RE = /^(https?:\/\/|about:blank$)/i;

function open(url, opts) {
  if (!ALLOWED_URL_RE.test(String(url || ''))) return Promise.resolve(makeResult({ out: 'Error: refusing to open a non-http(s) url', label: 'open' }));
  return run(['open', String(url)], Object.assign({ timeoutMs: T.open, label: 'open' }, opts));
}

function waitNetworkIdle(opts) {
  return run(['wait', '--load', 'networkidle'], Object.assign({ timeoutMs: T.wait, label: 'wait networkidle' }, opts));
}

function evalB64(b64, opts) {
  const s = String(b64 || '');
  if (!/^[A-Za-z0-9+/=]+$/.test(s)) return Promise.resolve(makeResult({ out: 'Error: eval payload is not base64', label: 'eval' }));
  if (s.length > MAX_ARG_CHARS) return Promise.resolve(makeResult({ out: 'Error: eval script too large for one argument', label: 'eval' }));
  return run(['eval', '-b', s], Object.assign({ timeoutMs: T.eval, label: 'eval' }, opts));
}

const evalJs = (js, opts) => evalB64(Buffer.from(String(js), 'utf8').toString('base64'), opts);

const lastLine = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';

async function getUrlResult(opts) {
  const r = await run(['get', 'url'], Object.assign({ timeoutMs: T.getUrl, label: 'get url' }, opts));
  const url = r.ok && !r.timedOut ? (lastLine(r.stdout) || lastLine(r.out)) : '';
  return { ok: r.ok && !r.timedOut, url, timedOut: r.timedOut, out: r.out };
}
async function getUrl(opts) { return (await getUrlResult(opts)).url; }

function looksLikeSession(file) {
  const j = fsx.readJson(file, null);
  return !!(j && Array.isArray(j.cookies));
}

// A process killed between "state save" and the rename leaves <file>.tmp-<pid> behind (it holds cookies).
function dropStaleTemps(target) {
  const dir = path.dirname(target), prefix = `${path.basename(target)}.tmp-`;
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!n.startsWith(prefix)) continue;
      const p = path.join(dir, n);
      try { if (Date.now() - fs.statSync(p).mtimeMs > 10 * 60 * 1000) fs.unlinkSync(p); } catch { /* raced */ }
    }
  } catch { /* directory unreadable: the save reports its own error */ }
}

// A browser with no page yet (about:blank) saves zero cookies; that must never replace a good file.
function wouldEmptyGoodFile(tmp, target) {
  const fresh = fsx.readJson(tmp, null);
  const old = fsx.readJson(target, null);
  return !!(fresh && old && Array.isArray(fresh.cookies) && Array.isArray(old.cookies) && fresh.cookies.length === 0 && old.cookies.length > 0);
}

// Written to a temp name, validated, chmod 600, then renamed: readers (cookie jar, HTTP checks)
// never see a torn file and the auth cookies are not world readable.
async function stateSave(file, opts) {
  const abs = path.resolve(String(file));
  fsx.ensureDir(path.dirname(abs));
  dropStaleTemps(abs);
  const tmp = `${abs}.tmp-${process.pid}`;
  const r = await run(['state', 'save', tmp], Object.assign({ timeoutMs: T.stateSave, label: 'state save' }, opts));
  if (r.ok && !r.timedOut && fs.existsSync(tmp) && looksLikeSession(tmp) && wouldEmptyGoodFile(tmp, abs)) {
    try { fs.unlinkSync(tmp); } catch { /* none */ }
    r.ok = false;
    r.out = 'Error: refusing to replace a session file that has cookies with an empty state (cold browser?)';
    return r;
  }
  if (r.ok && !r.timedOut && fs.existsSync(tmp) && looksLikeSession(tmp)) {
    try { fs.chmodSync(tmp, 0o600); } catch { /* not supported on this fs */ }
    fs.renameSync(tmp, abs);
    return r;
  }
  try { fs.unlinkSync(tmp); } catch { /* none */ }
  r.ok = false;
  if (!r.out) r.out = 'Error: state save produced no valid file';
  return r;
}

function stateLoad(file, opts) {
  const abs = path.resolve(String(file));
  if (!fs.existsSync(abs)) return Promise.resolve(makeResult({ out: `Error: state file not found: ${path.basename(abs)}`, label: 'state load' }));
  return run(['state', 'load', abs], Object.assign({ timeoutMs: T.stateLoad, label: 'state load' }, opts));
}

function close(opts) {
  return run(['close'], Object.assign({ timeoutMs: T.close, label: 'close' }, opts));
}

// ---------------------------------------------------------------- helpers built on the call forms

const isLoginUrl = (u) => /\/login/i.test(u || '');
const isSafeListBlocked = (u) => /SafeListLoginBlocked/i.test(u || '');
const isModuleErrorUrl = (u) => /aspxerrorpath|\/Error(?:\.aspx)?(?:[/?#]|$)/i.test(u || '');
const looksLikeError = (out) => /^(\u2717|Error|error|Timeout|timeout|Exception)/.test(String(out || '').trim());

/** Legacy Save-CatererSession: never overwrite the last good file with a logged-out state. */
async function saveSession(o) {
  const opts = o || {};
  const file = opts.file || SESSION_FILE;
  const u = await getUrlResult();
  if (isLoginUrl(u.url)) return { saved: false, skipped: 'login', url: u.url };
  if (isSafeListBlocked(u.url)) return { saved: false, skipped: 'safelist', url: u.url };
  const r = await stateSave(file);
  return { saved: r.ok, timedOut: r.timedOut, url: u.url, out: r.ok ? '' : r.out };
}

/** Cold daemon = fresh browser with no page (about:blank or empty). Unknown when get url failed. */
async function isCold() {
  const u = await getUrlResult({ timeoutMs: 60000 });
  if (!u.ok) return { cold: null, url: '' };
  return { cold: u.url === '' || u.url === 'about:blank', url: u.url };
}

function unwrapEval(output) {
  const s = String(output || '').trim();
  if (s[0] === '"') { try { return JSON.parse(s); } catch { /* fall through */ } }
  return s;
}

function parseEvalJson(output) {
  let raw = String(output || '').trim();
  const q = raw.indexOf('"'), b = raw.indexOf('{');
  if (q === -1 && b === -1) return { status: 0, error: 'empty browser output: ' + raw.slice(0, 120) };
  raw = (q !== -1 && (b === -1 || q < b)) ? raw.slice(q) : raw.slice(b);
  let inner;
  try { inner = JSON.parse(raw); } catch { return { status: 0, error: 'unparseable browser output: ' + raw.slice(0, 160) }; }
  if (typeof inner === 'string') {
    try { return JSON.parse(inner); } catch { return { status: 0, error: 'unparseable inner payload: ' + inner.slice(0, 160) }; }
  }
  return inner;
}

// ---------------------------------------------------------------- version, diagnostics, reset

async function verifyVersion(ctxIn) {
  const ctx = ctxIn || await ready();
  const r = await execCli(ctx, ['--version'], { timeoutMs: T.version, label: 'version', maxBuffer: 1024 * 1024, env: null });
  const m = String(r.out).match(/(\d+\.\d+\.\d+)/);
  const version = m ? m[1] : null;
  return { ok: r.ok && version === PINNED_VERSION, version, pinned: PINNED_VERSION, raw: r.out.slice(0, 120), bin: ctx.bin, source: ctx.binSource };
}

function listProcs() {
  if (process.platform !== 'linux') return [];
  const out = [];
  let names;
  try { names = fs.readdirSync('/proc'); } catch { return out; }
  for (const d of names) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const args = fs.readFileSync(`/proc/${d}/cmdline`).toString('utf8').split('\0').filter(Boolean);
      // Chrome rewrites its own cmdline into ONE space-joined element (seen with Chrome for Testing 145 on
      // Linux), so flags are matched against the joined string, never against argv elements.
      if (args.length) out.push({ pid: Number(d), args, cmd: args.join(' ') });
    } catch { /* process vanished */ }
  }
  return out;
}

const profileOf = (cmd) => {
  const m = String(cmd).match(/--user-data-dir=(\S+)/);
  return m ? m[1] : null;
};

/** Distinct agent-browser Chrome profile dirs in use: more than one = the split-backend signature. */
function countBackends() {
  const dirsSeen = new Set();
  for (const p of listProcs()) {
    const d = profileOf(p.cmd);
    if (d && /agent-browser-chrome-/.test(d)) dirsSeen.add(d);
  }
  return { count: dirsSeen.size, dirs: [...dirsSeen] };
}

async function status(session) {
  const ctx = await ready();
  const s = session || DEFAULT_SESSION;
  const alive = IS_WIN ? null : await probeSocket(path.join(ctx.sockDir, `${s}.sock`), 1000);
  let profiles = [];
  try { profiles = fs.readdirSync(ctx.tmpDir).filter(isProfileDir); } catch { /* none */ }
  const chrome = resolveChromiumInfo();
  return {
    sockDir: ctx.sockDir, tmpDir: ctx.tmpDir, daemonAlive: alive, profiles: profiles.length, backends: countBackends(), bin: ctx.bin, binSource: ctx.binSource,
    singleton: { pathLen: ctx.tmpInfo.pathLen, limit: ctx.tmpInfo.limit, margin: ctx.tmpInfo.margin, relocated: ctx.tmpInfo.relocated, reason: ctx.tmpInfo.reason },
    chromium: chrome.path, chromiumSource: chrome.source,
  };
}

/**
 * Stop the daemon and every Chrome that belongs to it, then clear its leftovers. Used when the
 * backend is known bad (cached DNS failures after an outage, split backends). It always costs a
 * fresh sign-in afterwards, so callers use it sparingly.
 */
async function reset(opts) {
  const o = opts || {};
  const session = o.session || DEFAULT_SESSION;
  const ctx = await ready();
  const report = { closed: false, killed: 0, removedProfiles: 0 };
  const c = await close({ session, timeoutMs: 15000 });
  report.closed = c.ok;
  if (process.platform === 'linux') {
    const pidFile = path.join(ctx.sockDir, `${session}.pid`);
    let pid = 0;
    try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch { /* no pid file */ }
    const tmpPrefix = `--user-data-dir=${ctx.tmpDir}${path.sep}`;
    for (const p of listProcs()) {
      const mine = p.cmd.includes(tmpPrefix) || (pid && p.pid === pid && /agent-browser/.test(p.args[0]));
      if (mine && p.pid !== process.pid) {
        try { process.kill(p.pid, 'SIGKILL'); report.killed++; } catch { /* gone */ }
      }
    }
  }
  for (const ext of ['sock', 'pid', 'version', 'config', 'stream']) {
    try { fs.unlinkSync(path.join(ctx.sockDir, `${session}.${ext}`)); } catch { /* none */ }
  }
  try {
    for (const n of fs.readdirSync(ctx.tmpDir).filter(isBrowserTemp)) {
      try { fs.rmSync(path.join(ctx.tmpDir, n), { recursive: true, force: true }); report.removedProfiles++; } catch { /* busy */ }
    }
  } catch { /* none */ }
  return report;
}

module.exports = {
  PINNED_VERSION, SITE, SESSION_FILE, T,
  run, open, waitNetworkIdle, evalB64, evalJs, getUrl, getUrlResult, stateSave, stateLoad, close,
  saveSession, isCold, verifyVersion, status, reset, countBackends,
  unwrapEval, parseEvalJson, looksLikeError, isLoginUrl, isSafeListBlocked, isModuleErrorUrl,
  resolveBin, resolveChromium, resolveChromiumInfo, dirs, cfg, ipcSafeMs,
  _internal: { buildEnv, ready, chooseSockDir, sweepStaleProfiles, semverGte, execCli },
};
