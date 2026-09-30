'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const H = require('./helpers');

H.installFetchGuard();

const future = () => Date.now() / 1000 + 86400;
const baseCookies = () => [
  { name: 'AuthCookie', value: 'old-auth', domain: '.caterer.com', path: '/', expires: future(), httpOnly: true, secure: true, session: false },
  { name: 'RecruiterAuthCookie', value: 'old-recruiter', domain: '.caterer.com', path: '/', expires: -1, session: true },
  { name: '_abck', value: 'fingerprint', domain: '.caterer.com', path: '/', expires: future() },
];

function setup(t) {
  const sb = H.buildSandbox({ prefix: 'rb-jar-' });
  sb.activate();
  t.after(() => sb.cleanup());
  sb.writeSession(baseCookies());
  return { sb, jar: sb.load('caterer-cookie-jar.js'), cs: sb.load('caterer-check-session.js') };
}

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}
const httpDate = (secs) => new Date(secs * 1000).toUTCString();

test('parseSetCookie handles Domain, Path, Expires, Max-Age, HttpOnly, Secure', (t) => {
  const { jar } = setup(t);
  const c = jar.parseSetCookie('AuthCookie=abc=def; Domain=caterer.com; Path=/x; Expires=Wed, 21 Oct 2037 07:28:00 GMT; HttpOnly; Secure', '.default');
  assert.equal(c.name, 'AuthCookie');
  assert.equal(c.value, 'abc=def');
  assert.equal(c.domain, '.caterer.com');
  assert.equal(c.path, '/x');
  assert.equal(c.httpOnly, true);
  assert.equal(c.secure, true);
  assert.equal(c.session, false);
  assert.equal(c.expires, Date.parse('Wed, 21 Oct 2037 07:28:00 GMT') / 1000);
  const m = jar.parseSetCookie('X=1; Max-Age=60', '.d');
  assert.ok(Math.abs(m.expires - (Date.now() / 1000 + 60)) < 5);
  assert.equal(jar.parseSetCookie('novalue', '.d'), null);
  assert.equal(jar.parseSetCookie('S=1', '.d').session, true);
});

test('isClearCookie: empty value or a past expiry is a logout directive, not a renewal', (t) => {
  const { jar } = setup(t);
  assert.equal(jar.isClearCookie({ value: '', expires: -1 }), true);
  assert.equal(jar.isClearCookie({ value: 'x', expires: 1 }), true);
  assert.equal(jar.isClearCookie({ value: 'x', expires: -1 }), false);
  assert.equal(jar.isClearCookie({ value: 'x', expires: future() }), false);
});

test('a genuine 200 renewal of the auth family is merged atomically with mode 600; noise is ignored', async (t) => {
  const { sb, jar } = setup(t);
  const { srv, url } = await serve((req, res) => {
    res.setHeader('Set-Cookie', [
      `AuthCookie=new-auth; Path=/; Expires=${httpDate(future())}; HttpOnly`,
      `AuthCookieCompany=brand-new-company; Path=/; Expires=${httpDate(future())}`,
      '_abck=attacker-noise; Path=/',
      'Unrelated=zzz; Path=/',
    ]);
    res.end('ok');
  });
  t.after(() => srv.close());
  const res = await jar.fetchWithCookieJarUpdate(`${url}/x`, {}, 5000);
  assert.equal(res.status, 200);
  const s = sb.readJson('state/caterer-session.json');
  const by = Object.fromEntries(s.cookies.map((c) => [c.name, c]));
  assert.equal(by.AuthCookie.value, 'new-auth');
  assert.equal(by.AuthCookieCompany.value, 'brand-new-company', 'a genuinely new auth cookie is kept');
  assert.equal(by._abck.value, 'fingerprint', 'non-auth cookies are never rewritten from Set-Cookie');
  assert.ok(!by.Unrelated);
  assert.equal(by.RecruiterAuthCookie.value, 'old-recruiter');
  if (process.platform !== 'win32') assert.equal(fs.statSync(sb.sessionFile()).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(sb.home).filter((n) => n.includes('.tmp')), []);
});

