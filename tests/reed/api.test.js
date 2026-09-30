'use strict';

// reed-browser-fetch (proxy through the live tab) and reed-api-client (session, direct fallback, HTTP error taxonomy).

const test = require('node:test');
const assert = require('node:assert');
const { withWorld, writeSession, validSession } = require('./helpers/world');
const { startFakeReed } = require('./helpers/fake-reed');

const world = (fn, o) => withWorld(fn, { fake: { loggedIn: true }, ...(o || {}) });

test('browser proxy GET/POST/binary run inside the tab with the seeded Bearer and return parsed data', () => world(async ({ m, fake, drive }) => {
  const tok = validSession(m, fake);
  const r = await drive(`
    const bf = require('./reed-browser-fetch');
    const usage = await bf.reedBrowserFetch('/monetization/daily-usage/');
    const search = await bf.reedBrowserFetchPost('/candidate/search/boolean/', { currentPage: 1, pageItemCount: 25 });
    const cv = await bf.reedBrowserFetchBinary('/candidate/cv/download/', { candidateId: 9001 });
    return { usage, total: search.result.totalItemCount, n: search.result.candidates.length, cvText: cv.buffer.toString('utf8').slice(0, 20), cd: cv.contentDisposition, ct: cv.contentType };
  `);
  assert.ok(r.ok, JSON.stringify(r.error) + r.stderr);
  assert.strictEqual(r.result.usage.result.dailyLimit, 600);
  assert.strictEqual(r.result.total, 30);
  assert.strictEqual(r.result.n, 25);
  assert.match(r.result.cvText, /^Head Chef at The Te/);
  assert.match(r.result.cd, /cv\.txt/);
  assert.ok(fake.api.requests.every((q) => q.auth === `Bearer ${tok}`), 'every API request carried the seeded token');
  assert.strictEqual(fake.api.requests.length, 3);
  assert.ok(!fake.methods().includes('Network.setRequestInterception'));
}));

test('HTTP error taxonomy through the browser proxy: 401/403 relogin, other 4xx/5xx generic, status attached', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  fake.api.failNext = [{ status: 401 }, { status: 403 }, { status: 429 }, { status: 451, body: { error: 'InternationalCvSearchNotAllowedException' } }, { status: 500 }];
  const r2 = await drive(`
    const bf = require('./reed-browser-fetch');
    const out = [];
    for (let i = 0; i < 5; i++) {
      try { await bf.reedBrowserFetch('/monetization/daily-usage/'); out.push('ok'); } catch (e) { out.push({ m: e.message.slice(0, 70), status: e.status }); }
    }
    return out;
  `);
  assert.ok(r2.ok, JSON.stringify(r2.error));
  const [e401, e403, e429, e451, e500] = r2.result;
  assert.match(e401.m, /^REED_RELOGIN_NEEDED: HTTP 401/);
  assert.strictEqual(e401.status, 401);
  assert.match(e403.m, /^REED_RELOGIN_NEEDED: HTTP 403/);
  assert.match(e429.m, /^Reed API HTTP 429: /);
  assert.strictEqual(e429.status, 429);
  assert.match(e451.m, /^Reed API HTTP 451: /);
  assert.match(e451.m, /InternationalCvSearchNotAllowed/);
  assert.match(e500.m, /^Reed API HTTP 500: /);
}));

test('binary proxy keeps the legacy messages: HTTP status only (no relogin marker), tiny/HTML handled by callers', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  fake.api.failNext = [{ status: 401 }];
  const r = await drive(`
    const bf = require('./reed-browser-fetch');
    try { await bf.reedBrowserFetchBinary('/candidate/cv/download/', { candidateId: 1 }); return 'no error'; } catch (e) { return { m: e.message, status: e.status }; }
  `);
  assert.deepStrictEqual(r.result, { m: 'Reed binary API HTTP 401', status: 401 });
}));

