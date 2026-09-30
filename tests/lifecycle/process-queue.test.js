'use strict';
const { makeWorkspace } = require('./helpers/workspace');
const ws = makeWorkspace('lc-pq');
require('./helpers/net-guard');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startFakeZoho } = require('./helpers/fake-zoho');
const { card, writeQueue, writeCv, fakeResponse, dbHelpers } = require('./helpers/fixtures');
const { captureConsole, seedDb, buildDeps } = require('./helpers/harness');
const pq = require('../../resourcer/scripts/process-approved-queue');

let zoho;
const db = dbHelpers(ws.db);
const QUEUE = 'merged-queue-2026-09-29T10-00-00.json';
const RUN_KEY = 'merged-queue-2026-09-29T10-00-00';

test.before(async () => { zoho = await startFakeZoho(); });
test.after(async () => { await zoho.close(); ws.cleanup(); });

function reset(ids, dbOpts) {
  ws.reset();
  zoho.calls.length = 0;
  zoho.scenarios.clear();
  seedDb(ws, ids, dbOpts);
}

async function execute({ candidates, queueName = QUEUE, queueExtra, hooks, ids, dbOpts, setup, keepState }) {
  if (!keepState) reset(ids || candidates.map(c => c.id).filter(i => /^\d+$/.test(String(i))), dbOpts);
  const qf = writeQueue(ws, queueName, { candidates, ...(queueExtra || {}) });
  if (setup) setup(qf);
  const built = buildDeps(ws, { zoho, hooks });
  const cap = captureConsole();
  let res;
  try { res = await pq.run(qf, built.deps); } finally { cap.restore(); built.close(); }
  const runKey = path.basename(qf).replace(/^approved-queue-/, '').replace(/\.json$/, '');
  const resultsFile = path.join(ws.downloads, `phase2-results-${runKey}.json`);
  const results = fs.existsSync(resultsFile) ? ws.readJson(resultsFile) : null;
  return { res, out: cap.lines, results, built, qf, runKey, resultsFile };
}

const has = name => fs.existsSync(path.join(ws.downloads, name));
const row = (results, id) => results.candidates.find(c => c.id === String(id));

// ---------------------------------------------------------------------------------------------
// the deletion rule, exhaustively
// ---------------------------------------------------------------------------------------------

test('failure injection matrix: CV/JSON are removed iff Zoho has the candidate AND (attached OR duplicate)', async () => {
  const creates = ['success', 'duplicate', 'flaky-once', 'http500', 'mandatory', 'invalid'];
  const attaches = ['ok', 'exists', 'throttle-then-ok', 'fail', 'http500', 'throttle-always', 'throw'];
  const dbModes = ['ok', 'throw'];
  const cvModes = [true, false];
  const cases = [];
  let n = 5000;
  for (const create of creates) for (const attach of attaches) for (const dbm of dbModes) for (const cv of cvModes) cases.push({ id: String(n++), create, attach, dbm, cv });

  const candidates = cases.map(c => (c.cv ? card(c.id) : card(c.id, { cvUrl: undefined })));
  reset(cases.map(c => c.id));
  for (const c of cases) {
    zoho.scenario(c.id, { create: c.create, attach: c.attach === 'throw' ? 'ok' : c.attach });
    if (c.cv) writeCv(ws, c.id);
  }
  const throwsDb = new Set(cases.filter(c => c.dbm === 'throw').map(c => c.id));
  const throwsAttach = new Set(cases.filter(c => c.attach === 'throw').map(c => path.basename(c.id)));
  const { res, results, built } = await execute({
    candidates, keepState: true,
    hooks: {
      setZohoIdThrows: id => throwsDb.has(String(id)),
      attachThrows: (zid, file) => throwsAttach.has(path.basename(file).replace(/^cv-(reed-)?/, '').replace(/\..*$/, '')),
    },
  });
  assert.equal(res.code, 0);
  assert.equal(results.candidates.length, cases.length);

  const attachedSet = new Set(['ok', 'exists', 'throttle-then-ok']);
  const problems = [];
  for (const c of cases) {
    const zohoSet = ['success', 'duplicate', 'flaky-once'].includes(c.create);
    const dup = c.create === 'duplicate';
    const attachedOk = !dup && c.cv && attachedSet.has(c.attach);
    const eligible = zohoSet && (dup || attachedOk);
    const r = row(results, c.id);
    const label = JSON.stringify(c);
    const cvName = `cv-${c.id}.pdf`;
    const jsonName = `candidate-${c.id}.json`;
    if (has(cvName) !== (c.cv && !eligible)) problems.push(`CV presence wrong: ${label}`);
    if (has(jsonName) !== !eligible) problems.push(`JSON presence wrong: ${label}`);
    const expStatus = zohoSet ? (dup ? 'duplicate' : 'new') : 'error';
    if (r.status !== expStatus) problems.push(`status ${r.status} != ${expStatus}: ${label}`);
    if (zohoSet && r.cvAttached !== attachedOk) problems.push(`cvAttached ${r.cvAttached} != ${attachedOk}: ${label}`);
    const zid = db.zohoId(c.id);
    if (zohoSet && c.dbm === 'ok' && !zid) problems.push(`DB zoho id missing: ${label}`);
    if (c.dbm === 'throw' && zid) problems.push(`DB write should have failed: ${label}`);
    if (!zohoSet && zid) problems.push(`DB has zoho id for failed push: ${label}`);
  }
  assert.deepEqual(problems, []);
  assert.equal(built.calls.create >= cases.length, true);
});

test('CV on disk is removed even when the DB write fails after a successful create+attach', async () => {
  reset(['7001']);
  writeCv(ws, '7001');
  const { res, results } = await execute({ candidates: [card('7001')], keepState: true, hooks: { setZohoIdThrows: true } });
  assert.equal(res.code, 0);
  assert.equal(row(results, '7001').status, 'new');
  assert.equal(has('cv-7001.pdf'), false);
  assert.equal(has('candidate-7001.json'), false);
  assert.equal(db.zohoId('7001'), null);
});

test('cleanup still runs when a later step of the block throws (console output failing)', async () => {
  reset(['7002']);
  writeCv(ws, '7002');
  const qf = writeQueue(ws, QUEUE, { candidates: [card('7002')] });
  const built = buildDeps(ws, { zoho });
  const cap = captureConsole();
  const origLog = console.log;
  console.log = (...a) => { if (String(a[0]).includes('ZOHO_ID=')) throw new Error('stdout closed'); origLog(...a); };
  let res;
  try { res = await pq.run(qf, built.deps); } finally { console.log = origLog; cap.restore(); }
  assert.equal(res.code, 1, 'the run aborts (legacy FATAL semantics)');
  assert.equal(has('cv-7002.pdf'), false, 'but the CV of the candidate Zoho already holds is gone');
  assert.equal(has('candidate-7002.json'), false);
});

