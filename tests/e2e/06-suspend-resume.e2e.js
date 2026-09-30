'use strict';
// SCENARIO 6 - a suspended and resumed instance. Every process of the world is frozen with SIGSTOP while the wall clock
// of all pipeline processes jumps forward (tests/e2e/lib/preload.js models it: Date, and file times written after the
// jump, move; the monotonic clock does not). Afterwards nothing may be killed for being "old", nothing may be launched
// twice and the run must finish normally.
const test = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('./lib/world');
const C = require('./lib/checks');
const U = require('./lib/util');

const TICK_ENV = { RESOURCER_MAX_TICK_MIN: '1' };
const MIN = 60000;

const consoleLog = (w) => { const f = w.list('logs', /^phase1-console-/)[0]; return f ? w.text(`logs/${f}`) : ''; };
const events = (w) => w.jsonl('logs/watchdog-runner.jsonl').map((e) => e.event);

function sampler(w) {
  const s = { phase1: 0, runner: 0, n: 0 };
  const t = setInterval(() => {
    const ps = w.pipelineProcs();
    s.phase1 = Math.max(s.phase1, ps.filter((p) => /phase1\.js/.test(p.cmd)).length);
    s.runner = Math.max(s.runner, ps.filter((p) => /watchdog-runner\.js/.test(p.cmd)).length);
    s.n += 1;
  }, 30);
  s.stop = () => clearInterval(t);
  return s;
}

async function scene(name, slow) {
  const w = new World(name);
  await w.create({});
  w.warmLoggedIn();
  w.svc.zoho.state.dupKeys.add('71000010');
  // slow browser calls: the run must outlast the supervisor's 25 s wake-up check, or a wrongful kill could never happen
  if (slow) w.setBrowserScenario({ rules: [{ when: { cmd: 'open' }, do: { delayMs: 8000 } }, { when: { cmd: 'eval' }, do: { delayMs: 2500 } }] });
  return w;
}

function signalAll(pids, sig) { for (const p of pids) U.kill(p, sig); }

function assertHealthyRun(w, s, what) {
  const last = w.lastRun();
  assert.equal(last.exitCode, 0, `${what}: the run finished normally`);
  assert.equal(last.killed, false, `${what}: not killed`);
  assert.equal(events(w).filter((e) => e === 'picked').length, 1, `${what}: launched once`);
  for (const bad of ['phase1-timeout-kill', 'phase1-killed-timeout', 'phase1-nonzero', 'busy-abort']) assert.ok(!events(w).includes(bad), `${what}: no ${bad}`);
  const keys = w.alerts().map((a) => a.key);
  for (const bad of ['run-killed', 'runner-crashed', 'run-failures', 'caterer-session', 'push-drought']) assert.ok(!keys.includes(bad), `${what}: no ${bad} alert (${keys})`);
  assert.equal(w.svc.zoho.created().length, 5, `${what}: five records in Zoho`);
  assert.deepEqual(w.pendingFiles(), []);
  assert.deepEqual(w.lockProblems(), [], `${what}: no leftover lock`);
  assert.equal(w.dbAll('select count(*) n from run_results')[0].n, 1, `${what}: one results row`);
  assert.ok(s.phase1 <= 1 && s.runner <= 1, `${what}: never two at once (phase1 ${s.phase1}, runner ${s.runner})`);
  const tickLog = w.list('logs', /^tick-/).map((n) => w.text('logs/' + n)).join('\n');
  assert.doesNotMatch(tickLog, /exceeded d+ min and its runner did not act/, what + ': the supervisor did not order a kill for a run that was merely frozen');
  assert.deepEqual(w.json('runtime/watchdog-state.json').killedNonces, {}, what + ': no run was marked as killed');
  const led = w.json('runtime/clock-jumps.json', []);
  assert.ok(Array.isArray(led) && led.some((e) => e.to - e.from >= 60 * MIN), `${what}: the frozen interval is in the ledger: ${JSON.stringify(led)}`);
  assert.deepEqual(C.secretHits(w), []);
}

