'use strict';

// Contract with the REAL screening CLI (scripts/ai-review.js, owned by the screening package): stdin hand-off, exit 3 /
// API_UNAVAILABLE on an unreachable gateway, and the D4 behaviour of reed-phase1 on top of it. No network: the gateway origin is a closed port.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { makeMirror, dep, SRC } = require('./helpers/mirror');
const { startFakeReed } = require('./helpers/fake-reed');

const HAVE_REAL = fs.existsSync(path.join(SRC, 'scripts', 'ai-review.js')) && fs.existsSync(path.join(SRC, 'scripts', 'lib', 'screening', 'index.js'));
const SKIP = HAVE_REAL ? false : 'the screening package is not present';

function closedPort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
const DOWN = (port) => ({
  AI_GATEWAY_API_KEY: 'fake-test-key-000000', SCREEN_GATEWAY_ORIGIN: `http://127.0.0.1:${port}`, SCREEN_BACKOFF_BASE_MS: '5',
});

test('real CLI: an unreachable gateway is exit 3 with API_UNAVAILABLE on stdout and stderr, and stdin input works', { skip: SKIP }, async () => {
  const m = makeMirror({ realAi: true });
  try {
    const port = await closedPort();
    const env = m.env(DOWN(port));
    const child = spawn(process.execPath, [m.p('scripts', 'ai-review.js'), '--mode', 'batch', '--job', 'Chef', '--location', 'LS1', '--distance', '20', '--candidates-file', '-'], { cwd: m.home, env });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.end(JSON.stringify([{ id: '1', snippet: 'Current role: Chef de Partie | Location: Leeds' }]));
    const code = await new Promise((r) => child.on('close', r));
    assert.strictEqual(code, 3, stderr);
    assert.ok(stdout.startsWith('API_UNAVAILABLE'), stdout);
    assert.match(stderr, /API_UNAVAILABLE/);
    assert.match(stderr, /SCREENING_MODEL: /);
  } finally { m.cleanup(); }
});

test('reed-phase1 on top of the real CLI with the gateway down: nothing burned, halt raised after 3 strikes', { skip: SKIP }, async () => {
  const m = makeMirror({ realAi: true });
  const fake = await startFakeReed({ loggedIn: true });
  try {
    const port = await closedPort();
    const env = { ...DOWN(port), REED_CDP_PORT: String(fake.cdpPort), REED_API_BASE: fake.apiBase, REED_AUTO_RELAUNCH: '0' };
    const r = await m.run('reed-phase1.js', ['--job-title', 'Chef', '--location', 'LS1', '--run-id', 'rc'], { env, timeoutMs: 120000 });
    assert.strictEqual(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /^REED_SCREENING_HALT: pipeline halt raised$/m);
    const halt = m.readJson('runtime/pipeline-halt.json');
    assert.strictEqual(halt.reason, 'AI screening unavailable');
    const D = dep('better-sqlite3');
    const db = new D(m.p('candidates.db'), { readonly: true });
    try { assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n, 0, 'no candidate burned'); } finally { db.close(); }
    assert.strictEqual(m.readJson('downloads/reed-approved-queue-rc.json').phase1Stats.screeningHalted, true);
  } finally { await fake.close(); m.cleanup(); }
});
