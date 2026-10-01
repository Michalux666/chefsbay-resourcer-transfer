'use strict';
// tools/make-manifest.js and tools/check-manifest.js: the code lockdown holds (changed, missing, added, installed copies, pins, exit codes).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.resolve(__dirname, '..', '..');
const isWin = process.platform === 'win32';
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-'));
test.after(() => { fs.rmSync(base, { recursive: true, force: true }); });
function cp(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
function copyTree(from, to, skip) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyTree(a, b, skip);
    else if (e.isFile()) cp(a, b);
  }
}
const SKIP = new Set(['node_modules', '.git', 'tests', 'data', 'research', '__pycache__']);

function world(tag) {
  const root = path.join(base, tag);
  const prof = path.join(root, 'opt-data', 'profiles', 'resourcer');
  const repo = path.join(prof, 'workspace');
  copyTree(SRC, repo, SKIP);
  fs.mkdirSync(path.join(prof, 'scripts'), { recursive: true });
  for (const f of fs.readdirSync(path.join(repo, 'hermes', 'scripts'))) cp(path.join(repo, 'hermes', 'scripts', f), path.join(prof, 'scripts', f));
  const plugin = path.join(root, 'opt-data', 'plugins', 'resourcer');
  copyTree(path.join(repo, 'plugin', 'resourcer'), plugin, new Set());
  cp(path.join(repo, 'hermes', 'SOUL.md'), path.join(prof, 'SOUL.md'));
  cp(path.join(repo, 'hermes', 'AGENTS.md'), path.join(repo, 'AGENTS.md'));
  copyTree(path.join(repo, 'hermes', 'skills', 'resourcer-ops'), path.join(prof, 'skills', 'productivity', 'resourcer-ops'), new Set());
  const mk = run(repo, 'make-manifest.js', []);
  assert.strictEqual(mk.status, 0, mk.stdout + mk.stderr);
  return { root, prof, repo, plugin, tools: path.join(repo, 'tools') };
}
function run(repo, tool, args, env) {
  return spawnSync(process.execPath, [path.join(repo, 'tools', tool), ...args], { encoding: 'utf8', env: Object.assign({}, process.env, { RESOURCER_HOME: '', HERMES_HOME: '' }, env || {}) });
}
const check = (w, args, env) => run(w.repo, 'check-manifest.js', args, env);

test('clean tree verifies, with installed wrappers and plugin found by layout', () => {
  const w = world('clean');
  const r = check(w, []);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /MANIFEST_OK files=\d+ changed=0 missing=0 unlisted=0 installed_changed=0 installed_missing=0/);
  assert.match(r.stdout, /installed wrappers compared/);
  assert.match(r.stdout, /installed plugin compared/);
});

test('a changed script fails with its path', () => {
  const w = world('chg');
  fs.appendFileSync(path.join(w.repo, 'resourcer', 'scripts', 'run-lock.js'), '\n// tampered\n');
  const r = check(w, []);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^CHANGED resourcer\/scripts\/run-lock\.js$/m);
  assert.match(r.stdout, /MANIFEST_FAILED/);
});

test('a deleted file fails as MISSING', () => {
  const w = world('miss');
  fs.unlinkSync(path.join(w.repo, 'resourcer', 'scripts', 'constants.js'));
  const r = check(w, []);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^MISSING resourcer\/scripts\/constants\.js$/m);
});

test('an added script fails as UNLISTED', () => {
  const w = world('add');
  fs.writeFileSync(path.join(w.repo, 'resourcer', 'scripts', 'lib', 'extra.js'), 'module.exports = 1;\n');
  const r = check(w, []);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^UNLISTED resourcer\/scripts\/lib\/extra\.js$/m);
});

test('installed SOUL.md, AGENTS.md and the skill are compared', () => {
  const w = world('prof');
  let r = check(w, []);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.match(r.stdout, /installed skill compared/);
  fs.appendFileSync(path.join(w.prof, 'SOUL.md'), 'x');
  fs.appendFileSync(path.join(w.repo, 'AGENTS.md'), 'x');
  fs.appendFileSync(path.join(w.prof, 'skills', 'productivity', 'resourcer-ops', 'SKILL.md'), 'x');
  r = check(w, []);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^INSTALLED_CHANGED .*SOUL.md$/m);
  assert.match(r.stdout, /^INSTALLED_CHANGED .*AGENTS.md$/m);
  assert.match(r.stdout, /^INSTALLED_CHANGED .*SKILL.md$/m);
});

