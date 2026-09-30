// Ported from cv-corpus/tests/role-parser.test.js by tools/vendor-tests.js; only mechanical edits, see that tool.
'use strict';
// SYNTHETIC CVs only (invented employers, titles and dates).
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCv, parseBest, splitParts, extractFields, mergeSplitDates } = require('../../../resourcer/scripts/lib/cv/vendor/role-parser');
const { parseDateRanges } = require('../../../resourcer/scripts/lib/cv/vendor/date-parse');
const { classifyHeading } = require('../../../resourcer/scripts/lib/cv/vendor/cv-lexicon');

const ASOF = '2026-09';
const parse = (text) => parseCv(text, { asOf: ASOF });
const brief = (r) => ({ t: r.title, e: r.employer, s: r.start, en: r.end, m: r.months });

const LAYOUTS = {
  dateLast: `WORK EXPERIENCE
Head Chef
The Test Kitchen, London
Jan 2019 - Mar 2021
- Ran a kitchen of 120 covers
- Managed a brigade of 8 chefs

Sous Chef
Sample Hotel
Apr 2016 - Dec 2018
- Sauces and larder

EDUCATION
2010 - 2012 Sample College
Level 2 NVQ in Professional Cookery`,
  dateFirst: `EXPERIENCE
Jan 2019 - Mar 2021
Head Chef
The Test Kitchen
Ran a kitchen of 120 covers and led the brigade every day.
Apr 2016 - Dec 2018
Sous Chef
Sample Hotel
Sauces and larder for the banqueting team.`,
  dateMid: `Work History
Head Chef
Jan 2019 - Mar 2021
The Test Kitchen
- Ran the kitchen
Sous Chef
Apr 2016 - Dec 2018
Sample Hotel
- Sauces`,
  sameLinePipe: `EMPLOYMENT HISTORY
Head Chef | The Test Kitchen | Jan 2019 - Present
Prepared food for a hundred guests each evening.
Sous Chef | Sample Hotel | Apr 2016 - Dec 2018
Assisted the head chef with menus and ordering.`,
  sameLineAt: `Experience
Head Chef at The Test Kitchen (Jan 2019 - Mar 2021)
Ran the pass every night.
Sous Chef at Sample Hotel (Apr 2016 - Dec 2018)
Sauces.`,
  sameLineComma: `EMPLOYMENT
Head Chef, The Test Kitchen, Jan 2019 - Mar 2021
Ran the kitchen and the pass for a busy service.
Sous Chef, Sample Hotel, Apr 2016 - Dec 2018
Sauces and larder.`,
  employerFirst: `EXPERIENCE
The Test Restaurant, London
Head Chef
Jan 2019 - Mar 2021
Ran the kitchen.

Sample Hotel
Sous Chef
Apr 2016 - Dec 2018
Sauces.`,
  table: `Work Experience
Jan 2019 - Mar 2021\tThe Test Kitchen\tHead Chef
Apr 2016 - Dec 2018\tSample Hotel\tSous Chef
2014 - 2016\tThe Old Inn\tKitchen Porter`,
  tableContinuation: `Experience
Jan 2019 - Mar 2021\tHead Chef
\tThe Test Kitchen
\t\u2022 Ran the kitchen
\t\u2022 Managed 8 chefs
Apr 2016 - Dec 2018\tSous Chef
\tSample Hotel
\t\u2022 Sauces`,
  labelled: `Work Experience
Job Title: Head Chef
Company: The Test Kitchen
Dates: Jan 2019 - Mar 2021
Responsibilities:
Running the sauce section.
Position: Sous Chef
Employer: Sample Hotel
Apr 2016 - Dec 2018`,
};

test('layout: title / employer / dates, dates first, dates in the middle', () => {
  for (const name of ['dateLast', 'dateFirst', 'dateMid']) {
    const r = parse(LAYOUTS[name]);
    assert.deepEqual(r.roles.map(brief), [
      { t: 'Head Chef', e: name === 'dateLast' ? 'The Test Kitchen' : 'The Test Kitchen', s: '2019-01', en: '2021-03', m: 27 },
      { t: 'Sous Chef', e: 'Sample Hotel', s: '2016-04', en: '2018-12', m: 33 },
    ], name);
    assert.ok(r.roles.every((x) => x.confidence === 'high'), `${name}: clean layouts are high confidence`);
    assert.equal(r.parseConfidence, 'high', name);
  }
});

