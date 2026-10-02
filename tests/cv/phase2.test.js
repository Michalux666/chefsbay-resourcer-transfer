'use strict';
// Phase 2 with CV screening: process-approved-queue.js on a fake queue, fake Zoho, a real SQLite file and either an injected
// reviewer (every scenario) or the real cv-review.js against a fake Jev gateway (end to end).
const P = require('./helpers/phase2-run');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('../lifecycle/helpers/sqlite');
const { card } = P;
const { ws, R, has, rowOf, setup, writeCvFile, execute, rejections, zohoIdOf, pq, halt, captureConsole } = P;
const cvStage = require('../../resourcer/scripts/lib/cv/phase2');
const { PLANTED, role, cvText } = require('./helpers/fixtures');
const { startFakeJev } = require('./helpers/fake-jev');

test.before(P.start);
test.after(P.stop);
const RUN_KEY = P.RUN_KEY;
const QUEUE = P.QUEUE;

test('CV_SCREEN off: a strict no-op, the reviewer is never called and the results file has no CV fields', async () => {
  const { res, results, seen, built } = await execute({ ids: ['8001', '8002'], scenario: {}, mode: 'off' });
  assert.equal(res.code, 0);
  assert.deepEqual(seen.calls, []);
  assert.equal(built.calls.create, 2);
  assert.equal(results.new, 2);
  assert.equal('cvRejected' in results, false);
  assert.equal('cvScreen' in results, false);
  assert.equal(rejections().length, 0);
  assert.equal(fs.existsSync(path.join(ws.home, 'shadow')), false, 'no shadow log');
  assert.equal(fs.existsSync(path.join(ws.home, 'state', 'cv-answers.jsonl')), false);
});

test('on: pass, the fallback lane and unreadable go on to Zoho; reject is not pushed, its CV and JSON are deleted and the rejection is recorded for this job title', async () => {
  const ids = ['8101', '8102', '8103', '8104'];
  const { res, results, out, built } = await execute({ ids, scenario: { 8101: R.pass, 8102: () => R.reject(['under_qualified', 'injection_flag']), 8103: R.review, 8104: R.unreadable } });
  assert.equal(res.code, 0);
  assert.equal(built.calls.create, 3, 'the rejected candidate is never sent to Zoho');
  assert.equal(rowOf(results, 8102).status, 'cv_rejected');
  assert.deepEqual(rowOf(results, 8102).reasonCodes, ['under_qualified', 'injection_flag']);
  assert.equal(rowOf(results, 8102).cvAttached, false);
  for (const id of ['8101', '8103', '8104']) assert.equal(rowOf(results, id).status, 'new', id);
  assert.equal(results.cvRejected, 1);
  assert.equal(results.new, 3);
  assert.equal(results.errors, 0);
  assert.equal(results.total, 4);
  assert.deepEqual([results.cvScreen.mode, results.cvScreen.screened, results.cvScreen.pass, results.cvScreen.reject, results.cvScreen.review, results.cvScreen.unreadable], ['on', 4, 1, 1, 1, 1]);
  assert.deepEqual([results.cvScreen.policyApprove, results.cvScreen.policyReject], [1, 0], 'only the fallback lane is settled by a policy; unreadable simply passes');
  assert.deepEqual([results.cvScreen.jev, results.cvScreen.fallback, results.cvScreen.jevShare, results.cvScreen.forced], [2, 1, 0.667, 0]);
  // the retention rule: nothing of the rejected candidate stays on disk; the others were cleaned after the push as before
  assert.equal(has('cv-8102.pdf'), false);
  assert.equal(has('candidate-8102.json'), false);
  assert.equal(zohoIdOf(8102), null);
  assert.ok(zohoIdOf(8101));
  // the rejection row: this job title, the reason text, today
  const rows = rejections();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].caterer_id, rows[0].reed_id, rows[0].job_title, rows[0].origin], [8102, null, 'Chef', 'cv:under_qualified,injection_flag']);
  assert.match(rows[0].rejected_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(out.some(l => /rejected by CV screening \(under_qualified,injection_flag\)/.test(l)));
  assert.ok(out.some(l => /CV screening \(on\): screened 4, pass 1, reject 1, fallback 1, unreadable 1; Jev-decided 2 \(66\.7 percent\), forced 0; reader errors 0/.test(l)));
});

