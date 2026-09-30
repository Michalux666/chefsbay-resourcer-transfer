#!/usr/bin/env node
'use strict';
/**
 * migrate-schema.js - idempotent schema migration for candidates.db (DESIGN 5.6).
 *
 * Steps (each reports applied | present | skipped | would-apply):
 *   journal_mode   WAL when the volume supports shared memory (probed), else left alone with a warning
 *   candidates     created_at / zoho_pushed_at columns + their two triggers (only if candidates exists)
 *   rejections     nullable candidate_rejections.reason_code (only if the table exists; never created here,
 *                  because a missing table selects the legacy unscoped skip rule)
 *   run_results    table + index exactly as research/dashboard-parity.md section 4.5
 *   integrity      PRAGMA quick_check
 *
 * busy_timeout is per connection, not persistent: it is set on this connection and every
 * script that opens the DB passes its own timeout.
 *
 * Exit: 0 ok (warnings allowed), 1 real error, 2 usage.
 */
const fs = require('fs');
const path = require('path');
const paths = require('./lib/paths');
const retention = require('./lib/cv-retention');

const RUN_RESULTS_COLUMNS = [
  ['run_key', 'TEXT PRIMARY KEY'],
  ['date', 'TEXT NOT NULL'],
  ['started_at', 'TEXT'], ['completed_at', 'TEXT'], ['requested_at', 'TEXT'], ['phase1_started_at', 'TEXT'],
  ['job_title', 'TEXT'], ['location', 'TEXT'], ['distance', 'INTEGER'], ['keywords', 'TEXT'], ['sources', 'TEXT'],
  ['pool', 'INTEGER'],
  ['downloaded', 'INTEGER'], ['new_to_zoho', 'INTEGER'], ['duplicates', 'INTEGER'], ['skipped', 'INTEGER'], ['errors', 'INTEGER'],
  ['approved_p1', 'INTEGER'], ['skipped_db', 'INTEGER'], ['skipped_review', 'INTEGER'], ['pages_scraped', 'INTEGER'],
  ['total_runtime_secs', 'INTEGER'], ['phase2_runtime_secs', 'INTEGER'],
  ['credits_remaining', 'INTEGER'], ['screening_model', 'TEXT'],
  ['caterer_json', 'TEXT'], ['reed_json', 'TEXT'],
  ['created_at', "TEXT DEFAULT (datetime('now'))"],
];

const RUN_RESULTS_DDL = `CREATE TABLE IF NOT EXISTS run_results (
  ${RUN_RESULTS_COLUMNS.map(([n, t]) => `${n} ${t}`).join(',\n  ')}
)`;
const RUN_RESULTS_INDEX = 'CREATE INDEX IF NOT EXISTS idx_run_results_date ON run_results(date, completed_at)';

const TRIGGER_CREATED = `CREATE TRIGGER IF NOT EXISTS candidates_set_created_at
  AFTER INSERT ON candidates
  FOR EACH ROW WHEN NEW.created_at IS NULL
  BEGIN
    UPDATE candidates SET created_at = datetime('now') WHERE id = NEW.id;
  END`;
const TRIGGER_PUSHED = `CREATE TRIGGER IF NOT EXISTS candidates_set_zoho_pushed_at
  AFTER UPDATE OF zoho_id ON candidates
  FOR EACH ROW WHEN NEW.zoho_id IS NOT NULL AND OLD.zoho_id IS NULL
  BEGIN
    UPDATE candidates SET zoho_pushed_at = datetime('now') WHERE id = NEW.id;
  END`;

// Filesystem magic numbers (statfs f_type) where SQLite shared-memory WAL is unreliable.
const WAL_UNSAFE_FS = new Map([
  [0x01021997, '9p'], [0x65735546, 'fuse/virtiofs'], [0x6969, 'nfs'], [0x517b, 'smb'],
  [0xff534d42, 'cifs'], [0xfe534d42, 'smb2'], [0x786f4256, 'vboxsf'],
]);

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
}

function triggerExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name);
}

// ---- pending checks (pure reads) ------------------------------------------------------------

