'use strict';
// The candidates.db schema as it exists in the legacy system (schema only, read from
// sqlite_master of the live file, plus the DDL in candidates-db.js / migrate-reed-schema.js /
// migrate-rejection-scoping.js). Fake rows only.

const REAL_SCHEMA = `
CREATE TABLE candidates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  caterer_id  INTEGER UNIQUE,
  reed_id     INTEGER UNIQUE,
  source      TEXT NOT NULL DEFAULT 'caterer',
  role        TEXT,
  location    TEXT,
  pulled_date TEXT,
  unlocked    INTEGER DEFAULT 0,
  zoho_id     TEXT,
  created_at TEXT,
  zoho_pushed_at TEXT
);
CREATE TRIGGER candidates_set_created_at
  AFTER INSERT ON candidates
  FOR EACH ROW WHEN NEW.created_at IS NULL
  BEGIN
    UPDATE candidates SET created_at = datetime('now') WHERE id = NEW.id;
  END;
CREATE TRIGGER candidates_set_zoho_pushed_at
  AFTER UPDATE OF zoho_id ON candidates
  FOR EACH ROW WHEN NEW.zoho_id IS NOT NULL AND OLD.zoho_id IS NULL
  BEGIN
    UPDATE candidates SET zoho_pushed_at = datetime('now') WHERE id = NEW.id;
  END;
CREATE TABLE candidate_rejections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  caterer_id  INTEGER,
  reed_id     INTEGER,
  job_title   TEXT NOT NULL,
  rejected_at TEXT NOT NULL,
  origin      TEXT
);
CREATE UNIQUE INDEX idx_rej_caterer ON candidate_rejections(caterer_id, job_title) WHERE caterer_id IS NOT NULL;
CREATE UNIQUE INDEX idx_rej_reed    ON candidate_rejections(reed_id, job_title)    WHERE reed_id    IS NOT NULL;
CREATE TABLE reed_daily_usage (
  date          TEXT PRIMARY KEY,
  profile_views INTEGER DEFAULT 0,
  cv_downloads  INTEGER DEFAULT 0,
  daily_limit   INTEGER DEFAULT 300
);
CREATE TABLE reed_location_cache (
  postcode    TEXT PRIMARY KEY,
  location_id INTEGER NOT NULL,
  name        TEXT,
  fetched_at  TEXT
);
CREATE TABLE "territory_searches" (
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
);
CREATE INDEX idx_territory_enabled ON territory_searches(enabled, next_run_date, priority);
`;

// Pre-Reed-migration candidates table (no reed_id, caterer_id is the primary key).
const PRE_REED_CANDIDATES = `
CREATE TABLE candidates (
  caterer_id  INTEGER PRIMARY KEY,
  source      TEXT,
  role        TEXT,
  location    TEXT,
  pulled_date TEXT,
  unlocked    INTEGER DEFAULT 0,
  zoho_id     TEXT
);
CREATE TABLE territory_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_title TEXT NOT NULL, location TEXT NOT NULL, distance INTEGER NOT NULL,
  keywords TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT 'low',
  UNIQUE(job_title, location, distance, keywords)
);
`;

module.exports = { REAL_SCHEMA, PRE_REED_CANDIDATES };
