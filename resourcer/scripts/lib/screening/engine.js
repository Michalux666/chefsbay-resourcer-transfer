'use strict';
// The screening engine. Four selectable engines (config engine / SCREEN_ENGINE):
//   jev_only    (default) Jev is the only model, and no request to any chat-completions endpoint is ever
//               made. decide() forces approve or reject for every card with usable answers (the criteria in
//               config/screening-criteria.json, docs/SCREENING-CRITERIA.md); those lanes are final. The rare
//               fallback lane (a card flagged as an injection by BOTH the keyword filter and Jev, a card of
//               fewer than 20 characters) is resolved by decide.reviewPolicy (reasonCode sys_review_policy_*),
//               never by a second-opinion provider: a card that instructs an AI is not handed to another model.
//               An answer that stays unusable is offered to a second-opinion provider if one is installed; without
//               one it is sys_invalid_result before the unlock (left undecided by the caller) and the policy after it.
//               A Jev outage is ScreeningUnavailable, never a fallback and never a reject.
//               The other three engines need allowLlm (SCREEN_ALLOW_LLM=1); config.load forces jev_only without it.
//   llm         the normal LLM decides, using the legacy recruiter prompt (shared rubric).
//   jev_shadow  the LLM decides exactly as in llm; Jev answers in parallel and is ONLY
//               LOGGED (shadow/screening-*.jsonl). Jev can never change a decision, an exit code or
//               (beyond a small bounded grace wait) the run time.
//   jev         Jev first: atomic questions -> decide() lanes. approve and reject are final; review,
//               injection flags (both filters), invalid answers and a Jev outage go to the LLM. A small share of Jev
//               decisions is re-checked by the LLM in the background (audit) and logged.
// Stage-1 rules (rules.js) run first in every engine; only rules set to 'enforce' decide.
//
// Failure semantics (legacy parity + deliberate changes D3/D4):
//   - every candidate gets exactly one decision or the whole call fails (all-or-nothing);
//   - transport failure (network, timeout, 429/5xx after retries, 401/402/403) -> ScreeningUnavailable
//     (CLI: API_UNAVAILABLE, exit 3); the first hard auth/credit error, or N consecutive candidates
//     failing, stops the run early instead of hammering a dead service;
//   - a model answer that stays unusable after retries and the backup model becomes
//     sys_invalid_result (reject, logged) for that candidate only (a poison pill must not halt the
//     pipeline) - unless it is systemic (many invalid results), which is treated as unavailable so
//     candidates are not silently burned;
//   - decisions made before a failure are cached so the caller's page retry re-asks only the rest.

const path = require('path');
const paths = require('../paths');
const fsx = require('../fsx');
const env = require('../env');
const { HttpFailure, InvalidAnswer, ScreeningUnavailable, reasonKeyOf } = require('./errors');
const { LlmClient, parseJsonLoose } = require('./llm-client');
const { JevClient } = require('./jev-client');
const { redactSnippet, redactTitle, sha16 } = require('./redact');
const { getRoleTier } = require('./tiers');
const { detectSource, snippetFeatures, evaluateRules } = require('./rules');
const rubric = require('./rubric');
const reasons = require('./reasons');
const { decide, compactAnswers } = require('./decide');
const Q = require('./jev-questions');
const { DecisionCache } = require('./cache');
const { ShadowLog } = require('./shadow');
const { Limiter, mapPool, settleWithin } = require('./pool');
const streak = require('./streak');
const { validateProvider, consult: consultSecondOpinion } = require('./second-opinion');

const ERRORS_LOG = path.join(paths.LOGS, 'errors.jsonl');
const DEGRADED_FILE = path.join(paths.RUNTIME, 'screening-degraded.json');
const UNCALIBRATED_FILE = path.join(paths.RUNTIME, 'screening-uncalibrated-warned.json');

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function clamp01(x) { return Math.min(1, Math.max(0, x)); }

// Validate one LLM decision object. approved MUST be a boolean (deliberate change D2: the legacy
// coercion turned the string "false" into true).
function parseDecision(content) {
  let v = parseJsonLoose(content);
  if (Array.isArray(v) && v.length === 1 && v[0] && typeof v[0] === 'object') v = v[0];
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new InvalidAnswer('decision is not an object', 'not_object');
  if (typeof v.approved !== 'boolean') throw new InvalidAnswer('approved is not a boolean', 'bad_approved');
  return {
    approved: v.approved,
    reason: typeof v.reason === 'string' ? v.reason : '',
    reasonCode: reasons.normaliseCode(v.reasonCode, v.approved),
    confidence: isNum(v.confidence) ? clamp01(v.confidence) : null,
  };
}

