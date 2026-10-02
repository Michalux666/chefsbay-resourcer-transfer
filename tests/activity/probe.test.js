'use strict';
// tools/activity-probe.js (docs/OPERATIONS.md, docs/ACTIVITY.md): what the "active within" windows really do. Read-only, counts and fixed
// strings only, refuses while the pipeline is busy. Everything here runs against fake adapters; the real adapters are exercised by the
// end-to-end rehearsal (tests/e2e/21-activity.e2e.js) against the fake Caterer and Reed sites.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const probe = require(path.join(REPO, 'tools', 'activity-probe'));
const sa = require(path.join(REPO, 'resourcer', 'scripts', 'lib', 'search-activity'));

const ARGS = ['--job', 'Test Role', '--location', 'FY4', '--distance', '20'];
const SENTINELS = ['Sam Sample', 'sam@example.invalid', '07700 900123', 'Ilkley'];

function io() {
  const out = [];
  const err = [];
  return { out: (s) => out.push(s), err: (s) => err.push(s), lines: out, errs: err, text: () => out.concat(err).join('\n') };
}

function fakeDeps(over) {
  const log = [];
  const echo = { none: '', 7: '14 days', 8: '1 month', 9: '2 months', 11: '6 months', 15: '12 months', 0: 'All' };
  const total = { none: 1500, 7: 100, 8: 400, 9: 700, 11: 1000, 15: 1400, 0: 2500 };
  const reedTotals = { Day: 5, TwoDays: 8, Week: 30, TwoWeeks: 70, month: 150, TwoMonths: 260, ThreeMonths: 400, SixMonths: 700, year: 1200, TwoYears: 1900, all: 3000 };
  const deps = {
    log,
    busy: () => { log.push('busy?'); return { busy: false }; },
    acquireBrowser: (owner) => { log.push(`lock:${owner}`); return { ok: true, release: () => log.push(`release:${owner}`) }; },
    caterer: {
      async readPage(url) {
        const m = /[?&]LastActivityId=(\d+)/.exec(url);
        const id = m ? m[1] : 'none';
        log.push(`page:${id}`);
        deps.urls.push(url);
        return { status: 'ok', applied: echo[id], total: total[id] };
      },
    },
    reed: {
      async prepare() { log.push('reed:prepare'); return { ok: true }; },
      async count(o, key) {
        const value = require(path.join(REPO, 'resourcer', 'scripts', 'reed-search')).ACTIVITY_TIMEFRAME_MAP[key];
        log.push(`reed:${value}`);
        return { ok: true, total: reedTotals[value] };
      },
      async finish() { log.push('reed:finish'); },
    },
    urls: [],
  };
  return Object.assign(deps, over || {});
}

test('--help and every usage error: nothing is requested, the exit codes are 0 and 2', async () => {
  const h = io();
  assert.equal(await probe.main(['--help'], h, fakeDeps()), 0);
  assert.match(h.text(), /Read-only: search pages only, no unlock, no credit, no profile view, no Zoho/);
  for (const bad of [[], ['--job', 'Test Role'], ['--job', 'Test Role', '--location', 'Leeds', '--distance', '20'], ['--job', 'Test Role', '--location', 'FY4'],
    ['--job', 'Test Role', '--location', 'FY4', '--distance', '25'], ['--job', 'Test Role', '--location', 'FY4', '--distance', '20', '--source', 'moon'],
    ['--job', 'x@y', '--location', 'FY4', '--distance', '20'], ['--unknown'], ['--job']]) {
    const e = io();
    const deps = fakeDeps();
    assert.equal(await probe.main(bad, e, deps), 2, JSON.stringify(bad));
    assert.deepEqual(deps.log, [], `nothing was touched: ${JSON.stringify(bad)}`);
  }
});

