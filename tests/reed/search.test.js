'use strict';

// reed-search: location cache, request shape, activity mapping, card normalisation, CLI.

const test = require('node:test');
const assert = require('node:assert');
const { withWorld, validSession } = require('./helpers/world');

const world = (fn, o) => withWorld(fn, { fake: { loggedIn: true }, ...(o || {}) });
const searchReq = (fake) => fake.api.requests.filter((q) => q.path.startsWith('/candidate/search/boolean/')).map((q) => JSON.parse(q.body));

test('search builds the portal request body, resolves the location once (file cache) and normalises cards', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  const r = await drive(`
    const { search } = require('./reed-search');
    const a = await search({ keywords: 'Chef', location: 'ls1', distance: 15, activeWithin: '3months', page: 1, pageSize: 25, ukOnly: true, tempOnly: false });
    const b = await search({ keywords: 'Chef', location: 'LS1', page: 2 });
    return { a: { totalCount: a.totalCount, pages: a.pages, page: a.page, pageSize: a.pageSize, queryId: a.queryId, first: { ...a.candidates[0], _raw: undefined } }, b: { page: b.page, n: b.candidates.length, pages: b.pages } };
  `);
  assert.ok(r.ok, JSON.stringify(r.error) + r.stderr);
  assert.deepStrictEqual(r.result.a.first, {
    id: 9001, name: 'Test Person 1', firstName: 'Test', lastLogin: '2026-09-01T10:00:00Z', lastLoginFriendly: '', isNew: false, isUnlocked: false,
    dateViewed: null, dateHidden: null, currentJobTitle: 'Chef de Partie 1', desiredJobTitle: 'Sous Chef', jobType: 'Permanent',
    currentLocation: 'Town1', desiredLocations: 'Leeds', salary: '25000', sectors: null, hasWorkPermit: true, noticePeriod: '1 month',
  });
  assert.strictEqual(r.result.a.totalCount, 30);
  assert.strictEqual(r.result.a.pages, 2);
  assert.strictEqual(r.result.a.pageSize, 25);
  assert.strictEqual(r.result.a.queryId, 'q-fake-0001');
  assert.strictEqual(r.result.b.n, 5);
  const bodies = searchReq(fake);
  assert.strictEqual(bodies[0].activityTimeFrame, 'ThreeMonths');
  assert.strictEqual(bodies[0].locationDistance, 15);
  assert.strictEqual(bodies[0].workEligibility, 'ukOnly');
  assert.deepStrictEqual(bodies[0].locationIds, [4242]);
  assert.strictEqual(bodies[0].keywords, 'Chef');
  assert.strictEqual(bodies[0].searchBy, 'cvAndJobTitle');
  assert.strictEqual(bodies[0].sortBy, 'relevancy');
  assert.strictEqual(bodies[1].activityTimeFrame, 'month', 'default activeWithin');
  assert.strictEqual(bodies[1].locationDistance, 20, 'default distance');
  const lookups = fake.api.requests.filter((q) => q.path.startsWith('/location/suggest-locations/'));
  assert.strictEqual(lookups.length, 1, 'second search is served from the location cache');
  assert.match(lookups[0].search, /searchTerm=ls1/);
  const cache = m.readJson('reed-location-cache.json');
  assert.strictEqual(cache.LS1.id, 4242);
}));

test('activity mapping, uk-only false and temp-only', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  const r = await drive(`
    const { search, ACTIVITY_TIMEFRAME_MAP } = require('./reed-search');
    for (const w of ['day', 'week', '2 weeks', 'onemonth', '6months', 'year', 'weird']) await search({ keywords: 'Chef', location: 'LS1', activeWithin: w, page: 1 });
    await search({ keywords: 'Chef', location: 'LS1', ukOnly: false, tempOnly: true });
    return Object.keys(ACTIVITY_TIMEFRAME_MAP).length;
  `);
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.strictEqual(r.result, 21);
  const b = searchReq(fake);
  assert.deepStrictEqual(b.slice(0, 7).map((x) => x.activityTimeFrame), ['Day', 'Week', 'TwoWeeks', 'month', 'SixMonths', 'year', 'weird']);
  assert.strictEqual(b[7].workEligibility, 'all');
  assert.strictEqual(b[7].isTemporary, true);
}));

