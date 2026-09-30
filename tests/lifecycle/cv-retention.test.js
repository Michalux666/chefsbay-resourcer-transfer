'use strict';
const { makeWorkspace } = require('./helpers/workspace');
const ws = makeWorkspace('lc-ret');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('../../resourcer/scripts/lib/cv-retention');
const BS = String.fromCharCode(92);

test.after(() => ws.cleanup());

test('deletion rule truth table: zoho id AND (attached OR duplicate)', () => {
  const bools = [true, false];
  for (const zohoId of ['4511', '', null, undefined, 0]) {
    for (const cvAttached of bools) {
      for (const isDuplicate of bools) {
        const expected = !!zohoId && (cvAttached || isDuplicate);
        assert.equal(R.shouldDeleteCandidateArtifacts({ zohoId, cvAttached, isDuplicate }), expected, JSON.stringify({ zohoId, cvAttached, isDuplicate }));
      }
    }
  }
  assert.equal(R.shouldDeleteCandidateArtifacts(), false);
});

test('isSafeId accepts integers only', () => {
  for (const ok of ['1', '104847500', 104847500, '00012']) assert.equal(R.isSafeId(ok), true, String(ok));
  for (const bad of ['', '../1', '1/2', '1.5', '-1', 'abc', '1e3', null, undefined, {}, [], '1 ', ' 1', '\u0661\u0662\u0663', '1'.repeat(21), NaN, 1.5, -3]) {
    assert.equal(R.isSafeId(bad), false, String(bad));
  }
});

test('cvBasenames and prefixes follow findExistingCv order', () => {
  assert.deepEqual(R.cvBasenames('7', 'caterer').slice(0, 2), ['cv-7.pdf', 'cv-7.docx']);
  assert.equal(R.cvBasenames('7', 'reed')[0], 'cv-reed-7.pdf');
  assert.equal(R.cvBasenames('7', 'reed').length, 10);
  assert.equal(R.cvBasenames('7', 'reed', false).length, 5);
  assert.deepEqual(R.cvBasenames('../7', 'reed'), []);
});

test('classifyDownloadName covers every legacy downloads/ pattern', () => {
  const k = n => R.classifyDownloadName(n).kind;
  assert.equal(k('candidate-123.json'), 'candidate');
  assert.equal(k('cv-123.pdf'), 'cv');
  assert.equal(k('cv-reed-123.docx'), 'cv');
  assert.equal(k('cv-123.odt'), 'cv');
  assert.equal(k('approved-queue-2026-09-29-100301.json'), 'queue');
  assert.equal(k('merged-queue-2026-09-29T10-31-01.json'), 'queue');
  assert.equal(k('reed-approved-queue-phase1-2026-09-29-100301.json'), 'queue');
  assert.equal(k('phase2-results-merged-queue-2026-09-29T10-31-01.json'), 'results');
  assert.equal(k('reed-empty-2026-09-29T10-31-01.json'), 'reed-empty');
  assert.equal(k('review-tmp-2026-09-29.json'), 'review-tmp');
  assert.equal(k('review-tmp-2026-09-29.json.stdout'), 'review-tmp');
  assert.equal(k('cv-123.pdf.4242.1700000000000.tmp'), 'tmp');
  assert.equal(k('screenshot-1.png'), 'other');
  assert.equal(k('candidate-123.json.bak'), 'other');
});

test('queue <-> results <-> status name mapping matches the legacy writer', () => {
  assert.equal(R.queueNameForRunKey('merged-queue-2026-09-29T10-31-01'), 'merged-queue-2026-09-29T10-31-01.json');
  assert.equal(R.queueNameForRunKey('2026-09-29-100301'), 'approved-queue-2026-09-29-100301.json');
  assert.equal(R.queueNameForRunKey('reed-approved-queue-chef-x'), 'reed-approved-queue-chef-x.json');
  assert.equal(R.runKeyForQueueName('approved-queue-2026-09-29-100301.json'), '2026-09-29-100301');
  assert.equal(R.runKeyForQueueName('merged-queue-2026-09-29T10-31-01.json'), 'merged-queue-2026-09-29T10-31-01');
  assert.equal(R.statusNameForQueue('approved-queue-2026-09-29-100301.json'), 'phase1-2026-09-29-100301.json');
  assert.equal(R.statusNameForQueue('reed-approved-queue-phase1-2026-09-29-100301.json'), 'phase1-2026-09-29-100301.json');
  assert.equal(R.statusNameForQueue('merged-queue-2026-09-29T10-31-01.json'), null);
});

