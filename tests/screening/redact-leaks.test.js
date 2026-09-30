'use strict';
// Update C, finding F10: two classes of residual leak found by scanning 952 real cards through the real redaction (counts only):
//   (1) a ranked card whose leading name is not a plain "Capitalised Capitalised" (here: a four-token name that starts with a particle or an
//       initial, an honorific, a name in a script without capitals) kept its WHOLE name, because the first token was refused as the first name;
//   (2) a number of 13 digits behind a label was not masked (the phone pattern wants a 0, 0044 or + prefix).
// Every example below is INVENTED; no real name, number or card is involved. The last tests prove the fix does not eat job titles or dates.
const h = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const { redactSnippet, redactTitle } = require(h.lib('screening/redact'));

const BODY = 'Unlock candidate 0 applications in last 30 days Updated 3 days ago Never unlocked Recent experience Other CV snippets Sous Chef Mar 2019 - Current The Grand Hotel Key Responsibilities running the pass and stock control';

function headOf(card, firstName) {
  return redactSnippet(card, firstName ? { firstName } : {});
}

test('class 1: a four-token leading name that starts with a particle is removed whole (role word De and all), the title stays', () => {
  const card = `14. De La Cruz Martinez Sous Chef | Leeds, LS1 4AB ${BODY}`;
  const r = headOf(card);
  assert.equal(r.text, `Sous Chef | Leeds, <PC> ${BODY}`);
  assert.equal(r.notes.name, true);
  assert.equal(r.notes.surname, true);
  assert.ok(!/Cruz|Martinez|De La/.test(r.text));
  // the same when the card supplies a first name that does not match the leading tokens
  assert.ok(!/Cruz|Martinez/.test(headOf(card, 'Zebedee').text));
});

test('class 1: initials, an honorific and a caseless script at the head of a ranked card', () => {
  const initials = headOf(`9. J. R. Quillfeather Brown Head Chef | Hull ${BODY}`);
  assert.ok(initials.text.startsWith('Head Chef | Hull'), initials.text);
  assert.ok(!/Quillfeather|Brown/.test(initials.text));

  const honorific = headOf(`3. Dr Wilhelmina Thornbury Pastry Chef | York ${BODY}`);
  assert.ok(honorific.text.startsWith('Pastry Chef | York'), honorific.text);
  assert.ok(!/Wilhelmina|Thornbury|\bDr\b/.test(honorific.text));

  // Arabic: four words, none of which has a capital letter (built from code points: the repository is ASCII only)
  const arabicName = [0x645, 0x62d, 0x645, 0x62f].concat([0x20, 0x639, 0x644, 0x64a], [0x20, 0x62d, 0x633, 0x646], [0x20, 0x627, 0x644, 0x639, 0x645, 0x631, 0x64a]).map(c => String.fromCodePoint(c)).join('');
  const arabic = headOf(`4. ${arabicName} Chef | Leeds ${BODY}`);
  assert.ok(arabic.text.startsWith('Chef | Leeds'), arabic.text);
  assert.ok(![...arabic.text].some(ch => ch.codePointAt(0) >= 0x600 && ch.codePointAt(0) <= 0x6ff));
  assert.equal(arabic.notes.name, true);
});

test('class 1: the ordinary cases are unchanged (capitalised first name and surname, known first name, lower case, long rank)', () => {
  assert.ok(headOf(`12. Alex Smith Head Chef | Leeds ${BODY}`, 'Alex').text.startsWith('Head Chef | Leeds'));
  assert.ok(headOf(`5. Priya Patel Chef de Partie | Leeds ${BODY}`).text.startsWith('Chef de Partie | Leeds'));
  assert.ok(headOf(`1234. tarquin fenwick Head Chef | Leeds ${BODY}`).text.startsWith('Head Chef | Leeds'));
  // a honorific is not taken for the first name any more: nothing of the name is left behind
  const mr = headOf(`6. Mr Tarquin Fenwick Sous Chef | Leeds ${BODY}`);
  assert.ok(mr.text.startsWith('Sous Chef | Leeds'), mr.text);
});

test('it never eats a job title: ranked cards with no name at all, and titles made of words that could be a name', () => {
  for (const title of ['Sous Chef', 'Head Chef', 'Chef de Partie', 'Kitchen Porter', 'Commis Chef', 'Pastry Chef', 'Line Cook', 'Breakfast Chef', 'Sushi Chef', 'Demi Chef de Partie']) {
    const r = headOf(`21. ${title} | Leeds, LS1 4AB ${BODY}`);
    assert.ok(r.text.startsWith(`${title} | Leeds, <PC>`), `${title}: ${r.text.slice(0, 50)}`);
    assert.equal(r.notes.name, false, `${title}: nothing was taken for a name`);
  }
  // "A la carte" begins with words that look like name parts, but a bare A is an English word and no initial, so nothing is cut
  const alaCarte = headOf(`8. A La Carte Chef | Leeds ${BODY}`);
  assert.ok(alaCarte.text.startsWith('A La Carte Chef | Leeds'), alaCarte.text);
  // a named card keeps a title made of capitalised words that are not role words
  const named = headOf(`5. Anna Smith Michelin Starred Chef | Leeds ${BODY}`);
  assert.ok(named.text.startsWith('Michelin Starred Chef | Leeds'), named.text);
});