test('resolveLocation: exact match preferred, alternative response shapes, not-found and no-id errors, corrupt cache tolerated', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  m.write('reed-location-cache.json', '{ corrupt');
  fake.api.failNext = [];
  const r = await drive(`
    const { resolveLocation } = require('./reed-search');
    return await resolveLocation('Leeds');
  `);
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.deepStrictEqual(r.result, { id: 4242, name: 'LEEDS' });
}));

test('resolveLocation response shape handling (unit, stubbed reedFetch)', () => world(async ({ m, drive }) => {
  const r = await drive(`
    const client = require('./reed-api-client');
    const shapes = {
      arr: [{ locationId: 1, searchName: 'A' }],
      res: { result: [{ id: 2, name: 'B' }] },
      sug: { suggestedLocations: [{ locationId: 3, displayName: 'C' }] },
      dat: { data: [{ locationId: 4, name: 'D' }] },
      deep: { x: { y: { z: [{ locationId: 5, name: 'E' }] } } },
      exact: { result: { suggestedLocations: [{ locationId: 6, searchName: 'Other' }, { locationId: 7, searchName: 'leeds' }] } },
    };
    let cur;
    const orig = Object.getOwnPropertyDescriptor(client, 'reedFetch');
    client.reedFetch = async () => cur;
    delete require.cache[require.resolve('./reed-search')];
    const { resolveLocation } = require('./reed-search');
    const out = {};
    let i = 0;
    for (const [k, v] of Object.entries(shapes)) { cur = v; out[k] = (await resolveLocation(k === 'exact' ? 'Leeds' : 'term' + (i++))).id; }
    cur = { result: { suggestedLocations: [] } };
    try { await resolveLocation('nowhere'); } catch (e) { out.none = e.message; }
    cur = { result: { suggestedLocations: [{ name: 'noid' }] } };
    try { await resolveLocation('noid'); } catch (e) { out.noid = e.message.slice(0, 40); }
    return out;
  `);
  assert.ok(r.ok, JSON.stringify(r.error) + r.stderr);
  assert.deepStrictEqual({ arr: r.result.arr, res: r.result.res, sug: r.result.sug, dat: r.result.dat, deep: r.result.deep, exact: r.result.exact }, { arr: 1, res: 2, sug: 3, dat: 4, deep: 5, exact: 7 });
  assert.strictEqual(r.result.none, 'No locations found for "nowhere"');
  assert.match(r.result.noid, /^Location API returned no ID/);
}));

test('required arguments and the CLI: JSON on stdout without _raw, usage exit 1, --help exit 0, relogin hint', () => world(async ({ m, fake, run, drive }) => {
  validSession(m, fake);
  const bad = await drive("try { await require('./reed-search').search({ location: 'LS1' }); } catch (e) { return e.message; }");
  assert.strictEqual(bad.result, 'keywords is required');
  const bad2 = await drive("try { await require('./reed-search').search({ keywords: 'x' }); } catch (e) { return e.message; }");
  assert.strictEqual(bad2.result, 'location is required');
  let r = await run('reed-search.js', ['--keywords', 'Chef', '--location', 'LS1', '--page-size', '5']);
  assert.strictEqual(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.candidates.length, 5);
  assert.ok(!('_raw' in j.candidates[0]));
  r = await run('reed-search.js', ['--keywords', 'Chef', '--location', 'LS1', '--page-size', '2', '--verbose']);
  assert.ok('_raw' in JSON.parse(r.stdout).candidates[0]);
  r = await run('reed-search.js', ['--keywords', 'Chef']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /Usage: node scripts\/reed-search\.js/);
  r = await run('reed-search.js', ['--help']);
  assert.strictEqual(r.code, 0);
  fake.api.failNext = [{ status: 401 }, { status: 401 }];
  r = await run('reed-search.js', ['--keywords', 'Chef', '--location', 'NEWPLACE']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /REED_RELOGIN_NEEDED/);
  assert.match(r.stderr, /cdp-reed-full-login\.js/);
}));