test('classifyRunsName whitelists only known run artefacts', () => {
  assert.equal(R.classifyRunsName('phase1-2026-09-29-100301.json'), 'status');
  assert.equal(R.classifyRunsName('phase1-2026-09-29-100301.json.run-lock'), 'status');
  assert.equal(R.classifyRunsName('phase1-2026-09-29-100301.json.stale-1T2'), 'status');
  assert.equal(R.classifyRunsName('params-watchdog-2026-09-29.json'), 'params');
  assert.equal(R.classifyRunsName('run-merged-queue-2026-09-29T10-31-01.json'), 'run-state');
  assert.equal(R.classifyRunsName('pipeline-wake.flag'), 'other');
  assert.equal(R.classifyRunsName('watchdog.lock'), 'other');
  assert.equal(R.classifyRunsName('heartbeat.json'), 'other');
});

// ------------------------------- jail -------------------------------------------------------------

function fresh() {
  ws.reset();
  fs.mkdirSync(ws.downloads, { recursive: true });
  return ws.downloads;
}

test('jailedUnlink removes a regular file inside a root and nothing else', () => {
  const d = fresh();
  fs.writeFileSync(path.join(d, 'cv-1.pdf'), 'x');
  const r = R.jailedUnlink([d], d, 'cv-1.pdf');
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(d, 'cv-1.pdf')), false);
  assert.equal(R.jailedUnlink([d], d, 'cv-1.pdf').reason, 'missing');
});

test('jailedUnlink rejects traversal, separators and dot names', () => {
  const d = fresh();
  const outside = path.join(ws.home, 'outside.txt');
  fs.writeFileSync(outside, 'keep');
  for (const name of ['../outside.txt', `..${BS}outside.txt`, 'sub/x', `sub${BS}x`, '..', '.', '', 'a\0b', undefined, null, 5]) {
    const r = R.jailedUnlink([d], d, name);
    assert.equal(r.ok, false, `name ${JSON.stringify(name)}`);
    assert.equal(r.reason, 'bad-name');
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
});

test('jailedUnlink refuses a directory that is not one of the roots', () => {
  const d = fresh();
  const other = path.join(ws.home, 'other');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'cv-1.pdf'), 'x');
  const r = R.jailedUnlink([d], other, 'cv-1.pdf');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'outside-jail');
  assert.equal(fs.existsSync(path.join(other, 'cv-1.pdf')), true);
  assert.equal(R.jailedUnlink([d], path.join(d, 'missing-dir'), 'x').reason, 'dir-missing');
});

test('jailedUnlink never follows or removes symlinks (file or directory)', (t) => {
  const d = fresh();
  const outsideDir = path.join(ws.home, 'outside-dir');
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideFile = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(outsideFile, 'keep');
  try {
    fs.symlinkSync(outsideFile, path.join(d, 'cv-9.pdf'));
    fs.symlinkSync(outsideDir, path.join(d, 'linkdir'), 'dir');
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') return t.skip('symlinks need privileges on this host');
    throw e;
  }
  assert.equal(R.jailedUnlink([d], d, 'cv-9.pdf').reason, 'symlink');
  assert.equal(R.jailedUnlink([d], d, 'linkdir').reason, 'symlink');
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'keep');
  // a root that is itself reached through a symlink resolves to the real directory
  const viaLink = path.join(ws.home, 'downloads-link');
  fs.symlinkSync(d, viaLink, 'dir');
  fs.writeFileSync(path.join(d, 'cv-10.pdf'), 'x');
  assert.equal(R.jailedUnlink([d], viaLink, 'cv-10.pdf').ok, true);
  assert.equal(R.jailedUnlink([outsideDir], viaLink, 'cv-9.pdf').reason, 'outside-jail');
});

