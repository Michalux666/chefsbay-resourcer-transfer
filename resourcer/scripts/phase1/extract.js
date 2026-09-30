'use strict';
const fs = require('fs');
const { sleep } = require('../lib/fsx');
const { pageUrl } = require('./url');
const { safeText, parseFailure } = require('./util');

// Empty-result probe, run only when the first scraped page has 0 cards. It asks the page whether it
// explicitly reports zero candidates. The legacy copy of this source lost its backslashes on
// 2026-09-04 (0s+candidates), so the "0 candidates" branch never matched; String.raw keeps them.
// The leading boundary stops "150 candidates" or "1,000 candidates" from reading as a zero.
const EMPTY_PROBE_JS = String.raw`(function(){var t=document.body?document.body.innerText:'';if(/(?:^|[^0-9,.])0\s+candidates?\b/i.test(t))return 'EMPTY';if(/no (candidates|results|matches)( (were )?found)?/i.test(t))return 'EMPTY';var m=t.match(/([0-9,]+)\s+candidates?/i);if(m)return 'COUNT:'+m[1];return 'UNKNOWN';})()`;
const EMPTY_PROBE_B64 = Buffer.from(EMPTY_PROBE_JS, 'utf8').toString('base64');

function loadExtractB64(file) {
  return fs.readFileSync(file, 'utf8').replace(/\s+/g, '');
}

// True when the probe output (agent-browser prints a JS string as a quoted JSON string) is exactly EMPTY.
function isExplicitEmpty(probeOut) {
  const lines = String(probeOut || '').split('\n').map((l) => l.trim().replace(/^"|"$/g, ''));
  return lines.includes('EMPTY');
}

async function probeEmpty(ctx) {
  const r = await ctx.browser.evalB64(EMPTY_PROBE_B64, 'empty-result confirm', ctx.cfg.browserMs.probe);
  return r.timedOut ? '' : r.out.trim();
}

// Navigates to one results page and returns its cards.
// {kind:'skip'} means the page failed (the caller counts the error and moves on);
// {kind:'cards', cards, networkidleTimedOut} otherwise.
async function extractPage(ctx, page) {
  const { st, cfg, out, browser } = ctx;

  const openRes = await browser.open(pageUrl(st.resultsUrlBase, page), `open page ${page}`);
  st.browserRoundtrips++;
  if (openRes.timedOut) {
    out(`WARN open timed out on page ${page} - skipping page`);
    return { kind: 'skip' };
  }
  if (!openRes.ok) out(`WARN open returned an error on page ${page}: ${safeText(openRes.out, 200)} - continuing`);

  const waitRes = await browser.waitNetworkIdle(`wait networkidle page ${page}`);
  st.browserRoundtrips++;
  let networkidleTimedOut = false;
  if (waitRes.timedOut) {
    out(`WARN wait networkidle timed out on page ${page} - sleeping ${cfg.settleMs / 1000}s for page to settle`);
    await sleep(cfg.settleMs);
    networkidleTimedOut = true;
  }

  const evalRes = await browser.evalB64(ctx.extractB64, `eval extract page ${page}`);
  st.browserRoundtrips++;
  if (evalRes.timedOut) {
    out(`WARN eval extract timed out on page ${page} - skipping page`);
    return { kind: 'skip' };
  }

  let jsonStr = evalRes.out.trim();
  if (jsonStr.length > 0 && jsonStr[0] === '"') {
    try {
      jsonStr = String(JSON.parse(jsonStr));
    } catch (e) {
      out(`WARN outer-string decode failed on page ${page} - skipping page: ${parseFailure(e)}`);
      return { kind: 'skip' };
    }
  }

  if (/^(Error|Timeout|Exception)/i.test(jsonStr)) {
    out(`WARN agent-browser returned an error on page ${page} - skipping: ${safeText(jsonStr, 200)}`);
    return { kind: 'skip' };
  }

  let cards;
  try {
    // Empty output reads as zero cards (as the legacy JSON reader did): the zero-card probe then decides between exhaustion and a fault.
    cards = jsonStr.trim() === '' ? [] : JSON.parse(jsonStr);
    if (cards === null) cards = [];
    if (!Array.isArray(cards)) throw new Error('expected a JSON array of cards');
  } catch (e) {
    out(`WARN parsing cards on page ${page} failed - skipping page: ${parseFailure(e)}`);
    // Card JSON holds names and snippets: only text that is not card data is echoed.
    out(/^\s*[[{]/.test(jsonStr) ? `  Raw output: ${jsonStr.length} chars of card-like JSON not logged` : `  Raw snippet (first 200): ${safeText(jsonStr, 200)}`);
    return { kind: 'skip' };
  }
  return { kind: 'cards', cards, networkidleTimedOut };
}

module.exports = { extractPage, probeEmpty, isExplicitEmpty, loadExtractB64, EMPTY_PROBE_JS, EMPTY_PROBE_B64 };
