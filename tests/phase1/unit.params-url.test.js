'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = path.resolve(__dirname, '..', '..', 'resourcer', 'scripts', 'phase1');
const { resolveParams, parseArgs } = require(path.join(P, 'params.js'));
const url = require(path.join(P, 'url.js'));

function capture() {
  const lines = [];
  return { out: (l) => lines.push(l), lines };
}

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(process.env.P1_TEST_TMP || os.tmpdir(), 'p1u-'));
  const f = path.join(dir, name);
  fs.writeFileSync(f, content);
  return f;
}

const BASE = ['--results-url', 'https://x.example/Results?CurrentLocation=LS29', '--job-title', 'Chef', '--location', 'LS29'];

test('kebab-case flags map to the legacy parameter names, defaults apply', () => {
  const c = capture();
  const r = resolveParams(BASE.concat(['--cv-limit', '7', '--priority', 'high']), c.out);
  assert.ok(r.params);
  assert.strictEqual(r.params.RESULTS_URL, 'https://x.example/Results?CurrentLocation=LS29');
  assert.strictEqual(r.params.JOB_TITLE, 'Chef');
  assert.strictEqual(r.params.CV_LIMIT, 7);
  assert.strictEqual(r.params.PRIORITY, 'high');
  assert.strictEqual(r.params.MAX_PAGES, 50);
  assert.strictEqual(r.params.DISTANCE_MILES, 20);
  assert.strictEqual(r.params.ACTIVE_WITHIN, '1 month');
  assert.strictEqual(r.params.SOURCES, 'caterer');
  assert.ok(c.lines.some((l) => l.startsWith('SOURCES_FALLBACK')));
});

test('--flag=value form and values starting with a dash are accepted', () => {
  const c = capture();
  const r = resolveParams(['--results-url=https://x.example/R?CurrentLocation=LE8', '--job-title=Chef', '--location=LE8', '--keywords', '-LOCATION:LE8'], c.out);
  assert.ok(r.params);
  assert.strictEqual(r.params.LOCATION, 'LE8');
  assert.strictEqual(r.params.KEYWORDS, '');
  assert.ok(c.lines.some((l) => l.startsWith('WARN detected shifted KEYWORDS arg')));
});

test('missing mandatory parameters exit 5 with the legacy message', () => {
  for (const [drop, msg] of [['--results-url', 'RESULTS_URL'], ['--job-title', 'JOB_TITLE'], ['--location', 'LOCATION']]) {
    const args = [];
    for (let i = 0; i < BASE.length; i += 2) if (BASE[i] !== drop) args.push(BASE[i], BASE[i + 1]);
    const c = capture();
    const r = resolveParams(args, c.out);
    assert.strictEqual(r.exit, 5, drop);
    assert.ok(c.lines.includes(`MISSING_PARAM: ${msg} is required.`), c.lines.join('|'));
  }
  const c = capture();
  assert.strictEqual(resolveParams(['--results-url', ' ', '--job-title', 'a', '--location', 'b'], c.out).exit, 5);
});

test('unknown flags and non-integer values exit 5', () => {
  assert.strictEqual(resolveParams(BASE.concat(['--bogus', '1']), capture().out).exit, 5);
  assert.strictEqual(resolveParams(BASE.concat(['--cv-limit', 'abc']), capture().out).exit, 5);
  assert.strictEqual(resolveParams(BASE.concat(['--max-pages']), capture().out).exit, 5);
});

test('SOURCES: valid values, case folding, invalid value exits 5', () => {
  assert.strictEqual(resolveParams(BASE.concat(['--sources', 'BOTH']), capture().out).params.SOURCES, 'both');
  assert.strictEqual(resolveParams(BASE.concat(['--sources', 'reed']), capture().out).params.SOURCES, 'reed');
  const c = capture();
  assert.strictEqual(resolveParams(BASE.concat(['--sources', 'linkedin']), c.out).exit, 5);
  assert.ok(c.lines.some((l) => l.startsWith("INVALID_SOURCES: 'linkedin'")));
});

test('SOURCES recovered from the init status file when the caller drops the argument', () => {
  const init = tmpFile('phase1-init.json', JSON.stringify({ status: 'phase1_initializing', sources: 'both' }));
  const c = capture();
  const r = resolveParams(BASE.concat(['--init-status-file', init]), c.out);
  assert.strictEqual(r.params.SOURCES, 'both');
  assert.ok(c.lines.some((l) => l.startsWith("SOURCES_RECOVERED: read from INIT_STATUS_FILE -> 'both'")));

  const bad = tmpFile('phase1-bad.json', '{not json');
  const c2 = capture();
  const r2 = resolveParams(BASE.concat(['--init-status-file', bad]), c2.out);
  assert.strictEqual(r2.params.SOURCES, 'caterer');
  assert.ok(c2.lines.some((l) => l.startsWith('SOURCES_RECOVERY_FAILED')));
});

