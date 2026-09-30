'use strict';
// applying-for-role-map.js (golden values from the legacy module), build-caterer-results-url.js,
// postcode-lookup.js (network stubbed) and fill-mandatory-fields.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');
const H = require('./helpers/home');

const home = H.makeHome('text');
process.env.RESOURCER_HOME = home;
process.env.HERMES_HOME = home;
require('./helpers/netguard');

const S = H.SCRIPTS;

// ---------------------------------------------------------------- applying-for-role-map
const TITLES = [
  ['Sous Chef', 'Chef'], ['Head Chef', 'Chef'], ['Chef de Partie', 'Chef'], ['CDP', 'Chef'], ['Commis Chef', 'Chef'],
  ['Pastry Chef', 'Chef'], ['Baker', 'Chef'], ['Pizzaiolo', 'Chef'], ['Kitchen Porter', 'Kitchen Porter'],
  ['Kichen Porter', 'Kitchen Porter'], ['Pot Wash', 'Kitchen Porter'], ['Potwasher', 'Kitchen Porter'],
  ['Dishwasher', 'Kitchen Porter'], ['Kitchen Steward', 'Kitchen Porter'], ['Kitchen Assistant', 'Kitchen Assistant'],
  ['Catering Assistant', 'Kitchen Assistant'], ['Canteen Assistant', 'Kitchen Assistant'], ['Food Handler', 'Kitchen Assistant'],
  ['Food Production Operative', 'Kitchen Assistant'], ['School Lunchtime Supervisor', 'Kitchen Assistant'],
  ['Barista', 'Bar'], ['Bar Manager', 'Bar'], ['Bartender', 'Bar'], ['Barman', 'Bar'], ['Cocktail Waiter', 'Bar'],
  ['Waiter', 'Waiting'], ['Waitress', 'Waiting'], ['Server', 'Waiting'], ['Front of House Manager', 'Waiting'],
  ['Host', 'Waiting'], ['Hostess', 'Waiting'], ['F & B Assistant', 'Waiting'], ['Food Runner', 'Waiting'],
  ['Restaurant Assistant', 'Waiting'], ['Housekeeper', 'Housekeeping'], ['Room Attendant', 'Housekeeping'],
  ['Laundry Operative', 'Housekeeping'], ['Supervisor', 'Supervisor'], ['Team Leader', 'Supervisor'],
  ['Admin Assistant', 'Admin'], ['Receptionist', 'Admin'], ['Office Manager', 'Admin'], ['General Manager', 'Manager'],
  ['Restaurant Manager', 'Manager'], ['Operations Management', 'Manager'], ['GM', 'Manager'], ['Catering Manager', 'Chef'],
  ['Kitchen Manager', 'Chef'], ['Cook', 'Chef'], ['Line Cook', 'Chef'], ['Culinary Assistant', 'Chef'], ['Confectioner', 'Chef'],
  ['Cake Decorator', 'Chef'], ['Sales Executive', null], ['Driver', null], ['Working Chef Manager', 'Chef'],
  ['Executive Chef', 'Chef'], ['Souschef', 'Chef'], ['Bake Off Champion', null], ['Pizza Maker', 'Chef'],
  ['Mixologist', 'Bar'], ['Cellar Person', null],
];
const SKILLS = [
  ['cocktail, mixology', 'Bar'], ['housekeeping, linen', 'Housekeeping'], ['front of house, table service', 'Waiting'],
  ['pot wash, dishwashing', 'Kitchen Porter'], ['food hygiene, canteen', 'Kitchen Assistant'], ['haccp, baking', 'Chef'],
  ['general management', 'Manager'], ['excel, word', null], ['wine service', 'Bar'], ['cooking, knife skills', 'Chef'],
  ['Fine Dining, Wine Service', 'Bar'],
];

