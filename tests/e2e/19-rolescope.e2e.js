'use strict';
// SCENARIO 19 - the role scope (docs/ROLESCOPE.md): people whose role was never recorded, Caterer AND Reed, the whole pipeline, run the way Hermes runs it (cron
// wrapper, scrubbed environment, both sources, one merged queue and one Phase 2 per search). CV_SCREEN stays at the shipped default (shadow): the role scope does not
// depend on it. A charging fake Caterer (the unlock spends a credit), the fake Reed site and API, the keyword-reading fake Jev (the decision depends on the role searched).
// The database starts as the old system left it: Caterer people unlocked and never pushed, Reed people seen and never pushed, no record of any role.
//   S1 Head Chef:      Caterer CA (a kitchen porter, legacy) is screened for Head Chef and rejected: one look given, recorded for Head Chef; CB (a head chef, legacy) is
//                      approved, unlocked again (charged), pushed. CD (a head chef, old, with a plain rejection of ANOTHER title: the keyword search of Waiter binds only
//                      Waiter) is screened for Head Chef like CB. CY (young) and CP (pushed) are skipped.
//                      Reed RA (a kitchen porter, new) and RB (a cook, legacy) are rejected for Head Chef: recorded per title; RC (a head chef, legacy) is claimed, viewed
//                      (counted) and pushed; RF (a head chef, new) is pushed; RD (pushed) and RE (viewed, never pushed) are skipped.
//   S2 Head Chef again, another territory: nobody is screened again for Head Chef; no unlock, no view.
//   S3 Kitchen Porter: CA is screened again (a new role), approved, unlocked (charged), pushed; Reed RA and RB (rejected for Head Chef only) are screened as normal and
//                      pushed. Nobody is pushed twice.
//   S4 Sous Chef with ROLE_SCOPE_LEGACY=off: the old skip is back for the people whose role was never recorded (CG, RG); nothing is recorded, nothing counted.
//   S5 the default again: CG and RG are looked at once; S6 the same title again: not again.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { World } = require('./lib/world');
const D = require('./lib/data');
const C = require('./lib/checks');

const X = 'Head Chef';
const Y = 'Kitchen Porter';
const W = 'Sous Chef';

const P = (n, over) => Object.assign({ id: 73000000 + n, n, kind: 'approve', page: 1, title: 'Kitchen Porter', city: 'Leeds', pc: 'LS29 8AA', exp: 6, cv: 'pdf', tokens: '', credit: 1 }, over || {});
const CA = P(31); // a kitchen porter: too junior for a head chef, right for a kitchen porter
const CB = P(32, { title: 'Head Chef', exp: 12 });
const CY = P(33); // young: unlocked 3 days ago, the stranded recovery owns it
const CP = P(34, { title: 'Head Chef', exp: 12 }); // already in Zoho
const CD = P(35, { title: 'Head Chef', exp: 12 }); // unlocked, never pushed, old, a plain rejection of ANOTHER title on record (it binds only that title)
const CG = P(36, { title: 'Sous Chef', exp: 8 });
const PEOPLE = [CA, CB, CY, CP, CD, CG];

const bucket = (c) => `fetch:UnlockCandidate?${new URLSearchParams({ CandidateData: D.cardOf(c).dataValue }).toString()}`;
const unlocks = (w, c) => (w.fakeBrowserState().counters || {})[bucket(c)] || 0;
const card = (c) => Object.assign(D.cardOf(c), { neverUnlocked: false, unlockedPrev: true });

// Reed: the same fake site for every search; the card list is rewritten between searches (a fresh Reed browser reads it)
const rcard = (id, title, name) => ({
  candidateId: id, name: name || `Reed Person ${id}`, firstName: 'Reed',
  jobPreference: { currentJobTitle: title, desiredJobTitle: title, jobType: 'Permanent', locations: { currentLocation: 'Leeds', desiredLocations: 'Leeds' }, salary: { minimumSalary: '22000' } },
});
const RA = rcard(9001, 'Kitchen Porter');
const RB = rcard(9002, 'Chef de Partie');
const RC = rcard(9003, 'Head Chef');
const RD = rcard(9004, 'Head Chef');
const RE = rcard(9005, 'Head Chef');
const RF = rcard(9006, 'Head Chef');
const RG = rcard(9007, 'Sous Chef');

