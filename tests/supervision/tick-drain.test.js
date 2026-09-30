'use strict';
// A run started by a cron run does not survive the end of that run, so a tick must never end while a run it launched is in
// flight: it stops launching at a cutoff, waits out its own run, and ends a run still going at a hard cap. Injected clock,
// fake runner spawner; the hard-cap tests use real sleeper processes so the kill order and the aftermath are the real ones.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const H = require('./_helpers');

H.installNetworkGuard();
process.env.RESOURCER_HOME = H.mkHome(null, 'drainbase');
const wd = require(path.join(H.SRC_SCRIPTS, 'pipeline-watchdog.js'));
const tick = require(path.join(H.SRC_SCRIPTS, 'lib', 'tick.js'));
const { C } = wd;

const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();

function mkEnv(t, o = {}) {
  const home = H.mkHome(t, 'drain');
  const files = tick.runtimeFiles(home);
  const notify = H.collectNotifier();
  const time = { wall: o.start || H.londonEpoch(2026, 9, 29, 10, 0), mono: 0 };
  const logs = [];
  const spawns = [];
  const gateTimes = [];
  const killed = [];
  const scheduled = [];
  const pendingFile = path.join(home, 'pending-searches', 'territory-1-x.json');
  H.writeJson(pendingFile, { jobTitle: 'Chef', location: 'AB1', distance: 20, sources: 'caterer' });
  const gate = o.gate || (() => 'READY');

  const finishRun = (child, nonce, code, extra) => {
    const cur = tick.readRecord(files.run);
    H.writeJson(files.lastRun, Object.assign({ nonce, exitCode: code, startedAt: cur && cur.rec ? cur.rec.startedAt : iso(time.wall), endedAt: iso(time.wall), file: 'territory-1-x.json', elapsedSec: 100 }, extra));
    try { fs.unlinkSync(files.run); } catch { /* none */ }
    child.emit('exit', code, null);
  };

  const ctx = wd.makeCtx(Object.assign({
    home,
    now: () => time.wall,
    mono: () => time.mono,
    sleep: async (ms) => {
      time.wall += ms;
      time.mono += ms;
      for (const s of scheduled.filter((x) => !x.done && x.at <= time.wall)) { s.done = true; await s.fn(); }
    },
    log: (m, lvl) => logs.push(`${lvl || 'info'}: ${m}`),
    notify,
    dbFit: () => ({ ok: true }),
    slowChecks: async () => {},
    diskGuard: () => ({}),
    exec: async (script) => {
      if (script === 'pending-gate.js') {
        gateTimes.push(time.wall);
        const g = gate(gateTimes.length);
        if (g !== 'READY') return { code: 0, stdout: g, stderr: '' };
        return { code: 0, stdout: JSON.stringify({ status: 'READY', file: 'territory-1-x.json', filePath: pendingFile, pending: { jobTitle: 'Chef', location: 'AB1' }, queueDepth: 2 }), stderr: '' };
      }
      if (script === 'cull-ghost-phase1.js') return { code: 0, stdout: 'CULL_OK culled=0 kept=0', stderr: '' };
      if (script === 'queue-due-territories.js') return { code: 0, stdout: JSON.stringify({ status: 'nothing_to_queue', due: 0, queued: 0 }), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    halt: { getHalt: () => null, setHalt: () => {}, clearHalt: () => {} },
    screening: () => ({ check: async () => ({ ok: true }) }),
    memAvailMb: () => 4000,
    killTree: async (pid) => {
      killed.push(pid);
      const r = spawns.find((s) => s.real && (s.real.phase1.pid === pid || s.real.runner.pid === pid));
      if (!r) return true;
      const target = r.real.phase1.pid === pid ? r.real.phase1 : r.real.runner;
      target.kill();
      await H.waitFor(() => !H.pidExists(pid), 5000);
      // A healthy runner notices its child is gone, reports a plain phase1 failure and exits by itself.
      if (target === r.real.phase1 && !o.wedgedRunner) {
        finishRun(r.child, r.nonce, 12, { reason: 'phase1-exit-null' });
        r.real.runner.kill();
        await H.waitFor(() => !H.pidExists(r.real.runner.pid), 5000);
      }
      return true;
    },
    spawnRunner: () => {
      const child = new EventEmitter();
      const nonce = `run${spawns.length + 1}`;
      const rec = { nonce, at: time.wall, child };
      spawns.push(rec);
      const claim = H.readJson(pendingFile);
      claim.spawnedAt = iso(time.wall);
      H.writeJson(pendingFile, claim);
      const runRec = { nonce, role: 'runner', startedAt: iso(time.wall), phase1StartedAt: iso(time.wall), file: 'territory-1-x.json' };
      if (o.realRunner) {
        rec.real = { runner: H.sleeper(t), phase1: H.sleeper(t) };
        child.pid = rec.real.runner.pid;
        Object.assign(runRec, { pid: child.pid, token: tick.procToken(child.pid), childPid: rec.real.phase1.pid, childToken: tick.procToken(rec.real.phase1.pid) });
      } else {
        child.pid = process.pid;
        Object.assign(runRec, { pid: process.pid, token: tick.procToken(process.pid) });
      }
      H.writeJson(files.run, runRec);
      const policy = o.finish && (o.finish[spawns.length - 1] || o.finish.default);
      if (policy) scheduled.push({ at: time.wall + policy.afterMs, fn: () => finishRun(child, nonce, policy.code, policy.extra) });
      return child;
    },
  }, o.ctx || {}));

  return {
    home, files, ctx, notify, logs, gateTimes, spawns, killed, pendingFile, time, scheduled,
    state: () => H.readJson(files.state, {}),
    tick: (opts) => wd.runTick(ctx, Object.assign({ maxMinutes: 55 }, opts)),
  };
}

// --- the limits -----------------------------------------------------------------------------------

test('limits: launch cutoff 38 min clamped to [10, bound - 10]; hard cap 56 min clamped to [bound, 56]; a tick under 20 minutes has neither', () => {
  const L = wd.tickLimits;
  const m = (r) => [r.cutoffMs / MIN, r.hardCapMs / MIN];
  assert.equal(C.LAUNCH_CUTOFF_DEFAULT_MIN, 38);
  assert.equal(C.TICK_HARD_CAP_DEFAULT_MIN, 56);
  assert.deepEqual(m(L(55, {})), [38, 56]);
  assert.deepEqual(m(L(55, { launchCutoffMin: 5 })), [10, 56], 'never earlier than 10 minutes');
  assert.deepEqual(m(L(55, { launchCutoffMin: 50 })), [45, 56], 'never later than bound - 10');
  assert.deepEqual(m(L(55, { launchCutoffMin: 20 })), [20, 56]);
  assert.deepEqual(m(L(30, {})), [20, 56], 'a shorter bound pulls the cutoff in');
  assert.deepEqual(m(L(20, {})), [10, 56]);
  assert.deepEqual(m(L(55, { hardCapMin: 60 })), [38, 56], 'the hard cap cannot pass the wrapper outer timeout');
  assert.deepEqual(m(L(55, { hardCapMin: 40 })), [38, 55], 'nor fall below the bound');
  assert.deepEqual(m(L(55, { hardCapMin: 55 })), [38, 55]);
  for (const junk of ['abc', '', 0, -5, null, undefined, NaN]) {
    assert.deepEqual(m(L(55, { launchCutoffMin: junk, hardCapMin: junk })), [38, 56], `junk ${String(junk)} means the defaults`);
  }
  assert.deepEqual(m(L(55, { launchCutoffMin: '12', hardCapMin: '50' })), [12, 55], 'numeric strings from the environment are read');
  const short = L(19, {});
  assert.equal(short.cutoffMs, undefined);
  assert.equal(short.hardCapMs, 19 * MIN, 'no drain: the bound is final');
  assert.equal(L(1, {}).cutoffMs, undefined);
});

test('the nested time bounds hold: cutoff < tick bound <= hard cap, and the hard cap plus the kill stays under the wrapper timeout, which stays under the cron timeout', () => {
  const sh = fs.readFileSync(path.join(H.REPO, 'hermes', 'scripts', 'resourcer-tick.sh'), 'utf8');
  const m = /-k (\d+) (\d+) "\$NODE"/.exec(sh);
  assert.ok(m, 'the wrapper runs node under timeout -k <grace> <seconds>');
  const [grace, outer] = [Number(m[1]), Number(m[2])];
  const killAllowance = (5 + 3) * 2 + C.HARD_CAP_RUNNER_EXIT_MS / 1000 + 20;
  assert.ok(C.TICK_HARD_CAP_MAX_MIN * 60 + killAllowance < outer, `${C.TICK_HARD_CAP_MAX_MIN * 60} s + ${killAllowance} s of kill work must stay under ${outer} s`);
  assert.ok(C.LAUNCH_CUTOFF_DEFAULT_MIN + C.LAUNCH_CUTOFF_MARGIN_MIN <= C.MAX_TICK_MIN_CAP);
  assert.ok(C.MAX_TICK_MIN_CAP <= C.TICK_HARD_CAP_DEFAULT_MIN && C.TICK_HARD_CAP_DEFAULT_MIN <= C.TICK_HARD_CAP_MAX_MIN);
  assert.ok(outer + grace <= 3500, 'the cron script timeout is at least 3500 s (docs/KNOWN-LIMITS.md K-PLAT4)');
});

// --- launch cutoff --------------------------------------------------------------------------------

test('no run is launched after the cutoff, the tick asks the gate no more, and it exits as soon as the last run has ended', async (t) => {
  const e = mkEnv(t, { finish: { default: { afterMs: 5 * MIN, code: 0, extra: { pool: 10, approved: 3, skippedDb: 5, errors: 0 } } } });
  const start = e.time.wall;
  const out = await e.tick();
  const cutoff = start + 38 * MIN;
  assert.equal(out.reason, 'launch-cutoff');
  assert.ok(e.spawns.length >= 5, `back-to-back runs until the cutoff (${e.spawns.length})`);
  assert.ok(e.spawns.every((s) => s.at < cutoff), 'every launch happened before the cutoff');
  assert.ok(e.gateTimes.every((g) => g < cutoff), 'the gate is not consulted after the cutoff');
  const lastEnd = e.spawns[e.spawns.length - 1].at + 5 * MIN;
  assert.ok(lastEnd > cutoff, 'the last run outlived the cutoff (that is the case the drain is for)');
  assert.ok(e.time.wall >= lastEnd && e.time.wall - lastEnd <= 15000, `the tick left right after the last run ended (${e.time.wall - lastEnd} ms later)`);
  assert.ok(e.time.wall < start + 55 * MIN);
  assert.deepEqual(e.killed, []);
  assert.equal(e.state().recentRuns.length, e.spawns.length, 'every run was accounted for by this tick');
  assert.equal(e.state().recentRuns.at(-1).exitCode, 0);
  assert.equal(fs.existsSync(e.files.run), false);
  assert.equal(fs.existsSync(e.files.tickLock), false, 'lock released');
});

test('the cutoff follows RESOURCER_LAUNCH_CUTOFF_MIN as passed to the tick', async (t) => {
  const e = mkEnv(t, { finish: { default: { afterMs: 3 * MIN, code: 0 } } });
  const start = e.time.wall;
  const out = await e.tick({ launchCutoffMin: 15 });
  assert.equal(out.reason, 'launch-cutoff');
  assert.ok(e.spawns.every((s) => s.at < start + 15 * MIN));
  assert.ok(e.spawns.length >= 4 && e.spawns.length <= 6, `launches ${e.spawns.length}`);
  assert.ok(e.time.wall < start + 20 * MIN);
});

// --- drain ----------------------------------------------------------------------------------------

test('a run launched before the cutoff that ends after the 55-minute mark is waited out; the tick exits right after it', async (t) => {
  const e = mkEnv(t, { finish: { 0: { afterMs: 36 * MIN, code: 0 }, 1: { afterMs: 19 * MIN + 30000, code: 0, extra: { pool: 9, approved: 2, skippedDb: 6, errors: 0 } } } });
  const start = e.time.wall;
  const out = await e.tick();
  assert.equal(e.spawns.length, 2);
  assert.ok(e.spawns[1].at - start < 38 * MIN, 'the second run started before the cutoff');
  const endsAt = e.spawns[1].at + 19 * MIN + 30000;
  assert.ok(endsAt > start + 55 * MIN, 'the second run ends after the 55-minute mark');
  assert.equal(out.reason, 'launch-cutoff');
  assert.ok(e.time.wall >= endsAt && e.time.wall - endsAt <= 15000, `the tick left right after the run (${e.time.wall - endsAt} ms)`);
  assert.ok(e.time.wall < start + 56 * MIN, 'inside the hard cap');
  assert.deepEqual(e.killed, [], 'nothing was killed');
  assert.equal(e.state().recentRuns.length, 2);
  assert.equal(e.state().recentRuns[1].exitCode, 0);
  assert.equal(e.notify.list.length, 0, 'a run that finishes in time raises no alert');
  assert.equal(e.gateTimes.length, 2, 'no gate call after the cutoff');
});

// --- hard cap -------------------------------------------------------------------------------------

test('hard cap: a run still in flight at 56 minutes is ended child first, recorded as tick-hard-cap, keeps its claim, and raises one warning', async (t) => {
  const e = mkEnv(t, { realRunner: true, gate: (n) => (n === 1 ? 'READY' : 'NO_WORK') });
  const start = e.time.wall;
  const out = await e.tick();
  assert.equal(out.reason, 'tick-hard-cap');
  assert.ok(e.time.wall >= start + 56 * MIN && e.time.wall < start + 56 * MIN + 30000, `ended at the hard cap (${(e.time.wall - start) / MIN} min)`);
  const real = e.spawns[0].real;
  assert.equal(e.killed[0], real.phase1.pid, 'the phase1 child first');
  assert.ok(!H.pidExists(real.phase1.pid) && !H.pidExists(real.runner.pid), 'both processes are gone');
  const st = e.state();
  const last = st.recentRuns.at(-1);
  assert.equal(last.exitCode, 13);
  assert.equal(last.reason, 'tick-hard-cap', 'the runner reported a plain phase1 failure; the tick knows why it ended it');
  assert.deepEqual(st.killedNonces, {}, 'accounted for now, not one tick later');
  assert.equal(st.handledRunNonce, 'run1');
  assert.equal(fs.existsSync(e.files.run), false);
  const keys = e.notify.keys();
  assert.deepEqual(keys, ['tick-hard-cap'], `only the hard-cap warning (${keys})`);
  assert.equal(e.notify.list[0].severity, 'warn');
  assert.match(e.notify.list[0].text, /56-minute limit/);
  assert.ok(H.readJson(e.pendingFile).spawnedAt, 'the claim stays stamped, as for a run killed at the 70-minute ceiling');
  assert.equal(H.readJson(e.pendingFile).failedRuns, undefined, 'it is not counted against the territory');
  assert.ok(e.logs.some((l) => /^error: CRITICAL run run1 is still in flight at the 56-minute tick limit/.test(l)));
  assert.equal(fs.existsSync(e.files.tickLock), false, 'lock released');
});

test('hard cap with a wedged runner: the runner is signalled after a grace period, the run is still accounted for as tick-hard-cap and no crash alert is raised', async (t) => {
  const e = mkEnv(t, { realRunner: true, wedgedRunner: true });
  const start = e.time.wall;
  const out = await e.tick();
  assert.equal(out.reason, 'tick-hard-cap');
  const real = e.spawns[0].real;
  assert.deepEqual(e.killed, [real.phase1.pid, real.runner.pid], 'child, then runner');
  assert.ok(e.time.wall - start >= 56 * MIN + C.HARD_CAP_RUNNER_EXIT_MS, 'the runner had time to exit by itself first');
  assert.ok(e.time.wall - start < 56 * MIN + C.HARD_CAP_RUNNER_EXIT_MS + 30000);
  const last = e.state().recentRuns.at(-1);
  assert.equal(last.exitCode, 13);
  assert.equal(last.reason, 'tick-hard-cap');
  assert.deepEqual(e.notify.keys(), ['tick-hard-cap'], 'no runner-crashed or run-killed alert');
  assert.ok(H.readJson(e.pendingFile).spawnedAt, 'the claim stays stamped (a plain crash would give it back)');
  assert.equal(fs.existsSync(e.files.run), false);
});

test('hard-cap kills are not territory failures (never quarantined) and their warning is rate-limited', async (t) => {
  const e = mkEnv(t, { realRunner: true });
  for (let i = 0; i < 4; i += 1) {
    const out = await e.tick();
    assert.equal(out.reason, 'tick-hard-cap', `tick ${i + 1}`);
    e.time.wall += 2 * MIN;
    e.time.mono += 2 * MIN;
  }
  assert.ok(fs.existsSync(e.pendingFile), 'four hard-cap kills in a row leave the territory in the queue');
  assert.equal(H.readJson(e.pendingFile).failedRuns, undefined);
  assert.equal(e.notify.list.filter((n) => n.key === 'tick-hard-cap').length, 1, 'one warning inside the six-hour gap');
  assert.ok(e.notify.list.every((n) => n.key !== 'territory-quarantined:territory-1-x.json'));
  assert.equal(e.state().recentRuns.filter((r) => r.reason === 'tick-hard-cap').length, 4);
  const nextDay = H.londonEpoch(2026, 9, 30, 10, 0) - e.time.wall;
  e.time.wall += nextDay;
  e.time.mono += nextDay;
  await e.tick();
  assert.equal(e.notify.list.filter((n) => n.key === 'tick-hard-cap').length, 2, 'and again once the gap has passed');
});

test('a tick shorter than 20 minutes never drains or kills its run: it ends at its bound as before', async (t) => {
  const e = mkEnv(t, { gate: (n) => (n === 1 ? 'READY' : 'NO_WORK') });
  const start = e.time.wall;
  const out = await e.tick({ maxMinutes: 3, superviseMs: 1000 });
  assert.equal(out.reason, 'bound');
  assert.ok(e.time.wall - start >= 3 * MIN && e.time.wall - start < 3 * MIN + 30000);
  assert.deepEqual(e.killed, []);
  assert.equal(tick.inspectRun(e.files.run).alive, true, 'the run is left for the next tick to adopt');
});

// --- adoption and the frozen-instance logic are untouched -----------------------------------------

test('a run adopted from a previous tick is supervised as before: never killed at the hard cap, the tick leaves at its 55-minute bound', async (t) => {
  const e = mkEnv(t, { gate: () => 'READY' });
  H.writeJson(e.files.run, { pid: process.pid, token: tick.procToken(process.pid), nonce: 'inherited1', startedAt: iso(e.time.wall - 5 * MIN), file: 'territory-1-x.json' });
  const start = e.time.wall;
  const out = await e.tick();
  assert.equal(out.reason, 'bound');
  assert.ok(e.time.wall - start >= 55 * MIN && e.time.wall - start <= 55 * MIN + 30000, `elapsed ${(e.time.wall - start) / MIN} min`);
  assert.deepEqual(e.killed, []);
  assert.equal(e.spawns.length, 0);
  assert.equal(e.gateTimes.length, 0);
  assert.equal(e.notify.list.length, 0);
  assert.equal(tick.inspectRun(e.files.run).alive, true);
});

test('an adopted run that ends after the cutoff is accounted for and the tick leaves at once, launching nothing', async (t) => {
  const e = mkEnv(t, { gate: () => 'READY' });
  const start = e.time.wall;
  H.writeJson(e.files.run, { pid: process.pid, token: tick.procToken(process.pid), nonce: 'inherited2', startedAt: iso(start - 5 * MIN), file: 'territory-1-x.json' });
  e.scheduled.push({ at: start + 40 * MIN, fn: () => {
    H.writeJson(e.files.lastRun, { nonce: 'inherited2', exitCode: 0, startedAt: iso(start - 5 * MIN), endedAt: iso(e.time.wall), file: 'territory-1-x.json', pool: 4, approved: 1, skippedDb: 3, errors: 0 });
    fs.unlinkSync(e.files.run);
  } });
  const out = await e.tick();
  assert.equal(out.reason, 'launch-cutoff');
  assert.equal(e.spawns.length, 0);
  assert.equal(e.gateTimes.length, 0);
  assert.ok(e.time.wall - (start + 40 * MIN) <= 15000);
  assert.equal(e.state().handledRunNonce, 'inherited2');
});

test('a recovered process (adopted-procs.json) alive past the cutoff keeps the tick supervising until it ends', async (t) => {
  const e = mkEnv(t, { gate: () => 'READY' });
  const start = e.time.wall;
  const proc = H.sleeper(t);
  tick.addAdopted(e.files, [{ pid: proc.pid, id: 'phase1-recovered', mode: 'phase2' }]);
  e.scheduled.push({ at: start + 45 * MIN, fn: async () => { proc.kill(); await H.waitFor(() => !H.pidExists(proc.pid), 5000); } });
  const out = await e.tick();
  assert.equal(out.reason, 'launch-cutoff');
  assert.ok(e.time.wall >= start + 45 * MIN && e.time.wall <= start + 45 * MIN + 30000, `the tick stayed until the process ended (${(e.time.wall - start) / MIN} min)`);
  assert.equal(e.spawns.length, 0);
  assert.deepEqual(e.killed, [], 'a recovered process is never killed by the tick bound');
});

test('a frozen instance: a wall-clock jump past the bound while the tick own run is in flight is not taken for elapsed tick time, so the run is not killed', async (t) => {
  const e = mkEnv(t, { realRunner: true, gate: (n) => (n === 1 ? 'READY' : 'NO_WORK') });
  e.scheduled.push({ at: e.time.wall + 20 * MIN, fn: () => { e.time.wall += 90 * MIN; } });
  e.scheduled.push({ at: e.time.wall + 130 * MIN, fn: async () => {
    const r = e.spawns[0];
    H.writeJson(e.files.lastRun, { nonce: r.nonce, exitCode: 0, startedAt: iso(e.time.wall), endedAt: iso(e.time.wall), file: 'territory-1-x.json' });
    r.real.phase1.kill();
    r.real.runner.kill();
    await H.waitFor(() => !H.pidExists(r.real.phase1.pid) && !H.pidExists(r.real.runner.pid), 5000);
    try { fs.unlinkSync(e.files.run); } catch { /* none */ }
  } });
  const out = await e.tick();
  assert.notEqual(out.reason, 'tick-hard-cap');
  assert.deepEqual(e.killed, [], 'nothing was killed for being old');
  assert.ok(tick.readSuspensions(e.files.suspensions).some((s) => s.to - s.from >= 85 * MIN), 'the frozen span is in the ledger');
  assert.equal(e.state().recentRuns.at(-1).exitCode, 0);
  assert.equal(e.notify.keys().includes('tick-hard-cap'), false);
});

// --- the setting reaches the tick through the environment ----------------------------------------

test('the tick reads RESOURCER_LAUNCH_CUTOFF_MIN and RESOURCER_TICK_HARD_CAP_MIN (through lib/env.js) and says so in its log', (t) => {
  const home = H.mkHome(t, 'envtick');
  H.installScripts(home);
  const run = (args, env) => spawnSync(process.execPath, [path.join(home, 'scripts', 'pipeline-watchdog.js'), '--tick'].concat(args), {
    cwd: home, encoding: 'utf8', timeout: 90000,
    env: Object.assign({}, process.env, { RESOURCER_HOME: home, RESOURCER_SETTLE_MS: '0', RESOURCER_MAX_TICK_MIN: '' }, env),
  });
  let r = run(['--max-minutes', '30'], { RESOURCER_LAUNCH_CUTOFF_MIN: '', RESOURCER_TICK_HARD_CAP_MIN: '' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /tick start: bound 30 min, launch cutoff 20 min, hard cap 56 min/);
  r = run(['--max-minutes', '55'], { RESOURCER_LAUNCH_CUTOFF_MIN: '15', RESOURCER_TICK_HARD_CAP_MIN: '58' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /tick start: bound 55 min, launch cutoff 15 min, hard cap 56 min/, 'the hard cap is clamped to 56');
  r = run(['--max-minutes', '55'], { RESOURCER_LAUNCH_CUTOFF_MIN: '99', RESOURCER_TICK_HARD_CAP_MIN: '55' });
  assert.match(r.stdout, /tick start: bound 55 min, launch cutoff 45 min, hard cap 55 min/);
  r = run(['--max-minutes', '2'], {});
  assert.match(r.stdout, /tick start: bound 2 min, no launch cutoff or drain/);
});
