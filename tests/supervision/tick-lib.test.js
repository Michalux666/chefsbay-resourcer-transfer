'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./_helpers');

H.installNetworkGuard();
const HOME0 = H.mkHome(null, 'ticklib-base');
process.env.RESOURCER_HOME = HOME0;
const tick = require(path.join(H.SRC_SCRIPTS, 'lib', 'tick.js'));

function ageFile(file, ms) {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(file, t, t);
}

test('acquire, second acquire fails with holder, release frees it', (t) => {
  const dir = H.mkHome(t, 'lock');
  const file = path.join(dir, 'runtime', 't.lock');
  const a = tick.acquireLock(file, { info: { role: 'test' } });
  assert.equal(a.ok, true);
  const b = tick.acquireLock(file);
  assert.equal(b.ok, false);
  assert.equal(b.holder.pid, process.pid);
  assert.equal(b.holder.role, 'test');
  assert.equal(a.release(), true);
  assert.equal(fs.existsSync(file), false);
  const c = tick.acquireLock(file);
  assert.equal(c.ok, true);
  c.release();
});

test('a lock owned by a dead pid is stale and is taken over', (t) => {
  const dir = H.mkHome(t, 'lock');
  const file = path.join(dir, 'runtime', 't.lock');
  H.writeJson(file, { pid: H.deadPid(), nonce: 'old', startedAt: new Date().toISOString() });
  const a = tick.acquireLock(file);
  assert.equal(a.ok, true, 'must steal a dead owner');
  assert.notEqual(tick.readRecord(file).rec.nonce, 'old');
  a.release();
});

test('a recycled pid (token mismatch) is not treated as the owner', { skip: !H.IS_LINUX && 'needs /proc identity' }, (t) => {
  const dir = H.mkHome(t, 'lock');
  const file = path.join(dir, 'runtime', 't.lock');
  H.writeJson(file, { pid: process.pid, token: 'other-boot:1', nonce: 'old' });
  const a = tick.acquireLock(file);
  assert.equal(a.ok, true, 'same pid but a different start time means the record is stale');
  a.release();
});

test('procToken is stable for a live process and differs between processes', { skip: !H.IS_LINUX && 'needs /proc identity' }, (t) => {
  const s = H.sleeper(t);
  const a = tick.procToken(process.pid);
  assert.equal(a, tick.procToken(process.pid));
  assert.ok(a && a.includes(':'));
  assert.notEqual(tick.procToken(s.pid), a);
});

test('heartbeat-stale live owner: stolen when allowed, kept when not', (t) => {
  const dir = H.mkHome(t, 'lock');
  const file = path.join(dir, 'runtime', 't.lock');
  const owner = tick.acquireLock(file);
  assert.equal(owner.ok, true);
  ageFile(file, 30 * 60000);
  if (H.IS_LINUX) {
    // With /proc identity the owner is provably alive; without it a stale heartbeat is the only
    // guard against a recycled pid, so this half of the rule is Linux-only.
    const keep = tick.acquireLock(file, { stealOnHeartbeatStale: false, staleMs: 60000 });
    assert.equal(keep.ok, false, 'a live run record must never be stolen for a stale heartbeat');
  }
  const steal = tick.acquireLock(file, { staleMs: 60000 });
  assert.equal(steal.ok, true, 'a frozen tick lock is taken over');
  assert.equal(owner.stillOwner(), false, 'the old owner must notice the loss');
  assert.equal(owner.heartbeat(), false);
  assert.equal(owner.release(), false, 'the old owner must not delete the new owner lock');
  assert.equal(fs.existsSync(file), true);
  steal.release();
});

test('heartbeat() refreshes the mtime and keeps the lock fresh', (t) => {
  const dir = H.mkHome(t, 'lock');
  const file = path.join(dir, 'runtime', 't.lock');
  const a = tick.acquireLock(file);
  ageFile(file, 5 * 60000);
  const before = fs.statSync(file).mtimeMs;
  assert.equal(a.heartbeat(), true);
  assert.ok(fs.statSync(file).mtimeMs > before + 60000);
  assert.equal(tick.acquireLock(file, { staleMs: 60000 }).ok, false);
  a.release();
});

