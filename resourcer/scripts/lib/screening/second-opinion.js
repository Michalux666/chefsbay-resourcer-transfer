'use strict';
// Extension point (docs/SCREENING.md section 16.8): an optional second opinion for cards Jev could not decide, passed as
// createEngine(cfg, { secondOpinion }) in engine jev_only. No provider ships. Any failure of a provider means "no opinion": the review policy decides.

const TIMEOUT_MS = 30000;

/** @returns {{name:string, review:Function}|null} the provider when it has the right shape */
function validateProvider(p) {
  if (!p || typeof p !== 'object') return null;
  if (typeof p.name !== 'string' || !p.name.trim() || typeof p.review !== 'function') return null;
  return { name: p.name.trim().slice(0, 60), review: p.review.bind(p) };
}

/**
 * @param {{name:string, review:Function}} provider
 * @param {object} req
 * @param {{signal?:AbortSignal, timeoutMs?:number}} [opts]
 * @returns {Promise<{status:'ok', answer:{approved:boolean, reasonCode:string|null, confidence:number|null}}|{status:'none'|'error'|'invalid'}>}
 */
async function consult(provider, req, opts) {
  const o = opts || {};
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (o.signal) {
    if (o.signal.aborted) return { status: 'error' };
    o.signal.addEventListener('abort', onAbort, { once: true });
  }
  let timer = null;
  try {
    const timeout = new Promise((resolve) => { timer = setTimeout(() => { ac.abort(); resolve('timeout'); }, o.timeoutMs || TIMEOUT_MS); });
    const r = await Promise.race([Promise.resolve().then(() => provider.review(req, { signal: ac.signal })), timeout]);
    if (r === 'timeout') return { status: 'error' };
    if (r === null || r === undefined) return { status: 'none' };
    if (typeof r !== 'object' || typeof r.approved !== 'boolean') return { status: 'invalid' };
    const c = Number(r.confidence);
    return {
      status: 'ok',
      answer: {
        approved: r.approved,
        reasonCode: typeof r.reasonCode === 'string' ? r.reasonCode : null,
        confidence: r.confidence !== undefined && r.confidence !== null && Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : null,
      },
    };
  } catch (e) {
    return { status: 'error' };
  } finally {
    if (timer) clearTimeout(timer);
    if (o.signal) o.signal.removeEventListener('abort', onAbort);
  }
}

module.exports = { validateProvider, consult, TIMEOUT_MS };
