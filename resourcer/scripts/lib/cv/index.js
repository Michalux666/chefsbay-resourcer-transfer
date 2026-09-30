'use strict';
// The CV screening stage. screenCv() judges the candidate's WHOLE work history against the role that was searched for:
//   read (extract) -> remove personal data (redact) -> structure (parse) -> facts by code -> Jev answers typed questions about
//   the searched role and every listed role -> the gate (code, ONE operating point, forced choice) -> pass or reject.
// Only the structured, redacted role entries (title, employer, dates, short duties) and the searched role go to Jev, never CV
// text, names, contact details, addresses or referees. Requiring this module has no side effects (no I/O, no exit).
//
//   const cv = require('./lib/cv');
//   const r = await cv.screenCv({ searchRole, fileBuffer, fileType, ctx: { known, candidateId, source, runId } });
//   r = { decision:'pass'|'reject'|'review'|'unreadable', final:'approve'|'reject', lane:'jev'|'facts'|'fallback'|'unreadable',
//         forced, confidence, pReject, reasonCodes, finalReasonCodes, policy, evidence (numbers only), searchLevel, model, ... }
//
// Who decides (docs/CV-SCREENING.md): Jev, for at least 99 percent of candidates: lane 'jev' (its answers plus the facts, forced
// choice, never a middle lane). Lane 'facts': a CV read with high confidence that lists no work history at all (nothing to ask Jev).
// Lane 'fallback' (decision 'review', very rare): Jev's answers were unusable after retries, or both injection filters fired, or the
// personal data could not be removed with certainty; config fallback.policy settles it (the second model is not part of this build).
// Lane 'unreadable': the CV text could not be read or turned into a work history; it PASSES THROUGH on the snippet decision.
//
// Failures: ScreeningUnavailable (Jev cannot answer: unreachable, refused, out of credit, timed out, or every answer unusable
// several times in a row). It is never turned into a decision: callers map it to API_UNAVAILABLE / exit 3 and stop.

const config = require('./config');
const facts = require('./facts');
const Q = require('./questions');
const gate = require('./gate');
const cache = require('./cache');
const injection = require('./injection');
const { CvJev, ask, unavailableFrom } = require('./jev');
const { resolveSearchLevel } = require('./levels');
const { CvShadowLog, buildRow } = require('./shadow');
const extract = require('./extract');
const redact = require('./redact');
const parse = require('./parse');
const env = require('../env');
const { ScreeningUnavailable, UsageError } = require('../screening/errors');

function anySignal(list) {
  const s = list.filter(Boolean);
  return s.length > 1 ? AbortSignal.any(s) : s[0];
}

// The raw answers of one request, arranged as the gate reads them.
function shapeAnswers(raw, n) {
  const relevance = [];
  const seniority = [];
  for (let i = 0; i < n; i++) {
    relevance.push(raw[`relevance_${i}`]);
    seniority.push(raw[`seniority_${i}`]);
  }
  const out = { relevance, seniority, overall: raw.overall_match, progression: raw.progression, careerChange: raw.career_change, injection: raw.injection };
  const ok = relevance.every(a => a && a.p) && seniority.every(a => a && a.p) && out.overall && out.overall.p && out.progression && out.progression.p
    && typeof out.careerChange === 'number' && typeof out.injection === 'number';
  if (!ok) throw new Error('answers are incomplete');
  return out;
}

function blankResult(cfg, extra) {
  return {
    decision: 'review', final: 'approve', lane: 'fallback', forced: false, confidence: null, pReject: null, tau: cfg.tau,
    reasonCodes: [], finalReasonCodes: [], policy: null, evidence: {},
    searchLevel: 'unknown', levelP: 0, model: null, cached: false, jevCalls: 0, jevDecision: null,
    roles: null, months: null, dates: null, answers: null, cfgSig: cfg.signature, qv: cfg.questions.version, inputKind: null, ...extra,
  };
}

function settle(cfg, r) {
  const res = gate.resolve(r.decision, r.reasonCodes, cfg, { jevDecision: r.jevDecision, injection: r.reasonCodes.includes('injection_flag') });
  return { ...r, final: res.final, lane: r.lane === 'facts' && r.decision !== 'review' ? 'facts' : res.lane, policy: res.policy, finalReasonCodes: res.finalReasonCodes };
}

function factSummary(f, relevantMonths) {
  return {
    roles: { parsed: f.rolesParsed, sent: f.rolesSent, undated: f.undatedRoles, omittedOld: f.omitted.old, omittedCapped: f.omitted.capped, omittedFuture: f.omitted.future, duplicates: f.omitted.duplicates },
    months: { total: f.totalMonths, recent: f.monthsRecent, relevant: relevantMonths === undefined ? null : relevantMonths },
    dates: f.roles.map(r => (r.dated ? [r.startIdx, r.endIdx] : null)),
  };
}

