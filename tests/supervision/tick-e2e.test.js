'use strict';
// Real processes: a tick driver launches a real runner, which launches a fake phase1. The kill tests
// prove that no instant of a kill leaves an orphaned lock or a double run. Runs on Linux (WSL).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./_helpers');

H.installNetworkGuard();
const SKIP = !H.IS_LINUX && 'process-kill semantics are verified on Linux (WSL)';
process.env.RESOURCER_HOME = H.mkHome(null, 'e2ebase');
const tick = require(path.join(H.SRC_SCRIPTS, 'lib', 'tick.js'));

const TICK_DRIVER = `
const path = require('path');
const home = process.env.RESOURCER_HOME;
const wd = require(path.join(home, 'scripts', 'pipeline-watchdog.js'));
const over = JSON.parse(process.env.DRIVER_CTX || '{}');
const opts = JSON.parse(process.env.DRIVER_OPTS || '{}');
const ctx = wd.makeCtx(Object.assign({ home, inWindow: () => true, slowChecks: async () => {}, diskGuard: () => ({}), log: (m, l) => console.log((l || 'info') + ': ' + m) }, over));
const stop = () => { ctx.stop = true; };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
wd.runTick(ctx, Object.assign({ maxMinutes: 3, superviseMs: 250 }, opts)).then((r) => {
  console.log('TICK_RESULT ' + JSON.stringify({ reason: r.reason, iterations: r.iterations, launched: r.launched, exitCode: r.exitCode }));
  process.exit(r.exitCode);
}, (e) => { console.error(e); process.exit(99); });
`;

function mkE2E(t, phase1Ctl, pendingCount) {
  const home = H.mkHome(t, 'e2e', { db: true });
  H.installScripts(home);
  fs.writeFileSync(path.join(home, 'driver.js'), TICK_DRIVER);
  fs.writeFileSync(path.join(home, 'scripts', 'process-approved-queue.js'), `
const fs = require('fs'); const path = require('path');
fs.writeFileSync(path.join(process.env.RESOURCER_HOME, 'markers', 'recovery-' + process.pid + '.json'), JSON.stringify({ pid: process.pid, start: Date.now(), argv: process.argv.slice(2) }));
setTimeout(() => process.exit(0), 4000);
`);
  H.setCtl(home, 'phase1', phase1Ctl || { sleepMs: 500 });
  for (let i = 1; i <= (pendingCount === undefined ? 1 : pendingCount); i++) {
    H.pendingFile(home, `territory-${i}-20260929-1000.json`, { location: `AB${i}`, sources: 'caterer' });
  }
  return { home, files: tick.runtimeFiles(home) };
}

