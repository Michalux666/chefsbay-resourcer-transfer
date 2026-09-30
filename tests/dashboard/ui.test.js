'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mini = require('./lib/mini-react');

const INDEX = path.resolve(__dirname, '..', '..', 'plugin', 'resourcer', 'dashboard', 'dist', 'index.js');
const SOURCE = fs.readFileSync(INDEX, 'utf8');
const PREFIX = '/api/plugins/resourcer';

// ------------------------------------------------------------------ canned API responses

function statusOk(over) {
  return {
    generatedAt: '2026-09-29T12:00:00.000Z',
    halt: { halted: false },
    pipeline: { inOperatingHours: true, operatingHours: '06:00-22:00', tz: 'Europe/London', lastActivityAt: '2026-09-29T11:58:00.000Z', lastActivityAgeMinutes: 2, stallSuspected: false, stallMinutes: 20 },
    activeRuns: [],
    queue: { depth: 3, claimed: 0, dashboardRequests: 1, unreadable: 0, upNext: [{ file: 'search-1-a.json', jobTitle: 'Sous Chef', location: 'YO2', distance: 20, sources: 'both', source: 'dashboard', requestedAt: null, claimed: false }] },
    caterer: { state: 'ok', updatedAt: '2026-09-29T11:00:00.000Z', ageMinutes: 60, detail: null, source: 'logs/watchdog-runner.jsonl' },
    reed: { state: 'unknown' },
    lastPush: { at: '2026-09-29T11:30:00.000Z', ageMinutes: 30, source: 'run_results' },
    backup: { count: 2, lastAt: '2026-09-29T03:30:00.000Z', ageHours: 8.5, file: 'x.enc', stale: false },
    disk: { available: true, totalBytes: 4e9, usedBytes: 1e9, freeBytes: 3e9, percentUsed: 25, level: 'ok' },
    alerts: { tail: [], critical24h: 0 },
    db: { ok: true, error: null },
    warnings: [],
    ...over,
  };
}

function statsOk(over) {
  return {
    generatedAt: '2026-09-29T12:00:00.000Z', today: '2026-09-29',
    zoho: { caterer: 15698, reed: 8998, total: 24696, goal: 100000, percent: 24.7, unlockedCaterer: 17009, unlockedReed: 0, daysToExpiry: 163, perDayNeeded: 462 },
    targets: { basis: 'unlocked CVs (downloaded)', perDay: 181, perWeek: 1269, todayPulled: 167, weekPulled: 803, todayPercent: 92.3, weekPercent: 63.3 },
    quota: { source: 'run_results', todayNew: 156, todayUnlocked: 167, todayDuplicates: 11, todayErrors: 0, todayRuns: 40, weekNew: 732, weekUnlocked: 803, weekRuns: 293, burnPerDay: 105,
      series: [{ date: '2026-09-28', new: 100, unlocked: 120, runs: 30 }, { date: '2026-09-29', new: 156, unlocked: 167, runs: 40 }] },
    credits: { remaining: 44463, total: 62475, expiry: '2027-03-11', syncedAt: '2026-09-29T08:00:00.000Z', source: 'sync', burnPerDay: 105, projectedRunout: '2027-11-20' },
    reed: { date: '2026-09-29', profileViews: 71, dailyLimit: 600, cvDownloads: 0, remaining: 529, expiry: '2027-03-18' },
    territories: { total: 1724, due: 104, overdue: 60, high: 0, medium: 0, low: 1724 },
    linkedToZohoToday: 167, warnings: [],
    ...over,
  };
}

function runsOk() {
  return { total: 23, limit: 10, offset: 0, warnings: [], runs: [{
    runKey: 'merged-queue-a', date: '2026-09-29', startedAt: '2026-09-29T10:00:00.000Z', completedAt: '2026-09-29T10:06:00.000Z', phase1StartedAt: '2026-09-29T10:00:00.000Z',
    jobTitle: 'Sous Chef', location: 'DT6', distance: 20, keywords: '', sources: 'both', pool: 13, downloaded: 5, newToZoho: 4, duplicates: 1, skipped: 0, errors: 0, approvedP1: 6, skippedDb: 5,
    skippedReview: 2, pagesScraped: 3, runSecs: 360, screeningModel: 'm', caterer: { pool: 8, newToZoho: 3, downloaded: 3, duplicates: 0, errors: 0, phase1: { approved: 4 }, authFailed: false },
    reed: { pool: 5, newToZoho: 1, downloaded: 2, duplicates: 1, errors: 0, phase1: { approved: 2 }, authFailed: true }, reedAuthFailed: true }] };
}

function territoriesOk(offset) {
  return { total: 45, limit: 20, offset: offset || 0, today: '2026-09-29', rows: [
    { id: 1, jobTitle: 'Sous Chef', location: 'YO1', distance: 20, keywords: 'dbs', priority: 'low', enabled: true, sources: 'both', pool: 12, newToZoho: 3, duplicates: 0, skipped: 0, errors: 0, lastSearched: '2026-09-20', nextRunDate: '2026-09-28', isDue: true, daysUntilDue: -1 },
    { id: 2, jobTitle: 'Head Chef', location: 'LS1', distance: 30, keywords: '', priority: 'high', enabled: false, sources: 'caterer', pool: 4, newToZoho: 0, duplicates: 0, skipped: 0, errors: 0, lastSearched: null, nextRunDate: null, isDue: true, daysUntilDue: 0 }] };
}