function candidatesPending(db) {
  if (!tableExists(db, 'candidates')) return { needed: false, skipped: 'no candidates table' };
  const cols = columnNames(db, 'candidates');
  const todo = [];
  if (!cols.has('created_at')) todo.push('column created_at');
  if (!cols.has('zoho_pushed_at')) todo.push('column zoho_pushed_at');
  if (!triggerExists(db, 'candidates_set_created_at')) todo.push('trigger candidates_set_created_at');
  if (!triggerExists(db, 'candidates_set_zoho_pushed_at')) todo.push('trigger candidates_set_zoho_pushed_at');
  return { needed: todo.length > 0, todo };
}

function rejectionsPending(db) {
  if (!tableExists(db, 'candidate_rejections')) return { needed: false, skipped: 'candidate_rejections table absent (created lazily by the pipeline)' };
  return columnNames(db, 'candidate_rejections').has('reason_code') ? { needed: false } : { needed: true, todo: ['column reason_code'] };
}

function runResultsPending(db) {
  if (!tableExists(db, 'run_results')) return { needed: true, todo: ['table run_results', 'index idx_run_results_date'] };
  const todo = [];
  const have = columnNames(db, 'run_results');
  for (const [n] of RUN_RESULTS_COLUMNS) if (!have.has(n)) todo.push(`column ${n}`);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_run_results_date'").get()) todo.push('index idx_run_results_date');
  return { needed: todo.length > 0, todo };
}

// ---- appliers (call inside one transaction) --------------------------------------------------

function ensureCandidateTimestamps(db) {
  const p = candidatesPending(db);
  if (!p.needed) return p;
  const cols = columnNames(db, 'candidates');
  if (!cols.has('created_at')) db.exec('ALTER TABLE candidates ADD COLUMN created_at TEXT');
  if (!cols.has('zoho_pushed_at')) db.exec('ALTER TABLE candidates ADD COLUMN zoho_pushed_at TEXT');
  db.exec(TRIGGER_CREATED);
  db.exec(TRIGGER_PUSHED);
  return p;
}

function ensureReasonCode(db) {
  const p = rejectionsPending(db);
  if (p.needed) db.exec('ALTER TABLE candidate_rejections ADD COLUMN reason_code TEXT');
  return p;
}

function ensureRunResults(db) {
  const p = runResultsPending(db);
  db.exec(RUN_RESULTS_DDL);
  const have = columnNames(db, 'run_results');
  for (const [n, t] of RUN_RESULTS_COLUMNS) {
    if (have.has(n)) continue;
    // ALTER cannot add a non-constant default or a primary key
    const type = t.replace(/ PRIMARY KEY/, '').replace(/ NOT NULL/, '').replace(/ DEFAULT \(.*\)/, '');
    db.exec(`ALTER TABLE run_results ADD COLUMN ${n} ${type}`);
  }
  db.exec(RUN_RESULTS_INDEX);
  return p;
}

// ---- journal mode ------------------------------------------------------------------------------

function walFilesystemVerdict(dir) {
  if (process.platform === 'win32') return { ok: true };
  try {
    const st = fs.statfsSync(dir);
    const name = WAL_UNSAFE_FS.get(st.type);
    if (name) return { ok: false, reason: `volume type ${name} is unsafe for WAL shared memory` };
  } catch { /* statfs unavailable: fall through to the functional probe */ }
  return { ok: true };
}

// Functional probe in logs/ (same volume as the DB in the standard layout); files removed through the jail.
function walFunctionalProbe(Database, probeDir) {
  const base = path.join(probeDir, `.wal-probe-${process.pid}-${Date.now()}`);
  const file = `${base}.db`;
  let a = null;
  let b = null;
  try {
    fs.mkdirSync(probeDir, { recursive: true });
    a = new Database(file);
    if (a.pragma('journal_mode = WAL', { simple: true }) !== 'wal') return { ok: false, reason: 'volume refused WAL' };
    a.exec('CREATE TABLE t(x INTEGER)');
    b = new Database(file);
    b.pragma('busy_timeout = 2000');
    a.exec('INSERT INTO t VALUES (1)');
    if (b.prepare('SELECT COUNT(*) AS n FROM t').get().n !== 1) return { ok: false, reason: 'second connection could not see a committed write' };
    a.pragma('wal_checkpoint(PASSIVE)');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `WAL probe failed: ${String(e.message || e).slice(0, 120)}` };
  } finally {
    try { if (b) b.close(); } catch { /* ignore */ }
    try { if (a) a.close(); } catch { /* ignore */ }
    for (const suffix of ['.db', '.db-wal', '.db-shm', '.db-journal']) retention.jailedUnlink([probeDir], probeDir, path.basename(base) + suffix);
  }
}