function startTick(e, over, opts, extraEnv) {
  const c = spawn(process.execPath, [path.join(e.home, 'driver.js')], {
    cwd: e.home,
    env: { ...process.env, RESOURCER_HOME: e.home, RESOURCER_SETTLE_MS: '0', DRIVER_CTX: JSON.stringify(over || {}), DRIVER_OPTS: JSON.stringify(opts || {}), ...(extraEnv || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const h = { child: c, out: '', err: '', exited: null };
  c.stdout.on('data', (d) => { h.out += d; });
  c.stderr.on('data', (d) => { h.err += d; });
  h.done = new Promise((resolve) => c.on('close', (code, sig) => { h.exited = { code, sig }; resolve(h.exited); }));
  h.result = () => { const m = /TICK_RESULT (.*)/.exec(h.out); return m ? JSON.parse(m[1]) : null; };
  return h;
}

const markers = (e, prefix) => fs.readdirSync(path.join(e.home, 'markers')).filter((f) => f.startsWith(prefix)).map((f) => H.readJson(path.join(e.home, 'markers', f))).sort((a, b) => a.start - b.start);
const runRecord = (e) => H.readJson(e.files.run, null);
const alertsOf = (e) => H.readLines(path.join(e.home, 'outbox', 'alerts.jsonl'));
const cleanup = (t, pids) => t.after(() => { for (const p of pids()) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } });

test('two territories run back to back, never overlapping, and the tick ends cleanly', { skip: SKIP, timeout: 90000 }, async (t) => {
  const e = mkE2E(t, { sleepMs: 700 }, 2);
  const tk = startTick(e);
  const exit = await tk.done;
  assert.equal(exit.code, 0, tk.out + tk.err);
  const m = markers(e, 'phase1-');
  assert.equal(m.length, 2);
  assert.ok(m[1].start >= m[0].end, `no overlap: run 2 started ${m[1].start} before run 1 ended ${m[0].end}`);
  assert.deepEqual(m.map((x) => x.location).sort(), ['AB1', 'AB2']);
  const r = tk.result();
  assert.equal(r.launched, 2);
  assert.equal(r.reason, 'gate-spawned');
  assert.equal(fs.existsSync(e.files.tickLock), false);
  assert.equal(fs.existsSync(e.files.run), false);
  const st = H.readJson(e.files.state);
  assert.equal(st.recentRuns.length, 2);
  assert.ok(st.recentRuns.every((x) => x.exitCode === 0));
  assert.equal(alertsOf(e).length, 0, 'no alert on a healthy day');
});

test('kill -9 of the TICK mid-run: the runner and phase1 survive, the next tick adopts the run (no double run)', { skip: SKIP, timeout: 90000 }, async (t) => {
  const e = mkE2E(t, { sleepMs: 5000 });
  let pids = [];
  cleanup(t, () => pids);
  const a = startTick(e);
  const rec = await H.waitFor(() => { const r = runRecord(e); return r && r.childPid ? r : null; }, 15000);
  assert.ok(rec, `run registered: ${a.out}${a.err}`);
  pids = [rec.pid, rec.childPid];
  a.child.kill('SIGKILL');
  await a.done;
  assert.equal(H.pidExists(rec.pid), true, 'runner survives the tick');
  assert.equal(H.pidExists(rec.childPid), true, 'phase1 survives the tick');
  assert.ok(fs.existsSync(e.files.tickLock), 'the killed tick left its lock behind');

  const b = startTick(e);
  const exit = await b.done;
  assert.equal(exit.code, 0, b.out + b.err);
  assert.equal(markers(e, 'phase1-').length, 1, 'phase1 ran exactly once');
  const r = b.result();
  assert.equal(r.launched || 0, 0, 'the second tick adopted, it did not launch');
  const st = H.readJson(e.files.state);
  assert.equal(st.recentRuns.length, 1);
  assert.equal(st.recentRuns[0].exitCode, 0);
  assert.equal(st.handledRunNonce, rec.nonce);
  assert.equal(fs.existsSync(e.files.tickLock), false);
  assert.equal(fs.existsSync(e.files.run), false);
});

test('kill -9 of the RUNNER mid-run: phase1 keeps going and still blocks a second run; the crash is reported once it ends', { skip: SKIP, timeout: 90000 }, async (t) => {
  const e = mkE2E(t, { sleepMs: 4000 }, 2);
  let pids = [];
  cleanup(t, () => pids);
  const a = startTick(e);
  const rec = await H.waitFor(() => { const r = runRecord(e); return r && r.childPid ? r : null; }, 15000);
  assert.ok(rec, a.out + a.err);
  pids = [rec.pid, rec.childPid];
  process.kill(rec.pid, 'SIGKILL');
  a.child.kill('SIGKILL');
  await a.done;
  assert.equal(await H.waitFor(() => !H.pidExists(rec.pid), 5000), true);
  assert.equal(H.pidExists(rec.childPid), true, 'orphaned phase1 still running');
  assert.equal(tick.busyState({ home: e.home }).busy, true);
  assert.equal(tick.busyState({ home: e.home }).kind, 'child');

  const b = startTick(e);
  const exit = await b.done;
  assert.equal(exit.code, 0, b.out + b.err);
  assert.equal(markers(e, 'phase1-').length, 1, 'no second run started while the orphan was alive');
  const keys = alertsOf(e).map((x) => x.key);
  assert.ok(keys.includes('runner-crashed'), `crash reported: ${keys}`);
  assert.equal(fs.existsSync(e.files.run), false, 'run record cleaned');
  assert.equal(b.result().reason, 'launch-backoff', 'no immediate relaunch after a crash');
});

test('kill -9 of everything mid-run: the orphaned status file is released and nothing runs twice', { skip: SKIP, timeout: 90000 }, async (t) => {
  const e = mkE2E(t, { sleepMs: 30000 });
  let pids = [];
  cleanup(t, () => pids);
  const a = startTick(e);
  const rec = await H.waitFor(() => { const r = runRecord(e); return r && r.childPid ? r : null; }, 15000);
  assert.ok(rec, a.out + a.err);
  pids = [rec.pid, rec.childPid];
  const statusBefore = fs.readdirSync(e.files.runs).filter((f) => f.startsWith('phase1-') && f.endsWith('.json'));
  assert.equal(statusBefore.length, 1);
  assert.equal(await H.waitFor(() => H.readJson(path.join(e.files.runs, statusBefore[0]), {}).status === 'phase1_running', 8000), true, 'phase1 reached phase1_running before the kill');
  for (const p of [rec.childPid, rec.pid]) process.kill(p, 'SIGKILL');
  a.child.kill('SIGKILL');
  await a.done;
  assert.equal(await H.waitFor(() => !H.pidExists(rec.pid) && !H.pidExists(rec.childPid), 5000), true);

  const b = startTick(e);
  await b.done;
  assert.equal(H.readJson(path.join(e.files.runs, statusBefore[0])).status, 'phase1_abandoned', 'released even though updated seconds ago: no live process');
  assert.equal(markers(e, 'phase1-').length, 1, 'no double run');
  assert.ok(alertsOf(e).some((x) => x.key === 'runner-crashed'));
  assert.equal(fs.existsSync(e.files.run), false);
  assert.equal(fs.existsSync(e.files.tickLock), false);

  // after the 60 s launch back-off the territory is offered again (its pending claim is 10 min old in real life)
  const st = H.readJson(e.files.state);
  assert.ok(st.launchNotBefore > Date.now(), 'relaunch is paced');
});

test('SIGTERM to the tick: prompt exit, lock released, the run continues and is adopted later', { skip: SKIP, timeout: 90000 }, async (t) => {
  const e = mkE2E(t, { sleepMs: 3500 });
  let pids = [];
  cleanup(t, () => pids);
  const a = startTick(e);
  const rec = await H.waitFor(() => { const r = runRecord(e); return r && r.childPid ? r : null; }, 15000);
  assert.ok(rec, a.out + a.err);
  pids = [rec.pid, rec.childPid];
  const t0 = Date.now();
  a.child.kill('SIGTERM');
  const exit = await a.done;
  assert.ok(Date.now() - t0 < 4000, 'exits promptly');
  assert.equal(exit.code, 0);
  assert.equal(a.result().reason, 'signal');
  assert.equal(fs.existsSync(e.files.tickLock), false, 'lock released by a terminated tick');
  assert.equal(H.pidExists(rec.pid), true, 'the runner is not touched');
  const b = startTick(e);
  await b.done;
  assert.equal(markers(e, 'phase1-').length, 1);
  assert.equal(H.readJson(e.files.state).recentRuns.at(-1).exitCode, 0);
});

test('a second tick while one is supervising exits at once with a note (PID lock), both directions', { skip: SKIP, timeout: 90000 }, async (t) => {
  const e = mkE2E(t, { sleepMs: 3000 });
  const a = startTick(e);
  await H.waitFor(() => { const r = runRecord(e); return r && r.childPid; }, 15000);
  const b = startTick(e);
  const exit = await b.done;
  assert.equal(exit.code, 0);
  assert.equal(b.result().reason, 'overlap');
  assert.match(b.out, /tick already running/);
  await a.done;
  assert.equal(markers(e, 'phase1-').length, 1);
});

test('a stale tick lock from a dead process is taken over without delay', { skip: SKIP, timeout: 60000 }, async (t) => {
  const e = mkE2E(t, { sleepMs: 300 });
  H.writeJson(e.files.tickLock, { pid: H.deadPid(), nonce: 'ghost', startedAt: new Date().toISOString() });
  const tk = startTick(e);
  const exit = await tk.done;
  assert.equal(exit.code, 0, tk.out + tk.err);
  assert.equal(markers(e, 'phase1-').length, 1);
});

test('halt end to end with the real halt module: a dead screening service holds the queue, recovery resumes it', { skip: SKIP, timeout: 90000 }, async (t) => {
  const e = mkE2E(t, { sleepMs: 300 });
  H.setCtl(e.home, 'screening', { ok: false, reason: 'screening gateway unreachable' });
  let tk = startTick(e);
  await tk.done;
  assert.equal(tk.result().reason, 'probe-miss');
  assert.equal(markers(e, 'phase1-').length, 0);
  tk = startTick(e);
  await tk.done;
  assert.equal(tk.result().reason, 'halted');
  const halt = H.readJson(path.join(e.home, 'runtime', 'pipeline-halt.json'));
  assert.equal(halt.halted, true);
  assert.equal(halt.reason, 'screening gateway unreachable');
  assert.equal(halt.blockedRuns, 1);
  assert.equal(markers(e, 'phase1-').length, 0, 'the territory was not started, so it is not burned');
  assert.ok(alertsOf(e).some((a) => a.key === 'pipeline-halt' && a.severity === 'critical'));

  H.setCtl(e.home, 'screening', { ok: true });
  tk = startTick(e);
  await tk.done;
  assert.equal(fs.existsSync(path.join(e.home, 'runtime', 'pipeline-halt.json')), false, 'halt cleared by the deep probe');
  assert.equal(markers(e, 'phase1-').length, 1, 'and the queue resumed in the same tick');
  assert.ok(alertsOf(e).some((a) => a.key === 'pipeline-halt' && a.severity === 'info'), 'the resume was announced');
  const errs = H.readLines(path.join(e.home, 'logs', 'errors.jsonl')).map((x) => x.context);
  assert.deepEqual(errs, ['pipeline_halted', 'pipeline_resumed']);
});

test('session blocked end to end: exit 11, 15-minute back-off, no scrape started, the login module owns the alert', { skip: SKIP, timeout: 90000 }, async (t) => {
  const e = mkE2E(t, { sleepMs: 300 });
  H.setCtl(e.home, 'session', { state: 'safelist' });
  let tk = startTick(e);
  await tk.done;
  assert.equal(markers(e, 'phase1-').length, 0, 'phase1 never started');
  assert.equal(alertsOf(e).some((x) => x.key === 'caterer-session'), false, 'no second alert: the real login module raises and rate-limits its own');
  assert.equal(H.readJson(path.join(e.home, 'runtime', 'caterer-status.json')).state, 'safelist_blocked');
  const st = H.readJson(e.files.state);
  assert.ok(st.staleCooldownUntil > Date.now() + 14 * 60000 - 60000 && st.staleCooldownUntil < Date.now() + 15 * 60000 + 5000, 'about 15 minutes ahead');
  assert.equal(tk.result().reason, 'cooldown');
  const orphan = fs.readdirSync(e.files.runs).filter((f) => f.startsWith('phase1-') && f.endsWith('.json'));
  assert.equal(orphan.length, 1);
  assert.equal(H.readJson(path.join(e.files.runs, orphan[0])).status, 'phase1_abandoned', 'the init file left by the aborted run is released at once, so the gate is not locked');
  assert.equal(H.readJson(path.join(e.home, 'pending-searches', 'territory-1-20260929-1000.json')).spawnedAt, undefined, 'the claim is released: the tick back-off holds the territory, and --clear-cooldown resumes it at once');

  tk = startTick(e);
  await tk.done;
  assert.equal(tk.result().reason, 'cooldown', 'a fresh tick still honours the persisted back-off');
  assert.equal(markers(e, 'phase1-').length, 0);
});

test('stranded phase 2 recovery: the recovered child is adopted and blocks a new launch until it ends', { skip: SKIP, timeout: 90000 }, async (t) => {
  const e = mkE2E(t, { sleepMs: 300 });
  const old = new Date(Date.now() - 20 * 60000).toISOString();
  H.writeJson(path.join(e.files.runs, 'phase1-2026-09-29-0800.json'), {
    id: 'phase1-2026-09-29-0800', status: 'phase1_complete', phase2Status: 'pending', sources: 'caterer',
    jobTitle: 'Chef', location: 'ZZ9', startedAt: old, updatedAt: old,
  });
  H.writeJson(path.join(e.home, 'downloads', 'approved-queue-2026-09-29-0800.json'), { candidates: [] });
  const tk = startTick(e);
  await H.waitFor(() => markers(e, 'recovery-').length === 1, 20000);
  const adopted = tick.readAdopted(e.files);
  assert.equal(adopted.length, 1, 'recovered child registered');
  assert.equal(adopted[0].mode, 'process-approved-queue');
  await tk.done;
  const m = markers(e, 'phase1-');
  const rec = markers(e, 'recovery-');
  assert.equal(rec.length, 1);
  if (m.length) assert.ok(m[0].start >= rec[0].start + 3500, 'a new run only started after the recovery child ended (4 s)');
});

test('the wrapper contract: exit codes of the CLI (--status works with nothing running; unknown flags exit 2)', { timeout: 30000 }, async (t) => {
  const e = mkE2E(t);
  const { spawnSync } = require('child_process');
  const st = spawnSync(process.execPath, [path.join(e.home, 'scripts', 'pipeline-watchdog.js'), '--status'], { cwd: e.home, env: { ...process.env, RESOURCER_HOME: e.home }, encoding: 'utf8' });
  assert.equal(st.status, 0, st.stderr);
  const rep = JSON.parse(st.stdout);
  assert.equal(rep.busy, false);
  assert.equal(rep.queueDepth, 1);
  const bad = spawnSync(process.execPath, [path.join(e.home, 'scripts', 'pipeline-watchdog.js'), '--nonsense'], { cwd: e.home, env: { ...process.env, RESOURCER_HOME: e.home }, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  const none = spawnSync(process.execPath, [path.join(e.home, 'scripts', 'pipeline-watchdog.js')], { cwd: e.home, env: { ...process.env, RESOURCER_HOME: e.home }, encoding: 'utf8' });
  assert.equal(none.status, 2);
  const help = spawnSync(process.execPath, [path.join(e.home, 'scripts', 'pipeline-watchdog.js'), '--help'], { cwd: e.home, env: { ...process.env, RESOURCER_HOME: e.home }, encoding: 'utf8' });
  assert.equal(help.status, 0);
});

test('--clear-cooldown drops the exit-11 back-off and the launch back-off', { timeout: 30000 }, async (t) => {
  const e = mkE2E(t);
  const { spawnSync } = require('child_process');
  H.writeJson(e.files.state, { staleCooldownUntil: Date.now() + 600000, launchNotBefore: Date.now() + 60000, consecutiveFailures: 2 });
  const r = spawnSync(process.execPath, [path.join(e.home, 'scripts', 'pipeline-watchdog.js'), '--clear-cooldown'], { cwd: e.home, env: { ...process.env, RESOURCER_HOME: e.home }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  const st = H.readJson(e.files.state);
  assert.equal(st.staleCooldownUntil, 0);
  assert.equal(st.launchNotBefore, 0);
  assert.equal(st.consecutiveFailures, 2, 'only the back-offs are cleared');
});

test('--queue-due through the real CLI: runs the queue script under its lock, paced, and exits 0 (1 on failure)', { timeout: 30000 }, async (t) => {
  const e = mkE2E(t);
  const { spawnSync } = require('child_process');
  const run = () => spawnSync(process.execPath, [path.join(e.home, 'scripts', 'pipeline-watchdog.js'), '--queue-due'], { cwd: e.home, env: { ...process.env, RESOURCER_HOME: e.home }, encoding: 'utf8' });
  let r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(e.home, 'markers', 'queue-due.calls'), 'utf8').trim().split('\n').length, 1);
  r = run();
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(path.join(e.home, 'markers', 'queue-due.calls'), 'utf8').trim().split('\n').length, 1, 'a second call inside 4.5 minutes is paced away');
  H.writeJson(path.join(e.home, 'runtime', 'queue-due-state.json'), { lastAt: 0 });
  H.setCtl(e.home, 'queue-due', { fail: true });
  r = run();
  assert.equal(r.status, 1, 'a failing queue script makes the cron job report failure');
});

test('phase1 exit 2 end to end: the tick raises the session alert itself and backs off', { skip: SKIP, timeout: 90000 }, async (t) => {
  const e = mkE2E(t, { sleepMs: 200, exit: 2 });
  const tk = startTick(e);
  await tk.done;
  const a = alertsOf(e).find((x) => x.key === 'caterer-session');
  assert.ok(a, 'the login module was not involved, so the tick alerts');
  assert.equal(a.severity, 'critical');
  assert.match(a.text, /went stale/);
  assert.equal(tk.result().reason, 'cooldown');
  assert.equal(H.readJson(path.join(e.home, 'runtime', 'caterer-status.json')).state, 'stale');
});

test('source gate end to end: a both-territory is rewritten to caterer before anything reads it', { skip: SKIP, timeout: 90000 }, async (t) => {
  const e = mkE2E(t, { sleepMs: 200 });
  const f = path.join(e.home, 'pending-searches', 'territory-1-20260929-1000.json');
  H.pendingFile(e.home, 'territory-1-20260929-1000.json', { sources: 'both', location: 'AB1' });
  const tk = startTick(e);
  await tk.done;
  const p = H.readJson(f);
  assert.equal(p.sources, 'caterer');
  assert.equal(p.sourcesRequested, 'both');
  assert.ok(p.spawnedAt, 'claimed after the rewrite');
  const m = markers(e, 'phase1-');
  assert.equal(m.length, 1);
  assert.equal(m[0].sources, 'caterer');
  const status = fs.readdirSync(e.files.runs).filter((n) => n.startsWith('phase1-') && n.endsWith('.json'));
  assert.equal(H.readJson(path.join(e.files.runs, status[0])).sources, 'caterer', 'init status agrees with the pending file');
});

// --- CV Database module error and browser.lock, end to end ---------------------------------------

test('CV Database module error end to end: no phase1, exit 11 cvdb-module, 15-minute back-off, no duplicate alert, browser lock released', { skip: SKIP, timeout: 90000 }, async (t) => {
  const e = mkE2E(t, { sleepMs: 300 }, 2);
  H.setCtl(e.home, 'session', { state: 'moduleerror' });
  const tk = startTick(e);
  const exit = await tk.done;
  assert.equal(exit.code, 0, tk.out + tk.err);
  assert.equal(markers(e, 'phase1-').length, 0, 'phase1 never started against the failing module');
  assert.equal(tk.result().reason, 'cooldown');
  const last = H.readJson(e.files.lastRun);
  assert.equal(last.exitCode, 11);
  assert.equal(last.reason, 'cvdb-module');
  const st = H.readJson(e.files.state);
  assert.ok(st.staleCooldownUntil > Date.now() + 10 * 60000, 'backs off about 15 minutes');
  assert.equal(alertsOf(e).some((x) => x.key === 'caterer-session'), false, 'the login module owns the alert for this reason');
  const status = H.readJson(path.join(e.home, 'runtime', 'caterer-status.json'));
  assert.equal(status.state, 'stale');
  assert.equal(status.detail, 'CV Database module error');
  assert.equal(fs.existsSync(path.join(e.home, 'runtime', 'browser.lock')), false, 'the lock is not left behind');
  const events = H.readLines(path.join(e.home, 'logs', 'watchdog-runner.jsonl')).map((l) => l.event);
  assert.ok(events.includes('session-dead'));
  assert.equal(events.includes('phase1-start'), false);
});

test('kill -9 of the runner leaves browser.lock behind; a stale holder is taken over by the next runner and nothing overlaps', { skip: SKIP, timeout: 90000 }, async (t) => {
  const e = mkE2E(t, { sleepMs: 1500 }, 2);
  const lockFile = path.join(e.home, 'runtime', 'browser.lock');
  let pids = [];
  cleanup(t, () => pids);
  const a = startTick(e);
  const rec = await H.waitFor(() => { const r = runRecord(e); return r && r.childPid ? r : null; }, 15000);
  assert.ok(rec, a.out + a.err);
  pids = [rec.pid, rec.childPid];
  assert.equal(H.readJson(lockFile).pid, rec.pid, 'the runner holds the lock while phase1 runs');
  process.kill(rec.pid, 'SIGKILL');
  a.child.kill('SIGKILL');
  await a.done;
  assert.equal(await H.waitFor(() => !H.pidExists(rec.pid), 5000), true);
  assert.equal(H.readJson(lockFile).pid, rec.pid, 'a killed runner cannot release it');
  assert.equal(await H.waitFor(() => !H.pidExists(rec.childPid), 10000), true, 'phase1 of the killed runner ends by itself');

  const b = startTick(e);
  await b.done;
  const st = H.readJson(e.files.state);
  st.launchNotBefore = 0;
  H.writeJson(e.files.state, st);
  const c = startTick(e);
  const exit = await c.done;
  assert.equal(exit.code, 0, c.out + c.err);
  const m = markers(e, 'phase1-');
  assert.equal(m.length, 3, 'the killed territory is retried (its claim was given back) and the second territory ran');
  for (let i = 1; i < m.length; i += 1) assert.ok(m[i].start >= m[i - 1].end, 'each run only after the previous one ended');
  for (const later of m.slice(1)) {
    assert.equal(later.browserLock.owner, 'caterer');
    assert.notEqual(later.browserLock.pid, rec.pid, 'the new runner replaced the dead holder');
    assert.equal(later.holderPid, String(later.browserLock.pid));
  }
  assert.equal(fs.existsSync(lockFile), false, 'released after the second run');
});

test('a live foreign browser.lock holder keeps the tick from starting a Caterer run (exit 10 paced by the launch back-off), and the run starts once it lets go', { skip: SKIP, timeout: 90000 }, async (t) => {
  const e = mkE2E(t, { sleepMs: 300 });
  const lockFile = path.join(e.home, 'runtime', 'browser.lock');
  const other = H.sleeper(t);
  H.writeJson(lockFile, { owner: 'reed', pid: other.pid, startedAt: new Date().toISOString(), purpose: 'reed-phase1' });
  const a = startTick(e, {}, {}, { RESOURCER_BROWSER_LOCK_WAIT_MS: '0' });
  await a.done;
  assert.equal(markers(e, 'phase1-').length, 0);
  assert.equal(H.readJson(e.home + '/pending-searches/territory-1-20260929-1000.json').spawnedAt, undefined, 'the territory stays unclaimed');
  assert.ok(H.readJson(e.files.state).launchNotBefore > Date.now(), 'paced like any exit 10');
  other.kill();
  assert.equal(await H.waitFor(() => !H.pidExists(other.pid), 5000), true);
  const st = H.readJson(e.files.state);
  st.launchNotBefore = 0;
  H.writeJson(e.files.state, st);
  const b = startTick(e, {}, {}, { RESOURCER_BROWSER_LOCK_WAIT_MS: '0' });
  await b.done;
  assert.equal(markers(e, 'phase1-').length, 1);
});