function scheduleOk() {
  return { today: '2026-09-29', totalEnabled: 1724, totalDue: 104, capPerDay: 57, queueCheck: 'Due territories are queued automatically by the supervisor', operatingHours: '06:00-22:00 Europe/London',
    groups: [{ key: 'overdue', label: 'Overdue', count: 60, truncated: true, rows: [{ id: 1, jobTitle: 'Sous Chef', location: 'YO1', distance: 20, keywords: '', priority: 'low', sources: 'both', lastSearched: null, nextRunDate: '2026-09-27' }] },
      { key: '2026-09-30', label: 'Tomorrow', count: 1, truncated: false, rows: [{ id: 9, jobTitle: 'Chef', location: 'M1', distance: 20, keywords: '', priority: 'low', sources: 'both', lastSearched: null, nextRunDate: '2026-09-30' }] }] };
}

function errorsOk() {
  return { errors: [{ ts: '2026-09-29T09:00:00.000Z', context: 'zoho_push', severity: null, error: 'Zoho said no', detail: null, jobTitle: 'Sous Chef', location: 'YO2', read: false }], acknowledgedAt: null, unread: 1 };
}

function standardRoutes(over) {
  return {
    '/status': () => statusOk(),
    '/stats': () => statsOk(),
    '/runs?limit=10&offset=0': () => runsOk(),
    '/territories?limit=20&offset=0': () => territoriesOk(0),
    '/schedule?days=7&perGroup=8': () => scheduleOk(),
    '/errors?limit=30': () => errorsOk(),
    '/halt': () => ({ halted: false }),
    ...over,
  };
}

function apiError(status, body) {
  const e = new Error(body && body.detail ? body.detail : `${status}: request failed`);
  e.status = status;
  e.body = body;
  return e;
}

// ------------------------------------------------------------------ harness

function setup(routes, opts) {
  const o = opts || {};
  const mr = mini.create();
  const calls = [];
  const registered = {};
  const slots = [];
  let timers = [];
  let timerId = 0;
  const saved = { window: global.window, document: global.document, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout, setInterval: global.setInterval, clearInterval: global.clearInterval };

  global.setTimeout = (fn, ms) => { const id = ++timerId; timers.push({ id, fn, ms, kind: 'timeout' }); return id; };
  global.setInterval = (fn, ms) => { const id = ++timerId; timers.push({ id, fn, ms, kind: 'interval' }); return id; };
  global.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
  global.clearInterval = global.clearTimeout;
  const doc = { hidden: !!o.hidden, getElementById: () => null };
  global.document = doc;

  const fetchJSON = async (url, init) => {
    assert.ok(url.startsWith(PREFIX + '/'), `unexpected url ${url}`);
    const p = url.slice(PREFIX.length);
    calls.push({ path: p, init });
    const handler = routes[p] || routes[p.split('?')[0]];
    if (!handler) throw apiError(404, { detail: `no route ${p}` });
    return handler(init, p);
  };
  const sdk = { sdkVersion: '1.1.0', React: mr.React, hooks: mr.hooks, components: {}, ...(o.noFetchJSON ? {} : { fetchJSON }), ...(o.sdk || {}) };
  global.window = { __HERMES_PLUGINS__: { register: (n, c) => { registered[n] = c; }, registerSlot: o.noSlot ? undefined : (p, s, c) => slots.push({ p, s, c }) }, __HERMES_PLUGIN_SDK__: sdk };
  delete require.cache[INDEX];
  require(INDEX);

  const h = {
    mr, calls, registered, slots, doc,
    get timers() { return timers; },
    restore() {
      mr.unmount();
      for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete global[k]; else global[k] = saved[k]; }
      delete require.cache[INDEX];
    },
    mount(component) { mr.mount(component); return h; },
    async settle() { await mr.settle(); return h; },
    get tree() { return mr.tree; },
    text() { return mini.textOf(mr.tree); },
    button(label) { return mini.find(mr.tree, mini.byText('button', label)); },
    async click(node) { assert.ok(node, 'element to click not found'); assert.equal(typeof node.props.onClick, 'function'); node.props.onClick({ preventDefault() {} }); await h.settle(); },
    async type(node, value) { assert.ok(node, 'input not found'); node.props.onChange({ target: { value } }); await h.settle(); },
    async runTimeouts() { const due = timers.filter((t) => t.kind === 'timeout'); timers = timers.filter((t) => t.kind !== 'timeout'); due.forEach((t) => t.fn()); await h.settle(); },
    callsTo(p) { return calls.filter((c) => c.path === p || c.path.startsWith(p + '?')); },
    input(id) { return mini.find(mr.tree, (n) => n.props && n.props.id === id); },
  };
  return h;
}

async function withPage(routes, opts, fn) {
  const h = setup(routes, opts);
  try {
    h.mount(h.registered.resourcer);
    await h.settle();
    await fn(h);
  } finally {
    h.restore();
  }
}

// ------------------------------------------------------------------ registration

