'use strict';
// Shadow mode: Jev is only logged and can never change what the pipeline sees. The log is redacted,
// has a fixed schema, no text, sampling, retention.
const h = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const screening = require(h.lib('screening'));
const { ShadowLog, pruneShadow, maybePrune, readRows } = require(h.lib('screening/shadow'));

let gw;
test.before(async () => { gw = await h.newGateway(); });
test.after(async () => { await gw.close(); });
test.beforeEach(() => { gw.reset(); h.resetHome(); });

const JEV = 'POST /typesafe/v1/systemone';
const LLM = 'POST /v1/chat/completions';
const calls = r => gw.stats().calls[r] || 0;
const CTX = { job: 'Chef', location: 'M1', distance: 20 };

function candidates(n) {
  return Array.from({ length: n }, (_, i) => {
    const toks = [i % 3 === 0 ? '[[REJECT]]' : '[[APPROVE]]', i % 7 === 0 ? '[[J:HTTP500]]' : '', i % 11 === 0 ? '[[J:LOWCONF]]' : '', i % 13 === 0 ? '[[J:MALFORMED]]' : ''].join(' ');
    return { id: String(50000 + i), name: 'ZZTESTNAME', snippet: `${i + 1}. ZZTESTNAME Smithson ${i % 2 ? 'Cook' : 'Sous Chef'} | Leeds, ZZ1 1ZZ Unlock candidate Recent experience Other CV snippets Cook Jan 2020 - Current Kitchen ${i} ${toks}` };
  });
}

test('property: stdout is byte-identical with the shadow off, on, with Jev down, and with Jev slow (bounded wait)', async () => {
  const list = candidates(200);
  const cfgFile = h.writeConfig({ shadow: { graceMs: 300 } });
  const runIt = async (env, mode) => {
    gw.reset(); h.resetHome();
    if (mode) gw.setMode(mode);
    const t0 = Date.now();
    const r = await h.runBatch(list, { env: { SCREEN_CONFIG_FILE: cfgFile, ...(env || {}) }, timeoutMs: 120000 });
    return { ...r, ms: Date.now() - t0 };
  };
  const off = await runIt({ SCREEN_SHADOW: '0' });
  assert.equal(off.code, 0, off.stderr);
  assert.equal(calls(JEV), 0, 'shadow off: Jev is never called');
  assert.equal(h.readShadow().length, 0);
  const on = await runIt({});
  assert.equal(on.code, 0);
  assert.equal(on.stdout, off.stdout);
  assert.ok(calls(JEV) >= 200);
  assert.equal(h.readShadow().length, 200);
  const down = await runIt({}, { jev: 'down' });
  assert.equal(down.code, 0);
  assert.equal(down.stdout, off.stdout);
  const slow = await runIt({}, { jev: 'slow', slowMs: 1500 });
  assert.equal(slow.code, 0);
  assert.equal(slow.stdout, off.stdout, 'a slow Jev cannot change results');
  assert.ok(slow.ms < 5000, `slow Jev added ${slow.ms}ms; the wait is bounded by graceMs`);
  assert.equal(slow.stderr.split('\n').filter(l => /^SCREENING_MODEL:/.test(l)).length, 1);
  assert.ok(!/API_UNAVAILABLE/.test(down.stderr + down.stdout + slow.stderr + slow.stdout), 'Jev trouble never looks like screening unavailable');
});

