#!/usr/bin/env node
/**
 * fill-mandatory-fields.js
 *
 * Pre-push recovery: checks all Zoho mandatory fields in a candidate JSON and
 * attempts to fill any gaps before the Zoho push is attempted.
 *
 * Mandatory fields: First_Name, Last_Name, Mobile, City, Email
 *
 * Recovery strategies (mandatory):
 *   Mobile     -> regex scan of CV text (docx / pdf / doc)
 *   Email      -> regex scan of CV text
 *   City       -> derived from Zip_Code via UK postcode-area lookup table
 *   First_Name -> extracted from first line(s) of CV; fallback: 'Candidate'
 *   Last_Name  -> extracted from first line(s) of CV; fallback: CatererID
 *
 * Optional enrichment (non-blocking - never prevents a Zoho push):
 *   Zip_Code   -> derived from City via postcode-lookup.js (static table + postcodes.io API).
 *                Reed candidates never have a postcode from the API; this fills the gap
 *                so Zoho's radius search (e.g. "Derby within 15 miles") works correctly.
 *                Returns outcode district only (e.g. "DE1") - sufficient for Zoho search.
 *
 * As a module:
 *   const { fillMandatoryFields } = require('./fill-mandatory-fields');
 *   const result = await fillMandatoryFields(jsonPath, cvPath);
 *   // -> { patched: true, recovered: ['Mobile','City'], enriched: ['Zip_Code=DE1'], stillMissing: [] }
 *
 * As CLI (for debugging):
 *   node scripts/fill-mandatory-fields.js downloads/candidate-12345.json [downloads/cv-12345.docx]
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const paths = require('./lib/paths');
const fsx = require('./lib/fsx');
const { lookupPostcodeForCity } = require('./postcode-lookup');

// --- Mandatory field list -----------------------------------------------------
const MANDATORY = ['First_Name', 'Last_Name', 'Mobile', 'City', 'Email'];

// --- UK postcode area -> city lookup ------------------------------------------
// Single source of truth: config/postcode-cities.json (richer data with county).
// We extract the city field from each entry to build the lookup map.
const POSTCODE_CITIES_PATH = path.join(paths.CONFIG, 'postcode-cities.json');
const _rawPostcodeCities = JSON.parse(fs.readFileSync(POSTCODE_CITIES_PATH, 'utf8'));
const POSTCODE_CITY = {};
for (const [prefix, entry] of Object.entries(_rawPostcodeCities)) {
  POSTCODE_CITY[prefix] = entry.city || entry;
}

/**
 * Derive a city name from a UK postcode.
 * Handles "York, YO41 1FQ" format (strips leading place name).
 * Tries the longest matching prefix first (e.g. NE before N).
 */
function deriveCity(postcode) {
  if (!postcode) return null;
  // Strip leading "City, " prefix if Caterer injected one
  const cleaned = postcode.replace(/^[^,]+,\s*/, '').trim().toUpperCase().replace(/\s+/, '');
  // Extract letter prefix (1-2 chars before the first digit)
  const m = cleaned.match(/^([A-Z]{1,2})\d/);
  if (!m) return null;
  const prefix = m[1];
  // Try 2-char first, then 1-char fallback
  return POSTCODE_CITY[prefix] || POSTCODE_CITY[prefix[0]] || null;
}

// --- CV text extraction -------------------------------------------------------

/**
 * Strip HTML tags from a string to get plain text.
 * Used when a .doc file is actually an HTML page (e.g. captive portal redirect).
 */