test('layout: title, employer and dates on one line (pipes, "at", commas, table cells)', () => {
  const pipe = parse(LAYOUTS.sameLinePipe);
  assert.deepEqual(pipe.roles.map(brief), [
    { t: 'Head Chef', e: 'The Test Kitchen', s: '2019-01', en: 'present', m: 93 },
    { t: 'Sous Chef', e: 'Sample Hotel', s: '2016-04', en: '2018-12', m: 33 },
  ]);
  for (const name of ['sameLineAt', 'sameLineComma']) {
    const r = parse(LAYOUTS[name]);
    assert.deepEqual(r.roles.map((x) => [x.title, x.employer, x.start, x.end]), [
      ['Head Chef', 'The Test Kitchen', '2019-01', '2021-03'],
      ['Sous Chef', 'Sample Hotel', '2016-04', '2018-12'],
    ], name);
  }
  const t = parse(LAYOUTS.table);
  assert.deepEqual(t.roles.map((x) => [x.title, x.employer, x.start, x.end, x.datePrecision]), [
    ['Head Chef', 'The Test Kitchen', '2019-01', '2021-03', 'month'],
    ['Sous Chef', 'Sample Hotel', '2016-04', '2018-12', 'month'],
    ['Kitchen Porter', 'The Old Inn', '2014-01', '2016-12', 'year'],
  ]);
  const tc = parse(LAYOUTS.tableContinuation);
  assert.deepEqual(tc.roles.map((x) => [x.title, x.employer, x.start]), [['Head Chef', 'The Test Kitchen', '2019-01'], ['Sous Chef', 'Sample Hotel', '2016-04']]);
  assert.match(tc.roles[0].duties, /Ran the kitchen Managed 8 chefs/);
});

test('layout: employer first, labelled fields', () => {
  const e = parse(LAYOUTS.employerFirst);
  assert.deepEqual(e.roles.map((x) => [x.title, x.employer]), [['Head Chef', 'The Test Restaurant'], ['Sous Chef', 'Sample Hotel']]);
  const l = parse(LAYOUTS.labelled);
  assert.deepEqual(l.roles.map((x) => [x.title, x.employer, x.start, x.end]), [
    ['Head Chef', 'The Test Kitchen', '2019-01', '2021-03'],
    ['Sous Chef', 'Sample Hotel', '2016-04', '2018-12'],
  ]);
});

test('date range split over two lines is merged, later line numbers stay valid', () => {
  const text = 'EXPERIENCE\nHead Chef\nThe Test Kitchen\nJan 2019\n- Mar 2021\nRan the kitchen.';
  const merged = mergeSplitDates(text.split('\n'), ASOF);
  assert.equal(merged.length, 6);
  assert.equal(merged[3], 'Jan 2019 - Mar 2021');
  assert.equal(merged[4], '');
  const r = parse(text);
  assert.deepEqual(r.roles.map((x) => [x.title, x.employer, x.start, x.end, x.duties]), [['Head Chef', 'The Test Kitchen', '2019-01', '2021-03', 'Ran the kitchen.']]);
  assert.deepEqual(r.roles[0].evidence, [2, 6]);
});

test('date precision: year-only entries are flagged, approximate and never high confidence', () => {
  const r = parse('EXPERIENCE\nKitchen Porter | The Old Inn | 2014 - 2016\nCook, Sample Bistro, Summer 2020 - Autumn 2020');
  const [a, c] = r.roles;
  assert.equal(a.datePrecision, 'year');
  assert.deepEqual([a.start, a.end, a.months], ['2014-01', '2016-12', 24]);
  assert.ok(a.flags.includes('year_only') && a.flags.includes('months_approx'));
  assert.notEqual(a.confidence, 'high');
  assert.equal(c.datePrecision, 'season');
  assert.ok(c.flags.includes('season'));
  assert.notEqual(c.confidence, 'high');
});

test('present uses asOf, so results are deterministic', () => {
  const t = 'EXPERIENCE\nHead Chef | The Test Kitchen | Jan 2026 - present';
  assert.equal(parseCv(t, { asOf: '2026-09' }).roles[0].months, 9);
  assert.equal(parseCv(t, { asOf: '2026-03' }).roles[0].months, 3);
});

