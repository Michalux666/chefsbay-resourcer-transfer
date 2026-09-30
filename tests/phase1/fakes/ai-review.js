'use strict';
// Fake screening CLI following the DESIGN 5.3 contract (batch and single modes).
const fs = require('fs');
const { scenario, readState, writeState, logCall, sleepMs, parseFlags } = require('./common');

function readInput(file) {
  if (file === '-') return fs.readFileSync(0, 'utf8');
  return fs.readFileSync(file, 'utf8');
}

function fileFacts(file) {
  if (!file || file === '-') return null;
  try { const st = fs.statSync(file); return { exists: true, mode: st.mode & 0o777, dir: require('path').basename(require('path').dirname(file)) }; } catch (e) { return { exists: false }; }
}

function step(list, n, fallback) {
  if (!Array.isArray(list) || list.length === 0) return fallback;
  return list[Math.min(n, list.length - 1)];
}

function apiDown(model) {
  process.stderr.write('WARN API attempt 3/3 failed: Gateway HTTP 503. Retrying in 30s...\n');
  process.stderr.write('API_UNAVAILABLE - gateway exhausted (3 retries). Last error: Gateway HTTP 503\n');
  process.stderr.write(`SCREENING_MODEL: ${model || 'none'}\n`);
  process.stdout.write('API_UNAVAILABLE:Gateway HTTP 503');
  process.exit(3);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const sc = scenario();
  const ai = sc.ai || {};
  const counters = readState('ai.json', { batch: 0, single: 0 });
  const mode = String(flags.mode || '').toLowerCase();

  if (mode === 'batch') {
    const n = counters.batch++;
    writeState('ai.json', counters);
    let input;
    const facts = fileFacts(flags['candidates-file']);
    try { input = JSON.parse(readInput(flags['candidates-file'])); if (flags['consume-input'] && flags['candidates-file'] !== '-' && !process.env.P1_NO_CONSUME) { try { fs.unlinkSync(flags['candidates-file']); } catch (e) { /* gone */ } } } catch (e) { process.stderr.write(`FATAL cannot read candidates: ${e.message}\n`); process.exit(1); }
    logCall('ai-review', {
      mode, job: flags.job, location: flags.location, distance: flags.distance,
      fileMode: flags['candidates-file'] === '-' ? 'stdin' : 'file',
      ids: input.map((c) => String(c.id)), hasToken: input.some((c) => c.candidateDataValue !== undefined),
      fields: Object.keys(input[0] || {}),
      fileFacts: facts, source: flags.source, runId: flags['run-id'], consume: flags['consume-input'] === true, withCodes: flags['with-codes'] === true,
    });
    const s = step(ai.batch, n, { outcome: 'ok' });
    process.stderr.write('  [ai-review] Batch screening - model: fake\n');
    if (s.outcome === 'api_down') apiDown(s.model);
    if (s.outcome === 'exit1') { process.stderr.write('FATAL something broke\n'); process.exit(1); }
    if (s.outcome === 'garbage') { process.stdout.write(s.text || 'this is not json'); process.exit(0); }
    if (s.outcome === 'empty_array') { process.stderr.write('SCREENING_MODEL: fake/screen-model\n'); process.stdout.write('[]'); process.exit(0); }
    if (s.outcome === 'exit1_with_json') { process.stdout.write(JSON.stringify(input.map((c) => ({ id: String(c.id), approved: true, reason: 'ok' })))); process.exit(1); }
    if (s.outcome === 'hang') { await sleepMs(Number(process.env.P1_HANG_MS || 15000)); }
    if (s.outcome === 'slow') { await sleepMs(s.ms || 500); }
    const model = s.model || 'fake/screen-model';
    const results = input.map((c) => {
      const o = (s.overrides || {})[String(c.id)];
      const approved = o ? o.approved : (s.approveAll !== false);
      const base = { id: String(c.id), approved, reason: (o && o.reason) || (approved ? 'Relevant hospitality background' : 'Not relevant') };
      if (flags['with-codes'] === true) base.reasonCode = (o && o.code) || (approved ? 'approve_other' : 'reject_other');
      return base;
    });
    const out = s.outcome === 'missing_id' ? results.slice(0, -1) : results;
    process.stderr.write(`SCREENING_MODEL: ${model}\n`);
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }

  if (mode === 'single') {
    const n = counters.single++;
    writeState('ai.json', counters);
    let viaStdin = false;
    if (flags['single-file'] === '-') {
      try { const j = JSON.parse(readInput('-')); flags.title = j.title; flags.snippet = j.snippet; flags.name = j.name; viaStdin = true; } catch (e) { process.stderr.write(`FATAL cannot read single input: ${e.message}\n`); process.exit(1); }
    }
    logCall('ai-review', { mode, job: flags.job, title: flags.title, snippet: flags.snippet, name: flags.name, source: flags.source, runId: flags['run-id'], viaStdin, argvHasSnippet: process.argv.some((a) => typeof flags.snippet === 'string' && flags.snippet && a === flags.snippet) });
    const s = step(ai.single, n, { outcome: 'ok', approved: true });
    if (s.outcome === 'api_down') apiDown(s.model);
    if (s.outcome === 'exit1') { process.stderr.write('FATAL something broke\n'); process.exit(1); }
    if (s.outcome === 'garbage') { process.stdout.write('no json here'); process.exit(0); }
    process.stderr.write(`SCREENING_MODEL: ${s.model || 'fake/single-model'}\n`);
    process.stdout.write(JSON.stringify({ approved: s.approved !== false, reason: s.reason || (s.approved === false ? 'Too junior' : 'Approved') }));
    process.exit(0);
  }

  process.stderr.write('usage: ai-review --mode batch|single\n');
  process.exit(1);
}

main().catch((e) => { process.stderr.write(`FATAL ${e.message}\n`); process.exit(1); });