const SEARCHES = {
  s1: { title: X, loc: 'LS29', caterer: [CA, CB, CY, CP, CD], reed: [RA, RB, RC, RD, RE, RF] },
  s2: { title: X, loc: 'BD2', caterer: [CA, CB, CY, CP, CD], reed: [RA, RB, RC, RD, RE, RF] },
  s3: { title: Y, loc: 'BD1', caterer: [CA, CB, CY, CP, CD], reed: [RA, RB, RC, RD, RE, RF] },
  s4: { title: W, loc: 'BD3', caterer: [CG, CY, CP], reed: [RG, RD] },
  s5: { title: W, loc: 'BD4', caterer: [CG, CY, CP], reed: [RG, RD] },
  s6: { title: W, loc: 'BD5', caterer: [CG, CY, CP], reed: [RG, RD] },
};

function siteFor(searches) {
  const byLocation = {};
  const fetch = [];
  const seen = new Set();
  for (const s of searches) {
    byLocation[s.loc] = { pages: { 1: s.caterer.map((c) => card(c)) } };
    for (const c of s.caterer) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const k = card(c);
      fetch.push({ match: `UnlockCandidate?${new URLSearchParams({ CandidateData: k.dataValue }).toString()}`, status: 200, body: JSON.stringify({ Instructions: [{ Content: { Contents: [D.unlockHtml(c)] } }] }), credit: c.credit });
      const f = D.cvFile(c, {});
      fetch.push({ match: `${new URLSearchParams({ candidateId: D.encIdOf(c) }).toString()}&`, status: 200, headers: { 'content-type': f.contentType, 'content-disposition': `attachment; filename="${f.filename}"` }, bodyBase64: f.buffer.toString('base64') });
    }
  }
  return { credentials: { username: D.SECRETS.catererUser, password: D.SECRETS.catererPass }, credits: 5000, searchWorld: { byLocation }, fetch };
}

function sqlite(w) { return require(path.join(w.home, 'node_modules', 'better-sqlite3')); }

// the database as the old system left it
function seed(w) {
  const Database = sqlite(w);
  const db = new Database(w.p('candidates.db'), { timeout: 5000 });
  try {
    const cat = db.prepare("INSERT INTO candidates (caterer_id, source, unlocked, zoho_id) VALUES (?, 'caterer', 1, ?)");
    const setCreated = db.prepare('UPDATE candidates SET created_at = ? WHERE caterer_id = ?');
    for (const c of [CA, CB, CG]) { cat.run(c.id, null); setCreated.run(null, c.id); } // legacy: unlocked, never pushed, no record, no created_at
    cat.run(CY.id, null); setCreated.run(new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 19).replace('T', ' '), CY.id);
    cat.run(CP.id, 'ZOHO-CP'); setCreated.run(null, CP.id);
    cat.run(CD.id, null); setCreated.run(null, CD.id);
    db.prepare("INSERT INTO candidate_rejections (caterer_id, job_title, rejected_at, origin) VALUES (?, 'Waiter', '2026-09-20', 'pipeline')").run(CD.id);
    const reed = db.prepare("INSERT INTO candidates (reed_id, source, unlocked, zoho_id) VALUES (?, 'reed', ?, ?)");
    for (const [id, unlocked, zoho] of [[9002, 0, null], [9003, 0, null], [9004, 0, 'ZOHO-RD'], [9005, 1, null], [9007, 0, null]]) reed.run(id, unlocked, zoho);
  } finally { db.close(); }
}

