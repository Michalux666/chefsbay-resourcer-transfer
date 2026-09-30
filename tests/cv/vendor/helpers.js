// Ported from cv-corpus/tests/helpers.js by tools/vendor-tests.js; only mechanical edits, see that tool.
'use strict';
// Test helpers: build tiny SYNTHETIC files (zip / docx / pdf / rtf) in memory. No real CV data is ever used in tests.

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: [{ name, data:Buffer|string, method?: 0|8 }]
function makeZip(entries, opts = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const method = e.method === 0 ? 0 : 8;
    const comp = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const flags = e.encrypted ? 1 : 0;
    const declaredSize = e.lieSize !== undefined ? e.lieSize : raw.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(declaredSize, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(declaredSize, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  void opts;
  return Buffer.concat([...locals, cd, end]);
}

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// blocks: array of strings (paragraphs) | { bullet: 'text' } | { table: [[cell, cell], ...] } | { textbox: 'text' }
function makeDocx(blocks) {
  const para = (text, bullet) => `<w:p>${bullet ? '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>' : '<w:pPr/>'}<w:r><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
  let body = '';
  for (const b of blocks) {
    if (typeof b === 'string') body += para(b, false);
    else if (b.bullet !== undefined) body += para(b.bullet, true);
    else if (b.table) {
      body += '<w:tbl>';
      for (const row of b.table) body += '<w:tr>' + row.map((c) => `<w:tc>${para(c, false)}</w:tc>`).join('') + '</w:tr>';
      body += '</w:tbl>';
    } else if (b.textbox !== undefined) {
      // a text box comes with a fallback copy that must not be counted twice
      body += `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent>${para(b.textbox, false)}</w:txbxContent></wps:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><v:textbox><w:txbxContent>${para(b.textbox, false)}</w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`;
    }
  }
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return makeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'word/document.xml', data: doc },
  ]);
}

// Text PDF: lines = [{ x, y, text }] (points, origin bottom-left) or an array of strings (auto layout, 14pt leading)
function makePdf(lines, opts = {}) {
  const items = lines.map((l, i) => (typeof l === 'string' ? { x: 72, y: 760 - i * 14, text: l } : l));
  const esc = (s) => s.replace(/\u005c/g, '\u005c\u005c').replace(/\(/g, '\u005c(').replace(/\)/g, '\u005c)');
  const stream = items.map((it) => `BT /F1 11 Tf 1 0 0 1 ${it.x} ${it.y} Tm (${esc(it.text)}) Tj ET`).join('\n');
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  objs.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  void opts;
  return Buffer.from(out, 'latin1');
}

function makeRtf(paragraphs) {
  const body = paragraphs.map((p) => p.replace(/\u005c/g, '\u005c\u005c').replace(/[{}]/g, '\u005c$&') + '\u005cpar').join('\n');
  return Buffer.from(`{\u005crtf1\u005cansi\u005cdeff0{\u005cfonttbl{\u005cf0 Arial;}}{\u005ccolortbl;\u005cred0\u005cgreen0\u005cblue0;}\u005cf0\u005cfs22 ${body}}`, 'latin1');
}

module.exports = { crc32, makeZip, makeDocx, makePdf, makeRtf, xmlEsc };
