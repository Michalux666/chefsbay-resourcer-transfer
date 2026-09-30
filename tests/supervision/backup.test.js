'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const H = require('./_helpers');

H.installNetworkGuard();
process.env.RESOURCER_HOME = H.mkHome(null, 'backupbase');
let Database = null;
try { Database = require('better-sqlite3'); } catch { /* tests skip below */ }
const NO_SQLITE = !Database && 'better-sqlite3 is not installed';
const backup = require(path.join(H.SRC_SCRIPTS, 'backup-db.js'));

const PASS = 'correct horse battery staple';
const HOUR = 3600000;
const DAY = 86400000;

function makeDb(file, n) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE candidates (id INTEGER PRIMARY KEY, caterer_id TEXT, zoho_id TEXT, note TEXT, blob BLOB);
    CREATE TABLE candidate_rejections (id INTEGER PRIMARY KEY, candidate_id TEXT, job_title TEXT);
    CREATE TABLE territory_searches (id INTEGER PRIMARY KEY, job_title TEXT, location TEXT);
    CREATE TABLE "odd name" (x INTEGER);
  `);
  const ins = db.prepare('INSERT INTO candidates (caterer_id, zoho_id, note, blob) VALUES (?,?,?,?)');
  const insR = db.prepare('INSERT INTO candidate_rejections (candidate_id, job_title) VALUES (?,?)');
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      ins.run(`C${i}`, i % 3 ? `Z${i}` : null, `unicode note ${i} \u00e9\u4e2d`, Buffer.from([i & 255, 1, 2, 3]));
      insR.run(`C${i}`, 'Chef');
    }
    db.prepare('INSERT INTO territory_searches (job_title, location) VALUES (?,?)').run('Chef', 'AB1');
  })();
  db.close();
}

function mkBackup(t, o = {}) {
  const home = H.mkHome(t, 'backup');
  let clock = o.start || Date.UTC(2026, 8, 29, 3, 30);
  const notify = H.collectNotifier();
  const logs = [];
  const ctx = backup.makeCtx(Object.assign({
    home, now: () => clock, notify, log: (m) => logs.push(m), passphrase: () => PASS, log2n: 12,
    uploadCmd: () => undefined, uploadEnv: () => '',
  }, o.ctx || {}));
  if (o.rows !== undefined) makeDb(ctx.dbFile, o.rows);
  return { home, ctx, notify, logs, set: (v) => { clock = v; }, advance: (ms) => { clock += ms; }, clock: () => clock, state: () => H.readJson(ctx.files.dir ? path.join(ctx.files.dir, 'backup-state.json') : '', {}) };
}

function dumpTable(dbFile, table) {
  const db = new Database(dbFile, { readonly: true });
  try { return db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map((r) => JSON.stringify(r, (k, v) => (v && v.type === 'Buffer' ? Buffer.from(v.data).toString('hex') : v))); } finally { db.close(); }
}

test('format constants: 37-byte header, RSBK magic, version 1', () => {
  assert.equal(backup.HEADER_LEN, 37);
  assert.deepEqual(backup.RETENTION, { daily: 14, weekly: 8 });
  assert.equal(backup.STALE_AFTER_MS, 26 * HOUR);
});

test('round trip: online backup of a WAL database, encrypted, restorable bit for bit', { skip: NO_SQLITE }, async (t) => {
  const b = mkBackup(t, { rows: 200, ctx: { log2n: 15 } });
  const created = await backup.createBackup(b.ctx);
  assert.match(created.name, /^candidates-20260929-033000\.db\.gz\.enc$/);
  const raw = fs.readFileSync(created.file);
  assert.equal(raw.subarray(0, 4).toString('ascii'), 'RSBK');
  assert.equal(raw[4], 1, 'version');
  assert.equal(raw[5], 1, 'kdf scrypt');
  assert.equal(raw[6], 15, 'log2 N');
  assert.equal(raw[7], 8);
  assert.equal(raw[8], 1);
  assert.equal(raw.includes(Buffer.from('SQLite format 3')), false, 'no plaintext database header');
  assert.equal(raw.includes(Buffer.from('unicode note')), false, 'no plaintext row data');
  assert.notDeepEqual(raw.subarray(37, 40), Buffer.from([0x1f, 0x8b, 0x08]), 'the payload is ciphertext, not a bare gzip stream');

  const manifest = H.readJson(created.file.replace(/\.db\.gz\.enc$/, '.json'));
  assert.equal(manifest.integrity, 'ok');
  assert.equal(manifest.tables.candidates, 200);
  assert.equal(manifest.tables.candidate_rejections, 200);
  assert.equal(manifest.tables.territory_searches, 1);
  assert.equal(manifest.tables['odd name'], 0, 'unusual table names are counted safely');
  assert.equal(manifest.sha256, require(path.join(H.SRC_SCRIPTS, 'lib', 'fsx.js')).sha256File(created.file));
  assert.equal(manifest.bytes, raw.length);

  const out = path.join(b.home, 'restored.db');
  await backup.decryptFile(created.file, out, PASS);
  for (const table of ['candidates', 'candidate_rejections', 'territory_searches']) {
    assert.deepEqual(dumpTable(out, table), dumpTable(b.ctx.dbFile, table), table);
  }
  assert.deepEqual(fs.readdirSync(b.ctx.tmpDir), [], 'no plaintext copy is left in the scratch directory');
  const s = H.readJson(path.join(b.home, 'runtime', 'backup-state.json'));
  assert.equal(s.lastFile, created.name);
  assert.ok(s.lastOkAt);
});

test('the file is created with mode 0600 on POSIX', { skip: NO_SQLITE || (H.IS_WIN && 'POSIX modes') }, async (t) => {
  const b = mkBackup(t, { rows: 5 });
  const created = await backup.createBackup(b.ctx);
  assert.equal(fs.statSync(created.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(b.ctx.dir).mode & 0o777, 0o700);
});

test('two backups of the same data differ (random salt and iv) and both restore', { skip: NO_SQLITE }, async (t) => {
  const b = mkBackup(t, { rows: 20 });
  const one = await backup.createBackup(b.ctx);
  b.advance(60000);
  const two = await backup.createBackup(b.ctx);
  const a = fs.readFileSync(one.file);
  const c = fs.readFileSync(two.file);
  assert.notDeepEqual(a.subarray(9, 37), c.subarray(9, 37), 'salt+iv differ');
  for (const f of [one.file, two.file]) {
    const out = path.join(b.home, `r-${path.basename(f)}.db`);
    await backup.decryptFile(f, out, PASS);
    assert.deepEqual(dumpTable(out, 'candidates'), dumpTable(b.ctx.dbFile, 'candidates'));
  }
});

test('wrong passphrase, truncation and every kind of tampering are rejected and leave no output', { skip: NO_SQLITE }, async (t) => {
  const b = mkBackup(t, { rows: 50 });
  const created = await backup.createBackup(b.ctx);
  const good = fs.readFileSync(created.file);
  const out = path.join(b.home, 'x.db');
  const bad = async (buf, pass, why) => {
    const f = path.join(b.home, 'bad.enc');
    fs.writeFileSync(f, buf);
    await assert.rejects(() => backup.decryptFile(f, out, pass || PASS), /decryption failed|not a backup file|unsupported/, why);
    assert.equal(fs.existsSync(out), false, `${why}: no output`);
    assert.deepEqual(fs.readdirSync(b.home).filter((n) => n.endsWith('.partial')), [], `${why}: no partial file`);
  };
  await bad(good, 'wrong passphrase entirely', 'wrong passphrase');
  await bad(good.subarray(0, good.length - 5), null, 'truncated tag');
  await bad(good.subarray(0, Math.floor(good.length / 2)), null, 'truncated body');
  const flip = (i) => { const c = Buffer.from(good); c[i] ^= 0x01; return c; };
  await bad(flip(40), null, 'flipped ciphertext byte');
  await bad(flip(good.length - 1), null, 'flipped tag byte');
  await bad(flip(15), null, 'flipped salt byte (also changes the key)');
  await bad(flip(30), null, 'flipped iv byte');
  await bad(Buffer.concat([good, Buffer.from([0])]), null, 'appended byte');
  await bad(Buffer.from('RSBK'), null, 'tiny file');
  const notBackup = Buffer.alloc(200, 7);
  await bad(notBackup, null, 'garbage file');
  // header field tampering that keeps the data intact is caught by the AAD binding
  const h = Buffer.from(good);
  h[8] = 2;
  await bad(h, null, 'header parameter changed');
});

test('refuses to write an unencrypted or weakly protected backup', { skip: NO_SQLITE }, async (t) => {
  let b = mkBackup(t, { rows: 3, ctx: { passphrase: () => null } });
  await assert.rejects(() => backup.createBackup(b.ctx), /no backup passphrase/);
  assert.deepEqual(fs.existsSync(b.ctx.dir) ? fs.readdirSync(b.ctx.dir).filter((n) => n.endsWith('.enc')) : [], []);
  b = mkBackup(t, { rows: 3, ctx: { passphrase: () => 'short' } });
  await assert.rejects(() => backup.createBackup(b.ctx), /shorter than 16/);
});

test('the passphrase may come from secrets/backup-passphrase', { skip: NO_SQLITE }, async (t) => {
  const home = H.mkHome(t, 'backup-secret');
  fs.mkdirSync(path.join(home, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(home, 'secrets', 'backup-passphrase'), 'a passphrase from the file\n');
  makeDb(path.join(home, 'candidates.db'), 4);
  const ctx = backup.makeCtx({ home, notify: H.collectNotifier(), log: () => {}, log2n: 12 });
  const c = await backup.createBackup(ctx);
  await backup.decryptFile(c.file, path.join(home, 'r.db'), 'a passphrase from the file');
});

test('a backup taken while another process writes stays consistent', { skip: NO_SQLITE, timeout: 60000 }, async (t) => {
  const b = mkBackup(t, { rows: 100 });
  const writer = path.join(b.home, 'writer.js');
  fs.writeFileSync(writer, `
