'use strict';
// Update C, finding F1 (Phase 1 side): while the CV stage holds the pipeline (CV_SCREEN on and the screening halt up) no candidate may be unlocked: each one
// would be held in Phase 2 and never pushed, and its credit would be spent for nothing. The supervisor starts no run while the halt is up; this is the same rule
// inside a run (one that started before the halt was raised, or one started by hand). The whole-pipeline proof is tests/e2e/15-cv-halt.e2e.js.
const os = require('os');
const fs = require('fs');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-cvhold-'));
process.env.RESOURCER_HOME = path.join(root, 'resourcer');
fs.mkdirSync(process.env.RESOURCER_HOME, { recursive: true });
process.env.RESOURCER_ENV_FILE = path.join(root, 'none.env');
const test = require('node:test');
const assert = require('node:assert');

const SRC = path.resolve(__dirname, '..', '..', 'resourcer', 'scripts');
const { blocked, stopIfBlocked } = require(path.join(SRC, 'phase1', 'cv-hold'));
const { unlockPass } = require(path.join(SRC, 'phase1', 'unlock'));
const cvStage = require(path.join(SRC, 'lib', 'cv', 'phase2'));
const halt = require(path.join(SRC, 'lib', 'pipeline-halt'));

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* best effort */ } });

const mkCtx = over => {
  const lines = [];
  return { lines, out: l => lines.push(String(l)), st: { stop: false, screeningIncomplete: false, approved: [], dbBroken: false, page: 1 }, p: {}, cfg: { timeoutMs: {} }, ...(over || {}) };
};

test('stopIfBlocked ends the run early, keeps the territory and says why; when nothing holds the pipeline it does nothing', () => {
  const held = mkCtx({ cvHold: () => true });
  assert.strictEqual(stopIfBlocked(held, 'before an unlock'), true);
  assert.strictEqual(held.st.stop, true);
  assert.strictEqual(held.st.screeningIncomplete, 'screening-unavailable', 'not bounded: a hold of this kind never gives the territory up');
  assert.match(held.lines.join('\n'), /STOPPING Phase 1 \(before an unlock\): the CV screening stage holds the pipeline .*nothing more is unlocked; the territory and its pending search are kept/);
  const free = mkCtx({ cvHold: () => false });
  assert.strictEqual(stopIfBlocked(free, 'x'), false);
  assert.deepStrictEqual([free.st.stop, free.st.screeningIncomplete, free.lines], [false, false, []]);
  assert.strictEqual(blocked(mkCtx({ cvHold: () => { throw new Error('boom'); } })), false, 'fails open: a broken check never stops a run');
});

test('unlockPass spends no credit once the stage holds the pipeline: the first card is not unlocked, the loop ends and the run is stopped', async () => {
  const ctx = mkCtx({ cvHold: () => true });
  await unlockPass(ctx, [{ id: 1, candidateDataValue: 'a' }, { id: 2, candidateDataValue: 'b' }]);
  assert.strictEqual(ctx.st.stop, true);
  assert.strictEqual(ctx.st.approved.length, 0);
  assert.strictEqual(ctx.lines.filter(l => /STOPPING Phase 1 \(before an unlock\)/.test(l)).length, 1, 'said once, not per card');
});

test('the real check reads CV_SCREEN and the halt file: on and halted blocks; shadow, off, unset or no halt never', () => {
  const saved = process.env.CV_SCREEN;
  try {
    halt.clearHalt();
    process.env.CV_SCREEN = 'on';
    assert.strictEqual(blocked(mkCtx()), false, 'no halt');
    halt.setHalt('screening gateway error', 'test', { blockedRun: true });
    assert.strictEqual(blocked(mkCtx()), true, 'on and halted');
    for (const v of [undefined, 'shadow', 'off']) {
      if (v === undefined) delete process.env.CV_SCREEN; else process.env.CV_SCREEN = v;
      assert.strictEqual(blocked(mkCtx()), false, `CV_SCREEN=${v}`);
    }
    assert.strictEqual(cvStage.unlockBlocked(), false);
  } finally {
    if (saved === undefined) delete process.env.CV_SCREEN; else process.env.CV_SCREEN = saved;
    halt.clearHalt();
  }
});

test('pageLoop checks the hold before it fetches the first page: a run started while the stage holds the pipeline ends before any page is read', async () => {
  const { pageLoop } = require(path.join(SRC, 'phase1', 'run'));
  const ctx = mkCtx({ cvHold: () => true });
  // a page fetch would fail loudly: any attempt to reach the browser layer throws through the ctx helpers
  await pageLoop(ctx);
  assert.strictEqual(ctx.st.stop, true);
  assert.strictEqual(ctx.st.screeningIncomplete, 'screening-unavailable');
  assert.strictEqual(ctx.lines.filter(l => /--- Page /.test(l)).length, 0, 'no page was started');
  assert.match(ctx.lines.join('\n'), /STOPPING Phase 1 \(before page 1\)/);
});
