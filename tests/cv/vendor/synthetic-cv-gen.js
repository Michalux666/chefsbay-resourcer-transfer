// Ported from cv-corpus/tests/synthetic-cv-gen.js by tools/vendor-tests.js; only mechanical edits, see that tool.
'use strict';
// Synthetic CV generator with GROUND TRUTH. Everything is invented; used to measure the role parser objectively.
const crypto = require('crypto');
const seedFrom = str => crypto.createHash('sha256').update(String(str)).digest().readUInt32LE(0);
function mulberry32(a) {
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TITLES = ['Head Chef', 'Sous Chef', 'Chef de Partie', 'Commis Chef', 'Kitchen Porter', 'Kitchen Assistant', 'Cook', 'Catering Assistant', 'Waiter', 'Bartender', 'Line Cook', 'Pastry Chef', 'Restaurant Manager',
  'Kitchen Manager', 'Demi Chef de Partie', 'Junior Sous Chef', 'Executive Chef', 'Breakfast Chef', 'Banqueting Chef', 'Warehouse Operative', 'Sales Assistant', 'Delivery Driver', 'Cleaner', 'Barista', 'Supervisor'];
const ADJ = ['Golden', 'Silver', 'Red', 'Royal', 'Old', 'Green', 'Blue', 'Crown', 'Rose', 'Mill'];
const NOUN = ['Lion', 'Anchor', 'Oak', 'Swan', 'Bell', 'Fox', 'Harbour', 'Garden', 'Bridge', 'Tower'];
const KIND = ['Hotel', 'Inn', 'Brasserie', 'Bistro', 'Cafe', 'Restaurant', 'Grill', 'Arms', 'Tavern'];
const SUR = ['Marlow', 'Pennick', 'Tavish', 'Corwen', 'Ashby', 'Dunmore', 'Kestrel', 'Larkin'];
const CORP = ['Catering Ltd', 'Foods Ltd', 'Group', 'Hospitality Ltd', 'Services Limited', 'Events Ltd'];
const DUTY = ['Prepared and cooked food to order for busy services.', 'Kept the kitchen clean and followed food safety rules.', 'Ordered stock and managed deliveries each week.', 'Trained new starters on the section.',
  'Worked closely with the team during lunch and dinner service.', 'Helped plan menus and costed dishes.', 'Handled allergens and labelled all preparation.', 'Covered the pass when the head chef was away.'];
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// hard mode: employer names that contain title words, cities, employment-type brackets, short duty fragments
const HARD_EMP = ['The Kitchen Table', "Cook's Arms", 'Chef & Brewer', 'The Porter House', 'Food For Thought Ltd', 'The Bar Kitchen', 'Catering Assistant Agency Ltd'];
const CITY = ['London', 'Leeds, UK', 'Bristol', 'Manchester', 'Cardiff'];
const SHORT_DUTY = ['Sauces', 'Pastry section', 'Food preparation', 'Customer service', 'Stock control', 'Cleaning duties', 'Banqueting'];

function pick(rnd, a) { return a[Math.floor(rnd() * a.length)]; }

function employer(rnd) {
  const k = Math.floor(rnd() * 4);
  if (k === 0) return `The ${pick(rnd, ADJ)} ${pick(rnd, NOUN)}`;
  if (k === 1) return `${pick(rnd, SUR)}'s ${pick(rnd, KIND)}`;
  if (k === 2) return `${pick(rnd, SUR)} ${pick(rnd, KIND)}`;
  return `${pick(rnd, SUR)} ${pick(rnd, CORP)}`;
}

// ground-truth roles, most recent first
function makeRoles(rnd, n, { present } = {}) {
  const roles = [];
  let endY = 2026;
  let endM = 9;
  for (let i = 0; i < n; i += 1) {
    const isPresent = i === 0 && present;
    const durMonths = 6 + Math.floor(rnd() * 40);
    const gap = Math.floor(rnd() * 4);
    let eY = endY;
    let eM = endM;
    if (i > 0) { eM -= gap; while (eM < 1) { eM += 12; eY -= 1; } }
    if (isPresent) { eY = 2026; eM = 9; }
    let sTotal = eY * 12 + (eM - 1) - durMonths;
    const sY = Math.floor(sTotal / 12);
    const sM = (sTotal % 12) + 1;
    roles.push({ title: pick(rnd, TITLES), employer: employer(rnd), start: { y: sY, m: sM }, end: isPresent ? 'present' : { y: eY, m: eM }, duties: Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(rnd, DUTY)) });
    sTotal -= 1;
    endY = Math.floor((sTotal) / 12);
    endM = (sTotal % 12) + 1;
  }
  return roles;
}

function harden(rnd, roles) {
  for (const r of roles) {
    if (rnd() < 0.2) r.employer = pick(rnd, HARD_EMP);
    if (rnd() < 0.4) r.employerText = `${r.employer}, ${pick(rnd, CITY)}`;
    if (rnd() < 0.25) r.titleText = `${r.title} (${pick(rnd, ['Full Time', 'Part Time', 'Temporary'])})`;
    if (rnd() < 0.4) r.duties = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(rnd, SHORT_DUTY));
  }
}

