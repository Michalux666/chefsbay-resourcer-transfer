'use strict';
// Phase 2 and the three modes of CV_SCREEN: the default (shadow), off as a strict no-op, and the early stop of a shadow queue when
// the gateway hangs or fails. Also the whole chain for a gateway that refuses requests (the per-CV answers_invalid, the streak
// guard, and what each mode does with the outage that follows).
const P = require('./helpers/phase2-run');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ws, R, has, rowOf, setup, writeCvFile, execute, rejections, halt } = P;
const { startFakeJev } = require('./helpers/fake-jev');
const { role, cvText } = require('./helpers/fixtures');

test.before(P.start);
test.after(P.stop);

const NO_FILL = { fillMandatory: () => ({ patched: false, recovered: [], stillMissing: [] }) };
const idsFrom = (base, n) => Array.from({ length: n }, (_, i) => String(base + i));
const shadowDir = () => path.join(ws.home, 'shadow');
const shadowRows = () => (fs.existsSync(shadowDir()) ? fs.readdirSync(shadowDir()).filter(n => /^cv-.*[.]jsonl$/.test(n)).flatMap(n => fs.readFileSync(path.join(shadowDir(), n), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))) : []);
const savedEnv = {};
function envSet(map) { for (const [k, v] of Object.entries(map)) { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
test.afterEach(() => { for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; delete savedEnv[k]; } });
function pointAt(g) { envSet({ SCREEN_GATEWAY_ORIGIN: g.origin, AI_GATEWAY_API_KEY: g.key, SCREEN_BACKOFF_BASE_MS: '1', SCREEN_MAX_ATTEMPTS: '2' }); }
const cdp = () => cvText([role('Chef de Partie', '2021-04', 'present'), role('Chef de Partie', '2018-02', '2021-03')]);
const porter = () => cvText([role('Kitchen Porter', '2020-09', 'present'), role('Kitchen Porter', '2016-09', '2020-08')]);

// ---- (a) the default is shadow ----------------------------------------------------------------------------------------------

test('nothing configured: Phase 2 runs the CV stage in shadow mode, evaluates every CV, blocks nothing and labels the log rows shadow', async () => {
  const gw = P.state.gw;
  gw.reset();
  pointAt(gw);
  envSet({ CV_SCREEN: undefined });
  const ids = ['7101', '7102'];
  setup(ids);
  writeCvFile('7101', cdp());
  writeCvFile('7102', porter());
  const { res, results, built, out } = await execute({ ids, keepState: true, useRealCli: true, defaultMode: true, queueExtra: { jobTitle: 'Head Chef' }, hooks: NO_FILL });
  assert.equal(res.code, 0);
  assert.equal(built.calls.create, 2, 'both go to Zoho: shadow never blocks, whatever the decision');
  assert.equal(results.new, 2);
  assert.equal(results.cvRejected, 0);
  assert.equal(results.cvScreen.mode, 'shadow');
  assert.equal(results.cvScreen.screened, 2);
  assert.equal(results.cvScreen.reject, 2, 'what it WOULD have rejected: a chef de partie and a porter for a head chef search');
  assert.equal(rejections().length, 0, 'no rejection is recorded in shadow');
  assert.equal(halt.getHalt(), null);
  const rows = shadowRows();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.mode === 'shadow' && r.final === 'reject' && r.runId === P.RUN_KEY), JSON.stringify(rows.map(r => [r.mode, r.final])));
  assert.ok(out.some(l => l.includes('Step 4.6 - CV screening (shadow')));
  assert.equal(has('cv-7101.pdf'), false, 'cleaned after the push, as ever');
});

test('an unrecognised CV_SCREEN value is shadow with a warning, never on', async () => {
  const gw = P.state.gw;
  pointAt(gw);
  envSet({ CV_SCREEN: 'enforce' });
  const ids = ['7151'];
  setup(ids);
  writeCvFile('7151', porter());
  const { results, built } = await execute({ ids, keepState: true, useRealCli: true, defaultMode: true, queueExtra: { jobTitle: 'Head Chef' }, hooks: NO_FILL });
  assert.equal(results.cvScreen.mode, 'shadow');
  assert.equal(built.calls.create, 1);
  assert.equal(rejections().length, 0);
});

