'use strict';
// tools/screening-report.js: agreement, reliability, approve rates, false approve/reject, the sweep of the one bar
// (decision.operatingPoint rejectAt), rule table and the go/no-go verdict, reproduced from a fixture log with known numbers.
// The fixture rows hold the answers of the criteria questions and are decided by the real decide().
const h = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const screening = require(h.lib('screening'));
const report = require(path.join(h.REPO, 'tools', 'screening-report.js'));
const REPORT = path.join(h.REPO, 'tools', 'screening-report.js');
const { A } = require('./criteria-answers');

const cfg = screening.loadConfig({ getEnv: () => undefined, file: 'none.json' });
// the same gate scoped to Caterer on purpose (Reed is off until its canary passes)
const cfgC = screening.loadConfig({ getEnv: () => undefined, file: 'none.json', overrides: { gate: { requiredSources: ['caterer'] } } });
const decide = screening.decide.decide;
const compact = screening.decide.compactAnswers;

const RETAIL = { kind: 'not_hospitality', sen: 'not_comparable', hosp: 0.03, area: 0.02, fit: 0.05, rel: [0.95, 0.03, 0.01, 0.01] };
const PROFILES = {
  approve: compact(A({ fit: 0.99 })),
  reject: compact(A({ ...RETAIL })),
  review: compact(A({ inject: 0.9, kw: 1 })),
  // one step below a sous search with the readings at 80% mismatch: R 0.8, rejected at a bar of 0.8 or less, approved above it
  border: compact(A({ role: 'senior_chef', kind: 'cook', sen: 'one_step_junior', fit: 0.2 })),
};

let seq = 0;
function row({ jev, llm, source = 'caterer', role = 'Chef', tier = 2, stage = 'pre_unlock', rules, llmConf = 0.9 }) {
  const dec = decide({ answers: PROFILES[jev], searchRole: role, searchTier: tier, stage: 1 }, cfg);
  return {
    v: 1, ts: new Date().toISOString(), mode: 'jev_shadow', runId: null, source, stage, jobTitle: role, searchTier: tier,
    candidateId: String(++seq), snippetSha: '0123456789abcdef', snippetLen: 100, redacted: true, flags: [], rules: rules || [],
    used: { engine: 'llm', approved: llm === 'approve', reasonCode: llm === 'approve' ? 'approve_other' : 'reject_other', model: 'anthropic/claude-sonnet-5.5', escalated: false },
    llm: { status: 'ok', model: 'anthropic/claude-sonnet-5.5', approved: llm === 'approve', reasonCode: llm === 'approve' ? 'approve_other' : 'reject_other', confidence: llmConf, latencyMs: 10, attempts: 1, backup: false },
    jev: { status: 'ok', model: 'typesafe-ai/jev', lane: dec.lane, reasonCode: dec.reasonCode, reviewReason: dec.reviewReason, confidence: dec.confidence, flags: dec.flags, stage: 1, answers: PROFILES[jev], latencyMs: 20, attempts: 1 },
    rv: 'legacy-1', qv: 's2-0123456789ab', tm: 'legacy',
  };
}
const many = (n, spec) => Array.from({ length: n }, () => row(spec));

// 600 caterer rows with known numbers
function goodRows() {
  return [
    ...many(300, { jev: 'approve', llm: 'approve' }),
    ...many(100, { jev: 'reject', llm: 'reject' }),
    ...many(20, { jev: 'approve', llm: 'reject' }),
    ...many(10, { jev: 'reject', llm: 'approve' }),
    ...many(100, { jev: 'review', llm: 'approve' }),
    ...many(70, { jev: 'review', llm: 'reject' }),
  ];
}

// 600 rows that clear every gate: lane agreement 96%, 4 lost candidates, 12 wasted credits
function strongRows(source) {
  return [
    ...many(300, { jev: 'approve', llm: 'approve', source }),
    ...many(100, { jev: 'reject', llm: 'reject', source }),
    ...many(12, { jev: 'approve', llm: 'reject', source }),
    ...many(4, { jev: 'reject', llm: 'approve', source }),
    ...many(100, { jev: 'review', llm: 'approve', source }),
    ...many(84, { jev: 'review', llm: 'reject', source }),
  ];
}

