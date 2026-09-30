#!/usr/bin/env node
'use strict';

// Full Reed login + token capture over CDP, for Chrome 153 (Network events, no request interception).
//
//   node scripts/cdp-reed-full-login.js            automatic login with secrets/reed-credentials.json
//   node scripts/cdp-reed-full-login.js --human    one-time HUMAN-assisted login (Cloudflare Turnstile blocks headless login)
//   node scripts/cdp-reed-full-login.js --clean    first clear the Reed/Auth0 cookies + web storage (recovery for HTTP 451: the JWT ip claim
//                                                  comes from the SSO session, so the session itself must be re-established from a UK IP)
//   node scripts/cdp-reed-full-login.js --check-credentials
//
// Credentials ONLY come from secrets/reed-credentials.json: {"email": "...", "password": "..."} (mode 0600). Values are never printed.
// Stdout markers: REED_LOGIN_OK | REED_LOGIN_BLOCKED_TURNSTILE | REED_LOGIN_FAILED | REED_CRED_MISSING | REED_CRED_INVALID | REED_CRED_OK
// Exit codes: 0 logged in, 1 login failed or blocked (legacy REED_AUTH_FAILED semantics), 3 credentials missing/invalid,
//             4 browser.lock held by a live non-Reed run.
// On success the tab is LEFT OPEN on the candidate-search page (api.reed.co.uk answers 401 unless the tab sits there).
// A Turnstile block is recorded in runtime/reed-login-block.json so automatic attempts never loop until a human logs in; the operator gets ONE critical
// alert (reed-human-login) per episode, and run-pipeline skips Reed (reed-api-client.authHold) instead of spending Reed retries while it is pending.

const fs = require('fs');
const paths = require('./lib/paths');
const env = require('./lib/env');
const fsx = require('./lib/fsx');
const { notify } = require('./lib/notify');
const {
  decodeJwtPayload, saveSession, writeReedStatus, alertOnce, clearAlertEpisode, markAuthOk,
  CRED_FILE, LOGIN_BLOCK_FILE, SESSION_FILE, AUTH_MARKER,
} = require('./reed-api-client');
const { CdpConn, createBearerCapture } = require('./reed-refresh-token');
const launcher = require('./ensure-chrome-cdp');

const TARGET_URL = () => env.get('REED_TARGET_URL') || 'https://www.reed.co.uk/recruiter/v2/candidates/search/results';
const LOGIN_URL = () => env.get('REED_LOGIN_URL') || 'https://secure-recruiter.reed.co.uk/login';

// Legacy waits were fixed sleeps (5s, 1s, 10s, 8s); they are now polls with these ceilings.
const FORM_WAIT_MS = 15000;
const PASS_WAIT_MS = 10000;
const TURNSTILE_WAIT_MS = 15000;
const POST_SUBMIT_WAIT_MS = 12000;
const CAPTURE_WAIT_MS = 20000;

const EMAIL_SEL = 'input[type="email"],input[name="email"],input[id="email"],input[name="username"],input[id="username"],input[autocomplete="username"]';
const PASS_SEL = 'input[type="password"],input[name="password"]';
const TURNSTILE_SEL = 'iframe[src*="challenges.cloudflare.com"],.cf-turnstile,[name="cf-turnstile-response"]';

const numEnv = (name, dflt) => {
  const n = Number(env.get(name, String(dflt)));
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
const timeScale = () => numEnv('REED_LOGIN_TIME_SCALE', 1);
const T = (ms) => Math.max(20, Math.round(ms * timeScale()));
const sleep = fsx.sleep;

function log(msg) { process.stderr.write(`[reed-login] ${msg}\n`); }
function say(line) { process.stdout.write(`${line}\n`); }

// ---------------------------------------------------------------- credentials

const PLACEHOLDER_RE = /^(changeme|change_me|replace_me|replace|todo|placeholder|your[-_ ]?(email|password)|x{3,}|<.*>)$/i;

function loadCredentials() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { error: 'REED_CRED_MISSING', message: `credentials file ${CRED_FILE} is missing or not valid JSON (schema: {"email":"...","password":"..."})` };
  }
  const email = typeof (raw && (raw.email || raw.username)) === 'string' ? (raw.email || raw.username).trim() : '';
  const password = typeof (raw && raw.password) === 'string' ? raw.password : '';
  if (!email || !password) {
    return { error: 'REED_CRED_MISSING', message: `${CRED_FILE} needs non-empty "email" and "password" fields` };
  }
  if (PLACEHOLDER_RE.test(email) || PLACEHOLDER_RE.test(password.trim())) {
    return { error: 'REED_CRED_INVALID', message: `${CRED_FILE} still contains placeholder values` };
  }
  if (process.platform !== 'win32') {
    try {
      if (fs.statSync(CRED_FILE).mode & 0o077) log(`WARN: ${CRED_FILE} is readable by group/others; run chmod 600 on it`);
    } catch { /* ignore */ }
  }
  return { email, password };
}

