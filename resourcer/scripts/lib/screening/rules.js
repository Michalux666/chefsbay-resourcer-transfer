'use strict';
// Stage 1: deterministic pre-decisions on the REDACTED snippet. Zero network. Only cases the
// research validated, and NEVER a reject for merely missing information:
//   - S1-NA-NONHOSP: the card has no experience block at all AND its headline is not a hospitality
//     title (50 of 50 such cards were rejected by the legacy LLM). Ships in 'shadow' mode: it is
//     evaluated and logged, the deciding engine still decides. Flip to 'enforce' in
//     config/screening.json only after the calibration report shows >= 98% agreement over >= 200 hits.
//   - T-* tier rules (entry-level search vs clearly senior last role; gap of two tiers or more):
//     shadow only.
// Everything else is a FLAG (no_content, no_experience_block, hosp_headline_no_experience,
// reed_no_data, injection). A flag never rejects; it is logged, it can skip the Jev call (no
// content) or force the LLM path (injection).

const { candidateTier, recentRoleTitle, headlineOf } = require('./tiers');

// Front of house and hotel titles count as hospitality too: the rule is about non-hospitality headlines, not about kitchen ones.
const HOSP_RE = /chef|cook|sous|commis|cdp|partie|pastry|kitchen|porter|catering|baker|larder|grill|sauce|kp\b|culinary|butcher|food|waiter|waitress|bar\s*(staff|tender|man|maid)|bartend|barista|hospitality|housekeep|reception|dish|steward|hostess?\b|restaurant|hotel|cafe|coffee|canteen|banquet|server\b|brasserie|pub\b|mixolog|sommelier|front\s*of\s*house|foh\b|events?\s*(staff|team|assistant)/i;
const INJECTION_RE = /ignore (all|any|previous|prior|earlier|the above)|disregard (all|any|the|previous|prior|earlier|above)|system prompt|you are (an|the) (ai|assistant|language model)|as an ai\b|approve (me|this candidate)|new instructions|rate (me|this candidate) (highly|10)|pre-?approved|mark (me|this|it|as) (as )?approved|respond with|reply with|output (approved|json)|always approve|set approved/i;
const ZERO_WIDTH_RE = /[\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/g;
const LOOKALIKE = { '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0445': 'x', '\u0456': 'i', '\u0443': 'y', '\u03bf': 'o', '\u03b1': 'a', '\u03b5': 'e' };

// Cheap evasions (zero-width characters, look-alike letters, "i g n o r e") are undone before the pattern runs; it stays a heuristic.
function foldForInjection(s) {
  let t = String(s || '').normalize('NFKC').replace(ZERO_WIDTH_RE, '');
  t = t.replace(/[\u0430\u0435\u043e\u0440\u0441\u0445\u0456\u0443\u03bf\u03b1\u03b5]/g, ch => LOOKALIKE[ch]);
  t = t.replace(/\b(?:[a-z] ){3,}[a-z]\b/gi, m => m.replace(/ /g, ''));
  return t;
}

function detectSource(snippet) {
  return /(^|\s)(Current role:|Desired role:|Work permit:)|--- CV Work Experience ---/.test(String(snippet || '')) ? 'reed' : 'caterer';
}

// features of a REDACTED snippet
function snippetFeatures(snippet, source) {
  const s = String(snippet || '');
  const src = source || detectSource(s);
  const headline = src === 'caterer' && s.includes(' | ') ? headlineOf(s) : '';
  const hasBlock = /Other CV snippets/i.test(s);
  const naMarker = /Other CV snippets\s+Not\s+available/i.test(s);
  const recentRole = src === 'caterer' ? recentRoleTitle(s) : '';
  const reedRole = /Current role:\s*\S/.test(s);
  const reedCv = /--- CV Work Experience ---\s*\S{20,}/.test(s);
  return {
    source: src,
    length: s.length,
    noContent: s.replace(/\s+/g, '').length < 20,
    hasExperienceBlock: hasBlock && !naMarker,
    naMarker,
    headline,
    hospHeadline: headline ? HOSP_RE.test(headline) : false,
    recentRole,
    recentTier: recentRole ? candidateTier(recentRole) : 0,
    reedNoData: src === 'reed' && !reedRole && !reedCv,
    injection: INJECTION_RE.test(s) || INJECTION_RE.test(foldForInjection(s)),
  };
}

function flagsOf(f) {
  const flags = [];
  if (f.noContent) flags.push('no_content');
  if (f.source === 'caterer' && f.naMarker) flags.push('no_experience_block');
  if (f.source === 'caterer' && f.naMarker && f.hospHeadline) flags.push('hosp_headline_no_experience');
  if (f.reedNoData) flags.push('reed_no_data');
  if (f.injection) flags.push('injection');
  return flags;
}

const RULES = [
  {
    id: 'S1-NA-NONHOSP', decision: 'reject', reasonCode: 'reject_no_history',
    test: f => f.source === 'caterer' && f.naMarker && f.headline.length >= 3 && f.headline.length <= 100 && !f.hospHeadline && !f.noContent,
  },
  {
    id: 'T-ENTRY-OVERQUAL-HEAD', decision: 'reject', reasonCode: 'reject_overqualified_entry',
    test: (f, c) => c.searchTier <= 1 && f.recentTier === 4,
  },
  {
    id: 'T-ENTRY-OVERQUAL-SOUS', decision: 'reject', reasonCode: 'reject_overqualified_entry',
    test: (f, c) => c.searchTier <= 1 && f.recentTier === 3 && /sous|second/i.test(f.recentRole) && !/junior/i.test(f.recentRole),
  },
  {
    id: 'T-UNDER-GAP', decision: 'reject', reasonCode: 'reject_too_junior',
    test: (f, c) => (c.searchTier === 3 || c.searchTier === 4) && f.recentTier === 1,
  },
];

/**
 * @param {object} f features from snippetFeatures
 * @param {{searchTier:number}} ctx
 * @param {{stage1:{rules:Object<string,string>}}} cfg
 * @returns {{hits:Array<{id:string,mode:string,decision:string,reasonCode:string}>, enforced:object|null, flags:string[]}}
 */
function evaluateRules(f, ctx, cfg) {
  const modes = (cfg && cfg.stage1 && cfg.stage1.rules) || {};
  const hits = [];
  let enforced = null;
  for (const r of RULES) {
    const mode = modes[r.id] || 'shadow';
    if (mode === 'off') continue;
    let hit = false;
    try { hit = !!r.test(f, ctx); } catch (e) { hit = false; }
    if (!hit) continue;
    const h = { id: r.id, mode, decision: r.decision, reasonCode: r.reasonCode };
    hits.push(h);
    if (mode === 'enforce' && !enforced) enforced = h;
  }
  return { hits, enforced, flags: flagsOf(f) };
}

module.exports = { HOSP_RE, INJECTION_RE, foldForInjection, RULES, detectSource, snippetFeatures, flagsOf, evaluateRules };
