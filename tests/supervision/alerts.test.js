'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./_helpers');

H.installNetworkGuard();
process.env.RESOURCER_HOME = H.mkHome(null, 'alertsbase');
const alerts = require(path.join(H.SRC_SCRIPTS, 'alerts-deliver.js'));
const tick = require(path.join(H.SRC_SCRIPTS, 'lib', 'tick.js'));

const MIN = 60000;
const HOUR = 3600000;

function mkAlerts(t, o = {}) {
  const home = H.mkHome(t, 'alerts');
  let clock = o.start || H.londonEpoch(2026, 9, 29, 14, 0);
  const lines = [];
  const pings = [];
  const ctx = alerts.makeCtx(Object.assign({
    home,
    now: () => clock,
    out: (l) => lines.push(l),
    deadmanUrl: () => o.deadman,
    ping: async (url) => { pings.push(url); return o.pingResult || { ok: true, status: 200 }; },
  }, o.ctx || {}));
  const outbox = path.join(home, 'outbox', 'alerts.jsonl');
  if (!o.fresh) {
    // Keep the once-a-day extras out of the way unless a test is about them.
    const ymd = require(path.join(H.SRC_SCRIPTS, 'lib', 'time.js')).londonParts(new Date(clock)).ymd;
    H.writeJson(path.join(home, 'runtime', 'alerts-state.json'), { version: 1, offset: 0, head: '', sent: {}, held: [], digestDate: ymd, heartbeatDate: ymd, deadmanDate: '' });
  }
  const add = (rec) => fs.appendFileSync(outbox, `${JSON.stringify(Object.assign({ ts: new Date(clock).toISOString(), severity: 'info', key: null, text: 'x' }, rec))}\n`);
  return {
    home, ctx, lines, pings, add, outbox,
    clock: () => clock, set: (v) => { clock = v; }, advance: (ms) => { clock += ms; },
    run: async () => { lines.length = 0; return alerts.run(ctx); },
    state: () => H.readJson(ctx.stateFile, {}),
  };
}

test('nothing to say: prints nothing and writes the dead-man heartbeat file', async (t) => {
  const a = mkAlerts(t, { start: H.londonEpoch(2026, 9, 29, 6, 30) });
  const r = await a.run();
  assert.deepEqual(a.lines, []);
  const hb = H.readJson(a.ctx.heartbeatFile);
  assert.ok(hb.ts);
  assert.equal(r.delivered, a.lines.length);
});

test('delivers a new alert once, in a compact one-line format with the London time', async (t) => {
  const a = mkAlerts(t);
  a.add({ severity: 'critical', key: 'pipeline-halt', text: 'PIPELINE HALTED - screening gateway unreachable.   Remedy: check the key.' });
  await a.run();
  assert.equal(a.lines.length, 1);
  assert.equal(a.lines[0], '[CRITICAL 14:00] PIPELINE HALTED - screening gateway unreachable. Remedy: check the key.');
  await a.run();
  assert.equal(a.lines.length, 0, 'the saved offset means it is never delivered twice');
  a.add({ severity: 'warn', key: 'k2', text: 'second' });
  await a.run();
  assert.deepEqual(a.lines, ['[WARN 14:00] second']);
});

test('a half-written line is left for the next run and delivered whole', async (t) => {
  const a = mkAlerts(t);
  const full = JSON.stringify({ ts: new Date(a.clock()).toISOString(), severity: 'warn', key: 'half', text: 'whole alert' });
  fs.writeFileSync(a.outbox, full.slice(0, 20));
  await a.run();
  assert.equal(a.lines.length, 0);
  fs.appendFileSync(a.outbox, `${full.slice(20)}\n`);
  await a.run();
  assert.deepEqual(a.lines, ['[WARN 14:00] whole alert']);
});

test('malformed lines and lines without text are skipped, unknown severities become info', async (t) => {
  const a = mkAlerts(t);
  fs.appendFileSync(a.outbox, 'not json\n{"text":""}\n[1,2]\n');
  a.add({ severity: 'urgent', key: 'x', text: 'odd severity' });
  await a.run();
  assert.deepEqual(a.lines, ['[INFO 14:00] odd severity']);
});

