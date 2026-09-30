'use strict';
// SCENARIO 9 - the nightly backup job: encrypted online snapshot, integrity check, manifest, retention, off-instance upload
// hook, restore test, staleness, tamper detection - and a backup taken while the pipeline is writing to the database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { World } = require('./lib/world');
const D = require('./lib/data');
const C = require('./lib/checks');
const U = require('./lib/util');

const w = new World('s9-backup');
const NAME = /^candidates-(\d{8})-(\d{6})\.db\.gz\.enc$/;
const encFiles = () => w.list('backups', NAME);
const passFile = () => path.join(w.privateDir, 'backup-pass');
let firstBackup = null;
let liveCounts = null;

function counts(dbFile) {
  const Db = require(path.join(w.home, 'node_modules', 'better-sqlite3'));
  const db = new Db(dbFile, { readonly: true, fileMustExist: true });
  try {
    const out = { integrity: db.pragma('integrity_check', { simple: true }) };
    for (const t of ['candidates', 'candidate_rejections', 'territory_searches', 'run_results', 'reed_daily_usage']) out[t] = db.prepare(`select count(*) n from ${t}`).get().n;
    return out;
  } finally { db.close(); }
}

test.before(async () => {
  await w.create({});
  w.warmLoggedIn();
  w.svc.zoho.state.dupKeys.add('71000010');
  fs.writeFileSync(passFile(), D.SECRETS.backupPassphrase, { mode: 0o600 });
  w.dropPending({});
  await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json') && w.pipelineProcs().length === 0, { maxTicks: 12, tickMin: 1 });
});
test.after(async () => { await w.close(); });

test('9.1 the cron job takes an encrypted snapshot, silently: manifest, integrity, format, no plaintext left anywhere', async () => {
  const r = await w.cron('resourcer-backup');
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', '']);
  assert.equal(encFiles().length, 1);
  firstBackup = encFiles()[0];
  const man = w.json(`backups/${firstBackup.replace(/\.db\.gz\.enc$/, '.json')}`);
  assert.equal(man.integrity, 'ok');
  assert.equal(man.name, firstBackup);
  assert.equal(man.tables.candidates, w.dbAll('select count(*) n from candidates')[0].n);
  assert.equal(man.tables.run_results, 1);
  assert.equal(man.sha256, crypto.createHash('sha256').update(fs.readFileSync(w.p('backups', firstBackup))).digest('hex'));
  const buf = fs.readFileSync(w.p('backups', firstBackup));
  assert.equal(buf.slice(0, 4).toString('ascii'), 'RSBK');
  assert.ok(!buf.includes(Buffer.from('SQLite format 3')) && !buf.includes(Buffer.from('candidates')), 'ciphertext only');
  assert.equal(w.json('runtime/backup-status.json').ok, true);
  // no plaintext copy anywhere in the profile
  const plain = C.profileFiles(w).filter((f) => fs.readFileSync(f).slice(0, 15).toString('latin1') === 'SQLite format 3' && !/\/candidates\.db(-wal|-shm)?$|pre-migrate/.test(f));
  assert.deepEqual(plain, []);
  assert.deepEqual(w.list('state', /backup-tmp/).filter((n) => fs.readdirSync(w.p('state', n)).length), [], 'the temporary snapshot directory is empty');
  assert.match(w.text(`logs/backup-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.log`), /backup ok/);
});

