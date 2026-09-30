'use strict';
// PID-liveness locks, heartbeat helpers and the run/adopted-process registry shared by the
// watchdog tick, the runner and maintenance. Liveness is decided by PID plus a process identity
// token (boot id + start time from /proc on Linux), never by scanning command lines.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fsx = require('./fsx');
const paths = require('./paths');

const INIT_GRACE_MS = 30000;
const STEAL_MUTEX_STALE_MS = 5000;
const RUN_LOCK_MAX_AGE_MS = 60 * 60 * 1000;
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;
// A recovered process older than the 70-minute run ceiling plus the tick's grace is wedged.
const ADOPTED_MAX_AGE_MS = 72 * 60 * 1000;
// A clock gap this far beyond what the code slept or measured on the monotonic clock is a frozen instance.
const CLOCK_JUMP_MS = 60 * 1000;
const SUSPENSION_KEEP_MS = 48 * 60 * 60 * 1000;
const SUSPENSION_FILE = 'clock-jumps.json';

function runtimeFiles(home) {
  const base = home ? path.resolve(home) : paths.HOME;
  const dir = path.join(base, 'runtime');
  return {
    home: base,
    dir,
    runs: path.join(base, 'runs'),
    logs: path.join(base, 'logs'),
    tickLock: path.join(dir, 'tick.lock'),
    tickHeartbeat: path.join(dir, 'tick.heartbeat'),
    run: path.join(dir, 'run.json'),
    lastRun: path.join(dir, 'last-run.json'),
    state: path.join(dir, 'watchdog-state.json'),
    adopted: path.join(dir, 'adopted-procs.json'),
    queueDueLock: path.join(dir, 'queue-due.lock'),
    queueDueState: path.join(dir, 'queue-due-state.json'),
    suspensions: path.join(dir, SUSPENSION_FILE),
  };
}

// Frozen-instance ledger: a resumed instance makes every heartbeat and start time look hours old although
// nothing died, so any process that sees the gap records it and every age comparison subtracts it.

function readSuspensions(file) {
  const list = fsx.readJson(file, []);
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && Number.isFinite(e.from) && Number.isFinite(e.to) && e.to > e.from)
    .map((e) => ({ from: Number(e.from), to: Number(e.to) }))
    .sort((a, b) => a.from - b.from);
}

// Merges overlapping intervals (two processes see the same freeze) and forgets old ones.
function recordSuspension(file, fromMs, toMs, nowMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const merged = [];
  const all = readSuspensions(file).concat([{ from: Math.round(fromMs), to: Math.round(toMs) }]).sort((a, b) => a.from - b.from);
  for (const e of all) {
    const last = merged[merged.length - 1];
    if (last && e.from <= last.to + 1000) last.to = Math.max(last.to, e.to);
    else merged.push({ from: e.from, to: e.to });
  }
  const kept = merged.filter((e) => e.to > now - SUSPENSION_KEEP_MS);
  try {
    fsx.writeJsonAtomic(file, kept);
  } catch {
    return null;
  }
  return kept;
}

function suspendedMs(file, startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  let total = 0;
  for (const e of readSuspensions(file)) {
    const a = Math.max(e.from, startMs);
    const b = Math.min(e.to, endMs);
    if (b > a) total += b - a;
  }
  return total;
}

// Wall time since startMs minus the time the instance was frozen; never negative.
function effectiveAgeMs(file, startMs, nowMs) {
  if (!Number.isFinite(startMs)) return 0;
  return Math.max(0, nowMs - startMs - suspendedMs(file, startMs, nowMs));
}

// check(expectedMs) reports a jump when wall time ran ahead of monotonic time, or overshot the span the caller expected.
function makeClockGuard(opts) {
  const o = Object.assign({ wall: () => Date.now(), mono: () => Number(process.hrtime.bigint() / 1000000n), thresholdMs: CLOCK_JUMP_MS }, opts);
  let lastWall = o.wall();
  let lastMono = o.mono();
  return {
    mark() {
      lastWall = o.wall();
      lastMono = o.mono();
    },
    check(expectedMs) {
      const w = o.wall();
      const m = o.mono();
      const dWall = w - lastWall;
      const dMono = m - lastMono;
      lastWall = w;
      lastMono = m;
      const byClocks = dWall - dMono;
      const byGap = Number.isFinite(expectedMs) ? dWall - expectedMs : 0;
      const jump = Math.max(byClocks, byGap);
      if (!(jump >= o.thresholdMs)) return null;
      return { fromMs: w - jump, toMs: w, jumpMs: jump, kind: byClocks >= byGap ? 'clock' : 'gap' };
    },
  };
}

