// Vendored from cv-corpus/lib/text-extract.js (source sha256 5cc20c1b596f) by tools/vendor-corpus.js; only mechanical edits, see that tool.
'use strict';
// CV text extraction: PDF (text-based), DOCX, RTF, plain text.
//
// Design rules
//  - The file type is decided from the magic bytes, never from the extension (extension is only a hint that is
//    reported when it disagrees).
//  - Nothing is guessed: scanned/empty PDFs, legacy binary .doc, encrypted files, oversized files and zip bombs are
//    reported with a status and a reason code, and NO text is returned for them.
//  - Hard limits: file size, pages, decoded characters, zip entries / inflated size (real guard, not header trust),
//    and a wall-clock timeout. For a timeout that can actually stop CPU-bound parsing use createExtractorPool(),
//    which runs the parsers in worker threads that are terminated on timeout.
//  - No text from a CV is ever put into an error message or reason code.
//
// Result shape: { status, reason, fileType, extHint, extMismatch, pages, text, chars }
//   status: 'ok' | 'scanned' | 'empty' | 'unsupported' | 'rejected' | 'error'
//   reason (when status != 'ok'): short fixed code such as 'doc_binary', 'too_large', 'zip_bomb', 'timeout',
//   'encrypted', 'no_text_layer', 'parse_failed'.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { layoutPage } = require('./pdf-layout');

const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 12 * 1024 * 1024,       // refuse files larger than this
  maxPages: 10,                     // PDF pages read (a CV longer than this is truncated, flagged pagesTruncated)
  maxChars: 250000,                 // decoded text cap
  timeoutMs: 25000,                 // wall clock per file
  maxZipEntries: 2000,
  maxXmlBytes: 32 * 1024 * 1024,    // inflated size cap for word/document.xml
  maxZipRatio: 400,                 // compressed:inflated ratio that is treated as a bomb
  minTextChars: 120,                // below this a PDF is 'scanned' (image only) and a DOCX 'empty'
});


// ---------------------------------------------------------------------------
// Module resolution (explicit path fallback so the code is usable both here and in production)

let pdfParseModule = null;
function loadPdfParse() {
  if (pdfParseModule) return pdfParseModule;
  const candidates = [];
  if (process.env.CV_PDF_PARSE_DIR) candidates.push(process.env.CV_PDF_PARSE_DIR);
  candidates.push('pdf-parse');
  let lastErr = null;
  for (const c of candidates) {
    try {
      const m = require(c);
      if (m && typeof m.PDFParse === 'function') { pdfParseModule = m; return m; }
    } catch (e) { lastErr = e; }
  }
  const err = new Error('pdf-parse (v2, PDFParse class) is not available');
  err.code = 'E_NO_PDF_PARSE';
  err.cause = lastErr;
  throw err;
}

// ---------------------------------------------------------------------------
// Type sniffing

function sniffType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return 'empty';
  const head = buf.subarray(0, 1024).toString('latin1');
  if (head.includes('%PDF-')) return 'pdf';               // the header may be preceded by a few junk bytes
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)) return 'zip';
  if (buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0 && buf[4] === 0xa1 && buf[5] === 0xb1) return 'doc_binary';
  if (/^\s*\{\u005crtf/i.test(head)) return 'rtf';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image';
  if (/^\s*<(!doctype html|html|\?xml)/i.test(head)) return 'html';
  // plain text: no NULs in the first 4 KB (UTF-16 with BOM is allowed) and mostly printable
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return 'txt';
  const sample = buf.subarray(0, 4096);
  let bad = 0;
  for (const b of sample) if (b === 0 || (b < 9) || (b > 13 && b < 32)) bad += 1;
  if (bad === 0 || bad / sample.length < 0.01) return 'txt';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Text normalisation shared by every extractor

const PRIVATE_BULLETS = /[\uF0A7\uF0B7\uF0D8\uF076\uF0FC\uF02D\uF0A8]/g;

function normaliseText(raw, maxChars) {
  let t = String(raw);
  if (t.length > maxChars) t = t.slice(0, maxChars);
  t = t.replace(/\r\n?/g, '\n');
  t = t.replace(/\u00ad/g, '');                                   // soft hyphen
  t = t.replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, '');          // zero width
  t = t.replace(PRIVATE_BULLETS, '\u2022');                        // Symbol/Wingdings bullets
  t = t.replace(/[\uE000-\uF8FF]/g, ' ');                          // remaining private use (icon fonts)
  t = t.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ');
  t = t.replace(/\ufb01/g, 'fi').replace(/\ufb02/g, 'fl').replace(/\ufb00/g, 'ff').replace(/\ufb03/g, 'ffi').replace(/\ufb04/g, 'ffl');
  t = t.replace(/[\u2018\u2019\u201a\u2032]/g, "'").replace(/[\u201c\u201d\u201e\u2033]/g, '"');
  t = t.replace(/[\u2013\u2014\u2212\u2015]/g, '-');
  // control characters other than \n \t \f
  t = t.replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/g, ' ');
  const lines = t.split('\n').map((l) => l.replace(/[ ]{2,}/g, '  ').replace(/[ \t]+$/g, '').replace(/^[ ]+/g, ''));
  const out = [];
  let blank = 0;
  for (const l of lines) {
    if (l.trim() === '') { blank += 1; if (blank <= 1) out.push(''); } else { blank = 0; out.push(l); }
  }
  return out.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Plain text

