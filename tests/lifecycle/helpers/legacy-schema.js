'use strict';
// Schema of the real legacy candidates.db (read from sqlite_master of a copy on 2026-09-29; no data).
const Database = require('./sqlite');

const CANDIDATES_OLD = `CREATE TABLE candidates (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        caterer_id  INTEGER UNIQUE,
        reed_id     INTEGER UNIQUE,
        source      TEXT NOT NULL DEFAULT 'caterer',
        role        TEXT,
        location    TEXT,
        pulled_date TEXT,
        unlocked    INTEGER DEFAULT 0,
        zoho_id     TEXT
      )`;

const CANDIDATES_NEW = CANDIDATES_OLD.replace('zoho_id     TEXT\n      )', 'zoho_id     TEXT\n      , created_at TEXT, zoho_pushed_at TEXT)');

const TRIGGERS = [
  `CREATE TRIGGER candidates_set_created_at
  AFTER INSERT ON candidates
  FOR EACH ROW WHEN NEW.created_at IS NULL
  BEGIN
    UPDATE candidates SET created_at = datetime('now') WHERE id = NEW.id;
  END`,
  `CREATE TRIGGER candidates_set_zoho_pushed_at
  AFTER UPDATE OF zoho_id ON candidates
  FOR EACH ROW WHEN NEW.zoho_id IS NOT NULL AND OLD.zoho_id IS NULL
  BEGIN
    UPDATE candidates SET zoho_pushed_at = datetime('now') WHERE id = NEW.id;
  END`,
];

const REST = [
  `CREATE TABLE candidate_rejections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    caterer_id  INTEGER,
    reed_id     INTEGER,
    job_title   TEXT NOT NULL,
    rejected_at TEXT NOT NULL,
    origin      TEXT
  )`,
  'CREATE UNIQUE INDEX idx_rej_caterer ON candidate_rejections(caterer_id, job_title) WHERE caterer_id IS NOT NULL',
  'CREATE UNIQUE INDEX idx_rej_reed    ON candidate_rejections(reed_id, job_title)    WHERE reed_id    IS NOT NULL',
  `CREATE TABLE reed_daily_usage (
      date          TEXT PRIMARY KEY,
      profile_views INTEGER DEFAULT 0,
      cv_downloads  INTEGER DEFAULT 0,
      daily_limit   INTEGER DEFAULT 300
    )`,
  `CREATE TABLE reed_location_cache (
      postcode    TEXT PRIMARY KEY,
      location_id INTEGER NOT NULL,
      name        TEXT,
      fetched_at  TEXT
    )`,
  `CREATE TABLE "territory_searches" (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      job_title         TEXT    NOT NULL,
      location          TEXT    NOT NULL,
      distance          INTEGER NOT NULL,
      keywords          TEXT    NOT NULL DEFAULT '',
      active_within     TEXT    NOT NULL DEFAULT '1 month',
      cv_limit          TEXT    NOT NULL DEFAULT '20',
      priority          TEXT    NOT NULL DEFAULT 'low',
      enabled           INTEGER NOT NULL DEFAULT 1,
      interval_days     INTEGER,
      candidate_count   INTEGER,
      new_to_zoho       INTEGER,
      duplicates        INTEGER,
      skipped           INTEGER,
      errors            INTEGER,
      credits_remaining INTEGER,
      last_searched     TEXT,
      next_run_date     TEXT, sources TEXT NOT NULL DEFAULT 'caterer',
      UNIQUE(job_title COLLATE NOCASE, location COLLATE NOCASE, distance, keywords COLLATE NOCASE)
    )`,
  'CREATE INDEX idx_territory_enabled ON territory_searches(enabled, next_run_date, priority)',
];

// opts.old: schema as it was before the 2026-08-24 timestamp migration. Rows are synthetic ids only.
function createLegacyDb(file, opts = {}) {
  const db = new Database(file);
  db.exec(opts.old ? CANDIDATES_OLD : CANDIDATES_NEW);
  if (!opts.old) for (const t of TRIGGERS) db.exec(t);
  for (const s of REST) db.exec(s);
  const ins = db.prepare('INSERT INTO candidates (caterer_id, reed_id, source, unlocked, zoho_id) VALUES (?, ?, ?, ?, ?)');
  db.transaction(rows => {
    for (const r of rows) ins.run(r.caterer_id ?? null, r.reed_id ?? null, r.source || 'caterer', r.unlocked ?? 0, r.zoho_id ?? null);
  })(opts.rows || []);
  db.exec("INSERT INTO territory_searches (job_title, location, distance, keywords, sources) VALUES ('Chef','LS1',20,'','both')");
  db.exec("INSERT INTO candidate_rejections (caterer_id, job_title, rejected_at, origin) VALUES (1, 'Chef', '2026-01-01', 'pipeline')");
  db.close();
  return file;
}

module.exports = { createLegacyDb };
