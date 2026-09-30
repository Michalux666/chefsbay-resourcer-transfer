'use strict';
// Personal data left behind by the Caterer browser side: the browser's HTTP cache, and CV files under an extension nothing looks for.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

function setup(t, envExtra) {
  const sb = H.buildSandbox({ prefix: 'rb-hard-' });
  sb.activate(envExtra);
  t.after(() => sb.cleanup());
  sb.fake.warmLoggedIn();
  return { sb, fake: sb.fake };
}

test('in-page fetches of an unlock reply or a CV are told not to use the HTTP cache (no copy stays in the profile)', (t) => {
  const { sb } = setup(t);
  const bf = sb.load('caterer-browser-fetch.js');
  assert.match(bf.buildBinaryFetchJs('/x', 1000), /credentials:'include',cache:'no-store',headers:/);
  assert.match(bf.buildTextFetchJs('/x', 1000), /credentials:'include',cache:'no-store',headers:/);
});

test('RESOURCER_FETCH_CACHE=default restores the plain request', (t) => {
  const { sb } = setup(t, { RESOURCER_FETCH_CACHE: 'default' });
  const bf = sb.load('caterer-browser-fetch.js');
  assert.ok(!bf.buildBinaryFetchJs('/x', 1000).includes('no-store'));
  assert.match(bf.buildTextFetchJs('/x', 1000), /credentials:'include',headers:/);
});

test('a CV labelled with an unsupported extension is saved under one Phase 2 can find (cv-N.odt used to be written and never attached)', async (t) => {
  const { sb, fake } = setup(t);
  const out = path.join(sb.home, 'downloads');
  const big = crypto.randomBytes(300).toString('base64');
  const cases = [
    [{ 'content-disposition': 'attachment; filename="cv.odt"', 'content-type': 'application/vnd.oasis.opendocument.text' }, '.doc'],
    [{ 'content-disposition': 'attachment; filename="cv.wps"' }, '.pdf'],
    [{ 'content-disposition': 'attachment; filename="cv.pages"', 'content-type': 'application/rtf' }, '.rtf'],
    [{ 'content-disposition': 'attachment; filename="cv.RTF"' }, '.rtf'],
  ];
  let n = 100;
  for (const [headers, want] of cases) {
    n++;
    fake.scenario({ site: { fetch: [{ match: 'CandidateDownloadCV', status: 200, headers, bodyBase64: big }] } });
    const r = sb.run('caterer-download-cv.js', ['E', 'A', out, String(n)]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(out, `cv-${n}${want}`)), `${JSON.stringify(headers)} -> cv-${n}${want}; got ${fs.readdirSync(out).join(',')}`);
  }
  const dl = sb.load('caterer-download-cv.js');
  assert.deepEqual(dl.guessExtension('', 'attachment; filename="cv.odt"'), { ext: '.pdf', filename: 'cv.odt' }, 'the original name is still reported for the log');
});
