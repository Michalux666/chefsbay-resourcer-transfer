'use strict';
// Role-scoped second look at a candidate who was unlocked and then rejected by CV screening (docs/RESURFACE.md).
//
// The rule (the same for Caterer and Reed, evaluated by classify()): an UNLOCKED candidate is not skipped for the search title R when
//   (a) the candidate has no Zoho id and was never pushed (candidates.zoho_id and zoho_pushed_at are empty, no results file records a push),
//   (b) the candidate has a record of an unlock-and-reject: a CV rejection (origin cv:...), a row of this module (origin resurface:...), or a legacy
//       row whose title is the sentinel '*' or empty (role unknown). A plain pre-unlock snippet rejection of another role (a real title, origin
//       pipeline) is NOT such a record: it may belong to a failed push or a stranded candidate, which keeps the old skip. For Reed only cv: and resurface: count.
//   (c) no candidate_rejections row for R exists (any origin, including this module's own 'resurface:started'),
//   (d) the daily cap allows one more (CV_RESURFACE_MAX_PER_DAY; the balance reserve is checked by the caller that reads the balance),
//   (e) CV_RESURFACE is on and CV_SCREEN is on (without CV_SCREEN=on no CV rejection exists, so the rule can never fire),
// and nothing of the candidate is in flight (a candidate file, a CV file or an unfinished queue). Everything else keeps the old skip.
// The unknown-title sentinel '*' counts as "role unknown" only here, for an unlocked, never-pushed candidate; for every other candidate it still
// blocks every title, exactly as before.
//
// The durable record of the charge is a candidate_rejections row for the NEW title with origin 'resurface:started', written by claim()
// BEFORE the CV is fetched again. The CV stage later turns it into 'cv:<codes>' when it rejects. That row is what makes a second charge for the
// same candidate and role impossible: a crash, a retry, an overlapping run and a recovered queue all find it.
//
// Counters (a small state file under runtime/, mode 0600, atomic writes, one London day): resurfaced candidates, charged / not charged /
// unknown, credits and Reed views spent, stops by the cap or the reserve. Nothing here ever throws into the pipeline: a failure of the accounting
// answers "not allowed", which is the old skip.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const fsx = require('./fsx');
const env = require('./env');
const timeLib = require('./time');

const DEFAULT_MAX_PER_DAY = 40;
const DEFAULT_MIN_CREDITS = 1000;
const ORIGIN_STARTED = 'resurface:started';
const ORIGIN_PUSHED = 'resurface:pushed';
const ORIGIN_SNIPPET = 'resurface:snippet';
const ORIGIN_POSTUNLOCK = 'resurface:postunlock';
const ORIGIN_PREFIX = 'resurface:';
const ALERT_KEY = 'cv-resurface-cap-reached';
const HISTORY_DAYS = 45;
const MAX_FAILED = 200;
const CV_EXTENSIONS = ['.pdf', '.docx', '.doc', '.rtf', '.txt'];

const stateFile = () => path.join(paths.RUNTIME, 'cv-resurface.json');
const lockFile = () => path.join(paths.RUNTIME, 'cv-resurface.lock');

// ---------------------------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------------------------

function intSetting(name, def, warnings) {
  const raw = env.get(name);
  if (raw === undefined) return def;
  const s = String(raw).trim();
  if (/^\d{1,9}$/.test(s)) return Number(s);
  warnings.push(`${name}='${s.slice(0, 20)}' is not a whole number: using ${def}`);
  return def;
}