test('on: a fallback-lane CV that the policy rejects is dropped like a reject, with the policy reason code; unreadable is never dropped', async () => {
  const { results, built } = await execute({ ids: ['8201', '8202', '8203'], scenario: { 8201: R.reviewReject, 8202: R.pass, 8203: R.unreadable } });
  assert.equal(built.calls.create, 2);
  assert.equal(rowOf(results, 8201).status, 'cv_rejected');
  assert.deepEqual(rowOf(results, 8201).reasonCodes, ['policy_fallback_reject', 'answers_invalid']);
  assert.equal(rowOf(results, 8203).status, 'new');
  assert.equal(results.cvScreen.policyReject, 1);
  assert.equal(rejections()[0].origin, 'cv:policy_fallback_reject,answers_invalid');
});

test('forced decisions are counted, logged with their marker and audited: a forced reject is dropped like any reject, a forced pass goes on', async () => {
  const { results, out } = await execute({ ids: ['8251', '8252', '8253'], scenario: { 8251: R.forcedReject, 8252: R.forcedPass, 8253: R.pass } });
  assert.equal(results.cvScreen.forced, 2);
  assert.equal(results.cvScreen.forcedRejected, 1);
  assert.equal(rowOf(results, 8251).status, 'cv_rejected');
  assert.equal(rowOf(results, 8252).status, 'new');
  assert.ok(out.some(l => /\[8251\] CV reject -> REJECTED \(jev, forced: forced,under_qualified\)/.test(l)));
  assert.ok(out.some(l => /\[8252\] CV pass -> continue \(jev, forced: forced,pass_doubt,under_qualified\)/.test(l)));
  assert.equal(rejections()[0].origin, 'cv:forced,under_qualified', 'the forced marker travels into the recorded reason');
});

test('shadow: everything is evaluated but nothing is ever blocked, and an outage is only a warning', async () => {
  const { res, results, built, out } = await execute({ ids: ['8301', '8302', '8303'], mode: 'shadow', scenario: { 8301: () => R.reject(), 8302: R.reviewReject, 8303: R.outage } });
  assert.equal(res.code, 0);
  assert.equal(built.calls.create, 3);
  assert.equal(results.new, 3);
  assert.equal(results.cvRejected, 0);
  assert.equal(results.cvScreen.mode, 'shadow');
  assert.equal(results.cvScreen.reject, 1);
  assert.equal(results.cvScreen.unscreened, 1);
  assert.equal(rejections().length, 0);
  assert.equal(halt.getHalt(), null, 'shadow never raises the halt');
  assert.ok(out.some(l => /WARN CV screening \(shadow\) could not reach Jev for 1 candidate/.test(l)));
  assert.equal(ws.alerts().filter(a => a.severity === 'critical').length, 0);
});

function withPhase1Status(qf, recovery) {
  const file = path.join(ws.runs, `phase1-${RUN_KEY}.json`);
  fs.mkdirSync(ws.runs, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id: RUN_KEY, status: 'phase1_complete', phase2Status: 'pending', jobTitle: 'Chef', location: 'LS1', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...(recovery ? { phase2Recovery: recovery } : {}) }));
  return file;
}

