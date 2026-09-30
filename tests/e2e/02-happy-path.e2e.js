'use strict';
// SCENARIO 2 - happy path: a pending search is drained by ticks; phase 1 scrapes three pages, dedupes against the
// restored database, screens with the default engine (jev_shadow), unlocks, downloads CVs; Phase 2 pushes to the
// fake Zoho with the CV attached and deletes the CVs and candidate JSON; every status file and the alert delivery agree.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { World, londonInstantAt } = require('./lib/world');
const D = require('./lib/data');
const C = require('./lib/checks');
const U = require('./lib/util');

const w = new World('s2-happy');
let ticks = [];
let pendingName;

test.before(async () => {
  await w.create({});
  w.svc.zoho.state.dupKeys.add('71000010');
});
test.after(async () => { await w.close(); });

test('2.1 a dashboard-style pending file is drained by ticks; the ticks say nothing', async () => {
  pendingName = w.dropPending({});
  assert.deepEqual(w.pendingFiles(), [pendingName]);
  ticks = await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json'), { maxTicks: 12, tickMin: 1 });
  for (const t of ticks) assert.deepEqual([t.code, t.stdout, t.stderr], [0, '', ''], t.stdout + t.stderr);
  assert.deepEqual(w.pendingFiles(), [], 'the pending file was consumed');
});

test('2.2 exactly one run, exit 0, with the numbers the fake world was built to produce', () => {
  const events = w.jsonl('logs/watchdog-runner.jsonl').map((e) => e.event);
  assert.equal(events.filter((e) => e === 'picked').length, 1);
  assert.equal(events.filter((e) => e === 'done').length, 1);
  assert.ok(events.indexOf('browser-lock') < events.indexOf('phase1-start'), 'the browser lock is taken before phase 1');
  const last = w.lastRun();
  assert.equal(last.exitCode, 0);
  assert.equal(last.phase1Code, 0);
  assert.equal(last.pool, 11);
  assert.equal(last.approved, 6);
  assert.equal(last.skippedDb, 2);
  assert.equal(last.errors, 0);
  assert.ok(!w.exists('runtime/run.json'), 'the run record is released');
  const st = w.json('runtime/watchdog-state.json');
  assert.equal(st.handledRunNonce, last.nonce);
  assert.equal(st.consecutiveFailures, 0);
  assert.equal(st.recentRuns.length, 1);
  assert.ok(w.exists('runtime/tick.heartbeat'));
  assert.equal(w.json('runtime/caterer-status.json').state, 'ok');
  const log = w.text('logs/phase1-console-' + w.list('logs', /^phase1-console-/)[0].slice(15));
  assert.match(log, /Cards on page 1 : 4/);
  assert.match(log, /Cards on page 2 : 4/);
  assert.match(log, /Cards on page 3 : 3/);
  assert.match(log, /Cards on page 4 : 0/);
  assert.match(log, /SKIP \(in DB\)/);
  assert.match(log, /REJECTED post-unlock AI/);
  assert.match(log, /CV attached OK/);
});

test('2.3 screening ran with the default engine: the LLM decided, Jev answered in parallel and was only logged to shadow/', () => {
  const calls = w.svc.gateway.stats().calls;
  assert.ok(calls['POST /v1/chat/completions'] >= 9, JSON.stringify(calls));
  assert.ok(calls['POST /typesafe/v1/systemone'] >= 9, JSON.stringify(calls));
  const shadowFiles = w.list('shadow', /^screening-\d{4}-\d{2}-\d{2}\.jsonl$/);
  assert.equal(shadowFiles.length, 1);
  const rows = w.jsonl(`shadow/${shadowFiles[0]}`);
  assert.ok(rows.length >= 9);
  for (const r of rows) {
    assert.equal(r.mode, 'jev_shadow');
    assert.equal(r.used.engine, 'llm', 'in shadow mode the LLM is the decider');
    assert.ok(r.jev && r.jev.status, 'a Jev answer is logged next to the decision');
    assert.equal(r.redacted, true);
  }
  const text = fs.readFileSync(w.p('shadow', shadowFiles[0]), 'utf8');
  for (const c of D.CANDIDATES) {
    const m = C.markers(c.n);
    for (const kind of ['name', 'surname', 'email', 'phone']) assert.ok(!text.includes(m[kind]), `shadow log holds no ${kind} of #${c.n}`);
    assert.ok(!text.includes(D.SECRETS.aiKey));
  }
  assert.ok(!/[A-Z]{1,2}\d{1,2} \d[A-Z]{2}/.test(text), 'postcodes are redacted in the shadow log');
  const queue = w.json(`downloads/${w.list('downloads', /^approved-queue-/)[0]}`);
  assert.equal(queue.screeningModel, 'anthropic/claude-sonnet-5.5');
});

