'use strict';

// reed-download: daily 600 cap from reed_daily_usage, credit accounting, retries with token refresh, CV sanity checks, PII-free logs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { withWorld, validSession, isWin, fileMode } = require('./helpers/world');

const world = (fn, o) => withWorld(fn, { fake: { loggedIn: true }, ...(o || {}) });
const usageRow = (m) => {
  const D = require('./helpers/mirror').dep('better-sqlite3');
  const db = new D(m.p('candidates.db'), { readonly: true, fileMustExist: true });
  try { return db.prepare('SELECT * FROM reed_daily_usage').all(); } finally { db.close(); }
};
const seedUsage = (m, row) => {
  const D = require('./helpers/mirror').dep('better-sqlite3');
  const db = new D(m.p('candidates.db'));
  db.exec('CREATE TABLE IF NOT EXISTS reed_daily_usage (date TEXT PRIMARY KEY, profile_views INTEGER DEFAULT 0, cv_downloads INTEGER DEFAULT 0, daily_limit INTEGER DEFAULT 300)');
  db.prepare('INSERT OR REPLACE INTO reed_daily_usage (date, profile_views, cv_downloads, daily_limit) VALUES (?, ?, ?, ?)').run(new Date().toISOString().slice(0, 10), row.views, row.cvs || 0, row.limit);
  db.close();
};

test('downloadCandidate: profile + CV saved, both credits counted in reed_daily_usage, no PII in the logs', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  const r = await drive(`
    const { downloadCandidate } = require('./reed-download');
    const res = await downloadCandidate({ candidateId: 9001, queryId: 'q-fake-0001', keywords: 'Chef' });
    return { creditsUsed: res.creditsUsed, hasEmail: !!res.profileData.email, cvPath: res.cvPath && require('path').basename(res.cvPath) };
  `);
  assert.ok(r.ok, JSON.stringify(r.error) + r.stderr);
  assert.deepStrictEqual(r.result, { creditsUsed: 2, hasEmail: true, cvPath: 'cv-reed-9001.txt' });
  assert.ok(fs.existsSync(m.p('downloads', 'cv-reed-9001.txt')));
  if (!isWin) assert.strictEqual(fileMode(m.p('downloads', 'cv-reed-9001.txt')), 0o600);
  const rows = usageRow(m);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].profile_views, 1);
  assert.strictEqual(rows[0].cv_downloads, 1);
  assert.strictEqual(rows[0].daily_limit, 600);
  const bodies = fake.api.requests.filter((q) => q.path.startsWith('/candidate/')).map((q) => ({ path: q.path, body: JSON.parse(q.body) }));
  assert.deepStrictEqual(bodies[0], { path: '/candidate/profile/', body: { candidateId: 9001, queryId: 'q-fake-0001', queryEventSource: 'candidateCard' } });
  assert.deepStrictEqual(bodies[1], { path: '/candidate/cv/download/', body: { candidateId: 9001, queryId: 'q-fake-0001', savedSearchId: null } });
  assert.ok(!/example\.invalid|07000/.test(r.stderr + r.stdout), 'contact details must not be logged');
}));

test('daily cap: at profile_views >= daily_limit the download throws DAILY_LIMIT_REACHED and makes no API call', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  seedUsage(m, { views: 600, limit: 600 });
  let r = await drive(`
    try { await require('./reed-download').downloadCandidate({ candidateId: 9001, queryId: 'q' }); return 'no error'; } catch (e) { return e.message; }
  `);
  assert.strictEqual(r.result, 'DAILY_LIMIT_REACHED: 600/600 profile views used today');
  assert.strictEqual(fake.api.requests.filter((q) => q.path.startsWith('/candidate/')).length, 0);
  seedUsage(m, { views: 299, limit: 300 });
  r = await drive("const x = await require('./reed-download').downloadCandidate({ candidateId: 9001, queryId: 'q', profileOnly: true }); return x.creditsUsed;");
  assert.strictEqual(r.result, 1, 'one below the limit still downloads');
  r = await drive(`
    try { await require('./reed-download').downloadCandidate({ candidateId: 9002, queryId: 'q' }); return 'no error'; } catch (e) { return e.message; }
  `);
  assert.strictEqual(r.result, 'DAILY_LIMIT_REACHED: 300/300 profile views used today', 'the per-row limit is honoured');
}));

test('missing usage row or table falls back to zero usage with the 600 default limit', () => world(async ({ m, fake, drive }) => {
  const r = await drive(`
    const d = require('./reed-download');
    const u = d.getTodayUsageFromDb();
    return { views: u.profile_views, limit: u.daily_limit };
  `);
  assert.deepStrictEqual(r.result, { views: 0, limit: 600 });
}));