function configureJournal(Database, db, dbPath, mode, probeDir) {
  const current = db.pragma('journal_mode', { simple: true });
  if (mode === 'keep') return { status: 'skipped', mode: current, detail: 'journal mode left as is (--journal-mode keep)' };
  if (mode === 'delete') {
    if (current === 'delete') return { status: 'present', mode: current };
    return { status: 'applied', mode: db.pragma('journal_mode = DELETE', { simple: true }) };
  }
  if (current === 'wal') return { status: 'present', mode: current };
  const fsv = walFilesystemVerdict(path.dirname(path.resolve(dbPath)));
  if (!fsv.ok) return { status: 'skipped', mode: current, warning: fsv.reason };
  const probe = walFunctionalProbe(Database, probeDir);
  if (!probe.ok) return { status: 'skipped', mode: current, warning: probe.reason };
  const after = db.pragma('journal_mode = WAL', { simple: true });
  if (after !== 'wal') return { status: 'skipped', mode: after, warning: `journal_mode stayed ${after}` };
  return { status: 'applied', mode: 'wal' };
}

// ---- driver -------------------------------------------------------------------------------------

function loadDriver() {
  return require('better-sqlite3');
}

async function migrate(opts = {}) {
  const Database = opts.Database || loadDriver();
  const dbPath = path.resolve(opts.db || paths.DB);
  const mode = opts.journalMode || 'wal';
  const dryRun = !!opts.dryRun;
  const busyMs = opts.busyTimeoutMs || 15000;
  const result = { ok: true, dbPath, dryRun, steps: [], warnings: [], errors: [], backup: null };

  const step = (name, status, detail) => {
    result.steps.push({ name, status, ...(detail ? { detail } : {}) });
  };

  if (!fs.existsSync(dbPath)) {
    if (!opts.create || dryRun) {
      result.ok = false;
      result.errors.push(`database not found: ${dbPath} (restore the data bundle first, or pass --create for a fresh install)`);
      return result;
    }
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: dryRun, fileMustExist: dryRun || !opts.create, timeout: busyMs });
    db.pragma(`busy_timeout = ${busyMs}`);
  } catch (e) {
    result.ok = false;
    result.errors.push(`cannot open database: ${String(e.message || e)}`);
    return result;
  }

  try {
    const cand = candidatesPending(db);
    const rej = rejectionsPending(db);
    const rr = runResultsPending(db);
    const journalNow = db.pragma('journal_mode', { simple: true });
    const journalWanted = mode === 'wal' ? journalNow !== 'wal' : (mode === 'delete' && journalNow !== 'delete');
    // A journal-mode flip changes no data, so only structural changes justify a backup (and a volume
    // that keeps refusing WAL must not produce a fresh backup on every run).
    const anyPending = cand.needed || rej.needed || rr.needed;

    if (dryRun) {
      const verdict = journalWanted && mode === 'wal' ? walFilesystemVerdict(path.dirname(dbPath)) : { ok: true };
      step('journal_mode', !journalWanted ? 'present' : (verdict.ok ? 'would-apply' : 'skipped'), verdict.ok ? `${journalNow} -> ${mode}` : `${journalNow} stays (${verdict.reason})`);
      step('candidates', cand.skipped ? 'skipped' : (cand.needed ? 'would-apply' : 'present'), (cand.todo || []).join(', ') || cand.skipped);
      step('rejections', rej.skipped ? 'skipped' : (rej.needed ? 'would-apply' : 'present'), rej.skipped);
      step('run_results', rr.needed ? 'would-apply' : 'present', (rr.todo || []).join(', '));
      return result;
    }

    if (anyPending && !opts.noBackup && fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dir = path.resolve(dbPath) === path.resolve(paths.DB) ? paths.BACKUPS : path.dirname(dbPath);
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `${path.basename(dbPath)}.pre-migrate-${stamp}`);
      await db.backup(dest);
      result.backup = dest;
    }

    let j;
    try {
      j = configureJournal(Database, db, dbPath, mode, opts.probeDir || paths.LOGS);
    } catch (e) {
      // e.g. another process holds the database: the structural migration below does not depend on it
      j = { status: 'skipped', mode: db.pragma('journal_mode', { simple: true }), warning: `journal mode change failed: ${String(e.message || e).slice(0, 100)}` };
    }
    step('journal_mode', j.status, `${j.mode}${j.detail ? ` (${j.detail})` : ''}`);
    if (j.warning) result.warnings.push(`journal_mode: ${j.warning}; database stays in ${j.mode} mode`);

    // IMMEDIATE takes the write lock up front so busy_timeout applies (a deferred read-then-write
    // transaction would fail at once with SQLITE_BUSY when another writer is active).
    db.transaction(() => {
      const c = ensureCandidateTimestamps(db);
      step('candidates', c.skipped ? 'skipped' : (c.needed ? 'applied' : 'present'), (c.todo || []).join(', ') || c.skipped);
      const r = ensureReasonCode(db);
      step('rejections', r.skipped ? 'skipped' : (r.needed ? 'applied' : 'present'), r.skipped);
      const t = ensureRunResults(db);
      step('run_results', t.needed ? 'applied' : 'present', (t.todo || []).join(', '));
    }).immediate();

    if (!opts.skipCheck) {
      const rows = db.pragma('quick_check');
      const verdict = rows.length === 1 && rows[0].quick_check === 'ok' ? 'ok' : rows.map(r => r.quick_check).slice(0, 3).join('; ');
      if (verdict === 'ok') step('integrity', 'present', 'quick_check ok');
      else { result.ok = false; result.errors.push(`integrity check failed: ${verdict}`); step('integrity', 'error', verdict); }
    }
  } catch (e) {
    result.ok = false;
    result.errors.push(String(e.message || e));
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  return result;
}

