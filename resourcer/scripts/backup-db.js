#!/usr/bin/env node
'use strict';
/**
 * backup-db.js - nightly encrypted snapshot of candidates.db, retention, restore test, upload hook.
 *
 * Snapshot: SQLite online backup (consistent while the pipeline writes) -> PRAGMA integrity_check on
 * the copy -> gzip -> AES-256-GCM (key = scrypt of BACKUP_PASSPHRASE or secrets/backup-passphrase)
 * -> backups/candidates-<UTC yyyymmdd-hhmmss>.db.gz.enc plus a .json manifest (sha256, per-table row
 * counts). The plaintext copy exists only under backups/.tmp for the duration of the run.
 *
 * File layout (all fields fixed size, no other framing):
 *   0 magic 'RSBK' | 4 version u8 (1) | 5 kdf u8 (1 = scrypt) | 6 log2(N) u8 | 7 r u8 (8) | 8 p u8 (1)
 *   9 salt[16] | 25 iv[12] | 37 ciphertext (gzip stream) | last 16 bytes: GCM tag. AAD = bytes 0..36.
 *
 * Usage:
 *   node scripts/backup-db.js [--auto | --backup]      --auto = backup + prune + upload + due restore test
 *   node scripts/backup-db.js --restore-test [--file <backup>]
 *   node scripts/backup-db.js --check-age
 *   node scripts/backup-db.js --list
 *   node scripts/backup-db.js --verify <file> | --restore <file> --out <path> [--force]
 *   (decrypt commands also accept --passphrase-file <path>)
 * Exit: 0 ok, 1 backup failed, 2 usage, 3 restore test/verify failed, 4 backup too old, 5 upload failed
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const paths = require('./lib/paths');
const env = require('./lib/env');
const fsx = require('./lib/fsx');
const timeLib = require('./lib/time');
const tick = require('./lib/tick');

const MAGIC = Buffer.from('RSBK', 'ascii');
const FORMAT_VERSION = 1;
const HEADER_LEN = 37;
const TAG_LEN = 16;
const KEY_LEN = 32;
const LOG2N = 17;
const MAX_LOG2N = 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const MIN_PASSPHRASE = 16;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const STALE_AFTER_MS = 26 * HOUR_MS;
const RETENTION = { daily: 14, weekly: 8 };
const NAME_RE = /^candidates-(\d{8})-(\d{6})\.db\.gz\.enc$/;
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const WATCHED_TABLES = ['candidates', 'candidate_rejections', 'territory_searches'];

const EXIT = { OK: 0, BACKUP: 1, USAGE: 2, RESTORE: 3, STALE: 4, UPLOAD: 5 };

function makeCtx(over) {
  const o = over || {};
  const home = o.home ? path.resolve(o.home) : paths.HOME;
  const files = tick.runtimeFiles(home);
  const dir = path.join(home, 'backups');
  return Object.assign({
    home,
    files,
    dir,
    tmpDir: path.join(home, 'state', 'backup-tmp'),
    dbFile: path.join(home, 'candidates.db'),
    stateFile: path.join(files.dir, 'backup-state.json'),
    now: () => Date.now(),
    notify: (a) => require('./lib/notify').notify(a),
    passphrase: () => loadPassphrase(home),
    sqlite: () => require('better-sqlite3'),
    log: (m) => console.log(`[backup] ${new Date().toISOString()} ${env.redact(m)}`),
    uploadCmd: () => env.get('BACKUP_UPLOAD_CMD'),
    uploadEnv: () => env.get('BACKUP_UPLOAD_ENV', ''),
    log2n: LOG2N,
  }, o);
}

function loadPassphrase(home) {
  let p = env.get('BACKUP_PASSPHRASE');
  if (!p) {
    try { p = fs.readFileSync(path.join(home, 'secrets', 'backup-passphrase'), 'utf8').split(/\r?\n/)[0].trim(); } catch { p = null; }
  }
  return p || null;
}

function requirePassphrase(ctx) {
  const p = ctx.passphrase();
  if (!p) throw new Error('no backup passphrase: set BACKUP_PASSPHRASE in the profile .env or create secrets/backup-passphrase (refusing to write an unencrypted backup)');
  if (p.length < MIN_PASSPHRASE) throw new Error(`backup passphrase is shorter than ${MIN_PASSPHRASE} characters`);
  return p;
}

function deriveKey(passphrase, salt, log2n, r, p) {
  return crypto.scryptSync(passphrase, salt, KEY_LEN, { N: 2 ** log2n, r, p, maxmem: 256 * 1024 * 1024 });
}

function buildHeader(salt, iv, log2n) {
  const h = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(h, 0);
  h[4] = FORMAT_VERSION;
  h[5] = 1;
  h[6] = log2n;
  h[7] = SCRYPT_R;
  h[8] = SCRYPT_P;
  salt.copy(h, 9);
  iv.copy(h, 25);
  return h;
}

async function encryptFile(src, dest, passphrase, opts) {
  const log2n = (opts && opts.log2n) || LOG2N;
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const header = buildHeader(salt, iv, log2n);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt, log2n, SCRYPT_R, SCRYPT_P), iv);
  cipher.setAAD(header);
  const tagAppender = new Transform({
    transform(chunk, enc, cb) { cb(null, chunk); },
    flush(cb) { cb(null, cipher.getAuthTag()); },
  });
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  fsx.ensureDir(path.dirname(dest));
  fs.writeFileSync(tmp, header, { mode: 0o600 });
  try {
    await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 9 }), cipher, tagAppender, fs.createWriteStream(tmp, { flags: 'a', mode: 0o600 }));
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* not created */ }
    throw e;
  }
}