/** @returns {{on:boolean, max:number, minCredits:number, warnings:string[]}} CV_RESURFACE (default on), CV_RESURFACE_MAX_PER_DAY (40), CV_RESURFACE_MIN_CREDITS (1000). */
function settings() {
  const warnings = [];
  let on = true;
  const raw = env.get('CV_RESURFACE');
  if (raw !== undefined) {
    const v = String(raw).trim().toLowerCase();
    if (v === '' || v === 'on' || v === 'true' || v === '1' || v === 'yes') on = true;
    else if (v === 'off' || v === 'false' || v === '0' || v === 'no') on = false;
    else {
      // a typo can never switch spending on: anything that is not clearly "on" or "off" is off; Phase 1 and cv-report print the warning
      on = false;
      warnings.push(`CV_RESURFACE='${v.slice(0, 20)}' is neither on nor off: treated as off (the second look is not active)`);
    }
  }
  return { on, max: intSetting('CV_RESURFACE_MAX_PER_DAY', DEFAULT_MAX_PER_DAY, warnings), minCredits: intSetting('CV_RESURFACE_MIN_CREDITS', DEFAULT_MIN_CREDITS, warnings), warnings };
}

/** The CV_SCREEN mode: 'on', 'shadow' or 'off' ('unknown' when the CV stage code is missing). */
function cvScreenMode() {
  try {
    return require('./cv/config').screenMode(env.get('CV_SCREEN')).mode;
  } catch (e) {
    return 'unknown';
  }
}

/** True when CV_SCREEN is on (only then does a CV rejection exist). Missing CV stage code reads as not on. */
function cvScreenOn() {
  return cvScreenMode() === 'on';
}

/** The whole switch: the setting is on, the cap is above zero and CV_SCREEN is on. */
function active() {
  try {
    const s = settings();
    return s.on && s.max > 0 && cvScreenOn();
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// the facts of the rule, read from candidates.db
// ---------------------------------------------------------------------------------------------

const idCol = source => (source === 'reed' ? 'reed_id' : 'caterer_id');

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function hasColumn(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}

/**
 * Is this candidate_rejections row a record that the candidate was unlocked and then rejected, or one whose role is unknown?
 * Yes for: a CV rejection (origin cv:...), any row of this module (resurface:...), and a legacy row with no usable title (the sentinel '*', empty).
 * No for a plain pre-unlock snippet rejection (origin pipeline, real title): it says nothing about the role the candidate was unlocked for, so an
 * unlocked, never-pushed candidate with only such a row may be a failed push or a stranded one, which the stranded recovery owns (old skip).
 */
function isPostUnlockRecord(r) {
  const origin = typeof r.origin === 'string' ? r.origin : '';
  if (origin.startsWith('cv:') || origin.startsWith(ORIGIN_PREFIX)) return true;
  const title = r.title === null || r.title === undefined ? '' : String(r.title).trim();
  return title === '' || title === '*';
}

const asIds = ids => (ids || []).map(n => parseInt(n, 10)).filter(Boolean);
const placeholders = list => list.map(() => '?').join(',');

/**
 * The database part of the rule (a), (b), (c), for the given ids. Pure read.
 * Caterer: the candidate row is unlocked and has no Zoho id. Reed: the `unlocked` column of a Reed row is never set by the pipeline, so it is not
 * read; the rows that can exist for a Reed id are CV rejections (origin cv:...) and this module's own rows, because a Reed snippet rejection writes
 * no row at all, and one of those must be among the rows.
 * @returns {number[]} the ids that may be looked at again for jobTitle
 */
function classifyRows(db, source, ids, jobTitle) {
  const clean = asIds(ids);
  if (!clean.length || !hasTable(db, 'candidate_rejections')) return [];
  const col = idCol(source);
  if (!hasColumn(db, 'candidates', col) || !hasColumn(db, 'candidate_rejections', col)) return [];
  const ph = placeholders(clean);
  const pushedAt = hasColumn(db, 'candidates', 'zoho_pushed_at') ? ' OR zoho_pushed_at IS NOT NULL' : '';
  const unlockedSql = source === 'reed' ? '' : ' AND unlocked = 1';
  const cands = db.prepare(`SELECT ${col} AS id, (zoho_id IS NOT NULL AND zoho_id <> ''${pushedAt}) AS pushed FROM candidates WHERE ${col} IN (${ph})${unlockedSql}`).all(...clean);
  if (!cands.length) return [];
  const rows = db.prepare(`SELECT ${col} AS id, job_title AS title, origin FROM candidate_rejections WHERE ${col} IN (${ph})`).all(...clean);
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.id)) byId.set(r.id, []);
    byId.get(r.id).push(r);
  }
  const out = [];
  for (const c of cands) {
    if (c.pushed) continue;
    const mine = byId.get(c.id) || [];
    if (!mine.length) continue; // an unlocked candidate with no record at all is a stranded or failed one: the old skip, the recovery owns it
    if (source === 'reed' && !mine.some(r => typeof r.origin === 'string' && (r.origin.startsWith('cv:') || r.origin.startsWith(ORIGIN_PREFIX)))) continue;
    if (source !== 'reed' && !mine.some(isPostUnlockRecord)) continue; // only a plain pre-unlock rejection of another role: no record of an unlock-and-reject
    if (mine.some(r => r.title === jobTitle)) continue; // already judged for this role (any origin, also an unfinished resurface)
    out.push(c.id);
  }
  // in the order the caller gave (the order of the page), so that the cap holds back the last ones of a page
  const rank = new Map(clean.map((id, i) => [id, i]));
  return out.sort((x, y) => rank.get(x) - rank.get(y));
}