test('CV_SCREEN=off is a strict no-op: no reviewer, no reviewer process, no CV keys in the results, no file of the stage, the same console output as without the stage', async () => {
  const gw = P.state.gw;
  gw.reset();
  pointAt(gw);
  envSet({ CV_SCREEN: 'off' });
  const ids = ['7201', '7202'];
  setup(ids);
  writeCvFile('7201', porter());
  writeCvFile('7202', cdp());
  const a = await execute({ ids, keepState: true, useRealCli: true, defaultMode: true, queueExtra: { jobTitle: 'Head Chef' }, hooks: NO_FILL });
  assert.equal(a.res.code, 0);
  assert.equal(gw.stats().requests, 0, 'Jev is never asked');
  assert.equal(a.built.calls.create, 2);
  assert.deepEqual(Object.keys(a.results).filter(k => ['cvRejected', 'cvScreen'].includes(k)), []);
  assert.equal(a.out.some(l => /CV screening|cv-review|Step 4\.6/i.test(l)), false);
  for (const d of ['shadow', 'state', 'runtime']) {
    const dir = path.join(ws.home, d);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => /^cv-|cv-answers|cv-search/.test(n)) : [];
    assert.deepEqual(files, [], d);
  }
  assert.deepEqual(a.results.candidates.map(c => c.status).sort(), ['new', 'new']);
});

// ---- (d) a shadow queue stops early when screening does not work ---------------------------------------------------------------

test('shadow: five CVs in a row that cannot be screened stop the queue, the rest is skipped, one warning alert, nothing blocked, nothing lost, no halt', async () => {
  const ids = idsFrom(7300, 12);
  const { res, results, built, seen, out } = await execute({ ids, mode: 'shadow', config: { cvScreenConcurrency: 1 }, scenario: Object.fromEntries(ids.map(id => [id, R.outage])) });
  assert.equal(res.code, 0);
  assert.equal(seen.calls.length, 5, 'the reviewer was called for five CVs only');
  assert.equal(built.calls.create, 12, 'every candidate went to Zoho as before');
  assert.equal(results.new, 12);
  assert.equal(results.cvRejected, 0);
  assert.equal(results.cvScreen.shadowStopped, true);
  assert.equal(results.cvScreen.unscreened, 12);
  assert.equal(results.cvScreen.screened, 0);
  assert.equal(halt.getHalt(), null, 'shadow never raises the halt');
  const alerts = ws.alerts().filter(a => a.key === 'cv-shadow-stopped');
  assert.equal(alerts.length, 1, 'one warning per queue');
  assert.equal(alerts[0].severity, 'warn');
  assert.ok(alerts[0].text.includes('5 CVs in a row could not be screened'));
  assert.ok(alerts[0].text.includes('12 CV(s) of this queue were not screened'));
  assert.equal(ws.alerts().filter(a => a.severity === 'critical').length, 0);
  assert.ok(out.some(l => l.includes('stopped after 5 CVs in a row could not be screened')));
  assert.equal(rejections().length, 0);
});

test('shadow: a CV that needed Jev and got an answer resets the count; an unreadable file (no request) neither counts nor resets', async () => {
  // failure, failure, success, failure x4: never five in a row
  const a = idsFrom(7400, 10);
  const seqA = [R.outage, R.outage, R.pass, R.outage, R.outage, R.outage, R.outage, R.pass, R.outage, R.outage];
  const ra = await execute({ ids: a, mode: 'shadow', config: { cvScreenConcurrency: 1 }, scenario: Object.fromEntries(a.map((id, i) => [id, seqA[i]])) });
  assert.equal(ra.results.cvScreen.shadowStopped, false);
  assert.equal(ra.seen.calls.length, 10);
  assert.equal(ra.results.cvScreen.screened, 2);
  assert.equal(ra.results.cvScreen.unscreened, 8);
  assert.equal(ws.alerts().filter(x => x.key === 'cv-shadow-stopped').length, 0);
  assert.equal(ra.built.calls.create, 10);

  // failure x2, unreadable, failure x3: the unreadable one changes nothing, so the fifth failure stops the queue
  const b = idsFrom(7420, 9);
  const seqB = [R.outage, R.outage, R.unreadable, R.outage, R.outage, R.outage, R.pass, R.pass, R.pass];
  const rb = await execute({ ids: b, mode: 'shadow', config: { cvScreenConcurrency: 1 }, scenario: Object.fromEntries(b.map((id, i) => [id, seqB[i]])) });
  assert.equal(rb.results.cvScreen.shadowStopped, true);
  assert.equal(rb.seen.calls.length, 6);
  assert.equal(rb.built.calls.create, 9);
  assert.equal(ws.alerts().filter(x => x.key === 'cv-shadow-stopped').length, 1);
});

