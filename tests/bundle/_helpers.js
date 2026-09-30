'use strict';
// Shared test helpers: fake legacy workspace with obviously fake secrets, tool runner, tree snapshots.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const TOOLS = path.join(REPO, 'tools');
const F = require(path.join(TOOLS, 'lib', 'bundle-format.js'));

const FAKE = {
  catererUser: 'fake-caterer-user@example.invalid',
  catererPass: 'FAKE-caterer-pw-Zx9Qw7-not-real',
  zohoClientId: 'FAKE-zoho-client-id-1000.ABCDEF',
  zohoClientSecret: 'FAKE-zoho-client-secret-0123456789abcdef',
  zohoAccess: 'FAKE-zoho-access-token-1000.aaaa.bbbb',
  zohoRefresh: 'FAKE-zoho-refresh-token-1000.cccc.dddd',
  reedEmail: 'fake-reed-user@example.invalid',
  reedPass: 'FAKE-reed-pw-4444',
  reedOtherPass: 'FAKE-other-reed-pw-9999',
  passphrase: 'fake test passphrase for bundle tests 0001',
  dashboardAuth: 'FAKE-dashboard-auth-hash-decoy',
  sessionCookie: 'FAKE-session-cookie-decoy',
};

function secretValues() {
  return Object.values(FAKE);
}

