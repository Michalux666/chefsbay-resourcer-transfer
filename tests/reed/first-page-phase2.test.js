'use strict';

// R3 and R4 against the REAL Phase 2 (process-approved-queue.run with the lifecycle harness) and the real territory map: what a failed Reed
// half writes into the results file, run_results and territory_searches, and the exact rule that keeps the lost Reed half from looking done
// (territory-utils.markReedHalf). The Caterer half must be recorded exactly as before.

const { makeWorkspace } = require('../lifecycle/helpers/workspace');
const ws = makeWorkspace('reed-first-page-p2');
require('../lifecycle/helpers/net-guard');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('../lifecycle/helpers/sqlite');
const { seedDb, buildDeps, captureConsole } = require('../lifecycle/helpers/harness');
const pq = require('../../resourcer/scripts/process-approved-queue');
const territory = require('../../resourcer/scripts/territory-utils');

test.after(() => ws.cleanup());

const day = (offset) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const TODAY = day(0);
const TOMORROW = day(1);
const FAILED = { pool: 0, pagesScraped: 0, inDb: 0, crossDedup: 0, rejected: 0, approved: 0, authFailed: false, authFailureReason: null, failed: true, failureKind: 'first_page', failureReason: 'HTTP 400 code 50010', errors: 1 };
const EMPTY = { pagesScraped: 1, pool: 0, inDb: 0, crossDedup: 0, rejected: 0, approved: 0 };
const GOOD = { pagesScraped: 2, pool: 30, inDb: 10, crossDedup: 0, rejected: 5, approved: 0, errors: 0 };
const AUTH = { pool: 0, pagesScraped: 0, approved: 0, authFailed: true, authFailureReason: 'turnstile_blocked' };

function mergedQueue(reed) {
  return {
    searchDate: TODAY, jobTitle: 'Chef', location: 'LS1', distance: 20, activeWithin: 'month', keywords: '', sources: 'both', screeningModel: 'test-model',
    candidateCount: 40, creditsRemaining: 44000,
    phase1Stats: { caterer: { pagesScraped: 3, approved: 0, skippedDb: 30, skippedReview: 8, errors: 0, totalCandidatesSeen: 40 }, ...(reed === undefined ? {} : { reed }) },
    candidates: [],
  };
}

function withDb(fn) {
  const db = new Database(ws.db, { timeout: 5000 });
  try { return fn(db); } finally { db.close(); }
}

// territory row in the state a scheduled run leaves it: due today, cadence seven days
function seedTerritory(over) {
  withDb((db) => {
    // the legacy fixture already holds Chef / LS1 / 20mi (sources both); only its schedule is set here
    db.prepare("UPDATE territory_searches SET priority = 'low', enabled = 1, next_run_date = ? WHERE job_title = 'Chef' AND location = 'LS1'")
      .run((over && over.next_run_date) || TODAY);
    if (over && over.reed_pending_since) {
      db.exec('ALTER TABLE territory_searches ADD COLUMN reed_pending_since TEXT');
      db.prepare('UPDATE territory_searches SET reed_pending_since = ?').run(over.reed_pending_since);
    }
  });
}
const territoryRow = () => withDb((db) => db.prepare('SELECT * FROM territory_searches WHERE job_title = ? AND location = ?').get('Chef', 'LS1'));

let seq = 0;
async function runPhase2(queue, opts = {}) {
  const name = `merged-queue-fp-${++seq}.json`;
  fs.mkdirSync(ws.downloads, { recursive: true });
  fs.mkdirSync(ws.pending, { recursive: true });
  const pendingFile = path.join(ws.pending, 'territory-5-20260930-1000.json');
  fs.writeFileSync(pendingFile, JSON.stringify({ jobTitle: 'Chef', location: 'LS1', sources: 'both', ...(opts.pending || {}) }));
  fs.writeFileSync(path.join(ws.downloads, name), JSON.stringify(queue));
  const built = buildDeps(ws, {});
  built.deps.allowedSources = () => 'both';
  built.deps.upsertTerritory = (db, p) => territory.upsertTerritory(db, p); // the real territory map
  if (opts.deps) Object.assign(built.deps, opts.deps);
  const cap = captureConsole();
  let res;
  try { res = await pq.run(path.join(ws.downloads, name), built.deps); } finally { cap.restore(); built.close(); }
  const runId = name.replace(/\.json$/, '');
  const results = ws.readJson(path.join(ws.downloads, `phase2-results-${runId}.json`));
  const runRow = withDb((db) => db.prepare('SELECT * FROM run_results WHERE run_key = ?').get(runId));
  return { res, out: cap.lines, results, runRow, pendingFile, reedJson: runRow && runRow.reed_json ? JSON.parse(runRow.reed_json) : null };
}

function fresh(over) {
  ws.reset();
  seedDb(ws, []);
  seedTerritory(over);
}

