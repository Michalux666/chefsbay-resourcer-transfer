#!/usr/bin/env node
'use strict';
/**
 * watchdog-runner.js - runs ONE pipeline territory with no model in the loop.
 *
 * Steps (legacy order, plus the browser lock): pending-gate -> claim -> stop idle Reed browser -> browser.lock
 * (owner caterer) -> create-init-status -> params file -> Caterer session check -> phase1.js -> outcome. The runner is started by the
 * watchdog tick as a detached process (output in logs/), registers itself exclusively in
 * runtime/run.json (the liveness record the tick adopts), and writes runtime/last-run.json when
 * it finishes so the tick can apply the exit-code policy even if it was restarted meanwhile.
 *
 * Usage:
 *   node scripts/watchdog-runner.js --from-gate           pick the oldest READY territory
 *   node scripts/watchdog-runner.js --pending <file.json> run one specific pending file
 *   node scripts/watchdog-runner.js --from-gate --dry-run show what WOULD run, spawn nothing
 *
 * Exit codes (unchanged from the legacy runner):
 *   0   run completed (phase1 reached a terminal status)
 *   10  no work, gate not READY, another pipeline process is live, or another browser run holds browser.lock
 *   11  Caterer session stale, safe-list blocked or CV Database module failing (phase1 exit 2, or the pre-run session check)
 *   12  phase1 exited non-zero for another reason (params/url/territory/lock/fatal)
 *   13  phase1 exceeded the 70-minute ceiling and was killed
 *   1   runner-level error (gate/init/spawn failure) before or around the run
 */
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const paths = require('./lib/paths');
const env = require('./lib/env');
const fsx = require('./lib/fsx');
const tick = require('./lib/tick');
const gate = require('./pending-gate');

const EXIT = { OK: 0, NO_WORK: 10, SESSION_STALE: 11, PHASE1_FAILED: 12, KILLED: 13, ERROR: 1 };
// Outer bound for one run: phase1's own watchdog is shorter, so hitting this means it is wedged.
const MAX_RUN_MS = 70 * 60 * 1000;
const SETTLE_MS = 5000;
const HEARTBEAT_MS = 10000;
const SESSION_STEP_MAX_MS = 15 * 60 * 1000;
// The phase1 timer may fire this early in active time (a monotonic clock that jumped) before it is re-armed.
const TIMER_SLACK_MS = 250;
const BROWSER_LOCK_WAIT_MS = 30000;
const STOP_IDLE_TIMEOUT_MS = 60000;
// Process names of a pipeline run; used only by the optional --scan diagnostics, never for liveness.
const PIPELINE_PROC_RE = 'phase1[.]js|run-pipeline|reed-phase1|process-approved-queue|ai-review';

const USAGE = [
  'Usage: node scripts/watchdog-runner.js [--from-gate | --pending <file>] [--dry-run] [--help]',
  'Runs one pipeline territory. Exit: 0 done, 10 no work/busy, 11 session stale, 12 phase1 failed, 13 killed at 70 min, 1 runner error.',
].join('\n');