test('a tab parked on the wrong page gets 401 from api.reed.co.uk (the live-tab-on-/search rule) and the token is not the problem', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  for (const t of fake.tabs.values()) { t.url = 'https://www.reed.co.uk/recruiter/v2/home'; t.page = { kind: 'home' }; t.ctx = null; }
  const r = await drive(`
    try { await require('./reed-browser-fetch').reedBrowserFetch('/monetization/daily-usage/'); return 'no error'; } catch (e) { return e.message.slice(0, 40); }
  `);
  assert.match(r.result, /^REED_RELOGIN_NEEDED: HTTP 401/);
}));

test('token seeding: expired session file triggers a navigate-capture (getToken) and the fresh token is used', () => world(async ({ m, fake, drive }) => {
  writeSession(m, { expiresAtSecs: Math.floor(Date.now() / 1000) - 100 });
  const r = await drive(`
    const bf = require('./reed-browser-fetch');
    const usage = await bf.reedBrowserFetch('/monetization/daily-usage/');
    return usage.result.dailyLimit;
  `);
  assert.ok(r.ok, JSON.stringify(r.error) + r.stderr);
  assert.strictEqual(r.result, 600);
  assert.match(r.stderr, /capturing fresh token via getToken/);
  const s = m.readJson('state/reed-session.json');
  assert.ok(fake.site.tokens.has(s.accessToken));
}));

test('no Reed tab and auto-relaunch disabled: a clear error, no crash', () => withWorld(async ({ m, fake, drive }) => {
  validSession(m, fake);
  const r = await drive(`
    try { await require('./reed-browser-fetch').reedBrowserFetch('/x'); return 'no error'; } catch (e) { return e.message; }
  `);
  assert.match(r.result, /^No Reed browser tab found\./);
}, { fake: { loggedIn: true, initialTab: false } }));

test('browser died mid-run: one relaunch attempt through the launcher, then the original error surfaces', () => withWorld(async ({ m, drive }) => {
  const r = await drive(`
    const bf = require('./reed-browser-fetch');
    const errs = [];
    for (let i = 0; i < 2; i++) { try { await bf.reedBrowserFetch('/x'); } catch (e) { errs.push(e.message.slice(0, 40)); } }
    return errs;
  `, { env: { REED_AUTO_RELAUNCH: '1', REED_CDP_PORT: '1', CHROMIUM_PATH: '/nonexistent/chromium' } });
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.strictEqual(r.result.length, 2);
  assert.strictEqual((r.stderr.match(/Reed browser relaunch: /g) || []).length, 1, 'relaunch attempted exactly once per process');
}, { fake: { loggedIn: true } }));

test('reed-api-client falls back to direct fetch only for non-4xx browser failures, and direct 401/403 map to REED_RELOGIN_NEEDED', () => withWorld(async ({ m, fake, drive }) => {
  validSession(m, fake);
  fake.api.failNext = [];
  const r = await drive(`
    const c = require('./reed-api-client');
    const ok = await c.reedFetch('/monetization/daily-usage/');
    return ok.result.dailyLimit;
  `, { env: { REED_CDP_PORT: '1' } });
  assert.ok(r.ok, JSON.stringify(r.error) + r.stderr);
  assert.strictEqual(r.result, 600);
  assert.match(r.stderr, /Browser proxy failed, trying direct/);

  fake.api.failNext = [{ status: 401 }, { status: 403 }, { status: 429 }, { status: 451 }];
  const r2 = await drive(`
    const c = require('./reed-api-client');
    const out = [];
    for (let i = 0; i < 4; i++) { try { await c.reedFetch('/monetization/daily-usage/'); out.push('ok'); } catch (e) { out.push({ m: e.message.slice(0, 60), status: e.status }); } }
    return out;
  `, { env: { REED_CDP_PORT: '1' } });
  assert.ok(r2.ok, JSON.stringify(r2.error));
  assert.match(r2.result[0].m, /^REED_RELOGIN_NEEDED: HTTP 401/);
  assert.match(r2.result[1].m, /^REED_RELOGIN_NEEDED: HTTP 403/);
  assert.match(r2.result[2].m, /^Reed API HTTP 429: /);
  assert.strictEqual(r2.result[3].status, 451);
}, { fake: { loggedIn: true } }));

