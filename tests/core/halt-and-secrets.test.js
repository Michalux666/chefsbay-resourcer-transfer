'use strict';
// lib/pipeline-halt.js + pipeline-halt-cli.js (state file, errors.jsonl, outbox alerts),
// lib/caterer-credentials.js (secrets path, placeholder guard, fill snippet) and constants.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./helpers/home');

const home = H.makeHome('halt');
process.env.RESOURCER_HOME = home;
process.env.HERMES_HOME = home;
process.env.RESOURCER_ENV_FILE = path.join(home, 'no-such.env');

const halt = require(path.join(H.SCRIPTS, 'lib', 'pipeline-halt.js'));
const creds = require(path.join(H.SCRIPTS, 'lib', 'caterer-credentials.js'));

const STATE = path.join(home, 'runtime', 'pipeline-halt.json');
const ERRORS = path.join(home, 'logs', 'errors.jsonl');
const ALERTS = path.join(home, 'outbox', 'alerts.jsonl');
const EM = String.fromCharCode(0x2014);

const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
function reset() {
  for (const f of [STATE, ERRORS, ALERTS]) fs.rmSync(f, { force: true });
}

test.describe('pipeline-halt', () => {
  test.beforeEach(reset);

  test('paths live under runtime/ and logs/', () => {
    assert.equal(halt.STATE_FILE, STATE);
    assert.equal(halt.ERRORS_LOG, ERRORS);
  });

  test('getHalt is null when nothing is halted', () => {
    assert.equal(halt.getHalt(), null);
  });

  test('setHalt writes the legacy state shape, one errors.jsonl entry and one critical alert', () => {
    const s = halt.setHalt('AI screening unavailable', 'failed on 3 pages', { remedy: 'check the key', blockedRun: true });
    assert.deepEqual(Object.keys(s), ['halted', 'reason', 'detail', 'since', 'lastCheckedAt', 'blockedRuns', 'remedy']);
    assert.equal(s.halted, true);
    assert.equal(s.reason, 'AI screening unavailable');
    assert.equal(s.detail, 'failed on 3 pages');
    assert.equal(s.blockedRuns, 1);
    assert.equal(s.remedy, 'check the key');
    assert.equal(s.since, s.lastCheckedAt);
    assert.deepEqual(halt.getHalt(), s);
    assert.ok(!fs.readFileSync(STATE, 'utf8').startsWith(String.fromCharCode(0xFEFF)));

    const errs = lines(ERRORS);
    assert.equal(errs.length, 1);
    assert.deepEqual(Object.keys(errs[0]), ['ts', 'context', 'severity', 'error', 'detail', 'remedy']);
    assert.equal(errs[0].context, 'pipeline_halted');
    assert.equal(errs[0].severity, 'critical');
    assert.equal(errs[0].error, `PIPELINE HALTED ${EM} AI screening unavailable`);
    assert.equal(errs[0].detail, 'failed on 3 pages');
    assert.equal(errs[0].remedy, 'check the key');

    const alerts = lines(ALERTS);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].severity, 'critical');
    assert.equal(alerts[0].key, 'pipeline-halt');
    assert.match(alerts[0].text, /^PIPELINE HALTED - AI screening unavailable\. failed on 3 pages Remedy: check the key$/);
    assert.ok(/^[\x20-\x7e]*$/.test(alerts[0].text), 'alert text is plain ASCII');
  });

  test('defaults: no remedy, blockedRuns 0 unless a run was held back', () => {
    const s = halt.setHalt('gateway is not running', undefined);
    assert.equal(s.detail, '');
    assert.equal(s.remedy, null);
    assert.equal(s.blockedRuns, 0);
  });

  test('the same reason is idempotent: only lastCheckedAt and blockedRuns move; no new log or alert', () => {
    const first = halt.setHalt('AI screening unavailable', 'a', { blockedRun: true });
    const again = halt.setHalt('AI screening unavailable', 'a different detail', { blockedRun: true });
    const third = halt.setHalt('AI screening unavailable', 'x');
    assert.equal(again.since, first.since);
    assert.equal(again.detail, 'a', 'the original detail is kept');
    assert.equal(again.blockedRuns, 2);
    assert.equal(third.blockedRuns, 2);
    assert.ok(Date.parse(third.lastCheckedAt) >= Date.parse(first.lastCheckedAt));
    assert.equal(lines(ERRORS).length, 1);
    assert.equal(lines(ALERTS).length, 1);
  });

  test('a different reason replaces the state (new since) and logs and alerts again', () => {
    const a = halt.setHalt('gateway is not running', 'd1', { blockedRun: true });
    const b = halt.setHalt('AI screening unavailable', 'd2');
    assert.equal(halt.getHalt().reason, 'AI screening unavailable');
    assert.equal(b.blockedRuns, 0);
    assert.ok(Date.parse(b.since) >= Date.parse(a.since));
    assert.equal(lines(ERRORS).length, 2);
    assert.equal(lines(ALERTS).length, 2);
  });

  test('clearHalt removes the state, logs the recovery and sends an info alert', () => {
    halt.setHalt('AI screening unavailable', 'd', { blockedRun: true });
    halt.setHalt('AI screening unavailable', 'd', { blockedRun: true });
    const prior = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    prior.since = new Date(Date.now() - 90 * 60000).toISOString();
    fs.writeFileSync(STATE, JSON.stringify(prior));
    const prev = halt.clearHalt();
    assert.equal(prev.reason, 'AI screening unavailable');
    assert.ok(!fs.existsSync(STATE));
    assert.equal(halt.getHalt(), null);
    const errs = lines(ERRORS);
    assert.equal(errs.length, 2);
    assert.deepEqual(Object.keys(errs[1]), ['ts', 'context', 'severity', 'error', 'detail']);
    assert.equal(errs[1].context, 'pipeline_resumed');
    assert.equal(errs[1].severity, 'info');
    assert.equal(errs[1].error, `Pipeline resumed ${EM} AI screening unavailable cleared`);
    assert.equal(errs[1].detail, 'was halted for 90 min; 2 run(s) held back (their territories were NOT consumed)');
    const alerts = lines(ALERTS);
    assert.equal(alerts.length, 2);
    assert.equal(alerts[1].severity, 'info');
    assert.equal(alerts[1].key, 'pipeline-halt');
    assert.match(alerts[1].text, /^Pipeline resumed - AI screening unavailable cleared\. was halted for 90 min;/);
  });

  test('clearHalt when nothing is halted does nothing (no log, no alert)', () => {
    assert.equal(halt.clearHalt(), null);
    assert.equal(lines(ERRORS).length, 0);
    assert.equal(lines(ALERTS).length, 0);
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify({ halted: false }));
    assert.equal(halt.clearHalt(), null);
    assert.equal(lines(ERRORS).length, 0);
  });

  test('an unreadable state file counts as not halted', () => {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, '{corrupt');
    assert.equal(halt.getHalt(), null);
    const s = halt.setHalt('AI screening unavailable', 'd');
    assert.equal(s.halted, true);
    assert.equal(halt.getHalt().reason, 'AI screening unavailable');
  });

  test('secrets in the detail or remedy never reach the state file, log or alert', () => {
    process.env.TEST_GATEWAY_API_KEY = 'sk-test-0123456789abcdef';
    try {
      halt.setHalt('screening gateway auth failed', 'HTTP 401 for key sk-test-0123456789abcdef', { remedy: 'rotate sk-test-0123456789abcdef' });
    } finally {
      delete process.env.TEST_GATEWAY_API_KEY;
    }
    for (const f of [STATE, ERRORS, ALERTS]) {
      const text = fs.readFileSync(f, 'utf8');
      assert.ok(!text.includes('sk-test-0123456789abcdef'), f);
      assert.ok(text.includes('***'), f);
    }
  });

  test('a write failure never throws (best effort)', () => {
    // make runtime/ a file so the state directory cannot be created
    fs.rmSync(path.join(home, 'runtime'), { recursive: true, force: true });
    fs.writeFileSync(path.join(home, 'runtime'), 'not a directory');
    try {
      assert.doesNotThrow(() => halt.setHalt('AI screening unavailable', 'd'));
      assert.equal(lines(ERRORS).length, 1, 'the log entry is still written');
    } finally {
      fs.rmSync(path.join(home, 'runtime'), { force: true });
    }
  });
});

