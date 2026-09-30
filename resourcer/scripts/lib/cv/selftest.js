'use strict';
// A no-network self-test of the CV readers: builds a tiny INVENTED PDF and a tiny INVENTED Word file in memory and runs the real extract
// adapter on both (the same code path a downloaded CV takes: magic-byte sniffing, pdf-parse, mammoth or the zip reader). It exists because the
// install canaries of docs/UPDATE-B.md were .txt files, which never touch the PDF or Word readers: an instance where pdf-parse cannot load
// turns every PDF into "unreadable" (a pass) and is only noticed after ten CVs. `node scripts/cv-review.js --self-test` prints one fixed line.
// No file is written, no network is used, no key is read, nothing real is involved.

const zlib = require('zlib');
const extract = require('./extract');

const BS = String.fromCharCode(92);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip file of {name, data} text entries (deflate). */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.from(e.data, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** @param {string[]} paragraphs */
function makeDocx(paragraphs) {
  const body = paragraphs.map(p => `<w:p><w:pPr/><w:r><w:t xml:space="preserve">${xmlEsc(p)}</w:t></w:r></w:p>`).join('');
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return makeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'word/document.xml', data: doc },
  ]);
}

/** @param {string[]} lines one text line each, top to bottom (at most about 50 lines fit on the page) */
function makePdf(lines) {
  const esc = s => s.split(BS).join(BS + BS).split('(').join(`${BS}(`).split(')').join(`${BS})`);
  const stream = lines.map((text, i) => `BT /F1 11 Tf 1 0 0 1 72 ${760 - i * 14} Tm (${esc(text)}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// Invented. Long enough to pass the readers' "too little text" floor (120 characters), and with a marker word the check looks for.
const LINES = [
  'Reader self test document',
  'Employment history',
  'Canary Post, Canary Test Ltd, Canary Town',
  'January 2020 to December 2021',
  'Invented duty lines that exist only to prove that the reader can open this file.',
  'A second invented line of plain text, so that the document is long enough to be read.',
  'Education: Canary Test Certificate',
];
const MARKER = /canary\s+post/i;

async function readOne(name, buffer, read) {
  try {
    const r = await read(buffer, name);
    if (!r.ok) return { name, ok: false, reason: r.reason || 'unreadable', source: r.source };
    if (!MARKER.test(r.text)) return { name, ok: false, reason: 'text_not_found', source: r.source };
    return { name, ok: true, reason: null, source: r.source };
  } catch (e) {
    return { name, ok: false, reason: 'error_reader_threw', source: null };
  }
}

/**
 * Builds the two files and runs the real readers on them.
 * @param {{extract?:Function}} [o]  extract: a replacement reader (tests only); the default is the real adapter
 * @returns {Promise<{ok:boolean, results:{name:string, ok:boolean, reason:string|null, source:string|null}[]}>} reasons are fixed codes, never text
 */
async function run(o) {
  const read = (o && o.extract) || extract.extractText;
  const results = [await readOne('pdf', makePdf(LINES), read), await readOne('docx', makeDocx(LINES), read)];
  return { ok: results.every(r => r.ok), results };
}

/** The one line the command prints: fixed text, reason codes only. */
function line(r) {
  return r.ok ? 'CV_SELF_TEST_OK pdf docx' : `CV_SELF_TEST_FAILED ${r.results.filter(x => !x.ok).map(x => `${x.name}:${x.reason}`).join(' ')}`;
}

module.exports = { run, line, makePdf, makeDocx, makeZip, LINES };
