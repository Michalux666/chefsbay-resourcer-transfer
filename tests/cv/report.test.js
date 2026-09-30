'use strict';
// scripts/cv-report.js: the owner's numbers from shadow/cv-*.jsonl (shares, forced decisions, operating-point what-if), from stored numbers only.
const { makeHome } = require('./helpers/home');
const home = makeHome('cv-report');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const report = require('../../resourcer/scripts/cv-report');

test.after(() => home.cleanup());
test.beforeEach(() => home.reset());

function writeRows(rows) {
  fs.mkdirSync(home.shadow, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(home.shadow, `cv-${day}.jsonl`), rows.map(r => JSON.stringify({ ts: new Date().toISOString(), mode: 'on', jobTitle: 'Chef', tau: 0.75, finalReasonCodes: [], ...r })).join('\n') + '\n');
}

function run(args) {
  let out = '';
  let err = '';
  const code = report.main(args, { out: s => { out += s; }, err: s => { err += s; } });
  return { code, out, err };
}

const jev = (p, extra) => ({ lane: 'jev', decision: p >= 0.75 ? 'reject' : 'pass', final: p >= 0.75 ? 'reject' : 'approve', pReject: p, forced: p >= 0.2 && p <= 0.8, confidence: p >= 0.75 ? p : 1 - p, ...(extra || {}) });

test('the report counts who decided, the reject rate, the forced decisions and the reason codes', () => {
  const rows = [];
  for (let i = 0; i < 97; i++) rows.push(jev(i < 20 ? 1 : 0, { finalReasonCodes: i < 20 ? ['under_qualified'] : ['pass_relevant_history'] }));
  rows.push(jev(0.6, { candidateId: '11', finalReasonCodes: ['forced', 'pass_doubt', 'no_relevant_experience'] }));
  rows.push(jev(0.78, { candidateId: '12', finalReasonCodes: ['forced', 'no_relevant_experience'] }));
  rows.push({ lane: 'fallback', decision: 'review', final: 'approve', pReject: null, forced: false, confidence: null, finalReasonCodes: ['policy_fallback_approve', 'answers_invalid'] });
  rows.push({ lane: 'unreadable', decision: 'unreadable', final: 'approve', pReject: null, forced: false, confidence: null, finalReasonCodes: ['unreadable_scanned_too_little_text'] });
  writeRows(rows);
  const r = run(['--json', '--forced']);
  assert.equal(r.code, 0);
  const s = JSON.parse(r.out);
  assert.equal(s.rows, 101);
  assert.deepEqual([s.lanes.jev, s.lanes.fallback, s.lanes.unreadable], [99, 1, 1]);
  assert.equal(s.modelled, 100);
  assert.equal(s.jevShare, 99);
  assert.equal(s.fallbackShare, 1);
  assert.equal(s.rejected, 21);
  assert.equal(s.forced, 2);
  assert.equal(s.forcedRejected, 1);
  assert.equal(s.codes.under_qualified, 20);
  assert.deepEqual(s.forcedRows.map(f => f.candidateId), ['11', '12'].sort((a, b) => (a === '11' ? 0.4 : 0.78) - (b === '11' ? 0.4 : 0.78)), 'lowest confidence first');
  assert.equal(s.byJob.Chef.n, 101);
});

test('the honest Jev share counts every screened CV, and the unreadable ones are split into "could not be read" and "no work history found"', () => {
  const rows = [];
  for (let i = 0; i < 90; i++) rows.push(jev(0));
  for (let i = 0; i < 4; i++) rows.push({ lane: 'unreadable', decision: 'unreadable', final: 'approve', pReject: null, forced: false, confidence: null, finalReasonCodes: ['unreadable_scanned_no_text_layer'] });
  for (let i = 0; i < 6; i++) rows.push({ lane: 'unreadable', decision: 'unreadable', final: 'approve', pReject: null, forced: false, confidence: null, finalReasonCodes: ['unreadable_no_work_history'] });
  writeRows(rows);
  const s = JSON.parse(run(['--json']).out);
  assert.equal(s.jevShare, 100, 'the owner rule: CVs Jev had to decide');
  assert.equal(s.jevShareAll, 90, 'all screened CVs');
  assert.equal(s.unreadableNotRead, 4);
  assert.equal(s.unreadableNoWorkHistory, 6);
  const text = run([]).out;
  assert.match(text, /Jev-decided of ALL 100 screened CVs: 90, 90%/);
  assert.match(text, /4 could not be read, 6 were read but no work history could be found/);
});

