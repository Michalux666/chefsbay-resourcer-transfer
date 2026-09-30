// Vendored from cv-corpus/lib/pdf-layout.js (source sha256 7cc331406b38) by tools/vendor-corpus.js; only mechanical edits, see that tool.
'use strict';
// Coordinate based text reconstruction for one PDF page (pure function, no PDF library needed: it takes text items).
//
//   layoutPage(items, { pageWidth }) -> { rows, columns, gutter }
//     items: [{ str, x, y, w, h }]  (pdf.js text items: x/y from the transform, w = width, h = font height; y grows upwards)
//     rows:    text in row order, big horizontal gaps become TAB (table cells / side-by-side columns stay on one line)
//     columns: text in column reading order (left column, then right column, per horizontal band) or null when the page
//              has no two-column structure
//     gutter:  x position of the detected gutter or null
//
// Why two variants: pdf.js emits items in content-stream order and pdf-parse joins runs on the same baseline with spaces,
// so a two-column CV comes out interleaved. Table layouts (date | employer | title) need the row order; sidebar layouts
// need the column order. The caller parses both and keeps the better parse.

function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function buildLines(items) {
  const real = items.filter((i) => typeof i.str === 'string' && i.str.trim() !== '' && Number.isFinite(i.x) && Number.isFinite(i.y));
  if (real.length === 0) return { lines: [], medianH: 0, pitch: 0 };
  const medianH = median(real.map((i) => i.h || 10)) || 10;
  const tol = Math.max(1.5, 0.45 * medianH);
  const sorted = real.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const lines = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= tol) { last.items.push(it); last.y = (last.y * (last.items.length - 1) + it.y) / last.items.length; }
    else lines.push({ y: it.y, items: [it] });
  }
  const cellGap = Math.max(12, 1.3 * medianH);
  for (const ln of lines) {
    ln.items.sort((a, b) => a.x - b.x);
    const segs = [];
    let cur = null;
    for (const it of ln.items) {
      const h = it.h || medianH;
      if (!cur) { cur = { x0: it.x, x1: it.x + it.w, text: it.str }; continue; }
      const gap = it.x - cur.x1;
      if (gap > cellGap) { segs.push(cur); cur = { x0: it.x, x1: it.x + it.w, text: it.str }; continue; }
      const glue = gap > 0.12 * h && !/\s$/.test(cur.text) && !/^\s/.test(it.str) ? ' ' : '';
      cur.text += glue + it.str;
      cur.x1 = Math.max(cur.x1, it.x + it.w);
    }
    if (cur) segs.push(cur);
    for (const s of segs) s.text = s.text.replace(/\s+/g, ' ').trim();
    // a bullet glyph that sits apart from its text is glued to it ("bullet TAB text" would look like a table row)
    const merged = [];
    for (let i = 0; i < segs.length; i += 1) {
      const s = segs[i];
      if (/^[\u2022\u25aa\u25cf\u25e6\u2023\u00b7*o-]$/.test(s.text) && i + 1 < segs.length) { segs[i + 1] = { x0: s.x0, x1: segs[i + 1].x1, text: `${s.text} ${segs[i + 1].text}` }; continue; }
      merged.push(s);
    }
    ln.segs = merged.filter((s) => s.text);
  }
  const ys = lines.map((l) => l.y);
  const gaps = [];
  for (let i = 1; i < ys.length; i += 1) gaps.push(ys[i - 1] - ys[i]);
  const sortedGaps = gaps.slice().sort((a, b) => a - b);
  const pitch = (sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length * 0.25)] : 0) || medianH * 1.2;
  return { lines: lines.filter((l) => l.segs.length), medianH, pitch };
}

function rowsText(lines, pitch) {
  const out = [];
  let prevY = null;
  for (const ln of lines) {
    if (prevY !== null && prevY - ln.y > 1.7 * pitch) out.push('');
    out.push(ln.segs.map((s) => s.text).join('\t'));
    prevY = ln.y;
  }
  return out.join('\n');
}

// Gutter detection: two dominant segment start positions far apart, with an empty band between the columns.
function findGutter(lines, pageWidth) {
  const starts = [];
  for (const ln of lines) for (const s of ln.segs) starts.push(s.x0);
  if (starts.length < 12) return null;
  const width = pageWidth || Math.max(...lines.flatMap((l) => l.segs.map((s) => s.x1)));
  const bin = 6;
  const hist = new Map();
  for (const x of starts) { const b = Math.round(x / bin); hist.set(b, (hist.get(b) || 0) + 1); }
  const peaks = [...hist.entries()].map(([b, n]) => ({ x: b * bin, n })).sort((a, b) => b.n - a.n);
  const nLines = lines.length;
  const first = peaks[0];
  if (!first || first.n < 0.2 * nLines) return null;
  // the second peak must be well to one side of the first
  const second = peaks.find((p) => Math.abs(p.x - first.x) > 0.22 * width && p.n >= 0.12 * nLines);
  if (!second) return null;
  const leftX = Math.min(first.x, second.x);
  const rightX = Math.max(first.x, second.x);
  const gutter = rightX - 3;
  // full-width lines cross the gutter; too many of them means this is not a two-column page
  let crossing = 0;
  let leftLines = 0;
  let rightLines = 0;
  for (const ln of lines) {
    const crosses = ln.segs.some((s) => s.x0 < gutter - 6 && s.x1 > gutter + 6);
    if (crosses) crossing += 1;
    if (ln.segs.some((s) => s.x0 < gutter)) leftLines += 1;
    if (ln.segs.some((s) => s.x0 >= gutter)) rightLines += 1;
  }
  if (crossing > 0.35 * nLines) return null;
  if (leftLines < 0.2 * nLines || rightLines < 0.2 * nLines) return null;
  void leftX;
  return gutter;
}

function columnsText(lines, gutter, pitch) {
  // bands: consecutive lines are grouped; a line whose segments cross the gutter closes the band and is emitted alone
  const out = [];
  let band = [];
  const flush = () => {
    if (!band.length) return;
    const left = [];
    const right = [];
    for (const ln of band) {
      const l = ln.segs.filter((s) => s.x0 < gutter);
      const r = ln.segs.filter((s) => s.x0 >= gutter);
      if (l.length) left.push({ y: ln.y, text: l.map((s) => s.text).join('\t') });
      if (r.length) right.push({ y: ln.y, text: r.map((s) => s.text).join('\t') });
    }
    const emit = (col) => {
      let prev = null;
      for (const c of col) {
        if (prev !== null && prev - c.y > 1.7 * pitch) out.push('');
        out.push(c.text);
        prev = c.y;
      }
    };
    emit(left);
    if (left.length && right.length) out.push('');
    emit(right);
    band = [];
  };
  for (const ln of lines) {
    const crosses = ln.segs.some((s) => s.x0 < gutter - 6 && s.x1 > gutter + 6);
    if (crosses) { flush(); out.push(ln.segs.map((s) => s.text).join('\t')); out.push(''); }
    else band.push(ln);
  }
  flush();
  return out.join('\n');
}

function layoutPage(items, opts = {}) {
  const { lines, pitch } = buildLines(items);
  if (lines.length === 0) return { rows: '', columns: null, gutter: null };
  const rows = rowsText(lines, pitch);
  const gutter = findGutter(lines, opts.pageWidth);
  const columns = gutter === null ? null : columnsText(lines, gutter, pitch);
  return { rows, columns, gutter };
}

module.exports = { layoutPage, buildLines, findGutter };
