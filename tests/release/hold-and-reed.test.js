'use strict';
// The release joins two separately built updates: CV_SCREEN=on made safe (a Phase 2 that CV screening HELD) and the Reed first-page fix (a Reed half that
// failed or never ran). This file proves how they meet, against the REAL Phase 2 (process-approved-queue.run), the real territory map and run_results:
//
//   B  one results file and ONE run_results row carry both: the CV counters (cvRejected, cvScreen, skipped including the CV rejections) and the Reed
//      half (reedStatus, reedStats.status / failed / failureReason, errors 1), and they do not disturb each other.
//   C  a both-source queue that was HELD and is completed by the recovery on the Caterer queue alone (its Reed step never ran, there is no merged queue)
//      does not silently lose its Reed half: the run is recorded Reed not_run and the territory is marked Reed-pending with one automatic retry, so
//      tools/reed-catchup.js lists it. A both-source queue whose Reed step DID run (a merged queue) and a run that was never held keep the exact
//      earlier rules (a not_run neither sets nor clears the mark).
const P = require('../cv/helpers/phase2-run');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('../lifecycle/helpers/sqlite');
const { buildDeps } = require('../lifecycle/helpers/harness');
const { writeQueue } = require('../lifecycle/helpers/fixtures');
const { ws, R, state, card, writeCvFile, captureConsole, pq, halt, cvConfig } = P;
const territory = require('../../resourcer/scripts/territory-utils');
const catchup = require('../../tools/reed-catchup');

test.before(P.start);
test.after(P.stop);

const day = (offset) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const TODAY = day(0);
const TS = '2026-09-30T10-00-00';
const CATERER_QUEUE = `approved-queue-${TS}.json`;
const STATUS = `phase1-${TS}.json`;
const withDb = (fn) => { const db = new Database(ws.db, { timeout: 5000 }); try { return fn(db); } finally { db.close(); } };
const territoryRow = () => withDb((db) => db.prepare("SELECT * FROM territory_searches WHERE job_title = 'Chef' AND location = 'LS1'").get());
const runRows = () => withDb((db) => {
  try { return db.prepare('SELECT * FROM run_results ORDER BY completed_at').all(); } catch { return []; } // the table is created by the first run that writes a row
});

function scene({ ids, pendingSources = 'both', hold = false } = {}) {
  P.setup(ids);
  for (const id of ids) writeCvFile(id);
  fs.mkdirSync(ws.pending, { recursive: true });
  fs.writeFileSync(path.join(ws.pending, 'territory-5-20260930-1000.json'), JSON.stringify({ jobTitle: 'Chef', location: 'LS1', sources: pendingSources }));
  fs.mkdirSync(ws.runs, { recursive: true });
  fs.writeFileSync(path.join(ws.runs, STATUS), JSON.stringify({
    id: `phase1-${TS}`, status: 'phase1_complete', jobTitle: 'Chef', location: 'LS1', sources: 'both', phase2Status: 'pending',
    startedAt: new Date(Date.now() - 30 * 60000).toISOString(), updatedAt: new Date(Date.now() - 10 * 60000).toISOString(),
    ...(hold ? { phase2Hold: { reason: 'cv-screening-unavailable', at: new Date().toISOString() } } : {}),
  }));
  withDb((db) => db.prepare("UPDATE territory_searches SET priority = 'low', enabled = 1, next_run_date = ? WHERE job_title = 'Chef' AND location = 'LS1'").run(TODAY));
}

// One Phase 2 run on `queueFile` (already written) with the CV stage on or shadow, a scripted reviewer, Reed switched on.
async function phase2(queueFile, { mode = 'on', scenario = {}, reedOn = true } = {}) {
  const built = buildDeps(ws, { zoho: state.zoho });
  built.deps.cvScreenMode = () => mode;
  built.deps.cvConfig = () => cvConfig.load({ file: 'no-such-file.json' });
  built.deps.allowedSources = () => (reedOn ? 'both' : 'caterer');
  built.deps.upsertTerritory = (db, p) => territory.upsertTerritory(db, p);
  built.deps.cvScreen = async (req) => (scenario[String(req.cand.id)] || R.pass)();
  const cap = captureConsole();
  let res;
  try { res = await pq.run(queueFile, built.deps); } finally { cap.restore(); built.close(); }
  return { res, out: cap.lines };
}

