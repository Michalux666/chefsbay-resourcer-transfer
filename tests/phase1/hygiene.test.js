'use strict';
// Coding-standard checks for the phase-1 files (DESIGN section 9): ASCII only, LF, banned tokens, no shell strings.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const shipped = [path.join(REPO, 'resourcer', 'scripts', 'phase1.js')].concat(walk(path.join(REPO, 'resourcer', 'scripts', 'phase1'), []));
const tests = walk(__dirname, []);

const BS = String.fromCharCode(92);
const BANNED = [
  ['C:' + BS, 'windows drive path'], ['C:/Users', 'windows user path'], ['wsl ', 'wsl call'], ['power' + 'shell', 'ps host'], ['pw' + 'sh', 'ps core'],
  ['open' + 'claw', 'legacy gateway'], ['pm' + '2', 'process manager'], ['schtasks', 'scheduled tasks'], ['187' + '89', 'legacy port'],
  ['WHATS' + 'APP', 'whatsapp'], ['ng' + 'rok', 'tunnel'], [BS + BS, 'double backslash literal'],
];

test('shipped phase-1 files: ASCII only, LF line endings, no banned tokens', () => {
  assert.ok(shipped.length >= 15, `expected the phase1 modules, found ${shipped.length}`);
  for (const f of shipped) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/[^\x00-\x7f]/.test(text), `${f} contains non-ASCII`);
    assert.ok(!text.includes('\r'), `${f} contains CR`);
    for (const [tok, why] of BANNED) assert.ok(!text.includes(tok), `${f} contains banned token (${why}): ${tok}`);
  }
});

test('test and fake files are ASCII only with LF endings and free of the banned tokens too', () => {
  for (const f of tests) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/[^\x00-\x7f]/.test(text), `${f} contains non-ASCII`);
    assert.ok(!text.includes('\r'), `${f} contains CR`);
    if (f === __filename) continue;
    for (const [tok, why] of BANNED) assert.ok(!text.includes(tok), `${f} contains banned token (${why}): ${tok}`);
  }
});

test('children are spawned with argument arrays: no shell option, no exec/execSync, no shell strings', () => {
  for (const f of shipped) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/shell\s*:\s*true/.test(text), `${f} enables a shell`);
    assert.ok(!/\bexec(Sync)?\s*\(/.test(text), `${f} uses exec`);
    assert.ok(!/child_process'\)\.exec\b/.test(text));
  }
});

test('library code never calls process.exit (only the entry point sets the exit code and signal handlers do)', () => {
  for (const f of shipped) {
    const text = fs.readFileSync(f, 'utf8');
    const base = path.basename(f);
    const count = (text.match(/process\.exit\(/g) || []).length;
    if (base === 'phase1.js') assert.strictEqual(count, 1, 'only the safety-net timer');
    else if (base === 'run.js') assert.strictEqual(count, 1, 'only the signal handler');
    else assert.strictEqual(count, 0, `${f} calls process.exit`);
  }
});

test('every shipped file passes a syntax check', () => {
  const { spawnSync } = require('child_process');
  for (const f of shipped) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${f}: ${r.stderr}`);
  }
});
