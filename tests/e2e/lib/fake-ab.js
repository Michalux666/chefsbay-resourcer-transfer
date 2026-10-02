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
      state.searchActivityId = u.searchParams.get('LastActivityId');
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

// What the results page says about the filters it applied (docs/ACTIVITY.md): the header count and the summary line. scenario searchWorld.activity:
//   echoById {id: text}   the text Caterer echoes for a LastActivityId (default: the legacy probe's values)
//   absentEcho            the text when no LastActivityId was sent (default: none, the summary then has no 'Active within last' part)
//   forceEcho             one text for every page (a Caterer that shows another window than the one sent)
//   noSummary             the summary line and header are missing (a changed page)
const DEFAULT_ECHO = { 7: '14 days', 8: '1 month', 9: '2 months', 11: '6 months', 15: '12 months', 0: 'All' };
function activityDocument(state, cfg) {
  const act = (cfg.searchWorld && cfg.searchWorld.activity) || {};
  const world = cfg.searchWorld && cfg.searchWorld.byLocation && cfg.searchWorld.byLocation[state.searchLoc];
  const cards = (world && world.pages && world.pages[String(state.searchPageNo || 1)]) || [];
  if (act.noSummary) return { body: { innerText: `Showing ${cards.length} candidates on this page` } };
  const id = state.searchActivityId;
  const byId = Object.assign({}, DEFAULT_ECHO, act.echoById || {});
  let text = id === null || id === undefined ? (act.absentEcho === undefined ? null : act.absentEcho) : byId[id];
  if (act.forceEcho !== undefined) text = act.forceEcho;
  const total = (world && world.total) || cards.length;
  const summary = `Search anything in CV or Profile: Chef. Exact match.${text === null || text === undefined ? '' : ` Active within last: ${text}.`} CV/Profile: Both`;
  return { body: { innerText: `Candidates ${total}\n${summary}\n` } };
}

site.evalScript = async function evalScript(script, state, cfg, save) {
  if (state.page === 'search' && cfg.searchWorld && script.includes('ACTIVITY-READ')) {
    const vm = require('vm');
    return vm.runInContext(script, vm.createContext({ document: activityDocument(state, cfg), Array, JSON, RegExp, parseInt, String }), { timeout: 5000 });
  }
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