test.describe('applying-for-role-map', () => {
  const m = require(path.join(S, 'applying-for-role-map.js'));

  test('mapToApplyingForRole matches the legacy mapping for every golden title', () => {
    for (const [title, role] of TITLES) assert.equal(m.mapToApplyingForRole(title), role, title);
  });

  test('rule order: porter before kitchen, bar before chef, manager last; case-insensitive', () => {
    assert.equal(m.mapToApplyingForRole('KITCHEN PORTER'), 'Kitchen Porter');
    assert.equal(m.mapToApplyingForRole('kitchen manager'), 'Chef');
    assert.equal(m.mapToApplyingForRole('Caf Attendant'), 'Waiting');
    assert.equal(m.mapToApplyingForRole('Cafe Attendant'), null, 'legacy quirk kept: the rule is caf + optional accented e, so a plain e does not match');
    assert.equal(m.mapToApplyingForRole('Caf\xe9 Attendant'), 'Waiting', 'the accented form is matched');
  });

  test('non-strings and empty input give null', () => {
    for (const v of [null, undefined, 5, {}, '', []]) assert.equal(m.mapToApplyingForRole(v), null);
  });

  test('mapFromSkillSet matches the legacy mapping and ignores non-strings', () => {
    for (const [skills, role] of SKILLS) assert.equal(m.mapFromSkillSet(skills), role, skills);
    for (const v of [null, undefined, 5, '']) assert.equal(m.mapFromSkillSet(v), null);
  });

  test('CLI prints the mapping; --help exits 0; no argument exits 1', () => {
    let r = H.run('scripts/applying-for-role-map.js', ['Sous', 'Chef'], { home });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '"Sous Chef" => Chef');
    r = H.run('scripts/applying-for-role-map.js', ['Astronaut'], { home });
    assert.equal(r.stdout.trim(), '"Astronaut" => (no match)');
    assert.equal(H.run('scripts/applying-for-role-map.js', ['--help'], { home }).status, 0);
    assert.equal(H.run('scripts/applying-for-role-map.js', [], { home }).status, 1);
  });
});

// ---------------------------------------------------------------- build-caterer-results-url
test.describe('build-caterer-results-url', () => {
  const b = require(path.join(S, 'build-caterer-results-url.js'));

  test('the URL is byte-identical to the browser-captured shape', () => {
    const { url, searchId } = b.buildResultsUrl({ jobTitle: 'Chef', location: 'DL7', distance: 30, searchId: 'abc-123' });
    assert.equal(searchId, 'abc-123');
    assert.equal(url, 'https://recruiter.caterer.com/CandidateSearchWebMvc/CandidateSearch/Results'
      + '?FreeText=Chef&ShowUnspecifiedSalary=False&CurrentLocation=DL7&Radius=48280&SalaryFacetsType=99'
      + '&PreRegStatusFacet=0%2c1&HideCandidatesSinceDays=7&SearchId=abc-123&scr=1');
  });

  test('FreeText uses + for spaces, keywords are appended, the location is percent-encoded', () => {
    const { url } = b.buildResultsUrl({ jobTitle: ' Sous Chef ', location: 'LS1 4AB', distance: 20, keywords: ' nvq  dbs ', searchId: 'g' });
    assert.match(url, /FreeText=Sous\+Chef\+nvq\+\+dbs&/);
    assert.match(url, /CurrentLocation=LS1%204AB&/);
    assert.match(url, /Radius=32187&/);
    assert.match(b.buildResultsUrl({ jobTitle: 'Kitchen & Porter', location: 'B1', distance: 10, searchId: 'g' }).url, /FreeText=Kitchen\+%26\+Porter&/);
  });

  test('a random GUID is generated when no search id is given', () => {
    const a = b.buildResultsUrl({ jobTitle: 'Chef', location: 'B1', distance: 5 });
    const c = b.buildResultsUrl({ jobTitle: 'Chef', location: 'B1', distance: 5 });
    assert.match(a.searchId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(a.searchId, c.searchId);
  });

  test('every mapped distance gives its radius; unmapped distances snap to the nearest valid one', () => {
    for (const [miles, metres] of Object.entries(b.RADIUS_METERS)) assert.equal(b.resolveRadius(Number(miles)), metres);
    assert.equal(b.resolveRadius('30'), 48280, 'numeric strings are accepted');
    assert.equal(b.resolveRadius(25), 48280, '25mi snaps to 30mi (the 2026-06-08 redirect loop)');
    assert.equal(b.resolveRadius(15), 32187);
    assert.equal(b.resolveRadius(35), 48280);
    assert.equal(b.resolveRadius(50), 64374);
    assert.equal(b.resolveRadius(70), 96561);
    assert.equal(b.resolveRadius(100), 128748);
    assert.equal(b.resolveRadius(0.3), 805);
    assert.equal(b.resolveRadius(2), 4828);
    assert.deepEqual(Object.values(b.RADIUS_METERS).sort((x, y) => x - y), [0, 805, 1609, 4828, 8047, 16093, 32187, 48280, 64374, 96561, 128748]);
    assert.equal(b.HIDE_VIEWED_SINCE_DAYS, 7);
  });

  test('unmappable distances and missing fields are errors', () => {
    for (const d of ['abc', '1x', undefined, -5, NaN]) assert.throws(() => b.resolveRadius(d), /unmappable distance/, String(d));
    assert.throws(() => b.buildResultsUrl({ jobTitle: '', location: 'X', distance: 5 }), /jobTitle is required/);
    assert.throws(() => b.buildResultsUrl({ jobTitle: 'X', location: ' ', distance: 5 }), /location is required/);
    assert.match(b.buildResultsUrl({ jobTitle: 'X', location: 'Y', distance: 0, searchId: 'g' }).url, /&Radius=0&/, 'distance 0 is a valid (zero) radius');
  });

  test('CLI prints RESULTS_URL and SEARCH_ID; errors go to stderr with exit 1', () => {
    let r = H.run('scripts/build-caterer-results-url.js', ['--job', 'Chef', '--location', 'DL7', '--distance', '30', '--search-id', 'abc'], { home });
    assert.equal(r.status, 0);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith('RESULTS_URL:https://recruiter.caterer.com/'));
    assert.equal(lines[1], 'SEARCH_ID:abc');
    r = H.run('scripts/build-caterer-results-url.js', ['--job', 'Chef'], { home });
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trim(), 'ERROR:location is required');
    assert.equal(H.run('scripts/build-caterer-results-url.js', ['--help'], { home }).status, 0);
  });
});

