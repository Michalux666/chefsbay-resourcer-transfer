'use strict';
// zoho-auth.js, zoho-create-candidate.js, zoho-attach-resume.js and lib/postcode-to-city.js
// against a fake Zoho / postcodes.io (no network): in-process for the logic, and as child
// processes (fetch replaced by a preload) for the CLIs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/home');
const { createFake } = require('./helpers/fake-services');
require('./helpers/netguard');

const home = H.makeHome('zoho');
process.env.RESOURCER_HOME = home;
process.env.HERMES_HOME = home;
process.env.RESOURCER_ENV_FILE = path.join(home, 'no-such.env');

const credsFile = path.join(home, 'secrets', 'zoho-credentials.json');
const pcCache = path.join(home, 'postcode-to-city-cache.json');
const PRELOAD = path.join(__dirname, 'helpers', 'fake-zoho-preload.js');

function writeCreds(extra = {}) {
  H.writeJson(credsFile, { client_id: 'fake-client', client_secret: 'fake-secret', refresh_token: 'fake-refresh', access_token: 'stale-token', ...extra });
}

function fresh() {
  for (const k of Object.keys(require.cache)) if (k.startsWith(H.SCRIPTS)) delete require.cache[k];
  return {
    auth: require(path.join(H.SCRIPTS, 'zoho-auth.js')),
    create: require(path.join(H.SCRIPTS, 'zoho-create-candidate.js')),
    attach: require(path.join(H.SCRIPTS, 'zoho-attach-resume.js')),
    p2c: require(path.join(H.SCRIPTS, 'lib', 'postcode-to-city.js')),
  };
}

let calls;
let restoreFetch;
function useFake(cfg = {}) {
  calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = createFake(cfg, (e) => calls.push(e), orig);
  restoreFetch = () => { globalThis.fetch = orig; };
}

async function capture(fn) {
  const out = { log: [], err: [] };
  const l = console.log; const e = console.error;
  console.log = (...a) => out.log.push(a.join(' '));
  console.error = (...a) => out.err.push(a.join(' '));
  try { out.value = await fn(); } finally { console.log = l; console.error = e; }
  return out;
}

test.beforeEach(() => {
  writeCreds();
  fs.rmSync(pcCache, { force: true });
});
test.afterEach(() => { if (restoreFetch) { restoreFetch(); restoreFetch = null; } });

const zohoCalls = (m) => calls.filter(c => c.host === 'recruit.zoho.eu' && (!m || c.method === m));

