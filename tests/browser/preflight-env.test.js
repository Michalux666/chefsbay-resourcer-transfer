'use strict';
// caterer-preflight.js: it never signs in underneath a run that is in flight (either mode), and --check-env is a read-only self-check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./helpers');

function setup(t, envExtra) {
  const sb = H.buildSandbox({ prefix: 'rb-pre2-' });
  sb.activate(envExtra);
  sb.writeCreds();
  t.after(() => sb.cleanup());
  return { sb, fake: sb.fake, pre: (args, env) => sb.run('caterer-preflight.js', args || [], { env }) };
}

function fakeRun(sb, t) {
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(function(){},60000)'], { stdio: 'ignore' });
  t.after(() => { try { sleeper.kill('SIGKILL'); } catch { /* gone */ } });
  fs.mkdirSync(path.join(sb.home, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(sb.home, 'runs', 'phase1-2026-09-30-100000.json.run-lock'), JSON.stringify({ pid: sleeper.pid, startedAt: Date.now() }));
  return sleeper;
}

test('a run in flight: the daily pre-flight skips (no sign-in, exit 0), like the keep-alive always did', async (t) => {
  const { sb, fake, pre } = setup(t);
  fakeRun(sb, t);
  for (const args of [[], ['--keepalive']]) {
    const r = pre(args);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, args.length ? /^CATERER_KEEPALIVE_SKIPPED: a pipeline run is in flight/m : /^CATERER_PREFLIGHT_SKIPPED: a pipeline run is in flight/m);
    assert.doesNotMatch(r.stdout, /CATERER_(OK|LOGIN_FAILED|SAFELIST)/);
  }
  assert.equal(fake.counters().submits || 0, 0, 'nobody signed in');
  assert.equal(fake.calls().filter((c) => c.cmd === 'open').length, 0, 'the shared browser session was not navigated');
  assert.equal(sb.readJson('runtime/caterer-preflight.json').caterer.state, 'skipped');
});

test('--check-env is read-only: no browser call, no sign-in, no summary file; a missing Chromium is a FAIL with exit 1', async (t) => {
  const { sb, fake, pre } = setup(t);
  const empty = H.mkTmp('rb-nochrome-');
  t.after(() => H.rmrf(empty));
  const r = pre(['--check-env'], { CHROMIUM_PATH: path.join(empty, 'chromium-that-is-not-there') });
  assert.equal(fake.calls().length, 0, 'agent-browser was never called');
  assert.ok(!fs.existsSync(path.join(sb.home, 'runtime', 'caterer-preflight.json')));
  if (H.IS_WIN) { assert.equal(r.status, 0); assert.match(r.stdout, /^BROWSER_ENV_OK$/m); return; }
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^PASS singleton-ab Caterer Chromium singleton socket path \d+ of 107 characters \(\d+ spare\)$/m);
  assert.match(r.stdout, /^PASS singleton-reed Reed Chromium singleton socket path/m);
  assert.match(r.stdout, /^FAIL chromium CHROMIUM_PATH points at a missing file/m);
  assert.match(r.stdout, /^BROWSER_ENV_FAIL: 1 check\(s\) failed$/m);
  assert.doesNotMatch(r.stdout, /^BROWSER_ENV_OK/m);
});

test('--check-env passes with a Chromium that starts, and --launch alone is a usage error', async (t) => {
  const dir = H.mkTmp('rb-fakechrome-');
  t.after(() => H.rmrf(dir));
  const chrome = path.join(dir, 'chromium');
  fs.writeFileSync(chrome, '#!/bin/sh\necho "Chromium 999.0.0.0 fake"\n', { mode: 0o755 });
  const { pre } = setup(t);
  const r = pre(['--check-env'], { CHROMIUM_PATH: chrome });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^BROWSER_ENV_OK$/m);
  if (!H.IS_WIN) assert.match(r.stdout, /^PASS chromium .*chromium \(CHROMIUM_PATH\) Chromium 999/m);
  const bad = pre(['--launch']);
  assert.equal(bad.status, 64);
  assert.match(bad.stdout, /--launch only goes with --check-env/);
});
