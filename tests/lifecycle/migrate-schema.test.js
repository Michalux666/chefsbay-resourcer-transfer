'use strict';
const { makeWorkspace } = require('./helpers/workspace');
const ws = makeWorkspace('lc-mig');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const Database = require('./helpers/sqlite');
const { createLegacyDb } = require('./helpers/legacy-schema');

const SCRIPT = path.resolve(__dirname, '../../resourcer/scripts/migrate-schema.js');
const migrateLib = require(SCRIPT);

test.after(() => ws.cleanup());

function cli(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, RESOURCER_HOME: ws.home, ...(env || {}) } });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

const ROWS = [
  { caterer_id: 101, unlocked: 1, zoho_id: 'z1' }, { caterer_id: 102, unlocked: 0 },
  { reed_id: 201, source: 'reed', unlocked: 1, zoho_id: 'z2' }, { caterer_id: 103, unlocked: 1 },
];

function fingerprint(file) {
  const db = new Database(file, { readonly: true });
  try {
    const schema = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    const h = crypto.createHash('sha256');
    h.update(JSON.stringify(schema));
    return h.digest('hex');
  } finally { db.close(); }
}

function dataHash(file, table, cols) {
  const db = new Database(file, { readonly: true });
  try {
    const rows = db.prepare(`SELECT ${cols} FROM ${table} ORDER BY 1`).all();
    return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  } finally { db.close(); }
}

// Column list of research/dashboard-parity.md section 4.5, written out independently of the implementation.
const EXPECTED_RUN_RESULTS = [
  ['run_key', 'TEXT', 0, 1], ['date', 'TEXT', 1, 0],
  ['started_at', 'TEXT', 0, 0], ['completed_at', 'TEXT', 0, 0], ['requested_at', 'TEXT', 0, 0], ['phase1_started_at', 'TEXT', 0, 0],
  ['job_title', 'TEXT', 0, 0], ['location', 'TEXT', 0, 0], ['distance', 'INTEGER', 0, 0], ['keywords', 'TEXT', 0, 0], ['sources', 'TEXT', 0, 0],
  ['pool', 'INTEGER', 0, 0],
  ['downloaded', 'INTEGER', 0, 0], ['new_to_zoho', 'INTEGER', 0, 0], ['duplicates', 'INTEGER', 0, 0], ['skipped', 'INTEGER', 0, 0], ['errors', 'INTEGER', 0, 0],
  ['approved_p1', 'INTEGER', 0, 0], ['skipped_db', 'INTEGER', 0, 0], ['skipped_review', 'INTEGER', 0, 0], ['pages_scraped', 'INTEGER', 0, 0],
  ['total_runtime_secs', 'INTEGER', 0, 0], ['phase2_runtime_secs', 'INTEGER', 0, 0],
  ['credits_remaining', 'INTEGER', 0, 0], ['screening_model', 'TEXT', 0, 0],
  ['caterer_json', 'TEXT', 0, 0], ['reed_json', 'TEXT', 0, 0],
  ['created_at', 'TEXT', 0, 0],
];

function journalMode(file) {
  const d = new Database(file, { readonly: true });
  try { return d.pragma('journal_mode', { simple: true }); } finally { d.close(); }
}

function freshLegacy(opts) {
  ws.reset();
  createLegacyDb(ws.db, { rows: ROWS, ...(opts || {}) });
  return ws.db;
}

