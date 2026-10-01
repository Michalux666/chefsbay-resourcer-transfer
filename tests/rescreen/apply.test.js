'use strict';
// R2 / R6: --apply is safe and atomic (every refusal writes nothing; a verified backup first; one transaction; a ledger first), --undo restores exactly the
// ledger, a second apply finds nothing, a crash between ledger and delete is recoverable, and no output holds personal data.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const { standardWorld, run, json, MARKERS, Database } = H;
const TARGET_IDS = [1001, 1002, 1003, 1032];
const ledgers = (h) => fs.readdirSync(h.p('runtime')).filter((n) => /^rescreen-ledger-.*\.jsonl$/.test(n));
const backups = (h) => (fs.existsSync(h.p('backups')) ? fs.readdirSync(h.p('backups')).filter((n) => n.endsWith('.db.gz.enc')) : []);
const nothingWritten = (h, before) => {
  assert.equal(h.snapshot(), before, 'a refusal changes no table and writes no file');
  assert.deepEqual(ledgers(h), []);
  assert.deepEqual(backups(h), []);
};

test('R2: --apply refuses (exit 3, nothing written) without --confirm, or with a number that is not the dry-run row count', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const before = h.snapshot();
  const none = await run(h, ['--apply']);
  assert.equal(none.code, 3);
  assert.match(none.out, /NOT APPLIED \(nothing was written\): --confirm N is required/);
  nothingWritten(h, before);
  for (const wrong of ['3', '5', '0', '400']) {
    const r = await run(h, ['--apply', '--confirm', wrong]);
    assert.equal(r.code, 3, wrong);
    assert.match(r.out, /does not equal the dry-run row count 4/);
    nothingWritten(h, before);
  }
});

test('R2: a stale number is refused too: the dry run said 4, then the data changed, so --confirm 4 no longer matches', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  h.db((d) => d.prepare("UPDATE candidates SET unlocked = 1 WHERE caterer_id = 1001").run()); // 1001 was unlocked in between
  const before = h.snapshot();
  const r = await run(h, ['--apply', '--confirm', '4']);
  assert.equal(r.code, 3);
  assert.match(r.out, /does not equal the dry-run row count 3/);
  nothingWritten(h, before);
});

test('R2: --apply refuses while a run is in flight, using the real predicate of pipeline-watchdog.js --status (a live run-lock), and while a screening halt is set', async (t) => {
  const h = standardWorld();
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => { child.kill('SIGKILL'); h.cleanup(); });
  const before = h.snapshot();
  fs.writeFileSync(h.p('runs', 'phase1-2026-10-01-1100.run-lock'), JSON.stringify({ pid: child.pid, startedAt: H.NOW.getTime() - 60000 }));
  const lockBefore = h.snapshot();
  const busy = await run(h, ['--apply', '--confirm', '4'], { busy: undefined });
  assert.equal(busy.code, 3);
  assert.match(busy.out, /a pipeline run is in flight/);
  assert.equal(h.snapshot(), lockBefore);
  assert.deepEqual(backups(h), []);
  fs.unlinkSync(h.p('runs', 'phase1-2026-10-01-1100.run-lock'));
  assert.equal(h.snapshot(), before);
  fs.writeFileSync(h.p('runtime', 'pipeline-halt.json'), JSON.stringify({ halted: true, reason: 'screening gateway auth failed', since: '2026-10-01T09:00:00Z' }));
  const haltBefore = h.snapshot();
  const halted = await run(h, ['--apply', '--confirm', '4']);
  assert.equal(halted.code, 3);
  assert.match(halted.out, /the screening halt is set/);
  assert.equal(h.snapshot(), haltBefore);
  assert.deepEqual(backups(h), []);
});

test('R2: a run that starts while the backup is being written is caught by the second check: the backup exists, nothing is deleted, no ledger', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const rejBefore = h.rejections();
  let calls = 0;
  const r = await run(h, ['--apply', '--confirm', '4'], { busy: () => ++calls >= 2 });
  assert.equal(r.code, 3);
  assert.match(r.out, /a pipeline run is in flight/);
  assert.deepEqual(h.rejections(), rejBefore);
  assert.deepEqual(ledgers(h), []);
  assert.equal(backups(h).length, 1);
});

