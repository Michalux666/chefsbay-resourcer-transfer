'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const TOOL = path.join(REPO, 'tools', 'request-search.js');
const tool = require(TOOL);
const VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'search-vectors.json'), 'utf8'));
const DUPES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'duplicate-cases.json'), 'utf8'));

const KEY_ORDER = ['jobTitle', 'location', 'keywords', 'priority', 'sources', 'distance', 'activeWithin', 'cvLimit', 'overrides', 'requestedAt', 'source'];
const FILE_RE = /^search-\d{13}-[0-9a-f]{6}\.json$/;
const BS = String.fromCharCode(92);

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-tool-'));
  for (const d of ['runs', 'pending-searches', 'logs', 'runtime', 'config']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'territory-defaults.json'), JSON.stringify({ distance: 20, activeWithin: '1 month', cvLimit: 20, priority: 'low', sources: 'both' }));
  return home;
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

function pendingNames(home) {
  return fs.readdirSync(path.join(home, 'pending-searches')).sort();
}

function canSymlink() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-sl-'));
  try {
    fs.symlinkSync(dir, path.join(dir, 'l'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const SYMLINKS = canSymlink();

function cli(args, env) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000 });
}

function cliAsync(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [TOOL, ...args], { env: { ...process.env, ...env } });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

// ---------------------------------------------------------------- shared vectors

for (const c of VECTORS.cases) {
  test(`vector: ${c.name}`, () => {
    const res = tool.validateSearch(c.input, c.defaults || VECTORS.defaults, c.mode || 'outward');
    if (c.ok) {
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.deepEqual(res.value, c.ok);
    } else {
      assert.equal(res.ok, false);
      assert.equal(res.field, c.error);
      assert.equal(res.status, 400);
      assert.ok(res.detail);
    }
  });
}

// ---------------------------------------------------------------- enqueue

