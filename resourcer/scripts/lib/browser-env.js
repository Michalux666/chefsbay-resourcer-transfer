'use strict';
// Environment decisions shared by lib/browser.js (Caterer) and ensure-chrome-cdp.js (Reed) so the two launchers cannot drift.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const paths = require('./paths');
const env = require('./env');

const IS_WIN = process.platform === 'win32';
// AF_UNIX sun_path holds 107 characters on Linux.
const SUN_PATH_MAX = 107;
// Chromium binds $TMPDIR/.org.chromium.Chromium.XXXXXX/SingletonSocket (46 after TMPDIR, 45 without the dot) and aborts with SIGTRAP past 107.
const SINGLETON_SUFFIX = 46;
const HERMES_EXE_FILE = '/etc/hermes/agent-browser-executable-path';
const LEAF = Object.freeze({ ab: 't', reed: 'rt' });
const DEFAULT_CHROME_ARGS = '--no-sandbox,--disable-dev-shm-usage,--lang=en-GB';

const byteLen = (s) => Buffer.byteLength(String(s), 'utf8');

function singletonBudget(tmpDir) {
  const pathLen = byteLen(tmpDir) + SINGLETON_SUFFIX;
  return { tmpDir, pathLen, limit: SUN_PATH_MAX, margin: SUN_PATH_MAX - pathLen };
}

function isWritableDir(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch { return false; }
}

function ensureWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return isWritableDir(dir);
  } catch { return false; }
}

// One directory per browser (the Caterer profile sweep must never see the Reed socket dir); /tmp/rab-<hash>/<leaf> when state/<leaf> does not fit.
function chooseTmpDir(kind, opts) {
  const o = opts || {};
  const leaf = LEAF[kind];
  if (!leaf) throw new Error(`unknown tmp dir kind: ${kind}`);
  const home = o.home || paths.HOME;
  const preferred = path.join(o.stateDir || path.join(home, 'state'), leaf);
  const win = o.platform ? o.platform === 'win32' : IS_WIN;
  const fits = singletonBudget(preferred).margin >= 0;
  if (win) return Object.assign({ dir: preferred, relocated: false, reason: null }, singletonBudget(preferred));
  let reason = null;
  if (!fits) reason = 'path-too-long';
  else if (!ensureWritableDir(preferred)) reason = 'not-writable';
  if (!reason) return Object.assign({ dir: preferred, relocated: false, reason: null }, singletonBudget(preferred));
  const h = crypto.createHash('sha256').update(home).digest('hex').slice(0, 8);
  const fb = path.join(o.tmpRoot || '/tmp', `rab-${h}`, leaf);
  ensureWritableDir(fb);
  return Object.assign({ dir: fb, relocated: true, reason }, singletonBudget(fb));
}

