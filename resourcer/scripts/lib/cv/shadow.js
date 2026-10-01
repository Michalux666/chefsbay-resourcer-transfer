'use strict';
// The CV shadow log: one JSON line per screened CV in shadow/cv-YYYY-MM-DD.jsonl (Europe/London date), the same conventions as
// the snippet screening log (shadow/screening-*.jsonl): private files (mode 0600), best effort (logging never affects a
// decision), deleted after retentionDays (180 by default). A row is AGGREGATE ONLY: role counts, months, the level of the
// searched role, the lane, the forced marker and confidence, the reason codes, the decision and Jev's numeric answers (with the
// month numbers of the roles, so the gate can be re-run offline under another operating point). It never holds a CV, a redacted CV, a job
// title of the candidate, an employer, a duty, a name, a contact detail or a reason sentence. The platform candidate id (a
// pseudonymous number, as in the screening log) is kept when the caller gives one so a recruiter can ask why a candidate was
// rejected; treat the file with the same access rules as candidates.db.

const fs = require('fs');
const path = require('path');
const paths = require('../paths');
const fsx = require('../fsx');
const time = require('../time');

const NAME_RE = /^cv-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY = 86400000;
const MARKER = '.last-prune-cv';

function fileFor(dir, date) {
  return path.join(dir, `cv-${time.londonParts(date || new Date()).ymd}.jsonl`);
}

class CvShadowLog {
  /** @param {{dir?:string, enabled?:boolean, now?:()=>Date}} [opts] */
  constructor(opts) {
    const o = opts || {};
    this.dir = o.dir || paths.SHADOW;
    this.enabled = o.enabled !== false;
    this.now = o.now || (() => new Date());
    this.failures = 0;
  }

  append(row) {
    if (!this.enabled) return false;
    try {
      fsx.ensureDir(this.dir, 0o700);
      fs.appendFileSync(fileFor(this.dir, this.now()), JSON.stringify(row) + '\n', { mode: 0o600 });
      return true;
    } catch (e) {
      this.failures++;
      return false;
    }
  }
}

/**
 * The row of one decision. Only numbers, fixed codes and the searched role are copied from the result.
 * @param {object} result  the result of screenCv
 * @param {{mode?:string, runId?:string, source?:string, candidateId?:string|number, jobTitle:string, now?:Date, storeAnswers?:boolean, inputKind?:string}} c
 */
function buildRow(result, c) {
  const row = {
    v: 1,
    ts: (c.now || new Date()).toISOString(),
    mode: c.mode || 'cli',
    runId: c.runId || null,
    source: c.source || null,
    candidateId: c.candidateId === undefined || c.candidateId === null || c.candidateId === '' ? null : String(c.candidateId).slice(0, 24),
    jobTitle: String(c.jobTitle || '').slice(0, 100),
    searchLevel: result.searchLevel,
    levelP: result.levelP,
    decision: result.decision,
    final: result.final,
    lane: result.lane,
    forced: !!result.forced,
    confidence: result.confidence === undefined ? null : result.confidence,
    pReject: result.pReject === undefined ? null : result.pReject,
    tau: result.tau === undefined ? null : result.tau,
    jevDecision: result.jevDecision || null,
    reasonCodes: result.reasonCodes,
    finalReasonCodes: result.finalReasonCodes,
    policy: result.policy,
    roles: result.roles,
    months: result.months,
    evidence: result.evidence,
    model: result.model,
    cached: !!result.cached,
    jevCalls: result.jevCalls,
    input: c.inputKind || result.inputKind || null,
    cfg: result.cfgSig,
    qv: result.qv,
  };
  if (c.storeAnswers !== false && result.answers) {
    row.answers = result.answers;
    if (result.dates) row.dates = result.dates;
  }
  return row;
}

// The row of one QUEUE whose shadow screening was cut short (phase2.shadowMaxSeconds or consecutive failures): how many CVs of it were screened
// and how many were skipped. Numbers and a fixed word only. It carries kind 'queue-stop', so readRows() (the decisions) never returns it and
// cv-report.js reads it with readQueueStops() to show the share of CVs the time cap left unscreened (an unscreened share, so the switch-on
// sample bias is visible).
function buildQueueStopRow(c) {
  return {
    v: 1,
    kind: 'queue-stop',
    ts: (c.now || new Date()).toISOString(),
    mode: c.mode || 'shadow',
    runId: c.runId || null,
    stoppedBy: c.stoppedBy === 'time' ? 'time' : 'failures',
    screened: Math.max(0, Math.round(Number(c.screened) || 0)),
    skipped: Math.max(0, Math.round(Number(c.skipped) || 0)),
  };
}

// Delete daily files older than `days`. Returns the names removed.
function pruneShadow(opts) {
  const o = opts || {};
  const dir = o.dir || paths.SHADOW;
  const days = o.days || 180;
  const now = o.now ? o.now() : new Date();
  const cutoff = time.londonParts(new Date(now.getTime() - days * DAY)).ymd;
  const deleted = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return { deleted, kept: 0 }; }
  let kept = 0;
  for (const n of names) {
    const m = NAME_RE.exec(n);
    if (!m) continue;
    if (m[1] < cutoff) {
      try { fs.unlinkSync(path.join(dir, n)); deleted.push(n); } catch (e) { kept++; }
    } else kept++;
  }
  return { deleted, kept };
}

// Prune at most once a day (marker file), so every CLI start can call it cheaply.
function maybePrune(opts) {
  const o = opts || {};
  const dir = o.dir || paths.SHADOW;
  const now = o.now ? o.now() : new Date();
  const marker = path.join(dir, MARKER);
  try {
    const last = Date.parse(fs.readFileSync(marker, 'utf8'));
    if (Number.isFinite(last) && now.getTime() - last < DAY) return null;
  } catch (e) { /* no marker yet */ }
  try { fs.statSync(dir); } catch (e) { return null; }
  const res = pruneShadow({ dir, days: o.days, now: () => now });
  try { fs.writeFileSync(marker, now.toISOString(), { mode: 0o600 }); } catch (e) { /* best effort */ }
  return res;
}

// Rows for a report; a bad line is skipped. Decision rows only: a queue-stop row (kind) is read by readQueueStops().
function readRows(opts) {
  return readAll(opts).filter(r => !r.kind);
}

/** The queue-stop rows (see buildQueueStopRow). */
function readQueueStops(opts) {
  return readAll(opts).filter(r => r.kind === 'queue-stop');
}

function readAll(opts) {
  const o = opts || {};
  const dir = o.dir || paths.SHADOW;
  const rows = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => NAME_RE.test(n)).sort(); } catch (e) { return rows; }
  for (const n of names) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, n), 'utf8'); } catch (e) { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { const r = JSON.parse(line); if (r && typeof r === 'object') rows.push(r); } catch (e) { /* skip */ }
    }
  }
  return rows;
}

module.exports = { CvShadowLog, buildRow, buildQueueStopRow, pruneShadow, maybePrune, readRows, readQueueStops, fileFor, NAME_RE };
