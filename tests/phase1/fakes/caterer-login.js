'use strict';
// Fake login module: ensureLoggedIn({allowRelogin}) can heal the fake session, throw, or hang.
const { scenario, readState, writeState, logCall } = require('./common');

async function ensureLoggedIn(opts) {
  const cfg = scenario().login || {};
  logCall('caterer-login', { opts });
  if (cfg.hang) return new Promise(() => {});
  if (cfg.throws) throw new Error('login exploded');
  if (cfg.heals) {
    const sess = readState('session.json', scenario().session || {});
    sess.cookieValid = true;
    sess.browserOnLogin = false;
    writeState('session.json', sess);
  }
  return { state: cfg.heals ? 'ok' : 'login', ok: Boolean(cfg.heals) };
}

module.exports = { ensureLoggedIn };
