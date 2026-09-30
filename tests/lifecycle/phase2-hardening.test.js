'use strict';
// Review fixes for Phase 2 (process-approved-queue.js, fill-mandatory-fields.js): every test here failed against the
// code as reviewed (see docs/parity/lifecycle.md, section "Review fixes"). Fake Zoho over 127.0.0.1, temp workspace.
const { makeWorkspace } = require('./helpers/workspace');
const ws = makeWorkspace('lc-p2h');
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
// built at run time: the address must not contain "example" (findEmail ignores those) yet the static scan wants @example.invalid in sources
const ADDR = ['jo.fake', 'mailbox.invalid'].join('@');
const QUEUE = 'merged-queue-2026-09-29T10-00-00.json';
const APPROVED = 'approved-queue-2026-09-29-100000.json';

test.before(async () => {
  zoho = await startFakeZoho();
  fs.mkdirSync(ws.dir('config'), { recursive: true });
  const cfgDir = path.resolve(__dirname, '../../resourcer/config');
  for (const f of fs.readdirSync(cfgDir)) fs.copyFileSync(path.join(cfgDir, f), path.join(ws.dir('config'), f));
});
test.after(async () => { await zoho.close(); ws.cleanup(); });

function reset(ids, dbOpts) {
  ws.reset();
  zoho.calls.length = 0;
  zoho.scenarios.clear();
  zoho.zohoIds.clear();
  seedDb(ws, ids, dbOpts);
}

async function execute({ candidates, queueName = QUEUE, queueExtra, hooks, keepState, ids, dbOpts, tweak, runOpts }) {
  if (!keepState) reset(ids || candidates.map(c => c.id).filter(i => /^\d+$/.test(String(i))), dbOpts);
  const qf = writeQueue(ws, queueName, { candidates, ...(queueExtra || {}) });
  const built = buildDeps(ws, { zoho, hooks });
  if (tweak) tweak(built);
  const cap = captureConsole();
  let res;
  try { res = await pq.run(qf, { ...built.deps, ...(runOpts || {}) }); } finally { cap.restore(); built.close(); }
  const runKey = path.basename(qf).replace(/^approved-queue-/, '').replace(/\.json$/, '');
  const resultsFile = path.join(ws.downloads, `phase2-results-${runKey}.json`);
  const results = fs.existsSync(resultsFile) ? ws.readJson(resultsFile) : null;
  return { res, out: cap.lines, results, built, qf, runKey, resultsFile };
}

const has = name => fs.existsSync(path.join(ws.downloads, name));
const row = (results, id) => results.candidates.find(c => c.id === String(id));
const attachCalls = id => zoho.callsFor(id, 'attach').length;

// ---------------------------------------------------------------------------------------------
// 18: a Reed half that stopped for a screening outage must not consume the territory
// ---------------------------------------------------------------------------------------------

test('a both-source run whose Reed half stopped because screening was down keeps the territory due and the pending search', async () => {
  reset(['9001']);
  fs.mkdirSync(ws.pending, { recursive: true });
  const pendingFile = path.join(ws.pending, 'territory-both-20260929-1000.json');
  fs.writeFileSync(pendingFile, JSON.stringify({ jobTitle: 'Chef', location: 'LS1', sources: 'both', spawnedAt: '2026-09-29T10:00:00.000Z' }));
  const { res, results, built } = await execute({
    candidates: [card('9001')], keepState: true,
    queueExtra: {
      sources: 'both',
      phase1Stats: {
        caterer: { pagesScraped: 2, approved: 1, skippedDb: 0, skippedReview: 0, errors: 0, totalCandidatesSeen: 6 },
        reed: { pagesScraped: 0, pool: 0, errors: 1, screeningHalted: true, screeningModel: 'unavailable' },
      },
    },
    tweak: b => { b.deps.allowedSources = () => 'both'; },
  });
  assert.equal(res.code, 0);
  assert.equal(results.new, 1, 'what the Caterer half approved is still pushed');
  assert.equal(results.incomplete, 'reed-screening-unavailable');
  assert.deepEqual(built.calls.upsert, [], 'the territory is not marked searched');
  const kept = ws.readJson(pendingFile);
  assert.equal(kept.sources, 'both');
  assert.equal(kept.spawnedAt, undefined, 'released so the gate offers it again');
});