test('registers the page under the manifest name and the header banner slot in (plugin, slot, component) order', () => {
  const h = setup(standardRoutes());
  try {
    assert.equal(typeof h.registered.resourcer, 'function');
    assert.equal(h.slots.length, 1);
    assert.equal(h.slots[0].p, 'resourcer');
    assert.equal(h.slots[0].s, 'header-banner');
    assert.equal(typeof h.slots[0].c, 'function');
    const manifest = JSON.parse(fs.readFileSync(path.resolve(path.dirname(INDEX), '..', 'manifest.json'), 'utf8'));
    assert.equal(manifest.name, 'resourcer');
    assert.deepEqual(manifest.slots, ['header-banner']);
  } finally { h.restore(); }
});

test('a missing SDK or missing hooks registers nothing and does not throw', () => {
  const saved = global.window;
  const warn = console.warn;
  const warnings = [];
  console.warn = (m) => warnings.push(String(m));
  try {
    global.window = {};
    delete require.cache[INDEX];
    require(INDEX);
    global.window = { __HERMES_PLUGINS__: { register() { throw new Error('should not register'); } }, __HERMES_PLUGIN_SDK__: { React: { createElement() {} } } };
    delete require.cache[INDEX];
    require(INDEX);
    assert.equal(warnings.length, 2);
  } finally {
    console.warn = warn;
    if (saved === undefined) delete global.window; else global.window = saved;
    delete require.cache[INDEX];
  }
});

test('an SDK without registerSlot still registers the page', () => {
  const h = setup(standardRoutes(), { noSlot: true });
  try {
    assert.equal(typeof h.registered.resourcer, 'function');
    assert.equal(h.slots.length, 0);
  } finally { h.restore(); }
});

// ------------------------------------------------------------------ page rendering

test('the page renders every panel with the numbers from the API', async () => {
  await withPage(standardRoutes(), {}, async (h) => {
    const t = h.text();
    for (const heading of ['Live progress', 'Targets and totals', 'Request a search', 'Recent runs', 'Territories and schedule', 'Alerts and errors']) assert.ok(t.includes(heading), heading);
    assert.ok(t.includes('Pulled today (target 181/day)'));
    assert.ok(t.includes('167') && t.includes('92% of target'));
    assert.ok(t.includes('Last 7 days (target 1,269/week)') && t.includes('803'));
    assert.ok(t.includes('24,696') && t.includes('Caterer 15,698 | Reed 8,998'));
    assert.ok(t.includes('44,463') && t.includes('Runout ~2027-11-20'));
    assert.ok(t.includes('Reed today 71 / 600 views'));
    assert.ok(t.includes('1,724') && t.includes('104 due (60 overdue)'));
    assert.ok(t.includes('No pipeline running.'));
    assert.ok(t.includes('Queue: 3 waiting') && t.includes('1 from the dashboard'));
    assert.ok(t.includes('Sous Chef | YO2 - 20mi (dashboard request)'));
    assert.ok(t.includes('Session OK') && t.includes('Auth') === false || t.includes('Unknown'));
    assert.ok(t.includes('30 min ago'));
    assert.ok(t.includes('Sous Chef | DT6 - 20mi'));
    assert.ok(t.includes('Reed auth failed'));
    assert.ok(t.includes('1-20 of 45'));
    assert.ok(t.includes('Schedule - 104 due of 1,724 enabled'));
    assert.ok(t.includes('Overdue (60)') && t.includes('+59 more'));
    assert.ok(t.includes('Zoho said no'));
  });
});

test('active runs show phase, progress and elapsed time from the start time', async () => {
  const routes = standardRoutes({ '/status': () => statusOk({ activeRuns: [
    { id: 'a', file: 'phase1-a.json', status: 'phase1_running', stage: 'phase1', label: 'Phase 1 - Scraping', jobTitle: 'Sous Chef', location: 'DT6', distance: 20, sources: 'both', startedAt: new Date(Date.now() - 125000).toISOString(), updatedAt: null, idleSecs: 30, stale: false,
      phase1: { page: 2, pool: 11, approved: 3, skippedDb: 6, errors: 0 }, phase2: null },
    { id: 'b', file: 'run-b.json', status: 'phase2_pushing', stage: 'phase2', label: 'Phase 2 - Zoho push', jobTitle: 'Head Chef', location: 'LS1', distance: 30, sources: 'caterer', startedAt: new Date(Date.now() - 60000).toISOString(), updatedAt: null, idleSecs: 5000, stale: true,
      phase1: null, phase2: { total: 5, pushed: 2, duplicates: 1, errors: 0 } }] }) });
  await withPage(routes, {}, async (h) => {
    const t = h.text();
    assert.ok(t.includes('2 running'));
    assert.ok(t.includes('Phase 1 - Scraping') && t.includes('Sous Chef | DT6 - 20mi'));
    assert.ok(t.includes('Phase 2 - Zoho push') && t.includes('3 / 5'));
    assert.ok(t.includes('stale?'));
    assert.match(t, /elapsed 2m \d+s/);
    const bars = mini.findAll(h.tree, (n) => n.props && n.props.role === 'progressbar');
    assert.ok(bars.some((b) => b.props['aria-valuenow'] === 60));
    assert.ok(h.timers.some((x) => x.kind === 'interval' && x.ms === 1000), 'elapsed ticker');
  });
});