function baseTmp() {
  const base = process.env.BUNDLE_TEST_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function mkTmp(prefix = 'cbr-test-') {
  return fs.mkdtempSync(path.join(baseTmp(), prefix));
}

function rmTmp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function sqlite() {
  return F.loadSqlite([]);
}

function write(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

const DDL = [
  `CREATE TABLE candidate_rejections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    caterer_id  INTEGER,
    reed_id     INTEGER,
    job_title   TEXT NOT NULL,
    rejected_at TEXT NOT NULL,
    origin      TEXT
  )`,
  `CREATE TABLE candidates (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        caterer_id  INTEGER UNIQUE,
        reed_id     INTEGER UNIQUE,
        source      TEXT NOT NULL DEFAULT 'caterer',
        role        TEXT,
        location    TEXT,
        pulled_date TEXT,
        unlocked    INTEGER DEFAULT 0,
        zoho_id     TEXT
      , created_at TEXT, zoho_pushed_at TEXT)`,
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
  'CREATE UNIQUE INDEX idx_rej_caterer ON candidate_rejections(caterer_id, job_title) WHERE caterer_id IS NOT NULL',
  'CREATE UNIQUE INDEX idx_rej_reed    ON candidate_rejections(reed_id, job_title)    WHERE reed_id    IS NOT NULL',
  'CREATE INDEX idx_territory_enabled ON territory_searches(enabled, next_run_date, priority)',
  `CREATE TRIGGER candidates_set_created_at
  AFTER INSERT ON candidates
  FOR EACH ROW WHEN NEW.created_at IS NULL
  BEGIN
    UPDATE candidates SET created_at = datetime('now') WHERE id = NEW.id;
  END`,
];

const DB_COUNTS = { candidates: 300, candidate_rejections: 80, territory_searches: 25, reed_daily_usage: 10, reed_location_cache: 3 };

function pad(n) { return String(n).padStart(2, '0'); }

function createFakeDb(file, { journal = 'delete', rows = DB_COUNTS } = {}) {
  const Database = sqlite();
  const db = new Database(file);
  try {
    db.pragma(`journal_mode = ${journal}`);
    for (const s of DDL) db.exec(s);
    const insC = db.prepare('INSERT INTO candidates (caterer_id, reed_id, source, role, location, pulled_date, unlocked, zoho_id, created_at, zoho_pushed_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const insR = db.prepare('INSERT INTO candidate_rejections (caterer_id, reed_id, job_title, rejected_at, origin) VALUES (?,?,?,?,?)');
    const insT = db.prepare('INSERT INTO territory_searches (job_title, location, distance, keywords, last_searched, next_run_date) VALUES (?,?,?,?,?,?)');
    const insU = db.prepare('INSERT INTO reed_daily_usage (date, profile_views, cv_downloads, daily_limit) VALUES (?,?,?,?)');
    const insL = db.prepare('INSERT INTO reed_location_cache (postcode, location_id, name, fetched_at) VALUES (?,?,?,?)');
    db.transaction(() => {
      for (let i = 0; i < rows.candidates; i += 1) {
        const reed = i % 3 === 0;
        insC.run(reed ? null : 100000 + i, reed ? 900000 + i : null, reed ? 'reed' : 'caterer', null, null, null, i % 2, i % 5 === 0 ? `ZF${i}` : null,
          `2026-09-${pad(1 + (i % 28))} ${pad(i % 24)}:${pad(i % 60)}:00`, null);
      }
      for (let i = 0; i < rows.candidate_rejections; i += 1) insR.run(200000 + i, null, `Fake Role ${i % 7}`, `2026-09-${pad(1 + (i % 27))}`, 'test');
      for (let i = 0; i < rows.territory_searches; i += 1) insT.run(`Fake Role ${i % 4}`, `ZZ${i}`, 10 + (i % 3) * 10, '', `2026-09-${pad(1 + (i % 25))}`, `2026-12-${pad(1 + (i % 25))}`);
      for (let i = 0; i < rows.reed_daily_usage; i += 1) insU.run(`2026-09-${pad(1 + i)}`, 10 + i, i, 300);
      for (let i = 0; i < rows.reed_location_cache; i += 1) insL.run(`ZZ${i} 1AA`, 1000 + i, `Fake Place ${i}`, '2026-09-01');
    })();
  } finally {
    db.close();
  }
}

// Fake legacy workspace mirroring the layout the real one has (names only; every value is fake).
function buildFakeLegacy(dir, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  createFakeDb(path.join(dir, 'candidates.db'), { journal: opts.journal || 'delete', rows: opts.dbRows || DB_COUNTS });
  write(path.join(dir, 'caterer-credentials.json'), JSON.stringify({ username: FAKE.catererUser, password: FAKE.catererPass }));
  write(path.join(dir, 'zoho-credentials.json'), JSON.stringify({
    client_id: FAKE.zohoClientId, client_secret: FAKE.zohoClientSecret, access_token: FAKE.zohoAccess,
    refresh_token: FAKE.zohoRefresh, api_domain: 'https://www.zohoapis.invalid', scope: 'FAKE.scope', token_type: 'Bearer',
  }, null, 2));
  write(path.join(dir, 'scripts', 'cdp-reed-full-login.js'),
    `'use strict';\nconst path = require('path');\n\nconst EMAIL = '${FAKE.reedEmail}';\nconst PASSWORD = '${FAKE.reedPass}';\nconst TARGET_URL = 'https://example.invalid/search';\n`);
  write(path.join(dir, 'scripts', 'reed-clean-relogin.js'),
    opts.reedSecondPass
      ? `'use strict';\nconst EMAIL = "${FAKE.reedEmail}";\nconst PASSWORD = "${opts.reedSecondPass}";\n`
      : `'use strict';\nconst EMAIL = '${FAKE.reedEmail}';\nconst PASSWORD = '${FAKE.reedPass}';\n`);
  write(path.join(dir, 'scripts', 'extract-js.b64'), Buffer.from('ZmFrZSBleHRyYWN0IGpzIGZvciB0ZXN0cw==\n'));
  write(path.join(dir, 'config', 'postcode-cities.json'), JSON.stringify({ ZZ1: 'Fakeville', ZZ2: 'Testton' }, null, 2));
  write(path.join(dir, 'config', 'territory-defaults.json'), JSON.stringify({ distance: 20, cvLimit: 20 }));
  write(path.join(dir, 'config', 'dashboard-auth.json'), JSON.stringify({ hash: FAKE.dashboardAuth }));
  if (opts.bigConfigBytes) write(path.join(dir, 'config', 'big-fake.json'), Buffer.from(crypto.randomBytes(opts.bigConfigBytes).toString('hex')));
  write(path.join(dir, 'postcode-lookup-cache.json'), JSON.stringify({ 'ZZ1 1AA': { city: 'Fakeville' } }));
  write(path.join(dir, 'postcode-to-city-cache.json'), JSON.stringify({ ZZ1: 'Fakeville' }));
  write(path.join(dir, 'reed-location-cache.json'), JSON.stringify({ ZZ1: 1001 }));
  const pend = path.join(dir, 'pending-searches');
  write(path.join(pend, 'territory-a-20260929-0103.json'), JSON.stringify({ jobTitle: 'Fake Role 1', location: 'ZZ1', distance: 20, sources: 'caterer', spawnedAt: '2026-09-29T01:04:00.000Z' }, null, 2));
  write(path.join(pend, 'territory-b-20260929-0103.json'), Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(JSON.stringify({ jobTitle: 'Fake Role 2', location: 'ZZ2', distance: 10 }))]));
  write(path.join(pend, 'territory-c-20260929-0103.json'), JSON.stringify({ jobTitle: 'Fake Role 3', location: 'ZZ3', distance: 30, spawnedAt: '2026-09-29T01:05:00.000Z', keywords: '' }, null, 2));
  write(path.join(pend, 'search-d.json'), JSON.stringify({ jobTitle: 'Fake Role 4', location: 'ZZ4', distance: 20 }));
  write(path.join(pend, '.dup-removed-20260607', 'territory-old.json'), JSON.stringify({ jobTitle: 'Removed dup' }));
  write(path.join(pend, 'notes.txt'), 'not a pending search');
  if (opts.badPending) write(path.join(pend, 'broken.json'), '{ this is not json ' + FAKE.sessionCookie);
  // decoys that must never travel
  write(path.join(dir, 'caterer-session.json'), JSON.stringify({ cookies: [{ name: 'x', value: FAKE.sessionCookie }] }));
  write(path.join(dir, 'reed-session.json'), JSON.stringify({ token: FAKE.sessionCookie }));
  write(path.join(dir, 'downloads', 'cv-1.pdf'), 'FAKE CV BYTES ' + FAKE.sessionCookie);
  write(path.join(dir, 'logs', 'phase1-console-1.log'), 'log ' + FAKE.sessionCookie);
  write(path.join(dir, 'review-tmp-1.json'), '{"snippet":"' + FAKE.sessionCookie + '"}');
  write(path.join(dir, 'runs', 'phase1-2026-01-01-000000.json'), JSON.stringify({ id: 'old', status: 'complete', startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:05:00.000Z' }));
  write(path.join(dir, 'runs', 'phase1-2026-01-02-000000.json'), JSON.stringify({ id: 'old2', status: 'phase1_abandoned', startedAt: '2026-01-02T00:00:00.000Z' }));
  fs.mkdirSync(path.join(dir, 'runtime'), { recursive: true });
  return dir;
}

function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('BUNDLE_') && k !== 'RESOURCER_HOME') env[k] = v;
  env.BUNDLE_SCRYPT_LOG2N = '15';
  if (process.env.BUNDLE_SQLITE_MODULE) env.BUNDLE_SQLITE_MODULE = process.env.BUNDLE_SQLITE_MODULE;
  return Object.assign(env, extra);
}

function passFile(dir, text = FAKE.passphrase, name = 'pass.txt') {
  const f = path.join(dir, name);
  fs.writeFileSync(f, text + '\n', { mode: 0o600 });
  return f;
}

function runTool(script, args, { env = {}, input, cwd, fd3 } = {}) {
  const stdio = [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'];
  let fd = null;
  if (fd3) { fd = fs.openSync(fd3, 'r'); stdio.push(fd); }
  try {
    const r = spawnSync(process.execPath, [path.join(TOOLS, script), ...args], {
      env: cleanEnv(env), encoding: 'utf8', input, cwd, stdio, windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024,
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', all: `${r.stdout || ''}\n${r.stderr || ''}` };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function sqliteModuleDir() {
  const env = process.env.BUNDLE_SQLITE_MODULE;
  if (env) return fs.existsSync(path.join(env, 'package.json')) ? env : path.join(env, 'better-sqlite3');
  for (const base of [TOOLS, path.join(REPO, 'resourcer')]) {
    try { return path.dirname(require.resolve('better-sqlite3/package.json', { paths: [base] })); } catch { /* next */ }
  }
  throw new Error('better-sqlite3 not found for tests');
}

function make(source, out, extraArgs = [], env = {}) {
  const dir = path.dirname(out);
  const pf = env.BUNDLE_PASSPHRASE_FILE || passFile(dir);
  return runTool('make-bundle.js', ['--source', source, '--out', out, ...extraArgs], { env: Object.assign({ BUNDLE_PASSPHRASE_FILE: pf }, env) });
}

function restore(bundle, home, extraArgs = [], env = {}) {
  const pf = env.BUNDLE_PASSPHRASE_FILE || passFile(path.dirname(bundle));
  return runTool('restore-bundle.js', ['--bundle', bundle, '--home', home, ...extraArgs], { env: Object.assign({ BUNDLE_PASSPHRASE_FILE: pf }, env) });
}

function verify(bundle, env = {}) {
  const pf = env.BUNDLE_PASSPHRASE_FILE || passFile(path.dirname(bundle));
  return runTool('verify-bundle.js', ['--bundle', bundle], { env: Object.assign({ BUNDLE_PASSPHRASE_FILE: pf }, env) });
}

// path -> "size:sha256" for every file under dir (directories recorded too); used to prove "nothing changed".
function snapshotTree(dir) {
  const out = {};
  const walk = (d) => {
    let names;
    try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names.sort()) {
      const full = path.join(d, n);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      const st = fs.lstatSync(full);
      if (st.isDirectory()) { out[`${rel}/`] = 'dir'; walk(full); } else out[rel] = `${st.size}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
    }
  };
  walk(dir);
  return out;
}

function readManifest(bundle, passphrase = FAKE.passphrase) {
  const contents = new Map();
  const r = F.scanBundle(bundle, { passphrase }, {
    sink(entry) {
      const parts = [];
      return { write(b) { parts.push(Buffer.from(b)); }, end() { contents.set(entry.path, Buffer.concat(parts)); }, abort() {} };
    },
  });
  if (r.key) r.key.fill(0);
  return { manifest: r.manifest, contents };
}

function assertNoSecrets(assert, text, label) {
  for (const v of secretValues()) assert.ok(!text.includes(v), `${label} leaked a secret value (${v.slice(0, 12)}...)`);
}

module.exports = { sqliteModuleDir, REPO, TOOLS, F, FAKE, DB_COUNTS, secretValues, mkTmp, rmTmp, sqlite, write, createFakeDb, buildFakeLegacy, cleanEnv, passFile, runTool, make, restore, verify, snapshotTree, readManifest, assertNoSecrets };
