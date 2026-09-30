'use strict';
/**
 * MANUAL check (not part of `node --test`; needs packages this repo does not depend on):
 *   npm install react@19 react-dom@19 jsdom        (in any scratch directory, not in this repo)
 *   NODE_PATH=<that dir>/node_modules node tests/dashboard/manual/real-react-check.js
 * Renders plugin/resourcer/dashboard/dist/index.js with REAL React 19 into a jsdom document, drives the halt
 * banner and the search form, and fails on any React console warning or error (invalid DOM nesting, missing keys,
 * hook-order problems, unknown props). It complements the mini-renderer tests in ../ui.test.js.
 */
const path = require('path');
const { JSDOM } = require('jsdom');

const INDEX = path.resolve(__dirname, '..', '..', '..', 'plugin', 'resourcer', 'dashboard', 'dist', 'index.js');
const PREFIX = '/api/plugins/resourcer';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.IS_REACT_ACT_ENVIRONMENT = true;
// react-dom decides at load time whether text-input change events exist, so the DOM globals must come first
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = React;

const problems = [];
const realError = console.error;
const realWarn = console.warn;
console.error = (...a) => { problems.push('error: ' + a.map(String).join(' ').slice(0, 400)); };
console.warn = (...a) => { problems.push('warn: ' + a.map(String).join(' ').slice(0, 400)); };

const calls = [];
let halted = true;
const data = {
  '/status': () => ({
    generatedAt: new Date().toISOString(),
    halt: halted ? { halted: true, reason: 'screening unavailable', detail: 'HTTP 401', remedy: 're-login', since: new Date().toISOString(), blockedRuns: 2, haltedForMinutes: 12 } : { halted: false },
    pipeline: { inOperatingHours: true, operatingHours: '06:00-22:00', tz: 'Europe/London', lastActivityAgeMinutes: 3, stallSuspected: false },
    activeRuns: [
      { id: 'a', file: 'phase1-a.json', status: 'phase1_running', stage: 'phase1', label: 'Phase 1 - Scraping', jobTitle: 'Sous Chef', location: 'DT6', distance: 20, sources: 'both', startedAt: new Date(Date.now() - 90000).toISOString(), idleSecs: 5, stale: false, phase1: { page: 2, pool: 11, approved: 3, skippedDb: 6, errors: 0 }, phase2: null },
      { id: 'b', file: 'run-b.json', status: 'phase2_pushing', stage: 'phase2', label: 'Phase 2 - Zoho push', jobTitle: 'Head Chef', location: 'LS1', distance: 30, sources: 'caterer', startedAt: new Date(Date.now() - 60000).toISOString(), idleSecs: 9000, stale: true, phase1: null, phase2: { total: 5, pushed: 2, duplicates: 1, errors: 0 } }],
    queue: { depth: 2, claimed: 0, dashboardRequests: 1, upNext: [{ file: 'a.json', jobTitle: 'Sous Chef', location: 'YO2', distance: 20, source: 'dashboard', claimed: false }] },
    caterer: { state: 'ok' }, reed: { state: 'unknown' }, lastPush: { at: new Date().toISOString(), ageMinutes: 4 },
    backup: { lastAt: new Date().toISOString(), ageHours: 3, stale: false }, disk: { available: true, percentUsed: 30, level: 'ok', freeBytes: 3e9 },
    alerts: { tail: [{ ts: new Date().toISOString(), severity: 'critical', key: 'k', text: 'pipeline halted' }], critical24h: 1 }, warnings: [],
  }),
  '/stats': () => ({ today: '2026-09-29', zoho: { caterer: 2, reed: 1, total: 3, goal: 100000, percent: 0, perDayNeeded: 500 },
    targets: { perDay: 181, perWeek: 1269, todayPulled: 90, weekPulled: 400, todayPercent: 49.7, weekPercent: 31.5 },
    quota: { source: 'run_results', todayNew: 80, todayUnlocked: 90, todayDuplicates: 5, todayErrors: 0, todayRuns: 4, weekNew: 350, weekUnlocked: 400, weekRuns: 20, burnPerDay: 50, series: [{ date: '2026-09-28', new: 1, unlocked: 2, runs: 1 }, { date: '2026-09-29', new: 3, unlocked: 4, runs: 2 }] },
    credits: { remaining: 44463, total: 62475, expiry: '2027-03-11', source: 'sync', syncedAt: new Date().toISOString(), projectedRunout: '2027-11-20' },
    reed: { profileViews: 71, dailyLimit: 600 }, territories: { total: 5, due: 3, overdue: 1, high: 1, medium: 1, low: 3 }, warnings: [] }),
  '/runs': () => ({ total: 1, limit: 10, offset: 0, warnings: [], runs: [{ runKey: 'k1', jobTitle: 'Sous Chef', location: 'DT6', distance: 20, keywords: '', sources: 'both', completedAt: new Date().toISOString(), runSecs: 300, errors: 0, pool: 5, downloaded: 4, newToZoho: 3, duplicates: 1, approvedP1: 4, skippedDb: 2, skippedReview: 1, pagesScraped: 2, caterer: { pool: 3, newToZoho: 2, duplicates: 0, errors: 0, phase1: { approved: 2 } }, reed: { pool: 2, newToZoho: 1, duplicates: 1, errors: 0, phase1: { approved: 2 }, authFailed: true }, reedAuthFailed: true }] }),
  '/territories': () => ({ total: 1, limit: 20, offset: 0, today: '2026-09-29', rows: [{ id: 1, jobTitle: 'Sous Chef', location: 'YO1', distance: 20, keywords: 'dbs', priority: 'low', enabled: true, sources: 'both', pool: 3, newToZoho: 1, lastSearched: '2026-09-20', nextRunDate: '2026-09-28', isDue: true }] }),
  '/schedule': () => ({ totalEnabled: 5, totalDue: 3, queueCheck: 'queued automatically', operatingHours: '06:00-22:00 Europe/London', groups: [{ key: 'overdue', label: 'Overdue', count: 2, truncated: true, rows: [{ id: 1, jobTitle: 'Sous Chef', location: 'YO1', distance: 20, priority: 'low', sources: 'both' }] }] }),
  '/errors': () => ({ errors: [{ ts: new Date().toISOString(), context: 'zoho_push', error: 'boom', read: false }], acknowledgedAt: null, unread: 1 }),
  '/halt': () => ({ halted }),
  '/halt/clear': () => { halted = false; return { ok: true, cleared: true }; },
  '/search': (init) => { const b = JSON.parse(init.body); return { ok: true, file: 'search-1-a.json', queueDepthAfter: 3, position: 1, note: 'Queued.', request: { jobTitle: b.jobTitle, location: b.location } }; },
};

