#!/usr/bin/env node
'use strict';
/*
 * caterer-preflight.js - daily pre-flight (run before the 06:00 window) and overnight keep-alive.
 * Port of caterer-daily-preflight.ps1 plus the keep-alive semantics of caterer-keepalive.js.
 *
 *   node scripts/caterer-preflight.js                 daily pre-flight: browser tooling, session check, sign in if needed
 *   node scripts/caterer-preflight.js --keepalive     overnight: check + persist renewed cookies; NEVER signs in
 *   node scripts/caterer-preflight.js --check-env     read-only self-check of the browser environment (no sign-in, no network);
 *                                                     add --launch to also start Chromium headless with the production TMPDIR
 *   options: --reed | --no-reed (default: Reed steps only when RESOURCER_SOURCES is reed or both), --json, --help
 *
 * Caterer runs HEADLESS (ephemeral profile, no display server), so the old "start Xvfb" step is gone. Only
 * the Reed browser needs a display and that is started by its own launcher.
 *
 * Markers on stdout (unchanged from the legacy script where they existed):
 *   CATERER_OK | CATERER_SAFELIST_BLOCKED | CATERER_LOGIN_FAILED | CATERER_MODULE_ERROR | CATERER_CHECK_ERROR |
 *   CATERER_BROWSER_MISSING | CATERER_KEPT_ALIVE | CATERER_EXPIRED | REED_OK | REED_FAILED
 *   BROWSER_STOP_IDLE (last line before the summary: node scripts/ensure-chrome-cdp.js --stop-if-idle; never changes the exit code)
 *   BROWSER_ENV_OK | BROWSER_ENV_FAIL (--check-env: PASS/WARN/FAIL/INFO lines, then one of these)
 *   CATERER_PREFLIGHT_SKIPPED | CATERER_KEEPALIVE_SKIPPED (a pipeline run is in flight and drives the same browser session)
 * Exit: 0 ok | 1 error/unknown | 2 safe-list block | 3 login failed | 4 module error | 5 Reed step failed | 64 usage
 *   (keep-alive exits 0 when the session has simply lapsed: the pre-flight heals it; 1 only if the tooling is broken)
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./lib/paths');
const env = require('./lib/env');
const fsx = require('./lib/fsx');
const { notify } = require('./lib/notify');
const browser = require('./lib/browser');
const loginLib = require('./caterer-login');

const SUMMARY_FILE = path.join(paths.RUNTIME, 'caterer-preflight.json');
const EXIT = Object.freeze({ OK: 0, ERROR: 1, SAFELIST: 2, LOGIN: 3, MODULE: 4, REED: 5, USAGE: 64 });
const STATE_EXIT = { ok: EXIT.OK, safelist: EXIT.SAFELIST, login: EXIT.LOGIN, moduleerror: EXIT.MODULE, unknown: EXIT.ERROR, error: EXIT.ERROR };

const HELP = `caterer-preflight.js - Caterer daily pre-flight and overnight keep-alive
Usage: node scripts/caterer-preflight.js [--keepalive] [--reed|--no-reed] [--json] [--help]
       node scripts/caterer-preflight.js --check-env [--launch]
Exit: 0 ok, 1 error, 2 safe-list block, 3 login failed, 4 CV Database module error, 5 Reed step failed, 64 usage
`;

function parseArgs(argv) {
  const a = { keepalive: false, reed: null, json: false, help: false, checkEnv: false, launch: false, bad: null };
  for (const x of argv) {
    if (x === '--keepalive') a.keepalive = true;
    else if (x === '--reed') a.reed = true;
    else if (x === '--no-reed') a.reed = false;
    else if (x === '--json') a.json = true;
    else if (x === '--check-env') a.checkEnv = true;
    else if (x === '--launch') a.launch = true;
    else if (x === '--help' || x === '-h') a.help = true;
    else a.bad = `unknown option ${x}`;
  }
  return a;
}

function reedEnabled(a) {
  if (a.reed !== null) return a.reed;
  const s = String(env.get('RESOURCER_SOURCES', 'caterer')).toLowerCase();
  return s === 'reed' || s === 'both';
}

const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g;
// One informative line of a child's output: a marker or error line if there is one, else the last line.
function tidy(text) {
  const lines = env.redact(String(text || '')).replace(JWT_RE, '***').split('\n').map((l) => l.trim()).filter(Boolean);
  const pick = lines.find((l) => /^(REED_|CDP_|Error|TypeError|RangeError)/.test(l));
  return (pick || lines[lines.length - 1] || '').slice(0, 200);
}

// Run one of the sibling node scripts with a hard timeout (process group killed on timeout).
function runNodeScript(file, args, timeoutMs) {
  return new Promise((resolve) => {
    if (!fs.existsSync(file)) return resolve({ code: null, out: '', missing: true, timedOut: false });
    const chunks = [];
    let done = false, child;
    const fin = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      fin({ code: null, out: Buffer.concat(chunks).toString('utf8'), timedOut: true });
    }, timeoutMs);
    try {
      child = spawn(process.execPath, [file, ...args], { cwd: paths.HOME, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    } catch (e) { return fin({ code: null, out: e.message, timedOut: false }); }
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));
    child.on('error', (e) => fin({ code: null, out: e.message, timedOut: false }));
    child.on('close', (code) => fin({ code, out: Buffer.concat(chunks).toString('utf8'), timedOut: false }));
  });
}

// The last step of every pre-flight and keep-alive: quit a Reed browser this run (or a killed one) left behind, so
// it does not sit next to the next Caterer run. The launcher skips it while any live holder owns browser.lock.
async function stopIdleBrowser(say) {
  const r = await runNodeScript(path.join(paths.SCRIPTS, 'ensure-chrome-cdp.js'), ['--stop-if-idle'], 90000);
  if (r.missing) return { ran: false, detail: 'launcher missing' };
  const detail = r.timedOut ? 'timed out' : tidy(r.out);
  say(`BROWSER_STOP_IDLE: exit ${r.timedOut ? 'timeout' : r.code}${detail ? ` - ${detail}` : ''}`);
  return { ran: true, code: r.timedOut ? null : r.code, detail };
}

async function reedSteps(say) {
  const cdp = await runNodeScript(path.join(paths.SCRIPTS, 'ensure-chrome-cdp.js'), [], 90000);
  if (cdp.missing) { say('REED_FAILED: scripts/ensure-chrome-cdp.js is not present'); return { ok: false, detail: 'launcher missing' }; }
  if (cdp.timedOut || cdp.code !== 0) { say(`REED_FAILED: browser launcher ${cdp.timedOut ? 'timed out' : 'exit ' + cdp.code}: ${tidy(cdp.out)}`); return { ok: false, detail: 'launcher failed' }; }
  const tok = await runNodeScript(path.join(paths.SCRIPTS, 'reed-refresh-token.js'), ['--force'], 150000);
  if (tok.missing) { say('REED_FAILED: scripts/reed-refresh-token.js is not present'); return { ok: false, detail: 'refresh script missing' }; }
  if (!tok.timedOut && /REED_TOKEN_REFRESHED/.test(tok.out)) { say('REED_OK: token refreshed'); return { ok: true, detail: 'refreshed' }; }
  say(`REED_FAILED: ${tok.timedOut ? 'token refresh timed out' : tidy(tok.out) || 'no output'}`);
  return { ok: false, detail: 'token refresh failed' };
}

function sessionFileConsistency() {
  try {
    const c = require('./constants');
    if (c && c.SESSION_PATH && path.resolve(c.SESSION_PATH) !== path.resolve(browser.SESSION_FILE)) return { ok: false, a: c.SESSION_PATH, b: browser.SESSION_FILE };
  } catch { /* constants not present in this checkout: nothing to compare */ }
  return { ok: true };
}

