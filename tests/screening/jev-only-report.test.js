'use strict';
// tools/screening-report.js on rows written by engine jev_only: no LLM data, so no agreement metrics; the report shows the
// Jev lane distribution, approval rate by role and source, a confidence-band histogram, the policy share and the top
// reason codes, and the promotion verdict says "not applicable in jev_only mode".
const h = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const screening = require(h.lib('screening'));
const report = require(path.join(h.REPO, 'tools', 'screening-report.js'));
const REPORT = path.join(h.REPO, 'tools', 'screening-report.js');

let gw;
test.before(async () => { gw = await h.newGateway(); });
test.after(async () => { await gw.close(); });
test.beforeEach(() => { gw.reset(); h.resetHome(); gw.setMode({ llm: 'restricted' }); });

const cfg = screening.loadConfig({ getEnv: () => undefined, file: 'none.json' });
const decide = screening.decide.decide;
const C = (snippet, id) => ({ id, name: 'Zed', snippet: `1. Zed Smith Cook | Leeds, LS1 4AB Unlock candidate Recent experience Other CV snippets Cook Jan 2020 - Current Test Kitchen ${snippet}` });

async function writeKnownLog() {
  const engine = screening.createEngine(screening.loadConfig({ overrides: { engine: 'jev_only', cache: { ttlSec: 0 } } }), { log: () => {} });
  let n = 0;
  const many = (count, tok) => Array.from({ length: count }, () => C(tok, `c${++n}`));
  await engine.screenBatch({ job: 'Chef', location: 'M1', distance: 20, source: 'caterer' }, [...many(10, '[[APPROVE]]'), ...many(5, '[[REJECT]]'), ...many(3, '[[LOWCONF]]'), ...many(2, '[[J:MALFORMED]]')]);
  await engine.screenBatch({ job: 'Chef de Partie', location: 'M1', distance: 20, source: 'reed' }, [...many(2, '[[APPROVE]]'), ...many(1, '[[LOWCONF]]')]);
  await engine.screenOne({ job: 'Chef', location: 'M1', distance: 20, source: 'caterer' }, { id: 'single-1', snippet: C('[[LOWCONF]]', 'x').snippet, title: 'Cook', name: 'Zed' });
  return screening.shadow.readRows({});
}

test('exact numbers from a log written by the engine', async () => {
  const rows = await writeKnownLog();
  assert.equal(rows.length, 24);
  assert.ok(rows.every(r => r.mode === 'jev_only' && r.llm === null));
  assert.equal(gw.stats().calls['POST /v1/chat/completions'] || 0, 0);
  const a = report.analyze(rows, cfg, { decide });
  const j = a.jevOnly;
  assert.equal(j.rows, 24);
  assert.deepEqual(j.lanes, { approve: 12, reject: 5, review: 5, invalid: 2 });
  assert.deepEqual(j.decidedBy, { jev: 17, policy: 5, system: 2 });
  assert.equal(j.undecided, 2, 'the two unusable answers before the unlock were left undecided, not decided by the policy');
  assert.equal(j.policy.total, 5);
  assert.ok(Math.abs(j.policy.share - 5 / 24) < 1e-12);
  assert.deepEqual(j.policy.byWhy, { review: 5 });
  assert.deepEqual(j.policy.byStage, { pre_unlock: 4, post_unlock: 1 });
  assert.equal(j.policy.reject, 4, 'pre-unlock policy rejects');
  assert.equal(j.policy.approve, 1, 'the post-unlock policy approves');
  assert.ok(Math.abs(j.approveRate - 13 / 24) < 1e-12, '12 Jev approvals plus the one post-unlock policy approval');
  assert.deepEqual(j.calibrated, { uncalibrated: 24 });
  const chef = j.byRole.find(x => x.key === 'Chef');
  assert.equal(chef.rows, 21);
  assert.equal(chef.jevDecided, 15);
  assert.ok(Math.abs(chef.jevApproveRate - 10 / 15) < 1e-12);
  assert.equal(j.byRole.find(x => x.key === 'Chef de Partie').rows, 3);
  assert.deepEqual(j.bySource.map(x => [x.key, x.rows]).sort(), [['caterer', 21], ['reed', 3]]);
  assert.deepEqual(j.byStage.map(x => [x.key, x.rows]).sort(), [['post_unlock', 1], ['pre_unlock', 23]]);
  const top = Object.fromEntries(j.topReasonCodes.map(x => [x.code, x.n]));
  assert.equal(top.approve_level_match, 12);
  assert.equal(top.reject_unrelated_industry, 5);
  assert.equal(top.sys_review_policy_reject, 4);
  assert.equal(top.sys_review_policy_approve, 1);
  assert.equal(top.sys_invalid_result, 2);
  assert.ok(j.topReasonCodes[0].n >= j.topReasonCodes[1].n, 'sorted by count');
  const band = j.confidence.histogram.find(b => b.n > 0);
  assert.equal(band.band, '0.95-1');
  assert.equal(band.n, 17);
  assert.equal(band.approve, 12);
  assert.equal(band.reject, 5);
  assert.equal(j.confidence.noConfidence, 7);
  assert.match(report.render(a), /cards left undecided .*: 2$/m);
});