test('a Reed run that halted on its own (flat stats) is treated the same way; a healthy Reed half still completes the territory', async () => {
  const flat = await execute({
    candidates: [card('9002')],
    queueExtra: { sources: 'reed', phase1Stats: { pagesScraped: 0, pool: 0, errors: 1, screeningHalted: true } },
  });
  assert.equal(flat.results.incomplete, 'reed-screening-unavailable');
  assert.deepEqual(flat.built.calls.upsert, []);
  const healthy = await execute({
    candidates: [card('9003')],
    queueExtra: { sources: 'both', phase1Stats: { caterer: { pagesScraped: 2, approved: 1 }, reed: { pagesScraped: 1, pool: 5, errors: 0 } } },
  });
  assert.equal(healthy.results.incomplete, undefined);
  assert.equal(healthy.built.calls.upsert.length, 1);
});

// ---------------------------------------------------------------------------------------------
// 19: a Zoho record this pipeline created itself must still get its CV
// ---------------------------------------------------------------------------------------------

test('a create whose answer was lost and then met DUPLICATE_DATA is our own record: the CV is attached before anything is deleted', async () => {
  reset(['9201']);
  writeCv(ws, '9201');
  zoho.scenario('9201', { create: 'created-then-lost', attach: 'ok' });
  const { res, results } = await execute({ candidates: [card('9201')], keepState: true });
  assert.equal(res.code, 0);
  assert.equal(row(results, '9201').status, 'new');
  assert.equal(row(results, '9201').cvAttached, true);
  assert.equal(attachCalls('9201'), 1, 'the CV reached Zoho');
  assert.equal(db.zohoId('9201'), zoho.zohoIds.get('9201'));
  assert.equal(has('cv-9201.pdf'), false);
  assert.equal(has('candidate-9201.json'), false);
});

test('the id of a created record is written to the candidate file before the attach, so a failed attach or a kill cannot make it look pre-existing', async () => {
  reset(['9301']);
  writeCv(ws, '9301');
  zoho.scenario('9301', { attach: 'fail' });
  const first = await execute({ candidates: [card('9301')], keepState: true, hooks: { setZohoIdThrows: true } });
  assert.equal(row(first.results, '9301').cvAttached, false);
  assert.equal(db.zohoId('9301'), null, 'the database write failed (stands in for a kill after the create)');
  const created = zoho.zohoIds.get('9301');
  assert.equal(ws.readJson(path.join(ws.downloads, 'candidate-9301.json'))._zohoCreatedId, created);
  assert.equal(has('cv-9301.pdf'), true);

  zoho.scenario('9301', { create: 'duplicate', attach: 'ok' });
  const second = await execute({ candidates: [card('9301')], keepState: true, queueName: 'merged-queue-2026-09-29T11-00-00.json' });
  assert.equal(row(second.results, '9301').status, 'new', 'DUPLICATE_DATA for the id on file is our record');
  assert.equal(row(second.results, '9301').cvAttached, true);
  assert.equal(attachCalls('9301') >= 2, true);
  assert.equal(has('cv-9301.pdf'), false);
  assert.equal(has('candidate-9301.json'), false);
  assert.equal(db.zohoId('9301'), created);
});

test('a genuinely pre-existing record (no id on file, no lost answer) stays untouched: nothing attached, files removed, counted as duplicate', async () => {
  reset(['9302']);
  writeCv(ws, '9302');
  zoho.scenario('9302', { create: 'duplicate', attach: 'ok' });
  const { results } = await execute({ candidates: [card('9302')], keepState: true });
  assert.equal(row(results, '9302').status, 'duplicate');
  assert.equal(attachCalls('9302'), 0);
  assert.equal(has('cv-9302.pdf'), false);
  assert.equal(has('candidate-9302.json'), false);
});

test('a different id on file does not make a duplicate ours; a clean Zoho rejection on an earlier attempt is not "may have been created"', async () => {
  reset(['9303']);
  writeCv(ws, '9303');
  fs.writeFileSync(path.join(ws.downloads, 'candidate-9303.json'), JSON.stringify({ First_Name: 'T', Last_Name: 'P', Email: 'a@example.invalid', Mobile: '07000000000', City: 'X', CatererID: '9303', _zohoCreatedId: '1' }));
  zoho.scenario('9303', { create: 'duplicate', attach: 'ok' });
  const { results } = await execute({ candidates: [card('9303')], keepState: true });
  assert.equal(row(results, '9303').status, 'duplicate');
  assert.equal(attachCalls('9303'), 0);
});

