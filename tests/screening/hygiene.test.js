'use strict';
// Coding-standard checks on the files this package ships (DESIGN section 9): ASCII only, LF, no banned
// tokens, no process.exit inside libraries, no secrets, no snippet temp files in the code.
const h = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const OWNED = [
  'resourcer/scripts/ai-review.js',
  'resourcer/scripts/caterer-ai-review.js',
  'resourcer/scripts/lib/screening-health.js',
  'resourcer/config/screening.json',
  'resourcer/config/screening-criteria.json',
  'tools/screening-report.js',
  'tools/screening-operating-point.js',
  'tools/gold-rows.js',
  'docs/SCREENING.md',
  'docs/SCREENING-CRITERIA.md',
  'docs/parity/screening.md',
];
function collect(dir, out) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) collect(p, out); else out.push(p);
  }
  return out;
}
const files = [
  ...OWNED.map(f => path.join(h.REPO, f)),
  ...collect(path.join(h.REPO, 'resourcer', 'scripts', 'lib', 'screening'), []),
  ...collect(path.join(h.REPO, 'tests', 'screening'), []),
  ...collect(path.join(h.REPO, 'tests', 'fake-gateway'), []),
].filter(f => fs.existsSync(f));

// built from parts so this file does not contain the tokens it forbids
const j = (...p) => p.join('');
const BANNED = [
  j('C:', String.fromCharCode(92)), j('C:', '/Users'), j('ws', 'l '), j('power', 'shell'), j('pw', 'sh'), j('open', 'claw'), j('pm', '2'),
  j('scht', 'asks'), j('18', '789'), j('WHATS', 'APP'), j('ng', 'rok'), String.fromCharCode(92, 92),
];

test('every shipped file is ASCII, LF-only, without a BOM', () => {
  assert.ok(files.length > 20);
  for (const f of files) {
    const buf = fs.readFileSync(f);
    assert.ok(!(buf[0] === 0xef && buf[1] === 0xbb), `${f}: BOM`);
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] > 0x7f) assert.fail(`${path.relative(h.REPO, f)}: non-ASCII byte at ${i}`);
      if (buf[i] === 0x0d) assert.fail(`${path.relative(h.REPO, f)}: CR at ${i}`);
    }
  }
});

test('no banned tokens anywhere in the shipped files', () => {
  for (const f of files) {
    if (f.endsWith('hygiene.test.js')) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const t of BANNED) assert.ok(!text.includes(t), `${path.relative(h.REPO, f)} contains a banned token (${JSON.stringify(t)})`);
  }
});

test('libraries never call process.exit; only the CLI entry points may', () => {
  for (const f of files.filter(x => x.includes(`${path.sep}lib${path.sep}`))) {
    assert.ok(!/process\.exit\(/.test(fs.readFileSync(f, 'utf8')), `${path.relative(h.REPO, f)} calls process.exit`);
  }
});

test('no secrets and no snippet temp files in code: no key-shaped literals, no review-tmp writers, no /tmp', () => {
  for (const f of files.filter(x => x.endsWith('.js') && !x.includes(`${path.sep}tests${path.sep}`))) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/(sk-|vck_|Bearer [A-Za-z0-9]{20,})/.test(text), `${f}: key-shaped literal`);
    assert.ok(!/writeFile(Sync)?\([^)]*review-tmp/.test(text), `${f}: writes review-tmp`);
    assert.ok(!/['"]\/tmp/.test(text), `${f}: uses /tmp`);
  }
});

test('the only npm-free requirements: no third-party modules in the screening code', () => {
  const builtin = new Set(require('node:module').builtinModules);
  for (const f of files.filter(x => x.endsWith('.js') && !x.includes(`${path.sep}tests${path.sep}`))) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      const name = m[1];
      if (name.startsWith('.') || name.startsWith('node:')) continue;
      assert.ok(builtin.has(name), `${path.relative(h.REPO, f)} requires ${name}`);
    }
  }
});
