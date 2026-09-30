#!/usr/bin/env node
'use strict';

// Reed JWT refresh over Chrome DevTools Protocol against the persistent Reed browser (CDP on 127.0.0.1).
//
// The token is captured from Network.requestWillBeSent / requestWillBeSentExtraInfo / responseReceived (Chrome 153 has no
// request interception). The navigation to the search page is REQUIRED: api.reed.co.uk answers 401 unless the live tab sits on
// the candidate-search page, so the tab is deliberately left there.
//
// CLI: node scripts/reed-refresh-token.js [--force]
// Stdout markers: TOKEN_VALID | REED_TOKEN_REFRESHED | REED_RELOGIN_NEEDED. Exit 0 ok, 1 failed.

const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const WebSocket = require('ws');
const paths = require('./lib/paths');
const env = require('./lib/env');
const fsx = require('./lib/fsx');
const launcher = require('./ensure-chrome-cdp');
const { markAuthOk, authHold } = require('./reed-api-client');

const SESSION_FILE = path.join(paths.STATE, 'reed-session.json');
const REED_SEARCH_URL = env.get('REED_TARGET_URL') || 'https://www.reed.co.uk/recruiter/v2/candidates/search/results';
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

const numEnv = (name, dflt) => {
  const n = Number(env.get(name, String(dflt)));
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const CAPTURE_TIMEOUT_MS = () => numEnv('REED_CAPTURE_TIMEOUT_MS', 45000);
const COMMAND_TIMEOUT_MS = () => numEnv('REED_CDP_COMMAND_TIMEOUT_MS', 30000);
const LAUNCH_TIMEOUT_MS = () => numEnv('REED_LAUNCH_TIMEOUT_MS', 60000);

function log(msg) { process.stderr.write(`[reed-refresh] ${msg}\n`); }

// ---------------------------------------------------------------- JWT / session helpers

function decodeJwtExpiry(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return payload.exp || null;
  } catch {
    return null;
  }
}

function expiresAtMs(expiresAt) {
  if (!expiresAt) return 0;
  return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
}

function isTokenValid(session, thresholdMs = REFRESH_THRESHOLD_MS) {
  if (!session || !session.accessToken || session.accessToken.length < 50) return false;
  const expMs = expiresAtMs(session.expiresAt);
  if (!expMs) {
    const exp = decodeJwtExpiry(session.accessToken);
    if (!exp) return false;
    return exp * 1000 - Date.now() > thresholdMs;
  }
  return expMs - Date.now() > thresholdMs;
}

function loadSession() {
  return fsx.readJson(SESSION_FILE, null);
}

function saveSession(accessToken, expiresAtSecs) {
  fsx.writeJsonAtomic(SESSION_FILE, {
    accessToken,
    refreshToken: null,
    expiresAt: expiresAtSecs,
    obtainedAt: new Date().toISOString(),
  }, 0o600);
  log(`Token saved - expires ${new Date(expiresAtSecs * 1000).toISOString()}`);
}

// ---------------------------------------------------------------- CDP plumbing

function cdpBase() {
  const c = launcher.config();
  return `http://${c.host}:${c.port}`;
}

function cdpHttpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('CDP HTTP timeout')); });
  });
}

async function getCdpTabs() {
  return (await cdpHttpGet(`${cdpBase()}/json`)) || [];
}