function stripHtml(html) {
  // Linear scans only: the regex forms (lazy script/style spans, "<[^>]+>") are quadratic on hostile input.
  const dropBlocks = (text, tag) => {
    const lower = text.toLowerCase();
    const open = `<${tag}`;
    const close = `</${tag}>`;
    let out = '';
    let i = 0;
    for (;;) {
      const s = lower.indexOf(open, i);
      if (s < 0) return out + text.slice(i);
      out += text.slice(i, s) + ' ';
      const e = lower.indexOf(close, s);
      if (e < 0) return out;
      i = e + close.length;
    }
  };
  const dropTags = (text) => {
    let out = '';
    let i = 0;
    for (;;) {
      const s = text.indexOf('<', i);
      if (s < 0) return out + text.slice(i);
      const e = text.indexOf('>', s);
      if (e < 0) return out + text.slice(i);
      out += text.slice(i, s) + ' ';
      i = e + 1;
    }
  };
  return dropTags(dropBlocks(dropBlocks(html, 'script'), 'style'))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Max bytes read from any CV file - prevents OOM on maliciously large files
const CV_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

// Contact details sit at the top of a CV; a hostile file must not hand the regex scans megabytes of text.
const CV_TEXT_MAX_CHARS = 200 * 1024;

async function extractCvText(cvPath) {
  const text = await extractCvTextUncapped(cvPath);
  return text.length > CV_TEXT_MAX_CHARS ? text.slice(0, CV_TEXT_MAX_CHARS) : text;
}

async function extractCvTextUncapped(cvPath) {
  if (!cvPath || !fs.existsSync(cvPath)) return '';
  const ext  = path.extname(cvPath).toLowerCase();
  const stat = fs.statSync(cvPath);
  if (stat.size > CV_MAX_BYTES) {
    console.warn(`[fill-mandatory-fields] CV too large (${stat.size} bytes), skipping text extraction: ${cvPath}`);
    return '';
  }
  try {
    if (ext === '.docx') {
      const mammoth = require('mammoth');
      const result  = await mammoth.extractRawText({ path: cvPath });
      return result.value || '';
    }
    if (ext === '.pdf') {
      // pdf-parse v2 exports a PDFParse class; the v1 call form (a function) throws and was swallowed here for every PDF
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse({ data: fs.readFileSync(cvPath) });
      try {
        const data = await parser.getText();
        return data.text || '';
      } finally {
        await parser.destroy().catch(() => {});
      }
    }
    // .doc / .rtf / .txt - best-effort raw read of local bytes only (no network)
    const raw     = fs.readFileSync(cvPath, 'latin1');
    const trimmed = raw.trimStart();
    // Detect HTML masquerading as .doc (captive portal, auth wall saved as .doc).
    // Strip tags locally - no URLs are followed; this is pure local text processing.
    if (/^<(!DOCTYPE|HTML)/i.test(trimmed)) {
      return stripHtml(raw);
    }
    return raw;
  } catch {
    return '';
  }
}

// The candidate file holds personal data: replace it atomically and keep it owner-only.
function writeCandidate(jsonPath, profile) {
  fsx.writeJsonAtomic(jsonPath, profile, 0o600);
}

// --- Field extractors ---------------------------------------------------------

function findPhone(text) {
  const patterns = [
    /(\+44[\s\-.]?7\d{3}[\s\-.]?\d{3}[\s\-.]?\d{3,4})/g,
    /(\+44[\s\-.]?\d{2,4}[\s\-.]?\d{3,4}[\s\-.]?\d{3,4})/g,
    /(07\d{3}[\s\-.]?\d{3}[\s\-.]?\d{3,4})/g,
    /(0\d{3,4}[\s\-.]?\d{3,4}[\s\-.]?\d{3,4})/g,
  ];
  const seen = new Map();
  for (const pat of patterns) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(text)) !== null) {
      const clean = m[1].replace(/[\s\-\.]/g, '');
      if (clean.length >= 10 && clean.length <= 14) seen.set(clean, m[1]);
    }
  }
  if (!seen.size) return null;
  // Prefer UK mobiles (07xxx / +447xxx)
  for (const d of seen.keys()) {
    if (d.startsWith('07') || d.startsWith('+447')) return d;
  }
  return seen.keys().next().value;
}

function findEmail(text) {
  // Bounded quantifiers (RFC limits: 64 local part, 255 domain): the unbounded form is quadratic on a long run of local-part characters.
  const m = text.slice(0, CV_TEXT_MAX_CHARS).match(/[a-zA-Z0-9._%+\-]{1,64}@[a-zA-Z0-9.\-]{1,255}\.[a-zA-Z]{2,}/g);
  if (!m) return null;
  return m.find(e => !e.toLowerCase().includes('example') && !e.toLowerCase().startsWith('test@')) || null;
}

/**
 * Common CV headings that look like 2-3 word "names" - must be skipped.
 */
const NAME_BLOCKLIST = /^(curriculum\s+vitae|personal\s+(statement|details|profile|summary)|professional\s+(profile|summary|experience)|cover\s+letter|reference|education|employment\s+history|work\s+experience|key\s+skills|career\s+(summary|objective|history)|executive\s+summary|about\s+me)$/i;

/**
 * Attempt to extract a candidate's name from the first few lines of CV text.
 * Heuristic: first short (2-5 word) line made entirely of letters, hyphens, or apostrophes.
 * Skips common CV headings that match the pattern (e.g. "Curriculum Vitae").
 * Returns { first, last } or null.
 */
