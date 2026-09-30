// Ported from cv-corpus/tests/cv-redact.test.js by tools/vendor-tests.js; only mechanical edits, see that tool.
'use strict';
// SYNTHETIC data only: every name, address, number and e-mail below is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const { redactCv, verifyRedaction, scanResidual, collapseLetterSpacing, isDateLikeNumberRun } = require('../../../resourcer/scripts/lib/cv/vendor/cv-redact');

const CTX = { names: ['Janet Testperson'], emails: ['janet.testperson@example.invalid'], phones: ['07700 900123'], postcodes: ['ZZ9 9ZZ'] };
const red = (text, ctx = CTX) => redactCv(text, ctx);
const has = (r, s) => r.text.includes(s);

test('e-mail: plain, upper case, spaced, obfuscated, wrapped over lines, known address', () => {
  const t = [
    'Email: someone@example.invalid',
    'MAIL: SOMEONE.ELSE@EXAMPLE.CO.UK',
    'contact: a.person @ example.invalid',
    'write to jane.doe [at] sample [dot] org',
    'long.local.part-name',
    '@example.invalid',
    'mail: janet.testperson@example.',
    'invalid',
  ].join('\n');
  const r = red(t, {});
  assert.ok(!/@/.test(r.text.replace(/\[AT\]/gi, '')) || !/example\.invalid/.test(r.text));
  assert.ok(!/someone@|SOMEONE|a\.person|jane\.doe/i.test(r.text));
  assert.ok(r.counts.email >= 4);
  // wrapped over two lines
  const w = red('Contact janet.testperson@example.\ninvalid today', CTX);
  assert.ok(!/testperson|example/i.test(w.text), `wrapped e-mail removed: ${JSON.stringify(w.text)}`);
  // "Chef @ The Ivy" is not an e-mail
  const at = red('Sous Chef @ The Ivy, London\nJan 2019 - Mar 2021', {});
  assert.ok(at.text.startsWith('Sous Chef @ The Ivy'));
});

test('e-mail: the local part on its own (social handle) is removed for the known address', () => {
  const r = red('Instagram janet.testperson99 loves food\nfollow janet.testperson', CTX);
  assert.ok(!/testperson/i.test(r.text));
});

test('phones: UK mobile / landline / +44 / (0) / dotted / spaced digits / other countries', () => {
  const nums = ['07700 900456', '07700900456', '+44 7700 900456', '+44 (0)7700 900456', '0044 7700 900456', '(020) 7946 0123', '020 7946 0123', '07700.900.456', '01632 960001',
    '+1 202 555 0143', '+353 1 234 5678', '+48 600 100 200', '0 7 7 0 0 9 0 0 4 5 6'];
  for (const n of nums) {
    const r = red(`Tel: ${n} | Head Chef`, {});
    assert.ok(!/\d{4}/.test(r.text.replace(/\[PHONE\]/g, '')), `phone removed: ${n} -> ${r.text}`);
    assert.ok(r.text.includes('Head Chef'));
  }
  const glued = red('Mobile:07700900456Email: x', {});
  assert.ok(!/0770/.test(glued.text));
  const many = red('07700 900456/07700 900457', {});
  assert.equal(many.counts.phone, 2);
});

test('phones: job dates, year lists, ranges and small numbers are NOT touched', () => {
  const keep = ['Jan 2019 - Mar 2021', '2015 - 2018', '2015 2016 2017', '01/2019 - 03/2021', '01.2019 - 03.2021', '12.03.2019', '2014-2016-2019', 'Level 2 NVQ, 120 covers, 45 staff', 'Since 2015', '1998 - 2001 - 2005'];
  for (const k of keep) assert.equal(red(`Role ${k} end`, {}).text, `Role ${k} end`, `left alone: ${k}`);
  assert.ok(isDateLikeNumberRun('2015 - 2018'));
  assert.ok(!isDateLikeNumberRun('07700 900456'));
});