test('rows: fixed schema, pseudonymous ids, hash, length and the REDACTED input only; planted name and postcode never appear anywhere', async () => {
  await fetch(`${gw.origin}/__fake/forbid`, { method: 'POST', body: JSON.stringify({ patterns: ['ZZTESTNAME', 'ZZ1 1ZZ', 'Smithson'] }) });
  const r = await h.runBatch(candidates(20), { env: { SCREEN_CACHE_TTL_SEC: '3600' } });
  assert.equal(r.code, 0);
  const rows = h.readShadow();
  assert.equal(rows.length, 20);
  const FORBIDDEN_KEYS = new Set(['snippet', 'name', 'title', 'reason', 'text', 'employer', 'email', 'phone', 'firstName', 'surname']);
  const scan = (o, p) => {
    if (Array.isArray(o)) return o.forEach((x, i) => scan(x, `${p}[${i}]`));
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { assert.ok(!FORBIDDEN_KEYS.has(k), `forbidden key ${p}.${k}`); scan(v, `${p}.${k}`); }
  };
  for (const row of rows) {
    scan(row, 'row');
    assert.equal(row.v, 1);
    assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(row.mode, 'jev_shadow');
    assert.ok(['caterer', 'reed'].includes(row.source));
    assert.equal(row.stage, 'pre_unlock');
    assert.equal(row.jobTitle, 'Chef');
    assert.equal(row.searchTier, 2);
    assert.match(row.candidateId, /^\d+$/);
    assert.match(row.snippetSha, /^[0-9a-f]{16}$/);
    assert.ok(Number.isInteger(row.snippetLen) && row.snippetLen > 0);
    assert.ok(Array.isArray(row.flags) && Array.isArray(row.rules));
    assert.equal(row.redacted, true);
    assert.equal(typeof row.input, 'string');
    assert.ok(row.input.startsWith('Sous Chef |') || row.input.startsWith('Cook |'), row.input.slice(0, 40));
    assert.ok(row.input.includes('<PC>'));
    assert.equal(row.inputTitle, undefined, 'no title in pre-unlock rows');
    assert.ok(row.used && row.used.engine === 'llm');
    assert.ok(row.llm && row.llm.model);
    if (row.jev && row.jev.status === 'ok') {
      assert.ok(['approve', 'reject', 'review'].includes(row.jev.lane));
      assert.equal(typeof row.jev.answers.candidate_kind.p.cook, 'number');
      assert.equal(row.jev.answers.hospitality_experience >= 0, true);
      assert.equal(typeof row.jev.answers.role_level.p.chef_generic, 'number', 'the role answer is kept with the candidate answers');
      assert.equal(typeof row.jev.answers.x_history_chars, 'number', 'and the card facts');
      assert.ok(Array.isArray(row.jev.flags));
      assert.match(row.qv, /^s2-[0-9a-f]{12}$/);
    }
  }
  assert.equal(gw.stats().forbiddenHits, 0, 'nothing identifying was sent to either engine');
  for (const f of h.walk(h.HOME).filter(x => !/cands-/.test(x))) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/ZZTESTNAME|ZZ1 1ZZ|Smithson/.test(text), `${path.relative(h.HOME, f)} must not contain the planted name or postcode`);
  }
  assert.ok(!/ZZTESTNAME|ZZ1 1ZZ|Smithson/.test(r.stderr + r.stdout));
});

test('sampling: SCREEN_SHADOW_RATE=0.5 compares about half (seeded); 0 compares none; 1 compares all', async () => {
  const cfg = rate => screening.loadConfig({ overrides: { cache: { ttlSec: 0 }, shadow: { rate } } });
  const list = () => Array.from({ length: 200 }, (_, i) => ({ id: String(i), snippet: `Cook | Leeds Recent experience Other CV snippets Cook Jan 2020 - Current X ${i}` }));
  const countJev = async rate => {
    gw.reset(); h.resetHome();
    const engine = screening.createEngine(cfg(rate), { log: () => {}, rng: h.seeded(42) });
    await engine.screenBatch(CTX, list());
    return h.readShadow().filter(r => r.jev && r.jev.status).length;
  };
  const half = await countJev(0.5);
  assert.ok(half >= 80 && half <= 120, `sampled ${half} of 200`);
  assert.equal(await countJev(0), 0);
  assert.equal(await countJev(1), 200);
});

test('a failing shadow log (unwritable directory) never affects screening', async () => {
  fs.writeFileSync(path.join(h.HOME, 'shadow'), 'this is a file, not a directory');
  const shadow = new ShadowLog({});
  const engine = screening.createEngine(screening.loadConfig({ overrides: { cache: { ttlSec: 0 } } }), { log: () => {}, shadow });
  const r = await engine.screenBatch(CTX, [{ id: '1', snippet: 'Cook [[APPROVE]]' }]);
  assert.equal(r.decisions[0].approved, true);
  assert.ok(shadow.failures > 0);
  fs.rmSync(path.join(h.HOME, 'shadow'));
});