function argFlag(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

// Children learn who holds browser.lock, so a Reed step started from phase1 borrows it instead of blocking on it.
function childEnv(ctx) {
  const e = Object.assign({}, process.env, { RESOURCER_HOME: ctx.home });
  if (ctx.browserLockPid) e.RESOURCER_BROWSER_LOCK_HOLDER_PID = String(ctx.browserLockPid);
  return e;
}

function execNode(ctx, script, args, opts) {
  const o = Object.assign({ timeoutMs: 30000 }, opts);
  return new Promise((resolve) => {
    execFile(ctx.node, [path.join(ctx.dirs.scripts, script)].concat(args || []), {
      cwd: ctx.home,
      timeout: o.timeoutMs,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: childEnv(ctx),
    }, (err, stdout, stderr) => {
      let code = 0;
      if (err) code = typeof err.code === 'number' ? err.code : (err.killed ? 'timeout' : 'spawn-error');
      resolve({ code, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(), error: err ? err.message : null });
    });
  });
}

async function mustRun(ctx, script, args, timeoutMs) {
  const r = await ctx.exec(script, args, { timeoutMs });
  if (r.code !== 0) {
    throw new Error(`${script} failed (${r.code}): ${(r.stderr || r.stdout || r.error || '').slice(0, 300)}`);
  }
  return r;
}

function makeCtx(over) {
  const o = over || {};
  const home = o.home ? path.resolve(o.home) : paths.HOME;
  const files = tick.runtimeFiles(home);
  const dirs = {
    home,
    scripts: path.join(home, 'scripts'),
    runs: path.join(home, 'runs'),
    logs: path.join(home, 'logs'),
    pending: path.join(home, 'pending-searches'),
  };
  const ctx = Object.assign({
    home,
    files,
    dirs,
    node: paths.NODE,
    now: () => Date.now(),
    sleep: fsx.sleep,
    logFile: path.join(dirs.logs, 'watchdog-runner.jsonl'),
    maxRunMs: MAX_RUN_MS,
    settleMs: Number.isFinite(Number(env.get('RESOURCER_SETTLE_MS', SETTLE_MS))) ? Number(env.get('RESOURCER_SETTLE_MS', SETTLE_MS)) : SETTLE_MS,
    heartbeatMs: HEARTBEAT_MS,
    allowedSources: () => env.get('RESOURCER_SOURCES', 'caterer'),
    clockJumpMs: tick.CLOCK_JUMP_MS,
    browserLockWaitMs: Number.isFinite(Number(env.get('RESOURCER_BROWSER_LOCK_WAIT_MS', BROWSER_LOCK_WAIT_MS))) ? Number(env.get('RESOURCER_BROWSER_LOCK_WAIT_MS', BROWSER_LOCK_WAIT_MS)) : BROWSER_LOCK_WAIT_MS,
    browserLock: { wait: (owner, opts) => require('./ensure-chrome-cdp').browserLock.wait(owner, opts) },
    buildResultsUrl: (p) => require('./build-caterer-results-url').buildResultsUrl(p),
    ensureLoggedIn: (opts) => require('./caterer-login').ensureLoggedIn(opts),
    ensureLoggedInDetailed: (opts) => { const m = require('./caterer-login'); return (m.ensureLoggedInDetailed || m.ensureLoggedIn)(opts); },
    aborted: null,
  }, o);
  // An injected wall clock without a monotonic one is treated as monotonic itself, so only gaps are seen.
  if (!ctx.mono) ctx.mono = o.now ? () => ctx.now() : () => Number(process.hrtime.bigint() / 1000000n);
  if (!ctx.exec) ctx.exec = (script, args, opts) => execNode(ctx, script, args, opts);
  if (o.ensureLoggedIn && !o.ensureLoggedInDetailed) delete ctx.ensureLoggedInDetailed;
  return ctx;
}

function makeLogger(ctx) {
  return (event, data) => {
    const rec = Object.assign({ ts: new Date(ctx.now()).toISOString(), event }, data || {});
    try { fsx.appendLine(ctx.logFile, env.redact(JSON.stringify(rec))); } catch { /* logging must never crash the runner */ }
    try { console.log(`[watchdog-runner] ${event} ${data ? env.redact(JSON.stringify(data)) : ''}`); } catch { /* stdout closed */ }
  };
}

async function resolvePending(ctx, argv, log) {
  const explicit = argFlag(argv, '--pending');
  if (explicit) {
    const filePath = path.isAbsolute(explicit) ? explicit : path.join(ctx.dirs.pending, explicit);
    if (!fs.existsSync(filePath)) throw new Error(`pending file not found: ${filePath}`);
    let raw = fs.readFileSync(filePath, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return { file: path.basename(filePath), filePath, data: JSON.parse(raw) };
  }
  const out = (await mustRun(ctx, 'pending-gate.js', [], 30000)).stdout.trim();
  if (!out.startsWith('{')) {
    log('gate-not-ready', { gate: out.split('\n')[0] });
    return null;
  }
  const parsed = JSON.parse(out);
  if (parsed.status !== 'READY') {
    log('gate-not-ready', { status: parsed.status });
    return null;
  }
  return { file: parsed.file, filePath: parsed.filePath, data: parsed.pending, queueDepth: parsed.queueDepth };
}

// RESOURCER_SOURCES gates Reed off until the operator's canary passes (caterer default).
function effectiveSources(requested, allowed) {
  const a = String(allowed || 'caterer').trim().toLowerCase();
  if (a === 'both') return requested;
  if (a === 'reed') return 'reed';
  return 'caterer';
}

// What the pending file asked for: the original request survives a downgrade (sourcesRequested), so a
// file gated while Reed was off runs with Reed once the operator's canary has passed.
function requestedSources(data) {
  return data.sourcesRequested || data.sources || (data.source === 'territory-scheduler' ? 'caterer' : 'both');
}

function buildParams(ctx, pending, initStatusFile, log) {
  const jobTitle = pending.jobTitle;
  const location = pending.location;
  const distance = Number(pending.distance) || 20;
  const keywords = pending.keywords || '';
  const requested = requestedSources(pending);
  const sources = effectiveSources(requested, ctx.allowedSources());
  if (sources !== requested && log) log('sources-gated', { requested, effective: sources, allowed: ctx.allowedSources() });

  const { url, searchId } = ctx.buildResultsUrl({ jobTitle, location, distance, keywords });

  return {
    RESULTS_URL: url,
    SEARCH_ID: searchId,
    JOB_TITLE: jobTitle,
    LOCATION: location,
    DISTANCE_MILES: distance,
    ACTIVE_WITHIN: pending.activeWithin || '1 month',
    CV_LIMIT: Number(pending.cvLimit) || 20,
    KEYWORDS: keywords,
    CANDIDATE_COUNT: 0,
    SOURCES: sources,
    REQUESTED_AT: pending.requestedAt || '',
    PRIORITY: pending.priority || 'low',
    INIT_STATUS_FILE: initStatusFile,
  };
}

// The caterer login module's answer -> 'ok' | 'login' | 'safelist' | 'error' | 'unknown'.
function normaliseSession(res) {
  if (res === true) return 'ok';
  if (res === false) return 'login';
  let s = null;
  if (typeof res === 'string') s = res;
  else if (res && typeof res === 'object') {
    s = res.state || res.status || res.result || null;
    if (!s && (res.safelist || res.safeListBlocked)) s = 'safelist';
    if (!s && (res.moduleError || res.cvdbModule)) s = 'moduleerror';
    if (!s && res.ok === true) s = 'ok';
    if (!s && res.ok === false) s = 'login';
  }
  if (typeof s !== 'string') return 'unknown';
  const v = s.toLowerCase().replace(/[^a-z]/g, '');
  if (v.includes('safelist')) return 'safelist';
  // Caterer's CV Database module fails per account while the session is fine: any spelling of it must
  // stop the run (an unrecognised answer would let phase 1 scrape a redirect loop and burn the territory).
  if (v.includes('moduleerror') || v.includes('cvdb')) return 'moduleerror';
  if (v === 'login' || v === 'loggedout' || v === 'stale') return 'login';
  if (v === 'ok' || v === 'loggedin' || v === 'error' || v === 'unknown') return v === 'loggedin' ? 'ok' : v;
  return 'unknown';
}

// Returns {state, reloggedIn, detail, timedOut}; state is 'skipped' for a Reed-only run.
async function checkSession(ctx, params, log) {
  if (!(params.SOURCES === 'caterer' || params.SOURCES === 'both')) return { state: 'skipped' };
  let timer;
  let timedOut = false;
  try {
    const guard = new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error('session check exceeded its ceiling')); }, ctx.sessionStepMaxMs || SESSION_STEP_MAX_MS); });
    const fn = ctx.ensureLoggedInDetailed || ctx.ensureLoggedIn;
    const res = await Promise.race([Promise.resolve(fn({ allowRelogin: true })), guard]);
    return { state: normaliseSession(res), reloggedIn: !!(res && typeof res === 'object' && res.reloggedIn), detail: res && typeof res === 'object' ? String(res.detail || '') : '', timedOut: false };
  } catch (e) {
    log('session-load-error', { error: e.message });
    // A login that is still driving the browser must not overlap the scrape: back off instead.
    return { state: timedOut ? 'login' : 'error', timedOut, detail: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// runtime/caterer-status.json is what the dashboard shows for the Caterer session.
function writeCatererStatus(ctx, state, detail) {
  try {
    fsx.writeJsonAtomic(path.join(ctx.files.dir, 'caterer-status.json'), { state, updatedAt: new Date(ctx.now()).toISOString(), detail: String(detail || '').slice(0, 200) });
  } catch { /* status is informational */ }
}

// The pending file, the params, the init status and the queue file must agree on the sources, or
// Phase 2 keeps a pending file that asked for Reed forever and the territory re-runs endlessly.
function gatePendingSources(ctx, pending, log) {
  const data = pending.data;
  const requested = requestedSources(data);
  const effective = effectiveSources(requested, ctx.allowedSources());
  const current = data.sources === undefined ? requested : data.sources;
  if (effective === current) return;
  let raw = fs.readFileSync(pending.filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  const obj = JSON.parse(raw);
  obj.sources = effective;
  if (!obj.sourcesRequested) obj.sourcesRequested = requested;
  fsx.writeJsonAtomic(pending.filePath, obj);
  data.sources = effective;
  log('sources-gated', { requested, effective, allowed: ctx.allowedSources(), file: pending.file });
}

function readJsonSafe(p) {
  if (!p) return null;
  try {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch { return null; }
}

/**
 * Find the run's FINAL status file. phase1 may create its OWN runs/phase1-<ts>.json and delete the
 * INIT_STATUS_FILE we seeded, so match jobTitle + location among files modified since this run
 * began; fall back to the init file. Reporting only - the pipeline itself is unaffected.
 */
function findFinalStatus(runsDir, jobTitle, location, sinceMs, initStatusFile) {
  let best = null;
  let bestMtime = 0;
  try {
    for (const f of fs.readdirSync(runsDir)) {
      if (!/^phase1-.*\.json$/.test(f)) continue;
      const fp = path.join(runsDir, f);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      if (st.mtimeMs < sinceMs - 120000) continue;
      const d = readJsonSafe(fp);
      if (!d) continue;
      if ((d.jobTitle || '').toLowerCase() !== (jobTitle || '').toLowerCase()) continue;
      if ((d.location || '').toLowerCase() !== (location || '').toLowerCase()) continue;
      if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = { path: fp, data: d }; }
    }
  } catch { /* ignore */ }
  if (best) return best;
  const init = readJsonSafe(initStatusFile);
  return init ? { path: initStatusFile, data: init } : { path: null, data: {} };
}

function mapPhase1Exit(res) {
  if (res.spawnError) return { code: EXIT.PHASE1_FAILED, event: 'phase1-spawn-failed', reason: 'spawn-error' };
  if (res.aborted) return { code: EXIT.ERROR, event: 'phase1-aborted', reason: `signal-${res.aborted}` };
  if (res.killed) return { code: EXIT.KILLED, event: 'phase1-killed-timeout', reason: 'timeout' };
  if (res.code === 2) return { code: EXIT.SESSION_STALE, event: 'session-stale', reason: 'phase1-session-stale' };
  if (res.code !== 0) return { code: EXIT.PHASE1_FAILED, event: 'phase1-nonzero', reason: `phase1-exit-${res.code}` };
  return { code: EXIT.OK, event: 'done', reason: null };
}

// phase1 leaves no member of its process group behind on a normal exit; anything left is a leak
// that could run into the next territory, so it is ended here.
async function reapGroup(pid, log) {
  if (!tick.groupAlive(pid)) return false;
  await tick.killTree(pid, { graceMs: 3000 });
  log('reaped-leftovers', { pgid: pid });
  return true;
}

function runPhase1(ctx, paramsFile, fd, lock, log) {
  return new Promise((resolve) => {
    let child;
    let killed = false;
    let settled = false;
    let timer;
    const startMs = ctx.now();
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Object.assign({ code: null, killed, aborted: ctx.aborted }, r));
    };
    // The ceiling counts running time only: a timer that fires after a freeze, or early on a jumped clock, re-arms.
    const onTimer = () => {
      if (settled) return;
      if (ctx.sampleClock) ctx.sampleClock();
      const active = tick.effectiveAgeMs(ctx.files.suspensions, startMs, ctx.now());
      const left = ctx.maxRunMs - active;
      if (left > TIMER_SLACK_MS) {
        log('phase1-timeout-deferred', { activeSec: Math.round(active / 1000), remainingSec: Math.round(left / 1000) });
        timer = setTimeout(onTimer, left);
        return;
      }
      killed = true;
      log('phase1-timeout-kill', { maxMs: ctx.maxRunMs, pid: child && child.pid });
      if (child) tick.killTree(child.pid, { graceMs: 5000 }).catch(() => {});
    };
    timer = setTimeout(onTimer, ctx.maxRunMs);
    try {
      child = spawn(ctx.node, [path.join(ctx.dirs.scripts, 'phase1.js'), '--params-file', paramsFile], {
        cwd: ctx.home,
        detached: true,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        env: childEnv(ctx),
      });
    } catch (e) {
      log('phase1-spawn-error', { error: e.message });
      done({ spawnError: e.message });
      return;
    }
    ctx.phase1Pid = child.pid;
    if (lock) lock.update({ childPid: child.pid, childToken: tick.procToken(child.pid), phase1StartedAt: new Date(ctx.now()).toISOString() });
    child.on('error', (err) => {
      log('phase1-spawn-error', { error: err.message });
      done({ spawnError: err.message });
    });
    child.on('exit', (code, signal) => {
      reapGroup(child.pid, log).catch(() => {}).then(() => done({ code, signal }));
    });
  });
}

// Never fatal: the lock, not this call, is what keeps the browsers apart.
async function stopIdleBrowser(ctx) {
  try {
    const r = await ctx.exec('ensure-chrome-cdp.js', ['--stop-if-idle'], { timeoutMs: STOP_IDLE_TIMEOUT_MS });
    return { code: r.code, result: String(r.stdout || r.stderr || r.error || '').split('\n')[0].slice(0, 160) };
  } catch (e) {
    return { code: 'error', result: e.message };
  }
}

// Outcomes the territory did not cause (session, screening, a signal, a foreign lock, the machine): its claim goes back at
// once and the failure is not counted against it. Every other failure keeps the claim stamped, so the gate skips the file
// for 10 minutes and the next territory runs (the legacy stale-spawn rotation) while the watchdog counts the failure.
const FAULTLESS_REASONS = new Set(['phase1-exit-3', 'phase1-exit-7', 'spawn-error', 'browser-lock-error', 'resolve-error', 'mark-spawned-error', 'screening-unavailable']);
function faultless(code, reason) {
  if (code === EXIT.SESSION_STALE) return true;
  const r = String(reason || '');
  return r.startsWith('signal-') || FAULTLESS_REASONS.has(r);
}

// A run that could not do its work (screening down, Caterer session stale) keeps its pending search; the claim stamp is
// removed so the gate offers the file again as soon as the cause is fixed instead of after the 10-minute stale-spawn window.
function releasePendingClaim(ctx, filePath, log, reason) {
  try {
    const obj = readJsonSafe(filePath);
    if (!obj || !obj.spawnedAt) return;
    delete obj.spawnedAt;
    fsx.writeJsonAtomic(filePath, obj);
    log('pending-released', { file: path.basename(filePath), reason: reason || 'released' });
  } catch (e) {
    log('pending-release-error', { error: e.message });
  }
}

// The Reed tail launches its browser under the lock this runner holds ("borrowed"), so it does not stop it; the runner
// does, before the lock is given up, or Chromium and its display server would idle for hours (DESIGN 7). Quit through CDP so the login survives.
async function stopReedBrowser(ctx, log) {
  if (env.get('REED_KEEP_CHROME', '0') === '1') return;
  try {
    const r = await ctx.exec('ensure-chrome-cdp.js', ['--stop'], { timeoutMs: STOP_IDLE_TIMEOUT_MS });
    log('reed-browser-stop', { code: r.code, result: String(r.stdout || r.stderr || r.error || '').split('\n')[0].slice(0, 160) });
  } catch (e) {
    log('reed-browser-stop', { code: 'error', result: e.message });
  }
}

function writeLastRun(ctx, rec) {
  try { fsx.writeJsonAtomic(ctx.files.lastRun, rec); } catch { /* the tick falls back to the crash path */ }
}

async function runOnce(ctx, argv) {
  const log = ctx.log || makeLogger(ctx);
  const dryRun = argv.includes('--dry-run');
  const startMs = ctx.now();
  const startedAt = new Date(startMs).toISOString();
  let lock = null;
  let hb = null;
  let browserLease = null;
  let reedTail = false;
  const summary = { file: null, filePath: null, initStatusFile: null };

  const finish = (code, extra) => {
    if (hb) clearInterval(hb);
    // Only a failure the territory did not cause gives the pending search back at once (see faultless).
    if (code !== EXIT.OK && code !== EXIT.NO_WORK && summary.filePath && !dryRun && faultless(code, extra && extra.reason)) releasePendingClaim(ctx, summary.filePath, log, (extra && extra.reason) || `exit-${code}`);
    if (lock) {
      if (!dryRun && code !== EXIT.NO_WORK) {
        writeLastRun(ctx, Object.assign({
          nonce: lock.nonce, pid: process.pid, exitCode: code, startedAt, endedAt: new Date(ctx.now()).toISOString(),
          elapsedSec: Math.round((ctx.now() - startMs) / 1000), file: summary.file,
        }, extra));
      }
      lock.release();
    }
    return Object.assign({ code }, extra);
  };

  try {
    if (!dryRun) {
      const c = tick.acquireLock(ctx.files.run, {
        info: { role: 'runner', argv: argv.join(' ') },
        isDead: tick.runRecordDead,
        stealOnHeartbeatStale: false,
      });
      if (!c.ok) {
        log('busy-abort', { busyPid: c.holder && c.holder.pid, note: 'a runner claim is live; deferring to avoid a duplicate concurrent run' });
        return { code: EXIT.NO_WORK, reason: 'claimed' };
      }
      lock = c;
      // Every heartbeat also compares the clocks; a gap is a frozen instance and no age (ceiling, backstop) counts it.
      const guard = tick.makeClockGuard({ wall: ctx.now, mono: ctx.mono, thresholdMs: ctx.clockJumpMs });
      ctx.sampleClock = () => {
        const j = guard.check(ctx.heartbeatMs);
        if (!j) return;
        tick.recordSuspension(ctx.files.suspensions, j.fromMs, j.toMs, ctx.now());
        log('clock-jump', { seconds: Math.round(j.jumpMs / 1000), kind: j.kind });
      };
      hb = setInterval(() => { ctx.sampleClock(); lock.heartbeat(); }, ctx.heartbeatMs);
      if (hb.unref) hb.unref();
    }

    let pending;
    try {
      pending = await resolvePending(ctx, argv, log);
    } catch (e) {
      log('resolve-error', { error: e.message });
      return finish(EXIT.ERROR, { reason: 'resolve-error', error: e.message });
    }
    if (!pending) return finish(EXIT.NO_WORK);

    const { file, filePath, data } = pending;
    summary.file = file;
    summary.filePath = filePath;
    log('picked', { file, job: data.jobTitle, location: data.location, distance: data.distance, sources: data.sources, queueDepth: pending.queueDepth });
    const invalid = gate.validatePending(data);
    if (invalid) {
      log('invalid-pending', { file, reason: invalid });
      return finish(EXIT.ERROR, { reason: 'invalid-pending', error: invalid, file });
    }

    if (!dryRun) {
      const busy = tick.busyState({ home: ctx.home, ownNonce: lock.nonce });
      if (busy.busy) {
        log('busy-abort', { busyPid: busy.pid, kind: busy.kind, note: 'a pipeline process is live; gate READY is stale - deferring to avoid a duplicate concurrent run' });
        return finish(EXIT.NO_WORK, { reason: 'busy' });
      }
    }

    if (dryRun) {
      const previewParams = buildParams(ctx, data, '<INIT_STATUS_FILE>', log);
      log('dry-run', { params: previewParams });
      console.log('\nDRY RUN - would run phase1.js with the above params. Nothing started.');
      return finish(EXIT.OK, { reason: 'dry-run' });
    }

    // Caterer and Reed browsers never run together (DESIGN 7): stop a leftover Reed browser, then hold browser.lock for the run.
    const stopped = await stopIdleBrowser(ctx);
    log('browser-stop-idle', stopped);
    try {
      const got = await ctx.browserLock.wait('caterer', { purpose: 'caterer-run', waitMs: ctx.browserLockWaitMs, pollMs: 2000 });
      if (!got.acquired) {
        const h = got.holder || {};
        log('browser-busy', { holderOwner: h.owner || null, holderPid: h.pid || null, reason: got.reason || null, note: 'another browser run holds browser.lock; the territory is not claimed and the next poll retries' });
        return finish(EXIT.NO_WORK, { reason: 'browser-busy' });
      }
      browserLease = got;
      ctx.browserLockPid = got.borrowed && got.holder ? got.holder.pid : process.pid;
      log('browser-lock', { owner: 'caterer', pid: ctx.browserLockPid, borrowed: !!got.borrowed });
    } catch (e) {
      log('browser-lock-error', { error: e.message });
      return finish(EXIT.ERROR, { reason: 'browser-lock-error', error: e.message });
    }

    lock.update({ file, jobTitle: data.jobTitle, location: data.location });

    try {
      gatePendingSources(ctx, pending, log);
    } catch (e) {
      log('sources-gate-error', { file, error: e.message });
      return finish(EXIT.ERROR, { reason: 'sources-gate-error', error: e.message });
    }

    try {
      await mustRun(ctx, 'pending-gate.js', ['--mark-spawned', file], 30000);
      log('marked-spawned', { file });
    } catch (e) {
      log('mark-spawned-error', { file, error: e.message });
      return finish(EXIT.ERROR, { reason: 'mark-spawned-error', error: e.message });
    }

    let initStatusFile;
    try {
      const out = (await mustRun(ctx, 'create-init-status.js', [filePath], 30000)).stdout.trim();
      const m = out.match(/INIT_FILE:(.+)$/m);
      if (!m) throw new Error(`create-init-status gave no INIT_FILE: ${out}`);
      initStatusFile = m[1].trim();
      summary.initStatusFile = initStatusFile;
      log('init-status', { initStatusFile });
    } catch (e) {
      log('init-status-error', { error: e.message });
      return finish(EXIT.ERROR, { reason: 'init-status-error', error: e.message });
    }

    let params;
    try {
      params = buildParams(ctx, data, initStatusFile, log);
    } catch (e) {
      log('params-error', { error: e.message });
      return finish(EXIT.ERROR, { reason: 'params-error', error: e.message });
    }
    // Seconds precision: minute precision let same-minute back-to-back runs share a console file.
    const stamp = new Date(ctx.now()).toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 17);
    const paramsFile = path.join(ctx.dirs.runs, `params-watchdog-${stamp}.json`);
    fsx.writeFileAtomic(paramsFile, JSON.stringify(params));
    log('params-written', { paramsFile, resultsUrl: params.RESULTS_URL, sources: params.SOURCES });

    reedTail = params.SOURCES === 'both' || params.SOURCES === 'reed';
    const session = await checkSession(ctx, params, log);
    if (session.reloggedIn) log('session-relogin', { note: 'the session was not signed in; the login module signed in again' });
    if (session.state === 'safelist') {
      const note = 'browser blocked at SafeListLoginBlocked - open a fresh verification link from the contact mailbox in the same browser session (docs/OPERATIONS.md); the queue resumes after the back-off';
      log('session-safelist-blocked', { note });
      log('session-dead', { note });
      writeCatererStatus(ctx, 'safelist_blocked', 'SafeListLoginBlocked');
      return finish(EXIT.SESSION_STALE, { reason: 'safelist', file });
    }
    if (session.state === 'moduleerror') {
      // The session is signed in but Caterer's CV Database module is failing: a scrape would only 0-card.
      log('session-dead', { note: 'Caterer CV Database module is failing although the session is signed in; the run is not started (docs/OPERATIONS.md)' });
      writeCatererStatus(ctx, 'stale', 'CV Database module error');
      return finish(EXIT.SESSION_STALE, { reason: 'cvdb-module', file });
    }
    if (session.state === 'login') {
      // The pending file stays claimed and the territory is not burned by a scrape that would 0-card on the login redirect.
      log('session-dead', { note: session.timedOut ? 'the Caterer sign-in did not finish within its time limit' : 'Caterer session is logged out and the automatic re-login did not restore it (docs/OPERATIONS.md)' });
      writeCatererStatus(ctx, 'login_failed', session.timedOut ? 'sign-in timed out' : session.detail);
      return finish(EXIT.SESSION_STALE, { reason: session.timedOut ? 'session-timeout' : 'login', file });
    }
    if (session.state !== 'skipped') {
      if (session.state === 'ok') writeCatererStatus(ctx, 'ok', session.reloggedIn ? 'signed in again' : '');
      log('session-loaded', { state: session.state });
      // Two navigations of the same browser session seconds apart were misread as a stale session (2026-07-10).
      await ctx.sleep(ctx.settleMs);
    }

    if (ctx.aborted) return finish(EXIT.ERROR, { reason: `signal-${ctx.aborted}`, file });

    const runLogPath = path.join(ctx.dirs.logs, `phase1-console-${stamp}.log`);
    fsx.ensureDir(ctx.dirs.logs);
    const fd = fs.openSync(runLogPath, 'a');
    log('phase1-start', { file, paramsFile, runLog: runLogPath });
    lock.update({ runLog: runLogPath });
    let res;
    try {
      res = await (ctx.runPhase1 ? ctx.runPhase1(ctx, paramsFile, fd, lock, log) : runPhase1(ctx, paramsFile, fd, lock, log));
    } finally {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    const elapsedSec = Math.round((ctx.now() - startMs) / 1000);

    const final = findFinalStatus(ctx.dirs.runs, data.jobTitle, data.location, startMs, initStatusFile);
    const status = final.data || {};
    const result = {
      file, statusFile: final.path ? path.basename(final.path) : null,
      exitCode: res.code, killed: !!res.killed, elapsedSec,
      phase1Status: status.status, pool: status.pool, approved: status.approved,
      skippedDb: status.skippedDb, errors: status.errors, phase2Status: status.phase2Status,
    };
    const mapped = mapPhase1Exit(res);
    if (status.incomplete) releasePendingClaim(ctx, filePath, log, 'screening-unavailable');
    if (res.spawnError) result.spawnError = res.spawnError;
    log(mapped.event, result);
    if (mapped.event === 'session-stale') writeCatererStatus(ctx, 'stale', 'phase1 reported a stale session (exit 2)');
    return finish(mapped.code, {
      reason: mapped.reason, file, statusFile: result.statusFile, phase1Code: res.code, killed: !!res.killed,
      phase1Status: status.status, pool: status.pool, approved: status.approved, skippedDb: status.skippedDb,
      errors: status.errors, phase2Status: status.phase2Status,
    });
  } catch (e) {
    log('fatal', { error: e.message, stack: e.stack });
    return finish(EXIT.ERROR, { reason: 'fatal', error: e.message });
  } finally {
    // After the run record and the result are written; a runner that is killed leaves the lock to the stale-holder rule.
    if (browserLease) {
      if (reedTail) await stopReedBrowser(ctx, log);
      try { browserLease.release(); } catch { /* a stale lock is taken over by pid liveness */ }
      ctx.browserLockPid = null;
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const known = new Set(['--from-gate', '--pending', '--dry-run']);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pending') { i++; continue; }
    if (!known.has(argv[i])) {
      console.error(`unknown argument '${argv[i]}'\n${USAGE}`);
      return EXIT.ERROR;
    }
  }
  const ctx = makeCtx();
  const onSignal = (sig) => {
    ctx.aborted = sig;
    if (ctx.phase1Pid) tick.killTree(ctx.phase1Pid, { graceMs: 5000 }).catch(() => {});
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  const r = await runOnce(ctx, argv);
  return r.code;
}

// Legacy compatibility: the pid of a live pipeline process, null when none, -1 when unknown.
function pipelineBusyPid(home) {
  try {
    const b = tick.busyState({ home });
    if (!b.busy) return null;
    return b.kind === 'unknown' || !b.pid ? -1 : b.pid;
  } catch {
    return -1;
  }
}

module.exports = {
  EXIT, MAX_RUN_MS, SETTLE_MS, PIPELINE_PROC_RE,
  makeCtx, makeLogger, runOnce, resolvePending, buildParams, effectiveSources, requestedSources, normaliseSession, childEnv, stopIdleBrowser,
  findFinalStatus, mapPhase1Exit, releasePendingClaim, faultless, stopReedBrowser, runPhase1, pipelineBusyPid, execNode, gatePendingSources, checkSession,
};

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => {
    console.error(`[watchdog-runner] fatal ${env.redact(e && e.stack ? e.stack : String(e))}`);
    process.exit(EXIT.ERROR);
  });
}
