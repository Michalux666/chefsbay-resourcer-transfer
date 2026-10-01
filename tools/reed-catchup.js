#!/usr/bin/env node
'use strict';
/**
 * reed-catchup.js - find the territories whose Reed half was lost and, on request, queue them again, a few a day.
 *
 * Why (docs/parity/reed-first-page.md): between 2026-09-30 17:50 and 18:28 London twelve Reed attempts failed on the first search page
 * (HTTP 400, code 50010) and were recorded as a clean empty Reed search, and earlier runs happened while Reed was switched off. Those
 * territories have had their Caterer half done and are marked searched, so nothing brings them back for a whole cadence interval.
 *
 * What it lists: a territory whose LATEST finished run since --since (default 2026-09-30) did not get a successful Reed half, while the
 * territory is still enabled and asks for Reed (territory_searches.sources both or reed). A territory with a Reed-pending mark
 * (territory_searches.reed_pending_since, set by Phase 2 when the Reed half failed) and no run row since then is listed as failed too. Categories:
 *   failed                  run_results.reed_json says status failed, or an auth failure
 *   skipped                 reed_json says status not_run (Reed did not run: held or skipped)
 *   reed_off                the run was recorded Caterer-only (Reed was off) for a territory that asks for Reed
 *   empty_with_log_failure  reed pool 0 and errors 0 (an old row, no status) AND logs/phase1-console-*.log of that day show a Reed
 *                           first-page failure for that title and place. An inference from log text, not a proof; rotated or deleted logs
 *                           cannot be read, so this category can only under-report.
 *
 * A territory whose run was merely HELD (Update C: CV screening in mode on could not reach Jev, exit 14 phase2-held; its status file in runs/ carries
 * phase2Hold and is not complete) is left out, like a queued or running one: the held queue is completed by the stranded-run recovery once the screening
 * halt clears, and a catch-up run queued now would only hold again (or unlock candidates that would be held). Counted as "held by CV screening".
 *
 * Output: counts and territory codes (outward postcodes) only. Never a name, e-mail, phone number or CV text; job titles are not printed.
 *
 * --queue N writes up to N pending-search files (pending-searches/zz-reed-catchup-<epoch ms>-<8 hex>.json: unique names, NOT the
 * minute-named files of create-pending-search.js, so a loop cannot overwrite them; the "zz" makes them sort after every scheduled or
 * dashboard search, so a catch-up only uses idle capacity). Sources both (there is no Reed-only run upstream: the Caterer half re-runs and
 * is mostly skipped as already known), priority low. Never a territory that is already queued, quarantined, running or that ran today (London day, as run_results records it); never
 * more than --per-day per UTC day (ledger runtime/reed-catchup.json); idempotent. Reed's daily profile-view budget (reed_daily_usage) is
 * respected the way the scheduler respects it: nothing is queued once today's views reach the limit, and every catch-up file reserves
 * CV_RESERVE views of the remaining budget for the day it is queued.
 *
 * --queue refuses (exit 3, nothing written) while Reed is switched off (RESOURCER_SOURCES) or held after an auth failure: the run would redo
 * the Caterer half, which can spend unlock credits, and still not do Reed. The analysis, the plan and the ledger are read under the
 * pending-searches lock, so two catch-up processes started together queue each territory once.
 *
 * Exit codes: 0 ok, 1 unexpected error, 2 usage error, 3 Reed is off or held (nothing queued), 4 could not write.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rs = require('./request-search');

const DEFAULT_SINCE = '2026-09-30';
const DEFAULT_PER_DAY = 10; // a design default; the owner decides how many a day
const CV_RESERVE = 20; // profile views one catch-up run may use (the default CV limit per run)
const DEFAULT_REED_LIMIT = 300; // the same fallback the scheduler uses when reed_daily_usage has no limit
const LEDGER_KEEP_DAYS = 14;
const LOG_CAP_BYTES = 40 * 1024 * 1024;
const SHOW_CODES = 60;

const USAGE = `Usage: node tools/reed-catchup.js [--since YYYY-MM-DD] [--queue N] [--per-day M] [--home DIR] [--json] [--dry-run]

Lists the territories whose latest finished run since --since (default ${DEFAULT_SINCE}) did not get a successful Reed half, as counts and
territory codes only. Dry run by default: nothing is written.

  --since <date>    first UTC day to look at (default ${DEFAULT_SINCE})
  --queue <N>       write up to N pending searches (sources both, priority low), oldest loss first
  --per-day <M>     never more than M catch-up searches per UTC day in total (default ${DEFAULT_PER_DAY})
  --home <dir>      workspace to use (default: RESOURCER_HOME, else the instance workspace, else ./resourcer)
  --dry-run         with --queue: print what would be queued, write nothing
  --json            print the result as JSON (same content)
  --help            this text

Exit codes: 0 ok, 1 unexpected error, 2 usage error, 3 Reed is off or held (nothing queued), 4 could not write.`;

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { since: DEFAULT_SINCE, queue: 0, perDay: DEFAULT_PER_DAY, home: null, json: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`); return argv[++i]; };
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--json') o.json = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--since') o.since = val();
    else if (a === '--queue') o.queue = val();
    else if (a === '--per-day') o.perDay = val();
    else if (a === '--home') o.home = val();
    else throw new UsageError(`unknown option ${a}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.since) || Number.isNaN(Date.parse(`${o.since}T00:00:00Z`))) throw new UsageError('--since must be a date like 2026-09-30');
  for (const k of ['queue', 'perDay']) {
    const n = typeof o[k] === 'number' ? o[k] : (/^\d{1,4}$/.test(String(o[k])) ? Number(o[k]) : NaN);
    if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${k === 'perDay' ? 'per-day' : k} must be a whole number of 0 or more`);
    o[k] = n;
  }
  return o;
}

function loadSqlite(home) {
  try { return require('better-sqlite3'); } catch { /* fall through to the resourcer install */ }
  return require(require.resolve('better-sqlite3', { paths: [path.join(__dirname, '..', 'resourcer'), home, process.cwd()] }));
}

