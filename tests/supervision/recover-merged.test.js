'use strict';
// Review finding: recovery of a killed both-source Phase 2 pushed only the Caterer approved-queue and stranded the Reed
// candidates of the merged queue. recover-stranded-phase1.js now finds the merged queue of the same title and location.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./_helpers');

const SCRIPT = path.join(H.SRC_SCRIPTS, 'recover-stranded-phase1.js');
const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const put = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj));

function scene(t, over) {
  const o = Object.assign({ sources: 'both', status: 'phase2_starting', mergedAgeMin: 8, mergedTitle: 'Chef', mergedLocation: 'LS1', results: null, merged: true }, over);
  const home = H.mkHome(t, 'recmerged');
  fs.writeFileSync(path.join(home, 'scripts', 'process-approved-queue.js'),
    "const fs=require('fs'),path=require('path');fs.appendFileSync(path.join(process.env.RESOURCER_HOME,'stub-calls.txt'),path.basename(process.argv[2])+'\\n');setTimeout(()=>{},1500);\n");
  const ts = '2026-09-29-100000';
  const status = path.join(home, 'runs', `phase1-${ts}.json`);
  put(status, { id: `phase1-${ts}`, status: o.status, jobTitle: 'Chef', location: 'LS1', sources: o.sources, startedAt: iso(30), updatedAt: iso(10), phase2Status: 'running' });
  put(path.join(home, 'downloads', `approved-queue-${ts}.json`), { jobTitle: 'Chef', location: 'LS1', phase1Stats: { pagesScraped: 2 }, candidates: [{ id: 'c1' }, { id: 'c2' }] });
  if (o.merged) {
    const mergedFile = path.join(home, 'downloads', 'merged-queue-2026-09-29-101500.json');
    put(mergedFile, { jobTitle: o.mergedTitle, location: o.mergedLocation, sources: 'both', phase1Stats: { caterer: {}, reed: {} }, candidates: [{ id: 'c1' }, { id: 'c2' }, { id: 'r1' }, { id: 'r2' }, { id: 'r3' }] });
    const when = new Date(Date.now() - o.mergedAgeMin * 60000);
    fs.utimesSync(mergedFile, when, when);
  }
  if (o.results) put(path.join(home, 'downloads', o.results), { completedAt: iso(1) });
  return { home, status };
}

const run = (home) => spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, RESOURCER_HOME: home }, encoding: 'utf8' });
const calls = (home) => { try { return fs.readFileSync(path.join(home, 'stub-calls.txt'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const waitCalls = async (home) => { for (let i = 0; i < 60 && calls(home).length === 0; i++) await new Promise((r) => setTimeout(r, 50)); return calls(home); };

test('a killed both-source Phase 2 is recovered on the merged queue, so the Reed candidates are pushed too', async (t) => {
  const { home } = scene(t);
  const r = run(home);
  assert.match(r.stdout, /RECOVERY_OK n=1 /);
  assert.deepEqual(await waitCalls(home), ['merged-queue-2026-09-29-101500.json'], 'not the Caterer-only approved queue');
});

test('a merged queue that Phase 2 already finished only closes the status file; nothing is pushed twice', async (t) => {
  const { home, status } = scene(t, { results: 'phase2-results-merged-queue-2026-09-29-101500.json' });
  const r = run(home);
  assert.doesNotMatch(r.stdout, /RECOVERY_OK/);
  assert.equal(JSON.parse(fs.readFileSync(status, 'utf8')).status, 'complete');
  assert.deepEqual(calls(home), []);
});

test('only a merged queue of the same title and location, written after the run began, is taken; anything else keeps the old behaviour', async (t) => {
  for (const over of [{ mergedTitle: 'Cook' }, { mergedLocation: 'M1' }, { mergedAgeMin: 45 }, { merged: false }, { sources: 'caterer' }]) {
    const { home } = scene(t, over);
    const r = run(home);
    assert.match(r.stdout, /RECOVERY_OK n=1 /, JSON.stringify(over));
    assert.deepEqual(await waitCalls(home), ['approved-queue-2026-09-29-100000.json'], JSON.stringify(over));
  }
});

test('a phase 1 that died (phase1_abandoned) is never matched to a merged queue', async (t) => {
  const { home } = scene(t, { status: 'phase1_abandoned' });
  const r = run(home);
  assert.match(r.stdout, /RECOVERY_OK n=1 /);
  assert.deepEqual(await waitCalls(home), ['approved-queue-2026-09-29-100000.json']);
});

test('Update C: a both-source Phase 2 that CV screening HELD (released to phase1_abandoned by the orphan sweep, phase2Hold kept) is recovered on the merged queue too, so the Reed half is not stranded', async (t) => {
  const { home, status } = scene(t, { status: 'phase1_abandoned' });
  const d = JSON.parse(fs.readFileSync(status, 'utf8'));
  d.phase2Hold = { reason: 'cv-screening-unavailable', at: iso(9) };
  put(status, d);
  assert.match(run(home).stdout, /RECOVERY_OK n=1 /);
  assert.deepEqual(await waitCalls(home), ['merged-queue-2026-09-29-101500.json']);
  // an abandoned phase 1 without a hold (a run killed before Phase 2) keeps the old behaviour: the Caterer queue
  const plain = scene(t, { status: 'phase1_abandoned' });
  assert.match(run(plain.home).stdout, /RECOVERY_OK n=1 /);
  assert.deepEqual(await waitCalls(plain.home), ['approved-queue-2026-09-29-100000.json']);
});