test('R3: a failed Reed attempt is recorded as failed with errors 1 in the results file and in run_results; the Caterer half is recorded exactly as before', async () => {
  fresh();
  const r = await runPhase2(mergedQueue(FAILED));
  assert.equal(r.res.code, 0);
  assert.equal(r.results.reedStatus, 'failed');
  assert.equal(r.results.reedStats.status, 'failed');
  assert.equal(r.results.reedStats.failed, true);
  assert.equal(r.results.reedStats.failureReason, 'HTTP 400 code 50010');
  assert.equal(r.results.reedStats.errors, 1, 'one error, not 0');
  assert.equal(r.results.reedStats.pool, 0);
  assert.equal(r.results.reedStats.phase1.errors, 1);
  assert.equal(r.results.sources, 'both');
  assert.equal(r.results.errors, 0, 'the run-level error count is the Caterer and Zoho side: unchanged');
  assert.equal(r.results.incomplete, undefined, 'the run is not incomplete: the Caterer half completed');
  assert.equal(r.results.catererStats.pool, 40);
  assert.equal(r.results.catererStats.phase1.approved, 0);
  assert.equal(r.results.catererStats.errors, 0);
  // run_results (the dashboard's source): reed_json carries the same
  assert.ok(r.runRow, 'the run_results row was written');
  assert.deepEqual([r.reedJson.status, r.reedJson.failed, r.reedJson.errors, r.reedJson.pool], ['failed', true, 1, 0]);
  assert.equal(r.runRow.errors, 0);
  assert.equal(r.runRow.sources, 'both');
  assert.equal(JSON.parse(r.runRow.caterer_json).pool, 40);
  assert.equal(fs.existsSync(r.pendingFile), false, 'the Caterer half is done: the pending search is complete (the Reed half is tracked on the territory, not by re-running Caterer)');
  assert.deepEqual(ws.alerts().filter((a) => /^reed-auth/.test(a.key || '')), [], 'not an auth failure');
});

test('R4: the territory stays marked searched for the Caterer half, is marked Reed-pending, and gets ONE automatic retry tomorrow through the normal due path', async () => {
  fresh({ next_run_date: TODAY });
  const r = await runPhase2(mergedQueue(FAILED));
  assert.ok(r.out.some((l) => /\[Territory\] Reed half NOT done for Chef \/ LS1 \(reed status failed\): marked reed-pending since .*one automatic retry on /.test(l)), r.out.join('\n'));
  const t = territoryRow();
  assert.equal(t.last_searched, TODAY, 'the Caterer half marks the territory searched');
  assert.equal(t.reed_pending_since, TODAY);
  assert.equal(t.next_run_date, TOMORROW, 'instead of a whole interval later');
  assert.ok(!withDb((db) => territory.getDueTerritories(db)).some((x) => x.location === 'LS1'), 'not due today (it becomes due tomorrow)');
});

test('R4: a second failure in the same episode keeps the ORIGINAL date and does not pull the schedule again; a good Reed half clears the mark', async () => {
  fresh({ next_run_date: TODAY, reed_pending_since: day(-3) });
  await runPhase2(mergedQueue(FAILED));
  let t = territoryRow();
  assert.equal(t.reed_pending_since, day(-3), 'the oldest date of the episode is kept');
  assert.ok(t.next_run_date > TOMORROW, `normal cadence after the retry failed too (${t.next_run_date})`);
  const r = await runPhase2(mergedQueue(GOOD));
  t = territoryRow();
  assert.equal(t.reed_pending_since, null, 'a run whose Reed half worked closes the episode');
  assert.equal(r.results.reedStatus, 'ok');
  assert.ok(r.out.some((l) => /reed-pending mark cleared/.test(l)));
});

test('R4: a genuine empty Reed pool counts as searched (status empty, errors 0) and clears the mark', async () => {
  fresh({ next_run_date: TODAY, reed_pending_since: day(-1) });
  const r = await runPhase2(mergedQueue(EMPTY));
  assert.equal(r.results.reedStatus, 'empty');
  assert.equal(r.results.reedStats.errors, 0);
  assert.equal(r.results.reedStats.failed, undefined);
  assert.deepEqual([r.reedJson.status, r.reedJson.errors], ['empty', 0]);
  assert.equal(territoryRow().reed_pending_since, null);
});

test('R4: a run with no Reed record at all (held or skipped) is status not_run: it neither sets nor clears the mark, and never reads as a clean Reed search', async () => {
  fresh({ next_run_date: TODAY, reed_pending_since: day(-2) });
  const r = await runPhase2(mergedQueue(undefined));
  assert.equal(r.results.reedStatus, 'not_run');
  assert.equal(r.reedJson.status, 'not_run');
  assert.equal(territoryRow().reed_pending_since, day(-2));
  fresh({ next_run_date: TODAY });
  await runPhase2(mergedQueue(undefined));
  assert.ok(!territoryRow().reed_pending_since, 'and a first not_run does not invent one');
});

test('R4: an auth-failed Reed half is marked pending too (the existing bounded retries stay in charge), without pulling the schedule', async () => {
  fresh({ next_run_date: TODAY });
  const r = await runPhase2(mergedQueue(AUTH));
  assert.equal(r.results.reedStatus, 'auth_failed');
  const t = territoryRow();
  assert.equal(t.reed_pending_since, TODAY);
  assert.ok(t.next_run_date > TOMORROW, 'no extra retry date: the pending file is kept for its own retries');
  assert.ok(fs.existsSync(r.pendingFile), 'the existing auth-failure retry keeps the pending search');
});

