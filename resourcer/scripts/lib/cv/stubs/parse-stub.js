'use strict';
// STUB role parser: finds date ranges in the experience part of a redacted CV and takes the words around them as title,
// employer and duties. parse.js prefers ./vendor/role-parser.js when it exists. It holds no table of job titles: a role is a
// line that carries a date range. Pure function, no I/O.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE = '(?:' + MONTH + String.raw`\.?,?\s+\d{4}|\d{1,2}[/.]\d{4}|\d{4}[/-]\d{1,2}|\d{4})`;
const PRESENT = '(?:present|current|currently|now|to date|ongoing|today)';
const RANGE = new RegExp('(' + DATE + ')' + String.raw`\s*(?:-|\u2013|\u2014|to|until|till)\s*(` + DATE + '|' + PRESENT + ')', 'i');
const BULLET = /^[\u2022*-]\s*/;

const HEADING = [
  ['experience', /^\W*(?:(?:work|employment|career|professional|relevant|recent)\s+)?(?:experience|history|employment)\b.{0,30}$/i],
  ['education', /^\W*(?:education|qualifications?|training|certificates?|courses?)\b.{0,30}$/i],
  ['skip', /^\W*(?:references?|referees?|personal(?:\s+details)?|interests?|hobbies|declaration|profile|summary|skills?|languages?)\b.{0,30}$/i],
];

function ym(text, isEnd) {
  const t = String(text).toLowerCase().trim();
  if (new RegExp('^' + PRESENT + '$').test(t)) return 'present';
  let m = /(\d{4})[/-](\d{1,2})/.exec(t);
  if (m) return m[1] + '-' + String(m[2]).padStart(2, '0');
  m = /(\d{1,2})[/.](\d{4})/.exec(t);
  if (m) return m[2] + '-' + String(m[1]).padStart(2, '0');
  m = new RegExp('(' + MONTH + ')' + String.raw`\.?,?\s+(\d{4})`).exec(t);
  if (m) return m[2] + '-' + String(MONTHS[m[1].slice(0, 3)]).padStart(2, '0');
  m = /(\d{4})/.exec(t);
  return m ? m[1] + '-' + (isEnd ? '12' : '01') : null;
}

function splitHead(head) {
  const s = head.replace(/^[\s\-\u2022*|,:;]+|[\s\-\u2022*|,:;]+$/g, '').trim();
  const m = /\s+(?:\||@|\bat\b|-|\u2013|\u2014)\s+|,\s+/.exec(s);
  if (!m) return { title: s, employer: '' };
  return { title: s.slice(0, m.index).trim(), employer: s.slice(m.index + m[0].length).trim() };
}

const headingOf = line => {
  const t = line.trim();
  if (!t || t.length > 50) return null;
  for (const [name, re] of HEADING) if (re.test(t)) return name;
  return null;
};

/** @returns {{roles:object[], qualifications:string[], skills:string[], parseConfidence:number}} */
function parseRoles(text) {
  const lines = String(text || '').split('\n');
  const roles = [];
  const quals = [];
  let section = 'experience';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = headingOf(line);
    if (h) { section = h; continue; }
    if (section === 'education') {
      const t = line.trim().replace(BULLET, '');
      if (t && t.length <= 60 && quals.length < 12) quals.push(t);
      continue;
    }
    if (section === 'skip') continue;
    const m = RANGE.exec(line);
    if (!m) continue;
    const start = ym(m[1], false);
    const end = ym(m[2], true);
    let head = (line.slice(0, m.index) + ' ' + line.slice(m.index + m[0].length)).trim();
    if (head.replace(/[^A-Za-z]/g, '').length < 3) {
      for (let j = i - 1; j >= 0 && j >= i - 2; j--) {
        const prev = lines[j].trim();
        if (prev && !RANGE.test(prev) && !headingOf(prev)) { head = prev; break; }
      }
    }
    const { title, employer } = splitHead(head);
    const duties = [];
    for (let j = i + 1; j < lines.length && duties.length < 6; j++) {
      const next = lines[j].trim();
      if (!next || RANGE.test(next) || headingOf(next)) break;
      if (BULLET.test(next) || next.length <= 120) duties.push(next.replace(BULLET, ''));
    }
    roles.push({ title, employer, start, end, months: null, duties, evidence: '' });
  }
  const parseConfidence = roles.length ? Math.min(0.9, 0.4 + 0.1 * roles.length) : (String(text || '').length > 400 ? 0.1 : 0.5);
  return { roles, qualifications: quals, skills: [], parseConfidence };
}

module.exports = { parseRoles };
