'use strict';
// Phase 1 and the role-scoped second look (docs/RESURFACE.md), against the REAL candidates-db.js on a temp SQLite file (legacy schema) with the fake
// Caterer neighbours: a candidate unlocked earlier and CV-rejected for another role comes up again; the claim is written before the unlock, the
// cost is measured around it (a charging fake, a non-charging fake, an unreadable balance), the reserve and the daily cap hold, and with CV_SCREEN
// shadow or CV_RESURFACE=off nothing changes.
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

const X = 'Head Chef';
const prev = (id, over) => card(id, Object.assign({ unlockedPrev: true, neverUnlocked: false }, over || {}));

// a home with the real database CLI, the legacy schema and the rows the old runs left behind
function homeOf(t, scenario, rows) {
  const home = h.makeHome(Object.assign({ pages: { 1: { cards: [] }, 2: { cards: [] } }, creditsStart: 5000, probeDb: true }, scenario), { real: ['run-lock'], resurface: true });
  t.after(() => h.cleanup(home));
  fs.copyFileSync(path.join(h.SRC, 'candidates-db.js'), path.join(home, 'candidates-db.js'));
  createLegacyDb(path.join(home, 'candidates.db'), { rows: [] });
  const db = new Database(path.join(home, 'candidates.db'));
  try {
    for (const c of (rows || {}).cands || []) db.prepare('INSERT INTO candidates (caterer_id, source, unlocked, zoho_id) VALUES (?, ?, ?, ?)').run(c.id, 'caterer', c.unlocked === undefined ? 1 : c.unlocked, c.zoho || null);
    for (const r of (rows || {}).rejections || []) db.prepare('INSERT INTO candidate_rejections (caterer_id, job_title, rejected_at, origin) VALUES (?, ?, ?, ?)').run(r[0], r[1], '2026-09-01', r[2]);
  } finally { db.close(); }
  return home;
}

const ENV = (extra) => Object.assign({ NODE_PATH: NM, CV_SCREEN: 'on' }, extra || {});
const rowsOf = (home, id) => { const db = new Database(path.join(home, 'candidates.db'), { readonly: true }); try { return db.prepare('SELECT job_title AS title, origin FROM candidate_rejections WHERE caterer_id = ? ORDER BY id').all(id); } finally { db.close(); } };
const unlockedOf = (home, id) => { const db = new Database(path.join(home, 'candidates.db'), { readonly: true }); try { return (db.prepare('SELECT unlocked FROM candidates WHERE caterer_id = ?').get(id) || {}).unlocked; } finally { db.close(); } };
const stateOf = (home) => { try { return JSON.parse(fs.readFileSync(path.join(home, 'runtime', 'cv-resurface.json'), 'utf8')); } catch (e) { return null; } };
const alertsOf = (home) => { try { return fs.readFileSync(path.join(home, 'outbox', 'alerts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };
const unlocksOf = (r) => r.calls.filter((c) => c.tool === 'caterer-unlock');
// a second run in the same home: the status files of the first one are gone, as they are by the time the next search starts
const rerun = (home, env) => { for (const f of fs.readdirSync(path.join(home, 'runs'))) fs.rmSync(path.join(home, 'runs', f), { force: true }); return h.runPhase1(home, h.baseArgs(), { env }); };
const claimRow = { title: 'Chef', origin: 'resurface:started' };
const old = { cands: [{ id: 501 }], rejections: [[501, X, 'cv:under_qualified']] };

test('C1 R2 a candidate unlocked and CV-rejected for another role is screened again, claimed BEFORE the unlock, re-opened once, queued with the resurfaced flag and the measured charge', { skip }, async (t) => {
  const home = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } } }, old);
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('RESURFACE: unlocked earlier and rejected for another role - screened again for this role'));
  assert.strictEqual(r.calls.filter((c) => c.tool === 'ai-review' && c.mode === 'batch').length, 1, 'the snippet screening decides for this role as usual');
  const u = unlocksOf(r);
  assert.strictEqual(u.length, 1, 'one fetch of the contact details and the CV link');
  assert.deepStrictEqual(u[0].rowsAtCall, [{ title: X, origin: 'cv:under_qualified' }, claimRow], 'the claim row for the new role is in the database at the moment of the unlock');
  const q = h.queueOf(home);
  assert.strictEqual(q.candidates.length, 1);
  assert.strictEqual(q.candidates[0].resurfaced, true);
  assert.strictEqual(q.candidates[0].resurfaceCharge, 'charged');
  assert.strictEqual(q.candidates[0].resurfaceCredits, 1);
  assert.deepStrictEqual(q.phase1Stats.resurfaced, { candidates: 1, charged: 1, notCharged: 0, chargedUnknown: 0, credits: 1, notQueued: { charged: 0, notCharged: 0, chargedUnknown: 0, credits: 0, rejectedAfterUnlock: 0 }, failedNotCharged: 0, capped: 0, belowReserve: 0, balanceUnreadable: 0 });
  assert.strictEqual(unlockedOf(home, 501), 1, 'still unlocked, no second first unlock');
  assert.deepStrictEqual(rowsOf(home, 501), [{ title: X, origin: 'cv:under_qualified' }, claimRow], 'the row of the earlier role stays');
  const s = stateOf(home).today;
  assert.deepStrictEqual([s.started, s.caterer, s.charged, s.notCharged, s.unknown, s.credits], [1, 1, 1, 0, 0, 1]);
  assert.strictEqual(fs.statSync(path.join(home, 'runtime', 'cv-resurface.json')).mode & 0o777, 0o600);
  assert.ok(r.stdout.includes('RESURFACE re-opened: charged, 1 credit(s)'));
});

