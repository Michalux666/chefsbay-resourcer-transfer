'use strict';
// The worlds and the snapshot of the identity comparison of the role scope (docs/ROLESCOPE.md R-C7); used by tests/e2e/identity-snapshot.js (the run on two trees)
// and by scenario 19 (the same worlds with the role scope on and off in one tree).
const assert = require('node:assert/strict');
const path = require('path');
const { World } = require('./world');

// `cached` and `jevCalls` are counters of the decision cache of the CV stage, which depend on which of the concurrent reviewers asked first: they vary between two runs of the SAME tree
const DROP = ['startedAt', 'completedAt', 'requestedAt', 'phase1StartedAt', 'runtimeSecs', 'totalRuntimeSecs', 'timing', 'generatedAt', 'ts', 'at', 'updatedAt', 'cached', 'jevCalls', 'queueFile', 'queuePath', 'lastTickAt', 'created_at', 'zoho_pushed_at', 'rejected_at'];

function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) {
      if (DROP.includes(k)) continue;
      if (k === 'browserRoundtrips') continue;
      o[k] = scrub(v[k]);
    }
    return o;
  }
  if (typeof v === 'string') return v.replace(/\d{4}-\d{2}-\d{2}[T-]\d{2}[:-]\d{2}[:-]\d{2}(?:[.-]\d+)?Z?/g, '<time>').replace(/(queue|phase1)-[0-9a-z-]+/g, '$1-<id>');
  return v;
}

function snapshot(x) {
  const results = x.list('downloads', /^phase2-results-.*\.json$/).map((f) => scrub(x.json(`downloads/${f}`))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const shadowFile = x.list('shadow', /^screening-\d{4}-\d{2}-\d{2}\.jsonl$/)[0];
  const decisions = shadowFile ? x.jsonl(`shadow/${shadowFile}`).filter((r) => !r.kind).map((r) => [String(r.candidateId), r.source, r.stage, r.approved === undefined ? null : r.approved, r.jobTitle]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : [];
  const rejAll = x.dbAll('select caterer_id, reed_id, job_title, origin from candidate_rejections order by caterer_id, reed_id, job_title');
  const scoped = (r) => /^reed:(snippet|approved)$/.test(String(r.origin));
  const last = x.lastRun();
  return {
    results,
    last: { exitCode: last.exitCode, phase1Code: last.phase1Code, pool: last.pool, approved: last.approved, skippedDb: last.skippedDb, errors: last.errors },
    candidates: x.dbAll('select caterer_id, reed_id, source, unlocked, zoho_id is not null as pushed from candidates order by caterer_id, reed_id'),
    rejections: rejAll.filter((r) => !scoped(r)),
    runResults: x.dbAll('select job_title, location, sources, pool, downloaded, new_to_zoho, duplicates, skipped, errors, approved_p1, skipped_db, skipped_review, pages_scraped, caterer_json, reed_json from run_results order by job_title, location').map((r) => scrub(Object.assign({}, r, { caterer_json: r.caterer_json && JSON.parse(r.caterer_json), reed_json: r.reed_json && JSON.parse(r.reed_json) }))),
    zoho: x.svc.zoho.state.calls.map((c) => [c.op, c.key, c.status]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    decisions,
    alerts: x.alerts().map((a) => [a.severity, a.key]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    runtime: x.list('runtime').filter((n) => /cv-resurface/.test(n)),
    reedUsage: x.dbAll('select profile_views, cv_downloads from reed_daily_usage order by date desc limit 1')[0] || null,
    reedLedgerRows: rejAll.filter(scoped).length,
  };
}

const rcard = (id, title, over) => ({ candidateId: id, name: `Reed Person ${id}`, firstName: 'Reed', jobPreference: { currentJobTitle: title, desiredJobTitle: 'Sous Chef', jobType: 'Permanent', locations: { currentLocation: 'Leeds', desiredLocations: 'Leeds' }, salary: { minimumSalary: '22000' } }, ...(over || {}) });
const REED_CARDS = [
  rcard(9001, 'Head Chef'), rcard(9002, 'Sous Chef'), rcard(9003, 'Chef de Partie'), rcard(9004, 'Kitchen Porter [[REJECT]]'), rcard(9005, 'Retail Cashier [[REJECT]]'),
  rcard(9006, 'Commis Chef'), rcard(9007, 'Head Chef'), rcard(9008, 'Sous Chef'),
];

async function oneWorld(name, o) {
  const x = new World(name);
  await x.create({ engine: null, sources: o.reed ? 'caterer' : 'caterer' });
  try {
    x.svc.zoho.state.dupKeys.add('71000010');
    x.warmLoggedIn();
    if (o.reed) await x.enableReed(REED_CARDS);
    if (o.env) x.writeEnv(o.env);
    if (o.legacy) {
      // the old system's leftovers: Caterer people unlocked and never pushed (no created_at, no row), Reed people seen and never pushed (no row)
      const Database = require(path.join(x.home, 'node_modules', 'better-sqlite3'));
      const db = new Database(x.p('candidates.db'), { timeout: 5000 });
      try {
        for (const id of [71000001, 71000005, 71000009]) {
          db.prepare("INSERT OR IGNORE INTO candidates (caterer_id, source, unlocked) VALUES (?, 'caterer', 1)").run(id);
          db.prepare('UPDATE candidates SET created_at = NULL WHERE caterer_id = ?').run(id);
        }
        for (const id of [9001, 9002, 9003]) db.prepare("INSERT OR IGNORE INTO candidates (reed_id, source, unlocked) VALUES (?, 'reed', 0)").run(id);
      } finally { db.close(); }
    }
    x.dropPending(o.reed ? { sources: 'both' } : {});
    const ticks = await x.tickUntil(async () => !x.pendingFiles().length && !x.exists('runtime/run.json') && x.pipelineProcs().length === 0, { maxTicks: 14, tickMin: 1, gapMs: 1500 });
    for (const tk of ticks) assert.deepEqual([tk.code, tk.stderr], [0, ''], tk.stdout + tk.stderr);
    return snapshot(x);
  } finally {
    await x.close();
  }
}

const WORLDS = {
  'cat-default': { },
  'cat-off': { env: { ROLE_SCOPE_LEGACY: 'off' } },
  'both-default': { reed: true },
  'both-legacy-off': { reed: true, legacy: true, env: { ROLE_SCOPE_LEGACY: 'off' } },
  // the control: the same leftovers with the role scope ON must NOT be identical to the previous release (they are screened once); a comparison that could not see that proves nothing
  'both-legacy-on': { reed: true, legacy: true },
};


module.exports = { snapshot, scrub, oneWorld, WORLDS };
