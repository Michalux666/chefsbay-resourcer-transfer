'use strict';

// Reed Phase 1 and the role scope (docs/ROLESCOPE.md): reed-phase1.js against the fake Reed world, the fake screening CLI and the REAL candidates-db.js on a temp
// SQLite file (legacy schema). R-C1: a Reed card rejected at the snippet stage is recorded per job title (candidate_rejections, origin reed:snippet) and is
// screened as normal under ANOTHER title, skipped under the same one. R-C2: a seen-only row with no title record (the rows of the old system) is let through to
// screening ONCE for whatever title the search is for, bounded by the page, the run limit and the daily views. R-C6: nobody mid-processing is touched.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withWorld } = require('./helpers/world');
const { dep, REPO } = require('./helpers/mirror');
const fr = require('./helpers/fake-reed');

const world = (fn, o) => withWorld(fn, { fake: { loggedIn: true }, ...(o || {}) });
const ARGS = (extra, title) => ['--job-title', title || 'Chef', '--location', 'LS1', '--distance', '20', '--run-id', 't1', ...(extra || [])];
const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// the real database module in the mirror, a legacy-schema database, and the rows of the old runs: cands [{id, unlocked, zoho, created}], rejections [[id, title, origin]]
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
    for (const c of rows.cands || []) db.prepare("INSERT INTO candidates (reed_id, source, unlocked, zoho_id) VALUES (?, 'reed', ?, ?)").run(c.id, c.unlocked || 0, c.zoho || null);
    for (const r of rows.rejections || []) db.prepare("INSERT INTO candidate_rejections (reed_id, job_title, rejected_at, origin) VALUES (?, ?, '2026-09-01', ?)").run(r[0], r[1], r[2]);
    if (rows.usage) db.prepare('INSERT INTO reed_daily_usage (date, profile_views, daily_limit) VALUES (?, ?, ?)').run(day(), rows.usage[0], rows.usage[1]);
  } finally { db.close(); }
}
const q = (m, sql, ...a) => { const D = dep('better-sqlite3'); const db = new D(m.p('candidates.db'), { readonly: true }); try { return db.prepare(sql).all(...a); } finally { db.close(); } };
const rowsOf = (m, id) => q(m, 'SELECT job_title AS title, origin FROM candidate_rejections WHERE reed_id = ? ORDER BY id', id);
const queue = (m, id = 't1') => m.readJson(`downloads/reed-approved-queue-${id}.json`);
const aiLog = (m) => m.readLines('ai-log.jsonl');
const screenedIds = (m) => aiLog(m).flatMap((x) => x.ids).map(String);
const state = (m) => (m.exists('runtime/cv-resurface.json') ? m.readJson('runtime/cv-resurface.json') : null);
const SEEN = (ids, extra) => ({ cands: ids.map((id) => Object.assign({ id }, extra && extra[id])) });

