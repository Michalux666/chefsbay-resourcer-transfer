'use strict';

// ensure-chrome-cdp on Linux with a fake chromium under the REAL xvfb-run: cold start, reuse, stale replacement, whole-tree
// shutdown without orphans, lock gate, concurrent launchers. Skipped where xvfb-run or /proc is unavailable (Windows).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const hasXvfb = process.platform === 'linux' && spawnSync('sh', ['-c', 'command -v xvfb-run && command -v Xvfb && command -v xauth']).status === 0;
const SKIP = hasXvfb ? false : 'needs Linux with xvfb-run, Xvfb and xauth';
const SCRIPT = path.resolve(__dirname, '..', '..', 'resourcer', 'scripts', 'ensure-chrome-cdp.js');
const FAKE = path.resolve(__dirname, 'helpers', 'fake-chromium.js');
const NODE_MODULES = path.resolve(__dirname, '..', '..', 'resourcer', 'node_modules');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { procs, withProfile, xvfbOrphans } = require('./helpers/procs');
function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
async function until(fn, ms = 10000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; }

async function env(extra) {
  const home = fs.mkdtempSync(path.join(process.env.REED_TEST_TMP || os.tmpdir(), 'reedlaunch-'));
  const bin = path.join(home, 'fake-chromium');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const port = await freePort();
  const apiPort = await freePort();
  const profile = path.join(home, 'state', 'chrome-reed');
  const e = {
    ...process.env,
    NODE_PATH: [NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
    RESOURCER_HOME: home, HERMES_HOME: path.join(home, 'hh'), RESOURCER_ENV_FILE: path.join(home, 'none.env'),
    CHROMIUM_PATH: bin, REED_CDP_PORT: String(port), FAKE_API_PORT: String(apiPort), REED_CDP_WAIT_S: '15', REED_CDP_POLL_MS: '100',
    ...(extra || {}),
  };
  delete e.REED_XVFB_RUN_UNSET;
  const cli = (args, o) => new Promise((resolve) => {
    const c = spawn(process.execPath, [SCRIPT, ...(args || [])], { env: { ...e, ...((o && o.env) || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  const cleanup = () => {
    spawnSync(process.execPath, [SCRIPT, '--stop', '--force'], { env: e });
    fs.rmSync(home, { recursive: true, force: true });
  };
  const launches = () => { try { return fs.readFileSync(path.join(profile, 'launches.txt'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { home, port, profile, e, cli, cleanup, launches, pidFile: path.join(home, 'state', 'reed-chrome.pid') };
}
const json = async (port, p, method) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: method || 'GET' }); return r.json(); };

test('cold start under xvfb-run: profile in state/, correct flags and DISPLAY, CDP verified, survives the launcher, pid file + log written', { skip: SKIP }, async () => {
  const w = await env();
  try {
    const orphansBefore = new Set(xvfbOrphans());
    const r = await w.cli([]);
    assert.strictEqual(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^CDP_LAUNCHING: /m);
    assert.match(r.stdout, /^CDP_READY: Chromium CDP reachable after \d+s\. \(Chrome\/153/m);
    const l = w.launches();
    assert.strictEqual(l.length, 1);
    const a = l[0].args;
    for (const f of [`--remote-debugging-port=${w.port}`, `--user-data-dir=${w.profile}`, '--no-first-run', '--no-default-browser-check', '--restore-last-session',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--no-sandbox', '--disable-dev-shm-usage', '--password-store=basic']) {
      assert.ok(a.includes(f), `missing flag ${f}`);
    }
    assert.strictEqual(a[a.length - 1], 'https://www.reed.co.uk/recruiter/v2/candidates/search/results');
    assert.match(l[0].display, /^:\d+$/, 'runs on an Xvfb display');
    assert.ok(w.profile.startsWith(path.join(w.home, 'state') + path.sep), 'profile lives under the workspace state/ directory (the test home itself may be under /tmp)');
    assert.ok(!a.some((x) => x.startsWith('--headless')), 'headed (Turnstile needs a real display)');
    await sleep(500);
    const v = await json(w.port, '/json/version');
    assert.match(v.Browser, /Chrome\/153/, 'CDP still answers after the launcher exited');
    const pid = JSON.parse(fs.readFileSync(w.pidFile, 'utf8'));
    assert.ok(pid.pid > 1 && pid.port === w.port && pid.profile === w.profile);
    assert.ok(fs.existsSync(path.join(w.home, 'logs', 'reed-chrome.log')));
    assert.ok(procs().some((p) => p.cmd.split(' ')[0].endsWith('Xvfb')), 'an Xvfb server exists while the browser runs');
  } finally { w.cleanup(); }
});

test('an already-live instance is reused (no second launch), --ensure-reed-tab opens a tab only when none exists', { skip: SKIP }, async () => {
  const w = await env();
  try {
    assert.strictEqual((await w.cli([])).code, 0);
    const r = await w.cli([]);
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /^CDP_READY: Chromium already listening on \d+\.$/m);
    assert.strictEqual(w.launches().length, 1);
    let tabs = await json(w.port, '/json');
    assert.ok(tabs.some((t) => String(t.url).includes('reed.co.uk')));
    for (const t of tabs) await json(w.port, `/json/close/${t.id}`, 'PUT').catch(() => null);
    tabs = await json(w.port, '/json');
    assert.strictEqual(tabs.length, 0);
    const r2 = await w.cli(['--ensure-reed-tab']);
    assert.strictEqual(r2.code, 0, r2.stdout);
    tabs = await json(w.port, '/json');
    assert.strictEqual(tabs.length, 1, 'a new tab was opened in the live browser');
    assert.strictEqual(w.launches().length, 1, 'and the browser was not restarted');
  } finally { w.cleanup(); }
});

test('a stale non-serving instance (ignores SIGTERM) is stopped and replaced; a stale SingletonLock does not block the profile', { skip: SKIP }, async () => {
  const w = await env({ FAKE_CHROMIUM_MODE: 'lock-check' });
  try {
    // stale instance: same profile, never serves CDP, ignores SIGTERM
    fs.mkdirSync(w.profile, { recursive: true });
    const stale = spawn('xvfb-run', ['-a', w.e.CHROMIUM_PATH, `--remote-debugging-port=${w.port}`, `--user-data-dir=${w.profile}`, 'about:blank'],
      { detached: true, stdio: 'ignore', env: { ...w.e, FAKE_CHROMIUM_MODE: 'never-listen' } });
    stale.unref();
    assert.ok(await until(() => withProfile(w.profile).length >= 2), 'stale wrapper + chromium are up');
    const staleRenderer = await until(() => { try { return Number(fs.readFileSync(path.join(w.profile, 'renderer.pid'), 'utf8')); } catch { return null; } });
    fs.writeFileSync(path.join(w.profile, 'SingletonLock'), 'stale-host-123');
    const r = await w.cli([]);
    assert.strictEqual(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^CDP_KILLING: stopping \d+ stale process\(es\)/m);
    assert.match(r.stdout, /^CDP_READY: Chromium CDP reachable/m, 'lock-check mode only starts when the stale lock was removed');
    assert.strictEqual(w.launches().filter((x) => x.args.length).length, 2, 'stale + new');
    const fresh = await until(() => { try { return Number(fs.readFileSync(path.join(w.profile, 'renderer.pid'), 'utf8')); } catch { return null; } });
    assert.notStrictEqual(fresh, staleRenderer);
    assert.strictEqual(fs.existsSync(`/proc/${staleRenderer}`), false, 'stale renderer is gone');
  } finally { w.cleanup(); }
});

test('missing browser binary, missing xvfb-run and a browser that dies at startup all fail fast with exit 1 and the legacy markers', { skip: SKIP }, async () => {
  const w = await env();
  try {
    let r = await w.cli([], { env: { CHROMIUM_PATH: '/nonexistent/chromium' } });
    assert.strictEqual(r.code, 1);
    assert.match(r.stdout, /^CDP_NO_CHROME: /m);
    r = await w.cli([], { env: { REED_XVFB_RUN: '/nonexistent/xvfb-run' } });
    assert.strictEqual(r.code, 1);
    assert.match(r.stdout, /^CDP_LAUNCH_FAILED: /m);
    const t0 = Date.now();
    r = await w.cli([], { env: { FAKE_CHROMIUM_MODE: 'exit-early', REED_CDP_WAIT_S: '20' } });
    assert.strictEqual(r.code, 1);
    assert.match(r.stdout, /^CDP_LAUNCH_FAILED: browser exited during startup \(code 3/m);
    assert.ok(Date.now() - t0 < 10000, 'does not wait out the full timeout for a dead browser');
    assert.strictEqual(fs.existsSync(w.pidFile), false);
  } finally { w.cleanup(); }
});

test('a browser that never opens CDP: CDP_TIMEOUT, exit 1, and the launched tree is torn down (no leaked chromium or Xvfb)', { skip: SKIP }, async () => {
  const w = await env({ FAKE_CHROMIUM_MODE: 'never-listen' });
  try {
    const orphansBefore = new Set(xvfbOrphans());
    const r = await w.cli(['--wait', '2']);
    assert.strictEqual(r.code, 1);
    assert.match(r.stdout, /^CDP_TIMEOUT: Chromium launched but CDP still not responding after 2s/m);
    assert.ok(await until(() => withProfile(w.profile).length === 0, 8000), 'no process left using the profile');
    assert.ok(await until(() => xvfbOrphans().every((p) => orphansBefore.has(p)), 8000), 'no orphaned Xvfb');
  } finally { w.cleanup(); }
});

test('--stop kills the whole tree (chromium, renderer, wrapper, Xvfb) cleanly, trims caches but keeps cookies, and is idempotent', { skip: SKIP }, async () => {
  const w = await env();
  try {
    const orphansBefore = new Set(xvfbOrphans());
    assert.strictEqual((await w.cli([])).code, 0);
    fs.mkdirSync(path.join(w.profile, 'Default', 'Cache'), { recursive: true });
    fs.writeFileSync(path.join(w.profile, 'Default', 'Cache', 'blob'), 'x');
    fs.writeFileSync(path.join(w.profile, 'Default', 'Cookies'), 'keep-me');
    assert.ok(withProfile(w.profile).length >= 3, 'wrapper + chromium + renderer');
    const r = await w.cli(['--stop']);
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /^CDP_STOPPED: stopped \d+ process\(es\)\./m);
    assert.strictEqual(withProfile(w.profile).length, 0);
    assert.ok(await until(() => xvfbOrphans().every((p) => orphansBefore.has(p)), 8000), 'xvfb-run removed its own Xvfb: no orphan');
    assert.strictEqual(fs.existsSync(path.join(w.profile, 'Default', 'Cache')), false, 'cache trimmed');
    assert.strictEqual(fs.readFileSync(path.join(w.profile, 'Default', 'Cookies'), 'utf8'), 'keep-me', 'login state kept');
    assert.strictEqual(fs.existsSync(w.pidFile), false);
    const again = await w.cli(['--stop']);
    assert.strictEqual(again.code, 0);
    assert.match(again.stdout, /^CDP_NOT_RUNNING: /m);
  } finally { w.cleanup(); }
});

test('--stop escalates to SIGKILL for a browser that ignores SIGTERM and still leaves no orphan Xvfb', { skip: SKIP }, async () => {
  const w = await env({ FAKE_CHROMIUM_MODE: 'ignore-term' });
  try {
    const orphansBefore = new Set(xvfbOrphans());
    assert.strictEqual((await w.cli([])).code, 0);
    const t0 = Date.now();
    const r = await w.cli(['--stop']);
    assert.strictEqual(r.code, 0, r.stdout);
    assert.ok(Date.now() - t0 < 30000);
    assert.strictEqual(withProfile(w.profile).length, 0);
    assert.ok(await until(() => xvfbOrphans().every((p) => orphansBefore.has(p)), 10000), 'no orphan Xvfb after the escalation path');
  } finally { w.cleanup(); }
});

test('--restart replaces the running browser; --status reports it', { skip: SKIP }, async () => {
  const w = await env();
  try {
    assert.strictEqual((await w.cli([])).code, 0);
    const first = JSON.parse(fs.readFileSync(w.pidFile, 'utf8')).pid;
    const st = await w.cli(['--status']);
    assert.strictEqual(st.code, 0);
    const j = JSON.parse(st.stdout);
    assert.strictEqual(j.cdp, true);
    assert.match(j.browser, /Chrome\/153/);
    assert.strictEqual(j.pidFile.pid, first);
    const r = await w.cli(['--restart']);
    assert.strictEqual(r.code, 0, r.stdout);
    const second = JSON.parse(fs.readFileSync(w.pidFile, 'utf8')).pid;
    assert.notStrictEqual(first, second);
    assert.strictEqual(fs.existsSync(`/proc/${first}`), false);
    assert.strictEqual(w.launches().length, 2);
    await w.cli(['--stop']);
    assert.strictEqual((await w.cli(['--status'])).code, 1);
  } finally { w.cleanup(); }
});

test('browser.lock: a live Caterer holder blocks launch and --stop (exit 4); --force stops; --stop-if-idle leaves it alone', { skip: SKIP }, async () => {
  const w = await env();
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    fs.mkdirSync(path.join(w.home, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(w.home, 'runtime', 'browser.lock'), JSON.stringify({ owner: 'caterer', pid: holder.pid, startedAt: new Date().toISOString() }));
    let r = await w.cli([]);
    assert.strictEqual(r.code, 4);
    assert.strictEqual(w.launches().length, 0, 'never launched while a Caterer run is active');
    fs.unlinkSync(path.join(w.home, 'runtime', 'browser.lock'));
    assert.strictEqual((await w.cli([])).code, 0);
    fs.writeFileSync(path.join(w.home, 'runtime', 'browser.lock'), JSON.stringify({ owner: 'caterer', pid: holder.pid, startedAt: new Date().toISOString() }));
    r = await w.cli(['--stop']);
    assert.strictEqual(r.code, 4);
    r = await w.cli(['--stop-if-idle']);
    assert.match(r.stdout, /^CDP_BUSY_SKIP/m);
    assert.ok(withProfile(w.profile).length > 0, 'still running');
    r = await w.cli(['--stop', '--force']);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(withProfile(w.profile).length, 0);
  } finally { holder.kill(); w.cleanup(); }
});

test('--stop-if-idle stops a lingering browser when nobody holds the lock (supervisor tick use)', { skip: SKIP }, async () => {
  const w = await env();
  try {
    assert.strictEqual((await w.cli([])).code, 0);
    const r = await w.cli(['--stop-if-idle']);
    assert.match(r.stdout, /^CDP_STOPPED/m);
    assert.strictEqual(withProfile(w.profile).length, 0);
  } finally { w.cleanup(); }
});

test('two launchers racing produce exactly one browser', { skip: SKIP }, async () => {
  const w = await env();
  try {
    const [a, b] = await Promise.all([w.cli([]), w.cli([])]);
    assert.strictEqual(a.code, 0, a.stdout);
    assert.strictEqual(b.code, 0, b.stdout);
    assert.strictEqual(w.launches().length, 1);
  } finally { w.cleanup(); }
});

test('stop never kills the process that asked for it or its ancestors, even if their argv carries the profile flag', { skip: SKIP }, async () => {
  const w = await env();
  try {
    assert.strictEqual((await w.cli([])).code, 0);
    const res = spawnSync('sh', ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} --stop; echo PARENT_ALIVE`, '_', `--user-data-dir=${w.profile}`], { env: w.e });
    assert.match(res.stdout.toString(), /CDP_STOPPED/);
    assert.match(res.stdout.toString(), /PARENT_ALIVE/);
  } finally { w.cleanup(); }
});

test('--stop quits the browser THROUGH CDP first so cookies and session state are flushed (plain SIGTERM would lose the login)', { skip: SKIP }, async () => {
  const w = await env();
  try {
    assert.strictEqual((await w.cli([])).code, 0);
    const r = await w.cli(['--stop']);
    assert.strictEqual(r.code, 0);
    assert.match(r.stdout, /^CDP_STOPPED: stopped \d+ process\(es\)\. \(quit through CDP\)/m);
    assert.ok(fs.existsSync(path.join(w.profile, 'cookies-flushed.txt')), 'Browser.close was honoured, the cookie database was flushed');
    assert.strictEqual(withProfile(w.profile).length, 0);
  } finally { w.cleanup(); }
});

test('a browser that ignores Browser.close is still stopped by the SIGTERM/SIGKILL ladder (no flush marker: the forced path)', { skip: SKIP }, async () => {
  for (const mode of ['ignore-close', 'ignore-term']) {
    const w = await env({ FAKE_CHROMIUM_MODE: mode, REED_CDP_CLOSE_WAIT_MS: '700' });
    try {
      const orphansBefore = new Set(xvfbOrphans());
      assert.strictEqual((await w.cli([])).code, 0);
      const r = await w.cli(['--stop']);
      assert.strictEqual(r.code, 0, r.stdout);
      assert.strictEqual(fs.existsSync(path.join(w.profile, 'cookies-flushed.txt')), false, mode);
      assert.strictEqual(withProfile(w.profile).length, 0, mode);
      assert.ok(await until(() => xvfbOrphans().every((p) => orphansBefore.has(p)), 10000), 'no orphan Xvfb');
    } finally { w.cleanup(); }
  }
});

test('a browser whose /proc cmdline is ONE joined element is found by --stop-if-idle, --stop and --restart; a look-alike profile is left alone', { skip: SKIP }, async () => {
  const w = await env();
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const spawned = [];
  const titled = (profile) => {
    const c = spawn(process.execPath, ['-e', `process.title = ${JSON.stringify(`/usr/lib/chromium/chromium --remote-debugging-port=1 --user-data-dir=${profile} --no-first-run about:blank`)}; setInterval(() => {}, 1000)`], { stdio: 'ignore' });
    spawned.push(c);
    return c;
  };
  const oneElement = (pid, profile) => until(() => {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      return raw.length === 1 && raw[0].includes(`--user-data-dir=${profile} `);
    } catch { return false; }
  }, 5000);
  const decoy = titled(`${w.profile}-caterer`);
  try {
    assert.ok(await oneElement(decoy.pid, `${w.profile}-caterer`), 'precondition: the title was rewritten into a single element');
    for (const flag of ['--stop-if-idle', '--stop']) {
      const target = titled(w.profile);
      assert.ok(await oneElement(target.pid, w.profile), `precondition (${flag})`);
      const r = await w.cli([flag]);
      assert.strictEqual(r.code, 0, r.stdout);
      assert.match(r.stdout, /^CDP_STOPPED: stopped 1 process\(es\)\./m, `${flag}: ${r.stdout}`);
      assert.ok(await until(() => !alive(target.pid), 8000), `${flag}: the browser was really stopped`);
      assert.ok(alive(decoy.pid), `${flag}: the look-alike profile was not touched`);
    }
    const stale = titled(w.profile);
    assert.ok(await oneElement(stale.pid, w.profile));
    const r = await w.cli(['--restart']);
    assert.strictEqual(r.code, 0, r.stdout);
    assert.ok(await until(() => !alive(stale.pid), 8000), '--restart replaced the joined-cmdline browser');
    assert.strictEqual(w.launches().length, 1, 'and started a fresh one');
    assert.ok(alive(decoy.pid));
  } finally { for (const c of spawned) c.kill('SIGKILL'); w.cleanup(); }
});

test('--restart quits through CDP as well, so the login survives a restart', { skip: SKIP }, async () => {
  const w = await env();
  try {
    assert.strictEqual((await w.cli([])).code, 0);
    const r = await w.cli(['--restart']);
    assert.strictEqual(r.code, 0, r.stdout);
    assert.ok(fs.existsSync(path.join(w.profile, 'cookies-flushed.txt')));
    assert.strictEqual(w.launches().length, 2);
  } finally { w.cleanup(); }
});
