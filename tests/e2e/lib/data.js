'use strict';
// Synthetic world for the rehearsal: fake secrets, fake people (with greppable markers), fake CV files
// and the Caterer search pages / unlock answers derived from them. Nothing here is a real value.
const zlib = require('zlib');

// Planted secrets. Any of these turning up in a log, outbox or shadow file is a leak.
const SECRETS = {
  aiKey: 'fake-test-key',
  catererUser: 'e2e.recruiter@example.invalid',
  catererPass: 'E2E-caterer-pw-Qz7-not-real',
  zohoClientId: 'E2E-zoho-client-id-1000.ABCDEF',
  zohoClientSecret: 'E2E-zoho-client-secret-0123456789abcdef',
  zohoAccess: 'E2E-zoho-access-token-stale',
  zohoRefresh: 'E2E-zoho-refresh-token-1000.cccc',
  zohoFreshAccess: 'E2E-zoho-access-token-fresh',
  reedEmail: 'e2e.reed@example.invalid',
  reedPass: 'E2E-reed-pw-4444-not-real',
  bundlePassphrase: 'e2e bundle passphrase for the rehearsal 0001',
  backupPassphrase: 'e2e backup passphrase for the rehearsal 0002',
  deadmanUrl: 'http://127.0.0.1:9/e2e-deadman-secret-token',
  sessionCookie: 'E2E-session-cookie-decoy',
};

const TERRITORY = { jobTitle: 'Chef', location: 'LS29', distance: 20 };

// Person markers: a value that must never appear outside the queue / result files that the retention sweep removes.
function person(n) {
  const pad = String(n).padStart(2, '0');
  return {
    first: `ZZ-FAKE-NAME-${n}`,
    last: `ZZ-FAKE-SURNAME-${n}`,
    email: `zz-fake-email-${n}@example.invalid`,
    phone: `0700000${pad}00`.slice(0, 11),
    snippetMarker: `ZZ-FAKE-SNIPPET-${n}`,
    cvMarker: `ZZ-FAKE-CV-${n}`,
  };
}

// scenario tokens are read by tests/fake-gateway/server.js: [[REJECT]] makes the LLM (and Jev) reject.
// kind: what the rehearsal expects to happen to the card.
//   approve   batch approve, unlock, single approve, pushed
//   reject    batch reject
//   indb      already in candidates (skipped before screening)
//   rejtitle  in candidate_rejections for this job title (skipped)
//   otherrej  in candidate_rejections for another job title only (screened again)
//   late      batch approve, unlocked, rejected by the post-unlock review
//   dup       approved and pushed, but Zoho already has the candidate (DUPLICATE_DATA)
//   nophone   approved; the unlock has no phone number, so Phase 2 must recover it from the CV text
const CANDIDATES = [
  { id: 71000001, n: 1, kind: 'approve', page: 1, title: 'Chef de Partie', city: 'Leeds', pc: 'LS29 8AA', exp: 6, cv: 'pdf' },
  { id: 71000002, n: 2, kind: 'reject', page: 1, title: 'Retail Cashier', city: 'Otley', pc: 'LS21 1AB', exp: 3, tokens: '[[REJECT]]' },
  { id: 71000003, n: 3, kind: 'indb', page: 1, title: 'Sous Chef', city: 'Ilkley', pc: 'LS29 9AA', exp: 8 },
  { id: 71000004, n: 4, kind: 'rejtitle', page: 1, title: 'Waiter', city: 'Leeds', pc: 'LS6 1AA', exp: 2 },
  { id: 71000005, n: 5, kind: 'approve', page: 2, title: 'Commis Chef', city: 'Ilkley', pc: 'LS29 7XX', exp: 2, cv: 'docx' },
  { id: 71000006, n: 6, kind: 'reject', page: 2, title: 'Driver', city: 'Leeds', pc: 'LS1 4AB', exp: 5, tokens: '[[REJECT]]' },
  { id: 71000007, n: 7, kind: 'otherrej', page: 2, title: 'Kitchen Porter', city: 'Leeds', pc: 'LS11 5AA', exp: 1, cv: 'pdf' },
  { id: 71000008, n: 8, kind: 'late', page: 2, title: 'Chef', city: 'Leeds', pc: 'LS8 2AA', exp: 4, unlockTitle: 'Bank Clerk [[REJECT]]' },
  { id: 71000009, n: 9, kind: 'approve', page: 3, title: 'Head Chef', city: 'Ilkley', pc: 'LS29 6AA', exp: 12, cv: 'pdf' },
  { id: 71000010, n: 10, kind: 'dup', page: 3, title: 'Line Cook', city: 'Leeds', pc: 'LS2 9AA', exp: 3, cv: 'pdf' },
  { id: 71000011, n: 11, kind: 'nophone', page: 3, title: 'Chef de Partie', city: 'Otley', pc: 'LS21 2BB', exp: 5, cv: 'pdf', noPhone: true },
];

