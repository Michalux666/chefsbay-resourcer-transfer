// Pipeline halt state - one place to record "the pipeline is stopped and why".
//
// Why (2026-09-04): when the screening dependency died on 09-03 the pipeline kept accepting
// territories. Each run did a full Caterer scrape (browser roundtrips, credits check, ~7 min),
// failed at AI screening, and still marked the territory searched with its next_run_date
// advanced. A whole day was consumed producing nothing, and the only clue was buried in per-run
// console logs. Two separate costs: wasted work, and a burnt schedule slot per territory.
//
// The fix is to refuse to start when a hard dependency is down, hold the queue, and say so
// loudly. This module owns that state:
//   - runtime/pipeline-halt.json  - machine-readable current state (dashboard reads it)
//   - logs/errors.jsonl           - one entry on halt and one on recovery; the dashboard
//                                   already surfaces this feed with an acknowledge flow
//   - outbox/alerts.jsonl         - one notify() on halt (critical) and one on recovery (info)
//
// Halting is deliberately sticky-but-self-clearing: once the dependency is healthy again,
// clearHalt() runs automatically on the next check, so nothing needs manual resetting.
'use strict';

const path = require('path');
const paths = require('./paths');
const fsx = require('./fsx');
const env = require('./env');
const { notify } = require('./notify');

const STATE_FILE = path.join(paths.RUNTIME, 'pipeline-halt.json');
const ERRORS_LOG = path.join(paths.LOGS, 'errors.jsonl');
const ALERT_KEY = 'pipeline-halt';

// The legacy entries carry a real em dash; keep the bytes identical without non-ASCII source.
const DASH = '\u{2014}';

function appendError(entry) {
  try {
    fsx.appendLine(ERRORS_LOG, JSON.stringify(entry));
  } catch (e) { /* logging must never throw */ }
}

function getHalt() {
  return fsx.readJson(STATE_FILE, null);
}

/**
 * Record that the pipeline is halted. Idempotent: re-calling while already halted for the
 * same reason updates lastCheckedAt/attempts but does NOT spam errors.jsonl or the outbox.
 */
function setHalt(reason, detail, opts = {}) {
  const prev = getHalt();
  const now = new Date().toISOString();

  if (prev && prev.reason === reason) {
    const next = { ...prev, lastCheckedAt: now, blockedRuns: (prev.blockedRuns || 0) + (opts.blockedRun ? 1 : 0) };
    try { fsx.writeJsonAtomic(STATE_FILE, next); } catch (e) { /* best effort */ }
    return next;
  }

  // Detail comes from upstream error text; it must never carry a secret into a state file.
  const safeDetail = env.redact(String(detail || ''));
  const safeRemedy = opts.remedy ? env.redact(String(opts.remedy)) : null;

  const state = {
    halted: true,
    reason,
    detail: safeDetail,
    since: now,
    lastCheckedAt: now,
    blockedRuns: opts.blockedRun ? 1 : 0,
    remedy: safeRemedy,
  };
  try {
    fsx.writeJsonAtomic(STATE_FILE, state);
  } catch (e) { /* best effort */ }

  appendError({
    ts: now,
    context: 'pipeline_halted',
    severity: 'critical',
    error: `PIPELINE HALTED ${DASH} ${reason}`,
    detail: safeDetail,
    remedy: safeRemedy,
  });
  try {
    const remedy = safeRemedy ? ` Remedy: ${safeRemedy}` : '';
    notify({
      severity: 'critical',
      key: ALERT_KEY,
      text: `PIPELINE HALTED - ${reason}. ${safeDetail}${remedy}`.trim(),
      meta: { event: 'halted', reason },
    });
  } catch (e) { /* alerting must never throw */ }
  return state;
}

/** Clear the halt. Logs a recovery entry only if we were actually halted. */
function clearHalt() {
  const prev = getHalt();
  if (!prev || !prev.halted) return null;
  const now = new Date().toISOString();
  const downMs = Date.parse(now) - Date.parse(prev.since || now);
  const detail = `was halted for ${Math.round(downMs / 60000)} min; ${prev.blockedRuns || 0} run(s) held back (their territories were NOT consumed)`;
  appendError({
    ts: now,
    context: 'pipeline_resumed',
    severity: 'info',
    error: `Pipeline resumed ${DASH} ${prev.reason} cleared`,
    detail,
  });
  fsx.safeUnlink(STATE_FILE);
  try {
    notify({
      severity: 'info',
      key: ALERT_KEY,
      text: `Pipeline resumed - ${prev.reason} cleared. ${detail}`,
      meta: { event: 'resumed', reason: prev.reason },
    });
  } catch (e) { /* alerting must never throw */ }
  return prev;
}

module.exports = { getHalt, setHalt, clearHalt, STATE_FILE, ERRORS_LOG };
