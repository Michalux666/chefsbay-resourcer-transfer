'use strict';
// Redaction (D6): first name, surname heuristic, postcode, e-mail, phone, URL. Synthetic data only.
const h = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const { redactSnippet, redactTitle, sha16 } = require(h.lib('screening/redact'));

const BODY = 'Unlock candidate 2 applications in last 30 days Updated 3 days ago Never unlocked Recent experience Other CV snippets Head Chef Jan 2020 - Current The Test Hotel Key Responsibilities menu design';

test('Caterer card: rank, first name (from the card), surname and postcode are removed; the decision text is kept', () => {
  const r = redactSnippet(`12. Alex Smith Head Chef | Leeds, LS1 4AB ${BODY}`, { firstName: 'Alex' });
  assert.ok(r.text.startsWith('Head Chef | Leeds, <PC> Unlock candidate'), r.text);
  assert.ok(!/Alex|Smith|LS1 4AB/.test(r.text));
  assert.ok(r.text.includes('Other CV snippets Head Chef Jan 2020 - Current The Test Hotel'));
  assert.equal(r.notes.name, true);
  assert.equal(r.notes.surname, true);
  assert.equal(r.notes.postcodes, 1);
});

test('single-token name: a name with no surname shown keeps the title', () => {
  const r = redactSnippet(`3. Maria Sous Chef | Bath, BA1 1AA ${BODY}`, { firstName: 'Maria' });
  assert.ok(r.text.startsWith('Sous Chef | Bath, <PC>'), r.text);
  assert.equal(r.notes.surname, false);
});

test('a surname that is also a role word stays (documented heuristic limit)', () => {
  const r = redactSnippet(`4. Alex Cook Sous Chef | Leeds, LS1 4AB ${BODY}`, { firstName: 'Alex' });
  assert.ok(!/Alex/.test(r.text));
  assert.ok(r.text.startsWith('Cook Sous Chef |'), 'Cook is kept because it is a role word');
});

test('no card name available (single mode): the rank marks a Caterer card and the first token is treated as the name', () => {
  const r = redactSnippet(`5. Priya Patel Chef de Partie | Leeds, LS2 9AA ${BODY}`);
  assert.ok(r.text.startsWith('Chef de Partie | Leeds, <PC>'), r.text);
});

test('a snippet without a rank and without a card name is left alone apart from the pattern masks', () => {
  const r = redactSnippet('Current role: Chef | Location: Leeds | Work permit: Yes');
  assert.equal(r.text, 'Current role: Chef | Location: Leeds | Work permit: Yes');
  assert.equal(r.notes.name, false);
});

test('particles and double-barrelled surnames', () => {
  assert.ok(redactSnippet(`6. Maria de Souza Head Chef | X ${BODY}`, { firstName: 'Maria' }).text.startsWith('Head Chef |'));
  assert.ok(redactSnippet(`6. Tom Smith-Jones Cook | X ${BODY}`, { firstName: 'Tom' }).text.startsWith('Cook |'));
});

test('first name repeated in the body is replaced (4+ letters, not a month or role word)', () => {
  const r = redactSnippet(`7. Zaphod Beeblebrox Cook | X Key Responsibilities reference from Zaphod available`, { firstName: 'Zaphod' });
  assert.ok(!/Zaphod/.test(r.text));
  assert.ok(r.text.includes('<NAME>'));
  const may = redactSnippet('8. May Jones Chef | X Employed May 2020 - Aug 2021', { firstName: 'May' });
  assert.ok(may.text.includes('May 2020'), 'a first name that is a month must not corrupt dates');
});

test('e-mail, phone numbers, URLs and postcodes are masked wherever they appear', () => {
  const r = redactSnippet('Contact me at jo.bloggs+cv@example.co.uk or 07123 456789 or +44 20 7946 0958 or 01632 960001; www.example.com/in/jo and https://x.example/y; based SW1A 1AA, ls14ab');
  assert.ok(!/@|07123|7946|960001|example|SW1A|ls14ab/i.test(r.text), r.text);
  assert.equal(r.notes.emails, 1);
  assert.equal(r.notes.urls, 2);
  assert.equal(r.notes.postcodes, 2);
  assert.ok(r.notes.phones >= 3);
});

test('dates and years are not mistaken for phone numbers or postcodes', () => {
  const t = 'Chef Jan 2019 - Dec 2021, Updated 0 days ago, 12 years experience, 2020 2021 2022';
  assert.equal(redactSnippet(t).text, t);
});

