'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const H = require('./_helpers');

H.installNetworkGuard();
process.env.RESOURCER_HOME = H.mkHome(null, 'wrapbase');
let Database = null;
try { Database = require('better-sqlite3'); } catch { /* backup wrapper test skips */ }

const HERMES_SCRIPTS = path.join(H.REPO, 'hermes', 'scripts');
const JOBS_FILE = path.join(H.REPO, 'hermes', 'cron', 'jobs.json');
const WRAPPERS = ['resourcer-tick.sh', 'resourcer-queue-due.sh', 'resourcer-alerts.sh', 'resourcer-maintenance.sh', 'resourcer-retention.sh', 'resourcer-backup.sh', 'resourcer-preflight.sh', 'resourcer-keepalive.sh'];
const POSIX = H.IS_WIN && 'POSIX shell wrappers run on Linux (WSL)';

// Banned tokens are assembled so this file itself stays clean under a repo-wide scan.
const BANNED = [
  ['C:', '\\'].join(''), ['C:', '/Users'].join(''), ['w', 'sl '].join(''), ['power', 'shell'].join(''), ['pw', 'sh'].join(''),
  ['open', 'claw'].join(''), ['pm', '2'].join(''), ['sch', 'tasks'].join(''), ['187', '89'].join(''), ['WHATS', 'APP'].join(''), ['ng', 'rok'].join(''),
];

// The cron creation scanner (hermes-operations.md 3.10) rejects raw text containing these.
const SCANNER = [
  /hermes\s+(?:-p\s+\S+\s+)?gateway\s+(?:restart|stop|uninstall)/i,
  /systemctl\s+(?:restart|stop|start)[^\n]*hermes-gateway/i,
  /launchctl[^\n]*hermes[^\n]*gateway/i,
  /\b(?:pkill|kill|taskkill)\b[^\n]*hermes[^\n]*gateway/i,
  /\b(?:pkill|killall)\b(?:\s+-f)?\s+python/i,
];

function profile(t, name) {
  const root = H.mkHome(t, name || 'profile');
  const prof = path.join(root, 'prof');
  fs.mkdirSync(path.join(prof, 'scripts'), { recursive: true });
  const home = path.join(prof, 'workspace', 'resourcer');
  fs.mkdirSync(home, { recursive: true });
  for (const d of ['runs', 'logs', 'runtime', 'pending-searches', 'outbox', 'scripts', 'scripts/lib', 'state', 'backups', 'downloads', 'ctl', 'markers']) fs.mkdirSync(path.join(home, d), { recursive: true });
  H.installScripts(home);
  for (const w of WRAPPERS) fs.copyFileSync(path.join(HERMES_SCRIPTS, w), path.join(prof, 'scripts', w));
  return { prof, home, script: (w) => path.join(prof, 'scripts', w) };
}

function runSh(script, env, opts) {
  const e = { ...process.env, ...(env || {}) };
  delete e.RESOURCER_HOME;
  return spawnSync('sh', [script], { encoding: 'utf8', env: { ...e, ...(env || {}) }, timeout: 60000, ...(opts || {}) });
}

// --- static checks (any platform) ---------------------------------------------------------------

test('shipped supervision files: ASCII only, LF only, none of the banned tokens', () => {
  const files = [
    ...WRAPPERS.map((w) => path.join(HERMES_SCRIPTS, w)), JOBS_FILE,
    ...['lib/tick.js', 'pipeline-watchdog.js', 'watchdog-runner.js', 'maintenance.js', 'alerts-deliver.js', 'backup-db.js'].map((f) => path.join(H.SRC_SCRIPTS, f)),
  ];
  for (const f of files) {
    const buf = fs.readFileSync(f);
    const text = buf.toString('latin1');
    assert.equal(/[^\x00-\x7F]/.test(text), false, `${path.basename(f)}: non-ASCII byte`);
    assert.equal(text.includes('\r'), false, `${path.basename(f)}: CR found`);
    for (const tok of BANNED) assert.equal(text.includes(tok), false, `${path.basename(f)} contains banned token ${tok}`);
    assert.equal(text.includes('\\\\'), false, `${path.basename(f)}: double-backslash literal`);
  }
});

