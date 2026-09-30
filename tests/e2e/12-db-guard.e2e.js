'use strict';
// SCENARIO 12 (extra) - the database is gone (deleted volume, failed restore): the supervisor must not start a run that would
// treat every candidate as new. The recovery drill is the documented one: restore the nightly backup, then the queue moves.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { World } = require('./lib/world');
const D = require('./lib/data');
const C = require('./lib/checks');

test('12 a missing candidates.db holds the queue with one critical alert; restoring the nightly backup lets the queue move and keeps the dedupe memory', async (t) => {
  const w = new World('s12-db-guard');
  await w.create({});
  t.after(() => w.close());
  w.warmLoggedIn();
  w.svc.zoho.state.dupKeys.add('71000010');

  // a normal run and the nightly backup
  w.dropPending({});
  await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json') && w.pipelineProcs().length === 0, { maxTicks: 12, tickMin: 1 });
  assert.equal(w.lastRun().exitCode, 0);
  const recordsBefore = w.svc.zoho.created().length;
  assert.equal((await w.cron('resourcer-backup')).code, 0);
  const backup = w.list('backups', /^candidates-\d{8}-\d{6}\.db\.gz\.enc$/)[0];

  // the database disappears
  for (const f of ['candidates.db', 'candidates.db-wal', 'candidates.db-shm']) fs.rmSync(w.p(f), { force: true });
  const pending = w.dropPending({ jobTitle: 'Chef', location: 'LS29', keywords: 'again' });
  const pf = w.node('preflight-db.js', [], { allowFail: true });
  assert.equal(pf.code, 1);
  assert.match(pf.stderr, /NOT FIT \(missing\)/);

  for (let i = 0; i < 3; i += 1) {
    const r = await w.cron('resourcer-tick', { env: { RESOURCER_MAX_TICK_MIN: '1' } });
    assert.deepEqual([r.code, r.stdout], [0, ''], 'the tick itself is healthy: it holds, it does not crash');
  }
  assert.equal(w.jsonl('logs/watchdog-runner.jsonl').filter((e) => e.event === 'picked').length, 1, 'no new run started');
  assert.deepEqual(w.pendingFiles(), [pending], 'the request waits');
  assert.equal(w.svc.zoho.created().length, recordsBefore);
  const crit = w.alerts().filter((a) => a.key === 'db-unfit');
  assert.equal(crit.length, 1, 'one alert, not one per minute');
  assert.equal(crit[0].severity, 'critical');
  assert.match(crit[0].text, /restore/i);
  assert.equal(w.exists('candidates.db'), false, 'the guard did not create an empty database');
  assert.match(w.text('logs/' + w.list('logs', /^tick-/)[0]), /candidates\.db is not fit to run on \(missing\)/);

  // the drill from the runbook
  const pass = path.join(w.privateDir, 'backup-pass');
  fs.writeFileSync(pass, D.SECRETS.backupPassphrase, { mode: 0o600 });
  const restored = w.node('backup-db.js', ['--restore', w.p('backups', backup), '--out', w.p('candidates.db'), '--passphrase-file', pass]);
  assert.equal(restored.code, 0, restored.stdout + restored.stderr);
  assert.equal(w.node('preflight-db.js', []).code, 0);
  w.node('migrate-schema.js', []);
  await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json') && w.pipelineProcs().length === 0, { maxTicks: 12, tickMin: 1 });
  assert.equal(w.lastRun().exitCode, 0);
  // the restored database remembered the first run: nothing was screened, unlocked or pushed twice
  assert.equal(w.lastRun().approved, 0);
  assert.equal(w.svc.zoho.created().length, recordsBefore);
  assert.equal(w.lastRun().skippedDb, 11, 'all eleven cards are recognised from the restored memory (pushed, rejected for this title, or already there)');
  assert.deepEqual(C.secretHits(w), []);
});