function findName(text) {
  const lines = text
    .split(/[\r\n]+/)
    .map(l => l.trim())
    .filter(Boolean);

  for (const line of lines.slice(0, 8)) {
    const words = line.split(/\s+/);
    if (
      words.length >= 2 &&
      words.length <= 5 &&
      words.every(w => /^[A-Za-z\-'\.]{2,}$/.test(w)) &&
      !NAME_BLOCKLIST.test(line)
    ) {
      return {
        first: words[0],
        last:  words.slice(1).join(' '),
      };
    }
  }
  return null;
}

// --- Main fill function -------------------------------------------------------

/**
 * Fill missing mandatory fields in a candidate JSON file.
 *
 * @param {string} jsonPath  - Path to the candidate JSON file (read + written in-place)
 * @param {string|null} cvPath   - Path to the CV file (optional but enables most recoveries)
 * @returns {Promise<{ patched: boolean, recovered: string[], stillMissing: string[] }>}
 */
async function fillMandatoryFields(jsonPath, cvPath) {
  if (!fs.existsSync(jsonPath)) {
    return { patched: false, recovered: [], stillMissing: MANDATORY.slice() };
  }

  const profile = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  // Identify which mandatory fields are missing
  const missing = MANDATORY.filter(f => !profile[f] || String(profile[f]).trim() === '');

  // Check if Zip_Code enrichment is also needed (common for Reed candidates, which never
  // have a postcode from the API). We must NOT early-return before the enrichment block.
  const needsZipEnrichment = !profile.Zip_Code || !String(profile.Zip_Code).trim();

  if (!missing.length && !needsZipEnrichment) {
    return { patched: false, recovered: [], stillMissing: [] };
  }

  // Lazily extract CV text only if needed for text-based fields
  const needsCvText = missing.some(f => ['Mobile', 'Email', 'First_Name', 'Last_Name'].includes(f));
  const cvText = needsCvText ? await extractCvText(cvPath) : '';

  const recovered    = [];
  const stillMissing = [];

  for (const field of missing) {
    let value = null;

    switch (field) {
      case 'Mobile':
        // Try CV text first; fall back to placeholder so Zoho push never fails on Mobile.
        // Recruiters can update the real number once the candidate is in Zoho.
        value = findPhone(cvText) || '07777777777';
        break;

      case 'Email':
        value = findEmail(cvText);
        // No fallback - if the profile has no email and the CV has no email,
        // the candidate is skipped at the pre-push check rather than pushed
        // with a placeholder (which would be useless for outreach anyway).
        break;

      case 'City':
        value = deriveCity(profile.Zip_Code);
        break;

      case 'First_Name': {
        const n = findName(cvText);
        value = n ? n.first : 'Candidate';  // safe fallback - better than Zoho rejection
        break;
      }

      case 'Last_Name': {
        const n = findName(cvText);
        if (n) {
          // If First_Name was already filled by name extraction, use the same parse
          value = n.last || profile.CatererID;
        } else {
          value = profile.CatererID || 'Unknown';
        }
        break;
      }
    }

    if (value) {
      profile[field] = value;
      recovered.push(`${field}=${value}`);
    } else {
      stillMissing.push(field);
    }
  }

  if (recovered.length) {
    writeCandidate(jsonPath, profile);
  }

  // -- Optional enrichment: Zip_Code from City --------------------------------
  // Runs after mandatory fields so City is guaranteed to be resolved first.
  // Non-blocking: failure here never prevents the Zoho push.
  // Particularly important for Reed candidates, which never have a postcode
  // from the API - without it, Zoho radius search won't find them.
  const enriched = [];
  if (!profile.Zip_Code || !String(profile.Zip_Code).trim()) {
    const city = profile.City || '';
    if (city && city.trim()) {
      try {
        const outcode = await lookupPostcodeForCity(city);
        if (outcode) {
          profile.Zip_Code = outcode;
          enriched.push(`Zip_Code=${outcode}`);
          // Write back to disk (may be a second write if mandatory fields were also patched)
          writeCandidate(jsonPath, profile);
        }
      } catch (e) {
        // Non-fatal - log and continue
        process.stderr.write(`[fill-mandatory-fields] Zip_Code enrichment failed for "${city}": ${e.message}\n`);
      }
    }
  }

  return {
    patched:      recovered.length > 0 || enriched.length > 0,
    recovered,
    enriched,
    stillMissing,
  };
}

// --- CLI mode ----------------------------------------------------------------
if (require.main === module) {
  const jsonPath = process.argv[2];
  const cvPath   = process.argv[3] || null;

  if (jsonPath === '--help' || jsonPath === '-h') {
    console.log('Usage: node fill-mandatory-fields.js <candidate.json> [cv-file]');
    process.exit(0);
  }

  if (!jsonPath) {
    console.error('Usage: node fill-mandatory-fields.js <candidate.json> [cv-file]');
    process.exit(1);
  }

  fillMandatoryFields(path.resolve(jsonPath), cvPath ? path.resolve(cvPath) : null)
    .then(result => {
      if (result.recovered.length)    console.log('Recovered:', result.recovered.map(r => r.split('=')[0]).join(', '));
      if (result.stillMissing.length) console.log('Still missing:', result.stillMissing.join(', '));
      if (!result.patched)            console.log('All mandatory fields already present.');
    })
    .catch(err => { console.error('Error:', err.message); process.exit(1); });
}

module.exports = { fillMandatoryFields, deriveCity, findPhone, findEmail, findName, extractCvText, MANDATORY };