test('R2: --apply refuses above --max-rows (default 400) and works at the limit', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const before = h.snapshot();
  const r = await run(h, ['--apply', '--confirm', '4', '--max-rows', '3']);
  assert.equal(r.code, 3);
  assert.match(r.out, /4 rows is more than --max-rows 3/);
  nothingWritten(h, before);
  const ok = await run(h, ['--apply', '--confirm', '4', '--max-rows', '4']);
  assert.equal(ok.code, 0, ok.err);
});

test('R2: the default --max-rows is 400', async (t) => {
  const h = H.makeHome();
  t.after(() => h.cleanup());
  h.territory('Chef', 'LS29');
  h.run('2026-09-30-1500', 'Chef', 'LS29');
  const rows = [];
  for (let i = 0; i < 401; i += 1) {
    const id = 5000 + i;
    rows.push(H.row('update-a', 'uncertain_ambiguous', { candidateId: String(id), ts: H.T0, runId: 'phase1-2026-09-30-1500', jobTitle: 'Chef' }));
    h.rej(id, 'Chef');
  }
  h.shadow(rows);
  const before = h.snapshot();
  const r = await run(h, ['--apply', '--confirm', '401']);
  assert.equal(r.code, 3);
  assert.match(r.out, /401 rows is more than --max-rows 400/);
  assert.equal(h.snapshot(), before);
});

test('R2: no verified backup, no apply: a missing passphrase, a backup the database changed under, and a backup that cannot be written all refuse with nothing deleted', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const before = h.snapshot();
  const rejBefore = h.rejections();
  const noKey = await run(h, ['--apply', '--confirm', '4'], { backup: { log2n: 12, passphrase: () => null } });
  assert.equal(noKey.code, 3);
  assert.match(noKey.out, /no verified backup could be made, nothing was changed: no backup passphrase/);
  nothingWritten(h, before);

  // the database changes between the snapshot and the comparison: the verified count differs from the live count
  const changed = await run(h, ['--apply', '--confirm', '4'], { hooks: { afterBackup: () => h.rej(2999, 'Chef') } });
  assert.equal(changed.code, 3);
  assert.match(changed.out, /the backup holds \d+ rows of candidate_rejections but the live database \d+: the database changed while it was written, nothing was changed/);
  assert.equal(h.rejections().length, rejBefore.length + 1, 'every row is still there, plus the one the hook added');
  assert.deepEqual(ledgers(h), []);

  // a backup directory that cannot be created
  const h2 = standardWorld();
  t.after(() => h2.cleanup());
  fs.writeFileSync(h2.p('backups'), 'a file where the folder should be');
  const rej2 = h2.rejections();
  const noDir = await run(h2, ['--apply', '--confirm', '4']);
  assert.equal(noDir.code, 3);
  assert.match(noDir.out, /no verified backup could be made/);
  assert.deepEqual(h2.rejections(), rej2);
  assert.deepEqual(ledgers(h2), []);
});