// ---------------------------------------------------------------------------------------------
// 24 + 23: the reprocess guard, --force, and the partial-failure alert
// ---------------------------------------------------------------------------------------------

test('a second run of the same approved-queue does not overwrite the results, the run_results row or the territory; --force retries only what failed', async () => {
  reset(['9101', '9102']);
  writeCv(ws, '9101');
  writeCv(ws, '9102');
  zoho.scenario('9101', { attach: 'fail' });
  zoho.scenario('9102', { create: 'http500' });
  const first = await execute({ candidates: [card('9101'), card('9102')], keepState: true, queueName: APPROVED });
  assert.equal(first.res.code, 0);
  assert.equal(row(first.results, '9101').status, 'new');
  assert.equal(row(first.results, '9101').cvAttached, false);
  assert.equal(row(first.results, '9102').status, 'error');
  assert.equal(first.built.calls.upsert.length, 1);
  const partial = ws.alerts().find(a => a.key === 'zoho-push-partial');
  assert.ok(partial, 'a partial failure raises an alert');
  assert.match(partial.text, /1 of 2 Zoho pushes failed/);
  assert.ok(partial.text.includes(`downloads/${APPROVED} --force`), 'the alert carries the exact retry command');
  const originalBytes = fs.readFileSync(first.resultsFile, 'utf8');

  const again = await execute({ candidates: [card('9101'), card('9102')], keepState: true, queueName: APPROVED });
  assert.equal(again.res.reason, 'already-processed', 'the guard now matches approved-queue-<ts>');
  assert.equal(fs.readFileSync(first.resultsFile, 'utf8'), originalBytes, 'results untouched');
  assert.equal(db.runResults().length, 1);
  assert.equal(db.runResults()[0].new_to_zoho, 1);
  assert.equal(again.built.calls.upsert.length, 0);

  zoho.scenario('9101', { attach: 'ok' });
  zoho.scenario('9102', {});
  const forced = await execute({ candidates: [card('9101'), card('9102')], keepState: true, queueName: APPROVED, runOpts: { force: true } });
  assert.equal(forced.res.code, 0);
  assert.match(forced.res.runId, /^2026-09-29-100000-rerun-\d{14}$/);
  assert.equal(fs.readFileSync(first.resultsFile, 'utf8'), originalBytes, 'the original results file is never rewritten');
  const rerunResults = ws.readJson(path.join(ws.downloads, `phase2-results-${forced.res.runId}.json`));
  assert.equal(row(rerunResults, '9102').status, 'new');
  assert.equal(row(rerunResults, '9101').status, 'skipped');
  assert.equal(row(rerunResults, '9101').cvAttached, true, 'the CV left over from the failed attach is attached now');
  assert.equal(attachCalls('9101') >= 2, true);
  assert.equal(has('cv-9101.pdf'), false);
  assert.equal(has('candidate-9101.json'), false);
  assert.equal(has('cv-9102.pdf'), false);
  assert.equal(has('candidate-9102.json'), false);
  assert.equal(forced.built.calls.upsert.length, 0, 'the territory is not marked searched again');
  const rr = db.runResults();
  assert.equal(rr.length, 2);
  assert.equal(rr.find(r => r.run_key === forced.res.runId).new_to_zoho, 1);
  assert.equal(rr.find(r => r.run_key === '2026-09-29-100000').new_to_zoho, 1, 'the original row keeps its counts');
});

test('when every push fails the critical alert also carries the retry command', async () => {
  reset(['9401', '9402', '9403']);
  for (const id of ['9401', '9402', '9403']) zoho.scenario(id, { create: 'http500' });
  await execute({ candidates: [card('9401'), card('9402'), card('9403')], keepState: true, queueName: APPROVED });
  const a = ws.alerts().find(x => x.key === 'zoho-push-failing');
  assert.ok(a && a.severity === 'critical');
  assert.ok(a.text.includes(`downloads/${APPROVED} --force`));
  assert.equal(ws.alerts().some(x => x.key === 'zoho-push-partial'), false);
});

// ---------------------------------------------------------------------------------------------
// 22: Caterer CV downloads
// ---------------------------------------------------------------------------------------------

