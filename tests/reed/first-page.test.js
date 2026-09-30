'use strict';

// The Reed "first page failed" incident of 2026-09-30 (HTTP 400, RequiredHeaderMissingException, code 50010) reproduced in the fakes, and the
// request path that no longer depends on one hypothesis: token embedded in the SAME evaluation, JWT check, wait for an idle tab on the search
// page, bounded retries on 400/50010 with one re-capture, one forensic line per failed attempt. See docs/parity/reed-first-page.md.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { withWorld, validSession, writeSession } = require('./helpers/world');
const { HEADER_MISSING_BODY } = require('./helpers/fake-reed');

const world = (fn, o) => withWorld(fn, { fake: { loggedIn: true }, ...(o || {}) });
const SEARCH = "await bf.reedBrowserFetchPost('/candidate/search/boolean/', { currentPage: 1, pageItemCount: 25 })";
const FAST = { REED_RETRY_BACKOFF_MS: '50', REED_RETRY_CAP_MS: '20000', REED_TAB_SETTLE_MS: '0' };
const FORENSIC = /^\[reed-browser-fetch\] REED_REQUEST_FORENSIC (.*)$/gm;
const forensic = (stderr) => [...stderr.matchAll(FORENSIC)].map((m) => Object.fromEntries(m[1].split(' ').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; })));
const get = (url, headers) => new Promise((resolve, reject) => {
  http.get(url, { headers }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
});

test('R1 harness: the fake API answers an absent or empty bearer with 400 / 50010 (the live signature) and a wrong token with 401', () => world(async ({ fake }) => {
  const base = `${fake.apiBase}/monetization/daily-usage/`;
  const none = await get(base, {});
  const empty = await get(base, { Authorization: 'Bearer ' });
  const junk = await get(base, { Authorization: 'Bearer not-a-known-token' });
  assert.strictEqual(none.status, 400);
  assert.strictEqual(empty.status, 400);
  assert.deepStrictEqual(JSON.parse(none.body), HEADER_MISSING_BODY);
  assert.strictEqual(junk.status, 401);
}));

test('R1 reproduction: a navigation that wipes the page token variable between the seed and the POST no longer produces an empty bearer', () => world(async ({ m, fake, drive }) => {
  const tok = validSession(m, fake);
  fake.site.wipeTokenAfterSeed = 1;
  const r = await drive(`const bf = require('./reed-browser-fetch'); const res = ${SEARCH}; return res.result.totalItemCount;`);
  assert.ok(r.ok, `${JSON.stringify(r.error)} ${r.stderr}`);
  assert.strictEqual(r.result, 30);
  assert.ok(fake.api.requests.length >= 1 && fake.api.requests.every((q) => q.auth === `Bearer ${tok}`), 'every request carried the token');
  assert.strictEqual(fake.api.headerMissingAnswers, 0, 'the API never saw an empty bearer');
}));

test('R1 reproduction: the document is replaced right after the first and second evaluations (any reload timing) and the search still succeeds', () => world(async ({ m, fake, drive }) => {
  const tok = validSession(m, fake);
  fake.site.reloadAfterEvals = [1, 2];
  const r = await drive(`const bf = require('./reed-browser-fetch'); const res = ${SEARCH}; return res.result.totalItemCount;`, { env: FAST });
  assert.ok(r.ok, `${JSON.stringify(r.error)} ${r.stderr}`);
  assert.strictEqual(r.result, 30);
  assert.strictEqual(fake.api.headerMissingAnswers, 0);
  assert.ok(fake.api.requests.every((q) => q.auth === `Bearer ${tok}`));
  assert.ok(fake.site.reloads >= 1, 'the reload really happened');
}));

test('R2 (c): a page that is still loading and not initialised (answers 400 to everything) is waited for, so the first request is not sent too early', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  fake.site.loadMs = 1500;
  fake.site.initMs = 1500;
  const r = await drive(`const bf = require('./reed-browser-fetch'); const res = ${SEARCH}; return res.result.totalItemCount;`, { env: { REED_TAB_SETTLE_MS: '100', REED_RETRY_BACKOFF_MS: '50' } });
  assert.ok(r.ok, `${JSON.stringify(r.error)} ${r.stderr}`);
  assert.strictEqual(r.result, 30);
  assert.strictEqual(fake.site.initRejects, 0, 'nothing was sent before the page was ready');
  assert.strictEqual(forensic(r.stderr).length, 0, 'no failed attempt, so no forensic line');
}));

