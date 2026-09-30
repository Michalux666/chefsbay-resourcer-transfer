'use strict';
/*
 * Mock of the Caterer recruiter site for the fake agent-browser: a tiny DOM (just enough for the
 * selectors the pipeline scripts use), a React-style controlled-input model (a raw `.value =`
 * assignment is NOT seen by the form, the native prototype setter plus an input event is), and the
 * routes/redirects the incident notes describe. All data is synthetic.
 */
const vm = require('vm');

const HOST = 'recruiter.caterer.com';
const HOME_PATH = '/Home/1368655';

// ------------------------------------------------------------------ selectors

function parseCompound(s) {
  const c = { tag: null, classes: [], attrs: [], nots: [] };
  let rest = s.trim();
  let m = rest.match(/^[a-zA-Z][\w-]*/);
  if (m) { c.tag = m[0].toLowerCase(); rest = rest.slice(m[0].length); }
  while (rest.length) {
    if ((m = rest.match(/^\.([\w-]+)/))) { c.classes.push(m[1]); rest = rest.slice(m[0].length); continue; }
    if ((m = rest.match(/^:not\(\[([^\]]+)\]\)/))) { c.nots.push(parseAttr(m[1])); rest = rest.slice(m[0].length); continue; }
    if ((m = rest.match(/^\[([^\]]+)\]/))) { c.attrs.push(parseAttr(m[1])); rest = rest.slice(m[0].length); continue; }
    throw new Error('fake selector engine cannot parse: ' + s);
  }
  return c;
}
function parseAttr(body) {
  const m = body.match(/^([\w-]+)\s*(\*?=)?\s*(.*)$/);
  return { name: m[1], op: m[2] || null, val: (m[3] || '').replace(/^["']|["']$/g, '') };
}
function attrMatches(el, a) {
  const v = el.getAttribute(a.name);
  if (a.op === null) return v !== null;
  if (v === null) return false;
  return a.op === '=' ? v === a.val : v.indexOf(a.val) !== -1;
}
function compoundMatches(el, c) {
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
  for (const k of c.classes) if (!el.classList.includes(k)) return false;
  for (const a of c.attrs) if (!attrMatches(el, a)) return false;
  for (const a of c.nots) if (attrMatches(el, a)) return false;
  return true;
}
function selectorMatches(el, selector) {
  return selector.split(',').some((part) => {
    const comps = part.trim().split(/\s+/).map(parseCompound);
    if (!compoundMatches(el, comps[comps.length - 1])) return false;
    let anc = el.parent, i = comps.length - 2;
    while (i >= 0) {
      while (anc && !compoundMatches(anc, comps[i])) anc = anc.parent;
      if (!anc) return false;
      anc = anc.parent; i--;
    }
    return true;
  });
}

// ------------------------------------------------------------------ DOM

class FakeEvent { constructor(type, init) { this.type = type; this.bubbles = !!(init && init.bubbles); } }

class Element {
  constructor(tag, attrs, text) {
    this.tagName = tag.toUpperCase();
    this._attrs = Object.assign({}, attrs || {});
    this.classList = String(this._attrs.class || '').split(/\s+/).filter(Boolean);
    this.textContent = text || '';
    this.parent = null;
    this.children = [];
    this._listeners = {};
  }
  get type() { return this._attrs.type || ''; }
  get name() { return this._attrs.name || ''; }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? String(this._attrs[n]) : null; }
  append(child) { child.parent = this; this.children.push(child); return child; }
  all() { const out = []; const walk = (e) => { for (const c of e.children) { out.push(c); walk(c); } }; walk(this); return out; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  dispatchEvent(ev) { for (const fn of this._listeners[ev.type] || []) fn(ev); if (this._onEvent) this._onEvent(ev); return true; }
  click() { if (this._onClick) this._onClick(); }
}

let nativeSetSeq = 0;
class HTMLInputElement extends Element {}
// The "native" setter: writes the DOM value but bypasses the framework's value tracker.
Object.defineProperty(HTMLInputElement.prototype, 'value', {
  configurable: true,
  get() { return this._domValue === undefined ? '' : this._domValue; },
  set(v) { this._domValue = String(v); this._nativeSeq = ++nativeSetSeq; },
});

function makeInput(attrs) {
  const el = new HTMLInputElement('input', attrs);
  el._tracker = '';
  el._reactValue = '';
  // Framework-style instance override: a plain `el.value = x` updates the tracker, so the next
  // input event looks like "no change" and the controlled state never sees the value.
  Object.defineProperty(el, 'value', {
    configurable: true,
    get() { return this._domValue === undefined ? '' : this._domValue; },
    set(v) { this._domValue = String(v); this._tracker = this._domValue; },
  });
  el._onEvent = (ev) => {
    if (ev.type === 'input' || ev.type === 'change') {
      if (el._domValue !== el._tracker) { el._reactValue = el._domValue; el._tracker = el._domValue; }
    }
  };
  return el;
}

function makeDocument(root, title, text, hooks) {
  const doc = {
    title,
    body: { innerText: text },
    querySelector(sel) { return root.all().find((e) => selectorMatches(e, sel)) || null; },
    querySelectorAll(sel) { return root.all().filter((e) => selectorMatches(e, sel)); },
  };
  hooks.doc = doc;
  return doc;
}

// ------------------------------------------------------------------ pages

function fmtCredits(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

function classifyUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return { kind: 'other', url: urlStr }; }
  if (u.hostname !== HOST) return { kind: 'other', url: urlStr };
  const p = u.pathname;
  if (/^\/login\/TwoFaAuthRedirect/i.test(p)) return { kind: 'verify', token: u.searchParams.get('token'), url: urlStr };
  if (/^\/login\/?$/i.test(p)) return { kind: 'login', url: urlStr };
  if (/SafeListLoginBlocked/i.test(p)) return { kind: 'safelistpage', url: urlStr };
  if (/^\/Home(\/\d+)?\/?$/i.test(p)) return { kind: 'home', url: urlStr };
  if (/^\/CandidateSearchWebMvc\/CandidateSearch/i.test(p)) return { kind: 'search', url: urlStr };
  if (/^\/Error/i.test(p)) return { kind: 'errorpage', url: urlStr };
  return { kind: 'protected', url: urlStr };
}

function expiredRedirectUrl(site, orig) {
  const rp = encodeURIComponent(new URL(orig).pathname);
  return site.expiredRedirect === 'login'
    ? `https://${HOST}/login?ReturnUrl=${rp}`
    : `https://${HOST}/?ReturnUrl=${rp}`;
}

/** Navigate: mutates browser state. Returns {ok:boolean, error?:string}. */
function navigate(state, site, urlStr) {
  state.form = null;
  if (site.dnsBroken) return { ok: false, error: 'Navigation failed: net::ERR_NAME_NOT_RESOLVED' };
  const c = classifyUrl(urlStr);
  const setPage = (kind, url) => { state.page = kind; state.url = url; state.hasFingerprint = state.hasFingerprint || kind !== 'other'; };
  if (c.kind === 'other') { state.page = 'generic'; state.url = urlStr; return { ok: true }; }
  if (c.kind === 'verify') {
    const good = site.acceptAnyToken || c.token === site.validToken;
    if (good && state.page === 'safelist') {
      state.loggedIn = true; state.hasFingerprint = true; state.knownDevice = true; state.safelistCleared = true;
      state.counters.verified = (state.counters.verified || 0) + 1;
      setPage('home', `https://${HOST}${HOME_PATH}`);
    } else {
      state.counters.staleTokens = (state.counters.staleTokens || 0) + 1;
      setPage('safelist', `https://${HOST}/Account/Unauthenticated/SafeListLoginBlocked`);
    }
    return { ok: true };
  }
  if (c.kind === 'safelistpage') { setPage('safelist', urlStr); return { ok: true }; }
  if (c.kind === 'errorpage') { setPage('error', urlStr); return { ok: true }; }
  if (c.kind === 'login') {
    if (state.loggedIn) setPage('home', `https://${HOST}${HOME_PATH}`);
    else setPage('login', urlStr);
    return { ok: true };
  }
  // protected pages
  if (!state.loggedIn) { setPage('login', expiredRedirectUrl(site, urlStr)); return { ok: true }; }
  if (c.kind === 'search' && site.cvdbModuleError) {
    state.url = 'chrome-error://chromewebdata/'; state.page = 'chromeerror';
    return { ok: false, error: 'Navigation failed: net::ERR_TOO_MANY_REDIRECTS' };
  }
  if (c.kind === 'home') { setPage('home', `https://${HOST}${HOME_PATH}`); return { ok: true }; }
  if (c.kind === 'search') { setPage('search', urlStr); return { ok: true }; }
  setPage('protected', urlStr);
  return { ok: true };
}

function submitLogin(state, site, form) {
  const creds = site.credentials || {};
  const u = form.u._reactValue, p = form.p._reactValue;
  state.counters.submits = (state.counters.submits || 0) + 1;
  if (!u && !p) { state.counters.emptySubmits = (state.counters.emptySubmits || 0) + 1; return; }
  const mode = (site.login && site.login.mode) || 'success';
  if (u !== creds.username || p !== creds.password || mode === 'badpassword') {
    state.counters.badLogins = (state.counters.badLogins || 0) + 1;
    state.page = 'login'; state.loginError = true;
    return;
  }
  const blocked = mode === 'safelist' || (mode === 'safelistUnlessFingerprint' && !state.knownDevice);
  if (mode === 'stay') return;
  if (blocked) {
    state.counters.safelistEmails = (state.counters.safelistEmails || 0) + 1;
    state.page = 'safelist'; state.url = `https://${HOST}/Account/Unauthenticated/SafeListLoginBlocked`;
    return;
  }
  state.loggedIn = true; state.hasFingerprint = true; state.knownDevice = true;
  state.page = 'home'; state.url = `https://${HOST}${HOME_PATH}`;
}

function buildPage(state, site) {
  const root = new Element('html');
  const hooks = { form: null };
  let title = 'Caterer', text = '';
  const kind = state.page;
  if (kind === 'login') {
    title = 'Sign in'; text = 'Sign in to Caterer Recruiter';
    if (site.cookieBanner && !state.bannerDismissed) {
      const b = new Element('button', { class: 'cookie-banner' }, 'Just necessary');
      b._onClick = () => { state.bannerDismissed = true; };
      root.append(b);
      root.append(new Element('button', { class: 'cookie-banner' }, 'Accept all'));
    }
    const form = root.append(new Element('form'));
    const variant = site.loginFormVariant === 'email-type';
    const u = form.append(makeInput(variant ? { type: 'email' } : { name: 'username', type: 'text' }));
    const p = form.append(makeInput(variant ? { type: 'password' } : { name: 'password', type: 'password' }));
    form.append(makeInput({ name: 'csrf', type: 'hidden' }));
    const f0 = state.form || {};
    u._domValue = f0.ud; u._tracker = f0.ud === undefined ? '' : f0.ud; u._reactValue = f0.u || '';
    p._domValue = f0.pd; p._tracker = f0.pd === undefined ? '' : f0.pd; p._reactValue = f0.p || '';
    const btn = form.append(new Element('button', { type: 'submit', class: 'btn btn-primary' }, 'Sign in'));
    hooks.form = { u, p };
    btn._onClick = () => submitLogin(state, site, hooks.form);
    if (state.loginError) text += ' Your email address or password was incorrect';
    if (site.rootHasNoForm && !/\/login/i.test(state.url)) {
      root.children = []; hooks.form = null; text = 'Welcome to Caterer';
    }
  } else if (kind === 'home') {
    title = 'Recruiter Dashboard'; text = 'Recruiter Dashboard';
  } else if (kind === 'search') {
    title = 'Candidate Search'; text = `Search Credits Remaining ${fmtCredits(site.credits)}`;
    if (site.creditsWidget !== false) root.append(new Element('span', { class: 'litCandidatesViewed' }, fmtCredits(site.credits)));
  } else if (kind === 'safelist') {
    title = 'Verify'; text = 'Please verify your account. We have sent a verification email.';
  } else if (kind === 'error') {
    title = 'Error'; text = 'An error has occurred';
  } else if (kind === 'protected') {
    title = 'Recruiter'; text = 'Recruiter page';
  } else {
    title = ''; text = '';
  }
  return { root, title, text, hooks };
}

// ------------------------------------------------------------------ fetch mock

function makeFetch(state, site, save, counters) {
  return function fetch(url, opts) {
    const key = String(url);
    const fx = (site.fetch || []).find((f) => key.indexOf(f.match) !== -1);
    const bucket = fx ? `fetch:${fx.match}` : 'fetch:unmatched';
    counters[bucket] = (counters[bucket] || 0) + 1;
    save();
    const signal = opts && opts.signal;
    return new Promise((resolve, reject) => {
      const abortErr = () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; return e; };
      if (signal && signal.aborted) return reject(abortErr());
      if (!fx) return reject(new TypeError('Failed to fetch'));
      if (fx.reject) return setTimeout(() => reject(new TypeError(fx.reject)), fx.delayMs || 0);
      const t = setTimeout(() => {
        const bodyBuf = fx.bodyBase64 ? Buffer.from(fx.bodyBase64, 'base64') : Buffer.from(fx.body || '', 'utf8');
        const headers = Object.assign({}, fx.headers || {});
        resolve({
          status: fx.status === undefined ? 200 : fx.status,
          ok: (fx.status === undefined ? 200 : fx.status) < 400,
          headers: { get: (n) => (headers[String(n).toLowerCase()] !== undefined ? headers[String(n).toLowerCase()] : null) },
          text: () => Promise.resolve(bodyBuf.toString('utf8')),
          arrayBuffer: () => Promise.resolve(bodyBuf.buffer.slice(bodyBuf.byteOffset, bodyBuf.byteOffset + bodyBuf.length)),
        });
      }, fx.delayMs || 0);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(abortErr()); });
    });
  };
}