let cachedBootId;
function bootId() {
  if (cachedBootId === undefined) {
    try { cachedBootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { cachedBootId = ''; }
  }
  return cachedBootId;
}

// /proc/<pid>/stat field 22 (starttime) is the 20th token after the ')' that closes the comm field.
function procInfo(pid) {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const f = stat.slice(close + 2).split(' ');
    if (!f[19]) return null;
    return { state: f[0], token: `${bootId()}:${f[19]}` };
  } catch {
    return null;
  }
}

function procToken(pid) {
  const info = procInfo(pid);
  return info ? info.token : null;
}

function isAlive(rec, opts) {
  const o = opts || {};
  if (!rec) return false;
  const pid = Number(rec.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!fsx.pidAlive(pid)) return false;
  const info = procInfo(pid);
  if (info) {
    if (info.state === 'Z' || info.state === 'X') return false;
    if (rec.token && rec.token !== info.token) return false;
    return true;
  }
  // Without /proc identity a recycled pid is only ruled out by a fresh heartbeat.
  if (typeof o.heartbeatAgeMs === 'number') return o.heartbeatAgeMs <= (o.heartbeatStaleMs || HEARTBEAT_STALE_MS);
  return true;
}

function groupAlive(pgid) {
  if (process.platform === 'win32' || !Number.isInteger(pgid) || pgid <= 1) return false;
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readRecord(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  let rec = null;
  let readError = null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : null;
    rec = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e.code) readError = e.code;
  }
  return { rec, mtimeMs: st.mtimeMs, readError };
}

function createExclusive(file, rec) {
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
  try { fs.writeSync(fd, JSON.stringify(rec)); } finally { fs.closeSync(fd); }
  return true;
}

function isStaleRecord(cur, o) {
  if (cur.readError) return false;
  const ageMs = o.suspensionFile ? effectiveAgeMs(o.suspensionFile, cur.mtimeMs, o.now()) : o.now() - cur.mtimeMs;
  if (!cur.rec || !Number.isInteger(cur.rec.pid)) return ageMs > INIT_GRACE_MS;
  const dead = o.isDead
    ? o.isDead(cur.rec, ageMs)
    : !isAlive(cur.rec, { heartbeatAgeMs: ageMs, heartbeatStaleMs: o.staleMs });
  if (dead) return true;
  return !!o.stealOnHeartbeatStale && ageMs > o.staleMs;
}

function updateRecord(file, nonce, patch) {
  const cur = readRecord(file);
  if (!cur || !cur.rec || cur.rec.nonce !== nonce) return false;
  try {
    fsx.writeJsonAtomic(file, Object.assign({}, cur.rec, patch), 0o600);
    return true;
  } catch {
    return false;
  }
}

function makeLock(file, rec) {
  const lock = {
    ok: true,
    file,
    nonce: rec.nonce,
    rec,
    stillOwner() {
      const cur = readRecord(file);
      return !!(cur && cur.rec && cur.rec.nonce === rec.nonce);
    },
    heartbeat() {
      if (!lock.stillOwner()) return false;
      try {
        const t = new Date();
        fs.utimesSync(file, t, t);
        return true;
      } catch {
        return false;
      }
    },
    update(patch) { return updateRecord(file, rec.nonce, patch); },
    release() {
      if (!lock.stillOwner()) return false;
      try { fs.unlinkSync(file); } catch { /* already gone */ }
      return true;
    },
  };
  return lock;
}

// Only the holder of the steal mutex may remove a stale record, so two contenders can never
// both unlink and re-create (the second unlink would delete the first one's fresh lock).
function stealStale(file, judged, rec, o) {
  const mutex = `${file}.steal`;
  try {
    fs.closeSync(fs.openSync(mutex, 'wx', 0o600));
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      if (Date.now() - fs.statSync(mutex).mtimeMs > STEAL_MUTEX_STALE_MS) fs.unlinkSync(mutex);
    } catch { /* the other stealer finished */ }
    return false;
  }
  try {
    const cur = readRecord(file);
    if (cur) {
      const sameRecord = (cur.rec && judged.rec && cur.rec.nonce === judged.rec.nonce) || (!cur.rec && !judged.rec);
      if (!sameRecord || !isStaleRecord(cur, o)) return false;
      try { fs.unlinkSync(file); } catch { /* raced with the owner's release */ }
    }
    return createExclusive(file, rec);
  } finally {
    try { fs.unlinkSync(mutex); } catch { /* best effort */ }
  }
}