test.describe('pipeline-halt-cli', () => {
  const cli = (args) => H.run('scripts/pipeline-halt-cli.js', args, { home });
  test.beforeEach(reset);

  test('get: exit 0 with {"halted":false} when clear, exit 1 with the JSON when halted', () => {
    let r = cli(['get']);
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), { halted: false });
    assert.deepEqual(JSON.parse(cli([]).stdout), { halted: false }, 'no argument behaves as get');
    assert.equal(cli(['whatever']).status, 0, 'unknown command behaves as get');
    cli(['set', 'AI screening unavailable', 'detail']);
    r = cli(['get']);
    assert.equal(r.status, 1);
    const st = JSON.parse(r.stdout);
    assert.equal(st.halted, true);
    assert.equal(st.reason, 'AI screening unavailable');
  });

  test('set: prints HALTED, counts a blocked run each time; missing reason exits 2', () => {
    let r = cli(['set', 'AI screening unavailable', 'three pages failed', 'check the key']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'HALTED: AI screening unavailable');
    let st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    assert.equal(st.blockedRuns, 1);
    assert.equal(st.detail, 'three pages failed');
    assert.equal(st.remedy, 'check the key');
    cli(['set', 'AI screening unavailable', 'again']);
    st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    assert.equal(st.blockedRuns, 2);
    r = cli(['set']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Usage: pipeline-halt-cli\.js set/);
  });

  test('clear: CLEARED: <reason> then NOT_HALTED', () => {
    cli(['set', 'gateway is not running', 'd']);
    let r = cli(['clear']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'CLEARED: gateway is not running');
    r = cli(['clear']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'NOT_HALTED');
    assert.equal(lines(ERRORS).filter(e => e.context === 'pipeline_resumed').length, 1);
  });

  test('--help exits 0', () => {
    const r = cli(['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /pipeline-halt-cli\.js set/);
  });
});

