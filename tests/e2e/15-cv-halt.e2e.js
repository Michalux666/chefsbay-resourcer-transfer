'use strict';
// SCENARIO 15 - Update C, findings F1 and F9: CV_SCREEN=on while the CV route alone refuses requests (the snippet route is healthy), through the whole
// pipeline, the way Hermes runs it (cron wrapper, scrubbed environment, the real supervisor tick, the real runner, Phase 1, Phase 2, the recovery).
//
// Before Update C the cycle was: Phase 2 holds (exit 2) and raises the screening halt -> the next tick's deep check asks only the SNIPPET canary, which is
// fine -> the halt is cleared -> a new run starts and unlocks more candidates (credits) -> Phase 2 holds again ... (four cycles measured), each with a
// critical pipeline-halt and cv-screening-unavailable, and the candidates unlocked on the way never pushed.
//
// Now: (a) mode on + CV route refusing + snippet route healthy => ONE hold, the halt stays until the CV route answers a canary, NO unlock after the
// halt, the run is recorded as held (runner exit 14), and when the route recovers the queue completes idempotently; (b) shadow with the same refusing
// route is unaffected: nothing held, nothing halted, every candidate pushed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('./lib/world');
const D = require('./lib/data');
const C = require('./lib/checks');

const isCvRequest = (r) => r.questions.includes('search_level') || r.questions.some((k) => /^relevance_\d+$/.test(k));
const unlocks = (w) => Object.entries((w.fakeBrowserState() || {}).counters || {}).filter(([k]) => k.startsWith('fetch:UnlockCandidate')).reduce((n, [, v]) => n + v, 0);
const haltState = (w) => w.json('runtime/pipeline-halt.json');
const errorsLog = (w) => w.jsonl('logs/errors.jsonl');
const criticalKeys = (w) => w.alerts().filter((a) => a.severity === 'critical').map((a) => a.key);
const allResults = (w) => w.list('downloads', /^phase2-results-.*\.json$/).map((n) => w.json(`downloads/${n}`));
// the results of the run that pushed the held queue (a later run of the same territory finds nothing new and writes an empty one)
const resultsOf = (w) => allResults(w).find((r) => r.new > 0) || null;

