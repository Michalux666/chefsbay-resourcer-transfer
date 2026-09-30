'use strict';
// Runs Phase 2 against the REAL sibling modules (zoho-create-candidate, zoho-attach-resume,
// fill-mandatory-fields, candidates-db, territory-utils) with only the network endpoint redirected to the
// fake Zoho server on 127.0.0.1. Skipped when those modules are not present in the checkout.
const { makeWorkspace } = require('./helpers/workspace');
const ws = makeWorkspace('lc-real');
require('./helpers/net-guard');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('./helpers/sqlite');

const SCRIPTS = path.resolve(__dirname, '../../resourcer/scripts');
const REQUIRED = ['zoho-auth.js', 'zoho-create-candidate.js', 'zoho-attach-resume.js', 'fill-mandatory-fields.js', 'territory-utils.js', 'constants.js'];
const present = REQUIRED.every(f => fs.existsSync(path.join(SCRIPTS, f))) && fs.existsSync(path.resolve(SCRIPTS, '../candidates-db.js'));

const { startFakeZoho } = require('./helpers/fake-zoho');
const { card, writeQueue, writeCv, fakeResponse, dbHelpers } = require('./helpers/fixtures');
const { captureConsole, seedDb } = require('./helpers/harness');
const pq = require('../../resourcer/scripts/process-approved-queue');

let zoho;
const db = dbHelpers(ws.db);

test.before(async () => {
  if (!present) return;
  zoho = await startFakeZoho();
  const constants = require(path.join(SCRIPTS, 'constants.js'));
  constants.RECRUIT_BASE = zoho.base; // zoho-auth captures this on its first (lazy) load
  fs.mkdirSync(ws.dir('config'), { recursive: true });
  for (const f of fs.readdirSync(path.resolve(SCRIPTS, '../config'))) fs.copyFileSync(path.resolve(SCRIPTS, '../config', f), path.join(ws.dir('config'), f));
  fs.mkdirSync(ws.dir('secrets'), { recursive: true });
  fs.writeFileSync(path.join(ws.dir('secrets'), 'zoho-credentials.json'), JSON.stringify({ client_id: 'fake-id', client_secret: 'fake-secret-value', refresh_token: 'fake-refresh', access_token: 'fake-access' }));
});
test.after(async () => {
  if (zoho) await zoho.close();
  try { require('../../resourcer/candidates-db').closeDb(); } catch { /* not loaded */ }
  ws.cleanup();
});

function realDepsOverrides() {
  return {
    cvScreenMode: () => 'off', // the CV stage is tested in tests/cv; this suite is the real Zoho lifecycle
    refreshToken: async () => {},
    fetchCv: async () => fakeResponse(),
    loadCookieHeader: () => 'a=b',
    baseCaterer: () => 'http://127.0.0.1:9',
    getCredits: () => ({ credits: null, source: 'phase2-completion' }),
    sleep: async () => {},
  };
}

async function runReal(candidates, extra) {
  try { require('../../resourcer/candidates-db').closeDb(); } catch { /* not loaded yet */ }
  ws.reset();
  zoho.calls.length = 0;
  zoho.scenarios.clear();
  seedDb(ws, candidates.filter(c => c.source !== 'reed').map(c => c.id), { reedIds: candidates.filter(c => c.source === 'reed').map(c => c.id) });
  fs.mkdirSync(ws.pending, { recursive: true });
  const qf = writeQueue(ws, 'merged-queue-2026-09-29T10-00-00.json', { candidates, ...(extra || {}) });
  const cap = captureConsole();
  let res;
  try { res = await pq.run(qf, realDepsOverrides()); } finally { cap.restore(); }
  try { require('../../resourcer/candidates-db').closeDb(); } catch { /* ignore */ }
  const resultsFile = path.join(ws.downloads, 'phase2-results-merged-queue-2026-09-29T10-00-00.json');
  return { res, out: cap.lines, results: fs.existsSync(resultsFile) ? ws.readJson(resultsFile) : null };
}