function decodePlainText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const sw = Buffer.from(buf.subarray(2));
    sw.swap16();
    return sw.toString('utf16le');
  }
  const body = (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) ? buf.subarray(3) : buf;
  const utf8 = body.toString('utf8');
  if (!utf8.includes('\ufffd')) return utf8;
  return body.toString('latin1'); // Windows-1252-ish legacy files; latin1 is a safe superset for letters
}

// ---------------------------------------------------------------------------
// RTF (control-word stripper; handles groups to skip, \par, \tab, \'hh, \uN)

const RTF_SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'headerl', 'headerr', 'headerf',
  'footerl', 'footerr', 'footerf', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'generator', 'listtable',
  'listoverridetable', 'rsidtbl', 'revtbl', 'xmlnstbl', 'fldinst', 'bkmkstart', 'bkmkend', 'shpinst', 'private', 'wgrffmtfilter',
  'pgptbl', 'mmathPr', 'nonshppict', 'blipuid',
]);

function rtfToText(src, maxChars) {
  const s = String(src);
  const out = [];
  let outLen = 0;
  const stack = [];
  let skipDepth = -1;    // stack depth at which a skipped destination started
  let ucSkip = 1;        // \ucN
  let pendingSkip = 0;   // chars to skip after \uN
  let i = 0;
  const n = s.length;
  let cpBytes = [];      // pending \'hh bytes (windows-1252 assumed)
  const flushBytes = () => {
    if (cpBytes.length) { out.push(Buffer.from(cpBytes).toString('latin1')); outLen += cpBytes.length; cpBytes = []; }
  };
  const emit = (str) => { if (skipDepth < 0) { flushBytes(); out.push(str); outLen += str.length; } };
  while (i < n && outLen < maxChars) {
    const ch = s[i];
    if (ch === '{') { stack.push(ucSkip); i += 1; continue; }
    if (ch === '}') {
      if (skipDepth >= 0 && stack.length <= skipDepth) skipDepth = -1;
      ucSkip = stack.length ? stack.pop() : 1;
      i += 1;
      continue;
    }
    if (ch === '\u005c') {
      const nx = s[i + 1];
      if (nx === undefined) break;
      if (nx === '\u005c' || nx === '{' || nx === '}') { if (pendingSkip > 0) pendingSkip -= 1; else emit(nx); i += 2; continue; }
      if (nx === '\n' || nx === '\r') { emit('\n'); i += 2; continue; }
      if (nx === '~') { emit(' '); i += 2; continue; }
      if (nx === '_' || nx === '-') { emit(nx === '_' ? '-' : ''); i += 2; continue; }
      if (nx === '*') {
        // ignorable destination: skip the whole group
        if (skipDepth < 0) skipDepth = stack.length;
        i += 2;
        continue;
      }
      if (nx === "'") {
        const hex = s.substr(i + 2, 2);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          if (pendingSkip > 0) pendingSkip -= 1;
          else if (skipDepth < 0) cpBytes.push(parseInt(hex, 16));
          i += 4;
          continue;
        }
        i += 2;
        continue;
      }
      const m = /^\u005c([a-zA-Z]+)(-?\d+)? ?/.exec(s.slice(i, i + 40));
      if (!m) { i += 2; continue; }
      i += m[0].length;
      const word = m[1];
      const param = m[2] === undefined ? null : parseInt(m[2], 10);
      if (RTF_SKIP_DESTINATIONS.has(word)) { if (skipDepth < 0) skipDepth = stack.length; continue; }
      if (skipDepth >= 0) continue;
      switch (word) {
        case 'par': case 'line': case 'sect': case 'page': emit('\n'); break;
        case 'row': emit('\n'); break;
        case 'cell': case 'tab': emit('\t'); break;
        case 'bullet': emit('\u2022'); break;
        case 'endash': case 'emdash': emit('-'); break;
        case 'lquote': case 'rquote': emit("'"); break;
        case 'ldblquote': case 'rdblquote': emit('"'); break;
        case 'uc': ucSkip = param === null ? 1 : param; break;
        case 'u': {
          if (param !== null) {
            const cp = param < 0 ? param + 65536 : param;
            if (pendingSkip > 0) pendingSkip -= 1;
            emit(String.fromCharCode(cp));
            pendingSkip = ucSkip;
          }
          break;
        }
        default: break;
      }
      continue;
    }
    if (ch === '\r' || ch === '\n') { i += 1; continue; }
    if (pendingSkip > 0) { pendingSkip -= 1; i += 1; continue; }
    if (skipDepth < 0) emit(ch);
    i += 1;
  }
  flushBytes();
  return out.join('');
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader (central directory, stored/deflate only) with a real inflate cap

