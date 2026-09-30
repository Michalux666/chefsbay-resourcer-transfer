#!/usr/bin/env node
'use strict';
/**
 * maintenance.js - idempotent housekeeping: runs/ prune, log rotation and compression, Chrome
 * cache cap, stray temp files, outbox trimming, disk guard, monthly VACUUM and the memory guard
 * the watchdog tick applies before it starts a browser run. Every step can be run alone.
 *
 * It removes only what it names: runs/ files, logs/ files, stray temp files in a few runtime directories,
 * candidates.db.pre-migrate-* copies in backups/ after 7 days, entry files of browser cache directories under
 * state/, and outbox rotations. It never lists secrets/ or shadow/ (the retention sweep prunes the shadow log
 * through its own module) and never removes anything else from state/ (sessions, cookies, profiles) or backups/.
 *
 * Usage: node scripts/maintenance.js [--daily] [--runs] [--logs] [--chrome-cache] [--tmp] [--pre-migrate]
 *                                    [--outbox] [--disk] [--vacuum] [--mem] [--dry-run] [--json]
 * Exit:  0 ok, 1 error, 2 usage, 3 a critical condition was raised (disk above the limit, or --mem below the floor)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const paths = require('./lib/paths');
const fsx = require('./lib/fsx');
const timeLib = require('./lib/time');
const tick = require('./lib/tick');

const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const DEFAULTS = {
  runsDays: 7,
  logCompressDays: 14,
  logDeleteDays: 90,
  cacheCapMb: 500,
  diskCritPct: 85,
  minMemMb: 700,
  vacuumEveryDays: 28,
  tmpDays: 1,
  outboxKeepDays: 30,
  preMigrateDays: 7,
};
// Append-only logs rotated by size; the dashboard reads errors.jsonl so it gets a generous limit.
const ROTATE_BY_SIZE = { 'watchdog-runner.jsonl': 5 * MB, 'pipeline-performance.jsonl': 5 * MB, 'errors.jsonl': 20 * MB };
const CACHE_DIR_NAMES = new Set(['Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'CacheStorage']);
// Cache entry files only: index, lock and manifest files are never removed from under a live browser.
const CACHE_KEEP_RE = /^(index|the-real-index|data_\d+|LOCK|CURRENT|MANIFEST-.*|LOG(\.old)?|.*\.lock)$/;
const RUN_FILE_RE = /^(phase1|run|params)-.*\.json$/;
const TMP_RE = /\.\d+\.\d+\.tmp$/;
// migrate-schema.js names its safety copy candidates.db.pre-migrate-<iso stamp with dashes>.
const PRE_MIGRATE_RE = /^candidates\.db\.pre-migrate-[0-9A-Za-z-]+$/;

function makeCtx(over) {
  const o = over || {};
  const home = o.home ? path.resolve(o.home) : paths.HOME;
  const files = tick.runtimeFiles(home);
  const ctx = Object.assign({
    home,
    files,
    dirs: {
      runs: files.runs, logs: files.logs, runtime: files.dir, state: path.join(home, 'state'),
      outbox: path.join(home, 'outbox'), pending: path.join(home, 'pending-searches'), db: path.join(home, 'candidates.db'),
      backups: path.join(home, 'backups'),
    },
    now: () => Date.now(),
    dryRun: false,
    notify: (a) => require('./lib/notify').notify(a),
    statfs: (dir) => fs.statfsSync(dir),
    readFile: (f) => fs.readFileSync(f, 'utf8'),
    cgroupDir: '/sys/fs/cgroup',
    isBusy: () => tick.busyState({ home }).busy,
  }, o);
  return ctx;
}

function listFiles(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function ageMs(ctx, st) {
  return ctx.now() - st.mtimeMs;
}

function pruneRuns(ctx, opts) {
  const days = (opts && opts.days) || DEFAULTS.runsDays;
  const out = { deleted: 0, kept: 0, bytes: 0 };
  for (const ent of listFiles(ctx.dirs.runs)) {
    if (!ent.isFile()) continue;
    if (!(RUN_FILE_RE.test(ent.name) || ent.name.endsWith('.run-lock'))) continue;
    const fp = path.join(ctx.dirs.runs, ent.name);
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    if (ageMs(ctx, st) <= days * DAY_MS) { out.kept++; continue; }
    if (!ctx.dryRun) { try { fs.unlinkSync(fp); } catch { continue; } }
    out.deleted++;
    out.bytes += st.size;
  }
  return out;
}

async function gzipFile(fp, mtime) {
  const tmp = `${fp}.gz.${process.pid}.${Date.now()}.tmp`;
  await pipeline(fs.createReadStream(fp), zlib.createGzip({ level: 6 }), fs.createWriteStream(tmp));
  fs.renameSync(tmp, `${fp}.gz`);
  try { fs.utimesSync(`${fp}.gz`, mtime, mtime); } catch { /* cosmetic */ }
  fs.unlinkSync(fp);
}

