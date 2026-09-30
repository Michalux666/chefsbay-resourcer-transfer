'use strict';
// The hard cap with real processes: a real tick driver, the real runner and a fake phase 1 that never ends in time. The driver's
// clock is skewed (wall and monotonic together, and no frozen-time detection) so the 56 minutes pass in a second. What the real
// runner writes when its phase 1 child is ended is the fact the tick's accounting depends on. Runs on Linux (WSL).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./_helpers');

H.installNetworkGuard();
const SKIP = !H.IS_LINUX && 'process-kill semantics are verified on Linux (WSL)';
process.env.RESOURCER_HOME = H.mkHome(null, 'drainreal');
const tick = require(path.join(H.SRC_SCRIPTS, 'lib', 'tick.js'));

const DRIVER = `
const path = require('path');
const fs = require('fs');
const home = process.env.RESOURCER_HOME;
const wd = require(path.join(home, 'scripts', 'pipeline-watchdog.js'));
const skew = () => { try { return JSON.parse(fs.readFileSync(path.join(home, 'ctl', 'skew.json'), 'utf8')).ms || 0; } catch { return 0; } };
const mono = () => Number(process.hrtime.bigint() / 1000000n);
const ctx = wd.makeCtx({
  home, inWindow: () => true, slowChecks: async () => {}, diskGuard: () => ({}), heartbeatGraceMs: 200, clockJumpMs: 1e12,
  now: () => Date.now() + skew(), mono: () => mono() + skew(), log: (m, l) => console.log((l || 'info') + ': ' + m),
});
wd.runTick(ctx, { maxMinutes: 55, superviseMs: 250 }).then((r) => {
  console.log('TICK_RESULT ' + JSON.stringify({ reason: r.reason, iterations: r.iterations, launched: r.launched, exitCode: r.exitCode }));
  process.exit(r.exitCode);
}, (e) => { console.error(e); process.exit(99); });
`;

function mkWorld(t, phase1Ctl) {
  const home = H.mkHome(t, 'drainreal', { db: true });
  H.installScripts(home);
  fs.writeFileSync(path.join(home, 'driver.js'), DRIVER);
  H.setCtl(home, 'phase1', phase1Ctl);
  H.pendingFile(home, 'territory-1-20260929-1000.json', { location: 'AB1', sources: 'caterer' });
  return { home, files: tick.runtimeFiles(home), pending: path.join(home, 'pending-searches', 'territory-1-20260929-1000.json') };
}

function startTick(e) {
  const c = spawn(process.execPath, [path.join(e.home, 'driver.js')], {
    cwd: e.home, env: { ...process.env, RESOURCER_HOME: e.home, RESOURCER_SETTLE_MS: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const h = { child: c, out: '', err: '' };
  c.stdout.on('data', (d) => { h.out += d; });
  c.stderr.on('data', (d) => { h.err += d; });
  h.done = new Promise((resolve) => c.on('close', (code, sig) => resolve({ code, sig })));
  h.result = () => { const m = /TICK_RESULT (.*)/.exec(h.out); return m ? JSON.parse(m[1]) : null; };
  return h;
}

test('a run still going at the hard cap is ended by the real tick: the real runner reports a plain phase 1 failure, the tick records tick-hard-cap, the claim stays, nothing is left behind', { skip: SKIP, timeout: 90000 }, async (t) => {
  const e = mkWorld(t, { sleepMs: 120000, grandchild: true });
  let pids = [];
  t.after(() => { for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } });
  const tk = startTick(e);
  const rec = await H.waitFor(() => { const r = H.readJson(e.files.run, null); return r && r.childPid ? r : null; }, 30000);
  assert.ok(rec, `run registered: ${tk.out}${tk.err}`);
  const grandchild = await H.waitFor(() => { try { return Number(fs.readFileSync(path.join(e.home, 'markers', 'grandchild.pid'), 'utf8')); } catch { return 0; } }, 15000);
  pids = [rec.pid, rec.childPid, grandchild].filter(Boolean);
  assert.equal(pids.length, 3, 'runner, phase 1 and its helper are running');
  assert.ok(H.readJson(e.pending).spawnedAt, 'the launch stamped the claim');

  H.writeJson(path.join(e.home, 'ctl', 'skew.json'), { ms: 57 * 60000 });
  const exit = await tk.done;
  assert.equal(exit.code, 0, tk.out + tk.err);
  assert.equal(tk.result().reason, 'tick-hard-cap', tk.out);
  assert.match(tk.out, /CRITICAL run \S+ is still in flight at the 56-minute tick limit/);

  for (const p of pids) assert.equal(await H.waitFor(() => !H.pidExists(p), 8000), true, `pid ${p} is gone`);
  const own = H.readJson(path.join(e.home, 'runtime', 'last-run.json'));
  assert.equal(own.exitCode, 12, 'the runner saw only a phase 1 child that died from a signal');
  assert.equal(own.reason, 'phase1-exit-null');
  const st = H.readJson(e.files.state);
  assert.equal(st.recentRuns.length, 1);
  assert.equal(st.recentRuns[0].exitCode, 13);
  assert.equal(st.recentRuns[0].reason, 'tick-hard-cap', 'the tick knows why it ended the run');
  assert.deepEqual(st.killedNonces, {});
  assert.equal(st.handledRunNonce, rec.nonce);
  assert.ok(H.readJson(e.pending).spawnedAt, 'the claim is still stamped: the gate rotates to the next territory');
  assert.equal(H.readJson(e.pending).failedRuns, undefined);
  assert.equal(fs.existsSync(e.files.run), false, 'run record cleaned');
  assert.equal(fs.existsSync(e.files.tickLock), false, 'tick lock released');
  assert.equal(fs.existsSync(path.join(e.home, 'runtime', 'browser.lock')), false, 'browser lock released');
  const keys = H.readLines(path.join(e.home, 'outbox', 'alerts.jsonl')).map((a) => a.key);
  assert.deepEqual(keys, ['tick-hard-cap']);
  assert.equal(tick.busyState({ home: e.home }).busy, false);
});
