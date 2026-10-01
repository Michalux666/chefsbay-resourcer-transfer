'use strict';
// Update C, Phase 2 side of the CV stage:
//   F3  a broken or missing criteria file fails closed (mode on holds with its own halt reason, shadow stops the stage with one warn alert, nothing is
//       ever rejected on the strength of a broken file)
//   F5  candidate_rejections.reason_code is the first real reason, not the 'forced' marker
//   F6  the two CV counters reconcile after a hold, and run_results.skipped carries the CV rejections
//   F7  shadow mode is bounded in time (phase2.shadowMaxSeconds), not only against consecutive failures
//   F1  no Phase 1 unlock while the CV stage holds the pipeline (unlockBlocked), never in shadow or off
const P = require('./helpers/phase2-run');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('../lifecycle/helpers/sqlite');
const { ws, R, has, rowOf, setup, writeCvFile, execute, rejections, halt } = P;
const cvStage = require('../../resourcer/scripts/lib/cv/phase2');
const cvConfig = require('../../resourcer/scripts/lib/cv/config');
const health = require('../../resourcer/scripts/lib/screening-health');
const backfill = require('../../resourcer/scripts/backfill-run-results');

test.before(P.start);
test.after(P.stop);

const savedEnv = {};
function envSet(map) { for (const [k, v] of Object.entries(map)) { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
test.afterEach(() => { for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; delete savedEnv[k]; } halt.clearHalt(); });

const cfgFile = () => path.join(ws.home, 'config', 'cv-screening.json');
const alertsOf = key => ws.alerts().filter(a => a.key === key);
const idsFrom = (base, n) => Array.from({ length: n }, (_, i) => String(base + i));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------- F3

const BROKEN = {
  'not JSON': () => fs.writeFileSync(cfgFile(), '{ this is not json'),
  'a number out of range (rejectAbove 5)': () => fs.writeFileSync(cfgFile(), JSON.stringify({ operatingPoint: { rejectAbove: 5 } })),
  'a question option blanked': () => fs.writeFileSync(cfgFile(), JSON.stringify({ questions: { roleSeniority: { options: { comparable: '' } } } })),
  'a value of the wrong type': () => fs.writeFileSync(cfgFile(), JSON.stringify({ levels: { mid: { minRelevantMonths: 'many' } } })),
  'the file is missing at the default path': () => fs.rmSync(cfgFile()),
};

test('F3: a broken file, a value out of range, a blanked question option and a missing default file are all a fault with a fixed detail; unknown keys and notes are not', () => {
  const home = path.join(ws.root, 'cfg-unit');
  fs.mkdirSync(home, { recursive: true });
  const at = (name, content) => { const f = path.join(home, name); fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content)); return f; };
  const load = (file, extra) => cvConfig.load({ file, getEnv: () => undefined, ...(extra || {}) });
  for (const [name, content] of [['notjson', '{ nope'], ['array', '[]'], ['range', { operatingPoint: { rejectAbove: 5 } }], ['type', { alerts: { rejectRateCeiling: 'high' } }],
    ['blank', { questions: { progression: { options: { rising: '  ' } } } }], ['band', { forced: { low: 0.9, high: 0.2 } }], ['shadowMax', { phase2: { shadowMaxSeconds: 0 } }]]) {
    const cfg = load(at(`${name}.json`, content));
    assert.ok(cfg.fault, `${name} is a fault`);
    assert.equal(cfg.fault.kind, 'config');
    assert.equal(cfg.fault.key, 'cvconfig');
    assert.match(cfg.fault.detail, /^[A-Za-z0-9.]+\.json is not usable: /);
    assert.equal(cfg.tau, 0.75, `${name}: the values shown are the built-in defaults, never the broken ones`);
  }
  // not faults: an unknown key (a warning), a note, a valid change, test overrides and the environment
  assert.equal(load(at('unknown.json', { madeUp: 1, _note: 'x', levels: { mid: { typoKey: 1 } } })).fault, null);
  assert.equal(load(at('valid.json', { operatingPoint: { rejectAbove: 0.85 } })).fault, null);
  assert.equal(cvConfig.load({ file: path.join(home, 'nope.json'), getEnv: () => undefined, overrides: { operatingPoint: { rejectAbove: 5 } } }).fault, null, 'test overrides never make a fault');
  assert.equal(load(at('env.json', {}), { getEnv: n => (n === 'CV_REJECT_ABOVE' ? '5' : undefined) }).fault, null, 'a bad environment value is a warning, the file is fine');
  // a file named explicitly that does not exist, and --config (fileRequired), are faults; a programmatic file that does not exist is not (a test seam)
  assert.ok(cvConfig.load({ getEnv: n => (n === 'CV_SCREEN_CONFIG_FILE' ? path.join(home, 'absent.json') : undefined) }).fault);
  assert.ok(cvConfig.load({ file: path.join(home, 'absent.json'), fileRequired: true, getEnv: () => undefined }).fault);
  assert.equal(cvConfig.load({ file: path.join(home, 'absent.json'), getEnv: () => undefined }).fault, null);
  // the shipped file is the same as the defaults: no fault, no warning
  const shipped = cvConfig.load({ file: path.resolve(__dirname, '..', '..', 'resourcer', 'config', 'cv-screening.json'), getEnv: () => undefined });
  assert.equal(shipped.fault, null);
  assert.deepEqual(shipped.warnings, []);
});