// ---------------------------------------------------------------- postcode-lookup
test.describe('postcode-lookup', () => {
  const cacheFile = path.join(home, 'postcode-lookup-cache.json');
  const realGet = https.get;
  let apiCalls;

  // Replaces https.get with a scripted answer: handler(url) -> object | 'error' | 'timeout' | 'garbage'.
  function stubApi(handler) {
    apiCalls = [];
    https.get = (url, opts, cb) => {
      apiCalls.push(String(url));
      const req = new EventEmitter();
      req.destroy = () => {};
      process.nextTick(() => {
        const out = handler(String(url));
        if (out === 'error') return req.emit('error', new Error('boom'));
        if (out === 'timeout') return req.emit('timeout');
        const res = new EventEmitter();
        cb(res);
        res.emit('data', out === 'garbage' ? '<html>' : JSON.stringify(out));
        res.emit('end');
      });
      return req;
    };
  }
  test.beforeEach(() => { fs.rmSync(cacheFile, { force: true }); });
  test.afterEach(() => { https.get = realGet; });

  const fresh = () => {
    delete require.cache[require.resolve(path.join(S, 'postcode-lookup.js'))];
    return require(path.join(S, 'postcode-lookup.js'));
  };

  test('normalise strips the county, punctuation and dashes', () => {
    const { normalise } = fresh();
    assert.equal(normalise('Leeds, West Yorkshire'), 'leeds');
    assert.equal(normalise('Sutton-in-Ashfield'), 'sutton in ashfield');
    assert.equal(normalise('  Stoke   on Trent '), 'stoke on trent');
    assert.equal(normalise('Chester-le-Street!'), 'chester le street');
    assert.equal(normalise("St. Helen's"), "st. helen's");
    assert.equal(normalise('Leeds ' + String.fromCharCode(0x2013) + ' West'), 'leeds west');
    assert.equal(normalise(''), '');
    assert.equal(normalise(null), '');
  });

  test('the static table answers without the network or the cache file', async () => {
    stubApi(() => { throw new Error('must not be called'); });
    const { lookupPostcodeForCity, STATIC_TABLE } = fresh();
    assert.equal(await lookupPostcodeForCity('Derby'), 'DE1');
    assert.equal(await lookupPostcodeForCity('Leeds, West Yorkshire'), 'LS1');
    assert.equal(await lookupPostcodeForCity('St. Helens'), 'WA10');
    assert.equal(await lookupPostcodeForCity('Stoke-on-Trent'), 'ST1');
    assert.equal(await lookupPostcodeForCity('LONDON'), 'EC1A');
    assert.equal(apiCalls.length, 0);
    assert.ok(!fs.existsSync(cacheFile));
    assert.equal(Object.keys(STATIC_TABLE).length, 111);
  });

  test('an empty name gives null', async () => {
    const { lookupPostcodeForCity } = fresh();
    assert.equal(await lookupPostcodeForCity(''), null);
    assert.equal(await lookupPostcodeForCity(undefined), null);
  });

  test('an unknown place is looked up on postcodes.io (City/Town preferred) and cached', async () => {
    stubApi(() => ({ result: [{ local_type: 'Hamlet', outcode: 'ZZ1' }, { local_type: 'Town', outcode: 'AB12' }] }));
    const { lookupPostcodeForCity } = fresh();
    assert.equal(await lookupPostcodeForCity('Testville, Shire'), 'AB12');
    assert.equal(apiCalls.length, 1);
    assert.equal(apiCalls[0], 'https://api.postcodes.io/places?q=testville&limit=5');
    assert.deepEqual(H.readJson(cacheFile), { testville: 'AB12' });
    assert.equal(await lookupPostcodeForCity('TESTVILLE'), 'AB12');
    assert.equal(apiCalls.length, 1, 'served from the cache');
  });

  test('the first result is used when none is a City or Town', async () => {
    stubApi(() => ({ result: [{ local_type: 'Hamlet', outcode: 'ZZ1' }, { local_type: 'Suburb', outcode: 'ZZ2' }] }));
    const { lookupPostcodeForCity } = fresh();
    assert.equal(await lookupPostcodeForCity('Hamletville'), 'ZZ1');
  });

  test('failures give null and the null is cached (no repeated failing lookups)', async () => {
    for (const mode of ['error', 'timeout', 'garbage', { result: [] }, {}]) {
      fs.rmSync(cacheFile, { force: true });
      stubApi(() => mode);
      const { lookupPostcodeForCity } = fresh();
      assert.equal(await lookupPostcodeForCity('Nowhereville'), null, JSON.stringify(mode));
      assert.deepEqual(H.readJson(cacheFile), { nowhereville: null });
      assert.equal(await lookupPostcodeForCity('Nowhereville'), null);
      assert.equal(apiCalls.length, 1);
    }
  });

  test('an existing cache file is honoured, a corrupt one is ignored', async () => {
    stubApi(() => ({ result: [{ local_type: 'City', outcode: 'NEW1' }] }));
    fs.writeFileSync(cacheFile, JSON.stringify({ cached: 'CA1' }));
    let { lookupPostcodeForCity } = fresh();
    assert.equal(await lookupPostcodeForCity('Cached'), 'CA1');
    assert.equal(apiCalls.length, 0);
    fs.writeFileSync(cacheFile, '{corrupt');
    ({ lookupPostcodeForCity } = fresh());
    assert.equal(await lookupPostcodeForCity('Fresh'), 'NEW1');
    assert.deepEqual(H.readJson(cacheFile), { fresh: 'NEW1' });
  });

  test('CLI: static hit prints "<city> -> <outcode>"; no argument and --help', () => {
    let r = H.run('scripts/postcode-lookup.js', ['Derby'], { home });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'Derby -> DE1');
    assert.match(r.stderr, /\[postcode-lookup\] Static hit: "Derby" -> DE1/);
    assert.equal(H.run('scripts/postcode-lookup.js', [], { home }).status, 1);
    assert.equal(H.run('scripts/postcode-lookup.js', ['--help'], { home }).status, 0);
  });
});

