'use strict';
// The search window for both sources (docs/ACTIVITY.md): the label list, the Caterer table and its validation, the setting
// CATERER_ACTIVITY_FILTER, the Reed mapping, and the page-summary reader. Pure functions: nothing here starts a process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..', '..');
const sa = require(path.join(REPO, 'resourcer', 'scripts', 'lib', 'search-activity'));
const reedSearch = require(path.join(REPO, 'resourcer', 'scripts', 'reed-search'));
const requestSearch = require(path.join(REPO, 'tools', 'request-search'));
const SHIPPED = path.join(REPO, 'resourcer', 'config', 'caterer-activity.json');

const shipped = () => sa.loadCatererConfig(SHIPPED);
const tmpFile = (text) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-cfg-'));
  const file = path.join(dir, 'caterer-activity.json');
  fs.writeFileSync(file, text);
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

test('the eight labels and the manual sources are exactly those of tools/request-search.js', () => {
  assert.deepEqual([...sa.LABELS], requestSearch.VALID_ACTIVE_WITHIN);
  assert.deepEqual([...sa.MANUAL_SOURCES], requestSearch.MANUAL_SOURCES);
  // the dashboard plugin writes the same source for the requests it queues
  const plugin = fs.readFileSync(path.join(REPO, 'plugin', 'resourcer', 'dashboard', 'plugin_api.py'), 'utf8');
  assert.match(plugin, /^MANUAL_SOURCES = \("dashboard", "request-search-cli"\)$/m);
  assert.ok(sa.isManualSource('dashboard') && sa.isManualSource('request-search-cli'));
  for (const other of ['territory-scheduler', 'queue-due-territories-autocatchup', 'reed-catchup', 'e2e-dashboard', '', undefined, null]) assert.equal(sa.isManualSource(other), false, String(other));
});

test('normaliseLabel accepts case and spacing, nothing else', () => {
  assert.equal(sa.normaliseLabel('12 MONTHS'), '12 months');
  assert.equal(sa.normaliseLabel('  1   month '), '1 month');
  assert.equal(sa.normaliseLabel('all'), 'All');
  for (const bad of ['month', '1month', '24 months', '', null, undefined, 12]) assert.equal(sa.normaliseLabel(bad), null, String(bad));
});

test('the shipped table holds only the ids of the legacy probe: 14 days 7, 1 month 8, 2 months 9, 6 months 11, 12 months 15, All 0; 3 and 18 months have none', () => {
  const c = shipped();
  assert.equal(c.ok, true, c.error);
  const ids = Object.fromEntries(Object.entries(c.labels).map(([k, v]) => [k, v.id]));
  assert.deepEqual(ids, { '14 days': 7, '1 month': 8, '2 months': 9, '3 months': null, '6 months': 11, '12 months': 15, '18 months': null, All: 0 });
  for (const label of ['14 days', '1 month', '2 months', '6 months', '12 months']) assert.deepEqual(c.labels[label].echo, [label]);
  assert.deepEqual(c.labels.All.echo, ['All', ''], 'All may also show no text at all');
});

test('the config is validated: every kind of damage is a fixed reason and no filter, never an exception', () => {
  const good = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));
  const damaged = [
    ['not json', '{ nope', /not valid JSON/],
    ['an array', '[]', /not a JSON object/],
    ['no labels', '{}', /no "labels"/],
    ['an unknown label', JSON.stringify({ labels: { '9 weeks': { id: 3, echo: ['9 weeks'] } } }), /not one of the eight labels/],
    ['a string id', JSON.stringify({ labels: { '1 month': { id: '8', echo: ['1 month'] } } }), /id must be a whole number/],
    ['a negative id', JSON.stringify({ labels: { '1 month': { id: -1, echo: ['1 month'] } } }), /id must be a whole number/],
    ['an id without echo', JSON.stringify({ labels: { '1 month': { id: 8 } } }), /no echo text/],
    ['an echo that is not plain', JSON.stringify({ labels: { '1 month': { id: 8, echo: ['<b>1 month</b>'] } } }), /echo must be/],
    ['two labels with one id', JSON.stringify({ labels: { '1 month': { id: 8, echo: ['1 month'] }, '2 months': { id: 8, echo: ['2 months'] } } }), /share the id 8/],
    ['an entry that is not an object', JSON.stringify({ labels: { '1 month': 8 } }), /is not an object/],
  ];
  assert.equal(good.labels['12 months'].id, 15);
  for (const [name, text, re] of damaged) {
    const f = tmpFile(text);
    try {
      const r = sa.loadCatererConfig(f.file);
      assert.equal(r.ok, false, name);
      assert.match(r.error, re, name);
      assert.ok(!r.error.includes('<b>'), 'the reason never repeats file text');
    } finally { f.cleanup(); }
  }
  const missing = sa.loadCatererConfig(path.join(os.tmpdir(), 'no-such-dir-activity', 'caterer-activity.json'));
  assert.deepEqual(missing, { ok: false, error: 'the file is missing' });
});