test('C7 a platform that does not charge for the second look: measured as not charged, no credit counted', { skip }, async (t) => {
  const home = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } }, charge: { default: { first: 1, repeat: 0 } } }, old);
  fs.writeFileSync(path.join(home, '_state', 'calls.jsonl'), JSON.stringify({ tool: 'caterer-unlock', id: '501', success: true }) + '\n'); // the first unlock, long ago
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  const q = h.queueOf(home);
  assert.strictEqual(q.candidates[0].resurfaceCharge, 'notCharged');
  assert.ok(!('resurfaceCredits' in q.candidates[0]));
  assert.deepStrictEqual([q.phase1Stats.resurfaced.charged, q.phase1Stats.resurfaced.notCharged, q.phase1Stats.resurfaced.credits], [0, 1, 0]);
  const s = stateOf(home).today;
  assert.deepStrictEqual([s.charged, s.notCharged, s.credits], [0, 1, 0]);
});

test('C7 R3 a balance that cannot be read before the unlock: the candidate stays skipped, nothing is recorded, no unlock, counted', { skip }, async (t) => {
  const home = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } }, creditsFail: [2] }, old);
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.strictEqual(unlocksOf(r).length, 0);
  assert.ok(r.stdout.includes('could not be read'));
  assert.strictEqual(r.calls.filter((c) => c.tool === 'ai-review' && c.mode === 'batch').length, 0, 'not even screened: the reserve is checked before the screening');
  assert.deepStrictEqual(rowsOf(home, 501), [{ title: X, origin: 'cv:under_qualified' }]);
  assert.strictEqual(h.queueOf(home).candidates.length, 0);
  assert.strictEqual(h.queueOf(home).phase1Stats.resurfaced.balanceUnreadable, 1);
  assert.strictEqual(stateOf(home).today.unreadable, 1);
  assert.strictEqual(stateOf(home).today.started, 0);
});

test('C7 a balance that cannot be read AFTER the unlock: counted as charged unknown, and the claim stays', { skip }, async (t) => {
  const home = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } }, creditsFail: [3] }, old);
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.strictEqual(unlocksOf(r).length, 1);
  const q = h.queueOf(home);
  assert.strictEqual(q.candidates[0].resurfaceCharge, 'unknown');
  assert.strictEqual(q.phase1Stats.resurfaced.chargedUnknown, 1);
  assert.strictEqual(stateOf(home).today.unknown, 1);
  assert.ok(r.stdout.includes('charge unknown'));
  assert.deepStrictEqual(rowsOf(home, 501).pop(), claimRow);
});

