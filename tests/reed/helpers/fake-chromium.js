#!/usr/bin/env node
'use strict';

// Stand-in for chromium, started by the launcher under the real xvfb-run. Serves the fake Reed world (CDP + API) on
// --remote-debugging-port and records how it was started. FAKE_CHROMIUM_MODE: normal | never-listen | exit-early | ignore-term |
// lock-check (exits 9 if a SingletonLock is present, like a real profile owned by a dead host), ignore-close (survives Browser.close
// but honours SIGTERM). Like real Chromium, the cookie database is only flushed on a graceful Browser.close, never on SIGTERM.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { startFakeReed } = require('./fake-reed');

const args = process.argv.slice(2);
const flag = (name) => (args.find((a) => a.startsWith(`${name}=`)) || '').slice(name.length + 1);
const port = Number(flag('--remote-debugging-port'));
const profile = flag('--user-data-dir');
const target = args.filter((a) => !a.startsWith('--')).pop() || 'about:blank';
const mode = process.env.FAKE_CHROMIUM_MODE || 'normal';

// Real Chromium rewrites its process title, so /proc/<pid>/cmdline is a single space-joined element; mimic that.
process.title = ['/usr/bin/chromium', ...args].join(' ');
fs.mkdirSync(profile, { recursive: true });
fs.appendFileSync(path.join(profile, 'launches.txt'), `${JSON.stringify({ pid: process.pid, args, display: process.env.DISPLAY || null, tmpdir: process.env.TMPDIR || null, tz: process.env.TZ || null, language: process.env.LANGUAGE || null, home: process.env.HOME || null })}\n`);

if (mode === 'exit-early') process.exit(3);
if (mode === 'no-sandbox-available') { console.error('No usable sandbox! Update your kernel or see chromium docs'); process.exit(5); }
if (mode === 'sigtrap') process.kill(process.pid, 'SIGTRAP');
if (mode === 'lock-check' && fs.existsSync(path.join(profile, 'SingletonLock'))) {
  console.error('The profile appears to be in use by another Chromium process');
  process.exit(9);
}
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
const ignoreClose = mode === 'ignore-term' || mode === 'ignore-close';
fs.writeFileSync(path.join(profile, 'SingletonLock'), String(process.pid));

const rendererTitle = `/usr/bin/chromium --type=renderer --user-data-dir=${profile}`;
const renderer = spawn(process.execPath, ['-e', `process.title = ${JSON.stringify(rendererTitle)};${mode === 'ignore-term' ? "process.on('SIGTERM', () => {});" : ''}setInterval(() => {}, 1000)`, '--', '--type=renderer', `--user-data-dir=${profile}`], { stdio: 'ignore' });
fs.writeFileSync(path.join(profile, 'renderer.pid'), String(renderer.pid));

let world = null;
function shutdown() {
  try { renderer.kill('SIGKILL'); } catch { /* gone */ }
  try { fs.unlinkSync(path.join(profile, 'SingletonLock')); } catch { /* gone */ }
  if (world) world.close().finally(() => process.exit(0)); else process.exit(0);
}
function onBrowserClose() {
  if (ignoreClose) return;
  fs.writeFileSync(path.join(profile, 'cookies-flushed.txt'), new Date().toISOString());
  setTimeout(shutdown, 50);
}
(async () => {
  if (mode !== 'never-listen') {
    world = await startFakeReed({
      cdpPort: port,
      apiPort: Number(process.env.FAKE_API_PORT || 0),
      loggedIn: process.env.FAKE_LOGGED_IN !== '0',
      initialUrl: target,
      onBrowserClose,
    });
    if (process.env.FAKE_SITE_MODE) world.site.mode = process.env.FAKE_SITE_MODE;
    // FAKE_REED_FAULT_FILE: JSON {site:{...}, api:{...}} read at every start (each Reed run starts a fresh browser), so a scenario can
    // change the fault between runs. Used by the first-page failure scenarios (wipeTokenAfterSeed, initMs, alwaysHeaderMissing ...).
    if (process.env.FAKE_REED_FAULT_FILE) {
      try {
        const fault = JSON.parse(fs.readFileSync(process.env.FAKE_REED_FAULT_FILE, 'utf8'));
        Object.assign(world.site, fault.site || {});
        Object.assign(world.api, fault.api || {});
      } catch { /* no fault file: the stock fake */ }
    }
  }
})().catch((e) => { console.error(e.message); process.exit(1); });

if (mode !== 'ignore-term') process.on('SIGTERM', shutdown);
setInterval(() => {}, 1000);
