'use strict';
// STUB text extractor: a small stand-in that works with the packages the pipeline already has (pdf-parse, mammoth) so the
// stage runs end to end before the corpus reader is vendored. extract.js prefers ./vendor/text-extract.js when it exists.
// Same rules as the real one: the type comes from the bytes, nothing is guessed, and a file that cannot be read gives a fixed
// reason code (no CV text ever appears in a reason).

const MAX_BYTES = 12 * 1024 * 1024;
const MIN_VISIBLE_CHARS = 120;
const PDF_TIMEOUT_MS = 25000;
const BS = String.fromCharCode(92);

function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return 'empty';
  const head = buf.subarray(0, 1024).toString('latin1');
  if (head.includes('%PDF-')) return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';
  if (buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return 'doc_binary';
  if (head.trimStart().startsWith('{' + BS + 'rtf')) return 'rtf';
  if ((buf[0] === 0x89 && buf[1] === 0x50) || (buf[0] === 0xff && buf[1] === 0xd8)) return 'image';
  if (/^\s*<(!doctype html|html|\?xml)/i.test(head)) return 'html';
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return 'txt';
  const sample = buf.subarray(0, 4096);
  let bad = 0;
  for (const b of sample) if (b === 0 || b < 9 || (b > 13 && b < 32)) bad++;
  return bad / sample.length < 0.01 ? 'txt' : 'unknown';
}

function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  return buf.toString('utf8').replace(/^\ufeff/, '');
}

// RTF control words start with a backslash: the patterns are built from its character code so no double-backslash literal is needed.
const RTF_PAR = new RegExp(BS + BS + 'par[d]?', 'g');
const RTF_HEX = new RegExp(BS + BS + "'[0-9a-f]{2}", 'gi');
const RTF_WORD = new RegExp(BS + BS + '[a-z]+-?' + BS + 'd* ?', 'gi');

function rtfToText(s) {
  return s
    .replace(RTF_PAR, '\n')
    .replace(RTF_HEX, ' ')
    .replace(RTF_WORD, ' ')
    .replace(/[{}]/g, '')
    .replace(/[ \t]+/g, ' ');
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]).finally(() => clearTimeout(timer));
}

async function readPdf(buf) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buf });
  try {
    const r = await withTimeout(parser.getText(), PDF_TIMEOUT_MS);
    return (r && r.text) || '';
  } finally {
    await parser.destroy().catch(() => {});
  }
}

/**
 * @returns {Promise<{status:string, reason:string|null, fileType:string, text:string, chars:number}>}
 */
async function extractText(buf) {
  const res = { status: 'ok', reason: null, fileType: 'unknown', text: '', chars: 0 };
  const fail = (status, reason) => ({ ...res, status, reason, text: '', chars: 0 });
  try {
    if (!Buffer.isBuffer(buf)) return fail('error', 'not_a_buffer');
    if (buf.length > MAX_BYTES) return fail('rejected', 'too_large');
    const type = sniff(buf);
    res.fileType = type;
    let text = '';
    if (type === 'empty') return fail('empty', 'zero_bytes');
    if (type === 'doc_binary') return fail('unsupported', 'doc_binary');
    if (type === 'image') return fail('unsupported', 'image_only');
    if (type === 'html') return fail('unsupported', 'html');
    if (type === 'unknown') return fail('unsupported', 'unknown_type');
    if (type === 'pdf') {
      try { text = await readPdf(buf); } catch (e) { return fail('error', /timeout/.test(String(e && e.message)) ? 'timeout' : 'parse_failed'); }
    } else if (type === 'zip') {
      try {
        const mammoth = require('mammoth');
        text = ((await mammoth.extractRawText({ buffer: buf })) || {}).value || '';
        res.fileType = 'docx';
      } catch (e) { return fail('unsupported', 'zip_not_docx'); }
    } else if (type === 'rtf') text = rtfToText(buf.toString('latin1'));
    else text = decodeText(buf);
    text = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').replace(/[ \t]+/g, ' ').trim();
    const visible = text.replace(/\s/g, '').length;
    if (visible < MIN_VISIBLE_CHARS) return fail(type === 'pdf' ? 'scanned' : 'empty', 'too_little_text');
    return { ...res, text, chars: text.length };
  } catch (e) {
    return fail('error', 'parse_failed');
  }
}

module.exports = { extractText, sniff };