const dbRows = (w, id, reed) => w.dbAll(`select job_title, origin from candidate_rejections where ${reed ? 'reed_id' : 'caterer_id'} = ? order by id`, id).map((r) => [r.job_title, r.origin]);
const zohoSources = (w) => w.svc.zoho.created().map((r) => `${r.payload.Source}:${r.payload.CatererID || r.payload.ReedID}`).sort();
const resultsOf = (w, title, loc) => {
  const all = w.list('downloads', /^phase2-results-.*\.json$/).map((f) => w.json(`downloads/${f}`)).filter((r) => r && r.jobTitle === title && r.location === loc);
  return all.sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt))).pop();
};
const stateFile = (w) => w.json('runtime/cv-resurface.json');
const screened = (w) => w.jsonl(`shadow/${w.list('shadow', /^screening-/).pop()}`);

function setReedCards(w, cards) {
  fs.writeFileSync(path.join(w.privateDir, 'reed-cards.json'), JSON.stringify(cards));
}

const done = (w) => async () => !w.pendingFiles().length && !w.exists('runtime/run.json') && w.pipelineProcs().length === 0;
async function search(w, s) {
  setReedCards(w, s.reed);
  w.dropPending({ jobTitle: s.title, location: s.loc, distance: 20, sources: 'both' });
  const ticks = await w.tickUntil(done(w), { maxTicks: 16, tickMin: 1, gapMs: 1500 });
  for (const tk of ticks) assert.deepEqual([tk.code, tk.stderr], [0, ''], tk.stdout + tk.stderr);
  assert.equal(w.lastRun().exitCode, 0);
  assert.equal(w.lastRun().jobTitle || s.title, s.title);
}

const personAllowed = [
  { re: /workspace\/resourcer\/downloads\/(approved|merged|reed-approved)-queue-[^/]*\.json$/, kinds: ['name', 'surname', 'email', 'phone'] },
  { re: /workspace\/resourcer\/downloads\/phase2-results-[^/]*\.json$/, kinds: ['name', 'surname'] },
  { re: /workspace\/resourcer\/shadow\/screening-[^/]*\.jsonl$/, kinds: ['snippet'] },
];
function hitsOfPeople(w) {
  const hits = [];
  const all = [];
  for (const c of PEOPLE) for (const [kind, value] of Object.entries(C.markers(c.n))) all.push({ n: c.n, kind, value });
  for (const f of C.profileFiles(w)) {
    const rel = path.relative(w.profile, f).split(path.sep).join('/');
    let buf;
    try { buf = fs.readFileSync(f); } catch { continue; }
    for (const m of all) {
      if (!buf.includes(m.value)) continue;
      if (personAllowed.some((x) => x.re.test(rel) && x.kinds.includes(m.kind))) continue;
      hits.push({ file: rel, n: m.n, kind: m.kind });
    }
  }
  return hits;
}

// scenario 20 (20-rolescope-cvon.e2e.js) runs this same file with CV_SCREEN=on: the role scope together with the CV stage that really rejects
const CVON = process.env.E2E_ROLESCOPE_CV === 'on';
const w = new World(CVON ? 's20-rolescope-cvon' : 's19-rolescope');
const reedUsage = () => (w.dbAll('select profile_views from reed_daily_usage order by date desc limit 1')[0] || { profile_views: 0 }).profile_views;

test.before(async () => {
  await w.create({ engine: null });
  w.setWorld(siteFor(Object.values(SEARCHES)), true);
  await w.enableReed(SEARCHES.s1.reed);
  w.svc.zoho.state.dupKeys.add('71000010');
  seed(w);
  if (CVON) w.writeEnv({ CV_SCREEN: 'on' });
});
test.after(async () => { await w.close(); });