test('failed attach keeps CV and candidate JSON for the retention window', async () => {
  reset(['7003']);
  writeCv(ws, '7003');
  zoho.scenario('7003', { attach: 'fail' });
  const { results, out } = await execute({ candidates: [card('7003')], keepState: true });
  assert.equal(row(results, '7003').status, 'new');
  assert.equal(row(results, '7003').cvAttached, false);
  assert.equal(has('cv-7003.pdf'), true);
  assert.equal(has('candidate-7003.json'), true);
  assert.ok(out.some(l => l.includes('CV attach failed')));
  assert.ok(ws.alerts().some(a => a.key === 'cv-attach-failed'));
  const errors = fs.readFileSync(path.join(ws.logs, 'errors.jsonl'), 'utf8');
  assert.match(errors, /"context":"cv_attach"/);
});

test('throttled attach is retried by the client and the CV is then deleted', async () => {
  reset(['7004']);
  writeCv(ws, '7004');
  zoho.scenario('7004', { attach: 'throttle-then-ok' });
  const { results } = await execute({ candidates: [card('7004')], keepState: true });
  assert.equal(row(results, '7004').cvAttached, true);
  assert.equal(zoho.callsFor('7004', 'attach').length, 3);
  assert.equal(has('cv-7004.pdf'), false);
});

test('reed CV pattern cv-reed-<id>.* is removed together with the JSON; DB reed_id row is updated', async () => {
  reset([], { reedIds: ['8100'] });
  writeCv(ws, '8100', { source: 'reed' });
  const { results, built } = await execute({
    candidates: [card('8100', { source: 'reed', cvUrl: undefined })], keepState: true, queueExtra: { sources: 'both' },
  });
  assert.equal(row(results, '8100').status, 'new');
  assert.equal(row(results, '8100').source, 'reed');
  assert.equal(has('cv-reed-8100.pdf'), false);
  assert.equal(has('candidate-8100.json'), false);
  assert.ok(db.zohoId('8100', 'reed'));
  assert.deepEqual(built.calls.reedDownloads, [], 'existing CV reused: no Reed download credit spent');
});

test('reed candidate is downloaded through reed-download, pushed, and cleaned up', async () => {
  reset([], { reedIds: ['8101'] });
  const { results, built } = await execute({ candidates: [card('8101', { source: 'reed', cvUrl: undefined })], keepState: true, queueExtra: { sources: 'both' } });
  assert.deepEqual(built.calls.reedDownloads, ['8101']);
  assert.equal(row(results, '8101').cvAttached, true);
  assert.equal(has('cv-reed-8101.pdf'), false);
  assert.equal(has('candidate-8101.json'), false);
});

test('same numeric id from both sources (legacy candidate-<id>.json collision): no cross deletion, no wrong push', async () => {
  reset(['9100'], { reedIds: ['9100'] });
  writeCv(ws, '9100', { source: 'caterer' });
  writeCv(ws, '9100', { source: 'reed' });
  const cands = [card('9100', { cvUrl: undefined }), card('9100', { source: 'reed', cvUrl: undefined })];
  const { results } = await execute({ candidates: cands, keepState: true, queueExtra: { sources: 'both' } });
  const [cat, reed] = results.candidates;
  assert.equal(cat.status, 'new');
  assert.equal(has('cv-9100.pdf'), false, 'the caterer candidate cleaned its own CV');
  assert.equal(has('cv-reed-9100.pdf'), true, 'the reed CV is not removed by the caterer candidate');
  assert.equal(reed.status, 'error');
  assert.equal(reed.error, 'No candidate JSON', 'the shared JSON name is gone, so the reed twin is not pushed with the caterer payload');
  assert.equal(zoho.callsFor('9100', 'create').length, 1);
});

test('duplicate in Zoho: nothing attached, files removed, run counts it as duplicate', async () => {
  reset(['7005']);
  writeCv(ws, '7005');
  zoho.scenario('7005', { create: 'duplicate' });
  const { results } = await execute({ candidates: [card('7005')], keepState: true });
  assert.equal(row(results, '7005').status, 'duplicate');
  assert.equal(zoho.callsFor('7005', 'attach').length, 0);
  assert.equal(has('cv-7005.pdf'), false);
  assert.equal(has('candidate-7005.json'), false);
  assert.equal(results.duplicates, 1);
  assert.equal(results.new, 0);
});

test('the same candidate listed twice in one queue: second occurrence is a duplicate, not an error (legacy outcome)', async () => {
  reset(['7007']);
  writeCv(ws, '7007');
  const { results } = await execute({ candidates: [card('7007'), card('7007')], keepState: true });
  assert.deepEqual(results.candidates.map(c => c.status), ['new', 'duplicate']);
  assert.equal(zoho.callsFor('7007', 'create').length, 1);
  assert.equal(results.errors, 0);
  assert.equal(has('cv-7007.pdf'), false);
});

test('legacy prefix fallback: a caterer candidate whose only CV is cv-reed-<id>.* attaches it and that exact file is removed', async () => {
  reset(['7008']);
  writeCv(ws, '7008', { source: 'reed' });
  writeCv(ws, '7008', { source: 'reed', ext: '.docx' });
  const { results } = await execute({ candidates: [card('7008', { cvUrl: undefined })], keepState: true });
  assert.equal(row(results, '7008').cvAttached, true);
  assert.equal(has('cv-reed-7008.pdf'), false);
  assert.equal(has('cv-reed-7008.docx'), true, 'only the attached file of the other prefix is removed');
  assert.equal(has('candidate-7008.json'), false);
});

test('no CV at all and push succeeds: JSON kept (rule needs attach or duplicate)', async () => {
  const { results } = await execute({ candidates: [card('7006', { cvUrl: undefined })] });
  assert.equal(row(results, '7006').status, 'new');
  assert.equal(row(results, '7006').cvAttached, false);
  assert.equal(has('candidate-7006.json'), true);
});

// ---------------------------------------------------------------------------------------------
// legacy behaviours
// ---------------------------------------------------------------------------------------------