const D = require(${JSON.stringify(require.resolve('better-sqlite3'))});
const db = new D(process.argv[2]);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
const ins = db.prepare('INSERT INTO candidates (caterer_id, note) VALUES (?, ?)');
let i = 0;
const stop = Date.now() + 2500;
while (Date.now() < stop) { ins.run('W' + (i++), 'w'); }
console.log('WROTE ' + i);
`);
  const w = spawn(process.execPath, [writer, b.ctx.dbFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => setTimeout(r, 300));
  const created = await backup.createBackup(b.ctx);
  await new Promise((resolve) => w.on('close', resolve));
  const m = H.readJson(created.file.replace(/\.db\.gz\.enc$/, '.json'));
  assert.equal(m.integrity, 'ok');
  assert.ok(m.tables.candidates >= 100);
  const res = await backup.restoreTest(b.ctx, { file: created.file, tolerance: 1 });
  assert.equal(res.ok, true, res.problems.join('; '));
});

// --- retention ----------------------------------------------------------------------------------

test('isoWeekKey follows ISO 8601 across the year boundary', () => {
  const k = (s) => backup.isoWeekKey(new Date(`${s}T12:00:00Z`));
  assert.equal(k('2025-12-28'), '2025-W52');
  assert.equal(k('2025-12-29'), '2026-W01');
  assert.equal(k('2026-01-01'), '2026-W01');
  assert.equal(k('2026-01-04'), '2026-W01');
  assert.equal(k('2026-01-05'), '2026-W02');
  assert.equal(k('2026-12-31'), '2026-W53');
});

function entriesFor(daysBack, perDay) {
  const out = [];
  const base = Date.UTC(2026, 8, 29, 3, 30);
  for (let d = 0; d < daysBack; d++) {
    for (let k = 0; k < (perDay || 1); k++) {
      const ms = base - d * DAY - k * 3600000;
      const iso = new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      out.push(backup.parseBackupName(`candidates-${iso}.db.gz.enc`));
    }
  }
  return out.sort((a, b) => b.date - a.date);
}

test('retention keeps the last 14 distinct days plus the newest backup of each of the last 8 ISO weeks', () => {
  const entries = entriesFor(120, 1);
  const keep = backup.selectKeep(entries);
  const kept = entries.filter((e) => keep.has(e.name));
  const dailyDays = new Set(entries.slice(0, 14).map((e) => e.ymd));
  for (const e of entries.slice(0, 14)) assert.ok(keep.has(e.name), `daily ${e.ymd}`);
  const weekKeys = [];
  for (const e of entries) { const w = backup.isoWeekKey(e.date); if (!weekKeys.includes(w)) weekKeys.push(w); }
  const newestOfWeek = (w) => entries.find((e) => backup.isoWeekKey(e.date) === w);
  for (const w of weekKeys.slice(0, 8)) assert.ok(keep.has(newestOfWeek(w).name), `weekly ${w}`);
  const expected = new Set([...entries.slice(0, 14).map((e) => e.name), ...weekKeys.slice(0, 8).map((w) => newestOfWeek(w).name)]);
  assert.equal(kept.length, expected.size);
  assert.ok(kept.length >= 14 && kept.length <= 22, `kept ${kept.length}`);
  assert.equal(dailyDays.size, 14);
});

test('retention with several backups a day keeps only the newest per day, and never drops the only backup', () => {
  const entries = entriesFor(20, 3);
  const keep = backup.selectKeep(entries);
  const perDay = {};
  for (const e of entries.filter((x) => keep.has(x.name))) perDay[e.ymd] = (perDay[e.ymd] || 0) + 1;
  assert.ok(Object.values(perDay).every((n) => n === 1), JSON.stringify(perDay));
  const one = entriesFor(1, 1);
  assert.equal(backup.selectKeep(one).size, 1);
  assert.equal(backup.selectKeep([]).size, 0);
});

test('pruneBackups removes the encrypted file and its manifest, leaves foreign files alone', (t) => {
  const home = H.mkHome(t, 'prune');
  const ctx = backup.makeCtx({ home, notify: H.collectNotifier(), log: () => {} });
  fs.mkdirSync(ctx.dir, { recursive: true });
  const entries = entriesFor(40, 1);
  for (const e of entries) {
    fs.writeFileSync(path.join(ctx.dir, e.name), 'x');
    fs.writeFileSync(path.join(ctx.dir, e.name.replace(/\.db\.gz\.enc$/, '.json')), '{}');
  }
  fs.writeFileSync(path.join(ctx.dir, 'notes.txt'), 'keep me');
  fs.writeFileSync(path.join(ctx.dir, 'candidates-manual.db'), 'keep me too');
  const r = backup.pruneBackups(ctx);
  assert.equal(r.removed.length, 40 - r.kept);
  assert.ok(r.kept >= 14);
  const left = fs.readdirSync(ctx.dir);
  assert.ok(left.includes('notes.txt') && left.includes('candidates-manual.db'));
  assert.equal(left.filter((n) => n.endsWith('.enc')).length, r.kept);
  assert.equal(left.filter((n) => n.startsWith('candidates-2') && n.endsWith('.json')).length, r.kept, 'manifests follow their backups');
  assert.equal(backup.pruneBackups(ctx).removed.length, 0, 'idempotent');
});

// --- restore test -------------------------------------------------------------------------------

test('restore test passes on a healthy backup and records it', { skip: NO_SQLITE }, async (t) => {
  const b = mkBackup(t, { rows: 120 });
  await backup.createBackup(b.ctx);
  const r = await backup.restoreTest(b.ctx);
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.equal(r.tables.candidates, 120);
  const s = H.readJson(path.join(b.home, 'runtime', 'backup-state.json'));
  assert.equal(s.lastRestoreOk, true);
  assert.equal(b.notify.list.length, 0);
  assert.deepEqual(fs.readdirSync(b.ctx.tmpDir), [], 'scratch database removed');
});

test('restore test fails loudly on a corrupted backup, a wrong manifest, a diverged live DB and no backups', { skip: NO_SQLITE }, async (t) => {
  const b = mkBackup(t, { rows: 300 });
  const created = await backup.createBackup(b.ctx);
  const manifestFile = created.file.replace(/\.db\.gz\.enc$/, '.json');

  // manifest disagrees with the restored content
  const m = H.readJson(manifestFile);
  H.writeJson(manifestFile, Object.assign({}, m, { tables: Object.assign({}, m.tables, { candidates: 299 }) }));
  let r = await backup.restoreTest(b.ctx);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /table candidates: restored 300 rows, manifest says 299/.test(p)));
  assert.equal(H.readJson(path.join(b.home, 'runtime', 'backup-state.json')).lastRestoreOk, false);
  assert.ok(b.notify.list.some((n) => n.key === 'backup-restore-test' && n.severity === 'critical'));
  H.writeJson(manifestFile, m);

  // live DB lost half its rows since the backup
  const live = new Database(b.ctx.dbFile);
  live.prepare('DELETE FROM candidates WHERE id > 150').run();
  live.close();
  r = await backup.restoreTest(b.ctx);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /candidates: restored 300 rows vs live 150/.test(p)), r.problems.join('; '));
  r = await backup.restoreTest(b.ctx, { tolerance: 1 });
  assert.equal(r.ok, true, 'a wide tolerance accepts it');

  // corrupted ciphertext
  const raw = fs.readFileSync(created.file);
  raw[60] ^= 0xff;
  fs.writeFileSync(created.file, raw);
  r = await backup.restoreTest(b.ctx, { tolerance: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /sha256|decryption failed/.test(p)));

  // missing manifest and an empty directory
  fs.unlinkSync(manifestFile);
  r = await backup.restoreTest(b.ctx, { tolerance: 1 });
  assert.ok(r.problems.includes('manifest missing'));
  const empty = mkBackup(t, { rows: 3 });
  r = await backup.restoreTest(empty.ctx);
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ['no backup to test']);
});

test('small live tables are not held to the percentage tolerance', { skip: NO_SQLITE }, async (t) => {
  const b = mkBackup(t, { rows: 10 });
  await backup.createBackup(b.ctx);
  const live = new Database(b.ctx.dbFile);
  live.prepare('DELETE FROM candidates WHERE id > 2').run();
  live.close();
  assert.equal((await backup.restoreTest(b.ctx)).ok, true);
});

// --- upload hook --------------------------------------------------------------------------------

function uploadScript(home, body) {
  const f = path.join(home, 'upload.js');
  fs.writeFileSync(f, body);
  return f;
}

test('upload hook: array-spawned, {file}/{name} substituted, environment provided, success recorded', { skip: NO_SQLITE }, async (t) => {
  const b = mkBackup(t, { rows: 5 });
  const script = uploadScript(b.home, `
