'use strict';
// Phase 2 and the role-scoped second look (docs/RESURFACE.md): process-approved-queue.js on a queue that carries resurfaced candidates, a real SQLite
// file in the legacy schema, a fake Zoho and an injected CV reviewer. A candidate that was unlocked and CV-rejected for another role (Caterer, charged and
// measured in Phase 1; Reed, claimed and measured here) is screened for this role: pushed once, or rejected again for it (the claim row becomes the CV
// rejection), never twice, with the accounting in the results, the counters and the database.
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
  for (const k of ['CV_RESURFACE', 'CV_RESURFACE_MAX_PER_DAY', 'CV_RESURFACE_MIN_CREDITS']) delete process.env[k];
  process.env.CV_SCREEN = 'on';
  fs.rmSync(path.join(ws.home, 'runtime'), { recursive: true, force: true });
});
test.after(() => { delete process.env.CV_SCREEN; });

const JOB = 'Chef'; // the job title of the fake queue
const OLD = 'Head Chef';
const state = () => { try { return JSON.parse(fs.readFileSync(path.join(ws.home, 'runtime', 'cv-resurface.json'), 'utf8')); } catch (e) { return null; } };
const rowsOf = (id, source) => { const db = new Database(ws.db, { readonly: true }); try { return db.prepare(`SELECT job_title AS title, origin FROM candidate_rejections WHERE ${source === 'reed' ? 'reed_id' : 'caterer_id'} = ? ORDER BY id`).all(Number(id)); } finally { db.close(); } };
const claimed = (ids, source, title) => () => {
  const db = new Database(ws.db);
  try {
    for (const id of ids) {
      const col = source === 'reed' ? 'reed_id' : 'caterer_id';
      db.prepare(`INSERT INTO candidate_rejections (${col}, job_title, rejected_at, origin) VALUES (?, ?, '2026-09-01', 'cv:under_qualified')`).run(Number(id), OLD);
      if (title) db.prepare(`INSERT INTO candidate_rejections (${col}, job_title, rejected_at, origin) VALUES (?, ?, '2026-09-29', 'resurface:started')`).run(Number(id), title);
    }
  } finally { db.close(); }
};
const caterer = (id, over) => card(id, Object.assign({ resurfaced: true, resurfaceCharge: 'charged', resurfaceCredits: 1 }, over || {}));
const reed = (id, over) => ({ id: String(id), source: 'reed', name: `Test Reed${id}`, firstName: 'Test', queryId: 'q-1', keywords: JOB, resurfaced: true, ...(over || {}) });

test('R2 C1 a resurfaced Caterer candidate the CV stage passes for this role is pushed ONCE with its CV; the claim row becomes resurface:pushed; the results say what it cost', async () => {
  const { res, results, out, built } = await execute({
    ids: ['8301', '8302'], cands: [caterer(8301), card(8302)], scenario: {}, before: claimed(['8301'], 'caterer', JOB),
  });
  assert.equal(res.code, 0);
  assert.equal(built.calls.create, 2, 'exactly one create call per candidate');
  assert.equal(rowOf(results, 8301).status, 'new');
  assert.equal(rowOf(results, 8301).resurfaced, true);
  assert.equal(rowOf(results, 8301).charge, 'charged');
  assert.equal(rowOf(results, 8301).credits, 1);
  assert.ok(!('resurfaced' in rowOf(results, 8302)), 'a normal candidate carries no flag');
  assert.deepEqual(results.resurfaced, { candidates: 1, caterer: 1, reed: 0, charged: 1, notCharged: 0, chargedUnknown: 0, credits: 1, chargedNotQueued: 0, rejectedAfterUnlock: 0, failedNotCharged: 0, reedViews: 0, pushed: 1, cvRejected: 0, held: 0, earlierAttempt: 0, capped: 0, belowReserve: 0, balanceUnreadable: 0 });
  assert.equal(results.catererStats.resurfaced.candidates, 1);
  assert.ok(zohoIdOf(8301), 'the Zoho id is what excludes the candidate for ever');
  assert.deepEqual(rowsOf(8301), [{ title: OLD, origin: 'cv:under_qualified' }, { title: JOB, origin: 'resurface:pushed' }]);
  assert.equal(has('cv-8301.pdf'), false);
  assert.equal(has('candidate-8301.json'), false);
  assert.ok(out.some((l) => /Resurfaced \(unlocked earlier, rejected for another role, screened again for this one\): 1 candidate\(s\), charged 1, not charged 0/.test(l)));
  assert.equal(state().today.pushed, 1);
});