test('setting: manual is the default, all and off are read, anything else falls back to manual with a warning', () => {
  const get = (v) => () => v;
  assert.deepEqual(sa.readSetting(get(undefined)), { value: 'manual', warn: null });
  assert.deepEqual(sa.readSetting(get('')), { value: 'manual', warn: null });
  assert.deepEqual(sa.readSetting(get('ALL')), { value: 'all', warn: null });
  assert.deepEqual(sa.readSetting(get(' off ')), { value: 'off', warn: null });
  const bad = sa.readSetting(get('sometimes'));
  assert.equal(bad.value, 'manual');
  assert.match(bad.warn, /CATERER_ACTIVITY_FILTER is not manual, all or off/);
});

test('the Caterer decision for every label, scheduled and manual, under every setting', () => {
  const config = shipped();
  const expectedId = { '14 days': 7, '1 month': 8, '2 months': 9, '3 months': null, '6 months': 11, '12 months': 15, '18 months': null, All: 0 };
  for (const label of sa.LABELS) {
    for (const manual of [true, false]) {
      const off = sa.catererFilterFor({ activeWithin: label, manual, setting: 'off', config });
      assert.equal(off.id, null, `off never sends: ${label}`);
      const man = sa.catererFilterFor({ activeWithin: label, manual, setting: 'manual', config });
      assert.equal(man.id, manual ? expectedId[label] : null, `manual setting, manual=${manual}: ${label}`);
      const all = sa.catererFilterFor({ activeWithin: label, manual, setting: 'all', config });
      assert.equal(all.id, expectedId[label], `all sends for every search: ${label}`);
    }
  }
});

test('a window with no known id sends nothing, says exactly why, and warns (3 months, 18 months); a scheduled search under manual stays silent', () => {
  const config = shipped();
  for (const label of ['3 months', '18 months']) {
    const d = sa.catererFilterFor({ activeWithin: label, manual: true, setting: 'manual', config });
    assert.equal(d.id, null);
    assert.equal(d.warn, true);
    assert.match(d.note, new RegExp(`no Caterer LastActivityId is known for "${label}"`));
    assert.match(d.note, /no filter sent to Caterer/);
  }
  const quiet = sa.catererFilterFor({ activeWithin: '3 months', manual: false, setting: 'manual', config });
  assert.deepEqual([quiet.id, quiet.warn, quiet.note], [null, false, ''], 'a scheduled search under the default setting says nothing');
  const off = sa.catererFilterFor({ activeWithin: '12 months', manual: true, setting: 'off', config });
  assert.match(off.note, /CATERER_ACTIVITY_FILTER=off/);
  assert.equal(off.warn, false);
});

test('an unknown label and an unusable config send nothing and warn', () => {
  const unknown = sa.catererFilterFor({ activeWithin: 'last fortnight', manual: true, setting: 'manual', config: shipped() });
  assert.equal(unknown.id, null);
  assert.equal(unknown.warn, true);
  assert.match(unknown.note, /not one of the eight labels/);
  const f = tmpFile('{ broken');
  try {
    const d = sa.catererFilterFor({ activeWithin: '12 months', manual: true, setting: 'manual', file: f.file });
    assert.equal(d.id, null);
    assert.equal(d.warn, true);
    assert.match(d.note, /caterer-activity\.json is not usable \(the file is not valid JSON\): no filter sent to Caterer/);
    // a scheduled search under the default setting never even reads the file
    const quiet = sa.catererFilterFor({ activeWithin: '1 month', manual: false, setting: 'manual', file: f.file });
    assert.deepEqual([quiet.id, quiet.warn, quiet.note], [null, false, '']);
  } finally { f.cleanup(); }
});

test('the id of a results URL is read back, and only a whole LastActivityId parameter counts', () => {
  assert.equal(sa.sentIdFromUrl('https://x.test/r?a=1&LastActivityId=15&b=2'), 15);
  assert.equal(sa.sentIdFromUrl('https://x.test/r?LastActivityId=0'), 0);
  assert.equal(sa.sentIdFromUrl('https://x.test/r?a=1'), null);
  assert.equal(sa.sentIdFromUrl('https://x.test/r?XLastActivityId=15'), null);
  assert.equal(sa.sentIdFromUrl('https://x.test/r?LastActivityId=15x'), null);
});

