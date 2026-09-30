'use strict';
// caterer-preflight.js (daily pre-flight and overnight keep-alive) ends with the Reed launcher's
// --stop-if-idle, whatever else happened, so a Reed browser never sits next to the next Caterer run.
// Uses the browser package's sandbox (fake agent-browser); the launcher is replaced by a recorder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const B = require('../browser/helpers');

function setup(t, launcherBody) {
  const sb = B.buildSandbox({ prefix: 'sup-pre-' });
  sb.activate();
  sb.writeCreds();
  t.after(() => sb.cleanup());
  const log = path.join(sb.home, 'launcher-calls.log');
  fs.writeFileSync(path.join(sb.scripts, 'ensure-chrome-cdp.js'), launcherBody || [
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`,
    "if (process.argv.includes('--stop-if-idle')) console.log('CDP_NOT_RUNNING: no Reed browser processes found.');",
    "else console.log('CDP_READY: up');",
  ].join('\n'));
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((_, i, a) => i < a.length - 1) : []);
  return { sb, fake: sb.fake, calls, pre: (args, env) => sb.run('caterer-preflight.js', args || [], { env }) };
}

test('daily pre-flight: the last launcher call is --stop-if-idle, it is reported, and the exit code is untouched', async (t) => {
  const { fake, calls, pre } = setup(t);
  fake.warmLoggedIn();
  const r = pre();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(calls(), ['--stop-if-idle']);
  assert.match(r.stdout, /BROWSER_STOP_IDLE: exit 0 - CDP_NOT_RUNNING/);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.indexOf(lines.find((l) => /Pre-flight complete/.test(l))) < lines.findIndex((l) => /BROWSER_STOP_IDLE/.test(l)), 'after the work, as the final step');
});

test('overnight keep-alive ends with it too', async (t) => {
  const { sb, fake, calls, pre } = setup(t);
  fake.warmLoggedIn();
  const r = pre(['--keepalive']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(calls(), ['--stop-if-idle']);
  assert.equal(sb.readJson('runtime/caterer-preflight.json').browserStop.ran, true);
});

test('with Reed enabled the launcher is used to start the Reed browser and the very last call is still --stop-if-idle', async (t) => {
  const { sb, fake, calls, pre } = setup(t);
  fake.warmLoggedIn();
  fs.writeFileSync(path.join(sb.scripts, 'reed-refresh-token.js'), "console.log('REED_TOKEN_REFRESHED eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop');");
  const r = pre([], { RESOURCER_SOURCES: 'both' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // the Reed status sync (reed-api-client.js --sync-status) loads the launcher module, which the recorder logs as a call
  assert.deepEqual(calls().filter((c) => c !== '--sync-status'), ['', '--stop-if-idle']);
  assert.equal(calls().at(-1), '--stop-if-idle', 'still the very last launcher call');
  assert.match(r.stdout, /REED_OK: token refreshed/);
});

test('every failure path ends the same way: safe-list block, bad login, module error, missing tooling with the launcher present', async (t) => {
  for (const [mode, code] of [['safelist', 2], ['badpassword', 3]]) {
    const { fake, calls, pre } = setup(t);
    fake.scenario({ site: { login: { mode } } });
    const r = pre();
    assert.equal(r.status, code, mode);
    assert.deepEqual(calls(), ['--stop-if-idle'], mode);
  }
  const m = setup(t);
  m.fake.warmLoggedIn();
  m.fake.scenario({ site: { cvdbModuleError: true } });
  assert.equal(m.pre().status, 4);
  assert.deepEqual(m.calls(), ['--stop-if-idle']);

  const missing = setup(t);
  const r = missing.pre([], { RESOURCER_AB_BIN: path.join(missing.sb.home, 'no-such-agent-browser') });
  assert.equal(r.status, 1);
  assert.deepEqual(missing.calls(), ['--stop-if-idle'], 'even when the browser tooling is broken a stray Reed browser is stopped');
});

test('a launcher that fails or is absent never changes the pre-flight result', async (t) => {
  const failing = setup(t, "console.log('CDP_LAUNCH_FAILED: nope'); process.exit(1);");
  failing.fake.warmLoggedIn();
  let r = failing.pre();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /BROWSER_STOP_IDLE: exit 1 - CDP_LAUNCH_FAILED/);

  const absent = setup(t);
  absent.fake.warmLoggedIn();
  fs.rmSync(path.join(absent.sb.scripts, 'ensure-chrome-cdp.js'));
  r = absent.pre();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /BROWSER_STOP_IDLE/);
  assert.equal(absent.sb.readJson('runtime/caterer-preflight.json').browserStop.ran, false);
});

test('the real launcher CLI understands the call (no browser running: CDP_NOT_RUNNING, exit 0)', async (t) => {
  const sb = B.buildSandbox({ prefix: 'sup-pre-real-' });
  t.after(() => sb.cleanup());
  const r = sb.run('ensure-chrome-cdp.js', ['--stop-if-idle']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /CDP_NOT_RUNNING|CDP_STOPPED|CDP_BUSY_SKIP/);
});

test('the overnight keep-alive stands aside while a pipeline run is in flight (it would drive the same browser session); the daily pre-flight does not', async (t) => {
  const { sb, fake, pre } = setup(t);
  fake.warmLoggedIn();
  const tick = require('../../resourcer/scripts/lib/tick');
  fs.mkdirSync(path.join(sb.home, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(sb.home, 'runtime', 'run.json'), JSON.stringify({ pid: process.pid, token: tick.procToken(process.pid), nonce: 'live', role: 'runner', startedAt: new Date().toISOString() }));
  const r = pre(['--keepalive']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /CATERER_KEEPALIVE_SKIPPED: a pipeline run is in flight/);
  assert.equal(fake.calls().filter((c) => c.cmd).length, 0, 'the browser session was not touched');
  fs.unlinkSync(path.join(sb.home, 'runtime', 'run.json'));
  const again = pre(['--keepalive']);
  assert.match(again.stdout, /CATERER_KEPT_ALIVE/);
});
