#!/usr/bin/env node
'use strict';
/**
 * alerts-deliver.js - turns outbox/alerts.jsonl into stdout lines that Hermes delivers to the
 * configured channel (local, email, Telegram). Reads new lines from a saved byte offset, dedupes
 * by key with per-severity windows, holds non-critical alerts during quiet hours (22:00-06:00
 * Europe/London) until morning, prints a daily digest at 18:00 and a daily "alive" line, and pings
 * an optional external dead-man endpoint. Prints nothing when there is nothing to say.
 *
 * This job is also the only watcher that does not live inside the supervision tick: when the tick heartbeat
 * (runtime/tick.heartbeat) is older than 10 minutes inside the operating window (06:00-22:00 London) it raises a
 * critical "tick-silent" alert, and it pings the dead-man endpoint (every 55 minutes, so at least hourly) only while that heartbeat is fresh.
 *
 * Usage: node scripts/alerts-deliver.js [--dry-run] [--digest] [--test] [--help]
 *   --test  queue one critical test alert in the outbox (the next run of this job delivers it to the configured
 *           channel) and print the line it will produce; with --dry-run only print it.
 * Exit:  0 ok (also when nothing was printed), 1 unexpected error, 2 usage
 */
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const paths = require('./lib/paths');
const env = require('./lib/env');
const fsx = require('./lib/fsx');
const timeLib = require('./lib/time');
const tick = require('./lib/tick');

const MIN_MS = 60 * 1000;
const WINDOWS_MS = { critical: 60 * MIN_MS, warn: 6 * 60 * MIN_MS, info: 24 * 60 * MIN_MS };
const QUIET_START = 22;
const QUIET_END = 6;
const DIGEST_HOUR = 18;
const HEARTBEAT_HOUR = 7;
const WINDOW_OPEN_HOUR = 6;
const WINDOW_CLOSE_HOUR = 22;
const TICK_STALE_MS = 10 * MIN_MS;
const DEADMAN_EVERY_MS = 55 * MIN_MS;
const FUTURE_SKEW_MS = 24 * 60 * MIN_MS;
const MAX_LINES = 25;
const MAX_HELD = 200;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const ROTATE_BYTES = 2 * 1024 * 1024;
const DAILY_TARGET = 181;
const WEEKLY_TARGET = 1269;
const SEVERITIES = ['info', 'warn', 'critical'];

function makeCtx(over) {
  const o = over || {};
  const home = o.home ? path.resolve(o.home) : paths.HOME;
  const files = tick.runtimeFiles(home);
  const outbox = path.join(home, 'outbox');
  return Object.assign({
    home,
    files,
    outboxFile: path.join(outbox, 'alerts.jsonl'),
    deliveredFile: path.join(outbox, 'alerts-delivered.jsonl'),
    stateFile: path.join(files.dir, 'alerts-state.json'),
    heartbeatFile: path.join(files.dir, 'alerts-last-run.json'),
    lockFile: path.join(files.dir, 'alerts.lock'),
    dbFile: path.join(home, 'candidates.db'),
    maxReadBytes: MAX_READ_BYTES,
    now: () => Date.now(),
    out: (line) => console.log(line),
    dryRun: false,
    forceDigest: false,
    deadmanUrl: () => env.get('RESOURCER_DEADMAN_URL'),
    ping: pingUrl,
  }, o);
}

function defaultState() {
  return { version: 1, offset: 0, head: '', headLen: 0, sent: {}, held: [], digestDate: '', heartbeatDate: '', deadmanAt: 0, firstRunAt: 0, lastRunAt: 0 };
}

function loadState(ctx) {
  const s = fsx.readJson(ctx.stateFile, null);
  const st = Object.assign(defaultState(), s && typeof s === 'object' ? s : {});
  if (!st.sent || typeof st.sent !== 'object') st.sent = {};
  if (!Array.isArray(st.held)) st.held = [];
  // Timestamps written while the clock ran ahead would otherwise suppress alerts and pings until real time caught up.
  const limit = ctx.now() + FUTURE_SKEW_MS;
  for (const k of ['deadmanAt', 'firstRunAt', 'lastRunAt']) if (Number(st[k]) > limit) st[k] = 0;
  for (const [k, v] of Object.entries(st.sent)) if (!v || !(Number(v.at) <= limit)) delete st.sent[k];
  return st;
}

