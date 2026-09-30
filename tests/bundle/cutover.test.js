'use strict';
// make-bundle cutover safety: the run-history backfill and the end-of-build fence recheck. Fake data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./_helpers');
const MB = require('../../tools/make-bundle.js');

const { F, FAKE } = H;

const shared = {};
test.before(() => {
  shared.root = H.mkTmp('cut-');
  shared.src = H.buildFakeLegacy(path.join(shared.root, 'legacy'));
});
test.after(() => H.rmTmp(shared.root));

function iso(daysAgo) {
  return new Date(Date.now() - daysAgo * 86400000).toISOString();
}

function writeResults(dir, n, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i += 1) {
    const day = i % 5;
    const stamp = iso(day).replace(/[:.]/g, '-').slice(0, 19);
    const results = {
      date: iso(day).slice(0, 10), completedAt: iso(day), startedAt: iso(day), jobTitle: `Fake Role ${i % 3}`, location: `ZZ${i}`, distance: 20,
      sources: 'caterer', new: 2 + (i % 3), duplicates: 1, skipped: 0, errors: 0, total: 3, downloaded: 3,
      phase1: { pagesScraped: 2, approved: 3 }, candidates: [{ id: '1', name: 'Fake Person', email: 'fake@example.invalid', status: 'new' }],
    };
    fs.writeFileSync(path.join(dir, `phase2-results-${stamp}-${i}.json`), JSON.stringify(results));
  }
  if (opts.corrupt) fs.writeFileSync(path.join(dir, 'phase2-results-corrupt.json'), '{ not json');
  fs.writeFileSync(path.join(dir, 'cv-1.pdf'), 'FAKE CV DATA');
}

test('--backfill-run-history puts run_results into the bundle copy, prints a per-day parity table, and never touches the legacy database', () => {
  const dl = path.join(shared.root, 'downloads1');
  writeResults(dl, 12, { corrupt: true });
  const out = path.join(shared.root, 'b1', 'b1.enc');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const before = H.snapshotTree(shared.src);
  const r = H.make(shared.src, out, ['--backfill-run-history', dl]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /run history: files=13 parsed=12 unreadable=1 undated=0 inserted=12 total_rows=12/);
  assert.match(r.stdout, /\d{4}-\d{2}-\d{2}  files\(new\)= *\d+  run_results\(new\)= *\d+/);
  assert.doesNotMatch(r.stdout, /MISMATCH/);
  H.assertNoSecrets(assert, r.all, 'make output');
  assert.ok(!r.all.includes('Fake Person') && !r.all.includes('fake@example.invalid'), 'no candidate data in the output');
  assert.deepEqual(H.snapshotTree(shared.src), before, 'the legacy workspace and its database are untouched');

  const { manifest } = H.readManifest(out);
  assert.equal(manifest.db.tables.run_results, 12);
  const V = H.verify(out);
  assert.equal(V.status, 0, V.all);
  assert.match(V.stdout, /run_results=12/);

  const home = path.join(shared.root, 'home1');
  const R = H.restore(out, home);
  assert.equal(R.status, 0, R.all);
  const info = F.inspectDatabase(H.sqlite(), { file: path.join(home, 'candidates.db') });
  assert.equal(info.tables.run_results, 12);
  const db = new (H.sqlite())(path.join(home, 'candidates.db'), { readonly: true });
  try {
    const cols = db.prepare('PRAGMA table_info(run_results)').all().map((c) => c.name);
    assert.ok(cols.includes('new_to_zoho') && cols.includes('caterer_json'));
    const stored = JSON.stringify(db.prepare('SELECT * FROM run_results').all());
    assert.ok(!stored.includes('Fake Person') && !stored.includes('fake@example.invalid'), 'counts only, never candidate rows');
  } finally { db.close(); }
});

