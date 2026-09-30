'use strict';
// Jev (TypeSafe System One) through the AI Gateway: POST {origin}/typesafe/v1/systemone, the same route, key and retry
// behaviour as the snippet screening client (scripts/lib/screening/http.js does the retries: network errors, timeouts,
// 408, 429 and 5xx with backoff and Retry-After; 400, 401, 402, 403, 404 and 422 are never retried).
// One request per CV, all questions in it (they are answered in parallel and in isolation). Only the model typesafe-ai/jev
// is ever named. A 2xx answer that cannot be used is an INVALID answer (the caller asks again, then settles by policy);
// it is never turned into a reject here.

const env = require('../env');
const http = require('../screening/http');
const { HttpFailure, ScreeningUnavailable, reasonKeyOf } = require('../screening/errors');

const EPS = 0.02;
const isNum = x => typeof x === 'number' && Number.isFinite(x);
const clamp01 = x => Math.min(1, Math.max(0, x));

class InvalidAnswers extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'InvalidAnswers';
    this.code = code || 'invalid';
  }
}

function readProbs(a, optionKeys, name) {
  const p = a && a.probabilities;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new InvalidAnswers(`${name}: probabilities missing`, 'no_probs');
  const out = {};
  let matched = 0;
  let sum = 0;
  for (const k of optionKeys) {
    const v = p[k];
    if (v === undefined || v === null) { out[k] = 0; continue; }
    if (!isNum(v) || v < -EPS || v > 1 + EPS) throw new InvalidAnswers(`${name}: bad probability`, 'bad_prob');
    out[k] = clamp01(v);
    matched++;
    sum += out[k];
  }
  if (matched === 0) throw new InvalidAnswers(`${name}: probabilities do not match the options`, 'no_probs');
  if (sum < 0.5 || sum > 1.5) throw new InvalidAnswers(`${name}: probabilities do not sum to about 1`, 'bad_sum');
  return out;
}

function argmax(p) {
  let best = null;
  for (const [k, v] of Object.entries(p)) if (best === null || v > p[best]) best = k;
  return best;
}

/**
 * Validates a systemone response against the questions that were asked. Missing or malformed answers throw InvalidAnswers.
 * @returns {{answers:Object<string, number|{p:object, top:string}>, model:string}}
 */
function parseAnswers(json, shape) {
  if (!json || typeof json !== 'object' || !json.answers || typeof json.answers !== 'object') throw new InvalidAnswers('no answers in response', 'no_answers');
  if (typeof json.model === 'string' && json.model && !/jev/i.test(json.model)) throw new InvalidAnswers('answered by a non-Jev model', 'not_jev');
  const out = {};
  for (const [key, spec] of Object.entries(shape)) {
    const a = json.answers[key];
    if (!a || typeof a !== 'object') throw new InvalidAnswers(`${key}: answer missing`, 'missing');
    if (spec.type === 'noul') {
      if (!isNum(a.noul) || a.noul < -EPS || a.noul > 1 + EPS) throw new InvalidAnswers(`${key}: bad noul value`, 'bad_noul');
      out[key] = clamp01(a.noul);
    } else if (spec.type === 'choice') {
      const p = readProbs(a, spec.options, key);
      if (typeof a.choice !== 'string' || !spec.options.includes(a.choice)) throw new InvalidAnswers(`${key}: choice is not one of the options`, 'bad_choice');
      out[key] = { p, top: argmax(p) };
    } else {
      const keys = Array.from({ length: spec.levels }, (_, i) => String(i));
      out[key] = { p: readProbs(a, keys, key), top: null };
      out[key].top = argmax(out[key].p);
    }
  }
  return { answers: out, model: typeof json.model === 'string' ? json.model : '' };
}

function apiKey() {
  const k = env.get('AI_GATEWAY_API_KEY');
  return k ? String(k).trim() : '';
}

class CvJev {
  /**
   * @param {{cfg:object, log?:(line:string)=>void, rng?:()=>number}} deps
   */
  constructor(deps) {
    this.cfg = deps.cfg;
    this.log = deps.log || (() => {});
    this.rng = deps.rng;
  }

