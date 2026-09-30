'use strict';
// Where the browsers' TMPDIR lives (Chromium binds its singleton socket at $TMPDIR + 46 characters, the kernel allows 107),
// which Chromium binary is used, the browser locale, and the launch-environment rules shared by browser.js and ensure-chrome-cdp.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./helpers');
const be = require(path.join(H.SRC_SCRIPTS, 'lib', 'browser-env.js'));

const POSIX = !H.IS_WIN;

function tmpHome(t, padTo) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-env-'));
  t.after(() => H.rmrf(base));
  if (!padTo) return base;
  const deep = path.join(base, 'p'.repeat(Math.max(1, padTo - base.length - 1)));
  fs.mkdirSync(deep, { recursive: true });
  return deep;
}

test('singleton socket arithmetic: TMPDIR + 46 characters must stay within 107', () => {
  assert.deepEqual(be.singletonBudget('a'.repeat(61)), { tmpDir: 'a'.repeat(61), pathLen: 107, limit: 107, margin: 0 });
  assert.equal(be.singletonBudget('a'.repeat(62)).margin, -1);
  assert.equal(be.singletonBudget('a'.repeat(56)).margin, 5, 'state/t under the DESIGN layout (48 character workspace root) keeps 5 spare');
  assert.equal(be.singletonBudget(String.fromCharCode(233).repeat(30)).pathLen, 60 + 46, 'bytes, not characters');
});

test('default: state/t for Caterer and state/rt for Reed, separate directories, nothing relocated', (t) => {
  const home = tmpHome(t);
  const ab = be.chooseTmpDir('ab', { home, platform: 'linux' });
  const reed = be.chooseTmpDir('reed', { home, platform: 'linux' });
  assert.equal(ab.dir, path.join(home, 'state', 't'));
  assert.equal(reed.dir, path.join(home, 'state', 'rt'));
  assert.equal(ab.relocated, false);
  assert.ok(fs.statSync(ab.dir).isDirectory() && fs.statSync(reed.dir).isDirectory());
  assert.notEqual(ab.dir, reed.dir, 'the Caterer stale-profile sweep must never see the Reed browser socket dir');
  assert.throws(() => be.chooseTmpDir('nope', { home }), /unknown tmp dir kind/);
});

test('a workspace root too long for the socket path moves the TMPDIR to a short, deterministic, per-install directory', (t) => {
  const home = tmpHome(t, 90);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-envroot-'));
  t.after(() => H.rmrf(root));
  const a = be.chooseTmpDir('ab', { home, platform: 'linux', tmpRoot: root });
  assert.equal(a.relocated, true);
  assert.equal(a.reason, 'path-too-long');
  assert.match(path.relative(root, a.dir).split(path.sep).join('/'), /^rab-[0-9a-f]{8}\/t$/);
  assert.equal(a.margin, 107 - Buffer.byteLength(a.dir) - 46);
  assert.ok(fs.statSync(a.dir).isDirectory());
  const again = be.chooseTmpDir('ab', { home, platform: 'linux', tmpRoot: root });
  assert.equal(again.dir, a.dir, 'every process of one install agrees');
  const other = be.chooseTmpDir('ab', { home: tmpHome(t, 91), platform: 'linux', tmpRoot: root });
  assert.notEqual(other.dir, a.dir, 'two installs never share it');
  const r = be.chooseTmpDir('reed', { home, platform: 'linux', tmpRoot: root });
  assert.equal(path.basename(r.dir), 'rt');
  assert.equal(path.dirname(r.dir), path.dirname(a.dir));
});

test('a state directory that cannot hold the TMPDIR (a file is in the way) falls back too', (t) => {
  const home = tmpHome(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-envroot-'));
  t.after(() => H.rmrf(root));
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 't'), 'not a directory');
  const a = be.chooseTmpDir('ab', { home, platform: 'linux', tmpRoot: root });
  assert.equal(a.relocated, true);
  assert.equal(a.reason, 'not-writable');
});