test('outage in the middle of a queue: nothing is pushed, nothing is lost, the halt and a critical alert are raised, and the recovery attempt is refunded', async () => {
  const ids = ['8401', '8402', '8403', '8404', '8405'];
  let status;
  const { res, results, built, out, seen } = await execute({
    ids, config: { cvScreenConcurrency: 1 },
    scenario: { 8401: R.pass, 8402: () => R.reject(), 8403: R.outage, 8404: R.pass, 8405: R.pass },
    before: qf => { status = withPhase1Status(qf, { attempts: 1, pid: 1, at: new Date().toISOString(), mode: 'process-approved-queue' }); },
  });
  assert.equal(res.code, 2);
  assert.equal(res.reason, 'cv-screening-unavailable');
  assert.equal(res.held, 3);
  assert.equal(results, null, 'no results file: a re-run is not blocked by the already-processed guard');
  assert.equal(built.calls.create, 0, 'nothing reached Zoho');
  assert.deepEqual(seen.calls, ['8401', '8402', '8403'], 'the queue stopped at the outage');
  // the candidate rejected before the outage stays rejected (final, idempotent); everyone else keeps CV and JSON
  assert.equal(has('cv-8402.pdf'), false);
  assert.equal(rejections().length, 1);
  for (const id of ['8401', '8403', '8404', '8405']) { assert.ok(has(`cv-${id}.pdf`), `cv ${id}`); assert.ok(has(`candidate-${id}.json`), `json ${id}`); }
  assert.ok(fs.existsSync(path.join(ws.downloads, QUEUE)), 'the queue file is untouched');
  // halt and alert
  const h = halt.getHalt();
  assert.equal(h.halted, true);
  assert.equal(h.reason, 'AI screening unavailable');
  assert.match(h.detail, /CV screening could not reach Jev/);
  assert.ok(ws.alerts().some(a => a.severity === 'critical' && a.key === 'cv-screening-unavailable'));
  // the status file stays recoverable, and the outage does not use up the recovery attempts
  const s = ws.readJson(status);
  assert.equal(s.status, 'phase2_starting');
  assert.equal(s.phase2Recovery.attempts, 0);
  assert.equal(s.phase2Hold.reason, 'cv-screening-unavailable');
  assert.equal(s.phase2Hold.queue, QUEUE, 'the hold pins its own queue, so a later run of the territory cannot take its place in the recovery');
  const runState = ws.readJson(path.join(ws.runs, `run-${RUN_KEY}.json`));
  assert.equal(runState.status, 'error');
  assert.equal(runState.error, 'cv-screening-unavailable');
  assert.equal(built.calls.upsert.length, 0, 'the territory is not marked searched');
  assert.ok(out.some(l => /HELD: CV screening is unavailable/.test(l)));
  assert.equal(zohoIdOf(8401), null);
});

test('the halt uses the fixed reason strings of the screening health check, chosen by why Jev was unavailable, so supervision and Phase 2 share one state', async () => {
  const health = require('../../resourcer/scripts/lib/screening-health');
  await execute({ ids: ['8451'], scenario: { 8451: R.outageAuth } });
  assert.equal(halt.getHalt().reason, health.REASONS.auth);
  assert.equal(halt.getHalt().remedy, health.REMEDIES.auth);
  halt.clearHalt();
  await execute({ ids: ['8452'], scenario: { 8452: R.outage } });
  assert.equal(halt.getHalt().reason, health.REASONS.unavailable, 'no reason key: the generic fixed reason');
  halt.clearHalt();
});

