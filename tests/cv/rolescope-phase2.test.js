'use strict';
// Phase 2 and the role scope for people whose role was never recorded (docs/ROLESCOPE.md R-C2, R-C3, R-C8): process-approved-queue.js on a queue that carries a
// legacy look (Caterer: claimed and measured in Phase 1; Reed: claimed here, right before the profile view, and measured around it), a real SQLite file in the
// legacy schema, a fake Zoho and an injected CV reviewer. Pushed once, or rejected again for this role (the claim row becomes the CV rejection), never twice.
const P = require('./helpers/phase2-run');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('../lifecycle/helpers/sqlite');
const { ws, R, has, rowOf, execute, zohoIdOf, card } = P;
const rs = require('../../resourcer/scripts/lib/resurface');
const cdb = require('../../resourcer/candidates-db');

test.before(P.start);
test.after(async () => { cdb.closeDb(); await P.stop(); });
test.beforeEach(() => {
  cdb.closeDb();
  for (const k of ['CV_RESURFACE', 'CV_RESURFACE_MAX_PER_DAY', 'CV_RESURFACE_MIN_CREDITS', 'ROLE_SCOPE_LEGACY', 'ROLE_SCOPE_MIN_AGE_DAYS']) delete process.env[k];
  process.env.CV_SCREEN = 'on';
  fs.rmSync(path.join(ws.home, 'runtime'), { recursive: true, force: true });
});
test.after(() => { delete process.env.CV_SCREEN; });

const JOB = 'Chef'; // the job title of the fake queue
const OLD = 'Head Chef';
const state = () => { try { return JSON.parse(fs.readFileSync(path.join(ws.home, 'runtime', 'cv-resurface.json'), 'utf8')); } catch (e) { return null; } };
const rowsOf = (id, source) => { const db = new Database(ws.db, { readonly: true }); try { return db.prepare(`SELECT job_title AS title, origin FROM candidate_rejections WHERE ${source === 'reed' ? 'reed_id' : 'caterer_id'} = ? ORDER BY id`).all(Number(id)); } finally { db.close(); } };
const rows = (ids, source, title, origin) => () => {
  const db = new Database(ws.db);
  try {
    for (const id of ids) db.prepare(`INSERT INTO candidate_rejections (${source === 'reed' ? 'reed_id' : 'caterer_id'}, job_title, rejected_at, origin) VALUES (?, ?, '2026-09-29', ?)`).run(Number(id), title, origin);
  } finally { db.close(); }
};
// the harness seeds Reed rows as unlocked; the real ones are seen-only (unlocked 0: Reed never sets it)
const seen = (ids) => () => { const db = new Database(ws.db); try { for (const id of ids) db.prepare('UPDATE candidates SET unlocked = 0 WHERE reed_id = ?').run(Number(id)); } finally { db.close(); } };
const both = (...fns) => (qf) => fns.forEach((f) => f(qf));
const caterer = (id, over) => card(id, Object.assign({ resurfaced: true, legacy: true, resurfaceCharge: 'charged', resurfaceCredits: 1 }, over || {}));
const reed = (id, over) => ({ id: String(id), source: 'reed', name: `Test Reed${id}`, firstName: 'Test', queryId: 'q-1', keywords: JOB, resurfaced: true, legacy: true, ...(over || {}) });
const usageOf = (usage) => (deps) => { deps.reedUsage = () => ({ date: '2026-10-01', profile_views: usage.profile_views, daily_limit: usage.daily_limit }); };
const download = (usage, order) => async (o) => {
  if (order) order.push([String(o.candidateId), rowsOf(o.candidateId, 'reed').map((r) => r.origin)]);
  usage.profile_views++;
  const cvPath = path.join(o.outputDir, `cv-reed-${o.candidateId}.pdf`);
  fs.writeFileSync(cvPath, Buffer.alloc(300, 0x25));
  return { cvPath, profileData: { firstName: 'Test', lastName: `Reed${o.candidateId}` } };
};

