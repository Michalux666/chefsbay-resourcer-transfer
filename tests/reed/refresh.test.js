'use strict';

// Token refresh over the Chrome-153 CDP surface: Network.requestWillBeSent / ExtraInfo / responseReceived, never interception.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { withWorld, writeSession, isWin, fileMode } = require('./helpers/world');
const { makeJwt } = require('./helpers/fake-reed');

const SRC = path.resolve(__dirname, '..', '..', 'resourcer', 'scripts');

for (const mode of ['requestWillBeSent', 'extraInfo', 'responseReceived']) {
  test(`--force captures the Bearer via ${mode}, saves the session 0600 and leaves the tab on the search page`, () => withWorld(async ({ m, fake, run }) => {
    fake.site.loggedIn = true;
    fake.site.captureMode = mode;
    const r = await run('reed-refresh-token.js', ['--force']);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /^REED_TOKEN_REFRESHED$/m);
    const s = m.readJson('state/reed-session.json');
    assert.ok(fake.site.tokens.has(s.accessToken), 'saved token is the one issued for api.reed.co.uk, not the foreign-host bearer');
    assert.strictEqual(s.refreshToken, null);
    assert.ok(s.expiresAt > Date.now() / 1000);
    if (!isWin) assert.strictEqual(fileMode(m.p('state', 'reed-session.json')), 0o600);
    assert.ok(!fake.methods().includes('Network.setRequestInterception'), 'must not call the removed CDP method');
    assert.strictEqual(m.readJson('runtime/reed-status.json').state, 'ok');
    assert.ok(fake.methods().includes('Network.enable'));
    const tab = [...fake.tabs.values()].find((t) => t.page.kind === 'search');
    assert.ok(tab, 'a tab must be left on the search page');
    assert.ok(!r.stdout.includes(s.accessToken) && !r.stderr.includes(s.accessToken), 'token never printed');
  }));
}

test('without --force a valid saved token short-circuits (TOKEN_VALID) and touches no browser', () => withWorld(async ({ m, fake, run }) => {
  writeSession(m);
  const r = await run('reed-refresh-token.js', []);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /^TOKEN_VALID$/m);
  assert.strictEqual(fake.calls.length, 0);
}));

test('a running human login is never disturbed: --force refresh leaves the browser alone (REED_RELOGIN_NEEDED, exit 1, no CDP traffic)', () => withWorld(async ({ m, fake, run }) => {
  const holder = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    fake.site.loggedIn = true;
    m.write('runtime/browser.lock', { owner: 'reed', pid: holder.pid, startedAt: new Date().toISOString(), purpose: 'human-login' });
    const r = await run('reed-refresh-token.js', ['--force']);
    assert.strictEqual(r.code, 1);
    assert.match(r.stdout, /^REED_RELOGIN_NEEDED$/m);
    assert.match(r.stderr, /Not touching the browser: a human login session holds browser\.lock/);
    assert.strictEqual(fake.calls.length, 0);
    assert.strictEqual(m.exists('state/reed-session.json'), false);
    // the same lock owned by an ordinary Reed run is not a human login: the refresh proceeds
    m.write('runtime/browser.lock', { owner: 'reed', pid: holder.pid, startedAt: new Date().toISOString(), purpose: 'reed-phase1' });
    const ok = await run('reed-refresh-token.js', ['--force']);
    assert.strictEqual(ok.code, 0, ok.stderr);
  } finally { holder.kill(); }
}));

test('a successful refresh closes a recorded login block and its marker (the human logged in through the browser)', () => withWorld(async ({ m, fake, run }) => {
  fake.site.loggedIn = true;
  m.write('runtime/reed-login-block.json', { blockedAt: new Date().toISOString(), reason: 'turnstile_unsolved', attempts: 1 });
  m.write('runtime/reed-auth-failed.marker', { reason: 'turnstile_blocked', failedAt: new Date().toISOString() });
  const r = await run('reed-refresh-token.js', ['--force']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(m.exists('runtime/reed-login-block.json'), false);
  assert.strictEqual(m.exists('runtime/reed-auth-failed.marker'), false);
  m.write('runtime/reed-auth-failed.marker', { reason: 'reed_451_international', failedAt: new Date().toISOString() });
  await run('reed-refresh-token.js', ['--force']);
  assert.strictEqual(m.readJson('runtime/reed-auth-failed.marker').reason, 'reed_451_international', 'a refresh cannot fix a session created abroad');
}));

test('an expired saved token is refreshed even without --force', () => withWorld(async ({ m, fake, run }) => {
  fake.site.loggedIn = true;
  writeSession(m, { expiresAtSecs: Math.floor(Date.now() / 1000) - 60 });
  const r = await run('reed-refresh-token.js', []);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /REED_TOKEN_REFRESHED/);
}));