// ---------------------------------------------------------------- login-block marker (never loop)

function readBlock() {
  const b = fsx.readJson(LOGIN_BLOCK_FILE, null);
  if (!b || !b.blockedAt) return null;
  const ageH = (Date.now() - Date.parse(b.blockedAt)) / 3600000;
  return { ...b, ageH };
}

function humanLoginCommand() {
  return `cd ${paths.HOME} && node scripts/cdp-reed-full-login.js --human`;
}

function humanInstructions() {
  const c = launcher.config();
  return [
    'Reed needs a one-time human login (Cloudflare Turnstile blocks automated login from this server).',
    `1. On the instance run:  ${humanLoginCommand()}`,
    `2. From your own computer forward the browser port:  ssh -N -L ${c.port}:127.0.0.1:${c.port} <user>@<instance-host>`,
    '3. In Chrome open chrome://inspect/#devices, click Configure, add localhost:' + c.port + ', then Inspect the Reed login page.',
    '4. Log in to Reed Recruiter in the inspected page (solve the check, enter the password, complete any 2FA).',
    'The command exits 0 with REED_LOGIN_OK once the session is captured; the pipeline resumes Reed by itself.',
  ];
}

// The block file paces automatic retries, the alert episode paces the page to the operator: one critical alert from the first block until a login succeeds.
function announceBlock(reason) {
  const prev = readBlock();
  fsx.writeJsonAtomic(LOGIN_BLOCK_FILE, { blockedAt: new Date().toISOString(), reason, attempts: ((prev && prev.attempts) || 0) + 1 });
  const command = humanLoginCommand();
  const port = launcher.config().port;
  alertOnce('reed-human-login', {
    severity: 'critical',
    text: `Reed needs a one-time human login. Run on the instance: ${command} then complete the login in the browser at 127.0.0.1:${port} (ssh -N -L ${port}:127.0.0.1:${port} USER@INSTANCE_HOST, then chrome://inspect > Configure > Inspect). Reed is skipped until this is done; Caterer keeps running.`,
    meta: { command, reason },
  });
}

function clearBlock() {
  fsx.safeUnlink(LOGIN_BLOCK_FILE);
}

// ---------------------------------------------------------------- page-side scripts (values are always JSON-embedded)

const jsFill = (selector, value) => `(function(sel,val){var e=document.querySelector(sel);if(!e)return 'missing';e.focus();var d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');if(d&&d.set){d.set.call(e,val);}else{e.value=val;}e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return e.value===val?'ok':'mismatch';})(${JSON.stringify(selector)},${JSON.stringify(value)})`;

const JS_CLICK = "(function(){var b=document.querySelector('button[type=\"submit\"]');if(b){b.click();return 'clicked';}var f=document.querySelector('form');if(f&&f.requestSubmit){f.requestSubmit();return 'submitted';}return 'no btn';})()";

const JS_STATE = `(function(){var q=function(s){return document.querySelector(s);};var t=document.title||'';var i=q('input[name="cf-turnstile-response"]');return JSON.stringify({url:location.href,title:t.slice(0,80),hasEmail:!!q(${JSON.stringify(EMAIL_SEL)}),hasPass:!!q(${JSON.stringify(PASS_SEL)}),turnstile:!!q(${JSON.stringify(TURNSTILE_SEL)}),turnstileSolved:!!(i&&i.value&&i.value.length>0),interstitial:/just a moment|attention required|verify you are human/i.test(t)});})()`;

