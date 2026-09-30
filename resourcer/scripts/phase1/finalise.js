'use strict';
const { dbRun, idStr } = require('./db');
const { creditsCheck } = require('./session');
const { writeStatus, buildQueueObject, writeQueue } = require('./queue');
const { clockLondon, round1 } = require('./util');
const retries = require('./retries');

const blankIfNull = (v) => (v === null || v === undefined ? '' : v);

// After the page loop: final status, timings, credits sync, the queue file, and the Zoho pre-check.
async function finalise(ctx) {
  const { st, out } = ctx;

  // A kill between this write and the hand-off must stay recoverable, which needs phase2Status pending on disk.
  st.phase2Status = 'pending';
  writeStatus(ctx, 'phase1_complete', st.pagesScraped);
  if (!st.screeningIncomplete && !st.incompleteGaveUp) retries.clear(ctx);
  const completedAt = new Date().toISOString();
  const scrapingTimeSecs = round1((Date.now() - st.scrapingStartMs) / 1000);
  const avgTimePerPageSecs = st.pageTimings.length
    ? round1(st.pageTimings.reduce((a, b) => a + b, 0) / st.pageTimings.length)
    : null;
  const avgTimePerRoundtrip = st.browserRoundtrips > 0 ? round1(scrapingTimeSecs / st.browserRoundtrips) : null;

  out('');
  out(`=== PHASE 1 DONE: ${clockLondon()} ===`);
  out(`Phase 1 scraping time: ${scrapingTimeSecs}s | Avg per page: ${blankIfNull(avgTimePerPageSecs)}s | Avg per roundtrip: ${blankIfNull(avgTimePerRoundtrip)}s`);
  out(`Browser round-trips: ${st.browserRoundtrips}`);
  out(`Approved: ${st.approved.length} | DB skips: ${st.skippedDb} | Review rejects: ${st.skippedReview} | Errors: ${st.errors}`);

  const creds = await creditsCheck(ctx, ['--update-db']);
  const creditsRemaining = creds.credits || 'unknown';
  out(`Credits remaining: ${creditsRemaining}`);

  const queueObj = buildQueueObject(ctx, { creditsRemaining, completedAt, scrapingTimeSecs, avgTimePerPageSecs, avgTimePerRoundtrip });
  writeQueue(ctx, queueObj);
  out(`Queue file: ${st.queueFile}`);

  // Candidates already in Zoho (by DB zoho_id) are dropped before Phase 2.
  const filtered = [];
  for (const c of st.approved) {
    const r = await dbRun(ctx, ['get-zoho-id', idStr(c.id)]);
    const zid = r.stdout.trim();
    if (r.code === 0 && !r.timedOut && zid && zid !== 'null') {
      out(`[${idStr(c.id)}] Already in Zoho (${zid}) - skip`);
    } else {
      filtered.push(c);
    }
  }
  out(`After Zoho pre-check: ${filtered.length} remain (was ${st.approved.length})`);
  st.approved = filtered;

  queueObj.candidates = st.approved;
  writeQueue(ctx, queueObj);
  out('Queue file updated');
  return { creditsRemaining };
}

module.exports = { finalise };