test('the retry after the outage completes the queue: rejected candidates are not downloaded again, the rest is pushed, and a second run is a no-op', async () => {
  const ids = ['8501', '8502', '8503'];
  await execute({ ids, config: { cvScreenConcurrency: 1 }, scenario: { 8501: R.pass, 8502: () => R.reject(), 8503: R.outage } });
  assert.equal(halt.getHalt().halted, true);
  // the watchdog clears the halt once screening works again
  halt.clearHalt();
  const retry = await execute({ ids, keepState: true, scenario: { 8501: R.pass, 8503: R.pass, 8502: R.pass } });
  assert.equal(retry.res.code, 0);
  assert.equal(retry.built.calls.fetchCv, 0, 'no CV was downloaded again');
  assert.equal(rowOf(retry.results, 8502).status, 'cv_rejected');
  assert.equal(retry.results.cvRejected, 1);
  assert.equal(rowOf(retry.results, 8501).status, 'new');
  assert.equal(rowOf(retry.results, 8503).status, 'new');
  assert.ok(!retry.seen.calls.includes('8502'), 'the earlier decision is not asked again');
  assert.equal(rejections().length, 1);
  assert.ok(retry.out.some(l => /Rejected by CV screening in an earlier run/.test(l)));
  // a completed queue is not processed again
  const again = await execute({ ids, keepState: true, scenario: {} });
  assert.equal(again.res.reason, 'already-processed');
  assert.equal(again.built.calls.create, 0);
  // and a forced re-run pushes nothing twice and rejects nothing twice
  ws.readJson(retry.resultsFile);
  const forced = await execute({ ids, keepState: true, scenario: {}, force: true });
  assert.equal(forced.res.code, 0);
  assert.equal(forced.built.calls.create, 0);
  assert.equal(rejections().length, 1);
  assert.equal(rowOf(forced.results || ws.readJson(path.join(ws.downloads, fs.readdirSync(ws.downloads).find(n => /rerun/.test(n) && /^phase2-results/.test(n)))), 8502).status, 'cv_rejected');
});

test('a queue that arrives while the screening halt is up is held at once: no download, no reviewer call, no second alert', async () => {
  setup(['8601', '8602']);
  for (const id of ['8601', '8602']) writeCvFile(id);
  halt.setHalt('screening gateway unreachable', 'test', { remedy: 'none', blockedRun: true });
  const alertsBefore = ws.alerts().length;
  const { res, seen, built, results } = await execute({ ids: ['8601', '8602'], keepState: true, scenario: {} });
  assert.equal(res.code, 2);
  assert.equal(results, null);
  assert.deepEqual(seen.calls, []);
  assert.equal(built.calls.fetchCv, 0);
  assert.equal(built.calls.create, 0);
  assert.equal(ws.alerts().length, alertsBefore, 'the halt already alerted');
  // other halts (not about screening) do not hold a queue
  halt.clearHalt();
  halt.setHalt('some other reason', 'test', { blockedRun: true });
  const other = await execute({ ids: ['8603'], scenario: {} });
  assert.equal(other.res.code, 0);
  halt.clearHalt();
});

test('the reject-rate alert: above the ceiling with at least ten CVs it warns, below it or with fewer it does not', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => String(8700 + i));
  const scenario = Object.fromEntries(ids.map((id, i) => [id, i < 8 ? () => R.reject() : R.pass]));
  const hi = await execute({ ids, scenario });
  const alert = ws.alerts().find(a => a.key === 'cv-reject-rate-high');
  assert.ok(alert, 'alert raised');
  assert.equal(alert.severity, 'warn');
  assert.match(alert.text, /rejected 8 of 12 CVs \(67 percent, ceiling 20\)/);
  assert.doesNotMatch(alert.text, /would have/);
  assert.equal(hi.results.cvScreen.rejectRate, 0.667);
  // the ceiling and the minimum are configuration
  const relaxed = await execute({ ids, scenario, cvOverrides: { alerts: { rejectRateCeiling: 0.9 } } });
  assert.equal(ws.alerts().filter(a => a.key === 'cv-reject-rate-high').length, 0);
  assert.equal(relaxed.results.cvRejected, 8);
  const few = await execute({ ids: ids.slice(0, 9), scenario: Object.fromEntries(ids.slice(0, 9).map(id => [id, () => R.reject()])) });
  assert.equal(ws.alerts().filter(a => a.key === 'cv-reject-rate-high').length, 0, 'fewer than ten CVs never alert');
  assert.equal(few.results.cvRejected, 9);
  const strictMin = await execute({ ids: ids.slice(0, 9), scenario: Object.fromEntries(ids.slice(0, 9).map(id => [id, () => R.reject()])), cvOverrides: { alerts: { rejectRateMinCandidates: 5 } } });
  assert.equal(ws.alerts().filter(a => a.key === 'cv-reject-rate-high').length, 1);
  assert.equal(strictMin.results.cvRejected, 9);
  // a policy reject counts towards the rate, so does shadow mode
  const shadow = await execute({ ids, scenario: Object.fromEntries(ids.map(id => [id, R.reviewReject])), mode: 'shadow' });
  assert.equal(shadow.results.cvRejected, 0);
  assert.ok(ws.alerts().some(a => a.key === 'cv-reject-rate-high' && /shadow/.test(JSON.stringify(a.meta))));
});

