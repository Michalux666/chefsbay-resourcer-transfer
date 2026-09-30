'use strict';
// Streaming proof: a 60 MB file goes through pack, authenticate and extract with bounded memory.
// Node's garbage collector lets a few tens of MB of Buffer garbage build up, so the proof is that peak
// memory does not scale with the file: a 180 MB run must peak at (almost) the same level as a 60 MB run.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./_helpers');

function runChild(dir, megabytes) {
  const r = spawnSync(process.execPath, ['--expose-gc', path.join(__dirname, 'stream-child.js'), dir, String(megabytes)], { encoding: 'utf8', timeout: 240000, windowsHide: true });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('60 MB synthetic file streams through the bundle with bounded memory', (t) => {
  const dir = H.mkTmp('stream-');
  t.after(() => H.rmTmp(dir));
  const small = runChild(dir, 60);
  assert.equal(small.identical, true, 'extracted bytes must equal the source');
  assert.equal(small.sizeMatches, true);
  assert.ok(small.chunks >= 60, `expected at least 60 chunks, got ${small.chunks}`);
  assert.equal(small.chunks, small.scannedChunks);
  assert.ok(small.growthMb < 55, `peak RSS grew by ${small.growthMb} MB (baseline ${small.baselineMb} MB, after ${small.afterMb} MB)`);

  const big = runChild(dir, 180);
  assert.equal(big.identical, true);
  assert.ok(big.chunks >= 180);
  assert.ok(big.growthMb - small.growthMb < 20, `memory scales with file size: 60 MB grew ${small.growthMb} MB, 180 MB grew ${big.growthMb} MB`);
});
