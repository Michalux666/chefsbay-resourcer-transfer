'use strict';
// cull-ghost-phase1.js (15/5/20/30/30 min thresholds) and recover-stranded-phase1.js
// (stale phase1_complete + phase2Status pending, dead-lock takeover) with fake status files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./helpers/home');

const home = H.makeHome('maint');
process.env.RESOURCER_HOME = home;
process.env.HERMES_HOME = home;
const runs = path.join(home, 'runs');
const downloads = path.join(home, 'downloads');
const scripts = path.join(home, 'scripts');
const logs = path.join(home, 'logs');
for (const d of [runs, downloads, scripts]) fs.mkdirSync(d, { recursive: true });

// Stand-ins for the real Phase 2 entry points: record their argv, then exit.
fs.writeFileSync(path.join(scripts, 'process-approved-queue.js'),
  "require('fs').writeFileSync(process.argv[2] + '.marker', JSON.stringify(process.argv.slice(2)));\n");
fs.writeFileSync(path.join(scripts, 'run-pipeline.js'),
  "require('fs').writeFileSync(process.argv[3] + '.marker', JSON.stringify(process.argv.slice(2)));\n");

function clean() {
  for (const d of [runs, downloads, logs]) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f), { recursive: true, force: true });
  }
}
test.beforeEach(clean);

const putRun = (name, obj) => H.writeJson(path.join(runs, name), obj);
const readRun = (name) => H.readJson(path.join(runs, name));

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 50));
  }
  return null;
}

test.describe('cull-ghost-phase1', () => {
  const cull = () => H.run('scripts/cull-ghost-phase1.js', [], { home });
  // The order of ids follows directory order, which differs between filesystems.
  const idsOf = (out) => out.match(/ids=(\S+)/)[1].split(',').sort();
  const THRESHOLDS = { phase1_initializing: 15, phase1_taking_over: 5, phase1_searching: 20, phase1_running: 30, phase1_active: 30 };

  test('thresholds are exactly 15/5/20/30/30 minutes', () => {
    const { GHOST_THRESHOLDS_MIN } = require(path.join(H.SCRIPTS, 'cull-ghost-phase1.js'));
    assert.deepEqual(GHOST_THRESHOLDS_MIN, THRESHOLDS);
  });

  test('each in-flight status is kept just inside its threshold and culled just outside', () => {
    for (const [status, max] of Object.entries(THRESHOLDS)) {
      clean();
      putRun('phase1-fresh.json', { id: 'fresh', status, updatedAt: H.minsAgo(max - 1) });
      putRun('phase1-ghost.json', { id: 'ghost', status, updatedAt: H.minsAgo(max + 1) });
      const r = cull();
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^CULL_OK culled=1 kept=1 ids=ghost$/m, `${status}: ${r.stdout}`);
      assert.equal(readRun('phase1-fresh.json').status, status);
      const g = readRun('phase1-ghost.json');
      assert.equal(g.status, 'phase1_abandoned');
      const why = g.cullReason.match(/^ghost_cull: status=(\S+) stale=(\d+)min threshold=(\d+)min$/);
      assert.ok(why, g.cullReason);
      assert.deepEqual([why[1], Number(why[3])], [status, max]);
      assert.ok(Date.now() - Date.parse(g.updatedAt) < 60000, 'updatedAt refreshed');
      assert.equal(g.id, 'ghost');
    }
  });

  test('culling releases the global lock', () => {
    putRun('phase1-ghost.json', { id: 'ghost', status: 'phase1_running', updatedAt: H.minsAgo(45) });
    const lock = require(path.join(H.SCRIPTS, 'run-lock.js'));
    assert.equal(lock.checkGlobalLock().blocked, true, 'run-lock still trusts a 45 min old running file');
    cull();
    assert.equal(lock.checkGlobalLock().blocked, false);
  });

  test('terminal, complete, phase2 and non-phase1 files are never touched', () => {
    const old = H.minsAgo(600);
    const untouched = {
      'phase1-a.json': { id: 'a', status: 'phase1_complete', phase2Status: 'pending', updatedAt: old },
      'phase1-b.json': { id: 'b', status: 'complete', updatedAt: old },
      'phase1-c.json': { id: 'c', status: 'error', updatedAt: old },
      'phase1-d.json': { id: 'd', status: 'phase1_abandoned', updatedAt: old },
      'phase1-e.json': { id: 'e', status: 'phase2_pushing', updatedAt: old },
      'phase1-f.json': { id: 'f', status: 'phase1_stale', updatedAt: old },
      'run-g.json': { id: 'g', status: 'phase1_running', updatedAt: old },
      'phase1-h.json.run-lock': { pid: 1, status: 'phase1_running', updatedAt: old },
    };
    for (const [n, o] of Object.entries(untouched)) putRun(n, o);
    const before = Object.fromEntries(Object.keys(untouched).map(n => [n, fs.readFileSync(path.join(runs, n), 'utf8')]));
    const r = cull();
    assert.match(r.stdout, /^CULL_OK culled=0 kept=0$/m);
    for (const n of Object.keys(untouched)) assert.equal(fs.readFileSync(path.join(runs, n), 'utf8'), before[n], n);
  });

  test('startedAt is used when updatedAt is missing; no timestamps at all counts as a ghost', () => {
    putRun('phase1-a.json', { id: 'a', status: 'phase1_running', startedAt: H.minsAgo(40) });
    putRun('phase1-b.json', { id: 'b', status: 'phase1_running', startedAt: H.minsAgo(5) });
    putRun('phase1-c.json', { id: 'c', status: 'phase1_running' });
    putRun('phase1-d.json', { id: 'd', status: 'phase1_running', updatedAt: 'not a date' });
    const r = cull();
    assert.match(r.stdout, /^CULL_OK culled=3 kept=1 ids=/m);
    assert.deepEqual(idsOf(r.stdout), ['a', 'c', 'd']);
    assert.equal(readRun('phase1-b.json').status, 'phase1_running');
  });

  test('corrupt files and files without a status are skipped', () => {
    fs.writeFileSync(path.join(runs, 'phase1-bad.json'), '{nope');
    putRun('phase1-nostatus.json', { id: 'x' });
    const r = cull();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^CULL_OK culled=0 kept=0$/m);
  });

  test('no runs directory: CULL_OK culled=0 kept=0 and exit 0', () => {
    fs.rmSync(runs, { recursive: true, force: true });
    const r = cull();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^CULL_OK culled=0 kept=0$/m);
    fs.mkdirSync(runs, { recursive: true });
  });

  test('the id falls back to the file name and several ids are comma separated', () => {
    putRun('phase1-a.json', { status: 'phase1_initializing', updatedAt: H.minsAgo(30) });
    putRun('phase1-b.json', { id: 'bee', status: 'phase1_searching', updatedAt: H.minsAgo(30) });
    const r = cull();
    assert.match(r.stdout, /^CULL_OK culled=2 kept=0 ids=/m);
    assert.deepEqual(idsOf(r.stdout), ['bee', 'phase1-a']);
  });

  test('cull also runs stranded recovery and reports RECOVERY_OK', async () => {
    const ts = '2026-09-29-101500';
    putRun(`phase1-${ts}.json`, { id: `phase1-${ts}`, status: 'phase1_complete', phase2Status: 'pending', sources: 'caterer', startedAt: H.minsAgo(30), updatedAt: H.minsAgo(30) });
    const queue = path.join(downloads, `approved-queue-${ts}.json`);
    H.writeJson(queue, []);
    const r = cull();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^CULL_OK culled=0 kept=0$/m);
    const rec = r.stdout.match(/^RECOVERY_OK n=1 (\S+)\(pid=(\d+),mode=process-approved-queue\)$/m);
    assert.ok(rec, r.stdout);
    assert.equal(rec[1], `phase1-${ts}`);
    assert.ok(await waitFor(() => fs.existsSync(queue + '.marker')), 'the Phase 2 stand-in was started');
  });

  test('--help exits 0 and changes nothing', () => {
    putRun('phase1-a.json', { id: 'a', status: 'phase1_running', updatedAt: H.minsAgo(99) });
    const r = H.run('scripts/cull-ghost-phase1.js', ['--help'], { home });
    assert.equal(r.status, 0);
    assert.equal(readRun('phase1-a.json').status, 'phase1_running');
  });
});