test('PS1 a Reed legacy look: claimed BEFORE the profile view (no slot of the cap), measured around it, pushed once; the claim row becomes resurface:pushed; the numbers of the role scope are in the results and the counters', async () => {
  const usage = { profile_views: 10, daily_limit: 300 };
  const order = [];
  const { res, results, built, out } = await execute({
    ids: [], setupOpts: { reedIds: [9401, 9402] }, cands: [reed(9401), reed(9402, { resurfaced: false, legacy: false })], scenario: {},
    hooks: { reedDownload: download(usage, order) }, tweak: usageOf(usage), before: seen([9401, 9402]),
    queueExtra: { phase1Stats: { reed: { pool: 30, resurfaced: { eligible: 3, candidates: 1, legacy: { screened: 3, rejectedAtSnippet: 2, candidates: 1 } } } } },
  });
  assert.equal(res.code, 0);
  assert.deepEqual(order.find((x) => x[0] === '9401')[1], ['resurface:started'], 'the claim row for this role was in the database when the download started');
  assert.equal(built.calls.create, 2);
  const row = rowOf(results, 9401);
  assert.deepEqual([row.status, row.resurfaced, row.legacy, row.charge, row.views], ['new', true, true, 'charged', 1]);
  assert.ok(!('legacy' in rowOf(results, 9402)), 'an ordinary approval carries no flag');
  assert.deepEqual(results.resurfaced.legacy, { screened: 3, rejectedAtSnippet: 2, rejectedAfterUnlock: 0, candidates: 1, caterer: 0, reed: 1, charged: 1, credits: 0, reedViews: 1, pushed: 1, cvRejected: 0, held: 0 });
  assert.deepEqual(rowsOf(9401, 'reed').map((r) => r.origin), ['resurface:pushed']);
  const s = state().today;
  assert.deepEqual([s.started, s.legacyReed, s.legacyCharged, s.legacyViews, s.legacyPushed, s.reedViews, s.pushed], [0, 1, 1, 1, 1, 1, 1], 'a Reed legacy look takes no slot');
  assert.ok(out.some((l) => /Role scope \(people whose role was never recorded, one more look for this role\): 3 screened, rejected at the snippet stage 2, queued 1 \(Caterer 0, Reed 1\), rejected after the unlock 0; charged 1, credits spent 0, Reed views spent 1; pushed 1, rejected by the CV stage 0, held back 0\./.test(l)), out.join('\n'));
  assert.equal(results.reedStats.resurfaced.reedViews, 1);
});

test('PS2 a Reed legacy look the CV stage rejects: not pushed, the claim row becomes the CV rejection for this role, counted as rejected again; the role is final, a new role is free', async () => {
  const usage = { profile_views: 10, daily_limit: 300 };
  const { results, built } = await execute({
    ids: [], setupOpts: { reedIds: [9411] }, cands: [reed(9411)], scenario: { 9411: () => R.reject(['over_qualified']) }, before: seen([9411]),
    hooks: { reedDownload: download(usage) }, tweak: usageOf(usage),
  });
  assert.equal(built.calls.create, 0);
  assert.equal(rowOf(results, 9411).status, 'cv_rejected');
  assert.deepEqual(rowsOf(9411, 'reed'), [{ title: JOB, origin: 'cv:over_qualified' }]);
  const s = state().today;
  assert.deepEqual([s.legacyReed, s.legacyRejected, s.legacyPushed, s.rejected], [1, 1, 0, 1]);
  assert.deepEqual(results.resurfaced.legacy.cvRejected, 1);
  cdb.closeDb();
  assert.deepEqual(cdb.resurfaceBatchReed([9411], JOB).judged, [9411], 'skipped for this role for ever');
  assert.deepEqual(cdb.resurfaceBatchReed([9411], 'Sous Chef').resurface, [9411], 'with the CV stage on a CV rejection is the CV rule: a new role is looked at again');
});