test('RR1 a Reed card rejected at the snippet stage is recorded for its job title; the same profile under the SAME title is skipped, under ANOTHER title it is screened as normal (R-C1)', () => world(async ({ m, run }) => {
  realDb(m, {});
  const r1 = await run('reed-phase1.js', ARGS(), { env: { FAKE_AI_REJECT_IDS: '9002,9003' } });
  assert.strictEqual(r1.code, 0, r1.stderr + r1.stdout);
  assert.deepStrictEqual(rowsOf(m, 9002), [{ title: 'Chef', origin: 'reed:snippet' }]);
  assert.deepStrictEqual(rowsOf(m, 9001), [{ title: 'Chef', origin: 'reed:approved' }], 'an approval is recorded for its title too (never screened, viewed and charged twice for one title)');
  assert.strictEqual(q(m, 'SELECT unlocked FROM candidates WHERE reed_id = 9002')[0].unlocked, 0, 'the seen row is written as before');
  const n1 = screenedIds(m).length;
  // the same title again (another territory): nobody is screened again
  const r2 = await run('reed-phase1.js', ARGS(['--run-id', 't2']));
  assert.strictEqual(r2.code, 0, r2.stderr);
  assert.strictEqual(screenedIds(m).length, n1, 'nobody was screened again for the same title');
  assert.strictEqual(queue(m, 't2').phase1Stats.inDb, 30);
  // ANOTHER title: the two rejected ones are screened as normal, nobody else (the approved ones are in flight: their queue is not finished)
  const r3 = await run('reed-phase1.js', ARGS(['--run-id', 't3'], 'Kitchen Porter'));
  assert.strictEqual(r3.code, 0, r3.stderr + r3.stdout);
  assert.deepStrictEqual(screenedIds(m).slice(n1).sort(), ['9002', '9003'], 'the rejected ones come up for the new title, and only they');
  const q3 = queue(m, 't3');
  assert.deepStrictEqual(q3.candidates.map((c) => c.id).sort(), [9002, 9003], 'approved for the new title (the fake approves everyone it is not told to reject)');
  assert.ok(!q3.candidates.some((c) => 'resurfaced' in c || 'legacy' in c), 'an ordinary screening: no claim, no flag');
  assert.deepStrictEqual(q3.phase1Stats.roleScope, { scopedScreened: 2, scopedRejected: 0, scopedApproved: 2 });
  assert.ok(!('resurfaced' in q3.phase1Stats), 'not a second look');
  assert.deepStrictEqual(rowsOf(m, 9002), [{ title: 'Chef', origin: 'reed:snippet' }, { title: 'Kitchen Porter', origin: 'reed:approved' }]);
  assert.strictEqual(state(m), null, 'no counter: nothing was claimed or counted');
  // and each title once: the same two again for either title are skipped
  const n3 = screenedIds(m).length;
  await run('reed-phase1.js', ARGS(['--run-id', 't4'], 'Kitchen Porter'));
  await run('reed-phase1.js', ARGS(['--run-id', 't5']));
  assert.strictEqual(screenedIds(m).length, n3);
}));

test('RR1 a rejection for the new title is recorded too: three titles, three rows, each screened once, never twice for the same title', () => world(async ({ m, run }) => {
  realDb(m, {});
  await run('reed-phase1.js', ARGS(), { env: { FAKE_AI_REJECT_IDS: '9002' } });
  await run('reed-phase1.js', ARGS(['--run-id', 't2'], 'Kitchen Porter'), { env: { FAKE_AI_REJECT_IDS: '9002' } });
  await run('reed-phase1.js', ARGS(['--run-id', 't3'], 'Sous Chef'), { env: { FAKE_AI_REJECT_IDS: '9002' } });
  assert.deepStrictEqual(rowsOf(m, 9002), [{ title: 'Chef', origin: 'reed:snippet' }, { title: 'Kitchen Porter', origin: 'reed:snippet' }, { title: 'Sous Chef', origin: 'reed:snippet' }]);
  assert.strictEqual(screenedIds(m).filter((x) => x === '9002').length, 3);
  for (const t of ['Chef', 'Kitchen Porter', 'Sous Chef']) await run('reed-phase1.js', ARGS(['--run-id', `again-${t}`], t));
  assert.strictEqual(screenedIds(m).filter((x) => x === '9002').length, 3, 'a fourth and fifth look never happened');
}));