test('the fallback-rate, forced-rate and unreadable-rate alerts', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => String(8800 + i));
  await execute({ ids, scenario: Object.fromEntries(ids.map(id => [id, R.unreadable])) });
  assert.ok(ws.alerts().some(a => a.key === 'cv-unreadable-rate-high'));
  await execute({ ids, scenario: Object.fromEntries(ids.map(id => [id, R.forcedPass])) });
  const forced = ws.alerts().find(a => a.key === 'cv-forced-rate-high');
  assert.ok(forced);
  assert.match(forced.text, /10 of 10 CVs .* decided in real doubt \(forced, ceiling 35 percent\)/);
  // the fallback rate is the owner's rule (Jev decides 99 percent): it needs at least twenty modelled CVs to speak
  const twenty = Array.from({ length: 20 }, (_, i) => String(8850 + i));
  await execute({ ids: twenty, scenario: Object.fromEntries(twenty.map((id, i) => [id, i < 3 ? R.review : R.pass])) });
  const fb = ws.alerts().find(a => a.key === 'cv-fallback-rate-high');
  assert.ok(fb, 'three of twenty is 15 percent');
  assert.match(fb.text, /3 of 20 CVs .* not decided by Jev/);
  assert.equal(fb.meta.jevShare, 0.85);
  await execute({ ids, scenario: Object.fromEntries(ids.map((id, i) => [id, i < 3 ? R.review : R.pass])) });
  assert.equal(ws.alerts().filter(a => a.key === 'cv-fallback-rate-high').length, 0, 'fewer than twenty CVs never raise it');
  await execute({ ids: twenty, scenario: Object.fromEntries(twenty.map((id, i) => [id, i < 1 ? R.review : R.pass])) });
  assert.equal(ws.alerts().filter(a => a.key === 'cv-fallback-rate-high').length, 0, 'one in twenty is inside the ceiling');
});

test('a reviewer that fails (not Jev) passes the CV through like an unreadable one, counted and reported once, whatever the fallback policy', async () => {
  const { results, built } = await execute({ ids: ['8901', '8902', '8903'], scenario: { 8901: R.broken, 8902: 'throw', 8903: R.pass } });
  assert.equal(results.new, 3);
  assert.equal(built.calls.create, 3);
  assert.equal(results.cvScreen.errors, 2);
  assert.equal(results.cvScreen.unreadable, 2);
  assert.equal(results.cvScreen.policyApprove, 0);
  assert.ok(ws.alerts().some(a => a.key === 'cv-review-errors'));
  const strict = await execute({ ids: ['8911'], scenario: { 8911: R.broken }, cvOverrides: { fallback: { policy: 'reject' } } });
  assert.equal(rowOf(strict.results, 8911).status, 'new', 'never a reject');
});