test('real modules: new candidate is created, CV attached, DB updated, files removed, territory and run_results written', { skip: !present && 'sibling modules not present' }, async () => {
  ws.reset();
  const c = card('1001');
  writeCv(ws, '1001');
  // seed happens inside runReal; pre-placed CV must survive ws.reset(), so write the queue and CV after reset via setup
  try { require('../../resourcer/candidates-db').closeDb(); } catch { /* ignore */ }
  seedDb(ws, ['1001', '1002', '1003']);
  zoho.calls.length = 0;
  zoho.scenarios.clear();
  zoho.scenario('1002', { create: 'duplicate' });
  zoho.scenario('1003', { attach: 'fail' });
  const cands = [c, card('1002'), card('1003')];
  const qf = writeQueue(ws, 'merged-queue-2026-09-29T10-00-00.json', { candidates: cands });
  const cap = captureConsole();
  let res;
  try { res = await pq.run(qf, realDepsOverrides()); } finally { cap.restore(); }
  try { require('../../resourcer/candidates-db').closeDb(); } catch { /* ignore */ }
  assert.equal(res.code, 0, cap.lines.join('\n'));
  const results = ws.readJson(path.join(ws.downloads, 'phase2-results-merged-queue-2026-09-29T10-00-00.json'));
  assert.deepEqual(results.candidates.map(r => [r.id, r.status, r.cvAttached]), [['1001', 'new', true], ['1002', 'duplicate', false], ['1003', 'new', false]]);
  assert.ok(db.zohoId('1001') && db.zohoId('1002') && db.zohoId('1003'));
  const left = fs.readdirSync(ws.downloads).filter(n => /^(cv|candidate)-/.test(n)).sort();
  assert.deepEqual(left, ['candidate-1003.json', 'cv-1003.pdf'], 'only the failed attach is kept');
  const d = new Database(ws.db, { readonly: true });
  try {
    const t = d.prepare('SELECT last_searched, new_to_zoho, duplicates FROM territory_searches WHERE job_title = ? COLLATE NOCASE AND location = ?').get('Chef', 'LS1');
    assert.equal(t.last_searched, '2026-09-29');
    assert.equal(t.new_to_zoho, 2);
    assert.equal(t.duplicates, 1);
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM run_results').get().n, 1);
  } finally { d.close(); }
  assert.equal(zoho.callsFor('1001', 'attach').length, 1);
});

test('real modules: real fillMandatoryFields recovers City from the postcode before the push', { skip: !present && 'sibling modules not present' }, async () => {
  const { res, results } = await runReal([card('2001', { city: '', postcode: 'LS1 4AB', cvUrl: undefined })]);
  assert.equal(res.code, 0);
  assert.equal(results.candidates[0].status, 'new');
});

test('real modules: a rejected create (invalid data) leaves files and reports the real error text', { skip: !present && 'sibling modules not present' }, async () => {
  ws.reset();
  try { require('../../resourcer/candidates-db').closeDb(); } catch { /* ignore */ }
  seedDb(ws, ['3001']);
  zoho.calls.length = 0;
  zoho.scenarios.clear();
  zoho.scenario('3001', { create: 'invalid' });
  const qf = writeQueue(ws, 'merged-queue-2026-09-29T10-00-00.json', { candidates: [card('3001')] });
  const cap = captureConsole();
  let res;
  try { res = await pq.run(qf, realDepsOverrides()); } finally { cap.restore(); }
  try { require('../../resourcer/candidates-db').closeDb(); } catch { /* ignore */ }
  assert.equal(res.code, 0);
  const r = res.phaseResults[0];
  assert.equal(r.status, 'error');
  assert.match(r.error, /^ERROR: INVALID_DATA invalid data/);
  assert.equal(fs.existsSync(path.join(ws.downloads, 'candidate-3001.json')), true);
  assert.equal(zoho.callsFor('3001', 'create').length, 3, 'three attempts through the real create code');
});