test('PS3 CV_SCREEN shadow at Phase 2 (the role scope is independent of it): the Reed legacy look is claimed, measured and pushed', async () => {
  process.env.CV_SCREEN = 'shadow';
  const usage = { profile_views: 10, daily_limit: 300 };
  const { results, built } = await execute({
    ids: [], setupOpts: { reedIds: [9421] }, cands: [reed(9421)], scenario: { 9421: () => R.reject() }, mode: 'shadow', before: seen([9421]),
    hooks: { reedDownload: download(usage) }, tweak: usageOf(usage),
  });
  assert.equal(built.calls.create, 1);
  assert.equal(rowOf(results, 9421).status, 'new');
  assert.deepEqual(rowsOf(9421, 'reed').map((r) => r.origin), ['resurface:pushed']);
});

test('PS4 the switch turned off between the phases: a Reed legacy look is held back (not downloaded, nothing recorded); the claimed Caterer look goes on (it was charged)', async () => {
  process.env.ROLE_SCOPE_LEGACY = 'off';
  const downloads = [];
  const a = await execute({
    ids: ['8451'], setupOpts: { reedIds: [9451] }, cands: [caterer(8451), reed(9451)], scenario: {}, before: both(seen([9451]), rows(['8451'], 'caterer', JOB, 'resurface:started')),
    hooks: { reedDownload: async (o) => { downloads.push(o.candidateId); return { cvPath: null, profileData: {} }; } }, tweak: usageOf({ profile_views: 1, daily_limit: 300 }),
  });
  assert.deepEqual(downloads, []);
  assert.equal(rowOf(a.results, 9451).held, 'disabled');
  assert.deepEqual(rowsOf(9451, 'reed'), []);
  assert.equal(rowOf(a.results, 8451).status, 'new');
});

test('PS5 a Reed download that failed without spending takes its claim back (no look counted); one that failed after a view was spent keeps it (counted, never taken back)', async () => {
  const none = { profile_views: 10, daily_limit: 300 };
  const a = await execute({ ids: [], setupOpts: { reedIds: [9461] }, cands: [reed(9461)], scenario: {}, before: seen([9461]), hooks: { reedDownload: async () => { throw new Error('HTTP 500'); } }, tweak: usageOf(none) });
  assert.deepEqual(rowsOf(9461, 'reed'), [], 'nothing was spent: the role is free again');
  assert.deepEqual([rowOf(a.results, 9461).status, rowOf(a.results, 9461).held], ['skipped', 'download-failed']);
  const t0 = state().today;
  assert.deepEqual([t0.started, t0.legacyReed, t0.charged, t0.legacyCharged], [0, 0, 0, 0], 'nothing was counted: no slot was taken, no look was given');
  assert.deepEqual(t0.failed, [`reed:9461:${JOB}`], 'noted as failed today (nothing spent): not screened again by every run of the day');
  let calls = 0;
  const spent = { profile_views: 10, daily_limit: 300 };
  const b = await execute({
    ids: [], setupOpts: { reedIds: [9462] }, cands: [reed(9462)], scenario: {}, before: seen([9462]), hooks: { reedDownload: async () => { throw new Error('HTTP 500 after the profile call'); } },
    tweak: (deps) => { deps.reedUsage = () => ({ date: '2026-10-01', profile_views: spent.profile_views + (calls++ ? 1 : 0), daily_limit: 300 }); },
  });
  assert.deepEqual(rowsOf(9462, 'reed').map((r) => r.origin), ['resurface:started'], 'the claim stays: it was charged');
  assert.deepEqual([state().today.legacyReed, state().today.legacyCharged, state().today.legacyViews], [1, 1, 1]);
  assert.equal(rowOf(b.results, 9462).held, 'download-failed');
});

