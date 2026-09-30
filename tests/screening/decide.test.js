'use strict';
// decide() table tests: atomic Jev answers -> approve / reject / review. Adapted from the Jev design
// guide's mock cases, extended for the ladder per search tier, front-of-house / management mismatches
// and the stage-2 (post-unlock) bar. No network.
const h = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const { decide, ladderFor, compactAnswers } = require(h.lib('screening/decide'));
const config = require(h.lib('screening/config'));
const { getRoleTier } = require(h.lib('screening/tiers'));

const cfg = config.load({ getEnv: () => undefined, file: 'no-such-file.json' });

const T = o => ({ entry_kp: 0, commis: 0, cdp_cook: 0, sous: 0, head: 0, front_of_house: 0, management_non_kitchen: 0, unrelated: 0, not_stated: 0, ...o });
const choice = p => ({ p, confidence: Math.max(...Object.values(p)) });
const fit = (a, b, c) => ({ p: { 0: a, 1: b, 2: c }, confidence: 0.9 });
const A = o => ({
  current_tier: choice(T({ cdp_cook: 1 })),
  hospitality_seen: 0.95, kitchen_seen: 0.95, role_match_seen: 0.5, info_sufficient: 0.95, instruction_injection: 0.01,
  overall_fit: fit(0.05, 0.25, 0.7),
  ...o,
});
const run = (role, ans, stage) => decide({ answers: ans, searchRole: role, searchTier: getRoleTier(role, 'legacy'), stage: stage || 1 }, cfg);