test.describe('recover-stranded-phase1', () => {
  const { recoverStranded } = require(path.join(H.SCRIPTS, 'recover-stranded-phase1.js'));
  const TS = '2026-09-29-101500';
  const statusName = `phase1-${TS}.json`;
  const stranded = (extra = {}) => ({
    id: `phase1-${TS}`, status: 'phase1_complete', phase2Status: 'pending', sources: 'caterer',
    startedAt: H.minsAgo(40), updatedAt: H.minsAgo(30), ...extra,
  });
  const queuePath = path.join(downloads, `approved-queue-${TS}.json`);
  const setup = (obj, { queue = true } = {}) => {
    putRun(statusName, obj);
    if (queue) H.writeJson(queuePath, [{ id: 1 }]);
  };
  const deadPid = () => {
    const r = spawnSync(process.execPath, ['-e', '0'], { windowsHide: true });
    return r.pid;
  };

  test('sources=caterer starts process-approved-queue.js with the queue file; output goes to logs/', async () => {
    setup(stranded());
    const r = recoverStranded();
    assert.equal(r.recovered.length, 1);
    assert.deepEqual({ ...r.recovered[0], pid: typeof r.recovered[0].pid }, {
      id: `phase1-${TS}`, sources: 'caterer', pid: 'number', queue: `approved-queue-${TS}.json`, mode: 'process-approved-queue',
    });
    const marker = await waitFor(() => fs.existsSync(queuePath + '.marker') && fs.readFileSync(queuePath + '.marker', 'utf8'));
    assert.ok(marker, 'child ran');
    assert.deepEqual(JSON.parse(marker), [queuePath]);
    const logFiles = fs.readdirSync(logs).filter(f => f.startsWith('recover-'));
    assert.equal(logFiles.length, 1);
  });

  test('sources=both starts run-pipeline.js --status-file and needs no queue file', async () => {
    setup(stranded({ sources: 'both' }), { queue: false });
    const r = recoverStranded();
    assert.equal(r.recovered.length, 1);
    assert.equal(r.recovered[0].mode, 'run-pipeline');
    assert.equal(r.recovered[0].queue, null);
    const statusPath = path.join(runs, statusName);
    const marker = await waitFor(() => fs.existsSync(statusPath + '.marker') && fs.readFileSync(statusPath + '.marker', 'utf8'));
    assert.deepEqual(JSON.parse(marker), ['--status-file', statusPath]);
  });

  test('sources=caterer without an approved-queue file is left alone', () => {
    setup(stranded(), { queue: false });
    assert.deepEqual(recoverStranded(), { recovered: [] });
  });

  test('a run that is not yet 15 minutes stale is left alone (14 min) and one past it is recovered (16 min)', () => {
    setup(stranded({ updatedAt: H.minsAgo(14) }));
    assert.equal(recoverStranded().recovered.length, 0);
    setup(stranded({ updatedAt: H.minsAgo(16) }));
    assert.equal(recoverStranded().recovered.length, 1);
  });

  test('only status=phase1_complete with phase2Status=pending qualifies', () => {
    for (const obj of [
      stranded({ status: 'phase1_running' }),
      stranded({ phase2Status: 'done' }),
      stranded({ phase2Status: undefined }),
      stranded({ status: 'complete' }),
    ]) {
      setup(obj);
      assert.equal(recoverStranded().recovered.length, 0, JSON.stringify(obj));
    }
  });

  test('older than 7 days is never resurrected', () => {
    setup(stranded({ startedAt: new Date(Date.now() - 8 * 86400000).toISOString() }));
    assert.equal(recoverStranded().recovered.length, 0);
    setup(stranded({ startedAt: new Date(Date.now() - 6 * 86400000).toISOString() }));
    assert.equal(recoverStranded().recovered.length, 1);
  });

  test('a live run-lock (running pid, started recently) blocks recovery and is kept', () => {
    setup(stranded());
    const lockPath = path.join(runs, statusName + '.run-lock');
    H.writeJson(lockPath, { pid: process.pid, startedAt: Date.now() - 5 * 60000, statusFile: statusName });
    assert.equal(recoverStranded().recovered.length, 0);
    assert.ok(fs.existsSync(lockPath));
  });

  test('a dead-pid run-lock is removed and the run recovered', async () => {
    setup(stranded());
    const lockPath = path.join(runs, statusName + '.run-lock');
    H.writeJson(lockPath, { pid: deadPid(), startedAt: Date.now() - 20 * 60000 });
    const r = recoverStranded();
    assert.equal(r.recovered.length, 1);
    assert.ok(!fs.existsSync(lockPath));
    assert.ok(await waitFor(() => fs.existsSync(queuePath + '.marker')));
  });

  test('a lock older than 60 minutes is stale even if its pid answers (pid reuse after a restart)', () => {
    setup(stranded());
    const lockPath = path.join(runs, statusName + '.run-lock');
    H.writeJson(lockPath, { pid: process.pid, startedAt: Date.now() - 61 * 60000 });
    assert.equal(recoverStranded().recovered.length, 1);
    assert.ok(!fs.existsSync(lockPath));
  });

  test('an unreadable or pid-less lock counts as stale', () => {
    setup(stranded());
    const lockPath = path.join(runs, statusName + '.run-lock');
    fs.writeFileSync(lockPath, '{nope');
    assert.equal(recoverStranded().recovered.length, 1);
    assert.ok(!fs.existsSync(lockPath));
  });

  test('no runs directory gives an empty result; the CLI prints RECOVERY_NONE / RECOVERY_OK and exits 0', async () => {
    fs.rmSync(runs, { recursive: true, force: true });
    assert.deepEqual(recoverStranded(), { recovered: [] });
    fs.mkdirSync(runs, { recursive: true });
    let r = H.run('scripts/recover-stranded-phase1.js', [], { home });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'RECOVERY_NONE');
    setup(stranded());
    r = H.run('scripts/recover-stranded-phase1.js', [], { home });
    assert.equal(r.status, 0);
    const rec = r.stdout.trim().match(/^RECOVERY_OK n=1 (\S+)\(pid=(\d+),mode=process-approved-queue\)$/);
    assert.ok(rec, r.stdout);
    assert.equal(rec[1], `phase1-${TS}`);
    assert.ok(await waitFor(() => fs.existsSync(queuePath + '.marker')));
    assert.equal(H.run('scripts/recover-stranded-phase1.js', ['--help'], { home }).status, 0);
  });
});