test('19.1 S1 (Head Chef): the people whose role was never recorded are screened once for Head Chef (Caterer and Reed); the young, the pushed and the viewed keep the old skip', async () => {
  await search(w, SEARCHES.s1);
  // Caterer
  assert.equal(unlocks(w, CA), 0, 'CA was rejected at the snippet stage: no unlock, no charge');
  assert.deepEqual(dbRows(w, CA.id), [[X, 'resurface:snippet']], 'the rejection is recorded for Head Chef');
  assert.equal(unlocks(w, CB), 1, 'CB was approved: the further unlock the owner accepted');
  assert.deepEqual(dbRows(w, CB.id), [[X, 'resurface:pushed']]);
  for (const c of [CY, CP]) assert.equal(unlocks(w, c), 0, `#${c.n} was not touched`);
  assert.deepEqual(dbRows(w, CY.id), []);
  assert.equal(unlocks(w, CD), 1, 'CD: the rejection for Waiter does not block Head Chef: screened, approved, unlocked again (charged)');
  assert.deepEqual(dbRows(w, CD.id), [['Waiter', 'pipeline'], [X, 'resurface:pushed']], 'the rejection of Waiter stays; the look records Head Chef');
  // Reed
  assert.deepEqual(dbRows(w, 9001, true), [[X, 'reed:snippet']], 'a new Reed person rejected for Head Chef: recorded per title');
  assert.deepEqual(dbRows(w, 9002, true), [[X, 'reed:snippet']], 'a legacy Reed person (no record) rejected: recorded for this title');
  assert.deepEqual(dbRows(w, 9003, true), [[X, 'resurface:pushed']], 'a legacy Reed person approved: claimed before the view, then pushed');
  assert.deepEqual(dbRows(w, 9006, true), [[X, 'reed:approved']], 'a new approval: its title row');
  assert.deepEqual(dbRows(w, 9004, true), [], 'pushed: never touched');
  assert.deepEqual(dbRows(w, 9005, true), [], 'viewed and never pushed: the old skip');
  assert.deepEqual(zohoSources(w), [`Caterer:${CB.id}`, `Caterer:${CD.id}`, 'Reed:9003', 'Reed:9006'].sort());
  assert.equal(reedUsage(), 2, 'two profile views: the legacy look RC and the new approval RF');
  // the numbers
  const res = resultsOf(w, X, 'LS29');
  assert.equal(res.new, 4);
  const l = res.resurfaced.legacy;
  assert.deepEqual([l.screened, l.rejectedAtSnippet, l.candidates, l.caterer, l.reed, l.pushed, l.credits, l.reedViews, l.charged], [5, 2, 3, 2, 1, 3, 2, 1, 3], JSON.stringify(l));
  const row = w.dbAll('select caterer_json, reed_json from run_results where job_title = ? and location = ?', X, 'LS29')[0];
  const cj = JSON.parse(row.caterer_json).resurfaced.legacy;
  const rj = JSON.parse(row.reed_json).resurfaced.legacy;
  assert.deepEqual([cj.screened, cj.rejectedAtSnippet, cj.candidates, cj.pushed, cj.credits, cj.charged], [3, 1, 2, 2, 2, 2], 'the Caterer side of the run_results row: CA rejected at the snippet stage, CB and CD claimed, charged and pushed');
  assert.deepEqual([rj.screened, rj.rejectedAtSnippet, rj.candidates, rj.pushed, rj.reedViews, rj.charged], [2, 1, 1, 1, 1, 1], 'the Reed side: RB rejected at the snippet stage, RC claimed, viewed and pushed');
  assert.deepEqual(w.dbAll("select name from pragma_table_info('run_results') order by cid").map((c) => c.name).filter((n) => /legacy|scope/.test(n)), [], 'no new column');
  const s = stateFile(w).today;
  assert.deepEqual([s.legacyCaterer, s.legacyReed, s.legacyRejected, s.legacyPushed, s.legacyCharged, s.legacyCredits, s.legacyViews], [3, 2, 2, 3, 3, 2, 1]);
  assert.deepEqual([s.started, s.caterer, s.reed], [2, 2, 0], 'the Caterer look took a slot of the cap; the Reed look did not');
});

