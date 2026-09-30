'use strict';
// The operator documents must agree with the repository: cron commands, alert keys, settings, files, flags, step numbers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(REPO, rel));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

const ALL = walk('');
const CODE = ALL.filter((f) => /^(resourcer\/scripts|tools|plugin)\/.*\.(js|py|sh)$/.test(f) || f === 'resourcer/candidates-db.js' || /^hermes\/scripts\/.*\.sh$/.test(f));

// Operator-facing documents. The historical ones (parity, LEGACY-MAP, DECISIONS, DESIGN) name legacy files on purpose and are not path-checked.
const LIVE_DOCS = [
  'README.md', 'HANDOFF.md', 'OPERATOR-PROMPT.md', 'hermes/AGENTS.md', 'hermes/SOUL.md', 'hermes/skills/resourcer-ops/SKILL.md',
  'docs/INSTALL.md', 'docs/ACCEPTANCE.md', 'docs/OPERATIONS.md', 'docs/CUTOVER.md', 'docs/ROLLBACK.md', 'docs/TEARDOWN.md',
  'docs/SECURITY.md', 'docs/KNOWN-LIMITS.md', 'docs/SCREENING.md', 'docs/ENV.md',
];
const ALL_DOCS = ALL.filter((f) => /^(docs\/.*\.md|README\.md|HANDOFF\.md|OPERATOR-PROMPT\.md|hermes\/.*\.md|plugin\/.*\.md)$/.test(f));

function fences(text) {
  const out = [];
  const re = /```[a-z0-9]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1].replace(/\n$/, ''));
  return out;
}

test('every named document exists', () => {
  for (const f of LIVE_DOCS) assert.ok(exists(f), `${f} is missing`);
});

test('INSTALL 9.5 creates exactly the eight jobs of hermes/cron/jobs.json, character for character', () => {
  const jobs = JSON.parse(read('hermes/cron/jobs.json')).jobs;
  assert.equal(jobs.length, 8);
  const created = fences(read('docs/INSTALL.md')).filter((b) => b.startsWith('hermes -p resourcer cron create ') && b.includes(' --script ') && !/resourcer-envprobe/.test(b));
  assert.deepEqual(created.slice().sort(), jobs.map((j) => j.cliPaused).sort(), 'INSTALL and jobs.json differ (jobs.json wins)');
  for (const c of created) {
    assert.equal((c.match(/<DELIVER_TARGET>/g) || []).length, 2, `${c.slice(0, 80)}: --deliver and --failure-deliver both take the target`);
    assert.ok(!/--deliver local|--failure-deliver local/.test(c), 'a real job is never created with local delivery');
    assert.ok(c.endsWith(' --paused'), 'created paused');
  }
});

test('the throwaway probe job is the only INSTALL job that uses local delivery, and it is removed again', () => {
  const install = read('docs/INSTALL.md');
  const local = fences(install).filter((b) => /cron create/.test(b) && /--deliver local/.test(b));
  assert.equal(local.length, 1);
  assert.match(local[0], /--name resourcer-envprobe /);
  assert.match(install, /hermes -p resourcer cron remove resourcer-envprobe/);
});

test('the enable order of INSTALL 9.9 is the enableOrder of jobs.json', () => {
  const order = JSON.parse(read('hermes/cron/jobs.json')).install.enableOrder;
  const s = read('docs/INSTALL.md');
  const from = s.indexOf('### 9.9 ');
  const to = s.indexOf('## 10. ');
  const seg = s.slice(from, to);
  const got = [...seg.matchAll(/^hermes -p resourcer cron resume (resourcer-[a-z-]+)$/gm)].map((m) => m[1]);
  assert.deepEqual(got, order);
});

test('the alert job runs around the clock in every document that gives its schedule', () => {
  const alerts = JSON.parse(read('hermes/cron/jobs.json')).jobs.find((j) => j.name === 'resourcer-alerts');
  assert.equal(alerts.schedule, '*/5 * * * *');
  for (const f of LIVE_DOCS) {
    const t = read(f);
    assert.ok(!/resourcer-alerts[^\n]*05:00 to 23:55/.test(t), `${f} still gives the old alert hours`);
    assert.ok(!/\*\/5 5-23 \* \* \*/.test(t), `${f} mentions the old alert schedule`);
  }
});

test('"tick" being null in --status is documented as normal, never as a failure condition', () => {
  for (const f of ['docs/INSTALL.md', 'docs/ACCEPTANCE.md', 'hermes/AGENTS.md', 'hermes/skills/resourcer-ops/SKILL.md', 'docs/OPERATIONS.md']) {
    const t = read(f);
    assert.ok(!/`tick\.alive` true/.test(t), `${f} requires tick.alive true`);
    assert.ok(!/"tick"` with `"alive": true`/.test(t), `${f} requires a non-null tick`);
    assert.match(t, /lastTickAt/, `${f} judges the tick by lastTickAt`);
  }
});

