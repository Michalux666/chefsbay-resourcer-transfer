'use strict';
// Fake Zoho Recruit over real HTTP on 127.0.0.1, plus a client that maps responses exactly like
// zoho-create-candidate.js / zoho-attach-resume.js do (same error strings, same throttle retry rule).
const fs = require('fs');
const http = require('http');
const path = require('path');

const THROTTLE_BODY = { code: 'INTERNAL_ERROR', message: 'URL_FIXED_THROTTLES_LIMIT_EXCEEDED' };

async function startFakeZoho() {
  const scenarios = new Map(); // key (CatererID|ReedID) -> { create, attach }
  const zohoIds = new Map();   // key -> zoho id
  const calls = [];
  let seq = 45116000000000000n;
  const attachAttempts = new Map();
  const createAttempts = new Map();
  const idToKey = new Map();

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const url = req.url.split('?')[0];
      if (req.method === 'POST' && url === '/recruit/v2/Candidates') {
        const payload = JSON.parse(body.toString('utf8')).data[0];
        const key = String(payload.CatererID || payload.ReedID);
        const sc = { create: 'success', attach: 'ok', ...(scenarios.get(key) || {}) };
        const n = (createAttempts.get(key) || 0) + 1;
        createAttempts.set(key, n);
        calls.push({ op: 'create', key, scenario: sc.create, attempt: n });
        if (sc.create === 'http500') { res.writeHead(500, { 'Content-Type': 'text/html' }); return res.end('<html>boom</html>'); }
        if (sc.create === 'mandatory') {
          return send(200, { data: [{ code: 'MANDATORY_NOT_FOUND', status: 'error', message: 'required field not found', details: { api_name: 'City' } }] });
        }
        if (sc.create === 'invalid') return send(200, { data: [{ code: 'INVALID_DATA', status: 'error', message: 'invalid data', details: { api_name: 'Email' } }] });
        if (sc.create === 'empty') return send(200, {});
        if (sc.create === 'no-id') return send(200, { data: [{ status: 'success', details: {} }] });
        if (sc.create === 'throttle-then-ok' && n < 3) return send(200, THROTTLE_BODY);
        if (sc.create === 'flaky-once' && n === 1) { res.writeHead(500, { 'Content-Type': 'text/html' }); return res.end('boom'); }
        if (!zohoIds.has(key)) { seq += 1n; zohoIds.set(key, String(seq)); }
        idToKey.set(zohoIds.get(key), key);
        // the record IS created, the answer is lost; the retry then meets DUPLICATE_DATA for the record we made
        if (sc.create === 'created-then-lost') {
          if (n === 1) { res.writeHead(500, { 'Content-Type': 'text/html' }); return res.end('lost'); }
          return send(200, { data: [{ code: 'DUPLICATE_DATA', status: 'error', message: 'duplicate data', details: { id: zohoIds.get(key) } }] });
        }
        if (sc.create === 'duplicate') {
          return send(200, { data: [{ code: 'DUPLICATE_DATA', status: 'error', message: 'duplicate data', details: { id: zohoIds.get(key) } }] });
        }
        return send(200, { data: [{ code: 'SUCCESS', status: 'success', details: { id: zohoIds.get(key) } }] });
      }
      if (req.method === 'PUT' && url === '/recruit/v2/Candidates') return send(200, { data: [{ status: 'success' }] });
      const m = /^\/recruit\/v2\/Candidates\/(\d+)\/Attachments$/.exec(url);
      if (req.method === 'POST' && m) {
        const key = idToKey.get(m[1]) || 'unknown';
        const sc = { attach: 'ok', ...(scenarios.get(key) || {}) };
        const n = (attachAttempts.get(key) || 0) + 1;
        attachAttempts.set(key, n);
        calls.push({ op: 'attach', key, scenario: sc.attach, attempt: n, bytes: body.length });
        if (sc.attach === 'http500') { res.writeHead(500, { 'Content-Type': 'text/html' }); return res.end('<html>boom</html>'); }
        if (sc.attach === 'fail') return send(200, { data: [{ status: 'error', code: 'INVALID_DATA', message: 'file type not allowed' }] });
        if (sc.attach === 'exists') return send(200, { data: [{ status: 'error', message: 'not allowed to attach more than one resume' }] });
        if (sc.attach === 'throttle-always') return send(200, THROTTLE_BODY);
        if (sc.attach === 'throttle-then-ok' && n < 3) return send(200, THROTTLE_BODY);
        return send(200, { data: [{ status: 'success', details: { id: `att-${key}` } }] });
      }
      return send(404, { code: 'NOT_FOUND' });
    });
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  function makeClient(opts = {}) {
    const sleep = opts.sleep || (async () => {});
    return {
      async createCandidate(candidate) {
        if (!candidate.Last_Name) throw new Error('ERROR: Last_Name is required');
        const payload = { ...candidate, Candidate_Status: 'New' };
        const res = await fetch(`${base}/recruit/v2/Candidates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: [payload], trigger: ['workflow'] }) });
        const result = await res.json();
        const record = result && result.data && result.data[0];
        if (!record) throw new Error(`ERROR: Unexpected Zoho response: ${JSON.stringify(result)}`);
        if (record.status === 'success') return { zohoId: record.details && record.details.id, isDuplicate: false, enrichment: null };
        if (record.code !== 'DUPLICATE_DATA') throw new Error(`ERROR: ${record.code} ${record.message} ${JSON.stringify(record.details)}`);
        return { zohoId: record.details && record.details.id, isDuplicate: true, enrichment: 'none' };
      },
      async attachResume(zohoId, filePath) {
        const backoffs = [4000, 8000, 15000];
        let result;
        for (let attempt = 1; attempt <= backoffs.length + 1; attempt++) {
          const form = new FormData();
          form.append('file', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
          const res = await fetch(`${base}/recruit/v2/Candidates/${zohoId}/Attachments?attachments_category=Resume`, { method: 'POST', body: form });
          const text = await res.text();
          let data;
          try { data = JSON.parse(text); } catch { data = { raw: text }; }
          const record = data && data.data && data.data[0];
          if (record && record.status === 'success') result = { ok: true, alreadyExists: false, status: res.status, data };
          else if (record && record.message && record.message.includes('not allowed to attach more than one')) result = { ok: true, alreadyExists: true, status: res.status, data };
          else result = { ok: false, alreadyExists: false, status: res.status, data };
          if (result.ok) return result;
          const throttled = /THROTTLE|LIMIT_EXCEEDED|TOO_MANY|RATE_LIMIT/i.test(JSON.stringify(data || {}));
          if (attempt > backoffs.length || !throttled) return result;
          await sleep(backoffs[attempt - 1]);
        }
        return result;
      },
    };
  }

  return {
    base, calls, scenarios, zohoIds, makeClient,
    scenario(id, sc) { scenarios.set(String(id), sc); },
    callsFor(key, op) { return calls.filter(c => c.key === String(key) && (!op || c.op === op)); },
    close: () => new Promise(r => server.close(r)),
  };
}

module.exports = { startFakeZoho };
