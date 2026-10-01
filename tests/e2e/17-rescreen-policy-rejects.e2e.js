'use strict';
// SCENARIO 17 - the re-screen of the pre-unlock rejections that Update A's review policy made because Jev was uncertain (tools/rescreen-policy-rejects.js,
// docs/RESCREEN.md), through the WHOLE pipeline on the default engine (jev_only), fake gateway and fake Caterer site:
//   shadow rows of the Update A engine (built from its real code, tests/rescreen/fixtures) + the rejections they made  ->  dry run (counts, no names)  ->
//   --apply (refusals, verified backup, ledger, one transaction)  ->  --queue  ->  the NEXT run (cron wrapper, scrubbed environment) screens the cleared
//   candidates again with the new criteria: some are approved and pushed, one is rejected afresh, an injection card and a CV rejection are never screened,
//   the territory keeps its regular next date  ->  --undo puts exactly the deleted rows back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { World, REPO, NODE } = require('./lib/world');
const D = require('./lib/data');
const C = require('./lib/checks');
const H = require('../rescreen/helpers');

const TOOL = path.join(REPO, 'tools', 'rescreen-policy-rejects.js');
const london = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const utcDay = (d) => d.toISOString().slice(0, 10);

function writable(w) {
  const Database = require(path.join(w.home, 'node_modules', 'better-sqlite3'));
  return (fn) => { const db = new Database(w.p('candidates.db')); try { return fn(db); } finally { db.close(); } };
}