test('happy path: download, push, attach, results, run_results row, credits sync, status file, pending file, wake flag', async () => {
  ws.reset();
  seedDb(ws, ['1001', '1002', '1003']);
  fs.mkdirSync(ws.runs, { recursive: true });
  fs.mkdirSync(ws.pending, { recursive: true });
  const status = path.join(ws.runs, 'phase1-2026-09-29-100000.json');
  fs.writeFileSync(status, JSON.stringify({ id: 'x', status: 'phase1_complete', jobTitle: 'Chef', location: 'LS1', startedAt: new Date().toISOString(), phase2Status: 'pending' }));
  fs.writeFileSync(path.join(ws.pending, 'territory-1-20260929-1000.json'), JSON.stringify({ jobTitle: 'chef', location: 'ls1', sources: 'caterer' }));
  fs.writeFileSync(path.join(ws.pending, 'territory-2-20260929-1000.json'), JSON.stringify({ jobTitle: 'Cook', location: 'LS2', sources: 'caterer' }));
  const { res, results, built, out } = await execute({
    candidates: [card('1001'), card('1002'), card('1003')], keepState: true, queueName: 'approved-queue-2026-09-29-100000.json',
  });
  assert.equal(res.code, 0);
  assert.equal(results.new, 3);
  assert.equal(results.downloaded, 3);
  assert.equal(results.total, 3);
  assert.equal(results.errors, 0);
  assert.equal(results.sources, 'caterer');
  assert.equal(results.date, '2026-09-29');
  assert.deepEqual(results.catererStats, { pool: 40, newToZoho: 3, downloaded: 3, duplicates: 0, errors: 0, phase1: { pagesScraped: 3, approved: 2, skippedDb: 30, skippedReview: 8 } });
  assert.equal(results.reedStats, null);
  assert.equal(results.phase1.candidateCount, 40);
  assert.equal(built.calls.fetchCv, 3);
  assert.deepEqual(fs.readdirSync(ws.downloads).filter(n => n.startsWith('cv-') || n.startsWith('candidate-')), []);
  for (const id of ['1001', '1002', '1003']) assert.ok(db.zohoId(id));
  // run_results
  const rr = db.runResults();
  assert.equal(rr.length, 1);
  assert.equal(rr[0].run_key, '2026-09-29-100000');
  assert.equal(rr[0].new_to_zoho, 3);
  assert.equal(rr[0].downloaded, 3);
  assert.equal(rr[0].date, '2026-09-29');
  assert.equal(rr[0].sources, 'caterer');
  assert.equal(rr[0].pool, 40);
  assert.equal(rr[0].approved_p1, 2);
  assert.equal(rr[0].credits_remaining, 44000);
  assert.equal(JSON.parse(rr[0].caterer_json).newToZoho, 3);
  assert.equal(rr[0].reed_json, null);
  // credits sync, wake flag, run state, status file, pending cleanup
  const credits = ws.readJson(path.join(ws.home, 'credits-sync.json'));
  assert.equal(credits.credits, 44000);
  assert.equal(credits.source, 'phase2-completion');
  assert.ok(fs.existsSync(path.join(ws.runs, 'pipeline-wake.flag')));
  const runState = ws.readJson(path.join(ws.runs, 'run-2026-09-29-100000.json'));
  assert.equal(runState.status, 'complete');
  assert.equal(runState.phase2.pushed, 3);
  const st = ws.readJson(status);
  assert.equal(st.status, 'complete');
  assert.equal(st.phase2Complete, true);
  assert.deepEqual(fs.readdirSync(ws.pending), ['territory-2-20260929-1000.json'], 'only the matching pending search is removed');
  assert.equal(built.calls.upsert.length, 1);
  assert.equal(built.calls.upsert[0].newToZoho, 3);
  assert.equal(built.calls.upsert[0].lastSearched, '2026-09-29');
  assert.ok(out.some(l => l.includes('=== Phase 2 Complete ===')));
  assert.ok(out.some(l => l.includes('Lock extended: phase1-2026-09-29-100000.json -> phase2_starting')));
  assert.equal(ws.alerts().length, 0);
});

test('console output and errors.jsonl carry ids only, never names, emails, phones or CV data', async () => {
  reset(['1101', '1102']);
  zoho.scenario('1102', { create: 'invalid' });
  const { out } = await execute({ candidates: [card('1101'), card('1102')], keepState: true });
  const all = out.join('\n') + '\n' + fs.readFileSync(path.join(ws.logs, 'errors.jsonl'), 'utf8');
  assert.doesNotMatch(all, /Person\d|Test Person|example\.invalid|07000/);
  assert.match(all, /1102/);
});

test('reprocess guard: a completed results file for the same queue stops a second run', async () => {
  reset(['1201']);
  const first = await execute({ candidates: [card('1201')], keepState: true });
  assert.equal(first.res.code, 0);
  const before = zoho.calls.length;
  const second = await execute({ candidates: [card('1201')], keepState: true });
  assert.equal(second.res.code, 0);
  assert.equal(second.res.reason, 'already-processed');
  assert.ok(second.out.some(l => l.includes('ALREADY_PROCESSED')));
  assert.equal(zoho.calls.length, before, 'no Zoho traffic on the second invocation');
});

test('reprocess guard survives the sweep order: queue deleted first means the guard is never asked twice', async () => {
  reset(['1202']);
  const first = await execute({ candidates: [card('1202')], keepState: true });
  // a sweep that removed the queue but not yet the results: the CLI is not handed a missing queue
  fs.unlinkSync(first.qf);
  const cap = captureConsole();
  let res;
  try { res = await pq.run(first.qf, buildDeps(ws, { zoho }).deps); } finally { cap.restore(); }
  assert.equal(res.code, 1);
  assert.equal(res.reason, 'queue-missing');
  assert.ok(fs.existsSync(first.resultsFile), 'results untouched');
});

test('unreadable prior results do not block reprocessing (legacy fall-through)', async () => {
  reset(['1203']);
  const qf = writeQueue(ws, QUEUE, { candidates: [card('1203')] });
  fs.writeFileSync(path.join(ws.downloads, `phase2-results-${RUN_KEY}.json`), '{not json');
  const cap = captureConsole();
  let res;
  try { res = await pq.run(qf, buildDeps(ws, { zoho }).deps); } finally { cap.restore(); }
  assert.equal(res.code, 0);
  assert.equal(res.reason, 'done');
});

test('CV already on disk is reused on retry (no download) and cleaned after the push', async () => {
  reset(['1301']);
  writeCv(ws, '1301', { ext: '.docx' });
  const { built, results } = await execute({ candidates: [card('1301')], keepState: true });
  assert.equal(built.calls.fetchCv, 0);
  assert.equal(results.downloaded, 0);
  assert.equal(zoho.callsFor('1301', 'attach')[0].bytes > 0, true);
  assert.equal(has('cv-1301.docx'), false);
});

test('candidate already in Zoho per DB is skipped and its files are left for the sweep', async () => {
  reset([], { extra: [{ caterer_id: 1401, unlocked: 1, zoho_id: '999' }] });
  writeCv(ws, '1401');
  const { results, built } = await execute({ candidates: [card('1401')], keepState: true });
  assert.equal(row(results, '1401').status, 'skipped');
  assert.equal(row(results, '1401').zohoId, '999');
  assert.equal(row(results, '1401').cvAttached, true, 'legacy: cvAttached mirrors CV presence for skipped rows');
  assert.equal(built.calls.create, 0);
  assert.equal(has('cv-1401.pdf'), true);
  assert.equal(results.skipped, 1);
});

test('no email anywhere: reported as error, no push, files kept', async () => {
  reset(['1501']);
  const { results, built } = await execute({
    candidates: [card('1501', { email: '' })], keepState: true,
    hooks: { fillMandatory: () => ({ patched: false, recovered: [], stillMissing: ['Email'] }) },
  });
  assert.equal(row(results, '1501').status, 'error');
  assert.match(row(results, '1501').error, /^NO_EMAIL/);
  assert.equal(built.calls.create, 0);
  assert.equal(has('candidate-1501.json'), true);
  assert.equal(results.pushErrors, 1);
});

test('create retries with 3s then 6s back-off, then reports the error', async () => {
  reset(['1601']);
  zoho.scenario('1601', { create: 'http500' });
  const { results, built } = await execute({ candidates: [card('1601')], keepState: true });
  assert.equal(row(results, '1601').status, 'error');
  assert.equal(built.calls.create, 3);
  assert.deepEqual(built.sleeps.filter(ms => ms >= 3000), [3000, 6000]);
  assert.equal(has('candidate-1601.json'), true);
  assert.match(fs.readFileSync(path.join(ws.logs, 'errors.jsonl'), 'utf8'), /"retriesExhausted":3/);
});