test('writes exactly the documented file and nothing else', async () => {
  const home = makeHome();
  try {
    const now = new Date('2026-09-29T12:00:00.000Z');
    const r = await tool.enqueueSearch({ home, now, input: { jobTitle: 'sous chef', location: 'yo2', keywords: 'DBS', sources: 'caterer', priority: 'high', distance: 30, activeWithin: '3 months', cvLimit: 40 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.file, FILE_RE);
    assert.equal(r.body.queueDepthAfter, 1);
    assert.equal(r.body.position, 1);
    assert.deepEqual(pendingNames(home), [r.body.file]);
    const raw = fs.readFileSync(path.join(home, 'pending-searches', r.body.file), 'utf8');
    assert.ok(!raw.startsWith('\uFEFF') && !raw.includes('\r'));
    const data = JSON.parse(raw);
    assert.deepEqual(Object.keys(data), KEY_ORDER);
    assert.deepEqual(data, r.body.request);
    assert.equal(data.requestedAt, '2026-09-29T12:00:00.000Z');
    assert.equal(data.source, 'request-search-cli');
    assert.ok(!('spawnedAt' in data));
    assert.deepEqual(data.overrides, ['distance', 'activeWithin', 'cvLimit']);
    assert.equal(r.body.file.slice(0, 20), `search-${now.getTime()}-`.slice(0, 20));
  } finally { cleanup(home); }
});

test('validation failure writes nothing', async () => {
  const home = makeHome();
  try {
    const r = await tool.enqueueSearch({ home, input: { jobTitle: 'Chef', location: 'York' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, 'location');
    assert.deepEqual(pendingNames(home), []);
  } finally { cleanup(home); }
});

test('client bookkeeping fields are ignored', async () => {
  const home = makeHome();
  try {
    const r = await tool.enqueueSearch({ home, input: { jobTitle: 'Chef', location: 'LS1', spawnedAt: '2099-01-01T00:00:00.000Z', source: 'territory-scheduler', requestedAt: '1999-01-01T00:00:00.000Z', overrides: ['x'] } });
    assert.equal(r.status, 200);
    const data = JSON.parse(fs.readFileSync(path.join(home, 'pending-searches', r.body.file), 'utf8'));
    assert.deepEqual(Object.keys(data), KEY_ORDER);
    assert.equal(data.source, 'request-search-cli');
    assert.deepEqual(data.overrides, []);
  } finally { cleanup(home); }
});

test('defaults come from config/territory-defaults.json and settings from dashboard-settings.json', async () => {
  const home = makeHome();
  try {
    fs.writeFileSync(path.join(home, 'config', 'territory-defaults.json'), JSON.stringify({ distance: 30, activeWithin: '2 months', cvLimit: 30, priority: 'medium', sources: 'caterer' }));
    const r = await tool.enqueueSearch({ home, input: { jobTitle: 'Chef', location: 'M1' } });
    assert.deepEqual([r.body.request.distance, r.body.request.activeWithin, r.body.request.cvLimit, r.body.request.priority, r.body.request.sources], [30, '2 months', 30, 'medium', 'caterer']);
    assert.deepEqual(r.body.request.overrides, []);
    fs.writeFileSync(path.join(home, 'config', 'dashboard-settings.json'), JSON.stringify({ location_mode: 'any' }));
    const place = await tool.enqueueSearch({ home, input: { jobTitle: 'Head Chef', location: 'Harrogate' } });
    assert.equal(place.status, 200);
    assert.equal(place.body.request.location, 'HARROGATE');
    fs.writeFileSync(path.join(home, 'config', 'dashboard-settings.json'), JSON.stringify({ location_mode: 'bogus' }));
    const strict = await tool.enqueueSearch({ home, input: { jobTitle: 'Pastry Chef', location: 'Ripon' } });
    assert.equal(strict.status, 400);
    fs.writeFileSync(path.join(home, 'config', 'territory-defaults.json'), JSON.stringify({ distance: 17, cvLimit: 999, priority: 'urgent', sources: 'x' }));
    const bad = await tool.enqueueSearch({ home, input: { jobTitle: 'Kitchen Porter', location: 'M2' } });
    assert.deepEqual([bad.body.request.distance, bad.body.request.cvLimit, bad.body.request.priority, bad.body.request.sources], [20, 20, 'low', 'both']);
  } finally { cleanup(home); }
});

test('position counts unclaimed files ahead and search names sort first', async () => {
  const home = makeHome();
  try {
    fs.writeFileSync(path.join(home, 'pending-searches', 'territory-9-20260929-0800.json'), JSON.stringify({ jobTitle: 'A', location: 'B1' }));
    fs.writeFileSync(path.join(home, 'pending-searches', 'search-1000000000000-aaaaaa.json'), JSON.stringify({ jobTitle: 'C', location: 'B2', spawnedAt: new Date().toISOString() }));
    const r = await tool.enqueueSearch({ home, input: { jobTitle: 'Sous Chef', location: 'YO2' } });
    assert.equal(r.body.position, 1);
    assert.equal(r.body.queueDepthAfter, 3);
    const names = [tool.newSearchFilename(new Date(2000)), 'territory-1-20260929-0800.json', tool.newSearchFilename(new Date(1000))].sort();
    assert.ok(names[0].startsWith('search-') && names[1].startsWith('search-') && names[2].startsWith('territory-'));
    assert.ok(names[0] < names[1]);
  } finally { cleanup(home); }
});

test('a halted pipeline is reported but the request is accepted', async () => {
  const home = makeHome();
  try {
    fs.writeFileSync(path.join(home, 'runtime', 'pipeline-halt.json'), JSON.stringify({ halted: true, reason: 'screening down' }));
    const r = await tool.enqueueSearch({ home, input: { jobTitle: 'Chef', location: 'M1' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.pipelineHalted, true);
    assert.match(r.body.note, /halted/i);
  } finally { cleanup(home); }
});

// ---------------------------------------------------------------- shared duplicate cases

function materialise(home, files, now) {
  const conv = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === '$agoMin') return new Date(now.getTime() - v.$agoMin * 60000).toISOString();
      return Object.fromEntries(keys.map((k) => [k, conv(v[k])]));
    }
    if (Array.isArray(v)) return v.map(conv);
    return v;
  };
  for (const f of files) {
    const p = path.join(home, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.text !== undefined ? f.text : JSON.stringify(conv(f.json)));
    if (f.mtimeAgoMin !== undefined) {
      const t = new Date(now.getTime() - f.mtimeAgoMin * 60000);
      fs.utimesSync(p, t, t);
    }
  }
}

for (const c of DUPES.cases) {
  test(`duplicate case: ${c.name}`, async () => {
    const home = makeHome();
    try {
      const now = new Date(DUPES.now);
      materialise(home, c.files, now);
      const r = await tool.enqueueSearch({ home, now, input: { ...DUPES.request } });
      assert.equal(r.status, c.expect.status, JSON.stringify(r.body));
      if (r.status === 409) {
        assert.equal(r.body.error, 'already_queued');
        assert.equal(r.body.existing.where, c.expect.where);
        if (c.expect.file) assert.equal(r.body.file, c.expect.file);
      } else {
        assert.equal(r.body.ok, true);
        assert.equal(r.body.request.requestedAt, now.toISOString());
      }
    } finally { cleanup(home); }
  });
}

// ---------------------------------------------------------------- atomic writes and locks

test('temp files are dotfiles that never end in .json and the final file is complete', () => {
  const home = makeHome();
  try {
    const dir = path.join(home, 'pending-searches');
    const real = fs.fsyncSync;
    const seen = [];
    fs.fsyncSync = (fd) => { seen.push(fs.readdirSync(dir).filter((n) => n.endsWith('.json'))); return real(fd); };
    let name;
    try { name = tool.writeNewFileAtomic(dir, () => 'x.json', '{"a":1}'); } finally { fs.fsyncSync = real; }
    assert.equal(name, 'x.json');
    assert.deepEqual(seen[0], []);
    assert.deepEqual(fs.readdirSync(dir), ['x.json']);
    assert.equal(fs.readFileSync(path.join(dir, 'x.json'), 'utf8'), '{"a":1}');
  } finally { cleanup(home); }
});

test('writeNewFileAtomic never overwrites an existing file', () => {
  const home = makeHome();
  try {
    const dir = path.join(home, 'd');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.json'), 'original');
    const names = ['a.json', 'b.json'];
    assert.equal(tool.writeNewFileAtomic(dir, () => names.shift(), 'new'), 'b.json');
    assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), 'original');
    assert.throws(() => tool.writeNewFileAtomic(dir, () => 'a.json', 'x'), /unique file name/);
    assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['a.json', 'b.json']);
  } finally { cleanup(home); }
});

