#!/usr/bin/env node
'use strict';

// Phase 1 orchestrator for the Reed.co.uk candidate pipeline (equivalent of phase1.js for Caterer).
//
// Flow: pre-flight token refresh (with fallback to a still-valid saved token) -> Reed API search (free, paginated)
//   -> DB dedup -> cross-dedup against the Caterer queue by name+location -> AI batch screening via ai-review.js
//   -> rejections marked seen at once -> approved queue file downloads/reed-approved-queue-<runId>.json -> approvals marked seen
//   only after that file is written and read back (a kill before then leaves them unmarked, so the next run screens them again).
//
// Usage: node scripts/reed-phase1.js --job-title "Chef" --location "LS1" [--distance 20] [--cv-limit 20]
//          [--active-within month] [--uk-only true|false] [--temp-only true|false] [--caterer-queue <path>]
//          [--run-id <id>] [--skip-screening]
// Exit codes: 0 done (also: a genuine empty pool, or stopped early because AI screening is unavailable), 1 usage error / REED_AUTH_FAILED /
//             first search page failed / fatal.
// Stdout markers: REED_AUTH_FAILED, REED_FIRST_PAGE_FAILED, REED_SCREENING_HALT, REED_DAILY_LIMIT, REED_BROWSER_BUSY, REED_PHASE1_SUMMARY:<json>.
//
// First page failure (2026-09-30 incident, docs/parity/reed-first-page.md): when the first search page cannot be fetched (after the request
// retries of reed-browser-fetch.js) and the cause is not an auth problem (401/403 relogin, 451, which keep their own handling), the attempt is a
// FAILURE, not an empty search: exit 1 and `REED_FIRST_PAGE_FAILED: <reason> attempts=<n> streak=<k>` on stdout. "Total pool: 0 candidates"
// stays a normal empty result (exit 0).
//
// D4 (screening unavailable): ANY screening attempt that does not end in a successful parse (exit 3 / API_UNAVAILABLE, exit 1 or any other
// non-zero exit, timeout, signal, spawn failure, unparseable or malformed output, results that do not cover every candidate) counts as
// unavailable: candidates of that page are NOT marked seen or rejected, the page is retried after a pause, and after 3 consecutive failed
// attempts the shared pipeline halt is raised ('AI screening unavailable') and the run stops early.

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const paths = require('./lib/paths');
const env = require('./lib/env');
const fsx = require('./lib/fsx');
const { search } = require('./reed-search');
const { SESSION_FILE, AUTH_MARKER, LOGIN_COMMAND, writeReedStatus, markAuthOk, alertOnce, clearAlertEpisode, recordFirstPageFailure, clearFirstPageFailures } = require('./reed-api-client');
const launcher = require('./ensure-chrome-cdp');
const candidateDb = require('../candidates-db');

const execFileAsync = promisify(execFile);

const AI_REVIEW_SCRIPT = path.join(paths.SCRIPTS, 'caterer-ai-review.js');
const AI_REVIEW_SCRIPT_ALT = path.join(paths.SCRIPTS, 'ai-review.js');

const PAGE_SIZE = 25;
const API_FAILURES_BEFORE_HALT = 3;
const HALT_REASON = 'AI screening unavailable';
const HALT_REMEDY = 'Check the screening gateway key and credits (AI_GATEWAY_API_KEY in the profile .env), that the Vercel team allows the model typesafe-ai/jev, and the gateway status page. The pipeline resumes by itself once screening answers; held territories are not consumed.';