test('a throttled create is retried with back-off and then succeeds; the CV is attached and removed', async () => {
  reset(['1651']);
  writeCv(ws, '1651');
  zoho.scenario('1651', { create: 'throttle-then-ok' });
  const { results, built } = await execute({ candidates: [card('1651')], keepState: true });
  assert.equal(row(results, '1651').status, 'new');
  assert.equal(built.calls.create, 3);
  assert.deepEqual(built.sleeps.filter(ms => ms >= 3000), [3000, 6000]);
  assert.equal(has('cv-1651.pdf'), false);
});

test('MANDATORY_NOT_FOUND triggers field recovery and one retry', async () => {
  reset(['1701']);
  writeCv(ws, '1701');
  zoho.scenario('1701', { create: 'mandatory' });
  let calls = 0;
  const { results } = await execute({
    candidates: [card('1701')], keepState: true,
    hooks: {
      fillMandatory: () => {
        calls++;
        if (calls === 1) return { patched: false, recovered: [], stillMissing: [] };
        zoho.scenario('1701', { create: 'success' });
        return { patched: true, recovered: ['City=Testville'], stillMissing: [] };
      },
    },
  });
  // first fillMandatory call is the pre-push check (Step 4.5); the second is the recovery after Zoho rejected
  assert.equal(calls, 2);
  assert.equal(row(results, '1701').status, 'new');
  assert.equal(has('cv-1701.pdf'), false);
});

test('MANDATORY_NOT_FOUND that cannot be recovered is reported with the missing field', async () => {
  reset(['1702']);
  zoho.scenario('1702', { create: 'mandatory' });
  const { results } = await execute({ candidates: [card('1702')], keepState: true });
  assert.equal(row(results, '1702').error, 'MANDATORY_NOT_FOUND City (no fields to fill)');
});

test('a thrown download error (session gone, network down) is that candidate\'s error, not a fatal abort', async () => {
  reset(['1801', '1802']);
  const { res, results } = await execute({
    candidates: [card('1801'), card('1802')], keepState: true,
    hooks: { fetchCv: url => { if (url.includes('1801')) throw new Error('No Caterer session file - run caterer-login first'); return fakeResponse(); } },
  });
  assert.equal(res.code, 0);
  assert.equal(results.downloadErrors, 1);
  assert.equal(row(results, '1802').cvAttached, true);
  assert.equal(row(results, '1801').status, 'new', 'candidate is still pushed (without CV) instead of being stranded');
});

test('HTML masquerading as a CV, tiny bodies and HTTP errors are download errors', async () => {
  reset(['1901', '1902', '1903']);
  const html = Buffer.from('<!DOCTYPE html><html>' + 'x'.repeat(200));
  const { results, out } = await execute({
    candidates: [card('1901'), card('1902'), card('1903')], keepState: true,
    hooks: {
      fetchCv: url => {
        if (url.includes('1901')) return fakeResponse({ body: html, contentType: 'text/html' });
        if (url.includes('1902')) return fakeResponse({ body: Buffer.alloc(10) });
        return fakeResponse({ ok: false, status: 403, statusText: 'Forbidden' });
      },
    },
  });
  assert.equal(results.downloadErrors, 3);
  assert.equal(fs.readdirSync(ws.downloads).some(n => n.startsWith('cv-')), false, 'nothing saved');
  assert.ok(out.some(l => l.includes('returned HTML page')));
  assert.ok(out.some(l => l.includes('File too small')));
  assert.ok(out.some(l => l.includes('HTTP 403 Forbidden')));
});

test('guessExtension only returns extensions findExistingCv can find', () => {
  assert.equal(pq.guessExtension('application/pdf', ''), '.pdf');
  assert.equal(pq.guessExtension('', 'attachment; filename="cv.DOCX"'), '.docx');
  assert.equal(pq.guessExtension('application/octet-stream', 'attachment; filename="cv.odt"'), '.pdf', 'unsupported extension falls back');
  assert.equal(pq.guessExtension('application/msword', 'attachment; filename="cv.wps"'), '.doc');
  assert.equal(pq.guessExtension('application/vnd.openxmlformats-officedocument.wordprocessingml.document', ''), '.docx');
  assert.equal(pq.guessExtension('text/plain', ''), '.txt');
  assert.equal(pq.guessExtension('', ''), '.pdf');
});

test('CV file is written with 0600 and atomically (no tmp left behind)', async () => {
  reset(['2001']);
  zoho.scenario('2001', { attach: 'fail' });
  await execute({ candidates: [card('2001')], keepState: true });
  const names = fs.readdirSync(ws.downloads);
  assert.equal(names.some(n => n.endsWith('.tmp')), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(ws.downloads, 'cv-2001.pdf')).mode & 0o777, 0o600);
});

test('invalid candidate ids never touch the filesystem outside downloads/', async () => {
  reset(['2101']);
  const victim = path.join(ws.home, 'cv-1.pdf');
  fs.writeFileSync(victim, 'keep');
  const evil = card('../../resourcer/cv-1', { cvUrl: '/x' });
  const { results, res } = await execute({ candidates: [evil, card('2101'), null, { name: 'no id' }], keepState: true });
  assert.equal(res.code, 0);
  assert.equal(results.candidates.filter(c => c.status === 'error' && /INVALID_ID/.test(c.error)).length, 3);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
  assert.equal(row(results, '2101').status, 'new');
  assert.equal(results.total, 4);
});

test('run_results failure never fails the run and is repairable later', async () => {
  reset(['2201']);
  const { res, results, built } = await execute({ candidates: [card('2201')], keepState: true, hooks: { openDbThrowsOnce: true } });
  assert.equal(res.code, 0);
  assert.equal(res.runResultsWritten, false);
  assert.equal(built.calls.upsert.length, 1, 'territory update still ran');
  assert.ok(results);
  assert.ok(ws.alerts().some(a => a.key === 'run-results-write-failed'));
  assert.match(fs.readFileSync(path.join(ws.logs, 'errors.jsonl'), 'utf8'), /"context":"run_results"/);
  // rerun of the writer alone is idempotent: INSERT OR REPLACE keyed by run_key
  const backfill = require('../../resourcer/scripts/backfill-run-results');
  const d = db.open();
  try {
    require('../../resourcer/scripts/migrate-schema').ensureRunResults(d);
    backfill.writeRunResultRow(d, backfill.buildRunResultRow(results, RUN_KEY), { replace: true });
    backfill.writeRunResultRow(d, backfill.buildRunResultRow(results, RUN_KEY), { replace: true });
  } finally { d.close(); }
  assert.equal(db.runResults().length, 1);
});

