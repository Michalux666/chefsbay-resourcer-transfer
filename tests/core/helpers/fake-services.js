'use strict';
// Canned Zoho Recruit / Zoho accounts / postcodes.io answers used by the core tests, both
// in-process (globalThis.fetch replaced) and in child processes (fake-zoho-preload.js).
//
// cfg keys: token ('fail'), attach ('exists'|'fail'), create ('dup'|'error'), status (Zoho
// Candidate_Status of the duplicate), record (extra fields of the duplicate), postcodes
// ({ 'LS1 4AB': 'Leeds' }), unauthorizedOnce (first recruit call answers 401).

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function describeBody(body) {
  if (body && typeof body === 'object' && typeof body.entries === 'function' && !(body instanceof URLSearchParams)) {
    const parts = {};
    for (const [k, v] of body.entries()) parts[k] = typeof v === 'string' ? v : `[file ${v.name} ${v.size} bytes]`;
    return parts;
  }
  if (body instanceof URLSearchParams) return Object.fromEntries(body);
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return body; }
  }
  return body;
}

/**
 * @param {object} cfg
 * @param {(entry: object) => void} [onCall]
 * @param {Function} [fallback] fetch used for hosts this fake does not serve
 */
function createFake(cfg = {}, onCall = () => {}, fallback = null) {
  let unauthorizedLeft = cfg.unauthorizedOnce ? 1 : 0;
  return async function fakeFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const headers = init.headers || {};
    onCall({
      method, host: u.host, path: u.pathname + u.search,
      auth: headers.Authorization || null,
      body: describeBody(init.body),
    });

    if (u.host === 'accounts.zoho.eu') {
      if (cfg.token === 'fail') return json(400, { error: 'invalid_code' });
      return json(200, { access_token: 'fresh-access-token' });
    }

    if (u.host === 'recruit.zoho.eu') {
      if (unauthorizedLeft > 0) { unauthorizedLeft--; return json(401, { code: 'INVALID_TOKEN' }); }
      if (/\/Attachments$/.test(u.pathname)) {
        if (cfg.attach === 'exists') return json(200, { data: [{ status: 'error', code: 'INVALID_DATA', message: 'not allowed to attach more than one file' }] });
        if (cfg.attach === 'fail') return json(400, { data: [{ status: 'error', code: 'INVALID_DATA', message: 'nope' }] });
        if (cfg.attach === 'throttle') return json(400, { code: 'INTERNAL_ERROR', message: 'URL_FIXED_THROTTLES_LIMIT_EXCEEDED' });
        return json(200, { data: [{ status: 'success', details: { id: 'ATT-1' } }] });
      }
      if (method === 'POST' && u.pathname.endsWith('/Candidates')) {
        if (cfg.create === 'dup') return json(200, { data: [{ status: 'error', code: 'DUPLICATE_DATA', message: 'duplicate', details: { id: 'Z-DUP-1' } }] });
        if (cfg.create === 'error') return json(200, { data: [{ status: 'error', code: 'MANDATORY_NOT_FOUND', message: 'City missing', details: { api_name: 'City' } }] });
        if (cfg.create === 'empty') return json(200, {});
        return json(200, { data: [{ status: 'success', details: { id: 'Z-NEW-1' } }] });
      }
      if (method === 'GET' && /\/Candidates\/[^/]+$/.test(u.pathname)) {
        if (cfg.fetchFails) return json(500, { code: 'BOOM' });
        return json(200, { data: [{ id: 'Z-DUP-1', Candidate_Status: cfg.status || 'New', ...(cfg.record || {}) }] });
      }
      if (method === 'PUT') {
        if (cfg.putFails) return json(200, { data: [{ status: 'error', code: 'INVALID_DATA' }] });
        return json(200, { data: [{ status: 'success', details: { id: 'Z-DUP-1' } }] });
      }
      return json(404, { code: 'NOT_FOUND' });
    }

    if (u.host === 'api.postcodes.io') {
      const map = cfg.postcodes || {};
      const key = decodeURIComponent(u.pathname.split('/').pop());
      if (u.pathname.startsWith('/postcodes/') && key in map) return json(200, { result: { admin_district: map[key] } });
      if (u.pathname.startsWith('/outcodes/') && key in map) return json(200, { result: { admin_district: [map[key]] } });
      return json(404, { error: 'Invalid postcode' });
    }

    if (fallback) return fallback(input, init);
    throw new Error(`fake-services: unexpected request to ${u.host}`);
  };
}

module.exports = { createFake };