// ---- CLI --------------------------------------------------------------------------------------

const HELP = `Usage: node scripts/migrate-schema.js [options]
  --db <file>             database (default: RESOURCER_HOME/candidates.db)
  --dry-run               report what would change; writes nothing
  --journal-mode <m>      wal (default) | delete | keep
  --busy-timeout-ms <n>   default 15000
  --no-backup             skip the pre-migration online backup
  --skip-check            skip PRAGMA quick_check
  --create                create the database if missing (fresh install only)
  --json                  print one JSON object instead of text
  --help
Exit codes: 0 ok, 1 error, 2 usage.`;

function parseArgs(argv) {
  const o = {};
  const value = (flag, i) => {
    if (i >= argv.length || String(argv[i]).startsWith('--')) throw new Error(`${flag} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--no-backup') o.noBackup = true;
    else if (a === '--skip-check') o.skipCheck = true;
    else if (a === '--create') o.create = true;
    else if (a === '--json') o.json = true;
    else if (a === '--db') o.db = value(a, ++i);
    else if (a === '--journal-mode') o.journalMode = value(a, ++i);
    else if (a === '--busy-timeout-ms') o.busyTimeoutMs = Number(value(a, ++i));
    else throw new Error(`unknown argument: ${a}`);
  }
  if (o.journalMode && !['wal', 'delete', 'keep'].includes(o.journalMode)) throw new Error('--journal-mode must be wal, delete or keep');
  if (o.busyTimeoutMs !== undefined && !(o.busyTimeoutMs > 0)) throw new Error('--busy-timeout-ms must be a positive number');
  return o;
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    process.stderr.write(`${e.message}\n${HELP}\n`);
    return 2;
  }
  if (opts.help) { process.stdout.write(`${HELP}\n`); return 0; }
  const res = await migrate(opts);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(res)}\n`);
  } else {
    process.stdout.write(`[migrate-schema] ${res.dryRun ? 'DRY RUN ' : ''}${res.dbPath}\n`);
    for (const s of res.steps) process.stdout.write(`  ${s.name.padEnd(13)} ${s.status}${s.detail ? `  ${s.detail}` : ''}\n`);
    if (res.backup) process.stdout.write(`  backup        ${res.backup}\n`);
    for (const w of res.warnings) process.stdout.write(`  WARN ${w}\n`);
    for (const e of res.errors) process.stderr.write(`  ERROR ${e}\n`);
    process.stdout.write(`[migrate-schema] ${res.ok ? 'OK' : 'FAILED'}\n`);
  }
  return res.ok ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code), err => {
    process.stderr.write(`FATAL: ${err && err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  migrate, ensureRunResults, ensureCandidateTimestamps, ensureReasonCode, configureJournal,
  RUN_RESULTS_DDL, RUN_RESULTS_INDEX, RUN_RESULTS_COLUMNS, tableExists, columnNames, walFilesystemVerdict,
};