test('archetype profiles behave as intended under the shipped criteria: approve, reject, and the fallback lane (a double injection flag)', () => {
  assert.deepEqual(['approve', 'reject', 'review'].map(k => decide({ answers: PROFILES[k], searchRole: 'Chef', searchTier: 2, stage: 1 }, cfg).lane), ['approve', 'reject', 'review']);
  assert.equal(decide({ answers: PROFILES.border, searchRole: 'Sous Chef', stage: 1 }, cfg).lane, 'reject');
});

test('numbers are reproduced exactly from the fixture log', () => {
  const a = report.analyze(goodRows(), cfg, { decide });
  const o = a.overall;
  assert.equal(o.pairs, 600);
  assert.equal(o.decided, 430);
  assert.equal(o.review, 170);
  assert.ok(Math.abs(o.coverage - 430 / 600) < 1e-12);
  assert.ok(Math.abs(o.laneAgreement - 400 / 430) < 1e-12);
  assert.ok(Math.abs(o.systemAgreement - 570 / 600) < 1e-12);
  assert.equal(o.falseApprove, 20);
  assert.equal(o.falseReject, 10);
  assert.ok(Math.abs(o.falseApproveRate - 20 / 600) < 1e-12);
  assert.ok(Math.abs(o.llmApproveRate - 410 / 600) < 1e-12);
  assert.ok(Math.abs(o.systemApproveRate - 420 / 600) < 1e-12);
  assert.ok(Math.abs(o.approveDeltaPts - (10 / 600) * 100) < 1e-9);
  assert.ok(Math.abs(o.falseRejectOfLlmApproved - 10 / 410) < 1e-12);
  assert.ok(Math.abs(o.laneCoverage - 430 / 600) < 1e-12);
  assert.equal(o.jevRows, 600);
  assert.deepEqual(a.confusion['jev approve'], { 'llm approve': 300, 'llm reject': 20 });
  assert.deepEqual(a.confusion['jev reject'], { 'llm approve': 10, 'llm reject': 100 });
  assert.deepEqual(a.confusion['jev review'], { 'llm approve': 100, 'llm reject': 70 });
  assert.equal(a.bySource.length, 1);
  assert.equal(a.byRole[0].key, 'Chef');
  assert.equal(a.volume.rows, 600);
});

test('reliability bands: decided rows land in the confidence bands with agreement and a Wilson bound', () => {
  const a = report.analyze(goodRows(), cfg, { decide });
  const top = a.byBand[a.byBand.length - 1];
  assert.equal(top.n, 430);
  assert.ok(Math.abs(top.agreement - 400 / 430) < 1e-12);
  assert.ok(top.agreementLo < top.agreement && top.agreementLo > 0.85);
  assert.ok(top.meanConfidence > 0.96 && top.meanConfidence < 1, `mean stated confidence ${top.meanConfidence}`);
  assert.ok(top.gap < 0, 'stated ~0.97 vs actual 93%: over-confident');
  assert.equal(a.byBand.slice(0, -1).every(b => b.n === 0), true);
  const w = report.wilson(50, 100);
  assert.ok(w.lo > 0.39 && w.lo < 0.41 && w.hi > 0.59 && w.hi < 0.61);
});

test('verdict GO when the gate is met; NO-GO when Jev approves what the LLM rejects; INSUFFICIENT with too little data', () => {
  assert.equal(report.analyze(strongRows('caterer'), cfgC, { decide }).verdict.status, 'GO');
  const bad = [...many(300, { jev: 'approve', llm: 'approve' }), ...many(60, { jev: 'approve', llm: 'reject' }), ...many(100, { jev: 'reject', llm: 'reject' }), ...many(140, { jev: 'review', llm: 'approve' })];
  const nb = report.analyze(bad, cfgC, { decide }).verdict;
  assert.equal(nb.status, 'NO-GO');
  assert.ok(nb.checks.some(c => c.status === 'fail' && /Jev approves/.test(c.name)));
  const few = report.analyze(strongRows('caterer').slice(0, 100), cfgC, { decide }).verdict;
  assert.equal(few.status, 'INSUFFICIENT DATA');
  assert.ok(few.missing.some(m => /caterer: 100 compared rows, need 500/.test(m)));
  assert.equal(report.analyze([], cfgC, { decide }).verdict.status, 'INSUFFICIENT DATA');
  // per-source: a second source with too little data blocks the GO
  const two = report.analyze([...strongRows('caterer'), ...many(40, { jev: 'approve', llm: 'approve', source: 'reed' })], cfgC, { decide }).verdict;
  assert.equal(two.status, 'INSUFFICIENT DATA');
});