test('territory update failure is fatal after the results and run_results rows exist (legacy order)', async () => {
  reset(['2301']);
  const { res, results, built } = await execute({ candidates: [card('2301')], keepState: true, hooks: { upsertThrows: true } });
  assert.equal(res.code, 1);
  assert.equal(res.reason, 'fatal');
  assert.ok(results, 'results file was written before the failure');
  assert.equal(db.runResults().length, 1);
  const state = ws.readJson(path.join(ws.runs, `run-${RUN_KEY}.json`));
  assert.equal(state.status, 'error');
  assert.match(state.error, /injected territory failure/);
  assert.ok(ws.alerts().some(a => a.key === 'phase2-fatal' && a.severity === 'critical'));
  assert.match(fs.readFileSync(path.join(ws.logs, 'errors.jsonl'), 'utf8'), /"context":"phase2_fatal"/);
  assert.equal(built.calls.upsert.length, 1);
});

test('CLI: --help exits 0 and prints usage; no argument exits 1 (legacy)', () => {
  const { spawnSync } = require('child_process');
  const script = path.resolve(__dirname, '../../resourcer/scripts/process-approved-queue.js');
  const env = { ...process.env, RESOURCER_HOME: ws.home };
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', env });
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes('Usage: node scripts/process-approved-queue.js'));
  const none = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /Usage:/);
  const missing = spawnSync(process.execPath, [script, path.join(ws.home, 'nope.json')], { encoding: 'utf8', env });
  assert.equal(missing.status, 1);
});

test('argument and input errors keep the legacy exit-1 contract', async () => {
  const cap = captureConsole();
  try {
    const deps = buildDeps(ws, { zoho }).deps;
    assert.deepEqual([(await pq.run(undefined, deps)).code, (await pq.run(undefined, deps)).reason], [1, 'usage']);
    assert.equal((await pq.run(path.join(ws.downloads, 'nope.json'), deps)).reason, 'queue-missing');
    fs.mkdirSync(ws.downloads, { recursive: true });
    const bad = path.join(ws.downloads, 'bad-queue.json');
    fs.writeFileSync(bad, '{oops');
    assert.equal((await pq.run(bad, deps)).reason, 'queue-invalid-json');
    fs.writeFileSync(bad, JSON.stringify({ candidates: { a: 1 } }));
    assert.equal((await pq.run(bad, deps)).reason, 'candidates-invalid');
    fs.writeFileSync(bad, JSON.stringify({ candidates: null }));
    assert.equal((await pq.run(bad, deps)).reason, 'candidates-invalid');
  } finally { cap.restore(); }
});

test('empty queue still writes results, run_results and updates the territory', async () => {
  const { res, results, built } = await execute({ candidates: [] });
  assert.equal(res.code, 0);
  assert.equal(results.total, 0);
  assert.equal(results.new, 0);
  assert.equal(db.runResults().length, 1);
  assert.equal(built.calls.upsert.length, 1);
  assert.equal(built.calls.upsert[0].newToZoho, 0);
});

test('token refresh failure is only a warning', async () => {
  reset(['2401']);
  const { res, out } = await execute({ candidates: [card('2401')], keepState: true, hooks: { refreshThrows: true } });
  assert.equal(res.code, 0);
  assert.ok(out.some(l => l.includes('Token refresh warning')));
});

test('credits fallback: queue without credits asks the live check; stale fallback is not written', async () => {
  reset(['2501']);
  let calls = 0;
  const qf = writeQueue(ws, QUEUE, { candidates: [card('2501')], creditsRemaining: null });
  const built = buildDeps(ws, { zoho });
  built.deps.getCredits = () => { calls++; return { credits: '12345', source: 'fallback-stale' }; };
  const cap = captureConsole();
  try { await pq.run(qf, built.deps); } finally { cap.restore(); }
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(path.join(ws.home, 'credits-sync.json')), false);
  reset(['2502']);
  const qf2 = writeQueue(ws, QUEUE, { candidates: [card('2502')], creditsRemaining: null });
  const built2 = buildDeps(ws, { zoho });
  built2.deps.getCredits = () => ({ credits: '777', source: 'phase2-fallback' });
  const cap2 = captureConsole();
  try { await pq.run(qf2, built2.deps); } finally { cap2.restore(); }
  assert.deepEqual(ws.readJson(path.join(ws.home, 'credits-sync.json')).credits, 777);
});

test('all pushes failing raises a critical alert (Zoho credentials down)', async () => {
  reset(['2601', '2602', '2603']);
  for (const id of ['2601', '2602', '2603']) zoho.scenario(id, { create: 'http500' });
  await execute({ candidates: [card('2601'), card('2602'), card('2603')], keepState: true });
  const a = ws.alerts().find(x => x.key === 'zoho-push-failing');
  assert.ok(a);
  assert.equal(a.severity, 'critical');
});

// ---------------------------------------------------------------------------------------------
// pending file + reed auth + status file semantics (ported branches)
// ---------------------------------------------------------------------------------------------

function pendingCase(pendingBody, queueExtra) {
  reset([]);
  fs.mkdirSync(ws.pending, { recursive: true });
  const f = path.join(ws.pending, 'territory-5-20260929-1000.json');
  fs.writeFileSync(f, JSON.stringify({ jobTitle: 'Chef', location: 'LS1', spawnedAt: 'now', ...pendingBody }));
  return { f, run: () => execute({ candidates: [], keepState: true, queueExtra }) };
}

// RESOURCER_SOURCES decides whether Reed can run at all; unset means caterer only (the default until the canary passes).
async function withSources(value, fn) {
  const prev = process.env.RESOURCER_SOURCES;
  if (value === undefined) delete process.env.RESOURCER_SOURCES; else process.env.RESOURCER_SOURCES = value;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.RESOURCER_SOURCES; else process.env.RESOURCER_SOURCES = prev;
  }
}

test('pending file: caterer run deletes it', async () => {
  const c = pendingCase({ sources: 'caterer' });
  await withSources(undefined, () => c.run());
  assert.equal(fs.existsSync(c.f), false);
});

test('pending file: with Reed enabled the sources hint widens a caterer-looking queue to both, so the file is removed', async () => {
  await withSources('both', async () => {
    const c = pendingCase({ sources: 'both' });
    const { results } = await c.run();
    assert.equal(results.sources, 'both');
    assert.equal(fs.existsSync(c.f), false);
  });
});

test('pending file: with Reed enabled a caterer-only result keeps a sibling pending file that asked for reed/both, but only for a bounded number of runs', async () => {
  await withSources('both', async () => {
    reset([]);
    fs.mkdirSync(ws.pending, { recursive: true });
    const a = path.join(ws.pending, 'territory-5-a.json');
    const b = path.join(ws.pending, 'territory-5-b.json');
    const seed = () => {
      fs.writeFileSync(a, JSON.stringify({ jobTitle: 'Chef', location: 'LS1', sources: 'caterer' }));
      if (!fs.existsSync(b)) fs.writeFileSync(b, JSON.stringify({ jobTitle: 'Chef', location: 'LS1', sources: 'both', spawnedAt: '2026-09-29T10:00:00.000Z' }));
    };
    seed();
    let r = await execute({ candidates: [], keepState: true });
    assert.equal(fs.existsSync(a), false, 'caterer-only pending is always removed');
    assert.equal(r.results.sources, 'caterer', 'the first match (a) says caterer, so the run counts as caterer-only');
    assert.equal(ws.readJson(b).sourceMismatchRetries, 1);
    assert.equal(ws.readJson(b).spawnedAt, '2026-09-29T10:00:00.000Z', 'the claim is kept as before');
    assert.ok(r.out.some(l => l.includes('WARN keeping pending file') && l.includes('retry 1/2')));

    seed();
    fs.rmSync(r.resultsFile);
    r = await execute({ candidates: [], keepState: true });
    assert.equal(ws.readJson(b).sourceMismatchRetries, 2);

    seed();
    fs.rmSync(r.resultsFile);
    r = await execute({ candidates: [], keepState: true });
    assert.equal(fs.existsSync(b), false, 'third attempt: dropped instead of looping for ever');
    const alert = ws.alerts().find(x => x.key === 'pending-sources-mismatch-giveup');
    assert.ok(alert);
    assert.equal(alert.severity, 'warn');
    assert.ok(r.out.some(l => l.includes('Deleted pending search file') && l.includes('caterer-only run')));
  });
});