test('a profile without contact details triggers a token refresh and one retry (each view counts)', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  fake.api.profileNoContact = 1;
  const r = await drive(`
    const res = await require('./reed-download').downloadCandidate({ candidateId: 9003, queryId: 'q', profileOnly: true });
    return { credits: res.creditsUsed, email: !!res.profileData.email };
  `);
  assert.ok(r.ok, JSON.stringify(r.error) + r.stderr);
  assert.deepStrictEqual(r.result, { credits: 1, email: true });
  assert.match(r.stderr, /forcing token refresh and retrying/);
  assert.strictEqual(usageRow(m)[0].profile_views, 2);
  const navs = fake.calls.filter((c) => c.method === 'Page.navigate').length;
  assert.ok(navs >= 1, 'token refresh navigated the tab');
}));

test('profile failing twice: profileOnly rethrows, otherwise the CV download is still attempted', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  fake.api.failNext = [{ status: 500 }, { status: 500 }];
  let r = await drive(`
    try { await require('./reed-download').downloadCandidate({ candidateId: 9004, queryId: 'q', profileOnly: true }); return 'no error'; } catch (e) { return e.message.slice(0, 30); }
  `);
  assert.match(r.result, /^Reed API POST HTTP 500/);
  fake.api.failNext = [{ status: 500 }, { status: 500 }];
  r = await drive(`
    const res = await require('./reed-download').downloadCandidate({ candidateId: 9005, queryId: 'q' });
    return { profile: res.profileData, cv: !!res.cvPath, credits: res.creditsUsed };
  `);
  assert.deepStrictEqual(r.result, { profile: null, cv: true, credits: 1 });
}));

test('HTML or tiny CV bodies are rejected, retried once with a token refresh, and the run continues with the profile', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  for (const kind of ['html', 'tiny']) {
    fake.api.cvKind = kind;
    const r = await drive(`
      const res = await require('./reed-download').downloadCandidate({ candidateId: 9006, queryId: 'q' });
      return { cv: res.cvPath, credits: res.creditsUsed };
    `);
    assert.deepStrictEqual(r.result, { cv: null, credits: 1 }, kind);
    assert.match(r.stderr, kind === 'html' ? /returned HTML/ : /very small file/);
    assert.match(r.stderr, /CV retry also failed/);
  }
  assert.strictEqual(fs.existsSync(m.p('downloads', 'cv-reed-9006.txt')), false);
  assert.strictEqual(usageRow(m)[0].cv_downloads || 0, 0, 'no cv_download counted for rejected bodies');
}));

test('anonymized CV is free (no cv_download credit) and saved as cv-reed-<id>.anon<ext>: classified as a CV by the retention sweep, never picked up by the Phase 2 reader', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  const r = await drive(`
    const ret = require('./lib/cv-retention');
    const res = await require('./reed-download').downloadCandidate({ candidateId: 9007, queryId: 'q', keywords: 'Chef', anonymizedCv: true, cvOnly: true });
    const name = require('path').basename(res.cvPath);
    const c = ret.classifyDownloadName(name);
    const readerNames = [...ret.cvBasenames('9007', 'reed'), ...ret.cvBasenames('9007', 'caterer')];
    const plan = ret.planDownloadsSweep({ now: Date.now() + 15 * 86400000, entries: [{ name, size: 10, mtimeMs: Date.now(), type: 'file' }], readResults: () => null, readStatus: () => null, queueInfo: () => null });
    return { credits: res.creditsUsed, name, kind: c.kind, id: c.match[2], prefix: c.match[1], readerHasIt: readerNames.includes(name), actions: plan.actions.map((a) => [a.kind, a.reason, a.id, a.source]) };
  `);
  assert.deepStrictEqual(r.result, { credits: 0, name: 'cv-reed-9007.anontxt', kind: 'cv', id: '9007', prefix: 'reed-', readerHasIt: false, actions: [['cv', 'orphan', '9007', 'reed']] });
  assert.ok(fs.existsSync(m.p('downloads', 'cv-reed-9007.anontxt')));
  assert.strictEqual(fs.existsSync(m.p('downloads', 'cv-reed-9007.txt')), false, 'the real-CV name stays free for the paid CV');
  const anon = fake.api.requests.find((q) => q.path === '/candidate/cv/download/anonymized/');
  assert.deepStrictEqual(JSON.parse(anon.body), { candidateId: 9007, savedSearchId: null, keywords: 'Chef' });
}));

