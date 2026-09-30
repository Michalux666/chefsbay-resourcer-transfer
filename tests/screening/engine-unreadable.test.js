'use strict';
const h = require('./criteria-helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const config = require(h.lib('screening/config'));

// the guard is about the engine that decides without a language model; the older engines send an unusable answer to the model
const SKIP = config.ENGINES.includes('jev_only') ? false : 'the jev_only engine is not in this tree';

const GOOD = h.card('Chef de Partie', 'Chef de Partie Feb 2022 - Current Grand Central Hotel Running the sauce section. Commis Chef Jan 2019 - Jan 2022 Harbour View');
const drifted = i => `Applicant profile ${i} ${'Cooked and prepared food for a busy restaurant kitchen. '.repeat(8)} Unlock candidate Never unlocked`;

async function screen(snippets) {
  const { createEngine } = require(h.lib('screening/engine'));
  const gw = await h.startGateway({});
  try {
    const cfg = h.loadConfig(gw.origin, { engine: 'jev_only', shadow: { enabled: false }, cache: { ttlSec: 0 } });
    const llm = { chat: async () => { throw new Error('no language model in jev_only'); } };
    const engine = createEngine(cfg, { llm, shadow: { append() {}, enabled: false } });
    return await engine.screenBatch({ job: 'Chef', location: 'Leeds', distance: 20 }, snippets.map((s, i) => ({ id: String(i), name: 'ZZTESTNAME', snippet: s })));
  } finally {
    await gw.close();
  }
}

test('a card the parser cannot read is a fault, never an empty-profile rejection; the other cards are decided by Jev', { skip: SKIP }, async () => {
  const res = await screen([GOOD, drifted(1), GOOD, GOOD, GOOD]);
  assert.equal(res.decisions[1].source, 'system');
  assert.equal(res.decisions[1].reasonCode, 'sys_invalid_result');
  assert.notEqual(res.decisions[1].reasonCode, 'reject_no_history');
  for (const i of [0, 2, 3, 4]) assert.equal(res.decisions[i].source, 'jev');
  assert.equal(res.stats.invalid, 1);
});

test('when every card is unreadable the run stops as systemic instead of rejecting the whole page', { skip: SKIP }, async () => {
  await assert.rejects(() => screen([drifted(1), drifted(2), drifted(3), drifted(4), drifted(5)]), /unusable results for 5 of 5 candidates/);
});