function codeAlertKeys() {
  const keys = new Set();
  const kebab = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
  for (const f of CODE.filter((x) => x.endsWith('.js') && !x.startsWith('plugin/'))) {
    const src = read(f);
    let m;
    const re = /\bkey:\s*([^\n]*)/g;
    while ((m = re.exec(src))) {
      const around = src.slice(Math.max(0, m.index - 300), m.index + 300);
      if (!/notify|severity|alert/i.test(around)) continue;
      const line = m[1].split(/,\s*(?:text|meta|severity)\b/)[0];
      const rx = /(['"`])([a-z][a-z0-9-]*)(?=[:'"`$])/g;
      let k;
      while ((k = rx.exec(line))) if (kebab.test(k[2])) keys.add(k[2]);
    }
    const rc = /const\s+[A-Z_]*KEY[A-Z_]*\s*=\s*'([a-z-]+)'/g;
    let c;
    while ((c = rc.exec(src))) if (kebab.test(c[1])) keys.add(c[1]);
  }
  return keys;
}

test('every alert key the code raises is in the AGENTS.md table and in OPERATIONS section 11', () => {
  const keys = codeAlertKeys();
  assert.ok(keys.size > 40, `only ${keys.size} keys were found: the extraction is broken`);
  const agents = read('hermes/AGENTS.md');
  const ops = read('docs/OPERATIONS.md');
  const missingA = [...keys].filter((k) => !agents.includes(k));
  const missingO = [...keys].filter((k) => !ops.includes(k));
  assert.deepEqual(missingA, [], 'not in hermes/AGENTS.md');
  assert.deepEqual(missingO, [], 'not in docs/OPERATIONS.md');
});

test('every alert key documented in AGENTS.md and OPERATIONS section 11 exists in the code', () => {
  const src = CODE.filter((f) => /\.(js|py)$/.test(f)).map(read).join('\n');
  const agents = read('hermes/AGENTS.md');
  const table = agents.slice(agents.indexOf('| Key |'), agents.indexOf('Any key not in this table'));
  const doc = new Set();
  for (const l of table.split('\n')) {
    const m = /^\| ([^|]+) \|/.exec(l);
    if (!m || m[1].startsWith('Key') || m[1].startsWith('---')) continue;
    for (const k of m[1].split(',')) doc.add(k.trim().replace(/:<.*$/, ''));
  }
  assert.ok(doc.size > 50);
  assert.deepEqual([...doc].filter((k) => !src.includes(k)), []);
  const ops = read('docs/OPERATIONS.md');
  const sec = ops.slice(ops.indexOf('## 11. Alert keys'), ops.indexOf('## 12. '));
  const opsKeys = [...sec.matchAll(/^\| `([^`|]+)`/gm)].map((m) => m[1].replace(/:<.*$/, ''));
  assert.deepEqual(opsKeys.filter((k) => !src.includes(k)), []);
  assert.deepEqual(opsKeys.filter((k) => !agents.includes(k)), []);
});

test('docs/ENV.md documents every environment variable the code reads, and names nothing that exists nowhere', () => {
  const used = new Set();
  for (const f of CODE.filter((x) => /\.(js|py)$/.test(x))) {
    const s = read(f);
    for (const re of [
      /\benv\.(?:get|has|require|num|int|bool|flag|str|getNumber|getInt)\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
      /process\.env\.([A-Z][A-Z0-9_]+)/g,
      /process\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
      /os\.environ(?:\.get)?\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
      /os\.getenv\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
    ]) {
      let m;
      while ((m = re.exec(s))) used.add(m[1]);
    }
    // Local aliases such as E('SCREEN_ENGINE') or envNum('RESOURCER_X', 5): a setting family name as the first argument of a call.
    const fam = /^(RESOURCER|SCREEN|PHASE1|BACKUP|BUNDLE|CHROMIUM|AI_GATEWAY|HERMES|PLUGIN|CATERER|REED|SMOKE|PF|E2E|SUP|P1)_/;
    const markers = /^(REED_AUTH_FAILED|REED_CRED_OK|REED_LOGIN_BLOCKED_TURNSTILE|REED_LOGIN_OK|REED_RELOGIN_NEEDED|REED_TOKEN_REFRESHED)$/;
    for (const m of s.matchAll(/[A-Za-z_.\]]\(\s*(['"])([A-Z][A-Z0-9_]{4,})\1\s*[,)]/g)) {
      if (fam.test(m[2]) && !m[2].endsWith('_') && !markers.test(m[2])) used.add(m[2]);
    }
  }
  const envmd = read('docs/ENV.md');
  const doc = new Set([...envmd.matchAll(/^\| `([A-Z][A-Z0-9_]+)`/gm)].map((m) => m[1]));
  assert.ok(used.size > 30 && doc.size > 100, `${used.size} names read by the code, ${doc.size} documented`);
  assert.deepEqual([...used].filter((n) => !doc.has(n)).sort(), [], 'read by the code, missing from docs/ENV.md');
  const corpus = ALL.filter((f) => /^(resourcer|tools|plugin|hermes|tests)\//.test(f) && /\.(js|py|sh|json|md)$/.test(f)).map(read).join('\n');
  assert.deepEqual([...doc].filter((n) => !corpus.includes(n)).sort(), [], 'documented in docs/ENV.md, present in no file');
});

test('shipped wrappers named in the docs are the wrappers of hermes/scripts, and each job names a wrapper that exists', () => {
  const jobs = JSON.parse(read('hermes/cron/jobs.json')).jobs;
  for (const j of jobs) assert.ok(exists(`hermes/scripts/${j.script}`), `${j.script} missing`);
  const onDisk = ALL.filter((f) => /^hermes\/scripts\/resourcer-[a-z-]+\.sh$/.test(f)).map((f) => path.basename(f)).sort();
  assert.deepEqual(onDisk, jobs.map((j) => j.script).sort());
});

// ---- step numbers -------------------------------------------------------------------------------------

function headingNumbers(rel) {
  const set = new Set();
  for (const l of read(rel).split('\n')) {
    let m = /^## (\d+)\./.exec(l);
    if (m) set.add(m[1]);
    m = /^### (\d+\.\d+)\b/.exec(l);
    if (m) set.add(m[1]);
  }
  return set;
}

test('every "INSTALL <number>" reference in any document points at an existing heading of INSTALL.md', () => {
  const heads = headingNumbers('docs/INSTALL.md');
  assert.ok(heads.has('9.7') && heads.has('0.7') && heads.has('13'));
  const bad = [];
  for (const f of ALL_DOCS) {
    if (f.startsWith('docs/parity/')) continue;
    const t = read(f);
    const re = /\bINSTALL(?:\.md)?[`)]?[ ]+(?:(?:section|step|steps)[ ]+)?(\d{1,2}(?:\.\d{1,2})?)(?:(?:[ ]+to|,[ ]+and|,|[ ]+and)[ ]+(\d{1,2}(?:\.\d{1,2})?))*/g;
    let m;
    while ((m = re.exec(t))) {
      const nums = m[0].match(/\d{1,2}(?:\.\d{1,2})?/g) || [];
      for (const n of nums) if (!heads.has(n)) bad.push(`${f}: INSTALL ${n}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('INSTALL.md cross references inside the document ("step N", "N.M" after see/in/of/at) exist', () => {
  const t = read('docs/INSTALL.md');
  const heads = headingNumbers('docs/INSTALL.md');
  const bad = [];
  const body = t.replace(/```[\s\S]*?```/g, '');
  for (const m of body.matchAll(/\b[Ss]teps?[ ]+(\d{1,2}(?:\.\d{1,2})?)(?:(?:[ ]+to|,|[ ]+and)[ ]+(\d{1,2}(?:\.\d{1,2})?))*/g)) {
    for (const n of m[0].match(/\d{1,2}(?:\.\d{1,2})?/g)) if (!heads.has(n)) bad.push(`step ${n}`);
  }
  for (const m of body.matchAll(/\b(?:see|in|of|at|from|to|repeat|after|before|until|and|with)[ ]+(\d{1,2}\.\d{1,2})\b/g)) {
    if (!heads.has(m[1])) bad.push(`${m[0]}`);
  }
  for (const m of body.matchAll(/\((\d{1,2}\.\d{1,2})(?:[,;)]| and| to)/g)) {
    if (!heads.has(m[1])) bad.push(`(${m[1]}`);
  }
  assert.deepEqual(bad, []);
});

test('ACCEPTANCE ids referenced in other documents exist', () => {
  const ids = new Set([...read('docs/ACCEPTANCE.md').matchAll(/\| ([A-Z]{2}\d{1,2}b?) \|/g)].map((m) => m[1]));
  assert.ok(ids.has('GL05') && ids.has('BC01') && ids.has('SU03'));
  const bad = [];
  for (const f of LIVE_DOCS) {
    if (f === 'docs/ACCEPTANCE.md') continue;
    for (const m of read(f).matchAll(/\b(?:ACCEPTANCE|item|items)[ ]+`?((?:GL|BC|CO|BU|SR|SU|HF|DA|PH|IN|RE|DC)\d{1,2}b?)\b/g)) if (!ids.has(m[1])) bad.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(bad, []);
});

// ---- files and commands ---------------------------------------------------------------------------------

const RUNTIME_DIRS = /^(?:runs|downloads|logs|runtime|pending-searches|secrets|outbox|shadow|state|backups|cron|install-work|incoming|deploy|bin)\//;
const ROOTS = ['', 'resourcer/', 'resourcer/scripts/', 'tools/', 'tests/', 'docs/', 'hermes/', 'plugin/resourcer/', 'plugin/resourcer/dashboard/', 'hermes/scripts/'];
// Files a document names that are created at run time, on the laptop, or by the operator.
const CREATED = new Set([
  'candidates.db', 'data/resourcer-bundle.enc', 'config/dashboard-settings.json', 'scripts/resourcer-envprobe.sh',
  'install-work/deep-check.js', 'install-work/enable-plugin.py', 'config.yaml', 'package-lock.json', 'resourcer/package-lock.json',
  'dashboard/plugin_config.json',
]);

function backticked(text) {
  const out = [];
  for (const m of text.matchAll(/`([^`\n]+)`/g)) out.push(m[1].trim());
  return out;
}

test('repository paths named in backticks in the operator documents exist', () => {
  const bad = new Set();
  const pathRe = /^(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:js|sh|md|json|py|yaml|yml|b64|sha256)$/;
  for (const f of LIVE_DOCS) {
    for (let tok of backticked(read(f))) {
      if (/[\s<>$*{}|=:"']/.test(tok) && !/^(?:node|sh|bash)\s/.test(tok)) continue;
      tok = tok.replace(/^(?:node|sh|bash)\s+/, '').split(/\s/)[0];
      if (!pathRe.test(tok)) continue;
      if (/^(?:\/|~|\.\.|\$|<)/.test(tok) || RUNTIME_DIRS.test(tok) || CREATED.has(tok)) continue;
      if (/^(?:C:|R\/|W\/|P\/)/.test(tok)) continue;
      if (/YYYY|<|>|\*/.test(tok)) continue;
      const hit = ROOTS.some((r) => exists(r + tok));
      if (!hit) bad.add(`${f}: ${tok}`);
    }
  }
  assert.deepEqual([...bad].sort(), []);
});

test('scripts named as "node <script>" in code blocks exist, and every --flag they are given appears in the script or its libraries', () => {
  const libs = CODE.filter((f) => f.endsWith('.js'));
  const bad = new Set();
  let checked = 0;
  for (const f of LIVE_DOCS) {
    const text = read(f);
    const lines = [...fences(text).flatMap((b) => b.split('\n')), ...backticked(text)];
    for (const line of lines) {
      const m = /(?:^|[ ;&(])node[ ]+((?:[A-Za-z0-9_.\/-]+\/)?[A-Za-z0-9_.-]+\.js)((?:[ ]+[^\n`|;&]*)?)/.exec(line);
      if (!m) continue;
      let script = m[1];
      if (/^(?:\/|~|\$|<)/.test(script) && !script.startsWith('/opt/data/profiles/resourcer/workspace/')) continue;
      script = script.replace('/opt/data/profiles/resourcer/workspace/', '').replace(/^resourcer\/(?=scripts\/)/, '');
      const cands = [script, `resourcer/${script}`, `resourcer/scripts/${script}`, `tools/${script}`, `tests/${script}`];
      const rel = cands.find(exists);
      if (!rel) {
        if (!/^(?:install-work\/|R\/|W\/|file\.js$|merge-back\.js$)/.test(script)) bad.add(`${f}: node ${script} (no such file)`);
        continue;
      }
      checked += 1;
      const dir = path.posix.dirname(rel);
      const pool = [rel, ...libs.filter((x) => x.startsWith(`${dir}/`))];
      const src = pool.map(read).join('\n');
      for (const fl of (m[2].match(/(?:^|\s)(--[a-z][a-z0-9-]*)/g) || []).map((x) => x.trim())) {
        if (!src.includes(fl)) bad.add(`${f}: node ${rel} ${fl}`);
      }
    }
  }
  assert.ok(checked > 40, `only ${checked} commands were checked`);
  assert.deepEqual([...bad].sort(), []);
});

