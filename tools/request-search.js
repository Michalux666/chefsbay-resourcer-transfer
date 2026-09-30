#!/usr/bin/env node
'use strict';
/**
 * request-search.js - queue a one-off search by dropping an atomic pending-searches/search-*.json file.
 *
 * Same rules as POST /api/plugins/resourcer/search in plugin/resourcer/dashboard/plugin_api.py (the two
 * implementations are checked against tests/dashboard/fixtures/search-vectors.json):
 *   - validation and normalisation of title, location, keywords, sources, priority, distance, activeWithin, cvLimit;
 *   - 409-style refusal when the same title+location is already pending or in flight;
 *   - unique file name search-<epoch ms>-<6 hex>.json, never spawnedAt, temp dotfile + fsync + no-clobber link;
 *   - advisory lock file pending-searches/.request-search.lock shared with the plugin.
 *
 * Exit codes: 0 queued (or --dry-run valid), 1 unexpected error, 2 usage or validation error,
 *             3 already queued or running, 4 could not write (I/O, lock busy, path outside RESOURCER_HOME).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let sharedPaths = null;
try { sharedPaths = require('../resourcer/scripts/lib/paths'); } catch { sharedPaths = null; }
let sharedTime = null;
try { sharedTime = require('../resourcer/scripts/lib/time'); } catch { sharedTime = null; }

const DEFAULT_HOME = '/opt/data/profiles/resourcer/workspace/resourcer';
const VALID_SOURCES = ['both', 'caterer', 'reed'];
const VALID_PRIORITIES = ['high', 'medium', 'low'];
const VALID_DISTANCES = [5, 10, 20, 30, 40, 60, 80];
const VALID_ACTIVE_WITHIN = ['14 days', '1 month', '2 months', '3 months', '6 months', '12 months', '18 months', 'All'];
const CV_LIMIT_MIN = 10;
const CV_LIMIT_MAX = 50;
const ACRONYMS = new Set(['DBS', 'NVQ', 'CDP', 'HND', 'HNC', 'UK', 'EU', 'TV', 'CV', 'HR', 'IT']);
const CITY_NAMES = new Set([
  'london', 'manchester', 'leeds', 'liverpool', 'york', 'york city', 'sheffield', 'birmingham', 'bristol',
  'nottingham', 'leicester', 'newcastle', 'glasgow', 'edinburgh', 'cardiff', 'brighton', 'oxford', 'cambridge',
  'reading', 'coventry', 'hull', 'bradford', 'wolverhampton', 'derby', 'stoke', 'exeter', 'portsmouth',
  'southampton', 'norwich', 'plymouth', 'sunderland', 'middlesbrough', 'bolton', 'blackpool',
]);

const TITLE_CHARS = /^[A-Za-z0-9 &'./()+-]+$/;
const KEYWORD_CHARS = /^[A-Za-z0-9 ,.&'/+:()_-]*$/;
const LOCATION_CHARS = /^[A-Za-z0-9 .'-]+$/;
const OUTWARD_RE = /^[A-Z]{1,2}[0-9][0-9A-Z]?$/;
const POSTCODE_RE = /^([A-Z]{1,2}[0-9][0-9A-Z]?) ?([0-9][A-Z]{2})$/;
const PLACE_RE = /^[A-Z][A-Z .'-]{1,38}[A-Z]$/;
const KEYWORD_NONE_RE = /^(none|\(none\)|n\/a|null|undefined|-)$/i;
const KEYWORD_DROP_RE = /^(-?location:[a-z0-9]+|currentlocation:[a-z0-9]+)$/i;
const WS_RE = /[ \t\r\n]+/g;
const KEYWORD_SPLIT_RE = /[ \t\r\n,]+/;
const NAME_DATE_RE = /(\d{4}-\d{2}-\d{2})/;

const DENY_BASENAME_RE = /^(\.env(\..*)?|auth\.json|state\.db|.*credentials.*|.*session.*\.json|.*\.pem|.*\.key|id_rsa.*)$/i;
const DENY_DIRS = new Set(['secrets', 'state', '.ssh', '.git']);

const STATUS_MAX_AGE_MIN = {
  phase1_initializing: 20, phase1_taking_over: 5, phase1_searching: 30, phase1_active: 60, phase1_running: 60,
  phase1_complete: 10, phase2_starting: 30, phase2_pushing: 30,
};
const PHASE2_ACTIVE = ['phase2_starting', 'phase2_pushing'];
const CLAIM_STALE_MS = 10 * 60 * 1000;
const LOCK_STALE_MS = 30 * 1000;
const LOCK_WAIT_MS = 3000;
const PENDING_PARSE_CAP = 500;
const SEARCH_QUEUE_CAP = 25; // manual searches waiting at once; each one spends paid Caterer credits (same value in plugin_api.py)
const MANUAL_SOURCES = ['dashboard', 'request-search-cli'];
const RUN_SCAN_CAP = 300;
const LIVE_WINDOW_MS = 2 * 3600 * 1000;

const BACKSLASH = String.fromCharCode(92);

class JailError extends Error {}

class ValidationError extends Error {
  constructor(field, detail) { super(detail); this.field = field; this.detail = detail; }
}

function resolveHome(env) {
  const e = env || process.env;
  if (e.RESOURCER_HOME) return path.resolve(e.RESOURCER_HOME);
  // An operator shell on the instance has no RESOURCER_HOME: the real workspace beats a repo checkout's resourcer/ directory.
  if (fs.existsSync(DEFAULT_HOME)) return DEFAULT_HOME;
  if (sharedPaths && sharedPaths.HOME) return sharedPaths.HOME;
  return DEFAULT_HOME;
}

function realResolve(p) {
  try {
    return fs.realpathSync.native(p);
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(realResolve(parent), path.basename(p));
  }
}

/** Resolve parts under home: rejects absolute paths, '..', symlink escapes and secret-looking names. */
function jailPath(home, ...parts) {
  const root = realResolve(path.resolve(home));
  const segments = [];
  for (const part of parts) {
    const s = String(part);
    if (s.includes('\0')) throw new JailError('NUL byte in path');
    if (s.startsWith('/') || s.startsWith(BACKSLASH) || /^[A-Za-z]:/.test(s)) throw new JailError('absolute paths are not allowed');
    for (const seg of s.split(BACKSLASH).join('/').split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') throw new JailError("'..' segments are not allowed");
      segments.push(seg);
    }
  }
  const denied = (segs) => segs.some((x, i) => DENY_DIRS.has(x.toLowerCase()) || (i === segs.length - 1 && DENY_BASENAME_RE.test(x)));
  if (denied(segments)) throw new JailError('path is not accessible');
  const target = realResolve(path.join(root, ...segments));
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new JailError('path escapes the resourcer home');
  const relParts = rel === '' ? [] : rel.split(path.sep);
  if (denied(relParts)) throw new JailError('path is not accessible');
  return target;
}

