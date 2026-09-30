'use strict';
// SCENARIO 10 - what is left on disk after the run, the maintenance job and the retention sweep. Personal data of the synthetic
// people (names, e-mails, phones, CV text, snippet text) is planted with greppable markers; the whole simulated profile is
// searched for them before and after. Time passing is modelled by moving file times and the recorded completion times back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { World } = require('./lib/world');
const D = require('./lib/data');
const C = require('./lib/checks');
const U = require('./lib/util');

const w = new World('s10-retention');
const DAY = 86400000;

const age = (rel, days) => { const t = (Date.now() - days * DAY) / 1000; fs.utimesSync(w.p(rel), t, t); };
function hashTree(rel) {
  const h = crypto.createHash('sha256');
  for (const f of U.walk(w.p(rel)).sort()) { h.update(path.relative(w.p(rel), f)); h.update(fs.readFileSync(f)); }
  return h.digest('hex');
}
const ALLOWED_BEFORE = [
  { re: /workspace\/resourcer\/downloads\/(approved-queue|phase2-results)-[^/]*\.json$/, kinds: ['name', 'surname', 'email', 'phone'] },
  { re: /workspace\/resourcer\/downloads\/candidate-\d+\.json$/, kinds: ['name', 'surname', 'email', 'phone'] },
  { re: /workspace\/resourcer\/downloads\/cv-\d+\.\w+$/, kinds: ['name', 'surname', 'email', 'phone', 'cv', 'snippet'] },
  { re: /workspace\/resourcer\/shadow\/screening-[^/]*\.jsonl$/, kinds: ['snippet'] },
];

test.before(async () => {
  await w.create({});
  w.warmLoggedIn();
  w.svc.zoho.state.dupKeys.add('71000010');
  w.svc.zoho.state.mode.perKey['71000005'] = { attach: 'fail' };
  w.dropPending({});
  await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json') && w.pipelineProcs().length === 0, { maxTicks: 12, tickMin: 1 });
});
test.after(async () => { await w.close(); });

test('10.1 right after the run: personal data only where the design keeps it, a failed CV attach keeps that one CV for its retry window', () => {
  assert.equal(w.lastRun().exitCode, 0);
  const left = w.list('downloads').filter((n) => /^(cv-|candidate-)/.test(n)).sort();
  assert.deepEqual(left, ['candidate-71000005.json', 'cv-71000005.docx'], 'only the candidate whose attach failed');
  assert.ok(w.alerts().some((a) => a.key === 'cv-attach-failed' && a.severity === 'warn'));
  const hits = C.personHits(w, ALLOWED_BEFORE);
  assert.deepEqual(hits, [], C.fmtHits(hits));
  for (const f of ['secrets', 'state']) assert.equal(C.modeOf(w.p(f)) & 0o077, f === 'secrets' ? 0 : C.modeOf(w.p(f)) & 0o077);
});

test('10.2 a sweep straight after the run removes only what is never allowed to stay (review-tmp, stale screening input) and keeps the rest', async () => {
  // legacy leftovers that must never survive: a review-tmp file with a snippet and a name, a stale screening input
  fs.writeFileSync(w.p('downloads', 'review-tmp-legacy.json'), JSON.stringify({ snippet: `${D.person(1).first} ${D.person(1).snippetMarker}` }));
  fs.mkdirSync(w.p('runtime', 'screening-input'), { recursive: true });
  fs.writeFileSync(w.p('runtime', 'screening-input', 'stale.json'), JSON.stringify({ snippet: D.person(2).snippetMarker }));
  age('runtime/screening-input/stale.json', 0.2);
  const m = await w.cron('resourcer-maintenance');
  const r = await w.cron('resourcer-retention');
  assert.deepEqual([m.code, m.stdout, r.code, r.stdout], [0, '', 0, '']);
  assert.equal(w.exists('downloads/review-tmp-legacy.json'), false, 'review-tmp is always removed');
  assert.equal(w.exists('runtime/screening-input/stale.json'), false, 'a screening input older than an hour is removed');
  assert.equal(w.list('downloads', /^(approved-queue|phase2-results)-/).length, 2, 'a fresh queue and result file stay');
  assert.deepEqual(w.list('downloads').filter((n) => /^(cv-|candidate-)/.test(n)).sort(), ['candidate-71000005.json', 'cv-71000005.docx']);
  assert.equal(w.dbAll('select count(*) n from run_results')[0].n, 1);
});

