'use strict';
// Update C, finding F11: SearchLevels.put wrote its whole in-memory map without looking at the file again, so the reviewer processes of one Phase 2
// (up to four at once) erased each other's titles and asked Jev for the same level again (16 requests for 5 titles in the rehearsal). The file is now
// read again under a short lock, merged and then written atomically.
const { makeHome } = require('./helpers/home');
const home = makeHome('cv-cache-conc');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cache = require('../../resourcer/scripts/lib/cv/cache');

test.after(() => home.cleanup());
test.beforeEach(() => home.reset());

const CACHE_JS = path.resolve(__dirname, '..', '..', 'resourcer', 'scripts', 'lib', 'cv', 'cache.js');
const entry = n => ({ p: { mid: 0.9, unclear: 0.1 }, model: `m${n}` });
const open = (file, extra) => new cache.SearchLevels({ file, qhash: 'h', ...(extra || {}) });

test('two stores that loaded the same (empty) file keep each other\'s titles: the second put merges instead of overwriting', () => {
  const file = path.join(home.state, 'levels-merge.json');
  const a = open(file);
  const b = open(file);
  a.load();
  b.load(); // both saw an empty file
  a.put('Title A', entry(1));
  b.put('Title B', entry(2));
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(onDisk.entries).sort(), ['title a', 'title b']);
  // and each store sees the other's title at once after its own put
  assert.ok(b.get('Title A'), 'b learned about a\'s title from the merge');
  assert.equal(open(file).get('title b').model, 'm2');
  assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock file is removed');
});

test('the title just asked wins for its own key, other processes\' titles win for theirs, and a file for another question wording starts afresh', () => {
  const file = path.join(home.state, 'levels-own.json');
  const a = open(file);
  a.load();
  fs.writeFileSync(file, JSON.stringify({ v: 1, qhash: 'h', entries: { 'chef': { ...entry(9), at: new Date().toISOString() }, 'cook': { ...entry(8), at: new Date().toISOString() } } }));
  a.put('Chef', entry(1)); // asked again by this process: its answer replaces the old one
  const d = JSON.parse(fs.readFileSync(file, 'utf8')).entries;
  assert.equal(d.chef.model, 'm1');
  assert.equal(d.cook.model, 'm8', 'the other process\'s title is kept');
  const other = open(file, {});
  other.qhash = 'another-wording';
  other.put('Sous Chef', entry(3));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).entries), ['sous chef'], 'a new wording means a fresh cache');
});

test('a stale lock (older than 10 seconds: a killed process) is taken over at once, a lock of a live writer is waited for, and a file that cannot be locked never fails the put', () => {
  const file = path.join(home.state, 'levels-lock.json');
  fs.mkdirSync(home.state, { recursive: true });
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  const t0 = Date.now();
  open(file).put('Title', entry(1));
  assert.ok(Date.now() - t0 < 1000, 'the stale lock did not make the put wait');
  assert.ok(open(file).get('title'));
  assert.equal(fs.existsSync(lock), false);
  // a folder that cannot be made (a file is in the way): the put is silent
  const blocker = path.join(home.state, 'blocker');
  fs.writeFileSync(blocker, 'a file where a folder is needed');
  assert.doesNotThrow(() => open(path.join(blocker, 'x', 'levels.json')).put('T', entry(2)));
});

test('eight processes that put different titles at the same moment lose none of them (three rounds)', async () => {
  for (let round = 0; round < 3; round++) {
    const file = path.join(home.state, `levels-par-${round}.json`);
    const startAt = Date.now() + 1500;
    const code = `
      const c = require(${JSON.stringify(CACHE_JS)});
      const s = new c.SearchLevels({ file: ${JSON.stringify(file)}, qhash: 'h' });
      s.load();
      while (Date.now() < ${startAt}) { /* every process has loaded the same empty file; they all write together */ }
      for (let k = 0; k < 3; k++) s.put('title ' + process.argv[1] + '-' + k, { p: { mid: 1 }, model: 'm' });
    `;
    const kids = Array.from({ length: 8 }, (_, i) => new Promise(resolve => {
      const c = spawn(process.execPath, ['-e', code, String(i)], { stdio: 'ignore' });
      c.on('close', resolve);
    }));
    await Promise.all(kids);
    const entries = JSON.parse(fs.readFileSync(file, 'utf8')).entries;
    assert.equal(Object.keys(entries).length, 24, `round ${round}: ${Object.keys(entries).length} of 24 titles survived`);
    assert.equal(fs.existsSync(`${file}.lock`), false);
  }
});

test('a writer whose lock was taken over after the stale limit leaves the new owner\'s lock alone, and a lock it still owns is removed', () => {
  const lock = path.join(home.state, 'own.lock');
  cache.withFileLock(lock, () => { fs.writeFileSync(lock, 'another-writer-token'); });
  assert.equal(fs.readFileSync(lock, 'utf8'), 'another-writer-token', 'not ours any more: kept');
  fs.unlinkSync(lock);
  assert.equal(cache.withFileLock(lock, () => 7), 7);
  assert.equal(fs.existsSync(lock), false, 'ours: removed');
});