test('19.2 S2 (Head Chef again, another territory): nobody is screened again for Head Chef; no unlock, no view, no new row', async () => {
  const unlocksBefore = [CA, CB, CY, CP, CD].map((c) => unlocks(w, c));
  const views = reedUsage();
  const rowsBefore = w.dbAll('select count(*) n from candidate_rejections')[0].n;
  const shadowBefore = screened(w).length;
  await search(w, SEARCHES.s2);
  assert.deepEqual([CA, CB, CY, CP, CD].map((c) => unlocks(w, c)), unlocksBefore);
  assert.equal(reedUsage(), views);
  assert.equal(w.dbAll('select count(*) n from candidate_rejections')[0].n, rowsBefore);
  assert.equal(screened(w).length, shadowBefore, 'nothing was screened at all');
  assert.equal(w.svc.zoho.created().length, 4, 'no second Zoho record');
});

test('19.3 S3 (Kitchen Porter): CA, RA and RB, rejected for Head Chef only, are screened as normal for the new role and pushed; nobody is pushed twice', async () => {
  await search(w, SEARCHES.s3);
  assert.equal(unlocks(w, CA), 1);
  assert.deepEqual(dbRows(w, CA.id), [[X, 'resurface:snippet'], [Y, 'resurface:pushed']]);
  assert.equal(unlocks(w, CB), 1, 'the pushed head chef is not fetched again');
  assert.deepEqual(dbRows(w, 9003, true), [[X, 'resurface:pushed']], 'pushed: nothing for the new role');
  if (!CVON) {
    assert.deepEqual(dbRows(w, 9001, true), [[X, 'reed:snippet'], [Y, 'reed:approved']]);
    assert.deepEqual(dbRows(w, 9002, true), [[X, 'reed:snippet'], [Y, 'reed:approved']]);
    assert.deepEqual(zohoSources(w), [`Caterer:${CA.id}`, `Caterer:${CB.id}`, `Caterer:${CD.id}`, 'Reed:9001', 'Reed:9002', 'Reed:9003', 'Reed:9006'].sort());
    assert.equal(w.svc.zoho.state.calls.filter((c) => c.op === 'create').length, 7, 'exactly one create call per person in the whole world');
    const s = stateFile(w).today;
    assert.deepEqual([s.legacyCaterer, s.legacyReed, s.legacyPushed], [4, 2, 4]);
  } else {
    // with the CV stage on, the fake CV of a new Reed approval may be rejected after the download: its row becomes the CV rejection for the new title (one row per person
    // and title); what must hold is that each was screened once for each of the two titles, and that nobody is pushed twice
    for (const id of [9001, 9002]) {
      const rows = dbRows(w, id, true);
      assert.deepEqual(rows.map((r) => r[0]), [X, Y]);
      assert.match(rows[1][1], /^(reed:approved|cv:)/);
    }
    const z = zohoSources(w);
    assert.equal(new Set(z).size, z.length, 'nobody is pushed twice: ' + z.join(','));
    for (const k of [`Caterer:${CA.id}`, `Caterer:${CB.id}`, `Caterer:${CD.id}`, 'Reed:9003', 'Reed:9006']) assert.ok(z.includes(k), k);
    assert.equal(w.svc.zoho.state.calls.filter((c) => c.op === 'create').length, z.length, 'exactly one create call per person in the whole world');
  }
});

test('19.4 S4 (Sous Chef, ROLE_SCOPE_LEGACY=off): the old skip is back for CG and RG; nothing is recorded, nothing is counted, no key in the results', async () => {
  w.writeEnv({ ROLE_SCOPE_LEGACY: 'off' });
  const before = JSON.stringify(stateFile(w));
  const rowsBefore = w.dbAll('select count(*) n from candidate_rejections')[0].n;
  await search(w, SEARCHES.s4);
  assert.equal(unlocks(w, CG), 0);
  assert.deepEqual(dbRows(w, CG.id), []);
  assert.deepEqual(dbRows(w, 9007, true), []);
  assert.equal(w.dbAll('select count(*) n from candidate_rejections')[0].n, rowsBefore);
  assert.equal(JSON.stringify(stateFile(w)), before, 'nothing counted');
  const res = resultsOf(w, W, 'BD3');
  assert.ok(!('resurfaced' in res), JSON.stringify(res.resurfaced));
  assert.equal(w.lastRun().skippedDb >= 3, true);
});

