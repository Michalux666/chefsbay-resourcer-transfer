'use strict';
// plugin/resourcer/install-plugin.sh: copy without bytecode caches, move an old install aside, link, enable.
// A stub stands in for the hermes command; nothing outside the temp directory is touched. POSIX shells only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN = path.resolve(__dirname, '..', '..', 'plugin', 'resourcer');
const SCRIPT = path.join(PLUGIN, 'install-plugin.sh');
const skip = process.platform === 'win32' ? 'POSIX shell tools only (runs on Linux)' : false;

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyTree(a, b); else fs.copyFileSync(a, b);
  }
}

function fixture(hermesBody) {
  const root = fs.mkdtempSync(path.join(process.env.LIFECYCLE_TEST_TMP || os.tmpdir(), 'plug-'));
  const src = path.join(root, 'src', 'resourcer');
  copyTree(PLUGIN, src);
  fs.mkdirSync(path.join(src, 'dashboard', '__pycache__'), { recursive: true });
  fs.writeFileSync(path.join(src, 'dashboard', '__pycache__', 'plugin_api.cpython-312.pyc'), 'bytecode');
  fs.writeFileSync(path.join(src, 'stray.pyc'), 'bytecode');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(root, 'hermes.log');
  fs.writeFileSync(path.join(bin, 'hermes'), `#!/usr/bin/env bash\necho "$@" >> "${log}"\n${hermesBody || ''}\n`, { mode: 0o755 });
  const env = {
    PATH: process.env.PATH, HOME: root, PLUGIN_DEST: path.join(root, 'plugins', 'resourcer'),
    PROFILE_PLUGINS_DIR: path.join(root, 'profile', 'plugins'), HERMES_BIN: path.join(bin, 'hermes'),
  };
  const run = () => spawnSync('bash', [path.join(src, 'install-plugin.sh')], { env, encoding: 'utf8', timeout: 60000 });
  return { root, src, env, log, run };
}

test('installs a clean copy, links it into the profile, enables it twice and prints INSTALL_OK', { skip }, () => {
  const f = fixture();
  try {
    const r = f.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /INSTALL_OK/);
    const dest = f.env.PLUGIN_DEST;
    assert.ok(fs.existsSync(path.join(dest, 'dashboard', 'manifest.json')));
    assert.ok(fs.existsSync(path.join(dest, 'dashboard', 'dist', 'index.js')));
    assert.ok(!fs.existsSync(path.join(dest, 'dashboard', '__pycache__')), 'no bytecode cache is installed');
    assert.ok(!fs.existsSync(path.join(dest, 'stray.pyc')));
    assert.equal(fs.readlinkSync(path.join(f.env.PROFILE_PLUGINS_DIR, 'resourcer')), dest);
    const calls = fs.readFileSync(f.log, 'utf8').split('\n').filter(Boolean);
    assert.ok(calls.includes('plugins enable resourcer'));
    assert.ok(calls.includes('-p resourcer plugins enable resourcer'));
    assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['resourcer']);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('an older install is moved aside, never deleted; a second run is repeatable', { skip }, () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    fs.writeFileSync(path.join(f.env.PLUGIN_DEST, 'marker.txt'), 'old install');
    const r = f.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /moved the previous install to .*resourcer\.old-\d{8}T\d{6}Z/);
    const aside = fs.readdirSync(path.dirname(f.env.PLUGIN_DEST)).filter((n) => n.startsWith('resourcer.old-'));
    assert.equal(aside.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(f.env.PLUGIN_DEST), aside[0], 'marker.txt'), 'utf8'), 'old install');
    assert.ok(!fs.existsSync(path.join(f.env.PLUGIN_DEST, 'marker.txt')), 'the new copy is clean');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('when hermes refuses to enable the plugin and no interpreter can write the config, it fails loudly', { skip }, () => {
  const f = fixture('case "$*" in *"plugins enable"*) exit 1;; esac');
  try {
    const r = f.run();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /INSTALL_FAILED could not enable the plugin/);
    assert.doesNotMatch(r.stdout, /INSTALL_OK/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('refuses to run from something that is not the plugin directory', { skip }, () => {
  const f = fixture();
  try {
    fs.rmSync(path.join(f.src, 'dashboard', 'manifest.json'));
    const r = f.run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /INSTALL_FAILED/);
    assert.ok(!fs.existsSync(f.env.PLUGIN_DEST));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('the installer and the README raise no approval trigger: no recursive delete, no find -exec, no command-line heredoc', () => {
  const sh = fs.readFileSync(SCRIPT, 'utf8');
  const readme = fs.readFileSync(path.join(PLUGIN, 'README.md'), 'utf8');
  for (const [name, text] of [['install-plugin.sh', sh], ['README.md', readme]]) {
    const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(code, /rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r|-exec\s/, `${name}: recursive delete or find -exec`);
  }
  assert.ok(!sh.includes('\r') && !/[^\x00-\x7f]/.test(sh));
});
