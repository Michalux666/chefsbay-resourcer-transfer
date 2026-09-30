#!/usr/bin/env node
'use strict';
/*
 * caterer-login.js - the ONE Caterer sign-in implementation (session check, fresh login, safe-list
 * handling, recovery link). Replaces caterer-do-login.ps1 AND the inline copy in watchdog-runner
 * (two copies drifting apart silently broke self-heal for 3 days on 2026-07-04).
 *
 * Library:
 *   ensureLoggedIn({allowRelogin=true}) -> 'ok' | 'login' | 'safelist' | 'moduleerror' | 'unknown' | 'error'
 *   ensureLoggedInDetailed(opts)        -> {state, detail, reloggedIn, notes[], suppressed?}
 *   checkLoggedIn(), login(), openVerificationLink(url)
 *
 * CLI: node scripts/caterer-login.js [--check] [--force] [--restore-state|--no-restore-state]
 *                                     [--open-link <url>|-] [--json] [--help]
 *   Default: check the browser session; only if it is not signed in, sign in.
 *   Exit: 0 ok | 1 unexpected/unknown | 2 SAFELIST_BLOCKED | 3 CRED_* or LOGIN_FAILED |
 *         4 CATERER_MODULE_ERROR (session fine, CV Database module failing) | 64 usage
 *
 * Lessons encoded here (docs/parity/browser-caterer.md maps each to the incident note):
 *  - React-controlled form: native value setter + real input/change events, credentials embedded with
 *    JSON.stringify (never hand-escaped), never logged.
 *  - Cold daemon (no page yet) => `state load` the saved fingerprint cookies BEFORE the login page.
 *    Warm daemon => never `state load` (Akamai invalidates a reloaded snapshot).
 *  - Only ever save the session from a confirmed signed-in page (never from /login or the safe-list page).
 *  - SafeListLoginBlocked is detected by URL and DOM (its URL has no slash before "Login"), is NOT retried
 *    (each attempt emails a new link and invalidates the old one), raises a critical alert once, and the
 *    fix is `--open-link <newest emailed link>` in the same browser session.
 *  - A healthy session with a failing CV Database module (redirect loop) is reported as moduleerror,
 *    never as "logged out": no re-login, no safe-list email churn.
 *  - Placeholder/missing credentials are refused locally before any browser work (account lock risk).
 *  - Stale browser backend after an outage (name resolution failing in the browser while it works here)
 *    => reset the browser once, then sign in cold.
 */
const path = require('path');
const dns = require('dns');
const paths = require('./lib/paths');
const env = require('./lib/env');
const fsx = require('./lib/fsx');
const { notify } = require('./lib/notify');
const browser = require('./lib/browser');

const { SITE, SESSION_FILE } = browser;
const EXIT = Object.freeze({ OK: 0, ERROR: 1, SAFELIST: 2, FAILED: 3, MODULE: 4, USAGE: 64 });
const STATE_FILE = path.join(paths.RUNTIME, 'caterer-login-state.json');

const MIN_GAP_AFTER_FAILURE_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 3;
const FAIL_HOLD_MS = 3 * 60 * 60 * 1000;
const RENOTIFY = { safelist: 3 * 60 * 60 * 1000, failed: 6 * 60 * 60 * 1000, cred: 6 * 60 * 60 * 1000, moduleError: 6 * 60 * 60 * 1000 };
const BROWSER_RESET_MIN_GAP_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------- page scripts (kept as plain strings)

const DISMISS_JS = String.raw`(function(){var b=[...document.querySelectorAll('button')].find(function(x){return /just necessary|accept all/i.test(x.textContent||'');});if(b){b.click();}return 'dismissed:'+(b!=null);})()`;

function buildFillJs(cred) {
  return '(function(){'
    + 'function setVal(el,val){var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;s.call(el,val);el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));}'
    + 'var u=document.querySelector("[name=username]")||document.querySelector("input[type=email]")||document.querySelectorAll("input:not([type=hidden])")[0];'
    + 'var p=document.querySelector("[name=password]")||document.querySelector("input[type=password]");'
    + 'if(!u||!p)return "NOFORM";'
    + 'setVal(u,' + JSON.stringify(String(cred.username)) + ');'
    + 'setVal(p,' + JSON.stringify(String(cred.password)) + ');'
    + 'return "FILLED";})()';
}

