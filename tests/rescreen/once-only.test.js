'use strict';
// The once-only guard (owner requirement 2026-10-01): a candidate that an applied, not undone ledger of this tool cleared for a job title is NEVER cleared again for
// that title, whether or not a rejection row exists again and whether or not any shadow row survives; an undo releases exactly the rows it put back; a ledger that
// cannot be read in full makes the apply refuse; a different job title is a different role and is not covered; nightly housekeeping never touches the ledgers.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const { run, json, row, T0, T2, MARKERS, standardWorld } = H;
const ledgers = (h) => fs.readdirSync(h.p('runtime')).filter((n) => /^rescreen-ledger-.*\.jsonl$/.test(n)).sort();
const markers = (h, kind) => fs.readdirSync(h.p('runtime')).filter((n) => new RegExp(`^rescreen-${kind}-.*\\.json$`).test(n)).sort();
const backups = (h) => (fs.existsSync(h.p('backups')) ? fs.readdirSync(h.p('backups')).filter((n) => n.endsWith('.db.gz.enc')) : []);
const IDS = [2001, 2002, 2003];

// Three Chef candidates (and one more for another title) that Update A's policy rejected because Jev was uncertain; every rejection is stored.
function world() {
  const h = H.makeHome();
  h.territory('Chef', 'LS29', { sources: 'caterer' });
  h.territory('Kitchen Porter', 'LS29', { sources: 'caterer' });
  h.run('2026-09-30-1500', 'Chef', 'LS29');
  h.run('2026-09-30-1600', 'Kitchen Porter', 'LS29', { completed: '2026-09-30T17:00:00.000Z', started: '2026-09-30T15:50:00.000Z' });
  const rows = IDS.map((id) => row('update-a', 'uncertain_ambiguous', { candidateId: String(id), ts: T0, runId: 'phase1-2026-09-30-1500', jobTitle: 'Chef' }));
  for (const id of IDS) { h.cand(id); h.rej(id, 'Chef'); }
  h.shadow(rows);
  return h;
}
const apply = async (h, n, extra) => { const r = await run(h, ['--apply', '--confirm', String(n)].concat(extra || [])); assert.equal(r.code, 0, r.out + r.err); return r; };
// what the re-screen leaves behind: Jev rejects the card again, so phase 1 books a NEW rejection (origin pipeline, a later date); the shadow row is optional
function reScreen(h, id, title, o) {
  const x = Object.assign({ shadow: true, same: null }, o || {});
  if (x.same) h.db((d) => d.prepare('INSERT INTO candidate_rejections (id, caterer_id, job_title, rejected_at, origin) VALUES (?,?,?,?,?)').run(x.same.id, id, title, x.same.rejected_at, 'pipeline'));
  else h.rej(id, title, { date: '2026-10-01' });
  if (x.shadow) h.shadow([row('head', 'jev_reject', { candidateId: String(id), ts: T2, runId: 'phase1-2026-10-01-0900', jobTitle: title })]);
}
const dry = async (h, extra) => (await json(h, extra || [])).j.dryRun;

test('once-only 1: the loop. Clear, then the re-screen (Jev rejects again: a new row, a later date), then run again WITHOUT any shadow row of the second look: nothing is selected, reason cleared_before', async (t) => {
  const h = world();
  t.after(() => h.cleanup());
  assert.equal((await dry(h)).eligible.rowsToDelete, 3);
  await apply(h, 3);
  for (const id of IDS) reScreen(h, id, 'Chef', { shadow: false }); // shadow logging was off, the file was pruned, or a cache hit wrote no row
  const s = await dry(h);
  assert.equal(s.eligible.rowsToDelete, 0);
  assert.equal(s.excluded.cleared_before, 3);
  assert.equal(s.excluded.outside_window, undefined, 'the new rows are inside the window: only the guard holds them back');
  const again = await run(h, ['--apply', '--confirm', '3']);
  assert.equal(again.code, 3);
  assert.equal(h.rejections().filter((x) => x.job_title === 'Chef').length, 3, 'the three new rejections are still there');
  assert.equal((await run(h, ['--apply', '--confirm', '0'])).code, 0, 'a count of 0 changes nothing');
  assert.equal(ledgers(h).length, 1, 'no second ledger');
  // and with the whole shadow log gone nothing can be selected at all, and nothing fails
  fs.rmSync(h.p('shadow'), { recursive: true, force: true });
  const gone = await dry(h);
  assert.equal(gone.eligible.rowsToDelete, 0);
  assert.equal(gone.policyUncertainRejects, 0);
});