test('--dry-run lists the Caterer and Reed variants and makes no request: no busy check, no lock, no page, no search', async () => {
  const h = io();
  const deps = fakeDeps();
  assert.equal(await probe.main(ARGS.concat(['--dry-run']), h, deps), 0);
  assert.deepEqual(deps.log, []);
  const t = h.text();
  assert.match(t, /DRY RUN \(no request is made\)/);
  const caterer = h.lines.filter((l) => l.startsWith('CATERER variant'));
  assert.deepEqual(caterer.map((l) => /param=(\S+)/.exec(l)[1]), ['none', 'LastActivityId=7', 'LastActivityId=8', 'LastActivityId=9', 'LastActivityId=11', 'LastActivityId=15', 'LastActivityId=0']);
  const values = h.lines.filter((l) => l.startsWith('REED variant')).map((l) => /activityTimeFrame=(\S+)/.exec(l)[1]);
  assert.deepEqual(values, ['Day', 'TwoDays', 'Week', 'TwoWeeks', 'month', 'TwoMonths', 'ThreeMonths', 'SixMonths', 'year', 'TwoYears', 'all']);
  assert.ok(!/https?:/.test(t), 'no URL is printed');
  const reedOnly = io();
  await probe.main(ARGS.concat(['--dry-run', '--source', 'reed']), reedOnly, deps);
  assert.ok(!reedOnly.lines.some((l) => l.startsWith('CATERER variant')));
  const catOnly = io();
  await probe.main(ARGS.concat(['--dry-run', '--source', 'caterer']), catOnly, deps);
  assert.ok(!catOnly.lines.some((l) => l.startsWith('REED variant')));
});

test('a pipeline run in flight, or a held browser lock, is refused with exit 3 before any page is loaded or any search is made', async () => {
  const busy = fakeDeps({ busy: () => ({ busy: true, why: 'a pipeline run is in flight (runner)' }) });
  const h = io();
  assert.equal(await probe.main(ARGS, h, busy), 3);
  assert.match(h.errs.join('\n'), /^REFUSED: a pipeline run is in flight \(runner\)\./);
  assert.deepEqual(busy.urls, []);
  const locked = fakeDeps({ acquireBrowser: (owner) => { locked.log.push(`lock:${owner}`); return { ok: false, why: 'browser.lock is held by caterer' }; } });
  const h2 = io();
  assert.equal(await probe.main(ARGS, h2, locked), 3);
  assert.match(h2.errs.join('\n'), /REFUSED: browser\.lock is held by caterer/);
  assert.deepEqual(locked.urls, []);
  assert.ok(!locked.log.some((l) => l.startsWith('page:') || l.startsWith('reed:')));
  // the Reed lock refused after a good Caterer pass: exit 3, the Caterer numbers were printed
  const reedLocked = fakeDeps({ acquireBrowser: (owner) => { reedLocked.log.push(`lock:${owner}`); return owner === 'reed' ? { ok: false, why: 'browser.lock is held by caterer' } : { ok: true, release: () => reedLocked.log.push(`release:${owner}`) }; } });
  const h3 = io();
  assert.equal(await probe.main(ARGS, h3, reedLocked), 3);
  assert.equal(h3.lines.filter((l) => l.startsWith('CATERER param=')).length, 7);
});

