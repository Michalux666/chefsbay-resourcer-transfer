'use strict';
// IDENTITY SNAPSHOT of the role scope (docs/ROLESCOPE.md R-C7): runs whole worlds and writes everything the pipeline leaves behind into one normalised JSON file.
// It is not a scenario (the name has no number): tests/e2e-identity.sh runs it on the tree of the previous release and on this tree and compares the files.
//
//   E2E_IDENTITY_OUT=<file>   where the JSON goes (without it the test only checks that the worlds run)
//
// Worlds (each in its own simulated profile; fake people only):
//   cat-default   the standard Caterer world of scenario 2, the shipped defaults
//   cat-off       the same with ROLE_SCOPE_LEGACY=off
//   both-default  Caterer and Reed (the fake Reed site), some Reed cards rejected by the screening, nothing legacy in the database
//   both-legacy-off  the same world with people the old system left behind (Caterer unlocked and never pushed, Reed seen only: no record of any role) and
//                    ROLE_SCOPE_LEGACY=off: the old skip for exactly these people
//   both-legacy-on   the control: the same leftovers with the role scope on (the default); the comparison must find it DIFFERENT from the previous release
// What the NEW code writes that the previous release does not (the per-title ledger of Reed: origin reed:snippet and reed:approved, the part of the fix that has no
// switch) is taken out of the rows and COUNTED separately, so the comparison says plainly what differs: nothing else may.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { oneWorld, WORLDS } = require('./lib/identity');

const out = {};
for (const [name, o] of Object.entries(WORLDS)) {
  test(`identity world ${name}`, async () => {
    out[name] = await oneWorld(`s19-id-${name}`, o);
    assert.ok(out[name].results.length >= 1 && out[name].zoho.length >= 5, 'the world ran');
  });
}

test.after(() => {
  if (process.env.E2E_IDENTITY_OUT) fs.writeFileSync(process.env.E2E_IDENTITY_OUT, JSON.stringify(out, null, 1));
});

