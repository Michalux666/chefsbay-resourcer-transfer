'use strict';
const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const P = path.resolve(__dirname, '..', '..', 'resourcer', 'scripts', 'phase1');
const cities = require(path.join(P, 'cities.js'));
const extract = require(path.join(P, 'extract.js'));
const util = require(path.join(P, 'util.js'));
const screen = require(path.join(P, 'screen.js'));
const unlock = require(path.join(P, 'unlock.js'));

const maps = {
  postcodeMap: new Map([['LS', { city: 'Leeds', county: 'West Yorkshire' }], ['M', { city: 'Manchester', county: 'Greater Manchester' }], ['BD', { city: 'Bradford', county: '' }]]),
  cityToCounty: new Map([['LEEDS', 'West Yorkshire'], ['MANCHESTER', 'Greater Manchester'], ['BRADFORD', '']]),
};

function probe(text) {
  return vm.runInNewContext(extract.EMPTY_PROBE_JS, { document: { body: { innerText: text } } });
}

// ---- empty-result probe: the legacy copy lost its backslashes (regex broken since 2026-09-04) ----

test('probe: an explicit "0 candidates" is EMPTY (the branch that was dead)', () => {
  assert.strictEqual(probe('Search results: 0 candidates'), 'EMPTY');
  assert.strictEqual(probe('Your search returned 0 candidate for LL23'), 'EMPTY');
  assert.strictEqual(probe('0   candidates'), 'EMPTY');
  assert.strictEqual(probe('(0 candidates)'), 'EMPTY');
});

test('probe: the "no candidates/results/matches found" wording is EMPTY', () => {
  assert.strictEqual(probe('No candidates found'), 'EMPTY');
  assert.strictEqual(probe('no results were found for your search'), 'EMPTY');
  assert.strictEqual(probe('There are no matches'), 'EMPTY');
});

test('probe: a non-zero count is COUNT, and 150 / 1,000 / 10 candidates never read as zero', () => {
  assert.strictEqual(probe('164 candidates'), 'COUNT:164');
  assert.strictEqual(probe('Showing 150 candidates'), 'COUNT:150');
  assert.strictEqual(probe('1,000 candidates match'), 'COUNT:1,000');
  assert.strictEqual(probe('10 candidates'), 'COUNT:10');
  assert.notStrictEqual(probe('3.0 candidates'), 'EMPTY');
});

test('probe: an unrecognised page is UNKNOWN and a page without a body does not throw', () => {
  assert.strictEqual(probe('Welcome. Please log in.'), 'UNKNOWN');
  assert.strictEqual(probe(''), 'UNKNOWN');
  assert.strictEqual(vm.runInNewContext(extract.EMPTY_PROBE_JS, { document: {} }), 'UNKNOWN');
});

test('probe: the embedded source contains real backslashes and the base64 round-trips', () => {
  const BS = String.fromCharCode(92);
  assert.ok(extract.EMPTY_PROBE_JS.includes(`0${BS}s+candidates`), 'backslash-s must survive');
  assert.ok(extract.EMPTY_PROBE_JS.includes(`([0-9,]+)${BS}s+candidates`));
  assert.strictEqual(Buffer.from(extract.EMPTY_PROBE_B64, 'base64').toString('utf8'), extract.EMPTY_PROBE_JS);
  assert.ok(!/[^\x20-\x7e]/.test(extract.EMPTY_PROBE_JS), 'ASCII only');
});

test('probe output handling: only an exact EMPTY line counts (quoted JSON string as agent-browser prints it)', () => {
  assert.strictEqual(extract.isExplicitEmpty('"EMPTY"'), true);
  assert.strictEqual(extract.isExplicitEmpty('EMPTY'), true);
  assert.strictEqual(extract.isExplicitEmpty('  "EMPTY"  \n'), true);
  assert.strictEqual(extract.isExplicitEmpty('"COUNT:150"'), false);
  assert.strictEqual(extract.isExplicitEmpty('"UNKNOWN"'), false);
  assert.strictEqual(extract.isExplicitEmpty(''), false);
  assert.strictEqual(extract.isExplicitEmpty('Error: execution context is empty'), false);
});

