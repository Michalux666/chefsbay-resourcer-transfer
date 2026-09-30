'use strict';
// A Hermes instance is frozen when idle and resumed later: the wall clock jumps, every start time and
// heartbeat looks hours old, but nothing died. These tests drive the tick, the runner and the shared
// ledger with injectable wall and monotonic clocks and prove that a healthy run is neither killed nor
// ignored (and then doubled) after a resume, while a wedged one is still ended.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const H = require('./_helpers');

H.installNetworkGuard();
process.env.RESOURCER_HOME = H.mkHome(null, 'resumebase');
const wd = require(path.join(H.SRC_SCRIPTS, 'pipeline-watchdog.js'));
const tick = require(path.join(H.SRC_SCRIPTS, 'lib', 'tick.js'));
const runner = require(path.join(H.SRC_SCRIPTS, 'watchdog-runner.js'));

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();
const setMtime = (file, ms) => fs.utimesSync(file, new Date(ms), new Date(ms));

// --- the shared ledger and the clock guard ------------------------------------------------------

test('clock guard: a freeze that paused the monotonic clock, one that did not, and the ordinary cases', () => {
  let wall = 1000000;
  let mono = 5000;
  const g = tick.makeClockGuard({ wall: () => wall, mono: () => mono, thresholdMs: 60 * SEC });

  wall += 10 * SEC; mono += 10 * SEC;
  assert.equal(g.check(10 * SEC), null, 'an ordinary interval');

  wall += 2 * HOUR + 10 * SEC; mono += 10 * SEC;
  let j = g.check();
  assert.equal(j.kind, 'clock', 'wall ran ahead of the monotonic clock');
  assert.equal(j.jumpMs, 2 * HOUR);
  assert.equal(j.toMs, wall);
  assert.equal(j.fromMs, wall - 2 * HOUR);

  wall += 2 * HOUR + 10 * SEC; mono += 2 * HOUR + 10 * SEC;
  assert.equal(g.check(), null, 'both clocks moved: without an expected length nothing is provably wrong');
  wall += 2 * HOUR + 10 * SEC; mono += 2 * HOUR + 10 * SEC;
  j = g.check(10 * SEC);
  assert.equal(j.kind, 'gap', 'the span was 2 h where 10 s was expected');
  assert.equal(j.jumpMs, 2 * HOUR);

  wall += 59 * SEC; mono += 0;
  assert.equal(g.check(), null, 'just under the threshold');
  wall -= 3 * HOUR;
  assert.equal(g.check(10 * SEC), null, 'a wall clock stepped backwards never counts as a freeze');
  g.mark();
  wall += 5 * SEC; mono += 5 * SEC;
  assert.equal(g.check(5 * SEC), null, 'mark() re-bases both clocks');
});

test('ledger: intervals merge, are pruned after 48 h, survive garbage, and discount an age by their overlap only', (t) => {
  const home = H.mkHome(t, 'ledger');
  const file = tick.runtimeFiles(home).suspensions;
  const now = Date.UTC(2026, 8, 29, 12, 0, 0);
  assert.deepEqual(tick.readSuspensions(file), [], 'missing file');
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(tick.readSuspensions(file), [], 'garbage');
  fs.writeFileSync(file, JSON.stringify([{ from: 'x', to: 5 }, null, { from: 9, to: 3 }, 7]));
  assert.deepEqual(tick.readSuspensions(file), [], 'malformed entries are dropped');

  fs.rmSync(file);
  tick.recordSuspension(file, now - 5 * HOUR, now - 3 * HOUR, now);
  tick.recordSuspension(file, now - 3 * HOUR + 500, now - 2 * HOUR, now);
  assert.deepEqual(tick.readSuspensions(file), [{ from: now - 5 * HOUR, to: now - 2 * HOUR }], 'two sightings of one freeze merge');
  tick.recordSuspension(file, now - 60 * HOUR, now - 59 * HOUR, now);
  assert.equal(tick.readSuspensions(file).length, 1, 'an entry older than 48 h is forgotten');
  assert.equal(tick.recordSuspension(file, 5, 5, now), null, 'an empty interval is refused');
  assert.equal(tick.recordSuspension(file, NaN, 9, now), null);

  assert.equal(tick.suspendedMs(file, now - 4 * HOUR, now), 2 * HOUR, 'only the overlap counts');
  assert.equal(tick.suspendedMs(file, now - 6 * HOUR, now), 3 * HOUR);
  assert.equal(tick.suspendedMs(file, now - HOUR, now), 0);
  assert.equal(tick.effectiveAgeMs(file, now - 4 * HOUR, now), 2 * HOUR);
  assert.equal(tick.effectiveAgeMs(file, now - 10 * MIN, now), 10 * MIN);
  assert.equal(tick.effectiveAgeMs(file, now + HOUR, now), 0, 'never negative');
  assert.equal(tick.effectiveAgeMs(file, NaN, now), 0);
});

