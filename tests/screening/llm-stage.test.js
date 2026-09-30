'use strict';
// The LLM stage: the normal-LLM decider (default engine) and escalation target. Request shape,
// robust parsing, retries, backup model, failure classes, breaker, fail-open, prompt fidelity.
const h = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const screening = require(h.lib('screening'));
const rubric = require(h.lib('screening/rubric'));
const { ScreeningUnavailable } = require(h.lib('screening/errors'));
const { parseDecision } = require(h.lib('screening/engine'));
const { parseJsonLoose } = require(h.lib('screening/llm-client'));

let gw;
test.before(async () => { gw = await h.newGateway(); });
test.after(async () => { await gw.close(); });
test.beforeEach(() => { gw.reset(); h.resetHome(); });

const JEV = 'POST /typesafe/v1/systemone';
const LLM = 'POST /v1/chat/completions';
const calls = r => gw.stats().calls[r] || 0;
const CTX = { job: 'Chef', location: 'M1', distance: 20 };

function engineWith(overrides, deps) {
  const cfg = screening.loadConfig({ overrides: { cache: { ttlSec: 0 }, ...(overrides || {}) } });
  return { cfg, engine: screening.createEngine(cfg, { log: () => {}, ...(deps || {}) }) };
}
let n = 0;
const C = (snippet, extra) => ({ id: `c${++n}`, name: 'Zed', snippet: `1. Zed Smith Cook | Leeds, LS1 4AB Unlock candidate Recent experience Other CV snippets Cook Jan 2020 - Current Test Kitchen ${snippet}`, ...(extra || {}) });

test('request shape: json_schema strict, all keys required, no temperature, no reasoning, system + user message', async () => {
  gw.state.capture = true;
  const { engine, cfg } = engineWith({ engine: 'llm' });
  await engine.screenBatch(CTX, [C('')]);
  const b = gw.stats().captured.find(x => x.route === LLM).body;
  assert.equal(b.model, 'anthropic/claude-sonnet-5.5');
  assert.equal(b.response_format.type, 'json_schema');
  assert.equal(b.response_format.json_schema.strict, true);
  assert.equal(b.response_format.json_schema.schema.additionalProperties, false);
  assert.deepEqual([...b.response_format.json_schema.schema.required].sort(), Object.keys(b.response_format.json_schema.schema.properties).sort());
  assert.equal(b.temperature, undefined, 'no temperature for 5.x models');
  assert.equal(b.reasoning, undefined);
  assert.equal(b.providerOptions, undefined);
  assert.ok(b.max_tokens <= cfg.llm.maxTokens);
  assert.deepEqual(b.messages.map(m => m.role), ['system', 'user']);
  assert.match(b.messages[0].content, /untrusted data/);
});

test('optional request features come from config: reasoning effort, zero data retention; 4.x models get temperature 0', async () => {
  gw.state.capture = true;
  const { engine } = engineWith({ engine: 'llm', llm: { reasoningEffort: 'low', zeroDataRetention: true } });
  await engine.screenBatch(CTX, [C('')]);
  const b = gw.stats().captured.find(x => x.route === LLM).body;
  assert.deepEqual(b.reasoning, { effort: 'low' });
  assert.deepEqual(b.providerOptions, { gateway: { zeroDataRetention: true } });
  gw.state.captured = [];
  const e4 = engineWith({ engine: 'llm', llm: { model: 'anthropic/claude-sonnet-4-6', backupModel: null } }).engine;
  await e4.screenBatch(CTX, [C('')]);
  assert.equal(gw.stats().captured.find(x => x.route === LLM).body.temperature, 0);
});

test('prompt fidelity: the batch user message is the legacy prompt (one candidate) with the structured tail', async () => {
  gw.state.capture = true;
  const { engine, cfg } = engineWith({ engine: 'llm' });
  const cand = C('');
  await engine.screenBatch({ job: 'Kitchen Porter', location: 'M1', distance: 15 }, [cand]);
  const user = gw.stats().captured.find(x => x.route === LLM).body.messages[1].content;
  const redacted = require(h.lib('screening/redact')).redactSnippet(cand.snippet, { firstName: 'Zed' }).text;
  const expected = rubric.buildBatchPrompt('Kitchen Porter', 'M1', 15, [{ id: cand.id, snippet: redacted }], { output: 'object', tierMode: cfg.tierMode });
  assert.equal(user, expected);
  assert.match(user, /We are searching for: Kitchen Porter within 15 miles of M1\./);
  assert.match(user, /OVER-QUALIFICATION LIMIT for entry-level roles/);
  assert.ok(user.includes(`id: ${cand.id}\nsnippet: Cook | Leeds, <PC> Unlock candidate`));
});