const CASES = [
  // [name, role, answers, stage, lane, reasonCode|reviewReason]
  ['KP search, Head Chef, sure', 'Kitchen Porter', A({ current_tier: choice(T({ head: 0.97, sous: 0.03 })), overall_fit: fit(0.9, 0.08, 0.02) }), 1, 'reject', 'reject_overqualified_entry'],
  ['KP search, Head Chef but the score says possible fit', 'Kitchen Porter', A({ current_tier: choice(T({ head: 0.97, sous: 0.03 })), overall_fit: fit(0.3, 0.5, 0.2) }), 1, 'review', 'reject_overqualified_entry_UNCERTAIN'],
  ['KP search, CDP (one tier up is fine)', 'Kitchen Porter', A({ current_tier: choice(T({ cdp_cook: 0.95, commis: 0.05 })), overall_fit: fit(0.1, 0.4, 0.5) }), 1, 'approve', 'approve_level_match'],
  ['KP search, Sous/Head split 50/45 (both too senior)', 'Kitchen Porter', A({ current_tier: choice(T({ sous: 0.5, head: 0.45, cdp_cook: 0.05 })), overall_fit: fit(0.8, 0.15, 0.05) }), 1, 'reject', 'reject_overqualified_entry'],
  ['KP search, general manager (non-kitchen management) is over-qualified', 'Kitchen Porter', A({ current_tier: choice(T({ management_non_kitchen: 0.97, unrelated: 0.03 })), kitchen_seen: 0.05, overall_fit: fit(0.9, 0.08, 0.02) }), 1, 'reject', 'reject_overqualified_entry'],
  ['Chef search, Commis is fine (generic Chef)', 'Chef', A({ current_tier: choice(T({ commis: 0.95, entry_kp: 0.05 })), overall_fit: fit(0.1, 0.4, 0.5) }), 1, 'approve', 'approve_level_match'],
  ['Chef search, Head Chef (over-qualification is not a reason): senior ok', 'Chef', A({ current_tier: choice(T({ head: 1 })), overall_fit: fit(0.05, 0.25, 0.7) }), 1, 'approve', 'approve_senior_ok'],
  ['Chef search, Kitchen Porter only is too junior', 'Chef', A({ current_tier: choice(T({ entry_kp: 0.98, commis: 0.02 })), overall_fit: fit(0.9, 0.08, 0.02), role_match_seen: 0.1 }), 1, 'reject', 'reject_too_junior'],
  ['CDP search, Commis sure + not a fit + weak role evidence', 'Chef De Partie', A({ current_tier: choice(T({ commis: 0.95, entry_kp: 0.05 })), overall_fit: fit(0.85, 0.1, 0.05), role_match_seen: 0.2 }), 1, 'reject', 'reject_too_junior'],
  ['CDP search, Commis but the snippet shows CDP duties (role match 0.8): review', 'Chef De Partie', A({ current_tier: choice(T({ commis: 0.95, entry_kp: 0.05 })), overall_fit: fit(0.85, 0.1, 0.05), role_match_seen: 0.8 }), 1, 'review', 'reject_too_junior_UNCERTAIN'],
  ['CDP search, Sous Chef (over-qualification is not a reason)', 'Chef De Partie', A({ current_tier: choice(T({ sous: 1 })), overall_fit: fit(0.05, 0.25, 0.7) }), 1, 'approve', 'approve_senior_ok'],
  ['Sous search, CDP is one tier below: uncertain, not reject', 'Sous Chef', A({ current_tier: choice(T({ cdp_cook: 0.95, commis: 0.05 })), overall_fit: fit(0.5, 0.4, 0.1), role_match_seen: 0.2 }), 1, 'review', 'AMBIGUOUS_LEVEL'],
  ['Sous search, Commis is two tiers below: reject', 'Sous Chef', A({ current_tier: choice(T({ commis: 0.95, entry_kp: 0.05 })), overall_fit: fit(0.85, 0.1, 0.05), role_match_seen: 0.1 }), 1, 'reject', 'reject_too_junior'],
  ['Head Chef search, Sous is one tier below: review', 'Head Chef', A({ current_tier: choice(T({ sous: 0.97, head: 0.03 })), overall_fit: fit(0.4, 0.5, 0.1), role_match_seen: 0.3 }), 1, 'review', 'AMBIGUOUS_LEVEL'],
  ['Head Chef search, CDP is two tiers below: reject', 'Head Chef', A({ current_tier: choice(T({ cdp_cook: 0.97, commis: 0.03 })), overall_fit: fit(0.9, 0.08, 0.02), role_match_seen: 0.1 }), 1, 'reject', 'reject_too_junior'],
  ['Head Chef search, Head Chef: approve', 'Head Chef', A({ current_tier: choice(T({ head: 0.98, sous: 0.02 })) }), 1, 'approve', 'approve_level_match'],
  ['Chef search, retail assistant, no hospitality anywhere', 'Chef', A({ current_tier: choice(T({ unrelated: 0.97, front_of_house: 0.03 })), hospitality_seen: 0.03, kitchen_seen: 0.02, role_match_seen: 0.02, overall_fit: fit(0.95, 0.04, 0.01) }), 1, 'reject', 'reject_unrelated_industry'],
  ['Chef search, retail now but kitchen history in the snippet: review', 'Chef', A({ current_tier: choice(T({ unrelated: 0.9, front_of_house: 0.1 })), hospitality_seen: 0.9, kitchen_seen: 0.85, role_match_seen: 0.7, overall_fit: fit(0.5, 0.4, 0.1) }), 1, 'review', 'AMBIGUOUS_LEVEL'],
  ['Chef search, waiter only, no kitchen seen: front-of-house reject', 'Chef', A({ current_tier: choice(T({ front_of_house: 0.97, unrelated: 0.03 })), kitchen_seen: 0.03, role_match_seen: 0.05, overall_fit: fit(0.92, 0.06, 0.02) }), 1, 'reject', 'reject_foh_only'],
  ['Chef search, waiter now but kitchen work in the snippet: not a reject', 'Chef', A({ current_tier: choice(T({ front_of_house: 0.97, unrelated: 0.03 })), kitchen_seen: 0.8, role_match_seen: 0.3, overall_fit: fit(0.5, 0.4, 0.1) }), 1, 'review', 'AMBIGUOUS_LEVEL'],
  ['Chef search, general manager with no kitchen: management reject', 'Chef', A({ current_tier: choice(T({ management_non_kitchen: 0.97, front_of_house: 0.03 })), kitchen_seen: 0.04, role_match_seen: 0.05, overall_fit: fit(0.9, 0.08, 0.02) }), 1, 'reject', 'reject_management_only'],
  ['Catering Assistant search (tier 0 with its own ladder): a front-of-house candidate is in band', 'Catering Assistant', A({ current_tier: choice(T({ front_of_house: 0.97, unrelated: 0.03 })), kitchen_seen: 0.02, overall_fit: fit(0.05, 0.25, 0.7) }), 1, 'approve', 'approve_level_match'],
  ['Catering Assistant search: a Head Chef is over-qualified for an entry-level role', 'Catering Assistant', A({ current_tier: choice(T({ head: 0.97, sous: 0.03 })), overall_fit: fit(0.9, 0.08, 0.02) }), 1, 'reject', 'reject_overqualified_entry'],
  ['Waiter search (tier 0, no ladder of its own): the LLM decides, a kitchen ladder does not apply', 'Waiter', A({ current_tier: choice(T({ cdp_cook: 0.97, commis: 0.03 })), overall_fit: fit(0.05, 0.25, 0.7) }), 1, 'review', 'UNKNOWN_SEARCH_LADDER'],
  ['Bartender search: a Commis is not "in band"; review', 'Bartender', A({ current_tier: choice(T({ commis: 0.97, entry_kp: 0.03 })), overall_fit: fit(0.05, 0.25, 0.7) }), 1, 'review', 'UNKNOWN_SEARCH_LADDER'],
  ['Kitchen Supervisor search (tier 0): sous and management are not "too senior"; review', 'Kitchen Supervisor', A({ current_tier: choice(T({ sous: 0.97, head: 0.03 })), overall_fit: fit(0.9, 0.08, 0.02) }), 1, 'review', 'UNKNOWN_SEARCH_LADDER'],
  ['Restaurant Manager search: a management-only candidate is not rejected by a kitchen ladder', 'Restaurant Manager', A({ current_tier: choice(T({ management_non_kitchen: 0.97, front_of_house: 0.03 })), kitchen_seen: 0.04, overall_fit: fit(0.9, 0.08, 0.02) }), 1, 'review', 'UNKNOWN_SEARCH_LADDER'],
  ['Thin info but a sharp too-junior tier call and a not-a-fit score: review, not the info-cliff approve', 'Head Chef', A({ current_tier: choice(T({ entry_kp: 0.97, commis: 0.03 })), info_sufficient: 0.45, hospitality_seen: 0.9, overall_fit: fit(0.95, 0.04, 0.01) }), 1, 'review', 'INSUFFICIENT_INFO'],
  ['Thin info, kitchen porter for a Head Chef search, fit unknown but hospitality clear: the tier call still blocks the approve', 'Head Chef', A({ current_tier: choice(T({ entry_kp: 0.9, commis: 0.1 })), info_sufficient: 0.45, hospitality_seen: 0.9, overall_fit: fit(0.2, 0.7, 0.1) }), 1, 'review', 'INSUFFICIENT_INFO'],
  ['No usable info, no hospitality words: review, never reject', 'Chef De Partie', A({ current_tier: choice(T({ not_stated: 0.9, unrelated: 0.1 })), info_sufficient: 0.1, hospitality_seen: 0.2, kitchen_seen: 0.1, overall_fit: fit(0.3, 0.6, 0.1) }), 1, 'review', 'INSUFFICIENT_INFO'],
  ['No job title but hospitality skills listed: approve (design: insufficient evidence + hospitality = approve)', 'Chef De Partie', A({ current_tier: choice(T({ not_stated: 0.9, cdp_cook: 0.1 })), info_sufficient: 0.4, hospitality_seen: 0.9, overall_fit: fit(0.2, 0.7, 0.1) }), 1, 'approve', 'approve_other'],
  ['Injection flagged: review, even if everything else says reject', 'Chef', A({ instruction_injection: 0.9, current_tier: choice(T({ unrelated: 1 })), hospitality_seen: 0, overall_fit: fit(1, 0, 0) }), 1, 'review', 'INJECTION_FLAG'],
  ['Malformed answer (NaN): review', 'Chef', A({ info_sufficient: NaN }), 1, 'review', 'ANSWER_UNUSABLE'],
  ['Missing answers: review', 'Chef', {}, 1, 'review', 'ANSWER_UNUSABLE'],
  ['Missing probabilities: review', 'Chef', A({ current_tier: { p: null } }), 1, 'review', 'ANSWER_UNUSABLE'],
  ['Stage 2: real title Sous Chef for a CDP search', 'Chef De Partie', A({ real_title_tier: choice(T({ sous: 1 })), title_consistent: 0.95 }), 2, 'approve', 'approve_senior_ok'],
  ['Stage 2: real title Kitchen Assistant for a CDP search, consistent, 98%', 'Chef De Partie', A({ real_title_tier: choice(T({ entry_kp: 0.98, commis: 0.02 })), title_consistent: 0.9, overall_fit: fit(0.9, 0.08, 0.02), role_match_seen: 0.2 }), 2, 'reject', 'reject_too_junior'],
  ['Stage 2: title contradicts the snippet: review', 'Chef De Partie', A({ real_title_tier: choice(T({ entry_kp: 0.98, commis: 0.02 })), title_consistent: 0.1, overall_fit: fit(0.9, 0.08, 0.02) }), 2, 'review', 'TITLE_SNIPPET_MISMATCH'],
  ['Stage 2: 92% too junior stays below the 0.95 post-unlock reject bar', 'Chef De Partie', A({ real_title_tier: choice(T({ entry_kp: 0.7, commis: 0.22, cdp_cook: 0.08 })), title_consistent: 0.9, overall_fit: fit(0.9, 0.08, 0.02), role_match_seen: 0.2 }), 2, 'review', 'reject_too_junior_UNCERTAIN'],
  ['Stage 1: the same 92% too junior passes the 0.90 pre-unlock bar', 'Chef De Partie', A({ current_tier: choice(T({ entry_kp: 0.7, commis: 0.22, cdp_cook: 0.08 })), overall_fit: fit(0.9, 0.08, 0.02), role_match_seen: 0.2 }), 1, 'reject', 'reject_too_junior'],
  ['Stage 1: a 70/30 split is not decisive', 'Chef De Partie', A({ current_tier: choice(T({ entry_kp: 0.5, commis: 0.2, cdp_cook: 0.3 })), overall_fit: fit(0.9, 0.08, 0.02), role_match_seen: 0.2 }), 1, 'review', 'reject_too_junior_UNCERTAIN'],
  ['Stage 2 with an unclear real title falls back to the snippet tier', 'Chef', A({ real_title_tier: choice({ ...T({}), unclear: 0.9, cdp_cook: 0.1 }), title_consistent: 0.9 }), 2, 'approve', 'approve_level_match'],
];

