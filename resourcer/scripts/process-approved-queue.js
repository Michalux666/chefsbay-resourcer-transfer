#!/usr/bin/env node
'use strict';
// Phase 2: CV download, candidate JSON, Zoho push, results, territory update. Deviations from the legacy engine: docs/parity/lifecycle.md.
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const paths = require('./lib/paths');
const fsx = require('./lib/fsx');
const env = require('./lib/env');
const { notify } = require('./lib/notify');
const retention = require('./lib/cv-retention');
const cvStage = require('./lib/cv/phase2');

const execFileAsync = promisify(execFile);

const DOWNLOADS = paths.DOWNLOADS;
const RUNS_DIR = paths.RUNS;
const LOGS_DIR = paths.LOGS;
const PENDING_DIR = paths.PENDING;
const DL_SCRIPT = path.join(paths.SCRIPTS, 'caterer-download-cv.js');

const CV_EXTENSIONS = retention.CV_EXTENSIONS;
const DEFAULT_CONFIG = Object.freeze({
  concurrency: 5,
  catererDownloadConcurrency: 2, // every Caterer CV goes through the one signed-in browser
  zohoDelayMs: 500, // Zoho limit is concurrency(10) + credits, not per-call spacing (legacy 2026-06-02)
  retryDelayMs: 3000,
  maxRetries: 3,
  childTimeoutMs: 150000, // caterer-download-cv.js budgets 60 s to 135 s of its own; a shorter parent timer killed working downloads
  fillTimeoutMs: 30000,
  cvScreenTimeoutMs: 180000, // one reviewer process (the Jev part has its own 90 s deadline)
});

const sleepReal = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Lazy real dependencies (all injectable for tests). Nothing is required until first used.
// ---------------------------------------------------------------------------------------------

function realDeps() {
  return {
    refreshToken: () => require('./zoho-auth').refreshToken(),
    createCandidate: p => require('./zoho-create-candidate').createCandidate(p),
    attachResume: (zohoId, file) => require('./zoho-attach-resume').attachResume(zohoId, file),
    fillMandatoryFields: (j, c) => require('./fill-mandatory-fields').fillMandatoryFields(j, c),
    candidateDb: {
      getZohoId: id => require('../candidates-db').getZohoId(id),
      setZohoId: (id, zid) => require('../candidates-db').setZohoId(id, zid),
      getDb: () => require('../candidates-db').getDb(),
    },
    reedDownloadCandidate: o => require('./reed-download').downloadCandidate(o),
    normalizeProfileToZoho: (...a) => require('./reed-download').normalizeProfileToZoho(...a),
    fetchCv: (url, opts, timeoutMs) => require('./caterer-cookie-jar').fetchWithCookieJarUpdate(url, opts, timeoutMs),
    loadCookieHeader: () => require('./caterer-session-utils').loadCookieHeader(),
    baseCaterer: () => require('./caterer-session-utils').BASE_CATERER,
    downloadCvViaScript: downloadCvViaScriptReal,
    upsertTerritory: (db, params) => require('./territory-utils').upsertTerritory(db, params),
    markReedHalf: (db, params) => require('./territory-utils').markReedHalf(db, params),
    openDb: () => {
      const Database = require('better-sqlite3');
      const db = new Database(paths.DB, { fileMustExist: true, timeout: 15000 });
      db.pragma('busy_timeout = 15000');
      return db;
    },
    getCredits: () => getCreditsReal(),
    allowedSources: () => env.get('RESOURCER_SOURCES', 'caterer'),
    cvScreenMode: () => cvStage.mode(env.get('CV_SCREEN')),
    cvScreen: req => cvStage.runCli(req),
    cvConfig: () => cvStage.loadConfig(),
    sleep: sleepReal,
  };
}

// RESOURCER_SOURCES gates Reed off until the operator's canary passes; same rule as watchdog-runner.js.
function reedAllowed(value) {
  const a = String(value === undefined || value === null ? 'caterer' : value).trim().toLowerCase();
  return a === 'both' || a === 'reed';
}

function makeDeps(overrides) {
  const d = { ...realDeps(), ...(overrides || {}) };
  d.config = { ...DEFAULT_CONFIG, ...((overrides && overrides.config) || {}) };
  return d;
}

// ---------------------------------------------------------------------------------------------
// Phase 1 status file lookup (legacy findPhase1StatusFile, unchanged semantics)
// ---------------------------------------------------------------------------------------------

function findPhase1StatusFile(queuePath, matchStatuses, meta) {
  const base = path.basename(queuePath, '.json');
  const statuses = matchStatuses || ['phase1_complete'];

  const m1 = base.match(/^(?:approved-queue|merged-queue)-(.+)$/);
  if (m1) {
    const candidate = path.join(RUNS_DIR, `phase1-${m1[1]}.json`);
    if (fs.existsSync(candidate)) return candidate;
  }

  const m2 = base.match(/^reed-approved-queue-(phase1-.+)$/);
  if (m2) {
    const candidate = path.join(RUNS_DIR, `${m2[1]}.json`);
    if (fs.existsSync(candidate)) return candidate;
  }

  try {
    const files = fs.readdirSync(RUNS_DIR)
      .filter(f => f.startsWith('phase1-') && f.endsWith('.json'))
      .map(f => ({ f, p: path.join(RUNS_DIR, f), m: fs.statSync(path.join(RUNS_DIR, f)).mtime }))
      .sort((a, b) => b.m - a.m);

    // Never match a phase1 file whose startedAt is more than 7 days old (2026-05-06: an ancient
    // phase1_complete orphan was flipped to complete and polluted the territory log).
    const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const isFresh = (data) => {
      const ref = data.startedAt || data.updatedAt;
      if (!ref) return true;
      const t = new Date(ref).getTime();
      if (Number.isNaN(t)) return true;
      return (Date.now() - t) <= MAX_AGE_MS;
    };

    if (meta && meta.jobTitle && meta.location) {
      for (const { p } of files) {
        try {
          const data = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (statuses.includes(data.status) && data.jobTitle === meta.jobTitle && data.location === meta.location && isFresh(data)) return p;
        } catch { /* skip */ }
      }
    }

    for (const { p } of files) {
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (statuses.includes(data.status) && isFresh(data)) return p;
      } catch { /* skip unreadable */ }
    }
  } catch { /* RUNS_DIR read failed */ }

  return null;
}

// What happened to the Reed half of a run (docs/parity/reed-first-page.md): failed (the search could not be made), auth_failed, halted (screening
// down), limit (daily profile views used up), ok (searched, candidates seen or approved), empty (searched, a genuine pool of 0), not_run (the run asks
// for Reed but no Reed step left any record: held or skipped). null = the run has no Reed half at all.
function reedStatusOf(reedP1, reedCandCount, resolvedSources) {
  const hasStats = !!reedP1 && Object.keys(reedP1).length > 0;
  if (!hasStats && !reedCandCount) return (resolvedSources === 'reed' || resolvedSources === 'both') ? 'not_run' : null;
  if (reedP1.failed === true) return 'failed';
  if (reedP1.authFailed) return 'auth_failed';
  if (reedP1.screeningHalted === true) return 'halted';
  if (reedP1.dailyLimitReached === true) return 'limit';
  return (Number(reedP1.pool ?? reedP1.totalCandidatesSeen ?? 0) > 0 || reedCandCount > 0) ? 'ok' : 'empty';
}