function readJsonCapped(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > maxBytes) return null;
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

function readJsonJailed(home, ...parts) {
  try { return readJsonCapped(jailPath(home, ...parts), 2 * 1024 * 1024); } catch { return null; }
}

function londonHour(date) {
  if (sharedTime && typeof sharedTime.londonHour === 'function') return sharedTime.londonHour(date);
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', hour: '2-digit' });
  return Number(fmt.format(date));
}

function loadSettings(home) {
  const settings = { location_mode: 'outward', operating_hours: { start: 6, end: 22 } };
  const raw = readJsonJailed(home, 'config', 'dashboard-settings.json');
  if (raw) {
    if (raw.location_mode === 'outward' || raw.location_mode === 'any') settings.location_mode = raw.location_mode;
    const oh = raw.operating_hours;
    if (oh && Number.isInteger(oh.start) && Number.isInteger(oh.end) && oh.start >= 0 && oh.end <= 24 && oh.start < oh.end) {
      settings.operating_hours = { start: oh.start, end: oh.end };
    }
  }
  return settings;
}

function loadSearchDefaults(home) {
  const raw = readJsonJailed(home, 'config', 'territory-defaults.json') || {};
  const cv = Number.isInteger(raw.cvLimit) && raw.cvLimit >= CV_LIMIT_MIN && raw.cvLimit <= CV_LIMIT_MAX ? raw.cvLimit : 20;
  return {
    distance: VALID_DISTANCES.includes(raw.distance) ? raw.distance : 20,
    activeWithin: VALID_ACTIVE_WITHIN.includes(raw.activeWithin) ? raw.activeWithin : '1 month',
    cvLimit: cv,
    priority: VALID_PRIORITIES.includes(raw.priority) ? raw.priority : 'low',
    sources: VALID_SOURCES.includes(raw.sources) ? raw.sources : 'both',
  };
}

