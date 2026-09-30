'use strict';
// A local stand-in for the AI Gateway route that serves Jev for the CV stage: POST /typesafe/v1/systemone on 127.0.0.1 only.
// Its "brain" reads the role list of the state and answers the CV questions with simple keyword rules. THE NUMBERS SAY
// NOTHING ABOUT THE REAL JEV; they exist to drive the mechanics (state, retries, caching, gate, privacy) offline. The keyword
// tables live here, in a test helper, on purpose: the shipped code has none.
// Anything but the systemone route is a 404, a chat-completions request is counted as forbidden, a model other than
// typesafe-ai/jev is a 400 and also counted.

const http = require('http');

const KEY = 'fake-cv-gateway-key';

const TIERS = [
  ['head', /head chef|executive chef|chef manager|catering manager|unit manager|head cook/i],
  ['senior', /sous|second chef|senior chef de partie|senior cdp/i],
  ['entry', /porter|kitchen assistant|catering assistant|commis|trainee|apprentice|\bkp\b|pot wash|dishwash/i],
  ['mid', /chef de partie|\bcdp\b|line cook|\bcook\b|pastry|baker|larder|^chef\b|\bchef$/i],
];
const TIER_NUM = { entry: 1, mid: 2, senior: 3, head: 4 };
const KITCHEN = /porter|kitchen|catering|commis|chef|cook|baker|pastry|sous|larder|banquet/i;
const FOH = /waiter|waitress|bar staff|barista|host|front of house|supervisor|restaurant manager/i;
const INJECT = /ignore (?:all|previous)|approve|system note|recruiter note|pass verdict|output pass/i;

function tierOf(title) {
  const t = String(title || '');
  for (const [name, re] of TIERS) if (re.test(t)) return name;
  return null;
}

function familyOf(title) {
  const t = String(title || '');
  if (KITCHEN.test(t)) return 'kitchen';
  if (FOH.test(t)) return 'foh';
  return 'other';
}

function probs(options, main, top) {
  const p = {};
  const rest = options.filter(o => o !== main);
  const t = top === undefined ? 0.9 : top;
  for (const o of options) p[o] = o === main ? t : Math.round((1 - t) / Math.max(1, rest.length) * 1000) / 1000;
  return p;
}

function levelProbs(n, main, top) {
  const keys = Array.from({ length: n }, (_, i) => String(i));
  return probs(keys, String(main), top);
}

function relOf(title, searchRole) {
  const fam = familyOf(title);
  if (fam === 'kitchen' && familyOf(searchRole) === 'kitchen') return tierOf(title) === tierOf(searchRole) ? 3 : 2;
  if (fam === 'foh' && familyOf(searchRole) !== 'foh') return 1;
  return fam === 'foh' || fam === 'kitchen' ? 2 : 0;
}

function senOf(title, searchRole) {
  const a = tierOf(title);
  const b = tierOf(searchRole);
  if (familyOf(title) !== 'kitchen' || !a || !b) return 'cannot_tell';
  const d = TIER_NUM[a] - TIER_NUM[b];
  if (d <= -2) return 'much_more_junior';
  if (d === -1) return 'one_step_junior';
  if (d === 0) return 'comparable';
  if (d === 1) return 'one_step_senior';
  return 'two_or_more_steps_senior';
}

function answersFor(body, opts) {
  const o = opts || {};
  const role = String((body.state && body.state.search && body.state.search.role) || '');
  const lines = (body.state && body.state.candidate && body.state.candidate.roles) || [];
  const titles = lines.map(l => String(l).split(' | ')[0]);
  const all = JSON.stringify(body.state || {});
  const kitchenShare = titles.length ? titles.filter(t => familyOf(t) === 'kitchen').length / titles.length : 0;
  const out = {};
  for (const [key, q] of Object.entries(body.questions || {})) {
    let m;
    if ((m = /^relevance_(\d+)$/.exec(key))) {
      const lvl = relOf(titles[Number(m[1])], role);
      out[key] = { type: 'score', probabilities: levelProbs((q.criteria || []).length, lvl, o.top) };
    } else if ((m = /^seniority_(\d+)$/.exec(key))) {
      const opts2 = Object.keys(q.criteria || {});
      out[key] = { type: 'choice', choice: senOf(titles[Number(m[1])], role), probabilities: probs(opts2, senOf(titles[Number(m[1])], role), o.top) };
    } else if (key === 'overall_match') {
      const lvl = kitchenShare >= 0.6 ? 3 : (kitchenShare >= 0.3 ? 2 : (kitchenShare > 0 ? 1 : 0));
      out[key] = { type: 'score', probabilities: levelProbs((q.criteria || []).length, lvl, o.top) };
    } else if (key === 'progression') {
      out[key] = { type: 'choice', choice: 'stable', probabilities: probs(Object.keys(q.criteria || {}), 'stable', o.top) };
    } else if (key === 'career_change') {
      out[key] = { type: 'noul', noul: kitchenShare < 0.4 ? 0.95 : 0.03 };
    } else if (key === 'injection') {
      out[key] = { type: 'noul', noul: INJECT.test(all.replace(/"data_note":"[^"]*"/, '').replace(/"agency_context":"[^"]*"/, '')) ? 0.95 : 0.02 };
    } else if (key === 'search_level') {
      const t = tierOf(role);
      const main = t || 'not_a_kitchen_role';
      out[key] = { type: 'choice', choice: main, probabilities: probs(Object.keys(q.criteria || {}), main, o.top) };
    } else {
      out[key] = { type: 'noul', noul: 0.5 };
    }
  }
  return out;
}