// Merged queues nest phase1Stats by source; single-source queues are flat.
function flattenPhase1Stats(stats) {
  if (!stats) return {};
  if (!stats.caterer && !stats.reed) return stats;
  const c = stats.caterer || {};
  const r = stats.reed || {};
  const sumOrNull = (a, b) => (a == null && b == null) ? null : (a || 0) + (b || 0);
  const latest = (a, b) => {
    if (!a) return b || null;
    if (!b) return a;
    return new Date(a) > new Date(b) ? a : b;
  };
  const concat = (a, b) => {
    const ar = Array.isArray(a) ? a : [];
    const br = Array.isArray(b) ? b : [];
    return (ar.length || br.length) ? [...ar, ...br] : null;
  };
  const deriveScraping = (s) => {
    if (s.scrapingTimeSecs != null) return s.scrapingTimeSecs;
    if (s.phase1StartedAt && s.phase1CompletedAt) {
      return +(((new Date(s.phase1CompletedAt) - new Date(s.phase1StartedAt)) / 1000).toFixed(1));
    }
    return null;
  };
  const cScrape = deriveScraping(c);
  const rScrape = deriveScraping(r);
  const totalPages = sumOrNull(c.pagesScraped, r.pagesScraped);
  const totalScraping = sumOrNull(cScrape, rScrape);
  return {
    phase1CompletedAt: latest(c.phase1CompletedAt, r.phase1CompletedAt),
    scrapingTimeSecs: totalScraping,
    sessionValidationTimeSecs: sumOrNull(c.sessionValidationTimeSecs, r.sessionValidationTimeSecs),
    avgTimePerPageSecs: (totalPages && totalScraping) ? +(totalScraping / totalPages).toFixed(1) : null,
    avgTimePerBrowserRoundtrip: c.avgTimePerBrowserRoundtrip ?? r.avgTimePerBrowserRoundtrip ?? null,
    pageTimings: concat(c.pageTimings, r.pageTimings),
    _bySource: { caterer: c, reed: r },
  };
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function logError(context, error, extra = {}) {
  const entry = { ts: new Date().toISOString(), context, error: String(error), ...extra };
  try {
    fsx.appendLine(path.join(LOGS_DIR, 'errors.jsonl'), env.redact(JSON.stringify(entry)));
  } catch { /* logging must never break a run */ }
}

function makeRunState(runId, meta) {
  const file = path.join(RUNS_DIR, `run-${runId}.json`);
  const state = {
    id: runId, status: 'phase2_starting',
    jobTitle: meta.jobTitle, location: meta.location, distance: meta.distance,
    keywords: meta.keywords, startedAt: new Date().toISOString(),
    requestedAt: meta.requestedAt || null,
    phase1StartedAt: meta.phase1StartedAt || null,
    runtimeSecs: null,
    totalRuntimeSecs: null,
    phase1: meta.phase1 || {},
    phase2: { downloaded: 0, pushed: 0, duplicates: 0, errors: 0, total: (meta.candidates && meta.candidates.length) || 0 },
    completedAt: null, error: null,
  };
  fsx.writeJsonAtomic(file, state);
  return {
    file,
    update(patch) {
      if (!fs.existsSync(file)) return;
      try {
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        Object.assign(s, patch);
        if (patch.phase2) Object.assign(s.phase2, patch.phase2);
        fsx.writeJsonAtomic(file, s);
      } catch { /* dashboard progress only */ }
    },
  };
}

function findExistingCv(id, source) {
  if (!retention.isSafeId(id)) return null;
  for (const prefix of retention.cvPrefixes(source)) {
    for (const ext of CV_EXTENSIONS) {
      const p = path.join(DOWNLOADS, `${prefix}${id}${ext}`);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function guessExtension(contentType, contentDisposition) {
  const fromDisposition = () => {
    if (!contentDisposition) return null;
    const m = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i);
    if (!m) return null;
    const ext = path.extname(m[1].replace(/['"]/g, '').trim());
    return ext ? ext.toLowerCase() : null;
  };
  const fromType = () => {
    if (!contentType) return null;
    if (contentType.includes('pdf')) return '.pdf';
    if (contentType.includes('wordprocessingml') || contentType.includes('docx')) return '.docx';
    if (contentType.includes('msword') || contentType.includes('doc')) return '.doc';
    if (contentType.includes('rtf')) return '.rtf';
    if (contentType.includes('text')) return '.txt';
    return null;
  };
  // A CV saved under an extension findExistingCv() does not search for would be orphaned on disk
  // and never attached, so only the supported extensions are accepted.
  const d = fromDisposition();
  if (d && CV_EXTENSIONS.includes(d)) return d;
  return fromType() || '.pdf';
}

async function downloadCvDirect(deps, cvUrl, candidateId) {
  const base = deps.baseCaterer();
  const fullUrl = cvUrl.startsWith('http') ? cvUrl : `${base}${cvUrl}`;
  // The session cookie must only ever go to the Caterer site.
  let sameOrigin = false;
  try { sameOrigin = new URL(fullUrl).origin === new URL(base).origin; } catch { sameOrigin = false; }
  if (!sameOrigin) return { error: 'cvUrl is not on the Caterer site - not fetched' };
  const cookieHeader = deps.loadCookieHeader();

  const res = await deps.fetchCv(fullUrl, {
    headers: {
      Cookie: cookieHeader,
      Referer: `${base}/CandidateSearchWebMvc/CandidateSearch/Results`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*',
    },
    redirect: 'follow',
  }, 60000);

  if (!res.ok) return { error: `HTTP ${res.status} ${res.statusText}` };

  const contentType = res.headers.get('content-type') || '';
  const contentDisposition = res.headers.get('content-disposition') || '';
  const ext = guessExtension(contentType, contentDisposition);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 100) {
    return { error: `File too small (${buffer.length} bytes) - likely an error page` };
  }

  // HTML masquerading as a CV (captive portal, auth wall). CV content is untrusted: never follow URLs in it.
  const sniff = buffer.slice(0, 64).toString('latin1').trimStart();
  if (/^<(!DOCTYPE|HTML)/i.test(sniff)) {
    return { error: 'CV download returned HTML page (captive portal or auth redirect) - no usable CV. Candidate requires manual lookup.' };
  }

  const cvPath = path.join(DOWNLOADS, `cv-${candidateId}${ext}`);
  fsx.writeFileAtomic(cvPath, buffer, 0o600);
  return { cvPath, size: buffer.length, ext };
}

// A malformed card (a non-string name, say) throws here; the caller turns that into one candidate's error row.
function buildProfile(deps, cand, { jobTitle, location, distance }) {
  const candSource4 = cand.source || 'caterer';
  let profile;

  if (candSource4 === 'reed' && cand._reedProfile) {
    profile = deps.normalizeProfileToZoho(cand._reedProfile, { jobTitle, location, distance: distance ?? 20 }, cand);
  } else if (candSource4 === 'reed') {
    const nameParts = (cand.name || '').split(' ');
    profile = {
      First_Name: cand.firstName || nameParts[0] || 'Unknown',
      Last_Name: nameParts.slice(1).join(' ') || String(cand.id),
      Email: '',
      Mobile: '',
      Current_Job_Title: cand.currentJobTitle || '',
      City: cand.currentLocation || '',
      Zip_Code: '',
      State: '',
      Country: 'United Kingdom',
      Experience_in_Years: null,
      ReedID: String(cand.id),
      Source: 'Reed',
      Search_Job_Title: jobTitle,
      Search_Criteria: `${jobTitle} | ${location} | ${distance ?? 20}mi`,
    };
  } else {
    profile = {
      First_Name: cand.firstName || (cand.name ? cand.name.split(' ')[0] : 'Unknown'),
      Last_Name: cand.lastName || (cand.name ? cand.name.split(' ').slice(1).join(' ') : cand.id),
      Email: cand.email || '',
      Mobile: (cand.phone || '').replace(/\s/g, ''),
      Current_Job_Title: cand.currentTitle || '',
      Account_Name: cand.currentEmployer || '',
      City: cand.city || '',
      Zip_Code: cand.postcode || '',
      State: cand.state || '',
      Country: 'United Kingdom',
      Experience_in_Years: cand.experience || null,
      CatererID: String(cand.id),
      Source: 'Caterer',
      Search_Job_Title: jobTitle,
      Search_Criteria: `${jobTitle} | ${location} | ${distance ?? 20}mi`,
    };
  }
  return profile;
}

// Node fetch to recruiter.caterer.com is blocked by bot mitigation (2026-06-01), so a candidate that carries the
// encrypted id goes through the signed-in browser. When that fails the direct fetch is still tried (legacy tried
// whichever applied), and a download that ran into its timeout gets one more go before the candidate is pushed CV-less.
async function downloadCatererCv(deps, cfg, cand) {
  if (!cand.encId) {
    if (cand.cvUrl) return downloadCvDirect(deps, cand.cvUrl, cand.id);
    return { error: 'No cvUrl or encId available' };
  }
  let result = await deps.downloadCvViaScript(cand.encId, cand.auditId, cand.id, cfg);
  if (!result.error) return result;
  if (cand.cvUrl) {
    try {
      const direct = await downloadCvDirect(deps, cand.cvUrl, cand.id);
      if (!direct.error) return direct;
    } catch { /* the script error below is the one worth reporting */ }
  }
  if (result.timedOut) {
    const again = await deps.downloadCvViaScript(cand.encId, cand.auditId, cand.id, cfg);
    if (!again.error) return again;
    result = again;
  }
  return result;
}

// Answers that leave it open whether Zoho created the record: a timeout, a dropped connection, a non-JSON (5xx) body.
// A clean Zoho rejection ("ERROR: <code> ...") never created anything.
const MAY_HAVE_CREATED = /timeout|timed out|abort|fetch failed|ECONN|EPIPE|socket|JSON|Unexpected/i;

function readCreatedId(jsonPath) {
  try {
    const v = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))._zohoCreatedId;
    return v ? String(v) : null;
  } catch { return null; }
}

// Written before the CV attach, so a kill or a lost answer cannot make the created record look pre-existing later.
function recordCreatedId(jsonPath, zohoId) {
  try {
    const profile = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (profile._zohoCreatedId === String(zohoId)) return;
    profile._zohoCreatedId = String(zohoId);
    fsx.writeJsonAtomic(jsonPath, profile, 0o600);
  } catch { /* best effort: the worst case is the legacy behaviour */ }
}

// A row skipped because the database already has a Zoho id can still hold a CV whose attach failed earlier (or a
// crash hit between the database write and the cleanup). When the candidate file proves this pipeline created that
// very record, attach the CV now and clear the leftovers; otherwise leave them to the retention sweep.
async function settleLeftovers(deps, cand, zohoId, jsonPath, cvPath, protectAlternate) {
  if (!zohoId || !jsonPath || !cvPath || !fs.existsSync(jsonPath) || readCreatedId(jsonPath) !== String(zohoId)) return null;
  let attached = false;
  try {
    const r = await deps.attachResume(zohoId, cvPath);
    attached = !!(r && r.ok);
  } catch { attached = false; }
  if (!attached) return { attached: false };
  retention.removeCandidateArtifacts({
    dir: DOWNLOADS, id: cand.id, source: cand.source === 'reed' ? 'reed' : 'caterer', jailRoots: [DOWNLOADS], protectAlternate, cvPath,
  });
  return { attached: true };
}

// One corrupt candidate file or hostile CV must not end the run for everyone: a throw or a stall becomes "nothing recovered".
async function fillGuarded(deps, cfg, jsonPath, cvPath, id) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => deps.fillMandatoryFields(jsonPath, cvPath)),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${cfg.fillTimeoutMs} ms`)), cfg.fillTimeoutMs); }),
    ]);
  } catch (err) {
    const msg = String((err && err.message) || err).slice(0, 120);
    console.log(`  [${id}] WARN mandatory-field recovery failed (${msg}) - continuing without it`);
    logError('fill_mandatory', msg, { candidateId: String(id) });
    return { patched: false, recovered: [], enriched: [], stillMissing: [] };
  } finally {
    clearTimeout(timer);
  }
}

function makeGate(limit) {
  let active = 0;
  const waiters = [];
  return async (fn) => {
    if (active >= Math.max(1, limit)) await new Promise(resolve => waiters.push(resolve));
    active++;
    try { return await fn(); } finally {
      active--;
      const next = waiters.shift();
      if (next) next();
    }
  };
}

async function downloadCvViaScriptReal(encId, auditId, candidateId, config) {
  const args = [DL_SCRIPT, String(encId), String(auditId || ''), DOWNLOADS, String(candidateId)];
  try {
    await execFileAsync(process.execPath, args, { cwd: paths.HOME, timeout: (config && config.childTimeoutMs) || 30000, encoding: 'utf8', windowsHide: true });
  } catch (err) {
    // The script may exit non-zero on a warning; check whether the file appeared.
    const p = findExistingCv(candidateId);
    if (p) return { cvPath: p, size: fs.statSync(p).size };
    const msg = (err.stdout || err.stderr || err.message || '').toString().slice(0, 200);
    return { error: msg, timedOut: err.killed === true };
  }
  const p = findExistingCv(candidateId);
  if (p) return { cvPath: p, size: fs.statSync(p).size };
  return { error: 'Script exited but file not found' };
}

// caterer-get-credits.js budgets 40 s + 40 s + 25 s plus a retry read; a shorter parent timeout kills a read that would have succeeded.
const CREDITS_TIMEOUT_MS = 120000;

// Live credit read when the queue carried none. Exit 2 from the script means "stale fallback value".
// opts.exec replaces execFileSync (tests only).
function getCreditsReal(opts) {
  const exec = (opts && opts.exec) || execFileSync;
  try {
    const out = exec(process.execPath, [path.join(paths.SCRIPTS, 'caterer-get-credits.js')], {
      cwd: paths.HOME, timeout: CREDITS_TIMEOUT_MS, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const match = out.match(/^\d+$/m);
    return { credits: match ? match[0] : null, source: 'phase2-fallback' };
  } catch (e) {
    if (e.status === 2 && e.stdout) {
      const m = e.stdout.toString().match(/^\d+$/m);
      return { credits: m ? m[0] : null, source: 'fallback-stale' };
    }
    return { credits: null, source: 'phase2-completion' };
  }
}

async function getZohoIdFromDb(deps, id, source) {
  try {
    if (!source || source === 'caterer') {
      return deps.candidateDb.getZohoId(Number(id)) || null;
    }
    if (source === 'reed') {
      try {
        const db = deps.candidateDb.getDb();
        const row = db.prepare('SELECT zoho_id FROM candidates WHERE reed_id = ?').get(Number(id));
        if (row && row.zoho_id) return row.zoho_id;
      } catch { /* fall through */ }
      try {
        const db = deps.candidateDb.getDb();
        const row = db.prepare("SELECT zoho_id FROM candidates WHERE caterer_id = ? AND source = 'reed'").get(Number(id));
        return (row && row.zoho_id) || null;
      } catch { /* fall through */ }
    }
    return null;
  } catch {
    return null;
  }
}

async function runConcurrent(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function runNext() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) workers.push(runNext());
  await Promise.all(workers);
  return results;
}

function timingSummary(arr) {
  const vals = arr.filter(t => !t.error).map(t => t.secs);
  if (!vals.length) return null;
  const sum = vals.reduce((a, b) => a + b, 0);
  return {
    count: vals.length,
    totalSecs: +sum.toFixed(1),
    avgSecs: +(sum / vals.length).toFixed(2),
    minSecs: +Math.min(...vals).toFixed(2),
    maxSecs: +Math.max(...vals).toFixed(2),
  };
}

function safeLabel(v) {
  return String(v).slice(0, 40).replace(/[^ -~]/g, '?');
}

function safeAtomicWrite(file, obj, mode) {
  fsx.writeJsonAtomic(file, obj, mode);
}

function readPendingFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
}

// A pending file that asked for Reed but got a caterer-only run is kept this many extra times (Reed on only), then dropped.
const SOURCE_MISMATCH_MAX_RETRIES = 2;

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function run(queuePathArg, injected) {
  const deps = makeDeps(injected);
  const cfg = deps.config;
  const sleep = deps.sleep;
  let runState = null;

  try {
    if (!queuePathArg) {
      console.error('Usage: node scripts/process-approved-queue.js <queue.json>');
      return { code: 1, reason: 'usage' };
    }

    const absQueuePath = path.resolve(queuePathArg);
    if (!fs.existsSync(absQueuePath)) {
      console.error(`Queue file not found: ${absQueuePath}`);
      return { code: 1, reason: 'queue-missing' };
    }

    let queue;
    try {
      queue = JSON.parse(fs.readFileSync(absQueuePath, 'utf8'));
    } catch (err) {
      console.error(`Invalid JSON in queue file: ${err.message}`);
      return { code: 1, reason: 'queue-invalid-json' };
    }

    // Reprocess guard: a completed phase2-results file for this exact queue means it already ran. The results
    // are named after the run id, i.e. the queue name without the approved-queue- prefix (the legacy guard looked
    // for the prefixed name and so never fired for approved-queue-<ts>, letting a second run overwrite the results
    // and the run_results row with zeros). --force re-runs it on purpose (failed pushes after an outage): the
    // results then go to a separate -rerun- file and the territory and pending search are left alone.
    const queueBasename = path.basename(absQueuePath, '.json');
    const priorRunId = queueBasename.replace(/^approved-queue-/, '');
    const expectedResultsPath = path.join(path.dirname(absQueuePath), `phase2-results-${priorRunId}.json`);
    let rerun = false;
    if (fs.existsSync(expectedResultsPath)) {
      try {
        const prior = JSON.parse(fs.readFileSync(expectedResultsPath, 'utf8'));
        if (prior && prior.completedAt) {
          if (!deps.force) {
            console.log(`[Phase 2] ALREADY_PROCESSED: ${queueBasename} completed at ${prior.completedAt} - skipping duplicate run (use --force to retry the failed pushes)`);
            return { code: 0, reason: 'already-processed' };
          }
          rerun = true;
        }
      } catch { /* unreadable: fall through and reprocess */ }
    }

    const {
      searchDate, jobTitle, location,
      distance = null,
      activeWithin = null,
      keywords = '',
      cvLimit = null,
      priority = null,
      candidateCount = null,
      creditsRemaining = null,
      phase1StartedAt = null,
      requestedAt = null,
      candidates: rawCandidates = [],
      phase1Stats = {},
      screeningModel = null,
    } = queue;

    const catererP1 = (phase1Stats.caterer && typeof phase1Stats.caterer === 'object') ? phase1Stats.caterer : phase1Stats;
    const reedP1 = (phase1Stats.reed && typeof phase1Stats.reed === 'object') ? phase1Stats.reed : {};
    // A Reed half that stopped because screening was down leaves the territory due, exactly like the Caterer half.
    const reedHalted = reedP1.screeningHalted === true || phase1Stats.screeningHalted === true;
    const incompleteRun = catererP1.incomplete ? String(catererP1.incomplete).slice(0, 60) : (reedHalted ? 'reed-screening-unavailable' : null);
    if (!Array.isArray(rawCandidates)) {
      console.error('Queue field `candidates` is invalid (expected array).');
      return { code: 1, reason: 'candidates-invalid' };
    }
    // A non-object entry becomes an id-less candidate, which is reported as INVALID_ID below.
    const candidates = rawCandidates.map(c => (c && typeof c === 'object' ? c : {}));

    fsx.ensureDir(RUNS_DIR);
    fsx.ensureDir(LOGS_DIR);

    const startedAt = new Date().toISOString();
    const today = (searchDate || startedAt.slice(0, 10));
    const runId = rerun
      ? `${priorRunId}-rerun-${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}`
      : path.basename(absQueuePath).replace(/^approved-queue-/, '').replace(/\.json$/, '');

    // Hold the pipeline lock: phase2_starting has a 30-minute max age.
    {
      const phase1File = findPhase1StatusFile(absQueuePath, ['phase1_complete', 'phase1_running', 'phase1_initializing'], { jobTitle, location });
      if (phase1File) {
        try {
          const existing = JSON.parse(fs.readFileSync(phase1File, 'utf8'));
          Object.assign(existing, { status: 'phase2_starting', phase2Status: 'running', updatedAt: new Date().toISOString() });
          safeAtomicWrite(phase1File, existing);
          console.log(`[Phase 2] Lock extended: ${path.basename(phase1File)} -> phase2_starting`);
        } catch (e) {
          console.log(`[Phase 2] WARN: Could not update phase1 status to phase2_starting: ${e.message}`);
        }
      }
    }

    runState = makeRunState(runId, { jobTitle, location, distance, keywords, phase1: phase1Stats, candidates, requestedAt, phase1StartedAt });

    console.log(`[Phase 2] Processing ${candidates.length} candidates for ${jobTitle} in ${location}`);
    console.log(`          Queue date: ${searchDate} | Run ID: ${runId}`);
    if (candidates.length === 0) {
      console.log('[Phase 2] Empty queue received - will still write results and update territory map.');
    }
    console.log('');

    // CV screening (CV_SCREEN off|shadow|on, default shadow, docs/CV-SCREENING.md). An outage in mode on holds the whole queue with every CV kept.
    const cvMode = deps.cvScreenMode();
    const cvCfg = cvMode === 'off' ? null : deps.cvConfig();
    if (cvCfg) for (const w of cvCfg.warnings) console.log(`[Phase 2] WARN cv config: ${w}`);
    const cvRejected = new Map();
    const holdRun = (detail, held, reasonKey) => {
      console.log(`[Phase 2] HELD: CV screening is unavailable (${detail}) - ${held} candidate(s) stay queued with their CVs; nothing further was pushed or approved. The stranded-run recovery retries this queue.`);
      cvStage.raiseOutage({ detail, jobTitle, location, runId, held, reasonKey });
      runState.update({ status: 'error', error: 'cv-screening-unavailable', completedAt: new Date().toISOString() });
      const p1 = findPhase1StatusFile(absQueuePath, ['phase2_starting', 'phase1_complete', 'phase1_running', 'phase1_initializing'], { jobTitle, location });
      if (p1) {
        try {
          const existing = JSON.parse(fs.readFileSync(p1, 'utf8'));
          const rec = existing.phase2Recovery;
          if (rec && rec.attempts > 0) rec.attempts -= 1; // an outage must not use up the recovery attempts of the run
          Object.assign(existing, { updatedAt: new Date().toISOString(), phase2Hold: { reason: 'cv-screening-unavailable', at: new Date().toISOString() } });
          safeAtomicWrite(p1, existing);
        } catch { /* the status file is a hint only */ }
      }
      return { code: 2, reason: 'cv-screening-unavailable', held, runId };
    };
    if (cvMode === 'on' && candidates.length > 0 && cvStage.screeningHalted()) return holdRun('the screening halt is up', candidates.length);

    // Refresh the Zoho token once so child calls do not trigger their own refreshes.
    console.log('[Phase 2] Refreshing Zoho OAuth token...');
    try {
      await deps.refreshToken();
      console.log('[Phase 2] Token refreshed OK - starting pipeline');
    } catch (err) {
      console.log(`[Phase 2] Token refresh warning (will retry inline): ${(err.message || String(err)).slice(0, 80)}`);
    }

    fsx.ensureDir(DOWNLOADS);

    // ---- Step 2: resume detection -----------------------------------------------------------
    console.log('[Phase 2] Step 2 - Resume detection...');
    const toDownload = [];
    const toSkipZoho = new Set();
    const noEmailSkip = new Map();
    const invalidIdSkip = new Map();
    const idSources = new Map();
    const removeCvArtifacts = (cand, cvPath) => {
      const sources = idSources.get(String(cand.id));
      return retention.removeCandidateArtifacts({
        dir: DOWNLOADS, id: cand.id, source: cand.source === 'reed' ? 'reed' : 'caterer', jailRoots: [DOWNLOADS], protectAlternate: !!(sources && sources.size > 1), cvPath,
      });
    };

    for (const cand of candidates) {
      if (!retention.isSafeId(cand.id)) {
        console.log(`  [${safeLabel(cand.id)}] INVALID_ID - candidate skipped`);
        invalidIdSkip.set(String(cand.id), 'INVALID_ID - candidate id is not numeric, skipped');
        toSkipZoho.add(cand.id);
        continue;
      }
      const key = String(cand.id);
      if (!idSources.has(key)) idSources.set(key, new Set());
      idSources.get(key).add(cand.source === 'reed' ? 'reed' : 'caterer');

      const existingZohoId = await getZohoIdFromDb(deps, cand.id, cand.source);
      if (existingZohoId) {
        console.log(`  [${cand.id}] Already in Zoho (${existingZohoId}) - skipping`);
        toSkipZoho.add(cand.id);
      }

      // Idempotent re-run: a CV that screening rejected earlier for this job title is neither downloaded nor pushed again.
      if (cvMode === 'on' && !existingZohoId) {
        const earlier = cvStage.findEarlierRejection(deps, cand, jobTitle);
        if (earlier) {
          console.log(`  [${cand.id}] Rejected by CV screening in an earlier run (${earlier.reason}) - not downloaded again`);
          cvRejected.set(key, { reasonCodes: earlier.reason.replace(/^cv:/, '').split(','), earlier: true, recorded: true });
          toSkipZoho.add(cand.id);
          removeCvArtifacts(cand, null);
          continue;
        }
      }

      const cvExists = findExistingCv(cand.id, cand.source);
      if (!cvExists && !toSkipZoho.has(cand.id)) {
        toDownload.push(cand);
      } else if (cvExists) {
        console.log(`  [${cand.id}] CV already present: ${path.basename(cvExists)}`);
      }
    }

    const catererGate = makeGate(cfg.catererDownloadConcurrency);
    const dlTimings = [];
    const pushTimings = [];
    const flatStats = flattenPhase1Stats(phase1Stats);
    const phase1CompletedAt = flatStats.phase1CompletedAt || null;
    const handoffTimeSecs = (phase1CompletedAt && startedAt)
      ? Math.round((new Date(startedAt) - new Date(phase1CompletedAt)) / 1000)
      : null;

    // ---- Step 3: parallel CV downloads ------------------------------------------------------
    const downloadStepStartMs = Date.now();
    if (toDownload.length > 0) {
      console.log(`\n[Phase 2] Step 3 - Downloading ${toDownload.length} CVs (concurrency ${cfg.concurrency})...`);

      await runConcurrent(toDownload, async (cand) => {
        const dlStart = Date.now();
        let result;
        const candSource = cand.source || 'caterer';

        if (candSource === 'reed') {
          try {
            const reedResult = await deps.reedDownloadCandidate({
              candidateId: cand.id,
              queryId: cand.queryId || null,
              keywords: cand.keywords || jobTitle || '',
              outputDir: DOWNLOADS,
            });
            cand._reedProfile = reedResult.profileData;
            if (reedResult.cvPath) {
              const size = fs.statSync(reedResult.cvPath).size;
              result = { cvPath: reedResult.cvPath, size };
            } else {
              result = { cvPath: null, size: 0, profileOnly: true };
            }
          } catch (err) {
            result = { error: err.message };
          }
        } else {
          // A thrown network/session error is recorded as this candidate's download error; the
          // legacy code let it abort the whole run and strand every approved candidate.
          try {
            result = await catererGate(() => downloadCatererCv(deps, cfg, cand));
          } catch (err) {
            result = { error: (err && err.message) || String(err) };
          }
        }

        const dlSecs = (Date.now() - dlStart) / 1000;
        if (result.error) {
          dlTimings.push({ id: String(cand.id), secs: dlSecs, error: result.error });
          console.log(`  [${cand.id}] CV download failed: ${result.error}`);
          logError('cv_download', result.error, { candidateId: String(cand.id), source: candSource, jobTitle, location });
        } else if (result.profileOnly) {
          dlTimings.push({ id: String(cand.id), secs: dlSecs, sizeKb: 0, warning: 'profileOnly_no_cv' });
          console.log(`  [${cand.id}] WARN Profile downloaded but NO CV file - email recovery may fail`);
        } else if (result.cvPath) {
          const sizeKb = result.size ? Math.round(result.size / 1024) : 0;
          const fname = path.basename(result.cvPath);
          dlTimings.push({ id: String(cand.id), secs: dlSecs, sizeKb });
          console.log(`  [${cand.id}] CV downloaded: ${fname} (${sizeKb}KB, ${dlSecs.toFixed(1)}s)`);
        }
      }, cfg.concurrency);
    } else {
      console.log('\n[Phase 2] Step 3 - No CVs to download (all present or skipped)');
    }

    // ---- Step 4: candidate JSON -------------------------------------------------------------
    console.log('\n[Phase 2] Step 4 - Writing candidate JSON files...');

    for (const cand of candidates) {
      if (toSkipZoho.has(cand.id)) continue;

      const jsonPath = path.join(DOWNLOADS, retention.candidateJsonName(cand.id));
      if (fs.existsSync(jsonPath)) {
        console.log(`  [${cand.id}] JSON already present`);
        continue;
      }

      try {
        fsx.writeJsonAtomic(jsonPath, buildProfile(deps, cand, { jobTitle, location, distance }), 0o600);
        console.log(`  [${cand.id}] Written`);
      } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 120);
        console.log(`  [${cand.id}] WARN candidate JSON not written: ${msg}`);
        logError('candidate_json', msg, { candidateId: String(cand.id) });
      }
    }

    // ---- Step 4.5: pre-push mandatory field recovery ----------------------------------------
    console.log('\n[Phase 2] Step 4.5 - Pre-push mandatory field check...');

    for (const cand of candidates) {
      if (toSkipZoho.has(cand.id)) continue;

      const jsonPath4 = path.join(DOWNLOADS, retention.candidateJsonName(cand.id));
      const cvPath4 = findExistingCv(cand.id, cand.source);
      if (!fs.existsSync(jsonPath4)) continue;

      const { recovered, enriched, stillMissing } = await fillGuarded(deps, cfg, jsonPath4, cvPath4, cand.id);

      if (recovered.length) {
        console.log(`  [${cand.id}] Auto-filled: ${recovered.map(r => String(r).split('=')[0]).join(', ')}`);
      }
      if (enriched && enriched.length) {
        console.log(`  [${cand.id}] Postcode enriched: ${enriched.map(r => String(r).split('=')[0]).join(', ')}`);
      }
      if (stillMissing.includes('Email')) {
        const noEmailMsg = 'NO_EMAIL - no email on profile or CV, Zoho push skipped';
        console.log(`  [${cand.id}] WARN ${noEmailMsg}`);
        noEmailSkip.set(String(cand.id), noEmailMsg);
        toSkipZoho.add(cand.id);
      } else if (stillMissing.length) {
        console.log(`  [${cand.id}]  Still missing: ${stillMissing.join(', ')} - will attempt Zoho (may fail)`);
      }
    }

    // ---- Step 4.6: CV screening (CV_SCREEN=on|shadow) -----------------------------------------
    let cvSummary = null;
    const cvShadowHalted = cvMode === 'shadow' && cvStage.screeningHalted();
    if (cvShadowHalted) console.log('\n[Phase 2] WARN CV screening (shadow) skipped: the screening halt is up, so Jev is not reachable; nothing was blocked');
    if (cvMode !== 'off' && !cvShadowHalted) {
      // cfg.cvScreenConcurrency is only a test seam; the setting is CV_SCREEN_CONCURRENCY / jev.concurrency of the criteria file
      const cvConcurrency = Math.max(1, Math.round(Number(cfg.cvScreenConcurrency) || cvCfg.jev.concurrency));
      console.log(`\n[Phase 2] Step 4.6 - CV screening (${cvMode}, up to ${cvConcurrency} at a time)...`);
      const cvRun = await cvStage.screenCandidates({
        deps, cfg: cvCfg, mode: cvMode, candidates,
        skip: c => toSkipZoho.has(c.id) || !retention.isSafeId(c.id),
        findCv: c => findExistingCv(c.id, c.source),
        jsonPathOf: c => path.join(DOWNLOADS, retention.candidateJsonName(c.id)),
        jobTitle, runId, concurrency: cvConcurrency, timeoutMs: cfg.cvScreenTimeoutMs,
        applyReject: (c, cvPath, codes) => {
          const rec = cvStage.recordRejection(deps, c, jobTitle, codes);
          if (rec.ok) removeCvArtifacts(c, cvPath);
          else logError('cv_reject_record', rec.error, { candidateId: String(c.id), jobTitle, location });
          return { recorded: rec.ok };
        },
      });
      cvSummary = cvRun.stats;
      for (const [id, o] of cvRun.outcomes) {
        if (o.screened) console.log(`  [${id}] CV ${o.decision} -> ${o.action === 'reject' ? 'REJECTED' : 'continue'} (${o.lane}${o.forced ? ', forced' : ''}: ${o.reasonCodes.join(',')})`);
        else if (o.why === 'no-cv') console.log(`  [${id}] no CV file - not screened`);
      }
      if (cvRun.unavailable) {
        const held = [...cvRun.outcomes.values()].filter(o => o.action === 'held').length;
        return holdRun(cvRun.unavailable.detail || 'Jev unavailable', held, cvRun.unavailable.reasonKey);
      }
      if (cvRun.shadowStopped) console.log(`[Phase 2] WARN CV screening (shadow) stopped after ${cvRun.shadowStopped.failures} CVs in a row could not be screened (${cvRun.shadowStopped.detail}); ${cvSummary.unscreened} candidate(s) were not screened; nothing was blocked`);
      else if (cvMode === 'shadow' && cvSummary.unscreened) console.log(`[Phase 2] WARN CV screening (shadow) could not reach Jev for ${cvSummary.unscreened} candidate(s); nothing was blocked`);
      for (const cand of candidates) {
        const o = cvRun.outcomes.get(String(cand.id));
        if (o && o.action === 'reject') {
          cvRejected.set(String(cand.id), { reasonCodes: o.reasonCodes, recorded: o.recorded });
          toSkipZoho.add(cand.id);
        }
      }
      console.log(`[Phase 2] CV screening (${cvMode}): screened ${cvSummary.screened}, pass ${cvSummary.pass}, reject ${cvSummary.reject}, fallback ${cvSummary.review}, unreadable ${cvSummary.unreadable}; Jev-decided ${cvSummary.jev} (${cvSummary.jevShare === null ? 'n/a' : `${Math.round(cvSummary.jevShare * 1000) / 10} percent`}), forced ${cvSummary.forced}; reader errors ${cvSummary.errors}`);
      for (const a of cvStage.alertsFor(cvSummary, cvCfg, jobTitle, location)) notify(a);
    }

    // ---- Step 5: sequential Zoho push -------------------------------------------------------
    console.log('\n[Phase 2] Step 5 - Zoho push (sequential with rate limiting)...');
    const pushStepStartMs = Date.now();

    const phaseResults = [];
    const pushedInRun = new Map();
    const cleanupFailures = [];
    let attachFailures = 0;
    let cleanedCandidates = 0;

    for (const cand of candidates) {
      const pushStart = Date.now();
      const safe = retention.isSafeId(cand.id);
      const jsonPath = safe ? path.join(DOWNLOADS, retention.candidateJsonName(cand.id)) : null;
      const cvPath = safe ? findExistingCv(cand.id, cand.source) : null;
      const name = cand.name || `${cand.firstName || ''} ${cand.lastName || ''}`.trim() || String(cand.id);

      if (toSkipZoho.has(cand.id)) {
        const invalidErr = invalidIdSkip.get(String(cand.id));
        const noEmailErr = noEmailSkip.get(String(cand.id));
        if (invalidErr) {
          logError('zoho_push', invalidErr, { jobTitle, location });
          phaseResults.push({ id: String(cand.id), name, status: 'error', error: invalidErr, cvAttached: false });
        } else if (noEmailErr) {
          console.log(`  [${cand.id}] -> error (no email on profile or CV)`);
          logError('zoho_push', noEmailErr, { candidateId: String(cand.id), jobTitle, location });
          phaseResults.push({ id: String(cand.id), name, status: 'error', error: noEmailErr, cvAttached: !!cvPath });
        } else if (cvRejected.has(String(cand.id))) {
          const cvRej = cvRejected.get(String(cand.id));
          console.log(`  [${cand.id}] -> rejected by CV screening (${cvRej.reasonCodes.join(',')}) - not pushed${cvRej.earlier ? ' (decided in an earlier run)' : ''}`);
          phaseResults.push({ id: String(cand.id), name, status: 'cv_rejected', source: cand.source || 'caterer', reasonCodes: cvRej.reasonCodes, cvAttached: false });
        } else {
          const existingZohoId = await getZohoIdFromDb(deps, cand.id, cand.source);
          console.log(`  [${cand.id}] -> already in Zoho (${existingZohoId}) - skipped`);
          const skippedRow = { id: String(cand.id), name, status: 'skipped', zohoId: existingZohoId, cvAttached: !!cvPath };
          phaseResults.push(skippedRow);
          const settled = await settleLeftovers(deps, cand, existingZohoId, jsonPath, cvPath, !!(idSources.get(String(cand.id)) && idSources.get(String(cand.id)).size > 1));
          if (settled && settled.attached) {
            cleanedCandidates++;
            skippedRow.cvAttached = true;
            console.log(`  [${cand.id}] -> CV left over from an earlier attempt attached now`);
          }
        }
        continue;
      }

      // The same candidate listed twice in one queue: the first push already removed the JSON. The
      // legacy code pushed it again and Zoho answered DUPLICATE_DATA; record that outcome directly.
      const pushKey = `${cand.source === 'reed' ? 'reed' : 'caterer'}:${cand.id}`;
      if (!fs.existsSync(jsonPath) && pushedInRun.has(pushKey)) {
        console.log(`  [${cand.id}] -> already pushed earlier in this run - counted as duplicate`);
        phaseResults.push({ id: String(cand.id), name, status: 'duplicate', source: cand.source || 'caterer', zohoId: pushedInRun.get(pushKey), cvAttached: false });
        continue;
      }

      if (!fs.existsSync(jsonPath)) {
        console.log(`  [${cand.id}] -> WARN No candidate JSON - skipping Zoho push`);
        phaseResults.push({ id: String(cand.id), name, status: 'error', error: 'No candidate JSON' });
        continue;
      }

      let zohoId = null;
      let isDuplicate = false;
      let pushError = null;
      const maxRetries = cfg.maxRetries;
      let delay = cfg.retryDelayMs;
      // Evidence that a DUPLICATE_DATA answer is about a record this pipeline created itself (lost response on an
      // earlier attempt, or a kill between the create and the database write); such a record still needs its CV.
      const recordedId = readCreatedId(jsonPath);
      let ambiguousCreate = false;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const candidatePayload = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          const created = await deps.createCandidate(candidatePayload);
          zohoId = created.zohoId;
          isDuplicate = created.isDuplicate;
          pushError = null;
          break;
        } catch (err) {
          pushError = (err.message || String(err)).slice(0, 300);
          if (MAY_HAVE_CREATED.test(pushError)) ambiguousCreate = true;
          if (attempt < maxRetries) {
            console.log(`    Retry ${attempt}/${maxRetries - 1} in ${delay / 1000}s...`);
            await sleep(delay);
            delay *= 2;
          }
        }
      }

      // Mandatory field recovery fallback for edge cases
      if (!zohoId && pushError && pushError.includes('MANDATORY_NOT_FOUND')) {
        const apiMatch = pushError.match(/"api_name"\s*:\s*"([^"]+)"/);
        const missingField = apiMatch ? apiMatch[1] : 'unknown';
        console.log(`  [${cand.id}] -> Zoho rejected (missing ${missingField}) - attempting recovery...`);

        const { patched, recovered, stillMissing } = await fillGuarded(deps, cfg, jsonPath, cvPath, cand.id);

        if (patched) {
          console.log(`  [${cand.id}] -> Filled: ${recovered.map(r => String(r).split('=')[0]).join(', ')} - retrying Zoho...`);
          try {
            const candidatePayload = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            const created = await deps.createCandidate(candidatePayload);
            zohoId = created.zohoId;
            isDuplicate = created.isDuplicate;
            pushError = null;
          } catch (recErr) {
            pushError = `Field recovery exception: ${(recErr.message || String(recErr)).slice(0, 200)}`;
            if (MAY_HAVE_CREATED.test(pushError)) ambiguousCreate = true;
          }
        } else {
          const msg = stillMissing.length
            ? `still missing after recovery: ${stillMissing.join(', ')}`
            : 'no fields to fill';
          console.log(`  [${cand.id}] -> WARN ${msg} - cannot auto-recover`);
          pushError = `MANDATORY_NOT_FOUND ${missingField} (${msg})`;
        }
      }

      if (!zohoId) {
        console.log(`  [${cand.id}] -> ERROR: ${pushError} (attempt ${maxRetries}/${maxRetries} failed)`);
        logError('zoho_push', pushError, { candidateId: String(cand.id), jobTitle, location, retriesExhausted: maxRetries });
        phaseResults.push({ id: String(cand.id), name, status: 'error', error: pushError, cvAttached: false });
        if (cand !== candidates[candidates.length - 1]) await sleep(cfg.zohoDelayMs);
        continue;
      }

      // DUPLICATE_DATA for the very record this pipeline created earlier (same id on file, or an earlier attempt
      // whose answer was lost): it is ours, so it still needs its CV and counts as new. A record that pre-existed
      // stays untouched.
      if (isDuplicate && ((recordedId && recordedId === String(zohoId)) || ambiguousCreate)) {
        isDuplicate = false;
        console.log(`  [${cand.id}] -> record ${zohoId} was created by this pipeline earlier - attaching the CV`);
      }
      if (!isDuplicate) recordCreatedId(jsonPath, zohoId);

      // Zoho holds the candidate from here on. Whatever happens next in this block, the local
      // CV and candidate JSON are removed in the finally clause once they are no longer needed.
      let cvAttached = false;
      let cleanupEligible = false;
      try {
        // A duplicate already exists in Zoho (only CatererID linking was done): nothing to attach.
        if (!isDuplicate && cvPath) {
          try {
            const attachResult = await deps.attachResume(zohoId, cvPath);
            cvAttached = !!attachResult.ok;
            if (!cvAttached) {
              const attachErr = JSON.stringify(attachResult.data).slice(0, 200);
              console.log(`    WARN CV attach failed: ${attachErr}`);
              logError('cv_attach', attachErr, { candidateId: String(cand.id), zohoId, jobTitle, location });
            }
          } catch (attachEx) {
            cvAttached = false;
            const attachErr = (attachEx.message || String(attachEx)).slice(0, 200);
            console.log(`    WARN CV attach exception: ${attachErr}`);
            logError('cv_attach', attachErr, { candidateId: String(cand.id), zohoId, jobTitle, location });
          }
          if (!cvAttached) attachFailures++;
        }

        cleanupEligible = retention.shouldDeleteCandidateArtifacts({ zohoId, cvAttached, isDuplicate });

        // Local tracking only: safe to write regardless of duplicate status.
        try {
          const candSourcePush = cand.source || 'caterer';
          if (candSourcePush === 'reed') {
            try {
              const db = deps.candidateDb.getDb();
              try {
                db.prepare('UPDATE candidates SET zoho_id = ? WHERE reed_id = ?').run(String(zohoId), Number(cand.id));
              } catch {
                db.prepare("UPDATE candidates SET zoho_id = ? WHERE caterer_id = ? AND source = 'reed'").run(String(zohoId), Number(cand.id));
              }
            } catch (err) {
              console.log(`    WARN DB update failed (Reed): ${(err.message || String(err)).slice(0, 100)}`);
            }
          } else {
            deps.candidateDb.setZohoId(Number(cand.id), String(zohoId));
          }
        } catch (err) {
          console.log(`    WARN DB update failed: ${(err.message || String(err)).slice(0, 100)}`);
        }

        runState.update({ status: 'phase2_pushing', phase2: {
          pushed: phaseResults.filter(r => r.status === 'new').length + (isDuplicate ? 0 : 1),
          duplicates: phaseResults.filter(r => r.status === 'duplicate').length + (isDuplicate ? 1 : 0),
          errors: phaseResults.filter(r => r.status === 'error').length,
        } });

        let statusTag;
        let attachTag;
        if (isDuplicate) {
          statusTag = `ALREADY IN ZOHO ${zohoId}`;
          attachTag = 'no changes made OK';
        } else {
          statusTag = `ZOHO_ID=${zohoId}`;
          attachTag = cvAttached ? 'CV attached OK' : (cvPath ? 'WARN CV attach failed' : 'WARN no CV');
        }
        console.log(`  [${cand.id}] -> ${statusTag} | ${attachTag}`);

        const pushSecs = (Date.now() - pushStart) / 1000;
        pushTimings.push({ id: String(cand.id), secs: pushSecs, status: isDuplicate ? 'duplicate' : (zohoId ? 'new' : 'error') });

        pushedInRun.set(pushKey, zohoId);
        phaseResults.push({
          id: String(cand.id),
          name,
          status: isDuplicate ? 'duplicate' : 'new',
          source: cand.source || 'caterer',
          zohoId,
          cvAttached,
        });
      } finally {
        if (cleanupEligible) {
          const sources = idSources.get(String(cand.id));
          const rm = retention.removeCandidateArtifacts({
            dir: DOWNLOADS,
            id: cand.id,
            source: cand.source === 'reed' ? 'reed' : 'caterer',
            jailRoots: [DOWNLOADS],
            protectAlternate: !!(sources && sources.size > 1),
            cvPath,
          });
          if (rm.removed.length) cleanedCandidates++;
          if (rm.failed.length) {
            cleanupFailures.push({ id: String(cand.id), failed: rm.failed });
            console.log(`    WARN cleanup could not remove: ${rm.failed.map(f => `${f.name} (${f.reason})`).join(', ')}`);
            logError('cv_cleanup', rm.failed.map(f => `${f.name}:${f.reason}`).join(','), { candidateId: String(cand.id) });
          }
        }
      }

      if (cand !== candidates[candidates.length - 1]) await sleep(cfg.zohoDelayMs);
    }

    // ---- Step 6: results ---------------------------------------------------------------------
    const completedAt = new Date().toISOString();
    const runtimeSecs = Math.round((new Date(completedAt) - new Date(startedAt)) / 1000);
    const trueStartTime = requestedAt || phase1StartedAt;
    const totalRuntimeSecs = trueStartTime
      ? Math.round((new Date(completedAt) - new Date(trueStartTime)) / 1000)
      : null;
    const resultsPath = path.join(DOWNLOADS, `phase2-results-${runId}.json`);

    const newCount = phaseResults.filter(r => r.status === 'new').length;
    const dupCount = phaseResults.filter(r => r.status === 'duplicate').length;
    const skipCount = phaseResults.filter(r => r.status === 'skipped').length;
    const cvRejectedCount = phaseResults.filter(r => r.status === 'cv_rejected').length;
    const pushErrCount = phaseResults.filter(r => r.status === 'error').length;
    const dlErrCount = dlTimings.filter(t => t.error).length;
    const totalErrCount = pushErrCount + dlErrCount;
    const dlCount = toDownload.length;

    const downloadStepSecs = +((Date.now() - downloadStepStartMs) / 1000).toFixed(1);
    const pushStepSecs = +((Date.now() - pushStepStartMs) / 1000).toFixed(1);

    const timing = {
      totalWallClockSecs: totalRuntimeSecs,
      phase1ScrapingSecs: flatStats.scrapingTimeSecs ?? null,
      sessionValidationSecs: flatStats.sessionValidationTimeSecs ?? null,
      handoffSecs: handoffTimeSecs,
      phase2TotalSecs: runtimeSecs,
      phase2DownloadStepSecs: downloadStepSecs,
      phase2PushStepSecs: pushStepSecs,
      avgTimePerPageSecs: flatStats.avgTimePerPageSecs ?? null,
      avgTimePerBrowserRoundtripSecs: flatStats.avgTimePerBrowserRoundtrip ?? null,
      cvDownload: timingSummary(dlTimings),
      zohoPush: timingSummary(pushTimings),
      pageTimings: flatStats.pageTimings ?? null,
    };

    // With Reed off (RESOURCER_SOURCES) a run cannot have covered Reed, whatever the pending file asked for.
    const reedOn = reedAllowed(deps.allowedSources());

    const pendingSourcesHint = (() => {
      if (!reedOn || !fs.existsSync(PENDING_DIR)) return null;
      const normTitle = (jobTitle || '').toLowerCase().trim();
      const normLoc = (location || '').toLowerCase().trim();
      let names = [];
      try { names = fs.readdirSync(PENDING_DIR); } catch { return null; }
      for (const f of names) {
        if (!f.endsWith('.json')) continue;
        try {
          const p = readPendingFile(path.join(PENDING_DIR, f));
          if ((p.jobTitle || '').toLowerCase().trim() === normTitle && (p.location || '').toLowerCase().trim() === normLoc) {
            return retention.normalizeSources(p.sources);
          }
        } catch { /* one unreadable file must not hide the others; hint only */ }
      }
      return null;
    })();

    const resolvedSources = (() => {
      const fromQueue = retention.normalizeSources(queue.sources);
      if (fromQueue && fromQueue !== 'caterer') return fromQueue;
      const fromQueueSingle = retention.normalizeSources(queue.source);
      if (fromQueueSingle && fromQueueSingle !== 'caterer') return fromQueueSingle;
      const hasCaterer = candidates.some(c => !c.source || c.source === 'caterer');
      const hasReed = candidates.some(c => c.source === 'reed');
      if (hasCaterer && hasReed) return 'both';
      if (hasReed) return 'reed';
      if (pendingSourcesHint === 'both' || pendingSourcesHint === 'reed') return pendingSourcesHint;
      return 'caterer';
    })();

    const reedStatusNow = reedStatusOf(reedP1, phaseResults.filter(r => r.source === 'reed').length, resolvedSources);
    const resultsObj = {
      date: today,
      requestedAt,
      phase1StartedAt,
      startedAt,
      completedAt,
      runtimeSecs,
      totalRuntimeSecs,
      jobTitle,
      location,
      distance,
      activeWithin,
      keywords,
      cvLimit,
      candidateCount,
      creditsRemaining,
      screeningModel,
      sources: resolvedSources,
      ...(incompleteRun ? { incomplete: incompleteRun } : {}),
      ...(reedStatusNow ? { reedStatus: reedStatusNow } : {}),
      phase1: {
        candidateCount: catererP1.totalCandidatesSeen ?? candidateCount ?? null,
        pagesScraped: catererP1.pagesScraped ?? null,
        approved: catererP1.approved ?? catererP1.approvedQueue ?? null,
        skippedDb: catererP1.skippedDb ?? null,
        skippedReview: catererP1.skippedReview ?? catererP1.rejectedScreening ?? null,
        errors: catererP1.errors ?? null,
        browserRoundtrips: catererP1.browserRoundtrips ?? null,
        sessionRefreshed: catererP1.sessionRefreshed ?? null,
      },
      downloaded: dlCount,
      total: candidates.length,
      new: newCount,
      duplicates: dupCount,
      skipped: skipCount,
      errors: totalErrCount,
      downloadErrors: dlErrCount,
      pushErrors: pushErrCount,
      ...(cvSummary ? { cvRejected: cvRejectedCount, cvScreen: cvSummary } : {}),
      // Per-source breakdown: always emitted for caterer/both (reed/both) runs even with 0 candidates.
      catererStats: (() => {
        const catCands = phaseResults.filter(r => !r.source || r.source === 'caterer');
        const hasCatererPhase1 = Object.keys(catererP1).length > 0 || resolvedSources === 'caterer' || resolvedSources === 'both';
        if (!catCands.length && !hasCatererPhase1) return null;
        return {
          pool: catererP1.totalCandidatesSeen ?? candidateCount ?? 0,
          newToZoho: catCands.filter(r => r.status === 'new').length,
          downloaded: catCands.filter(r => !r.downloadError).length,
          duplicates: catCands.filter(r => r.status === 'duplicate').length,
          errors: catCands.filter(r => r.status === 'error' || r.downloadError).length,
          phase1: { pagesScraped: catererP1.pagesScraped ?? 0, approved: catererP1.approved ?? 0,
            skippedDb: catererP1.skippedDb ?? 0, skippedReview: catererP1.skippedReview ?? 0 },
        };
      })(),
      reedStats: (() => {
        const reedCands = phaseResults.filter(r => r.source === 'reed');
        const hasReedPhase1 = Object.keys(reedP1).length > 0 || resolvedSources === 'reed' || resolvedSources === 'both';
        if (!reedCands.length && !hasReedPhase1) return null;
        return {
          pool: reedP1.pool ?? reedP1.totalCandidatesSeen ?? 0,
          newToZoho: reedCands.filter(r => r.status === 'new').length,
          downloaded: reedCands.filter(r => !r.downloadError).length,
          duplicates: reedCands.filter(r => r.status === 'duplicate').length,
          // A failed Reed attempt counts one error: it never reads as a clean empty search (pool 0, errors 0).
          errors: Math.max(reedCands.filter(r => r.status === 'error' || r.downloadError).length, reedStatusNow === 'failed' ? 1 : 0),
          status: reedStatusNow,
          ...(reedStatusNow === 'failed' ? { failed: true, failureReason: reedP1.failureReason || null } : {}),
          authFailed: reedP1.authFailed || false,
          authFailureReason: reedP1.authFailureReason || null,
          phase1: { pagesScraped: reedP1.pagesScraped ?? 0, approved: reedP1.approved ?? 0,
            rejected: reedP1.rejected ?? 0, errors: reedP1.errors ?? 0,
            skippedDb: reedP1.skippedDb ?? reedP1.inDb ?? 0,
            noPermit: reedP1.noPermit ?? 0,
            authFailed: reedP1.authFailed || false,
            authFailureReason: reedP1.authFailureReason || null },
        };
      })(),
      timing,
      candidates: phaseResults,
    };

    fsx.writeJsonAtomic(resultsPath, resultsObj, 0o600);

    // run_results: aggregate stats that outlive the results file (never fails a run).
    let runResultsWritten = false;
    try {
      const backfill = require('./backfill-run-results');
      const migrateSchema = require('./migrate-schema');
      const row = backfill.buildRunResultRow(resultsObj, runId, null);
      if (!row) throw new Error('results object has no date');
      const rdb = deps.openDb();
      try {
        migrateSchema.ensureRunResults(rdb);
        backfill.writeRunResultRow(rdb, row, { replace: true });
      } finally {
        try { rdb.close(); } catch { /* ignore */ }
      }
      runResultsWritten = true;
      console.log(`[Phase 2] run_results row written: ${runId}`);
    } catch (e) {
      console.log(`[Phase 2] WARN: run_results write failed: ${(e.message || String(e)).slice(0, 120)}`);
      logError('run_results', (e.message || String(e)).slice(0, 300), { runId });
    }

    // credits-sync.json for the dashboard; live check when the queue carried no credits.
    let effectiveCredits = creditsRemaining;
    let creditsSource = 'phase2-completion';
    if (effectiveCredits == null) {
      const c = deps.getCredits();
      creditsSource = c.source;
      if (c.credits != null) effectiveCredits = c.credits;
      if (creditsSource === 'fallback-stale') {
        console.log(`[Phase 2] Credits stale fallback: ${effectiveCredits} (not writing to sync file)`);
      } else {
        console.log(`[Phase 2] Credits fallback: ${effectiveCredits || 'unavailable'}`);
      }
    }
    if (effectiveCredits != null && creditsSource !== 'fallback-stale') {
      try {
        safeAtomicWrite(paths.p('credits-sync.json'), {
          credits: Number(effectiveCredits),
          syncedAt: new Date().toISOString(),
          source: creditsSource,
        });
      } catch (syncErr) {
        console.log(`[Phase 2] WARN: credits-sync.json update failed: ${syncErr.message}`);
      }
    }

    runState.update({
      status: 'complete', completedAt,
      runtimeSecs,
      totalRuntimeSecs,
      phase2: {
        downloaded: dlCount,
        pushed: newCount,
        duplicates: dupCount,
        errors: totalErrCount,
        downloadErrors: dlErrCount,
        pushErrors: pushErrCount,
      },
    });

    // ---- territory_searches upsert (candidates.db) ------------------------------------------
    // interval_days and enabled are never touched; priority steps down when newToZoho < 5.
    // A run that stopped because screening went down did not search the territory: it stays due.
    if (rerun) {
      console.log(`[Territory] kept as is: ${jobTitle} / ${location} - a --force re-run of a finished queue never re-marks the territory`);
    } else if (incompleteRun) {
      console.log(`[Territory] kept as is: ${jobTitle} / ${location} - the run stopped early (${incompleteRun}), so it is not marked searched`);
    } else {
      const tdb = deps.openDb();
      let result;
      let reedMark = null;
      try {
        result = deps.upsertTerritory(tdb, {
          jobTitle,
          location,
          keywords: keywords || '',
          searchDistance: distance != null ? parseInt(distance, 10) : null,
          initialPriority: priority || null,
          candidateCount,
          newToZoho: newCount,
          duplicates: dupCount,
          skipped: skipCount,
          errors: totalErrCount,
          creditsRemaining,
          lastSearched: today,
        });
        // The Caterer half is real and marks the territory searched; the Reed half is bookkept on its own (rule R4, territory-utils.markReedHalf).
        if (reedStatusNow) {
          try {
            reedMark = deps.markReedHalf(tdb, { jobTitle: result.jobTitle, location: result.location, keywords: result.keywords ?? (keywords || ''), distance: result.distance, status: reedStatusNow, today });
          } catch (e) {
            reedMark = { error: String((e && e.message) || e).slice(0, 120) }; // bookkeeping only: never fails the run
          }
        }
      } finally {
        try { tdb.close(); } catch { /* ignore */ }
      }
      if (reedMark && reedMark.error) console.log(`[Territory] WARN: Reed half mark failed: ${reedMark.error}`);
      else if (reedMark && reedMark.pending) console.log(`[Territory] Reed half NOT done for ${result.jobTitle} / ${result.location} (reed status ${reedStatusNow}): marked reed-pending since ${today}${reedMark.retryDate ? `, one automatic retry on ${reedMark.retryDate}` : ''}`);
      else if (reedMark && reedMark.cleared) console.log(`[Territory] Reed half done for ${result.jobTitle} / ${result.location}: reed-pending mark cleared`);
      if (result.autoDowngraded) {
        console.log(`[Territory] AUTO-DOWNGRADE: ${result.jobTitle} / ${result.location} - ${result.previousPriority} -> ${result.effectivePriority} (fewer than 5 new CVs this run)`);
        runState.update({ autoDowngraded: true, previousPriority: result.previousPriority });
      }
      console.log(`Territory DB updated: ${result.jobTitle} / ${result.location} / ${result.distance}mi -> ${today} | next: ${result.nextRunDate} (${result.effectivePriority})${result.autoDowngraded ? ' [auto-downgraded from ' + result.previousPriority + ']' : ''}`);
    }

    // ---- Step 6.5: pending search cleanup ---------------------------------------------------
    // The pending file survives a sub-agent crash by design; now that Phase 2 is done it can go.
    {
      if (!rerun && fs.existsSync(PENDING_DIR)) {
        const normTitle = (jobTitle || '').toLowerCase().trim();
        const normLoc = (location || '').toLowerCase().trim();
        for (const f of fs.readdirSync(PENDING_DIR)) {
          if (!f.endsWith('.json')) continue;
          try {
            const p = readPendingFile(path.join(PENDING_DIR, f));
            const pTitle = (p.jobTitle || '').toLowerCase().trim();
            const pLoc = (p.location || '').toLowerCase().trim();
            if (pTitle === normTitle && pLoc === normLoc) {
              if (incompleteRun) {
                delete p.spawnedAt;
                safeAtomicWrite(path.join(PENDING_DIR, f), p);
                console.log(`[Phase 2] Kept pending search file: ${f} (the run stopped early: ${incompleteRun})`);
                continue;
              }
              const pendingSources = retention.normalizeSources(p.sources) || 'caterer';
              const reedRequested = (pendingSources === 'both' || pendingSources === 'reed');
              // Reed is off: this run could not have served the request, and keeping the file would re-run the territory for ever.
              if (reedRequested && !reedOn) {
                retention.jailedUnlink([PENDING_DIR], PENDING_DIR, f);
                console.log(`[Phase 2] Deleted pending search file: ${f} (asked for sources=${pendingSources} but Reed is disabled by RESOURCER_SOURCES)`);
                continue;
              }
              // Reed auth failure: keep the pending file for a bounded retry so Reed is never silently skipped.
              const reedAuthFailed = !!(phase1Stats && phase1Stats.reed && phase1Stats.reed.authFailed);
              const REED_AUTH_MAX_RETRIES = 3;
              if (reedRequested && reedAuthFailed) {
                const attempt = (p.reedAuthRetries || 0) + 1;
                if (attempt > REED_AUTH_MAX_RETRIES) {
                  retention.jailedUnlink([PENDING_DIR], PENDING_DIR, f);
                  console.log(`[Phase 2] Reed auth-failed ${attempt - 1}x for ${jobTitle}/${location} - giving up; deleted pending ${f}. MANUAL Reed re-login required.`);
                  notify({ severity: 'critical', key: 'reed-auth-giveup', text: `Reed auth failed ${attempt - 1}x for ${jobTitle}/${location}; pending search dropped. Manual Reed re-login required.`, meta: { jobTitle, location } });
                } else {
                  p.reedAuthRetries = attempt;
                  delete p.spawnedAt;
                  safeAtomicWrite(path.join(PENDING_DIR, f), p);
                  console.log(`[Phase 2] Reed AUTH FAILURE - keeping pending ${f} for retry ${attempt}/${REED_AUTH_MAX_RETRIES} (sources=${pendingSources}) so Reed is not silently skipped.`);
                  notify({ severity: 'warn', key: 'reed-auth-failed', text: `Reed auth failed for ${jobTitle}/${location}; retry ${attempt}/${REED_AUTH_MAX_RETRIES} queued.`, meta: { jobTitle, location, attempt } });
                }
                continue;
              }

              if (reedRequested && resultsObj.sources === 'caterer') {
                const attempt = (Number(p.sourceMismatchRetries) || 0) + 1;
                if (attempt > SOURCE_MISMATCH_MAX_RETRIES) {
                  retention.jailedUnlink([PENDING_DIR], PENDING_DIR, f);
                  console.log(`[Phase 2] Deleted pending search file: ${f} (pending sources=${pendingSources} still answered by a caterer-only run after ${attempt - 1} retries)`);
                  notify({ severity: 'warn', key: 'pending-sources-mismatch-giveup', text: `Pending search ${jobTitle}/${location} asked for ${pendingSources} but ran caterer-only ${attempt} times; dropped.`, meta: { jobTitle, location } });
                } else {
                  p.sourceMismatchRetries = attempt;
                  safeAtomicWrite(path.join(PENDING_DIR, f), p);
                  console.log(`[Phase 2] WARN keeping pending file ${f} (retry ${attempt}/${SOURCE_MISMATCH_MAX_RETRIES}): pending sources=${pendingSources}, result sources=${resultsObj.sources}`);
                }
                continue;
              }

              retention.jailedUnlink([PENDING_DIR], PENDING_DIR, f);
              console.log(`[Phase 2] Deleted pending search file: ${f} (pipeline complete)`);
            }
          } catch { /* skip unreadable */ }
        }
      }
    }

    // ---- Step 6.6: wake flag (vestigial hygiene signal; the wake script call is gone) -------
    try {
      fsx.writeFileAtomic(path.join(RUNS_DIR, 'pipeline-wake.flag'), Date.now().toString());
      console.log('[Phase 2] wake.flag written');
    } catch (e) {
      console.log('[Phase 2] WARN: Could not write wake.flag: ' + e.message);
    }

    // ---- Step 7: summary ---------------------------------------------------------------------
    console.log('\n=== Phase 2 Complete ===');
    console.log(`New to Zoho:              ${newCount}`);
    console.log(`Already in Zoho (untouched): ${dupCount}`);
    console.log(`Skipped (pre-check):      ${skipCount}`);
    console.log(`Errors:                   ${totalErrCount} (download ${dlErrCount}, push ${pushErrCount})`);
    console.log(`Total processed:  ${candidates.length}`);
    console.log(`CV/JSON cleaned:  ${cleanedCandidates} candidate(s) | CV attach failures kept: ${attachFailures}`);
    if (cvSummary) console.log(`CV screening (${cvMode}): ${cvRejectedCount} rejected and not pushed | screened ${cvSummary.screened} | forced ${cvSummary.forced} | fallback ${cvSummary.fallback} (approved ${cvSummary.policyApprove}, rejected ${cvSummary.policyReject})`);
    console.log(`Results saved to: ${resultsPath}`);

    // ---- Step 7.5: alerts (replaces the legacy chat report) ----------------------------------
    {
      const attempted = phaseResults.filter(r => (r.status === 'new' || r.status === 'duplicate') ||
        (r.status === 'error' && r.error && !/^(NO_EMAIL|INVALID_ID|No candidate JSON)/.test(String(r.error)))).length;
      const succeeded = newCount + dupCount;
      const retryHint = `After Zoho works again: node scripts/process-approved-queue.js downloads/${path.basename(absQueuePath)} --force (their CVs and files are kept 14 days).`;
      if (attempted >= 3 && succeeded === 0) {
        notify({ severity: 'critical', key: 'zoho-push-failing', text: `Phase 2 for ${jobTitle}/${location}: all ${attempted} Zoho pushes failed. Check Zoho credentials. ${retryHint}`, meta: { runId, attempted } });
      } else if (attempted - succeeded > 0) {
        notify({ severity: 'warn', key: 'zoho-push-partial', text: `Phase 2 for ${jobTitle}/${location}: ${attempted - succeeded} of ${attempted} Zoho pushes failed. ${retryHint}`, meta: { runId, failed: attempted - succeeded, attempted } });
      }
      if (attachFailures > 0) {
        notify({ severity: 'warn', key: 'cv-attach-failed', text: `${attachFailures} CV attach failure(s) in ${jobTitle}/${location}; files kept for retention window.`, meta: { runId, count: attachFailures } });
      }
      if (cleanupFailures.length) {
        notify({ severity: 'warn', key: 'cv-cleanup-failed', text: `Could not delete local CV/JSON for ${cleanupFailures.length} candidate(s) after a successful push.`, meta: { runId, count: cleanupFailures.length } });
      }
      const cvUnrecorded = [...cvRejected.values()].filter(v => v.recorded === false).length;
      if (cvUnrecorded > 0) {
        notify({ severity: 'warn', key: 'cv-reject-not-recorded', text: `${cvUnrecorded} CV screening rejection(s) in ${jobTitle}/${location} could not be written to candidates.db; their files were kept and the decision is repeated on the next run.`, meta: { runId, count: cvUnrecorded } });
      }
      if (cvSummary && cvSummary.errors > 0) {
        notify({ severity: 'warn', key: 'cv-review-errors', text: `The CV reviewer failed on ${cvSummary.errors} CV(s) in ${jobTitle}/${location}; they passed through like unreadable CVs.`, meta: { runId, count: cvSummary.errors } });
      }
      if (!runResultsWritten) {
        notify({ severity: 'warn', key: 'run-results-write-failed', text: `run_results row not written for ${runId}; the retention sweep will repair it from the results file.`, meta: { runId } });
      }
    }

    // ---- Step 8: phase1 status file -> terminal "complete" ---------------------------------
    {
      const phase1File = findPhase1StatusFile(absQueuePath, ['phase2_starting', 'phase1_complete', 'phase1_running', 'phase1_initializing'], { jobTitle, location });
      if (phase1File) {
        try {
          const existing = JSON.parse(fs.readFileSync(phase1File, 'utf8'));
          const now = new Date().toISOString();
          Object.assign(existing, { status: 'complete', completedAt: now, updatedAt: now, phase2Complete: true });
          safeAtomicWrite(phase1File, existing);
          console.log(`[Phase 2] Phase1 status file updated to "complete": ${path.basename(phase1File)}`);
        } catch (e) {
          console.log(`[Phase 2] WARN: Could not update phase1 status file: ${e.message}`);
        }
      } else {
        console.log('[Phase 2] WARN: No phase1 status file found to mark as complete');
      }
    }

    return { code: 0, reason: 'done', resultsPath, runId, phaseResults, resultsObj, runResultsWritten };
  } catch (err) {
    console.error('FATAL:', err && err.message);
    logError('phase2_fatal', err && err.message);
    if (runState) runState.update({ status: 'error', error: err && err.message, completedAt: new Date().toISOString() });
    notify({ severity: 'critical', key: 'phase2-fatal', text: `Phase 2 aborted: ${String((err && err.message) || err).slice(0, 200)}` });
    return { code: 1, reason: 'fatal', error: err };
  }
}

if (require.main === module) {
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  const cliArgs = process.argv.slice(2);
  if (cliArgs[0] === '--help' || cliArgs[0] === '-h') {
    process.stdout.write('Usage: node scripts/process-approved-queue.js <queue.json> [--force]\n--force re-runs a queue that already finished (retry failed pushes); its results go to a separate -rerun- file and the territory is not re-marked.\nExit: 0 done or already processed, 1 fatal error or bad input, 2 held because CV screening (CV_SCREEN=on) could not reach Jev: nothing was lost and the queue is retried.\n');
    process.exit(0);
  }
  run(cliArgs.find(a => !a.startsWith('-')), cliArgs.includes('--force') ? { force: true } : undefined).then(res => {
    // Explicit exit: an open keep-alive socket or DB handle must not hold the process after completion.
    process.exit(res.code);
  });
}

module.exports = {
  run, makeDeps, findPhase1StatusFile, flattenPhase1Stats, findExistingCv, guessExtension,
  getZohoIdFromDb, getCreditsReal, reedAllowed, DEFAULT_CONFIG, CREDITS_TIMEOUT_MS, SOURCE_MISMATCH_MAX_RETRIES,
};
