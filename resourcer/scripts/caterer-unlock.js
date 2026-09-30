#!/usr/bin/env node
'use strict';
/**
 * caterer-unlock.js
 *
 * Calls the Caterer unlock endpoint for a single candidate (through the signed-in browser session, see
 * caterer-browser-fetch.js) and returns structured profile data extracted from the unlock response.
 *
 * Usage:
 *   node scripts/caterer-unlock.js <candidateId> <candidateDataValue>
 *
 * Output (stdout, exactly one JSON line; the phase 1 caller picks the line that starts with "{" and
 * contains "success"):
 *   {"success":true,"name":"...","firstName":"...","lastName":"...","email":"...","phone":"...","cvUrl":"...","encId":"...","auditId":"...","jobTitle":"..."}
 *   {"success":false,"error":"HTTP 401"}
 *
 * Exit codes: 0 = success, 1 = error
 *
 * An unlock spends a credit, so it is sent exactly once (singleAttempt): a slow response is reported as a
 * failure, never re-sent by the CLI.
 */
const { SITE } = require('./lib/browser');
const { browserFetchText } = require('./caterer-browser-fetch');

function decodeHtml(str) {
  return (str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .trim();
}

async function unlockAndExtract(candidateId, candidateDataValue) {
  const params = new URLSearchParams({ CandidateData: candidateDataValue });
  const url = `${SITE.BASE}/CandidateSearchWebMvc/CandidateSearch/UnlockCandidate?${params.toString()}`;

  const res = await browserFetchText(url, 40000, { singleAttempt: true, label: 'unlock' });

  if (res.timedOut) {
    return { success: false, error: 'browser-fetch: unlock timed out (not re-sent, to avoid a duplicate unlock)' };
  }
  if (res.error) {
    return { success: false, error: `browser-fetch: ${res.error}` };
  }
  if (!res.status || res.status >= 400) {
    return { success: false, error: `HTTP ${res.status}` };
  }

  let data;
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    return { success: false, error: 'Empty response - session may have expired' };
  }

  // Combine all HTML content from Instructions array
  const allHtml = data.Instructions
    ? data.Instructions.flatMap((inst) => (inst.Content && inst.Content.Contents) || []).join('\n')
    : '';

  if (!allHtml) {
    return { success: false, error: 'Empty response - session may have expired' };
  }

  const nameMatch = allHtml.match(/class="flex-row person"[\s\S]*?<span[^>]*>([^<]+)<\/span>/);
  const name = nameMatch ? decodeHtml(nameMatch[1]).trim() : '';

  const emailMatch = allHtml.match(/href="mailto:([^"]+)"/i);
  const email = emailMatch ? emailMatch[1] : '';

  const phoneMatch = allHtml.match(/id="candidate-details-phone-\d+"[^>]*>([^<]+)<\/div>/);
  const phone = phoneMatch ? phoneMatch[1].trim() : '';

  const cvUrlMatch = allHtml.match(/data-href="(\/CandidateSearch\/CandidateDownloadCV\.aspx[^"]+)"/);
  const cvUrl = cvUrlMatch ? cvUrlMatch[1] : '';

  let encId = '', auditId = '';
  if (cvUrl) {
    const encMatch = cvUrl.match(/candidateId=([^&]+)/);
    const auditMatch = cvUrl.match(/CandidateSearchAuditId=([^&]+)/);
    if (encMatch) encId = decodeURIComponent(encMatch[1]);
    if (auditMatch) auditId = decodeURIComponent(auditMatch[1]);
  }

  const jobMatch = allHtml.match(/candidate-identifier-summary[\s\S]*?<span[^>]*>([^|<]+)<\/span>/);
  const jobRaw = jobMatch ? decodeHtml(jobMatch[1]) : '';
  const jobTitle = jobRaw.replace(/<[^>]+>/g, '').replace(/match>/g, '').trim();

  const nameParts = name.split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  if (!name && !email) {
    return { success: false, error: 'Could not extract profile data - unlock may have failed or used a credit already' };
  }

  return { success: true, name, firstName, lastName, email, phone, cvUrl, encId, auditId, jobTitle };
}

function done(code, line) {
  process.stdout.write(line + '\n', () => process.exit(code));
}

async function main() {
  const [,, candidateId, candidateDataValue] = process.argv;

  if (candidateId === '--help' || candidateId === '-h') {
    return done(0, [
      'Usage: node scripts/caterer-unlock.js <candidateId> <candidateDataValue>',
      'Prints one JSON line ({"success":true,...} or {"success":false,"error":...}); exit 0 on success, 1 on error.',
    ].join('\n'));
  }

  if (!candidateId || !candidateDataValue) {
    return done(1, JSON.stringify({ success: false, error: 'Usage: caterer-unlock.js <candidateId> <candidateDataValue>' }));
  }

  try {
    const result = await unlockAndExtract(candidateId, candidateDataValue);
    return done(result.success ? 0 : 1, JSON.stringify(result));
  } catch (err) {
    return done(1, JSON.stringify({ success: false, error: err.message }));
  }
}

module.exports = { unlockAndExtract, decodeHtml };

if (require.main === module) main();
