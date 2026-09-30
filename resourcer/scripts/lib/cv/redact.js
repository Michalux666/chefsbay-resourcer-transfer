'use strict';
// Adapter over the CV redactor. Interfaces:
//   redactCv(text, known) -> Promise<{text, verified, counts}>   text with names, contact details, addresses and referees removed;
//                                                                verified = an independent check found nothing left
//   scrubRecord(record, known) -> {record, changed, verified}    the last barrier before anything goes to Jev: a whitelisted copy of
//                                                                a parsed record (title, employer, dates, duties, qualifications
//                                                                only) with every pattern of personal data masked
// known = {names, emails, phones, postcodes} of the candidate as the pipeline already holds them. Uses ./vendor/cv-redact.js when
// installed (its redactCv/verifyRedaction), else ./stubs/redact-stub.js.

const { normalizeParseConfidence } = require('./facts');

let vendored = null;
try { vendored = require('./vendor/cv-redact'); } catch (e) { vendored = null; }
const stub = require('./stubs/redact-stub');

function clean(list) { return (Array.isArray(list) ? list : []).map(x => String(x === undefined || x === null ? '' : x).trim()).filter(Boolean); }

function knownCtx(known) {
  const k = known || {};
  return { names: clean(k.names), emails: clean(k.emails), phones: clean(k.phones), postcodes: clean(k.postcodes) };
}

// No CV is this long: whatever is beyond is cut before any pattern runs, so a hostile file cannot make the redactor slow.
const MAX_TEXT_CHARS = 200000;

async function redactCv(text, known) {
  const ctx = knownCtx(known);
  const input = String(text || '').slice(0, MAX_TEXT_CHARS);
  if (vendored) {
    const r = await vendored.redactCv(input, { ...ctx, guessName: true });
    const out = typeof r === 'string' ? r : String((r && r.text) || '');
    let verified = false;
    try {
      verified = vendored.verifyRedaction ? !!vendored.verifyRedaction(out, ctx).ok : false;
      // its independent, looser scan: a leftover e-mail, phone number, postcode, insurance number or birth date is not verified
      if (verified && vendored.scanResidual) {
        const c = vendored.scanResidual(out);
        verified = !(c.email || c.phone || c.postcode || c.nino || c.dob);
      }
    } catch (e) { verified = false; }
    return { text: out, verified, counts: (r && r.counts) || {} };
  }
  const r = stub.redactCv(input, ctx);
  return { text: r.text, verified: stub.verifyRedaction(r.text, ctx).ok, counts: r.counts };
}

const BS = String.fromCharCode(92);
const BEFORE = String.raw`(?<![\p{L}])`;
const AFTER = String.raw`(?![\p{L}])`;
const SPACES = String.raw`\s+`;
const reEscape = s => Array.from(String(s)).map(ch => ('.*+?^${}()|[]'.includes(ch) || ch === BS ? BS + ch : ch)).join('');

// Whole names ("First Last" in either order) and long name parts (6 letters or more, so a surname that is also a common word stays).
function nameMatchers(names) {
  const list = [];
  for (const full of names) {
    const parts = full.split(/\s+/).filter(p => p.length >= 2);
    if (parts.length >= 2) {
      list.push(new RegExp(BEFORE + reEscape(parts[0]) + SPACES + reEscape(parts[parts.length - 1]) + AFTER, 'giu'));
      list.push(new RegExp(BEFORE + reEscape(parts[parts.length - 1]) + SPACES + reEscape(parts[0]) + AFTER, 'giu'));
    }
    for (const p of parts) if (p.length >= 6) list.push(new RegExp(BEFORE + reEscape(p) + AFTER, 'giu'));
  }
  return list;
}

// Fields are cut before any pattern runs (a hostile field must not make the patterns quadratic); the stage keeps at most 200 characters of duties anyway.
const FIELD_LIMIT = 1500;
const MAX_ROLES_SCANNED = 200;

// Another person named after a relation ("reported to Ottoline Farthing", "led by Mr Quill"): the words of the reader's own vocabulary
// (titles, employers) stay, anything else that is capitalised after the cue is masked. Without the vocabulary every such word is masked.
let vocabulary = null;
try { vocabulary = require('./vendor/cv-lexicon'); } catch (e) { vocabulary = null; }
const RELATION = /\b([Rr]eport(?:ed|ing|s)? to|[Mm]anaged by|[Ss]upervised by|[Tt]rained by|[Ll]ed by|[Mm]entored by|[Cc]oached by|[Ww]orked (?:with|under)|[Aa]ssistant to|[Dd]eputy to|[Uu]nder)([ \t:,-]+)((?:(?:Mr|Mrs|Ms|Miss|Dr)\.?[ \t]+)?(?:(?:[A-Z][a-z]{2,}|[A-Z]{2,4})[ \t-]?){1,4})/g;
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'the', 'and', 'of']);

function isVocabulary(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  return HONORIFICS.has(w) || !!(vocabulary && (vocabulary.TITLE_WORDS.has(w) || vocabulary.STRONG_TITLE_WORDS.has(w) || vocabulary.EMPLOYER_WORDS.has(w)));
}

function maskRelations(text) {
  return text.replace(RELATION, (all, cue, sep, who) => {
    const words = who.trim().split(/[ \t-]+/);
    const at = words.findIndex(w => !isVocabulary(w));
    if (at < 0) return all;
    return `${cue}${sep}${words.slice(0, at).map(w => `${w} `).join('')}[NAME]${who.slice(who.trimEnd().length)}`;
  });
}

function maskField(s, known, tally) {
  let out = String(s === undefined || s === null ? '' : s).slice(0, FIELD_LIMIT);
  const before = out;
  for (const e of known.emails) out = out.split(e).join('[EMAIL]');
  for (const re of known.nameRes) out = out.replace(re, '[NAME]');
  out = maskRelations(stub.mask(out, {}));
  if (out !== before) tally.changed++;
  return out;
}

function scrubRecord(record, known) {
  const ctx = { ...knownCtx(known), nameRes: nameMatchers(knownCtx(known).names) };
  const tally = { changed: 0 };
  const src = record && typeof record === 'object' ? record : {};
  const roles = (Array.isArray(src.roles) ? src.roles : []).filter(r => r && typeof r === 'object').slice(0, MAX_ROLES_SCANNED).map(r => ({
    title: maskField(r.title, ctx, tally),
    employer: maskField(r.employer, ctx, tally),
    start: typeof r.start === 'string' ? r.start.slice(0, 12) : null,
    end: typeof r.end === 'string' ? r.end.slice(0, 12) : null,
    duties: Array.isArray(r.duties) ? r.duties.filter(d => typeof d === 'string').slice(0, 30).map(d => maskField(d, ctx, tally)) : maskField(r.duties, ctx, tally),
  }));
  const qualifications = (Array.isArray(src.qualifications) ? src.qualifications : []).filter(q => typeof q === 'string').slice(0, 60).map(q => maskField(q, ctx, tally));
  const out = { roles, qualifications, parseConfidence: normalizeParseConfidence(src.parseConfidence) };
  const flat = roles.map(r => [r.title, r.employer, Array.isArray(r.duties) ? r.duties.join(' ') : r.duties].join(' ')).concat(qualifications).join('\n');
  const check = stub.verifyRedaction(flat, { emails: ctx.emails, phones: ctx.phones, postcodes: ctx.postcodes });
  return { record: out, changed: tally.changed, verified: check.ok };
}

module.exports = { redactCv, scrubRecord, knownCtx, isVendored: () => !!vendored };
