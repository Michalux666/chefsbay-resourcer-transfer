'use strict';
// Preloaded with --require: any fetch to a host other than loopback throws (DESIGN 9, zero network in tests).
const real = globalThis.fetch;
globalThis.fetch = function guardedFetch(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  let host = '';
  try { host = new URL(url).hostname; } catch (e) { host = ''; }
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
    throw new Error(`network access blocked in tests: ${host || url}`);
  }
  return real(input, init);
};
