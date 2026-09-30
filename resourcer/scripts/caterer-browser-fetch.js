#!/usr/bin/env node
'use strict';
/**
 * caterer-browser-fetch.js
 *
 * Proxies HTTP(S) requests to Caterer THROUGH the agent-browser session instead of node/undici fetch.
 *
 * Why: since 2026-06-01 the Caterer unlock / CV-download endpoints block non-browser HTTP clients (node
 * fetch hangs, node https/curl get 302 -> /Error): WAF or bot-mitigation triggered by a high-volume unlock
 * burst. The logged-in browser (same origin, real session, browser TLS fingerprint) is not blocked.
 *
 * The fetch runs inside the browser page via `eval`, so the browser must already be signed in and on a
 * recruiter.caterer.com page (the scrape keeps it there during the unlock/download passes).
 *
 *   browserFetchText(url, timeoutMs, opts)    -> { status, body }                         (unlock, JSON/text)
 *   browserFetchBinary(url, timeoutMs, opts)  -> { status, contentType, contentDisposition, buffer }  (CVs)
 * Both resolve { status: 0, error } on failure ({..., timedOut: true} when the wrapper timed out).
 *
 * opts.singleAttempt: for state-changing requests (unlock). The wrapper then never lets the CLI re-send the
 * command after its 30 s read timeout (that could unlock twice); the in-page fetch is aborted a few seconds
 * before that limit, so a slow request fails cleanly instead of being retried.
 * Every in-page fetch has an abort timer so a hung request cannot keep the single browser daemon busy.
 */
const browser = require('./lib/browser');
const env = require('./lib/env');

const { SITE } = browser;

// Without no-store a CV or unlock reply stays in the warm browser's disk cache; RESOURCER_FETCH_CACHE=default restores the plain request.
function cacheOption() {
  return env.get('RESOURCER_FETCH_CACHE', 'no-store') === 'default' ? '' : "cache:'no-store',";
}

// Ensure the page origin is recruiter.caterer.com so the proxied fetch is same-origin (credentials +
// readable response). Used by the CV download path, where the tab may have been left elsewhere. NOT used by
// the unlock path: phase 1 keeps the browser on the results page and navigating would lose the search.
async function ensureCatererOrigin() {
  const u = await browser.getUrlResult({ timeoutMs: 15000 });
  if (!u.ok) return;
  if (u.url.includes('recruiter.caterer.com')) return;
  const o = await browser.open(SITE.HOME_URL, { timeoutMs: 30000 });
  if (o.ok) await browser.waitNetworkIdle({ timeoutMs: 30000 });
}

function firstLine(s) { return String(s || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || ''; }

// Run a JS expression in the caterer session and return the parsed value. The injected JS must return
// JSON.stringify(obj); this unwraps the CLI's quoted-string emission back to the object.
async function runBrowserEval(js, timeoutMs, opts) {
  const o = opts || {};
  const r = await browser.evalJs(js, { timeoutMs: timeoutMs + 5000, singleAttempt: !!o.singleAttempt, label: o.label || 'browser-fetch eval' });
  if (!r.ok) {
    const res = { status: 0, error: 'browser eval failed: ' + firstLine(r.out) };
    if (r.timedOut) res.timedOut = true;
    return res;
  }
  return browser.parseEvalJson(r.stdout);
}

// Abort the in-page fetch before the wrapper gives up. For single-attempt calls that is also before the
// CLI's own read timeout.
function pageAbortMs(timeoutMs, opts) {
  if (opts && opts.singleAttempt) return Math.max(1000, Math.min(timeoutMs, browser.ipcSafeMs() - 3000));
  return timeoutMs;
}

function buildTextFetchJs(url, abortMs) {
  return '(async function(){var ac=new AbortController();var tm=setTimeout(function(){ac.abort();},' + Number(abortMs) + ');try{'
    + 'var r=await fetch(' + JSON.stringify(url) + ",{credentials:'include'," + cacheOption() + "headers:{Accept:'application/json, */*'},signal:ac.signal});"
    + 'var t=await r.text();clearTimeout(tm);'
    + 'return JSON.stringify({status:r.status,body:t});'
    + "}catch(e){clearTimeout(tm);return JSON.stringify({status:0,error:(e&&e.name==='AbortError')?'in-page fetch timed out':String(e&&e.message||e)});}})()";
}

function buildBinaryFetchJs(url, abortMs) {
  return '(async function(){var ac=new AbortController();var tm=setTimeout(function(){ac.abort();},' + Number(abortMs) + ');try{'
    + 'var r=await fetch(' + JSON.stringify(url) + ",{credentials:'include'," + cacheOption() + "headers:{Accept:'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*'},signal:ac.signal});"
    + "var ct=r.headers.get('content-type')||'';var cd=r.headers.get('content-disposition')||'';"
    + 'var buf=await r.arrayBuffer();clearTimeout(tm);var bytes=new Uint8Array(buf);'
    + "var bin='';var chunk=8192;for(var i=0;i<bytes.length;i+=chunk){bin+=String.fromCharCode.apply(null,bytes.subarray(i,i+chunk));}"
    + 'return JSON.stringify({status:r.status,contentType:ct,contentDisposition:cd,base64:btoa(bin),size:bytes.length});'
    + "}catch(e){clearTimeout(tm);return JSON.stringify({status:0,error:(e&&e.name==='AbortError')?'in-page fetch timed out':String(e&&e.message||e)});}})()";
}

async function browserFetchText(url, timeoutMs = 40000, opts) {
  const abortMs = pageAbortMs(timeoutMs, opts);
  return runBrowserEval(buildTextFetchJs(url, abortMs), abortMs, opts);
}

async function browserFetchBinary(url, timeoutMs = 60000, opts) {
  await ensureCatererOrigin();
  const abortMs = pageAbortMs(timeoutMs, opts);
  const res = await runBrowserEval(buildBinaryFetchJs(url, abortMs), abortMs, opts);
  if (res && res.base64 != null) {
    res.buffer = Buffer.from(res.base64, 'base64');
    delete res.base64;
  }
  return res;
}

module.exports = { browserFetchText, browserFetchBinary, ensureCatererOrigin, runBrowserEval, buildTextFetchJs, buildBinaryFetchJs };
