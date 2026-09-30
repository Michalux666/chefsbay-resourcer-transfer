'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const H = require('./_helpers');

H.installNetworkGuard();
process.env.RESOURCER_HOME = H.mkHome(null, 'wdbase');
const wd = require(path.join(H.SRC_SCRIPTS, 'pipeline-watchdog.js'));
const tick = require(path.join(H.SRC_SCRIPTS, 'lib', 'tick.js'));
const { C } = wd;

const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();

// A fully injected environment: fake clock, fake gate/halt/screening/notify, fake runner spawner.
function mkEnv(t, o = {}) {
  const home = H.mkHome(t, 'wd');
  const files = tick.runtimeFiles(home);
  const notify = H.collectNotifier();
  let clock = o.start || H.londonEpoch(2026, 9, 29, 10, 0);
  const logs = [];
  const gateQueue = (o.gate || []).slice();
  const gateTimes = [];
  const execCalls = [];
  const spawns = [];
  const scheduled = [];
  const halts = { state: o.halted || null, sets: [], clears: 0 };
  const screening = { cheap: { ok: true }, deep: { ok: true }, calls: [] };
  const env = { mem: 4000 };
  const killed = [];

  const finishRun = (child, nonce, code, extra) => {
    let startedAt = iso(clock);
    const cur = tick.readRecord(files.run);
    if (cur && cur.rec) startedAt = cur.rec.startedAt;
    if (code !== 10) {
      H.writeJson(files.lastRun, Object.assign({ nonce, exitCode: code, startedAt, endedAt: iso(clock), file: 'territory-1-x.json', elapsedSec: 100 }, extra));
    }
    try { fs.unlinkSync(files.run); } catch { /* none */ }
    child.emit('exit', code, null);
  };

  const ctx = wd.makeCtx(Object.assign({
    home,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      for (const s of scheduled.filter((x) => !x.done && x.at <= clock)) { s.done = true; s.fn(); }
    },
    log: (m, lvl) => logs.push(`${lvl || 'info'}: ${m}`),
    notify,
    dbFit: () => ({ ok: true }),
    slowChecks: async () => {},
    diskGuard: () => ({}),
    exec: async (script, args) => {
      execCalls.push({ script, args, at: clock });
      if (script === 'pending-gate.js') {
        gateTimes.push(clock);
        const g = gateQueue.length ? gateQueue.shift() : 'NO_WORK';
        if (g === 'READY') {
          return { code: 0, stdout: JSON.stringify({ status: 'READY', file: 'territory-1-x.json', filePath: path.join(home, 'pending-searches', 'territory-1-x.json'), pending: { jobTitle: 'Chef', location: 'AB1' }, queueDepth: 2 }), stderr: '' };
        }
        if (g === 'ERROR') return { code: 1, stdout: 'ERROR:all_files_corrupt (1 parse failures)', stderr: '' };
        return { code: 0, stdout: g, stderr: '' };
      }
      if (script === 'cull-ghost-phase1.js') return { code: 0, stdout: o.cull || 'CULL_OK culled=0 kept=0', stderr: '' };
      if (script === 'queue-due-territories.js') {
        if (o.queueDueFail) return { code: 1, stdout: '', stderr: 'boom', error: 'boom' };
        return { code: 0, stdout: JSON.stringify({ status: 'nothing_to_queue', due: 0, queued: 0 }), stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    halt: {
      getHalt: () => halts.state,
      setHalt: (r, d, opts) => { halts.sets.push({ r, d, opts }); halts.state = { halted: true, reason: r, since: iso(clock) }; },
      clearHalt: () => { halts.clears++; halts.state = null; },
    },
    screening: () => ({ check: async ({ deep }) => { screening.calls.push({ deep: !!deep, at: clock }); return deep ? screening.deep : screening.cheap; } }),
    memAvailMb: () => env.mem,
    killTree: async (pid, opts) => { killed.push({ pid, opts }); return true; },
    spawnRunner: () => {
      const child = new EventEmitter();
      child.pid = process.pid;
      const nonce = `run${spawns.length + 1}`;
      spawns.push({ nonce, at: clock });
      if (!o.noRegister) {
        H.writeJson(files.run, { pid: process.pid, token: tick.procToken(process.pid), nonce, role: 'runner', startedAt: iso(clock), file: 'territory-1-x.json' });
      }
      const policy = (o.finish && (o.finish[spawns.length - 1] || o.finish.default)) || o.finish;
      if (policy && policy.afterMs !== undefined) {
        scheduled.push({ at: clock + policy.afterMs, fn: () => finishRun(child, nonce, policy.code, policy.extra) });
      }
      child.finish = (code, extra) => finishRun(child, nonce, code, extra);
      return child;
    },
  }, o.ctx || {}));

  return {
    home, files, ctx, notify, logs, gateTimes, execCalls, spawns, halts, screening, env, killed, scheduled,
    clock: () => clock, setClock: (v) => { clock = v; },
    state: () => tick_state(files),
    tick: (opts) => wd.runTick(ctx, Object.assign({ maxMinutes: 30 }, opts)),
  };
}

function tick_state(files) {
  return H.readJson(files.state, {});
}

// ---------------------------------------------------------------------------------------------

test('constants: 70-minute ceiling, 15-minute session back-off, 55-minute tick bound', () => {
  assert.equal(C.MAX_RUN_MS, 70 * MIN);
  assert.equal(C.STALE_COOLDOWN_MS, 15 * MIN);
  assert.equal(C.MAX_TICK_MIN_CAP, 55);
  assert.equal(C.MAINT_INTERVAL_MS, 5 * MIN);
});

test('outside the operating window the tick exits at once and never asks the gate', async (t) => {
  const e = mkEnv(t, { start: H.londonEpoch(2026, 9, 29, 5, 59), gate: ['READY'] });
  const out = await e.tick();
  assert.equal(out.reason, 'outside-window');
  assert.equal(e.gateTimes.length, 0);
  assert.equal(e.spawns.length, 0);
  assert.equal(fs.existsSync(e.files.tickLock), false, 'lock released');
});

test('in the window with no work: one gate call, no launch, exit', async (t) => {
  const e = mkEnv(t, { gate: ['NO_WORK'] });
  const out = await e.tick();
  assert.equal(out.reason, 'gate-no_work');
  assert.equal(e.gateTimes.length, 1);
  assert.equal(e.spawns.length, 0);
});

test('READY: launches one runner, supervises it, then re-checks the gate immediately after exit 0', async (t) => {
  const e = mkEnv(t, { gate: ['READY', 'NO_WORK'], finish: { afterMs: 2 * MIN, code: 0, extra: { pool: 10, approved: 3, skippedDb: 5, errors: 0 } } });
  const out = await e.tick();
  assert.equal(e.spawns.length, 1);
  assert.equal(e.gateTimes.length, 2);
  const finishedAt = e.spawns[0].at + 2 * MIN;
  assert.ok(e.gateTimes[1] - finishedAt < 15000, `handover must not wait for the next poll (gap ${e.gateTimes[1] - finishedAt} ms)`);
  assert.equal(out.reason, 'gate-no_work');
  const st = e.state();
  assert.equal(st.handledRunNonce, 'run1');
  assert.equal(st.recentRuns.length, 1);
  assert.equal(st.recentRuns[0].exitCode, 0);
  assert.equal(e.notify.list.length, 0, 'a normal run raises no alert');
  assert.equal(fs.existsSync(e.files.run), false);
});

test('a second tick while one is running exits immediately (PID lock)', async (t) => {
  const e = mkEnv(t, { gate: ['READY'] });
  const held = tick.acquireLock(e.files.tickLock, { info: { role: 'tick' } });
  assert.equal(held.ok, true);
  const out = await e.tick();
  assert.equal(out.reason, 'overlap');
  assert.equal(e.gateTimes.length, 0);
  assert.equal(held.stillOwner(), true, 'the running tick keeps its lock');
  held.release();
});

test('adopts an in-flight run from a previous tick: no gate call, no second launch, stops at the bound', async (t) => {
  const e = mkEnv(t, { gate: ['READY'] });
  H.writeJson(e.files.run, { pid: process.pid, token: tick.procToken(process.pid), nonce: 'adopted1', startedAt: iso(e.clock() - 5 * MIN), file: 'territory-1-x.json' });
  const out = await e.tick({ maxMinutes: 2 });
  assert.equal(out.reason, 'bound');
  assert.equal(e.gateTimes.length, 0);
  assert.equal(e.spawns.length, 0);
  assert.equal(e.killed.length, 0, 'the bound never kills the run: the next tick adopts it');
  assert.equal(tick.inspectRun(e.files.run).alive, true);
});

test('tick length is capped at 55 minutes whatever is asked', async (t) => {
  const e = mkEnv(t);
  H.writeJson(e.files.run, { pid: process.pid, token: tick.procToken(process.pid), nonce: 'adopted2', startedAt: iso(e.clock()), file: 'x' });
  const start = e.clock();
  const out = await e.tick({ maxMinutes: 500 });
  assert.equal(out.reason, 'bound');
  const elapsed = e.clock() - start;
  assert.ok(elapsed >= 55 * MIN && elapsed <= 55 * MIN + 30000, `elapsed ${elapsed}`);
});

test('exit 11 (session went stale mid-run): critical alert, 15-minute back-off that survives tick restarts', async (t) => {
  const e = mkEnv(t, { gate: ['READY', 'READY', 'READY'], finish: { afterMs: 30000, code: 11, extra: { reason: 'phase1-session-stale' } } });
  const out = await e.tick();
  assert.equal(out.reason, 'cooldown');
  assert.equal(e.spawns.length, 1);
  assert.equal(e.gateTimes.length, 1, 'no gate call during the back-off');
  const n = e.notify.list.find((x) => x.key === 'caterer-session');
  assert.ok(n, 'session alert raised');
  assert.equal(n.severity, 'critical');
  assert.match(n.text, /went stale/i);
  const endedAt = e.spawns[0].at + 30000;
  assert.equal(e.state().staleCooldownUntil, endedAt + 15 * MIN);

  e.setClock(endedAt + 14 * MIN);
  const again = await e.tick();
  assert.equal(again.reason, 'cooldown', 'a fresh tick inside the back-off still holds');
  assert.equal(e.gateTimes.length, 1);
  assert.equal(e.spawns.length, 1);

  e.setClock(endedAt + 15 * MIN + 1000);
  const after = await e.tick();
  assert.equal(e.gateTimes.length, 2, 'gate consulted again once the back-off has passed');
  assert.equal(e.spawns.length, 2);
  assert.ok(after.iterations >= 1);
});

test('exit 11 alert text differs for a hung sign-in and a mid-run stale session', async (t) => {
  for (const [reason, re] of [['session-timeout', /did not finish/i], ['phase1-session-stale', /went stale/i]]) {
    const e = mkEnv(t, { gate: ['READY'], finish: { afterMs: 10000, code: 11, extra: { reason } } });
    await e.tick();
    const n = e.notify.list.find((x) => x.key === 'caterer-session');
    assert.ok(n && re.test(n.text), `${reason}: ${n && n.text}`);
  }
});

test('exit 12: no alert for one failure, 60 s launch back-off, alert on the third in a row', async (t) => {
  const e = mkEnv(t, { gate: ['READY', 'READY', 'READY', 'READY'], finish: { default: { afterMs: 20000, code: 12, extra: { reason: 'phase1-exit-4' } } } });
  let out = await e.tick();
  assert.equal(out.reason, 'launch-backoff');
  assert.equal(e.notify.list.length, 0);
  assert.equal(e.spawns.length, 1);
  const ended1 = e.spawns[0].at + 20000;
  assert.equal(e.state().launchNotBefore, ended1 + 60000);

  e.setClock(ended1 + 30000);
  out = await e.tick();
  assert.equal(e.spawns.length, 1, 'still backing off 30 s after the failure');
  assert.equal(out.reason, 'launch-backoff');

  e.setClock(ended1 + 61000);
  await e.tick();
  assert.equal(e.spawns.length, 2);
  e.setClock(e.clock() + 3 * MIN);
  await e.tick();
  assert.equal(e.spawns.length, 3);
  e.setClock(e.clock() + 3 * MIN);
  await e.tick();
  assert.ok(e.notify.keys().includes('run-failures'), 'three failures in a row raise one warning');
  assert.equal(e.notify.list.filter((x) => x.key === 'run-failures').length, 1);
});

test('a runner that exits 10 without a result does not cause a tight relaunch loop', async (t) => {
  const e = mkEnv(t, { gate: ['READY', 'READY', 'READY'], finish: { afterMs: 500, code: 10 } });
  const out = await e.tick();
  assert.equal(e.spawns.length, 1, 'READY-but-busy must not spin');
  assert.equal(out.reason, 'launch-backoff');
});

test('exit 13 (killed at 70 min) raises a warning and backs off', async (t) => {
  const e = mkEnv(t, { gate: ['READY'], finish: { afterMs: 60000, code: 13, extra: { reason: 'timeout' } } });
  await e.tick();
  const n = e.notify.list.find((x) => x.key === 'run-killed');
  assert.ok(n);
  assert.equal(n.severity, 'warn');
  assert.match(n.text, /70 minutes/);
});

test('exit 0 clears failure streaks and a leftover back-off', async (t) => {
  const e = mkEnv(t, { gate: ['READY', 'NO_WORK'], finish: { afterMs: 10000, code: 0 } });
  fs.writeFileSync(e.files.state, JSON.stringify({ consecutiveFailures: 2, staleCooldownUntil: 1, launchNotBefore: 1 }));
  await e.tick();
  const st = e.state();
  assert.equal(st.consecutiveFailures, 0);
  assert.equal(st.staleCooldownUntil, 0);
});

test('three completed runs in a row that saw only known candidates with 1 error each raise a never-screened warning', async (t) => {
  const same = { pool: 150, approved: 0, skippedDb: 150, errors: 1 };
  const e = mkEnv(t, { gate: ['READY', 'READY', 'READY', 'NO_WORK'], finish: { default: { afterMs: 10000, code: 0, extra: same } } });
  await e.tick();
  assert.equal(e.spawns.length, 3);
  const n = e.notify.list.filter((x) => x.key === 'never-screened');
  assert.equal(n.length, 1);
  assert.equal(n[0].severity, 'warn');
});

test('a run with real approvals never trips the never-screened rule', async (t) => {
  const e = mkEnv(t, { gate: ['READY', 'READY', 'READY', 'NO_WORK'], finish: { default: { afterMs: 10000, code: 0, extra: { pool: 150, approved: 4, skippedDb: 146, errors: 1 } } } });
  await e.tick();
  assert.equal(e.notify.list.filter((x) => x.key === 'never-screened').length, 0);
});

// --- 70-minute ceiling with an injectable clock -------------------------------------------------

test('70-minute kill: not killed inside the ceiling plus grace, killed just past it, recorded as exit 13', async (t) => {
  const e = mkEnv(t, { gate: [] });
  const runner = H.sleeper(t);
  const child = H.sleeper(t);
  const started = e.clock() - 71 * MIN;
  H.writeJson(e.files.run, {
    pid: runner.pid, token: tick.procToken(runner.pid), childPid: child.pid, childToken: tick.procToken(child.pid),
    nonce: 'wedged1', startedAt: iso(started), phase1StartedAt: iso(started), file: 'territory-9-x.json',
  });
  let out = await e.tick({ maxMinutes: 1, superviseMs: 1000 });
  assert.equal(e.killed.length, 0, 'at 71 minutes the runner own 70-minute timer has priority; the tick waits out its grace');
  assert.equal(out.reason, 'bound');

  e.setClock(started + 70 * MIN + 2 * MIN + 1000);
  out = await e.tick({ maxMinutes: 1, once: true });
  assert.ok(e.killed.some((k) => k.pid === child.pid), 'phase1 child is killed first');
  assert.ok(e.killed.some((k) => k.pid === runner.pid), 'then the wedged runner');
  assert.equal(e.state().killedNonces.wedged1, 'overrun');

  // The fake killTree only records; end the processes for real, then let the tick reconcile.
  runner.kill();
  child.kill();
  await H.waitFor(() => !H.pidExists(runner.pid) && !H.pidExists(child.pid), 5000);
  H.writeJson(path.join(e.files.runs, 'phase1-2026-09-29-1000.json'), { id: 'phase1-x', status: 'phase1_running', updatedAt: iso(started) });
  out = await e.tick({ maxMinutes: 1 });
  const n = e.notify.list.find((x) => x.key === 'run-killed');
  assert.ok(n, 'exit 13 recorded');
  assert.equal(e.state().recentRuns.at(-1).exitCode, 13);
  assert.equal(fs.existsSync(e.files.run), false);
  const orphan = H.readJson(path.join(e.files.runs, 'phase1-2026-09-29-1000.json'));
  assert.equal(orphan.status, 'phase1_abandoned', 'the wedged run lock is released so the queue can resume');
});

// --- crash and orphan handling ------------------------------------------------------------------

test('crashed run (runner and phase1 dead, no result): detected, cleaned, orphans released, retried after 60 s', async (t) => {
  const e = mkEnv(t, { gate: ['READY'] });
  H.writeJson(e.files.run, { pid: H.deadPid(), nonce: 'crash1', childPid: H.deadPid(), startedAt: iso(e.clock() - 10 * MIN), file: 'territory-3-x.json' });
  H.writeJson(path.join(e.files.runs, 'phase1-2026-09-29-0950.json'), { id: 'phase1-2026-09-29-0950', status: 'phase1_running', updatedAt: iso(e.clock() - 60000), jobTitle: 'Chef', location: 'AB1' });
  const out = await e.tick();
  assert.equal(fs.existsSync(e.files.run), false, 'dead run record removed');
  assert.ok(e.notify.keys().includes('runner-crashed'));
  const f = H.readJson(path.join(e.files.runs, 'phase1-2026-09-29-0950.json'));
  assert.equal(f.status, 'phase1_abandoned', 'released even though it was updated a minute ago: no process is alive');
  assert.match(f.abandonedReason, /orphaned/);
  assert.equal(e.spawns.length, 0, 'no relaunch inside the 60 s back-off');
  assert.equal(out.reason, 'launch-backoff');
});

test('a crashed run gives back the claim it stamped on its pending search, so the territory is retried after the back-off instead of after ten minutes', async (t) => {
  const e = mkEnv(t, { gate: ['READY'] });
  const pending = path.join(e.home, 'pending-searches', 'territory-3-x.json');
  H.writeJson(pending, { jobTitle: 'Chef', location: 'AB1', spawnedAt: iso(e.clock() - 2 * MIN) });
  H.writeJson(e.files.run, { pid: H.deadPid(), nonce: 'crash2', childPid: H.deadPid(), startedAt: iso(e.clock() - 3 * MIN), file: 'territory-3-x.json' });
  await e.tick();
  assert.equal(H.readJson(pending).spawnedAt, undefined);
  assert.equal(H.readJson(pending).jobTitle, 'Chef');
});

test('a crashed run\'s browser.lock is removed once its holder is dead; a live holder keeps it', async (t) => {
  const e = mkEnv(t, { gate: ['NO_WORK'] });
  const lock = path.join(e.files.dir, 'browser.lock');
  H.writeJson(lock, { owner: 'caterer', pid: H.deadPid(), startedAt: iso(e.clock() - 5 * MIN), purpose: 'caterer-run' });
  H.writeJson(e.files.run, { pid: H.deadPid(), nonce: 'crash3', childPid: H.deadPid(), startedAt: iso(e.clock() - 4 * MIN), file: 'territory-3-x.json' });
  await e.tick();
  assert.equal(fs.existsSync(lock), false, 'the dead runner\'s lock is gone');

  const live = H.sleeper(t);
  H.writeJson(lock, { owner: 'reed', pid: live.pid, startedAt: iso(e.clock()), purpose: 'reed-phase1' });
  wd.clearStaleBrowserLock({ files: e.files, log: () => {} });
  assert.equal(fs.existsSync(lock), true, 'a live holder (a manual Reed tool) is never touched');
});

test('a run whose result was already handled is not reported as a crash when the record lingers', async (t) => {
  const e = mkEnv(t, { gate: ['NO_WORK'] });
  fs.writeFileSync(e.files.state, JSON.stringify({ handledRunNonce: 'done1' }));
  H.writeJson(e.files.run, { pid: H.deadPid(), nonce: 'done1', startedAt: iso(e.clock() - MIN) });
  await e.tick();
  assert.equal(e.notify.keys().includes('runner-crashed'), false);
  assert.equal(fs.existsSync(e.files.run), false);
});

test('an unreadable run record is treated as busy (fail safe), never as free', async (t) => {
  if (H.IS_WIN || (process.getuid && process.getuid() === 0)) return t.skip('needs permission bits and a non-root user');
  const e = mkEnv(t, { gate: ['READY'] });
  H.writeJson(e.files.run, { pid: H.deadPid(), nonce: 'x' });
  fs.chmodSync(e.files.run, 0o000);
  const out = await e.tick({ maxMinutes: 1 });
  fs.chmodSync(e.files.run, 0o600);
  assert.equal(e.spawns.length, 0);
  assert.equal(out.reason, 'bound');
});

test('gate LOCKED with no live run releases the orphan and launches', async (t) => {
  const e = mkEnv(t, { gate: ['LOCKED:phase1-x', 'READY', 'NO_WORK'], finish: { afterMs: 5000, code: 0 } });
  fs.writeFileSync(e.files.state, JSON.stringify({ lastMaintenanceAt: e.clock(), lastSlowCheckAt: e.clock() }));
  H.writeJson(path.join(e.files.runs, 'phase1-2026-09-29-0900.json'), { id: 'phase1-x', status: 'phase1_initializing', updatedAt: iso(e.clock() - 30 * MIN) });
  await e.tick();
  assert.equal(H.readJson(path.join(e.files.runs, 'phase1-2026-09-29-0900.json')).status, 'phase1_abandoned');
  assert.equal(e.spawns.length, 1);
  assert.equal(e.gateTimes.length >= 2, true);
});

test('gate LOCKED but the file is young: not released (could be a manually started run)', async (t) => {
  const e = mkEnv(t, { gate: ['LOCKED:phase1-x', 'LOCKED:phase1-x'] });
  H.writeJson(path.join(e.files.runs, 'phase1-2026-09-29-0959.json'), { id: 'phase1-x', status: 'phase1_running', updatedAt: iso(e.clock() - 20000) });
  const out = await e.tick();
  assert.equal(H.readJson(path.join(e.files.runs, 'phase1-2026-09-29-0959.json')).status, 'phase1_running');
  assert.equal(out.reason, 'gate-locked');
});

test('releaseOrphanedLocks never touches files while a run is alive, nor terminal statuses', async (t) => {
  const e = mkEnv(t);
  const f = path.join(e.files.runs, 'phase1-a.json');
  H.writeJson(f, { id: 'a', status: 'phase1_running', updatedAt: iso(e.clock() - 3 * 60 * MIN) });
  H.writeJson(path.join(e.files.runs, 'phase1-b.json'), { id: 'b', status: 'complete', updatedAt: iso(e.clock() - 3 * 60 * MIN) });
  H.writeJson(path.join(e.files.runs, 'phase1-c.json'), { id: 'c', status: 'phase1_complete', phase2Status: 'pending', updatedAt: iso(e.clock() - 3 * 60 * MIN) });
  H.writeJson(e.files.run, { pid: process.pid, token: tick.procToken(process.pid), nonce: 'live', startedAt: iso(e.clock()) });
  assert.deepEqual(wd.releaseOrphanedLocks(e.ctx, { minAgeMs: 0 }), { released: 0, skipped: 'busy' });
  assert.equal(H.readJson(f).status, 'phase1_running');
  fs.unlinkSync(e.files.run);
  assert.equal(wd.releaseOrphanedLocks(e.ctx, { minAgeMs: 0 }).released, 1);
  assert.equal(H.readJson(f).status, 'phase1_abandoned');
  assert.equal(H.readJson(path.join(e.files.runs, 'phase1-b.json')).status, 'complete');
  assert.equal(H.readJson(path.join(e.files.runs, 'phase1-c.json')).status, 'phase1_complete', 'the Reed tail status is left to recover-stranded');
});

test('releaseOrphanedLocks closes a Phase 2 progress record left in a phase2 status (a Phase 2 killed mid-push), and only when nothing is alive', async (t) => {
  const e = mkEnv(t);
  const f = path.join(e.files.runs, 'run-2026-09-29-1000.json');
  H.writeJson(f, { id: '2026-09-29-1000', status: 'phase2_pushing', startedAt: iso(e.clock() - 5 * MIN) });
  H.writeJson(path.join(e.files.runs, 'run-2026-09-29-0900.json'), { id: '2026-09-29-0900', status: 'complete', startedAt: iso(e.clock() - 60 * MIN) });
  H.writeJson(e.files.run, { pid: process.pid, token: tick.procToken(process.pid), nonce: 'live', startedAt: iso(e.clock()) });
  assert.deepEqual(wd.releaseOrphanedLocks(e.ctx, { minAgeMs: 0 }), { released: 0, skipped: 'busy' });
  assert.equal(H.readJson(f).status, 'phase2_pushing', 'a live run is never touched');
  fs.unlinkSync(e.files.run);
  assert.equal(wd.releaseOrphanedLocks(e.ctx, { minAgeMs: 10 * MIN }).released, 0, 'too young for the periodic release');
  assert.equal(wd.releaseOrphanedLocks(e.ctx, { minAgeMs: 2 * MIN }).released, 1);
  const r = H.readJson(f);
  assert.equal(r.status, 'error');
  assert.match(r.error, /orphaned \(was phase2_pushing/);
  assert.equal(H.readJson(path.join(e.files.runs, 'run-2026-09-29-0900.json')).status, 'complete');
});

test('a candidates.db that is not fit to run on holds the queue: no launch, one critical alert per half hour; a fit one launches again', async (t) => {
  let fit = { ok: false, reason: 'missing', detail: 'no such file (restore the data bundle first)' };
  const e = mkEnv(t, { gate: ['READY', 'READY', 'READY', 'READY'], ctx: { dbFit: () => fit } });
  let out = await e.tick({ once: true });
  assert.equal(out.reason, 'db-unfit');
  assert.equal(e.spawns.length, 0);
  assert.deepEqual(e.notify.list.filter((n) => n.key === 'db-unfit').map((n) => n.severity), ['critical']);
  assert.match(e.notify.list.find((n) => n.key === 'db-unfit').text, /missing.*restore/is);
  e.setClock(e.clock() + 2 * MIN);
  out = await e.tick({ once: true });
  assert.equal(out.reason, 'db-unfit');
  assert.equal(e.notify.list.filter((n) => n.key === 'db-unfit').length, 1, 'not repeated every minute');
  e.setClock(e.clock() + 31 * MIN);
  await e.tick({ once: true });
  assert.equal(e.notify.list.filter((n) => n.key === 'db-unfit').length, 2, 'repeated after half an hour');
  assert.equal(e.halts.sets.length, 0, 'not a halt: a screening recovery must not clear it');
  assert.equal(e.screening.calls.length, 0, 'the screening probe is not even asked');
  fit = { ok: true };
  e.setClock(e.clock() + 2 * MIN);
  out = await e.tick({ once: true });
  assert.equal(e.spawns.length, 1, 'a database that is fit again lets the run start');
});

test('dbFitCheck fails closed: a run starts only when the database is ok or a writer holds the lock; corrupt, driver-less and unknown verdicts hold the queue', () => {
  const mk = (r) => wd.dbFitCheck({ home: '/x', dbFit: () => r });
  for (const reason of ['missing', 'not-a-file', 'empty-file', 'integrity-failed', 'no-candidates-table', 'no-candidates', 'open-failed', 'driver-missing', 'something-new']) assert.equal(mk({ ok: false, reason }).ok, false, reason);
  assert.equal(mk({ ok: false, reason: 'locked' }).ok, true, 'a locked database only means the check could not be made');
  assert.equal(mk({ ok: true }).ok, true);
  assert.equal(mk({ ok: false }).ok, false, 'no reason is not a pass');
  assert.equal(mk(undefined).ok, false);
  const crashed = wd.dbFitCheck({ home: '/x', dbFit: () => { throw new Error('boom'); } });
  assert.equal(crashed.ok, false, 'a crashing check holds the queue');
  assert.equal(crashed.reason, 'check-crashed');
});

test('a corrupt (open-failed) or driver-less database holds the queue with one critical db-unfit alert naming the cause, and nothing is launched', async (t) => {
  for (const [reason, detail, expect] of [['open-failed', 'file is not a database', /restore the newest backup/], ['driver-missing', 'Cannot find module better-sqlite3', /npm rebuild better-sqlite3/]]) {
    const e = mkEnv(t, { gate: ['READY', 'READY'], ctx: { dbFit: () => ({ ok: false, reason, detail }) } });
    let out = await e.tick();
    assert.equal(out.reason, 'db-unfit', reason);
    assert.equal(e.spawns.length, 0, `${reason}: nothing launched`);
    assert.equal(e.screening.calls.length, 0, `${reason}: screening never probed`);
    const alert = e.notify.list.filter((x) => x.key === 'db-unfit');
    assert.equal(alert.length, 1);
    assert.equal(alert[0].severity, 'critical');
    assert.ok(alert[0].text.includes(reason) && expect.test(alert[0].text), alert[0].text);
    e.setClock(e.clock() + MIN);
    out = await e.tick();
    assert.equal(out.reason, 'db-unfit');
    assert.equal(e.notify.list.filter((x) => x.key === 'db-unfit').length, 1, 'rate limited to one alert per 30 minutes');
  }
});

// --- halt / resume ------------------------------------------------------------------------------

test('halt: one probe miss holds without halting, two consecutive misses halt without consuming the territory', async (t) => {
  const e = mkEnv(t, { gate: ['READY', 'READY'] });
  e.screening.cheap = { ok: false, reason: 'screening gateway unreachable', detail: 'ECONNREFUSED' };
  let out = await e.tick();
  assert.equal(out.reason, 'probe-miss');
  assert.equal(e.halts.sets.length, 0);
  assert.equal(e.spawns.length, 0);

  e.setClock(e.clock() + MIN);
  out = await e.tick();
  assert.equal(out.reason, 'halted');
  assert.equal(e.halts.sets.length, 1);
  assert.equal(e.halts.sets[0].r, 'screening gateway unreachable');
  assert.equal(e.halts.sets[0].opts.blockedRun, true);
  assert.ok(e.halts.sets[0].opts.remedy);
  assert.equal(e.spawns.length, 0, 'the run was never started, so the territory is not burned');
});

test('halt: two misses more than 5 minutes apart do not halt (the streak expires)', async (t) => {
  const e = mkEnv(t, { gate: ['READY', 'READY'] });
  e.screening.cheap = { ok: false, reason: 'screening gateway unreachable' };
  await e.tick();
  e.setClock(e.clock() + 10 * MIN);
  const out = await e.tick();
  assert.equal(out.reason, 'probe-miss');
  assert.equal(e.halts.sets.length, 0);
});

test('a successful probe resets the miss streak', async (t) => {
  const e = mkEnv(t, { gate: ['READY', 'READY', 'READY'], finish: { afterMs: 5000, code: 0 } });
  e.screening.cheap = { ok: false, reason: 'x' };
  await e.tick();
  assert.equal(e.state().probeFail.count, 1);
  e.screening.cheap = { ok: true };
  e.setClock(e.clock() + MIN);
  await e.tick();
  assert.equal(e.state().probeFail.count, 0);
});

test('halted: deep canary at most once per minute; recovery clears the halt and the run proceeds', async (t) => {
  const e = mkEnv(t, {
    gate: ['READY', 'READY', 'READY', 'NO_WORK'],
    halted: { halted: true, reason: 'AI screening unavailable', since: iso(H.londonEpoch(2026, 9, 29, 9, 0)) },
    finish: { afterMs: 5000, code: 0 },
  });
  e.screening.deep = { ok: false, reason: 'screening gateway auth failed', detail: 'HTTP 401' };
  let out = await e.tick();
  assert.equal(out.reason, 'halted');
  assert.equal(e.screening.calls.filter((c) => c.deep).length, 1);
  assert.equal(e.halts.sets.at(-1).r, 'screening gateway auth failed', 'the halt reason is refreshed from the canary');

  e.setClock(e.clock() + 20000);
  out = await e.tick();
  assert.equal(e.screening.calls.filter((c) => c.deep).length, 1, 'no second canary inside a minute');
  assert.equal(out.reason, 'halted');

  e.screening.deep = { ok: true };
  e.setClock(e.clock() + 61000);
  out = await e.tick();
  assert.equal(e.halts.clears, 1, 'healthy canary clears the halt');
  assert.equal(e.spawns.length, 1, 'and the queue resumes in the same tick');
});

test('halt probes only happen when a territory is READY (legacy parity)', async (t) => {
  const e = mkEnv(t, { gate: ['NO_WORK'], halted: { halted: true, reason: 'AI screening unavailable', since: iso(0) } });
  await e.tick();
  assert.equal(e.screening.calls.length, 0);
  assert.equal(e.halts.clears, 0);
});

test('a screening health module that cannot be loaded halts instead of running unprotected', async (t) => {
  const e = mkEnv(t, { gate: ['READY', 'READY'], ctx: { screening: () => { throw new Error('module not found'); } } });
  await e.tick();
  e.setClock(e.clock() + MIN);
  await e.tick();
  assert.equal(e.halts.sets.length, 1);
  assert.match(e.halts.sets[0].r, /screening health module unavailable/);
  assert.equal(e.spawns.length, 0);
});

test('a hung probe cannot wedge the tick (timeout counts as a miss)', async (t) => {
  const e = mkEnv(t, { gate: ['READY'], ctx: { screening: () => ({ check: () => new Promise(() => {}) }) } });
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms > 10000 ? 20 : ms, ...a);
  try {
    const out = await e.tick();
    assert.equal(out.reason, 'probe-miss');
  } finally {
    global.setTimeout = realSetTimeout;
  }
});

// --- memory guard -------------------------------------------------------------------------------

test('low memory: the launch is held and a warning raised, then it proceeds when memory returns', async (t) => {
  const e = mkEnv(t, { gate: ['READY', 'READY'], finish: { afterMs: 5000, code: 0 } });
  e.env.mem = 650;
  let out = await e.tick();
  assert.equal(out.reason, 'low-memory');
  assert.equal(e.spawns.length, 0);
  const n = e.notify.list.find((x) => x.key === 'low-memory');
  assert.ok(n);
  assert.equal(n.severity, 'warn');
  e.env.mem = 700;
  e.setClock(e.clock() + MIN);
  out = await e.tick();
  assert.equal(e.spawns.length, 1, '700 MB is the floor: exactly at it is allowed');
});

// --- maintenance --------------------------------------------------------------------------------

test('queue-due runs at most every 4.5 minutes across ticks, and never overlaps itself', async (t) => {
  const e = mkEnv(t, { gate: ['NO_WORK', 'NO_WORK', 'NO_WORK'] });
  const count = () => e.execCalls.filter((c) => c.script === 'queue-due-territories.js').length;
  await e.tick();
  assert.equal(count(), 1);
  e.setClock(e.clock() + 2 * MIN);
  await e.tick();
  assert.equal(count(), 1, 'inside the pacing window');
  e.setClock(e.clock() + 3 * MIN);
  await e.tick();
  assert.equal(count(), 2);

  // a held queue-due lock (the cron job running) is respected
  const l = tick.acquireLock(e.files.queueDueLock, { info: { role: 'queue-due' } });
  const r = await wd.runQueueDue(e.ctx, { force: true });
  assert.equal(r.skipped, 'locked');
  l.release();
});

test('queue-due failing three times in a row raises one warning', async (t) => {
  const e = mkEnv(t, { queueDueFail: true });
  for (let i = 0; i < 4; i++) {
    await wd.runQueueDue(e.ctx, { force: true });
  }
  assert.equal(e.notify.list.filter((x) => x.key === 'queue-due-failing').length, 1);
});

test('maintenance every 5 minutes runs cull-ghost only when idle', async (t) => {
  const e = mkEnv(t, { gate: [] });
  H.writeJson(e.files.run, { pid: process.pid, token: tick.procToken(process.pid), nonce: 'live', startedAt: iso(e.clock()) });
  await e.tick({ maxMinutes: 1 });
  assert.equal(e.execCalls.filter((c) => c.script === 'cull-ghost-phase1.js').length, 0, 'no stranded-run recovery beside a live browser run');
  assert.ok(e.execCalls.some((c) => c.script === 'queue-due-territories.js'), 'queue-due still runs');
  fs.unlinkSync(e.files.run);
  e.setClock(e.clock() + 6 * MIN);
  await e.tick();
  assert.equal(e.execCalls.filter((c) => c.script === 'cull-ghost-phase1.js').length, 1);
});

test('cull-ghost output is parsed and recovered children are adopted as a live run', async (t) => {
  const live = H.sleeper(t);
  const cull = `CULL_OK culled=2 kept=1 ids=a,b\nRECOVERY_OK n=2 phase1-2026-09-29-0800(pid=${H.deadPid()},mode=run-pipeline),phase1-2026-09-29-0810(pid=${live.pid},mode=process-approved-queue)`;
  const e = mkEnv(t, { cull });
  const r = await wd.cullGhost(e.ctx);
  assert.equal(r.culled, 2);
  assert.equal(r.recovered.length, 2);
  assert.equal(r.recovered[1].id, 'phase1-2026-09-29-0810');
  assert.equal(r.recovered[1].mode, 'process-approved-queue');
  const b = tick.busyState({ home: e.home });
  assert.equal(b.busy, true);
  assert.equal(b.kind, 'adopted');
  assert.equal(b.pid, live.pid);
});

test('adopted recovery children block a new launch until they end', async (t) => {
  const live = H.sleeper(t);
  const e = mkEnv(t, { gate: ['READY'], finish: { afterMs: 5000, code: 0 } });
  tick.addAdopted(e.files, [{ pid: live.pid, id: 'phase1-x', mode: 'run-pipeline' }]);
  const out = await e.tick({ maxMinutes: 1 });
  assert.equal(e.spawns.length, 0);
  assert.equal(out.reason, 'bound');
  live.kill();
  await H.waitFor(() => !H.pidExists(live.pid), 5000);
  const out2 = await e.tick();
  assert.equal(e.spawns.length, 1);
});

// --- misc ---------------------------------------------------------------------------------------

test('--once runs exactly one iteration', async (t) => {
  const e = mkEnv(t, { gate: ['READY', 'READY'], finish: { afterMs: 5000, code: 0 } });
  const out = await e.tick({ once: true });
  assert.equal(out.iterations, 1);
  assert.equal(e.spawns.length, 1);
  assert.equal(out.reason, 'once');
});

test('a tick that loses its lock stops without acting or deleting the new owner lock', async (t) => {
  const e = mkEnv(t, { gate: ['NO_WORK'] });
  const original = e.ctx.sleep;
  let stole = false;
  H.writeJson(e.files.run, { pid: process.pid, token: tick.procToken(process.pid), nonce: 'live', startedAt: iso(e.clock()) });
  e.ctx.sleep = async (ms) => {
    if (!stole) {
      stole = true;
      fs.writeFileSync(e.files.tickLock, JSON.stringify({ pid: process.pid, nonce: 'someone-else', startedAt: iso(e.clock()) }));
    }
    return original(ms);
  };
  const out = await e.tick({ maxMinutes: 5 });
  assert.equal(out.reason, 'lock-lost');
  assert.equal(tick.readRecord(e.files.tickLock).rec.nonce, 'someone-else');
});

test('gate ERROR is logged and the tick exits; a failing iteration exits 1 after releasing the lock', async (t) => {
  const e = mkEnv(t, { gate: ['ERROR'] });
  let out = await e.tick();
  assert.equal(out.reason, 'gate-error');
  assert.ok(e.logs.some((l) => l.startsWith('error: gate check failed')));

  const e2 = mkEnv(t, { ctx: { exec: async () => { throw new Error('exec exploded'); } } });
  out = await e2.tick();
  assert.equal(out.exitCode, 1);
  assert.equal(out.reason, 'iteration-error');
  assert.equal(fs.existsSync(e2.files.tickLock), false);
});

test('statusReport summarises supervision state without throwing on an empty home', async (t) => {
  const e = mkEnv(t, { gate: ['NO_WORK'] });
  await e.tick();
  const r = wd.statusReport(e.ctx, false);
  assert.equal(r.busy, false);
  assert.equal(r.queueDepth, 0);
  assert.equal(r.halt, null);
  assert.ok(r.london.hour === 10);
  assert.ok(r.lastTickAt);
});

test('push drought: raised only when a queue exists, no halt/back-off explains it, and the window has been open 3 h', async (t) => {
  let Database;
  try { Database = require('better-sqlite3'); } catch { return t.skip('better-sqlite3 not installed'); }
  const e = mkEnv(t);
  const db = new Database(path.join(e.home, 'candidates.db'));
  db.exec('CREATE TABLE run_results (run_key TEXT PRIMARY KEY, date TEXT, completed_at TEXT, new_to_zoho INTEGER)');
  db.prepare('INSERT INTO run_results VALUES (?,?,?,?)').run('r1', '2026-09-29', iso(e.clock() - 4 * 60 * MIN), 5);
  db.close();
  const state = wd.defaultState();
  assert.equal(wd.checkPushDrought(e.ctx, state).skipped, 'no-queue');
  H.pendingFile(e.home, 'territory-1.json');
  const r = wd.checkPushDrought(e.ctx, state);
  assert.equal(r.alerted, true);
  assert.equal(e.notify.list.at(-1).key, 'push-drought');
  assert.equal(e.notify.list.at(-1).severity, 'critical');
  state.staleCooldownUntil = e.clock() + MIN;
  assert.equal(wd.checkPushDrought(e.ctx, state).skipped, 'explained-cooldown');
  state.staleCooldownUntil = 0;
  e.halts.state = { halted: true, reason: 'x' };
  assert.equal(wd.checkPushDrought(e.ctx, state).skipped, 'explained-halt');
  e.halts.state = null;
  e.setClock(H.londonEpoch(2026, 9, 29, 8, 30));
  assert.equal(wd.checkPushDrought(e.ctx, state).skipped, 'window');
});

test('push drought: a recent push is fine', async (t) => {
  let Database;
  try { Database = require('better-sqlite3'); } catch { return t.skip('better-sqlite3 not installed'); }
  const e = mkEnv(t);
  const db = new Database(path.join(e.home, 'candidates.db'));
  db.exec('CREATE TABLE run_results (run_key TEXT PRIMARY KEY, date TEXT, completed_at TEXT, new_to_zoho INTEGER)');
  db.prepare('INSERT INTO run_results VALUES (?,?,?,?)').run('r1', '2026-09-29', iso(e.clock() - 30 * MIN), 5);
  db.close();
  H.pendingFile(e.home, 'territory-1.json');
  assert.equal(wd.checkPushDrought(e.ctx, wd.defaultState()).ok, true);
  assert.equal(e.notify.list.length, 0);
});

test('a recovered child older than the run ceiling is killed and no longer blocks the queue', async (t) => {
  const live = H.sleeper(t);
  const e = mkEnv(t, { gate: ['NO_WORK'] });
  const files = tick.runtimeFiles(e.home);
  H.writeJson(files.adopted, [{ pid: live.pid, token: tick.procToken(live.pid), id: 'phase1-old', mode: 'run-pipeline', addedAt: iso(e.clock() - 73 * MIN) }]);
  assert.equal(tick.busyState({ home: e.home, now: e.clock() }).busy, false, 'past the limit it is ignored for liveness');
  await e.tick();
  assert.ok(e.killed.some((k) => k.pid === live.pid), 'and it is ended');
  H.writeJson(files.adopted, [{ pid: live.pid, token: tick.procToken(live.pid), id: 'phase1-new', mode: 'run-pipeline', addedAt: iso(e.clock() - 10 * MIN) }]);
  assert.equal(tick.busyState({ home: e.home, now: e.clock() }).busy, true, 'a young one still blocks');
});

test('persistent gate errors raise one warning after five checks', async (t) => {
  const e = mkEnv(t, { gate: ['ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR'] });
  for (let i = 0; i < 6; i++) { await e.tick(); e.setClock(e.clock() + MIN); }
  assert.equal(e.notify.list.filter((x) => x.key === 'gate-error').length, 1);
  assert.equal(e.state().gateErrors, 6);
});

test('a runner that cannot be spawned backs the launch off for a minute instead of spinning', async (t) => {
  const e = mkEnv(t, { gate: ['READY', 'READY', 'READY'], noRegister: true, ctx: {} });
  const realSpawn = e.ctx.spawnRunner;
  e.ctx.spawnRunner = (o) => {
    const child = realSpawn(o);
    queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
    return child;
  };
  const out = await e.tick();
  assert.equal(e.spawns.length, 1);
  assert.equal(out.reason, 'launch-backoff');
});

test('exit 11 for a safe-list block, a logout or a CV Database module error backs off but raises no second alert (the login module owns those)', async (t) => {
  for (const reason of ['safelist', 'login', 'cvdb-module']) {
    const e = mkEnv(t, { gate: ['READY', 'READY'], finish: { afterMs: 10000, code: 11, extra: { reason } } });
    const out = await e.tick();
    assert.equal(out.reason, 'cooldown', reason);
    assert.equal(e.notify.list.length, 0, `${reason}: no duplicate alert`);
    assert.ok(e.state().staleCooldownUntil > e.clock(), `${reason}: still backs off 15 minutes`);
    assert.ok(e.logs.some((l) => l.includes('the login module owns the alert')));
  }
});

test('the tick touches runtime/tick.heartbeat on every start and iteration for the dashboard stall detector', async (t) => {
  const e = mkEnv(t, { gate: ['NO_WORK'] });
  assert.equal(fs.existsSync(e.files.tickHeartbeat), false);
  await e.tick();
  assert.ok(fs.existsSync(e.files.tickHeartbeat));
  assert.match(fs.readFileSync(e.files.tickHeartbeat, 'utf8'), /^2026-09-29T/);
  const busyEnv = mkEnv(t);
  H.writeJson(busyEnv.files.run, { pid: process.pid, token: tick.procToken(process.pid), nonce: 'live', startedAt: iso(busyEnv.clock()) });
  await busyEnv.tick({ maxMinutes: 1 });
  const first = fs.readFileSync(busyEnv.files.tickHeartbeat, 'utf8');
  assert.ok(first > iso(H.londonEpoch(2026, 9, 29, 10, 0)), 'updated as the fake clock moved');
});

test('a tick that finds another tick running still leaves the heartbeat to that tick', async (t) => {
  const e = mkEnv(t);
  const held = tick.acquireLock(e.files.tickLock, { info: { role: 'tick' } });
  await e.tick();
  assert.equal(fs.existsSync(e.files.tickHeartbeat), false, 'an overlapping fire does not pretend to be the working tick');
  held.release();
});

test('the halt remedy comes from the screening module when it supplies one', async (t) => {
  const e = mkEnv(t, {
    gate: ['READY', 'READY'],
    ctx: { screening: () => ({ REMEDIES: { auth: 'Rotate the key please.' }, check: async () => ({ ok: false, reason: 'screening gateway auth failed', key: 'auth', detail: 'HTTP 401', ms: 3 }) }) },
  });
  await e.tick();
  e.setClock(e.clock() + MIN);
  await e.tick();
  assert.equal(e.halts.sets.length, 1);
  assert.equal(e.halts.sets[0].opts.remedy, 'Rotate the key please.');
  assert.equal(e.halts.sets[0].r, 'screening gateway auth failed');
  assert.equal(e.halts.sets[0].d, 'HTTP 401');
});

test('against the real screening-health module (no key configured): the result shape drives a halt with its own fixed reason and remedy', async (t) => {
  let real;
  const saved = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = '';
  t.after(() => { if (saved === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = saved; });
  try { real = require(path.join(H.SRC_SCRIPTS, 'lib', 'screening-health.js')); } catch (err) { return t.skip(`real module not loadable here: ${err.message}`); }
  const probe = await real.check({ deep: false });
  if (probe.ok) return t.skip('a key is configured on this machine');
  assert.equal(typeof probe.reason, 'string');
  assert.ok(Object.values(real.REASONS).includes(probe.reason), 'a fixed reason string');
  assert.equal(typeof probe.ms, 'number');
  const e = mkEnv(t, { gate: ['READY', 'READY'], ctx: { screening: () => real } });
  await e.tick();
  e.setClock(e.clock() + MIN);
  await e.tick();
  assert.equal(e.halts.sets.length, 1);
  assert.equal(e.halts.sets[0].r, probe.reason);
  assert.equal(e.halts.sets[0].opts.remedy, real.REMEDIES[probe.key]);
  assert.equal(e.spawns.length, 0);
});

// --- poison territories, streak alerts, clock excursions, log floods (review findings) ------------------

const pendingPath = (e, name) => path.join(e.home, 'pending-searches', name || 'territory-1-x.json');
const quarantinePath = (e, name) => path.join(e.home, 'pending-searches', '.quarantine', name || 'territory-1-x.json');
let nonceSeq = 0;
const result = (e, code, reason, over) => Object.assign({ nonce: `n${++nonceSeq}`, exitCode: code, reason, file: 'territory-1-x.json', endedAt: iso(e.clock()), pool: 0, approved: 0, elapsedSec: 10 }, over);

test('territory failures are counted per pending file; the third failure in a row quarantines it with one critical alert naming the file and the reason', (t) => {
  const e = mkEnv(t);
  H.pendingFile(e.home, 'territory-1-x.json', { location: 'AB1', spawnedAt: iso(e.clock()) });
  const state = wd.defaultState();
  wd.handleResult(e.ctx, state, result(e, 12, 'phase1-exit-6'));
  assert.equal(H.readJson(pendingPath(e)).failedRuns, 1);
  assert.equal(H.readJson(pendingPath(e)).lastFailure.exitCode, 12);
  assert.equal(H.readJson(pendingPath(e)).spawnedAt !== undefined, true, 'the claim is not touched here: the runner decided to keep it');
  wd.handleResult(e.ctx, state, result(e, 13, 'timeout'));
  assert.equal(H.readJson(pendingPath(e)).failedRuns, 2);
  assert.equal(e.notify.list.filter((x) => /^territory-quarantined/.test(x.key)).length, 0);
  wd.handleResult(e.ctx, state, result(e, 12, 'phase1-exit-6'));
  assert.equal(fs.existsSync(pendingPath(e)), false, 'out of the queue');
  assert.equal(H.readJson(quarantinePath(e)).failedRuns, 3);
  assert.match(fs.readFileSync(path.join(e.home, 'pending-searches', '.quarantine', 'territory-1-x.why.txt'), 'utf8'), /3 failed runs in a row, last exit 12 \(phase1-exit-6\)/);
  const q = e.notify.list.filter((x) => /^territory-quarantined/.test(x.key));
  assert.equal(q.length, 1);
  assert.equal(q[0].key, 'territory-quarantined:territory-1-x.json');
  assert.equal(q[0].severity, 'critical');
  assert.match(q[0].text, /territory-1-x\.json \(Chef in AB1\) failed 3 runs in a row \(last: exit 12, phase1-exit-6 = bad url encoding\)/);
  assert.match(q[0].text, /--release-quarantine territory-1-x\.json/);
});

test('a successful run starts the count again, and failures the territory did not cause are never counted', (t) => {
  const e = mkEnv(t);
  H.pendingFile(e.home, 'territory-1-x.json', { location: 'AB1' });
  const state = wd.defaultState();
  wd.handleResult(e.ctx, state, result(e, 12, 'phase1-exit-5'));
  wd.handleResult(e.ctx, state, result(e, 12, 'phase1-exit-5'));
  assert.equal(H.readJson(pendingPath(e)).failedRuns, 2);
  wd.handleResult(e.ctx, state, result(e, 0, null));
  assert.equal(H.readJson(pendingPath(e)).failedRuns, undefined, 'exit 0 clears the counters');
  assert.equal(H.readJson(pendingPath(e)).lastFailure, undefined);
  for (const [code, reason] of [[11, 'login'], [11, 'safelist'], [12, 'phase1-exit-3'], [12, 'phase1-exit-7'], [1, 'signal-SIGTERM'], [1, 'browser-lock-error'], [1, 'resolve-error'], [1, 'mark-spawned-error'], [12, 'spawn-error']]) {
    wd.handleResult(e.ctx, state, result(e, code, reason));
  }
  assert.equal(H.readJson(pendingPath(e)).failedRuns, undefined, 'no faultless failure counts');
  assert.equal(e.notify.list.some((x) => /^territory-quarantined/.test(x.key)), false);
});

test('while several different territories fail at once the failures are the system\'s, not the files\': nothing is counted or quarantined', (t) => {
  const e = mkEnv(t);
  for (const n of ['a', 'b', 'c', 'd']) H.pendingFile(e.home, `territory-${n}.json`, { location: n.toUpperCase() });
  const state = wd.defaultState();
  for (const n of ['a', 'b', 'c']) wd.handleResult(e.ctx, state, result(e, 12, 'phase1-exit-5', { file: `territory-${n}.json` }));
  assert.equal(H.readJson(pendingPath(e, 'territory-a.json')).failedRuns, 1);
  assert.equal(H.readJson(pendingPath(e, 'territory-b.json')).failedRuns, 1);
  assert.equal(H.readJson(pendingPath(e, 'territory-c.json')).failedRuns, undefined, 'the third distinct failing file is where it becomes systemic');
  for (let i = 0; i < 4; i++) wd.handleResult(e.ctx, state, result(e, 12, 'phase1-exit-5', { file: 'territory-d.json' }));
  assert.equal(fs.existsSync(pendingPath(e, 'territory-d.json')), true, 'not quarantined during a system-wide failure');
  assert.equal(e.notify.list.some((x) => /^territory-quarantined/.test(x.key)), false);
  assert.ok(e.logs.some((l) => /different territories failed/.test(l)));
});

test('a run that wedged for 70 minutes keeps its claim (the gate rotates on); a plain crash gives it back; both are counted', async (t) => {
  for (const [nonce, kind] of [['wedged1', 'overrun'], ['crashed1', null]]) {
    const e = mkEnv(t, { gate: ['READY'] });
    const pending = pendingPath(e);
    H.writeJson(pending, { jobTitle: 'Chef', location: 'AB1', spawnedAt: iso(e.clock() - 2 * MIN) });
    H.writeJson(e.files.run, { pid: H.deadPid(), nonce, childPid: H.deadPid(), startedAt: iso(e.clock() - 3 * MIN), file: 'territory-1-x.json' });
    const state = wd.defaultState();
    if (kind) state.killedNonces[nonce] = kind;
    wd.reconcileRun(e.ctx, state);
    const d = H.readJson(pending);
    assert.equal(d.failedRuns, 1, `${nonce}: counted`);
    assert.equal(d.spawnedAt !== undefined, kind === 'overrun', `${nonce}: claim ${kind === 'overrun' ? 'kept' : 'released'}`);
    assert.equal(d.lastFailure.reason, kind === 'overrun' ? 'overrun-killed' : 'runner-crashed');
  }
});

test('the run-failures alert repeats every 10 failures and every 6 hours, states the streak length, and turns critical after a day', (t) => {
  const e = mkEnv(t);
  const state = wd.defaultState();
  const alerts = () => e.notify.list.filter((x) => x.key === 'run-failures');
  let clock = e.clock();
  const fail = (n) => { for (let i = 0; i < n; i++) { clock += MIN; wd.handleResult(e.ctx, state, result(e, 12, 'phase1-exit-5', { file: null, endedAt: iso(clock) })); } };
  fail(2);
  assert.equal(alerts().length, 0);
  fail(1);
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].text, /^3 pipeline runs in a row have failed/);
  assert.equal(alerts()[0].severity, 'warn');
  fail(9);
  assert.equal(alerts().length, 1, 'failures 4 to 12 are quiet');
  fail(1);
  assert.equal(alerts().length, 2, 'failure 13 repeats');
  assert.match(alerts()[1].text, /^13 pipeline runs in a row/);
  clock += 7 * 3600000;
  fail(1);
  assert.equal(alerts().length, 3, 'six hours later it repeats again');
  clock += 25 * 3600000;
  fail(1);
  const last = alerts().at(-1);
  assert.equal(last.severity, 'critical', 'a streak older than a day is critical');
  assert.match(last.text, /over 3\d h/);
});

test('queue-due and gate failure alerts also repeat instead of firing once per streak', () => {
  assert.equal(wd.streakDue(3, 3, 12), true);
  assert.equal(wd.streakDue(4, 3, 12), false);
  assert.equal(wd.streakDue(15, 3, 12), true);
  assert.equal(wd.streakDue(27, 3, 12), true);
  assert.equal(wd.streakDue(65, 5, 60), true);
  assert.equal(wd.streakDue(64, 5, 60), false);
});

test('runner exit 10: a stuck "busy" answer for 30 minutes is reported through the tick', async (t) => {
  const e = mkEnv(t, { gate: ['READY', 'READY', 'READY', 'READY'], finish: { default: { afterMs: 0, code: 10 } } });
  let out;
  for (let i = 0; i < 4; i++) {
    out = await e.tick();
    e.setClock(e.clock() + 12 * MIN);
  }
  const w = e.notify.list.filter((x) => x.key === 'runner-busy');
  assert.equal(w.length, 1, out && out.reason);
  assert.equal(w[0].severity, 'warn');
  assert.match(w[0].text, /stale runtime\/browser\.lock|browser\.lock/);
  assert.equal(e.state().exit10.n >= 3, true);
});

test('persisted timestamps that lie more than a day in the future (a clock excursion) are ignored, so the tick is not frozen', (t) => {
  const e = mkEnv(t);
  const future = e.clock() + 30 * 86400000;
  H.writeJson(e.files.state, { staleCooldownUntil: future, launchNotBefore: future, lastMaintenanceAt: future, lastSlowCheckAt: future, haltProbeAt: future, dbAlertAt: future, superviseSince: future, lastTickAt: future, consecutiveFailures: 1 });
  const st = wd.loadState(e.ctx);
  for (const k of ['staleCooldownUntil', 'launchNotBefore', 'lastMaintenanceAt', 'lastSlowCheckAt', 'haltProbeAt', 'dbAlertAt', 'superviseSince', 'lastTickAt']) assert.equal(st[k], 0, k);
  assert.equal(st.consecutiveFailures, 1, 'everything else is kept');
  H.writeJson(e.files.state, { staleCooldownUntil: e.clock() + 15 * MIN });
  assert.equal(wd.loadState(e.ctx).staleCooldownUntil, e.clock() + 15 * MIN, 'a real 15-minute back-off survives');
});

test('a tick launches after a future-dated back-off and queue-due state were left behind', async (t) => {
  const e = mkEnv(t, { gate: ['READY'] });
  const future = e.clock() + 30 * 86400000;
  H.writeJson(e.files.state, { staleCooldownUntil: future, launchNotBefore: future, lastMaintenanceAt: future });
  H.writeJson(e.files.queueDueState, { lastAt: future });
  const out = await e.tick();
  assert.equal(out.launched, 1);
  assert.equal(e.execCalls.some((c) => c.script === 'queue-due-territories.js'), true, 'queue-due ran despite its future lastAt');
});

test('a run log past the cap ends the run, keeps only its tail, and raises one critical alert', async (t) => {
  const e = mkEnv(t);
  const log = path.join(e.home, 'logs', 'phase1-console-flood.log');
  fs.writeFileSync(log, `${'x'.repeat(3000)}TAIL-MARKER`);
  const rec = { pid: 4242, token: 'tok', nonce: 'flood1', childPid: 4243, childToken: 'ctok', runLog: log, startedAt: iso(e.clock()) };
  const old = wd.C.LOG_CAP_BYTES;
  const oldKeep = wd.C.LOG_KEEP_BYTES;
  wd.C.LOG_CAP_BYTES = 1000;
  wd.C.LOG_KEEP_BYTES = 200;
  try {
    const state = wd.defaultState();
    assert.equal(await wd.guardRunLogs(e.ctx, state, rec), true);
    assert.deepEqual(e.killed.map((k) => k.pid), [4243, 4242], 'phase1 first, then the runner');
    assert.equal(state.killedNonces.flood1, 'logflood');
    const text = fs.readFileSync(log, 'utf8');
    assert.ok(text.length < 400 && text.endsWith('TAIL-MARKER') && text.includes('was cut to its last'), text.slice(0, 120));
    const a = e.notify.list.filter((x) => x.key === 'log-flood');
    assert.equal(a.length, 1);
    assert.equal(a[0].severity, 'critical');
    assert.equal(await wd.guardRunLogs(e.ctx, state, rec), false, 'a small log is left alone');
  } finally {
    wd.C.LOG_CAP_BYTES = old;
    wd.C.LOG_KEEP_BYTES = oldKeep;
  }
});

test('the disk is checked on every 5-minute maintenance pass, also while a run is in flight', async (t) => {
  let calls = 0;
  const e = mkEnv(t, { gate: ['READY'], ctx: { diskGuard: () => { calls++; return {}; } } });
  H.writeJson(e.files.run, { pid: process.pid, token: tick.procToken(process.pid), nonce: 'busy1', role: 'runner', startedAt: iso(e.clock()), file: 'territory-1-x.json' });
  const state = wd.defaultState();
  await wd.iterate(e.ctx, state, { superviseMs: 10000 });
  assert.equal(calls, 1);
  e.setClock(e.clock() + 2 * MIN);
  await wd.iterate(e.ctx, state, { superviseMs: 10000 });
  assert.equal(calls, 1, 'not more often than every 5 minutes');
  e.setClock(e.clock() + 4 * MIN);
  await wd.iterate(e.ctx, state, { superviseMs: 10000 });
  assert.equal(calls, 2);
});

test('an alert that cannot be written is not silent: the tick logs its text and exits 1 when it was critical', (t) => {
  const e = mkEnv(t);
  const logs = [];
  const ctx = wd.makeCtx({ home: e.home, log: (m, l) => logs.push(`${l || 'info'}: ${m}`) });
  const notify = require(path.join(H.SRC_SCRIPTS, 'lib', 'notify.js'));
  const outbox = path.dirname(notify.FILE);
  fs.rmSync(outbox, { recursive: true, force: true });
  fs.writeFileSync(outbox, 'a file where the outbox directory should be');
  try {
    assert.equal(ctx.notify({ severity: 'warn', key: 'w', text: 'a warning' }), false);
    assert.equal(ctx.criticalLost, undefined, 'a lost warning does not fail the tick');
    assert.equal(ctx.notify({ severity: 'critical', key: 'c', text: 'a critical' }), false);
    assert.equal(ctx.criticalLost, 1);
    assert.ok(logs.some((l) => /ALERT NOT RECORDED.*\[critical\] c: a critical/.test(l)), logs.join('\n'));
  } finally {
    fs.rmSync(outbox, { force: true });
    fs.mkdirSync(outbox, { recursive: true });
  }
});

function droughtEnv(t, setup) {
  let Database;
  try { Database = require('better-sqlite3'); } catch { return null; }
  const e = mkEnv(t);
  const db = new Database(path.join(e.home, 'candidates.db'));
  setup(db, e);
  db.close();
  H.pendingFile(e.home, 'territory-1.json');
  return e;
}

test('push drought on a fresh install: no run_results and no pushed candidate ever, measured from when supervision started', (t) => {
  const e = droughtEnv(t, (db) => { db.exec('CREATE TABLE candidates (id INTEGER PRIMARY KEY, zoho_pushed_at TEXT)'); });
  if (!e) return t.skip('better-sqlite3 not installed');
  const state = wd.defaultState();
  assert.equal(wd.checkPushDrought(e.ctx, state).skipped, 'no-data', 'no baseline yet');
  state.superviseSince = e.clock() - 1 * 60 * MIN;
  assert.equal(wd.checkPushDrought(e.ctx, state).ok, true, 'one hour in: fine');
  state.superviseSince = e.clock() - 4 * 60 * MIN;
  const r = wd.checkPushDrought(e.ctx, state);
  assert.equal(r.alerted, true, 'four hours in with a queue and nothing ever pushed');
  assert.equal(e.notify.list.at(-1).key, 'push-drought');
});

test('push drought: a last push that predates supervision (go-live day) does not alert on the first tick; a later push counts', (t) => {
  const e = droughtEnv(t, (db, env) => {
    db.exec('CREATE TABLE run_results (run_key TEXT PRIMARY KEY, date TEXT, completed_at TEXT, new_to_zoho INTEGER)');
    db.prepare('INSERT INTO run_results VALUES (?,?,?,?)').run('r0', '2026-09-28', iso(env.clock() - 30 * 60 * MIN), 40);
  });
  if (!e) return t.skip('better-sqlite3 not installed');
  const state = wd.defaultState();
  state.superviseSince = e.clock() - 10 * MIN;
  assert.equal(wd.checkPushDrought(e.ctx, state).ok, true);
  assert.equal(e.notify.list.length, 0);
});

test('push drought: candidates.zoho_pushed_at (UTC, no zone suffix) stands in when run_results has nothing', (t) => {
  const e = droughtEnv(t, (db, env) => {
    db.exec('CREATE TABLE candidates (id INTEGER PRIMARY KEY, zoho_pushed_at TEXT)');
    const stamp = new Date(env.clock() - 20 * MIN).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare('INSERT INTO candidates (zoho_pushed_at) VALUES (?)').run(stamp);
  });
  if (!e) return t.skip('better-sqlite3 not installed');
  const state = wd.defaultState();
  state.superviseSince = e.clock() - 10 * 60 * MIN;
  assert.equal(wd.checkPushDrought(e.ctx, state).ok, true, 'a push 20 minutes ago is not a drought');
});

test('the first tick records when supervision started', async (t) => {
  const e = mkEnv(t, { gate: ['NO_WORK'] });
  const t0 = e.clock();
  await e.tick();
  assert.equal(e.state().superviseSince, t0);
  e.setClock(e.clock() + 5 * MIN);
  await e.tick();
  assert.equal(e.state().superviseSince, t0, 'never moved by later ticks');
});

test('review finding "ghost cull then concurrent recovery of a live run" cannot happen through the tick: while a run is alive a stale-looking phase1 status is neither culled nor recovered', async (t) => {
  const e = mkEnv(t);
  H.writeJson(e.files.run, { pid: process.pid, token: tick.procToken(process.pid), nonce: 'live1', role: 'runner', startedAt: iso(e.clock() - 40 * MIN), file: 'territory-1-x.json', childPid: process.pid, childToken: tick.procToken(process.pid) });
  const status = path.join(e.home, 'runs', 'phase1-2026-09-29-090000.json');
  H.writeJson(status, { id: 'phase1-2026-09-29-090000', status: 'phase1_running', jobTitle: 'Chef', location: 'AB1', startedAt: iso(e.clock() - 45 * MIN), updatedAt: iso(e.clock() - 45 * MIN) });
  const state = wd.defaultState();
  for (let i = 0; i < 3; i++) {
    await wd.iterate(e.ctx, state, { superviseMs: 10000 });
    e.setClock(e.clock() + 6 * MIN);
  }
  assert.equal(e.execCalls.some((c) => c.script === 'cull-ghost-phase1.js'), false, 'the ghost cull (and the recovery it starts) is not even run');
  assert.equal(H.readJson(status).status, 'phase1_running');
  assert.equal(wd.releaseOrphanedLocks(e.ctx, { minAgeMs: 0 }).skipped, 'busy');
});

test('--status lists the quarantined territories', (t) => {
  const e = mkEnv(t);
  H.pendingFile(e.home, 'territory-1-x.json', { location: 'AB1' });
  assert.deepEqual(wd.statusReport(e.ctx, false).quarantined, []);
  const state = wd.defaultState();
  for (let i = 0; i < 3; i++) wd.handleResult(e.ctx, state, result(e, 12, 'phase1-exit-5'));
  assert.deepEqual(wd.statusReport(e.ctx, false).quarantined, ['territory-1-x.json']);
  assert.equal(wd.statusReport(e.ctx, false).queueDepth, 0, 'a quarantined file is not queue depth');
});
