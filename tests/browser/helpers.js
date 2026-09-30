'use strict';
/*
 * Shared helpers for the browser-caterer tests. buildSandbox() copies the scripts under test into a
 * throw-away RESOURCER_HOME (so legacy-style helpers that resolve paths from __dirname work) and wires
 * the fake agent-browser. Real KEEP/core files are used when they exist in the repo; otherwise the
 * fixtures in ./fixtures stand in.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const fake = require('./fake');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_SCRIPTS = path.join(REPO_ROOT, 'resourcer', 'scripts');
const FIX = path.join(__dirname, 'fixtures');

const KEEP_FILES = ['constants.js', 'caterer-session-utils.js', 'fetch-with-timeout.js'];

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

function mkTmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'rb-')); }
function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

const FAKE_CRED = Object.freeze({ username: 'fake.user@example.invalid', password: 'fake-pass-123' });

function buildSandbox(opts) {
  const o = Object.assign({ prefix: 'rb-' }, opts || {});
  const home = mkTmp(o.prefix);
  const scripts = path.join(home, 'scripts');
  copyDir(SRC_SCRIPTS, scripts);
  for (const f of KEEP_FILES) {
    if (!fs.existsSync(path.join(scripts, f))) fs.copyFileSync(path.join(FIX, 'legacy-keep', f), path.join(scripts, f));
  }
  const credLib = path.join(scripts, 'lib', 'caterer-credentials.js');
  if (!fs.existsSync(credLib)) fs.copyFileSync(path.join(FIX, 'core-stubs', 'caterer-credentials.js'), credLib);
  const f = fake.create(path.join(home, 'fake-ab'));
  const hermes = path.join(home, 'hermes-home');
  fs.mkdirSync(hermes, { recursive: true });

  const sb = {
    home, scripts, fake: f, hermes,
    env(extra) {
      const base = {};
      for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'NODE_OPTIONS']) {
        if (process.env[k] !== undefined) base[k] = process.env[k];
      }
      return Object.assign(base, { RESOURCER_HOME: home, HERMES_HOME: hermes }, f.env(), extra || {});
    },
    /** Apply the sandbox env to THIS process (for in-process require of sandbox modules). */
    activate(extra) {
      sb._saved = {};
      const e = sb.env(extra);
      for (const k of Object.keys(e)) { sb._saved[k] = process.env[k]; process.env[k] = e[k]; }
      for (const k of Object.keys(process.env)) if (k.startsWith('AGENT_BROWSER_') && !(k in e)) { sb._saved[k] = process.env[k]; delete process.env[k]; }
    },
    deactivate() {
      for (const k of Object.keys(sb._saved || {})) { if (sb._saved[k] === undefined) delete process.env[k]; else process.env[k] = sb._saved[k]; }
      sb._saved = {};
    },
    load(rel) { return require(path.join(scripts, rel)); },
    writeCreds(obj) {
      const dir = path.join(home, 'secrets');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'caterer-credentials.json'), JSON.stringify(obj || FAKE_CRED));
      f.scenario({ site: { credentials: obj || FAKE_CRED } });
    },
    sessionFile() { fs.mkdirSync(path.join(home, 'state'), { recursive: true }); return path.join(home, 'state', 'caterer-session.json'); },
    writeSession(cookies, extra) {
      fs.mkdirSync(path.dirname(sb.sessionFile()), { recursive: true });
      fs.writeFileSync(sb.sessionFile(), JSON.stringify(Object.assign({ cookies, origins: [] }, extra || {})));
    },
    readJson(rel) { try { return JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8')); } catch { return null; } },
    run(script, args, ro) {
      const r = ro || {};
      const res = spawnSync(process.execPath, [path.join(scripts, script), ...(args || [])], {
        cwd: home, env: sb.env(r.env), encoding: 'utf8', timeout: r.timeout || 120000, input: r.input,
      });
      return { status: res.status, signal: res.signal, stdout: res.stdout || '', stderr: res.stderr || '', error: res.error };
    },
    cleanup() { sb.deactivate(); rmrf(home); },
  };
  return sb;
}

/** Throw for any fetch to a host other than loopback (DESIGN section 9: zero network in tests). */
function installFetchGuard() {
  if (globalThis.__fetchGuard) return;
  const real = globalThis.fetch;
  globalThis.__fetchGuard = true;
  globalThis.fetch = function guarded(url, opts) {
    const u = new URL(typeof url === 'string' ? url : (url && url.url) || String(url));
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') throw new Error(`network guard: refusing fetch to ${u.hostname}`);
    return real(url, opts);
  };
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, stepMs) {
  const end = Date.now() + (timeoutMs || 5000);
  while (Date.now() < end) { if (await fn()) return true; await sleep(stepMs || 50); }
  return !!(await fn());
}

const IS_WIN = process.platform === 'win32';

module.exports = { REPO_ROOT, SRC_SCRIPTS, buildSandbox, installFetchGuard, mkTmp, rmrf, pidAlive, sleep, waitFor, FAKE_CRED, IS_WIN, fake };
