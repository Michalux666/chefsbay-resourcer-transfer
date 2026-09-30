'use strict';
/*
 * Loaded into every Node process of the rehearsal through NODE_OPTIONS=--require (the only test
 * injection the pipeline sees besides speed knobs). It stands in for the internet:
 *   - the hosts the pipeline is allowed to reach are redirected to the local fakes named in
 *     $E2E_SERVICES_FILE ({ "map": { "recruit.zoho.eu": 43001, ... } });
 *   - a request to anything else that is not loopback throws and is recorded in $E2E_NETLOG.
 * A clock file ($E2E_CLOCK_FILE, JSON [{ atRealMs, addMs }]) can move the wall clock forward for every
 * process at once, the way a resumed instance sees it: Date.now(), new Date() and file mtimes read
 * through fs.stat all shift for files written after the jump. The monotonic clock is left alone.
 */
const fs = require('fs');

const SERVICES_FILE = process.env.E2E_SERVICES_FILE;
const NETLOG = process.env.E2E_NETLOG;
const CLOCK_FILE = process.env.E2E_CLOCK_FILE;

function logNet(rec) {
  if (!NETLOG) return;
  try { fs.appendFileSync(NETLOG, JSON.stringify(Object.assign({ t: new Date().toISOString(), pid: process.pid }, rec)) + '\n'); } catch { /* best effort */ }
}

let servicesCache = { at: 0, map: {} };
function services() {
  const now = Date.now();
  if (now - servicesCache.at < 500) return servicesCache.map;
  let map = {};
  try { map = JSON.parse(fs.readFileSync(SERVICES_FILE, 'utf8')).map || {}; } catch { /* none yet */ }
  servicesCache = { at: now, map };
  return map;
}

const isLoopback = (h) => h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';

if (SERVICES_FILE) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    let u;
    try { u = new URL(url); } catch { return realFetch(input, init); }
    if (isLoopback(u.hostname)) return realFetch(input, init);
    const port = services()[u.hostname];
    if (!port) {
      logNet({ blocked: u.hostname, path: u.pathname });
      return Promise.reject(new TypeError(`e2e net guard: ${u.hostname} is not reachable in the rehearsal`));
    }
    const headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
    headers.set('x-e2e-host', u.hostname);
    const next = `http://127.0.0.1:${port}${u.pathname}${u.search}`;
    if (typeof input === 'string' || input instanceof URL) return realFetch(next, Object.assign({}, init, { headers }));
    return realFetch(new Request(next, input), Object.assign({}, init, { headers }));
  };

  for (const modName of ['http', 'https']) {
    const mod = require(modName);
    const realRequest = mod.request;
    const wrap = function guardedRequest(...args) {
      let host = null;
      const a0 = args[0];
      if (typeof a0 === 'string') { try { host = new URL(a0).hostname; } catch { host = null; } }
      else if (a0 instanceof URL) host = a0.hostname;
      else if (a0 && typeof a0 === 'object') host = a0.hostname || (a0.host ? String(a0.host).split(':')[0] : null);
      if (host && !isLoopback(host)) {
        logNet({ blocked: host, via: modName });
        throw new Error(`e2e net guard: ${host} is not reachable in the rehearsal`);
      }
      return realRequest.apply(mod, args);
    };
    mod.request = wrap;
    mod.get = function guardedGet(...args) { const r = wrap(...args); r.end(); return r; };
  }
}

if (CLOCK_FILE) {
  let cache = { at: 0, jumps: [] };
  const jumps = () => {
    const now = process.hrtime.bigint();
    if (cache.at && now - cache.at < 20000000n) return cache.jumps;
    let j = [];
    try { j = JSON.parse(fs.readFileSync(CLOCK_FILE, 'utf8')); } catch { j = []; }
    cache = { at: now, jumps: Array.isArray(j) ? j : [] };
    return cache.jumps;
  };
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  // offset for an instant read from the real clock at realMs
  const offsetAt = (realMs) => jumps().reduce((s, j) => (realMs >= j.atRealMs ? s + j.addMs : s), 0);
  const nowShifted = () => { const r = realNow(); return r + offsetAt(r); };
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(nowShifted()); else super(...args);
    }
    static now() { return nowShifted(); }
  }
  globalThis.Date = ShiftedDate;

  const shiftStats = (st) => {
    if (!st) return st;
    const real = st.mtimeMs;
    const add = offsetAt(real);
    if (!add) return st;
    for (const k of ['atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs']) if (typeof st[k] === 'number') st[k] += add;
    for (const k of ['atime', 'mtime', 'ctime', 'birthtime']) if (st[k] instanceof RealDate) st[k] = new RealDate(st[k].getTime() + add);
    return st;
  };
  // a process that stamps a file with its (shifted) clock stores the real instant, so the stat shift above is not applied twice
  const toReal = (t) => {
    if (t instanceof RealDate) return new RealDate(t.getTime() - offsetAt(realNow()));
    if (typeof t === 'number') return t - offsetAt(realNow()) / 1000;
    return t;
  };
  for (const name of ['utimesSync', 'futimesSync']) {
    const orig = fs[name];
    fs[name] = function stamped(target, a, m) { return orig.call(fs, target, toReal(a), toReal(m)); };
  }
  const origUtimes = fs.utimes;
  fs.utimes = function stamped(target, a, m, cb) { return origUtimes.call(fs, target, toReal(a), toReal(m), cb); };
  for (const name of ['statSync', 'lstatSync', 'fstatSync']) {
    const orig = fs[name];
    fs[name] = function shifted(...args) {
      const r = orig.apply(fs, args);
      return shiftStats(r);
    };
  }
  for (const name of ['stat', 'lstat', 'fstat']) {
    const orig = fs[name];
    fs[name] = function shifted(...args) {
      const cb = args[args.length - 1];
      if (typeof cb !== 'function') return orig.apply(fs, args);
      args[args.length - 1] = (err, st) => cb(err, err ? st : shiftStats(st));
      return orig.apply(fs, args);
    };
  }
}