const SUBMIT_JS = String.raw`(function(){var b=document.querySelector('button[type=submit],input[type=submit],button.btn-primary,form button');if(b){b.click();return 'CLICKED';}return 'NOBTN';})()`;

// SAFELIST first (its URL has no slash before "Login" and no password field), then the CV Database
// error page, then the logged-out signals, then the signed-in widget; anything else is not a login page.
const STATE_PROBE_JS = String.raw`(function(){var h=location.href;if(/SafeListLoginBlocked/i.test(h))return 'SAFELIST';if(/aspxerrorpath|\/Error(\.aspx)?([\/?#]|$)/i.test(h))return 'ERRORPAGE';if(document.querySelector('[name=password]'))return 'LOGIN';if(/[?&]ReturnUrl=/i.test(h))return 'LOGIN';if(document.querySelector('.litCandidatesViewed'))return 'OK';return /\/login/i.test(h)?'LOGIN':'OK';})()`;

// ---------------------------------------------------------------- small helpers

const PLACEHOLDER_A = /^<.*>$/;
const PLACEHOLDER_B = /password\s*here|your\s*password|changeme|xxxx|todo/i;
const NET_ERR_RE = /ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE|ERR_CONNECTION_(?:REFUSED|RESET|TIMED_OUT|CLOSED)|ERR_TIMED_OUT/i;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function sleepScale() {
  const v = Number(env.get('RESOURCER_SLEEP_SCALE'));
  return Number.isFinite(v) && v >= 0 ? v : 1;
}
const realSleep = (ms) => new Promise((r) => setTimeout(r, Math.round(ms * sleepScale())));

function defaultDns(host) {
  return Promise.race([
    dns.promises.lookup(host).then(() => true, () => false),
    new Promise((r) => setTimeout(() => r(false), 8000)),
  ]);
}

function deps(o) {
  const x = o || {};
  return { browser: x._browser || browser, sleep: x._sleep || realSleep, dnsLookup: x._dns || defaultDns, now: x._now || Date.now };
}

