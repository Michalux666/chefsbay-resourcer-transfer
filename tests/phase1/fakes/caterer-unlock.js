'use strict';
// Fake unlock CLI: prints one JSON line per the caterer-unlock contract.
const { scenario, logCall, sleepMs } = require('./common');

async function main() {
  const [, , id, token] = process.argv;
  const sc = scenario();
  const table = sc.unlock || {};
  const plan = table[String(id)] || table.__default || {
    success: true, name: `Test Person ${id}`, firstName: 'Test', lastName: `Person ${id}`,
    email: `person${id}@example.invalid`, phone: '07 700 900 001', cvUrl: `/CandidateSearch/CandidateDownloadCV.aspx?candidateId=enc${id}&CandidateSearchAuditId=aud${id}`,
    encId: `enc${id}`, auditId: `aud${id}`, jobTitle: 'Head Chef',
  };
  // sc.probeDb: what candidates.db holds for this candidate at the moment of the unlock (the claim of the second look must already be there)
  let rowsAtCall;
  if (sc.probeDb) {
    try {
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.P1_HOME, 'candidates.db'), { readonly: true });
      rowsAtCall = db.prepare('SELECT job_title AS title, origin FROM candidate_rejections WHERE caterer_id = ? ORDER BY id').all(Number(id));
      db.close();
    } catch (e) { rowsAtCall = { error: String(e.message).slice(0, 80) }; }
  }
  logCall('caterer-unlock', { id, tokenPresent: Boolean(token), token, success: plan.success, rowsAtCall });
  if (plan.__hang) await sleepMs(Number(process.env.P1_HANG_MS || 15000));
  if (plan.__raw !== undefined) {
    process.stdout.write(String(plan.__raw) + '\n');
    process.exit(plan.__exit === undefined ? 1 : plan.__exit);
  }
  let line = JSON.stringify(plan);
  if (plan.__assertTail) line += ' Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src/win/async.c';
  process.stdout.write(line + '\n');
  process.exit(plan.success ? 0 : 1);
}

main();
