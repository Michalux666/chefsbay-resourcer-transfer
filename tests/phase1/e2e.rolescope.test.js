'use strict';
// Phase 1 and the role scope for people whose role was never recorded (docs/ROLESCOPE.md R-C3), against the REAL candidates-db.js on a temp SQLite file (legacy
// schema) with the fake Caterer neighbours: an unlocked, never-pushed, old person with NO rejection record is screened once for the title of the search
// (ROLE_SCOPE_LEGACY, default on, independent of CV_SCREEN); if the snippet screening approves, the unlock is called again (a further unlock is accepted), the claim is in
// the database BEFORE the unlock, the cost is measured, and the role is recorded whatever the outcome. The cap and the credit reserve apply; the old skip holds for
// the young, the pushed and everyone in flight.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./harness');
const Database = require('../lifecycle/helpers/sqlite');
const { createLegacyDb } = require('../lifecycle/helpers/legacy-schema');

const { card } = h;
const NM = [path.join(h.SRC, 'node_modules')].concat((process.env.NODE_PATH || '').split(path.delimiter)).find((d) => d && fs.existsSync(path.join(d, 'better-sqlite3')));
const skip = NM ? false : 'better-sqlite3 is not available';

const prev = (id, over) => card(id, Object.assign({ unlockedPrev: true, neverUnlocked: false }, over || {}));
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');

// rows: cands [{id, unlocked, zoho, created (null = a legacy row that never had a created_at)}], rejections [[id, title, origin]]
function homeOf(t, scenario, rows) {
  const home = h.makeHome(Object.assign({ pages: { 1: { cards: [] }, 2: { cards: [] } }, creditsStart: 5000, probeDb: true }, scenario), { real: ['run-lock'], resurface: true });
  t.after(() => h.cleanup(home));
  fs.copyFileSync(path.join(h.SRC, 'candidates-db.js'), path.join(home, 'candidates-db.js'));
  createLegacyDb(path.join(home, 'candidates.db'), { rows: [] });
  const db = new Database(path.join(home, 'candidates.db'));
  try {
    for (const c of (rows || {}).cands || []) {
      db.prepare('INSERT INTO candidates (caterer_id, source, unlocked, zoho_id) VALUES (?, ?, ?, ?)').run(c.id, 'caterer', c.unlocked === undefined ? 1 : c.unlocked, c.zoho || null);
      db.prepare('UPDATE candidates SET created_at = ? WHERE caterer_id = ?').run('created' in c ? c.created : null, c.id);
    }
    for (const r of (rows || {}).rejections || []) db.prepare('INSERT INTO candidate_rejections (caterer_id, job_title, rejected_at, origin) VALUES (?, ?, ?, ?)').run(r[0], r[1], '2026-09-01', r[2]);
  } finally { db.close(); }
  return home;
}

const ENV = (extra) => Object.assign({ NODE_PATH: NM, CV_SCREEN: 'shadow' }, extra || {});
const rowsOf = (home, id) => { const db = new Database(path.join(home, 'candidates.db'), { readonly: true }); try { return db.prepare('SELECT job_title AS title, origin FROM candidate_rejections WHERE caterer_id = ? ORDER BY id').all(id); } finally { db.close(); } };
const stateOf = (home) => { try { return JSON.parse(fs.readFileSync(path.join(home, 'runtime', 'cv-resurface.json'), 'utf8')); } catch (e) { return null; } };
const alertsOf = (home) => { try { return fs.readFileSync(path.join(home, 'outbox', 'alerts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };
const unlocksOf = (r) => r.calls.filter((c) => c.tool === 'caterer-unlock');
const batchesOf = (r) => r.calls.filter((c) => c.tool === 'ai-review' && c.mode === 'batch');
const rerun = (home, env, args) => { for (const f of fs.readdirSync(path.join(home, 'runs'))) fs.rmSync(path.join(home, 'runs', f), { force: true }); return h.runPhase1(home, args || h.baseArgs(), { env }); };
const claimRow = { title: 'Chef', origin: 'resurface:started' };
const legacy = { cands: [{ id: 501, created: null }] };

test('PC1 a legacy person (unlocked, never pushed, no record, old) is screened for this title, claimed BEFORE the unlock, unlocked again, queued as a legacy look with its measured charge; CV_SCREEN shadow, off or on', { skip }, async (t) => {
  for (const mode of ['shadow', 'off', 'on']) {
    const home = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } } }, legacy);
    const r = await h.runPhase1(home, h.baseArgs(), { env: ENV({ CV_SCREEN: mode }) });
    assert.strictEqual(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes('ROLE SCOPE: unlocked earlier, the role is not recorded and nothing was ever pushed - screened for this role'), mode);
    assert.strictEqual(batchesOf(r).length, 1, 'the snippet screening decides for this role as usual');
    const u = unlocksOf(r);
    assert.strictEqual(u.length, 1, 'the further unlock the owner accepted');
    assert.deepStrictEqual(u[0].rowsAtCall, [claimRow], 'the claim for this role is in the database at the moment of the unlock');
    const qd = h.queueOf(home);
    assert.deepStrictEqual([qd.candidates[0].resurfaced, qd.candidates[0].legacy, qd.candidates[0].resurfaceCharge, qd.candidates[0].resurfaceCredits], [true, true, 'charged', 1]);
    assert.deepStrictEqual(qd.phase1Stats.resurfaced.legacy, { screened: 1, rejectedAtSnippet: 0, rejectedAfterUnlock: 0, candidates: 1, charged: 1, credits: 1 });
    assert.deepStrictEqual(rowsOf(home, 501), [claimRow], 'the role is recorded');
    const s = stateOf(home).today;
    assert.deepStrictEqual([s.started, s.caterer, s.charged, s.credits, s.legacyCaterer, s.legacyCharged, s.legacyCredits, s.legacyRejected], [1, 1, 1, 1, 1, 1, 1, 0], mode);
  }
});