// What the fields sent to Jev say to the keyword filter.
function injectionTexts(f) {
  const out = [];
  for (const r of f.roles) out.push(r.title, r.employer, r.duties);
  return out.concat(f.qualifications);
}

/**
 * @param {{searchRole:string, record?:object, fileBuffer?:Buffer, fileType?:string, ctx?:object}} req
 *   ctx: {cfg, now, known:{names,emails,phones,postcodes}, log, signal, jev (an object with evaluate(), tests), answersCache,
 *         levelStore, shadow (a CvShadowLog, or null to log nothing), candidateId, source, runId, mode}
 * @returns {Promise<object>}
 */
async function screenCv(req) {
  const ctx = req.ctx || {};
  const cfg = ctx.cfg || config.load();
  const now = ctx.now || new Date();
  const log = ctx.log || (() => {});
  const searchRole = facts.cleanText(req.searchRole, cfg.input.maxSearchRoleChars);
  if (!searchRole) throw new UsageError('the searched role is required');
  const inputKind = req.record ? 'record' : 'file';
  const minChars = cfg.evidence.minReadableChars;

  const done = r => {
    const result = settle(cfg, { ...blankResult(cfg), inputKind, ...r });
    const shadow = ctx.shadow === undefined ? new CvShadowLog({ enabled: cfg.shadow.enabled }) : ctx.shadow;
    if (shadow && shadow.enabled !== false && cfg.shadow.enabled) {
      shadow.append(buildRow(result, { mode: ctx.mode || (env.get('CV_SCREEN') ? config.screenMode(env.get('CV_SCREEN')).mode : 'cli'), runId: ctx.runId, source: ctx.source, candidateId: ctx.candidateId, jobTitle: searchRole, now, storeAnswers: cfg.shadow.storeAnswers, inputKind }));
    }
    return result;
  };

  // 1. a parsed, redacted record: read it from the file, or take the one the caller already holds
  let record = req.record;
  let textVerified = true;
  let textChars = null;
  if (!record) {
    if (!Buffer.isBuffer(req.fileBuffer)) throw new UsageError('a CV file or a parsed record is required');
    const ex = await extract.extractText(req.fileBuffer, req.fileType);
    if (!ex.ok) return done({ decision: 'unreadable', lane: 'unreadable', reasonCodes: [`unreadable_${ex.reason}`] });
    textChars = ex.text.length;
    if (textChars < minChars) return done({ decision: 'unreadable', lane: 'unreadable', reasonCodes: ['unreadable_too_little_text'] });
    const red = await redact.redactCv(ex.text, ctx.known);
    const redAlt = ex.textAlt ? await redact.redactCv(ex.textAlt, ctx.known) : null;
    textVerified = !!red.verified && (!redAlt || !!redAlt.verified);
    const asOf = facts.ymText(facts.nowIndex(now));
    const parsed = await parse.parseRoles(redAlt ? { variants: [{ name: 'row', text: red.text }, { name: 'column', text: redAlt.text }] } : red.text, { asOf });
    record = { roles: parsed.roles, qualifications: parsed.qualifications, parseConfidence: parsed.parseConfidence };
  } else {
    if (record.redactionVerified === false) textVerified = false;
    if (typeof record.textChars === 'number') textChars = record.textChars;
  }

  // 2. the last barrier: a whitelisted copy with every pattern of personal data masked. When the text-level check was not clean the
  //    duties (the free-text part) are not sent at all: the titles, employers and dates are enough for Jev.
  const scrub = redact.scrubRecord(record, ctx.known);
  if (!scrub.verified) return done({ decision: 'review', lane: 'fallback', reasonCodes: ['redaction_unverified'] });
  if (!textVerified) {
    for (const r of scrub.record.roles) r.duties = [];
    scrub.record.qualifications = [];
  }

  // 3. facts worked out by code
  const f = facts.buildFacts(scrub.record, cfg, now);
  const summary = factSummary(f);
  const extraEvidence = textVerified ? {} : { dutiesDropped: 1 };
  if (f.rolesSent === 0) {
    const pc = f.parseConfidence;
    // a reader that listed jobs of which none is usable (all in the future, all blank) has failed: that is not an empty profile
    const listedJobs = Array.isArray(scrub.record.roles) && scrub.record.roles.length > 0;
    if (textChars !== null && textChars < minChars) return done({ decision: 'unreadable', lane: 'unreadable', reasonCodes: ['unreadable_too_little_text'], ...summary });
    if (pc === null || pc < cfg.evidence.emptyProfileMinParse || listedJobs) return done({ decision: 'unreadable', lane: 'unreadable', reasonCodes: ['unreadable_no_work_history'], ...summary });
    const dec = gate.evaluate({ facts: f, level: 'unknown', answers: null, cfg });
    return done({ decision: dec.decision, lane: 'facts', forced: dec.forced, confidence: dec.confidence, pReject: dec.pReject, reasonCodes: dec.reasonCodes, evidence: { ...dec.evidence, ...extraEvidence }, ...summary });
  }

  // 4. what Jev is asked
  const state = Q.buildState(cfg, searchRole, f);
  const questions = Q.buildQuestions(cfg, f.rolesSent);
  const shape = Q.expectedShape(questions);
  if (!Q.sizeCheck(state, questions).ok) return done({ decision: 'review', lane: 'fallback', reasonCodes: ['answers_invalid'], ...summary });
  const qhash = Q.questionSetHash(cfg, questions);
  const answersCache = ctx.answersCache || new cache.AnswersCache({ ttlSec: cfg.cache.answersTtlSec, maxEntries: cfg.cache.maxEntries });
  const levelStore = ctx.levelStore || new cache.SearchLevels({ qhash: Q.questionSetHash(cfg, Q.buildSearchLevelRequest(cfg, '').questions), ttlSec: cfg.cache.searchLevelTtlSec });
  const jev = ctx.jev || new CvJev({ cfg, log });
  const signal = anySignal([ctx.signal, AbortSignal.timeout(cfg.jev.deadlineMs)]);
  const key = cache.answersKey(cfg.jev.model, qhash, state);

  const stored = answersCache.get(key);
  const mainCall = stored
    ? Promise.resolve({ ok: true, answers: stored.answers, meta: { model: stored.model }, cached: true })
    : ask(jev, { state, questions, shape }, cfg, signal, 'cv');
  const [lvl, main] = await Promise.all([resolveSearchLevel({ cfg, jev, searchRole, store: levelStore, signal, log }), mainCall]);
  const jevCalls = lvl.calls + (stored ? 0 : 1);

  if (!main.ok) {
    const streak = cache.recordStreak({ invalid: 1, successes: 0, max: cfg.jev.invalidStreakMax, ttlMs: cfg.jev.invalidStreakTtlSec * 1000 });
    if (streak.trip) throw unavailableFrom(main.refused ? { kind: 'transient', status: main.status || 400, message: `${streak.count} CVs in a row were refused by the gateway (HTTP ${main.status || 'error'})` } : { kind: 'transient', message: `${streak.count} CVs in a row got answers that could not be used` }, 'cv');
    if (main.refused) log(`WARN Jev refused the request (HTTP ${main.status || 'error'}); this CV takes the fallback lane`);
    const refusal = main.refused ? { requestRefused: main.status || 1 } : {};
    return done({ decision: 'review', lane: 'fallback', reasonCodes: ['answers_invalid'], searchLevel: lvl.level, levelP: lvl.p, jevCalls, evidence: { ...extraEvidence, ...refusal }, ...summary });
  }
  if (!stored) {
    answersCache.put(key, { answers: main.answers, model: main.meta.model });
    cache.recordStreak({ invalid: 0, successes: 1, max: cfg.jev.invalidStreakMax, ttlMs: cfg.jev.invalidStreakTtlSec * 1000 });
  }

  // 5. the gate: forced choice at the one operating point
  let shaped;
  let dec;
  try {
    shaped = shapeAnswers(main.answers, f.rolesSent);
    dec = gate.evaluate({ facts: f, level: lvl.level, levelDist: lvl.dist, levelP: lvl.p, answers: shaped, cfg });
  } catch (e) {
    return done({ decision: 'review', lane: 'fallback', reasonCodes: ['answers_invalid'], searchLevel: lvl.level, levelP: lvl.p, jevCalls, evidence: extraEvidence, ...summary });
  }
  const common = {
    forced: dec.forced,
    confidence: dec.confidence,
    pReject: dec.pReject,
    evidence: { ...dec.evidence, ...extraEvidence },
    searchLevel: dec.level,
    levelP: lvl.p,
    model: main.meta.model || cfg.jev.model,
    cached: !!main.cached,
    jevCalls,
    answers: { ...gate.compactAnswers(shaped), levels: Object.fromEntries(Object.entries(lvl.dist).filter(([, p]) => p > 0)) },
    ...factSummary(f, dec.evidence.relevantMonths),
  };

  // 6. two independent signals of an attempt to steer the reviewer send the CV to the fallback lane
  const kw = injection.scan(injectionTexts(f), cfg.injectionRes);
  if (kw.hit && shaped.injection >= cfg.injection.probability) {
    return done({ ...common, decision: 'review', lane: 'fallback', jevDecision: dec.decision, reasonCodes: ['injection_flag'].concat(dec.reasonCodes) });
  }
  const codes = kw.hit || shaped.injection >= cfg.injection.probability ? dec.reasonCodes.concat('injection_signal') : dec.reasonCodes;
  return done({ ...common, decision: dec.decision, lane: 'jev', reasonCodes: codes });
}

module.exports = {
  screenCv,
  loadConfig: config.load,
  screenMode: config.screenMode,
  gate,
  config,
  facts,
  questions: Q,
  injection,
  shadow: require('./shadow'),
  ScreeningUnavailable,
  UsageError,
};
