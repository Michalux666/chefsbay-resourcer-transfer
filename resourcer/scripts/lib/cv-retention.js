'use strict';
// Data-lifecycle helpers shared by process-approved-queue.js and retention-sweep.js.
// Nothing here may unlink a file except through jailedUnlink (regular file, plain basename,
// directory equal to one of the allowed roots).
const fs = require('fs');
const path = require('path');

const DAY_MS = 86400000;
const CV_EXTENSIONS = ['.pdf', '.docx', '.doc', '.rtf', '.txt'];

const DEFAULTS = Object.freeze({
  queueAfterCompleteDays: 3,
  orphanDays: 14,
  runsDays: 7,
  logCompressDays: 14,
  logDeleteDays: 90,
  tmpDays: 1,
  hardKillTmpHours: 1,
  screeningInputHours: 1,
  shadowDays: 180,
  jsonlRotateMB: 50,
  diskThresholdPct: 85,
  maxDeletes: 20000,
});

const VALID_SOURCES = Object.freeze(['caterer', 'reed', 'both']);

// The dashboard and run_results only know these three values; anything else is treated as absent.
function normalizeSources(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return VALID_SOURCES.includes(s) ? s : null;
}

// Caterer and Reed ids are plain integers; anything else never reaches the filesystem.
const ID_RE = /^\d{1,20}$/;

function isSafeId(id) {
  return (typeof id === 'string' || typeof id === 'number') && ID_RE.test(String(id));
}

function cvPrefixes(source) {
  return source === 'reed' ? ['cv-reed-', 'cv-'] : ['cv-', 'cv-reed-'];
}

function cvBasenames(id, source, includeAlternate) {
  if (!isSafeId(id)) return [];
  const prefixes = includeAlternate === false ? [cvPrefixes(source)[0]] : cvPrefixes(source);
  const out = [];
  for (const prefix of prefixes) for (const ext of CV_EXTENSIONS) out.push(`${prefix}${id}${ext}`);
  return out;
}

function candidateJsonName(id) {
  return `candidate-${id}.json`;
}

// The one deletion rule (DESIGN 5.6): Zoho id set AND (CV attached OR Zoho already had the candidate).
function shouldDeleteCandidateArtifacts({ zohoId, cvAttached, isDuplicate } = {}) {
  return !!zohoId && !!(cvAttached || isDuplicate);
}

// ---------------------------------------------------------------------------------------------
// Jail
// ---------------------------------------------------------------------------------------------

function realOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

