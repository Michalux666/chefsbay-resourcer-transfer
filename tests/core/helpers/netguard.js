'use strict';
// Preloaded (node --require) into every child process the core tests start, and required by
// the in-process tests: any attempt to reach a host other than loopback throws.
const http = require('http');
const https = require('https');

const ALLOWED = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function hostOf(arg) {
  if (typeof arg === 'string') {
    try { return new URL(arg).hostname; } catch { return arg; }
  }
  if (arg && typeof arg === 'object') {
    if (arg instanceof URL) return arg.hostname;
    if (typeof arg.url === 'string') return hostOf(arg.url);
    return arg.hostname || arg.host || 'localhost';
  }
  return 'localhost';
}

function check(arg) {
  const host = String(hostOf(arg)).replace(/:\d+$/, '');
  if (!ALLOWED.has(host)) {
    const err = new Error(`netguard: outbound request to "${host}" blocked in tests`);
    err.code = 'NETGUARD';
    throw err;
  }
}

function guardModule(mod) {
  for (const fn of ['request', 'get']) {
    const orig = mod[fn];
    mod[fn] = function guarded(...args) {
      check(args[0]);
      return orig.apply(this, args);
    };
  }
}

guardModule(http);
guardModule(https);

const realFetch = globalThis.fetch;
if (typeof realFetch === 'function' && !realFetch.__netguard) {
  const guardedFetch = function guardedFetch(input, init) {
    check(input);
    return realFetch.call(this, input, init);
  };
  guardedFetch.__netguard = true;
  globalThis.fetch = guardedFetch;
}

module.exports = { check, ALLOWED };
