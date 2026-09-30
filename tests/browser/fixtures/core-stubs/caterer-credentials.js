'use strict';
// TEST STUB standing in for resourcer/scripts/lib/caterer-credentials.js (owned by the core package)
// when that file is not in the repo yet. Same contract the login code relies on: load() returns
// {username, password} from secrets/caterer-credentials.json and throws on missing/invalid/placeholder.
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const CRED_PATH = path.join(paths.SECRETS, 'caterer-credentials.json');

function load() {
  let raw;
  try { raw = fs.readFileSync(CRED_PATH, 'utf8'); } catch {
    throw new Error(`Caterer credentials not found at ${CRED_PATH}.`);
  }
  let cred;
  try { cred = JSON.parse(raw.replace(/^\ufeff/, '')); } catch (e) {
    throw new Error(`Caterer credentials at ${CRED_PATH} is not valid JSON: ${e.message}`);
  }
  if (!cred.username || !cred.password) throw new Error(`Caterer credentials at ${CRED_PATH} needs both "username" and "password".`);
  if (/^<.*>$/.test(cred.password) || /password\s*here|your\s*password|changeme|xxxx|todo/i.test(cred.password)) {
    throw new Error(`Caterer password at ${CRED_PATH} is still a placeholder, not a real password.`);
  }
  return { username: cred.username, password: cred.password };
}

module.exports = { load, CRED_PATH };
