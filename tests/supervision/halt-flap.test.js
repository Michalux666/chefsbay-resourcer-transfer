'use strict';
// Update C finalizer, verifier findings 1 and 3.
//   1  the CV canary is one small invented request: a route that answers it but fails on real CVs would make the supervisor clear the halt, start another run
//      (unlocks spend credits) and hold again, for ever. After two clears within the window while a held queue is waiting, the third clear is refused
//      (a manual clear or a fix is needed); clears with no held queue are never counted.
//   3  a held queue whose own pending search is gone is verified on a tick with no READY search, so the halt does not wait for the next queued territory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./_helpers');
const { startFakeGateway } = require('../fake-gateway/server');

H.installNetworkGuard();
const HOME = H.mkHome(null, 'haltflap');
process.env.RESOURCER_HOME = HOME;
process.env.HERMES_HOME = HOME;
process.env.RESOURCER_ENV_FILE = path.join(HOME, 'none.env');
process.env.AI_GATEWAY_API_KEY = 'fake-test-key';
process.env.SCREEN_ENGINE = 'jev_only';
process.env.SCREEN_BACKOFF_BASE_MS = '2';
delete process.env.CV_SCREEN;
fs.mkdirSync(path.join(HOME, 'config'), { recursive: true });
fs.copyFileSync(path.join(H.REPO, 'resourcer', 'config', 'cv-screening.json'), path.join(HOME, 'config', 'cv-screening.json'));

const wd = require(path.join(H.SRC_SCRIPTS, 'pipeline-watchdog.js'));
const halt = require(path.join(H.SRC_SCRIPTS, 'lib', 'pipeline-halt.js'));
const health = require(path.join(H.SRC_SCRIPTS, 'lib', 'screening-health.js'));
const { C } = wd;

test.after(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

const MIN = 60000;
const heldStatus = () => H.writeJson(path.join(HOME, 'runs', 'phase1-2026-09-29-100000.json'), { id: 'phase1-2026-09-29-100000', status: 'phase1_abandoned', jobTitle: 'Chef', location: 'AB1', sources: 'caterer', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), phase2Hold: { reason: 'cv-screening-unavailable', at: new Date().toISOString() } });
const noHeld = () => fs.rmSync(path.join(HOME, 'runs', 'phase1-2026-09-29-100000.json'), { force: true });

function mk(clockStart) {
  const box = { clock: clockStart };
  const ctx = wd.makeCtx({ home: HOME, now: () => box.clock, log: () => {}, notify: H.collectNotifier(), dbFit: () => ({ ok: true }), memAvailMb: () => 4000, screening: () => health });
  return { box, ctx, state: wd.defaultState() };
}

async function gateway(t) {
  const gw = await startFakeGateway({ key: 'fake-test-key' });
  t.after(() => gw.close());
  process.env.SCREEN_GATEWAY_ORIGIN = gw.origin;
  process.env.CV_SCREEN = 'on';
  t.after(() => { delete process.env.CV_SCREEN; });
  return gw;
}

test('the halt of a held queue is cleared twice, then refused: the third verify keeps it and says a manual clear is needed', async (t) => {
  await gateway(t);
  halt.clearHalt();
  heldStatus();
  t.after(noHeld);
  const { box, ctx, state } = mk(H.londonEpoch(2026, 9, 29, 10, 0));
  const gate = { parsed: { pending: { jobTitle: 'Chef', location: 'AB1' }, queueDepth: 3 } };
  for (let cycle = 1; cycle <= 2; cycle++) {
    halt.setHalt('screening gateway error', `cycle ${cycle}`, { blockedRun: true });
    box.clock += 2 * MIN;
    const pf = await wd.preflight(ctx, state, gate);
    assert.equal(pf.ok, true, `cycle ${cycle}: cleared`);
    assert.equal(halt.getHalt(), null);
  }
  halt.setHalt('screening gateway error', 'cycle 3', { blockedRun: true });
  box.clock += 2 * MIN;
  const pf = await wd.preflight(ctx, state, gate);
  assert.deepEqual([pf.ok, pf.reason], [false, 'halted']);
  const h = halt.getHalt();
  assert.equal(h.halted, true);
  assert.equal(h.reason, 'screening halt keeps returning');
  assert.match(h.remedy, /pipeline-halt-cli\.js clear/);
  assert.match(h.reason, /screening/i, 'still a screening halt: no unlock while it is up');
  // it stays, and the next verify is not before the long interval
  const probeAt = state.haltProbeAt;
  assert.ok(probeAt - box.clock >= C.FLAP_PROBE_MS - 1);
  box.clock += 2 * MIN;
  assert.equal((await wd.preflight(ctx, state, gate)).reason, 'halted');
  assert.equal(halt.getHalt().reason, 'screening halt keeps returning');
  // after the window the counting starts again
  box.clock += C.FLAP_WINDOW_MS + MIN;
  assert.equal((await wd.preflight(ctx, state, gate)).ok, true);
  assert.equal(halt.getHalt(), null);
});

test('clears with no held queue are never counted (a snippet outage or a key problem can recur as often as it likes)', async (t) => {
  await gateway(t);
  halt.clearHalt();
  noHeld();
  const { box, ctx, state } = mk(H.londonEpoch(2026, 9, 29, 10, 0));
  const gate = { parsed: { pending: { jobTitle: 'Chef', location: 'AB1' }, queueDepth: 3 } };
  for (let cycle = 1; cycle <= 5; cycle++) {
    halt.setHalt('screening gateway error', `cycle ${cycle}`, { blockedRun: true });
    box.clock += 2 * MIN;
    assert.equal((await wd.preflight(ctx, state, gate)).ok, true, `cycle ${cycle}`);
  }
  assert.deepEqual(state.heldClears, []);
});

test('a tick with no READY search still verifies the halt while a held queue waits, and does nothing when none waits', async (t) => {
  const gw = await gateway(t);
  halt.clearHalt();
  const { box, ctx, state } = mk(H.londonEpoch(2026, 9, 29, 10, 0));
  halt.setHalt('screening gateway error', 'outage', { blockedRun: true });
  box.clock += 2 * MIN;
  noHeld();
  assert.deepEqual(await wd.verifyHeldHalt(ctx, state), { checked: false }, 'no held queue: not its business');
  assert.equal(halt.getHalt().halted, true);
  assert.equal(gw.stats().requests.length, 0);
  heldStatus();
  t.after(noHeld);
  gw.setMode({ cv: '503' });
  const bad = await wd.verifyHeldHalt(ctx, state);
  assert.deepEqual([bad.checked, bad.ok], [true, false]);
  assert.equal(halt.getHalt().halted, true);
  assert.deepEqual(await wd.verifyHeldHalt(ctx, state), { checked: false }, 'rate limited to the verify interval');
  gw.setMode({ cv: 'ok' });
  box.clock += 2 * MIN;
  const good = await wd.verifyHeldHalt(ctx, state);
  assert.deepEqual([good.checked, good.ok], [true, true]);
  assert.equal(halt.getHalt(), null, 'cleared without any pending search');
});