test('busyState: a recovered child and a run-lock that only look old because the instance was frozen still block a launch', (t) => {
  const live = H.sleeper(t);
  const home = H.mkHome(t, 'busyfreeze');
  const files = tick.runtimeFiles(home);
  const now = Date.now();
  H.writeJson(files.adopted, [{ pid: live.pid, token: tick.procToken(live.pid), id: 'phase1-x', mode: 'run-pipeline', addedAt: iso(now - 90 * MIN) }]);
  assert.equal(tick.busyState({ home, now }).busy, false, 'without a recorded freeze 90 minutes is past the 72-minute limit');
  tick.recordSuspension(files.suspensions, now - 80 * MIN, now - 30 * MIN, now);
  const b = tick.busyState({ home, now });
  assert.equal(b.busy, true, 'with 50 minutes of frozen time it is 40 minutes old');
  assert.equal(b.kind, 'adopted');

  const home2 = H.mkHome(t, 'busyfreeze2');
  const f2 = tick.runtimeFiles(home2);
  fs.writeFileSync(path.join(f2.runs, 'phase1-q.json.run-lock'), JSON.stringify({ pid: live.pid, startedAt: now - 90 * MIN }));
  assert.equal(tick.busyState({ home: home2, now }).busy, false, 'a 90-minute-old run-lock is stale');
  tick.recordSuspension(f2.suspensions, now - 80 * MIN, now - 30 * MIN, now);
  assert.equal(tick.busyState({ home: home2, now }).kind, 'run-lock');
});

test('inspectRun: the heartbeat age excludes frozen time, so a stopped clock does not make a live runner look dead', (t) => {
  const home = H.mkHome(t, 'inspectfreeze');
  const files = tick.runtimeFiles(home);
  const now = Date.now();
  H.writeJson(files.run, { pid: process.pid, token: tick.procToken(process.pid), nonce: 'n', startedAt: iso(now - 3 * HOUR) });
  setMtime(files.run, now - 2 * HOUR);
  assert.ok(tick.inspectRun(files.run, now).heartbeatAgeMs >= 2 * HOUR - 5 * SEC);
  tick.recordSuspension(files.suspensions, now - 2 * HOUR + 10 * SEC, now - 5 * SEC, now);
  const insp = tick.inspectRun(files.run, now);
  assert.ok(insp.heartbeatAgeMs <= 20 * SEC, `heartbeat age ${insp.heartbeatAgeMs}`);
  assert.equal(insp.alive, true);
});

test('heartbeatAdvances: true only when the file moved between the two reads (an injectable sleep drives it)', async (t) => {
  const home = H.mkHome(t, 'hbadv');
  const file = path.join(home, 'runtime', 'hb.json');
  H.writeJson(file, {});
  setMtime(file, 1700000000000);
  assert.equal(await tick.heartbeatAdvances(file, 25 * SEC, async () => {}), false, 'nothing moved');
  assert.equal(await tick.heartbeatAdvances(file, 25 * SEC, async () => setMtime(file, 1700000010000)), true, 'the owner beat while we waited');
  assert.equal(await tick.heartbeatAdvances(path.join(home, 'runtime', 'missing.json'), 1, async () => {}), false);
});