function wellFormed(v) {
  if (typeof v === 'string') return v.isWellFormed();
  if (Array.isArray(v)) return v.every(wellFormed);
  if (v && typeof v === 'object') return Object.entries(v).every(([k, x]) => k.isWellFormed() && wellFormed(x));
  return true;
}

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({ __unparseable: true }); } });
    req.on('error', () => resolve({ __unparseable: true }));
  });
}

/**
 * @param {{key?:string, latencyMs?:number, failFirst?:number, failStatus?:number, respond?:Function, top?:number, capture?:boolean}} [options]
 *   respond(idx, body, req) may return {status, body, headers, delayMs} to override the answer of request number idx (1-based)
 */
function startFakeJev(options) {
  const o = options || {};
  const S = { requests: 0, answered: 0, inflight: 0, maxInflight: 0, byRoute: {}, models: {}, forbiddenHits: 0, badAuth: 0, captured: [], searchLevel: 0, main: 0 };
  const sockets = new Set();

  function send(res, code, body, headers) {
    const s = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), ...(headers || {}) });
    res.end(s);
  }

  const server = http.createServer(async (req, res) => {
    const route = `${req.method} ${req.url.split('?')[0]}`;
    S.byRoute[route] = (S.byRoute[route] || 0) + 1;
    S.inflight++;
    S.maxInflight = Math.max(S.maxInflight, S.inflight);
    res.on('close', () => { S.inflight--; });
    try {
      if (/chat\/completions/i.test(route)) { S.forbiddenHits++; await readBody(req); return send(res, 403, { message: 'restricted access' }); }
      if (route !== 'POST /typesafe/v1/systemone') { await readBody(req); return send(res, 404, { message: `no route ${route}` }); }
      const body = await readBody(req);
      const idx = ++S.requests;
      if (o.capture !== false) S.captured.push(body);
      if (req.headers.authorization !== `Bearer ${o.key || KEY}`) { S.badAuth++; return send(res, 401, { message: 'invalid key' }); }
      if (body.__unparseable || !body.model || !body.questions || typeof body.questions !== 'object') return send(res, 422, { message: 'invalid request body' });
      // the real gateway refuses a request that holds a lone surrogate (seen on 2026-09-30: HTTP 400 "invalid Unicode text")
      if (!wellFormed(body)) { S.invalidUnicode = (S.invalidUnicode || 0) + 1; return send(res, 400, { error: { message: 'Request contains invalid Unicode text.', type: 'AI_APICallError' } }); }
      S.models[body.model] = (S.models[body.model] || 0) + 1;
      if (body.model !== 'typesafe-ai/jev') { S.forbiddenHits++; return send(res, 400, { message: 'model not served here' }); }
      if (body.questions.search_level) S.searchLevel++; else S.main++;
      if (o.respond) {
        const custom = o.respond(idx, body, req);
        if (custom) {
          if (custom.delayMs) await new Promise(r => setTimeout(r, custom.delayMs));
          return send(res, custom.status || 200, custom.body || {}, custom.headers);
        }
      }
      if (o.failFirst && idx <= o.failFirst) return send(res, o.failStatus || 503, { message: 'fake outage' });
      await new Promise(r => setTimeout(r, o.latencyMs === undefined ? 2 : o.latencyMs));
      S.answered++;
      return send(res, 200, { model: 'typesafe-ai/jev', answers: answersFor(body, o), usage: { input_tokens: 400, output_tokens: 20 } }, { 'x-typesafe-request-id': `req_${idx}` });
    } catch (e) {
      try { send(res, 500, { message: 'fake gateway error' }); } catch (e2) { /* socket gone */ }
      return undefined;
    }
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        key: o.key || KEY,
        origin: `http://127.0.0.1:${port}`,
        stats: () => ({ ...S, captured: S.captured.slice() }),
        reset: () => { S.requests = 0; S.answered = 0; S.captured.length = 0; S.searchLevel = 0; S.main = 0; S.maxInflight = 0; },
        close: () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
      });
    });
  });
}

module.exports = { startFakeJev, answersFor, KEY, tierOf, familyOf };