test('status chips reflect caterer, reed, activity and backup problems', async () => {
  const routes = standardRoutes({ '/status': () => statusOk({
    caterer: { state: 'safelist_blocked', detail: 'needs the emailed link', ageMinutes: 5 }, reed: { state: 'auth_failed', detail: 'token refresh failed' },
    pipeline: { inOperatingHours: true, operatingHours: '06:00-22:00', tz: 'Europe/London', lastActivityAgeMinutes: 90, stallSuspected: true },
    backup: { count: 0, lastAt: null, ageHours: null, stale: true }, disk: { available: true, percentUsed: 91, level: 'critical', freeBytes: 1e8 },
    lastPush: { at: null, ageMinutes: null } }) });
  await withPage(routes, {}, async (h) => {
    const t = h.text();
    assert.ok(t.includes('Safe-list block') && t.includes('Auth failed') && t.includes('never'));
    assert.ok(t.includes('None for 1 h 30 min, work queued'));
    assert.ok(t.includes('none found') && t.includes('91% used'));
    const chips = mini.findAll(h.tree, (n) => n.props && typeof n.props.className === 'string' && n.props.className.startsWith('rsr-chip '));
    const tone = (label) => chips.find((c) => mini.textOf(c).startsWith(label)).props.className;
    assert.ok(tone('Caterer').includes('rsr-bad') && tone('Reed').includes('rsr-bad') && tone('Activity').includes('rsr-bad'));
    assert.ok(tone('Backup').includes('rsr-warn') && tone('Disk').includes('rsr-bad'));
  });
});

test('the Reed chip says Disabled, Not logged in or Auth OK, with the reason as its hint', async () => {
  const cases = [
    [{ state: 'disabled', enabled: false, sources: 'caterer', detail: 'RESOURCER_SOURCES=caterer' }, 'Disabled', 'rsr-muted-chip'],
    [{ state: 'not_logged_in', enabled: true, sources: 'both', detail: 'Reed is on (RESOURCER_SOURCES=both) but no successful Reed login is recorded yet' }, 'Not logged in', 'rsr-warn'],
    [{ state: 'ok', enabled: true, sources: 'both', detail: null }, 'Auth OK', 'rsr-ok'],
  ];
  for (const [reed, text, tone] of cases) {
    await withPage(standardRoutes({ '/status': () => statusOk({ reed }) }), {}, async (h) => {
      const chips = mini.findAll(h.tree, (n) => n.props && typeof n.props.className === 'string' && n.props.className.startsWith('rsr-chip '));
      const chip = chips.find((c) => mini.textOf(c).startsWith('Reed'));
      assert.ok(mini.textOf(chip).includes(text), `${reed.state}: ${mini.textOf(chip)}`);
      assert.ok(chip.props.className.includes(tone), `${reed.state}: ${chip.props.className}`);
      if (reed.detail) assert.equal(chip.props.title, reed.detail);
      if (reed.state !== 'ok') assert.ok(!mini.textOf(chip).includes('Auth OK'));
    });
  }
});

test('progress bars never exceed 100 percent', async () => {
  const routes = standardRoutes({ '/stats': () => statsOk({ targets: { perDay: 181, perWeek: 1269, todayPulled: 900, weekPulled: 5000, todayPercent: 497.2, weekPercent: 394 }, zoho: { caterer: 1, reed: 1, total: 2, goal: 1, percent: 250 } }) });
  await withPage(routes, {}, async (h) => {
    const widths = mini.findAll(h.tree, (n) => n.props && typeof n.props.className === 'string' && n.props.className.startsWith('rsr-bar-fill')).map((n) => n.props.style.width);
    assert.ok(widths.length >= 3 && widths.every((w) => /^\d+(\.\d+)?%$/.test(w) && parseFloat(w) <= 100), widths.join(','));
  });
});

test('missing run_results shows the fallback message instead of numbers', async () => {
  const routes = standardRoutes({ '/stats': () => statsOk({ quota: { source: 'db-fallback', todayNew: 2, todayUnlocked: null, todayDuplicates: null, todayErrors: null, todayRuns: null, weekNew: 3, weekUnlocked: null, weekRuns: null, burnPerDay: 0, series: [] },
    targets: { perDay: 181, perWeek: 1269, todayPulled: null, weekPulled: null, todayPercent: null, weekPercent: null }, warnings: ['run_results table is missing'] }) });
  await withPage(routes, {}, async (h) => {
    assert.ok(h.text().includes('run_results not available') && h.text().includes('run_results table is missing'));
  });
});

// ------------------------------------------------------------------ halt banner

const HALT = { halted: true, reason: 'screening unavailable', detail: 'HTTP 401 from the gateway', remedy: 're-authenticate the model gateway', since: '2026-09-29T11:00:00.000Z', blockedRuns: 3, haltedForMinutes: 75 };

