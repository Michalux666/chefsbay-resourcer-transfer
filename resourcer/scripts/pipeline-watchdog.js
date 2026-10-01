#!/usr/bin/env node
'use strict';
/**
 * pipeline-watchdog.js - the supervision tick that replaces the always-on daemon.
 *
 * A Hermes cron job starts one tick (see hermes/scripts/resourcer-tick.sh). The tick is BOUNDED
 * (--max-minutes, at most 55) so it never meets the 3600 s cron timeout, holds a PID-liveness lock
 * so an overlapping fire exits at once, and keeps only small persisted state so it is safe to be
 * killed at any instant. While a run is in flight it stays in the foreground (that keeps the
 * instance awake); when nothing is left to do it exits so the instance can idle. A run cannot
 * outlive its tick, so the tick stops launching at RESOURCER_LAUNCH_CUTOFF_MIN, waits out the run
 * it launched and ends a run still going at RESOURCER_TICK_HARD_CAP_MIN.
 *
 * Preserved from the legacy daemon: operating window (Europe/London), one runner at a time,
 * 15-minute back-off after a session-stale exit (11), 70-minute run ceiling, halt probe and
 * self-clearing resume, pending-gate drain, queue-due-territories and cull-ghost/recover-stranded
 * every 5 minutes, orphaned-lock release, immediate re-check after a run that exits 0.
 *
 * Usage:
 *   node scripts/pipeline-watchdog.js --tick [--max-minutes 55]   supervision tick (cron)
 *   node scripts/pipeline-watchdog.js --once                      one iteration, no waiting
 *   node scripts/pipeline-watchdog.js --queue-due                 queue due territories (idempotent)
 *   node scripts/pipeline-watchdog.js --status [--scan]           print supervision state as JSON
 *   node scripts/pipeline-watchdog.js --clear-cooldown            drop the exit-11 back-off
 *   node scripts/pipeline-watchdog.js --release-quarantine <file> put a quarantined pending search back in the queue
 * Exit: 0 normal (including "another tick is running"), 1 unexpected error, 2 usage.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./lib/paths');
const env = require('./lib/env');
const fsx = require('./lib/fsx');
const timeLib = require('./lib/time');
const tick = require('./lib/tick');
const runnerLib = require('./watchdog-runner');
const pendingGate = require('./pending-gate');
const { PHASE2_HELD_EXIT } = require('./lib/phase2-exit');

const C = {
  OPEN_HOUR: 6,
  CLOSE_HOUR: 22,
  MAX_TICK_MIN_CAP: 55,
  // The tick drains: no launch after the cutoff, its own run is waited out up to the hard cap, which plus the kill stays under the wrapper's 3450 s timeout.
  DRAIN_MIN_TICK_MIN: 20,
  LAUNCH_CUTOFF_DEFAULT_MIN: 38,
  LAUNCH_CUTOFF_FLOOR_MIN: 10,
  LAUNCH_CUTOFF_MARGIN_MIN: 10,
  TICK_HARD_CAP_DEFAULT_MIN: 56,
  TICK_HARD_CAP_MAX_MIN: 56,
  HARD_CAP_RUNNER_EXIT_MS: 10000,
  HARD_CAP_ALERT_GAP_MS: 6 * 3600000,
  POLL_MS: 60000,
  SUPERVISE_MS: 10000,
  STALE_COOLDOWN_MS: 15 * 60000,
  MAINT_INTERVAL_MS: 5 * 60000,
  SLOW_CHECK_INTERVAL_MS: 30 * 60000,
  QUEUE_DUE_MIN_GAP_MS: 270000,
  MAX_RUN_MS: runnerLib.MAX_RUN_MS,
  TICK_KILL_GRACE_MS: 2 * 60000,
  PROBE_FAILS_BEFORE_HALT: 2,
  PROBE_STREAK_EXPIRE_MS: 5 * 60000,
  HALT_PROBE_MS: 60000,
  // A halt that was cleared twice within this window while a CV-held queue was waiting, and was raised again, is not cleared a third time by the supervisor:
  // the CV canary (one small invented request) passes while real CVs still fail, so the clear would only start another run that unlocks credits and holds again.
  FLAP_WINDOW_MS: 6 * 3600000,
  FLAP_MAX_CLEARS: 2,
  FLAP_PROBE_MS: 15 * 60000,
  MIN_MEM_MB: 700,
  ORPHAN_MIN_AGE_MS: 120000,
  REGISTER_WAIT_MS: 15000,
  PUSH_DROUGHT_MS: 3 * 3600000,
  GATE_TIMEOUT_MS: 30000,
  RECENT_RUNS_KEPT: 20,
  // Frozen-instance handling: a gap of CLOCK_JUMP_MS is a suspend; HEARTBEAT_GRACE_MS is 2.5 runner heartbeats.
  CLOCK_JUMP_MS: tick.CLOCK_JUMP_MS,
  RESUME_GAP_MS: 3 * 60000,
  HEARTBEAT_GRACE_MS: 25000,
  OVERRUN_HEALTHY_EXTRA_MS: 10 * 60000,
  TICK_LOCK_STALE_MS: 10 * 60000,
  // A territory that fails this many runs in a row is moved out of the queue (docs/parity/supervision.md, poison territories).
  QUARANTINE_AFTER: 3,
  // Failures of this many different territories among the last runs mean the system is broken, not one territory.
  SYSTEMIC_DISTINCT: 3,
  SYSTEMIC_WINDOW: 6,
  LOG_CAP_BYTES: 300 * 1024 * 1024,
  LOG_KEEP_BYTES: 256 * 1024,
  EXIT10_ALERT_MS: 30 * 60000,
  STREAK_REPEAT_MS: 6 * 3600000,
  STREAK_CRITICAL_MS: 24 * 3600000,
  // A persisted timestamp this far ahead of the clock was written while the clock ran ahead; it is ignored.
  FUTURE_SKEW_MS: 24 * 3600000,
};

// phase1 statuses that mean "a run is actively working this file". If one exists while no
// pipeline process is alive, the file is an orphan that would lock the gate until its age limit.
const NONTERMINAL_STATUSES = new Set([
  'phase1_initializing', 'phase1_running', 'phase1_taking_over',
  'phase1_searching', 'phase1_active', 'phase2_starting', 'phase2_push',
]);

// The only preflight-db.js verdict other than ok that still lets a run start: a busy writer means the check could not be made.
// Anything else (open-failed for corruption, driver-missing, integrity-failed, missing, empty) holds the queue.
const DB_RUNNABLE = new Set(['locked']);
const DB_ALERT_GAP_MS = 30 * 60000;
const DB_REMEDY = {
  'driver-missing': 'The SQLite driver (better-sqlite3) cannot be loaded, usually after a Node upgrade: run npm rebuild better-sqlite3 (or npm ci) in resourcer/, then node scripts/preflight-db.js.',
  'open-failed': 'The file cannot be opened as a database (corruption): restore the newest backup (node scripts/backup-db.js --list, then --restore), then node scripts/preflight-db.js.',
};
const DB_REMEDY_DEFAULT = 'Restore it (tools/restore-bundle.js or node scripts/backup-db.js --restore), then check with node scripts/preflight-db.js.';
const PHASE1_EXIT_TEXT = { 1: 'phase1 crashed', 4: 'territory mismatch', 5: 'missing parameters', 6: 'bad url encoding' };

const REMEDY = 'Check the screening gateway: AI_GATEWAY_API_KEY in the profile .env and the Vercel AI Gateway credits and status (docs/OPERATIONS.md). The halt clears itself when screening answers again.';

// Operating hours: 06:00-22:00 Europe/London every day including weekends.
function inOperatingHours(date, open, close) {
  const h = timeLib.londonHour(timeLib.hourClock(date));
  return h >= (open === undefined ? C.OPEN_HOUR : open) && h < (close === undefined ? C.CLOSE_HOUR : close);
}

function makeCtx(over) {
  const o = over || {};
  const home = o.home ? path.resolve(o.home) : paths.HOME;
  const files = tick.runtimeFiles(home);
  const dirs = {
    home,
    scripts: path.join(home, 'scripts'),
    runs: files.runs,
    logs: files.logs,
    pending: path.join(home, 'pending-searches'),
  };
  const ctx = Object.assign({
    home,
    files,
    dirs,
    node: paths.NODE,
    now: () => Date.now(),
    sleep: fsx.sleep,
    maxRunMs: C.MAX_RUN_MS,
    heartbeatGraceMs: C.HEARTBEAT_GRACE_MS,
    clockJumpMs: C.CLOCK_JUMP_MS,
    stop: false,
    runnerExits: new Map(),
    halt: {
      getHalt: () => require('./lib/pipeline-halt').getHalt(),
      setHalt: (...a) => require('./lib/pipeline-halt').setHalt(...a),
      clearHalt: () => require('./lib/pipeline-halt').clearHalt(),
    },
    screening: () => require('./lib/screening-health'),
    notify: (a) => notifyOrComplain(ctx, a),
    memAvailMb: () => require('./maintenance').memoryAvailableMb(),
    killTree: (pid, opts) => tick.killTree(pid, opts),
    log: null,
  }, o);
  // An injected wall clock without a monotonic one is treated as monotonic itself, so only gaps are seen.
  if (!ctx.mono) ctx.mono = o.now ? () => ctx.now() : () => Number(process.hrtime.bigint() / 1000000n);
  if (!ctx.exec) ctx.exec = (script, args, opts) => runnerLib.execNode(ctx, script, args, opts);
  if (!ctx.spawnRunner) ctx.spawnRunner = (opts) => defaultSpawnRunner(ctx, opts);
  if (!ctx.log) {
    ctx.log = (msg, level) => {
      const line = `[watchdog] ${new Date(ctx.now()).toISOString()} ${env.redact(msg)}`;
      if (level === 'error') console.error(line); else console.log(line);
    };
  }
  return ctx;
}

// notify() reports a failed outbox write by returning false; a critical alert that cannot be written must not vanish:
// its text goes to the tick log and the tick exits 1, so the cron failure notice reaches the human instead.
function notifyOrComplain(ctx, a) {
  let ok = false;
  try { ok = require('./lib/notify').notify(a); } catch { ok = false; }
  if (!ok) {
    ctx.log(`ALERT NOT RECORDED (outbox not writable) [${a && a.severity}] ${a && a.key}: ${a && a.text}`, 'error');
    if (a && a.severity === 'critical') ctx.criticalLost = (ctx.criticalLost || 0) + 1;
  }
  return ok;
}

function defaultSpawnRunner(ctx, opts) {
  const child = spawn(ctx.node, [path.join(ctx.dirs.scripts, 'watchdog-runner.js')].concat(opts.args), {
    cwd: ctx.home,
    detached: true,
    stdio: ['ignore', opts.fd, opts.fd],
    windowsHide: true,
    env: Object.assign({}, process.env, { RESOURCER_HOME: ctx.home }),
  });
  child.unref();
  return child;
}

function defaultState() {
  return {
    version: 1,
    staleCooldownUntil: 0,
    launchNotBefore: 0,
    probeFail: { count: 0, lastAt: 0 },
    haltProbeAt: 0,
    heldClears: [],
    lastMaintenanceAt: 0,
    lastSlowCheckAt: 0,
    handledRunNonce: null,
    killedNonces: {},
    consecutiveFailures: 0,
    recentRuns: [],
    lastTickAt: 0,
    lastTickStartedAt: 0,
    lastTickEndedAt: 0,
    lastHeartbeatWarnAt: 0,
    lastClockJumpAt: 0,
    lastResume: null,
    superviseSince: 0,
  };
}

const CLAMP_KEYS = ['staleCooldownUntil', 'launchNotBefore', 'haltProbeAt', 'lastMaintenanceAt', 'lastSlowCheckAt', 'lastHeartbeatWarnAt', 'lastTickAt', 'dbAlertAt', 'superviseSince', 'runFailAlertAt', 'failStreakSince', 'exit10AlertAt', 'hardCapAlertAt'];

// Reason recorded for a run the tick ended at its hard cap; like an overrun it keeps its claim, and it is not the territory's fault.
const TICK_HARD_CAP = 'tick-hard-cap';
const territoryFault = (code, reason) => !runnerLib.faultless(code, reason) && reason !== TICK_HARD_CAP;

function loadState(ctx) {
  const s = fsx.readJson(ctx.files.state, null);
  const st = Object.assign(defaultState(), s && typeof s === 'object' ? s : {});
  const limit = ctx.now() + C.FUTURE_SKEW_MS;
  for (const k of CLAMP_KEYS) {
    if (Number(st[k]) > limit) st[k] = 0;
  }
  return st;
}

// True at the first streak length and again every `every` failures.
function streakDue(n, first, every) {
  return n === first || (n > first && (n - first) % every === 0);
}

function touchHeartbeat(ctx) {
  try { fs.writeFileSync(ctx.files.tickHeartbeat, new Date(ctx.now()).toISOString()); } catch { /* informational */ }
}