test('shadow: a reviewer that crashes or times out counts as a failure too, and the limit is configuration (phase2.shadowStopAfterFailures)', async () => {
  const ids = idsFrom(7450, 8);
  const mix = [R.broken, () => ({ code: null, result: null, detail: 'the reviewer did not answer in time' }), 'throw', R.pass, R.pass, R.pass, R.pass, R.pass];
  const r = await execute({ ids, mode: 'shadow', config: { cvScreenConcurrency: 1 }, cvOverrides: { phase2: { shadowStopAfterFailures: 3 } }, scenario: Object.fromEntries(ids.map((id, i) => [id, mix[i]])) });
  assert.equal(r.results.cvScreen.shadowStopped, true);
  assert.equal(r.seen.calls.length, 3);
  assert.equal(r.results.cvScreen.errors, 3);
  assert.equal(r.built.calls.create, 8);
  assert.ok(ws.alerts().some(x => x.key === 'cv-shadow-stopped' && x.text.includes('3 CVs in a row')));
});

test('shadow: reviewers that are still running when the queue stops are stopped at once (a hung gateway cannot hold Phase 2 for minutes)', async () => {
  const ids = idsFrom(7500, 40);
  const hang = req => new Promise(resolve => {
    const t = setTimeout(() => resolve(R.outage()), 60000);
    req.signal.addEventListener('abort', () => { clearTimeout(t); resolve({ code: null, result: null, aborted: true, detail: 'stopped' }); }, { once: true });
  });
  const slowFail = () => new Promise(resolve => setTimeout(() => resolve(R.outage()), 80));
  const scenario = Object.fromEntries(ids.map((id, i) => [id, i < 5 ? slowFail : hang]));
  const t0 = Date.now();
  const r = await execute({ ids, mode: 'shadow', config: { cvScreenConcurrency: 4 }, scenario });
  assert.ok(Date.now() - t0 < 20000, `took ${Date.now() - t0} ms`);
  assert.equal(r.results.cvScreen.shadowStopped, true);
  assert.equal(r.built.calls.create, 40);
  assert.equal(r.results.cvScreen.unscreened, 40);
  assert.ok(r.seen.calls.length <= 9, `${r.seen.calls.length} reviewers were started for 40 CVs`);
});

test('shadow: a screening halt that is already up skips the stage for the queue with one line, and Phase 2 goes on as before', async () => {
  const ids = ['7601', '7602'];
  setup(ids);
  for (const id of ids) writeCvFile(id);
  halt.setHalt('AI screening unavailable', 'test', { remedy: 'none', blockedRun: true });
  const { res, results, seen, out, built } = await execute({ ids, keepState: true, mode: 'shadow', scenario: {} });
  halt.clearHalt();
  assert.equal(res.code, 0);
  assert.deepEqual(seen.calls, []);
  assert.equal(built.calls.create, 2);
  assert.equal('cvScreen' in results, false);
  assert.ok(out.some(l => l.includes('CV screening (shadow) skipped: the screening halt is up')));
});

test('on: an outage still holds the queue at the FIRST failure, with nothing lost (the shadow stop does not apply)', async () => {
  const ids = idsFrom(7700, 6);
  const { res, built, seen } = await execute({ ids, mode: 'on', config: { cvScreenConcurrency: 1 }, scenario: { 7700: R.outage } });
  halt.clearHalt();
  assert.equal(res.code, 2);
  assert.equal(built.calls.create, 0);
  assert.deepEqual(seen.calls, ['7700']);
  for (const id of ids) assert.ok(has(`cv-${id}.pdf`));
  assert.equal(ws.alerts().filter(a => a.key === 'cv-shadow-stopped').length, 0);
});

test('shadow with the real reviewer and a failing gateway: the queue stops after five CVs and the gateway is not asked for the rest', async () => {
  const dead = await startFakeJev({ failFirst: 100000, failStatus: 503 });
  try {
    pointAt(dead);
    envSet({ CV_SCREEN: undefined });
    const ids = idsFrom(7800, 14);
    setup(ids);
    for (const id of ids) writeCvFile(id, cdp());
    const { res, results, built } = await execute({ ids, keepState: true, useRealCli: true, defaultMode: true, config: { cvScreenConcurrency: 1 }, hooks: NO_FILL });
    assert.equal(res.code, 0);
    assert.equal(built.calls.create, 14, 'nothing was blocked');
    assert.equal(results.cvScreen.shadowStopped, true);
    assert.equal(results.cvScreen.unscreened, 14);
    assert.ok(dead.stats().requests <= 5 * 4, `${dead.stats().requests} requests to the failing gateway`);
    assert.equal(halt.getHalt(), null);
    assert.equal(ws.alerts().filter(a => a.key === 'cv-shadow-stopped').length, 1);
  } finally { await dead.close(); }
});

