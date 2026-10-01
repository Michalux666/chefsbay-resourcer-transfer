'use strict';
// SCENARIO 18 - the role-scoped second look (docs/RESURFACE.md), the whole pipeline, run the way Hermes runs it (cron wrapper, scrubbed environment).
// CV_SCREEN=on, a charging fake Caterer (the unlock spends a credit and the search page shows the balance), seven searches in one world:
//   S1 Head Chef: A (a kitchen porter), A2 (a retail assistant) and B (a head chef) are unlocked; the CV stage rejects A and A2 for Head Chef, B is pushed.
//   S2 Head Chef again, another territory: A, A2 and B are skipped (nothing is screened, nothing is unlocked).
//   S3 Kitchen Porter: A and A2 (rejected for another role) and C (a legacy rejection with the sentinel) come up again; the daily cap of three stops E and F; D (stranded:
//      unlocked, no record) and B (pushed) are skipped. A is pushed, C is pushed, A2 is rejected again. A charges again, A2 does not (a platform that does not), C charges.
//   S4 Kitchen Porter again: A2 (rejected for this role) and the pushed ones are skipped; the cap still holds E and F and the alert is not raised a second time.
//   S5 Sous Chef with CV_RESURFACE=off, a new day: A2, E and F are skipped, exactly as before the feature.
//   S6 the same search with the default (on): A2, E and F are looked at again, F is pushed, A2 and E are rejected again.
//   S7 CV_SCREEN=shadow: nobody is looked at again, whatever the role.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { World } = require('./lib/world');
const D = require('./lib/data');
const C = require('./lib/checks');

const X = 'Head Chef';
const Y = 'Kitchen Porter';
const Z = 'Sous Chef';

const P = (n, over) => Object.assign({ id: 72000000 + n, n, kind: 'approve', page: 1, title: 'Kitchen Porter', city: 'Leeds', pc: 'LS29 8AA', exp: 6, cv: 'pdf', tokens: '[[APPROVE]]' }, over || {});
const A = P(21, { creditRepeat: 1 });
const A2 = P(22, { creditRepeat: 0 }); // a platform that does not charge for the second look
const B = P(23, { title: 'Head Chef', exp: 12 });
const CL = P(24); // legacy post-unlock rejection with the sentinel '*' (the role of that unlock is unknown)
const DS = P(25); // stranded: unlocked, no record at all
const E = P(26);
const F = P(27);
const G = P(28); // unlocked, never pushed, and only a plain pre-unlock rejection of another role (origin pipeline): a failed push or a stranded one, NOT a record of a rejection
const PEOPLE = [A, A2, B, CL, DS, E, F, G];
// the CV says something different from the headline of the card: that is what makes the decision depend on the role
const CV_TITLES = { 21: 'Kitchen Porter', 22: 'Retail Assistant', 23: 'Head Chef', 24: 'Kitchen Porter', 25: 'Kitchen Porter', 26: 'Retail Assistant', 27: 'Sous Chef', 28: 'Kitchen Porter' };

const bucket = (c) => `fetch:UnlockCandidate?${new URLSearchParams({ CandidateData: D.cardOf(c).dataValue }).toString()}`;
const unlocks = (w, c) => (w.fakeBrowserState().counters || {})[bucket(c)] || 0;
const totalUnlocks = (w) => PEOPLE.reduce((a, c) => a + unlocks(w, c), 0);

const card = (c, prev) => Object.assign(D.cardOf(c), { neverUnlocked: !prev, unlockedPrev: !!prev });

function siteFor(searches) {
  const byLocation = {};
  const fetch = [];
  const seen = new Set();
  for (const s of searches) {
    byLocation[s.loc] = { pages: { 1: s.cards.map(([c, prev]) => card(c, prev)) } };
    for (const [c] of s.cards) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const k = card(c, false);
      const first = c.credit === undefined ? 1 : c.credit;
      fetch.push({ match: `UnlockCandidate?${new URLSearchParams({ CandidateData: k.dataValue }).toString()}`, status: 200, body: JSON.stringify({ Instructions: [{ Content: { Contents: [D.unlockHtml(c)] } }] }), credit: first, creditRepeat: c.creditRepeat });
      const f = D.cvFile(c, { cvTitles: CV_TITLES });
      fetch.push({ match: `${new URLSearchParams({ candidateId: D.encIdOf(c) }).toString()}&`, status: 200, headers: { 'content-type': f.contentType, 'content-disposition': `attachment; filename="${f.filename}"` }, bodyBase64: f.buffer.toString('base64') });
    }
  }
  return { credentials: { username: D.SECRETS.catererUser, password: D.SECRETS.catererPass }, credits: 5000, searchWorld: { byLocation }, fetch };
}