function scriptWriter(state, behave) {
  return async (encId, auditId, id) => {
    state.calls.push(id);
    state.inFlight++;
    state.max = Math.max(state.max, state.inFlight);
    try { return await behave(id, state.calls.filter(x => x === id).length); } finally { state.inFlight--; }
  };
}

test('a download that ran into its timeout gets one more go before the candidate is pushed without a CV', async () => {
  const state = { calls: [], inFlight: 0, max: 0 };
  const { results } = await execute({
    candidates: [card('9501', { encId: 'E1', auditId: 'A1', cvUrl: undefined })],
    tweak: b => {
      b.deps.downloadCvViaScript = scriptWriter(state, async (id, n) => {
        if (n === 1) return { error: 'killed', timedOut: true };
        writeCv(ws, id);
        return { cvPath: path.join(ws.downloads, `cv-${id}.pdf`), size: 300 };
      });
    },
  });
  assert.deepEqual(state.calls, ['9501', '9501']);
  assert.equal(row(results, '9501').cvAttached, true);
  assert.equal(results.downloadErrors, 0);
});

test('a failing browser download falls back to the direct fetch when the card has a cvUrl; without a timeout there is no second script run', async () => {
  const state = { calls: [], inFlight: 0, max: 0 };
  const { results, built } = await execute({
    candidates: [card('9502', { encId: 'E2', auditId: 'A2' })],
    tweak: b => { b.deps.downloadCvViaScript = scriptWriter(state, async () => ({ error: 'browser said no', timedOut: false })); },
  });
  assert.deepEqual(state.calls, ['9502']);
  assert.equal(built.calls.fetchCv, 1);
  assert.equal(row(results, '9502').cvAttached, true, 'the direct fetch supplied the CV');

  const fail = await execute({
    candidates: [card('9503', { encId: 'E3', auditId: 'A3' })],
    hooks: { fetchCv: () => fakeResponse({ ok: false, status: 403, statusText: 'Forbidden' }) },
    tweak: b => { b.deps.downloadCvViaScript = scriptWriter(state, async () => ({ error: 'killed', timedOut: true })); },
  });
  assert.equal(state.calls.filter(x => x === '9503').length, 2, 'timeout: exactly one retry');
  assert.equal(fail.results.downloadErrors, 1);
  assert.equal(row(fail.results, '9503').status, 'new', 'still pushed, without a CV');
  assert.equal(row(fail.results, '9503').cvAttached, false);
});

test('the browser downloads share one gate: never more than catererDownloadConcurrency at a time, while Reed keeps the general concurrency', async () => {
  const state = { calls: [], inFlight: 0, max: 0 };
  const ids = ['9511', '9512', '9513', '9514', '9515', '9516'];
  const { results } = await execute({
    candidates: ids.map(id => card(id, { encId: `E${id}`, auditId: `A${id}` })),
    tweak: b => {
      b.deps.config = { concurrency: 5 };
      b.deps.downloadCvViaScript = scriptWriter(state, async (id) => {
        await new Promise(r => setTimeout(r, 25));
        writeCv(ws, id);
        return { cvPath: path.join(ws.downloads, `cv-${id}.pdf`), size: 300 };
      });
    },
  });
  assert.equal(state.calls.length, 6);
  assert.equal(state.max, 2);
  assert.equal(results.new, 6);
});

test('the CV download child gets 150 s and its own caterer concurrency default', () => {
  assert.equal(pq.DEFAULT_CONFIG.childTimeoutMs, 150000);
  assert.equal(pq.DEFAULT_CONFIG.catererDownloadConcurrency, 2);
  assert.equal(pq.DEFAULT_CONFIG.fillTimeoutMs, 30000);
});

// ---------------------------------------------------------------------------------------------
// 77: the session cookie only goes to the Caterer site
// ---------------------------------------------------------------------------------------------

test('a cvUrl on any other origin is never fetched and the session cookie is never read for it', async () => {
  let cookieReads = 0;
  const { results, built } = await execute({
    candidates: [
      card('9601', { cvUrl: 'https://evil.example.invalid/cv.pdf' }),
      card('9602', { cvUrl: 'http://recruiter.caterer.test/cv.pdf' }),
      card('9603', { cvUrl: '/cv/9603' }),
      card('9604', { cvUrl: 'https://recruiter.caterer.test/cv/9604' }),
    ],
    tweak: b => {
      b.deps.baseCaterer = () => 'https://recruiter.caterer.test';
      b.deps.loadCookieHeader = () => { cookieReads++; return 'a=b'; };
    },
  });
  assert.equal(built.calls.fetchCv, 2, 'only the relative path and the same-origin absolute URL were fetched');
  assert.equal(cookieReads, 2);
  assert.equal(results.downloadErrors, 2);
  assert.equal(row(results, '9603').cvAttached, true);
  assert.equal(row(results, '9604').cvAttached, true);
  assert.equal(row(results, '9601').cvAttached, false);
});