test('dedupe windows by severity: critical 60 min, warn 6 h, info 24 h', async (t) => {
  const a = mkAlerts(t);
  const cases = [['critical', 60 * MIN], ['warn', 6 * HOUR], ['info', 24 * HOUR]];
  const mine = () => a.lines.filter((l) => /(first|again|later) (critical|warn|info)/.test(l));
  for (const [sev, window] of cases) {
    const key = `k-${sev}`;
    a.set(H.londonEpoch(2026, 9, 29, 9, 0));
    a.add({ severity: sev, key, text: `first ${sev}` });
    await a.run();
    assert.equal(mine().length, 1, `${sev} first delivery`);
    a.advance(window - MIN);
    a.add({ severity: sev, key, text: `again ${sev}` });
    await a.run();
    assert.equal(mine().length, 0, `${sev} suppressed just inside the window`);
    a.advance(2 * MIN);
    a.add({ severity: sev, key, text: `later ${sev}` });
    await a.run();
    const shown = a.lines.filter((l) => l.includes(`later ${sev}`));
    assert.equal(shown.length, 1, `${sev} delivered again after the window`);
    assert.match(shown[0], /\(\+1 repeats suppressed\)/);
  }
  assert.equal(alerts.WINDOWS_MS.critical, 60 * MIN);
  assert.equal(alerts.WINDOWS_MS.warn, 6 * HOUR);
  assert.equal(alerts.WINDOWS_MS.info, 24 * HOUR);
});

test('different keys are independent; keyless alerts dedupe on their text', async (t) => {
  const a = mkAlerts(t);
  a.add({ severity: 'critical', key: 'a', text: 'one' });
  a.add({ severity: 'critical', key: 'b', text: 'two' });
  a.add({ severity: 'critical', key: null, text: 'same text' });
  a.add({ severity: 'critical', key: null, text: 'same text' });
  a.add({ severity: 'critical', key: null, text: 'other text' });
  await a.run();
  assert.equal(a.lines.length, 4);
});

test('the halt alert and its resume share a key but must both be delivered', async (t) => {
  const a = mkAlerts(t);
  a.add({ severity: 'critical', key: 'pipeline-halt', text: 'PIPELINE HALTED - x', meta: { event: 'halted', reason: 'x' } });
  a.add({ severity: 'info', key: 'pipeline-halt', text: 'Pipeline resumed - x cleared', meta: { event: 'resumed', reason: 'x' } });
  await a.run();
  assert.equal(a.lines.length, 2);
  assert.match(a.lines[1], /resumed/);
  // a second halt for a DIFFERENT reason inside the window is new information
  a.add({ severity: 'critical', key: 'pipeline-halt', text: 'PIPELINE HALTED - y', meta: { event: 'halted', reason: 'y' } });
  a.add({ severity: 'critical', key: 'pipeline-halt', text: 'PIPELINE HALTED - x again', meta: { event: 'halted', reason: 'x' } });
  await a.run();
  assert.equal(a.lines.length, 1, 'a new reason is delivered; the same reason inside the window is not');
  assert.match(a.lines[0], /HALTED - y/);
});

test('quiet hours 22:00-06:00: critical passes, the rest is held and delivered at 06:00 with counts', async (t) => {
  const a = mkAlerts(t, { start: H.londonEpoch(2026, 9, 29, 23, 0) });
  a.add({ severity: 'warn', key: 'w', text: 'disk is getting full' });
  a.add({ severity: 'warn', key: 'w', text: 'disk is getting fuller' });
  a.add({ severity: 'info', key: 'i', text: 'backup finished' });
  a.add({ severity: 'critical', key: 'c', text: 'backup FAILED' });
  await a.run();
  assert.deepEqual(a.lines, ['[CRITICAL 23:00] backup FAILED'], 'only the critical alert at night');
  assert.equal(a.state().held.length, 2);

  a.set(H.londonEpoch(2026, 9, 30, 3, 0));
  await a.run();
  assert.equal(a.lines.length, 0, 'still quiet at 03:00');
  a.set(H.londonEpoch(2026, 9, 30, 5, 59));
  await a.run();
  assert.equal(a.lines.length, 0);

  a.set(H.londonEpoch(2026, 9, 30, 6, 0));
  await a.run();
  const held = a.lines.filter((l) => l.includes('held'));
  assert.equal(held.length, 2);
  assert.ok(held.some((l) => l.includes('disk is getting fuller') && l.includes('(x2)')), held.join('\n'));
  assert.ok(held.some((l) => l.includes('backup finished')));
  assert.equal(a.state().held.length, 0);
  await a.run();
  assert.equal(a.lines.filter((l) => l.includes('held')).length, 0, 'delivered exactly once');
});

test('a held alert that already went out inside its window is not held twice', async (t) => {
  const a = mkAlerts(t, { start: H.londonEpoch(2026, 9, 29, 21, 30) });
  a.add({ severity: 'warn', key: 'w', text: 'first' });
  await a.run();
  assert.equal(a.lines.length, 1);
  a.set(H.londonEpoch(2026, 9, 29, 22, 30));
  a.add({ severity: 'warn', key: 'w', text: 'again at night' });
  await a.run();
  assert.equal(a.lines.length, 0);
  assert.equal(a.state().held.length, 0, 'suppressed by the delivered copy, not queued behind it');
});