class ZipReject extends Error {
  constructor(code) { super(code); this.zipCode = code; }
}

function readZipEntries(buf, limits) {
  const min = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipReject('zip_no_directory');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) throw new ZipReject('zip64');
  if (total > limits.maxZipEntries) throw new ZipReject('zip_too_many_entries');
  if (cdOff + cdSize > buf.length) throw new ZipReject('zip_truncated');
  const entries = new Map();
  let p = cdOff;
  let declaredTotal = 0;
  for (let k = 0; k < total; k += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipReject('zip_bad_directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    declaredTotal += size;
    entries.set(name, { flags, method, compSize, size, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  // header-declared sizes are checked here, and the inflate cap below is the real guard
  if (declaredTotal > limits.maxXmlBytes * 8) throw new ZipReject('zip_bomb');
  return entries;
}

function readZipEntry(buf, e, limits) {
  if (e.flags & 1) throw new ZipReject('encrypted');
  if (e.size > limits.maxXmlBytes) throw new ZipReject('zip_bomb');
  if (buf.length < e.localOff + 30 || buf.readUInt32LE(e.localOff) !== 0x04034b50) throw new ZipReject('zip_bad_local_header');
  const nameLen = buf.readUInt16LE(e.localOff + 26);
  const extraLen = buf.readUInt16LE(e.localOff + 28);
  const start = e.localOff + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.compSize);
  if (data.length !== e.compSize) throw new ZipReject('zip_truncated');
  if (e.compSize > 0 && e.size / Math.max(1, e.compSize) > limits.maxZipRatio && e.size > 1024 * 1024) throw new ZipReject('zip_bomb');
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) {
    try {
      return zlib.inflateRawSync(data, { maxOutputLength: limits.maxXmlBytes });
    } catch (err) {
      if (err && err.code === 'ERR_BUFFER_TOO_LARGE') throw new ZipReject('zip_bomb');
      throw new ZipReject('zip_bad_data');
    }
  }
  throw new ZipReject('zip_unsupported_method');
}

// ---------------------------------------------------------------------------
// DOCX

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXmlEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, g) => {
    if (g[0] === '#') {
      const cp = g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return ' ';
      try { return String.fromCodePoint(cp); } catch { return ' '; }
    }
    return XML_ENT[g] !== undefined ? XML_ENT[g] : m;
  });
}