test('preflight probe ids used in INSTALL and ACCEPTANCE exist in tools/preflight.sh', () => {
  const pf = read('tools/preflight.sh');
  const bad = new Set();
  for (const f of ['docs/INSTALL.md', 'docs/ACCEPTANCE.md']) {
    for (const m of read(f).matchAll(/\b(?:preflight|probe|probes|PASS|FAIL|WARN)[ ,]+(?:[A-H]\d{1,2}b?(?:,[ ]*| and | to )?)+/g)) {
      for (const id of m[0].match(/\b[A-H]\d{1,2}b?\b/g) || []) if (!new RegExp(`[a-z]+ "?${id}[ "]`).test(pf) && !pf.includes(`"${id} `) && !pf.includes(` ${id} `)) bad.add(`${f}: ${id}`);
    }
  }
  assert.deepEqual([...bad].sort(), []);
});

test('the install runbook and the operator prompt agree on the two machine-level plugin commands', () => {
  const install = read('docs/INSTALL.md');
  const prompt = read('OPERATOR-PROMPT.md');
  for (const cmd of ['hermes plugins enable resourcer', 'hermes plugins list --enabled']) {
    assert.ok(install.includes(cmd), `INSTALL lacks ${cmd}`);
    assert.ok(prompt.includes(cmd), `OPERATOR-PROMPT lacks ${cmd}`);
  }
  assert.match(install, /### 10\.2 [^\n]*HUMAN-APPROVE/);
  assert.match(install, /### 0\.7 Create the scratch folder/);
  assert.match(prompt, /step 0\.7/);
});

test('every file the runbook writes into install-work has a 0.7 precondition, and 9.2 sets the wrapper mode', () => {
  const t = read('docs/INSTALL.md');
  assert.match(t, /mkdir -p \/opt\/data\/profiles\/resourcer\/install-work\n/);
  assert.match(t, /chmod 755 \/opt\/data\/profiles\/resourcer\/scripts\/resourcer-\*\.sh/);
  assert.match(t, /chmod 755 \/opt\/data\/profiles\/resourcer\/scripts\/resourcer-envprobe\.sh/);
  for (const marker of ['deep-check.js', 'enable-plugin.py']) assert.match(t, new RegExp(`0\\.7[^\\n]*[\\s\\S]{0,4000}${marker.replace('.', '\\.')}`));
});

test('documents are ASCII with LF line endings', () => {
  const bad = [];
  for (const f of ALL_DOCS.concat(['.gitattributes'].filter(exists))) {
    const buf = fs.readFileSync(path.join(REPO, f));
    if (buf.includes(13)) bad.push(`${f}: CR`);
    for (let i = 0; i < buf.length; i += 1) if (buf[i] > 127) { bad.push(`${f}: non-ASCII byte at ${i}`); break; }
  }
  assert.deepEqual(bad, []);
});
