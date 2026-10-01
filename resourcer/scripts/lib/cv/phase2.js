'use strict';
// The CV screening step of Phase 2 (scripts/process-approved-queue.js, "Step 4.6"): after a CV is downloaded and before
// anything goes to Zoho, every candidate that has a CV file is screened by scripts/cv-review.js (one child process each,
// at most cvScreenConcurrency at a time, so a hostile file can only ever hurt its own process).
//   CV_SCREEN=off     nothing runs: a strict no-op
//   CV_SCREEN=shadow  (the default) every CV is screened and logged, nothing is ever blocked and an outage is only a warning; after
//                     phase2.shadowStopAfterFailures CVs in a row that could not be screened, or once the screening of the queue has run
//                     phase2.shadowMaxSeconds (a gateway that answers, but slowly), the rest of the queue is skipped with one warning
//                     alert, so a hung or slow gateway cannot slow Phase 2 down
//   CV_SCREEN=on      pass, unreadable and the very rare fallback-lane CV (decision review, settled by config fallback.policy,
//                     approve by default) go on to Zoho as before; reject = not pushed, the CV and the candidate JSON are
//                     deleted (retention rule), a candidate_rejections row for this job title carries the reason 'cv:<codes>'
// An outage (exit 3 of the reviewer) in mode on stops the queue WITHOUT losing anything: nothing is pushed or rejected any
// further, every CV and queue entry stays for the retry, the screening halt is raised and a critical alert goes out. It is
// never turned into an approval. The halt this raises is cleared by supervision only when the CV route itself answers (the deep
// check of lib/screening-health.js asks a CV canary while the mode is on), and while it is up no Phase 1 unlock starts (unlockBlocked()).
// A broken or missing criteria file (config/cv-screening.json) is the same kind of fault: fail closed, never a decision (mode on holds,
// shadow stops the stage with one warning alert).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('../paths');
const fsx = require('../fsx');
const env = require('../env');
const { notify } = require('../notify');
const { mapPool } = require('../screening/pool');
const config = require('./config');
const gate = require('./gate');

const REVIEWER = path.resolve(__dirname, '..', '..', 'cv-review.js');
const HALT_REASON = 'AI screening unavailable';
const HALT_REMEDY = 'Check AI_GATEWAY_API_KEY in the profile .env, the credits, and that the Vercel team allows typesafe-ai/jev. CV screening resumes with the next Phase 2 run once the watchdog clears the halt; every CV of the held queue is kept.';
const DECISIONS = ['pass', 'reject', 'review', 'unreadable'];

let warnedMode = false;

/** 'off' | 'shadow' | 'on' from CV_SCREEN (unset is shadow; a typo is shadow too, with one warning line). */
function mode(value, log) {
  const m = config.screenMode(value);
  if (m.warning && !warnedMode) { warnedMode = true; (log || console.log)(`[Phase 2] WARN ${m.warning}`); }
  return m.mode;
}

function loadConfig() { return config.load(); }

const asList = v => (Array.isArray(v) ? v : [v]).filter(x => typeof x === 'string' && x.trim());

/** What the pipeline already knows about the candidate, so it can be removed from the CV before anything leaves the process. */
function knownFor(cand, profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const names = [];
  for (const n of asList([cand.name, cand.firstName, cand.lastName, p.First_Name, p.Last_Name, `${p.First_Name || ''} ${p.Last_Name || ''}`.trim()])) names.push(n);
  return {
    names: Array.from(new Set(names)),
    emails: asList([cand.email, p.Email]),
    phones: asList([cand.phone, p.Mobile, p.Phone]),
    postcodes: asList([cand.postcode, p.Zip_Code]),
  };
}

function readProfile(jsonPath) {
  if (!jsonPath) return null;
  return fsx.readJson(jsonPath, null);
}

