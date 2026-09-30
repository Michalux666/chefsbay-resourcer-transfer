'use strict';
// A request the gateway refuses as malformed (HTTP 400, 404, 422, the transport kind 'request') is a fault of ONE CV: it becomes the
// per-CV answers_invalid (fallback lane, settled by the policy, approve by default) and is never asked again. Only a run of such CVs
// (the streak guard, three in a row) escalates to an outage. 5xx, 429, timeouts, 401, 402, 403 and network errors stay outages.
const { makeHome } = require('./helpers/home');
const home = makeHome('cv-refused');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { startFakeJev } = require('./helpers/fake-jev');
const { NOW, role, record, cvText } = require('./helpers/fixtures');
const cv = require('../../resourcer/scripts/lib/cv');
const cache = require('../../resourcer/scripts/lib/cv/cache');

const SCRIPT = path.join(__dirname, '..', '..', 'resourcer', 'scripts', 'cv-review.js');
let gw;
test.before(async () => { gw = await startFakeJev(); });
test.after(async () => { await gw.close(); home.cleanup(); });
test.beforeEach(() => { home.reset(); gw.reset(); home.point(gw); process.env.SCREEN_MAX_ATTEMPTS = '3'; delete process.env.SCREEN_JEV_TIMEOUT_MS; });

const screen = (searchRole, req, ctx, over) => cv.screenCv({ searchRole, ...req, ctx: { cfg: cv.loadConfig({ file: 'no-such-file.json', overrides: over }), now: NOW, ...(ctx || {}) } });
const roles = i => [role('Chef de Partie', `${2010 + i}-01`, 'present')];
const isMain = body => !body.questions.search_level;
const refuse = (status, only) => ({ respond: (idx, body) => (only === 'main' && !isMain(body) ? null : { status, body: { message: 'malformed request', echo: 'CANARY-TEXT-FROM-THE-GATEWAY' } }) });

test('400, 404 and 422 are a per-CV answers_invalid: the fallback lane (approve by default), asked once, no outage, the gateway body never logged', async () => {
  for (const status of [400, 404, 422]) {
    home.reset();
    const g = await startFakeJev(refuse(status));
    home.point(g);
    const logs = [];
    const r = await screen('Chef de Partie', { record: record(roles(0)) }, { log: m => logs.push(m) });
    assert.deepEqual([r.decision, r.lane, r.final], ['review', 'fallback', 'approve'], String(status));
    assert.deepEqual(r.reasonCodes, ['answers_invalid']);
    assert.deepEqual(r.finalReasonCodes, ['policy_fallback_approve', 'answers_invalid']);
    assert.equal(r.evidence.requestRefused, status, 'the refusal status is kept as a number');
    assert.equal(r.searchLevel, 'unknown', 'the level request was refused too: the level rules are off');
    assert.equal(g.stats().requests, 2, 'one level request and one CV request, each sent once: a refused request is never asked again');
    const text = logs.join('\n');
    assert.ok(text.includes(`Jev refused the request (HTTP ${status})`));
    assert.equal(text.includes('CANARY-TEXT-FROM-THE-GATEWAY'), false);
    const rows = home.shadowRows();
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].lane, rows[0].decision, rows[0].evidence.requestRefused], ['fallback', 'review', status]);
    assert.equal(JSON.stringify(rows[0]).includes('CANARY-TEXT-FROM-THE-GATEWAY'), false);
    await g.close();
  }
  home.point(gw);
});

test('the fallback policy still settles a refused CV: reject when configured', async () => {
  const g = await startFakeJev(refuse(422, 'main'));
  home.point(g);
  const r = await screen('Chef de Partie', { record: record(roles(0)) }, null, { fallback: { policy: 'reject' } });
  assert.deepEqual([r.decision, r.lane, r.final], ['review', 'fallback', 'reject']);
  assert.deepEqual(r.finalReasonCodes, ['policy_fallback_reject', 'answers_invalid']);
  await g.close();
  home.point(gw);
});

test('only the request for the level of the searched title is refused: the CV is still decided by Jev, with the level unknown', async () => {
  const g = await startFakeJev({ respond: (idx, body) => (body.questions.search_level ? { status: 400, body: { message: 'x' } } : null) });
  home.point(g);
  const r = await screen('Chef de Partie', { record: record(roles(0)) });
  assert.equal(r.lane, 'jev');
  assert.equal(r.searchLevel, 'unknown');
  assert.ok(['pass', 'reject'].includes(r.decision));
  await g.close();
  home.point(gw);
});

test('three refused CVs in a row are an outage (exit 3 material, reason error); a CV that gets a real answer in between resets the count', async () => {
  let refusing = true;
  const g = await startFakeJev({ respond: (idx, body) => (refusing && isMain(body) ? { status: 422, body: { message: 'x' } } : null) });
  home.point(g);
  const streakFile = () => path.join(home.runtime, 'cv-invalid-streak.json');

  assert.equal((await screen('Chef de Partie', { record: record(roles(0)) })).decision, 'review');
  assert.equal((await screen('Chef de Partie', { record: record(roles(1)) })).decision, 'review');
  assert.equal(JSON.parse(fs.readFileSync(streakFile(), 'utf8')).count, 2);
  await assert.rejects(() => screen('Chef de Partie', { record: record(roles(2)) }), e => e.name === 'ScreeningUnavailable' && e.reasonKey === 'error' && /3 CVs in a row were refused by the gateway \(HTTP 422\)/.test(e.detail));
  assert.equal(home.shadowRows().length, 2, 'the third CV wrote no decision');

  // a real answer resets the streak: refused, refused, ok, refused, refused is still no outage
  home.reset();
  refusing = true;
  await screen('Chef de Partie', { record: record(roles(3)) });
  await screen('Chef de Partie', { record: record(roles(4)) });
  refusing = false;
  assert.equal((await screen('Chef de Partie', { record: record(roles(5)) })).lane, 'jev');
  assert.equal(fs.existsSync(streakFile()), false, 'reset');
  refusing = true;
  assert.equal((await screen('Chef de Partie', { record: record(roles(6)) })).decision, 'review');
  assert.equal((await screen('Chef de Partie', { record: record(roles(7)) })).decision, 'review');
  await g.close();
  home.point(gw);
});

