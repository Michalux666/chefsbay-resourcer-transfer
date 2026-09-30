// Single source of truth for the Caterer login (the pipeline seat).
//
// 2026-08-23: the password used to be hardcoded in ~20 scripts. Rotating it meant finding
// every copy, and the copies drifted -- that is exactly what silently broke auto-relogin on
// 2026-07-04 (the React-form fix landed in one login script but not in the duplicate
// inside the runner). Everything now reads secrets/caterer-credentials.json.
//
// Read fresh on every call (no module-level cache) so a password rotation takes effect
// without restarting anything.
//
// Do NOT hardcode the password anywhere. Do NOT log the return value of load().
'use strict';

const path = require('path');
const fs = require('fs');
const paths = require('./paths');

const CRED_PATH = path.join(paths.SECRETS, 'caterer-credentials.json');

function load() {
  let raw;
  try {
    raw = fs.readFileSync(CRED_PATH, 'utf8');
  } catch (e) {
    throw new Error(
      `Caterer credentials not found at ${CRED_PATH}. ` +
      'Create it as {"username":"...","password":"..."} (see docs/SECURITY.md).'
    );
  }
  let cred;
  try {
    cred = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch (e) {
    throw new Error(`Caterer credentials at ${CRED_PATH} is not valid JSON: ${e.message}`);
  }
  if (!cred.username || !cred.password) {
    throw new Error(`Caterer credentials at ${CRED_PATH} needs both "username" and "password".`);
  }
  assertNotPlaceholder(cred.password);
  return { username: cred.username, password: cred.password };
}

// 2026-08-24: the credentials file was once saved with the literal template placeholder
// "<new password here>" still in it. That reached Caterer as a real login attempt and came
// back "email address or password was incorrect" -- and this account HAS been locked before
// by repeated failed logins (2026-04-12). Fail fast and locally instead of spending an
// attempt on a value that cannot possibly be right.
function assertNotPlaceholder(pw) {
  const looksTemplated = /^<.*>$/.test(pw) || /password\s*here|your\s*password|changeme|xxxx|todo/i.test(pw);
  if (looksTemplated) {
    throw new Error(
      `Caterer password at ${CRED_PATH} is still a placeholder, not a real password. ` +
      'Replace it with the actual password. NOT attempting a login (repeated failures can ' +
      'lock the account).'
    );
  }
}

// Escape a value for embedding inside a single-quoted JavaScript string literal:
// backslash -> two backslashes, quote -> backslash quote, CR/LF removed.
const BS = String.fromCharCode(92);
function jsLit(s) {
  return String(s).split(BS).join(BS + BS).split("'").join(BS + "'").replace(/[\r\n]/g, '');
}

// Convenience: the standard React-safe fill snippet, credentials already substituted.
// Caterer's login form is React-controlled -- a raw `.value =` assignment does not register,
// so use the native HTMLInputElement setter + real input/change events (verified 2026-07-01).
function buildFillJs() {
  const c = load();
  return "(function(){function setVal(el,val){var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}"
    + "var u=document.querySelector('[name=username]')||document.querySelector('input[type=email]'),"
    + "p=document.querySelector('[name=password]')||document.querySelector('input[type=password]');"
    + "if(!u||!p)return'NOFORM';"
    + "setVal(u,'" + jsLit(c.username) + "');setVal(p,'" + jsLit(c.password) + "');return'FILLED';})()";
}

module.exports = { load, jsLit, buildFillJs, CRED_PATH };