// ---------------------------------------------------------------------------------------------
// candidate_rejections (the existing table; no schema change): one row per candidate and job title, origin = 'cv:<codes>'
// ---------------------------------------------------------------------------------------------

const reasonText = codes => `cv:${codes.join(',')}`.replace(/[^\x20-\x7e]/g, '?').slice(0, 200);

/** The first reason code that is not the 'forced' marker ('' when there is none); at most 60 characters. */
function primaryReasonCode(codes) {
  const first = (Array.isArray(codes) ? codes : []).find(c => typeof c === 'string' && c && c !== 'forced');
  return String(first || '').slice(0, 60);
}

function idColumn(cand) { return cand.source === 'reed' ? 'reed_id' : 'caterer_id'; }

function tableInfo(db) {
  try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='candidate_rejections'").get() ? new Set(db.prepare('PRAGMA table_info(candidate_rejections)').all().map(c => c.name)) : null; } catch (e) { return null; }
}

/** The earlier CV rejection of this candidate for this job title (a re-run must not download the CV again), or null. */
function findEarlierRejection(deps, cand, jobTitle) {
  try {
    const db = deps.candidateDb.getDb();
    const cols = tableInfo(db);
    if (!cols || !cols.has(idColumn(cand))) return null;
    const row = db.prepare(`SELECT origin FROM candidate_rejections WHERE ${idColumn(cand)} = ? AND job_title = ?`).get(Number(cand.id), String(jobTitle));
    return row && typeof row.origin === 'string' && row.origin.startsWith('cv:') ? { reason: row.origin } : null;
  } catch (e) {
    return null;
  }
}

/** Records the rejection; safe to repeat (an existing row for the candidate and job title is left as it is). */
function recordRejection(deps, cand, jobTitle, codes) {
  try {
    const db = deps.candidateDb.getDb();
    db.prepare(`CREATE TABLE IF NOT EXISTS candidate_rejections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caterer_id INTEGER, reed_id INTEGER,
      job_title TEXT NOT NULL, rejected_at TEXT NOT NULL, origin TEXT
    )`).run();
    const col = idColumn(cand);
    const prior = db.prepare(`SELECT origin FROM candidate_rejections WHERE ${col} = ? AND job_title = ?`).get(Number(cand.id), String(jobTitle));
    if (prior && typeof prior.origin === 'string' && (prior.origin.startsWith('resurface:') || prior.origin === 'reed:approved')) {
      // The claim row of a resurfaced candidate (written before the CV was fetched again, docs/RESURFACE.md), or the approval row of a Reed candidate for this
      // job title (reed:approved, docs/ROLESCOPE.md), becomes the CV rejection: one row per candidate and job title, and the row of the earlier role stays as it is.
      db.prepare(`UPDATE candidate_rejections SET origin = ?, rejected_at = ? WHERE ${col} = ? AND job_title = ?`)
        .run(reasonText(codes), new Date().toISOString().slice(0, 10), Number(cand.id), String(jobTitle));
      const cols0 = tableInfo(db);
      if (cols0 && cols0.has('reason_code')) {
        try { db.prepare(`UPDATE candidate_rejections SET reason_code = ? WHERE ${col} = ? AND job_title = ?`).run(primaryReasonCode(codes), Number(cand.id), String(jobTitle)); } catch (e) { /* optional column */ }
      }
      return { ok: true, existed: false, claimed: true };
    }
    if (prior) return { ok: true, existed: true };
    db.prepare(`INSERT INTO candidate_rejections (${col}, job_title, rejected_at, origin) VALUES (?, ?, ?, ?)`)
      .run(Number(cand.id), String(jobTitle), new Date().toISOString().slice(0, 10), reasonText(codes));
    const cols = tableInfo(db);
    if (cols && cols.has('reason_code')) {
      // 'forced' is a marker that opens the code list of a decision taken in doubt, not a reason: the column holds the first real one
      try { db.prepare(`UPDATE candidate_rejections SET reason_code = ? WHERE ${col} = ? AND job_title = ? AND reason_code IS NULL`).run(primaryReasonCode(codes), Number(cand.id), String(jobTitle)); } catch (e) { /* optional column */ }
    }
    return { ok: true, existed: false };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 120) };
  }
}

