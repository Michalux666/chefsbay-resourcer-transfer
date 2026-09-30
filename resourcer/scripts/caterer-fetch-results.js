#!/usr/bin/env node
/**
 * Diagnostic: fetches a Caterer search-results page over plain HTTP with the saved session
 * cookies and extracts the candidate cards (id, name, location, job title, unlock state,
 * distance). Used to confirm that a session is really logged in and returns candidates
 * (e.g. after a re-login, when the first run may report an empty pool).
 *
 * Usage:
 *   node scripts/caterer-fetch-results.js [--url <results-url>] [--ids <id,id,...>] [--out <file>]
 *
 * Default output is a one-line JSON summary (counts only). Candidate names and locations are
 * personal data, so they are only printed for --ids and only written to disk for --out
 * (owner-only file).
 *
 * Exit: 0 ok, 1 HTTP error or failure.
 */
'use strict';

const fsx = require('./lib/fsx');
const { loadCookieHeader, BASE_CATERER: BASE_URL } = require('./caterer-session-utils');

const DEFAULT_URL = `${BASE_URL}/CandidateSearchWebMvc/CandidateSearch/Results?FreeText=Kitchen+Assistant+DBS&ShowUnspecifiedSalary=False&LastActivityId=15&CurrentLocation=L1&Radius=32187&SalaryFacetsType=99&PreRegStatusFacet=0%2c1&HideCandidatesSinceDays=0&SearchId=a9ef9399-6acd-425b-bc1e-62805add9a75&scr=1&PageSize=50`;

function decodeHtml(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '');
}

/**
 * Extract the candidate cards from a results page.
 * @param {string} html
 * @returns {object[]}
 */
function parseCandidates(html) {
  const candidates = [];

  // Find all candidate unlock state inputs to get IDs
  const idMatches = html.matchAll(/candidate-unlock-state-(\d+)/g);
  const ids = [...new Set([...idMatches].map(m => m[1]))];

  for (const id of ids) {
    const cand = { id };

    // Find the section around this candidate
    const sectionStart = html.indexOf(`candidate-header-bar-left-${id}`);
    if (sectionStart < 0) {
      cand.error = 'section not found';
      candidates.push(cand);
      continue;
    }

    const sectionEnd = html.indexOf(`candidate-header-bar-left-`, sectionStart + 1);
    const section = html.substring(sectionStart, sectionEnd > 0 ? sectionEnd : sectionStart + 5000);

    // Extract name from identifier summary
    // Pattern: <a href="...candidateId=...">Name</a> ... | Location, Postcode
    const nameMatch = section.match(/class="identifier">[\s\S]*?<a[^>]+>([\w\s'-]+)<\/a>/i);
    if (nameMatch) cand.name = decodeHtml(nameMatch[1]).trim();

    // Extract location from identifier summary
    const locMatch = section.match(/candidate-identifier-summary[\s\S]*?<span[^>]*>([\w\s,]+)<\/span>/i);
    if (locMatch) cand.location = decodeHtml(locMatch[1]).trim();

    // Try specific location pattern: City, Postcode
    const cityPostcode = section.match(/\|\s*<span[^>]*>([\w\s]+,?\s*[A-Z]{1,2}[0-9][0-9A-Z]?\s*[0-9][A-Z]{2})<\/span>/i);
    if (cityPostcode) cand.cityPostcode = decodeHtml(cityPostcode[1]).trim();

    // Job title from identifier
    const jobMatch = section.match(/candidate-identifier-summary[\s\S]*?(<match>|)([\w\s]+?)(?: <match>|\|)/);
    if (jobMatch) cand.jobTitle = decodeHtml(jobMatch[2]).trim();

    // Unlock state
    const unlockMatch = section.match(/candidate-unlock-state-\d+"\s+value="(true|false)"/);
    if (unlockMatch) cand.unlocked = unlockMatch[1] === 'true';

    // Distance
    const distMatch = section.match(/([\d.]+) miles/);
    if (distMatch) cand.miles = distMatch[1];

    candidates.push(cand);
  }

  return candidates;
}

/**
 * @param {{ url?: string, fetchImpl?: Function, cookieHeader?: string }} [opts]
 * @returns {Promise<object[]>}
 */
async function fetchResults(opts = {}) {
  const cookieHeader = opts.cookieHeader !== undefined ? opts.cookieHeader : loadCookieHeader();
  const url = opts.url || DEFAULT_URL;
  const fetchImpl = opts.fetchImpl || require('./caterer-cookie-jar').fetchWithCookieJarUpdate;

  console.error('Fetching results page...');
  const res = await fetchImpl(url, {
    headers: {
      Cookie: cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'text/html,application/xhtml+xml'
    },
    redirect: 'follow'
  }, 30000);

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.httpStatus = res.status;
    throw err;
  }

  const candidates = parseCandidates(await res.text());
  console.error(`Found ${candidates.length} candidate IDs`);
  return candidates;
}

async function main(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log('Usage: node scripts/caterer-fetch-results.js [--url <results-url>] [--ids <id,id,...>] [--out <file>]');
    return 0;
  }
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

  let candidates;
  try {
    candidates = await fetchResults({ url: arg('--url') });
  } catch (err) {
    if (err.httpStatus) console.error(err.message);
    else console.error('FATAL:', err.message);
    return 1;
  }

  const out = arg('--out');
  if (out) fsx.writeJsonAtomic(out, candidates, 0o600);

  const wanted = (arg('--ids') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (wanted.length) {
    console.log('=== Candidate Card Data ===');
    candidates.filter(c => wanted.includes(c.id)).forEach(c => console.log(JSON.stringify(c)));
  } else {
    console.log(JSON.stringify({
      candidates: candidates.length,
      unlocked: candidates.filter(c => c.unlocked === true).length,
      withLocation: candidates.filter(c => c.cityPostcode || c.location).length,
    }));
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code));
}

module.exports = { parseCandidates, fetchResults, decodeHtml, DEFAULT_URL };