/**
 * Candidates of which something is still in the pipeline or already in Zoho: a candidate file, a CV file, an entry of a queue whose Phase 2 has not
 * finished, or a results file that records a push. They stay skipped, so a second charge cannot start while the first outcome is still open, and a
 * crash between the Zoho write and the database write cannot lead to a second record.
 * @returns {Set<string>}
 */
function inFlightIds(ids, opts) {
  const dir = (opts && opts.downloads) || paths.DOWNLOADS;
  const want = new Set(asIds(ids).map(String));
  const found = new Set();
  if (!want.size) return found;
  for (const id of want) {
    if (fs.existsSync(path.join(dir, `candidate-${id}.json`))) { found.add(id); continue; }
    for (const prefix of ['cv-', 'cv-reed-']) for (const ext of CV_EXTENSIONS) if (fs.existsSync(path.join(dir, `${prefix}${id}${ext}`))) found.add(id);
  }
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return found; }
  const readJson = f => fsx.readJson(path.join(dir, f), null);
  for (const n of names) {
    let m = /^((?:approved|merged|reed-approved)-queue-.+)\.json$/.exec(n);
    if (m) {
      const runId = n.replace(/^approved-queue-/, '').replace(/\.json$/, '');
      const res = readJson(`phase2-results-${runId}.json`);
      if (res && res.completedAt) continue; // finished: its candidates are decided
      const q = readJson(n);
      for (const c of (q && Array.isArray(q.candidates) ? q.candidates : [])) if (c && want.has(String(c.id))) found.add(String(c.id));
      continue;
    }
    m = /^phase2-results-.+\.json$/.exec(n);
    if (m) {
      const res = readJson(n);
      for (const c of (res && Array.isArray(res.candidates) ? res.candidates : [])) {
        if (c && c.zohoId && (c.status === 'new' || c.status === 'duplicate') && want.has(String(c.id))) found.add(String(c.id));
      }
    }
  }
  return found;
}

/**
 * The rule for one page of a search: which ids are looked at again, and how many the daily cap held back.
 * Nothing is returned (and nothing read) while the switch is off.
 * @returns {{resurface:number[], capped:number}}
 */
function classify(db, source, ids, jobTitle, opts) {
  const o = opts || {};
  const none = { resurface: [], capped: 0 };
  try {
    if (!(o.force || active())) return none;
    let eligible = classifyRows(db, source, ids, jobTitle);
    if (!eligible.length) return none;
    const busy = inFlightIds(eligible, o);
    eligible = eligible.filter(id => !busy.has(String(id)) && !failedToday(source, id, jobTitle, o));
    if (!eligible.length) return none;
    const left = remaining(o);
    if (left === null) return { resurface: [], capped: eligible.length }; // accounting unreadable: the old skip
    return { resurface: eligible.slice(0, left), capped: Math.max(0, eligible.length - left) };
  } catch (e) {
    return none;
  }
}

