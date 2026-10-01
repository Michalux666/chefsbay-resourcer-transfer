#!/usr/bin/env node
'use strict';
/**
 * rescreen-policy-rejects.js - give the candidates that Update A's review policy rejected only because Jev was UNCERTAIN a second look under the
 * forced-choice criteria, a few territories a day.
 *
 * Why (docs/RESCREEN.md): until the release was installed (2026-10-01) the instance ran Update A. Before the unlock a card Jev was not decisive about went to
 * the review policy (SCREEN_REVIEW_PRE=reject) and was REJECTED: a row in candidate_rejections (origin pipeline) that makes phase 1 skip that candidate for
 * that job title from then on. The new criteria decide at least 99 percent of the cards (in doubt approve), so many of those rejections would now be
 * approvals. This tool finds them, clears exactly those rejection rows and queues the territories again, so the next runs screen the candidates afresh.
 *
 * What is selected (exact predicate, both engine shapes, docs/RESCREEN.md section 3): the intersection of
 *   (a) a shadow row (shadow/screening-*.jsonl; the Update A shape and the current one are read by the same classifier) of stage pre_unlock decided by the
 *       review policy (used.engine policy, reasonCode sys_review_policy_reject) because Jev was uncertain (policy.why review: Jev answered, lane review, a
 *       review reason that is neither an instruction to the reader nor an unusable answer). An injection flag, an empty card, an unusable answer, a rejection
 *       Jev made itself and every post_unlock row are never selected.
 *   (b) a candidate_rejections row that still exists for that id and job title with origin exactly "pipeline", dated inside the window.
 * and then, per candidate, minus: unlocked or in Zoho; a newer Jev decision for the same card; a rejection that another row (a CV rejection, the '*' sentinel,
 * a duplicate) would still keep blocking; and minus the ONCE-ONLY GUARD (cleared_before): a candidate and job title that any ledger of an apply that took
 * effect and was not undone already cleared is never cleared again, whatever the tables or the shadow log say now (see coverage()). Every exclusion is counted by reason.
 *
 * Reed (docs/RESCREEN.md section 6): phase 1 of Reed does not read candidate_rejections at all. It skips a candidate that has a row in candidates (any row,
 * any title; a screened and rejected card is booked as "seen" there). Clearing a Reed candidate therefore means deleting its seen-only candidates row
 * (reed_id, unlocked 0, no Zoho id). That is the one place where this tool touches the candidates table, so it is OFF unless --reed-seen is given.
 *
 * Output: counts, dates and territory (job title and outward postcode) only. Never a name, an e-mail, a phone number, a CV or snippet text.
 *
 * Modes (dry run by default: nothing is written):
 *   (none)                    count what --apply would delete, by source, day and territory, and every exclusion by reason
 *   --apply --confirm N       refuses (exit 3, nothing written) unless N equals the dry-run row count exactly, no run is in flight, no screening halt is set,
 *                             the count is within --max-rows, every earlier ledger can be read in full (the once-only guard) and a backup of candidates.db was
 *                             written and verified FIRST; then, in ONE transaction, writes the ledger (runtime/rescreen-ledger-<UTC stamp>.jsonl, mode 0600) and
 *                             deletes exactly the selected rows; after the commit it records the apply (runtime/rescreen-applied-<stamp>.json, mode 0600)
 *   --undo <ledger>           puts exactly the rows of a ledger back (idempotent; refuses a row that exists with different content) and records the undo
 *                             (runtime/rescreen-undone-<stamp>.json): the once-only guard then releases the rows that were put back
 *   --queue                   writes pending-search files for the territories whose candidates were cleared (from the ledgers), at most --per-day a UTC day
 *                             (territories at priority high or medium are left to their regular sweep: a queued run steps them down, a schedule change; the Caterer
 *                             credits and Reed views left bound the number)
 *
 * Exit codes: 0 ok, 1 unexpected error, 2 usage error, 3 refused (nothing written), 4 could not write.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rs = require('./request-search');
const catchup = require('./reed-catchup');

const DEFAULT_SINCE = '2026-09-30';
const DEFAULT_PER_DAY = 10; // a design default; the owner decides how many a day
const DEFAULT_MAX_ROWS = 400; // a design default
const CV_RESERVE = catchup.CV_RESERVE; // profile views one queued run may use (the default CV limit per run), as in tools/reed-catchup.js
const DEFAULT_REED_LIMIT = 300; // the fallback the scheduler uses when reed_daily_usage has no limit
const CREDIT_RESERVE = 200; // a design default: Caterer credits --queue leaves for the regular sweep; below it (known balance minus this, in runs of CV_RESERVE) nothing more is queued
const RAISED = ['high', 'medium']; // the tiers upsertTerritory steps DOWN when a run finds fewer than 5 new candidates (a re-screen run usually does)
const LEDGER_KEEP_DAYS = 14;
const SHADOW_FILE_CAP = 256 * 1024 * 1024;
const LEDGER_CAP = 32 * 1024 * 1024;
const SHOW_ROWS = 40;
const NAME_RE = /^screening-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const LEDGER_RE = /^rescreen-ledger-\d{8}T\d{6}Z(?:-\d+)?\.jsonl$/;
const SOURCES = ['caterer', 'reed'];

const USAGE = `Usage: node tools/rescreen-policy-rejects.js [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--apply --confirm N] [--queue [--per-day M]] [--undo <ledger>]
                                              [--max-rows K] [--reed-seen] [--ledger <file>] [--home DIR] [--json] [--dry-run]

Counts the pre-unlock rejections that the review policy made only because Jev was uncertain (they stopped the candidate being screened again for that job
title) and, on request, clears them and queues their territories again. Dry run by default: nothing is written; counts, dates and territories only.

  --since <date>      first UTC day to look at (default ${DEFAULT_SINCE})
  --until <date>      last UTC day to look at (default: now)
  --apply             delete the selected rows (needs --confirm N, a backup, an idle pipeline); writes runtime/rescreen-ledger-<stamp>.jsonl first
  --confirm <N>       the row count the dry run printed; --apply refuses unless it is exactly this
  --max-rows <K>      --apply refuses above K rows (default ${DEFAULT_MAX_ROWS}); narrow the window and apply in parts
  --reed-seen         also clear Reed candidates: deletes their seen-only candidates row (docs/RESCREEN.md section 6); without it Reed candidates are only counted
  --queue             write pending searches for the territories whose candidates a ledger shows as cleared (oldest first, priority low)
  --per-day <M>       never more than M queued territories per UTC day in total (default ${DEFAULT_PER_DAY})
  --ledger <file>     with --queue: use only this ledger (default: every ledger in runtime/)
  --undo <ledger>     restore exactly the rows of a ledger
  --home <dir>        workspace to use (default: RESOURCER_HOME, else the instance workspace, else ./resourcer)
  --dry-run           never write anything, whatever else is given
  --json              print the result as JSON (same content)
  --help              this text

Exit codes: 0 ok, 1 unexpected error, 2 usage error, 3 refused (nothing written), 4 could not write.`;

class UsageError extends Error {}
class Refusal extends Error {}
class WriteFailure extends Error {}

function parseArgs(argv) {
  const o = {
    since: DEFAULT_SINCE, until: null, apply: false, confirm: null, queue: false, perDay: DEFAULT_PER_DAY, maxRows: DEFAULT_MAX_ROWS, undo: null,
    home: null, json: false, dryRun: false, reedSeen: false, ledger: null, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`); return argv[++i]; };
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--json') o.json = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--apply') o.apply = true;
    else if (a === '--queue') o.queue = true;
    else if (a === '--reed-seen') o.reedSeen = true;
    else if (a === '--since') o.since = val();
    else if (a === '--until') o.until = val();
    else if (a === '--confirm') o.confirm = val();
    else if (a === '--per-day') o.perDay = val();
    else if (a === '--max-rows') o.maxRows = val();
    else if (a === '--undo') o.undo = val();
    else if (a === '--ledger') o.ledger = val();
    else if (a === '--home') o.home = val();
    else throw new UsageError(`unknown option ${a}`);
  }
  const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
  if (!isDay(o.since)) throw new UsageError('--since must be a date like 2026-09-30');
  if (o.until !== null && !isDay(o.until)) throw new UsageError('--until must be a date like 2026-10-01');
  if (o.until !== null && o.until < o.since) throw new UsageError('--until must not be before --since');
  for (const [k, flag] of [['confirm', '--confirm'], ['perDay', '--per-day'], ['maxRows', '--max-rows']]) {
    if (o[k] === null) continue;
    const n = typeof o[k] === 'number' ? o[k] : (/^\d{1,7}$/.test(String(o[k])) ? Number(o[k]) : NaN);
    if (!Number.isInteger(n) || n < 0) throw new UsageError(`${flag} must be a whole number of 0 or more`);
    o[k] = n;
  }
  if (o.confirm !== null && !o.apply) throw new UsageError('--confirm only goes with --apply');
  if (o.undo !== null && (o.apply || o.queue)) throw new UsageError('--undo cannot be combined with --apply or --queue');
  if (o.ledger !== null && !o.queue) throw new UsageError('--ledger only goes with --queue');
  return o;
}

function loadSqlite(home) {
  try { return require('better-sqlite3'); } catch { /* fall through to the resourcer install */ }
  return require(require.resolve('better-sqlite3', { paths: [path.join(__dirname, '..', 'resourcer'), home, process.cwd()] }));
}

