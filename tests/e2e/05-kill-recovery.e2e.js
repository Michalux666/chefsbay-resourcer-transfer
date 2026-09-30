'use strict';
// SCENARIO 5 - kill -9 at five deliberate points and at random points, then keep ticking. The run must be adopted or
// cleanly recovered: never two runs at once, every unlocked candidate reaches Zoho exactly once, no lock is left behind,
// the territory is searched in the end and nothing is lost.
const test = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('./lib/world');
const D = require('./lib/data');
const C = require('./lib/checks');
const U = require('./lib/util');

const TICK_ENV = { RESOURCER_MAX_TICK_MIN: '1' };
const PUSHED = [71000001, 71000005, 71000007, 71000009, 71000010, 71000011];

function startSampler(w) {
  const s = { phase1: 0, runner: 0, phase2: 0, n: 0 };
  const timer = setInterval(() => {
    const ps = w.pipelineProcs();
    s.phase1 = Math.max(s.phase1, ps.filter((p) => /phase1\.js/.test(p.cmd)).length);
    s.runner = Math.max(s.runner, ps.filter((p) => /watchdog-runner\.js/.test(p.cmd)).length);
    s.phase2 = Math.max(s.phase2, ps.filter((p) => /process-approved-queue\.js/.test(p.cmd)).length);
    s.n += 1;
  }, 30);
  s.stop = () => clearInterval(timer);
  return s;
}

const consoleLog = (w) => { const f = w.list('logs', /^phase1-console-/)[0]; return f ? w.text(`logs/${f}`) : ''; };
const pidOf = (w, re) => { const p = w.pipelineProcs().find((x) => re.test(x.cmd)); return p ? p.pid : null; };
const tickPid = (w) => { const p = w.worldProcs(/^\S*node\S* scripts\/pipeline-watchdog\.js --tick/)[0]; return p ? p.pid : null; };
const started = (w) => w.jsonl('logs/watchdog-runner.jsonl').filter((e) => e.event === 'picked').length;

// Keep firing the tick (like Hermes' every-minute cron). Persisted stamps are fast-forwarded as if the minutes between
// fires had passed; everything else runs for real.
async function settle(w, opts) {
  const o = Object.assign({ maxMs: 240000 }, opts);
  const t0 = Date.now();
  for (;;) {
    const r = await w.cron('resourcer-tick', { env: TICK_ENV, timeoutMs: 200000 });
    assert.ok([0, 137].includes(r.code), `tick rc ${r.code}: ${r.stdout}`);
    w.fastForward(10);
    const idle = !w.pendingFiles().length && !w.exists('runtime/run.json') && w.pipelineProcs().length === 0;
    if (idle) {
      // one more fire proves the system is quiet
      const again = await w.cron('resourcer-tick', { env: TICK_ENV });
      if (again.code === 0 && !w.pendingFiles().length && w.pipelineProcs().length === 0) return;
    }
    if (Date.now() - t0 > o.maxMs) throw new Error(`not settled after ${o.maxMs} ms: pending=${w.pendingFiles()} procs=${w.pipelineProcs().map((p) => p.cmd.slice(0, 80))} locks=${w.lockProblems()}`);
    await U.sleep(1500);
  }
}

function assertConsistent(w, sampler, what) {
  const ids = new Map(w.dbAll('select caterer_id, unlocked, zoho_id from candidates where caterer_id between 71000000 and 71999999').map((r) => [r.caterer_id, r]));
  for (const id of PUSHED) assert.ok(ids.get(id) && ids.get(id).zoho_id, `${what}: ${id} reached Zoho`);
  for (const id of [71000002, 71000006]) assert.equal(ids.get(id).unlocked, 0, `${what}: ${id} was rejected before unlock`);
  assert.equal(w.svc.zoho.created().length, 5, `${what}: five distinct new Zoho records`);
  const perKey = {};
  for (const c of w.svc.zoho.state.calls) if (c.op === 'create' && !c.duplicate) perKey[c.key] = (perKey[c.key] || 0) + 1;
  for (const [k, n] of Object.entries(perKey)) assert.equal(n, 1, `${what}: ${k} was created in Zoho once`);
  const ds = new Set(w.svc.zoho.created().map((r) => r.key));
  for (const id of PUSHED.filter((i) => i !== 71000010)) assert.ok(ds.has(String(id)), `${what}: ${id} exists in Zoho`);
  assert.deepEqual(w.pendingFiles(), [], `${what}: the pending search was consumed`);
  assert.deepEqual(w.lockProblems(), [], `${what}: no orphan lock or live status`);
  assert.deepEqual(w.pipelineProcs(), [], `${what}: no process left`);
  assert.deepEqual(w.list('downloads').filter((n) => /^(cv-|candidate-)/.test(n)), [], `${what}: no CV or candidate JSON left`);
  assert.ok(w.dbAll("select last_searched from territory_searches where location='LS29'")[0].last_searched > '2026-09-01', `${what}: the territory was searched in the end`);
  assert.ok(sampler.phase1 <= 1, `${what}: never two phase 1 at once (saw ${sampler.phase1})`);
  assert.ok(sampler.runner <= 1, `${what}: never two runners at once (saw ${sampler.runner})`);
  assert.ok(sampler.phase2 <= 1, `${what}: never two Phase 2 at once (saw ${sampler.phase2})`);
  assert.ok(sampler.n > 20, 'the sampler really ran');
  const bad = w.alerts().filter((a) => a.severity === 'critical');
  assert.deepEqual(bad, [], `${what}: no critical alert`);
  assert.deepEqual(C.secretHits(w), [], `${what}: no secret leaked`);
  assert.deepEqual(w.netBlocked(), []);
}