test('the held queue is capped and says how many were dropped', async (t) => {
  const a = mkAlerts(t, { start: H.londonEpoch(2026, 9, 29, 23, 0) });
  for (let i = 0; i < 230; i++) a.add({ severity: 'info', key: `k${i}`, text: `n${i}` });
  await a.run();
  assert.equal(a.state().held.length, 200);
  assert.ok(a.lines.some((l) => /30 held overnight alerts were dropped/.test(l)));
});

test('output is capped at 25 lines with a pointer to the audit log', async (t) => {
  const a = mkAlerts(t);
  for (let i = 0; i < 40; i++) a.add({ severity: 'critical', key: `k${i}`, text: `alert ${i}` });
  await a.run();
  assert.equal(a.lines.length, 26);
  assert.match(a.lines[25], /and 15 more lines/);
  const audit = H.readLines(a.ctx.deliveredFile);
  assert.equal(audit.length, 40, 'every delivered alert is in the audit log');
});

test('a truncated or replaced outbox file restarts from the top', async (t) => {
  const a = mkAlerts(t);
  a.add({ severity: 'critical', key: 'one', text: 'a fairly long first alert so the offset is large' });
  a.add({ severity: 'critical', key: 'two', text: 'a fairly long second alert so the offset is larger' });
  await a.run();
  assert.equal(a.lines.length, 2);
  fs.writeFileSync(a.outbox, '');
  a.add({ severity: 'critical', key: 'three', text: 'new file' });
  await a.run();
  assert.deepEqual(a.lines, ['[CRITICAL 14:00] new file']);
  // same size or larger but a different file (rotated by hand): the head hash catches it
  fs.writeFileSync(a.outbox, `${JSON.stringify({ ts: new Date(a.clock()).toISOString(), severity: 'critical', key: 'four', text: 'replaced file with more bytes than the offset' })}\n`.repeat(3));
  await a.run();
  assert.equal(a.lines.length, 1, 'three identical lines dedupe to one delivery');
  assert.match(a.lines[0], /replaced file/);
});

test('dry run prints but does not advance the offset or change state', async (t) => {
  const a = mkAlerts(t, { start: H.londonEpoch(2026, 9, 29, 6, 30), fresh: true, ctx: { dryRun: true } });
  a.add({ severity: 'critical', key: 'k', text: 'peek' });
  await a.run();
  assert.equal(a.lines.length, 1);
  assert.equal(fs.existsSync(a.ctx.stateFile), false);
  a.ctx.dryRun = false;
  await a.run();
  assert.equal(a.lines.length, 1, 'still delivered on the real run');
});

test('a large fully-consumed outbox is rotated and stragglers written during rotation are not lost', async (t) => {
  const a = mkAlerts(t, { start: H.londonEpoch(2026, 9, 29, 14, 0) });
  const big = 'x'.repeat(3000);
  for (let i = 0; i < 800; i++) fs.appendFileSync(a.outbox, `${JSON.stringify({ ts: new Date(a.clock()).toISOString(), severity: 'info', key: `bulk-${i}`, text: big })}\n`);
  await a.run();
  const old = new Date(a.clock() - 5 * MIN);
  fs.utimesSync(a.outbox, old, old);
  a.set(a.clock() + 10 * MIN);
  await a.run();
  const rotated = fs.readdirSync(path.join(a.home, 'outbox')).filter((f) => /^alerts-\d{8}-\d{6}\.jsonl$/.test(f));
  assert.equal(rotated.length, 1, 'rotated file named for the maintenance prune rule');
  assert.equal(fs.existsSync(a.outbox), false);
  assert.equal(a.state().offset, 0);
  a.add({ severity: 'critical', key: 'after', text: 'after rotation' });
  await a.run();
  assert.deepEqual(a.lines, ['[CRITICAL 14:10] after rotation']);
});

// --- digest -------------------------------------------------------------------------------------

function seedDb(home, rows) {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(home, 'candidates.db'));
  db.exec(`CREATE TABLE run_results (
    run_key TEXT PRIMARY KEY, date TEXT NOT NULL, started_at TEXT, completed_at TEXT, job_title TEXT, location TEXT, sources TEXT,
    pool INTEGER, downloaded INTEGER, new_to_zoho INTEGER, duplicates INTEGER, skipped INTEGER, errors INTEGER,
    approved_p1 INTEGER, skipped_db INTEGER, skipped_review INTEGER, caterer_json TEXT, reed_json TEXT)`);
  const ins = db.prepare('INSERT INTO run_results (run_key,date,job_title,location,sources,downloaded,new_to_zoho,duplicates,skipped,errors,approved_p1,skipped_review,caterer_json,reed_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const r of rows) ins.run(r.key, r.date, r.job || 'Chef', 'AB1', r.sources || 'both', r.dl || 0, r.new || 0, r.dup || 0, r.skip || 0, r.err || 0, r.a1 || 0, r.sr || 0, r.cj || null, r.rj || null);
  db.close();
}

