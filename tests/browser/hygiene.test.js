'use strict';
/* Source hygiene for the files this package ships: banned tokens, ASCII only, LF only, no hard-coded secrets. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const OWNED = [
  'lib/browser.js', 'lib/browser-env.js', 'caterer-login.js', 'caterer-preflight.js', 'caterer-browser-fetch.js', 'caterer-check-session.js',
  'caterer-cookie-jar.js', 'caterer-download-cv.js', 'caterer-get-credits.js', 'caterer-unlock.js',
].map((f) => path.join(H.SRC_SCRIPTS, f));

// Built by concatenation so this file does not contain the tokens it forbids.
const j = (...p) => p.join('');
const BANNED = [
  j('C', ':', '\\'), j('C', ':/Users'), j('w', 'sl '), j('power', 'shell'), j('pw', 'sh'), j('open', 'claw'),
  j('pm', '2'), j('sch', 'tasks'), j('187', '89'), j('WHATS', 'APP'), j('ng', 'rok'), j('\\', '\\'),
];

for (const f of OWNED) {
  test(`hygiene: ${path.basename(f)}`, () => {
    const s = fs.readFileSync(f, 'utf8');
    for (const tok of BANNED) assert.ok(!s.toLowerCase().includes(tok.toLowerCase()), `banned token ${JSON.stringify(tok)} in ${path.basename(f)}`);
    assert.ok(!/[^\x00-\x7f]/.test(s), 'ASCII only');
    assert.ok(!s.includes('\r'), 'LF line endings');
    assert.ok(!/(?:password|passwd|secret|token)\s*[:=]\s*['"][^'"\s]{8,}['"]/i.test(s.replace(/String\.raw`[^`]*`/g, '')), 'no hard-coded secret-looking literal');
  });
}

test('hygiene: the test tree is ASCII-only with LF endings too', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(__dirname).filter((x) => /\.(js|sh)$/.test(x))) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/[^\x00-\x7f]/.test(s), `ASCII only: ${path.relative(__dirname, f)}`);
    assert.ok(!s.includes('\r'), `LF only: ${path.relative(__dirname, f)}`);
  }
});

test('browser.js keeps its promises: no shell, argv array spawn, no top-level side effects', () => {
  const s = fs.readFileSync(OWNED[0], 'utf8');
  assert.ok(!/shell\s*:\s*true/.test(s));
  assert.ok(!/\bexec(?:Sync)?\s*\(/.test(s));
  assert.ok(/detached:\s*!IS_WIN/.test(s));
  assert.ok(s.includes('AGENT_BROWSER_SOCKET_DIR'));
});
