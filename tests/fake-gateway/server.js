'use strict';
// Zero-dependency fake AI Gateway for the screening tests. It speaks just enough of:
//   POST /typesafe/v1/systemone   Jev (TypeSafe-compatible surface)
//   POST /v1/evaluate             Vercel-native evaluation surface (only for the "do not mix parsers" test)
//   POST /v1/chat/completions     the normal LLM with json_schema structured output
//   GET  /v1/credits, /v1/models, /typesafe/v1/models
// and is steered by SCENARIO TOKENS placed in the candidate snippet, e.g. [[REJECT]] or
// [[J:HTTP500x2]] (J: = Jev route only, L: = LLM route only, no prefix = both), plus a global mode
// switch (POST /__fake/mode). It never stores request bodies unless capture is switched on, and only
// synthetic data is ever sent to it.
//
//   Jev answer tokens : [[APPROVE]] [[REJECT]] [[LOWCONF]] [[TIER:<option>]] [[RTIER:<option>]] [[INJECT]] [[NOINFO]] [[MISMATCH]]
//                       for the criteria questions (seniority, role_level) they are mapped by criteria-answers.js and the
//                       default is a keyword reading of the card; [[ROLEMATCH]] and [[FIT]] only steer the old question set
//   LLM answer tokens : [[APPROVE]] (default) [[REJECT]] [[REASON:<code>]] [[LLMCONF:<x>]] [[LLMSTRBOOL]]
//                       [[LLMJSON:<text>]] [[LLMLENGTH]] [[LLMREFUSAL]] [[L500PRIMARY]] [[LBADPRIMARY]]
//   failure tokens    : [[HTTP500]] [[HTTP500x<n>]] [[HTTP429]] [[HTTP429x<n>]] [[HTTP422]] [[SLOW:<ms>]]
//                       [[TIMEOUT]] [[MALFORMED]] [[BADCHOICE]] [[NOPROBS]] [[NOTJEV]]
// Global modes per route (POST /__fake/mode {jev|llm|cv: ...}; cv = only the requests of the CV screening stage, recognised by their questions, so the snippet
// route can stay healthy while the CV route refuses, as in Update C finding F1): ok, down, slow, 401, 402, 403, 429, 500, 503,
// restricted (403 "Your team has restricted access to this model"), no_providers (400 no_providers_available).

const http = require('node:http');
const crypto = require('node:crypto');

const DEFAULT_KEY = 'fake-test-key';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function hash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12); }
const r2 = x => Math.round(x * 100) / 100;

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({ __unparseable: true }); } });
    req.on('error', () => resolve({ __unparseable: true }));
  });
}

function tokensOf(text, side) {
  const out = [];
  const re = /\[\[([A-Za-z0-9_]+:)?([A-Za-z0-9_]+)(?::([^\]]*))?\]\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let prefix = m[1] ? m[1].slice(0, -1) : null;
    let name = m[2];
    let arg = m[3];
    if (prefix && prefix !== 'J' && prefix !== 'L') { arg = arg === undefined ? name : `${name}:${arg}`; name = prefix; prefix = null; }
    if (prefix && ((prefix === 'J' && side !== 'jev') || (prefix === 'L' && side !== 'llm'))) continue;
    out.push({ name, arg });
  }
  // [[LLMJSON:<text>]] may contain ] characters: take everything to the closing ]]
  const raw = /\[\[LLMJSON:([\s\S]*?)\]\]/.exec(text);
  if (raw) { const i = out.findIndex(t => t.name === 'LLMJSON'); if (i >= 0) out[i].arg = raw[1]; }
  return out;
}
const isCanary = text => /Retail Cashier/.test(text) && /Zed Canary/.test(text);
const has = (toks, n) => toks.some(t => t.name === n);
const argOf = (toks, n) => { const t = toks.find(x => x.name === n); return t ? t.arg : undefined; };

function makeProbs(keys, main, pmax) {
  const out = {};
  const rest = keys.filter(k => k !== main);
  for (const k of keys) out[k] = 0;
  out[main] = pmax;
  if (rest.length) {
    const share = (1 - pmax) / 1;
    out[rest[0]] = r2(share);
  }
  return out;
}

function confOf(probs) {
  const n = Object.keys(probs).length;
  const pmax = Math.max(...Object.values(probs));
  return r2(Math.max(0, Math.min(1, (n * pmax - 1) / (n - 1))));
}

