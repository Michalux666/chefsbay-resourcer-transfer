'use strict';

// Normalises whatever shape lib/browser returns ({ok,out,timedOut,code} or {success,output,exitCode}) into one.
function normResult(r) {
  if (typeof r === 'string') return { ok: true, timedOut: false, out: r, code: 0 };
  if (!r || typeof r !== 'object') return { ok: false, timedOut: false, out: '', code: null };
  return {
    ok: r.ok !== undefined ? !!r.ok : !!r.success,
    timedOut: !!r.timedOut,
    out: String(r.out !== undefined ? r.out : (r.output !== undefined ? r.output : '')),
    code: r.code !== undefined ? r.code : (r.exitCode !== undefined ? r.exitCode : null),
  };
}

// Wraps lib/browser (DESIGN 5.1) with the per-call timeouts and the TIMEOUT log line of the legacy helper.
function createBrowser(lib, out, cfg) {
  const t = cfg.browserMs;

  async function call(label, ms, fn) {
    let r;
    try {
      r = normResult(await fn());
    } catch (e) {
      r = { ok: false, timedOut: false, out: `Error: ${e.message}`, code: null };
    }
    if (r.timedOut) out(`TIMEOUT: ${label} exceeded ${Math.round(ms / 1000)}s`);
    return r;
  }

  const waitFn = (ms) => (typeof lib.waitNetworkIdle === 'function'
    ? lib.waitNetworkIdle({ timeoutMs: ms })
    : lib.waitLoad('networkidle', { timeoutMs: ms }));

  return {
    open: (url, label) => call(label || 'open page', t.open, () => lib.open(url, { timeoutMs: t.open })),
    waitNetworkIdle: (label) => call(label || 'wait networkidle', t.wait, () => waitFn(t.wait)),
    evalB64: (b64, label, ms) => call(label || 'eval extract', ms || t.eval, () => lib.evalB64(b64, { timeoutMs: ms || t.eval })),
    // '' on timeout or failure, like the legacy "timeout is treated as empty" rule.
    async getUrl(label) {
      let r;
      try {
        r = await lib.getUrl({ timeoutMs: t.url });
      } catch (e) {
        return '';
      }
      if (typeof r === 'string') return r.trim();
      const n = normResult(r);
      if (n.timedOut) { out(`TIMEOUT: ${label || 'get url'} exceeded ${Math.round(t.url / 1000)}s`); return ''; }
      const lines = n.out.split('\n').map((l) => l.trim()).filter(Boolean);
      return lines.length ? lines[lines.length - 1] : '';
    },
    stateSave: (file, label) => call(label || 'session state save', t.stateSave, () => lib.stateSave(file, { timeoutMs: t.stateSave })),
  };
}

module.exports = { createBrowser, normResult };
