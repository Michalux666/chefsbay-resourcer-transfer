#!/usr/bin/env node
/**
 * postcode-lookup.js
 *
 * Derives a UK postcode outcode (district) from a city/town name.
 * Used to populate Zip_Code for candidates whose source (e.g. Reed) does not
 * expose full address data via API.
 *
 * Resolution order (fastest -> slowest):
 *   1. Static table  - ~100 major UK cities hardcoded (zero latency)
 *   2. File cache    - results of past API lookups, stored in postcode-lookup-cache.json
 *   3. postcodes.io  - free public API, no auth, no credits:
 *                      GET https://api.postcodes.io/places?q={city}&limit=5
 *                      Filters to local_type "City" or "Town" to avoid suburb mismatches.
 *
 * Returns the outcode district only (e.g. "DE1", "LS1") - not a full postcode.
 * Outcode-level precision is sufficient for Zoho's radius search.
 *
 * Usage (module):
 *   const { lookupPostcodeForCity } = require('./postcode-lookup');
 *   const outcode = await lookupPostcodeForCity('Derby');  // -> 'DE1'
 *   const outcode = await lookupPostcodeForCity('Wigan');  // -> 'WN1'
 *   const outcode = await lookupPostcodeForCity('???');    // -> null
 *
 * Usage (CLI - for testing):
 *   node scripts/postcode-lookup.js Derby
 *   node scripts/postcode-lookup.js "Chester Le Street"
 */

'use strict';

const https = require('https');
const fs    = require('fs');

const paths = require('./lib/paths');
const fsx   = require('./lib/fsx');

const CACHE_FILE  = paths.p('postcode-lookup-cache.json');
const API_TIMEOUT = 5000; // ms

// -- Static table --------------------------------------------------------------
// Major UK cities and towns -> central outcode district.
// Hardcoded entries take priority over the API, preventing mismatches for
// ambiguous or commonly misspelled places (e.g. Pudsey, Flint).
// Add new entries here as needed - lowercase keys, no punctuation.
const STATIC_TABLE = {
  // England - North East
  'newcastle upon tyne': 'NE1',
  'newcastle':           'NE1',
  'gateshead':           'NE8',
  'sunderland':          'SR1',
  'south shields':       'NE33',
  'north shields':       'NE29',
  'hartlepool':          'TS24',
  'middlesbrough':       'TS1',
  'stockton on tees':    'TS18',
  'darlington':          'DL1',
  'durham':              'DH1',
  'chester le street':   'DH3',
  'consett':             'DH8',
  'bishop auckland':     'DL14',

  // England - North West
  'manchester':          'M1',
  'salford':             'M5',
  'liverpool':           'L1',
  'bootle':              'L20',
  'birkenhead':          'CH41',
  'ellesmere port':      'CH65',
  'wirral':              'CH41',  // peninsula district - Birkenhead is the main centre
  'chester':             'CH1',
  'warrington':          'WA1',
  'wigan':               'WN1',
  'bolton':              'BL1',
  'bury':                'BL9',
  'rochdale':            'OL16',
  'oldham':              'OL1',
  'stockport':           'SK1',
  'sale':                'M33',
  'altrincham':          'WA14',
  'northwich':           'CW9',
  'macclesfield':        'SK10',
  'crewe':               'CW1',
  'st helens':           'WA10',
  'st. helens':          'WA10',
  'runcorn':             'WA7',
  'widnes':              'WA8',
  'blackpool':           'FY1',
  'blackburn':           'BB1',
  'burnley':             'BB11',
  'lancaster':           'LA1',
  'preston':             'PR1',

  // England - Yorkshire & Humber
  'leeds':               'LS1',
  'bradford':            'BD1',
  'sheffield':           'S1',
  'york':                'YO1',
  'hull':                'HU1',
  'kingston upon hull':  'HU1',
  'huddersfield':        'HD1',
  'halifax':             'HX1',
  'wakefield':           'WF1',
  'barnsley':            'S70',
  'rotherham':           'S60',
  'doncaster':           'DN1',
  'scarborough':         'YO11',
  'harrogate':           'HG1',
  'batley':              'WF17',
  'castleford':          'WF10',
  'dewsbury':            'WF12',
  'keighley':            'BD21',
  'pudsey':              'LS28',
  'holmfirth':           'HD9',
  'selby':               'YO8',

  // England - East Midlands
  'derby':               'DE1',
  'nottingham':          'NG1',
  'leicester':           'LE1',
  'lincoln':             'LN1',
  'northampton':         'NN1',
  'alfreton':            'DE55',
  'ashbourne':           'DE6',

  // England - West Midlands
  'birmingham':          'B1',
  'coventry':            'CV1',
  'wolverhampton':       'WV1',
  'walsall':             'WS1',
  'west bromwich':       'B70',
  'stoke on trent':      'ST1',
  'stoke-on-trent':      'ST1',
  'stafford':            'ST16',
  'shrewsbury':          'SY1',

  // England - East of England
  'norwich':             'NR1',
  'cambridge':           'CB1',
  'ipswich':             'IP1',
  'peterborough':        'PE1',
  'luton':               'LU1',

  // England - London
  'london':              'EC1A',

  // England - South East
  'oxford':              'OX1',
  'reading':             'RG1',
  'brighton':            'BN1',
  'southampton':         'SO14',
  'portsmouth':          'PO1',
  'guildford':           'GU1',
  'maidstone':           'ME14',
  'canterbury':          'CT1',
  'folkestone':          'CT20',

  // England - South West
  'bristol':             'BS1',
  'bath':                'BA1',
  'exeter':              'EX1',
  'plymouth':            'PL1',
  'gloucester':          'GL1',
  'cheltenham':          'GL50',
  'swindon':             'SN1',

  // Wales
  'cardiff':             'CF10',
  'swansea':             'SA1',
  'newport':             'NP20',
  'flint':               'CH6',

  // Scotland
  'edinburgh':           'EH1',
  'glasgow':             'G1',
  'aberdeen':            'AB10',
  'dundee':              'DD1',
  'inverness':           'IV1',
};