test('the verdict is "not applicable in jev_only mode"; the comparison sections are empty, never NaN', async () => {
  const a = report.analyze(await writeKnownLog(), cfg, { decide });
  assert.equal(a.verdict.status, 'NOT APPLICABLE');
  assert.equal(a.verdict.note, 'not applicable in jev_only mode');
  assert.deepEqual(a.verdict.checks, []);
  assert.equal(a.overall.pairs, 0);
  const text = report.render(a);
  for (const s of ['J. JEV-ONLY MODE', 'Jev lane distribution', 'policy decisions', 'approval rate by role', 'approval rate by source', 'Jev confidence bands', 'top reason codes', '7. VERDICT', 'engine promotion (jev_shadow -> jev): not applicable in jev_only mode', 'sys_review_policy_reject']) {
    assert.ok(text.includes(s), `report contains ${s}`);
  }
  assert.ok(!/NaN|undefined|Infinity/.test(text), 'no NaN or undefined anywhere in the text');
  assert.ok(!/1\. AGREEMENT/.test(text), 'no agreement metrics without an LLM');
  assert.match(text, /Sections 1 to 6 compare Jev with the LLM/);
  assert.ok(!/NaN/.test(JSON.stringify(a)));
});

test('CLI: text, --json and --strict (exit 3 = not applicable) on a jev_only log; a filter to one source works', async () => {
  await writeKnownLog();
  const dir = path.join(h.HOME, 'shadow');
  const txt = await h.runNode(REPORT, ['--dir', dir, '--since', '2d']);
  assert.equal(txt.code, 0, txt.stderr);
  assert.match(txt.stdout, /not applicable in jev_only mode/);
  const js = await h.runNode(REPORT, ['--dir', dir, '--json']);
  const parsed = JSON.parse(js.stdout);
  assert.equal(parsed.verdict.status, 'NOT APPLICABLE');
  assert.equal(parsed.jevOnly.policy.total, 5);
  assert.equal((await h.runNode(REPORT, ['--dir', dir, '--strict'])).code, 3);
  const reed = await h.runNode(REPORT, ['--dir', dir, '--source', 'reed', '--json']);
  assert.equal(JSON.parse(reed.stdout).jevOnly.rows, 3);
  assert.match((await h.runNode(REPORT, ['--help'])).stdout, /3 not applicable/);
});

test('a window that mixes jev_shadow and jev_only rows keeps the old comparison and adds the jev_only section', async () => {
  let seq = 0;
  const shadowRow = () => ({
    v: 1, ts: new Date().toISOString(), mode: 'jev_shadow', source: 'caterer', stage: 'pre_unlock', jobTitle: 'Chef', searchTier: 2, candidateId: `s${++seq}`,
    flags: [], rules: [], used: { engine: 'llm', approved: true, reasonCode: 'approve_other', model: 'm', escalated: false },
    llm: { status: 'ok', model: 'm', approved: true, reasonCode: 'approve_other', confidence: 0.9 },
    jev: { status: 'ok', model: 'typesafe-ai/jev', lane: 'approve', reasonCode: 'approve_level_match', confidence: 0.97, stage: 1 },
  });
  const only = await writeKnownLog();
  const a = report.analyze([shadowRow(), shadowRow(), ...only], cfg, { decide });
  assert.equal(a.overall.pairs, 2, 'only jev_shadow rows are compared');
  assert.equal(a.jevOnly.rows, 24);
  assert.equal(a.volume.rows, 26);
  assert.notEqual(a.verdict.status, 'NOT APPLICABLE', 'the shadow rows still get a verdict');
  const text = report.render(a);
  assert.ok(text.includes('J. JEV-ONLY MODE') && text.includes('1. AGREEMENT'));
});

