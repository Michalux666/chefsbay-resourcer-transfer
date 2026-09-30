'use strict';
// The three adapters (reader, redactor, role parser) behind the interfaces of the brief, whichever implementation is installed.
const { makeHome } = require('./helpers/home');
const home = makeHome('cv-adapters');
const test = require('node:test');
const assert = require('node:assert/strict');
const extract = require('../../resourcer/scripts/lib/cv/extract');
const redact = require('../../resourcer/scripts/lib/cv/redact');
const parse = require('../../resourcer/scripts/lib/cv/parse');
const { PLANTED, KNOWN, role, cvText } = require('./helpers/fixtures');

test.after(() => home.cleanup());

const BS = String.fromCharCode(92);
const bytes = (...b) => Buffer.from(b);

test('extract: plain text in several encodings is read, the type comes from the bytes and not from the hint', async () => {
  const text = cvText([role('Sous Chef', '2020-01', 'present')]);
  let r = await extract.extractText(Buffer.from(text, 'utf8'), 'pdf');
  assert.equal(r.ok, true);
  assert.match(r.text, /Sous Chef/);
  const bom = Buffer.concat([bytes(0xff, 0xfe), Buffer.from(text, 'utf16le')]);
  r = await extract.extractText(bom, 'txt');
  assert.equal(r.ok, true);
  assert.match(r.text, /Sous Chef/);
  const rtf = Buffer.from('{' + BS + 'rtf1 ' + text.split('\n').join(BS + 'par ') + '}');
  r = await extract.extractText(rtf, 'rtf');
  assert.equal(r.ok, true);
  assert.match(r.text, /Sous Chef/);
});

test('extract: a file that cannot be read gives a fixed reason code and never any text', async () => {
  const cases = [
    [Buffer.alloc(0), /^empty/],
    [Buffer.concat([bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), Buffer.alloc(200)]), /^unsupported_doc_binary$/],
    [Buffer.from('<html><body>login</body></html>'), /^unsupported_html$/],
    [Buffer.concat([bytes(0xff, 0xd8, 0xff), Buffer.alloc(200, 3)]), /^unsupported_image_only$/],
    [Buffer.from('short'), /^empty_too_little_text$/],
    [Buffer.from('%PDF-1.4 broken'), /^(?:error_|scanned_)/],
    [Buffer.alloc(13 * 1024 * 1024, 65), /^rejected_too_large$/],
  ];
  for (const [buf, re] of cases) {
    const r = await extract.extractText(buf, 'pdf');
    assert.equal(r.ok, false);
    assert.equal(r.text, '');
    assert.match(r.reason, re);
    assert.match(r.reason, /^[a-z0-9_]+$/);
  }
  assert.equal((await extract.extractText('not a buffer', 'pdf')).ok, false);
});

test('redact: names, contact details, addresses parts and the referee block are removed and the result is verified', async () => {
  const r = await redact.redactCv(cvText([role('Sous Chef', '2020-01', 'present')]), KNOWN);
  assert.equal(r.verified, true);
  for (const v of [PLANTED.first, PLANTED.last, PLANTED.email, PLANTED.phone, PLANTED.postcode, PLANTED.referee, PLANTED.refereePhone]) assert.equal(r.text.includes(v), false, v);
  assert.match(r.text, /Sous Chef/);
  assert.match(r.text, /Level 2 Food Safety/);
});

test('redact: another person named after a relation is masked; the words of the reader vocabulary after the cue stay', () => {
  const duties = [
    `Reported to ${PLANTED.referee}, area manager (${PLANTED.refereePhone})`,
    'Trained by Mr Quillfeather',
    'led by Head Chef Maria Rossi',
    'Reported to Head Chef and Sous Chef',
    'worked under Pressure daily',
    'managed by Compass Group',
    'supervised by the team leader',
  ];
  const out = redact.scrubRecord({ roles: [{ title: 'Cook', employer: 'Test Kitchen Ltd', start: '2020-01', end: 'present', duties }], qualifications: [], parseConfidence: 0.9 }, KNOWN).record.roles[0].duties;
  assert.equal(out[0], 'Reported to [NAME], area manager [PHONE])');
  assert.equal(out[1], 'Trained by Mr [NAME]');
  assert.equal(out[2], 'led by Head Chef [NAME]');
  assert.equal(out[3], 'Reported to Head Chef and Sous Chef');
  assert.equal(out[4], 'worked under [NAME] daily');
  assert.equal(out[5], 'managed by Compass Group');
  assert.equal(out[6], 'supervised by the team leader');
  for (const d of out) for (const v of [PLANTED.referee.split(' ')[0], PLANTED.referee.split(' ')[1], 'Quillfeather', 'Rossi']) assert.equal(d.includes(v), false, v);
});

test('redact: with no known name the pattern-based data still goes', async () => {
  const r = await redact.redactCv('Reach me on 07700 900123 or a.b@example.invalid, http://example.invalid/me, ZZ1 1ZZ, @handle99', {});
  assert.equal(r.verified, true);
  for (const v of ['07700', 'example.invalid', 'ZZ1', 'handle99']) assert.equal(r.text.includes(v), false, v);
});

test('redact: a hostile unbroken run of letters never makes the patterns run for long', async () => {
  const t0 = Date.now();
  const long = 'a'.repeat(400000);
  const r = await redact.redactCv(`Chef\n${long}\n${long}@${long}`, KNOWN);
  const s = redact.scrubRecord({ roles: [{ title: long, employer: long, duties: [long, long], start: '2020-01', end: 'present' }], qualifications: [long] }, KNOWN);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  assert.ok(r.text.length <= 200000, 'the input is cut before any pattern runs');
  assert.ok(s.record.roles[0].title.length <= 1500);
});