test('the fixture that used to be GO now fails: 1.7% lost candidates and a 90% lane-agreement lower bound', () => {
  const v = report.analyze(goodRows(), cfgC, { decide }).verdict;
  assert.equal(v.status, 'NO-GO');
  assert.ok(v.checks.some(c => c.status === 'fail' && /Jev rejects \/ LLM approves \(caterer\)/.test(c.name)));
  assert.ok(v.checks.some(c => c.status === 'fail' && /lane agreement lower bound/.test(c.name)));
});

test('gate: Jev losing 10% of the LLM-approved cards fails even when the two error types cancel out in the approval rate', () => {
  // 200 approve-lane agree, 50 wasted credits, 200 reject-lane agree, 50 lost candidates, 500 review (half approved by the LLM)
  const rows = [
    ...many(200, { jev: 'approve', llm: 'approve' }), ...many(50, { jev: 'approve', llm: 'reject' }),
    ...many(200, { jev: 'reject', llm: 'reject' }), ...many(50, { jev: 'reject', llm: 'approve' }),
    ...many(250, { jev: 'review', llm: 'approve' }), ...many(250, { jev: 'review', llm: 'reject' }),
  ];
  const a = report.analyze(rows, cfgC, { decide });
  assert.ok(Math.abs(a.overall.approveDeltaPts) < 1e-9, 'the approval rates cancel: the old gate could not see this');
  assert.ok(Math.abs(a.overall.systemAgreement - 0.9) < 1e-9, 'system agreement counts the review lane as agreeing by construction');
  assert.ok(Math.abs(a.overall.laneAgreement - 0.8) < 1e-9);
  assert.ok(Math.abs(a.overall.falseRejectOfLlmApproved - 0.1) < 1e-9);
  assert.equal(a.verdict.status, 'NO-GO');
  const failing = a.verdict.checks.filter(c => c.status === 'fail').map(c => c.name);
  assert.ok(failing.some(n => /Jev rejects \/ LLM approves/.test(n)), failing.join('; '));
  assert.ok(failing.some(n => /lost share of LLM-approved/.test(n)), failing.join('; '));
  assert.ok(failing.some(n => /lane agreement lower bound/.test(n)), failing.join('; '));
});

test('gate: Jev that hands almost everything to the fallback lane is not a GO (minimum coverage)', () => {
  const rows = [...many(30, { jev: 'approve', llm: 'approve' }), ...many(30, { jev: 'reject', llm: 'reject' }), ...many(540, { jev: 'review', llm: 'approve' })];
  const v = report.analyze(rows, cfgC, { decide }).verdict;
  assert.equal(v.status, 'NO-GO');
  assert.ok(v.checks.some(c => c.status === 'fail' && /decides on its own/.test(c.name)));
});

test('gate: the engine flip is global, so a Caterer-only log is not a GO unless the gate is scoped to Caterer on purpose', () => {
  const rows = strongRows('caterer');
  const dflt = report.analyze(rows, cfg, { decide }).verdict;
  assert.equal(dflt.status, 'INSUFFICIENT DATA');
  assert.ok(dflt.missing.some(m => /^reed: no compared rows at all/.test(m)), dflt.missing.join('; '));
  assert.equal(report.analyze(rows, cfgC, { decide }).verdict.status, 'GO');
  assert.equal(report.analyze([...rows, ...strongRows('reed')], cfg, { decide }).verdict.status, 'GO');
  const bad = screening.loadConfig({ getEnv: () => undefined, file: 'none.json', overrides: { gate: { requiredSources: ['nowhere'] } } });
  assert.deepEqual(bad.gate.requiredSources, ['caterer', 'reed']);
  assert.ok(bad.warnings.some(w => /requiredSources/.test(w)));
});