const norm = (s) => String(s || '').trim().toLowerCase();
const keyOf = (title, location, keywords) => `${norm(title)}|${String(location || '').trim().toUpperCase()}|${norm(keywords)}`;
const utcDay = (d) => d.toISOString().slice(0, 10);
// The day of a run (run_results.date, the queue's searchDate) is the LONDON day; the Reed view budget and this tool's ledger are keyed by the UTC day.
const londonDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return utcDay(d); };

function parseJson(text) {
  if (typeof text !== 'string' || !text) return null;
  try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

// ---------------------------------------------------------------- evidence in the logs

const NEAR_RE = /\[reed-search\] POST \S+ - "(.*)" near (\S+) \(/;
const FIRST_PAGE_FAIL_RE = /Could not fetch first page|REED_FIRST_PAGE_FAILED/;
const UNSEARCHABLE_RE = /No locations found for/; // the place has no Reed location: an empty search, not a failure (older logs carry it as a first-page failure)

// Map key(title, place) -> Set of UTC days (the log file's day) on which a Reed first-page failure was logged for it. The diagnostic
// lines carry no timestamp, so the failure is attributed to the last "[reed-search] POST ... near <place>" line before it, and to the day
// the log was last written. Only those two facts are kept; no other log text is read into the result.
function firstPageFailuresInLogs(home, sinceDay) {
  const out = new Map();
  const dir = path.join(home, 'logs');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^phase1-console-.*\.log$/.test(n)); } catch { return out; }
  for (const name of names) {
    const file = path.join(dir, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    const day = utcDay(st.mtime);
    if (day < sinceDay || st.size > LOG_CAP_BYTES) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let last = null;
    for (const line of text.split('\n')) {
      const m = NEAR_RE.exec(line);
      if (m) { last = { title: m[1], place: m[2] }; continue; }
      if (last && FIRST_PAGE_FAIL_RE.test(line) && !UNSEARCHABLE_RE.test(line)) {
        const k = keyOf(last.title, last.place, '');
        if (!out.has(k)) out.set(k, new Set());
        out.get(k).add(day);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- held queues

const HELD_MAX_AGE_DAYS = 7; // the stranded-run recovery ignores status files older than this (K-CV16)

// Keys (title|PLACE) of the runs whose Phase 2 CV screening HELD and that nobody has completed yet. Reads the status files in runs/ only; nothing is printed from them.
function heldRuns(home, now) {
  const held = new Set();
  let names = [];
  try { names = fs.readdirSync(path.join(home, 'runs')).filter((n) => /^phase1-.*[.]json$/.test(n)); } catch { return held; }
  for (const n of names) {
    const d = parseJson((() => { try { return fs.readFileSync(path.join(home, 'runs', n), 'utf8').replace(String.fromCharCode(0xFEFF), ''); } catch { return ''; } })());
    if (!d || !d.phase2Hold || d.status === 'complete' || d.phase2Complete) continue;
    const since = Date.parse(d.startedAt || d.updatedAt || '');
    if (Number.isFinite(since) && now.getTime() - since > HELD_MAX_AGE_DAYS * 86400000) continue;
    held.add(`${norm(d.jobTitle)}|${String(d.location || '').toUpperCase()}`);
  }
  return held;
}

// ---------------------------------------------------------------- the analysis

function classify(run, wantsReed, logDays) {
  if (!wantsReed) return null;
  const reed = parseJson(run.reed_json);
  const status = reed && typeof reed.status === 'string' ? reed.status : null;
  if (status === 'failed' || status === 'auth_failed' || (reed && reed.authFailed === true) || (reed && reed.failed === true)) return 'failed';
  if (status === 'not_run') return 'skipped';
  if (run.sources === 'caterer' || (!reed && run.sources !== 'both' && run.sources !== 'reed')) return 'reed_off';
  const pool0 = reed && Number(reed.pool || 0) === 0 && Number(reed.errors || 0) === 0 && (status === null || status === 'empty');
  if (pool0 && logDays) {
    const d0 = run.date;
    if (logDays.has(d0) || logDays.has(addDays(d0, 1))) return 'empty_with_log_failure';
  }
  return null;
}

// `logs` (the slow part: it reads the console logs) may be passed in so a caller that holds the pending-searches lock does not read them inside it.
function analyse(home, o, now, logs) {
  const Database = loadSqlite(home);
  const dbFile = path.join(home, 'candidates.db');
  if (!fs.existsSync(dbFile)) throw new Error(`no candidates.db in ${home}`);
  const db = new Database(dbFile, { readonly: true, fileMustExist: true, timeout: 5000 });
  const today = utcDay(now);
  const todayRun = londonDay(now); // the day column of run_results is the London day
  let runs = [];
  let terrs = [];
  let usage = null;
  try {
    runs = db.prepare('SELECT run_key, date, completed_at, job_title, location, distance, keywords, sources, reed_json FROM run_results WHERE date >= ? AND completed_at IS NOT NULL ORDER BY completed_at ASC').all(o.since);
    // SELECT *: the reed_pending_since column (territory-utils.markReedHalf) exists only once a run has needed it.
    terrs = db.prepare('SELECT * FROM territory_searches').all().map((t) => ({ ...t, sources: t.sources || 'caterer' }));
    try { usage = db.prepare('SELECT profile_views, daily_limit FROM reed_daily_usage WHERE date = ?').get(today) || null; } catch { usage = null; }
  } finally {
    db.close();
  }

  const latest = new Map();
  const ranToday = new Set();
  const reedByDay = new Map(); // run day -> {attempts, failed}: the failure rate of docs/ACCEPTANCE.md RE08, without reading any log
  for (const r of runs) {
    if (r.sources === 'both' || r.sources === 'reed') {
      const rj = parseJson(r.reed_json);
      const st = rj && typeof rj.status === 'string' ? rj.status : null;
      if (rj && st !== 'not_run' && st !== 'halted' && st !== 'limit') {
        const d = reedByDay.get(r.date) || { attempts: 0, failed: 0 };
        d.attempts++;
        if (classify(r, true, null) === 'failed') d.failed++;
        reedByDay.set(r.date, d);
      }
    }
    const k = keyOf(r.job_title, r.location, r.keywords);
    latest.set(k, r); // ascending by completion: the last one wins
    if (r.date === todayRun) ranToday.add(k);
  }
  const terrByKey = new Map();
  for (const t of terrs) {
    const k = keyOf(t.job_title, t.location, t.keywords);
    const prev = terrByKey.get(k);
    if (!prev || t.distance > prev.distance) terrByKey.set(k, t);
  }

  logs = logs || firstPageFailuresInLogs(home, o.since);
  const pending = rs.scanPending(home, now).items;
  const queuedKeys = new Set(pending.map((p) => keyOf(p.jobTitle, p.location, p.keywords)));
  const queuedLoose = new Set(pending.map((p) => `${norm(p.jobTitle)}|${String(p.location).toUpperCase()}`));
  const quarantined = new Set();
  try {
    const qdir = path.join(home, 'pending-searches', '.quarantine');
    for (const f of fs.readdirSync(qdir).filter((n) => n.endsWith('.json') && !n.startsWith('.'))) {
      const d = parseJson(fs.readFileSync(path.join(qdir, f), 'utf8'));
      if (d) quarantined.add(`${norm(d.jobTitle)}|${String(d.location || '').toUpperCase()}`);
    }
  } catch { /* no quarantine folder */ }
  const running = new Set(rs.scanActiveRuns(home, now).map((r) => `${norm(r.jobTitle)}|${String(r.location).toUpperCase()}`));
  const held = heldRuns(home, now);

  const cats = { failed: [], skipped: [], reed_off: [], empty_with_log_failure: [] };
  const excluded = { notAskingForReed: 0, disabled: 0, queuedOrRunning: 0, heldByCvScreening: 0, ranToday: 0, noTerritoryRow: 0 };
  const consider = (k, t, cat, since) => {
    const loose = `${norm(t.job_title)}|${String(t.location).toUpperCase()}`;
    if (!t.enabled) { excluded.disabled++; return; }
    if (ranToday.has(k)) { excluded.ranToday++; return; }
    if (held.has(loose)) { excluded.heldByCvScreening++; return; }
    if (queuedKeys.has(k) || queuedLoose.has(loose) || quarantined.has(loose) || running.has(loose)) { excluded.queuedOrRunning++; return; }
    cats[cat].push({ key: k, category: cat, code: String(t.location).toUpperCase(), since, territory: t });
  };
  const listedKeys = new Set();
  for (const [k, run] of latest) {
    const t = terrByKey.get(k);
    if (!t) { excluded.noTerritoryRow++; continue; }
    const wantsReed = t.sources === 'both' || t.sources === 'reed';
    const logDays = logs.get(keyOf(run.job_title, run.location, ''));
    const cat = classify(run, wantsReed, logDays);
    if (!cat) { if (!wantsReed && classify(run, true, logDays)) excluded.notAskingForReed++; continue; }
    listedKeys.add(k);
    consider(k, t, cat, run.completed_at || run.date);
  }
  // An open Reed-pending mark of the territory map (R4) also counts when the latest run did not classify as a loss: its statistics row is gone,
  // or the latest run was halted or hit the daily view limit (those runs neither set nor clear the mark, so the Reed half is still owed).
  for (const [k, t] of terrByKey) {
    if (listedKeys.has(k) || !t.reed_pending_since || String(t.reed_pending_since) < o.since) continue;
    if (t.sources === 'both' || t.sources === 'reed') consider(k, t, 'failed', String(t.reed_pending_since));
  }
  const order = ['failed', 'skipped', 'reed_off', 'empty_with_log_failure'];
  const list = order.flatMap((c) => cats[c]).sort((a, b) => (order.indexOf(a.category) - order.indexOf(b.category)) || String(a.since).localeCompare(String(b.since)));
  const byDay = [...reedByDay.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([date, v]) => ({ date, attempts: v.attempts, failed: v.failed, failedPercent: Math.round(v.failed / v.attempts * 1000) / 10 }));
  return { today, cats, list, excluded, usage, latestRuns: latest.size, reedByDay: byDay };
}

// ---------------------------------------------------------------- the ledger (per UTC day, for --per-day and idempotency)

function readLedger(home) {
  const f = path.join(home, 'runtime', 'reed-catchup.json');
  const j = parseJson((() => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } })());
  return j && j.days && typeof j.days === 'object' ? j : { days: {} };
}

function writeLedger(home, ledger, today) {
  const keep = addDays(today, -LEDGER_KEEP_DAYS);
  for (const d of Object.keys(ledger.days)) if (d < keep) delete ledger.days[d];
  const dir = path.join(home, 'runtime');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'reed-catchup.json');
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o664 });
  fs.renameSync(tmp, f);
}