test('jailedUnlink will not delete a directory even inside the root', () => {
  const d = fresh();
  fs.mkdirSync(path.join(d, 'cv-5.pdf'));
  assert.equal(R.jailedUnlink([d], d, 'cv-5.pdf').reason, 'not-regular-file');
  assert.equal(fs.existsSync(path.join(d, 'cv-5.pdf')), true);
});

test('removeCandidateArtifacts removes json + every extension of the own CV prefix, nothing else', () => {
  const d = fresh();
  for (const n of ['candidate-11.json', 'cv-11.pdf', 'cv-11.docx', 'cv-reed-11.pdf', 'cv-12.pdf', 'candidate-12.json']) fs.writeFileSync(path.join(d, n), 'x');
  const r = R.removeCandidateArtifacts({ dir: d, id: '11', source: 'caterer', jailRoots: [d] });
  assert.deepEqual(r.removed.sort(), ['candidate-11.json', 'cv-11.docx', 'cv-11.pdf']);
  assert.deepEqual(r.failed, []);
  assert.equal(fs.existsSync(path.join(d, 'cv-12.pdf')), true, 'other candidates untouched');
  assert.equal(fs.existsSync(path.join(d, 'cv-reed-11.pdf')), true, 'the other prefix is not this candidate\'s file');
});

test('removeCandidateArtifacts also removes the file that was actually attached when the reader fell back to the other prefix', () => {
  const d = fresh();
  for (const n of ['candidate-11.json', 'cv-reed-11.pdf', 'cv-reed-11.docx']) fs.writeFileSync(path.join(d, n), 'x');
  const r = R.removeCandidateArtifacts({ dir: d, id: '11', source: 'caterer', jailRoots: [d], cvPath: path.join(d, 'cv-reed-11.pdf') });
  assert.deepEqual(r.removed.sort(), ['candidate-11.json', 'cv-reed-11.pdf']);
  assert.equal(fs.existsSync(path.join(d, 'cv-reed-11.docx')), true);
  // an unrelated cvPath is never deleted
  fs.writeFileSync(path.join(d, 'cv-99.pdf'), 'x');
  const r2 = R.removeCandidateArtifacts({ dir: d, id: '11', source: 'caterer', jailRoots: [d], cvPath: path.join(d, 'cv-99.pdf') });
  assert.equal(r2.removed.includes('cv-99.pdf'), false);
  assert.equal(fs.existsSync(path.join(d, 'cv-99.pdf')), true);
});

test('removeCandidateArtifacts honours protectAlternate (another candidate owns the other-source names)', () => {
  const d = fresh();
  for (const n of ['candidate-11.json', 'cv-11.pdf', 'cv-reed-11.pdf']) fs.writeFileSync(path.join(d, n), 'x');
  const r = R.removeCandidateArtifacts({ dir: d, id: '11', source: 'caterer', jailRoots: [d], protectAlternate: true, cvPath: path.join(d, 'cv-reed-11.pdf') });
  assert.deepEqual(r.removed.sort(), ['candidate-11.json', 'cv-11.pdf']);
  assert.equal(fs.existsSync(path.join(d, 'cv-reed-11.pdf')), true);
});

test('removeCandidateArtifacts refuses unsafe ids and never leaves the directory', () => {
  const d = fresh();
  const victim = path.join(ws.home, 'cv-1.pdf');
  fs.writeFileSync(victim, 'keep');
  for (const id of ['../cv-1', `..${BS}..${BS}x`, '1/../1', '', null]) {
    const r = R.removeCandidateArtifacts({ dir: d, id, source: 'caterer', jailRoots: [d] });
    assert.equal(r.skipped, 'unsafe-id');
    assert.deepEqual(r.removed, []);
  }
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
});

test('removeCandidateArtifacts reports a symlinked candidate file instead of following it', (t) => {
  const d = fresh();
  const target = path.join(ws.home, 'precious.json');
  fs.writeFileSync(target, 'keep');
  try { fs.symlinkSync(target, path.join(d, 'candidate-21.json')); } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') return t.skip('symlinks need privileges on this host');
    throw e;
  }
  const r = R.removeCandidateArtifacts({ dir: d, id: '21', source: 'caterer', jailRoots: [d] });
  assert.deepEqual(r.removed, []);
  assert.equal(r.failed[0].reason, 'symlink');
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
});

