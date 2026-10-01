'use strict';

// Reed Phase 1 and the role-scoped second look (docs/RESURFACE.md): reed-phase1.js against the fake Reed world, the fake screening CLI and the REAL
// candidates-db.js on a temp SQLite file. A Reed candidate whose CV was rejected for another role (a cv: row, no Zoho id) is screened again for this
// role; a Reed snippet rejection has no row and stays skipped (Reed snippet rejections are permanent, unchanged).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withWorld } = require('./helpers/world');
const { dep, REPO } = require('./helpers/mirror');

const world = (fn, o) => withWorld(fn, { fake: { loggedIn: true }, ...(o || {}) });
const ARGS = (extra) => ['--job-title', 'Chef', '--location', 'LS1', '--distance', '20', '--run-id', 't1', ...(extra || [])];
const OLD = 'Head Chef';

// the REAL database module in the mirror (the mirror ships a stub), and a legacy-schema database with the rows of the old runs
function realDb(m, rows) {
  fs.copyFileSync(path.join(REPO, 'resourcer', 'candidates-db.js'), m.p('candidates-db.js'));
  const D = dep('better-sqlite3');
  const db = new D(m.p('candidates.db'));
  try {
    db.exec(`CREATE TABLE candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, caterer_id INTEGER UNIQUE, reed_id INTEGER UNIQUE, source TEXT NOT NULL DEFAULT 'caterer',
      role TEXT, location TEXT, pulled_date TEXT, unlocked INTEGER DEFAULT 0, zoho_id TEXT, created_at TEXT, zoho_pushed_at TEXT);
      CREATE TABLE candidate_rejections (id INTEGER PRIMARY KEY AUTOINCREMENT, caterer_id INTEGER, reed_id INTEGER, job_title TEXT NOT NULL, rejected_at TEXT NOT NULL, origin TEXT);
      CREATE UNIQUE INDEX idx_rej_reed ON candidate_rejections(reed_id, job_title) WHERE reed_id IS NOT NULL;
      CREATE TABLE reed_daily_usage (date TEXT PRIMARY KEY, profile_views INTEGER DEFAULT 0, cv_downloads INTEGER DEFAULT 0, daily_limit INTEGER DEFAULT 300);`);
    for (const c of rows.cands || []) db.prepare("INSERT INTO candidates (reed_id, source, unlocked, zoho_id) VALUES (?, 'reed', 0, ?)").run(c.id, c.zoho || null);
    for (const r of rows.rejections || []) db.prepare("INSERT INTO candidate_rejections (reed_id, job_title, rejected_at, origin) VALUES (?, ?, '2026-09-01', ?)").run(r[0], r[1], r[2]);
  } finally { db.close(); }
}
const rowsOf = (m, id) => { const D = dep('better-sqlite3'); const db = new D(m.p('candidates.db'), { readonly: true }); try { return db.prepare('SELECT job_title AS title, origin FROM candidate_rejections WHERE reed_id = ? ORDER BY id').all(id); } finally { db.close(); } };
const queue = (m, id = 't1') => m.readJson(`downloads/reed-approved-queue-${id}.json`);
const aiLog = (m) => m.readLines('ai-log.jsonl');
const screenedIds = (m) => aiLog(m).flatMap((x) => x.ids).map(String);
const alerts = (m) => m.readLines('outbox/alerts.jsonl');
const state = (m) => (m.exists('runtime/cv-resurface.json') ? m.readJson('runtime/cv-resurface.json') : null);
const SEED = {
  cands: [{ id: 9001 }, { id: 9002 }, { id: 9003, zoho: 'ZOHO-9003' }, { id: 9004 }, { id: 9005 }],
  rejections: [[9001, OLD, 'cv:under_qualified'], [9003, OLD, 'cv:under_qualified'], [9004, 'Chef', 'cv:over_qualified'], [9004, OLD, 'cv:under_qualified'], [9005, OLD, 'cv:under_qualified'], [9005, 'Chef', 'resurface:started']],
};
// these tests prove the CV rule: the role scope for people whose role was never recorded (ROLE_SCOPE_LEGACY, on in production) is switched off here, so a seen-only
// person keeps the old skip; tests/reed/rolescope-phase1.test.js proves the role scope
const ON = { CV_SCREEN: 'on', ROLE_SCOPE_LEGACY: 'off' };