window.__HERMES_PLUGINS__ = { register(name, c) { this.page = c; }, registerSlot(p, s, c) { this.slot = { p, s, c }; } };
window.__HERMES_PLUGIN_SDK__ = {
  sdkVersion: '1.1.0', React, hooks: { useState: React.useState, useEffect: React.useEffect, useRef: React.useRef, useMemo: React.useMemo, useCallback: React.useCallback },
  fetchJSON: async (url, init) => {
    const p = url.slice(PREFIX.length).split('?')[0];
    calls.push({ p, init });
    if (!data[p]) throw Object.assign(new Error('404: no route ' + p), { status: 404 });
    return data[p](init);
  },
};
require(INDEX);

function fail(msg) { console.error = realError; console.error('FAIL: ' + msg); process.exitCode = 1; }

(async () => {
  const root = createRoot(document.getElementById('root'));
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  await act(async () => { root.render(React.createElement(window.__HERMES_PLUGINS__.page)); });
  await settle();
  let text = document.body.textContent;
  for (const needle of ['PIPELINE STOPPED - screening unavailable', 'Live progress', 'Pulled today (target 181/day)', 'Request a search', 'Recent runs', 'Territories and schedule', 'Alerts and errors', 'Phase 2 - Zoho push']) {
    if (!text.includes(needle)) fail('missing text: ' + needle);
  }
  const click = async (label) => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(label));
    if (!b) { fail('no button ' + label); return; }
    await act(async () => { b.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    await settle();
  };
  await click('Clear halt');
  if (!document.body.textContent.includes('halts again within a few minutes')) fail('no confirmation step');
  await click('Yes, clear halt');
  if (document.body.textContent.includes('PIPELINE STOPPED')) fail('banner still there after clearing');
  if (!calls.some((c) => c.p === '/halt/clear' && c.init.method === 'POST')) fail('no POST /halt/clear');

  const setValue = async (id, value) => {
    const el = document.getElementById(id);
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    await act(async () => { el.dispatchEvent(new window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); });
  };
  await setValue('rsr-title', 'sous chef');
  await setValue('rsr-loc', 'yo2');
  await setValue('rsr-distance', '30');
  await act(async () => { document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
  await settle();
  const post = calls.find((c) => c.p === '/search');
  if (!post) fail('form did not post'); else {
    const body = JSON.parse(post.init.body);
    if (body.jobTitle !== 'sous chef' || body.location !== 'yo2' || body.distance !== 30) fail('bad body ' + post.init.body);
  }
  if (!document.body.textContent.includes('Queued sous chef | yo2')) fail('no success message');

  await click('Run now');
  if (document.getElementById('rsr-title').value !== 'Sous Chef') fail('prefill did not fill the title');

  await act(async () => { root.unmount(); });
  const slotRoot = createRoot(document.getElementById('root'));
  halted = true;
  await act(async () => { slotRoot.render(React.createElement(window.__HERMES_PLUGINS__.slot.c)); });
  await settle();
  if (!document.body.textContent.includes('PIPELINE STOPPED') || [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Clear halt'))) fail('slot banner wrong');
  await act(async () => { slotRoot.unmount(); });

  const EVIL = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const cleanStatus = data['/status'];
  data['/status'] = () => { const o = cleanStatus(); o.halt = { halted: true, reason: EVIL, detail: EVIL, remedy: EVIL, blockedRuns: 1 }; o.alerts.tail[0].text = EVIL; o.activeRuns[0].jobTitle = EVIL; return o; };
  data['/territories'] = () => ({ total: 1, limit: 20, offset: 0, rows: [{ id: 1, jobTitle: EVIL, location: EVIL, distance: 20, keywords: EVIL, priority: 'low', enabled: true, sources: 'both', isDue: true }] });
  data['/errors'] = () => ({ errors: [{ ts: EVIL, context: EVIL, error: EVIL, read: false }], acknowledgedAt: null, unread: 1 });
  const evilRoot = createRoot(document.getElementById('root'));
  await act(async () => { evilRoot.render(React.createElement(window.__HERMES_PLUGINS__.page)); });
  await settle();
  if (!document.body.textContent.includes(EVIL)) fail('hostile text was not displayed as text');
  if (document.querySelectorAll('img, script, iframe, object, embed, link, style, svg').length) fail('hostile markup became elements');
  if (/<img|<script/i.test(document.body.innerHTML)) fail('hostile markup present unescaped in innerHTML');
  await act(async () => { evilRoot.unmount(); });

  console.error = realError; console.warn = realWarn;
  if (problems.length) { console.error('React reported problems:\n' + problems.join('\n')); process.exitCode = 1; }
  if (!process.exitCode) console.log('OK: real React 19 rendered every panel with no console warnings or errors (' + calls.length + ' API calls)');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error = realError; console.error(e); process.exit(1); });