test('undated entries appear only when nothing is dated, with null dates and low confidence', () => {
  const r = parse('EXPERIENCE\nHead Chef - The Test Kitchen\nRan the kitchen and the pass.\nSous Chef - Sample Hotel\nSauces.');
  assert.equal(r.roles.length, 2);
  for (const x of r.roles) {
    assert.equal(x.start, null); assert.equal(x.end, null); assert.equal(x.months, null);
    assert.equal(x.confidence, 'low');
    assert.ok(x.flags.includes('undated'));
  }
  const dated = parse('EXPERIENCE\nHead Chef - The Test Kitchen  Jan 2019 - Mar 2021\nSous Chef - Sample Hotel\nSauces.');
  assert.equal(dated.roles.length, 1, 'the undated line is not added when a dated role exists');
});

test('an open ending, reversed dates and future dates are marked low confidence and get no months', () => {
  const r = parse('EXPERIENCE\nHead Chef | The Test Kitchen | Jan 2019 -\nSous Chef | Sample Hotel | Mar 2021 - Jan 2019\nCook | Future Cafe | Jan 2031 - Mar 2032');
  const [a, b, c] = r.roles;
  assert.ok(a.flags.includes('open_end') && a.end === null && a.months === null && a.confidence === 'low');
  assert.ok(b.flags.includes('reversed') && b.months === null && b.confidence === 'low');
  assert.ok(c.flags.includes('future') && c.confidence === 'low');
});

test('sections: dates in education / skills / interests are not jobs', () => {
  const r = parse(`EDUCATION
2008 - 2010 Sample School
GCSEs in Maths and English
SKILLS
Knife skills 2015 - 2020
INTERESTS
Football 2011 - 2019
EXPERIENCE
Cook | Sample Bistro | Jan 2020 - Dec 2020`);
  assert.deepEqual(r.roles.map((x) => x.title), ['Cook']);
  const edu = parse('EXPERIENCE\nApprentice Chef | Sample College | 2010 - 2012\nLevel 2 NVQ, City College | 2012 - 2014');
  assert.deepEqual(edu.roles.map((x) => x.title), ['Apprentice Chef'], 'a strong title survives, a course line does not');
});

test('subheadings inside a role do not end the experience section', () => {
  const r = parse(`EXPERIENCE
Head Chef
The Test Kitchen
Jan 2019 - Mar 2021
Key achievements
- Won an award
Responsibilities:
- Ran the kitchen
Sous Chef
Sample Hotel
Apr 2016 - Dec 2018
- Sauces`);
  assert.equal(r.roles.length, 2);
  assert.match(r.roles[0].duties, /Won an award/);
  assert.match(r.roles[0].duties, /Ran the kitchen/);
});

test('duties are joined, bullet markers removed, capped at 240 characters', () => {
  const long = Array.from({ length: 30 }, (_, i) => `- Duty number ${i} for the kitchen team`).join('\n');
  const r = parse(`EXPERIENCE\nHead Chef | The Test Kitchen | Jan 2019 - Mar 2021\n${long}`);
  assert.ok(r.roles[0].duties.length <= 240);
  assert.ok(!r.roles[0].duties.includes('- Duty'));
  assert.ok(r.roles[0].duties.startsWith('Duty number 0 for the kitchen team Duty number 1'));
});

test('non-hospitality careers and unknown titles are handled without inventing anything', () => {
  const r = parse('Employment History\nWarehouse Operative, Sample Ltd, Jan 2019 - Mar 2021\nPicking and packing.\nZorblatt Wrangler, Imaginary Corp, 2015 - 2018');
  assert.equal(r.roles[0].title, 'Warehouse Operative');
  const z = r.roles[1];
  assert.equal(z.title, null, 'a title with no title vocabulary is not guessed');
  assert.ok(z.flags.includes('no_title'));
  assert.equal(z.confidence, 'low');
  assert.equal(z.start, '2015-01');
});

test('non-English and noise: no roles are made up', () => {
  assert.deepEqual(parse('Experiencia laboral\nJefe de cocina, Restaurante El Sol, enero 2019 - marzo 2021\nDirigi la cocina.').roles, []);
  assert.deepEqual(parse('Shopping list\nmilk\neggs\nbread').roles, []);
  assert.deepEqual(parse('').roles, []);
  assert.deepEqual(parse('   \n\n  ').roles, []);
  const junk = parse('\u0001\u0002 ~~~~ ???? ' + 'x'.repeat(5000));
  assert.deepEqual(junk.roles, []);
});