test('R2 C1 a resurfaced candidate rejected again for this role: not pushed, the claim row becomes the CV rejection for this role, the row of the earlier role stays, the CV and the JSON are deleted', async () => {
  const { results, built } = await execute({
    ids: ['8311'], cands: [caterer(8311, { resurfaceCharge: 'notCharged', resurfaceCredits: 0 })], scenario: { 8311: () => R.reject(['over_qualified']) }, before: claimed(['8311'], 'caterer', JOB),
  });
  assert.equal(built.calls.create, 0, 'nothing reaches Zoho');
  const row = rowOf(results, 8311);
  assert.equal(row.status, 'cv_rejected');
  assert.equal(row.resurfaced, true);
  assert.equal(row.charge, 'notCharged');
  assert.deepEqual(rowsOf(8311), [{ title: OLD, origin: 'cv:under_qualified' }, { title: JOB, origin: 'cv:over_qualified' }]);
  assert.equal(zohoIdOf(8311), null);
  assert.equal(has('cv-8311.pdf'), false);
  assert.equal(has('candidate-8311.json'), false);
  assert.equal(results.resurfaced.cvRejected, 1);
  assert.equal(results.resurfaced.notCharged, 1);
  assert.equal(state().today.rejected, 1);
  // and it is final for this role: the dedupe of the next search skips it, and so does the second look
  assert.deepEqual(cdb.classifyBatchScoped([8311], JOB).skip, [8311]);
  assert.deepEqual(cdb.classifyBatchScoped([8311], JOB).resurface, []);
  assert.deepEqual(cdb.classifyBatchScoped([8311], 'Sous Chef').resurface, [8311], 'but another role is free');
});

test('C3 no second Zoho record, ever: the queue run again (--force) and a candidate already in Zoho create nothing', async () => {
  const first = await execute({ ids: ['8321'], cands: [caterer(8321)], scenario: {}, before: claimed(['8321'], 'caterer', JOB) });
  assert.equal(first.built.calls.create, 1);
  const zid = zohoIdOf(8321);
  const again = await execute({ ids: ['8321'], cands: [caterer(8321)], scenario: {}, keepState: true, force: true });
  assert.equal(again.built.calls.create, 0, 'the database already holds the Zoho id: skipped before the push');
  assert.equal(zohoIdOf(8321), zid);
  assert.equal(state().today.pushed, 1, 'a re-run is not counted again');
  assert.equal(rowOf(ws.readJson(again.res.resultsPath), 8321).status, 'skipped');
});

test('C3 a crash between the Zoho write and the database write: the results file records the push, so the candidate is not resurfaced again, and a re-run creates no second record', async () => {
  const first = await execute({ ids: ['8331'], cands: [caterer(8331)], scenario: {}, before: claimed(['8331'], 'caterer', JOB), hooks: { setZohoIdThrows: true } });
  assert.equal(first.built.calls.create, 1);
  assert.equal(zohoIdOf(8331), null, 'the database write failed after Zoho created the record');
  // another role, the same candidate: unlocked, never pushed according to the database, rejection rows exist: only the record of the push holds it back
  cdb.closeDb();
  assert.deepEqual(cdb.classifyBatchScoped([8331], 'Sous Chef').resurface, [], 'the push is recorded in the results file of the queue');
  P.state.zoho.scenario('8331', { create: 'duplicate' }); // what the real Zoho answers for a record that exists
  const second = await execute({ ids: ['8331'], cands: [caterer(8331)], scenario: {}, keepState: true, force: true });
  assert.equal(second.res.code, 0);
  assert.equal(second.built.calls.create, 1, 'the push is tried again (the database has no Zoho id) and Zoho answers DUPLICATE_DATA: no second record');
  assert.equal(rowOf(ws.readJson(second.res.resultsPath), 8331).status, 'duplicate');
});

