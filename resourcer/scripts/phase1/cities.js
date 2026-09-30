'use strict';
const fs = require('fs');
const { readJsonStrict } = require('./util');

// Loads config/postcode-cities.json into {postcodeMap: area -> {city,county}, cityToCounty: CITY -> county}.
// The first entry seen for a city wins (the map has no conflicting duplicates today).
function loadPostcodeMaps(file) {
  const postcodeMap = new Map();
  const cityToCounty = new Map();
  if (!fs.existsSync(file)) return { postcodeMap, cityToCounty };
  const parsed = readJsonStrict(file);
  for (const area of Object.keys(parsed)) postcodeMap.set(area.toUpperCase(), parsed[area] || {});
  for (const entry of postcodeMap.values()) {
    const city = entry.city ? String(entry.city).trim() : '';
    const county = entry.county ? String(entry.county).trim() : '';
    if (city && !cityToCounty.has(city.toUpperCase())) cityToCounty.set(city.toUpperCase(), county);
  }
  return { postcodeMap, cityToCounty };
}

function getPostcodeArea(postcode) {
  if (!postcode) return '';
  const p = String(postcode).replace(/\s/g, '').toUpperCase();
  const m = p.match(/^([A-Z]{1,2})/);
  return m ? m[1] : '';
}

function getCityFromPostcode(maps, postcode) {
  const area = getPostcodeArea(postcode);
  if (area && maps.postcodeMap.has(area)) {
    const city = maps.postcodeMap.get(area).city;
    if (city) return city;
  }
  return '';
}

function getStateFromCity(maps, city) {
  if (!city) return '';
  const key = String(city).trim().toUpperCase();
  return maps.cityToCounty.has(key) ? maps.cityToCounty.get(key) : '';
}

// Caterer often returns a location-shaped title such as "Manchester, M22 4AD"; use that city first.
function getCityFromTitle(title) {
  if (!title) return '';
  const t = String(title).trim();
  const m = t.match(/^([^,]{2,40}),\s*[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}$/);
  if (!m) return '';
  const city = m[1].trim();
  if (!city) return '';
  if (/^\d+$/.test(city)) return '';
  return city;
}

const BACKSLASH = String.fromCharCode(92);
const REGEX_SPECIALS = '.*+?^${}()|[]' + BACKSLASH;

function escapeRegex(s) {
  let out = '';
  for (const ch of s) out += REGEX_SPECIALS.includes(ch) ? BACKSLASH + ch : ch;
  return out;
}

// Best-effort job title from the card snippet head ("3. First Last Title | City, PC ...").
function getTitleFromSnippet(snippet, candidateName) {
  if (!snippet) return '';
  let head = String(snippet).split('|')[0];
  head = head.replace(/^\s*\d+\.\s*/, '');
  if (candidateName && String(candidateName).trim()) {
    head = head.replace(new RegExp('^' + String.raw`\s*` + escapeRegex(String(candidateName).trim()) + String.raw`\s*`, 'i'), '');
  }
  head = head.replace(/\s+(Unlock candidate|Forward details|Download CV|View CV|Invite to apply).*$/i, '');
  return head.trim();
}

// Post-unlock titles that are only a postcode carry no role information.
function isPostcodeTitle(titleStr) {
  return /^[A-Z]{1,2}\d{1,2}[\s,]/i.test(titleStr) || /^[A-Z]{1,2}\d{1,2}$/i.test(titleStr);
}

// Zoho city resolution order: unlocked title city -> postcode map -> raw card scrape.
function resolveCity(maps, unlockedTitle, postcode, cityRaw) {
  const fromTitle = getCityFromTitle(unlockedTitle);
  if (fromTitle) return fromTitle;
  const fromPostcode = getCityFromPostcode(maps, postcode);
  if (fromPostcode) return fromPostcode;
  if (cityRaw && String(cityRaw).trim().length > 2) return String(cityRaw).trim();
  return '';
}

module.exports = {
  loadPostcodeMaps, getPostcodeArea, getCityFromPostcode, getStateFromCity, getCityFromTitle,
  getTitleFromSnippet, isPostcodeTitle, resolveCity,
};
