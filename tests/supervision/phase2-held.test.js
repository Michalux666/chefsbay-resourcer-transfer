'use strict';
// Update C, findings F1 and F9 on the supervision side.
//   F9  a run whose Phase 2 was HELD by CV screening ends with runner exit 14: recorded as held (neither a success nor a failure), its pending search is
//       given back at once, and the supervisor neither counts a failure, nor quarantines the territory, nor raises the run-failures alert, nor backs off for long.
//   F1  the halt a held queue raises only clears when the deep check passes, and the deep check asks the CV route while CV_SCREEN is on: four supervisor ticks
//       against a refusing CV route (snippet route healthy) keep ONE halt, one halt alert, one critical CV alert and start no run; the first tick after the
//       route recovers resumes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./_helpers');
const { startFakeGateway } = require('../fake-gateway/server');

H.installNetworkGuard();
const HOME = H.mkHome(null, 'phase2held');
process.env.RESOURCER_HOME = HOME;
process.env.HERMES_HOME = HOME;
process.env.RESOURCER_ENV_FILE = path.join(HOME, 'none.env');
process.env.AI_GATEWAY_API_KEY = 'fake-test-key';
process.env.SCREEN_ENGINE = 'jev_only';
process.env.SCREEN_BACKOFF_BASE_MS = '2';
delete process.env.CV_SCREEN;
fs.mkdirSync(path.join(HOME, 'config'), { recursive: true });
fs.copyFileSync(path.join(H.REPO, 'resourcer', 'config', 'cv-screening.json'), path.join(HOME, 'config', 'cv-screening.json'));

const runner = require(path.join(H.SRC_SCRIPTS, 'watchdog-runner.js'));
const wd = require(path.join(H.SRC_SCRIPTS, 'pipeline-watchdog.js'));
const tick = require(path.join(H.SRC_SCRIPTS, 'lib', 'tick.js'));
const halt = require(path.join(H.SRC_SCRIPTS, 'lib', 'pipeline-halt.js'));
const health = require(path.join(H.SRC_SCRIPTS, 'lib', 'screening-health.js'));
const cvStage = require(path.join(H.SRC_SCRIPTS, 'lib', 'cv', 'phase2.js'));
const { EXIT } = runner;
const { C } = wd;

