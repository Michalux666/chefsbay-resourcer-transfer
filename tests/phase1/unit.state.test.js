'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// RESOURCER_HOME must be set before the modules under test load, so this file runs in its own process.
const HOME = fs.mkdtempSync(path.join(process.env.P1_TEST_TMP || os.tmpdir(), 'p1s-'));
process.env.RESOURCER_HOME = HOME;
process.env.RESOURCER_ENV_FILE = path.join(HOME, '_none.env');
process.env.HERMES_HOME = path.join(HOME, '_hermes');

const test = require('node:test');
const assert = require('node:assert');
const P = path.resolve(__dirname, '..', '..', 'resourcer', 'scripts', 'phase1');
const run = require(path.join(P, 'run.js'));
const config = require(path.join(P, 'config.js'));
const paths = require(path.resolve(__dirname, '..', '..', 'resourcer', 'scripts', 'lib', 'paths.js'));
const util = require(path.join(P, 'util.js'));

test.after(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* best effort */ } });

test('home resolution follows RESOURCER_HOME', () => {
  assert.strictEqual(paths.HOME, path.resolve(HOME));
});

test('chooseTimestamp: an explicit valid PHASE1_RUN_TIMESTAMP is used as is (resume), an invalid one is ignored', () => {
  assert.strictEqual(run.chooseTimestamp({ runTimestamp: '2026-01-02-030405' }, null), '2026-01-02-030405');
  const ts = run.chooseTimestamp({ runTimestamp: 'garbage' }, null);
  assert.match(ts, /^\d{4}-\d{2}-\d{2}-\d{6}$/);
});

test('chooseTimestamp: never adopts a run id whose status or queue file already exists', () => {
  fs.mkdirSync(paths.RUNS, { recursive: true });
  fs.mkdirSync(paths.DOWNLOADS, { recursive: true });
  const now = Date.now();
  // occupy the current second and the next two, one via the status file and one via the queue file
  const taken = [0, 1, 2].map((i) => util.runTimestamp(new Date(now + i * 1000)));
  fs.writeFileSync(path.join(paths.RUNS, `phase1-${taken[0]}.json`), '{}');
  fs.writeFileSync(path.join(paths.DOWNLOADS, `approved-queue-${taken[1]}.json`), '{}');
  fs.writeFileSync(path.join(paths.RUNS, `phase1-${taken[2]}.json`), '{}');
  const lines = [];
  const chosen = run.chooseTimestamp({ runTimestamp: '' }, (l) => lines.push(l));
  assert.ok(!taken.includes(chosen) || Date.now() - now > 1500, `chose a taken id: ${chosen}`);
  assert.ok(lines.length === 1 && lines[0].startsWith('NOTE run id collision'), lines.join('|'));
});

test('makeState builds the run file names from the timestamp and starts every counter at the legacy value', () => {
  const st = run.makeState({ runTimestamp: '2030-05-06-070809' }, null);
  assert.strictEqual(st.statusFile, path.join(paths.RUNS, 'phase1-2030-05-06-070809.json'));
  assert.strictEqual(st.queueFile, path.join(paths.DOWNLOADS, 'approved-queue-2030-05-06-070809.json'));
  assert.strictEqual(st.browserRoundtrips, 1, 'the session validation counts as the first round trip');
  assert.strictEqual(st.page, 1);
  assert.strictEqual(st.screeningModel, 'unknown');
  assert.strictEqual(st.phase2Status, null);
  assert.deepStrictEqual([st.skippedDb, st.skippedReview, st.errors, st.pagesScraped, st.totalSeen, st.apiFailureCount], [0, 0, 0, 0, 0, 0]);
});

test('advancePage stops at MAX_PAGES', () => {
  const lines = [];
  const ctx = { st: { page: 2, stop: false }, p: { MAX_PAGES: 3 }, out: (l) => lines.push(l) };
  run.advancePage(ctx);
  assert.strictEqual(ctx.st.page, 3);
  assert.strictEqual(ctx.st.stop, false);
  run.advancePage(ctx);
  assert.strictEqual(ctx.st.stop, true);
  assert.deepStrictEqual(lines, ['Reached max page limit (3)']);
});

