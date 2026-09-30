'use strict';
/*
 * The page scripts are plain strings sent through `eval`, so a lost backslash or quote only shows up on the
 * live site (that is how the phase 1 empty-result probe went wrong on 2026-09-04). These tests run the exact
 * shipped strings against the fake DOM and assert their answers page by page.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const site = require('./fake/site');

const SITE = { credentials: { username: 'u@example.invalid', password: 'pw-123456' }, cookieBanner: true, credits: 44463, expiredRedirect: 'root' };

function stateFor(page, url, extra) {
  return Object.assign({ page, url, loggedIn: page !== 'login' && page !== 'safelist', counters: {}, hasFingerprint: true }, extra || {});
}
const run = (script, state, cfg) => site.evalScript(script, state, Object.assign({}, SITE, cfg || {}), () => {});

function load(t) {
  const sb = H.buildSandbox({ prefix: 'rb-probe-' });
  sb.activate();
  t.after(() => sb.cleanup());
  return { login: sb.load('caterer-login.js'), credits: sb.load('caterer-get-credits.js') };
}

test('login-state probe: every page kind gets the right verdict', async (t) => {
  const { login } = load(t);
  const P = login.STATE_PROBE_JS;
  assert.equal(await run(P, stateFor('login', 'https://recruiter.caterer.com/login')), 'LOGIN');
  assert.equal(await run(P, stateFor('login', 'https://recruiter.caterer.com/?ReturnUrl=%2fx')), 'LOGIN');
  assert.equal(await run(P, stateFor('safelist', 'https://recruiter.caterer.com/Account/Unauthenticated/SafeListLoginBlocked')), 'SAFELIST');
  assert.equal(await run(P, stateFor('home', 'https://recruiter.caterer.com/Home/1368655')), 'OK');
  assert.equal(await run(P, stateFor('search', 'https://recruiter.caterer.com/CandidateSearchWebMvc/CandidateSearch')), 'OK');
  assert.equal(await run(P, stateFor('error', 'https://recruiter.caterer.com/Error?aspxerrorpath=%2fx')), 'ERRORPAGE');
  assert.equal(await run(P, stateFor('error', 'https://recruiter.caterer.com/Error.aspx')), 'ERRORPAGE');
  assert.equal(await run(P, stateFor('generic', 'https://recruiter.caterer.com/Home/1?ReturnUrl=x')), 'LOGIN', 'ReturnUrl in the query means a redirect to sign-in even without a form');
  assert.equal(await run(P, stateFor('protected', 'https://recruiter.caterer.com/login')), 'LOGIN', '/login URL without a form still counts as login');
  assert.equal(await run(P, stateFor('protected', 'https://recruiter.caterer.com/Errors/ok')), 'OK', 'only the Error page itself is an error page');
});

test('safe-list is detected even though its URL has no slash before "Login"', async (t) => {
  const { login } = load(t);
  const url = 'https://recruiter.caterer.com/Account/Unauthenticated/SafeListLoginBlocked';
  assert.equal(/\/login/i.test(url), false);
  assert.equal(await run(login.STATE_PROBE_JS, stateFor('safelist', url)), 'SAFELIST');
});

test('fill + submit scripts drive the controlled form; the dismiss script clicks the cookie banner', async (t) => {
  const { login } = load(t);
  const st = stateFor('login', 'https://recruiter.caterer.com/login', { loggedIn: false });
  assert.equal(await run(login.DISMISS_JS, st), 'dismissed:true');
  assert.equal(st.bannerDismissed, true);
  assert.equal(await run(login.DISMISS_JS, st), 'dismissed:false', 'nothing left to dismiss');
  assert.equal(await run(login.buildFillJs(SITE.credentials), st), 'FILLED');
  assert.equal(st.form.u, 'u@example.invalid');
  assert.equal(st.form.p, 'pw-123456');
  assert.equal(await run(login.SUBMIT_JS, st), 'CLICKED');
  assert.equal(st.loggedIn, true);
  assert.equal(st.url, 'https://recruiter.caterer.com/Home/1368655');
});

test('fill script answers NOFORM when the page has no form; submit answers NOBTN without a button', async (t) => {
  const { login } = load(t);
  const home = stateFor('home', 'https://recruiter.caterer.com/Home/1368655');
  assert.equal(await run(login.buildFillJs(SITE.credentials), home), 'NOFORM');
  assert.equal(await run(login.SUBMIT_JS, home), 'NOBTN');
});

test('credentials are embedded as JSON string literals: hostile values cannot break out of the string', async (t) => {
  const { login } = load(t);
  const evil = { username: 'a\'"\\`${1+1}\n</script>', password: '");document.title="pwned;//' };
  const js = login.buildFillJs(evil);
  assert.ok(js.includes(JSON.stringify(evil.username)));
  assert.ok(js.includes(JSON.stringify(evil.password)));
  const st = stateFor('login', 'https://recruiter.caterer.com/login', { loggedIn: false });
  assert.equal(await run(js, st), 'FILLED');
  assert.equal(st.form.u, evil.username);
  assert.equal(st.form.p, evil.password);
});

test('credits probe: widget digits, text fallback, LOGIN, unknown', async (t) => {
  const { credits } = load(t);
  const C = credits.CREDITS_JS;
  assert.equal(await run(C, stateFor('search', 'https://recruiter.caterer.com/CandidateSearchWebMvc/CandidateSearch')), '44463');
  assert.equal(await run(C, stateFor('search', 'https://recruiter.caterer.com/CandidateSearchWebMvc/CandidateSearch'), { creditsWidget: false }), '44463');
  assert.equal(await run(C, stateFor('login', 'https://recruiter.caterer.com/login', { loggedIn: false })), 'LOGIN');
  assert.equal(await run(C, stateFor('home', 'https://recruiter.caterer.com/Home/1368655')), 'unknown');
});

test('the selector engine of the fake understands every selector the scripts use (guard against a vacuous fake)', async () => {
  const doc = site.makeDocument;
  void doc;
  const page = site.buildPage(stateFor('login', 'https://recruiter.caterer.com/login', { loggedIn: false, bannerDismissed: true }), SITE);
  const q = (s) => page.root.all().filter((e) => site.selectorMatches(e, s));
  assert.equal(q('[name=username]').length, 1);
  assert.equal(q('[name=password]').length, 1);
  assert.equal(q('input[type=password]').length, 1);
  assert.equal(q('input:not([type=hidden])').length, 2);
  assert.equal(q('button[type=submit],input[type=submit],button.btn-primary,form button').length, 1);
  assert.equal(q('input[type=email]').length, 0);
});