function runInFlight() {
  try {
    const b = require('./lib/tick').busyState({ home: paths.HOME });
    return b && b.busy ? b : null;
  } catch { return null; }
}

// Read-only: what the browsers need from this instance. FAIL lines make the exit code 1; WARN lines are advice.
async function checkEnv(say, launch) {
  const rows = await require('./lib/browser-env').diagnose({ launch });
  let fails = 0;
  for (const r of rows) {
    if (r.level === 'fail') fails++;
    say(`${r.level.toUpperCase()} ${r.id} ${r.text}`);
  }
  if (!launch) say('INFO launch add --launch to start Chromium headless with the production TMPDIR and flags');
  say(fails ? `BROWSER_ENV_FAIL: ${fails} check(s) failed` : 'BROWSER_ENV_OK');
  return fails ? EXIT.ERROR : EXIT.OK;
}

async function main(argv, io) {
  const w = (io && io.write) || ((t) => process.stdout.write(t));
  const say = (t) => w(t + '\n');
  const a = parseArgs(argv);
  if (a.help) { w(HELP); return EXIT.OK; }
  if (a.bad) { say(`usage error: ${a.bad}`); w(HELP); return EXIT.USAGE; }
  if (a.launch && !a.checkEnv) { say('usage error: --launch only goes with --check-env'); w(HELP); return EXIT.USAGE; }
  if (a.checkEnv) return checkEnv(say, a.launch);

  const summary = { at: new Date().toISOString(), mode: a.keepalive ? 'keepalive' : 'preflight', caterer: null, reed: null, browser: {}, exitCode: 0 };
  const finish = async (code) => {
    // keeps the dashboard's Reed indicator truthful ("disabled" while RESOURCER_SOURCES excludes Reed); advisory only
    try { await runNodeScript(path.join(paths.SCRIPTS, 'reed-api-client.js'), ['--sync-status'], 20000); } catch { /* advisory */ }
    try { summary.browserStop = await stopIdleBrowser(say); } catch (e) { summary.browserStop = { ran: false, detail: String(e && e.message).slice(0, 120) }; }
    summary.exitCode = code;
    try { fsx.writeJsonAtomic(SUMMARY_FILE, summary, 0o644); } catch { /* summary is advisory */ }
    if (a.json) say(JSON.stringify(summary));
    return code;
  };

  say(a.keepalive ? '=== Caterer keep-alive ===' : '=== Caterer daily pre-flight ===');

  // A run that started shortly before 22:00 may still be driving the same browser session at 23:00, and a late catch-up of the
  // daily pre-flight could sign in underneath it; the run looks after the session itself.
  const busy = runInFlight();
  if (busy) {
    if (a.keepalive) say(`CATERER_KEEPALIVE_SKIPPED: a pipeline run is in flight (pid ${busy.pid || '?'}); the run keeps the session alive itself`);
    else say(`CATERER_PREFLIGHT_SKIPPED: a pipeline run is in flight (pid ${busy.pid || '?'}); it drives the same browser session and signs in again itself if needed`);
    summary.caterer = { state: 'skipped', detail: 'run in flight' };
    return finish(EXIT.OK);
  }

  // 1. tooling: pinned agent-browser present and runnable
  const v = await browser.verifyVersion();
  summary.browser = { version: v.version, bin: v.source };
  if (!v.version) {
    say(`CATERER_BROWSER_MISSING: agent-browser is not runnable (${tidy(v.raw) || 'no output'}); install the pinned ${browser.PINNED_VERSION} build (docs/INSTALL.md)`);
    notify({ severity: 'critical', key: 'caterer-browser-missing', text: 'agent-browser is not runnable on the instance; Caterer sourcing cannot run. Reinstall the pinned build (docs/INSTALL.md).' });
    return finish(EXIT.ERROR);
  }
  say(`Browser: agent-browser ${v.version} (headless, no display needed)`);
  if (!v.ok) {
    say(`AB_VERSION_MISMATCH: found ${v.version}, the pipeline is pinned to ${browser.PINNED_VERSION}`);
    notify({ severity: 'warn', key: 'ab-version', text: `agent-browser is ${v.version}, the pipeline is pinned to ${browser.PINNED_VERSION}.` });
  }
  say(`Chromium: ${browser.resolveChromium() || 'auto-detect by agent-browser'}`);

  // 2. hygiene: a second backend is the signature of the 2026-08-02 split-session incident
  const be = browser.countBackends();
  summary.browser.backends = be.count;
  if (be.count > 1) {
    say(`BROWSER_BACKENDS: ${be.count} agent-browser Chrome profiles are running (expected 1) - possible split backend`);
    notify({ severity: 'warn', key: 'ab-backends', text: `${be.count} agent-browser Chrome profiles are running (expected 1). The session may be split across backends; run reset if Caterer looks logged out.` });
  }
  const cons = sessionFileConsistency();
  if (!cons.ok) {
    say('SESSION_FILE_MISMATCH: the login code and the cookie helpers use different session files');
    notify({ severity: 'critical', key: 'caterer-session-file', text: 'The Caterer session file differs between the browser wrapper and constants.js; fix constants.js SESSION_PATH.' });
  }

  // 3. session
  const r = await loginLib.ensureLoggedInDetailed({ allowRelogin: !a.keepalive });
  summary.caterer = { state: r.state, detail: r.detail, reloggedIn: !!r.reloggedIn, suppressed: r.suppressed || null };
  let code = STATE_EXIT[r.state] === undefined ? EXIT.ERROR : STATE_EXIT[r.state];

  if (a.keepalive) {
    if (r.state === 'ok') {
      const s = await browser.saveSession();
      say(`CATERER_KEPT_ALIVE: session signed in${s.saved ? ', renewed cookies saved' : ' (save skipped)'}`);
      code = EXIT.OK;
    } else if (r.state === 'error' || r.state === 'unknown') {
      say(`CATERER_CHECK_ERROR: ${r.state} ${r.detail}`);
      code = EXIT.ERROR;
    } else {
      say(`CATERER_EXPIRED: ${r.state}${r.detail ? ' (' + r.detail + ')' : ''}; the 05:50 pre-flight signs in again`);
      code = EXIT.OK;
    }
    return finish(code);
  }

  if (r.state === 'ok') say(r.reloggedIn ? 'CATERER_OK: fresh login succeeded.' : 'CATERER_OK: session already valid, no login needed.');
  else if (r.state === 'safelist') say('CATERER_SAFELIST_BLOCKED: needs the newest verification link from the Caterer login mailbox: node scripts/caterer-login.js --open-link "<link>"');
  else if (r.state === 'login') say(`CATERER_LOGIN_FAILED: ${r.marker || 'not signed in'}${r.detail ? ' (' + r.detail + ')' : ''} - form fill/submit or credentials need investigation.`);
  else if (r.state === 'moduleerror') say(`CATERER_MODULE_ERROR: ${r.detail}. The session is fine; re-login will not help.`);
  else say(`CATERER_CHECK_ERROR: ${r.state}${r.detail ? ' (' + r.detail + ')' : ''}`);
  if (r.state === 'error' || r.state === 'unknown') {
    notify({ severity: 'warn', key: 'caterer-preflight', text: `Caterer pre-flight could not confirm the session (${r.state}: ${r.detail}).` });
  }

  // 4. Reed (optional; the browser launcher and token refresh belong to the Reed scripts)
  if (reedEnabled(a)) {
    const rs = await reedSteps(say);
    summary.reed = rs;
    if (!rs.ok) {
      notify({ severity: 'warn', key: 'reed-preflight', text: `Reed pre-flight failed: ${rs.detail}.` });
      if (code === EXIT.OK) code = EXIT.REED;
    }
  }

  say('=== Pre-flight complete ===');
  return finish(code);
}

module.exports = { main, parseArgs, reedEnabled, EXIT, SUMMARY_FILE };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.stdout.write('', () => process.exit(code)); },
    (e) => { process.stderr.write(`caterer-preflight crashed: ${e && e.message}\n`, () => process.exit(EXIT.ERROR)); },
  );
}
