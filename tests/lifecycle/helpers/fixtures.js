'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('./sqlite');

// Synthetic candidate cards (no real people): ids are plain integers, names are obviously fake.
function card(id, extra = {}) {
  return {
    id: String(id), firstName: 'Test', lastName: `Person${id}`, name: `Test Person${id}`,
    email: `test${id}@example.invalid`, phone: '07000 000000', city: 'Testville', postcode: 'TE1 1ST',
    currentTitle: 'Chef', cvUrl: `/cv/${id}`, ...extra,
  };
}

function writeQueue(ws, name, over = {}) {
  const queue = {
    searchDate: '2026-09-29', jobTitle: 'Chef', location: 'LS1', distance: 20, activeWithin: 'month',
    keywords: '', cvLimit: 20, candidateCount: 40, creditsRemaining: 44000,
    phase1StartedAt: '2026-09-29T09:00:00.000Z', requestedAt: '2026-09-29T08:59:00.000Z',
    phase1Stats: { pagesScraped: 3, approved: 2, skippedDb: 30, skippedReview: 8, errors: 0, totalCandidatesSeen: 40 },
    screeningModel: 'test-model', candidates: [], ...over,
  };
  fs.mkdirSync(ws.downloads, { recursive: true });
  const file = path.join(ws.downloads, name);
  fs.writeFileSync(file, JSON.stringify(queue));
  return file;
}

function writeCv(ws, id, { source = 'caterer', ext = '.pdf', bytes = 300 } = {}) {
  const file = path.join(ws.downloads, `${source === 'reed' ? 'cv-reed-' : 'cv-'}${id}${ext}`);
  fs.mkdirSync(ws.downloads, { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 0x25));
  return file;
}

function fakeResponse({ ok = true, status = 200, statusText = 'OK', contentType = 'application/pdf', disposition = '', body = Buffer.alloc(300, 0x25) } = {}) {
  return {
    ok, status, statusText,
    headers: { get: k => ({ 'content-type': contentType, 'content-disposition': disposition })[k.toLowerCase()] || null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

function dbHelpers(dbFile) {
  return {
    open: () => new Database(dbFile, { timeout: 5000 }),
    zohoId(id, source = 'caterer') {
      const db = new Database(dbFile, { readonly: true });
      try {
        const row = db.prepare(source === 'reed' ? 'SELECT zoho_id FROM candidates WHERE reed_id = ?' : 'SELECT zoho_id FROM candidates WHERE caterer_id = ?').get(Number(id));
        return row ? row.zoho_id : undefined;
      } finally { db.close(); }
    },
    runResults() {
      const db = new Database(dbFile, { readonly: true });
      try { return db.prepare('SELECT * FROM run_results ORDER BY run_key').all(); } finally { db.close(); }
    },
  };
}

module.exports = { card, writeQueue, writeCv, fakeResponse, dbHelpers };