test('R2: the apply: a verified backup first, the ledger second, then ONE transaction deletes exactly the selected rows and nothing else', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const rejBefore = h.rejections();
  const candBefore = h.candidates();
  const countsBefore = h.counts();
  const shadowBefore = fs.readdirSync(h.p('shadow')).map((f) => fs.readFileSync(h.p('shadow', f), 'utf8'));
  const r = await run(h, ['--apply', '--confirm', '4']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`backup candidates-\\d{8}-\\d{6}\\.db\\.gz\\.enc written and verified: candidate_rejections ${rejBefore.length} rows`));
  assert.match(r.out, /ledger runtime\/rescreen-ledger-\d{8}T\d{6}Z\.jsonl written first \(mode 0600\)/);
  assert.match(r.out, /deleted 4 rows in one transaction \(4 candidates\)/);
  assert.match(r.out, /undo: node tools\/rescreen-policy-rejects\.js --undo rescreen-ledger-/);

  // exactly the four rows are gone; every other row is byte for byte what it was
  const rejAfter = h.rejections();
  const gone = rejBefore.filter((x) => !rejAfter.some((y) => y.id === x.id));
  assert.deepEqual(gone.map((x) => x.caterer_id).sort(), TARGET_IDS);
  assert.ok(gone.every((x) => x.origin === 'pipeline'));
  assert.deepEqual(rejAfter, rejBefore.filter((x) => !TARGET_IDS.includes(x.caterer_id)));
  assert.deepEqual(h.candidates(), candBefore, 'the candidates table and every unlocked flag are untouched');
  assert.deepEqual(h.counts(), { ...countsBefore, candidate_rejections: countsBefore.candidate_rejections - 4 });
  assert.deepEqual(fs.readdirSync(h.p('shadow')).map((f) => fs.readFileSync(h.p('shadow', f), 'utf8')), shadowBefore, 'the shadow log is evidence: never changed');
  // another job title, another origin, an unlocked person, the sentinel: all still there
  assert.ok(rejAfter.some((x) => x.caterer_id === 1023 && x.origin.startsWith('cv:')));
  assert.ok(rejAfter.some((x) => x.caterer_id === 1029 && x.job_title === '*'));
  assert.ok(rejAfter.some((x) => x.caterer_id === 1025 && x.job_title === 'Kitchen Porter'));
  assert.ok(rejAfter.some((x) => x.caterer_id === 1011), 'an injection card keeps its rejection');
  assert.ok(rejAfter.some((x) => x.caterer_id === 1013), 'an empty card keeps its rejection');
  assert.ok(rejAfter.some((x) => x.caterer_id === 1014), 'a rejection Jev made itself is kept');
  assert.ok(rejAfter.some((x) => x.caterer_id === 1017), 'a post-unlock row is never touched');
  assert.ok(rejAfter.some((x) => x.caterer_id === 1021 && x.job_title === 'Chef'), 'an unlocked candidate keeps it');

  // the backup holds the rows that were deleted
  const bk = require('../../resourcer/scripts/backup-db');
  const ctx = bk.makeCtx({ home: h.home, notify: () => {}, log: () => {}, log2n: 12 });
  const files = backups(h);
  assert.equal(files.length, 1);
  const out = h.p('restored.db');
  await bk.decryptFile(h.p('backups', files[0]), out, process.env.BACKUP_PASSPHRASE);
  const rdb = new Database(out, { readonly: true });
  assert.equal(rdb.prepare('SELECT COUNT(*) c FROM candidate_rejections').get().c, rejBefore.length);
  assert.equal(rdb.prepare('SELECT COUNT(*) c FROM candidate_rejections WHERE caterer_id IN (1001, 1002, 1003, 1032)').get().c, 4);
  rdb.close();
  assert.ok(ctx);

  // the ledger: mode 0600, one line per deleted row with the full row, no card text
  const l = ledgers(h);
  assert.equal(l.length, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(h.p('runtime', l[0])).mode & 0o777, 0o600);
  const lines = fs.readFileSync(h.p('runtime', l[0]), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  assert.equal(lines.length, 4);
  for (const line of lines) {
    assert.deepEqual(Object.keys(line).sort(), ['applyId', 'at', 'decisionAt', 'jobTitle', 'kind', 'row', 'runId', 'source', 'table', 'territory', 'v']);
    assert.equal(line.table, 'candidate_rejections');
    assert.equal(line.source, 'caterer');
    assert.ok(gone.some((g) => JSON.stringify(g) === JSON.stringify(line.row)), 'the full original row');
    assert.ok(line.territory && line.territory.title && line.territory.location);
  }
  const text = fs.readFileSync(h.p('runtime', l[0]), 'utf8');
  for (const m of MARKERS) assert.ok(!text.includes(m), `the ledger holds ${m}`);
  for (const m of MARKERS) assert.ok(!r.all.includes(m), `the output holds ${m}`);
  for (const id of ['1001', '1002', '1003', '1032']) assert.ok(!new RegExp(`\\b${id}\\b`).test(r.all), `the output names candidate ${id}`);
});