// ---- city / title helpers ----

test('getCityFromTitle: "City, POSTCODE" titles only, case-sensitive postcode, numeric city rejected', () => {
  assert.strictEqual(cities.getCityFromTitle('Manchester, M22 4AD'), 'Manchester');
  assert.strictEqual(cities.getCityFromTitle('  Leeds,LS1 4AB '), 'Leeds');
  assert.strictEqual(cities.getCityFromTitle('Head Chef'), '');
  assert.strictEqual(cities.getCityFromTitle('Manchester, m22 4ad'), '');
  assert.strictEqual(cities.getCityFromTitle('12345, M22 4AD'), '');
  assert.strictEqual(cities.getCityFromTitle('A, M22 4AD'), '');
  assert.strictEqual(cities.getCityFromTitle(''), '');
  assert.strictEqual(cities.getCityFromTitle(null), '');
});

test('getPostcodeArea / getCityFromPostcode / getStateFromCity', () => {
  assert.strictEqual(cities.getPostcodeArea('ls29 8ab'), 'LS');
  assert.strictEqual(cities.getPostcodeArea('M22 4AD'), 'M');
  assert.strictEqual(cities.getPostcodeArea('123'), '');
  assert.strictEqual(cities.getCityFromPostcode(maps, 'LS29 8AB'), 'Leeds');
  assert.strictEqual(cities.getCityFromPostcode(maps, 'ZZ1 1AA'), '');
  assert.strictEqual(cities.getStateFromCity(maps, ' leeds '), 'West Yorkshire');
  assert.strictEqual(cities.getStateFromCity(maps, 'Nowhere'), '');
  assert.strictEqual(cities.getStateFromCity(maps, ''), '');
});

test('resolveCity order: unlocked title city, then postcode map, then raw card city (> 2 chars), else empty', () => {
  assert.strictEqual(cities.resolveCity(maps, 'Manchester, M22 4AD', 'LS29 8AB', 'Skipton'), 'Manchester');
  assert.strictEqual(cities.resolveCity(maps, 'Head Chef', 'LS29 8AB', 'Skipton'), 'Leeds');
  assert.strictEqual(cities.resolveCity(maps, 'Head Chef', 'ZZ1 1AA', ' Skipton '), 'Skipton');
  assert.strictEqual(cities.resolveCity(maps, 'Head Chef', 'ZZ1 1AA', 'ab'), '');
  assert.strictEqual(cities.resolveCity(maps, 'Head Chef', 'ZZ1 1AA', ''), '');
});

test('getTitleFromSnippet strips the rank, the candidate name and the trailing controls', () => {
  assert.strictEqual(cities.getTitleFromSnippet('3. Alex Sample Sous Chef | Ilkley, LS29 8AB Unlock candidate', 'Alex Sample'), 'Sous Chef');
  assert.strictEqual(cities.getTitleFromSnippet('3. alex sample Sous Chef | Ilkley', 'Alex Sample'), 'Sous Chef');
  assert.strictEqual(cities.getTitleFromSnippet('12. Kitchen Porter Unlock candidate to view', ''), 'Kitchen Porter');
  assert.strictEqual(cities.getTitleFromSnippet('1. Sam (Jr.) Cook | Leeds', 'Sam (Jr.)'), 'Cook');
  assert.strictEqual(cities.getTitleFromSnippet('', 'x'), '');
  assert.strictEqual(cities.getTitleFromSnippet(null, 'x'), '');
});