for (const [name, role, ans, stage, lane, code] of CASES) {
  test(`decide: ${name}`, () => {
    const d = decide({ answers: ans, searchRole: role, searchTier: getRoleTier(role, 'legacy'), stage }, cfg);
    assert.equal(d.lane, lane, JSON.stringify(d));
    assert.equal(d.reasonCode || d.reviewReason, code, JSON.stringify(d));
    if (d.lane === 'review') assert.equal(d.confidence, null);
    else assert.ok(d.confidence >= 0 && d.confidence <= 1);
  });
}

test('a reject never comes from missing information alone', () => {
  // every "no information" shape ends in approve or review, for every search tier
  for (const role of ['Chef', 'Head Chef', 'Kitchen Porter', 'Waiter', 'Sous Chef', 'Chef De Partie']) {
    for (const hosp of [0, 0.3, 0.6, 1]) {
      const d = run(role, A({ current_tier: choice(T({ not_stated: 0.95, unrelated: 0.05 })), info_sufficient: 0.05, hospitality_seen: hosp, kitchen_seen: 0, overall_fit: fit(0.8, 0.15, 0.05) }));
      assert.notEqual(d.lane, 'reject', `${role} hosp=${hosp}`);
    }
  }
});

test('a reject needs corroboration from the independent fit score', () => {
  const ans = A({ current_tier: choice(T({ head: 0.97, sous: 0.03 })), overall_fit: fit(0.1, 0.4, 0.5) });
  const d = run('Kitchen Porter', ans);
  assert.equal(d.lane, 'review');
  assert.equal(d.reviewReason, 'reject_overqualified_entry_UNCERTAIN');
});