// ------------------------------- plan ---------------------------------------------------------------

const DAY = R.DAY_MS;
const NOW = Date.parse('2026-09-29T12:00:00Z');
const file = (name, ageDays, size = 10, type = 'file') => ({ name, size, type, mtimeMs: NOW - ageDays * DAY });

function plan(entries, over = {}) {
  return R.planDownloadsSweep({
    now: NOW, entries,
    readResults: over.readResults || (() => undefined),
    readStatus: over.readStatus || (() => null),
    queueInfo: over.queueInfo || (() => null),
  });
}
const names = p => p.actions.map(a => a.name);

test('plan: review-tmp always, fresh or not', () => {
  const p = plan([file('review-tmp-1.json', 0), file('review-tmp-1.json.stdout', 0)]);
  assert.deepEqual(names(p).sort(), ['review-tmp-1.json', 'review-tmp-1.json.stdout']);
});

test('plan: results+queue group is deleted queue first, results second, only after 3 days', () => {
  const qn = 'merged-queue-2026-09-20T10-00-00.json';
  const rn = 'phase2-results-merged-queue-2026-09-20T10-00-00.json';
  const done = ageDays => ({ date: '2026-09-20', completedAt: new Date(NOW - ageDays * DAY).toISOString() });
  const old = plan([file(qn, 4), file(rn, 4)], { readResults: () => done(4) });
  assert.deepEqual(names(old), [qn, rn]);
  assert.equal(old.actions[1].dependsOn, qn);
  assert.equal(old.actions[0].requiresRunResult, 'merged-queue-2026-09-20T10-00-00');
  const young = plan([file(qn, 2.9), file(rn, 2.9)], { readResults: () => done(2.9) });
  assert.deepEqual(names(young), []);
  const edge = plan([file(qn, 3.01), file(rn, 3.01)], { readResults: () => done(3.01) });
  assert.deepEqual(names(edge), [qn, rn]);
  // completedAt drives the decision, not mtime alone
  const touched = plan([file(qn, 10), file(rn, 10)], { readResults: () => done(1) });
  assert.deepEqual(names(touched), []);
});

test('plan: results without a queue file are removed after 3 days; a recent one keeps its queue reserved', () => {
  const rn = 'phase2-results-merged-queue-2026-09-20T10-00-00.json';
  const p = plan([file(rn, 5)], { readResults: () => ({ date: '2026-09-20', completedAt: new Date(NOW - 5 * DAY).toISOString() }) });
  assert.deepEqual(names(p), [rn]);
  assert.equal(p.actions[0].dependsOn, undefined);
  const qn = 'merged-queue-2026-09-29T10-00-00.json';
  const rn2 = 'phase2-results-merged-queue-2026-09-29T10-00-00.json';
  const keep = plan([file(qn, 20), file(rn2, 1)], { readResults: () => ({ date: '2026-09-28', completedAt: new Date(NOW - DAY).toISOString() }) });
  assert.deepEqual(names(keep), [], 'an old queue re-processed yesterday must not be swept as an orphan');
});

test('plan: caterer-only approved-queue pairs with results named without the prefix', () => {
  const qn = 'approved-queue-2026-09-20-100301.json';
  const rn = 'phase2-results-2026-09-20-100301.json';
  const p = plan([file(qn, 6), file(rn, 6)], { readResults: () => ({ date: '2026-09-20', completedAt: new Date(NOW - 6 * DAY).toISOString() }) });
  assert.deepEqual(names(p), [qn, rn]);
});

test('plan: undated results wait 14 days like orphans instead of sitting behind the run_results gate forever', () => {
  const qn = 'merged-queue-2026-09-01T10-00-00.json';
  const rn = 'phase2-results-merged-queue-2026-09-01T10-00-00.json';
  const undated = { completedAt: new Date(NOW - 20 * DAY).toISOString() };
  assert.deepEqual(names(plan([file(qn, 20), file(rn, 20)], { readResults: () => undated })), [qn, rn]);
  assert.deepEqual(names(plan([file(qn, 9), file(rn, 9)], { readResults: () => ({ completedAt: new Date(NOW - 9 * DAY).toISOString() }) })), []);
});