async function scene(name) {
  const w = new World(name);
  await w.create({});
  w.warmLoggedIn();
  w.svc.zoho.state.dupKeys.add('71000010');
  return w;
}

test('5.1 kill -9 the tick while its runner works: the next tick adopts the run, which finishes once', async (t) => {
  const w = await scene('s5-tick');
  t.after(() => w.close());
  const sampler = startSampler(w);
  w.dropPending({});
  const tk = w.cron('resourcer-tick', { env: TICK_ENV });
  await U.waitFor(() => pidOf(w, /watchdog-runner\.js/) && pidOf(w, /phase1\.js/), { timeoutMs: 30000, pollMs: 10, what: 'runner and phase 1 running' });
  const victim = tickPid(w);
  assert.ok(victim, 'the tick process was found');
  U.kill(victim);
  const dead = await tk;
  assert.match(dead.stdout, /^resourcer-tick failed rc=137/, 'Hermes sees the failure');
  assert.ok(pidOf(w, /watchdog-runner\.js/), 'the detached runner survived its tick');
  await settle(w);
  sampler.stop();
  assert.equal(started(w), 1, 'one run for one territory: the adopted run was not doubled');
  assert.match(w.text('logs/' + w.list('logs', /^tick-/)[0]), /runner finished a run \(exit 0\)/);
  assert.deepEqual(w.alerts().filter((a) => a.severity !== 'info'), [], 'an adopted run raises nothing');
  assertConsistent(w, sampler, 'tick kill');
});

test('5.2 kill -9 the runner right after it claimed the territory: crash noticed, claim given back, territory retried', async (t) => {
  const w = await scene('s5-runner');
  t.after(() => w.close());
  const sampler = startSampler(w);
  const pending = w.dropPending({});
  const tk = w.cron('resourcer-tick', { env: TICK_ENV });
  await U.waitFor(() => w.jsonl('logs/watchdog-runner.jsonl').some((e) => e.event === 'marked-spawned'), { timeoutMs: 30000, pollMs: 4 });
  U.kill(pidOf(w, /watchdog-runner\.js/));
  await tk;
  assert.ok(w.alerts().some((a) => a.key === 'runner-crashed' && a.severity === 'warn'));
  assert.equal(w.json(`pending-searches/${pending}`).spawnedAt, undefined, 'the claim is given back at once (not after the 10 minute stale-spawn window)');
  assert.equal(w.lockProblems().filter((p) => /run\.json|status/.test(p) && !/browser\.lock/.test(p)).length, 0);
  await settle(w);
  sampler.stop();
  assert.equal(started(w), 2, 'the crashed attempt and one retry');
  assertConsistent(w, sampler, 'runner kill');
});

