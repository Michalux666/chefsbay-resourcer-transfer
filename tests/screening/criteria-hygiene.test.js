'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

const SHIPPED = [
  'resourcer/scripts/lib/screening/card.js',
  'resourcer/scripts/lib/screening/criteria.js',
  'resourcer/scripts/lib/screening/decide.js',
  'resourcer/scripts/lib/screening/jev-client.js',
  'resourcer/scripts/lib/screening/jev-questions.js',
  'resourcer/scripts/lib/screening/operating-point.js',
  'tools/screening-operating-point.js',
  'tools/gold-rows.js',
  'resourcer/config/screening-criteria.json',
  'tests/screening/criteria-fake-answers.js',
  'tests/screening/criteria-helpers.js',
  'tests/screening/criteria-answers.js',
  'tests/screening/operating-point.test.js',
  'tests/screening/engine-injection.test.js',
  'tests/screening/engine-unreadable.test.js',
  'tests/screening/criteria-hygiene.test.js',
  'tests/screening/criteria.test.js',
  'tests/screening/card.test.js',
  'tests/screening/questions.test.js',
  'tests/screening/decide-criteria.test.js',
  'tests/screening/client-criteria.test.js',
  'tests/screening/probes.test.js',
  'tests/screening/fixtures/criteria-probes.json',
  'docs/SCREENING-CRITERIA.md',
].map(f => path.join(ROOT, f)).filter(f => fs.existsSync(f));

// built from parts so this file does not contain the tokens it forbids
const j = (...p) => p.join('');
const BANNED = [
  j('C:', String.fromCharCode(92)), j('C:', '/Users'), j('ws', 'l '), j('power', 'shell'), j('pw', 'sh'), j('open', 'claw'), j('pm', '2'),
  j('scht', 'asks'), j('18', '789'), j('WHATS', 'APP'), j('ng', 'rok'), String.fromCharCode(92, 92),
];

test('the files of this patch are ASCII, LF only and without a BOM', () => {
  assert.ok(SHIPPED.length >= 10);
  for (const f of SHIPPED) {
    const buf = fs.readFileSync(f);
    assert.ok(!(buf[0] === 0xef && buf[1] === 0xbb), `${f}: BOM`);
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] > 0x7f) assert.fail(`${path.relative(ROOT, f)}: non-ASCII byte at ${i}`);
      if (buf[i] === 0x0d) assert.fail(`${path.relative(ROOT, f)}: CR at ${i}`);
    }
  }
});

test('no banned token in any file of this patch', () => {
  for (const f of SHIPPED) {
    if (f.endsWith('criteria-hygiene.test.js')) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const t of BANNED) assert.ok(!text.includes(t), `${path.relative(ROOT, f)} contains a banned token (${JSON.stringify(t)})`);
  }
});

test('code has no block comments and no comment longer than one line', () => {
  for (const f of SHIPPED.filter(x => x.endsWith('.js'))) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    let prevWasComment = false;
    lines.forEach((line, i) => {
      const t = line.trim();
      assert.ok(!t.startsWith('/*') && !t.startsWith('*/') && !t.startsWith('* '), `${path.relative(ROOT, f)}:${i + 1} block comment`);
      const isComment = t.startsWith('//');
      assert.ok(!(isComment && prevWasComment), `${path.relative(ROOT, f)}:${i + 1} comment longer than one line`);
      prevWasComment = isComment;
    });
  }
});

test('libraries never call process.exit and use only built-in modules', () => {
  const builtin = new Set(require('node:module').builtinModules);
  for (const f of SHIPPED.filter(x => x.endsWith('.js'))) {
    const text = fs.readFileSync(f, 'utf8');
    if (f.includes(`${path.sep}lib${path.sep}`)) assert.ok(!/process\.exit\(/.test(text), `${f} calls process.exit`);
    if (!f.includes(`${path.sep}tests${path.sep}`)) assert.ok(!/(sk-|vck_|Bearer [A-Za-z0-9]{20,})/.test(text), `${f}: key-shaped literal`);
    for (const m of text.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      const name = m[1];
      if (name.startsWith('.') || name.startsWith('node:')) continue;
      assert.ok(builtin.has(name), `${path.relative(ROOT, f)} requires ${name}`);
    }
  }
});