test('a halted pipeline shows the banner with the clear button and a confirmation step', async () => {
  let halted = true;
  const routes = standardRoutes({ '/status': () => statusOk({ halt: halted ? HALT : { halted: false } }), '/halt/clear': () => { halted = false; return { ok: true, cleared: true, previous: {} }; } });
  await withPage(routes, {}, async (h) => {
    const t = h.text();
    assert.ok(t.includes('PIPELINE STOPPED - screening unavailable') && t.includes('HTTP 401 from the gateway'));
    assert.ok(t.includes('Stopped for 1h 15m - 3 run(s) held back'));
    const remedy = mini.find(h.tree, (n) => n.type === 'pre');
    assert.equal(mini.textOf(remedy), 're-authenticate the model gateway');
    await h.click(h.button('Clear halt'));
    assert.ok(h.text().includes('halts again within a few minutes'));
    assert.equal(h.callsTo('/halt/clear').length, 0, 'no request before confirming');
    await h.click(h.button('Cancel'));
    assert.ok(!h.text().includes('halts again within a few minutes') && h.button('Clear halt'));
    await h.click(h.button('Clear halt'));
    const statusCallsBefore = h.callsTo('/status').length;
    await h.click(h.button('Yes, clear halt'));
    const post = h.callsTo('/halt/clear');
    assert.equal(post.length, 1);
    assert.equal(post[0].init.method, 'POST');
    assert.equal(post[0].init.headers['Content-Type'], 'application/json');
    assert.equal(post[0].init.body, '{}');
    assert.ok(h.callsTo('/status').length > statusCallsBefore, 'status is refreshed after clearing');
    assert.ok(!h.text().includes('PIPELINE STOPPED'));
  });
});

test('a second halt after a cleared one starts with a clean banner', async () => {
  let halted = true;
  const routes = standardRoutes({ '/status': () => statusOk({ halt: halted ? HALT : { halted: false } }), '/halt/clear': () => { halted = false; return { ok: true, cleared: true, previous: {} }; } });
  await withPage(routes, {}, async (h) => {
    await h.click(h.button('Clear halt'));
    await h.click(h.button('Yes, clear halt'));
    assert.ok(!h.text().includes('PIPELINE STOPPED'));
    halted = true;
    await h.runTimeouts();
    assert.ok(h.text().includes('PIPELINE STOPPED'));
    assert.ok(!h.text().includes('Halt cleared.') && h.button('Clear halt') && !h.text().includes('Clear the halt anyway?'));
  });
});

test('a failed clear shows the server message and keeps the banner', async () => {
  const routes = standardRoutes({ '/status': () => statusOk({ halt: HALT }), '/halt/clear': () => { throw apiError(500, { error: 'clear_failed', detail: 'could not clear the halt: disk full' }); } });
  await withPage(routes, {}, async (h) => {
    await h.click(h.button('Clear halt'));
    await h.click(h.button('Yes, clear halt'));
    assert.ok(h.text().includes('could not clear the halt: disk full') && h.text().includes('PIPELINE STOPPED'));
  });
});

test('the header slot renders nothing when running and a compact banner when halted', async () => {
  let state = { halted: false };
  const h = setup(standardRoutes({ '/halt': () => state }));
  try {
    h.mount(h.slots[0].c);
    await h.settle();
    assert.equal(mini.textOf(h.tree), '');
    state = HALT;
    await h.runTimeouts();
    assert.ok(h.text().includes('PIPELINE STOPPED - screening unavailable'));
    assert.equal(h.button('Clear halt'), null, 'the slot banner has no clear button');
    assert.ok(h.timers.some((t) => t.kind === 'timeout' && t.ms === 30000));
  } finally { h.restore(); }
});

// ------------------------------------------------------------------ search form

function fillForm(h, values) {
  const map = { title: 'rsr-title', loc: 'rsr-loc', kw: 'rsr-kw' };
  return (async () => {
    for (const [k, v] of Object.entries(values)) await h.type(h.input(map[k]), v);
  })();
}

test('the search form posts the entered values and shows the queue position', async () => {
  let body = null;
  const routes = standardRoutes({ '/search': (init) => { body = JSON.parse(init.body); return { ok: true, file: 'search-1-a.json', queueDepthAfter: 4, position: 1, note: 'Queued. It is picked up in queue order.', request: { jobTitle: 'Sous Chef', location: 'YO2' } }; } });
  await withPage(routes, {}, async (h) => {
    await fillForm(h, { title: 'sous chef', loc: 'yo2', kw: 'DBS' });
    await h.type(h.input('rsr-source'), 'caterer');
    await h.input('rsr-source').props.onChange({ target: { value: 'caterer' } });
    await h.settle();
    await h.input('rsr-distance').props.onChange({ target: { value: '30' } });
    await h.settle();
    const submit = mini.find(h.tree, (n) => n.type === 'form');
    submit.props.onSubmit({ preventDefault() {} });
    await h.settle();
    assert.deepEqual(body, { jobTitle: 'sous chef', location: 'yo2', keywords: 'DBS', sources: 'caterer', priority: 'high', distance: 30, activeWithin: '1 month', cvLimit: 20 });
    assert.ok(h.text().includes('Queued Sous Chef | YO2 (position 1, queue depth 4). Queued. It is picked up in queue order.'));
    assert.equal(h.input('rsr-title').props.value, '', 'title cleared after success');
    assert.ok(h.callsTo('/status').length >= 2, 'status refreshed after queuing');
  });
});