const cleanEval = (s) => String(s || '').replace(ANSI, '').replace(/"/g, '').trim();
const firstLine = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
const onCaterer = (u) => /^https?:\/\/recruiter\.caterer\.com(?:[/?#]|$)/i.test(u || '');
const isoNow = (d) => new Date(d.now()).toISOString();

// Address an operator can read without seeing a query string (recovery links carry a token).
function safeUrl(u) {
  try { const x = new URL(u); return x.origin + x.pathname; } catch { return String(u || '').split('?')[0]; }
}

// A password or username must never reach a log, an alert or stdout, whatever text they end up in.
function scrubber(cred) {
  const raw = cred ? [cred.password, cred.username].filter((s) => typeof s === 'string' && s.length >= 4) : [];
  // also the JSON-escaped spelling, which is how a value shows up if an error message echoes the script
  const secrets = raw.concat(raw.map((s) => JSON.stringify(s).slice(1, -1))).filter((s, i, a) => s && a.indexOf(s) === i);
  return (text) => {
    let t = String(text);
    for (const s of secrets) t = t.split(s).join('***');
    return t;
  };
}

function loadCredentials() {
  let cred;
  try {
    cred = require('./lib/caterer-credentials').load();
  } catch (e) {
    const msg = String((e && e.message) || e);
    const marker = /not found|ENOENT|MODULE_NOT_FOUND|Cannot find module/i.test(msg) ? 'CRED_MISSING'
      : /placeholder/i.test(msg) ? 'CRED_PLACEHOLDER' : 'CRED_INVALID';
    throw Object.assign(new Error(msg), { marker });
  }
  if (!cred || typeof cred.username !== 'string' || typeof cred.password !== 'string' || !cred.username.trim() || !cred.password.trim()) {
    throw Object.assign(new Error('caterer credentials need both username and password'), { marker: 'CRED_INVALID' });
  }
  if (PLACEHOLDER_A.test(cred.password) || PLACEHOLDER_B.test(cred.password)) {
    throw Object.assign(new Error('caterer password is still a placeholder, not a real password'), { marker: 'CRED_PLACEHOLDER' });
  }
  return cred;
}

function sessionFileUsable() {
  const j = fsx.readJson(SESSION_FILE, null);
  return !!(j && Array.isArray(j.cookies));
}

// ---------------------------------------------------------------- persisted attempt state (anti-loop)

function readState() { return fsx.readJson(STATE_FILE, {}) || {}; }
function writeState(st) { try { fsx.writeJsonAtomic(STATE_FILE, st, 0o600); } catch { /* state is advisory */ } }

function cooldownMs() {
  const m = Number(env.get('CATERER_SAFELIST_COOLDOWN_MIN'));
  return (Number.isFinite(m) && m >= 0 ? m : 60) * 60 * 1000;
}

function attemptGate(st, nowMs) {
  if (st.holdUntil && Date.parse(st.holdUntil) > nowMs) return { allow: false, reason: 'hold', state: 'login' };
  if (st.safelist && st.safelist.lastAttemptAt && nowMs - Date.parse(st.safelist.lastAttemptAt) < cooldownMs()) {
    return { allow: false, reason: 'safelist-cooldown', state: 'safelist' };
  }
  if ((st.lastResult === 'failed' || st.lastResult === 'attempting') && st.lastAttemptAt && nowMs - Date.parse(st.lastAttemptAt) < MIN_GAP_AFTER_FAILURE_MS) {
    return { allow: false, reason: 'min-gap', state: 'login' };
  }
  return { allow: true };
}

function notifyOnce(st, slot, everyMs, alert, nowMs) {
  const cur = st[slot] || (st[slot] = {});
  if (cur.notifiedAt && nowMs - Date.parse(cur.notifiedAt) < everyMs) return false;
  cur.notifiedAt = new Date(nowMs).toISOString();
  notify(alert);
  return true;
}

const SAFELIST_ALERT = 'Caterer sign-in is blocked by the device safe-list check, so no CV sourcing can run. ACTION: open the NEWEST verification email from Caterer sent to the Caterer login mailbox, copy the link (it contains TwoFaAuthRedirect) and run in the resourcer workspace: node scripts/caterer-login.js --open-link "<the link>" (or pipe it in: echo "<the link>" | node scripts/caterer-login.js --open-link -). Do not re-run the login repeatedly: every attempt emails a new link and invalidates the older ones. The pipeline keeps checking without signing in again.';

// ---------------------------------------------------------------- cold-daemon rule

/**
 * A daemon with no page yet has no cookies (new container, killed browser). Its very first navigation
 * creates a brand-new device fingerprint, which is what Akamai turns into a safe-list block. So the saved
 * fingerprint/session cookies are loaded BEFORE any navigation of a cold browser, and never into a warm one.
 */
async function prepareBrowser(opts, d, notes) {
  if (opts.restoreState === 'never') return 'skipped';
  if (!sessionFileUsable()) { notes.push('no usable saved session file (first login or lost state)'); return 'nofile'; }
  const c = opts.restoreState === 'always' ? { cold: true } : await d.browser.isCold();
  if (c.cold !== true) return 'warm';
  notes.push('cold browser: restoring the saved fingerprint/session cookies before any navigation');
  const r = await d.browser.stateLoad(SESSION_FILE, { timeoutMs: 60000 });
  return r.ok ? 'loaded' : 'failed';
}

// ---------------------------------------------------------------- session check

async function classifyModuleError(d, notes) {
  notes.push('search page failing; probing the home page to tell a broken module from a logged-out session');
  const h = await d.browser.open(SITE.HOME_ROOT, { timeoutMs: 40000 });
  if (h.timedOut || !h.ok) return { state: 'error', detail: 'search page and home page both failed: ' + firstLine(h.out) };
  await d.browser.waitNetworkIdle({ timeoutMs: 40000 });
  const e = await d.browser.evalJs(STATE_PROBE_JS, { timeoutMs: 20000 });
  const raw = cleanEval(e.stdout || e.out);
  if (raw.includes('SAFELIST')) return { state: 'safelist', detail: 'SafeListLoginBlocked' };
  if (raw.includes('LOGIN')) return { state: 'login', detail: 'search page failing and the home page shows the sign-in form' };
  if (raw.includes('OK')) return { state: 'moduleerror', detail: 'the CV Database search page fails (redirect loop or error page) while the session is signed in' };
  return { state: 'error', detail: 'home page probe gave no answer' };
}

/** Navigate the warm browser to the search page and read the DOM. No `state load` ever happens here. */
async function checkLoggedIn(o) {
  const d = deps(o);
  const notes = [];
  const op = await d.browser.open(SITE.SEARCH_URL, { timeoutMs: 40000 });
  if (op.timedOut) return { state: 'error', detail: 'open timed out', notes };
  if (!op.ok) {
    if (/ERR_TOO_MANY_REDIRECTS/i.test(op.out)) return Object.assign(await classifyModuleError(d, notes), { notes });
    if (NET_ERR_RE.test(op.out)) return { state: 'network', detail: firstLine(op.out), notes };
    return { state: 'error', detail: firstLine(op.out), notes };
  }
  await d.browser.waitNetworkIdle({ timeoutMs: 40000 });
  const e = await d.browser.evalJs(STATE_PROBE_JS, { timeoutMs: 20000 });
  if (!e.ok) return { state: 'error', detail: 'state probe failed: ' + firstLine(e.out), notes };
  const raw = cleanEval(e.stdout || e.out);
  if (raw.includes('SAFELIST')) return { state: 'safelist', detail: 'SafeListLoginBlocked', notes };
  if (raw.includes('ERRORPAGE')) return Object.assign(await classifyModuleError(d, notes), { notes });
  if (raw.includes('LOGIN')) return { state: 'login', detail: 'sign-in form shown', notes };
  if (raw.includes('OK')) return { state: 'ok', detail: '', notes };
  return { state: 'unknown', detail: 'unrecognised probe answer', notes };
}

// ---------------------------------------------------------------- fresh login (port of caterer-do-login.ps1)

function result(status, exitCode, marker, message, extra) {
  return Object.assign({ status, exitCode, marker, message }, extra || {});
}

async function login(o) {
  const opts = Object.assign({ restoreState: 'auto', save: true, log: () => {} }, o);
  const d = deps(opts);
  let scrub = scrubber(null);
  const say = (m) => opts.log(scrub(m));

  say('Starting Caterer fresh login...');
  let cred;
  try {
    cred = loadCredentials();
  } catch (e) {
    const txt = `${e.marker}: ${e.message}. NOT attempting a login (repeated failures can lock the account).`;
    say(txt);
    return result('cred', EXIT.FAILED, e.marker, txt);
  }
  scrub = scrubber(cred);

  let restored = 'skipped';
  if (opts.restoreState !== 'never') {
    if (sessionFileUsable()) {
      let cold = opts.restoreState === 'always';
      if (!cold) cold = (await d.browser.isCold()).cold === true;
      if (cold) {
        say('Restoring prior session state (fingerprint/tracking cookies) before login...');
        const r = await d.browser.stateLoad(SESSION_FILE, { timeoutMs: 60000 });
        restored = r.ok ? 'loaded' : 'failed';
      } else {
        say('Warm browser: not loading saved state (Akamai invalidates a reloaded snapshot on a live session).');
      }
    } else {
      say('No prior session file found -- proceeding with a clean browser (first-time login).');
    }
  }

  const op = await d.browser.open(SITE.LOGIN_URL, { timeoutMs: 40000 });
  if (!op.ok) {
    const txt = `LOGIN_FAILED: could not open the login page (${scrub(firstLine(op.out))})`;
    say(txt);
    return result('failed', EXIT.FAILED, 'LOGIN_FAILED', txt, { restored });
  }
  await d.browser.waitNetworkIdle({ timeoutMs: 40000 });
  await d.sleep(1000);

  const u0 = await d.browser.getUrlResult();
  if (u0.ok && isSafe(u0.url)) return safelistResult(say, restored, u0.url);
  const already = u0.ok && onCaterer(u0.url) && !browser.isLoginUrl(u0.url) && !browser.isModuleErrorUrl(u0.url);
  let url = u0.url;

  if (already) {
    say(`Already authenticated: the login page redirected to ${safeUrl(u0.url)}`);
  } else {
    await d.browser.evalJs(DISMISS_JS, { timeoutMs: 20000 });
    await d.sleep(1000);

    const fill = await d.browser.evalJs(buildFillJs(cred), { timeoutMs: 20000, singleAttempt: true });
    const fr = cleanEval(fill.stdout || fill.out);
    say(`Form fill result: ${scrub(fr) || scrub(firstLine(fill.out))}`);
    if (!fill.ok || fr.includes('NOFORM') || !fr.includes('FILLED')) {
      const txt = 'LOGIN_FAILED: the sign-in form was not found or could not be filled (page structure changed?)';
      say(txt);
      return result('failed', EXIT.FAILED, 'LOGIN_FAILED', txt, { restored });
    }
    await d.sleep(300);
    const sub = await d.browser.evalJs(SUBMIT_JS, { timeoutMs: 20000, singleAttempt: true });
    const sr = cleanEval(sub.stdout || sub.out);
    say(`Form submit result: ${scrub(sr) || scrub(firstLine(sub.out))}`);
    if (!sub.ok || !sr.includes('CLICKED')) {
      const txt = 'LOGIN_FAILED: no submit button found on the sign-in form';
      say(txt);
      return result('failed', EXIT.FAILED, 'LOGIN_FAILED', txt, { restored });
    }

    await d.browser.waitNetworkIdle({ timeoutMs: 40000 });
    await d.sleep(2000);
    // The redirect can trail networkidle: give a genuine success a few seconds to leave /login.
    for (let i = 0; i < 6; i++) {
      const u = await d.browser.getUrlResult();
      url = u.url;
      if (u.ok && !browser.isLoginUrl(url)) break;
      if (u.ok && isSafe(url)) break;
      await d.sleep(2000);
    }
  }
  say(`URL after login: ${safeUrl(url)}`);

  if (isSafe(url)) return safelistResult(say, restored, url);
  if (browser.isLoginUrl(url)) {
    const txt = 'LOGIN_FAILED: still on /login -- the credentials were rejected or the form fill/submit did not work.';
    say(txt);
    return result('failed', EXIT.FAILED, 'LOGIN_FAILED', txt, { restored, url: safeUrl(url) });
  }
  if (!onCaterer(url) || browser.isModuleErrorUrl(url) || /\/Account\/Unauthenticated/i.test(url)) {
    const txt = `LOGIN_FAILED: unexpected landing page (${safeUrl(url) || 'blank'})`;
    say(txt);
    return result('failed', EXIT.FAILED, 'LOGIN_FAILED', txt, { restored, url: safeUrl(url) });
  }

  if (opts.save) {
    const s = await d.browser.saveSession();
    say(s.saved ? 'Session saved' : `WARN session not saved (${s.skipped || s.out || 'save failed'})`);
  }
  say('Login complete');
  return result('ok', EXIT.OK, 'LOGIN_OK', 'Login complete', { restored, url: safeUrl(url) });
}

function isSafe(u) { return browser.isSafeListBlocked(u); }

function safelistResult(say, restored, url) {
  const txt = 'SAFELIST_BLOCKED: Caterer wants device verification -- a verification link (newest email) must be opened in this browser session: node scripts/caterer-login.js --open-link -';
  say(txt);
  return result('safelist', EXIT.SAFELIST, 'SAFELIST_BLOCKED', txt, { restored, url: safeUrl(url) });
}

// ---------------------------------------------------------------- recovery link

async function openVerificationLink(link, o) {
  const d = deps(o);
  const say = (o && o.log) || (() => {});
  let u;
  try { u = new URL(String(link || '').trim()); } catch { return result('badlink', EXIT.USAGE, 'BAD_LINK', 'BAD_LINK: not a URL'); }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'recruiter.caterer.com' || !/TwoFaAuthRedirect/i.test(u.pathname)) {
    return result('badlink', EXIT.USAGE, 'BAD_LINK', 'BAD_LINK: expected an https://recruiter.caterer.com/login/TwoFaAuthRedirect link from the verification email');
  }
  const op = await d.browser.open(u.toString(), { timeoutMs: 90000 });
  if (!op.ok) return result('failed', EXIT.FAILED, 'LOGIN_FAILED', `LOGIN_FAILED: could not open the link (${firstLine(op.out)})`);
  await d.browser.waitNetworkIdle({ timeoutMs: 60000 });
  await d.sleep(2000);
  let url = '';
  for (let i = 0; i < 4; i++) {
    const g = await d.browser.getUrlResult({ timeoutMs: 30000 });
    url = g.url;
    if (g.ok && onCaterer(url) && !browser.isLoginUrl(url) && !isSafe(url)) break;
    await d.sleep(2000);
  }
  say(`URL after verification link: ${safeUrl(url)}`);
  if (!onCaterer(url) || browser.isLoginUrl(url) || isSafe(url) || browser.isModuleErrorUrl(url)) {
    return result('safelist', EXIT.SAFELIST, 'SAFELIST_BLOCKED', 'SAFELIST_BLOCKED: the link did not clear the block (an older link? use the NEWEST email; links are single use)', { url: safeUrl(url) });
  }
  const s = await d.browser.saveSession();
  const st = readState();
  const wasBlocked = !!st.safelist;
  Object.assign(st, { safelist: null, consecutiveFailures: 0, holdUntil: null, lastResult: 'ok', lastAttemptAt: isoNow(d) });
  writeState(st);
  if (wasBlocked) notify({ severity: 'info', key: 'caterer-safelist-cleared', text: 'Caterer safe-list block cleared; the session is signed in again.' });
  return result('ok', EXIT.OK, 'SAFELIST_CLEARED', `SAFELIST_CLEARED: signed in (${safeUrl(url)}); session ${s.saved ? 'saved' : 'NOT saved'}`, { url: safeUrl(url), saved: s.saved });
}

// ---------------------------------------------------------------- ensure (check, then heal once)

async function ensureLoggedInDetailed(o) {
  const opts = Object.assign({ allowRelogin: true, force: false, restoreState: 'auto' }, o);
  const d = deps(opts);
  const notes = [];
  const say = (m) => { notes.push(m); if (opts.log) opts.log(m); };
  const st = readState();
  const nowMs = () => d.now();
  const out = (state, detail, extra) => Object.assign({ state, detail: detail || '', reloggedIn: false, notes }, extra || {});

  await prepareBrowser(opts, d, notes);

  let chk = opts.force ? { state: 'login', detail: 'forced', notes: [] } : await checkLoggedIn(opts);
  notes.push(...(chk.notes || []));

  if (chk.state === 'network') {
    const host = new URL(SITE.BASE).hostname;
    const dnsOk = await d.dnsLookup(host);
    const last = st.lastBrowserReset ? Date.parse(st.lastBrowserReset) : 0;
    if (dnsOk && opts.allowRelogin && nowMs() - last > BROWSER_RESET_MIN_GAP_MS) {
      say('browser reports a network failure while name resolution works here: stale browser backend; resetting the browser once');
      await d.browser.reset();
      st.lastBrowserReset = isoNow(d);
      writeState(st);
      chk = await checkLoggedIn(opts);
      notes.push(...(chk.notes || []));
    } else {
      return out('error', dnsOk ? 'browser network failure (reset not allowed now): ' + chk.detail : 'network unreachable: ' + chk.detail);
    }
  }

  if (chk.state === 'ok') {
    const was = !!st.safelist;
    if (was || st.moduleError || st.consecutiveFailures) {
      Object.assign(st, { safelist: null, moduleError: null, consecutiveFailures: 0, holdUntil: null });
      writeState(st);
    }
    if (was) notify({ severity: 'info', key: 'caterer-safelist-cleared', text: 'Caterer safe-list block cleared; the session is signed in again.' });
    return out('ok');
  }

  if (chk.state === 'safelist') return finishSafelist(st, d, out);

  if (chk.state === 'moduleerror') return finishModuleError(st, d, out, chk.detail);

  if (chk.state === 'error' || chk.state === 'network') return out('error', chk.detail);

  // 'login' or 'unknown': the browser is not confirmed signed in.
  if (!opts.allowRelogin) return out(chk.state, chk.detail);

  const gate = opts.force ? { allow: true } : attemptGate(st, nowMs());
  if (!gate.allow) {
    say(`sign-in attempt suppressed (${gate.reason})`);
    return out(gate.state, `suppressed: ${gate.reason}`, { suppressed: gate.reason });
  }

  st.lastAttemptAt = isoNow(d);
  st.lastResult = 'attempting';
  writeState(st);
  const res = await login({ restoreState: 'never', save: false, log: say, _browser: d.browser, _sleep: d.sleep });
  st.lastAttemptAt = isoNow(d);

  if (res.status === 'safelist') {
    st.lastResult = 'safelist';
    const sl = st.safelist || (st.safelist = { since: isoNow(d), attempts: 0 });
    sl.lastAttemptAt = isoNow(d);
    sl.attempts = (sl.attempts || 0) + 1;
    writeState(st);
    return finishSafelist(st, d, out, true);
  }
  if (res.status === 'cred') {
    st.lastResult = 'cred';
    notifyOnce(st, 'cred', RENOTIFY.cred, { severity: 'critical', key: 'caterer-cred', text: `Caterer credentials are unusable (${res.marker}). Fix secrets/caterer-credentials.json; no login is attempted until then.` }, nowMs());
    writeState(st);
    return out('login', res.marker, { marker: res.marker });
  }
  if (res.status === 'failed') {
    st.lastResult = 'failed';
    st.consecutiveFailures = (st.consecutiveFailures || 0) + 1;
    if (st.consecutiveFailures >= FAIL_LIMIT) {
      st.holdUntil = new Date(nowMs() + FAIL_HOLD_MS).toISOString();
      notifyOnce(st, 'failed', RENOTIFY.failed, { severity: 'critical', key: 'caterer-login-failed', text: `Caterer login failed ${st.consecutiveFailures} times in a row (${res.message}). Automatic attempts are paused for 3 hours to protect the account; check the credentials and the login page, then run node scripts/caterer-login.js --force.` }, nowMs());
    } else {
      notifyOnce(st, 'failedWarn', RENOTIFY.failed, { severity: 'warn', key: 'caterer-login-failed', text: `Caterer login attempt failed (${res.message}). The next automatic attempt is at least 10 minutes away.` }, nowMs());
    }
    writeState(st);
    return out('login', res.marker, { marker: res.marker });
  }

  // login() reported success: verify on the search page like the legacy runner did.
  st.lastResult = 'ok';
  st.consecutiveFailures = 0;
  st.holdUntil = null;
  writeState(st);
  const v = await checkLoggedIn(opts);
  notes.push(...(v.notes || []));
  if (v.state === 'safelist') return finishSafelist(st, d, out, true);
  if (v.state === 'login') return out('login', 'signed in but the search page still shows the sign-in form', { reloggedIn: true });
  if (v.state === 'moduleerror') {
    await d.browser.saveSession();
    return finishModuleError(st, d, out, v.detail, true);
  }
  if (v.state === 'error' || v.state === 'network') say('post-login verification inconclusive (' + v.detail + '); proceeding');
  const sv = await d.browser.saveSession();
  say(sv.saved ? 'Session saved' : `WARN session not saved (${sv.skipped || sv.out || 'save failed'})`);
  if (st.safelist) { st.safelist = null; writeState(st); }
  return out('ok', '', { reloggedIn: true });
}

function finishSafelist(st, d, out, fresh) {
  if (!st.safelist) st.safelist = { since: isoNow(d), attempts: 0 };
  notifyOnce(st, 'safelist', RENOTIFY.safelist, { severity: 'critical', key: 'caterer-safelist', text: SAFELIST_ALERT }, d.now());
  writeState(st);
  return out('safelist', 'SafeListLoginBlocked', { reloggedIn: !!fresh });
}

function finishModuleError(st, d, out, detail, reloggedIn) {
  if (!st.moduleError) st.moduleError = { since: isoNow(d) };
  notifyOnce(st, 'moduleError', RENOTIFY.moduleError, { severity: 'warn', key: 'caterer-cvdb-module', text: 'Caterer CV Database search is failing on Caterer side (redirect loop / error page) although the session is signed in. Re-logging in will not help; Caterer sourcing is paused until it recovers.' }, d.now());
  writeState(st);
  return out('moduleerror', detail, { reloggedIn: !!reloggedIn });
}

async function ensureLoggedIn(o) { return (await ensureLoggedInDetailed(o)).state; }

// ---------------------------------------------------------------- CLI

const HELP = `caterer-login.js - Caterer session check and sign-in (one implementation)

Usage: node scripts/caterer-login.js [options]
  (no options)          check the browser session; sign in only if it is not signed in
  --check               check only, never sign in
  --force               skip the pre-check and the attempt limits, sign in now
  --restore-state       always load the saved session file before the login page
  --no-restore-state    never load it (default: only when the browser is cold)
  --open-link <url|->   open the newest emailed TwoFaAuthRedirect link in the session (- reads it from stdin)
  --json                print one JSON line at the end
  --help
Exit: 0 ok, 1 unexpected/unknown, 2 SAFELIST_BLOCKED, 3 CRED_*/LOGIN_FAILED, 4 CATERER_MODULE_ERROR, 64 usage
`;

function parseArgs(argv) {
  const a = { check: false, force: false, restoreState: 'auto', link: null, json: false, help: false, bad: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--check') a.check = true;
    else if (x === '--force') a.force = true;
    else if (x === '--restore-state') a.restoreState = 'always';
    else if (x === '--no-restore-state') a.restoreState = 'never';
    else if (x === '--json') a.json = true;
    else if (x === '--help' || x === '-h') a.help = true;
    else if (x === '--open-link') { a.link = argv[++i]; if (!a.link) a.bad = '--open-link needs a value'; }
    else a.bad = `unknown option ${x}`;
  }
  return a;
}

const STATE_EXIT = { ok: EXIT.OK, safelist: EXIT.SAFELIST, login: EXIT.FAILED, moduleerror: EXIT.MODULE, unknown: EXIT.ERROR, error: EXIT.ERROR };

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    let done = false;
    const fin = () => { if (!done) { done = true; process.stdin.pause(); resolve(s.split(/\r?\n/)[0].trim()); } };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; if (s.includes('\n')) fin(); });
    process.stdin.on('end', fin);
    process.stdin.on('error', fin);
  });
}

