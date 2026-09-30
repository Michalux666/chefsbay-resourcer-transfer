'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'criteria-test-'));
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* Windows may still hold a handle */ } });

for (const k of Object.keys(process.env)) if (/^SCREEN_|^AI_GATEWAY|^RESOURCER_|^HERMES_/.test(k)) delete process.env[k];
process.env.RESOURCER_HOME = HOME;
process.env.HERMES_HOME = HOME;
process.env.RESOURCER_ENV_FILE = path.join(HOME, 'none.env');
process.env.AI_GATEWAY_API_KEY = 'fake-test-key';
process.env.SCREEN_BACKOFF_BASE_MS = '5';
process.env.SCREEN_CACHE_TTL_SEC = '0';
process.env.SCREEN_RETRY_AFTER_CAP_MS = '50';

// in the repo the library sits two levels up; in the screening lab it is the assembled build next to the patch
function findRoot() {
  const here = path.resolve(__dirname, '..', '..');
  const spots = [here, path.resolve(here, '..', 'build'), path.resolve(here, 'build')];
  for (const s of spots) if (fs.existsSync(path.join(s, 'resourcer', 'scripts', 'lib', 'screening', 'http.js'))) return s;
  throw new Error('the screening library was not found next to these tests');
}

const ROOT = findRoot();
const LIB = path.join(ROOT, 'resourcer', 'scripts', 'lib');
const PACKAGED = path.join(ROOT, 'resourcer', 'config', 'screening-criteria.json');

const lib = name => path.join(LIB, name);
const { answersFor } = require('./criteria-fake-answers');

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ __bad: true }); } });
  });
}

// options.respond(idx, body) may return { status, body, delayMs } to override the answer to request number idx (1-based)
function startGateway(options) {
  const o = options || {};
  const state = { requests: 0, bodies: [], roleRequests: 0 };
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const send = (code, obj) => { const s = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) }); res.end(s); };
    if (req.method !== 'POST' || req.url !== '/typesafe/v1/systemone') return send(404, { message: 'no route' });
    if (req.headers.authorization !== 'Bearer fake-test-key') return send(401, { message: 'invalid key' });
    const idx = ++state.requests;
    state.bodies.push(body);
    if (body.questions && body.questions.role_level && !body.state.candidate) state.roleRequests++;
    if (o.roleDelayMs && !body.state.candidate) await new Promise(x => setTimeout(x, o.roleDelayMs));
    if (o.respond) {
      const r = o.respond(idx, body);
      if (r) {
        if (r.delayMs) await new Promise(x => setTimeout(x, r.delayMs));
        return send(r.status || 200, r.body || {});
      }
    }
    return send(200, { model: 'typesafe-ai/jev', answers: answersFor(body), usage: { input_tokens: 300, output_tokens: 20 } });
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        state,
        close: () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
      });
    });
  });
}

function loadConfig(origin, overrides) {
  const config = require(lib('screening/config'));
  return config.load({ getEnv: () => undefined, file: 'no-such-file.json', overrides: { gateway: { origin }, ...(overrides || {}) } });
}

function card(title, history, opts) {
  const o = opts || {};
  const act = o.active ? ` Active ${o.active}` : '';
  return `${title} | Leeds, <PC> Unlock candidate ${o.apps || '3 applications in last 30 days'}${act} Updated ${o.updated || '5 days ago'} Never unlocked Recent experience Other CV snippets ${history || 'Not available'}`;
}

function writeCriteria(mutate, name) {
  const obj = JSON.parse(fs.readFileSync(PACKAGED, 'utf8'));
  if (mutate) mutate(obj);
  const f = path.join(HOME, name || `criteria-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(f, JSON.stringify(obj, null, 2));
  return f;
}

function packaged() {
  return JSON.parse(fs.readFileSync(PACKAGED, 'utf8'));
}

module.exports = { HOME, ROOT, LIB, PACKAGED, lib, startGateway, loadConfig, card, writeCriteria, packaged };