// Walks word/document.xml in document order.
//  - a paragraph is a line; list paragraphs get a bullet; mc:Fallback copies of text boxes are dropped (no doubled text)
//  - a table row becomes lines in which the cells are separated by TAB. Cells holding several paragraphs continue on the
//    following lines, so [date | title, employer, duties...] reads "date TAB title", "employer", "duties" (the tab-less
//    continuation lines keep the reading order a person would have)
function docxXmlToText(xml) {
  let x = xml.replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, '');
  x = x.replace(/<w:del\b[\s\S]*?<\/w:del>/g, '');
  const re = /<w:tbl>|<\/w:tbl>|<w:tr(?:\s[^>]*)?>|<\/w:tr>|<w:tc(?:\s[^>]*)?>|<\/w:tc>|<w:p(?:\s[^>]*)?>|<\/w:p>|<w:numPr>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br\b[^>]*\/>|<w:cr\s*\/>|<w:noBreakHyphen\s*\/>/g;
  const lines = [];
  let cur = '';
  let bulletPending = false;
  let paraHasText = false;
  let tblDepth = 0;
  let row = null;
  let cell = null;
  const endParagraph = () => {
    if (tblDepth === 0) lines.push(cur);
    else if (cell && cur.trim() !== '') cell.push(cur.trim());
    cur = '';
    paraHasText = false;
    bulletPending = false;
  };
  let m;
  while ((m = re.exec(x)) !== null) {
    const tok = m[0];
    if (tok.startsWith('<w:t>') || tok.startsWith('<w:t ')) {
      if (bulletPending && !paraHasText) cur += '\u2022 ';
      bulletPending = false;
      paraHasText = true;
      cur += decodeXmlEntities(m[1]);
    } else if (tok === '<w:numPr>') {
      bulletPending = true;
    } else if (tok === '<w:tbl>') {
      if (tblDepth === 0 && cur !== '') endParagraph();
      tblDepth += 1;
    } else if (tok === '</w:tbl>') {
      tblDepth = Math.max(0, tblDepth - 1);
    } else if (tok.startsWith('<w:tr')) {
      if (tblDepth === 1) row = [];
    } else if (tok === '</w:tr>') {
      if (tblDepth === 1 && row) {
        const n = Math.max(0, ...row.map((c) => c.length));
        for (let i = 0; i < n; i += 1) lines.push(row.map((c) => c[i] || '').join('\t').replace(/\t+$/, ''));
        row = null;
      }
    } else if (tok.startsWith('<w:tc')) {
      if (tblDepth === 1) cell = [];
    } else if (tok === '</w:tc>') {
      if (tblDepth === 1 && row && cell) { if (cur.trim() !== '') endParagraph(); row.push(cell); cell = null; }
    } else if (/^<w:p[\s>]/.test(tok)) {
      bulletPending = false;
      paraHasText = false;
    } else if (tok === '</w:p>') {
      endParagraph();
    } else if (tok.startsWith('<w:tab')) {
      cur += '\t';
    } else if (tok.startsWith('<w:br') || tok.startsWith('<w:cr')) {
      endParagraph();
    } else if (tok.startsWith('<w:noBreakHyphen')) {
      cur += '-';
    }
  }
  if (cur.trim() !== '') endParagraph();
  return lines.join('\n');
}

function extractDocx(buf, limits) {
  const entries = readZipEntries(buf, limits);
  const doc = entries.get('word/document.xml');
  if (!doc) {
    if (entries.has('content.xml') || entries.has('xl/workbook.xml') || entries.has('ppt/presentation.xml')) return { unsupported: 'not_docx_zip' };
    return { unsupported: 'zip_not_document' };
  }
  const xml = readZipEntry(buf, doc, limits).toString('utf8');
  return { text: docxXmlToText(xml) };
}

// ---------------------------------------------------------------------------
// PDF

function withTimeout(promise, ms, code) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(code), { timeoutCode: code })), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

// Reads the text items with their coordinates (pdf.js through pdf-parse) and rebuilds rows and columns ourselves.
async function pdfLayoutText(parser, limits) {
  const doc = await parser.load();
  const total = doc.numPages;
  const n = Math.min(total, limits.maxPages);
  const rowPages = [];
  const colPages = [];
  let anyColumns = false;
  for (let p = 1; p <= n; p += 1) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items.filter((i) => typeof i.str === 'string').map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: i.height || Math.abs(i.transform[3]) }));
    const lay = layoutPage(items, { pageWidth: vp.width });
    rowPages.push(lay.rows);
    if (lay.columns !== null) anyColumns = true;
    colPages.push(lay.columns !== null ? lay.columns : lay.rows);
  }
  return { text: rowPages.join('\n\f\n'), textAlt: anyColumns ? colPages.join('\n\f\n') : null, pages: total, pagesTruncated: total > limits.maxPages };
}