test('C8 the balance reserve: below CV_RESURFACE_MIN_CREDITS nothing is re-opened, nothing is recorded, one warning a day', { skip }, async (t) => {
  const home = homeOf(t, { pages: { 1: { cards: [prev(501), prev(502)] }, 2: { cards: [] } }, creditsStart: 900 }, { cands: [{ id: 501 }, { id: 502 }], rejections: [[501, X, 'cv:under_qualified'], [502, X, 'cv:under_qualified']] });
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.strictEqual(unlocksOf(r).length, 0, 'the unlock path of a normal candidate is not touched, a resurfaced one is held');
  assert.strictEqual(r.calls.filter((c) => c.tool === 'ai-review' && c.mode === 'batch').length, 0, 'held back BEFORE the screening: no Jev call is spent on people who cannot be re-opened');
  assert.strictEqual(h.queueOf(home).phase1Stats.resurfaced.belowReserve, 2);
  assert.deepStrictEqual(rowsOf(home, 502), [{ title: X, origin: 'cv:under_qualified' }]);
  const a = alertsOf(home).filter((x) => x.key === 'cv-resurface-cap-reached');
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].severity, 'warn');
  assert.match(a[0].text, /CV_RESURFACE_MIN_CREDITS/);
  const s = stateOf(home).today;
  assert.deepStrictEqual([s.started, s.reserve], [0, 2]);
  // the reserve is a setting: lowered, the same cards are re-opened
  const again = await rerun(home, ENV({ CV_RESURFACE_MIN_CREDITS: '100' }));
  assert.strictEqual(unlocksOf(again).length, 2);
});

test('C8 the daily cap: the next candidate stays skipped (not rejected, nothing recorded), the warning is raised once, and the day after they are looked at again', { skip }, async (t) => {
  const home = homeOf(t, { pages: { 1: { cards: [prev(501), prev(502), prev(503)] }, 2: { cards: [] } } }, { cands: [{ id: 501 }, { id: 502 }, { id: 503 }], rejections: [[501, X, 'cv:a'], [502, X, 'cv:a'], [503, X, 'cv:a']] });
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV({ CV_RESURFACE_MAX_PER_DAY: '2' }) });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.deepStrictEqual(unlocksOf(r).map((c) => c.id), ['501', '502']);
  assert.ok(r.stdout.includes('DB skips: 1'), 'the held-back one is an ordinary skip');
  assert.deepStrictEqual(rowsOf(home, 503), [{ title: X, origin: 'cv:a' }]);
  assert.strictEqual(h.queueOf(home).phase1Stats.resurfaced.capped, 1);
  assert.strictEqual(alertsOf(home).filter((x) => x.key === 'cv-resurface-cap-reached').length, 1);
  // the same search again on the same day: still held back, no second warning
  const again = await rerun(home, ENV({ CV_RESURFACE_MAX_PER_DAY: '2' }));
  assert.strictEqual(unlocksOf(again).length, 2, 'no new unlock');
  assert.strictEqual(alertsOf(home).filter((x) => x.key === 'cv-resurface-cap-reached').length, 1);
  // a new London day (the counter file of yesterday)
  const st = stateOf(home);
  st.today.day = '2000-01-01';
  fs.writeFileSync(path.join(home, 'runtime', 'cv-resurface.json'), JSON.stringify(st));
  const next = await rerun(home, ENV({ CV_RESURFACE_MAX_PER_DAY: '2' }));
  assert.deepStrictEqual(unlocksOf(next).map((c) => c.id), ['501', '502', '503'], 'eligible again: the first two are claimed already, so only 503 is new');
});

