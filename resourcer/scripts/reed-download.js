#!/usr/bin/env node
'use strict';

// Phase 2 profile + CV download for Reed candidates. COSTS CREDITS: only call for approved candidates.
//
// Flow: POST /candidate/profile/ (1 daily view credit), POST /candidate/cv/download/, save the CV, count usage in reed_daily_usage.
// The 600/day cap is enforced here (DAILY_LIMIT_REACHED) from the local reed_daily_usage table.
//
// CLI: node scripts/reed-download.js --candidate-id <id> --query-id <uuid> [--keywords Chef] [--output-dir dir]
//        [--profile-only|--cv-only|--anonymized-cv]     |     node scripts/reed-download.js --check-quota
// Module: const { downloadCandidate, checkDailyQuota } = require('./reed-download');

const fs = require('fs');
const path = require('path');
const paths = require('./lib/paths');
const fsx = require('./lib/fsx');
const { CV_EXTENSIONS } = require('./lib/cv-retention');
const { reedBrowserFetchPost, reedBrowserFetchBinary, reedBrowserFetch } = require('./reed-browser-fetch');

// Browser-proxied fetch wrappers (Reed API needs Cloudflare cookies)
async function reedFetch(endpoint, options = {}) {
  if (options.method === 'POST') {
    return reedBrowserFetchPost(endpoint, options.body ? JSON.parse(options.body) : {});
  }
  return reedBrowserFetch(endpoint);
}
async function reedFetchBinary(endpoint, options = {}) {
  return reedBrowserFetchBinary(endpoint, options.body ? JSON.parse(options.body) : null);
}

const DOWNLOADS = paths.DOWNLOADS;
const DB_PATH = paths.DB;
const DEFAULT_DAILY_LIMIT = 600;

function log(msg) { process.stderr.write(`[reed-download] ${msg}\n`); }

// ---------------------------------------------------------------- daily quota tracking

// UTC date key: shared with the scheduler and dashboard, which read reed_daily_usage by the same key.
function today() {
  return new Date().toISOString().slice(0, 10);
}

async function checkDailyQuota() {
  try {
    const data = await reedFetch('/monetization/daily-usage/');
    const usage = (data && data.result) || data;
    return {
      profileViews: usage?.profileViews ?? usage?.dailyViews ?? null,
      cvDownloads: usage?.cvDownloads ?? null,
      dailyLimit: usage?.dailyLimit ?? DEFAULT_DAILY_LIMIT,
      remaining: usage?.remaining ?? null,
      raw: usage,
    };
  } catch (err) {
    log(`WARN: Could not fetch daily quota: ${err.message}`);
    return { profileViews: null, cvDownloads: null, dailyLimit: DEFAULT_DAILY_LIMIT, remaining: null };
  }
}

const USAGE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS reed_daily_usage (
    date          TEXT PRIMARY KEY,
    profile_views INTEGER DEFAULT 0,
    cv_downloads  INTEGER DEFAULT 0,
    daily_limit   INTEGER DEFAULT ${DEFAULT_DAILY_LIMIT}
  )