test.after(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------------------------- runner

test('mapPhase1Exit: phase1 exit 14 is HELD (runner exit 14, reason phase2-held); the other codes keep their meaning', () => {
  const m = (r) => runner.mapPhase1Exit(Object.assign({ code: 0, killed: false }, r));
  assert.deepEqual(m({ code: 14 }), { code: 14, event: 'phase2-held', reason: 'phase2-held' });
  assert.equal(EXIT.HELD, 14);
  assert.equal(m({ code: 0 }).code, EXIT.OK);
  assert.equal(m({ code: 2 }).code, EXIT.SESSION_STALE);
  assert.equal(m({ code: 13 }).code, EXIT.PHASE1_FAILED, 'only 14 is the hold');
  assert.equal(m({ code: 14, killed: true }).code, EXIT.KILLED, 'killed still wins');
  assert.equal(runner.faultless(14, 'phase2-held'), true, 'the territory is not at fault');
  assert.equal(runner.faultless(12, 'phase1-exit-5'), false);
});

function mkRunner(t, phase1, pendingExtra) {
  const home = H.mkHome(t, 'held-runner');
  const pendingPath = path.join(home, 'pending-searches', 'territory-7-x.json');
  H.writeJson(pendingPath, Object.assign({ jobTitle: 'Sous Chef', location: 'AB1', distance: 30, keywords: '', priority: 'high', sources: 'caterer', cvLimit: 25, requestedAt: '2026-09-29T09:00:00.000Z', spawnedAt: new Date().toISOString() }, pendingExtra));
  const ctx = runner.makeCtx({
    home, settleMs: 0, heartbeatMs: 50, log: () => {}, allowedSources: () => 'caterer',
    buildResultsUrl: () => ({ url: 'https://example.test/r?q=x', searchId: 's' }), browserLockWaitMs: 0,
    browserLock: { wait: async (owner) => ({ acquired: true, borrowed: false, reentrant: false, holder: { owner, pid: process.pid }, release: () => {} }) },
    ensureLoggedIn: async () => 'ok',
    exec: async (script, args) => {
      if (script === 'pending-gate.js' && args[0] === '--mark-spawned') return { code: 0, stdout: 'MARKED', stderr: '' };
      if (script === 'pending-gate.js') return { code: 0, stdout: JSON.stringify({ status: 'READY', file: 'territory-7-x.json', filePath: pendingPath, pending: { jobTitle: 'Sous Chef', location: 'AB1', distance: 30, keywords: '', priority: 'high', sources: 'caterer', cvLimit: 25 }, queueDepth: 1 }), stderr: '' };
      if (script === 'create-init-status.js') {
        const f = path.join(home, 'runs', 'phase1-2026-09-29-1000.json');
        H.writeJson(f, { id: 'phase1-2026-09-29-1000', status: 'phase1_initializing', jobTitle: 'Sous Chef', location: 'AB1', updatedAt: new Date().toISOString() });
        return { code: 0, stdout: `INIT_FILE:${f}`, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    runPhase1: async (c, paramsFile, fd) => { fs.writeSync(fd, 'CONSOLE\n'); return phase1; },
  });
  return { home, ctx, pendingPath, files: tick.runtimeFiles(home) };
}

test('runner: a held run is recorded as held (exit 14, reason phase2-held) and its pending search is given back at once; a plain phase1 failure keeps the claim', async (t) => {
  const held = mkRunner(t, { code: 14, killed: false, aborted: null });
  const res = await runner.runOnce(held.ctx, ['--from-gate']);
  assert.equal(res.code, 14);
  const last = H.readJson(held.files.lastRun);
  assert.equal(last.exitCode, 14);
  assert.equal(last.reason, 'phase2-held');
  assert.equal(H.readJson(held.pendingPath).spawnedAt, undefined, 'the claim is released: the territory is offered again as soon as the halt clears');
  const failed = mkRunner(t, { code: 12, killed: false, aborted: null });
  assert.equal((await runner.runOnce(failed.ctx, ['--from-gate'])).code, 12);
  assert.ok(H.readJson(failed.pendingPath).spawnedAt, 'a failure the territory caused keeps its claim (the rotation)');
});

// ---------------------------------------------------------------------------------------------- watchdog

function mkWd(t, o) {
  const home = H.mkHome(t, 'held-wd');
  const notify = H.collectNotifier();
  const ctx = wd.makeCtx(Object.assign({ home, now: () => 1000000000000, log: () => {}, notify, dbFit: () => ({ ok: true }), slowChecks: async () => {}, diskGuard: () => ({}) }, o));
  return { home, ctx, notify };
}

test('a held run is recorded as held: no failure count, no quarantine, no run-failures alert, no long back-off, and it is not a success either', (t) => {
  const e = mkWd(t);
  const pending = path.join(e.home, 'pending-searches', 'territory-1-x.json');
  H.pendingFile(e.home, 'territory-1-x.json', { location: 'AB1' });
  const state = wd.defaultState();
  state.consecutiveFailures = 2;
  state.failStreakSince = 12345;
  state.staleCooldownUntil = 0;
  const endedMs = 1000000000000;
  for (let n = 0; n < 6; n++) {
    wd.handleResult(e.ctx, state, { nonce: `h${n}`, exitCode: 14, reason: 'phase2-held', file: 'territory-1-x.json', endedAt: iso(endedMs + n * MIN), pool: 40, approved: 6, skippedDb: 30, errors: 0, elapsedSec: 300 });
  }
  assert.equal(state.consecutiveFailures, 2, 'neither raised nor reset');
  assert.equal(state.failStreakSince, 12345, 'the failure streak is not touched');
  assert.equal(state.staleCooldownUntil, 0, 'no session back-off');
  assert.equal(state.launchNotBefore, endedMs + 5 * MIN + C.POLL_MS, 'only the ordinary one-minute pause');
  assert.deepEqual(e.notify.list, [], 'no alert: Phase 2 raised the halt and its one critical alert');
  assert.equal(H.readJson(pending).failedRuns, undefined, 'no failure counted against the territory');
  assert.equal(fs.existsSync(pending), true, 'never quarantined');
  assert.equal(state.recentRuns.length, 6);
  assert.deepEqual([state.recentRuns[5].exitCode, state.recentRuns[5].reason], [14, 'phase2-held'], 'recorded as held, with the numbers of the run');
  // three held runs with "pool equals DB skips" are not the never-screened pattern (that check only reads exit 0)
  const s2 = wd.defaultState();
  for (let n = 0; n < 3; n++) wd.handleResult(e.ctx, s2, { nonce: `n${n}`, exitCode: 14, reason: 'phase2-held', file: 'territory-1-x.json', endedAt: iso(endedMs + n * MIN), pool: 40, approved: 0, skippedDb: 40, errors: 1, elapsedSec: 100 });
  assert.deepEqual(e.notify.list, []);
  // and a real failure after them still counts normally
  wd.handleResult(e.ctx, s2, { nonce: 'f1', exitCode: 12, reason: 'phase1-exit-5', file: 'territory-1-x.json', endedAt: iso(endedMs + 9 * MIN), elapsedSec: 10 });
  assert.equal(s2.consecutiveFailures, 1);
});

// ---------------------------------------------------------------------------------------------- the whole supervision cycle against a refusing CV route

test('F1: a halt raised by the CV stage stays while the CV route refuses (snippet route healthy): four ticks, ONE halt, no resume, no run started; it clears on the first tick after the route answers', async (t) => {
  const gw = await startFakeGateway({ key: 'fake-test-key' });
  t.after(() => gw.close());
  process.env.SCREEN_GATEWAY_ORIGIN = gw.origin;
  process.env.CV_SCREEN = 'on';
  t.after(() => { delete process.env.CV_SCREEN; });
  halt.clearHalt();
  fs.rmSync(path.join(HOME, 'logs', 'errors.jsonl'), { force: true });
  const notify = H.collectNotifier();
  let clock = H.londonEpoch(2026, 9, 29, 10, 0);
  const ctx = wd.makeCtx({ home: HOME, now: () => clock, log: () => {}, notify, dbFit: () => ({ ok: true }), memAvailMb: () => 4000, screening: () => health });
  const state = wd.defaultState();
  const gate = { parsed: { pending: { jobTitle: 'Chef', location: 'AB1' }, queueDepth: 3 } };

  // Phase 2 of a run holds its queue: the CV route answers 503 to the stage's own requests, the snippet route is fine
  gw.setMode({ cv: '503' });
  const raised = cvStage.raiseOutage({ detail: 'HTTP 503: fake', jobTitle: 'Chef', location: 'AB1', runId: 'r1', held: 6, reasonKey: 'error', notify });
  assert.equal(raised.halted, true);
  const since = halt.getHalt().since;

  for (let i = 0; i < 4; i++) {
    clock += 2 * MIN; // past the one-minute verify interval: every tick runs the deep check
    const pf = await wd.preflight(ctx, state, gate);
    assert.deepEqual([pf.ok, pf.reason], [false, 'halted'], `tick ${i + 1}: no run starts`);
    assert.equal(halt.getHalt().halted, true, `tick ${i + 1}: still halted`);
    assert.equal(halt.getHalt().since, since, 'the same halt, never cleared and raised again');
  }
  const log = fs.readFileSync(path.join(HOME, 'logs', 'errors.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(log.filter((x) => x.context === 'pipeline_halted').length, 1, 'one halt entry');
  assert.equal(log.filter((x) => x.context === 'pipeline_resumed').length, 0, 'never resumed');
  assert.deepEqual(notify.list.filter((a) => a.severity === 'critical').map((a) => a.key), ['cv-screening-unavailable'], 'one critical CV alert; the halt alert goes through the halt module');
  const deepCalls = gw.stats().requests.filter((r) => r.questions.includes('relevance_0'));
  assert.equal(deepCalls.length, 4, 'one CV canary per verify, each a single request');

  // the CV route recovers: the next verify clears the halt and the queue resumes
  gw.setMode({ cv: 'ok' });
  clock += 2 * MIN;
  const back = await wd.preflight(ctx, state, gate);
  assert.equal(back.ok, true);
  assert.equal(halt.getHalt(), null);
  const log2 = fs.readFileSync(path.join(HOME, 'logs', 'errors.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(log2.filter((x) => x.context === 'pipeline_resumed').length, 1);
});

test('F1: with CV_SCREEN unset (shadow) the same halt clears on the snippet canary alone: shadow never keeps a halt and never asks the CV route', async (t) => {
  const gw = await startFakeGateway({ key: 'fake-test-key' });
  t.after(() => gw.close());
  process.env.SCREEN_GATEWAY_ORIGIN = gw.origin;
  delete process.env.CV_SCREEN;
  halt.clearHalt();
  gw.setMode({ cv: '503' });
  halt.setHalt('screening gateway error', 'earlier outage', { blockedRun: true });
  const ctx = wd.makeCtx({ home: HOME, now: () => H.londonEpoch(2026, 9, 29, 10, 0), log: () => {}, notify: H.collectNotifier(), dbFit: () => ({ ok: true }), memAvailMb: () => 4000, screening: () => health });
  const pf = await wd.preflight(ctx, wd.defaultState(), { parsed: { pending: { jobTitle: 'Chef', location: 'AB1' }, queueDepth: 1 } });
  assert.equal(pf.ok, true);
  assert.equal(halt.getHalt(), null);
  assert.equal(gw.stats().requests.filter((r) => r.questions.includes('relevance_0')).length, 0);
});

test('F3/F4: a halt raised for a broken criteria file clears only when the file is valid again (the cheap check refuses it, so no run starts and the halt is raised after two misses)', async (t) => {
  const gw = await startFakeGateway({ key: 'fake-test-key' });
  t.after(() => gw.close());
  process.env.SCREEN_GATEWAY_ORIGIN = gw.origin;
  process.env.CV_SCREEN = 'on';
  t.after(() => { delete process.env.CV_SCREEN; });
  halt.clearHalt();
  const cfgFile = path.join(HOME, 'config', 'cv-screening.json');
  const good = fs.readFileSync(cfgFile, 'utf8');
  t.after(() => fs.writeFileSync(cfgFile, good));
  fs.writeFileSync(cfgFile, '{ broken');
  let clock = H.londonEpoch(2026, 9, 29, 10, 0);
  const ctx = wd.makeCtx({ home: HOME, now: () => clock, log: () => {}, notify: H.collectNotifier(), dbFit: () => ({ ok: true }), memAvailMb: () => 4000, screening: () => health });
  const state = wd.defaultState();
  const gate = { parsed: { pending: { jobTitle: 'Chef', location: 'AB1' }, queueDepth: 1 } };
  clock += MIN;
  assert.deepEqual((await wd.preflight(ctx, state, gate)).reason, 'probe-miss', 'the first miss only holds this tick');
  clock += MIN;
  assert.deepEqual((await wd.preflight(ctx, state, gate)).reason, 'halted', 'the second raises the halt: before any browser run was started');
  assert.equal(halt.getHalt().reason, 'CV screening criteria invalid');
  assert.match(halt.getHalt().remedy, /Fix config\/cv-screening\.json/);
  assert.equal(gw.stats().requests.length, 0, 'decided from the local files: nothing was asked of the gateway');
  fs.writeFileSync(cfgFile, good);
  clock += MIN;
  assert.equal((await wd.preflight(ctx, state, gate)).ok, true, 'valid again: the cheap check passes, the deep check passes, the halt clears');
  assert.equal(halt.getHalt(), null);
});