const fs = require('fs');
fs.writeFileSync(process.argv[4], JSON.stringify({ args: process.argv.slice(2, 4), file: process.env.BACKUP_FILE, name: process.env.BACKUP_NAME, manifest: process.env.BACKUP_MANIFEST, extra: process.env.MY_SECRET_VAR, exists: fs.existsSync(process.argv[2]) }));
`);
  const marker = path.join(b.home, 'upload-marker.json');
  b.ctx.uploadCmd = () => JSON.stringify([process.execPath, script, '{file}', '{name}', marker]);
  b.ctx.uploadEnv = () => 'MY_SECRET_VAR, NOT_SET_VAR';
  process.env.MY_SECRET_VAR = 'value-for-child';
  t.after(() => { delete process.env.MY_SECRET_VAR; });
  const code = await backup.runAuto(b.ctx);
  assert.equal(code, backup.EXIT.OK);
  const m = H.readJson(marker);
  assert.equal(m.exists, true, 'the encrypted file exists when the hook runs');
  assert.match(m.args[0], /candidates-20260929-033000\.db\.gz\.enc$/);
  assert.equal(m.args[1], 'candidates-20260929-033000.db.gz.enc');
  assert.equal(m.file, m.args[0]);
  assert.match(m.manifest, /\.json$/);
  assert.equal(m.extra, 'value-for-child');
  assert.ok(H.readJson(path.join(b.home, 'runtime', 'backup-state.json')).lastUploadOkAt);
  assert.equal(b.notify.list.length, 0);
});

test('upload hook: a plain string command is split on spaces; no command means skipped', () => {
  assert.deepEqual(backup.parseUploadCmd('rclone copyto {file} remote:bucket/{name}'), ['rclone', 'copyto', '{file}', 'remote:bucket/{name}']);
  assert.deepEqual(backup.parseUploadCmd('["a b","c"]'), ['a b', 'c']);
  assert.equal(backup.parseUploadCmd(''), null);
  assert.equal(backup.parseUploadCmd(undefined), null);
  assert.throws(() => backup.parseUploadCmd('[1,2]'), /JSON array of strings/);
  assert.throws(() => backup.parseUploadCmd('["a", 2]'), /JSON array of strings/);
});

test('upload hook failure: exit code 5, warn when it worked recently, critical when it never or long ago did', { skip: NO_SQLITE }, async (t) => {
  const b = mkBackup(t, { rows: 5 });
  const script = uploadScript(b.home, "process.stderr.write('remote said no: token=abcdefghijk'); process.exit(3);");
  b.ctx.uploadCmd = () => JSON.stringify([process.execPath, script]);
  let code = await backup.runAuto(b.ctx);
  assert.equal(code, backup.EXIT.UPLOAD);
  let n = b.notify.list.find((x) => x.key === 'backup-upload');
  assert.equal(n.severity, 'critical', 'never uploaded successfully');
  assert.match(n.text, /exit 3/);
  assert.match(n.text, /does not survive loss of the instance/);
  const localBackups = fs.readdirSync(b.ctx.dir).filter((f) => f.endsWith('.enc'));
  assert.equal(localBackups.length, 1, 'the local backup is fine and kept');

  b.notify.list.length = 0;
  b.advance(DAY);
  fs.writeFileSync(path.join(b.home, 'runtime', 'backup-state.json'), JSON.stringify({ lastUploadOkAt: new Date(b.clock() - DAY).toISOString(), lastRestoreTestAt: new Date(b.clock()).toISOString() }));
  code = await backup.runAuto(b.ctx);
  assert.equal(code, backup.EXIT.UPLOAD);
  n = b.notify.list.find((x) => x.key === 'backup-upload');
  assert.equal(n.severity, 'warn', 'one missed night after a good day is a warning');

  b.notify.list.length = 0;
  b.advance(4 * DAY);
  code = await backup.runAuto(b.ctx);
  n = b.notify.list.find((x) => x.key === 'backup-upload');
  assert.equal(n.severity, 'critical', 'several days without an off-instance copy escalates');
});

test('upload hook that hangs is stopped at its timeout', { skip: NO_SQLITE, timeout: 30000 }, async (t) => {
  const b = mkBackup(t, { rows: 3, ctx: { uploadTimeoutMs: 400 } });
  const script = uploadScript(b.home, 'setInterval(() => {}, 1000);');
  b.ctx.uploadCmd = () => JSON.stringify([process.execPath, script]);
  const created = await backup.createBackup(b.ctx);
  const t0 = Date.now();
  const r = await backup.uploadBackup(b.ctx, created);
  assert.equal(r.ok, false);
  assert.match(r.error, /exceeded/);
  assert.ok(Date.now() - t0 < 10000);
});

test('an upload command that does not exist is a reported failure, not a crash', { skip: NO_SQLITE }, async (t) => {
  const b = mkBackup(t, { rows: 3 });
  b.ctx.uploadCmd = () => JSON.stringify(['definitely-not-a-command-xyz', '{file}']);
  const created = await backup.createBackup(b.ctx);
  const r = await backup.uploadBackup(b.ctx, created);
  assert.equal(r.ok, false);
  assert.match(r.error, /ENOENT/);
});

// --- age check, nightly flow --------------------------------------------------------------------

test('checkAge: 26 hour limit, and a never-succeeded backup is flagged after the first day', (t) => {
  const home = H.mkHome(t, 'age');
  const notify = H.collectNotifier();
  let now = Date.UTC(2026, 8, 29, 12, 0);
  const call = () => backup.checkAge({ home, notify, now: () => now });
  let r = call();
  assert.equal(r.stale, false, 'first check just records the reference time');
  now += 25 * HOUR;
  assert.equal(call().stale, false);
  now += 2 * HOUR;
  r = call();
  assert.equal(r.stale, true);
  assert.equal(notify.list.at(-1).key, 'backup-stale');
  assert.match(notify.list.at(-1).text, /No DB backup has succeeded yet/);

  fs.writeFileSync(path.join(home, 'runtime', 'backup-state.json'), JSON.stringify({ lastOkAt: new Date(now - 25 * HOUR).toISOString(), firstCheckAt: new Date(now - 90 * DAY).toISOString() }));
  assert.equal(call().stale, false);
  fs.writeFileSync(path.join(home, 'runtime', 'backup-state.json'), JSON.stringify({ lastOkAt: new Date(now - 27 * HOUR).toISOString() }));
  r = call();
  assert.equal(r.stale, true);
  assert.equal(r.ageHours, 27);
  assert.match(notify.list.at(-1).text, /27 h old/);
  assert.equal(notify.list.at(-1).severity, 'critical');
});

test('nightly flow: restore test on the first run, then only on Sundays (London) or after 8 days', { skip: NO_SQLITE }, async (t) => {
  const b = mkBackup(t, { rows: 30, start: Date.UTC(2026, 8, 29, 3, 30) });   // a Tuesday
  const restoreRuns = () => b.logs.filter((l) => /restore test/.test(l)).length;
  assert.equal(await backup.runAuto(b.ctx), backup.EXIT.OK);
  assert.equal(restoreRuns(), 1, 'never tested before: test now');
  b.advance(DAY);
  await backup.runAuto(b.ctx);
  assert.equal(restoreRuns(), 1, 'Wednesday: no test');
  b.set(Date.UTC(2026, 9, 4, 3, 30));   // Sunday 2026-10-04
  await backup.runAuto(b.ctx);
  assert.equal(restoreRuns(), 2, 'Sunday: test');
  b.set(Date.UTC(2026, 9, 14, 3, 30));  // Wednesday, 10 days after the last test
  await backup.runAuto(b.ctx);
  assert.equal(restoreRuns(), 3, 'overdue by more than 8 days: test');
  assert.equal(b.notify.list.length, 0, 'a healthy night is silent');
});

test('a failing backup (unreadable database) exits 1, raises a critical alert and keeps earlier backups', { skip: NO_SQLITE }, async (t) => {
  const b = mkBackup(t, { rows: 30 });
  assert.equal(await backup.runAuto(b.ctx), backup.EXIT.OK);
  const before = fs.readdirSync(b.ctx.dir).filter((f) => f.endsWith('.enc'));
  fs.writeFileSync(b.ctx.dbFile, Buffer.alloc(4096, 0x5a));
  b.advance(DAY);
  const code = await backup.runAuto(b.ctx);
  assert.equal(code, backup.EXIT.BACKUP);
  const n = b.notify.list.find((x) => x.key === 'backup-failed' || x.key === 'backup-integrity');
  assert.ok(n, JSON.stringify(b.notify.list));
  assert.equal(n.severity, 'critical');
  assert.match(n.text, /Nightly DB backup failed/);
  assert.deepEqual(fs.readdirSync(b.ctx.dir).filter((f) => f.endsWith('.enc')), before, 'no new file, nothing deleted');
  assert.deepEqual(fs.readdirSync(b.ctx.tmpDir), [], 'no scratch files left behind');
  const s = H.readJson(path.join(b.home, 'runtime', 'backup-state.json'));
  assert.ok(s.lastFailureAt);
});

test('a missing database is a clear failure', { skip: NO_SQLITE }, async (t) => {
  const b = mkBackup(t);
  assert.equal(await backup.runAuto(b.ctx), backup.EXIT.BACKUP);
  assert.match(b.notify.list[0].text, /database not found/);
});

test('a sudden drop in a core table between snapshots raises a warning', { skip: NO_SQLITE }, async (t) => {
  const b = mkBackup(t, { rows: 500 });
  await backup.createBackup(b.ctx);
  const live = new Database(b.ctx.dbFile);
  live.prepare('DELETE FROM candidates WHERE id > 200').run();
  live.close();
  b.advance(DAY);
  await backup.createBackup(b.ctx);
  const n = b.notify.list.find((x) => x.key === 'backup-shrunk');
  assert.ok(n);
  assert.match(n.text, /candidates 500 -> 200/);
  assert.equal(n.severity, 'warn');
});

test('a large database streams through encryption without loading it whole', { skip: NO_SQLITE, timeout: 120000 }, async (t) => {
  const home = H.mkHome(t, 'big');
  const big = path.join(home, 'big.bin');
  const fd = fs.openSync(big, 'w');
  const chunk = require('crypto').randomBytes(1024 * 1024);
  for (let i = 0; i < 24; i++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  const enc = path.join(home, 'big.enc');
  const dec = path.join(home, 'big.out');
  // the payload is gzip-wrapped by encryptFile, so a raw 24 MB file exercises multiple stream chunks
  await backup.encryptFile(big, enc, PASS, { log2n: 12 });
  await backup.decryptFile(enc, dec, PASS);
  assert.equal(require(path.join(H.SRC_SCRIPTS, 'lib', 'fsx.js')).sha256File(dec), require(path.join(H.SRC_SCRIPTS, 'lib', 'fsx.js')).sha256File(big));
});

// --- CLI ----------------------------------------------------------------------------------------

test('CLI: --auto, --list, --verify, --restore (refuses to overwrite), --check-age and usage errors', { skip: NO_SQLITE, timeout: 120000 }, (t) => {
  const home = H.mkHome(t, 'backupcli');
  H.installScripts(home);
  makeDb(path.join(home, 'candidates.db'), 40);
  fs.mkdirSync(path.join(home, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(home, 'secrets', 'pass.txt'), `${PASS}\n`);
  const run = (args, extraEnv) => spawnSync(process.execPath, [path.join(home, 'scripts', 'backup-db.js'), ...args], {
    cwd: home, encoding: 'utf8', env: { ...process.env, RESOURCER_HOME: home, BACKUP_PASSPHRASE: PASS, ...(extraEnv || {}) },
  });
  let r = run(['--auto']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  r = run(['--list']);
  assert.equal(r.status, 0);
  const name = /candidates-\d{8}-\d{6}\.db\.gz\.enc/.exec(r.stdout)[0];
  const file = path.join(home, 'backups', name);
  r = run(['--verify', file]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).tables.candidates, 40);
  const out = path.join(home, 'restored.db');
  r = run(['--restore', file, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(out));
  r = run(['--restore', file, '--out', out]);
  assert.notEqual(r.status, 0, 'refuses to overwrite');
  assert.match(r.stderr, /exists/);
  r = run(['--restore', file, '--out', out, '--force']);
  assert.equal(r.status, 0);
  r = run(['--verify', file, '--passphrase-file', path.join(home, 'secrets', 'pass.txt')], { BACKUP_PASSPHRASE: '' });
  assert.equal(r.status, 0, r.stderr);
  r = run(['--verify', file], { BACKUP_PASSPHRASE: 'the wrong passphrase!!' });
  assert.equal(r.status, backup.EXIT.RESTORE);
  assert.doesNotMatch(r.stderr + r.stdout, /the wrong passphrase/, 'the passphrase is never echoed');
  r = run(['--restore-test']);
  assert.equal(r.status, 0, r.stderr);
  r = run(['--check-age']);
  assert.equal(r.status, 0);
  assert.equal(run(['--help']).status, 0);
  assert.equal(run(['--bogus']).status, backup.EXIT.USAGE);
  assert.equal(run(['--restore', file]).status, backup.EXIT.USAGE);
  assert.equal(run(['--auto'], { BACKUP_PASSPHRASE: '' }).status, backup.EXIT.BACKUP, 'no passphrase: refuse');
});

test('the upload child never receives the backup passphrase', { skip: NO_SQLITE }, async (t) => {
  const b = mkBackup(t, { rows: 3 });
  const script = uploadScript(b.home, "require('fs').writeFileSync(process.argv[2], JSON.stringify({ leaked: process.env.BACKUP_PASSPHRASE || null }));");
  const marker = path.join(b.home, 'env-marker.json');
  b.ctx.uploadCmd = () => JSON.stringify([process.execPath, script, marker]);
  process.env.BACKUP_PASSPHRASE = PASS;
  t.after(() => { delete process.env.BACKUP_PASSPHRASE; });
  const created = await backup.createBackup(b.ctx);
  const r = await backup.uploadBackup(b.ctx, created);
  assert.equal(r.ok, true);
  assert.equal(H.readJson(marker).leaked, null);
});

test('runtime/backup-status.json records each nightly outcome for the dashboard', { skip: NO_SQLITE }, async (t) => {
  const b = mkBackup(t, { rows: 10 });
  const status = () => H.readJson(path.join(b.home, 'runtime', 'backup-status.json'));
  assert.equal(await backup.runAuto(b.ctx), backup.EXIT.OK);
  assert.equal(status().ok, true);
  assert.equal(status().finishedAt, new Date(b.clock()).toISOString());
  assert.equal(status().error, undefined);
  fs.writeFileSync(b.ctx.dbFile, Buffer.alloc(4096, 0x5a));
  b.advance(DAY);
  assert.equal(await backup.runAuto(b.ctx), backup.EXIT.BACKUP);
  assert.equal(status().ok, false);
  assert.ok(status().error && status().error.length > 5);
});

test('the scratch directory is outside backups/ so a leftover cannot look like a fresh backup', { skip: NO_SQLITE }, async (t) => {
  const b = mkBackup(t, { rows: 3 });
  await backup.createBackup(b.ctx);
  assert.equal(path.relative(b.ctx.dir, b.ctx.tmpDir).startsWith('..'), true);
  assert.equal(fs.existsSync(path.join(b.ctx.dir, '.tmp')), false);
});

test('the default key-derivation cost is scrypt 2^17 (the bundle\'s cost); files written at the older 2^15 still restore', async (t) => {
  const home = H.mkHome(t, 'kdfcost');
  const src = path.join(home, 'plain.bin');
  fs.writeFileSync(src, 'payload that is small but real');
  const now = path.join(home, 'now.enc');
  await backup.encryptFile(src, now, PASS);
  assert.equal(fs.readFileSync(now).subarray(0, 4).toString('ascii'), 'RSBK');
  assert.equal(fs.readFileSync(now)[6], 17, 'header byte 6 is log2(N)');
  const old = path.join(home, 'old.enc');
  await backup.encryptFile(src, old, PASS, { log2n: 15 });
  assert.equal(fs.readFileSync(old)[6], 15);
  for (const [enc, out] of [[now, 'now.out'], [old, 'old.out']]) {
    await backup.decryptFile(enc, path.join(home, out), PASS);
    assert.equal(fs.readFileSync(path.join(home, out), 'utf8'), 'payload that is small but real');
  }
});
