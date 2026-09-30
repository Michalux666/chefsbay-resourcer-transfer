#!/usr/bin/env node
/**
 * zoho-create-candidate.js
 */

const fs = require('fs');
const path = require('path');
const { mapToApplyingForRole } = require('./applying-for-role-map');
const { zohoRequest } = require('./zoho-auth');
const { lookupCityForPostcode, isPostcode } = require('./lib/postcode-to-city');

// Decode the HTML entities the Caterer scrape leaves in field values (see PAYLOAD_FIX below).
const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeHtmlEntities(s) {
  return String(s).replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === '#') {
      const n = g[1].toLowerCase() === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(n) ? String.fromCharCode(n) : m;
    }
    const k = g.toLowerCase();
    return HTML_ENTITIES[k] !== undefined ? HTML_ENTITIES[k] : m;
  });
}

function normaliseCountry(raw) {
  if (!raw) return 'United Kingdom';
  const s = raw.trim().toUpperCase();
  if (s === 'UK' || s === 'GB' || s === 'UNITED KINGDOM' || s === 'GREAT BRITAIN') return 'United Kingdom';
  return raw.trim();
}

const PROTECTED_STATUSES = new Set([
  'Awaiting Training / Contract Signed',
  'Complete',
  'Contract Sent',
  'ID verification',
  'Move to Ubeya',
  'Training Expired / On Ubeya',
  'Visa Expired',
]);

const ENRICHABLE_FIELDS = [
  'Mobile',
  'Current_Job_Title',
  'City',
  'Zip_Code',
  'State',
  'Country',
  'Experience_in_Years',
];

async function fetchZohoCandidate(zohoId) {
  const fields = ['id', 'Candidate_Status', ...ENRICHABLE_FIELDS].join(',');
  const data = await zohoRequest('GET', `/Candidates/${zohoId}?fields=${fields}`, undefined, true, 30000);
  return data?.data?.[0] || null;
}