test('pending file: Reed disabled, a pending file that says both/reed is deleted (never kept) and the run is recorded as caterer-only', async () => {
  for (const asked of ['both', 'reed']) {
    await withSources(undefined, async () => {
      const c = pendingCase({ sources: asked, spawnedAt: '2026-09-29T10:00:00.000Z' }, { sources: 'caterer' });
      const { results, out, res } = await c.run();
      assert.equal(res.code, 0);
      assert.equal(fs.existsSync(c.f), false, `${asked}: pending file must not survive a completed caterer-only run`);
      assert.equal(results.sources, 'caterer', 'the hint of a pending file must not turn a caterer-only run into a both-run');
      assert.equal(results.reedStats, null);
      assert.ok(out.some(l => l.includes('Reed is disabled by RESOURCER_SOURCES')));
      const rr = db.runResults();
      assert.equal(rr.length, 1);
      assert.equal(rr[0].sources, 'caterer');
      assert.equal(rr[0].reed_json, null);
    });
  }
});

test('pending file: Reed disabled and the sibling that asked for both is deleted too (the legacy doom loop)', async () => {
  await withSources(undefined, async () => {
    reset([]);
    fs.mkdirSync(ws.pending, { recursive: true });
    const a = path.join(ws.pending, 'territory-5-a.json');
    const b = path.join(ws.pending, 'territory-5-b.json');
    fs.writeFileSync(a, JSON.stringify({ jobTitle: 'Chef', location: 'LS1', sources: 'caterer' }));
    fs.writeFileSync(b, JSON.stringify({ jobTitle: 'Chef', location: 'LS1', sources: 'both' }));
    const other = path.join(ws.pending, 'territory-9-z.json');
    fs.writeFileSync(other, JSON.stringify({ jobTitle: 'Cook', location: 'M1', sources: 'both' }));
    const { results } = await execute({ candidates: [], keepState: true });
    assert.equal(results.sources, 'caterer');
    assert.equal(fs.existsSync(a), false);
    assert.equal(fs.existsSync(b), false);
    assert.equal(fs.existsSync(other), true, 'a different territory is untouched');
  });
});

test('pending file protocol: a file kept for a retry stays claimed for 10 minutes, then the real gate re-queues it; the counter survives', async () => {
  const { spawnSync } = require('child_process');
  const gate = () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'resourcer', 'scripts', 'pending-gate.js')], { encoding: 'utf8', env: { ...process.env, RESOURCER_HOME: ws.home } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  await withSources('both', async () => {
    reset([]);
    fs.mkdirSync(ws.pending, { recursive: true });
    fs.writeFileSync(path.join(ws.pending, 'territory-5-a.json'), JSON.stringify({ jobTitle: 'Chef', location: 'LS1', sources: 'caterer' }));
    const b = path.join(ws.pending, 'territory-5-b.json');
    fs.writeFileSync(b, JSON.stringify({ jobTitle: 'Chef', location: 'LS1', sources: 'both', spawnedAt: new Date().toISOString() }));
    await execute({ candidates: [], keepState: true });
    assert.equal(ws.readJson(b).sourceMismatchRetries, 1);
    assert.equal(gate(), 'SPAWNED:territory-5-b.json', 'no hot loop: the claim holds the file back');
    const p = ws.readJson(b);
    p.spawnedAt = new Date(Date.now() - 11 * 60000).toISOString();
    fs.writeFileSync(b, JSON.stringify(p));
    const ready = JSON.parse(gate());
    assert.equal(ready.status, 'READY');
    assert.equal(ready.file, 'territory-5-b.json');
    assert.equal(ready.pending.sourceMismatchRetries, 1, 'the retry counter travels with the re-queued file');
    assert.equal(ready.pending.spawnedAt, undefined);
  });
});

test('pending file: RESOURCER_SOURCES values are read like the watchdog does (case, spaces; anything else means caterer only)', () => {
  for (const [v, want] of [['both', true], [' Reed ', true], ['BOTH', true], ['caterer', false], ['', false], ['reed,caterer', false], ['none', false], [undefined, false], [null, false]]) {
    assert.equal(pq.reedAllowed(v), want, JSON.stringify(v));
  }
});

test('pending file: a corrupt pending file no longer hides the sources hint of the files after it', async () => {
  await withSources('both', async () => {
    reset([]);
    fs.mkdirSync(ws.pending, { recursive: true });
    fs.writeFileSync(path.join(ws.pending, 'territory-1-broken.json'), '{ not json');
    const good = path.join(ws.pending, 'territory-2-good.json');
    fs.writeFileSync(good, String.fromCharCode(0xFEFF) + JSON.stringify({ jobTitle: 'Chef', location: 'LS1', sources: 'both' }));
    const { results } = await execute({ candidates: [], keepState: true });
    assert.equal(results.sources, 'both');
    assert.equal(fs.existsSync(good), false, 'a BOM-prefixed pending file is understood and removed');
    assert.equal(fs.existsSync(path.join(ws.pending, 'territory-1-broken.json')), true, 'an unreadable file is left alone');
  });
});

test('pending file: reed auth failure keeps it for a bounded retry without spawnedAt, then gives up', async () => {
  await withSources('both', async () => {
    const stats = { caterer: { approved: 0 }, reed: { authFailed: true, authFailureReason: 'token' } };
    let c = pendingCase({ sources: 'both' }, { sources: 'both', phase1Stats: stats });
    await c.run();
    let p = ws.readJson(c.f);
    assert.equal(p.reedAuthRetries, 1);
    assert.equal(p.spawnedAt, undefined);
    assert.ok(ws.alerts().some(a => a.key === 'reed-auth-failed'));
    c = pendingCase({ sources: 'both', reedAuthRetries: 3 }, { sources: 'both', phase1Stats: stats });
    await c.run();
    assert.equal(fs.existsSync(c.f), false);
    assert.ok(ws.alerts().some(a => a.key === 'reed-auth-giveup' && a.severity === 'critical'));
  });
});