function saveState(ctx, state) {
  try { fsx.writeJsonAtomic(ctx.files.state, state); } catch (e) { ctx.log(`state save failed: ${e.message}`, 'error'); }
}

function londonCompact(ctx) {
  return timeLib.londonParts(new Date(ctx.now())).ymd.replace(/-/g, '');
}

async function withTimeout(promise, ms, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeout()), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// gate, locks, maintenance

async function checkGate(ctx) {
  const r = await ctx.exec('pending-gate.js', [], { timeoutMs: C.GATE_TIMEOUT_MS });
  const raw = String(r.stdout || '').split('\n')[0].trim();
  if (r.code !== 0) return { status: 'ERROR', raw: raw || r.error || String(r.code) };
  if (raw.startsWith('{')) {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* fall through */ }
    if (parsed && parsed.status === 'READY') return { status: 'READY', parsed, raw };
    return { status: parsed && parsed.status ? String(parsed.status) : 'ERROR', raw };
  }
  const status = (raw.split(/[:\s]/)[0] || 'ERROR').toUpperCase();
  return { status, raw };
}

// Guarded by the liveness authority, so it can never abandon a genuinely live run (including
// the Reed tail, which keeps run-pipeline alive after phase1 wrote phase1_complete).
function releaseOrphanedLocks(ctx, opts) {
  const minAgeMs = opts && opts.minAgeMs !== undefined ? opts.minAgeMs : C.ORPHAN_MIN_AGE_MS;
  let busy;
  try { busy = ctx.busy ? ctx.busy() : tick.busyState({ home: ctx.home, now: ctx.now() }); } catch { busy = { busy: true }; }
  if (busy.busy) return { released: 0, skipped: 'busy' };
  let names;
  try { names = fs.readdirSync(ctx.dirs.runs); } catch { return { released: 0 }; }
  let released = 0;
  for (const f of names) {
    if (!/^phase1-.*\.json$/.test(f)) continue;
    const fp = path.join(ctx.dirs.runs, f);
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      const d = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
      if (!NONTERMINAL_STATUSES.has(d.status)) continue;
      const updated = Date.parse(d.updatedAt || d.startedAt || '');
      if (minAgeMs > 0 && Number.isFinite(updated) && ctx.now() - updated < minAgeMs) continue;
      const was = d.status;
      d.status = 'phase1_abandoned';
      d.updatedAt = new Date(ctx.now()).toISOString();
      d.abandonedReason = `orphaned (was ${was}, no live pipeline process); released by pipeline-watchdog`;
      fsx.writeJsonAtomic(fp, d);
      released++;
      ctx.log(`released orphaned lock ${d.id || f} (was ${was})`);
    } catch { /* unreadable: skip */ }
  }
  // A Phase 2 killed mid-push leaves its progress record (run-*.json) in a phase2 status, which the run lock reads as
  // an in-flight run for 30 minutes. No process is alive (checked above), so the record is closed as an error.
  for (const f of names) {
    if (!/^run-.*\.json$/.test(f)) continue;
    const fp = path.join(ctx.dirs.runs, f);
    try {
      const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (d.status !== 'phase2_starting' && d.status !== 'phase2_pushing') continue;
      const updated = Date.parse(d.updatedAt || d.startedAt || '');
      if (minAgeMs > 0 && Number.isFinite(updated) && ctx.now() - updated < minAgeMs) continue;
      const was = d.status;
      d.status = 'error';
      d.error = `orphaned (was ${was}, no live pipeline process); released by pipeline-watchdog`;
      d.completedAt = new Date(ctx.now()).toISOString();
      fsx.writeJsonAtomic(fp, d);
      released++;
      ctx.log(`released orphaned Phase 2 record ${d.id || f} (was ${was})`);
    } catch { /* unreadable: skip */ }
  }
  if (released) ctx.log(`released ${released} orphaned lock(s) - queue can resume`);
  return { released };
}

async function cullGhost(ctx) {
  const r = await ctx.exec('cull-ghost-phase1.js', [], { timeoutMs: 60000 });
  if (r.code !== 0) {
    ctx.log(`maintenance cull-ghost-phase1.js failed: ${r.error || r.code}`, 'error');
    return { ok: false };
  }
  const out = { ok: true, culled: 0, recovered: [] };
  for (const line of r.stdout.split('\n')) {
    const m = /^CULL_OK culled=(\d+)/.exec(line);
    if (m) out.culled = Number(m[1]);
    if (line.startsWith('RECOVERY_OK')) {
      const re = /([^\s,()]+)\(pid=(\d+),mode=([\w-]+)\)/g;
      let x;
      while ((x = re.exec(line)) !== null) out.recovered.push({ id: x[1], pid: Number(x[2]), mode: x[3] });
    }
    if (line.startsWith('CULL_ERR') || line.startsWith('RECOVERY_ERR')) ctx.log(`maintenance ${line}`, 'error');
  }
  if (out.culled) ctx.log(`culled ${out.culled} ghost phase1 file(s)`);
  if (out.recovered.length) {
    // Recovered children are detached; register them so they count as a live run until they end.
    tick.addAdopted(ctx.files, out.recovered);
    ctx.log(`recovered ${out.recovered.length} stranded run(s): ${out.recovered.map((x) => `${x.id}(pid=${x.pid},mode=${x.mode})`).join(',')}`);
  }
  return out;
}

async function runQueueDue(ctx, opts) {
  const o = Object.assign({ force: false }, opts);
  const qd = fsx.readJson(ctx.files.queueDueState, {});
  const now = ctx.now();
  if (Number(qd.lastAt) > now + C.FUTURE_SKEW_MS) qd.lastAt = 0;
  if (!o.force && now - (qd.lastAt || 0) < C.QUEUE_DUE_MIN_GAP_MS) return { skipped: 'recent' };
  const lock = tick.acquireLock(ctx.files.queueDueLock, { staleMs: 120000, info: { role: 'queue-due' } });
  if (!lock.ok) return { skipped: 'locked' };
  try {
    qd.lastAt = now;
    const r = await ctx.exec('queue-due-territories.js', ['--json', '--quiet'], { timeoutMs: 30000 });
    let summary = null;
    if (r.code === 0) {
      try { summary = JSON.parse(r.stdout); } catch { summary = null; }
    }
    if (!summary) {
      qd.fails = (qd.fails || 0) + 1;
      ctx.log(`queue-due-territories failed: ${r.error || r.stdout || r.code}`, 'error');
      if (streakDue(qd.fails, 3, 12)) {
        ctx.notify({ severity: 'warn', key: 'queue-due-failing', text: `queue-due-territories has failed ${qd.fails} times in a row, so newly due territories are not being queued. Run: node scripts/queue-due-territories.js --dry-run (docs/OPERATIONS.md).` });
      }
      return { ok: false };
    }
    qd.fails = 0;
    qd.lastSummary = summary;
    if (summary.queued > 0) {
      ctx.log(`auto-queued ${summary.queued} due territor${summary.queued === 1 ? 'y' : 'ies'}${summary.reedBudgetExhausted ? ' [Reed budget exhausted]' : ''}`);
    }
    return { ok: true, summary };
  } finally {
    try { fsx.writeJsonAtomic(ctx.files.queueDueState, qd); } catch { /* best effort */ }
    lock.release();
  }
}

