'use strict';
// tools/preflight.sh lists environment variable NAMES only. A multi-line value shows up in env(1) as extra lines that are not
// NAME=value: they are not names, must not be printed, and must not trigger the AGENT_BROWSER_ warning.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./_helpers');

H.installNetworkGuard();
const SKIP = !H.IS_LINUX && 'the probe reads /proc and runs under POSIX sh (verified on Linux, WSL)';
const SCRIPT = path.join(H.REPO, 'tools', 'preflight.sh');
const PROBE_SECRET = 'PROBE-CONTINUATION-SECRET-TOKEN-do-not-print';

const shells = H.IS_LINUX ? ['sh', 'dash', 'bash'].filter((s) => spawnSync('sh', ['-c', `command -v ${s}`]).status === 0) : ['sh'];

// The probe reads its profile from its own location: a copy under <profile>/scripts keeps every file it touches in a temp dir.
function profile(t) {
  const root = H.mkHome(t, 'pfenv');
  const prof = path.join(root, 'prof');
  fs.mkdirSync(path.join(prof, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(prof, 'workspace', 'resourcer'), { recursive: true });
  const script = path.join(prof, 'scripts', 'resourcer-envprobe.sh');
  fs.copyFileSync(SCRIPT, script);
  fs.writeFileSync(path.join(prof, 'cron-envprobe.state'), '999999 0\n');
  return { prof, script };
}

function probe(shell, p, env) {
  const e = Object.assign({ PATH: process.env.PATH, HOME: p.prof }, env);
  return spawnSync(shell, [p.script], { encoding: 'utf8', env: e, timeout: 60000 });
}

function namesLine(out) {
  const lines = out.split('\n');
  const i = lines.findIndex((l) => /^ENVPROBE variable NAMES matching /.test(l));
  assert.ok(i >= 0, 'the header line is printed');
  assert.match(lines[i], /\(names only\):$/);
  return { header: lines[i], names: lines[i + 1], next: lines[i + 2] };
}

for (const shell of shells) {
  test(`env probe under ${shell}: a multi-line value contributes no continuation lines, only real names are listed, in the same format`, { skip: SKIP, timeout: 90000 }, (t) => {
    const p = profile(t);
    const multi = `first line\n${PROBE_SECRET} KEY continuation\nTOKEN words only\nlast`;
    const r = probe(shell, p, { MULTI_KEY_BLOB: multi, RESOURCER_PROBE_A: '1', PROBE_PASSWORD: 'x', UNRELATED_NAME: 'y' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(PROBE_SECRET), 'no part of a value is ever printed');
    assert.doesNotMatch(r.stdout, /TOKEN words only/);
    const { names, next } = namesLine(r.stdout);
    assert.equal(names, 'MULTI_KEY_BLOB PROBE_PASSWORD RESOURCER_PROBE_A ', 'sorted names, one space after each, nothing else');
    assert.match(next, /^ENVPROBE AI_GATEWAY_API_KEY in the process environment: absent/, 'the next probe line follows the names line directly');
    assert.match(r.stdout, /^ENVPROBE_DONE$/m);
  });

  test(`env probe under ${shell}: a plain environment prints the same list as before`, { skip: SKIP, timeout: 90000 }, (t) => {
    const p = profile(t);
    const r = probe(shell, p, { HERMES_HOME: p.prof, AI_GATEWAY_API_KEY_NOT: 'v', CHROMIUM_PATH: '/x', NODE_ENV: 'test' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const { names } = namesLine(r.stdout);
    assert.equal(names, 'AI_GATEWAY_API_KEY_NOT CHROMIUM_PATH HERMES_HOME NODE_ENV ');
  });
}

test('env probe: an environment with no matching name prints an empty names line', { skip: SKIP, timeout: 90000 }, (t) => {
  const p = profile(t);
  const r = probe('sh', p, { NOTHING_HERE: 'a\nKEY words' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(namesLine(r.stdout).names, '');
});

test('the same NAME=value rule guards the AGENT_BROWSER_ check in the full probe: a continuation line that only starts with the prefix does not warn, a real variable does', { skip: SKIP, timeout: 180000 }, (t) => {
  const root = H.mkHome(t, 'pfc16');
  const rh = path.join(root, 'rh');
  fs.mkdirSync(rh, { recursive: true });
  const run = (env) => spawnSync('sh', [SCRIPT, '--offline', '--no-browser'], {
    encoding: 'utf8', timeout: 150000,
    env: Object.assign({ PATH: process.env.PATH, HOME: root, RESOURCER_HOME: rh, PROFILE_HOME: root }, env),
  });
  let r = run({ NOTES: `a\nAGENT_BROWSER_LOOKALIKE and more words\nb` });
  assert.match(r.stdout, /^PASS C16 no AGENT_BROWSER_\* variables in the environment$/m, r.stdout.split('\n').filter((l) => /C16/.test(l)).join('\n'));
  r = run({ AGENT_BROWSER_HOME: '/x', AGENT_BROWSER_V2: '1', NOTES: 'a\nAGENT_BROWSER_LOOKALIKE and more words' });
  const line = r.stdout.split('\n').find((l) => /C16/.test(l));
  const m = /^WARN C16 AGENT_BROWSER_\* variables are set in this shell \((.*)\):/.exec(line);
  assert.ok(m, line);
  assert.deepEqual(m[1].trim().split(' ').sort(), ['AGENT_BROWSER_HOME', 'AGENT_BROWSER_V2'], 'the names, in the format the warning always had');
  assert.doesNotMatch(r.stdout, /LOOKALIKE/);
});