test('RR2 legacy: a seen-only person with no title record is screened ONCE for whatever title the search is for; a rejection is recorded for it, an approval is queued as a claimed look (R-C2)', () => world(async ({ m, run }) => {
  realDb(m, SEEN([9001, 9002, 9003]));
  const r = await run('reed-phase1.js', ARGS(), { env: { FAKE_AI_REJECT_IDS: '9002' } });
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  const qd = queue(m);
  assert.deepStrictEqual(screenedIds(m).slice(0, 30).filter((x) => ['9001', '9002', '9003'].includes(x)).sort(), ['9001', '9002', '9003'], 'the three old rows were screened');
  const c1 = qd.candidates.find((c) => c.id === 9001);
  assert.deepStrictEqual([c1.resurfaced, c1.legacy], [true, true], 'approved: queued as a look that Phase 2 claims before the profile view');
  assert.deepStrictEqual(rowsOf(m, 9001), [], 'the claim is written by Phase 2, right before the view: Phase 1 records nothing for an approval');
  assert.deepStrictEqual(rowsOf(m, 9002), [{ title: 'Chef', origin: 'reed:snippet' }], 'rejected: recorded for the title, so it is never screened for it again');
  assert.deepStrictEqual(qd.phase1Stats.resurfaced, { eligible: 3, candidates: 2, legacy: { screened: 3, rejectedAtSnippet: 1, candidates: 2 } });
  assert.match(r.stderr + r.stdout, /\[9001\] ROLE SCOPE \(seen before, the role was never recorded, never pushed\): screened once for this role/);
  const t = state(m).today;
  assert.deepStrictEqual([t.legacyReed, t.legacyRejected, t.legacyCaterer], [1, 1, 0], 'counted: one look given and rejected again at the snippet stage; the approvals are counted when Phase 2 claims them');
  assert.deepStrictEqual([t.started, t.reed], [0, 0], 'no slot of the daily cap: the Reed daily views and the run limit bound the Reed looks');
  // the next search for the same title: the rejected one is judged, the two approved are in flight (their queue is not finished): nobody is screened
  const n = screenedIds(m).length;
  const again = await run('reed-phase1.js', ARGS(['--run-id', 't2']));
  assert.strictEqual(again.code, 0, again.stderr);
  assert.strictEqual(screenedIds(m).length, n, 'nobody screened a second time for the same title');
  // another title: the rejected one is a scoped screening (no claim), the approved ones are still in flight
  const other = await run('reed-phase1.js', ARGS(['--run-id', 't3'], 'Kitchen Porter'));
  assert.strictEqual(other.code, 0, other.stderr);
  assert.deepStrictEqual(screenedIds(m).slice(n).sort(), ['9002']);
}));

test('RR2 a legacy person whose role was looked at (the claim row of Phase 2, or a look of the role scope) is screened for a NEW role, once; never for the same one', () => world(async ({ m, run }) => {
  realDb(m, { cands: [{ id: 9001 }, { id: 9002 }], rejections: [[9001, 'Head Chef', 'resurface:started'], [9002, 'Head Chef', 'resurface:snippet']] });
  const r = await run('reed-phase1.js', ARGS(), { env: { FAKE_AI_REJECT_IDS: '9002' } });
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  assert.deepStrictEqual(screenedIds(m).slice(0, 2).sort(), ['9001', '9002']);
  const qd = queue(m);
  assert.deepStrictEqual(qd.candidates.filter((c) => [9001, 9002].includes(c.id)).map((c) => [c.id, c.legacy]), [[9001, true]]);
  assert.deepStrictEqual(rowsOf(m, 9002), [{ title: 'Head Chef', origin: 'resurface:snippet' }, { title: 'Chef', origin: 'reed:snippet' }]);
}));

test('RR3 safety (R-C6): a person in Zoho, one profile-viewed (unlocked 1), one with a candidate file, a CV file, or an entry of an unfinished queue is never let through; with the switch off every seen row is skipped as before', () => world(async ({ m, run }) => {
  realDb(m, { cands: [{ id: 9001, zoho: 'ZOHO-9001' }, { id: 9002, unlocked: 1 }, { id: 9003 }, { id: 9004 }, { id: 9005 }, { id: 9006 }] });
  m.write('downloads/candidate-9003.json', {});
  m.write('downloads/cv-reed-9004.pdf', 'x');
  m.write('downloads/reed-approved-queue-earlier.json', { candidates: [{ id: 9005 }] });
  const r = await run('reed-phase1.js', ARGS());
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  const screened = screenedIds(m);
  for (const id of ['9001', '9002', '9003', '9004', '9005']) assert.ok(!screened.includes(id), `${id} was not screened`);
  assert.ok(screened.includes('9006'), 'the one nobody is working on is');
  assert.deepStrictEqual(rowsOf(m, 9001), []);
  assert.deepStrictEqual(rowsOf(m, 9002), []);
  // the switch off: the old skip for every seen row (the title-scoped rows keep working)
  fs.rmSync(m.p('candidates.db'), { force: true });
  realDb(m, SEEN([9001, 9002, 9003, 9004, 9005, 9006]));
  fs.rmSync(m.p('downloads'), { recursive: true, force: true });
  const r2 = await run('reed-phase1.js', ARGS(['--run-id', 't2']), { env: { ROLE_SCOPE_LEGACY: 'off' } });
  assert.strictEqual(r2.code, 0, r2.stderr);
  assert.strictEqual(queue(m, 't2').phase1Stats.inDb, 6, 'every seen row is skipped');
  assert.ok(!('resurfaced' in queue(m, 't2').phase1Stats));
}));