function pendingCount(ctx) {
  try { return fs.readdirSync(ctx.dirs.pending).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
}

// A working pipeline that stops pushing is the symptom of every silent outage seen so far.
function checkPushDrought(ctx, state) {
  const p = timeLib.londonParts(new Date(ctx.now()));
  if (p.hour < C.OPEN_HOUR + 3 || p.hour >= C.CLOSE_HOUR) return { skipped: 'window' };
  if (ctx.now() < state.staleCooldownUntil) return { skipped: 'explained-cooldown' };
  const halted = ctx.halt.getHalt();
  if (halted && halted.halted) return { skipped: 'explained-halt' };
  if (pendingCount(ctx) === 0) return { skipped: 'no-queue' };
  let Database;
  try { Database = require('better-sqlite3'); } catch (e) {
    ctx.notify({ severity: 'critical', key: 'sqlite-driver', text: `The SQLite driver (better-sqlite3) cannot be loaded (${String(e && e.message).split(/\r?\n/)[0].slice(0, 120)}), so no run can be checked or started. ${DB_REMEDY['driver-missing']}` });
    return { alerted: true, skipped: 'no-sqlite' };
  }
  let db;
  try {
    db = new Database(path.join(ctx.home, 'candidates.db'), { readonly: true, fileMustExist: true });
    let last = null;
    try { last = db.prepare('SELECT MAX(completed_at) AS t FROM run_results WHERE new_to_zoho > 0').get(); } catch { last = null; }
    let t = last && last.t ? Date.parse(last.t) : NaN;
    if (!Number.isFinite(t)) {
      try {
        const z = db.prepare('SELECT MAX(zoho_pushed_at) AS t FROM candidates').get();
        t = z && z.t ? Date.parse(String(z.t).replace(' ', 'T') + (/(?:Z|[+-]\d\d:?\d\d)$/i.test(String(z.t)) ? '' : 'Z')) : NaN;
      } catch { t = NaN; }
    }
    // Measured from when supervision started too, so a fresh install or a restored database cannot look drought-free forever
    // (nothing ever pushed) nor drought-struck at the first tick (the last push predates it).
    const base = Math.max(Number.isFinite(t) ? t : 0, Number(state.superviseSince) || 0);
    if (!base) return { skipped: 'no-data' };
    const ageMs = ctx.now() - base;
    if (ageMs > C.PUSH_DROUGHT_MS) {
      const hours = Math.round(ageMs / 360000) / 10;
      ctx.notify({
        severity: 'critical',
        key: 'push-drought',
        text: `No new candidate has reached Zoho for ${hours} h inside the operating window (queue ${pendingCount(ctx)}). No halt or session back-off explains it: check logs/tick-*.log and the dashboard (docs/OPERATIONS.md).`,
        meta: { hours },
      });
      return { alerted: true, hours };
    }
    return { ok: true };
  } catch (e) {
    return { skipped: `error:${e.code || e.message}` };
  } finally {
    if (db) { try { db.close(); } catch { /* ignore */ } }
  }
}

function defaultDiskGuard(ctx) {
  const m = require('./maintenance');
  return m.diskGuard(m.makeCtx({ home: ctx.home, notify: ctx.notify, now: ctx.now }));
}

async function slowChecks(ctx, state) {
  const step = (name, fn) => {
    try { return fn(); } catch (e) { ctx.log(`slow check ${name} failed: ${e.message}`, 'error'); return null; }
  };
  step('backup-age', () => require('./backup-db').checkAge({ home: ctx.home, notify: ctx.notify, now: ctx.now }));
  step('push-drought', () => checkPushDrought(ctx, state));
}

async function maybeMaintenance(ctx, state, opts) {
  const now = ctx.now();
  if (now - state.lastMaintenanceAt >= C.MAINT_INTERVAL_MS) {
    state.lastMaintenanceAt = now;
    // A full volume breaks database writes after a Zoho create, so it is watched while a run is in flight too.
    try { (ctx.diskGuard || defaultDiskGuard)(ctx); } catch (e) { ctx.log(`disk guard failed: ${e.message}`, 'error'); }
    // Recovery of a stranded run must not overlap a live run's browser, so it only runs when idle.
    if (!opts.busy) {
      try { releaseOrphanedLocks(ctx, { minAgeMs: C.ORPHAN_MIN_AGE_MS }); } catch (e) { ctx.log(`orphan release failed: ${e.message}`, 'error'); }
      try { await cullGhost(ctx); } catch (e) { ctx.log(`cull-ghost failed: ${e.message}`, 'error'); }
    }
    try { await runQueueDue(ctx); } catch (e) { ctx.log(`queue-due failed: ${e.message}`, 'error'); }
  }
  if (now - state.lastSlowCheckAt >= C.SLOW_CHECK_INTERVAL_MS) {
    state.lastSlowCheckAt = now;
    await (ctx.slowChecks || slowChecks)(ctx, state);
  }
}

// ---------------------------------------------------------------------------------------------
// run outcome policy

function num(v) {
  return v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
}

// The login module raises (and rate-limits) its own alerts for these reasons; repeating them every
// 15 minutes from here would defeat its re-notify policy.
const LOGIN_OWNED_REASONS = new Set(['safelist', 'login', 'cvdb-module']);

function sessionAlert(res) {
  if (res.reason === 'session-timeout') {
    return 'The Caterer sign-in did not finish within its 15 minute limit (the browser or the login page may be hung), so no run was started. The queue backs off 15 min and retries (docs/OPERATIONS.md, Caterer login).';
  }
  return 'The Caterer session went stale during a run (phase1 exit 2). The queue backs off 15 min and retries (docs/OPERATIONS.md, Caterer login).';
}

function handleResult(ctx, state, res) {
  const code = Number(res.exitCode);
  const endedMs = Date.parse(res.endedAt) || ctx.now();
  state.handledRunNonce = res.nonce || state.handledRunNonce;
  if (res.nonce) delete state.killedNonces[res.nonce];
  state.recentRuns.push({
    nonce: res.nonce || null, endedAt: res.endedAt || new Date(endedMs).toISOString(), exitCode: code, file: res.file || null,
    reason: res.reason || null, pool: num(res.pool), approved: num(res.approved), skippedDb: num(res.skippedDb),
    errors: num(res.errors), elapsedSec: num(res.elapsedSec),
  });
  if (state.recentRuns.length > C.RECENT_RUNS_KEPT) state.recentRuns.splice(0, state.recentRuns.length - C.RECENT_RUNS_KEPT);

  if (code === 11) {
    state.staleCooldownUntil = endedMs + C.STALE_COOLDOWN_MS;
    state.consecutiveFailures = 0;
    ctx.log(`CRITICAL runner exit 11 (Caterer session stale; auto-relogin failed) - backing off ${C.STALE_COOLDOWN_MS / 60000}m`, 'error');
    if (LOGIN_OWNED_REASONS.has(res.reason)) {
      ctx.log(`session back-off (${res.reason}): the login module owns the alert`);
    } else {
      ctx.notify({
        severity: 'critical', key: 'caterer-session', text: sessionAlert(res),
        meta: { reason: res.reason || null, retryAfter: new Date(state.staleCooldownUntil).toISOString() },
      });
    }
    return;
  }
  if (code === PHASE2_HELD_EXIT) {
    // The run unlocked its candidates but Phase 2 was HELD: CV screening (CV_SCREEN=on) could not reach Jev (or its criteria file is not usable).
    // Not a success (no failure counter is cleared, the never-screened check does not see it) and not a failure either: the territory is not at
    // fault, so no failure count, no quarantine and no run-failures alert, and no long back-off. Phase 2 raised the screening halt and its one
    // critical alert; the halt keeps every new run (and so every new unlock) from starting until the CV route answers a canary, and the queue
    // is retried by the stranded-run recovery once it clears.
    state.launchNotBefore = Math.max(state.launchNotBefore || 0, endedMs + C.POLL_MS);
    ctx.log('runner finished a run whose Phase 2 was HELD (CV screening could not run; nothing was lost) - no new run starts while the screening halt is up');
    return;
  }
  if (code === 0) {
    state.consecutiveFailures = 0;
    state.failStreakSince = 0;
    state.staleCooldownUntil = 0;
    clearTerritoryFailures(ctx, res.file);
    ctx.log(`runner finished a run (exit 0) - re-checking gate immediately for next territory`);
    const last3 = state.recentRuns.slice(-3);
    const unscreened = (r) => r.exitCode === 0 && r.pool !== null && r.pool === r.skippedDb && r.errors === 1 && !r.approved;
    if (last3.length === 3 && last3.every(unscreened)) {
      ctx.notify({
        severity: 'warn', key: 'never-screened',
        text: 'Three runs in a row saw only already-known candidates with 1 error each (pool equals DB skips): candidates may never have been screened. Check the halt banner and logs/phase1-console-*.log (docs/OPERATIONS.md).',
      });
    }
    return;
  }
  state.launchNotBefore = Math.max(state.launchNotBefore || 0, endedMs + C.POLL_MS);
  if (code === 10) return;
  state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
  if (state.consecutiveFailures === 1) state.failStreakSince = endedMs;
  ctx.log(`runner exited code ${code}${res.reason ? ` (${res.reason})` : ''} - will resume on next poll`);
  if (code === 13 && res.reason !== TICK_HARD_CAP) {
    ctx.notify({ severity: 'warn', key: 'run-killed', text: `A run for ${res.file || 'a territory'} exceeded 70 minutes and was killed; its territory is retried. Repeated kills point at a wedged browser (docs/OPERATIONS.md).` });
  }
  recordTerritoryFailure(ctx, state, res, code);
  const n = state.consecutiveFailures;
  const streakMs = endedMs - (state.failStreakSince || endedMs);
  const repeat = n > 3 && endedMs - (state.runFailAlertAt || 0) >= C.STREAK_REPEAT_MS;
  if (streakDue(n, 3, 10) || repeat) {
    state.runFailAlertAt = endedMs;
    const long = streakMs >= C.STREAK_CRITICAL_MS;
    ctx.notify({ severity: long ? 'critical' : 'warn', key: 'run-failures', text: `${n} pipeline runs in a row have failed${long ? ` over ${Math.round(streakMs / 3600000)} h` : ''} (last: exit ${code}${res.reason ? `, ${res.reason}` : ''}). See logs/watchdog-runner.jsonl and logs/phase1-console-*.log.` });
  }
}

const FAILURE_KEYS = ['failedRuns', 'lastFailure'];

function readPendingObject(ctx, file) {
  if (!file) return null;
  const fp = path.join(ctx.dirs.pending, path.basename(String(file)));
  const d = fsx.readJson(fp, null);
  return d && typeof d === 'object' && !Array.isArray(d) ? { fp, d } : null;
}

// A territory that just ran clean starts again from zero (normally its file is already gone).
function clearTerritoryFailures(ctx, file) {
  try {
    const p = readPendingObject(ctx, file);
    if (!p || !FAILURE_KEYS.some((k) => k in p.d)) return;
    for (const k of FAILURE_KEYS) delete p.d[k];
    fsx.writeJsonAtomic(p.fp, p.d);
  } catch { /* the counters are advisory */ }
}

// Counts a failure against the pending search that caused it and, at QUARANTINE_AFTER in a row, takes it out of the queue
// so the territories behind it can run. Failures the territory did not cause (session, screening, signals) never count, and
// neither do failures while several different territories are failing: that is the system, not one file.
function recordTerritoryFailure(ctx, state, res, code) {
  try {
    if (!territoryFault(code, res.reason)) return;
    const p = readPendingObject(ctx, res.file);
    if (!p) return;
    const name = path.basename(p.fp);
    const recent = state.recentRuns.slice(-C.SYSTEMIC_WINDOW);
    const failing = new Set(recent.filter((r) => Number(r.exitCode) !== 0 && Number(r.exitCode) !== 10 && r.file && territoryFault(Number(r.exitCode), r.reason)).map((r) => r.file));
    if (failing.size >= C.SYSTEMIC_DISTINCT) {
      ctx.log(`${failing.size} different territories failed among the last ${recent.length} runs: not counting this failure against ${name} (a system fault, see the run-failures alert)`, 'error');
      return;
    }
    const n = (Number(p.d.failedRuns) || 0) + 1;
    p.d.failedRuns = n;
    p.d.lastFailure = { at: new Date(ctx.now()).toISOString(), exitCode: code, reason: res.reason || null };
    fsx.writeJsonAtomic(p.fp, p.d);
    if (n < C.QUARANTINE_AFTER) {
      ctx.log(`territory ${name} has failed ${n} run(s) in a row (${C.QUARANTINE_AFTER} moves it to .quarantine/)`, 'error');
      return;
    }
    const why = `${n} failed runs in a row, last exit ${code}${res.reason ? ` (${res.reason})` : ''}`;
    const q = pendingGate.quarantineFile(ctx.dirs.pending, name, why);
    ctx.log(`CRITICAL territory ${name} quarantined: ${why}`, 'error');
    const detail = PHASE1_EXIT_TEXT[String(res.reason || '').replace('phase1-exit-', '')];
    ctx.notify({
      severity: 'critical', key: `territory-quarantined:${name}`,
      text: `Territory ${name} (${p.d.jobTitle || '?'} in ${p.d.location || '?'}) failed ${n} runs in a row (last: exit ${code}${res.reason ? `, ${res.reason}` : ''}${detail ? ` = ${detail}` : ''}) and was moved to pending-searches/.quarantine/ so the queue behind it keeps running. Read logs/phase1-console-*.log, fix the cause, then: node scripts/pipeline-watchdog.js --release-quarantine ${q} (docs/OPERATIONS.md).`,
      meta: { file: name, quarantinedAs: q, exitCode: code, reason: res.reason || null },
    });
  } catch (e) {
    ctx.log(`territory failure bookkeeping failed: ${e.message}`, 'error');
  }
}

// A run that died without a result (killed runner, killed instance) still holds the claim it stamped on its pending
// search; without this the gate would say SPAWNED for the 10-minute stale-spawn window before the territory is retried.
function releaseClaim(ctx, file) {
  if (!file) return;
  const fp = path.join(ctx.dirs.pending, path.basename(String(file)));
  try {
    const d = fsx.readJson(fp, null);
    if (!d || !d.spawnedAt) return;
    delete d.spawnedAt;
    fsx.writeJsonAtomic(fp, d);
    ctx.log(`released the claim on ${path.basename(fp)} (its run died without a result)`);
  } catch (e) {
    ctx.log(`claim release failed for ${path.basename(fp)}: ${e.message}`, 'error');
  }
}

// A killed runner cannot release runtime/browser.lock. Once its run is provably dead the file is only clutter (the next
// runner would take it over by pid liveness), and it makes a manual Reed tool look blocked; a live holder is never touched.
function clearStaleBrowserLock(ctx) {
  const file = path.join(ctx.files.dir, 'browser.lock');
  try {
    const rec = fsx.readJson(file, null);
    if (!rec || !Number.isInteger(rec.pid) || fsx.pidAlive(rec.pid)) return;
    fs.unlinkSync(file);
    ctx.log(`removed the browser lock of dead pid ${rec.pid} (${rec.owner || 'unknown'})`);
  } catch { /* raced with a new holder: leave it */ }
}

function clearRunRecord(ctx, insp) {
  const cur = tick.readRecord(ctx.files.run);
  if (!cur) return;
  const same = (cur.rec && insp.rec && cur.rec.nonce === insp.rec.nonce) || (!cur.rec && !insp.rec);
  if (same) { try { fs.unlinkSync(ctx.files.run); } catch { /* raced */ } }
}

function applyRunnerExits(ctx, state) {
  for (const [pid, ex] of ctx.runnerExits) {
    ctx.runnerExits.delete(pid);
    // Exit 10 writes no result; without a pause a READY-but-busy gate would relaunch in a tight loop.
    if (ex.code === 10 || ex.code === 1 || ex.code === null) state.launchNotBefore = Math.max(state.launchNotBefore || 0, ex.at + C.POLL_MS);
    // Exit 10 for half an hour with nothing else in between is a stuck lock or a recycled pid, not idleness.
    if (ex.code === 10) {
      const streak = state.exit10 || (state.exit10 = { since: ex.at, n: 0 });
      streak.n += 1;
      if (ex.at - streak.since >= C.EXIT10_ALERT_MS && ex.at - (state.exit10AlertAt || 0) >= C.STREAK_REPEAT_MS) {
        state.exit10AlertAt = ex.at;
        ctx.notify({ severity: 'warn', key: 'runner-busy', text: `The runner has answered "busy or nothing to do" ${streak.n} times over ${Math.round((ex.at - streak.since) / 60000)} min while the queue is READY, so nothing is running. Look for a stale runtime/browser.lock or .run-lock whose pid was reused (docs/OPERATIONS.md).` });
      }
    } else if (state.exit10) {
      delete state.exit10;
    }
  }
}

// Reconcile runtime/run.json with reality. Returns {busy, insp} while a run is alive; otherwise
// applies any finished result (normal or crashed) exactly once.
function reconcileRun(ctx, state) {
  const insp = tick.inspectRun(ctx.files.run, ctx.now());
  if (insp && insp.alive) return { busy: true, insp };
  let last = fsx.readJson(ctx.files.lastRun, null);
  // The runner reports the death of the child the tick ended as a plain phase1 failure; the tick knows why it ended it.
  if (last && last.nonce && state.killedNonces[last.nonce] === TICK_HARD_CAP && Number(last.exitCode) !== 0 && Number(last.exitCode) !== 10) {
    last = Object.assign({}, last, { exitCode: 13, reason: TICK_HARD_CAP });
  }
  const lastNew = last && last.nonce && last.nonce !== state.handledRunNonce ? last : null;
  const finished = [];
  if (lastNew) {
    handleResult(ctx, state, lastNew);
    finished.push(lastNew);
  }
  if (insp) {
    const nonce = insp.rec && insp.rec.nonce;
    const accounted = nonce && (nonce === state.handledRunNonce);
    if (!accounted) {
      const overrun = nonce && state.killedNonces[nonce];
      const crash = {
        nonce: nonce || `crash-${ctx.now()}`, exitCode: overrun ? 13 : 1,
        reason: overrun === 'logflood' ? 'log-flood-killed' : (overrun === TICK_HARD_CAP ? TICK_HARD_CAP : (overrun ? 'overrun-killed' : 'runner-crashed')),
        startedAt: insp.rec && insp.rec.startedAt, endedAt: new Date(ctx.now()).toISOString(),
        file: insp.rec && insp.rec.file,
      };
      if (!overrun) {
        ctx.notify({ severity: 'warn', key: 'runner-crashed', text: `A pipeline run ended without a result (its runner or phase1 process died${insp.rec && insp.rec.file ? `, territory file ${insp.rec.file}` : ''}). Orphaned locks were released and the territory is retried.` });
      }
      if (nonce) delete state.killedNonces[nonce];
      handleResult(ctx, state, crash);
      // A run that wedged for 70 minutes keeps its claim (the gate rotates to the next territory); a plain crash gives it back.
      if (!overrun) releaseClaim(ctx, insp.rec && insp.rec.file);
      clearStaleBrowserLock(ctx);
      finished.push(crash);
    }
    clearRunRecord(ctx, insp);
  }
  if (finished.some((f) => Number(f.exitCode) !== 0 && Number(f.exitCode) !== 10)) {
    try { releaseOrphanedLocks(ctx, { minAgeMs: 0 }); } catch (e) { ctx.log(`orphan release failed: ${e.message}`, 'error'); }
  }
  return { busy: false, finished };
}

const runAgeMs = (ctx, started) => tick.effectiveAgeMs(ctx.files.suspensions, started, ctx.now());

// A runaway loop can write faster than the 10 s supervise cadence notices, so the wrapper also sets a file-size limit;
// this catches the slower floods (retry storms, error spam) before they fill the volume: end the run, keep only the tail.
async function guardRunLogs(ctx, state, rec) {
  const logs = [rec.runLog, path.join(ctx.dirs.logs, `runner-${londonCompact(ctx)}.log`)].filter(Boolean);
  for (const f of logs) {
    let size;
    try { size = fs.statSync(f).size; } catch { continue; }
    if (size <= C.LOG_CAP_BYTES) continue;
    const isRunLog = f === rec.runLog;
    ctx.log(`CRITICAL ${path.basename(f)} is ${Math.round(size / 1048576)} MB (cap ${Math.round(C.LOG_CAP_BYTES / 1048576)} MB)${isRunLog ? ' - ending the run' : ''}`, 'error');
    if (isRunLog) {
      state.killedNonces[rec.nonce] = 'logflood';
      if (rec.childPid) await ctx.killTree(rec.childPid, { token: rec.childToken });
      if (rec.pid) await ctx.killTree(rec.pid, { token: rec.token });
    }
    try {
      const fd = fs.openSync(f, 'r');
      const keep = Buffer.alloc(Math.min(size, C.LOG_KEEP_BYTES));
      try { fs.readSync(fd, keep, 0, keep.length, size - keep.length); } finally { fs.closeSync(fd); }
      fs.truncateSync(f, 0);
      fs.appendFileSync(f, `[watchdog] log exceeded ${Math.round(C.LOG_CAP_BYTES / 1048576)} MB and was cut to its last ${Math.round(keep.length / 1024)} KB\n`);
      fs.appendFileSync(f, keep);
    } catch (e) {
      ctx.log(`could not truncate ${path.basename(f)}: ${e.message}`, 'error');
    }
    ctx.notify({ severity: 'critical', key: 'log-flood', text: `${path.basename(f)} grew past ${Math.round(C.LOG_CAP_BYTES / 1048576)} MB${isRunLog ? ', so the run was ended and its territory will be retried' : ''}. Something is printing in a loop: read the tail of the log (docs/OPERATIONS.md).` });
    return true;
  }
  return false;
}

async function superviseRun(ctx, state, insp) {
  const rec = insp.rec;
  if (!rec) return;
  if (await guardRunLogs(ctx, state, rec)) return;
  const started = Date.parse(rec.phase1StartedAt || rec.startedAt || '');
  const limit = ctx.maxRunMs + C.TICK_KILL_GRACE_MS;
  if (Number.isFinite(started) && runAgeMs(ctx, started) > limit) {
    // The age already excludes recorded freezes. Before ending a run the heartbeat is read twice: a runner
    // whose timers are running is not wedged, whatever the wall clock says (a freeze nobody has recorded yet).
    if (insp.runnerAlive) {
      const beating = await tick.heartbeatAdvances(ctx.files.run, ctx.heartbeatGraceMs, ctx.sleep);
      const age = runAgeMs(ctx, started);
      if (age <= limit || (beating && age <= limit + C.OVERRUN_HEALTHY_EXTRA_MS)) {
        ctx.log(`run ${rec.nonce} is past its ceiling by the wall clock but its runner is ${beating ? 'still heartbeating' : 'inside recorded frozen time'}: not killed`);
        return;
      }
    }
    // The runner arms its own 70-minute timer; reaching here means the runner itself is wedged.
    state.killedNonces[rec.nonce] = 'overrun';
    ctx.log(`CRITICAL run ${rec.nonce} exceeded ${Math.round(ctx.maxRunMs / 60000)} min and its runner did not act - killing`, 'error');
    if (rec.childPid) await ctx.killTree(rec.childPid, { token: rec.childToken });
    if (insp.runnerAlive) await ctx.killTree(rec.pid, { token: rec.token });
    return;
  }
  if (insp.runnerAlive && insp.heartbeatAgeMs > 15 * 60000 && ctx.now() - state.lastHeartbeatWarnAt > 30 * 60000) {
    state.lastHeartbeatWarnAt = ctx.now();
    ctx.log(`runner ${rec.pid} heartbeat is ${Math.round(insp.heartbeatAgeMs / 60000)} min old (still alive; the ${Math.round(ctx.maxRunMs / 60000)}-minute ceiling applies)`, 'error');
  }
}

// A run this tick launched cannot outlive it: one still in flight at the hard cap is ended like an overrun (child first, claim kept) and accounted for now.
async function endAtHardCap(ctx, state, o) {
  const insp = tick.inspectRun(ctx.files.run, ctx.now());
  const rec = insp && insp.alive ? insp.rec : null;
  if (!rec || !o.launchedPids.has(rec.pid)) return false;
  state.killedNonces[rec.nonce] = TICK_HARD_CAP;
  ctx.log(`CRITICAL run ${rec.nonce} is still in flight at the ${Math.round(o.hardCapMs / 60000)}-minute tick limit - ending it cleanly`, 'error');
  if (rec.childPid) await ctx.killTree(rec.childPid, { token: rec.childToken });
  const until = ctx.now() + C.HARD_CAP_RUNNER_EXIT_MS;
  let cur = tick.inspectRun(ctx.files.run, ctx.now());
  while (cur && cur.runnerAlive && ctx.now() < until) {
    await ctx.sleep(250);
    cur = tick.inspectRun(ctx.files.run, ctx.now());
  }
  if (cur && cur.runnerAlive) await ctx.killTree(rec.pid, { token: rec.token });
  if (!state.hardCapAlertAt || ctx.now() - state.hardCapAlertAt >= C.HARD_CAP_ALERT_GAP_MS) {
    state.hardCapAlertAt = ctx.now();
    ctx.notify({
      severity: 'warn', key: TICK_HARD_CAP,
      text: `A run${rec.file ? ` (${rec.file})` : ''} was still in flight when the tick reached its ${Math.round(o.hardCapMs / 60000)}-minute limit and was ended cleanly; its territory is retried later. A run must finish before the limit or it cannot survive the end of the tick: if this repeats, lower RESOURCER_LAUNCH_CUTOFF_MIN (docs/OPERATIONS.md).`,
      meta: { file: rec.file || null, nonce: rec.nonce },
    });
  }
  applyRunnerExits(ctx, state);
  reconcileRun(ctx, state);
  return true;
}

// ---------------------------------------------------------------------------------------------
// pre-flight and launch

// Fail closed: a run starts only when preflight-db says ok (or that a writer holds the lock). Anything else, including a check
// that crashed, holds the queue, because phase1 treats an unreadable database as "every candidate is new".
function dbFitCheck(ctx) {
  try {
    const r = ctx.dbFit ? ctx.dbFit() : require('./preflight-db').checkDb({ db: path.join(ctx.home, 'candidates.db'), busyTimeoutMs: 5000 });
    const ok = !!(r && (r.ok === true || DB_RUNNABLE.has(r.reason)));
    return { ok, reason: (r && r.reason) || (ok ? null : 'unknown'), detail: r && r.detail };
  } catch (e) {
    return { ok: false, reason: 'check-crashed', detail: String(e && e.message).slice(0, 100) };
  }
}

async function screeningCheck(ctx, deep) {
  let mod;
  try {
    mod = ctx.screening();
  } catch (e) {
    return { ok: false, reason: 'screening health module unavailable', detail: String(e.message).slice(0, 300) };
  }
  const limit = deep ? 90000 : 15000;
  try {
    const r = await withTimeout(Promise.resolve(mod.check({ deep })), limit, () => ({ ok: false, reason: 'screening gateway unreachable', detail: `health probe exceeded ${limit} ms` }));
    if (r && !r.ok && !r.remedy && r.key && mod.REMEDIES && mod.REMEDIES[r.key]) r.remedy = mod.REMEDIES[r.key];
    return r;
  } catch (e) {
    return { ok: false, reason: 'screening gateway unreachable', detail: String(e.message).slice(0, 300) };
  }
}

/**
 * Never start a run while AI screening is unavailable: a run against a dead dependency still
 * scrapes a territory, fails at the AI step and marks it searched (216 territories were burned
 * that way in one outage). Cheap probe on every READY tick, two consecutive misses to halt (a busy
 * service can miss one), deep canary only while halted and at most once per HALT_PROBE_MS.
 */
async function preflight(ctx, state, gate) {
  const job = gate.parsed && gate.parsed.pending ? `${gate.parsed.pending.jobTitle}/${gate.parsed.pending.location}` : 'unknown';
  const queueDepth = gate.parsed ? gate.parsed.queueDepth : '?';
  const now = ctx.now();

  // A missing, empty or corrupt candidates.db makes every candidate look new: screening and unlocks would be spent again.
  const dbc = dbFitCheck(ctx);
  if (!dbc.ok) {
    ctx.log(`candidates.db is not fit to run on (${dbc.reason}): holding ${job}`, 'error');
    if (!state.dbAlertAt || now - state.dbAlertAt > DB_ALERT_GAP_MS) {
      state.dbAlertAt = now;
      ctx.notify({ severity: 'critical', key: 'db-unfit', text: `candidates.db is not fit to run on (${dbc.reason}${dbc.detail ? `: ${dbc.detail}` : ''}). Nothing is started: without it every candidate looks new and would be screened and unlocked again. ${DB_REMEDY[dbc.reason] || DB_REMEDY_DEFAULT} (docs/OPERATIONS.md)`, meta: { reason: dbc.reason } });
    }
    return { ok: false, reason: 'db-unfit' };
  }

  const cheap = await screeningCheck(ctx, false);
  if (!cheap.ok) {
    if (now - state.probeFail.lastAt > C.PROBE_STREAK_EXPIRE_MS) state.probeFail.count = 0;
    state.probeFail.count += 1;
    state.probeFail.lastAt = now;
    if (state.probeFail.count < C.PROBE_FAILS_BEFORE_HALT) {
      ctx.log(`screening probe failed (${state.probeFail.count}/${C.PROBE_FAILS_BEFORE_HALT}: ${cheap.reason}) - could just be a busy service; holding ${job} this tick without halting.`, 'error');
      return { ok: false, reason: 'probe-miss' };
    }
    const reason = cheap.reason || 'screening gateway unreachable';
    ctx.halt.setHalt(reason, cheap.detail || 'The screening health probe failed twice in a row, so every AI screening call would fail. Holding the queue instead of burning territories.', { remedy: cheap.remedy || REMEDY, blockedRun: true });
    ctx.log(`CRITICAL pipeline HALTED - ${reason}. Holding ${job} and ${queueDepth} queued territories (none consumed).`, 'error');
    return { ok: false, reason: 'halted' };
  }
  state.probeFail = { count: 0, lastAt: 0 };

  const halted = ctx.halt.getHalt();
  if (halted && halted.halted) {
    if (now < state.haltProbeAt) {
      ctx.log(`pipeline still HALTED (${halted.reason}) - holding ${job}; next verify in ${Math.round((state.haltProbeAt - now) / 1000)}s`, 'error');
      return { ok: false, reason: 'halted' };
    }
    state.haltProbeAt = now + C.HALT_PROBE_MS;
    ctx.log(`halted (${halted.reason}) - verifying screening before resuming`);
    const deep = await screeningCheck(ctx, true);
    if (!deep.ok) {
      ctx.halt.setHalt(deep.reason || 'screening gateway unreachable', deep.detail || '', { remedy: deep.remedy || REMEDY });
      ctx.log(`still HALTED: ${deep.reason}`, 'error');
      return { ok: false, reason: 'halted' };
    }
    if (!clearVerifiedHalt(ctx, state)) return { ok: false, reason: 'halted' };
    ctx.log('screening healthy again - halt cleared, queue resumes');
  }

  const mem = ctx.memAvailMb();
  if (mem < C.MIN_MEM_MB) {
    ctx.log(`only ${mem} MB memory available (< ${C.MIN_MEM_MB} MB): not starting ${job} this tick`, 'error');
    ctx.notify({ severity: 'warn', key: 'low-memory', text: `Memory is low (${mem} MB available, floor ${C.MIN_MEM_MB} MB), so the next territory is held until it recovers. Another profile on the instance may be using it (docs/OPERATIONS.md).`, meta: { availMb: mem } });
    return { ok: false, reason: 'low-memory' };
  }
  return { ok: true, job, queueDepth };
}

// Clear the screening halt after a healthy verification, unless that would be the third clear within FLAP_WINDOW_MS while a held queue is waiting
// (see FLAP_MAX_CLEARS). Clears with no held queue (a snippet outage, a key problem) are never counted. Returns true when the halt was cleared.
function clearVerifiedHalt(ctx, state) {
  const now = ctx.now();
  if (hasHeldQueue(ctx)) {
    state.heldClears = (Array.isArray(state.heldClears) ? state.heldClears : []).filter((t) => Number.isFinite(t) && t <= now && now - t < C.FLAP_WINDOW_MS);
    if (state.heldClears.length >= C.FLAP_MAX_CLEARS) {
      state.haltProbeAt = now + C.FLAP_PROBE_MS;
      ctx.halt.setHalt('screening halt keeps returning',
        `The supervisor cleared the screening halt ${state.heldClears.length} times in the last ${Math.round(C.FLAP_WINDOW_MS / 3600000)} h and CV screening held the queue again each time: the CV route answers its small test request but fails on real CVs. Nothing more is unlocked and the held queue is kept.`,
        { remedy: 'Look at the CV route (the Phase 2 log and node scripts/cv-report.js --days 1 --mode on), fix the cause, then node scripts/pipeline-halt-cli.js clear (docs/OPERATIONS.md section 6). Or set CV_SCREEN shadow.' });
      ctx.log('screening verifies healthy, but the halt has returned after every clear: NOT clearing it again (needs a manual clear)', 'error');
      return false;
    }
    state.heldClears.push(now);
  } else {
    state.heldClears = [];
  }
  ctx.halt.clearHalt();
  return true;
}

// A queue that CV screening HELD (phase2Hold in its status file) is retried by the stranded-run recovery only once the screening halt is gone, and the halt
// is otherwise re-verified only when a READY pending search exists. With the queue empty (the held run's own pending search was consumed) the halt would
// wait for the next queued territory, so the tick verifies it on the same 60 s rate when a held queue is waiting.
function hasHeldQueue(ctx) {
  let names;
  try { names = fs.readdirSync(ctx.dirs.runs); } catch { return false; }
  for (const f of names) {
    if (!/^phase1-.*\.json$/.test(f)) continue;
    try {
      const raw = fs.readFileSync(path.join(ctx.dirs.runs, f), 'utf8');
      const d = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
      // the same cut-offs as the recovery: a run older than 7 days, or one the recovery gave up on, is not waiting for anything
      const started = Date.parse(d && (d.startedAt || d.updatedAt));
      if (Number.isFinite(started) && Date.now() - started > 7 * 24 * 60 * 60 * 1000) continue;
      if (d && d.phase2Recovery && d.phase2Recovery.gaveUp) continue;
      if (d && d.phase2Hold && d.status !== 'complete' && !d.phase2Complete) return true;
    } catch { /* unreadable: skip */ }
  }
  return false;
}

async function verifyHeldHalt(ctx, state) {
  const halted = ctx.halt.getHalt();
  if (!halted || !halted.halted) return { checked: false };
  if (ctx.now() < state.haltProbeAt) return { checked: false };
  if (!hasHeldQueue(ctx)) return { checked: false };
  state.haltProbeAt = ctx.now() + C.HALT_PROBE_MS;
  ctx.log(`halted (${halted.reason}) and a held queue is waiting - verifying screening before it is retried`);
  const deep = await screeningCheck(ctx, true);
  if (!deep.ok) {
    ctx.halt.setHalt(deep.reason || 'screening gateway unreachable', deep.detail || '', { remedy: deep.remedy || REMEDY });
    ctx.log(`still HALTED: ${deep.reason}`, 'error');
    return { checked: true, ok: false };
  }
  if (!clearVerifiedHalt(ctx, state)) return { checked: true, ok: false };
  ctx.log('screening healthy again - halt cleared, the held queue is retried by the recovery');
  return { checked: true, ok: true };
}

async function launchRunner(ctx, state, gate, info) {
  fsx.ensureDir(ctx.dirs.logs);
  const logPath = path.join(ctx.dirs.logs, `runner-${londonCompact(ctx)}.log`);
  const fd = fs.openSync(logPath, 'a');
  let child;
  try {
    child = ctx.spawnRunner({ args: ['--from-gate'], fd });
  } catch (e) {
    ctx.log(`runner spawn threw: ${e.message}`, 'error');
    state.launchNotBefore = ctx.now() + C.POLL_MS;
    return { launched: false, reason: 'spawn-error' };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
  ctx.log(`READY (${info.job}, queueDepth=${info.queueDepth}) - started watchdog-runner (pid ${child.pid})`);
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal, at: ctx.now() };
    ctx.runnerExits.set(child.pid, exited);
  });
  child.on('error', (err) => {
    ctx.log(`runner child error: ${err.message}`, 'error');
    state.launchNotBefore = Math.max(state.launchNotBefore || 0, ctx.now() + C.POLL_MS);
    exited = exited || { code: 1, signal: null, at: ctx.now() };
  });
  const until = ctx.now() + C.REGISTER_WAIT_MS;
  while (ctx.now() < until && !exited) {
    const insp = tick.inspectRun(ctx.files.run, ctx.now());
    if (insp && insp.rec && insp.rec.pid === child.pid) break;
    await ctx.sleep(100);
  }
  return { launched: true, pid: child.pid };
}