async function decryptFile(src, dest, passphrase) {
  const size = fs.statSync(src).size;
  if (size < HEADER_LEN + TAG_LEN + 1) throw new Error('not a backup file (too short)');
  const fd = fs.openSync(src, 'r');
  const header = Buffer.alloc(HEADER_LEN);
  const tag = Buffer.alloc(TAG_LEN);
  try {
    fs.readSync(fd, header, 0, HEADER_LEN, 0);
    fs.readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    fs.closeSync(fd);
  }
  if (!header.subarray(0, 4).equals(MAGIC) || header[4] !== FORMAT_VERSION || header[5] !== 1) throw new Error('not a backup file (bad header)');
  if (header[6] > MAX_LOG2N || header[6] < 10) throw new Error('backup header has an unsupported key-derivation cost');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, header.subarray(9, 25), header[6], header[7], header[8]), header.subarray(25, 37));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const partial = `${dest}.${process.pid}.partial`;
  fsx.ensureDir(path.dirname(dest));
  try {
    await pipeline(
      fs.createReadStream(src, { start: HEADER_LEN, end: size - TAG_LEN - 1 }),
      decipher,
      zlib.createGunzip(),
      fs.createWriteStream(partial, { mode: 0o600 }),
    );
    fs.renameSync(partial, dest);
  } catch (e) {
    try { fs.unlinkSync(partial); } catch { /* not created */ }
    throw new Error('decryption failed: wrong passphrase or the file is corrupted or truncated');
  }
}

function rmDbFiles(file) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.unlinkSync(file + suffix); } catch { /* not present */ }
  }
}