test('gate: coverage is measured on the Jev lanes of every row, not only on rows the LLM also answered (engine jev logs)', () => {
  // engine jev: Jev decided 800 rows, only 5% of those carry an LLM audit answer; the 200 review rows all have one
  const rows = [];
  for (let i = 0; i < 800; i++) {
    const r = row({ jev: i % 2 ? 'approve' : 'reject', llm: i % 2 ? 'approve' : 'reject' });
    if (i % 20 !== 0) r.llm = null;
    rows.push(r);
  }
  for (let i = 0; i < 200; i++) rows.push(row({ jev: 'review', llm: i % 2 ? 'approve' : 'reject' }));
  const o = report.analyze(rows, cfgC, { decide }).overall;
  assert.equal(o.jevRows, 1000);
  assert.ok(Math.abs(o.laneCoverage - 0.8) < 1e-12, 'true share of cards Jev decided on its own');
  assert.ok(o.coverage < 0.5, `pair-based coverage ${o.coverage} is biased low in engine jev`);
});

test('recommend() honours the lost-candidate caps and the lane bound, not only the wasted-credit cap', () => {
  const g = cfg.gate;
  const point = over => ({ pairs: 600, decided: 400, systemAgreement: 0.97, falseApproveRate: 0.01, falseRejectRate: 0.005, falseRejectOfLlmApproved: 0.01, laneAgreementLo: 0.95, coverage: 0.6, approveDeltaPts: 0.5, laneAgreement: 0.96, rejectAt: 0.7, ...over });
  assert.ok(report.recommend([point({})], g));
  assert.equal(report.recommend([point({ falseRejectRate: 0.04 })], g), null, 'too many lost candidates');
  assert.equal(report.recommend([point({ falseRejectOfLlmApproved: 0.1 })], g), null, 'too large a share of the LLM-approved cards lost');
  assert.equal(report.recommend([point({ laneAgreementLo: 0.9 })], g), null, 'lane agreement bound too low');
  assert.equal(report.recommend([point({ coverage: 0.1 })], g), null, 'Jev decides too little');
  const best = report.recommend([point({ falseRejectRate: 0.04, coverage: 0.9 }), point({ coverage: 0.5 })], g);
  assert.equal(best.coverage, 0.5, 'the higher-coverage point that breaks a cap is skipped');
});

test('approval-rate delta per role is judged only for roles with enough rows', () => {
  const rows = [...goodRows(), ...many(60, { jev: 'approve', llm: 'reject', role: 'Cook' })];
  const v = report.analyze(rows, cfg, { decide }).verdict;
  assert.ok(v.checks.some(c => /approval rate delta \(Cook\)/.test(c.name) && c.status === 'fail'));
  const tiny = report.analyze([...goodRows(), ...many(10, { jev: 'approve', llm: 'reject', role: 'Cook' })], cfg, { decide }).verdict;
  assert.ok(!tiny.checks.some(c => /\(Cook\)/.test(c.name)));
  assert.ok(tiny.smallRoles.some(s => /^Cook/.test(s)));
});

