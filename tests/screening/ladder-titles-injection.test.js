'use strict';
// 2026-09-30 go-live round: (K-SCR12) the owner's real non-kitchen search titles are on the tier-0 ladder, and
// Jev's own "does the text instruct an AI" question flags at 0.7 (the card's button text scored 0.5-0.7). Synthetic data only.
const h = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const screening = require(h.lib('screening'));
const config = require(h.lib('screening/config'));
const { decide, ladderFor } = require(h.lib('screening/decide'));
const { getRoleTier } = require(h.lib('screening/tiers'));

const SHIPPED = path.join(h.REPO, 'resourcer', 'config', 'screening.json');
const noEnv = () => undefined;
const cfg = config.load({ getEnv: noEnv, file: SHIPPED });

const T = o => ({ entry_kp: 0, commis: 0, cdp_cook: 0, sous: 0, head: 0, front_of_house: 0, management_non_kitchen: 0, unrelated: 0, not_stated: 0, ...o });
const choice = p => ({ p, confidence: Math.max(...Object.values(p)) });
const fit = (a, b, c) => ({ p: { 0: a, 1: b, 2: c }, confidence: 0.9 });
const A = o => ({
  current_tier: choice(T({ cdp_cook: 1 })),
  hospitality_seen: 0.95, kitchen_seen: 0.95, role_match_seen: 0.5, info_sufficient: 0.95, instruction_injection: 0.01,
  overall_fit: fit(0.05, 0.25, 0.7),
  ...o,
});
const FOH = A({ current_tier: choice(T({ front_of_house: 0.97, unrelated: 0.03 })), kitchen_seen: 0.02 });
const run = (role, ans, stage, c) => decide({ answers: ans, searchRole: role, searchTier: getRoleTier(role, 'legacy'), stage: stage || 1 }, c || cfg);

const OWNER_TITLES = ['Waiter', 'Waitress', 'Server', 'Front Of House', 'Bartender', 'Dish Washer'];

let gw;
test.before(async () => { gw = await h.newGateway(); });
test.after(async () => { await gw.close(); });
test.beforeEach(() => { gw.reset(); h.resetHome(); process.env.AI_GATEWAY_API_KEY = 'fake-test-key'; });

// ---------------------------------------------------------------------------------------------- K-SCR12

test('the shipped tier0Titles hold the owner titles, lower-case, and equal the built-in defaults', () => {
  const json = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));
  const titles = json.decide.ladder.tier0Titles;
  for (const t of ['catering assistant', 'kitchen hand', 'food production', 'waiter', 'waitress', 'server', 'front of house', 'bartender', 'dish washer']) assert.ok(titles.includes(t), t);
  for (const t of titles) assert.equal(t, t.toLowerCase());
  assert.deepEqual(config.DEFAULTS.decide.ladder.tier0Titles, titles);
  assert.deepEqual(cfg.decide.ladder.tier0Titles, titles);
});

test('every owner search title is search tier 0 and is served by the tier-0 ladder, not the no-ladder review lane', () => {
  for (const title of OWNER_TITLES) {
    assert.equal(getRoleTier(title, 'legacy'), 0, title);
    assert.equal(ladderFor(title, 0, cfg), cfg.decide.ladder.bySearchTier['0'], title);
    const d = run(title, FOH);
    assert.equal(d.lane, 'approve', `${title}: ${JSON.stringify(d)}`);
    assert.equal(d.reasonCode, 'approve_level_match', title);
  }
});

test('the title match is on whole words, in any case, inside a longer title', () => {
  for (const title of ['WAITER', 'waitress', 'Head Waiter', 'Bartender - weekends', 'Front of House Team', 'dish  washer', 'Server (evenings)']) {
    const d = run(title, FOH);
    assert.equal(d.lane, 'approve', `${title}: ${JSON.stringify(d)}`);
  }
  for (const title of ['Observer', 'Waiterage']) assert.equal(run(title, FOH).reviewReason, 'UNKNOWN_SEARCH_LADDER', title);
});

