'use strict';

// browser.lock protocol: exclusive create, liveness, staleness, hand-off to an ancestor, CLI gate.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(process.env.REED_TEST_TMP || os.tmpdir(), 'reedlock-'));
process.env.RESOURCER_HOME = TMP;
process.env.HERMES_HOME = path.join(TMP, 'hh');
process.env.RESOURCER_ENV_FILE = path.join(TMP, 'none.env');
const SCRIPT = path.resolve(__dirname, '..', '..', 'resourcer', 'scripts', 'ensure-chrome-cdp.js');
const launcher = require(SCRIPT);
const lock = launcher.browserLock;
const LOCK_FILE = lock.file();

function sleeper() {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  return c;
}
function writeLock(rec) {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  fs.writeFileSync(LOCK_FILE, JSON.stringify(rec));
}
function clear() { try { fs.unlinkSync(LOCK_FILE); } catch { /* none */ } }

test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });
test.beforeEach(clear);

test('acquire on a free lock writes owner/pid and release removes it', () => {
  const r = lock.acquire('reed', { purpose: 't' });
  assert.strictEqual(r.acquired, true);
  const rec = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  assert.strictEqual(rec.owner, 'reed');
  assert.strictEqual(rec.pid, process.pid);
  assert.strictEqual(rec.purpose, 't');
  r.release();
  assert.strictEqual(fs.existsSync(LOCK_FILE), false);
});

test('a second acquire in the same process is re-entrant and does not release the first', () => {
  const a = lock.acquire('reed');
  const b = lock.acquire('reed');
  assert.strictEqual(b.acquired, true);
  assert.strictEqual(b.reentrant, true);
  b.release();
  assert.strictEqual(fs.existsSync(LOCK_FILE), true);
  a.release();
  assert.strictEqual(fs.existsSync(LOCK_FILE), false);
});

test('a live foreign holder blocks acquisition and blocks the Reed browser when it is a Caterer run', () => {
  const child = sleeper();
  try {
    writeLock({ owner: 'caterer', pid: child.pid, startedAt: new Date().toISOString() });
    const r = lock.acquire('reed');
    assert.strictEqual(r.acquired, false);
    assert.strictEqual(r.holder.owner, 'caterer');
    assert.strictEqual(lock.reedMayUse().ok, false);
  } finally { child.kill(); }
});

test('a live foreign Reed holder blocks acquire but does not block Reed browser use', () => {
  const child = sleeper();
  try {
    writeLock({ owner: 'reed', pid: child.pid, startedAt: new Date().toISOString() });
    assert.strictEqual(lock.acquire('reed').acquired, false);
    assert.strictEqual(lock.reedMayUse().ok, true);
  } finally { child.kill(); }
});

test('a dead holder is taken over', () => {
  const dead = spawnSync(process.execPath, ['-e', '0']);
  assert.ok(dead.pid);
  writeLock({ owner: 'caterer', pid: dead.pid, startedAt: new Date().toISOString() });
  const r = lock.acquire('reed');
  assert.strictEqual(r.acquired, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')).pid, process.pid);
  r.release();
});

test('a live holder older than the max age is treated as stale', () => {
  const child = sleeper();
  try {
    writeLock({ owner: 'caterer', pid: child.pid, startedAt: new Date(Date.now() - 5 * 3600 * 1000).toISOString() });
    const r = lock.acquire('reed');
    assert.strictEqual(r.acquired, true);
    r.release();
  } finally { child.kill(); }
});

test('release never deletes a lock owned by another pid', () => {
  const child = sleeper();
  try {
    writeLock({ owner: 'caterer', pid: child.pid, startedAt: new Date().toISOString() });
    lock.release();
    assert.strictEqual(fs.existsSync(LOCK_FILE), true);
  } finally { child.kill(); }
});

test('a lock held by an ancestor process is borrowed (run-pipeline hand-off), release is a no-op', () => {
  writeLock({ owner: 'reed', pid: process.pid, startedAt: new Date().toISOString() });
  const code = `
    const l = require(${JSON.stringify(SCRIPT)}).browserLock;
    const r = l.acquire('reed');
    process.stdout.write(JSON.stringify({ acquired: r.acquired, borrowed: r.borrowed }));
    r.release();
  `;
  const res = spawnSync(process.execPath, ['-e', code], { env: { ...process.env } });
  assert.deepStrictEqual(JSON.parse(res.stdout.toString()), { acquired: true, borrowed: true });
  assert.strictEqual(fs.existsSync(LOCK_FILE), true, 'child release must not remove the parent lock');
});

test('RESOURCER_BROWSER_LOCK_HOLDER_PID marks an unrelated live pid as the hand-off holder', () => {
  const child = sleeper();
  try {
    writeLock({ owner: 'reed', pid: child.pid, startedAt: new Date().toISOString() });
    const code = `
      const l = require(${JSON.stringify(SCRIPT)}).browserLock;
      const r = l.acquire('reed');
      process.stdout.write(JSON.stringify({ acquired: r.acquired, borrowed: !!r.borrowed }));
    `;
    const res = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, RESOURCER_BROWSER_LOCK_HOLDER_PID: String(child.pid) } });
    assert.deepStrictEqual(JSON.parse(res.stdout.toString()), { acquired: true, borrowed: true });
  } finally { child.kill(); }
});