test('PC2 a legacy person the snippet screening rejects: no unlock, no charge, the rejection is recorded for this title (resurface:snippet), counted; never screened for it again, screened for another title', { skip }, async (t) => {
  const home = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } }, ai: { batch: [{ outcome: 'ok', overrides: { 501: { approved: false, reason: 'Too senior' } } }] } }, legacy);
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.strictEqual(unlocksOf(r).length, 0);
  assert.deepStrictEqual(rowsOf(home, 501), [{ title: 'Chef', origin: 'resurface:snippet' }]);
  const s = stateOf(home).today;
  assert.deepStrictEqual([s.started, s.legacyCaterer, s.legacyRejected, s.charged], [0, 1, 1, 0]);
  const qd = h.queueOf(home);
  assert.deepStrictEqual(qd.phase1Stats.resurfaced.legacy, { screened: 1, rejectedAtSnippet: 1, rejectedAfterUnlock: 0, candidates: 0, charged: 0, credits: 0 });
  const again = await rerun(home, ENV());
  assert.strictEqual(batchesOf(again).length, 1, 'the second run never screened it again for this title (the first run\'s call is all there is)');
  assert.ok(again.stdout.includes('SKIP (in DB)'));
  // another title: eligible again, screened again (the fake approves it now)
  const sc = JSON.parse(fs.readFileSync(path.join(home, 'scenario.json'), 'utf8'));
  delete sc.ai;
  fs.writeFileSync(path.join(home, 'scenario.json'), JSON.stringify(sc));
  const other = await rerun(home, ENV(), h.baseArgs().map((a) => (a === 'Chef' ? 'Kitchen Porter' : a)));
  assert.ok(other.stdout.includes('ROLE SCOPE'), other.stdout);
  assert.strictEqual(unlocksOf(other).length, 1);
  assert.deepStrictEqual(rowsOf(home, 501).map((x) => x.title), ['Chef', 'Kitchen Porter']);
});

test('PC3 a legacy person approved by the snippet screening and rejected by the review right after the unlock: the claim stays (it was charged), counted as a look rejected again, nothing queued', { skip }, async (t) => {
  const home = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } }, ai: { single: [{ outcome: 'ok', approved: false, reason: 'Too junior' }] } }, legacy);
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('REJECTED post-unlock AI'));
  assert.deepStrictEqual(rowsOf(home, 501), [claimRow], 'with CV_SCREEN shadow nothing else is written; the claim is the record of the role');
  const s = stateOf(home).today;
  assert.deepStrictEqual([s.charged, s.legacyCaterer, s.legacyRejected, s.legacyCharged, s.legacyCredits], [1, 1, 1, 1, 1]);
  const qd = h.queueOf(home);
  assert.strictEqual(qd.candidates.length, 0);
  assert.deepStrictEqual(qd.phase1Stats.resurfaced.legacy, { screened: 1, rejectedAtSnippet: 0, rejectedAfterUnlock: 1, candidates: 0, charged: 1, credits: 1 });
  const again = await rerun(home, ENV());
  assert.strictEqual(unlocksOf(again).length, 1, 'no second unlock for this role');
});

