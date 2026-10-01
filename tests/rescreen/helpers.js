'use strict';
// Shared fixtures of the tests of tools/rescreen-policy-rejects.js: a synthetic RESOURCER_HOME with the real table layouts, shadow rows built from the REAL engines
// (tests/rescreen/fixtures/make-rows.js: update-a-rows.json from the d60d917 code, head-rows.json from this repository), and a runner for the tool.
// Only invented data lives here. Every personal-looking value is a planted marker (ZZ-FAKE-...) that the hygiene tests look for in every output.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
function dep(name) {
  try { return require(name); } catch { return require(require.resolve(name, { paths: [path.join(REPO, 'resourcer'), process.cwd()] })); }
}
const Database = dep('better-sqlite3');
const tool = require('../../tools/rescreen-policy-rejects');
const migrate = require('../../resourcer/scripts/migrate-schema');

process.env.BACKUP_PASSPHRASE = 'rescreen test passphrase 0123456789';

const NOW = new Date('2026-10-01T12:00:00Z');
const FIXTURES = { 'update-a': require('./fixtures/update-a-rows.json'), head: require('./fixtures/head-rows.json') };
const MARKERS = ['ZZ-FAKE-NAME-1', 'ZZ-FAKE-SURNAME-1', 'zz-fake-email-1@example.invalid', '07000000100', 'ZZ-FAKE-CV-1'];

const londonDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

// a row of the real engine of `set` (update-a | head), re-labelled for one card; `input` carries planted personal-looking text
function row(set, label, over) {
  const f = FIXTURES[set].rows.find((x) => x.label === label);
  if (!f) throw new Error(`no fixture row ${set}/${label}`);
  const r = JSON.parse(JSON.stringify(f.row));
  r.input = `${MARKERS.join(' ')} planted text of card ${over && over.candidateId}`;
  return Object.assign(r, over || {});
}

const DDL = [
  `CREATE TABLE candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, caterer_id INTEGER UNIQUE, reed_id INTEGER UNIQUE, source TEXT NOT NULL DEFAULT 'caterer',
    role TEXT, location TEXT, pulled_date TEXT, unlocked INTEGER DEFAULT 0, zoho_id TEXT, created_at TEXT, zoho_pushed_at TEXT)`,
  `CREATE TRIGGER candidates_set_created_at AFTER INSERT ON candidates FOR EACH ROW WHEN NEW.created_at IS NULL
   BEGIN UPDATE candidates SET created_at = datetime('now') WHERE id = NEW.id; END`,
  `CREATE TABLE candidate_rejections (
    id INTEGER PRIMARY KEY AUTOINCREMENT, caterer_id INTEGER, reed_id INTEGER, job_title TEXT NOT NULL, rejected_at TEXT NOT NULL, origin TEXT)`,
  `CREATE TABLE reed_daily_usage (date TEXT PRIMARY KEY, profile_views INTEGER DEFAULT 0, cv_downloads INTEGER DEFAULT 0, daily_limit INTEGER DEFAULT 300)`,
  `CREATE TABLE territory_searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job_title TEXT NOT NULL, location TEXT NOT NULL, distance INTEGER NOT NULL, keywords TEXT NOT NULL DEFAULT '',
    active_within TEXT NOT NULL DEFAULT '1 month', cv_limit TEXT NOT NULL DEFAULT '20', priority TEXT NOT NULL DEFAULT 'low', enabled INTEGER NOT NULL DEFAULT 1,
    interval_days INTEGER, candidate_count INTEGER, new_to_zoho INTEGER, duplicates INTEGER, skipped INTEGER, errors INTEGER, credits_remaining INTEGER,
    last_searched TEXT, next_run_date TEXT, sources TEXT NOT NULL DEFAULT 'caterer', UNIQUE(job_title COLLATE NOCASE, location COLLATE NOCASE, distance, keywords COLLATE NOCASE))`,
];
const UNIQUE_INDEXES = [
  'CREATE UNIQUE INDEX idx_rej_caterer ON candidate_rejections(caterer_id, job_title) WHERE caterer_id IS NOT NULL',
  'CREATE UNIQUE INDEX idx_rej_reed ON candidate_rejections(reed_id, job_title) WHERE reed_id IS NOT NULL',
];

