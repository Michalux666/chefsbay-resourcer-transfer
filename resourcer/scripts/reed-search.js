#!/usr/bin/env node
'use strict';

// Reed BFF candidate search wrapper: location id lookup (file cache), request building, card normalisation.
// CLI: node scripts/reed-search.js --keywords "Chef" --location "LS1" --distance 20 --active-within month --page 1
// Module: const { search, resolveLocation } = require('./reed-search');
// CLI output: JSON { totalCount, page, pageSize, pages, candidates, queryId, dailyUsage } on stdout.

const paths = require('./lib/paths');
const fsx = require('./lib/fsx');
const { reedFetch } = require('./reed-api-client');

const LOCATION_CACHE_FILE = paths.p('reed-location-cache.json');

const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_DISTANCE = 20;
const DEFAULT_ACTIVE_WITHIN = 'month';

// activityTimeFrame mapping: friendly names to API values
const ACTIVITY_TIMEFRAME_MAP = {
  day: 'Day',
  '1 day': 'Day',
  '2 days': 'TwoDays',
  week: 'Week',
  '1 week': 'Week',
  '2 weeks': 'TwoWeeks',
  month: 'month',
  '1 month': 'month',
  onemonth: 'month',
  '2months': 'TwoMonths',
  twomonths: 'TwoMonths',
  '3 months': 'ThreeMonths',
  '3months': 'ThreeMonths',
  '6 months': 'SixMonths',
  '6months': 'SixMonths',
  year: 'year',
  '12 months': 'year',
  '1 year': 'year',
  '2 years': 'TwoYears',
  '24 months': 'TwoYears',
  all: 'all',
};

// ---------------------------------------------------------------- location cache

function loadLocationCache() {
  const c = fsx.readJson(LOCATION_CACHE_FILE, {});
  return c && typeof c === 'object' ? c : {};
}

function saveLocationCache(cache) {
  try {
    fsx.writeJsonAtomic(LOCATION_CACHE_FILE, cache);
  } catch (err) {
    process.stderr.write(`[reed-search] Warning: Could not save location cache: ${err.message}\n`);
  }
}

// Resolve a postcode/location string to a Reed location id (file cache first, then the suggest-locations API).
async function resolveLocation(searchTerm) {
  const key = searchTerm.trim().toUpperCase();
  const cache = loadLocationCache();

  if (cache[key]) {
    process.stderr.write(`[reed-search] Location cache hit: ${key} -> ${cache[key].id} (${cache[key].name})\n`);
    return { id: cache[key].id, name: cache[key].name };
  }

  process.stderr.write(`[reed-search] Looking up location: ${searchTerm}\n`);
  const data = await reedFetch(`/location/suggest-locations/?searchTerm=${encodeURIComponent(searchTerm)}`);

  let locations = [];
  if (Array.isArray(data)) {
    locations = data;
  } else if (Array.isArray(data && data.result && data.result.suggestedLocations)) {
    locations = data.result.suggestedLocations;
  } else if (Array.isArray(data && data.result)) {
    locations = data.result;
  } else if (Array.isArray(data && data.suggestedLocations)) {
    locations = data.suggestedLocations;
  } else if (Array.isArray(data && data.data)) {
    locations = data.data;
  } else {
    const walk = (obj, depth = 0) => {
      if (depth > 3 || !obj || typeof obj !== 'object') return;
      for (const val of Object.values(obj)) {
        if (Array.isArray(val) && val.length > 0 && (val[0].locationId || val[0].id)) {
          locations = val;
          return;
        }
        walk(val, depth + 1);
      }
    };
    walk(data);
  }

  if (!locations.length) {
    throw new Error(`No locations found for "${searchTerm}"`);
  }

  const normTerm = searchTerm.trim().toLowerCase();
  const exact = locations.find((l) =>
    (l.searchName || l.name || l.displayName || '').toLowerCase() === normTerm ||
    (l.postcode || '').toLowerCase() === normTerm);
  const best = exact || locations[0];

  const locationId = best.locationId || best.id;
  const locationName = best.searchName || best.name || best.displayName || searchTerm;
  if (!locationId) {
    throw new Error(`Location API returned no ID for "${searchTerm}": ${JSON.stringify(best).slice(0, 200)}`);
  }

  cache[key] = { id: locationId, name: locationName, fetchedAt: new Date().toISOString() };
  saveLocationCache(cache);

  process.stderr.write(`[reed-search] Resolved: ${searchTerm} -> ${locationId} (${locationName})\n`);
  return { id: locationId, name: locationName };
}

// ---------------------------------------------------------------- search

