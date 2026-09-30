'use strict';

// The Reed launcher inside a container/microVM: its own short TMPDIR (xvfb-run and Chromium's singleton socket), London locale,
// replaceable safety flags, the Hermes-image Chromium path, and readable causes for launch failures. Linux with xvfb-run only.

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

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

async function env(extra) {
  const home = fs.mkdtempSync(path.join(process.env.REED_TEST_TMP || os.tmpdir(), 'reedenv-'));
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
  for (const k of ['REED_CHROME_ARGS', 'RESOURCER_BROWSER_TZ', 'RESOURCER_BROWSER_LANG']) if (!(extra && k in extra)) delete e[k];
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
  return { home, port, profile, e, cli, cleanup, launches };
}

test('the browser gets its own short TMPDIR under state/, never the inherited one: a missing Hermes scratch directory no longer stops xvfb-run (hermes-fit 82)', { skip: SKIP }, async () => {
  const w = await env({ TMPDIR: path.join(os.tmpdir(), 'reedenv-no-such-scratch', 'cache', 'scratch') });
  try {
    const r = await w.cli([]);
    assert.strictEqual(r.code, 0, r.stdout + r.stderr);
    const l = w.launches()[0];
    assert.strictEqual(l.tmpdir, path.join(w.home, 'state', 'rt'), 'the Reed TMPDIR lives in state/rt');
    assert.ok(fs.statSync(l.tmpdir).isDirectory());
    assert.ok(Buffer.byteLength(l.tmpdir) + 46 <= 107, 'short enough for the singleton socket');
    assert.strictEqual(fs.existsSync(w.e.TMPDIR), false, 'the inherited scratch directory was not needed');
  } finally { w.cleanup(); }
});

test('a workspace root too long for the singleton socket relocates the Reed TMPDIR to the short ephemeral directory', { skip: SKIP }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reedenvlong-'));
  const deep = path.join(base, 'a-deliberately-long-directory-name-to-push-the-socket-path-over-the-limit', 'and-more-length');
  fs.mkdirSync(deep, { recursive: true });
  const w = await env({ RESOURCER_HOME: deep, RESOURCER_ENV_FILE: path.join(deep, 'none.env'), REED_CHROME_PROFILE: path.join(base, 'p') });
  let shortRoot = null;
  try {
    const r = await w.cli([]);
    assert.strictEqual(r.code, 0, r.stdout + r.stderr);
    const rec = JSON.parse(fs.readFileSync(path.join(base, 'p', 'launches.txt'), 'utf8').split('\n').filter(Boolean)[0]);
    assert.match(rec.tmpdir, /\/rab-[0-9a-f]{8}\/rt$/);
    assert.ok(Buffer.byteLength(rec.tmpdir) + 46 <= 107);
    shortRoot = path.dirname(rec.tmpdir);
  } finally {
    w.cleanup();
    if (shortRoot) fs.rmSync(shortRoot, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('locale and flags: London time and en-GB by default, the safety flags replaceable, HOME kept usable', { skip: SKIP }, async () => {
  const w = await env();
  try {
    assert.strictEqual((await w.cli([])).code, 0);
    let l = w.launches()[0];
    assert.strictEqual(l.tz, 'Europe/London');
    assert.strictEqual(l.language, 'en_GB:en');
    for (const f of ['--no-sandbox', '--disable-dev-shm-usage', '--lang=en-GB', '--password-store=basic']) assert.ok(l.args.includes(f), `missing ${f}`);
    assert.ok(!l.args.includes('--disable-gpu'), 'no GPU flag by default: WebGL stays available to the login page');
    assert.strictEqual(fs.statSync(l.home).isDirectory(), true);
  } finally { w.cleanup(); }
  const w2 = await env({ REED_CHROME_ARGS: '--no-sandbox,--disable-gpu', RESOURCER_BROWSER_TZ: 'off', RESOURCER_BROWSER_LANG: 'off', TZ: 'UTC', HOME: '/nonexistent-home-dir' });
  try {
    assert.strictEqual((await w2.cli([])).code, 0);
    const l = w2.launches()[0];
    assert.ok(l.args.includes('--disable-gpu') && l.args.includes('--no-sandbox'));
    assert.ok(!l.args.includes('--disable-dev-shm-usage') && !l.args.includes('--lang=en-GB'), 'REED_CHROME_ARGS replaces the whole safety list');
    assert.strictEqual(l.tz, 'UTC', 'off leaves the inherited zone alone');
    assert.strictEqual(l.language, null);
    assert.strictEqual(l.home, path.join(w2.home, 'state'), 'an unusable HOME is replaced by the state directory');
  } finally { w2.cleanup(); }
});

test('--status names the browser it would use and the singleton socket budget', { skip: SKIP }, async () => {
  const w = await env();
  try {
    const r = await w.cli(['--status']);
    assert.strictEqual(r.code, 1, 'nothing is running');
    const st = JSON.parse(r.stdout);
    assert.strictEqual(st.chrome, path.join(w.home, 'fake-chromium'));
    assert.strictEqual(st.chromeSource, 'CHROMIUM_PATH');
    assert.strictEqual(st.singleton.limit, 107);
    assert.ok(st.singleton.margin >= 0);
  } finally { w.cleanup(); }
});

test('launch failures name their cause: sandbox unavailable, and a SIGTRAP abort', { skip: SKIP }, async () => {
  const w = await env({ FAKE_CHROMIUM_MODE: 'no-sandbox-available' });
  try {
    const r = await w.cli([]);
    assert.strictEqual(r.code, 1);
    assert.match(r.stdout, /^CDP_LAUNCH_FAILED: browser exited during startup \(code 5, signal null\): the sandbox is unavailable: keep --no-sandbox in REED_CHROME_ARGS; see /m);
  } finally { w.cleanup(); }
  const w2 = await env({ FAKE_CHROMIUM_MODE: 'sigtrap' });
  try {
    const r = await w2.cli([]);
    assert.strictEqual(r.code, 1);
    assert.match(r.stdout, /^CDP_LAUNCH_FAILED: browser exited during startup \(code 133.*aborted \(SIGTRAP\).*TMPDIR/m);
  } finally { w2.cleanup(); }
});

test('after a stop the TMPDIR residue of the killed browser (singleton-socket and xvfb-run directories) is gone, other files stay', { skip: SKIP }, async () => {
  const w = await env();
  try {
    assert.strictEqual((await w.cli([])).code, 0);
    const tmp = path.join(w.home, 'state', 'rt');
    fs.mkdirSync(path.join(tmp, '.org.chromium.Chromium.AbC123'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'xvfb-run.Zz9'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'keep.txt'), 'x');
    assert.strictEqual((await w.cli(['--stop'])).code, 0);
    assert.strictEqual(fs.existsSync(path.join(tmp, '.org.chromium.Chromium.AbC123')), false);
    assert.strictEqual(fs.existsSync(path.join(tmp, 'xvfb-run.Zz9')), false);
    assert.strictEqual(fs.existsSync(path.join(tmp, 'keep.txt')), true);
  } finally { w.cleanup(); }
});
