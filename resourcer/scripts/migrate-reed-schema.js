#!/usr/bin/env node
/**
 * migrate-reed-schema.js - Phase 0 database migration for Reed integration
 *
 * What it does:
 *   1. Checks if migration already done (reed_id column exists -> skip)
 *   2. Backs up the DB
 *   3. Migrates candidates table to add id AUTOINCREMENT, reed_id, fixes source
 *   4. Adds sources column to territory_searches
 *   5. Creates reed_daily_usage table
 *   6. Creates reed_location_cache table
 *   7. Verifies row counts
 */

'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const { DB_PATH } = require('./constants');

function log(msg) { console.log(msg); }

function alreadyMigrated(db) {
  const cols = db.prepare('PRAGMA table_info(candidates)').all();
  return cols.some(c => c.name === 'reed_id');
}

function backup(dbPath) {
  const bakPath = dbPath + '.bak-reed-migration';
  if (fs.existsSync(bakPath)) {
    log(`Backup already exists at ${bakPath} \u{2014} skipping copy`);
    return bakPath;
  }
  fs.copyFileSync(dbPath, bakPath);
  log(`Backed up DB to ${bakPath}`);
  return bakPath;
}

function migrateCandidatesTable(db) {
  // Count rows before migration
  const beforeCount = db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n;
  log(`Candidates before migration: ${beforeCount}`);

  // Run migration in a transaction
  const doMigration = db.transaction(() => {
    // Step 1: Rename old table
    db.exec('ALTER TABLE candidates RENAME TO candidates_old');
    log('Renamed candidates \u{2192} candidates_old');

    // Step 2: Create new table with AUTOINCREMENT id, reed_id, proper source NOT NULL
    // Note: SQLite treats NULLs as distinct in UNIQUE columns, so multiple NULLs are fine.
    // Partial index syntax (WHERE NOT NULL) is not supported in CREATE TABLE - use UNIQUE index instead.
    db.exec(`
      CREATE TABLE candidates (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        caterer_id  INTEGER UNIQUE,
        reed_id     INTEGER UNIQUE,
        source      TEXT NOT NULL DEFAULT 'caterer',
        role        TEXT,
        location    TEXT,
        pulled_date TEXT,
        unlocked    INTEGER DEFAULT 0,
        zoho_id     TEXT
      )
    `);
    log('Created new candidates table');

    // Step 3: Migrate data
    const migrated = db.prepare(`
      INSERT INTO candidates (caterer_id, source, role, location, pulled_date, unlocked, zoho_id)
      SELECT caterer_id, COALESCE(source, 'caterer'), role, location, pulled_date, unlocked, zoho_id
      FROM candidates_old
    `).run();
    log(`Migrated ${migrated.changes} rows`);

    // Step 4: Verify counts match BEFORE dropping old table
    const afterCount = db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n;
    if (afterCount !== beforeCount) {
      throw new Error(`Row count mismatch! Before: ${beforeCount}, After: ${afterCount} \u{2014} rolling back`);
    }
    log(`Row count verified: ${afterCount} rows \u{2713}`);

    // Step 5: Drop old table (only after verification)
    db.exec('DROP TABLE candidates_old');
    log('Dropped candidates_old');

    return { beforeCount, afterCount };
  });

  return doMigration();
}

function addTerritorySourcesColumn(db) {
  try {
    db.exec(`ALTER TABLE territory_searches ADD COLUMN sources TEXT NOT NULL DEFAULT 'caterer'`);
    log('Added sources column to territory_searches');
  } catch (err) {
    if (err.message.includes('duplicate column name')) {
      log('territory_searches.sources column already exists \u{2014} skipping');
    } else {
      throw err;
    }
  }
}

function createReedDailyUsageTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reed_daily_usage (
      date          TEXT PRIMARY KEY,
      profile_views INTEGER DEFAULT 0,
      cv_downloads  INTEGER DEFAULT 0,
      daily_limit   INTEGER DEFAULT 300
    )
  `);
  log('Created reed_daily_usage table (or already exists)');
}

function createReedLocationCacheTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reed_location_cache (
      postcode    TEXT PRIMARY KEY,
      location_id INTEGER NOT NULL,
      name        TEXT,
      fetched_at  TEXT
    )
  `);
  log('Created reed_location_cache table (or already exists)');
}

function main() {
  if (process.argv[2] === '--help' || process.argv[2] === '-h') {
    console.log('Usage: node scripts/migrate-reed-schema.js\nOne-off, idempotent Reed schema migration of candidates.db (backs up to candidates.db.bak-reed-migration first).');
    return;
  }
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at: ${DB_PATH}`);
    process.exit(1);
  }

  log(`Opening DB: ${DB_PATH}`);
  const db = new Database(DB_PATH);

  // Check if already migrated
  if (alreadyMigrated(db)) {
    log('\n\u{2713} Migration already done (reed_id column exists) \u{2014} skipping candidates table migration');
    // Still ensure other tables exist (idempotent)
    addTerritorySourcesColumn(db);
    createReedDailyUsageTable(db);
    createReedLocationCacheTable(db);
    const count = db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n;
    log(`\n\u{2713} All done. Candidates table has ${count} rows.`);
    db.close();
    return;
  }

  log('\n=== Starting Reed Schema Migration ===\n');

  // Fold any WAL content into the main file first: the backup is a plain file copy.
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* not in WAL mode */ }

  // Back up first (may already exist if user ran it)
  backup(DB_PATH);

  // Step 1: Migrate candidates table
  log('\n--- Step 1: Migrating candidates table ---');
  const { beforeCount, afterCount } = migrateCandidatesTable(db);

  // Step 2: Add sources column to territory_searches
  log('\n--- Step 2: Adding sources column to territory_searches ---');
  addTerritorySourcesColumn(db);

  // Step 3: Create reed_daily_usage
  log('\n--- Step 3: Creating reed_daily_usage table ---');
  createReedDailyUsageTable(db);

  // Step 4: Create reed_location_cache
  log('\n--- Step 4: Creating reed_location_cache table ---');
  createReedLocationCacheTable(db);

  // Final summary
  log('\n=== Migration Complete ===');
  log(`  Candidates: ${beforeCount} \u{2192} ${afterCount} rows (no data lost)`);
  log(`  territory_searches: sources column added`);
  log(`  reed_daily_usage: created`);
  log(`  reed_location_cache: created`);
  log('');

  db.close();
}

main();
