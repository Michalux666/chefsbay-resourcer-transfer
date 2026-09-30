'use strict';
// Builds an injected-dependency set for process-approved-queue.run() and captures console output.
// Requires helpers/workspace.js to have set RESOURCER_HOME first.
const fs = require('fs');
const path = require('path');
const Database = require('./sqlite');
const { createLegacyDb } = require('./legacy-schema');
const { fakeResponse } = require('./fixtures');

function captureConsole() {
  const lines = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...a) => { lines.push(a.map(String).join(' ')); };
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  return { lines, restore() { console.log = orig.log; console.error = orig.error; } };
}

function seedDb(ws, ids, opts = {}) {
  const rows = [];
  for (const id of ids) rows.push({ caterer_id: Number(id), unlocked: 1 });
  for (const id of opts.reedIds || []) rows.push({ reed_id: Number(id), source: 'reed', unlocked: 1 });
  for (const r of opts.extra || []) rows.push(r);
  createLegacyDb(ws.db, { rows });
}

function candidateDbFor(ws, hooks = {}) {
  let shared = null;
  const withDb = fn => {
    const db = new Database(ws.db, { timeout: 5000 });
    try { return fn(db); } finally { db.close(); }
  };
  return {
    getZohoId: id => withDb(db => {
      const row = db.prepare('SELECT zoho_id FROM candidates WHERE caterer_id = ?').get(id);
      return (row && row.zoho_id) || null;
    }),
    setZohoId: (id, zid) => {
      if (typeof hooks.setZohoIdThrows === 'function' ? hooks.setZohoIdThrows(id) : hooks.setZohoIdThrows) throw new Error('injected DB write failure');
      return withDb(db => db.prepare('UPDATE candidates SET zoho_id = ? WHERE caterer_id = ?').run(zid, id));
    },
    getDb: () => {
      if (hooks.getDbThrows) throw new Error('injected getDb failure');
      if (!shared) shared = new Database(ws.db, { timeout: 5000 });
      return shared;
    },
    close: () => { if (shared) { try { shared.close(); } catch { /* ignore */ } shared = null; } },
  };
}

// opts: zoho (fake server), sleeps[], hooks{setZohoIdThrows,attachThrows,fillMandatory,fetchCv,...}
function buildDeps(ws, opts = {}) {
  const sleeps = [];
  const client = opts.zoho ? opts.zoho.makeClient({ sleep: async () => {} }) : null;
  const should = (h, ...a) => (typeof h === 'function' ? !!h(...a) : !!h);
  const hooks = opts.hooks || {};
  const calls = { fetchCv: 0, upsert: [], fill: 0, reedDownloads: [], refresh: 0, attach: 0, create: 0 };
  const deps = {
    config: { concurrency: 2 },
    sleep: async ms => { sleeps.push(ms); },
    refreshToken: async () => { calls.refresh++; if (hooks.refreshThrows) throw new Error('token endpoint down'); },
    createCandidate: async p => { calls.create++; return client.createCandidate(p); },
    attachResume: async (zid, file) => {
      calls.attach++;
      if (should(hooks.attachThrows, zid, file)) throw new Error('injected attach exception');
      return client.attachResume(zid, file);
    },
    fillMandatoryFields: async (json, cv) => {
      calls.fill++;
      if (hooks.fillMandatory) return hooks.fillMandatory(json, cv, calls.fill);
      return { patched: false, recovered: [], stillMissing: [] };
    },
    candidateDb: candidateDbFor(ws, hooks),
    fetchCv: async (url, o, t) => {
      calls.fetchCv++;
      if (hooks.fetchCv) return hooks.fetchCv(url, o, t);
      return fakeResponse();
    },
    loadCookieHeader: () => 'a=b',
    baseCaterer: () => 'http://127.0.0.1:9',
    downloadCvViaScript: async () => ({ error: 'script path not used in tests' }),
    reedDownloadCandidate: async o => {
      calls.reedDownloads.push(o.candidateId);
      if (hooks.reedDownload) return hooks.reedDownload(o);
      const cvPath = path.join(o.outputDir, `cv-reed-${o.candidateId}.pdf`);
      fs.writeFileSync(cvPath, Buffer.alloc(300, 0x25));
      return { cvPath, profileData: { firstName: 'Test', lastName: `Reed${o.candidateId}` } };
    },
    normalizeProfileToZoho: (profile, meta, cand) => ({
      First_Name: profile.firstName, Last_Name: profile.lastName, Email: `reed${cand.id}@example.invalid`,
      Mobile: '07000000000', City: 'Testville', ReedID: String(cand.id), Source: 'Reed', Search_Job_Title: meta.jobTitle,
    }),
    upsertTerritory: (db, params) => {
      calls.upsert.push(params);
      if (hooks.upsertThrows) throw new Error('injected territory failure');
      return { jobTitle: params.jobTitle, location: params.location, distance: params.searchDistance || 20, nextRunDate: '2026-10-06', effectivePriority: 'low', autoDowngraded: false, previousPriority: null };
    },
    getCredits: () => ({ credits: null, source: 'phase2-completion' }),
  };
  if (hooks.openDbThrowsOnce) {
    let thrown = false;
    const real = require('../../../resourcer/scripts/process-approved-queue').makeDeps({}).openDb;
    deps.openDb = () => {
      if (!thrown) { thrown = true; throw new Error('injected run_results DB failure'); }
      return real();
    };
  }
  return { deps, sleeps, calls, close: () => deps.candidateDb.close() };
}

module.exports = { captureConsole, seedDb, buildDeps, candidateDbFor };
