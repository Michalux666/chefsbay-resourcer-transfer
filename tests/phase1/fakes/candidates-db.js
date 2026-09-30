'use strict';
// Fake candidates-db.js CLI backed by a JSON file: check, check-batch-scoped, add, seen, reject-title, get-zoho-id.
const fs = require('fs');
const path = require('path');
const { scenario, readState, writeState, logCall } = require('./common');

function load() {
  const sc = scenario();
  return readState('db.json', {
    candidates: Object.assign({}, (sc.db && sc.db.candidates) || {}),
    rejections: ((sc.db && sc.db.rejections) || []).slice(),
    zoho: Object.assign({}, (sc.db && sc.db.zoho) || {}),
  });
}

function main() {
  const [, , cmd, ...args] = process.argv;
  const sc = scenario();
  const opts = sc.db || {};
  const db = load();
  logCall('candidates-db', { cmd, args });

  if (opts.dbBroken && cmd !== 'get-zoho-id') { process.stderr.write('Error: file is not a database\n'); process.exit(cmd === 'check' || cmd === 'check-reed' ? 2 : 1); }
  if (opts.writeFail && (cmd === 'add' || cmd === 'seen' || cmd === 'reject-title')) { process.stderr.write('Error: attempt to write a readonly database\n'); process.exit(1); }
  if (opts.checkCrash && cmd === 'check') { process.stderr.write('Error: node crashed before printing\n'); process.exit(1); }
  if (cmd === 'check') {
    if (opts.checkExit2) { process.stderr.write('check failed: database is locked\n'); process.exit(2); }
    const id = String(parseInt(args[0], 10));
    if (!parseInt(args[0], 10)) { process.stderr.write('Usage: check <id>\n'); process.exit(2); }
    const row = db.candidates[id];
    if (row) { console.log(row.unlocked ? `UNLOCKED: ${id}` : `SEEN: ${id}`); process.exit(0); }
    console.log(`NEW: ${id}`);
    process.exit(1);
  }
  if (cmd === 'check-batch-scoped') {
    if (opts.batchFail) { process.stderr.write('Error: database is locked\n'); process.exit(1); }
    if (opts.batchGarbage) { console.log('not json at all'); process.exit(0); }
    const ids = (args[0] || '').split(/[,\s]+/).map((s) => parseInt(s, 10)).filter(Boolean);
    const title = args[1] || '';
    const inDb = ids.filter((id) => {
      const row = db.candidates[String(id)];
      if (row && row.unlocked) return true;
      return db.rejections.some((r) => String(r.id) === String(id) && (r.title === title || r.title === '*'));
    });
    console.log(JSON.stringify({ inDb }));
    process.exit(0);
  }
  if (cmd === 'add') {
    const id = String(parseInt(args[0], 10));
    db.candidates[id] = { unlocked: 1 };
    writeState('db.json', db);
    // which candidates the queue file already holds at the moment the database marks this one
    const queueIds = [];
    try {
      const dir = path.join(process.env.RESOURCER_HOME || path.resolve(__dirname, '..'), 'downloads');
      for (const q of fs.readdirSync(dir).filter((n) => /^approved-queue-/.test(n))) for (const c of JSON.parse(fs.readFileSync(path.join(dir, q), 'utf8')).candidates) queueIds.push(String(c.id));
    } catch (e) { /* no queue file yet */ }
    logCall('candidates-db-add', { id, queueIds });
    console.log(`ADDED: ${id}`);
    process.exit(0);
  }
  if (cmd === 'seen') {
    const id = String(parseInt(args[0], 10));
    db.candidates[id] = { unlocked: Math.max((db.candidates[id] || {}).unlocked || 0, 0) };
    writeState('db.json', db);
    console.log(`SEEN: ${id}`);
    process.exit(0);
  }
  if (cmd === 'reject-title') {
    const id = String(parseInt(args[0], 10));
    if (!db.rejections.some((r) => String(r.id) === id && r.title === args[1])) db.rejections.push({ id, title: args[1] });
    writeState('db.json', db);
    process.exit(0);
  }
  if (cmd === 'get-zoho-id') {
    const id = String(parseInt(args[0], 10));
    if (db.zoho[id]) { console.log(db.zoho[id]); process.exit(0); }
    process.exit(1);
  }
  process.stderr.write(`unknown command ${cmd}\n`);
  process.exit(1);
}

main();