// ---------------------------------------------------------------------------------------------
// the reviewer child process
// ---------------------------------------------------------------------------------------------

/**
 * Runs scripts/cv-review.js for one CV. Never throws.
 * @returns {Promise<{code:number|null, result:object|null, detail:string}>} code 0 with a result, 3 = Jev unavailable, anything else = the reviewer failed
 */
function runCli(req) {
  return new Promise(resolve => {
    const args = [
      REVIEWER,
      `--job=${req.jobTitle}`, `--cv-file=${req.cvPath}`, '--known-file=-',
      `--candidate-id=${String(req.cand.id)}`, `--source=${req.cand.source === 'reed' ? 'reed' : 'caterer'}`,
    ];
    if (req.runId) args.push(`--run-id=${req.runId}`);
    if (req.mode === 'shadow' || req.mode === 'on') args.push(`--mode=${req.mode}`);
    if (req.signal && req.signal.aborted) return resolve({ code: null, result: null, aborted: true, detail: 'stopped' });
    let child;
    try {
      child = spawn(process.execPath, args, { cwd: paths.HOME, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env });
    } catch (e) {
      return resolve({ code: null, result: null, detail: `spawn failed: ${String(e.message).slice(0, 80)}` });
    }
    let out = '';
    let err = '';
    let settled = false;
    const onAbort = () => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } finish({ code: null, result: null, aborted: true, detail: 'stopped' }); };
    const finish = v => { if (!settled) { settled = true; clearTimeout(timer); if (req.signal) req.signal.removeEventListener('abort', onAbort); resolve(v); } };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } finish({ code: null, result: null, detail: 'the reviewer did not answer in time' }); }, req.timeoutMs || 180000);
    if (req.signal) req.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', d => { if (out.length < 200000) out += d; });
    child.stderr.on('data', d => { if (err.length < 20000) err += d; });
    child.on('error', e => finish({ code: null, result: null, detail: `spawn error: ${String(e.message).slice(0, 80)}` }));
    child.on('close', code => {
      if (code === 3 || out.startsWith('API_UNAVAILABLE')) {
        const key = /^SCREENING_REASON: ([a-z]{2,20})$/m.exec(err);
        return finish({ code: 3, result: null, reasonKey: key ? key[1] : null, detail: env.redact(out.replace(/^API_UNAVAILABLE:?/, '')).replace(/\s+/g, ' ').trim().slice(0, 160) });
      }
      if (code !== 0) return finish({ code, result: null, detail: env.redact(err.split('\n').filter(l => /^FATAL/.test(l)).pop() || `exit ${code}`).slice(0, 160) });
      const line = out.split('\n').map(l => l.trim()).find(l => l.startsWith('{'));
      let result = null;
      try { result = JSON.parse(line); } catch (e) { result = null; }
      finish({ code: 0, result, detail: '' });
    });
    child.stdin.on('error', () => { /* the child may exit before reading */ });
    child.stdin.end(JSON.stringify(req.known || {}));
  });
}

function validResult(r) {
  return !!r && typeof r === 'object' && DECISIONS.includes(r.decision) && (r.final === 'approve' || r.final === 'reject') && Array.isArray(r.finalReasonCodes);
}

// ---------------------------------------------------------------------------------------------
// the step
// ---------------------------------------------------------------------------------------------

/** The counters of one queue (all zero); what the results file carries as cvScreen. */
function newStats(mode) {
  return {
    mode, considered: 0, screened: 0, pass: 0, reject: 0, review: 0, unreadable: 0, rejected: 0,
    jev: 0, facts: 0, fallback: 0, forced: 0, forcedRejected: 0, policyApprove: 0, policyReject: 0,
    cached: 0, noCv: 0, errors: 0, unscreened: 0, jevCalls: 0, rejectRate: 0, jevShare: null, fallbackShare: null, unavailable: false,
    shadowStopped: false, shadowStoppedBy: null, configInvalid: false,
  };
}