test('the gold-set export offers policy decisions for labelling; labels score jev_only rows (Jev-decided and policy-decided separately)', async () => {
  const rows = await writeKnownLog();
  const sample = report.exportSample(rows, 24, 3);
  assert.equal(sample.length, 24);
  for (const x of sample) {
    assert.deepEqual(Object.keys(x).filter(k => ['llm', 'jev', 'used', 'policy', 'rules', 'flags'].includes(k)), [], 'independent labels: no model or policy answers');
    assert.equal(x.label, null);
  }
  const policyIds = new Set(rows.filter(r => r.used.engine === 'policy').map(r => r.candidateId));
  const small = report.exportSample(rows, 6, 3);
  assert.ok(small.filter(x => policyIds.has(x.candidateId)).length >= 2, 'the uncertain third of a small sample is filled with policy rows');
  const labels = rows.map(r => ({ candidateId: r.candidateId, jobTitle: r.jobTitle, label: 'approve' }));
  const a = report.analyze(rows, cfg, { decide, labels });
  assert.equal(a.labels.jevOnly.n, 24);
  assert.ok(Math.abs(a.labels.jevOnly.accuracy - 13 / 24) < 1e-12);
  assert.equal(a.labels.jevOnly.jevDecidedN, 17);
  assert.ok(Math.abs(a.labels.jevOnly.jevDecidedAccuracy - 12 / 17) < 1e-12);
  assert.equal(a.labels.jevOnly.policyN, 5);
  assert.ok(Math.abs(a.labels.jevOnly.policyAccuracy - 1 / 5) < 1e-12);
  assert.match(report.render(a), /human labels: jev_only rows accuracy 54\.2% \(n=24\)/);
});

test('an empty window and a log without policy rows do not break the report', () => {
  const a = report.analyze([], cfg, { decide });
  assert.equal(a.jevOnly, null);
  assert.equal(a.verdict.status, 'INSUFFICIENT DATA');
  const one = report.analyze([{ v: 1, ts: new Date().toISOString(), mode: 'jev_only', source: 'caterer', stage: 'pre_unlock', jobTitle: 'Chef', searchTier: 2, candidateId: '1', flags: [], rules: [], rv: 'legacy-1', qv: 'q1', tm: 'legacy', used: { engine: 'jev', approved: true, reasonCode: 'approve_level_match', model: 'm' }, llm: null, jev: { status: 'ok', lane: 'approve', confidence: 0.99 } }], cfg, { decide });
  assert.equal(one.jevOnly.policy.total, 0);
  assert.equal(one.jevOnly.policy.share, 0);
  assert.ok(!/NaN|undefined/.test(report.render(one)));
});

test('the what-if grid re-runs decide() on the stored answers: at the current bars it reproduces the stored lanes', async () => {
  const rows = await writeKnownLog();
  const a = report.analyze(rows, cfg, { decide });
  assert.deepEqual(a.jevOnly.whatIf.map(w => [w.stage, w.rows]), [[1, 21], [2, 1]]);
  const w1 = a.jevOnly.whatIf[0];
  assert.deepEqual(w1.current, { rejectP: 0.9, approveP: 0.6 });
  const cell = w1.grid.find(g => g.rejectP === 0.9 && g.approveP === 0.6);
  assert.deepEqual([cell.approve, cell.reject, cell.review], [12, 5, 4]);
  assert.ok(Math.abs(cell.reviewShare - 4 / 21) < 1e-12);
  assert.ok(Math.abs(cell.approveShareOfDecided - 12 / 17) < 1e-12);
  assert.equal(w1.grid.length, 30);
  const text = report.render(a);
  assert.match(text, /what-if, stage 1 \(21 rows with a stored Jev answer; the current bars are rejectP 0\.9 and approveP 0\.6\)/);
  assert.match(text, /there is no reference in this mode/);
  assert.deepEqual(report.analyze(rows, cfg, {}).jevOnly.whatIf, [], 'without a decide function the grid is simply absent');
});