const writeCaterer = (ids) => writeQueue(ws, CATERER_QUEUE, { searchDate: TODAY, candidates: ids.map((id) => card(id)) });
const resultsOf = (name) => ws.readJson(path.join(ws.downloads, name));

const FAILED = { pool: 0, pagesScraped: 0, inDb: 0, crossDedup: 0, rejected: 0, approved: 0, authFailed: false, authFailureReason: null, failed: true, failureKind: 'first_page', failureReason: 'HTTP 400 code 50010', errors: 1 };

test('B: one run carries the CV counters of a rejection AND a failed Reed half, in the results file and in the ONE run_results row', async () => {
  const ids = ['201', '202', '203'];
  scene({ ids });
  const merged = `merged-queue-${TS}.json`;
  fs.writeFileSync(path.join(ws.downloads, merged), JSON.stringify({
    searchDate: TODAY, jobTitle: 'Chef', location: 'LS1', distance: 20, activeWithin: 'month', keywords: '', sources: 'both', screeningModel: 'test-model',
    candidateCount: 40, creditsRemaining: 44000,
    phase1Stats: { caterer: { pagesScraped: 3, approved: 3, skippedDb: 30, skippedReview: 8, errors: 0, totalCandidatesSeen: 40 }, reed: FAILED },
    candidates: ids.map((id) => card(id)),
  }));
  const { res } = await phase2(path.join(ws.downloads, merged), { mode: 'on', scenario: { 202: () => R.reject(['under_qualified']) } });
  assert.equal(res.code, 0);
  const results = resultsOf(`phase2-results-merged-queue-${TS}.json`);
  // the CV side (update C)
  assert.equal(results.cvRejected, 1);
  assert.equal(results.cvScreen.rejected, 1);
  assert.equal(results.cvScreen.rejectedEarlier, 0);
  // the Reed side (update D)
  assert.equal(results.reedStatus, 'failed');
  assert.equal(results.reedStats.status, 'failed');
  assert.equal(results.reedStats.failed, true);
  assert.equal(results.reedStats.failureReason, 'HTTP 400 code 50010');
  assert.equal(results.reedStats.errors, 1);
  assert.equal(results.errors, 0, 'the run-level error count is untouched by the Reed failure');
  // the same facts in the dashboard's source
  const rows = runRows();
  assert.equal(rows.length, 1, 'one row for the one run');
  assert.equal(rows[0].skipped, (results.skipped || 0) + 1, 'skipped carries the CV rejection');
  assert.equal(rows[0].new_to_zoho, 2);
  const reed = JSON.parse(rows[0].reed_json);
  assert.deepEqual([reed.status, reed.failed, reed.errors], ['failed', true, 1]);
  assert.equal(JSON.parse(rows[0].caterer_json).pool, 40);
  // and the territory: searched for the Caterer half, Reed-pending for the lost half, the CV rejection counted as skipped
  const t = territoryRow();
  assert.equal(t.last_searched, TODAY);
  assert.equal(t.reed_pending_since, TODAY);
});