function makeHome(opts) {
  const o = opts || {};
  const home = fs.mkdtempSync(path.join(process.env.RESCREEN_TEST_TMP || os.tmpdir(), 'rescreen-'));
  for (const d of ['runtime', 'runs', 'shadow', 'pending-searches', 'logs', 'config']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const db = new Database(path.join(home, 'candidates.db'));
  for (const s of DDL) db.exec(s);
  if (!o.noUniqueIndex) for (const s of UNIQUE_INDEXES) db.exec(s);
  migrate.ensureRunResults(db);
  db.close();
  const h = {
    home,
    p: (...x) => path.join(home, ...x),
    db(fn) { const d = new Database(path.join(home, 'candidates.db')); try { return fn(d); } finally { d.close(); } },
    cand(id, o2) {
      const x = Object.assign({ source: 'caterer', unlocked: 0, zoho_id: null }, o2 || {});
      return h.db((d) => d.prepare('INSERT INTO candidates (caterer_id, reed_id, source, unlocked, zoho_id, created_at, role, location) VALUES (?,?,?,?,?,?,?,?)')
        .run(x.source === 'reed' ? null : id, x.source === 'reed' ? id : null, x.source, x.unlocked, x.zoho_id, x.created_at || '2026-09-30 15:00:00', 'Chef', 'LS29').lastInsertRowid);
    },
    rej(id, title, o2) {
      const x = Object.assign({ date: '2026-09-30', origin: 'pipeline', source: 'caterer' }, o2 || {});
      return h.db((d) => d.prepare('INSERT INTO candidate_rejections (caterer_id, reed_id, job_title, rejected_at, origin) VALUES (?,?,?,?,?)')
        .run(x.source === 'reed' ? null : id, x.source === 'reed' ? id : null, title, x.date, x.origin).lastInsertRowid);
    },
    territory(title, loc, o2) {
      const x = Object.assign({ distance: 20, keywords: '', sources: 'both', enabled: 1, next: '2030-01-01', priority: 'low' }, o2 || {});
      h.db((d) => d.prepare('INSERT INTO territory_searches (job_title, location, distance, keywords, sources, enabled, next_run_date, priority, last_searched) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(title, loc, x.distance, x.keywords, x.sources, x.enabled, x.next, x.priority, x.last || '2026-09-20'));
    },
    // a finished run: run_results row (the key phase 2 writes) and the phase 1 status file
    run(stamp, title, loc, o2) {
      const x = Object.assign({ sources: 'caterer', distance: 20, completed: '2026-09-30T16:00:00.000Z', started: '2026-09-30T14:40:00.000Z', key: null, statusFile: true }, o2 || {});
      h.db((d) => d.prepare('INSERT INTO run_results (run_key, date, started_at, completed_at, phase1_started_at, job_title, location, distance, keywords, sources) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(x.key || stamp, x.completed.slice(0, 10), x.started, x.completed, x.started, title, loc, x.distance, '', x.sources));
      if (x.statusFile) fs.writeFileSync(h.p('runs', `phase1-${stamp}.json`), JSON.stringify({ id: `phase1-${stamp}`, status: 'complete', phase2Status: 'done', jobTitle: title, location: loc, distance: x.distance, sources: x.sources, startedAt: x.started }));
    },
    shadow(rows, mode) {
      const byDay = new Map();
      for (const r of rows) { const d = londonDay(new Date(r.ts)); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(r); }
      for (const [d, list] of byDay) {
        const f = h.p('shadow', `screening-${d}.jsonl`);
        fs.appendFileSync(f, `${list.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: mode === undefined ? 0o600 : mode });
        fs.chmodSync(f, mode === undefined ? 0o600 : mode);
      }
    },
    rejections: () => h.db((d) => d.prepare('SELECT * FROM candidate_rejections ORDER BY id').all()),
    candidates: () => h.db((d) => d.prepare('SELECT * FROM candidates ORDER BY id').all()),
    counts: () => h.db((d) => Object.fromEntries(['candidates', 'candidate_rejections', 'territory_searches', 'run_results'].map((t) => [t, d.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c]))),
    // everything an operation may change: every table row, every file (name and content hash) except the database files themselves
    snapshot() {
      const dump = h.db((d) => ['candidates', 'candidate_rejections', 'territory_searches', 'run_results', 'reed_daily_usage'].map((t) => d.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));
      const files = [];
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const f = path.join(dir, e.name);
          if (e.isDirectory()) walk(f);
          else if (!/^candidates\.db/.test(e.name)) files.push(`${path.relative(home, f)}:${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}`);
        }
      };
      walk(home);
      return JSON.stringify({ dump, files: files.sort() });
    },
    cleanup() { fs.rmSync(home, { recursive: true, force: true }); },
  };
  return h;
}

// the tool as the tests call it: fixed clock, no run in flight unless a test says so, a cheap key derivation for the backup
async function run(h, args, extra) {
  const out = [];
  const err = [];
  const io = Object.assign({
    out: (s) => out.push(s), err: (s) => err.push(s), now: NOW, env: { RESOURCER_HOME: h.home, RESOURCER_SOURCES: 'both' },
    busy: () => false, backup: { log2n: 12 },
  }, extra || {});
  const code = await tool.main(['--home', h.home].concat(args), io);
  return { code, out: out.join('\n'), err: err.join('\n'), all: `${out.join('\n')}\n${err.join('\n')}` };
}
const json = async (h, args, extra) => { const r = await run(h, args.concat('--json'), extra); return Object.assign(r, { j: r.out ? JSON.parse(r.out) : null }); };

// The standard world of the selection tests. Every card is a Caterer card for the title Chef unless stated; the decisions are rows of the REAL engines.
const T0 = '2026-09-30T15:00:00.000Z';
const T1 = '2026-09-30T16:00:00.000Z';
const T2 = '2026-10-01T08:00:00.000Z';
function standardWorld(opts) {
  const h = makeHome(opts);
  h.territory('Chef', 'LS29', { sources: 'both' });
  h.territory('Kitchen Porter', 'M1', { sources: 'caterer' });
  h.run('2026-09-30-1500', 'Chef', 'LS29', { sources: 'both' });
  h.run('2026-09-30-1600', 'Kitchen Porter', 'M1', { sources: 'caterer', completed: '2026-09-30T17:00:00.000Z', started: '2026-09-30T15:50:00.000Z' });
  const rows = [];
  const ok = (id, label, ts, runId, title) => rows.push(row('update-a', label, { candidateId: String(id), ts, runId: runId || 'phase1-2026-09-30-1500', jobTitle: title || 'Chef' }));
  // eligible: the policy rejected an uncertain card, the rejection is stored
  ok(1001, 'uncertain_ambiguous', T0); h.cand(1001); h.rej(1001, 'Chef');
  ok(1002, 'uncertain_x', T1, 'phase1-2026-09-30-1600', 'Kitchen Porter'); h.cand(1002); h.rej(1002, 'Kitchen Porter');
  ok(1003, 'uncertain_ambiguous', T2, 'phase1-2026-09-30-1500'); h.rej(1003, 'Chef', { date: '2026-10-01' }); // no candidates row at all: still eligible
  // never selected: not a policy rejection because Jev was uncertain
  ok(1011, 'injection_keyword', T0); h.rej(1011, 'Chef');
  ok(1012, 'injection_jev', T0); h.rej(1012, 'Chef');
  ok(1013, 'empty', T0); h.rej(1013, 'Chef');
  ok(1014, 'jev_reject', T0); h.rej(1014, 'Chef');
  ok(1015, 'policy_approve_pre', T0);
  ok(1016, 'invalid', T0);
  ok(1017, 'post_unlock_policy_reject', T0); h.rej(1017, 'Chef');
  // excluded, each for one reason
  ok(1021, 'uncertain_ambiguous', T0); h.cand(1021, { unlocked: 1 }); h.rej(1021, 'Chef');
  ok(1022, 'uncertain_ambiguous', T0); h.cand(1022, { zoho_id: 'ZOHO-1' }); h.rej(1022, 'Chef');
  ok(1023, 'uncertain_ambiguous', T0); h.rej(1023, 'Chef', { origin: 'cv:no_relevant_experience' });
  ok(1024, 'uncertain_ambiguous', T0);
  ok(1025, 'uncertain_ambiguous', T0); h.rej(1025, 'Kitchen Porter');
  ok(1026, 'uncertain_ambiguous', T0); h.rej(1026, 'Chef'); rows.push(row('head', 'jev_approve', { candidateId: '1026', ts: T2, runId: 'phase1-2026-10-01-0900', jobTitle: 'Chef' }));
  ok(1027, 'uncertain_ambiguous', T0); h.rej(1027, 'Chef'); rows.push(row('update-a', 'policy_approve_pre', { candidateId: '1027', ts: T2, runId: 'phase1-2026-10-01-0900', jobTitle: 'Chef' }));
  ok(1028, 'uncertain_ambiguous', T0); h.rej(1028, 'Chef', { date: '2026-09-20' });
  ok(1029, 'uncertain_ambiguous', T0); h.rej(1029, 'Chef'); h.rej(1029, '*', { origin: 'pipeline' });
  ok(1030, 'uncertain_ambiguous', T0); h.rej(1030, 'Chef', { origin: null });
  ok('canary-yes', 'uncertain_ambiguous', T0);
  rows.push(row('update-a', 'uncertain_ambiguous', { candidateId: '1031', ts: T0, source: 'mystery', jobTitle: 'Chef' }));
  // a card Jev decided about another title since: irrelevant to this title, so 1032 stays eligible
  ok(1032, 'uncertain_ambiguous', T0); h.rej(1032, 'Chef'); rows.push(row('head', 'jev_approve', { candidateId: '1032', ts: T2, runId: 'phase1-2026-10-01-0900', jobTitle: 'Kitchen Porter' }));
  // Reed
  const reed = (id, label, ts) => rows.push(row('update-a', label, { candidateId: String(id), ts, runId: null, source: 'reed', jobTitle: 'Chef' }));
  reed(9001, 'reed_uncertain', T0); h.cand(9001, { source: 'reed' });
  reed(9002, 'reed_uncertain', T0); h.cand(9002, { source: 'reed', unlocked: 1 });
  reed(9003, 'reed_uncertain', T0);
  reed(9004, 'reed_uncertain', T0); h.cand(9004, { source: 'reed', zoho_id: 'ZOHO-2' });
  reed(9005, 'reed_uncertain', T0); h.cand(9005, { source: 'reed' });
  h.shadow(rows);
  return h;
}

module.exports = { REPO, dep, Database, tool, NOW, FIXTURES, MARKERS, row, makeHome, run, json, standardWorld, londonDay, T0, T1, T2 };