test('plan: corrupt results wait 14 days, then go with their queue', () => {
  const qn = 'merged-queue-2026-09-01T10-00-00.json';
  const rn = 'phase2-results-merged-queue-2026-09-01T10-00-00.json';
  assert.deepEqual(names(plan([file(qn, 20), file(rn, 20)])), [qn, rn]);
  const young = plan([file(rn, 9)]);
  assert.deepEqual(names(young), []);
});

test('plan: approved/reed queue with a completed status file follows the 3 day rule', () => {
  const qn = 'approved-queue-2026-09-20-100301.json';
  const rq = 'reed-approved-queue-phase1-2026-09-20-100301.json';
  const status = a => ({ phase2Complete: true, completedAt: new Date(NOW - a * DAY).toISOString() });
  const p = plan([file(qn, 8), file(rq, 8)], { readStatus: () => status(4) });
  assert.deepEqual(names(p).sort(), [qn, rq].sort());
  assert.deepEqual(names(plan([file(qn, 8)], { readStatus: () => status(2) })), []);
  // phase2Status:'done' counts as completion too
  assert.deepEqual(names(plan([file(qn, 8)], { readStatus: () => ({ phase2Status: 'done', updatedAt: new Date(NOW - 5 * DAY).toISOString() }) })), [qn]);
});

test('plan: a queue that never completed is an orphan only after 14 days and is reported as stranded', () => {
  const qn = 'approved-queue-2026-09-01-100301.json';
  const stranded = plan([file(qn, 15)], { readStatus: () => ({ status: 'phase1_complete', phase2Status: 'pending' }), queueInfo: () => ({ candidates: 4 }) });
  assert.deepEqual(names(stranded), [qn]);
  assert.deepEqual(stranded.anomalies, [{ code: 'stranded-queue-deleted', name: qn, candidates: 4 }]);
  assert.deepEqual(names(plan([file(qn, 13.9)])), []);
  const mq = 'merged-queue-2026-09-01T10-00-00.json';
  assert.deepEqual(names(plan([file(mq, 16)])), [mq], 'no status mapping for merged queues: age rule');
});

test('plan: a reed queue with no status mapping follows a completed run for the same job and location (3h window)', () => {
  const rq = 'reed-approved-queue-chef-ls1-2026-09-20T10-00-00.json';
  const rn = 'phase2-results-merged-queue-2026-09-20T10-20-00.json';
  const qmtime = NOW - 8 * DAY;
  const q = { name: rq, size: 1, type: 'file', mtimeMs: qmtime };
  const r = { name: rn, size: 1, type: 'file', mtimeMs: qmtime + 25 * 60000 };
  const results = over => ({ date: '2026-09-20', jobTitle: 'Chef', location: 'LS1', completedAt: new Date(qmtime + 25 * 60000).toISOString(), ...over });
  const info = { candidates: 3, jobTitle: 'chef', location: 'ls1' };
  const hit = plan([q, r], { readResults: () => results(), queueInfo: () => info });
  assert.ok(names(hit).includes(rq), 'consumed reed queue is removed with the completed run');
  assert.equal(hit.actions.find(a => a.name === rq).reason, 'consumed-by-completed-run');
  const otherLoc = plan([q, r], { readResults: () => results({ location: 'M1' }), queueInfo: () => info });
  assert.equal(names(otherLoc).includes(rq), false, 'different location: not the same run');
  const tooLate = plan([q, r], { readResults: () => results({ completedAt: new Date(qmtime + 4 * 3600000).toISOString() }), queueInfo: () => info });
  assert.equal(names(tooLate).includes(rq), false, 'completion outside the 3 hour window');
  const young = plan([{ ...q, mtimeMs: NOW - DAY }, { ...r, mtimeMs: NOW - DAY + 25 * 60000 }], { readResults: () => results({ completedAt: new Date(NOW - DAY + 25 * 60000).toISOString() }), queueInfo: () => info });
  assert.deepEqual(names(young), [], 'the 3 day retention still applies');
  assert.deepEqual(names(plan([{ ...q, mtimeMs: NOW - 15 * DAY }], { queueInfo: () => ({ ...info, candidates: 2 }) })), [rq], 'no completed run: plain 14 day orphan');
});