test('R2: a second apply finds nothing (idempotent): the dry run says 0, --confirm 0 changes nothing, and no second ledger or backup is written', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  assert.equal((await run(h, ['--apply', '--confirm', '4'])).code, 0);
  const after = h.snapshot();
  const files = [ledgers(h).length, backups(h).length];
  const dry = await json(h, []);
  assert.equal(dry.j.dryRun.eligible.rowsToDelete, 0);
  assert.equal(dry.j.dryRun.excluded.already_cleared, 4, 'the four cleared cards are recognised by the ledger');
  assert.equal(dry.j.dryRun.excluded.no_stored_rejection, 2, 'the two cards that never had a stored rejection');
  const again = await run(h, ['--apply', '--confirm', '0']);
  assert.equal(again.code, 0);
  assert.match(again.out, /nothing to apply: no row matches/);
  const stale = await run(h, ['--apply', '--confirm', '4']);
  assert.equal(stale.code, 3, 'the old number is refused');
  assert.equal(h.snapshot(), after);
  assert.deepEqual([ledgers(h).length, backups(h).length], files);
});

test('R2: atomicity: a failure in the middle of the deletes rolls everything back, nothing is deleted, the ledger that was written first is tolerated by --undo', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const dump = () => JSON.stringify([h.rejections(), h.candidates()]);
  const before = dump();
  const r = await run(h, ['--apply', '--confirm', '4'], { hooks: { afterDelete: (n) => { if (n === 2) throw new Error('injected failure'); } } });
  assert.equal(r.code, 4);
  assert.match(r.err, /the transaction failed and was rolled back, nothing was deleted \(ledger rescreen-ledger-\S+ lists what may have been deleted/);
  assert.equal(dump(), before, 'all four rows are still there');
  assert.equal(ledgers(h).length, 1, 'the ledger was written first');
  assert.equal(h.rejections().length, JSON.parse(before)[0].length);
  // the crash-recovery rule: --undo of a ledger whose rows are all still present is a no-op, not an error
  const undo = await run(h, ['--undo', ledgers(h)[0]]);
  assert.equal(undo.code, 0, undo.out + undo.err);
  assert.match(undo.out, /restored 0, already present 4/);
  assert.equal(dump(), before);
  // and a retry afterwards works
  const retry = await run(h, ['--apply', '--confirm', '4']);
  assert.equal(retry.code, 0, retry.err);
  assert.equal(h.rejections().length, JSON.parse(before)[0].length - 4);
});

test('R2: a failure while the transaction commits the ledger or rejects a row that changed under it deletes nothing', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const before = JSON.stringify(h.rejections());
  // a row that is no longer exactly the one the plan holds (another process changed it between the plan and the transaction)
  const r = await run(h, ['--apply', '--confirm', '4'], { hooks: { afterBackup: () => h.db((d) => d.prepare("UPDATE candidate_rejections SET rejected_at = '2026-10-01' WHERE caterer_id = 1001").run()) } });
  assert.equal(r.code, 3);
  assert.match(r.out, /the database changed since the dry run, nothing was changed/);
  assert.equal(h.rejections().filter((x) => x.caterer_id === 1001).length, 1);
  assert.notEqual(JSON.stringify(h.rejections()), before, 'only the changed date differs');
  assert.equal(h.rejections().length, JSON.parse(before).length);
});

