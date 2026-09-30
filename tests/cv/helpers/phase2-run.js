'use strict';
// Shared by the Phase 2 test files of the CV stage: a temporary workspace, a fake Zoho, a fake Jev gateway, and execute(), which runs
// process-approved-queue.js on a fake queue with either an injected reviewer (every scenario) or the real cv-review.js (end to end).
// Requiring this file creates the workspace first, before any resourcer script is loaded (paths.js reads RESOURCER_HOME once).
const { makeWorkspace } = require('../../lifecycle/helpers/workspace');
const ws = makeWorkspace('cv-p2');
require('../../lifecycle/helpers/net-guard');
const fs = require('fs');
const path = require('path');
const Database = require('../../lifecycle/helpers/sqlite');
const { startFakeZoho } = require('../../lifecycle/helpers/fake-zoho');
const { card, writeQueue } = require('../../lifecycle/helpers/fixtures');
const { captureConsole, seedDb, buildDeps } = require('../../lifecycle/helpers/harness');
const pq = require('../../../resourcer/scripts/process-approved-queue');
const halt = require('../../../resourcer/scripts/lib/pipeline-halt');
const cvConfig = require('../../../resourcer/scripts/lib/cv/config');
const { startFakeJev } = require('./fake-jev');

const state = { zoho: null, gw: null };
async function start() { state.zoho = await startFakeZoho(); state.gw = await startFakeJev(); }
async function stop() { await state.zoho.close(); await state.gw.close(); ws.cleanup(); }

const QUEUE = 'approved-queue-2026-09-30T10-00-00.json';
const RUN_KEY = '2026-09-30T10-00-00';
const has = name => fs.existsSync(path.join(ws.downloads, name));
const rowOf = (results, id) => results.candidates.find(c => c.id === String(id));

// what the reviewer prints, as the queue step reads it
const R = {
  pass: () => ({ code: 0, result: { decision: 'pass', final: 'approve', lane: 'jev', forced: false, reasonCodes: ['pass_relevant_history'], finalReasonCodes: ['pass_relevant_history'], policy: null, jevCalls: 2, cached: false } }),
  forcedPass: () => ({ code: 0, result: { decision: 'pass', final: 'approve', lane: 'jev', forced: true, reasonCodes: ['forced', 'pass_doubt', 'under_qualified'], finalReasonCodes: ['forced', 'pass_doubt', 'under_qualified'], policy: null, jevCalls: 2, cached: false } }),
  reject: (codes = ['under_qualified']) => ({ code: 0, result: { decision: 'reject', final: 'reject', lane: 'jev', forced: false, reasonCodes: codes, finalReasonCodes: codes, policy: null, jevCalls: 2, cached: false } }),
  forcedReject: () => ({ code: 0, result: { decision: 'reject', final: 'reject', lane: 'jev', forced: true, reasonCodes: ['forced', 'under_qualified'], finalReasonCodes: ['forced', 'under_qualified'], policy: null, jevCalls: 2, cached: false } }),
  review: () => ({ code: 0, result: { decision: 'review', final: 'approve', lane: 'fallback', forced: false, reasonCodes: ['answers_invalid'], finalReasonCodes: ['policy_fallback_approve', 'answers_invalid'], policy: { applied: 'review', side: 'approve', code: 'policy_fallback_approve' }, jevCalls: 2, cached: false } }),
  reviewReject: () => ({ code: 0, result: { decision: 'review', final: 'reject', lane: 'fallback', forced: false, reasonCodes: ['answers_invalid'], finalReasonCodes: ['policy_fallback_reject', 'answers_invalid'], policy: { applied: 'review', side: 'reject', code: 'policy_fallback_reject' }, jevCalls: 2, cached: false } }),
  unreadable: () => ({ code: 0, result: { decision: 'unreadable', final: 'approve', lane: 'unreadable', forced: false, reasonCodes: ['unreadable_scanned_too_little_text'], finalReasonCodes: ['unreadable_scanned_too_little_text'], policy: null, jevCalls: 0, cached: false } }),
  outage: () => ({ code: 3, result: null, detail: 'HTTP 503: fake outage' }),
  outageAuth: () => ({ code: 3, result: null, reasonKey: 'auth', detail: 'HTTP 401: invalid key' }),
  broken: () => ({ code: 1, result: null, detail: 'FATAL something broke' }),
};