test('findPhase1StatusFile: name match, content match, 7-day guard', () => {
  ws.reset();
  fs.mkdirSync(ws.runs, { recursive: true });
  const w = (n, o) => { fs.writeFileSync(path.join(ws.runs, n), JSON.stringify(o)); return path.join(ws.runs, n); };
  const recent = new Date().toISOString();
  const named = w('phase1-2026-09-29-100000.json', { status: 'phase1_complete', jobTitle: 'Chef', location: 'LS1', startedAt: recent });
  w('phase1-2026-09-29-110000.json', { status: 'phase1_complete', jobTitle: 'Cook', location: 'LS2', startedAt: recent });
  assert.equal(pq.findPhase1StatusFile(path.join(ws.downloads, 'approved-queue-2026-09-29-100000.json'), null, {}), named);
  assert.equal(pq.findPhase1StatusFile(path.join(ws.downloads, 'reed-approved-queue-phase1-2026-09-29-100000.json'), null, {}), named);
  const cook = pq.findPhase1StatusFile(path.join(ws.downloads, 'merged-queue-2026-09-29T11-00-00.json'), ['phase1_complete'], { jobTitle: 'Cook', location: 'LS2' });
  assert.match(cook, /110000/);
  const oldRun = new Date(Date.now() - 8 * 86400000).toISOString();
  fs.rmSync(ws.runs, { recursive: true }); fs.mkdirSync(ws.runs);
  w('phase1-2026-09-01-090000.json', { status: 'phase1_complete', jobTitle: 'Chef', location: 'LS1', startedAt: oldRun });
  assert.equal(pq.findPhase1StatusFile(path.join(ws.downloads, 'merged-queue-x.json'), ['phase1_complete'], { jobTitle: 'Chef', location: 'LS1' }), null);
});

test('flattenPhase1Stats merges nested caterer/reed stats like the legacy code', () => {
  assert.deepEqual(pq.flattenPhase1Stats(null), {});
  const flat = { pagesScraped: 2 };
  assert.equal(pq.flattenPhase1Stats(flat), flat);
  const f = pq.flattenPhase1Stats({
    caterer: { pagesScraped: 2, scrapingTimeSecs: 20, sessionValidationTimeSecs: 3, phase1CompletedAt: '2026-09-29T10:00:00Z', avgTimePerBrowserRoundtrip: 1.5, pageTimings: [1] },
    reed: { pagesScraped: 3, phase1StartedAt: '2026-09-29T10:00:00Z', phase1CompletedAt: '2026-09-29T10:00:40Z', pageTimings: [2, 3] },
  });
  assert.equal(f.phase1CompletedAt, '2026-09-29T10:00:40Z');
  assert.equal(f.scrapingTimeSecs, 60);
  assert.equal(f.avgTimePerPageSecs, 12);
  assert.equal(f.sessionValidationTimeSecs, 3);
  assert.equal(f.avgTimePerBrowserRoundtrip, 1.5);
  assert.deepEqual(f.pageTimings, [1, 2, 3]);
});

test('merged both-source run: reed stats block, resolved sources and per-source counts', async () => {
  reset(['3001'], { reedIds: ['3002'] });
  const { results } = await execute({
    candidates: [card('3001'), card('3002', { source: 'reed', cvUrl: undefined })], keepState: true,
    queueExtra: { sources: 'both', phase1Stats: { caterer: { pagesScraped: 2, approved: 1, skippedDb: 5, skippedReview: 2, totalCandidatesSeen: 10 }, reed: { pool: 30, pagesScraped: 1, approved: 1, rejected: 4, inDb: 2 } } },
  });
  assert.equal(results.sources, 'both');
  assert.equal(results.catererStats.pool, 10);
  assert.equal(results.catererStats.newToZoho, 1);
  assert.equal(results.reedStats.pool, 30);
  assert.equal(results.reedStats.newToZoho, 1);
  assert.equal(results.reedStats.phase1.skippedDb, 2);
  const rr = db.runResults();
  assert.equal(JSON.parse(rr[0].reed_json).pool, 30);
  assert.equal(rr[0].sources, 'both');
});

test('no zoho traffic and no file changes outside the workspace directories', async () => {
  reset(['3101']);
  const before = fs.readdirSync(ws.root).sort();
  await execute({ candidates: [card('3101')], keepState: true });
  assert.deepEqual(fs.readdirSync(ws.root).sort(), before);
});

// ---------------------------------------------------------------------------------------------
// credits read: the parent must outlast the child's own budget
// ---------------------------------------------------------------------------------------------

test('credits fallback: the child gets 120 s, longer than the 40+40+25 s budget of caterer-get-credits.js', () => {
  assert.equal(pq.CREDITS_TIMEOUT_MS, 120000);
  let seen;
  const ok = pq.getCreditsReal({ exec: (cmd, args, o) => { seen = { cmd, args, o }; return '4242\n'; } });
  assert.deepEqual(ok, { credits: '4242', source: 'phase2-fallback' });
  assert.equal(seen.o.timeout, 120000);
  assert.equal(seen.cmd, process.execPath);
  assert.equal(seen.args.length, 1);
  assert.match(seen.args[0], /caterer-get-credits\.js$/);
  // exit 2 = the script could not read the page and printed its stale fallback value
  const stale = pq.getCreditsReal({ exec: () => { const e = new Error('exit 2'); e.status = 2; e.stdout = '777\n'; throw e; } });
  assert.deepEqual(stale, { credits: '777', source: 'fallback-stale' });
  // killed by the timeout: no value, and the run goes on
  const killed = pq.getCreditsReal({ exec: () => { const e = new Error('spawnSync ETIMEDOUT'); e.code = 'ETIMEDOUT'; e.status = null; e.signal = 'SIGTERM'; throw e; } });
  assert.deepEqual(killed, { credits: null, source: 'phase2-completion' });
});

test('credits fallback: no 30 s timeout is left on the caterer-get-credits call', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'resourcer', 'scripts', 'process-approved-queue.js'), 'utf8');
  const body = src.slice(src.indexOf('function getCreditsReal'), src.indexOf('async function getZohoIdFromDb'));
  assert.match(body, /timeout: CREDITS_TIMEOUT_MS/);
  assert.doesNotMatch(body, /timeout:\s*30000/);
  assert.match(src, /const CREDITS_TIMEOUT_MS = 120000;/);
  assert.equal(pq.DEFAULT_CONFIG.childTimeoutMs, 150000, 'the CV download child gets 150 s: caterer-download-cv.js budgets 60 s to 135 s of its own (was 30 s, shorter than the child)');
});

// ---------------------------------------------------------------------------------------------
// run_results against the dashboard contract (docs/parity/dashboard.md section 5)
// ---------------------------------------------------------------------------------------------

const DASHBOARD_REQUIRED = ['date', 'new_to_zoho', 'downloaded', 'duplicates', 'errors'];
const DASHBOARD_COUNT_KEYS = ['pool', 'newToZoho', 'downloaded', 'duplicates', 'skipped', 'errors', 'phase1', 'authFailed', 'authFailureReason'];