test('required fields are checked before any request is sent', async () => {
  await withPage(standardRoutes(), {}, async (h) => {
    const form = mini.find(h.tree, (n) => n.type === 'form');
    form.props.onSubmit({ preventDefault() {} });
    await h.settle();
    assert.equal(h.callsTo('/search').length, 0);
    assert.ok(h.text().includes('Job title and postcode area are required.'));
    assert.ok(h.input('rsr-title').props.className.includes('rsr-input-bad'));
  });
});

test('location hints warn about city names and full text but accept outward codes', async () => {
  await withPage(standardRoutes(), {}, async (h) => {
    await h.type(h.input('rsr-loc'), 'York');
    assert.ok(h.text().includes('City names resolve ambiguously'));
    await h.type(h.input('rsr-loc'), 'Yorkshire');
    assert.ok(h.text().includes('Use the outward code only'));
    await h.type(h.input('rsr-loc'), 'yo2');
    assert.ok(h.text().includes('Valid postcode area'));
    await h.type(h.input('rsr-loc'), '');
    assert.ok(!h.text().includes('Valid postcode area'));
  });
});

test('server validation errors mark the offending field', async () => {
  const routes = standardRoutes({ '/search': () => { throw apiError(400, { error: 'validation', field: 'location', detail: 'Enter the postcode area only (outward code such as YO2, M1, LS1), not a city name or a full postcode.' }); } });
  await withPage(routes, {}, async (h) => {
    await fillForm(h, { title: 'Chef', loc: 'York' });
    mini.find(h.tree, (n) => n.type === 'form').props.onSubmit({ preventDefault() {} });
    await h.settle();
    assert.ok(h.text().includes('Enter the postcode area only'));
    assert.ok(h.input('rsr-loc').props.className.includes('rsr-input-bad'));
    assert.ok(!h.input('rsr-title').props.className.includes('rsr-input-bad'));
  });
});

test('a duplicate request shows the existing one', async () => {
  const routes = standardRoutes({ '/search': () => { throw apiError(409, { error: 'already_queued', detail: 'Sous Chef | YO2 is already queued; it will run in queue order.', file: 'search-1-a.json', existing: { where: 'pending', jobTitle: 'Sous Chef', location: 'YO2', distance: 30, claimed: false } }); } });
  await withPage(routes, {}, async (h) => {
    await fillForm(h, { title: 'Sous Chef', loc: 'YO2' });
    mini.find(h.tree, (n) => n.type === 'form').props.onSubmit({ preventDefault() {} });
    await h.settle();
    const t = h.text();
    assert.ok(t.includes('is already queued; it will run in queue order.'));
    assert.ok(t.includes('Existing request: Sous Chef | YO2 - 30mi (waiting in the queue)'));
  });
});

test('older SDK builds that only put the body in the message still map 400 and 409 responses', async () => {
  const routes = standardRoutes({ '/search': () => { throw new Error('409: ' + JSON.stringify({ error: 'already_queued', detail: 'already there', existing: { where: 'in_flight', jobTitle: 'Chef', location: 'M1' } })); } });
  await withPage(routes, {}, async (h) => {
    await fillForm(h, { title: 'Chef', loc: 'M1' });
    mini.find(h.tree, (n) => n.type === 'form').props.onSubmit({ preventDefault() {} });
    await h.settle();
    assert.ok(h.text().includes('already there') && h.text().includes('(running now)'));
  });
});

test('Run now on a territory prefills the form', async () => {
  await withPage(standardRoutes(), {}, async (h) => {
    const buttons = mini.findAll(h.tree, mini.byText('button', 'Run now'));
    assert.equal(buttons.length, 2);
    await h.click(buttons[0]);
    assert.equal(h.input('rsr-title').props.value, 'Sous Chef');
    assert.equal(h.input('rsr-loc').props.value, 'YO1');
    assert.equal(h.input('rsr-kw').props.value, 'dbs');
    assert.equal(h.input('rsr-source').props.value, 'both');
    assert.equal(h.input('rsr-distance').props.value, '20');
    await h.click(mini.findAll(h.tree, mini.byText('button', 'Run now'))[1]);
    assert.equal(h.input('rsr-title').props.value, 'Head Chef');
    assert.equal(h.input('rsr-distance').props.value, '30');
    assert.equal(h.input('rsr-source').props.value, 'caterer');
  });
});

// ------------------------------------------------------------------ lists

test('territory filters are debounced and paging requests the next offset', async () => {
  await withPage(standardRoutes({ '/territories?limit=20&offset=20': () => territoriesOk(20), '/territories?q=sous&limit=20&offset=0': () => territoriesOk(0) }), {}, async (h) => {
    const before = h.callsTo('/territories').length;
    const q = mini.find(h.tree, (n) => n.props && n.props['aria-label'] === 'Filter by role');
    await h.type(q, 'sous');
    assert.equal(h.callsTo('/territories').length, before, 'no request until the debounce fires');
    await h.runTimeouts();
    assert.ok(h.callsTo('/territories').some((c) => c.path === '/territories?q=sous&limit=20&offset=0'));
    const due = mini.find(h.tree, (n) => n.type === 'input' && n.props.type === 'checkbox');
    due.props.onChange({ target: { checked: true } });
    await h.settle();
    await h.runTimeouts();
    assert.ok(h.callsTo('/territories').some((c) => c.path.includes('due=1')));
  });
});