test.describe('zoho-auth', () => {
  test('reads secrets/zoho-credentials.json and sends the bearer token to the Recruit v2 API', async () => {
    useFake();
    const { auth } = fresh();
    assert.equal(auth.loadCreds().client_id, 'fake-client');
    const data = await auth.zohoRequest('GET', '/Candidates/Z1?fields=id');
    assert.deepEqual(data, { data: [{ id: 'Z-DUP-1', Candidate_Status: 'New' }] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].host, 'recruit.zoho.eu');
    assert.equal(calls[0].path, '/recruit/v2/Candidates/Z1?fields=id');
    assert.equal(calls[0].auth, 'Zoho-oauthtoken stale-token');
    assert.equal(auth.RECRUIT_BASE, 'https://recruit.zoho.eu');
  });

  test('a JSON body is sent with a JSON content type', async () => {
    useFake();
    const { auth } = fresh();
    await auth.zohoRequest('PUT', '/Candidates', { data: [{ id: '1' }] });
    assert.deepEqual(calls[0].body, { data: [{ id: '1' }] });
  });

  test('a 401 refreshes the token once, persists it (owner-only, other fields kept) and retries', async () => {
    useFake({ unauthorizedOnce: true });
    const { auth } = fresh();
    const data = await auth.zohoRequest('GET', '/Candidates/Z1');
    assert.equal(data.data[0].id, 'Z-DUP-1');
    assert.deepEqual(calls.map(c => `${c.method} ${c.host}`), ['GET recruit.zoho.eu', 'POST accounts.zoho.eu', 'GET recruit.zoho.eu']);
    assert.deepEqual(calls[1].body, { grant_type: 'refresh_token', client_id: 'fake-client', client_secret: 'fake-secret', refresh_token: 'fake-refresh' });
    assert.equal(calls[2].auth, 'Zoho-oauthtoken fresh-access-token');
    const saved = H.readJson(credsFile);
    assert.equal(saved.access_token, 'fresh-access-token');
    assert.equal(saved.refresh_token, 'fake-refresh');
    assert.equal(saved.client_id, 'fake-client');
    if (process.platform !== 'win32') assert.equal(fs.statSync(credsFile).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(credsFile)).filter(f => f.endsWith('.tmp')), [], 'no temp file left behind');
  });

  test('a second 401 after the refresh is returned, not looped', async () => {
    calls = [];
    const orig = globalThis.fetch;
    restoreFetch = () => { globalThis.fetch = orig; };
    globalThis.fetch = async (input, init) => {
      const u = new URL(typeof input === 'string' ? input : input.url);
      calls.push({ host: u.host });
      if (u.host === 'accounts.zoho.eu') return new Response(JSON.stringify({ access_token: 'x' }), { status: 200 });
      return new Response(JSON.stringify({ code: 'INVALID_TOKEN' }), { status: 401 });
    };
    const { auth } = fresh();
    const res = await auth.zohoRequestRaw('GET', '/Candidates/1');
    assert.equal(res.status, 401);
    assert.equal(calls.filter(c => c.host === 'accounts.zoho.eu').length, 1);
    assert.equal(calls.length, 3);
  });

  test('a failing token endpoint is retried 3 times with growing delays, then throws', async (t) => {
    useFake({ token: 'fail' });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { auth } = fresh();
    const p = auth.refreshToken();
    p.catch(() => {});
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setImmediate(r));
      t.mock.timers.tick(10000);
    }
    await assert.rejects(p, /No access_token/);
    assert.equal(calls.filter(c => c.host === 'accounts.zoho.eu').length, 3);
    assert.equal(H.readJson(credsFile).access_token, 'stale-token', 'the file is untouched on failure');
  });

  test('the error of a failed token refresh names the error only, never the response body (which may echo the request)', async (t) => {
    const orig = globalThis.fetch;
    restoreFetch = () => { globalThis.fetch = orig; };
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid_client', echo: 'client_secret=fake-secret&refresh_token=fake-refresh' }), { status: 400 });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { auth } = fresh();
    const p = auth.refreshToken();
    p.catch(() => {});
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setImmediate(r));
      t.mock.timers.tick(10000);
    }
    await assert.rejects(p, (e) => /No access_token: invalid_client$/.test(e.message) && !/fake-secret|fake-refresh/.test(e.message));
  });
});