function appendError(entry) {
  try { fsx.appendLine(ERRORS_LOG, JSON.stringify(entry)); } catch (e) { /* logging must never throw */ }
}

class Run {
  constructor(cfg, cands, ctx, stage, deps) {
    this.cands = cands;
    this.ctx = ctx;
    this.stage = stage;
    this.results = new Array(cands.length).fill(null);
    this.rows = [];
    this.abort = new AbortController();
    this.shadowAbort = new AbortController();
    this.llmLimiter = new Limiter(cfg.llm.concurrency);
    this.jevLimiter = new Limiter(cfg.jev.concurrency);
    this.comparisons = [];
    this.fatal = null;
    this.unavailable = 0;
    this.failStreak = 0;
    this.invalid = 0;
    this.successes = 0;
    this.usable = 0;
    this.jevFailures = 0;
    this.primaryRequestErrors = 0;
    this.jevAttempts = 0;
    this.policyCount = 0;
    this.policy = { reject: 0, approve: 0, byWhy: {} };
    this.lastErr = null;
    this.attempted = new Set();
    this.used = new Map();
    this.deps = deps;
    this.cfg = cfg;
  }

  trip(fatal) {
    if (this.fatal) return;
    this.fatal = fatal;
    this.abort.abort();
  }

  noteUsed(model, rank) { if (model && !this.used.has(model)) this.used.set(model, rank); }

  compare(fn) {
    const p = Promise.resolve().then(fn).catch(() => ({ status: 'error', code: 'internal' }));
    this.comparisons.push(p);
    return p;
  }
}