// all seven searches up front: a card shows "Unlocked previously" from the search in which the platform has unlocked it
const SEARCHES = {
  s1: { title: X, loc: 'LS29', cards: [[A, false], [A2, false], [B, false]] },
  s2: { title: X, loc: 'BD2', cards: [[A, true], [A2, true], [B, true]] },
  s3: { title: Y, loc: 'BD1', cards: [[A, true], [A2, true], [B, true], [CL, true], [DS, true], [G, true], [E, true], [F, true]] },
  s4: { title: Y, loc: 'BD4', cards: [[A, true], [A2, true], [B, true], [CL, true], [DS, true], [G, true], [E, true], [F, true]] },
  s5: { title: Z, loc: 'BD5', cards: [[A2, true], [E, true], [F, true]] },
  s6: { title: Z, loc: 'BD6', cards: [[A2, true], [E, true], [F, true]] },
  s7: { title: 'Commis Chef', loc: 'BD7', cards: [[A2, true], [E, true], [F, true]] },
};

function sqlite(w) { return require(path.join(w.home, 'node_modules', 'better-sqlite3')); }

// legacy data of the restored database: rows the old system left behind (fake ids only)
function seed(w) {
  const Database = sqlite(w);
  const db = new Database(w.p('candidates.db'), { timeout: 5000 });
  try {
    const insC = db.prepare('INSERT INTO candidates (caterer_id, source, unlocked, zoho_id) VALUES (?, ?, 1, ?)');
    const insR = db.prepare('INSERT INTO candidate_rejections (caterer_id, job_title, rejected_at, origin) VALUES (?, ?, ?, ?)');
    insC.run(CL.id, 'caterer', null);
    insR.run(CL.id, '*', '2026-08-03', 'log-backfill');
    insC.run(DS.id, 'caterer', null); // stranded: no rejection row, no Zoho id
    insC.run(G.id, 'caterer', null);
    insR.run(G.id, X, '2026-09-20', 'pipeline');
    for (const c of [E, F]) { insC.run(c.id, 'caterer', null); insR.run(c.id, X, '2026-09-20', 'cv:under_qualified'); }
  } finally { db.close(); }
}

const dbRows = (w, id) => w.dbAll('select job_title, origin from candidate_rejections where caterer_id = ? order by id', id).map((r) => [r.job_title, r.origin]);
const zohoKeys = (w) => [...w.svc.zoho.state.records.values()].map((r) => r.key).sort();
const resultsOf = (w, title, loc) => {
  const all = w.list('downloads', /^phase2-results-.*\.json$/).map((f) => w.json(`downloads/${f}`)).filter((r) => r && r.jobTitle === title && r.location === loc);
  return all.sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt))).pop();
};
const stateFile = (w) => w.json('runtime/cv-resurface.json');
const capAlerts = (w) => w.alerts().filter((a) => a.key === 'cv-resurface-cap-reached');

async function search(w, s) {
  w.dropPending({ jobTitle: s.title, location: s.loc, distance: 20 });
  const ticks = await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json'), { maxTicks: 14, tickMin: 1 });
  for (const tk of ticks) assert.deepEqual([tk.code, tk.stderr], [0, ''], tk.stdout + tk.stderr);
  assert.equal(w.lastRun().exitCode, 0);
}