const pad = (n) => String(n).padStart(2, '0');
const DATE_FORMATS = {
  mon3: (r) => `${MON3[r.start.m - 1]} ${r.start.y} - ${r.end === 'present' ? 'Present' : `${MON3[r.end.m - 1]} ${r.end.y}`}`,
  monTo: (r) => `${MONL[r.start.m - 1]} ${r.start.y} to ${r.end === 'present' ? 'date' : `${MONL[r.end.m - 1]} ${r.end.y}`}`,
  numeric: (r) => `${pad(r.start.m)}/${r.start.y} - ${r.end === 'present' ? 'present' : `${pad(r.end.m)}/${r.end.y}`}`,
  year: (r) => `${r.start.y} - ${r.end === 'present' ? 'Present' : r.end.y}`,
};

const T = (r) => r.titleText || r.title;
const E = (r) => r.employerText || r.employer;
const DUTY_LINES = (d, style) => (style === 'bullet' ? d.map((x) => `- ${x}`) : style === 'dot' ? d.map((x) => `\u2022 ${x}`) : [d.join(' ')]);

// layout name -> function(role, dateText, dutyStyle) -> lines
const LAYOUT_FNS = {
  titleEmployerDate: (r, dt, ds) => [T(r), E(r), dt, ...DUTY_LINES(r.duties, ds), ''],
  employerTitleDate: (r, dt, ds) => [E(r), T(r), dt, ...DUTY_LINES(r.duties, ds), ''],
  dateTitleEmployer: (r, dt, ds) => [dt, T(r), E(r), ...DUTY_LINES(r.duties, ds), ''],
  titleDateEmployer: (r, dt, ds) => [T(r), dt, E(r), ...DUTY_LINES(r.duties, ds), ''],
  pipe: (r, dt, ds) => [`${T(r)} | ${E(r)} | ${dt}`, ...DUTY_LINES(r.duties, ds), ''],
  dashTitleEmployerDate: (r, dt, ds) => [`${T(r)} - ${E(r)}   ${dt}`, ...DUTY_LINES(r.duties, ds), ''],
  atParen: (r, dt, ds) => [`${T(r)} at ${E(r)} (${dt})`, ...DUTY_LINES(r.duties, ds), ''],
  commaLine: (r, dt, ds) => [`${T(r)}, ${E(r)}, ${dt}`, ...DUTY_LINES(r.duties, ds), ''],
  employerDashTitleDateLine2: (r, dt, ds) => [`${E(r)} - ${T(r)}`, dt, ...DUTY_LINES(r.duties, ds), ''],
  table3: (r, dt) => [`${dt}\t${E(r)}\t${T(r)}`],
  tableTitleFirst: (r, dt) => [`${T(r)}\t${E(r)}\t${dt}`],
  labelled: (r, dt, ds) => [`Job Title: ${T(r)}`, `Company: ${E(r)}`, `Dates: ${dt}`, ...DUTY_LINES(r.duties, ds), ''],
};

const HEADINGS = ['WORK EXPERIENCE', 'Employment History', 'PROFESSIONAL EXPERIENCE', 'Experience', 'Career History', 'WORK HISTORY'];

function makeCv(seed, opts = {}) {
  const rnd = mulberry32(seedFrom(seed));
  const layout = opts.layout || pick(rnd, Object.keys(LAYOUT_FNS));
  const dateFmt = opts.dateFmt || pick(rnd, Object.keys(DATE_FORMATS));
  const ds = opts.dutyStyle || pick(rnd, ['bullet', 'dot', 'para']);
  const n = opts.roles || 2 + Math.floor(rnd() * 5);
  const roles = makeRoles(rnd, n, { present: rnd() < 0.5 });
  if (opts.hard) harden(rnd, roles);
  const lines = [];
  lines.push('CURRICULUM VITAE');
  if (rnd() < 0.7) lines.push('PROFILE', 'A reliable and hard working kitchen professional with a positive attitude and years of experience in busy venues.', '');
  if (rnd() < 0.3) lines.push('KEY SKILLS', 'Menu planning, stock control, food safety, team leadership', '');
  lines.push(pick(rnd, HEADINGS));
  for (const r of roles) lines.push(...LAYOUT_FNS[layout](r, DATE_FORMATS[dateFmt](r), ds));
  if (rnd() < 0.8) lines.push('EDUCATION', '2005 - 2007 Sample College', 'Level 2 NVQ in Professional Cookery', '');
  if (rnd() < 0.5) lines.push('INTERESTS', 'Football, cooking and travel', '');
  return { text: lines.join('\n'), roles, layout, dateFmt, dutyStyle: ds };
}

module.exports = { makeCv, LAYOUT_FNS, DATE_FORMATS, TITLES };