test('PS6 a recovered queue, a retry: a Reed legacy look whose claim exists (a run that crashed after it) is held back by the next run and never charged twice for the role', async () => {
  const downloads = [];
  const { results } = await execute({
    ids: [], setupOpts: { reedIds: [9471] }, cands: [reed(9471)], scenario: {}, before: both(seen([9471]), rows(['9471'], 'reed', JOB, 'resurface:started')),
    hooks: { reedDownload: async (o) => { downloads.push(o.candidateId); return { cvPath: null, profileData: {} }; } }, tweak: usageOf({ profile_views: 10, daily_limit: 300 }),
  });
  assert.deepEqual(downloads, [], 'no second download, so no second view');
  assert.deepEqual([rowOf(results, 9471).status, rowOf(results, 9471).held], ['skipped', 'not-eligible']);
  assert.deepEqual(rowsOf(9471, 'reed').map((r) => r.origin), ['resurface:started']);
});

test('PS7 no Reed views left, or the usage unreadable: the Reed legacy look is held back and counted, nothing is recorded (the daily views bound the Reed looks)', async () => {
  const a = await execute({ ids: [], setupOpts: { reedIds: [9481] }, cands: [reed(9481)], scenario: {}, before: seen([9481]), tweak: usageOf({ profile_views: 300, daily_limit: 300 }) });
  assert.equal(rowOf(a.results, 9481).held, 'daily-limit');
  assert.equal(a.results.resurfaced.belowReserve, 1);
  assert.deepEqual(rowsOf(9481, 'reed'), []);
  const b = await execute({ ids: [], setupOpts: { reedIds: [9482] }, cands: [reed(9482)], scenario: {}, before: seen([9482]), tweak: (deps) => { deps.reedUsage = () => { throw new Error('gone'); }; } });
  assert.equal(rowOf(b.results, 9482).held, 'unreadable');
  assert.deepEqual(rowsOf(9482, 'reed'), []);
});

test('PS8 a Reed approval for this title (reed:approved) that the CV stage rejects: its row becomes the CV rejection, one row per person and title, so the CV rule and the re-run guard keep working', async () => {
  const usage = { profile_views: 10, daily_limit: 300 };
  const a = await execute({
    ids: [], setupOpts: { reedIds: [9491] }, cands: [reed(9491, { resurfaced: false, legacy: false })], scenario: { 9491: () => R.reject(['under_qualified']) },
    before: both(seen([9491]), rows(['9491'], 'reed', JOB, 'reed:approved')), hooks: { reedDownload: download(usage) }, tweak: usageOf(usage),
  });
  assert.equal(rowOf(a.results, 9491).status, 'cv_rejected');
  assert.deepEqual(rowsOf(9491, 'reed'), [{ title: JOB, origin: 'cv:under_qualified' }]);
  // and the earlier-rejection guard of a re-run finds it (the CV is not downloaded again)
  const downloads = [];
  const b = await execute({
    ids: [], setupOpts: { reedIds: [9491] }, keepState: true, force: true, cands: [reed(9491, { resurfaced: false, legacy: false })], scenario: {},
    hooks: { reedDownload: async (o) => { downloads.push(o.candidateId); return { cvPath: null, profileData: {} }; } }, tweak: usageOf(usage),
  });
  assert.deepEqual(downloads, []);
  assert.equal(rowOf(b.results, 9491).status, 'cv_rejected');
  // a Reed approval that the CV stage passes keeps its row (reed:approved is bookkeeping: the Zoho id is what excludes the person)
  const c = await execute({ ids: [], setupOpts: { reedIds: [9492] }, cands: [reed(9492, { resurfaced: false, legacy: false })], scenario: {}, before: both(seen([9492]), rows(['9492'], 'reed', JOB, 'reed:approved')), hooks: { reedDownload: download(usage) }, tweak: usageOf(usage) });
  assert.equal(rowOf(c.results, 9492).status, 'new');
  assert.deepEqual(rowsOf(9492, 'reed').map((r) => r.origin), ['reed:approved']);
});

