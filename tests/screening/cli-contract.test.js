'use strict';
// The CLI contract of ai-review.js, exactly as the legacy callers consume it (screening-contract 2, 7.2).
const h = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let gw;
test.before(async () => { gw = await h.newGateway(); });
test.after(async () => { await gw.close(); });
test.beforeEach(() => { gw.reset(); h.resetHome(); });

const APPROVE = h.card('Head Chef', '[[APPROVE]]');
const REJECT = 'Delivery Driver | Leeds [[REJECT]]';

test('batch happy path: one line, input order, ids as strings, keys exactly id,approved,reason', async () => {
  const r = await h.runBatch([{ id: 101, snippet: APPROVE }, { id: '102', snippet: REJECT }, { id: 103, snippet: APPROVE }]);
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes('\n'), 'stdout is a single physical line with no trailing newline');
  assert.match(r.stdout, /^\[\s*[\{\]]/, 'matches the legacy caller parser regex');
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.map(x => x.id), ['101', '102', '103']);
  for (const x of out) {
    assert.deepEqual(Object.keys(x), ['id', 'approved', 'reason']);
    assert.equal(typeof x.id, 'string');
    assert.equal(typeof x.approved, 'boolean');
    assert.ok(x.reason.length > 0 && x.reason.length <= 120);
  }
  assert.deepEqual(out.map(x => x.approved), [true, false, true]);
});

test('stderr: SCREENING_MODEL marker with the engine actually used; no API_UNAVAILABLE; no JSON-looking log lines', async () => {
  const r = await h.runBatch([{ id: 1, snippet: APPROVE }]);
  assert.equal(r.code, 0);
  const lines = r.stderr.split('\n').map(l => l.trim()).filter(Boolean);
  const sm = lines.filter(l => /^SCREENING_MODEL:/.test(l));
  assert.equal(sm.length, 1);
  assert.equal(sm[0], 'SCREENING_MODEL: anthropic/claude-sonnet-5.5', 'jev_shadow: the LLM decided, Jev is only logged');
  assert.ok(!/API_UNAVAILABLE/.test(r.stderr + r.stdout));
  assert.ok(!lines.some(l => /^\[\s*[\{\]]/.test(l)), 'no stderr line may look like the results array');
  assert.equal(lines[lines.length - 1], sm[0], 'marker is the last stderr line');
});

test('the legacy wrapper caterer-ai-review.js behaves identically', async () => {
  const r = await h.runBatch([{ id: 1, snippet: APPROVE }], { script: h.CLI_WRAPPER });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), [{ id: '1', approved: true, reason: 'Fake approve reason' }]);
});

test('reason longer than 120 chars is cut; empty reason becomes Approved/Rejected', async () => {
  const long = 'x'.repeat(300);
  const a = await h.runBatch([{ id: 1, snippet: `[[LLMJSON:{"approved":true,"reason":"${long}","reasonCode":"approve_other","confidence":0.5}]]` }]);
  assert.equal(JSON.parse(a.stdout)[0].reason.length, 120);
  const b = await h.runBatch([{ id: 1, snippet: '[[LLMJSON:{"approved":true,"reason":"","reasonCode":"approve_other","confidence":0.5}]]' }, { id: 2, snippet: '[[LLMJSON:{"approved":false,"reason":"  ","reasonCode":"reject_other","confidence":0.5}]]' }]);
  const out = JSON.parse(b.stdout);
  assert.equal(out[0].reason, 'Approved');
  assert.equal(out[1].reason, 'Rejected');
});

test('single mode prints only {approved, reason}', async () => {
  const r = await h.runSingle(APPROVE);
  assert.equal(r.code, 0);
  const o = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(o), ['approved', 'reason']);
  assert.equal(o.approved, true);
  assert.match(r.stderr, /^SCREENING_MODEL: anthropic\/claude-sonnet-5\.5$/m);
  const rej = await h.runSingle('[[REJECT]] Delivery Driver');
  assert.equal(JSON.parse(rej.stdout).approved, false);
});

test('--help exits 0 with usage on stderr; unknown mode exits 1 with usage; -h works', async () => {
  const help = await h.runNode(h.CLI, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stderr, /Exit codes:/);
  assert.equal(help.stdout, '');
  assert.equal((await h.runNode(h.CLI, ['-h'])).code, 0);
  const bad = await h.runNode(h.CLI, ['--mode', 'bogus']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Usage:/);
  assert.equal((await h.runNode(h.CLI, [])).code, 1);
});

