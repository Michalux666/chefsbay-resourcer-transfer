'use strict';
// recover-stranded-phase1.js: a phase 1 / Phase 2 killed mid-run leaves unlocked candidates that no later run would push.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', 'resourcer', 'scripts', 'recover-stranded-phase1.js');

function mkHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-int-'));
  for (const d of ['runs', 'downloads', 'scripts', 'logs', 'outbox']) fs.mkdirSync(path.join(home, d), { recursive: true });
  // stand-in for Phase 2: records its argument, stays alive a moment like a real run
  fs.writeFileSync(path.join(home, 'scripts', 'process-approved-queue.js'),
    "const fs=require('fs'),path=require('path');fs.appendFileSync(path.join(process.env.RESOURCER_HOME,'stub-calls.txt'),process.argv[2]+String.fromCharCode(10));setTimeout(()=>{},2500);\n");
  return home;
}

const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const put = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj));
const get = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function scene(home, over) {
  const o = Object.assign({ ts: '2026-09-29-100000', status: 'phase1_abandoned', ageMin: 10, queue: { searchDate: '2026-09-29', jobTitle: 'Chef', location: 'LS1', candidates: [{ id: '1' }] } }, over);
  const status = path.join(home, 'runs', `phase1-${o.ts}.json`);
  put(status, { id: `phase1-${o.ts}`, status: o.status, jobTitle: 'Chef', location: 'LS1', sources: 'caterer', startedAt: iso(o.ageMin + 5), updatedAt: iso(o.ageMin), phase2Status: null });
  const queue = path.join(home, 'downloads', `approved-queue-${o.ts}.json`);
  if (o.queue) put(queue, o.queue);
  return { status, queue };
}

const run = (home) => spawnSync(process.execPath, [SCRIPT], { env: Object.assign({}, process.env, { RESOURCER_HOME: home }), encoding: 'utf8' });
const stubCalls = (home) => { try { return fs.readFileSync(path.join(home, 'stub-calls.txt'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const alerts = (home) => { try { return fs.readFileSync(path.join(home, 'outbox', 'alerts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
// The stand-in Phase 2 child outlives the test for a moment and holds the directory (Windows refuses to delete it).
const removeHome = async (home) => {
  for (let i = 0; ; i += 1) {
    try { fs.rmSync(home, { recursive: true, force: true }); return; } catch (e) {
      if (i >= 40) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
};
const waitFile = async (fn) => { for (let i = 0; i < 60; i += 1) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

test('a checkpoint queue of a killed phase 1 is marked incomplete and handed to Phase 2 once; the running child blocks a second start', async () => {
  const home = mkHome();
  try {
    const { status, queue } = scene(home);
    const r = run(home);
    assert.match(r.stdout, /RECOVERY_OK n=1 phase1-2026-09-29-100000\(pid=\d+,mode=process-approved-queue\)/);
    assert.ok(await waitFile(() => stubCalls(home).length === 1));
    assert.deepEqual(stubCalls(home), [queue]);
    assert.deepEqual(get(queue).phase1Stats, { incomplete: 'run-interrupted' });
    assert.equal(get(queue).candidates.length, 1);
    const s = get(status);
    assert.equal(s.phase2Recovery.attempts, 1);
    assert.ok(s.phase2Recovery.pid > 0);
    assert.deepEqual(alerts(home).map((a) => `${a.severity}:${a.key}`), ['info:stranded-recovered']);
    assert.match(run(home).stdout, /RECOVERY_NONE/, 'the recovery child is still alive: no second start');
    assert.equal(stubCalls(home).length, 1);
  } finally { await removeHome(home); }
});

test('a complete queue of a killed Phase 2 is handed over unchanged (its territory and pending search are Phase 2 business)', async () => {
  const home = mkHome();
  try {
    const q = { searchDate: '2026-09-29', jobTitle: 'Chef', location: 'LS1', phase1Stats: { pagesScraped: 3, phase1CompletedAt: iso(12) }, candidates: [{ id: '1' }, { id: '2' }] };
    const { queue } = scene(home, { status: 'phase2_starting', queue: q });
    assert.match(run(home).stdout, /RECOVERY_OK n=1/);
    assert.ok(await waitFile(() => stubCalls(home).length === 1));
    assert.deepEqual(get(queue), q);
  } finally { await removeHome(home); }
});

test('nothing to recover: too young, no candidates, no queue, Phase 2 already finished, live statuses', () => {
  const home = mkHome();
  try {
    scene(home, { ts: '2026-09-29-100001', ageMin: 1 });
    scene(home, { ts: '2026-09-29-100002', queue: { candidates: [] } });
    scene(home, { ts: '2026-09-29-100003', queue: null });
    scene(home, { ts: '2026-09-29-100005', status: 'phase1_running' });
    scene(home, { ts: '2026-09-29-100006', status: 'complete' });
    const done = scene(home, { ts: '2026-09-29-100004' });
    put(path.join(home, 'downloads', 'phase2-results-2026-09-29-100004.json'), { completedAt: iso(9), new: 1 });
    const r = run(home);
    assert.match(r.stdout, /RECOVERY_NONE/);
    assert.deepEqual(stubCalls(home), []);
    const s = get(done.status);
    assert.equal(s.status, 'complete', 'a finished Phase 2 only needed its status file repaired');
    assert.equal(s.phase2Complete, true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('after three failed recoveries it stops and says so once', () => {
  const home = mkHome();
  try {
    const { status } = scene(home);
    const s = get(status);
    s.phase2Recovery = { attempts: 3, pid: 999999, at: iso(30) };
    put(status, s);
    assert.match(run(home).stdout, /RECOVERY_NONE/);
    assert.match(run(home).stdout, /RECOVERY_NONE/);
    assert.deepEqual(stubCalls(home), []);
    const a = alerts(home);
    assert.equal(a.length, 1);
    assert.equal(a[0].key, 'stranded-unrecoverable');
    assert.equal(a[0].severity, 'warn');
    assert.equal(get(status).phase2Recovery.gaveUp, true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