test('post-unlock: the single prompt with the real title, same rules block, fail-open policy', async () => {
  gw.state.capture = true;
  const { engine } = engineWith({ engine: 'llm' });
  const r = await engine.screenOne({ job: 'Chef', location: '', distance: 20 }, { id: 'single', snippet: C('[[APPROVE]]').snippet, title: 'Sous Chef', name: 'Zed' });
  assert.equal(r.decision.approved, true);
  const user = gw.stats().captured.find(x => x.route === LLM).body.messages[1].content;
  assert.match(user, /Candidate's current job title: Sous Chef/);
  assert.match(user, /We have unlocked this candidate \(credit spent\)/);
  assert.ok(user.includes(rubric.buildRubricBody('Chef', { tierMode: 'legacy' })));
});

test('SCREEN_TIER_MODE=fixed reaches the prompt (Commis Chef becomes an entry-level search)', async () => {
  gw.state.capture = true;
  await engineWith({ engine: 'llm', tierMode: 'legacy' }).engine.screenBatch({ ...CTX, job: 'Commis Chef' }, [C('')]);
  assert.match(gw.stats().captured.find(x => x.route === LLM).body.messages[1].content, /is NOT a reason to reject/);
  gw.state.captured = [];
  await engineWith({ engine: 'llm', tierMode: 'fixed' }).engine.screenBatch({ ...CTX, job: 'Commis Chef' }, [C('')]);
  assert.match(gw.stats().captured.find(x => x.route === LLM).body.messages[1].content, /OVER-QUALIFICATION LIMIT/);
});

test('robust parsing: prose around the JSON, fenced JSON, array of one', () => {
  const ok = '{"approved":true,"reason":"r","reasonCode":"approve_other","confidence":0.5}';
  assert.equal(parseJsonLoose(`Sure! ${ok} Thanks`).approved, true);
  assert.equal(parseJsonLoose('```json\n' + ok + '\n```').approved, true);
  assert.equal(parseDecision(`[${ok}]`).approved, true);
  assert.equal(parseDecision('\uFEFF' + ok).approved, true);
  assert.throws(() => parseJsonLoose('no json here'), /not valid JSON/);
  assert.throws(() => parseJsonLoose(''), /empty/);
  assert.throws(() => parseDecision('{"approved":"true"}'), /boolean/);
  assert.throws(() => parseDecision('{"reason":"x"}'), /boolean/);
  assert.throws(() => parseDecision('[1,2]'), /object/);
});

test('decision normalisation: confidence clamped, unknown or contradicting reason codes become <side>_other', () => {
  assert.equal(parseDecision('{"approved":true,"reason":"","reasonCode":"approve_other","confidence":7}').confidence, 1);
  assert.equal(parseDecision('{"approved":true,"reason":"","reasonCode":"approve_other","confidence":-3}').confidence, 0);
  assert.equal(parseDecision('{"approved":true,"reason":"","reasonCode":"approve_other","confidence":"x"}').confidence, null);
  assert.equal(parseDecision('{"approved":true,"reason":"","reasonCode":"nonsense","confidence":1}').reasonCode, 'approve_other');
  assert.equal(parseDecision('{"approved":true,"reason":"","reasonCode":"reject_too_junior","confidence":1}').reasonCode, 'approve_other');
  assert.equal(parseDecision('{"approved":false,"reason":"","reasonCode":"approve_level_match","confidence":1}').reasonCode, 'reject_other');
  assert.equal(parseDecision('{"approved":false,"reason":"","reasonCode":"reject_foh_only","confidence":1}').reasonCode, 'reject_foh_only');
});

test('malformed output classes are retried, then the backup model, then become sys_invalid_result (never an exit)', async () => {
  for (const tok of ['[[LLMLENGTH]]', '[[LLMJSON:this is not json]]', '[[LLMREFUSAL]]', '[[LLMSTRBOOL]]']) {
    gw.reset(); h.resetHome();
    const { engine } = engineWith({ engine: 'llm' });
    const r = await engine.screenBatch(CTX, [C(tok)]);
    const d = r.decisions[0];
    assert.equal(d.source, 'system', tok);
    assert.equal(d.reasonCode, 'sys_invalid_result', tok);
    assert.equal(d.approved, false, tok);
    assert.equal(d.reason, 'Screening result invalid - rejected conservatively', tok);
    assert.equal(calls(LLM), 3, `${tok}: primary x2 then backup x1`);
    assert.equal(r.modelLabel, 'anthropic/claude-sonnet-5.5+anthropic/claude-sonnet-5', 'labelled with the models that were tried, not unknown');
  }
  const log = fs.readFileSync(path.join(h.HOME, 'logs', 'errors.jsonl'), 'utf8');
  assert.match(log, /screening_invalid_result/);
  assert.ok(!/ZZ|Smith|Test Kitchen/.test(log), 'the error log never carries candidate text');
});

test('the backup model takes over when the primary fails or answers garbage', async () => {
  const a = await engineWith({ engine: 'llm' }).engine.screenBatch(CTX, [C('[[L500PRIMARY]]')]);
  assert.equal(a.decisions[0].source, 'llm');
  assert.equal(a.modelLabel, 'anthropic/claude-sonnet-5', 'label = the engine that actually decided');
  assert.equal(calls(LLM), 4, 'primary retried 3x on HTTP 500, then the backup answered');
  gw.reset();
  const b = await engineWith({ engine: 'llm' }).engine.screenBatch(CTX, [C('[[LBADPRIMARY]]')]);
  assert.equal(b.modelLabel, 'anthropic/claude-sonnet-5');
  assert.equal(calls(LLM), 3);
});

test('unavailable: transport failures throw ScreeningUnavailable with a stable reason key; the breaker stops early', async () => {
  gw.setMode({ llm: 'down' });
  const { engine } = engineWith({ engine: 'llm', llm: { maxAttempts: 1 } });
  const many = Array.from({ length: 12 }, () => C(''));
  await assert.rejects(() => engine.screenBatch(CTX, many), e => {
    assert.ok(e instanceof ScreeningUnavailable);
    assert.equal(e.reasonKey, 'unreachable');
    assert.match(e.detail, /3 consecutive candidates/);
    assert.equal(e.label, 'anthropic/claude-sonnet-5.5+anthropic/claude-sonnet-5');
    return true;
  });
  assert.ok(calls(LLM) < 24, `breaker stopped the run early (${calls(LLM)} calls)`);
  gw.reset();
  gw.setMode({ llm: '500' });
  await assert.rejects(() => engine.screenBatch(CTX, [C('')]), e => e.reasonKey === 'error' && e.status === 500);
  gw.reset();
  gw.setMode({ llm: '402' });
  await assert.rejects(() => engine.screenBatch(CTX, [C(''), C('')]), e => e.reasonKey === 'credits');
  gw.reset();
  gw.setMode({ llm: '401' });
  await assert.rejects(() => engine.screenBatch(CTX, [C('')]), e => e.reasonKey === 'auth');
});

test('systemic invalid output (many candidates) is unavailable, not a silent mass reject; a lone bad candidate is a rejection', async () => {
  const { engine } = engineWith({ engine: 'llm' });
  const bad = Array.from({ length: 8 }, () => C('[[LLMJSON:garbage]]'));
  await assert.rejects(() => engine.screenBatch(CTX, bad), e => e instanceof ScreeningUnavailable && /unusable results for 8 of 8/.test(e.detail));
  gw.reset(); h.resetHome();
  const mixed = [C('[[LLMJSON:garbage]]'), ...Array.from({ length: 9 }, () => C('[[APPROVE]]'))];
  const r = await engine.screenBatch(CTX, mixed);
  assert.equal(r.decisions.filter(d => d.source === 'system').length, 1);
  assert.equal(r.decisions.filter(d => d.approved).length, 9);
});

test('single mode fails OPEN on unusable output (credit spent) but still reports unavailability', async () => {
  const { engine } = engineWith({ engine: 'llm' });
  const r = await engine.screenOne(CTX, { id: 'single', snippet: '[[LLMJSON:garbage]]', title: 'Cook' });
  assert.equal(r.decision.approved, true);
  assert.equal(r.decision.reasonCode, 'sys_fail_open');
  assert.match(r.decision.reason, /approved/);
  gw.setMode({ llm: 'down' });
  await assert.rejects(() => engineWith({ engine: 'llm', llm: { maxAttempts: 1 } }).engine.screenOne(CTX, { id: 'single', snippet: 'x', title: 'Cook' }), ScreeningUnavailable);
});

test('llm engine: Jev is never called and the log rows carry no Jev part', async () => {
  const { engine } = engineWith({ engine: 'llm' });
  const r = await engine.screenBatch(CTX, [C('[[APPROVE]]'), C('[[REJECT]]')]);
  assert.equal(calls(JEV), 0);
  assert.equal(r.modelLabel, 'anthropic/claude-sonnet-5.5');
  assert.ok(h.readShadow().every(x => x.jev === null && x.llm.status === 'ok'));
});

test('redaction reaches the wire: a planted name and postcode are never sent (control: redaction off sends them)', async () => {
  await fetch(`${gw.origin}/__fake/forbid`, { method: 'POST', body: JSON.stringify({ patterns: ['ZZTESTNAME', 'ZZ1 1ZZ', 'Smithson'] }) });
  const cand = { id: 'p1', name: 'ZZTESTNAME', snippet: '1. ZZTESTNAME Smithson Head Chef | Leeds, ZZ1 1ZZ Unlock candidate Recent experience Other CV snippets Head Chef Jan 2020 - Current Hotel [[APPROVE]]' };
  await engineWith({ engine: 'jev_shadow', shadow: { auditRate: 1 } }).engine.screenBatch(CTX, [cand]);
  assert.ok(calls(LLM) >= 1 && calls(JEV) >= 1);
  assert.equal(gw.stats().forbiddenHits, 0, 'neither the LLM nor Jev saw the name or postcode');
  gw.reset();
  await fetch(`${gw.origin}/__fake/forbid`, { method: 'POST', body: JSON.stringify({ patterns: ['ZZTESTNAME', 'ZZ1 1ZZ'] }) });
  await engineWith({ engine: 'jev_shadow', redact: { enabled: false } }).engine.screenBatch(CTX, [cand]);
  assert.ok(gw.stats().forbiddenHits > 0, 'control: with redaction off the guard does see them');
});

test('default engine jev_shadow: the LLM decides; a Jev outage or a Jev disagreement changes nothing', async () => {
  const { engine } = engineWith({});
  const list = () => [C('[[APPROVE]]'), C('[[REJECT]]'), C('[[APPROVE]]')];
  const base = await engine.screenBatch(CTX, list());
  gw.reset(); h.resetHome();
  gw.setMode({ jev: 'down' });
  const down = await engineWith({ jev: { maxAttempts: 1 } }).engine.screenBatch(CTX, list());
  assert.deepEqual(down.decisions.map(d => [d.approved, d.source]), base.decisions.map(d => [d.approved, d.source]));
  assert.equal(down.modelLabel, 'anthropic/claude-sonnet-5.5');
  gw.reset(); h.resetHome();
  // Jev disagrees with the LLM on every candidate: still the LLM's decision
  const dis = await engine.screenBatch(CTX, [C('[[L:APPROVE]] [[J:REJECT]]'), C('[[L:REJECT]] [[J:APPROVE]]')]);
  assert.deepEqual(dis.decisions.map(d => d.approved), [true, false]);
  const rows = h.readShadow();
  assert.deepEqual(rows.map(r => [r.llm.approved, r.jev.lane]), [[true, 'reject'], [false, 'approve']]);
});

test('batch.onInvalid=approve makes an unusable answer fail open instead of a conservative reject', async () => {
  const { engine } = engineWith({ engine: 'llm', batch: { onInvalid: 'approve' } });
  const r = await engine.screenBatch(CTX, [C('[[LLMJSON:garbage]]')]);
  assert.equal(r.decisions[0].approved, true);
  assert.equal(r.decisions[0].reasonCode, 'sys_fail_open');
  const bad = screening.loadConfig({ overrides: { batch: { onInvalid: 'maybe' } } });
  assert.equal(bad.batch.onInvalid, 'reject');
  assert.ok(bad.warnings.some(w => /onInvalid/.test(w)));
});

test('rubric variants reach the wire and the log (SCREEN_INSUFFICIENT=lenient, stale clause), and change the cache signature', async () => {
  gw.state.capture = true;
  const { engine } = engineWith({ engine: 'llm', rubric: { insufficientEvidence: 'lenient', staleProfileClause: true } });
  await engine.screenBatch(CTX, [C('')]);
  const user = gw.stats().captured.find(x => x.route === LLM).body.messages[1].content;
  assert.match(user, /very little detail is NOT enough to reject/);
  assert.match(user, /out of date/);
  assert.equal(h.readShadow()[0].rv, 'legacy-1+lenient+stale');
  const bad = screening.loadConfig({ overrides: { rubric: { insufficientEvidence: 'harsh' } } });
  assert.equal(bad.rubric.insufficientEvidence, 'legacy');
  assert.ok(bad.warnings.some(w => /insufficientEvidence/.test(w)));
  const viaEnv = screening.loadConfig({ getEnv: n => (n === 'SCREEN_INSUFFICIENT' ? 'LENIENT' : undefined), file: 'none.json' });
  assert.equal(viaEnv.rubric.insufficientEvidence, 'lenient');
});

test('a primary model the gateway rejects as a bad request is skipped after two failures in a run; the backup decides', async () => {
  const { engine } = engineWith({ engine: 'llm', llm: { model: 'anthropic/nonexistent-model', concurrency: 1 } });
  const r = await engine.screenBatch(CTX, Array.from({ length: 6 }, () => C('[[APPROVE]]')));
  assert.ok(r.decisions.every(d => d.source === 'llm' && d.approved));
  assert.equal(r.modelLabel, 'anthropic/claude-sonnet-5');
  const requests = gw.stats().requests.filter(x => x.route === LLM);
  const backup = requests.filter(x => /claude-sonnet-5$/.test(x.model)).length;
  assert.equal(backup, 6);
  assert.equal(calls(LLM) - backup, 2, 'the bad primary was tried twice, then skipped');
});

test('a request-level 4xx on the primary AND the backup is unavailable, never a reject, on pages of any size', async () => {
  for (const n of [1, 2, 3, 4, 10]) {
    gw.reset(); h.resetHome();
    const { engine } = engineWith({ engine: 'llm', llm: { model: 'anthropic/nonexistent-1', backupModel: 'anthropic/nonexistent-2' } });
    await assert.rejects(() => engine.screenBatch(CTX, Array.from({ length: n }, () => C('[[APPROVE]]'))), e => {
      assert.ok(e instanceof ScreeningUnavailable, 'n=' + n);
      assert.equal(e.reasonKey, 'error');
      assert.equal(e.label, 'anthropic/nonexistent-1+anthropic/nonexistent-2', 'the run is labelled with the models it tried');
      return true;
    });
  }
  gw.reset(); h.resetHome();
  await assert.rejects(() => engineWith({ engine: 'llm' }).engine.screenBatch(CTX, [C('[[L:HTTP422]]')]), e => e instanceof ScreeningUnavailable);
});

test('a 4xx on the primary only still lets the backup decide (no false alarm)', async () => {
  const { engine } = engineWith({ engine: 'llm', llm: { model: 'anthropic/nonexistent-1' } });
  const r = await engine.screenBatch(CTX, [C('[[APPROVE]]'), C('[[REJECT]]')]);
  assert.deepEqual(r.decisions.map(d => [d.source, d.approved]), [['llm', true], ['llm', false]]);
});

test('no model configured at all is unavailable, not a silent reject', async () => {
  const cfg = screening.loadConfig({ overrides: { cache: { ttlSec: 0 }, engine: 'llm' } });
  cfg.llm.model = null;
  cfg.llm.backupModel = null;
  const engine = screening.createEngine(cfg, { log: () => {} });
  await assert.rejects(() => engine.screenBatch(CTX, [C(''), C('')]), e => e instanceof ScreeningUnavailable);
  await assert.rejects(() => engine.screenBatch(CTX, [C('')]), e => e instanceof ScreeningUnavailable);
});

test('unusable output for every candidate of a call of two or more is unavailable (refusal, truncation, non-JSON, wrong type)', async () => {
  for (const tok of ['[[LLMLENGTH]]', '[[LLMJSON:this is not json]]', '[[LLMREFUSAL]]', '[[LLMSTRBOOL]]']) {
    for (const n of [2, 3, 4]) {
      gw.reset(); h.resetHome();
      const { engine } = engineWith({ engine: 'llm' });
      await assert.rejects(() => engine.screenBatch(CTX, Array.from({ length: n }, () => C(tok))), e => {
        assert.ok(e instanceof ScreeningUnavailable, tok + ' n=' + n);
        assert.match(e.detail, /unusable results for/);
        return true;
      });
    }
  }
  gw.reset(); h.resetHome();
  const { engine } = engineWith({ engine: 'llm' });
  const r = await engine.screenBatch(CTX, [C('[[LLMJSON:garbage]]'), C('[[APPROVE]]')]);
  assert.deepEqual(r.decisions.map(d => d.reasonCode === 'sys_invalid_result'), [true, false], 'one poison card next to a good one is a per-candidate result');
});

test('cross-call streak: unusable answers on one-candidate pages trip on the third in a row, a success in between resets it', async () => {
  const streakFile = path.join(h.HOME, 'runtime', 'screening-invalid-streak.json');
  const { engine } = engineWith({ engine: 'llm' });
  for (let i = 0; i < 2; i++) {
    const r = await engine.screenBatch(CTX, [C('[[LLMJSON:x]]')]);
    assert.equal(r.decisions[0].reasonCode, 'sys_invalid_result');
  }
  assert.equal(JSON.parse(fs.readFileSync(streakFile, 'utf8')).count, 2);
  await assert.rejects(() => engine.screenBatch(CTX, [C('[[LLMJSON:x]]')]), e => e instanceof ScreeningUnavailable && /3 candidates in a row/.test(e.detail));
  // a call with any usable answer ends the streak
  const ok = await engine.screenBatch(CTX, [C('[[APPROVE]]')]);
  assert.equal(ok.decisions[0].approved, true);
  assert.ok(!fs.existsSync(streakFile), 'the streak file is removed after a success');
  for (let i = 0; i < 2; i++) await engine.screenBatch(CTX, [C('[[LLMJSON:x]]')]);
  await engine.screenBatch(CTX, [C('[[APPROVE]]')]);
  for (let i = 0; i < 2; i++) await engine.screenBatch(CTX, [C('[[LLMJSON:x]]')]);
  assert.equal(JSON.parse(fs.readFileSync(streakFile, 'utf8')).count, 2, 'never reached 3 consecutive');
});

test('cross-call streak: an old streak (past the TTL) does not count against a fresh problem; post-unlock single mode never touches it', async () => {
  const streakFile = path.join(h.HOME, 'runtime', 'screening-invalid-streak.json');
  fs.mkdirSync(path.dirname(streakFile), { recursive: true });
  fs.writeFileSync(streakFile, JSON.stringify({ count: 2, updatedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString() }));
  const { engine } = engineWith({ engine: 'llm' });
  const r = await engine.screenBatch(CTX, [C('[[LLMJSON:x]]')]);
  assert.equal(r.decisions[0].reasonCode, 'sys_invalid_result');
  assert.equal(JSON.parse(fs.readFileSync(streakFile, 'utf8')).count, 1);
  fs.writeFileSync(streakFile, JSON.stringify({ count: 2, updatedAt: new Date().toISOString() }));
  const single = await engine.screenOne(CTX, { id: 'single', snippet: '[[LLMJSON:x]]', title: 'Cook' });
  assert.equal(single.decision.reasonCode, 'sys_fail_open');
  assert.equal(JSON.parse(fs.readFileSync(streakFile, 'utf8')).count, 2);
});

test('the CLI turns every silent-reject path into exit 3: 4xx from both models, all-invalid pages and the streak', async () => {
  for (const cands of [[C('[[APPROVE]]')], [C('[[LLMJSON:x]]'), C('[[LLMJSON:x]]')]]) {
    gw.reset(); h.resetHome();
    const env = cands.length === 1 ? { SCREEN_LLM_MODEL: 'anthropic/nonexistent-1', SCREEN_LLM_BACKUP_MODEL: 'anthropic/nonexistent-2', SCREEN_ENGINE: 'llm' } : { SCREEN_ENGINE: 'llm' };
    const r = await h.runBatch(cands, { env });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /^API_UNAVAILABLE:/);
    assert.match(r.stderr, /SCREENING_MODEL: anthropic\//);
  }
});

test('a post-unlock title that is only a mask (a postcode in the title field) counts as no title: Jev gets the stage-1 questions', async () => {
  const { engine } = engineWith({});
  await engine.screenOne(CTX, { id: 'single', snippet: C('[[APPROVE]]').snippet, title: 'LS1 4AB', name: 'Zed' });
  const jevReq = gw.stats().requests.find(x => x.route === JEV);
  assert.ok(jevReq, 'Jev was asked in the shadow');
  assert.ok(!jevReq.questions.includes('real_title_tier'), 'no stage-2 question about a title that is just <PC>');
  assert.equal(h.readShadow()[0].jev.stage, 1);
});