test('C7 a resurfaced Reed candidate: claimed BEFORE the download, downloaded alone after the others, the profile views around it measured (a charging fake)', async () => {
  const usage = { profile_views: 10, daily_limit: 300 };
  const order = [];
  let inflight = 0;
  let maxInflight = 0;
  let soloAt = null;
  const { results, res } = await execute({
    ids: [], setupOpts: { reedIds: [9301, 9302, 9303] }, cands: [reed(9301), reed(9302, { resurfaced: false }), reed(9303, { resurfaced: false })], scenario: {},
    before: claimed(['9301'], 'reed', null),
    hooks: {
      reedDownload: async (o) => {
        inflight++; maxInflight = Math.max(maxInflight, inflight);
        if (String(o.candidateId) === '9301') {
          soloAt = inflight;
          order.push(['9301', rowsOf(9301, 'reed').map((r) => r.origin)]);
          usage.profile_views++;
        } else order.push([String(o.candidateId)]);
        await new Promise((r) => setTimeout(r, 15));
        inflight--;
        const cvPath = path.join(o.outputDir, `cv-reed-${o.candidateId}.pdf`);
        fs.writeFileSync(cvPath, Buffer.alloc(300, 0x25));
        return { cvPath, profileData: { firstName: 'Test', lastName: `Reed${o.candidateId}` } };
      },
    },
    tweak: (deps) => { deps.reedUsage = () => ({ date: '2026-10-01', profile_views: usage.profile_views, daily_limit: usage.daily_limit }); },
  });
  assert.equal(res.code, 0);
  assert.deepEqual(order.map((x) => x[0]).slice(-1), ['9301'], 'the resurfaced one is downloaded last, after the others');
  assert.deepEqual(order.find((x) => x[0] === '9301')[1], ['cv:under_qualified', 'resurface:started'], 'its claim row was in the database when the download started');
  assert.equal(soloAt, 1, 'nothing else was downloading while the resurfaced one was (the change of the views is attributable)');
  assert.equal(maxInflight <= 2, true);
  const row = rowOf(results, 9301);
  assert.deepEqual([row.status, row.resurfaced, row.charge, row.views], ['new', true, 'charged', 1]);
  assert.deepEqual([results.resurfaced.reed, results.resurfaced.charged, results.resurfaced.reedViews, results.resurfaced.pushed], [1, 1, 1, 1]);
  assert.equal(results.reedStats.resurfaced.reedViews, 1);
  const s = state().today;
  assert.deepEqual([s.started, s.reed, s.charged, s.reedViews, s.pushed], [1, 1, 1, 1, 1]);
  assert.deepEqual(rowsOf(9301, 'reed').map((r) => r.origin), ['cv:under_qualified', 'resurface:pushed']);
});

test('C7 a Reed profile view that is not charged for the second look is counted as not charged; an unreadable usage table at the start holds the candidate back', async () => {
  const usage = { profile_views: 50, daily_limit: 300 };
  const a = await execute({
    ids: [], setupOpts: { reedIds: [9311] }, cands: [reed(9311)], scenario: {}, before: claimed(['9311'], 'reed', null),
    tweak: (deps) => { deps.reedUsage = () => ({ date: '2026-10-01', profile_views: usage.profile_views, daily_limit: 300 }); },
  });
  assert.equal(rowOf(a.results, 9311).charge, 'notCharged');
  assert.equal(a.results.resurfaced.notCharged, 1);
  assert.equal(state().today.notCharged, 1);
  // unreadable before: held back, not downloaded, not pushed, nothing recorded against the candidate
  const downloads = [];
  const b = await execute({
    ids: [], setupOpts: { reedIds: [9312] }, cands: [reed(9312)], scenario: {}, before: claimed(['9312'], 'reed', null),
    hooks: { reedDownload: async (o) => { downloads.push(o.candidateId); return { cvPath: null, profileData: {} }; } },
    tweak: (deps) => { deps.reedUsage = () => { throw new Error('usage table unreadable'); }; },
  });
  assert.deepEqual(downloads, []);
  const row = rowOf(b.results, 9312);
  assert.deepEqual([row.status, row.held, row.resurfaced], ['skipped', 'unreadable', true]);
  assert.deepEqual(rowsOf(9312, 'reed').map((r) => r.origin), ['cv:under_qualified'], 'nothing recorded');
  assert.equal(b.built.calls.create, 0);
  assert.equal(b.results.resurfaced.held, 1);
  assert.equal(b.results.resurfaced.balanceUnreadable, 1);
});