test('input errors exit 1 with FATAL and nothing on stdout', async () => {
  const missing = await h.runNode(h.CLI, ['--mode', 'batch', '--candidates-file', path.join(h.HOME, 'does-not-exist.json')]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^FATAL /m);
  assert.equal(missing.stdout, '');
  const badJson = path.join(h.HOME, 'bad.json');
  fs.writeFileSync(badJson, '{not json');
  assert.equal((await h.runNode(h.CLI, ['--mode', 'batch', '--candidates-file', badJson])).code, 1);
  const notArray = path.join(h.HOME, 'obj.json');
  fs.writeFileSync(notArray, '{"id":1}');
  const na = await h.runNode(h.CLI, ['--mode', 'batch', '--candidates-file', notArray]);
  assert.equal(na.code, 1);
  assert.match(na.stderr, /Candidates must be an array/);
  const nullEl = path.join(h.HOME, 'null.json');
  fs.writeFileSync(nullEl, '[null]');
  assert.equal((await h.runNode(h.CLI, ['--mode', 'batch', '--candidates-file', nullEl])).code, 1);
  assert.equal((await h.runNode(h.CLI, ['--mode', 'batch', '--candidates-file'])).code, 1);
});

test('API unavailable: exit 3, stdout starts API_UNAVAILABLE:, stderr has the token and a SCREENING_MODEL line', async () => {
  gw.setMode({ jev: 'down', llm: 'down' });
  const r = await h.runBatch([{ id: 1, snippet: APPROVE }, { id: 2, snippet: APPROVE }], { env: { SCREEN_MAX_ATTEMPTS: '2' } });
  assert.equal(r.code, 3);
  assert.ok(r.stdout.startsWith('API_UNAVAILABLE:'), r.stdout);
  assert.ok(!r.stdout.includes('\n'));
  assert.match(r.stderr, /API_UNAVAILABLE/);
  assert.match(r.stderr, /^SCREENING_MODEL: \S+/m);
  assert.ok(!/fake-test-key/.test(r.stdout + r.stderr), 'the key never appears');
  const s = await h.runSingle(APPROVE, { env: { SCREEN_MAX_ATTEMPTS: '2' } });
  assert.equal(s.code, 3);
  assert.ok(s.stdout.startsWith('API_UNAVAILABLE:'));
});

test('401, 402, 403: exit 3 and no retries (one call per candidate)', async () => {
  for (const code of ['401', '402', '403']) {
    gw.reset();
    gw.setMode({ llm: code });
    const r = await h.runBatch([{ id: 1, snippet: APPROVE }, { id: 2, snippet: APPROVE }, { id: 3, snippet: APPROVE }]);
    assert.equal(r.code, 3, `HTTP ${code}`);
    assert.ok(r.stdout.startsWith(`API_UNAVAILABLE:`));
    assert.equal(gw.stats().calls['POST /v1/chat/completions'], 3, `HTTP ${code} must not be retried`);
  }
});

test('missing key: exit 3 with marker none, no request made', async () => {
  const r = await h.runBatch([{ id: 1, snippet: APPROVE }], { env: { AI_GATEWAY_API_KEY: '' } });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /^API_UNAVAILABLE:.*AI_GATEWAY_API_KEY/);
  assert.match(r.stderr, /^SCREENING_MODEL: none$/m);
  assert.deepEqual(gw.stats().calls, {});
});

test('empty candidate list prints [] with marker unknown and needs no key', async () => {
  const r = await h.runBatch([], { env: { AI_GATEWAY_API_KEY: '' } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '[]');
  assert.match(r.stderr, /^SCREENING_MODEL: unknown$/m);
});

test('approved must be a strict boolean: the string "false" is invalid, never approved', async () => {
  const r = await h.runBatch([{ id: 1, snippet: '[[LLMSTRBOOL]] [[REJECT]]' }]);
  assert.equal(r.code, 0);
  const o = JSON.parse(r.stdout)[0];
  assert.equal(o.approved, false);
  assert.equal(o.reason, 'Screening result invalid - rejected conservatively');
  assert.equal(gw.stats().calls['POST /v1/chat/completions'], 3, 'primary twice then the backup model');
});

test('requiring the screening library has no side effects', async () => {
  const before = h.walk(h.HOME).sort();
  const code = `require(${JSON.stringify(path.join(h.SCRIPTS, 'lib', 'screening'))}); require(${JSON.stringify(path.join(h.SCRIPTS, 'lib', 'screening-health.js'))}); require(${JSON.stringify(h.CLI)});`;
  const { spawnSync } = require('node:child_process');
  const res = spawnSync(process.execPath, ['-e', code], { env: h.baseEnv(), encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, '');
  assert.equal(res.stderr, '');
  assert.deepEqual(h.walk(h.HOME).sort(), before, 'no files created');
});

test('--candidates-file - reads stdin; --consume-input deletes the file', async () => {
  const r = await h.runNode(h.CLI, ['--mode', 'batch', '--job', 'Chef', '--candidates-file', '-'], { input: JSON.stringify([{ id: 7, snippet: APPROVE }]) });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout)[0].id, '7');
  const f = h.writeCandidates([{ id: 8, snippet: APPROVE }]);
  const r2 = await h.runNode(h.CLI, ['--mode', 'batch', '--job', 'Chef', '--candidates-file', f, '--consume-input']);
  assert.equal(r2.code, 0);
  assert.ok(!fs.existsSync(f), 'input file consumed');
});