test('bar sweep re-runs decide() offline: a higher rejectAt moves rejects to approves, every card stays decided; the recommendation respects the gate', () => {
  const rows = [...many(200, { jev: 'border', llm: 'reject', role: 'Sous Chef' }), ...many(200, { jev: 'approve', llm: 'approve', role: 'Sous Chef' })];
  const a = report.analyze(rows, cfg, { decide });
  const s = a.sweeps.find(x => x.stage === 1);
  assert.equal(s.rows, 400);
  assert.equal(s.current, 0.7);
  assert.deepEqual(s.grid.map(g => g.rejectAt), [0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]);
  const at = bar => s.grid.find(g => g.rejectAt === bar);
  assert.ok(Math.abs(at(0.7).coverage - 1) < 1e-12);
  assert.ok(Math.abs(at(0.7).systemAgreement - 1) < 1e-12, 'at 0.7 the border card (R 0.8) is rejected like the LLM did');
  assert.ok(Math.abs(at(0.9).coverage - 1) < 1e-12, 'no bar sends a card to a fallback: the forced choice');
  assert.ok(Math.abs(at(0.9).systemAgreement - 0.5) < 1e-12, 'at 0.9 the border card is approved: it disagrees with the LLM');
  assert.ok(Math.abs(at(0.9).falseApproveRate - 0.5) < 1e-12);
  assert.ok(s.recommended && s.recommended.rejectAt <= 0.8 && s.recommended.systemAgreement === 1);
  assert.ok(s.grid.every(g => typeof g.systemAgreement === 'number'));
  assert.ok(!('approveP' in s.grid[0]) && !('rejectP' in s.grid[0]), 'the two retired bars are not swept');
});

test('bar sweep: rows of the older question set are not re-decided, and a criteria file passed in decides with its own bar', () => {
  const old = row({ jev: 'approve', llm: 'approve' });
  old.jev.answers = { current_tier: { p: { cdp_cook: 1 } }, overall_fit: { p: { 0: 0, 1: 0, 2: 1 } } };
  old.qv = 'q1';
  const a = report.analyze([old, ...many(10, { jev: 'border', llm: 'reject', role: 'Sous Chef' })], cfg, { decide });
  assert.equal(a.sweeps.find(x => x.stage === 1).rows, 10, 'the old row is left out');
  const criteria = JSON.parse(JSON.stringify(screening.criteria.get().criteria));
  criteria.decision.operatingPoint.stage1.rejectAt = 0.85;
  const b = report.analyze(many(10, { jev: 'border', llm: 'reject', role: 'Sous Chef' }), cfg, { decide, criteria });
  assert.equal(b.sweeps.find(x => x.stage === 1).current, 0.85);
});

test('rule table: agreement, disagreements and the promotion check', () => {
  const hit = { id: 'S1-NA-NONHOSP', mode: 'shadow', decision: 'reject' };
  const rows = [
    ...many(249, { jev: 'reject', llm: 'reject', rules: [hit] }),
    row({ jev: 'reject', llm: 'approve', rules: [hit], llmConf: 0.4 }),
    ...many(30, { jev: 'reject', llm: 'reject', rules: [{ id: 'T-UNDER-GAP', mode: 'shadow', decision: 'reject' }] }),
  ];
  const t = report.analyze(rows, cfg, { decide }).rules;
  const na = t.find(x => x.id === 'S1-NA-NONHOSP');
  assert.equal(na.hits, 250);
  assert.equal(na.ruleRejectsLlmApproves, 1);
  assert.ok(Math.abs(na.agreement - 249 / 250) < 1e-12);
  assert.equal(na.promote, true, '250 hits, 99.6% agreement, no high-confidence disagreement');
  assert.equal(t.find(x => x.id === 'T-UNDER-GAP').promote, false, 'only 30 hits');
  const withHi = [...rows, row({ jev: 'approve', llm: 'approve', rules: [hit], llmConf: 0.95 })];
  withHi[withHi.length - 1].llm.approved = true;
  assert.equal(report.analyze(withHi, cfg, { decide }).rules.find(x => x.id === 'S1-NA-NONHOSP').promote, false, 'a high-confidence LLM approval of a rule reject blocks promotion');
});

test('labels: accuracy of each engine against human labels', () => {
  const rows = [row({ jev: 'approve', llm: 'approve' }), row({ jev: 'reject', llm: 'approve' }), row({ jev: 'review', llm: 'reject' })];
  const labels = [{ candidateId: rows[0].candidateId, label: 'approve' }, { candidateId: rows[1].candidateId, label: 'reject' }, { candidateId: rows[2].candidateId, label: 'reject' }];
  const a = report.analyze(rows, cfg, { decide, labels });
  assert.equal(a.labels.matched, 3);
  assert.ok(Math.abs(a.labels.llmAccuracy - 2 / 3) < 1e-12);
  assert.ok(Math.abs(a.labels.jevLaneAccuracy - 1) < 1e-12);
});

