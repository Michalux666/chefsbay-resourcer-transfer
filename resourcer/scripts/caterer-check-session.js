#!/usr/bin/env node
'use strict';
/**
 * caterer-check-session.js
 *
 * Fast HTTP-only pre-check of the saved caterer-session.json cookies: fail before a run rather than after 25
 * failed unlocks. NOTE: this uses node HTTP, which Caterer's bot manager can bounce even for a valid session
 * (2026-06-04), so "expired" here is a hint; the authority is the browser check in caterer-login.js.
 *
 * Strategy: GET a Caterer recruiter page with the session cookies, redirects not followed.
 *   - redirect to a login page or a ReturnUrl -> session EXPIRED
 *   - 200 on a protected page -> session VALID
 *
 * Output:  stdout: "valid" | "expired" | "unknown"
 * Exit:    0 = valid, 1 = expired/unknown
 *
 * Usage:   node scripts/caterer-check-session.js
 */
const fs = require('fs');
const { loadCookieHeader, checkSessionHealth, SESSION_PATH, BASE_CATERER } = require('./caterer-session-utils');
const { fetchWithCookieJarUpdate } = require('./caterer-cookie-jar');

const PROBE_URL = `${BASE_CATERER}/CandidateSearchWebMvc/CandidateSearch`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/**
 * Returns { output, exitCode, notes[] } and never exits the process (the CLI wrapper does).
 * deps: { fetchImpl, sessionPath, probeUrl } for tests.
 */
async function checkSession(deps) {
  const d = Object.assign({ fetchImpl: fetchWithCookieJarUpdate, sessionPath: SESSION_PATH, probeUrl: PROBE_URL }, deps);
  const notes = [];

  if (!fs.existsSync(d.sessionPath)) return { output: 'expired', exitCode: 1, notes };

  const health = checkSessionHealth();
  if (!health.valid) {
    notes.push(`Session invalid or expired (valid=${health.validCount}, expired=${health.expiredCount})`);
    return { output: 'expired', exitCode: 1, notes };
  }

  let cookieHeader = '';
  try {
    cookieHeader = loadCookieHeader();
  } catch (err) {
    notes.push(`Session read error: ${err.message}`);
    return { output: 'unknown', exitCode: 1, notes };
  }

  try {
    const res = await d.fetchImpl(d.probeUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { Cookie: cookieHeader, 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    }, 15000);

    if (res.status === 302 || res.status === 301) {
      const loc = res.headers.get('location') || '';
      // Caterer's real expired-session redirect goes to the site root with ?ReturnUrl=, not literally /login.
      if (loc.toLowerCase().includes('login') || /[?&]returnurl=/i.test(loc)) {
        notes.push(`Session expired - redirect to: ${loc.split('?')[0]}`);
        return { output: 'expired', exitCode: 1, notes };
      }
    }
    if (res.status === 200) return { output: 'valid', exitCode: 0, notes };

    notes.push(`Unexpected status: ${res.status}`);
    return { output: 'unknown', exitCode: 1, notes };
  } catch (err) {
    notes.push(`Network error: ${err.message}`);
    return { output: 'unknown', exitCode: 1, notes };
  }
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    const help = [
      'Usage: node scripts/caterer-check-session.js',
      'Prints valid, expired or unknown (HTTP hint only; the browser check in caterer-login.js is the authority); exit 0 when valid, 1 otherwise.',
      '',
    ].join('\n');
    return process.stdout.write(help, () => process.exit(0));
  }
  const r = await checkSession();
  for (const n of r.notes) process.stderr.write(n + '\n');
  process.stdout.write(r.output + '\n', () => process.exit(r.exitCode));
}

module.exports = { checkSession, PROBE_URL };

if (require.main === module) main();
