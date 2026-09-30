#!/usr/bin/env node
/**
 * pipeline-optimiser.js  -  Chefs Bay Resourcer APM
 *
 * Monitors scraper performance from login -> Zoho push. Entirely timing &
 * reliability focused. Does NOT care about CV yield - that's a business metric,
 * not a bot health metric.
 *
 * What it monitors:
 *   * Total wall-clock time (search submitted -> data in Zoho)
 *   * Per-phase timing: session validation, Phase 1 scraping, handoff, Phase 2 downloads, Zoho push
 *   * Browser round-trip efficiency (time per page, time per roundtrip)
 *   * CV download performance (avg, min, max per file)
 *   * Zoho push performance (avg, min, max per candidate)
 *   * Error breakdown by phase and type
 *   * Session health (was re-login needed?)
 *   * Regressions vs per-territory rolling average AND global rolling average
 *
 * Output: JSON { metrics, bottleneck, regressions, errorSummary, observations, verdict }
 * Side-effect: appends entry to logs/pipeline-performance.jsonl (no other writes, no messaging)
 *
 * Verdict:
 *   NOMINAL   - clean run, within expected norms
 *   ATTENTION - single issue: moderate regression OR non-fatal errors
 *   DEGRADED  - multiple issues OR severe regression (>60%) OR fatal errors
 *
 * Usage:
 *   node scripts/pipeline-optimiser.js <path-to-phase2-results.json>
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const paths = require('./lib/paths');
const fsx = require('./lib/fsx');

const LOGS_DIR = paths.LOGS;

const PERF_LOG   = path.join(LOGS_DIR, 'pipeline-performance.jsonl');
const ERRORS_LOG = path.join(LOGS_DIR, 'errors.jsonl');

// Rolling window for baseline comparisons
const GLOBAL_WINDOW    = 15;  // last N runs, any territory
const TERRITORY_WINDOW = 5;   // last N runs for same territory

// Regression thresholds (% over baseline avg -> trigger flag)
const THRESHOLDS = {
  totalWallClock:    { attention: 35, degraded: 65 },
  phase1Scraping:    { attention: 35, degraded: 65 },
  phase2Total:       { attention: 40, degraded: 80 },
  cvDownloadAvg:     { attention: 50, degraded: 100 },
  zohoPushAvg:       { attention: 50, degraded: 100 },
  browserRoundtrip:  { attention: 40, degraded: 80 },
};

// -- History --------------------------------------------------------------------

function loadHistory() {
  if (!fs.existsSync(PERF_LOG)) return [];
  const buf = fs.readFileSync(PERF_LOG);
  const raw = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF
    ? buf.toString('utf8', 3) : buf.toString('utf8');
  return raw.split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function recentErrors(runStartedAt, runCompletedAt) {
  // Read errors from this run only (by timestamp)
  if (!fs.existsSync(ERRORS_LOG)) return [];
  const buf = fs.readFileSync(ERRORS_LOG);
  const raw = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF
    ? buf.toString('utf8', 3) : buf.toString('utf8');
  const start = runStartedAt ? new Date(runStartedAt).getTime() : 0;
  const end   = runCompletedAt ? new Date(runCompletedAt).getTime() : Date.now();
  return raw.split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(e => {
      if (!e) return false;
      const t = e.ts ? new Date(e.ts).getTime() : 0;
      return t >= start - 5000 && t <= end + 5000;
    });
}

function avg(arr) {
  const vals = arr.filter(v => v != null && !isNaN(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function pctOver(current, baseline) {
  if (baseline == null || baseline === 0 || current == null) return null;
  return Math.round(((current - baseline) / baseline) * 100);
}

function fmtSecs(s) {
  if (s == null) return '\u{2014}';
  if (s >= 60) return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
  return `${s}s`;
}

function fieldAvg(history, field) {
  return avg(history.map(h => {
    const parts = field.split('.');
    let v = h;
    for (const p of parts) v = v?.[p];
    return v;
  }));
}

// -- Metric extraction ----------------------------------------------------------

function extractMetrics(results) {
  const p1 = results.phase1 || {};
  const t  = results.timing || {};

  return {
    // Identity
    runId:        results.runId       || null,
    date:         results.date        || new Date().toISOString().slice(0, 10),
    ts:           new Date().toISOString(),
    jobTitle:     results.jobTitle    || '',
    location:     results.location    || '',
    distance:     results.distance    ?? null,

    // -- Timing (all in seconds) --------------------------------------------
    timing: {
      // Wall-clock from search submitted to last candidate in Zoho
      totalWallClockSecs:    t.totalWallClockSecs           ?? results.totalRuntimeSecs ?? null,
      // Phase 1
      sessionValidationSecs: t.sessionValidationSecs        ?? null,
      phase1ScrapingSecs:    t.phase1ScrapingSecs            ?? null,
      avgTimePerPageSecs:    t.avgTimePerPageSecs            ?? null,
      avgBrowserRoundtripSecs: t.avgTimePerBrowserRoundtripSecs ?? null,
      pageTimings:           t.pageTimings                   ?? null,
      // Handoff (queue file written -> Phase 2 started)
      handoffSecs:           t.handoffSecs                   ?? null,
      // Phase 2
      phase2TotalSecs:       t.phase2TotalSecs               ?? results.runtimeSecs ?? null,
      phase2DownloadStepSecs: t.phase2DownloadStepSecs       ?? null,
      phase2PushStepSecs:    t.phase2PushStepSecs            ?? null,
      // Per-operation averages
      avgCvDownloadSecs:     t.cvDownload?.avgSecs           ?? null,
      minCvDownloadSecs:     t.cvDownload?.minSecs           ?? null,
      maxCvDownloadSecs:     t.cvDownload?.maxSecs           ?? null,
      avgZohoPushSecs:       t.zohoPush?.avgSecs             ?? null,
      minZohoPushSecs:       t.zohoPush?.minSecs             ?? null,
      maxZohoPushSecs:       t.zohoPush?.maxSecs             ?? null,
    },

    // -- Phase 1 pipeline stats ---------------------------------------------
    phase1: {
      catererPool:       p1.candidateCount ?? results.candidateCount ?? null,
      pagesScraped:      p1.pagesScraped     ?? null,
      browserRoundtrips: p1.browserRoundtrips ?? null,
      approved:          p1.approved          ?? null,
      skippedDb:         p1.skippedDb         ?? null,
      skippedReview:     p1.skippedReview     ?? null,
      unlockErrors:      p1.errors            ?? 0,
      sessionRefreshed:  p1.sessionRefreshed  ?? false,
    },

    // -- Phase 2 pipeline stats ---------------------------------------------
    phase2: {
      candidatesQueued: results.total        ?? null,
      downloaded:       results.downloaded   ?? null,
      newToZoho:        results.new          ?? results.newToZoho ?? null,
      duplicates:       results.duplicates   ?? null,
      skipped:          results.skipped      ?? null,
      errors:           results.errors       ?? 0,
    },

    // Credits
    creditsRemaining: results.creditsRemaining ?? null,
  };
}

// -- Analysis engine ------------------------------------------------------------

function analyse(current, allHistory, runErrors) {
  const regressions  = [];  // Performance regressions vs baseline
  const errorSummary = [];  // Error breakdown
  const observations = [];  // Neutral / informational

  const t = current.timing;

  // -- Filter history ---------------------------------------------------------
  const territoryHistory = allHistory
    .filter(h =>
      h.jobTitle?.toLowerCase() === current.jobTitle?.toLowerCase() &&
      h.location?.toLowerCase() === current.location?.toLowerCase()
    )
    .slice(-TERRITORY_WINDOW);

  const globalHistory = allHistory.slice(-GLOBAL_WINDOW);

  const hasTerritoryHistory = territoryHistory.length >= 2;
  const hasGlobalHistory    = globalHistory.length    >= 3;

  // -- Helper: compare a metric against both territory and global baselines ---
  function checkRegression(label, fieldPath, thresholdKey, formatFn) {
    const curr = fieldPath.split('.').reduce((o, k) => o?.[k], current);
    if (curr == null) return;

    const fmt = formatFn || fmtSecs;

    if (hasTerritoryHistory) {
      const base = fieldAvg(territoryHistory, fieldPath);
      const diff = pctOver(curr, base);
      if (diff != null) {
        const th = THRESHOLDS[thresholdKey] || { attention: 35, degraded: 65 };
        const flag = diff >= th.degraded ? 'DEGRADED' : diff >= th.attention ? 'ATTENTION' : null;
        if (flag) {
          regressions.push({
            severity: flag,
            metric:   label,
            current:  fmt(curr),
            baseline: `${fmt(base)} territory avg (${territoryHistory.length} runs)`,
            pctOver:  diff,
          });
          return;
        } else if (diff < -15) {
          observations.push(`\u{26A1} ${label} improved: ${fmt(curr)} vs territory avg ${fmt(base)} (${diff}%)`);
          return;
        }
      }
    }

    if (hasGlobalHistory) {
      const base = fieldAvg(globalHistory, fieldPath);
      const diff = pctOver(curr, base);
      if (diff != null) {
        const th = THRESHOLDS[thresholdKey] || { attention: 35, degraded: 65 };
        const flag = diff >= th.degraded ? 'DEGRADED' : diff >= th.attention ? 'ATTENTION' : null;
        if (flag) {
          regressions.push({
            severity: flag,
            metric:   label,
            current:  fmt(curr),
            baseline: `${fmt(base)} global avg (${globalHistory.length} runs)`,
            pctOver:  diff,
          });
        }
      }
    }
  }

  // -- 1. Total wall-clock ---------------------------------------------------
  checkRegression('Total wall-clock', 'timing.totalWallClockSecs', 'totalWallClock');

  // -- 2. Phase 1 scraping time ----------------------------------------------
  checkRegression('Phase 1 scraping', 'timing.phase1ScrapingSecs', 'phase1Scraping');

  // -- 3. Phase 2 total time -------------------------------------------------
  checkRegression('Phase 2 total', 'timing.phase2TotalSecs', 'phase2Total');

  // -- 4. CV download avg ----------------------------------------------------
  checkRegression('CV download avg', 'timing.avgCvDownloadSecs', 'cvDownloadAvg');

  // -- 5. Zoho push avg ------------------------------------------------------
  checkRegression('Zoho push avg', 'timing.avgZohoPushSecs', 'zohoPushAvg');

  // -- 6. Browser roundtrip avg ----------------------------------------------
  checkRegression('Browser roundtrip avg', 'timing.avgBrowserRoundtripSecs', 'browserRoundtrip');

  // -- 7. Error analysis -----------------------------------------------------
  const totalP1Errors = current.phase1.unlockErrors || 0;
  const totalP2Errors = current.phase2.errors       || 0;

  if (runErrors.length > 0) {
    // Group by context
    const byCtx = {};
    for (const e of runErrors) {
      const k = e.context || 'unknown';
      byCtx[k] = (byCtx[k] || 0) + 1;
    }
    for (const [ctx, count] of Object.entries(byCtx)) {
      const label = { cv_download: 'CV download', zoho_push: 'Zoho push', cv_attach: 'CV attach', session: 'session' }[ctx] || ctx;
      errorSummary.push({ context: ctx, label, count });
    }
  }

  if (totalP1Errors > 0) {
    regressions.push({
      severity: 'ATTENTION',
      metric:   'Phase 1 unlock errors',
      current:  `${totalP1Errors} error(s)`,
      baseline: '0 (expected)',
      pctOver:  null,
    });
  }
  if (totalP2Errors > 0) {
    regressions.push({
      severity: 'ATTENTION',
      metric:   'Phase 2 Zoho push errors',
      current:  `${totalP2Errors} error(s)`,
      baseline: '0 (expected)',
      pctOver:  null,
    });
  }

  // -- 8. Session health -----------------------------------------------------
  if (current.phase1.sessionRefreshed) {
    observations.push('\u{1F504} Session refresh was needed \u{2014} caterer-session.json was stale at run start');
  }

  // -- 9. Reliability trend -------------------------------------------------
  // Tracks whether the system is getting more stable over time.
  // Key signals: error-free streak, session refresh frequency, error rate trend.
  {
    const recentN = globalHistory.slice(-10);
    if (recentN.length >= 3) {
      const totalRuns     = recentN.length;
      const errorFreeRuns = recentN.filter(h => (h.errorsP1 || 0) + (h.errorsP2 || 0) === 0).length;
      const reliabilityPct = Math.round((errorFreeRuns / totalRuns) * 100);
      const currentClean  = (current.phase1.unlockErrors + current.phase2.errors) === 0;

      // Count clean run streak (consecutive error-free runs ending with current)
      let streak = currentClean ? 1 : 0;
      for (let i = recentN.length - 1; i >= 0 && streak > 0; i--) {
        const h = recentN[i];
        if ((h.errorsP1 || 0) + (h.errorsP2 || 0) === 0) streak++;
        else break;
      }

      if (currentClean && streak >= 3) {
        observations.push(`\u{2705} Reliability streak: ${streak} consecutive error-free runs (${reliabilityPct}% error-free across last ${totalRuns} runs)`);
      } else if (!currentClean && reliabilityPct >= 80) {
        regressions.push({
          severity: 'ATTENTION',
          metric:   'Reliability regression',
          current:  'Errors this run',
          baseline: `${reliabilityPct}% error-free over last ${totalRuns} runs`,
          pctOver:  null,
        });
      } else {
        observations.push(`Reliability: ${reliabilityPct}% error-free (${errorFreeRuns}/${totalRuns} recent runs)${streak > 1 ? ` | ${streak}-run clean streak` : ''}`);
      }

      // Session refresh frequency trend
      const sessionRefreshRuns = recentN.filter(h => h.sessionRefreshed).length;
      if (sessionRefreshRuns > 0 && !current.phase1.sessionRefreshed) {
        const pct = Math.round((sessionRefreshRuns / totalRuns) * 100);
        if (sessionRefreshRuns <= 1) {
          observations.push(`\u{2705} Session health: no refresh needed this run (was required in ${sessionRefreshRuns}/${totalRuns} recent runs \u{2014} appears resolved)`);
        } else {
          observations.push(`\u{26A0}\u{FE0F} Session refresh: occurred in ${sessionRefreshRuns}/${totalRuns} recent runs (${pct}%) \u{2014} consider refreshing caterer-session.json proactively`);
        }
      }

      // Error type recurrence - for each error type seen historically, check if it's now gone
      const historicErrorContexts = new Set();
      for (const h of recentN) {
        if (h.errorContexts) h.errorContexts.forEach(c => historicErrorContexts.add(c));
      }
      const currentErrorContexts = new Set(runErrors.map(e => e.context || 'unknown'));
      for (const ctx of historicErrorContexts) {
        if (!currentErrorContexts.has(ctx)) {
          const label = { cv_download: 'CV download failures', zoho_push: 'Zoho push failures', cv_attach: 'CV attach failures', session: 'session errors' }[ctx] || `${ctx} errors`;
          observations.push(`\u{2705} ${label} \u{2014} absent this run (previously occurred in recent history \u{2014} may be resolved)`);
        }
      }
      for (const ctx of currentErrorContexts) {
        if (!historicErrorContexts.has(ctx)) {
          observations.push(`\u{1F195} New error type this run: ${ctx} \u{2014} not seen in recent history (potential new regression)`);
        }
      }
    }
  }

  // -- 10. Bottleneck identification -----------------------------------------
  let bottleneck = null;
  const phases = [
    { name: 'Session validation', secs: t.sessionValidationSecs },
    { name: 'Phase 1 scraping',   secs: t.phase1ScrapingSecs },
    { name: 'CV downloads',        secs: t.phase2DownloadStepSecs },
    { name: 'Zoho push',           secs: t.phase2PushStepSecs },
    { name: 'Handoff',             secs: t.handoffSecs },
  ].filter(p => p.secs != null);

  if (phases.length >= 2) {
    const total = phases.reduce((s, p) => s + p.secs, 0);
    const slowest = phases.reduce((a, b) => b.secs > a.secs ? b : a);
    const pct = Math.round((slowest.secs / total) * 100);
    if (pct >= 40) {
      bottleneck = { phase: slowest.name, secs: slowest.secs, pctOfTotal: pct };
    }
  }

  // -- 10. Timing narrative --------------------------------------------------
  if (t.totalWallClockSecs) {
    const parts = [];
    if (t.sessionValidationSecs) parts.push(`validate ${fmtSecs(t.sessionValidationSecs)}`);
    if (t.phase1ScrapingSecs)    parts.push(`scrape ${fmtSecs(t.phase1ScrapingSecs)}`);
    if (t.handoffSecs)           parts.push(`handoff ${fmtSecs(t.handoffSecs)}`);
    if (t.phase2TotalSecs)       parts.push(`phase2 ${fmtSecs(t.phase2TotalSecs)}`);
    observations.push(`\u{23F1} Total: ${fmtSecs(t.totalWallClockSecs)}${parts.length ? ' (' + parts.join(' \u{2192} ') + ')' : ''}`);
  }

  if (t.phase1ScrapingSecs && current.phase1.pagesScraped) {
    const rpt = current.phase1.browserRoundtrips;
    observations.push(
      `Phase 1: ${current.phase1.pagesScraped} pages in ${fmtSecs(t.phase1ScrapingSecs)}` +
      (t.avgTimePerPageSecs  ? ` (avg ${fmtSecs(t.avgTimePerPageSecs)}/page)` : '') +
      (rpt != null ? ` | ${rpt} browser roundtrips` : '') +
      (t.avgBrowserRoundtripSecs ? ` (avg ${fmtSecs(t.avgBrowserRoundtripSecs)}/trip)` : '')
    );
  }

  if (t.avgCvDownloadSecs) {
    const n = current.phase2.downloaded;
    observations.push(`CV downloads: ${n} files, avg ${fmtSecs(t.avgCvDownloadSecs)} (min ${fmtSecs(t.minCvDownloadSecs)} / max ${fmtSecs(t.maxCvDownloadSecs)})`);
  }

  if (t.avgZohoPushSecs) {
    const n = (current.phase2.newToZoho || 0) + (current.phase2.duplicates || 0);
    observations.push(`Zoho push: ${n} candidates, avg ${fmtSecs(t.avgZohoPushSecs)} (min ${fmtSecs(t.minZohoPushSecs)} / max ${fmtSecs(t.maxZohoPushSecs)})`);
  }

  if (!hasTerritoryHistory && !hasGlobalHistory) {
    observations.push(`Baseline run \u{2014} accumulating history for regression analysis (${allHistory.length + 1} runs so far)`);
  } else if (!hasTerritoryHistory) {
    observations.push(`First run for ${current.jobTitle} | ${current.location} \u{2014} no territory baseline yet (${territoryHistory.length} prior runs)`);
  }

  // -- Zero-yield guard (2026-09-01) ------------------------------------------
  // A run that saw candidates but approved NOBODY is not nominal. When the gateway's
  // claude-cli OAuth expired (2026-08-28..09-01) every screening call failed, so approved
  // was 0 on 216 consecutive runs -- yet each reported errors=0 / VERDICT: NOMINAL and even
  // "3 consecutive error-free runs", because the AI failure was never counted as an error.
  // Four days and ~6,600 candidates were lost before anyone noticed. Pool>0 with approved=0
  // AND rejected=0 means the reviewer returned nothing at all -> screening is down.
  {
    const pool     = current.phase1.catererPool ?? 0;
    const approved = current.phase1.approved ?? 0;
    const rejected = current.phase1.skippedReview ?? 0;
    const skipped  = current.phase1.skippedDb ?? 0;
    const reviewed = pool - skipped;          // candidates that actually reached the reviewer
    if (pool > 0 && reviewed > 0 && approved === 0 && rejected === 0) {
      regressions.push({
        severity: 'DEGRADED',
        metric:   'AI screening produced no verdicts',
        current:  `${reviewed} candidate(s) reviewed, 0 approved and 0 rejected`,
        baseline: 'expected at least one verdict',
        pctOver:  null,
      });
      observations.push(
        'ALERT: the reviewer returned no verdicts - screening is likely down (check ' +
        'the AI Gateway key or credits; see docs/OPERATIONS.md). Candidates were NOT screened.'
      );
    }
  }

  // -- Verdict ----------------------------------------------------------------
  const hasDegraded  = regressions.some(r => r.severity === 'DEGRADED');
  const hasAttention = regressions.some(r => r.severity === 'ATTENTION');
  const verdict = hasDegraded ? 'DEGRADED' : hasAttention ? 'ATTENTION' : 'NOMINAL';

  return { regressions, errorSummary, bottleneck, observations, verdict };
}

// -- Log entry -----------------------------------------------------------------

function buildLogEntry(current, runErrors) {
  // Flat log entry for trend analysis over time - rich timing data
  const t = current.timing;
  return {
    ts:                    current.ts,
    date:                  current.date,
    jobTitle:              current.jobTitle,
    location:              current.location,
    distance:              current.distance,
    // Timing
    totalWallClockSecs:    t.totalWallClockSecs,
    sessionValidationSecs: t.sessionValidationSecs,
    phase1ScrapingSecs:    t.phase1ScrapingSecs,
    handoffSecs:           t.handoffSecs,
    phase2TotalSecs:       t.phase2TotalSecs,
    phase2DownloadStepSecs: t.phase2DownloadStepSecs,
    phase2PushStepSecs:    t.phase2PushStepSecs,
    avgTimePerPageSecs:    t.avgTimePerPageSecs,
    avgBrowserRoundtripSecs: t.avgBrowserRoundtripSecs,
    avgCvDownloadSecs:     t.avgCvDownloadSecs,
    avgZohoPushSecs:       t.avgZohoPushSecs,
    // Phase 1 stats
    catererPool:           current.phase1.catererPool,
    pagesScraped:          current.phase1.pagesScraped,
    browserRoundtrips:     current.phase1.browserRoundtrips,
    approvedP1:            current.phase1.approved,
    skippedDb:             current.phase1.skippedDb,
    errorsP1:              current.phase1.unlockErrors,
    sessionRefreshed:      current.phase1.sessionRefreshed,
    // Phase 2 stats
    downloaded:            current.phase2.downloaded,
    newToZoho:             current.phase2.newToZoho,
    duplicates:            current.phase2.duplicates,
    errorsP2:              current.phase2.errors,
    creditsRemaining:      current.creditsRemaining,
    // Error context tracking - enables "fix confirmed" detection in future runs
    errorContexts: runErrors ? [...new Set(runErrors.map(e => e.context || 'unknown'))] : [],
  };
}

// -- Main -----------------------------------------------------------------------

function main(argv) {
  const resultsPath = argv[0];
  if (resultsPath === '--help' || resultsPath === '-h') {
    console.log('Usage: node pipeline-optimiser.js <phase2-results.json>\nPrints a JSON analysis (metrics, regressions, verdict) and appends one line to logs/pipeline-performance.jsonl.');
    return 0;
  }
  if (!resultsPath) {
    console.error('Usage: node pipeline-optimiser.js <phase2-results.json>');
    return 1;
  }
  if (!fs.existsSync(resultsPath)) {
    console.error(`File not found: ${resultsPath}`);
    return 1;
  }

  const buf     = fs.readFileSync(resultsPath);
  const rawJson = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF ? buf.toString('utf8', 3) : buf.toString('utf8');
  const results = JSON.parse(rawJson);

  const allHistory = loadHistory();
  const current    = extractMetrics(results);
  const runErrors  = recentErrors(results.requestedAt || results.phase1StartedAt, results.completedAt);
  const { regressions, errorSummary, bottleneck, observations, verdict } = analyse(current, allHistory, runErrors);

  // Append to performance log
  fsx.appendLine(PERF_LOG, JSON.stringify(buildLogEntry(current, runErrors)));

  // Structured output for callers (run-pipeline reads it from stdout)
  console.log(JSON.stringify({ metrics: current, regressions, errorSummary, bottleneck, observations, verdict }, null, 2));
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, extractMetrics, analyse, buildLogEntry, loadHistory, recentErrors, fmtSecs, PERF_LOG, ERRORS_LOG };