test('17 re-screen: old-shape shadow rows and their rejections -> dry run -> apply -> queue -> the next run screens the cleared candidates -> undo', async (t) => {
  const w = new World('s17-rescreen');
  await w.create({ engine: null, legacy: { mainSources: 'caterer' } });
  t.after(() => w.close());
  w.warmLoggedIn();
  w.svc.zoho.state.dupKeys.add('71000010');
  const rw = writable(w);

  // ---- the state Update A left behind (rows of its real engine; rejections as phase 1 booked them) ----
  const now = new Date();
  const decided = new Date(now.getTime() - 3 * 3600 * 1000).toISOString();
  const today = utcDay(now);
  const since = utcDay(new Date(now.getTime() - 86400000));
  const runId = 'phase1-fixture-17';
  const person = (id) => D.person(D.CANDIDATES.find((c) => c.id === id).n);
  const shadowRow = (label, id) => {
    const p = person(id);
    return H.row('update-a', label, { candidateId: String(id), ts: decided, runId, jobTitle: 'Chef', input: `${p.first} ${p.last} ${p.email} ${p.phone} ${p.snippetMarker}` });
  };
  const rows = [
    shadowRow('uncertain_ambiguous', 71000001), // would be approved by the new criteria
    shadowRow('uncertain_x', 71000005), // would be approved
    shadowRow('uncertain_ambiguous', 71000002), // Jev rejects it for real now ([[REJECT]])
    shadowRow('injection_keyword', 71000009), // an instruction to the reader: never touched
    shadowRow('uncertain_ambiguous', 71000006), // uncertain, but the stored rejection is a CV-screening one: never touched
  ];
  fs.mkdirSync(w.p('shadow'), { recursive: true });
  const shadowFile = w.p('shadow', `screening-${london(new Date(decided))}.jsonl`);
  fs.writeFileSync(shadowFile, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(shadowFile, 0o600);
  rw((db) => {
    const ins = db.prepare("INSERT INTO candidate_rejections (caterer_id, job_title, rejected_at, origin) VALUES (?, 'Chef', ?, ?)");
    for (const id of [71000001, 71000005, 71000002, 71000009]) ins.run(id, today, 'pipeline');
    ins.run(71000006, today, 'cv:no_relevant_experience');
    db.prepare("INSERT INTO run_results (run_key, date, started_at, completed_at, phase1_started_at, job_title, location, distance, keywords, sources) VALUES ('fixture-17', ?, ?, ?, ?, 'Chef', 'LS29', 20, '', 'caterer')").run(today, decided, decided, decided);
  });
  fs.mkdirSync(w.p('runs'), { recursive: true });
  fs.writeFileSync(w.p('runs', `phase1-${runId.replace(/^phase1-/, '')}.json`), JSON.stringify({ id: runId, status: 'complete', phase2Status: 'done', jobTitle: 'Chef', location: 'LS29', distance: 20, sources: 'caterer', startedAt: decided }));
  const territory = () => w.dbAll("select next_run_date, last_searched, priority from territory_searches where job_title = 'Chef' and location = 'LS29'")[0];
  const regularNext = territory().next_run_date;
  assert.equal(regularNext, '2030-01-01');
  const rejections = () => w.dbAll('select * from candidate_rejections order by id');
  const rejBefore = rejections();
  const candBefore = w.dbAll('select * from candidates order by id');

  const cli = (args, opts) => {
    const r = spawnSync(NODE, [TOOL, '--home', w.home, ...args], {
      cwd: REPO, encoding: 'utf8', timeout: 180000,
      env: Object.assign(w.toolEnv({ BACKUP_PASSPHRASE: D.SECRETS.backupPassphrase, RESOURCER_ENV_FILE: path.join(w.profile, '.env') }), (opts && opts.env) || {}),
    });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '', all: `${r.stdout}\n${r.stderr}` };
  };
  const ledgers = () => w.list('runtime', /^rescreen-ledger-.*\.jsonl$/);
  const noPeople = (text, what) => {
    for (const c of D.CANDIDATES) {
      const m = C.markers(c.n);
      for (const kind of ['name', 'surname', 'email', 'phone', 'snippet']) assert.ok(!text.includes(m[kind]), `${what} holds the ${kind} of #${c.n}`);
    }
  };

  await t.test('the dry run counts the three re-screenable rejections by source, day and territory, names nobody, and writes nothing', () => {
    const r = cli(['--since', since]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /cards the review policy rejected before the unlock because Jev was uncertain \(distinct candidate and job title\): 4/);
    assert.match(r.out, /rows that --apply would delete: 3 {3}\(--apply --confirm 3\)/);
    assert.match(r.out, /caterer: 3 candidates, 3 rows/);
    assert.match(r.out, /Chef LS29: 3/);
    assert.match(r.out, /policy_injection_reject 1/);
    assert.match(r.out, /cv_rejection: blocked by a CV-screening rejection/);
    noPeople(r.all, 'the dry run output');
    for (const id of ['71000001', '71000005', '71000002', '71000009', '71000006']) assert.ok(!r.all.includes(id), `the dry run names candidate ${id}`);
    assert.deepEqual(rejections(), rejBefore);
    assert.deepEqual(w.list('runtime', /^rescreen-/), []);
    assert.deepEqual(w.list('backups', /\.db\.gz\.enc$/), []);
  });

  await t.test('--apply refuses a wrong number and a run in flight (the real predicate of pipeline-watchdog.js --status) and writes nothing, not even a backup', () => {
    const wrong = cli(['--since', since, '--apply', '--confirm', '4']);
    assert.equal(wrong.code, 3);
    assert.match(wrong.out, /does not equal the dry-run row count 3/);
    assert.deepEqual(rejections(), rejBefore);
    assert.deepEqual(w.list('backups', /\.db\.gz\.enc$/), []);
    // a run-lock held by a live process: the same predicate as pipeline-watchdog.js --status
    const sleeper = require('child_process').spawn('sleep', ['30'], { stdio: 'ignore' });
    fs.writeFileSync(w.p('runs', 'phase1-9999-12-31-2359.run-lock'), JSON.stringify({ pid: sleeper.pid, startedAt: Date.now() - 1000 }));
    const busy = cli(['--since', since, '--apply', '--confirm', '3']);
    sleeper.kill('SIGKILL');
    fs.unlinkSync(w.p('runs', 'phase1-9999-12-31-2359.run-lock'));
    assert.equal(busy.code, 3);
    assert.match(busy.out, /a pipeline run is in flight/);
    assert.deepEqual(rejections(), rejBefore);
    assert.deepEqual(w.list('backups', /\.db\.gz\.enc$/), [], 'refused before any backup');
  });

  let ledgerName;
  await t.test('--apply: a verified backup first, the ledger second (mode 0600), then exactly the three rows go in one transaction; the candidates table is untouched', () => {
    const r = cli(['--since', since, '--apply', '--confirm', '3']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /backup candidates-\d{8}-\d{6}\.db\.gz\.enc written and verified: candidate_rejections \d+ rows/);
    assert.match(r.out, /deleted 3 rows in one transaction \(3 candidates\)/);
    noPeople(r.all, 'the apply output');
    const after = rejections();
    assert.deepEqual(rejBefore.filter((x) => !after.some((y) => y.id === x.id)).map((x) => x.caterer_id).sort(), [71000001, 71000002, 71000005]);
    assert.equal(after.length, rejBefore.length - 3);
    assert.ok(after.some((x) => x.caterer_id === 71000009), 'the injection card keeps its rejection');
    assert.ok(after.some((x) => x.caterer_id === 71000006 && /^cv:/.test(x.origin)), 'the CV rejection is never touched');
    assert.ok(after.some((x) => x.caterer_id === 71000004), 'the legacy rejection (no shadow evidence) is never touched');
    assert.deepEqual(w.dbAll('select * from candidates order by id'), candBefore, 'no candidate row, no unlocked flag changed');
    ledgerName = ledgers()[0];
    assert.equal(ledgers().length, 1);
    assert.equal(C.modeOf(w.p('runtime', ledgerName)), 0o600);
    const lines = fs.readFileSync(w.p('runtime', ledgerName), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => l.territory && l.territory.title === 'Chef' && l.territory.location === 'LS29' && l.row.origin === 'pipeline'));
    noPeople(fs.readFileSync(w.p('runtime', ledgerName), 'utf8'), 'the ledger');
    // the backup is a real, independent-verifiable one: the repository's own backup tool opens it and counts the rows it held before the delete
    const bk = w.list('backups', /\.db\.gz\.enc$/);
    assert.equal(bk.length, 1);
    const v = w.node('backup-db.js', ['--verify', w.p('backups', bk[0])]);
    assert.equal(JSON.parse(v.stdout).tables.candidate_rejections, rejBefore.length);
    noPeople(`${bk.join(' ')} ${w.text(`backups/${bk[0].replace(/\.db\.gz\.enc$/, '.json')}`)}`, 'the backup listing');
    // nothing changed in the evidence
    assert.equal(fs.readFileSync(shadowFile, 'utf8'), `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`);
  });

  await t.test('a second apply finds nothing', () => {
    const dry = cli(['--since', since]);
    assert.match(dry.out, /rows that --apply would delete: 0 /);
    const again = cli(['--since', since, '--apply', '--confirm', '0']);
    assert.equal(again.code, 0, again.all);
    assert.match(again.out, /nothing to apply/);
    assert.equal(ledgers().length, 1);
    assert.equal(w.list('backups', /\.db\.gz\.enc$/).length, 1);
  });

  await t.test('--queue writes one unique pending search for the territory (sources as it asks, priority low), idempotently', () => {
    const r = cli(['--queue', '--per-day', '5']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /queued 1: Chef LS29 \(3\)/);
    const files = w.pendingFiles();
    assert.equal(files.length, 1);
    assert.match(files[0], /^zz-rescreen-\d+-[0-9a-f]{8}\.json$/);
    const p = w.json(`pending-searches/${files[0]}`);
    assert.deepEqual([p.jobTitle, p.location, p.sources, p.priority, p.distance], ['Chef', 'LS29', 'caterer', 'low', 20]);
    assert.equal(p.spawnedAt, undefined);
    noPeople(JSON.stringify(p), 'the pending search');
    const again = cli(['--queue', '--per-day', '5']);
    assert.equal(again.code, 0);
    assert.equal(w.pendingFiles().length, 1, 'nothing is queued twice');
  });

  await t.test('the next run (the cron wrapper) screens the cleared candidates again: two are approved and pushed, one is rejected afresh, the injection card and the CV rejection are never screened, the regular next date is untouched', async () => {
    w.svc.gateway.setMode({ llm: 'restricted' });
    const calls0 = w.svc.gateway.stats().calls['POST /typesafe/v1/systemone'] || 0;
    await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json') && w.pipelineProcs().length === 0, { maxTicks: 14, tickMin: 1, gapMs: 1500 });
    assert.equal(w.lastRun().exitCode, 0);
    const pushed = [...w.svc.zoho.state.records.values()].filter((r) => r.attachments.length).map((r) => r.key).sort();
    assert.ok(pushed.includes('71000001') && pushed.includes('71000005'), `the cleared candidates were approved and pushed: ${pushed}`);
    assert.ok(!pushed.includes('71000002') && !pushed.includes('71000009') && !pushed.includes('71000006') && !pushed.includes('71000004'));
    // the run's own shadow rows (the current engine): the cleared cards were screened, the protected ones never were
    const today0 = w.list('shadow', /^screening-.*\.jsonl$/).flatMap((f) => w.jsonl(`shadow/${f}`)).filter((r) => r.runId !== runId && r.ts > decided);
    const screened = new Set(today0.filter((r) => r.stage === 'pre_unlock').map((r) => r.candidateId));
    for (const id of ['71000001', '71000005', '71000002']) assert.ok(screened.has(id), `${id} was screened again`);
    for (const id of ['71000009', '71000006', '71000004', '71000003']) assert.ok(!screened.has(id), `${id} must not be screened`);
    assert.ok(today0.filter((r) => ['71000001', '71000005', '71000002'].includes(r.candidateId) && r.stage === 'pre_unlock').every((r) => r.used.engine === 'jev'), 'Jev decided them, no policy');
    assert.ok((w.svc.gateway.stats().calls['POST /typesafe/v1/systemone'] || 0) > calls0);
    assert.equal(w.svc.gateway.stats().calls['POST /v1/chat/completions'] || 0, 0, 'no language model');
    // 71000002: rejected afresh by the new criteria (a new row, same title, origin pipeline), so it is not lost and not screened a third time
    const rej2 = rejections().filter((x) => x.caterer_id === 71000002);
    assert.equal(rej2.length, 1);
    assert.equal(rej2[0].origin, 'pipeline');
    assert.ok(rejBefore.every((x) => x.caterer_id !== 71000002 || x.id !== rej2[0].id), 'a new row, not the old one');
    // the territory: searched today, the regular next date untouched (a run ahead of its slot does not roll it a whole interval)
    const tr = territory();
    assert.equal(tr.next_run_date, regularNext);
    assert.notEqual(tr.last_searched, '2026-08-20');
    assert.deepEqual(w.pendingFiles(), []);
    assert.deepEqual(w.alerts().filter((a) => a.severity !== 'info'), []);
    assert.deepEqual(w.netBlocked(), []);
    assert.deepEqual(C.secretHits(w), []);
  });

  await t.test('--queue again finds the territory already run since the apply and queues nothing', () => {
    const r = cli(['--queue', '--per-day', '5']);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /ran_since_apply 1/);
    assert.deepEqual(w.pendingFiles(), []);
  });

  await t.test('the once-only guard (the loop): the cleared candidates had their second look, so they are never cleared again, with the second look in the shadow log or with it LOST', () => {
    // 1. the real second look is in the shadow log (the run just made it): the guard is the first reason
    const withLook = cli(['--since', since]);
    assert.equal(withLook.code, 0, withLook.all);
    assert.match(withLook.out, /rows that --apply would delete: 0 /);
    assert.match(withLook.out, /once-only guard: 1 ledger in runtime\/: 1 took effect \(0 of them undone: only the rows put back are released\), 0 never took effect; 3 candidate and job title pairs are never cleared again/);
    assert.match(withLook.out, /left out: .*cleared_before 3/);
    // 2. the second look is LOST (shadow logging was off, the file was pruned, a cache hit wrote no row): only the old policy rows remain.
    //    71000002 now has a NEW pipeline rejection of the same title (Jev rejected it again) and an old policy row: the loop the owner forbade.
    const full = fs.readFileSync(shadowFile, 'utf8');
    fs.writeFileSync(shadowFile, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 });
    const lost = cli(['--since', since]);
    assert.equal(lost.code, 0, lost.all);
    assert.match(lost.out, /rows that --apply would delete: 0 /);
    assert.match(lost.out, /left out: .*cleared_before 3/);
    const rejNow = rejections();
    const refused = cli(['--since', since, '--apply', '--confirm', '1']);
    assert.equal(refused.code, 3);
    assert.match(refused.out, /does not equal the dry-run row count 0/);
    assert.deepEqual(rejections(), rejNow, 'nothing was deleted');
    assert.equal(ledgers().length, 1, 'no second ledger');
    // a ledger that cannot be read: the dry run warns, the apply refuses
    const damaged = w.p('runtime', 'rescreen-ledger-20260101T000000Z.jsonl');
    fs.writeFileSync(damaged, 'not json\n');
    const warn = cli(['--since', since]);
    assert.equal(warn.code, 0);
    assert.match(warn.out, /WARNING: ledger rescreen-ledger-20260101T000000Z\.jsonl 1 line\(s\) cannot be read/);
    const stop = cli(['--since', since, '--apply', '--confirm', '0']);
    assert.equal(stop.code, 3);
    assert.match(stop.out, /NOT APPLIED \(nothing was written\): the once-only guard cannot read rescreen-ledger-20260101T000000Z\.jsonl/);
    fs.unlinkSync(damaged);
    assert.equal(cli(['--since', since]).code, 0);
    fs.writeFileSync(shadowFile, full, { mode: 0o600 }); // the evidence as the run left it
    noPeople(withLook.all + lost.all + warn.all + stop.all, 'the guard output');
  });

  await t.test('--undo puts back exactly the rows that were deleted, leaves alone the one the run re-booked, is idempotent, and takes a backup first', () => {
    const rejNow = rejections();
    const r = cli(['--undo', ledgerName]);
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /restored 2, already present 0, left alone because a newer row for the same candidate and job title exists 1; backup candidates-/);
    const after = rejections();
    assert.equal(after.length, rejNow.length + 2);
    for (const old of rejBefore.filter((x) => [71000001, 71000005].includes(x.caterer_id))) assert.deepEqual(after.find((y) => y.id === old.id), old, 'the very same row, id and content');
    assert.equal(after.filter((x) => x.caterer_id === 71000002).length, 1, 'no duplicate for the candidate the run rejected afresh');
    const again = cli(['--undo', ledgerName]);
    assert.equal(again.code, 0);
    assert.match(again.out, /restored 0, already present 2, left alone because a newer row for the same candidate and job title exists 1/);
    assert.equal(rejections().length, after.length);
    assert.equal(w.list('backups', /\.db\.gz\.enc$/).length, 2);
    noPeople(r.all + again.all, 'the undo output');
    // the once-only guard after the undo: the two rows that were put back are released (the guard no longer names them; the real run unlocked them, so the older
    // exclusion unlocked now holds them back), the one candidate whose second look the undo found (a newer rejection) stays covered
    assert.match(r.out, /once-only guard released 2 lines, 1 stay covered/);
    assert.equal(w.list('runtime', /^rescreen-undone-.*\.json$/).length, 1);
    const full = fs.readFileSync(shadowFile, 'utf8');
    fs.writeFileSync(shadowFile, `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`, { mode: 0o600 });
    const released = cli(['--since', since]);
    fs.writeFileSync(shadowFile, full, { mode: 0o600 });
    assert.equal(released.code, 0, released.all);
    assert.match(released.out, /rows that --apply would delete: 0 /);
    assert.match(released.out, /left out: cleared_before 1, cv_rejection 1, unlocked 2/);
    noPeople(released.all, 'the dry run after the undo');
    assert.deepEqual(w.lockProblems(), []);
  });
});