test('R2 undo: the round trip restores exactly the deleted rows (same ids, same content), is idempotent, and takes a backup first', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const rejBefore = h.rejections();
  assert.equal((await run(h, ['--apply', '--confirm', '4'])).code, 0);
  const ledger = ledgers(h)[0];
  assert.equal(h.rejections().length, rejBefore.length - 4);
  const u = await run(h, ['--undo', ledger]);
  assert.equal(u.code, 0, u.err);
  assert.match(u.out, /ledger rescreen-ledger-\S+: 4 lines; restored 4, already present 0, left alone because a newer row for the same candidate and job title exists 0; backup candidates-/);
  assert.deepEqual(h.rejections(), rejBefore, 'exactly the rows that were deleted, with their ids');
  assert.equal(backups(h).length, 2, 'the apply and the undo each took a backup first');
  // a second undo restores nothing and writes no second backup
  const again = await run(h, ['--undo', ledger]);
  assert.equal(again.code, 0);
  assert.match(again.out, /restored 0, already present 4/);
  assert.equal(backups(h).length, 2);
  assert.deepEqual(h.rejections(), rejBefore);
  // and after an undo the dry run sees the four candidates again
  assert.equal((await json(h, [])).j.dryRun.eligible.rowsToDelete, 4);
  const noOutputHolds = u.all + again.all;
  for (const m of MARKERS) assert.ok(!noOutputHolds.includes(m));
});

test('R2 undo: refuses (exit 3, nothing written) a row that exists with different content; leaves alone a row a newer rejection of the same candidate and title replaced', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  assert.equal((await run(h, ['--apply', '--confirm', '4'])).code, 0);
  const ledger = ledgers(h)[0];
  const lines = fs.readFileSync(h.p('runtime', ledger), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  // 1: a row with the id of a deleted row but other content
  h.db((d) => d.prepare('INSERT INTO candidate_rejections (id, caterer_id, job_title, rejected_at, origin) VALUES (?,?,?,?,?)').run(lines[0].row.id, 99999, 'Other', '2026-10-01', 'pipeline'));
  const before = h.snapshot();
  const files = backups(h).length;
  const r = await run(h, ['--undo', ledger]);
  assert.equal(r.code, 3);
  assert.match(r.out, /NOT UNDONE \(nothing was written\): 1 row\(s\) of the ledger exist with different content: nothing was changed/);
  assert.equal(h.snapshot(), before);
  assert.equal(backups(h).length, files);
  // 2: the same candidate and title were rejected again since (a re-screen): the older row is not put back as a duplicate
  h.db((d) => d.prepare('DELETE FROM candidate_rejections WHERE caterer_id = 99999').run());
  h.rej(lines[1].row.caterer_id, lines[1].row.job_title, { date: '2026-10-01' });
  const u = await run(h, ['--undo', ledger]);
  assert.equal(u.code, 0, u.err);
  assert.match(u.out, /restored 3, already present 0, left alone because a newer row for the same candidate and job title exists 1/);
  assert.equal(h.rejections().filter((x) => x.caterer_id === lines[1].row.caterer_id && x.job_title === lines[1].row.job_title).length, 1);
});

test('R2 undo: refuses a file that is not a ledger of this tool, a ledger with a damaged line, a run in flight; --dry-run only counts', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  assert.equal((await run(h, ['--apply', '--confirm', '4'])).code, 0);
  const ledger = ledgers(h)[0];
  fs.writeFileSync(h.p('runtime', 'other.jsonl'), '{}\n');
  assert.equal((await run(h, ['--undo', 'other.jsonl'])).code, 3);
  assert.equal((await run(h, ['--undo', 'rescreen-ledger-20200101T000000Z.jsonl'])).code, 3);
  fs.writeFileSync(h.p('runtime', 'rescreen-ledger-20200101T000000Z.jsonl'), 'not json\n');
  const bad = await run(h, ['--undo', 'rescreen-ledger-20200101T000000Z.jsonl']);
  assert.equal(bad.code, 3);
  assert.match(bad.err, /ledger line 1 is not JSON/);
  fs.writeFileSync(h.p('runtime', 'rescreen-ledger-20200101T000001Z.jsonl'), `${JSON.stringify({ v: 1, table: 'territory_searches', kind: 'rejection', source: 'caterer', row: { id: 1 } })}\n`);
  const foreign = await run(h, ['--undo', 'rescreen-ledger-20200101T000001Z.jsonl']);
  assert.equal(foreign.code, 3);
  assert.match(foreign.err, /not a line of this tool/);
  const before = h.snapshot();
  const busy = await run(h, ['--undo', ledger], { busy: () => true });
  assert.equal(busy.code, 3);
  assert.equal(h.snapshot(), before);
  const dry = await run(h, ['--undo', ledger, '--dry-run']);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /would restore 4/);
  assert.equal(h.snapshot(), before);
});