test.describe('postcode-to-city', () => {
  test('resolves a full postcode via postcodes.io and caches it on disk', async () => {
    useFake({ postcodes: { 'LS1 4AB': 'Leeds' } });
    const { p2c } = fresh();
    assert.equal(await p2c.lookupCityForPostcode('ls1  4ab'), 'Leeds');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].host, 'api.postcodes.io');
    assert.equal(H.readJson(pcCache)['LS1 4AB'], 'Leeds');
    assert.equal(await p2c.lookupCityForPostcode('LS1 4AB'), 'Leeds');
    assert.equal(calls.length, 1, 'served from the cache');
  });

  test('falls back to the outcode for a retired postcode, and caches a negative result', async () => {
    useFake({ postcodes: { W1J: 'Islington' } });
    const { p2c } = fresh();
    assert.equal(await p2c.lookupCityForPostcode('W1J 7BN'), 'Islington');
    assert.deepEqual(calls.map(c => c.path.split('/')[1]), ['postcodes', 'outcodes']);
    calls.length = 0;
    assert.equal(await p2c.lookupCityForPostcode('ZZ9 9ZZ'), null);
    assert.equal(calls.length, 2);
    assert.equal(H.readJson(pcCache)['ZZ9 9ZZ'], null);
    calls.length = 0;
    assert.equal(await p2c.lookupCityForPostcode('ZZ9 9ZZ'), null);
    assert.equal(calls.length, 0, 'the negative result is cached');
  });

  test('a network failure returns null and is NOT cached', async () => {
    calls = [];
    const orig = globalThis.fetch;
    restoreFetch = () => { globalThis.fetch = orig; };
    globalThis.fetch = async () => { throw new Error('offline'); };
    const { p2c } = fresh();
    assert.equal(await p2c.lookupCityForPostcode('LS1 4AB'), null);
    assert.ok(!fs.existsSync(pcCache));
  });

  test('isPostcode and normalise', () => {
    const { p2c } = fresh();
    assert.equal(p2c.isPostcode('LS1 4AB'), true);
    assert.equal(p2c.isPostcode('ls14ab'), true);
    assert.equal(p2c.isPostcode('Head Chef'), false);
    assert.equal(p2c.isPostcode(''), false);
    assert.equal(p2c.normalise(' ls1   4ab '), 'LS1 4AB');
  });

  test('a non-postcode never reaches the network', async () => {
    useFake();
    const { p2c } = fresh();
    assert.equal(await p2c.lookupCityForPostcode('Sous Chef'), null);
    assert.equal(calls.length, 0);
  });
});

