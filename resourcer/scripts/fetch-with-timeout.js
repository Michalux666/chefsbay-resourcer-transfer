'use strict';

async function fetchWithTimeout(url, opts = {}, timeoutMs = 30000) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    return await fetch(url, { ...opts, signal });
  } catch (err) {
    if (timeoutController.signal.aborted && err?.name === 'AbortError') {
      const timeoutErr = new Error(`Fetch timeout after ${timeoutMs}ms for ${url}`);
      timeoutErr.code = 'FETCH_TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchWithTimeout };
