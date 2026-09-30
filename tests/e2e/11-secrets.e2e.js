'use strict';
// SCENARIO 11 - secrets hygiene. A day with everything that can go wrong runs; afterwards every log, the outbox, the shadow
// log, the run records, the state and the dashboard responses are searched for the planted secret values (raw, JSON-escaped
// and base64). Hostile servers that echo credentials back in their error bodies must not put them on disk either.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { World } = require('./lib/world');
const D = require('./lib/data');
const C = require('./lib/checks');
const U = require('./lib/util');

const SECRET_ARGV = [D.SECRETS.aiKey, D.SECRETS.zohoClientSecret, D.SECRETS.zohoRefresh, D.SECRETS.reedPass, D.SECRETS.backupPassphrase, D.SECRETS.bundlePassphrase];

test('11.1 a full day: sign-in, a run, an outage, a safe-list block, backup, maintenance, retention, alert delivery; no secret on disk outside its home, none in any process argument, modes right', async (t) => {
  const w = new World('s11-day');
  await w.create({});
  t.after(() => w.close());
  const argvHits = new Set();
  const timer = setInterval(() => {
    for (const p of U.procs(/./)) {
      if (!(p.cmd.includes(w.root) || p.cwd.startsWith(w.home))) continue;
      for (const s of SECRET_ARGV) if (p.cmd.includes(s) || p.cmd.includes(Buffer.from(s).toString('base64'))) argvHits.add(p.cmd.slice(0, 100));
    }
  }, 15);
  t.after(() => clearInterval(timer));

  w.svc.zoho.state.dupKeys.add('71000010');
  assert.equal((await w.cron('resourcer-preflight')).code, 0);
  w.dropPending({});
  await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json') && w.pipelineProcs().length === 0, { maxTicks: 12, tickMin: 1 });
  assert.equal(w.lastRun().exitCode, 0);

  // an outage: unreachable gateway -> halt -> critical alert
  const port = w.svc.gateway.port;
  await w.svc.gateway.close();
  w.dropPending({ jobTitle: 'Sous Chef', location: 'M1' });
  await w.cron('resourcer-tick', { env: { RESOURCER_MAX_TICK_MIN: '1' } });
  await w.cron('resourcer-tick', { env: { RESOURCER_MAX_TICK_MIN: '1' } });
  assert.equal(w.json('runtime/pipeline-halt.json').halted, true);
  w.node('pipeline-halt-cli.js', ['clear']);
  void port;

  // a safe-list block
  w.setWorld({ login: { mode: 'safelist' } });
  w.setFakeBrowserState({ loggedIn: false });
  const pre = await w.cron('resourcer-preflight');
  assert.equal(pre.code, 2);

  assert.equal((await w.cron('resourcer-backup')).code, 0);
  assert.equal((await w.cron('resourcer-maintenance')).code, 0);
  assert.equal((await w.cron('resourcer-retention')).code, 0);
  const alerts = await w.cron('resourcer-alerts');
  assert.equal(alerts.code, 0);
  clearInterval(timer);

  const texts = [alerts.stdout, pre.stdout];
  for (const s of Object.values(C.SECRET_VALUES)) for (const x of texts) assert.ok(!x.includes(s), 'a delivered message carries a secret');
  const hits = C.secretHits(w);
  assert.deepEqual(hits, [], C.fmtHits(hits));
  assert.deepEqual([...argvHits], [], 'no secret is passed in a process argument');

  const mode = (rel) => C.modeOf(path.join(w.profile, rel));
  assert.equal(mode('.env'), 0o600);
  assert.equal(mode('workspace/resourcer/secrets'), 0o700);
  for (const f of fs.readdirSync(w.p('secrets'))) assert.equal(C.modeOf(w.p('secrets', f)), 0o600, f);
  assert.equal(C.modeOf(w.p('state', 'caterer-session.json')), 0o600);
  assert.equal(C.modeOf(w.p('shadow')) & 0o077, 0, 'the screening log directory is owner-only');
  for (const f of w.list('backups', /\.enc$/)) assert.equal(C.modeOf(w.p('backups', f)) & 0o007, 0, 'backups are not world readable');
  assert.deepEqual(w.netBlocked(), []);
});

test('11.2 a token endpoint that echoes the request (client secret, refresh token) in its error does not put them in any log', async (t) => {
  const w = new World('s11-echo-zoho');
  await w.create({});
  t.after(() => w.close());
  w.warmLoggedIn();
  w.svc.zoho.state.mode.tokenEcho = true;
  w.dropPending({});
  await w.tickUntil(async () => !w.pendingFiles().length && !w.exists('runtime/run.json') && w.pipelineProcs().length === 0, { maxTicks: 12, tickMin: 1 });
  assert.ok(w.svc.zoho.state.calls.some((c) => c.op === 'token' && c.status === 400), 'the hostile endpoint was really asked');
  const hits = C.secretHits(w);
  assert.deepEqual(hits, [], C.fmtHits(hits));
});

test('11.3 a gateway that echoes the Authorization header in its error does not put the key in the halt file, an alert or a log', async (t) => {
  const w = new World('s11-echo-gw');
  await w.create({});
  t.after(() => w.close());
  w.warmLoggedIn();
  const hostile = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `invalid credentials ${req.headers.authorization}`, echo: body.slice(0, 400) } }));
    });
  });
  await new Promise((r) => hostile.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => hostile.close(r)));
  w.writeEnv({ SCREEN_GATEWAY_ORIGIN: `http://127.0.0.1:${hostile.address().port}` });
  w.dropPending({});
  await w.cron('resourcer-tick', { env: { RESOURCER_MAX_TICK_MIN: '1' } });
  await w.cron('resourcer-tick', { env: { RESOURCER_MAX_TICK_MIN: '1' } });
  await w.cron('resourcer-tick', { env: { RESOURCER_MAX_TICK_MIN: '1' } });
  const halt = w.json('runtime/pipeline-halt.json');
  assert.ok(halt && halt.halted, 'the auth failure halted the queue');
  assert.match(halt.reason, /auth failed|unreachable|error/);
  const hits = C.secretHits(w);
  assert.deepEqual(hits, [], C.fmtHits(hits));
  const shown = await w.cron('resourcer-alerts');
  assert.ok(!shown.stdout.includes(D.SECRETS.aiKey));
});