test('9.2 verify and restore with the passphrase: the restored database is intact and holds what the live one held', async () => {
  const live = counts(w.p('candidates.db'));
  liveCounts = live;
  const v = w.node('backup-db.js', ['--verify', w.p('backups', firstBackup), '--passphrase-file', passFile()]);
  assert.equal(v.code, 0);
  const out = path.join(w.privateDir, 'restored.db');
  const r = w.node('backup-db.js', ['--restore', w.p('backups', firstBackup), '--out', out, '--passphrase-file', passFile()]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(counts(out), live);
  assert.equal(counts(out).integrity, 'ok');
  // the same file under the live database name is refused without --force
  const refuse = w.node('backup-db.js', ['--restore', w.p('backups', firstBackup), '--out', out, '--passphrase-file', passFile()], { allowFail: true });
  assert.notEqual(refuse.code, 0);
  // the weekly restore test runs against the newest backup
  const rt = w.node('backup-db.js', ['--restore-test']);
  assert.equal(rt.code, 0, rt.stdout + rt.stderr);
});

test('9.3 tampering, truncation and a wrong passphrase are all detected', () => {
  const pf2 = path.join(w.privateDir, 'wrong-pass');
  fs.writeFileSync(pf2, 'a completely different passphrase 12345');
  const wrong = w.node('backup-db.js', ['--verify', w.p('backups', firstBackup), '--passphrase-file', pf2], { allowFail: true });
  assert.equal(wrong.code, 3);
  const bytes = fs.readFileSync(w.p('backups', firstBackup));
  const flipped = Buffer.from(bytes);
  flipped[Math.floor(bytes.length / 2)] ^= 0x01;
  const t1 = path.join(w.privateDir, 'flipped.enc');
  fs.writeFileSync(t1, flipped);
  assert.equal(w.node('backup-db.js', ['--verify', t1, '--passphrase-file', passFile()], { allowFail: true }).code, 3);
  const t2 = path.join(w.privateDir, 'cut.enc');
  fs.writeFileSync(t2, bytes.slice(0, bytes.length - 40));
  assert.equal(w.node('backup-db.js', ['--verify', t2, '--passphrase-file', passFile()], { allowFail: true }).code, 3);
  assert.ok(!(wrong.stdout + wrong.stderr).includes(D.SECRETS.backupPassphrase), 'the passphrase is never printed');
});

test('9.4 retention: 14 daily and 8 weekly copies; foreign files and the safety copy are left to their own jobs', async () => {
  const src = w.p('backups', firstBackup);
  const man = w.p('backups', firstBackup.replace(/\.db\.gz\.enc$/, '.json'));
  const today = new Date();
  for (let d = 1; d <= 60; d += 1) {
    const day = new Date(today.getTime() - d * 86400000);
    const stamp = `${day.getUTCFullYear()}${String(day.getUTCMonth() + 1).padStart(2, '0')}${String(day.getUTCDate()).padStart(2, '0')}-030000`;
    const name = `candidates-${stamp}.db.gz.enc`;
    fs.copyFileSync(src, w.p('backups', name));
    const m = JSON.parse(fs.readFileSync(man, 'utf8'));
    m.name = name;
    m.createdAt = new Date(day.getTime()).toISOString();
    fs.writeFileSync(w.p('backups', name.replace(/\.db\.gz\.enc$/, '.json')), JSON.stringify(m));
  }
  fs.writeFileSync(w.p('backups', 'NOTES.txt'), 'operator notes, not ours');
  const r = await w.cron('resourcer-backup');
  assert.deepEqual([r.code, r.stdout], [0, '']);
  const kept = encFiles();
  assert.ok(kept.length >= 14 && kept.length <= 22, `kept ${kept.length}`);
  const days = new Set(kept.map((n) => NAME.exec(n)[1]));
  for (let d = 0; d < 14; d += 1) {
    const day = new Date(today.getTime() - d * 86400000);
    const key = `${day.getUTCFullYear()}${String(day.getUTCMonth() + 1).padStart(2, '0')}${String(day.getUTCDate()).padStart(2, '0')}`;
    assert.ok(days.has(key), `the last 14 days keep ${key}`);
  }
  assert.ok(!kept.some((n) => NAME.exec(n)[1] < (() => { const d = new Date(today.getTime() - 80 * 86400000); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; })()), 'nothing older than the weekly window');
  assert.ok(w.exists('backups/NOTES.txt'), 'a foreign file is never touched');
  assert.ok(w.list('backups', /^candidates\.db\.pre-migrate-/).length >= 1, 'the safety copy belongs to maintenance, not to the backup job');
  for (const n of kept) assert.ok(w.exists(`backups/${n.replace(/\.db\.gz\.enc$/, '.json')}`), `manifest kept with ${n}`);
  assert.equal(w.list('backups', /\.json$/).length, kept.length, 'no orphan manifest');
});

test('9.5 the off-instance upload hook: a copy leaves the instance; a failing hook is a warning with the exit code 5 and a good local backup', async () => {
  const offsite = path.join(w.root, 'offsite');
  fs.mkdirSync(offsite, { recursive: true });
  w.writeEnv({ BACKUP_UPLOAD_CMD: JSON.stringify(['/bin/cp', '{file}', offsite + '/']) });
  const ok = await w.cron('resourcer-backup');
  assert.deepEqual([ok.code, ok.stdout], [0, '']);
  const newest = encFiles().sort().at(-1);
  assert.ok(fs.existsSync(path.join(offsite, newest)), 'the encrypted file was copied out');
  assert.ok(!fs.readdirSync(offsite).some((n) => /\.db$/.test(n)), 'only ciphertext leaves the instance');
  assert.equal(w.json('runtime/backup-status.json').ok, true);

  w.writeEnv({ BACKUP_UPLOAD_CMD: JSON.stringify(['/bin/false']) });
  const bad = await w.cron('resourcer-backup');
  assert.equal(bad.code, 5);
  assert.equal(bad.stdout.trim().split('\n').length, 1);
  assert.match(bad.stdout, /^resourcer-backup failed rc=5/);
  assert.ok(w.alerts().some((a) => a.key === 'backup-upload' && ['warn', 'critical'].includes(a.severity)));
  assert.ok(encFiles().length >= 14, 'the local backup is fine');
  w.writeEnv({ BACKUP_UPLOAD_CMD: null });
});

test('9.6 a missing passphrase fails loudly (one line, critical alert) and leaves no plaintext; an old newest backup is flagged stale', async () => {
  const saved = w.envFile.BACKUP_PASSPHRASE;
  w.writeEnv({ BACKUP_PASSPHRASE: null });
  const before = encFiles().length;
  const r = await w.cron('resourcer-backup');
  assert.notEqual(r.code, 0);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.ok(w.alerts().some((a) => a.severity === 'critical' && /^backup-/.test(a.key)), JSON.stringify(w.alerts().map((a) => a.key)));
  assert.equal(encFiles().length, before);
  w.writeEnv({ BACKUP_PASSPHRASE: saved });

  // age every backup 40 hours: the age check must say so
  for (const n of w.list('backups', NAME)) {
    const t = (Date.now() - 40 * 3600000) / 1000;
    fs.utimesSync(w.p('backups', n), t, t);
    const mf = w.p('backups', n.replace(/\.db\.gz\.enc$/, '.json'));
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    m.createdAt = new Date(Date.now() - 40 * 3600000).toISOString();
    fs.writeFileSync(mf, JSON.stringify(m));
    fs.utimesSync(mf, t, t);
  }
  const st = JSON.parse(fs.readFileSync(w.p('runtime/backup-state.json'), 'utf8'));
  st.lastOkAt = new Date(Date.now() - 40 * 3600000).toISOString();
  fs.writeFileSync(w.p('runtime/backup-state.json'), JSON.stringify(st));
  const age = w.node('backup-db.js', ['--check-age'], { allowFail: true });
  assert.equal(age.code, 4, age.stdout + age.stderr);
  assert.ok(w.alerts().some((a) => a.key === 'backup-stale' && a.severity === 'critical'));
  assert.deepEqual(C.secretHits(w), []);
});

test('9.7 a backup taken while phase 1 is writing candidates is consistent and does not disturb the run', async () => {
  const w2 = new World('s9b-live');
  await w2.create({});
  try {
    w2.warmLoggedIn();
    w2.svc.zoho.state.dupKeys.add('71000010');
    w2.setBrowserScenario({ rules: [{ when: { cmd: 'open' }, do: { delayMs: 1500 } }, { when: { cmd: 'eval' }, do: { delayMs: 400 } }] });
    w2.dropPending({});
    const tk = w2.cron('resourcer-tick', { env: { RESOURCER_MAX_TICK_MIN: '1' } });
    await U.waitFor(() => { const f = w2.list('logs', /^phase1-console-/)[0]; return f && /QUEUED \(2 total\)/.test(w2.text(`logs/${f}`)); }, { timeoutMs: 60000, pollMs: 10 });
    const b = await w2.cron('resourcer-backup');
    assert.deepEqual([b.code, b.stdout], [0, ''], 'the backup succeeds mid-run');
    await tk;
    await w2.tickUntil(async () => !w2.pendingFiles().length && !w2.exists('runtime/run.json') && w2.pipelineProcs().length === 0, { maxTicks: 12, tickMin: 1 });
    assert.equal(w2.lastRun().exitCode, 0);
    assert.equal(w2.svc.zoho.created().length, 5);
    const name = w2.list('backups', NAME)[0];
    const out = path.join(w2.privateDir, 'live-restored.db');
    const r = w2.node('backup-db.js', ['--restore', w2.p('backups', name), '--out', out]);
    assert.equal(r.code, 0);
    const Db = require(path.join(w2.home, 'node_modules', 'better-sqlite3'));
    const db = new Db(out, { readonly: true });
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.ok(db.prepare('select count(*) n from candidates').get().n >= 1501, 'the copy holds at least the restored rows plus what phase 1 had marked');
    db.close();
    const errs = w2.text('logs/errors.jsonl') + w2.list('logs', /^phase1-console/).map((f) => w2.text(`logs/${f}`)).join('');
    assert.doesNotMatch(errs, /SQLITE_BUSY|database is locked/i, 'neither side saw a lock error');
  } finally { await w2.close(); }
});