test('plan: reed-empty placeholders after 3 days', () => {
  assert.deepEqual(names(plan([file('reed-empty-2026-09-01T10-00-00.json', 4), file('reed-empty-2026-09-28T10-00-00.json', 1)])), ['reed-empty-2026-09-01T10-00-00.json']);
});

test('plan: orphan cv and candidate files at 14 days, with ids and source for the DB check', () => {
  const p = plan([file('cv-5.pdf', 15), file('cv-reed-6.docx', 15), file('candidate-5.json', 15), file('cv-7.pdf', 13), file('candidate-7.json', 1)]);
  assert.deepEqual(names(p).sort(), ['candidate-5.json', 'cv-5.pdf', 'cv-reed-6.docx']);
  const cv = p.actions.find(a => a.name === 'cv-reed-6.docx');
  assert.equal(cv.id, '6');
  assert.equal(cv.source, 'reed');
});

test('plan: stale tmp files, unknown files kept, symlinks and dirs never planned', () => {
  const p = plan([
    file('cv-1.pdf.9.9.tmp', 2), file('cv-2.pdf.9.9.tmp', 0.01), file('mystery.dat.tmp', 0.5), file('mystery2.dat.tmp', 2),
    file('screenshot-1.png', 90), file('notes.txt', 90),
    { name: 'candidate-99.json', type: 'symlink', size: 0, mtimeMs: 0 }, { name: 'sub', type: 'dir', size: 0, mtimeMs: 0 },
  ]);
  assert.deepEqual(names(p).sort(), ['cv-1.pdf.9.9.tmp', 'mystery2.dat.tmp']);
  assert.equal(p.kept.unknown, 2);
  assert.equal(p.kept.nonRegular, 2);
  assert.deepEqual(p.anomalies, [{ code: 'symlink-skipped', name: 'candidate-99.json' }]);
});

test('plan: a hard-kill tmp leftover of a known file is dead after an hour, an unknown tmp only after a day', () => {
  const hours = h => h / 24;
  const q = 'approved-queue-2026-09-29-100000.json';
  const p = plan([
    file(`${q}.4242.1790000000000.tmp`, hours(2)), file(`${q}.4243.1790000000001.tmp`, hours(0.5)),
    file(`${q}.tmp`, hours(3)), file('candidate-8.json.1.2.tmp', hours(5)), file('phase2-results-x.json.1.2.tmp', hours(5)),
    file('cv-reed-anon-8.pdf.1.2.tmp', hours(5)), file('weird.bin.1.2.tmp', hours(5)),
  ]);
  const byName = Object.fromEntries(p.actions.map(a => [a.name, a.reason]));
  assert.equal(byName[`${q}.4242.1790000000000.tmp`], 'hard-kill-tmp');
  assert.equal(byName[`${q}.tmp`], 'hard-kill-tmp');
  assert.equal(byName['candidate-8.json.1.2.tmp'], 'hard-kill-tmp');
  assert.equal(byName['phase2-results-x.json.1.2.tmp'], 'hard-kill-tmp');
  assert.equal(byName['cv-reed-anon-8.pdf.1.2.tmp'], 'hard-kill-tmp');
  assert.equal(`${q}.4243.1790000000001.tmp` in byName, false, 'half an hour old: an atomic write could still be running');
  assert.equal('weird.bin.1.2.tmp' in byName, false, 'unknown name: waits the full tmpDays');
  const tuned = R.planDownloadsSweep({ now: NOW, config: { hardKillTmpHours: 6 }, entries: [file('candidate-8.json.1.2.tmp', hours(5))], readResults: () => undefined, readStatus: () => null, queueInfo: () => null });
  assert.deepEqual(tuned.actions, [], 'hardKillTmpHours is honoured');
});