test('a mixed run of refused and unusable answers counts together towards the same streak', async () => {
  let mode = 'refuse';
  const g = await startFakeJev({
    respond: (idx, body) => {
      if (!isMain(body)) return null;
      return mode === 'refuse' ? { status: 400, body: { message: 'x' } } : { status: 200, body: { model: 'typesafe-ai/jev', answers: { overall_match: { type: 'score' } } } };
    },
  });
  home.point(g);
  await screen('Chef de Partie', { record: record(roles(0)) });
  mode = 'unusable';
  await screen('Chef de Partie', { record: record(roles(1)) });
  await assert.rejects(() => screen('Chef de Partie', { record: record(roles(2)) }), e => e.name === 'ScreeningUnavailable' && /in a row/.test(e.detail));
  await g.close();
  home.point(gw);
});

test('outage semantics are unchanged for 401, 402, 403, 429 (after its retries), 5xx and a timeout: the first CV throws, nothing is decided, no streak is kept', async () => {
  const cases = [[401, 'auth', 1], [402, 'credits', 1], [403, 'auth', 1], [429, 'error', 3], [500, 'error', 3], [503, 'error', 3]];
  for (const [status, key, sends] of cases) {
    home.reset();
    const g = await startFakeJev({ respond: () => ({ status, body: { message: 'no' } }) });
    home.point(g);
    await assert.rejects(() => screen('Chef de Partie', { record: record(roles(0)) }), e => e.name === 'ScreeningUnavailable' && e.reasonKey === key, String(status));
    assert.ok(g.stats().requests >= sends, `${status}: ${g.stats().requests} requests`);
    assert.equal(fs.existsSync(path.join(home.runtime, 'cv-invalid-streak.json')), false, `${status} leaves no streak`);
    assert.equal(home.shadowRows().length, 0);
    await g.close();
  }
  home.reset();
  const slow = await startFakeJev({ respond: () => ({ status: 200, body: {}, delayMs: 700 }) });
  home.point(slow);
  process.env.SCREEN_JEV_TIMEOUT_MS = '150';
  process.env.SCREEN_MAX_ATTEMPTS = '2';
  await assert.rejects(() => screen('Chef de Partie', { record: record(roles(0)) }), e => e.name === 'ScreeningUnavailable' && e.reasonKey === 'unreachable');
  assert.equal(home.shadowRows().length, 0);
  await slow.close();
  home.point(gw);
});

// ---- the command line ---------------------------------------------------------------------------------------------------------

function cli(args) {
  return new Promise(resolve => {
    const c = spawn(process.execPath, [SCRIPT, ...args], { env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => c.kill('SIGKILL'), 60000);
    c.stdout.on('data', d => { stdout += d; });
    c.stderr.on('data', d => { stderr += d; });
    c.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    c.stdin.on('error', () => {});
    c.stdin.end('');
  });
}

test('command line: a refused request exits 0 with a fallback-lane decision; the third in a row exits 3 with API_UNAVAILABLE', async () => {
  const g = await startFakeJev(refuse(422, 'main'));
  home.point(g);
  const file = i => { const f = path.join(home.root, `cv-${i}.txt`); fs.writeFileSync(f, cvText(roles(i))); return f; };
  for (const i of [0, 1]) {
    const r = await cli(['--job', 'Chef de Partie', '--cv-file', file(i)]);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual([out.decision, out.lane, out.final, out.reasonCodes], ['review', 'fallback', 'approve', ['answers_invalid']]);
    assert.match(r.stderr, /WARN Jev refused the request \(HTTP 422\)/);
    assert.equal(r.stderr.includes('API_UNAVAILABLE'), false);
  }
  const third = await cli(['--job', 'Chef de Partie', '--cv-file', file(2)]);
  assert.equal(third.code, 3);
  assert.match(third.stdout, /^API_UNAVAILABLE:.*3 CVs in a row were refused by the gateway \(HTTP 422\)$/);
  assert.match(third.stderr, /SCREENING_REASON: error/);
  await g.close();
  home.point(gw);
});

test('the streak file is numbers only and private', async () => {
  const g = await startFakeJev(refuse(400, 'main'));
  home.point(g);
  await screen('Chef de Partie', { record: record(roles(0)) });
  const f = path.join(home.runtime, 'cv-invalid-streak.json');
  const body = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(Object.keys(body).sort(), ['count', 'updatedAt']);
  assert.equal(body.count, 1);
  assert.ok(cache.streakFile().endsWith('cv-invalid-streak.json'));
  await g.close();
  home.point(gw);
});