test('5.3 kill -9 phase 1 after its first unlock: the unlocked candidate is recovered and pushed, the territory is re-run', async (t) => {
  const w = await scene('s5-phase1');
  t.after(() => w.close());
  const sampler = startSampler(w);
  w.dropPending({});
  const tk = w.cron('resourcer-tick', { env: TICK_ENV });
  await U.waitFor(() => /QUEUED \(1 total\)/.test(consoleLog(w)), { timeoutMs: 30000, pollMs: 5 });
  U.kill(pidOf(w, /phase1\.js/));
  await tk;
  assert.equal(w.lastRun().exitCode, 12);
  const row = w.dbAll('select unlocked, zoho_id from candidates where caterer_id = 71000001')[0];
  assert.ok(!row || (row.unlocked === 1 && row.zoho_id === null), 'the candidate is not in Zoho yet');
  const checkpoint = w.json(`downloads/${w.list('downloads', /^approved-queue-/)[0]}`);
  assert.deepEqual(checkpoint.candidates.map((c) => c.id), ['71000001'], 'the unlocked candidate is durable in the queue checkpoint');
  await settle(w);
  sampler.stop();
  assert.ok(w.alerts().some((a) => a.key === 'stranded-recovered'), 'the recovery says what it did');
  assert.ok(w.dbAll('select run_key from run_results').length >= 2, 'the recovery push and the full re-run each left a run_results row');
  assertConsistent(w, sampler, 'phase 1 kill');
});

test('5.4 kill -9 Phase 2 in the middle of the push: the queue is pushed again, nothing is created twice', async (t) => {
  const w = await scene('s5-phase2');
  t.after(() => w.close());
  const sampler = startSampler(w);
  w.dropPending({});
  const tk = w.cron('resourcer-tick', { env: TICK_ENV });
  await U.waitFor(() => /Step 5 - Zoho push/.test(consoleLog(w)), { timeoutMs: 30000, pollMs: 4 });
  U.kill(pidOf(w, /process-approved-queue\.js/));
  await tk;
  assert.ok(w.list('downloads', /^cv-/).length > 0, 'CVs are still on disk: nothing was pushed to completion');
  await settle(w);
  sampler.stop();
  assert.ok(w.alerts().some((a) => a.key === 'stranded-recovered'));
  assert.equal(w.dbAll('select count(*) n from run_results')[0].n, 1, 'one results row: the killed Phase 2 wrote none');
  assertConsistent(w, sampler, 'phase 2 kill');
});

test('5.5 kill -9 everything at once (an instance restart) in the middle of phase 1: the next ticks recover', async (t) => {
  const w = await scene('s5-everything');
  t.after(() => w.close());
  const sampler = startSampler(w);
  w.dropPending({});
  const tk = w.cron('resourcer-tick', { env: TICK_ENV });
  await U.waitFor(() => /QUEUED \(2 total\)/.test(consoleLog(w)), { timeoutMs: 30000, pollMs: 5 });
  for (const p of w.worldProcs(/./)) U.kill(p.pid);
  const dead = await tk;
  assert.equal(dead.signal, 'SIGKILL');
  assert.ok(w.exists('runtime/run.json') || w.exists('runtime/tick.lock'), 'the dead system left its locks and records behind');
  assert.deepEqual(w.pipelineProcs(), []);
  await settle(w);
  sampler.stop();
  assertConsistent(w, sampler, 'instance kill');
});

test('5.6 random kills: five kills at random moments, of a random victim (seeded), then recovery', async (t) => {
  const w = await scene('s5-random');
  t.after(() => w.close());
  let seed = Number(process.env.E2E_SEED || 20260929);
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const sampler = startSampler(w);
  w.dropPending({});
  // the tick, the runner, phase 1 and Phase 2; a killed leaf tool (one browser call, one screening call) is a per-candidate error by design
  const victims = [/^\S*node\S* scripts\/pipeline-watchdog\.js --tick/, /watchdog-runner\.js/, /phase1\.js/, /process-approved-queue\.js/];
  const log = [];
  for (let i = 0; i < 5; i += 1) {
    const tk = w.cron('resourcer-tick', { env: TICK_ENV, timeoutMs: 120000 });
    await U.sleep(200 + Math.floor(rnd() * 5500));
    const order = victims.map((re, k) => ({ re, k, r: rnd() })).sort((a, b) => a.r - b.r);
    let hit = null;
    for (const v of order) {
      const ps = w.worldProcs(v.re).filter((p) => !/env -i|timeout /.test(p.cmd));
      if (ps.length) { hit = { k: v.k, pid: ps[Math.floor(rnd() * ps.length)].pid }; break; }
    }
    if (hit) U.kill(hit.pid);
    log.push(hit ? hit.k : 'none');
    await tk;
    w.fastForward(10);
  }
  process.stderr.write(`[e2e] random kills (victim index per round): ${log.join(',')} (seed ${process.env.E2E_SEED || 20260929})\n`);
  await settle(w, { maxMs: 300000 });
  sampler.stop();
  assertConsistent(w, sampler, `random kills ${log.join(',')}`);
});