// ---------------------------------------------------------------------------------------------
// the tick

// A frozen-then-resumed instance shows up as a gap between two clocks. Record it, so every age
// comparison excludes it, and ask the next iteration to re-read the heartbeats before it decides anything.
function noteClockJump(ctx, state, o, j) {
  if (!j) return;
  const list = tick.recordSuspension(ctx.files.suspensions, j.fromMs, j.toMs, ctx.now());
  state.lastClockJumpAt = j.toMs;
  o.resumePending = true;
  ctx.log(`clock jumped ${Math.round(j.jumpMs / 1000)}s (${j.kind}): the instance was probably suspended; run and heartbeat ages exclude it${list ? '' : ' (ledger not writable)'}`, 'error');
}

// After a suspected resume the live processes have not run their timers yet: wait one grace period so the runner
// can record the gap, and read the run heartbeat twice, before this iteration decides anything.
async function settleAfterResume(ctx, state, o, quiet) {
  if (!(quiet || o.resumePending)) return null;
  o.resumePending = false;
  if (!tick.inFlightHints(ctx.files)) return null;
  const advancing = await tick.heartbeatAdvances(ctx.files.run, ctx.heartbeatGraceMs, ctx.sleep);
  state.lastResume = { at: new Date(ctx.now()).toISOString(), quiet: !!quiet, runHeartbeatAdvancing: advancing };
  ctx.log(`resume check: a run is in flight and its heartbeat is ${advancing ? 'advancing' : 'not advancing'} after ${Math.round(ctx.heartbeatGraceMs / 1000)}s`);
  return { advancing };
}