test.describe('caterer-credentials', () => {
  const secrets = path.join(home, 'secrets');
  const file = path.join(secrets, 'caterer-credentials.json');
  const write = (obj, raw) => {
    fs.mkdirSync(secrets, { recursive: true });
    fs.writeFileSync(file, raw !== undefined ? raw : JSON.stringify(obj));
  };
  test.beforeEach(() => fs.rmSync(file, { force: true }));

  test('reads secrets/caterer-credentials.json', () => {
    assert.equal(creds.CRED_PATH, file);
    write({ username: 'user@example.test', password: 'Sup3r-fake-pw', extra: 'ignored' });
    assert.deepEqual(creds.load(), { username: 'user@example.test', password: 'Sup3r-fake-pw' });
  });

  test('a BOM is tolerated, and every call re-reads the file (rotation needs no restart)', () => {
    write(null, String.fromCharCode(0xFEFF) + JSON.stringify({ username: 'u@example.test', password: 'first-fake-pw' }));
    assert.equal(creds.load().password, 'first-fake-pw');
    write({ username: 'u@example.test', password: 'second-fake-pw' });
    assert.equal(creds.load().password, 'second-fake-pw');
  });

  test('errors name the file but never the password', () => {
    assert.throws(() => creds.load(), (e) => /not found at .*caterer-credentials\.json/.test(e.message));
    write(null, '{nope');
    assert.throws(() => creds.load(), /not valid JSON/);
    write({ username: 'u@example.test' });
    assert.throws(() => creds.load(), /needs both "username" and "password"/);
    write({ password: 'p' });
    assert.throws(() => creds.load(), /needs both/);
  });

  test('a placeholder password is refused without trying a login', () => {
    for (const pw of ['<new password here>', '<anything>', 'your password', 'changeme', 'xxxx1234', 'todo', 'set PASSWORD HERE']) {
      write({ username: 'u@example.test', password: pw });
      assert.throws(() => creds.load(), (e) => /still a placeholder/.test(e.message) && !e.message.includes(pw), pw);
    }
    write({ username: 'u@example.test', password: 'a-real-looking-pw' });
    assert.doesNotThrow(() => creds.load());
  });

  test('jsLit escapes backslashes and quotes and drops line breaks', () => {
    const BS = String.fromCharCode(92);
    assert.equal(creds.jsLit("it's"), 'it' + BS + "'s");
    assert.equal(creds.jsLit('a' + BS + 'b'), 'a' + BS + BS + 'b');
    assert.equal(creds.jsLit('a\r\nb'), 'ab');
    assert.equal(creds.jsLit(42), '42');
  });

  test('buildFillJs produces a snippet that fills a React-style form with the exact values', () => {
    const BS = String.fromCharCode(92);
    const pw = `p'a${BS}ss"w;o)rd`;
    write({ username: "o'neil@example.test", password: pw });
    const js = creds.buildFillJs();
    assert.ok(js.startsWith('(function(){') && js.endsWith('})()'));

    const values = {};
    class FakeInput { constructor(name) { this.name = name; } dispatchEvent() { return true; } }
    Object.defineProperty(FakeInput.prototype, 'value', { set(v) { values[this.name] = v; }, get() { return values[this.name]; }, configurable: true });
    const els = { '[name=username]': new FakeInput('u'), '[name=password]': new FakeInput('p') };
    const ctx = {
      window: { HTMLInputElement: FakeInput },
      document: { querySelector: (sel) => els[sel] || null },
      Event: class { constructor(type) { this.type = type; } },
    };
    assert.equal(vm.runInNewContext(js, ctx), 'FILLED');
    assert.equal(values.u, "o'neil@example.test");
    assert.equal(values.p, pw);

    const empty = { ...ctx, document: { querySelector: () => null } };
    assert.equal(vm.runInNewContext(js, empty), 'NOFORM');
  });
});