test('a title that is still not on any ladder keeps the review lane (UNKNOWN_SEARCH_LADDER)', () => {
  for (const title of ['Barista', 'Kitchen Supervisor', 'Restaurant Manager', 'Housekeeper']) {
    const d = run(title, FOH);
    assert.equal(d.lane, 'review', title);
    assert.equal(d.reviewReason, 'UNKNOWN_SEARCH_LADDER', title);
  }
});

test('on the tier-0 ladder a clearly over-senior candidate is still rejected and an unrelated one is still rejected', () => {
  const head = A({ current_tier: choice(T({ head: 0.97, sous: 0.03 })), overall_fit: fit(0.9, 0.08, 0.02) });
  const retail = A({ current_tier: choice(T({ unrelated: 0.97, front_of_house: 0.03 })), hospitality_seen: 0.03, kitchen_seen: 0.02, role_match_seen: 0.02, overall_fit: fit(0.95, 0.04, 0.01) });
  for (const title of OWNER_TITLES) {
    assert.equal(run(title, head).reasonCode, 'reject_overqualified_entry', title);
    assert.equal(run(title, retail).reasonCode, 'reject_unrelated_industry', title);
  }
});

test('engine: a Waiter search is decided by Jev (approve and reject), not by the review policy, with the shipped configuration', async () => {
  const C = snippet => ({ id: String(Math.random()).slice(2, 8), name: 'Zed', snippet: `1. Zed Smith Cook | Leeds, LS1 4AB Unlock candidate Recent experience Other CV snippets Cook Jan 2020 - Current Test Kitchen ${snippet}` });
  for (const job of OWNER_TITLES) {
    const engine = screening.createEngine(screening.loadConfig({ overrides: { engine: 'jev_only', cache: { ttlSec: 0 } } }), { log: () => {} });
    const r = await engine.screenBatch({ job, location: 'M1', distance: 20 }, [C('[[APPROVE]]'), C('[[REJECT]]')]);
    assert.deepEqual(r.decisions.map(d => d.source), ['jev', 'jev'], job);
    assert.deepEqual(r.decisions.map(d => d.approved), [true, false], job);
    assert.equal(r.stats.policy.share, 0, job);
  }
});

// ---------------------------------------------------------------------------------------------- injectionP

test('injectionP is 0.7 for both stages in the shipped file and in the built-in defaults', () => {
  const json = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));
  assert.equal(json.decide.stage1.injectionP, 0.7);
  assert.equal(json.decide.stage2.injectionP, 0.7);
  assert.equal(config.DEFAULTS.decide.stage1.injectionP, 0.7);
  assert.equal(config.DEFAULTS.decide.stage2.injectionP, 0.7);
  const bad = config.load({ getEnv: noEnv, file: h.writeConfig({ decide: { stage1: { injectionP: 2 }, stage2: { injectionP: 'x' } } }) });
  assert.equal(bad.decide.stage1.injectionP, 0.7, 'an unusable value falls back to the default');
  assert.equal(bad.decide.stage2.injectionP, 0.7);
});

test('Jev scoring the card button text at 0.5-0.69 is no longer an injection flag; 0.7 and above still is (both stages)', () => {
  for (const stage of [1, 2]) {
    for (const v of [0.5, 0.6, 0.69]) {
      const d = run('Chef', A({ instruction_injection: v }), stage);
      assert.equal(d.lane, 'approve', `stage ${stage} p=${v}: ${JSON.stringify(d)}`);
      assert.ok(!d.flags.includes('injection'), `stage ${stage} p=${v}`);
    }
    for (const v of [0.7, 0.8, 0.9, 1]) {
      const d = run('Chef', A({ instruction_injection: v }), stage);
      assert.equal(d.lane, 'review', `stage ${stage} p=${v}`);
      assert.equal(d.reviewReason, 'INJECTION_FLAG', `stage ${stage} p=${v}`);
    }
  }
});

test('the injection threshold is still read from the configuration (0.5 flags a 0.6 answer again)', () => {
  const strict = JSON.parse(JSON.stringify(cfg));
  strict.decide.stage1.injectionP = 0.5;
  strict.decide.stage2.injectionP = 0.5;
  for (const stage of [1, 2]) assert.equal(run('Chef', A({ instruction_injection: 0.6 }), stage, strict).reviewReason, 'INJECTION_FLAG', `stage ${stage}`);
});
