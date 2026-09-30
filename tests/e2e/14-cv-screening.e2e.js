'use strict';
// SCENARIO 14 - CV screening after the unlock (Phase 2 "Step 4.6", docs/CV-SCREENING.md): the whole pipeline on the shipped defaults, run the way
// Hermes runs it (cron wrapper, scrubbed environment, so the reviewer processes must read the AI key from the profile .env themselves).
// The fake CVs end in a one-job employment history so the stage can read them; the shared fake gateway answers the CV questions with the keyword
// brain of tests/cv/helpers/fake-jev.js. (a) nothing configured: the stage runs in SHADOW, every candidate still reaches Zoho, one numbers-only row
// per CV is logged and no name, e-mail or CV text is written anywhere; (b) CV_SCREEN=on: a candidate whose CV history is retail is not pushed, his
// files are deleted and the rejection is recorded for the job title; (c) CV_SCREEN=off: the stage does nothing at all.
const test = require('node:test');
const assert = require('node:assert/strict');
const { World } = require('./lib/world');
const D = require('./lib/data');
const C = require('./lib/checks');

const CHAT = 'POST /v1/chat/completions';
const JEV = 'POST /typesafe/v1/systemone';
const isCvRequest = (r) => r.questions.includes('search_level') || r.questions.some((k) => /^relevance_\d+$/.test(k));
const cvLogs = (w) => w.list('shadow', /^cv-\d{4}-\d{2}-\d{2}\.jsonl$/);
const resultsOf = (w) => w.json(`downloads/${w.list('downloads', /^phase2-results-.*\.json$/)[0]}`);

async function drain(w) {
  w.svc.zoho.state.dupKeys.add('71000010');
  w.dropPending({});
  const ticks = await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json'), { maxTicks: 12, tickMin: 1 });
  for (const tk of ticks) assert.deepEqual([tk.code, tk.stdout, tk.stderr], [0, '', ''], tk.stdout + tk.stderr);
  const last = w.lastRun();
  assert.equal(last.exitCode, 0);
  assert.equal(last.approved, 6);
}

const personAllowed = [
  { re: /workspace\/resourcer\/downloads\/approved-queue-[^/]*\.json$/, kinds: ['name', 'surname', 'email', 'phone'] },
  { re: /workspace\/resourcer\/downloads\/phase2-results-[^/]*\.json$/, kinds: ['name', 'surname'] },
  { re: /workspace\/resourcer\/shadow\/screening-[^/]*\.jsonl$/, kinds: ['snippet'] },
];

test('14a nothing configured: the CV stage runs in shadow, every candidate still reaches Zoho, one numbers-only row per CV is logged', async (t) => {
  const w = new World('s14a-cv-shadow');
  await w.create({ engine: null });
  t.after(() => w.close());
  assert.equal(w.envFile.CV_SCREEN, undefined, 'the .env names no CV_SCREEN: this is the shipped default');
  await drain(w);

  await t.test('the run made the numbers of scenario 2: five records in Zoho with their CVs, nobody blocked', () => {
    assert.equal(w.svc.zoho.created().length, 5);
    assert.equal(w.svc.zoho.counts().attach, 5);
    assert.deepEqual(w.list('downloads').filter((n) => /^(cv-|candidate-)/.test(n)), []);
    const res = resultsOf(w);
    assert.equal(res.cvRejected, 0);
    assert.ok(res.cvScreen && res.cvScreen.screened >= 5, JSON.stringify(res.cvScreen));
    assert.equal(res.cvScreen.mode, 'shadow');
    assert.ok(!res.candidates.some((r) => r.status === 'cv_rejected'));
  });

  await t.test('the reviewers asked Jev (and only Jev) and read the AI key from the profile .env under the scrubbed environment', () => {
    const stats = w.svc.gateway.stats();
    assert.equal(stats.calls[CHAT] || 0, 0, 'no language model');
    const cv = stats.requests.filter(isCvRequest);
    assert.ok(cv.length >= 6, `${cv.length} CV requests of ${stats.calls[JEV]}`);
    for (const r of stats.requests) assert.equal(r.model, 'typesafe-ai/jev');
  });

  await t.test('shadow/cv-<date>.jsonl: one private row per screened CV, decisions only, no text', () => {
    const files = cvLogs(w);
    assert.equal(files.length, 1);
    assert.equal(C.modeOf(w.p('shadow', files[0])), 0o600);
    const rows = w.jsonl(`shadow/${files[0]}`);
    assert.equal(rows.length, resultsOf(w).cvScreen.screened);
    for (const r of rows) {
      assert.equal(r.mode, 'shadow');
      assert.equal(r.jobTitle, 'Chef');
      assert.equal(r.lane, 'jev', `${r.candidateId}: decided by Jev, not by a fallback`);
      assert.ok(['approve', 'reject'].includes(r.final));
      assert.equal(typeof r.pReject, 'number');
    }
    const text = w.text(`shadow/${files[0]}`);
    for (const c of D.CANDIDATES) {
      const m = C.markers(c.n);
      for (const kind of ['name', 'surname', 'email', 'phone', 'cv', 'snippet']) assert.ok(!text.includes(m[kind]), `the CV log holds no ${kind} of #${c.n}`);
      assert.ok(!text.includes(`Fake Kitchen ${c.n} Ltd`), 'no employer');
    }
    assert.ok(!text.includes(D.SECRETS.aiKey));
  });

  await t.test('the caches hold numbers only and nothing personal or secret is on disk outside its home; no alert', () => {
    assert.deepEqual(w.netBlocked(), []);
    assert.deepEqual(C.secretHits(w), []);
    const hits = C.personHits(w, personAllowed);
    assert.deepEqual(hits, [], C.fmtHits(hits));
    assert.deepEqual(C.strayFiles(w), []);
    assert.equal(C.modeOf(w.p('state', 'cv-answers.jsonl')), 0o600);
    assert.deepEqual(w.alerts().filter((a) => a.severity !== 'info'), []);
  });
});

