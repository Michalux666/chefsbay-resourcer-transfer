'use strict';

// Tolerant equivalent of the .NET UnescapeDataString: '+' stays '+', malformed sequences stay as written.
function unescapeDataString(s) {
  return String(s).replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try { return decodeURIComponent(run); } catch (e) { return run; }
  });
}

// Strip the hash, drop any existing PageNumber, and inject the params Caterer needs.
// Returns {base, notes} where notes are the console lines the legacy script printed.
function normaliseResultsUrl(resultsUrl) {
  const notes = [];
  let base = String(resultsUrl).replace(/#.*$/, '');
  base = base.replace(/([&?])PageNumber=\d+/gi, '');
  // Removing "?PageNumber=n" from the front of a query string would otherwise leave "path&a=b".
  if (!base.includes('?') && base.includes('&')) base = base.replace('&', '?');

  // Without SearchFormType=Targeted the page serves a Smart Search view with 0 cards (CW4, 2026-04-17).
  if (!/(?:\?|&)SearchFormType=/i.test(base)) {
    base += (base.includes('?') ? '&' : '?') + 'SearchFormType=Targeted';
    notes.push('URL normalisation: appended SearchFormType=Targeted (was missing)');
  }
  if (!/(?:\?|&)SearchOptionColumn=/i.test(base)) {
    base += '&SearchOptionColumn=ExactMatch';
    notes.push('URL normalisation: appended SearchOptionColumn=ExactMatch (was missing)');
  }
  // Caterer's default page size dropped to 10 in May 2026; 50 restores the historical density.
  if (!/(?:\?|&)PageSize=/i.test(base)) {
    base += '&PageSize=50';
    notes.push('URL normalisation: appended PageSize=50 (was missing)');
  }
  return { base, notes };
}

// An encoded '&' followed by another parameter name (CW4%26SearchString=) means the URL was hand-built; a lone %26 in a title is legitimate.
function hasBadEncoding(base) {
  return /(?:\?|&)[A-Za-z0-9_]+=[^&]*%26[A-Za-z0-9_]+=/i.test(base);
}

// The signed-in browser is only ever pointed at Caterer itself.
function isCatererUrl(base) {
  try {
    const u = new URL(base);
    return u.protocol === 'https:' && (u.hostname === 'caterer.com' || u.hostname.endsWith('.caterer.com'));
  } catch (e) {
    return false;
  }
}

// Returns {ok:true} or {ok:false, urlLoc}; the comparison is case-insensitive like the legacy -ne.
function checkTerritory(base, location) {
  const m = base.match(/(?:\?|&)CurrentLocation=([^&]+)/i);
  if (!m) return { ok: true, urlLoc: '' };
  const urlLoc = unescapeDataString(m[1]).trim();
  if (urlLoc && urlLoc.toLowerCase() !== String(location).toLowerCase()) return { ok: false, urlLoc };
  return { ok: true, urlLoc };
}

function pageUrl(base, page) {
  return page === 1 ? base : `${base}&PageNumber=${page}`;
}

module.exports = { normaliseResultsUrl, hasBadEncoding, checkTerritory, pageUrl, unescapeDataString, isCatererUrl };
