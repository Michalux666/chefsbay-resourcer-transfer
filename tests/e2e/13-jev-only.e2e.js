'use strict';
// SCENARIO 13 - the shipped default engine (jev_only): the whole pipeline with NO language model. The profile .env names no
// engine, and the fake gateway answers every chat-completions request with 403 "Your team has restricted access to this
// model" (the owner's Vercel team allows Jev only), so one stray call would fail the run. (a) a normal run makes the same
// numbers as scenario 2 with zero chat-completions requests; (b) when Jev itself is refused the pipeline halts, nothing is
// consumed and the halt clears once Jev is allowed again.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { World } = require('./lib/world');
const D = require('./lib/data');
const C = require('./lib/checks');

const CHAT = 'POST /v1/chat/completions';
const JEV = 'POST /typesafe/v1/systemone';
const territoryRow = (w) => w.dbAll("select last_searched, next_run_date, candidate_count from territory_searches where location = 'LS29'")[0];
const tickOnce = (w) => w.cron('resourcer-tick', { env: { RESOURCER_MAX_TICK_MIN: '1' } });

test('13a a normal run on the default engine: Jev decides, the policy is visible, no request ever reaches a language model', async (t) => {
  const w = new World('s13a-jev-only');
  await w.create({ engine: null });
  t.after(() => w.close());
  assert.equal(w.envFile.SCREEN_ENGINE, undefined, 'the .env names no engine: this is the shipped default');
  assert.ok(!/SCREEN_ENGINE/.test(fs.readFileSync(require('path').join(w.profile, '.env'), 'utf8')));
  w.svc.gateway.setMode({ llm: 'restricted' });
  w.svc.zoho.state.dupKeys.add('71000010');
  w.dropPending({});
  const ticks = await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json'), { maxTicks: 12, tickMin: 1 });
  for (const tk of ticks) assert.deepEqual([tk.code, tk.stdout, tk.stderr], [0, '', ''], tk.stdout + tk.stderr);

  await t.test('the run finished with the numbers of scenario 2', () => {
    const last = w.lastRun();
    assert.equal(last.exitCode, 0);
    assert.equal(last.phase1Code, 0);
    assert.equal(last.pool, 11);
    assert.equal(last.approved, 6);
    assert.equal(last.skippedDb, 2);
    assert.equal(last.errors, 0);
    assert.equal(w.svc.zoho.created().length, 5);
    assert.equal(w.json('runtime/pipeline-halt.json'), null);
  });

  await t.test('the gateway saw Jev requests and not one chat-completions request; only Jev is named on the wire', () => {
    const stats = w.svc.gateway.stats();
    assert.equal(stats.calls[CHAT] || 0, 0, JSON.stringify(stats.calls));
    assert.ok(stats.calls[JEV] >= 9, JSON.stringify(stats.calls));
    assert.equal(stats.requests.filter((r) => r.route === CHAT).length, 0);
    for (const r of stats.requests) assert.equal(r.model, 'typesafe-ai/jev');
  });

  await t.test('the shadow log says jev_only, holds no LLM data and names the deciding engine of every row', () => {
    const files = w.list('shadow', /^screening-\d{4}-\d{2}-\d{2}\.jsonl$/);
    assert.equal(files.length, 1);
    const rows = w.jsonl(`shadow/${files[0]}`);
    assert.ok(rows.length >= 9);
    for (const r of rows) {
      assert.equal(r.mode, 'jev_only');
      assert.equal(r.llm, null);
      assert.ok(['jev', 'policy'].includes(r.used.engine), r.used.engine);
      assert.equal(r.redacted, true);
      assert.equal(r.cal, false, 'the thresholds are still the uncalibrated placeholders');
      if (r.used.engine === 'policy') assert.match(r.used.reasonCode, /^sys_review_policy_(approve|reject)$/);
    }
    const text = fs.readFileSync(w.p('shadow', files[0]), 'utf8');
    for (const c of D.CANDIDATES) {
      const m = C.markers(c.n);
      for (const kind of ['name', 'surname', 'email', 'phone']) assert.ok(!text.includes(m[kind]), `shadow log holds no ${kind} of #${c.n}`);
    }
    assert.ok(!text.includes(D.SECRETS.aiKey));
  });

  await t.test('the run label names Jev (and the policy when it decided something); the database and the queue agree', () => {
    const queue = w.json(`downloads/${w.list('downloads', /^approved-queue-/)[0]}`);
    assert.match(queue.screeningModel, /^typesafe-ai\/jev(\+policy)?$/);
    const rr = w.dbAll('select screening_model from run_results');
    assert.equal(rr.length, 1);
    assert.match(rr[0].screening_model, /^typesafe-ai\/jev(\+policy)?$/);
  });

  await t.test('nothing reached the internet, no secret leaked, no alert was raised', () => {
    assert.deepEqual(w.netBlocked(), []);
    assert.deepEqual(C.secretHits(w), []);
    assert.deepEqual(w.alerts().filter((a) => a.severity !== 'info'), []);
  });
});