test('a full run prints, for each variant, the parameter, the applied text and the pool of the header (Caterer) and the total (Reed); the pages are the pipeline\'s own URLs', async () => {
  const h = io();
  const deps = fakeDeps();
  assert.equal(await probe.main(ARGS, h, deps), 0, h.text());
  assert.deepEqual(deps.log.slice(0, 3), ['busy?', 'lock:caterer', 'page:none']);
  assert.deepEqual(deps.log.filter((l) => l.startsWith('page:')), ['page:none', 'page:7', 'page:8', 'page:9', 'page:11', 'page:15', 'page:0']);
  assert.ok(deps.log.indexOf('release:caterer') < deps.log.indexOf('lock:reed'), 'one browser at a time: the Caterer lock is released before the Reed lock is taken');
  assert.ok(deps.log.indexOf('reed:prepare') < deps.log.indexOf('reed:Day'));
  assert.ok(deps.log.indexOf('reed:finish') < deps.log.indexOf('release:reed'));
  for (const u of deps.urls) {
    assert.match(u, /^https:\/\/recruiter\.caterer\.com\/CandidateSearchWebMvc\/CandidateSearch\/Results\?FreeText=Test\+Role&/);
    assert.match(u, /&CurrentLocation=FY4&Radius=32187&/);
    assert.match(u, /&SearchFormType=Targeted&SearchOptionColumn=ExactMatch&PageSize=50$/, 'the same normalisation as phase 1');
  }
  assert.ok(!/LastActivityId/.test(deps.urls[0]), 'the first page is the URL a scheduled search uses');
  const t = h.lines.join('\n');
  assert.match(t, /CATERER param=none label="\(no parameter[^"]*" applied="" pool=1500 status=ok/);
  assert.match(t, /CATERER param=LastActivityId=15 label="12 months" applied="12 months" pool=1400 status=ok/);
  assert.match(t, /CATERER param=LastActivityId=0 label="All" applied="All" pool=2500 status=ok/);
  assert.match(t, /REED activityTimeFrame=year key="year" total=1200 status=ok/);
  assert.match(t, /REED activityTimeFrame=TwoYears key="2 years" total=1900 status=ok/);
  assert.equal(h.lines.filter((l) => l.startsWith('REED activityTimeFrame=')).length, 11);
  assert.match(h.lines[h.lines.length - 1], /^# done: 0 variant\(s\) could not be read$/);
});

test('output is counts and fixed strings only: odd text from an adapter is reduced to plain characters, and no candidate text is ever asked for', async () => {
  const deps = fakeDeps();
  deps.caterer.readPage = async () => ({ status: 'ok', applied: 'x\n<b>"quoted"</b> sam@example.invalid', total: 12 });
  const h = io();
  assert.equal(await probe.main(ARGS.concat(['--source', 'caterer']), h, deps), 0);
  assert.ok(!h.text().includes('@'), 'no e-mail shaped text');
  assert.ok(!h.text().includes('<b>'));
  for (const s of SENTINELS) assert.ok(!h.text().includes(s));
  // the tool itself holds no way to an unlock, a credit, a profile, a CV, Zoho or the database
  const src = fs.readFileSync(path.join(REPO, 'tools', 'activity-probe.js'), 'utf8');
  const modules = [...src.matchAll(/(?:lib|require)\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(modules.length >= 8, `only ${modules.length} modules found`);
  assert.deepEqual(modules.filter((m) => /unlock|download|zoho|candidates-db|process-approved|credits|profile|cv-/i.test(m)), [], 'no module of a paid or writing action is reachable from the probe');
});

test('a signed-out Caterer browser stops the Caterer pass with a fixed note and exit 4; the probe never signs in and does not touch Reed after it', async () => {
  const deps = fakeDeps();
  deps.caterer.readPage = async (url) => { deps.urls.push(url); return { status: 'logged-out', applied: '', total: null }; };
  const h = io();
  assert.equal(await probe.main(ARGS, h, deps), 4);
  assert.equal(deps.urls.length, 1, 'stopped at the first page');
  assert.match(h.lines.join('\n'), /status=logged-out/);
  assert.match(h.lines.join('\n'), /The probe never signs in/);
  assert.ok(!deps.log.some((l) => l.startsWith('reed:') || l === 'lock:reed'));
  assert.ok(deps.log.includes('release:caterer'), 'the lock is given back');
});

test('variants that cannot be read are printed as such and the others still are: exit 5; Reed not ready: exit 4, nothing searched', async () => {
  const deps = fakeDeps();
  const orig = deps.caterer.readPage;
  deps.caterer.readPage = async (url) => (/LastActivityId=9(&|$)/.test(url) ? { status: 'error', applied: '', total: null } : orig(url));
  deps.reed.count = async (o, key) => (key === 'year' ? { ok: false, code: 'HTTP 400' } : { ok: true, total: 10 });
  const h = io();
  assert.equal(await probe.main(ARGS, h, deps), 5);
  assert.match(h.lines.join('\n'), /CATERER param=LastActivityId=9 label="2 months" applied="" pool=\? status=error/);
  assert.match(h.lines.join('\n'), /CATERER param=LastActivityId=15 .* status=ok/);
  assert.match(h.lines.join('\n'), /REED activityTimeFrame=year key="year" status=HTTP 400/);
  assert.match(h.lines[h.lines.length - 1], /^# done: 2 variant\(s\) could not be read$/);

  const notReady = fakeDeps();
  notReady.reed.prepare = async () => ({ ok: false, reason: 'sign-in needed' });
  const h2 = io();
  assert.equal(await probe.main(ARGS, h2, notReady), 4);
  assert.match(h2.lines.join('\n'), /REED status=not-ready reason="sign-in needed"/);
  assert.ok(!notReady.log.some((l) => /^reed:(Day|month|year)/.test(l)));
  assert.ok(notReady.log.includes('release:reed'));
});

test('an unusable caterer-activity.json leaves only the no-parameter page, with a note', async () => {
  const deps = fakeDeps();
  const h = io();
  assert.equal(await probe.main(ARGS.concat(['--source', 'caterer']), Object.assign(h, { config: { ok: false, error: 'the file is not valid JSON' } }), deps), 0);
  assert.match(h.lines.join('\n'), /NOTE caterer-activity\.json is not usable \(the file is not valid JSON\): only the no-parameter page is probed/);
  assert.deepEqual(deps.log.filter((l) => l.startsWith('page:')), ['page:none']);
});

test('--recent prints the window of the last runs from their results files: requested, sent, applied, match, pool and the Reed half', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-recent-'));
  try {
    const dir = path.join(home, 'downloads');
    fs.mkdirSync(dir);
    const write = (name, obj, age) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, JSON.stringify(obj));
      const t = new Date(Date.now() - age * 1000);
      fs.utimesSync(f, t, t);
    };
    write('phase2-results-a.json', { date: '2026-10-02', location: 'FY4', sources: 'both', jobTitle: 'Test Role', activity: { requestedActiveWithin: '12 months', requestedCvLimit: 30, sentLastActivityId: 15, appliedFilterText: '12 months', poolHeaderCount: 321, matched: 'yes', reed: { activeWithin: 'year', cvLimit: 30, ran: true } } }, 10);
    write('phase2-results-b.json', { date: '2026-10-01', location: 'LS1', sources: 'caterer', activity: { requestedActiveWithin: '1 month', requestedCvLimit: 20, sentLastActivityId: 'none', appliedFilterText: '', poolHeaderCount: 90, matched: 'n/a' } }, 20);
    write('phase2-results-c.json', { date: '2026-09-30', location: 'M1', sources: 'caterer' }, 30);
    write('phase2-results-d.json', 'not an object', 40);
    fs.writeFileSync(path.join(dir, 'phase2-results-e.json'), '{ broken');
    const lines = probe.recentRuns(5, home);
    assert.equal(lines.length, 3, 'unreadable files are skipped');
    assert.equal(lines[0], 'RUN date=2026-10-02 location=FY4 sources=both requested="12 months" cv_limit=30 sent="LastActivityId=15" applied="12 months" match=yes pool=321 reed_window=year reed_cv_limit=30');
    assert.equal(lines[1], 'RUN date=2026-10-01 location=LS1 sources=caterer requested="1 month" cv_limit=20 sent="LastActivityId=none" applied="" match=n/a pool=90');
    assert.match(lines[2], /^RUN date=2026-09-30 location=M1 sources=caterer activity=not-recorded/);
    assert.ok(!lines.join('\n').includes('Test Role'), 'no job title is printed');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('--recent through main: a header, the lines, exit 0, and no browser, lock or busy check', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-recent2-'));
  try {
    fs.mkdirSync(path.join(home, 'downloads'));
    const h = io();
    h.home = home;
    const deps = fakeDeps();
    assert.equal(await probe.main(['--recent'], h, deps), 0);
    assert.deepEqual(h.lines, ['# recent runs: 0']);
    assert.deepEqual(deps.log, []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the Caterer variants are the pipeline\'s: the same builder, the same normalisation, one page per id of the config in label order', () => {
  const v = probe.catererVariants({ job: 'Test Role', location: 'FY4', distance: 20 });
  assert.equal(v.configError, null);
  assert.deepEqual(v.variants.map((x) => x.param), ['none', 'LastActivityId=7', 'LastActivityId=8', 'LastActivityId=9', 'LastActivityId=11', 'LastActivityId=15', 'LastActivityId=0']);
  assert.deepEqual(v.variants.map((x) => x.label).slice(1), ['14 days', '1 month', '2 months', '6 months', '12 months', 'All']);
  const cfg = { ok: true, labels: { '12 months': { id: 15, echo: ['12 months'] }, '3 months': { id: null, echo: ['3 months'] } } };
  const only = probe.catererVariants({ job: 'Test Role', location: 'FY4', distance: 20, config: cfg });
  assert.deepEqual(only.variants.map((x) => x.param), ['none', 'LastActivityId=15'], 'a label without an id is not probed');
  assert.deepEqual(sa.LABELS.length, 8);
});

test('the Reed variants are the distinct activityTimeFrame values of reed-search.js, each through a key that maps to it', () => {
  const map = require(path.join(REPO, 'resourcer', 'scripts', 'reed-search')).ACTIVITY_TIMEFRAME_MAP;
  const v = probe.reedVariants();
  assert.deepEqual(v.map((x) => x.value), [...new Set(Object.values(map))]);
  for (const x of v) assert.equal(map[x.key], x.value);
});

test('the real adapters need no module that is not already part of the pipeline: realDeps builds without starting a browser', () => {
  const d = probe.realDeps();
  assert.equal(typeof d.busy, 'function');
  assert.equal(typeof d.caterer.readPage, 'function');
  assert.equal(typeof d.reed.count, 'function');
});