// --- the tick with injected clocks --------------------------------------------------------------

function mkEnv(t, o = {}) {
  const home = H.mkHome(t, 'resume');
  const files = tick.runtimeFiles(home);
  const notify = H.collectNotifier();
  const s = { clock: o.start || H.londonEpoch(2026, 9, 29, 10, 0), mono: 0 };
  const logs = [];
  const killed = [];
  const spawns = [];
  const gateCalls = [];
  const gates = (o.gate || []).slice();
  const hooks = { onSleep: null, onGate: null };
  const ctx = wd.makeCtx(Object.assign({
    home,
    dbFit: () => ({ ok: true }),
    now: () => s.clock,
    mono: () => s.mono,
    heartbeatGraceMs: 25 * SEC,
    sleep: async (ms) => {
      s.clock += ms;
      s.mono += ms;
      if (hooks.onSleep) hooks.onSleep(ms);
    },
    log: (m, lvl) => logs.push(`${lvl || 'info'}: ${m}`),
    notify,
    slowChecks: async () => {},
    diskGuard: () => ({}),
    exec: async (script) => {
      if (script === 'pending-gate.js') {
        gateCalls.push(s.clock);
        if (hooks.onGate) hooks.onGate();
        const g = gates.length ? gates.shift() : 'NO_WORK';
        if (g === 'READY') {
          return { code: 0, stdout: JSON.stringify({ status: 'READY', file: 'territory-1-x.json', filePath: path.join(home, 'pending-searches', 'territory-1-x.json'), pending: { jobTitle: 'Chef', location: 'AB1' }, queueDepth: 2 }), stderr: '' };
        }
        return { code: 0, stdout: g, stderr: '' };
      }
      if (script === 'cull-ghost-phase1.js') return { code: 0, stdout: 'CULL_OK culled=0 kept=0', stderr: '' };
      if (script === 'queue-due-territories.js') return { code: 0, stdout: JSON.stringify({ status: 'nothing_to_queue', due: 0, queued: 0 }), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    halt: { getHalt: () => null, setHalt: () => {}, clearHalt: () => {} },
    screening: () => ({ check: async () => ({ ok: true }) }),
    memAvailMb: () => 4000,
    killTree: async (pid) => { killed.push(pid); return true; },
    spawnRunner: () => {
      spawns.push(s.clock);
      const child = new EventEmitter();
      child.pid = process.pid;
      return child;
    },
  }, o.ctx || {}));
  const env = {
    home, files, ctx, notify, logs, killed, spawns, gateCalls, hooks, s,
    // The runner of the test: this very process, whose liveness is provable, with a heartbeat the test controls.
    startRun(startedMsAgo, extra) {
      const started = s.clock - startedMsAgo;
      H.writeJson(files.run, Object.assign({ pid: process.pid, token: tick.procToken(process.pid), nonce: 'live1', startedAt: iso(started), phase1StartedAt: iso(started), file: 'territory-1-x.json' }, extra));
      setMtime(files.run, s.clock);
      return started;
    },
    beat() { setMtime(files.run, s.clock); },
    freezeWall(ms) { s.clock += ms; },
    freezeBoth(ms) { s.clock += ms; s.mono += ms; },
    state: () => H.readJson(files.state, {}),
    ledger: () => tick.readSuspensions(files.suspensions),
    tick: (opts) => wd.runTick(ctx, Object.assign({ maxMinutes: 3, superviseMs: 10 * SEC }, opts)),
  };
  return env;
}

test('a healthy run is not killed when the instance is frozen for two hours inside a sleep (wall clock jumps, monotonic clock does not)', async (t) => {
  const e = mkEnv(t, { gate: ['READY'] });
  e.startRun(30 * MIN);
  let frozen = false;
  e.hooks.onSleep = () => {
    if (!frozen) { frozen = true; e.freezeWall(2 * HOUR); }
    e.beat();
  };
  const out = await e.tick();
  assert.equal(e.killed.length, 0, 'the 30-minute-old run is not past the 70-minute ceiling');
  assert.equal(e.spawns.length, 0, 'and it still blocks a launch');
  assert.equal(e.gateCalls.length, 0, 'the gate is never asked while a run is alive');
  assert.ok(['bound', 'lock-lost'].includes(out.reason) || out.reason === 'bound', out.reason);
  const ledger = e.ledger();
  assert.equal(ledger.length, 1);
  assert.ok(Math.abs((ledger[0].to - ledger[0].from) - 2 * HOUR) < 2 * SEC, 'the ledger holds the freeze');
  assert.ok(e.logs.some((l) => /clock jumped 7200s/.test(l)), e.logs.join('\n'));
  assert.equal(e.state().lastClockJumpAt > 0, true);
  assert.equal(e.state().lastResume.runHeartbeatAdvancing, true, 'the heartbeat was read twice after the jump and moved');
  assert.equal(tick.inspectRun(e.files.run, e.s.clock).alive, true);
});

test('the same freeze with both clocks running (a snapshot restore) is found by the sleep overshoot', async (t) => {
  const e = mkEnv(t);
  e.startRun(30 * MIN);
  let frozen = false;
  e.hooks.onSleep = () => {
    if (!frozen) { frozen = true; e.freezeBoth(3 * HOUR); }
    e.beat();
  };
  await e.tick();
  assert.equal(e.killed.length, 0);
  assert.equal(e.ledger().length, 1);
  assert.ok(e.logs.some((l) => /clock jumped 10800s \(gap\)/.test(l)), e.logs.join('\n'));
});

test('a freeze inside an iteration (a slow gate call) is found by the monotonic comparison', async (t) => {
  const e = mkEnv(t, { gate: ['NO_WORK'] });
  e.hooks.onGate = () => e.freezeWall(2 * HOUR);
  await e.tick({ once: true });
  assert.equal(e.ledger().length, 1);
  assert.ok(e.logs.some((l) => /clock jumped 7200s \(clock\)/.test(l)));
});

test('a run really past the ceiling is still ended: a static heartbeat gets no benefit of the doubt', async (t) => {
  const e = mkEnv(t);
  const runnerProc = H.sleeper(t);
  const child = H.sleeper(t);
  const started = e.s.clock - 73 * MIN;
  H.writeJson(e.files.run, { pid: runnerProc.pid, token: tick.procToken(runnerProc.pid), childPid: child.pid, childToken: tick.procToken(child.pid), nonce: 'wedged', startedAt: iso(started), phase1StartedAt: iso(started), file: 'x' });
  setMtime(e.files.run, e.s.clock - MIN);
  await e.tick({ once: true });
  assert.ok(e.killed.includes(child.pid), 'phase1 child');
  assert.ok(e.killed.includes(runnerProc.pid), 'and the wedged runner');
  assert.equal(e.state().killedNonces.wedged, 'overrun');
  assert.ok(e.ledger().length === 0, 'no freeze was involved');
});

test('an unrecorded freeze: past the ceiling by the wall clock but the runner heartbeat advances, so the run is spared up to 10 minutes over, not beyond', async (t) => {
  const e = mkEnv(t);
  const limit = 70 * MIN + 2 * MIN;
  e.startRun(limit + 1 * MIN);
  e.hooks.onSleep = () => e.beat();
  await e.tick({ once: true });
  assert.equal(e.killed.length, 0, 'one minute over with a beating runner: not killed');
  assert.ok(e.logs.some((l) => /still heartbeating: not killed/.test(l)));

  const e2 = mkEnv(t);
  e2.startRun(limit + 15 * MIN);
  e2.hooks.onSleep = () => e2.beat();
  await e2.tick({ once: true });
  assert.ok(e2.killed.includes(process.pid), 'a runner whose own timer failed is not allowed to hold the queue forever');
});

test('a fresh tick after a resume waits one grace period so the live runner can announce the freeze, then decides with the ledger', async (t) => {
  const e = mkEnv(t, { gate: ['READY'] });
  const start = e.s.clock;
  e.startRun(150 * MIN);
  setMtime(e.files.run, start - 2 * HOUR);
  H.writeJson(e.files.state, Object.assign(wd.defaultState(), { lastTickAt: start - 2 * HOUR }));
  let announced = false;
  e.hooks.onSleep = () => {
    if (!announced) {
      announced = true;
      // what the runner's own heartbeat loop does within seconds of the resume
      tick.recordSuspension(e.files.suspensions, start - 2 * HOUR, start, e.s.clock);
      e.beat();
    }
  };
  const out = await e.tick({ once: true });
  assert.equal(e.killed.length, 0, 'a 150-minute wall age with 120 minutes frozen is a 30-minute run');
  assert.equal(e.spawns.length, 0);
  assert.equal(e.gateCalls.length, 0);
  assert.equal(out.reason, 'once');
  assert.equal(e.state().lastResume.quiet, true);
  assert.equal(e.state().lastResume.runHeartbeatAdvancing, true);
  assert.ok(e.logs.some((l) => /resume check: a run is in flight and its heartbeat is advancing after 25s/.test(l)));
});

test('after a resume a recovered child that only looks old blocks the launch and is not killed; without the ledger it would be', async (t) => {
  const live = H.sleeper(t);
  const mk = (withLedger) => {
    const e = mkEnv(t, { gate: ['READY'] });
    H.writeJson(e.files.adopted, [{ pid: live.pid, token: tick.procToken(live.pid), id: 'phase1-x', mode: 'process-approved-queue', addedAt: iso(e.s.clock - 20 * MIN) }]);
    e.freezeWall(HOUR);
    if (withLedger) tick.recordSuspension(e.files.suspensions, e.s.clock - HOUR, e.s.clock, e.s.clock);
    return e;
  };
  const guarded = mk(true);
  await guarded.tick({ once: true });
  assert.equal(guarded.killed.length, 0);
  assert.equal(guarded.spawns.length, 0, 'no second run beside the recovered child');
  assert.equal(guarded.gateCalls.length, 0);

  const bare = mk(false);
  await bare.tick({ once: true });
  assert.ok(bare.killed.includes(live.pid), 'unchanged behaviour when nothing froze: 80 minutes is past the limit');
});

test('a tick that was frozen through a takeover neither launches nor overwrites the new owner state', async (t) => {
  const e = mkEnv(t, { gate: ['READY'] });
  e.hooks.onGate = () => {
    // another tick took the lock and did its own work while this one was suspended
    fs.writeFileSync(e.files.tickLock, JSON.stringify({ pid: process.pid, nonce: 'the-new-owner', startedAt: iso(e.s.clock) }));
    H.writeJson(e.files.state, Object.assign(wd.defaultState(), { marker: 'written-by-the-new-owner', handledRunNonce: 'n7' }));
  };
  const out = await e.tick({ once: true });
  assert.equal(out.reason, 'lock-lost');
  assert.equal(e.spawns.length, 0, 'no launch after the lock was lost');
  const st = e.state();
  assert.equal(st.marker, 'written-by-the-new-owner', 'the stale copy did not overwrite it');
  assert.equal(st.handledRunNonce, 'n7');
  assert.equal(tick.readRecord(e.files.tickLock).rec.nonce, 'the-new-owner', 'and the new owner keeps its lock');
  assert.ok(e.logs.some((l) => /taken over during this iteration/.test(l)));
});

test('an ordinary tick with no freeze pays nothing: no settle wait, no ledger, same launch timing', async (t) => {
  const e = mkEnv(t, { gate: ['READY', 'NO_WORK'] });
  const before = e.s.clock;
  const out = await e.tick({ once: true });
  assert.equal(e.spawns.length, 1);
  assert.equal(e.spawns[0] - before < 5 * SEC, true, 'launched without waiting');
  assert.equal(e.ledger().length, 0);
  assert.equal(fs.existsSync(e.files.suspensions), false);
  assert.equal(out.reason, 'once');
  assert.equal(e.state().lastResume, null);
});

// --- the runner with injected clocks ------------------------------------------------------------

function realRunnerEnv(t, ctl) {
  const home = H.mkHome(t, 'resumerunner');
  H.installScripts(home);
  H.setCtl(home, 'phase1', ctl || { sleepMs: 60000 });
  const files = tick.runtimeFiles(home);
  const paramsFile = path.join(home, 'runs', 'params.json');
  H.writeJson(paramsFile, { INIT_STATUS_FILE: path.join(home, 'runs', 'phase1-init.json'), JOB_TITLE: 'Chef', LOCATION: 'AB1', SOURCES: 'caterer' });
  return { home, files, paramsFile };
}

async function runPhase1With(r, ctxOver) {
  const events = [];
  const ctx = runner.makeCtx(Object.assign({ home: r.home, log: (e, d) => events.push([e, d]), settleMs: 0 }, ctxOver));
  const fd = fs.openSync(path.join(r.home, 'logs', 'p1.log'), 'a');
  const t0 = Date.now();
  let res;
  try { res = await runner.runPhase1(ctx, r.paramsFile, fd, null, ctx.log); } finally { fs.closeSync(fd); }
  return { res, events, ms: Date.now() - t0 };
}

test('runner ceiling: a timer that fires early in active time (a jumped monotonic clock) re-arms instead of killing a young run', async (t) => {
  const r = realRunnerEnv(t, { sleepMs: 60000 });
  let wall = Date.UTC(2026, 8, 29, 10, 0, 0);
  setTimeout(() => { wall += 450; }, 500);
  const out = await runPhase1With(r, { now: () => wall, maxRunMs: 400 });
  const names = out.events.map((x) => x[0]);
  assert.ok(names.includes('phase1-timeout-deferred'), names.join());
  assert.ok(names.indexOf('phase1-timeout-deferred') < names.indexOf('phase1-timeout-kill'));
  assert.equal(out.res.killed, true, 'and it is still ended once the active time reaches the ceiling');
  assert.ok(out.ms >= 780, `the kill waited for the active clock (${out.ms} ms)`);
});

test('runner ceiling: time another process has already recorded as frozen is not counted against the run', async (t) => {
  const r = realRunnerEnv(t, { sleepMs: 60000 });
  const now = Date.now();
  tick.recordSuspension(r.files.suspensions, now - 1000, now + 300, now);
  const out = await runPhase1With(r, { maxRunMs: 400 });
  const names = out.events.map((x) => x[0]);
  assert.ok(names.includes('phase1-timeout-deferred'), names.join());
  assert.equal(out.res.killed, true);
  assert.ok(out.ms >= 650, `${out.ms} ms: 400 ms ceiling plus about 300 ms of recorded frozen time`);
});

test('runner ceiling without any freeze is unchanged: the run is killed when the ceiling is reached', async (t) => {
  const r = realRunnerEnv(t, { sleepMs: 60000 });
  const out = await runPhase1With(r, { maxRunMs: 400 });
  const names = out.events.map((x) => x[0]);
  assert.equal(names.includes('phase1-timeout-deferred'), false);
  assert.equal(out.res.killed, true);
  assert.ok(out.ms < 5000);
});

test('runner heartbeat records a freeze it sees (wall jumped, monotonic did not) in the shared ledger', async (t) => {
  const home = H.mkHome(t, 'runnerhb');
  H.installScripts(home);
  const files = tick.runtimeFiles(home);
  let wall = Date.UTC(2026, 8, 29, 10, 0, 0);
  const events = [];
  const pendingData = { jobTitle: 'Chef', location: 'AB1', distance: 20, keywords: '', priority: 'low', sources: 'caterer', cvLimit: 20, requestedAt: iso(wall), source: 'territory-scheduler' };
  H.writeJson(path.join(home, 'pending-searches', 'territory-1-x.json'), pendingData);
  const ctx = runner.makeCtx({
    home,
    now: () => wall,
    mono: () => Number(process.hrtime.bigint() / 1000000n),
    heartbeatMs: 30,
    settleMs: 0,
    log: (e, d) => events.push([e, d]),
    browserLockWaitMs: 0,
    browserLock: { wait: async () => ({ acquired: true, borrowed: false, holder: {}, release: () => {} }) },
    buildResultsUrl: () => ({ url: 'https://example.test/r', searchId: 's' }),
    ensureLoggedIn: async () => 'ok',
    exec: async (script, args) => {
      if (script === 'pending-gate.js' && args.length === 0) {
        return { code: 0, stdout: JSON.stringify({ status: 'READY', file: 'territory-1-x.json', filePath: path.join(home, 'pending-searches', 'territory-1-x.json'), pending: pendingData, queueDepth: 1 }), stderr: '' };
      }
      if (script === 'create-init-status.js') {
        const f = path.join(home, 'runs', 'phase1-2026-09-29-1000.json');
        H.writeJson(f, { id: 'x', status: 'phase1_initializing', jobTitle: 'Chef', location: 'AB1' });
        return { code: 0, stdout: `INIT_FILE:${f}`, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    runPhase1: async () => {
      await new Promise((res) => setTimeout(res, 120));
      wall += 3 * HOUR;
      await new Promise((res) => setTimeout(res, 250));
      return { code: 0, killed: false, aborted: null };
    },
  });
  const res = await runner.runOnce(ctx, ['--from-gate']);
  assert.equal(res.code, 0);
  const ledger = tick.readSuspensions(files.suspensions);
  assert.equal(ledger.length, 1);
  assert.ok(Math.abs((ledger[0].to - ledger[0].from) - 3 * HOUR) < 2 * SEC, JSON.stringify(ledger));
  assert.ok(events.some((e) => e[0] === 'clock-jump' && e[1].seconds === 10800 && ['clock', 'gap'].includes(e[1].kind)), JSON.stringify(events.filter((e) => e[0] === 'clock-jump')));
});

test('real processes: a run whose whole process group is stopped for longer than its ceiling is not killed on resume', { skip: !H.IS_LINUX && 'SIGSTOP/SIGCONT are verified on Linux (WSL)', timeout: 60000 }, async (t) => {
  const { spawn } = require('child_process');
  const home = H.mkHome(t, 'sigstop');
  H.installScripts(home);
  H.setCtl(home, 'phase1', { sleepMs: 1200 });
  H.pendingFile(home, 'territory-7-x.json', { sources: 'caterer' });
  const driver = `
const path = require('path');
const home = process.env.RESOURCER_HOME;
const r = require(path.join(home, 'scripts', 'watchdog-runner.js'));
const ctx = r.makeCtx(Object.assign({ home, settleMs: 0, log: () => {} }, JSON.parse(process.env.DRIVER_CTX)));
r.runOnce(ctx, ['--from-gate']).then((res) => process.exit(res.code), (e) => { console.error(e); process.exit(99); });
`;
  fs.writeFileSync(path.join(home, 'driver.js'), driver);
  const files = tick.runtimeFiles(home);
  const c = spawn(process.execPath, [path.join(home, 'driver.js')], {
    cwd: home, env: { ...process.env, RESOURCER_HOME: home, DRIVER_CTX: JSON.stringify({ maxRunMs: 2000, heartbeatMs: 100, clockJumpMs: 800 }) }, stdio: 'ignore',
  });
  const exited = new Promise((resolve) => c.on('close', (code) => resolve(code)));
  t.after(() => { try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } });
  const rec = await H.waitFor(() => { const x = H.readJson(files.run, null); return x && x.childPid ? x : null; }, 15000);
  assert.ok(rec, 'phase1 started');
  await new Promise((res) => setTimeout(res, 300));
  process.kill(-rec.childPid, 'SIGSTOP');
  process.kill(rec.pid, 'SIGSTOP');
  await new Promise((res) => setTimeout(res, 3000));
  process.kill(rec.pid, 'SIGCONT');
  process.kill(-rec.childPid, 'SIGCONT');
  const code = await exited;
  assert.equal(code, 0, 'the 3-second stop is not counted against the 2-second ceiling');
  const ledger = tick.readSuspensions(files.suspensions);
  assert.equal(ledger.length >= 1, true, 'the runner recorded the stop');
  assert.ok(ledger[0].to - ledger[0].from >= 2000, JSON.stringify(ledger));
  assert.equal(H.readJson(files.lastRun).exitCode, 0);
});

// --- stale tick lock after a resume ---------------------------------------------------------------

const LINUX_ONLY = !H.IS_LINUX && 'liveness by /proc identity is verified on Linux (WSL)';

function lockHeldBy(e, o) {
  const rec = Object.assign({ pid: process.pid, token: tick.procToken(process.pid), nonce: 'the-holder', startedAt: iso(Date.now() - 3 * HOUR), role: 'tick' }, o);
  H.writeJson(e.files.tickLock, rec);
  setMtime(e.files.tickLock, Date.now() - 2 * HOUR);
  return rec;
}

test('stale-looking tick lock, holder alive and heartbeating after the grace period: the newcomer leaves it alone', { skip: LINUX_ONLY }, async (t) => {
  const e = mkEnv(t, { gate: ['READY'] });
  lockHeldBy(e);
  const waits = [];
  e.hooks.onSleep = (ms) => { waits.push(ms); setMtime(e.files.tickLock, Date.now()); };
  const out = await e.tick({ once: true });
  assert.equal(out.reason, 'overlap');
  assert.deepEqual(waits, [25 * SEC], 'one grace period, heartbeat read before and after');
  assert.equal(tick.readRecord(e.files.tickLock).rec.nonce, 'the-holder', 'the lock was not taken');
  assert.equal(e.spawns.length, 0);
  assert.equal(e.gateCalls.length, 0);
});

test('stale-looking tick lock, holder alive but its heartbeat never moves (wedged): taken over after exactly one grace period', { skip: LINUX_ONLY }, async (t) => {
  const e = mkEnv(t, { gate: ['NO_WORK'] });
  lockHeldBy(e);
  const waits = [];
  e.hooks.onSleep = (ms) => waits.push(ms);
  const out = await e.tick({ once: true });
  assert.equal(out.reason, 'gate-no_work', 'the newcomer took the lock and ran');
  assert.deepEqual(waits.slice(0, 1), [25 * SEC]);
  assert.equal(e.gateCalls.length, 1);
});

test('stale-looking tick lock explained by a recorded freeze is not stale at all: no wait, no takeover', { skip: LINUX_ONLY }, async (t) => {
  const e = mkEnv(t);
  lockHeldBy(e);
  tick.recordSuspension(e.files.suspensions, Date.now() - 2 * HOUR + 5 * SEC, Date.now() - 2 * SEC, Date.now());
  const waits = [];
  e.hooks.onSleep = (ms) => waits.push(ms);
  const out = await e.tick({ once: true });
  assert.equal(out.reason, 'overlap');
  assert.deepEqual(waits, [], 'nothing to wait for');
  assert.equal(tick.readRecord(e.files.tickLock).rec.nonce, 'the-holder');
});

test('a tick lock whose holder is dead is taken over at once, without a grace period', async (t) => {
  const e = mkEnv(t, { gate: ['NO_WORK'] });
  lockHeldBy(e, { pid: H.deadPid(), token: null });
  const waits = [];
  e.hooks.onSleep = (ms) => waits.push(ms);
  const out = await e.tick({ once: true });
  assert.equal(out.reason, 'gate-no_work');
  assert.deepEqual(waits, []);
});

test('a fresh lock of a live tick is never questioned', async (t) => {
  const e = mkEnv(t);
  lockHeldBy(e);
  setMtime(e.files.tickLock, Date.now() - 30 * SEC);
  const waits = [];
  e.hooks.onSleep = (ms) => waits.push(ms);
  const out = await e.tick({ once: true });
  assert.equal(out.reason, 'overlap');
  assert.deepEqual(waits, []);
});