/**
 * Take an exclusive PID-liveness lock. Returns {ok:true, ...lock} or {ok:false, holder}.
 * A record is stale when its owner is dead (or the pid was recycled), or, if stealOnHeartbeatStale,
 * when its heartbeat (file mtime) is older than staleMs. The old owner must call stillOwner()
 * before acting so a frozen-then-resumed process backs off instead of double-running.
 */
function acquireLock(file, opts) {
  const o = Object.assign({ staleMs: 10 * 60 * 1000, stealOnHeartbeatStale: true, isDead: null, info: {}, now: Date.now }, opts);
  fsx.ensureDir(path.dirname(file));
  const rec = Object.assign({
    pid: process.pid,
    token: procToken(process.pid),
    nonce: crypto.randomBytes(8).toString('hex'),
    startedAt: new Date(o.now()).toISOString(),
  }, o.info);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (createExclusive(file, rec)) return makeLock(file, rec);
    const cur = readRecord(file);
    if (!cur) continue;
    if (!isStaleRecord(cur, o)) return { ok: false, holder: cur.rec, readError: cur.readError };
    if (stealStale(file, cur, rec, o)) return makeLock(file, rec);
  }
  const last = readRecord(file);
  return { ok: false, holder: last ? last.rec : null };
}

function readLockHolder(file) {
  const cur = readRecord(file);
  return cur ? { rec: cur.rec, ageMs: Date.now() - cur.mtimeMs } : null;
}

function waitUntil(pred, ms, sleep) {
  const s = sleep || fsx.sleep;
  return (async () => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (pred()) return true;
      await s(50);
    }
    return pred();
  })();
}

/**
 * Terminate a process and its process group: SIGTERM, then SIGKILL after graceMs.
 * If a token is given, a recycled pid is never signalled.
 */
async function killTree(pid, opts) {
  const o = Object.assign({ graceMs: 5000, token: undefined, sleep: fsx.sleep }, opts);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  // A live pid whose identity differs from the recorded token was recycled: it is not ours to signal.
  // A dead pid with a surviving group can only be leftovers of the old leader (the kernel never
  // reuses a pid that still names a process group).
  if (o.token && isAlive({ pid }) && !isAlive({ pid, token: o.token })) return true;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return !fsx.pidAlive(pid);
  }
  const send = (sig) => {
    try { process.kill(-pid, sig); return true; } catch (e) { if (e.code !== 'ESRCH' && e.code !== 'EPERM') return false; }
    try { process.kill(pid, sig); return true; } catch { return false; }
  };
  const gone = () => !isAlive({ pid, token: o.token }) && !groupAlive(pid);
  send('SIGTERM');
  if (!(await waitUntil(gone, o.graceMs, o.sleep))) {
    send('SIGKILL');
    await waitUntil(gone, 3000, o.sleep);
  }
  return gone();
}

function runRecordDead(rec, ageMs) {
  const runner = isAlive(rec, { heartbeatAgeMs: ageMs, heartbeatStaleMs: HEARTBEAT_STALE_MS });
  const child = !!rec.childPid && isAlive({ pid: rec.childPid, token: rec.childToken });
  return !(runner || child);
}

function inspectRun(runFile, now) {
  const cur = readRecord(runFile);
  if (!cur) return null;
  const t = now === undefined ? Date.now() : now;
  const ageMs = effectiveAgeMs(path.join(path.dirname(runFile), SUSPENSION_FILE), cur.mtimeMs, t);
  const out = {
    rec: cur.rec, mtimeMs: cur.mtimeMs, heartbeatAgeMs: ageMs, readError: cur.readError,
    corrupt: !cur.rec && !cur.readError, unknown: false, runnerAlive: false, childAlive: false, alive: false,
  };
  if (cur.readError) { out.unknown = true; out.alive = true; return out; }
  if (!cur.rec) { out.alive = ageMs <= INIT_GRACE_MS; return out; }
  out.runnerAlive = isAlive(cur.rec, { heartbeatAgeMs: ageMs, heartbeatStaleMs: HEARTBEAT_STALE_MS });
  out.childAlive = !!cur.rec.childPid && isAlive({ pid: cur.rec.childPid, token: cur.rec.childToken });
  out.alive = out.runnerAlive || out.childAlive;
  return out;
}