// ---------------------------------------------------------------------------------------------
// the counters: one small file, one London day, a lock around every read-modify-write
// ---------------------------------------------------------------------------------------------

const DAY_KEYS = ['started', 'caterer', 'reed', 'charged', 'notCharged', 'unknown', 'credits', 'reedViews', 'capped', 'reserve', 'unreadable', 'pushed', 'rejected'];

function emptyDay(day) {
  const d = { day };
  for (const k of DAY_KEYS) d[k] = 0;
  return d;
}

function londonDay(now) { return timeLib.londonParts(now ? new Date(now) : new Date()).ymd; }

function normalise(raw, day) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const today = s.today && typeof s.today === 'object' ? s.today : null;
  const history = Array.isArray(s.history) ? s.history.filter(h => h && typeof h.day === 'string') : [];
  let cur = emptyDay(day);
  let failed = [];
  if (today && today.day === day) {
    for (const k of DAY_KEYS) cur[k] = Number(today[k]) || 0;
    if (Array.isArray(today.failed)) failed = today.failed.filter(k => typeof k === 'string').slice(-MAX_FAILED);
  } else if (today && typeof today.day === 'string') {
    const old = Object.assign({}, today);
    delete old.failed; // the list of today's failed attempts is not history
    history.push(old);
  }
  // one alert per London day and reason (the cap and the reserve are separate); an older file with one alertDay counts for both
  const ad = s.alertDays && typeof s.alertDays === 'object' && !Array.isArray(s.alertDays) ? s.alertDays : {};
  const legacy = typeof s.alertDay === 'string' ? s.alertDay : null;
  const alertDays = { cap: typeof ad.cap === 'string' ? ad.cap : legacy, reserve: typeof ad.reserve === 'string' ? ad.reserve : legacy };
  const out = { version: 1, today: cur, history: history.slice(-HISTORY_DAYS), alertDays };
  out.today.day = day;
  if (failed.length) out.today.failed = failed;
  return out;
}

function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* no wait */ } }

function withLock(fn) {
  const file = lockFile();
  fsx.ensureDir(path.dirname(file), 0o700);
  const t0 = Date.now();
  let fd = null;
  for (;;) {
    try { fd = fs.openSync(file, 'wx', 0o600); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(file).mtimeMs > 30000) { fs.unlinkSync(file); continue; } } catch (e2) { /* raced */ }
      if (Date.now() - t0 > 5000) throw new Error('cv-resurface.json is locked');
      sleepSync(25);
    }
  }
  try { return fn(); } finally { try { fs.closeSync(fd); } catch (e) { /* closed */ } try { fs.unlinkSync(file); } catch (e) { /* gone */ } }
}

/** Reads the state (a missing or broken file is a new day, never an error). */
function readState(now) { return normalise(fsx.readJson(stateFile(), null), londonDay(now)); }

/** Read-modify-write under the lock; returns what fn returns, throws when the file cannot be written. */
function mutate(fn, now) {
  return withLock(() => {
    const s = readState(now);
    const r = fn(s);
    fsx.writeJsonAtomic(stateFile(), s, 0o600);
    try { fs.chmodSync(stateFile(), 0o600); } catch (e) { /* best effort */ }
    return r;
  });
}

/** How many more candidates today's cap allows; null when the counters cannot be read. */
function remaining(opts) {
  try {
    const max = (opts && opts.max !== undefined) ? opts.max : settings().max;
    return Math.max(0, max - readState(opts && opts.now).today.started);
  } catch (e) {
    return null;
  }
}

