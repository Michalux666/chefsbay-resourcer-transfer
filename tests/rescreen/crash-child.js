'use strict';
// Child of the crash-recovery test of tests/rescreen/apply.test.js: runs the real --apply and kills itself (SIGKILL: no cleanup, no rollback code, no exit handler)
// in the middle of the deletes, after the ledger was written and while the transaction is open.
const tool = require('../../tools/rescreen-policy-rejects');

const [home, killAt, confirm] = process.argv.slice(2);
tool.main(['--home', home, '--apply', '--confirm', confirm], {
  out: () => {},
  err: () => {},
  now: new Date('2026-10-01T12:00:00Z'),
  env: { RESOURCER_HOME: home, RESOURCER_SOURCES: 'both' },
  busy: () => false,
  backup: { log2n: 12 },
  hooks: { afterDelete: (n) => { if (n === Number(killAt)) process.kill(process.pid, 'SIGKILL'); } },
}).then((code) => process.exit(code), () => process.exit(1));