test('C7 a Reed usage that is unreadable AFTER the download is counted as charged unknown; the claim stays', async () => {
  let calls = 0;
  const { results } = await execute({
    ids: [], setupOpts: { reedIds: [9321] }, cands: [reed(9321)], scenario: {}, before: claimed(['9321'], 'reed', null),
    tweak: (deps) => { deps.reedUsage = () => { calls++; if (calls > 1) throw new Error('gone'); return { date: '2026-10-01', profile_views: 5, daily_limit: 300 }; }; },
  });
  assert.equal(rowOf(results, 9321).charge, 'unknown');
  assert.equal(state().today.unknown, 1);
  assert.equal(rowsOf(9321, 'reed').pop().origin, 'resurface:pushed');
});

test('C8 the cap holds a resurfaced Reed candidate back at Phase 2 too: not downloaded, not recorded, one warning', async () => {
  process.env.CV_RESURFACE_MAX_PER_DAY = '1';
  const downloads = [];
  const { results } = await execute({
    ids: [], setupOpts: { reedIds: [9331, 9332] }, cands: [reed(9331), reed(9332)], scenario: {}, before: claimed(['9331', '9332'], 'reed', null),
    hooks: { reedDownload: async (o) => { downloads.push(String(o.candidateId)); const cvPath = path.join(o.outputDir, `cv-reed-${o.candidateId}.pdf`); fs.writeFileSync(cvPath, Buffer.alloc(300, 0x25)); return { cvPath, profileData: { firstName: 'T', lastName: `R${o.candidateId}` } }; } },
    tweak: (deps) => { deps.reedUsage = () => ({ date: '2026-10-01', profile_views: 1, daily_limit: 300 }); },
  });
  assert.deepEqual(downloads, ['9331']);
  assert.deepEqual([rowOf(results, 9332).status, rowOf(results, 9332).held], ['skipped', 'cap']);
  assert.deepEqual(rowsOf(9332, 'reed').map((r) => r.origin), ['cv:under_qualified']);
  assert.equal(results.resurfaced.capped, 1);
  assert.equal(P.ws.alerts().filter((a) => a.key === 'cv-resurface-cap-reached').length, 1);
  assert.equal(state().today.capped, 1);
});

test('C8 no Reed views left today: a resurfaced candidate is held back (counted as the reserve), a download that failed without spending takes its claim back', async () => {
  const none = await execute({
    ids: [], setupOpts: { reedIds: [9341] }, cands: [reed(9341)], scenario: {}, before: claimed(['9341'], 'reed', null),
    tweak: (deps) => { deps.reedUsage = () => ({ date: '2026-10-01', profile_views: 300, daily_limit: 300 }); },
  });
  assert.equal(rowOf(none.results, 9341).held, 'daily-limit');
  assert.equal(none.results.resurfaced.belowReserve, 1);
  const failing = await execute({
    ids: [], setupOpts: { reedIds: [9342] }, cands: [reed(9342)], scenario: {}, before: claimed(['9342'], 'reed', null),
    hooks: { reedDownload: async () => { throw new Error('HTTP 500'); } },
    tweak: (deps) => { deps.reedUsage = () => ({ date: '2026-10-01', profile_views: 10, daily_limit: 300 }); },
  });
  assert.deepEqual(rowsOf(9342, 'reed').map((r) => r.origin), ['cv:under_qualified'], 'the claim was taken back: nothing was spent');
  assert.equal(state().today.started, 0, 'and its slot with it');
  assert.deepEqual([rowOf(failing.results, 9342).status, rowOf(failing.results, 9342).held], ['skipped', 'download-failed'], 'a bare card is never pushed for a resurfaced candidate');
  assert.equal(failing.built.calls.create, 0);
});