test('C11 an unlock that failed and spent nothing gives the claim back; one that spent (or cannot be told) keeps it', { skip }, async (t) => {
  const failing = { 501: { success: false, error: 'HTTP 403' }, 502: { success: false, error: 'HTTP 500' } };
  const home = homeOf(t, { pages: { 1: { cards: [prev(501), prev(502)] }, 2: { cards: [] } }, unlock: failing, charge: { default: { first: 1, repeat: 1 }, byId: { 502: { first: 1, repeat: 1 } }, failCharges: false } },
    { cands: [{ id: 501 }, { id: 502 }], rejections: [[501, X, 'cv:a'], [502, X, 'cv:a']] });
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('RESURFACE claim taken back'));
  assert.deepStrictEqual(rowsOf(home, 501), [{ title: X, origin: 'cv:a' }], 'nothing was spent: the role is free again');
  assert.deepStrictEqual(rowsOf(home, 502), [{ title: X, origin: 'cv:a' }]);
  assert.strictEqual(stateOf(home).today.started, 0, 'the slots went back');
  assert.deepStrictEqual(stateOf(home).today.failed, ['caterer:501:Chef', 'caterer:502:Chef'], 'but they are not tried again today');
  // the failed unlock DID spend (the platform charged and then failed): the claim stays
  const home2 = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } }, unlock: { 501: { success: false, error: 'HTTP 500' } }, charge: { default: { first: 1, repeat: 1 }, failCharges: true } }, old);
  const r2 = await h.runPhase1(home2, h.baseArgs(), { env: ENV() });
  assert.deepStrictEqual(rowsOf(home2, 501).pop(), claimRow, 'a charge is never taken back');
  assert.strictEqual(r2.stdout.includes('claim taken back'), false);
  assert.strictEqual(h.queueOf(home2).phase1Stats.resurfaced.notQueued.charged, 1, 'the results block holds the charge although nothing was queued');
  assert.strictEqual(h.queueOf(home2).phase1Stats.resurfaced.notQueued.credits, 1);
  assert.strictEqual(stateOf(home2).today.charged, 1);
  assert.strictEqual(h.queueOf(home2).candidates.length, 0, 'nothing queued');
  assert.strictEqual(r2.code, 0);
});

test('C1 C4 a resurfaced candidate the snippet screening rejects for this role is recorded for this role like any rejection, and is not screened for it again', { skip }, async (t) => {
  const home = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } }, ai: { batch: [{ outcome: 'ok', overrides: { 501: { approved: false, reason: 'Too senior' } } }] } }, old);
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.strictEqual(unlocksOf(r).length, 0, 'rejected before the unlock: no charge');
  assert.deepStrictEqual(rowsOf(home, 501), [{ title: X, origin: 'cv:under_qualified' }, { title: 'Chef', origin: 'pipeline' }]);
  assert.strictEqual(stateOf(home), null, 'nothing was claimed, nothing counted');
  const again = await rerun(home, ENV());
  assert.strictEqual(again.calls.filter((c) => c.tool === 'ai-review').length, 1, 'the second run never screened it again');
  assert.ok(again.stdout.includes('SKIP (in DB)'));
});

test('R2 the post-unlock review can still reject a resurfaced candidate: the claim stays (it was charged), nothing is queued', { skip }, async (t) => {
  const home = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } }, ai: { single: [{ outcome: 'ok', approved: false, reason: 'Too junior' }] } }, old);
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('REJECTED post-unlock AI'));
  assert.deepStrictEqual(rowsOf(home, 501).pop(), claimRow);
  assert.strictEqual(stateOf(home).today.charged, 1);
  const rs = h.queueOf(home).phase1Stats.resurfaced;
  assert.strictEqual(h.queueOf(home).candidates.length, 0);
  assert.deepStrictEqual([rs.candidates, rs.notQueued.charged, rs.notQueued.credits, rs.notQueued.rejectedAfterUnlock], [0, 1, 1, 1], 'the charge of a person rejected right after the unlock is in the results block');
});

test('C5 C6 with CV_SCREEN shadow, off or unset, or CV_RESURFACE=off, the card is skipped exactly as before: no screening, no claim, no resurfaced key anywhere', { skip }, async (t) => {
  for (const env of [{ CV_SCREEN: 'shadow' }, { CV_SCREEN: 'off' }, { CV_SCREEN: '' }, { CV_RESURFACE: 'off' }, { CV_RESURFACE: 'false' }, { CV_RESURFACE_MAX_PER_DAY: '0' }]) {
    const home = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } } }, old);
    const r = await h.runPhase1(home, h.baseArgs(), { env: ENV(env) });
    assert.strictEqual(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes('    SKIP (in DB)'), JSON.stringify(env));
    assert.ok(!r.stdout.includes('RESURFACE'), JSON.stringify(env));
    assert.strictEqual(r.calls.filter((c) => c.tool === 'ai-review').length, 0);
    assert.strictEqual(unlocksOf(r).length, 0);
    assert.deepStrictEqual(rowsOf(home, 501), [{ title: X, origin: 'cv:under_qualified' }]);
    assert.ok(!('resurfaced' in (h.queueOf(home).phase1Stats)), 'the queue carries no resurfaced block');
    assert.strictEqual(stateOf(home), null, 'no counter file');
  }
});

