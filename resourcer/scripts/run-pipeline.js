#!/usr/bin/env node
'use strict';

// Deterministic pipeline orchestrator, called after Phase 1 (phase1.js) completes. Reads the phase1 status JSON and continues:
//   status phase1_complete + sources both (Phase 2 pending) -> Reed Phase 1 -> merge -> Phase 2 once -> optimiser
//   sources caterer (or Phase 2 already done)               -> nothing to run, results are located for the optimiser
// RESOURCER_SOURCES (caterer|reed|both, default caterer) gates Reed: when it excludes Reed the Reed step is skipped and
// Phase 2 runs once on the Caterer queue. The same happens while Reed is on hold (a human login is pending or running, or a recent
// auth failure needs time): the Reed step is skipped WITHOUT recording an auth failure, so the pending search keeps its Reed retries.
//
// Usage: node scripts/run-pipeline.js --status-file <path-to-phase1-status.json>
// Exit codes: 0 done (also PIPELINE_SKIPPED for a parallel run, and when Phase 2 itself failed: legacy), 1 no/unreadable status file or fatal,
// 14 Phase 2 was HELD (CV screening could not run, nothing was lost, the queue is retried once the screening halt clears): there is no results
// file for this run, the optimiser is not run and the caller records the run as held, not as done.
// Stdout: PIPELINE_COMPLETE / SOURCES: / QUEUE_FILE: / RESULTS_FILE: / CREDITS: / VERDICT: (child output is echoed to stderr); PIPELINE_HELD instead of PIPELINE_COMPLETE when held.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./lib/paths');
const env = require('./lib/env');
const fsx = require('./lib/fsx');
const { AUTH_MARKER, sourcesGate, syncGateStatus, authHold } = require('./reed-api-client');
const launcher = require('./ensure-chrome-cdp');
const activityLib = require('./lib/search-activity');
const { PHASE2_HELD, PHASE2_HELD_EXIT } = require('./lib/phase2-exit');

const RUNS_DIR = paths.RUNS;
const DOWNLOADS = paths.DOWNLOADS;
const SCRIPTS = paths.SCRIPTS;
const RUN_LOCK_MAX_AGE_MIN = 60;
const CAPTURE_CAP = 200 * 1024;

function log(msg) { console.error(`[pipeline] ${msg}`); }
function out(msg) { console.log(msg); }

function readJson(file) {
  return fsx.readJson(file, null);
}

// Runs a child, echoing its output to our stderr (prefixed) while capturing a capped copy.
function spawnCapture(cmd, args, tag, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: paths.HOME, stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, ...(extraEnv || {}) } });
    let stdout = '';
    let stderr = '';
    const feed = (which) => (d) => {
      const s = d.toString();
      process.stderr.write(s.split('\n').filter((l) => l.length).map((l) => `[${tag}] ${l}\n`).join(''));
      if (which === 'out') { stdout = (stdout + s).slice(-CAPTURE_CAP); } else { stderr = (stderr + s).slice(-CAPTURE_CAP); }
    };
    child.stdout.on('data', feed('out'));
    child.stderr.on('data', feed('err'));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
  });
}

function getTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function newestMatching(dir, test) {
  try {
    const files = fs.readdirSync(dir)
      .filter(test)
      .map((f) => ({ p: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return files[0] ? files[0].p : null;
  } catch {
    return null;
  }
}

const findPhase2Results = () => newestMatching(DOWNLOADS, (f) => f.startsWith('phase2-results-') && f.endsWith('.json'));
const findPhase1StatusFile = () => newestMatching(RUNS_DIR, (f) => f.startsWith('phase1-') && f.endsWith('.json'));

function parseArgs(argv) {
  const i = argv.indexOf('--status-file');
  return { statusFile: i >= 0 && i + 1 < argv.length ? argv[i + 1] : null, help: argv.includes('--help') || argv.includes('-h') };
}

// RESOURCER_SOURCES gate. Anything that is not caterer|reed|both is treated as caterer.
function reedEnabled() {
  const g = sourcesGate();
  if (!g.valid) log(`WARN: RESOURCER_SOURCES='${g.raw}' is not caterer|reed|both - treating as caterer`);
  return g.reedEnabled;
}

// ---------------------------------------------------------------- the window and the CV limit of the request

// What the request or territory asked for, as phase 1 recorded it in its status file (the `activity` block). A status without it (an older run,
// a test) means the stored defaults: 1 month and 20, which give the same Reed arguments this script always passed.
function requestedWindow(status) {
  const a = status && status.activity && typeof status.activity === 'object' ? status.activity : {};
  return { activeWithin: a.requestedActiveWithin, cvLimit: a.requestedCvLimit };
}

// The `activity` block that goes into the merged queue: Caterer's (from its queue, else the status file) plus what Reed was given.
function activityBlock(status, queueFile, reedPlan) {
  const q = queueFile && fs.existsSync(queueFile) ? readJson(queueFile) : null;
  const base = (q && q.activity && typeof q.activity === 'object' && q.activity) || (status && status.activity) || null;
  if (!base && !reedPlan) return null;
  return { ...(base || {}), ...(reedPlan ? { reed: reedPlan } : {}) };
}

// ---------------------------------------------------------------- Reed Phase 1

async function runReedPhase1(opts, extraEnv) {
  log('=== Reed Phase 1 ===');
  // The window and the CV limit of the request or territory (docs/ACTIVITY.md); the stored defaults give the values this call always had.
  const win = opts.window || activityLib.reedWindowFor(null);
  const cvLimit = activityLib.reedCvLimitFor(opts.cvLimit);
  const args = [
    path.join(SCRIPTS, 'reed-phase1.js'),
    '--job-title', opts.jobTitle || '',
    '--location', opts.location || '',
    '--distance', String(opts.distance || 20),
    '--active-within', win.arg,
    '--cv-limit', String(cvLimit),
  ];
  if (opts.queueFile) args.push('--caterer-queue', opts.queueFile);

  // Clear any stale auth-failed marker so a fresh failure can be detected.
  fsx.safeUnlink(AUTH_MARKER);

  const { code, stdout, stderr } = await spawnCapture(paths.NODE, args, 'reed', extraEnv);
  log(`Reed Phase 1 exit: ${code}`);

  if (code !== 0) {
    const tail = (s) => (s || '').trim().split('\n').slice(-25).join('\n');
    log(`Reed Phase 1 FAILED - diagnostic output:\n--- reed stdout (tail) ---\n${tail(stdout)}\n--- reed stderr (tail) ---\n${tail(stderr)}\n--- end reed output ---`);
  }

  // Auth failure via marker file (reliable) or, on a non-zero exit, signatures in the output (2026-06-17: a 401 reports on stderr).
  let authFailure = null;
  const reedOut = `${stdout || ''}\n${stderr || ''}`;
  if (fs.existsSync(AUTH_MARKER)) {
    authFailure = readJson(AUTH_MARKER) || { reason: 'marker_unreadable' };
  } else if (code !== 0 && /REED_AUTH_FAILED|REED_RELOGIN_NEEDED|REED_BROWSER_BUSY|HTTP 401|HTTP 451|No refresh token available/i.test(reedOut)) {
    authFailure = { reason: 'reed_401_or_relogin', failedAt: new Date().toISOString() };
  }
  if (authFailure) log(`!! Reed AUTH FAILED - reason=${authFailure.reason}. Reed stats will show the failure in the results.`);

  // A Reed attempt that could not search is a FAILURE (reed_status failed, errors 1), never an empty search (docs/parity/reed-first-page.md).
  // Marker REED_FIRST_PAGE_FAILED (reed-phase1.js) names the first-page case; any other non-zero exit that left no queue and no auth failure is the generic case.
  let failure = null;
  if (!authFailure) {
    const fp = /REED_FIRST_PAGE_FAILED:[ \t]*([^\n]*)/.exec(reedOut);
    if (fp) failure = { kind: 'first_page', reason: fp[1].replace(/\s+attempts=.*$/, '').trim().slice(0, 80) || 'unknown', failedAt: new Date().toISOString() };
  }

  let reedQueue = null;
  const sm = stdout.match(/REED_PHASE1_SUMMARY:(\{.*\})/);
  if (sm) {
    try { reedQueue = JSON.parse(sm[1]).queuePath || null; } catch { reedQueue = null; }
  }
  if (!reedQueue) {
    const match = stdout.match(/reed-approved-queue-([^.]+)\.json/);
    if (match) reedQueue = path.join(DOWNLOADS, `reed-approved-queue-${match[1]}.json`);
  }
  if (!failure && !authFailure && code !== 0 && !reedQueue) failure = { kind: 'phase1_exit', reason: `exit ${code}`, failedAt: new Date().toISOString() };
  // reed-phase1.js lowers the limit to the profile views left today and says so; the run record states the limit that was really used.
  const lowered = /CV limit lowered from ([0-9]+) to ([0-9]+)/.exec(reedOut);
  return { code, reedQueue, authFailure, failure, cvLimitEffective: lowered ? Number(lowered[2]) : cvLimit };
}

// ---------------------------------------------------------------- queue merge

async function mergeQueues(catererQueueFile, reedQueueFile, activity) {
  const ts = getTimestamp();
  const mergedFile = path.join(DOWNLOADS, `merged-queue-${ts}.json`);
  const empty = { candidates: [], searchDate: new Date().toISOString().slice(0, 10) };

  const caterer = (catererQueueFile && fs.existsSync(catererQueueFile)) ? (readJson(catererQueueFile) || empty) : empty;
  const reed = (reedQueueFile && fs.existsSync(reedQueueFile)) ? (readJson(reedQueueFile) || empty) : empty;

  const real = (m) => (m && m !== 'unknown' ? m : null);
  const merged = {
    searchDate: caterer.searchDate || reed.searchDate || new Date().toISOString().slice(0, 10),
    jobTitle: caterer.jobTitle || reed.jobTitle || '',
    location: caterer.location || reed.location || '',
    distance: caterer.distance || reed.distance || 20,
    activeWithin: caterer.activeWithin || reed.activeWithin || 'month',
    sources: 'both',
    // Prefer a real model name over 'unknown' (Caterer writes 'unknown' when no batch ran)
    screeningModel: real(caterer.screeningModel) || real(reed.screeningModel) || caterer.screeningModel || reed.screeningModel || 'unknown',
    creditsRemaining: caterer.creditsRemaining || reed.creditsRemaining || null,
    phase1StartedAt: caterer.phase1StartedAt || reed.phase1StartedAt || null,
    requestedAt: caterer.requestedAt || reed.requestedAt || null,
    candidateCount: (caterer.candidateCount || 0) + (reed.candidateCount || 0),
    phase1Stats: { caterer: caterer.phase1Stats || {}, reed: reed.phase1Stats || {} },
    candidates: [...(caterer.candidates || []), ...(reed.candidates || [])],
    // what was asked, sent and applied for the search window, with the Reed half (docs/ACTIVITY.md); absent for a caller that has none
    ...(activity ? { activity } : {}),
  };

  fsx.writeJsonAtomic(mergedFile, merged, 0o600);
  log(`Merged queue: ${mergedFile} (${merged.candidates.length} candidates)`);
  return mergedFile;
}

// ---------------------------------------------------------------- Phase 2

async function runPhase2(queueFile, extraEnv) {
  if (!queueFile || !fs.existsSync(queueFile)) {
    log('No queue file - Phase 2 skipped');
    return { code: 0, resultsFile: null };
  }
  log(`=== Phase 2: ${queueFile} ===`);
  const { code } = await spawnCapture(paths.NODE, [path.join(SCRIPTS, 'process-approved-queue.js'), queueFile], 'phase2', extraEnv);
  // A held Phase 2 (exit 2) wrote no results: the newest results file on disk belongs to an OLDER run and must not be taken for this one
  // (it would print the wrong RESULTS_FILE and feed the optimiser a duplicate entry).
  const held = code === PHASE2_HELD;
  const resultsFile = held ? null : findPhase2Results();
  log(`Phase 2 exit: ${code}${held ? ' (HELD: CV screening could not run, nothing was lost)' : ''}, results: ${resultsFile || 'none'}`);
  return { code, resultsFile, held };
}

// PRIMARY: match by timestamp in the filename (phase1-<ts>.json -> approved-queue-<ts>.json); the mtime fallback only applies
// when there is no status file or no name match (2026-05-15: an mtime match picked a sibling territory's queue).
function findApprovedQueue(statusFile) {
  try {
    if (statusFile) {
      const m = path.basename(statusFile, '.json').match(/^phase1-(.+)$/);
      if (m) {
        const direct = path.join(DOWNLOADS, `approved-queue-${m[1]}.json`);
        if (fs.existsSync(direct)) return direct;
      }
    }
    return newestMatching(DOWNLOADS, (f) => f.startsWith('approved-queue-') && f.endsWith('.json'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- optimiser

async function runOptimiser(resultsFile) {
  if (!resultsFile || !fs.existsSync(resultsFile)) {
    log('No results - optimiser skipped');
    return null;
  }
  log('Running optimiser...');
  const { stdout } = await spawnCapture(paths.NODE, [path.join(SCRIPTS, 'pipeline-optimiser.js'), resultsFile], 'optimiser');
  try {
    const result = JSON.parse(stdout);
    log(`Verdict: ${result.verdict}`);
    if (result.observations) result.observations.forEach((o) => log(`  ${o}`));
    return result;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- per-status-file run lock (parallel-invocation guard)

// 2026-05-14 (NG10): two invocations on the same status file raced through Reed -> merge -> Phase 2 -> Zoho POST and created
// duplicate records. The lock is created exclusively; a holder that is dead or older than 60 min is taken over.
function acquireRunLock(statusFile) {
  const lockPath = `${statusFile}.run-lock`;
  const now = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o644);
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: now, statusFile }, null, 2)); } finally { fs.closeSync(fd); }
      return { acquired: true, lockPath };
    } catch (e) {
      if (e.code !== 'EEXIST') return { acquired: false, error: e.message };
    }
    const lock = readJson(lockPath);
    if (lock) {
      const ageMin = (now - (lock.startedAt || 0)) / 60000;
      const alive = !!lock.pid && fsx.pidAlive(lock.pid);
      if (ageMin < RUN_LOCK_MAX_AGE_MIN && alive) return { acquired: false, holderPid: lock.pid, holderAgeMin: ageMin };
      log(`Stale run-lock (pid=${lock.pid} age=${ageMin.toFixed(1)}m alive=${alive}) - taking over`);
    } else {
      log('run-lock unreadable - taking over');
    }
    fsx.safeUnlink(lockPath);
  }
  return { acquired: false, error: 'could not take over the run-lock' };
}

function releaseRunLock(lockPath) {
  fsx.safeUnlink(lockPath);
}

// ---------------------------------------------------------------- main

const USAGE = 'Usage: node scripts/run-pipeline.js --status-file <path-to-phase1-status.json>\nGate: RESOURCER_SOURCES=caterer|reed|both (default caterer).\nExit codes: 0 done, 1 no/unreadable status file or fatal.';

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { out(USAGE); return 0; }

  // The dashboard's Reed indicator says 'disabled' whenever the gate excludes Reed, whatever this run does next.
  try { syncGateStatus(); } catch (e) { log(`WARN: could not sync runtime/reed-status.json: ${e.message}`); }

  const statusFile = opts.statusFile || findPhase1StatusFile();
  if (!statusFile || !fs.existsSync(statusFile)) {
    console.error('FATAL: No phase1 status file found');
    return 1;
  }

  const lockResult = acquireRunLock(statusFile);
  if (!lockResult.acquired) {
    log(`ABORT: Another run-pipeline.js (pid=${lockResult.holderPid}) is already processing this status file (age=${lockResult.holderAgeMin ? lockResult.holderAgeMin.toFixed(1) : '?'}m). Skipping to prevent Zoho duplicates.`);
    out(`PIPELINE_SKIPPED: parallel run in progress (pid=${lockResult.holderPid})`);
    return 0;
  }
  let browserLock = null;
  let ownsBrowser = false;
  // The browser side is released as soon as Phase 2 has downloaded the Reed CVs; the run-lock is held until exit (legacy).
  // Order matters: the browser is quit (through CDP, so the login survives) BEFORE the browser lock is given up.
  const keepBrowser = () => env.get('REED_KEEP_CHROME', '0') === '1';
  const stopBrowser = async () => {
    if (ownsBrowser) {
      ownsBrowser = false;
      if (!keepBrowser()) {
        try { await launcher.stopChromeGraceful(); } catch (e) { log(`WARN: could not stop the Reed browser: ${e.message}`); }
      }
    }
    if (browserLock) { browserLock.release(); browserLock = null; }
  };
  const cleanupSync = () => {
    if (ownsBrowser) {
      ownsBrowser = false;
      if (!keepBrowser()) {
        try { launcher.stopChrome(); } catch (e) { log(`WARN: could not stop the Reed browser: ${e.message}`); }
      }
    }
    if (browserLock) { browserLock.release(); browserLock = null; }
    releaseRunLock(lockResult.lockPath);
  };
  process.on('exit', cleanupSync);
  process.on('SIGINT', () => { stopBrowser().finally(() => { cleanupSync(); process.exit(130); }); });
  process.on('SIGTERM', () => { stopBrowser().finally(() => { cleanupSync(); process.exit(143); }); });

  try {
    log(`Reading status: ${statusFile}`);
    const status = readJson(statusFile);
    if (!status) {
      console.error('FATAL: Could not parse status file');
      return 1;
    }
    log(`Status: ${status.status}, sources: ${status.sources}`);
    log(`Pool: ${status.pool}, approved: ${status.approved}, errors: ${status.errors}`);

    // phase2Status (set by phase1): 'done' = Phase 2 already ran inline, 'pending' = deferred until Reed has run;
    // absent = decide from sources (both -> run Reed + Phase 2, otherwise assume Phase 2 ran inline).
    const p2status = status.phase2Status;
    const src = status.sources || 'caterer';
    const needsReed = src === 'both' && p2status !== 'done';
    const phase2AlreadyDone = p2status === 'done' || src !== 'both';

    const queueFile = findApprovedQueue(statusFile);
    log(`Queue file: ${queueFile || 'none'}`);

    let finalQueueFile = queueFile;
    let resultsFile = null;
    let held = false;

    if (needsReed) {
      let childEnv = {};
      let reedQueuePath = null;
      let reedAuthFailure = null;
      let reedFailure = null;
      let reedSkippedByConfig = false;
      let reedHold = null;
      let reedWindow = null;
      let reedCvLimit = null;
      let reedActivity = null;

      if (!reedEnabled()) {
        reedSkippedByConfig = true;
        log(`REED_DISABLED: RESOURCER_SOURCES=${env.get('RESOURCER_SOURCES', 'caterer')} excludes Reed - Reed step skipped, Phase 2 runs on the Caterer queue`);
      } else if ((reedHold = authHold())) {
        log(`REED_HELD: ${reedHold.reason} (${reedHold.detail}) - Reed step skipped, its retries are not spent, Phase 2 runs on the Caterer queue`);
      } else {
        log('Sources = both - running Reed Phase 1...');
        const asked = requestedWindow(status);
        reedWindow = activityLib.reedWindowFor(asked.activeWithin);
        reedCvLimit = activityLib.reedCvLimitFor(asked.cvLimit);
        reedActivity = { activeWithin: reedWindow.arg, requestedActiveWithin: reedWindow.requested, cvLimit: reedCvLimit, cvLimitRequested: reedCvLimit, ran: false, ...(reedWindow.note ? { note: reedWindow.note } : {}) };
        log(`REED_ACTIVITY requested="${reedWindow.requested}" sent="${reedWindow.arg}" cvLimit=${reedCvLimit}`);
        if (reedWindow.warn) log(`WARN: ${reedWindow.note}`);
        const waitSec = Number(env.get('REED_LOCK_WAIT_SEC', '300'));
        const waitMs = (Number.isFinite(waitSec) && waitSec >= 0 ? waitSec : 300) * 1000;
        const lock = await launcher.browserLock.wait('reed', { purpose: 'run-pipeline', waitMs, pollMs: 5000 });
        if (!lock.acquired) {
          const h = lock.holder || {};
          reedAuthFailure = { reason: 'browser_lock_busy', failedAt: new Date().toISOString(), holder: h.owner ? `${h.owner}:${h.pid}` : null };
          log(`!! Reed SKIPPED: browser.lock held by ${h.owner || 'another process'} (pid ${h.pid || '?'}) after waiting ${Math.round(waitMs / 1000)}s`);
        } else {
          browserLock = lock;
          ownsBrowser = !lock.borrowed && !lock.reentrant;
          childEnv = { RESOURCER_BROWSER_LOCK_HOLDER_PID: String(lock.borrowed ? lock.holder.pid : process.pid) };
          try {
            const reedResult = await runReedPhase1({
              jobTitle: status.jobTitle, location: status.location, distance: status.distance, queueFile, window: reedWindow, cvLimit: reedCvLimit,
            }, childEnv);
            reedActivity = { ...reedActivity, cvLimit: reedResult.cvLimitEffective, ran: true };
            reedQueuePath = reedResult.reedQueue;
            reedAuthFailure = reedResult.authFailure;
            reedFailure = reedResult.failure;
          } catch (err) {
            log(`ERROR: Reed Phase 1 threw: ${err.message} - treating as auth/runtime failure`);
            reedAuthFailure = { reason: 'spawn_threw', error: (err.message || '').slice(0, 200), failedAt: new Date().toISOString() };
          }
        }
      }

      if (reedSkippedByConfig || reedHold) {
        finalQueueFile = queueFile;
      } else if (reedQueuePath && fs.existsSync(reedQueuePath)) {
        // Always merge, even if the Reed queue is empty: the merged file records that both sources were attempted.
        finalQueueFile = await mergeQueues(queueFile, reedQueuePath, activityBlock(status, queueFile, reedActivity));
      } else {
        if (reedAuthFailure) {
          log(`!! Reed SKIPPED due to auth failure (${reedAuthFailure.reason}) - merged queue will carry authFailed flag`);
        } else if (reedFailure && reedFailure.kind === 'first_page') {
          log(`!! REED_FIRST_PAGE_FAILED (${reedFailure.reason}) - recorded as a FAILED Reed attempt (reed_status failed, errors 1), not as an empty search; the Caterer half is unaffected and the territory keeps a Reed-pending mark`);
        } else if (reedFailure) {
          log(`WARNING: Reed produced no queue (${reedFailure.reason}) - recorded as a FAILED Reed attempt (reed_status failed, errors 1), not as an empty search`);
        } else {
          log('WARNING: Reed produced no queue - merging with empty Reed to record both-source attempt');
        }
        // The placeholder makes the merged queue report sources='both'; phase1Stats.authFailed lets Phase 2 keep the pending
        // search for a Reed retry (Reed must never be silently skipped).
        const placeholderReed = path.join(DOWNLOADS, `reed-empty-${getTimestamp()}.json`);
        fsx.writeJsonAtomic(placeholderReed, {
          searchDate: new Date().toISOString().slice(0, 10),
          jobTitle: status.jobTitle,
          location: status.location,
          source: 'reed',
          candidates: [],
          phase1Stats: {
            pool: 0, pagesScraped: 0, inDb: 0, crossDedup: 0, rejected: 0, approved: 0,
            authFailed: !!reedAuthFailure,
            authFailureReason: (reedAuthFailure && reedAuthFailure.reason) || null,
            authFailedAt: (reedAuthFailure && reedAuthFailure.failedAt) || null,
            ...(reedFailure && !reedAuthFailure ? {
              failed: true, failureKind: reedFailure.kind, failureReason: reedFailure.reason, failedAt: reedFailure.failedAt, errors: 1,
            } : {}),
          },
        }, 0o600);
        finalQueueFile = await mergeQueues(queueFile, placeholderReed, activityBlock(status, queueFile, reedActivity));
      }

      // Phase 2 ALWAYS runs once on the final queue, even with 0 candidates (territory map update, pending-search cleanup).
      const phase2Result = await runPhase2(finalQueueFile, childEnv);
      resultsFile = phase2Result.resultsFile;
      held = !!phase2Result.held;

      // Mark phase2Status done so a second invocation is a no-op; a held Phase 2 is not done: its queue is retried by the recovery.
      const fresh = readJson(statusFile);
      if (fresh && !held) {
        fresh.phase2Status = 'done';
        fresh.updatedAt = new Date().toISOString();
        try { fsx.writeJsonAtomic(statusFile, fresh); } catch { /* best effort */ }
      }
    } else if (phase2AlreadyDone || !needsReed) {
      // A Phase 2 that ran inline and was HELD (process-approved-queue.js left phase2Hold in the status file and did not complete it)
      // has no results of its own: the newest results file on disk is an older run's.
      held = !!(status.phase2Hold && status.status !== 'complete' && !status.phase2Complete);
      log(held ? 'Single-source run - Phase 2 was held (CV screening could not run); no results for this run' : (phase2AlreadyDone ? 'Single-source run - Phase 2 already completed inline' : 'WARNING: No clear phase2 signal - assuming Phase 2 ran inline'));
      resultsFile = held ? null : findPhase2Results();
    }

    await stopBrowser();

    const optimiserResult = await runOptimiser(resultsFile);

    log('========================================');
    log('Pipeline orchestration complete');
    log('========================================');

    out(held ? 'PIPELINE_HELD' : 'PIPELINE_COMPLETE');
    out(`SOURCES: ${status.sources || 'caterer'}`);
    out(`QUEUE_FILE: ${finalQueueFile || ''}`);
    out(`RESULTS_FILE: ${resultsFile || ''}`);
    out(`CREDITS: ${status.credits || ''}`);
    out(`VERDICT: ${(optimiserResult && optimiserResult.verdict) || 'unknown'}`);

    if (optimiserResult && (optimiserResult.verdict === 'ATTENTION' || optimiserResult.verdict === 'DEGRADED')) {
      out(`WARNING: PERFORMANCE ${optimiserResult.verdict}`);
      (optimiserResult.regressions || []).forEach((r) => {
        out(`  ${r.metric}: ${r.current} vs baseline ${r.baseline} (${r.change})`);
      });
    }
    return held ? PHASE2_HELD_EXIT : 0;
  } finally {
    cleanupSync();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    console.error(`FATAL: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { main, acquireRunLock, releaseRunLock, findApprovedQueue, mergeQueues, reedEnabled, parseArgs, requestedWindow, activityBlock, runReedPhase1 };
