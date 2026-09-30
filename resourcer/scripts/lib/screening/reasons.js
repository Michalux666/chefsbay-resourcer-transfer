'use strict';
// Reason codes. The CLI still prints a human sentence (<= 120 chars) as `reason`; the code is what
// the shadow log, the calibration report and (optionally) the database use. No code anywhere may
// depend on the wording of a sentence.

const MAX_REASON = 120;

// code -> [sentence template, when to use it (shown to the LLM and in the owner doc)]
const TABLE = {
  approve_level_match: ['Current role at an appropriate level for <job>', 'the current or most recent role is at a level appropriate for the search'],
  approve_relevant_history: ['Strong relevant background for <job>', 'previous history and a strong background in roles relevant to the search'],
  approve_senior_ok: ['More senior than needed but acceptable for agency shifts', 'more senior than the search but acceptable (over-qualification is not a reason to reject unless the search is entry-level)'],
  approve_other: ['Suitable for <job>', 'any other reason to approve'],
  reject_no_history: ['No visible experience or background information', 'no meaningful professional background or relevant history is visible'],
  reject_foh_only: ['Front-of-house or bar background, no kitchen experience', 'background is front of house, bar or service only, with no kitchen work, for a kitchen search'],
  reject_unrelated_industry: ['Background in an unrelated industry', 'background is in a completely unrelated area with no relevant experience'],
  reject_management_only: ['Management or supervisory background, no hands-on kitchen work', 'management or supervision only, no hands-on kitchen work, for a kitchen search'],
  reject_too_junior: ['Too junior to competently perform <job> duties', 'clearly too junior to competently perform the duties of the search role'],
  reject_stale_profile: ['Profile out of date, no recent experience visible', 'the profile is clearly out of date with no recent experience visible'],
  reject_wrong_specialism: ['Specialism does not fit <job> (e.g. pastry-only, production line)', 'a kitchen specialism that does not fit the search role'],
  reject_overqualified_entry: ['Overqualified for an entry-level role', 'massively overqualified for an entry-level search (rules for entry-level searches only)'],
  reject_other: ['Not suitable for <job>', 'any other reason to reject'],
  sys_fail_open: ['Screening result unusable - approved conservatively', null],
  sys_invalid_result: ['Screening result invalid - rejected conservatively', null],
};

// Codes an engine (LLM or Jev) may return.
const ENGINE_CODES = Object.keys(TABLE).filter(c => !c.startsWith('sys_'));
const ALL_CODES = Object.keys(TABLE);

// Coarse grouping used by the report (the four-way view of the legacy rubric).
const COARSE = {
  approve_level_match: 'approve_level_match',
  approve_relevant_history: 'approve_relevant_history',
  approve_senior_ok: 'approve_senior_ok',
  approve_other: 'approve_other',
  reject_no_history: 'reject_no_history',
  reject_stale_profile: 'reject_no_history',
  reject_foh_only: 'reject_unrelated_background',
  reject_unrelated_industry: 'reject_unrelated_background',
  reject_management_only: 'reject_unrelated_background',
  reject_wrong_specialism: 'reject_unrelated_background',
  reject_too_junior: 'reject_too_junior',
  reject_overqualified_entry: 'reject_overqualified_entry',
  reject_other: 'reject_other',
  sys_fail_open: 'approve_other',
  sys_invalid_result: 'reject_other',
};

function sideOf(code) {
  const c = String(code || '');
  if (c.startsWith('approve_') || c === 'sys_fail_open') return 'approve';
  if (c.startsWith('reject_') || c === 'sys_invalid_result') return 'reject';
  return null;
}

// A code from an engine, made consistent with the decision. Unknown or contradicting -> <side>_other.
function normaliseCode(code, approved) {
  const side = approved ? 'approve' : 'reject';
  const c = String(code || '');
  if (ENGINE_CODES.includes(c) && sideOf(c) === side) return c;
  return `${side}_other`;
}

function clip(s) {
  return String(s).replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);
}

// The sentence for a code, with <job> filled.
function sentenceFor(code, job) {
  const row = TABLE[code] || TABLE.reject_other;
  return clip(row[0].split('<job>').join(String(job || 'the role')));
}

// The `reason` field the CLI prints: the model's own line when it gave one (legacy behaviour),
// else the template for the code, else the legacy Approved/Rejected default.
function reasonText({ text, code, approved, job }) {
  const own = clip(text || '');
  if (own) return own;
  if (code && TABLE[code]) return sentenceFor(code, job);
  return approved ? 'Approved' : 'Rejected';
}

// Block appended to the shared rubric so the LLM can fill reasonCode.
function codeHelpBlock() {
  return ENGINE_CODES.map(c => `${c} - ${TABLE[c][1]}`).join('\n');
}

module.exports = { MAX_REASON, TABLE, ENGINE_CODES, ALL_CODES, COARSE, sideOf, normaliseCode, sentenceFor, reasonText, codeHelpBlock, clip };