function setup(ids, dbOpts) {
  ws.reset();
  state.zoho.calls.length = 0;
  state.zoho.scenarios.clear();
  seedDb(ws, ids, dbOpts);
  halt.clearHalt();
  fs.rmSync(path.join(ws.home, 'runtime'), { recursive: true, force: true });
  fs.rmSync(path.join(ws.home, 'shadow'), { recursive: true, force: true });
  fs.rmSync(path.join(ws.home, 'state'), { recursive: true, force: true });
}

function writeCvFile(id, body, source) {
  const f = path.join(ws.downloads, `${source === 'reed' ? 'cv-reed-' : 'cv-'}${id}.pdf`);
  fs.mkdirSync(ws.downloads, { recursive: true });
  fs.writeFileSync(f, body === undefined ? Buffer.alloc(300, 0x25) : body);
  return f;
}

// scenario: id -> what the injected reviewer answers (a function of the request and the call number is allowed)
// defaultMode: leave cvScreenMode alone, so the queue step reads CV_SCREEN itself (the real default)
async function execute({ ids, scenario, mode = 'on', cvOverrides, hooks, queueExtra, keepState, config, useRealCli, force, before, cands, defaultMode }) {
  const candidates = cands || ids.map(id => card(id));
  if (!keepState) {
    setup(ids);
    for (const id of ids) writeCvFile(id);
  }
  const qf = writeQueue(ws, QUEUE, { candidates, ...(queueExtra || {}) });
  if (before) before(qf);
  const built = buildDeps(ws, { zoho: state.zoho, hooks });
  const seen = { calls: [], inflight: 0, maxInflight: 0 };
  if (defaultMode) delete built.deps.cvScreenMode;
  else built.deps.cvScreenMode = () => mode;
  if (!defaultMode || cvOverrides) built.deps.cvConfig = () => cvConfig.load({ file: 'no-such-file.json', overrides: cvOverrides });
  if (!useRealCli) {
    built.deps.cvScreen = async req => {
      seen.calls.push(String(req.cand.id));
      seen.inflight++;
      seen.maxInflight = Math.max(seen.maxInflight, seen.inflight);
      try {
        await new Promise(r => setTimeout(r, 5));
        const s = scenario[String(req.cand.id)];
        if (typeof s === 'function') return s(req, seen.calls.length);
        if (s === 'throw') throw new Error('injected reviewer crash');
        return (s || R.pass)();
      } finally { seen.inflight--; }
    };
  }
  if (config) built.deps.config = { ...built.deps.config, ...config };
  if (force) built.deps.force = true;
  const cap = captureConsole();
  let res;
  try { res = await pq.run(qf, built.deps); } finally { cap.restore(); built.close(); }
  const resultsFile = path.join(ws.downloads, `phase2-results-${RUN_KEY}.json`);
  const results = fs.existsSync(resultsFile) ? ws.readJson(resultsFile) : null;
  return { res, out: cap.lines, results, built, qf, seen, resultsFile };
}

function rejections() {
  const db = new Database(ws.db, { readonly: true });
  try { return db.prepare('SELECT caterer_id, reed_id, job_title, rejected_at, origin FROM candidate_rejections WHERE origin LIKE ?').all('cv:%'); } finally { db.close(); }
}

const zohoIdOf = id => { const db = new Database(ws.db, { readonly: true }); try { return (db.prepare('SELECT zoho_id FROM candidates WHERE caterer_id = ?').get(Number(id)) || {}).zoho_id || null; } finally { db.close(); } };

module.exports = { ws, state, start, stop, R, QUEUE, RUN_KEY, has, rowOf, setup, writeCvFile, execute, rejections, zohoIdOf, pq, halt, cvConfig, captureConsole, card };