`;

function updateDailyUsageDb(type = 'profile_view') {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH);
    try {
      db.exec(USAGE_TABLE_SQL);
      const dateStr = today();
      db.prepare(`
        INSERT INTO reed_daily_usage (date, profile_views, cv_downloads, daily_limit)
        VALUES (?, 0, 0, ${DEFAULT_DAILY_LIMIT})
        ON CONFLICT(date) DO NOTHING
      `).run(dateStr);
      if (type === 'profile_view') {
        db.prepare('UPDATE reed_daily_usage SET profile_views = profile_views + 1 WHERE date = ?').run(dateStr);
      } else if (type === 'cv_download') {
        db.prepare('UPDATE reed_daily_usage SET cv_downloads = cv_downloads + 1 WHERE date = ?').run(dateStr);
      }
    } finally {
      db.close();
    }
  } catch (err) {
    log(`WARN: Could not update daily usage DB: ${err.message}`);
  }
}

function getTodayUsageFromDb() {
  const fallback = () => ({ date: today(), profile_views: 0, cv_downloads: 0, daily_limit: DEFAULT_DAILY_LIMIT });
  try {
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH);
    try {
      db.exec(USAGE_TABLE_SQL);
      return db.prepare('SELECT * FROM reed_daily_usage WHERE date = ?').get(today()) || fallback();
    } finally {
      db.close();
    }
  } catch {
    return fallback();
  }
}

// ---------------------------------------------------------------- profile download

// Full unlocked profile. COSTS 1 DAILY VIEW CREDIT.
async function downloadProfile(candidateId, queryId) {
  log(`Downloading profile for candidate ${candidateId} (1 credit)...`);
  if (!queryId) log('WARN: queryId not provided - profile endpoint may return 400');

  const data = await reedFetch('/candidate/profile/', {
    method: 'POST',
    body: JSON.stringify({ candidateId, queryId: queryId || null, queryEventSource: 'candidateCard' }),
  });

  const profileData = (data && (data.result || data.candidate || data.profile)) || data;
  if (!profileData) throw new Error(`Could not download profile for candidate ${candidateId}`);

  if (profileData.email || profileData.phoneNumber || profileData.mobile) {
    log('Profile unlocked: contact details present');
  } else {
    log('WARN: Profile returned but no email/phone found - may be locked or wrong endpoint');
  }

  updateDailyUsageDb('profile_view');
  return profileData;
}

// ---------------------------------------------------------------- CV download

// Only the extensions Phase 2 looks for (lib/cv-retention CV_EXTENSIONS): a CV saved as .odt or .wps would never be found, attached or swept.
function guessExtension(contentType, contentDisposition) {
  if (contentDisposition) {
    const m = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i);
    if (m) {
      const fn = m[1].replace(/['"]/g, '').trim();
      const ext = path.extname(fn).toLowerCase();
      if (CV_EXTENSIONS.includes(ext)) return ext;
    }
  }
  if (contentType) {
    if (contentType.includes('pdf')) return '.pdf';
    if (contentType.includes('wordprocessingml') || contentType.includes('docx')) return '.docx';
    if (contentType.includes('msword') || contentType.includes('doc')) return '.doc';
    if (contentType.includes('rtf')) return '.rtf';
    if (contentType.includes('text/plain')) return '.txt';
  }
  return '.pdf';
}

// Candidate ids build file names, and lib/cv-retention.js only recognises numeric ids: anything else never reaches the disk.
function safeCandidateId(candidateId) {
  const id = String(candidateId);
  if (!/^\d{1,20}$/.test(id)) throw new Error(`candidateId must be numeric (got a ${id.length}-character value)`);
  return id;
}

// cv-reed-<id>.anon<ext> (e.g. cv-reed-9007.anonpdf): lib/cv-retention.js sweeps that name as a CV, findExistingCv() never finds it, so a redacted CV cannot pass for the real one.
const ANON_EXTENSIONS = ['pdf', 'docx', 'doc', 'rtf', 'txt'];
function anonymizedCvName(candidateId, ext) {
  const e = String(ext || '').replace(/^\./, '').toLowerCase();
  return `cv-reed-${safeCandidateId(candidateId)}.anon${ANON_EXTENSIONS.includes(e) ? e : 'pdf'}`;
}

function sniffHtml(buffer) {
  return /^<(!DOCTYPE|HTML)/i.test(buffer.slice(0, 64).toString('latin1').trimStart());
}

// Full (un-redacted) CV file. COSTS CREDITS.
async function downloadCv(candidateId, queryId, outputDir = DOWNLOADS) {
  safeCandidateId(candidateId);
  log(`Downloading full CV for candidate ${candidateId}...`);
  fs.mkdirSync(outputDir, { recursive: true });

  const { buffer, contentType, contentDisposition } = await reedFetchBinary('/candidate/cv/download/', {
    method: 'POST',
    body: JSON.stringify({ candidateId, queryId: queryId || null, savedSearchId: null }),
  });

  if (buffer.length < 100) {
    throw new Error(`CV download returned very small file (${buffer.length} bytes) - may be error response`);
  }
  if (sniffHtml(buffer)) throw new Error('CV download returned HTML (may be auth wall or error page)');

  const ext = guessExtension(contentType, contentDisposition);
  const cvPath = path.join(outputDir, `cv-reed-${safeCandidateId(candidateId)}${ext}`);
  fsx.writeFileAtomic(cvPath, buffer, 0o600);
  log(`CV saved: ${path.basename(cvPath)} (${Math.round(buffer.length / 1024)}KB)`);

  updateDailyUsageDb('cv_download');
  return { cvPath, size: buffer.length, ext };
}

// Anonymized (redacted) CV: FREE, no credits.
async function downloadAnonymizedCv(candidateId, keywords, outputDir = DOWNLOADS) {
  safeCandidateId(candidateId);
  log(`Downloading anonymized CV for candidate ${candidateId} (free)...`);
  fs.mkdirSync(outputDir, { recursive: true });

  const { buffer, contentType, contentDisposition } = await reedFetchBinary('/candidate/cv/download/anonymized/', {
    method: 'POST',
    body: JSON.stringify({ candidateId, savedSearchId: null, keywords: keywords || '' }),
  });

  if (buffer.length < 100) throw new Error(`Anonymized CV download returned very small file (${buffer.length} bytes)`);
  if (sniffHtml(buffer)) throw new Error('Anonymized CV download returned HTML (may be auth wall or error page)');

  const ext = guessExtension(contentType, contentDisposition);
  const cvPath = path.join(outputDir, anonymizedCvName(candidateId, ext));
  fsx.writeFileAtomic(cvPath, buffer, 0o600);
  log(`Anonymized CV saved: ${path.basename(cvPath)} (${Math.round(buffer.length / 1024)}KB)`);

  return { cvPath, size: buffer.length, ext };
}

// ---------------------------------------------------------------- combined download

// Profile and CV for an approved candidate. Returns {profileData, cvPath, creditsUsed}.
async function downloadCandidate({ candidateId, queryId = null, keywords = '', outputDir = DOWNLOADS, profileOnly = false, cvOnly = false, anonymizedCv = false }) {
  if (!candidateId) throw new Error('candidateId is required');
  safeCandidateId(candidateId);
  if (!queryId) log('WARN: queryId not provided - profile/CV endpoints may fail or return 400');

  const usage = getTodayUsageFromDb();
  log(`Daily usage: ${usage.profile_views}/${usage.daily_limit} profile views today`);
  if (usage.profile_views >= usage.daily_limit) {
    throw new Error(`DAILY_LIMIT_REACHED: ${usage.profile_views}/${usage.daily_limit} profile views used today`);
  }

  let profileData = null;
  let cvPath = null;
  let creditsUsed = 0;

  // 07777777777 is the fill-mandatory-fields placeholder: treated as missing
  function profileHasContact(p) {
    if (!p) return false;
    const email = p.email || p.emailAddress || '';
    const phone = p.phoneNumber || p.phone || p.mobile || '';
    return email.includes('@') || (phone && phone.replace(/\s/g, '') !== '07777777777');
  }

  async function forceTokenRefresh() {
    try {
      const { refreshToken } = require('./reed-refresh-token');
      log('Forcing token refresh before retry...');
      await refreshToken();
      try {
        const { invalidateToken } = require('./reed-browser-fetch');
        if (invalidateToken) invalidateToken();
      } catch { /* non-fatal: the next request re-reads the session file anyway */ }
      log('Token refreshed');
    } catch (e) {
      log(`Token refresh failed (non-fatal): ${e.message}`);
    }
  }

  if (!cvOnly) {
    try {
      profileData = await downloadProfile(candidateId, queryId);
      creditsUsed++;
      log(`Profile downloaded for ${candidateId}`);

      if (!profileHasContact(profileData)) {
        log(`WARN: Profile for ${candidateId} returned no email/phone - forcing token refresh and retrying...`);
        await forceTokenRefresh();
        try {
          const retryProfile = await downloadProfile(candidateId, queryId);
          if (profileHasContact(retryProfile)) {
            profileData = retryProfile;
            log(`Retry succeeded - got contact details for ${candidateId}`);
          } else {
            log(`Retry also returned no contact details for ${candidateId} - continuing with what we have`);
          }
        } catch (retryErr) {
          log(`Profile retry failed: ${retryErr.message}`);
        }
      }
    } catch (err) {
      log(`Profile download failed: ${err.message}`);
      await forceTokenRefresh();
      try {
        log(`Retrying profile download for ${candidateId}...`);
        profileData = await downloadProfile(candidateId, queryId);
        creditsUsed++;
        log(`Profile retry succeeded for ${candidateId}`);
      } catch (retryErr) {
        log(`Profile retry also failed: ${retryErr.message}`);
        if (!profileOnly) {
          log('Attempting CV download anyway...');
        } else {
          throw retryErr;
        }
      }
    }
  }

  if (!profileOnly) {
    const fetchCv = async () => {
      if (anonymizedCv) return downloadAnonymizedCv(candidateId, keywords, outputDir);
      const r = await downloadCv(candidateId, queryId, outputDir);
      creditsUsed++;
      return r;
    };
    try {
      cvPath = (await fetchCv()).cvPath;
    } catch (err) {
      log(`CV download failed: ${err.message} - retrying with fresh token...`);
      await forceTokenRefresh();
      try {
        cvPath = (await fetchCv()).cvPath;
        log(`CV retry succeeded for ${candidateId}`);
      } catch (retryErr) {
        log(`CV retry also failed: ${retryErr.message}`);
      }
    }
  }

  return { profileData, cvPath, creditsUsed };
}

// ---------------------------------------------------------------- profile to Zoho fields

// Normalise a Reed profile API response to the shape zoho-create-candidate.js expects.
function normalizeProfileToZoho(profile, searchMeta = {}, cardData = {}) {
  const { jobTitle = '', location = '', distance = 20 } = searchMeta;

  const fullName = profile?.name || profile?.fullName || cardData?.name || '';
  const firstName = profile?.firstName || cardData?.firstName || fullName.split(' ')[0] || '';
  const lastName = profile?.lastName || profile?.surname || fullName.split(' ').slice(1).join(' ') || fullName || '';

  const email = profile?.email || profile?.emailAddress || '';
  const mobile = profile?.phoneNumber || profile?.phone || profile?.mobile || '';

  const city = profile?.address?.town || profile?.town || cardData?.currentLocation || '';
  const postcode = profile?.address?.postcode || profile?.postcode || '';
  const state = profile?.address?.county || profile?.county || '';

  const currentJobTitle = profile?.currentJobTitle || cardData?.currentJobTitle || '';

  const workHistory = profile?.workHistory || profile?.employmentHistory || [];
  let experienceYears = null;
  if (workHistory.length > 0) {
    let totalMonths = 0;
    for (const role of workHistory) {
      const start = role.startDate ? new Date(role.startDate) : null;
      const end = role.endDate ? new Date(role.endDate) : new Date();
      if (start) {
        const months = (end - start) / (1000 * 60 * 60 * 24 * 30.44);
        totalMonths += Math.max(0, months);
      }
    }
    experienceYears = Math.round(totalMonths / 12 * 10) / 10;
  }

  const candidateId = profile?.candidateId || profile?.id || cardData?.id;

  const { mapToApplyingForRole } = require('./applying-for-role-map');
  const applyingForRole = mapToApplyingForRole(jobTitle);

  return {
    First_Name: firstName || 'Unknown',
    Last_Name: lastName || String(candidateId),
    Email: email,
    Mobile: mobile.replace(/\s/g, ''),
    Current_Job_Title: currentJobTitle,
    City: city,
    Zip_Code: postcode,
    State: state,
    Country: 'United Kingdom',
    Experience_in_Years: experienceYears,
    ReedID: String(candidateId),
    Source: 'Reed',
    Search_Job_Title: jobTitle,
    Applying_for_role: applyingForRole || undefined,
    Search_Criteria: `${jobTitle} | ${location} | ${distance}mi`,
  };
}

// ---------------------------------------------------------------- CLI

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

const USAGE = `
Reed Candidate Download
WARNING: This script COSTS CREDITS. Only use for approved candidates.

