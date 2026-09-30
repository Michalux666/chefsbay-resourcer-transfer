// Ported from cv-corpus/tests/pdf-layout.test.js by tools/vendor-tests.js; only mechanical edits, see that tool.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { layoutPage } = require('../../../resourcer/scripts/lib/cv/vendor/pdf-layout');

const item = (str, x, y, w) => ({ str, x, y, w: w || str.length * 5.5, h: 11 });

test('row order: same baseline, big gap -> tab; small gap -> space; blank line for a paragraph gap', () => {
  const items = [
    item('Head', 72, 700), item('Chef', 100, 700), item('Jan 2019 - Mar 2021', 300, 700),
    item('Ran the kitchen', 72, 686),
    item('Sous Chef', 72, 640),
  ];
  const r = layoutPage(items, { pageWidth: 612 });
  assert.equal(r.rows, 'Head Chef\tJan 2019 - Mar 2021\nRan the kitchen\n\nSous Chef');
  assert.equal(r.columns, null);
});

test('a lone bullet glyph is glued to its text (not a table cell)', () => {
  const r = layoutPage([item('\u2022', 72, 700, 5), item('Prepared sauces', 90, 700)], { pageWidth: 612 });
  assert.equal(r.rows, '\u2022 Prepared sauces');
});

test('two-column page: column order reads the left column first', () => {
  const items = [];
  for (let i = 0; i < 10; i += 1) items.push(item(`left ${i}`, 60, 700 - i * 20));
  for (let i = 0; i < 10; i += 1) items.push(item(`right ${i}`, 320, 700 - i * 20));
  const r = layoutPage(items, { pageWidth: 612 });
  assert.ok(r.gutter !== null && r.gutter > 200 && r.gutter < 330);
  const lines = r.columns.split('\n').filter(Boolean);
  assert.deepEqual(lines.slice(0, 10), Array.from({ length: 10 }, (_, i) => `left ${i}`));
  assert.deepEqual(lines.slice(10), Array.from({ length: 10 }, (_, i) => `right ${i}`));
  assert.ok(r.rows.split('\n')[0].includes('\t'), 'row order keeps both columns on one line');
});

test('a full-width banner splits the page into bands', () => {
  const items = [item('A FULL WIDTH BANNER ACROSS THE WHOLE PAGE FROM EDGE TO EDGE OF THE SHEET', 60, 750, 480)];
  for (let i = 0; i < 6; i += 1) items.push(item(`l${i}`, 60, 700 - i * 20), item(`r${i}`, 320, 700 - i * 20));
  const r = layoutPage(items, { pageWidth: 612 });
  const lines = r.columns.split('\n').filter(Boolean);
  assert.ok(lines[0].startsWith('A FULL WIDTH'));
  assert.deepEqual(lines.slice(1, 7), ['l0', 'l1', 'l2', 'l3', 'l4', 'l5']);
});

test('a single wide text column is not treated as two columns', () => {
  const items = [];
  for (let i = 0; i < 20; i += 1) items.push(item('A long line of ordinary running text that spans most of the page width for sure', 72, 700 - i * 14, 440));
  const r = layoutPage(items, { pageWidth: 612 });
  assert.equal(r.columns, null);
});

test('empty and whitespace-only pages', () => {
  assert.deepEqual(layoutPage([], {}), { rows: '', columns: null, gutter: null });
  assert.equal(layoutPage([item('   ', 10, 10)], {}).rows, '');
});