test('writeNewFileAtomic falls back to rename when hard links are unsupported', () => {
  const home = makeHome();
  try {
    const dir = path.join(home, 'd');
    fs.mkdirSync(dir);
    const real = fs.linkSync;
    fs.linkSync = () => { const e = new Error('nope'); e.code = 'EPERM'; throw e; };
    try { assert.equal(tool.writeNewFileAtomic(dir, () => 'c.json', 'hello'), 'c.json'); } finally { fs.linkSync = real; }
    assert.equal(fs.readFileSync(path.join(dir, 'c.json'), 'utf8'), 'hello');
    assert.deepEqual(fs.readdirSync(dir), ['c.json']);
  } finally { cleanup(home); }
});

test('concurrent identical requests in one process produce one file', async () => {
  const home = makeHome();
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => tool.enqueueSearch({ home, input: { jobTitle: 'Sous Chef', location: 'YO2' } })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409, 409, 409]);
    assert.equal(pendingNames(home).length, 1);
  } finally { cleanup(home); }
});

test('concurrent distinct requests all succeed with unique names', async () => {
  const home = makeHome();
  try {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => tool.enqueueSearch({ home, input: { jobTitle: `Chef ${i}`, location: 'YO2' } })));
    assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.body)));
    const names = pendingNames(home);
    assert.equal(names.length, 10);
    assert.equal(new Set(names).size, 10);
    assert.ok(names.every((n) => FILE_RE.test(n)));
  } finally { cleanup(home); }
});

test('separate CLI processes racing on the same request queue exactly one', async () => {
  const home = makeHome();
  try {
    const results = await Promise.all(Array.from({ length: 6 }, () => cliAsync(['--job', 'Sous Chef', '--location', 'YO2'], { RESOURCER_HOME: home })));
    const codes = results.map((r) => r.code).sort();
    assert.deepEqual(codes, [0, 3, 3, 3, 3, 3], JSON.stringify(results));
    assert.equal(pendingNames(home).length, 1);
  } finally { cleanup(home); }
});

