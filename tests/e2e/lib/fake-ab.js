#!/usr/bin/env node
'use strict';
/*
 * Fake agent-browser 0.21.0 for the end-to-end rehearsal. It is the browser package's fake
 * (tests/browser/fake) plus a Caterer search-results page: candidate cards are served to the REAL
 * scripts/extract-js.b64 payload (run in a vm against a small DOM), so a change to that payload's
 * selectors fails the rehearsal instead of passing silently.
 *
 * Scenario: $FAKE_AB_DIR/scenario.json  site.searchWorld = { byLocation: { LS29: { pages: { "1": [card] } } } }
 *   card = { id, name, text, postcode, dataValue, unlockedPrev }
 * Unlock answers and CV bodies are ordinary site.fetch entries (see ../../browser/fake/site.js).
 */
const site = require('../../browser/fake/site.js');

const origNavigate = site.navigate;
const origEval = site.evalScript;

site.navigate = function navigate(state, cfg, url) {
  // A verification link is tied to the e-mail Caterer sent, not to the page the browser happens to be on.
  if (/TwoFaAuthRedirect/i.test(url) && state.counters && state.counters.safelistEmails > 0 && !state.loggedIn) state.page = 'safelist';
  const r = origNavigate(state, cfg, url);
  if (state.page === 'search') {
    try {
      const u = new URL(url);
      state.searchLoc = u.searchParams.get('CurrentLocation');
      state.searchPageNo = Number(u.searchParams.get('PageNumber') || 1);
    } catch { /* keep the previous values */ }
  }
  return r;
};

function searchDocument(state, cfg) {
  const world = cfg.searchWorld && cfg.searchWorld.byLocation && cfg.searchWorld.byLocation[state.searchLoc];
  const cards = (world && world.pages && world.pages[String(state.searchPageNo || 1)]) || [];
  const els = cards.map((c) => ({
    id: `candidate-${c.id}`,
    innerText: `${c.text}\nUnlock candidate to view full profile`,
    innerHTML: `<div class="flags">${c.unlockedPrev ? 'Unlocked previously' : 'Never unlocked'}</div>`,
    querySelector: () => ({ innerText: c.name }),
    dataValue: c.dataValue,
  }));
  const body = cards.length ? `Showing ${cards.length} candidates on this page` : (cfg.searchWorld && cfg.searchWorld.emptyText) || '0 candidates match your search';
  return {
    body: { innerText: body },
    querySelectorAll: (sel) => (sel === '[id^=candidate-]' ? els : []),
    querySelector: (sel) => {
      const m = /^input\[name=candidate-data-(\d+)\]$/.exec(sel);
      if (!m) return null;
      const el = els.find((e) => e.id === `candidate-${m[1]}`);
      return el ? { value: el.dataValue } : null;
    },
  };
}

site.evalScript = async function evalScript(script, state, cfg, save) {
  if (state.page === 'search' && cfg.searchWorld) {
    const isExtract = script.includes('querySelectorAll') && script.includes('candidate-');
    const isProbe = script.includes("'EMPTY'") && script.includes('innerText');
    if (isExtract || isProbe) {
      const vm = require('vm');
      const doc = searchDocument(state, cfg);
      const ctx = vm.createContext({ document: doc, Array, JSON, RegExp, parseInt, String });
      return vm.runInContext(script, ctx, { timeout: 5000 });
    }
  }
  return origEval(script, state, cfg, save);
};

require('../../browser/fake/agent-browser.js');
