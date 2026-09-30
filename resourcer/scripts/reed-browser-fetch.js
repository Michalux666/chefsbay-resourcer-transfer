#!/usr/bin/env node
'use strict';

// Browser-proxy for Reed BFF API calls. api.reed.co.uk needs the Cloudflare cf_clearance cookie and a live logged-in tab, so
// every request runs inside that tab via CDP Runtime.evaluate on the persistent Reed browser (127.0.0.1:<REED_CDP_PORT>).
// Usage: const { reedBrowserFetch, reedBrowserFetchPost, reedBrowserFetchBinary } = require('./reed-browser-fetch');
//
// Request path (docs/parity/reed-first-page.md, the HTTP 400 / RequiredHeaderMissingException / 50010 incident of 2026-09-30):
//   (a) the token is resolved in Node (session file, else a navigate-capture) and travels INSIDE the evaluation that sends the request;
//       no page variable is set by a separate call, so a navigation that replaces the document cannot empty the bearer;
//   (b) a token that is not a JWT (three dot-separated parts) is never sent: REED_TOKEN_MISSING (retriable, code 'REED_TOKEN_MISSING');
//   (c) before the request the tab must be loaded (readyState complete), idle for REED_TAB_SETTLE_MS and unchanged between two polls,
//       bounded by REED_TAB_READY_WAIT_MS; the tab is never navigated here (a tab off the search page still answers 401, as before);
//   (d) HTTP 400 naming RequiredHeaderMissingException / 50010 (and a missing token, and a navigation during the request) is retried up to
//       REQUEST_ATTEMPTS (3) times in total with a short backoff, the token is re-captured once, all inside REED_RETRY_CAP_MS;
//       401/403/429/451 and every other status keep their handling and are never retried here;
//   (e) every failed attempt logs ONE forensic line (REED_REQUEST_FORENSIC) without any secret.

const { API_BASE } = require('./reed-api-client');
const { CdpConn, getCdpTabs, pickReedTab } = require('./reed-refresh-token');
const launcher = require('./ensure-chrome-cdp');
const env = require('./lib/env');
const fsx = require('./lib/fsx');

const SEND_TIMEOUT_MS = 60000;
const REQUEST_ATTEMPTS = 3;
const READY_POLL_MS = 150;
const OLD_PAGE_MS = 30000; // a page older than this needs no stability check