/**
 * Screens the candidates of one queue.
 * @param {{deps:object, cfg:object, mode:'shadow'|'on', candidates:object[], skip:(cand:object)=>boolean, findCv:(cand:object)=>string|null,
 *          jsonPathOf:(cand:object)=>string|null, jobTitle:string, runId:string, applyReject:(cand:object, cvPath:string, codes:string[])=>{recorded:boolean},
 *          concurrency:number, timeoutMs:number, log:(line:string)=>void}} o
 * @returns {Promise<{outcomes:Map<string,object>, stats:object, unavailable:null|{detail:string}, shadowStopped:null|{kind:'failures'|'time', failures:number, detail:string}}>}
 */
async function screenCandidates(o) {
  const outcomes = new Map();
  const stats = newStats(o.mode);
  const todo = o.candidates.filter(c => !o.skip(c));
  let unavailable = null;

  // Shadow mode must never slow Phase 2 down: after N CVs in a row that could not be screened the rest of the queue is skipped
  // and the reviewers still running are stopped. Only a CV that actually needed Jev resets the count (an unreadable file does not).
  const stopAfter = o.mode === 'shadow' && o.cfg.phase2 ? o.cfg.phase2.shadowStopAfterFailures : 0;
  const abort = new AbortController();
  let failures = 0;
  let stopped = null;
  const noteFailure = detail => {
    if (!stopAfter || stopped) return;
    failures++;
    if (failures >= stopAfter) { stopped = { kind: 'failures', failures, detail: String(detail || 'unavailable').slice(0, 120) }; abort.abort(); }
  };
  // ... and not against a gateway that answers, but slowly: after shadowMaxSeconds the rest is skipped whatever the answers were.
  // The limit only ever applies to shadow (mode on must screen every CV before it is pushed, and holds on an outage instead).
  const maxSec = o.mode === 'shadow' && o.cfg.phase2 ? Number(o.cfg.phase2.shadowMaxSeconds) : 0;
  const limitTimer = maxSec > 0 ? setTimeout(() => {
    if (stopped) return;
    stopped = { kind: 'time', failures: 0, seconds: maxSec, detail: `the screening of this queue ran longer than ${maxSec} seconds` };
    abort.abort();
  }, maxSec * 1000) : null;
  const skipStopped = (key) => { stats.unscreened++; outcomes.set(key, { action: 'push', screened: false, why: 'shadow-stopped' }); };

  try {
    await mapPool(todo.length, o.concurrency, async i => {
      const cand = todo[i];
      const key = String(cand.id);
      const cvPath = o.findCv(cand);
      if (!cvPath) { stats.noCv++; outcomes.set(key, { action: 'push', screened: false, why: 'no-cv' }); return; }
      stats.considered++;
      if (stopped) { skipStopped(key); return; }
      const known = knownFor(cand, readProfile(o.jsonPathOf(cand)));
      let r;
      try {
        r = await o.deps.cvScreen({ cand, cvPath, jobTitle: o.jobTitle, known, runId: o.runId, timeoutMs: o.timeoutMs, mode: o.mode, signal: abort.signal });
      } catch (e) {
        r = { code: null, result: null, detail: String((e && e.message) || e).slice(0, 120) };
      }

      if (r.aborted || (stopped && !r.result)) { skipStopped(key); return; }
      if (r.code === 3) {
        if (o.mode === 'on') { unavailable = unavailable || { detail: r.detail, reasonKey: r.reasonKey || null }; stats.unscreened++; outcomes.set(key, { action: 'held', screened: false, why: 'unavailable' }); return; }
        stats.unscreened++;
        outcomes.set(key, { action: 'push', screened: false, why: 'unavailable-shadow' });
        noteFailure(r.detail);
        return;
      }
      let res = r.code === 0 && validResult(r.result) ? r.result : null;
      if (!res) {
        noteFailure(r.detail);
        // the reviewer itself failed (not Jev): the CV passes through like an unreadable one (never a reject), and it is counted
        stats.errors++;
        const s = gate.resolve('unreadable', ['unreadable_review_error'], o.cfg);
        res = { decision: 'unreadable', final: s.final, lane: s.lane, forced: false, reasonCodes: ['unreadable_review_error'], finalReasonCodes: s.finalReasonCodes, policy: s.policy, jevCalls: 0, cached: false };
      }
      if (Number(res.jevCalls) > 0) failures = 0;
      stats.screened++;
      stats[res.decision]++;
      if (res.lane === 'jev' || res.lane === 'facts' || res.lane === 'fallback') stats[res.lane]++;
      if (res.final === 'reject') stats.rejected++;
      if (res.forced) { stats.forced++; if (res.final === 'reject') stats.forcedRejected++; }
      if (res.policy) { if (res.final === 'reject') stats.policyReject++; else stats.policyApprove++; }
      if (res.cached) stats.cached++;
      stats.jevCalls += Number(res.jevCalls) || 0;

      const base = { screened: true, decision: res.decision, final: res.final, lane: res.lane, forced: !!res.forced, reasonCodes: res.finalReasonCodes };
      if (o.mode === 'on' && res.final === 'reject') {
        const applied = o.applyReject(cand, cvPath, res.finalReasonCodes);
        outcomes.set(key, { ...base, action: 'reject', recorded: applied.recorded });
      } else {
        outcomes.set(key, { ...base, action: 'push' });
      }
    }, () => !!unavailable || !!stopped);
  } finally {
    if (limitTimer) clearTimeout(limitTimer);
  }

  // candidates that were not reached stay untouched: held after an outage in mode on, simply not screened after a shadow stop
  for (const cand of todo) {
    const key = String(cand.id);
    if (outcomes.has(key)) continue;
    if (stopped) skipStopped(key);
    else { stats.unscreened++; outcomes.set(key, { action: 'held', screened: false, why: 'unavailable' }); }
  }
  const decided = stats.screened;
  stats.rejectRate = decided ? Math.round(stats.rejected / decided * 1000) / 1000 : 0;
  const modelled = stats.jev + stats.facts + stats.fallback;
  stats.jevShare = modelled ? Math.round(stats.jev / modelled * 1000) / 1000 : null;
  stats.fallbackShare = modelled ? Math.round(stats.fallback / modelled * 1000) / 1000 : null;
  stats.unavailable = !!unavailable;
  stats.shadowStopped = !!stopped;
  stats.shadowStoppedBy = stopped ? stopped.kind : null;
  return { outcomes, stats, unavailable, shadowStopped: stopped };
}

