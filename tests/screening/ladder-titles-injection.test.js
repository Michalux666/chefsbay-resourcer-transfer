'use strict';
// Go-live round of 2026-09-30 (K-SCR12 and the injection bar), carried over to the criteria design: the owner's real non-kitchen
// search titles are decided by Jev like any other title, no title list is needed or read, and Jev's own "does the text instruct
// an AI" answer flags a card only at 0.7 and only together with the keyword filter. Synthetic data only.
const h = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const screening = require(h.lib('screening'));
const config = require(h.lib('screening/config'));
const { decide } = require(h.lib('screening/decide'));
const criteriaLib = require(h.lib('screening/criteria'));
const { getRoleTier } = require(h.lib('screening/tiers'));
const { KINDS, ROLES, choice, A } = require('./criteria-answers');

const SHIPPED = path.join(h.REPO, 'resourcer', 'config', 'screening.json');
const noEnv = () => undefined;
const cfg = config.load({ getEnv: noEnv, file: SHIPPED });
const base = criteriaLib.load({ file: path.join(h.REPO, 'resourcer', 'config', 'screening-criteria.json') }).criteria;
const run = (ans, stage, c) => decide({ answers: ans, searchRole: 'x', stage: stage || 1, criteria: base }, c || cfg);

const OWNER_TITLES = ['Waiter', 'Waitress', 'Server', 'Front Of House', 'Bartender', 'Dish Washer'];
const RETAIL = { kind: 'not_hospitality', sen: 'not_comparable', hosp: 0.03, area: 0.02, fit: 0.05, rel: [0.95, 0.03, 0.01, 0.01] };

let gw;
test.before(async () => { gw = await h.newGateway(); });
test.after(async () => { await gw.close(); });
test.beforeEach(() => { gw.reset(); h.resetHome(); process.env.AI_GATEWAY_API_KEY = 'fake-test-key'; });

// ---------------------------------------------------------------------------------------------- K-SCR12: no title list any more

test('no title list is read or shipped: the ladder and tier0Titles are gone from the file and the defaults, and no library file holds a job-title table', () => {
  const json = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));
  assert.equal(json.decide.ladder, undefined);
  assert.equal(config.DEFAULTS.decide.ladder, undefined);
  assert.equal(cfg.decide.ladder, undefined);
  const titles = /\b(sous|commis|porter|waiter|waitress|barista|bartender|chef de partie|head chef|kitchen assistant)\b/i;
  for (const f of ['decide.js', 'criteria.js', 'jev-client.js', 'jev-questions.js', 'card.js', 'operating-point.js']) {
    const code = fs.readFileSync(path.join(h.SCRIPTS, 'lib', 'screening', f), 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.ok(!titles.test(code), `${f} names a job title in code`);
  }
});

test('the owner search titles are roles of the criteria (service_or_bar, entry), so a front-of-house candidate is comparable and an unrelated one is rejected, for every level of the family', () => {
  for (const role of ['service_or_bar', 'entry', 'other']) {
    const foh = run(A({ role, kind: 'service_or_bar', sen: role === 'service_or_bar' ? 'comparable' : 'not_comparable', area: 0.5, rel: [0.02, 0.3, 0.6, 0.08] }));
    assert.equal(foh.lane, 'approve', `${role}: ${JSON.stringify(foh)}`);
    const retail = run(A({ role, ...RETAIL }));
    assert.deepEqual([retail.lane, retail.reasonCode], ['reject', 'reject_unrelated_industry'], role);
  }
});

test('engine: every owner search title is decided by Jev (approve and reject), never by the review policy, with the shipped configuration', async () => {
  const C = snippet => ({ id: String(Math.random()).slice(2, 8), name: 'Zed', snippet: `1. Zed Smith Cook | Leeds, LS1 4AB Unlock candidate Recent experience Other CV snippets Cook Jan 2020 - Current Test Kitchen ${snippet}` });
  for (const job of OWNER_TITLES) {
    const engine = screening.createEngine(screening.loadConfig({ overrides: { engine: 'jev_only', cache: { ttlSec: 0 } } }), { log: () => {} });
    const r = await engine.screenBatch({ job, location: 'M1', distance: 20 }, [C('[[APPROVE]]'), C('[[REJECT]]')]);
    assert.deepEqual(r.decisions.map(d => d.source), ['jev', 'jev'], job);
    assert.deepEqual(r.decisions.map(d => d.approved), [true, false], job);
    assert.equal(r.stats.policy.share, 0, job);
    assert.equal(getRoleTier(job, 'legacy') >= 0, true, 'the legacy tier still exists for the log and the LLM engines');
  }
});

