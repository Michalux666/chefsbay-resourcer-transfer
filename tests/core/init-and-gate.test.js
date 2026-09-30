'use strict';
// create-init-status.js (deterministic run-file ids, Europe/London stamp) and pending-gate.js
// (queue picking, claim stamping, the "no spawnedAt on hand-made files" rule).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/home');

const BOM = String.fromCharCode(0xFEFF);

function londonStamp(d) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const o = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return `${o.year}-${o.month}-${o.day}-${o.hour}${o.minute}`;
}

test.describe('create-init-status', () => {
  const cis = (home, args, env) => H.run('scripts/create-init-status.js', args, { home, env });
  const pendingFile = (home, obj, name = 'territory-1.json') => {
    const p = path.join(home, 'pending-searches', name);
    H.writeJson(p, obj);
    return p;
  };

  test('writes runs/phase1-<London yyyy-mm-dd-HHMM>.json and prints INIT_FILE:<path>', () => {
    const home = H.makeHome('cis');
    const p = pendingFile(home, { jobTitle: 'Chef', location: 'LS1', distance: 30, sources: 'both', requestedAt: '2026-09-29T08:00:00.000Z' });
    const before = londonStamp(new Date());
    const r = cis(home, [p]);
    const after = londonStamp(new Date());
    assert.equal(r.status, 0, r.stderr);
    const m = r.stdout.trim().match(/^INIT_FILE:(.+)$/);
    assert.ok(m, r.stdout);
    const file = m[1];
    assert.equal(path.dirname(file), path.join(home, 'runs'));
    const id = path.basename(file, '.json');
    assert.match(id, /^phase1-\d{4}-\d{2}-\d{2}-\d{4}$/);
    assert.ok([before, after].includes(id.slice('phase1-'.length)), `${id} vs ${before}/${after}`);
    const doc = H.readJson(file);
    assert.deepEqual(Object.keys(doc), ['id', 'status', 'jobTitle', 'location', 'distance', 'pool', 'startedAt', 'requestedAt', 'page', 'approved', 'skippedDb', 'errors', 'sources', 'updatedAt']);
    assert.equal(doc.id, id);
    assert.equal(doc.status, 'phase1_initializing');
    assert.equal(doc.jobTitle, 'Chef');
    assert.equal(doc.location, 'LS1');
    assert.equal(doc.distance, 30);
    assert.equal(doc.pool, null);
    assert.equal(doc.requestedAt, '2026-09-29T08:00:00.000Z');
    assert.equal(doc.page, 0);
    assert.equal(doc.approved, 0);
    assert.equal(doc.skippedDb, null);
    assert.equal(doc.errors, null);
    assert.equal(doc.sources, 'both');
    assert.equal(doc.startedAt, doc.updatedAt);
    assert.ok(!fs.readFileSync(file, 'utf8').startsWith(BOM), 'UTF-8 without BOM');
  });

  test('the stamp is Europe/London whatever the machine timezone is', () => {
    const home = H.makeHome('cis-tz');
    const p = pendingFile(home, { jobTitle: 'Chef', location: 'LS1' });
    const before = londonStamp(new Date());
    const r = cis(home, [p], { TZ: 'Pacific/Auckland' });
    const after = londonStamp(new Date());
    assert.equal(r.status, 0, r.stderr);
    const id = path.basename(r.stdout.trim().slice('INIT_FILE:'.length), '.json');
    assert.ok([before, after].includes(id.slice('phase1-'.length)), `${id} vs ${before}/${after}`);
  });

  test('defaults: distance 20, sources caterer, requestedAt = now', () => {
    const home = H.makeHome('cis-def');
    const p = pendingFile(home, { jobTitle: 'Chef', location: 'LS1' });
    const doc = H.readJson(cis(home, [p]).stdout.trim().slice('INIT_FILE:'.length));
    assert.equal(doc.distance, 20);
    assert.equal(doc.sources, 'caterer');
    assert.equal(doc.requestedAt, doc.startedAt);
  });

  test('never overwrites an existing status file: the same minute gets a -<sss><ms> suffix', () => {
    const home = H.makeHome('cis-col');
    const p = pendingFile(home, { jobTitle: 'Chef', location: 'LS1' });
    const files = new Set();
    for (let i = 0; i < 4; i++) {
      const r = cis(home, [p]);
      assert.equal(r.status, 0, r.stderr);
      files.add(r.stdout.trim().slice('INIT_FILE:'.length));
    }
    assert.equal(files.size, 4);
    assert.equal(fs.readdirSync(path.join(home, 'runs')).length, 4);
    const ids = [...files].map(f => path.basename(f, '.json'));
    assert.ok(ids.some(id => /^phase1-\d{4}-\d{2}-\d{2}-\d{4}-\d{5}$/.test(id)), ids.join(','));
  });

  test('a BOM in the pending file is tolerated', () => {
    const home = H.makeHome('cis-bom');
    const p = path.join(home, 'pending-searches', 'b.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, BOM + JSON.stringify({ jobTitle: 'Chef', location: 'LS1' }));
    assert.equal(cis(home, [p]).status, 0);
  });

  test('errors: exit 1 with ERROR:<reason> on stderr', () => {
    const home = H.makeHome('cis-err');
    let r = cis(home, []);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trim(), 'ERROR:missing pending-search file path argument');
    r = cis(home, [path.join(home, 'nope.json')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^ERROR:pending file not found: /);
    const bad = path.join(home, 'bad.json');
    fs.writeFileSync(bad, '{nope');
    r = cis(home, [bad]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^ERROR:cannot parse pending file: /);
    const noLoc = pendingFile(home, { jobTitle: 'Chef' }, 'noloc.json');
    r = cis(home, [noLoc]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trim(), 'ERROR:pending file missing jobTitle or location');
    assert.ok(!fs.existsSync(path.join(home, 'runs')) || fs.readdirSync(path.join(home, 'runs')).length === 0);
  });

  test('--help exits 0 without writing anything', () => {
    const home = H.makeHome('cis-help');
    const r = cis(home, ['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: node scripts\/create-init-status\.js/);
    assert.ok(!fs.existsSync(path.join(home, 'runs')));
  });
});

test.describe('pending-gate', () => {
  const gate = (home, args = []) => H.run('scripts/pending-gate.js', args, { home });
  const pend = (home, name, obj, raw) => {
    const p = path.join(home, 'pending-searches', name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, raw !== undefined ? raw : JSON.stringify(obj, null, 2));
    return p;
  };
  const gateJson = (r) => JSON.parse(r.stdout.trim());

  test('NO_WORK when there is no directory, no files, or only non-json files', () => {
    const home = H.makeHome('gate-none');
    let r = gate(home);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'NO_WORK');
    fs.mkdirSync(path.join(home, 'pending-searches'));
    assert.equal(gate(home).stdout.trim(), 'NO_WORK');
    fs.writeFileSync(path.join(home, 'pending-searches', 'notes.txt'), 'x');
    fs.writeFileSync(path.join(home, 'pending-searches', '.search-1.abc.tmp'), '{}');
    assert.equal(gate(home).stdout.trim(), 'NO_WORK');
  });

  test('READY names the oldest (alphabetical) file and reports queue depth', () => {
    const home = H.makeHome('gate-ready');
    pend(home, 'territory-2-20260929-0900.json', { jobTitle: 'Bar', location: 'M1', source: 'queue-due-territories-autocatchup', sources: 'reed' });
    pend(home, 'search-1759145000123-a3f1.json', { jobTitle: 'Chef', location: 'LS1', source: 'dashboard' });
    pend(home, 'territory-1-20260929-0900.json', { jobTitle: 'Cook', location: 'B1' });
    const r = gate(home);
    assert.equal(r.status, 0);
    const out = gateJson(r);
    assert.deepEqual(Object.keys(out), ['status', 'file', 'filePath', 'pending', 'queueDepth']);
    assert.equal(out.status, 'READY');
    assert.equal(out.file, 'search-1759145000123-a3f1.json');
    assert.equal(out.filePath, path.join(home, 'pending-searches', out.file));
    assert.equal(out.queueDepth, 3);
    assert.equal(out.pending.jobTitle, 'Chef');
  });

  test('the sources field defaults to caterer for territory-scheduler files and both otherwise', () => {
    const home = H.makeHome('gate-src');
    pend(home, 'a.json', { jobTitle: 'A', location: 'L1', source: 'territory-scheduler' });
    assert.equal(gateJson(gate(home)).pending.sources, 'caterer');
    fs.rmSync(path.join(home, 'pending-searches', 'a.json'));
    pend(home, 'b.json', { jobTitle: 'B', location: 'L1', source: 'dashboard' });
    assert.equal(gateJson(gate(home)).pending.sources, 'both');
    fs.rmSync(path.join(home, 'pending-searches', 'b.json'));
    pend(home, 'c.json', { jobTitle: 'C', location: 'L1', sources: 'reed' });
    assert.equal(gateJson(gate(home)).pending.sources, 'reed');
  });

  test('a hand-made file WITHOUT spawnedAt is picked up immediately', () => {
    const home = H.makeHome('gate-nospawn');
    pend(home, 'manual.json', { jobTitle: 'Chef', location: 'LS1' });
    const out = gateJson(gate(home));
    assert.equal(out.status, 'READY');
    assert.ok(!('spawnedAt' in out.pending));
  });

  test('a file with a recent spawnedAt is skipped; the next unspawned file is READY', () => {
    const home = H.makeHome('gate-recent');
    pend(home, 'a.json', { jobTitle: 'A', location: 'L1', spawnedAt: H.minsAgo(1) });
    let r = gate(home);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'SPAWNED:a.json');
    pend(home, 'b.json', { jobTitle: 'B', location: 'L2' });
    const out = gateJson(gate(home));
    assert.equal(out.file, 'b.json');
    assert.equal(out.queueDepth, 2);
    // the claimed file is left untouched
    assert.ok(H.readJson(path.join(home, 'pending-searches', 'a.json')).spawnedAt);
  });

  test('--mark-spawned stamps spawnedAt and the gate then reports SPAWNED', () => {
    const home = H.makeHome('gate-mark');
    pend(home, 'search-1.json', { jobTitle: 'Chef', location: 'LS1' });
    const before = Date.now();
    const r = gate(home, ['--mark-spawned', 'search-1.json']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'MARKED: search-1.json');
    const doc = H.readJson(path.join(home, 'pending-searches', 'search-1.json'));
    assert.equal(doc.jobTitle, 'Chef');
    const t = Date.parse(doc.spawnedAt);
    assert.ok(t >= before - 1000 && t <= Date.now() + 1000);
    assert.equal(gate(home).stdout.trim(), 'SPAWNED:search-1.json');
  });

  test('--mark-spawned on a missing file is silent and exits 0; on a corrupt file it reports and exits 0', () => {
    const home = H.makeHome('gate-mark2');
    fs.mkdirSync(path.join(home, 'pending-searches'), { recursive: true });
    let r = gate(home, ['--mark-spawned', 'ghost.json']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    pend(home, 'bad.json', null, '{nope');
    r = gate(home, ['--mark-spawned', 'bad.json']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /Failed to mark:/);
  });

  test('a stale claim (over 10 min, no active run) is released and the file is READY again', () => {
    const home = H.makeHome('gate-stale');
    pend(home, 'a.json', { jobTitle: 'A', location: 'L1', spawnedAt: H.minsAgo(11) });
    const r = gate(home);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /WARN: Stale spawn detected for a\.json \(11m old\) - re-queuing/);
    const out = gateJson(r);
    assert.equal(out.status, 'READY');
    assert.ok(!('spawnedAt' in out.pending));
    assert.ok(!('spawnedAt' in H.readJson(path.join(home, 'pending-searches', 'a.json'))), 'the claim is removed on disk');
  });

  test('a claim at the 10 minute boundary is still respected (9 min)', () => {
    const home = H.makeHome('gate-9');
    pend(home, 'a.json', { jobTitle: 'A', location: 'L1', spawnedAt: H.minsAgo(9) });
    assert.equal(gate(home).stdout.trim(), 'SPAWNED:a.json');
  });

  test('LOCKED:<run id> while a pipeline run is in flight, before any file is read', () => {
    const home = H.makeHome('gate-lock');
    pend(home, 'a.json', { jobTitle: 'A', location: 'L1' });
    H.writeJson(path.join(home, 'runs', 'phase1-2026-09-29-0900.json'), { id: 'phase1-2026-09-29-0900', status: 'phase1_running', updatedAt: new Date().toISOString() });
    const r = gate(home);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'LOCKED:phase1-2026-09-29-0900');
    // and it stops blocking once the run is stale
    H.writeJson(path.join(home, 'runs', 'phase1-2026-09-29-0900.json'), { id: 'phase1-2026-09-29-0900', status: 'phase1_running', updatedAt: H.minsAgo(90) });
    assert.equal(gateJson(gate(home)).status, 'READY');
  });

  test('a UTF-8 BOM is stripped from the file on read', () => {
    const home = H.makeHome('gate-bom');
    const p = pend(home, 'a.json', null, BOM + JSON.stringify({ jobTitle: 'A', location: 'L1' }));
    const r = gate(home);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /WARN: Stripped UTF-8 BOM from a\.json/);
    assert.equal(gateJson(r).pending.jobTitle, 'A');
    assert.ok(!fs.readFileSync(p, 'utf8').startsWith(BOM));
  });

  test('every file unparseable: ERROR:all_files_corrupt and exit 1; one good file among bad ones is READY', () => {
    const home = H.makeHome('gate-bad');
    pend(home, 'a.json', null, '{nope');
    pend(home, 'b.json', null, '');
    let r = gate(home);
    assert.equal(r.status, 1);
    assert.equal(r.stdout.trim(), 'ERROR:all_files_corrupt (2 parse failures)');
    pend(home, 'c.json', { jobTitle: 'C', location: 'L1' });
    r = gate(home);
    assert.equal(r.status, 0);
    assert.equal(gateJson(r).file, 'c.json');
    assert.match(r.stderr, /Failed to read a\.json/);
  });

  test('--help exits 0', () => {
    const home = H.makeHome('gate-help');
    const r = gate(home, ['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--mark-spawned/);
  });
});