// ---------------------------------------------------------------- the plan and the writes

function planQueue(a, o, ledger) {
  const doneToday = (ledger.days[a.today] || []).length;
  const limit = a.usage ? (Number(a.usage.daily_limit) || DEFAULT_REED_LIMIT) : DEFAULT_REED_LIMIT;
  const used = a.usage ? Number(a.usage.profile_views) || 0 : 0;
  const remaining = Math.max(0, limit - used);
  const byBudget = Math.max(0, Math.floor(remaining / CV_RESERVE) - doneToday);
  const byDay = Math.max(0, o.perDay - doneToday);
  const already = new Set(ledger.days[a.today] || []);
  const fresh = a.list.filter((x) => !already.has(x.key));
  const take = Math.min(o.queue, byDay, byBudget, fresh.length);
  let reason = null;
  if (take < o.queue) {
    if (take === byBudget && byBudget < Math.min(byDay, fresh.length)) reason = remaining === 0 ? "Reed's daily view budget is used up" : 'not enough of the Reed daily view budget left';
    else if (take === byDay && byDay < fresh.length) reason = 'per-day limit reached';
    else reason = 'fewer catch-up territories than asked';
  }
  return { take, chosen: fresh.slice(0, take), doneToday, byDay, byBudget, remaining, limit, used, reason };
}