test('CLI: text report has every section; --json parses; --strict maps the verdict to exit codes; --criteria loads another file and refuses a broken one', async () => {
  const dir = path.join(h.HOME, 'report-shadow');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const write = rows => fs.writeFileSync(path.join(dir, `screening-${day}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  write([...strongRows('caterer'), ...strongRows('reed')]);
  const txt = await h.runNode(REPORT, ['--dir', dir]);
  assert.equal(txt.code, 0, txt.stderr);
  for (const s of ['1. AGREEMENT', '2. RELIABILITY', '3. BY SOURCE', 'BY ROLE', '4. FALSE-APPROVE', '5. BAR SWEEP', 'rejectAt', '6. STAGE-1 RULES', '7. VERDICT', 'engine promotion (jev_shadow -> jev): GO']) {
    assert.ok(txt.stdout.includes(s), `report contains ${s}`);
  }
  assert.ok(!/THRESHOLD SWEEP|rejectP|approveP/.test(txt.stdout), 'the retired bars are not mentioned');
  const js = await h.runNode(REPORT, ['--dir', dir, '--json']);
  assert.equal(JSON.parse(js.stdout).verdict.status, 'GO');
  assert.equal((await h.runNode(REPORT, ['--dir', dir, '--strict'])).code, 0);
  write([...many(300, { jev: 'approve', llm: 'approve' }), ...many(120, { jev: 'approve', llm: 'reject' }), ...many(100, { jev: 'reject', llm: 'reject' }), ...many(80, { jev: 'review', llm: 'approve' })]);
  assert.equal((await h.runNode(REPORT, ['--dir', dir, '--strict'])).code, 1, 'NO-GO');
  write(goodRows().slice(0, 50));
  assert.equal((await h.runNode(REPORT, ['--dir', dir, '--strict'])).code, 2, 'INSUFFICIENT DATA');
  write(strongRows('caterer'));
  assert.equal((await h.runNode(REPORT, ['--dir', dir, '--strict'])).code, 2, 'a Caterer-only log is INSUFFICIENT under the default gate');
  assert.equal((await h.runNode(REPORT, ['--dir', dir, '--config', path.join(h.HOME, 'no-such-config.json')])).code, 1, 'a mistyped --config is an error, not silently the defaults');
  assert.equal((await h.runNode(REPORT, ['--dir', dir, '--source', 'reed'])).code, 0);
  assert.equal((await h.runNode(REPORT, ['--dir', path.join(h.HOME, 'no-such-dir')])).code, 0, 'an empty log is a valid (insufficient) report');
  assert.equal((await h.runNode(REPORT, ['--help'])).code, 0);
  const crit = h.writeRawConfig(Object.assign(JSON.parse(fs.readFileSync(path.join(h.REPO, 'resourcer', 'config', 'screening-criteria.json'), 'utf8'))), 'report-criteria.json');
  assert.equal((await h.runNode(REPORT, ['--dir', dir, '--criteria', crit])).code, 0);
  const broken = h.writeRawConfig({ version: 'x' }, 'report-broken-criteria.json');
  const bad = await h.runNode(REPORT, ['--dir', dir, '--criteria', broken]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--criteria file unusable/);
  assert.match((await h.runNode(REPORT, ['--help'])).stdout, /--criteria/);
});

test('an end-to-end log written by the engine feeds the report without errors', async () => {
  const gw = await h.newGateway();
  try {
    const eng = screening.createEngine(screening.loadConfig({ overrides: { cache: { ttlSec: 0 } } }), { log: () => {} });
    await eng.screenBatch({ job: 'Chef', location: 'M1', distance: 20 }, Array.from({ length: 12 }, (_, i) => ({ id: String(i), snippet: `Cook | Leeds Recent experience Other CV snippets Cook Jan 2020 - Current X ${i % 2 ? '[[REJECT]]' : '[[APPROVE]]'}` })));
  } finally { await gw.close(); }
  const rows = screening.shadow.readRows({});
  assert.equal(rows.length, 12);
  const a = report.analyze(rows, cfg, { decide });
  assert.equal(a.overall.pairs, 12);
  assert.equal(a.sweeps.find(x => x.stage === 1).rows, 12, 'the rows the engine wrote carry answers the sweep can re-decide');
  assert.ok(report.render(a).includes('VERDICT'));
});

test('gold-set export: redacted inputs only, no model answers, stratified, deterministic; labels round-trip into --labels', async () => {
  const withInput = (spec, i) => ({ ...row(spec), input: `Head Chef | Leeds, <PC> sample ${i}`, ...(spec.stage === 'post_unlock' ? { inputTitle: 'Sous Chef' } : {}) });
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => withInput({ jev: 'approve', llm: 'approve' }, i)),
    ...Array.from({ length: 12 }, (_, i) => withInput({ jev: 'approve', llm: 'reject' }, 100 + i)),
    ...Array.from({ length: 12 }, (_, i) => withInput({ jev: 'review', llm: 'approve' }, 200 + i)),
    row({ jev: 'approve', llm: 'approve' }),
  ];
  const a = report.exportSample(rows, 12, 7);
  const b = report.exportSample(rows, 12, 7);
  assert.deepEqual(a, b, 'deterministic for a seed');
  assert.notDeepEqual(a.map(x => x.candidateId), report.exportSample(rows, 12, 8).map(x => x.candidateId));
  assert.equal(a.length, 12);
  for (const x of a) {
    assert.deepEqual(Object.keys(x).filter(k => ['llm', 'jev', 'used', 'rules', 'flags'].includes(k)), [], 'independent labels: no model answers');
    assert.equal(x.label, null);
    assert.match(x.input, /^Head Chef/);
  }
  const byId = new Map(rows.map(r => [r.candidateId, r]));
  const dis = a.filter(x => { const r = byId.get(x.candidateId); return r.jev.lane === 'approve' && r.llm.approved === false; }).length;
  const unc = a.filter(x => byId.get(x.candidateId).jev.lane === 'review').length;
  assert.ok(dis >= 3, `disagreements ${dis}`);
  assert.ok(unc >= 3, `uncertain ${unc}`);
  assert.ok(a.every(x => x.candidateId !== rows[rows.length - 1].candidateId), 'rows without stored input are never exported');
  // CLI: --export-sample writes a file; the filled file feeds --labels
  const dir = path.join(h.HOME, 'export-shadow');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dir, `screening-${day}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const out = path.join(h.HOME, 'to-label.jsonl');
  const r = await h.runNode(REPORT, ['--dir', dir, '--export-sample', '9', '--seed', '3', '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 9);
  const labelled = lines.map(l => ({ candidateId: l.candidateId, jobTitle: l.jobTitle, label: 'approve' }));
  const lf = path.join(h.HOME, 'labels.jsonl');
  fs.writeFileSync(lf, labelled.map(l => JSON.stringify(l)).join('\n'));
  const rep = await h.runNode(REPORT, ['--dir', dir, '--labels', lf, '--json']);
  assert.equal(JSON.parse(rep.stdout).labels.matched, 9);
});

test('gold-set export: a card Jev decided but flagged as forced (the operating point, not Jev, chose the side) is offered for labelling like any uncertain card', () => {
  const plain = i => ({ ...row({ jev: 'approve', llm: 'approve' }), input: `Cook | Leeds, <PC> plain ${i}` });
  const forced = i => { const r = { ...row({ jev: 'approve', llm: 'approve' }), input: `Cook | Leeds, <PC> forced ${i}` }; r.jev = { ...r.jev, flags: ['forced'], confidence: 0.95 }; return r; };
  const rows = [...Array.from({ length: 60 }, (_, i) => plain(i)), ...Array.from({ length: 6 }, (_, i) => forced(i))];
  const sample = report.exportSample(rows, 9, 5);
  assert.ok(sample.filter(x => /forced/.test(x.input)).length >= 3, 'the uncertain third is filled with forced cards');
});