test('digest at 18:00: once per day, with targets, sources, roles, halts, credits and backup age', async (t) => {
  let ok = true;
  try { require('better-sqlite3'); } catch { ok = false; }
  if (!ok) return t.skip('better-sqlite3 not installed');
  const a = mkAlerts(t, { start: H.londonEpoch(2026, 9, 29, 17, 59), fresh: true });
  const today = new Date(a.clock()).toISOString().slice(0, 10);
  seedDb(a.home, [
    { key: 'r1', date: today, new: 100, dl: 110, dup: 8, skip: 2, err: 1, a1: 60, sr: 40, job: 'Chef', sources: 'both', cj: JSON.stringify({ newToZoho: 70 }), rj: JSON.stringify({ newToZoho: 30 }) },
    { key: 'r2', date: today, new: 42, dl: 44, dup: 3, a1: 10, sr: 30, job: 'Cook', sources: 'caterer' },
    { key: 'r3', date: '2026-09-25', new: 200, dl: 210, job: 'Chef' },
  ]);
  H.writeJson(path.join(a.home, 'credits-sync.json'), { credits: 44463 });
  H.writeJson(path.join(a.home, 'runtime', 'backup-state.json'), { lastOkAt: new Date(a.clock() - 7 * HOUR).toISOString(), lastRestoreTestAt: new Date(a.clock() - 3 * 86400000).toISOString(), lastRestoreOk: true });
  fs.appendFileSync(path.join(a.home, 'logs', 'errors.jsonl'), `${JSON.stringify({ ts: new Date(a.clock() - 5 * HOUR).toISOString(), context: 'pipeline_halted', error: 'x' })}\n${JSON.stringify({ ts: new Date(a.clock() - 4 * HOUR).toISOString(), context: 'pipeline_resumed', detail: 'was halted for 47 min; 2 run(s) held back' })}\n`);
  await a.run();
  assert.equal(a.lines.some((l) => l.includes('daily digest')), false, 'not before 18:00');
  a.set(H.londonEpoch(2026, 9, 29, 18, 0));
  await a.run();
  const d = a.lines.find((l) => l.includes('Resourcer daily digest 2026-09-29'));
  assert.ok(d, a.lines.join('\n'));
  assert.match(d, /CVs pulled today: 142 of 181 target \(78%\); last 7 days 342 of 1,269\./);
  assert.match(d, /Runs today 2: unlocked 154, duplicates 11, skipped 2, errors 1\./);
  assert.match(d, /New in Zoho by source: Caterer 112, Reed 30\./);
  assert.match(d, /Approval rate by role \(pre-unlock\): Chef 60% \(n=100\), Cook 25% \(n=40\)\./);
  assert.match(d, /Halts today: 1 episode\(s\), 47 min lost\./);
  assert.match(d, /Caterer credits: 44,463 remaining/);
  assert.match(d, /Backup: last OK 7 h ago, restore test ok 3 d ago\./);
  await a.run();
  assert.equal(a.lines.some((l) => l.includes('daily digest')), false, 'once per day');
  a.set(H.londonEpoch(2026, 9, 30, 18, 5));
  await a.run();
  assert.ok(a.lines.some((l) => l.includes('daily digest 2026-09-30')), 'again the next day');
});

test('digest survives a missing database and never runs in quiet hours unless forced', async (t) => {
  const a = mkAlerts(t, { start: H.londonEpoch(2026, 9, 29, 22, 30), fresh: true });
  await a.run();
  assert.equal(a.lines.some((l) => l.includes('daily digest')), false);
  a.ctx.forceDigest = true;
  await a.run();
  const d = a.lines.find((l) => l.includes('daily digest'));
  assert.ok(d);
  assert.match(d, /Database not readable/);
  assert.match(d, /Halts today: none\./);
  assert.match(d, /Backup: none recorded yet\./);
  assert.match(d, /Caterer credits: no sync recorded\./);
});

test('digest reports a halt that is still running and a failed restore test', async (t) => {
  const a = mkAlerts(t, { start: H.londonEpoch(2026, 9, 29, 18, 30), fresh: true });
  H.writeJson(path.join(a.home, 'runtime', 'pipeline-halt.json'), { halted: true, reason: 'AI screening unavailable', since: new Date(a.clock() - 90 * MIN).toISOString() });
  H.writeJson(path.join(a.home, 'runtime', 'backup-state.json'), { lastOkAt: new Date(a.clock() - 3 * HOUR).toISOString(), lastRestoreTestAt: new Date(a.clock() - 86400000).toISOString(), lastRestoreOk: false, lastFailureAt: new Date(a.clock() - HOUR).toISOString() });
  await a.run();
  const d = a.lines.find((l) => l.includes('daily digest'));
  assert.match(d, /still halted, 90 min so far/);
  assert.match(d, /restore test FAILED/);
  assert.match(d, /LAST ATTEMPT FAILED/);
});

