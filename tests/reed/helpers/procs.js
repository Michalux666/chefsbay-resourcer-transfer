'use strict';

// /proc helpers for the Linux tests. Orphan detection is by parentage, not by "any new Xvfb": test files run in parallel processes,
// so other tests' live Xvfb servers must not count.

const fs = require('fs');
const path = require('path');

function procs() {
  const out = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${n}/stat`, 'latin1');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (rest[0] === 'Z') continue;
      const args = fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').split('\0').filter(Boolean);
      out.push({ pid: Number(n), ppid: Number(rest[1]), args, cmd: args.join(' ') });
    } catch { /* gone */ }
  }
  return out;
}

const isXvfb = (p) => path.basename(p.cmd.split(' ')[0]) === 'Xvfb';
const isWrapper = (p) => p.cmd.split(' ').some((t) => path.basename(t) === 'xvfb-run');
const withProfile = (profile) => procs().filter((p) => `${p.cmd} `.includes(`--user-data-dir=${profile} `));

// Xvfb servers that no live xvfb-run wrapper owns any more (nothing will ever clean them up).
function xvfbOrphans() {
  const all = procs();
  const byPid = new Map(all.map((p) => [p.pid, p]));
  return all.filter((p) => isXvfb(p) && !(byPid.get(p.ppid) && isWrapper(byPid.get(p.ppid)))).map((p) => p.pid);
}

module.exports = { procs, withProfile, xvfbOrphans, isXvfb };
