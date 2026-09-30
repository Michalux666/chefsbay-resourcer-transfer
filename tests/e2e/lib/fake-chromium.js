#!/usr/bin/env node
'use strict';
/*
 * Stand-in for chromium in the rehearsal: the Reed package's fake browser (CDP + Reed API on 127.0.0.1) with candidate
 * cards that carry the rehearsal's markers. $E2E_REED_CANDIDATES_FILE (optional JSON array of card overrides) replaces
 * the 30 default cards; anything else is the stock fake.
 */
const fs = require('fs');
const fr = require('../../reed/helpers/fake-reed');

const file = process.env.E2E_REED_CANDIDATES_FILE;
if (file) {
  let cards = null;
  try { cards = JSON.parse(fs.readFileSync(file, 'utf8')).map((o, i) => fr.makeCard(i + 1, o)); } catch { cards = null; }
  if (cards) {
    const orig = fr.startFakeReed;
    fr.startFakeReed = (o) => orig(Object.assign({}, o, { candidates: cards }));
  }
}
require('../../reed/helpers/fake-chromium');
