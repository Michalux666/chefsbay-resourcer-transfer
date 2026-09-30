'use strict';
// A synthetic legacy workspace (the laptop side of the cutover): real schema, fake rows, fake credentials.
const fs = require('fs');
const path = require('path');
const { SECRETS, CANDIDATES } = require('./data');

const REPO = path.resolve(__dirname, '..', '..', '..');

function sqlite() {
  try { return require('better-sqlite3'); } catch { /* fall through */ }
  return require(path.join(REPO, 'resourcer', 'node_modules', 'better-sqlite3'));
}

const CANDIDATES_DDL = `CREATE TABLE candidates (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        caterer_id  INTEGER UNIQUE,
        reed_id     INTEGER UNIQUE,
        source      TEXT NOT NULL DEFAULT 'caterer',
        role        TEXT,
        location    TEXT,
        pulled_date TEXT,
        unlocked    INTEGER DEFAULT 0,
        zoho_id     TEXT
      , created_at TEXT, zoho_pushed_at TEXT)`;

const DDL = [
  CANDIDATES_DDL,
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

function write(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

// opts.dueTerritory: put the main territory's next_run_date in the past so queue-due-territories picks it up.
function build(dir, opts) {
  const o = opts || {};
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const Database = sqlite();
  const db = new Database(path.join(dir, 'candidates.db'));
  db.pragma('journal_mode = delete');
  for (const s of DDL) db.exec(s);
  const insC = db.prepare('INSERT INTO candidates (caterer_id, reed_id, source, role, location, pulled_date, unlocked, zoho_id, created_at, zoho_pushed_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const insR = db.prepare('INSERT INTO candidate_rejections (caterer_id, reed_id, job_title, rejected_at, origin) VALUES (?,?,?,?,?)');
  const insT = db.prepare("INSERT INTO territory_searches (job_title, location, distance, keywords, sources, priority, last_searched, next_run_date, candidate_count, new_to_zoho) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const insU = db.prepare('INSERT INTO reed_daily_usage (date, profile_views, cv_downloads, daily_limit) VALUES (?,?,?,?)');
  const insL = db.prepare('INSERT INTO reed_location_cache (postcode, location_id, name, fetched_at) VALUES (?,?,?,?)');
  db.transaction(() => {
    for (let i = 0; i < 1500; i += 1) {
      const reed = i % 4 === 0;
      const pushed = i % 3 !== 0;
      insC.run(reed ? null : 60000000 + i, reed ? 91000000 + i : null, reed ? 'reed' : 'caterer', 'Chef', 'LS1',
        `2026-08-${String(1 + (i % 28)).padStart(2, '0')}`, pushed ? 1 : 0, pushed ? `ZLEG${i}` : null,
        `2026-08-${String(1 + (i % 28)).padStart(2, '0')} 09:${String(i % 60).padStart(2, '0')}:00`,
        pushed ? `2026-08-${String(1 + (i % 28)).padStart(2, '0')} 10:00:00` : null);
    }
    const already = CANDIDATES.find((c) => c.kind === 'indb');
    insC.run(already.id, null, 'caterer', 'Chef', 'LS29', '2026-09-10', 1, 'ZLEG-INDB', '2026-09-10 09:00:00', '2026-09-10 10:00:00');
    for (const c of CANDIDATES) {
      if (c.kind === 'rejtitle') insR.run(c.id, null, 'Chef', '2026-09-01', 'pipeline');
      if (c.kind === 'otherrej') insR.run(c.id, null, 'Kitchen Porter', '2026-09-01', 'pipeline');
    }
    for (let i = 0; i < 40; i += 1) insR.run(80000000 + i, null, 'Chef', '2026-09-02', 'pipeline');
    const far = '2030-01-01';
    const main = o.dueTerritory ? '2026-09-01' : far;
    insT.run('Chef', 'LS29', 20, '', o.mainSources || 'both', 'low', '2026-08-20', main, 30, 5);
    insT.run('Sous Chef', 'M1', 20, '', 'both', 'low', '2026-08-20', far, 10, 2);
    insT.run('Kitchen Porter', 'B1', 10, '', 'caterer', 'medium', '2026-08-21', far, 20, 4);
    for (let i = 0; i < 9; i += 1) insU.run(`2026-09-${String(20 + i).padStart(2, '0')}`, 10 + i, i, 300);
    insL.run('LS29', 1234, 'Ilkley', '2026-09-01');
  })();
  db.close();

  write(path.join(dir, 'caterer-credentials.json'), JSON.stringify({ username: SECRETS.catererUser, password: SECRETS.catererPass }));
  write(path.join(dir, 'zoho-credentials.json'), JSON.stringify({
    client_id: SECRETS.zohoClientId, client_secret: SECRETS.zohoClientSecret, access_token: SECRETS.zohoAccess,
    refresh_token: SECRETS.zohoRefresh, api_domain: 'https://www.zohoapis.invalid', scope: 'E2E.scope', token_type: 'Bearer',
  }, null, 2));
  write(path.join(dir, 'scripts', 'cdp-reed-full-login.js'),
    `'use strict';\nconst EMAIL = '${SECRETS.reedEmail}';\nconst PASSWORD = '${SECRETS.reedPass}';\nconst TARGET_URL = 'https://example.invalid/search';\n`);
  write(path.join(dir, 'scripts', 'reed-clean-relogin.js'),
    `'use strict';\nconst EMAIL = '${SECRETS.reedEmail}';\nconst PASSWORD = '${SECRETS.reedPass}';\n`);
  fs.copyFileSync(path.join(REPO, 'resourcer', 'scripts', 'extract-js.b64'), path.join(dir, 'scripts', 'extract-js.b64'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'resourcer', 'config', 'postcode-cities.json'), path.join(dir, 'config', 'postcode-cities.json'));
  fs.copyFileSync(path.join(REPO, 'resourcer', 'config', 'territory-defaults.json'), path.join(dir, 'config', 'territory-defaults.json'));
  write(path.join(dir, 'config', 'dashboard-auth.json'), JSON.stringify({ hash: 'E2E-dashboard-auth-decoy' }));
  write(path.join(dir, 'postcode-lookup-cache.json'), JSON.stringify({}));
  write(path.join(dir, 'postcode-to-city-cache.json'), JSON.stringify({}));
  write(path.join(dir, 'reed-location-cache.json'), JSON.stringify({ LS29: 1234 }));
  fs.mkdirSync(path.join(dir, 'pending-searches'), { recursive: true });
  // decoys that must never travel
  write(path.join(dir, 'caterer-session.json'), JSON.stringify({ cookies: [{ name: 'x', value: SECRETS.sessionCookie }] }));
  write(path.join(dir, 'reed-session.json'), JSON.stringify({ token: SECRETS.sessionCookie }));
  write(path.join(dir, 'downloads', 'cv-1.pdf'), `LEGACY CV BYTES ${SECRETS.sessionCookie}`);
  write(path.join(dir, 'logs', 'phase1-console-1.log'), `log ${SECRETS.sessionCookie}`);
  write(path.join(dir, 'review-tmp-1.json'), `{"snippet":"${SECRETS.sessionCookie}"}`);
  fs.mkdirSync(path.join(dir, 'runtime'), { recursive: true });
  return dir;
}

module.exports = { build, sqlite, REPO };