test('a title the old ladder had no place for (Barista, Kitchen Supervisor, Restaurant Manager, Housekeeper, Dishwasher) is decided by Jev too: the K-SCR12 gap is closed', async () => {
  const C = snippet => ({ id: String(Math.random()).slice(2, 8), name: 'Zed', snippet: `1. Zed Smith Cook | Leeds, LS1 4AB Unlock candidate Recent experience Other CV snippets Cook Jan 2020 - Current Test Kitchen ${snippet}` });
  for (const job of ['Barista', 'Kitchen Supervisor', 'Restaurant Manager', 'Housekeeper', 'Dishwasher']) {
    const engine = screening.createEngine(screening.loadConfig({ overrides: { engine: 'jev_only', cache: { ttlSec: 0 } } }), { log: () => {} });
    const r = await engine.screenBatch({ job, location: 'M1', distance: 20 }, [C('[[APPROVE]]'), C('[[REJECT]]')]);
    assert.deepEqual(r.decisions.map(d => d.source), ['jev', 'jev'], job);
    assert.equal(r.stats.policy.total, 0, job);
    assert.equal(r.decisions[1].approved, false, job);
  }
});

test('the role level is read for every level of the criteria: the tables have a row for each, so no level can fall through to a fallback', () => {
  for (const role of ROLES) {
    for (const kind of KINDS) {
      const d = run(A({ role, kind, sen: 'cannot_tell', fit: 0.5 }));
      assert.ok(['approve', 'reject'].includes(d.lane), `${role} ${kind}: ${JSON.stringify(d)}`);
    }
  }
  assert.deepEqual(Object.keys(base.decision.rules).sort(), ROLES.slice().sort());
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

test('Jev scoring the card button text at 0.5-0.69 is no injection flag even with a keyword hit; 0.7 and above is one only together with the keyword filter (both stages)', () => {
  for (const stage of [1, 2]) {
    for (const v of [0.5, 0.6, 0.69]) {
      const d = run(A({ inject: v, kw: 1 }), stage);
      assert.equal(d.lane, 'approve', `stage ${stage} p=${v}: ${JSON.stringify(d)}`);
      assert.ok(!d.flags.includes('injection'), `stage ${stage} p=${v}`);
    }
    for (const v of [0.7, 0.8, 0.9, 1]) {
      const both = run(A({ inject: v, kw: 1 }), stage);
      assert.equal(both.lane, 'review', `stage ${stage} p=${v}`);
      assert.equal(both.reviewReason, 'INJECTION_FLAG', `stage ${stage} p=${v}`);
      const jevOnly = run(A({ inject: v, kw: 0 }), stage);
      assert.equal(jevOnly.lane, 'approve', `stage ${stage} p=${v}: Jev alone does not stop Jev deciding`);
    }
  }
});

test('the injection threshold is still read from the configuration (0.5 flags a 0.6 answer again, with a keyword hit)', () => {
  const strict = JSON.parse(JSON.stringify(cfg));
  strict.decide.stage1.injectionP = 0.5;
  strict.decide.stage2.injectionP = 0.5;
  for (const stage of [1, 2]) {
    assert.equal(run(A({ inject: 0.6, kw: 1 }), stage, strict).reviewReason, 'INJECTION_FLAG', `stage ${stage}`);
    assert.equal(run(A({ inject: 0.6, kw: 0 }), stage, strict).lane, 'approve', `stage ${stage}: no keyword, no fallback`);
  }
});

test('the criteria file, not a title list, says what each owner title is: the role question is asked once per title and holds the wording', () => {
  const q = base.roleLevel.role_level;
  assert.ok(Object.keys(q.criteria).includes('service_or_bar'));
  assert.match(q.criteria.service_or_bar, /waiter/i);
  assert.match(q.criteria.service_or_bar, /bartender/i);
  assert.match(q.criteria.entry, /dishwasher/i);
  assert.ok(choice(ROLES, 'service_or_bar').p.service_or_bar > 0.9);
});