test('never invents: every title, employer and date can be found in the evidence lines', () => {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  for (const [name, text] of Object.entries(LAYOUTS)) {
    const lines = text.split('\n');
    const r = parse(text);
    assert.ok(r.roles.length > 0, name);
    for (const role of r.roles) {
      const [a, b] = role.evidence;
      assert.ok(a >= 1 && b <= lines.length && a <= b, `${name}: evidence span inside the text`);
      const span = norm(lines.slice(a - 1, b).join(' '));
      if (role.title) assert.ok(span.includes(norm(role.title)), `${name}: title "${role.title}" comes from the evidence lines`);
      if (role.employer) assert.ok(span.includes(norm(role.employer)), `${name}: employer "${role.employer}" comes from the evidence lines`);
      const spanRanges = lines.slice(a - 1, b).flatMap((l) => parseDateRanges(l, { asOf: ASOF }));
      assert.ok(spanRanges.some((d) => `${String(d.start.y).padStart(4, '0')}-${String(d.start.m).padStart(2, '0')}` === role.start), `${name}: start date is written in the evidence lines`);
    }
  }
});

test('never invents: dropping every title-bearing word leaves null titles, not made-up ones', () => {
  const stripped = LAYOUTS.dateLast.replace(/Head Chef|Sous Chef/g, 'Zorblatt Wrangler').replace(/NVQ.*/, '');
  const r = parse(stripped);
  for (const role of r.roles) assert.ok(role.title === null || (role.flags.includes('title_unverified') && role.confidence === 'low'), 'no title vocabulary: null, or a flagged low-confidence piece of the line');
  assert.ok(r.roles.every((x) => x.confidence === 'low'));
});

test('extractFields: title vs employer selection, brackets, locations, labels', () => {
  assert.deepEqual(extractFields(['Head Chef (Full Time)', 'The Test Kitchen, London, UK']), { title: 'Head Chef', titleStrong: true, titleFlag: null, titleLong: false, titleProse: false, employerProse: false, employer: 'The Test Kitchen', labelled: false });
  assert.equal(extractFields(['Head Chef', 'The Test Kitchen, [ADDRESS], [POSTCODE]']).employer, 'The Test Kitchen', 'redaction placeholders are not part of an employer');
  assert.equal(extractFields(['Head Chef', 'Mar 2021']).employer, null, 'a date fragment is never an employer');
  assert.equal(extractFields(['Head Chef and Kitchen Manager and Front of House Supervisor and Events Coordinator Team']).titleLong, true);
  assert.equal(extractFields(['Sample Hotel & Spa - Sous Chef']).title, 'Sous Chef');
  assert.equal(extractFields(['Sample Hotel & Spa - Sous Chef']).employer, 'Sample Hotel & Spa');
  assert.equal(extractFields(['Chef de Partie - Pastry Chef']).title, 'Chef de Partie - Pastry Chef');
  assert.equal(extractFields(['Job Title: Cook', 'Company: Sample Bistro']).employer, 'Sample Bistro');
  assert.deepEqual(splitParts('Cook | Sample Bistro'), ['Cook', 'Sample Bistro']);
  assert.deepEqual(splitParts('Sous Chef, Banqueting'), ['Sous Chef, Banqueting']);
  assert.deepEqual(splitParts('Accountant, Sample LLP'), ['Accountant', 'Sample LLP']);
  assert.equal(extractFields([]).title, null);
});

test('two-column jumble is flagged and never reaches high confidence; parseBest prefers the readable variant', () => {
  const jumbled = `Work Experience\nJan 2019 - Mar 2021\tSKILLS\nApr 2016 - Dec 2018\tKnife skills\n2014 - 2016\tFood safety\nHead Chef\tStock control`;
  const rows = parseCv(jumbled, { asOf: ASOF });
  assert.ok(rows.roles.every((x) => x.confidence !== 'high'));
  const good = LAYOUTS.dateLast;
  const best = parseBest([{ name: 'rows', text: jumbled }, { name: 'columns', text: good }], { asOf: ASOF });
  assert.equal(best.variant, 'columns');
  const tie = parseBest([{ name: 'rows', text: good }, { name: 'columns', text: good }], { asOf: ASOF });
  assert.equal(tie.variant, 'rows', 'row order wins ties');
});

