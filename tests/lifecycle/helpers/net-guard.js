'use strict';
// Zero-network rule: fetch may only reach 127.0.0.1.
const realFetch = globalThis.fetch;
globalThis.fetch = function guardedFetch(input, init) {
  const raw = typeof input === 'string' ? input : (input && input.url) || String(input);
  const host = new URL(raw).hostname;
  if (host !== '127.0.0.1') throw new Error(`network guard: refusing to reach ${host}`);
  return realFetch(input, init);
};
module.exports = { realFetch };