test('PC4 R-C6 the young (younger than the minimum age, with or without a rejection of another title), the pushed, one in flight (a candidate file), and a normal new card: skipped as before or unaffected; an old one with a plain rejection of ANOTHER title is screened for this one', { skip }, async (t) => {
  const home = homeOf(t, { pages: { 1: { cards: [prev(601), prev(602), prev(603), prev(604), prev(605), card(606), prev(607)] }, 2: { cards: [] } } }, {
    cands: [{ id: 601, created: ago(3) }, { id: 602, created: null, zoho: 'ZOHO-602' }, { id: 603, created: null }, { id: 604, created: null }, { id: 605, created: ago(40) }, { id: 607, created: ago(3) }],
    rejections: [[604, 'Head Chef', 'pipeline'], [607, 'Head Chef', 'pipeline']],
  });
  fs.mkdirSync(path.join(home, 'downloads'), { recursive: true });
  fs.writeFileSync(path.join(home, 'downloads', 'candidate-603.json'), '{}');
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.deepStrictEqual(unlocksOf(r).map((c) => c.id).sort(), ['604', '605', '606'], 'the old ones (604 with a rejection of another title, 605 with no record) and the new card (606)');
  assert.ok(r.stdout.includes('DB skips: 4'));
  const qd = h.queueOf(home);
  assert.deepStrictEqual(qd.candidates.map((c) => [c.id, c.legacy === true]).sort(), [['604', true], ['605', true], ['606', false]]);
  assert.ok(!('resurfaced' in qd.candidates.find((c) => c.id === '606')), 'a new card carries no flag');
  assert.deepStrictEqual(rowsOf(home, 604), [{ title: 'Head Chef', origin: 'pipeline' }, claimRow], 'the rejection of another title stays; the look records this role');
  assert.deepStrictEqual(rowsOf(home, 607), [{ title: 'Head Chef', origin: 'pipeline' }], 'young: the old skip, nothing recorded');
  assert.deepStrictEqual(rowsOf(home, 601), []);
});

test('PC10 the owner line, whole Phase 1: a card whose CV was seen earlier, rejected on the keyword search for one title, is screened for another title once it is old, never twice for either', { skip }, async (t) => {
  // run 1 (title Chef): a card of a person unlocked earlier ("unlocked previously") is rejected at the snippet stage: unlocked, rejected for Chef
  const home = homeOf(t, { pages: { 1: { cards: [prev(701)] }, 2: { cards: [] } }, ai: { batch: [{ outcome: 'ok', overrides: { 701: { approved: false, reason: 'Too senior' } } }] } }, { cands: [] });
  const r1 = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.strictEqual(r1.code, 0, r1.stdout + r1.stderr);
  assert.strictEqual(unlocksOf(r1).length, 0);
  assert.deepStrictEqual(rowsOf(home, 701), [{ title: 'Chef', origin: 'pipeline' }]);
  const sc = JSON.parse(fs.readFileSync(path.join(home, 'scenario.json'), 'utf8'));
  delete sc.ai;
  fs.writeFileSync(path.join(home, 'scenario.json'), JSON.stringify(sc));
  const other = h.baseArgs().map((a) => (a === 'Chef' ? 'Kitchen Porter' : a));
  // another title straight away: young, the stranded recovery's window: the old skip
  const r2 = await rerun(home, ENV(), other);
  assert.strictEqual(unlocksOf(r2).length, 0);
  assert.ok(r2.stdout.includes('SKIP (in DB)'));
  // once the person is old, the same card is screened for the other title (a further unlock is accepted), the role is recorded
  const db = new Database(path.join(home, 'candidates.db'));
  try { db.prepare('UPDATE candidates SET created_at = ? WHERE caterer_id = ?').run(ago(40), 701); } finally { db.close(); }
  const r3 = await rerun(home, ENV(), other);
  assert.ok(r3.stdout.includes('ROLE SCOPE'), r3.stdout);
  assert.strictEqual(unlocksOf(r3).length, 1);
  assert.deepStrictEqual(rowsOf(home, 701).map((x) => x.title), ['Chef', 'Kitchen Porter']);
  // neither title again
  for (const args of [other, h.baseArgs()]) {
    const again = await rerun(home, ENV(), args);
    assert.strictEqual(unlocksOf(again).length, 1, 'the calls of the fake accumulate over the runs: still the one unlock of r3');
    assert.ok(again.stdout.includes('SKIP (in DB)'));
  }
});

test('PC5 the switch: ROLE_SCOPE_LEGACY off (or a typo) skips exactly as before: no screening, no claim, no key anywhere; a typo says so once; the CV rule is not touched', { skip }, async (t) => {
  for (const v of ['off', 'false', 'nope']) {
    const home = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } } }, legacy);
    const r = await h.runPhase1(home, h.baseArgs(), { env: ENV({ ROLE_SCOPE_LEGACY: v }) });
    assert.strictEqual(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes('    SKIP (in DB)'), v);
    assert.ok(!r.stdout.includes('ROLE SCOPE') && !r.stdout.includes('RESURFACE'), v);
    assert.strictEqual(batchesOf(r).length, 0);
    assert.strictEqual(unlocksOf(r).length, 0);
    assert.deepStrictEqual(rowsOf(home, 501), []);
    assert.ok(!('resurfaced' in h.queueOf(home).phase1Stats));
    assert.strictEqual(stateOf(home), null);
    if (v === 'nope') {
      assert.ok(r.stdout.includes("WARN ROLE_SCOPE_LEGACY='nope' is neither on nor off: treated as off"));
      assert.strictEqual(r.stdout.split('WARN ROLE_SCOPE_LEGACY').length, 2, 'once per run');
    }
  }
});

