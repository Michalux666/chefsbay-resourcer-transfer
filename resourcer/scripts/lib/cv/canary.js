'use strict';
// The CV canary: ONE small request made exactly the way the CV stage makes its own (the same client CvJev, the same question set built by
// questions.js for a one-job history, the same shape check), with invented text that names no real person, employer or role. The supervision
// deep check runs it while CV_SCREEN is 'on', so a screening halt raised by the CV stage only clears when the CV route itself answers; a
// healthy snippet route proves nothing about it (the routes are the same URL but the questions, the state and the failure modes differ).
// It never reads or writes a cache, a shadow row or a file, and it does not judge the answers: a usable answer is a working route.

const config = require('./config');
const facts = require('./facts');
const Q = require('./questions');
const { CvJev, ask } = require('./jev');
const { HttpFailure } = require('../screening/errors');

const SEARCHED = 'Canary Role';
// Invented. Nothing here is a person, an employer or a real job; it only has to look like one listed job with a duty line.
const RECORD = {
  roles: [{ title: 'Canary Post', employer: 'Canary Test Ltd', start: '2020-01', end: '2021-12', duties: ['canary test duty line'] }],
  qualifications: [],
  parseConfidence: 0.9,
};

/**
 * @param {{cfg?:object, timeoutMs?:number, jev?:object, now?:Date}} [o]  cfg: the CV configuration; jev: tests inject a client
 * @returns {Promise<{ok:true}|{ok:false, err:Error}>}  err is an HttpFailure (kind auth, credits, transient, request, invalid or config)
 *   so the health check maps it to its fixed reasons like any other gateway failure; it never throws
 */
async function cvCanary(o) {
  const opts = o || {};
  try {
    const cfg = opts.cfg || config.load();
    if (cfg.fault) return { ok: false, err: new HttpFailure('cvconfig', cfg.fault.detail) };
    const f = facts.buildFacts(RECORD, cfg, opts.now || new Date());
    const state = Q.buildState(cfg, SEARCHED, f);
    const questions = Q.buildQuestions(cfg, f.rolesSent);
    const shape = Q.expectedShape(questions);
    // one try, no retries: the check is run while halted and must be quick; the supervisor asks again a minute later
    const ccfg = { ...cfg, jev: { ...cfg.jev, maxAttempts: 1, maxInvalidAttempts: 1, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) } };
    const jev = opts.jev || new CvJev({ cfg: ccfg });
    const signal = AbortSignal.timeout(Math.max(1000, opts.timeoutMs || cfg.jev.deadlineMs));
    const r = await ask(jev, { state, questions, shape }, ccfg, signal, 'cv canary');
    if (r.ok) return { ok: true };
    // a refused request (400, 404, 422) or an answer that stays unusable: the CV route does not work for the stage's own request
    return { ok: false, err: new HttpFailure(r.refused ? 'request' : 'invalid', r.message || 'the CV canary answer could not be used', { status: r.status || null }) };
  } catch (e) {
    if (e && e.name === 'ScreeningUnavailable') {
      // unavailableFrom() lost the kind; the reason key is enough for the fixed reason strings
      const kind = e.reasonKey === 'auth' ? 'auth' : (e.reasonKey === 'credits' ? 'credits' : 'transient');
      return { ok: false, err: new HttpFailure(kind, e.detail || e.message, { status: e.status || null }) };
    }
    return { ok: false, err: e instanceof Error ? e : new Error(String(e)) };
  }
}

module.exports = { cvCanary, SEARCHED, RECORD };
