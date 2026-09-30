'use strict';

// Fake Reed world for offline tests: a Chrome-153-like CDP server (HTTP /json + WebSocket per tab) with a tiny login/site
// state machine, plus a fake Reed BFF API on 127.0.0.1. No real network is ever touched.

const http = require('http');
const vm = require('vm');
const crypto = require('crypto');
function dep(name) {
  try { return require(name); } catch { return require(require.resolve(name, { paths: [require('path').resolve(__dirname, '..', '..', '..', 'resourcer'), process.cwd()] })); }
}
const { WebSocketServer } = dep('ws');

const API_PREFIX = '/api-bff-recruiter-candidates';
const SEARCH_URL = 'https://www.reed.co.uk/recruiter/v2/candidates/search/results';
const HOME_URL = 'https://www.reed.co.uk/recruiter/v2/home';

const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function makeJwt(expSecs, extra) {
  return `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({ sub: 'test|1', exp: expSecs, ...(extra || {}) })}.${b64u(`sig${crypto.randomBytes(12).toString('hex')}`)}`;
}

class FakeInput {
  constructor() { this._value = ''; }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  focus() {}
  dispatchEvent() { return true; }
}

function makeCard(i, over) {
  return {
    candidateId: 9000 + i,
    name: `Test Person ${i}`,
    firstName: 'Test',
    lastLogin: '2026-09-01T10:00:00Z',
    isNew: false,
    jobPreference: {
      currentJobTitle: `Chef de Partie ${i}`, desiredJobTitle: 'Sous Chef', jobType: 'Permanent',
      locations: { currentLocation: `Town${i}`, desiredLocations: 'Leeds' },
      salary: { minimumSalary: '25000' },
    },
    jobEligibility: { hasWorkPermit: true },
    employmentStatus: { noticePeriod: '1 month' },
    ...(over || {}),
  };
}

