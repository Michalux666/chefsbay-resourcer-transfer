'use strict';
// Update C, finding F1: a queue that CV screening HELD (process-approved-queue.js left phase2Hold in the status file) is not retried while the screening
// halt is up (a retry could only hold again, each time with a run record and an alert); once the supervisor has cleared the halt, because the CV route
// answered its canary, the next recovery pass completes it. A phase 2 that was interrupted for any other reason is recovered as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./_helpers');

const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const put = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj)); };

function scene(t, o) {
  const home = H.mkHome(t, 'recheld');
  // the real scripts (recovery loads the halt module and the CV stage), with Phase 2 replaced by a recorder
  fs.cpSync(H.SRC_SCRIPTS, path.join(home, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(home, 'scripts', 'process-approved-queue.js'),
    "const fs=require('fs'),path=require('path');fs.appendFileSync(path.join(process.env.RESOURCER_HOME,'stub-calls.txt'),path.basename(process.argv[2])+String.fromCharCode(10));setTimeout(()=>{},800);");
  const ts = '2026-09-29-100000';
  put(path.join(home, 'runs', `phase1-${ts}.json`), Object.assign({ id: `phase1-${ts}`, status: 'phase2_starting', jobTitle: 'Chef', location: 'LS1', sources: 'caterer', startedAt: iso(30), updatedAt: iso(10), phase2Status: 'running' }, o.status));
  put(path.join(home, 'downloads', `approved-queue-${ts}.json`), { jobTitle: 'Chef', location: 'LS1', phase1Stats: { pagesScraped: 2 }, candidates: [{ id: 'c1' }, { id: 'c2' }] });
  if (o.halt) put(path.join(home, 'runtime', 'pipeline-halt.json'), { halted: true, reason: o.halt, since: iso(5) });
  return home;
}

const HELD = { phase2Hold: { reason: 'cv-screening-unavailable', at: new Date().toISOString() } };
const run = (home) => spawnSync(process.execPath, [path.join(home, 'scripts', 'recover-stranded-phase1.js')], { env: { ...process.env, RESOURCER_HOME: home }, encoding: 'utf8' });
const calls = (home) => { try { return fs.readFileSync(path.join(home, 'stub-calls.txt'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const waitCalls = async (home) => { for (let i = 0; i < 60 && calls(home).length === 0; i++) await new Promise((r) => setTimeout(r, 50)); return calls(home); };

test('a held queue waits for the screening halt to clear: no recovery, no alert, no attempt used while it is up', async (t) => {
  const home = scene(t, { status: HELD, halt: 'screening gateway error' });
  for (let i = 0; i < 3; i++) {
    const r = run(home);
    assert.match(r.stdout, /RECOVERY_NONE/, r.stdout + r.stderr);
  }
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(calls(home), []);
  const status = JSON.parse(fs.readFileSync(path.join(home, 'runs', 'phase1-2026-09-29-100000.json'), 'utf8'));
  assert.equal(status.phase2Recovery, undefined, 'no attempt was recorded');
  assert.ok(!fs.existsSync(path.join(home, 'outbox', 'alerts.jsonl')), 'no stranded-recovered alert');
});

test('once the halt is cleared the next pass completes the held queue', async (t) => {
  const home = scene(t, { status: HELD, halt: 'screening gateway error' });
  assert.match(run(home).stdout, /RECOVERY_NONE/);
  fs.rmSync(path.join(home, 'runtime', 'pipeline-halt.json'));
  const r = run(home);
  assert.match(r.stdout, /RECOVERY_OK n=1 /);
  assert.deepEqual(await waitCalls(home), ['approved-queue-2026-09-29-100000.json']);
});

test('a halt that is not about screening, and an interrupted Phase 2 that was not held, are recovered as before', async (t) => {
  const other = scene(t, { status: HELD, halt: 'migration in progress' });
  assert.match(run(other).stdout, /RECOVERY_OK n=1 /);
  assert.deepEqual(await waitCalls(other), ['approved-queue-2026-09-29-100000.json']);
  const notHeld = scene(t, { status: {}, halt: 'screening gateway error' });
  assert.match(run(notHeld).stdout, /RECOVERY_OK n=1 /, 'no phase2Hold: a killed Phase 2, the snippet halt is not its business');
  assert.deepEqual(await waitCalls(notHeld), ['approved-queue-2026-09-29-100000.json']);
});