async function main(argv, io) {
  const w = (io && io.write) || ((t) => process.stdout.write(t));
  const line = (t) => w(t + '\n');
  const a = parseArgs(argv);
  if (a.help) { w(HELP); return EXIT.OK; }
  if (a.bad) { line(`usage error: ${a.bad}`); w(HELP); return EXIT.USAGE; }
  let final;
  if (a.link) {
    const link = a.link === '-' ? await readStdin() : a.link;
    final = await openVerificationLink(link, { log: line });
    line(final.message);
    if (a.json) line(JSON.stringify({ status: final.status, exitCode: final.exitCode }));
    return final.exitCode;
  }
  const r = await ensureLoggedInDetailed({ allowRelogin: !a.check, force: a.force, restoreState: a.restoreState, log: line });
  let code = STATE_EXIT[r.state] === undefined ? EXIT.ERROR : STATE_EXIT[r.state];
  if (r.state === 'ok') line(r.reloggedIn ? 'Login complete' : 'SESSION_OK: already signed in');
  else if (r.state === 'safelist') line('SAFELIST_BLOCKED: Caterer wants device verification; open the newest emailed link with: node scripts/caterer-login.js --open-link -');
  else if (r.state === 'login') line(`${r.marker || 'LOGIN_FAILED'}: not signed in${r.detail ? ' (' + r.detail + ')' : ''}`);
  else if (r.state === 'moduleerror') line(`CATERER_MODULE_ERROR: ${r.detail}. The session is fine; re-login will not help.`);
  else line(`CHECK_ERROR: ${r.state}${r.detail ? ' (' + r.detail + ')' : ''}`);
  if (a.json) line(JSON.stringify({ state: r.state, detail: r.detail, reloggedIn: r.reloggedIn, suppressed: r.suppressed || null, exitCode: code }));
  return code;
}

module.exports = {
  EXIT, STATE_FILE, ensureLoggedIn, ensureLoggedInDetailed, checkLoggedIn, login, openVerificationLink, main,
  buildFillJs, DISMISS_JS, SUBMIT_JS, STATE_PROBE_JS, loadCredentials, attemptGate, safeUrl, parseArgs,
};

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.stdout.write('', () => process.exit(code)); },
    (e) => { process.stderr.write(`caterer-login crashed: ${e && e.message}\n`, () => process.exit(EXIT.ERROR)); },
  );
}