test.describe('zoho-create-candidate', () => {
  const caterer = (extra = {}) => ({
    First_Name: 'Fake', Last_Name: 'Person', Email: 'fake.person@example.test', Mobile: '07700900000',
    City: 'Leeds', Zip_Code: 'LS1 4AB', Country: 'UK', Current_Job_Title: 'Sous Chef', CatererID: '123456',
    Search_Job_Title: 'Sous Chef', Snippet: 'not a zoho field', ...extra,
  });
  const postedPayload = () => zohoCalls('POST')[0].body.data[0];

  test('creates a Caterer candidate with the mapped payload', async () => {
    useFake();
    const { create } = fresh();
    const r = await create.createCandidate(caterer());
    assert.deepEqual(r, { zohoId: 'Z-NEW-1', isDuplicate: false, enrichment: null });
    const call = zohoCalls('POST')[0];
    assert.equal(call.path, '/recruit/v2/Candidates');
    assert.deepEqual(call.body.trigger, ['workflow']);
    assert.equal(call.body.data.length, 1);
    assert.deepEqual(postedPayload(), {
      First_Name: 'Fake', Last_Name: 'Person', Email: 'fake.person@example.test', Mobile: '07700900000',
      Current_Job_Title: 'Sous Chef', City: 'Leeds', Zip_Code: 'LS1 4AB', Country: 'United Kingdom',
      CatererID: '123456', Source: 'Caterer', Applying_for_role: 'Chef', Candidate_Status: 'New',
    });
  });

  test('Applying_for_role: explicit value wins; otherwise mapped from the search title, default Chef', async () => {
    useFake();
    let { create } = fresh();
    await create.createCandidate(caterer({ Applying_for_role: 'Bar', Search_Job_Title: 'Chef' }));
    assert.equal(postedPayload().Applying_for_role, 'Bar');
    calls.length = 0;
    await create.createCandidate(caterer({ Search_Job_Title: 'Kitchen Porter' }));
    assert.equal(postedPayload().Applying_for_role, 'Kitchen Porter');
    calls.length = 0;
    await create.createCandidate(caterer({ Search_Job_Title: undefined }));
    assert.equal(postedPayload().Applying_for_role, 'Chef');
  });

  test('a Reed candidate carries ReedID and Source Reed', async () => {
    useFake();
    const { create } = fresh();
    const c = caterer({ CatererID: undefined, ReedID: '777' });
    await create.createCandidate(c);
    const p = postedPayload();
    assert.equal(p.ReedID, '777');
    assert.equal(p.Source, 'Reed');
    assert.ok(!('CatererID' in p));
    calls.length = 0;
    await create.createCandidate(caterer({ CatererID: undefined, reedID: '888' }));
    assert.equal(postedPayload().ReedID, '888', 'the legacy reedID key is accepted');
  });

  test('required fields are enforced before any request', async () => {
    useFake();
    const { create } = fresh();
    await assert.rejects(create.createCandidate(caterer({ Last_Name: '' })), /ERROR: Last_Name is required/);
    await assert.rejects(create.createCandidate(caterer({ CatererID: undefined })), /ERROR: CatererID is required for Caterer source/);
    await assert.rejects(create.createCandidate(caterer({ source: 'Reed', CatererID: undefined })), /ERROR: ReedID is required for Reed source/);
    assert.equal(calls.length, 0);
  });

  test('HTML entities are decoded in every string field, including a postcode hidden behind an nbsp', async () => {
    useFake({ postcodes: { 'E6 3DT': 'Newham' } });
    const { create } = fresh();
    const out = await capture(() => create.createCandidate(caterer({
      Email: 'o&#39;neil@example.test', Last_Name: 'Smith &amp; Sons', City: '', Zip_Code: '', Current_Job_Title: 'E6&#160; 3DT',
    })));
    const p = postedPayload();
    assert.equal(p.Email, "o'neil@example.test");
    assert.equal(p.Last_Name, 'Smith & Sons');
    assert.equal(p.Zip_Code, 'E6 3DT');
    assert.equal(p.City, 'Newham');
    assert.ok(!('Current_Job_Title' in p), 'a postcode is never sent as a job title');
    assert.ok(out.log.includes('PAYLOAD_FIX: decoded HTML entities in Email'));
    assert.ok(out.log.includes('PAYLOAD_FIX: decoded HTML entities in Last_Name'));
    assert.ok(out.log.some(l => l.startsWith('PAYLOAD_FIX: Current_Job_Title="E6 3DT" is a postcode -> Zip_Code + City="Newham"')));
  });

  test('a postcode in Current_Job_Title that cannot be resolved still fills Zip_Code and warns', async () => {
    useFake({ postcodes: {} });
    const { create } = fresh();
    const out = await capture(() => create.createCandidate(caterer({ City: '', Zip_Code: '', Current_Job_Title: 'ZZ9 9ZZ' })));
    const p = postedPayload();
    assert.equal(p.Zip_Code, 'ZZ9 9ZZ');
    assert.ok(!('City' in p));
    assert.ok(out.log.some(l => l.startsWith('PAYLOAD_WARN: Current_Job_Title="ZZ9 9ZZ" is a postcode but did not resolve to a city')));
  });

  test('a postcode title with City and Zip_Code already present is just dropped', async () => {
    useFake();
    const { create } = fresh();
    await create.createCandidate(caterer({ Current_Job_Title: 'ls1 4ab' }));
    const p = postedPayload();
    assert.ok(!('Current_Job_Title' in p));
    assert.equal(p.City, 'Leeds');
    assert.equal(p.Zip_Code, 'LS1 4AB');
    assert.equal(calls.filter(c => c.host === 'api.postcodes.io').length, 0);
  });

  test('Zoho error codes other than DUPLICATE_DATA are thrown with code, message and details', async () => {
    useFake({ create: 'error' });
    const { create } = fresh();
    await assert.rejects(create.createCandidate(caterer()), /^Error: ERROR: MANDATORY_NOT_FOUND City missing \{"api_name":"City"\}$/);
    restoreFetch(); restoreFetch = null;
    useFake({ create: 'empty' });
    const again = fresh().create;
    await assert.rejects(again.createCandidate(caterer()), /ERROR: Unexpected Zoho response: \{\}/);
  });

  test('DUPLICATE_DATA with gaps in the existing record enriches it and backfills the source id', async () => {
    useFake({ create: 'dup', status: 'New', record: { State: null } });
    const { create } = fresh();
    const out = await capture(() => create.createCandidate(caterer({ State: 'West Yorkshire' })));
    assert.deepEqual(out.value, { zohoId: 'Z-DUP-1', isDuplicate: true, enrichment: 'enriched' });
    assert.ok(out.log.some(l => /^DUPLICATE_ENRICHED ZOHO_ID=Z-DUP-1 fields=/.test(l)));
    const put = zohoCalls('PUT')[0];
    assert.equal(put.path, '/recruit/v2/Candidates');
    const rec = put.body.data[0];
    assert.equal(rec.id, 'Z-DUP-1');
    assert.equal(rec.CatererID, '123456');
    for (const f of ['Mobile', 'Current_Job_Title', 'City', 'Zip_Code', 'State', 'Country']) assert.ok(f in rec, f);
    assert.equal(rec.State, 'West Yorkshire');
  });

  test('DUPLICATE_DATA with nothing to add only backfills the id', async () => {
    const full = { Mobile: '07700900000', Current_Job_Title: 'Sous Chef', City: 'Leeds', Zip_Code: 'LS1 4AB', State: 'X', Country: 'United Kingdom', Experience_in_Years: '3' };
    useFake({ create: 'dup', record: full });
    const { create } = fresh();
    const out = await capture(() => create.createCandidate(caterer()));
    assert.deepEqual(out.value, { zohoId: 'Z-DUP-1', isDuplicate: true, enrichment: 'none' });
    assert.ok(out.log.includes('DUPLICATE_NO_GAPS ZOHO_ID=Z-DUP-1'));
    assert.deepEqual(zohoCalls('PUT')[0].body.data[0], { id: 'Z-DUP-1', CatererID: '123456' });
  });

  test('a duplicate in a protected status is never enriched', async () => {
    useFake({ create: 'dup', status: 'Complete', record: { Mobile: null, City: null } });
    const { create } = fresh();
    const out = await capture(() => create.createCandidate(caterer()));
    assert.deepEqual(out.value, { zohoId: 'Z-DUP-1', isDuplicate: true, enrichment: 'protected' });
    assert.ok(out.log.includes('DUPLICATE_PROTECTED ZOHO_ID=Z-DUP-1 status=Complete'));
    assert.deepEqual(zohoCalls('PUT').map(c => c.body.data[0]), [{ id: 'Z-DUP-1', CatererID: '123456' }]);
  });

  test('a duplicate whose existing record cannot be read makes no update and reports no gaps', async () => {
    useFake({ create: 'dup', fetchFails: true });
    const { create } = fresh();
    const out = await capture(() => create.createCandidate(caterer()));
    assert.equal(out.value.enrichment, 'none');
    assert.equal(zohoCalls('PUT').length, 0);
  });

  test('a rejected enrichment PUT logs a warning and falls back to the id backfill', async () => {
    useFake({ create: 'dup', putFails: true, record: { Mobile: null } });
    const { create } = fresh();
    const out = await capture(() => create.createCandidate(caterer()));
    assert.equal(out.value.enrichment, 'none');
    assert.ok(out.err.some(l => l.startsWith('ENRICH_WARN: PUT failed:')));
    assert.equal(zohoCalls('PUT').length, 2);
    assert.deepEqual(zohoCalls('PUT')[1].body.data[0], { id: 'Z-DUP-1', CatererID: '123456' });
  });

  test('Reed duplicates are backfilled with ReedID', async () => {
    useFake({ create: 'dup', record: { Mobile: 'x', Current_Job_Title: 'x', City: 'x', Zip_Code: 'x', State: 'x', Country: 'x', Experience_in_Years: 'x' } });
    const { create } = fresh();
    await capture(() => create.createCandidate(caterer({ CatererID: undefined, ReedID: '555' })));
    assert.deepEqual(zohoCalls('PUT')[0].body.data[0], { id: 'Z-DUP-1', ReedID: '555' });
  });

  test('buildEnrichmentPatch fills only empty Zoho fields and skips data-quality traps', async () => {
    const { create } = fresh();
    const out = await capture(() => {
      const patch = create.buildEnrichmentPatch(
        { Mobile: '0770', City: '', State: null, Current_Job_Title: '', Zip_Code: undefined, Country: 'United Kingdom' },
        { Mobile: 'new', City: 'Leeds', State: 'leeds', Current_Job_Title: 'LS1 4AB', Zip_Code: 'LS1 4AB', Country: 'X', Experience_in_Years: '' }
      );
      return patch;
    });
    assert.deepEqual(out.value, { City: 'Leeds', Zip_Code: 'LS1 4AB' });
    assert.ok(out.log.some(l => l.startsWith('ENRICH_SKIP: State="leeds" matches City="Leeds"')));
    assert.ok(out.log.some(l => l.startsWith('ENRICH_SKIP: Current_Job_Title="LS1 4AB" looks like a postcode')));
    assert.equal(create.buildEnrichmentPatch({ Mobile: 'a' }, { Mobile: 'b' }), null);
  });

  test('decodeHtmlEntities and normaliseCountry', () => {
    const { create } = fresh();
    assert.equal(create.decodeHtmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;'), 'a & b <c> "d" \'e\'');
    assert.equal(create.decodeHtmlEntities('&#65;&#x42;&nbsp;&unknown;'), 'AB &unknown;');
    assert.equal(create.normaliseCountry('uk'), 'United Kingdom');
    assert.equal(create.normaliseCountry(' GB '), 'United Kingdom');
    assert.equal(create.normaliseCountry('Great Britain'), 'United Kingdom');
    assert.equal(create.normaliseCountry('France '), 'France');
    assert.equal(create.normaliseCountry(''), 'United Kingdom');
  });
});

