// Ported from cv-corpus/tests/text-extract.test.js by tools/vendor-tests.js; only mechanical edits, see that tool.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../../../resourcer/scripts/lib/cv/vendor/text-extract');
const H = require('./helpers');

const FILLER = 'Prepared and served food for one hundred guests each evening in a busy hotel restaurant kitchen, working closely with the team.';

test('sniffType uses magic bytes, not the extension', () => {
  assert.equal(X.sniffType(H.makePdf(['hello'])), 'pdf');
  assert.equal(X.sniffType(H.makeDocx(['hello'])), 'zip');
  assert.equal(X.sniffType(H.makeRtf(['hello'])), 'rtf');
  assert.equal(X.sniffType(Buffer.from('plain text cv')), 'txt');
  assert.equal(X.sniffType(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), 'doc_binary');
  assert.equal(X.sniffType(Buffer.alloc(0)), 'empty');
  assert.equal(X.sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 'image');
  assert.equal(X.sniffType(Buffer.from([1, 2, 3, 0, 0, 0, 9, 9, 9, 0, 0, 0, 0, 0, 0, 0])), 'unknown');
});

test('DOCX: paragraphs, bullets, table rows and text boxes (no doubled text)', async () => {
  const docx = H.makeDocx([
    'WORK EXPERIENCE',
    { bullet: FILLER },
    { table: [['Jan 2019 - Mar 2021', 'The Test Kitchen', 'Head Chef'], ['Apr 2016 - Dec 2018', 'Sample Hotel', 'Sous Chef']] },
    { textbox: `Boxed text ${FILLER}` },
    'Closing paragraph. ' + FILLER,
  ]);
  const r = await X.extractText(docx, { fileName: 'cv.docx' });
  assert.equal(r.status, 'ok');
  assert.equal(r.fileType, 'docx');
  assert.match(r.text, /^WORK EXPERIENCE\n\u2022 Prepared and served/);
  assert.ok(r.text.includes('Jan 2019 - Mar 2021\tThe Test Kitchen\tHead Chef\n'), 'table row keeps its cells on one line separated by tabs');
  assert.equal(r.text.split('Boxed text').length - 1, 1, 'text box content appears once (Fallback copy dropped)');
});

test('DOCX: a table cell with several paragraphs continues on the following lines', () => {
  const text = X.docxXmlToText('<w:document><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Jan 2019 - Mar 2021</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Head Chef</w:t></w:r></w:p><w:p><w:r><w:t>The Test Kitchen</w:t></w:r></w:p><w:p><w:r><w:t>Ran the pass</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
  assert.equal(text, 'Jan 2019 - Mar 2021\tHead Chef\n\tThe Test Kitchen\n\tRan the pass');
});

test('RTF: paragraphs, escapes and skipped groups', async () => {
  const r = await X.extractText(H.makeRtf(['WORK EXPERIENCE', `Head Chef ${FILLER}`, 'Caf\u005c\'e2 and {braces}']), { fileName: 'cv.rtf' });
  assert.equal(r.status, 'ok');
  assert.equal(r.fileType, 'rtf');
  assert.ok(r.text.startsWith('WORK EXPERIENCE\nHead Chef Prepared'));
  assert.ok(!r.text.includes('Arial'), 'font table is skipped');
  const t = X.rtfToText("{\u005crtf1\u005cansi caf\u005c'e9 \u005cu8364? end\u005cpar next\u005ctab cell}", 1000);
  assert.ok(t.includes('caf\u00e9'));
  assert.ok(t.includes('\u20ac'));
  assert.ok(t.includes('end\nnext\tcell'));
});

test('plain text: utf-8, utf-16 BOM and latin1 fallback', async () => {
  const body = `EXPERIENCE\n${FILLER}\n${FILLER}\n`;
  let r = await X.extractText(Buffer.from(body, 'utf8'), { fileName: 'cv.txt' });
  assert.equal(r.status, 'ok');
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]);
  r = await X.extractText(u16, { fileName: 'cv.txt' });
  assert.equal(r.status, 'ok');
  assert.ok(r.text.startsWith('EXPERIENCE'));
  const latin = Buffer.from(body.replace('busy', 'caf\u00e9'), 'latin1');
  r = await X.extractText(latin, { fileName: 'cv.txt' });
  assert.ok(r.text.includes('caf\u00e9'));
});

test('PDF: text layer is extracted, cells on one baseline are tab separated', async () => {
  const pdf = H.makePdf([
    { x: 72, y: 720, text: 'WORK EXPERIENCE' },
    { x: 72, y: 700, text: 'Jan 2019 - Mar 2021' }, { x: 250, y: 700, text: 'The Test Kitchen' }, { x: 420, y: 700, text: 'Head Chef' },
    { x: 72, y: 680, text: FILLER },
    { x: 72, y: 660, text: FILLER },
  ]);
  const r = await X.extractText(pdf, { fileName: 'cv.pdf' });
  assert.equal(r.status, 'ok');
  assert.equal(r.fileType, 'pdf');
  assert.equal(r.pages, 1);
  assert.ok(r.text.includes('Jan 2019 - Mar 2021\tThe Test Kitchen\tHead Chef'));
});