// --- daily alive line and dead-man switch -------------------------------------------------------

test('the alive line goes out once a day after 07:00 with queue, halt and backup facts', async (t) => {
  const a = mkAlerts(t, { start: H.londonEpoch(2026, 9, 29, 6, 55), fresh: true });
  H.pendingFile(a.home, 'territory-1.json');
  H.pendingFile(a.home, 'territory-2.json');
  H.writeJson(path.join(a.home, 'runtime', 'watchdog-state.json'), { lastTickAt: a.clock() - 3 * MIN });
  await a.run();
  assert.equal(a.lines.some((l) => l.includes('Resourcer alive')), false);
  a.set(H.londonEpoch(2026, 9, 29, 7, 0));
  await a.run();
  const l = a.lines.find((x) => x.includes('Resourcer alive'));
  assert.ok(l);
  assert.match(l, /last tick 8 min ago, queue 2, not halted/);
  await a.run();
  assert.equal(a.lines.some((x) => x.includes('Resourcer alive')), false, 'once per day');
});

function pingServer(t, status) {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); res.statusCode = status(); res.end('ok'); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    t.after(() => server.close());
    resolve({ url: `http://127.0.0.1:${server.address().port}/ping/secret-token-123`, hits });
  }));
}

// The tick heartbeat file, aged as the test needs: mtime is clock - ageMs (the fake clock, not the real one).
function beat(a, ageMs) {
  const f = a.ctx.files.tickHeartbeat;
  fs.writeFileSync(f, 'x');
  const when = new Date(a.clock() - (ageMs || 0));
  fs.utimesSync(f, when, when);
}

test('dead-man ping: hourly to a local endpoint while the tick heartbeat is fresh, retried when it fails, failure warned once, URL never printed', async (t) => {
  let code = 500;
  const srv = await pingServer(t, () => code);
  const a = mkAlerts(t, { start: H.londonEpoch(2026, 9, 29, 6, 5), deadman: srv.url, fresh: true, ctx: { ping: alerts.pingUrl } });
  beat(a);
  await a.run();
  assert.equal(srv.hits.length, 1);
  assert.ok(a.lines.some((l) => l.includes('dead-man ping failed') && l.includes('HTTP 500')), a.lines.join('\n'));
  assert.equal(a.lines.join('\n').includes('secret-token'), false, 'the URL is a secret and is never printed');
  assert.ok(!a.state().deadmanAt, 'not marked done while failing');
  code = 200;
  a.advance(5 * MIN);
  beat(a);
  await a.run();
  assert.equal(srv.hits.length, 2, 'retried on the next run');
  assert.equal(a.lines.some((l) => l.includes('dead-man')), false);
  a.advance(5 * MIN);
  beat(a);
  await a.run();
  assert.equal(srv.hits.length, 2, 'already pinged this hour');
  a.advance(56 * MIN);
  beat(a);
  await a.run();
  assert.equal(srv.hits.length, 3, 'hourly');
  code = 500;
  a.advance(61 * MIN);
  beat(a);
  await a.run();
  assert.equal(srv.hits.length, 4, 'it keeps trying');
  assert.equal(a.lines.some((l) => l.includes('dead-man')), false, 'the failure warning is deduped for six hours, not repeated on every run');
});

test('dead-man ping is withheld when the tick heartbeat is missing or stale, and skipped without a URL or on a dry run', async (t) => {
  const a = mkAlerts(t, { start: H.londonEpoch(2026, 9, 29, 12, 0), deadman: 'http://127.0.0.1:1/x', fresh: true });
  await a.run();
  assert.equal(a.pings.length, 0, 'no heartbeat file at all');
  beat(a, 11 * MIN);
  a.advance(5 * MIN);
  await a.run();
  assert.equal(a.pings.length, 0, 'a heartbeat older than 10 minutes');
  beat(a, 9 * MIN);
  a.ctx.dryRun = true;
  await a.run();
  assert.equal(a.pings.length, 0, 'dry run');
  a.ctx.dryRun = false;
  a.ctx.deadmanUrl = () => undefined;
  await a.run();
  assert.equal(a.pings.length, 0, 'no URL configured');
  a.ctx.deadmanUrl = () => 'http://127.0.0.1:1/x';
  await a.run();
  assert.equal(a.pings.length, 1, 'a fresh heartbeat lets it through');
});

test('pingUrl refuses non-http schemes and reports connection errors without throwing', async () => {
  assert.deepEqual(await alerts.pingUrl('file:///etc/passwd', 500), { ok: false, error: 'unsupported scheme' });
  assert.deepEqual(await alerts.pingUrl('not a url', 500), { ok: false, error: 'invalid url' });
  const r = await alerts.pingUrl('http://127.0.0.1:1/x', 1000);
  assert.equal(r.ok, false);
});