test('KEYWORDS sanitising: none / (none) / n/a / null / undefined / - become empty, case-insensitive', () => {
  for (const kw of ['none', '(none)', 'N/A', 'null', 'Undefined', '-', 'NONE']) {
    const c = capture();
    const r = resolveParams(BASE.concat(['--keywords', kw]), c.out);
    assert.strictEqual(r.params.KEYWORDS, '', kw);
    assert.ok(c.lines.some((l) => l.startsWith('KEYWORDS sanitised')), kw);
  }
  assert.strictEqual(resolveParams(BASE.concat(['--keywords', 'sous chef']), capture().out).params.KEYWORDS, 'sous chef');
});

test('params file: provides everything, wins over CLI, unknown keys ignored, kebab and case tolerant keys', () => {
  const f = tmpFile('params.json', JSON.stringify({
    RESULTS_URL: 'https://x.example/R?CurrentLocation=B25', JOB_TITLE: 'Head Chef', LOCATION: 'B25',
    CV_LIMIT: 30, MAX_PAGES: '4', SOURCES: 'both', KEYWORDS: 'grill', PRIORITY: 'high', REQUESTED_AT: '2026-09-29T10:00:00.000Z',
    'distance-miles': 25, SOMETHING_ELSE: 1,
  }));
  const c = capture();
  const r = resolveParams(['--params-file', f, '--job-title', 'Ignored', '--cv-limit', '5'], c.out);
  assert.ok(r.params, c.lines.join('|'));
  assert.strictEqual(r.params.JOB_TITLE, 'Head Chef');
  assert.strictEqual(r.params.CV_LIMIT, 30);
  assert.strictEqual(r.params.MAX_PAGES, 4);
  assert.strictEqual(r.params.DISTANCE_MILES, 25);
  assert.strictEqual(r.params.SOURCES, 'both');
  assert.strictEqual(r.params.REQUESTED_AT, '2026-09-29T10:00:00.000Z');
  assert.ok(c.lines.includes(`PARAMS_FILE_LOADED: ${f}`));
});

test('params file: BOM tolerated, nulls ignored for integers, empty strings do not override the CLI', () => {
  const f = tmpFile('params.json', String.fromCharCode(0xFEFF) + JSON.stringify({ JOB_TITLE: '', CV_LIMIT: null, KEYWORDS: null }));
  const r = resolveParams(BASE.concat(['--params-file', f, '--cv-limit', '9', '--keywords', 'x']), capture().out);
  assert.strictEqual(r.params.JOB_TITLE, 'Chef');
  assert.strictEqual(r.params.CV_LIMIT, 9);
  assert.strictEqual(r.params.KEYWORDS, '');
});

test('params file: malformed, non-object, non-numeric int and missing files exit 7', () => {
  const bad = tmpFile('bad.json', '{"RESULTS_URL": ');
  const c = capture();
  assert.strictEqual(resolveParams(['--params-file', bad], c.out).exit, 7);
  assert.ok(c.lines.some((l) => l.startsWith('PARAMS_FILE_ERROR:')));
  assert.strictEqual(resolveParams(['--params-file', tmpFile('arr.json', '[1,2]')], capture().out).exit, 7);
  assert.strictEqual(resolveParams(['--params-file', tmpFile('n.json', JSON.stringify({ CV_LIMIT: 'lots' }))], capture().out).exit, 7);
  assert.strictEqual(resolveParams(['--params-file', path.join(os.tmpdir(), 'definitely-not-here.json')], capture().out).exit, 7);
});

test('--help is recognised', () => {
  assert.strictEqual(resolveParams(['--help'], capture().out).help, true);
  assert.strictEqual(parseArgs(['-h']).help, true);
});

// ---------------- url.js ----------------