test('a stale lock is taken over and a fresh lock makes the call fail with LOCK_BUSY', async () => {
  const home = makeHome();
  try {
    const lock = path.join(home, 'pending-searches', '.request-search.lock');
    fs.writeFileSync(lock, '1 1');
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(lock, old, old);
    const ok = await tool.enqueueSearch({ home, input: { jobTitle: 'Chef', location: 'M1' } });
    assert.equal(ok.status, 200);
    assert.ok(!fs.existsSync(lock));
    fs.writeFileSync(lock, '1 1');
    await assert.rejects(tool.enqueueSearch({ home, input: { jobTitle: 'Head Chef', location: 'M2' }, lockWaitMs: 150 }), (e) => e.code === 'LOCK_BUSY');
    assert.ok(fs.existsSync(lock));
    const out = []; const errs = [];
    const code = await tool.main(['--job', 'Head Chef', '--location', 'M2'], { env: { RESOURCER_HOME: home }, out: (s) => out.push(s), err: (s) => errs.push(s), lockWaitMs: 100 });
    assert.equal(code, 4);
    assert.match(errs.join('\n'), /another search request/);
  } finally { cleanup(home); }
});

test('a writer only removes its own lock file', async () => {
  const home = makeHome();
  try {
    const dir = path.join(home, 'pending-searches');
    const lock = path.join(dir, '.request-search.lock');
    const out = await tool.withDirLock(dir, async () => { fs.writeFileSync(lock, '999 1 someone-elses-token'); return 'done'; });
    assert.equal(out, 'done');
    assert.equal(fs.readFileSync(lock, 'utf8'), '999 1 someone-elses-token');
    fs.rmSync(lock);
    await tool.withDirLock(dir, async () => { assert.ok(fs.existsSync(lock)); });
    assert.ok(!fs.existsSync(lock));
  } finally { cleanup(home); }
});

// ---------------------------------------------------------------- jail

test('jailPath refuses escapes and secret-looking names', () => {
  const home = makeHome();
  try {
    const root = fs.realpathSync(home);
    for (const bad of ['../x', 'runs/../../x', '/etc/passwd', '..', 'C:foo', 'D:/x', BS + 'windows', 'runs' + BS + '..' + BS + '..' + BS + 'x']) {
      assert.throws(() => tool.jailPath(home, bad), tool.JailError, bad);
    }
    assert.throws(() => tool.jailPath(home, 'runs', '..', '..', 'x'), tool.JailError);
    assert.throws(() => tool.jailPath(home, 'runs', '/abs'), tool.JailError);
    assert.throws(() => tool.jailPath(home, 'runs', 'a\0b'), tool.JailError);
    for (const name of ['.env', '.env.local', 'auth.json', 'state.db', 'caterer-credentials.json', 'caterer-session.json', 'reed-session.json', 'id_rsa', 'server.pem', 'api.key']) {
      assert.throws(() => tool.jailPath(home, name), tool.JailError, name);
      assert.throws(() => tool.jailPath(home, 'runs', name), tool.JailError, name);
    }
    for (const dir of ['secrets', 'state', '.ssh', '.git', 'SECRETS']) {
      assert.throws(() => tool.jailPath(home, dir), tool.JailError, dir);
      assert.throws(() => tool.jailPath(home, 'runs', dir, 'x'), tool.JailError, dir);
    }
    assert.equal(tool.jailPath(home, 'runs'), path.join(root, 'runs'));
    assert.equal(tool.jailPath(home, 'runs/phase1-x.json'), path.join(root, 'runs', 'phase1-x.json'));
    assert.equal(tool.jailPath(home, 'does', 'not', 'exist.json'), path.join(root, 'does', 'not', 'exist.json'));
    for (const ok of [['candidates.db'], ['runtime', 'pipeline-halt.json'], ['config', 'dashboard-settings.json'], ['reed-auth-failed.marker']]) {
      tool.jailPath(home, ...ok);
    }
  } finally { cleanup(home); }
});