test('retention: files older than the window are pruned by their date; the marker limits it to once a day', () => {
  const dir = path.join(h.HOME, 'shadow');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date('2026-09-29T12:00:00Z');
  const day = n => new Date(now.getTime() - n * 86400000).toISOString().slice(0, 10);
  for (const n of [0, 100, 179, 181, 200, 400]) fs.writeFileSync(path.join(dir, `screening-${day(n)}.jsonl`), '{}\n');
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'keep');
  const res = pruneShadow({ dir, days: 180, now: () => now });
  assert.deepEqual(res.deleted.sort(), [181, 200, 400].map(n => `screening-${day(n)}.jsonl`).sort());
  assert.deepEqual(fs.readdirSync(dir).sort(), ['unrelated.txt', ...[0, 100, 179].map(n => `screening-${day(n)}.jsonl`)].sort());
  fs.writeFileSync(path.join(dir, `screening-${day(500)}.jsonl`), '{}\n');
  const first = maybePrune({ dir, days: 180, now: () => now });
  assert.ok(first && first.deleted.length === 1);
  fs.writeFileSync(path.join(dir, `screening-${day(600)}.jsonl`), '{}\n');
  assert.equal(maybePrune({ dir, days: 180, now: () => now }), null, 'second call the same day does nothing');
  assert.equal(maybePrune({ dir, days: 180, now: () => new Date(now.getTime() + 2 * 86400000) }).deleted.length >= 1, true);
});

test('shadow files are private (mode 0600) and named by London date', () => {
  const log = new ShadowLog({ now: () => new Date('2026-07-01T23:30:00Z') });
  assert.ok(log.append({ v: 1, ts: '2026-07-01T23:30:00Z' }));
  const names = fs.readdirSync(path.join(h.HOME, 'shadow'));
  assert.deepEqual(names, ['screening-2026-07-02.jsonl'], '23:30Z in July is 00:30 London time on the 2nd');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(h.HOME, 'shadow', names[0])).mode & 0o777, 0o600);
});

test('readRows skips bad lines and honours since/until', () => {
  const dir = path.join(h.HOME, 'shadow');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'screening-2026-09-01.jsonl'), '{"ts":"2026-09-01T10:00:00Z","a":1}\nnot json\n\n{"ts":"2026-09-02T10:00:00Z","a":2}\n');
  assert.equal(readRows({ dir }).length, 2);
  assert.deepEqual(readRows({ dir, since: new Date('2026-09-02T00:00:00Z') }).map(r => r.a), [2]);
  assert.deepEqual(readRows({ dir, until: new Date('2026-09-01T23:59:59Z') }).map(r => r.a), [1]);
  assert.deepEqual(readRows({ dir: path.join(h.HOME, 'missing') }), []);
});

test('the audit of Jev decisions and the shadow comparison use the same log schema', async () => {
  const cfg = screening.loadConfig({ overrides: { engine: 'jev', decide: { calibration: { calibrated: true } }, cache: { ttlSec: 0 }, shadow: { auditRate: 1 } } });
  const engine = screening.createEngine(cfg, { log: () => {} });
  await engine.screenBatch(CTX, [{ id: '1', snippet: 'Cook Recent experience [[APPROVE]]' }]);
  const row = h.readShadow()[0];
  assert.equal(row.mode, 'jev');
  assert.equal(row.used.engine, 'jev');
  assert.equal(row.llm.status, 'ok');
  assert.equal(row.jev.status, 'ok');
  assert.equal(calls(LLM), 1);
});

