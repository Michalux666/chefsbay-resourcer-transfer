#!/usr/bin/env node
/**
 * build-caterer-results-url.js
 *
 * Deterministically constructs the Caterer.com candidate-search Results URL from
 * the same inputs a live browser form-submit used to capture
 * (JOB_TITLE / LOCATION / DISTANCE / KEYWORDS).
 *
 * WHY THIS EXISTS (2026-06-02 - watchdog-as-runner):
 *   The per-run LLM session's "Step 2 - Search" was the only reason it was required: it
 *   opened the browser, filled the form, submitted, and copied the
 *   resulting RESULTS_URL. But that URL is fully templated - Caterer's /Results
 *   endpoint keys off FreeText + CurrentLocation + Radius (+ HideCandidatesSinceDays);
 *   the SearchId is just a tracking token, NOT a server-registered handle. Proof:
 *     - a hand-built URL with NO SearchId at all worked.
 *     - Every recent production run (e.g. DL7 pool=54, 2026-06-02) used this exact
 *       template shape with an arbitrary random GUID and returned a full pool.
 *   phase1 then navigates the logged-in browser to this URL itself and
 *   appends SearchFormType=Targeted / SearchOptionColumn=ExactMatch / PageSize=50.
 *
 * OUTPUT SHAPE (byte-matches the browser-captured URLs, e.g. DL7 / Chef / 30mi):
 *   https://recruiter.caterer.com/CandidateSearchWebMvc/CandidateSearch/Results
 *     ?FreeText=Chef&ShowUnspecifiedSalary=False&CurrentLocation=DL7&Radius=48280
 *     &SalaryFacetsType=99&PreRegStatusFacet=0%2c1&HideCandidatesSinceDays=7
 *     &SearchId=<random-guid>&scr=1
 *
 * ACTIVE WITHIN (docs/ACTIVITY.md): when the caller passes activeWithin (the label of the request or territory) and manual (true for a
 * one-off request), the URL carries &LastActivityId=<id> after HideCandidatesSinceDays, according to the setting
 * CATERER_ACTIVITY_FILTER (manual = default, all, off) and config/caterer-activity.json. Without activeWithin, or when the setting says
 * no filter for this search, the URL is byte for byte what it was before this existed. buildResultsUrl also returns `activity` (what was
 * decided and why) for the caller to log.
 *
 * Usage (CLI):
 *   node scripts/build-caterer-results-url.js --job "Chef" --location DL7 --distance 30 [--keywords ""] [--search-id <guid>] [--active-within <label> [--manual]]
 *   -> prints exactly one line: RESULTS_URL:<url>   (and SEARCH_ID:<guid> on a 2nd line)
 *
 * Usage (module):
 *   const { buildResultsUrl } = require('./build-caterer-results-url');
 *   const { url, searchId, activity } = buildResultsUrl({ jobTitle, location, distance, keywords, activeWithin, manual });
 */
'use strict';

const crypto = require('crypto');
const { BASE_CATERER } = require('./constants');

// Distance (miles) -> RadiusTravelTime (meters). Source of truth is the Caterer search
// form's "Distance" field mapping.
const RADIUS_METERS = {
  0: 0,
  0.5: 805,
  1: 1609,
  3: 4828,
  5: 8047,
  10: 16093,
  20: 32187,
  30: 48280,
  40: 64374,
  60: 96561,
  80: 128748,
};

// Fixed: "Hide viewed since: 7 days".
const HIDE_VIEWED_SINCE_DAYS = 7;

/**
 * URL-encode the FreeText value the way Caterer's form does: spaces -> '+', and
 * percent-encode the rest. encodeURIComponent gives %20 for spaces, so swap to '+'
 * to match the observed production URLs (FreeText=Sous+Chef, Executive+Chef, etc.).
 */
function encodeFreeText(text) {
  return encodeURIComponent(text).replace(/%20/g, '+');
}

