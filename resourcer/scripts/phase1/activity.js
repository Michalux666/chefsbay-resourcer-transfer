'use strict';
// The search window of a Caterer run, as it was requested, as it was sent and as Caterer says it applied it (docs/ACTIVITY.md).
//
//   initial()     the block that the status file, the queue and the run results carry (`activity`)
//   announce()    prints the note of a window that could not be sent
//   selfCheck()   after the first results page: reads the summary of the filters Caterer applied, compares it with what the config expects
//                 for the id that was sent, writes one ACTIVITY_FILTER line and stores the answer. It never fails the run (a wrong window
//                 only changes the pool) and never costs a browser round-trip in the run's statistics.
//
// The library (lib/search-activity.js) is optional here: without it (an older copy of the tree) the block still records what was
// requested and sent, and nothing is read from the page.
let lib = null;
try { lib = require('../lib/search-activity'); } catch (e) { lib = null; }

const URL_ID_RE = /[?&]LastActivityId=(\d{1,4})(?=&|#|$)/i;

function sentIdOf(url) {
  const m = String(url || '').match(URL_ID_RE);
  return m ? Number(m[1]) : null;
}

// The block of the status file: what was asked, what was sent, what Caterer applied (filled in by selfCheck).
function initial(p, resultsUrl) {
  const sent = sentIdOf(resultsUrl);
  const block = {
    requestedActiveWithin: p.ACTIVE_WITHIN,
    requestedCvLimit: p.CV_LIMIT,
    sentLastActivityId: sent === null ? 'none' : sent,
    appliedFilterText: null,
    poolHeaderCount: null,
    matched: 'not-checked',
  };
  if (p.ACTIVITY_NOTE) block.note = String(p.ACTIVITY_NOTE).slice(0, 200);
  return block;
}

function announce(ctx) {
  const a = ctx.st.activity;
  if (a && a.note) ctx.out(`ACTIVITY_FILTER_NOTE ${a.note}`);
}

function alertText(a, matched) {
  if (matched === 'no') {
    return `Caterer did not show the search window that was sent: the request asked for "${a.requestedActiveWithin}" (LastActivityId=${a.sentLastActivityId}) and the results page says "${a.appliedFilterText || 'no window'}". The run continued; only the size of the pool differs. Check resourcer/config/caterer-activity.json and docs/ACTIVITY.md.`;
  }
  return `The results page summary could not be read, so the search window that was sent ("${a.requestedActiveWithin}", LastActivityId=${a.sentLastActivityId}) is not confirmed. The run continued. The page layout may have changed: see docs/ACTIVITY.md.`;
}

async function selfCheck(ctx, cardsOnPage) {
  const st = ctx.st;
  const a = st.activity;
  if (!lib || !a || a.matched !== 'not-checked') return;
  let reading = lib.parseSummaryOutput('');
  try {
    const r = await ctx.browser.evalB64(lib.SUMMARY_B64, 'read applied filters', ctx.cfg.browserMs.probe);
    if (r && r.ok && !r.timedOut) reading = lib.parseSummaryOutput(r.out);
  } catch (e) { /* unreadable */ }
  const sent = a.sentLastActivityId === 'none' ? null : a.sentLastActivityId;
  let expected = null;
  if (sent !== null) expected = lib.entryForId(lib.loadCatererConfig(), sent);
  const ev = lib.evaluateApplied({ sentId: sent, expected, reading });
  a.appliedFilterText = ev.applied;
  a.poolHeaderCount = ev.poolHeaderCount;
  a.matched = ev.matched;
  ctx.out(lib.activityLine(a.requestedActiveWithin, sent, ev.applied, ev.matched));
  const alertable = ev.matched === lib.MATCH.NO || (ev.matched === lib.MATCH.UNREADABLE && cardsOnPage > 0);
  if (!alertable) return;
  try {
    const text = alertText(a, ev.matched);
    if (lib.alertOncePerDay({ text, meta: { jobTitle: ctx.p.JOB_TITLE, location: ctx.p.LOCATION, matched: ev.matched } })) ctx.out(`ALERT: ${text}`);
  } catch (e) { /* alerting never throws */ }
}

module.exports = { initial, announce, selfCheck, sentIdOf };