for (const [name, breakIt] of Object.entries(BROKEN)) {
  test(`F3 mode on, ${name}: the queue is HELD with the CV-config halt reason, nothing is asked of Jev, nothing is pushed or rejected, and the critical alert goes out once`, async () => {
    envSet({ CV_SCREEN: 'on', CV_SCREEN_CONFIG_FILE: undefined });
    const ids = ['6101', '6102', '6103'];
    const { res, results, built, seen, out } = await execute({ ids, defaultMode: true, scenario: {}, before: () => breakIt() });
    assert.equal(res.code, 2);
    assert.equal(res.reason, 'cv-screening-unavailable');
    assert.equal(results, null);
    assert.deepEqual(seen.calls, [], 'the reviewer never ran');
    assert.equal(built.calls.create, 0);
    assert.equal(rejections().length, 0, 'never a reject from a broken file');
    for (const id of ids) assert.ok(has(`cv-${id}.pdf`), `cv ${id} kept`);
    const h = halt.getHalt();
    assert.equal(h.halted, true);
    assert.equal(h.reason, health.REASONS.cvconfig);
    assert.equal(h.remedy, health.REMEDIES.cvconfig);
    assert.match(h.detail, /CV screening could not run during Chef\/LS1: cv-screening\.json is not usable/);
    assert.equal(alertsOf('cv-screening-unavailable').filter(a => a.severity === 'critical').length, 1);
    assert.ok(out.some(l => /WARN CV screening criteria are not usable: cv-screening\.json is not usable/.test(l)));
  });
}

test('F3 mode on: the halt stays while the file is broken (a held queue arriving again is held quietly) and the same queue completes once the file is valid again', async () => {
  envSet({ CV_SCREEN: 'on' });
  const ids = ['6151', '6152'];
  await execute({ ids, defaultMode: true, scenario: {}, before: () => BROKEN['not JSON']() });
  assert.equal(halt.getHalt().halted, true);
  const alertsBefore = ws.alerts().length;
  const again = await execute({ ids, defaultMode: true, keepState: true, scenario: {}, before: () => BROKEN['not JSON']() });
  assert.equal(again.res.code, 2);
  assert.equal(ws.alerts().length, alertsBefore, 'no second alert while the halt is up');
  // supervision clears the halt only when the deep check passes, and its cheap check refuses a broken file (tests/screening/health-cv.test.js);
  // here the operator has fixed the file and the halt is cleared
  fs.copyFileSync(path.resolve(__dirname, '..', '..', 'resourcer', 'config', 'cv-screening.json'), cfgFile());
  halt.clearHalt();
  const fixed = await execute({ ids, defaultMode: true, keepState: true, scenario: {} });
  assert.equal(fixed.res.code, 0);
  assert.equal(fixed.results.new, 2);
  assert.equal(fixed.built.calls.create, 2);
});

