'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

function setup(t, envExtra) {
  const sb = H.buildSandbox({ prefix: 'rb-cred-' });
  sb.activate(envExtra);
  t.after(() => sb.cleanup());
  return { sb, fake: sb.fake, mod: sb.load('caterer-get-credits.js') };
}

test('warm session: prints the integer, writes credits-sync.json, never loads or saves state', async (t) => {
  const { sb, fake } = setup(t);
  fake.warmLoggedIn();
  const r = sb.run('caterer-get-credits.js', []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '44463');
  assert.match(r.stderr, /Credits remaining: 44463/);
  const sync = sb.readJson('credits-sync.json');
  assert.equal(sync.credits, 44463);
  assert.equal(sync.source, 'warm-dom');
  assert.ok(Date.now() - Date.parse(sync.syncedAt) < 60000);
  assert.equal(fake.calls('state').length, 0, 'Akamai rule: no state load/save here');
  assert.deepEqual(fake.trail().map((x) => x.split(' ')[0]), ['open', 'wait', 'eval']);
  assert.equal(fake.trail()[0], 'open https://recruiter.caterer.com/CandidateSearchWebMvc/CandidateSearch');
});

test('phase1 style parsing: only the digit line is picked out of merged output', async (t) => {
  const { sb, fake } = setup(t);
  fake.warmLoggedIn();
  const r = sb.run('caterer-get-credits.js', []);
  const merged = (r.stderr + r.stdout).split('\n').filter((l) => /^\d+$/.test(l));
  assert.deepEqual(merged, ['44463']);
});

test('logged out: exit 2, "unknown", reason on stderr, one settle re-read, no state load', async (t) => {
  const { sb, fake } = setup(t);
  const r = sb.run('caterer-get-credits.js', []);
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), 'unknown');
  assert.match(r.stderr, /logged out/);
  assert.equal(fake.calls('eval').length, 2, 'read twice before condemning the session (post re-login false negative)');
  assert.equal(fake.calls('state').length, 0);
  assert.equal(sb.readJson('credits-sync.json'), null, 'nothing written on failure');
});

test('a first unknown read that settles on the second read succeeds', async (t) => {
  const { sb, fake } = setup(t);
  fake.warmLoggedIn();
  fake.scenario({ rules: [{ when: { cmd: 'eval', scriptIncludes: 'Credits', nth: 1 }, do: { stdout: '"unknown"', code: 0 } }] });
  const r = sb.run('caterer-get-credits.js', []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '44463');
});

test('falls back to the "Credits Remaining" text when the widget is missing', async (t) => {
  const { sb, fake } = setup(t);
  fake.warmLoggedIn();
  fake.scenario({ site: { creditsWidget: false } });
  const r = sb.run('caterer-get-credits.js', []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '44463');
});

test('implausible values are rejected like the legacy bounds (0 < n <= 200000)', async (t) => {
  const { sb, fake } = setup(t);
  fake.warmLoggedIn();
  fake.scenario({ site: { credits: 999999 } });
  const r = sb.run('caterer-get-credits.js', []);
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), 'unknown');
});

test('CV Database module failing: exit 2 like before, but stderr names it and nothing tries to log in', async (t) => {
  const { sb, fake } = setup(t);
  fake.warmLoggedIn();
  fake.scenario({ site: { cvdbModuleError: true } });
  const r = sb.run('caterer-get-credits.js', []);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /CVDB_MODULE_ERROR/);
  assert.ok(!fake.trail().some((x) => x.includes('/login')));
});

test('--quiet suppresses stderr; --help exits 0', async (t) => {
  const { sb, fake } = setup(t);
  fake.warmLoggedIn();
  const q = sb.run('caterer-get-credits.js', ['--quiet']);
  assert.equal(q.status, 0);
  assert.equal(q.stderr, '');
  const h = sb.run('caterer-get-credits.js', ['--help']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /Usage/);
});

test('parseCreditsAnswer: colour codes, quotes, last numeric line wins, LOGIN, bounds', (t) => {
  const { mod } = setup(t);
  const p = mod.parseCreditsAnswer;
  assert.equal(p('"44463"').credits, 44463);
  assert.equal(p('\x1b[32m\u2713 noise\x1b[0m\n123\n"5000"\n').credits, 5000);
  assert.equal(p('"LOGIN"').login, true);
  assert.equal(p('"unknown"').credits, null);
  assert.equal(p('0').credits, null);
  assert.equal(p('200001').credits, null);
  assert.equal(p('200000').credits, 200000);
  assert.equal(p('').credits, null);
});

test('the credits script keeps its regex escapes (the 2026-09-04 lost-backslash defect class)', (t) => {
  const { mod } = setup(t);
  assert.ok(mod.CREDITS_JS.includes('\\s+Remaining'));
  assert.ok(mod.CREDITS_JS.includes('[\\d,]{4,7}'));
  assert.ok(mod.CREDITS_JS.includes('\\d/.test('));
});

test('--update-db updates the latest territory_searches row and closes the db (driver injected)', (t) => {
  const { mod } = setup(t);
  const log = [];
  class FakeDb {
    constructor(file) { log.push(['open', path.basename(file)]); }
    pragma(p) { log.push(['pragma', p]); }
    prepare(sql) {
      return {
        get: () => { log.push(['get', sql.slice(0, 30)]); return { name: 'territory_searches' }; },
        run: (v) => { log.push(['run', sql, v]); },
      };
    }
    close() { log.push(['close']); }
  }
  mod.updateCreditsInDb(123, FakeDb);
  assert.deepEqual(log[0], ['open', 'candidates.db']);
  assert.ok(log.some((l) => l[0] === 'pragma' && /busy_timeout/.test(l[1])));
  assert.ok(log.some((l) => l[0] === 'run' && /UPDATE territory_searches SET credits_remaining/.test(l[1]) && l[2] === 123));
  assert.deepEqual(log[log.length - 1], ['close']);
  const none = [];
  class NoTable extends FakeDb { prepare(sql) { return { get: () => undefined, run: () => none.push(sql) }; } }
  mod.updateCreditsInDb(5, NoTable);
  assert.deepEqual(none, [], 'no update when the table does not exist');
});

test('a missing DB driver only costs the DB update (legacy: "DB update skipped")', async (t) => {
  const { sb, fake } = setup(t);
  fake.warmLoggedIn();
  const r = sb.run('caterer-get-credits.js', ['--update-db']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '44463');
  void fs;
});