async function iterate(ctx, state, o) {
  const now = ctx.now();
  const prevTickAt = state.lastTickAt;
  state.lastTickAt = now;
  await settleAfterResume(ctx, state, o, !!prevTickAt && now - prevTickAt > C.RESUME_GAP_MS);
  applyRunnerExits(ctx, state);

  const rec = reconcileRun(ctx, state);
  if (rec.busy) {
    await superviseRun(ctx, state, rec.insp);
    await maybeMaintenance(ctx, state, { busy: true });
    return { sleepMs: o.superviseMs, ownRun: !!(o.launchedPids && rec.insp.rec && o.launchedPids.has(rec.insp.rec.pid)) };
  }
  applyRunnerExits(ctx, state);

  // A recovered child that outlives the run ceiling is wedged: end it instead of blocking the queue.
  for (const a of tick.readAdopted(ctx.files)) {
    const added = Date.parse(a.addedAt || '');
    if (Number.isFinite(added) && tick.effectiveAgeMs(ctx.files.suspensions, added, ctx.now()) > tick.ADOPTED_MAX_AGE_MS && tick.isAlive(a)) {
      ctx.log(`CRITICAL recovered process ${a.pid} (${a.id || a.mode}) is older than ${Math.round(tick.ADOPTED_MAX_AGE_MS / 60000)} min - killing`, 'error');
      await ctx.killTree(a.pid, { token: a.token });
    }
  }

  // Recovered stranded runs and live per-status run-locks are also "a run in flight".
  const other = ctx.busy ? ctx.busy() : tick.busyState({ home: ctx.home, now: ctx.now() });
  if (other.busy) {
    await maybeMaintenance(ctx, state, { busy: true });
    return { sleepMs: o.superviseMs };
  }

  await maybeMaintenance(ctx, state, { busy: false });

  // Past the launch cutoff nothing new starts (it could not finish before the tick ends); the tick only waits out what is running.
  if (o.launchCutoffMs !== undefined && o.elapsedMs && o.elapsedMs() >= o.launchCutoffMs) {
    const late = ctx.busy ? ctx.busy() : tick.busyState({ home: ctx.home, now: ctx.now() });
    if (late.busy) return { sleepMs: o.superviseMs };
    return { exit: true, reason: 'launch-cutoff' };
  }

  const inWindow = ctx.inWindow ? ctx.inWindow(ctx.now()) : inOperatingHours(new Date(ctx.now()));
  if (!inWindow) return { exit: true, reason: 'outside-window' };
  if (ctx.now() < state.staleCooldownUntil) return { exit: true, reason: 'cooldown' };
  if (ctx.now() < state.launchNotBefore) return { exit: true, reason: 'launch-backoff' };

  let gate = await checkGate(ctx);
  if (gate.status === 'LOCKED') {
    // Not busy by PID, yet the gate is locked: a crashed run left a non-terminal status file.
    releaseOrphanedLocks(ctx, { minAgeMs: C.ORPHAN_MIN_AGE_MS });
    gate = await checkGate(ctx);
  }
  if (gate.status === 'ERROR') {
    ctx.log(`gate check failed: ${gate.raw}`, 'error');
    state.gateErrors = (state.gateErrors || 0) + 1;
    if (streakDue(state.gateErrors, 5, 60)) {
      ctx.notify({ severity: 'warn', key: 'gate-error', text: `The queue gate has failed ${state.gateErrors} checks in a row (${String(gate.raw).slice(0, 120)}), so nothing can start. Check pending-searches/ for unreadable files (docs/OPERATIONS.md).` });
    }
  } else {
    state.gateErrors = 0;
  }
  if (gate.status !== 'READY') {
    try { await verifyHeldHalt(ctx, state); } catch { /* a failed verification is retried on the next tick */ }
    return { exit: true, reason: `gate-${gate.status.toLowerCase()}` };
  }

  const pf = await preflight(ctx, state, gate);
  if (!pf.ok) return { exit: true, reason: pf.reason };

  // A tick that was frozen through a takeover finishes its iteration once it resumes; it must not launch.
  if (o.lock && !o.lock.stillOwner()) {
    ctx.log('tick lock was taken over during this iteration - not launching', 'error');
    return { exit: true, reason: 'lock-lost' };
  }
  const l = await launchRunner(ctx, state, gate, pf);
  if (!l.launched) return { exit: true, reason: l.reason };
  o.launched = (o.launched || 0) + 1;
  if (o.launchedPids) o.launchedPids.add(l.pid);
  return { sleepMs: 1000, ownRun: true };
}