async function extractPdf(buf, limits) {
  const { PDFParse } = loadPdfParse();
  const parser = new PDFParse({ data: new Uint8Array(buf), verbosity: 0 });
  try {
    try {
      const lay = await withTimeout(pdfLayoutText(parser, limits), limits.timeoutMs, 'timeout');
      if (lay.text.replace(/\s/g, '').length >= 50) return lay;
    } catch (e) {
      if (e && e.timeoutCode) throw e;
      if (e && /Password/i.test(String(e.name))) throw e;
      // any other failure of the coordinate path: fall back to pdf-parse's own text
    }
    const r = await withTimeout(parser.getText({ first: limits.maxPages, pageJoiner: '', lineEnforce: true, cellSeparator: '\t' }), limits.timeoutMs, 'timeout');
    const pages = Array.isArray(r.pages) ? r.pages : [];
    const text = pages.map((p) => String(p.text || '')).join('\n\f\n');
    return { text, textAlt: null, pages: r.total || pages.length, pagesTruncated: (r.total || pages.length) > limits.maxPages };
  } finally {
    // destroy must not mask the real result, and must not hang
    try { await withTimeout(parser.destroy(), 3000, 'destroy_timeout'); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Public API

function extHintOf(fileName) {
  if (!fileName) return null;
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(fileName));
  return m ? m[1].toLowerCase() : null;
}

const EXT_FOR_TYPE = { pdf: ['pdf'], docx: ['docx', 'docm'], rtf: ['rtf'], txt: ['txt', 'text'], doc_binary: ['doc'] };

async function extractText(buf, opts = {}) {
  const limits = Object.assign({}, DEFAULT_LIMITS, opts.limits || {});
  const extHint = extHintOf(opts.fileName || opts.ext);
  const res = { status: 'error', reason: 'parse_failed', fileType: 'unknown', extHint, extMismatch: false, pages: null, text: '', textAlt: null, chars: 0, pagesTruncated: false };
  const done = (status, reason, extra) => {
    Object.assign(res, { status, reason: reason || null }, extra || {});
    const ft = res.fileType === 'zip' ? 'docx' : res.fileType;
    if (extHint && EXT_FOR_TYPE[ft]) res.extMismatch = !EXT_FOR_TYPE[ft].includes(extHint);
    else if (extHint && ['pdf', 'docx', 'doc', 'rtf', 'txt'].includes(extHint)) res.extMismatch = true;
    return res;
  };
  try {
    if (!Buffer.isBuffer(buf)) return done('error', 'not_a_buffer');
    if (buf.length > limits.maxBytes) { res.fileType = sniffType(buf.subarray(0, 4096)); return done('rejected', 'too_large'); }
    const type = sniffType(buf);
    res.fileType = type;

    let text = '';
    if (type === 'empty') return done('empty', 'zero_bytes');
    if (type === 'doc_binary') return done('unsupported', 'doc_binary');
    if (type === 'image') return done('unsupported', 'image_only');
    if (type === 'html') return done('unsupported', 'html');
    if (type === 'unknown') return done('unsupported', 'unknown_type');
    if (type === 'pdf') {
      let r;
      try { r = await extractPdf(buf, limits); } catch (e) {
        if (e && e.timeoutCode) return done('error', 'timeout');
        const name = e && e.name ? String(e.name) : '';
        if (/Password/i.test(name)) return done('unsupported', 'encrypted');
        if (/InvalidPDF|Format|Missing/i.test(name)) return done('error', 'invalid_pdf');
        return done('error', 'parse_failed');
      }
      res.pages = r.pages;
      res.pagesTruncated = r.pagesTruncated;
      text = r.text;
      if (r.textAlt) res.textAlt = normaliseText(r.textAlt, limits.maxChars);
    } else if (type === 'zip') {
      let r;
      try { r = extractDocx(buf, limits); } catch (e) {
        if (e instanceof ZipReject) return done(e.zipCode === 'encrypted' ? 'unsupported' : 'rejected', e.zipCode);
        return done('error', 'parse_failed');
      }
      if (r.unsupported) { res.fileType = 'zip'; return done('unsupported', r.unsupported); }
      res.fileType = 'docx';
      text = r.text;
    } else if (type === 'rtf') {
      text = rtfToText(buf.toString('latin1'), limits.maxChars * 2);
    } else if (type === 'txt') {
      text = decodePlainText(buf);
    }
    text = normaliseText(text, limits.maxChars);
    res.text = text;
    res.chars = text.length;
    const visible = text.replace(/[\s\f]/g, '').length;
    if (visible === 0) return done(type === 'pdf' ? 'scanned' : 'empty', type === 'pdf' ? 'no_text_layer' : 'no_text', { text: '', textAlt: null, chars: 0 });
    if (visible < limits.minTextChars) return done(type === 'pdf' ? 'scanned' : 'empty', 'too_little_text', { text: '', textAlt: null, chars: 0 });
    return done('ok', null);
  } catch (e) {
    return done('error', 'parse_failed', { text: '', chars: 0 });
  }
}

async function extractFile(file, opts = {}) {
  const limits = Object.assign({}, DEFAULT_LIMITS, opts.limits || {});
  let st;
  try { st = fs.statSync(file); } catch { return { status: 'error', reason: 'unreadable', fileType: 'unknown', extHint: extHintOf(file), extMismatch: false, pages: null, text: '', chars: 0 }; }
  if (st.size > limits.maxBytes) {
    return { status: 'rejected', reason: 'too_large', fileType: 'unknown', extHint: extHintOf(file), extMismatch: false, pages: null, text: '', chars: 0 };
  }
  let buf;
  try { buf = fs.readFileSync(file); } catch { return { status: 'error', reason: 'unreadable', fileType: 'unknown', extHint: extHintOf(file), extMismatch: false, pages: null, text: '', chars: 0 }; }
  return extractText(buf, Object.assign({}, opts, { fileName: path.basename(file) }));
}

// ---------------------------------------------------------------------------
// Worker pool: hard timeouts by terminating the worker (parsers are CPU bound and cannot be interrupted in-thread)

function createExtractorPool(opts = {}) {
  const { Worker } = require('worker_threads');
  const size = Math.max(1, opts.workers || 4);
  const timeoutMs = opts.timeoutMs || (DEFAULT_LIMITS.timeoutMs + 8000);
  const workerFile = path.join(__dirname, 'extract-worker.js');
  const limits = opts.limits || {};
  const idle = [];
  const queue = [];
  let closed = false;
  let seq = 0;

  function spawn() {
    const w = new Worker(workerFile, { workerData: { limits } });
    w.on('error', () => { /* handled through the per-job listeners */ });
    return w;
  }
  function pump() {
    while (!closed && queue.length && (idle.length || liveCount < size)) {
      const job = queue.shift();
      let w = idle.pop();
      if (!w) { w = spawn(); liveCount += 1; }
      run(w, job);
    }
  }
  let liveCount = 0;
  function run(w, job) {
    const id = ++seq;
    let finished = false;
    const cleanup = () => { w.removeListener('message', onMsg); w.removeListener('error', onErr); w.removeListener('exit', onExit); clearTimeout(timer); };
    const settle = (result, reuse) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (reuse && !closed) idle.push(w);
      else { liveCount -= 1; w.terminate().catch(() => {}); }
      job.resolve(result);
      pump();
    };
    const onMsg = (m) => { if (m && m.id === id) settle(m.result, true); };
    const onErr = () => settle({ status: 'error', reason: 'worker_crash', fileType: 'unknown', extHint: extHintOf(job.file), extMismatch: false, pages: null, text: '', chars: 0 }, false);
    const onExit = () => settle({ status: 'error', reason: 'worker_crash', fileType: 'unknown', extHint: extHintOf(job.file), extMismatch: false, pages: null, text: '', chars: 0 }, false);
    const timer = setTimeout(() => settle({ status: 'error', reason: 'timeout', fileType: 'unknown', extHint: extHintOf(job.file), extMismatch: false, pages: null, text: '', chars: 0 }, false), timeoutMs);
    w.on('message', onMsg);
    w.on('error', onErr);
    w.on('exit', onExit);
    w.postMessage({ id, file: job.file });
  }
  return {
    extractFile(file) {
      if (closed) return Promise.reject(new Error('pool closed'));
      return new Promise((resolve) => { queue.push({ file, resolve }); pump(); });
    },
    async close() {
      closed = true;
      await Promise.all(idle.splice(0).map((w) => w.terminate().catch(() => {})));
    },
  };
}

module.exports = {
  DEFAULT_LIMITS,
  sniffType,
  normaliseText,
  rtfToText,
  docxXmlToText,
  decodePlainText,
  extractText,
  extractFile,
  createExtractorPool,
  extHintOf,
};