function quoteIdent(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

function inspectDb(Database, file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = db.pragma('integrity_check');
    const integrity = rows.length === 1 && String(rows[0].integrity_check) === 'ok' ? 'ok' : rows.slice(0, 3).map((r) => r.integrity_check).join('; ');
    const tables = {};
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      tables[t.name] = db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(t.name)}`).get().c;
    }
    return { integrity, tables };
  } finally {
    db.close();
  }
}

function utcStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

// runtime/backup-status.json is what the dashboard shows for the backup job.
function writeStatus(ctx, ok, error) {
  try {
    fsx.writeJsonAtomic(path.join(ctx.files.dir, 'backup-status.json'), Object.assign({ ok, finishedAt: new Date(ctx.now()).toISOString() }, error ? { error: String(error).slice(0, 300) } : {}));
  } catch { /* informational */ }
}

function readState(ctx) {
  const s = fsx.readJson(ctx.stateFile, {});
  return s && typeof s === 'object' ? s : {};
}

function writeState(ctx, patch) {
  const s = Object.assign(readState(ctx), patch);
  fsx.writeJsonAtomic(ctx.stateFile, s);
  return s;
}

function parseBackupName(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const y = +m[1].slice(0, 4);
  const mo = +m[1].slice(4, 6);
  const d = +m[1].slice(6, 8);
  const hh = +m[2].slice(0, 2);
  const mi = +m[2].slice(2, 4);
  const ss = +m[2].slice(4, 6);
  return { name, date: new Date(Date.UTC(y, mo - 1, d, hh, mi, ss)), ymd: m[1] };
}

function isoWeekKey(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t - y0) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}

function listBackups(ctx) {
  let names = [];
  try { names = fs.readdirSync(ctx.dir); } catch { return []; }
  return names.map(parseBackupName).filter(Boolean).sort((a, b) => b.date - a.date);
}

// Keep the newest backup of each of the last `daily` distinct days and of the last `weekly` ISO weeks.
function selectKeep(entries, retention) {
  const r = Object.assign({}, RETENTION, retention);
  const keep = new Set();
  const days = new Set();
  for (const e of entries) {
    if (!days.has(e.ymd) && days.size < r.daily) { days.add(e.ymd); keep.add(e.name); }
  }
  const weeks = new Set();
  for (const e of entries) {
    const k = isoWeekKey(e.date);
    if (!weeks.has(k) && weeks.size < r.weekly) { weeks.add(k); keep.add(e.name); }
  }
  return keep;
}

function pruneBackups(ctx, retention) {
  const entries = listBackups(ctx);
  const keep = selectKeep(entries, retention);
  const removed = [];
  for (const e of entries) {
    if (keep.has(e.name)) continue;
    for (const f of [e.name, e.name.replace(/\.db\.gz\.enc$/, '.json')]) {
      try { fs.unlinkSync(path.join(ctx.dir, f)); } catch { /* already gone */ }
    }
    removed.push(e.name);
  }
  return { kept: keep.size, removed };
}

function cleanTmp(ctx) {
  try {
    for (const f of fs.readdirSync(ctx.tmpDir)) {
      const fp = path.join(ctx.tmpDir, f);
      try { if (ctx.now() - fs.statSync(fp).mtimeMs > HOUR_MS) fs.unlinkSync(fp); } catch { /* ignore */ }
    }
  } catch { /* no tmp dir yet */ }
}

async function createBackup(ctx) {
  const passphrase = requirePassphrase(ctx);
  const Database = ctx.sqlite();
  if (!fs.existsSync(ctx.dbFile)) throw new Error(`database not found: ${ctx.dbFile}`);
  fsx.ensureDir(ctx.dir, 0o700);
  fsx.ensureDir(ctx.tmpDir, 0o700);
  for (const d of [ctx.dir, ctx.tmpDir]) { try { fs.chmodSync(d, 0o700); } catch { /* not ours to change */ } }
  cleanTmp(ctx);
  const startedMs = ctx.now();
  const stamp = utcStamp(startedMs);
  const name = `candidates-${stamp}.db.gz.enc`;
  const tmpDb = path.join(ctx.tmpDir, `candidates-${stamp}.${process.pid}.db`);
  const out = path.join(ctx.dir, name);
  const prev = readState(ctx);
  try {
    const src = new Database(ctx.dbFile, { fileMustExist: true, timeout: 30000 });
    try { await src.backup(tmpDb); } finally { src.close(); }
    const info = inspectDb(Database, tmpDb);
    if (info.integrity !== 'ok') {
      const err = new Error(`integrity_check failed on the snapshot: ${info.integrity.slice(0, 200)}`);
      err.integrity = true;
      throw err;
    }
    const sourceBytes = fs.statSync(tmpDb).size;
    await encryptFile(tmpDb, out, passphrase, { log2n: ctx.log2n });
    const manifest = {
      version: FORMAT_VERSION, name, createdAt: new Date(startedMs).toISOString(), sourceBytes,
      bytes: fs.statSync(out).size, sha256: fsx.sha256File(out), integrity: info.integrity, tables: info.tables,
    };
    fsx.writeJsonAtomic(path.join(ctx.dir, name.replace(/\.db\.gz\.enc$/, '.json')), manifest, 0o600);
    // A sudden drop in a core table between two snapshots is the signature of data loss.
    const shrunk = [];
    for (const t of WATCHED_TABLES) {
      const before = prev.lastCounts && prev.lastCounts[t];
      if (before >= 100 && info.tables[t] !== undefined && info.tables[t] < before * 0.8) shrunk.push(`${t} ${before} -> ${info.tables[t]}`);
    }
    if (shrunk.length) {
      ctx.notify({ severity: 'warn', key: 'backup-shrunk', text: `A core table shrank by more than 20% since the previous backup (${shrunk.join(', ')}). The previous snapshot is kept; check for data loss before it ages out.` });
    }
    writeState(ctx, { lastOkAt: new Date(ctx.now()).toISOString(), lastFile: name, lastBytes: manifest.bytes, lastCounts: info.tables, lastFailureAt: null, lastFailure: null });
    ctx.log(`backup ok: ${name} (${manifest.bytes} bytes, ${Object.keys(info.tables).length} tables)`);
    return { name, file: out, manifest };
  } finally {
    rmDbFiles(tmpDb);
  }
}

function parseUploadCmd(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  let argv;
  if (v.startsWith('[')) {
    argv = JSON.parse(v);
    if (!Array.isArray(argv) || !argv.length || !argv.every((x) => typeof x === 'string')) throw new Error('BACKUP_UPLOAD_CMD must be a JSON array of strings or a plain command');
  } else {
    argv = v.split(/\s+/);
  }
  return argv;
}

function uploadBackup(ctx, created) {
  let argv;
  try { argv = parseUploadCmd(ctx.uploadCmd()); } catch (e) { return Promise.resolve({ ok: false, error: e.message }); }
  if (!argv) return Promise.resolve({ skipped: true });
  const manifestPath = created.file.replace(/\.db\.gz\.enc$/, '.json');
  const sub = (s) => s.split('{file}').join(created.file).split('{name}').join(created.name).split('{manifest}').join(manifestPath);
  const childEnv = Object.assign({}, process.env, { BACKUP_FILE: created.file, BACKUP_NAME: created.name, BACKUP_MANIFEST: manifestPath });
  delete childEnv.BACKUP_PASSPHRASE;
  for (const n of String(ctx.uploadEnv() || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const v = env.get(n);
    if (v !== undefined) childEnv[n] = v;
  }
  return new Promise((resolve) => {
    let tail = '';
    let settled = false;
    let child;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      if (child) tick.killTree(child.pid, { graceMs: 3000 }).catch(() => {});
      done({ ok: false, error: `upload exceeded ${UPLOAD_TIMEOUT_MS / 60000} min` });
    }, ctx.uploadTimeoutMs || UPLOAD_TIMEOUT_MS);
    try {
      child = spawn(argv[0], argv.slice(1).map(sub), { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv, windowsHide: true, detached: process.platform !== 'win32' });
    } catch (e) {
      done({ ok: false, error: e.message });
      return;
    }
    const keep = (d) => { tail = (tail + d.toString()).slice(-2000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (e) => done({ ok: false, error: e.code || e.message }));
    child.on('close', (code) => done(code === 0 ? { ok: true } : { ok: false, error: `exit ${code}: ${env.redact(tail).replace(/\s+/g, ' ').trim().slice(-300)}` }));
  });
}

function withinTolerance(restored, live, tol) {
  if (live < 50) return true;
  return restored >= live * (1 - tol) && restored <= live * (1 + tol) + 50;
}

async function restoreTest(ctx, opts) {
  const o = Object.assign({ tolerance: 0.1 }, opts);
  const passphrase = requirePassphrase(ctx);
  const Database = ctx.sqlite();
  const entry = o.file ? { name: path.basename(o.file) } : listBackups(ctx)[0];
  const problems = [];
  const result = { ok: false, name: entry ? entry.name : null, problems };
  if (!entry) { problems.push('no backup to test'); return finishRestoreTest(ctx, result); }
  const file = o.file ? path.resolve(o.file) : path.join(ctx.dir, entry.name);
  const manifestPath = file.replace(/\.db\.gz\.enc$/, '.json');
  const manifest = fsx.readJson(manifestPath, null);
  fsx.ensureDir(ctx.tmpDir, 0o700);
  const scratch = path.join(ctx.tmpDir, `restore-test-${process.pid}-${ctx.now()}.db`);
  try {
    if (!manifest) problems.push('manifest missing');
    else if (manifest.sha256 !== fsx.sha256File(file)) problems.push('sha256 does not match the manifest');
    await decryptFile(file, scratch, passphrase);
    const info = inspectDb(Database, scratch);
    if (info.integrity !== 'ok') problems.push(`integrity_check: ${info.integrity.slice(0, 120)}`);
    if (manifest) {
      for (const [t, c] of Object.entries(manifest.tables || {})) {
        if (info.tables[t] !== c) problems.push(`table ${t}: restored ${info.tables[t]} rows, manifest says ${c}`);
      }
    }
    if (fs.existsSync(ctx.dbFile)) {
      const live = inspectLiveCounts(Database, ctx.dbFile);
      for (const [t, c] of Object.entries(info.tables)) {
        if (live[t] !== undefined && !withinTolerance(c, live[t], o.tolerance)) problems.push(`table ${t}: restored ${c} rows vs live ${live[t]} (outside ${Math.round(o.tolerance * 100)}%)`);
      }
    }
    result.tables = info.tables;
  } catch (e) {
    problems.push(e.message);
  } finally {
    rmDbFiles(scratch);
  }
  result.ok = problems.length === 0;
  return finishRestoreTest(ctx, result);
}

function inspectLiveCounts(Database, file) {
  const db = new Database(file, { fileMustExist: true, timeout: 10000 });
  try {
    const out = {};
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      out[t.name] = db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(t.name)}`).get().c;
    }
    return out;
  } finally {
    db.close();
  }
}