test('storing the redacted input can be switched off (shadow.storeText / SCREEN_SHADOW_TEXT); post-unlock rows carry the redacted title', async () => {
  const off = screening.createEngine(screening.loadConfig({ overrides: { cache: { ttlSec: 0 }, shadow: { storeText: false } } }), { log: () => {} });
  await off.screenBatch(CTX, [{ id: '1', name: 'ZZTESTNAME', snippet: '1. ZZTESTNAME Smithson Cook | Leeds, ZZ1 1ZZ Other CV snippets Cook Jan 2020 - Current X' }]);
  let row = h.readShadow()[0];
  assert.equal(row.input, undefined);
  assert.match(row.snippetSha, /^[0-9a-f]{16}$/);
  h.resetHome();
  const on = screening.createEngine(screening.loadConfig({ overrides: { cache: { ttlSec: 0 } } }), { log: () => {} });
  await on.screenOne(CTX, { id: 'single', name: 'ZZTESTNAME', snippet: '1. ZZTESTNAME Smithson Cook | Leeds, ZZ1 1ZZ Other CV snippets Cook Jan 2020 - Current X', title: 'ZZ1 1ZZ' });
  row = h.readShadow()[0];
  assert.equal(row.stage, 'post_unlock');
  assert.equal(row.inputTitle, '', 'a title that is only a mask (a postcode) is no title at all; it is not logged or sent as <PC>');
  assert.ok(!/ZZTESTNAME|Smithson|ZZ1 1ZZ/.test(JSON.stringify(row)));
});

// ---------------------------------------------------------------------------------------------------------- Update C, finding F8 (part 2)
// The snippet install canaries (docs/UPDATE-B.md 7.1, docs/UPDATE-C.md) wrote three rows with runId install-canary into the shadow log, which the
// acceptance report reads. --no-shadow keeps them out, and the readers skip such rows that an instance at Update B already holds.

test('ai-review --no-shadow writes no shadow row (batch and single) and changes nothing else; without it the row is written', async () => {
  const cands = [{ id: 'canary-yes', snippet: h.card('Chef de Partie', '[[APPROVE]]') }, { id: 'canary-no', snippet: 'Retail Cashier | Testville [[REJECT]]' }];
  const cfgFile = h.writeConfig({ shadow: { enabled: true, rate: 1, graceMs: 300 } });
  const env = { SCREEN_CONFIG_FILE: cfgFile };
  const plain = await h.runBatch(cands, { env, extraArgs: ['--run-id', 'install-canary', '--with-codes'] });
  assert.equal(plain.code, 0, plain.stderr);
  const withRows = h.readShadow();
  assert.ok(withRows.length >= 2, 'without the flag the canary rows are logged');
  assert.ok(withRows.every(r => r.runId === 'install-canary'));

  h.resetHome();
  gw.reset();
  const quiet = await h.runBatch(cands, { env, extraArgs: ['--run-id', 'install-canary', '--with-codes', '--no-shadow'] });
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.deepEqual(h.readShadow(), [], 'no row');
  assert.equal(quiet.stdout, plain.stdout, 'the decisions are the same');

  h.resetHome();
  const single = await h.runSingle('Retail Cashier | Testville [[REJECT]]', { env, extraArgs: ['--run-id', 'install-canary', '--no-shadow'] });
  assert.equal(single.code, 0, single.stderr);
  assert.deepEqual(h.readShadow(), []);
});

test('ai-review --help names --no-shadow; it is a flag, never taken for the value of the one before it', async () => {
  const r = await h.runNode(h.CLI, ['--help']);
  assert.match(r.stderr, /--no-shadow/);
  const x = await h.runBatch([{ id: '1', snippet: h.card('Head Chef', '[[APPROVE]]') }], { extraArgs: ['--run-id', '--no-shadow'] });
  assert.equal(x.code, 0, x.stderr);
  assert.deepEqual(h.readShadow(), [], 'the flag after a value flag still counts as a flag');
});

test('readRows skips the rows of run id install-canary unless asked for them; every other row is read', () => {
  const dir = path.join(h.HOME, 'shadow-canary');
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const row = (id, runId) => JSON.stringify({ ts: new Date().toISOString(), id, runId });
  fs.writeFileSync(path.join(dir, `screening-${day}.jsonl`), [row('a', 'install-canary'), row('b', 'phase1-2026-09-30'), row('c', null), row('d', 'install-canary'), row('e', 'install-canary-zdr')].join('\n') + '\n');
  assert.deepEqual(readRows({ dir }).map(r => r.id), ['b', 'c']);
  assert.deepEqual(readRows({ dir, includeCanary: true }).map(r => r.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(require(h.lib('screening/shadow')).INSTALL_CANARY_RUN_ID, 'install-canary');
});
