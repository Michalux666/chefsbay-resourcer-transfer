'use strict';
// The fake outside world of the rehearsal, as real HTTP servers on 127.0.0.1 inside the test process:
//   zoho     Zoho accounts (token), Zoho Recruit (Candidates create/update/get, Attachments) and postcodes.io
//   gateway  tests/fake-gateway (Jev + LLM), key fake-test-key
//   reed     added by the Reed scenario (tests/reed/helpers/fake-reed.js)
// The children reach them only through lib/preload.js, which maps the real host names to these ports.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { startFakeGateway } = require('../../fake-gateway/server.js');

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

// filename and payload size of the first file part of a multipart body
function multipartFile(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const start = buf.indexOf(boundary);
  if (start < 0) return null;
  const headEnd = buf.indexOf(Buffer.from('\r\n\r\n'), start);
  if (headEnd < 0) return null;
  const head = buf.slice(start, headEnd).toString('latin1');
  const fn = /filename="([^"]*)"/.exec(head);
  const next = buf.indexOf(boundary, headEnd + 4);
  const data = buf.slice(headEnd + 4, next < 0 ? buf.length : next - 2);
  return { filename: fn ? fn[1] : null, size: data.length, head: data.slice(0, 8).toString('latin1') };
}

async function startZoho(opts) {
  const o = opts || {};
  const st = {
    records: new Map(),      // zoho id -> { id, key, payload, attachments: [] }
    byKey: new Map(),        // CatererID / ReedID -> zoho id
    calls: [],               // { op, key, at, status }
    tokenGrants: 0,
    seq: 45116000000000000n,
    mode: {
      create: 'ok',          // ok | http500 | throttle | down
      attach: 'ok',          // ok | exists | http500 | fail
      latencyMs: 0,
      requireMandatory: true,
      perKey: {},            // key -> { create, attach }
    },
    dupKeys: new Set(o.dupKeys || []),   // keys Zoho already holds (created outside the pipeline)
  };
  const nextId = () => { st.seq += 1n; return String(st.seq); };
  const log = (op, key, status, extra) => st.calls.push(Object.assign({ op, key, status, at: Date.now() }, extra || {}));

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const host = String(req.headers['x-e2e-host'] || '');
    const url = req.url.split('?')[0];
    const send = (status, obj, headers) => {
      const s = JSON.stringify(obj);
      res.writeHead(status, Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) }, headers || {}));
      res.end(s);
    };
    if (st.mode.latencyMs) await new Promise((r) => setTimeout(r, st.mode.latencyMs));
    try {
      if (st.mode.create === 'down' && /zoho/.test(host)) { req.socket.destroy(); return; }

      if (host === 'accounts.zoho.eu' && url === '/oauth/v2/token') {
        // a hostile / careless token endpoint that echoes the whole request (client secret, refresh token) in its error
        if (st.mode.tokenEcho) { log('token', null, 400); return send(400, { error: 'invalid_client', echo: body.toString('utf8') }); }
        st.tokenGrants++;
        log('token', null, 200);
        return send(200, { access_token: 'E2E-zoho-access-token-fresh', expires_in: 3600, token_type: 'Bearer' });
      }

      if (host === 'recruit.zoho.eu') {
        if (!/^Zoho-oauthtoken /.test(String(req.headers.authorization || ''))) { log('auth-missing', null, 401); return send(401, { code: 'INVALID_TOKEN' }); }
        if (req.method === 'POST' && url === '/recruit/v2/Candidates') {
          const payload = JSON.parse(body.toString('utf8')).data[0];
          const key = String(payload.CatererID || payload.ReedID);
          const pk = st.mode.perKey[key] || {};
          const mode = pk.create || st.mode.create;
          if (mode === 'http500') { log('create', key, 500); res.writeHead(500, { 'content-type': 'text/html' }); return res.end('<html>boom</html>'); }
          if (mode === 'throttle') { log('create', key, 200, { throttled: true }); return send(200, { code: 'INTERNAL_ERROR', message: 'URL_FIXED_THROTTLES_LIMIT_EXCEEDED' }); }
          if (st.mode.requireMandatory) {
            for (const f of ['Last_Name', 'City', 'Email', 'Mobile']) {
              if (!payload[f]) { log('create', key, 200, { rejected: f }); return send(200, { data: [{ code: 'MANDATORY_NOT_FOUND', status: 'error', message: 'required field not found', details: { api_name: f } }] }); }
            }
          }
          if (st.byKey.has(key) || st.dupKeys.has(key)) {
            if (!st.byKey.has(key)) {
              const id = nextId();
              st.records.set(id, { id, key, payload: { CatererID: key, Candidate_Status: 'New' }, attachments: [], external: true });
              st.byKey.set(key, id);
            }
            log('create', key, 200, { duplicate: true });
            return send(200, { data: [{ code: 'DUPLICATE_DATA', status: 'error', message: 'duplicate data', details: { id: st.byKey.get(key) } }] });
          }
          const id = nextId();
          st.records.set(id, { id, key, payload, attachments: [] });
          st.byKey.set(key, id);
          log('create', key, 200);
          return send(200, { data: [{ code: 'SUCCESS', status: 'success', message: 'record added', details: { id } }] });
        }
        if (req.method === 'PUT' && url === '/recruit/v2/Candidates') {
          log('update', null, 200);
          return send(200, { data: [{ code: 'SUCCESS', status: 'success', details: {} }] });
        }
        let m = /^\/recruit\/v2\/Candidates\/(\d+)\/Attachments$/.exec(url);
        if (req.method === 'POST' && m) {
          const rec = st.records.get(m[1]);
          const key = rec ? rec.key : 'unknown';
          const pk = st.mode.perKey[key] || {};
          const mode = pk.attach || st.mode.attach;
          const file = multipartFile(body, req.headers['content-type']);
          if (!rec) { log('attach', key, 404); return send(404, { code: 'INVALID_DATA', message: 'no such record' }); }
          if (mode === 'http500') { log('attach', key, 500); res.writeHead(500, { 'content-type': 'text/html' }); return res.end('boom'); }
          if (mode === 'fail') { log('attach', key, 200, { failed: true }); return send(200, { data: [{ status: 'error', code: 'INVALID_DATA', message: 'file type not allowed' }] }); }
          if (mode === 'exists' || rec.attachments.length) { log('attach', key, 200, { exists: true }); return send(200, { data: [{ status: 'error', message: 'not allowed to attach more than one resume' }] }); }
          rec.attachments.push({ filename: file && file.filename, size: file && file.size, head: file && file.head });
          log('attach', key, 200, { size: file && file.size });
          return send(200, { data: [{ status: 'success', code: 'SUCCESS', details: { id: `att-${rec.id}` } }] });
        }
        m = /^\/recruit\/v2\/Candidates\/(\d+)$/.exec(url);
        if (req.method === 'GET' && m) {
          const rec = st.records.get(m[1]);
          log('get', rec ? rec.key : null, rec ? 200 : 404);
          return rec ? send(200, { data: [Object.assign({ id: rec.id, Candidate_Status: 'New' }, rec.payload)] }) : send(204, {});
        }
      }

      if (/postcodes\.io$/.test(host)) {
        let mm = /^\/outcodes\/([^/]+)$/.exec(url);
        if (mm) return send(200, { status: 200, result: { outcode: decodeURIComponent(mm[1]).toUpperCase(), admin_district: ['Leeds'] } });
        mm = /^\/postcodes\/([^/]+)$/.exec(url);
        if (mm) return send(200, { status: 200, result: { postcode: decodeURIComponent(mm[1]).toUpperCase(), admin_district: 'Leeds' } });
      }
      log('unrouted', null, 404, { host, url });
      return send(404, { code: 'NOT_FOUND', host, url });
    } catch (e) {
      log('error', null, 500, { message: e.message });
      return send(500, { code: 'FAKE_ERROR', message: e.message });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return {
    port: server.address().port,
    state: st,
    counts() {
      const c = {};
      for (const x of st.calls) c[x.op] = (c[x.op] || 0) + 1;
      return c;
    },
    created() { return [...st.records.values()].filter((r) => !r.external); },
    close() { return new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }); },
  };
}

// One object with everything a scenario needs to reach, plus the services file the preload reads.
async function startServices(dir, opts) {
  const o = opts || {};
  const zoho = await startZoho(o.zoho);
  const gateway = await startFakeGateway({ key: 'fake-test-key', port: o.gatewayPort || 0 });
  const servicesFile = path.join(dir, 'services.json');
  const svc = { zoho, gateway, servicesFile, reed: null, extra: {} };
  svc.write = () => {
    const map = {
      'recruit.zoho.eu': zoho.port,
      'accounts.zoho.eu': zoho.port,
      'api.postcodes.io': zoho.port,
      'postcodes.io': zoho.port,
    };
    if (svc.reed) for (const h of svc.reed.hosts) map[h] = svc.reed.port;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(servicesFile, JSON.stringify({ map }));
  };
  svc.write();
  svc.close = async () => {
    await zoho.close();
    await svc.gateway.close();
    if (svc.reed && svc.reed.close) await svc.reed.close();
  };
  return svc;
}

module.exports = { startZoho, startServices, startFakeGateway };
