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
// $E2E_REED_CV_TEXT replaces the text of every Reed CV download (the stock text has no employment history, so the CV screening stage could not read it)
if (process.env.E2E_REED_CV_TEXT) {
  const orig = fr.startFakeReed;
  fr.startFakeReed = async (o) => {
    const fake = await orig(o);
    fake.api.cvText = process.env.E2E_REED_CV_TEXT;
    return fake;
  };
}
// $E2E_REED_REQUEST_LOG: every request the fake Reed API receives is appended to that file as one JSON line (method, path, and for a search the
// activityTimeFrame, page and page size), so the rehearsal can read what Reed was really asked (scenario 20).
if (process.env.E2E_REED_REQUEST_LOG) {
  const orig = fr.startFakeReed;
  fr.startFakeReed = async (o) => {
    const fake = await orig(o);
    const file = process.env.E2E_REED_REQUEST_LOG;
    fake.api.requests = {
      push(rec) {
        let b = {};
        try { b = JSON.parse(rec.body || '{}'); } catch { b = {}; }
        try { fs.appendFileSync(file, JSON.stringify({ method: rec.method, path: rec.path, activityTimeFrame: b.activityTimeFrame, currentPage: b.currentPage, pageItemCount: b.pageItemCount }) + '\n'); } catch { /* the log is optional */ }
        return 0;
      },
    };
    return fake;
  };
}
require('../../reed/helpers/fake-chromium');
