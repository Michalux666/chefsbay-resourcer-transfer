'use strict';
// Regression test: a both-source queue that CV screening HELD must be recovered on ITS OWN merged queue, also when a LATER run of the
// same territory (the "extra run" of K-CV13, started as soon as the halt cleared) wrote a NEWER merged queue (empty: its candidates were already known).
// Without the pin (phase2Hold.queue) findMergedQueueFor picks the newest merged queue by mtime, sees an empty one and skips the held run, or (when that
// run's results exist) flips the held status file to complete.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('../supervision/_helpers');

const SCRIPT = path.join(H.SRC_SCRIPTS, 'recover-stranded-phase1.js');
const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const put = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj));
const run = (home) => spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, RESOURCER_HOME: home }, encoding: 'utf8' });
const calls = (home) => { try { return fs.readFileSync(path.join(home, 'stub-calls.txt'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const waitCalls = async (home) => { for (let i = 0; i < 60 && calls(home).length === 0; i++) await new Promise((r) => setTimeout(r, 50)); return calls(home); };

function scene(t, { withResultsOfNewer }) {
  const home = H.mkHome(t, 'recnewer');
  fs.writeFileSync(path.join(home, 'scripts', 'process-approved-queue.js'),
    "const fs=require('fs'),path=require('path');fs.appendFileSync(path.join(process.env.RESOURCER_HOME,'stub-calls.txt'),path.basename(process.argv[2])+'\\n');setTimeout(()=>{},1500);\n");
  const ts = '2026-09-29-100000';
  const status = path.join(home, 'runs', `phase1-${ts}.json`);
  put(status, { id: `phase1-${ts}`, status: 'phase1_abandoned', jobTitle: 'Chef', location: 'LS1', sources: 'both', startedAt: iso(30), updatedAt: iso(10), phase2Status: 'running',
    phase2Hold: { reason: 'cv-screening-unavailable', at: iso(9), queue: 'merged-queue-2026-09-29-101500.json' } });
  put(path.join(home, 'downloads', `approved-queue-${ts}.json`), { jobTitle: 'Chef', location: 'LS1', phase1Stats: { pagesScraped: 2 }, candidates: [{ id: 'c1' }, { id: 'c2' }] });
  const mk = (name, cands, ageMin) => {
    const f = path.join(home, 'downloads', name);
    put(f, { jobTitle: 'Chef', location: 'LS1', sources: 'both', phase1Stats: { caterer: {}, reed: {} }, candidates: cands });
    const when = new Date(Date.now() - ageMin * 60000); fs.utimesSync(f, when, when);
  };
  mk('merged-queue-2026-09-29-101500.json', [{ id: 'c1' }, { id: 'c2' }, { id: 'r1' }, { id: 'r2' }], 9); // the held run's own queue
  mk('merged-queue-2026-09-29-102000.json', [], 4); // the extra run of the same territory: nothing new, newer
  if (withResultsOfNewer) put(path.join(home, 'downloads', 'phase2-results-merged-queue-2026-09-29-102000.json'), { completedAt: iso(3) });
  return { home, status };
}

test('the held queue is recovered on its own merged queue although a newer, empty merged queue of the same territory exists', async (t) => {
  const { home } = scene(t, { withResultsOfNewer: false });
  assert.match(run(home).stdout, /RECOVERY_OK n=1 /);
  assert.deepEqual(await waitCalls(home), ['merged-queue-2026-09-29-101500.json']);
});

test('the held status file is NOT flipped to complete because the newer run finished: the held queue still gets pushed', async (t) => {
  const { home, status } = scene(t, { withResultsOfNewer: true });
  run(home);
  assert.deepEqual(await waitCalls(home), ['merged-queue-2026-09-29-101500.json']);
  const d = JSON.parse(fs.readFileSync(status, 'utf8'));
  assert.notEqual(d.status, 'complete', 'held and unpushed, never complete');
});