test('15a CV_SCREEN=on, CV route refusing, snippet route healthy: one hold, the halt stays, no credit is spent after it, and the recovery completes the queue idempotently', async (t) => {
  const w = new World('s15a-cv-halt');
  await w.create({ engine: null });
  t.after(() => w.close());
  w.writeEnv({ CV_SCREEN: 'on' });
  w.svc.zoho.state.dupKeys.add('71000010');
  const gw = w.svc.gateway;
  gw.setMode({ cv: '503' });
  w.dropPending({});

  // ------------------------------------------------------------ the first run: Phase 1 unlocks, Phase 2 holds
  await w.tickUntil(async () => w.lastRun() !== null && !w.exists('runtime/run.json') && !!haltState(w), { maxTicks: 8, tickMin: 1 });
  const unlocksAtHalt = unlocks(w);
  await t.test('the run was HELD: recorded as held (exit 14), not as a success and not as a failure; nothing reached Zoho, nothing was lost', () => {
    const last = w.lastRun();
    assert.equal(last.exitCode, 14, JSON.stringify(last));
    assert.equal(last.reason, 'phase2-held');
    assert.ok(unlocksAtHalt >= 6, `${unlocksAtHalt} candidates were unlocked before Phase 2 held`);
    assert.equal(w.svc.zoho.created().length, 0);
    assert.deepEqual(allResults(w), [], 'no results file: the run did not finish');
    assert.ok(w.list('downloads').some((n) => /^cv-/.test(n)), 'every CV is kept for the retry');
    assert.equal(w.pendingFiles().length, 1, 'the territory and its pending search are kept (nothing consumed)');
    assert.equal(w.pendingFiles().length && w.json(`pending-searches/${w.pendingFiles()[0]}`).failedRuns, undefined, 'no failure counted against the territory');
    const st = w.json('runtime/watchdog-state.json');
    assert.equal(st.consecutiveFailures, 0, 'a hold is not a failure');
    const rec = st.recentRuns[st.recentRuns.length - 1];
    assert.deepEqual([rec.exitCode, rec.reason], [14, 'phase2-held']);
    assert.deepEqual(w.alerts().filter((a) => a.key === 'run-failures' || /^territory-quarantined/.test(a.key || '')), []);
  });

  await t.test('the screening halt is up with its reason and remedy, raised once, with exactly one critical alert from the CV stage and one from the halt', () => {
    const h = haltState(w);
    assert.equal(h.halted, true);
    assert.equal(h.reason, 'screening gateway error');
    assert.ok(h.remedy);
    assert.deepEqual(criticalKeys(w).sort(), ['cv-screening-unavailable', 'pipeline-halt']);
  });

  // ------------------------------------------------------------ the supervisor keeps checking: the halt must stay, and nothing may be unlocked
  const nonce = w.lastRun().nonce;
  for (let i = 0; i < 5; i++) {
    w.fastForward(10); // the launch back-off, the verify interval and the recovery ages have all passed
    const tk = await w.cron('resourcer-tick', { env: { RESOURCER_MAX_TICK_MIN: '1' }, timeoutMs: 240000 });
    assert.equal(tk.code, 0, tk.stdout + tk.stderr);
  }
  await t.test('after five more ticks with every timer expired: the same halt, never cleared, no new run, no credit spent, no second alert, nothing pushed', () => {
    assert.equal(haltState(w).halted, true);
    const log = errorsLog(w);
    assert.equal(log.filter((x) => x.context === 'pipeline_halted').length, 1, 'one halt, raised once');
    assert.equal(log.filter((x) => x.context === 'pipeline_resumed').length, 0, 'never resumed while the CV route refuses');
    assert.equal(w.lastRun().nonce, nonce, 'no new run was started');
    assert.equal(unlocks(w), unlocksAtHalt, 'credits spent after the halt: zero');
    assert.deepEqual(criticalKeys(w).sort(), ['cv-screening-unavailable', 'pipeline-halt'], 'one of each, ever');
    assert.equal(w.svc.zoho.created().length, 0);
    assert.deepEqual(allResults(w), []);
    // the supervisor really asked the CV route each time (the canary), and the snippet route answered
    const cvCalls = gw.stats().requests.filter(isCvRequest);
    assert.ok(cvCalls.length >= 5, `${cvCalls.length} CV requests: the canary of each verify`);
    assert.ok(gw.stats().requests.filter((r) => !isCvRequest(r)).length >= 5, 'and the snippet canary');
  });

  // ------------------------------------------------------------ the CV route recovers: the halt clears and the held queue completes
  gw.setMode({ cv: 'ok' });
  w.fastForward(10);
  await w.tickUntil(async () => !haltState(w) && !w.exists('runtime/run.json') && w.pendingFiles().length === 0 && w.svc.zoho.created().length >= 5, { maxTicks: 14, tickMin: 1, onTick: async () => { w.fastForward(10); } });
  await t.test('the halt cleared once, and the queue completed: the same five records as a normal run, each with its CV, none twice, and the territory is marked done', () => {
    const log = errorsLog(w);
    assert.equal(log.filter((x) => x.context === 'pipeline_halted').length, 1);
    assert.equal(log.filter((x) => x.context === 'pipeline_resumed').length, 1);
    assert.equal(w.svc.zoho.created().length, 5);
    assert.equal(w.svc.zoho.counts().attach, 5);
    const keys = w.svc.zoho.created().map((r) => r.key);
    assert.equal(new Set(keys).size, keys.length, 'no record twice');
    assert.deepEqual(w.list('downloads').filter((n) => /^(cv-|candidate-)/.test(n)), [], 'CVs and candidate files are cleaned after the push');
    const res = resultsOf(w);
    assert.equal(res.new, 5);
    assert.equal(res.cvRejected, 0);
    assert.equal(res.cvScreen.mode, 'on');
    assert.equal(w.pendingFiles().length, 0);
    assert.deepEqual(w.lockProblems(), []);
  });

  await t.test('idempotent: more ticks push nothing twice, raise nothing, and leave no halt', async () => {
    const before = { created: w.svc.zoho.created().length, calls: w.svc.zoho.counts().create, alerts: criticalKeys(w).length };
    for (let i = 0; i < 2; i++) {
      w.fastForward(10);
      const tk = await w.cron('resourcer-tick', { env: { RESOURCER_MAX_TICK_MIN: '1' }, timeoutMs: 240000 });
      assert.equal(tk.code, 0, tk.stdout + tk.stderr);
    }
    assert.equal(w.svc.zoho.created().length, before.created);
    assert.equal(w.svc.zoho.counts().create, before.calls, 'no second push attempt');
    assert.equal(criticalKeys(w).length, before.alerts);
    assert.equal(haltState(w), null);
    assert.deepEqual(w.netBlocked(), []);
    assert.deepEqual(C.secretHits(w), []);
  });
});

test('15b shadow (the default) with the same refusing CV route: nothing is held or halted, every candidate is pushed, no critical alert, and the supervisor never asks the CV route', async (t) => {
  const w = new World('s15b-cv-shadow');
  await w.create({ engine: null });
  t.after(() => w.close());
  assert.equal(w.envFile.CV_SCREEN, undefined, 'the shipped default');
  w.svc.zoho.state.dupKeys.add('71000010');
  const gw = w.svc.gateway;
  gw.setMode({ cv: '503' });
  w.dropPending({});
  const ticks = await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json'), { maxTicks: 12, tickMin: 1 });
  for (const tk of ticks) assert.equal(tk.code, 0, tk.stdout + tk.stderr);
  assert.equal(w.lastRun().exitCode, 0);
  assert.equal(w.svc.zoho.created().length, 5, 'shadow never blocks');
  assert.equal(haltState(w), null, 'shadow never halts');
  assert.deepEqual(criticalKeys(w), []);
  const res = resultsOf(w);
  assert.equal(res.cvRejected, 0);
  assert.equal(res.cvScreen.mode, 'shadow');
  assert.ok(res.cvScreen.unscreened >= 1, 'the CVs that could not be screened were passed through unscreened');
  assert.equal(w.json('runtime/watchdog-state.json').consecutiveFailures, 0);
});