const numEnv = (name, dflt) => {
  const n = Number(env.get(name, String(dflt)));
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
// 2026-06-09: 30s aborted slow-but-valid captures (launcher up to ~30s + capture 45s); 90s covers both. Env override is for tests.
const REFRESH_KILL_TIMEOUT_MS = () => numEnv('REED_REFRESH_TIMEOUT_MS', 90000);
// The most people of whom the role was never recorded that ONE Reed run lets through to screening (docs/ROLESCOPE.md, K-RL4): bounds the run time of a sweep
// through a territory of old profiles, and the rest keep the old skip until a later run. 100 is a design default, not an owner decision. 0 lets none through.
const LEGACY_PER_RUN = () => Math.floor(numEnv('ROLE_SCOPE_REED_MAX_PER_RUN', 100));
// Legacy login used fixed sleeps (~24s) under a 60s kill; the login now polls with larger ceilings, so it gets the refresh's 90s.
const LOGIN_KILL_TIMEOUT_MS = () => numEnv('REED_LOGIN_TIMEOUT_MS', 90000);
const LAUNCH_KILL_TIMEOUT_MS = () => numEnv('REED_LAUNCH_TIMEOUT_MS', 60000);
// Must exceed the ai-review.js full retry cycle (~410s) with headroom for slow batches under load; the env override is for tests.
const SCREEN_TIMEOUT_MS = () => numEnv('REED_SCREEN_TIMEOUT_MS', 900000);
const PAGE_RETRY_PAUSE_MS = () => numEnv('SCREEN_PAGE_RETRY_PAUSE_SEC', 120) * 1000;
const CV_DELAY_MS = () => numEnv('REED_CV_DELAY_MS', 200);
// pdf and docx parsers run in this process on candidate-supplied files; a file this large is skipped (card data only).
const MAX_ANON_CV_BYTES = 5 * 1024 * 1024;

function log(msg) { process.stderr.write(`[reed-phase1] ${msg}\n`); }
function out(msg) { process.stdout.write(`${msg}\n`); }
const sleep = fsx.sleep;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

// ---------------------------------------------------------------- DB helpers (Reed-aware)

function checkByReedId(reedId) {
  try {
    const db = candidateDb.getDb();
    try {
      return db.prepare('SELECT id, zoho_id FROM candidates WHERE reed_id = ?').get(reedId) || null;
    } catch {
      try {
        return db.prepare("SELECT id, zoho_id FROM candidates WHERE source='reed' AND caterer_id = ?").get(reedId) || null;
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }
}

// Mark a Reed candidate as seen in the DB (no credits spent).
function seenReedCandidate(reedId) {
  try {
    const db = candidateDb.getDb();
    try {
      db.prepare(`
        INSERT INTO candidates (reed_id, source, unlocked) VALUES (?, 'reed', 0)
        ON CONFLICT(reed_id) DO UPDATE SET unlocked = MAX(unlocked, 0)
        WHERE reed_id IS NOT NULL
      `).run(reedId);
      return true;
    } catch {
      try {
        db.prepare(`
          INSERT INTO candidates (caterer_id, source, unlocked) VALUES (?, 'reed', 0)
          ON CONFLICT(caterer_id) DO UPDATE SET unlocked = MAX(unlocked, 0)
        `).run(reedId);
        return true;
      } catch (e) {
        log(`WARN: DB seen tracking failed for Reed ID ${reedId}: ${e.message}`);
        return false;
      }
    }
  } catch (e) {
    log(`WARN: DB error for Reed ID ${reedId}: ${e.message}`);
    return false;
  }
}

// The role scope of one page (docs/RESURFACE.md, docs/ROLESCOPE.md). A Reed row is the old "seen" ledger; since the role scope a rejection or an approval is
// also recorded per job title (candidate_rejections, origin reed:snippet or reed:approved), and the skip reads both:
//   again   screened again for this title and claimed in Phase 2 before the profile view: a CV rejection of another role (CV_RESURFACE, CV_SCREEN on), or a
//           person whose role was never recorded (ROLE_SCOPE_LEGACY, default on); `legacy` is the part that is the second reason
//   scoped  rejected or approved for another title only: screened as normal for this one (not switchable)
//   judged  a row for this title exists: skipped for it
// Everything empty on any error: the old skip (any Reed row skips). The daily cap holds some back (counted, alerted once a day).
function roleScopeForPage(pageCandidates, jobTitle) {
  const none = { again: new Set(), legacy: new Set(), scoped: new Set(), judged: new Set() };
  try {
    const rs = require('./lib/resurface');
    const r = candidateDb.resurfaceBatchReed(pageCandidates.map((c) => c.id), jobTitle);
    if (r.capped) {
      rs.record({ stop: 'capped', n: r.capped });
      if (rs.alertStopped({ why: 'cap', detail: `${jobTitle}.` })) out('ALERT: the daily cap of resurfaced candidates was reached');
    }
    const set = (a) => new Set((a || []).map(String));
    return { again: set(r.resurface), legacy: set(r.legacy), scoped: set(r.scoped), judged: set(r.judged) };
  } catch (e) {
    return none;
  }
}

// A resurfaced candidate that the snippet screening rejects for this role is recorded for this role (origin resurface:snippet), so it is not screened for it again.
function recordResurfaceReject(cand, jobTitle) {
  try {
    require('./lib/resurface').recordSnippetReject(candidateDb.getDb(), { source: 'reed', id: cand.id, jobTitle });
  } catch (e) { log(`WARN: could not record the rejection of resurfaced candidate ${cand.id}: ${e.message}`); }
}

// Every other Reed snippet rejection is recorded per job title too (origin reed:snippet, docs/ROLESCOPE.md): the same profile under ANOTHER title is screened
// as normal, under this one it is skipped. Written BEFORE the seen row: a kill between the two leaves a skip for this title, never a loop. A failed write
// leaves the old state (the seen row, no title record: a person whose role is not recorded).
function recordReedTitleRow(cand, jobTitle, origin) {
  try {
    require('./lib/resurface').recordSnippetReject(candidateDb.getDb(), { source: 'reed', id: cand.id, jobTitle, origin, onError: (e) => log(`WARN: could not record the ${origin} row of Reed candidate ${cand.id} (the person may be screened again for this title): ${String(e && e.message).slice(0, 120)}`) });
  } catch (e) { log(`WARN: could not record the ${origin} row of Reed candidate ${cand.id}: ${e.message}`); }
}

// Short, secret-free description of why the first page failed: HTTP status and API error code, or the error code of the failure.
function firstPageFailureReason(err) {
  const m = /"errorCode"\s*:\s*"?(\d{3,6})/.exec(String(err && err.message));
  if (err && err.status) return `HTTP ${err.status}${m ? ` code ${m[1]}` : ''}`;
  if (err && err.code && /^[A-Z0-9_]{3,40}$/.test(String(err.code))) return String(err.code);
  return 'error';
}

// A first-page error that belongs to this territory and not to Reed's state: the place cannot be searched at all (Reed's location lookup
// returns nothing, raised by reed-search.js before any request to the search API). It is not a failure of the attempt: no streak, no alert,
// no retry, no catch-up listing. Everything else (HTTP 400 of any code, 5xx, timeouts, browser errors) stays a failure, so a systematic break
// is never taken for a run of unsearchable places.
const isUnsearchablePlace = (err) => /No locations found for/.test(String((err && err.message) || ''));

function makeRunId(jobTitle, location) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 20);
  return `${safe(jobTitle)}-${safe(location)}-${ts}`;
}

// ---------------------------------------------------------------- anonymized CV text (FREE, in memory only)

async function extractCvText(buffer, ext, candidateId) {
  let text = '';
  try {
    if (ext === '.docx') {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      text = result.value || '';
    } else if (ext === '.pdf') {
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse({ data: buffer });
      try {
        await parser.load();
        const result = await parser.getText();
        text = result.text || '';
      } finally {
        if (typeof parser.destroy === 'function') {
          try { await parser.destroy(); } catch { /* ignore */ }
        }
      }
    } else {
      text = buffer.toString('latin1');
    }
  } catch (parseErr) {
    log(`CV text extraction failed for ${candidateId}: ${parseErr.message}`);
  }
  return text;
}

// The anonymized CV has all work history with name/email/phone redacted; nothing is written to disk.
async function getAnonymizedCvText(candidateId, keywords) {
  try {
    const { reedBrowserFetchBinary } = require('./reed-browser-fetch');
    const { buffer, contentType, contentDisposition } = await reedBrowserFetchBinary(
      '/candidate/cv/download/anonymized/',
      { candidateId, savedSearchId: null, keywords: keywords || '' }
    );
    if (buffer.length < 100 || buffer.length > MAX_ANON_CV_BYTES) return '';
    const sniff = buffer.slice(0, 64).toString('latin1').trimStart();
    if (/^<(!DOCTYPE|HTML)/i.test(sniff)) return '';

    let ext = '.pdf';
    if (contentDisposition) {
      const m = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i);
      if (m) {
        const e = path.extname(m[1].replace(/['"]/g, '').trim()).toLowerCase();
        if (e) ext = e;
      }
    }
    if (!ext || ext === '.pdf') {
      if (contentType && (contentType.includes('wordprocessingml') || contentType.includes('docx'))) ext = '.docx';
      if (contentType && contentType.includes('msword')) ext = '.doc';
    }
    const text = await extractCvText(buffer, ext, candidateId);
    return text.replace(/\s+/g, ' ').trim().slice(0, 1500);
  } catch (err) {
    log(`Anonymized CV download failed for ${candidateId}: ${err.message}`);
    return '';
  }
}

// ---------------------------------------------------------------- AI screening

function getAiReviewScript() {
  if (fs.existsSync(AI_REVIEW_SCRIPT_ALT)) return AI_REVIEW_SCRIPT_ALT;
  if (fs.existsSync(AI_REVIEW_SCRIPT)) return AI_REVIEW_SCRIPT;
  throw new Error(`AI review script not found at ${AI_REVIEW_SCRIPT} or ${AI_REVIEW_SCRIPT_ALT}`);
}

// Nothing was screened: flagged so the page loop marks nothing and retries; `why` is a short data-free reason for logs and the halt detail.
const unavailableResults = (candidates, screeningModel, why) => candidates.map((c) => ({
  id: String(c.id), approved: false, reason: 'AI API unavailable - not screened', screeningModel, unavailable: true, failure: why || 'unavailable',
}));

// Why a screening child failed; every failure is unavailable (D4), the caller only needs to know that no decision was made.
function describeFailure(err) {
  if (!err) return 'unknown failure';
  if (String(err.stdout || '').startsWith('API_UNAVAILABLE') || String(err.stderr || '').includes('API_UNAVAILABLE')) return 'API_UNAVAILABLE';
  if (err.killed === true) return 'timeout';
  if (err.signal) return `killed by ${err.signal}`;
  if (typeof err.code === 'number') return `exit ${err.code}`;
  if (err.code) return `could not start (${err.code})`;
  return 'screening failed';
}

// Kept for callers of the earlier API: every failed screening attempt is now "unavailable".
function screeningUnavailable(err) {
  return !!err;
}

// A successful parse is a JSON array with a boolean `approved` for EVERY candidate sent (one element per input); anything else is no decision.
function parseScreeningOutput(stdout, candidates) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, why: 'unparseable output' };
  }
  if (!Array.isArray(parsed)) return { ok: false, why: 'output is not a JSON array' };
  const byId = new Map();
  for (const r of parsed) {
    if (!r || typeof r !== 'object' || (typeof r.id !== 'string' && typeof r.id !== 'number') || typeof r.approved !== 'boolean') {
      return { ok: false, why: 'malformed result entry' };
    }
    byId.set(String(r.id), r);
  }
  const missing = candidates.filter((c) => !byId.has(String(c.id))).length;
  if (missing) return { ok: false, why: `results missing for ${missing} of ${candidates.length} candidates` };
  return { ok: true, results: parsed.map((r) => ({ ...r, id: String(r.id), reason: typeof r.reason === 'string' && r.reason ? r.reason : (r.approved ? 'Approved' : 'Rejected') })) };
}

