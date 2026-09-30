#!/usr/bin/env node
'use strict';

// Core module for Reed BFF API access: session file, JWT helpers, direct fetch and the browser-proxy wrappers.
// Usage as module: const { reedFetch, getToken, saveSession, loadSession } = require('./reed-api-client');
// CLI: node scripts/reed-api-client.js [--check|--daily-usage]

const fs = require('fs');
const path = require('path');
const paths = require('./lib/paths');
const env = require('./lib/env');
const fsx = require('./lib/fsx');

const SESSION_FILE = path.join(paths.STATE, 'reed-session.json');
const AUTH_MARKER = path.join(paths.RUNTIME, 'reed-auth-failed.marker');
const LOGIN_BLOCK_FILE = path.join(paths.RUNTIME, 'reed-login-block.json');
const STATUS_FILE = path.join(paths.RUNTIME, 'reed-status.json');
const ALERT_EPISODES_FILE = path.join(paths.RUNTIME, 'reed-alert-episodes.json');
const STATUS_STATES = ['ok', 'auth_failed', 'disabled'];
const CRED_FILE = path.join(paths.SECRETS, 'reed-credentials.json');
const API_BASE = env.get('REED_API_BASE') || 'https://api.reed.co.uk/api-bff-recruiter-candidates';
const AUTH0_DOMAIN = 'https://secure-recruiter.reed.co.uk';
const AUTH0_CLIENT_ID = 'IefIxjdMXLETqAFYFJWAcvM9e8Y0lu37';
const LOGIN_COMMAND = 'node scripts/cdp-reed-full-login.js';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Refresh if token expires within 5 minutes
const REFRESH_THRESHOLD_SECS = 5 * 60;

// ---------------------------------------------------------------- token helpers

function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function isTokenValid(session) {
  if (!session || !session.accessToken) return false;
  const expiry = session.expiresAt;
  if (expiry) {
    return expiry - Date.now() / 1000 > REFRESH_THRESHOLD_SECS;
  }
  const payload = decodeJwtPayload(session.accessToken);
  if (payload && payload.exp) {
    return payload.exp - Date.now() / 1000 > REFRESH_THRESHOLD_SECS;
  }
  return false;
}

function loadSession() {
  return fsx.readJson(SESSION_FILE, null);
}

function saveSession(session) {
  fsx.writeJsonAtomic(SESSION_FILE, session, 0o600);
}

// runtime/reed-status.json is {state: ok|auth_failed|disabled, updatedAt: ISO, detail: string} exactly (docs/parity/dashboard.md section 5); detail is always present.
function writeReedStatus(state, detail) {
  if (!STATUS_STATES.includes(state)) return false;
  try {
    fsx.writeJsonAtomic(STATUS_FILE, { state, updatedAt: new Date().toISOString(), detail: env.redact(detail == null ? '' : String(detail)).slice(0, 200) });
    return true;
  } catch {
    return false;
  }
}

function readReedStatus() {
  const s = fsx.readJson(STATUS_FILE, null);
  return s && typeof s === 'object' && typeof s.state === 'string' ? s : null;
}