function finishRestoreTest(ctx, result) {
  writeState(ctx, { lastRestoreTestAt: new Date(ctx.now()).toISOString(), lastRestoreOk: result.ok });
  if (!result.ok) {
    ctx.notify({ severity: 'critical', key: 'backup-restore-test', text: `The weekly restore test of the DB backup FAILED (${result.name || 'no file'}): ${result.problems.join('; ').slice(0, 300)}. Treat the backups as unverified until fixed (docs/OPERATIONS.md).` });
  }
  ctx.log(`restore test ${result.ok ? 'ok' : 'FAILED'}: ${result.name}${result.ok ? '' : ` - ${result.problems.join('; ')}`}`);
  return result;
}

/** Notify when the newest good backup is older than 26 h (or none has ever succeeded). */
function checkAge(over) {
  const ctx = makeCtx(over);
  const s = readState(ctx);
  const now = ctx.now();
  if (!s.firstCheckAt) {
    try { writeState(ctx, { firstCheckAt: new Date(now).toISOString() }); } catch { /* best effort */ }
    s.firstCheckAt = new Date(now).toISOString();
  }
  const ref = s.lastOkAt ? Date.parse(s.lastOkAt) : Date.parse(s.firstCheckAt);
  const ageMs = now - ref;
  const stale = ageMs > STALE_AFTER_MS;
  if (stale) {
    ctx.notify({
      severity: 'critical', key: 'backup-stale',
      text: s.lastOkAt
        ? `The newest DB backup is ${Math.round(ageMs / HOUR_MS)} h old (limit 26 h). Run: node scripts/backup-db.js --auto and check logs/backup-*.log.`
        : 'No DB backup has succeeded yet. Run: node scripts/backup-db.js --auto and check the passphrase setting (docs/OPERATIONS.md).',
      meta: { ageHours: Math.round(ageMs / HOUR_MS) },
    });
  }
  return { stale, ageHours: Math.round(ageMs / HOUR_MS), lastOkAt: s.lastOkAt || null };
}