function readAdopted(files) {
  const list = fsx.readJson(files.adopted, []);
  return Array.isArray(list) ? list.filter((e) => e && Number.isInteger(e.pid)) : [];
}

function addAdopted(files, entries) {
  const live = readAdopted(files).filter((e) => isAlive(e));
  for (const e of entries) {
    if (!Number.isInteger(e.pid) || live.some((x) => x.pid === e.pid)) continue;
    live.push({ pid: e.pid, token: procToken(e.pid), id: e.id || null, mode: e.mode || null, addedAt: new Date().toISOString() });
  }
  fsx.writeJsonAtomic(files.adopted, live);
  return live;
}

function runLockHolders(runsDir, now, suspensionFile) {
  const out = [];
  let names;
  try { names = fs.readdirSync(runsDir); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.run-lock')) continue;
    const lock = fsx.readJson(path.join(runsDir, name), null);
    if (!lock || !Number.isInteger(lock.pid) || lock.pid === process.pid) continue;
    const startedAt = Number(lock.startedAt) || 0;
    const age = suspensionFile ? effectiveAgeMs(suspensionFile, startedAt, now) : now - startedAt;
    if (age >= RUN_LOCK_MAX_AGE_MS) continue;
    if (fsx.pidAlive(lock.pid)) out.push({ pid: lock.pid, file: name });
  }
  return out;
}

/**
 * The single "is a pipeline run in flight?" authority: the runner record (runner or its phase1
 * child alive), adopted recovery children, and live per-status run-locks. An unreadable record
 * counts as busy (fail safe), exactly like the legacy liveness sentinel.
 */
function busyState(opts) {
  const o = opts || {};
  const files = runtimeFiles(o.home);
  const now = o.now === undefined ? Date.now() : o.now;
  const run = inspectRun(files.run, now);
  const own = run && run.rec && run.rec.nonce && run.rec.nonce === o.ownNonce;
  if (run && !own && run.alive) {
    let kind = 'child';
    if (run.unknown) kind = 'unknown';
    else if (run.runnerAlive) kind = 'runner';
    return { busy: true, kind, pid: run.rec ? (run.runnerAlive ? run.rec.pid : run.rec.childPid) : null, run };
  }
  for (const a of readAdopted(files)) {
    const added = Date.parse(a.addedAt || '');
    if (Number.isFinite(added) && effectiveAgeMs(files.suspensions, added, now) > ADOPTED_MAX_AGE_MS) continue;
    if (isAlive(a)) return { busy: true, kind: 'adopted', pid: a.pid, detail: a.id || a.mode || null, run };
  }
  const locks = runLockHolders(files.runs, now, files.suspensions);
  if (locks.length) return { busy: true, kind: 'run-lock', pid: locks[0].pid, detail: locks[0].file, run };
  return { busy: false, kind: null, pid: null, run };
}

// Cheap test for "worth waiting out a suspected resume": a run record, a recovered child or a run-lock file exists.
function inFlightHints(files) {
  if (fs.existsSync(files.run)) return true;
  if (readAdopted(files).length) return true;
  try {
    return fs.readdirSync(files.runs).some((n) => n.endsWith('.run-lock'));
  } catch {
    return false;
  }
}

function mtimeMs(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

// True when the file's mtime moved between two reads a grace period apart, i.e. its owner is running timers now.
async function heartbeatAdvances(file, graceMs, sleep) {
  const first = mtimeMs(file);
  await (sleep || fsx.sleep)(graceMs);
  const second = mtimeMs(file);
  return first !== null && second !== null && second > first;
}

module.exports = {
  INIT_GRACE_MS, HEARTBEAT_STALE_MS, RUN_LOCK_MAX_AGE_MS, ADOPTED_MAX_AGE_MS, CLOCK_JUMP_MS, SUSPENSION_FILE,
  readSuspensions, recordSuspension, suspendedMs, effectiveAgeMs, makeClockGuard, inFlightHints, heartbeatAdvances,
  runtimeFiles, procInfo, procToken, isAlive, groupAlive,
  readRecord, updateRecord, acquireLock, readLockHolder, killTree, waitUntil,
  runRecordDead, inspectRun, readAdopted, addAdopted, runLockHolders, busyState,
};