const personAllowed = [
  { re: /workspace\/resourcer\/downloads\/approved-queue-[^/]*\.json$/, kinds: ['name', 'surname', 'email', 'phone'] },
  { re: /workspace\/resourcer\/downloads\/merged-queue-[^/]*\.json$/, kinds: ['name', 'surname', 'email', 'phone'] },
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

const w = new World('s18-resurface');
const shadowRows = () => w.list('shadow', /^cv-\d{4}-\d{2}-\d{2}\.jsonl$/).flatMap((f) => w.jsonl(`shadow/${f}`)).filter((r) => !r.kind);
let shadowKeysOfS1 = null;

test.before(async () => {
  await w.create({ engine: null });
  w.writeEnv({ CV_SCREEN: 'on', CV_RESURFACE_MAX_PER_DAY: '3' });
  w.setWorld(siteFor(Object.values(SEARCHES)), true);
  seed(w);
});
test.after(async () => { await w.close(); });

test('18.1 S1 (Head Chef): the first unlocks; the CV stage rejects the two who do not fit, the head chef is pushed; nothing is resurfaced yet', async () => {
  await search(w, SEARCHES.s1);
  assert.deepEqual(zohoKeys(w), [String(B.id)]);
  assert.equal(totalUnlocks(w), 3);
  const res = resultsOf(w, X, 'LS29');
  assert.equal(res.cvRejected, 2);
  assert.ok(!('resurfaced' in res), 'no resurfaced block when nothing was resurfaced');
  assert.deepEqual(dbRows(w, A.id).map((r) => r[0]), [X]);
  assert.match(dbRows(w, A.id)[0][1], /^cv:/);
  assert.match(dbRows(w, A2.id)[0][1], /^cv:/);
  assert.equal(w.dbAll('select unlocked from candidates where caterer_id = ?', A.id)[0].unlocked, 1);
  assert.equal(stateFile(w), null, 'the counters file does not exist until the second look does something');
  shadowKeysOfS1 = new Set(shadowRows().flatMap((r) => Object.keys(r)));
  assert.ok(shadowKeysOfS1.size > 5 && shadowRows().length === 3);
  assert.deepEqual(w.list('downloads').filter((n) => /^(cv-|candidate-)/.test(n)), []);
});

test('18.2 S2 (Head Chef again, another territory): the same people are skipped for the same role; no unlock, no charge', async () => {
  const before = totalUnlocks(w);
  await search(w, SEARCHES.s2);
  assert.equal(totalUnlocks(w), before);
  assert.equal(w.lastRun().skippedDb, 3);
  assert.deepEqual(zohoKeys(w), [String(B.id)]);
  assert.equal(stateFile(w), null);
});

test('18.3 S3 (Kitchen Porter): the ones rejected for another role are looked at again, charged and measured; the cap stops the next two; stranded and pushed ones are skipped', async () => {
  await search(w, SEARCHES.s3);
  // who was unlocked again: A, A2 and C (the first three eligible in page order); E and F were held back by the cap, D and B never reached the unlock
  assert.equal(unlocks(w, A), 2);
  assert.equal(unlocks(w, A2), 2);
  assert.equal(unlocks(w, CL), 1);
  for (const c of [DS, G, E, F]) assert.equal(unlocks(w, c), 0, `#${c.n} was not unlocked`);
  assert.equal(unlocks(w, B), 1, 'the pushed one is never fetched again');
  // A and C are pushed (one record each, B from S1), A2 is rejected again for this role
  assert.deepEqual(zohoKeys(w), [A.id, B.id, CL.id].map(String).sort());
  const res = resultsOf(w, Y, 'BD1');
  assert.equal(res.cvRejected, 1);
  assert.equal(res.new, 2);
  const r = res.resurfaced;
  assert.equal(r.candidates, 3);
  assert.deepEqual([r.charged, r.notCharged, r.chargedUnknown, r.credits], [2, 1, 0, 2], 'A and C were charged one credit each, A2 was not');
  assert.deepEqual([r.pushed, r.cvRejected], [2, 1]);
  assert.equal(r.capped, 2, 'E and F were held back by the cap');
  const byId = new Map(res.candidates.map((c) => [c.id, c]));
  assert.equal(byId.get(String(A.id)).resurfaced, true);
  assert.equal(byId.get(String(A.id)).charge, 'charged');
  assert.equal(byId.get(String(A2.id)).charge, 'notCharged');
  assert.equal(byId.get(String(A2.id)).status, 'cv_rejected');
  assert.equal(byId.get(String(CL.id)).charge, 'charged');
  assert.ok(!byId.has(String(B.id)) && !byId.has(String(DS.id)) && !byId.has(String(G.id)) && !byId.has(String(E.id)));
  assert.deepEqual(res.catererStats.resurfaced.candidates, 3);
  // the same numbers travel in the run_results row (its caterer_json column), without a schema change
  const rr = w.dbAll("select caterer_json from run_results where job_title = ? and location = ?", Y, 'BD1')[0];
  assert.equal(JSON.parse(rr.caterer_json).resurfaced.credits, 2);
  assert.deepEqual(w.dbAll("select name from pragma_table_info('run_results') order by cid").map((c) => c.name).filter((n) => /resurf/.test(n)), [], 'no new column');
  // the database: one row per role, the old rows untouched, no second unlock flag, the claim became the CV rejection or the push
  assert.deepEqual(dbRows(w, A.id), [[X, dbRows(w, A.id)[0][1]], [Y, 'resurface:pushed']]);
  assert.match(dbRows(w, A.id)[0][1], /^cv:/);
  assert.equal(dbRows(w, A2.id).length, 2);
  assert.match(dbRows(w, A2.id)[1][1], /^cv:/);
  assert.deepEqual(dbRows(w, CL.id), [['*', 'log-backfill'], [Y, 'resurface:pushed']]);
  assert.deepEqual(dbRows(w, E.id).map((x) => x[0]), [X], 'nothing was recorded against the people the cap held back');
  assert.deepEqual(dbRows(w, DS.id), [], 'the stranded one has no record and keeps the old skip');
  assert.deepEqual(dbRows(w, G.id), [[X, 'pipeline']], 'a plain pre-unlock rejection is no record of an unlock-and-reject: G keeps the old skip (a second charge for the role of its own unlock must not happen) and nothing is recorded');
  assert.equal(w.dbAll('select unlocked from candidates where caterer_id = ?', A.id)[0].unlocked, 1);
  assert.deepEqual(w.dbAll('select caterer_id, zoho_id is not null as z from candidates where caterer_id in (?, ?)', A2.id, E.id).map((x) => x.z), [0, 0]);
  // the counters, and one warning
  const s = stateFile(w).today;
  assert.deepEqual([s.started, s.caterer, s.charged, s.notCharged, s.unknown, s.credits, s.pushed, s.rejected, s.capped], [3, 3, 2, 1, 0, 2, 2, 1, 2]);
  assert.equal(capAlerts(w).length, 1);
  assert.equal(capAlerts(w)[0].severity, 'warn');
  assert.deepEqual(w.list('downloads').filter((n) => /^(cv-|candidate-)/.test(n)), [], 'every re-downloaded CV was deleted after the CV stage');
  const log = w.text(`logs/${w.list('logs', /^phase1-console-/).pop()}`);
  assert.match(log, /RESURFACE claimed for this role/);
  assert.match(log, /RESURFACE re-opened: charged, 1 credit/);
  assert.match(log, /RESURFACE re-opened: not charged/);
});

test('18.4 S4 (Kitchen Porter again): rejected for this role is final, pushed is final, the cap still holds and the warning is not raised a second time', async () => {
  const before = totalUnlocks(w);
  await search(w, SEARCHES.s4);
  assert.equal(totalUnlocks(w), before, 'nobody was unlocked');
  assert.deepEqual(zohoKeys(w), [A.id, B.id, CL.id].map(String).sort(), 'no second Zoho record');
  assert.equal(w.svc.zoho.state.calls.filter((c) => c.op === 'create').length, 3, 'exactly one create call per pushed person in the whole world');
  assert.equal(dbRows(w, A2.id).length, 2, 'no further row for A2');
  assert.equal(capAlerts(w).length, 1, 'one warning a day');
  const s = stateFile(w).today;
  assert.equal(s.started, 3);
  assert.equal(s.capped, 4);
});

test('18.5 S5 (a new day, CV_RESURFACE=off): the old skip is back, whatever the rows say', async () => {
  fs.rmSync(w.p('runtime/cv-resurface.json'));
  w.writeEnv({ CV_RESURFACE: 'off' });
  const before = totalUnlocks(w);
  await search(w, SEARCHES.s5);
  assert.equal(totalUnlocks(w), before);
  assert.equal(w.lastRun().skippedDb, 3);
  assert.equal(stateFile(w), null, 'with the switch off nothing is counted');
  const res = resultsOf(w, Z, 'BD5');
  assert.ok(!('resurfaced' in res));
});

test('18.6 S6 (the default again): the same people are now looked at again; a CV that fits the new role is pushed, the others are rejected again for it', async () => {
  w.writeEnv({ CV_RESURFACE: null });
  await search(w, SEARCHES.s6);
  assert.equal(unlocks(w, A2), 3);
  assert.equal(unlocks(w, E), 1);
  assert.equal(unlocks(w, F), 1);
  assert.deepEqual(zohoKeys(w), [A.id, B.id, CL.id, F.id].map(String).sort());
  const res = resultsOf(w, Z, 'BD6');
  assert.equal(res.resurfaced.candidates, 3);
  assert.equal(res.resurfaced.pushed, 1);
  assert.equal(res.resurfaced.cvRejected, 2);
  assert.deepEqual(dbRows(w, A2.id).map((r) => r[0]), [X, Y, Z]);
  assert.equal(dbRows(w, A2.id)[2][1].startsWith('cv:'), true);
  assert.deepEqual(dbRows(w, E.id).map((r) => r[0]), [X, Z]);
  assert.equal(dbRows(w, F.id)[1][1], 'resurface:pushed');
  assert.equal(stateFile(w).today.started, 3);
});

test('18.7 S7 (CV_SCREEN=shadow): nobody is looked at again, whatever the role', async () => {
  w.writeEnv({ CV_SCREEN: 'shadow' });
  fs.rmSync(w.p('runtime/cv-resurface.json'));
  const before = totalUnlocks(w);
  await search(w, SEARCHES.s7);
  assert.equal(totalUnlocks(w), before);
  assert.equal(w.lastRun().skippedDb, 3);
  assert.equal(stateFile(w), null);
  const res = resultsOf(w, 'Commis Chef', 'BD7');
  assert.ok(!('resurfaced' in res));
  assert.equal(res.cvScreen === undefined || res.cvScreen.mode === 'shadow', true);
});

test('18.8 nothing personal or secret outside its home, no stray file, no leftover lock, only the one warning', () => {
  assert.deepEqual(w.netBlocked(), []);
  assert.deepEqual(C.secretHits(w), []);
  const hits = hitsOfPeople(w);
  assert.deepEqual(hits, [], C.fmtHits(hits));
  assert.deepEqual(C.strayFiles(w), []);
  assert.deepEqual(w.lockProblems(), []);
  assert.deepEqual(w.list('runtime').filter((n) => /cv-resurface\.lock$/.test(n)), []);
  assert.equal(C.modeOf(w.p('runtime/cv-resurface.json')), null, 'the file of S7 was removed and the shadow run did not create it');
  assert.deepEqual(w.alerts().filter((a) => a.severity !== 'info').map((a) => a.key), ['cv-resurface-cap-reached']);
  // C9: the shadow log rows of the re-screened candidates hold exactly what the rows of the first screening hold: no new field, no title, no text
  const rows = shadowRows();
  assert.ok(rows.length >= 9, `${rows.length} CV rows in the log`);
  for (const r of rows) assert.deepEqual(Object.keys(r).filter((k) => !shadowKeysOfS1.has(k)), [], `a field of a row that the first screening did not have: ${JSON.stringify(Object.keys(r))}`);
  assert.ok(rows.filter((r) => String(r.candidateId) === String(A2.id)).length >= 3, 'A2 was screened once for each of three roles');
  assert.deepEqual(rows.filter((r) => String(r.candidateId) === String(A2.id)).map((r) => r.jobTitle).sort(), [X, Y, Z].sort());
  const logText = w.list('shadow', /^cv-/).map((f) => w.text(`shadow/${f}`)).join(String.fromCharCode(10));
  for (const c of PEOPLE) for (const m of Object.values(C.markers(c.n))) assert.ok(!logText.includes(m), `the CV log holds no personal marker (#${c.n})`);
});

// ---- C5: with CV_SCREEN shadow or off the feature changes nothing. The whole standard world (scenario 2: three pages, a post-unlock reject, a duplicate, a missing
// phone) is run twice, once with the shipped defaults (CV_RESURFACE unset = on) and once with CV_RESURFACE=off, and everything the pipeline leaves behind is compared:
// results, queue statistics, database rows, Zoho calls, the shadow log, the alerts. (Against the code of the previous release the same comparison was run once by the
// author, docs/RESURFACE.md section 8: this test keeps the part that can be kept in the repository.)
function snapshot(x) {
  const drop = ['startedAt', 'completedAt', 'requestedAt', 'phase1StartedAt', 'runtimeSecs', 'totalRuntimeSecs', 'timing'];
  const results = x.list('downloads', /^phase2-results-.*\.json$/).map((f) => {
    const r = JSON.parse(JSON.stringify(x.json(`downloads/${f}`)));
    for (const k of drop) delete r[k];
    delete r.phase1.browserRoundtrips;
    return r;
  });
  const shadowFile = x.list('shadow', /^cv-\d{4}-\d{2}-\d{2}\.jsonl$/)[0];
  const rows = shadowFile ? x.jsonl(`shadow/${shadowFile}`).filter((r) => !r.kind).map((r) => [String(r.candidateId), r.mode, r.decision, r.final, r.lane, r.jobTitle]).sort() : [];
  const last = x.lastRun();
  return {
    results,
    last: { exitCode: last.exitCode, phase1Code: last.phase1Code, pool: last.pool, approved: last.approved, skippedDb: last.skippedDb, errors: last.errors },
    candidates: x.dbAll('select caterer_id, reed_id, source, unlocked, zoho_id is not null as pushed from candidates order by id'),
    rejections: x.dbAll('select caterer_id, reed_id, job_title, origin from candidate_rejections order by id'),
    runResults: x.dbAll('select date, job_title, location, sources, pool, downloaded, new_to_zoho, duplicates, skipped, errors, approved_p1, skipped_db, skipped_review, pages_scraped, caterer_json, reed_json from run_results order by date, job_title'),
    zoho: x.svc.zoho.state.calls.map((c) => [c.op, c.key, c.status]),
    shadow: rows,
    alerts: x.alerts().map((a) => [a.severity, a.key]),
    files: x.list('runtime').filter((n) => /cv-resurface/.test(n)),
  };
}

async function standardWorld(name, env) {
  const x = new World(name);
  await x.create({ engine: null });
  try {
    x.writeEnv(env);
    x.svc.zoho.state.dupKeys.add('71000010');
    x.dropPending({});
    const ticks = await x.tickUntil(async () => !x.pendingFiles().length && !x.exists('runtime/run.json'), { maxTicks: 12, tickMin: 1 });
    for (const tk of ticks) assert.deepEqual([tk.code, tk.stderr], [0, ''], tk.stdout + tk.stderr);
    return snapshot(x);
  } finally {
    await x.close();
  }
}

for (const mode of ['shadow', 'off']) {
  test(`18.9 C5 CV_SCREEN=${mode}: everything the pipeline leaves behind is the same with CV_RESURFACE on (the default) and off`, async () => {
    const on = await standardWorld(`s18-eq-${mode}-on`, mode === 'off' ? { CV_SCREEN: 'off' } : {});
    const off = await standardWorld(`s18-eq-${mode}-off`, Object.assign({ CV_RESURFACE: 'off' }, mode === 'off' ? { CV_SCREEN: 'off' } : {}));
    assert.ok(on.results.length >= 1 && on.zoho.length >= 5, 'the standard world ran');
    assert.deepEqual(on, off);
    assert.deepEqual(on.files, [], 'no counter file');
    assert.ok(!JSON.stringify(on.results).includes('resurfaced'), 'no resurfaced key anywhere in the results');
    assert.ok(!on.rejections.some((r) => /^resurface/.test(r.origin)));
  });
}