test('R2 (c): an SPA redirect shortly after the load (a second document) is waited out as well', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  fake.site.spaReloadMs = 500;
  fake.site.initMs = 900;
  const r = await drive(`const bf = require('./reed-browser-fetch'); const res = ${SEARCH}; return res.result.totalItemCount;`, { env: { REED_TAB_SETTLE_MS: '1000', REED_RETRY_BACKOFF_MS: '50' } });
  assert.ok(r.ok, `${JSON.stringify(r.error)} ${r.stderr}`);
  assert.strictEqual(fake.site.initRejects, 0);
}));

test('R2 (d): 400 / 50010 with a healthy token is retried (tab re-verified, token captured once more) and succeeds on the third attempt; one forensic line per failed attempt', () => world(async ({ m, fake, drive }) => {
  const tok = validSession(m, fake);
  fake.api.failNext = [{ status: 400, body: HEADER_MISSING_BODY, path: '/candidate/search/' }, { status: 400, body: HEADER_MISSING_BODY, path: '/candidate/search/' }];
  const r = await drive(`const bf = require('./reed-browser-fetch'); const res = ${SEARCH}; return res.result.totalItemCount;`, { env: FAST });
  assert.ok(r.ok, `${JSON.stringify(r.error)} ${r.stderr}`);
  assert.strictEqual(r.result, 30);
  const f = forensic(r.stderr);
  assert.strictEqual(f.length, 2);
  assert.deepStrictEqual(f.map((x) => x.attempt), ['1/3', '2/3']);
  assert.ok(f.every((x) => x.status === '400' && x.code === '50010'));
  assert.strictEqual(fake.methods().filter((x) => x === 'Page.navigate').length, 1, 'the token is re-captured once, not on every retry');
  assert.ok(!(r.stdout + r.stderr).includes(tok), 'the token is never printed');
}));

test('R2 (e): the forensic line names headers, token presence and size bucket, path without query, timings and whether a navigation was seen, and nothing secret', () => world(async ({ m, fake, drive }) => {
  const tok = validSession(m, fake);
  fake.api.failNext = [{ status: 400, body: HEADER_MISSING_BODY, path: '/candidate/search/' }];
  const r = await drive(`const bf = require('./reed-browser-fetch'); ${SEARCH}; return 'ok';`, { env: FAST });
  assert.ok(r.ok, `${JSON.stringify(r.error)} ${r.stderr}`);
  const [f] = forensic(r.stderr);
  assert.ok(f, r.stderr);
  assert.strictEqual(f.headers, 'Authorization,Content-Type,Accept');
  assert.strictEqual(f.token, 'yes');
  assert.match(f.len, /^(<100|100-299|300-599|600-999|1000\+)$/);
  assert.strictEqual(f.path, '/recruiter/v2/candidates/search/results');
  assert.match(f.sinceNavMs, /^\d+$/);
  assert.match(f.sinceTokenMs, /^\d+$/);
  assert.strictEqual(f.navDuringRequest, 'no');
  assert.strictEqual(f.readyState, 'complete');
  const payload = tok.split('.');
  for (const part of payload) assert.ok(!(r.stdout + r.stderr).includes(part), 'no part of the token is logged');
  assert.ok(!/Bearer/.test(r.stderr), 'no Authorization value');
}));

test('R2 (d): a persistent 400 / 50010 fails after three attempts with the HTTP 400 message intact (status attached), never an empty success', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  fake.api.alwaysHeaderMissing = true;
  const r = await drive(`
    const bf = require('./reed-browser-fetch');
    try { ${SEARCH}; return 'no error'; } catch (e) { return { m: e.message.slice(0, 60), status: e.status, attempts: e.attempts }; }
  `, { env: FAST });
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.match(r.result.m, /^Reed API POST HTTP 400: /);
  assert.strictEqual(r.result.status, 400);
  assert.strictEqual(r.result.attempts, 3);
  assert.strictEqual(forensic(r.stderr).length, 3);
  assert.strictEqual(fake.api.headerMissingAnswers, 3);
}));

