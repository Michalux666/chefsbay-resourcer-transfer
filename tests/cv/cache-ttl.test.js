'use strict';
// The search-level cache: the level Jev gave to a searched title is reused for 30 days (cache.searchLevelTtlSec), then asked again.
const { makeHome } = require('./helpers/home');
const home = makeHome('cv-ttl');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startFakeJev } = require('./helpers/fake-jev');
const { NOW, role, record } = require('./helpers/fixtures');
const cv = require('../../resourcer/scripts/lib/cv');
const cache = require('../../resourcer/scripts/lib/cv/cache');

const DAY = 86400000;
let gw;
test.before(async () => { gw = await startFakeJev(); });
test.after(async () => { await gw.close(); home.cleanup(); });
test.beforeEach(() => { home.reset(); gw.reset(); home.point(gw); process.env.SCREEN_MAX_ATTEMPTS = '3'; });

const cfgOf = over => cv.loadConfig({ file: 'no-such-file.json', overrides: over });
const screen = (searchRole, req, over) => cv.screenCv({ searchRole, ...req, ctx: { cfg: cfgOf(over), now: NOW } });
const roles = i => [role('Chef de Partie', `${2010 + i}-01`, 'present')];
const qhashOf = cfg => cv.questions.questionSetHash(cfg, cv.questions.buildSearchLevelRequest(cfg, '').questions);

test('SearchLevels: an entry is reused inside its lifetime and asked again from the moment it is that old', () => {
  const file = path.join(home.state, 'levels-unit.json');
  let now = Date.parse('2026-09-01T00:00:00Z');
  const open = ttlSec => new cache.SearchLevels({ file, qhash: 'h', ttlSec, now: () => now });
  open(30 * 86400).put('Chef de Partie', { p: { mid: 0.9, unclear: 0.1 }, model: 'typesafe-ai/jev' });
  assert.equal(open(30 * 86400).get('chef  de PARTIE').p.mid, 0.9, 'titles are compared after trimming, case and spaces');
  now += 29 * DAY + 23 * 3600 * 1000;
  assert.ok(open(30 * 86400).get('Chef de Partie'), 'still fresh just before 30 days');
  now += 3600 * 1000;
  assert.equal(open(30 * 86400).get('Chef de Partie'), null, 'exactly 30 days old is expired');
  assert.ok(open(undefined).get('Chef de Partie'), 'no lifetime given: kept for ever');
  assert.equal(open(0).get('Chef de Partie'), null, 'a lifetime of 0 never reuses an entry');
});

test('SearchLevels: an entry whose timestamp cannot be read is not trusted when there is a lifetime', () => {
  const file = path.join(home.state, 'levels-bad-at.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, qhash: 'h', entries: { 'chef': { p: { mid: 1 }, model: 'm', at: 'not a date' }, 'cook': { p: { mid: 1 }, model: 'm' } } }));
  const s = new cache.SearchLevels({ file, qhash: 'h', ttlSec: 100 });
  assert.equal(s.get('chef'), null);
  assert.equal(s.get('cook'), null);
  assert.ok(new cache.SearchLevels({ file, qhash: 'h' }).get('chef'), 'without a lifetime it is used as before');
});

test('the default lifetime is 30 days, and it is configuration', () => {
  assert.equal(cfgOf().cache.searchLevelTtlSec, 30 * 86400);
  assert.equal(cfgOf({ cache: { searchLevelTtlSec: 3600 } }).cache.searchLevelTtlSec, 3600);
});

test('the stage: a level remembered 29 days ago is reused, one remembered 31 days ago is asked again and the entry is renewed', async () => {
  const cfg = cfgOf();
  const put = ageDays => new cache.SearchLevels({ file: cache.levelsFile(), qhash: qhashOf(cfg), now: () => Date.now() - ageDays * DAY }).put('Chef de Partie', { p: { entry: 0, mid: 0.9, senior: 0.05, head: 0, not_a_kitchen_role: 0.05, unclear: 0 }, model: 'typesafe-ai/jev' });

  put(29);
  let r = await screen('Chef de Partie', { record: record(roles(0)) });
  assert.equal(r.searchLevel, 'mid');
  assert.equal(gw.stats().searchLevel, 0, 'reused');

  put(31);
  gw.reset();
  r = await screen('Chef de Partie', { record: record(roles(1)) });
  assert.equal(gw.stats().searchLevel, 1, 'asked again');
  const fresh = JSON.parse(fs.readFileSync(cache.levelsFile(), 'utf8')).entries['chef de partie'];
  assert.ok(Date.now() - Date.parse(fresh.at) < 60000, 'the entry was renewed');

  gw.reset();
  await screen('Chef de Partie', { record: record(roles(2)) });
  assert.equal(gw.stats().searchLevel, 0, 'and reused again');
});

test('the stage: a lifetime of 0 asks for the level of the searched title every time', async () => {
  await screen('Chef de Partie', { record: record(roles(0)) }, { cache: { searchLevelTtlSec: 0 } });
  await screen('Chef de Partie', { record: record(roles(1)) }, { cache: { searchLevelTtlSec: 0 } });
  assert.equal(gw.stats().searchLevel, 2);
});