// ---- (b) a gateway that refuses requests, in both modes ------------------------------------------------------------------------

test('on: refused requests are a per-CV fallback (policy approve); the third in a row is an outage that holds the queue with nothing lost', async () => {
  const g = await startFakeJev({ respond: (idx, body) => (body.questions.search_level ? null : { status: 422, body: { message: 'malformed' } }) });
  try {
    pointAt(g);
    const ids = idsFrom(7900, 5);
    setup(ids);
    for (const id of ids) writeCvFile(id, cvText([role('Chef de Partie', `${2010 + Number(id) % 10}-01`, 'present')]));
    const { res, results, built } = await execute({ ids, keepState: true, useRealCli: true, config: { cvScreenConcurrency: 1 }, hooks: NO_FILL });
    assert.equal(res.code, 2);
    assert.equal(results, null);
    assert.equal(built.calls.create, 0, 'nothing was pushed before the outage was known');
    for (const id of ids) assert.ok(has(`cv-${id}.pdf`), id);
    assert.equal(halt.getHalt().halted, true);
    assert.ok(ws.alerts().some(a => a.key === 'cv-screening-unavailable' && a.severity === 'critical'));
    assert.equal(rejections().length, 0);
  } finally { await g.close(); halt.clearHalt(); }
});

test('shadow: refused requests never block, the outage that follows the streak is only a warning, and five failures stop the queue', async () => {
  const g = await startFakeJev({ respond: (idx, body) => (body.questions.search_level ? null : { status: 400, body: { message: 'malformed' } }) });
  try {
    pointAt(g);
    const ids = idsFrom(7950, 9);
    setup(ids);
    for (const id of ids) writeCvFile(id, cvText([role('Chef de Partie', `${2010 + Number(id) % 10}-01`, 'present')]));
    const { res, results, built } = await execute({ ids, mode: 'shadow', keepState: true, useRealCli: true, config: { cvScreenConcurrency: 1 }, hooks: NO_FILL });
    assert.equal(res.code, 0);
    assert.equal(built.calls.create, 9, 'every candidate is pushed');
    assert.equal(results.cvScreen.review, 2, 'two CVs took the fallback lane before the streak guard escalated');
    assert.equal(results.cvScreen.shadowStopped, true);
    assert.equal(halt.getHalt(), null);
    assert.equal(ws.alerts().filter(a => a.severity === 'critical').length, 0);
    assert.equal(shadowRows().length, 2);
    assert.equal(rowOf(results, 7950).status, 'new');
  } finally { await g.close(); }
});

// ---- the reviewer process ---------------------------------------------------------------------------------------------------

const cvStage = require('../../resourcer/scripts/lib/cv/phase2');

test('runCli: the mode travels to the shadow row, an aborted signal returns at once without a process, and an abort while Jev hangs kills the reviewer', async () => {
  const gw = P.state.gw;
  gw.reset();
  pointAt(gw);
  setup([]);
  const f = path.join(ws.home, 'one.txt');
  fs.writeFileSync(f, cdp());
  const req = extra => ({ cand: { id: '7990', source: 'caterer' }, cvPath: f, jobTitle: 'Chef de Partie', known: {}, runId: 'run-x', timeoutMs: 30000, ...extra });

  const ok = await cvStage.runCli(req({ mode: 'shadow' }));
  assert.equal(ok.code, 0);
  assert.equal(ok.result.decision, 'pass');
  assert.deepEqual(shadowRows().map(r => [r.mode, r.runId, r.candidateId]), [['shadow', 'run-x', '7990']]);

  const pre = new AbortController();
  pre.abort();
  const t0 = Date.now();
  const none = await cvStage.runCli(req({ signal: pre.signal }));
  assert.equal(none.aborted, true);
  assert.ok(Date.now() - t0 < 500);

  const slow = await startFakeJev({ respond: () => ({ status: 200, body: {}, delayMs: 20000 }) });
  try {
    pointAt(slow);
    envSet({ SCREEN_JEV_TIMEOUT_MS: '20000', SCREEN_MAX_ATTEMPTS: '1' });
    const other = path.join(ws.home, 'two.txt');
    fs.writeFileSync(other, cvText([role('Sous Chef', '2019-01', 'present')]));
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 400);
    const r = await cvStage.runCli(req({ cvPath: other, signal: ac.signal, mode: 'shadow' }));
    assert.equal(r.aborted, true);
    assert.equal(r.code, null);
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  } finally { await slow.close(); }
});
