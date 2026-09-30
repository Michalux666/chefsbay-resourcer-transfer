'use strict';
// Runs the REAL Phase 2 (process-approved-queue.run) on a scratch workspace, with the lifecycle test
// harness supplying the database and fake dependencies. Only the pending files and the queue file come
// from the caller (a JSON file named on the command line); the outcome is one RESULT line on stdout.
const fs = require('fs');
const path = require('path');

const LC = path.join(__dirname, '..', '..', 'lifecycle', 'helpers');
const { makeWorkspace } = require(path.join(LC, 'workspace'));
const ws = makeWorkspace('sup-phase2');
require(path.join(LC, 'net-guard'));
const { writeQueue } = require(path.join(LC, 'fixtures'));
const { captureConsole, seedDb, buildDeps } = require(path.join(LC, 'harness'));
const pq = require(path.join(__dirname, '..', '..', '..', 'resourcer', 'scripts', 'process-approved-queue'));

(async () => {
  const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  seedDb(ws, []);
  fs.mkdirSync(ws.pending, { recursive: true });
  for (const p of input.pending) fs.writeFileSync(path.join(ws.pending, p.name), JSON.stringify(p.data));
  const queueName = 'merged-queue-2026-09-29T10-00-00.json';
  const queueFile = writeQueue(ws, queueName, Object.assign({ jobTitle: input.jobTitle, location: input.location }, input.queue));
  const built = buildDeps(ws, {});
  const cap = captureConsole();
  let res;
  try { res = await pq.run(queueFile, built.deps); } finally { cap.restore(); built.close(); }
  const resultsFile = path.join(ws.downloads, 'phase2-results-merged-queue-2026-09-29T10-00-00.json');
  const results = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : null;
  process.stdout.write(`RESULT ${JSON.stringify({ code: res && res.code, pending: fs.readdirSync(ws.pending), sources: results && results.sources, log: cap.lines.filter((l) => /pending/i.test(l)) })}\n`);
  ws.cleanup();
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
