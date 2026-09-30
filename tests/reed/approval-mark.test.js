'use strict';

// A screened Reed candidate is recorded as "seen" in candidates.db, and everything "seen" is skipped by every later run.
// Rejections are final decisions and are recorded at once; an APPROVAL is only recorded after the queue file that carries it has
// been written and read back, so a kill or a failed write never leaves an approved candidate in no queue and marked as done.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { withWorld, isWin } = require('./helpers/world');
const { dep } = require('./helpers/mirror');

const world = (fn, o) => withWorld(fn, { fake: { loggedIn: true }, ...(o || {}) });
const ARGS = (extra) => ['--job-title', 'Chef', '--location', 'LS1', '--distance', '20', '--run-id', 't1', ...(extra || [])];

function dbIds(m) {
  const D = dep('better-sqlite3');
  if (!m.exists('candidates.db')) return [];
  const db = new D(m.p('candidates.db'), { readonly: true });
  try { return db.prepare('SELECT reed_id FROM candidates ORDER BY reed_id').all().map((r) => r.reed_id); } finally { db.close(); }
}
const aiLog = (m) => m.readLines('ai-log.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; }

test('the queue cannot be written: approvals are NOT marked seen, rejections are, and the next run screens the approvals again', () => world(async ({ m, run }) => {
  m.write('downloads', 'a plain file where the downloads directory should be');
  const r = await run('reed-phase1.js', ARGS(), { env: { FAKE_AI_REJECT_IDS: '9002,9013' } });
  assert.notStrictEqual(r.code, 0, 'a run that could not write its queue fails');
  assert.deepStrictEqual(dbIds(m), [9002, 9013], 'only the two real rejections are recorded');
  fs.rmSync(m.p('downloads'));
  const again = await run('reed-phase1.js', ARGS(['--run-id', 't2']), { env: { FAKE_AI_REJECT_IDS: '9002,9013' } });
  assert.strictEqual(again.code, 0, again.stderr + again.stdout);
  const q = m.readJson('downloads/reed-approved-queue-t2.json');
  assert.strictEqual(q.candidates.length, 28, 'all 28 approvals are in the new queue');
  assert.strictEqual(q.phase1Stats.inDb, 2, 'only the rejections were skipped as already seen');
  assert.strictEqual(dbIds(m).length, 30, 'after the queue exists every screened candidate is recorded');
}));

test('a normal run marks approvals only once the queue file is in place, and the recorded set equals the queued set plus the rejections', () => world(async ({ m, run }) => {
  const r = await run('reed-phase1.js', ARGS(), { env: { FAKE_AI_REJECT_IDS: '9005' } });
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  const q = m.readJson('downloads/reed-approved-queue-t1.json');
  const queued = q.candidates.map((c) => c.id).sort((a, b) => a - b);
  assert.strictEqual(queued.length, 29);
  assert.deepStrictEqual(dbIds(m), [...queued, 9005].sort((a, b) => a - b));
  assert.match(r.stdout, /approvals recorded as seen: 29/);
}));

test('the same candidate on two pages is screened and queued once', () => world(async ({ m, fake, run }) => {
  fake.api.candidates.splice(25, 1, { ...fake.api.candidates[3] });
  const r = await run('reed-phase1.js', ARGS());
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  const q = m.readJson('downloads/reed-approved-queue-t1.json');
  const ids = q.candidates.map((c) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'no duplicate in the queue');
  assert.strictEqual(q.phase1Stats.inDb, 1, 'the repeat counts as already handled');
}));

test('SIGKILL of reed-phase1 between page 1 and the queue write leaves no approved candidate marked, and a re-run picks them all up', { skip: isWin }, () => world(async ({ m, env, run }) => {
  const child = spawn(process.execPath, [m.p('scripts', 'reed-phase1.js'), ...ARGS()], {
    cwd: m.home, env: { ...env, FAKE_AI_PLAN: 'ok,hang', FAKE_AI_REJECT_IDS: '9002' }, stdio: 'ignore', detached: true,
  });
  try {
    assert.ok(await until(() => aiLog(m).length >= 2, 20000), 'page 1 was screened and page 2 is being screened');
    assert.ok(!m.exists('downloads/reed-approved-queue-t1.json'), 'no queue exists yet');
    process.kill(-child.pid, 'SIGKILL');
    await until(() => false, 300);
  } finally { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
  assert.deepStrictEqual(dbIds(m), [9002], 'page 1 approvals (24 candidates) are not recorded; the rejection is');
  assert.ok(!m.exists('downloads/reed-approved-queue-t1.json'));
  const r = await run('reed-phase1.js', ARGS(['--run-id', 't2']), { env: { FAKE_AI_REJECT_IDS: '9002' } });
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  const q = m.readJson('downloads/reed-approved-queue-t2.json');
  assert.strictEqual(q.candidates.length, 29, 'every approval of the killed run reaches the new queue');
  assert.strictEqual(q.phase1Stats.inDb, 1);
  assert.ok(fs.existsSync(path.join(m.home, 'downloads', 'reed-approved-queue-t2.json')));
}));
