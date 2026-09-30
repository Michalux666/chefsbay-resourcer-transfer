'use strict';
// node --require preload: answers the Zoho / postcodes.io requests the core CLIs make, from a
// canned script in FAKE_SERVICES (JSON). Every request is appended to FAKE_LOG (JSON lines).
// Loaded after netguard.js, so any other host still fails.
const fs = require('fs');
const { createFake } = require('./fake-services');

const cfg = JSON.parse(process.env.FAKE_SERVICES || '{}');
const LOG = process.env.FAKE_LOG;

globalThis.fetch = createFake(
  cfg,
  (entry) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(entry) + '\n'); },
  globalThis.fetch
);