test('2.4 the database: new candidates unlocked and stamped with their Zoho id, rejections scoped to the job title, run_results row, territory', () => {
  const rows = new Map(w.dbAll('select * from candidates where caterer_id between 71000000 and 71999999').map((r) => [r.caterer_id, r]));
  for (const id of [71000001, 71000005, 71000007, 71000009, 71000010, 71000011]) {
    assert.equal(rows.get(id).unlocked, 1, `${id} unlocked`);
    assert.ok(rows.get(id).zoho_id, `${id} has a Zoho id`);
    assert.ok(rows.get(id).zoho_pushed_at, `${id} push time stamped by the trigger`);
  }
  assert.equal(rows.get(71000008).unlocked, 1, 'the post-unlock reject spent its credit');
  assert.equal(rows.get(71000008).zoho_id, null);
  assert.equal(rows.get(71000003).zoho_id, 'ZLEG-INDB', 'the candidate that was already there is untouched');
  for (const id of [71000002, 71000006]) assert.equal(rows.get(id).unlocked, 0, `${id} rejected before unlock`);
  const rej = w.dbAll('select caterer_id, job_title from candidate_rejections where caterer_id between 71000000 and 71999999').map((r) => `${r.caterer_id}|${r.job_title}`).sort();
  assert.deepEqual(rej, ['71000002|Chef', '71000004|Chef', '71000006|Chef', '71000007|Kitchen Porter']);

  const rr = w.dbAll('select * from run_results');
  assert.equal(rr.length, 1);
  const r = rr[0];
  assert.deepEqual(
    [r.job_title, r.location, r.distance, r.sources, r.pool, r.downloaded, r.new_to_zoho, r.duplicates, r.errors, r.approved_p1, r.skipped_db, r.skipped_review, r.pages_scraped],
    ['Chef', 'LS29', 20, 'caterer', 11, 6, 5, 1, 0, 6, 2, 3, 4],
  );
  assert.equal(r.screening_model, 'anthropic/claude-sonnet-5.5');
  assert.equal(r.credits_remaining, 44463);
  const t = w.dbAll("select * from territory_searches where location = 'LS29'")[0];
  assert.equal(t.candidate_count, 11);
  assert.equal(t.new_to_zoho, 5);
  assert.equal(t.duplicates, 1);
  assert.ok(t.last_searched);
  assert.ok(t.next_run_date > new Date().toISOString().slice(0, 10));
});

test('2.5 Zoho got five new records with their CVs attached, one duplicate was recognised and not touched', () => {
  const z = w.svc.zoho;
  assert.deepEqual(z.counts(), { token: 1, create: 6, attach: 5, get: 1, update: 1 });
  assert.equal(z.created().length, 5);
  const byKey = new Map([...z.state.records.values()].map((r) => [r.key, r]));
  const c1 = byKey.get('71000001');
  assert.equal(c1.payload.First_Name, D.person(1).first);
  assert.equal(c1.payload.Email, D.person(1).email);
  assert.equal(c1.payload.City, 'Leeds');
  assert.equal(c1.payload.Zip_Code, 'LS29 8AA');
  assert.equal(c1.payload.Source, 'Caterer');
  assert.equal(c1.payload.Search_Criteria, 'Chef | LS29 | 20mi');
  assert.equal(c1.attachments.length, 1);
  assert.equal(c1.attachments[0].head, '%PDF-1.4');
  assert.equal(c1.attachments[0].filename, 'cv-71000001.pdf');
  assert.equal(byKey.get('71000005').attachments[0].filename, 'cv-71000005.docx');
  assert.equal(byKey.get('71000005').attachments[0].head.slice(0, 2), 'PK');
  assert.equal(byKey.get('71000011').payload.Mobile, D.person(11).phone, 'the phone the unlock did not have was recovered from the PDF text');
  assert.equal(byKey.get('71000010').attachments.length, 0, 'a duplicate gets no second CV');
  assert.equal(byKey.get('71000008'), undefined, 'the post-unlock reject was never pushed');
  assert.equal(byKey.get('71000002'), undefined);
});