test('the sweep re-thresholds the stored pReject: a lower bar rejects the doubtful ones, a higher bar passes them', () => {
  writeRows([jev(1), jev(0.6), jev(0.3), jev(0), { lane: 'fallback', decision: 'review', final: 'reject', pReject: null, forced: false, confidence: null }]);
  const s = JSON.parse(run(['--json']).out);
  const at = t => s.sweep.find(x => Math.abs(x.tau - t) < 1e-9).rejected;
  assert.equal(at(0.75), 2, 'one sure reject and the fallback reject');
  assert.equal(at(0.5), 3);
  assert.equal(at(0.25), 4);
  assert.equal(at(0.95), 2);
  assert.equal(at(0.05), 4);
});

test('the text report flags a Jev share below 99 percent and a fallback share above 1 percent, and lists forced decisions on request', () => {
  const rows = [];
  for (let i = 0; i < 90; i++) rows.push(jev(0));
  for (let i = 0; i < 10; i++) rows.push({ lane: 'fallback', decision: 'review', final: 'approve', pReject: null, forced: false, confidence: null, finalReasonCodes: ['answers_invalid'] });
  rows.push(jev(0.5, { candidateId: '77' }));
  writeRows(rows);
  const r = run(['--forced']);
  assert.match(r.out, /BELOW the 99% the owner requires/);
  assert.match(r.out, /ABOVE the 1% the owner allows/);
  assert.match(r.out, /FORCED DECISIONS, LOWEST CONFIDENCE FIRST/);
  assert.match(r.out, /id 77 /);
  assert.match(r.out, /tau 0\.75\*/);
  assert.equal(r.out.includes('id 77 ') && !run([]).out.includes('id 77 '), true, 'forced rows only with --forced');
});

test('filters: --mode and --days; an empty log is a report of zeros, bad flags are exit 1 with the usage', () => {
  writeRows([jev(0, { mode: 'shadow' }), jev(1, { mode: 'on' })]);
  assert.equal(JSON.parse(run(['--json', '--mode', 'shadow']).out).rows, 1);
  assert.equal(JSON.parse(run(['--json', '--mode', 'on']).out).rows, 1);
  assert.equal(JSON.parse(run(['--json', '--from', '2999-01-01']).out).rows, 0);
  home.reset();
  const empty = run([]);
  assert.equal(empty.code, 0);
  assert.match(empty.out, /0 screened CVs/);
  for (const bad of [['--days', 'x'], ['--from', 'yesterday'], ['--mode', 'loud']]) {
    const r = run(bad);
    assert.equal(r.code, 1, bad.join(' '));
    assert.match(r.err, /Usage:/);
  }
  assert.equal(run(['--help']).code, 0);
});

const unread = code => ({ lane: 'unreadable', decision: 'unreadable', final: 'approve', pReject: null, forced: false, confidence: null, finalReasonCodes: [code] });
const fallback = () => ({ lane: 'fallback', decision: 'review', final: 'approve', pReject: null, forced: false, confidence: null, finalReasonCodes: ['answers_invalid'] });
function population({ jevPass, jevReject, unreadable = 0, fallbacks = 0 }) {
  const rows = [];
  for (let i = 0; i < jevPass; i++) rows.push(jev(0));
  for (let i = 0; i < jevReject; i++) rows.push(jev(1, { finalReasonCodes: ['under_qualified'] }));
  for (let i = 0; i < unreadable; i++) rows.push(unread('unreadable_scanned_too_little_text'));
  for (let i = 0; i < fallbacks; i++) rows.push(fallback());
  return rows;
}
const checkOf = (s, name) => s.acceptance.checks.find(c => c.name === name);