test('a column of dates followed by the role blocks is flagged (date_column_run), not silently paired', () => {
  const r = parse('Experience\nJan 2019 - Mar 2021\nApr 2016 - Dec 2018\nJan 2014 - Dec 2015\n\nHead Chef, The Test Kitchen\nSous Chef, Sample Hotel\nCook, The Old Inn');
  assert.ok(r.diagnostics.layoutFlags.includes('date_column_run'));
  assert.ok(r.roles.filter((x) => x.flags.includes('no_header_lines')).every((x) => x.confidence === 'low'));
});

test('heading recognition covers common variants and rejects sentences', () => {
  for (const h of ['WORK EXPERIENCE', 'Work Experience:', 'Employment History', 'Professional Experience', 'CAREER HISTORY', 'WorkExperience', 'Relevant Work Experience']) assert.equal(classifyHeading(h), 'experience', h);
  for (const h of ['Education', 'Education & Qualifications', 'Certifications and licenses']) assert.equal(classifyHeading(h), 'education', h);
  for (const h of ['Key Skills', 'Core Competencies']) assert.equal(classifyHeading(h), 'skills', h);
  for (const h of ['Personal Profile', 'Professional Summary', 'About me']) assert.equal(classifyHeading(h), 'summary', h);
  assert.equal(classifyHeading('References available on request'), 'references');
  assert.equal(classifyHeading('Hobbies and Interests'), 'interests');
  assert.equal(classifyHeading('I have five years of experience in busy kitchens and love cooking for guests'), null);
  assert.equal(classifyHeading('Head Chef'), null);
  assert.equal(classifyHeading('Experience 2019'), null);
});

test('qualification and skill keyword lists', () => {
  const r = parse(`EXPERIENCE
Cook | Sample Bistro | Jan 2020 - Dec 2020
EDUCATION
Level 2 Food Safety in Catering (2019)
Level 3 Award in Food Safety
Allergen awareness training certificate
HACCP level 3, COSHH, Manual Handling, Fire Marshal, First Aid at Work
NVQ Level 2 in Professional Cookery, City & Guilds 706/2
BTEC Diploma, GCSE Maths, A-Levels
Personal Licence (APLH), WSET Level 2, DBS checked, full UK driving licence
SKILLS
Butchery, pastry, banqueting, menu costing, stock control, rota planning, team leadership, vegan menus`);
  for (const q of ['food-hygiene-l2', 'food-hygiene-l3', 'allergen-training', 'haccp', 'coshh', 'manual-handling', 'fire-safety', 'first-aid', 'nvq-l2', 'city-and-guilds', 'professional-cookery', 'btec', 'gcse', 'a-level', 'personal-licence', 'wset', 'dbs', 'driving-licence']) {
    assert.ok(r.qualifications.includes(q), `qualification ${q}`);
  }
  assert.ok(!r.qualifications.includes('food-hygiene'), 'the generic keyword is dropped when a level is known');
  for (const s of ['butchery', 'pastry', 'banqueting', 'menu-planning', 'stock-control', 'rota', 'team-leadership', 'vegan-vegetarian']) assert.ok(r.skills.includes(s), `skill ${s}`);
  assert.ok(r.qualifications.every((k) => /^[a-z0-9-]+$/.test(k)), 'plain keywords only');
});

test('robustness: huge inputs finish quickly and never throw', () => {
  const t0 = Date.now();
  parse('EXPERIENCE\n' + 'Head Chef | The Test Kitchen | Jan 2019 - Mar 2021\n- duty\n'.repeat(5000));
  parse('EXPERIENCE\n' + 'a'.repeat(300000));
  parse('EXPERIENCE\n' + 'Jan 2019 - '.repeat(20000));
  parse(Array.from({ length: 20000 }, (_, i) => `Line ${i}\t${i}\tx`).join('\n'));
  assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
  assert.ok(parse('EXPERIENCE\n' + 'Head Chef | The Test Kitchen | Jan 2019 - Mar 2021\n'.repeat(500)).roles.length <= 40, 'role count is capped');
});

