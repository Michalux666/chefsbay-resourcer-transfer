'use strict';
const { notify } = require('../lib/notify');
const retries = require('./retries');

const KINDS = Object.freeze({
  SCREENING_UNAVAILABLE: 'screening-unavailable',
  SCREENING_ERROR: 'screening-error',
  SCRAPE_FAILURE: 'scrape-failure',
  UNLOCK_FAILING: 'unlock-failing',
  DB_UNAVAILABLE: 'db-unavailable',
  RUN_ERROR: 'run-error',
});

function raiseAlert(ctx, severity, key, text) {
  ctx.out(`ALERT: ${text}`);
  try { notify({ severity, key, text, meta: { jobTitle: ctx.p.JOB_TITLE, location: ctx.p.LOCATION } }); } catch (e) { /* alerting never throws */ }
}

function reasonOf(st) {
  if (!st || !st.screeningIncomplete) return null;
  return typeof st.screeningIncomplete === 'string' ? st.screeningIncomplete : KINDS.SCREENING_UNAVAILABLE;
}

// bounded holds give up after cfg.incompleteMaxRuns early-ended runs of one search so a repeating fault cannot loop every minute.
function markIncomplete(ctx, kind, opts) {
  const { st, cfg, out, p } = ctx;
  if (st.screeningIncomplete || st.incompleteGaveUp) return { held: !!st.screeningIncomplete };
  const bounded = !!(opts && opts.bounded);
  if (!bounded) {
    st.screeningIncomplete = kind;
    return { held: true };
  }
  const { runs, persisted } = retries.bump(ctx, kind);
  const limit = cfg.incompleteMaxRuns;
  st.incompleteRuns = runs;
  if (!persisted) out('WARN could not persist the early-end counter (runtime/phase1-incomplete-runs.json); the hold cannot be bounded this run');
  if (runs >= limit && persisted) {
    st.incompleteGaveUp = kind;
    retries.clear(ctx);
    out(`GIVING UP holding ${p.JOB_TITLE}/${p.LOCATION}: ${runs} runs in a row ended early (${kind}); this run completes normally so the territory is not retried every minute`);
    raiseAlert(ctx, 'critical', 'phase1-incomplete-giveup',
      `${p.JOB_TITLE} ${p.LOCATION} ended early ${runs} times in a row (${kind}); the search is now treated as done for this interval. Check logs/phase1-console-*.log.`);
    return { held: false, gaveUp: true };
  }
  st.screeningIncomplete = kind;
  out(`RUN ENDED EARLY (${kind}): the territory and its pending search are kept (early-end ${runs} of ${limit})`);
  return { held: true, runs };
}

module.exports = { KINDS, raiseAlert, reasonOf, markIncomplete };