test('URLs, LinkedIn, social handles', () => {
  const r = red([
    'https://www.linkedin.com/in/some-person-123',
    'www.example.invalid/portfolio',
    'linkedin.com/in/another',
    'my site sample-chef.co.uk',
    'LinkedIn: some-person-123',
    'Instagram: @some_chef',
    'follow @some_chef_2',
  ].join('\n'), {});
  assert.ok(!/linkedin\.com|example\.invalid|sample-chef|some-person|some_chef/i.test(r.text), r.text);
  const keep = red('Worked with food.In charge of the pass and E.g. sauces', {});
  assert.ok(keep.text.includes('food.In charge'), 'a missing space after a full stop is not a domain');
});

test('postcodes: full, glued, tab split, label, known partial forms', () => {
  const r = red('Home: LS1 4AB\nAt SW1A 1AA today\nBirmingham,B33 8TH\nPostcode: EC1A\nsplit E1\t6AN\nzz99zz', { postcodes: ['ZZ9 9ZZ'] });
  assert.ok(!/LS1|SW1A|B33|EC1A|E1\s*6AN/.test(r.text), r.text);
  assert.ok(!/zz9/i.test(r.text));
  const k = red('Lives near LondonZZ99ZZ', { postcodes: ['ZZ9 9ZZ'] });
  assert.ok(!/ZZ99ZZ/i.test(k.text));
});

test('street addresses: number + street, flat prefix, address label with continuation, PO box', () => {
  const r = red([
    '12 Acacia Avenue, Testville, TV1 2AB',
    'Flat 3, 45b Sample Road, Testtown',
    'Address: 7 Fictional Close',
    'Testville',
    'TV2 3CD',
    'PO Box 123',
    'Worked at 10 Downing Street kitchens',
  ].join('\n'), {});
  assert.ok(!/Acacia|Sample Road|Fictional|TV1|TV2|PO Box|Downing/.test(r.text), r.text);
  const keep = red('Ran a 120 cover restaurant with 25 staff and 3 sections', {});
  assert.equal(keep.text, 'Ran a 120 cover restaurant with 25 staff and 3 sections');
});

test('dates of birth: labelled forms, label alone with the value on the next line, unlabelled in the header, age', () => {
  const r = red([
    'Date of Birth: 14th March 1988',
    'DOB - 03/04/1990',
    'D.O.B. 1 Jan 85',
    'Born: 1979',
    'Date of birth',
    '22/09/1984',
    'Age: 34',
    'a 29 year old chef',
    'Nationality: Utopian',
    'Marital Status: Single',
    'NI Number: QQ 12 34 56 C',
    '',
    'WORK EXPERIENCE',
    'Head Chef, The Ivy, Jan 2019 - Mar 2021',
  ].join('\n'), {});
  assert.ok(!/1988|1990|1985|1979|1984|Utopian|Single|QQ 12/.test(r.text), r.text);
  assert.ok(!/\b34\b|\b29\b/.test(r.text.replace('2019', '').replace('2021', '')));
  assert.ok(r.text.includes('Jan 2019 - Mar 2021'), 'role dates survive');
  // an unlabelled full date inside a job range must survive
  const keep = red('01/03/1998 - 30/06/2001 Kitchen Porter', {});
  assert.ok(keep.text.includes('1998') && keep.text.includes('2001'));
  // an unlabelled birth date in the first lines is removed
  const head = red('Some Header\n14 March 1988\nProfile', {});
  assert.ok(!/1988/.test(head.text));
});

test('own name: full, reversed, initials, upper case, glued, diacritics, possessive, middle name', () => {
  const ctx = { names: ['Jos\u00e9 Mar\u00eda Garc\u00eda-Testperson', 'Jos\u00e9', 'Garc\u00eda-Testperson'] };
  const t = [
    'JOSE MARIA GARCIA-TESTPERSON',
    'Curriculum vitae of Jose Garcia',
    'Garcia-Testperson, Jose',
    'J. Garcia-Testperson',
    "Jose's kitchen skills; Testperson leads",
    'josegarciatestperson@ maybe',
    'JOSEGARCIA and jose.garcia',
    'Jos\u00e9 Luis Garc\u00eda-Testperson',
  ].join('\n');
  const r = red(t, ctx);
  assert.ok(!/jose|garc[i\u00ed]a|testperson|maria/i.test(r.text), r.text);
  assert.ok(verifyRedaction(r.text, ctx).ok);
});