// -- Cache helpers -------------------------------------------------------------

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch { /* corrupt cache - start fresh */ }
  return {};
}

function saveCache(cache) {
  try {
    fsx.writeJsonAtomic(CACHE_FILE, cache);
  } catch (e) {
    process.stderr.write(`[postcode-lookup] Warning: could not save cache: ${e.message}\n`);
  }
}

// -- Normalise city string -----------------------------------------------------
// Strips county suffix (e.g. "Leeds, West Yorkshire" -> "Leeds"),
// lowercases, and removes extraneous punctuation.
function normalise(cityStr) {
  if (!cityStr) return '';
  return cityStr
    .split(',')[0]        // drop county part
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ') // collapse whitespace
    .replace(/[-\u2013\u2014]/g, ' ')          // convert hyphens/dashes to spaces ("Sutton-in-Ashfield" -> "sutton in ashfield")
    .replace(/[^a-z0-9\s.']/g, '')  // strip remaining non-alphanumeric except spaces/apostrophes/periods
    .replace(/\s+/g, ' ')           // re-collapse any double-spaces created by hyphen replacement
    .trim();
}

// -- postcodes.io API call -----------------------------------------------------
function apiLookup(city) {
  return new Promise((resolve, reject) => {
    const q   = encodeURIComponent(city);
    const url = `https://api.postcodes.io/places?q=${q}&limit=5`;
    const req = https.get(url, { timeout: API_TIMEOUT }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const data    = JSON.parse(body);
          const results = data?.result || [];
          // Prefer City or Town match to avoid suburbs / hamlets with same name
          const hit = results.find(r => ['City', 'Town'].includes(r.local_type))
                   || results[0]
                   || null;
          resolve(hit?.outcode || null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// -- Main export ---------------------------------------------------------------

/**
 * Look up the outcode (postcode district) for a UK city or town name.
 *
 * @param {string} cityName  - City or town name, optionally followed by county
 *                             e.g. "Derby", "Leeds, West Yorkshire", "St. Helens"
 * @returns {Promise<string|null>}  Outcode district (e.g. "DE1") or null if unknown
 */
async function lookupPostcodeForCity(cityName) {
  const norm = normalise(cityName);
  if (!norm) return null;

  // 1. Static table
  if (STATIC_TABLE[norm]) {
    process.stderr.write(`[postcode-lookup] Static hit: "${cityName}" -> ${STATIC_TABLE[norm]}\n`);
    return STATIC_TABLE[norm];
  }

  // 2. File cache
  const cache = loadCache();
  if (norm in cache) {
    const cached = cache[norm];
    process.stderr.write(`[postcode-lookup] Cache hit: "${cityName}" -> ${cached || 'null'}\n`);
    return cached || null;
  }

  // 3. postcodes.io API
  process.stderr.write(`[postcode-lookup] API lookup: "${cityName}"...\n`);
  const outcode = await apiLookup(norm);
  process.stderr.write(`[postcode-lookup] API result: "${cityName}" -> ${outcode || 'null'}\n`);

  // Cache the result (including null - so we don't retry failures repeatedly)
  cache[norm] = outcode;
  saveCache(cache);

  return outcode;
}

module.exports = { lookupPostcodeForCity, normalise, STATIC_TABLE, CACHE_FILE };

// -- CLI mode ------------------------------------------------------------------
if (require.main === module) {
  const city = process.argv.slice(2).join(' ');
  if (city === '--help' || city === '-h') {
    console.log('Usage: node scripts/postcode-lookup.js <city name>\nPrints "<city> -> <outcode>" (exit 0) or "<city> -> no result" (exit 1).');
    process.exit(0);
  }
  if (!city) {
    console.error('Usage: node scripts/postcode-lookup.js <city name>');
    process.exit(1);
  }
  lookupPostcodeForCity(city).then(outcode => {
    if (outcode) {
      console.log(`${city} -> ${outcode}`);
    } else {
      console.log(`${city} -> no result`);
      process.exit(1);
    }
  });
}