test('run_results: the table is created when absent, with the dashboard columns, and the row carries the required subset', async () => {
  reset(['7101']);
  const before = db.open();
  assert.equal(before.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'run_results'").get().n, 0, 'fixture starts without the table');
  before.close();
  const { res } = await execute({ candidates: [card('7101')], keepState: true });
  assert.equal(res.runResultsWritten, true);
  const d = db.open();
  try {
    const cols = d.prepare('PRAGMA table_info(run_results)').all().map(c => c.name);
    assert.deepEqual(cols, require('../../resourcer/scripts/migrate-schema').RUN_RESULTS_COLUMNS.map(c => c[0]));
    assert.equal(d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_run_results_date'").get().n, 1);
  } finally { d.close(); }
  const [row0] = db.runResults();
  for (const k of DASHBOARD_REQUIRED) assert.notEqual(row0[k], null, k);
  assert.match(row0.date, /^\d{4}-\d{2}-\d{2}$/);
  for (const k of ['new_to_zoho', 'downloaded', 'duplicates', 'errors']) assert.equal(Number.isInteger(row0[k]), true, k);
});

test('run_results: a partial older table is repaired by the writer instead of failing the run', async () => {
  reset(['7102']);
  const d = db.open();
  d.exec('CREATE TABLE run_results (run_key TEXT PRIMARY KEY, date TEXT NOT NULL, new_to_zoho INTEGER)');
  d.close();
  const { res } = await execute({ candidates: [card('7102')], keepState: true });
  assert.equal(res.runResultsWritten, true);
  const [row0] = db.runResults();
  assert.equal(row0.new_to_zoho, 1);
  assert.equal(row0.downloaded, 1);
  assert.equal(row0.sources, 'caterer');
});

test('run_results: the per-source JSON holds counts only (no names, no candidate rows)', async () => {
  reset(['7103'], { reedIds: ['7104'] });
  await withSources('both', () => execute({
    candidates: [card('7103'), card('7104', { source: 'reed', cvUrl: undefined })], keepState: true,
    queueExtra: { sources: 'both', phase1Stats: { caterer: { pagesScraped: 1, approved: 1 }, reed: { pool: 3, pagesScraped: 1, approved: 1, authFailed: false } } },
  }));
  const [row0] = db.runResults();
  for (const col of ['caterer_json', 'reed_json']) {
    const obj = JSON.parse(row0[col]);
    for (const k of Object.keys(obj)) assert.ok(DASHBOARD_COUNT_KEYS.includes(k), `${col}.${k}`);
    assert.doesNotMatch(row0[col], /Test Person|example\.invalid|07000/);
  }
});

test('run_results: sources is always caterer, reed or both', async () => {
  const backfill = require('../../resourcer/scripts/backfill-run-results');
  const base = { date: '2026-09-29' };
  for (const [given, want] of [['both', 'both'], [' Both ', 'both'], ['REED', 'reed'], ['caterer', 'caterer'], ['caterer+reed', 'caterer'], ['both,reed', 'caterer'], ['', 'caterer'], [null, 'caterer'], [undefined, 'caterer'], [7, 'caterer']]) {
    assert.equal(backfill.buildRunResultRow({ ...base, sources: given }, 'k').sources, want, JSON.stringify(given));
  }
  assert.equal(backfill.buildRunResultRow({ ...base, sources: 'nonsense' }, 'k', { sources: 'reed' }).sources, 'reed', 'a valid queue value fills in for a bad results value');
  // and through the live writer: a padded, upper-case value in the queue is normalised end to end
  reset(['7105']);
  const { results } = await withSources('both', () => execute({ candidates: [card('7105')], keepState: true, queueExtra: { sources: ' BOTH ' } }));
  assert.equal(results.sources, 'both');
  assert.equal(db.runResults()[0].sources, 'both');
  reset(['7106']);
  const r2 = await withSources(undefined, () => execute({ candidates: [card('7106')], keepState: true, queueExtra: { sources: 'caterer+reed' } }));
  assert.equal(r2.results.sources, 'caterer');
  assert.equal(db.runResults()[0].sources, 'caterer');
});

test('run_results: downloaded is the number of CVs that needed downloading (legacy dlCount), total is the fallback', async () => {
  reset(['7111', '7112', '7113']);
  writeCv(ws, '7112');
  const { results } = await execute({ candidates: [card('7111'), card('7112'), card('7113')], keepState: true });
  assert.equal(results.total, 3);
  assert.equal(results.downloaded, 2, 'one CV was already on disk');
  const [row0] = db.runResults();
  assert.equal(row0.downloaded, 2);
  assert.equal(row0.new_to_zoho, 3);
  const backfill = require('../../resourcer/scripts/backfill-run-results');
  assert.equal(backfill.buildRunResultRow({ date: '2026-09-29', total: 5 }, 'k').downloaded, 5, 'legacy files without downloaded fall back to total');
  assert.equal(backfill.buildRunResultRow({ date: '2026-09-29', downloaded: 0, total: 5 }, 'k').downloaded, 0, 'an explicit zero is kept');
  assert.equal(backfill.buildRunResultRow({ date: '2026-09-29' }, 'k').downloaded, null);
});

test('a Caterer candidate that carries encId is downloaded through the browser script, never with a node fetch; without encId the direct fetch is the fallback', async () => {
  reset(['6601', '6602']);
  const qf = writeQueue(ws, QUEUE, { candidates: [card('6601', { encId: 'ENC6601', auditId: 'AUD6601' }), card('6602')] });
  const built = buildDeps(ws, { zoho });
  const viaScript = [];
  built.deps.downloadCvViaScript = async (encId, auditId, id) => {
    viaScript.push([encId, auditId, id]);
    writeCv(ws, id);
    return { cvPath: path.join(ws.downloads, 'cv-' + id + '.pdf'), size: 300 };
  };
  const cap = captureConsole();
  let res;
  try { res = await pq.run(qf, built.deps); } finally { cap.restore(); built.close(); }
  assert.equal(res.code, 0);
  assert.deepEqual(viaScript, [['ENC6601', 'AUD6601', '6601']]);
  assert.equal(built.calls.fetchCv, 1, 'only the candidate without encId used the direct fetch');
});

test('a run cut short by a screening outage pushes what it approved but does not mark the territory searched and keeps the pending search, released for the next run', async () => {
  reset(['6701']);
  fs.mkdirSync(ws.pending, { recursive: true });
  const pendingFile = path.join(ws.pending, 'territory-9-20260929-1000.json');
  fs.writeFileSync(pendingFile, JSON.stringify({ jobTitle: 'Chef', location: 'LS1', sources: 'caterer', spawnedAt: '2026-09-29T10:00:00.000Z' }));
  const { res, results, built } = await execute({
    candidates: [card('6701')], keepState: true,
    queueExtra: { phase1Stats: { pagesScraped: 2, approved: 1, skippedDb: 0, skippedReview: 0, errors: 1, totalCandidatesSeen: 6, incomplete: 'screening-unavailable' } },
  });
  assert.equal(res.code, 0);
  assert.equal(results.new, 1);
  assert.equal(results.incomplete, 'screening-unavailable');
  assert.deepEqual(built.calls.upsert, [], 'the territory is not marked searched');
  const kept = ws.readJson(pendingFile);
  assert.equal(kept.jobTitle, 'Chef');
  assert.equal(kept.spawnedAt, undefined, 'the claim stamp is gone so the gate offers the file again');
});