test('Reed: every label maps to a key reed-search.js knows; the stored default is the value that was always sent; 18 months is the next wider window, with a note', () => {
  const map = reedSearch.ACTIVITY_TIMEFRAME_MAP;
  const want = { '14 days': 'TwoWeeks', '1 month': 'month', '2 months': 'TwoMonths', '3 months': 'ThreeMonths', '6 months': 'SixMonths', '12 months': 'year', '18 months': 'TwoYears', All: 'all' };
  for (const label of sa.LABELS) {
    const w = sa.reedWindowFor(label);
    assert.ok(Object.prototype.hasOwnProperty.call(map, w.arg), `${label}: "${w.arg}" is not a key of ACTIVITY_TIMEFRAME_MAP`);
    assert.equal(map[w.arg], want[label], label);
    assert.equal(w.exact, label !== '18 months', label);
    assert.equal(w.warn, label === '18 months', label);
  }
  assert.equal(sa.reedWindowFor('1 month').arg, 'month', 'the literal run-pipeline.js used before this change');
  assert.equal(sa.reedWindowFor(null).arg, 'month');
  assert.equal(sa.reedWindowFor(undefined).arg, 'month');
  assert.equal(sa.reedWindowFor('').arg, 'month');
  const eighteen = sa.reedWindowFor('18 months');
  assert.match(eighteen.note, /no 18 months window.*2 years/);
  // never narrower than asked: a window that cannot be matched exactly is wider
  const order = ['14 days', '1 month', '2 months', '3 months', '6 months', '12 months', '18 months', 'All'];
  const months = { month: 1, '2months': 2, '3months': 3, '6months': 6, year: 12, '2 years': 24, all: 1e9, '2 weeks': 0.5 };
  for (const label of order) {
    const asked = { '14 days': 0.5, '1 month': 1, '2 months': 2, '3 months': 3, '6 months': 6, '12 months': 12, '18 months': 18, All: 1e9 }[label];
    assert.ok(months[sa.reedWindowFor(label).arg] >= asked, `${label} is searched at least as wide as asked`);
  }
});

test('a window text that is none of the eight labels is cut to 20 plain characters wherever it is logged or stored', () => {
  const hostile = 'SECRET"' + String.fromCharCode(10) + 'FAKE_LINE: injected ' + 'y'.repeat(400);
  assert.equal(sa.plainLabel('12 months'), '12 months');
  assert.equal(sa.plainLabel(undefined), '');
  const p = sa.plainLabel(hostile);
  assert.ok(p.length <= 20 && /^[A-Za-z0-9 ?]*$/.test(p), p);
  const w = sa.reedWindowFor(hostile);
  assert.equal(w.arg, 'month');
  assert.equal(w.requested, p);
  assert.ok(!(w.requested + w.note).includes(String.fromCharCode(10)) && !(w.requested + w.note).includes('FAKE_LINE: '));
  const c = sa.catererFilterFor({ activeWithin: hostile, manual: true, setting: 'manual' });
  assert.equal(c.requested, p);
  assert.ok(!(c.requested + c.note).includes(String.fromCharCode(10)));
  assert.equal(c.id, null);
});

test('Reed: an unrecognised window behaves as before (a month) and warns; the CV limit is the request\'s own or the default', () => {
  const w = sa.reedWindowFor('last fortnight');
  assert.equal(w.arg, 'month');
  assert.equal(w.warn, true);
  assert.match(w.note, /not one of the eight labels: Reed searched the last month, as before/);
  assert.equal(sa.reedCvLimitFor(30), 30);
  assert.equal(sa.reedCvLimitFor('45'), 45);
  for (const bad of [undefined, null, 0, -3, 2.5, 'many', NaN]) assert.equal(sa.reedCvLimitFor(bad), 20, String(bad));
});

// ---------------------------------------------------------------------------------------------------- the page reader

function runRead(innerText, extraDoc) {
  const document = Object.assign({ body: { innerText } }, extraDoc || {});
  return vm.runInNewContext(sa.SUMMARY_JS, { document, JSON, parseInt, RegExp, String });
}

