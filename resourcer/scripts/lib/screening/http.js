'use strict';
// One HTTP helper for both gateway clients: plain fetch, per-attempt timeout, retry with backoff on
// network errors / timeouts / 408 / 429 / 5xx (Retry-After honoured), never retry 400/401/402/403/404/422.
// Errors are HttpFailure objects with a `kind` (see errors.js), never message-matched.

const env = require('../env');
const { HttpFailure } = require('./errors');

function bodyExcerpt(text) {
  return env.redact(String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200));
}

function retryAfterMs(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const ms = Number(headers.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms >= 0 && headers.get('retry-after-ms') !== null) return ms;
  const raw = headers.get('retry-after');
  if (raw === null || raw === undefined || raw === '') return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const d = Date.parse(raw);
  return Number.isNaN(d) ? null : Math.max(0, d - Date.now());
}

function abortedError() {
  return new HttpFailure('aborted', 'aborted by caller');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortedError());
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    function onAbort() { clearTimeout(t); reject(abortedError()); }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function describeNetworkError(err, timeoutMs) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return `timeout after ${timeoutMs}ms`;
  const code = err && err.cause && (err.cause.code || err.cause.message);
  return `network error: ${env.redact(String(code || (err && err.message) || err)).slice(0, 120)}`;
}

/**
 * @param {string} method
 * @param {string} url
 * @param {{headers?:object, body?:object, timeoutMs:number, maxAttempts:number,
 *          retry:{baseMs:number,capMs:number,maxRetryAfterMs:number}, signal?:AbortSignal,
 *          log?:(line:string)=>void, label?:string, rng?:()=>number}} opts
 * @returns {Promise<{status:number, headers:Headers, json:any, text:string, ms:number, attempts:number}>}
 */
async function request(method, url, opts) {
  const o = opts;
  const log = o.log || (() => {});
  const label = o.label || 'API';
  const rng = o.rng || Math.random;
  const max = Math.max(1, o.maxAttempts || 1);
  const t00 = Date.now();
  // a private dependent signal per call: many concurrent calls never pile listeners onto the shared one
  const outer = o.signal ? AbortSignal.any([o.signal]) : null;

  for (let attempt = 1; ; attempt++) {
    if (outer && outer.aborted) throw abortedError();
    const signals = [AbortSignal.timeout(o.timeoutMs)];
    if (outer) signals.push(outer);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

    let failure = null;
    let delayMs = null;
    try {
      const res = await globalThis.fetch(url, {
        method,
        signal,
        headers: { 'Content-Type': 'application/json', ...(o.headers || {}) },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      });
      const text = await res.text();
      if (res.ok) {
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = undefined; }
        if (json !== undefined) return { status: res.status, headers: res.headers, json, text, ms: Date.now() - t00, attempts: attempt };
        failure = new HttpFailure('transient', `HTTP ${res.status} with a non-JSON body: ${bodyExcerpt(text).slice(0, 80)}`, { status: res.status, attempts: attempt });
      } else if (res.status === 401 || res.status === 403) {
        throw new HttpFailure('auth', `HTTP ${res.status}: ${bodyExcerpt(text)}`, { status: res.status, attempts: attempt });
      } else if (res.status === 402) {
        throw new HttpFailure('credits', `HTTP 402: ${bodyExcerpt(text)}`, { status: 402, attempts: attempt });
      } else if (res.status === 408 || res.status === 429 || res.status >= 500) {
        const ra = retryAfterMs(res.headers);
        failure = new HttpFailure('transient', `HTTP ${res.status}: ${bodyExcerpt(text)}`, { status: res.status, attempts: attempt, retryAfterMs: ra });
        if (ra !== null) delayMs = Math.min(ra, o.retry.maxRetryAfterMs);
      } else {
        throw new HttpFailure('request', `HTTP ${res.status}: ${bodyExcerpt(text)}`, { status: res.status, attempts: attempt });
      }
    } catch (err) {
      if (err instanceof HttpFailure) {
        if (err.kind !== 'transient') throw err;
        failure = err;
      } else if (outer && outer.aborted) {
        throw abortedError();
      } else {
        failure = new HttpFailure('transient', describeNetworkError(err, o.timeoutMs), { attempts: attempt });
      }
    }

    if (attempt >= max) {
      log(`WARN ${label} attempt ${attempt}/${max} failed: ${failure.message}.`);
      failure.attempts = attempt;
      throw failure;
    }
    if (delayMs === null) delayMs = Math.min(o.retry.capMs, o.retry.baseMs * Math.pow(2, attempt - 1)) * (0.75 + rng() * 0.25);
    log(`WARN ${label} attempt ${attempt}/${max} failed: ${failure.message}. Retrying in ${Math.round(delayMs / 100) / 10}s...`);
    await sleep(delayMs, outer);
  }
}

module.exports = { request, sleep, retryAfterMs, bodyExcerpt };