const numEnv = (name, dflt) => {
  const n = Number(env.get(name, String(dflt)));
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
const READY_WAIT_MS = () => numEnv('REED_TAB_READY_WAIT_MS', 10000); // 0 switches the wait off
const SETTLE_MS = () => numEnv('REED_TAB_SETTLE_MS', 1500);
const RETRY_BACKOFF_MS = () => numEnv('REED_RETRY_BACKOFF_MS', 1500);
const RETRY_CAP_MS = () => numEnv('REED_RETRY_CAP_MS', 45000);

function log(msg) { process.stderr.write(`[reed-browser-fetch] ${msg}\n`); }

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
// Three non-empty dot-separated base64url parts and a plausible length. Nothing here ever returns or logs the value.
const looksLikeJwt = (t) => typeof t === 'string' && t.length >= 50 && JWT_RE.test(t);

function jwtExpMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return payload && payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function lenBucket(n) {
  if (!n) return '0';
  if (n < 100) return '<100';
  if (n < 300) return '100-299';
  if (n < 600) return '300-599';
  if (n < 1000) return '600-999';
  return '1000+';
}

// Error codes of this module (err.code). Kept as constants: a quoted name in a call would read as an environment variable to the docs check.
const CODE_TOKEN_MISSING = 'REED_TOKEN_MISSING';
const CODE_NAV_DURING_REQUEST = 'REED_NAV_DURING_REQUEST';

function codedError(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  return Object.assign(e, extra || {});
}

// ---------------------------------------------------------------- tab discovery

async function findReedTab() {
  const tab = pickReedTab(await getCdpTabs());
  return tab ? tab.webSocketDebuggerUrl : null;
}

// One relaunch attempt per process when the browser died mid-run (for example killed by the OOM killer).
let relaunchAttempted = false;
async function locateReedTab() {
  let lastErr = null;
  try {
    const url = await findReedTab();
    if (url) return url;
  } catch (e) {
    lastErr = e;
  }
  if (!relaunchAttempted && env.get('REED_AUTO_RELAUNCH', '1') !== '0') {
    relaunchAttempted = true;
    const r = await launcher.ensureChrome({ ensureReedTab: true });
    log(`Reed browser relaunch: ${r.marker}`);
    if (r.ok) {
      try {
        const url = await findReedTab();
        if (url) return url;
      } catch (e) {
        lastErr = e;
      }
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

// ---------------------------------------------------------------- persistent CDP connection

let conn = null;
let connUrl = null;

async function connectCdp(wsUrl) {
  if (conn && connUrl === wsUrl && conn.ws && conn.ws.readyState === 1) return;
  closeCdp();
  const c = new CdpConn(wsUrl);
  await c.open(5000);
  conn = c;
  connUrl = wsUrl;
  log('CDP connected');
}

async function cdpEvaluate(expression) {
  if (!conn || !conn.ws || conn.ws.readyState !== 1) throw new Error('CDP not connected');
  const result = await conn.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, timeout: 30000,
  }, SEND_TIMEOUT_MS);
  if (result && result.exceptionDetails) {
    const exc = result.exceptionDetails;
    throw new Error(`JS exception: ${(exc.exception && exc.exception.description) || exc.text || 'unknown'}`);
  }
  return result && result.result ? result.result.value : undefined;
}

function closeCdp() {
  if (conn) {
    conn.close();
    conn = null;
    connUrl = null;
  }
}

async function ensureTab() {
  const wsUrl = await locateReedTab();
  if (!wsUrl) {
    throw new Error('No Reed browser tab found. Run: node scripts/ensure-chrome-cdp.js --ensure-reed-tab and make sure the Reed session is logged in.');
  }
  await connectCdp(wsUrl);
}

// ---------------------------------------------------------------- token (resolved in Node, sent inside the request)

let tokenState = null; // {token, at}

// A later process step (reed-download after a forced refresh) calls this so the next request re-reads the session file.
function invalidateToken() { tokenState = null; }

// Usable for a request now: a JWT that does not expire within the next 15 seconds.
function tokenUsable(token) {
  if (!looksLikeJwt(token)) return false;
  const exp = jwtExpMs(token);
  return exp === null || exp - Date.now() > 15000;
}

// Priority (legacy: page variable, session file, navigate-capture; the variable is gone): the token of this process while it lasts, the
// session file when valid, getToken() (navigate-capture, never refreshToken() of the API client: 2026-06-17), and, when `recapture`, a
// forced navigate-capture. Throws REED_TOKEN_MISSING when no JWT could be obtained. `budgetMs` bounds a capture.
// Concurrent callers (Phase 2 downloads run in parallel) share one resolution, so two requests never start two navigate-captures.
let resolving = null;
function resolveToken(opts = {}) {
  if (!opts.recapture && tokenState && tokenUsable(tokenState.token)) return Promise.resolve(tokenState);
  if (!resolving) resolving = resolveTokenNow(opts).finally(() => { resolving = null; });
  return resolving;
}

async function resolveTokenNow({ recapture = false, budgetMs } = {}) {
  if (!recapture && tokenState && tokenUsable(tokenState.token)) return tokenState;
  const previous = tokenState; // a re-capture that fails must not throw away a token that still works
  tokenState = null;
  const { isTokenValid, loadSession, getToken } = require('./reed-api-client');
  let token = null;
  let capture = recapture;
  if (!recapture) {
    const session = loadSession();
    const valid = !!session && isTokenValid(session);
    if (valid && looksLikeJwt(session.accessToken)) {
      tokenState = { token: session.accessToken, at: Date.now() };
      log('Token taken from reed-session.json');
      return tokenState;
    }
    if (valid) {
      log('The saved token is not a JWT - it is not used');
      capture = true;
    } else {
      log('Session file token expired or missing - capturing fresh token via getToken (browser CDP)...');
      try {
        token = await getToken(); // a failed capture inside getToken is not repeated below
      } catch (e) {
        log(`Token refresh failed: ${e.message}`);
      }
    }
  }
  if (capture) {
    log(recapture ? 'Re-capturing the token through the browser after a failed request...' : 'Capturing the token through the browser...');
    try {
      const { refreshToken } = require('./reed-refresh-token');
      token = await refreshToken({ timeoutMs: budgetMs });
    } catch (e) {
      log(`Token capture failed: ${String(e.message).slice(0, 120)}`);
      token = null;
    }
  }
  if (!looksLikeJwt(token) && recapture) {
    // The re-capture is an optional extra. The token of this process, or else the saved one, is sent again when it is still usable:
    // a transient 400 is then retried with a token that is known to be good instead of ending as "no token" (the real 400 is kept).
    let keep = previous && tokenUsable(previous.token) ? previous : null;
    if (!keep) {
      const session = loadSession();
      if (session && isTokenValid(session) && looksLikeJwt(session.accessToken)) keep = { token: session.accessToken, at: Date.now() };
    }
    if (keep) {
      tokenState = keep;
      log('Re-capture did not finish - sending again with the earlier token');
      return tokenState;
    }
  }
  if (!looksLikeJwt(token)) {
    throw codedError(CODE_TOKEN_MISSING, 'REED_TOKEN_MISSING: no usable Reed token (saved session and browser capture). Log in again with: node scripts/cdp-reed-full-login.js');
  }
  tokenState = { token, at: Date.now() };
  log('Token obtained (capture from the live tab)');
  return tokenState;
}

// ---------------------------------------------------------------- the tab is on the search page and idle

const READY_EXPR = `(function () {
  var p = typeof performance !== 'undefined';
  return JSON.stringify({ path: location.pathname, rs: document.readyState, since: p ? Math.round(performance.now()) : -1, origin: p ? performance.timeOrigin : 0 });
})()`;

const onSearchPage = (p) => /candidates\/search/.test(String(p || ''));

// -> {ready, path, sinceNavMs, waitedMs}. Bounded by REED_TAB_READY_WAIT_MS; never navigates; a tab that is settled but not on the search page
// is not waited for (nothing is in flight), the API then answers 401 and the caller's relogin handling applies, exactly as before.
async function waitTabReady() {
  const maxWait = READY_WAIT_MS();
  if (maxWait === 0) return { ready: null, path: null, sinceNavMs: null, waitedMs: 0 };
  const settle = SETTLE_MS();
  const start = Date.now();
  let prev = null;
  let s = null;
  for (;;) {
    try {
      s = JSON.parse(await cdpEvaluate(READY_EXPR));
    } catch {
      s = null; // the document was being replaced while asked
    }
    const idle = !!s && s.rs === 'complete' && s.since >= settle;
    if (idle && (s.since >= OLD_PAGE_MS || (prev && prev.origin === s.origin))) {
      if (!onSearchPage(s.path)) log(`Tab is on ${String(s.path).slice(0, 80)}, not the search page: sending anyway (Reed answers 401 off the search page)`);
      return { ready: true, path: s.path, sinceNavMs: s.since, waitedMs: Date.now() - start };
    }
    prev = idle ? s : null;
    if (Date.now() - start >= maxWait) {
      log(`Tab not ready after ${Math.round(maxWait / 1000)}s (${s ? `${s.rs}, ${s.since} ms since the last navigation` : 'document replaced'}): sending anyway`);
      return { ready: false, path: s ? s.path : null, sinceNavMs: s ? s.since : null, waitedMs: Date.now() - start };
    }
    await fsx.sleep(READY_POLL_MS);
  }
}

// ---------------------------------------------------------------- one request, in the page

// The expression is built from JSON.stringify'd values only: URL, header map (token included) and body cannot break out of it.
// The page reports where it was, how long since its last navigation and whether the document changed during the request.
function buildExpression({ url, method, headers, bodyStr, binary }) {
  const opts = `{ method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers)}${bodyStr ? `, body: ${JSON.stringify(bodyStr)}` : ''} }`;
  const tail = binary
    ? `return r.arrayBuffer().then(function (buf) {
          var bytes = new Uint8Array(buf);
          var binStr = '';
          var chunkSize = 8192;
          for (var i = 0; i < bytes.length; i += chunkSize) { binStr += String.fromCharCode.apply(null, bytes.slice(i, i + chunkSize)); }
          return JSON.stringify({ status: r.status, contentType: r.headers.get('content-type') || '', contentDisposition: r.headers.get('content-disposition') || '', base64: btoa(binStr), size: bytes.length, meta: meta() });
        });`
    : `return r.text().then(function (t) { return JSON.stringify({ status: r.status, body: t, meta: meta() }); });`;
  return `(function () {
    var p = typeof performance !== 'undefined';
    var t0 = p ? performance.timeOrigin : 0;
    function meta() { return { path: location.pathname, since: p ? Math.round(performance.now()) : -1, nav: p ? performance.timeOrigin !== t0 : false, rs: document.readyState }; }
    return fetch(${JSON.stringify(url)}, ${opts}).then(function (r) { ${tail} }).catch(function (e) { return JSON.stringify({ error: e.message, meta: meta() }); });
  })()`;
}

const DESTROYED_RE = /context was destroyed|Cannot find context|Inspected target navigated|Promise was collected|Target closed|Execution context/i;

const isHeaderMissing = (status, body) => status === 400 && /RequiredHeaderMissing|\b50010\b/.test(String(body || ''));

function bodyCode(body) {
  const m = /"errorCode"\s*:\s*"?(\d{3,6})/.exec(String(body || ''));
  return m ? m[1] : 'none';
}

const safePath = (p) => (p ? String(p).replace(/[^A-Za-z0-9/_.~%-]/g, '_').slice(0, 120) : 'unknown');

// One line per failed attempt. Names and coarse numbers only: no token, no header value, no query string, no body.
function forensicLine(f) {
  log(`REED_REQUEST_FORENSIC attempt=${f.attempt}/${REQUEST_ATTEMPTS} status=${f.status == null ? 'none' : f.status} code=${f.code || 'none'} headers=${f.names.join(',') || 'none'} token=${f.tokenLen ? 'yes' : 'no'} len=${lenBucket(f.tokenLen)} path=${safePath(f.path)} sinceNavMs=${f.sinceNavMs == null ? 'unknown' : f.sinceNavMs} sinceTokenMs=${f.sinceTokenMs == null ? 'unknown' : f.sinceTokenMs} navDuringRequest=${f.nav} readyState=${f.readyState || 'unknown'}`);
}

// Runs the request with the attempt loop described at the top of the file. Resolves the parsed page result ({status, body|base64, ...}) of the
// first attempt that is not a retriable failure; throws the final error otherwise. `toError(parsed)` builds the error for a status >= 400.
async function requestInPage({ url, method, bodyStr, binary, toError }) {
  const start = Date.now();
  const cap = RETRY_CAP_MS();
  const backoff = RETRY_BACKOFF_MS();
  let recaptured = false;
  let needRecapture = false;
  let lastFailure = null;
  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt++) {
    const f = { attempt, status: null, code: null, names: [], tokenLen: 0, path: null, sinceNavMs: null, sinceTokenMs: null, nav: 'unknown', readyState: null };
    let failure = null;
    try {
      await ensureTab();
      const left = Math.max(2000, cap - (Date.now() - start));
      const ts = await resolveToken({ recapture: needRecapture, budgetMs: left });
      if (needRecapture) { recaptured = true; needRecapture = false; }
      const ready = await waitTabReady();
      if (ready.path) { f.path = ready.path; f.sinceNavMs = ready.sinceNavMs; }
      const headers = { Authorization: `Bearer ${ts.token}`, 'Content-Type': 'application/json' };
      if (!binary) headers.Accept = 'application/json';
      f.names = Object.keys(headers);
      f.tokenLen = ts.token.length;
      f.sinceTokenMs = Date.now() - ts.at;
      const raw = await cdpEvaluate(buildExpression({ url, method, headers, bodyStr, binary }));
      if (!raw) throw new Error(`Empty response from browser for ${url.replace(API_BASE, '')}`);
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const meta = parsed.meta || {};
      if (meta.path) f.path = meta.path;
      if (typeof meta.since === 'number' && meta.since >= 0) f.sinceNavMs = meta.since;
      if (meta.rs) f.readyState = meta.rs;
      f.nav = meta.nav ? 'yes' : 'no';
      if (parsed.error) throw new Error(`Browser ${binary ? 'binary' : (method === 'POST' ? 'POST' : 'fetch')} error: ${parsed.error}`);
      if (!(parsed.status >= 400)) return parsed;
      f.status = parsed.status;
      f.code = bodyCode(parsed.body);
      if (!isHeaderMissing(parsed.status, parsed.body)) {
        forensicLine(f);
        throw toError(parsed);
      }
      failure = { error: toError(parsed), needRecapture: !recaptured };
    } catch (e) {
      if (e && e.code === 'REED_TOKEN_MISSING') {
        f.code = 'REED_TOKEN_MISSING';
        failure = { error: Object.assign(e, { attempts: attempt }), needRecapture: true };
      } else if (e && f.status == null && DESTROYED_RE.test(String(e.message))) {
        // Only an error raised before any HTTP status was read (a CDP or page error). The text of a server answer never decides a retry.
        f.code = 'REED_NAV_DURING_REQUEST';
        f.nav = 'yes';
        failure = { error: codedError(CODE_NAV_DURING_REQUEST, 'REED_NAV_DURING_REQUEST: the page was replaced while the request was in flight'), needRecapture: false };
      } else {
        if (f.tokenLen && f.status == null) { f.code = 'BROWSER_ERROR'; forensicLine(f); }
        throw Object.assign(e, { attempts: attempt });
      }
    }
    forensicLine(f);
    failure.error.attempts = attempt;
    lastFailure = failure;
    if (attempt >= REQUEST_ATTEMPTS) break;
    const wait = backoff * attempt;
    if (Date.now() - start + wait > cap) {
      log(`Retry cap of ${Math.round(cap / 1000)}s reached after attempt ${attempt}: giving up`);
      break;
    }
    needRecapture = failure.needRecapture;
    await fsx.sleep(wait);
  }
  throw lastFailure.error;
}

// ---------------------------------------------------------------- session

// Connects to the Reed tab and makes sure a usable token exists (kept for callers of the earlier API). Nothing is set in the page.
async function ensureBrowserSession() {
  await ensureTab();
  await resolveToken();
  return true;
}

// ---------------------------------------------------------------- public API

async function browserJson(url, method, bodyJson, label) {
  const parsed = await requestInPage({
    url, method, bodyStr: bodyJson, binary: false,
    toError(p) {
      if (p.status === 401 || p.status === 403) {
        const e = new Error(`REED_RELOGIN_NEEDED: HTTP ${p.status}. Re-login with: node scripts/cdp-reed-full-login.js`);
        e.status = p.status;
        return e;
      }
      const e = new Error(`Reed API ${label ? 'POST ' : ''}HTTP ${p.status}: ${(p.body || '').slice(0, 200)}`);
      e.status = p.status;
      return e;
    },
  });
  return JSON.parse(parsed.body);
}

async function reedBrowserFetch(endpoint) {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
  return browserJson(url, 'GET', null, '');
}

async function reedBrowserFetchPost(endpoint, body) {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
  return browserJson(url, 'POST', JSON.stringify(body), 'POST ');
}

// Binary fetch (CV downloads). Returns {buffer, contentType, contentDisposition}.
async function reedBrowserFetchBinary(endpoint, body) {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
  const parsed = await requestInPage({
    url, method: body ? 'POST' : 'GET', bodyStr: body ? JSON.stringify(body) : null, binary: true,
    toError(p) {
      const e = new Error(`Reed binary API HTTP ${p.status}`);
      e.status = p.status;
      return e;
    },
  });
  return {
    buffer: Buffer.from(parsed.base64, 'base64'),
    contentType: parsed.contentType,
    contentDisposition: parsed.contentDisposition,
  };
}

process.once('beforeExit', closeCdp);

module.exports = {
  reedBrowserFetch,
  reedBrowserFetchPost,
  reedBrowserFetchBinary,
  ensureBrowserSession,
  findReedTab,
  cdpEvaluate,
  closeCdp,
  invalidateToken,
  looksLikeJwt,
  API_BASE,
};