test('url: hash stripped, PageNumber removed, required params injected (PageSize=50)', () => {
  const r = url.normaliseResultsUrl('https://x.example/Results?CurrentLocation=LS29&SearchString=Chef&PageNumber=3#search-results');
  assert.strictEqual(r.base, 'https://x.example/Results?CurrentLocation=LS29&SearchString=Chef&SearchFormType=Targeted&SearchOptionColumn=ExactMatch&PageSize=50');
  assert.deepStrictEqual(r.notes, [
    'URL normalisation: appended SearchFormType=Targeted (was missing)',
    'URL normalisation: appended SearchOptionColumn=ExactMatch (was missing)',
    'URL normalisation: appended PageSize=50 (was missing)',
  ]);
});

test('url: existing params are kept and matched case-insensitively, nothing re-appended', () => {
  const src = 'https://x.example/Results?currentlocation=LS29&searchformtype=Targeted&SEARCHOPTIONCOLUMN=ExactMatch&pagesize=10';
  const r = url.normaliseResultsUrl(src);
  assert.strictEqual(r.base, src);
  assert.deepStrictEqual(r.notes, []);
});

test('url: PageNumber first in the query string keeps a valid query', () => {
  const r = url.normaliseResultsUrl('https://x.example/Results?PageNumber=2&CurrentLocation=LS29');
  assert.ok(r.base.startsWith('https://x.example/Results?CurrentLocation=LS29'), r.base);
});

test('url: pageUrl appends PageNumber for pages after the first', () => {
  assert.strictEqual(url.pageUrl('https://x/R?a=1', 1), 'https://x/R?a=1');
  assert.strictEqual(url.pageUrl('https://x/R?a=1', 4), 'https://x/R?a=1&PageNumber=4');
});

test('url: %26 inside a parameter value is BAD_URL_ENCODING; a real & is fine', () => {
  assert.strictEqual(url.hasBadEncoding('https://x/R?CurrentLocation=CW4%26SearchString=Sous+Chef%26Distance=30'), true);
  assert.strictEqual(url.hasBadEncoding('https://x/R?CurrentLocation=CW4&SearchString=Sous+Chef&Distance=30'), false);
  assert.strictEqual(url.hasBadEncoding('https://x/R?FreeText=Fish%20%26%20Chips'), false, 'a legitimately encoded ampersand in a title is fine');
  assert.strictEqual(url.hasBadEncoding('https://x/R?FreeText=Food+%26+Beverage+Manager&CurrentLocation=LS29'), false);
  assert.strictEqual(url.hasBadEncoding('https://x/R?FreeText=Chef%26CurrentLocation=LS29'), true, 'an encoded & that swallows the next parameter is the hand-built case');
});

test('url: territory check is case-insensitive, trims the URL value, decodes escapes, ignores a missing CurrentLocation', () => {
  assert.strictEqual(url.checkTerritory('https://x/R?CurrentLocation=ls29&a=1', 'LS29').ok, true);
  assert.strictEqual(url.checkTerritory('https://x/R?a=1&CURRENTLOCATION=LS29', 'LS29').ok, true);
  assert.strictEqual(url.checkTerritory('https://x/R?CurrentLocation=LS29%20&a=1', 'LS29').ok, true);
  assert.strictEqual(url.checkTerritory('https://x/R?CurrentLocation=Le%20Havre', 'Le Havre').ok, true);
  assert.strictEqual(url.checkTerritory('https://x/R?a=1', 'LS29').ok, true);
  const bad = url.checkTerritory('https://x/R?CurrentLocation=LS30', 'LS29');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.urlLoc, 'LS30');
  // '+' is not decoded (same as the .NET UnescapeDataString), so a plus-encoded space mismatches
  assert.strictEqual(url.checkTerritory('https://x/R?CurrentLocation=Le+Havre', 'Le Havre').ok, false);
});

test('url: malformed percent sequences are left as written instead of throwing', () => {
  assert.strictEqual(url.unescapeDataString('100%'), '100%');
  assert.strictEqual(url.unescapeDataString('%E0%A4%A'), '%E0%A4%A');
  assert.strictEqual(url.unescapeDataString('a%20b'), 'a b');
});

test('url: only https caterer.com addresses are accepted as RESULTS_URL', () => {
  assert.strictEqual(url.isCatererUrl('https://recruiter.caterer.com/CandidateSearchWebMvc/CandidateSearch/Results?FreeText=Chef'), true);
  assert.strictEqual(url.isCatererUrl('https://caterer.com/x'), true);
  for (const bad of ['http://recruiter.caterer.com/x', 'https://caterer.com.evil.example/x', 'https://evilcaterer.com/x', 'https://evil.example/?u=recruiter.caterer.com', 'file:///etc/passwd', 'not a url', '']) {
    assert.strictEqual(url.isCatererUrl(bad), false, bad);
  }
});
