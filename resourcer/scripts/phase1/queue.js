'use strict';
const fs = require('fs');
const fsx = require('../lib/fsx');
const { readJsonStrict, todayLondon, safeText } = require('./util');
const { reasonOf } = require('./incomplete');
const resurface = require('./resurface');

// Queue files hold names, emails and phone numbers: owner-only.
const QUEUE_MODE = 0o600;
// Default reason of a run that stopped because screening went down: Phase 2 may push what was approved but keeps the territory.
const INCOMPLETE_SCREENING = 'screening-unavailable';

// Live status file the dashboard, run-lock, run-pipeline and the watchdog read (schema unchanged).
function statusObject(ctx, status, pg) {
  const { st, p } = ctx;
  const obj = {
    id: `phase1-${st.timestamp}`,
    status,
    jobTitle: p.JOB_TITLE,
    location: p.LOCATION,
    distance: p.DISTANCE_MILES,
    pool: st.skippedDb + st.approved.length + st.skippedReview,
    startedAt: st.startedAt,
    page: pg || 0,
    approved: st.approved.length,
    skippedDb: st.skippedDb,
    errors: st.errors,
    sources: p.SOURCES,
    phase2Status: st.phase2Status,
    updatedAt: new Date().toISOString(),
  };
  const why = reasonOf(st);
  if (why) {
    obj.incomplete = why;
    if (st.incompleteRuns) {
      obj.incompleteRuns = st.incompleteRuns;
      obj.incompleteLimit = ctx.cfg ? ctx.cfg.incompleteMaxRuns : undefined;
    }
  }
  if (st.incompleteGaveUp) obj.incompleteGaveUp = st.incompleteGaveUp;
  return obj;
}

function writeStatus(ctx, status, pg) {
  try {
    fsx.writeJsonAtomic(ctx.st.statusFile, statusObject(ctx, status, pg));
    ctx.st.lastStatus = status;
    return true;
  } catch (e) {
    ctx.out(`WARN could not write status file: ${safeText(e.message, 200)}`);
    return false;
  }
}

// Recovery: a queue checkpoint with this run's timestamp is reloaded so approved (already unlocked)
// candidates are not lost or re-screened.
function loadCheckpoint(ctx) {
  const file = ctx.st.queueFile;
  if (!fs.existsSync(file)) return [];
  try {
    const q = readJsonStrict(file);
    if (q && Array.isArray(q.candidates) && q.candidates.length > 0) {
      const seen = new Set();
      const unique = q.candidates.filter((c) => {
        const id = String(c && c.id !== undefined && c.id !== null ? c.id : '');
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      ctx.out(`[RECOVERY] Loaded ${unique.length} previously-approved candidates from checkpoint`);
      return unique;
    }
    return [];
  } catch (e) {
    ctx.out(`[RECOVERY] Could not parse existing queue file - starting fresh: ${safeText(e.message, 200)}`);
    return [];
  }
}

// Written after every page that has approvals: if the process dies mid-run the queue survives.
function writeCheckpoint(ctx, opts) {
  const { st, p } = ctx;
  if (st.approved.length === 0) return;
  const obj = {
    searchDate: todayLondon(),
    jobTitle: p.JOB_TITLE,
    location: p.LOCATION,
    source: 'caterer',
    candidates: st.approved,
  };
  try {
    fsx.writeJsonAtomic(st.queueFile, obj, QUEUE_MODE);
    if (!(opts && opts.quiet)) ctx.out(`[CHECKPOINT] Saved ${st.approved.length} candidates to queue file after page ${st.page}`);
  } catch (e) {
    ctx.out(`WARN checkpoint write failed: ${safeText(e.message, 200)}`);
  }
}

function buildQueueObject(ctx, fin) {
  const { st, p } = ctx;
  const obj = {
    searchId: p.SEARCH_ID,
    searchDate: todayLondon(),
    jobTitle: p.JOB_TITLE,
    location: p.LOCATION,
    distance: p.DISTANCE_MILES,
    activeWithin: p.ACTIVE_WITHIN,
    keywords: p.KEYWORDS.trim(),
    cvLimit: p.CV_LIMIT,
    priority: p.PRIORITY,
    sources: p.SOURCES,
    phase2Status: 'pending',
    screeningModel: st.screeningModel,
    candidateCount: st.totalSeen,
    creditsRemaining: fin.creditsRemaining,
    phase1StartedAt: st.startedAt,
    requestedAt: p.REQUESTED_AT ? p.REQUESTED_AT : st.startedAt,
    phase1Stats: {
      pagesScraped: st.pagesScraped,
      approved: st.approved.length,
      skippedDb: st.skippedDb,
      scrapingStartedAt: st.scrapingStartedAt,
      phase1CompletedAt: fin.completedAt,
      sessionValidationTimeSecs: st.sessionValidationTimeSecs,
      scrapingTimeSecs: fin.scrapingTimeSecs,
      avgTimePerPageSecs: fin.avgTimePerPageSecs,
      avgTimePerBrowserRoundtrip: fin.avgTimePerRoundtrip,
      pageTimings: st.pageTimings,
      sessionRefreshed: false,
      skippedReview: st.skippedReview,
      errors: st.errors,
      browserRoundtrips: st.browserRoundtrips,
      totalCandidatesSeen: st.totalSeen,
    },
    candidates: st.approved,
  };
  const why = reasonOf(st);
  if (why) obj.phase1Stats.incomplete = why;
  // only when a resurfaced candidate (or a stop of the second look) happened in this run: otherwise the queue is exactly what it always was
  const rsv = resurface.queueStats(ctx);
  if (rsv) obj.phase1Stats.resurfaced = rsv;
  return obj;
}

function writeQueue(ctx, obj) {
  fsx.writeJsonAtomic(ctx.st.queueFile, obj, QUEUE_MODE);
}

module.exports = { INCOMPLETE_SCREENING, statusObject, writeStatus, loadCheckpoint, writeCheckpoint, buildQueueObject, writeQueue };