test('browser.js hands agent-browser a TMPDIR whose singleton socket path fits, even for a very long RESOURCER_HOME (hermes-fit 79)', { skip: !POSIX && 'unix sockets' }, (t) => {
  const sb = H.buildSandbox({ prefix: 'rb-tmp-' });
  t.after(() => sb.cleanup());
  const deep = path.join(sb.home, 'x'.repeat(40), 'y'.repeat(40));
  fs.mkdirSync(deep, { recursive: true });
  const code = `
    const b = require(${JSON.stringify(path.join(sb.scripts, 'lib', 'browser.js'))});
    b.getUrl().then(() => b.status()).then((s) => { console.log(JSON.stringify(s)); process.exit(0); });`;
  const r = spawnSync(process.execPath, ['-e', code], { env: sb.env({ RESOURCER_HOME: deep }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const st = JSON.parse(r.stdout.trim().split('\n').pop());
  const seen = sb.fake.calls().pop().env;
  assert.ok(Buffer.byteLength(seen.tmpdir) + 46 <= 107, `TMPDIR ${seen.tmpdir} would give a ${seen.tmpdir.length + 46} character singleton socket path`);
  assert.equal(seen.tmpdir, st.tmpDir);
  assert.equal(st.singleton.relocated, true);
  assert.equal(st.singleton.reason, 'path-too-long');
  assert.ok(st.singleton.margin >= 0 && st.singleton.limit === 107);
  assert.match(st.tmpDir, /^\/tmp\/rab-[0-9a-f]{8}\/t$/);
  try { fs.rmSync(path.dirname(st.tmpDir), { recursive: true, force: true }); } catch { /* best effort */ }
});

test('status() exposes the singleton socket margin (5 spare for the default layout)', { skip: !POSIX && 'unix sockets' }, async (t) => {
  const sb = H.buildSandbox({ prefix: 'rb-st-' });
  sb.activate();
  t.after(() => sb.cleanup());
  const browser = sb.load('lib/browser.js');
  const st = await browser.status();
  assert.equal(st.singleton.limit, 107);
  assert.equal(st.singleton.pathLen, Buffer.byteLength(st.tmpDir) + 46);
  assert.equal(st.singleton.margin, 107 - st.singleton.pathLen);
  assert.equal(st.singleton.relocated, false);
  assert.equal(st.tmpDir, path.join(sb.home, 'state', 't'));
});

test('Chromium lookup: CHROMIUM_PATH, then the Debian binaries, then the path the Hermes image records (hermes-fit 83)', (t) => {
  const dir = tmpHome(t);
  const real = path.join(dir, 'chromium-from-image');
  fs.writeFileSync(real, '#!/bin/sh\n', { mode: 0o755 });
  const rec = path.join(dir, 'agent-browser-executable-path');
  fs.writeFileSync(rec, `${real}\n`);
  assert.deepEqual(be.resolveChromium({ explicit: '/opt/x/chromium', hermesFile: rec }), { path: '/opt/x/chromium', source: 'CHROMIUM_PATH' });
  const viaImage = be.resolveChromium({ explicit: '', hermesFile: rec });
  if (viaImage.source === 'hermes-image') assert.equal(viaImage.path, real);
  else assert.equal(viaImage.source, 'debian', 'a Debian chromium wins when it is installed');
  fs.writeFileSync(rec, `${path.join(dir, 'gone')}\n`);
  const none = be.resolveChromium({ explicit: '', hermesFile: rec });
  assert.ok(none.source === 'none' || none.source === 'debian');
  if (none.source === 'none') assert.equal(none.path, null, 'a recorded path that does not exist is ignored');
});

test('browser locale: London time and en-GB by default, individually switched off with "off"', () => {
  const keep = { tz: process.env.RESOURCER_BROWSER_TZ, lang: process.env.RESOURCER_BROWSER_LANG };
  try {
    delete process.env.RESOURCER_BROWSER_TZ; delete process.env.RESOURCER_BROWSER_LANG;
    assert.deepEqual(be.localeEnv(), { TZ: 'Europe/London', LANGUAGE: 'en_GB:en' });
    process.env.RESOURCER_BROWSER_TZ = 'off';
    assert.deepEqual(be.localeEnv(), { LANGUAGE: 'en_GB:en' });
    process.env.RESOURCER_BROWSER_LANG = 'off'; process.env.RESOURCER_BROWSER_TZ = 'Europe/Dublin';
    assert.deepEqual(be.localeEnv(), { TZ: 'Europe/Dublin' });
  } finally {
    for (const [k, v] of [['RESOURCER_BROWSER_TZ', keep.tz], ['RESOURCER_BROWSER_LANG', keep.lang]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('default Chromium flags are container-safe and the list is replaceable', () => {
  assert.deepEqual(be.chromeArgList(), ['--no-sandbox', '--disable-dev-shm-usage', '--lang=en-GB']);
  assert.deepEqual(be.chromeArgList(' --a , --b ,'), ['--a', '--b']);
  assert.deepEqual(be.reedSafetyArgs(), ['--no-sandbox', '--disable-dev-shm-usage', '--lang=en-GB']);
});

test('the daemon gets a writable HOME: an unusable inherited one is replaced by the state directory', { skip: !POSIX && 'HOME semantics' }, async (t) => {
  const sb = H.buildSandbox({ prefix: 'rb-home-' });
  sb.activate({ HOME: path.join(sb.home, 'no-such-home') });
  t.after(() => sb.cleanup());
  const browser = sb.load('lib/browser.js');
  await browser.getUrl();
  assert.equal(sb.fake.calls()[0].env.home, path.join(sb.home, 'state'));
});

test('agent-browser lookup follows the install layout before HERMES_HOME (hermes-fit 81)', { skip: !POSIX && 'layout' }, (t) => {
  const profile = tmpHome(t);
  const home = path.join(profile, 'workspace', 'resourcer');
  const wrong = path.join(profile, 'other-profile');
  fs.mkdirSync(path.join(profile, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(wrong, 'bin'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(profile, 'bin', 'agent-browser'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(wrong, 'bin', 'agent-browser'), '#!/bin/sh\n', { mode: 0o755 });
  const code = `const b = require(${JSON.stringify(path.join(H.SRC_SCRIPTS, 'lib', 'browser.js'))}); console.log(JSON.stringify(b.resolveBin()));`;
  const r = spawnSync(process.execPath, ['-e', code], {
    env: { PATH: process.env.PATH, RESOURCER_HOME: home, HERMES_HOME: wrong, RESOURCER_ENV_FILE: path.join(profile, 'none.env') }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).bin, path.join(profile, 'bin', 'agent-browser'));
});

test('diagnose() reports the singleton budgets and a missing browser without touching the network', { skip: !POSIX && 'Linux checks' }, async (t) => {
  const sb = H.buildSandbox({ prefix: 'rb-dg-' });
  sb.activate({ CHROMIUM_PATH: path.join(sb.home, 'no-chromium') });
  t.after(() => sb.cleanup());
  const dg = require(path.join(sb.scripts, 'lib', 'browser-env.js'));
  const rows = await dg.diagnose();
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by['singleton-ab'].level, 'pass');
  assert.match(by['singleton-ab'].text, /of 107 characters \(\d+ spare\)/);
  assert.equal(by['singleton-reed'].level, 'pass');
  assert.equal(by.chromium.level, 'fail');
  assert.match(by.chromium.text, /missing file/);
  assert.equal(by.state.level, 'pass');
});
