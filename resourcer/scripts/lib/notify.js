'use strict';
const path = require('path');
const paths = require('./paths');
const fsx = require('./fsx');
const env = require('./env');

const FILE = path.join(paths.OUTBOX, 'alerts.jsonl');

function notify({ severity = 'info', key, text, meta } = {}) {
  if (!text) return false;
  const rec = {
    ts: new Date().toISOString(),
    severity: ['info', 'warn', 'critical'].includes(severity) ? severity : 'info',
    key: key || null,
    text: env.redact(String(text)).slice(0, 1000),
  };
  if (meta && typeof meta === 'object') rec.meta = JSON.parse(env.redact(JSON.stringify(meta)));
  try {
    fsx.appendLine(FILE, JSON.stringify(rec));
    return true;
  } catch {
    return false;
  }
}

module.exports = { notify, FILE };