function buildEnrichmentPatch(zohoRecord, catererPayload) {
  const patch = {};
  for (const field of ENRICHABLE_FIELDS) {
    const zohoVal = zohoRecord[field];
    const catVal = catererPayload[field];
    const zohoEmpty = zohoVal === null || zohoVal === undefined || zohoVal === '';
    const catHas = catVal !== null && catVal !== undefined && catVal !== '';

    if (!zohoEmpty || !catHas) continue;

    if (field === 'State' && catererPayload.City) {
      const stateNorm = String(catVal).trim().toLowerCase();
      const cityNorm = String(catererPayload.City).trim().toLowerCase();
      if (stateNorm === cityNorm) {
        console.log(`ENRICH_SKIP: State="${catVal}" matches City="${catererPayload.City}" - Caterer data quality issue, skipping`);
        continue;
      }
    }

    if (field === 'Current_Job_Title') {
      const postcodeRe = /^[A-Z]{1,2}[0-9][0-9A-Z]?\s?[0-9][A-Z]{2}$/i;
      if (postcodeRe.test(String(catVal).trim())) {
        console.log(`ENRICH_SKIP: Current_Job_Title="${catVal}" looks like a postcode - Caterer data quality issue, skipping`);
        continue;
      }
    }

    patch[field] = catVal;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

async function createCandidate(candidate) {
  if (!candidate.Last_Name) throw new Error('ERROR: Last_Name is required');

  // Determine source: Reed or Caterer
  const isReed = !!(candidate.ReedID || candidate.reedID || candidate.source === 'Reed' || candidate.source === 'reed');
  const isCaterer = !isReed;

  // Normalise: support legacy reedID key in addition to correct ReedID
  if (candidate.reedID && !candidate.ReedID) candidate.ReedID = candidate.reedID;

  // Validate required ID field based on source
  if (isCaterer && !candidate.CatererID) throw new Error('ERROR: CatererID is required for Caterer source');
  if (isReed    && !candidate.ReedID)    throw new Error('ERROR: ReedID is required for Reed source');

  if (!candidate.Applying_for_role) {
    const titleForMapping = candidate.Search_Job_Title || 'Chef';
    const mapped = mapToApplyingForRole(titleForMapping);
    if (mapped) candidate.Applying_for_role = mapped;
  }

  // 2026-08-24: SALVAGE a postcode misfiled into Current_Job_Title.
  // The Caterer scrape routinely puts the candidate's postcode in Current_Job_Title and
  // leaves City empty. Zoho requires City, so the push died with MANDATORY_NOT_FOUND and the
  // candidate was left unlocked-but-never-pushed; 1,200+ had silently accumulated before this
  // was found. We used to just discard the stray value -- now we use it: it fills Zip_Code and
  // derives City. Best-effort: if the lookup fails we leave things as they were.
  {
    // 2026-09-04: decode HTML entities across every string field FIRST. The scrape leaves raw
    // entities in place, and they break two things: a postcode hidden behind one is not
    // recognised as a postcode at all (observed: Current_Job_Title "E6&#160; 3DT", a valid
    // E6 3DT behind a non-breaking space, which stranded the candidate on missing City), and
    // Zoho rejects entity-laden emails outright (INVALID_DATA on "...@&#39;hotmail.co.uk").
    for (const [k, v] of Object.entries(candidate)) {
      if (typeof v === 'string' && /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/.test(v)) {
        const decoded = decodeHtmlEntities(v).replace(/\s+/g, ' ').trim();
        if (decoded !== v) {
          candidate[k] = decoded;
          console.log(`PAYLOAD_FIX: decoded HTML entities in ${k}`);
        }
      }
    }

    const strayTitle = String(candidate.Current_Job_Title || '').trim();
    if (strayTitle && isPostcode(strayTitle)) {
      if (!String(candidate.Zip_Code || '').trim()) candidate.Zip_Code = strayTitle.toUpperCase();
      if (!String(candidate.City || '').trim()) {
        try {
          const city = await lookupCityForPostcode(strayTitle);
          if (city) {
            candidate.City = city;
            console.log(`PAYLOAD_FIX: Current_Job_Title="${strayTitle}" is a postcode -> Zip_Code + City="${city}"`);
          } else {
            console.log(`PAYLOAD_WARN: Current_Job_Title="${strayTitle}" is a postcode but did not resolve to a city`);
          }
        } catch (e) {
          console.log(`PAYLOAD_WARN: postcode->city lookup failed for "${strayTitle}": ${e.message}`);
        }
      }
      candidate.Current_Job_Title = '';   // it was never a job title
    }
  }

  const payload = {};

  // Source-specific field maps
  // Reed uses 'ReedID'; Caterer uses 'CatererID'
  const FIELD_MAP_COMMON = [
    'First_Name', 'Last_Name', 'Email', 'Mobile', 'Current_Job_Title',
    'Account_Name', 'City', 'Zip_Code', 'State', 'Country',
    'Experience_in_Years', 'Source', 'Applying_for_role', 'Search_Criteria',
  ];
  const FIELD_MAP = isCaterer
    ? [...FIELD_MAP_COMMON, 'CatererID']
    : [...FIELD_MAP_COMMON, 'ReedID'];

  const UK_POSTCODE_RE = /^[A-Z]{1,2}[0-9][0-9A-Z]?\s?[0-9][A-Z]{2}$/i;
  for (const field of FIELD_MAP) {
    const val = candidate[field];
    if (val === undefined || val === null || val === '') continue;

    if (field === 'Current_Job_Title' && UK_POSTCODE_RE.test(String(val).trim())) {
      console.log(`PAYLOAD_SKIP: Current_Job_Title="${val}" is a postcode - omitting from Zoho record`);
      continue;
    }

    payload[field] = field === 'Country' ? normaliseCountry(val) : val;
  }

  // Set source
  payload.Source = isReed ? 'Reed' : 'Caterer';
  payload.Candidate_Status = 'New';

  const result = await zohoRequest('POST', '/Candidates', { data: [payload], trigger: ['workflow'] }, true, 30000);
  const record = result?.data?.[0];
  if (!record) throw new Error(`ERROR: Unexpected Zoho response: ${JSON.stringify(result)}`);

  if (record.status === 'success') {
    return { zohoId: record.details?.id, isDuplicate: false, enrichment: null };
  }

  if (record.code !== 'DUPLICATE_DATA') {
    throw new Error(`ERROR: ${record.code} ${record.message} ${JSON.stringify(record.details)}`);
  }

  const zohoId = record.details?.id;
  let enrichmentApplied = false;
  let enrichedFields = [];
  let protectedStatus = null;

  // Build the ID backfill object - for Caterer: CatererID, for Reed: ReedID
  const idBackfill = isReed
    ? { id: zohoId, ReedID: payload.ReedID }
    : { id: zohoId, CatererID: payload.CatererID };

  try {
    const zohoRecord = await fetchZohoCandidate(zohoId);

    if (zohoRecord) {
      const status = zohoRecord.Candidate_Status || '';

      if (PROTECTED_STATUSES.has(status)) {
        protectedStatus = status;
      } else {
        const patch = buildEnrichmentPatch(zohoRecord, payload);
        if (patch) {
          const putResult = await zohoRequest('PUT', '/Candidates', { data: [{ ...idBackfill, ...patch }] }, true, 30000);
          const putRecord = putResult?.data?.[0];
          if (putRecord?.status === 'success') {
            enrichmentApplied = true;
            enrichedFields = Object.keys(patch);
          } else {
            console.error('ENRICH_WARN: PUT failed:', JSON.stringify(putRecord));
            await zohoRequest('PUT', '/Candidates', { data: [{ ...idBackfill }] }, true, 30000);
          }
        } else {
          await zohoRequest('PUT', '/Candidates', { data: [{ ...idBackfill }] }, true, 30000);
        }
      }
    }

    if (protectedStatus) {
      await zohoRequest('PUT', '/Candidates', { data: [{ ...idBackfill }] }, true, 30000);
    }
  } catch (e) {
    console.error('ENRICH_ERROR:', e.message);
    try {
      await zohoRequest('PUT', '/Candidates', { data: [{ ...idBackfill }] }, true, 30000);
    } catch (_) { }
  }

  if (enrichmentApplied) {
    console.log(`DUPLICATE_ENRICHED ZOHO_ID=${zohoId} fields=${enrichedFields.join(',')}`);
  } else if (protectedStatus) {
    console.log(`DUPLICATE_PROTECTED ZOHO_ID=${zohoId} status=${protectedStatus}`);
  } else {
    console.log(`DUPLICATE_NO_GAPS ZOHO_ID=${zohoId}`);
  }

  return {
    zohoId,
    isDuplicate: true,
    enrichment: enrichmentApplied ? 'enriched' : (protectedStatus ? 'protected' : 'none'),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: node zoho-create-candidate.js <json-file>  OR  --json \'{"First_Name":...}\'');
    return;
  }
  if (!args.length) {
    console.error('Usage: node zoho-create-candidate.js <json-file>  OR  --json \'{"First_Name":...}\'');
    process.exit(1);
  }

  let candidate;
  if (args[0] === '--json') {
    candidate = JSON.parse(args[1]);
  } else {
    const filePath = path.resolve(args[0]);
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
    candidate = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  try {
    const result = await createCandidate(candidate);
    if (result.isDuplicate) {
      console.log(`DUPLICATE ZOHO_ID=${result.zohoId}`);
    } else {
      console.log(`ZOHO_ID=${result.zohoId}`);
    }
    setTimeout(() => process.exit(0), 100);
  } catch (err) {
    console.error(err.message || String(err));
    setTimeout(() => process.exit(1), 100);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('FATAL:', err.message);
    setTimeout(() => process.exit(1), 100);
  });
}

module.exports = { createCandidate, buildEnrichmentPatch, decodeHtmlEntities, normaliseCountry };