test('C10 a Reed candidate whose CV was rejected for another role is screened again and queued with the resurfaced flag; seen-only, pushed and already-judged candidates stay skipped', () => world(async ({ m, run }) => {
  realDb(m, SEED);
  const r = await run('reed-phase1.js', ARGS(), { env: ON });
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  const q = queue(m);
  const ids = q.candidates.map((c) => c.id);
  assert.ok(ids.includes(9001), '9001 was rejected for Head Chef only: screened again for Chef');
  for (const skipped of [9002, 9003, 9004, 9005]) assert.ok(!ids.includes(skipped), `${skipped} stays skipped`);
  const c = q.candidates.find((x) => x.id === 9001);
  assert.strictEqual(c.resurfaced, true);
  assert.ok(!q.candidates.filter((x) => x.id !== 9001).some((x) => 'resurfaced' in x), 'a new candidate carries no flag');
  assert.deepStrictEqual(q.phase1Stats.resurfaced, { eligible: 1, candidates: 1 });
  assert.strictEqual(q.phase1Stats.inDb, 4);
  assert.ok(screenedIds(m).includes('9001'), 'the snippet screening decided for this role');
  assert.ok(/RESURFACE \(CV rejected for another role, never pushed\)/.test(r.stderr + r.stdout));
  assert.deepStrictEqual(rowsOf(m, 9001), [{ title: OLD, origin: 'cv:under_qualified' }], 'Phase 1 records nothing: the claim is written in Phase 2, right before the download');
  assert.strictEqual(state(m), null);
}));

test('C4 a resurfaced Reed candidate the snippet screening rejects for this role is recorded for this role and never screened for it again', () => world(async ({ m, run }) => {
  realDb(m, SEED);
  const r = await run('reed-phase1.js', ARGS(), { env: { ...ON, FAKE_AI_REJECT_IDS: '9001' } });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(!queue(m).candidates.some((c) => c.id === 9001));
  assert.deepStrictEqual(rowsOf(m, 9001), [{ title: OLD, origin: 'cv:under_qualified' }, { title: 'Chef', origin: 'resurface:snippet' }]);
  const before = screenedIds(m).filter((x) => x === '9001').length;
  const again = await run('reed-phase1.js', ARGS(['--run-id', 't2']), { env: ON });
  assert.strictEqual(again.code, 0, again.stderr);
  assert.strictEqual(screenedIds(m).filter((x) => x === '9001').length, before, 'screened once for this role');
}));

test('C4 C10 an ordinary Reed snippet rejection is recorded for its job title (reed:snippet) and is skipped for that title for ever; nothing else is written (docs/ROLESCOPE.md)', () => world(async ({ m, run }) => {
  realDb(m, SEED);
  await run('reed-phase1.js', ARGS(), { env: { ...ON, FAKE_AI_REJECT_IDS: '9010' } });
  assert.deepStrictEqual(rowsOf(m, 9010), [{ title: 'Chef', origin: 'reed:snippet' }]);
  const again = await run('reed-phase1.js', ARGS(['--run-id', 't2']), { env: ON });
  assert.strictEqual(screenedIds(m).filter((x) => x === '9010').length, 1, '9010 was screened once and is skipped now');
  assert.ok(!queue(m, 't2').candidates.some((c) => c.id === 9010));
}));

test('C5 C6 with CV_SCREEN shadow, off or unset, or CV_RESURFACE=off, a Reed candidate is skipped exactly as before: nothing flagged, no key in the queue', () => world(async ({ m, run }) => {
  realDb(m, SEED);
  let n = 0;
  for (const env0 of [{ CV_SCREEN: 'shadow' }, { CV_SCREEN: 'off' }, {}, { CV_SCREEN: 'on', CV_RESURFACE: 'off' }, { CV_SCREEN: 'on', CV_RESURFACE_MAX_PER_DAY: '0' }]) {
    const env = { ...env0, ROLE_SCOPE_LEGACY: 'off' };
    n += 1;
    const r = await run('reed-phase1.js', ARGS(['--run-id', `off${n}`]), { env });
    assert.strictEqual(r.code, 0, r.stderr);
    const q = queue(m, `off${n}`);
    assert.ok(!q.candidates.some((c) => c.id === 9001 || 'resurfaced' in c), JSON.stringify(env));
    assert.ok(!('resurfaced' in q.phase1Stats));
    if (n === 1) assert.strictEqual(q.phase1Stats.inDb, 5, 'the five known candidates, exactly as before');
  }
}));

test('C8 the daily cap holds the rest of a page back: they stay skipped, nothing is recorded, one warning, the count in the counters', () => world(async ({ m, run }) => {
  realDb(m, { cands: [{ id: 9001 }, { id: 9002 }, { id: 9003 }], rejections: [[9001, OLD, 'cv:a'], [9002, OLD, 'cv:a'], [9003, OLD, 'cv:a']] });
  const r = await run('reed-phase1.js', ARGS(), { env: { ...ON, CV_RESURFACE_MAX_PER_DAY: '2' } });
  assert.strictEqual(r.code, 0, r.stderr);
  const q = queue(m);
  assert.deepStrictEqual(q.candidates.filter((c) => c.resurfaced).map((c) => c.id), [9001, 9002]);
  assert.ok(!q.candidates.some((c) => c.id === 9003));
  assert.deepStrictEqual(rowsOf(m, 9003), [{ title: OLD, origin: 'cv:a' }]);
  assert.strictEqual(alerts(m).filter((a) => a.key === 'cv-resurface-cap-reached').length, 1);
  assert.strictEqual(state(m).today.capped, 1);
}));