function resolveRadius(distanceMiles) {
  const d = Number(distanceMiles);
  if (Object.prototype.hasOwnProperty.call(RADIUS_METERS, d)) return RADIUS_METERS[d];
  if (!Number.isFinite(d) || d <= 0) throw new Error(`unmappable distance: ${distanceMiles}`);
  // Caterer's /Results endpoint ONLY accepts the DISCRETE radius values in RADIUS_METERS.
  // An arbitrary computed value (the old fallback, e.g. 25mi -> Math.round(25*1609.34)=40234)
  // makes the server redirect-loop (net::ERR_TOO_MANY_REDIRECTS) and serve 0 cards -- which
  // phase1's silent-zero guard then mis-flags as an error (pool 0 / errors 1), losing
  // a whole territory of real candidates. Confirmed 2026-06-08: Sous Chef/DN1/25mi=40234
  // looped & returned 0; the same search snapped to 48280 returned 50 candidates.
  // So snap an unmapped distance to the NEAREST valid radius; on a tie, prefer the WIDER
  // value (more coverage, never silently under-search a territory).
  const target = d * 1609.34;
  const standards = Object.values(RADIUS_METERS).filter((m) => m > 0).sort((a, b) => a - b);
  let best = standards[0];
  let bestDelta = Infinity;
  for (const m of standards) {
    const delta = Math.abs(m - target);
    if (delta < bestDelta || (delta === bestDelta && m > best)) {
      best = m;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * @param {object} opts
 * @param {string} opts.jobTitle  e.g. "Chef" / "Sous Chef"  (required)
 * @param {string} opts.location  postcode, e.g. "DL7"        (required)
 * @param {number} opts.distance  miles, e.g. 20 / 30         (required)
 * @param {string} [opts.keywords]  appended to FreeText when non-empty (territory runs leave this blank)
 * @param {string} [opts.searchId]  override the random GUID (mainly for tests)
 * @param {string} [opts.activeWithin]  the window label (14 days ... All); absent = no filter, as before
 * @param {boolean} [opts.manual]  the search is a one-off request (pending-file source dashboard or request-search-cli)
 * @param {object} [opts.activityConfig]  an already loaded caterer-activity config (tests); default: config/caterer-activity.json
 * @param {string} [opts.activitySetting]  manual | all | off (tests); default: the CATERER_ACTIVITY_FILTER setting
 * @returns {{ url: string, searchId: string, activity: (object|null) }}
 */
function buildResultsUrl(opts) {
  const jobTitle = (opts.jobTitle || '').trim();
  const location = (opts.location || '').trim();
  if (!jobTitle) throw new Error('jobTitle is required');
  if (!location) throw new Error('location is required');

  const radius = resolveRadius(opts.distance);

  // FreeText = job title, plus keywords appended when present (matches the
  // "Kitchen+Assistant+DBS" shape seen in production). Territory runs
  // always pass empty keywords, so this is just job title in practice.
  const kw = (opts.keywords || '').trim();
  const freeTextRaw = kw ? `${jobTitle} ${kw}` : jobTitle;

  const searchId = (opts.searchId && String(opts.searchId).trim()) || crypto.randomUUID();

  // The window filter. The library is loaded only when a window was passed: every older caller is untouched. A library that cannot load
  // (an unusual checkout) means no filter, with the reason in `activity.note`, never an exception.
  let activity = null;
  let activityParam = '';
  if (opts.activeWithin !== undefined && opts.activeWithin !== null) {
    try {
      const sa = require('./lib/search-activity');
      activity = sa.catererFilterFor({ activeWithin: opts.activeWithin, manual: !!opts.manual, setting: opts.activitySetting, config: opts.activityConfig });
    } catch (e) {
      activity = { requested: String(opts.activeWithin), label: null, setting: 'unknown', id: null, echo: [], note: 'the activity library could not be loaded: no filter sent to Caterer', warn: true };
    }
    if (activity.id !== null) activityParam = `&LastActivityId=${activity.id}`;
  }

  // NOTE: order + literal encodings chosen to byte-match the browser-captured URLs:
  //   PreRegStatusFacet=0%2c1  (the %2c is a literal comma, pre-encoded - do NOT re-encode)
  const url =
    `${BASE_CATERER}/CandidateSearchWebMvc/CandidateSearch/Results` +
    `?FreeText=${encodeFreeText(freeTextRaw)}` +
    `&ShowUnspecifiedSalary=False` +
    `&CurrentLocation=${encodeURIComponent(location)}` +
    `&Radius=${radius}` +
    `&SalaryFacetsType=99` +
    `&PreRegStatusFacet=0%2c1` +
    `&HideCandidatesSinceDays=${HIDE_VIEWED_SINCE_DAYS}` +
    activityParam +
    `&SearchId=${searchId}` +
    `&scr=1`;

  return { url, searchId, activity };
}

module.exports = { buildResultsUrl, resolveRadius, RADIUS_METERS, HIDE_VIEWED_SINCE_DAYS };

// --- CLI ---
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log('Usage: node scripts/build-caterer-results-url.js --job <title> --location <postcode> --distance <miles> [--keywords <kw>] [--search-id <guid>] [--active-within <label> [--manual]]\nPrints RESULTS_URL:<url> and SEARCH_ID:<guid>; on error prints ERROR:<msg> to stderr and exits 1.\n--active-within adds LastActivityId for the window according to CATERER_ACTIVITY_FILTER (manual: only with --manual; all; off) and config/caterer-activity.json; the reason nothing was added goes to stderr as NOTE:<text>.');
    process.exit(0);
  }
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  try {
    const { url, searchId, activity } = buildResultsUrl({
      jobTitle: get('--job'),
      location: get('--location'),
      distance: get('--distance'),
      keywords: get('--keywords') || '',
      searchId: get('--search-id'),
      activeWithin: get('--active-within'),
      manual: argv.includes('--manual'),
    });
    if (activity && activity.note) console.error(`NOTE:${activity.note}`);
    console.log(`RESULTS_URL:${url}`);
    console.log(`SEARCH_ID:${searchId}`);
  } catch (e) {
    console.error(`ERROR:${e.message}`);
    process.exit(1);
  }
}