const norm = (s) => String(s || '').trim().toLowerCase();
const normLoc = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
const utcDay = (d) => d.toISOString().slice(0, 10);
const londonDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return utcDay(d); };

function parseJson(text) {
  if (typeof text !== 'string' || !text) return null;
  try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

function readJsonFile(file, cap) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > cap) return null;
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return parseJson(raw);
  } catch { return null; }
}

// ---------------------------------------------------------------- the shadow rows

// Who decided a card, from ONE shadow row of either engine shape. Returns {kind, approved}:
//   jev                    used.engine jev (approve or reject: Jev decided, forced or not)
//   policy_uncertain       the review policy settled a card Jev answered but was not decisive about (Update A's review lane): the only kind that is selected, when rejected
//   policy_injection       the policy settled a card flagged as an instruction to the reader (a keyword hit or Jev's own flag)
//   policy_empty           the policy settled an empty card (Jev was not asked)
//   policy_invalid         the policy settled an unusable answer (after the unlock only)
//   policy_other           a policy row this classifier cannot place: never selected
//   system | other | none  an unusable answer left undecided, a rule / cache / language-model decision, no decision at all
// Update A wrote policy {why, side, reviewReason} and, for a keyword-flagged card, jev {status skipped, why injection}; the current engine wrote the same fields
// with jev {status ok, lane review, reviewReason INJECTION_FLAG} for an injection and cannot reach the review lane for an uncertain card (decide() forces a choice).
// A row without a policy block is placed from its jev block; anything inconsistent is policy_other, which is never touched.
function classifyRow(r) {
  const used = r && r.used && typeof r.used === 'object' ? r.used : null;
  if (!used) return { kind: 'none', approved: false };
  const approved = used.approved === true;
  if (used.engine === 'jev') return { kind: 'jev', approved };
  if (used.engine === 'system') return { kind: 'system', approved };
  if (used.engine !== 'policy') return { kind: 'other', approved };
  // a malformed row is never selected: the approval flag must be a boolean, the blocks plain objects, the flags arrays (the real engines write nothing else)
  const plain = (x) => x === undefined || x === null || (typeof x === 'object' && !Array.isArray(x));
  const flagsOk = (x) => x === undefined || x === null || Array.isArray(x);
  if (typeof used.approved !== 'boolean' || !plain(r.policy) || !plain(r.jev) || !flagsOk(r.flags) || !flagsOk(r.jev && r.jev.flags)) return { kind: 'policy_other', approved };
  const p = r.policy && typeof r.policy === 'object' ? r.policy : null;
  const j = r.jev && typeof r.jev === 'object' ? r.jev : null;
  let why = p && typeof p.why === 'string' ? p.why : null;
  if (!why && j) {
    if (j.status === 'skipped') why = j.why === 'injection' || j.why === 'no_content' ? j.why : null;
    else if (j.status === 'ok' && j.lane === 'review') why = j.reviewReason === 'INJECTION_FLAG' ? 'injection' : (j.reviewReason === 'ANSWER_UNUSABLE' ? 'invalid' : 'review');
  }
  let reason = { review: 'uncertain', injection: 'injection', no_content: 'empty', invalid: 'invalid' }[why] || 'other';
  if (reason === 'uncertain') {
    const reviewReasons = [p && p.reviewReason, j && j.reviewReason];
    const flags = [].concat(Array.isArray(r.flags) ? r.flags : [], j && Array.isArray(j.flags) ? j.flags : []);
    const consistent = j && j.status === 'ok' && j.lane === 'review'
      && !reviewReasons.some((x) => x === 'INJECTION_FLAG' || x === 'ANSWER_UNUSABLE')
      && !flags.some((f) => f === 'injection' || f === 'card_unreadable' || f === 'no_content')
      && (!approved ? used.reasonCode === 'sys_review_policy_reject' && !(p && p.side === 'approve') : used.reasonCode === 'sys_review_policy_approve');
    if (!consistent) reason = 'other';
  }
  return { kind: `policy_${reason}`, approved };
}

// One compact row: only the fields the selection needs. The redacted card text (`input`) and every other field are dropped on the spot and never kept.
function compactRow(r) {
  if (!r || typeof r !== 'object') return null;
  if (typeof r.runId === 'string' && r.runId.startsWith('install-canary')) return null; // invented install cards
  const t = Date.parse(r.ts);
  if (!Number.isFinite(t) || (r.stage !== 'pre_unlock' && r.stage !== 'post_unlock')) return null;
  const id = typeof r.candidateId === 'string' || typeof r.candidateId === 'number' ? String(r.candidateId) : '';
  const c = classifyRow(r);
  return {
    t, stage: r.stage, source: typeof r.source === 'string' ? r.source : '', title: typeof r.jobTitle === 'string' ? r.jobTitle : '', id,
    runId: typeof r.runId === 'string' ? r.runId.slice(0, 80) : null, kind: c.kind, approved: c.approved,
  };
}

function readShadow(home, o) {
  const res = { files: 0, rows: [], looseModeFiles: [], tooBig: 0, badLines: 0 };
  const dir = path.join(home, 'shadow');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => NAME_RE.test(n)).sort(); } catch { return res; }
  const from = addDays(o.since, -1); // the file name is the London day; a row of the first UTC day may sit in the previous one
  for (const name of names) {
    if (NAME_RE.exec(name)[1] < from) continue;
    const file = path.join(dir, name);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    if (st.size > SHADOW_FILE_CAP) { res.tooBig++; continue; }
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) res.looseModeFiles.push(name);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    res.files++;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { res.badLines++; continue; }
      const c = compactRow(r);
      if (c) res.rows.push(c);
    }
  }
  return res;
}

// ---------------------------------------------------------------- the analysis

const EXCLUSION_LABELS = {
  no_stored_rejection: 'no rejection stored for that job title (nothing blocks the candidate)',
  cv_rejection: 'blocked by a CV-screening rejection (origin cv:), never touched',
  other_origin: 'the stored rejection has another origin than pipeline, never touched',
  outside_window: 'the stored rejection is dated outside the window (or before the decision), never touched',
  still_blocked: 'another rejection row (the * sentinel, a duplicate) would still block the candidate',
  unlocked: 'unlocked or already in Zoho',
  newer_jev_decision: 'a newer shadow row shows Jev decided the card since',
  newer_other_decision: 'a newer shadow row shows another decision since (policy, rule, after the unlock)',
  bad_id: 'candidate id is not a platform number',
  unknown_source: 'the row names no known source',
  cleared_before: 'once-only guard: an apply of this tool (a ledger that was not undone) already cleared the candidate for this job title, so it has had its second look and is never cleared again for it, whatever the rejection or the shadow log say now',
  reed_not_blocked: 'Reed candidate has no seen row (nothing blocks it)',
  reed_row_not_plain: 'the candidates row of the Reed candidate is not a plain Reed seen row (it carries a Caterer id too), never touched',
};

const tableTools = (db) => {
  const have = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  const cols = (name) => new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name));
  return { have, cols };
};

function pickTerritory(terrs, title, location, keywords) {
  const list = terrs.filter((t) => norm(t.job_title) === norm(title) && normLoc(t.location) === normLoc(location));
  if (!list.length) return null;
  if (keywords !== null && keywords !== undefined) {
    const k = list.filter((t) => norm(t.keywords) === norm(keywords));
    if (k.length === 1) return k[0];
    if (k.length > 1) return k.sort((a, b) => b.distance - a.distance)[0];
  }
  return list.length === 1 ? list[0] : null;
}

function buildRunIndex(db, home, sinceDay) {
  let runs = [];
  try { runs = db.prepare('SELECT * FROM run_results WHERE date >= ?').all(addDays(sinceDay, -3)); } catch { runs = []; }
  return { runs, byKey: new Map(runs.map((r) => [r.run_key, r])), home };
}

