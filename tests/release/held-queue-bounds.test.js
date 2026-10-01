'use strict';
// Release hardening: the supervisor's "a held queue is waiting" test (which makes it re-verify a screening halt every minute) uses the same cut-offs
// as the stranded-run recovery: a status file older than 7 days, or one the recovery gave up on, waits for nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('../supervision/_helpers');

const wd = require(path.join(H.SRC_SCRIPTS, 'pipeline-watchdog.js'));
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
const hold = { reason: 'cv-screening-unavailable', at: iso(0) };

function ctxWith(t, files) {
  const home = H.mkHome(t, 'heldbounds');
  const runs = path.join(home, 'runs');
  fs.mkdirSync(runs, { recursive: true });
  for (const [name, obj] of Object.entries(files)) fs.writeFileSync(path.join(runs, name), JSON.stringify(obj));
  return { dirs: { runs } };
}

test('a fresh held run is a waiting held queue; a complete one, one older than 7 days and one the recovery gave up on are not', (t) => {
  const base = { status: 'phase1_abandoned', phase2Hold: hold, startedAt: iso(0), updatedAt: iso(0) };
  assert.equal(wd.hasHeldQueue(ctxWith(t, { 'phase1-a.json': base })), true);
  assert.equal(wd.hasHeldQueue(ctxWith(t, { 'phase1-a.json': { ...base, status: 'complete' } })), false);
  assert.equal(wd.hasHeldQueue(ctxWith(t, { 'phase1-a.json': { ...base, startedAt: iso(8), updatedAt: iso(8) } })), false, 'older than 7 days');
  assert.equal(wd.hasHeldQueue(ctxWith(t, { 'phase1-a.json': { ...base, phase2Recovery: { attempts: 3, gaveUp: true } } })), false, 'given up on');
  assert.equal(wd.hasHeldQueue(ctxWith(t, { 'phase1-old.json': { ...base, startedAt: iso(9) }, 'phase1-new.json': base })), true, 'one waiting file is enough');
});