test('symlink escapes are refused', { skip: !SYMLINKS && 'symlinks need privileges on this host' }, async () => {
  const home = makeHome();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-out-'));
  try {
    fs.rmSync(path.join(home, 'pending-searches'), { recursive: true });
    fs.symlinkSync(outside, path.join(home, 'pending-searches'), 'dir');
    assert.throws(() => tool.jailPath(home, 'pending-searches'), tool.JailError);
    await assert.rejects(tool.enqueueSearch({ home, input: { jobTitle: 'Chef', location: 'M1' } }), tool.JailError);
    assert.deepEqual(fs.readdirSync(outside), []);
    const code = await tool.main(['--job', 'Chef', '--location', 'M1'], { env: { RESOURCER_HOME: home }, out: () => {}, err: () => {} });
    assert.equal(code, 4);
    fs.mkdirSync(path.join(home, 'secrets'));
    fs.rmSync(path.join(home, 'runs'), { recursive: true });
    fs.symlinkSync(path.join(home, 'secrets'), path.join(home, 'runs'), 'dir');
    assert.throws(() => tool.jailPath(home, 'runs', 'x.json'), tool.JailError);
  } finally { cleanup(home); cleanup(outside); }
});

test('resolveHome prefers RESOURCER_HOME, then the shared paths library', () => {
  assert.equal(tool.resolveHome({ RESOURCER_HOME: '/tmp/x-home' }), path.resolve('/tmp/x-home'));
  const fallback = tool.resolveHome({});
  assert.ok(fallback === path.join(REPO, 'resourcer') || fallback === '/opt/data/profiles/resourcer/workspace/resourcer', fallback);
});

// ---------------------------------------------------------------- CLI

test('--help prints usage and exits 0', () => {
  const r = cli(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: node tools\/request-search.js/);
  assert.match(r.stdout, /Exit codes:/);
});

test('CLI exit codes: queued 0, validation 2, duplicate 3, unknown option 2, dry run writes nothing', () => {
  const home = makeHome();
  try {
    const env = { RESOURCER_HOME: home };
    const dry = cli(['--job', 'Sous Chef', '--location', 'yo2', '--dry-run'], env);
    assert.equal(dry.status, 0);
    assert.match(dry.stdout, /VALID: Sous Chef \| YO2/);
    assert.deepEqual(pendingNames(home), []);
    const ok = cli(['--job', 'Sous Chef', '--location', 'yo2', '--distance', '30', '--json'], env);
    assert.equal(ok.status, 0, ok.stderr);
    const body = JSON.parse(ok.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.request.distance, 30);
    assert.deepEqual(pendingNames(home), [body.file]);
    const dup = cli(['--job', 'sous chef', '--location', 'YO2'], env);
    assert.equal(dup.status, 3);
    assert.match(dup.stderr, /DUPLICATE/);
    const bad = cli(['--job', 'Chef', '--location', 'York'], env);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /location/);
    const badDistance = cli(['--job', 'Chef', '--location', 'M1', '--distance', '15'], env);
    assert.equal(badDistance.status, 2);
    const unknown = cli(['--job', 'Chef', '--location', 'M1', '--bogus'], env);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown option/);
    const missing = cli(['--job'], env);
    assert.equal(missing.status, 2);
    const nothing = cli([], env);
    assert.equal(nothing.status, 2);
    assert.equal(pendingNames(home).length, 1);
    const jsonErr = cli(['--job', 'Chef', '--location', 'York', '--json'], env);
    assert.equal(jsonErr.status, 2);
    assert.equal(JSON.parse(jsonErr.stdout).field, 'location');
  } finally { cleanup(home); }
});

test('CLI --location-mode any accepts a full postcode and --home overrides the environment', () => {
  const home = makeHome();
  try {
    const r = cli(['--job', 'Chef', '--location', 'ls1 4ab', '--location-mode', 'any', '--home', home, '--json'], { RESOURCER_HOME: '/definitely/not/here' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).request.location, 'LS1 4AB');
    assert.equal(cli(['--job', 'Chef', '--location', 'M1', '--location-mode', 'sideways', '--home', home]).status, 2);
  } finally { cleanup(home); }
});