test('--backfill-run-history: a missing folder is a source error, an empty one only a warning', () => {
  const out = path.join(shared.root, 'b2', 'b2.enc');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const missing = H.make(shared.src, out, ['--backfill-run-history', path.join(shared.root, 'nope')]);
  assert.equal(missing.status, 5, missing.all);
  assert.match(missing.stderr, /folder not found/);
  assert.ok(!fs.existsSync(out));
  const empty = path.join(shared.root, 'downloads-empty');
  fs.mkdirSync(empty);
  const r = H.make(shared.src, out, ['--backfill-run-history', empty]);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stderr, /no phase2-results files were found/);
  assert.equal(H.readManifest(out).manifest.db.tables.run_results, 0);
});

function ioCapture() {
  const lines = [];
  return { lines, warn: (m) => lines.push(String(m)), log: (m) => lines.push(String(m)) };
}

function fenceFixture(name) {
  const src = H.buildFakeLegacy(path.join(shared.root, name));
  const Database = H.sqlite();
  const dbFile = path.join(src, 'candidates.db');
  const pre = F.inspectDatabase(Database, { file: dbFile });
  fs.mkdirSync(path.join(src, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(src, 'runtime', 'pipeline-halt.json'), JSON.stringify({ reason: 'migration', since: iso(0) }));
  return { src, Database, dbFile, pre };
}

test('fence recheck: a quiet source passes; a cleared halt, a new run or a database write after the snapshot refuse with --require-fence', () => {
  const fx = fenceFixture('fence1');
  const io = ioCapture();
  MB.recheckFence(io, { requireFence: true }, fx.src, fx.dbFile, fx.Database, fx.pre, false);
  assert.deepEqual(io.lines, []);

  fs.rmSync(path.join(fx.src, 'runtime', 'pipeline-halt.json'));
  assert.throws(() => MB.recheckFence(io, { requireFence: true }, fx.src, fx.dbFile, fx.Database, fx.pre, false), (e) => e.exitCode === F.EXIT.REFUSED && /halt was cleared/.test(e.message) && /stop the legacy supervisor/.test(e.message));
  MB.recheckFence(io, { requireFence: false }, fx.src, fx.dbFile, fx.Database, fx.pre, false);
  assert.deepEqual(io.lines, [], 'without --require-fence a missing halt is no problem');
  fs.writeFileSync(path.join(fx.src, 'runtime', 'pipeline-halt.json'), '{}');

  fs.mkdirSync(path.join(fx.src, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(fx.src, 'runs', 'phase1-2026-09-30-000000.json'), JSON.stringify({ status: 'phase1_running', updatedAt: iso(0) }));
  assert.throws(() => MB.recheckFence(ioCapture(), { requireFence: true }, fx.src, fx.dbFile, fx.Database, fx.pre, false), /pipeline run started/);
  MB.recheckFence(ioCapture(), { requireFence: true }, fx.src, fx.dbFile, fx.Database, fx.pre, true);
  fs.rmSync(path.join(fx.src, 'runs', 'phase1-2026-09-30-000000.json'));

  const db = new fx.Database(fx.dbFile);
  try { db.prepare("INSERT INTO candidates (caterer_id, source, created_at) VALUES (999001, 'caterer', '2026-09-30 01:00:00')").run(); } finally { db.close(); }
  assert.throws(() => MB.recheckFence(ioCapture(), { requireFence: true }, fx.src, fx.dbFile, fx.Database, fx.pre, false), (e) => e.exitCode === F.EXIT.REFUSED && /database changed after the snapshot/.test(e.message));
  const soft = ioCapture();
  MB.recheckFence(soft, { requireFence: false }, fx.src, fx.dbFile, fx.Database, fx.pre, false);
  assert.ok(soft.lines.some((l) => /warning: .*database changed after the snapshot/.test(l)), 'without --require-fence it only warns');
});

test('--require-fence end to end: a halt file that is present and a quiet database build a bundle', () => {
  const fx = fenceFixture('fence2');
  const out = path.join(shared.root, 'b3', 'b3.enc');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = H.make(fx.src, out, ['--require-fence']);
  assert.equal(r.status, 0, r.all);
  assert.match(r.stdout, /BUNDLE_OK/);
  assert.ok(FAKE.passphrase);
});