test('PC6 the daily cap and the credit reserve bound the Caterer looks: the next person stays skipped (nothing recorded), one warning, the reserve is checked before the screening', { skip }, async (t) => {
  const home = homeOf(t, { pages: { 1: { cards: [prev(501), prev(502), prev(503)] }, 2: { cards: [] } } }, { cands: [{ id: 501, created: null }, { id: 502, created: null }, { id: 503, created: null }] });
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV({ CV_RESURFACE_MAX_PER_DAY: '2' }) });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.deepStrictEqual(unlocksOf(r).map((c) => c.id), ['501', '502']);
  assert.deepStrictEqual(rowsOf(home, 503), []);
  assert.strictEqual(h.queueOf(home).phase1Stats.resurfaced.capped, 1);
  assert.strictEqual(alertsOf(home).filter((x) => x.key === 'cv-resurface-cap-reached').length, 1);
  const home2 = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } }, creditsStart: 900 }, legacy);
  const r2 = await h.runPhase1(home2, h.baseArgs(), { env: ENV() });
  assert.strictEqual(unlocksOf(r2).length, 0);
  assert.strictEqual(batchesOf(r2).length, 0, 'held back BEFORE the screening: no Jev call for people who cannot be unlocked');
  assert.deepStrictEqual(rowsOf(home2, 501), []);
  assert.strictEqual(h.queueOf(home2).phase1Stats.resurfaced.belowReserve, 1);
});

test('PC7 an unlock that failed and spent nothing gives the claim back (not tried again today, no look counted); one that spent keeps it: a possible charge is never taken back', { skip }, async (t) => {
  const home = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } }, unlock: { 501: { success: false, error: 'HTTP 403' } } }, legacy);
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('RESURFACE claim taken back'));
  assert.deepStrictEqual(rowsOf(home, 501), []);
  const s = stateOf(home).today;
  assert.deepStrictEqual([s.started, s.legacyCaterer, s.legacyCharged], [0, 0, 0]);
  assert.deepStrictEqual(s.failed, ['caterer:501:Chef']);
  const home2 = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } }, unlock: { 501: { success: false, error: 'HTTP 500' } }, charge: { default: { first: 1, repeat: 1 }, failCharges: true } }, legacy);
  const r2 = await h.runPhase1(home2, h.baseArgs(), { env: ENV() });
  assert.deepStrictEqual(rowsOf(home2, 501), [claimRow]);
  assert.deepStrictEqual([stateOf(home2).today.legacyCaterer, stateOf(home2).today.legacyCharged], [1, 1]);
  assert.strictEqual(r2.code, 0);
});

test('PC8 a person the CV rule already has (CV_SCREEN on, a CV rejection of another role) is a resurfaced look, NOT a legacy one: one list, one claim, no legacy key', { skip }, async (t) => {
  const home = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } } }, { cands: [{ id: 501, created: null }], rejections: [[501, 'Head Chef', 'cv:under_qualified']] });
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV({ CV_SCREEN: 'on' }) });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('RESURFACE: unlocked earlier and rejected for another role - screened again for this role'));
  assert.ok(!r.stdout.includes('ROLE SCOPE'));
  const qd = h.queueOf(home);
  assert.ok(!('legacy' in qd.candidates[0]) && !('legacy' in qd.phase1Stats.resurfaced));
  const s = stateOf(home).today;
  assert.deepStrictEqual([s.started, s.legacyCaterer, s.legacyCharged], [1, 0, 0]);
  assert.deepStrictEqual(rowsOf(home, 501).map((x) => x.origin), ['cv:under_qualified', 'resurface:started'], 'exactly one claim row');
});

test('PC9 the fallback per-card check (the batch query failed) never lets a legacy person through: an unlocked card is skipped as before', { skip }, async (t) => {
  const home = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } } }, legacy);
  const src = fs.readFileSync(path.join(home, 'candidates-db.js'), 'utf8');
  fs.writeFileSync(path.join(home, 'candidates-db.js'), src.replace("case 'check-batch-scoped': {", "case 'check-batch-scoped': { console.error('forced batch failure'); process.exit(1);"));
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.ok(r.stdout.includes('using per-card check'));
  assert.ok(r.stdout.includes('    SKIP (in DB)'));
  assert.strictEqual(unlocksOf(r).length, 0);
});