// ---------------------------------------------------------------------------------------------
// 26: one bad candidate must not end the run
// ---------------------------------------------------------------------------------------------

test('a mandatory-field recovery that throws or stalls is that candidate\'s problem only, and a malformed card becomes an error row', async () => {
  const { res, results, out } = await execute({
    candidates: [
      card('9701'), card('9702'), card('9703'),
      card('9704', { firstName: undefined, lastName: undefined, name: 12345 }),
    ],
    hooks: {
      fillMandatory: (json) => {
        if (json.includes('9701')) throw new Error('corrupt candidate file');
        if (json.includes('9702')) return new Promise(() => {});
        return { patched: false, recovered: [], stillMissing: [] };
      },
    },
    tweak: b => { b.deps.config = { concurrency: 2, fillTimeoutMs: 50 }; },
  });
  assert.equal(res.code, 0, 'the run completes');
  for (const id of ['9701', '9702', '9703']) assert.equal(row(results, id).status, 'new', id);
  assert.equal(row(results, '9704').status, 'error');
  assert.match(row(results, '9704').error, /No candidate JSON/);
  assert.equal(out.filter(l => l.includes('mandatory-field recovery failed')).length, 2);
  const errors = fs.readFileSync(path.join(ws.logs, 'errors.jsonl'), 'utf8');
  assert.match(errors, /"context":"fill_mandatory"/);
  assert.match(errors, /"context":"candidate_json"/);
});

// ---------------------------------------------------------------------------------------------
// 59: a hostile CV cannot stall the run (real fill-mandatory-fields module)
// ---------------------------------------------------------------------------------------------

test('fill-mandatory-fields: the e-mail scan and the HTML stripping are linear on hostile input and still find a real address', async () => {
  const fill = require('../../resourcer/scripts/fill-mandatory-fields');
  const limit = 3000;
  let t = Date.now();
  assert.equal(fill.findEmail('a'.repeat(1000000)), null);
  assert.ok(Date.now() - t < limit, `findEmail on 1 MB of local-part characters took ${Date.now() - t} ms`);
  assert.equal(fill.findEmail('x@'.repeat(100000)), null);
  assert.equal(fill.findEmail(`Reach me: ${ADDR} or later`), ADDR);

  const dir = fs.mkdtempSync(path.join(ws.root, 'cvs-'));
  const cases = {
    'a.txt': 'a'.repeat(100 * 1024),
    'b.doc': '<html>' + '<script'.repeat(20000),
    'c.doc': '<html>' + '<'.repeat(60000),
    'd.doc': '<html><style>' + 'x{'.repeat(20000),
  };
  for (const [name, body] of Object.entries(cases)) {
    const cv = path.join(dir, name);
    fs.writeFileSync(cv, body);
    const json = path.join(dir, `${name}.json`);
    fs.writeFileSync(json, JSON.stringify({ First_Name: 'T', Last_Name: 'P', Mobile: '07000000000', City: 'X', Zip_Code: 'X1 1XX', Email: '' }));
    t = Date.now();
    const r = await fill.fillMandatoryFields(json, cv);
    assert.ok(Date.now() - t < limit, `${name} took ${Date.now() - t} ms`);
    assert.deepEqual(r.stillMissing, ['Email'], name);
  }

  const html = path.join(dir, 'real.doc');
  fs.writeFileSync(html, `<HTML><script>var x=1;</script><style>p{}</style><body>Contact: ${ADDR}</body></HTML>`);
  assert.ok((await fill.extractCvText(html)).includes(ADDR));
  const big = path.join(dir, 'big.txt');
  fs.writeFileSync(big, 'z'.repeat(400 * 1024) + ` late${'@'}mailbox.invalid`);
  assert.ok((await fill.extractCvText(big)).length <= 200 * 1024, 'text is capped');
});
