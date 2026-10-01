'use strict';
// Compares two identity snapshots (tests/e2e/identity-snapshot.js): node identity-compare.js <old.json> <new.json>
// Prints, per world, IDENTICAL or the keys that differ; exit 0 only when every world is identical (and the control world `-legacy-on` is NOT). The only thing allowed to differ is the count of rows of the
// per-title ledger of Reed (reedLedgerRows: origin reed:snippet and reed:approved), which the previous release does not write and which has no switch.
const fs = require('fs');

const [a, b] = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
let bad = 0;
const names = Array.from(new Set(Object.keys(a).concat(Object.keys(b)))).sort();
for (const n of names) {
  if (!a[n] || !b[n]) { console.log(`${n}: MISSING in ${a[n] ? 'new' : 'old'}`); bad += 1; continue; }
  const keys = Array.from(new Set(Object.keys(a[n]).concat(Object.keys(b[n])))).filter((k) => k !== 'reedLedgerRows').sort();
  const diff = keys.filter((k) => JSON.stringify(a[n][k]) !== JSON.stringify(b[n][k]));
  const bytes = JSON.stringify(Object.fromEntries(keys.map((k) => [k, a[n][k]]))).length;
  if (/-legacy-on$/.test(n)) {
    // the control: it must differ, or the comparison is blind
    if (diff.length) console.log(`${n}: DIFFERENT as expected (the control: the leftovers are looked at once) in ${diff.join(', ')}`);
    else { console.log(`${n}: IDENTICAL, which is wrong for the control: the comparison cannot see the role scope`); bad += 1; }
    continue;
  }
  if (diff.length) { console.log(`${n}: DIFFERENT in ${diff.join(', ')}`); bad += 1; for (const k of diff) console.log(`  ${k}\n    old: ${JSON.stringify(a[n][k]).slice(0, 400)}\n    new: ${JSON.stringify(b[n][k]).slice(0, 400)}`); }
  else console.log(`${n}: IDENTICAL (${bytes} bytes compared; per-title Reed ledger rows: old ${a[n].reedLedgerRows}, new ${b[n].reedLedgerRows})`);
}
process.exit(bad ? 1 : 0);