/** Takes one slot of today's cap. {ok:true} or {ok:false, reason:'cap'|'error'}. */
function reserveSlot(source, opts) {
  try {
    const max = (opts && opts.max !== undefined) ? opts.max : settings().max;
    return mutate(s => {
      if (s.today.started >= max) return { ok: false, reason: 'cap' };
      s.today.started++;
      s.today[source === 'reed' ? 'reed' : 'caterer']++;
      return { ok: true };
    }, opts && opts.now);
  } catch (e) {
    return { ok: false, reason: 'error' };
  }
}

/** Gives a slot back (a claim that was not made, or an unlock that failed without a charge). */
function releaseSlot(source, opts) {
  try {
    mutate(s => {
      if (s.today.started > 0) s.today.started--;
      const k = source === 'reed' ? 'reed' : 'caterer';
      if (s.today[k] > 0) s.today[k]--;
    }, opts && opts.now);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Counts what happened to one resurfaced candidate. kind: 'charged' | 'notCharged' | 'unknown' (the cost of the re-download), plus the spend.
 * @param {{kind?:string, credits?:number, views?:number, stop?:'capped'|'reserve'|'unreadable', n?:number, pushed?:boolean, rejected?:boolean}} ev
 */
function record(ev, opts) {
  try {
    return mutate(s => {
      const n = ev.n === undefined ? 1 : Number(ev.n) || 0;
      if (ev.kind === 'charged' || ev.kind === 'notCharged' || ev.kind === 'unknown') s.today[ev.kind] += n;
      if (ev.credits) s.today.credits += Number(ev.credits) || 0;
      if (ev.views) s.today.reedViews += Number(ev.views) || 0;
      if (ev.stop === 'capped' || ev.stop === 'reserve' || ev.stop === 'unreadable') s.today[ev.stop] += n;
      if (ev.pushed) s.today.pushed += n;
      if (ev.rejected) s.today.rejected += n;
      return true;
    }, opts && opts.now);
  } catch (e) {
    return false;
  }
}

/**
 * One WARN alert per London day and reason when the cap (or the reserve) stopped a candidate. Returns true when the alert was raised now.
 * The day is marked inside the lock BEFORE the alert is sent (two processes cannot both send), and taken back if sending throws.
 * @param {{why:'cap'|'reserve', detail?:string, notify?:Function, now?:any}} o
 */
function alertStopped(o) {
  const why = o.why === 'reserve' ? 'reserve' : 'cap';
  let day = null;
  try {
    const raise = mutate(s => {
      if (s.alertDays[why] === s.today.day) return false;
      s.alertDays[why] = s.today.day;
      day = s.today.day;
      return true;
    }, o.now);
    if (!raise) return false;
    const st = settings();
    const text = why === 'reserve'
      ? `Resurfaced candidates are held back today: the Caterer balance is below the reserve of ${st.minCredits} credits (CV_RESURFACE_MIN_CREDITS). They stay skipped for now, nothing was recorded against them, and they are looked at again once the balance is above it.`
      : `The cap of ${st.max} resurfaced candidates a day (CV_RESURFACE_MAX_PER_DAY) was reached: more people who were unlocked and rejected for another role came up than the cap allows. They stay skipped for now, nothing was recorded against them, and they are looked at again tomorrow. The day's numbers: node scripts/cv-report.js.`;
    const send = o.notify || require('./notify').notify;
    try {
      send({ severity: 'warn', key: ALERT_KEY, text: o.detail ? `${text} ${o.detail}` : text, meta: { cap: st.max, minCredits: st.minCredits, why } });
    } catch (e) {
      // the alert did not go out: the day is not used up, the next stop raises it again
      try { mutate(s => { if (s.alertDays[why] === day) s.alertDays[why] = null; }, o.now); } catch (e2) { /* nothing more to do */ }
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// failed re-opens of the day: a candidate whose second unlock failed with nothing spent is not tried again before the next London day
// ---------------------------------------------------------------------------------------------

const failKey = (source, id, title) => `${source === 'reed' ? 'reed' : 'caterer'}:${parseInt(id, 10)}:${String(title)}`;

/** True when this candidate's second look for this title already failed today (nothing spent). Unreadable counters read as false (the rule's other guards stand). */
function failedToday(source, id, title, opts) {
  try { return (readState(opts && opts.now).today.failed || []).includes(failKey(source, id, title)); } catch (e) { return false; }
}

/** Notes that the second look of this candidate failed without a charge, so the same people are not screened and tried again by every run of the day. */
function noteFailed(source, id, title, opts) {
  try {
    return mutate(s => {
      const f = s.today.failed || [];
      const k = failKey(source, id, title);
      if (!f.includes(k)) f.push(k);
      s.today.failed = f.slice(-MAX_FAILED);
      return true;
    }, opts && opts.now);
  } catch (e) {
    return false;
  }
}

/** The days the report shows: today and the history, oldest first, from a London day on. */
function days(fromDay, opts) {
  const s = readState(opts && opts.now);
  return s.history.concat([s.today]).filter(d => !fromDay || d.day >= fromDay);
}

// ---------------------------------------------------------------------------------------------
// the charge: claim before, measure around, release only when nothing was spent
// ---------------------------------------------------------------------------------------------

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS candidate_rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caterer_id INTEGER, reed_id INTEGER,
  job_title TEXT NOT NULL, rejected_at TEXT NOT NULL, origin TEXT
)`;

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The durable claim, written BEFORE the candidate is fetched again: one candidate_rejections row for the new title, origin 'resurface:started'.
 * It takes one slot of the daily cap, and it succeeds only if the rule still holds (a, b, c) at this moment, atomically, so two runs that
 * overlap cannot both claim the same candidate and role.
 * @returns {{claimed:true}|{claimed:false, why:'disabled'|'not-eligible'|'cap'|'already-claimed'|'error'}}
 */
function claim(db, o) {
  try {
    if (!(o.force || active())) return { claimed: false, why: 'disabled' };
    const source = o.source === 'reed' ? 'reed' : 'caterer';
    const id = parseInt(o.id, 10);
    if (!id || !o.jobTitle) return { claimed: false, why: 'not-eligible' };
    db.prepare(TABLE_SQL).run();
    const col = idCol(source);
    let slot = false;
    const tx = db.transaction(() => {
      if (!classifyRows(db, source, [id], o.jobTitle).length) return { claimed: false, why: 'not-eligible' };
      if (failedToday(source, id, o.jobTitle, o)) return { claimed: false, why: 'failed-today' };
      const r = reserveSlot(source, o);
      if (!r.ok) return { claimed: false, why: r.reason };
      slot = true;
      const info = db.prepare(`INSERT INTO candidate_rejections (${col}, job_title, rejected_at, origin)
        SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM candidate_rejections WHERE ${col} = ? AND job_title = ?)`)
        .run(id, String(o.jobTitle), today(), ORIGIN_STARTED, id, String(o.jobTitle));
      if (info.changes !== 1) { slot = false; releaseSlot(source, o); return { claimed: false, why: 'already-claimed' }; }
      return { claimed: true };
    });
    try {
      return tx.immediate();
    } catch (e) {
      if (slot) releaseSlot(source, o);
      throw e;
    }
  } catch (e) {
    return { claimed: false, why: 'error' };
  }
}

/** Takes a claim back: only a row that is still 'resurface:started' goes, and its slot with it. Called only when the measurement says nothing was spent. */
function release(db, o) {
  try {
    const source = o.source === 'reed' ? 'reed' : 'caterer';
    const col = idCol(source);
    const info = db.prepare(`DELETE FROM candidate_rejections WHERE ${col} = ? AND job_title = ? AND origin = ?`).run(parseInt(o.id, 10), String(o.jobTitle), ORIGIN_STARTED);
    if (info.changes === 1) releaseSlot(source, o);
    return info.changes === 1;
  } catch (e) {
    return false;
  }
}

/**
 * Writes a row for a rejection whose role is known and was not recorded before, so the person is never screened for that role again:
 *   resurface:snippet     a resurfaced candidate (Reed or Caterer) that the snippet screening rejected for the new role;
 *   resurface:postunlock  a candidate that Phase 1's own review rejected AFTER the unlock (written only while the second look is active: with it
 *                         off nothing is written, exactly as before), which makes that rejection role-scoped like a CV rejection.
 */
function recordSnippetReject(db, o) {
  try {
    const source = o.source === 'reed' ? 'reed' : 'caterer';
    const origin = o.origin === ORIGIN_POSTUNLOCK ? ORIGIN_POSTUNLOCK : ORIGIN_SNIPPET;
    if (origin === ORIGIN_POSTUNLOCK && !(o.force || active())) return false;
    const col = idCol(source);
    db.prepare(TABLE_SQL).run();
    const id = parseInt(o.id, 10);
    const info = db.prepare(`INSERT INTO candidate_rejections (${col}, job_title, rejected_at, origin)
      SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM candidate_rejections WHERE ${col} = ? AND job_title = ?)`)
      .run(id, String(o.jobTitle), today(), origin, id, String(o.jobTitle));
    return info.changes === 1;
  } catch (e) {
    return false;
  }
}

/** The claim row of a candidate that was pushed to Zoho becomes 'resurface:pushed' (bookkeeping only: the Zoho id already excludes the candidate for ever). */
function markPushed(db, o) {
  try {
    const col = idCol(o.source === 'reed' ? 'reed' : 'caterer');
    db.prepare(`UPDATE candidate_rejections SET origin = ?, rejected_at = ? WHERE ${col} = ? AND job_title = ? AND origin = ?`).run(ORIGIN_PUSHED, today(), parseInt(o.id, 10), String(o.jobTitle), ORIGIN_STARTED);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * What a re-download cost, from two readings of the balance (Caterer credits, or Reed profile views of the day).
 * @param {number|null} before @param {number|null} after @param {'credits'|'views'} unit
 * @returns {{kind:'charged'|'notCharged'|'unknown', credits:number, views:number}}
 */
function measure(before, after, unit) {
  const b = Number(before);
  const a = Number(after);
  const none = { kind: 'unknown', credits: 0, views: 0 };
  if (before === null || after === null || before === undefined || after === undefined || !Number.isFinite(b) || !Number.isFinite(a)) return none;
  const delta = unit === 'views' ? a - b : b - a; // views go up when spent, credits go down
  if (delta < 0) return none; // the balance moved the wrong way (a top-up, another run): not a measurement
  if (delta === 0) return { kind: 'notCharged', credits: 0, views: 0 };
  return unit === 'views' ? { kind: 'charged', credits: 0, views: delta } : { kind: 'charged', credits: delta, views: 0 };
}

/** The worse of two measurements of one candidate (a charge anywhere is a charge; unknown beats not charged). */
function combine(a, b) {
  if (!a) return b;
  if (!b) return a;
  const order = { notCharged: 0, unknown: 1, charged: 2 };
  const kind = order[a.kind] >= order[b.kind] ? a.kind : b.kind;
  return { kind, credits: (a.credits || 0) + (b.credits || 0), views: (a.views || 0) + (b.views || 0) };
}

module.exports = {
  settings, active, cvScreenOn, cvScreenMode, classify, classifyRows, inFlightIds, remaining, reserveSlot, releaseSlot, record, alertStopped, days, readState,
  claim, release, recordSnippetReject, markPushed, measure, combine, londonDay, failedToday, noteFailed, isPostUnlockRecord,
  ALERT_KEY, ORIGIN_STARTED, ORIGIN_PUSHED, ORIGIN_SNIPPET, ORIGIN_POSTUNLOCK, ORIGIN_PREFIX, DEFAULT_MAX_PER_DAY, DEFAULT_MIN_CREDITS, stateFile,
};