test('R2 (d): the retries have a total time cap, so the Reed phase stays bounded', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  fake.api.alwaysHeaderMissing = true;
  const t0 = Date.now();
  const r = await drive(`
    const bf = require('./reed-browser-fetch');
    try { ${SEARCH}; return 'no error'; } catch (e) { return { status: e.status, attempts: e.attempts }; }
  `, { env: { ...FAST, REED_RETRY_BACKOFF_MS: '400', REED_RETRY_CAP_MS: '500' } });
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.strictEqual(r.result.status, 400);
  assert.ok(r.result.attempts < 3, `the cap stopped the retries (attempts ${r.result.attempts})`);
  assert.ok(Date.now() - t0 < 15000);
}));

test('R2 (d): other 4xx keep their handling and are not retried: 401 and 403 are relogin, 429 is a plain HTTP error, each sent once', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  const out = [];
  for (const status of [401, 403, 429]) {
    fake.api.failNext = [{ status, path: '/candidate/search/' }];
    const before = fake.api.requests.length;
    const r = await drive(`
      const bf = require('./reed-browser-fetch');
      try { ${SEARCH}; return 'no error'; } catch (e) { return { m: e.message.slice(0, 30), status: e.status }; }
    `, { env: FAST });
    assert.ok(r.ok, JSON.stringify(r.error));
    out.push([r.result.status, fake.api.requests.length - before, /REED_RELOGIN_NEEDED/.test(r.result.m)]);
  }
  assert.deepStrictEqual(out, [[401, 1, true], [403, 1, true], [429, 1, false]]);
}));

test('R2 (b): a saved token that is not a JWT is never sent: the capture is tried, and when it fails the error is REED_TOKEN_MISSING with zero API requests', () => world(async ({ m, fake, drive }) => {
  writeSession(m, { token: 'not-a-jwt-'.padEnd(90, 'x'), expiresAtSecs: Math.floor(Date.now() / 1000) + 3000 });
  fake.site.captureMode = 'none';
  const r = await drive(`
    const bf = require('./reed-browser-fetch');
    try { ${SEARCH}; return 'no error'; } catch (e) { return { m: e.message.slice(0, 40), code: e.code }; }
  `, { env: { ...FAST, REED_CAPTURE_TIMEOUT_MS: '400' } });
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.strictEqual(r.result.code, 'REED_TOKEN_MISSING');
  assert.match(r.result.m, /^REED_TOKEN_MISSING/);
  assert.strictEqual(fake.api.requests.length, 0, 'nothing was sent without a usable token');
}));

test('R2 (b): REED_TOKEN_MISSING is not turned into a direct fetch or a relogin by reed-api-client', () => world(async ({ m, fake, drive }) => {
  writeSession(m, { token: 'not-a-jwt-'.padEnd(90, 'x'), expiresAtSecs: Math.floor(Date.now() / 1000) + 3000 });
  fake.site.captureMode = 'none';
  const r = await drive(`
    const c = require('./reed-api-client');
    try { await c.reedFetch('/candidate/search/boolean/', { method: 'POST', body: JSON.stringify({ currentPage: 1 }) }); return 'no error'; } catch (e) { return { m: e.message.slice(0, 40), code: e.code }; }
  `, { env: { ...FAST, REED_CAPTURE_TIMEOUT_MS: '400' } });
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.strictEqual(r.result.code, 'REED_TOKEN_MISSING');
  assert.ok(!/trying direct/.test(r.stderr), 'no direct fetch fallback');
}));

test('R2 (a): the request expression carries the token itself and no code path sets a page token variable', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'resourcer', 'scripts', 'reed-browser-fetch.js'), 'utf8');
  assert.ok(!/__capturedReedToken\s*=/.test(src), 'no window variable is assigned');
  assert.ok(!/window\.__capturedReedToken/.test(src));
});

// ---------------------------------------------------------------- finalizer additions (review findings)

const CAP_FAST = { ...FAST, REED_CAPTURE_TIMEOUT_MS: '400' };