test('a snippet that starts with -- is accepted as a value; bad --distance falls back', async () => {
  const r = await h.runNode(h.CLI, ['--mode', 'single', '--job', 'Chef', '--title', 'Cook', '--snippet', '--odd snippet text [[APPROVE]]']);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).approved, true);
  const f = h.writeCandidates([{ id: 1, snippet: APPROVE }]);
  const b = await h.runNode(h.CLI, ['--mode', 'batch', '--distance', 'abc', '--candidates-file', f]);
  assert.equal(b.code, 0);
});

test('no snippet temp files: none after a batch, none after a killed batch; stale legacy leftovers are swept', async () => {
  const dl = path.join(h.HOME, 'downloads');
  fs.mkdirSync(dl, { recursive: true });
  const old = path.join(dl, 'review-tmp-old.json');
  const fresh = path.join(dl, 'review-tmp-fresh.json');
  fs.writeFileSync(old, '[]');
  fs.writeFileSync(fresh, '[]');
  const twoHours = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(old, twoHours, twoHours);
  const r = await h.runBatch([{ id: 1, snippet: APPROVE }]);
  assert.equal(r.code, 0);
  assert.ok(!fs.existsSync(old), 'the 2-hour-old review-tmp file is swept');
  assert.ok(fs.existsSync(fresh), 'a fresh one is left alone');
  fs.rmSync(fresh);
  // killed mid-run: nothing containing snippet text may be on disk
  gw.reset();
  const k = await h.runBatch([{ id: 1, snippet: '[[SLOW:5000]] ZZSNIPPETMARK' }], { killAfterMs: 400 });
  void k;
  const files = h.walk(h.HOME).filter(f => !f.endsWith('cands.json') && !/cands-/.test(f));
  assert.ok(!files.some(f => /review-tmp/.test(f)));
  for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes('ZZSNIPPETMARK'), `${f} must not contain snippet text`);
});

test('--with-codes is opt-in: it adds reasonCode and nothing else; the default output is the legacy shape', async () => {
  const plain = JSON.parse((await h.runBatch([{ id: 1, snippet: '[[REASON:approve_level_match]]' }])).stdout)[0];
  assert.deepEqual(Object.keys(plain), ['id', 'approved', 'reason']);
  const withCodes = JSON.parse((await h.runBatch([{ id: 1, snippet: '[[REASON:approve_level_match]]' }], { extraArgs: ['--with-codes'] })).stdout)[0];
  assert.deepEqual(Object.keys(withCodes), ['id', 'approved', 'reason', 'reasonCode']);
  assert.equal(withCodes.reasonCode, 'approve_level_match');
  const single = JSON.parse((await h.runSingle('[[REJECT]]', { extraArgs: ['--with-codes'] })).stdout);
  assert.deepEqual(Object.keys(single), ['approved', 'reason', 'reasonCode']);
  assert.equal(single.reasonCode, 'reject_no_history');
});

test('single mode can take title, snippet and first name from stdin (--single-file -): nothing personal on the command line, redaction still applies', async () => {
  await fetch(`${gw.origin}/__fake/forbid`, { method: 'POST', body: JSON.stringify({ patterns: ['ZZTESTNAME', 'Smithson', 'ZZ1 1ZZ'] }) });
  const payload = { title: 'Sous Chef', snippet: h.card('Sous Chef', '[[APPROVE]]'), name: 'ZZTESTNAME' };
  const r = await h.runNode(h.CLI, ['--mode', 'single', '--job', 'Chef', '--source', 'caterer', '--single-file', '-'], { input: JSON.stringify(payload) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).approved, true);
  assert.equal(gw.stats().forbiddenHits, 0, 'the name and postcode read from stdin never reach the gateway');
  const viaFlags = await h.runSingle(h.card('Sous Chef', '[[APPROVE]]'), { title: 'Sous Chef' });
  assert.equal(JSON.parse(viaFlags.stdout).approved, true, 'the three flags still work');
  const file = h.writeCandidates(payload, 'single-input.json');
  const viaFile = await h.runNode(h.CLI, ['--mode', 'single', '--job', 'Chef', '--single-file', file, '--consume-input'], {});
  assert.equal(viaFile.code, 0, viaFile.stderr);
  assert.ok(!fs.existsSync(file), 'consumed');
  const bad = await h.runNode(h.CLI, ['--mode', 'single', '--job', 'Chef', '--single-file', '-'], { input: '[1,2]' });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /FATAL .*JSON object/);
});