test('wait() acquires once the holder goes away', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600)'], { stdio: 'ignore' });
  writeLock({ owner: 'caterer', pid: child.pid, startedAt: new Date().toISOString() });
  const t0 = Date.now();
  const r = await lock.wait('reed', { waitMs: 8000, pollMs: 100 });
  assert.strictEqual(r.acquired, true);
  assert.ok(Date.now() - t0 >= 300, 'should have waited for the holder');
  r.release();
});

test('wait() gives up after waitMs', async () => {
  const child = sleeper();
  try {
    writeLock({ owner: 'caterer', pid: child.pid, startedAt: new Date().toISOString() });
    const t0 = Date.now();
    const r = await lock.wait('reed', { waitMs: 300, pollMs: 50 });
    assert.strictEqual(r.acquired, false);
    assert.ok(Date.now() - t0 < 3000);
  } finally { child.kill(); }
});

test('an unreadable fresh lock file counts as busy, an old one is taken over', () => {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  fs.writeFileSync(LOCK_FILE, '{not json');
  assert.strictEqual(lock.acquire('reed').acquired, false);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(LOCK_FILE, old, old);
  const r = lock.acquire('reed');
  assert.strictEqual(r.acquired, true);
  r.release();
});

test('CLI: ensure-chrome-cdp exits 4 with CDP_LOCKED while a Caterer run holds the lock', () => {
  const child = sleeper();
  try {
    writeLock({ owner: 'caterer', pid: child.pid, startedAt: new Date().toISOString() });
    const res = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, REED_CDP_PORT: '1' } });
    assert.strictEqual(res.status, 4);
    assert.match(res.stdout.toString(), /^CDP_LOCKED: /);
    const stop = spawnSync(process.execPath, [SCRIPT, '--stop'], { env: { ...process.env } });
    assert.strictEqual(stop.status, 4);
    const idle = spawnSync(process.execPath, [SCRIPT, '--stop-if-idle'], { env: { ...process.env } });
    assert.strictEqual(idle.status, 0);
    assert.match(idle.stdout.toString(), /^CDP_BUSY_SKIP: /);
  } finally { child.kill(); }
});

test('hasFlag matches whole arguments only, in NUL-separated and Chromium-style joined command lines', () => {
  const { hasFlag } = launcher;
  const flag = '--user-data-dir=/a/chrome-reed';
  assert.strictEqual(hasFlag('/usr/bin/chromium --no-first-run --user-data-dir=/a/chrome-reed https://x', flag), true);
  assert.strictEqual(hasFlag('--user-data-dir=/a/chrome-reed', flag), true);
  assert.strictEqual(hasFlag('/usr/bin/chromium --user-data-dir=/a/chrome-reed', flag), true);
  assert.strictEqual(hasFlag('/usr/bin/chromium --user-data-dir=/a/chrome-reed2 x', flag), false, 'a longer path is another profile');
  assert.strictEqual(hasFlag('/usr/bin/chromium x--user-data-dir=/a/chrome-reed', flag), false);
  assert.strictEqual(hasFlag('/usr/bin/chromium --user-data-dir=/b --user-data-dir=/a/chrome-reed', flag), true);
  assert.strictEqual(hasFlag('', flag), false);
});