Usage:
  node scripts/reed-download.js --candidate-id <id> --query-id <queryId> [options]
  node scripts/reed-download.js --check-quota

Options:
  --candidate-id <id>   Reed candidate ID (required for download)
  --query-id <uuid>     QueryId from search response metaData (required for profile/CV)
  --keywords <terms>    Search keywords (e.g. "Chef"), needed for anonymized CV
  --output-dir <path>   Directory for the CV file (default: downloads/)
  --profile-only        Download profile only (no CV)
  --cv-only             Download CV only (no profile)
  --anonymized-cv       Download free anonymized CV (name/email/phone redacted, no credits)
  --check-quota         Check daily credit usage (no download, no cost)
  --help                This text (exit 0)

Exit codes: 0 ok, 1 error or missing/invalid arguments.
`;

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.h) { process.stderr.write(USAGE); return 0; }

  if (args['check-quota']) {
    try {
      const apiQuota = await checkDailyQuota();
      const dbUsage = getTodayUsageFromDb();
      console.log(JSON.stringify({
        today: today(),
        apiQuota,
        dbTracked: { profileViews: dbUsage.profile_views, cvDownloads: dbUsage.cv_downloads, dailyLimit: dbUsage.daily_limit },
      }, null, 2));
      return 0;
    } catch (err) {
      console.error(`Error: ${err.message}`);
      return 1;
    }
  }

  const candidateIdRaw = args['candidate-id'] || args.id;
  const queryId = args['query-id'] || args.queryId || null;
  const keywords = args.keywords || args.k || '';
  const outputDir = args['output-dir'] || args.output || DOWNLOADS;

  if (!candidateIdRaw) {
    process.stderr.write(USAGE);
    return 1;
  }
  const candidateId = Number(candidateIdRaw);
  if (!candidateId || Number.isNaN(candidateId)) {
    console.error(`Invalid candidate ID: ${candidateIdRaw}`);
    return 1;
  }

  log(`CREDIT WARNING: Downloading candidate ${candidateId} will spend credits.`);
  if (!queryId) log('WARNING: --query-id not provided - profile/CV endpoints may fail.');
  log(`Daily usage so far: ${getTodayUsageFromDb().profile_views} / ${DEFAULT_DAILY_LIMIT} profile views`);

  try {
    const result = await downloadCandidate({
      candidateId, queryId, keywords, outputDir,
      profileOnly: !!args['profile-only'], cvOnly: !!args['cv-only'], anonymizedCv: !!args['anonymized-cv'],
    });
    console.log(JSON.stringify({ candidateId, queryId, profileData: result.profileData, cvPath: result.cvPath, creditsUsed: result.creditsUsed }, null, 2));
    return 0;
  } catch (err) {
    console.error(`Error: ${err.message}`);
    if (err.message.includes('REED_RELOGIN_NEEDED')) console.error('Run: node scripts/cdp-reed-full-login.js');
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    try { require('./reed-browser-fetch').closeCdp(); } catch { /* not loaded */ }
    process.exit(code);
  }).catch((err) => {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  anonymizedCvName,
  downloadCandidate,
  downloadProfile,
  downloadCv,
  downloadAnonymizedCv,
  checkDailyQuota,
  getTodayUsageFromDb,
  updateDailyUsageDb,
  normalizeProfileToZoho,
};