test('candidates without a CV file (a Reed profile only) are not screened and go on as before; candidates already in Zoho or without an e-mail are not screened either', async () => {
  const ids = ['9001', '9002', '9003'];
  setup(ids, { extra: [] });
  db2(ws, 9003, 'ZOHO-EXISTING');
  writeCvFile('9001');
  const cands = [card('9001'), card('9002', { cvUrl: undefined }), card('9003')];
  const { results, seen } = await execute({ ids, cands, keepState: true, scenario: {}, hooks: { fillMandatory: () => ({ patched: false, recovered: [], stillMissing: [] }) } });
  assert.deepEqual(seen.calls, ['9001']);
  assert.equal(results.cvScreen.noCv, 1);
  assert.equal(rowOf(results, 9003).status, 'skipped');
});

function db2(w, id, zid) {
  const db = new Database(w.db);
  db.prepare('UPDATE candidates SET zoho_id = ? WHERE caterer_id = ?').run(zid, id);
  db.close();
}

test('at most four reviewers run at once by default, and the limit is configuration', async () => {
  const ids = Array.from({ length: 14 }, (_, i) => String(9100 + i));
  const a = await execute({ ids, scenario: {} });
  assert.ok(a.seen.maxInflight > 1 && a.seen.maxInflight <= 4, `max in flight ${a.seen.maxInflight}`);
  const b = await execute({ ids, scenario: {}, config: { cvScreenConcurrency: 2 } });
  assert.equal(b.seen.maxInflight, 2);
  // the documented settings: jev.concurrency of the criteria file and the CV_SCREEN_CONCURRENCY variable (the test seam above is not one of them)
  const c = await execute({ ids, scenario: {}, cvOverrides: { jev: { concurrency: 1 } } });
  assert.equal(c.seen.maxInflight, 1, 'jev.concurrency of the criteria file');
  process.env.CV_SCREEN_CONCURRENCY = '3';
  try {
    const d = await execute({ ids, scenario: {} });
    assert.equal(d.seen.maxInflight, 3, 'CV_SCREEN_CONCURRENCY');
    assert.ok(d.out.some(l => /up to 3 at a time/.test(l)));
  } finally { delete process.env.CV_SCREEN_CONCURRENCY; }
});

test('a Reed candidate is rejected in the reed_id column and its own CV file is removed', async () => {
  setup([], { reedIds: ['9301'] });
  writeCvFile('9301', undefined, 'reed');
  const cands = [{ ...card('9301'), source: 'reed', queryId: 'q1' }];
  const { results } = await execute({ ids: [], cands, keepState: true, scenario: { 9301: () => R.reject(['no_relevant_experience']) } });
  assert.equal(rowOf(results, 9301).status, 'cv_rejected');
  assert.equal(rowOf(results, 9301).source, 'reed');
  assert.equal(has('cv-reed-9301.pdf'), false);
  const rows = rejections();
  assert.deepEqual([rows[0].caterer_id, rows[0].reed_id, rows[0].origin], [null, 9301, 'cv:no_relevant_experience']);
});

test('the reason code column of a migrated database is filled too, the schema is never changed', async () => {
  setup(['9401']);
  writeCvFile('9401');
  const db = new Database(ws.db);
  db.exec('ALTER TABLE candidate_rejections ADD COLUMN reason_code TEXT');
  db.close();
  await execute({ ids: ['9401'], keepState: true, scenario: { 9401: () => R.reject(['over_qualified']) } });
  const check = new Database(ws.db, { readonly: true });
  const row = check.prepare("SELECT reason_code, origin FROM candidate_rejections WHERE caterer_id = 9401").get();
  const cols = check.prepare('PRAGMA table_info(candidate_rejections)').all().map(c => c.name);
  check.close();
  assert.deepEqual(row, { reason_code: 'over_qualified', origin: 'cv:over_qualified' });
  assert.deepEqual(cols, ['id', 'caterer_id', 'reed_id', 'job_title', 'rejected_at', 'origin', 'reason_code']);
});

