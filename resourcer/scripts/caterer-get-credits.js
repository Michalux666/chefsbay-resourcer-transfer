#!/usr/bin/env node
'use strict';
/**
 * caterer-get-credits.js
 *
 * Reads the current credits remaining from Caterer.com through the LIVE (warm) agent-browser session.
 *
 * Strategy (the only one that survives Caterer's bot manager, 2026-06-04): navigate the warm browser to the
 * search page and read the server-rendered credits widget (.litCandidatesViewed) from the DOM. There is NO
 * `state load` here and no node HTTP path: both are bounced to /login and a `state load` on a warm session
 * logs it out. On any failure the script signals "session stale" (exit 2) and the caller re-logs in.
 *
 * Usage:   node scripts/caterer-get-credits.js [--update-db] [--quiet]
 * Output:  stdout: integer credits (e.g. "62185"), or "unknown" on failure
 * Exit:    0 credits read | 2 could not read (stale session; stderr says why, and names a Caterer-side
 *          CV Database module failure explicitly so it is not mistaken for a logout)
 * Writes:  credits-sync.json (authoritative snapshot the dashboard reads); with --update-db also
 *          territory_searches.credits_remaining on the latest row.
 */
const paths = require('./lib/paths');
const env = require('./lib/env');
const fsx = require('./lib/fsx');
const browser = require('./lib/browser');

const { SITE } = browser;
const SYNC_PATH = paths.p('credits-sync.json');

// Answer is the digits, LOGIN (password field on the page) or unknown. Written as a real function string so
// it can be unit tested against a fake DOM.
const CREDITS_JS = String.raw`(function(){var e=document.querySelector('.litCandidatesViewed');if(e&&/\d/.test(e.textContent))return e.textContent.replace(/[^0-9]/g,'');if(document.querySelector('[name=password]'))return 'LOGIN';var t=document.body?document.body.innerText:'';var m=t.match(/Credits\s+Remaining[\s\S]{0,30}?([\d,]{4,7})/i);return m?m[1].replace(/,/g,''):'unknown';})()`;

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const sleepScale = () => { const v = Number(env.get('RESOURCER_SLEEP_SCALE')); return Number.isFinite(v) && v >= 0 ? v : 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.round(ms * sleepScale())));

/** Parse the eval output: strip colour codes and quotes, keep the LAST line that is only digits. */
function parseCreditsAnswer(raw) {
  const cleaned = String(raw || '').replace(ANSI, '').replace(/"/g, '').trim();
  if (/LOGIN/.test(cleaned)) return { login: true, credits: null, cleaned };
  const numLines = cleaned.split('\n').map((l) => l.trim()).filter((l) => /^\d+$/.test(l));
  const val = numLines[numLines.length - 1];
  const n = val ? parseInt(val, 10) : NaN;
  if (Number.isFinite(n) && n > 0 && n <= 200000) return { credits: n, cleaned };
  return { credits: null, cleaned };
}

async function readDomOnce() {
  const r = await browser.evalJs(CREDITS_JS, { timeoutMs: 25000, label: 'credits eval' });
  if (!r.ok) return { credits: null, failed: `eval failed: ${String(r.out).split('\n')[0]}` };
  return parseCreditsAnswer(r.stdout);
}

async function fetchCreditsViaWarmDom() {
  try {
    const o = await browser.open(SITE.SEARCH_URL, { timeoutMs: 40000 });
    if (!o.ok) {
      if (/ERR_TOO_MANY_REDIRECTS/i.test(o.out)) {
        return { credits: null, moduleError: true, reason: 'CVDB_MODULE_ERROR: the CV Database search page fails (redirect loop) - a Caterer-side module problem, not a logout; re-login will not help' };
      }
      return { credits: null, reason: 'warm-dom error: ' + String(o.out).split('\n')[0] };
    }
    // networkidle can stall on ads/polling; the DOM read below is authoritative
    await browser.waitNetworkIdle({ timeoutMs: 40000 });
    let a = await readDomOnce();
    if (!Number.isFinite(a.credits)) {
      // Right after a re-login the page can still be settling: read once more before condemning the session.
      await sleep(5000);
      a = await readDomOnce();
    }
    if (Number.isFinite(a.credits)) return { credits: a.credits };
    if (a.failed) return { credits: null, reason: 'warm-dom error: ' + a.failed };
    if (a.login) return { credits: null, reason: 'warm browser on login page - session logged out (run caterer-login)' };
    const u = await browser.getUrl({ timeoutMs: 15000 });
    if (browser.isModuleErrorUrl(u)) return { credits: null, moduleError: true, reason: 'CVDB_MODULE_ERROR: the search page landed on the error page' };
    return { credits: null, reason: `credits not found in warm DOM (got: ${a.cleaned.slice(0, 60)})` };
  } catch (e) {
    return { credits: null, reason: 'warm-dom error: ' + e.message };
  }
}

function updateCreditsInDb(credits, Database) {
  const D = Database || require('better-sqlite3');
  const db = new D(paths.DB);
  try {
    try { db.pragma('busy_timeout = 5000'); } catch { /* older driver */ }
    const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='territory_searches'").get();
    if (tbl) db.prepare('UPDATE territory_searches SET credits_remaining = ? WHERE id = (SELECT MAX(id) FROM territory_searches)').run(credits);
  } finally {
    db.close();
  }
}

function done(code, text) {
  process.stdout.write(text, () => process.exit(code));
}

async function main(argv) {
  const args = argv || process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    return done(0, 'Usage: node scripts/caterer-get-credits.js [--update-db] [--quiet]\nPrints the credits remaining (integer) and exits 0; prints "unknown" and exits 2 when it cannot read them.\n');
  }
  const updateDb = args.includes('--update-db');
  const quiet = args.includes('--quiet');
  const log = quiet ? () => {} : (msg) => process.stderr.write(msg + '\n');

  log('[credits] reading credits via warm caterer browser session (DOM)...');
  const warm = await fetchCreditsViaWarmDom();
  if (warm.credits !== null) {
    log(`[credits] Credits remaining: ${warm.credits} (via warm DOM)`);
    fsx.writeJsonAtomic(SYNC_PATH, { credits: warm.credits, syncedAt: new Date().toISOString(), source: 'warm-dom' });
    if (updateDb) {
      try { updateCreditsInDb(warm.credits); } catch (e) { log(`[credits] DB update skipped: ${e.message}`); }
    }
    return done(0, `${warm.credits}\n`);
  }
  log(`[credits] warm-DOM path failed: ${warm.reason} - signalling session-stale (exit 2) for re-login`);
  return done(2, 'unknown\n');
}

module.exports = { CREDITS_JS, parseCreditsAnswer, fetchCreditsViaWarmDom, updateCreditsInDb, main, SYNC_PATH };

if (require.main === module) {
  main().catch((e) => { process.stderr.write(`[credits] fatal: ${e && e.message}\n`, () => process.exit(2)); });
}
