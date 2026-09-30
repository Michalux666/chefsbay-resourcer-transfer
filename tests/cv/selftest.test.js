'use strict';
// Update C, finding F8 (part 1): the CV install canaries of docs/UPDATE-B.md were .txt files, which never touch the PDF or Word readers, so an instance where
// pdf-parse cannot load turned every PDF into "unreadable" (a pass) and was only noticed after ten CVs. `cv-review.js --self-test` builds a tiny invented
// PDF and Word file in memory, runs the real readers on them and prints one fixed line. No network, no key, no config, no file.
const { makeHome } = require('./helpers/home');
const home = makeHome('cv-selftest');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startFakeJev } = require('./helpers/fake-jev');
const cli = require('../../resourcer/scripts/cv-review');
const selftest = require('../../resourcer/scripts/lib/cv/selftest');
const extract = require('../../resourcer/scripts/lib/cv/extract');

let gw;
test.before(async () => { gw = await startFakeJev(); });
test.after(async () => { await gw.close(); home.cleanup(); });

let pdfParse = true;
try { require.resolve('pdf-parse'); } catch (e) { pdfParse = false; }
const readers = { skip: pdfParse ? false : 'pdf-parse is not installed here (the rehearsal machine has it)' };

function run(argv) {
  let out = '';
  let err = '';
  return cli.main(argv, { out: s => { out += s; }, err: s => { err += s; } }).then(code => ({ code, out, err }));
}

test('the invented files are real PDF and Word files: the magic bytes, and text the real adapter reads back', readers, async () => {
  const pdf = selftest.makePdf(selftest.LINES);
  const docx = selftest.makeDocx(selftest.LINES);
  assert.equal(pdf.slice(0, 5).toString('latin1'), '%PDF-');
  assert.equal(docx.slice(0, 2).toString('latin1'), 'PK');
  for (const [name, buf] of [['pdf', pdf], ['docx', docx]]) {
    const r = await extract.extractText(buf, name);
    assert.equal(r.ok, true, `${name}: ${r.reason}`);
    assert.match(r.text, /Canary Post/i);
    assert.ok(r.text.length >= 120, 'long enough to pass the readers\' floor');
  }
});

test('--self-test prints ONE fixed line and exits 0; it needs no key, no gateway, no criteria file and makes no request', readers, async () => {
  delete process.env.AI_GATEWAY_API_KEY;
  home.point(gw);
  delete process.env.AI_GATEWAY_API_KEY; // point() set it; the self-test must not need it
  home.removeConfig();
  const r = await run(['--self-test']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'CV_SELF_TEST_OK pdf docx\n');
  assert.equal(r.err, '', 'nothing on stderr');
  assert.equal(gw.stats().requests, 0, 'no request reached the gateway');
  assert.deepEqual(home.listFiles().filter(n => !/^(config)\//.test(n)), [], 'no file was written');
  assert.deepEqual(home.shadowRows(), []);
});

test('a reader that cannot read one of the files is a non-zero exit with a fixed line of reason codes (never text)', async () => {
  const fake = async (buf, name) => (name === 'pdf' ? { ok: false, text: '', textAlt: null, reason: 'error_parse_failed', source: 'vendor' } : { ok: true, text: 'Canary Post ...', textAlt: null, reason: null, source: 'vendor' });
  const r = await selftest.run({ extract: fake });
  assert.equal(r.ok, false);
  assert.equal(selftest.line(r), 'CV_SELF_TEST_FAILED pdf:error_parse_failed');
  const both = await selftest.run({ extract: async () => { throw new Error('the module could not be loaded: /secret/path'); } });
  assert.equal(both.ok, false);
  assert.equal(selftest.line(both), 'CV_SELF_TEST_FAILED pdf:error_reader_threw docx:error_reader_threw', 'the message of the error is never printed');
  const missing = await selftest.run({ extract: async () => ({ ok: true, text: 'a perfectly readable text that says nothing expected '.repeat(5), textAlt: null, reason: null, source: 'stub' }) });
  assert.equal(selftest.line(missing), 'CV_SELF_TEST_FAILED pdf:text_not_found docx:text_not_found', 'readable is not enough: the invented text must come back');
  // and the command maps it to exit 1
  const saved = selftest.run;
  selftest.run = async () => r;
  try {
    const c = await run(['--self-test']);
    assert.equal(c.code, 1);
    assert.equal(c.out, 'CV_SELF_TEST_FAILED pdf:error_parse_failed\n');
  } finally { selftest.run = saved; }
});

test('--self-test is in the usage text and is not mistaken for a value of another flag', async () => {
  const h = await run(['--help']);
  assert.match(h.err, /--self-test/);
  assert.match(h.err, /CV_SELF_TEST_OK pdf docx/);
  assert.equal(cli.parseArgs(['--self-test']).hasOwnProperty('self-test'), true);
  assert.equal(cli.parseArgs(['--job', 'Chef', '--self-test'])['self-test'], true);
});

test('the self-test source holds no real name, number or address: only invented canary text', () => {
  const s = fs.readFileSync(path.resolve(__dirname, '..', '..', 'resourcer', 'scripts', 'lib', 'cv', 'selftest.js'), 'utf8');
  assert.ok(!/@|https?:\/\/|\b0\d{10}\b/.test(s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/ .*/g, '').replace(/xmlns(:w)?="[^"]+"/g, '')), 'no e-mail, URL or telephone number (the XML namespaces of a Word file are not addresses)');
  assert.ok(selftest.LINES.every(l => /^[\x20-\x7e]+$/.test(l)));
});