test('empty lock file: young is held (writer mid-create), old is stale', (t) => {
  const dir = H.mkHome(t, 'lock');
  const file = path.join(dir, 'runtime', 't.lock');
  fs.writeFileSync(file, '');
  assert.equal(tick.acquireLock(file).ok, false);
  ageFile(file, tick.INIT_GRACE_MS + 5000);
  const a = tick.acquireLock(file);
  assert.equal(a.ok, true);
  a.release();
});

test('an unreadable record is never stolen (fail safe)', { skip: (H.IS_WIN || (process.getuid && process.getuid() === 0)) && 'needs permission bits and a non-root user' }, (t) => {
  const dir = H.mkHome(t, 'lock');
  const file = path.join(dir, 'runtime', 't.lock');
  H.writeJson(file, { pid: H.deadPid(), nonce: 'x' });
  fs.chmodSync(file, 0o000);
  const a = tick.acquireLock(file);
  fs.chmodSync(file, 0o600);
  assert.equal(a.ok, false);
});

test('update() only works for the owner nonce and keeps other fields', (t) => {
  const dir = H.mkHome(t, 'lock');
  const file = path.join(dir, 'runtime', 'run.json');
  const a = tick.acquireLock(file, { info: { role: 'runner', file: 'x.json' } });
  assert.equal(a.update({ childPid: 123 }), true);
  const rec = tick.readRecord(file).rec;
  assert.equal(rec.childPid, 123);
  assert.equal(rec.file, 'x.json');
  assert.equal(tick.updateRecord(file, 'not-the-nonce', { childPid: 1 }), false);
  a.release();
});

test('many processes racing for one stale lock: exactly one wins, every round', { skip: !H.IS_LINUX && 'process race test runs on Linux (WSL)', timeout: 120000 }, async (t) => {
  const dir = H.mkHome(t, 'race');
  const file = path.join(dir, 'runtime', 'race.lock');
  const script = path.join(dir, 'racer.js');
  fs.writeFileSync(script, `
const tick = require(${JSON.stringify(path.join(H.SRC_SCRIPTS, 'lib', 'tick.js'))});
const [file, goAt] = [process.argv[2], Number(process.argv[3])];
while (Date.now() < goAt) {}
const r = tick.acquireLock(file);
console.log(r.ok ? 'WON' : 'LOST');
if (r.ok) setTimeout(() => process.exit(0), 400);
`);
  const N = 6;
  const ROUNDS = 8;
  for (let round = 0; round < ROUNDS; round++) {
    try { fs.unlinkSync(file); } catch { /* none */ }
    H.writeJson(file, { pid: H.deadPid(), nonce: `stale-${round}` });
    const goAt = Date.now() + 700;
    const outs = await Promise.all(Array.from({ length: N }, () => new Promise((resolve) => {
      let out = '';
      const c = spawn(process.execPath, [script, file, String(goAt)], { env: { ...process.env, RESOURCER_HOME: dir } });
      c.stdout.on('data', (d) => { out += d; });
      c.on('close', () => resolve(out.trim()));
    })));
    const winners = outs.filter((o) => o === 'WON').length;
    assert.equal(winners, 1, `round ${round}: ${JSON.stringify(outs)}`);
  }
});

test('killTree ends a process group, and refuses a recycled pid', { skip: !H.IS_LINUX && 'group semantics are checked on Linux (WSL)', timeout: 30000 }, async (t) => {
  const dir = H.mkHome(t, 'kill');
  const script = path.join(dir, 'parent.js');
  fs.writeFileSync(script, `
const { spawn } = require('child_process');
const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
console.log('CHILD ' + c.pid);
setInterval(() => {}, 1000);
`);
  const parent = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  parent.stdout.on('data', (d) => { out += d; });
  const childPid = await H.waitFor(() => { const m = /CHILD (\d+)/.exec(out); return m && Number(m[1]); }, 10000);
  assert.ok(childPid, 'child pid reported');
  assert.equal(await tick.killTree(parent.pid, { token: 'wrong:token', graceMs: 500 }), true, 'a wrong token means the pid is not ours: nothing to do');
  assert.equal(H.pidExists(parent.pid), true, 'a recycled pid must not be signalled');
  const ok = await tick.killTree(parent.pid, { token: tick.procToken(parent.pid), graceMs: 3000 });
  assert.equal(ok, true);
  assert.equal(await H.waitFor(() => !H.pidExists(parent.pid) && !H.pidExists(childPid), 5000), true, 'group members are gone too');
});

