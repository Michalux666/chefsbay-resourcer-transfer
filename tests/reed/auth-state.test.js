'use strict';

// The Reed auth state shared by the login, refresh, phase 1 and run-pipeline: status file shape (docs/parity/dashboard.md section 5),
// once-per-episode alerts, the RESOURCER_SOURCES gate status, the hold decision, and the CLI that exposes them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(process.env.REED_TEST_TMP || os.tmpdir(), 'reedauth-'));
process.env.RESOURCER_HOME = TMP;
process.env.HERMES_HOME = path.join(TMP, 'hh');
process.env.RESOURCER_ENV_FILE = path.join(TMP, 'none.env');
for (const k of Object.keys(process.env)) if (/^(REED_|RESOURCER_SOURCES)/.test(k)) delete process.env[k];
const SCRIPT = path.resolve(__dirname, '..', '..', 'resourcer', 'scripts', 'reed-api-client.js');
const api = require(SCRIPT);

const HOUR = 3600000;
const iso = (agoMs) => new Date(Date.now() - agoMs).toISOString();
const rt = (name) => path.join(TMP, 'runtime', name);
const writeRt = (name, body) => { fs.mkdirSync(path.dirname(rt(name)), { recursive: true }); fs.writeFileSync(rt(name), typeof body === 'string' ? body : JSON.stringify(body)); };
const readRt = (name) => JSON.parse(fs.readFileSync(rt(name), 'utf8'));
const alertsFile = path.join(TMP, 'outbox', 'alerts.jsonl');
const alerts = () => { try { return fs.readFileSync(alertsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const sleeper = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });

function reset() {
  for (const d of ['runtime', 'outbox']) fs.rmSync(path.join(TMP, d), { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (/^(REED_|RESOURCER_SOURCES)/.test(k)) delete process.env[k];
}
test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });
test.beforeEach(reset);

// ------------------------------------------------------------------ runtime/reed-status.json

test('status file shape is exactly {state, updatedAt (ISO), detail (string)} for every state', () => {
  for (const state of ['ok', 'auth_failed', 'disabled']) {
    assert.strictEqual(api.writeReedStatus(state, `why ${state}`), true);
    const s = readRt('reed-status.json');
    assert.deepStrictEqual(Object.keys(s).sort(), ['detail', 'state', 'updatedAt']);
    assert.strictEqual(s.state, state);
    assert.strictEqual(new Date(s.updatedAt).toISOString(), s.updatedAt);
    assert.strictEqual(s.detail, `why ${state}`);
  }
  api.writeReedStatus('ok');
  assert.strictEqual(readRt('reed-status.json').detail, '', 'detail is always present');
  api.writeReedStatus('ok', null);
  assert.strictEqual(readRt('reed-status.json').detail, '');
});

test('status writes reject unknown states, cut the detail at 200 characters and redact secrets', () => {
  api.writeReedStatus('ok', 'first');
  assert.strictEqual(api.writeReedStatus('broken', 'x'), false);
  assert.strictEqual(api.writeReedStatus('', 'x'), false);
  assert.strictEqual(readRt('reed-status.json').detail, 'first', 'a rejected state leaves the file alone');
  api.writeReedStatus('auth_failed', 'x'.repeat(500));
  assert.strictEqual(readRt('reed-status.json').detail.length, 200);
  process.env.TEST_REED_PASSWORD = 'sentinel-secret-value-77';
  try {
    api.writeReedStatus('auth_failed', 'login failed with sentinel-secret-value-77 inside');
    assert.ok(!fs.readFileSync(rt('reed-status.json'), 'utf8').includes('sentinel-secret-value-77'));
  } finally { delete process.env.TEST_REED_PASSWORD; }
});

test('readReedStatus ignores a file without a string state', () => {
  assert.strictEqual(api.readReedStatus(), null);
  writeRt('reed-status.json', { state: 7 });
  assert.strictEqual(api.readReedStatus(), null);
  writeRt('reed-status.json', '{oops');
  assert.strictEqual(api.readReedStatus(), null);
  api.writeReedStatus('ok', 'fine');
  assert.strictEqual(api.readReedStatus().state, 'ok');
});

// ------------------------------------------------------------------ alerts: one per episode

test('alertOnce raises the first alert of a key, stays silent while the episode is open, and again after clearAlertEpisode', () => {
  assert.strictEqual(api.alertOnce('k1', { severity: 'critical', text: 'first' }), true);
  assert.strictEqual(api.alertOnce('k1', { severity: 'critical', text: 'again' }), false);
  assert.strictEqual(api.alertOnce('k2', { severity: 'warn', text: 'other key' }), true);
  assert.deepStrictEqual(alerts().map((a) => [a.key, a.severity, a.text]), [['k1', 'critical', 'first'], ['k2', 'warn', 'other key']]);
  api.clearAlertEpisode('k1');
  assert.strictEqual(api.alertOnce('k1', { severity: 'critical', text: 'new episode' }), true);
  assert.strictEqual(alerts().length, 3);
  api.clearAlertEpisode('never-opened', 'k2');
  assert.strictEqual(api.alertOnce('k2', { severity: 'warn', text: 'k2 again' }), true);
});

test('alertOnce reminds once REED_ALERT_REMIND_HOURS has passed (72 h default) and never when it is 0; a corrupt episode file just alerts', () => {
  writeRt('reed-alert-episodes.json', { k: { at: iso(71 * HOUR) } });
  assert.strictEqual(api.alertOnce('k', { text: 'a' }), false, '71 h: still the same episode');
  writeRt('reed-alert-episodes.json', { k: { at: iso(73 * HOUR) } });
  assert.strictEqual(api.alertOnce('k', { text: 'b' }), true, '73 h: reminder');
  assert.ok(Date.now() - Date.parse(readRt('reed-alert-episodes.json').k.at) < 60000);
  writeRt('reed-alert-episodes.json', { k: { at: iso(500 * HOUR) } });
  process.env.REED_ALERT_REMIND_HOURS = '0';
  assert.strictEqual(api.alertOnce('k', { text: 'c' }), false, 'reminders off');
  delete process.env.REED_ALERT_REMIND_HOURS;
  writeRt('reed-alert-episodes.json', '{corrupt');
  assert.strictEqual(api.alertOnce('k', { text: 'd' }), true);
});

// ------------------------------------------------------------------ RESOURCER_SOURCES gate

test('sourcesGate: caterer is the default, reed and both enable Reed, anything else is caterer', () => {
  const g = (v) => { if (v === undefined) delete process.env.RESOURCER_SOURCES; else process.env.RESOURCER_SOURCES = v; return api.sourcesGate(); };
  assert.deepStrictEqual(g(undefined), { raw: 'caterer', value: 'caterer', valid: true, reedEnabled: false });
  assert.strictEqual(g('both').reedEnabled, true);
  assert.strictEqual(g(' REED ').value, 'reed');
  assert.strictEqual(g('reed').reedEnabled, true);
  const bad = g('everything');
  assert.deepStrictEqual([bad.valid, bad.value, bad.reedEnabled, bad.raw], [false, 'caterer', false, 'everything']);
});

test('syncGateStatus writes disabled only when Reed is excluded, does not rewrite an unchanged flag, and removes a stale one; other states are left alone', () => {
  process.env.RESOURCER_SOURCES = 'caterer';
  assert.deepStrictEqual(api.syncGateStatus(), { state: 'disabled', changed: true });
  const first = readRt('reed-status.json');
  assert.deepStrictEqual(Object.keys(first).sort(), ['detail', 'state', 'updatedAt']);
  assert.strictEqual(first.detail, 'RESOURCER_SOURCES=caterer');
  assert.deepStrictEqual(api.syncGateStatus(), { state: 'disabled', changed: false });
  assert.strictEqual(readRt('reed-status.json').updatedAt, first.updatedAt);
  process.env.RESOURCER_SOURCES = 'nonsense';
  assert.strictEqual(api.syncGateStatus().changed, true, 'the detail names the value that was set');
  assert.strictEqual(readRt('reed-status.json').detail, 'RESOURCER_SOURCES=nonsense');
  process.env.RESOURCER_SOURCES = 'both';
  assert.deepStrictEqual(api.syncGateStatus(), { state: null, changed: true });
  assert.strictEqual(fs.existsSync(rt('reed-status.json')), false);
  api.writeReedStatus('auth_failed', 'real failure');
  assert.deepStrictEqual(api.syncGateStatus(), { state: 'auth_failed', changed: false });
  assert.strictEqual(readRt('reed-status.json').detail, 'real failure');
});

// ------------------------------------------------------------------ the hold

test('authHold: nothing recorded means no hold; a young block holds for the block window, an old one does not', () => {
  assert.strictEqual(api.authHold(), null);
  writeRt('reed-login-block.json', { blockedAt: iso(HOUR), reason: 'turnstile_unsolved', attempts: 1 });
  const h = api.authHold();
  assert.strictEqual(h.reason, 'human_login_pending');
  assert.match(h.detail, /turnstile_unsolved/);
  writeRt('reed-login-block.json', { blockedAt: iso(13 * HOUR), reason: 'x', attempts: 1 });
  assert.strictEqual(api.authHold(), null);
  process.env.REED_LOGIN_BLOCK_HOURS = '24';
  assert.strictEqual(api.authHold().reason, 'human_login_pending', 'the window is REED_LOGIN_BLOCK_HOURS');
  writeRt('reed-login-block.json', { reason: 'no date' });
  assert.strictEqual(api.authHold(), null, 'a block without a date holds nothing');
});

test('authHold: marker reasons and windows', () => {
  const at = (reason, agoMs, extra) => { writeRt('reed-auth-failed.marker', { reason, failedAt: iso(agoMs), ...(extra || {}) }); return api.authHold(); };
  assert.strictEqual(at('turnstile_blocked', 11 * HOUR).reason, 'turnstile_blocked');
  assert.strictEqual(at('turnstile_blocked', 13 * HOUR), null);
  assert.strictEqual(at('reed_451_international', 3 * HOUR).reason, 'reed_451_international');
  assert.strictEqual(at('reed_451_international', 13 * HOUR), null);
  assert.strictEqual(at('auto_login_failed', 29 * 60000).reason, 'auto_login_failed');
  assert.strictEqual(at('auto_login_failed', 31 * 60000), null);
  assert.strictEqual(at('reed_credentials_missing', 60000).reason, 'reed_credentials_missing');
  assert.strictEqual(at('browser_lock_busy', 1000), null, 'a lock conflict is not an auth failure');
  assert.strictEqual(at('some_future_reason', 60000).reason, 'some_future_reason');
  process.env.REED_AUTH_HOLD_MIN = '5';
  assert.strictEqual(at('auto_login_failed', 6 * 60000), null, 'REED_AUTH_HOLD_MIN sets the short window');
  assert.strictEqual(at('turnstile_blocked', 6 * 60000).reason, 'turnstile_blocked', 'but not the people-needed one');
  const h = at('auto_login_failed', 60000);
  assert.ok(Date.parse(h.since) > Date.now() - 120000);
  fs.unlinkSync(rt('reed-auth-failed.marker'));
  assert.strictEqual(api.authHold(), null);
});

test('authHold: a live human-login session holds; a dead one, a foreign Caterer run, an ordinary Reed run and our own lock do not', () => {
  const holder = sleeper();
  const dead = spawnSync(process.execPath, ['-e', '0']);
  const lock = (rec) => writeRt('browser.lock', { startedAt: new Date().toISOString(), ...rec });
  try {
    lock({ owner: 'reed', pid: holder.pid, purpose: 'human-login' });
    assert.strictEqual(api.authHold().reason, 'human_login_in_progress');
    lock({ owner: 'reed', pid: dead.pid, purpose: 'human-login' });
    assert.strictEqual(api.authHold(), null, 'dead holder');
    lock({ owner: 'caterer', pid: holder.pid, purpose: 'human-login' });
    assert.strictEqual(api.authHold(), null, 'a Caterer run is the lock-wait path, not a hold');
    lock({ owner: 'reed', pid: holder.pid, purpose: 'reed-phase1' });
    assert.strictEqual(api.authHold(), null);
    lock({ owner: 'reed', pid: process.pid, purpose: 'human-login' });
    assert.strictEqual(api.authHold(), null, 'our own lock is not a hold against ourselves');
    lock({ owner: 'reed', pid: holder.pid, purpose: 'human-login', startedAt: iso(5 * HOUR) });
    assert.strictEqual(api.authHold(), null, 'a lock older than 4 h is stale');
  } finally { holder.kill(); }
});

// ------------------------------------------------------------------ markAuthOk

test('markAuthOk closes block, marker, status and the login episodes; HTTP 451 survives a refresh but not a completed login', () => {
  api.writeReedStatus('auth_failed', 'blocked');
  writeRt('reed-login-block.json', { blockedAt: iso(HOUR), reason: 'x', attempts: 1 });
  writeRt('reed-auth-failed.marker', { reason: 'turnstile_blocked', failedAt: iso(HOUR) });
  api.alertOnce('reed-human-login', { text: 'a' });
  api.alertOnce('reed-credentials', { text: 'b' });
  api.alertOnce('reed-451', { text: 'c' });
  api.markAuthOk('token refreshed');
  assert.strictEqual(readRt('reed-status.json').state, 'ok');
  assert.strictEqual(fs.existsSync(rt('reed-login-block.json')), false);
  assert.strictEqual(fs.existsSync(rt('reed-auth-failed.marker')), false);
  const eps = readRt('reed-alert-episodes.json');
  assert.deepStrictEqual(Object.keys(eps), ['reed-451']);
  writeRt('reed-auth-failed.marker', { reason: 'reed_451_international', failedAt: iso(HOUR) });
  api.markAuthOk('token refreshed again');
  assert.strictEqual(readRt('reed-auth-failed.marker').reason, 'reed_451_international', 'a refresh cannot fix a session created abroad');
  api.markAuthOk('login captured', { all: true });
  assert.strictEqual(fs.existsSync(rt('reed-auth-failed.marker')), false);
  assert.deepStrictEqual(Object.keys(readRt('reed-alert-episodes.json')), []);
});

// ------------------------------------------------------------------ CLI

function cli(args, env) {
  const e = { ...process.env, RESOURCER_HOME: TMP, ...(env || {}) };
  for (const k of ['RESOURCER_SOURCES']) if (!(env && k in env)) delete e[k];
  return spawnSync(process.execPath, [SCRIPT, ...args], { env: e, encoding: 'utf8', timeout: 30000 });
}

test('CLI --sync-status and --auth-state print JSON; --help documents both', () => {
  const help = cli(['--help']);
  assert.strictEqual(help.status, 0);
  assert.match(help.stdout, /--sync-status/);
  assert.match(help.stdout, /--auth-state/);
  const s = cli(['--sync-status'], { RESOURCER_SOURCES: 'caterer' });
  assert.strictEqual(s.status, 0, s.stderr);
  assert.deepStrictEqual(JSON.parse(s.stdout), { state: 'disabled', changed: true });
  const a = cli(['--auth-state'], { RESOURCER_SOURCES: 'both' });
  assert.strictEqual(a.status, 0, a.stderr);
  const j = JSON.parse(a.stdout);
  assert.strictEqual(j.reedEnabled, true);
  assert.strictEqual(j.status.state, 'disabled');
  assert.strictEqual(j.hold, null);
  writeRt('reed-login-block.json', { blockedAt: iso(1000), reason: 'turnstile_unsolved', attempts: 1 });
  assert.strictEqual(JSON.parse(cli(['--auth-state']).stdout).hold.reason, 'human_login_pending');
  assert.strictEqual(cli(['--bogus']).status, 1);
});