const numEnv = (name, dflt) => {
  const n = Number(env.get(name, String(dflt)));
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

// ---------------------------------------------------------------- alerts: one per episode

function readEpisodes() {
  const j = fsx.readJson(ALERT_EPISODES_FILE, null);
  return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
}

// One alert per episode: silent until clearAlertEpisode(key), except a reminder after REED_ALERT_REMIND_HOURS (72, 0 = never) so a forgotten problem resurfaces.
function alertOnce(key, alert) {
  const eps = readEpisodes();
  const open = eps[key];
  if (open) {
    const remindH = numEnv('REED_ALERT_REMIND_HOURS', 72);
    const age = Date.now() - Date.parse(open.at);
    if (!(remindH > 0 && age >= remindH * 3600000)) return false;
  }
  try {
    fsx.writeJsonAtomic(ALERT_EPISODES_FILE, { ...eps, [key]: { at: new Date().toISOString() } });
  } catch { /* an unwritable state file must not swallow the alert */ }
  const { notify } = require('./lib/notify');
  return notify({ key, ...alert });
}

function clearAlertEpisode(...keys) {
  const eps = readEpisodes();
  let changed = false;
  for (const k of keys) if (k in eps) { delete eps[k]; changed = true; }
  if (!changed) return;
  try { fsx.writeJsonAtomic(ALERT_EPISODES_FILE, eps); } catch { /* advisory */ }
}

// ---------------------------------------------------------------- RESOURCER_SOURCES gate and the auth hold

// {raw, value, valid, reedEnabled}: anything that is not caterer|reed|both is treated as caterer.
function sourcesGate() {
  const raw = String(env.get('RESOURCER_SOURCES', 'caterer')).trim().toLowerCase();
  const valid = ['caterer', 'reed', 'both'].includes(raw);
  const value = valid ? raw : 'caterer';
  return { raw, value, valid, reedEnabled: value === 'reed' || value === 'both' };
}

// Keeps runtime/reed-status.json truthful about the gate: 'disabled' while Reed is excluded, and no stale 'disabled' once it is enabled again.
function syncGateStatus() {
  const g = sourcesGate();
  const cur = readReedStatus();
  if (!g.reedEnabled) {
    const detail = `RESOURCER_SOURCES=${g.raw}`;
    if (cur && cur.state === 'disabled' && cur.detail === detail) return { state: 'disabled', changed: false };
    writeReedStatus('disabled', detail);
    return { state: 'disabled', changed: true };
  }
  if (cur && cur.state === 'disabled') {
    fsx.safeUnlink(STATUS_FILE);
    return { state: null, changed: true };
  }
  return { state: cur ? cur.state : null, changed: false };
}

// People-needed failures hold Reed for the login-block window, other auth failures back off REED_AUTH_HOLD_MIN; a lock conflict never holds.
const HOLD_LONG_REASONS = new Set(['turnstile_blocked', 'reed_451_international']);
const HOLD_IGNORED_REASONS = new Set(['browser_lock_busy']);

// -> null (Reed may run) | {reason, detail, since?}: run-pipeline skips the Reed step on a hold, so a pending human login spends no Reed retries.
function authHold(nowMs = Date.now()) {
  try {
    const launcher = require('./ensure-chrome-cdp');
    const st = launcher.browserLock.state();
    const h = st.holder;
    if (st.held && !st.mine && !st.ancestor && h && h.owner === 'reed' && h.purpose === 'human-login') {
      return { reason: 'human_login_in_progress', detail: `a human login session holds browser.lock (pid ${h.pid})` };
    }
  } catch { /* an unreadable lock is not a hold */ }

  const blockWindowMs = numEnv('REED_LOGIN_BLOCK_HOURS', 12) * 3600000;
  const block = fsx.readJson(LOGIN_BLOCK_FILE, null);
  if (block && block.blockedAt && nowMs - Date.parse(block.blockedAt) < blockWindowMs) {
    return { reason: 'human_login_pending', detail: `a Turnstile block is recorded (${block.reason || 'unknown'})`, since: block.blockedAt };
  }

  let mtimeMs = null;
  try { mtimeMs = fs.statSync(AUTH_MARKER).mtimeMs; } catch { return null; }
  const mk = fsx.readJson(AUTH_MARKER, null) || {};
  const reason = typeof mk.reason === 'string' && mk.reason ? mk.reason : 'marker_unreadable';
  if (HOLD_IGNORED_REASONS.has(reason)) return null;
  const failedMs = Date.parse(mk.failedAt);
  const at = Number.isFinite(failedMs) ? failedMs : mtimeMs;
  const windowMs = HOLD_LONG_REASONS.has(reason) ? blockWindowMs : numEnv('REED_AUTH_HOLD_MIN', 30) * 60000;
  if (nowMs - at < windowMs) return { reason, detail: `Reed auth failed (${reason})`, since: new Date(at).toISOString() };
  return null;
}

// Reed is authenticated: close the open auth problems; only a completed login (opts.all) lifts HTTP 451, a refresh cannot fix a session created abroad.
function markAuthOk(detail, opts = {}) {
  writeReedStatus('ok', detail);
  fsx.safeUnlink(LOGIN_BLOCK_FILE);
  const mk = fsx.readJson(AUTH_MARKER, null);
  if (opts.all || !mk || mk.reason !== 'reed_451_international') fsx.safeUnlink(AUTH_MARKER);
  clearAlertEpisode('reed-human-login', 'reed-credentials');
  if (opts.all) clearAlertEpisode('reed-451');
}

// Error carrying the HTTP status so callers can branch without parsing messages.
function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------------------------------------------------------------- token refresh

// Reed issues no refresh token (all renewal is browser based); kept for API compatibility with the legacy module.
async function refreshToken() {
  const session = loadSession();
  if (!session || !session.refreshToken) {
    throw new Error(`REED_RELOGIN_NEEDED: No refresh token available - run: ${LOGIN_COMMAND}`);
  }
  const res = await fetch(`${AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', client_id: AUTH0_CLIENT_ID, refresh_token: session.refreshToken }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`REED_RELOGIN_NEEDED: Auth0 token refresh failed (HTTP ${res.status}): ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('REED_RELOGIN_NEEDED: Auth0 refresh response missing access_token');
  }
  const newSession = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || session.refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in || 1800),
    obtainedAt: new Date().toISOString(),
  };
  saveSession(newSession);
  return newSession.accessToken;
}

