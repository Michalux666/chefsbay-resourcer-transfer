#!/usr/bin/env node
/**
 * candidates-db.js - Candidate ID lookup database (Caterer + Reed)
 */

'use strict';

const fs = require('fs');
const paths = require('./scripts/lib/paths');

// As a library a missing driver still fails loudly at require; as the CLI it is deferred so `check` can report it as exit 2.
let Database = null;
let driverError = null;
try {
  Database = require('better-sqlite3');
} catch (e) {
  if (require.main !== module) throw e;
  driverError = e;
}

const DB_PATH = paths.DB;

function ensureSchema(db) {
  // Original candidates table (now migrated via migrate-reed-schema.js - see Phase 0)
  // This CREATE TABLE is kept for fresh installs only; existing DBs should use the migration script.
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      caterer_id  INTEGER UNIQUE,
      reed_id     INTEGER UNIQUE,
      source      TEXT NOT NULL DEFAULT 'caterer',
      role        TEXT,
      location    TEXT,
      pulled_date TEXT,
      unlocked    INTEGER DEFAULT 0,
      zoho_id     TEXT
    );
  `);

  // Idempotent column additions for legacy DBs that weren't migrated
  try { db.exec('ALTER TABLE candidates ADD COLUMN unlocked INTEGER DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE candidates ADD COLUMN zoho_id TEXT'); } catch {}
  try { db.exec('ALTER TABLE candidates ADD COLUMN role TEXT'); } catch {}
  try { db.exec('ALTER TABLE candidates ADD COLUMN location TEXT'); } catch {}
  try { db.exec('ALTER TABLE candidates ADD COLUMN pulled_date TEXT'); } catch {}
  try { db.exec('ALTER TABLE candidates ADD COLUMN source TEXT'); } catch {}
  try { db.exec("ALTER TABLE candidates ADD COLUMN reed_id INTEGER"); } catch {}

  // P3: scheduler query index
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_territory_enabled ON territory_searches(enabled, next_run_date, priority)'); } catch {}
  // P3: redundant index cleanup (caterer_id is UNIQUE)
  try { db.exec('DROP INDEX IF EXISTS idx_caterer_id'); } catch {}

  // Reed Phase 0: new tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS reed_daily_usage (
      date          TEXT PRIMARY KEY,
      profile_views INTEGER DEFAULT 0,
      cv_downloads  INTEGER DEFAULT 0,
      daily_limit   INTEGER DEFAULT 300
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS reed_location_cache (
      postcode    TEXT PRIMARY KEY,
      location_id INTEGER NOT NULL,
      name        TEXT,
      fetched_at  TEXT
    );
  `);

  // Reed Phase 0: territory_searches sources column
  try { db.exec("ALTER TABLE territory_searches ADD COLUMN sources TEXT NOT NULL DEFAULT 'caterer'"); } catch {}
}

// Singleton connection - avoids opening/closing on every call (60+ times per pipeline run)
let _singletonDb = null;

function openDb() {
  if (!Database) throw driverError;
  const db = new Database(DB_PATH);
  // Several processes (phase1 children, phase 2, the dashboard reader) share this file.
  db.pragma('busy_timeout = 5000');
  // Never switch modes here: migrate-schema.js probes the volume and is the only place that may turn WAL on.
  // A DB that is already in WAL is re-asserted; a failure must never stop the caller.
  try {
    if (String(db.pragma('journal_mode', { simple: true })).toLowerCase() === 'wal') db.pragma('journal_mode = WAL');
  } catch {}
  ensureSchema(db);
  return db;
}

function getDb() {
  if (_singletonDb) {
    try {
      // Quick liveness check - throws if closed
      _singletonDb.pragma('journal_mode');
      return _singletonDb;
    } catch {
      _singletonDb = null;
    }
  }
  _singletonDb = openDb();
  return _singletonDb;
}

function closeDb() {
  if (_singletonDb) {
    try { _singletonDb.close(); } catch {}
    _singletonDb = null;
  }
}

// Ensure DB is closed on process exit
process.on('exit', closeDb);

function withDb(fn) {
  return fn(getDb());
}

// --- Caterer candidate methods (unchanged) ------------------------------------

function checkCandidate(id) {
  return withDb(db => db.prepare('SELECT caterer_id, unlocked FROM candidates WHERE caterer_id = ?').get(id) || null);
}