test('scrubRecord: a whitelisted copy, personal data masked, the parser evidence and any extra field dropped', () => {
  const dirty = {
    roles: [{
      title: `Chef ${PLANTED.email}`, employer: `${PLANTED.first} ${PLANTED.last} Catering`, start: '2020-01', end: 'present', months: 99, evidence: 'RAW SOURCE LINE',
      duties: [`call ${PLANTED.phone}`, 'sauces'], secret: 'x',
    }],
    qualifications: [`Food Safety ${PLANTED.postcode}`], skills: ['ignored'], parseConfidence: 0.7, rawText: 'the whole CV',
  };
  const r = redact.scrubRecord(dirty, KNOWN);
  assert.equal(r.verified, true);
  assert.deepEqual(Object.keys(r.record).sort(), ['parseConfidence', 'qualifications', 'roles']);
  assert.deepEqual(Object.keys(r.record.roles[0]).sort(), ['duties', 'employer', 'end', 'start', 'title']);
  const text = JSON.stringify(r.record);
  for (const v of [PLANTED.first, PLANTED.last, PLANTED.email, PLANTED.phone, PLANTED.postcode, 'RAW SOURCE LINE', 'the whole CV', 'ignored', 'secret']) assert.equal(text.includes(v), false, v);
  assert.match(text, /sauces/);
  assert.ok(r.changed >= 4);
});

test('scrubRecord: a short surname that is also a common word is left alone, a long name part and a full name are masked', () => {
  const known = { names: ['Alex Cook'], emails: [], phones: [], postcodes: [] };
  const r = redact.scrubRecord({ roles: [{ title: 'Cook', employer: 'Alex Cook Ltd', start: null, end: null, duties: ['cook for 40'] }] }, known);
  assert.equal(r.record.roles[0].title, 'Cook');
  assert.equal(r.record.roles[0].employer, '[NAME] Ltd');
  const long = redact.scrubRecord({ roles: [{ title: 'Chef', employer: 'Quimbleton and Sons', start: null, end: null, duties: [] }] }, { names: ['Zed Quimbleton'] });
  assert.equal(long.record.roles[0].employer, '[NAME] and Sons');
});

test('scrubRecord: digits of a known phone number written in an odd way are caught by the verification', () => {
  const r = redact.scrubRecord({ roles: [{ title: 'Chef', employer: '', start: null, end: null, duties: ['7  00  90  0  3  21'] }] }, KNOWN);
  assert.equal(r.verified, false);
});

test('parse: date ranges become roles with title, employer and duties; education and references are not roles', async () => {
  const p = await parse.parseRoles([
    'PROFILE', 'Keen and reliable.', '', 'EXPERIENCE',
    'Sous Chef | Grand Hotel | Mar 2020 - Present', '- sauces', '- menu planning',
    'Chef de Partie, Old Pub  06/2016 - 02/2020', 'larder',
    '2010 - 2012 Kitchen Porter at Corner Cafe',
    '', 'EDUCATION', 'NVQ Level 3 (2012 - 2014)', 'Level 2 Food Safety', '', 'REFERENCES', 'A Person, Somewhere, 2019 - 2020',
  ].join('\n'));
  assert.equal(p.roles.length, 3);
  assert.deepEqual(p.roles.map(r => [r.title, r.employer, r.start, r.end]), [
    ['Sous Chef', 'Grand Hotel', '2020-03', 'present'],
    ['Chef de Partie', 'Old Pub', '2016-06', '2020-02'],
    ['Kitchen Porter', 'Corner Cafe', '2010-01', '2012-12'],
  ]);
  assert.equal([].concat(p.roles[0].duties).join(' '), 'sauces menu planning');
  assert.ok(p.qualifications.length >= 1 && p.qualifications.every(q => typeof q === 'string'), 'qualifications come back as keywords');
  assert.ok(p.parseConfidence > 0.5);
  for (const r of p.roles) assert.deepEqual(Object.keys(r).sort(), ['duties', 'employer', 'end', 'start', 'title']);
});

test('parse: text without a work history gives no roles and a low confidence, and never throws', async () => {
  const p = await parse.parseRoles('x '.repeat(400));
  assert.equal(p.roles.length, 0);
  assert.ok(p.parseConfidence <= 0.3);
  for (const bad of [undefined, null, 5, '']) assert.equal((await parse.parseRoles(bad)).roles.length, 0);
});

test('parse: a hostile long line is handled quickly', async () => {
  const t0 = Date.now();
  await parse.parseRoles(`EXPERIENCE\n${'1'.repeat(200000)} - ${'2'.repeat(200000)}\n${'a '.repeat(100000)}`);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});

test('the whole read path on a file: extract, redact, parse give roles without any personal data', async () => {
  const text = cvText([role('Sous Chef', '2020-01', 'present'), role('Chef de Partie', '2015-03', '2019-12')]);
  const ex = await extract.extractText(Buffer.from(text), 'txt');
  const red = await redact.redactCv(ex.text, KNOWN);
  const parsed = await parse.parseRoles(red.text);
  assert.equal(parsed.roles.length, 2);
  assert.equal(JSON.stringify(parsed).includes(PLANTED.last), false);
});

test('the real reader, redactor and role parser are the ones in use, not the minimal stand-ins', () => {
  assert.equal(extract.isVendored(), true, 'lib/cv/vendor/text-extract.js did not load (is pdf-parse installed?)');
  assert.equal(redact.isVendored(), true, 'lib/cv/vendor/cv-redact.js did not load');
  assert.equal(parse.isVendored(), true, 'lib/cv/vendor/role-parser.js did not load');
});