test('the repo pending gate accepts the file and offers a dashboard request first', () => {
  const gate = path.join(REPO, 'resourcer', 'scripts', 'pending-gate.js');
  if (!fs.existsSync(gate)) return;
  const home = makeHome();
  try {
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(home, 'pending-searches', `territory-${i}-20260929-0800.json`), JSON.stringify({ jobTitle: `Chef ${i}`, location: `B${i + 1}`, sources: 'caterer' }));
    const q = cli(['--job', 'Sous Chef', '--location', 'YO2', '--json'], { RESOURCER_HOME: home });
    assert.equal(q.status, 0, q.stderr);
    const g = spawnSync(process.execPath, [gate], { encoding: 'utf8', env: { ...process.env, RESOURCER_HOME: home }, timeout: 60000 });
    assert.equal(g.status, 0, g.stderr);
    const ready = JSON.parse(g.stdout);
    assert.equal(ready.status, 'READY');
    assert.equal(ready.file, JSON.parse(q.stdout).file);
    assert.equal(ready.pending.jobTitle, 'Sous Chef');
    assert.equal(ready.pending.sources, 'both');
    assert.ok(!('spawnedAt' in ready.pending));
    assert.equal(ready.queueDepth, 4);
  } finally { cleanup(home); }
});

test('a queued request survives being read back with a BOM-tolerant reader', async () => {
  const home = makeHome();
  try {
    fs.writeFileSync(path.join(home, 'pending-searches', 'search-1000000000000-aaaaaa.json'), '\uFEFF' + JSON.stringify({ jobTitle: 'Sous Chef', location: 'YO2' }));
    const r = await tool.enqueueSearch({ home, input: { jobTitle: 'Sous Chef', location: 'YO2' } });
    assert.equal(r.status, 409);
  } finally { cleanup(home); }
});

// ---------------------------------------------------------------- static rules

test('tool source is ASCII, LF only, has a shebang and no banned tokens', () => {
  const raw = fs.readFileSync(TOOL);
  assert.ok(!raw.includes(13), 'CR found');
  assert.ok(raw.every((b) => b < 128), 'non-ASCII byte found');
  const text = raw.toString('ascii');
  assert.ok(text.startsWith('#!/usr/bin/env node'));
  assert.ok(!text.includes(BS + BS));
  const banned = ['C:' + BS,'C:/Users', 'ws' + 'l ', 'power' + 'shell', 'pw' + 'sh', 'open' + 'claw', 'pm' + '2', 'sch' + 'tasks', '187' + '89', 'WHATS' + 'APP', 'ng' + 'rok'];
  for (const token of banned) assert.ok(!text.includes(token), token);
  assert.ok(!/process\.exit\(/.test(text.replace(/\/\*[\s\S]*?\*\//g, '')), 'library code must not call process.exit');
});

// ---------------------------------------------------------------- queue cap (credits are paid per unlock)

function dropPending(home, n, source, extra) {
  for (let i = 0; i < n; i++) {
    const data = { jobTitle: `Role ${source} ${i}`, location: `LS${(i % 90) + 1}`, source, requestedAt: new Date().toISOString(), ...(extra || {}) };
    fs.writeFileSync(path.join(home, 'pending-searches', `${source}-${String(i).padStart(3, '0')}.json`), JSON.stringify(data));
  }
}

test('the CLI turns the 26th waiting manual search away (status 429, exit 4); scheduled and claimed files do not count', async () => {
  const home = makeHome();
  try {
    dropPending(home, 40, 'territory-scheduler');
    dropPending(home, 10, 'dashboard', { spawnedAt: new Date().toISOString() });
    dropPending(home, 24, 'request-search-cli');
    const before = pendingNames(home);
    const ok = await tool.enqueueSearch({ home, input: { jobTitle: 'Fresh Title', location: 'M1' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const full = await tool.enqueueSearch({ home, input: { jobTitle: 'Another Title', location: 'M2' } });
    assert.equal(full.status, 429);
    assert.equal(full.body.error, 'queue_full');
    assert.equal(full.body.waiting, 25);
    assert.equal(full.body.limit, 25);
    assert.equal(pendingNames(home).length, before.length + 1, 'nothing more is written once the queue is full');
    const dry = await tool.enqueueSearch({ home, dryRun: true, input: { jobTitle: 'Third Title', location: 'M3' } });
    assert.equal(dry.status, 429, 'a dry run reports the same refusal');
    const res = cli(['--job', 'Fourth Title', '--location', 'M4'], { RESOURCER_HOME: home });
    assert.equal(res.status, 4);
    assert.match(res.stderr, /25 manual searches are already waiting/);
  } finally { cleanup(home); }
});