test('2.6 CVs and candidate JSON are gone; queue and result files remain for the sweep; nothing else is left behind', () => {
  const names = w.list('downloads');
  assert.deepEqual(names.filter((n) => /^(cv-|candidate-)/.test(n)), []);
  assert.equal(names.filter((n) => /^approved-queue-.*\.json$/.test(n)).length, 1);
  assert.equal(names.filter((n) => /^phase2-results-.*\.json$/.test(n)).length, 1);
  assert.deepEqual(C.strayFiles(w), []);
  assert.deepEqual(w.list('runtime').filter((n) => /screening-input/.test(n)), []);
  const p1 = w.json(`runs/${w.list('runs', /^phase1-/)[0]}`);
  assert.equal(p1.status, 'complete');
  assert.equal(p1.phase2Complete, true);
  const run = w.json(`runs/${w.list('runs', /^run-/)[0]}`);
  assert.equal(run.status, 'complete');
  assert.equal(run.phase2.pushed, 5);
  assert.equal(w.json('credits-sync.json').credits, 44463);
});

test('2.7 the alert outbox is coherent: a healthy run raises nothing, and delivery at 18:30 prints a digest that matches run_results', async () => {
  const bad = w.alerts().filter((a) => a.severity !== 'info');
  assert.deepEqual(bad, [], JSON.stringify(bad));
  const at = londonInstantAt(18, 30);
  const r = await w.cron('resourcer-alerts', { env: { RESOURCER_TEST_NOW: at } });
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /^Resourcer daily digest \d{4}-\d{2}-\d{2}$/);
  assert.ok(lines.some((l) => /^\[INFO \d\d:\d\d\] Resourcer alive .*queue 0, not halted/.test(l)), r.stdout);
  const londonDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  if (londonDay === new Date().toISOString().slice(0, 10)) {
    assert.ok(lines.some((l) => /CVs pulled today: 5 of 181 target/.test(l)), r.stdout);
    assert.ok(lines.some((l) => /Runs today 1: unlocked 6, duplicates 1, skipped 0, errors 0\./.test(l)), r.stdout);
    assert.ok(lines.some((l) => /New in Zoho by source: Caterer 5, Reed 0/.test(l)), r.stdout);
  }
  assert.ok(lines.some((l) => /Halts today: none/.test(l)));
  assert.ok(lines.some((l) => /Caterer credits: 44,463 remaining/.test(l)));
  const again = await w.cron('resourcer-alerts', { env: { RESOURCER_TEST_NOW: at } });
  assert.equal(again.stdout, '', 'the digest and the alive line are once a day');
});

test('2.8 nothing reached the internet, no secret leaked, personal data sits only in the queue and result files that the sweep removes', () => {
  assert.deepEqual(w.netBlocked(), []);
  assert.deepEqual(C.secretHits(w), []);
  const hits = C.personHits(w, [
    { re: /workspace\/resourcer\/downloads\/approved-queue-[^/]*\.json$/, kinds: ['name', 'surname', 'email', 'phone'] },
    { re: /workspace\/resourcer\/downloads\/phase2-results-[^/]*\.json$/, kinds: ['name', 'surname'] },
    // DESIGN D3: the redacted snippet body is kept for calibration in shadow/ (180 days) and nowhere else
    { re: /workspace\/resourcer\/shadow\/screening-[^/]*\.jsonl$/, kinds: ['snippet'] },
  ]);
  assert.deepEqual(hits, [], C.fmtHits(hits));
  assert.equal(C.modeOf(w.p('downloads', w.list('downloads', /^approved-queue-/)[0])), 0o600, 'the queue holds personal data: owner only');
});