async function search(params) {
  const {
    keywords,
    location,
    distance = DEFAULT_DISTANCE,
    activeWithin = DEFAULT_ACTIVE_WITHIN,
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
    ukOnly = true,
    tempOnly = false,
    sortBy = 'relevancy',
  } = params;

  if (!keywords) throw new Error('keywords is required');
  if (!location) throw new Error('location is required');

  const { id: locationId } = await resolveLocation(location);

  const normActive = String(activeWithin).toLowerCase().trim();
  const activityTimeFrame = ACTIVITY_TIMEFRAME_MAP[normActive] || normActive || DEFAULT_ACTIVE_WITHIN;

  // Matches exactly what the recruiter portal sends
  const body = {
    currentPage: page,
    pageItemCount: pageSize,
    activityTimeFrame,
    activityType: 'active',
    locationDistance: distance,
    workEligibility: ukOnly ? 'ukOnly' : 'all',
    isPermanent: false,
    isTemporary: tempOnly,
    isContract: false,
    isFullTime: false,
    isPartTime: false,
    searchBy: 'cvAndJobTitle',
    languages: null,
    sectors: null,
    isCandidatesWithDrivingLicencesOnly: false,
    qualification: { type: null },
    source: { type: 'all' },
    keywords,
    salaryType: 'perAnnum',
    isCandidatesWithNoSalaryHidden: false,
    salaryFrom: null,
    salaryTo: null,
    sortBy,
    locationIds: [locationId],
  };

  process.stderr.write(`[reed-search] POST /candidate/search/boolean/ - "${keywords}" near ${location} (${distance}mi, ${activityTimeFrame}, page ${page})\n`);

  const data = await reedFetch('/candidate/search/boolean/', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  // Response: { result: { totalItemCount, pageItemCount, currentPage, candidates[] }, metaData: [{key, value}] }
  const resultObj = (data && data.result) || data;
  const totalCount = (resultObj && (resultObj.totalItemCount || resultObj.totalCount)) || 0;
  const rawCandidates = (resultObj && (resultObj.candidates || resultObj.items)) || [];
  const candidates = rawCandidates.map((c) => normalizeCandidateCard(c));
  const totalPages = totalCount > 0 ? Math.ceil(totalCount / pageSize) : 0;

  // queryId is required by the profile/CV download endpoints
  const queryIdMeta = (data.metaData || []).find((m) => m.key === 'QueryId');
  const queryId = (queryIdMeta && queryIdMeta.value) || null;

  return {
    totalCount,
    page: (resultObj && resultObj.currentPage) || page,
    pageSize: rawCandidates.length,
    pages: totalPages,
    candidates,
    queryId,
    dailyUsage: (resultObj && resultObj.dailyUsage) || null,
  };
}

// Normalise a raw Reed card (free search data, no credits spent).
function normalizeCandidateCard(raw) {
  const jp = raw.jobPreference || {};
  const loc = jp.locations || {};
  const sal = jp.salary || {};
  const elig = raw.jobEligibility || {};
  const emp = raw.employmentStatus || {};

  return {
    id: raw.candidateId,
    name: raw.name || '',
    firstName: raw.firstName || '',

    lastLogin: raw.lastLogin || null,
    lastLoginFriendly: raw.lastLoginFriendlyFormat || '',
    isNew: !!raw.isNew,
    isUnlocked: !!raw.isUnlocked,
    dateViewed: raw.dateViewed || null,
    dateHidden: raw.dateHidden || null,

    currentJobTitle: jp.currentJobTitle || '',
    desiredJobTitle: jp.desiredJobTitle || '',
    jobType: jp.jobType || '',
    currentLocation: loc.currentLocation || (loc.home && loc.home.town) || '',
    desiredLocations: loc.desiredLocations || '',
    salary: sal.minimumSalary || '',
    sectors: jp.sectors || null,

    hasWorkPermit: !!elig.hasWorkPermit,
    noticePeriod: emp.noticePeriod || null,

    _raw: raw,
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
Reed Candidate Search
Usage: node scripts/reed-search.js --keywords <terms> --location <postcode> [options]

Options:
  --keywords <terms>       Search keywords (required)
  --location <postcode>    Location postcode or city (required)
  --distance <miles>       Search radius in miles (default: 20)
  --active-within <period> Activity period: day, week, month, 3months, 6months, year (default: month)
  --page <n>               Page number (default: 1)
  --page-size <n>          Results per page: 25, 50, 100 (default: 25)
  --uk-only true|false     UK work eligibility filter (default: true)
  --temp-only true|false   Temporary contract only (default: false)
  --verbose                Include raw candidate data in output
  --help                   This text (exit 0)

Exit codes: 0 ok, 1 missing arguments or search failed.
`;

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.h) { process.stderr.write(USAGE); return 0; }

  const keywords = args.keywords || args.k;
  const location = args.location || args.l;
  const distance = Number(args.distance || args.d || 20);
  const activeWithin = args['active-within'] || args.active || 'month';
  const page = Number(args.page || 1);
  const pageSize = Number(args['page-size'] || args.pageSize || 25);
  const ukOnly = args['uk-only'] !== 'false';
  const tempOnly = args['temp-only'] === 'true';
  const verbose = !!args.verbose;

  if (!keywords || !location) {
    process.stderr.write(USAGE);
    return 1;
  }

  try {
    const result = await search({ keywords, location, distance, activeWithin, page, pageSize, ukOnly, tempOnly });
    if (!verbose) {
      result.candidates = result.candidates.map(({ _raw, ...rest }) => rest);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`\n[reed-search] Found ${result.totalCount} total candidates (showing page ${result.page}/${result.pages})\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`[reed-search] ERROR: ${err.message}\n`);
    if (err.message.includes('REED_RELOGIN_NEEDED')) {
      process.stderr.write('[reed-search] Run: node scripts/cdp-reed-full-login.js\n');
    }
    return 1;
  } finally {
    try { require('./reed-browser-fetch').closeCdp(); } catch { /* not loaded */ }
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

module.exports = {
  search,
  resolveLocation,
  normalizeCandidateCard,
  ACTIVITY_TIMEFRAME_MAP,
};