function firstLine(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/)[0].trim(); } catch { return ''; }
}
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// CHROMIUM_PATH, then the Debian binaries, then the path the Hermes image records; opts.reed also accepts the Google Chrome names.
function resolveChromium(opts) {
  const o = opts || {};
  const explicit = o.explicit !== undefined ? o.explicit : env.get('CHROMIUM_PATH');
  if (explicit) return { path: explicit, source: 'CHROMIUM_PATH' };
  for (const c of ['/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (isFile(c)) return { path: c, source: 'debian' };
  }
  const rec = firstLine(o.hermesFile || HERMES_EXE_FILE);
  if (rec && isFile(rec)) return { path: rec, source: 'hermes-image' };
  if (o.reed) {
    for (const c of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) {
      if (isFile(c)) return { path: c, source: 'google-chrome' };
    }
  }
  return { path: null, source: 'none' };
}

// RESOURCER_AB_CHROME_ARGS (comma separated) replaces the whole default list.
function chromeArgList(raw) {
  const v = raw !== undefined ? raw : env.get('RESOURCER_AB_CHROME_ARGS', DEFAULT_CHROME_ARGS);
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

// The container-dependent flags of the headed Reed browser; REED_CHROME_ARGS replaces the whole list.
function reedSafetyArgs(raw) {
  const v = raw !== undefined ? raw : env.get('REED_CHROME_ARGS', DEFAULT_CHROME_ARGS);
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

// A UK address with a UTC/en-US browser is an avoidable bot signal; 'off' disables either setting.
function localeEnv() {
  const out = {};
  const tz = env.get('RESOURCER_BROWSER_TZ', 'Europe/London');
  const lang = env.get('RESOURCER_BROWSER_LANG', 'en-GB');
  if (tz && tz !== 'off') out.TZ = tz;
  if (lang && lang !== 'off') {
    const posix = String(lang).replace('-', '_');
    out.LANGUAGE = `${posix}:${posix.split('_')[0]}`;
  }
  return out;
}

// Chromium and xvfb-run write under HOME: keep the inherited one only when it is a writable directory.
function usableHome(fallback) {
  const h = process.env.HOME;
  return h && isWritableDir(h) ? h : fallback;
}

// ---------------------------------------------------------------- self-check

function onPath(name) {
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (d && isFile(path.join(d, name))) return path.join(d, name);
  }
  return null;
}

function runProbe(cmd, args, o) {
  return new Promise((resolve) => {
    execFile(cmd, args, Object.assign({ encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, o), (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code === undefined ? null : err.code) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// Chromium writes DevToolsActivePort once its singleton socket and DevTools server are up; a too-long TMPDIR aborts it silently.
function launchProbe(chromePath, tmpDir) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const prof = path.join(tmpDir, `probe-profile-${process.pid}`);
    const e = Object.assign({}, process.env, { TMPDIR: tmpDir, HOME: usableHome(paths.STATE) }, localeEnv());
    delete e.DISPLAY;
    const args = ['--headless=new', ...chromeArgList(), '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${prof}`, 'about:blank'];
    let child, done = false, exited = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearInterval(poll); clearTimeout(limit);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      setTimeout(() => { try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* best effort */ } resolve(v); }, 300);
    };
    const poll = setInterval(() => {
      if (fs.existsSync(path.join(prof, 'DevToolsActivePort'))) finish({ ok: true });
      else if (exited) finish({ ok: false, why: `exited during startup (${exited.signal || 'code ' + exited.code})${exited.signal === 'SIGTRAP' ? ', typical for a TMPDIR that is too long' : ''}` });
    }, 250);
    const limit = setTimeout(() => finish({ ok: false, why: 'no DevTools port after 30 seconds' }), 30000);
    try {
      child = spawn(chromePath, args, { env: e, stdio: 'ignore', detached: true });
    } catch (err) { clearInterval(poll); clearTimeout(limit); return resolve({ ok: false, why: err.message }); }
    child.on('error', (err) => finish({ ok: false, why: err.message }));
    child.on('exit', (code, signal) => { exited = { code, signal }; });
  });
}

// Read-only checks as [{id, level: pass|warn|fail|info, text}]; opts.launch also starts Chromium headless with the production TMPDIR and flags.
async function diagnose(opts) {
  const o = opts || {};
  const res = [];
  const add = (id, level, text) => res.push({ id, level, text });
  if (IS_WIN) {
    add('platform', 'info', 'Windows host: the Linux-only checks are skipped');
    return res;
  }
  const state = paths.STATE;
  if (ensureWritableDir(state)) add('state', 'pass', 'state directory is writable');
  else add('state', 'fail', `state directory ${state} is not writable`);
  const home = process.env.HOME;
  if (home && isWritableDir(home)) add('home', 'pass', 'HOME exists and is writable');
  else add('home', 'warn', 'HOME is missing or not writable; browser children get the state directory as HOME instead');
  const tmp = process.env.TMPDIR;
  if (tmp) {
    if (isWritableDir(tmp)) add('tmpdir', 'pass', 'inherited TMPDIR exists and is writable');
    else add('tmpdir', 'warn', 'inherited TMPDIR is missing or not writable; xvfb-run would fail with it, the launchers use their own directory instead');
  }
  for (const kind of ['ab', 'reed']) {
    const t = chooseTmpDir(kind);
    const label = kind === 'ab' ? 'Caterer' : 'Reed';
    if (t.margin < 0) add(`singleton-${kind}`, 'fail', `${label} Chromium singleton socket path would be ${t.pathLen} characters (limit ${t.limit}) even in ${t.dir}`);
    else if (t.relocated) add(`singleton-${kind}`, 'warn', `${label} browser TMPDIR moved to ${t.dir} (${t.reason}); singleton socket path ${t.pathLen} of ${t.limit}`);
    else add(`singleton-${kind}`, 'pass', `${label} Chromium singleton socket path ${t.pathLen} of ${t.limit} characters (${t.margin} spare)`);
  }
  if (tmp) {
    const inh = singletonBudget(tmp);
    add('singleton-inherited', inh.margin < 0 ? 'info' : 'pass', `the inherited TMPDIR would give a ${inh.pathLen} character singleton socket path (${inh.margin < 0 ? 'too long, so it is never used for Chromium' : 'fits'})`);
  }
  const chrome = resolveChromium({ reed: true });
  if (!chrome.path) {
    add('chromium', 'fail', 'no Chromium found: set CHROMIUM_PATH in the profile .env');
  } else if (!isFile(chrome.path)) {
    add('chromium', 'fail', `CHROMIUM_PATH points at a missing file (${chrome.path})`);
  } else {
    const v = await runProbe(chrome.path, ['--version'], { timeout: 20000 });
    const ver = (v.stdout || v.stderr).split('\n')[0].trim().slice(0, 80);
    add('chromium', v.ok ? 'pass' : 'fail', `${chrome.path} (${chrome.source}) ${v.ok ? ver : 'does not start'}`);
  }
  for (const bin of ['xvfb-run', 'Xvfb', 'xauth']) {
    add(`tool-${bin}`, onPath(bin) ? 'pass' : 'warn', onPath(bin) ? `${bin} present` : `${bin} not on PATH: the Reed browser cannot start without it (Caterer does not need it)`);
  }
  if (o.launch && chrome.path && isFile(chrome.path)) {
    const t = chooseTmpDir('ab');
    const r = await launchProbe(chrome.path, t.dir);
    if (r.ok) add('launch', 'pass', `headless Chromium starts with the production TMPDIR (${t.pathLen} character singleton path) and flags ${chromeArgList().join(' ')}`);
    else add('launch', 'fail', `headless Chromium did not start with the production TMPDIR: ${r.why}`);
  }
  return res;
}

module.exports = {
  SUN_PATH_MAX, SINGLETON_SUFFIX, HERMES_EXE_FILE, DEFAULT_CHROME_ARGS,
  singletonBudget, chooseTmpDir, resolveChromium, chromeArgList, reedSafetyArgs, localeEnv, usableHome, isWritableDir, ensureWritableDir, diagnose,
};