/**
 * Leaves one line in the CV shadow log for a queue whose shadow screening was cut short, so cv-report.js can show how much of what was queued the
 * cap left unscreened. Best effort: logging never affects a run.
 * @param {{enabled?:boolean, runId?:string, stoppedBy:'time'|'failures', screened:number, skipped:number}} o
 */
function logShadowStop(o) {
  try {
    const shadow = require('./shadow');
    if (o.enabled === false) return false; // the shadow log is switched off (config shadow.enabled): this row is not written either
    return new shadow.CvShadowLog().append(shadow.buildQueueStopRow({ ...o, mode: 'shadow' }));
  } catch (e) {
    return false;
  }
}

/**
 * Warnings when one share of a run is above its ceiling (config alerts.*): a mis-tuned gate or a broken reader is noticed within a run.
 * In shadow mode the rates are what the stage WOULD have done, and the texts say so. One more warning when a shadow queue was cut short.
 */
function alertsFor(stats, cfg, jobTitle, location) {
  const A = cfg.alerts;
  const out = [];
  const where = `${jobTitle} in ${location}`;
  const shadow = stats.mode === 'shadow';
  if (stats.configInvalid) {
    // nothing was screened: the criteria file is not usable (fail closed), and in shadow that never blocks anything
    out.push({
      severity: 'warn',
      key: 'cv-config-invalid',
      text: `CV screening (shadow) did not run for ${where}: ${cfg.fault ? cfg.fault.detail : 'its criteria file is not usable'}, so ${stats.unscreened} CV(s) of this queue were not screened. Nothing was blocked and nothing was lost. Fix config/cv-screening.json (or the file CV_SCREEN_CONFIG_FILE names) or restore it from git; with CV_SCREEN on the same fault holds the pipeline.`,
      meta: { skipped: stats.unscreened },
    });
    return out;
  }
  if (stats.shadowStopped) {
    const byTime = stats.shadowStoppedBy === 'time';
    out.push({
      severity: 'warn',
      key: 'cv-shadow-stopped',
      text: byTime
        ? `CV screening (shadow) stopped early for ${where}: it had run for ${cfg.phase2.shadowMaxSeconds} seconds (phase2.shadowMaxSeconds) without finishing the queue, so ${stats.unscreened} CV(s) of this queue were not screened. Nothing was blocked and nothing was lost. The gateway is answering slowly: check the gateway status; screening resumes with the next queue.`
        : `CV screening (shadow) stopped early for ${where}: ${cfg.phase2.shadowStopAfterFailures} CVs in a row could not be screened, so ${stats.unscreened} CV(s) of this queue were not screened. Nothing was blocked and nothing was lost. Check AI_GATEWAY_API_KEY, the credits and the gateway; screening resumes with the next queue.`,
      meta: { screened: stats.screened, skipped: stats.unscreened, ...(byTime ? { reason: 'time' } : {}) },
    });
  }
  if (stats.screened < Math.min(A.rejectRateMinCandidates, A.fallbackMinCandidates)) return out;
  const share = n => n / stats.screened;
  if (stats.screened >= A.rejectRateMinCandidates && share(stats.rejected) > A.rejectRateCeiling) {
    out.push({ severity: 'warn', key: 'cv-reject-rate-high', text: `CV screening ${shadow ? 'would have rejected' : 'rejected'} ${stats.rejected} of ${stats.screened} CVs (${Math.round(share(stats.rejected) * 100)} percent, ceiling ${Math.round(A.rejectRateCeiling * 100)}) for ${where}${shadow ? '; nothing was blocked' : ''}. A gate that is too strict, or a broken reader, looks like this: check shadow/cv-*.jsonl and config/cv-screening.json.`, meta: { screened: stats.screened, rejected: stats.rejected, mode: stats.mode } });
  }
  const modelled = stats.jev + stats.facts + stats.fallback;
  if (modelled >= A.fallbackMinCandidates && stats.fallback / modelled > A.fallbackRateCeiling) {
    out.push({ severity: 'warn', key: 'cv-fallback-rate-high', text: `${stats.fallback} of ${modelled} CVs for ${where} were not decided by Jev (fallback lane, ceiling ${Math.round(A.fallbackRateCeiling * 100)} percent; the owner's rule is that Jev decides at least 99 percent). Look at the reason codes answers_invalid, injection_flag and redaction_unverified in shadow/cv-*.jsonl.`, meta: { screened: stats.screened, fallback: stats.fallback, jevShare: stats.jevShare } });
  }
  if (stats.screened >= A.rejectRateMinCandidates && share(stats.forced) > A.forcedRateCeiling) {
    out.push({ severity: 'warn', key: 'cv-forced-rate-high', text: `${stats.forced} of ${stats.screened} CVs for ${where} were decided in real doubt (forced, ceiling ${Math.round(A.forcedRateCeiling * 100)} percent): Jev was unsure about many of them. Audit the forced rows in shadow/cv-*.jsonl.`, meta: { screened: stats.screened, forced: stats.forced } });
  }
  if (stats.screened >= A.rejectRateMinCandidates && share(stats.unreadable) > A.unreadableRateCeiling) {
    out.push({ severity: 'warn', key: 'cv-unreadable-rate-high', text: `${stats.unreadable} of ${stats.screened} CVs for ${where} could not be read (ceiling ${Math.round(A.unreadableRateCeiling * 100)} percent): the CV reader may be broken, and those CVs go to Zoho unscreened.`, meta: { screened: stats.screened, unreadable: stats.unreadable } });
  }
  return out;
}