function payloadFor(item, now) {
  const t = item.territory;
  return {
    jobTitle: t.job_title,
    location: t.location,
    keywords: t.keywords || '',
    priority: 'low',
    sources: 'both',
    distance: t.distance,
    activeWithin: t.active_within || '1 month',
    cvLimit: parseInt(t.cv_limit, 10) || 20,
    overrides: [],
    requestedAt: now.toISOString(),
    source: 'reed-catchup',
    catchupReason: item.category,
  };
}

const newName = (now) => `zz-reed-catchup-${now.getTime()}-${crypto.randomBytes(4).toString('hex')}.json`;

// Runs inside the pending-searches lock (see main): the analysis, the plan and the ledger are read under the same lock as the writes, so two
// catch-up processes started together cannot both queue the same territory.
function writeQueued(home, plan, now) {
  const dir = rs.jailPath(home, 'pending-searches');
  const ledger = readLedger(home);
  const day = utcDay(now);
  const written = [];
  for (const item of plan.chosen) {
    const name = rs.writeNewFileAtomic(dir, () => newName(now), `${JSON.stringify(payloadFor(item, now), null, 2)}\n`);
    written.push({ file: name, code: item.code, category: item.category });
    (ledger.days[day] = ledger.days[day] || []).push(item.key);
  }
  writeLedger(home, ledger, day);
  return written;
}