test('F3 mode on, CV_SCREEN_CONFIG_FILE names a file that does not exist: held, like a broken file', async () => {
  envSet({ CV_SCREEN: 'on', CV_SCREEN_CONFIG_FILE: path.join(ws.root, 'nowhere', 'cv.json') });
  const { res, seen } = await execute({ ids: ['6161'], defaultMode: true, scenario: {} });
  assert.equal(res.code, 2);
  assert.deepEqual(seen.calls, []);
  assert.match(halt.getHalt().detail, /cv\.json is not usable: the file does not exist/);
});

test('F3 shadow, broken file: the stage stops with ONE warn alert cv-config-invalid, every candidate still goes to Zoho, nothing is blocked, no halt, no shadow row', async () => {
  envSet({ CV_SCREEN: 'shadow' });
  const ids = ['6201', '6202', '6203', '6204'];
  const { res, results, built, seen, out } = await execute({ ids, defaultMode: true, scenario: {}, before: () => BROKEN['a number out of range (rejectAbove 5)']() });
  assert.equal(res.code, 0);
  assert.equal(built.calls.create, 4, 'nothing is blocked');
  assert.equal(results.new, 4);
  assert.equal(results.cvRejected, 0);
  assert.deepEqual(seen.calls, []);
  assert.equal(results.cvScreen.configInvalid, true);
  assert.equal(results.cvScreen.screened, 0);
  assert.equal(results.cvScreen.unscreened, 4);
  assert.equal(halt.getHalt(), null, 'shadow never halts');
  assert.equal(rejections().length, 0);
  const a = alertsOf('cv-config-invalid');
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'warn');
  assert.match(a[0].text, /did not run for Chef in LS1/);
  assert.match(a[0].text, /cv-screening\.json is not usable/);
  assert.match(a[0].text, /restore it from git/);
  assert.equal(alertsOf('cv-screening-unavailable').length, 0);
  assert.ok(out.some(l => /CV screening \(shadow\) skipped: cv-screening\.json is not usable: .*; 4 candidate\(s\) were not screened; nothing was blocked/.test(l)));
  const shadowDir = path.join(ws.home, 'shadow');
  assert.equal(fs.existsSync(shadowDir) && fs.readdirSync(shadowDir).some(n => /^cv-/.test(n)), false, 'nothing was screened, nothing was logged');
});

test('F3 off: a broken file is nobody\'s business (the stage does nothing at all, not even a warning)', async () => {
  envSet({ CV_SCREEN: 'off' });
  const { res, results, out } = await execute({ ids: ['6301'], defaultMode: true, scenario: {}, before: () => BROKEN['not JSON']() });
  assert.equal(res.code, 0);
  assert.equal('cvScreen' in results, false);
  assert.ok(!out.some(l => /cv-screening/.test(l)));
  assert.equal(alertsOf('cv-config-invalid').length, 0);
});

// ---------------------------------------------------------------------------------------------------------- F5