// -> [{id, approved, reason, screeningModel, unavailable?}] one per candidate, in input order.
async function runAiScreening(jobTitle, location, distance, candidates, useCvText = true, opts = {}) {
  if (!candidates.length) return [];

  const aiReviewScript = getAiReviewScript();
  const cvCache = opts.cvCache || new Map();

  const cvTexts = {};
  if (useCvText) {
    log(`Downloading anonymized CVs for ${candidates.length} candidates (free)...`);
    let cvCount = 0;
    for (const c of candidates) {
      const key = String(c.id);
      try {
        let text = cvCache.get(key);
        if (text === undefined) {
          text = await getAnonymizedCvText(c.id, jobTitle);
          cvCache.set(key, text);
          await sleep(CV_DELAY_MS());
        }
        if (text.length > 50) {
          cvTexts[key] = text;
          cvCount++;
        }
      } catch { /* non-fatal: fall back to card data only */ }
    }
    log(`Got anonymized CV text for ${cvCount}/${candidates.length} candidates`);
  }

  const candidatesForAi = candidates.map((c) => {
    const parts = [];
    if (c.currentJobTitle) parts.push(`Current role: ${c.currentJobTitle}`);
    if (c.desiredJobTitle) parts.push(`Desired role: ${c.desiredJobTitle}`);
    if (c.currentLocation) parts.push(`Location: ${c.currentLocation}`);
    if (c.salary) parts.push(`Salary: ${c.salary}`);
    if (c.jobType) parts.push(`Type: ${c.jobType}`);
    if (c.hasWorkPermit !== undefined) parts.push(`Work permit: ${c.hasWorkPermit ? 'Yes' : 'No'}`);
    if (c.noticePeriod) parts.push(`Notice: ${c.noticePeriod}`);
    if (c.desiredLocations) parts.push(`Open to: ${c.desiredLocations}`);
    let snippet = parts.join(' | ');
    const cvText = cvTexts[String(c.id)];
    if (cvText) snippet += `\n--- CV Work Experience ---\n${cvText}`;
    return { id: String(c.id), snippet };
  });

  try {
    log(`Running AI screening batch: ${candidates.length} candidates...`);
    // Snippets go to the screening CLI over stdin ('--candidates-file -'): they are never written to disk.
    const pending = execFileAsync(
      paths.NODE,
      [aiReviewScript, '--mode', 'batch', '--source', 'reed', '--job', jobTitle, '--location', location, '--distance', String(distance), '--candidates-file', '-'],
      { cwd: paths.HOME, timeout: SCREEN_TIMEOUT_MS(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    );
    pending.child.stdin.on('error', () => {});
    pending.child.stdin.end(JSON.stringify(candidatesForAi));
    const { stdout, stderr } = await pending;

    let screeningModel = 'unknown';
    if (stderr) {
      const smMatch = stderr.match(/SCREENING_MODEL:\s*(.+)/);
      if (smMatch) screeningModel = smMatch[1].trim();
      const lines = stderr.split('\n').filter((l) => l.includes('WARN') || l.includes('ERROR') || l.includes('FATAL'));
      if (lines.length) log(`AI stderr: ${lines.join(' | ')}`);
    }
    log(`AI screening model: ${screeningModel}`);

    if (stdout.startsWith('API_UNAVAILABLE')) {
      log(`WARN: AI API unavailable: ${stdout.slice(0, 100)}`);
      return unavailableResults(candidates, 'unavailable', 'API_UNAVAILABLE');
    }

    const parsed = parseScreeningOutput(stdout, candidates);
    if (!parsed.ok) {
      log(`WARN: screening output rejected (${parsed.why}); treating the page as unavailable, nothing is marked`);
      return unavailableResults(candidates, 'unavailable', parsed.why);
    }
    return parsed.results.map((r) => ({ ...r, screeningModel }));
  } catch (err) {
    // execFile rejects on every non-zero exit, timeout kill, signal and spawn failure: none of them is a decision about a candidate.
    const why = describeFailure(err);
    log(`WARN: AI screening did not complete (${why}): ${env.redact(String(err.stdout || err.message)).slice(0, 200)}`);
    return unavailableResults(candidates, 'unavailable', why);
  }
}

// ---------------------------------------------------------------- cross-dedup

function normName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
function normLocation(loc) {
  return String(loc || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}
function dedupKey(name, location) {
  return `${normName(name)}|${normLocation(location)}`;
}

// ---------------------------------------------------------------- pipeline halt (shared with the Caterer side)

function pipelineHalt() {
  try {
    return require('./lib/pipeline-halt');
  } catch (e) {
    log(`WARN: lib/pipeline-halt unavailable: ${e.message}`);
    return null;
  }
}

function currentHalt() {
  const h = pipelineHalt();
  try { const s = h && h.getHalt(); return s && s.halted ? s : null; } catch { return null; }
}

function raiseHalt(jobTitle, location, lastFailure) {
  const h = pipelineHalt();
  if (h) {
    try {
      const last = lastFailure ? ` (last failure: ${lastFailure})` : '';
      h.setHalt(HALT_REASON,
        `Screening API failed on ${API_FAILURES_BEFORE_HALT} consecutive attempts during Reed ${jobTitle}/${location}${last}. Every further run would fail the same way, so the queue is held.`,
        { remedy: HALT_REMEDY, blockedRun: true });
    } catch (e) {
      log(`WARN: could not raise pipeline halt: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------- Reed auth (pre-flight refresh, fallback to a valid token, auto-login)

function existingTokenValid() {
  const s = fsx.readJson(SESSION_FILE, null);
  if (!s) return false;
  const exp = Number(s.expiresAt || 0);
  return Number.isFinite(exp) && exp > Date.now() / 1000 + 120;
}

function writeAuthFailedMarker(reason, ctx) {
  if (reason !== 'browser_lock_busy') writeReedStatus('auth_failed', reason);
  try {
    fsx.writeJsonAtomic(AUTH_MARKER, { reason, failedAt: new Date().toISOString(), jobTitle: ctx.jobTitle, location: ctx.location });
  } catch { /* disk full / unlikely */ }
}

function ensureChromeCdp() {
  try {
    out('[Reed Phase 1] Ensuring Chromium CDP is available...');
    const cdpOut = execFileSync(paths.NODE, [path.join(__dirname, 'ensure-chrome-cdp.js'), '--ensure-reed-tab'],
      { cwd: paths.HOME, timeout: LAUNCH_KILL_TIMEOUT_MS(), encoding: 'utf8' });
    out(`[Reed Phase 1] ensure-chrome-cdp: ${cdpOut.trim().replace(/\s*\n\s*/g, ' | ').slice(0, 300)}`);
    return true;
  } catch (e) {
    const msg = String((e.stdout || '') + (e.stderr || '') + (e.message || ''));
    out(`[Reed Phase 1] ensure-chrome-cdp failed (exit ${e.status}): ${msg.trim().slice(0, 200)}`);
    return false;
  }
}

function runRefresh() {
  try {
    const o = execFileSync(paths.NODE, [path.join(__dirname, 'reed-refresh-token.js'), '--force'],
      { cwd: paths.HOME, timeout: REFRESH_KILL_TIMEOUT_MS(), encoding: 'utf8' });
    return { ok: o.includes('REED_TOKEN_REFRESHED') || o.includes('TOKEN_VALID'), reloginNeeded: o.includes('REED_RELOGIN_NEEDED'), out: o };
  } catch (e) {
    const o = String((e.stdout || '') + (e.stderr || '') + (e.message || ''));
    return { ok: false, reloginNeeded: o.includes('REED_RELOGIN_NEEDED'), out: o, error: (e.message || '').slice(0, 200) };
  }
}

// -> {ok:true} | {ok:false, reason}. The login script saves the session itself; no token ever crosses stdout.
function attemptFullReedLogin() {
  if (!ensureChromeCdp()) {
    out('[Reed Phase 1] Cannot auto-login without Chromium CDP - marking auth failed.');
    return { ok: false, reason: 'auto_login_failed' };
  }
  out('[Reed Phase 1] Running cdp-reed-full-login.js...');
  let loginOut = '';
  try {
    loginOut = execFileSync(paths.NODE, [path.join(__dirname, 'cdp-reed-full-login.js')],
      { cwd: paths.HOME, timeout: LOGIN_KILL_TIMEOUT_MS(), encoding: 'utf8' });
  } catch (e) {
    loginOut = String((e.stdout || '') + (e.stderr || ''));
    out(`[Reed Phase 1] Auto-login FAILED: ${loginOut.trim().split('\n').slice(-1)[0].slice(0, 200) || String(e.message).slice(0, 200)}`);
    if (loginOut.includes('REED_LOGIN_BLOCKED_TURNSTILE')) return { ok: false, reason: 'turnstile_blocked' };
    if (loginOut.includes('REED_CRED_')) return { ok: false, reason: 'reed_credentials_missing' };
    return { ok: false, reason: 'auto_login_failed' };
  }
  if (loginOut.includes('REED_LOGIN_OK') && existingTokenValid()) {
    out('[Reed Phase 1] Auto-login SUCCESS - token saved');
    return { ok: true };
  }
  out(`[Reed Phase 1] Auto-login returned no token: ${loginOut.trim().slice(0, 150)}`);
  return { ok: false, reason: 'auto_login_failed' };
}

// Reed returns DEGRADED (fewer/zero) results on stale tokens rather than a clean 401, so the token is force-refreshed before every run.
// Chain (2026-04-17): refresh -> full CDP login -> refresh again. Auth outcomes go to reed-auth-failed.marker for run-pipeline.js.
function ensureReedAuth(ctx) {
  // Chromium must be live BEFORE the refresh (the HG4 silent-skip: Chrome was not running, so refresh and login both failed).
  ensureChromeCdp();

  out('[Reed Phase 1] Pre-flight - refreshing Reed token...');
  let r = runRefresh();
  if (r.ok) { out('[Reed Phase 1] Token refreshed OK'); return true; }
  out(`[Reed Phase 1] Refresh did not confirm success - reloginNeeded=${r.reloginNeeded}${r.error ? `, error=${r.error}` : ''}`);

  // Resilience (2026-06-05): a failed force-refresh must not zero out Reed while the saved token is still valid.
  if (existingTokenValid()) { out('[Reed Phase 1] Refresh unconfirmed but saved token still valid - proceeding with it (skipping auto-login)'); return true; }

  out('[Reed Phase 1] Attempting full auto-login (cdp-reed-full-login.js)...');
  const login = attemptFullReedLogin();
  if (login.ok) {
    out('[Reed Phase 1] Post-login verify - re-running refresh...');
    r = runRefresh();
    if (r.ok) { out('[Reed Phase 1] Token refreshed OK after auto-login'); return true; }
    if (existingTokenValid()) { out('[Reed Phase 1] Post-login refresh unconfirmed but saved token still valid - proceeding with it'); return true; }
    out('[Reed Phase 1] Post-login refresh still not confirmed - writing auth-failed marker');
    writeAuthFailedMarker('post_login_verify_failed', ctx);
    return false;
  }

  out('[Reed Phase 1] Auto-login failed');
  if (existingTokenValid()) { out('[Reed Phase 1] Auto-login failed but saved token still valid - proceeding with it'); return true; }
  writeAuthFailedMarker(login.reason, ctx);
  return false;
}

// ---------------------------------------------------------------- approved queue

function writeApprovedQueue(runId, jobTitle, location, distance, activeWithin, searchDate, candidates, phase1Stats) {
  fsx.ensureDir(paths.DOWNLOADS);
  const outputPath = path.join(paths.DOWNLOADS, `reed-approved-queue-${runId}.json`);
  const queueData = {
    searchDate,
    jobTitle,
    location,
    distance,
    activeWithin,
    source: 'reed',
    screeningModel: phase1Stats.screeningModel || 'unknown',
    phase1Stats: { ...phase1Stats, phase1CompletedAt: phase1Stats.phase1CompletedAt || new Date().toISOString() },
    candidateCount: phase1Stats.pool || candidates.length,
    candidates,
  };
  fsx.writeJsonAtomic(outputPath, queueData, 0o600);
  log(`Approved queue written: ${outputPath} (${candidates.length} candidates)`);
  return { outputPath, queueData };
}

// Approvals are marked seen only once the queue carrying them reads back, so a kill or failed write before that re-screens them. Each approval that is not
// a claimed second look also gets its title row (reed:approved) FIRST, so the same title is never screened, viewed and charged twice for the same person;
// a claimed one has its claim row written by Phase 2 before the profile view.
function markApprovedSeen(queuePath, approved, jobTitle) {
  const written = fsx.readJson(queuePath, null);
  const inQueue = new Set(((written && Array.isArray(written.candidates)) ? written.candidates : []).map((c) => String(c.id)));
  let marked = 0;
  for (const cand of approved) {
    if (!inQueue.has(String(cand.id))) throw new Error(`approved queue ${path.basename(queuePath)} does not contain candidate ${cand.id}; approvals left unmarked`);
  }
  for (const cand of approved) {
    if (!cand.resurfaced) recordReedTitleRow(cand, jobTitle, 'reed:approved');
    if (seenReedCandidate(cand.id)) marked++;
  }
  return marked;
}

// Profile views left today (each approved candidate costs at least one); null when the usage table cannot be read.
function dailyBudgetLeft() {
  try {
    const u = require('./reed-download').getTodayUsageFromDb();
    const left = Number(u.daily_limit) - Number(u.profile_views);
    return Number.isFinite(left) ? Math.max(0, left) : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- main

const USAGE = `
Reed Phase 1 - Candidate Screening Pipeline

Usage: node scripts/reed-phase1.js --job-title "Chef" --location "LS1" [options]

Options:
  --job-title <role>       Job role to search (default: Chef)
  --location <postcode>    Location postcode or city (required)
  --distance <miles>       Search radius (default: 20)
  --active-within <period> Activity period: day, week, month, 3months (default: month)
  --cv-limit <n>           Max approved candidates to collect (default: no limit)
  --uk-only true|false     UK work eligibility filter (default: true)
  --temp-only true|false   Temporary contract only (default: false)
  --caterer-queue <path>   Path to caterer approved queue for cross-dedup
  --run-id <id>            Custom run ID (auto-generated if not set)
  --skip-screening         Approve everyone without AI screening
  --help                   This text (exit 0)
`;

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.h) { out(USAGE); return 0; }

  const jobTitle = args['job-title'] || args.job || 'Chef';
  const location = args.location || args.l;
  const distance = Number(args.distance || args.d || 20);
  const activeWithin = args['active-within'] || args.active || 'month';
  let cvLimit = args['cv-limit'] ? Number(args['cv-limit']) : null;
  const ukOnly = args['uk-only'] !== 'false';
  const tempOnly = args['temp-only'] === 'true';
  const runId = args['run-id'] || makeRunId(jobTitle, location);
  const catererQueuePath = args['caterer-queue'] || null;
  const skipScreening = args['skip-screening'] === true || args['skip-screening'] === 'true';

  if (!location) {
    out(USAGE);
    return 1;
  }

  const ctx = { jobTitle, location };
  // Drop any stale marker from a previous failed run so a fresh run starts clean.
  fsx.safeUnlink(AUTH_MARKER);
  const phase1StartedAt = new Date().toISOString();
  const searchDate = phase1StartedAt.slice(0, 10);

  out('[Reed Phase 1] Starting...');
  out(`  Job: ${jobTitle} | Location: ${location} | Distance: ${distance}mi | Active: ${activeWithin}`);
  if (cvLimit) out(`  CV limit: ${cvLimit}`);
  out('');

  const emptyStats = (extra) => ({ pagesScraped: 0, pool: 0, inDb: 0, crossDedup: 0, rejected: 0, approved: 0, ...extra });

  // A halted pipeline means screening is down: do not spend a browser run on it.
  if (!skipScreening) {
    const halt = currentHalt();
    if (halt) {
      out(`REED_SCREENING_HALT: pipeline halted (${halt.reason}) - Reed screening skipped for this run`);
      const haltStats = emptyStats({ errors: 1, screeningHalted: true, screeningModel: 'unavailable', phase1StartedAt });
      const q = writeApprovedQueue(runId, jobTitle, location, distance, activeWithin, searchDate, [], haltStats);
      out(`REED_PHASE1_SUMMARY:${JSON.stringify({ source: 'reed', runId, jobTitle, location, distance, approved: 0, screeningModel: 'unavailable', queuePath: q.outputPath, stats: haltStats })}`);
      return 0;
    }
  }

  // Nothing is worth screening or approving when Phase 2 could not download it: check the budget before any browser work.
  const budgetLeft = dailyBudgetLeft();
  if (budgetLeft !== null) {
    if (budgetLeft < 1) {
      out(`REED_DAILY_LIMIT: no Reed profile views left today - screening skipped so nothing is approved that cannot be downloaded`);
      const limitStats = emptyStats({ errors: 0, dailyLimitReached: true, screeningModel: 'unavailable', phase1StartedAt });
      const q = writeApprovedQueue(runId, jobTitle, location, distance, activeWithin, searchDate, [], limitStats);
      out(`REED_PHASE1_SUMMARY:${JSON.stringify({ source: 'reed', runId, jobTitle, location, distance, approved: 0, screeningModel: 'unavailable', queuePath: q.outputPath, stats: limitStats })}`);
      return 0;
    }
    if (cvLimit && cvLimit > budgetLeft) {
      out(`  CV limit lowered from ${cvLimit} to ${budgetLeft}: that is all the Reed profile views left today`);
      cvLimit = budgetLeft;
    }
  }

  const lock = launcher.browserLock.acquire('reed', { purpose: 'reed-phase1' });
  if (!lock.acquired) {
    const h = lock.holder || {};
    out(`REED_BROWSER_BUSY: browser.lock held by ${h.owner || 'another process'} (pid ${h.pid || '?'})`);
    writeAuthFailedMarker('browser_lock_busy', ctx);
    out('REED_AUTH_FAILED');
    return 1;
  }
  const ownsBrowser = !lock.borrowed && !lock.reentrant;

  try {
    if (!ensureReedAuth(ctx)) {
      out('REED_AUTH_FAILED');
      return 1;
    }
    markAuthOk('authenticated for a run');

    const catererDedupKeys = new Set();
    if (catererQueuePath && fs.existsSync(catererQueuePath)) {
      try {
        const catererQueue = JSON.parse(fs.readFileSync(catererQueuePath, 'utf8'));
        const catererCandidates = catererQueue.candidates || catererQueue;
        if (Array.isArray(catererCandidates)) {
          for (const c of catererCandidates) {
            const name = c.name || `${c.firstName || ''} ${c.lastName || ''}`.trim();
            const loc = c.currentLocation || c.location || c.city || '';
            catererDedupKeys.add(dedupKey(name, loc));
          }
          out(`[Reed Phase 1] Caterer cross-dedup: ${catererDedupKeys.size} candidates loaded`);
        }
      } catch (err) {
        log(`WARN: Could not load Caterer queue for cross-dedup: ${err.message}`);
      }
    }

    // Step 1: total count
    out('[Reed Phase 1] Step 1 - Checking total candidate pool...');
    let totalCount = 0;
    let totalPages = 0;
    let currentQueryId = null;
    const searchParams = (page) => ({ keywords: jobTitle, location, distance, activeWithin, page, pageSize: PAGE_SIZE, ukOnly, tempOnly });

    try {
      const firstPage = await search(searchParams(1));
      clearAlertEpisode('reed-451');
      totalCount = firstPage.totalCount;
      totalPages = firstPage.pages || Math.ceil(totalCount / PAGE_SIZE);
      out(`  Total pool: ${totalCount} candidates (${totalPages} pages)`);

      if (totalCount === 0) {
        clearFirstPageFailures(); // a genuine empty answer: the search worked
        out('[Reed Phase 1] No candidates found - exiting');
        writeApprovedQueue(runId, jobTitle, location, distance, activeWithin, searchDate, [], emptyStats({}));
        return 0;
      }

      currentQueryId = firstPage.queryId || null;
      if (currentQueryId) out(`  QueryId: ${currentQueryId}`);
      else out('  WARN: No queryId in search response - profile download may fail');
    } catch (err) {
      if (isUnsearchablePlace(err)) {
        // Reed has no such place: nothing to search, nothing failed. Recorded as an empty search (pool 0, errors 0), with the reason in the log.
        log(`Reed location lookup found nothing for this territory: ${String(err.message).slice(0, 120)}`);
        out('REED_LOCATION_NOT_FOUND: Reed cannot search this place - recorded as an empty Reed search, not a failure');
        writeApprovedQueue(runId, jobTitle, location, distance, activeWithin, searchDate, [], emptyStats({ locationNotFound: true }));
        return 0;
      }
      log(`FATAL: Could not fetch first page: ${err.message}`);
      if (err.message.includes('REED_RELOGIN_NEEDED')) log(`Run: ${LOGIN_COMMAND}`);
      if (err.status === 451 || /HTTP 451/.test(err.message)) {
        writeAuthFailedMarker('reed_451_international', ctx);
        alertOnce('reed-451', { severity: 'critical', text: `Reed refused the search from this server (HTTP 451 InternationalCvSearchNotAllowed): the login session was created from a non-UK network. Once the server egresses from the UK, re-establish the session with: cd ${paths.HOME} && node scripts/cdp-reed-full-login.js --clean (add --human if Turnstile blocks it). Reed is skipped until then; Caterer keeps running.` });
      } else if (err.code === 'REED_TOKEN_MISSING') {
        // No usable token in the saved session and none from the browser: that is a login problem, handled like any other (marker, hold, alert).
        writeAuthFailedMarker('token_missing', ctx);
        out('REED_AUTH_FAILED');
      } else if (!/REED_RELOGIN_NEEDED/.test(err.message)) {
        // Not an auth problem and not an empty search: the Reed half of this run did not happen. Say so, loudly and in a fixed form.
        const reason = firstPageFailureReason(err);
        const rec = recordFirstPageFailure({ reason, attempts: err.attempts, jobTitle, location });
        writeReedStatus('ok', `authenticated, but the first search page failed (${rec.count} in a row)`);
        out(`REED_FIRST_PAGE_FAILED: ${reason} attempts=${err.attempts || 1} streak=${rec.count}`);
      }
      return 1;
    }

    // Step 2: paginate + screen
    const approvedCandidates = [];
    const stats = {
      pool: totalCount, pagesScraped: 0, inDb: 0, crossDedup: 0, noPermit: 0, rejected: 0, approved: 0, errors: 0,
      screeningModel: 'unknown',
    };
    const cvCache = new Map();
    const resurfaceStats = { eligible: 0 };
    const scopeStats = { legacyScreened: 0, legacyRejected: 0, scopedScreened: 0, scopedRejected: 0 };
    const approvedIds = new Set();
    let apiFailureCount = 0;
    let pageFetchFailures = 0; // search pages that could not be fetched (after the retries of reed-browser-fetch)
    let lastPageFailure = null;
    let firstPageSettled = false;

    const maxPages = cvLimit ? Math.ceil(cvLimit * 10 / PAGE_SIZE) : totalPages; // overfetch to allow for rejections
    out(`[Reed Phase 1] Step 2 - Paginating through results (up to ${Math.min(maxPages, totalPages)} pages)...\n`);

    for (let page = 1; page <= Math.min(maxPages, totalPages); page++) {
      if (cvLimit && approvedCandidates.length >= cvLimit) {
        out(`  [Page ${page}] CV limit reached (${approvedCandidates.length}/${cvLimit}) - stopping`);
        break;
      }

      let pageData;
      try {
        // Page 1 is re-fetched (step 1 only kept the count) as in the legacy flow
        pageData = await search(searchParams(page));
        if (page === 1 && stats.pagesScraped === 0 && !currentQueryId && pageData.queryId) currentQueryId = pageData.queryId;
        stats.pagesScraped++;
        if (!firstPageSettled) { firstPageSettled = true; clearFirstPageFailures(); } // the search answered: the streak and its alert episode end
      } catch (err) {
        log(`ERROR fetching page ${page}: ${err.message}`);
        pageFetchFailures++;
        lastPageFailure = err;
        stats.errors++;
        if (err.message.includes('REED_RELOGIN_NEEDED')) break;
        if (err.status === 451) break;
        await sleep(2000);
        continue;
      }

      const pageCandidates = pageData.candidates;
      if (!pageCandidates.length) {
        out(`  [Page ${page}] Empty page - done`);
        break;
      }
      out(`  [Page ${page}/${Math.min(maxPages, totalPages)}] ${pageCandidates.length} candidates fetched`);

      // Page-local counters: applied to stats only once the page is settled, so a retried page is not double counted.
      const pg = { inDb: 0, crossDedup: 0, noPermit: 0, legacy: 0, scoped: 0 };
      const toScreen = [];
      const scope = roleScopeForPage(pageCandidates, jobTitle);
      for (const cand of pageCandidates) {
        const sid = String(cand.id);
        const again = scope.again.has(sid) && !approvedIds.has(sid);
        const scoped = !again && scope.scoped.has(sid) && !approvedIds.has(sid);
        if (approvedIds.has(sid) || scope.judged.has(sid) || (checkByReedId(cand.id) && !again && !scoped)) {
          pg.inDb++;
          log(`  [${cand.id}] SKIP (already in DB)`);
          continue;
        }
        if (catererDedupKeys.size > 0 && catererDedupKeys.has(dedupKey(cand.name, cand.currentLocation))) {
          pg.crossDedup++;
          log(`  [${cand.id}] SKIP (cross-dedup: matches Caterer candidate)`);
          continue;
        }
        // The ukOnly filter is already in the API call; this is belt-and-suspenders
        if (ukOnly && cand.hasWorkPermit === false) {
          pg.noPermit++;
          log(`  [${cand.id}] SKIP (no work permit)`);
          continue;
        }
        if (again && scope.legacy.has(sid) && scopeStats.legacyScreened + pg.legacy >= LEGACY_PER_RUN()) {
          pg.inDb++;
          log(`  [${cand.id}] SKIP (already in DB; the limit of ${LEGACY_PER_RUN()} people of unrecorded role per run is reached: a later run)`);
          continue;
        }
        if (again) {
          cand._resurfaced = true;
          resurfaceStats.eligible++;
          if (scope.legacy.has(sid)) {
            cand._legacy = true;
            pg.legacy++;
            log(`  [${cand.id}] ROLE SCOPE (seen before, the role was never recorded, never pushed): screened once for this role`);
          } else {
            log(`  [${cand.id}] RESURFACE (CV rejected for another role, never pushed): screened again for this role`);
          }
        } else if (scoped) {
          cand._scoped = true;
          pg.scoped++;
          log(`  [${cand.id}] ROLE SCOPE (rejected or approved for another role only, never pushed): screened as normal for this role`);
        }
        toScreen.push(cand);
      }
      const applyPageCounters = () => { stats.inDb += pg.inDb; stats.crossDedup += pg.crossDedup; stats.noPermit += pg.noPermit; scopeStats.legacyScreened += pg.legacy; scopeStats.scopedScreened += pg.scoped; };
      out(`    -> ${pageCandidates.length - toScreen.length} skipped (${stats.inDb + pg.inDb} DB, ${stats.crossDedup + pg.crossDedup} cross-dedup), ${toScreen.length} to screen`);

      if (!toScreen.length) { applyPageCounters(); continue; }

      // AI batch screening
      let aiResults;
      if (skipScreening) {
        out('    -> AI screening SKIPPED (--skip-screening flag)');
        aiResults = toScreen.map((c) => ({ id: String(c.id), approved: true, reason: 'Screening skipped' }));
      } else {
        const halt = currentHalt();
        if (halt) {
          out(`REED_SCREENING_HALT: pipeline halted (${halt.reason}) - stopping Reed screening`);
          stats.screeningHalted = true;
          stats.errors++;
          if (stats.screeningModel === 'unknown') stats.screeningModel = 'unavailable';
          stats.pagesScraped--;
          break;
        }
        try {
          aiResults = await runAiScreening(jobTitle, location, distance, toScreen, true, { cvCache });
          if (aiResults.length && aiResults[0].screeningModel && aiResults[0].screeningModel !== 'unknown' && !aiResults[0].unavailable) {
            stats.screeningModel = aiResults[0].screeningModel;
          }
        } catch (err) {
          // Only a broken installation lands here (missing screening script): nothing was screened, so nothing may be burned.
          log(`AI screening could not run for page ${page}: ${err.message}`);
          aiResults = unavailableResults(toScreen, 'unavailable', 'screening script missing');
        }

        const failed = aiResults.find((r) => r.unavailable);
        if (failed) {
          // D4: nothing was screened, so nothing is marked seen or rejected; the page is retried.
          apiFailureCount++;
          stats.pagesScraped--;
          if (apiFailureCount >= API_FAILURES_BEFORE_HALT) {
            out(`STOPPING Reed Phase 1: AI screening unavailable for ${API_FAILURES_BEFORE_HALT} consecutive attempts (last failure: ${failed.failure})`);
            raiseHalt(jobTitle, location, failed.failure);
            stats.screeningHalted = true;
            stats.errors++;
            if (stats.screeningModel === 'unknown') stats.screeningModel = 'unavailable';
            out('REED_SCREENING_HALT: pipeline halt raised');
            break;
          }
          const pauseMs = PAGE_RETRY_PAUSE_MS();
          out(`    WARN AI screening API unavailable (${apiFailureCount}/${API_FAILURES_BEFORE_HALT}) [${failed.failure}] - pausing ${Math.round(pauseMs / 1000)} seconds before retrying page ${page}...`);
          await sleep(pauseMs);
          page--;
          continue;
        }
        apiFailureCount = 0;
      }

      applyPageCounters();
      const aiMap = new Map(aiResults.map((r) => [String(r.id), r]));

      for (const cand of toScreen) {
        const ai = aiMap.get(String(cand.id));
        const approved = ai?.approved ?? false;
        const reason = ai?.reason ?? 'No AI result';

        if (approved) {
          stats.approved++;
          approvedIds.add(String(cand.id));
          approvedCandidates.push({
            id: cand.id,
            source: 'reed',
            queryId: currentQueryId, // required by profile/CV download endpoints
            keywords: jobTitle, // needed for the anonymized CV download
            name: cand.name,
            firstName: cand.firstName,
            currentJobTitle: cand.currentJobTitle,
            currentLocation: cand.currentLocation,
            desiredJobTitle: cand.desiredJobTitle,
            desiredLocations: cand.desiredLocations,
            salary: cand.salary,
            jobType: cand.jobType,
            hasWorkPermit: cand.hasWorkPermit,
            noticePeriod: cand.noticePeriod,
            lastLogin: cand.lastLogin,
            screeningReason: reason,
            ...(cand._resurfaced ? { resurfaced: true } : {}),
            ...(cand._legacy ? { legacy: true } : {}),
          });

          if (cvLimit && approvedCandidates.length >= cvLimit) {
            out(`    + [${cand.id}] - APPROVED (${reason}) [limit reached]`);
            break;
          }
          out(`    + [${cand.id}] - APPROVED: ${reason}`);
        } else {
          stats.rejected++;
          out(`    x [${cand.id}] - REJECTED: ${reason}`);
          if (cand._resurfaced && !cand._legacy) {
            seenReedCandidate(cand.id);
            recordResurfaceReject(cand, jobTitle);
          } else {
            recordReedTitleRow(cand, jobTitle, 'reed:snippet');
            seenReedCandidate(cand.id);
            if (cand._legacy) {
              scopeStats.legacyRejected++;
              try { require('./lib/resurface').record({ look: 'reed', legacyRejected: true }); } catch (e) { log(`WARN: could not count a legacy look: ${e.message}`); }
            }
            if (cand._scoped) scopeStats.scopedRejected++;
          }
        }
      }

      if (page < Math.min(maxPages, totalPages)) await sleep(500);
    }

    // A run that found a pool but could not fetch a single page of it did not do its Reed half: that is a failure, never a quiet "ok".
    let noPageFetched = null;
    if (stats.pagesScraped === 0 && pageFetchFailures > 0 && !stats.screeningHalted) {
      const reason = firstPageFailureReason(lastPageFailure);
      const rec = recordFirstPageFailure({ reason, attempts: lastPageFailure && lastPageFailure.attempts, jobTitle, location });
      writeReedStatus('ok', `authenticated, but no search page could be fetched (${rec.count} in a row)`);
      out(`REED_FIRST_PAGE_FAILED: ${reason} attempts=${(lastPageFailure && lastPageFailure.attempts) || 1} streak=${rec.count} (no search page could be fetched)`);
      noPageFetched = reason;
    }

    // Step 3: write approved queue
    const phase1CompletedAt = new Date().toISOString();
    const phase1Stats = {
      pagesScraped: stats.pagesScraped,
      pool: stats.pool,
      inDb: stats.inDb,
      crossDedup: stats.crossDedup,
      noPermit: stats.noPermit,
      rejected: stats.rejected,
      approved: stats.approved,
      errors: stats.errors,
      screeningModel: stats.screeningModel,
      phase1StartedAt,
      phase1CompletedAt,
    };
    if (stats.screeningHalted) phase1Stats.screeningHalted = true;
    // only when the second look met a candidate in this run: otherwise the queue is exactly what it always was
    const resurfacedApproved = approvedCandidates.filter((c) => c.resurfaced).length;
    if (resurfaceStats.eligible || resurfacedApproved) {
      phase1Stats.resurfaced = { eligible: resurfaceStats.eligible, candidates: resurfacedApproved };
      const legacyApproved = approvedCandidates.filter((c) => c.legacy).length;
      if (scopeStats.legacyScreened) phase1Stats.resurfaced.legacy = { screened: scopeStats.legacyScreened, rejectedAtSnippet: scopeStats.legacyRejected, candidates: legacyApproved };
    }
    if (scopeStats.scopedScreened) phase1Stats.roleScope = { scopedScreened: scopeStats.scopedScreened, scopedRejected: scopeStats.scopedRejected, scopedApproved: scopeStats.scopedScreened - scopeStats.scopedRejected };
    if (noPageFetched) { phase1Stats.failed = true; phase1Stats.failureReason = noPageFetched; phase1Stats.errors = Math.max(1, phase1Stats.errors); }
    const queueData = writeApprovedQueue(runId, jobTitle, location, distance, activeWithin, searchDate, approvedCandidates, phase1Stats);
    const marked = markApprovedSeen(queueData.outputPath, approvedCandidates, jobTitle);
    out(`[Reed Phase 1] approvals recorded as seen: ${marked}`);

    out('');
    out('==========================================');
    out('[Reed Phase 1] Summary:');
    out(`  Pool:         ${stats.pool} candidates in search`);
    out(`  Pages:        ${stats.pagesScraped} scraped`);
    out(`  Skipped DB:   ${stats.inDb}`);
    out(`  Skipped dedup:${stats.crossDedup}`);
    out(`  Rejected AI:  ${stats.rejected}`);
    out(`  APPROVED:     ${stats.approved}`);
    out('------------------------------------------');
    out(`  Queue file:   ${queueData.outputPath}`);
    out(`  Screened by:  ${stats.screeningModel}`);
    out('==========================================');

    const summary = {
      source: 'reed', runId, jobTitle, location, distance,
      approved: stats.approved, screeningModel: stats.screeningModel, queuePath: queueData.outputPath, stats,
    };
    out('');
    out(`REED_PHASE1_SUMMARY:${JSON.stringify(summary)}`);
    return 0;
  } finally {
    lock.release();
    if (ownsBrowser && env.get('REED_KEEP_CHROME', '0') !== '1') {
      try { await launcher.stopChromeGraceful(); } catch (e) { log(`WARN: could not stop the Reed browser: ${e.message}`); }
    }
  }
}

function cleanupAndExit(code = 0) {
  try { require('./reed-browser-fetch').closeCdp(); } catch { /* not loaded */ }
  process.exit(code);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => cleanupAndExit(code)).catch((err) => {
    log(`FATAL: ${err.message}`);
    if (err.message.includes('REED_RELOGIN_NEEDED')) out(`Run: ${LOGIN_COMMAND}`);
    cleanupAndExit(1);
  });
}

module.exports = {
  main, firstPageFailureReason, runAiScreening, parseScreeningOutput, describeFailure, checkByReedId, seenReedCandidate, screeningUnavailable, parseArgs, REFRESH_KILL_TIMEOUT_MS,
};
