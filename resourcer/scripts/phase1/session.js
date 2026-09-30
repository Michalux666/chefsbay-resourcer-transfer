'use strict';
const path = require('path');
const paths = require('../lib/paths');
const env = require('../lib/env');
const fsx = require('../lib/fsx');
const { runNode } = require('./proc');
const { scriptPath } = require('./config');
const { safeText, round1 } = require('./util');

// One source of truth for the saved session file: env override, then constants.js, then state/.
function sessionFile() {
  const override = env.get('CATERER_SESSION_FILE');
  if (override) return path.resolve(override);
  try {
    const c = require('../constants');
    if (c && c.SESSION_PATH) return c.SESSION_PATH;
  } catch (e) { /* constants.js not present */ }
  return path.join(paths.STATE, 'caterer-session.json');
}

// caterer-get-credits.js prints the credits as the last all-digit line; anything else means "not logged in".
async function creditsCheck(ctx, extraArgs) {
  const r = await runNode(scriptPath('caterer-get-credits'), extraArgs || [], { cwd: paths.HOME, timeoutMs: ctx.cfg.timeoutMs.credits });
  const lines = `${r.stdout}\n${r.stderr}`.split('\n').map((l) => l.trim()).filter(Boolean);
  const digits = lines.filter((l) => /^\d+$/.test(l));
  return { credits: digits.length ? digits[digits.length - 1] : null, lines };
}

function withTimeout(promise, ms, label) {
  let timer;
  const limit = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// One automatic re-login through the shared login module (never a second copy of the login logic).
async function tryLogin(ctx) {
  const { out, cfg } = ctx;
  try {
    const r = await withTimeout(Promise.resolve(ctx.getLogin().ensureLoggedIn({ allowRelogin: true })), cfg.timeoutMs.login, 'auto-login');
    if (typeof r === 'string') out(`Auto-login result: ${safeText(r, 100)}`);
    else if (r && typeof r === 'object') {
      const bits = ['state', 'status', 'ok', 'reason'].filter((k) => r[k] !== undefined).map((k) => `${k}=${safeText(r[k], 60)}`);
      if (bits.length) out(`Auto-login result: ${bits.join(' ')}`);
    }
  } catch (e) {
    out(`WARN auto-login attempt threw: ${safeText(e.message, 300)}`);
  }
}

// The device-verification page is a logged-out state too: the saved cookies do not satisfy it.
const loggedOutUrl = (u) => /\/login/i.test(u) || /SafeListLoginBlocked/i.test(u);

// Pre-validation: credits via the warm session, one auto re-login, then the browser-aware check.
// Returns {exit:2} when the session cannot be recovered, else {credits, secs}.
async function validateSession(ctx) {
  const { out } = ctx;
  out('Pre-validating Caterer session...');
  const startMs = Date.now();
  let r = await creditsCheck(ctx);
  let credits = r.credits;

  if (!credits) {
    out('SESSION_STALE detected. Attempting one automatic Caterer re-login...');
    await tryLogin(ctx);
    r = await creditsCheck(ctx);
    credits = r.credits;
  }
  if (!credits) {
    out('SESSION_STALE: Caterer session expired or invalid after retry. Re-login required.');
    out(`Raw output: ${safeText(r.lines.join(' | '), 400)}`);
    return { exit: 2 };
  }

  // The credits check can pass on a valid cookie file while the live browser is logged out (2026-06-03).
  let authUrl = await ctx.browser.getUrl('browser auth-check');
  if (loggedOutUrl(authUrl)) {
    out('SESSION_STALE: browser on /login despite valid cookies -- attempting one automatic Caterer re-login...');
    await tryLogin(ctx);
    authUrl = await ctx.browser.getUrl('browser auth-recheck');
    if (loggedOutUrl(authUrl) || !authUrl) {
      out('SESSION_STALE: still on /login after auto re-login -- re-login required.');
      return { exit: 2 };
    }
    out(`Auto re-login succeeded -- browser now on: ${safeText(authUrl, 200)}`);
    const re = await creditsCheck(ctx);
    if (re.credits) credits = re.credits;
  }

  const secs = round1((Date.now() - startMs) / 1000);
  out(`Session OK - credits: ${credits} (validated in ${secs}s)`);
  return { credits, secs };
}

// Saves the browser session only while it is authenticated: saving a logged-out state poisoned the
// session file and broke every later run (2026-06-03 unlock outage).
async function saveCatererSession(ctx, label) {
  const { out } = ctx;
  const url = await ctx.browser.getUrl(`auth-check ${label}`);
  if (/\/login/i.test(url)) {
    out(`WARN session NOT saved (${label}) -- browser on /login (logged out); keeping prior good session file`);
    return;
  }
  // The device-verification page is not a signed-in state either; saving it would poison the session file.
  if (/SafeListLoginBlocked/i.test(url)) {
    out(`WARN session NOT saved (${label}) -- browser on the device-verification page; keeping prior good session file`);
    return;
  }
  try { fsx.ensureDir(path.dirname(ctx.sessionFile), 0o700); } catch (e) { /* the save below reports the failure */ }
  const r = await ctx.browser.stateSave(ctx.sessionFile, `session state save (${label})`);
  if (r.timedOut) out(`WARN session save timed out (${label}) -- pipeline continues`);
  else if (!r.ok) out(`WARN session save failed (${label}): ${safeText(r.out, 200)} -- pipeline continues`);
  else out(`Session saved (${label})`);
}

module.exports = { validateSession, saveCatererSession, creditsCheck, sessionFile, withTimeout };
