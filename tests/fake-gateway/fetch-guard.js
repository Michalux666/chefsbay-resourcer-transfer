'use strict';
// Test-only network guard. Load with `require` in a test file or via NODE_OPTIONS=--require so a
// screening test can never reach the internet: fetch() and net sockets throw for any host other than
// the loopback address. Zero dependencies.

const net = require('node:net');

const ALLOWED = new Set(['127.0.0.1', 'localhost', '::1']);

if (!globalThis.__screeningFetchGuard) {
  globalThis.__screeningFetchGuard = true;

  const realFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    let url = '';
    try { url = typeof input === 'string' ? input : (input && input.url) || String(input); } catch (e) { url = ''; }
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { throw new Error(`fetch guard: unparseable URL ${String(url).slice(0, 60)}`); }
    if (!ALLOWED.has(host)) throw new Error(`fetch guard: blocked request to ${host}`);
    return realFetch.call(this, input, init);
  };

  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const a = Array.isArray(args[0]) ? args[0][0] : args[0];
    let host = null;
    if (a && typeof a === 'object') host = a.path ? null : (a.host || a.hostname || 'localhost');
    else if (typeof a === 'number') host = typeof args[1] === 'string' ? args[1] : 'localhost';
    if (host !== null && !ALLOWED.has(String(host))) throw new Error(`fetch guard: blocked socket to ${host}`);
    return realConnect.apply(this, args);
  };
}

module.exports = { ALLOWED };
