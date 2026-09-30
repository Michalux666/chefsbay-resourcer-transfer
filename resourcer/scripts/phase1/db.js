'use strict';
const paths = require('../lib/paths');
const { runNode } = require('./proc');
const { scriptPath } = require('./config');

const idStr = (v) => (v === undefined || v === null ? '' : String(v));

// Runs one candidates-db.js subcommand exactly like the legacy `node candidates-db.js ...`.
function dbRun(ctx, args) {
  return runNode(scriptPath('candidates-db'), args.map(String), { cwd: paths.HOME, timeoutMs: ctx.cfg.timeoutMs.db });
}

// A bookkeeping write that fails is reported, and a streak of failures marks the database as broken so the run stops.
async function dbWrite(ctx, args) {
  const r = await dbRun(ctx, args);
  const failed = r.timedOut || r.error || r.code !== 0;
  if (failed) {
    ctx.out(`WARN candidates-db ${args[0]} ${idStr(args[1])} failed (exit ${r.code === null ? 'none' : r.code}${r.timedOut ? ', timeout' : ''})`);
  }
  const st = ctx.st;
  if (st) {
    st.dbFailStreak = failed ? (st.dbFailStreak || 0) + 1 : 0;
    if (failed) st.errors++;
    if (failed && st.dbFailStreak >= (ctx.cfg.dbFailLimit || 3)) st.dbBroken = true;
  }
  return r;
}

module.exports = { dbRun, dbWrite, idStr };