// Batched existence check: returns the subset of the given caterer_ids that are already
// in the DB. One query instead of one node-process spawn per card (perf, 2026-06-02).
function checkCandidatesBatch(ids) {
  const clean = ids.map(n => parseInt(n, 10)).filter(Boolean);
  if (!clean.length) return [];
  return withDb(db => {
    const placeholders = clean.map(() => '?').join(',');
    const rows = db.prepare(`SELECT caterer_id FROM candidates WHERE caterer_id IN (${placeholders})`).all(...clean);
    return rows.map(r => r.caterer_id);
  });
}

/**
 * Job-title-scoped skip check (2026-08-03).
 *
 * Returns the subset of `ids` that should be SKIPPED for this job title.
 * Unlike checkCandidatesBatch (which skips anyone ever recorded), this only
 * skips a candidate when:
 *   - unlocked = 1                       -> we already hold their CV, never re-pay; or
 *   - a rejection row exists for THIS job title; or
 *   - a rejection row exists with the '*' sentinel (pre-2026-06-02 rows whose
 *     original job title is unknowable - kept blocked so this cannot regress them).
 *
 * Everyone else is reconsidered, so someone rejected for Chef can still be
 * screened for Kitchen Porter / Catering Assistant, which is the whole point.
 *
 * Falls back to the unscoped behaviour if candidate_rejections is missing, so a
 * DB that hasn't been migrated still behaves exactly as before.
 */
function checkCandidatesBatchScoped(ids, jobTitle) {
  const clean = ids.map(n => parseInt(n, 10)).filter(Boolean);
  if (!clean.length) return [];
  return withDb(db => {
    const hasTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='candidate_rejections'"
    ).get();
    if (!hasTable) return checkCandidatesBatch(clean);

    const ph = clean.map(() => '?').join(',');
    // Already hold the CV -> always skip.
    const unlocked = db.prepare(
      `SELECT caterer_id FROM candidates WHERE caterer_id IN (${ph}) AND unlocked = 1`
    ).all(...clean).map(r => r.caterer_id);
    // Already judged for this exact role (or blocked by the unknown-title sentinel).
    const rejected = db.prepare(
      `SELECT caterer_id FROM candidate_rejections
        WHERE caterer_id IN (${ph}) AND (job_title = ? OR job_title = '*')`
    ).all(...clean, jobTitle).map(r => r.caterer_id);

    return [...new Set([...unlocked, ...rejected])];
  });
}

/**
 * Record that a candidate was rejected for a specific job title.
 * Paired with seenCandidate() - the candidates row keeps the global "seen"
 * ledger, this row scopes WHY/for-what so other roles stay open.
 */