function restoreDue(ctx) {
  const s = readState(ctx);
  const p = timeLib.londonParts(new Date(ctx.now()));
  if (!s.lastRestoreTestAt) return true;
  return p.dow === 0 || ctx.now() - Date.parse(s.lastRestoreTestAt) > 8 * DAY_MS;
}

async function runAuto(ctx) {
  let code = EXIT.OK;
  let created = null;
  try {
    created = await createBackup(ctx);
  } catch (e) {
    writeState(ctx, { lastFailureAt: new Date(ctx.now()).toISOString(), lastFailure: String(e.message).slice(0, 300) });
    ctx.notify({ severity: 'critical', key: e.integrity ? 'backup-integrity' : 'backup-failed', text: `Nightly DB backup failed: ${env.redact(e.message).slice(0, 300)}. The previous backups are untouched (docs/OPERATIONS.md).` });
    ctx.log(`backup FAILED: ${e.message}`);
    writeStatus(ctx, false, e.message);
    return EXIT.BACKUP;
  }
  writeStatus(ctx, true);
  const pruned = pruneBackups(ctx);
  if (pruned.removed.length) ctx.log(`pruned ${pruned.removed.length} old backup(s), kept ${pruned.kept}`);

  const up = await uploadBackup(ctx, created);
  if (up.ok) {
    writeState(ctx, { lastUploadOkAt: new Date(ctx.now()).toISOString() });
    ctx.log('upload ok');
  } else if (!up.skipped) {
    const s = readState(ctx);
    const lastOk = s.lastUploadOkAt ? Date.parse(s.lastUploadOkAt) : 0;
    const critical = ctx.now() - lastOk > 2 * DAY_MS + 2 * HOUR_MS;
    ctx.notify({ severity: critical ? 'critical' : 'warn', key: 'backup-upload', text: `The off-instance backup upload failed: ${up.error}. The local encrypted backup is fine, but a same-volume copy does not survive loss of the instance.` });
    ctx.log(`upload FAILED: ${up.error}`);
    code = EXIT.UPLOAD;
  }

  if (restoreDue(ctx)) {
    const rt = await restoreTest(ctx);
    if (!rt.ok) code = EXIT.RESTORE;
  }
  return code;
}