test('R2: a database without the unique indexes of the legacy layout (a fresh install) behaves the same, and a duplicate pipeline row keeps the candidate blocked', async (t) => {
  const h = standardWorld({ noUniqueIndex: true });
  t.after(() => h.cleanup());
  h.rej(1001, 'Chef'); // a second pipeline row of the same decision window: both are the selection (they would both block)
  h.rej(1002, 'Kitchen Porter', { origin: 'cv:no_relevant_experience' }); // a CV rejection of the same title next to the pipeline one: still blocks, so 1002 is not selected
  const dry = await json(h, []);
  assert.equal(dry.j.dryRun.eligible.candidates, 3);
  assert.equal(dry.j.dryRun.eligible.rowsToDelete, 4, '1001 twice, 1003, 1032');
  assert.equal(dry.j.dryRun.excluded.still_blocked, 2, '1029 (the sentinel) and 1002 (the CV row)');
  const r = await run(h, ['--apply', '--confirm', '4']);
  assert.equal(r.code, 0, r.err);
  assert.equal(h.rejections().filter((x) => x.caterer_id === 1001).length, 0);
  assert.equal(h.rejections().filter((x) => x.caterer_id === 1002).length, 2, 'the pipeline row and the CV row of 1002 stay');
});

test('R2/R4 --reed-seen: deletes the seen-only candidates row of a Reed candidate (and only that), the ledger carries the full row, --undo puts it back', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const candBefore = h.candidates();
  const rejBefore = h.rejections();
  const r = await run(h, ['--apply', '--confirm', '6', '--reed-seen']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`candidate_rejections ${rejBefore.length} rows, candidates \\d+ rows`));
  const after = h.candidates();
  assert.deepEqual(candBefore.filter((x) => !after.some((y) => y.id === x.id)).map((x) => x.reed_id).sort(), [9001, 9005]);
  assert.ok(after.some((x) => x.reed_id === 9002 && x.unlocked === 1), 'an unlocked Reed candidate is never touched');
  assert.ok(after.some((x) => x.reed_id === 9004 && x.zoho_id === 'ZOHO-2'), 'one in Zoho is never touched');
  assert.equal(h.rejections().length, rejBefore.length - 4);
  const lines = fs.readFileSync(h.p('runtime', ledgers(h)[0]), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  const seen = lines.filter((x) => x.kind === 'reed_seen');
  assert.equal(seen.length, 2);
  for (const l of seen) {
    assert.equal(l.table, 'candidates');
    assert.equal(l.source, 'reed');
    assert.ok(candBefore.some((c) => JSON.stringify(c) === JSON.stringify(l.row)), 'the full candidates row, every column');
  }
  const u = await run(h, ['--undo', ledgers(h)[0]]);
  assert.equal(u.code, 0, u.err);
  assert.deepEqual(h.candidates(), candBefore, 'the rows are back with their ids and their created_at');
  assert.deepEqual(h.rejections(), rejBefore);
});

test('R2: a Reed seen row is not deleted without --reed-seen even when --confirm counts it', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const before = h.snapshot();
  const r = await run(h, ['--apply', '--confirm', '6']);
  assert.equal(r.code, 3);
  assert.match(r.out, /does not equal the dry-run row count 4/);
  assert.equal(h.snapshot(), before);
});