test('a rejection that cannot be recorded keeps the files, is not pushed, and raises a warning; the next run decides again', async () => {
  const { results, built } = await execute({ ids: ['9501', '9502'], scenario: { 9501: () => R.reject(), 9502: R.pass }, hooks: { getDbThrows: true } });
  assert.equal(rowOf(results, 9501).status, 'cv_rejected');
  assert.equal(built.calls.create, 1);
  assert.ok(has('cv-9501.pdf'), 'kept because the rejection was not written');
  assert.ok(ws.alerts().some(a => a.key === 'cv-reject-not-recorded'));
});

test('the same candidate twice in one queue is screened once and reported for both entries', async () => {
  const { results, seen } = await execute({ ids: ['9601'], cands: [card('9601'), card('9601')], scenario: { 9601: () => R.reject() } });
  assert.equal(seen.calls.length, 2, 'both entries are candidates of the queue');
  assert.equal(rejections().length, 1);
  assert.equal(results.candidates.filter(c => c.status === 'cv_rejected').length, 2);
});

test('the job title of the queue is the scope of the rejection', async () => {
  await execute({ ids: ['9701'], scenario: { 9701: () => R.reject() }, queueExtra: { jobTitle: 'Kitchen Porter' } });
  assert.equal(rejections()[0].job_title, 'Kitchen Porter');
});

// ---------------------------------------------------------------------------------------------------------------------
// end to end: the real cv-review.js in a child process against the fake Jev gateway
// ---------------------------------------------------------------------------------------------------------------------

function e2eEnv() {
  process.env.SCREEN_GATEWAY_ORIGIN = P.state.gw.origin;
  process.env.AI_GATEWAY_API_KEY = P.state.gw.key;
  process.env.SCREEN_BACKOFF_BASE_MS = '1';
  process.env.SCREEN_MAX_ATTEMPTS = '2';
}

test('end to end with the real reviewer: pass and reject decisions, personal data removed, shadow rows, files deleted', async () => {
  e2eEnv();
  P.state.gw.reset();
  const ids = ['9801', '9802', '9803'];
  setup(ids);
  writeCvFile('9801', cvText([role('Chef de Partie', '2021-04', 'present'), role('Chef de Partie', '2018-02', '2021-03')]));
  writeCvFile('9802', cvText([role('Kitchen Porter', '2020-09', 'present'), role('Kitchen Porter', '2016-09', '2020-08')]));
  writeCvFile('9803', Buffer.from('%PDF-1.4\nnot a real pdf\n'));
  const cands = ids.map(id => card(id, { firstName: PLANTED.first, lastName: PLANTED.last, name: `${PLANTED.first} ${PLANTED.last}`, email: PLANTED.email, phone: PLANTED.phone, postcode: PLANTED.postcode }));
  const { res, results, built } = await execute({ ids, cands, keepState: true, useRealCli: true, queueExtra: { jobTitle: 'Head Chef' }, hooks: { fillMandatory: () => ({ patched: false, recovered: [], stillMissing: [] }) } });
  assert.equal(res.code, 0);
  // the CDP history against a head search is below the level: reject; the porter too; the unreadable file goes through by policy
  assert.equal(rowOf(results, 9801).status, 'cv_rejected');
  assert.equal(rowOf(results, 9802).status, 'cv_rejected');
  assert.equal(rowOf(results, 9803).status, 'new');
  assert.equal(built.calls.create, 1);
  assert.equal(results.cvScreen.reject, 2);
  assert.equal(results.cvScreen.unreadable, 1);
  assert.equal(results.cvScreen.jev, 2);
  assert.equal(results.cvScreen.jevShare, 1);
  assert.equal(results.cvScreen.policyApprove, 0);
  assert.equal(has('cv-9801.pdf'), false);
  const rows = rejections();
  assert.deepEqual(rows.map(r => r.caterer_id).sort(), [9801, 9802]);
  assert.ok(rows.every(r => r.job_title === 'Head Chef' && /^cv:(?:forced,)?under_qualified/.test(r.origin)), JSON.stringify(rows));
  // privacy: nothing personal reached Jev or the shadow log
  const sent = JSON.stringify(P.state.gw.stats().captured);
  for (const v of [PLANTED.first, PLANTED.last, PLANTED.email, PLANTED.phone, PLANTED.postcode, PLANTED.referee]) assert.equal(sent.includes(v), false, v);
  const shadowDir = path.join(ws.home, 'shadow');
  const rowsText = fs.readdirSync(shadowDir).filter(n => /^cv-/.test(n)).map(n => fs.readFileSync(path.join(shadowDir, n), 'utf8')).join('');
  assert.equal(rowsText.split('\n').filter(Boolean).length, 3);
  for (const v of [PLANTED.first, PLANTED.last, PLANTED.email, PLANTED.phone, PLANTED.postcode]) assert.equal(rowsText.includes(v), false, v);
  assert.match(rowsText, /"candidateId":"9801"/);
  assert.match(rowsText, /"runId":"2026-09-30T10-00-00"/);
});