test('config: defaults, env overrides, script path overrides', () => {
  const c = config.loadConfig();
  assert.strictEqual(c.heartbeatMs, 20000);
  assert.strictEqual(c.pageRetryPauseMs, 120000);
  assert.strictEqual(c.settleMs, 5000);
  assert.strictEqual(c.unlockPauseMs, 1500);
  assert.strictEqual(c.maxConsecutivePageErrors, 5);
  assert.strictEqual(c.screenInputMode, 'stdin');
  assert.deepStrictEqual(c.browserMs, { open: 90000, wait: 90000, eval: 60000, probe: 30000, url: 20000, stateSave: 60000 });

  process.env.PHASE1_HEARTBEAT_SEC = '0.5';
  process.env.SCREEN_PAGE_RETRY_PAUSE_SEC = '3';
  process.env.SCREEN_INPUT_MODE = 'file';
  process.env.PHASE1_SETTLE_MS = 'not-a-number';
  const d = config.loadConfig();
  assert.strictEqual(d.heartbeatMs, 500);
  assert.strictEqual(d.pageRetryPauseMs, 3000);
  assert.strictEqual(d.screenInputMode, 'file');
  assert.strictEqual(d.settleMs, 5000, 'a bad value falls back to the default');
  for (const k of ['PHASE1_HEARTBEAT_SEC', 'SCREEN_PAGE_RETRY_PAUSE_SEC', 'SCREEN_INPUT_MODE', 'PHASE1_SETTLE_MS']) delete process.env[k];

  assert.strictEqual(config.scriptPath('ai-review'), path.join(paths.SCRIPTS, 'ai-review.js'));
  assert.strictEqual(config.scriptPath('candidates-db'), path.join(paths.HOME, 'candidates-db.js'));
  process.env.PHASE1_SCRIPT_AI_REVIEW = path.join(HOME, 'other', 'fake-review.js');
  process.env.PHASE1_SCRIPT_CATERER_GET_CREDITS = path.join(HOME, 'other', 'fake-credits.js');
  assert.strictEqual(config.scriptPath('ai-review'), path.join(HOME, 'other', 'fake-review.js'));
  assert.strictEqual(config.scriptPath('caterer-get-credits'), path.join(HOME, 'other', 'fake-credits.js'));
  delete process.env.PHASE1_SCRIPT_AI_REVIEW;
  delete process.env.PHASE1_SCRIPT_CATERER_GET_CREDITS;
});

test('runNode: captures output, honours the timeout, reports spawn problems, never rejects', async () => {
  const { runNode } = require(path.join(P, 'proc.js'));
  const echo = path.join(HOME, 'echo.js');
  fs.writeFileSync(echo, "process.stdout.write('out:' + process.argv.slice(2).join('|')); process.stderr.write('err'); process.exit(3);");
  const a = await runNode(echo, ['a b', '--c', '']);
  assert.strictEqual(a.code, 3);
  assert.strictEqual(a.stdout, 'out:a b|--c|');
  assert.strictEqual(a.stderr, 'err');
  assert.strictEqual(a.timedOut, false);

  const sleeper = path.join(HOME, 'sleep.js');
  fs.writeFileSync(sleeper, 'setTimeout(() => {}, 30000);');
  const b = await runNode(sleeper, [], { timeoutMs: 300, graceMs: 200 });
  assert.strictEqual(b.timedOut, true);
  assert.ok(b.ms < 5000);

  const stdin = path.join(HOME, 'stdin.js');
  fs.writeFileSync(stdin, "process.stdout.write(require('fs').readFileSync(0, 'utf8').toUpperCase());");
  const c = await runNode(stdin, [], { input: 'hello' });
  assert.strictEqual(c.stdout, 'HELLO');

  const d = await runNode(path.join(HOME, 'does-not-exist.js'), []);
  assert.notStrictEqual(d.code, 0);
});