// Smallest documents the CV text extractors accept (no external files, no network).
function makeMinimalPdf(text) {
  return Buffer.from(['%PDF-1.4', '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj', '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
    '4 0 obj<</Length 44>>stream', `BT /F1 12 Tf 10 50 Td (${text}) Tj ET`, 'endstream endobj',
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj', 'trailer<</Root 1 0 R/Size 6>>', '%%EOF', ''].join(String.fromCharCode(10)));
}

function makeMinimalDocx(text) {
  const zlib = require('zlib');
  const files = [
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`],
  ];
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    parts.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => resolve(d));
  });
}

async function startFakeReed(opts = {}) {
  const site = {
    loggedIn: !!opts.loggedIn,
    mode: 'ok', // ok | turnstile | turnstile-after-submit | reject | interstitial
    twoStep: false,
    creds: { email: 'reed.test.user@example.invalid', password: 'Pw-SENTINEL-1234' },
    tokenTtlSecs: 1800,
    captureMode: 'requestWillBeSent', // requestWillBeSent | extraInfo | responseReceived | none
    navError: null,
    tokens: new Set(),
    tokenClaims: {},
    cookiesDeleted: 0,
    issueToken() {
      const t = makeJwt(Math.floor(Date.now() / 1000) + site.tokenTtlSecs, site.tokenClaims);
      site.tokens.add(t);
      return t;
    },
  };

  const api = {
    candidates: opts.candidates || Array.from({ length: 30 }, (_, i) => makeCard(i + 1)),
    queryId: 'q-fake-0001',
    failNext: [], // [{status, body?}] consumed one per API request
    fixedStatus: null,
    requests: [],
    profileViews: 0,
    cvText: 'Head Chef at The Test Kitchen 2018-2024. Ran a brigade of ten. AAA-CVTEXT-MARKER ' + 'Experience in fine dining. '.repeat(6),
    cvKind: 'txt', // txt | html | tiny
    blockDirect: false, // requests from Node (direct fetch carries an Origin header) get Cloudflare's 403, like production
    profileNoContact: 0, // first N profile requests come back without contact details
  };

  // -------------------------------------------------------------- fake Reed API
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, accept',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-expose-headers': 'content-disposition, content-type',
  };
  const apiServer = http.createServer(async (req, res) => {
    const writeHead = res.writeHead.bind(res);
    res.writeHead = (status, headers) => writeHead(status, { ...cors, ...(headers || {}) });
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const body = await readBody(req);
    const url = new URL(req.url, 'http://127.0.0.1');
    const rec = { method: req.method, path: url.pathname.replace(API_PREFIX, ''), search: url.search, auth: req.headers.authorization || '', body };
    api.requests.push(rec);
    const send = (status, obj, headers) => {
      res.writeHead(status, { 'content-type': 'application/json', ...(headers || {}) });
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
    };
    if (api.blockDirect && req.headers.origin === 'https://www.reed.co.uk') return send(403, { requiresTurnstile: true });
    if (api.failNext.length) {
      const f = api.failNext[0];
      if (!f.path || rec.path.includes(f.path)) {
        if (f.skip > 0) {
          f.skip--;
        } else {
          api.failNext.shift();
          return send(f.status, f.body || { message: `forced ${f.status}` });
        }
      }
    }
    if (api.fixedStatus) return send(api.fixedStatus, { message: `fixed ${api.fixedStatus}` });
    const tok = rec.auth.replace(/^Bearer /i, '');
    let valid = site.tokens.has(tok);
    if (valid) {
      try {
        const exp = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).exp;
        valid = exp > Date.now() / 1000;
      } catch { valid = false; }
    }
    if (!valid) return send(401, { message: 'unauthorized' });
    const p = rec.path;
    if (req.method === 'GET' && p.startsWith('/location/suggest-locations/')) {
      const term = url.searchParams.get('searchTerm') || '';
      return send(200, { result: { suggestedLocations: [{ locationId: 4242, searchName: term.toUpperCase(), postcode: term }] } });
    }
    if (req.method === 'POST' && p.startsWith('/candidate/search/boolean/')) {
      const b = JSON.parse(body || '{}');
      const size = b.pageItemCount || 25;
      const page = b.currentPage || 1;
      const slice = api.candidates.slice((page - 1) * size, page * size);
      return send(200, {
        result: { totalItemCount: api.candidates.length, pageItemCount: slice.length, currentPage: page, candidates: slice },
        metaData: [{ key: 'QueryId', value: api.queryId }],
      });
    }
    if (req.method === 'POST' && p.startsWith('/candidate/profile/')) {
      const b = JSON.parse(body || '{}');
      api.profileViews++;
      if (api.profileNoContact > 0) { api.profileNoContact--; return send(200, { result: { candidateId: b.candidateId, name: 'Test Person' } }); }
      return send(200, { result: { candidateId: b.candidateId, name: 'Test Person', email: `cand${b.candidateId}@example.invalid`, phoneNumber: '07000 000000', address: { town: 'Leeds', postcode: 'LS1 1AA' } } });
    }
    if (req.method === 'POST' && p.startsWith('/candidate/cv/download/')) {
      if (api.cvKind === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!DOCTYPE html><html><body>please log in</body></html>'.padEnd(200, ' ')); }
      if (api.cvKind === 'pdf') { res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="cv.pdf"' }); return res.end(makeMinimalPdf(api.cvText.slice(0, 60))); }
      if (api.cvKind === 'docx') { res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'content-disposition': 'attachment; filename="cv.docx"' }); return res.end(makeMinimalDocx(api.cvText)); }
      if (api.cvKind === 'odt') { res.writeHead(200, { 'content-type': 'application/vnd.oasis.opendocument.text', 'content-disposition': 'attachment; filename="cv.odt"' }); return res.end(Buffer.concat([Buffer.from('PK-fake-odt-'), Buffer.alloc(200, 65)])); }
      if (api.cvKind === 'tiny') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('tiny'); }
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="cv.txt"' });
      return res.end(api.cvText);
    }
    if (req.method === 'GET' && p.startsWith('/monetization/daily-usage/')) {
      return send(200, { result: { profileViews: api.profileViews, dailyLimit: 600 } });
    }
    return send(404, { message: 'not found' });
  });
  await new Promise((r) => apiServer.listen(opts.apiPort || 0, '127.0.0.1', r));
  const apiPort = apiServer.address().port;

  // -------------------------------------------------------------- fake CDP (Chrome 153 surface)
  const calls = [];
  const tabs = new Map();
  let tabSeq = 0;
  let reqSeq = 0;
  const cdpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const host = req.headers.host;
    const desc = (t) => ({ id: t.id, type: t.type || 'page', title: t.title || '', url: t.url, webSocketDebuggerUrl: `ws://${host}/devtools/page/${t.id}` });
    if (url.pathname === '/json/version') return json(200, { Browser: 'Chrome/153.0.8010.50', 'Protocol-Version': '1.3', webSocketDebuggerUrl: `ws://${host}/devtools/browser/x` });
    if (url.pathname === '/json' || url.pathname === '/json/list') return json(200, [...tabs.values()].map(desc));
    if (url.pathname === '/json/new') {
      if (req.method !== 'PUT') { res.writeHead(405); return res.end('Using unsafe HTTP verb GET to invoke /json/new. This action supports only PUT verb.'); }
      const target = decodeURIComponent(req.url.slice(req.url.indexOf('?') + 1)) || 'about:blank';
      const t = newTab(target === 'about:blank' ? 'about:blank' : null);
      if (target !== 'about:blank') navigateTab(t, target, false);
      return json(200, desc(t));
    }
    if (url.pathname.startsWith('/json/close/')) {
      const id = url.pathname.split('/').pop();
      const t = tabs.get(id);
      if (t) { for (const w of t.sockets) w.close(); tabs.delete(id); }
      res.writeHead(200); return res.end('Target is closing');
    }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  cdpServer.on('upgrade', (req, socket, head) => {
    const id = req.url.split('/').pop();
    if (req.url.startsWith('/devtools/browser/')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          calls.push({ method: msg.method, tab: 'browser' });
          if (msg.method === 'Browser.close') {
            ws.send(JSON.stringify({ id: msg.id, result: {} }));
            if (opts.onBrowserClose) opts.onBrowserClose();
          } else {
            ws.send(JSON.stringify({ id: msg.id, error: { code: -32601, message: `'${msg.method}' wasn't found` } }));
          }
        });
      });
      return;
    }
    const t = tabs.get(id);
    if (!t) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      t.sockets.add(ws);
      ws.on('close', () => t.sockets.delete(ws));
      ws.on('message', (data) => onMessage(t, ws, JSON.parse(data.toString())));
    });
  });
  await new Promise((r) => cdpServer.listen(opts.cdpPort || 0, '127.0.0.1', r));
  const cdpPort = cdpServer.address().port;

  function newTab(url) {
    const id = `T${++tabSeq}`;
    const t = { id, type: 'page', url: url || 'about:blank', title: '', sockets: new Set(), page: { kind: 'blank' }, ctx: null, win: {} };
    tabs.set(id, t);
    return t;
  }

  function emit(t, method, params) {
    const msg = JSON.stringify({ method, params });
    for (const w of t.sockets) { try { w.send(msg); } catch { /* closed */ } }
  }

  function loginPage() {
    const emailEl = new FakeInput();
    const passEl = new FakeInput();
    return {
      kind: 'login', emailEl, passEl,
      hasEmail: site.mode !== 'interstitial',
      hasPass: !site.twoStep && site.mode !== 'interstitial',
      turnstile: site.mode === 'turnstile',
      turnstileSolved: false,
      interstitial: site.mode === 'interstitial',
    };
  }

  function setUrl(t, url, kind) {
    t.url = url;
    t.win = {};
    t.ctx = null;
    t.page = kind === 'login' ? loginPage() : { kind };
    t.title = t.page.interstitial ? 'Just a moment...' : (kind === 'login' ? 'Sign in' : kind);
  }

  function emitBearer(t) {
    const tok = site.issueToken();
    const url = `https://api.reed.co.uk${API_PREFIX}/user/context`;
    const rid = `R${++reqSeq}`;
    setTimeout(() => {
      emit(t, 'Network.requestWillBeSent', { requestId: `${rid}p`, request: { url, method: 'OPTIONS', headers: { Accept: '*/*' } } });
      emit(t, 'Network.requestWillBeSent', { requestId: `${rid}x`, request: { url: 'https://www.example.invalid/track', method: 'GET', headers: { Authorization: 'Bearer some-other-service-token-that-is-long-enough-to-pass-length' } } });
      if (site.captureMode === 'requestWillBeSent') {
        emit(t, 'Network.requestWillBeSent', { requestId: rid, request: { url, method: 'GET', headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' } } });
      } else if (site.captureMode === 'extraInfo') {
        emit(t, 'Network.requestWillBeSent', { requestId: rid, request: { url, method: 'GET', headers: { Accept: 'application/json' } } });
        emit(t, 'Network.requestWillBeSentExtraInfo', { requestId: rid, headers: { authorization: `Bearer ${tok}` } });
      } else if (site.captureMode === 'responseReceived') {
        emit(t, 'Network.responseReceived', { requestId: rid, response: { url, status: 200, requestHeaders: { Authorization: `Bearer ${tok}` } } });
      }
    }, 5);
  }

  function navigateTab(t, url, fromCdp) {
    if (/^https:\/\/secure-recruiter\.reed\.co\.uk\//i.test(url)) {
      if (site.loggedIn) { setUrl(t, HOME_URL, 'home'); } else { setUrl(t, url, 'login'); }
    } else if (/reed\.co\.uk\/recruiter/i.test(url)) {
      if (!site.loggedIn) {
        setUrl(t, 'https://secure-recruiter.reed.co.uk/login?state=redirect', 'login');
      } else if (/candidates\/search/.test(url)) {
        setUrl(t, url, 'search');
        emitBearer(t);
      } else {
        setUrl(t, url, 'home');
      }
    } else {
      setUrl(t, url, 'blank');
    }
    return fromCdp;
  }

  function buildContext(t) {
    const doc = {
      get title() { return t.title; },
      querySelector(sel) {
        const p = t.page;
        if (p.kind !== 'login') return null;
        if (sel.includes('input[type="email"]')) return p.hasEmail ? p.emailEl : null;
        if (sel.includes('input[type="password"]')) return p.hasPass ? p.passEl : null;
        if (sel === 'input[name="cf-turnstile-response"]') return p.turnstile ? { get value() { return p.turnstileSolved ? 'solved-token' : ''; } } : null;
        if (sel.includes('challenges.cloudflare.com')) return p.turnstile ? {} : null;
        if (sel === 'button[type="submit"]') return { click: () => submit(t) };
        if (sel === 'form') return { requestSubmit: () => submit(t) };
        return null;
      },
    };
    const realFetch = fetch;
    const wrappedFetch = async (u, o) => {
      const s = String(u);
      if (s.startsWith('https://api.reed.co.uk')) {
        if (t.page.kind !== 'search') return new Response('{"message":"tab not on search page"}', { status: 401 });
        return realFetch(`http://127.0.0.1:${apiPort}${s.slice('https://api.reed.co.uk'.length)}`, o);
      }
      if (s.startsWith(`http://127.0.0.1:${apiPort}`)) {
        if (t.page.kind !== 'search') return new Response('{"message":"tab not on search page"}', { status: 401 });
        return realFetch(s, o);
      }
      throw new TypeError(`fake fetch blocked: ${s}`);
    };
    const sandbox = {
      document: doc, fetch: wrappedFetch, Event: class Event { constructor(type) { this.type = type; } },
      btoa, Uint8Array, console: { log() {} },
      localStorage: { clear() { t.storageCleared = true; } },
      sessionStorage: { clear() {} },
    };
    Object.defineProperty(sandbox, 'location', { get: () => ({ href: t.url }) });
    sandbox.window = sandbox;
    sandbox.HTMLInputElement = FakeInput;
    Object.defineProperty(sandbox, '__capturedReedToken', { get: () => t.win.token, set: (v) => { t.win.token = v; }, configurable: true, enumerable: true });
    return vm.createContext(sandbox);
  }

  function submit(t) {
    const p = t.page;
    if (p.kind !== 'login') return;
    if (!p.hasPass) {
      if (p.emailEl.value) p.hasPass = true;
      return;
    }
    if (site.mode === 'turnstile-after-submit') { p.turnstile = true; return; }
    if (site.mode === 'turnstile' && !p.turnstileSolved) return;
    if (site.mode === 'reject') return;
    if (p.emailEl.value === site.creds.email && p.passEl.value === site.creds.password) {
      site.loggedIn = true;
      setUrl(t, HOME_URL, 'home');
    }
  }

  async function evaluate(t, params) {
    if (!t.ctx) t.ctx = buildContext(t);
    let r;
    try {
      r = vm.runInContext(params.expression, t.ctx, { timeout: 5000 });
      if (r && typeof r.then === 'function') r = await r;
    } catch (e) {
      return { exceptionDetails: { text: 'Uncaught', exception: { description: `${e && e.name}: ${e && e.message}` } } };
    }
    if (r === undefined) return { result: { type: 'undefined' } };
    return { result: { type: typeof r, value: typeof r === 'object' && r !== null ? JSON.parse(JSON.stringify(r)) : r } };
  }

  async function onMessage(t, ws, msg) {
    const { id, method, params } = msg;
    calls.push({ method, tab: t.id, params: method.startsWith('Runtime.') ? undefined : params });
    const reply = (result) => ws.send(JSON.stringify({ id, result: result || {} }));
    const fail = (code, message) => ws.send(JSON.stringify({ id, error: { code, message } }));
    if (opts.hangMethods && opts.hangMethods.includes(method)) return;
    if (opts.delayMethods && opts.delayMethods[method]) await new Promise((r) => setTimeout(r, opts.delayMethods[method]));
    switch (method) {
      case 'Network.enable':
      case 'Page.enable':
      case 'Runtime.enable':
        return reply({});
      case 'Page.navigate': {
        if (site.navError) return reply({ frameId: 'F', errorText: site.navError });
        navigateTab(t, params.url, true);
        reply({ frameId: 'F', loaderId: 'L' });
        return undefined;
      }
      case 'Runtime.evaluate': {
        const r = await evaluate(t, params);
        return reply(r);
      }
      case 'Network.getCookies':
        return reply({ cookies: site.loggedIn ? ['auth0', 'did', 'cf_clearance'].map((name) => ({ name, domain: '.reed.co.uk', path: '/' })) : [] });
      case 'Network.deleteCookies':
        site.cookiesDeleted++;
        if (site.cookiesDeleted >= 3) { site.loggedIn = false; site.cookiesDeleted = 0; }
        return reply({});
      default:
        return fail(-32601, `'${method}' wasn't found`);
    }
  }

  const fake = {
    cdpPort, apiPort, site, api, calls, tabs,
    apiBase: `http://127.0.0.1:${apiPort}${API_PREFIX}`,
    addTab(url) { const t = newTab(url || 'about:blank'); if (url) navigateTab(t, url, false); return t; },
    methods() { return calls.map((c) => c.method); },
    // simulates a human finishing the login in whichever tab is on the login page
    humanLogin() {
      site.loggedIn = true;
      for (const t of tabs.values()) if (t.page.kind === 'login') setUrl(t, HOME_URL, 'home');
    },
    async close() {
      for (const t of tabs.values()) for (const w of t.sockets) { try { w.terminate(); } catch { /* ignore */ } }
      cdpServer.closeAllConnections();
      apiServer.closeAllConnections();
      await new Promise((r) => cdpServer.close(r));
      await new Promise((r) => apiServer.close(r));
    },
  };
  if (opts.initialTab !== false) fake.addTab(opts.initialUrl || SEARCH_URL);
  return fake;
}

module.exports = { startFakeReed, makeJwt, makeCard, makeMinimalPdf, makeMinimalDocx, SEARCH_URL, HOME_URL, API_PREFIX };