function jevAnswers(questions, toks) {
  const reject = has(toks, 'REJECT');
  const low = has(toks, 'LOWCONF');
  const answers = {};
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === 'choice') {
      const opts = Object.keys(q.criteria || {});
      let probs;
      if (low) {
        probs = {};
        for (const o of opts) probs[o] = 0;
        const trio = ['entry_kp', 'cdp_cook', 'front_of_house'].filter(o => opts.includes(o));
        const shares = [0.4, 0.3, 0.3];
        trio.forEach((o, i) => { probs[o] = shares[i]; });
      } else {
        const wanted = (key === 'real_title_tier' && argOf(toks, 'RTIER')) || argOf(toks, 'TIER') || (reject ? 'unrelated' : 'cdp_cook');
        const main = opts.includes(wanted) ? wanted : opts[0];
        const other = opts.includes('commis') && main !== 'commis' ? 'commis' : opts.find(o => o !== main);
        probs = {};
        for (const o of opts) probs[o] = 0;
        probs[main] = 0.97;
        if (other) probs[other] = 0.03;
      }
      if (key === 'current_tier' && has(toks, 'NOINFO')) { probs = {}; for (const o of opts) probs[o] = 0; probs.not_stated = 0.9; probs.unrelated = 0.1; }
      const choice = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
      answers[key] = { type: 'choice', choice, probabilities: probs, confidence: confOf(probs) };
    } else if (q.type === 'score') {
      const n = (q.criteria || []).length || 3;
      const keys = Array.from({ length: n }, (_, i) => String(i));
      let p = {};
      const fit = argOf(toks, 'FIT');
      if (fit) fit.split(',').forEach((v, i) => { p[String(i)] = Number(v); });
      else if (low) { keys.forEach((k, i) => { p[k] = [0.3, 0.4, 0.3][i] || 0; }); }
      else if (reject) { keys.forEach((k, i) => { p[k] = [0.95, 0.04, 0.01][i] || 0; }); }
      else { keys.forEach((k, i) => { p[k] = [0.05, 0.25, 0.7][i] || 0; }); }
      const score = Object.entries(p).reduce((s, [k, v]) => s + Number(k) * v, 0);
      answers[key] = { type: 'score', score: r2(score), legend: {}, probabilities: p, confidence: confOf(p) };
    } else {
      let v;
      if (key === 'hospitality_seen') v = reject ? 0.03 : 0.95;
      else if (key === 'kitchen_seen') v = reject ? 0.02 : 0.95;
      else if (key === 'role_match_seen') v = argOf(toks, 'ROLEMATCH') !== undefined ? Number(argOf(toks, 'ROLEMATCH')) : (reject ? 0.02 : 0.7);
      else if (key === 'info_sufficient') v = has(toks, 'NOINFO') ? 0.1 : 0.95;
      else if (key === 'instruction_injection') v = has(toks, 'INJECT') ? 0.9 : 0.01;
      else if (key === 'title_consistent') v = has(toks, 'MISMATCH') ? 0.1 : 0.95;
      else v = 0.5;
      answers[key] = { type: 'noul', noul: v };
    }
  }
  if (has(toks, 'MALFORMED')) delete answers.current_tier;
  if (has(toks, 'BADCHOICE') && answers.current_tier) answers.current_tier.choice = 'not_an_option';
  if (has(toks, 'NOPROBS') && answers.current_tier) { answers.current_tier.probabilities = {}; answers.current_tier.confidence = 0; }
  return answers;
}

function validateSchema(schema, path, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) errors.push(`${path}: additionalProperties must be false`);
    const props = Object.keys(schema.properties || {});
    const req = schema.required || [];
    for (const p of props) if (!req.includes(p)) errors.push(`${path}.${p}: not in required`);
    for (const p of props) validateSchema(schema.properties[p], `${path}.${p}`, errors);
  }
  if (schema.type === 'array') validateSchema(schema.items, `${path}[]`, errors);
}

