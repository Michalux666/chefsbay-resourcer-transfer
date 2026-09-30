'use strict';

// How the launcher recognises the Reed browser in the process table. Real Chromium rewrites /proc/<pid>/cmdline into ONE space-joined
// element, ordinary processes have one element per argument: both shapes, and look-alikes, must classify correctly. Pure functions,
// no /proc access, runs everywhere.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(process.env.REED_TEST_TMP || os.tmpdir(), 'reedproc-'));
process.env.RESOURCER_HOME = TMP;
process.env.HERMES_HOME = path.join(TMP, 'hh');
process.env.RESOURCER_ENV_FILE = path.join(TMP, 'none.env');
const launcher = require(path.resolve(__dirname, '..', '..', 'resourcer', 'scripts', 'ensure-chrome-cdp.js'));
test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

const PROFILE = '/data/state/chrome-reed';
const C = { profile: PROFILE };
const FLAGS = `--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=${PROFILE} --no-first-run --password-store=basic about:blank`;
const proc = (pid, ...args) => ({ pid, ppid: 1, args });
const pids = (list) => launcher.profileProcs(C, list).map((p) => p.pid);

test('a rewritten cmdline (ONE space-joined element) is found; so is an ordinary one-element-per-argument cmdline', () => {
  const joined = proc(10, `/usr/lib/chromium/chromium ${FLAGS}`);
  const split = proc(11, '/usr/bin/chromium', '--remote-debugging-port=9222', `--user-data-dir=${PROFILE}`, 'about:blank');
  const wrapper = proc(12, '/bin/sh', '/usr/bin/xvfb-run', '-a', '-s', '-screen 0 1920x1080x24', '/usr/bin/chromium', ...FLAGS.split(' '));
  assert.deepStrictEqual(pids([joined, split, wrapper]), [10, 11, 12]);
});

test('a record with a precomputed cmd is used as given, one with only args is joined', () => {
  assert.strictEqual(launcher.cmdOf({ cmd: 'a b', args: ['x'] }), 'a b');
  assert.strictEqual(launcher.cmdOf({ args: ['a', 'b c'] }), 'a b c');
  assert.strictEqual(launcher.cmdOf({}), '');
  assert.deepStrictEqual(pids([{ pid: 5, cmd: `chromium ${FLAGS}` }]), [5]);
});

test('the flag must be a whole argument: another profile that merely starts with the same path, a file under the profile, and unrelated processes do not match', () => {
  const list = [
    proc(20, `/usr/lib/chromium/chromium --user-data-dir=${PROFILE}-caterer --no-first-run`),
    proc(21, `/usr/lib/chromium/chromium --user-data-dir=${PROFILE}2`),
    proc(22, 'tail', '-f', `${PROFILE}/reed-chrome.log`),
    proc(23, `/usr/lib/chromium/chromium --user-data-dir=/other/state/chrome-reed`),
    proc(24, 'node', 'server.js'),
    proc(25),
    proc(26, `chromium --disk-cache-dir=${PROFILE} --no-first-run`),
  ];
  assert.deepStrictEqual(pids(list), []);
});

test('the flag is found at the start, in the middle and at the very end of the joined line', () => {
  assert.deepStrictEqual(pids([proc(30, `--user-data-dir=${PROFILE} --x`), proc(31, `chromium --a --user-data-dir=${PROFILE} --b`), proc(32, `chromium --a --user-data-dir=${PROFILE}`)]), [30, 31, 32]);
});

test('a profile path with spaces still matches (the joined line is compared as text)', () => {
  const spaced = { profile: '/data/my state/chrome-reed' };
  const list = [proc(40, `chromium --remote-debugging-port=9222 --user-data-dir=${spaced.profile} --no-first-run`), proc(41, `chromium --user-data-dir=${spaced.profile}x`)];
  assert.deepStrictEqual(launcher.profileProcs(spaced, list).map((p) => p.pid), [40]);
});

test('hasFlag is the whole-argument test on a joined line', () => {
  assert.strictEqual(launcher.hasFlag('a --f=1 b', '--f=1'), true);
  assert.strictEqual(launcher.hasFlag('a --f=12 b', '--f=1'), false);
  assert.strictEqual(launcher.hasFlag('a x--f=1 b', '--f=1'), false);
  assert.strictEqual(launcher.hasFlag('--f=1', '--f=1'), true);
});