test('13b Jev refused by the Vercel team: the deep check names the remedy, the pipeline halts, nothing is consumed, and it resumes once Jev is allowed', async (t) => {
  const w = new World('s13b-jev-restricted');
  await w.create({ engine: null });
  t.after(() => w.close());
  const before = territoryRow(w);
  const rejBefore = w.dbAll('select count(*) n from candidate_rejections')[0].n;
  const candBefore = w.dbAll('select count(*) n from candidates')[0].n;
  w.svc.gateway.setMode({ llm: 'restricted', jev: 'restricted' });
  const pending = w.dropPending({});

  await t.test('phase 1 stops after three strikes: exit 3 is a halt, never a silent reject', async () => {
    const r = await tickOnce(w);
    assert.deepEqual([r.code, r.stdout], [0, '']);
    const log = w.text(`logs/${w.list('logs', /^phase1-console-/)[0]}`);
    assert.match(log, /STOPPING Phase 1: AI screening API down for 3 consecutive pages/);
    assert.match(log, /PHASE2_SKIPPED/);
    assert.equal(w.json('runtime/pipeline-halt.json').halted, true);
    assert.deepEqual(w.pendingFiles(), [pending]);
    assert.deepEqual(territoryRow(w), before, 'the territory was not consumed');
    assert.equal(w.dbAll('select count(*) n from candidate_rejections')[0].n, rejBefore, 'nobody was rejected because Jev was refused');
    assert.equal(w.dbAll('select count(*) n from candidates')[0].n, candBefore, 'nobody was marked seen');
    assert.equal(w.svc.zoho.counts().create || 0, 0);
    assert.equal(w.svc.gateway.stats().calls[CHAT] || 0, 0, 'no fallback to a language model');
  });

  await t.test('while halted the deep check says what to do: allow typesafe-ai/jev on the Vercel team', async () => {
    for (let i = 0; i < 3; i += 1) await tickOnce(w);
    const halt = w.json('runtime/pipeline-halt.json');
    assert.equal(halt.halted, true);
    assert.match(halt.remedy, /typesafe-ai\/jev/);
    assert.equal(w.svc.gateway.stats().calls[CHAT] || 0, 0, 'the deep check never contacts a language model either');
    assert.equal(w.jsonl('logs/watchdog-runner.jsonl').filter((e) => e.event === 'picked').length, 1, 'no second run started while halted');
  });

  await t.test('Jev is allowed again: the deep canary clears the halt and the same pending search runs to completion', async () => {
    w.svc.gateway.setMode({ jev: 'ok' });
    w.svc.zoho.state.dupKeys.add('71000010');
    await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json'), { maxTicks: 30, tickMin: 1, gapMs: 5000, timeoutMs: 180000 });
    assert.equal(w.json('runtime/pipeline-halt.json'), null);
    assert.equal(w.lastRun().exitCode, 0);
    assert.equal(w.lastRun().approved, 6);
    assert.equal(w.svc.zoho.created().length, 5);
    assert.notEqual(territoryRow(w).last_searched, before.last_searched);
    assert.equal(w.svc.gateway.stats().calls[CHAT] || 0, 0);
    assert.deepEqual(C.secretHits(w), []);
  });
});

test('13c a leftover SCREEN_ENGINE=jev_shadow in the profile .env (written by the first release) is harmless: the run completes on Jev alone and the log says why', async (t) => {
  const w = new World('s13c-leftover-engine');
  await w.create({ engine: 'jev_shadow', allowLlm: false });
  t.after(() => w.close());
  assert.equal(w.envFile.SCREEN_ENGINE, 'jev_shadow');
  assert.equal(w.envFile.SCREEN_ALLOW_LLM, undefined, 'no opt-in in the .env');
  w.svc.gateway.setMode({ llm: 'restricted' });
  w.svc.zoho.state.dupKeys.add('71000010');
  w.dropPending({});
  await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json'), { maxTicks: 12, tickMin: 1 });

  const last = w.lastRun();
  assert.equal(last.exitCode, 0);
  assert.equal(last.approved, 6);
  assert.equal(w.json('runtime/pipeline-halt.json'), null);
  const stats = w.svc.gateway.stats();
  assert.equal(stats.calls[CHAT] || 0, 0, JSON.stringify(stats.calls));
  assert.ok(stats.calls[JEV] >= 9, JSON.stringify(stats.calls));
  const log = w.text(`logs/${w.list('logs', /^phase1-console-/)[0]}`);
  assert.match(log, /WARN screening config: engine 'jev_shadow' calls a language model, which the AI Gateway does not carry here/);
  const rows = w.jsonl(`shadow/${w.list('shadow', /^screening-\d{4}-\d{2}-\d{2}\.jsonl$/)[0]}`);
  assert.ok(rows.length >= 9);
  for (const r of rows) assert.equal(r.mode, 'jev_only');
  assert.deepEqual(C.secretHits(w), []);
});