function rejectCandidateForTitle(id, jobTitle) {
  return withDb(db => {
    try {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS candidate_rejections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          caterer_id INTEGER, reed_id INTEGER,
          job_title TEXT NOT NULL, rejected_at TEXT NOT NULL, origin TEXT
        )`).run();
      db.prepare(`
        INSERT INTO candidate_rejections (caterer_id, job_title, rejected_at, origin)
        VALUES (?, ?, ?, 'pipeline') ON CONFLICT DO NOTHING
      `).run(id, jobTitle || '*', new Date().toISOString().slice(0, 10));
      return true;
    } catch { return false; }
  });
}

function addCandidate(id) {
  return withDb(db => db.prepare(`
    INSERT INTO candidates (caterer_id, source, unlocked) VALUES (?, 'caterer', 1)
    ON CONFLICT(caterer_id) DO UPDATE SET unlocked = 1
  `).run(id));
}

function seenCandidate(id) {
  return withDb(db => db.prepare(`
    INSERT INTO candidates (caterer_id, source, unlocked) VALUES (?, 'caterer', 0)
    ON CONFLICT(caterer_id) DO UPDATE SET unlocked = MAX(unlocked, 0)
  `).run(id));
}

function setZohoId(id, zohoId) {
  return withDb(db => db.prepare('UPDATE candidates SET zoho_id = ? WHERE caterer_id = ?').run(zohoId, id));
}

function getZohoId(id) {
  return withDb(db => {
    const row = db.prepare('SELECT zoho_id FROM candidates WHERE caterer_id = ?').get(id);
    return row?.zoho_id || null;
  });
}

// --- Reed candidate methods (Phase 0) ----------------------------------------

/**
 * Check if a Reed candidate exists in DB.
 * Returns the full row or null.
 */
function checkByReedId(reedId) {
  return withDb(db => db.prepare('SELECT * FROM candidates WHERE reed_id = ?').get(reedId) || null);
}

/**
 * Register a Reed candidate as unlocked (credit spent - profile viewed).
 */
function addReedCandidate(reedId) {
  return withDb(db => db.prepare(`
    INSERT INTO candidates (reed_id, source, unlocked) VALUES (?, 'reed', 1)
    ON CONFLICT(reed_id) DO UPDATE SET unlocked = 1
  `).run(reedId));
}

/**
 * Register a Reed candidate as seen/screened (no credit spent - prevents re-screening).
 */
function seenReedCandidate(reedId) {
  return withDb(db => db.prepare(`
    INSERT INTO candidates (reed_id, source, unlocked) VALUES (?, 'reed', 0)
    ON CONFLICT(reed_id) DO UPDATE SET unlocked = MAX(unlocked, 0)
  `).run(reedId));
}

/**
 * Set Zoho ID for a Reed candidate after successful push.
 */
function setZohoIdByReedId(reedId, zohoId) {
  return withDb(db => db.prepare('UPDATE candidates SET zoho_id = ? WHERE reed_id = ?').run(zohoId, reedId));
}

/**
 * Get Zoho ID for a Reed candidate.
 */
function getZohoIdByReedId(reedId) {
  return withDb(db => {
    const row = db.prepare('SELECT zoho_id FROM candidates WHERE reed_id = ?').get(reedId);
    return row?.zoho_id || null;
  });
}

// --- Source-aware stats -------------------------------------------------------

/**
 * Count totals (unlocked, seen-only) - source-agnostic. Existing behaviour.
 */
function countStats() {
  return withDb(db => {
    const total = db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n;
    const unlocked = db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE unlocked = 1').get().n;
    return { total, unlocked, seenOnly: total - unlocked };
  });
}

/**
 * Count stats broken down by source.
 * Returns array of: { source, total, in_zoho, unlocked }
 */
function countStatsBySource() {
  return withDb(db => db.prepare(`
    SELECT
      source,
      COUNT(*) AS total,
      SUM(CASE WHEN zoho_id IS NOT NULL THEN 1 ELSE 0 END) AS in_zoho,
      SUM(CASE WHEN unlocked = 1 THEN 1 ELSE 0 END) AS unlocked
    FROM candidates
    GROUP BY source
    ORDER BY source
  `).all());
}

// --- Reed location cache ------------------------------------------------------

/**
 * Get a cached location ID by postcode (or null if not cached).
 */
function getCachedLocation(postcode) {
  return withDb(db => db.prepare('SELECT * FROM reed_location_cache WHERE postcode = ?').get(postcode) || null);
}

/**
 * Cache a postcode -> locationId mapping.
 */
function cacheLocation(postcode, locationId, name) {
  return withDb(db => db.prepare(`
    INSERT OR REPLACE INTO reed_location_cache (postcode, location_id, name, fetched_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(postcode, locationId, name || null));
}

// --- Reed daily usage ---------------------------------------------------------

/**
 * Get today's Reed usage row (or null if no row yet).
 * date should be 'YYYY-MM-DD'.
 */
function getReedDailyUsage(date) {
  return withDb(db => db.prepare('SELECT * FROM reed_daily_usage WHERE date = ?').get(date) || null);
}

/**
 * Increment a daily usage counter.
 * field: 'profile_views' or 'cv_downloads'
 * Creates the row if it doesn't exist.
 */
function incrementReedUsage(date, field) {
  if (field !== 'profile_views' && field !== 'cv_downloads') {
    throw new Error(`Invalid field: ${field}. Must be 'profile_views' or 'cv_downloads'`);
  }
  return withDb(db => db.prepare(`
    INSERT INTO reed_daily_usage (date, ${field})
    VALUES (?, 1)
    ON CONFLICT(date) DO UPDATE SET ${field} = ${field} + 1
  `).run(date));
}

// --- CSV import (Caterer activity report) -------------------------------------

function importCvdb(csvPath) {
  if (!csvPath || !fs.existsSync(csvPath)) {
    throw new Error('Usage: import-cvdb <path/to/activity-report.csv>');
  }

  return withDb(db => {
    const raw = fs.readFileSync(csvPath, 'utf8');
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const lc = lines[i].toLowerCase().replace(/[^a-z,]/g, '');
      if (lc.includes('candidateid') || lc.includes('candidate,id')) { headerIdx = i; break; }
      if (lines[i].toLowerCase().includes('candidate id')) { headerIdx = i; break; }
    }
    if (headerIdx === -1) throw new Error('Could not find header row with "Candidate Id"');

    const headers = lines[headerIdx].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z ]/g, '').trim());
    const idCol = headers.findIndex(h => h === 'candidate id' || h === 'candidateid');
    const creditCol = headers.findIndex(h => h.includes('credit used') && !h.includes('internal'));
    if (idCol === -1) throw new Error('No "Candidate Id" column found');

    const upsert = db.prepare(`
      INSERT INTO candidates (caterer_id, source, unlocked) VALUES (?, 'caterer', ?)
      ON CONFLICT(caterer_id) DO UPDATE SET unlocked = MAX(unlocked, excluded.unlocked)
    `);

    const runImport = db.transaction((dataLines) => {
      let added = 0; let updated = 0; let skipped = 0;
      for (const line of dataLines) {
        const cols = line.split(',');
        const id = parseInt((cols[idCol] || '').trim().replace(/"/g, ''), 10);
        if (!id || Number.isNaN(id)) { skipped++; continue; }

        const creditRaw = creditCol >= 0 ? (cols[creditCol] || '').trim().replace(/"/g, '').toLowerCase() : '0';
        const unlocked = (creditRaw === '1' || creditRaw === 'true') ? 1 : 0;

        const existing = db.prepare('SELECT unlocked FROM candidates WHERE caterer_id = ?').get(id);
        upsert.run(id, unlocked);
        if (existing) updated++; else added++;
      }
      return { added, updated, skipped };
    });

    const summary = runImport(lines.slice(headerIdx + 1));
    const total = db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n;
    const unlockedCount = db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE unlocked = 1').get().n;
    return { ...summary, total, unlocked: unlockedCount, seenOnly: total - unlockedCount };
  });
}

// --- CLI ----------------------------------------------------------------------

const HELP = `
Candidate DB (Caterer + Reed)
  check <id>                   Check if Caterer ID exists (exit 0=exists, exit 1=new, exit 2=error or bad usage)
  check-batch <ids|--file f>   Print {"inDb":[...]} for the given Caterer IDs
  check-batch-scoped <ids|--file f> <jobTitle>
                               Same, but only skips unlocked or rejected-for-this-title
  reject-title <id> <title>    Record a rejection scoped to a job title (exit 1 if it could not be written)
  check-reed <id>              Check if Reed ID exists (exit 0=exists, exit 1=new, exit 2=error or bad usage)
  add <id>                     Register Caterer candidate as unlocked (credit spent)
  seen <id>                    Register Caterer candidate as seen/screened (no credit)
  set-zoho-id <id> <zoho_id>  Record Zoho candidate ID after successful push (Caterer)
  get-zoho-id <id>             Print zoho_id if set (exit 0), else exit 1 (Caterer)
  import-cvdb <csv>            Import from Caterer CVDB Activity Report
  count                        Show totals (all sources)
  count-by-source              Show breakdown by source (caterer/reed)
      `;

async function main() {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case 'check': {
      const id = parseInt(args[0], 10);
      if (!id) { console.error('Usage: check <id>'); process.exit(2); }
      let row;
      try {
        row = checkCandidate(id);
      } catch (err) {
        // exit 2 must never be read as "new": a broken database would make every card look unseen
        console.error(`check failed: ${err && err.message ? err.message : String(err)}`);
        process.exit(2);
      }
      if (row) {
        console.log(row.unlocked ? `UNLOCKED: ${id}` : `SEEN: ${id}`);
        process.exit(0);
      }
      console.log(`NEW: ${id}`);
      process.exit(1);
    }

    case 'check-batch': {
      // Usage: check-batch <comma-separated-ids>   (or --file <path> for large lists)
      let raw = args[0] || '';
      if (raw === '--file' && args[1]) raw = fs.readFileSync(args[1], 'utf8');
      const ids = raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
      const inDb = checkCandidatesBatch(ids);
      console.log(JSON.stringify({ inDb }));
      process.exit(0);
    }

    case 'check-batch-scoped': {
      // Usage: check-batch-scoped <comma-ids|--file path> <jobTitle>
      let raw = args[0] || '';
      let titleArg = args[1];
      if (raw === '--file' && args[1]) { raw = fs.readFileSync(args[1], 'utf8'); titleArg = args[2]; }
      const ids = raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
      const inDb = checkCandidatesBatchScoped(ids, titleArg || '');
      console.log(JSON.stringify({ inDb }));
      process.exit(0);
    }

    case 'reject-title': {
      // Usage: reject-title <id> <jobTitle>
      const id = parseInt(args[0], 10);
      if (!id) { console.error('Usage: reject-title <id> <jobTitle>'); process.exit(2); }
      if (!rejectCandidateForTitle(id, args[1] || '')) { console.error('reject-title failed: the rejection was not recorded'); process.exit(1); }
      process.exit(0);
    }

    case 'check-reed': {
      const id = parseInt(args[0], 10);
      if (!id) { console.error('Usage: check-reed <id>'); process.exit(2); }
      let row;
      try {
        row = checkByReedId(id);
      } catch (err) {
        console.error(`check-reed failed: ${err && err.message ? err.message : String(err)}`);
        process.exit(2);
      }
      if (row) {
        console.log(row.unlocked ? `UNLOCKED (Reed): ${id}` : `SEEN (Reed): ${id}`);
        process.exit(0);
      }
      console.log(`NEW (Reed): ${id}`);
      process.exit(1);
    }

    case 'import-cvdb': {
      try {
        const out = importCvdb(args[0]);
        console.log(`Import done: ${out.added} new, ${out.updated} updated, ${out.skipped} skipped`);
        console.log(`DB totals: ${out.total} candidates (${out.unlocked} unlocked, ${out.seenOnly} seen-only)`);
      } catch (err) {
        console.error(err.message);
        process.exit(2);
      }
      break;
    }

    case 'add': {
      const id = parseInt(args[0], 10);
      if (!id) { console.error('Usage: add <id>'); process.exit(2); }
      addCandidate(id);
      console.log(`ADDED: ${id}`);
      break;
    }

    case 'seen': {
      const id = parseInt(args[0], 10);
      if (!id) { console.error('Usage: seen <id>'); process.exit(2); }
      seenCandidate(id);
      console.log(`SEEN: ${id}`);
      break;
    }

    case 'set-zoho-id': {
      const id = parseInt(args[0], 10);
      const zohoId = args[1];
      if (!id || !zohoId) { console.error('Usage: set-zoho-id <caterer_id> <zoho_id>'); process.exit(2); }
      setZohoId(id, zohoId);
      console.log(`ZOHO_ID_SET: ${id} \u{2192} ${zohoId}`);
      break;
    }

    case 'get-zoho-id': {
      const id = parseInt(args[0], 10);
      if (!id) { console.error('Usage: get-zoho-id <id>'); process.exit(2); }
      const zohoId = getZohoId(id);
      if (zohoId) {
        console.log(zohoId);
        process.exit(0);
      }
      process.exit(1);
      break;
    }

    case 'count': {
      const { total, unlocked, seenOnly } = countStats();
      console.log(`Total: ${total} | Unlocked (credit spent): ${unlocked} | Seen only: ${seenOnly}`);
      break;
    }

    case 'count-by-source': {
      const rows = countStatsBySource();
      if (!rows.length) {
        console.log('No candidates in DB');
        break;
      }
      console.log('Candidates by source:');
      for (const row of rows) {
        console.log(`  ${row.source}: ${row.total} total | ${row.unlocked} unlocked | ${row.in_zoho} in Zoho`);
      }
      const grand = rows.reduce((a, r) => ({ total: a.total + r.total, unlocked: a.unlocked + r.unlocked, in_zoho: a.in_zoho + r.in_zoho }), { total: 0, unlocked: 0, in_zoho: 0 });
      console.log(`  ${'\u{2500}'.repeat(37)}`);
      console.log(`  TOTAL: ${grand.total} | ${grand.unlocked} unlocked | ${grand.in_zoho} in Zoho`);
      break;
    }

    default:
      console.log(HELP);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.message || String(err));
    process.exit(1);
  });
}

module.exports = {
  DB_PATH,
  getDb,
  closeDb,
  // Caterer methods
  checkCandidate,
  addCandidate,
  seenCandidate,
  checkCandidatesBatchScoped,
  rejectCandidateForTitle,
  setZohoId,
  getZohoId,
  importCvdb,
  countStats,
  // Reed methods
  checkByReedId,
  addReedCandidate,
  seenReedCandidate,
  setZohoIdByReedId,
  getZohoIdByReedId,
  // Source-aware stats
  countStatsBySource,
  // Location cache
  getCachedLocation,
  cacheLocation,
  // Daily usage
  getReedDailyUsage,
  incrementReedUsage,
};