test('C6 a resurfaced Reed candidate when the switch was turned off between the phases is held back, not downloaded; a Caterer one (already charged) goes on', async () => {
  process.env.CV_RESURFACE = 'off';
  const downloads = [];
  const a = await execute({
    ids: ['8351'], setupOpts: { reedIds: [9351] }, cands: [caterer(8351), reed(9351)], scenario: {}, before: () => { claimed(['8351'], 'caterer', JOB)(); claimed(['9351'], 'reed', null)(); },
    hooks: { reedDownload: async (o) => { downloads.push(o.candidateId); return { cvPath: null, profileData: {} }; } },
    tweak: (deps) => { deps.reedUsage = () => ({ date: '2026-10-01', profile_views: 1, daily_limit: 300 }); },
  });
  assert.deepEqual(downloads, []);
  assert.equal(rowOf(a.results, 9351).held, 'disabled');
  assert.equal(rowOf(a.results, 8351).status, 'new');
});

test('C5 a queue without a resurfaced candidate: no resurfaced key in the results, the rows, the territory stats or the counters', async () => {
  const { results } = await execute({ ids: ['8361', '8362'], scenario: { 8362: () => R.reject() } });
  assert.ok(!('resurfaced' in results));
  assert.ok(!results.candidates.some((c) => 'resurfaced' in c));
  assert.ok(!(results.catererStats && 'resurfaced' in results.catererStats));
  assert.equal(state(), null);
  assert.deepEqual(rowsOf(8362), [{ title: JOB, origin: 'cv:under_qualified' }]);
});

test('C5 CV_SCREEN shadow at Phase 2 (switched from on after Phase 1): a resurfaced Caterer candidate is pushed like everyone, its claim row becomes resurface:pushed', async () => {
  const { results, built } = await execute({ ids: ['8371'], cands: [caterer(8371)], scenario: { 8371: () => R.reject() }, mode: 'shadow', before: claimed(['8371'], 'caterer', JOB) });
  assert.equal(built.calls.create, 1);
  assert.equal(rowOf(results, 8371).status, 'new');
  assert.equal(rowsOf(8371).pop().origin, 'resurface:pushed');
});

test('R3 a counter file that cannot be written never stops Phase 2: the resurfaced candidate is still pushed once, the run ends normally, the results still say what it cost', async () => {
  // the counter file is a directory: reading it gives a new day, writing it fails
  const { res, results, built } = await execute({
    ids: ['8381'], cands: [caterer(8381)], scenario: {},
    before: () => { claimed(['8381'], 'caterer', JOB)(); fs.mkdirSync(path.join(ws.home, 'runtime', 'cv-resurface.json'), { recursive: true }); },
  });
  assert.equal(res.code, 0);
  assert.equal(built.calls.create, 1);
  assert.equal(rowOf(results, 8381).status, 'new');
  assert.equal(results.resurfaced.charged, 1);
  assert.equal(rowsOf(8381).pop().origin, 'resurface:pushed');
});

test('C11 a Reed download that failed AFTER a profile view was spent keeps its claim (a possible second charge for the same role is never taken back); one whose usage cannot be read afterwards keeps it too', async () => {
  let calls = 0;
  const spent = await execute({
    ids: [], setupOpts: { reedIds: [9351] }, cands: [reed(9351)], scenario: {}, before: claimed(['9351'], 'reed', null),
    hooks: { reedDownload: async () => { throw new Error('HTTP 500 after the profile call'); } },
    tweak: (deps) => { deps.reedUsage = () => ({ date: '2026-10-01', profile_views: 10 + (calls++ ? 1 : 0), daily_limit: 300 }); },
  });
  assert.deepEqual(rowsOf(9351, 'reed').map((r) => r.origin), ['cv:under_qualified', 'resurface:started'], 'the claim stays: it was charged');
  assert.equal(state().today.started, 1, 'and so does its slot');
  assert.equal(state().today.charged, 1);
  assert.equal(state().today.reedViews, 1);
  assert.deepEqual([rowOf(spent.results, 9351).status, rowOf(spent.results, 9351).held], ['skipped', 'download-failed']);
  assert.equal(spent.built.calls.create, 0, 'never pushed as a bare card');
  fs.rmSync(path.join(ws.home, 'runtime'), { recursive: true, force: true });
  let n = 0;
  const unknown = await execute({
    ids: [], setupOpts: { reedIds: [9352] }, cands: [reed(9352)], scenario: {}, before: claimed(['9352'], 'reed', null),
    hooks: { reedDownload: async () => { throw new Error('HTTP 500'); } },
    tweak: (deps) => { deps.reedUsage = () => { if (n++) throw new Error('gone'); return { date: '2026-10-01', profile_views: 10, daily_limit: 300 }; }; },
  });
  assert.deepEqual(rowsOf(9352, 'reed').map((r) => r.origin), ['cv:under_qualified', 'resurface:started'], 'the cost cannot be told: the claim stays');
  assert.equal(state().today.unknown, 1);
  assert.equal(rowOf(unknown.results, 9352).held, 'download-failed');
});