async function evalJs(conn, expression) {
  const r = await conn.send('Runtime.evaluate', { expression, returnByValue: true }, 30000);
  if (r && r.exceptionDetails) throw new Error('page script failed');
  return r && r.result ? r.result.value : undefined;
}

// Page scripts can hit "execution context destroyed" while a navigation settles; retry a couple of times.
async function evalRetry(conn, expression, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await evalJs(conn, expression);
    } catch (e) {
      last = e;
      await sleep(T(400));
    }
  }
  throw last;
}

async function getState(conn) {
  try {
    const v = await evalJs(conn, JS_STATE);
    return typeof v === 'string' ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

async function pollUntil(fn, timeoutMs, stepMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(stepMs);
  }
}

const isLoginUrl = (url) => /^https?:\/\/secure-recruiter\.reed\.co\.uk(:\d+)?\//i.test(String(url || ''));
const turnstileUnsolved = (s) => !!s && (s.interstitial || (s.turnstile && !s.turnstileSolved));

// ---------------------------------------------------------------- tabs

async function getTabs(c) {
  const r = await launcher.cdpHttp(c, 'GET', '/json', 5000);
  return r && Array.isArray(r.body) ? r.body : [];
}

async function createTab(c, url) {
  const r = await launcher.cdpHttp(c, 'PUT', `/json/new?${encodeURIComponent(url)}`, 8000);
  const tab = r && r.status >= 200 && r.status < 300 ? r.body : null;
  if (!tab || !tab.id || !tab.webSocketDebuggerUrl) throw new Error('Failed to create new tab');
  return tab;
}

const closeTab = (c, id) => launcher.cdpHttp(c, 'PUT', `/json/close/${id}`, 5000).catch(() => null);

// Sweeps stale auth-flow tabs from failed runs, but never the last page (closing the last tab ends the browser).
async function sweepStaleAuthTabs(c) {
  const pages = (await getTabs(c)).filter((t) => t.type === 'page');
  const stale = pages.filter((t) => isLoginUrl(t.url));
  const safeToClose = stale.slice(0, Math.max(0, pages.length - 1));
  if (safeToClose.length) {
    log(`Sweeping ${safeToClose.length} stale auth tab(s) (of ${stale.length} matched, ${pages.length} total pages)`);
    await Promise.all(safeToClose.map((t) => closeTab(c, t.id)));
  }
}

async function navigate(conn, url) {
  const r = await conn.send('Page.navigate', { url }, 45000);
  if (r && r.errorText) throw new Error(`navigation failed: ${r.errorText}`);
}

// ---------------------------------------------------------------- shared capture step

// Navigates the tab to the search page and waits for a Bearer on api.reed.co.uk. Leaves the tab there.
async function captureOnSearchPage(conn, tokenBox) {
  const prev = tokenBox.token;
  tokenBox.token = null;
  await navigate(conn, TARGET_URL());
  const got = await pollUntil(async () => tokenBox.token, T(CAPTURE_WAIT_MS), T(250));
  return got || prev || null;
}

function attachCapture(conn) {
  const box = { token: null };
  const cap = createBearerCapture();
  conn.onEvent((msg) => {
    if (box.token) return;
    const t = cap.feed(msg);
    if (t) box.token = t;
  });
  return box;
}

// The JWT ip claim comes from the SSO session; it is printed (a public IP, not a secret) to diagnose HTTP 451.
function persist(token) {
  const payload = decodeJwtPayload(token);
  const expiresAt = (payload && payload.exp) || Math.floor(Date.now() / 1000) + 1800;
  saveSession({ accessToken: token, refreshToken: null, expiresAt, obtainedAt: new Date().toISOString() });
  return { expiresAt, ip: (payload && payload['https://www.reed.co.uk/api/auth/ip']) || 'unknown' };
}

// ---------------------------------------------------------------- clean session (recovery)

const CLEAN_ORIGINS = ['https://www.reed.co.uk', 'https://secure-recruiter.reed.co.uk', 'https://reed-recruiter-prod.eu.auth0.com', 'https://api.reed.co.uk'];

async function cleanSession(c) {
  const tab = await createTab(c, 'about:blank');
  const conn = new CdpConn(tab.webSocketDebuggerUrl);
  try {
    await conn.open();
    await conn.send('Network.enable');
    await conn.send('Page.enable');
    await navigate(conn, `${new URL(TARGET_URL()).origin}/`);
    await sleep(T(3000));
    const r = await conn.send('Network.getCookies', { urls: CLEAN_ORIGINS });
    const cookies = (r && r.cookies) || [];
    for (const ck of cookies) await conn.send('Network.deleteCookies', { name: ck.name, domain: ck.domain, path: ck.path });
    await evalRetry(conn, 'localStorage.clear(); sessionStorage.clear(); "cleared"');
    log(`Cleared ${cookies.length} Reed/Auth0 cookies and the web storage`);
    fsx.safeUnlink(SESSION_FILE);
    return cookies.length;
  } finally {
    conn.close();
    await closeTab(c, tab.id);
  }
}

// ---------------------------------------------------------------- automatic login

// -> {ok:true, expiresAt} | {ok:false, blocked:boolean, reason}
async function runAutomaticLogin(creds, opts = {}) {
  const c = launcher.config();
  if (opts.clean) await cleanSession(c);
  await sweepStaleAuthTabs(c).catch(() => {});
  const tab = await createTab(c, 'about:blank');
  log(`Tab ${tab.id} (fresh)`);
  const conn = new CdpConn(tab.webSocketDebuggerUrl);
  let ok = false;
  try {
    await conn.open();
    const box = attachCapture(conn);
    await conn.send('Network.enable');
    await conn.send('Page.enable');

    log('Navigating to login...');
    await navigate(conn, LOGIN_URL());

    let st = await pollUntil(async () => {
      const s = await getState(conn);
      if (!s) return null;
      if (s.hasEmail) return s;
      if (!isLoginUrl(s.url) && /reed\.co\.uk/i.test(s.url) && !s.interstitial) return s;
      return null;
    }, T(FORM_WAIT_MS), T(500));

    if (!st) {
      const last = await getState(conn);
      if (turnstileUnsolved(last)) return { ok: false, blocked: true, reason: 'turnstile_challenge_before_form' };
      return { ok: false, blocked: false, reason: 'login_form_not_found' };
    }

    if (st.hasEmail) {
      log('Filling email...');
      if ((await evalRetry(conn, jsFill(EMAIL_SEL, creds.email))) === 'missing') return { ok: false, blocked: false, reason: 'email_field_missing' };
      let s2 = await getState(conn);
      if (!s2 || !s2.hasPass) {
        log('Two-step form: continuing to the password step...');
        await evalRetry(conn, JS_CLICK);
        s2 = await pollUntil(async () => {
          const s = await getState(conn);
          return s && s.hasPass ? s : null;
        }, T(PASS_WAIT_MS), T(500));
        if (!s2) {
          const last = await getState(conn);
          if (turnstileUnsolved(last)) return { ok: false, blocked: true, reason: 'turnstile_challenge_at_email_step' };
          return { ok: false, blocked: false, reason: 'password_field_not_found' };
        }
      }
      log('Filling password...');
      if ((await evalRetry(conn, jsFill(PASS_SEL, creds.password))) === 'missing') return { ok: false, blocked: false, reason: 'password_field_missing' };
      await sleep(T(1000));

      const gate = await getState(conn);
      if (turnstileUnsolved(gate)) {
        log('Cloudflare check present - waiting for it to resolve...');
        const solved = await pollUntil(async () => {
          const s = await getState(conn);
          return s && !turnstileUnsolved(s) ? s : null;
        }, T(TURNSTILE_WAIT_MS), T(500));
        if (!solved) return { ok: false, blocked: true, reason: 'turnstile_unsolved' };
      }

      log('Clicking sign in...');
      await evalRetry(conn, JS_CLICK);
      await pollUntil(async () => {
        if (box.token) return 'token';
        const s = await getState(conn);
        return s && !isLoginUrl(s.url) ? 'moved' : null;
      }, T(POST_SUBMIT_WAIT_MS), T(500));
      const after = await getState(conn);
      if (!box.token && after && isLoginUrl(after.url) && turnstileUnsolved(after)) {
        return { ok: false, blocked: true, reason: 'turnstile_after_submit' };
      }
    } else {
      log('Already logged in (persistent profile) - skipping the form');
    }

    log('Navigating to candidates search (token capture + leave tab on search page)...');
    const token = await captureOnSearchPage(conn, box);
    if (!token) {
      const last = await getState(conn);
      if (turnstileUnsolved(last) && isLoginUrl(last && last.url)) return { ok: false, blocked: true, reason: 'turnstile_on_redirect' };
      return { ok: false, blocked: false, reason: last && isLoginUrl(last.url) ? 'login_rejected' : 'no_token_captured' };
    }
    const saved = persist(token);
    ok = true;
    log(`Tab ${tab.id} LEFT OPEN (logged-in recruiter session on search page)`);
    return { ok: true, ...saved };
  } finally {
    conn.close();
    if (!ok) {
      await closeTab(c, tab.id);
      log(`Tab ${tab.id} closed (login failed)`);
    }
  }
}

// ---------------------------------------------------------------- human-assisted login

async function runHumanLogin(waitMin, opts = {}) {
  const c = launcher.config();
  if (opts.clean) await cleanSession(c);
  const tab = await createTab(c, LOGIN_URL());
  for (const line of humanInstructions()) say(line);
  say(`Waiting up to ${waitMin} minute(s) for the login to complete...`);
  const deadline = Date.now() + waitMin * 60000;
  const inRecruiter = (t) => /^https?:\/\/www\.reed\.co\.uk(:\d+)?\/recruiter/i.test(String(t.url || ''));
  // Tabs already sitting in the recruiter area (stale, from before) must not count as "the human logged in".
  const stale = new Set((await getTabs(c)).filter((t) => t.type === 'page' && inRecruiter(t)).map((t) => t.id));
  let target = null;
  while (Date.now() < deadline && !target) {
    const pages = (await getTabs(c)).filter((t) => t.type === 'page' && !stale.has(t.id));
    const mine = pages.find((t) => t.id === tab.id);
    target = [mine, ...pages].filter(Boolean).find(inRecruiter) || null;
    if (!target) await sleep(T(2000));
  }
  if (!target) return { ok: false, blocked: false, reason: 'human_login_timeout' };

  const conn = new CdpConn(target.webSocketDebuggerUrl);
  try {
    await conn.open();
    const box = attachCapture(conn);
    await conn.send('Network.enable');
    log('Login detected - capturing token...');
    const token = await captureOnSearchPage(conn, box);
    if (!token) return { ok: false, blocked: false, reason: 'no_token_captured' };
    return { ok: true, ...persist(token) };
  } finally {
    conn.close();
  }
}

// ---------------------------------------------------------------- CLI

const USAGE = `Usage: node scripts/cdp-reed-full-login.js [--human [--wait-min N]] [--clean] [--ignore-block] [--check-credentials]
  (default)            automatic login with ${CRED_FILE}
  --human              one-time human-assisted login (see the instructions it prints); waits N minutes (default 30)
  --clean              clear the Reed/Auth0 cookies and web storage first (HTTP 451 recovery); works with --human too
  --ignore-block       attempt automatic login even though a Turnstile block is recorded
  --check-credentials  validate the credentials file and exit (no browser)
Credentials file schema: {"email": "...", "password": "..."} (mode 0600). Values are never printed or logged.
Markers: REED_LOGIN_OK REED_LOGIN_BLOCKED_TURNSTILE REED_LOGIN_FAILED REED_CRED_MISSING REED_CRED_INVALID REED_CRED_OK
Exit codes: 0 ok, 1 login failed/blocked, 3 credentials missing/invalid, 4 browser locked by a live Caterer run.`;

async function main(argv) {
  const has = (f) => argv.includes(f);
  if (has('--help') || has('-h')) { say(USAGE); return 0; }
  const human = has('--human');

  if (has('--check-credentials')) {
    const creds = loadCredentials();
    if (creds.error) { say(`${creds.error}: ${creds.message}`); return 3; }
    credentialsFixed();
    say('REED_CRED_OK');
    return 0;
  }

  if (!human) {
    const block = readBlock();
    const windowH = numEnv('REED_LOGIN_BLOCK_HOURS', 12);
    if (block && block.ageH < windowH && !has('--ignore-block')) {
      say(`REED_LOGIN_BLOCKED_TURNSTILE: human login pending since ${block.blockedAt}; automatic attempts are paused for ${windowH}h (run: ${humanLoginCommand()}).`);
      return 1;
    }
    const creds = loadCredentials();
    if (creds.error) {
      writeReedStatus('auth_failed', creds.error);
      alertOnce('reed-credentials', {
        severity: 'critical',
        text: `Reed credentials are missing or invalid (${creds.error}). Create ${CRED_FILE} as {"email":"...","password":"..."} with mode 0600, then verify it with: cd ${paths.HOME} && node scripts/cdp-reed-full-login.js --check-credentials . Reed is skipped until this is done; Caterer keeps running.`,
        meta: { reason: creds.error },
      });
      say(`${creds.error}: ${creds.message}`);
      return 3;
    }
    credentialsFixed();
    return withBrowser('login', async () => {
      let res;
      try {
        res = await runAutomaticLogin(creds, { clean: has('--clean') });
      } catch (err) {
        res = { ok: false, blocked: false, reason: 'error', detail: env.redact(err.message) };
      }
      return finish(res);
    });
  }

  const wi = argv.indexOf('--wait-min');
  const waitMin = wi >= 0 && Number(argv[wi + 1]) > 0 ? Number(argv[wi + 1]) : 30;
  return withBrowser('human-login', async () => {
    let res;
    try {
      res = await runHumanLogin(waitMin, { clean: has('--clean') });
    } catch (err) {
      res = { ok: false, blocked: false, reason: 'error', detail: env.redact(err.message) };
    }
    if (res.ok) {
      notify({ severity: 'info', key: 'reed-human-login', text: 'Reed human login completed; Reed sourcing resumes.' });
    }
    return finish(res);
  });
}

// A valid credentials file closes the missing-credentials episode and lifts its failure marker, so Reed resumes at once.
function credentialsFixed() {
  clearAlertEpisode('reed-credentials');
  const mk = fsx.readJson(AUTH_MARKER, null);
  if (mk && mk.reason === 'reed_credentials_missing') fsx.safeUnlink(AUTH_MARKER);
}

function finish(res) {
  if (res.ok) {
    markAuthOk('login captured', { all: true });
    say(`REED_LOGIN_OK expires=${new Date(res.expiresAt * 1000).toISOString()} ip=${res.ip}`);
    return 0;
  }
  if (res.blocked) {
    announceBlock(res.reason);
    writeReedStatus('auth_failed', `human login required (${res.reason})`);
    say(`REED_LOGIN_BLOCKED_TURNSTILE: ${res.reason}`);
    for (const line of humanInstructions()) log(line);
    return 1;
  }
  writeReedStatus('auth_failed', `login failed (${res.reason})`);
  say(`REED_LOGIN_FAILED: ${res.reason}${res.detail ? ` (${String(res.detail).slice(0, 120)})` : ''}`);
  return 1;
}

// Lock + browser bracket shared by both modes. A lock held by an ancestor (run-pipeline hand-off) is borrowed.
async function withBrowser(purpose, fn) {
  const lock = launcher.browserLock.acquire('reed', { purpose });
  if (!lock.acquired) {
    const h = lock.holder || {};
    say(`REED_LOGIN_FAILED: browser.lock held by ${h.owner || 'another process'} (pid ${h.pid || '?'})`);
    return 4;
  }
  try {
    const r = await launcher.ensureChrome({ onMessage: (m, t) => log(`${m}: ${t}`) });
    if (!r.ok) {
      say(`REED_LOGIN_FAILED: browser not available (${r.marker})`);
      return r.exit === 4 ? 4 : 1;
    }
    return await fn();
  } finally {
    lock.release();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    say(`REED_LOGIN_FAILED: ${env.redact(err.message)}`);
    process.exit(1);
  });
}

module.exports = {
  main, loadCredentials, runAutomaticLogin, runHumanLogin, isLoginUrl, humanLoginCommand, readBlock, clearBlock,
  EMAIL_SEL, PASS_SEL, TURNSTILE_SEL,
};