test('the pager moves through runs and disables at the edges', async () => {
  await withPage(standardRoutes({ '/runs?limit=10&offset=10': () => ({ ...runsOk(), offset: 10 }) }), {}, async (h) => {
    const prev = mini.findAll(h.tree, mini.byText('button', 'Prev'))[0];
    assert.equal(prev.props.disabled, true);
    const next = mini.findAll(h.tree, mini.byText('button', 'Next'))[0];
    assert.equal(next.props.disabled, false);
    await h.click(next);
    assert.ok(h.callsTo('/runs').some((c) => c.path === '/runs?limit=10&offset=10'));
    assert.ok(h.text().includes('11-20 of 23'));
  });
});

test('mark all read posts the acknowledgement and reloads the feed', async () => {
  let acked = false;
  await withPage(standardRoutes({ '/errors?limit=30': () => ({ ...errorsOk(), unread: acked ? 0 : 1 }), '/errors/ack': (init) => { acked = true; assert.equal(init.method, 'POST'); return { ok: true, acknowledgedAt: 'x' }; } }), {}, async (h) => {
    await h.click(h.button('Mark all read (1)'));
    assert.equal(h.callsTo('/errors/ack').length, 1);
    assert.ok(h.button('Mark all read (0)'));
  });
});

// ------------------------------------------------------------------ resilience

test('a failing status call shows an error and backs off to 30 seconds', async () => {
  await withPage(standardRoutes({ '/status': () => { throw apiError(500, { detail: 'boom' }); } }), {}, async (h) => {
    assert.ok(h.text().includes('Could not load status: boom'));
    const retry = h.timers.filter((t) => t.kind === 'timeout').map((t) => t.ms);
    assert.ok(retry.includes(30000), retry.join(','));
  });
});

test('a busy database (503) shows a retry notice instead of an error', async () => {
  const routes = standardRoutes({ '/runs?limit=10&offset=0': () => { throw apiError(503, { error: 'db_unavailable', detail: 'candidates.db is not readable right now: database is locked' }); } });
  await withPage(routes, {}, async (h) => {
    assert.ok(h.text().includes('Database busy, retrying...'));
  });
});

test('polling pauses while the tab is hidden and resumes when visible', async () => {
  const h = setup(standardRoutes(), { hidden: true });
  try {
    h.mount(h.registered.resourcer);
    await h.settle();
    assert.equal(h.calls.length, 0, 'nothing is fetched while hidden');
    h.doc.hidden = false;
    await h.runTimeouts();
    assert.ok(h.callsTo('/status').length >= 1);
  } finally { h.restore(); }
});

test('polls on the documented intervals and stops when unmounted', async () => {
  const h = setup(standardRoutes());
  try {
    h.mount(h.registered.resourcer);
    await h.settle();
    const delays = h.timers.filter((t) => t.kind === 'timeout').map((t) => t.ms).sort((a, b) => a - b);
    assert.ok(delays.includes(5000) && delays.includes(30000) && delays.includes(60000), delays.join(','));
    h.mr.unmount();
    assert.deepEqual(h.timers.filter((t) => t.kind === 'timeout'), []);
    assert.deepEqual(h.timers.filter((t) => t.kind === 'interval'), []);
  } finally { h.restore(); }
});

