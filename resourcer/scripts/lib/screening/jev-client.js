'use strict';

const http = require('./http');
const { HttpFailure, InvalidAnswer } = require('./errors');
const { apiKey } = require('./llm-client');
const Q = require('./jev-questions');
const criteriaLib = require('./criteria');
const { cardFacts } = require('./card');

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

// a missing, malformed or sentinel answer is INVALID: the caller sends the card to review, never to reject
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

const roleKey = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

class JevClient {
  constructor(deps) {
    this.cfg = deps.cfg;
    this.log = deps.log || (() => {});
    this.rng = deps.rng;
    this.roles = new Map();
  }

  async post(body, p, label) {
    const cfg = this.cfg;
    try {
      const res = await http.request('POST', `${cfg.gateway.origin}/typesafe/v1/systemone`, {
        headers: { Authorization: `Bearer ${apiKey()}`, 'User-Agent': 'chefsbay-resourcer-screening/1' },
        body,
        timeoutMs: p.timeoutMs || cfg.jev.timeoutMs,
        maxAttempts: p.maxAttempts || cfg.jev.maxAttempts,
        retry: cfg.retry,
        signal: p.signal,
        log: this.log,
        label: label || 'Jev',
        rng: this.rng,
      });
      return { res };
    } catch (err) {
      if (err instanceof HttpFailure && err.kind !== 'aborted') {
        return { fail: { ok: false, kind: err.kind, code: `http_${err.status || err.kind}`, message: err.message, status: err.status, attempts: err.attempts } };
      }
      throw err;
    }
  }

  async askRole(criteria, p) {
    const questions = Q.buildRoleQuestions(criteria);
    const body = { model: this.cfg.jev.model, state: Q.buildRoleState(p.searchRole, criteria), questions };
    if (this.cfg.jev.zeroDataRetention) body.providerOptions = { gateway: { zeroDataRetention: true } };
    const r = await this.post(body, p, 'Jev role');
    if (r.fail) return r.fail;
    try {
      const parsed = parseAnswers(r.res.json, Q.expectedShape(questions));
      return { ok: true, answers: parsed.answers };
    } catch (err) {
      if (err instanceof InvalidAnswer) return { ok: false, kind: 'invalid', code: err.code, message: err.message, attempts: r.res.attempts };
      throw err;
    }
  }

  // one request per distinct search title for the life of the client; a failure is never cached
  roleProfile(criteria, p) {
    const key = roleKey(p.searchRole);
    let pending = this.roles.get(key);
    if (!pending) {
      pending = this.askRole(criteria, p).then(r => { if (!r.ok) this.roles.delete(key); return r; }, e => { this.roles.delete(key); throw e; });
      this.roles.set(key, pending);
    }
    return pending;
  }

  async evaluate(p) {
    const cfg = this.cfg;
    const loaded = criteriaLib.get();
    if (!loaded.ok || loaded.decisionErrors.length) {
      const why = loaded.ok ? loaded.decisionErrors : loaded.errors;
      return { ok: false, kind: 'config', code: 'criteria_invalid', message: `screening-criteria.json: ${why.join('; ').slice(0, 200)}`, attempts: 0 };
    }
    const criteria = loaded.criteria;
    const built = Q.buildRequest({
      searchRole: p.searchRole, snippet: p.snippet, realJobTitle: p.realJobTitle, stage: p.stage, model: cfg.jev.model,
      zdr: cfg.jev.zeroDataRetention, maxChars: cfg.jev.maxSnippetChars, criteria, asOf: p.asOf,
    });

    const role = await this.roleProfile(criteria, p);
    if (!role.ok) return role;
    const res = await this.post(built.body, p, 'Jev');
    if (res.fail) return res.fail;

    try {
      const parsed = parseAnswers(res.res.json, Q.expectedShape(built.questions));
      const rid = res.res.headers && res.res.headers.get ? res.res.headers.get('x-typesafe-request-id') : null;
      return {
        ok: true,
        answers: { ...parsed.answers, ...role.answers, ...cardFacts(built.card) },
        meta: {
          model: parsed.model || cfg.jev.model,
          requestId: rid || null,
          usage: res.res.json.usage || null,
          ms: res.res.ms,
          attempts: res.res.attempts,
          qhash: built.qh,
          hasRealTitle: built.hasRealTitle,
        },
      };
    } catch (err) {
      if (err instanceof InvalidAnswer) return { ok: false, kind: 'invalid', code: err.code, message: err.message, attempts: res.res.attempts };
      throw err;
    }
  }
}

module.exports = { JevClient, parseAnswers, pickConfidence };
