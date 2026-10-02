'use strict';
// The Caterer results URL and the params of a run (docs/ACTIVITY.md): a scheduled territory gets the URL and the params it always had,
// a one-off request carries its window as LastActivityId, and the setting CATERER_ACTIVITY_FILTER (manual, all, off) decides who sends it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPTS = path.join(REPO, 'resourcer', 'scripts');
const builder = require(path.join(SCRIPTS, 'build-caterer-results-url'));
const sa = require(path.join(SCRIPTS, 'lib', 'search-activity'));
const runner = require(path.join(SCRIPTS, 'watchdog-runner'));
const { normaliseResultsUrl } = require(path.join(SCRIPTS, 'phase1', 'url'));

const CONFIG = sa.loadCatererConfig(path.join(REPO, 'resourcer', 'config', 'caterer-activity.json'));
const ID = { '14 days': 7, '1 month': 8, '2 months': 9, '3 months': null, '6 months': 11, '12 months': 15, '18 months': null, All: 0 };
const BASE = { jobTitle: 'Chef', location: 'FY4', distance: 20, keywords: '', searchId: 'sid-1' };

// The builder of the commit this change started from (the installed release), loaded from git when history is here.
function mainBuilder() {
  const r = spawnSync('git', ['show', 'bc3e750:resourcer/scripts/build-caterer-results-url.js'], { cwd: REPO, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-builder-'));
  const file = path.join(dir, 'build-caterer-results-url.js');
  fs.writeFileSync(file, r.stdout.replace("require('./constants')", `require(${JSON.stringify(path.join(SCRIPTS, 'constants'))})`));
  return { mod: require(file), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const withSetting = (value, fn) => {
  const before = process.env.CATERER_ACTIVITY_FILTER;
  if (value === undefined) delete process.env.CATERER_ACTIVITY_FILTER; else process.env.CATERER_ACTIVITY_FILTER = value;
  try { return fn(); } finally { if (before === undefined) delete process.env.CATERER_ACTIVITY_FILTER; else process.env.CATERER_ACTIVITY_FILTER = before; }
};

test('a scheduled territory gets the URL of main, byte for byte, under the default setting and under off (any label, any input)', (t) => {
  const main = mainBuilder();
  if (!main) { t.skip('no git history with the installed release bc3e750 here'); return; }
  t.after(main.cleanup);
  const inputs = [
    BASE, { ...BASE, jobTitle: 'Kitchen Porter', location: 'DL7', distance: 30 }, { ...BASE, keywords: 'nvq dbs', distance: 5 },
    { ...BASE, jobTitle: 'Kitchen & Porter', location: 'B1', distance: 25 },
  ];
  for (const setting of [undefined, 'manual', 'off']) {
    for (const input of inputs) {
      const old = main.mod.buildResultsUrl(input).url;
      withSetting(setting, () => {
        assert.equal(builder.buildResultsUrl(input).url, old, `no window passed, setting ${setting}`);
        for (const label of sa.LABELS) {
          assert.equal(builder.buildResultsUrl({ ...input, activeWithin: label, manual: false }).url, old, `scheduled ${label}, setting ${setting}`);
        }
        assert.equal(builder.buildResultsUrl({ ...input, activeWithin: '1 month' }).url, old, 'manual absent means scheduled');
      });
    }
  }
  withSetting('off', () => {
    for (const label of sa.LABELS) assert.equal(builder.buildResultsUrl({ ...BASE, activeWithin: label, manual: true }).url, main.mod.buildResultsUrl(BASE).url, `off, manual ${label}`);
  });
});

test('a one-off request carries LastActivityId after HideCandidatesSinceDays and nothing else changes in the URL', () => {
  const plain = builder.buildResultsUrl(BASE).url;
  const r = withSetting(undefined, () => builder.buildResultsUrl({ ...BASE, activeWithin: '12 months', manual: true }));
  assert.equal(r.url, plain.replace('&HideCandidatesSinceDays=7&', '&HideCandidatesSinceDays=7&LastActivityId=15&'));
  assert.equal(r.activity.id, 15);
  assert.equal(r.activity.warn, false);
  assert.deepEqual(r.activity.echo, ['12 months']);
});

test('every label of a manual request: the mapped id, or no parameter and a WARN note for 3 and 18 months', () => {
  const plain = builder.buildResultsUrl(BASE).url;
  for (const label of sa.LABELS) {
    const r = withSetting('manual', () => builder.buildResultsUrl({ ...BASE, activeWithin: label, manual: true, activityConfig: CONFIG }));
    if (ID[label] === null) {
      assert.equal(r.url, plain, label);
      assert.equal(r.activity.warn, true, label);
      assert.match(r.activity.note, /no Caterer LastActivityId is known/);
    } else {
      assert.match(r.url, new RegExp(`&HideCandidatesSinceDays=7&LastActivityId=${ID[label]}&SearchId=sid-1&scr=1$`), label);
      assert.equal(r.activity.warn, false, label);
    }
  }
});

test('setting all sends the stored window of a scheduled territory too; off sends nothing even for a request; "All" is sent only when the window says All', () => {
  withSetting('all', () => {
    assert.match(builder.buildResultsUrl({ ...BASE, activeWithin: '1 month', manual: false }).url, /&LastActivityId=8&/);
    assert.match(builder.buildResultsUrl({ ...BASE, activeWithin: '6 months', manual: false }).url, /&LastActivityId=11&/);
    assert.match(builder.buildResultsUrl({ ...BASE, activeWithin: 'All', manual: true }).url, /&LastActivityId=0&/);
  });
  withSetting('off', () => {
    const r = builder.buildResultsUrl({ ...BASE, activeWithin: '12 months', manual: true });
    assert.ok(!/LastActivityId/.test(r.url));
    assert.match(r.activity.note, /CATERER_ACTIVITY_FILTER=off/);
  });
  withSetting('manual', () => {
    assert.ok(!/LastActivityId/.test(builder.buildResultsUrl({ ...BASE, activeWithin: 'All', manual: false }).url), 'a scheduled territory never sends All under manual');
    assert.match(builder.buildResultsUrl({ ...BASE, activeWithin: 'All', manual: true }).url, /&LastActivityId=0&/);
  });
});

test('an invalid config file sends no filter and says why, in the URL builder and with a window that is not a label', () => {
  const bad = { ok: false, error: 'the file is not valid JSON' };
  const r = builder.buildResultsUrl({ ...BASE, activeWithin: '12 months', manual: true, activityConfig: bad, activitySetting: 'manual' });
  assert.ok(!/LastActivityId/.test(r.url));
  assert.equal(r.activity.warn, true);
  assert.match(r.activity.note, /not usable \(the file is not valid JSON\)/);
  const odd = builder.buildResultsUrl({ ...BASE, activeWithin: 'sometime', manual: true, activitySetting: 'manual' });
  assert.ok(!/LastActivityId/.test(odd.url));
  assert.match(odd.activity.note, /not one of the eight labels/);
});

test('the builder CLI: --active-within with --manual adds the id, without --manual a scheduled search stays as before', () => {
  const run = (args, env) => spawnSync(process.execPath, [path.join(SCRIPTS, 'build-caterer-results-url.js'), '--job', 'Chef', '--location', 'FY4', '--distance', '20', '--search-id', 'g'].concat(args), { encoding: 'utf8', env: Object.assign({}, process.env, { CATERER_ACTIVITY_FILTER: '' }, env || {}) });
  const manual = run(['--active-within', '12 months', '--manual']);
  assert.equal(manual.status, 0, manual.stderr);
  assert.match(manual.stdout, /^RESULTS_URL:.*&LastActivityId=15&SearchId=g&scr=1$/m);
  const sched = run(['--active-within', '12 months']);
  assert.ok(!/LastActivityId/.test(sched.stdout));
  assert.equal(sched.stderr, '');
  const unmapped = run(['--active-within', '3 months', '--manual']);
  assert.ok(!/LastActivityId/.test(unmapped.stdout));
  assert.match(unmapped.stderr, /^NOTE:no Caterer LastActivityId is known for "3 months"/m);
});

test('phase 1 keeps LastActivityId when it normalises the URL, and adds nothing of the kind when the URL has none', () => {
  const withId = builder.buildResultsUrl({ ...BASE, activeWithin: '12 months', manual: true, activitySetting: 'manual', activityConfig: CONFIG }).url;
  const a = normaliseResultsUrl(`${withId}#top`);
  assert.match(a.base, /&LastActivityId=15&SearchId=sid-1&scr=1&SearchFormType=Targeted&SearchOptionColumn=ExactMatch&PageSize=50$/);
  assert.equal(sa.sentIdFromUrl(a.base), 15);
  const b = normaliseResultsUrl(builder.buildResultsUrl(BASE).url);
  assert.ok(!/LastActivityId/.test(b.base));
  assert.equal(sa.sentIdFromUrl(b.base), null);
});

// ---------------------------------------------------------------------------------------------------- the params of a run

function ctxFor(allowed) {
  return { allowedSources: () => allowed || 'both', buildResultsUrl: (p) => builder.buildResultsUrl({ ...p, searchId: 'sid-1' }) };
}
const pendingOf = (over) => Object.assign({ jobTitle: 'Chef', location: 'FY4', distance: 20, keywords: '', priority: 'low', sources: 'both', activeWithin: '1 month', cvLimit: 20, requestedAt: '2026-10-01T10:00:00.000Z', source: 'territory-scheduler' }, over);

test('params of a scheduled territory with the stored defaults: exactly the keys and values they always had, no note, no window in the URL, nothing logged', () => {
  const events = [];
  const params = withSetting(undefined, () => runner.buildParams(ctxFor(), pendingOf(), '/init.json', (e, d) => events.push([e, d])));
  assert.deepEqual(params, {
    RESULTS_URL: builder.buildResultsUrl({ ...BASE }).url, SEARCH_ID: 'sid-1', JOB_TITLE: 'Chef', LOCATION: 'FY4', DISTANCE_MILES: 20, ACTIVE_WITHIN: '1 month', CV_LIMIT: 20,
    KEYWORDS: '', CANDIDATE_COUNT: 0, SOURCES: 'both', REQUESTED_AT: '2026-10-01T10:00:00.000Z', PRIORITY: 'low', INIT_STATUS_FILE: '/init.json',
  });
  assert.deepEqual(Object.keys(params), ['RESULTS_URL', 'SEARCH_ID', 'JOB_TITLE', 'LOCATION', 'DISTANCE_MILES', 'ACTIVE_WITHIN', 'CV_LIMIT', 'KEYWORDS', 'CANDIDATE_COUNT', 'SOURCES', 'REQUESTED_AT', 'PRIORITY', 'INIT_STATUS_FILE']);
  assert.deepEqual(events, [], 'a plain scheduled run adds no log line');
  // the catch-up that queues missed territories is not a person asking either
  const catchup = withSetting(undefined, () => runner.buildParams(ctxFor(), pendingOf({ source: 'queue-due-territories-autocatchup', activeWithin: '12 months' }), '/init.json'));
  assert.ok(!/LastActivityId/.test(catchup.RESULTS_URL));
  assert.equal(catchup.ACTIVE_WITHIN, '12 months');
});

test('params of a one-off request (dashboard or request-search-cli): the window reaches the URL, the CV limit reaches the params, and the decision is logged', () => {
  for (const source of ['request-search-cli', 'dashboard']) {
    const events = [];
    const params = withSetting(undefined, () => runner.buildParams(ctxFor(), pendingOf({ source, activeWithin: '12 months', cvLimit: 30, priority: 'high' }), '/init.json', (e, d) => events.push([e, d])));
    assert.match(params.RESULTS_URL, /&LastActivityId=15&/, source);
    assert.equal(params.ACTIVE_WITHIN, '12 months');
    assert.equal(params.CV_LIMIT, 30);
    assert.equal(params.ACTIVITY_NOTE, undefined, 'nothing unusual to say');
    assert.deepEqual(events, [['activity-filter', { requested: '12 months', setting: 'manual', manual: true, sent: 15, note: undefined }]]);
  }
});

test('params of a one-off request for a window with no id: the URL has none, the note travels in the params, and the log line is a warning', () => {
  const events = [];
  const params = withSetting(undefined, () => runner.buildParams(ctxFor(), pendingOf({ source: 'request-search-cli', activeWithin: '18 months', cvLimit: 25 }), '/init.json', (e, d) => events.push([e, d])));
  assert.ok(!/LastActivityId/.test(params.RESULTS_URL));
  assert.match(params.ACTIVITY_NOTE, /no Caterer LastActivityId is known for "18 months"/);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'activity-filter-warn');
  assert.equal(events[0][1].sent, 'none');
});

test('the setting changes who sends: all sends for a scheduled territory, off for nobody', () => {
  const sched = pendingOf({ activeWithin: '2 months' });
  assert.match(withSetting('all', () => runner.buildParams(ctxFor(), sched, '/i.json')).RESULTS_URL, /&LastActivityId=9&/);
  assert.ok(!/LastActivityId/.test(withSetting('off', () => runner.buildParams(ctxFor(), pendingOf({ source: 'dashboard', activeWithin: '2 months' }), '/i.json')).RESULTS_URL));
  assert.ok(!/LastActivityId/.test(withSetting('manual', () => runner.buildParams(ctxFor(), sched, '/i.json')).RESULTS_URL));
});

test('a builder that returns no activity (an injected one) leaves the params as they were', () => {
  const ctx = { allowedSources: () => 'caterer', buildResultsUrl: () => ({ url: 'https://example.test/r', searchId: 's' }) };
  const params = runner.buildParams(ctx, pendingOf({ source: 'dashboard', activeWithin: '12 months' }), '/i.json');
  assert.equal(params.RESULTS_URL, 'https://example.test/r');
  assert.equal('ACTIVITY_NOTE' in params, false);
});