test('migrates the legacy schema: run_results exactly per 4.5, index, reason_code, data untouched', () => {
  freshLegacy();
  const before = { cand: dataHash(ws.db, 'candidates', '*'), terr: dataHash(ws.db, 'territory_searches', '*'), rej: dataHash(ws.db, 'candidate_rejections', 'id, caterer_id, reed_id, job_title, rejected_at, origin') };
  const r = cli(['--db', ws.db, '--json']);
  assert.equal(r.code, 0, r.err + r.out);
  const j = r.json();
  assert.equal(j.ok, true);
  const steps = Object.fromEntries(j.steps.map(s => [s.name, s.status]));
  assert.equal(steps.run_results, 'applied');
  assert.equal(steps.rejections, 'applied');
  assert.equal(steps.candidates, 'present');

  const db = new Database(ws.db, { readonly: true });
  try {
    const cols = db.prepare('PRAGMA table_info(run_results)').all();
    assert.deepEqual(cols.map(c => [c.name, c.type, c.notnull, c.pk]), EXPECTED_RUN_RESULTS);
    assert.equal(cols.find(c => c.name === 'created_at').dflt_value, "datetime('now')");
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_run_results_date'").get();
    assert.match(idx.sql, /ON run_results\(date, completed_at\)/);
    const rej = db.prepare('PRAGMA table_info(candidate_rejections)').all().find(c => c.name === 'reason_code');
    assert.ok(rej);
    assert.equal(rej.notnull, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM candidate_rejections WHERE reason_code IS NOT NULL').get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'").get().n, 2);
  } finally { db.close(); }
  assert.equal(dataHash(ws.db, 'candidates', '*'), before.cand);
  assert.equal(dataHash(ws.db, 'territory_searches', '*'), before.terr);
  assert.equal(dataHash(ws.db, 'candidate_rejections', 'id, caterer_id, reed_id, job_title, rejected_at, origin'), before.rej);
});

test('idempotent: second run changes nothing, takes no backup, reports present', () => {
  freshLegacy();
  const first = cli(['--db', ws.db, '--json']);
  assert.equal(first.code, 0);
  const fp1 = fingerprint(ws.db);
  const backups1 = fs.readdirSync(ws.dir('backups'));
  assert.equal(backups1.length, 1, 'one pre-migration backup');
  const second = cli(['--db', ws.db, '--json']);
  assert.equal(second.code, 0, second.err);
  const j = second.json();
  for (const s of j.steps) assert.ok(['present', 'skipped'].includes(s.status), `${s.name}: ${s.status}`);
  assert.equal(j.backup, null);
  assert.equal(fingerprint(ws.db), fp1);
  assert.deepEqual(fs.readdirSync(ws.dir('backups')), backups1);
  const third = cli(['--db', ws.db]);
  assert.equal(third.code, 0);
  assert.match(third.out, /\[migrate-schema\] OK/);
});

test('the pre-migration backup is a usable copy with the same rows', () => {
  freshLegacy();
  const r = cli(['--db', ws.db, '--json']).json();
  assert.ok(r.backup && r.backup.startsWith(ws.dir('backups')));
  const b = new Database(r.backup, { readonly: true });
  try {
    assert.equal(b.prepare('SELECT COUNT(*) AS n FROM candidates').get().n, ROWS.length);
    assert.equal(b.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='run_results'").get().n, 0, 'backup predates the migration');
  } finally { b.close(); }
});

test('WAL is enabled when the volume supports it, otherwise skipped with a warning (never an error)', () => {
  freshLegacy();
  const j = cli(['--db', ws.db, '--json']).json();
  const step = j.steps.find(s => s.name === 'journal_mode');
  const mode = journalMode(ws.db);
  if (step.status === 'applied') {
    assert.equal(mode, 'wal');
    assert.deepEqual(j.warnings, []);
    // a second connection reads while the first writes
    const a = new Database(ws.db);
    const b = new Database(ws.db);
    a.exec('BEGIN IMMEDIATE');
    a.prepare('INSERT INTO candidates (caterer_id, source) VALUES (999, \'caterer\')').run();
    assert.equal(b.prepare('SELECT COUNT(*) AS n FROM candidates WHERE caterer_id = 999').get().n, 0, 'reader sees the pre-commit state');
    a.exec('COMMIT');
    assert.equal(b.prepare('SELECT COUNT(*) AS n FROM candidates WHERE caterer_id = 999').get().n, 1);
    a.close(); b.close();
  } else {
    assert.equal(step.status, 'skipped');
    assert.equal(j.warnings.length, 1);
    assert.equal(mode, 'delete');
  }
  assert.equal(j.ok, true);
  const probeLeftovers = fs.readdirSync(ws.logs).filter(n => n.startsWith('.wal-probe'));
  assert.deepEqual(probeLeftovers, [], 'probe files removed');
});

test('WAL is refused on an unsafe filesystem verdict and the database keeps its journal mode', () => {
  freshLegacy();
  const v = migrateLib.walFilesystemVerdict(ws.home);
  assert.equal(typeof v.ok, 'boolean');
  const db = new Database(ws.db);
  const orig = fs.statfsSync;
  try {
    if (process.platform !== 'win32') {
      fs.statfsSync = () => ({ type: 0x01021997 });
      const res = migrateLib.configureJournal(Database, db, ws.db, 'wal', ws.logs);
      assert.equal(res.status, 'skipped');
      assert.match(res.warning, /9p/);
      assert.equal(db.pragma('journal_mode', { simple: true }), 'delete');
    }
  } finally { fs.statfsSync = orig; db.close(); }
});

test('--journal-mode keep / delete', () => {
  freshLegacy();
  const keep = cli(['--db', ws.db, '--journal-mode', 'keep', '--json']).json();
  assert.equal(keep.steps.find(s => s.name === 'journal_mode').status, 'skipped');
  assert.equal(journalMode(ws.db), 'delete');
  cli(['--db', ws.db, '--journal-mode', 'wal', '--json']);
  const del = cli(['--db', ws.db, '--journal-mode', 'delete', '--json']).json();
  assert.equal(del.ok, true);
  assert.equal(journalMode(ws.db), 'delete');
});

test('pre-2026-08-24 schema: timestamp columns and both triggers are added and work', () => {
  freshLegacy({ old: true });
  const j = cli(['--db', ws.db, '--json']).json();
  assert.equal(j.steps.find(s => s.name === 'candidates').status, 'applied');
  const db = new Database(ws.db);
  try {
    const cols = db.prepare('PRAGMA table_info(candidates)').all().map(c => c.name);
    assert.ok(cols.includes('created_at') && cols.includes('zoho_pushed_at'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE created_at IS NOT NULL').get().n, 0, 'existing rows are not back-dated');
    db.prepare("INSERT INTO candidates (caterer_id, source) VALUES (555, 'caterer')").run();
    assert.ok(db.prepare('SELECT created_at FROM candidates WHERE caterer_id = 555').get().created_at);
    db.prepare("UPDATE candidates SET zoho_id = 'zz' WHERE caterer_id = 555").run();
    assert.ok(db.prepare('SELECT zoho_pushed_at FROM candidates WHERE caterer_id = 555').get().zoho_pushed_at);
    db.prepare("UPDATE candidates SET zoho_id = 'zz2' WHERE caterer_id = 555").run();
  } finally { db.close(); }
});

test('legacy triggers on the real schema are preserved byte for byte', () => {
  freshLegacy();
  const trig = () => {
    const db = new Database(ws.db, { readonly: true });
    try { return db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(); } finally { db.close(); }
  };
  const before = trig();
  cli(['--db', ws.db, '--json']);
  assert.deepEqual(trig(), before);
});

test('candidate_rejections is never created when absent (a missing table selects the legacy skip rule)', () => {
  ws.reset();
  const db = new Database(ws.db);
  db.exec('CREATE TABLE candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, caterer_id INTEGER UNIQUE, reed_id INTEGER UNIQUE, source TEXT NOT NULL DEFAULT \'caterer\', unlocked INTEGER DEFAULT 0, zoho_id TEXT)');
  db.close();
  const j = cli(['--db', ws.db, '--json']).json();
  assert.equal(j.steps.find(s => s.name === 'rejections').status, 'skipped');
  const chk = new Database(ws.db, { readonly: true });
  assert.equal(chk.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='candidate_rejections'").get().n, 0);
  chk.close();
});

test('empty database (no legacy tables) migrates to just run_results', () => {
  ws.reset();
  new Database(ws.db).close();
  const j = cli(['--db', ws.db, '--json']).json();
  assert.equal(j.ok, true);
  assert.equal(j.steps.find(s => s.name === 'candidates').status, 'skipped');
  assert.equal(j.steps.find(s => s.name === 'run_results').status, 'applied');
});

test('run_results column drift: an older/partial table gains the missing nullable columns, rows kept', () => {
  freshLegacy();
  const db = new Database(ws.db);
  db.exec('CREATE TABLE run_results (run_key TEXT PRIMARY KEY, date TEXT NOT NULL, new_to_zoho INTEGER)');
  db.prepare("INSERT INTO run_results (run_key, date, new_to_zoho) VALUES ('k1', '2026-09-01', 4)").run();
  db.close();
  const j = cli(['--db', ws.db, '--json']).json();
  assert.equal(j.ok, true);
  const chk = new Database(ws.db, { readonly: true });
  const cols = chk.prepare('PRAGMA table_info(run_results)').all().map(c => c.name);
  assert.deepEqual(cols.sort(), EXPECTED_RUN_RESULTS.map(c => c[0]).sort());
  assert.equal(chk.prepare("SELECT new_to_zoho AS n FROM run_results WHERE run_key = 'k1'").get().n, 4);
  chk.close();
});

test('--dry-run reports what would change and writes nothing (no backup, no schema change)', () => {
  freshLegacy();
  const fp = fingerprint(ws.db);
  const j = cli(['--db', ws.db, '--dry-run', '--json']).json();
  assert.equal(j.ok, true);
  assert.equal(j.dryRun, true);
  assert.ok(j.steps.some(s => s.status === 'would-apply'));
  assert.equal(fingerprint(ws.db), fp);
  assert.equal(fs.readdirSync(ws.dir('backups')).length, 0);
  assert.equal(journalMode(ws.db), 'delete');
});

test('real errors exit non-zero: missing database, garbage file, unusable path', () => {
  ws.reset();
  const missing = cli(['--db', path.join(ws.home, 'nope.db')]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /database not found/);
  const garbage = path.join(ws.home, 'garbage.db');
  fs.writeFileSync(garbage, 'this is not a sqlite database at all, just text '.repeat(50));
  const bad = cli(['--db', garbage, '--json']);
  assert.equal(bad.code, 1);
  assert.equal(bad.json().ok, false);
  assert.ok(bad.json().errors.length >= 1);
  const created = cli(['--db', path.join(ws.home, 'fresh.db'), '--create', '--json']);
  assert.equal(created.code, 0, created.err);
  assert.equal(created.json().steps.find(s => s.name === 'run_results').status, 'applied');
});

test('usage: --help exits 0, unknown or bad flags exit 2', () => {
  assert.equal(cli(['--help']).code, 0);
  assert.match(cli(['--help']).out, /Usage: node scripts\/migrate-schema\.js/);
  assert.equal(cli(['--nonsense']).code, 2);
  assert.equal(cli(['--journal-mode', 'fast']).code, 2);
  assert.equal(cli(['--busy-timeout-ms', '-5']).code, 2);
  assert.equal(cli(['--db']).code, 2, 'a flag without its value must not silently fall back to the default database');
  assert.equal(cli(['--db', '--dry-run']).code, 2);
  assert.equal(cli(['--journal-mode']).code, 2);
});

test('busy_timeout: a competing writer that lets go within the timeout does not fail the migration', async () => {
  freshLegacy();
  const holder = new Database(ws.db);
  holder.exec('BEGIN IMMEDIATE');
  holder.prepare("INSERT INTO candidates (caterer_id, source) VALUES (777, 'caterer')").run();
  const child = spawn(process.execPath, [SCRIPT, '--db', ws.db, '--json', '--busy-timeout-ms', '8000', '--journal-mode', 'keep'], { env: { ...process.env, RESOURCER_HOME: ws.home } });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  await new Promise(r => setTimeout(r, 700));
  holder.exec('COMMIT');
  holder.close();
  const code = await new Promise(r => child.on('close', r));
  assert.equal(code, 0, out);
  assert.equal(JSON.parse(out).ok, true);
});

test('library API: ensureRunResults is callable on any connection and idempotent', () => {
  ws.reset();
  const db = new Database(ws.db);
  migrateLib.ensureRunResults(db);
  migrateLib.ensureRunResults(db);
  assert.equal(migrateLib.tableExists(db, 'run_results'), true);
  assert.equal(migrateLib.columnNames(db, 'run_results').size, EXPECTED_RUN_RESULTS.length);
  db.close();
});
