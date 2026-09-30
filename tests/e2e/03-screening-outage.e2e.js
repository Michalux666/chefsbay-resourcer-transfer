'use strict';
// SCENARIO 3 - screening outage. (a) The gateway is unreachable before a run: two misses halt the queue, one critical
// alert, nothing is started or consumed, and the halt clears itself when the canary passes again. (b) The gateway
// answers the cheap probe but the model fails mid-run: three strikes halt the pipeline and the territory and its
// pending search survive. (c) A Jev outage in shadow mode never blocks the LLM decision.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { World, londonInstantAt } = require('./lib/world');
const { startFakeGateway } = require('./lib/services');
const D = require('./lib/data');
const C = require('./lib/checks');
const U = require('./lib/util');

const territoryRow = (w) => w.dbAll("select last_searched, next_run_date, candidate_count from territory_searches where location = 'LS29'")[0];
const unlockCalls = (w) => Object.entries(w.fakeBrowserState().counters || {}).filter(([k]) => k.includes('UnlockCandidate')).reduce((n, [, v]) => n + v, 0);
const tickOnce = (w) => w.cron('resourcer-tick', { env: { RESOURCER_MAX_TICK_MIN: '1' } });

test('3a gateway unreachable: probe miss, halt, critical alert, nothing consumed; the canary resumes the queue by itself', async (t) => {
  const w = new World('s3a-unreachable');
  await w.create({});
  t.after(() => w.close());
  const port = w.svc.gateway.port;
  const before = territoryRow(w);
  await w.svc.gateway.close();
  const pending = w.dropPending({});

  await t.test('first miss holds the territory without halting', async () => {
    const r = await tickOnce(w);
    assert.deepEqual([r.code, r.stdout], [0, '']);
    assert.equal(w.json('runtime/pipeline-halt.json'), null, 'one miss can be a busy service');
    assert.deepEqual(w.pendingFiles(), [pending]);
    assert.ok(!w.exists('runtime/run.json') && !w.exists('runtime/last-run.json'));
  });

  await t.test('second miss halts: halt file, one critical alert, still nothing started', async () => {
    const r = await tickOnce(w);
    assert.deepEqual([r.code, r.stdout], [0, '']);
    const halt = w.json('runtime/pipeline-halt.json');
    assert.equal(halt.halted, true);
    assert.equal(halt.reason, 'screening gateway unreachable');
    assert.match(halt.remedy, /resumes automatically/);
    const crit = w.alerts().filter((a) => a.severity === 'critical');
    assert.equal(crit.length, 1);
    assert.equal(crit[0].key, 'pipeline-halt');
    assert.match(crit[0].text, /PIPELINE HALTED - screening gateway unreachable/);
    for (let i = 0; i < 3; i += 1) await tickOnce(w);
    assert.equal(w.alerts().filter((a) => a.severity === 'critical').length, 1, 'ticks while halted do not repeat the alert');
    assert.ok(w.json('runtime/pipeline-halt.json').blockedRuns >= 2, 'held runs are counted');
    assert.ok(!w.exists('runtime/last-run.json') && !w.exists('runtime/run.json'), 'no run was ever started');
    assert.deepEqual(w.pendingFiles(), [pending], 'the pending search is untouched');
    assert.equal(w.json(`pending-searches/${pending}`).spawnedAt, undefined);
    assert.deepEqual(territoryRow(w), before, 'the territory was not consumed');
    assert.equal(w.svc.zoho.counts().create || 0, 0);
    assert.ok(w.jsonl('logs/errors.jsonl').some((e) => e.context === 'pipeline_halted'), 'the halt is in the errors feed the dashboard shows');
  });

  await t.test('the critical alert reaches the human through the alert job', async () => {
    const r = await w.cron('resourcer-alerts');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /CRITICAL.*PIPELINE HALTED - screening gateway unreachable/);
    assert.equal(r.stdout.split('\n').filter((l) => /PIPELINE HALTED/.test(l)).length, 1);
  });

  await t.test('the gateway returns: the canary verifies it, the halt clears itself and the held territory runs', async () => {
    w.svc.gateway = await startFakeGateway({ key: D.SECRETS.aiKey, port });
    w.svc.zoho.state.dupKeys.add('71000010');
    await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json'), { maxTicks: 10, tickMin: 1 });
    assert.equal(w.json('runtime/pipeline-halt.json'), null, 'the halt file is removed');
    const alerts = w.alerts().filter((a) => a.key === 'pipeline-halt');
    assert.deepEqual(alerts.map((a) => a.severity), ['critical', 'info']);
    assert.match(alerts[1].text, /Pipeline resumed - screening gateway unreachable cleared\. was halted for \d+ min; \d+ run\(s\) held back \(their territories were NOT consumed\)/);
    const calls = w.svc.gateway.stats().calls;
    assert.ok(calls['GET /v1/credits'] >= 1, 'the deep check asked for the key and the balance');
    assert.equal(w.lastRun().exitCode, 0);
    assert.equal(w.svc.zoho.created().length, 5);
    assert.notEqual(territoryRow(w).last_searched, before.last_searched, 'searched once the run really happened');
    assert.ok(w.jsonl('logs/errors.jsonl').some((e) => e.context === 'pipeline_resumed'));
    const lines = (await w.cron('resourcer-alerts')).stdout;
    assert.match(lines, /Pipeline resumed/);
    assert.deepEqual(C.secretHits(w), []);
  });
});

