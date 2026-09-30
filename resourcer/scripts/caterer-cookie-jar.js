'use strict';
/**
 * caterer-cookie-jar.js
 *
 * Root-cause fix for the daily Caterer session reset (2026-07-01, verified empirically): recruiter.caterer.com
 * silently re-issues (Set-Cookie) the ASP.NET auth-cookie family - AuthCookie, AuthCookieRoles,
 * AuthCookieCompany, RecruiterAuthCookie - on ORDINARY authenticated GET requests (sliding expiration). Every
 * script that loaded a static cookie snapshot from caterer-session.json threw those renewals away, so the
 * server-side expiry clock ran down unrenewed until the session lapsed overnight.
 *
 * This module wraps fetch: use it wherever loadCookieHeader() + fetchWithTimeout() are used and it keeps
 * caterer-session.json fresh for free. PhRecruiterAuthCookie (the 24 h JWT from the sister site) is not
 * needed for search access and is left alone.
 *
 * The session file has the same JSON shape the browser wrapper's `state save` writes ({cookies, origins}),
 * so both writers can share it. Writes here are atomic (temp file + rename, mode 600).
 */
const fs = require('fs');
const fsx = require('./lib/fsx');
const { SESSION_PATH } = require('./constants');
const { fetchWithTimeout } = require('./fetch-with-timeout');

const AUTH_COOKIE_NAMES = new Set([
  'AuthCookie', 'AuthCookieRoles', 'AuthCookieCompany', 'RecruiterAuthCookie',
]);

/**
 * Parse a single raw Set-Cookie header string into a cookie object of the shape used in caterer-session.json.
 */
function parseSetCookie(raw, defaultDomain) {
  const parts = raw.split(';').map((p) => p.trim());
  const [nameValue, ...attrs] = parts;
  const eq = nameValue.indexOf('=');
  if (eq === -1) return null;
  const name = nameValue.slice(0, eq);
  const value = nameValue.slice(eq + 1);

  const cookie = {
    name, value,
    domain: defaultDomain,
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: false,
    session: true,
  };

  for (const attr of attrs) {
    const [k, v] = attr.split('=').map((s) => s && s.trim());
    const key = (k || '').toLowerCase();
    if (key === 'domain' && v) cookie.domain = v.startsWith('.') ? v : `.${v}`;
    else if (key === 'path' && v) cookie.path = v;
    else if (key === 'expires' && v) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) { cookie.expires = t / 1000; cookie.session = false; }
    } else if (key === 'max-age' && v) {
      const secs = parseInt(v, 10);
      if (!Number.isNaN(secs)) { cookie.expires = (Date.now() / 1000) + secs; cookie.session = false; }
    } else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure') cookie.secure = true;
  }
  return cookie;
}

/**
 * A Set-Cookie for one of the auth-cookie names can mean either "renewed" (sliding expiration) or "cleared"
 * (logout / session kill: ASP.NET clears a cookie by re-issuing it with an empty value and/or an expiry in the
 * past, e.g. 1970-01-01). Treating a clear-cookie as a renewal is exactly how one transient blip (a redirect to
 * /login, a WAF challenge page, a 401) would permanently poison the saved session with a dead cookie (fixed
 * 2026-07-04). Never merge one of these.
 */
function isClearCookie(cookie) {
  if (!cookie.value) return true;
  if (cookie.expires !== -1 && cookie.expires <= Date.now() / 1000) return true;
  return false;
}

/**
 * Merge freshly-observed cookies into the on-disk session file. Only touches cookies whose name matches
 * something already in the file (known auth/tracking cookies), so unrelated ad-tech Set-Cookie noise never
 * pollutes the session. Skips anything that looks like a clear-cookie directive (see isClearCookie).
 */
function mergeCookiesIntoSession(freshCookies, sessionPath) {
  const file = sessionPath || SESSION_PATH;
  const renewals = freshCookies.filter((c) => !isClearCookie(c));
  if (!renewals.length) return { updated: 0 };
  const session = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byName = new Map(session.cookies.map((c) => [c.name, c]));
  let updated = 0;
  for (const fresh of renewals) {
    if (byName.has(fresh.name)) {
      Object.assign(byName.get(fresh.name), fresh);
      updated++;
    } else if (AUTH_COOKIE_NAMES.has(fresh.name)) {
      session.cookies.push(fresh);
      updated++;
    }
  }
  if (updated > 0) fsx.writeJsonAtomic(file, session, 0o600);
  return { updated };
}

/**
 * Drop-in replacement for fetchWithTimeout() that ALSO captures and persists any renewed auth cookies the
 * server hands back. Same signature/return value as fetchWithTimeout.
 */
async function fetchWithCookieJarUpdate(url, opts = {}, timeoutMs = 30000) {
  const res = await fetchWithTimeout(url, opts, timeoutMs);

  try {
    // Only trust Set-Cookie as a real renewal on a genuine, non-redirected 200 for the request we made. A
    // redirected (e.g. bounced to /login) or non-OK response is exactly where the site is most likely
    // clearing the auth cookies, not renewing them.
    if (res.ok && !res.redirected) {
      const rawSetCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      if (rawSetCookies.length) {
        const domain = new URL(url).hostname;
        const parsed = rawSetCookies.map((raw) => parseSetCookie(raw, `.${domain.replace(/^recruiter\./, '')}`)).filter(Boolean);
        const authRenewals = parsed.filter((c) => AUTH_COOKIE_NAMES.has(c.name));
        if (authRenewals.length) mergeCookiesIntoSession(authRenewals);
      }
    }
  } catch (err) {
    // Never let cookie-jar bookkeeping break the actual request the caller cares about.
    process.stderr.write(`[caterer-cookie-jar] non-fatal: failed to persist renewed cookies: ${err.message}\n`);
  }

  return res;
}

module.exports = { fetchWithCookieJarUpdate, mergeCookiesIntoSession, parseSetCookie, isClearCookie, AUTH_COOKIE_NAMES, SESSION_PATH };