function inQuietHours(date) {
  const h = timeLib.londonHour(timeLib.hourClock(date));
  return h >= QUIET_START || h < QUIET_END;
}

function hhmm(date) {
  const p = timeLib.londonParts(date);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

const HEAD_BYTES = 128;

// Hash of the first `len` bytes; the same length is used on every later read so an append-only
// file that grows keeps the same head.
function headOf(file, len) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      return sha1(buf.toString('latin1'));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function readRange(file, from, to) {
  const len = Math.max(0, to - from);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try {
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

function tryParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// A torn write (crash, full disk) leaves a partial record with no newline, so the next whole record is appended to the same
// line. Every record notify() writes starts with {"ts", so the whole ones are recovered from behind the torn part.
function salvage(line) {
  const starts = [];
  for (let i = line.indexOf('{"ts"'); i >= 0; i = line.indexOf('{"ts"', i + 1)) starts.push(i);
  const out = [];
  for (let k = 0; k < starts.length; k++) {
    const rec = tryParse(line.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : line.length));
    if (rec) out.push(rec);
  }
  return out;
}

// Consume whole lines only, so a writer caught mid-append is picked up whole on the next run.
// A window that holds no newline at all is one giant line: it is skipped, or delivery would stall on it forever.
function parseLines(buf, maxBytes) {
  const cut = buf.lastIndexOf(10);
  if (cut < 0) {
    if (maxBytes && buf.length >= maxBytes) return { alerts: [], consumed: buf.length, oversize: true };
    return { alerts: [], consumed: 0 };
  }
  const consumedBytes = cut + 1;
  const alerts = [];
  for (const line of buf.subarray(0, cut).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let recs = [];
    const whole = tryParse(line);
    if (whole && typeof whole === 'object') recs = [whole];
    else if (!whole) recs = salvage(line);
    for (const rec of recs) {
      if (!rec || typeof rec !== 'object' || !rec.text) continue;
      alerts.push({
        ts: rec.ts || null,
        severity: SEVERITIES.includes(rec.severity) ? rec.severity : 'info',
        key: rec.key || null,
        text: String(rec.text),
        meta: rec.meta && typeof rec.meta === 'object' ? rec.meta : null,
      });
    }
  }
  return { alerts, consumed: consumedBytes };
}

function readNew(ctx, state) {
  let st;
  try { st = fs.statSync(ctx.outboxFile); } catch { return { alerts: [], size: 0 }; }
  const sameHead = !state.headLen || headOf(ctx.outboxFile, Math.min(st.size, state.headLen)) === state.head;
  if (st.size < state.offset || (state.offset > 0 && !sameHead)) {
    state.offset = 0;
  }
  const maxBytes = ctx.maxReadBytes || MAX_READ_BYTES;
  const end = Math.min(st.size, state.offset + maxBytes);
  const { alerts, consumed, oversize } = parseLines(readRange(ctx.outboxFile, state.offset, end), maxBytes);
  state.offset += consumed;
  state.headLen = Math.min(st.size, HEAD_BYTES);
  state.head = headOf(ctx.outboxFile, state.headLen);
  return { alerts, size: st.size, oversize: !!oversize };
}

function dedupeKey(a) {
  const base = a.key ? a.key : `text:${sha1(a.text).slice(0, 12)}`;
  const sub = a.meta ? [a.meta.event, a.meta.reason].filter(Boolean).join(':') : '';
  return `${base}|${a.severity}${sub ? `|${sub}` : ''}`;
}

function validDate(ts, fallback) {
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(t) ? new Date(t) : fallback;
}

function formatAlert(a, extra) {
  const when = validDate(a.ts, new Date());
  const tag = `${a.severity.toUpperCase()} ${hhmm(when)}${extra && extra.held ? ' held' : ''}`;
  const suffix = extra && extra.suppressed ? ` (+${extra.suppressed} repeats suppressed)` : '';
  const count = extra && extra.count > 1 ? ` (x${extra.count})` : '';
  return `[${tag}] ${a.text.replace(/\s+/g, ' ').trim()}${count}${suffix}`;
}

function audit(ctx, a, held) {
  if (ctx.dryRun) return;
  try {
    fsx.appendLine(ctx.deliveredFile, JSON.stringify({ ts: new Date(ctx.now()).toISOString(), severity: a.severity, key: a.key, text: a.text.slice(0, 500), held: !!held }));
  } catch { /* the audit log is best effort */ }
}

/** Decide what to print now: returns lines; mutates state (sent, held). */
function processAlerts(ctx, state, alerts) {
  const now = ctx.now();
  const quiet = inQuietHours(new Date(now));
  const lines = [];
  const emit = (a, extra) => {
    lines.push(formatAlert(a, extra));
    audit(ctx, a, extra && extra.held);
  };

  if (!quiet && state.held.length) {
    for (const h of state.held) {
      const dk = dedupeKey(h);
      const prev = state.sent[dk];
      emit(h, { held: true, count: h.count, suppressed: prev ? prev.suppressed : 0 });
      state.sent[dk] = { at: now, suppressed: 0 };
    }
    state.held = [];
  }

  for (const a of alerts) {
    const dk = dedupeKey(a);
    const window = WINDOWS_MS[a.severity];
    const prev = state.sent[dk];
    const heldIdx = state.held.findIndex((h) => dedupeKey(h) === dk);
    if (heldIdx >= 0) {
      state.held[heldIdx].count = (state.held[heldIdx].count || 1) + 1;
      state.held[heldIdx].text = a.text;
      continue;
    }
    if (prev && now - prev.at < window) {
      prev.suppressed = (prev.suppressed || 0) + 1;
      continue;
    }
    if (quiet && a.severity !== 'critical') {
      state.held.push(Object.assign({ count: 1 }, a));
      continue;
    }
    emit(a, { suppressed: prev ? prev.suppressed : 0 });
    state.sent[dk] = { at: now, suppressed: 0 };
  }

  if (state.held.length > MAX_HELD) {
    const drop = state.held.length - MAX_HELD;
    state.held.sort((x, y) => SEVERITIES.indexOf(y.severity) - SEVERITIES.indexOf(x.severity));
    state.held.length = MAX_HELD;
    lines.push(`[WARN ${hhmm(new Date(now))}] ${drop} held overnight alerts were dropped (more than ${MAX_HELD}).`);
  }
  for (const [k, v] of Object.entries(state.sent)) {
    if (now - v.at > 3 * 24 * 60 * MIN_MS) delete state.sent[k];
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// digest and daily heartbeat

const nf = (n) => Number(n || 0).toLocaleString('en-GB');

function openDb(ctx) {
  let Database;
  try { Database = require('better-sqlite3'); } catch { return null; }
  if (!fs.existsSync(ctx.dbFile)) return null;
  try { return new Database(ctx.dbFile, { readonly: true, fileMustExist: true }); } catch { return null; }
}

function pickNum(obj, names) {
  if (!obj || typeof obj !== 'object') return null;
  for (const n of names) if (Number.isFinite(Number(obj[n])) && obj[n] !== null && obj[n] !== '') return Number(obj[n]);
  return null;
}

function haltSummary(ctx, ymd) {
  const file = path.join(ctx.home, 'logs', 'errors.jsonl');
  let text = '';
  try {
    const st = fs.statSync(file);
    const from = Math.max(0, st.size - 512 * 1024);
    text = readRange(file, from, st.size).toString('utf8');
  } catch { /* no error log yet: an active halt is still reported below */ }
  let episodes = 0;
  let minutes = 0;
  for (const line of text.split('\n')) {
    if (!line.includes('pipeline_')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!validDate(e.ts, null) || timeLib.londonParts(validDate(e.ts, null)).ymd !== ymd) continue;
    if (e.context === 'pipeline_halted') episodes++;
    if (e.context === 'pipeline_resumed') {
      const m = /was halted for (\d+) min/.exec(e.detail || '');
      if (m) minutes += Number(m[1]);
    }
  }
  let ongoing = null;
  const h = fsx.readJson(path.join(ctx.files.dir, 'pipeline-halt.json'), null);
  if (h && h.halted && h.since) {
    ongoing = Math.max(0, Math.round((ctx.now() - Date.parse(h.since)) / 60000));
    minutes += ongoing;
  }
  return { episodes, minutes, ongoing };
}

function backupSummary(ctx) {
  const b = fsx.readJson(path.join(ctx.files.dir, 'backup-state.json'), null);
  if (!b || !b.lastOkAt) return 'none recorded yet';
  const h = Math.round((ctx.now() - Date.parse(b.lastOkAt)) / 3600000);
  let s = `last OK ${h} h ago`;
  if (b.lastRestoreTestAt) s += `, restore test ${b.lastRestoreOk === false ? 'FAILED' : 'ok'} ${Math.round((ctx.now() - Date.parse(b.lastRestoreTestAt)) / 86400000)} d ago`;
  if (b.lastFailureAt && Date.parse(b.lastFailureAt) > Date.parse(b.lastOkAt)) s += ', LAST ATTEMPT FAILED';
  return s;
}

// One line about the role-scoped second look (docs/RESURFACE.md), only on a day it did something: people unlocked earlier and rejected for another role,
// screened again for this one. The numbers are the counters of runtime/cv-resurface.json (a failed read says nothing).
function resurfaceLine(ctx, ymd) {
  const st = fsx.readJson(path.join(ctx.files.dir, 'cv-resurface.json'), null);
  const t = st && st.today && st.today.day === ymd ? st.today : null;
  if (!t) return null;
  const n = (k) => Number(t[k]) || 0;
  const looks = n('legacyCaterer') + n('legacyReed');
  if (!n('started') && !n('capped') && !n('reserve') && !n('unreadable') && !looks && !n('legacyRejected')) return null;
  const held = n('capped') + n('reserve') + n('unreadable');
  // the people whose role was never recorded (docs/ROLESCOPE.md): looks given, rejected again, pushed, what they cost; part of the numbers before it except the snippet rejections
  const scope = looks || n('legacyRejected') ? ` Role scope (role never recorded, one more look): ${nf(looks)} given (Caterer ${nf(n('legacyCaterer'))}, Reed ${nf(n('legacyReed'))}), rejected again ${nf(n('legacyRejected'))}, pushed ${nf(n('legacyPushed'))}, charged ${nf(n('legacyCharged'))}, credits ${nf(n('legacyCredits'))}, Reed views ${nf(n('legacyViews'))}.` : '';
  return `Resurfaced today (unlocked earlier, rejected for another role, screened again): ${nf(n('started'))} started, charged ${nf(n('charged'))}, not charged ${nf(n('notCharged'))}, charge unknown ${nf(n('unknown'))}; credits spent ${nf(n('credits'))}, Reed views ${nf(n('reedViews'))}; pushed ${nf(n('pushed'))}, rejected again ${nf(n('rejected'))}${held ? `; held back ${nf(held)} (cap, reserve or unreadable balance)` : ''}.${scope}`;
}

function buildDigest(ctx) {
  const now = new Date(ctx.now());
  const ymd = timeLib.londonParts(now).ymd;
  const utcDay = now.toISOString().slice(0, 10);
  const lines = [`Resourcer daily digest ${ymd}`];
  const db = openDb(ctx);
  let weekDownloaded = null;
  if (!db) {
    lines.push('Database not readable from the digest job (run_results section skipped).');
  } else {
    try {
      const today = db.prepare('SELECT COUNT(*) AS runs, COALESCE(SUM(new_to_zoho),0) AS n, COALESCE(SUM(downloaded),0) AS d, COALESCE(SUM(duplicates),0) AS dup, COALESCE(SUM(skipped),0) AS sk, COALESCE(SUM(errors),0) AS err FROM run_results WHERE date = ?').get(utcDay);
      const week = db.prepare("SELECT COALESCE(SUM(new_to_zoho),0) AS n, COALESCE(SUM(downloaded),0) AS d FROM run_results WHERE date >= date(?, '-6 day') AND date <= ?").get(utcDay, utcDay);
      weekDownloaded = week.d;
      lines.push(`CVs pulled today: ${nf(today.n)} of ${DAILY_TARGET} target (${Math.round((today.n / DAILY_TARGET) * 100)}%); last 7 days ${nf(week.n)} of ${nf(WEEKLY_TARGET)}.`);
      lines.push(`Runs today ${nf(today.runs)}: unlocked ${nf(today.d)}, duplicates ${nf(today.dup)}, skipped ${nf(today.sk)}, errors ${nf(today.err)}.`);
      const src = { caterer: 0, reed: 0, unsplit: 0 };
      let reedFailed = 0;
      for (const r of db.prepare('SELECT sources, new_to_zoho, caterer_json, reed_json FROM run_results WHERE date = ?').all(utcDay)) {
        let c = null;
        let d = null;
        try { c = r.caterer_json ? JSON.parse(r.caterer_json) : null; } catch { c = null; }
        try { d = r.reed_json ? JSON.parse(r.reed_json) : null; } catch { d = null; }
        if (d && (d.status === 'failed' || d.failed === true)) reedFailed += 1;
        const cn = pickNum(c, ['newToZoho', 'new_to_zoho', 'new', 'pushed']);
        const dn = pickNum(d, ['newToZoho', 'new_to_zoho', 'new', 'pushed']);
        if (cn !== null || dn !== null) { src.caterer += cn || 0; src.reed += dn || 0; }
        else if (r.sources === 'caterer') src.caterer += r.new_to_zoho || 0;
        else if (r.sources === 'reed') src.reed += r.new_to_zoho || 0;
        else src.unsplit += r.new_to_zoho || 0;
      }
      lines.push(`New in Zoho by source: Caterer ${nf(src.caterer)}, Reed ${nf(src.reed)}${src.unsplit ? `, not split ${nf(src.unsplit)}` : ''}.`);
      if (reedFailed) lines.push(`Reed attempts that failed today: ${reedFailed} (their Reed half is not done; docs/OPERATIONS.md 8.1, tools/reed-catchup.js).`);
      const roles = db.prepare('SELECT job_title AS t, SUM(approved_p1) AS a, SUM(skipped_review) AS r FROM run_results WHERE date = ? GROUP BY job_title HAVING (COALESCE(SUM(approved_p1),0) + COALESCE(SUM(skipped_review),0)) > 0 ORDER BY (COALESCE(SUM(approved_p1),0) + COALESCE(SUM(skipped_review),0)) DESC LIMIT 6').all(utcDay);
      if (roles.length) {
        lines.push(`Approval rate by role (pre-unlock): ${roles.map((x) => `${x.t} ${Math.round((x.a / (x.a + x.r)) * 100)}% (n=${x.a + x.r})`).join(', ')}.`);
      }
    } catch (e) {
      lines.push(`Run statistics unavailable (${String(e.message).slice(0, 80)}).`);
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  }
  const hs = haltSummary(ctx, ymd);
  lines.push(hs.episodes || hs.minutes ? `Halts today: ${hs.episodes} episode(s), ${hs.minutes} min lost${hs.ongoing !== null ? ` (still halted, ${hs.ongoing} min so far)` : ''}.` : 'Halts today: none.');
  const credits = fsx.readJson(path.join(ctx.home, 'credits-sync.json'), null);
  if (credits && Number(credits.credits) > 0) {
    const burn = weekDownloaded !== null ? Math.round(weekDownloaded / 7) : null;
    lines.push(`Caterer credits: ${nf(credits.credits)} remaining${burn ? ` (about ${nf(burn)} unlocks/day this week)` : ''}.`);
  } else {
    lines.push('Caterer credits: no sync recorded.');
  }
  const rsv = resurfaceLine(ctx, ymd);
  if (rsv) lines.push(rsv);
  lines.push(`Backup: ${backupSummary(ctx)}.`);
  return lines.join('\n');
}

function aliveLine(ctx) {
  const state = fsx.readJson(ctx.files.state, {});
  const now = ctx.now();
  const parts = [`Resourcer alive ${timeLib.londonParts(new Date(now)).ymd}`];
  parts.push(state.lastTickAt ? `last tick ${Math.round((now - state.lastTickAt) / 60000)} min ago` : 'no tick recorded yet');
  let queue = 0;
  try { queue = fs.readdirSync(path.join(ctx.home, 'pending-searches')).filter((f) => f.endsWith('.json')).length; } catch { /* none */ }
  parts.push(`queue ${queue}`);
  const h = fsx.readJson(path.join(ctx.files.dir, 'pipeline-halt.json'), null);
  parts.push(h && h.halted ? `HALTED (${h.reason})` : 'not halted');
  parts.push(`backup ${backupSummary(ctx)}`);
  return `[INFO ${hhmm(new Date(now))}] ${parts.join(', ')}.`;
}

function pingUrl(url, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve({ ok: false, error: 'invalid url' }); return; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') { resolve({ ok: false, error: 'unsupported scheme' }); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'GET', timeout: timeoutMs || 10000 }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.code || 'error' }));
    req.end();
  });
}

// The tick touches runtime/tick.heartbeat on every start and every iteration, so its age is the one signal that does not depend
// on the tick's own health. Returns null when the file has never been written.
function tickHeartbeatAgeMs(ctx) {
  try { return ctx.now() - fs.statSync(ctx.files.tickHeartbeat).mtimeMs; } catch { return null; }
}

function tickWatch(ctx, state, p) {
  const now = ctx.now();
  const age = tickHeartbeatAgeMs(ctx);
  const fresh = age !== null && age <= TICK_STALE_MS;
  // A heartbeat that was never seen counts silence from the moment this job first looked, so the install order
  // (alerts first, tick a few minutes later) does not raise a false alarm.
  const observedMs = state.firstRunAt ? now - state.firstRunAt : 0;
  const silentMs = age !== null ? age : observedMs;
  // If this job itself did not run for a while (the instance was suspended), a stale heartbeat proves nothing yet.
  const gap = state.lastRunAt ? now - state.lastRunAt : 0;
  const inWindow = p.hour >= WINDOW_OPEN_HOUR && p.hour < WINDOW_CLOSE_HOUR;
  const silent = inWindow && silentMs > TICK_STALE_MS && gap <= TICK_STALE_MS;
  return { age, fresh, silent, silentMs };
}

function tickSilentAlert(ctx, watch) {
  const last = watch.age === null ? 'never seen' : `last heartbeat ${hhmm(new Date(ctx.now() - watch.age))} London`;
  return {
    ts: new Date(ctx.now()).toISOString(), severity: 'critical', key: 'tick-silent', meta: null,
    text: `The supervision tick has been silent for ${Math.round(watch.silentMs / MIN_MS)} min (${last}) inside the operating window, so nothing is being started, watched or alerted on. Check that "hermes -p resourcer cron list" shows resourcer-tick enabled and that "node scripts/pipeline-watchdog.js --status" shows lastTickAt within 2 minutes (docs/OPERATIONS.md).`,
  };
}

function rotateIfLarge(ctx, state) {
  let st;
  try { st = fs.statSync(ctx.outboxFile); } catch { return false; }
  if (st.size < ROTATE_BYTES || state.offset < st.size || ctx.now() - st.mtimeMs < 60 * 1000) return false;
  const rotated = path.join(path.dirname(ctx.outboxFile), `alerts-${new Date(ctx.now()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}.jsonl`);
  try { fs.renameSync(ctx.outboxFile, rotated); } catch { return false; }
  // A writer that opened the old file just before the rename appended into the rotated copy.
  try {
    const after = fs.statSync(rotated).size;
    if (after > state.offset) return { rotated, tail: readRange(rotated, state.offset, after) };
  } catch { /* nothing more */ }
  return { rotated, tail: null };
}

// A full or read-only volume cannot hold the delivery offset: printing would repeat every alert on every run, so nothing is consumed.
function stateWritable(ctx, nowDate) {
  try {
    fsx.writeJsonAtomic(ctx.heartbeatFile, { ts: nowDate.toISOString(), phase: 'start' });
    return true;
  } catch {
    return false;
  }
}

// Orders the output so a critical is never the line cut off: critical first, then warn, then everything else, each in arrival order.
function bySeverity(lines) {
  const rank = (l) => (l.startsWith('[CRITICAL') ? 0 : (l.startsWith('[WARN') ? 1 : 2));
  return lines.map((l, i) => ({ l, i, r: rank(l) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.l);
}

async function run(ctx) {
  const result = { lines: [], delivered: 0, digest: false, alive: false, pinged: false, skipped: null };
  let lock = null;
  if (!ctx.dryRun && ctx.useLock !== false) {
    lock = tick.acquireLock(ctx.lockFile, { staleMs: 5 * MIN_MS, info: { role: 'alerts' } });
    if (!lock.ok) { result.skipped = 'locked'; return result; }
  }
  try {
    return await runLocked(ctx, result);
  } finally {
    if (lock) lock.release();
  }
}

async function runLocked(ctx, result) {
  const nowDate = new Date(ctx.now());
  if (!ctx.dryRun && !stateWritable(ctx, nowDate)) {
    const line = `[CRITICAL ${hhmm(nowDate)}] Alert delivery state is not writable (${path.dirname(ctx.stateFile)}): alerts are held in the outbox instead of being repeated on every run. Free disk space or fix the permissions (docs/OPERATIONS.md).`;
    ctx.out(line);
    result.lines = [line];
    result.delivered = 1;
    result.skipped = 'state-unwritable';
    return result;
  }
  const state = loadState(ctx);
  const p = timeLib.londonParts(timeLib.hourClock(nowDate));
  const quiet = inQuietHours(nowDate);
  const fresh = readNew(ctx, state);
  const injected = [];
  const iso = nowDate.toISOString();
  if (fresh.oversize) {
    injected.push({ ts: iso, severity: 'warn', key: 'outbox-oversize', meta: null, text: `An outbox line longer than ${ctx.maxReadBytes || MAX_READ_BYTES} bytes was skipped; the alerts after it are delivered normally. Something wrote a runaway alert (docs/OPERATIONS.md).` });
  }
  const watch = tickWatch(ctx, state, p);
  if (watch.silent) injected.push(tickSilentAlert(ctx, watch));

  // The dead-man endpoint only hears from a healthy supervisor, so a dead tick (or a dead instance) makes it raise its own alarm.
  const url = watch.fresh && ctx.dryRun !== true && ctx.now() - (state.deadmanAt || 0) >= DEADMAN_EVERY_MS ? ctx.deadmanUrl() : null;
  if (url) {
    const r = await ctx.ping(url, 10000);
    if (r.ok) { state.deadmanAt = ctx.now(); result.pinged = true; }
    else injected.push({ ts: iso, severity: 'warn', key: 'deadman-ping-failed', meta: null, text: `The dead-man ping failed (${r.error || `HTTP ${r.status}`}); it retries on the next run.` });
  }

  const lines = processAlerts(ctx, state, fresh.alerts.concat(injected));
  result.lines = lines;

  // A failing digest must never block the alerts behind it (the offset is saved at the end of the run).
  if (ctx.forceDigest || (!quiet && p.hour >= DIGEST_HOUR && state.digestDate !== p.ymd)) {
    try { lines.push(buildDigest(ctx)); } catch (e) { lines.push(`[WARN ${hhmm(nowDate)}] The daily digest could not be built: ${String(e.message).slice(0, 120)}`); }
    state.digestDate = p.ymd;
    result.digest = true;
  }
  if (!quiet && p.hour >= HEARTBEAT_HOUR && state.heartbeatDate !== p.ymd) {
    try { lines.push(aliveLine(ctx)); } catch (e) { lines.push(`[WARN ${hhmm(nowDate)}] The daily alive line could not be built: ${String(e.message).slice(0, 120)}`); }
    state.heartbeatDate = p.ymd;
    result.alive = true;
  }
  if (!ctx.dryRun) {
    const rot = rotateIfLarge(ctx, state);
    if (rot) {
      state.offset = 0;
      state.head = '';
      state.headLen = 0;
      if (rot.tail && rot.tail.length) {
        const extra = parseLines(rot.tail);
        lines.push(...processAlerts(ctx, state, extra.alerts));
      }
    }
  }

  let printed = lines;
  if (lines.length > MAX_LINES) {
    printed = bySeverity(lines).slice(0, MAX_LINES);
    printed.push(`... and ${lines.length - MAX_LINES} more lines (see outbox/alerts-delivered.jsonl).`);
  }
  // Print before saving the offset: a crash in between re-delivers (deduped) instead of losing alerts.
  for (const l of printed) ctx.out(l);
  if (!ctx.dryRun) {
    try {
      if (!state.firstRunAt) state.firstRunAt = ctx.now();
      state.lastRunAt = ctx.now();
      fsx.writeJsonAtomic(ctx.stateFile, state);
      fsx.writeJsonAtomic(ctx.heartbeatFile, { ts: nowDate.toISOString(), offset: state.offset, held: state.held.length, deliveredThisRun: lines.length });
    } catch (e) {
      console.error(`alerts state save failed: ${e.message}`);
    }
  }
  result.delivered = lines.length;
  return result;
}

const USAGE = 'Usage: node scripts/alerts-deliver.js [--dry-run] [--digest] [--test] [--help]';

// Queues one critical alert (a unique event id defeats the hourly dedupe) and prints the line the next delivery will produce.
function emitTest(ctx) {
  const stamp = new Date(ctx.now());
  const rec = {
    ts: stamp.toISOString(), severity: 'critical', key: 'alerts-test',
    text: 'TEST ALERT from alerts-deliver.js --test: if you can read this message, critical alerts reach you.',
    meta: { event: `test-${stamp.getTime().toString(36)}` },
  };
  if (!ctx.dryRun) fsx.appendLine(ctx.outboxFile, JSON.stringify(rec));
  ctx.out(formatAlert(Object.assign({}, rec, { severity: 'critical' }), null));
  return rec;
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return 0; }
  for (const a of argv) {
    if (a !== '--dry-run' && a !== '--digest' && a !== '--test') { console.error(`unknown argument '${a}'\n${USAGE}`); return 2; }
  }
  const ctx = makeCtx({ dryRun: argv.includes('--dry-run'), forceDigest: argv.includes('--digest') });
  if (argv.includes('--test')) { emitTest(ctx); return 0; }
  await run(ctx);
  return 0;
}

module.exports = {
  WINDOWS_MS, QUIET_START, QUIET_END, DIGEST_HOUR, DAILY_TARGET, WEEKLY_TARGET,
  TICK_STALE_MS, DEADMAN_EVERY_MS,
  makeCtx, loadState, readNew, parseLines, dedupeKey, processAlerts, inQuietHours, buildDigest, aliveLine, pingUrl, run, emitTest, tickWatch,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`alerts-deliver failed: ${env.redact(e && e.stack ? e.stack : String(e))}`);
    process.exit(1);
  });
}