// Sleeps in one-second steps so a signal is honoured quickly; a step that took far longer than asked
// means the instance was frozen inside it.
async function sleepStoppable(ctx, ms, guard, onJump) {
  let left = ms;
  while (left > 0 && !ctx.stop) {
    const step = Math.min(left, 1000);
    if (guard) guard.mark();
    await ctx.sleep(step);
    if (guard) onJump(guard.check(step));
    left -= step;
  }
}

// A live holder whose lock merely looks stale was probably frozen: one grace period to prove it before its lock is taken.
async function holderProvesAlive(ctx) {
  const cur = tick.readRecord(ctx.files.tickLock);
  if (!cur || !cur.rec || cur.readError) return false;
  const stale = (c) => !c || tick.effectiveAgeMs(ctx.files.suspensions, c.mtimeMs, Date.now()) > C.TICK_LOCK_STALE_MS;
  if (!stale(cur) || !tick.isAlive(cur.rec, { heartbeatAgeMs: Date.now() - cur.mtimeMs })) return false;
  await tick.heartbeatAdvances(ctx.files.tickLock, ctx.heartbeatGraceMs, ctx.sleep);
  return !stale(tick.readRecord(ctx.files.tickLock));
}

const positiveMin = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt);

// Cutoff in [floor, maxMin - margin], hard cap in [maxMin, max]; a tick under DRAIN_MIN_TICK_MIN (tests, smoke checks) has no room for either and ends at its bound.
function tickLimits(maxMin, o) {
  if (maxMin < C.DRAIN_MIN_TICK_MIN) return { cutoffMs: undefined, hardCapMs: maxMin * 60000 };
  const cutoff = Math.max(C.LAUNCH_CUTOFF_FLOOR_MIN, Math.min(positiveMin(o.launchCutoffMin, C.LAUNCH_CUTOFF_DEFAULT_MIN), maxMin - C.LAUNCH_CUTOFF_MARGIN_MIN));
  const hardCap = Math.max(maxMin, Math.min(positiveMin(o.hardCapMin, C.TICK_HARD_CAP_DEFAULT_MIN), C.TICK_HARD_CAP_MAX_MIN));
  return { cutoffMs: cutoff * 60000, hardCapMs: hardCap * 60000 };
}