// Valid saved token, else capture a fresh JWT from the live logged-in tab via reed-refresh-token.js.
async function getToken() {
  const session = loadSession();
  if (session && isTokenValid(session)) return session.accessToken;
  const reason = !session || !session.accessToken ? 'no session' : 'token expired';
  try {
    const { refreshToken: browserCapture } = require('./reed-refresh-token');
    return await browserCapture();
  } catch (err) {
    throw new Error(
      `REED_RELOGIN_NEEDED: ${reason} - browser capture also failed (${err.message}). Log in again with: ${LOGIN_COMMAND}`
    );
  }
}

// ---------------------------------------------------------------- direct fetch (fallback only; Cloudflare normally blocks it)

async function directFetch(endpoint, options, timeoutMs, accept, binary) {
  const token = await getToken();
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: accept,
      Origin: 'https://www.reed.co.uk',
      Referer: 'https://www.reed.co.uk/',
      'User-Agent': USER_AGENT,
      ...(options.headers || {}),
    };
    const res = await fetch(url, { ...options, headers, signal: controller.signal });
    if (!res.ok) {
      const txt = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw httpError(`REED_RELOGIN_NEEDED: HTTP ${res.status} - token rejected. Run: ${LOGIN_COMMAND}`, res.status);
      }
      throw httpError(`Reed API${binary ? ' (binary)' : ''} HTTP ${res.status}: ${txt.slice(0, 300)}`, res.status);
    }
    if (binary) {
      return {
        buffer: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') || '',
        contentDisposition: res.headers.get('content-disposition') || '',
      };
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const reedFetchDirect = (endpoint, options = {}, timeoutMs = 30000) =>
  directFetch(endpoint, options, timeoutMs, 'application/json', false);
const reedFetchBinaryDirect = (endpoint, options = {}, timeoutMs = 60000) =>
  directFetch(endpoint, options, timeoutMs, 'application/pdf,application/octet-stream,*/*', true);

// ---------------------------------------------------------------- browser-proxy wrappers (the normal path)

let browserFetchModule = null;
function getBrowserFetch() {
  if (browserFetchModule) return browserFetchModule;
  try {
    browserFetchModule = require('./reed-browser-fetch');
    return browserFetchModule;
  } catch {
    return null;
  }
}

async function reedFetch(endpoint, options = {}, timeoutMs = 30000) {
  const bf = getBrowserFetch();
  if (bf) {
    try {
      if (options.method === 'POST') {
        return await bf.reedBrowserFetchPost(endpoint, options.body ? JSON.parse(options.body) : {});
      }
      return await bf.reedBrowserFetch(endpoint);
    } catch (err) {
      if (!err.message.includes('REED_RELOGIN_NEEDED') && !err.message.includes('HTTP 4')) {
        process.stderr.write(`[reed-api-client] Browser proxy failed, trying direct: ${err.message.slice(0, 80)}\n`);
        return reedFetchDirect(endpoint, options, timeoutMs);
      }
      throw err;
    }
  }
  return reedFetchDirect(endpoint, options, timeoutMs);
}

async function reedFetchBinary(endpoint, options = {}, timeoutMs = 60000) {
  const bf = getBrowserFetch();
  if (bf) {
    try {
      return await bf.reedBrowserFetchBinary(endpoint, options.body ? JSON.parse(options.body) : null);
    } catch (err) {
      if (!err.message.includes('REED_RELOGIN_NEEDED') && !err.message.includes('HTTP 4')) {
        return reedFetchBinaryDirect(endpoint, options, timeoutMs);
      }
      throw err;
    }
  }
  return reedFetchBinaryDirect(endpoint, options, timeoutMs);
}

// ---------------------------------------------------------------- CLI

function cliCheckToken() {
  const s = loadSession();
  if (isTokenValid(s)) {
    const expMs = s.expiresAt && s.expiresAt < 1e12 ? s.expiresAt * 1000 : s.expiresAt || 0;
    const mins = expMs ? Math.max(0, Math.round((expMs - Date.now()) / 60000)) : null;
    process.stdout.write(`TOKEN_VALID${mins !== null ? ` (${mins}m)` : ''}\n`);
    return 0;
  }
  process.stdout.write('TOKEN_EXPIRED\n');
  return 1;
}

async function cliDailyUsage() {
  try {
    const data = await reedFetch('/monetization/daily-usage/', { method: 'GET' }, 30000);
    const usage = (data && data.result) || data || {};
    const profileViews = usage.profileViews ?? usage.dailyViews ?? usage.profile_views ?? 0;
    const dailyLimit = usage.dailyLimit ?? usage.daily_limit ?? 600;
    const cvDownloads = usage.cvDownloads ?? usage.cv_downloads ?? null;
    const remaining = usage.remaining ?? Math.max(0, dailyLimit - profileViews);
    process.stdout.write(`${JSON.stringify({ profileViews, dailyLimit, cvDownloads, remaining })}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`[reed-api-client] daily-usage failed: ${err.message}\n`);
    process.stdout.write('DAILY_USAGE_UNAVAILABLE\n');
    return 1;
  }
}

const USAGE = `Usage: node scripts/reed-api-client.js [--check|--daily-usage|--sync-status|--auth-state]
  --check         token validity (TOKEN_VALID | TOKEN_EXPIRED)
  --daily-usage   Reed daily usage as JSON (DAILY_USAGE_UNAVAILABLE on failure)
  --sync-status   make runtime/reed-status.json follow RESOURCER_SOURCES ('disabled' while Reed is excluded); prints JSON
  --auth-state    print the Reed auth state (status file, failure marker, login block, hold) as JSON
Exit codes: 0 ok, 1 token expired / usage unavailable / bad usage.`;

function cliAuthState() {
  const gate = sourcesGate();
  process.stdout.write(`${JSON.stringify({
    sources: gate.value, reedEnabled: gate.reedEnabled, status: readReedStatus(),
    marker: fsx.readJson(AUTH_MARKER, null), loginBlock: fsx.readJson(LOGIN_BLOCK_FILE, null), hold: authHold(),
  })}\n`);
  return 0;
}

async function cli(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (argv.includes('--check')) return cliCheckToken();
  if (argv.includes('--daily-usage')) return cliDailyUsage();
  if (argv.includes('--sync-status')) {
    process.stdout.write(`${JSON.stringify(syncGateStatus())}\n`);
    return 0;
  }
  if (argv.includes('--auth-state')) return cliAuthState();
  process.stdout.write(`${USAGE}\n`);
  return 1;
}

if (require.main === module) {
  cli(process.argv.slice(2)).then((code) => {
    try { require('./reed-browser-fetch').closeCdp(); } catch { /* module not loaded */ }
    process.exit(code);
  });
}

module.exports = {
  reedFetch,
  reedFetchBinary,
  getToken,
  refreshToken,
  saveSession,
  loadSession,
  isTokenValid,
  decodeJwtPayload,
  httpError,
  writeReedStatus,
  readReedStatus,
  alertOnce,
  clearAlertEpisode,
  sourcesGate,
  syncGateStatus,
  authHold,
  markAuthOk,
  STATUS_FILE,
  ALERT_EPISODES_FILE,
  SESSION_FILE,
  AUTH_MARKER,
  LOGIN_BLOCK_FILE,
  CRED_FILE,
  LOGIN_COMMAND,
  API_BASE,
  AUTH0_DOMAIN,
  AUTH0_CLIENT_ID,
};