test('the page reader returns the header count, whether the summary line exists, and only the short window text: never other page text', () => {
  const page = [
    'Candidates 1,234', 'Alex Sample Sous Chef | Ilkley, LS29 8AB sam@example.invalid 07700 900123',
    'Search anything in CV or Profile: Chef. Exact match. Active within last: 12 months. CV/Profile: Both',
  ].join('\n');
  const out = runRead(page);
  assert.deepEqual(JSON.parse(out), { total: 1234, summary: true, active: '12 months', login: false });
  assert.ok(!/Sample|example|07700|Ilkley/.test(out), 'no card text leaves the page');
  const none = JSON.parse(runRead('Candidates 12\nSearch anything in CV or Profile: Chef. Exact match. CV/Profile: Both'));
  assert.deepEqual([none.total, none.summary, none.active], [12, true, null]);
  const nothing = JSON.parse(runRead('some other page'));
  assert.deepEqual([nothing.total, nothing.summary, nothing.active], [null, false, null]);
  const form = JSON.parse(runRead('Sign in', { querySelector: (s) => (s === '[name=password]' ? {} : null) }));
  assert.equal(form.login, true);
});

test('parseSummaryOutput reads the quoted JSON string agent-browser prints, and calls everything else unreadable', () => {
  const quoted = JSON.stringify(runRead('Candidates 77\nSearch anything in CV or Profile: Chef. Active within last: 6 months. x'));
  assert.deepEqual(sa.parseSummaryOutput(`\u001b[0mnoise\n${quoted}`), { readable: true, total: 77, summary: true, applied: '6 months', loggedOut: false });
  for (const bad of ['', 'Error: boom', '"not json"', '{"x":1}', undefined, null, '"{\\"total\\":\\"many\\"}"']) {
    assert.equal(sa.parseSummaryOutput(bad).readable, false, String(bad));
  }
  const login = sa.parseSummaryOutput(JSON.stringify(JSON.stringify({ total: null, summary: false, active: null, login: true })));
  assert.deepEqual([login.readable, login.loggedOut], [false, true]);
  // text that is not plain is dropped, never logged
  const odd = sa.parseSummaryOutput(JSON.stringify(JSON.stringify({ total: 5, summary: true, active: '12 months <script>', login: false })));
  assert.equal(odd.readable, false);
  assert.equal(odd.applied, '');
});

test('evaluateApplied: match yes, no and unreadable when an id was sent; n/a when none was; the applied text is kept either way', () => {
  const exp = { label: '12 months', echo: ['12 months'] };
  const read = (applied, over) => Object.assign({ readable: true, total: 55, summary: true, applied, loggedOut: false }, over || {});
  assert.deepEqual(sa.evaluateApplied({ sentId: 15, expected: exp, reading: read('12 Months') }), { matched: 'yes', applied: '12 Months', poolHeaderCount: 55 });
  assert.deepEqual(sa.evaluateApplied({ sentId: 15, expected: exp, reading: read('1 month') }), { matched: 'no', applied: '1 month', poolHeaderCount: 55 });
  assert.deepEqual(sa.evaluateApplied({ sentId: 15, expected: exp, reading: read('') }), { matched: 'no', applied: '', poolHeaderCount: 55 }, 'a readable page that shows no window is a mismatch for a non-All id');
  assert.equal(sa.evaluateApplied({ sentId: 15, expected: exp, reading: { readable: false, total: null, applied: '' } }).matched, 'unreadable');
  const all = { label: 'All', echo: ['All', ''] };
  assert.equal(sa.evaluateApplied({ sentId: 0, expected: all, reading: read('') }).matched, 'yes', 'All may show no text');
  assert.equal(sa.evaluateApplied({ sentId: 0, expected: all, reading: read('1 month') }).matched, 'no');
  assert.deepEqual(sa.evaluateApplied({ sentId: null, expected: null, reading: read('1 month') }), { matched: 'n/a', applied: '1 month', poolHeaderCount: 55 }, 'a scheduled run logs what Caterer applied by default');
  assert.deepEqual(sa.evaluateApplied({ sentId: null, expected: null, reading: read('') }), { matched: 'n/a', applied: '', poolHeaderCount: 55 });
  assert.equal(sa.evaluateApplied({ sentId: 15, expected: null, reading: read('12 months') }).matched, 'n/a', 'an id the config does not know any more cannot be compared');
  // a header with no summary line (the layout changed, or an empty results page) says nothing about the window: never a verdict
  assert.deepEqual(sa.evaluateApplied({ sentId: 15, expected: exp, reading: read('', { summary: false }) }), { matched: 'unreadable', applied: '', poolHeaderCount: 55 });
  assert.equal(sa.evaluateApplied({ sentId: 0, expected: all, reading: read('', { summary: false }) }).matched, 'unreadable', 'not even All is confirmed without the summary line');
  assert.equal(sa.evaluateApplied({ sentId: null, expected: null, reading: read('', { summary: false }) }).matched, 'n/a');
});