test('PDF: a two-column page also yields a column-order variant', async () => {
  const items = [{ x: 72, y: 740, text: 'CURRICULUM VITAE OF A SAMPLE PERSON' }];
  const left = ['SKILLS', 'Knife skills', 'Food safety', 'Stock control', 'Team leading', 'Menu costing', 'Allergen care', 'Sauces', 'Pastry basics', 'Rota planning', 'Butchery', 'Grill'];
  const right = ['WORK EXPERIENCE', 'Head Chef', 'The Test Kitchen', 'Jan 2019 - Mar 2021', 'Ran the kitchen and led a brigade', 'Sous Chef', 'Sample Hotel', 'Apr 2016 - Dec 2018', 'Sauces and larder for banqueting', 'Commis Chef', 'Old Inn', '2014 - 2016'];
  left.forEach((t, i) => items.push({ x: 60, y: 700 - i * 22, text: t }));
  right.forEach((t, i) => items.push({ x: 300, y: 700 - i * 22, text: t }));
  const r = await X.extractText(H.makePdf(items), { fileName: 'cv.pdf', limits: { minTextChars: 50 } });
  assert.equal(r.status, 'ok');
  assert.ok(r.textAlt, 'column variant present');
  const iSkills = r.textAlt.indexOf('Butchery');
  const iWork = r.textAlt.indexOf('WORK EXPERIENCE');
  assert.ok(iSkills > 0 && iWork > iSkills, 'left column is read completely before the right column');
  const rowsIdx = r.text.indexOf('Butchery');
  assert.ok(r.text.slice(0, rowsIdx).includes('Commis Chef'), 'row order interleaves the columns');
});

test('scanned / empty / unsupported files are reported, never guessed', async () => {
  let r = await X.extractText(H.makePdf(['x']), { fileName: 'scan.pdf' });
  assert.equal(r.status, 'scanned');
  assert.equal(r.text, '');
  r = await X.extractText(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]), { fileName: 'old.doc' });
  assert.deepEqual([r.status, r.reason], ['unsupported', 'doc_binary']);
  r = await X.extractText(Buffer.alloc(0), { fileName: 'empty.pdf' });
  assert.deepEqual([r.status, r.reason], ['empty', 'zero_bytes']);
  r = await X.extractText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), { fileName: 'scan.pdf' });
  assert.deepEqual([r.status, r.reason], ['unsupported', 'image_only']);
  r = await X.extractText(H.makeZip([{ name: 'xl/workbook.xml', data: '<x/>' }]), { fileName: 'cv.docx' });
  assert.equal(r.status, 'unsupported');
  r = await X.extractText(H.makeZip([{ name: 'word/document.xml', data: '<w:document><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>' }]), { fileName: 'cv.docx' });
  assert.equal(r.status, 'empty');
});

test('extension is only a hint: a DOCX named .pdf is read as DOCX and flagged', async () => {
  const r = await X.extractText(H.makeDocx(['EXPERIENCE', FILLER, FILLER]), { fileName: 'cv.pdf' });
  assert.equal(r.status, 'ok');
  assert.equal(r.fileType, 'docx');
  assert.equal(r.extMismatch, true);
});

test('limits: oversize file, zip bomb (real inflate cap, lying headers) and encrypted entries', async () => {
  let r = await X.extractText(Buffer.alloc(2000, 0x41), { fileName: 'big.txt', limits: { maxBytes: 1000 } });
  assert.deepEqual([r.status, r.reason], ['rejected', 'too_large']);
  const big = Buffer.alloc(3 * 1024 * 1024, 0x41);
  r = await X.extractText(H.makeZip([{ name: 'word/document.xml', data: big }]), { fileName: 'bomb.docx', limits: { maxXmlBytes: 1024 * 1024 } });
  assert.deepEqual([r.status, r.reason], ['rejected', 'zip_bomb']);
  r = await X.extractText(H.makeZip([{ name: 'word/document.xml', data: big, lieSize: 100 }]), { fileName: 'lie.docx', limits: { maxXmlBytes: 1024 * 1024 } });
  assert.deepEqual([r.status, r.reason], ['rejected', 'zip_bomb'], 'a header that lies about the size cannot bypass the inflate cap');
  r = await X.extractText(H.makeZip([{ name: 'word/document.xml', data: '<w:t>x</w:t>', encrypted: true }]), { fileName: 'enc.docx' });
  assert.deepEqual([r.status, r.reason], ['unsupported', 'encrypted']);
  r = await X.extractText(Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(40, 1)]), { fileName: 'trunc.docx' });
  assert.equal(r.status, 'rejected');
});

test('normalisation: ligatures, bullets, dashes, private-use icons, blank runs', () => {
  const t = X.normaliseText('Fine\ufb01sh\u00a0\u2013 chef\n\n\n\n\uf0b7 item\u200b\n\ue000icon', 1000);
  assert.equal(t, 'Finefish - chef\n\n\u2022 item\n icon'.replace('\n icon', '\nicon'));
});