test.describe('zoho-attach-resume', () => {
  const cv = path.join(home, 'cv-1.pdf');
  test.before(() => fs.writeFileSync(cv, 'fake cv bytes'));

  test('attachOnce posts the file as a Resume attachment and returns the attachment id', async () => {
    useFake();
    const { attach } = fresh();
    const r = await attach.attachOnce('Z-1', cv);
    assert.equal(r.ok, true);
    assert.equal(r.alreadyExists, false);
    assert.equal(r.id, 'ATT-1');
    assert.equal(calls[0].path, '/recruit/v2/Candidates/Z-1/Attachments?attachments_category=Resume');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].body.file, '[file cv-1.pdf 13 bytes]');
  });

  test('"not allowed to attach more than one" means the resume is already there', async () => {
    useFake({ attach: 'exists' });
    const { attach } = fresh();
    const r = await attach.attachResume('Z-1', cv);
    assert.deepEqual({ ok: r.ok, alreadyExists: r.alreadyExists, id: r.id }, { ok: true, alreadyExists: true, id: null });
    assert.equal(calls.length, 1);
  });

  test('a non-throttle failure fails fast (one attempt)', async () => {
    useFake({ attach: 'fail' });
    const { attach } = fresh();
    const r = await attach.attachResume('Z-1', cv);
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.equal(calls.length, 1);
  });

  test('throttling is retried with backoff (4 attempts by default) and then reported', async () => {
    useFake({ attach: 'throttle' });
    const { attach } = fresh();
    assert.deepEqual([...attach.ATTACH_BACKOFFS_MS], [4000, 8000, 15000]);
    attach.ATTACH_BACKOFFS_MS.splice(0, 3, 1, 1, 1);
    const out = await capture(() => attach.attachResume('Z-1', cv));
    assert.equal(out.value.ok, false);
    assert.equal(calls.length, 4);
    assert.equal(out.err.length, 3);
    assert.match(out.err[0], /^\[attach\] zoho Z-1 throttled \(attempt 1\/4\) - retrying in 0\.001s$/);
    calls.length = 0;
    const capped = await capture(() => attach.attachResume('Z-1', cv, { maxAttempts: 2 }));
    assert.equal(capped.value.ok, false);
    assert.equal(calls.length, 2);
  });
});