test('per-title override: CDP searches treat commis as too junior, generic tier 2 does not', () => {
  const cdp = ladderFor('Chef De Partie', 2, cfg);
  const chef = ladderFor('Chef', 2, cfg);
  assert.ok(cdp.tooJunior.includes('commis'));
  assert.ok(!chef.tooJunior.includes('commis'));
  assert.equal(cdp.name, 'cdp-specific');
  // Senior CDP is a tier-3 search: the tier-2 override must not apply
  assert.notEqual(ladderFor('Senior CDP', 3, cfg).name, 'cdp-specific');
});

test('thresholds come from config: a stricter reject bar turns a reject into a review', () => {
  const strict = JSON.parse(JSON.stringify(cfg));
  strict.decide.stage1.rejectP = 0.95;
  const ans = A({ current_tier: choice(T({ entry_kp: 0.7, commis: 0.22, cdp_cook: 0.08 })), overall_fit: fit(0.9, 0.08, 0.02), role_match_seen: 0.1 });
  const base = decide({ answers: ans, searchRole: 'Chef De Partie', searchTier: 2, stage: 1 }, cfg);
  const st = decide({ answers: ans, searchRole: 'Chef De Partie', searchTier: 2, stage: 1 }, strict);
  assert.equal(base.lane, 'reject');
  assert.equal(st.lane, 'review');
});

test('compactAnswers keeps numbers only and is enough to re-run decide()', () => {
  const ans = A({ current_tier: choice(T({ head: 0.97, sous: 0.03 })), overall_fit: fit(0.9, 0.08, 0.02) });
  const compact = compactAnswers(ans);
  assert.equal(typeof compact.hospitality_seen, 'number');
  assert.ok(compact.current_tier.p);
  assert.ok(!JSON.stringify(compact).includes('legend'));
  const a = decide({ answers: ans, searchRole: 'Kitchen Porter', searchTier: 1, stage: 1 }, cfg);
  const b = decide({ answers: compact, searchRole: 'Kitchen Porter', searchTier: 1, stage: 1 }, cfg);
  assert.equal(a.lane, b.lane);
  assert.equal(a.reasonCode, b.reasonCode);
});