test('a tampered installed wrapper fails; a missing one only warns', () => {
  const w = world('inst');
  fs.appendFileSync(path.join(w.prof, 'scripts', 'resourcer-tick.sh'), '\necho x\n');
  let r = check(w, []);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^INSTALLED_CHANGED .*resourcer-tick\.sh$/m);
  fs.copyFileSync(path.join(w.repo, 'hermes', 'scripts', 'resourcer-tick.sh'), path.join(w.prof, 'scripts', 'resourcer-tick.sh'));
  fs.unlinkSync(path.join(w.prof, 'scripts', 'resourcer-backup.sh'));
  r = check(w, []);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.match(r.stdout, /^INSTALLED_MISSING .*resourcer-backup\.sh$/m);
});

test('an extra resourcer wrapper in the profile is refused', () => {
  const w = world('inst2');
  fs.writeFileSync(path.join(w.prof, 'scripts', 'resourcer-evil.sh'), '#!/bin/sh\n');
  const r = check(w, []);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^INSTALLED_UNLISTED .*resourcer-evil\.sh$/m);
});

test('installed plugin: change fails, plugin_config.json and bytecode are allowed, another file is refused', () => {
  const w = world('plug');
  fs.writeFileSync(path.join(w.plugin, 'dashboard', 'plugin_config.json'), '{"resourcerHome":"/x"}\n');
  fs.mkdirSync(path.join(w.plugin, 'dashboard', '__pycache__'), { recursive: true });
  fs.writeFileSync(path.join(w.plugin, 'dashboard', '__pycache__', 'a.pyc'), 'x');
  let r = check(w, []);
  assert.strictEqual(r.status, 0, r.stdout);
  fs.appendFileSync(path.join(w.plugin, 'dashboard', 'plugin_api.py'), '\n# x\n');
  r = check(w, []);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^INSTALLED_CHANGED .*plugin_api\.py$/m);
  fs.copyFileSync(path.join(w.repo, 'plugin', 'resourcer', 'dashboard', 'plugin_api.py'), path.join(w.plugin, 'dashboard', 'plugin_api.py'));
  fs.writeFileSync(path.join(w.plugin, 'dashboard', 'other.py'), 'x = 1\n');
  r = check(w, []);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^INSTALLED_UNLISTED .*other\.py$/m);
});

test('config drift is advisory unless --strict-config', () => {
  const w = world('cfg');
  fs.writeFileSync(path.join(w.repo, 'resourcer', 'config', 'screening.json'), '{"engine":"llm"}\n');
  fs.writeFileSync(path.join(w.repo, 'resourcer', 'config', 'dashboard-settings.json'), '{}\n');
  let r = check(w, []);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.match(r.stdout, /^CONFIG_CHANGED resourcer\/config\/screening\.json$/m);
  assert.match(r.stdout, /^CONFIG_UNLISTED resourcer\/config\/dashboard-settings\.json$/m);
  assert.match(r.stdout, /config_drift=2/);
  r = check(w, ['--strict-config']);
  assert.strictEqual(r.status, 1);
});

test('pin: matching digest passes, other digest fails', () => {
  const w = world('pin');
  const digest = /MANIFEST_SHA256=([0-9a-f]{64})/.exec(check(w, []).stdout)[1];
  assert.strictEqual(check(w, ['--expect', digest]).status, 0);
  const r = check(w, ['--expect', '0'.repeat(64)]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /PIN_MISMATCH/);
  assert.strictEqual(check(w, ['--expect', 'abc']).status, 2);
});

test('a checkout with CRLF line endings verifies the same way', () => {
  const w = world('crlf');
  const f = path.join(w.repo, 'resourcer', 'scripts', 'run-lock.js');
  fs.writeFileSync(f, fs.readFileSync(f, 'latin1').replace(/\r?\n/g, '\r\n'), 'latin1');
  const r = check(w, ['--installed', 'off']);
  assert.strictEqual(r.status, 0, r.stdout);
});