// ------------------------------------------------------------------ eval

async function evalScript(script, state, site, save) {
  const page = buildPage(state, site);
  const hooks = {};
  const doc = makeDocument(page.root, page.title, page.text, hooks);
  const location = { get href() { return state.url; } };
  const win = {};
  const sandbox = {
    document: doc, location, Event: FakeEvent, HTMLInputElement, window: win,
    fetch: makeFetch(state, site, save, state.counters),
    btoa: (s) => Buffer.from(String(s), 'latin1').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('latin1'),
    Uint8Array, AbortController, setTimeout, clearTimeout, console,
  };
  win.HTMLInputElement = HTMLInputElement; win.document = doc; win.location = location; win.Event = FakeEvent;
  const ctx = vm.createContext(sandbox);
  let result = vm.runInContext(script, ctx, { timeout: 5000 });
  if (result && typeof result.then === 'function') result = await result;
  if (page.hooks.form) {
    const f = page.hooks.form;
    state.form = { u: f.u._reactValue, p: f.p._reactValue, ud: f.u._domValue, pd: f.p._domValue };
  }
  return result;
}

function formatEval(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === undefined) return 'undefined';
  return JSON.stringify(v, null, 2);
}

// ------------------------------------------------------------------ cookies (state save / load)

function cookiesFor(state) {
  const now = Math.floor(Date.now() / 1000);
  const mk = (name, value, extra) => Object.assign({ name, value, domain: '.caterer.com', path: '/', expires: now + 86400, size: name.length + value.length, httpOnly: false, secure: true, session: false }, extra || {});
  const out = [];
  if (state.hasFingerprint) {
    out.push(mk('_abck', 'fake-fingerprint-abck'));
    out.push(mk('bm_sz', 'fake-fingerprint-bmsz'));
    out.push(mk('CONSENTMGR', 'c1:0', { httpOnly: false }));
  }
  const authNames = ['AuthCookie', 'AuthCookieRoles', 'AuthCookieCompany', 'RecruiterAuthCookie'];
  if (state.loggedIn) {
    // Real session cookies come back from the browser with expires -1: that is NOT a dead cookie.
    for (const n of authNames) out.push(mk(n, 'fake-auth-' + n, { expires: -1, session: true, httpOnly: true }));
  } else if (state.hasFingerprint && state.tombstones) {
    for (const n of authNames) out.push(mk(n, '', { expires: 1, session: false }));
  }
  return out;
}

function stateJson(state) {
  return {
    cookies: cookiesFor(state),
    origins: [{ origin: `https://${HOST}`, localStorage: [{ name: 'fake-key', value: 'fake-value' }], sessionStorage: [] }],
  };
}

function applyLoadedState(state, site, json) {
  const cookies = Array.isArray(json.cookies) ? json.cookies : [];
  const now = Date.now() / 1000;
  if (site.stateLoadLogsOutWarm && state.loggedIn) { state.loggedIn = false; }
  if (cookies.some((c) => c.name === '_abck' && c.value)) { state.hasFingerprint = true; state.knownDevice = true; }
  const auth = cookies.find((c) => c.name === 'AuthCookie' && c.value && (c.expires === -1 || c.expires > now));
  if (auth && site.acceptLoadedAuth !== false && !site.stateLoadLogsOutWarm) state.loggedIn = true;
}

module.exports = {
  HOST, HOME_PATH, navigate, evalScript, formatEval, stateJson, applyLoadedState, classifyUrl,
  selectorMatches, Element, makeInput, HTMLInputElement, FakeEvent, buildPage, makeDocument,
};