async function runTick(ctx, opts) {
  const o = Object.assign({ maxMinutes: C.MAX_TICK_MIN_CAP, once: false, superviseMs: C.SUPERVISE_MS, pollMs: C.POLL_MS, launched: 0 }, opts);
  const maxMin = Math.max(1, Math.min(Number(o.maxMinutes) || C.MAX_TICK_MIN_CAP, C.MAX_TICK_MIN_CAP));
  const startedAt = ctx.now();
  const deadline = startedAt + maxMin * 60000;
  const limits = tickLimits(maxMin, o);
  // Frozen time is excluded, so a resumed instance is not taken for a tick that ran its whole length.
  const elapsedMs = () => tick.effectiveAgeMs(ctx.files.suspensions, startedAt, ctx.now());
  o.launchCutoffMs = limits.cutoffMs;
  o.hardCapMs = limits.hardCapMs;
  o.elapsedMs = elapsedMs;
  o.launchedPids = new Set();
  const contended = await holderProvesAlive(ctx);
  const lock = contended ? { ok: false, holder: (tick.readRecord(ctx.files.tickLock) || {}).rec } : tick.acquireLock(ctx.files.tickLock, { info: { role: 'tick' }, staleMs: C.TICK_LOCK_STALE_MS, now: Date.now, suspensionFile: ctx.files.suspensions });
  if (!lock.ok) {
    ctx.log(`tick already running (pid ${lock.holder && lock.holder.pid}) - exiting`);
    return { exitCode: 0, reason: 'overlap', iterations: 0 };
  }
  const state = loadState(ctx);
  state.lastTickStartedAt = startedAt;
  if (!state.superviseSince) state.superviseSince = startedAt;
  touchHeartbeat(ctx);
  const min = (ms) => Math.round(ms / 60000);
  const limitsText = limits.cutoffMs === undefined ? `no launch cutoff or drain (a tick under ${C.DRAIN_MIN_TICK_MIN} min)` : `launch cutoff ${min(limits.cutoffMs)} min, hard cap ${min(limits.hardCapMs)} min`;
  ctx.log(`tick start: bound ${maxMin} min, ${limitsText}`);
  const out = { exitCode: 0, reason: null, iterations: 0, state };
  const guard = tick.makeClockGuard({ wall: ctx.now, mono: ctx.mono, thresholdMs: ctx.clockJumpMs });
  o.lock = lock;
  const onJump = (j) => noteClockJump(ctx, state, o, j);
  try {
    for (;;) {
      out.iterations++;
      if (ctx.stop) { out.reason = 'signal'; break; }
      if (!lock.heartbeat()) { out.reason = 'lock-lost'; ctx.log('tick lock was taken over - exiting without acting', 'error'); break; }
      touchHeartbeat(ctx);
      let step;
      try {
        step = await iterate(ctx, state, o);
      } catch (e) {
        ctx.log(`iteration failed: ${e.stack || e.message}`, 'error');
        step = { exit: true, reason: 'iteration-error' };
        out.exitCode = 1;
      }
      onJump(guard.check());
      // A tick whose lock was taken over while it was frozen must not overwrite the new owner's state.
      if (lock.stillOwner()) saveState(ctx, state);
      if (step.exit) { out.reason = step.reason; break; }
      if (o.once) { out.reason = 'once'; break; }
      // Past the bound the tick stays only for the run it launched itself (a run adopted from an earlier tick is left, as always).
      const draining = limits.cutoffMs !== undefined && ctx.now() >= deadline && !!step.ownRun;
      if (ctx.now() >= deadline && !draining) { out.reason = 'bound'; break; }
      if (draining && elapsedMs() >= o.hardCapMs) {
        if (!lock.stillOwner()) { out.reason = 'lock-lost'; break; }
        out.reason = (await endAtHardCap(ctx, state, o)) ? TICK_HARD_CAP : 'bound';
        if (lock.stillOwner()) saveState(ctx, state);
        break;
      }
      const room = draining ? o.hardCapMs - elapsedMs() : deadline - ctx.now();
      await sleepStoppable(ctx, Math.max(0, Math.min(step.sleepMs, room)), guard, onJump);
    }
  } finally {
    if (lock.stillOwner()) {
      state.lastTickEndedAt = ctx.now();
      saveState(ctx, state);
      touchHeartbeat(ctx);
    }
    lock.release();
  }
  out.launched = o.launched;
  return out;
}