test('the ACTIVITY_FILTER line has the documented shape, and nothing but plain text goes into it', () => {
  assert.equal(sa.activityLine('12 months', 15, '12 months', 'yes'), 'ACTIVITY_FILTER requested="12 months" sent="LastActivityId=15" applied="12 months" match=yes');
  assert.equal(sa.activityLine('1 month', null, '', 'n/a'), 'ACTIVITY_FILTER requested="1 month" sent="LastActivityId=none" applied="" match=n/a');
  assert.equal(sa.activityLine('x"y', 7, 'a\nb<c>', 'no'), 'ACTIVITY_FILTER requested="x?y" sent="LastActivityId=7" applied="a?b?c?" match=no');
});

test('the alert is sent once per London day, the day is marked before sending, and a failed send does not use the day up', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-alert-'));
  try {
    const file = path.join(dir, 'activity-alert.json');
    const sent = [];
    const notify = (a) => { sent.push(a); };
    const at = (iso) => new Date(iso);
    assert.equal(sa.alertOncePerDay({ text: 't1', file, now: at('2026-10-02T09:00:00Z'), notify }), true);
    assert.equal(sa.alertOncePerDay({ text: 't2', file, now: at('2026-10-02T15:00:00Z'), notify }), false, 'same day');
    assert.equal(sa.alertOncePerDay({ text: 't3', file, now: at('2026-10-03T09:00:00Z'), notify }), true, 'next day');
    assert.deepEqual(sent.map((a) => [a.key, a.severity, a.text]), [['caterer-activity-mismatch', 'warn', 't1'], ['caterer-activity-mismatch', 'warn', 't3']]);
    const failing = () => { throw new Error('outbox down'); };
    assert.equal(sa.alertOncePerDay({ text: 't4', file, now: at('2026-10-04T09:00:00Z'), notify: failing }), false);
    assert.equal(sa.alertOncePerDay({ text: 't5', file, now: at('2026-10-04T10:00:00Z'), notify }), true, 'the failed send did not use the day up');
    // the day is the London day, not the UTC day: in summer time 22:30Z is the 5th and 23:30Z is already the 6th
    assert.equal(sa.alertOncePerDay({ text: 't6', file, now: at('2026-10-05T22:30:00Z'), notify }), true);
    assert.equal(sa.alertOncePerDay({ text: 't7', file, now: at('2026-10-05T23:30:00Z'), notify }), true, 'London midnight has passed');
    assert.equal(sa.alertOncePerDay({ text: 't8', file, now: at('2026-10-06T08:00:00Z'), notify }), false, 'still the 6th in London');
    // one alert per cause and day: a window that does not match must not hide an unreadable page (and the reverse), and a failed send gives its cause back
    const day = at('2026-10-07T09:00:00Z');
    assert.equal(sa.alertOncePerDay({ text: 'c1', cause: 'no', file, now: day, notify }), true);
    assert.equal(sa.alertOncePerDay({ text: 'c2', cause: 'no', file, now: day, notify }), false);
    assert.equal(sa.alertOncePerDay({ text: 'c3', cause: 'unreadable', file, now: day, notify }), true, 'another cause, the same day');
    assert.equal(sa.alertOncePerDay({ text: 'c4', cause: 'unreadable', file, now: day, notify }), false);
    const day2 = at('2026-10-08T09:00:00Z');
    assert.equal(sa.alertOncePerDay({ text: 'c5', cause: 'no', file, now: day2, notify }), true);
    assert.equal(sa.alertOncePerDay({ text: 'c6', cause: 'unreadable', file, now: day2, notify: failing }), false);
    assert.equal(sa.alertOncePerDay({ text: 'c7', cause: 'no', file, now: day2, notify }), false, 'the first cause stays used up');
    assert.equal(sa.alertOncePerDay({ text: 'c8', cause: 'unreadable', file, now: day2, notify }), true, 'the failed one was given back');
    // a state file of the earlier form ({day} only) means everything was sent today
    fs.writeFileSync(file, JSON.stringify({ day: '2026-10-09' }));
    assert.equal(sa.alertOncePerDay({ text: 'c9', cause: 'no', file, now: at('2026-10-09T09:00:00Z'), notify }), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