test('PS9 a Caterer legacy look (claimed and measured in Phase 1): pushed once, the claim row becomes resurface:pushed, counted as a legacy look pushed; the results block adds the people Phase 1 screened and rejected', async () => {
  const p1 = { resurfaced: { candidates: 1, charged: 1, notCharged: 0, chargedUnknown: 0, credits: 1, notQueued: { charged: 1, notCharged: 0, chargedUnknown: 0, credits: 1, rejectedAfterUnlock: 1 }, failedNotCharged: 0, capped: 0, belowReserve: 0, balanceUnreadable: 0,
    legacy: { screened: 4, rejectedAtSnippet: 2, rejectedAfterUnlock: 1, candidates: 1, charged: 2, credits: 2 } } };
  const { res, results, built, out } = await execute({
    ids: ['8501', '8502'], cands: [caterer(8501), card(8502)], scenario: {}, before: rows(['8501'], 'caterer', JOB, 'resurface:started'), queueExtra: { phase1Stats: p1 },
  });
  assert.equal(res.code, 0);
  assert.equal(built.calls.create, 2);
  const row = rowOf(results, 8501);
  assert.deepEqual([row.status, row.resurfaced, row.legacy, row.charge, row.credits], ['new', true, true, 'charged', 1]);
  assert.ok(!('legacy' in rowOf(results, 8502)));
  assert.deepEqual(results.resurfaced.legacy, { screened: 4, rejectedAtSnippet: 2, rejectedAfterUnlock: 1, candidates: 1, caterer: 1, reed: 0, charged: 2, credits: 2, reedViews: 0, pushed: 1, cvRejected: 0, held: 0 });
  assert.deepEqual(rowsOf(8501), [{ title: JOB, origin: 'resurface:pushed' }]);
  const s = state().today;
  assert.deepEqual([s.legacyPushed, s.pushed, s.legacyRejected], [1, 1, 0]);
  assert.ok(out.some((l) => /Role scope \(people whose role was never recorded, one more look for this role\): 4 screened, rejected at the snippet stage 2, queued 1 \(Caterer 1, Reed 0\), rejected after the unlock 1; charged 2, credits spent 2/.test(l)));
  assert.ok(zohoIdOf(8501));
  assert.equal(results.catererStats.resurfaced.candidates, 1);
});

test('PS10 a Caterer legacy look the CV stage rejects: the claim row becomes the CV rejection for this role, counted as rejected again; no second Zoho record when the queue is run again', async () => {
  const { results, built } = await execute({
    ids: ['8511'], cands: [caterer(8511)], scenario: { 8511: () => R.reject(['over_qualified']) }, before: rows(['8511'], 'caterer', JOB, 'resurface:started'),
  });
  assert.equal(built.calls.create, 0);
  assert.equal(rowOf(results, 8511).status, 'cv_rejected');
  assert.deepEqual(rowsOf(8511), [{ title: JOB, origin: 'cv:over_qualified' }]);
  assert.deepEqual([state().today.legacyRejected, state().today.legacyPushed, results.resurfaced.legacy.cvRejected], [1, 0, 1]);
  const again = await execute({ ids: ['8511'], cands: [caterer(8511)], scenario: {}, keepState: true, force: true });
  assert.equal(again.built.calls.create, 0);
  assert.equal(state().today.legacyRejected, 1, 'a re-run is not counted again');
});

test('PS11 a queue without a legacy look carries no legacy key anywhere, and the numbers of an ordinary resurfaced look are unchanged', async () => {
  const { results } = await execute({
    ids: ['8521'], cands: [card(8521, { resurfaced: true, resurfaceCharge: 'charged', resurfaceCredits: 1 })], scenario: {}, before: rows(['8521'], 'caterer', JOB, 'resurface:started'),
  });
  assert.ok(!('legacy' in results.resurfaced), JSON.stringify(results.resurfaced));
  assert.ok(!results.candidates.some((c) => 'legacy' in c));
  const s = state().today;
  assert.deepEqual([s.legacyCaterer, s.legacyReed, s.legacyRejected, s.legacyPushed, s.legacyCharged], [0, 0, 0, 0, 0]);
  const plain = await execute({ ids: ['8522'], scenario: {} });
  assert.ok(!('resurfaced' in plain.results));
});