test('10.3 days later: queue and result files, the retried CV, orphans, logs and run records are swept by their rules; the database keeps the record', async () => {
  // orphans and a young CV that is not yet due
  fs.writeFileSync(w.p('downloads', 'cv-99999.pdf'), Buffer.alloc(300, 0x25));
  fs.writeFileSync(w.p('downloads', 'candidate-99999.json'), JSON.stringify({ First_Name: 'Orphan' }));
  fs.writeFileSync(w.p('downloads', 'cv-99998.pdf'), Buffer.alloc(300, 0x25));
  age('downloads/cv-99999.pdf', 15); age('downloads/candidate-99999.json', 15); age('downloads/cv-99998.pdf', 1);
  // time passes for the run's own files
  for (const n of w.list('downloads', /^(approved-queue|phase2-results)-/)) age(`downloads/${n}`, 4);
  const resultsName = w.list('downloads', /^phase2-results-/)[0];
  const results = w.json(`downloads/${resultsName}`);
  results.completedAt = new Date(Date.now() - 4 * DAY).toISOString();
  fs.writeFileSync(w.p('downloads', resultsName), JSON.stringify(results));
  age(`downloads/${resultsName}`, 4);
  for (const n of ['cv-71000005.docx', 'candidate-71000005.json']) age(`downloads/${n}`, 15);
  for (const n of w.list('runs')) age(`runs/${n}`, 8);
  for (const n of w.list('runs', /^phase1-.*\.json$/)) {
    const d = w.json(`runs/${n}`);
    d.completedAt = new Date(Date.now() - 8 * DAY).toISOString();
    d.updatedAt = d.completedAt;
    fs.writeFileSync(w.p('runs', n), JSON.stringify(d));
    age(`runs/${n}`, 8);
  }
  const oldLog = w.list('logs', /^phase1-console-/)[0];
  age(`logs/${oldLog}`, 15);
  const before = { secrets: hashTree('secrets'), state: hashTree('state'), cfg: hashTree('config') };

  const m = await w.cron('resourcer-maintenance');
  const r = await w.cron('resourcer-retention');
  assert.deepEqual([m.code, m.stdout, r.code, r.stdout], [0, '', 0, '']);

  assert.deepEqual(w.list('downloads', /^(approved-queue|phase2-results)-/), [], 'queue and result files are gone 3 days after completion');
  assert.deepEqual(w.list('downloads').filter((n) => /^(cv-71000005|candidate-71000005|cv-99999|candidate-99999)/.test(n)), [], 'the retried CV after 14 days and the orphans');
  assert.ok(w.exists('downloads/cv-99998.pdf'), 'a one-day-old orphan is not due yet');
  assert.deepEqual(w.list('runs', /^(phase1|run|params)-/), [], 'run records older than 7 days');
  assert.equal(w.exists(`logs/${oldLog}`), false, 'the plain log is replaced by its compressed copy');
  assert.ok(w.exists(`logs/${oldLog}.gz`));
  const summary = JSON.parse(w.text('logs/' + w.list('logs', /^retention-\d{8}\.log$/)[0]).trim().split('\n').pop());
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.refused, []);
  assert.equal(w.dbAll('select count(*) n from run_results')[0].n, 1, 'the run stays in the database');
  assert.deepEqual({ secrets: hashTree('secrets'), state: hashTree('state'), cfg: hashTree('config') }, before, 'secrets, state and config are never touched');

  const hits = C.personHits(w, [{ re: /workspace\/resourcer\/shadow\/screening-[^/]*\.jsonl$/, kinds: ['snippet'] }]);
  assert.deepEqual(hits, [], C.fmtHits(hits));
  assert.deepEqual(C.strayFiles(w).filter((f) => !/cv-99998/.test(f)), []);
});

test('10.4 a second pass changes nothing; the redacted screening log leaves at 180 days and then no snippet text is left anywhere', async () => {
  const snap = () => ['downloads', 'runs', 'shadow', 'state', 'secrets', 'config'].flatMap((d) => U.walk(w.p(d))).map((f) => `${f}:${fs.statSync(f).size}`).sort().join('\n');
  const a = snap();
  const m = await w.cron('resourcer-maintenance');
  const r = await w.cron('resourcer-retention');
  assert.deepEqual([m.code, r.code], [0, 0]);
  assert.equal(snap(), a, 'idempotent');

  const shadow = w.list('shadow', /^screening-/)[0];
  assert.ok(shadow);
  const old = new Date(Date.now() - 181 * DAY);
  const oldName = `screening-${old.getUTCFullYear()}-${String(old.getUTCMonth() + 1).padStart(2, '0')}-${String(old.getUTCDate()).padStart(2, '0')}.jsonl`;
  fs.renameSync(w.p('shadow', shadow), w.p('shadow', oldName));
  age(`shadow/${oldName}`, 181);
  const r2 = await w.cron('resourcer-retention');
  assert.equal(r2.code, 0);
  assert.equal(w.list('shadow', /^screening-/).includes(oldName), false, 'the 181 day old shadow file is pruned');

  const hits = C.personHits(w, []);
  assert.deepEqual(hits, [], C.fmtHits(hits));
  assert.deepEqual(C.secretHits(w), []);
  assert.deepEqual(w.netBlocked(), []);
  const left = w.list('downloads');
  assert.deepEqual(left.filter((n) => !/^cv-99998\.pdf$/.test(n) && !/^\./.test(n)), [], `downloads/ holds nothing: ${left}`);
});