test('C3 a pushed candidate, one with no record at all, and one rejected for THIS role are skipped; a candidate screened for the first time is unaffected and carries no flag', { skip }, async (t) => {
  const home = homeOf(t, { pages: { 1: { cards: [prev(601), prev(602), prev(603), card(604)] }, 2: { cards: [] } } },
    { cands: [{ id: 601, zoho: 'ZOHO-601' }, { id: 602 }, { id: 603 }], rejections: [[601, X, 'cv:a'], [603, 'Chef', 'cv:b'], [603, X, 'cv:a']] });
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('DB skips: 3'));
  assert.deepStrictEqual(unlocksOf(r).map((c) => c.id), ['604']);
  const q = h.queueOf(home);
  assert.deepStrictEqual(q.candidates.map((c) => c.id), ['604']);
  assert.ok(!('resurfaced' in q.candidates[0]) && !('resurfaced' in q.phase1Stats));
  assert.strictEqual(stateOf(home), null);
});

test('R2 the fallback per-card check (the batch query failed) never resurfaces: an unlocked card is skipped as before', { skip }, async (t) => {
  const home = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } } }, old);
  const src = fs.readFileSync(path.join(home, 'candidates-db.js'), 'utf8');
  fs.writeFileSync(path.join(home, 'candidates-db.js'), src.replace("case 'check-batch-scoped': {", "case 'check-batch-scoped': { console.error('forced batch failure'); process.exit(1);"));
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.ok(r.stdout.includes('using per-card check'));
  assert.ok(r.stdout.includes('    SKIP (in DB)'));
  assert.strictEqual(unlocksOf(r).length, 0);
});

test('C6 a CV_RESURFACE value that is neither on nor off is off, never on, and the run says so (one WARN line); a clear "true" is on', { skip }, async (t) => {
  const home = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } } }, old);
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV({ CV_RESURFACE: 'nope' }) });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes("WARN CV_RESURFACE='nope' is neither on nor off: treated as off"));
  assert.strictEqual(r.stdout.split('WARN CV_RESURFACE').length, 2, 'once per run');
  assert.ok(r.stdout.includes('    SKIP (in DB)'));
  assert.strictEqual(unlocksOf(r).length, 0);
  assert.strictEqual(stateOf(home), null);
  const home2 = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } } }, old);
  const r2 = await h.runPhase1(home2, h.baseArgs(), { env: ENV({ CV_RESURFACE: 'true' }) });
  assert.strictEqual(unlocksOf(r2).length, 1);
  assert.ok(!r2.stdout.includes('WARN CV_RESURFACE'));
});

test('C8 a balance reader that is broken costs ONE read, not one per candidate: the first failure holds every later resurfaced card of the run, and nobody is screened', { skip }, async (t) => {
  const ids = [501, 502, 503, 504, 505];
  const home = homeOf(t, { pages: { 1: { cards: ids.map((i) => prev(i)) }, 2: { cards: [prev(506)] } }, creditsStart: 5000, creditsFailFrom: 2 },
    { cands: ids.concat([506]).map((id) => ({ id })), rejections: ids.concat([506]).map((id) => [id, X, 'cv:a']) });
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.strictEqual(unlocksOf(r).length, 0);
  assert.strictEqual(r.calls.filter((c) => c.tool === 'ai-review' && c.mode === 'batch').length, 0, 'held back before the screening');
  const reads = r.calls.filter((c) => c.tool === 'caterer-get-credits').length;
  assert.ok(reads <= 3, `the start of the run, one failed read, the end of the run: ${reads} reads`);
  assert.deepStrictEqual(stateOf(home).today.started, 0);
  assert.strictEqual(h.queueOf(home).phase1Stats.resurfaced.balanceUnreadable, 6);
});

test('C8 the reserve boundary: a balance exactly equal to CV_RESURFACE_MIN_CREDITS is allowed, one below is held back', { skip }, async (t) => {
  const home = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } }, creditsStart: 1000 }, old);
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.strictEqual(unlocksOf(r).length, 1, 'balance 1000, reserve 1000: allowed');
  const home2 = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } }, creditsStart: 999 }, old);
  const r2 = await h.runPhase1(home2, h.baseArgs(), { env: ENV() });
  assert.strictEqual(unlocksOf(r2).length, 0, 'balance 999: held back');
});