test('3b the model fails mid-run: three strikes halt the pipeline; the territory and its pending search are not lost; recovery re-runs it', async (t) => {
  const w = new World('s3b-midrun');
  await w.create({});
  t.after(() => w.close());
  const before = territoryRow(w);
  const rejBefore = w.dbAll('select count(*) n from candidate_rejections')[0].n;
  const candBefore = w.dbAll('select count(*) n from candidates')[0].n;
  w.svc.gateway.setMode({ llm: '500', jev: '500' });
  const pending = w.dropPending({});

  await t.test('phase 1 stops after three strikes and hands nothing to Phase 2', async () => {
    const r = await tickOnce(w);
    assert.deepEqual([r.code, r.stdout], [0, '']);
    const log = w.text(`logs/${w.list('logs', /^phase1-console-/)[0]}`);
    assert.match(log, /failure 1\/3/);
    assert.match(log, /failure 3\/3/);
    assert.match(log, /STOPPING Phase 1: AI screening API down for 3 consecutive pages/);
    assert.match(log, /PHASE2_SKIPPED/);
    assert.doesNotMatch(log, /\[Phase 2\]/, 'Phase 2 did not run');
    const last = w.lastRun();
    assert.equal(last.exitCode, 0);
    assert.equal(last.phase1Status, 'phase1_abandoned', 'a terminal status: the global lock is free');
    assert.equal(last.phase2Status, 'skipped');
    assert.equal(last.approved, 0);
    assert.equal(unlockCalls(w), 0, 'no credit was spent');
  });

  await t.test('halt file and both alerts are there', () => {
    const halt = w.json('runtime/pipeline-halt.json');
    assert.equal(halt.halted, true);
    const keys = w.alerts().map((a) => `${a.severity}:${a.key}`);
    assert.ok(keys.includes('critical:pipeline-halt'), keys.join(','));
    assert.ok(keys.includes('warn:phase1-screening-down'), keys.join(','));
  });

  await t.test('nothing was lost: pending search kept and released, territory unsearched, no results row, no candidate marked', () => {
    assert.deepEqual(w.pendingFiles(), [pending]);
    assert.equal(w.json(`pending-searches/${pending}`).spawnedAt, undefined, 'the claim stamp is gone');
    assert.deepEqual(territoryRow(w), before);
    assert.equal(w.dbAll('select count(*) n from run_results')[0].n, 0);
    assert.equal(w.dbAll('select count(*) n from candidate_rejections')[0].n, rejBefore, 'unscreened candidates are not rejected');
    assert.equal(w.dbAll('select count(*) n from candidates')[0].n, candBefore, 'unscreened candidates are not marked seen');
    assert.equal(w.svc.zoho.counts().create || 0, 0);
    assert.ok(w.jsonl('logs/watchdog-runner.jsonl').some((e) => e.event === 'pending-released'));
    assert.equal(w.exists('runtime/run.json'), false);
  });

  await t.test('while the model is still down the queue is held, not looped', async () => {
    for (let i = 0; i < 3; i += 1) await tickOnce(w);
    assert.equal(w.jsonl('logs/watchdog-runner.jsonl').filter((e) => e.event === 'picked').length, 1, 'no second run started');
    assert.deepEqual(w.pendingFiles(), [pending]);
  });

  await t.test('the model recovers: the deep canary clears the halt and the same pending search runs to completion', async () => {
    w.svc.gateway.setMode({ llm: 'ok', jev: 'ok' });
    w.svc.zoho.state.dupKeys.add('71000010');
    await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json'), { maxTicks: 30, tickMin: 1, gapMs: 5000, timeoutMs: 180000 });
    assert.equal(w.json('runtime/pipeline-halt.json'), null);
    assert.ok(w.alerts().some((a) => a.key === 'pipeline-halt' && a.severity === 'info'));
    assert.equal(w.lastRun().exitCode, 0);
    assert.equal(w.lastRun().approved, 6);
    assert.equal(w.svc.zoho.created().length, 5);
    assert.notEqual(territoryRow(w).last_searched, before.last_searched);
    assert.equal(w.dbAll('select count(*) n from run_results')[0].n, 1);
    assert.deepEqual(C.secretHits(w), []);
  });
});

test('3c a Jev outage in shadow mode never blocks the run: the LLM decides and the failure is only logged', async (t) => {
  const w = new World('s3c-jev-down');
  await w.create({});
  t.after(() => w.close());
  w.svc.gateway.setMode({ jev: '500' });
  w.svc.zoho.state.dupKeys.add('71000010');
  w.dropPending({});
  await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json'), { maxTicks: 10, tickMin: 1 });
  assert.equal(w.lastRun().exitCode, 0);
  assert.equal(w.lastRun().approved, 6);
  assert.equal(w.svc.zoho.created().length, 5);
  assert.equal(w.json('runtime/pipeline-halt.json'), null);
  // the CV stage runs in shadow by default, needs Jev too and finds it down: it stops after five CVs, says so once and blocks nothing (all five records above reached Zoho)
  const alerts = w.alerts().filter((a) => a.severity !== 'info');
  assert.deepEqual(alerts.map((a) => [a.key, a.severity]), [['cv-shadow-stopped', 'warn']]);
  assert.deepEqual(w.list('shadow', /^cv-d{4}/), [], 'no CV was screened, so no CV row exists');
  const rows = w.jsonl(`shadow/${w.list('shadow', /^screening-/)[0]}`);
  assert.ok(rows.length >= 9);
  assert.ok(rows.every((r) => r.used.engine === 'llm' && r.jev && r.jev.status !== 'ok'), 'Jev failed, the LLM decided');
});