// The run behind a shadow row: Caterer rows carry the run id phase1-<stamp> (the status file runs/phase1-<stamp>.json, and run_results under <stamp> or
// merged-queue-<stamp>); Reed rows carry no run id, so the run is the ONE run for that title, asking for Reed, whose time span holds the row.
function attribute(item, idx) {
  if (item.source === 'caterer') {
    if (!item.runId) return null;
    const stamp = item.runId.replace(/^phase1-/, '');
    if (!/^[0-9A-Za-z-]{4,60}$/.test(stamp)) return null;
    const run = idx.byKey.get(stamp) || idx.byKey.get(`merged-queue-${stamp}`);
    if (run) return { title: run.job_title, location: run.location, distance: run.distance, keywords: run.keywords || '', sources: run.sources };
    let sf = null;
    try { sf = readJsonFile(rs.jailPath(idx.home, 'runs', `phase1-${stamp}.json`), 512 * 1024); } catch { sf = null; }
    if (sf && sf.jobTitle && sf.location) return { title: sf.jobTitle, location: sf.location, distance: sf.distance, keywords: null, sources: sf.sources };
    return null;
  }
  const found = new Map();
  for (const r of idx.runs) {
    if (norm(r.job_title) !== norm(item.title) || !(r.sources === 'both' || r.sources === 'reed')) continue;
    const from = Date.parse(r.phase1_started_at || r.started_at || '');
    const to = Date.parse(r.completed_at || '');
    if (!Number.isFinite(from) || !Number.isFinite(to) || item.t < from || item.t > to) continue;
    found.set(`${norm(r.job_title)}|${normLoc(r.location)}|${norm(r.keywords)}`, { title: r.job_title, location: r.location, distance: r.distance, keywords: r.keywords || '', sources: r.sources });
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

// THE ONCE-ONLY GUARD (owner requirement 2026-10-01: only re-screen what the old fallback rejected, never in a loop; the same failed profiles are not screened
// again, only when they come up for a DIFFERENT role). Every (source, id, job title) that appears in ANY ledger of an apply that took effect and was not undone is
// covered for ever, whatever the tables or the shadow log say now: a person cleared, screened again and rejected again by Jev has a NEW rejection row for the same
// title (origin pipeline, a later date, possibly even the very same id and date), and the shadow row of that second look may be missing (shadow logging off, a pruned
// file, a decision served from the cache). Such a candidate is left out as cleared_before.
//   applied   = the marker runtime/rescreen-applied-<stamp>.json that a successful apply writes after its commit, OR (a kill between the commit and the marker) the
//               table state: a row of the ledger is gone or changed. A ledger without either (a rolled-back or killed apply) cleared nothing and covers nothing.
//   undone    = the marker runtime/rescreen-undone-<stamp>.json that a successful --undo writes after its commit. It releases the rows of that ledger that were put
//               back; a row the undo left alone because a newer rejection of the same candidate and title exists (a second look took place) stays covered.
//   fail safe = a ledger that cannot be read, has a damaged line, is shorter than the marker says or has lost its file (a marker without a ledger) is reported as a
//               problem: the dry run warns, --apply and --queue refuse (exit 3, nothing written). The lines of such a ledger that can be read still count.
// "the row is still there" means the SAME row (every column of the ledger line), not merely the same row id, so a re-used rowid cannot fool the table evidence.
const LEDGER_NAME_RE = /^rescreen-ledger-(\d{8}T\d{6}Z(?:-\d+)?)\.jsonl$/;
const MARKER_RE = /^rescreen-(applied|undone)-(\d{8}T\d{6}Z(?:-\d+)?)\.json$/;
const ledgerKey = (l) => {
  const id = l.table === 'candidates' || l.source === 'reed' ? l.row.reed_id : l.row.caterer_id;
  const title = typeof l.jobTitle === 'string' ? l.jobTitle : l.row.job_title;
  return id === null || id === undefined || !title ? null : `${l.source}|${id}|${title}`;
};

function readMarker(home, kind, stamp) {
  let raw;
  try { raw = fs.readFileSync(path.join(ledgerDir(home), `rescreen-${kind}-${stamp}.json`), 'utf8'); } catch (e) { return { state: e.code === 'ENOENT' ? 'none' : 'bad' }; }
  const j = parseJson(raw);
  return j && j.v === 1 && j.ledger === `rescreen-ledger-${stamp}.jsonl` ? { state: 'ok', data: j } : { state: 'bad' };
}

function writeMarker(home, kind, stamp, data) {
  const dir = ledgerDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const final = path.join(dir, `rescreen-${kind}-${stamp}.json`);
  const tmp = path.join(dir, `.rescreen-${kind}-${stamp}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, ledger: `rescreen-ledger-${stamp}.jsonl`, ...data })}\n`, { mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(tmp, final);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
    throw e;
  }
  try { fs.chmodSync(final, 0o600); } catch { /* best effort */ }
}

function coverage(db, home) {
  const out = { covered: new Set(), ledgers: 0, covering: 0, notApplied: 0, undone: 0, problems: [], warnings: [] };
  let names = [];
  try { names = fs.readdirSync(ledgerDir(home)); } catch (e) { if (e.code !== 'ENOENT') out.problems.push({ file: 'runtime', reason: 'the folder cannot be listed' }); }
  names.sort();
  const stamps = new Set();
  for (const name of names) {
    const m = LEDGER_NAME_RE.exec(name);
    if (!m) continue;
    const stamp = m[1];
    stamps.add(stamp);
    out.ledgers++;
    const rd = readLedgerLenient(path.join(ledgerDir(home), name));
    if (rd.error) out.problems.push({ file: name, reason: rd.error });
    if (rd.bad) out.problems.push({ file: name, reason: `${rd.bad} line(s) cannot be read` });
    const ap = readMarker(home, 'applied', stamp);
    if (ap.state === 'ok' && Number.isInteger(ap.data.rows) && rd.lines.length < ap.data.rows) out.problems.push({ file: name, reason: `holds ${rd.lines.length} readable lines but ${ap.data.rows} were written` });
    if (ap.state === 'bad') out.warnings.push(`${name}: its applied marker is damaged (the ledger is still treated as applied)`);
    const applied = ap.state !== 'none' || rd.lines.some((l) => !ledgerRowPresent(db, l));
    if (!applied) { out.notApplied++; continue; }
    const un = readMarker(home, 'undone', stamp);
    if (un.state === 'bad') out.warnings.push(`${name}: its undone marker is damaged (the ledger still counts as applied)`);
    const kept = un.state === 'ok' ? new Set(Array.isArray(un.data.keptRows) ? un.data.keptRows : []) : null;
    if (kept) out.undone++;
    out.covering++;
    for (const l of rd.lines) {
      if (kept && !kept.has(l.row.id)) continue; // released by the undo: the row was put back (or was never gone)
      const k = ledgerKey(l);
      if (k) out.covered.add(k);
    }
  }
  for (const name of names) {
    const m = MARKER_RE.exec(name);
    if (m && m[1] === 'applied' && !stamps.has(m[2])) out.problems.push({ file: `rescreen-ledger-${m[2]}.jsonl`, reason: 'the file is gone although the apply recorded it' });
  }
  return out;
}

// is the row of this ledger line still in its table, unchanged (an unreadable table counts as present: fail safe)
function ledgerRowPresent(db, l) {
  let ex;
  try { ex = db.prepare(`SELECT * FROM ${l.table} WHERE id = ?`).get(l.row.id); } catch { return true; }
  return !!ex && Object.keys(l.row).every((c) => ex[c] === l.row[c]);
}

// Pure read of the database (db may be the read-only handle of a dry run or the transaction handle of an apply): -> the plan.
function analyse(db, home, o, nowMs, shadow, opts) {
  const sinceMs = Date.parse(`${o.since}T00:00:00Z`);
  const untilMs = o.until ? Date.parse(`${o.until}T23:59:59.999Z`) : nowMs;
  const untilDay = o.until || utcDay(new Date(nowMs));
  const T = tableTools(db);
  const hasRej = T.have('candidate_rejections');
  if (!T.have('candidates')) throw new Error('no candidates table in candidates.db');
  const rejCols = hasRej ? T.cols('candidate_rejections') : new Set();
  const candCols = T.cols('candidates');
  const prep = (sql) => db.prepare(sql);
  const q = {
    rejCaterer: hasRej && rejCols.has('caterer_id') ? prep("SELECT * FROM candidate_rejections WHERE caterer_id = ? AND (job_title = ? OR job_title = '*')") : null,
    rejReed: hasRej && rejCols.has('reed_id') ? prep('SELECT * FROM candidate_rejections WHERE reed_id = ? AND job_title = ?') : null,
    candCaterer: candCols.has('caterer_id') ? prep('SELECT * FROM candidates WHERE caterer_id = ?') : null,
    candReed: candCols.has('reed_id') ? prep('SELECT * FROM candidates WHERE reed_id = ?') : null,
  };

  const guard = coverage(db, home);
  const kindCounts = {};
  let postUnlock = 0;
  const byId = new Map();
  const cands = new Map();
  for (const r of shadow.rows) {
    const k = `${r.source}|${r.id}`;
    if (!byId.has(k)) byId.set(k, []);
    byId.get(k).push(r);
    if (r.t < sinceMs || r.t > untilMs) continue;
    if (r.stage === 'post_unlock') { postUnlock++; continue; }
    const label = r.kind.startsWith('policy_') ? `${r.kind}_${r.approved ? 'approve' : 'reject'}` : r.kind;
    kindCounts[label] = (kindCounts[label] || 0) + 1;
    if (r.kind === 'policy_uncertain' && !r.approved) {
      const ck = `${r.source}|${r.id}|${r.title}`;
      const prev = cands.get(ck);
      if (!prev || r.t > prev.t) cands.set(ck, r);
    }
  }

  const excluded = {};
  const bump = (k) => { excluded[k] = (excluded[k] || 0) + 1; };
  const eligible = [];
  let reedHeldBack = 0;
  const ordered = [...cands.values()].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  for (const R of ordered) {
    if (!SOURCES.includes(R.source)) { bump('unknown_source'); continue; }
    if (!/^[1-9]\d{0,15}$/.test(R.id) || !R.title) { bump('bad_id'); continue; }
    const id = Number(R.id);
    if (guard.covered.has(`${R.source}|${id}|${R.title}`)) { bump('cleared_before'); continue; }
    const newer = (byId.get(`${R.source}|${R.id}`) || []).filter((x) => x.t > R.t
      && (x.title === R.title || (R.source === 'reed' && x.kind === 'jev' && x.approved)));
    if (newer.some((x) => x.kind === 'jev')) { bump('newer_jev_decision'); continue; }
    if (newer.some((x) => x.stage === 'post_unlock' || x.kind.startsWith('policy_') || x.kind === 'other')) { bump('newer_other_decision'); continue; }

    const deletions = [];
    if (R.source === 'caterer') {
      const cand = q.candCaterer ? q.candCaterer.get(id) : null;
      if (cand && (Number(cand.unlocked) > 0 || cand.zoho_id)) { bump('unlocked'); continue; }
      const rows = q.rejCaterer ? q.rejCaterer.all(id, R.title) : [];
      if (!rows.length) { bump('no_stored_rejection'); continue; }
      const decisionDay = utcDay(new Date(R.t));
      const mine = rows.filter((x) => x.job_title === R.title && x.origin === 'pipeline' && typeof x.rejected_at === 'string'
        && x.rejected_at >= o.since && x.rejected_at <= untilDay && x.rejected_at >= decisionDay);
      if (!mine.length) {
        const same = rows.filter((x) => x.job_title === R.title);
        if (same.some((x) => typeof x.origin === 'string' && x.origin.startsWith('cv:'))) bump('cv_rejection');
        else if (same.some((x) => x.origin === 'pipeline')) bump('outside_window');
        else if (same.length) bump('other_origin');
        else bump('still_blocked'); // only the * sentinel
        continue;
      }
      if (rows.length !== mine.length) { bump('still_blocked'); continue; }
      for (const row of mine) deletions.push({ table: 'candidate_rejections', kind: 'rejection', row });
    } else {
      const cand = q.candReed ? q.candReed.get(id) : null;
      if (!cand) { bump('reed_not_blocked'); continue; }
      if (Number(cand.unlocked) > 0 || cand.zoho_id) { bump('unlocked'); continue; }
      if (cand.source !== 'reed' || (cand.caterer_id !== null && cand.caterer_id !== undefined)) { bump('reed_row_not_plain'); continue; }
      const rejs = q.rejReed ? q.rejReed.all(id, R.title) : [];
      if (rejs.some((x) => typeof x.origin === 'string' && x.origin.startsWith('cv:'))) { bump('cv_rejection'); continue; }
      if (!o.reedSeen) { reedHeldBack++; continue; }
      deletions.push({ table: 'candidates', kind: 'reed_seen', row: cand });
    }
    eligible.push({ source: R.source, id, title: R.title, t: R.t, day: londonDay(new Date(R.t)), runId: R.runId, deletions, territory: null });
  }

  if (!opts || !opts.skipTerritory) {
    const idx = buildRunIndex(db, home, o.since);
    let terrs = [];
    try { terrs = db.prepare('SELECT * FROM territory_searches').all(); } catch { terrs = []; }
    for (const e of eligible) {
      const a = attribute(e, idx);
      const t = a ? pickTerritory(terrs, e.title, a.location, a.keywords) : null;
      e.territory = t ? { title: t.job_title, location: t.location, distance: t.distance, keywords: t.keywords || '', sources: t.sources || 'caterer' } : null;
      if (!t && a) e.territory = { title: e.title, location: a.location, distance: a.distance, keywords: a.keywords || '', sources: a.sources || 'caterer', unknown: true };
    }
  }

  const rows = eligible.flatMap((e) => e.deletions.map((d) => ({ ...d, cand: e })));
  const ledgerGuard = { ledgers: guard.ledgers, covering: guard.covering, notApplied: guard.notApplied, undone: guard.undone, covered: guard.covered.size, problems: guard.problems, warnings: guard.warnings };
  return { sinceMs, untilMs, untilDay, kindCounts, postUnlock, considered: cands.size, excluded, reedHeldBack, eligible, rows, ledgerGuard };
}

// the plan is the rows themselves: a row that changed in any column between the dry run and the transaction is a different plan
const rowKey = (d) => `${d.table}:${d.row.id}:${JSON.stringify(d.row)}`;

// ---------------------------------------------------------------- guards: a run in flight, a screening halt

function isBusy(home, now, io) {
  try {
    if (io && typeof io.busy === 'function') { const b = io.busy(); return !!(b && typeof b === 'object' ? b.busy : b); }
    return !!require('../resourcer/scripts/lib/tick').busyState({ home, now: now.getTime() }).busy;
  } catch { return true; } // cannot tell: fail safe (treated as a run in flight)
}

function haltOf(home) {
  const file = path.join(home, 'runtime', 'pipeline-halt.json');
  const h = readJsonFile(file, 64 * 1024);
  if (h) return h.halted ? h : null;
  return fs.existsSync(file) && fs.statSync(file).size > 0 ? { unreadable: true } : null; // a halt file that cannot be read is treated as a halt: fail safe
}

function guards(home, now, io) {
  const out = [];
  if (isBusy(home, now, io)) out.push('a pipeline run is in flight (pipeline-watchdog.js --status shows busy true): pause both jobs and wait until it is idle');
  const h = haltOf(home);
  if (h) out.push(h.unreadable ? 'runtime/pipeline-halt.json cannot be read: treated as a screening halt, tell the owner' : 'the screening halt is set (pipeline-watchdog.js --status shows a halt): wait until it clears itself');
  return out;
}

// A ledger the once-only guard cannot read in full: the apply and the queue refuse (the dry run only warns, see renderDry).
function ledgerRefusals(plan) {
  const p = plan && plan.ledgerGuard ? plan.ledgerGuard.problems : [];
  if (!p.length) return [];
  return [`the once-only guard cannot read ${p.map((x) => `${x.file} (${x.reason})`).join(', ')}: restore the file from your copy or tell the owner, do not move or delete it, a damaged ledger could let a candidate be re-screened a second time`];
}

// ---------------------------------------------------------------- backup (the existing code of scripts/backup-db.js)

async function backupAndVerify(home, db, countsOf, io) {
  let bk;
  try { bk = require('../resourcer/scripts/backup-db'); } catch (e) { throw new Refusal(`the backup code could not be loaded: ${String((e && e.message) || e).slice(0, 120)}`); }
  const ctx = bk.makeCtx(Object.assign({
    home, notify: () => {}, log: () => {}, sqlite: () => loadSqlite(home),
  }, (io && io.backup) || {}));
  let created;
  let info;
  try {
    // the backup name has a resolution of one second: never overwrite the backup a moment ago (an apply and an undo run back to back by a script)
    const newest = bk.listBackups(ctx)[0];
    if (newest && Math.abs(Date.now() - newest.date.getTime()) < 1500) await new Promise((r) => setTimeout(r, 1600));
    created = await bk.createBackup(ctx);
    info = await bk.verifyOrRestore(ctx, created.file, null, false);
  } catch (e) {
    throw new Refusal(`no verified backup could be made, nothing was changed: ${String((e && e.message) || e).slice(0, 160)}`);
  }
  if (io && io.hooks && typeof io.hooks.afterBackup === 'function') io.hooks.afterBackup();
  const live = countsOf();
  for (const [table, n] of Object.entries(live)) {
    if (info.tables[table] !== n) {
      throw new Refusal(`the backup holds ${info.tables[table]} rows of ${table} but the live database ${n}: the database changed while it was written, nothing was changed`);
    }
  }
  return { name: created.name, tables: info.tables };
}

const tableCounts = (db) => () => {
  const out = {};
  for (const t of ['candidate_rejections', 'candidates']) {
    try { out[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c; } catch { out[t] = undefined; }
  }
  return out;
};

// ---------------------------------------------------------------- the ledger

function ledgerDir(home) { return path.join(home, 'runtime'); }

function writeLedger(home, lines, now) {
  const dir = ledgerDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const text = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
  for (let n = 0; n < 50; n++) {
    const name = `rescreen-ledger-${stamp}${n ? `-${n}` : ''}.jsonl`;
    const final = path.join(dir, name);
    if (fs.existsSync(final)) continue;
    const tmp = path.join(dir, `.${name}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try { fs.linkSync(tmp, final); } catch (e) { if (e.code === 'EEXIST') continue; fs.renameSync(tmp, final); }
      try { fs.chmodSync(final, 0o600); } catch { /* best effort */ }
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* renamed or gone */ }
    }
    try { const dfd = fs.openSync(dir, 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch { /* directory fsync is best effort */ }
    return { name, file: final };
  }
  throw new WriteFailure('could not allocate a unique ledger name');
}

function ledgerLine(d, applyId, at) {
  const e = d.cand;
  return {
    v: 1, at: at.toISOString(), applyId, kind: d.kind, table: d.table, source: e.source, jobTitle: e.title,
    decisionAt: new Date(e.t).toISOString(), runId: e.runId, territory: e.territory ? { title: e.territory.title, location: e.territory.location, distance: e.territory.distance, keywords: e.territory.keywords, sources: e.territory.sources } : null,
    row: d.row,
  };
}

const isLedgerLine = (j) => !!j && typeof j === 'object' && ((j.table === 'candidate_rejections' && j.kind === 'rejection') || (j.table === 'candidates' && j.kind === 'reed_seen'))
  && j.v === 1 && !!j.row && typeof j.row === 'object' && Number.isInteger(j.row.id) && SOURCES.includes(j.source);

function readLedgerFile(file) {
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > LEDGER_CAP) throw new Refusal('the ledger is not a readable file of a sane size');
  const lines = [];
  let n = 0;
  for (const text of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!text) continue;
    n++;
    let j;
    try { j = JSON.parse(text); } catch { throw new Refusal(`ledger line ${n} is not JSON`); }
    if (!isLedgerLine(j)) throw new Refusal(`ledger line ${n} is not a line of this tool`);
    lines.push(j);
  }
  return lines;
}

// The reader of the once-only guard: it never throws and keeps every line it can prove (a damaged line or file is reported, see coverage()).
function readLedgerLenient(file) {
  const out = { lines: [], bad: 0, error: null };
  let text;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > LEDGER_CAP) { out.error = 'is not a readable file of a sane size'; return out; }
    text = fs.readFileSync(file, 'utf8');
  } catch { out.error = 'cannot be read'; return out; }
  for (const t of text.split('\n')) {
    if (!t) continue;
    let j = null;
    try { j = JSON.parse(t); } catch { j = null; }
    if (isLedgerLine(j)) out.lines.push(j); else out.bad++;
  }
  return out;
}

function listLedgers(home) {
  try { return fs.readdirSync(ledgerDir(home)).filter((n) => LEDGER_RE.test(n)).sort().map((n) => path.join(ledgerDir(home), n)); } catch { return []; }
}

// ---------------------------------------------------------------- apply

async function doApply(home, o, io, now, dry) {
  const Database = loadSqlite(home);
  const dbFile = path.join(home, 'candidates.db');
  const shadow = readShadow(home, o);
  const ro = new Database(dbFile, { readonly: true, fileMustExist: true, timeout: 5000 });
  let plan;
  try { plan = analyse(ro, home, o, now.getTime(), shadow); } finally { ro.close(); }
  const n = plan.rows.length;
  const refusals = [];
  if (o.confirm === null) refusals.push('--confirm N is required: N is the row count of the dry run');
  else if (o.confirm !== n) refusals.push(`--confirm ${o.confirm} does not equal the dry-run row count ${n}: run the dry run again and give its number`);
  if (n > o.maxRows) refusals.push(`${n} rows is more than --max-rows ${o.maxRows}: narrow the window with --since and --until and apply in parts, or raise --max-rows`);
  refusals.push(...ledgerRefusals(plan));
  refusals.push(...guards(home, now, io));
  const result = { plan, refusals, applied: false, rows: n, ledger: null, backup: null, deleted: 0, shadow, warnings: [] };
  if (dry || refusals.length) return result;
  if (n === 0) return result; // nothing to do: no backup, no ledger

  const roc = new Database(dbFile, { readonly: true, fileMustExist: true, timeout: 5000 });
  try { result.backup = await backupAndVerify(home, roc, tableCounts(roc), io); } catch (e) {
    if (e instanceof Refusal) { result.refusals = [e.message]; return result; }
    throw e;
  } finally { roc.close(); }

  const again = guards(home, now, io); // the backup took a while
  if (again.length) { result.refusals = again; return result; }

  const rw = new Database(dbFile, { fileMustExist: true, timeout: 10000 });
  const applyId = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  // prepared when a row of that table is to be deleted: a database without candidate_rejections (Reed only so far) must not fail here
  const sqlOf = {
    // the row itself (its id), of the right source (the id column of that source), that job title, origin pipeline, dated inside the window
    candidate_rejections: "DELETE FROM candidate_rejections WHERE id = ? AND caterer_id = ? AND job_title = ? AND origin = 'pipeline' AND rejected_at = ? AND rejected_at >= ? AND rejected_at <= ?",
    candidates: "DELETE FROM candidates WHERE id = ? AND reed_id = ? AND source = 'reed' AND (unlocked IS NULL OR unlocked = 0) AND zoho_id IS NULL",
  };
  const del = {};
  const deleter = (table) => del[table] || (del[table] = rw.prepare(sqlOf[table]));
  try {
    const tx = rw.transaction(() => {
      const check = analyse(rw, home, o, now.getTime(), shadow, { skipTerritory: true });
      const a = plan.rows.map(rowKey).sort();
      const b = check.rows.map(rowKey).sort();
      if (a.length !== b.length || a.some((k, i) => k !== b[i])) throw new Refusal('the database changed since the dry run, nothing was changed: run the dry run again');
      const led = writeLedger(home, plan.rows.map((d) => ledgerLine(d, applyId, now)), now); // the ledger FIRST: it lists what may be deleted
      result.ledger = led.name;
      let k = 0;
      for (const d of plan.rows) {
        const r = d.table === 'candidates' ? deleter('candidates').run(d.row.id, d.row.reed_id) : deleter('candidate_rejections').run(d.row.id, d.row.caterer_id, d.row.job_title, d.row.rejected_at, o.since, plan.untilDay);
        if (r.changes !== 1) throw new Refusal(`row ${d.table}:${d.row.id} could not be deleted exactly once, nothing was changed`);
        k++;
        if (io && io.hooks && typeof io.hooks.afterDelete === 'function') io.hooks.afterDelete(k, d);
      }
      return k;
    });
    result.deleted = tx.immediate();
    result.applied = true;
    // the marker of the once-only guard, after the commit: a kill before it is covered by the table evidence (coverage())
    try {
      writeMarker(home, 'applied', LEDGER_NAME_RE.exec(result.ledger)[1], { at: now.toISOString(), applyId, rows: plan.rows.length, candidates: plan.eligible.length });
    } catch (e) {
      result.warnings.push(`the applied marker of ${result.ledger} could not be written (${String((e && e.code) || e).slice(0, 40)}): the once-only guard falls back on the table state; tell the owner`);
    }
  } catch (e) {
    if (e instanceof Refusal) { result.refusals = [e.message]; return result; }
    throw new WriteFailure(`the transaction failed and was rolled back, nothing was deleted${result.ledger ? ` (ledger ${result.ledger} lists what may have been deleted; --undo restores it and is a no-op for rows that are still there)` : ''}: ${String((e && e.message) || e).slice(0, 160)}`);
  } finally {
    try { rw.close(); } catch { /* closed */ }
  }
  return result;
}

// ---------------------------------------------------------------- undo

async function doUndo(home, o, io, now, dry) {
  let file = o.undo;
  if (!path.isAbsolute(file) && !/[\\/]/.test(file)) file = path.join(ledgerDir(home), file);
  file = path.resolve(file);
  if (!LEDGER_RE.test(path.basename(file))) throw new Refusal('that is not a ledger of this tool (rescreen-ledger-<stamp>.jsonl)');
  if (!fs.existsSync(file)) throw new Refusal('the ledger file does not exist');
  const lines = readLedgerFile(file);
  const Database = loadSqlite(home);
  const dbFile = path.join(home, 'candidates.db');
  const refusals = guards(home, now, io);
  const result = { ledger: path.basename(file), lines: lines.length, restored: 0, present: 0, superseded: 0, conflicts: 0, refusals, backup: null, released: null, keptCovered: null };
  const stamp = LEDGER_NAME_RE.exec(result.ledger)[1];
  // the once-only guard is released only once the rows are back (written after the commit: a kill before it leaves the ledger covered, and --undo can be run again)
  const markUndone = (kept) => {
    result.keptCovered = kept.length;
    result.released = lines.length - kept.length;
    if (readMarker(home, 'undone', stamp).state === 'ok') return;
    try { writeMarker(home, 'undone', stamp, { at: now.toISOString(), lines: lines.length, restored: result.restored, keptRows: kept }); } catch (e) {
      throw new WriteFailure(`the rows were put back but the undone marker could not be written (${String((e && e.code) || e).slice(0, 40)}): the ledger still counts for the once-only guard; run the same --undo again`);
    }
  };
  const plan = (db) => {
    const cols = {};
    for (const t of ['candidate_rejections', 'candidates']) { try { cols[t] = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)); } catch { cols[t] = new Set(); } }
    const todo = [];
    let present = 0; let superseded = 0; let conflicts = 0;
    const keptRows = []; // rows left alone because a newer rejection exists: a second look took place, they stay covered by the once-only guard
    for (const l of lines) {
      const have = cols[l.table];
      if (!have.size || Object.keys(l.row).some((c) => !have.has(c))) throw new Refusal(`the table ${l.table} no longer has the columns of the ledger, nothing was changed`);
      const ex = db.prepare(`SELECT * FROM ${l.table} WHERE id = ?`).get(l.row.id);
      if (ex) {
        if (Object.keys(l.row).every((c) => ex[c] === l.row[c])) present++; else conflicts++;
        continue;
      }
      if (l.table === 'candidate_rejections') {
        const col = l.row.caterer_id !== null && l.row.caterer_id !== undefined ? 'caterer_id' : 'reed_id';
        if (db.prepare(`SELECT 1 FROM candidate_rejections WHERE ${col} = ? AND job_title = ?`).get(l.row[col], l.row.job_title)) { superseded++; keptRows.push(l.row.id); continue; }
      } else if (db.prepare('SELECT 1 FROM candidates WHERE reed_id = ?').get(l.row.reed_id)) { superseded++; keptRows.push(l.row.id); continue; }
      todo.push(l);
    }
    return { todo, present, superseded, conflicts, keptRows };
  };
  const ro = new Database(dbFile, { readonly: true, fileMustExist: true, timeout: 5000 });
  let p;
  try { p = plan(ro); } finally { ro.close(); }
  Object.assign(result, { present: p.present, superseded: p.superseded, conflicts: p.conflicts });
  if (p.conflicts) result.refusals = refusals.concat([`${p.conflicts} row(s) of the ledger exist with different content: nothing was changed`]);
  if (dry || result.refusals.length) { result.restored = 0; result.wouldRestore = p.todo.length; return result; }
  if (!p.todo.length) { markUndone(p.keptRows); return result; }

  const roc = new Database(dbFile, { readonly: true, fileMustExist: true, timeout: 5000 });
  try { result.backup = await backupAndVerify(home, roc, tableCounts(roc), io); } catch (e) {
    if (e instanceof Refusal) { result.refusals = [e.message]; return result; }
    throw e;
  } finally { roc.close(); }
  const again = guards(home, now, io);
  if (again.length) { result.refusals = again; return result; }

  const rw = new Database(dbFile, { fileMustExist: true, timeout: 10000 });
  let keptRows = null;
  try {
    const tx = rw.transaction(() => {
      const q = plan(rw);
      if (q.conflicts) throw new Refusal('the database changed since the check, nothing was changed');
      for (const l of q.todo) {
        const names = Object.keys(l.row);
        rw.prepare(`INSERT INTO ${l.table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`).run(...names.map((c) => l.row[c]));
      }
      return q;
    });
    const q = tx.immediate();
    result.restored = q.todo.length;
    result.superseded = q.superseded;
    result.present = q.present;
    keptRows = q.keptRows;
  } catch (e) {
    if (e instanceof Refusal) { result.refusals = [e.message]; return result; }
    throw new WriteFailure(`the transaction failed and was rolled back: ${String((e && e.message) || e).slice(0, 160)}`);
  } finally {
    try { rw.close(); } catch { /* closed */ }
  }
  markUndone(keptRows);
  return result;
}

// ---------------------------------------------------------------- queue

const QUEUE_LEDGER = 'rescreen-queue.json';

function readQueueLedger(home) {
  const j = readJsonFile(path.join(home, 'runtime', QUEUE_LEDGER), 4 * 1024 * 1024);
  return j && j.days && typeof j.days === 'object' ? j : { days: {} };
}

function writeQueueLedger(home, ledger, today) {
  const keep = addDays(today, -LEDGER_KEEP_DAYS);
  for (const d of Object.keys(ledger.days)) if (d < keep) delete ledger.days[d];
  const dir = path.join(home, 'runtime');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, QUEUE_LEDGER);
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o664 });
  fs.renameSync(tmp, f);
}

// Reed must be on and not held for a queued run of a territory that asks for Reed: with Reed off the run would redo the Caterer half, be recorded
// Caterer-only for a territory that asks for Reed (tools/reed-catchup.js would then list it as lost) and never serve the Reed candidates.
function reedNotAvailable(io) {
  let raw;
  if (io && io.env) raw = io.env.RESOURCER_SOURCES;
  else {
    try { raw = require('../resourcer/scripts/lib/env').get('RESOURCER_SOURCES'); } catch { return null; }
  }
  const v = String(raw === undefined ? 'caterer' : raw).trim().toLowerCase();
  if (v !== 'reed' && v !== 'both') return `Reed is switched off (RESOURCER_SOURCES is ${v || 'empty'})`;
  if (!(io && io.env)) {
    try {
      const hold = require('../resourcer/scripts/reed-api-client').authHold();
      if (hold) return `Reed is on hold (${hold.reason})`;
    } catch { /* cannot tell: do not block */ }
  }
  return null;
}

function analyseQueue(db, home, o, now, io) {
  const files = o.ledger ? [path.resolve(o.ledger)] : listLedgers(home);
  const groups = new Map();
  let linesTotal = 0;
  let linesCleared = 0;
  let unattributed = 0;
  for (const f of files) {
    if (!LEDGER_RE.test(path.basename(f))) throw new Refusal('--ledger is not a ledger of this tool (rescreen-ledger-<stamp>.jsonl)');
    let lines;
    try { lines = readLedgerFile(f); } catch (e) { throw new Refusal(`${path.basename(f)}: ${e instanceof Refusal ? e.message : 'the ledger could not be read'}`); }
    for (const l of lines) {
      linesTotal++;
      if (ledgerRowPresent(db, l)) continue; // not applied (or undone, or the crash case): this row did not clear anything
      linesCleared++;
      if (!l.territory || !l.territory.title || !l.territory.location) { unattributed++; continue; }
      const key = `${norm(l.territory.title)}|${normLoc(l.territory.location)}|${norm(l.territory.keywords)}`;
      const g = groups.get(key) || { key, title: l.territory.title, location: l.territory.location, keywords: l.territory.keywords || '', candidates: 0, oldest: Infinity, latestApply: 0 };
      g.candidates++;
      g.oldest = Math.min(g.oldest, Date.parse(l.decisionAt) || Infinity);
      g.latestApply = Math.max(g.latestApply, Date.parse(l.at) || 0);
      groups.set(key, g);
    }
  }
  let terrs = [];
  try { terrs = db.prepare('SELECT * FROM territory_searches').all(); } catch { terrs = []; }
  let runs = [];
  try { runs = db.prepare('SELECT job_title, location, keywords, completed_at FROM run_results WHERE completed_at IS NOT NULL').all(); } catch { runs = []; }
  const lastRun = new Map();
  for (const r of runs) {
    const k = `${norm(r.job_title)}|${normLoc(r.location)}`;
    const t = Date.parse(r.completed_at) || 0;
    if (t > (lastRun.get(k) || 0)) lastRun.set(k, t);
  }
  // the newest balance a finished run recorded (phase 2 writes it); unknown when no run recorded one
  let credits = null;
  try {
    const c = db.prepare('SELECT credits_remaining AS c FROM run_results WHERE credits_remaining IS NOT NULL AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1').get();
    if (c && Number.isFinite(Number(c.c))) credits = Number(c.c);
  } catch { credits = null; }
  let usage = null;
  try { usage = db.prepare('SELECT profile_views, daily_limit FROM reed_daily_usage WHERE date = ?').get(utcDay(now)) || null; } catch { usage = null; }
  const pending = rs.scanPending(home, now).items;
  const queued = new Set(pending.map((p) => `${norm(p.jobTitle)}|${normLoc(p.location)}`));
  try {
    const qdir = path.join(home, 'pending-searches', '.quarantine');
    for (const f of fs.readdirSync(qdir).filter((n) => n.endsWith('.json') && !n.startsWith('.'))) {
      const d = parseJson(fs.readFileSync(path.join(qdir, f), 'utf8'));
      if (d) queued.add(`${norm(d.jobTitle)}|${normLoc(d.location)}`);
    }
  } catch { /* no quarantine folder */ }
  const running = new Set(rs.scanActiveRuns(home, now).map((r) => `${norm(r.jobTitle)}|${normLoc(r.location)}`));
  const held = catchup.heldRuns(home, now);
  const reedOff = reedNotAvailable(io);
  const ledger = readQueueLedger(home);
  const today = utcDay(now);
  const doneToday = ledger.days[today] || [];
  const limit = usage ? (Number(usage.daily_limit) || DEFAULT_REED_LIMIT) : DEFAULT_REED_LIMIT;
  const used = usage ? Number(usage.profile_views) || 0 : 0;
  let reedRoom = Math.max(0, Math.floor(Math.max(0, limit - used) / CV_RESERVE));
  let slots = Math.max(0, o.perDay - doneToday.length);
  // each queued run that asks for Caterer may unlock up to CV_RESERVE candidates (one credit each): leave CREDIT_RESERVE for the regular sweep
  let creditRoom = credits === null ? Infinity : Math.max(0, Math.floor(Math.max(0, credits - CREDIT_RESERVE) / CV_RESERVE));

  const excluded = {};
  const bump = (k) => { excluded[k] = (excluded[k] || 0) + 1; };
  const chosen = [];
  const list = [...groups.values()].sort((a, b) => a.oldest - b.oldest || (a.key < b.key ? -1 : 1));
  for (const g of list) {
    const terr = pickTerritory(terrs, g.title, g.location, g.keywords);
    const loose = `${norm(g.title)}|${normLoc(g.location)}`;
    const asksReed = terr && (terr.sources === 'both' || terr.sources === 'reed');
    if (!terr) { bump('no_territory'); continue; }
    if (!terr.enabled) { bump('disabled'); continue; }
    // a queued run is an ordinary run: below 5 new candidates it steps a raised territory down one tier and re-bases its cadence (docs/KNOWN-LIMITS.md K-RSC3),
    // which is a change of the schedule this tool must never cause: a raised territory is left to its regular sweep, which screens the cleared candidates anyway
    if (RAISED.includes(norm(terr.priority))) { bump('above_low'); continue; }
    if ((lastRun.get(loose) || 0) > g.latestApply) { bump('ran_since_apply'); continue; }
    if (held.has(loose)) { bump('held_by_cv_screening'); continue; }
    if (queued.has(loose) || running.has(loose)) { bump('queued_or_running'); continue; }
    if (doneToday.includes(g.key)) { bump('queued_today'); continue; }
    if (asksReed && reedOff) { bump('reed_unavailable'); continue; }
    if (slots <= 0) { bump('per_day_limit'); continue; }
    if (asksReed && reedRoom <= 0) { bump('reed_budget'); continue; }
    const usesCaterer = terr.sources !== 'reed';
    if (usesCaterer && creditRoom <= 0) { bump('credits_floor'); continue; }
    slots--;
    if (asksReed) reedRoom--;
    if (usesCaterer) creditRoom--;
    chosen.push({ ...g, territory: terr });
  }
  return { files: files.length, linesTotal, linesCleared, unattributed, groups: list.length, excluded, chosen, perDay: o.perDay, doneToday: doneToday.length, reedOff, reedBudget: { used, limit }, credits: { known: credits, reserve: CREDIT_RESERVE } };
}

function queuePayload(g, now) {
  const t = g.territory;
  return {
    jobTitle: t.job_title,
    location: t.location,
    keywords: t.keywords || '',
    priority: 'low',
    sources: t.sources || 'caterer',
    distance: t.distance,
    activeWithin: t.active_within || '1 month',
    cvLimit: parseInt(t.cv_limit, 10) || 20,
    overrides: [],
    requestedAt: now.toISOString(),
    source: 'rescreen-policy-rejects',
    rescreenCleared: g.candidates,
  };
}

const queueName = (now) => `zz-rescreen-${now.getTime()}-${crypto.randomBytes(4).toString('hex')}.json`;

async function doQueue(home, o, io, now, dry) {
  const Database = loadSqlite(home);
  const dbFile = path.join(home, 'candidates.db');
  const run = () => {
    const db = new Database(dbFile, { readonly: true, fileMustExist: true, timeout: 5000 });
    try { return analyseQueue(db, home, o, now, io); } finally { db.close(); }
  };
  if (dry) return { plan: run(), written: null };
  let plan;
  let written = [];
  let stage = 'lock';
  try {
    await rs.withDirLock(rs.jailPath(home, 'pending-searches'), async () => {
      stage = 'analyse';
      plan = run();
      if (!plan.chosen.length) return;
      stage = 'write';
      const dir = rs.jailPath(home, 'pending-searches');
      const ledger = readQueueLedger(home);
      const today = utcDay(now);
      for (const g of plan.chosen) {
        // the day's slot is recorded BEFORE its file is written: a kill in between can only lose a slot (the territory is picked again on a later day), never exceed --per-day
        (ledger.days[today] = ledger.days[today] || []).push(g.key);
        writeQueueLedger(home, ledger, today);
        const name = rs.writeNewFileAtomic(dir, () => queueName(now), `${JSON.stringify(queuePayload(g, now), null, 2)}\n`);
        written.push({ file: name, location: g.location });
      }
    });
  } catch (e) {
    if (e instanceof Refusal) throw e;
    if (stage === 'write' || stage === 'lock' || e.code === 'LOCK_BUSY') throw new WriteFailure(`could not write the pending searches: ${e.message}`);
    throw e;
  }
  return { plan, written };
}

// ---------------------------------------------------------------- output

const plural = (n, w) => `${n} ${n === 1 ? w : (w.endsWith('y') ? `${w.slice(0, -1)}ies` : `${w}s`)}`;

function summarise(plan, shadow, o, now, readiness) {
  const bySource = {};
  const byDay = {};
  const terr = new Map();
  for (const e of plan.eligible) {
    const s = (bySource[e.source] = bySource[e.source] || { candidates: 0, rows: 0 });
    s.candidates++;
    s.rows += e.deletions.length;
    byDay[e.day] = (byDay[e.day] || 0) + 1;
    const label = e.territory ? `${e.territory.title} ${normLoc(e.territory.location)}` : 'unknown territory';
    terr.set(label, (terr.get(label) || 0) + 1);
  }
  return {
    window: { since: o.since, until: plan.untilDay }, now: now.toISOString(),
    shadow: { files: shadow.files, rows: shadow.rows.length, looseModeFiles: shadow.looseModeFiles, tooBig: shadow.tooBig, badLines: shadow.badLines },
    preUnlockByKind: plan.kindCounts, postUnlockRows: plan.postUnlock,
    policyUncertainRejects: plan.considered, excluded: plan.excluded, reedHeldBack: plan.reedHeldBack,
    eligible: { candidates: plan.eligible.length, rowsToDelete: plan.rows.length, bySource, byDay, byTerritory: [...terr.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([territory, candidates]) => ({ territory, candidates })) },
    ledgerGuard: plan.ledgerGuard,
    applyReadiness: readiness,
  };
}

function renderDry(s) {
  const L = [];
  L.push(`rescreen-policy-rejects (dry run) window ${s.window.since} to ${s.window.until} (UTC), now ${s.now}`);
  L.push(`shadow log: ${plural(s.shadow.files, 'file')}, ${s.shadow.rows} rows read (pre-unlock decisions in the window by who made them: ${Object.entries(s.preUnlockByKind).sort().map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}; after the unlock ${s.postUnlockRows}, never touched)`);
  if (s.shadow.looseModeFiles.length) L.push(`WARNING: ${plural(s.shadow.looseModeFiles.length, 'shadow file')} not mode 0600 (${s.shadow.looseModeFiles.join(' ')}): they hold personal data, fix the mode`);
  if (s.shadow.badLines) L.push(`WARNING: shadow log lines that could not be read and were skipped (a truncated file?): ${s.shadow.badLines}; the counts below may be too low`);
  if (s.shadow.tooBig) L.push(`WARNING: ${plural(s.shadow.tooBig, 'shadow file')} too large to read and skipped`);
  const g = s.ledgerGuard;
  L.push(`once-only guard: ${plural(g.ledgers, 'ledger')} in runtime/: ${g.covering} took effect (${g.undone} of them undone: only the rows put back are released), ${g.notApplied} never took effect; ${g.covered} candidate and job title pairs are never cleared again`);
  for (const p of g.problems) L.push(`WARNING: ledger ${p.file} ${p.reason}: the guard covers only what it can prove of it, and --apply and --queue refuse until it is restored (the owner decides; never delete or move a ledger)`);
  for (const w of g.warnings) L.push(`WARNING: ${w}`);
  L.push(`cards the review policy rejected before the unlock because Jev was uncertain (distinct candidate and job title): ${s.policyUncertainRejects}`);
  const ex = Object.entries(s.excluded).sort();
  L.push(`left out: ${ex.length ? ex.map(([k, n]) => `${k} ${n}`).join(', ') : 'nothing'}`);
  for (const [k] of ex) if (EXCLUSION_LABELS[k]) L.push(`  ${k}: ${EXCLUSION_LABELS[k]}`);
  if (s.reedHeldBack) L.push(`Reed candidates blocked only by a seen row, NOT counted (add --reed-seen to include them, docs/RESCREEN.md section 6): ${s.reedHeldBack}`);
  L.push(`re-screenable candidates: ${s.eligible.candidates}`);
  L.push(`rows that --apply would delete: ${s.eligible.rowsToDelete}   (--apply --confirm ${s.eligible.rowsToDelete})`);
  for (const [src, v] of Object.entries(s.eligible.bySource)) L.push(`  ${src}: ${v.candidates} candidates, ${v.rows} rows`);
  if (Object.keys(s.eligible.byDay).length) L.push(`  by day of the decision (London): ${Object.entries(s.eligible.byDay).sort().map(([d, n]) => `${d} ${n}`).join(', ')}`);
  const T = s.eligible.byTerritory;
  if (T.length) {
    L.push(`  by territory (${plural(T.length, 'territory')}):`);
    for (const t of T.slice(0, SHOW_ROWS)) L.push(`    ${t.territory}: ${t.candidates}`);
    if (T.length > SHOW_ROWS) L.push(`    +${T.length - SHOW_ROWS} more`);
  }
  const r = s.applyReadiness;
  L.push(r.refusals.length ? `--apply would be refused now: ${r.refusals.join('; ')}` : '--apply is possible now (idle pipeline, no halt, within --max-rows)');
  L.push('nothing was written. To apply: node tools/rescreen-policy-rejects.js --apply --confirm <the row count above> (docs/RESCREEN.md section 8)');
  return L.join('\n');
}

function renderApply(r, o) {
  const L = [];
  if (r.refusals.length) {
    L.push(`NOT APPLIED (nothing was written): ${r.refusals.join('; ')}`);
  } else if (!r.applied) {
    L.push('nothing to apply: no row matches (an earlier apply already took them), no backup or ledger was written');
  } else {
    L.push(`backup ${r.backup.name} written and verified: candidate_rejections ${r.backup.tables.candidate_rejections} rows${r.backup.tables.candidates !== undefined ? `, candidates ${r.backup.tables.candidates} rows` : ''}`);
    L.push(`ledger runtime/${r.ledger} written first (mode 0600)`);
    L.push(`deleted ${r.deleted} rows in one transaction (${r.plan.eligible.length} candidates)`);
    L.push(`undo: node tools/rescreen-policy-rejects.js --undo ${r.ledger}`);
    L.push(`next: node tools/rescreen-policy-rejects.js --queue --per-day ${o.perDay} (a few territories a day; docs/RESCREEN.md section 9)`);
    L.push('once-only guard: these candidates are never cleared again for these job titles, whatever Jev decides in the second look (docs/RESCREEN.md section 5)');
  }
  for (const w of r.warnings || []) L.push(`WARNING: ${w}`);
  return L.join('\n');
}

function renderUndo(r) {
  if (r.refusals.length) return `NOT UNDONE (nothing was written): ${r.refusals.join('; ')}`;
  const verb = r.wouldRestore !== undefined ? 'would restore' : 'restored';
  return `ledger ${r.ledger}: ${plural(r.lines, 'line')}; ${verb} ${r.wouldRestore !== undefined ? r.wouldRestore : r.restored}, already present ${r.present}, left alone because a newer row for the same candidate and job title exists ${r.superseded}${r.backup ? `; backup ${r.backup.name} verified first` : ''}${r.released !== null ? `; once-only guard released ${r.released} lines, ${r.keptCovered} stay covered (a second look took place)` : ''}`;
}

function renderQueue(p, written, o, dry) {
  const L = [];
  L.push(`queue (${dry ? 'dry run' : 'written'}): ${plural(p.files, 'ledger')}, ${p.linesCleared} cleared rows (${p.linesTotal - p.linesCleared} not cleared: not applied or undone), ${p.unattributed} without a territory, ${plural(p.groups, 'territory')}`);
  const ex = Object.entries(p.excluded).sort();
  L.push(`left out: ${ex.length ? ex.map(([k, n]) => `${k} ${n}`).join(', ') : 'nothing'}`);
  L.push(`per-day limit ${p.perDay} (${p.doneToday} already today); Reed views today ${p.reedBudget.used} of ${p.reedBudget.limit}${p.reedOff ? `; ${p.reedOff}: territories that ask for Reed are not queued` : ''}`);
  L.push(p.credits.known === null ? 'Caterer credits: no finished run recorded a balance, so the credits are NOT guarded (read the balance in the digest before queueing more than a few)' : `Caterer credits: ${p.credits.known} at the last finished run; ${CREDIT_RESERVE} are left for the regular sweep, then each queued territory reserves ${CV_RESERVE}`);
  L.push(`${written ? 'queued' : 'would queue'} ${p.chosen.length}: ${p.chosen.map((g) => `${g.title} ${normLoc(g.location)} (${g.candidates})`).join(', ') || 'none'}`);
  if (written) for (const w of written) L.push(`  + ${w.file} (${normLoc(w.location)})`);
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
  const emit = (obj, text) => out(o.json ? JSON.stringify(obj) : text);
  try {
    if (!fs.existsSync(path.join(home, 'candidates.db'))) throw new Error(`no candidates.db in ${home}`);
    if (o.undo !== null) {
      const r = await doUndo(home, o, io, now, o.dryRun);
      emit({ mode: o.dryRun ? 'undo-dry-run' : 'undo', ...r }, renderUndo(r));
      return r.refusals.length ? 3 : 0;
    }
    let code = 0;
    const result = { mode: 'dry-run' };
    const text = [];
    if (o.apply) {
      const r = await doApply(home, o, io, now, o.dryRun);
      result.mode = o.dryRun ? 'dry-run' : 'apply';
      if (!o.dryRun && r.shadow && r.shadow.looseModeFiles.length) err(`WARNING: ${plural(r.shadow.looseModeFiles.length, 'shadow file')} not mode 0600 (${r.shadow.looseModeFiles.join(' ')}): they hold personal data, fix the mode`);
      result.apply = { applied: r.applied, rows: r.rows, deleted: r.deleted, ledger: r.ledger, backup: r.backup, refusals: r.refusals, candidates: r.plan.eligible.length, warnings: r.warnings };
      text.push(o.dryRun ? renderDry(summarise(r.plan, readShadow(home, o), o, now, { refusals: r.refusals })) : renderApply(r, o));
      if (r.refusals.length) code = 3;
    } else if (!o.queue || o.dryRun) {
      const Database = loadSqlite(home);
      const shadow = readShadow(home, o);
      const db = new Database(path.join(home, 'candidates.db'), { readonly: true, fileMustExist: true, timeout: 5000 });
      let plan;
      try { plan = analyse(db, home, o, now.getTime(), shadow); } finally { db.close(); }
      const refusals = ledgerRefusals(plan).concat(guards(home, now, io));
      if (plan.rows.length > o.maxRows) refusals.unshift(`${plan.rows.length} rows is more than --max-rows ${o.maxRows}: narrow the window with --since and --until, or raise --max-rows`);
      const s = summarise(plan, shadow, o, now, { refusals });
      result.dryRun = s;
      if (!o.queue) text.push(renderDry(s));
    }
    if (o.queue && code === 0) {
      const q = await doQueue(home, o, io, now, o.dryRun);
      result.mode = o.apply ? result.mode : (o.dryRun ? 'queue-dry-run' : 'queue');
      result.queue = {
        ledgers: q.plan.files, clearedRows: q.plan.linesCleared, unattributed: q.plan.unattributed, territories: q.plan.groups, excluded: q.plan.excluded,
        perDay: q.plan.perDay, queuedToday: q.plan.doneToday, reedOff: q.plan.reedOff, reedBudget: q.plan.reedBudget, credits: q.plan.credits,
        chosen: q.plan.chosen.map((g) => ({ territory: `${g.title} ${normLoc(g.location)}`, candidates: g.candidates })), written: q.written ? q.written.map((w) => w.file) : null,
      };
      text.push(renderQueue(q.plan, q.written, o, o.dryRun));
    }
    out(o.json ? JSON.stringify(result) : text.join('\n'));
    return code;
  } catch (e) {
    if (e instanceof Refusal) { err(`NOT DONE (nothing was written): ${e.message}`); return 3; }
    if (e instanceof WriteFailure) { err(`ERROR: ${e.message}`); return 4; }
    err(`ERROR: ${e && e.message ? e.message : e}`);
    return 1;
  }
}

module.exports = {
  main, parseArgs, classifyRow, compactRow, readShadow, analyse, analyseQueue, doApply, doUndo, doQueue, writeLedger, readLedgerFile, readLedgerLenient, listLedgers, coverage, guards,
  DEFAULT_SINCE, DEFAULT_PER_DAY, DEFAULT_MAX_ROWS, CV_RESERVE, CREDIT_RESERVE, EXCLUSION_LABELS, USAGE,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`ERROR: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
  });
}