async function verifyOrRestore(ctx, file, out, force) {
  const passphrase = requirePassphrase(ctx);
  const Database = ctx.sqlite();
  const target = out ? path.resolve(out) : path.join(ctx.tmpDir, `verify-${process.pid}.db`);
  if (out && fs.existsSync(target) && !force) throw new Error(`${target} exists; pass --force to overwrite`);
  fsx.ensureDir(path.dirname(target), 0o700);
  await decryptFile(path.resolve(file), target, passphrase);
  try {
    const info = inspectDb(Database, target);
    if (info.integrity !== 'ok') throw new Error(`integrity_check failed: ${info.integrity.slice(0, 200)}`);
    return { tables: info.tables, out: out ? target : null };
  } catch (e) {
    if (out) rmDbFiles(target);
    throw e;
  } finally {
    if (!out) rmDbFiles(target);
    else { for (const suffix of ['-wal', '-shm', '-journal']) { try { fs.unlinkSync(target + suffix); } catch { /* not present */ } } }
  }
}

const USAGE = [
  'Usage: node scripts/backup-db.js [--auto | --backup]',
  '       node scripts/backup-db.js --restore-test [--file <backup>]',
  '       node scripts/backup-db.js --check-age | --list',
  '       node scripts/backup-db.js --verify <file> | --restore <file> --out <path> [--force]',
  '       (decrypt commands accept --passphrase-file <path>)',
].join('\n');

async function main(argv) {
  const has = (f) => argv.includes(f);
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  if (has('--help') || has('-h')) { console.log(USAGE); return EXIT.OK; }
  const valued = new Set(['--file', '--restore', '--verify', '--out', '--passphrase-file']);
  const bare = new Set(['--auto', '--backup', '--restore-test', '--check-age', '--list', '--force']);
  for (let i = 0; i < argv.length; i++) {
    if (valued.has(argv[i])) { i++; continue; }
    if (!bare.has(argv[i])) { console.error(`unknown argument '${argv[i]}'\n${USAGE}`); return EXIT.USAGE; }
  }
  const over = {};
  if (val('--passphrase-file')) {
    const pf = val('--passphrase-file');
    over.passphrase = () => fs.readFileSync(pf, 'utf8').split(/\r?\n/)[0].trim();
  }
  const ctx = makeCtx(over);
  try {
    if (has('--list')) {
      for (const e of listBackups(ctx)) console.log(`${e.name}  ${Math.round((ctx.now() - e.date.getTime()) / HOUR_MS)} h old`);
      return EXIT.OK;
    }
    if (has('--check-age')) {
      const r = checkAge();
      console.log(JSON.stringify(r));
      return r.stale ? EXIT.STALE : EXIT.OK;
    }
    if (has('--restore-test')) {
      const r = await restoreTest(ctx, { file: val('--file') });
      return r.ok ? EXIT.OK : EXIT.RESTORE;
    }
    if (has('--verify') || has('--restore')) {
      const file = val('--verify') || val('--restore');
      if (has('--restore') && !val('--out')) { console.error(`--restore needs --out <path>\n${USAGE}`); return EXIT.USAGE; }
      const r = await verifyOrRestore(ctx, file, has('--restore') ? val('--out') : null, has('--force'));
      console.log(JSON.stringify({ ok: true, out: r.out, tables: r.tables }));
      return EXIT.OK;
    }
    if (has('--auto')) return await runAuto(ctx);
    if (has('--backup') || argv.length === 0) {
      await createBackup(ctx);
      return EXIT.OK;
    }
  } catch (e) {
    console.error(`backup-db failed: ${env.redact(e.message)}`);
    return has('--restore') || has('--verify') || has('--restore-test') ? EXIT.RESTORE : EXIT.BACKUP;
  }
  console.error(USAGE);
  return EXIT.USAGE;
}

module.exports = {
  EXIT, RETENTION, STALE_AFTER_MS, HEADER_LEN, makeCtx, encryptFile, decryptFile, createBackup, restoreTest, checkAge,
  pruneBackups, selectKeep, listBackups, parseBackupName, isoWeekKey, uploadBackup, parseUploadCmd, runAuto, inspectDb, verifyOrRestore,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`backup-db failed: ${env.redact(e && e.message)}`);
    process.exit(EXIT.BACKUP);
  });
}