// The halt reason and remedy for a failure: the FIXED strings of the screening health check (so a halt raised here and one raised by
// supervision are the same state and never churn), or the generic one when that module cannot be loaded.
function haltFor(reasonKey) {
  try {
    const h = require('../screening-health');
    return { reason: h.REASONS[reasonKey] || h.REASONS.unavailable, remedy: h.REMEDIES[reasonKey] || HALT_REMEDY };
  } catch (e) {
    return { reason: HALT_REASON, remedy: HALT_REMEDY };
  }
}

/**
 * The queue cannot be screened now: keep everything, raise the screening halt (once) and alert. Nothing is pushed, rejected further or deleted.
 * @returns {{halted:boolean}}
 */
function raiseOutage(o) {
  let halted = false;
  let raised = false;
  try {
    const halt = o.halt || require('../pipeline-halt');
    const cur = halt.getHalt();
    if (!(cur && cur.halted)) {
      const hf = haltFor(o.reasonKey);
      const cause = o.reasonKey === 'cvconfig' || o.reasonKey === 'config' ? 'could not run' : 'could not reach Jev';
      halt.setHalt(hf.reason, `CV screening ${cause} during ${o.jobTitle}/${o.location}: ${o.detail || 'unavailable'}. The queue is held with every CV kept.`, { remedy: hf.remedy, blockedRun: true });
      raised = true;
    }
    halted = true;
  } catch (e) { /* the alert below still goes out */ }
  // One critical alert per outage: while the halt is up the retries of the held queue stay quiet.
  if (raised || !halted) {
    try {
      (o.notify || notify)({ severity: 'critical', key: 'cv-screening-unavailable', text: `CV screening is unavailable (${String(o.detail || 'Jev unreachable').slice(0, 120)}). Phase 2 for ${o.jobTitle}/${o.location} is held with ${o.held} candidate(s) and every CV kept; it is retried automatically once screening works. Nothing was approved without screening.`, meta: { runId: o.runId, held: o.held } });
    } catch (e) { /* alerting never throws */ }
  }
  return { halted, alerted: raised || !halted };
}

/** True while the pipeline halt is up for a screening reason (Phase 2 must not even start work that would need Jev). */
function screeningHalted(halt) {
  try {
    const h = (halt || require('../pipeline-halt')).getHalt();
    return !!(h && h.halted && /screening/i.test(String(h.reason || '')));
  } catch (e) {
    return false;
  }
}

/**
 * True when the CV stage is on and the screening halt is up: no new Phase 1 unlock may start (every candidate unlocked now would be
 * held at Phase 2 and never pushed, which is how credits were spent for nothing). Never throws; false in shadow and off.
 */
function unlockBlocked(halt) {
  try {
    return config.screenMode(env.get('CV_SCREEN')).mode === 'on' && screeningHalted(halt);
  } catch (e) {
    return false;
  }
}

module.exports = {
  mode, loadConfig, newStats, knownFor, findEarlierRejection, recordRejection, runCli, screenCandidates, alertsFor, raiseOutage, screeningHalted,
  reasonText, validResult, unlockBlocked, primaryReasonCode, HALT_REASON, logShadowStop,
};
