'use strict';
/*
 * Test-side handle for the fake agent-browser (see agent-browser.js).
 *
 *   const fake = require('.../tests/browser/fake').create(dir);
 *   Object.assign(process.env, fake.env());      // RESOURCER_AB_BIN, FAKE_AB_DIR, fast-test switches
 *   fake.scenario({ site: { login: { mode: 'safelist' } } });   // deep-merges into scenario.json
 *   fake.browser({ loggedIn: true });                            // edits the fake browser state
 *   fake.calls('eval');  fake.counters();  fake.reset();
 */
const fs = require('fs');
const path = require('path');

const BIN = path.join(__dirname, 'agent-browser.js');
const CHROMIUM = path.join(__dirname, 'chromium.js');

function deepMerge(a, b) {
  if (Array.isArray(b) || b === null || typeof b !== 'object') return b;
  const out = Object.assign({}, a && typeof a === 'object' && !Array.isArray(a) ? a : {});
  for (const k of Object.keys(b)) out[k] = deepMerge(out[k], b[k]);
  return out;
}

function create(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const F_SCN = path.join(dir, 'scenario.json');
  const F_BRW = path.join(dir, 'browser.json');
  const F_CALLS = path.join(dir, 'calls.jsonl');
  const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const api = {
    dir, bin: BIN, chromium: CHROMIUM,
    env(extra) {
      return Object.assign({
        RESOURCER_AB_BIN: BIN,
        FAKE_AB_DIR: dir,
        RESOURCER_AB_NAV_GAP_MS: '0',
        RESOURCER_SLEEP_SCALE: '0',
        RESOURCER_AB_IPC_READ_MS: '1800',
        FAKE_AB_READ_TIMEOUT_MS: '1800',
      }, extra || {});
    },
    scenario(patch) {
      const next = patch === undefined ? rd(F_SCN, {}) : deepMerge(rd(F_SCN, {}), patch);
      if (patch !== undefined) fs.writeFileSync(F_SCN, JSON.stringify(next, null, 2));
      return next;
    },
    setScenario(obj) { fs.writeFileSync(F_SCN, JSON.stringify(obj, null, 2)); },
    browser(patch) {
      const cur = rd(F_BRW, { alive: false, url: 'about:blank', page: 'blank', loggedIn: false, hasFingerprint: false, bannerDismissed: false, counters: {}, ruleHits: {} });
      if (patch === undefined) return cur;
      const next = deepMerge(cur, patch);
      fs.writeFileSync(F_BRW, JSON.stringify(next));
      return next;
    },
    /** Make the fake browser look like a warm, signed-in daemon sitting on the recruiter home page. */
    warmLoggedIn() {
      return api.browser({ alive: true, loggedIn: true, hasFingerprint: true, knownDevice: true, page: 'home', url: 'https://recruiter.caterer.com/Home/1368655' });
    },
    calls(cmd) {
      let lines = [];
      try { lines = fs.readFileSync(F_CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
      const all = lines.filter((l) => l.event === 'call');
      return cmd ? all.filter((c) => c.cmd === cmd) : all;
    },
    events(name) {
      let lines = [];
      try { lines = fs.readFileSync(F_CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
      return name ? lines.filter((l) => l.event === name) : lines;
    },
    /** Compact "cmd arg" trail of every invocation, e.g. ['open https://...', 'wait --load networkidle']. */
    trail() {
      return api.calls().map((c) => (c.argv || []).slice(c.session ? 2 : 0).map((a, i) => (c.cmd === 'eval' && i === 1 ? '<b64>' : a)).join(' '));
    },
    counters() { return api.browser().counters || {}; },
    clearCalls() { try { fs.unlinkSync(F_CALLS); } catch { /* none */ } },
    reset() {
      for (const f of [F_SCN, F_BRW, F_CALLS]) { try { fs.unlinkSync(f); } catch { /* none */ } }
    },
  };
  return api;
}

module.exports = { create, deepMerge, BIN, CHROMIUM };