// Reed must be on and not held for a queued catch-up to do any good: with Reed off the run would redo the Caterer half and skip Reed again.
// -> null (go ahead) | a sentence. Tests inject io.env (then only RESOURCER_SOURCES is read); a real run also honours the auth hold.
function reedNotAvailable(io) {
  let raw;
  if (io && io.env) raw = io.env.RESOURCER_SOURCES;
  else {
    try { raw = require('../resourcer/scripts/lib/env').get('RESOURCER_SOURCES'); } catch { return null; } // no install to ask: do not block
  }
  const v = String(raw === undefined ? 'caterer' : raw).trim().toLowerCase();
  if (v !== 'reed' && v !== 'both') return `Reed is switched off (RESOURCER_SOURCES is ${v || 'empty'}): a catch-up run would redo the Caterer half and skip Reed again`;
  if (!(io && io.env)) {
    try {
      const hold = require('../resourcer/scripts/reed-api-client').authHold();
      if (hold) return `Reed is on hold (${hold.reason}): wait until the login problem is fixed`;
    } catch { /* cannot tell: do not block */ }
  }
  return null;
}

// ---------------------------------------------------------------- output

const codesOf = (items) => {
  const codes = [...new Set(items.map((x) => x.code))];
  return codes.length > SHOW_CODES ? `${codes.slice(0, SHOW_CODES).join(' ')} +${codes.length - SHOW_CODES} more` : codes.join(' ');
};

function summary(a, o, plan, written) {
  return {
    since: o.since, today: a.today, mode: o.queue > 0 && !o.dryRun ? 'queue' : 'dry-run', territories: a.list.length,
    categories: Object.fromEntries(Object.entries(a.cats).map(([k, v]) => [k, { count: v.length, codes: [...new Set(v.map((x) => x.code))] }])),
    excluded: a.excluded,
    reedByDay: a.reedByDay,
    reedBudget: a.usage ? { used: Number(a.usage.profile_views) || 0, limit: Number(a.usage.daily_limit) || DEFAULT_REED_LIMIT } : null,
    queue: plan ? {
      asked: o.queue, perDay: o.perDay, queuedToday: plan.doneToday, allowedByBudget: plan.byBudget, wouldQueue: plan.take, reason: plan.reason,
      codes: plan.chosen.map((x) => x.code), written: written ? written.map((w) => ({ file: w.file, code: w.code })) : null,
    } : null,
  };
}

