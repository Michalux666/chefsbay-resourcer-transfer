'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

function setup(t, envExtra) {
  const sb = H.buildSandbox({ prefix: 'rb-fetch-' });
  sb.activate(envExtra);
  t.after(() => sb.cleanup());
  sb.fake.warmLoggedIn();
  return { sb, fake: sb.fake };
}

const UNLOCK_HTML = [
  '<div class="flex-row person"><span>Jane Q Example</span></div>',
  '<a href="mailto:jane.example@example.invalid">mail</a>',
  '<div id="candidate-details-phone-4711">07000 000000</div>',
  '<a data-href="/CandidateSearch/CandidateDownloadCV.aspx?candidateId=ENC%2BID%3D%3D&CandidateSearchAuditId=AUD%2FID%3D%3D&x=1">cv</a>',
  '<div class="candidate-identifier-summary"><span>Sous Chef</span> | Sheffield</div>',
].join('\n');
const UNLOCK_BODY = JSON.stringify({ Instructions: [{ Content: { Contents: [UNLOCK_HTML] } }] });

function unlockFixture(extra) {
  return { match: 'UnlockCandidate', status: 200, body: UNLOCK_BODY, ...(extra || {}) };
}

test('unlock success: parsed profile, sent once, exactly one JSON line on stdout, exit 0', async (t) => {
  const { sb, fake } = setup(t);
  fake.scenario({ site: { fetch: [unlockFixture()] } });
  const r = sb.run('caterer-unlock.js', ['4711', 'CD=value+with/odd chars==']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const j = JSON.parse(lines[0]);
  assert.deepEqual(j, {
    success: true, name: 'Jane Q Example', firstName: 'Jane', lastName: 'Q Example', email: 'jane.example@example.invalid',
    phone: '07000 000000', cvUrl: '/CandidateSearch/CandidateDownloadCV.aspx?candidateId=ENC%2BID%3D%3D&CandidateSearchAuditId=AUD%2FID%3D%3D&x=1',
    encId: 'ENC+ID==', auditId: 'AUD/ID==', jobTitle: 'Sous Chef',
  });
  assert.equal(fake.counters()['fetch:UnlockCandidate'], 1);
  const script = fake.calls('eval')[0].script;
  assert.ok(script.includes('/CandidateSearchWebMvc/CandidateSearch/UnlockCandidate?CandidateData=CD%3Dvalue%2Bwith%2Fodd+chars%3D%3D'), 'candidate data is URL-encoded and JSON-string embedded');
  assert.ok(script.includes("credentials:'include'"));
  assert.equal(fake.calls('open').length, 0, 'the unlock path never navigates (it would lose the paginated search)');
});

test('unlock failures keep their legacy shapes and exit 1', async (t) => {
  const { sb, fake } = setup(t);
  const cases = [
    [unlockFixture({ status: 401, body: '' }), /^\{"success":false,"error":"HTTP 401"\}$/],
    [unlockFixture({ body: 'not json' }), /"error":"Empty response - session may have expired"/],
    [unlockFixture({ body: JSON.stringify({ Instructions: [] }) }), /"error":"Empty response - session may have expired"/],
    [unlockFixture({ body: JSON.stringify({ Instructions: [{ Content: { Contents: ['<p>nothing useful</p>'] } }] }) }), /"error":"Could not extract profile data - unlock may have failed or used a credit already"/],
    [unlockFixture({ reject: 'Failed to fetch' }), /"error":"browser-fetch: Failed to fetch"/],
  ];
  for (const [fx, re] of cases) {
    fake.scenario({ site: { fetch: [fx] } });
    const r = sb.run('caterer-unlock.js', ['1', 'x']);
    assert.equal(r.status, 1);
    assert.match(r.stdout.trim(), re);
    assert.equal(r.stdout.trim().split('\n').length, 1);
  }
  const usage = sb.run('caterer-unlock.js', ['only-one-arg']);
  assert.equal(usage.status, 1);
  assert.match(usage.stdout, /Usage: caterer-unlock\.js/);
});

test('slow unlock: the in-page fetch is aborted before the CLI read timeout, and the request went out once', async (t) => {
  const { sb, fake } = setup(t, { RESOURCER_AB_IPC_READ_MS: '8000' });
  fake.scenario({ site: { fetch: [unlockFixture({ delayMs: 4500 })] } });
  const t0 = Date.now();
  const r = sb.run('caterer-unlock.js', ['1', 'x'], { env: { RESOURCER_AB_IPC_READ_MS: '8000', FAKE_AB_READ_TIMEOUT_MS: '8000' } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /"error":"browser-fetch: in-page fetch timed out"/);
  assert.ok(Date.now() - t0 < 6500, 'failed fast instead of waiting for the slow response');
  assert.equal(fake.counters()['fetch:UnlockCandidate'], 1, 'sent exactly once');
  assert.equal(fake.events('resend').length, 0);
});

test('a wedged browser: the wrapper timeout is reported as not re-sent, never retried', async (t) => {
  const { sb, fake } = setup(t);
  fake.scenario({ rules: [{ when: { cmd: 'eval' }, do: { hangMs: 60000 } }] });
  const r = sb.run('caterer-unlock.js', ['1', 'x']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /unlock timed out \(not re-sent, to avoid a duplicate unlock\)/);
  assert.equal(fake.calls('eval').length, 1, 'one eval invocation, no retry loop in our code');
});

test('CV download: binary round trip, atomic 600 file, CV_FILE marker, no temp leftovers', async (t) => {
  const { sb, fake } = setup(t);
  const bytes = crypto.randomBytes(5000);
  fake.scenario({ site: { fetch: [{ match: 'CandidateDownloadCV', status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Some CV.PDF"' }, bodyBase64: bytes.toString('base64') }] } });
  const out = path.join(sb.home, 'downloads');
  const r = sb.run('caterer-download-cv.js', ['ENC+ID==', 'AUD/ID==', out, '4711']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const file = path.join(out, 'cv-4711.pdf');
  assert.match(r.stdout, new RegExp('CV_FILE=' + file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(fs.readFileSync(file).equals(bytes), 'bytes identical after base64 through the browser');
  assert.deepEqual(fs.readdirSync(out), ['cv-4711.pdf']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const script = fake.calls('eval').pop().script;
  assert.ok(script.includes('candidateId=ENC%2BID%3D%3D&CandidateSearchAuditId=AUD%2FID%3D%3D&PagePosition=1&PageNumber=1&PageSize=10'));
});

test('CV download: extension rules, tiny bodies and HTTP errors fail with exit 1 and write nothing', async (t) => {
  const { sb, fake } = setup(t);
  const out = path.join(sb.home, 'downloads');
  const big = crypto.randomBytes(300).toString('base64');
  const ext = [
    [{ 'content-type': 'application/msword' }, '.doc'],
    [{ 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, '.doc'],
    [{ 'content-type': 'application/rtf' }, '.rtf'],
    [{ 'content-type': 'text/plain' }, '.txt'],
    [{}, '.pdf'],
    [{ 'content-disposition': "attachment; filename=cv.DOCX" }, '.docx'],
  ];
  let n = 0;
  for (const [headers, want] of ext) {
    n++;
    fake.scenario({ site: { fetch: [{ match: 'CandidateDownloadCV', status: 200, headers, bodyBase64: big }] } });
    const r = sb.run('caterer-download-cv.js', ['E', 'A', out, String(n)]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(out, `cv-${n}${want}`)), `${JSON.stringify(headers)} -> ${want}`);
  }
  const before = fs.readdirSync(out).length;
  fake.scenario({ site: { fetch: [{ match: 'CandidateDownloadCV', status: 200, headers: { 'content-type': 'text/html' }, body: '<html>error</html>' }] } });
  let r = sb.run('caterer-download-cv.js', ['E', 'A', out, '99']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /too small/);
  fake.scenario({ site: { fetch: [{ match: 'CandidateDownloadCV', status: 500, body: 'x' }] } });
  r = sb.run('caterer-download-cv.js', ['E', 'A', out, '98']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /HTTP 500/);
  fake.scenario({ site: { fetch: [{ match: 'CandidateDownloadCV', reject: 'net::ERR_FAILED' }] } });
  r = sb.run('caterer-download-cv.js', ['E', 'A', out, '97']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /browser-fetch: net::ERR_FAILED/);
  assert.equal(fs.readdirSync(out).length, before, 'nothing written on failure');
  assert.equal(sb.run('caterer-download-cv.js', []).status, 1);
});

test('CV download re-anchors the tab on the recruiter origin only when it is elsewhere', async (t) => {
  const { sb, fake } = setup(t);
  const out = path.join(sb.home, 'downloads');
  fake.scenario({ site: { fetch: [{ match: 'CandidateDownloadCV', status: 200, headers: { 'content-type': 'application/pdf' }, bodyBase64: crypto.randomBytes(200).toString('base64') }] } });
  let r = sb.run('caterer-download-cv.js', ['E', 'A', out, '1']);
  assert.equal(r.status, 0);
  assert.equal(fake.calls('open').length, 0, 'already on recruiter.caterer.com: no navigation');
  fake.browser({ page: 'generic', url: 'https://example.invalid/somewhere' });
  fake.clearCalls();
  r = sb.run('caterer-download-cv.js', ['E', 'A', out, '2']);
  assert.equal(r.status, 0);
  assert.deepEqual(fake.trail().map((x) => x.split(' ')[0]).slice(0, 4), ['get', 'open', 'wait', 'eval']);
  assert.equal(fake.calls('open')[0].argv[3], 'https://recruiter.caterer.com/Home/1368655');
});

test('a 3 MB CV goes through the browser output path intact', async (t) => {
  const { sb, fake } = setup(t);
  const bytes = crypto.randomBytes(3 * 1024 * 1024);
  fake.scenario({ site: { fetch: [{ match: 'CandidateDownloadCV', status: 200, headers: { 'content-type': 'application/pdf' }, bodyBase64: bytes.toString('base64') }] } });
  const out = path.join(sb.home, 'downloads');
  const r = sb.run('caterer-download-cv.js', ['E', 'A', out, '7'], { timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.readFileSync(path.join(out, 'cv-7.pdf')).equals(bytes));
});

test('the in-page scripts carry an abort timer and a JSON-embedded URL', (t) => {
  const { sb } = setup(t);
  const bf = sb.load('caterer-browser-fetch.js');
  const js = bf.buildTextFetchJs('https://recruiter.caterer.com/a?b="c"&d=\\e', 1234);
  assert.ok(js.includes('AbortController'));
  assert.ok(js.includes('ac.abort();},1234)'));
  assert.ok(js.includes(JSON.stringify('https://recruiter.caterer.com/a?b="c"&d=\\e')));
  const bjs = bf.buildBinaryFetchJs('https://x/', 99);
  assert.ok(bjs.includes('btoa(bin)') && bjs.includes('signal:ac.signal'));
});

test('the candidate id can never escape the output directory', async (t) => {
  const { sb, fake } = setup(t);
  fake.scenario({ site: { fetch: [{ match: 'CandidateDownloadCV', status: 200, headers: { 'content-type': 'application/pdf' }, bodyBase64: crypto.randomBytes(200).toString('base64') }] } });
  const out = path.join(sb.home, 'downloads');
  const r = sb.run('caterer-download-cv.js', ['E', 'A', out, '../../evil/x']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(out), ['cv-______evil_x.pdf']);
  assert.ok(!fs.existsSync(path.join(sb.home, 'evil')));
});

test('every CLI answers --help with exit 0 and touches no browser', async (t) => {
  const { sb, fake } = setup(t);
  for (const s of ['caterer-unlock.js', 'caterer-download-cv.js', 'caterer-check-session.js', 'caterer-get-credits.js', 'caterer-login.js', 'caterer-preflight.js']) {
    const r = sb.run(s, ['--help']);
    assert.equal(r.status, 0, s + ': ' + r.stderr);
    assert.match(r.stdout, /Usage/, s);
  }
  assert.equal(fake.calls().length, 0);
});