  /**
   * @param {{state:object, questions:object, shape:object, signal?:AbortSignal}} p
   * @returns {Promise<{ok:true, answers:object, meta:object}|{ok:false, kind:string, code:string, message:string, status?:number}>}
   */
  async evaluate(p) {
    const cfg = this.cfg;
    const key = apiKey();
    if (!key) return { ok: false, kind: 'auth', code: 'no_key', message: 'AI_GATEWAY_API_KEY is not set' };
    const body = { model: cfg.jev.model, state: p.state, questions: p.questions };
    if (cfg.jev.zeroDataRetention) body.providerOptions = { gateway: { zeroDataRetention: true } };

    let res;
    try {
      res = await http.request('POST', `${cfg.gateway.origin}/typesafe/v1/systemone`, {
        headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'chefsbay-resourcer-cv/1' },
        body,
        timeoutMs: cfg.jev.timeoutMs,
        maxAttempts: cfg.jev.maxAttempts,
        retry: cfg.retry,
        signal: p.signal,
        log: this.log,
        label: 'Jev',
        rng: this.rng,
      });
    } catch (err) {
      if (err instanceof HttpFailure) {
        return { ok: false, kind: err.kind, code: `http_${err.status || err.kind}`, message: err.message, status: err.status };
      }
      throw err;
    }
    try {
      const parsed = parseAnswers(res.json, p.shape);
      const rid = res.headers && res.headers.get ? res.headers.get('x-typesafe-request-id') : null;
      return { ok: true, answers: parsed.answers, meta: { model: parsed.model || cfg.jev.model, requestId: rid || null, ms: res.ms, attempts: res.attempts } };
    } catch (err) {
      if (err instanceof InvalidAnswers) return { ok: false, kind: 'invalid', code: err.code, message: err.message };
      throw err;
    }
  }
}

/** The failure of a request as the error every caller treats as "Jev is unavailable" (the CLI turns it into API_UNAVAILABLE and exit 3). */
function unavailableFrom(failure, label) {
  const detail = env.redact(String(failure.message || failure.code || 'unavailable')).replace(/\s+/g, ' ').slice(0, 160);
  return new ScreeningUnavailable(`${label ? label + ': ' : ''}${detail}`, { reasonKey: reasonKeyOf(failure), status: failure.status || null });
}

/**
 * One logical request: asked again when the answer is unusable (cfg.jev.maxInvalidAttempts), never retried for the reasons the
 * transport does not retry. Outages (network, timeout, 5xx after the retries, 429, 401, 402, 403, the deadline) throw
 * ScreeningUnavailable. An answer that stays unusable, and a request the gateway refuses as malformed (400, 404, 422: the kind
 * 'request'; asking again cannot change it), is returned as {ok:false, kind:'invalid'} for the caller to settle for THIS CV
 * (the fallback lane); a run of such CVs is escalated to an outage by the streak guard of the caller, never one CV at a time.
 * @returns {Promise<{ok:true, answers:object, meta:object}|{ok:false, kind:'invalid', code:string, message:string, refused?:boolean, status?:number|null}>}
 */
async function ask(jev, payload, cfg, signal, label) {
  let last = null;
  for (let attempt = 1; attempt <= cfg.jev.maxInvalidAttempts; attempt++) {
    const r = await jev.evaluate({ state: payload.state, questions: payload.questions, shape: payload.shape, signal });
    if (r.ok) return r;
    if (r.kind === 'request') return { ok: false, kind: 'invalid', code: 'refused', message: `the gateway refused the request (HTTP ${r.status || 'error'})`, refused: true, status: r.status || null };
    if (r.kind !== 'invalid') throw unavailableFrom(r.kind === 'aborted' ? { kind: 'transient', message: 'the time allowed for Jev ran out' } : r, label);
    last = r;
  }
  return last || { ok: false, kind: 'invalid', code: 'no_attempt', message: 'no attempt was made' };
}

module.exports = { CvJev, parseAnswers, InvalidAnswers, apiKey, ask, unavailableFrom };