// --- CLI ----------------------------------------------------------------------------------------

test('CLI: prints alerts from the outbox, exits 0; --help 0; unknown argument 2', (t) => {
  const home = H.mkHome(t, 'alertscli');
  H.installScripts(home);
  fs.writeFileSync(path.join(home, 'outbox', 'alerts.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), severity: 'critical', key: 'cli', text: 'from the cli' })}\n`);
  const run = (args) => spawnSync(process.execPath, [path.join(home, 'scripts', 'alerts-deliver.js'), ...args], { cwd: home, env: { ...process.env, RESOURCER_HOME: home }, encoding: 'utf8' });
  let r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[CRITICAL \d\d:\d\d\] from the cli/);
  r = run([]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.includes('from the cli'), false);
  assert.equal(run(['--help']).status, 0);
  assert.equal(run(['--bogus']).status, 2);
});

test('invalid UTF-8 inside a line does not make the byte offset drift', async (t) => {
  const a = mkAlerts(t);
  const good = JSON.stringify({ ts: new Date(a.clock()).toISOString(), severity: 'critical', key: 'utf', text: 'before \u00e9 after' });
  const bad = Buffer.concat([Buffer.from(`{"ts":"${new Date(a.clock()).toISOString()}","severity":"critical","key":"bad","text":"broken `), Buffer.from([0xff, 0xfe]), Buffer.from(' bytes"}\n')]);
  fs.writeFileSync(a.outbox, Buffer.concat([bad, Buffer.from(`${good}\n`)]));
  await a.run();
  assert.equal(a.lines.length, 2);
  assert.equal(a.state().offset, fs.statSync(a.outbox).size, 'offset is exactly the file size');
  a.add({ severity: 'critical', key: 'next', text: 'still aligned' });
  await a.run();
  assert.deepEqual(a.lines, ['[CRITICAL 14:00] still aligned']);
});

test('output happens before the offset is saved: a crash while printing re-delivers instead of losing alerts', async (t) => {
  const a = mkAlerts(t);
  a.add({ severity: 'critical', key: 'k', text: 'must not be lost' });
  const realOut = a.ctx.out;
  a.ctx.out = () => { throw new Error('stdout closed'); };
  await assert.rejects(() => alerts.run(a.ctx), /stdout closed/);
  assert.equal(a.state().offset || 0, 0, 'offset not advanced');
  a.ctx.out = realOut;
  await a.run();
  assert.deepEqual(a.lines, ['[CRITICAL 14:00] must not be lost']);
});

test('an alert with an unparseable timestamp cannot poison the run (delivered with the current time)', async (t) => {
  const a = mkAlerts(t);
  fs.appendFileSync(a.outbox, `${JSON.stringify({ ts: 'garbage', severity: 'critical', key: 'bad-ts', text: 'odd timestamp' })}\n${JSON.stringify({ severity: 'critical', key: 'no-ts', text: 'no timestamp' })}\n`);
  await a.run();
  assert.equal(a.lines.length, 2);
  assert.ok(a.lines.every((l) => /^\[CRITICAL \d\d:\d\d\] /.test(l)));
  assert.equal(a.state().offset, fs.statSync(a.outbox).size, 'the offset advanced past the odd lines');
});

test('a digest that throws is reported as a warning and does not block the alerts', async (t) => {
  const a = mkAlerts(t, { start: H.londonEpoch(2026, 9, 29, 18, 30), fresh: true });
  a.add({ severity: 'critical', key: 'k', text: 'real alert' });
  H.writeJson(path.join(a.home, 'credits-sync.json'), { credits: 100 });
  fs.writeFileSync(path.join(a.home, 'runtime', 'backup-state.json'), '{"lastOkAt": {"toString": 1}}');
  const real = a.ctx.files;
  a.ctx.files = null; // buildDigest dereferences ctx.files, so it throws
  await a.run();
  a.ctx.files = real;
  assert.ok(a.lines.some((l) => l.includes('real alert')));
  assert.ok(a.lines.some((l) => /digest could not be built/.test(l)));
});

// --- independent watch on the tick (review finding: nothing watched the tick) ------------------------

test('tick-silent: a heartbeat older than 10 minutes inside the operating window raises one critical alert per hour', async (t) => {
  const a = mkAlerts(t, { start: H.londonEpoch(2026, 9, 29, 14, 0) });
  beat(a, 30 * MIN);
  await a.run();
  assert.equal(a.lines.length, 1, a.lines.join('\n'));
  assert.match(a.lines[0], /^\[CRITICAL 14:00\] The supervision tick has been silent for 30 min \(last heartbeat 13:30 London\)/);
  assert.match(a.lines[0], /cron list/);
  let total = 1;
  for (let i = 1; i <= 12; i++) {
    a.advance(5 * MIN);
    beat(a, 30 * MIN + i * 5 * MIN);
    await a.run();
    total += a.lines.filter((l) => l.includes('tick has been silent')).length;
    if (i === 11) assert.equal(total, 1, 'deduped for the whole hour');
  }
  assert.equal(total, 2, 'raised again once the hour is up');
  a.advance(5 * MIN);
  beat(a, 1 * MIN);
  await a.run();
  assert.equal(a.lines.filter((l) => l.includes('tick has been silent')).length, 0, 'a fresh heartbeat is silent');
});

test('tick-silent: only inside 06:00-22:00 London, and the boundaries are exact', async (t) => {
  const a = mkAlerts(t, { start: H.londonEpoch(2026, 9, 29, 5, 55) });
  for (const [h, m, expect] of [[5, 55, false], [6, 0, true], [21, 55, true], [22, 0, false], [23, 30, false], [3, 0, false]]) {
    a.set(H.londonEpoch(2026, 9, h >= 6 ? 29 : 30, h, m));
    fs.writeFileSync(a.ctx.stateFile, JSON.stringify({ version: 1, offset: 0, head: '', sent: {}, held: [], digestDate: '2026-09-29', heartbeatDate: '2026-09-29' }));
    beat(a, 2 * HOUR);
    await a.run();
    assert.equal(a.lines.some((l) => l.includes('tick has been silent')), expect, `${h}:${m}`);
  }
});

test('tick-silent: a heartbeat that has never been written gets 10 minutes of grace from the first run, so the install order is safe', async (t) => {
  const a = mkAlerts(t, { start: H.londonEpoch(2026, 9, 29, 14, 0), fresh: true });
  await a.run();
  assert.equal(a.lines.some((l) => l.includes('silent')), false, 'first run');
  a.advance(8 * MIN);
  await a.run();
  assert.equal(a.lines.some((l) => l.includes('silent')), false, 'still inside the grace');
  a.advance(4 * MIN);
  await a.run();
  const l = a.lines.find((x) => x.includes('silent'));
  assert.ok(l, a.lines.join('\n'));
  assert.match(l, /never seen/);
});

test('tick-silent: if the alert job itself was not running (a suspended instance), one stale heartbeat proves nothing; the next run decides', async (t) => {
  const a = mkAlerts(t, { start: H.londonEpoch(2026, 9, 29, 14, 0) });
  fs.writeFileSync(a.ctx.stateFile, JSON.stringify({ version: 1, offset: 0, head: '', sent: {}, held: [], digestDate: '2026-09-29', heartbeatDate: '2026-09-29', lastRunAt: a.clock() - 3 * HOUR }));
  beat(a, 3 * HOUR);
  await a.run();
  assert.equal(a.lines.some((l) => l.includes('silent')), false, 'first run after the gap');
  a.advance(5 * MIN);
  beat(a, 3 * HOUR + 5 * MIN);
  await a.run();
  assert.equal(a.lines.some((l) => l.includes('silent')), true, 'still stale five minutes later: now it is real');
});

test('tick-silent is a critical alert, so it is delivered at the edge of the window and is not held with the quiet-hours alerts', async (t) => {
  const a = mkAlerts(t, { start: H.londonEpoch(2026, 9, 29, 21, 58) });
  beat(a, 40 * MIN);
  await a.run();
  assert.equal(a.lines.length, 1);
  assert.equal(a.state().held.length, 0);
});

test('a future-dated delivery record (clock excursion) does not suppress alerts', async (t) => {
  const a = mkAlerts(t);
  beat(a);
  fs.writeFileSync(a.ctx.stateFile, JSON.stringify({ version: 1, offset: 0, head: '', sent: { 'k|critical': { at: a.clock() + 30 * 24 * HOUR, suppressed: 0 } }, held: [], digestDate: '2026-09-29', heartbeatDate: '2026-09-29', deadmanAt: a.clock() + 30 * 24 * HOUR }));
  a.add({ severity: 'critical', key: 'k', text: 'must show' });
  await a.run();
  assert.deepEqual(a.lines, ['[CRITICAL 14:00] must show']);
});

// --- --test mode ---------------------------------------------------------------------------------

test('--test: prints one critical line, queues it for the channel, and every use is delivered (no hourly dedupe)', (t) => {
  const home = H.mkHome(t, 'alertstest');
  H.installScripts(home);
  const run = (args) => spawnSync(process.execPath, [path.join(home, 'scripts', 'alerts-deliver.js'), ...args], { cwd: home, env: { ...process.env, RESOURCER_HOME: home }, encoding: 'utf8' });
  let r = run(['--test']);
  assert.equal(r.status, 0, r.stderr);
  const printed = r.stdout.trim().split('\n');
  assert.equal(printed.length, 1);
  assert.match(printed[0], /^\[CRITICAL \d\d:\d\d\] TEST ALERT/);
  const queued = H.readLines(path.join(home, 'outbox', 'alerts.jsonl'));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].severity, 'critical');
  r = run([]);
  assert.match(r.stdout, /\[CRITICAL \d\d:\d\d\] TEST ALERT/, 'the normal delivery run sends it to the channel');
  assert.equal(run(['--test']).status, 0);
  r = run([]);
  assert.match(r.stdout, /TEST ALERT/, 'a second test inside the hour is not swallowed by the dedupe');
  r = run(['--test', '--dry-run']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /TEST ALERT/);
  assert.equal(H.readLines(path.join(home, 'outbox', 'alerts.jsonl')).length, 2, 'dry run queues nothing');
});

