'use strict';
// run-lock.js: the global pipeline lock is derived from runs/*.json, with per-status maximum
// ages (20/5/30/60/60/30/30/10 min). Thresholds are part of the contract.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/home');

const home = H.makeHome('lock');
process.env.RESOURCER_HOME = home;
process.env.HERMES_HOME = home;
const runs = path.join(home, 'runs');
fs.mkdirSync(runs, { recursive: true });

const lock = require(path.join(H.SCRIPTS, 'run-lock.js'));
const { RUN_STATUS } = require(path.join(H.SCRIPTS, 'constants.js'));

function clearRuns() {
  for (const f of fs.readdirSync(runs)) fs.rmSync(path.join(runs, f), { force: true });
}
function put(name, obj) { H.writeJson(path.join(runs, name), obj); }

test.beforeEach(clearRuns);

test('thresholds are exactly the documented per-status ages', () => {
  assert.deepEqual(lock.STATUS_MAX_AGE, {
    phase1_initializing: 20,
    phase1_taking_over: 5,
    phase1_searching: 30,
    phase1_active: 60,
    phase1_running: 60,
    phase2_starting: 30,
    phase2_pushing: 30,
    phase1_complete: 10,
  });
});

test('no runs directory or an empty one means clear', () => {
  fs.rmSync(runs, { recursive: true, force: true });
  assert.deepEqual(lock.getActiveRuns(), []);
  assert.deepEqual(lock.checkGlobalLock(), { blocked: false, activeCount: 0 });
  fs.mkdirSync(runs, { recursive: true });
  assert.equal(lock.checkGlobalLock().blocked, false);
});

test('boundary: a status blocks just inside its max age and releases just outside', () => {
  const cases = Object.entries(lock.STATUS_MAX_AGE);
  for (const [status, max] of cases) {
    clearRuns();
    put('phase1-a.json', { id: 'a', status, jobTitle: 'Chef', location: 'LS1', updatedAt: H.minsAgo(max - 1) });
    assert.equal(lock.checkGlobalLock().blocked, true, `${status} at ${max - 1} min`);
    clearRuns();
    put('phase1-a.json', { id: 'a', status, jobTitle: 'Chef', location: 'LS1', updatedAt: H.minsAgo(max + 1) });
    assert.equal(lock.checkGlobalLock().blocked, false, `${status} at ${max + 1} min`);
  }
});

test('terminal and unknown statuses never block', () => {
  for (const status of ['phase1_abandoned', 'complete', 'error', 'phase1_stale', 'whatever']) {
    put(`phase1-${status}.json`, { id: status, status, updatedAt: H.minsAgo(0) });
  }
  assert.equal(lock.checkGlobalLock().blocked, false);
});

test('updatedAt falls back to startedAt; a file with neither is treated as active', () => {
  put('phase1-s.json', { id: 's', status: RUN_STATUS.RUNNING, startedAt: H.minsAgo(61) });
  assert.equal(lock.checkGlobalLock().blocked, false);
  clearRuns();
  put('phase1-n.json', { id: 'n', status: RUN_STATUS.RUNNING });
  const r = lock.checkGlobalLock();
  assert.equal(r.blocked, true);
  assert.equal(r.blockingRun.updatedAt, null);
});

test('corrupt or non-object files are skipped', () => {
  fs.writeFileSync(path.join(runs, 'phase1-bad.json'), '{not json');
  fs.writeFileSync(path.join(runs, 'note.txt'), 'hello');
  put('phase1-ok.json', { id: 'ok', status: RUN_STATUS.SEARCHING, updatedAt: H.minsAgo(1) });
  const r = lock.checkGlobalLock();
  assert.equal(r.activeCount, 1);
  assert.equal(r.blockingRun.id, 'ok');
});

test('global lock reports the primary blocker and all active runs', () => {
  put('phase1-1.json', { id: 'one', status: RUN_STATUS.RUNNING, jobTitle: 'Chef', location: 'LS1', updatedAt: H.minsAgo(1) });
  put('phase1-2.json', { id: 'two', status: RUN_STATUS.PHASE2_PUSH, job_title: 'Bar', location: 'M1', updatedAt: H.minsAgo(1) });
  const r = lock.checkGlobalLock();
  assert.equal(r.blocked, true);
  assert.equal(r.activeCount, 2);
  assert.equal(r.activeRuns.length, 2);
  assert.equal(r.blockingRun.id, r.activeRuns[0].id);
  assert.equal(r.activeRuns.find(x => x.id === 'two').jobTitle, 'Bar', 'job_title alias is read');
});