function normaliseTitle(raw) {
  return raw.trim().replace(WS_RE, ' ').split(' ').map((w) => {
    const up = w.toUpperCase();
    return ACRONYMS.has(up) ? up : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

function normaliseLocation(raw) {
  return raw.trim().toUpperCase().replace(WS_RE, ' ');
}

function normaliseKeywords(raw) {
  const text = raw.trim();
  if (!text || KEYWORD_NONE_RE.test(text)) return '';
  const tokens = text.toLowerCase().split(KEYWORD_SPLIT_RE).filter(Boolean).filter((t) => !KEYWORD_DROP_RE.test(t));
  return [...new Set(tokens)].sort().join(' ');
}

function toInt(value) {
  if (typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^\s*\d{1,6}\s*$/.test(value)) return parseInt(value.trim(), 10);
  return null;
}

function locationError() {
  return 'Enter the postcode area only (outward code such as YO2, M1, LS1), not a city name or a full postcode.';
}

/** Returns the normalised request fields (no requestedAt/source) or throws ValidationError. */
function validateFields(input, defaults, locationMode) {
  const payload = input && typeof input === 'object' ? input : {};
  const titleRaw = payload.jobTitle;
  if (typeof titleRaw !== 'string' || !titleRaw.trim()) throw new ValidationError('jobTitle', 'Job title is required');
  if (!TITLE_CHARS.test(titleRaw.trim().replace(WS_RE, ' '))) {
    throw new ValidationError('jobTitle', "Job title may only contain letters, numbers, spaces and & ' . / ( ) + -");
  }
  const jobTitle = normaliseTitle(titleRaw);
  if (jobTitle.length < 2 || jobTitle.length > 60) throw new ValidationError('jobTitle', 'Job title must be 2 to 60 characters');

  const locRaw = payload.location;
  if (typeof locRaw !== 'string' || !locRaw.trim()) throw new ValidationError('location', 'Location is required');
  if (!LOCATION_CHARS.test(locRaw.trim().replace(WS_RE, ' '))) throw new ValidationError('location', locationError());
  let location = normaliseLocation(locRaw);
  if (OUTWARD_RE.test(location)) {
    // outward code accepted as is
  } else if (locationMode === 'any' && POSTCODE_RE.test(location)) {
    const m = POSTCODE_RE.exec(location);
    location = `${m[1]} ${m[2]}`;
  } else if (locationMode === 'any' && !CITY_NAMES.has(location.toLowerCase()) && PLACE_RE.test(location)) {
    // place name accepted only in 'any' mode
  } else {
    throw new ValidationError('location', locationError());
  }

  let kwRaw = payload.keywords === undefined || payload.keywords === null ? '' : payload.keywords;
  if (typeof kwRaw !== 'string' || kwRaw.length > 120 || !KEYWORD_CHARS.test(kwRaw)) {
    throw new ValidationError('keywords', "Keywords may only contain letters, numbers, spaces and , . & ' / + : ( ) _ - (max 120 characters)");
  }
  const keywords = normaliseKeywords(kwRaw);
  if (keywords.length > 60) throw new ValidationError('keywords', 'Keywords are too long (max 60 characters once normalised)');

  let sources = payload.sources === undefined || payload.sources === null ? defaults.sources : payload.sources;
  if (!VALID_SOURCES.includes(sources)) throw new ValidationError('sources', 'Source must be one of: both, caterer, reed');
  let priority = payload.priority === undefined || payload.priority === null ? defaults.priority : payload.priority;
  if (!VALID_PRIORITIES.includes(priority)) throw new ValidationError('priority', 'Priority must be one of: high, medium, low');

  const distance = payload.distance === undefined || payload.distance === null || payload.distance === '' ? defaults.distance : toInt(payload.distance);
  if (!VALID_DISTANCES.includes(distance)) throw new ValidationError('distance', `Distance must be one of: ${VALID_DISTANCES.join(', ')} miles`);
  let active = payload.activeWithin === undefined || payload.activeWithin === null || payload.activeWithin === '' ? defaults.activeWithin : payload.activeWithin;
  if (typeof active !== 'string' || !VALID_ACTIVE_WITHIN.includes(active.trim())) {
    throw new ValidationError('activeWithin', `Active within must be one of: ${VALID_ACTIVE_WITHIN.join(', ')}`);
  }
  active = active.trim();
  const cvRaw = payload.cvLimit;
  const cvLimit = cvRaw === undefined || cvRaw === null || cvRaw === '' ? defaults.cvLimit : toInt(cvRaw);
  if (cvLimit === null || cvLimit < CV_LIMIT_MIN || cvLimit > CV_LIMIT_MAX) {
    throw new ValidationError('cvLimit', `CVs per run must be a whole number from ${CV_LIMIT_MIN} to ${CV_LIMIT_MAX}`);
  }

  const overrides = [['distance', distance], ['activeWithin', active], ['cvLimit', cvLimit]]
    .filter(([k, v]) => v !== defaults[k]).map(([k]) => k);
  return { jobTitle, location, keywords, priority, sources, distance, activeWithin: active, cvLimit, overrides };
}

function validateSearch(input, defaults, locationMode) {
  try {
    return { ok: true, value: validateFields(input, defaults, locationMode || 'outward') };
  } catch (e) {
    if (e instanceof ValidationError) return { ok: false, status: 400, error: 'validation', field: e.field, detail: e.detail };
    throw e;
  }
}

const keyOf = (title, location) => `${String(title || '').trim().toLowerCase()}|${String(location || '').trim().toLowerCase()}`;
const scrub = (v, n) => String(v === undefined || v === null ? '' : v).slice(0, n);

function scanPending(home, now) {
  let dir;
  try { dir = jailPath(home, 'pending-searches'); } catch { return { names: [], items: [], unparsed: 0 }; }
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
  } catch { names = []; }
  const items = [];
  let unparsed = 0;
  for (const name of names.slice(0, PENDING_PARSE_CAP)) {
    let data = null;
    try { data = readJsonCapped(jailPath(home, 'pending-searches', name), 64 * 1024); } catch { data = null; }
    if (!data) { unparsed++; continue; }
    const claimedAt = data.spawnedAt ? Date.parse(data.spawnedAt) : NaN;
    items.push({
      file: name,
      jobTitle: scrub(data.jobTitle, 80),
      location: scrub(data.location, 40),
      distance: Number.isInteger(data.distance) ? data.distance : null,
      keywords: scrub(data.keywords, 60),
      sources: VALID_SOURCES.includes(data.sources) ? data.sources : null,
      source: data.source ? scrub(data.source, 60) : null,
      requestedAt: typeof data.requestedAt === 'string' ? data.requestedAt : null,
      claimed: !!data.spawnedAt,
      claimFresh: !Number.isNaN(claimedAt) && now.getTime() - claimedAt < CLAIM_STALE_MS,
    });
  }
  return { names, items, unparsed };
}

function scanActiveRuns(home, now) {
  let dir;
  try { dir = jailPath(home, 'runs'); } catch { return []; }
  const cutoff = new Date(now.getTime() - 2 * 86400000).toISOString().slice(0, 10);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  names = names.filter((n) => !n.startsWith('.') && n.endsWith('.json') && (n.startsWith('phase1-') || n.startsWith('run-')))
    .filter((n) => { const m = NAME_DATE_RE.exec(n); return !m || m[1] >= cutoff; })
    .sort().reverse();
  names = [...names.filter((n) => n.startsWith('phase1-')).slice(0, RUN_SCAN_CAP), ...names.filter((n) => n.startsWith('run-')).slice(0, RUN_SCAN_CAP)];
  const terminal = new Map();
  const phase2 = [];
  const phase1 = [];
  for (const name of names) {
    let file; let mtime;
    try { file = jailPath(home, 'runs', name); mtime = fs.statSync(file).mtimeMs; } catch { continue; }
    const data = readJsonCapped(file, 512 * 1024);
    if (!data) continue;
    const key = keyOf(data.jobTitle, data.location);
    if (name.startsWith('run-')) {
      if (data.status === 'complete' || data.status === 'error') {
        const t = Date.parse(data.completedAt || data.updatedAt || data.startedAt);
        terminal.set(key, Math.max(terminal.get(key) || 0, Number.isNaN(t) ? mtime : t));
      } else if (PHASE2_ACTIVE.includes(data.status)) {
        phase2.push({ data, mtime });
      }
    } else if (Object.prototype.hasOwnProperty.call(STATUS_MAX_AGE_MIN, data.status) && !PHASE2_ACTIVE.includes(data.status)) {
      phase1.push({ data, mtime });
    }
  }
  const active = [];
  const covered = new Set();
  const record = (item) => {
    const d = item.data;
    const updated = Date.parse(d.updatedAt);
    const touch = Math.max(Number.isNaN(updated) ? 0 : updated, item.mtime);
    const idleMs = Math.max(0, now.getTime() - touch);
    if (idleMs > LIVE_WINDOW_MS) return null;
    const sources = VALID_SOURCES.includes(d.sources) ? d.sources : 'caterer';
    let maxAge = STATUS_MAX_AGE_MIN[d.status] || 30;
    if (d.status === 'phase1_complete' && (sources === 'both' || sources === 'reed')) maxAge = 60;
    return { jobTitle: scrub(d.jobTitle, 80), location: scrub(d.location, 40), distance: Number.isInteger(d.distance) ? d.distance : 20, sources, stale: idleMs > maxAge * 60000 };
  };
  for (const item of phase2) {
    const rec = record(item);
    if (rec) { active.push(rec); covered.add(keyOf(item.data.jobTitle, item.data.location)); }
  }
  for (const item of phase1) {
    const d = item.data;
    const key = keyOf(d.jobTitle, d.location);
    if (covered.has(key)) continue;
    if (d.status === 'phase1_complete' && d.phase2Status === 'done') continue;
    if ((terminal.get(key) || 0) >= item.mtime) continue;
    const rec = record(item);
    if (rec) active.push(rec);
  }
  return active;
}

function findDuplicate(home, title, location, now) {
  const key = keyOf(title, location);
  for (const item of scanPending(home, now).items) {
    if (keyOf(item.jobTitle, item.location) === key) {
      return { where: 'pending', file: item.file, jobTitle: item.jobTitle, location: item.location, distance: item.distance,
        keywords: item.keywords, sources: item.sources, claimed: item.claimed };
    }
  }
  for (const run of scanActiveRuns(home, now)) {
    if (!run.stale && keyOf(run.jobTitle, run.location) === key) {
      return { where: 'in_flight', file: null, jobTitle: run.jobTitle, location: run.location, distance: run.distance,
        keywords: '', sources: run.sources, claimed: true };
    }
  }
  return null;
}

const LINK_FALLBACK_CODES = new Set(['EPERM', 'EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EACCES', 'UNKNOWN']);

function writeNewFileAtomic(dir, makeName, text) {
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 8; attempt++) {
    const name = makeName();
    const tmp = path.join(dir, `.${name}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    const fd = fs.openSync(tmp, 'wx', 0o664);
    try {
      try {
        fs.writeSync(fd, text);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const final = path.join(dir, name);
      try {
        fs.linkSync(tmp, final);
      } catch (e) {
        if (e.code === 'EEXIST') continue;
        if (!LINK_FALLBACK_CODES.has(e.code)) throw e;
        if (fs.existsSync(final)) continue;
        fs.renameSync(tmp, final);
      }
      try { fs.chmodSync(final, 0o664); } catch { /* best effort */ }
      try {
        const dfd = fs.openSync(dir, 'r');
        try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
      } catch { /* directory fsync is best effort (not supported on every platform) */ }
      return name;
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* already renamed or removed */ }
    }
  }
  throw new Error('could not allocate a unique file name');
}

async function withDirLock(dir, fn, waitMs) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.request-search.lock');
  const deadline = Date.now() + (waitMs === undefined ? LOCK_WAIT_MS : waitMs);
  const token = crypto.randomBytes(8).toString('hex');
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o664);
      try { fs.writeSync(fd, `${process.pid} ${Math.floor(Date.now() / 1000)} ${token}`); } finally { fs.closeSync(fd); }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; }
      } catch { /* lock vanished: retry */ }
      if (Date.now() > deadline) {
        const err = new Error('another search request is being written; try again');
        err.code = 'LOCK_BUSY';
        throw err;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      if (fs.readFileSync(lock, 'utf8').includes(token)) fs.unlinkSync(lock);
    } catch { /* already gone */ }
  }
}

const newSearchFilename = (now) => `search-${now.getTime()}-${crypto.randomBytes(3).toString('hex')}.json`;

/** Validate, dedupe and write. Resolves { status, body } exactly like the plugin route. */
async function enqueueSearch({ home, input, now, dryRun, locationMode, lockWaitMs }) {
  const clock = now || new Date();
  const settings = loadSettings(home);
  const defaults = loadSearchDefaults(home);
  const checked = validateSearch(input, defaults, locationMode || settings.location_mode);
  if (!checked.ok) return { status: 400, body: { error: checked.error, field: checked.field, detail: checked.detail } };
  const request = { ...checked.value, requestedAt: clock.toISOString(), source: 'request-search-cli' };
  const pendingDir = jailPath(home, 'pending-searches');

  const work = async () => {
    const dup = findDuplicate(home, request.jobTitle, request.location, clock);
    if (dup) {
      return { status: 409, body: {
        error: 'already_queued',
        detail: `${dup.jobTitle} | ${dup.location} is already ${dup.where === 'in_flight' ? 'running' : 'queued'}; it will run in queue order.`,
        file: dup.file, existing: dup,
      } };
    }
    const waiting = scanPending(home, clock);
    const manual = waiting.items.filter((i) => !i.claimFresh && MANUAL_SOURCES.includes(i.source)).length;
    if (manual >= SEARCH_QUEUE_CAP || waiting.names.length > PENDING_PARSE_CAP) {
      return { status: 429, body: {
        error: 'queue_full',
        detail: `${manual} manual searches are already waiting (limit ${SEARCH_QUEUE_CAP}); they run in queue order, so try again later.`,
        waiting: manual, limit: SEARCH_QUEUE_CAP,
      } };
    }
    if (dryRun) return { status: 200, body: { ok: true, dryRun: true, request } };
    const name = writeNewFileAtomic(pendingDir, () => newSearchFilename(clock), JSON.stringify(request, null, 2) + '\n');
    const written = readJsonCapped(jailPath(home, 'pending-searches', name), 64 * 1024);
    if (!written || Object.prototype.hasOwnProperty.call(written, 'spawnedAt')) {
      try { fs.unlinkSync(jailPath(home, 'pending-searches', name)); } catch { /* best effort */ }
      return { status: 500, body: { error: 'write_verify_failed', detail: 'the queued file could not be read back; nothing was queued' } };
    }
    const pend = scanPending(home, clock);
    const unclaimed = pend.items.filter((i) => !i.claimFresh).map((i) => i.file);
    const halt = readJsonJailed(home, 'runtime', 'pipeline-halt.json');
    const halted = !!(halt && halt.halted);
    const hour = londonHour(clock);
    const inside = hour >= settings.operating_hours.start && hour < settings.operating_hours.end;
    return { status: 200, body: {
      ok: true, file: name, queueDepthAfter: pend.names.length,
      position: unclaimed.includes(name) ? unclaimed.indexOf(name) + 1 : null,
      pipelineHalted: halted, inOperatingHours: inside,
      note: halted ? 'The pipeline is halted; the search is queued and will start when the halt clears.'
        : inside ? 'Queued. It is picked up in queue order, ahead of scheduled territories.'
          : 'Queued. It will start when operating hours begin.',
      request,
    } };
  };
  return dryRun ? work() : withDirLock(pendingDir, work, lockWaitMs);
}

const USAGE = `Usage: node tools/request-search.js --job <title> --location <postcode area> [options]

Queue a one-off search (an atomic pending-searches/search-*.json drop). It runs ahead of scheduled territories.

Options:
  --job <title>             job title, e.g. "Sous Chef" (required)
  --location <area>         outward postcode, e.g. YO2 (required)
  --keywords <text>         optional keywords, e.g. "DBS"
  --sources <s>             both | caterer | reed (default from config/territory-defaults.json, else both)
  --priority <p>            high | medium | low (default low)
  --distance <miles>        ${VALID_DISTANCES.join(' | ')} (default 20)
  --active-within <text>    ${VALID_ACTIVE_WITHIN.join(' | ')}
  --cv-limit <n>            ${CV_LIMIT_MIN}-${CV_LIMIT_MAX} (default 20)
  --location-mode <m>       outward (default) | any (also accept a full postcode or a place name)
  --home <dir>              workspace to use (default: RESOURCER_HOME, else the instance workspace if it exists, else ./resourcer of this checkout)
  --dry-run                 validate and check for duplicates, write nothing
  --json                    print the result as JSON
  --help                    show this text

Exit codes: 0 queued, 1 unexpected error, 2 usage or validation error, 3 already queued or running, 4 could not write or ${SEARCH_QUEUE_CAP} manual searches are already waiting.`;

const FLAGS = {
  '--job': 'jobTitle', '--location': 'location', '--keywords': 'keywords', '--sources': 'sources', '--priority': 'priority',
  '--distance': 'distance', '--active-within': 'activeWithin', '--cv-limit': 'cvLimit',
};

function parseArgs(argv) {
  const input = {};
  const opts = { dryRun: false, json: false, help: false, locationMode: null, home: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--location-mode' || a === '--home' || Object.prototype.hasOwnProperty.call(FLAGS, a)) {
      if (i + 1 >= argv.length) throw new ValidationError('usage', `${a} needs a value`);
      const v = argv[++i];
      if (a === '--location-mode') opts.locationMode = v;
      else if (a === '--home') opts.home = v;
      else input[FLAGS[a]] = v;
    } else {
      throw new ValidationError('usage', `unknown option ${a}`);
    }
  }
  return { input, opts };
}

async function main(argv, io) {
  const out = (io && io.out) || ((s) => process.stdout.write(s + '\n'));
  const err = (io && io.err) || ((s) => process.stderr.write(s + '\n'));
  const env = (io && io.env) || process.env;
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    err(`ERROR: ${e.detail || e.message}`);
    err(USAGE);
    return 2;
  }
  if (parsed.opts.help) { out(USAGE); return 0; }
  if (parsed.opts.locationMode && !['outward', 'any'].includes(parsed.opts.locationMode)) {
    err('ERROR: --location-mode must be outward or any');
    return 2;
  }
  const home = parsed.opts.home ? path.resolve(parsed.opts.home) : resolveHome(env);
  let result;
  try {
    result = await enqueueSearch({ home, input: parsed.input, dryRun: parsed.opts.dryRun, now: io && io.now, locationMode: parsed.opts.locationMode, lockWaitMs: io && io.lockWaitMs });
  } catch (e) {
    if (e instanceof JailError) { err(`ERROR: ${e.message}`); return 4; }
    if (e.code === 'LOCK_BUSY') { err(`ERROR: ${e.message}`); return 4; }
    if (e.code && /^E[A-Z]+$/.test(e.code)) { err(`ERROR: could not write: ${e.message}`); return 4; }
    err(`ERROR: ${e.message}`);
    return 1;
  }
  if (parsed.opts.json) out(JSON.stringify(result.body));
  if (result.status === 200) {
    if (!parsed.opts.json) {
      out(result.body.dryRun ? `VALID: ${result.body.request.jobTitle} | ${result.body.request.location} (dry run, nothing written)`
        : `QUEUED: ${result.body.file} (position ${result.body.position || '?'}, queue depth ${result.body.queueDepthAfter}). ${result.body.note}`);
    }
    return 0;
  }
  if (!parsed.opts.json) {
    err(result.status === 409 ? `DUPLICATE: ${result.body.detail}` : `ERROR: ${result.body.field ? result.body.field + ': ' : ''}${result.body.detail}`);
  }
  if (result.status === 400) return 2;
  if (result.status === 409) return 3;
  return 4;
}

module.exports = {
  main, parseArgs, resolveHome, jailPath, JailError, ValidationError, validateSearch, normaliseTitle, normaliseLocation,
  normaliseKeywords, loadSettings, loadSearchDefaults, scanPending, scanActiveRuns, findDuplicate, writeNewFileAtomic,
  withDirLock, enqueueSearch, newSearchFilename, USAGE,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`ERROR: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
  });
}