// --- alerts must not be lost or stormed (review finding) -----------------------------------------

test('a torn line followed by a whole alert on the same line: the whole alert is still delivered', async (t) => {
  const a = mkAlerts(t);
  beat(a);
  const whole = JSON.stringify({ ts: new Date(a.clock()).toISOString(), severity: 'critical', key: 'after-torn', text: 'whole critical after a torn write' });
  fs.appendFileSync(a.outbox, `{"ts":"2026-09-29T13:59:00.000Z","severity":"warn","ke${whole}\n`);
  await a.run();
  assert.deepEqual(a.lines, ['[CRITICAL 14:00] whole critical after a torn write']);
  assert.equal(a.state().offset, fs.statSync(a.outbox).size);
});

test('a line longer than the read window is skipped with one warning instead of stalling delivery forever', async (t) => {
  const a = mkAlerts(t, { ctx: { maxReadBytes: 1024 } });
  fs.appendFileSync(a.outbox, `${'x'.repeat(5000)}\n`);
  a.add({ severity: 'critical', key: 'behind', text: 'behind the giant line' });
  const seen = [];
  for (let i = 0; i < 12 && !seen.some((l) => l.includes('behind the giant line')); i++) {
    beat(a);
    await a.run();
    seen.push(...a.lines);
    a.advance(MIN);
  }
  assert.ok(seen.some((l) => l.includes('behind the giant line')), seen.join('\n'));
  assert.equal(seen.filter((l) => l.includes('longer than')).length, 1, 'one warning, not one per window');
  assert.equal(a.state().offset, fs.statSync(a.outbox).size);
});