test('C11 K-RS4 a Reed candidate whose claim was written by a run that crashed before the download is held back by the next run (never charged twice for the role)', async () => {
  const downloads = [];
  const { results } = await execute({
    ids: [], setupOpts: { reedIds: [9361] }, cands: [reed(9361)], scenario: {}, before: claimed(['9361'], 'reed', JOB),
    hooks: { reedDownload: async (o) => { downloads.push(o.candidateId); return { cvPath: null, profileData: {} }; } },
    tweak: (deps) => { deps.reedUsage = () => ({ date: '2026-10-01', profile_views: 10, daily_limit: 300 }); },
  });
  assert.deepEqual(downloads, [], 'no second download, so no second view');
  assert.equal(rowOf(results, 9361).status, 'skipped');
  assert.equal(rowOf(results, 9361).held, 'not-eligible');
  assert.deepEqual(rowsOf(9361, 'reed').map((r) => r.origin), ['cv:under_qualified', 'resurface:started'], 'the claim row is untouched');
});

test('C7 the Reed usage reader used by the second look is STRICT: an unreadable database is an error (unknown cost), not "no views today"', async () => {
  const { execFileSync } = require('child_process');
  const home = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rsv-strict-'));
  try {
    fs.mkdirSync(path.join(home, 'candidates.db')); // a directory where the database should be: cannot be opened
    const script = path.resolve(__dirname, '..', '..', 'resourcer', 'scripts', 'reed-download.js');
    const code = "const m = require(" + JSON.stringify(script) + ");" +
      "let strict = 'no error'; try { m.getTodayUsageFromDb({ strict: true }); } catch (e) { strict = 'threw'; }" +
      "const loose = m.getTodayUsageFromDb(); console.log(JSON.stringify({ strict, loose: loose.profile_views }));";
    const out = execFileSync(process.execPath, ['-e', code], { env: Object.assign({}, process.env, { RESOURCER_HOME: home, HERMES_HOME: home }), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd: home });
    assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), { strict: 'threw', loose: 0 });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('C7 the results block holds EVERY charge: the re-opens Phase 1 counted that never reached the queue (rejected right after the unlock, failed after a charge) are added to the totals', async () => {
  const p1 = { resurfaced: { candidates: 1, charged: 1, notCharged: 0, chargedUnknown: 0, credits: 1, notQueued: { charged: 2, notCharged: 1, chargedUnknown: 1, credits: 2, rejectedAfterUnlock: 3 }, failedNotCharged: 4, capped: 0, belowReserve: 0, balanceUnreadable: 0 } };
  const { results } = await execute({
    ids: ['8391'], cands: [caterer(8391)], scenario: {}, before: claimed(['8391'], 'caterer', JOB), queueExtra: { phase1Stats: p1 },
  });
  const b = results.resurfaced;
  assert.equal(b.candidates, 1, 'the candidates of this queue');
  assert.equal(b.charged, 3, '1 queued + 2 not queued');
  assert.equal(b.chargedUnknown, 1);
  assert.equal(b.notCharged, 1);
  assert.equal(b.credits, 3, '1 queued + 2 not queued');
  assert.equal(b.chargedNotQueued, 3);
  assert.equal(b.rejectedAfterUnlock, 3);
  assert.equal(b.failedNotCharged, 4);
});