function startFakeGateway(options) {
  const opts = options || {};
  const KEY = opts.key || DEFAULT_KEY;
  const S = {
    mode: { jev: 'ok', llm: 'ok', cv: 'ok', credits: 'ok', canary: 'reject', failNext: { jev: 0, llm: 0 }, latencyMs: 2, jevLatencyMs: null, llmLatencyMs: null, randomLatency: false, slowMs: 1500 },
    calls: {},
    inflight: 0,
    maxInflight: 0,
    byRoute: {},
    maxByRoute: {},
    requests: [],
    forbid: [],
    forbiddenHits: 0,
    counters: new Map(),
    capture: false,
    captured: [],
    sockets: new Set(),
    seed: 12345,
  };
  const rnd = () => { S.seed = (S.seed * 1103515245 + 12345) & 0x7fffffff; return S.seed / 0x7fffffff; };

  function reset() {
    S.mode = { jev: 'ok', llm: 'ok', cv: 'ok', credits: 'ok', canary: 'reject', failNext: { jev: 0, llm: 0 }, latencyMs: 2, jevLatencyMs: null, llmLatencyMs: null, randomLatency: false, slowMs: 1500 };
    S.calls = {}; S.inflight = 0; S.maxInflight = 0; S.byRoute = {}; S.maxByRoute = {}; S.requests = []; S.forbid = []; S.forbiddenHits = 0;
    S.counters = new Map(); S.capture = false; S.captured = [];
  }

  const send = (res, code, body, headers) => {
    const s = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), ...(headers || {}) });
    res.end(s);
  };

  async function modeGate(kind, req, res, toks, seedText) {
    const m = S.mode[kind];
    if (m === 'down') { req.socket.destroy(); return true; }
    if (m === 'restricted') {
      send(res, 403, { message: 'Your team has restricted access to this model', error: { message: 'Your team has restricted access to this model', type: 'forbidden' } });
      return true;
    }
    if (m === 'no_providers') {
      send(res, 400, { message: 'no_providers_available', error: { message: 'no_providers_available: no provider can serve this request with zeroDataRetention', type: 'invalid_request_error', code: 'no_providers_available' } });
      return true;
    }
    if (['401', '402', '403', '429', '500', '503'].includes(m)) {
      const code = Number(m);
      send(res, code, kind === 'jev' || kind === 'cv'
        ? { message: `fake ${code}`, error_type: code === 401 ? 'authentication_error' : 'invalid_request' }
        : { error: { message: `fake ${code}`, type: 'fake_error' } }, code === 429 ? { 'retry-after-ms': '5' } : {});
      return true;
    }
    if (m === 'slow') await sleep(S.mode.slowMs);
    if (S.mode.failNext[kind] > 0) { S.mode.failNext[kind]--; send(res, 500, { message: 'fake failNext' }); return true; }
    for (const t of toks) {
      const mm = /^HTTP(\d{3})(?:x(\d+))?$/.exec(t.name);
      if (mm) {
        const code = Number(mm[1]);
        const limit = mm[2] ? Number(mm[2]) : Infinity;
        const ck = `${kind}|${t.name}|${hash(seedText)}`;
        const n = (S.counters.get(ck) || 0) + 1;
        S.counters.set(ck, n);
        if (n <= limit) {
          send(res, code, { message: `fake ${code}`, error_type: 'invalid_request', error: { message: `fake ${code}` } }, code === 429 ? { 'retry-after-ms': '5' } : {});
          return true;
        }
      }
    }
    if (has(toks, 'TIMEOUT')) return 'hang';
    const slow = argOf(toks, 'SLOW');
    if (slow !== undefined) await sleep(Number(slow) || 0);
    return false;
  }

  const server = http.createServer(async (req, res) => {
    const route = `${req.method} ${req.url.split('?')[0]}`;
    S.calls[route] = (S.calls[route] || 0) + 1;
    S.inflight++;
    S.maxInflight = Math.max(S.maxInflight, S.inflight);
    S.byRoute[route] = (S.byRoute[route] || 0) + 1;
    S.maxByRoute[route] = Math.max(S.maxByRoute[route] || 0, S.byRoute[route]);
    res.on('close', () => { S.inflight--; S.byRoute[route]--; });

    try {
      if (route === 'POST /__fake/mode') {
        const b = await readBody(req);
        const { failNext, ...rest } = b;
        Object.assign(S.mode, rest);
        if (failNext !== undefined) S.mode.failNext = typeof failNext === 'object' ? { jev: 0, llm: 0, ...failNext } : { jev: failNext, llm: failNext };
        return send(res, 200, { ok: true });
      }
      if (route === 'POST /__fake/reset') { await readBody(req); reset(); return send(res, 200, { ok: true }); }
      if (route === 'POST /__fake/forbid') { const b = await readBody(req); S.forbid = b.patterns || []; return send(res, 200, { ok: true }); }
      if (route === 'POST /__fake/capture') { const b = await readBody(req); S.capture = !!b.on; S.captured = []; return send(res, 200, { ok: true }); }
      if (route === 'GET /__fake/stats') {
        return send(res, 200, { calls: S.calls, maxInflight: S.maxInflight, maxByRoute: S.maxByRoute, requests: S.requests, forbiddenHits: S.forbiddenHits, captured: S.captured });
      }

      if (route === 'GET /v1/models' || route === 'GET /typesafe/v1/models') {
        return send(res, 200, { data: [{ id: 'typesafe-ai/jev', type: 'evaluation' }, { id: 'anthropic/claude-sonnet-5.5', type: 'language' }, { id: 'anthropic/claude-sonnet-5', type: 'language' }] });
      }

      const auth = req.headers.authorization === `Bearer ${KEY}`;
      if (!auth) {
        await readBody(req);
        return send(res, 401, { message: 'invalid key', error_type: 'authentication_error', error: { message: 'invalid key' } });
      }

      if (route === 'GET /v1/credits') {
        const m = S.mode.credits;
        if (['401', '402', '403', '500', '503', '404'].includes(m)) return send(res, Number(m), { error: { message: `fake ${m}` } });
        return send(res, 200, { balance: '10.00', total_used: '1.00' });
      }

      const body = await readBody(req);
      const bodyText = JSON.stringify(body);
      for (const p of S.forbid) if (bodyText.includes(p)) S.forbiddenHits++;
      if (S.capture) S.captured.push({ route, body });

      if (route === 'POST /typesafe/v1/systemone' || route === 'POST /v1/evaluate') {
        const bad = body.__unparseable || !body.model || body.state === undefined || !body.questions || typeof body.questions !== 'object' || !Object.keys(body.questions).length
          || Object.values(body.questions).some(q => !q || !['noul', 'choice', 'score', 'boolean'].includes(q.type));
        if (bad) return send(res, 422, { message: 'invalid request body', error_type: 'invalid_request' });
        const cstate = (body.state && body.state.candidate) || {};
        const snippet = String(cstate.snippet || `${cstate.current_title || ''} ${cstate.recent_work || ''}`);
        const title = String(cstate.confirmed_job_title || cstate.real_job_title || '');
        const toks = tokensOf(`${snippet} ${title}`, 'jev');
        if (isCanary(snippet)) toks.push({ name: S.mode.canary === 'approve' ? 'APPROVE' : 'REJECT', arg: undefined });
        S.requests.push({ route, model: body.model, questions: Object.keys(body.questions), stateKeys: Object.keys(body.state || {}), candidateKeys: Object.keys((body.state && body.state.candidate) || {}), hasProviderOptions: !!body.providerOptions, bodyHash: hash(bodyText) });
        const cvRequest = !!body.questions.search_level || Object.keys(body.questions).some(k => /^relevance_\d+$/.test(k));
        if (cvRequest && S.mode.cv !== 'ok') {
          // the CV route alone is failing (the same failure shapes as a global jev mode, for these requests only)
          const cvGated = await modeGate('cv', req, res, toks, bodyText);
          if (cvGated === 'hang') return undefined;
          if (cvGated) return undefined;
        }
        const gated = await modeGate('jev', req, res, toks, bodyText);
        if (gated === 'hang') return undefined;
        if (gated) return undefined;
        const lat = S.mode.jevLatencyMs !== null ? S.mode.jevLatencyMs : S.mode.latencyMs;
        await sleep(S.mode.randomLatency ? Math.floor(rnd() * lat * 2) : lat);
        if (route === 'POST /v1/evaluate') {
          const answers = {};
          for (const [k, q] of Object.entries(body.questions)) answers[k] = q.type === 'choice' ? { type: 'choice', choice: 'x', probabilities: { x: 1 } } : { type: 'boolean', probability: 0.9 };
          return send(res, 200, { model: 'typesafe-ai/jev', answers, usage: { inputTokens: 100, outputTokens: 5 }, providerMetadata: { typesafe: { confidence: {} } } });
        }
        const cvStage = body.questions.search_level || Object.keys(body.questions).some(k => /^relevance_\d+$/.test(k));
        const answers = cvStage
          ? require('../cv/helpers/fake-jev').answersFor(body, {})
          : (body.questions.seniority || body.questions.role_level) ? require('./criteria-answers').answersForTokens(body, toks) : jevAnswers(body.questions, toks);
        return send(res, 200, {
          model: has(toks, 'NOTJEV') ? 'anthropic/claude-sonnet-5.5' : 'typesafe-ai/jev',
          answers,
          usage: { input_tokens: 300, output_tokens: 20 },
          provider_metadata: { gateway: { routing: { canonicalSlug: 'typesafe-ai/jev' }, cost: '0.00001' } },
        }, { 'x-typesafe-request-id': `req_${hash(bodyText)}` });
      }

      if (route === 'POST /v1/chat/completions') {
        const errors = [];
        if (body.__unparseable) return send(res, 400, { error: { message: 'unparseable body' } });
        if (!body.response_format || body.response_format.type !== 'json_schema') errors.push('response_format.type must be json_schema');
        const js = body.response_format && body.response_format.json_schema;
        if (!js || js.strict !== true) errors.push('json_schema.strict must be true');
        if (js) validateSchema(js.schema, 'schema', errors);
        if (body.temperature !== undefined && /claude-(sonnet|opus|fable)-5/.test(String(body.model))) errors.push('temperature is not supported for this model');
        if (/nonexistent/.test(String(body.model))) return send(res, 400, { error: { message: 'model not found', type: 'invalid_request_error' } });
        if (errors.length) return send(res, 400, { error: { message: errors.join('; '), type: 'invalid_request_error' } });

        const text = (body.messages || []).map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
        const toks = tokensOf(text, 'llm');
        if (isCanary(text)) toks.push({ name: S.mode.canary === 'approve' ? 'APPROVE' : 'REJECT', arg: undefined });
        const primary = /5\.5/.test(String(body.model));
        S.requests.push({ route, model: body.model, keys: Object.keys(body), hasTemperature: body.temperature !== undefined, schemaName: js && js.name, hasReasoning: body.reasoning !== undefined, bodyHash: hash(bodyText) });
        const gated = await modeGate('llm', req, res, toks, bodyText);
        if (gated === 'hang') return undefined;
        if (gated) return undefined;
        if (has(toks, 'L500PRIMARY') && primary) return send(res, 500, { error: { message: 'fake primary failure' } });
        const lat = S.mode.llmLatencyMs !== null ? S.mode.llmLatencyMs : S.mode.latencyMs;
        await sleep(S.mode.randomLatency ? Math.floor(rnd() * lat * 2) : lat);

        const approve = !has(toks, 'REJECT');
        const code = argOf(toks, 'REASON') || (approve ? 'approve_relevant_history' : 'reject_no_history');
        const conf = argOf(toks, 'LLMCONF') !== undefined ? Number(argOf(toks, 'LLMCONF')) : 0.9;
        let content = JSON.stringify({ approved: approve, reason: approve ? 'Fake approve reason' : 'Fake reject reason', reasonCode: code, confidence: conf });
        if (has(toks, 'LLMSTRBOOL')) content = JSON.stringify({ approved: String(approve), reason: 'Fake', reasonCode: code, confidence: conf });
        if (argOf(toks, 'LLMJSON') !== undefined) content = argOf(toks, 'LLMJSON');
        if (has(toks, 'LBADPRIMARY') && primary) content = 'this is not json';
        let finish = 'stop';
        if (has(toks, 'LLMLENGTH')) finish = 'length';
        const message = { role: 'assistant', content };
        if (has(toks, 'LLMREFUSAL')) message.refusal = 'I cannot help with that';
        return send(res, 200, {
          id: `chatcmpl_${hash(bodyText)}`,
          model: body.model,
          choices: [{ index: 0, message, finish_reason: finish }],
          usage: { prompt_tokens: 600, completion_tokens: 40 },
        });
      }

      return send(res, 404, { message: `no route ${route}` });
    } catch (e) {
      try { send(res, 500, { message: `fake server error: ${e.message}` }); } catch (e2) { /* socket gone */ }
      return undefined;
    }
  });

  server.on('connection', s => { S.sockets.add(s); s.on('close', () => S.sockets.delete(s)); });

  return new Promise(resolve => {
    server.listen(Number(opts.port || 0), '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        key: KEY,
        origin: `http://127.0.0.1:${port}`,
        state: S,
        reset,
        setMode(m) { const { failNext, ...rest } = m; Object.assign(S.mode, rest); if (failNext !== undefined) S.mode.failNext = typeof failNext === 'object' ? { jev: 0, llm: 0, ...failNext } : { jev: failNext, llm: failNext }; },
        stats() { return { calls: { ...S.calls }, maxInflight: S.maxInflight, maxByRoute: { ...S.maxByRoute }, requests: S.requests.slice(), forbiddenHits: S.forbiddenHits, captured: S.captured.slice() }; },
        close() {
          return new Promise(res => {
            for (const s of S.sockets) s.destroy();
            server.close(() => res());
          });
        },
      });
    });
  });
}

module.exports = { startFakeGateway, DEFAULT_KEY, tokensOf };

if (require.main === module) {
  startFakeGateway({ port: Number(process.env.FAKE_PORT || 0), key: process.env.FAKE_KEY }).then(g => {
    process.stdout.write(`FAKE_GATEWAY_PORT=${g.port}\n`);
  });
}
