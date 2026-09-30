'use strict';
// The keyword filter for prompt-injection attempts in the structured fields of a CV. It is one of TWO signals (the other is Jev's
// own injection answer): a CV goes to the fallback lane only when both fire. The patterns live in config (injection.patterns);
// only the folding of cheap evasions is fixed here: invisible characters, look-alike letters, and l e t t e r spacing.

const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u2060-\u2064\ufeff]/g;
const LOOKALIKE = { '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0445': 'x', '\u0456': 'i', '\u0443': 'y', '\u03bf': 'o', '\u03b1': 'a', '\u03b5': 'e', '\u0455': 's', '\u04bb': 'h' };
const LOOKALIKE_RE = /[\u0430\u0435\u043e\u0440\u0441\u0445\u0456\u0443\u03bf\u03b1\u03b5\u0455\u04bb]/g;

/** The text as a keyword filter should see it: normalised, visible, look-alikes undone, spaced-out words joined, single spaces. */
function fold(input) {
  let t = String(input === undefined || input === null ? '' : input);
  try { t = t.normalize('NFKC'); } catch (e) { /* keep as is */ }
  t = t.replace(INVISIBLE, '').replace(LOOKALIKE_RE, ch => LOOKALIKE[ch]);
  t = t.replace(/(?<![a-z])(?:[a-z] ){2,}[a-z](?![a-z])/gi, m => m.replace(/ /g, ''));
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * @param {string[]} texts  the fields of the structured CV (titles, employers, duties, qualifications)
 * @param {RegExp[]} patterns  compiled by config.js
 * @returns {{hit:boolean, count:number}} how many patterns matched anywhere
 */
function scan(texts, patterns) {
  const folded = texts.map(fold).filter(Boolean);
  const joined = folded.join(' ; ').slice(0, 60000);
  let count = 0;
  for (const re of patterns) if (re.test(joined)) count++;
  return { hit: count > 0, count };
}

module.exports = { fold, scan };
