'use strict';
// Adapter over the CV text reader. Interface: extractText(buffer, fileType) -> Promise<{ok, text, textAlt, reason, source}>.
// It uses ./vendor/text-extract.js (the reader built and tested on the CV corpus: magic-byte type detection, pdf layout, docx
// tables, size and zip-bomb limits) when that file is installed and falls back to ./stubs/extract-stub.js, which needs only
// the packages the pipeline already has. `reason` is a fixed code such as unsupported_doc_binary or scanned_too_little_text;
// no CV text ever appears in it. `textAlt` is the column-order reading of a two-column PDF (null otherwise).

let vendored = null;
try { vendored = require('./vendor/text-extract'); } catch (e) { vendored = null; }
const stub = require('./stubs/extract-stub');

const codePart = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/**
 * @param {Buffer} buffer
 * @param {string} [fileType]  pdf, docx, doc, rtf or txt (only a hint: the type is decided from the bytes)
 * @returns {Promise<{ok:boolean, text:string, textAlt:string|null, reason:string|null, source:'vendor'|'stub'}>}
 */
async function extractText(buffer, fileType) {
  let raw;
  const source = vendored ? 'vendor' : 'stub';
  try {
    raw = vendored ? await vendored.extractText(buffer, fileType ? { fileName: `cv.${codePart(fileType)}` } : {}) : await stub.extractText(buffer);
  } catch (e) {
    return { ok: false, text: '', textAlt: null, reason: 'error_reader_failed', source };
  }
  if (raw && raw.status === 'ok' && typeof raw.text === 'string' && raw.text.trim()) {
    return { ok: true, text: raw.text, textAlt: typeof raw.textAlt === 'string' && raw.textAlt.trim() ? raw.textAlt : null, reason: null, source };
  }
  const reason = [codePart(raw && raw.status) || 'error', codePart(raw && raw.reason)].filter(Boolean).join('_');
  return { ok: false, text: '', textAlt: null, reason: reason || 'error_unknown', source };
}

module.exports = { extractText, isVendored: () => !!vendored };