test.describe('constants', () => {
  const c = require(path.join(H.SCRIPTS, 'constants.js'));

  test('paths follow RESOURCER_HOME', () => {
    assert.equal(c.WORKSPACE, home);
    assert.equal(c.DOWNLOADS, path.join(home, 'downloads'));
    assert.equal(c.RUNS_DIR, path.join(home, 'runs'));
    assert.equal(c.LOGS_DIR, path.join(home, 'logs'));
    assert.equal(c.DB_PATH, path.join(home, 'candidates.db'));
    assert.equal(c.CREDS_PATH, path.join(home, 'secrets', 'zoho-credentials.json'));
    assert.equal(c.SESSION_PATH, path.join(home, 'state', 'caterer-session.json'));
  });

  test('business constants and status sets are unchanged', () => {
    assert.equal(c.BASE_CATERER, 'https://recruiter.caterer.com');
    assert.equal(c.RECRUIT_BASE, 'https://recruit.zoho.eu');
    assert.equal(c.CREDITS_TOTAL, 62475);
    assert.equal(c.CREDITS_EXPIRY, '2027-03-11');
    assert.equal(c.DAILY_QUOTA, 248);
    assert.deepEqual(c.RUN_STATUS, {
      INITIALIZING: 'phase1_initializing', SEARCHING: 'phase1_searching', ACTIVE: 'phase1_active', RUNNING: 'phase1_running',
      COMPLETE: 'phase1_complete', ABANDONED: 'phase1_abandoned', PHASE2_START: 'phase2_starting', PHASE2_PUSH: 'phase2_pushing',
      DONE: 'complete', ERROR: 'error',
    });
    assert.deepEqual(c.IN_FLIGHT_STATUSES, ['phase1_initializing', 'phase1_searching', 'phase1_active', 'phase1_running', 'phase1_complete', 'phase2_starting', 'phase2_pushing']);
    assert.deepEqual(c.TERMINAL_STATUSES, ['phase1_abandoned', 'complete', 'error', 'phase1_stale']);
  });
});

test.describe('env.redact knows the credential files in secrets/', () => {
  test('values of secret-named keys in secrets/*.json are hidden, other values are not', () => {
    const secretsDir = path.join(home, 'secrets');
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(path.join(secretsDir, 'zoho-credentials.json'), JSON.stringify({ client_id: 'ID-visible-1000', client_secret: 'SECRET-value-aaaa1111', refresh_token: 'REFRESH-value-bbbb2222' }));
    fs.writeFileSync(path.join(secretsDir, 'caterer-credentials.json'), JSON.stringify({ username: 'someone@example.invalid', password: 'PW-value-cccc3333' }));
    fs.writeFileSync(path.join(secretsDir, 'broken.json'), '{ not json');
    const env = require(path.join(H.SCRIPTS, 'lib', 'env.js'));
    const out = env.redact('echo: SECRET-value-aaaa1111 | REFRESH-value-bbbb2222 | PW-value-cccc3333 | ID-visible-1000 | someone@example.invalid');
    assert.equal(out, 'echo: *** | *** | *** | ID-visible-1000 | someone@example.invalid');
  });
});