test('R2: a hard crash (SIGKILL) in the middle of the deletes, after the ledger was written: the database recovers with every row still there, --undo of the ledger is a tolerated no-op, and the apply can be repeated', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  const before = JSON.stringify([h.rejections(), h.candidates()]);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'crash-child.js'), h.home, '2', '4'], { encoding: 'utf8', timeout: 120000, env: { ...process.env } });
  assert.equal(r.signal, 'SIGKILL', `the child must die by the kill, not finish: ${r.status} ${r.stderr}`);
  assert.equal(JSON.stringify([h.rejections(), h.candidates()]), before, 'the open transaction was never committed: every row is there');
  assert.equal(ledgers(h).length, 1, 'the ledger was on disk before the first delete');
  assert.equal(backups(h).length, 1, 'and so was the verified backup');
  const lines = fs.readFileSync(h.p('runtime', ledgers(h)[0]), 'utf8').trim().split('\n');
  assert.equal(lines.length, 4, 'it lists what MAY have been deleted');
  // the recovery rules: a ledger whose rows are still present clears nothing (so nothing is queued for it) and --undo tolerates it
  const q = await json(h, ['--queue', '--dry-run']);
  assert.equal(q.j.queue.clearedRows, 0);
  assert.equal(q.j.queue.chosen.length, 0);
  const undo = await run(h, ['--undo', ledgers(h)[0]]);
  assert.equal(undo.code, 0, undo.out + undo.err);
  assert.match(undo.out, /restored 0, already present 4/);
  assert.equal(JSON.stringify([h.rejections(), h.candidates()]), before);
  // and the dry run still sees all four, the apply goes through
  assert.equal((await json(h, [])).j.dryRun.eligible.rowsToDelete, 4);
  const again = await run(h, ['--apply', '--confirm', '4']);
  assert.equal(again.code, 0, again.err);
  assert.equal(h.rejections().length, JSON.parse(before)[0].length - 4);
});

test('R2/R6 hygiene: the backup listing and its manifest, the ledger and every output hold no name, e-mail, phone number, card text or candidate id; a shadow file that is not mode 0600 is reported on an apply too', async (t) => {
  if (process.platform === 'win32') { t.skip('no POSIX modes here'); return; }
  const h = standardWorld();
  t.after(() => h.cleanup());
  fs.chmodSync(h.p('shadow', fs.readdirSync(h.p('shadow'))[0]), 0o640);
  const r = await run(h, ['--apply', '--confirm', '4']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /WARNING: 1 shadow file not mode 0600/);
  const listing = [];
  for (const f of fs.readdirSync(h.p('backups'))) listing.push(f, fs.readFileSync(h.p('backups', f), f.endsWith('.json') ? 'utf8' : 'latin1'));
  const everything = `${r.all}\n${listing.join('\n')}\n${fs.readFileSync(h.p('runtime', ledgers(h)[0]), 'utf8')}`;
  for (const m of MARKERS) assert.ok(!everything.includes(m), `${m} appears`);
  assert.ok(!everything.includes('planted text'));
  const ledgerAndOutput = `${r.all}\n${fs.readFileSync(h.p('runtime', ledgers(h)[0]), 'utf8').replace(/"(caterer_id|id)":\d+/g, '')}`;
  for (const id of ['1011', '1012', '1013', '1014', '1017', '1021', '1023']) assert.ok(!ledgerAndOutput.includes(id), `candidate ${id} (not selected) appears`);
});

test('R3: a candidate this tool already cleared is never cleared again, even when the rejection stored now has no newer shadow row (the second look was served from the decision cache); an undo makes the others selectable again', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  assert.equal((await run(h, ['--apply', '--confirm', '4'])).code, 0);
  h.rej(1001, 'Chef', { date: '2026-10-01' }); // booked by the second look (a cached decision writes no shadow row)
  const dry = await json(h, []);
  assert.equal(dry.j.dryRun.eligible.rowsToDelete, 0);
  assert.equal(dry.j.dryRun.excluded.already_cleared, 4);
  const again = await run(h, ['--apply', '--confirm', '1']);
  assert.equal(again.code, 3);
  assert.equal(h.rejections().filter((x) => x.caterer_id === 1001).length, 1, 'the new rejection of 1001 is still there');
  // after an undo the restored rows are blocking again and selectable again; 1001 keeps its newer row and stays cleared
  assert.equal((await run(h, ['--undo', ledgers(h)[0]])).code, 0);
  const after = await json(h, []);
  assert.equal(after.j.dryRun.eligible.rowsToDelete, 3, '1002, 1003 and 1032');
  assert.equal(after.j.dryRun.excluded.already_cleared, 1, '1001');
});
