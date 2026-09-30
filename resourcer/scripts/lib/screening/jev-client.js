'use strict';
// Jev (TypeSafe System One) through the AI Gateway: POST {origin}/typesafe/v1/systemone.
// One request per candidate, all atomic questions in it. Defensive by design: the docs leave some
// response details unverified, so
//   - confidence is read from the answer, else from provider metadata, else computed from the
//     probabilities as (N*pmax-1)/(N-1);
//   - any missing, malformed or sentinel answer (probabilities absent) is an INVALID answer, which
//     the caller treats as "review", never as a reject;
//   - only the TypeSafe-compatible response shape is parsed (noul / choice / score), never the
//     Vercel-native /v1/evaluate one.

const http = require('./http');
const { HttpFailure, InvalidAnswer } = require('./errors');
const { apiKey } = require('./llm-client');
const Q = require('./jev-questions');

const EPS = 0.02;

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function clamp01(x) { return Math.min(1, Math.max(0, x)); }

function readProbs(a, optionKeys, name) {
  const p = a && a.probabilities;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new InvalidAnswer(`${name}: probabilities missing`, 'no_probs');
  const out = {};
  let matched = 0;
  let sum = 0;
  for (const k of optionKeys) {
    const v = p[k];
    if (v === undefined || v === null) { out[k] = 0; continue; }
    if (!isNum(v) || v < -EPS || v > 1 + EPS) throw new InvalidAnswer(`${name}: bad probability`, 'bad_prob');
    out[k] = clamp01(v);
    matched++;
    sum += out[k];
  }
  if (matched === 0) throw new InvalidAnswer(`${name}: probabilities do not match the options`, 'no_probs');
  if (sum < 0.5 || sum > 1.5) throw new InvalidAnswer(`${name}: probabilities do not sum to about 1`, 'bad_sum');
  return out;
}

function pickConfidence(json, key, a, n, pmax) {
  if (isNum(a && a.confidence)) return { value: clamp01(a.confidence), from: 'answer' };
  const md = (json && (json.providerMetadata || json.provider_metadata)) || null;
  const c = md && md.typesafe && md.typesafe.confidence && md.typesafe.confidence[key];
  if (isNum(c)) return { value: clamp01(c), from: 'metadata' };
  const computed = n > 1 ? clamp01((n * pmax - 1) / (n - 1)) : 1;
  return { value: computed, from: 'computed' };
}

function argmax(p) {
  let best = null;
  for (const [k, v] of Object.entries(p)) if (best === null || v > p[best]) best = k;
  return best;
}

/**
 * Validate and normalise a systemone response.
 * @returns {{answers:Object<string,any>, model:string}}
 * @throws {InvalidAnswer}
 */
function parseAnswers(json, shape) {
  if (!json || typeof json !== 'object' || !json.answers || typeof json.answers !== 'object') throw new InvalidAnswer('no answers in response', 'no_answers');
  if (typeof json.model === 'string' && json.model && !/jev/i.test(json.model)) throw new InvalidAnswer('answered by a non-Jev model', 'not_jev');
  const out = {};
  for (const [key, spec] of Object.entries(shape)) {
    const a = json.answers[key];
    if (!a || typeof a !== 'object') throw new InvalidAnswer(`${key}: answer missing`, 'missing');
    if (spec.type === 'noul') {
      if (!isNum(a.noul) || a.noul < -EPS || a.noul > 1 + EPS) throw new InvalidAnswer(`${key}: bad noul value`, 'bad_noul');
      out[key] = clamp01(a.noul);
    } else if (spec.type === 'choice') {
      const p = readProbs(a, spec.options, key);
      if (typeof a.choice !== 'string' || !spec.options.includes(a.choice)) throw new InvalidAnswer(`${key}: choice is not one of the options`, 'bad_choice');
      const pmax = Math.max(...Object.values(p));
      const conf = pickConfidence(json, key, a, spec.options.length, pmax);
      out[key] = { p, choice: a.choice, top: argmax(p), confidence: conf.value, confidenceFrom: conf.from };
    } else {
      const keys = Array.from({ length: spec.levels }, (_, i) => String(i));
      const p = readProbs(a, keys, key);
      const pmax = Math.max(...Object.values(p));
      const conf = pickConfidence(json, key, a, spec.levels, pmax);
      out[key] = { p, top: argmax(p), confidence: conf.value, confidenceFrom: conf.from };
    }
  }
  return { answers: out, model: typeof json.model === 'string' ? json.model : '' };
}

class JevClient {
  constructor(deps) {
    this.cfg = deps.cfg;
    this.log = deps.log || (() => {});
    this.rng = deps.rng;
  }

  /**
   * @param {{searchRole:string, searchTier:number, snippet:string, realJobTitle?:string, stage:1|2,
   *          signal?:AbortSignal, maxAttempts?:number, timeoutMs?:number}} p  (snippet and title already redacted)
   * @returns {Promise<{ok:true, answers:object, meta:object}|{ok:false, kind:string, code:string, message:string}>}
   */
  async evaluate(p) {
    const cfg = this.cfg;
    const snippet = String(p.snippet || '').slice(0, cfg.jev.maxSnippetChars);
    const hasRealTitle = !!(p.stage === 2 && p.realJobTitle);
    const questions = Q.buildQuestions({ stage: p.stage, searchTier: p.searchTier, hasRealTitle });
    const state = Q.buildState({ searchRole: p.searchRole, searchTier: p.searchTier, snippet, realJobTitle: hasRealTitle ? p.realJobTitle : '' });
    const body = { model: cfg.jev.model, state, questions };
    if (cfg.jev.zeroDataRetention) body.providerOptions = { gateway: { zeroDataRetention: true } };

    let res;
    try {
      res = await http.request('POST', `${cfg.gateway.origin}/typesafe/v1/systemone`, {
        headers: { Authorization: `Bearer ${apiKey()}`, 'User-Agent': 'chefsbay-resourcer-screening/1' },
        body,
        timeoutMs: p.timeoutMs || cfg.jev.timeoutMs,
        maxAttempts: p.maxAttempts || cfg.jev.maxAttempts,
        retry: cfg.retry,
        signal: p.signal,
        log: this.log,
        label: 'Jev',
        rng: this.rng,
      });
    } catch (err) {
      if (err instanceof HttpFailure && err.kind !== 'aborted') {
        return { ok: false, kind: err.kind, code: `http_${err.status || err.kind}`, message: err.message, status: err.status, attempts: err.attempts };
      }
      throw err;
    }

    try {
      const parsed = parseAnswers(res.json, Q.expectedShape(questions));
      const rid = res.headers && res.headers.get ? res.headers.get('x-typesafe-request-id') : null;
      return {
        ok: true,
        answers: parsed.answers,
        meta: {
          model: parsed.model || cfg.jev.model,
          requestId: rid || null,
          usage: res.json.usage || null,
          ms: res.ms,
          attempts: res.attempts,
          qhash: Q.questionSetHash(questions),
          hasRealTitle,
        },
      };
    } catch (err) {
      if (err instanceof InvalidAnswer) return { ok: false, kind: 'invalid', code: err.code, message: err.message, attempts: res.attempts };
      throw err;
    }
  }
}

module.exports = { JevClient, parseAnswers, pickConfidence };