test('14b CV_SCREEN=on: a retail history is not pushed, its files are deleted and the rejection is recorded for the job title', async (t) => {
  const w = new World('s14b-cv-on');
  await w.create({ engine: null });
  t.after(() => w.close());
  w.writeEnv({ CV_SCREEN: 'on' });
  w.setWorld(Object.assign({ credentials: { username: D.SECRETS.catererUser, password: D.SECRETS.catererPass } }, D.siteWorld(D.CANDIDATES, { cvTitles: { 7: 'Retail Assistant' } })));
  await drain(w);

  await t.test('four records in Zoho; candidate 71000007 was screened out after the unlock and never pushed', () => {
    const byKey = new Map([...w.svc.zoho.state.records.values()].map((r) => [r.key, r]));
    assert.equal(w.svc.zoho.created().length, 4);
    assert.equal(byKey.get('71000007'), undefined);
    for (const id of ['71000001', '71000005', '71000009', '71000011']) assert.ok(byKey.get(id), `${id} was pushed`);
    const res = resultsOf(w);
    assert.equal(res.cvRejected, 1);
    const row = res.candidates.find((r) => r.id === '71000007');
    assert.equal(row.status, 'cv_rejected');
    assert.equal(row.cvAttached, false);
    assert.ok(row.reasonCodes.length > 0);
  });

  await t.test('the rejection is in candidates.db for this job title only, with its origin, and the files are gone', () => {
    const rows = w.dbAll("select job_title, origin from candidate_rejections where caterer_id = 71000007 order by id");
    assert.deepEqual(rows.map((r) => r.job_title), ['Kitchen Porter', 'Chef']);
    assert.match(rows[1].origin, /^cv:/);
    assert.deepEqual(w.list('downloads').filter((n) => /^(cv-|candidate-)/.test(n)), []);
    assert.deepEqual(C.strayFiles(w), []);
  });

  await t.test('the shadow log says reject for that one CV and pass for the others; nothing personal was logged', () => {
    const rows = w.jsonl(`shadow/${cvLogs(w)[0]}`);
    const by = new Map(rows.map((r) => [String(r.candidateId), r]));
    assert.equal(by.get('71000007').final, 'reject');
    assert.equal(by.get('71000007').mode, 'on');
    for (const id of ['71000001', '71000005', '71000009', '71000011']) assert.equal(by.get(id).final, 'approve', id);
    const hits = C.personHits(w, personAllowed);
    assert.deepEqual(hits, [], C.fmtHits(hits));
    assert.deepEqual(C.secretHits(w), []);
    assert.deepEqual(w.alerts().filter((a) => a.severity !== 'info'), []);
  });
});

test('14c CV_SCREEN=off: the stage does nothing at all', async (t) => {
  const w = new World('s14c-cv-off');
  await w.create({ engine: null });
  t.after(() => w.close());
  w.writeEnv({ CV_SCREEN: 'off' });
  await drain(w);
  assert.equal(w.svc.zoho.created().length, 5);
  assert.equal(w.svc.gateway.stats().requests.filter(isCvRequest).length, 0, 'no CV question reached Jev');
  assert.deepEqual(cvLogs(w), []);
  assert.deepEqual(w.list('state').filter((n) => /^cv-/.test(n)), []);
  const res = resultsOf(w);
  assert.ok(!('cvScreen' in res) && !('cvRejected' in res), 'the results file carries no CV screening key');
  assert.deepEqual(w.alerts().filter((a) => a.severity !== 'info'), []);
});