test('C: a held both-source queue completed on the Caterer queue alone records Reed not_run and marks the territory Reed-pending, so reed-catchup lists it', async () => {
  const ids = ['211', '212'];
  scene({ ids });
  writeCaterer(ids);
  const qf = path.join(ws.downloads, CATERER_QUEUE);
  // 1. CV screening cannot reach Jev: Phase 2 is HELD (exit 2), nothing is recorded for the run, the status file carries phase2Hold
  const held = await phase2(qf, { mode: 'on', scenario: { 211: R.outage, 212: R.outage } });
  assert.equal(held.res.code, 2, held.out.join('\n'));
  assert.ok(JSON.parse(fs.readFileSync(path.join(ws.runs, STATUS), 'utf8')).phase2Hold, 'the hold is recorded');
  assert.equal(territoryRow().reed_pending_since ?? null, null, 'a hold writes nothing to the territory map');
  assert.equal(runRows().length, 0);
  halt.clearHalt();
  // 2. the halt is gone: the recovery runs Phase 2 on the Caterer queue alone (there is no merged queue: the Reed step never ran)
  const done = await phase2(qf, { mode: 'on' });
  assert.equal(done.res.code, 0, done.out.join('\n'));
  const results = resultsOf(`phase2-results-${TS}.json`);
  assert.equal(results.sources, 'both', 'the pending search asked for both');
  assert.equal(results.reedStatus, 'not_run');
  assert.ok(done.out.some((l) => /\[Territory\] Reed half NOT done for Chef \/ LS1 \(reed status not_run\): marked reed-pending since .*one automatic retry on /.test(l)), done.out.join('\n'));
  const t = territoryRow();
  assert.equal(t.last_searched, TODAY, 'the Caterer half is done');
  assert.equal(t.reed_pending_since, TODAY, 'the Reed half is owed');
  assert.equal(t.next_run_date, day(1), 'one automatic retry');
  const rows = runRows();
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].reed_json).status, 'not_run');
  // 3. the catch-up tool lists it (from the run row, and from the mark)
  const a = catchup.analyse(ws.home, { since: '2020-01-01' }, new Date(Date.now() + 2 * 86400000));
  assert.deepEqual(a.list.map((x) => `${x.code}:${x.category}`), ['LS1:skipped']);
});

test('C: the same completion WITHOUT a hold in its history keeps the earlier rule: Reed not_run neither sets nor clears the mark', async () => {
  const ids = ['221'];
  scene({ ids });
  writeCaterer(ids);
  const done = await phase2(path.join(ws.downloads, CATERER_QUEUE), { mode: 'on' });
  assert.equal(done.res.code, 0, done.out.join('\n'));
  assert.equal(resultsOf(`phase2-results-${TS}.json`).reedStatus, 'not_run');
  assert.equal(territoryRow().reed_pending_since ?? null, null, 'a run that was never held invents no mark');
});

test('C: a held queue completed with Reed switched OFF (Caterer only) never marks anything: Reed was not asked for', async () => {
  const ids = ['231'];
  scene({ ids, pendingSources: 'caterer', hold: true });
  writeCaterer(ids);
  const done = await phase2(path.join(ws.downloads, CATERER_QUEUE), { mode: 'on', reedOn: false });
  assert.equal(done.res.code, 0, done.out.join('\n'));
  assert.equal(resultsOf(`phase2-results-${TS}.json`).reedStatus, undefined);
  assert.equal(territoryRow().reed_pending_since ?? null, null);
});

test('C: markReedHalf opens a mark for not_run ONLY when the caller says the half is owed, and pulls the one retry; a later good Reed half clears it', () => {
  scene({ ids: ['241'] });
  withDb((db) => {
    db.prepare("UPDATE territory_searches SET next_run_date = ? WHERE job_title = 'Chef' AND location = 'LS1'").run(day(7)); // the cadence date a finished run leaves
    const base = { jobTitle: 'Chef', location: 'LS1', keywords: '', distance: 20, today: TODAY };
    assert.deepEqual(territory.markReedHalf(db, { ...base, status: 'not_run' }), { changed: false });
    assert.deepEqual(territory.markReedHalf(db, { ...base, status: 'not_run', owed: false }), { changed: false });
    const r = territory.markReedHalf(db, { ...base, status: 'not_run', owed: true });
    assert.deepEqual([r.changed, r.pending, r.first, r.retryDate], [true, true, true, day(1)]);
    const again = territory.markReedHalf(db, { ...base, status: 'not_run', owed: true });
    assert.deepEqual([again.first, again.retryDate], [false, null], 'a second one keeps the original date and schedules nothing more');
    assert.deepEqual(territory.markReedHalf(db, { ...base, status: 'ok' }), { changed: true, cleared: true });
  });
});