test('19.5 S5 (the default again) and S6 (the same title again): CG and RG are looked at once and recorded; the same title never again', async () => {
  w.writeEnv({ ROLE_SCOPE_LEGACY: null });
  await search(w, SEARCHES.s5);
  assert.equal(unlocks(w, CG), 1);
  assert.deepEqual(dbRows(w, CG.id), [[W, 'resurface:pushed']]);
  assert.deepEqual(dbRows(w, 9007, true), [[W, 'resurface:pushed']]);
  const z = zohoSources(w);
  assert.ok(z.includes(`Caterer:${CG.id}`) && z.includes('Reed:9007'));
  const unlocksBefore = unlocks(w, CG);
  const views = reedUsage();
  const created = w.svc.zoho.created().length;
  await search(w, SEARCHES.s6);
  assert.equal(unlocks(w, CG), unlocksBefore);
  assert.equal(reedUsage(), views);
  assert.equal(w.svc.zoho.created().length, created, 'no second Zoho record');
});

test('19.6 the totals, the alerts, and nothing personal or secret outside its home', () => {
  const s = stateFile(w).today;
  assert.deepEqual([s.legacyCaterer, s.legacyReed, s.legacyRejected, s.legacyPushed], CVON ? [s.legacyCaterer, 3, 2, s.legacyPushed] : [5, 3, 2, 6], JSON.stringify(s)); // CV_SCREEN on: a person who has a recorded look is the CV rule's, counted there
  assert.deepEqual(w.alerts().filter((a) => a.severity !== 'info').map((a) => a.key), [], 'no alert: the cap and the reserve were never reached');
  assert.deepEqual(w.netBlocked(), []);
  assert.deepEqual(C.secretHits(w), []);
  const hits = hitsOfPeople(w);
  assert.deepEqual(hits, [], C.fmtHits(hits));
  assert.deepEqual(C.strayFiles(w), []);
  assert.deepEqual(w.lockProblems(), []);
  assert.deepEqual(w.list('runtime').filter((n) => /cv-resurface\.lock$/.test(n)), []);
  assert.equal(C.modeOf(w.p('runtime/cv-resurface.json')), 0o600);
  assert.deepEqual(w.list('downloads').filter((n) => /^(cv-|cv-reed-|candidate-)/.test(n)), [], 'no CV or candidate JSON left');
});

// ---- R-C7: with nothing legacy in the database the shipped default (the role scope on) and ROLE_SCOPE_LEGACY=off leave exactly the same behind, in the whole world
// (Caterer and Reed, some Reed cards rejected by the screening). The per-title ledger of Reed (reed:snippet, reed:approved) is the one thing the new code writes that
// no switch controls: it is counted, not compared. Against the code of the previous release the same worlds are compared by tests/e2e-identity.sh (docs/ROLESCOPE.md).
test('19.7 R-C7 with nothing legacy in the database the shipped default and ROLE_SCOPE_LEGACY=off leave exactly the same behind, Caterer and Reed', { skip: CVON && 'compared at the shipped default by scenario 19' }, async () => {
  const { oneWorld, WORLDS } = require('./lib/identity');
  const on = await oneWorld('s19-eq-on', WORLDS['both-default']);
  const off = await oneWorld('s19-eq-off', Object.assign({}, WORLDS['both-default'], { env: { ROLE_SCOPE_LEGACY: 'off' } }));
  const strip = (x) => Object.assign({}, x, { reedLedgerRows: undefined });
  assert.ok(on.results.length >= 1 && on.zoho.length >= 25 && on.reedUsage.profile_views >= 1, 'the world ran, Caterer and Reed');
  assert.deepEqual(strip(on), strip(off));
  assert.ok(on.reedLedgerRows >= 6, 'the new per-title ledger of Reed is written either way (it has no switch)');
  assert.ok(!JSON.stringify(on.results).includes('legacy'), 'no legacy key anywhere in the results');
  assert.deepEqual(on.runtime, [], 'no counter file');
});