test('over the line cap the criticals are printed first, so a critical after line 25 is never the one cut off', async (t) => {
  const a = mkAlerts(t);
  beat(a);
  for (let i = 0; i < 40; i++) a.add({ severity: 'warn', key: `w${i}`, text: `warn ${i}` });
  a.add({ severity: 'critical', key: 'late', text: 'the critical that arrived last' });
  await a.run();
  assert.equal(a.lines.length, 26);
  assert.match(a.lines[0], /^\[CRITICAL/);
  assert.ok(a.lines.some((l) => l.includes('the critical that arrived last')));
  assert.match(a.lines[25], /and 16 more lines/);
});

test('overlapping alert jobs deliver once: the second run finds the lock held and prints nothing', async (t) => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const a = mkAlerts(t, { deadman: 'http://127.0.0.1:1/x', ctx: { ping: async () => { await slow; return { ok: true, status: 200 }; } } });
  beat(a);
  a.add({ severity: 'critical', key: 'once', text: 'delivered exactly once' });
  const out = [];
  a.ctx.out = (l) => out.push(l);
  const first = alerts.run(a.ctx);
  await new Promise((r) => setTimeout(r, 30));
  const second = await alerts.run(a.ctx);
  assert.equal(second.skipped, 'locked');
  release();
  await first;
  assert.equal(out.filter((l) => l.includes('delivered exactly once')).length, 1);
  assert.equal(fs.existsSync(a.ctx.lockFile), false, 'the lock is released afterwards');
  const third = await alerts.run(a.ctx);
  assert.equal(third.skipped, null);
});

test('an unwritable delivery state prints one critical line and consumes nothing, instead of repeating every alert on every run', async (t) => {
  const a = mkAlerts(t);
  a.add({ severity: 'critical', key: 'pending', text: 'still in the outbox' });
  fs.writeFileSync(path.join(a.home, 'not-a-dir'), 'x');
  a.ctx.heartbeatFile = path.join(a.home, 'not-a-dir', 'alerts-last-run.json');
  a.ctx.stateFile = path.join(a.home, 'not-a-dir', 'alerts-state.json');
  for (let i = 0; i < 3; i++) {
    const r = await a.run();
    assert.equal(r.skipped, 'state-unwritable');
    assert.equal(a.lines.length, 1);
    assert.match(a.lines[0], /^\[CRITICAL 14:00\] Alert delivery state is not writable/);
  }
});