test('C11 an unlock that failed and whose cost cannot be told (the balance cannot be read afterwards) keeps its claim: a possible charge is never taken back', { skip }, async (t) => {
  const home = homeOf(t, { pages: { 1: { cards: [prev(501)] }, 2: { cards: [] } }, unlock: { 501: { success: false, error: 'HTTP 500' } }, creditsStart: 5000, creditsFail: [3] }, old);
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.strictEqual(unlocksOf(r).length, 1);
  assert.deepStrictEqual(rowsOf(home, 501).pop(), claimRow, 'the claim stays');
  assert.strictEqual(stateOf(home).today.started, 1, 'and so does its slot');
  assert.strictEqual(stateOf(home).today.unknown, 1);
  assert.ok(!r.stdout.includes('claim taken back'));
  assert.strictEqual(stateOf(home).today.failed, undefined, 'not noted as a failure without a charge: it may have been charged');
  const again = await rerun(home, ENV());
  assert.strictEqual(unlocksOf(again).length, 1, 'the role is never charged again');
});

test('C2 a platform that refuses the second unlock: no run-stopping streak (the normal unlocks are not affected), every refused card is tried once a day, and not screened or tried again by the next run', { skip }, async (t) => {
  const ids = [501, 502, 503, 504, 505, 506, 507];
  const refuse = {};
  for (const i of ids) refuse[i] = { success: false, error: 'HTTP 403' };
  refuse[604] = undefined;
  const home = homeOf(t, { pages: { 1: { cards: ids.map((i) => prev(i)).concat([card(604)]) }, 2: { cards: [] } }, unlock: refuse, creditsStart: 5000 },
    { cands: ids.map((id) => ({ id })), rejections: ids.map((id) => [id, X, 'cv:a']) });
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  assert.ok(!r.stdout.includes('STOPPING Phase 1'), 'seven refusals in a row do not stop the run');
  assert.strictEqual(unlocksOf(r).length, 8);
  assert.strictEqual(unlocksOf(r)[0].id, '604', 'the normal card of the page is unlocked before the resurfaced ones');
  assert.strictEqual(stateOf(home).today.failed.length, 7);
  assert.strictEqual(stateOf(home).today.started, 0);
  const again = await rerun(home, ENV());
  assert.strictEqual(unlocksOf(again).length, 8, 'no new unlock of the refused cards (the 8 are the first run\'s)');
  assert.strictEqual(again.calls.filter((c) => c.tool === 'ai-review' && c.mode === 'batch').length, 1, 'only the first run screened them (and 604 is already in the DB)');
});

test('C4 C11 a NORMAL card rejected by the own review of Phase 1 after its unlock is recorded for that role while the second look is active (role-scoped like a CV rejection); with CV_SCREEN shadow or the switch off nothing is written, as before', { skip }, async (t) => {
  const reject = { ai: { single: [{ outcome: 'ok', approved: false, reason: 'Too junior' }] } };
  const home = homeOf(t, Object.assign({ pages: { 1: { cards: [card(604)] }, 2: { cards: [] } } }, reject), {});
  const r = await h.runPhase1(home, h.baseArgs(), { env: ENV() });
  assert.ok(r.stdout.includes('REJECTED post-unlock AI'));
  assert.deepStrictEqual(rowsOf(home, 604), [{ title: 'Chef', origin: 'resurface:postunlock' }]);
  assert.strictEqual(unlockedOf(home, 604), 1);
  for (const env of [{ CV_SCREEN: 'shadow' }, { CV_RESURFACE: 'off' }]) {
    const h2 = homeOf(t, Object.assign({ pages: { 1: { cards: [card(604)] }, 2: { cards: [] } } }, reject), {});
    const r2 = await h.runPhase1(h2, h.baseArgs(), { env: ENV(env) });
    assert.ok(r2.stdout.includes('REJECTED post-unlock AI'));
    assert.deepStrictEqual(rowsOf(h2, 604), [], `nothing written: ${JSON.stringify(env)}`);
  }
});