test('once-only 2: the same loop WITH the shadow rows of the second look (Jev decided: newer_jev_decision would also hold): the guard is the first reason and holds on its own', async (t) => {
  const h = world();
  t.after(() => h.cleanup());
  await apply(h, 3);
  for (const id of IDS) reScreen(h, id, 'Chef', { shadow: true });
  const s = await dry(h);
  assert.equal(s.eligible.rowsToDelete, 0);
  assert.equal(s.excluded.cleared_before, 3);
  assert.equal(s.excluded.newer_jev_decision, undefined);
  // the old policy rows alone (the second look's shadow file is lost) give the same answer
  fs.rmSync(h.p('shadow', 'screening-2026-10-01.jsonl'));
  const lost = await dry(h);
  assert.equal(lost.eligible.rowsToDelete, 0);
  assert.equal(lost.excluded.cleared_before, 3);
});

test('once-only 2b: the table evidence is not needed: the new rejection may be the very same row (re-used id, same day, same content), and a kill between the commit and the marker is covered by the table state', async (t) => {
  const h = world();
  t.after(() => h.cleanup());
  await apply(h, 3);
  const lines = fs.readFileSync(h.p('runtime', ledgers(h)[0]), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  // a table without AUTOINCREMENT hands out the id again: the second look's rejection is identical to the one that was cleared
  for (const l of lines) reScreen(h, l.row.caterer_id, 'Chef', { shadow: false, same: l.row });
  assert.deepEqual(h.rejections().map((x) => x.id).sort(), lines.map((l) => l.row.id).sort());
  const s = await dry(h);
  assert.equal(s.eligible.rowsToDelete, 0, 'the applied marker keeps them covered although every ledger row looks untouched');
  assert.equal(s.excluded.cleared_before, 3);
  assert.equal(s.ledgerGuard.covering, 1);
  // without the marker (a kill right after the commit) the table state still proves the apply, as long as a row differs
  const h2 = world();
  t.after(() => h2.cleanup());
  await apply(h2, 3);
  for (const f of markers(h2, 'applied')) fs.unlinkSync(h2.p('runtime', f));
  for (const id of IDS) reScreen(h2, id, 'Chef', { shadow: false });
  const s2 = await dry(h2);
  assert.equal(s2.excluded.cleared_before, 3);
  assert.equal(s2.ledgerGuard.covering, 1);
});

test('once-only 2c: a ledger of an apply that never took effect (rolled back, killed) covers nothing: its candidates are cleared by the retry', async (t) => {
  const h = world();
  t.after(() => h.cleanup());
  const r = await run(h, ['--apply', '--confirm', '3'], { hooks: { afterDelete: (n) => { if (n === 2) throw new Error('injected failure'); } } });
  assert.equal(r.code, 4);
  assert.equal(ledgers(h).length, 1);
  assert.deepEqual(markers(h, 'applied'), [], 'no marker: the transaction was rolled back');
  const s = await dry(h);
  assert.equal(s.ledgerGuard.notApplied, 1);
  assert.equal(s.ledgerGuard.covering, 0);
  assert.equal(s.eligible.rowsToDelete, 3, 'nothing was cleared, so nothing is covered');
  await apply(h, 3);
  assert.equal(ledgers(h).length, 2);
  assert.equal(markers(h, 'applied').length, 1, 'only the apply that took effect has a marker');
  const after = (await dry(h)).ledgerGuard;
  assert.equal(after.covering, 2, 'the retry, and the first ledger too: the table state now shows its rows gone (same candidates, harmless)');
  assert.equal(after.covered, 3);
});

test('once-only 3: an undone ledger releases exactly the rows it put back; a row a second look replaced stays covered', async (t) => {
  const h = world();
  t.after(() => h.cleanup());
  await apply(h, 3);
  const led = ledgers(h)[0];
  assert.equal((await dry(h)).excluded.cleared_before, 3);
  const u = await run(h, ['--undo', led]);
  assert.equal(u.code, 0, u.err);
  assert.match(u.out, /once-only guard released 3 lines, 0 stay covered/);
  assert.equal(markers(h, 'undone').length, 1);
  const released = await dry(h);
  assert.equal(released.eligible.rowsToDelete, 3, 'the restored rejections are selectable again');
  assert.equal(released.excluded.cleared_before, undefined);
  assert.equal(released.ledgerGuard.undone, 1);
  // a second undo changes nothing and keeps the first marker
  const marker = fs.readFileSync(h.p('runtime', markers(h, 'undone')[0]), 'utf8');
  assert.equal((await run(h, ['--undo', led])).code, 0);
  assert.equal(fs.readFileSync(h.p('runtime', markers(h, 'undone')[0]), 'utf8'), marker);
  // a new apply covers them again
  await apply(h, 3);
  assert.equal((await dry(h)).excluded.cleared_before, 3);

  // partial: apply, one candidate is screened again and rejected again, then the owner undoes the ledger
  const h2 = world();
  t.after(() => h2.cleanup());
  await apply(h2, 3);
  reScreen(h2, 2001, 'Chef', { shadow: false });
  const u2 = await run(h2, ['--undo', ledgers(h2)[0]]);
  assert.equal(u2.code, 0, u2.err);
  assert.match(u2.out, /restored 2, already present 0, left alone because a newer row for the same candidate and job title exists 1/);
  assert.match(u2.out, /once-only guard released 2 lines, 1 stay covered/);
  const s2 = await dry(h2);
  assert.equal(s2.eligible.rowsToDelete, 2, '2002 and 2003 are selectable again');
  assert.equal(s2.excluded.cleared_before, 1, '2001 had its second look');
  const mk = JSON.parse(fs.readFileSync(h2.p('runtime', markers(h2, 'undone')[0]), 'utf8'));
  assert.equal(mk.keptRows.length, 1);
});

test('once-only 3b: an undo that finds nothing to restore (a restored database, a second look already booked) still records itself', async (t) => {
  const h = world();
  t.after(() => h.cleanup());
  await apply(h, 3);
  const led = ledgers(h)[0];
  // the owner restored the pre-apply database: every row is back and untouched, the guard still covers them (fail closed) until the ledger is undone
  const lines = fs.readFileSync(h.p('runtime', led), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  for (const l of lines) h.db((d) => d.prepare('INSERT INTO candidate_rejections (id, caterer_id, job_title, rejected_at, origin) VALUES (?,?,?,?,?)').run(l.row.id, l.row.caterer_id, l.row.job_title, l.row.rejected_at, l.row.origin));
  const covered = await dry(h);
  assert.equal(covered.eligible.rowsToDelete, 0, 'the marker says applied: covered');
  assert.equal(covered.excluded.cleared_before, 3);
  const u = await run(h, ['--undo', led]);
  assert.equal(u.code, 0, u.err);
  assert.match(u.out, /restored 0, already present 3/);
  assert.equal(backups(h).length, 1, 'no second backup: nothing was restored');
  assert.equal((await dry(h)).eligible.rowsToDelete, 3, 'released');
});

test('once-only 4: a ledger that cannot be read: the dry run warns, the apply refuses (exit 3, nothing written), the lines that can be read still count', async (t) => {
  const h = world();
  t.after(() => h.cleanup());
  await apply(h, 3);
  for (const id of IDS) reScreen(h, id, 'Chef', { shadow: false });
  // a new eligible candidate so that an apply has something to do
  h.shadow([row('update-a', 'uncertain_ambiguous', { candidateId: '2010', ts: T0, runId: 'phase1-2026-09-30-1500', jobTitle: 'Chef' })]);
  h.cand(2010); h.rej(2010, 'Chef');
  const led = ledgers(h)[0];
  const original = fs.readFileSync(h.p('runtime', led), 'utf8');
  const files = backups(h).length;

  // (a) damaged: one line is garbage; the other two are still proof
  fs.writeFileSync(h.p('runtime', led), `${original.trim().split('\n').slice(0, 2).join('\n')}\n{"v":1,"table":"candidate_rej\n`);
  const damaged = h.snapshot();
  const d = await run(h, []);
  assert.equal(d.code, 0, 'a dry run only warns');
  assert.match(d.out, new RegExp(`WARNING: ledger ${led.replace(/\./g, '\\.')} 1 line\\(s\\) cannot be read`));
  assert.match(d.out, /WARNING: ledger \S+ holds 2 readable lines but 3 were written/);
  assert.match(d.out, /--apply would be refused now: the once-only guard cannot read /);
  const j = (await json(h, [])).j.dryRun;
  assert.equal(j.eligible.rowsToDelete, 2, '2010 and 2003 (the line of 2003 is the one that cannot be read, so nothing proves its second look)');
  assert.equal(j.excluded.cleared_before, 2, 'the two readable lines still cover their candidates');
  assert.equal(j.ledgerGuard.problems.length, 2);
  const refused = await run(h, ['--apply', '--confirm', '2']);
  assert.equal(refused.code, 3);
  assert.match(refused.out, /NOT APPLIED \(nothing was written\): the once-only guard cannot read /);
  assert.equal(h.snapshot(), damaged, 'nothing was written: no table change, no backup, no ledger, no marker');
  assert.equal(backups(h).length, files);
  assert.equal(ledgers(h).length, 1);
  assert.equal((await run(h, ['--queue', '--dry-run'])).code, 3, 'the queue refuses too');

  // (b) restored: the apply works again
  fs.writeFileSync(h.p('runtime', led), original);
  assert.equal((await dry(h)).ledgerGuard.problems.length, 0);
  await apply(h, 1);
  assert.equal(h.rejections().filter((x) => x.caterer_id === 2010).length, 0);

  // (c) a ledger that is not even a file of this tool, and one that is gone while its marker remains
  const h2 = world();
  t.after(() => h2.cleanup());
  await apply(h2, 3);
  h2.shadow([row('update-a', 'uncertain_ambiguous', { candidateId: '2010', ts: T0, runId: 'phase1-2026-09-30-1500', jobTitle: 'Chef' })]);
  h2.cand(2010); h2.rej(2010, 'Chef');
  const l2 = ledgers(h2)[0];
  fs.renameSync(h2.p('runtime', l2), h2.p('runtime', `moved-${l2}`));
  const orphan = await run(h2, ['--apply', '--confirm', '1']);
  assert.equal(orphan.code, 3);
  assert.match(orphan.out, new RegExp(`${l2.replace(/\./g, '\\.')} \\(the file is gone although the apply recorded it\\)`));
  assert.equal(h2.rejections().filter((x) => x.caterer_id === 2010).length, 1, 'nothing was deleted');
  fs.renameSync(h2.p('runtime', `moved-${l2}`), h2.p('runtime', l2));
  fs.writeFileSync(h2.p('runtime', 'rescreen-ledger-20250101T000000Z.jsonl'), JSON.stringify({ v: 1, table: 'territory_searches', kind: 'rejection', source: 'caterer', row: { id: 1 } }) + '\n');
  const foreign = await run(h2, ['--apply', '--confirm', '1']);
  assert.equal(foreign.code, 3);
  assert.match(foreign.out, /rescreen-ledger-20250101T000000Z\.jsonl \(1 line\(s\) cannot be read\)/);
  assert.equal(h2.rejections().filter((x) => x.caterer_id === 2010).length, 1);
  // an apply with --dry-run says the same and writes nothing
  const dryApply = await run(h2, ['--apply', '--confirm', '1', '--dry-run']);
  assert.match(dryApply.out, /--apply would be refused now/);
});

test('once-only 5: two ledgers: both cover; undoing one releases only its own rows', async (t) => {
  const h = world();
  t.after(() => h.cleanup());
  await apply(h, 3);
  for (const id of [2011, 2012]) {
    h.shadow([row('update-a', 'uncertain_ambiguous', { candidateId: String(id), ts: T0, runId: 'phase1-2026-09-30-1500', jobTitle: 'Chef' })]);
    h.cand(id); h.rej(id, 'Chef');
  }
  await apply(h, 2);
  const [a, b] = ledgers(h);
  assert.equal(ledgers(h).length, 2);
  assert.notEqual(a, b);
  const both = await dry(h);
  assert.equal(both.ledgerGuard.covering, 2);
  assert.equal(both.excluded.cleared_before, 5);
  for (const id of [...IDS, 2011, 2012]) reScreen(h, id, 'Chef', { shadow: false });
  assert.equal((await dry(h)).excluded.cleared_before, 5, 'five second looks, none selected');
  // without a second look: undo A (the three) and keep B (the two)
  const h2 = world();
  t.after(() => h2.cleanup());
  await apply(h2, 3);
  const firstLedger = ledgers(h2)[0];
  for (const id of [2011, 2012]) {
    h2.shadow([row('update-a', 'uncertain_ambiguous', { candidateId: String(id), ts: T0, runId: 'phase1-2026-09-30-1500', jobTitle: 'Chef' })]);
    h2.cand(id); h2.rej(id, 'Chef');
  }
  await apply(h2, 2);
  assert.equal((await run(h2, ['--undo', firstLedger])).code, 0);
  const s = await dry(h2);
  assert.equal(s.eligible.rowsToDelete, 3, 'the three of ledger A');
  assert.equal(s.excluded.cleared_before, 2, 'the two of ledger B stay covered');
  assert.equal(s.ledgerGuard.covering, 2);
  assert.equal(s.ledgerGuard.undone, 1);
});

test('once-only 6: a DIFFERENT job title for the same candidate is a new role and is not covered (owner rule); the same title is', async (t) => {
  const h = world();
  t.after(() => h.cleanup());
  await apply(h, 3);
  // 2001 now comes up for another title: the old fallback rejected that too, it is the first look at that role
  h.shadow([row('update-a', 'uncertain_x', { candidateId: '2001', ts: '2026-09-30T16:00:00.000Z', runId: 'phase1-2026-09-30-1600', jobTitle: 'Kitchen Porter' })]);
  h.rej(2001, 'Kitchen Porter');
  const s = await dry(h);
  assert.equal(s.eligible.rowsToDelete, 1, 'the Kitchen Porter row of 2001 is selectable');
  assert.deepEqual(s.eligible.byTerritory, [{ territory: 'Kitchen Porter LS29', candidates: 1 }]);
  assert.equal(s.excluded.cleared_before, 3, 'the three Chef cards are covered; the Kitchen Porter card is not');
  // the Chef title of the same candidate is still covered
  reScreen(h, 2001, 'Chef', { shadow: false });
  assert.equal((await dry(h)).excluded.cleared_before, 3);
  await apply(h, 1);
  assert.equal(h.rejections().filter((x) => x.caterer_id === 2001 && x.job_title === 'Chef').length, 1, 'the Chef rejection of the second look is untouched');
  assert.equal(h.rejections().filter((x) => x.caterer_id === 2001 && x.job_title === 'Kitchen Porter').length, 0);
  // and now that title is covered too
  h.rej(2001, 'Kitchen Porter', { date: '2026-10-01' });
  assert.equal((await dry(h)).excluded.cleared_before, 4);
});

test('once-only 7: a Reed candidate cleared with --reed-seen and seen again (a new seen row) is not cleared again', async (t) => {
  const h = standardWorld();
  t.after(() => h.cleanup());
  await apply(h, 6, ['--reed-seen']);
  h.cand(9001, { source: 'reed' }); // phase 1 books the screened card as seen again
  h.cand(9005, { source: 'reed' });
  const s = await dry(h, ['--reed-seen']);
  assert.equal(s.excluded.cleared_before, 6, 'the four Caterer cards and the two Reed cards');
  assert.equal(s.eligible.rowsToDelete, 0);
});

test('once-only 8: the guard files are private, hold no personal data and no candidate id, and the dry run names the guard', async (t) => {
  const h = world();
  t.after(() => h.cleanup());
  const r = await apply(h, 3);
  await run(h, ['--undo', ledgers(h)[0]]);
  const files = fs.readdirSync(h.p('runtime')).filter((n) => /^rescreen-(applied|undone)-/.test(n));
  assert.equal(files.length, 2);
  for (const f of files) {
    const text = fs.readFileSync(h.p('runtime', f), 'utf8');
    if (process.platform !== 'win32') assert.equal(fs.statSync(h.p('runtime', f)).mode & 0o777, 0o600);
    for (const m of MARKERS) assert.ok(!text.includes(m));
    for (const id of IDS) assert.ok(!new RegExp(`\\b${id}\\b`).test(text), `candidate ${id} named in a marker`);
    assert.ok(/^\{"v":1,"ledger":"rescreen-ledger-\d{8}T\d{6}Z\.jsonl"/.test(text));
  }
  assert.ok(!fs.readdirSync(h.p('runtime')).some((n) => n.endsWith('.tmp')));
  const out = (await run(h, [])).out;
  assert.match(out, /once-only guard: 1 ledger in runtime\/: 1 took effect \(1 of them undone: only the rows put back are released\), 0 never took effect; 0 candidate and job title pairs are never cleared again/);
  assert.match(r.out, /once-only guard: these candidates are never cleared again for these job titles/);
});

test('once-only 9: nightly housekeeping and the retention sweep never delete or touch the ledgers, their markers or the queue ledger, however old', async (t) => {
  if (process.platform === 'win32') { t.skip('child processes with POSIX paths'); return; }
  const h = world();
  t.after(() => h.cleanup());
  await apply(h, 3);
  await run(h, ['--undo', ledgers(h)[0]]);
  await apply(h, 3);
  fs.writeFileSync(h.p('runtime', 'rescreen-queue.json'), `${JSON.stringify({ days: {} })}\n`);
  const names = fs.readdirSync(h.p('runtime')).filter((n) => /^rescreen-/.test(n)).sort();
  assert.ok(names.length >= 5, names.join(','));
  const old = new Date('2015-01-01T00:00:00Z');
  const sum = () => names.map((n) => `${n}:${fs.readFileSync(h.p('runtime', n), 'utf8').length}`);
  for (const n of names) fs.utimesSync(h.p('runtime', n), old, old);
  const before = sum();
  const scripts = path.join(H.REPO, 'resourcer', 'scripts');
  const env = { ...process.env, RESOURCER_HOME: h.home, NODE_PATH: [path.join(H.REPO, 'resourcer', 'node_modules'), process.env.NODE_PATH || ''].join(path.delimiter) };
  const m = spawnSync(process.execPath, [path.join(scripts, 'maintenance.js'), '--daily'], { env, encoding: 'utf8', timeout: 120000 });
  assert.ok(m.status === 0 || m.status === 3, `maintenance: ${m.status} ${m.stderr}`);
  const rs = spawnSync(process.execPath, [path.join(scripts, 'retention-sweep.js'), '--now', '2036-01-01T00:00:00Z'], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(rs.status, 0, `retention sweep: ${rs.stderr} ${rs.stdout.slice(0, 300)}`);
  assert.deepEqual(fs.readdirSync(h.p('runtime')).filter((n) => /^rescreen-/.test(n)).sort(), names);
  assert.deepEqual(sum(), before);
  // the guard still holds after the housekeeping (the sweep also pruned the shadow log, which is 10 years old by its clock: the ledgers alone cover)
  const g = (await dry(h)).ledgerGuard;
  assert.equal(g.covered, 3);
  assert.equal(g.problems.length, 0);
});

test('once-only 4b: a ledger that is not a file, or a runtime folder that cannot be listed, is a problem (fail closed); a missing runtime folder is simply no ledger', async (t) => {
  const h = world();
  t.after(() => h.cleanup());
  fs.mkdirSync(h.p('runtime', 'rescreen-ledger-20250101T000000Z.jsonl'));
  const d = await run(h, []);
  assert.equal(d.code, 0);
  assert.match(d.out, /WARNING: ledger rescreen-ledger-20250101T000000Z\.jsonl is not a readable file of a sane size/);
  const refused = await run(h, ['--apply', '--confirm', '3']);
  assert.equal(refused.code, 3);
  assert.equal(h.rejections().length, 3, 'nothing was deleted');
  fs.rmdirSync(h.p('runtime', 'rescreen-ledger-20250101T000000Z.jsonl'));

  const h2 = world();
  t.after(() => h2.cleanup());
  fs.rmSync(h2.p('runtime'), { recursive: true, force: true });
  const none = await json(h2, []);
  assert.equal(none.code, 0);
  assert.equal(none.j.dryRun.ledgerGuard.ledgers, 0);
  assert.deepEqual(none.j.dryRun.ledgerGuard.problems, []);
  assert.equal(none.j.dryRun.eligible.rowsToDelete, 3);
  fs.writeFileSync(h2.p('runtime'), 'a file where the folder should be');
  const bad = await json(h2, []);
  assert.deepEqual(bad.j.dryRun.ledgerGuard.problems, [{ file: 'runtime', reason: 'the folder cannot be listed' }]);
  assert.equal((await run(h2, ['--apply', '--confirm', '3'])).code, 3);
  assert.equal(h2.rejections().length, 3);
});

test('once-only 4c: a damaged or foreign marker never releases a ledger (fail closed) and is warned about; a damaged applied marker still counts as applied', async (t) => {
  const h = world();
  t.after(() => h.cleanup());
  await apply(h, 3);
  const led = ledgers(h)[0];
  const stamp = /^rescreen-ledger-(.+)\.jsonl$/.exec(led)[1];
  const undone = h.p('runtime', `rescreen-undone-${stamp}.json`);
  // restore the rows by hand so that the table shows nothing, then offer markers that are not the one a real undo writes
  for (const content of ['not json', JSON.stringify({ v: 1, ledger: 'rescreen-ledger-20200101T000000Z.jsonl', keptRows: [] }), JSON.stringify({ v: 2, ledger: led, keptRows: [] })]) {
    fs.writeFileSync(undone, `${content}\n`);
    const s = await dry(h);
    assert.equal(s.excluded.cleared_before, 3, `a marker like ${content.slice(0, 20)} does not release the ledger`);
    assert.equal(s.ledgerGuard.undone, 0);
    assert.match(JSON.stringify(s.ledgerGuard.warnings), /undone marker is damaged/);
  }
  fs.unlinkSync(undone);
  fs.writeFileSync(h.p('runtime', `rescreen-applied-${stamp}.json`), 'garbage\n');
  for (const id of IDS) reScreen(h, id, 'Chef', { shadow: false });
  const s = await dry(h);
  assert.equal(s.ledgerGuard.covering, 1, 'a damaged applied marker still means applied');
  assert.match(JSON.stringify(s.ledgerGuard.warnings), /applied marker is damaged/);
});