test('isPostcodeTitle recognises postcode-only and postcode-led titles, case-insensitively', () => {
  for (const t of ['LS29', 'ls29', 'M22 4AD', 'LS29, Ilkley', 'B1 xyz']) assert.strictEqual(cities.isPostcodeTitle(t), true, t);
  for (const t of ['Head Chef', 'Cook 2 days', 'Chef', '']) assert.strictEqual(cities.isPostcodeTitle(t), false, t);
});

// ---- misc helpers ----

test('extractUnlockJson picks the success line and cuts the shutdown assertion trailer', () => {
  const json = '{"success":true,"name":"A B"}';
  assert.strictEqual(unlock.extractUnlockJson(`noise\n${json} Assertion failed: !(x), file y\n`), json);
  assert.strictEqual(unlock.extractUnlockJson(`${json}\n`), json);
  assert.deepStrictEqual(JSON.parse(unlock.extractUnlockJson('  {"success":false,"error":"HTTP 401"}  \n')), { success: false, error: 'HTTP 401' });
  assert.strictEqual(unlock.extractUnlockJson('garbage only'), 'garbage only');
});

test('screeningModelFrom: last marker wins, case-insensitive, trimmed', () => {
  assert.strictEqual(screen.screeningModelFrom('a\nSCREENING_MODEL: m1\r\nx\nscreening_model:   m2  \n', 'unknown'), 'm2');
  assert.strictEqual(screen.screeningModelFrom('nothing here', 'unknown'), 'unknown');
  assert.strictEqual(screen.screeningModelFrom('  SCREENING_MODEL: indented', 'keep'), 'keep');
});

test('argVal guards values starting with two dashes', () => {
  assert.strictEqual(screen.argVal('--oops'), ' --oops');
  assert.strictEqual(screen.argVal('Sous Chef'), 'Sous Chef');
  assert.strictEqual(screen.argVal(undefined), '');
});

test('util: maskEmail, outwardCode, psBool, safeText', () => {
  assert.strictEqual(util.maskEmail('jane.doe@example.com'), 'j***@example.com');
  assert.strictEqual(util.maskEmail(''), '');
  assert.strictEqual(util.maskEmail('nonsense'), '***');
  assert.strictEqual(util.outwardCode('ls29 8ab'), 'LS29');
  assert.strictEqual(util.outwardCode('M1 1AA'), 'M1');
  assert.strictEqual(util.outwardCode(''), '');
  assert.strictEqual(util.psBool(true), 'True');
  assert.strictEqual(util.psBool(0), 'False');
  assert.strictEqual(util.safeText('a\n  b\tc', 10), 'a b c');
  assert.strictEqual(util.safeText('x'.repeat(50), 5), 'xxxxx');
});

test('runTimestamp is yyyy-MM-dd-HHmmss in London time', () => {
  assert.match(util.runTimestamp(new Date('2026-07-01T11:30:05Z')), /^2026-07-01-123005$/);
  assert.match(util.runTimestamp(new Date('2026-01-15T11:30:05Z')), /^2026-01-15-113005$/);
  assert.match(util.runTimestamp(), /^\d{4}-\d{2}-\d{2}-\d{6}$/);
});

test('loadExtractB64 keeps the base64 intact and drops only whitespace (line wraps, trailing newline)', () => {
  const os = require('os');
  const CRLF = String.fromCharCode(13, 10);
  const LF = String.fromCharCode(10);
  const b64 = Buffer.from('(function(){ return "sassy assess"; })()', 'utf8').toString('base64');
  const wrapped = b64.slice(0, 10) + CRLF + b64.slice(10, 30) + LF + b64.slice(30) + LF;
  const f = path.join(fs.mkdtempSync(path.join(process.env.P1_TEST_TMP || os.tmpdir(), 'p1e-')), 'extract.b64');
  fs.writeFileSync(f, wrapped);
  const out = extract.loadExtractB64(f);
  assert.strictEqual(out, b64);
  assert.ok(/[sS]/.test(out), 'the letter s survives');
});