function stamp(ctx) {
  return new Date(ctx.now()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

async function rotateLogs(ctx, opts) {
  const o = Object.assign({ compressDays: DEFAULTS.logCompressDays, deleteDays: DEFAULTS.logDeleteDays }, opts);
  const out = { rotated: 0, compressed: 0, deleted: 0 };
  for (const [name, limit] of Object.entries(ROTATE_BY_SIZE)) {
    const fp = path.join(ctx.dirs.logs, name);
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    if (st.size <= limit) continue;
    if (!ctx.dryRun) {
      const ext = path.extname(name);
      fs.renameSync(fp, path.join(ctx.dirs.logs, `${path.basename(name, ext)}-${stamp(ctx)}${ext}`));
    }
    out.rotated++;
  }
  for (const ent of listFiles(ctx.dirs.logs)) {
    if (!ent.isFile()) continue;
    const fp = path.join(ctx.dirs.logs, ent.name);
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    const age = ageMs(ctx, st);
    if (ent.name.endsWith('.gz')) {
      if (age > o.deleteDays * DAY_MS) {
        if (!ctx.dryRun) { try { fs.unlinkSync(fp); } catch { continue; } }
        out.deleted++;
      }
    } else if (/\.(log|jsonl|txt)$/.test(ent.name) && age > o.compressDays * DAY_MS) {
      if (!ctx.dryRun) {
        try { await gzipFile(fp, st.mtime); } catch { continue; }
      }
      out.compressed++;
    }
  }
  return out;
}

function collectCacheFiles(root, depth, inCache, acc) {
  if (depth > 9) return;
  for (const ent of listFiles(root)) {
    const fp = path.join(root, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      collectCacheFiles(fp, depth + 1, inCache || CACHE_DIR_NAMES.has(ent.name), acc);
    } else if (ent.isFile() && inCache && !CACHE_KEEP_RE.test(ent.name)) {
      try {
        const st = fs.statSync(fp);
        acc.push({ fp, size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* vanished */ }
    }
  }
}

function capChromeCache(ctx, opts) {
  const capMb = (opts && opts.capMb) || DEFAULTS.cacheCapMb;
  if (ctx.isBusy()) return { skipped: 'busy', beforeMb: null, afterMb: null, deleted: 0 };
  const acc = [];
  collectCacheFiles(ctx.dirs.state, 0, false, acc);
  let total = acc.reduce((n, f) => n + f.size, 0);
  const out = { beforeMb: Math.round(total / MB), afterMb: 0, deleted: 0 };
  if (total > capMb * MB) {
    acc.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of acc) {
      if (total <= capMb * MB) break;
      if (!ctx.dryRun) { try { fs.unlinkSync(f.fp); } catch { continue; } }
      total -= f.size;
      out.deleted++;
    }
  }
  out.afterMb = Math.round(total / MB);
  return out;
}

function pruneTmp(ctx, opts) {
  const days = (opts && opts.days) || DEFAULTS.tmpDays;
  const out = { deleted: 0 };
  for (const dir of [ctx.dirs.runtime, ctx.dirs.runs, ctx.dirs.outbox, ctx.dirs.pending, ctx.dirs.logs, ctx.dirs.backups]) {
    for (const ent of listFiles(dir)) {
      if (!ent.isFile()) continue;
      const stale = TMP_RE.test(ent.name) || (dir === ctx.dirs.runtime && ent.name.endsWith('.steal'));
      if (!stale) continue;
      const fp = path.join(dir, ent.name);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      const limit = ent.name.endsWith('.steal') ? 60 * 1000 : days * DAY_MS;
      if (ageMs(ctx, st) <= limit) continue;
      if (!ctx.dryRun) { try { fs.unlinkSync(fp); } catch { continue; } }
      out.deleted++;
    }
  }
  return out;
}

// The one-off safety copy migrate-schema.js takes before a structural change. It holds candidate data
// unencrypted, so it must not outlive its purpose; the nightly encrypted backups are never touched.
function prunePreMigrate(ctx, opts) {
  const days = (opts && opts.days) || DEFAULTS.preMigrateDays;
  const out = { deleted: 0, kept: 0, bytes: 0 };
  for (const ent of listFiles(ctx.dirs.backups)) {
    if (!ent.isFile() || !PRE_MIGRATE_RE.test(ent.name)) continue;
    const fp = path.join(ctx.dirs.backups, ent.name);
    let st;
    try { st = fs.lstatSync(fp); } catch { continue; }
    if (ageMs(ctx, st) <= days * DAY_MS) { out.kept++; continue; }
    if (!ctx.dryRun) { try { fs.unlinkSync(fp); } catch { continue; } }
    out.deleted++;
    out.bytes += st.size;
  }
  return out;
}

function pruneOutbox(ctx, opts) {
  const days = (opts && opts.days) || DEFAULTS.outboxKeepDays;
  const out = { deleted: 0, trimmed: false };
  for (const ent of listFiles(ctx.dirs.outbox)) {
    if (!ent.isFile() || !/^alerts-\d{8}.*\.jsonl$/.test(ent.name)) continue;
    const fp = path.join(ctx.dirs.outbox, ent.name);
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    if (ageMs(ctx, st) <= days * DAY_MS) continue;
    if (!ctx.dryRun) { try { fs.unlinkSync(fp); } catch { continue; } }
    out.deleted++;
  }
  const delivered = path.join(ctx.dirs.outbox, 'alerts-delivered.jsonl');
  try {
    if (fs.statSync(delivered).size > 2 * MB && !ctx.dryRun) {
      const lines = fs.readFileSync(delivered, 'utf8').split('\n').filter(Boolean);
      fsx.writeFileAtomic(delivered, `${lines.slice(-2000).join('\n')}\n`);
      out.trimmed = true;
    }
  } catch { /* not created yet */ }
  return out;
}

function diskGuard(ctx, opts) {
  const critPct = (opts && opts.critPct) || DEFAULTS.diskCritPct;
  const dir = fs.existsSync(ctx.home) ? ctx.home : path.dirname(ctx.home);
  const s = ctx.statfs(dir);
  const bsize = s.bsize;
  const used = (s.blocks - s.bfree) * bsize;
  const free = s.bavail * bsize;
  const usedPct = used + free > 0 ? Math.round((used / (used + free)) * 1000) / 10 : 0;
  const out = { usedPct, freeMb: Math.round(free / MB), totalMb: Math.round((s.blocks * bsize) / MB), critical: usedPct > critPct };
  if (out.critical) {
    ctx.notify({
      severity: 'critical',
      key: 'disk-usage',
      text: `Disk ${usedPct}% used (${out.freeMb} MB free) on the volume holding RESOURCER_HOME; the pipeline and backups stop working when it fills. See docs/OPERATIONS.md (storage).`,
      meta: out,
    });
  }
  return out;
}

function memoryAvailableMb(ctx) {
  const c = ctx || makeCtx();
  let avail = null;
  try {
    const m = /MemAvailable:\s+(\d+)\s*kB/.exec(c.readFile('/proc/meminfo'));
    if (m) avail = Number(m[1]) / 1024;
  } catch { /* not Linux */ }
  try {
    const max = c.readFile(`${c.cgroupDir}/memory.max`).trim();
    if (/^\d+$/.test(max)) {
      const cur = Number(c.readFile(`${c.cgroupDir}/memory.current`).trim());
      let reclaim = 0;
      try {
        const m = /^inactive_file (\d+)/m.exec(c.readFile(`${c.cgroupDir}/memory.stat`));
        if (m) reclaim = Number(m[1]);
      } catch { /* optional */ }
      const cg = (Number(max) - cur + reclaim) / MB;
      avail = avail === null ? cg : Math.min(avail, cg);
    }
  } catch { /* no cgroup limit */ }
  if (avail === null) avail = os.freemem() / MB;
  return Math.round(avail);
}

function memoryGuard(ctx, opts) {
  const minMb = (opts && opts.minMb) || DEFAULTS.minMemMb;
  const availMb = opts && typeof opts.availMb === 'number' ? opts.availMb : memoryAvailableMb(ctx);
  return { ok: availMb >= minMb, availMb, minMb };
}

function loadSqlite() {
  try { return require('better-sqlite3'); } catch { return null; }
}

function vacuumIfDue(ctx, opts) {
  const o = Object.assign({ force: false, everyDays: DEFAULTS.vacuumEveryDays }, opts);
  const stateFile = path.join(ctx.dirs.runtime, 'maintenance-state.json');
  const state = fsx.readJson(stateFile, {});
  const last = state.lastVacuumAt ? Date.parse(state.lastVacuumAt) : 0;
  if (!o.force && ctx.now() - last < o.everyDays * DAY_MS) return { skipped: 'not-due', lastVacuumAt: state.lastVacuumAt || null };
  if (!fs.existsSync(ctx.dirs.db)) return { skipped: 'no-db' };
  if (ctx.isBusy()) return { skipped: 'busy' };
  if (ctx.dryRun) return { skipped: 'dry-run' };
  const Database = loadSqlite();
  if (!Database) return { skipped: 'no-sqlite' };
  let db;
  try {
    const before = fs.statSync(ctx.dirs.db).size;
    db = new Database(ctx.dirs.db, { fileMustExist: true, timeout: 30000 });
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* not WAL */ }
    db.exec('VACUUM');
    try { db.pragma('optimize'); } catch { /* optional */ }
    db.close();
    db = null;
    const after = fs.statSync(ctx.dirs.db).size;
    state.lastVacuumAt = new Date(ctx.now()).toISOString();
    fsx.writeJsonAtomic(stateFile, state);
    return { vacuumed: true, beforeMb: Math.round(before / MB * 10) / 10, afterMb: Math.round(after / MB * 10) / 10 };
  } catch (e) {
    if (db) { try { db.close(); } catch { /* ignore */ } }
    ctx.notify({ severity: 'warn', key: 'vacuum-failed', text: `Monthly VACUUM of candidates.db did not complete: ${String(e.message).slice(0, 200)}. It retries the next night.` });
    return { error: e.message };
  }
}

async function runDaily(ctx) {
  const r = {};
  const step = async (name, fn) => {
    try { r[name] = await fn(); } catch (e) { r[name] = { error: e.message }; }
  };
  await step('runs', () => pruneRuns(ctx));
  await step('logs', () => rotateLogs(ctx));
  await step('tmp', () => pruneTmp(ctx));
  await step('preMigrate', () => prunePreMigrate(ctx));
  await step('outbox', () => pruneOutbox(ctx));
  await step('chromeCache', () => capChromeCache(ctx));
  await step('disk', () => diskGuard(ctx));
  await step('vacuum', () => vacuumIfDue(ctx));
  return r;
}

const USAGE = 'Usage: node scripts/maintenance.js [--daily] [--runs] [--logs] [--chrome-cache] [--tmp] [--pre-migrate] [--outbox] [--disk] [--vacuum] [--mem] [--dry-run] [--json] [--help]';

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return 0; }
  const flags = new Set(['--daily', '--runs', '--logs', '--chrome-cache', '--tmp', '--pre-migrate', '--outbox', '--disk', '--vacuum', '--mem', '--dry-run', '--json']);
  for (const a of argv) {
    if (!flags.has(a)) { console.error(`unknown argument '${a}'\n${USAGE}`); return 2; }
  }
  const has = (f) => argv.includes(f);
  if (!argv.some((a) => a !== '--dry-run' && a !== '--json')) { console.error(USAGE); return 2; }
  const ctx = makeCtx({ dryRun: has('--dry-run') });
  let result = {};
  let critical = false;
  if (has('--daily')) {
    result = await runDaily(ctx);
    critical = !!(result.disk && result.disk.critical);
  } else {
    if (has('--runs')) result.runs = pruneRuns(ctx);
    if (has('--logs')) result.logs = await rotateLogs(ctx);
    if (has('--tmp')) result.tmp = pruneTmp(ctx);
    if (has('--pre-migrate')) result.preMigrate = prunePreMigrate(ctx);
    if (has('--outbox')) result.outbox = pruneOutbox(ctx);
    if (has('--chrome-cache')) result.chromeCache = capChromeCache(ctx);
    if (has('--disk')) { result.disk = diskGuard(ctx); critical = critical || result.disk.critical; }
    if (has('--vacuum')) result.vacuum = vacuumIfDue(ctx, { force: true });
    if (has('--mem')) {
      result.mem = memoryGuard(ctx);
      if (!result.mem.ok) critical = true;
    }
  }
  console.log(JSON.stringify(Object.assign({ ts: new Date(ctx.now()).toISOString(), london: timeLib.londonParts(new Date(ctx.now())).ymd }, result)));
  return critical ? 3 : 0;
}

module.exports = {
  DEFAULTS, ROTATE_BY_SIZE, PRE_MIGRATE_RE, makeCtx, pruneRuns, rotateLogs, capChromeCache, pruneTmp, prunePreMigrate, pruneOutbox,
  diskGuard, memoryAvailableMb, memoryGuard, vacuumIfDue, runDaily,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`maintenance failed: ${e && e.message}`);
    process.exit(1);
  });
}