test('RR4 the cross-source dedupe still works for a person the role scope lets through: a match in the Caterer queue is skipped, nothing is recorded for it', () => world(async ({ m, run }) => {
  realDb(m, SEEN([9001, 9002]));
  m.write('downloads/approved-queue-cat.json', { candidates: [{ name: 'Test Person 2', currentLocation: 'Town2' }] });
  const r = await run('reed-phase1.js', ARGS(['--caterer-queue', m.p('downloads/approved-queue-cat.json')]));
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  assert.ok(!screenedIds(m).includes('9002'));
  assert.ok(screenedIds(m).includes('9001'));
  assert.strictEqual(queue(m).phase1Stats.crossDedup, 1);
  assert.deepStrictEqual(rowsOf(m, 9002), [], 'nothing recorded: they come up again');
}));

test('RR5 no flood: a search that meets 500 legacy profiles screens them in the normal pages of 25; the approvals stay inside the run limit and inside the daily views', () => world(async ({ m, fake, run }) => {
  fake.api.candidates.splice(0, fake.api.candidates.length, ...Array.from({ length: 500 }, (_, i) => fr.makeCard(i + 1)));
  realDb(m, { cands: Array.from({ length: 500 }, (_, i) => ({ id: 9001 + i })), usage: [0, 300] });
  const r = await run('reed-phase1.js', ARGS(['--cv-limit', '20']));
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  const calls = aiLog(m);
  assert.ok(calls.length >= 1 && calls.every((c) => c.ids.length <= 25), 'normal batches of at most one page');
  const qd = queue(m);
  assert.strictEqual(qd.candidates.length, 20, 'the run limit');
  assert.ok(qd.candidates.every((c) => c.resurfaced === true && c.legacy === true));
  assert.ok(screenedIds(m).length <= 200, `${screenedIds(m).length} screened: the overfetch of the run limit, never the 500`);
  assert.strictEqual(rowsOf(m, 9500).length, 0, 'the people never reached are untouched');
  // five views left today: the run limit is lowered to five, the approvals stay inside it
  fs.rmSync(m.p('downloads'), { recursive: true, force: true });
  const D = dep('better-sqlite3');
  const w = new D(m.p('candidates.db'));
  try { w.prepare('DELETE FROM candidate_rejections').run(); w.prepare('UPDATE reed_daily_usage SET profile_views = 295').run(); } finally { w.close(); }
  const r2 = await run('reed-phase1.js', ARGS(['--cv-limit', '20', '--run-id', 't2']), { env: { ROLE_SCOPE_LEGACY: 'on' } });
  assert.strictEqual(r2.code, 0, r2.stderr + r2.stdout);
  assert.strictEqual(queue(m, 't2').candidates.length, 5, 'only five profile views are left today: five approvals at most');
  // no views left: nothing is screened at all
  const w2 = new D(m.p('candidates.db'));
  try { w2.prepare('UPDATE reed_daily_usage SET profile_views = 300').run(); } finally { w2.close(); }
  const before = screenedIds(m).length;
  const r3 = await run('reed-phase1.js', ARGS(['--run-id', 't3']));
  assert.match(r3.stdout, /REED_DAILY_LIMIT/);
  assert.strictEqual(screenedIds(m).length, before);
}));