test('F5: candidate_rejections.reason_code is the first REAL reason, never the forced marker', async () => {
  const ids = ['6401', '6402', '6403'];
  setup(ids);
  for (const id of ids) writeCvFile(id);
  const db = new Database(ws.db);
  db.exec('ALTER TABLE candidate_rejections ADD COLUMN reason_code TEXT');
  db.close();
  await execute({ ids, keepState: true, scenario: {
    6401: P.R.forcedReject,
    6402: () => P.R.reject(['forced', 'pass_doubt', 'no_relevant_experience']),
    6403: () => P.R.reject(['stale_experience', 'career_change']),
  } });
  const check = new Database(ws.db, { readonly: true });
  const rows = Object.fromEntries(check.prepare('SELECT caterer_id, reason_code, origin FROM candidate_rejections WHERE origin LIKE ?').all('cv:%').map(r => [r.caterer_id, r]));
  check.close();
  assert.deepEqual(rows[6401], { caterer_id: 6401, reason_code: 'under_qualified', origin: 'cv:forced,under_qualified' });
  assert.equal(rows[6402].reason_code, 'pass_doubt');
  assert.equal(rows[6403].reason_code, 'stale_experience');
  assert.equal(cvStage.primaryReasonCode(['forced']), '', 'only the marker: nothing to name');
  assert.equal(cvStage.primaryReasonCode(['forced', 'forced', 'x'.repeat(80)]).length, 60);
  assert.equal(cvStage.primaryReasonCode(undefined), '');
});

// ---------------------------------------------------------------------------------------------------------- F6

test('F6: after a hold the two counters reconcile (cvRejected = this run\'s rejects + rejectedEarlier), the results block says what it counts, and run_results.skipped carries the rejections', async () => {
  const ids = ['6501', '6502', '6503', '6504', '6505'];
  // first attempt: two are rejected, then Jev is unavailable: held
  const first = await execute({ ids, config: { cvScreenConcurrency: 1 }, scenario: { 6501: () => P.R.reject(), 6502: () => P.R.reject(), 6503: P.R.outage } });
  assert.equal(first.res.code, 2);
  assert.equal(rejections().length, 2);
  halt.clearHalt();
  // the retry: one more is rejected, the rest pass; the two earlier ones are not asked again
  const retry = await execute({ ids, keepState: true, config: { cvScreenConcurrency: 1 }, scenario: { 6503: () => P.R.reject(), 6504: P.R.pass, 6505: P.R.pass } });
  assert.equal(retry.res.code, 0);
  const r = retry.results;
  assert.equal(r.cvRejected, 3, 'the TOTAL of the queue');
  assert.equal(r.cvScreen.rejected, 1, 'this run decided one');
  assert.equal(r.cvScreen.reject, 1);
  assert.equal(r.cvScreen.rejectedEarlier, 2, 'decided before the hold');
  assert.equal(r.cvRejected, r.cvScreen.rejected + r.cvScreen.rejectedEarlier, 'the counters reconcile');
  assert.match(r.cvScreen.scope, /decisions taken in this run only; cvRejected is every candidate of the queue/);
  assert.equal(r.new, 2);
  assert.equal(r.skipped, 0, 'skipped in the results file stays the pre-check count');
  assert.equal(r.total, 5);
  assert.equal(r.new + r.duplicates + r.skipped + r.cvRejected + r.errors, r.total, 'every candidate of the queue is in exactly one place');
  // the dashboard funnel: run_results.skipped = pre-check skips + CV rejections
  const db = new Database(ws.db, { readonly: true });
  try {
    const row = db.prepare('SELECT downloaded, new_to_zoho, duplicates, skipped, errors FROM run_results WHERE run_key = ?').get(P.RUN_KEY);
    assert.equal(row.skipped, 3);
    assert.equal(row.new_to_zoho + row.duplicates + row.skipped + row.errors, 5, 'the funnel explains every candidate of the queue');
  } finally { db.close(); }
  assert.equal(retry.built.calls.upsert[0].skipped, 3, 'the territory row carries the same count');
});