function render(s) {
  const L = [];
  L.push(`reed-catchup ${s.mode === 'queue' ? '' : '(dry run) '}since ${s.since}, today ${s.today} (UTC)`);
  L.push(`territories whose latest finished run did not get a successful Reed half: ${s.territories}`);
  const label = { failed: 'failed (Reed failed or auth failed)', skipped: 'skipped (Reed did not run)', reed_off: 'reed_off (recorded while Reed was off)', empty_with_log_failure: 'empty_with_log_failure (pool 0, errors 0, first-page failure in the log)' };
  for (const [k, v] of Object.entries(s.categories)) L.push(`  ${label[k]}: ${v.count}${v.count ? `   ${codesOf(v.codes.map((c) => ({ code: c })))}` : ''}`);
  const e = s.excluded;
  L.push(`left out: already queued or running ${e.queuedOrRunning}, held by CV screening ${e.heldByCvScreening}, ran today ${e.ranToday}, disabled ${e.disabled}, territory asks for Caterer only ${e.notAskingForReed}, no territory row ${e.noTerritoryRow}`);
  if (s.reedByDay && s.reedByDay.length) L.push(`Reed attempts by run day (a run that asked for Reed and did not stop before it): ${s.reedByDay.slice(-7).map((d) => `${d.date} ${d.attempts} attempts, ${d.failed} failed (${d.failedPercent}%)`).join('; ')}`);
  L.push(s.reedBudget ? `Reed views today: ${s.reedBudget.used} of ${s.reedBudget.limit}` : 'Reed views today: none recorded');
  if (s.queue) {
    const q = s.queue;
    L.push(`--queue ${q.asked}: per-day limit ${q.perDay} (${q.queuedToday} already today), view budget allows ${q.allowedByBudget} more: ${s.mode === 'queue' ? 'queued' : 'would queue'} ${q.wouldQueue}${q.codes.length ? `   ${q.codes.join(' ')}` : ''}${q.reason ? `   [${q.reason}]` : ''}`);
    if (q.written) for (const w of q.written) L.push(`  + ${w.file} (${w.code})`);
  } else if (s.territories) {
    L.push('nothing was written. To queue some: node tools/reed-catchup.js --queue N (N at most the per-day limit)');
  }
  return L.join('\n');
}

async function main(argv, io) {
  const out = (io && io.out) || ((s) => process.stdout.write(`${s}\n`));
  const err = (io && io.err) || ((s) => process.stderr.write(`${s}\n`));
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) { err(`ERROR: ${e.message}`); err(USAGE); return 2; }
    throw e;
  }
  if (o.help) { out(USAGE); return 0; }
  const home = o.home ? path.resolve(o.home) : rs.resolveHome((io && io.env) || process.env);
  const now = (io && io.now) || new Date();
  try {
    let a;
    let plan = null;
    let written = null;
    let refused = null;
    if (o.queue > 0 && !o.dryRun) {
      refused = reedNotAvailable(io);
      if (refused) {
        a = analyse(home, o, now);
        plan = { ...planQueue(a, o, readLedger(home)), take: 0, chosen: [], reason: refused };
      } else {
        let stage = 'lock'; // a pending folder that cannot be locked or written is exit 4, like a failed write
        const logs = firstPageFailuresInLogs(home, o.since); // read before the lock: it can take a while
        try {
          await rs.withDirLock(rs.jailPath(home, 'pending-searches'), async () => {
            stage = 'analyse';
            a = analyse(home, o, now, logs);
            plan = planQueue(a, o, readLedger(home));
            if (plan.take > 0) { stage = 'write'; written = writeQueued(home, plan, now); }
          });
        } catch (e) {
          if (stage === 'write' || stage === 'lock' || e.code === 'LOCK_BUSY') { err(`ERROR: could not write the pending searches: ${e.message}`); return 4; }
          throw e;
        }
      }
    } else {
      a = analyse(home, o, now);
      if (o.queue > 0) plan = planQueue(a, o, readLedger(home));
    }
    const s = summary(a, o, plan, written);
    out(o.json ? JSON.stringify(s) : render(s));
    if (refused) { err(`NOT QUEUED: ${refused}`); return 3; }
    return 0;
  } catch (e) {
    err(`ERROR: ${e && e.message ? e.message : e}`);
    return 1;
  }
}

module.exports = { main, parseArgs, analyse, classify, planQueue, heldRuns, firstPageFailuresInLogs, keyOf, DEFAULT_SINCE, DEFAULT_PER_DAY, CV_RESERVE, USAGE };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`ERROR: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
  });
}
