'use strict';
// fill-mandatory-fields.js PDF text extraction. pdf-parse v2 exports a PDFParse class (not a function), so the
// legacy call form threw inside a try/catch and every .pdf CV silently yielded empty text.
// The PDF is generated here (no fixtures, fake person); the suite skips cleanly when pdf-parse is not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/home');

const home = H.makeHome('pdfcv');
process.env.RESOURCER_HOME = home;
process.env.HERMES_HOME = home;
process.env.RESOURCER_ENV_FILE = path.join(home, 'no-such.env');
require('./helpers/netguard');

const SCRIPT = path.join(H.SCRIPTS, 'fill-mandatory-fields.js');

function resolvePdfParse() {
  try { return require.resolve('pdf-parse', { paths: [H.SCRIPTS, H.RES] }); } catch { return null; }
}
const PDF_PARSE = resolvePdfParse();
const skip = PDF_PARSE ? false : 'pdf-parse is not installed (run npm install in resourcer/)';

/** A one-page PDF, Helvetica, one text line per entry. Lines must not contain parentheses or backslashes. */
function makePdf(lines) {
  for (const l of lines) assert.ok(!/[()]/.test(l) && !l.includes(String.fromCharCode(92)), 'unescaped test text only');
  const ops = ['BT', '/F1 12 Tf', '14 TL', '72 720 Td'];
  for (const l of lines) ops.push(`(${l}) Tj`, 'T*');
  ops.push('ET');
  const stream = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const dir = path.join(home, 'pdfs');
fs.mkdirSync(dir, { recursive: true });
let n = 0;
const writePdf = (bytes, name) => { const p = path.join(dir, name || `cv-${n++}.pdf`); fs.writeFileSync(p, bytes); return p; };
const candidate = (obj) => { const p = path.join(dir, `candidate-${n++}.json`); H.writeJson(p, obj); return p; };
const CV_LINES = ['Jane Sample', 'Commis Chef', 'Mobile 07700 900123', 'jane.sample@mail.invalid'];

test.describe('fill-mandatory-fields PDF extraction', { skip }, () => {
  const f = require(SCRIPT);

  test('extractCvText returns the text of a real PDF', async () => {
    const text = await f.extractCvText(writePdf(makePdf(CV_LINES)));
    assert.match(text, /Jane Sample/);
    assert.match(text, /Commis Chef/);
    assert.match(text, /07700 900123/);
    assert.match(text, /jane\.sample@mail\.invalid/);
  });

  test('a PDF CV recovers name, mobile and e-mail instead of the placeholders', async () => {
    const p = candidate({ First_Name: '', Last_Name: '', Email: '', Mobile: '', City: 'Leeds', Zip_Code: 'LS1 1AA', CatererID: '424242' });
    const r = await f.fillMandatoryFields(p, writePdf(makePdf(CV_LINES)));
    assert.deepEqual(r.stillMissing, []);
    const doc = H.readJson(p);
    assert.equal(doc.First_Name, 'Jane');
    assert.equal(doc.Last_Name, 'Sample');
    assert.equal(doc.Mobile, '07700900123');
    assert.equal(doc.Email, 'jane.sample@mail.invalid');
    assert.notEqual(doc.Mobile, '07777777777');
    assert.notEqual(doc.First_Name, 'Candidate');
  });

  test('the extension is matched case-insensitively', async () => {
    const text = await f.extractCvText(writePdf(makePdf(CV_LINES), 'CV-UPPER.PDF'));
    assert.match(text, /Jane Sample/);
  });

  test('a corrupt, truncated or empty PDF yields empty text and does not throw', async () => {
    assert.equal(await f.extractCvText(writePdf(Buffer.from('not a pdf'))), '');
    assert.equal(await f.extractCvText(writePdf(Buffer.alloc(0))), '');
    const good = makePdf(CV_LINES);
    assert.equal(await f.extractCvText(writePdf(good.subarray(0, 60))), '');
  });

  test('a corrupt PDF falls back to the placeholders exactly like an unreadable CV', async () => {
    const p = candidate({ First_Name: '', Last_Name: '', Email: 'a@b.test', Mobile: '', City: 'Leeds', Zip_Code: 'LS1 1AA', CatererID: '7' });
    const r = await f.fillMandatoryFields(p, writePdf(Buffer.from('%PDF-1.4 garbage')));
    assert.deepEqual(r.stillMissing, []);
    const doc = H.readJson(p);
    assert.equal(doc.Mobile, '07777777777');
    assert.equal(doc.First_Name, 'Candidate');
    assert.equal(doc.Last_Name, '7');
  });

  test('the parser is destroyed after success and after a failed parse', async () => {
    const real = require(PDF_PARSE);
    const entry = require.cache[PDF_PARSE];
    const calls = [];
    class FakeParser {
      constructor(opts) { calls.push(['new', Buffer.isBuffer(opts.data) || opts.data instanceof Uint8Array]); this.fail = opts.data.length === 3; }
      async getText() { calls.push(['getText']); if (this.fail) throw new Error('boom'); return { text: 'Ann Fake\n' }; }
      async destroy() { calls.push(['destroy']); }
    }
    entry.exports = { PDFParse: FakeParser };
    try {
      assert.equal(await f.extractCvText(writePdf(Buffer.from('abcd'))), 'Ann Fake\n');
      assert.equal(await f.extractCvText(writePdf(Buffer.from('abc'))), '');
    } finally {
      entry.exports = real;
    }
    assert.deepEqual(calls.map(c => c[0]), ['new', 'getText', 'destroy', 'new', 'getText', 'destroy']);
    assert.equal(calls[0][1], true, 'the file bytes are passed as data');
  });

  test('the module is the v2 class API, not a callable function', () => {
    const lib = require(PDF_PARSE);
    assert.equal(typeof lib, 'object');
    assert.equal(typeof lib.PDFParse, 'function');
  });

  test('CLI on a PDF CV prints field names only, never the recovered values', () => {
    const p = candidate({ First_Name: '', Last_Name: '', Email: '', Mobile: '', City: 'Leeds', Zip_Code: 'LS1 1AA', CatererID: '9' });
    const r = H.run('scripts/fill-mandatory-fields.js', [p, writePdf(makePdf(CV_LINES))], { home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Recovered: .*Mobile/);
    assert.ok(!r.stdout.includes('07700'), 'no phone number on stdout');
    assert.ok(!r.stdout.includes('mail.invalid'), 'no e-mail address on stdout');
    assert.equal(H.readJson(p).Mobile, '07700900123');
  });
});

test('the source uses the class API', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /const \{ PDFParse \} = require\('pdf-parse'\)/);
  assert.match(src, /new PDFParse\(\{ data:/);
  assert.match(src, /\.getText\(\)/);
  assert.match(src, /\.destroy\(\)/);
  assert.ok(!/await pdfParse\(/.test(src), 'the v1 call form is gone');
});