test('R2 (d): a re-capture that cannot finish does not discard a token that still works: the retry is sent again with it and succeeds', () => world(async ({ m, fake, drive }) => {
  const tok = validSession(m, fake);
  fake.site.captureMode = 'none'; // the browser never shows a token, so every re-capture fails
  fake.api.failNext = [{ status: 400, body: HEADER_MISSING_BODY, path: '/candidate/search/' }];
  const r = await drive(`const bf = require('./reed-browser-fetch'); const res = ${SEARCH}; return res.result.totalItemCount;`, { env: CAP_FAST });
  assert.ok(r.ok, `${JSON.stringify(r.error)} ${r.stderr}`);
  assert.strictEqual(r.result, 30);
  assert.strictEqual(fake.api.requests.length, 2, 'the failed request and the retry both reached the API');
  assert.ok(fake.api.requests.every((q) => q.auth === `Bearer ${tok}`));
  assert.match(r.stderr, /sending again with the earlier token/);
  assert.ok(!(r.stdout + r.stderr).includes(tok), 'the token is never printed');
}));

test('R2 (d): a persistent 400 with a re-capture that cannot finish ends as the real HTTP 400 after three requests, not as REED_TOKEN_MISSING', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  fake.site.captureMode = 'none';
  fake.api.alwaysHeaderMissing = true;
  const r = await drive(`
    const bf = require('./reed-browser-fetch');
    try { ${SEARCH}; return 'no error'; } catch (e) { return { m: e.message.slice(0, 40), status: e.status, code: e.code || null, attempts: e.attempts }; }
  `, { env: CAP_FAST });
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.match(r.result.m, /^Reed API POST HTTP 400: /);
  assert.strictEqual(r.result.status, 400);
  assert.strictEqual(r.result.attempts, 3);
  assert.strictEqual(fake.api.requests.length, 3);
}));

test('R2 (d): a replaced document during the request (destroyed context) is retried once or twice and recovers', () => world(async ({ m, fake, drive }) => {
  const tok = validSession(m, fake);
  fake.site.destroyNextEvals = 2;
  const r = await drive(`const bf = require('./reed-browser-fetch'); const res = ${SEARCH}; return res.result.totalItemCount;`, { env: FAST });
  assert.ok(r.ok, `${JSON.stringify(r.error)} ${r.stderr}`);
  assert.strictEqual(r.result, 30);
  assert.strictEqual(fake.api.requests.length, 1, 'only the last attempt reached the API');
  assert.ok(fake.api.requests.every((q) => q.auth === `Bearer ${tok}`));
  const f = forensic(r.stderr);
  assert.strictEqual(f.length, 2);
  assert.ok(f.every((x) => x.code === 'REED_NAV_DURING_REQUEST' && x.navDuringRequest === 'yes'));
}));

test('R2 (d): a destroyed context on every attempt ends as REED_NAV_DURING_REQUEST and is NOT turned into a direct fetch or a relogin by reed-api-client', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  fake.site.destroyNextEvals = 10;
  const r = await drive(`
    const c = require('./reed-api-client');
    try { await c.reedFetch('/candidate/search/boolean/', { method: 'POST', body: JSON.stringify({ currentPage: 1 }) }); return 'no error'; } catch (e) { return { m: e.message.slice(0, 40), code: e.code || null, attempts: e.attempts }; }
  `, { env: FAST });
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.strictEqual(r.result.code, 'REED_NAV_DURING_REQUEST');
  assert.strictEqual(r.result.attempts, 3);
  assert.ok(!/trying direct/.test(r.stderr), 'no direct fetch fallback');
  assert.ok(!/REED_RELOGIN_NEEDED/.test(r.result.m));
}));

test('R2 (d): the text of a server answer never decides a retry: a 500 whose body mentions a destroyed context is sent once', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  fake.api.failNext = [{ status: 500, body: '{"message":"Execution context was destroyed"}', path: '/candidate/search/' }];
  const r = await drive(`
    const bf = require('./reed-browser-fetch');
    try { ${SEARCH}; return 'no error'; } catch (e) { return { status: e.status, attempts: e.attempts }; }
  `, { env: FAST });
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.strictEqual(r.result.status, 500);
  assert.strictEqual(fake.api.requests.length, 1);
}));