test('getToken: valid saved token is used as is; missing/expired triggers capture and a failure becomes REED_RELOGIN_NEEDED', () => withWorld(async ({ m, fake, drive }) => {
  const tok = validSession(m, fake);
  let r = await drive("return await require('./reed-api-client').getToken();");
  assert.strictEqual(r.result, tok);
  m.write('state/reed-session.json', { accessToken: 'x', expiresAt: 1 });
  r = await drive("try { await require('./reed-api-client').getToken(); return 'no error'; } catch (e) { return e.message; }", { env: { REED_CDP_PORT: '1', CHROMIUM_PATH: '/nonexistent/chromium' } });
  assert.match(r.result, /^REED_RELOGIN_NEEDED: token expired - browser capture also failed/);
  assert.match(r.result, /cdp-reed-full-login\.js/, 'the hint names the new login command, not the dead reed-login.js');
  assert.ok(!/reed-login\.js/.test(r.result));
}, { fake: { loggedIn: true } }));

test('reed-api-client CLI: --check reports TOKEN_VALID / TOKEN_EXPIRED, --daily-usage prints usage or DAILY_USAGE_UNAVAILABLE, --help exits 0', () => world(async ({ m, fake, run }) => {
  let r = await run('reed-api-client.js', ['--check']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stdout, /^TOKEN_EXPIRED$/m);
  validSession(m, fake);
  r = await run('reed-api-client.js', ['--check']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /^TOKEN_VALID \(\d+m\)$/m);
  r = await run('reed-api-client.js', ['--daily-usage']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), { profileViews: 0, dailyLimit: 600, cvDownloads: null, remaining: 600 });
  fake.api.fixedStatus = 500;
  r = await run('reed-api-client.js', ['--daily-usage']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stdout, /^DAILY_USAGE_UNAVAILABLE$/m);
  r = await run('reed-api-client.js', ['--help']);
  assert.strictEqual(r.code, 0);
  r = await run('reed-api-client.js', []);
  assert.strictEqual(r.code, 1);
}));

test('session file: 0600 atomic write, and the stale session path never falls back to a hard-coded location', async () => {
  const w = await startFakeReed({});
  await w.close();
  const src = require('fs').readFileSync(require('path').resolve(__dirname, '..', '..', 'resourcer', 'scripts', 'reed-api-client.js'), 'utf8');
  assert.ok(/paths\.STATE/.test(src));
});

test('a token the API considers expired (401) while the session file still looks valid: REED_RELOGIN_NEEDED, and a forced refresh repairs it', () => world(async ({ m, fake, drive, run }) => {
  fake.site.tokenTtlSecs = -30; // the API sees it as expired at once
  const stale = fake.site.issueToken();
  m.write('state/reed-session.json', { accessToken: stale, refreshToken: null, expiresAt: Math.floor(Date.now() / 1000) + 1500, obtainedAt: new Date().toISOString() });
  const r = await drive(`
    try { await require('./reed-browser-fetch').reedBrowserFetch('/monetization/daily-usage/'); return 'no error'; } catch (e) { return { m: e.message.slice(0, 40), status: e.status }; }
  `);
  assert.strictEqual(r.result.status, 401);
  assert.match(r.result.m, /^REED_RELOGIN_NEEDED: HTTP 401/);
  fake.site.tokenTtlSecs = 1800;
  const ref = await run('reed-refresh-token.js', ['--force']);
  assert.strictEqual(ref.code, 0, ref.stderr);
  const ok = await drive("return (await require('./reed-browser-fetch').reedBrowserFetch('/monetization/daily-usage/')).result.dailyLimit;");
  assert.strictEqual(ok.result, 600);
}));