test('separators: dash spacing, slash between words, double slash, chain names, hyphenated titles', () => {
  const cases = [
    ['Head Chef- The Ivy', 'Head Chef', 'The Ivy'],
    ['Head Chef -The Ivy', 'Head Chef', 'The Ivy'],
    ['Hilton/Head Chef', 'Head Chef', 'Hilton'],
    ['Bar Manager // Sample Arms', 'Bar Manager', 'Sample Arms'],
    ['Pizza Chef & Kitchen Porter Pizza Express, Leeds', 'Pizza Chef & Kitchen Porter', 'Pizza Express'],
    ['Sous-Chef at Test Bistro', 'Sous-Chef', 'Test Bistro'],
    ['Bell Hotel-Head Chef', 'Head Chef', 'Bell Hotel'],
    ['Chef/Cook | Sample Inn', 'Chef/Cook', 'Sample Inn'],
    ['Head chef in a restaurant in Leeds', 'Head chef', 'a restaurant in Leeds'],
    ['Part time Kitchen Assistant', 'Kitchen Assistant', null],
  ];
  for (const [line, title, employer] of cases) {
    const f = extractFields([line]);
    assert.equal(f.title, title, line);
    assert.equal(f.employer, employer, line);
  }
  assert.equal(extractFields(['24/7 Chef']).title, '24/7 Chef', 'digits around a slash are not a separator');
  assert.equal(extractFields(['Co-op Kitchen Porter']).title, 'Co-op Kitchen Porter', 'an ordinary hyphenated word stays whole');
  assert.equal(extractFields(['Head Chef', 'Chef & Brewer']).employer, 'Chef & Brewer', 'a chain name that contains a job word is an employer');
  assert.equal(extractFields(['Head Chef', 'The Porter House']).employer, 'The Porter House');
  assert.equal(extractFields(['Kitchen Assistant', 'Catering Assistant Agency Ltd']).title, 'Kitchen Assistant', 'a legal-form name is never the title');
  assert.equal(extractFields(['Restaurant Manager, Sample Foods Ltd']).title, 'Restaurant Manager', 'a venue word used as a modifier is not an employer');
});

test('sections: combined headings, wrapped words, and CVs whose jobs sit under an unusual heading', () => {
  assert.equal(classifyHeading('Education and Experience'), 'experience');
  assert.equal(classifyHeading('Qualifications & Work History'), 'experience');
  assert.equal(classifyHeading('Training / Employment'), 'experience');
  assert.equal(classifyHeading('Education & Training'), 'education');
  assert.equal(classifyHeading('Additional Experience'), 'experience');
  // a wrapped lower-case word ("training") on its own line is not a heading and does not end the experience section
  const r = parse(`EXPERIENCE
Head Chef | The Test Kitchen | Jan 2019 - Mar 2021
Responsible for menu design and staff
training
Sous Chef | Sample Hotel | Apr 2016 - Dec 2018
Sauces.`);
  assert.equal(r.roles.length, 2);
  // no experience heading at all, jobs listed under "Education"-like text: still found when they carry a title or an employer
  const noHeading = parse(`SOME CANDIDATE
EDUCATION AND WORK
Kitchen Porter | The Old Inn | 2014 - 2016
2010 - 2012 City College
Level 2 NVQ in Professional Cookery`);
  assert.deepEqual(noHeading.roles.map((x) => x.title), ['Kitchen Porter']);
});

test('dates in separate cells and dd.mm.yy ranges become roles (flagged, never high confidence)', () => {
  const r = parse('EXPERIENCE\n01/06/2019\t30/09/2019\tLine Cook\tSample Grill\n01.03.18 - 31.05.18\tKitchen Porter\tThe Old Inn');
  assert.deepEqual(r.roles.map((x) => [x.title, x.start, x.end]), [['Line Cook', '2019-06', '2019-09'], ['Kitchen Porter', '2018-03', '2018-05']]);
  assert.ok(r.roles[1].flags.includes('two_digit_year'));
  assert.notEqual(r.roles[1].confidence, 'high');
});

test('narrative (prose) CVs: sentence fragments are flagged low confidence, never presented as clean titles', () => {
  const f = extractFields(['Head chef and kitchen manager and cook and cleaner and the driver of the van to the shop']);
  assert.equal(f.titleProse, true);
  assert.equal(extractFields(['Head Chef', 'The Test Kitchen']).titleProse, false, 'a normal title is not prose');
  const r = parse('EXPERIENCE\nWorked as a chef with a lot of responsibility for the kitchen and the team in a hotel Jan 2019 - Mar 2021\nRan the pass.');
  for (const role of r.roles) assert.ok(role.confidence !== 'high', 'a prose entry is never high confidence');
});

test('a date range that ends on a day of the month is not read as a two-digit end year', () => {
  const rs = parseDateRanges('(1 Jan 2025 to 31 Dec)', { asOf: ASOF });
  assert.deepEqual(rs, []);
});