test('R4: a screening halt is not a Reed failure and leaves the territory alone (existing rule: it stays due)', async () => {
  fresh({ next_run_date: TODAY });
  const r = await runPhase2(mergedQueue({ ...GOOD, screeningHalted: true, errors: 1 }));
  assert.equal(r.results.incomplete, 'reed-screening-unavailable');
  assert.equal(territoryRow().reed_pending_since, undefined, 'the column was never even added: nothing to record');
});

test('R4: the mark is bookkeeping: a failing marker never fails the run, and the column is added to a legacy table by itself', async () => {
  fresh({ next_run_date: TODAY });
  assert.ok(!('reed_pending_since' in territoryRow()), 'the legacy schema has no such column');
  const r = await runPhase2(mergedQueue(FAILED), { deps: { markReedHalf: () => { throw new Error('boom'); } } });
  assert.equal(r.res.code, 0);
  assert.ok(r.out.some((l) => /WARN: Reed half mark failed: boom/.test(l)));
  fresh({ next_run_date: TODAY });
  await runPhase2(mergedQueue(FAILED));
  assert.ok('reed_pending_since' in territoryRow(), 'added on first use');
});

test('R4 unit: the retry date is the first day from tomorrow with free daily capacity, and a territory already due sooner keeps its date', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE territory_searches (id INTEGER PRIMARY KEY AUTOINCREMENT, job_title TEXT, location TEXT, distance INTEGER, keywords TEXT DEFAULT '', enabled INTEGER DEFAULT 1, next_run_date TEXT)`);
  const add = db.prepare("INSERT INTO territory_searches (job_title, location, distance, next_run_date) VALUES (?, ?, 20, ?)");
  add.run('Chef', 'LS1', day(9));
  add.run('Chef', 'LS2', TOMORROW); // fills tomorrow's capacity of 1
  add.run('Chef', 'LS3', TODAY); // due now
  const base = { jobTitle: 'Chef', distance: 20, keywords: '', status: 'failed', today: TODAY, cap: 1 };
  assert.deepEqual(territory.markReedHalf(db, { ...base, location: 'LS1' }), { changed: true, pending: true, first: true, retryDate: day(2) });
  assert.equal(db.prepare("SELECT next_run_date FROM territory_searches WHERE location = 'LS1'").get().next_run_date, day(2));
  const due = territory.markReedHalf(db, { ...base, location: 'LS3' });
  assert.equal(due.retryDate, null, 'already due before the retry date: unchanged');
  assert.equal(db.prepare("SELECT next_run_date FROM territory_searches WHERE location = 'LS3'").get().next_run_date, TODAY);
  assert.deepEqual(territory.markReedHalf(db, { ...base, location: 'LS1' }), { changed: true, pending: true, first: false, retryDate: null }, 'second failure: no new date');
  assert.deepEqual(territory.markReedHalf(db, { ...base, location: 'NOPE' }), { changed: false, missing: true });
  assert.deepEqual(territory.markReedHalf(db, { ...base, location: 'LS1', status: 'not_run' }), { changed: false });
  assert.deepEqual(territory.markReedHalf(db, { ...base, location: 'LS1', status: 'ok' }), { changed: true, cleared: true });
  db.close();
});

// ---------------------------------------------------------------- finalizer additions (review findings)

test('R4: a run ahead of its slot (a catch-up or one-off search on a territory that is not due yet) leaves next_run_date where it was; a due one still rolls on by whole intervals', async () => {
  const later = day(9);
  fresh({ next_run_date: later });
  await runPhase2(mergedQueue(GOOD));
  assert.equal(territoryRow().next_run_date, later, 'an early run does not push the next regular sweep a whole interval past its due date');
  assert.equal(territoryRow().last_searched, TODAY, 'the territory is still marked searched');
  fresh({ next_run_date: TODAY });
  await runPhase2(mergedQueue(GOOD));
  assert.ok(territoryRow().next_run_date > TODAY, 'a due territory advances as before');
});

test('R4: a failed Reed half on a territory that is not due yet still gets its one automatic retry tomorrow (the date is pulled earlier, not left)', async () => {
  fresh({ next_run_date: day(20) });
  await runPhase2(mergedQueue(FAILED));
  assert.equal(territoryRow().next_run_date, TOMORROW);
  assert.equal(territoryRow().reed_pending_since, TODAY);
});

test('R3: a failed stats block from a Reed run that fetched no search page (phase1Stats.failed) is a failed Reed half too', async () => {
  fresh();
  const r = await runPhase2(mergedQueue({ pagesScraped: 0, pool: 30, inDb: 0, crossDedup: 0, rejected: 0, approved: 0, errors: 2, failed: true, failureReason: 'HTTP 400 code 50010' }));
  assert.equal(r.results.reedStatus, 'failed');
  assert.equal(r.reedJson.failed, true);
  assert.ok(r.reedJson.errors >= 1);
  assert.equal(territoryRow().reed_pending_since, TODAY);
});