test('clear-cookie directives never poison the saved session (2026-07-04)', async (t) => {
  const { sb, jar } = setup(t);
  const before = fs.readFileSync(sb.sessionFile(), 'utf8');
  const { srv, url } = await serve((req, res) => {
    res.setHeader('Set-Cookie', ['AuthCookie=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'RecruiterAuthCookie=deleted; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
    res.end('ok');
  });
  t.after(() => srv.close());
  await jar.fetchWithCookieJarUpdate(`${url}/x`, {}, 5000);
  assert.equal(fs.readFileSync(sb.sessionFile(), 'utf8'), before, 'file byte-identical');
});

test('renewals on a redirected or non-OK response are not trusted', async (t) => {
  const { sb, jar } = setup(t);
  const before = fs.readFileSync(sb.sessionFile(), 'utf8');
  const { srv, url } = await serve((req, res) => {
    if (req.url === '/redir') { res.statusCode = 302; res.setHeader('Location', '/final'); return res.end(); }
    if (req.url === '/final') { res.setHeader('Set-Cookie', `AuthCookie=from-redirect; Path=/; Expires=${httpDate(future())}`); return res.end('ok'); }
    res.statusCode = 401;
    res.setHeader('Set-Cookie', `AuthCookie=from-401; Path=/; Expires=${httpDate(future())}`);
    res.end('no');
  });
  t.after(() => srv.close());
  const r1 = await jar.fetchWithCookieJarUpdate(`${url}/redir`, { redirect: 'follow' }, 5000);
  assert.equal(r1.redirected, true);
  const r2 = await jar.fetchWithCookieJarUpdate(`${url}/other`, {}, 5000);
  assert.equal(r2.status, 401);
  assert.equal(fs.readFileSync(sb.sessionFile(), 'utf8'), before);
});

test('bookkeeping failure (no session file) is non-fatal and the response is still returned', async (t) => {
  const { sb, jar } = setup(t);
  fs.unlinkSync(sb.sessionFile());
  const { srv, url } = await serve((req, res) => { res.setHeader('Set-Cookie', `AuthCookie=x; Path=/; Expires=${httpDate(future())}`); res.end('body'); });
  t.after(() => srv.close());
  const res = await jar.fetchWithCookieJarUpdate(`${url}/x`, {}, 5000);
  assert.equal(await res.text(), 'body');
});

test('the session file path used here equals the one the browser wrapper writes', (t) => {
  const { sb, jar } = setup(t);
  const browser = sb.load('lib/browser.js');
  assert.equal(require('path').resolve(jar.SESSION_PATH), require('path').resolve(browser.SESSION_FILE));
});

// ---------------------------------------------------------------- check-session

function fakeRes(status, headers) {
  return { status, headers: { get: (n) => (headers || {})[n.toLowerCase()] || null } };
}

test('check-session: no file, expired cookies', async (t) => {
  const { sb, cs } = setup(t);
  const seen = [];
  const spy = async (url, opts) => { seen.push([url, opts]); return fakeRes(200); };
  sb.writeSession([{ name: 'AuthCookie', value: 'x', domain: '.caterer.com', path: '/', expires: 5 }]);
  let r = await cs.checkSession({ fetchImpl: spy });
  assert.deepEqual([r.output, r.exitCode], ['expired', 1]);
  assert.equal(seen.length, 0, 'no request when the cookies are already expired');
  fs.unlinkSync(sb.sessionFile());
  r = await cs.checkSession({ fetchImpl: spy });
  assert.deepEqual([r.output, r.exitCode], ['expired', 1]);
});

test('check-session: 200 is valid and sends the cookie header without following redirects', async (t) => {
  const { cs } = setup(t);
  let opts;
  const r = await cs.checkSession({ fetchImpl: async (u, o) => { opts = o; return fakeRes(200); } });
  assert.deepEqual([r.output, r.exitCode], ['valid', 0]);
  assert.equal(opts.redirect, 'manual');
  assert.match(opts.headers.Cookie, /AuthCookie=old-auth/);
  assert.match(opts.headers.Cookie, /RecruiterAuthCookie=old-recruiter/, 'expires -1 (browser session cookie) is valid, not dead');
});

test('check-session: redirects to a login page or a ReturnUrl mean expired, other statuses mean unknown', async (t) => {
  const { cs } = setup(t);
  const run = (status, loc) => cs.checkSession({ fetchImpl: async () => fakeRes(status, loc ? { location: loc } : {}) });
  assert.equal((await run(302, '/login?x=1')).output, 'expired');
  assert.equal((await run(301, 'https://recruiter.caterer.com/?ReturnUrl=%2fx')).output, 'expired');
  assert.equal((await run(302, '/somewhere-else')).output, 'unknown');
  assert.equal((await run(500)).output, 'unknown');
  const boom = await cs.checkSession({ fetchImpl: async () => { throw new Error('connect ECONNRESET'); } });
  assert.deepEqual([boom.output, boom.exitCode], ['unknown', 1]);
  assert.match(boom.notes[0], /Network error/);
});

test('check-session CLI: prints the verdict and exits 1 when there is no session file', async (t) => {
  const { sb } = setup(t);
  fs.unlinkSync(sb.sessionFile());
  const r = sb.run('caterer-check-session.js', []);
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), 'expired');
});