const EXPECT_PUSHED = CANDIDATES.filter((c) => ['approve', 'otherrej', 'dup', 'nophone'].includes(c.kind));

function cardOf(c) {
  const p = person(c.n);
  const name = `${p.first} ${p.last}`;
  const tokens = c.tokens || '';
  const text = `${c.n}. ${name} ${c.title} | ${c.city}, ${c.pc} ${c.exp} years experience Recent experience ${c.title} at Fake Kitchen ${c.n} Ltd ${p.snippetMarker} ${tokens}`;
  return {
    id: String(c.id), name, postcode: c.pc, city: c.city, exp: c.exp,
    neverUnlocked: c.kind !== 'indb', unlockedPrev: c.kind === 'indb',
    text, dataValue: `e2e-token-${c.id}-${c.n}`,
  };
}

function encIdOf(c) { return `ENC${c.id}x`; }
function auditIdOf(c) { return `AUD${c.id}`; }

function unlockHtml(c) {
  const p = person(c.n);
  const title = c.unlockTitle || c.title;
  const phone = c.noPhone ? '' : `<div id="candidate-details-phone-${c.id}" class="ph">${p.phone}</div>`;
  return [
    `<div class="flex-row person"><span>${p.first} ${p.last}</span></div>`,
    `<a href="mailto:${p.email}">${p.email}</a>`,
    phone,
    `<a class="dl" data-href="/CandidateSearch/CandidateDownloadCV.aspx?candidateId=${encodeURIComponent(encIdOf(c))}&amp;CandidateSearchAuditId=${encodeURIComponent(auditIdOf(c))}">CV</a>`,
    `<div class="candidate-identifier-summary"><span>${title}</span><span> | ${c.city}, ${c.pc}</span></div>`,
  ].join('\n').replace(/&amp;/g, '&');
}

// ------------------------------------------------------------------ CV files

function pdfEscape(s) { return String(s).replace(/[\\()]/g, (m) => '\\' + m); }

function makePdf(lines) {
  const stream = 'BT /F1 11 Tf 72 720 Td 14 TL ' + lines.map((l) => `(${pdfEscape(l)}) Tj T*`).join(' ') + ' ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function zipStore(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x21, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}

function makeDocx(lines) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const body = lines.map((l) => `<w:p><w:r><w:t>${esc(l)}</w:t></w:r></w:p>`).join('');
  return zipStore([
    ['[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')],
    ['_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')],
    ['word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`)],
  ]);
}

function cvLines(c) {
  const p = person(c.n);
  return [
    `${p.first} ${p.last}`,
    `Email: ${p.email}`,
    `Mobile: ${p.phone}`,
    `${c.city}, ${c.pc}`,
    `${c.title} - ${c.exp} years in professional kitchens`,
    `${p.cvMarker} ${p.snippetMarker}`,
    'Skills: knife skills, food safety level 3, stock control, banqueting for 200 covers.',
  ];
}

function cvFile(c) {
  if (c.cv === 'docx') {
    return { buffer: makeDocx(cvLines(c)), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: 'cv.docx' };
  }
  return { buffer: makePdf(cvLines(c)), contentType: 'application/pdf', filename: 'cv.pdf' };
}

// scenario.json fragment for the fake agent-browser: search pages plus unlock and CV answers.
function siteWorld(cands, opts) {
  const o = opts || {};
  const pages = {};
  const fetches = [];
  for (const c of cands) {
    if (o.onlyKinds && !o.onlyKinds.includes(c.kind)) continue;
    const card = cardOf(c);
    (pages[c.page] = pages[c.page] || []).push(card);
    const unlock = { Instructions: [{ Content: { Contents: [unlockHtml(c)] } }] };
    fetches.push({ match: `UnlockCandidate?${new URLSearchParams({ CandidateData: card.dataValue }).toString()}`, status: 200, body: JSON.stringify(unlock) });
    if (c.cv) {
      const f = cvFile(c);
      fetches.push({
        match: `${new URLSearchParams({ candidateId: encIdOf(c) }).toString()}&`,
        status: 200,
        headers: { 'content-type': f.contentType, 'content-disposition': `attachment; filename="${f.filename}"` },
        bodyBase64: f.buffer.toString('base64'),
      });
    }
  }
  return {
    searchWorld: { byLocation: { [o.location || TERRITORY.location]: { pages } } },
    fetch: fetches,
  };
}

module.exports = {
  SECRETS, TERRITORY, CANDIDATES, EXPECT_PUSHED, person, cardOf, unlockHtml, encIdOf, auditIdOf, makePdf, makeDocx, cvFile, siteWorld,
};