test('the planted test tokens never survive', () => {
  const r = redactSnippet('1. ZZTESTNAME Smithson Head Chef | Leeds, ZZ1 1ZZ Unlock candidate', { firstName: 'ZZTESTNAME' });
  assert.ok(!/ZZTESTNAME|Smithson|ZZ1 1ZZ/.test(r.text), r.text);
});

test('redaction can be switched off (SCREEN_REDACT=0) and only collapses whitespace', () => {
  const r = redactSnippet('1. Alex  Smith   Chef | LS1 4AB', { firstName: 'Alex', enabled: false });
  assert.equal(r.text, '1. Alex Smith Chef | LS1 4AB');
});

test('titles: pattern masks only; a postcode-shaped title is masked', () => {
  assert.equal(redactTitle('LS1 4AB').text, '<PC>');
  assert.equal(redactTitle('Sous Chef').text, 'Sous Chef');
  assert.equal(redactTitle('').text, '');
});

test('length cap and control characters', () => {
  const r = redactSnippet('a\u0000b\u0007c ' + 'x'.repeat(5000), { maxChars: 100 });
  assert.equal(r.text.length, 100);
  assert.ok(!/[\u0000-\u001f]/.test(r.text));
});

test('sha16 is stable and 16 hex characters', () => {
  assert.match(sha16('x'), /^[0-9a-f]{16}$/);
  assert.equal(sha16('x'), sha16('x'));
  assert.notEqual(sha16('x'), sha16('y'));
});

test('accented names are handled (card first name and the surname heuristic)', () => {
  const j = String.fromCharCode(0x4a, 0x6f, 0x73, 0xe9);
  const m = String.fromCharCode(0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72);
  const r = redactSnippet(`5. ${j} ${m} Head Chef | Leeds, LS1 4AB ${BODY}`, { firstName: j });
  assert.ok(r.text.startsWith('Head Chef | Leeds, <PC>'), r.text);
  assert.ok(!r.text.includes(j) && !r.text.includes(m));
  const fallback = redactSnippet(`5. ${j} ${m} Head Chef | Leeds, LS1 4AB ${BODY}`);
  assert.ok(fallback.text.startsWith('Head Chef |'), fallback.text);
  const body = redactSnippet(`5. ${j} ${m} Cook | X Key Responsibilities reference from ${j} available`, { firstName: j });
  assert.ok(!body.text.includes(j), body.text);
});

test('international numbers, bare social domains, handles, national insurance numbers, birth dates and ages are masked', () => {
  const r = redactSnippet('Call +353 87 123 4567 or +48 600 100 200, see linkedin.com/in/jo and instagram.com/jo_cooks, @jo_cooks; NI AB123456C; born 12/03/1985, DOB: 3 May 1990, aged 34; postcodes LS1,4AB and GIR 0AA');
  assert.ok(!/353|4567|600 100|linkedin|instagram|jo_cooks|AB123456C|1985|1990|34|LS1,4AB|GIR/.test(r.text), r.text);
  for (const tag of ['<PHONE>', '<URL>', '<HANDLE>', '<ID>', '<DOB>', '<AGE>', '<PC>']) assert.ok(r.text.includes(tag), tag + ' in ' + r.text);
});

test('the new masks leave ordinary CV text alone', () => {
  const t = 'Head Chef born in Leeds, 12 years experience, aged prime cuts, worked at Instagram Cafe, 2019 - 2021 covers 350 per night, NI cover';
  assert.equal(redactSnippet(t).text, t);
});

test('particle chains before a surname are removed as one surname', () => {
  assert.ok(redactSnippet('6. Maria van der Berg Head Chef | X ' + BODY, { firstName: 'Maria' }).text.startsWith('Head Chef |'));
  assert.ok(redactSnippet('6. Ana dos Santos Cook | X ' + BODY, { firstName: 'Ana' }).text.startsWith('Cook |'));
  assert.ok(redactSnippet('6. Priya de Partie Chef | X ' + BODY, { firstName: 'Priya' }).text.includes('de Partie'), 'a role phrase that starts with a particle is not a surname');
});

test('huge inputs are bounded before any pattern runs (no quadratic stall)', () => {
  const t0 = Date.now();
  const r = redactSnippet('a'.repeat(400000), { maxChars: 4000 });
  assert.ok(Date.now() - t0 < 2000, 'took ' + (Date.now() - t0) + ' ms');
  assert.equal(r.text.length, 4000);
  const t1 = Date.now();
  redactTitle('b'.repeat(400000));
  assert.ok(Date.now() - t1 < 2000);
});
