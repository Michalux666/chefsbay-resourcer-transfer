'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const PLUGIN = path.join(REPO, 'plugin', 'resourcer');
const DASH = path.join(PLUGIN, 'dashboard');
const BS = String.fromCharCode(92);

function listFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

const SHIPPED = [...listFiles(PLUGIN).filter((f) => !f.endsWith('.pyc') && !f.includes('__pycache__')), path.join(REPO, 'tools', 'request-search.js')];

test('manifest.json is strict JSON (no comments) with the fields Hermes reads', () => {
  const raw = fs.readFileSync(path.join(DASH, 'manifest.json'), 'utf8');
  assert.ok(!raw.startsWith('\uFEFF'));
  const m = JSON.parse(raw);
  assert.ok(!/^\s*\/\//m.test(raw), 'comments make the manifest invalid JSON');
  assert.equal(m.name, 'resourcer');
  assert.equal(m.label, 'Resourcer');
  assert.equal(m.entry, 'dist/index.js');
  assert.equal(m.css, 'dist/style.css');
  assert.equal(m.api, 'plugin_api.py');
  assert.ok(m.tab.path.startsWith('/'));
  assert.ok(!m.api.startsWith('/') && !m.api.includes('..'), 'api path must stay inside dashboard/');
  assert.ok(['Database', 'Activity', 'BarChart3'].includes(m.icon), 'icon must be one the SPA maps');
  assert.ok(!('override' in m.tab), 'must not replace a built-in tab');
});

test('directory name, plugin.yaml name and manifest name are identical (the CLI enable path depends on it)', () => {
  const yaml = fs.readFileSync(path.join(PLUGIN, 'plugin.yaml'), 'utf8');
  const name = /^name:\s*(\S+)\s*$/m.exec(yaml)[1];
  const manifest = JSON.parse(fs.readFileSync(path.join(DASH, 'manifest.json'), 'utf8'));
  assert.equal(name, manifest.name);
  assert.equal(path.basename(PLUGIN), manifest.name);
  for (const forbidden of ['requires_hermes', 'capabilities', 'python_dependencies', 'kind', 'pip_dependencies', 'requires_env']) {
    assert.ok(!new RegExp(`^${forbidden}:`, 'm').test(yaml), `${forbidden} must not be set`);
  }
  assert.match(yaml, /^version:/m);
  assert.match(yaml, /^description:/m);
});

test('__init__.py is a no-op register(ctx) so the agent loader accepts the plugin', () => {
  const src = fs.readFileSync(path.join(PLUGIN, '__init__.py'), 'utf8');
  assert.match(src, /def register\(ctx\):/);
  assert.ok(!/^\s*(import|from)\s/m.test(src), 'no imports: it must load on any interpreter');
});

test('every file the manifest points at exists and the API file is a single module', () => {
  for (const rel of ['dist/index.js', 'dist/style.css', 'plugin_api.py']) assert.ok(fs.existsSync(path.join(DASH, rel)), rel);
  const siblings = fs.readdirSync(DASH).filter((n) => n.endsWith('.py'));
  assert.deepEqual(siblings, ['plugin_api.py'], 'relative imports do not work under the Hermes loader');
});

test('assets use only extensions Hermes serves', () => {
  const served = new Set(['.js', '.mjs', '.css', '.json', '.html', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff2', '.woff', '.ttf', '.otf', '.map']);
  for (const f of listFiles(path.join(DASH, 'dist'))) assert.ok(served.has(path.extname(f)), f);
});

test('shipped plugin files and the CLI tool are ASCII with LF endings and free of banned tokens', () => {
  const banned = ['C:' + BS, 'C:/Users', 'ws' + 'l ', 'power' + 'shell', 'pw' + 'sh', 'open' + 'claw', 'pm' + '2', 'sch' + 'tasks', '187' + '89', 'WHATS' + 'APP', 'ng' + 'rok'];
  for (const f of SHIPPED) {
    const raw = fs.readFileSync(f);
    const rel = path.relative(REPO, f);
    assert.ok(!raw.includes(13), `${rel}: CR found`);
    assert.ok(raw.every((b) => b < 128), `${rel}: non-ASCII byte`);
    const text = raw.toString('ascii');
    assert.ok(!text.includes(BS + BS), `${rel}: double-backslash literal`);
    for (const token of banned) assert.ok(!text.includes(token), `${rel}: banned token ${token}`);
  }
});

test('the README documents install, enable, restart, verify and roll back with the real paths', () => {
  const readme = fs.readFileSync(path.join(PLUGIN, 'README.md'), 'utf8');
  for (const needle of ['/opt/data/plugins/resourcer', 'plugins.enabled', 'hermes plugins enable resourcer', '/api/plugins/resourcer/health', 'dashboard restart', 'RESOURCER_HOME', 'dashboard-settings.json', 'request-search.js']) {
    assert.ok(readme.includes(needle), `README is missing: ${needle}`);
  }
  assert.ok(!readme.includes('\uFEFF'));
});

test('no secrets, tokens or personal data in the plugin tree', () => {
  const patterns = [/sk-[A-Za-z0-9]{16,}/, /AKIA[0-9A-Z]{12,}/, /-----BEGIN [A-Z ]*PRIVATE KEY/, /[A-Za-z0-9._%+-]+@(?!example\.invalid)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, /\bBearer\s+[A-Za-z0-9._-]{16,}/];
  for (const f of SHIPPED) {
    const text = fs.readFileSync(f, 'utf8');
    for (const p of patterns) assert.ok(!p.test(text), `${path.relative(REPO, f)} matches ${p}`);
  }
});