test('own name: two-letter and common-word names do not corrupt job titles', () => {
  const ctx = { names: ['Sam Cook'] };
  const r = red('Sam Cook\nHead Cook at The Sample Inn\nCook and baker, Cooking classes\nHead Chef Jan 2019 - Mar 2021', ctx);
  assert.ok(r.text.includes('Head Cook at The Sample Inn'), r.text);
  assert.ok(r.text.includes('Head Chef Jan 2019'));
  assert.ok(!/\bSam\b/.test(r.text));
  const short = red('Li Wu\nWorked with Li Wu at a wok station', { names: ['Li Wu'] });
  assert.ok(!/Li Wu/.test(short.text), short.text);
  assert.ok(short.text.includes('wok station'));
});

test('own name without context: the header line is guessed', () => {
  const r = redactCv('Alexandra Samplename\nHead Chef\nalexandra likes food. Alexandra Samplename ran the pass.', {});
  assert.ok(r.guessedNames);
  assert.ok(!/Alexandra|Samplename/i.test(r.text), r.text);
  assert.ok(r.text.includes('Head Chef'));
  // headings and job titles are never mistaken for names
  const h = redactCv('Curriculum Vitae\nWORK EXPERIENCE\nHead Chef', {});
  assert.ok(!h.guessedNames);
  assert.ok(h.text.includes('WORK EXPERIENCE'));
});

test('referee blocks and "references available" lines are removed, with the other people named in them', () => {
  const t = [
    'WORK EXPERIENCE',
    'Head Chef - The Ivy - Jan 2019 - Mar 2021',
    'REFERENCES',
    'Bob Referee, General Manager, The Ivy',
    'Tel 01632 960002  bob.referee@example.invalid',
    '',
    'Carol Reference, Owner',
    'INTERESTS',
    'Cooking and football',
    'References available on request',
    'Referee 1: Dan Person, Head Chef, Sample Hotel',
    'additional line of the referee block',
    '',
    'Declaration: I confirm this is true',
  ].join('\n');
  const r = red(t, {});
  assert.ok(!/Bob|Carol|Referee|Dan Person|additional line|01632/.test(r.text), r.text);
  assert.ok(r.text.includes('INTERESTS') && r.text.includes('Cooking and football'), 'the next section survives');
  assert.ok(r.counts.refereeBlocks >= 2);
  const m = red('Head Chef at X\nReferences: available upon request\nSKILLS\nKnife skills', {});
  assert.ok(!/available upon request/.test(m.text));
  assert.ok(m.text.includes('SKILLS'));
});

test('honorific names and "reporting to" names, but not titles', () => {
  const r = red('Reporting to Mr Tom Boss and Dr Ann Tester\nreporting to Head Chef Smith\nsupervised by Jane Doe', {});
  assert.ok(!/Tom Boss|Ann Tester|Jane/.test(r.text), r.text);
  assert.ok(r.text.includes('reporting to Head Chef'));
});

test('letter-spaced headings and names are collapsed', () => {
  assert.equal(collapseLetterSpacing('W O R K   E X P E R I E N C E'), 'WORK EXPERIENCE');
  assert.equal(collapseLetterSpacing('Head Chef'), 'Head Chef');
  const r = red('J A N E T   T E S T P E R S O N\nHead Chef', CTX);
  assert.ok(!/testperson|janet/i.test(r.text));
});

test('sensitive labels keep the label and hide the value', () => {
  const r = red('Gender: Female\nReligion: none\nPlace of Birth: Sampletown\nPassport No: X1234567\nShare code: W12 3456 790', {});
  assert.ok(!/Female|none|Sampletown|X1234567|W12/.test(r.text), r.text);
  assert.ok(/Gender:/.test(r.text));
});