test('F6: buildRunResultRow counts cvRejected into skipped, and a run without the CV stage is unchanged', () => {
  const base = { date: '2026-09-30', total: 10, new: 5, duplicates: 1, skipped: 2, errors: 0 };
  assert.equal(backfill.buildRunResultRow({ ...base, cvRejected: 2 }, 'k', null).skipped, 4);
  assert.equal(backfill.buildRunResultRow(base, 'k', null).skipped, 2, 'no cvRejected key (stage off): as before');
  assert.equal(backfill.buildRunResultRow({ ...base, cvRejected: 0 }, 'k', null).skipped, 2);
  assert.equal(backfill.buildRunResultRow({ ...base, cvRejected: 'x' }, 'k', null).skipped, 2, 'a value that is not a number counts as none');
  assert.equal(backfill.buildRunResultRow({ date: '2026-09-30', cvRejected: 3 }, 'k', null).skipped, 3);
});

// ---------------------------------------------------------------------------------------------------------- F7

test('F7: shadow stops the screening of a slow queue after shadowMaxSeconds: the rest is not screened, one warn alert, nothing blocked, the stage returns in time', async () => {
  const ids = idsFrom(6600, 12);
  const slow = async req => { await sleep(450); return P.R.pass(req); };
  const t0 = Date.now();
  const r = await execute({ ids, mode: 'shadow', config: { cvScreenConcurrency: 1 }, cvOverrides: { phase2: { shadowMaxSeconds: 1 } }, scenario: Object.fromEntries(ids.map(id => [id, slow])) });
  const secs = (Date.now() - t0) / 1000;
  assert.equal(r.res.code, 0);
  assert.equal(r.built.calls.create, 12, 'every candidate went to Zoho: shadow never blocks');
  const s = r.results.cvScreen;
  assert.equal(s.shadowStopped, true);
  assert.equal(s.shadowStoppedBy, 'time');
  assert.ok(s.screened >= 1 && s.screened <= 4, `${s.screened} screened before the limit`);
  assert.equal(s.screened + s.unscreened, 12);
  assert.ok(r.seen.calls.length <= 5, `the reviewer was not called for the rest (${r.seen.calls.length} calls)`);
  assert.ok(secs < 6, `${secs}s: nowhere near the 12 x 0.45 s of a full queue plus the Zoho pushes`);
  const a = alertsOf('cv-shadow-stopped');
  assert.equal(a.length, 1);
  assert.match(a[0].text, /it had run for 1 seconds \(phase2\.shadowMaxSeconds\)/);
  assert.equal(a[0].meta.reason, 'time');
  assert.ok(r.out.some(l => /stopped after 1 seconds \(phase2\.shadowMaxSeconds\)/.test(l)));
  assert.equal(halt.getHalt(), null);
  assert.equal(r.results.cvRejected, 0);
  // the cap leaves one queue-stop line in the CV shadow log (numbers only), which cv-report.js turns into the unscreened share; it is not a decision row
  const shadowLog = require('../../resourcer/scripts/lib/cv/shadow');
  const stops = shadowLog.readQueueStops();
  assert.equal(stops.length, 1);
  assert.deepEqual([stops[0].kind, stops[0].stoppedBy, stops[0].mode, stops[0].screened, stops[0].skipped], ['queue-stop', 'time', 'shadow', s.screened, s.unscreened]);
  assert.deepEqual(Object.keys(stops[0]).sort(), ['kind', 'mode', 'runId', 'screened', 'skipped', 'stoppedBy', 'ts', 'v']);
  assert.equal(shadowLog.readRows().length, 0, 'a queue-stop row is never a decision row');
});