test('isHardKillTmp: only the temp names of files this package knows, per directory', () => {
  const H = R.isHardKillTmp;
  for (const n of ['approved-queue-2026-09-29-100000.json.1.2.tmp', 'merged-queue-2026-09-29T10-00-00.json.1.2.tmp', 'reed-approved-queue-phase1-x.json.1.2.tmp',
    'phase2-results-abc.json.1.2.tmp', 'candidate-5.json.1.2.tmp', 'cv-5.pdf.1.2.tmp', 'cv-reed-5.docx.1.2.tmp', 'cv-reed-anon-5.txt.1.2.tmp', 'reed-empty-2026-09-01T10-00-00.json.tmp']) {
    assert.equal(H('downloads', n), true, n);
  }
  for (const n of ['approved-queue-2026-09-29-100000.json', 'cv-5.pdf', 'screenshot-1.png.1.2.tmp', 'notes.tmp', 'x.tmp', '.tmp', 'review-tmp-1.json', 'phase1-2026-09-29-100000.json.1.2.tmp']) {
    assert.equal(H('downloads', n), false, n);
  }
  for (const n of ['phase1-2026-09-29-100000.json.1.2.tmp', 'params-watchdog-1.json.1.2.tmp', 'run-merged-queue-x.json.1.2.tmp', 'phase1-x.json.tmp']) assert.equal(H('runs', n), true, n);
  for (const n of ['pipeline-wake.flag.1.2.tmp', 'phase1-x.json', 'other.tmp', 'cv-5.pdf.1.2.tmp']) assert.equal(H('runs', n), false, n);
  assert.equal(H('logs', 'phase1-x.json.1.2.tmp'), false);
  assert.equal(H('downloads', 5), false);
});

test('classifyDownloadName: cv-reed-anon-* is its own class and is never mistaken for a candidate CV', () => {
  const k = n => R.classifyDownloadName(n).kind;
  assert.equal(k('cv-reed-anon-9007.txt'), 'cv-anon');
  assert.equal(k('cv-reed-anon-9007.pdf'), 'cv-anon');
  assert.equal(k('cv-reed-anon-9007'), 'other');
  assert.equal(k('cv-reed-anon-x.pdf'), 'other');
  assert.equal(k('cv-reed-9007.pdf'), 'cv');
  assert.equal(k('cv-9007.pdf'), 'cv');
  assert.deepEqual(R.cvBasenames('9007', 'reed').filter(n => n.includes('anon')), [], 'a candidate cleanup never targets the anonymised copy');
});

test('plan: anonymised Reed CVs are orphans at 14 days and carry no id/source for the pushed-or-not accounting', () => {
  const p = plan([file('cv-reed-anon-9007.txt', 15), file('cv-reed-anon-9008.pdf', 13), file('cv-reed-9009.pdf', 15)]);
  const anon = p.actions.find(a => a.name === 'cv-reed-anon-9007.txt');
  assert.equal(anon.kind, 'cv-anon');
  assert.equal(anon.reason, 'orphan-anonymised');
  assert.equal(anon.id, undefined);
  assert.equal(anon.source, undefined);
  assert.equal(names(p).includes('cv-reed-anon-9008.pdf'), false, 'young: kept');
  assert.equal(p.actions.find(a => a.name === 'cv-reed-9009.pdf').kind, 'cv');
  assert.equal(p.kept.recent, 1);
});

test('normalizeSources: only the dashboard enum passes, case and spaces tolerated', () => {
  assert.deepEqual(R.VALID_SOURCES, ['caterer', 'reed', 'both']);
  for (const [input, want] of [['caterer', 'caterer'], ['Reed', 'reed'], [' BOTH ', 'both'], ['both,reed', null], ['', null], [null, null], [undefined, null], [5, null], ['caterer+reed', null]]) {
    assert.equal(R.normalizeSources(input), want, JSON.stringify(input));
  }
});

test('jailedUnlink still refuses a backslash and a slash in the name (the regex was rewritten without a double-backslash literal)', () => {
  const d = fresh();
  for (const name of [`a${BS}b`, `${BS}`, `x${BS}`, 'a/b', '/', 'a\u0000b']) assert.equal(R.jailedUnlink([d], d, name).reason, 'bad-name', JSON.stringify(name));
  assert.equal(fs.readFileSync(path.join(__dirname, '..', '..', 'resourcer', 'scripts', 'lib', 'cv-retention.js'), 'utf8').includes(BS + BS), false, 'no double-backslash literal in the source');
});