test('a realistic synthetic CV: nothing identifying survives and the work history is intact', () => {
  const cv = [
    'JANET TESTPERSON',
    '12 Acacia Avenue, Testville, ZZ9 9ZZ',
    'Mobile: 07700 900123  Email: janet.testperson@example.invalid',
    'LinkedIn: linkedin.com/in/janet-testperson',
    'Date of Birth: 14/03/1988',
    'PROFILE',
    'Janet is a dedicated chef.',
    'WORK EXPERIENCE',
    'Head Chef',
    'The Ivy, London',
    'Jan 2019 - Mar 2021',
    '- Ran a team of 8 chefs',
    'REFERENCES',
    'Bob Referee 01632 960003',
  ].join('\n');
  const r = red(cv, CTX);
  assert.ok(verifyRedaction(r.text, CTX).ok);
  const resid = scanResidual(r.text);
  assert.deepEqual(Object.values(resid).filter(Boolean), []);
  assert.ok(r.text.includes('Head Chef') && r.text.includes('Jan 2019 - Mar 2021') && r.text.includes('Ran a team of 8 chefs'));
  assert.ok(!/Bob|Referee/.test(r.text));
});

test('verifyRedaction detects every leaked class (counts only) and scanResidual is independent', () => {
  const v = verifyRedaction('call 07700 900123 or janet.testperson@example.invalid at ZZ9 9ZZ, Janet Testperson', CTX);
  assert.equal(v.ok, false);
  assert.ok(v.leaks.email >= 1 && v.leaks.phone >= 1 && v.leaks.postcode >= 1 && v.leaks.name >= 1);
  assert.ok(!JSON.stringify(v).includes('janet'), 'the verdict never contains the values');
  const rs = scanResidual('mail me@x.invalid, www.foo.com, 07700 900999, AB1 2CD, DOB 12/12/1990, @handle_x');
  assert.ok(rs.email && rs.url && rs.phone && rs.postcode && rs.dob && rs.handle);
  assert.deepEqual(Object.values(scanResidual('Head Chef, Jan 2019 - Mar 2021, 120 covers')).filter(Boolean), []);
});

test('redaction is idempotent and does not throw on odd input', () => {
  const once = red('Email a@b.invalid\nTel 07700 900123', CTX);
  const twice = red(once.text, CTX);
  assert.equal(twice.text, once.text);
  for (const odd of ['', '   ', '\n\n', '[NAME] [NAME]', '\u0000\u0001', 'a'.repeat(50000)]) assert.equal(typeof red(odd, CTX).text, 'string');
  assert.equal(red(null, CTX).text, '');
});

test('other people\'s names: any known candidate name is scrubbed, vocabulary-only pairs and unrelated words are not', () => {
  const { scrubNamePairs, scrubUserNames } = require('../../../resourcer/scripts/lib/cv/vendor/cv-redact');
  const sets = { pairs: new Set(['alice wonderland', 'wonderland alice', 'chef kitchen', 'kitchen chef', 'li wu', 'wu li', 'mary rose']), glued: new Set(['alicewonderland']) };
  const r = scrubNamePairs('Trained Alice Wonderland on the grill.\nWonderland, Alice ran the pass; alicewonderland99 and Li Wu helped.\nHead Chef Kitchen and Mary Rose Hotel', sets);
  assert.ok(!/Alice|Wonderland|Li Wu/i.test(r.text.replace(/alicewonderland99/, '')), r.text);
  assert.ok(r.text.includes('Chef Kitchen'), 'a pair made only of job / employer words is left alone');
  assert.ok(r.count >= 4);
  assert.equal(r.text.split('\n').length, 3, 'line count is preserved');
  assert.equal(scrubNamePairs('Alice ran the Wonderland pass', sets).count, 0, 'the words must be adjacent');
  assert.equal(scrubNamePairs('anything', null).text, 'anything');
  const u = scrubUserNames('reach chef.person99 or chef.other88 today', new Set(['chef.person99']));
  assert.equal(u.text, 'reach [HANDLE] or chef.other88 today');
  assert.equal(u.count, 1);
});