function createEngine(cfg, deps) {
  const d = deps || {};
  const log = d.log || (() => {});
  const rng = d.rng || Math.random;
  const eff = cfg.engineEffective;
  const only = eff === 'jev_only';
  const llmClient = only ? null : (d.llm || new LlmClient({ cfg, log, rng }));
  const jevClient = d.jev || new JevClient({ cfg, log: eff === 'jev' || only ? log : () => {}, rng });
  const secondOpinion = only ? validateProvider(d.secondOpinion) : null;
  let uncalibratedWarned = false;
  const cache = d.cache || new DecisionCache({ ttlSec: cfg.cache.ttlSec, maxEntries: cfg.cache.maxEntries });
  const shadow = d.shadow || new ShadowLog({ enabled: cfg.shadow.enabled });
  const errorLog = d.errorLog || appendError;

  const rubricOpts = { tierMode: cfg.tierMode, staleProfileClause: cfg.rubric.staleProfileClause, insufficientEvidence: cfg.rubric.insufficientEvidence };

  const sig = sha16([
    eff, only ? '' : cfg.llm.model, only ? '' : (cfg.llm.backupModel || ''), cfg.jev.model, secondOpinion ? secondOpinion.name : '', rubric.variantOf(rubricOpts), cfg.tierMode,
    Q.QUESTIONS_VERSION, JSON.stringify(cfg.decide), JSON.stringify(cfg.stage1.rules),
    cfg.redact.enabled ? 'r1' : 'r0',
  ].join('|'));

  function prepare(run, i) {
    const c = run.cands[i] || {};
    const rs = redactSnippet(c.snippet, { firstName: c.name, enabled: cfg.redact.enabled, maxChars: cfg.redact.maxSnippetChars });
    const titleText = run.stage === 'post_unlock' ? redactTitle(c.title, { enabled: cfg.redact.enabled }).text : '';
    // A title that is only masks (a postcode or e-mail in the title field) is no title: it would reach Jev as '<PC>'.
    const title = /^(?:<[A-Z]+>\s*)+$/.test(titleText) ? '' : titleText;
    const source = run.ctx.source || detectSource(rs.text);
    const features = snippetFeatures(rs.text, source);
    const rules = evaluateRules(features, { searchTier: run.searchTier }, cfg);
    return { id: String(c.id || ''), snippet: rs.text, title, source, features, rules, sha: sha16(rs.text), len: rs.text.length };
  }

  function newRow(run, prep) {
    return {
      v: 1,
      ts: new Date().toISOString(),
      mode: eff,
      runId: run.ctx.runId || null,
      source: prep.source,
      stage: run.stage,
      jobTitle: run.ctx.job,
      searchTier: run.searchTier,
      candidateId: prep.id,
      snippetSha: prep.sha,
      snippetLen: prep.len,
      // D3: the REDACTED input is kept (retention window applies) so recruiters can label a gold set; switch off with shadow.storeText
      ...(cfg.shadow.storeText ? { input: prep.snippet } : {}),
      ...(cfg.shadow.storeText && run.stage === 'post_unlock' ? { inputTitle: prep.title } : {}),
      redacted: cfg.redact.enabled,
      flags: prep.rules.flags,
      rules: prep.rules.hits.map(h => ({ id: h.id, mode: h.mode, decision: h.decision })),
      used: null,
      llm: null,
      jev: null,
      rv: rubric.variantOf(rubricOpts),
      qv: Q.QUESTIONS_VERSION,
      tm: cfg.tierMode,
      ...(only ? { cal: !!cfg.decide.calibration.calibrated } : {}),
    };
  }

  function decisionOf(source, o) {
    return {
      approved: o.approved,
      reasonCode: o.reasonCode,
      // the LLM's own line is used as before (legacy default 'Approved'/'Rejected' when empty); other engines get the code's sentence
      reason: reasons.reasonText({ text: o.reason, code: source === 'llm' ? null : o.reasonCode, approved: o.approved, job: o.job }),
      confidence: o.confidence === undefined ? null : o.confidence,
      source,
      engineModel: o.model,
      escalated: !!o.escalated,
      ruleId: o.ruleId || null,
    };
  }

  async function runJev(run, prep, shadowCall) {
    if (prep.features.noContent) return { status: 'skipped', why: 'no_content' };
    const signal = shadowCall ? AbortSignal.any([run.abort.signal, run.shadowAbort.signal]) : run.abort.signal;
    const jevStage = run.stage === 'post_unlock' && prep.title ? 2 : 1;
    const maxAttempts = shadowCall ? cfg.shadow.jevMaxAttempts : cfg.jev.maxAttempts;
    if (!shadowCall) run.attempted.add(cfg.jev.model);
    const t0 = Date.now();
    let last = null;
    for (let inv = 1; inv <= cfg.jev.maxInvalidAttempts; inv++) {
      let r;
      try {
        r = await run.jevLimiter.run(() => jevClient.evaluate({
          searchRole: run.ctx.job, searchTier: run.searchTier, snippet: prep.snippet, realJobTitle: prep.title, stage: jevStage, signal, maxAttempts,
        }));
      } catch (e) {
        if (e instanceof HttpFailure && e.kind === 'aborted') return { status: 'timeout', latencyMs: Date.now() - t0 };
        throw e;
      }
      run.jevAttempts += r.attempts || (r.meta && r.meta.attempts) || 1;
      if (r.ok) {
        const dec = decide({ answers: r.answers, searchRole: run.ctx.job, searchTier: run.searchTier, stage: jevStage }, cfg);
        return {
          status: 'ok',
          model: r.meta.model,
          lane: dec.lane,
          reasonCode: dec.reasonCode,
          reviewReason: dec.reviewReason,
          confidence: dec.confidence,
          flags: dec.flags,
          stage: jevStage,
          answers: compactAnswers(r.answers),
          requestId: r.meta.requestId,
          latencyMs: Date.now() - t0,
          attempts: r.meta.attempts,
        };
      }
      last = r;
      if (r.kind !== 'invalid') break;
    }
    const failed = { status: last.kind === 'invalid' ? 'invalid' : 'error', kind: last.kind, code: last.code, latencyMs: Date.now() - t0, attempts: last.attempts || 1 };
    // not enumerable: the caller needs the error, the shadow row must never carry a gateway message
    if (last.kind !== 'invalid') Object.defineProperty(failed, 'err', { value: new HttpFailure(last.kind, last.message, { status: last.status, attempts: last.attempts }) });
    return failed;
  }

  function llmMessages(run, prep) {
    const opts = { ...rubricOpts, output: 'object' };
    const user = run.stage === 'post_unlock'
      ? rubric.buildSinglePrompt(run.ctx.job, prep.title, prep.snippet, opts)
      : rubric.buildBatchPrompt(run.ctx.job, run.ctx.location, run.ctx.distance, [{ id: prep.id, snippet: prep.snippet }], opts);
    return [{ role: 'system', content: rubric.SYSTEM_MESSAGE }, { role: 'user', content: user }];
  }

  // LLM decision for one candidate: primary model (retrying unusable output), then the backup model.
  async function runLlm(run, prep, signal, opts) {
    if (only) throw new Error('internal: the LLM path is disabled in jev_only');
    const o = opts || {};
    // a primary model the gateway keeps refusing as a bad request (retired or misspelt slug) is skipped
    // for the rest of the run once it has failed twice in a row, so every candidate does not pay for it
    const skipPrimary = !!cfg.llm.backupModel && run.primaryRequestErrors >= 2;
    const models = (skipPrimary ? [cfg.llm.backupModel] : [cfg.llm.model, cfg.llm.backupModel]).filter(Boolean);
    const messages = llmMessages(run, prep);
    const t0 = Date.now();
    if (!models.length) {
      const err = new HttpFailure('request', 'no LLM model is configured');
      return { ok: false, kind: 'request', err, summary: { status: 'error', model: null, code: 'no_model', latencyMs: 0 } };
    }
    let sawTransient = null;
    let invalidCode = null;
    let requestErr = null;
    let attempts = 0;
    for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi];
      run.attempted.add(model);
      const isPrimary = model === cfg.llm.model;
      const tries = isPrimary ? cfg.llm.maxInvalidAttempts : 1;
      for (let t = 0; t < tries; t++) {
        try {
          const r = await run.llmLimiter.run(() => llmClient.chat({
            model, messages, schemaName: 'screening_decision', schema: rubric.DECISION_SCHEMA, signal,
            maxAttempts: o.maxAttempts, timeoutMs: o.timeoutMs,
          }));
          attempts += r.attempts || 1;
          const parsed = parseDecision(r.content);
          if (isPrimary) run.primaryRequestErrors = 0;
          return { ok: true, dec: { ...parsed, model }, summary: { status: 'ok', model, approved: parsed.approved, reasonCode: parsed.reasonCode, confidence: parsed.confidence, latencyMs: Date.now() - t0, attempts, backup: mi > 0 } };
        } catch (e) {
          if (e instanceof InvalidAnswer) { invalidCode = e.code; attempts++; continue; }
          if (e instanceof HttpFailure) {
            if (e.kind === 'aborted') return { ok: false, kind: 'aborted', summary: { status: 'timeout', model, latencyMs: Date.now() - t0 } };
            if (e.hard) return { ok: false, kind: 'hard', err: e, summary: { status: 'error', model, code: `http_${e.status || e.kind}`, latencyMs: Date.now() - t0 } };
            if (e.kind === 'transient') { sawTransient = e; break; }
            if (e.kind === 'request') { requestErr = e; if (isPrimary) run.primaryRequestErrors++; break; }
          }
          throw e;
        }
      }
    }
    if (sawTransient) {
      return { ok: false, kind: 'transient', err: sawTransient, summary: { status: 'error', model: models[0], code: `http_${sawTransient.status || 'network'}`, latencyMs: Date.now() - t0, attempts } };
    }
    // A 4xx means our request or configuration is wrong (retired slug, unsupported flag): systemic, never a verdict on the candidate.
    if (requestErr) {
      return { ok: false, kind: 'request', err: requestErr, summary: { status: 'error', model: models[0], code: `request_${requestErr.status}`, latencyMs: Date.now() - t0, attempts } };
    }
    const code = invalidCode || 'invalid';
    return { ok: false, kind: 'invalid', code, summary: { status: 'invalid', model: models[0], code, latencyMs: Date.now() - t0, attempts } };
  }

  function rankOf(model) {
    if (model === cfg.jev.model) return 0;
    if (model === cfg.llm.model) return 1;
    if (model === cfg.llm.backupModel) return 2;
    if (secondOpinion && model === secondOpinion.name) return 6;
    if (model === 'policy') return 8;
    if (model === 'rules') return 9;
    return 5;
  }

  function success(run, usable) { run.failStreak = 0; run.successes++; if (usable) run.usable++; }

  function tally(run, dec) {
    if (!reasons.isPolicyCode(dec.reasonCode)) return;
    const side = dec.approved ? 'approve' : 'reject';
    const why = dec.policyWhy || 'cached';
    run.policyCount++;
    run.policy[side]++;
    run.policy.byWhy[why] = (run.policy.byWhy[why] || 0) + 1;
  }

  function warnUncalibrated(ctx) {
    if (!only || uncalibratedWarned || cfg.decide.calibration.calibrated) return;
    uncalibratedWarned = true;
    const runId = ctx.runId ? String(ctx.runId).slice(0, 80) : '';
    try {
      if (runId) {
        const prev = fsx.readJson(UNCALIBRATED_FILE, null);
        if (prev && prev.runId === runId) return;
        fsx.writeJsonAtomic(UNCALIBRATED_FILE, { runId, at: new Date().toISOString() }, 0o600);
      }
    } catch (e) { /* the warning is still worth more than the de-duplication */ }
    log('WARN screening: engine jev_only is running on UNCALIBRATED placeholder thresholds (the operating point in screening-criteria.json was fitted on old-model labels, not on recruiter labels); the policy share in the summary line should stay near zero, see docs/SCREENING.md section 16.');
  }

  // Second opinion (extension point, no provider ships): only for a valid but uncertain Jev answer or an unusable one.
  async function askSecondOpinion(run, prep, row, why, jr) {
    const req = { job: run.ctx.job, stage: run.stage, searchTier: run.searchTier, snippet: prep.snippet, title: prep.title, reviewReason: (jr && jr.reviewReason) || null, candidateId: prep.id };
    const r = await consultSecondOpinion(secondOpinion, req, { signal: run.abort.signal });
    row.second = { provider: secondOpinion.name, status: r.status };
    if (r.status !== 'ok') return null;
    run.noteUsed(secondOpinion.name, 6);
    return decisionOf('second_opinion', { approved: r.answer.approved, reasonCode: reasons.normaliseCode(r.answer.reasonCode, r.answer.approved), confidence: r.answer.confidence, model: secondOpinion.name, job: run.ctx.job });
  }

  // An unusable answer is a fault, not an unsure card: before the unlock it is left undecided (the caller screens it again), after it the policy applies.
  async function resolveByPolicy(run, prep, row, why, jr) {
    if (secondOpinion && (why === 'review' || why === 'invalid')) {
      const so = await askSecondOpinion(run, prep, row, why, jr);
      if (so) return so;
    }
    if (why === 'invalid' && run.stage === 'pre_unlock') {
      return decisionOf('system', { approved: run.failOpen, reasonCode: run.failOpen ? 'sys_fail_open' : 'sys_invalid_result', model: 'none', job: run.ctx.job });
    }
    const side = run.stage === 'post_unlock' ? cfg.decide.reviewPolicy.postUnlock : cfg.decide.reviewPolicy.preUnlock;
    const approved = side === 'approve';
    row.policy = { why, side, ...(jr && jr.reviewReason ? { reviewReason: jr.reviewReason } : {}) };
    const dec = decisionOf('policy', { approved, reasonCode: approved ? 'sys_review_policy_approve' : 'sys_review_policy_reject', model: 'policy', job: run.ctx.job });
    dec.policyWhy = why;
    return dec;
  }

  // jev_only: Jev decides approve and reject; everything else goes to resolveByPolicy. Jev unavailable trips or fails the run, it never decides anything.
  async function decideJevOnly(run, prep, row) {
    const jr = await runJev(run, prep, false);
    row.jev = jr;
    // decide() reports any exception (a missing or malformed answer) and an unreadable card as ANSWER_UNUSABLE: a fault, so it feeds the guards
    const unusable = jr.status === 'invalid' || (jr.status === 'ok' && jr.reviewReason === 'ANSWER_UNUSABLE');
    let why;
    if (jr.status === 'ok' && !unusable) {
      run.noteUsed(jr.model, rankOf(jr.model));
      if (jr.lane !== 'review') return decisionOf('jev', { approved: jr.lane === 'approve', reasonCode: jr.reasonCode, confidence: jr.confidence, model: jr.model, job: run.ctx.job });
      why = jr.reviewReason === 'INJECTION_FLAG' ? 'injection' : 'review';
    } else if (jr.status === 'skipped') {
      why = jr.why;
    } else if (unusable) {
      why = 'invalid';
      run.invalid++;
      run.jevFailures++;
      errorLog({
        ts: new Date().toISOString(), context: 'screening_invalid_result', severity: 'warn',
        error: `Jev answer unusable for candidate ${prep.id} (${jr.code || 'decide'}); ${run.stage === 'pre_unlock' ? 'left undecided, screened again next time' : 'decided by the review policy'}`,
        detail: `job=${run.ctx.job} stage=${run.stage} model=${cfg.jev.model}`,
      });
    } else if (jr.status === 'timeout') {
      return null;
    } else {
      run.jevFailures++;
      const err = jr.err || new HttpFailure('transient', 'Jev request failed');
      if (err.hard) run.trip({ detail: err.message, reasonKey: reasonKeyOf(err), status: err.status });
      else candidateUnavailable(run, err);
      return null;
    }
    return resolveByPolicy(run, prep, row, why, jr);
  }

  function candidateUnavailable(run, err) {
    run.unavailable++;
    run.failStreak++;
    run.lastErr = err;
    if (run.failStreak >= cfg.batch.breakerConsecutive) {
      run.trip({
        detail: `AI screening service failing: ${run.failStreak} consecutive candidates could not be screened. Last error: ${err.message}`,
        reasonKey: reasonKeyOf(err),
        status: err.status || null,
      });
    }
  }

  async function processInner(run, i) {
    const prep = prepare(run, i);
    const ckey = run.useCache ? DecisionCache.key({ sig, job: run.ctx.job, stage: run.stage, title: prep.title, text: prep.snippet }) : null;
    if (ckey) {
      const hit = cache.get(ckey);
      if (hit) {
        run.results[i] = decisionOf('cache', { approved: hit.a === 1, reasonCode: hit.rc, confidence: hit.cf, model: hit.m, job: run.ctx.job, ruleId: hit.r });
        run.noteUsed(hit.m, rankOf(hit.m));
        tally(run, run.results[i]);
        success(run, true);
        return;
      }
    }

    const row = newRow(run, prep);
    run.rows.push(row);
    const job = run.ctx.job;

    if (eff === 'jev_shadow' && cfg.shadow.enabled && rng() < cfg.shadow.rate) {
      run.compare(() => runJev(run, prep, true)).then(r => { row.jev = r; });
    }

    let used = null;
    if (prep.rules.enforced) {
      used = decisionOf('rule', { approved: prep.rules.enforced.decision === 'approve', reasonCode: prep.rules.enforced.reasonCode, model: 'rules', job, ruleId: prep.rules.enforced.id });
    } else if (only) {
      used = await decideJevOnly(run, prep, row);
      if (!used) return;
    } else if (eff === 'jev') {
      const jr = await runJev(run, prep, false);
      row.jev = jr;
      if (jr.status === 'ok' && jr.lane !== 'review') {
        used = decisionOf('jev', { approved: jr.lane === 'approve', reasonCode: jr.reasonCode, confidence: jr.confidence, model: jr.model, job });
      } else if (jr.status !== 'ok' && jr.status !== 'skipped') {
        run.jevFailures++;
      }
    }

    if (!used && !only) {
      const lr = await runLlm(run, prep, run.abort.signal, {});
      row.llm = lr.summary;
      if (lr.ok) {
        used = decisionOf('llm', { ...lr.dec, job, escalated: eff === 'jev' });
      } else if (lr.kind === 'hard') {
        run.trip({ detail: lr.err.message, reasonKey: reasonKeyOf(lr.err), status: lr.err.status });
        row.used = null;
        return;
      } else if (lr.kind === 'transient' || lr.kind === 'request') {
        candidateUnavailable(run, lr.err);
        return;
      } else if (lr.kind === 'aborted') {
        return;
      } else {
        run.invalid++;
        used = decisionOf('system', { approved: run.failOpen, reasonCode: run.failOpen ? 'sys_fail_open' : 'sys_invalid_result', model: 'none', job });
        errorLog({
          ts: new Date().toISOString(), context: 'screening_invalid_result', severity: 'warn',
          error: `Screening result unusable for candidate ${prep.id} (${lr.code}); ${run.failOpen ? 'approved' : 'rejected conservatively'}`,
          detail: `job=${job} stage=${run.stage} models=${[cfg.llm.model, cfg.llm.backupModel].filter(Boolean).join(',')}`,
        });
      }
    }

    row.used = { engine: used.source, approved: used.approved, reasonCode: used.reasonCode, model: used.engineModel, escalated: used.escalated };
    run.results[i] = used;
    tally(run, used);
    // an unusable Jev answer decided by the policy is not evidence: it is neither cached nor counted as a usable answer
    const usable = used.source !== 'system' && used.policyWhy !== 'invalid';
    if (usable) {
      run.noteUsed(used.engineModel, rankOf(used.engineModel));
      if (ckey) cache.set(ckey, { a: used.approved ? 1 : 0, rc: used.reasonCode, cf: used.confidence, m: used.engineModel, r: used.ruleId || undefined });
    }
    success(run, usable);

    // audit: a small share of Jev / rule decisions is re-checked by the LLM in the background
    if (!only && cfg.shadow.enabled && (used.source === 'jev' || used.source === 'rule') && rng() < cfg.shadow.auditRate) {
      const sig2 = AbortSignal.any([run.abort.signal, run.shadowAbort.signal]);
      run.compare(() => runLlm(run, prep, sig2, { maxAttempts: 1, timeoutMs: cfg.shadow.auditTimeoutMs })).then(r => { row.llm = r.summary; });
    }
  }

  async function processOne(run, i) {
    try {
      await processInner(run, i);
    } catch (e) {
      if (e instanceof HttpFailure && e.kind === 'aborted') return;
      // an unexpected bug for one candidate: unusable result, logged, never a crash of the whole run
      run.invalid++;
      const c = run.cands[i] || {};
      run.results[i] = decisionOf('system', { approved: run.failOpen, reasonCode: run.failOpen ? 'sys_fail_open' : 'sys_invalid_result', model: 'none', job: run.ctx.job });
      errorLog({
        ts: new Date().toISOString(), context: 'screening_internal_error', severity: 'warn',
        error: `Unexpected screening error for candidate ${String(c.id || '')}: ${env.redact(String(e && e.message)).slice(0, 120)}`,
        detail: `job=${run.ctx.job} stage=${run.stage}`,
      });
    }
  }

  function labelOf(run) {
    const entries = [...run.used.entries()].sort((a, b) => a[1] - b[1]).map(e => e[0]);
    if (only) {
      if (run.attempted.has(cfg.jev.model) && !entries.includes(cfg.jev.model)) entries.unshift(cfg.jev.model);
      if (run.policyCount > 0 && !entries.includes('policy')) entries.push('policy');
    }
    if (entries.length) return entries.join('+');
    return run.attempted.size ? attemptedLabel(run) : 'unknown';
  }

  function attemptedLabel(run) {
    const a = [...run.attempted];
    return a.length ? a.join('+') : 'none';
  }

  function degrade(run) {
    if (eff !== 'jev') return;
    try {
      if (run.jevFailures > 0) {
        fsx.writeJsonAtomic(DEGRADED_FILE, { degraded: true, engine: 'jev', since: new Date().toISOString(), failures: run.jevFailures, of: run.cands.length, detail: 'Jev could not answer; the LLM is deciding those candidates' });
      } else if (run.successes > 0) {
        fsx.safeUnlink(DEGRADED_FILE);
      }
    } catch (e) { /* best effort */ }
  }

  async function execute(ctx, cands, stage, opts) {
    const o = opts || {};
    if (!cands.length) return { decisions: [], modelLabel: 'unknown', stats: { total: 0, bySource: {}, invalid: 0, jevFailures: 0, policy: { total: 0, reject: 0, approve: 0, byWhy: {}, share: 0 }, engine: eff } };
    if (!env.get('AI_GATEWAY_API_KEY')) {
      const err = new ScreeningUnavailable('AI_GATEWAY_API_KEY is not set', { reasonKey: 'auth' });
      err.label = 'none';
      throw err;
    }
    warnUncalibrated(ctx);
    const run = new Run(cfg, cands, ctx, stage, d);
    run.searchTier = getRoleTier(ctx.job, cfg.tierMode);
    run.singleMode = stage === 'post_unlock';
    // an unusable model answer: single mode fails open (credit spent); batch rejects unless configured to approve
    run.failOpen = !!o.failOpen || cfg.batch.onInvalid === 'approve';
    run.useCache = stage === 'pre_unlock' && cache.enabled;

    const timer = setTimeout(() => run.trip({ detail: `AI screening deadline of ${Math.round(cfg.batch.deadlineMs / 1000)}s exceeded`, reasonKey: 'unreachable', status: null }), cfg.batch.deadlineMs);
    try {
      const concurrency = only ? cfg.jev.concurrency : (eff === 'jev' ? Math.max(cfg.jev.concurrency, cfg.llm.concurrency) : cfg.llm.concurrency);
      await mapPool(cands.length, concurrency, i => processOne(run, i), () => !!run.fatal);

      if (run.comparisons.length) {
        await settleWithin(Promise.allSettled(run.comparisons), cfg.shadow.graceMs);
        run.shadowAbort.abort();
        await Promise.allSettled(run.comparisons);
      }
    } finally {
      clearTimeout(timer);
      run.shadowAbort.abort();
      for (const row of run.rows) {
        shadow.append(row);
      }
      cache.save();
      degrade(run);
    }

    if (run.fatal) {
      const err = new ScreeningUnavailable(run.fatal.detail, { reasonKey: run.fatal.reasonKey, status: run.fatal.status, engines: [...run.attempted] });
      err.label = attemptedLabel(run);
      throw err;
    }
    if (run.unavailable > 0) {
      const err = new ScreeningUnavailable(`${run.unavailable} of ${cands.length} candidates could not be screened. Last error: ${run.lastErr ? run.lastErr.message : 'unknown'}`, { reasonKey: reasonKeyOf(run.lastErr), status: run.lastErr && run.lastErr.status, engines: [...run.attempted] });
      err.label = attemptedLabel(run);
      throw err;
    }
    if (!run.singleMode) {
      const massive = run.invalid >= cfg.batch.invalidMassMin && run.invalid / cands.length >= cfg.batch.invalidMassShare;
      // Pages are mostly 1-3 candidates: when nothing at all in a call was usable the fault is systemic, not one poison card.
      const allInvalid = cands.length >= 2 && run.invalid === cands.length;
      const st = streak.record({ invalid: run.invalid, successes: run.usable, max: cfg.batch.invalidStreakMax, ttlMs: cfg.batch.invalidStreakTtlSec * 1000 });
      if (massive || allInvalid || st.trip) {
        const why = st.trip && !massive && !allInvalid ? `${st.count} candidates in a row across calls` : `${run.invalid} of ${cands.length} candidates`;
        const err = new ScreeningUnavailable(`AI screening produced unusable results for ${why} (systemic, not a single bad candidate)`, { reasonKey: 'error', engines: [...run.attempted] });
        err.label = attemptedLabel(run);
        throw err;
      }
    }

    if (run.results.some(r => !r)) {
      const err = new ScreeningUnavailable('internal error: a candidate ended without a decision', { reasonKey: 'error', engines: [...run.attempted] });
      err.label = attemptedLabel(run);
      throw err;
    }

    const bySource = {};
    for (const r of run.results) if (r) bySource[r.source] = (bySource[r.source] || 0) + 1;
    return {
      decisions: run.results,
      modelLabel: labelOf(run),
      stats: {
        total: cands.length, bySource, invalid: run.invalid, jevFailures: run.jevFailures, engine: eff,
        policy: { total: run.policyCount, reject: run.policy.reject, approve: run.policy.approve, byWhy: run.policy.byWhy, share: Math.round(run.policyCount / cands.length * 1000) / 1000 },
      },
    };
  }

  return {
    engine: eff,
    /**
     * @param {{job:string, location?:string, distance?:number, source?:string, runId?:string}} ctx
     * @param {Array<{id:any, snippet:string, name?:string}>} candidates
     * @returns {Promise<{decisions:object[], modelLabel:string, stats:object}>}
     * @throws {ScreeningUnavailable}
     */
    screenBatch(ctx, candidates) {
      return execute(ctx, candidates, 'pre_unlock', { failOpen: false });
    },
    /**
     * Post-unlock single screening. An unusable answer fails OPEN (approve, sys_fail_open): the credit
     * is already spent. Unavailability still throws so the CLI reports API_UNAVAILABLE (the caller
     * then approves, exactly as before).
     */
    async screenOne(ctx, candidate) {
      const r = await execute(ctx, [candidate], 'post_unlock', { failOpen: true });
      return { decision: r.decisions[0], modelLabel: r.modelLabel, stats: r.stats };
    },
  };
}

module.exports = { createEngine, parseDecision, ERRORS_LOG, DEGRADED_FILE };