test('end to end: Jev down means the queue is held with everything kept (exit 3 of the reviewer becomes exit 2 of Phase 2)', async () => {
  const dead = await startFakeJev({ failFirst: 100000, failStatus: 503 });
  process.env.SCREEN_GATEWAY_ORIGIN = dead.origin;
  process.env.AI_GATEWAY_API_KEY = dead.key;
  process.env.SCREEN_MAX_ATTEMPTS = '2';
  const ids = ['9901', '9902'];
  setup(ids);
  for (const id of ids) writeCvFile(id, cvText([role('Chef de Partie', '2021-04', 'present')]));
  const { res, results, built } = await execute({ ids, keepState: true, useRealCli: true, hooks: { fillMandatory: () => ({ patched: false, recovered: [], stillMissing: [] }) } });
  await dead.close();
  assert.equal(res.code, 2);
  assert.equal(results, null);
  assert.equal(built.calls.create, 0);
  for (const id of ids) { assert.ok(has(`cv-${id}.pdf`)); assert.ok(has(`candidate-${id}.json`)); }
  assert.equal(halt.getHalt().halted, true);
  assert.equal(rejections().length, 0);
  assert.ok(ws.alerts().some(a => a.key === 'cv-screening-unavailable'));
  halt.clearHalt();
  // the gateway is back: the same queue completes
  e2eEnv();
  const back = await execute({ ids, keepState: true, useRealCli: true, hooks: { fillMandatory: () => ({ patched: false, recovered: [], stillMissing: [] }) } });
  assert.equal(back.res.code, 0);
  assert.equal(back.results.new, 2);
});

test('the queue step reads CV_SCREEN from the environment: shadow when it is not set, off only when it says so, shadow (never on) for anything it does not know', () => {
  const saved = process.env.CV_SCREEN;
  try {
    delete process.env.CV_SCREEN;
    assert.equal(pq.makeDeps().cvScreenMode(), 'shadow', 'the default');
    process.env.CV_SCREEN = '';
    assert.equal(pq.makeDeps().cvScreenMode(), 'shadow', 'empty is unset');
    process.env.CV_SCREEN = 'ON';
    assert.equal(pq.makeDeps().cvScreenMode(), 'on');
    process.env.CV_SCREEN = 'shadow';
    assert.equal(pq.makeDeps().cvScreenMode(), 'shadow');
    process.env.CV_SCREEN = 'off';
    assert.equal(pq.makeDeps().cvScreenMode(), 'off');
    process.env.CV_SCREEN = 'yes please';
    const cap = captureConsole();
    try { assert.equal(pq.makeDeps().cvScreenMode(), 'shadow'); } finally { cap.restore(); }
    assert.ok(cap.lines.some(l => /runs in shadow mode/.test(l)));
  } finally {
    if (saved === undefined) delete process.env.CV_SCREEN; else process.env.CV_SCREEN = saved;
  }
  assert.equal(typeof cvStage.runCli, 'function');
});