test('the switch-on check: every number inside the acceptance is OK, and only the panel review is left', () => {
  writeRows(population({ jevPass: 287, jevReject: 9, unreadable: 24 }));
  const r = run([]);
  const s = JSON.parse(run(['--json']).out);
  assert.equal(s.rows, 320);
  assert.equal(s.acceptance.numbersOk, true);
  assert.deepEqual(s.acceptance.checks.map(c => c.name), ['enough CVs', 'Jev-decided', 'fallback lane', 'unreadable', 'reject rate']);
  assert.ok(s.acceptance.checks.every(c => c.ok));
  assert.match(r.out, /SWITCH-ON CHECK/);
  assert.match(r.out, /numbers OK: only the panel review is left/);
  assert.match(r.out, /\[people\]\s+every decision that rejects \(9\) agreed by the panel/);
  assert.match(r.out, /\[people\]\s+the 30 lowest-confidence forced decisions/);
  assert.equal(r.out.includes('[NOT YET]'), false);
});

test('the switch-on check: each number that is out of its range is NOT YET, and shadow stays', () => {
  const cases = [
    ['too few CVs', { jevPass: 90, jevReject: 3, unreadable: 7 }, 'enough CVs'],
    ['Jev-decided below 99 percent', { jevPass: 287, jevReject: 9, unreadable: 24, fallbacks: 5 }, 'Jev-decided'],
    ['fallback above 1 percent', { jevPass: 285, jevReject: 9, unreadable: 24, fallbacks: 4 }, 'fallback lane'],
    ['unreadable above 12 percent', { jevPass: 250, jevReject: 9, unreadable: 61 }, 'unreadable'],
    ['reject rate above 5 percent', { jevPass: 270, jevReject: 26, unreadable: 24 }, 'reject rate'],
    ['reject rate below 1 percent', { jevPass: 293, jevReject: 3, unreadable: 24 }, 'reject rate'],
  ];
  for (const [label, pop, failing] of cases) {
    writeRows(population(pop));
    const s = JSON.parse(run(['--json']).out);
    assert.equal(checkOf(s, failing).ok, false, label);
    assert.equal(s.acceptance.numbersOk, false, label);
    const text = run([]).out;
    assert.match(text, /\[NOT YET\]/, label);
    assert.match(text, /numbers NOT YET OK: keep CV_SCREEN=shadow/, label);
  }
});

test('the switch-on check never passes on an empty report', () => {
  const s = JSON.parse(run(['--json']).out);
  assert.equal(s.rows, 0);
  assert.equal(s.acceptance.numbersOk, false);
  assert.ok(s.acceptance.checks.every(c => c.ok === false));
});

test('--rejects lists every decision that rejects for the panel, oldest first, with the forced marker; without the flag nothing is listed', () => {
  const rows = [
    jev(1, { candidateId: '31', ts: '2026-09-28T09:00:00.000Z', finalReasonCodes: ['no_relevant_experience'] }),
    jev(0, { candidateId: '32' }),
    jev(0.78, { candidateId: '33', ts: '2026-09-27T09:00:00.000Z', finalReasonCodes: ['forced', 'stale_experience'] }),
  ];
  fs.mkdirSync(home.shadow, { recursive: true });
  fs.writeFileSync(path.join(home.shadow, 'cv-2026-09-28.jsonl'), rows.map(r => JSON.stringify({ ts: new Date().toISOString(), mode: 'shadow', jobTitle: 'Chef', tau: 0.75, finalReasonCodes: [], ...r })).join('\n') + '\n');
  const text = run(['--from', '2026-09-01', '--rejects']).out;
  assert.match(text, /DECISIONS THAT REJECT \(in shadow mode: WOULD reject\), OLDEST FIRST/);
  const listed = text.split('OLDEST FIRST')[1];
  assert.ok(listed.indexOf('id 33') > -1 && listed.indexOf('id 33') < listed.indexOf('id 31'), 'oldest first');
  assert.equal(listed.includes('id 32'), false, 'a pass is not listed');
  assert.match(listed, /id 33 .*forced/);
  assert.equal(run(['--from', '2026-09-01']).out.includes('OLDEST FIRST'), false);
  const j = JSON.parse(run(['--json', '--from', '2026-09-01', '--rejects']).out);
  assert.deepEqual(j.rejectRows.map(x => [x.candidateId, x.forced]), [['33', true], ['31', false]]);
  assert.equal(JSON.parse(run(['--json', '--from', '2026-09-01']).out).rejectRows, undefined);
});