test('skipFileBasename excludes the caller\'s own bridge file', () => {
  put('phase1-own.json', { id: 'own', status: RUN_STATUS.INITIALIZING, updatedAt: H.minsAgo(1) });
  assert.equal(lock.checkGlobalLock().blocked, true);
  assert.equal(lock.checkGlobalLock(undefined, { skipFileBasename: 'phase1-own.json' }).blocked, false);
  put('phase1-other.json', { id: 'other', status: RUN_STATUS.INITIALIZING, updatedAt: H.minsAgo(1) });
  assert.equal(lock.checkGlobalLock(undefined, { skipFileBasename: 'phase1-own.json' }).blockingRun.id, 'other');
});

test('phase1_complete is released once a matching run-*.json shows complete', () => {
  const ts = '2026-09-29-101500';
  put(`phase1-${ts}.json`, { id: ts, status: RUN_STATUS.COMPLETE, updatedAt: H.minsAgo(1) });
  assert.equal(lock.checkGlobalLock().blocked, true);
  put(`run-${ts}.json`, { status: 'complete' });
  assert.equal(lock.checkGlobalLock().blocked, false);
  // a run file that is not complete does not release it
  clearRuns();
  put(`phase1-${ts}.json`, { id: ts, status: RUN_STATUS.COMPLETE, updatedAt: H.minsAgo(1) });
  put(`run-${ts}.json`, { status: 'running' });
  assert.equal(lock.checkGlobalLock().blocked, true);
});

test('per-territory lock matches title and location case-insensitively', () => {
  put('phase1-t.json', { id: 't', status: RUN_STATUS.RUNNING, jobTitle: 'Sous Chef', location: 'LS1', updatedAt: H.minsAgo(1) });
  assert.equal(lock.checkRunLock('sous chef', ' ls1 ').blocked, true);
  assert.equal(lock.checkRunLock('Sous Chef', 'LS2').blocked, false);
  assert.equal(lock.checkRunLock('Chef', 'LS1').blocked, false);
  const hit = lock.checkRunLock('Sous Chef', 'LS1');
  assert.equal(hit.blockingRun.id, 't');
});

test('checkRunLockAgainst uses a pre-computed active list', () => {
  const active = [{ id: 'x', jobTitle: 'Chef', location: 'M1' }];
  assert.equal(lock.checkRunLockAgainst(active, 'chef', 'm1').blocked, true);
  assert.equal(lock.checkRunLockAgainst(active, 'chef', 'm2').blocked, false);
  assert.equal(lock.checkRunLockAgainst([], 'chef', 'm1').blocked, false);
});

test.describe('CLI', () => {
  const cli = (args) => H.run('scripts/run-lock.js', args, { home });

  test('--global exits 0 when clear and 2 when blocked, printing JSON', () => {
    let r = cli(['--global']);
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), { blocked: false, activeCount: 0 });
    put('phase1-c.json', { id: 'c', status: RUN_STATUS.RUNNING, updatedAt: H.minsAgo(1) });
    r = cli(['--global']);
    assert.equal(r.status, 2);
    assert.equal(JSON.parse(r.stdout).blockingRun.id, 'c');
    r = cli(['--global', '--skip-file=phase1-c.json']);
    assert.equal(r.status, 0);
  });

  test('--check needs both fields, then exits 0/2', () => {
    assert.equal(cli(['--check', 'JOB_TITLE=Chef']).status, 1);
    put('phase1-c.json', { id: 'c', status: RUN_STATUS.RUNNING, jobTitle: 'Chef', location: 'LS1', updatedAt: H.minsAgo(1) });
    assert.equal(cli(['--check', 'JOB_TITLE=Chef', 'LOCATION=LS1']).status, 2);
    assert.equal(cli(['--check', 'JOB_TITLE=Chef', 'LOCATION=LS9']).status, 0);
  });

  test('no arguments lists active runs; --help exits 0', () => {
    put('phase1-c.json', { id: 'c', status: RUN_STATUS.RUNNING, updatedAt: H.minsAgo(1) });
    const r = cli([]);
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).activeRuns.length, 1);
    const h = cli(['--help']);
    assert.equal(h.status, 0);
    assert.match(h.stdout, /--global/);
  });
});
