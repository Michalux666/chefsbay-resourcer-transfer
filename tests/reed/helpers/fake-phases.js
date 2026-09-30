'use strict';

// Fake Phase 2, optimiser and Reed phase 1 used by the orchestration tests (they log every call to <home>/calls.jsonl).

const FAKE_REED = `'use strict';
const fs = require('fs');
const path = require('path');
const home = process.env.RESOURCER_HOME;
fs.appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify({ who: 'reed', argv: process.argv.slice(2), holder: process.env.RESOURCER_BROWSER_LOCK_HOLDER_PID || null, ppid: process.ppid }) + '' + String.fromCharCode(10) + '');
const mode = process.env.FAKE_REED_MODE || 'ok';
const argv = process.argv.slice(2);
const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
if (mode === 'auth-marker') { fs.mkdirSync(path.join(home, 'runtime'), { recursive: true }); fs.writeFileSync(path.join(home, 'runtime', 'reed-auth-failed.marker'), JSON.stringify({ reason: 'turnstile_blocked', failedAt: new Date().toISOString() })); console.log('REED_AUTH_FAILED'); process.exit(1); }
if (mode === 'auth-output') { console.error('REED_RELOGIN_NEEDED: HTTP 401'); process.exit(1); }
if (mode === 'boom') { console.error('something unrelated exploded'); process.exit(1); }
if (mode === 'quiet') { console.log('[Reed Phase 1] No candidates found - exiting'); process.exit(0); }
fs.mkdirSync(path.join(home, 'downloads'), { recursive: true });
const q = path.join(home, 'downloads', 'reed-approved-queue-fake-1.json');
fs.writeFileSync(q, JSON.stringify({ searchDate: '2026-09-29', jobTitle: get('--job-title'), location: get('--location'), source: 'reed', screeningModel: 'fake/model-1', candidateCount: 40, phase1Stats: { pool: 40, approved: 2, pagesScraped: 2 }, candidates: [{ id: 1, source: 'reed' }, { id: 2, source: 'reed' }] }));
if (mode === 'regex-path') { console.log('  Queue file:   ' + q); } else { console.log('REED_PHASE1_SUMMARY:' + JSON.stringify({ source: 'reed', queuePath: q })); }
`;

const FAKE_PAQ = `'use strict';
const fs = require('fs');
const path = require('path');
const home = process.env.RESOURCER_HOME;
const queue = process.argv[2];
fs.appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify({ who: 'phase2', queue: path.basename(queue), holder: process.env.RESOURCER_BROWSER_LOCK_HOLDER_PID || null }) + '' + String.fromCharCode(10) + '');
fs.mkdirSync(path.join(home, 'downloads'), { recursive: true });
fs.writeFileSync(path.join(home, 'downloads', 'phase2-results-fake.json'), JSON.stringify({ queue: path.basename(queue), sources: JSON.parse(fs.readFileSync(queue, 'utf8')).sources }));
process.exit(Number(process.env.FAKE_PAQ_EXIT || 0));
`;

const FAKE_OPT = `'use strict';
const fs = require('fs');
const path = require('path');
fs.appendFileSync(path.join(process.env.RESOURCER_HOME, 'calls.jsonl'), JSON.stringify({ who: 'optimiser', results: path.basename(process.argv[2]) }) + '' + String.fromCharCode(10) + '');
console.log(JSON.stringify({ verdict: process.env.FAKE_VERDICT || 'NOMINAL', observations: ['ok'], regressions: [{ metric: 'm', current: 1, baseline: 2, change: '-50%' }] }));
`;

module.exports = { FAKE_REED, FAKE_PAQ, FAKE_OPT };