test('manifest missing exits 3, malformed exits 3, unknown option exits 2', () => {
  const w = world('bad');
  fs.unlinkSync(path.join(w.repo, 'MANIFEST.sha256'));
  let r = check(w, []);
  assert.strictEqual(r.status, 3);
  assert.match(r.stdout, /MANIFEST_MISSING/);
  fs.writeFileSync(path.join(w.repo, 'MANIFEST.sha256'), 'not a manifest\n');
  r = check(w, []);
  assert.strictEqual(r.status, 3);
  fs.writeFileSync(path.join(w.repo, 'MANIFEST.sha256'), 'a'.repeat(64) + '  ../etc/passwd\n');
  assert.strictEqual(check(w, []).status, 3);
  assert.strictEqual(check(w, ['--bogus']).status, 2);
});

test('RESOURCER_HOME redirects resourcer/ and is reported', () => {
  const w = world('rh');
  const alt = path.join(w.root, 'alt-resourcer');
  copyTree(path.join(w.repo, 'resourcer'), alt, new Set());
  fs.appendFileSync(path.join(alt, 'scripts', 'run-lock.js'), '\n// x\n');
  const r = check(w, [], { RESOURCER_HOME: alt });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^CHANGED resourcer\/scripts\/run-lock\.js$/m);
  assert.match(r.stdout, /NOTE resourcer\/ read from .*alt-resourcer/);
});

test('make-manifest refuses a symlink and an odd file name; is deterministic; --dry-run writes nothing', () => {
  const w = world('mk');
  const a = fs.readFileSync(path.join(w.repo, 'MANIFEST.sha256'), 'utf8');
  const again = run(w.repo, 'make-manifest.js', []);
  assert.strictEqual(again.status, 0);
  assert.strictEqual(fs.readFileSync(path.join(w.repo, 'MANIFEST.sha256'), 'utf8'), a);
  fs.writeFileSync(path.join(w.repo, 'tools', 'bad name.js'), 'x\n');
  const r = run(w.repo, 'make-manifest.js', []);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unusual file name/);
  fs.unlinkSync(path.join(w.repo, 'tools', 'bad name.js'));
  if (!isWin) {
    fs.symlinkSync('/etc/hostname', path.join(w.repo, 'tools', 'link.js'));
    const s = run(w.repo, 'make-manifest.js', []);
    assert.strictEqual(s.status, 1);
    assert.match(s.stderr, /symlink not allowed/);
    fs.unlinkSync(path.join(w.repo, 'tools', 'link.js'));
  }
  const before = fs.readFileSync(path.join(w.repo, 'MANIFEST.sha256'), 'utf8');
  fs.appendFileSync(path.join(w.repo, 'tools', 'make-manifest.js'), '\n');
  const d = run(w.repo, 'make-manifest.js', ['--dry-run']);
  assert.strictEqual(d.status, 0);
  assert.strictEqual(fs.readFileSync(path.join(w.repo, 'MANIFEST.sha256'), 'utf8'), before);
  assert.strictEqual(run(w.repo, 'make-manifest.js', ['--nope']).status, 2);
});

test('sha256sum -c agrees with the manifest on a POSIX tree', () => {
  if (isWin) return;
  const w = world('sum');
  const r = spawnSync('sha256sum', ['-c', 'MANIFEST.sha256', '--quiet'], { cwd: w.repo, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

test('the MANIFEST.sha256 committed in the repository is the manifest of this tree (a release whose code changed after the last make-manifest fails here, not on the instance)', (t) => {
  // Only in a git checkout: a copy that npm install or a test run has added files to (package-lock.json) has no .git and is skipped.
  if (!fs.existsSync(path.join(SRC, '.git'))) { t.skip('not a git checkout'); return; }
  const mk = require(path.join(SRC, 'tools', 'make-manifest.js'));
  const fresh = mk.buildManifest(SRC);
  const committed = fs.readFileSync(path.join(SRC, 'MANIFEST.sha256'), 'utf8');
  assert.strictEqual(committed, fresh.text, 'run: node tools/make-manifest.js, commit MANIFEST.sha256, and give the owner the manifest_sha256= value it prints');
});