// ---------------------------------------------------------------------------------------------
// CLI

const USAGE = [
  'Usage: node scripts/pipeline-watchdog.js <mode>',
  '  --tick [--max-minutes N]   supervision tick (N <= 55; default 55). From 20 minutes up it stops launching runs at',
  '                             RESOURCER_LAUNCH_CUTOFF_MIN (default 38), waits out the run it launched and ends it at',
  '                             RESOURCER_TICK_HARD_CAP_MIN (default 56, at most 56)',
  '  --once                     run a single iteration',
  '  --queue-due                queue due territories (idempotent, safe to run any time)',
  '  --status [--scan]          print supervision state as JSON',
  '  --clear-cooldown           drop the exit-11 back-off and the launch back-off',
  '  --release-quarantine FILE  put a quarantined pending search (pending-searches/.quarantine/FILE) back in the queue',
  '  --help',
].join('\n');

function scanProcesses() {
  const out = [];
  if (process.platform !== 'linux') return out;
  const re = new RegExp(runnerLib.PIPELINE_PROC_RE);
  let names;
  try { names = fs.readdirSync('/proc'); } catch { return out; }
  for (const n of names) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').split('\0').join(' ');
      if (re.test(cmd) && !/pipeline-watchdog|--status/.test(cmd)) out.push({ pid: Number(n), cmd: cmd.slice(0, 160) });
    } catch { /* exited */ }
  }
  return out;
}

function statusReport(ctx, scan) {
  const state = loadState(ctx);
  const now = ctx.now();
  const lock = tick.readLockHolder(ctx.files.tickLock);
  const insp = tick.inspectRun(ctx.files.run, now);
  const halted = (() => { try { return ctx.halt.getHalt(); } catch { return null; } })();
  const report = {
    ts: new Date(now).toISOString(),
    london: timeLib.londonParts(new Date(now)),
    inOperatingHours: inOperatingHours(new Date(now)),
    tick: lock && lock.rec ? { pid: lock.rec.pid, alive: tick.isAlive(lock.rec, { heartbeatAgeMs: lock.ageMs }), heartbeatAgeSec: Math.round(lock.ageMs / 1000) } : null,
    run: insp && insp.rec ? {
      pid: insp.rec.pid, alive: insp.alive, kind: insp.runnerAlive ? 'runner' : (insp.childAlive ? 'child' : 'dead'),
      startedAt: insp.rec.startedAt, file: insp.rec.file || null, childPid: insp.rec.childPid || null,
    } : null,
    busy: tick.busyState({ home: ctx.home, now }).busy,
    cooldownUntil: state.staleCooldownUntil ? new Date(state.staleCooldownUntil).toISOString() : null,
    launchNotBefore: state.launchNotBefore ? new Date(state.launchNotBefore).toISOString() : null,
    halt: halted && halted.halted ? { reason: halted.reason, since: halted.since } : null,
    queueDepth: pendingCount(ctx),
    quarantined: pendingGate.listQuarantined(ctx.dirs.pending),
    consecutiveFailures: state.consecutiveFailures,
    lastTickAt: state.lastTickAt ? new Date(state.lastTickAt).toISOString() : null,
    lastMaintenanceAt: state.lastMaintenanceAt ? new Date(state.lastMaintenanceAt).toISOString() : null,
    lastClockJumpAt: state.lastClockJumpAt ? new Date(state.lastClockJumpAt).toISOString() : null,
    recentRuns: state.recentRuns.slice(-5),
  };
  if (scan) report.untrackedProcesses = scanProcesses().filter((p) => !(insp && insp.rec && (p.pid === insp.rec.pid || p.pid === insp.rec.childPid)));
  return report;
}

async function main(argv) {
  const has = (f) => argv.includes(f);
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  if (has('--help') || has('-h')) { console.log(USAGE); return 0; }
  const modes = ['--tick', '--once', '--queue-due', '--status', '--clear-cooldown', '--release-quarantine'].filter(has);
  if (modes.length !== 1) { console.error(USAGE); return 2; }
  const known = new Set(['--tick', '--once', '--queue-due', '--status', '--clear-cooldown', '--release-quarantine', '--max-minutes', '--scan']);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max-minutes' || argv[i] === '--release-quarantine') { i++; continue; }
    if (!known.has(argv[i])) { console.error(`unknown argument '${argv[i]}'\n${USAGE}`); return 2; }
  }
  const ctx = makeCtx();

  if (has('--status')) { console.log(JSON.stringify(statusReport(ctx, has('--scan')), null, 2)); return 0; }
  if (has('--clear-cooldown')) {
    const s = loadState(ctx);
    s.staleCooldownUntil = 0;
    s.launchNotBefore = 0;
    saveState(ctx, s);
    console.log('cooldown cleared');
    return 0;
  }
  if (has('--release-quarantine')) {
    const r = pendingGate.releaseQuarantined(ctx.dirs.pending, val('--release-quarantine'));
    if (!r.ok) { console.error(`release failed: ${r.error}`); return 1; }
    console.log(`released ${r.file}: back in the queue with its failure count cleared`);
    return 0;
  }
  if (has('--queue-due')) {
    const r = await runQueueDue(ctx);
    if (r.ok === false) return 1;
    return 0;
  }

  const onSignal = () => { ctx.stop = true; };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  const configured = Number(val('--max-minutes') || env.get('RESOURCER_MAX_TICK_MIN', C.MAX_TICK_MIN_CAP));
  const r = await runTick(ctx, {
    maxMinutes: configured, once: has('--once'),
    launchCutoffMin: env.get('RESOURCER_LAUNCH_CUTOFF_MIN', C.LAUNCH_CUTOFF_DEFAULT_MIN),
    hardCapMin: env.get('RESOURCER_TICK_HARD_CAP_MIN', C.TICK_HARD_CAP_DEFAULT_MIN),
  });
  ctx.log(`tick end: ${r.reason} (iterations ${r.iterations}, launched ${r.launched || 0})`);
  return r.exitCode || (ctx.criticalLost ? 1 : 0);
}

module.exports = {
  C, NONTERMINAL_STATUSES, PIPELINE_PROC_RE: runnerLib.PIPELINE_PROC_RE,
  inOperatingHours, tickLimits, makeCtx, dbFitCheck, streakDue, recordTerritoryFailure, guardRunLogs, releaseClaim, clearStaleBrowserLock, loadState, saveState, defaultState, checkGate, releaseOrphanedLocks, cullGhost, runQueueDue,
  checkPushDrought, slowChecks, handleResult, reconcileRun, superviseRun, settleAfterResume, noteClockJump, preflight, verifyHeldHalt, clearVerifiedHalt, hasHeldQueue, launchRunner, iterate, runTick, statusReport,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`[watchdog] fatal ${env.redact(e && e.stack ? e.stack : String(e))}`);
    process.exit(1);
  });
}
