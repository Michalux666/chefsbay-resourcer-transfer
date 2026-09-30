'use strict';

const fs = require('fs');
const { makeMirror } = require('./mirror');
const { startFakeReed, makeJwt } = require('./fake-reed');

// Runs fn({m, fake, env}) against a fresh mirror + fake Reed world, always cleaning up.
async function withWorld(fn, opts = {}) {
  const m = makeMirror();
  const fake = await startFakeReed(opts.fake || {});
  const env = m.env({
    REED_CDP_PORT: String(fake.cdpPort),
    REED_API_BASE: fake.apiBase,
    REED_AUTO_RELAUNCH: '0',
    ...(opts.env || {}),
  });
  try {
    let seq = 0;
    const run = (script, args, o) => m.run(script, args, { ...(o || {}), env: { ...env, ...((o && o.env) || {}) } });
    // drive(code): runs an async function body inside the mirror (so it can require('./reed-search') etc.) and returns {ok, result|error}
    const drive = async (code, o) => {
      const name = `_drv-${++seq}.js`;
      m.write(`scripts/${name}`, `'use strict';
(async () => {
${code}
})().then((r) => { process.stdout.write(String.fromCharCode(10) + 'RESULT:' + JSON.stringify(r === undefined ? null : r) + String.fromCharCode(10)); try { require('./reed-browser-fetch').closeCdp(); } catch (e) { /* not loaded */ } process.exit(0); }).catch((e) => { process.stdout.write(String.fromCharCode(10) + 'ERROR:' + JSON.stringify({ message: e.message, status: e.status, code: e.code }) + String.fromCharCode(10)); process.exit(1); });
`);
      const r = await run(name, [], o);
      const rm = r.stdout.match(/^RESULT:(.*)$/m);
      const em = r.stdout.match(/^ERROR:(.*)$/m);
      return { ok: !!rm, result: rm ? JSON.parse(rm[1]) : undefined, error: em ? JSON.parse(em[1]) : undefined, stdout: r.stdout, stderr: r.stderr, code: r.code };
    };
    return await fn({ m, fake, env, run, drive });
  } finally {
    await fake.close();
    m.cleanup();
  }
}

function writeSession(m, { token, expiresAtSecs, raw } = {}) {
  const exp = expiresAtSecs === undefined ? Math.floor(Date.now() / 1000) + 1800 : expiresAtSecs;
  const t = token || makeJwt(exp);
  m.write('state/reed-session.json', raw || { accessToken: t, refreshToken: null, expiresAt: exp, obtainedAt: new Date().toISOString() });
  return t;
}

// A session file whose token the fake API accepts.
function validSession(m, fake, ttlSecs) {
  fake.site.tokenTtlSecs = ttlSecs || 1800;
  const tok = fake.site.issueToken();
  const exp = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).exp;
  writeSession(m, { token: tok, expiresAtSecs: exp });
  return tok;
}

function writeCreds(m, creds) {
  m.write('secrets/reed-credentials.json', creds || { email: 'reed.test.user@example.invalid', password: 'Pw-SENTINEL-1234' }, 0o600);
}

const isWin = process.platform === 'win32';
const fileMode = (p) => (fs.statSync(p).mode & 0o777);

module.exports = { withWorld, writeSession, validSession, writeCreds, isWin, fileMode };