test('F7: a fast queue is not cut, the limit is configuration with a default of 120 seconds and is validated like the other keys, and it never applies in mode on', async () => {
  assert.equal(cvConfig.load({ file: 'x.json', getEnv: () => undefined }).phase2.shadowMaxSeconds, 120);
  const bad = cvConfig.load({ file: 'x.json', getEnv: () => undefined, overrides: { phase2: { shadowMaxSeconds: 0 } } });
  assert.equal(bad.phase2.shadowMaxSeconds, 120);
  assert.ok(bad.warnings.some(w => /phase2\.shadowMaxSeconds must be a number from 1 to 3600/.test(w)));
  assert.equal(cvConfig.load({ file: 'x.json', getEnv: () => undefined, overrides: { phase2: { shadowMaxSeconds: 30 } } }).phase2.shadowMaxSeconds, 30);
  const quick = await execute({ ids: idsFrom(6700, 6), mode: 'shadow', scenario: {} });
  assert.equal(quick.results.cvScreen.shadowStopped, false);
  assert.equal(quick.results.cvScreen.screened, 6);
  // mode on: every CV is screened before it is pushed, whatever the time (the limit is a shadow guard)
  const ids = idsFrom(6750, 4);
  const on = await execute({ ids, mode: 'on', config: { cvScreenConcurrency: 1 }, cvOverrides: { phase2: { shadowMaxSeconds: 1 } }, scenario: Object.fromEntries(ids.map(id => [id, async req => { await sleep(400); return P.R.pass(req); }])) });
  assert.equal(on.res.code, 0);
  assert.equal(on.results.cvScreen.screened, 4);
  assert.equal(on.results.cvScreen.shadowStopped, false);
  assert.equal(alertsOf('cv-shadow-stopped').length, 0);
});

test('F7: screenCandidates on its own: the limit stops the reviewers still running through the abort signal', async () => {
  const cfg = cvConfig.load({ file: 'x.json', getEnv: () => undefined });
  cfg.phase2.shadowMaxSeconds = 0.3; // below the validated minimum on purpose: a test needs it fast
  let aborted = 0;
  const deps = { cvScreen: req => new Promise(resolve => {
    const t = setTimeout(() => resolve({ code: 0, result: P.R.pass().result }), 2000);
    req.signal.addEventListener('abort', () => { clearTimeout(t); aborted++; resolve({ code: null, result: null, aborted: true, detail: 'stopped' }); }, { once: true });
  }) };
  const cands = idsFrom(1, 6).map(id => ({ id }));
  const t0 = Date.now();
  const r = await cvStage.screenCandidates({ deps, cfg, mode: 'shadow', candidates: cands, skip: () => false, findCv: () => '/x', jsonPathOf: () => null, jobTitle: 'Chef', runId: 'r', applyReject: () => ({ recorded: true }), concurrency: 2, timeoutMs: 5000 });
  assert.ok(Date.now() - t0 < 1500, 'returned soon after the limit, not after the 2 s reviewers');
  assert.equal(aborted, 2, 'both running reviewers were stopped');
  assert.equal(r.shadowStopped.kind, 'time');
  assert.equal(r.stats.unscreened, 6);
  assert.equal(r.stats.screened, 0);
  for (const o of r.outcomes.values()) assert.deepEqual([o.action, o.screened], ['push', false]);
});

// ---------------------------------------------------------------------------------------------------------- F1 (unit)

test('F1: unlockBlocked is true only while the CV stage is ON and the screening halt is up', () => {
  const up = () => halt.setHalt(health.REASONS.error, 'test', { blockedRun: true });
  halt.clearHalt();
  envSet({ CV_SCREEN: 'on' });
  assert.equal(cvStage.unlockBlocked(), false, 'on, no halt');
  up();
  assert.equal(cvStage.unlockBlocked(), true, 'on and halted');
  for (const v of [undefined, '', 'shadow', 'off', 'typo']) {
    envSet({ CV_SCREEN: v });
    assert.equal(cvStage.unlockBlocked(), false, `CV_SCREEN=${v}: shadow never blocks`);
  }
  envSet({ CV_SCREEN: 'on' });
  halt.clearHalt();
  halt.setHalt('some other reason', 'test', { blockedRun: true });
  assert.equal(cvStage.unlockBlocked(), false, 'a halt that is not about screening');
  halt.clearHalt();
  assert.equal(cvStage.unlockBlocked({ getHalt: () => { throw new Error('unreadable'); } }), false, 'fails open');
});
