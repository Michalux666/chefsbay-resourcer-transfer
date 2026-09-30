#!/usr/bin/env node
/**
 * caterer-keepalive.js
 *
 * Bridges the ~8h overnight gap (22:00-06:00, watchdog operating window) during
 * which NO Caterer requests happen at all, so the server never gets a chance to
 * silently renew the ASP.NET auth-cookie family (see caterer-cookie-jar.js for
 * why that renewal matters). A single authenticated GET, run 2-3x overnight via
 * cron, is enough to keep the session's sliding-renewal clock from lapsing.
 *
 * Safe to run at any time: read-only GET, same request caterer-check-session.js
 * already makes constantly during the day.
 *
 * Usage: node scripts/caterer-keepalive.js
 * Output: "kept-alive" (200, cookies possibly renewed) | "expired" (needs re-login) | "unknown" | "error"
 * Exit:   0 kept-alive, 1 anything else
 */
'use strict';

const { checkSessionHealth, loadCookieHeader, BASE_CATERER } = require('./caterer-session-utils');

const PROBE_URL = `${BASE_CATERER}/CandidateSearchWebMvc/CandidateSearch`;

// The cookie-jar helper is only needed for the network step, so it is loaded lazily.
function defaultFetch() {
  return require('./caterer-cookie-jar').fetchWithCookieJarUpdate;
}

/**
 * Runs the keep-alive probe. Returns { out, err, code } instead of exiting so it can be tested.
 * @param {{ fetchImpl?: Function }} [deps]
 */
async function run(deps = {}) {
  const health = checkSessionHealth();
  if (!health.valid) {
    return { out: 'expired\n', err: '', code: 1 };
  }

  let cookieHeader;
  try {
    cookieHeader = loadCookieHeader();
  } catch (err) {
    return { out: 'error\n', err: `${err.message}\n`, code: 1 };
  }

  try {
    const fetchImpl = deps.fetchImpl || defaultFetch();
    const res = await fetchImpl(PROBE_URL, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Cookie: cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    }, 15000);

    if (res.status === 200) {
      return { out: 'kept-alive\n', err: '', code: 0 };
    }
    // A valid session always gets 200 directly on this URL (confirmed empirically,
    // repeatedly). ANY redirect away from it means we're not authenticated -- Caterer's
    // actual expired-session redirect goes to the site root ("/?ReturnUrl=..."), NOT
    // literally "/login", so don't gate this on the location containing "login".
    if (res.status === 302 || res.status === 301) {
      return { out: 'expired\n', err: '', code: 1 };
    }
    return { out: 'unknown\n', err: '', code: 1 };
  } catch (err) {
    return { out: 'error\n', err: `Network error: ${err.message}\n`, code: 1 };
  }
}

if (require.main === module) {
  if (process.argv[2] === '--help' || process.argv[2] === '-h') {
    console.log('Usage: node scripts/caterer-keepalive.js\nPrints kept-alive (exit 0) | expired | unknown | error (exit 1).');
    process.exit(0);
  }
  // Exit explicitly (as before): the HTTP client may keep an idle socket alive.
  run().then(r => {
    if (r.err) process.stderr.write(r.err);
    process.stdout.write(r.out, () => process.exit(r.code));
  });
}

module.exports = { run, PROBE_URL };
