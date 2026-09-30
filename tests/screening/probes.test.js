'use strict';
const h = require('./criteria-helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { JevClient } = require(h.lib('screening/jev-client'));
const { decide, compactAnswers } = require(h.lib('screening/decide'));
const { parseCard, keywordInjection } = require(h.lib('screening/card'));
const config = require(h.lib('screening/config'));

const PROBES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'criteria-probes.json'), 'utf8'));
const EXPECT = ['approve', 'reject', 'review'];

test('the probe fixture is well formed: unique ids, three expectations, three sets, criteria C1 to C13 all covered', () => {
  assert.ok(PROBES.length >= 200);
  assert.equal(new Set(PROBES.map(p => p.id)).size, PROBES.length);
  const criteria = new Set();
  for (const p of PROBES) {
    assert.ok(EXPECT.includes(p.expect), `${p.id} ${p.expect}`);
    assert.ok(['A', 'B', 'C'].includes(p.set));
    assert.match(p.criterion, /^C\d+$/);
    assert.ok(p.role && p.text && p.note, p.id);
    if (p.stage === 2) assert.ok(p.realTitle, p.id);
    criteria.add(p.criterion);
  }
  for (let i = 1; i <= 13; i++) assert.ok(criteria.has(`C${i}`), `C${i}`);
  assert.ok(PROBES.filter(p => p.set === 'B').length >= 40 && PROBES.filter(p => p.set === 'C').length >= 50, 'the two held-out sets');
});

test('the expectations follow the forced-choice policy: the fallback lane is expected only where the keyword filter fires, and doubt is approve', () => {
  for (const p of PROBES) {
    if (p.expect === 'review') {
      assert.equal(p.criterion, 'C9', p.id);
      assert.ok(keywordInjection(p.text), `${p.id}: a fallback probe needs a keyword hit`);
    }
  }
  const counts = {};
  for (const p of PROBES) counts[p.expect] = (counts[p.expect] || 0) + 1;
  assert.ok(counts.approve >= 60 && counts.reject >= 60, JSON.stringify(counts));
  assert.ok(counts.review <= 12, `the fallback lane is rare even among probes: ${counts.review}`);
});

test('every probe parses into a card Jev can be asked about, and nothing personal is in it', () => {
  for (const p of PROBES) {
    const c = parseCard(p.text, Date.UTC(2026, 8, 30));
    assert.ok(c.currentTitle || c.recentWork || /Not available|^<PC>|Current role:/.test(p.text), p.id);
    assert.ok(!/@|http/.test(p.text), p.id);
  }
});

test('every probe runs through the client and the decision without an error, and only an injection both filters flag reaches the fallback lane', async () => {
  const gw = await h.startGateway({});
  try {
    const cfg = h.loadConfig(gw.origin);
    const dcfg = config.load({ getEnv: () => undefined, file: 'none.json' });
    const client = new JevClient({ cfg });
    let n = 0;
    let fallbacks = 0;
    for (const p of PROBES) {
      const r = await client.evaluate({ searchRole: p.role, searchTier: 2, snippet: p.text, realJobTitle: p.realTitle || '', stage: p.stage || 1 });
      assert.equal(r.ok, true, `${p.id}: ${JSON.stringify(r)}`);
      assert.equal(r.answers.x_injection_kw, keywordInjection(p.text) ? 1 : 0, p.id);
      const d = decide({ answers: compactAnswers(r.answers), searchRole: p.role, searchTier: 2, stage: p.stage || 1 }, dcfg);
      assert.ok(['approve', 'reject', 'review'].includes(d.lane), p.id);
      if (d.lane === 'review') {
        fallbacks++;
        assert.equal(d.reviewReason, 'INJECTION_FLAG', p.id);
        assert.equal(r.answers.x_injection_kw, 1, p.id);
      }
      if (p.criterion === 'C9' && p.expect === 'review') assert.equal(d.lane, 'review', p.id);
      n++;
    }
    assert.equal(n, PROBES.length);
    assert.ok(fallbacks >= 5 && fallbacks <= 12, String(fallbacks));
    assert.ok(gw.state.requests >= n);
  } finally {
    await gw.close();
  }
});