function sameDir(a, b) {
  if (!a || !b) return false;
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Separators and NUL as hex escapes (2f = slash, 5c = backslash): the source keeps no double-backslash literal.
const UNSAFE_NAME_CHARS = /[\x2f\x5c\x00]/;

function jailedUnlink(jailRoots, dir, name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || UNSAFE_NAME_CHARS.test(name)) {
    return { ok: false, reason: 'bad-name' };
  }
  const realDir = realOrNull(dir);
  if (!realDir) return { ok: false, reason: 'dir-missing' };
  const allowed = (jailRoots || []).some(r => sameDir(realOrNull(r), realDir));
  if (!allowed) return { ok: false, reason: 'outside-jail' };
  const target = path.join(realDir, name);
  let st;
  try { st = fs.lstatSync(target); } catch (e) {
    return { ok: false, reason: e.code === 'ENOENT' ? 'missing' : `stat-failed:${e.code || 'ERR'}` };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (!st.isFile()) return { ok: false, reason: 'not-regular-file' };
  try {
    fs.unlinkSync(target);
    return { ok: true, size: st.size };
  } catch (e) {
    return { ok: false, reason: `unlink-failed:${e.code || 'ERR'}` };
  }
}

// Removes candidate-<id>.json and every extension of the candidate's own CV prefix (cv-<id>.* for
// Caterer, cv-reed-<id>.* for Reed). cvPath is the file that was actually attached: when the reader fell
// back to the other prefix, exactly that file goes too (unless another candidate in the queue, protectAlternate,
// owns the other-source names). Never throws.
function removeCandidateArtifacts({ dir, id, source, jailRoots, protectAlternate, cvPath }) {
  const result = { removed: [], failed: [], skipped: null };
  if (!isSafeId(id)) { result.skipped = 'unsafe-id'; return result; }
  const names = [candidateJsonName(id), ...cvBasenames(id, source, false)];
  if (cvPath && !protectAlternate) {
    const base = path.basename(String(cvPath));
    if (cvBasenames(id, source, true).includes(base) && !names.includes(base)) names.push(base);
  }
  for (const name of names) {
    const r = jailedUnlink(jailRoots || [dir], dir, name);
    if (r.ok) result.removed.push(name);
    else if (r.reason !== 'missing') result.failed.push({ name, reason: r.reason });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Name classification
// ---------------------------------------------------------------------------------------------

const DOWNLOAD_RULES = [
  ['review-tmp', /^review-tmp-/],
  ['tmp', /\.tmp$/],
  ['candidate', /^candidate-(\d+)\.json$/],
  ['cv-anon', /^cv-reed-anon-(\d+)\.[A-Za-z0-9]{1,10}$/],
  ['cv', /^cv-(reed-)?(\d+)\.[A-Za-z0-9]{1,10}$/],
  ['results', /^phase2-results-(.+)\.json$/],
  ['reed-empty', /^reed-empty-.+\.json$/],
  ['queue', /^(?:approved-queue|merged-queue|reed-approved-queue)-.+\.json$/],
];

function classifyDownloadName(name) {
  for (const [kind, re] of DOWNLOAD_RULES) {
    const m = re.exec(name);
    if (m) return { kind, match: m };
  }
  return { kind: 'other', match: null };
}

const RUNS_RULES = [
  ['tmp', /\.tmp$/],
  ['status', /^phase1-.+\.json(\.[A-Za-z0-9._-]+)?$/],
  ['params', /^params-.+\.json$/],
  ['run-state', /^run-.+\.json$/],
];

function classifyRunsName(name) {
  for (const [kind, re] of RUNS_RULES) if (re.test(name)) return kind;
  return 'other';
}

// fsx.writeFileAtomic leaves <file>.<pid>.<ms>.tmp behind when the process is killed between write and rename.
const TMP_SUFFIX_RE = /(?:\.\d+\.\d+)?\.tmp$/;

// True for such a leftover of a file this package knows (queue, results, candidate, CV; phase1 status,
// params, run state): it is dead after an hour, unlike an unknown *.tmp which waits tmpDays.
function isHardKillTmp(dirKind, name) {
  if (typeof name !== 'string' || !TMP_SUFFIX_RE.test(name)) return false;
  const owner = name.replace(TMP_SUFFIX_RE, '');
  if (dirKind === 'downloads') return ['queue', 'results', 'candidate', 'cv', 'cv-anon', 'reed-empty'].includes(classifyDownloadName(owner).kind);
  if (dirKind === 'runs') return ['status', 'params', 'run-state'].includes(classifyRunsName(owner));
  return false;
}

function queueNameForRunKey(runKey) {
  return /^(?:merged-queue|reed-approved-queue)-/.test(runKey) ? `${runKey}.json` : `approved-queue-${runKey}.json`;
}

function runKeyForQueueName(queueName) {
  const base = queueName.replace(/\.json$/, '');
  return base.replace(/^approved-queue-/, '');
}

function statusNameForQueue(queueName) {
  let m = /^approved-queue-(.+)\.json$/.exec(queueName);
  if (m) return `phase1-${m[1]}.json`;
  m = /^reed-approved-queue-(phase1-.+)\.json$/.exec(queueName);
  if (m) return `${m[1]}.json`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Downloads plan (pure: no filesystem access)
// ---------------------------------------------------------------------------------------------

function ageDays(now, ms) {
  return (now - ms) / DAY_MS;
}

function isoMs(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

function status2Done(status) {
  if (!status || typeof status !== 'object') return null;
  if (status.phase2Complete === true || status.phase2Status === 'done') {
    return isoMs(status.completedAt) ?? isoMs(status.updatedAt) ?? isoMs(status.startedAt);
  }
  return null;
}

// ctx: { now, config, entries[{name,size,mtimeMs,type}], readResults(name), readStatus(name),
//        queueInfo(name) -> {candidates, jobTitle, location} | null }
function planDownloadsSweep(ctx) {
  const cfg = { ...DEFAULTS, ...(ctx.config || {}) };
  const now = ctx.now;
  const plan = { actions: [], anomalies: [], kept: { recent: 0, unknown: 0, nonRegular: 0 } };
  const byName = new Map();
  const claimed = new Set();
  const reserved = new Set();
  const runKeysSeen = new Set();
  const completions = [];
  const norm = v => String(v || '').toLowerCase().trim();

  const add = (entry, kind, reason, extra) => {
    plan.actions.push({ name: entry.name, kind, reason, size: entry.size || 0, ...(extra || {}) });
    claimed.add(entry.name);
  };

  for (const e of ctx.entries) {
    if (e.type !== 'file') { plan.kept.nonRegular++; if (e.type === 'symlink') plan.anomalies.push({ code: 'symlink-skipped', name: e.name }); continue; }
    byName.set(e.name, e);
  }

  // 1. review-tmp-* (snippets with names): always. tmp leftovers: after tmpDays.
  for (const e of byName.values()) {
    const { kind } = classifyDownloadName(e.name);
    if (kind === 'review-tmp') add(e, 'review-tmp', 'always');
    else if (kind === 'tmp') {
      const hardKill = isHardKillTmp('downloads', e.name);
      if (ageDays(now, e.mtimeMs) >= (hardKill ? cfg.hardKillTmpHours / 24 : cfg.tmpDays)) add(e, 'tmp', hardKill ? 'hard-kill-tmp' : 'stale-tmp');
    }
  }

  // 2. results groups: queue first, results second (reprocess guard reads the results file).
  for (const e of byName.values()) {
    if (claimed.has(e.name)) continue;
    const { kind, match } = classifyDownloadName(e.name);
    if (kind !== 'results') continue;
    const runKey = match[1];
    runKeysSeen.add(runKey);
    const qName = queueNameForRunKey(runKey);
    const q = byName.get(qName);
    if (q) reserved.add(qName);
    const mtimeAge = ageDays(now, e.mtimeMs);
    if (mtimeAge < cfg.queueAfterCompleteDays) { plan.kept.recent++; continue; }

    const results = ctx.readResults(e.name);
    if (results === undefined || results === null || typeof results !== 'object') {
      // unreadable or corrupt: treat like an orphan, by file age
      if (mtimeAge >= cfg.orphanDays) {
        if (q) add(q, 'queue', 'group-of-corrupt-results');
        add(e, 'results', 'corrupt-results-orphan', q ? { dependsOn: qName } : {});
        plan.anomalies.push({ code: 'corrupt-results-deleted', name: e.name });
      } else plan.kept.recent++;
      continue;
    }
    const completed = isoMs(results.completedAt) ?? e.mtimeMs;
    completions.push({ title: norm(results.jobTitle), loc: norm(results.location), at: completed });
    if (ageDays(now, completed) < cfg.queueAfterCompleteDays) { plan.kept.recent++; continue; }
    if (typeof results.date !== 'string' || !results.date) {
      // no date: run_results cannot hold it (the legacy dashboard never bucketed it either), so it
      // waits like an orphan instead of being kept forever behind the run_results gate
      if (mtimeAge >= cfg.orphanDays) {
        if (q) add(q, 'queue', 'group-of-undated-results');
        add(e, 'results', 'undated-results-orphan', q ? { dependsOn: qName } : {});
        plan.anomalies.push({ code: 'undated-results-deleted', name: e.name });
      } else plan.kept.recent++;
      continue;
    }
    const gate = { requiresRunResult: runKey };
    if (q) add(q, 'queue', 'phase2-complete+retention', gate);
    add(e, 'results', 'phase2-complete+retention', { ...gate, ...(q ? { dependsOn: qName } : {}) });
  }

  // 3. remaining queue files (no results of their own) and reed-empty placeholders.
  for (const e of byName.values()) {
    if (claimed.has(e.name) || reserved.has(e.name)) continue;
    const { kind } = classifyDownloadName(e.name);
    if (kind === 'reed-empty') {
      if (ageDays(now, e.mtimeMs) >= cfg.queueAfterCompleteDays) add(e, 'queue', 'reed-placeholder');
      else plan.kept.recent++;
      continue;
    }
    if (kind !== 'queue') continue;
    if (e.name.startsWith('reed-approved-queue-') && !statusNameForQueue(e.name) && ctx.queueInfo) {
      // Reed queues carry <job>-<location>-<timestamp> names, so no status file maps to them. Once a
      // merged run for the same job and location completed within 3 hours after the queue was written
      // (it was merged into that run's queue), the file is dead and follows the completed + N days rule.
      const info = ctx.queueInfo(e.name);
      if (info && info.jobTitle) {
        const hit = completions.find(c => c.title === norm(info.jobTitle) && c.loc === norm(info.location)
          && c.at >= e.mtimeMs - 5 * 60000 && c.at <= e.mtimeMs + 3 * 3600000);
        if (hit) { add(e, 'queue', 'consumed-by-completed-run'); continue; }
      }
    }
    const statusName = statusNameForQueue(e.name);
    const status = statusName ? ctx.readStatus(statusName) : null;
    const doneAt = status2Done(status);
    if (doneAt !== null) {
      if (ageDays(now, doneAt) >= cfg.queueAfterCompleteDays) add(e, 'queue', 'phase2-complete+retention');
      else plan.kept.recent++;
      continue;
    }
    if (ageDays(now, e.mtimeMs) >= cfg.orphanDays) {
      const info = ctx.queueInfo ? ctx.queueInfo(e.name) : null;
      add(e, 'queue', 'orphan-queue');
      if (info && info.candidates > 0) plan.anomalies.push({ code: 'stranded-queue-deleted', name: e.name, candidates: info.candidates });
    } else plan.kept.recent++;
  }

  // 4. orphan CVs and candidate JSON (older than orphanDays; the per-candidate cleanup normally removed them).
  for (const e of byName.values()) {
    if (claimed.has(e.name) || reserved.has(e.name)) continue;
    const { kind, match } = classifyDownloadName(e.name);
    if (kind !== 'cv' && kind !== 'candidate' && kind !== 'cv-anon') { if (kind === 'other') plan.kept.unknown++; continue; }
    if (ageDays(now, e.mtimeMs) >= cfg.orphanDays) {
      // A redacted Reed CV never goes to Zoho, so it carries no id/source for the pushed-or-not accounting.
      if (kind === 'cv-anon') { add(e, 'cv-anon', 'orphan-anonymised'); continue; }
      const id = kind === 'cv' ? match[2] : match[1];
      const source = kind === 'cv' && match[1] ? 'reed' : 'caterer';
      add(e, kind === 'cv' ? 'cv' : 'candidate', 'orphan', { id, source });
    } else plan.kept.recent++;
  }

  plan.runKeys = [...runKeysSeen];
  return plan;
}

module.exports = {
  DAY_MS, CV_EXTENSIONS, DEFAULTS, VALID_SOURCES, normalizeSources, isSafeId, cvPrefixes, cvBasenames, candidateJsonName,
  shouldDeleteCandidateArtifacts, jailedUnlink, removeCandidateArtifacts,
  classifyDownloadName, classifyRunsName, isHardKillTmp, queueNameForRunKey, runKeyForQueueName, statusNameForQueue,
  planDownloadsSweep, status2Done, ageDays,
};
