#!/usr/bin/env node
'use strict';
/**
 * caterer-download-cv.js
 *
 * Downloads a candidate CV from Caterer.com through the signed-in browser session (node fetch to Caterer
 * is blocked, see caterer-browser-fetch.js).
 *
 * Usage:
 *   node caterer-download-cv.js <encrypted_candidate_id> <audit_id> <output_dir> [candidate_id]
 *
 * Output:
 *   Saves the file to: <output_dir>/cv-<candidate_id>.<ext>   (mode 600, written atomically)
 *   Prints: CV_FILE=<full_path>
 *
 * Exits 0 on success, 1 on failure. A CV is personal data: the file is deleted by the pipeline once the
 * candidate is in Zoho (see the retention rules), never copied anywhere else by this script.
 */
const fs = require('fs');
const path = require('path');
const { SITE } = require('./lib/browser');
const { browserFetchBinary } = require('./caterer-browser-fetch');
const { CV_EXTENSIONS } = require('./lib/cv-retention');

// Only the extensions Phase 2 searches for (lib/cv-retention CV_EXTENSIONS): a CV saved as .odt would never be found, attached or swept.
function guessExtension(contentType, contentDisposition) {
  let filename = null;
  if (contentDisposition) {
    const match = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i);
    if (match) {
      filename = match[1].replace(/['"]/g, '').trim();
      const ext = path.extname(filename).toLowerCase();
      if (CV_EXTENSIONS.includes(ext)) return { ext, filename };
    }
  }
  if (contentType) {
    if (contentType.includes('pdf')) return { ext: '.pdf', filename };
    if (contentType.includes('msword') || contentType.includes('doc')) return { ext: '.doc', filename };
    if (contentType.includes('wordprocessingml') || contentType.includes('docx')) return { ext: '.docx', filename };
    if (contentType.includes('rtf')) return { ext: '.rtf', filename };
    if (contentType.includes('text')) return { ext: '.txt', filename };
  }
  return { ext: '.pdf', filename };
}

function buildDownloadUrl(encCandidateId, auditId) {
  const params = new URLSearchParams({ candidateId: encCandidateId });
  if (auditId) params.set('CandidateSearchAuditId', auditId);
  params.set('PagePosition', '1');
  params.set('PageNumber', '1');
  params.set('PageSize', '10');
  return `${SITE.BASE}/CandidateSearch/CandidateDownloadCV.aspx?${params}`;
}

// The temp name does not start with "cv-", so a reader that looks for cv-<id>.* never sees a half-written file.
function writeCvAtomic(outputPath, buffer) {
  const tmp = path.join(path.dirname(outputPath), `.cvtmp-${process.pid}-${path.basename(outputPath)}`);
  try {
    fs.writeFileSync(tmp, buffer, { mode: 0o600 });
    fs.renameSync(tmp, outputPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* none */ }
    throw e;
  }
}

async function downloadCv(encCandidateId, auditId, outputDir, candidateIdStr, io) {
  const log = (io && io.log) || ((m) => console.log(m));
  const err = (io && io.err) || ((m) => console.error(m));
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  log('Downloading CV from Caterer (via browser proxy)...');
  const res = await browserFetchBinary(buildDownloadUrl(encCandidateId, auditId), 60000);

  if (res.error) { err(`browser-fetch: ${res.error}`); return { ok: false }; }
  if (!res.status || res.status >= 400) { err(`HTTP ${res.status}`); return { ok: false }; }

  const contentType = res.contentType || '';
  const contentDisposition = res.contentDisposition || '';
  const { ext, filename: originalName } = guessExtension(contentType, contentDisposition);
  // the id becomes part of a file name: keep it to plain characters (no path separators)
  const candidateId = String(candidateIdStr || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  const outputPath = path.join(path.resolve(outputDir), `cv-${candidateId}${ext}`);

  const buffer = res.buffer || Buffer.alloc(0);
  if (buffer.length < 100) {
    err(`Downloaded file too small (${buffer.length} bytes) - likely an error page`);
    err('Content: ' + buffer.toString('utf8').slice(0, 200));
    return { ok: false };
  }

  writeCvAtomic(outputPath, buffer);
  log(`CV_FILE=${outputPath}`);
  log(`  Size: ${(buffer.length / 1024).toFixed(1)}KB | Type: ${contentType} | Original: ${originalName || 'unknown'}`);
  return { ok: true, outputPath, size: buffer.length };
}

async function main() {
  const [,, encCandidateId, auditId, outputDir, candidateIdStr] = process.argv;
  if (encCandidateId === '--help' || encCandidateId === '-h') {
    console.log('Usage: node scripts/caterer-download-cv.js <enc_candidate_id> <audit_id> <output_dir> [candidate_id]');
    console.log('Saves <output_dir>/cv-<candidate_id>.<ext> and prints CV_FILE=<path>; exit 0 on success, 1 on failure.');
    return process.stdout.write('', () => process.exit(0));
  }
  if (!encCandidateId || !outputDir) {
    console.error('Usage: caterer-download-cv.js <enc_candidate_id> <audit_id> <output_dir> [candidate_id]');
    return process.stderr.write('', () => process.exit(1));
  }
  let code = 1;
  try {
    const r = await downloadCv(encCandidateId, auditId, outputDir, candidateIdStr);
    code = r.ok ? 0 : 1;
  } catch (e) {
    console.error('FATAL:', e.message);
  }
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

module.exports = { guessExtension, buildDownloadUrl, writeCvAtomic, downloadCv };

if (require.main === module) main();