test('busyState: live runner, orphaned child, dead record, adopted proc, run-lock', (t) => {
  const home = H.mkHome(t, 'busy');
  const f = tick.runtimeFiles(home);
  assert.equal(tick.busyState({ home }).busy, false);

  const live = H.sleeper(t);
  H.writeJson(f.run, { pid: live.pid, token: tick.procToken(live.pid), nonce: 'n1', startedAt: new Date().toISOString() });
  let b = tick.busyState({ home });
  assert.equal(b.busy, true);
  assert.equal(b.kind, 'runner');
  assert.equal(tick.busyState({ home, ownNonce: 'n1' }).busy, false, 'a caller ignores its own claim');

  H.writeJson(f.run, { pid: H.deadPid(), nonce: 'n2', childPid: live.pid, childToken: tick.procToken(live.pid) });
  b = tick.busyState({ home });
  assert.equal(b.busy, true);
  assert.equal(b.kind, 'child', 'runner dead but its phase1 child alive still counts as a run');

  H.writeJson(f.run, { pid: H.deadPid(), nonce: 'n3', childPid: H.deadPid() });
  assert.equal(tick.busyState({ home }).busy, false, 'both dead: not busy');
  fs.unlinkSync(f.run);

  tick.addAdopted(f, [{ pid: live.pid, id: 'phase1-x', mode: 'run-pipeline' }]);
  b = tick.busyState({ home });
  assert.equal(b.busy, true);
  assert.equal(b.kind, 'adopted');
  fs.unlinkSync(f.adopted);

  fs.writeFileSync(path.join(f.runs, 'phase1-a.json.run-lock'), JSON.stringify({ pid: live.pid, startedAt: Date.now() }));
  b = tick.busyState({ home });
  assert.equal(b.busy, true);
  assert.equal(b.kind, 'run-lock');
  fs.writeFileSync(path.join(f.runs, 'phase1-a.json.run-lock'), JSON.stringify({ pid: live.pid, startedAt: Date.now() - 61 * 60000 }));
  assert.equal(tick.busyState({ home }).busy, false, 'a run-lock older than 60 minutes is stale even if the pid answers');
  fs.writeFileSync(path.join(f.runs, 'phase1-a.json.run-lock'), JSON.stringify({ pid: H.deadPid(), startedAt: Date.now() }));
  assert.equal(tick.busyState({ home }).busy, false);
});

test('inspectRun: corrupt young record counts as initialising, old one as dead', (t) => {
  const home = H.mkHome(t, 'inspect');
  const f = tick.runtimeFiles(home);
  fs.writeFileSync(f.run, '{"pid": 12');
  let i = tick.inspectRun(f.run);
  assert.equal(i.corrupt, true);
  assert.equal(i.alive, true);
  ageFile(f.run, tick.INIT_GRACE_MS + 5000);
  i = tick.inspectRun(f.run);
  assert.equal(i.alive, false);
});

test('addAdopted de-duplicates and drops dead entries', (t) => {
  const home = H.mkHome(t, 'adopt');
  const f = tick.runtimeFiles(home);
  const live = H.sleeper(t);
  tick.addAdopted(f, [{ pid: live.pid, id: 'a' }, { pid: live.pid, id: 'a' }, { pid: H.deadPid(), id: 'dead' }]);
  let list = tick.readAdopted(f);
  assert.equal(list.length, 2);
  tick.addAdopted(f, [{ pid: live.pid, id: 'a' }]);
  list = tick.readAdopted(f);
  assert.equal(list.filter((e) => e.pid === live.pid).length, 1);
  assert.equal(list.some((e) => e.id === 'dead'), false, 'dead entries are pruned when the registry is rewritten');
});