test('class 2: a 13-digit number behind a label is masked, with or without separators and whatever the label', () => {
  const cases = [
    ['Mobile: 4479123456789', /Mobile: <PHONE>/],
    ['Tel 44 7912 345 6789', /Tel <PHONE>/],
    ['Phone number - 7912-345-67890', /Phone number - <PHONE>/],
    ['WhatsApp: +44 7912 345678', /WhatsApp: <PHONE>/],
    ['Call 4479123456789', /Call <PHONE>/],
  ];
  for (const [text, want] of cases) {
    const r = redactSnippet(`7. Sous Chef | Leeds ${text} ${BODY}`);
    assert.match(r.text, want, text);
    assert.ok(!/\d{9}/.test(r.text.replace(BODY, '')), `${text}: no long digit run is left`);
    assert.ok(r.notes.phones >= 1, text);
  }
  // ten or more digits in one piece are masked even without a label
  assert.match(redactSnippet(`7. Sous Chef | Leeds 4479123456789 ${BODY}`).text, /Leeds <PHONE> Unlock/);
  // the titles go through the same masks
  assert.equal(redactTitle('Chef Mobile: 4479123456789').text, 'Chef Mobile: <PHONE>');
});

test('class 2 does not touch dates, years, counts or a word after the label', () => {
  const kept = [
    'Jan 2017 - Dec 2019 2019 2021 2020 2022',
    'Contact Centre Agent Mar 2018 - Jun 2020',
    'Phone Repair Technician 2015 - 2018',
    'Call Centre Team Leader 2016 2017 2018 2019',
    '12 covers 120 covers 1200 covers',
  ];
  for (const text of kept) {
    const r = redactSnippet(`7. Sous Chef | Leeds ${text} ${BODY}`);
    assert.ok(r.text.includes(text), `${text} -> ${r.text.slice(0, 80)}`);
    assert.equal(r.notes.phones, 0, text);
  }
});

test('class 1: the leading name is found when its first token has a typographic apostrophe or an accent typed as a separate mark (the plain pattern refused both)', () => {
  const apostrophe = String.fromCharCode(0x2019);
  const combining = String.fromCharCode(0x301);
  for (const name of [`O${apostrophe}Brienson Quillfeather`, `Jose${combining} Quillfeather`, `D${apostrophe}Souzatron Brandywine`]) {
    const r = headOf(`5. ${name} Sous Chef | Leeds, LS1 4AB ${BODY}`);
    assert.equal(r.text, `Sous Chef | Leeds, <PC> ${BODY}`, name);
    assert.equal(r.notes.name, true);
  }
});

test('class 1: a leading honorific, particle or initial marks the start of a name even when the title does not start with a role word; with no such cue nothing is cut', () => {
  // the title starts with a word that is not a role word: a name cue still means the name-shaped tokens before it are a name
  const a = headOf(`9. De La Quillfeather Brandywine Gourmet Sous Chef | Hull ${BODY}`);
  assert.ok(!/Quillfeather|Brandywine/.test(a.text), a.text.slice(0, 60));
  assert.ok(a.text.includes('Sous Chef | Hull'));
  const b = headOf(`9. J. R. Quillfeather Brandywine Gourmet Sous Chef | Hull ${BODY}`);
  assert.ok(!/Quillfeather|Brandywine/.test(b.text), b.text.slice(0, 60));
  // bare capital letters count as initials only beside another initial: 'E Commerce Manager' is a title
  const title = headOf(`9. E Commerce Manager | Hull ${BODY}`);
  assert.ok(title.text.startsWith('E Commerce Manager | Hull'), title.text.slice(0, 50));
  assert.equal(headOf(`9. J R Quillfeather Sous Chef | Hull ${BODY}`).text.startsWith('Sous Chef | Hull'), true, 'J R Quillfeather: initials beside an initial');
  // without a cue and without a role word after them, capitalised words are left alone
  const none = headOf(`9. Gourmet Specialities Kitchen Lead | Hull ${BODY}`);
  assert.ok(none.notes.name, 'the existing first-name heuristic still applies to a plain capitalised start');
});