test.describe('CLIs with a fake Zoho (child processes)', () => {
  const logFile = path.join(home, 'fake-calls.jsonl');
  const cli = (script, args, cfg = {}) => {
    fs.rmSync(logFile, { force: true });
    return H.run(script, args, {
      home, preload: [PRELOAD], env: { FAKE_SERVICES: JSON.stringify(cfg), FAKE_LOG: logFile },
    });
  };
  const logged = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const candFile = path.join(home, 'candidate-1.json');
  const cand = { First_Name: 'Fake', Last_Name: 'Person', Email: 'fake@example.test', Mobile: '07700900000', City: 'Leeds', Zip_Code: 'LS1 4AB', CatererID: '99', Search_Job_Title: 'Chef' };
  test.before(() => H.writeJson(candFile, cand));

  test('zoho-create-candidate <file>: ZOHO_ID=<id>, exit 0', () => {
    const r = cli('scripts/zoho-create-candidate.js', [candFile]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'ZOHO_ID=Z-NEW-1');
    assert.equal(logged().filter(c => c.method === 'POST').length, 1);
  });

  test('zoho-create-candidate --json <object>', () => {
    const r = cli('scripts/zoho-create-candidate.js', ['--json', JSON.stringify(cand)]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'ZOHO_ID=Z-NEW-1');
  });

  test('zoho-create-candidate: a duplicate prints DUPLICATE ZOHO_ID=<id> and exits 0', () => {
    const r = cli('scripts/zoho-create-candidate.js', [candFile], { create: 'dup', record: { Mobile: 'a', Current_Job_Title: 'a', City: 'a', Zip_Code: 'a', State: 'a', Country: 'a', Experience_in_Years: 'a' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DUPLICATE_NO_GAPS ZOHO_ID=Z-DUP-1/);
    assert.match(r.stdout, /^DUPLICATE ZOHO_ID=Z-DUP-1$/m);
  });

  test('zoho-create-candidate: a Zoho error exits 1 with the message on stderr', () => {
    const r = cli('scripts/zoho-create-candidate.js', [candFile], { create: 'error' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ERROR: MANDATORY_NOT_FOUND City missing/);
  });

  test('zoho-create-candidate: usage errors exit 1; --help exits 0', () => {
    assert.equal(cli('scripts/zoho-create-candidate.js', []).status, 1);
    const r = cli('scripts/zoho-create-candidate.js', [path.join(home, 'absent.json')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /File not found/);
    assert.equal(cli('scripts/zoho-create-candidate.js', ['--help']).status, 0);
  });

  test('zoho-attach-resume <id> <file>: ATTACHED, ALREADY_HAS_RESUME (both exit 0), error exits 1', () => {
    const cv = path.join(home, 'cv-cli.pdf');
    fs.writeFileSync(cv, 'fake');
    let r = cli('scripts/zoho-attach-resume.js', ['Z-9', cv]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Attaching cv-cli\.pdf \(0\.00MB\) to Zoho candidate Z-9\.\.\.$/m);
    assert.match(r.stdout, /^ATTACHED: attachment ID ATT-1$/m);
    r = cli('scripts/zoho-attach-resume.js', ['Z-9', cv], { attach: 'exists' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^ALREADY_HAS_RESUME: candidate Z-9 already has a Resume attached - skipping$/m);
    r = cli('scripts/zoho-attach-resume.js', ['Z-9', cv], { attach: 'fail' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ERROR \(HTTP 400\):/);
  });

  test('zoho-attach-resume: usage, missing file and files over 20MB exit 1', () => {
    assert.equal(cli('scripts/zoho-attach-resume.js', []).status, 1);
    let r = cli('scripts/zoho-attach-resume.js', ['Z-9', path.join(home, 'absent.pdf')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /File not found/);
    const big = path.join(home, 'big.pdf');
    fs.closeSync(fs.openSync(big, 'w'));
    fs.truncateSync(big, 21 * 1024 * 1024);
    r = cli('scripts/zoho-attach-resume.js', ['Z-9', big]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /File too large: 21\.0MB \(Zoho limit: 20MB\)/);
    assert.equal(logged().length, 0, 'nothing was uploaded');
    assert.equal(cli('scripts/zoho-attach-resume.js', ['--help']).status, 0);
  });
});