// Deterministic tab choice shared by the refresh and the API proxy so both work on the same tab: a tab already on the candidate
// search page first (api.reed.co.uk answers 401 anywhere else), then any recruiter tab, then any reed.co.uk page.
function pickReedTab(tabs, opts = {}) {
  const pages = (tabs || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const url = (t) => String(t.url || '');
  return pages.find((t) => url(t).includes('reed.co.uk/recruiter/') && url(t).includes('candidates/search'))
    || pages.find((t) => url(t).includes('reed.co.uk/recruiter'))
    || pages.find((t) => url(t).includes('reed.co.uk'))
    || (opts.anyPage ? (pages[0] || (tabs || [])[0] || null) : null);
}

async function findReedTab() {
  return pickReedTab(await getCdpTabs(), { anyPage: true });
}

// Minimal CDP client. Command errors and timeouts reject; error text never includes command params (they may carry secrets).
class CdpConn {
  constructor(wsUrl, opts = {}) {
    this.wsUrl = wsUrl;
    this.commandTimeoutMs = opts.commandTimeoutMs || COMMAND_TIMEOUT_MS();
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ws = null;
    this.closed = false;
  }

  open(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        try { ws.terminate(); } catch { /* ignore */ }
        reject(new Error('CDP WebSocket connection timeout'));
      }, timeoutMs);
      ws.on('open', () => { clearTimeout(timer); resolve(); });
      ws.on('error', (e) => { clearTimeout(timer); this.fail(e); reject(e); });
      ws.on('close', () => { this.closed = true; this.fail(new Error('CDP closed')); });
      ws.on('message', (data) => this.onMessage(data));
    });
  }

  onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`CDP error (${p.method}): ${msg.error.message}`));
      else p.resolve(msg.result || {});
      return;
    }
    for (const l of this.listeners) {
      try { l(msg); } catch { /* listener bugs must not kill the socket */ }
    }
  }

  fail(err) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
    for (const l of this.listeners) {
      try { l({ method: '__closed', error: err }); } catch { /* ignore */ }
    }
  }

  send(method, params = {}, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) { reject(new Error(`CDP not connected (${method})`)); return; }
      const id = ++this.id;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`));
      }, timeoutMs || this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  onEvent(fn) { this.listeners.push(fn); }

  close() {
    this.closed = true;
    const ws = this.ws;
    if (!ws) return;
    setTimeout(() => { try { ws.close(); } catch { /* ignore */ } }, 100).unref();
  }
}

// ---------------------------------------------------------------- bearer capture (no request interception)

const headerValue = (headers, name) => {
  if (!headers || typeof headers !== 'object') return '';
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name) return String(headers[k] || '');
  return '';
};

function bearerFrom(headers, url) {
  const auth = headerValue(headers, 'authorization');
  if (!/^Bearer /i.test(auth) || !String(url || '').includes('api.reed.co.uk')) return null;
  const token = auth.slice(7).trim();
  return token.length >= 50 ? token : null;
}

// Stateful: ExtraInfo events carry headers but no URL, so URLs are remembered per requestId.
function createBearerCapture() {
  const urls = new Map();
  return {
    feed(msg) {
      const m = msg && msg.method;
      const p = (msg && msg.params) || {};
      if (m === 'Network.requestWillBeSent') {
        const req = p.request || {};
        if (p.requestId) urls.set(p.requestId, req.url || '');
        return bearerFrom(req.headers, req.url);
      }
      if (m === 'Network.requestWillBeSentExtraInfo') {
        return bearerFrom(p.headers, urls.get(p.requestId));
      }
      if (m === 'Network.responseReceived') {
        const r = p.response || {};
        return bearerFrom(r.requestHeaders, r.url);
      }
      return null;
    },
  };
}

// Registers on an already-open connection. Resolves with the first Bearer token seen on api.reed.co.uk.
function waitForBearer(conn, timeoutMs) {
  const capture = createBearerCapture();
  let settle;
  const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  let done = false;
  const finish = (err, token) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (err) settle.reject(err); else settle.resolve(token);
  };
  const timer = setTimeout(() => finish(new Error(`Token capture timeout after ${timeoutMs}ms`)), timeoutMs);
  conn.onEvent((msg) => {
    if (msg.method === '__closed') { finish(new Error('CDP closed without token')); return; }
    const token = capture.feed(msg);
    if (token) finish(null, token);
  });
  return { promise, fail: (e) => finish(e) };
}

// opts.timeoutMs (optional) lowers the capture wait below REED_CAPTURE_TIMEOUT_MS so a caller with a time budget stays inside it.
async function captureTokenViaCdp(wsUrl, opts = {}) {
  const conn = new CdpConn(wsUrl);
  let cap = null;
  try {
    await conn.open();
    log('CDP connected - enabling Network...');
    const waitMs = opts.timeoutMs > 0 ? Math.min(CAPTURE_TIMEOUT_MS(), opts.timeoutMs) : CAPTURE_TIMEOUT_MS();
    cap = waitForBearer(conn, waitMs);
    cap.promise.catch(() => {});
    await conn.send('Network.enable');
    log('Navigating to trigger Auth0 token...');
    conn.send('Page.navigate', { url: REED_SEARCH_URL }, 60000)
      .then((r) => { if (r && r.errorText) cap.fail(new Error(`navigation failed: ${r.errorText}`)); })
      .catch(() => {});
    const token = await cap.promise;
    log('Token captured from api.reed.co.uk request');
    return token;
  } finally {
    if (cap) cap.fail(new Error('capture ended'));
    conn.close();
  }
}

// ---------------------------------------------------------------- flows

async function refreshToken(opts = {}) {
  const tab = await findReedTab();
  if (!tab || !tab.webSocketDebuggerUrl) throw new Error('No Chromium tab found. Run: node scripts/ensure-chrome-cdp.js --ensure-reed-tab');
  log(`Using tab: ${String(tab.url || '').split('?')[0]}`);
  const token = await captureTokenViaCdp(tab.webSocketDebuggerUrl, opts);
  const expSecs = decodeJwtExpiry(token) || Math.floor(Date.now() / 1000) + 1800;
  saveSession(token, expSecs);
  return token;
}

// Any reed.co.uk page counts: a logged-out tab sits on secure-recruiter.reed.co.uk and the navigation below sorts out the session.
const hasReedTab = (tabs) => Array.isArray(tabs) && tabs.some((t) => t.type === 'page' && String(t.url || '').includes('reed.co.uk'));

function runLauncher(args) {
  return new Promise((resolve, reject) => {
    execFile(paths.NODE, [path.join(__dirname, 'ensure-chrome-cdp.js'), ...args], { timeout: LAUNCH_TIMEOUT_MS(), encoding: 'utf8' },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr })));
  });
}

async function ensureChromeCdp() {
  let tabs = null;
  try { tabs = await getCdpTabs(); } catch { tabs = null; }
  if (hasReedTab(tabs)) return true;
  log('CDP not ready or no Reed tab - launching Chromium...');
  try {
    const { stdout } = await runLauncher(['--ensure-reed-tab']);
    log(`Chromium startup: ${stdout.trim().split('\n').pop()}`);
  } catch (err) {
    log(`Chromium startup failed: ${String((err.stdout || err.message || '')).trim().split('\n').pop()}`);
    return false;
  }
  try { return hasReedTab(await getCdpTabs()); } catch { return false; }
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Usage: node scripts/reed-refresh-token.js [--force]\nStdout: TOKEN_VALID | REED_TOKEN_REFRESHED | REED_RELOGIN_NEEDED. Exit 0 ok, 1 failed.\n');
    return 0;
  }
  const force = argv.includes('--force');
  const session = loadSession();
  if (!force && isTokenValid(session)) {
    log(`Token still valid (${Math.round((expiresAtMs(session.expiresAt) - Date.now()) / 60000)}min remaining) - skipping refresh`);
    process.stdout.write('TOKEN_VALID\n');
    return 0;
  }
  const hold = authHold();
  if (hold && hold.reason === 'human_login_in_progress') {
    log(`Not touching the browser: ${hold.detail}. Finish the login first.`);
    process.stdout.write('REED_RELOGIN_NEEDED\n');
    return 1;
  }
  if (!(await ensureChromeCdp())) {
    log('FAILED: Chromium CDP not available or no Reed tab.');
    process.stdout.write('REED_RELOGIN_NEEDED\n');
    return 1;
  }
  log('Refreshing Reed JWT via Chromium CDP...');
  try {
    await refreshToken();
    markAuthOk('token refreshed');
    process.stdout.write('REED_TOKEN_REFRESHED\n');
    return 0;
  } catch (err) {
    log(`FAILED: ${err.message}`);
    process.stdout.write('REED_RELOGIN_NEEDED\n');
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    log(`FAILED: ${err.message}`);
    process.stdout.write('REED_RELOGIN_NEEDED\n');
    process.exit(1);
  });
}

module.exports = {
  refreshToken, isTokenValid, loadSession, saveSession, expiresAtMs, decodeJwtExpiry,
  captureTokenViaCdp, waitForBearer, createBearerCapture, CdpConn, findReedTab, pickReedTab, getCdpTabs, ensureChromeCdp, SESSION_FILE,
};
