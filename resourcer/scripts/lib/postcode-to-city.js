// Reverse UK postcode -> city (admin_district), with an on-disk cache.
//
// Why this exists (2026-08-24): the Caterer scrape misfiles the candidate's POSTCODE into
// Current_Job_Title and leaves City empty. Zoho requires City, so every such push died with
// MANDATORY_NOT_FOUND and the candidate was left unlocked-but-never-pushed -- 1,200+ of them
// had accumulated. zoho-create-candidate.js used to just discard the stray postcode; now it
// uses it to fill Zip_Code and derive City through this helper.
//
// Counterpart to scripts/postcode-lookup.js, which goes the other way (city -> outcode).
// Uses postcodes.io: free, public, no auth, no credits.
'use strict';

const fs = require('fs');
const paths = require('./paths');
const fsx = require('./fsx');

const CACHE_PATH = paths.p('postcode-to-city-cache.json');
const API = 'https://api.postcodes.io/postcodes/';

const UK_POSTCODE_RE = /^[A-Z]{1,2}[0-9][0-9A-Z]?\s?[0-9][A-Z]{2}$/i;

function normalise(pc) {
  return String(pc || '').toUpperCase().replace(/\s+/g, ' ').trim();
}

function isPostcode(s) {
  return UK_POSTCODE_RE.test(String(s || '').trim());
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch (e) { return {}; }
}

function saveCache(cache) {
  try { fsx.writeJsonAtomic(CACHE_PATH, cache); } catch (e) { /* cache is best-effort */ }
}

// Returns a city string, or null if the postcode cannot be resolved.
// Negative results are cached too (as null) so a bad postcode is not re-queried forever.
async function lookupCityForPostcode(postcode, { timeoutMs = 8000 } = {}) {
  const key = normalise(postcode);
  if (!key || !isPostcode(key)) return null;

  const cache = loadCache();
  if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];

  let city = null;
  let timer;
  try {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(API + encodeURIComponent(key), { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const j = await res.json();
      const r = j && j.result;
      // admin_district is the local authority (e.g. "Westminster") -- the closest thing
      // postcodes.io gives to a town/city name and what Zoho's City field wants.
      if (r) city = r.admin_district || r.parish || r.region || null;
    }
  } catch (e) {
    // Network failure: do NOT cache, so a later run can retry.
    clearTimeout(timer);
    return null;
  }

  // 2026-09-04: fall back to the OUTCODE when the full postcode does not resolve.
  // Terminated/retired postcodes (common on older CVs -- W1J 7BN, EC2V 8AN, W1W 6AJ all
  // 404 on the live endpoint) would otherwise fail the Zoho push on missing City and strand
  // the candidate. The outcode endpoint returns every district the outcode spans, so for a
  // multi-borough outcode this is APPROXIMATE (W1J -> "Islington" when it is really
  // Mayfair/Westminster). An approximate City beats losing the candidate, and the exact
  // postcode is still stored in Zip_Code.
  if (!city) {
    const outcode = key.split(' ')[0];
    if (outcode && outcode !== key) {
      let t2;
      try {
        const ctrl2 = new AbortController();
        t2 = setTimeout(() => ctrl2.abort(), timeoutMs);
        const res2 = await fetch('https://api.postcodes.io/outcodes/' + encodeURIComponent(outcode), { signal: ctrl2.signal });
        clearTimeout(t2);
        if (res2.ok) {
          const j2 = await res2.json();
          const r2 = j2 && j2.result;
          const pick = v => Array.isArray(v) ? v[0] : v;
          if (r2) city = pick(r2.admin_district) || pick(r2.parish) || pick(r2.region) || null;
        }
      } catch (e) { clearTimeout(t2); return null; }   // network failure: don't cache a false negative
    }
  }

  cache[key] = city;
  saveCache(cache);
  return city;
}

module.exports = { lookupCityForPostcode, isPostcode, normalise, CACHE_PATH };