test('6.1 the whole instance freezes mid-run and resumes 90 minutes later (past the 70 minute ceiling): the run is neither killed nor doubled', async (t) => {
  const w = await scene('s6-freeze-all', true);
  t.after(() => w.close());
  const s = sampler(w);
  w.dropPending({});
  const tick = w.cron('resourcer-tick', { env: TICK_ENV, timeoutMs: 300000 });
  await U.waitFor(() => /QUEUED \(1 total\)/.test(consoleLog(w)), { timeoutMs: 40000, pollMs: 10, what: 'the first unlock' });

  const frozen = w.worldProcs(/./).map((p) => p.pid).filter((p) => p !== process.pid);
  assert.ok(frozen.length >= 4, `frozen ${frozen.length} processes`);
  signalAll(frozen, 'SIGSTOP');
  w.jump(90 * MIN);
  await U.sleep(3500);
  signalAll(frozen, 'SIGCONT');

  // the every-minute cron fires again right after the resume
  const second = w.cron('resourcer-tick', { env: TICK_ENV, timeoutMs: 300000 });
  await Promise.all([tick, second]);
  await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json') && w.pipelineProcs().length === 0, { maxTicks: 20, tickMin: 1, gapMs: 1500 });
  s.stop();
  assertHealthyRun(w, s, 'freeze of everything');
  assert.match(w.text('logs/' + w.list('logs', /^tick-/)[0]), /clock jumped \d+s/, 'a tick noticed the jump and said so');
});

test('6.2 only the run is frozen (runner, phase 1 and their tools) while the tick keeps running; the wall clock jumps 80 minutes', async (t) => {
  const w = await scene('s6-freeze-run', true);
  t.after(() => w.close());
  const s = sampler(w);
  w.dropPending({});
  const tick = w.cron('resourcer-tick', { env: TICK_ENV, timeoutMs: 300000 });
  await U.waitFor(() => /QUEUED \(1 total\)/.test(consoleLog(w)), { timeoutMs: 40000, pollMs: 10 });

  const run = w.worldProcs(/watchdog-runner\.js|phase1\.js|ai-review\.js|caterer-|fake-ab|agent-browser|process-approved-queue/).map((p) => p.pid).filter((p) => p !== process.pid);
  assert.ok(run.length >= 2);
  signalAll(run, 'SIGSTOP');
  w.jump(80 * MIN);
  await U.sleep(12500); // the tick supervises every 10 s: it sees a stale heartbeat and a jumped clock
  const midTick = w.jsonl('logs/watchdog-runner.jsonl').length;
  signalAll(run, 'SIGCONT');
  await tick;
  await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json') && w.pipelineProcs().length === 0, { maxTicks: 20, tickMin: 1, gapMs: 1500 });
  s.stop();
  assert.ok(midTick > 0);
  assertHealthyRun(w, s, 'freeze of the run');
});

test('6.3 a resumed instance whose tick lock looks hours old: a fresh tick does not steal it from a live tick, nor start a second run', async (t) => {
  const w = await scene('s6-lock');
  t.after(() => w.close());
  const s = sampler(w);
  w.dropPending({});
  const tick = w.cron('resourcer-tick', { env: { RESOURCER_MAX_TICK_MIN: '2' }, timeoutMs: 300000 });
  await U.waitFor(() => /QUEUED \(1 total\)/.test(consoleLog(w)), { timeoutMs: 40000, pollMs: 10 });
  const frozen = w.worldProcs(/./).map((p) => p.pid).filter((p) => p !== process.pid);
  signalAll(frozen, 'SIGSTOP');
  w.jump(3 * 60 * MIN);
  await U.sleep(1500);
  // the instance wakes: the fresh cron fire runs BEFORE the frozen processes get scheduled again
  const early = w.cron('resourcer-tick', { env: TICK_ENV, timeoutMs: 120000 });
  await U.sleep(2500);
  signalAll(frozen, 'SIGCONT');
  await Promise.all([tick, early]);
  await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json') && w.pipelineProcs().length === 0, { maxTicks: 20, tickMin: 1, gapMs: 1500 });
  s.stop();
  assertHealthyRun(w, s, 'wake-up race');
});