test('logged-out browser (redirect to login): no token, REED_RELOGIN_NEEDED, exit 1 after the capture timeout', () => withWorld(async ({ fake, run }) => {
  fake.site.loggedIn = false;
  const r = await run('reed-refresh-token.js', ['--force'], { env: { REED_CAPTURE_TIMEOUT_MS: '800' } });
  assert.strictEqual(r.code, 1);
  assert.match(r.stdout, /^REED_RELOGIN_NEEDED$/m);
  assert.match(r.stderr, /Token capture timeout after 800ms/);
}));

test('a page that never issues a Bearer request times out cleanly', () => withWorld(async ({ fake, run }) => {
  fake.site.loggedIn = true;
  fake.site.captureMode = 'none';
  const r = await run('reed-refresh-token.js', ['--force'], { env: { REED_CAPTURE_TIMEOUT_MS: '600' } });
  assert.strictEqual(r.code, 1);
  assert.match(r.stdout, /REED_RELOGIN_NEEDED/);
}));

test('navigation errors fail fast with REED_RELOGIN_NEEDED', () => withWorld(async ({ fake, run }) => {
  fake.site.loggedIn = true;
  fake.site.navError = 'net::ERR_NAME_NOT_RESOLVED';
  const t0 = Date.now();
  const r = await run('reed-refresh-token.js', ['--force'], { env: { REED_CAPTURE_TIMEOUT_MS: '20000' } });
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /navigation failed: net::ERR_NAME_NOT_RESOLVED/);
  assert.ok(Date.now() - t0 < 10000);
}));

test('CDP unreachable and no browser to launch: REED_RELOGIN_NEEDED, exit 1, never a silent success', () => withWorld(async ({ run }) => {
  const r = await run('reed-refresh-token.js', ['--force'], { env: { REED_CDP_PORT: '1', CHROMIUM_PATH: '/nonexistent/chromium' } });
  assert.strictEqual(r.code, 1);
  assert.match(r.stdout, /^REED_RELOGIN_NEEDED$/m);
}));

test('the extra Network events are matched case-insensitively and foreign hosts / short tokens are ignored', () => {
  const { createBearerCapture } = require(path.join(SRC, 'reed-refresh-token.js'));
  const tok = makeJwt(Math.floor(Date.now() / 1000) + 600);
  const c = createBearerCapture();
  assert.strictEqual(c.feed({ method: 'Network.requestWillBeSent', params: { requestId: '1', request: { url: 'https://api.reed.co.uk/x', headers: { Authorization: 'Bearer short' } } } }), null);
  assert.strictEqual(c.feed({ method: 'Network.requestWillBeSent', params: { requestId: '2', request: { url: 'https://other.example.invalid/x', headers: { Authorization: `Bearer ${tok}` } } } }), null);
  assert.strictEqual(c.feed({ method: 'Network.requestWillBeSent', params: { requestId: '3', request: { url: 'https://api.reed.co.uk/x', headers: {} } } }), null);
  assert.strictEqual(c.feed({ method: 'Network.requestWillBeSentExtraInfo', params: { requestId: '3', headers: { AUTHORIZATION: `bearer ${tok}` } } }), tok);
  assert.strictEqual(c.feed({ method: 'Network.requestWillBeSentExtraInfo', params: { requestId: 'unknown', headers: { authorization: `Bearer ${tok}` } } }), null, 'ExtraInfo without a known api URL is ignored');
  assert.strictEqual(c.feed({ method: 'Network.responseReceived', params: { response: { url: 'https://api.reed.co.uk/y', requestHeaders: { authorization: `Bearer ${tok}` } } } }), tok);
  assert.strictEqual(c.feed({ method: 'Page.loadEventFired', params: {} }), null);
  assert.strictEqual(c.feed(null), null);
});

test('JWT helpers: expiry decode, seconds/millis normalisation, validity threshold', () => {
  const mod = require(path.join(SRC, 'reed-refresh-token.js'));
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const tok = makeJwt(exp);
  assert.strictEqual(mod.decodeJwtExpiry(tok), exp);
  assert.strictEqual(mod.decodeJwtExpiry('garbage'), null);
  assert.strictEqual(mod.expiresAtMs(exp), exp * 1000);
  assert.strictEqual(mod.expiresAtMs(exp * 1000), exp * 1000);
  assert.strictEqual(mod.isTokenValid({ accessToken: tok, expiresAt: exp }), true);
  assert.strictEqual(mod.isTokenValid({ accessToken: tok, expiresAt: Math.floor(Date.now() / 1000) + 60 }), false, 'inside the 5 minute threshold');
  assert.strictEqual(mod.isTokenValid({ accessToken: 'short', expiresAt: exp }), false);
  assert.strictEqual(mod.isTokenValid(null), false);
  assert.strictEqual(mod.isTokenValid({ accessToken: tok }), true, 'falls back to the JWT exp claim');
});