test('RR11 the run bound (ROLE_SCOPE_REED_MAX_PER_RUN, default 100): one run lets at most that many people of unrecorded role through, the rest keep the old skip with no row and are met by a later run; 0 lets none through', () => world(async ({ m, fake, run }) => {
  fake.api.candidates.splice(0, fake.api.candidates.length, ...Array.from({ length: 120 }, (_, i) => fr.makeCard(i + 1)));
  realDb(m, { cands: Array.from({ length: 120 }, (_, i) => ({ id: 9001 + i })), usage: [0, 300] });
  const r1 = await run('reed-phase1.js', ARGS(), { env: { ROLE_SCOPE_REED_MAX_PER_RUN: '30' } });
  assert.strictEqual(r1.code, 0, r1.stderr + r1.stdout);
  const first = screenedIds(m);
  assert.strictEqual(first.length, 30, 'only 30 of the 120 were screened by this run');
  assert.match(r1.stderr + r1.stdout, /the limit of 30 people of unrecorded role per run is reached/);
  assert.strictEqual(rowsOf(m, 9120).length, 0, 'the ones held back by the bound have no row: nothing was recorded for them');
  // a later run meets the next ones (the first 30 are judged for this title now)
  const r2 = await run('reed-phase1.js', ARGS(['--run-id', 't2']), { env: { ROLE_SCOPE_REED_MAX_PER_RUN: '30' } });
  assert.strictEqual(r2.code, 0, r2.stderr + r2.stdout);
  const second = screenedIds(m).slice(30);
  assert.strictEqual(second.length, 30);
  assert.ok(second.every((id) => !first.includes(id)), 'nobody is screened twice for the same title');
  // 0 lets none through
  const before = screenedIds(m).length;
  const r3 = await run('reed-phase1.js', ARGS(['--run-id', 't3']), { env: { ROLE_SCOPE_REED_MAX_PER_RUN: '0' } });
  assert.strictEqual(r3.code, 0, r3.stderr + r3.stdout);
  assert.strictEqual(screenedIds(m).length, before);
}));

test('RR6 a screening that is unavailable records nothing: the legacy people of the page are retried and keep every rule (no row, no flag lost)', () => world(async ({ m, run }) => {
  realDb(m, SEEN([9001, 9002]));
  const r = await run('reed-phase1.js', ARGS(), { env: { FAKE_AI_PLAN: 'unavailable,ok', SCREEN_PAGE_RETRY_PAUSE_SEC: '0', REED_CV_DELAY_MS: '0' } });
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  const qd = queue(m);
  assert.strictEqual(qd.phase1Stats.resurfaced.legacy.screened, 2, 'counted once, not once per attempt');
  assert.ok(qd.candidates.some((c) => c.id === 9001 && c.legacy === true));
}));

test('RR7 a database that cannot answer keeps the old skip for every seen row (never a crash, never a flood): the role-scope table is gone', () => world(async ({ m, run }) => {
  realDb(m, SEEN([9001, 9002]));
  const D = dep('better-sqlite3');
  const w = new D(m.p('candidates.db'));
  try { w.exec('DROP TABLE candidate_rejections'); } finally { w.close(); }
  const r = await run('reed-phase1.js', ARGS());
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  const screened = screenedIds(m);
  assert.ok(!screened.includes('9001') && !screened.includes('9002'), 'the old skip');
  assert.strictEqual(queue(m).phase1Stats.inDb, 2);
}));

test('RR8 the run limit and the pages: a search with the legacy people and new ones screens each person once per title, and the approvals of this run get their title row after the queue exists', () => world(async ({ m, run }) => {
  realDb(m, SEEN([9001]));
  await run('reed-phase1.js', ARGS());
  const qd = queue(m);
  assert.strictEqual(qd.candidates.length, 30);
  assert.deepStrictEqual(rowsOf(m, 9005), [{ title: 'Chef', origin: 'reed:approved' }], 'a brand new approval: one row for its title');
  assert.deepStrictEqual(rowsOf(m, 9001), [], 'a claimed look: its row is the claim of Phase 2');
  assert.strictEqual(q(m, 'SELECT COUNT(*) c FROM candidate_rejections')[0].c, 29);
}));
