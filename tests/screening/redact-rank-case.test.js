'use strict';
// Regression (2026-09-30, backtest finding): the card rank prefix was stripped for 1-3 digits only and the
// name was removed only when capitalised, so a 4-digit rank or a lower-case name reached Jev. Synthetic data only.
const h = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const { redactSnippet } = require(h.lib('screening/redact'));

const BODY = 'Unlock candidate 2 applications in last 30 days Updated 3 days ago Never unlocked Recent experience Other CV snippets Sous Chef Mar 2019 - Current The Grand Hotel Key Responsibilities running the pass, ordering and stock control; Commis Chef Jun 2016 - Feb 2019 Riverside Bistro';
const RANKS = ['7', '12', '123', '1234', '12345', '123456'];
const NAME_LEAK = /tarquin|fenwick/i;

function both(card, firstName) {
  return [redactSnippet(card, { firstName }), redactSnippet(card)];
}

test('the rank prefix is stripped at any length from 1 to 6 digits, with and without the card first name', () => {
  for (const rank of RANKS) {
    for (const r of both(`${rank}. Tarquin Fenwick Head Chef | Leeds, LS1 4AB ${BODY}`, 'Tarquin')) {
      assert.equal(r.text, `Head Chef | Leeds, <PC> ${BODY}`, `rank ${rank}`);
      assert.equal(r.notes.name, true, `rank ${rank}`);
      assert.equal(r.notes.surname, true, `rank ${rank}`);
    }
  }
});

test('a lower-case name is removed at any rank length, with and without the card first name', () => {
  for (const rank of RANKS) {
    for (const r of both(`${rank}. tarquin fenwick Head Chef | Leeds, LS1 4AB ${BODY}`, 'Tarquin')) {
      assert.equal(r.text, `Head Chef | Leeds, <PC> ${BODY}`, `rank ${rank}`);
      assert.equal(r.notes.surname, true, `rank ${rank}`);
    }
    for (const r of both(`${rank}. tarquin fenwick head chef | leeds, ls1 4ab ${BODY}`, 'Tarquin')) {
      assert.ok(r.text.startsWith('head chef | leeds, <PC> Unlock candidate'), r.text);
      assert.ok(!NAME_LEAK.test(r.text), r.text);
    }
  }
});

test('a lower-case name after a card first name is removed even when the card has no rank prefix', () => {
  const r = redactSnippet(`tarquin fenwick Head Chef | Leeds, LS1 4AB ${BODY}`, { firstName: 'Tarquin' });
  assert.equal(r.text, `Head Chef | Leeds, <PC> ${BODY}`);
});

test('an upper-case name is removed at any rank length, and a recurring upper-case first name is masked in the body', () => {
  for (const rank of RANKS) {
    for (const r of both(`${rank}. TARQUIN FENWICK HEAD CHEF | LEEDS, LS1 4AB Unlock candidate`, 'Tarquin')) {
      assert.equal(r.text, 'HEAD CHEF | LEEDS, <PC> Unlock candidate', `rank ${rank}`);
      assert.equal(r.notes.surname, true, `rank ${rank}`);
    }
  }
  const body = redactSnippet('1234. TARQUIN FENWICK Cook | X Key Responsibilities reference from TARQUIN available', { firstName: 'Tarquin' });
  assert.ok(!NAME_LEAK.test(body.text), body.text);
  assert.ok(body.text.includes('<NAME>'), body.text);
});

test('a lower-case name with a particle chain before the surname is removed', () => {
  for (const rank of ['12', '1234']) {
    const r = redactSnippet(`${rank}. maria de souza head chef | X ${BODY}`, { firstName: 'Maria' });
    assert.ok(r.text.startsWith('head chef | X'), r.text);
    const bare = redactSnippet(`${rank}. maria van der berg Head Chef | X ${BODY}`);
    assert.ok(bare.text.startsWith('Head Chef | X'), bare.text);
  }
});

test('a surname that is also a role word stays (documented limit), for every rank length and case', () => {
  for (const rank of RANKS) {
    const lower = redactSnippet(`${rank}. tarquin cook Sous Chef | Leeds ${BODY}`, { firstName: 'Tarquin' });
    assert.ok(!/tarquin/i.test(lower.text), lower.text);
    assert.ok(lower.text.startsWith('cook Sous Chef |'), lower.text);
    const baker = redactSnippet(`${rank}. Tarquin Baker Sous Chef | Leeds ${BODY}`);
    assert.ok(!/tarquin/i.test(baker.text), baker.text);
    assert.ok(baker.text.startsWith('Baker Sous Chef |'), baker.text);
    const upper = redactSnippet(`${rank}. TARQUIN COOK SOUS CHEF | LEEDS`, { firstName: 'Tarquin' });
    assert.ok(upper.text.startsWith('COOK SOUS CHEF |'), upper.text);
  }
});

test('job titles, employers and duties are not over-redacted, whatever the case of the name or the length of the rank', () => {
  const shapes = ['12. Tarquin Fenwick', '1234. Tarquin Fenwick', '12. tarquin fenwick', '1234. tarquin fenwick', '123456. TARQUIN FENWICK', '1234. Tarquin'];
  for (const name of shapes) {
    for (const r of both(`${name} Head Chef | Leeds, LS1 4AB ${BODY}`, 'Tarquin')) {
      assert.equal(r.text, `Head Chef | Leeds, <PC> ${BODY}`, name);
      assert.ok(!r.text.includes('<NAME>'), name);
    }
  }
});

test('a card with a rank but no name keeps its headline, and lower-case text that is kept is not re-cased', () => {
  const kept = redactSnippet(`1234. kitchen porter | Bath, BA1 1AA ${BODY}`);
  assert.equal(kept.text, `kitchen porter | Bath, <PC> ${BODY}`);
  assert.equal(kept.notes.name, false);
  const role = redactSnippet(`12. head chef | leeds, ls1 4ab ${BODY}`);
  assert.equal(role.text, `head chef | leeds, <PC> ${BODY}`);
  assert.equal(role.notes.name, false);
  const upper = redactSnippet('4321. KITCHEN PORTER | BATH Unlock candidate');
  assert.equal(upper.text, 'KITCHEN PORTER | BATH Unlock candidate');
});

test('no name shape leaks a synthetic name (rank length x case x card first name)', () => {
  const names = ['Tarquin Fenwick', 'tarquin fenwick', 'TARQUIN FENWICK'];
  for (const rank of RANKS) {
    for (const name of names) {
      for (const r of both(`${rank}. ${name} Sous Chef | Leeds, LS1 4AB ${BODY}`, 'Tarquin')) assert.ok(!NAME_LEAK.test(r.text), `${rank} ${name}: ${r.text}`);
    }
  }
});