test('anonymizedCvName: known extensions are kept (any case), anything else becomes pdf, the id must be numeric', () => world(async ({ drive }) => {
  const r = await drive(`
    const { anonymizedCvName } = require('./reed-download');
    const out = ['.pdf', '.DOCX', 'doc', '.rtf', '.txt', '.exe', '', null, '.p/../x'].map((e) => anonymizedCvName(42, e));
    let bad = [];
    for (const id of ['abc', '1/../2', '', '12.5', '9'.repeat(21)]) { try { anonymizedCvName(id, '.pdf'); bad.push('accepted ' + id); } catch (e) { bad.push('rejected'); } }
    return { out, bad };
  `);
  assert.deepStrictEqual(r.result.out, ['cv-reed-42.anonpdf', 'cv-reed-42.anondocx', 'cv-reed-42.anondoc', 'cv-reed-42.anonrtf', 'cv-reed-42.anontxt', 'cv-reed-42.anonpdf', 'cv-reed-42.anonpdf', 'cv-reed-42.anonpdf', 'cv-reed-42.anonpdf']);
  assert.deepStrictEqual(r.result.bad, ['rejected', 'rejected', 'rejected', 'rejected', 'rejected']);
}));

test('a non-numeric candidate id is refused before any request or credit and nothing is written', () => world(async ({ m, fake, drive }) => {
  validSession(m, fake);
  const r = await drive(`
    const d = require('./reed-download');
    const errs = [];
    for (const f of [() => d.downloadCandidate({ candidateId: 'abc', queryId: 'q' }), () => d.downloadAnonymizedCv('1/../../x', 'Chef'), () => d.downloadCv('7x', 'q')]) {
      try { await f(); errs.push('no error'); } catch (e) { errs.push(e.message.slice(0, 27)); }
    }
    return errs;
  `);
  assert.deepStrictEqual(r.result, ['candidateId must be numeric', 'candidateId must be numeric', 'candidateId must be numeric']);
  assert.strictEqual(fake.api.requests.filter((q) => q.path.startsWith('/candidate/')).length, 0, 'no API call, so no credit');
  assert.ok(!fs.existsSync(m.p('downloads')) || fs.readdirSync(m.p('downloads')).length === 0);
}));

test('CLI: --check-quota, --help, missing/invalid candidate id', () => world(async ({ m, fake, run }) => {
  validSession(m, fake);
  let r = await run('reed-download.js', ['--check-quota']);
  assert.strictEqual(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.apiQuota.dailyLimit, 600);
  assert.strictEqual(j.dbTracked.dailyLimit, 600);
  r = await run('reed-download.js', ['--help']);
  assert.strictEqual(r.code, 0);
  r = await run('reed-download.js', []);
  assert.strictEqual(r.code, 1);
  r = await run('reed-download.js', ['--candidate-id', 'abc']);
  assert.strictEqual(r.code, 1);
  r = await run('reed-download.js', ['--candidate-id', '9010', '--query-id', 'q', '--profile-only']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).creditsUsed, 1);
}));

test('normalizeProfileToZoho maps the profile and falls back to card data / ids', () => world(async ({ drive }) => {
  const r = await drive(`
    const { normalizeProfileToZoho } = require('./reed-download');
    const full = normalizeProfileToZoho({ candidateId: 5, name: 'Ann Lee', email: 'a@example.invalid', phoneNumber: '07 000 000 000',
      address: { town: 'Leeds', postcode: 'LS1 1AA', county: 'West Yorkshire' },
      workHistory: [{ startDate: '2020-01-01', endDate: '2022-01-01' }] }, { jobTitle: 'Chef', location: 'LS1', distance: 15 }, {});
    const bare = normalizeProfileToZoho({}, { jobTitle: 'Chef' }, { id: 77, currentLocation: 'Hull', currentJobTitle: 'Cook' });
    return { full, bare };
  `);
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.strictEqual(r.result.full.First_Name, 'Ann');
  assert.strictEqual(r.result.full.Last_Name, 'Lee');
  assert.strictEqual(r.result.full.Mobile, '07000000000');
  assert.strictEqual(r.result.full.City, 'Leeds');
  assert.strictEqual(r.result.full.Zip_Code, 'LS1 1AA');
  assert.strictEqual(r.result.full.Experience_in_Years, 2);
  assert.strictEqual(r.result.full.Search_Criteria, 'Chef | LS1 | 15mi');
  assert.strictEqual(r.result.full.Source, 'Reed');
  assert.strictEqual(r.result.full.ReedID, '5');
  assert.strictEqual(r.result.bare.First_Name, 'Unknown');
  assert.strictEqual(r.result.bare.Last_Name, '77');
  assert.strictEqual(r.result.bare.City, 'Hull');
  assert.strictEqual(r.result.bare.Current_Job_Title, 'Cook');
  assert.strictEqual(r.result.bare.Experience_in_Years, null);
}));