test('cron scanner rules: no gateway lifecycle text in any wrapper or in the jobs file', () => {
  for (const f of [...WRAPPERS.map((w) => path.join(HERMES_SCRIPTS, w)), JOBS_FILE]) {
    const text = fs.readFileSync(f, 'utf8');
    for (const re of SCANNER) assert.equal(re.test(text), false, `${path.basename(f)} matches ${re}`);
    if (f.endsWith('.sh')) {
      assert.equal(/gateway/i.test(text), false, `${path.basename(f)} should not even mention a gateway`);
      assert.equal(/\bkill\b/i.test(text.replace(/^#.*$/gm, '')), false, `${path.basename(f)} has no kill command in code`);
    }
  }
});

test('wrappers are plain sh: no bashisms, set -u, and only real files (no symlink dependencies)', () => {
  for (const w of WRAPPERS) {
    const text = fs.readFileSync(path.join(HERMES_SCRIPTS, w), 'utf8');
    assert.match(text, /^#!\/bin\/sh\n/, w);
    assert.match(text, /\nset -u\n/, w);
    assert.equal(/(^|[\s;])\[\[\s|\bsource\b|<\(|\bfunction\b|\$\{[A-Za-z_]+\/\//.test(text), false, `${w} uses a bashism`);
    assert.equal(/\bnohup\b|\bsetsid\b|\bdisown\b/.test(text), false, `${w}: no shell-level backgrounding`);
    assert.equal(/ &\s*$/m.test(text), false, `${w}: no trailing &`);
    assert.match(text, /<\/dev\/null/, `${w}: stdin is not inherited`);
  }
  assert.match(fs.readFileSync(path.join(HERMES_SCRIPTS, 'resourcer-tick.sh'), 'utf8'), /-k 30 3450/, 'the tick has an outer timeout below the 3600 s cron limit');
});

test('sh -n accepts every wrapper', { skip: POSIX }, () => {
  for (const w of WRAPPERS) {
    const r = spawnSync('sh', ['-n', path.join(HERMES_SCRIPTS, w)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${w}: ${r.stderr}`);
  }
});

// --- jobs.json ----------------------------------------------------------------------------------

function cronFieldOk(field, min, max) {
  return field.split(',').every((part) => {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return false;
    if (m[2] !== undefined && Number(m[2]) < 1) return false;
    if (m[1] === '*') return true;
    const [a, b] = m[1].split('-').map(Number);
    return a >= min && (b === undefined ? a : b) <= max && (b === undefined || a <= b);
  });
}

function hoursOf(field) {
  const out = new Set();
  for (const part of field.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    const step = m[2] ? Number(m[2]) : 1;
    let a = 0;
    let b = 23;
    if (m[1] !== '*') { const r = m[1].split('-').map(Number); a = r[0]; b = r[1] === undefined ? r[0] : r[1]; }
    for (let h = a; h <= b; h += step) out.add(h);
  }
  return out;
}

test('jobs.json: eight jobs, valid schedules, existing scripts, CLI strings consistent with each spec', () => {
  const jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  assert.equal(jobs.profile, 'resourcer');
  assert.deepEqual(jobs.jobs.map((j) => j.name).sort(), ['resourcer-alerts', 'resourcer-backup', 'resourcer-keepalive', 'resourcer-maintenance', 'resourcer-preflight', 'resourcer-queue-due', 'resourcer-retention', 'resourcer-tick']);
  const names = new Set();
  for (const j of jobs.jobs) {
    assert.equal(names.has(j.name), false, 'unique names');
    names.add(j.name);
    const f = j.schedule.split(' ');
    assert.equal(f.length, 5, `${j.name}: five cron fields`);
    assert.ok(cronFieldOk(f[0], 0, 59) && cronFieldOk(f[1], 0, 23) && cronFieldOk(f[2], 1, 31) && cronFieldOk(f[3], 1, 12) && cronFieldOk(f[4], 0, 7), `${j.name}: ${j.schedule}`);
    assert.ok(fs.existsSync(path.join(HERMES_SCRIPTS, j.script)), `${j.name}: script ${j.script} exists`);
    assert.match(j.script, /^[a-z0-9-]+\.sh$/);
    assert.equal(j.noAgent, true);
    assert.equal(j.deliver, jobs.delivery.placeholder, `${j.name}: one shared delivery target, never local`);
    assert.equal(j.failureDeliver, jobs.delivery.placeholder, `${j.name}: failure notices go to the same target`);
    assert.equal(j.workdir, jobs.paths.resourcerHome);
    const expected = `hermes -p resourcer cron create "${j.schedule}" --no-agent --script ${j.script} --name ${j.name} --deliver ${j.deliver} --failure-deliver ${j.failureDeliver} --workdir ${j.workdir}`;
    assert.equal(j.cli, expected, `${j.name}: cli string`);
    assert.equal(j.cliPaused, `${expected} --paused`);
    assert.ok(j.purpose.length > 40 && j.failureMeans);
  }
  for (const n of jobs.install.enableOrder) assert.ok(names.has(n), `enableOrder ${n}`);
  assert.equal(jobs.install.enableOrder.length, 8);
  assert.equal(new Set(jobs.install.enableOrder).size, 8);
  assert.deepEqual(jobs.install.enableOrder.slice(0, 3), ['resourcer-alerts', 'resourcer-queue-due', 'resourcer-tick'], 'delivery, queueing, then the tick');
  for (const p of jobs.prerequisites) assert.match(p.cli, /^hermes -p resourcer config (set|get) /);
});

test('jobs.json delivery: a human-set target replaces local everywhere, the install proves it, and the night is covered for criticals', () => {
  const raw = fs.readFileSync(JOBS_FILE, 'utf8');
  const jobs = JSON.parse(raw);
  assert.match(jobs.delivery.placeholder, /^<[A-Z_]+>$/, 'a placeholder that cannot be pasted into a shell by accident');
  assert.match(jobs.delivery.humanMustSet, /Stop and ask/);
  assert.match(jobs.delivery.why, /local/);
  for (const j of jobs.jobs) {
    assert.equal(/--deliver local|--failure-deliver local/.test(j.cli + j.cliPaused), false, `${j.name} is not created with local delivery`);
    assert.equal((j.cliPaused.match(/<DELIVER_TARGET>/g) || []).length, 2, `${j.name}: --deliver and --failure-deliver both take the target`);
    assert.match(j.cliPaused, /--deliver <DELIVER_TARGET> --failure-deliver <DELIVER_TARGET> --workdir /);
  }
  const alertsJob = jobs.jobs.find((j) => j.name === 'resourcer-alerts');
  const hours = hoursOf(alertsJob.schedule.split(' ')[1]);
  for (let h = 0; h <= 23; h++) assert.ok(hours.has(h), `the alert job fires in hour ${h}, so a night-time critical is delivered`);
  assert.equal(alertsJob.schedule.split(' ')[0], '*/5');
  assert.match(alertsJob.overnight, /critical/);
  assert.match(alertsJob.overnight, /06:00/);
  assert.ok(jobs.notes.some((n) => /^Overnight \(00:00-05:00\)/.test(n)), 'the overnight behaviour is stated in the notes');
  assert.equal(/because the alert job does not run overnight/.test(raw), false, 'the old claim is gone');
  const step3 = jobs.installSteps.steps.find((x) => x.n === 3);
  assert.ok(step3.verify.some((c) => /alerts-deliver\.js --test$/.test(c)) && step3.verify.some((c) => /cron run resourcer-alerts$/.test(c)));
  assert.match(step3.expect, /TEST ALERT/);
  assert.ok(jobs.acceptance.some((a) => /cron list/.test(a.check)) && jobs.acceptance.some((a) => /pipeline-watchdog\.js --status/.test(a.check) && /lastTickAt/.test(a.expect)));
});

test('jobs.json: the tick and alert schedules cover 05:00-23:59 and the queue job 05:00-21:59, in either timezone', () => {
  const jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  const by = Object.fromEntries(jobs.jobs.map((j) => [j.name, j]));
  const hours = (n) => hoursOf(by[n].schedule.split(' ')[1]);
  for (let h = 5; h <= 23; h++) assert.ok(hours('resourcer-tick').has(h), `tick fires in hour ${h}`);
  assert.equal(by['resourcer-tick'].schedule.split(' ')[0], '*', 'every minute');
  for (let h = 5; h <= 21; h++) assert.ok(hours('resourcer-queue-due').has(h));
  assert.ok(hours('resourcer-alerts').has(18), 'the 18:00 digest needs an alert run in hour 18');
  assert.ok(hours('resourcer-alerts').has(6) && hours('resourcer-alerts').has(7));
  assert.equal(by['resourcer-tick'].schedule.split(' ').slice(2).join(' '), '* * *');
  assert.equal(by['resourcer-preflight'].schedule, '50 5 * * *', 'ten minutes before the window');
  assert.equal(by['resourcer-keepalive'].schedule, '0 23,2,5 * * *');
  assert.match(by['resourcer-backup'].schedule, /^30 3 /);
  assert.match(by['resourcer-maintenance'].schedule, /^10 4 /);
  assert.equal(by['resourcer-retention'].schedule, '20 4 * * *', 'daily, after the housekeeping, before the window');
});

test('jobs.json: the two legacy Caterer schedules survive with their exact expressions and commands', () => {
  const jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  const by = Object.fromEntries(jobs.jobs.map((j) => [j.name, j]));
  assert.equal(by['resourcer-preflight'].schedule, '50 5 * * *');
  assert.match(by['resourcer-preflight'].legacy, /Caterer Daily Pre-Flight, 50 5 \* \* \*, Europe\/London/);
  assert.equal(by['resourcer-preflight'].command, 'node scripts/caterer-preflight.js');
  assert.equal(by['resourcer-keepalive'].schedule, '0 23,2,5 * * *');
  assert.match(by['resourcer-keepalive'].legacy, /Caterer Overnight Keep-Alive, 0 23,2,5 \* \* \*, Europe\/London/);
  assert.equal(by['resourcer-keepalive'].command, 'node scripts/caterer-preflight.js --keepalive');
  assert.equal(by['resourcer-retention'].command, 'node scripts/retention-sweep.js');
  assert.ok(jobs.prerequisites.some((p) => p.cli === 'hermes -p resourcer config set timezone Europe/London'), 'the London schedules need the timezone');
  const wrapper = (n) => fs.readFileSync(path.join(HERMES_SCRIPTS, n), 'utf8');
  assert.match(wrapper('resourcer-preflight.sh'), /scripts\/caterer-preflight\.js >>"\$LOG"/);
  assert.match(wrapper('resourcer-keepalive.sh'), /scripts\/caterer-preflight\.js --keepalive >>"\$LOG"/);
  assert.match(wrapper('resourcer-retention.sh'), /scripts\/retention-sweep\.js >>"\$LOG" 2>&1 <\/dev\/null/, 'the sweep writes to a log file, not to the cron pipe');
});

test('jobs.json installSteps: migrate, backfill, then alerts, queue-due, tick; not cron jobs; no gateway lifecycle text', () => {
  const raw = fs.readFileSync(JOBS_FILE, 'utf8');
  const jobs = JSON.parse(raw);
  const steps = jobs.installSteps.steps;
  assert.match(jobs.installSteps.note, /NOT cron jobs/);
  assert.deepEqual(steps.map((x) => x.n), [1, 2, 3, 4, 5, 6]);
  assert.match(steps[0].run, /node scripts\/migrate-schema\.js$/);
  assert.match(steps[1].run, /node scripts\/backfill-run-results\.js --strict$/);
  assert.equal(steps[2].run, 'hermes -p resourcer cron resume resourcer-alerts');
  assert.equal(steps[3].run, 'hermes -p resourcer cron resume resourcer-queue-due');
  assert.equal(steps[4].run, 'hermes -p resourcer cron resume resourcer-tick');
  assert.deepEqual(steps[5].run.map((c) => c.replace(/^.* /, '')).sort(), ['resourcer-backup', 'resourcer-keepalive', 'resourcer-maintenance', 'resourcer-preflight', 'resourcer-retention']);
  for (const st of steps) {
    const cmds = Array.isArray(st.run) ? st.run : [st.run];
    for (const c of cmds) {
      assert.match(c, /^(cd \S+ && node scripts\/[a-z-]+\.js( --strict)?|hermes -p resourcer cron resume resourcer-[a-z-]+)$/, c);
      const m = /cron resume (resourcer-[a-z-]+)$/.exec(c);
      if (m) assert.ok(jobs.jobs.some((j) => j.name === m[1]), `${m[1]} is a defined job`);
      const script = /node (scripts\/[a-z-]+\.js)/.exec(c);
      if (script) assert.ok(fs.existsSync(path.join(H.REPO, 'resourcer', script[1])), `${script[1]} exists`);
    }
    assert.ok(st.why && st.why.length > 20, `step ${st.n} says why`);
  }
  assert.deepEqual(jobs.install.enableOrder, ['resourcer-alerts', 'resourcer-queue-due', 'resourcer-tick', 'resourcer-backup', 'resourcer-maintenance', 'resourcer-retention', 'resourcer-keepalive', 'resourcer-preflight'], 'the summary list matches the steps');
  assert.equal(/gateway/i.test(raw), false, 'the spec never mentions a gateway at all');
  for (const re of SCANNER) assert.equal(re.test(raw), false, String(re));
  const cronFields = jobs.jobs.map((j) => j.schedule);
  assert.equal(cronFields.some((f) => /migrate|backfill/.test(f)), false, 'the one-time commands are not scheduled');
});

// --- running the wrappers -----------------------------------------------------------------------

test('tick wrapper: silent on success, logs to logs/tick-<date>.log, never leaves the wrapper failing', { skip: POSIX, timeout: 60000 }, (t) => {
  const p = profile(t);
  const r = runSh(p.script('resourcer-tick.sh'), { HERMES_HOME: p.prof });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, '', 'silent on success');
  assert.equal(r.stderr, '');
  const logs = fs.readdirSync(path.join(p.home, 'logs')).filter((f) => /^tick-\d{8}\.log$/.test(f));
  assert.equal(logs.length, 1);
  assert.match(fs.readFileSync(path.join(p.home, 'logs', logs[0]), 'utf8'), /tick end:/);
  const r2 = runSh(p.script('resourcer-tick.sh'), { HERMES_HOME: p.prof });
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout, '');
});

test('every wrapper derives RESOURCER_HOME from its own location when the environment is bare', { skip: POSIX, timeout: 60000 }, (t) => {
  const p = profile(t);
  const r = runSh(p.script('resourcer-queue-due.sh'), { HERMES_HOME: '' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.readdirSync(path.join(p.home, 'logs')).some((f) => f.startsWith('queue-due-')), 'ran against workspace/resourcer next to the scripts directory');
});

test('tick wrapper failure: exactly one line on stdout, the exit code, and the reason from the log', { skip: POSIX, timeout: 60000 }, (t) => {
  const p = profile(t);
  fs.writeFileSync(path.join(p.home, 'scripts', 'pipeline-watchdog.js'), 'throw new Error("tick exploded for the test");\n');
  const r = runSh(p.script('resourcer-tick.sh'), { HERMES_HOME: p.prof });
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim().split('\n').length, 1, 'one line');
  assert.match(r.stdout, /^resourcer-tick failed rc=1: /);
  assert.match(r.stdout, /tick exploded/);
});

test('wrapper preconditions: missing workspace exits 90, missing node exits 91, each with one line', { skip: POSIX, timeout: 60000 }, (t) => {
  const p = profile(t);
  const r = runSh(p.script('resourcer-tick.sh'), { HERMES_HOME: p.prof, RESOURCER_HOME: path.join(p.prof, 'nowhere') });
  assert.equal(r.status, 90);
  assert.equal(r.stdout.trim().split('\n').length, 1);

  const bin = path.join(p.prof, 'bin');
  fs.mkdirSync(bin);
  for (const tool of ['dirname', 'date', 'mkdir', 'tail', 'cut', 'timeout']) {
    const w = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (w) fs.symlinkSync(w, path.join(bin, tool));
  }
  const noNode = spawnSync('/bin/sh', [p.script('resourcer-tick.sh')], { encoding: 'utf8', env: { PATH: bin, HERMES_HOME: p.prof } });
  assert.equal(noNode.status, 91, noNode.stdout + noNode.stderr);
  assert.match(noNode.stdout, /node is not on PATH/);
});

test('queue-due wrapper: silent on success, one failure line when the queue script fails', { skip: POSIX, timeout: 60000 }, (t) => {
  const p = profile(t);
  let r = runSh(p.script('resourcer-queue-due.sh'), { HERMES_HOME: p.prof });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(fs.readFileSync(path.join(p.home, 'markers', 'queue-due.calls'), 'utf8').trim().split('\n').length, 1);
  H.setCtl(p.home, 'queue-due', { fail: true });
  fs.writeFileSync(path.join(p.home, 'runtime', 'queue-due-state.json'), '{"lastAt":0}');
  r = runSh(p.script('resourcer-queue-due.sh'), { HERMES_HOME: p.prof });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^resourcer-queue-due failed rc=1: /);
  assert.equal(r.stdout.trim().split('\n').length, 1);
});

test('alerts wrapper: its stdout IS the message; silent when there is nothing; errors go to the log', { skip: POSIX, timeout: 60000 }, (t) => {
  const p = profile(t);
  const line = JSON.stringify({ ts: new Date().toISOString(), severity: 'critical', key: 'w', text: 'wrapper alert text' });
  fs.writeFileSync(path.join(p.home, 'outbox', 'alerts.jsonl'), `${line}\n`);
  let r = runSh(p.script('resourcer-alerts.sh'), { HERMES_HOME: p.prof });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\[CRITICAL \d\d:\d\d\] wrapper alert text$/m);
  r = runSh(p.script('resourcer-alerts.sh'), { HERMES_HOME: p.prof });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.includes('wrapper alert text'), false);
  fs.unlinkSync(path.join(p.home, 'scripts', 'alerts-deliver.js'));
  r = runSh(p.script('resourcer-alerts.sh'), { HERMES_HOME: p.prof });
  assert.equal(r.status, 90);
  assert.match(r.stdout, /alerts-deliver\.js not found/);
});

test('alerts wrapper reports a crash of the deliverer as a failure line after any alerts it produced', { skip: POSIX, timeout: 60000 }, (t) => {
  const p = profile(t);
  fs.writeFileSync(path.join(p.home, 'scripts', 'alerts-deliver.js'), 'console.log("partial output"); process.exit(4);\n');
  const r = runSh(p.script('resourcer-alerts.sh'), { HERMES_HOME: p.prof });
  assert.equal(r.status, 4);
  assert.equal(r.stdout, 'partial output\nresourcer-alerts failed rc=4\n');
});

test('maintenance wrapper: silent success (or a single critical line when the disk is genuinely full)', { skip: POSIX, timeout: 60000 }, (t) => {
  const p = profile(t);
  const st = fs.statfsSync(p.home);
  const usedPct = ((st.blocks - st.bfree) / ((st.blocks - st.bfree) + st.bavail)) * 100;
  if (usedPct > 80) return t.skip(`test volume is ${Math.round(usedPct)}% full`);
  fs.writeFileSync(path.join(p.home, 'runs', 'phase1-old.json'), '{}');
  const old = new Date(Date.now() - 30 * 86400000);
  fs.utimesSync(path.join(p.home, 'runs', 'phase1-old.json'), old, old);
  const r = runSh(p.script('resourcer-maintenance.sh'), { HERMES_HOME: p.prof });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(path.join(p.home, 'runs', 'phase1-old.json')), false, 'it really ran');
});

test('backup wrapper: silent success creates an encrypted backup; missing passphrase is one failure line', { skip: POSIX || (!Database && 'better-sqlite3 is not installed'), timeout: 120000 }, (t) => {
  const p = profile(t);
  const db = new Database(path.join(p.home, 'candidates.db'));
  db.exec('CREATE TABLE candidates (id INTEGER PRIMARY KEY, x TEXT); INSERT INTO candidates (x) VALUES (\'a\'),(\'b\');');
  db.close();
  fs.writeFileSync(path.join(p.prof, '.env'), 'BACKUP_PASSPHRASE=a long enough passphrase for the wrapper test\n');
  let r = runSh(p.script('resourcer-backup.sh'), { HERMES_HOME: p.prof });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(fs.readdirSync(path.join(p.home, 'backups')).filter((f) => f.endsWith('.enc')).length, 1);
  fs.unlinkSync(path.join(p.prof, '.env'));
  r = runSh(p.script('resourcer-backup.sh'), { HERMES_HOME: p.prof, BACKUP_PASSPHRASE: '' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^resourcer-backup failed rc=1: /);
  assert.equal(r.stdout.trim().split('\n').length, 1);
});

test('the cron job pipes close even if the tick is killed while a run continues (no long-lived child holds them)', { skip: POSIX, timeout: 90000 }, async (t) => {
  const p = profile(t);
  H.seedDb(p.home);
  H.setCtl(p.home, 'phase1', { sleepMs: 6000 });
  H.pendingFile(p.home, 'territory-1-20260929-1000.json', { sources: 'caterer' });
  // A shim runs the real engine with the window forced open (the wrapper hard-codes its own command line).
  fs.renameSync(path.join(p.home, 'scripts', 'pipeline-watchdog.js'), path.join(p.home, 'scripts', 'pipeline-watchdog.real.js'));
  fs.writeFileSync(path.join(p.home, 'scripts', 'pipeline-watchdog.js'), `
const wd = require('./pipeline-watchdog.real.js');
const ctx = wd.makeCtx({ inWindow: () => true, slowChecks: async () => {}, diskGuard: () => ({}) });
wd.runTick(ctx, { maxMinutes: 3, superviseMs: 250 }).then((r) => process.exit(r.exitCode));
`);
  const files = require(path.join(H.SRC_SCRIPTS, 'lib', 'tick.js')).runtimeFiles(p.home);
  const env = { ...process.env, HERMES_HOME: p.prof, RESOURCER_SETTLE_MS: '0' };
  delete env.RESOURCER_HOME;
  const w = spawn('sh', [p.script('resourcer-tick.sh')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  w.stdout.on('data', (d) => { out += d; });
  const rec = await H.waitFor(() => { const r = H.readJson(files.run, null); return r && r.childPid ? r : null; }, 20000);
  assert.ok(rec, 'a run started');
  const lock = H.readJson(files.tickLock);
  process.kill(lock.pid, 'SIGKILL');
  const t0 = Date.now();
  const closed = await Promise.race([new Promise((resolve) => w.on('close', () => resolve(true))), new Promise((resolve) => setTimeout(() => resolve(false), 4000))]);
  assert.equal(closed, true, 'the wrapper finished and released its pipes although phase1 is still running');
  assert.ok(Date.now() - t0 < 4000);
  assert.equal(H.pidExists(rec.childPid), true, 'the run itself is untouched');
  assert.match(out, /^resourcer-tick failed rc=137/m, 'a killed tick is reported');
  t.after(() => { for (const pid of [rec.pid, rec.childPid]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });
});

test('preflight and keepalive wrappers run the right command, are silent on success and report the exit code on failure', { skip: POSIX, timeout: 60000 }, (t) => {
  const p = profile(t);
  let r = runSh(p.script('resourcer-preflight.sh'), { HERMES_HOME: p.prof });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, '');
  r = runSh(p.script('resourcer-keepalive.sh'), { HERMES_HOME: p.prof });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const calls = fs.readFileSync(path.join(p.home, 'markers', 'preflight.calls'), 'utf8').split('\n').filter((x, i, a) => i < a.length - 1);
  assert.deepEqual(calls, ['', '--keepalive']);
  assert.ok(fs.readdirSync(path.join(p.home, 'logs')).some((f) => f.startsWith('preflight-')));
  assert.ok(fs.readdirSync(path.join(p.home, 'logs')).some((f) => f.startsWith('keepalive-')));

  H.setCtl(p.home, 'preflight', { exit: 2 });
  r = runSh(p.script('resourcer-preflight.sh'), { HERMES_HOME: p.prof });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^resourcer-preflight failed rc=2: CATERER_SAFELIST_BLOCKED simulated$/m);
  assert.equal(r.stdout.trim().split('\n').length, 1);
});

test('maintenance wrapper runs only the housekeeping (the sweep is its own job) and reports its exit code', { skip: POSIX, timeout: 60000 }, (t) => {
  const p = profile(t);
  const sweep = path.join(p.home, 'scripts', 'retention-sweep.js');
  fs.writeFileSync(sweep, "require('fs').appendFileSync(require('path').join(process.env.RESOURCER_HOME, 'markers', 'order.txt'), 'sweep\\n');\n");
  const real = path.join(p.home, 'scripts', 'maintenance.js');
  fs.renameSync(real, path.join(p.home, 'scripts', 'maintenance.real.js'));
  fs.writeFileSync(real, "require('fs').appendFileSync(require('path').join(process.env.RESOURCER_HOME, 'markers', 'order.txt'), 'maint ' + process.argv.slice(2).join(' ') + '\\n'); process.exit(Number(process.env.MAINT_RC || 0));\n");
  let r = runSh(p.script('resourcer-maintenance.sh'), { HERMES_HOME: p.prof });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(fs.readFileSync(path.join(p.home, 'markers', 'order.txt'), 'utf8'), 'maint --daily\n', 'no sweep from the maintenance job');
  r = runSh(p.script('resourcer-maintenance.sh'), { HERMES_HOME: p.prof, MAINT_RC: '3' });
  assert.equal(r.status, 3);
  assert.match(r.stdout, /^resourcer-maintenance failed rc=3/);
  assert.equal(r.stdout.trim().split('\n').length, 1);
});

test('retention wrapper: the sweep summary goes to logs/retention-<date>.log, success is silent, failure is one line', { skip: POSIX, timeout: 60000 }, (t) => {
  const p = profile(t);
  const sweep = path.join(p.home, 'scripts', 'retention-sweep.js');
  fs.writeFileSync(sweep, "console.log(JSON.stringify({ ok: true, deleted: 0 })); console.error('a warning on stderr'); process.exit(Number(process.env.SWEEP_RC || 0));\n");
  let r = runSh(p.script('resourcer-retention.sh'), { HERMES_HOME: p.prof });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, '', 'stdout of the sweep never reaches the cron pipe');
  assert.equal(r.stderr, '');
  const logs = fs.readdirSync(path.join(p.home, 'logs')).filter((f) => /^retention-\d{8}\.log$/.test(f));
  assert.equal(logs.length, 1);
  const text = fs.readFileSync(path.join(p.home, 'logs', logs[0]), 'utf8');
  assert.match(text, /"deleted":0/);
  assert.match(text, /a warning on stderr/);
  r = runSh(p.script('resourcer-retention.sh'), { HERMES_HOME: p.prof, SWEEP_RC: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^resourcer-retention failed rc=1: /);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  fs.unlinkSync(sweep);
  r = runSh(p.script('resourcer-retention.sh'), { HERMES_HOME: p.prof });
  assert.equal(r.status, 90);
  assert.match(r.stdout, /retention-sweep\.js not found/);
});

test('retention wrapper against the real sweep on an empty workspace: exit 0 and a JSON summary in the log', { skip: POSIX || (!Database && 'better-sqlite3 is not installed'), timeout: 120000 }, (t) => {
  const p = profile(t);
  fs.cpSync(H.SRC_SCRIPTS, path.join(p.home, 'scripts'), { recursive: true });
  const r = runSh(p.script('resourcer-retention.sh'), { HERMES_HOME: p.prof });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, '');
  const log = fs.readdirSync(path.join(p.home, 'logs')).find((f) => /^retention-\d{8}\.log$/.test(f));
  const first = fs.readFileSync(path.join(p.home, 'logs', log), 'utf8').trim().split('\n').find((l) => l.startsWith('{'));
  assert.equal(JSON.parse(first).ok, true);
});

test('the tick wrapper works with the scrubbed environment Hermes gives cron scripts (PATH and HERMES_HOME only)', { skip: POSIX, timeout: 60000 }, (t) => {
  const p = profile(t);
  const r = spawnSync('sh', [p.script('resourcer-tick.sh')], { encoding: 'utf8', env: { PATH: process.env.PATH, HERMES_HOME: p.prof }, timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, '');
  const log = fs.readdirSync(path.join(p.home, 'logs')).find((f) => /^tick-\d{8}\.log$/.test(f));
  assert.match(fs.readFileSync(path.join(p.home, 'logs', log), 'utf8'), /tick end:/);
  const q = spawnSync('sh', [p.script('resourcer-queue-due.sh')], { encoding: 'utf8', env: { PATH: process.env.PATH, HERMES_HOME: p.prof }, timeout: 60000 });
  assert.equal(q.status, 0, q.stdout + q.stderr);
  assert.equal(q.stdout, '');
});

// --- review findings: profile selection, TMPDIR, tick bound, file-size backstop, failure text, bash ------------------

const ENV_PROBE = `
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const lim = spawnSync('sh', ['-c', 'ulimit -f'], { encoding: 'utf8' }).stdout.trim();
fs.writeFileSync(path.join(process.env.RESOURCER_HOME, 'markers', 'probe.json'), JSON.stringify({ tmp: process.env.TMPDIR || null, argv: process.argv.slice(2), hermesHome: process.env.HERMES_HOME || null, fileLimit: lim }));
`;

function probeHome(t) {
  const p = profile(t);
  fs.writeFileSync(path.join(p.home, 'scripts', 'pipeline-watchdog.js'), ENV_PROBE);
  return p;
}

const probe = (p) => H.readJson(path.join(p.home, 'markers', 'probe.json'));

test('every wrapper takes its profile from where the script lives, not from an inherited HERMES_HOME that names another profile', { skip: POSIX, timeout: 60000 }, (t) => {
  const p = probeHome(t);
  const foreign = path.join(H.mkHome(t, 'foreignprofile'), 'default-home');
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, '.env'), 'AI_GATEWAY_API_KEY=fake-key-from-the-wrong-profile\n');
  const r = runSh(p.script('resourcer-tick.sh'), { HERMES_HOME: foreign });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(probe(p).hermesHome, p.prof, 'children see the corrected HERMES_HOME, so env.js reads this profile\'s .env');
  const log = fs.readdirSync(path.join(p.home, 'logs')).filter((f) => f.startsWith('tick-')).map((f) => fs.readFileSync(path.join(p.home, 'logs', f), 'utf8')).join('');
  assert.match(log, /note: HERMES_HOME=.*differs from the script location; using /);
  for (const w of WRAPPERS.filter((x) => x !== 'resourcer-tick.sh')) {
    const text = fs.readFileSync(path.join(HERMES_SCRIPTS, w), 'utf8');
    assert.match(text, /\nPROFILE_HOME=\$\(dirname "\$SELF_DIR"\)\n/, `${w}: profile from the script location`);
    assert.match(text, /\nHERMES_HOME=\$PROFILE_HOME\nexport HERMES_HOME\n/, `${w}: exported for the children`);
  }
});

test('a missing or unwritable TMPDIR is replaced by a private directory under state/ (xvfb-run and Chromium need one); a good one is left alone', { skip: POSIX, timeout: 60000 }, (t) => {
  const p = probeHome(t);
  let r = runSh(p.script('resourcer-tick.sh'), { HERMES_HOME: p.prof, TMPDIR: path.join(p.prof, 'pruned-scratch') });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(probe(p).tmp, path.join(p.home, 'state', 't'));
  assert.equal(fs.statSync(path.join(p.home, 'state', 't')).mode & 0o777, 0o700);
  const good = path.join(p.prof, 'scratch');
  fs.mkdirSync(good);
  r = runSh(p.script('resourcer-tick.sh'), { HERMES_HOME: p.prof, TMPDIR: good });
  assert.equal(probe(p).tmp, good);
  for (const w of ['resourcer-preflight.sh', 'resourcer-keepalive.sh']) assert.match(fs.readFileSync(path.join(HERMES_SCRIPTS, w), 'utf8'), /TMPDIR=\$RESOURCER_HOME\/state\/t/, w);
});

test('the tick bound comes from RESOURCER_MAX_TICK_MIN only when the cron environment has it, so a profile .env value stays reachable', { skip: POSIX, timeout: 60000 }, (t) => {
  const p = probeHome(t);
  runSh(p.script('resourcer-tick.sh'), { HERMES_HOME: p.prof, RESOURCER_MAX_TICK_MIN: '' });
  assert.deepEqual(probe(p).argv, ['--tick']);
  runSh(p.script('resourcer-tick.sh'), { HERMES_HOME: p.prof, RESOURCER_MAX_TICK_MIN: '30' });
  assert.deepEqual(probe(p).argv, ['--tick', '--max-minutes', '30']);
});

test('the tick runs with a 1 GiB single-file limit, the backstop for a runaway writer', { skip: POSIX, timeout: 60000 }, (t) => {
  const p = probeHome(t);
  runSh(p.script('resourcer-tick.sh'), { HERMES_HOME: p.prof });
  assert.equal(probe(p).fileLimit, '2097152');
});

test('pre-flight and keep-alive report the marker line that names the cause, not the closing BROWSER_STOP_IDLE line', { skip: POSIX, timeout: 60000 }, (t) => {
  const p = profile(t);
  fs.writeFileSync(path.join(p.home, 'scripts', 'caterer-preflight.js'), "console.log('CATERER_BROWSER_MISSING: agent-browser is not runnable'); console.log('BROWSER_STOP_IDLE: exit 0 - CDP_NOT_RUNNING'); process.exit(1);\n");
  for (const w of ['resourcer-preflight.sh', 'resourcer-keepalive.sh']) {
    const r = runSh(p.script(w), { HERMES_HOME: p.prof });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /failed rc=1: CATERER_BROWSER_MISSING: agent-browser is not runnable$/m, w);
  }
});

test('the wrappers also work when Hermes runs them with bash (they are plain sh, but the rehearsal must match the runner)', { skip: POSIX, timeout: 60000 }, (t) => {
  const p = profile(t);
  const env = { PATH: process.env.PATH, HERMES_HOME: p.prof, HOME: p.prof };
  const tickRun = spawnSync('bash', [p.script('resourcer-tick.sh')], { encoding: 'utf8', env, timeout: 60000 });
  assert.equal(tickRun.status, 0, tickRun.stdout + tickRun.stderr);
  assert.equal(tickRun.stdout, '');
  fs.writeFileSync(path.join(p.home, 'outbox', 'alerts.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), severity: 'critical', key: 'b', text: 'seen through bash' })}\n`);
  const alertRun = spawnSync('bash', [p.script('resourcer-alerts.sh')], { encoding: 'utf8', env, timeout: 60000 });
  assert.equal(alertRun.status, 0, alertRun.stderr);
  assert.match(alertRun.stdout, /seen through bash/);
});
