#!/usr/bin/env node
'use strict';
/*
 * FAKE agent-browser 0.21.0 CLI for tests. Usable by any package's tests:
 *
 *   RESOURCER_AB_BIN=<this file>          (browser.js runs *.js bins through node, so this works on
 *                                          Windows and Linux without an exec bit)
 *   FAKE_AB_DIR=<dir>                     scenario.json (input), browser.json (fake browser state),
 *                                         calls.jsonl (one line per invocation)
 *   FAKE_AB_READ_TIMEOUT_MS=<ms>          emulates the real CLI's IPC read timeout + re-send
 *                                         behaviour (real value 30000; see docs/parity/browser-caterer.md)
 *
 * It models one persistent "daemon" (state survives across invocations like the real one) that starts
 * cold (about:blank, no cookies) and is stopped by `close`. The Caterer site is simulated by ./site.js:
 * login (React-controlled form), safe-list block, expired-session redirects, CV DB module error,
 * DNS failure, in-page fetch fixtures for unlock and CV download.
 *
 * scenario.json keys (all optional): version, readTimeoutMs, coldStartDelayMs, site{...}, rules[].
 *   rules: [{when:{cmd, argIncludes, scriptIncludes, nth}, do:{stdout, stderr, code, delayMs, hangMs,
 *            spawnChild, spawnGrandchildMs}}]  first matching rule wins; `nth` counts matches (1-based).
 * This file must never contain real credentials: every value in the fixtures is synthetic.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const site = require('./site');

const DIR = process.env.FAKE_AB_DIR || path.join(os.tmpdir(), 'fake-ab-default');
try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* ignore */ }
const F_SCN = path.join(DIR, 'scenario.json');
const F_BRW = path.join(DIR, 'browser.json');
const F_CALLS = path.join(DIR, 'calls.jsonl');

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const scn = readJson(F_SCN, {});
const siteCfg = Object.assign({ credentials: { username: 'fake.user@example.invalid', password: 'fake-pass-123' }, login: { mode: 'success' }, expiredRedirect: 'root', cookieBanner: true, credits: 44463, validToken: 'tok-newest' }, scn.site || {});
let state = readJson(F_BRW, null) || { alive: false, url: 'about:blank', page: 'blank', loggedIn: false, hasFingerprint: false, bannerDismissed: false, counters: {}, ruleHits: {} };
state.counters = state.counters || {};
state.ruleHits = state.ruleHits || {};
const saveState = () => { try { fs.writeFileSync(F_BRW, JSON.stringify(state)); } catch { /* ignore */ } };
const log = (o) => { try { fs.appendFileSync(F_CALLS, JSON.stringify(Object.assign({ t: Date.now(), pid: process.pid }, o)) + '\n'); } catch { /* ignore */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function emit(stream, text) { return new Promise((res) => stream.write(text, res)); }
async function finish(code, stdout, stderr) {
  if (stdout) await emit(process.stdout, stdout.endsWith('\n') ? stdout : stdout + '\n');
  if (stderr) await emit(process.stderr, stderr.endsWith('\n') ? stderr : stderr + '\n');
  process.exit(code);
}

function seenEnv() {
  const e = process.env;
  return {
    socketDir: e.AGENT_BROWSER_SOCKET_DIR || null, tmpdir: e.TMPDIR || null, noColor: e.NO_COLOR || null,
    exe: e.AGENT_BROWSER_EXECUTABLE_PATH || null, args: e.AGENT_BROWSER_ARGS || null,
    hasNative: e.AGENT_BROWSER_NATIVE !== undefined, hasEnc: e.AGENT_BROWSER_ENCRYPTION_KEY !== undefined,
    hasSessionName: e.AGENT_BROWSER_SESSION_NAME !== undefined, hasProfile: e.AGENT_BROWSER_PROFILE !== undefined,
    headed: e.AGENT_BROWSER_HEADED || null, display: e.DISPLAY || null, idle: e.AGENT_BROWSER_IDLE_TIMEOUT_MS || null,
    tz: e.TZ || null, language: e.LANGUAGE || null, home: e.HOME || null,
  };
}

function matchRule(cmd, rest, script) {
  const rules = Array.isArray(scn.rules) ? scn.rules : [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i], w = r.when || {};
    if (w.cmd && w.cmd !== cmd) continue;
    if (w.argIncludes && !rest.join(' ').includes(w.argIncludes)) continue;
    if (w.scriptIncludes && !(script || '').includes(w.scriptIncludes)) continue;
    const key = 'r' + i;
    state.ruleHits[key] = (state.ruleHits[key] || 0) + 1;
    if (w.nth && state.ruleHits[key] !== w.nth) continue;
    return r.do || {};
  }
  return null;
}

async function applyRule(d) {
  if (d.spawnChild) {
    const c = spawn(process.execPath, ['-e', 'setTimeout(function(){},120000)'], { stdio: 'ignore' });
    try { fs.writeFileSync(path.join(DIR, 'child.pid'), String(c.pid)); } catch { /* ignore */ }
  }
  if (d.spawnGrandchildMs) {
    const g = spawn(process.execPath, ['-e', `setTimeout(function(){},${d.spawnGrandchildMs})`], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
    try { fs.writeFileSync(path.join(DIR, 'grandchild.pid'), String(g.pid)); } catch { /* ignore */ }
    g.unref();
  }
  if (d.delayMs) await sleep(d.delayMs);
  if (d.hangMs) await sleep(d.hangMs);
  if (d.stdout !== undefined || d.stderr !== undefined || d.code !== undefined) {
    saveState();
    await finish(d.code === undefined ? 0 : d.code, d.stdout, d.stderr);
  }
}

// Emulates the real CLI: a command that takes longer than the IPC read timeout is re-sent (up to 5
// sends in total) and the daemon executes every send. fn() is one execution inside the "daemon".
async function withResends(fn) {
  const R = Number(process.env.FAKE_AB_READ_TIMEOUT_MS) || scn.readTimeoutMs || 30000;
  const t0 = Date.now();
  log({ event: 'exec', n: 1 });
  let result = await fn();
  const sends = Math.min(5, 1 + Math.floor((Date.now() - t0) / R));
  for (let k = 2; k <= sends; k++) {
    log({ event: 'resend', n: k });
    log({ event: 'exec', n: k });
    result = await fn();
  }
  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--version' || argv[0] === '-V') {
    log({ event: 'call', argv, env: seenEnv() });
    return finish(0, `agent-browser ${scn.version || '0.21.0'}`);
  }
  if (argv[0] !== '--session' || argv.length < 3) return finish(2, '', 'usage: agent-browser --session <name> <command> [args...]');
  const session = argv[1], cmd = argv[2], rest = argv.slice(3);
  let script = null;
  if (cmd === 'eval' && rest[0] === '-b') { try { script = Buffer.from(rest[1] || '', 'base64').toString('utf8'); } catch { script = null; } }
  log({ event: 'call', argv, session, cmd, script: script ? script.slice(0, 6000) : undefined, env: seenEnv() });

  if (cmd === 'close') {
    state = { alive: false, url: 'about:blank', page: 'blank', loggedIn: false, hasFingerprint: false, bannerDismissed: false, counters: state.counters, ruleHits: state.ruleHits, spent: state.spent };
    saveState();
    if (scn.site && scn.site.dnsBrokenUntilClose) { scn.site.dnsBroken = false; scn.site.dnsBrokenUntilClose = false; try { fs.writeFileSync(F_SCN, JSON.stringify(scn, null, 2)); } catch { /* ignore */ } }
    return finish(0, '\u2713 Browser closed');
  }

  const rule = matchRule(cmd, rest, script);
  if (rule) { await applyRule(rule); }

  if (!state.alive) {
    if (scn.coldStartDelayMs) await sleep(scn.coldStartDelayMs);
    state.alive = true; state.url = 'about:blank'; state.page = 'blank';
    log({ event: 'cold-start', session });
  }

  switch (cmd) {
    case 'open': {
      const url = rest[0];
      const r = site.navigate(state, siteCfg, url);
      saveState();
      if (!r.ok) return finish(1, '', '\u2717 ' + r.error);
      return finish(0, `\u2713 ${state.page}\n${state.url}`);
    }
    case 'wait': {
      if (siteCfg.networkidleTimeout) { await sleep(siteCfg.networkidleTimeout === true ? 50 : siteCfg.networkidleTimeout); saveState(); return finish(1, '', '\u2717 Timeout 30000ms exceeded waiting for load state networkidle'); }
      saveState();
      return finish(0, '\u2713 Done');
    }
    case 'get': {
      if (rest[0] === 'url') { saveState(); return finish(0, state.url); }
      return finish(2, '', 'unsupported get target');
    }
    case 'state': {
      if (rest[0] === 'save') {
        const p = rest[1];
        if (!p) return finish(2, '', 'usage: state save <path>');
        if (scn.stateSaveFails) return finish(1, '', '\u2717 State save failed');
        fs.writeFileSync(p, JSON.stringify(scn.stateSaveGarbage ? { nothing: true } : site.stateJson(state), null, 2));
        saveState();
        return finish(0, `\u2713 State saved to ${p}`);
      }
      if (rest[0] === 'load') {
        const p = rest[1];
        let j;
        try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return finish(1, '', `\u2717 Failed to read state file: ${e.message}`); }
        site.applyLoadedState(state, siteCfg, j);
        state.counters.stateLoads = (state.counters.stateLoads || 0) + 1;
        saveState();
        return finish(0, `\u2713 State path set to ${p}`);
      }
      return finish(2, '', 'unsupported state action');
    }
    case 'eval': {
      if (script === null) return finish(2, '', '\u2717 Invalid base64 encoding');
      const save = saveState;
      let out;
      try {
        out = await withResends(async () => {
          const v = await site.evalScript(script, state, siteCfg, save);
          saveState();
          return site.formatEval(v);
        });
      } catch (e) {
        saveState();
        return finish(1, '', `\u2717 Evaluation failed: ${e && e.message ? e.message : e}`);
      }
      return finish(0, out);
    }
    default:
      return finish(2, '', `\u2717 Unknown command: ${cmd}`);
  }
}

main().catch((e) => finish(1, '', 'fake agent-browser crashed: ' + (e && e.stack || e)));