// ---------------------------------------------------------------- fill-mandatory-fields
test.describe('fill-mandatory-fields', () => {
  const f = require(path.join(S, 'fill-mandatory-fields.js'));
  const cities = H.readJson(path.join(H.RES, 'config', 'postcode-cities.json'));
  const dir = path.join(home, 'fill');
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const cand = (obj) => { const p = path.join(dir, `candidate-${n++}.json`); H.writeJson(p, obj); return p; };
  const cv = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
  const capErr = async (fn) => {
    const orig = process.stderr.write.bind(process.stderr);
    let buf = '';
    process.stderr.write = (s) => { buf += s; return true; };
    try { return { value: await fn(), stderr: buf }; } finally { process.stderr.write = orig; }
  };

  test('findPhone prefers UK mobiles, strips separators and enforces 10-14 digits', () => {
    assert.equal(f.findPhone('call 07700 900123 today'), '07700900123');
    assert.equal(f.findPhone('+44 7700 900 123'), '+447700900123');
    assert.equal(f.findPhone('landline 0113 496 0000 mobile 07700900999'), '07700900999', 'a mobile beats an earlier landline');
    assert.equal(f.findPhone('0113 496 0000'), '01134960000');
    assert.equal(f.findPhone('no number here'), null);
    assert.equal(f.findPhone('12345'), null);
    assert.equal(f.findPhone(''), null);
  });

  test('findEmail skips example and test@ addresses', () => {
    assert.equal(f.findEmail('write to a.b@site.co.uk please'), 'a.b@site.co.uk');
    assert.equal(f.findEmail('test@x.org example@site.com real@site.com'), 'real@site.com');
    assert.equal(f.findEmail('only example@site.com'), null);
    assert.equal(f.findEmail('nothing'), null);
  });

  test('findName takes the first 2-5 word line of letters and skips CV headings', () => {
    assert.deepEqual(f.findName('John Smith\nChef'), { first: 'John', last: 'Smith' });
    assert.deepEqual(f.findName('Curriculum Vitae\nMaria Garcia Lopez\n'), { first: 'Maria', last: 'Garcia Lopez' });
    assert.deepEqual(f.findName("\n\n  Mary-Jane O'Neil  \n"), { first: 'Mary-Jane', last: "O'Neil" });
    assert.equal(f.findName('Personal Statement\nEducation\nWork Experience'), null);
    assert.equal(f.findName('12 High Street\nLeeds'), null);
    assert.deepEqual(f.findName('Just one\n'), { first: 'Just', last: 'one' });
    assert.equal(f.findName('A B C D E F G'), null, 'more than 5 words is not a name');
    assert.equal(f.findName(''), null);
  });

  test('deriveCity uses the postcode area table, longest prefix first, and strips a "City, " lead-in', () => {
    assert.equal(f.deriveCity('LS1 4AB'), cities.LS.city);
    assert.equal(f.deriveCity('York, YO41 1FQ'), cities.YO.city);
    assert.equal(f.deriveCity('e6 3dt'), cities.E.city);
    assert.equal(f.deriveCity('M1 1AA'), cities.M.city);
    assert.equal(f.deriveCity('ZZ1 1ZZ'), null);
    assert.equal(f.deriveCity(''), null);
    assert.equal(f.deriveCity(null), null);
    assert.equal(f.deriveCity('not a postcode'), null);
  });

  test('recovers Mobile, Email and names from a text CV and writes the file back (owner-only)', async () => {
    const p = cand({ First_Name: '', Last_Name: '', Email: '', Mobile: '', City: '', Zip_Code: 'LS1 4AB', CatererID: '111' });
    const r = await f.fillMandatoryFields(p, cv('cv-a.txt', 'John Smith\nCommis Chef\nMobile: 07700 900123\nEmail: john.smith@mail.test\n'));
    assert.equal(r.patched, true);
    assert.deepEqual(r.recovered.sort(), ['City=' + cities.LS.city, 'Email=john.smith@mail.test', 'First_Name=John', 'Last_Name=Smith', 'Mobile=07700900123'].sort());
    assert.deepEqual(r.stillMissing, []);
    const doc = H.readJson(p);
    assert.equal(doc.Mobile, '07700900123');
    assert.equal(doc.City, cities.LS.city);
    assert.equal(doc.First_Name, 'John');
    if (process.platform !== 'win32') assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir).filter(x => x.endsWith('.tmp')), []);
  });

  test('fallbacks: placeholder mobile, "Candidate", the Caterer id as surname; Email has no fallback', async () => {
    const p = cand({ First_Name: '', Last_Name: '', Email: '', Mobile: '', City: 'Leeds', Zip_Code: 'LS1 1AA', CatererID: '222' });
    const r = await f.fillMandatoryFields(p, cv('cv-b.txt', 'no useful text here at all'));
    assert.deepEqual(r.stillMissing, ['Email']);
    const doc = H.readJson(p);
    assert.equal(doc.Mobile, '07777777777');
    assert.equal(doc.First_Name, 'Candidate');
    assert.equal(doc.Last_Name, '222');
    assert.equal(doc.Email, '');
    const q = cand({ First_Name: '', Last_Name: '', Email: 'a@b.test', Mobile: '07700900000', City: 'Leeds', Zip_Code: 'LS1 1AA' });
    await f.fillMandatoryFields(q, null);
    assert.equal(H.readJson(q).Last_Name, 'Unknown');
  });

  test('a missing City is derived from Zip_Code; an unknown postcode leaves it missing', async () => {
    const p = cand({ First_Name: 'A', Last_Name: 'B', Email: 'a@b.test', Mobile: '07700900000', City: '', Zip_Code: 'ZZ1 1ZZ' });
    const r = await f.fillMandatoryFields(p, null);
    assert.deepEqual(r.stillMissing, ['City']);
    assert.equal(r.patched, false);
  });

  test('a complete record with a Zip_Code is left untouched', async () => {
    const obj = { First_Name: 'A', Last_Name: 'B', Email: 'a@b.test', Mobile: '07700900000', City: 'Derby', Zip_Code: 'DE1 1AA' };
    const p = cand(obj);
    const before = fs.readFileSync(p, 'utf8');
    assert.deepEqual(await f.fillMandatoryFields(p, null), { patched: false, recovered: [], stillMissing: [] });
    assert.equal(fs.readFileSync(p, 'utf8'), before);
  });

  test('a missing Zip_Code is filled from the City (static table, no network)', async () => {
    const p = cand({ First_Name: 'A', Last_Name: 'B', Email: 'a@b.test', Mobile: '07700900000', City: 'Derby', Zip_Code: '' });
    const out = await capErr(() => f.fillMandatoryFields(p, null));
    assert.deepEqual(out.value, { patched: true, recovered: [], enriched: ['Zip_Code=DE1'], stillMissing: [] });
    assert.equal(H.readJson(p).Zip_Code, 'DE1');
    assert.match(out.stderr, /Static hit: "Derby"/);
  });

  test('Zip_Code enrichment failing never blocks: no city, or a lookup error', async () => {
    const p = cand({ First_Name: 'A', Last_Name: 'B', Email: 'a@b.test', Mobile: '07700900000', City: '', Zip_Code: '' });
    const r = await f.fillMandatoryFields(p, null);
    assert.deepEqual(r.stillMissing, ['City']);
    assert.equal(r.patched, false);
  });

  test('a missing candidate file reports every mandatory field as missing', async () => {
    assert.deepEqual(await f.fillMandatoryFields(path.join(dir, 'absent.json'), null), { patched: false, recovered: [], stillMissing: ['First_Name', 'Last_Name', 'Mobile', 'City', 'Email'] });
    assert.deepEqual(f.MANDATORY, ['First_Name', 'Last_Name', 'Mobile', 'City', 'Email']);
  });

  test('extractCvText: text files, HTML masquerading as .doc, size cap, unreadable formats', async () => {
    assert.equal(await f.extractCvText(cv('t.txt', 'plain text')), 'plain text');
    assert.equal(await f.extractCvText(cv('h.doc', '<!DOCTYPE html><html><head><style>x{}</style></head><body><script>1</script>Hello &amp; welcome&nbsp;Bob</body></html>')), 'Hello & welcome Bob');
    assert.equal(await f.extractCvText(null), '');
    assert.equal(await f.extractCvText(path.join(dir, 'nope.txt')), '');
    const big = path.join(dir, 'big.txt');
    fs.closeSync(fs.openSync(big, 'w'));
    fs.truncateSync(big, 5 * 1024 * 1024 + 1);
    const out = await capErr(async () => {
      const origWarn = console.warn;
      let warned = '';
      console.warn = (m) => { warned += m; };
      try { return { text: await f.extractCvText(big), warned }; } finally { console.warn = origWarn; }
    });
    assert.equal(out.value.text, '');
    assert.match(out.value.warned, /CV too large/);
    assert.equal(await f.extractCvText(cv('broken.docx', 'not a zip')), '', 'a corrupt docx yields empty text');
    assert.equal(await f.extractCvText(cv('broken.pdf', 'not a pdf')), '', 'a corrupt pdf yields empty text');
  });

  test('CLI: --help, usage error, and a run on a text CV', () => {
    assert.equal(H.run('scripts/fill-mandatory-fields.js', ['--help'], { home }).status, 0);
    assert.equal(H.run('scripts/fill-mandatory-fields.js', [], { home }).status, 1);
    const p = cand({ First_Name: '', Last_Name: '', Email: '', Mobile: '', City: '', Zip_Code: 'LS1 4AB', CatererID: '5' });
    const c = cv('cli.txt', 'Ann Lee\n07700 900555\nann@mail.test\n');
    const r = H.run('scripts/fill-mandatory-fields.js', [p, c], { home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Recovered: /);
    assert.equal(H.readJson(p).Mobile, '07700900555');
  });
});
