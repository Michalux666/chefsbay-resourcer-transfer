// TEST FIXTURE: verbatim copy of the legacy helper (non-ASCII punctuation replaced) so tests can run without the KEEP package.
'use strict';
const fs = require('fs');
const { SESSION_PATH, BASE_CATERER } = require('./constants');

/**
 * Load Caterer session cookies, filtering out expired ones.
 * Returns a Cookie header string ready for HTTP requests.
 * Throws if session file is missing or has no valid cookies.
 */
function loadCookieHeader() {
  if (!fs.existsSync(SESSION_PATH)) {
    throw new Error('No Caterer session file - run caterer-login first');
  }
  const session = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
  const nowEpoch = Date.now() / 1000;

  const validCookies = (session.cookies || [])
    .filter(c => c.domain && (c.domain.includes('caterer.com') || c.domain.includes('recruiter')))
    .filter(c => !c.expires || c.expires === -1 || c.expires > nowEpoch);

  if (validCookies.length === 0) {
    throw new Error('All Caterer session cookies have expired - need fresh login');
  }

  return validCookies.map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * Check if the Caterer session has valid (non-expired) cookies.
 * Returns { valid: boolean, expiredCount: number, validCount: number }
 */
function checkSessionHealth() {
  try {
    const session = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
    const nowEpoch = Date.now() / 1000;
    const all = (session.cookies || [])
      .filter(c => c.domain && (c.domain.includes('caterer.com') || c.domain.includes('recruiter')));
    const valid = all.filter(c => !c.expires || c.expires === -1 || c.expires > nowEpoch);
    return { valid: valid.length > 0, validCount: valid.length, expiredCount: all.length - valid.length };
  } catch {
    return { valid: false, validCount: 0, expiredCount: 0 };
  }
}

/**
 * Required auth cookie names - if these are missing from the session,
 * Caterer API calls will silently 302 to login instead of returning data.
 */
const REQUIRED_AUTH_COOKIES = ['.ASPXAUTH'];

/**
 * Validate that the session file contains the required auth cookies.
 * Returns { valid, missing[], warnings[] }
 */
function validateSession() {
  const warnings = [];
  const missing = [];

  if (!fs.existsSync(SESSION_PATH)) {
    return { valid: false, missing: ['session file'], warnings: ['Session file does not exist'] };
  }

  let session;
  try {
    session = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
  } catch (err) {
    return { valid: false, missing: ['parseable session'], warnings: [`Session file corrupt: ${err.message}`] };
  }

  const nowEpoch = Date.now() / 1000;
  const allCookies = (session.cookies || [])
    .filter(c => c.domain && (c.domain.includes('caterer.com') || c.domain.includes('recruiter')));

  if (allCookies.length === 0) {
    return { valid: false, missing: ['any cookies'], warnings: ['Session file contains no Caterer cookies'] };
  }

  const validCookies = allCookies.filter(c => !c.expires || c.expires === -1 || c.expires > nowEpoch);

  for (const name of REQUIRED_AUTH_COOKIES) {
    const cookie = validCookies.find(c => c.name === name);
    if (!cookie) {
      missing.push(name);
      // Check if it exists but is expired
      const expired = allCookies.find(c => c.name === name && c.expires && c.expires !== -1 && c.expires <= nowEpoch);
      if (expired) {
        warnings.push(`${name} cookie found but EXPIRED (${new Date(expired.expires * 1000).toISOString()})`);
      } else {
        warnings.push(`${name} cookie not found in session`);
      }
    }
  }

  // Check if session is about to expire (within 30 minutes)
  const authCookie = validCookies.find(c => c.name === '.ASPXAUTH');
  if (authCookie && authCookie.expires && authCookie.expires !== -1) {
    const minsRemaining = (authCookie.expires - nowEpoch) / 60;
    if (minsRemaining < 30) {
      warnings.push(`.ASPXAUTH expires in ${Math.round(minsRemaining)} minutes - consider refreshing session`);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
    warnings,
    validCookieCount: validCookies.length,
    totalCookieCount: allCookies.length,
  };
}

module.exports = { loadCookieHeader, checkSessionHealth, validateSession, SESSION_PATH, BASE_CATERER };
