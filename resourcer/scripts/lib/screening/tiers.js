'use strict';
// Role tiers. ROLE_TIERS is the legacy table VERBATIM (legacy scripts/ai-review.js:176-181) because
// the legacy behaviour depends on its quirks: the generic chef word in tier 2 is tested before tier 1,
// so 'Commis Chef' is tier 2, and 'Sous-Chef' (hyphen) is tier 2 not 3. SCREEN_TIER_MODE=fixed
// adds the single documented correction (commis is tier 1). Never "tidy" these regexes.

const ROLE_TIERS = {
  1: /\b(kitchen\s*(assistant|porter)|KP|commis|pot\s*wash|dish\s*wash)\b/i,
  2: /\b(chef\s*de\s*partie|CDP|line\s*cook|cook\b|chef\b|breakfast\s*chef|pastry\s*chef|baker|larder\s*chef|grill\s*chef|sauce\s*chef)\b/i,
  3: /\b(sous\s*chef|second\s*chef|senior\s*(CDP|chef\s*de\s*partie)|junior\s*sous)\b/i,
  4: /\b(head\s*chef|exec(utive)?\s*chef|chef\s*manager|chef\s*patron|chef\s*director|group\s*chef|catering\s*manager)\b/i,
};

const COMMIS_RE = /\bcommis\b/i;

// Search-side tier. Highest tier first so 'Head Chef' is not caught by the generic chef word.
// 0 = unknown / non-kitchen. mode 'legacy' reproduces the legacy function exactly.
function getRoleTier(roleTitle, mode) {
  const t = String(roleTitle || '').trim();
  if (ROLE_TIERS[4].test(t)) return 4;
  if (ROLE_TIERS[3].test(t)) return 3;
  if (mode === 'fixed' && COMMIS_RE.test(t)) return 1;
  if (ROLE_TIERS[2].test(t)) return 2;
  if (ROLE_TIERS[1].test(t)) return 1;
  return 0;
}

// Candidate-side tier of a job title (new code, used by the stage-1 tier rules and by the report).
// Commis is tested before the generic chef word so a Commis Chef candidate is tier 1, and hyphens
// are tolerated. Returns 0 when the title is not on the kitchen ladder.
const CAND_TIERS = {
  4: /\b(head[\s-]*chef|exec(utive)?[\s-]*chef|chef[\s-]*manager|chef[\s-]*patron|chef[\s-]*director|group[\s-]*chef|catering[\s-]*manager|head[\s-]*cook)\b/i,
  3: /\b(sous[\s-]*chef|souschef|second[\s-]*chef|senior[\s-]*(cdp|chef[\s-]*de[\s-]*partie)|junior[\s-]*sous)\b/i,
  1: /\b(kitchen[\s-]*(assistant|porter|hand)|kp|commis|pot[\s-]*wash|dish[\s-]*wash(er)?|dishwasher|apprentice|trainee)\b/i,
  2: /\b(chef[\s-]*de[\s-]*partie|cdp|line[\s-]*cook|cook|chef|breakfast[\s-]*chef|pastry[\s-]*chef|baker|larder[\s-]*chef|grill[\s-]*chef|sauce[\s-]*chef)\b/i,
};

function candidateTier(title) {
  const t = String(title || '').trim();
  if (!t) return 0;
  if (CAND_TIERS[4].test(t)) return 4;
  if (CAND_TIERS[3].test(t)) return 3;
  if (CAND_TIERS[1].test(t)) return 1;
  if (CAND_TIERS[2].test(t)) return 2;
  return 0;
}

const MONTH_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}/;

// The most recent role title in a Caterer card snippet: the text after 'Other CV snippets' up to
// the first 'Mon YYYY' date, trimmed to 80 characters. '' when absent or 'Not available'.
function recentRoleTitle(snippet) {
  const s = String(snippet || '');
  const i = s.search(/Other CV snippets/i);
  if (i < 0) return '';
  let rest = s.slice(i + 'Other CV snippets'.length).trim();
  if (/^Not\s+available/i.test(rest)) return '';
  const m = rest.match(MONTH_RE);
  if (m) rest = rest.slice(0, m.index);
  return rest.trim().slice(0, 80);
}

// The headline of a Caterer card: text before the first ' | ', minus the leading rank ('12. ').
function headlineOf(snippet) {
  const s = String(snippet || '').replace(/^\s*\d+\.\s+/, '');
  const i = s.indexOf(' | ');
  return (i < 0 ? s.slice(0, 120) : s.slice(0, i)).trim();
}

module.exports = { ROLE_TIERS, getRoleTier, candidateTier, recentRoleTitle, headlineOf, MONTH_RE };