test('authedFetch is used when fetchJSON is missing, and errors keep their status', async () => {
  const calls = [];
  const authedFetch = async (url, init) => {
    calls.push(url);
    const p = url.slice(PREFIX.length);
    if (p === '/search') return { ok: false, status: 400, text: async () => JSON.stringify({ error: 'validation', field: 'jobTitle', detail: 'Job title is required' }) };
    const body = standardRoutes()[p] ? standardRoutes()[p](init) : { halted: false };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  await withPage(standardRoutes(), { noFetchJSON: true, sdk: { authedFetch } }, async (h) => {
    assert.ok(calls.length > 0 && h.text().includes('Pulled today'));
    await fillForm(h, { title: 'x', loc: 'M1' });
    mini.find(h.tree, (n) => n.type === 'form').props.onSubmit({ preventDefault() {} });
    await h.settle();
    assert.ok(h.text().includes('Job title is required'));
    assert.ok(h.input('rsr-title').props.className.includes('rsr-input-bad'));
  });
});

test('with no fetch helper at all the page reports it instead of crashing', async () => {
  await withPage(standardRoutes(), { noFetchJSON: true }, async (h) => {
    assert.ok(h.text().includes('no fetch helper'));
  });
});

// ------------------------------------------------------------------ untrusted data

const EVIL = '<img src=x onerror=alert(1)><script>alert(2)</script>';

test('hostile strings from the API are rendered as text and never become elements or handlers', async () => {
  const routes = standardRoutes({
    '/status': () => statusOk({
      halt: { ...HALT, reason: EVIL, detail: EVIL, remedy: EVIL },
      caterer: { state: EVIL, detail: EVIL }, reed: { state: EVIL },
      activeRuns: [{ id: EVIL, file: 'p.json', status: 'phase1_running', stage: EVIL, label: EVIL, jobTitle: EVIL, location: EVIL, distance: 20, sources: EVIL, startedAt: EVIL, idleSecs: 1, stale: false, phase1: { page: 1, pool: 1, approved: 0, skippedDb: 0, errors: 0 }, phase2: null }],
      queue: { depth: 1, claimed: 0, dashboardRequests: 0, upNext: [{ file: 'a.json', jobTitle: EVIL, location: EVIL, distance: 20, source: EVIL, claimed: false }] },
      alerts: { tail: [{ ts: EVIL, severity: EVIL, key: EVIL, text: EVIL }], critical24h: 0 },
      backup: { lastAt: EVIL, ageHours: EVIL, stale: false, file: EVIL }, disk: { available: true, percentUsed: EVIL, level: EVIL, freeBytes: EVIL } }),
    '/runs?limit=10&offset=0': () => ({ ...runsOk(), runs: [{ ...runsOk().runs[0], jobTitle: EVIL, location: EVIL, keywords: EVIL, sources: EVIL }] }),
    '/territories?limit=20&offset=0': () => ({ ...territoriesOk(0), rows: [{ ...territoriesOk(0).rows[0], jobTitle: EVIL, location: EVIL, keywords: EVIL, priority: EVIL, sources: EVIL }] }),
    '/schedule?days=7&perGroup=8': () => ({ ...scheduleOk(), groups: [{ key: EVIL, label: EVIL, count: 1, truncated: false, rows: [{ id: 1, jobTitle: EVIL, location: EVIL, distance: 20, priority: EVIL, sources: EVIL }] }], queueCheck: EVIL, operatingHours: EVIL }),
    '/errors?limit=30': () => ({ errors: [{ ts: EVIL, context: EVIL, error: EVIL, detail: EVIL, jobTitle: EVIL, location: EVIL, read: false }], acknowledgedAt: null, unread: 1 }),
    '/stats': () => statsOk({ today: EVIL, warnings: [EVIL], credits: { remaining: 1, total: 2, expiry: EVIL, source: EVIL, projectedRunout: EVIL, syncedAt: EVIL } }),
  });
  await withPage(routes, {}, async (h) => {
    assert.ok(h.text().includes(EVIL), 'the hostile text is displayed verbatim as text');
    const allowed = new Set(['div', 'section', 'header', 'h3', 'span', 'button', 'input', 'select', 'option', 'label', 'form', 'pre', 'ol', 'ul', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'details', 'summary', 'fragment']);
    const types = new Set();
    mini.walk(h.tree, (n) => { if (typeof n !== 'string') types.add(n.type); });
    for (const t of types) assert.ok(allowed.has(t), `unexpected element <${t}>`);
    mini.walk(h.tree, (n) => {
      if (typeof n === 'string') return;
      for (const [k, v] of Object.entries(n.props)) {
        if (/^on[A-Z]/.test(k)) assert.equal(typeof v, 'function', `${k} must be a function`);
        assert.ok(!/^(dangerouslySetInnerHTML|innerHTML|href|src|srcDoc|formAction)$/.test(k), `prop ${k} must not be used`);
        if (k === 'style') for (const [sk, sv] of Object.entries(v)) assert.match(String(sv), /^\d+(\.\d+)?%?$/, `style ${sk} must be numeric`);
      }
    });
  });
});

test('the source has no unsafe DOM sinks, no external URLs and no non-ASCII characters', () => {
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  for (const sink of ['innerHTML', 'outerHTML', 'dangerouslySetInnerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'javascript:', 'srcdoc', 'localStorage', 'sessionStorage', '.appendChild(', 'createElementNS']) {
    assert.ok(!code.includes(sink), `found ${sink}`);
  }
  assert.ok(!/https?:\/\//.test(SOURCE), 'no external URLs');
  assert.ok(!/href\s*[:=]/.test(SOURCE), 'no href built from data');
  const raw = fs.readFileSync(INDEX);
  assert.ok(raw.every((b) => b < 128) && !raw.includes(13), 'ASCII with LF only');
  assert.ok(!SOURCE.includes(String.fromCharCode(92, 92)), 'no double backslash literals');
  assert.ok(!/(^|[^A-Za-z])import\s|export\s+(default|const|function)/.test(SOURCE), 'classic script: no import/export');
  const css = fs.readFileSync(path.resolve(path.dirname(INDEX), 'style.css'), 'utf8');
  assert.ok(!/https?:\/\/|@import|url\(/.test(css), 'stylesheet loads nothing external');
  assert.ok(/var\(--color-/.test(css), 'uses Hermes theme variables');
});

test('every class the stylesheet is built around exists in the bundle and vice versa (no dead prefix)', () => {
  const css = fs.readFileSync(path.resolve(path.dirname(INDEX), 'style.css'), 'utf8');
  const used = new Set([...SOURCE.matchAll(/["' ](rsr-[a-z0-9-]+)/g)].map((m) => m[1]));
  const defined = new Set([...css.matchAll(/\.(rsr-[a-z0-9-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((c) => !c.endsWith('-') && !defined.has(c) && !/^rsr-(title|loc|kw|source|priority|distance|active|cv|search)$/.test(c));
  assert.deepEqual(missing, []);
});
