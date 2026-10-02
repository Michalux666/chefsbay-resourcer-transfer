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
  'docs/SECURITY.md', 'docs/KNOWN-LIMITS.md', 'docs/SCREENING.md', 'docs/ENV.md', 'docs/UPDATE-JEV-ONLY.md', 'docs/UPDATE-B.md', 'docs/UPDATE-C.md', 'docs/UPDATE-RESCREEN.md', 'docs/RESCREEN.md', 'docs/UPDATE-E.md', 'docs/RESURFACE.md', 'docs/UPDATE-F.md', 'docs/ROLESCOPE.md', 'docs/ACTIVITY.md', 'docs/UPDATE-G.md',
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
      const id = /^\s*([A-Z][A-Z0-9_]*)\s*[,}]/.exec(m[1]);
      const lit = id && new RegExp(`const\\s+${id[1]}\\s*=\\s*'([a-z][a-z0-9-]*)'`).exec(src);
      if (lit && kebab.test(lit[1])) keys.add(lit[1]);
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
    const fam = /^(RESOURCER|SCREEN|CV|PHASE1|BACKUP|BUNDLE|CHROMIUM|AI_GATEWAY|HERMES|PLUGIN|CATERER|REED|SMOKE|PF|E2E|SUP|P1)_/;
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

test('UPDATE-JEV-ONLY.md: only commands this operator may run, every Hermes command by its full path, code before settings, and a rollback that restores the old setting', () => {
  const t = read('docs/UPDATE-JEV-ONLY.md');
  const blocks = fences(t);
  assert.ok(blocks.length >= 20, `only ${blocks.length} command blocks`);
  for (const b of blocks) {
    if (b.startsWith("'use strict'")) continue;
    assert.ok(!/(^|\s)(grep|head|sed|tail|awk|cat)(\s|$)/.test(b), `a command the operator cannot run: ${b.slice(0, 80)}`);
    assert.ok(!b.includes('|'), `a shell pipe: ${b.slice(0, 80)}`);
    if (/(^|\s)\S*hermes -p /.test(b)) assert.ok(b.startsWith('/opt/hermes/bin/hermes -p resourcer '), `Hermes command without its full path: ${b}`);
  }
  assert.ok(!/(^|[^/])hermes -p resourcer/.test(t.split('/opt/hermes/bin/hermes -p resourcer').join('')), 'a bare hermes command');
  const at = (needle) => { const i = t.indexOf(needle); assert.ok(i >= 0, `missing: ${needle}`); return i; };
  const pull = at('git -C /opt/data/profiles/resourcer/workspace pull --ff-only');
  const verify = at('check-manifest.js --installed off --expect <NEW_DIGEST>');
  const setting = at('/opt/hermes/bin/hermes -p resourcer config set SCREEN_ENGINE jev_only');
  const deep = at('install-work/deep-check.js');
  assert.ok(pull < verify && verify < setting && setting < deep, 'order: pull, verify, setting, deep check');
  assert.match(t, /"engines":\{"jev":\{"ok":true\}\}/);
  assert.match(t, /NO `llm` entry/);
  assert.match(t, /rm \/opt\/data\/profiles\/resourcer\/install-work\/deep-check\.js/);
  const rollback = t.slice(at('## Rolling back'));
  assert.match(rollback, /reset --hard <OLD_COMMIT>/);
  assert.match(rollback, /config set SCREEN_ENGINE jev_shadow/);
  assert.match(rollback, /check-manifest\.js --expect <OLD_DIGEST>/);
  assert.match(t, /SCREEN_ALLOW_LLM/);
  assert.ok(!/config set SCREEN_ALLOW_LLM (1|true|on)/.test(t), 'the note never turns the opt-in on');
});

function gitLines(args) {
  const r = require('child_process').spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null;
}

test('UPDATE-JEV-ONLY.md copies exactly the installed files that changed since the first release, and says nothing else changed', (t) => {
  const changed = gitLines(['diff', '--name-only', '016b444']);
  const added = gitLines(['ls-files', '--others', '--exclude-standard']);
  if (!changed || !added) { t.skip('no git history with the first release here'); return; }
  const files = changed.concat(added);
  const note = read('docs/UPDATE-JEV-ONLY.md');
  const wrappers = files.filter((f) => /^hermes\/scripts\/resourcer-[a-z-]+\.sh$/.test(f) || f === 'hermes/SOUL.md');
  assert.deepEqual(wrappers, [], 'a cron wrapper or SOUL.md changed: the note says they did not, and would have to copy them');
  assert.match(note, /cron wrappers and `SOUL\.md` are unchanged/);
  assert.ok(files.includes('hermes/AGENTS.md') && note.includes('workspace/hermes/AGENTS.md /opt/data/profiles/resourcer/workspace/AGENTS.md'));
  assert.ok(files.some((f) => f.startsWith('hermes/skills/resourcer-ops/')) && note.includes('skills/ops/resourcer-ops/'));
  const plugin = files.filter((f) => f.startsWith('plugin/resourcer/') && f !== 'plugin/resourcer/install-plugin.sh');
  assert.ok(plugin.length > 0);
  for (const f of plugin) {
    const rel = f.slice('plugin/resourcer/'.length);
    const cp = `cp /opt/data/profiles/resourcer/workspace/${f} /opt/data/plugins/resourcer/${rel}`;
    assert.ok(note.split(cp).length >= 3, `the note must copy ${f} on update and again on rollback`);
  }
  assert.ok(!/dashboard plugin are unchanged/.test(note), 'the plugin changed: the note may not say it did not');
});

// ---- Update B (screening criteria and the CV stage) ---------------------------------------------------

const noQuotes = (b) => b.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');

test('UPDATE-B.md: only commands this operator may run, code before canaries before resume, no setting is changed, and a rollback that needs none', () => {
  const t = read('docs/UPDATE-B.md');
  const blocks = fences(t);
  assert.ok(blocks.length >= 30, `only ${blocks.length} command blocks`);
  for (const b of blocks) {
    if (/^(Sam Sampleperson|Robin Roleplay)\n/.test(b)) continue;
    const bare = noQuotes(b);
    assert.ok(!/(^|\s)(grep|head|sed|tail|awk|cat)(\s|$)/.test(bare), `a command the operator cannot run: ${b.slice(0, 80)}`);
    assert.ok(!bare.includes('|'), `a shell pipe: ${b.slice(0, 80)}`);
    assert.ok(!/config set/.test(b), `the update changes no setting: ${b.slice(0, 80)}`);
    if (/(^|\s)\S*hermes -p /.test(b)) assert.ok(b.startsWith('/opt/hermes/bin/hermes -p resourcer '), `Hermes command without its full path: ${b}`);
  }
  const prose = t.split('/opt/hermes/bin/hermes -p resourcer').join('').split('hermes -p resourcer config set CV_SCREEN on').join('');
  assert.ok(!/(^|[^/])hermes -p resourcer/.test(prose), 'a bare hermes command');
  const at = (needle) => { const i = t.indexOf(needle); assert.ok(i >= 0, `missing: ${needle}`); return i; };
  const pause = at('/opt/hermes/bin/hermes -p resourcer cron pause resourcer-tick');
  const pull = at('git -C /opt/data/profiles/resourcer/workspace pull --ff-only');
  const verify = at('check-manifest.js --installed off --expect <NEW_DIGEST>');
  const copy = at('cp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md /opt/data/profiles/resourcer/workspace/AGENTS.md');
  const full = at('check-manifest.js --expect <NEW_DIGEST>');
  const batch = at('scripts/ai-review.js --mode batch');
  const cvCanary = at('scripts/cv-review.js --job "Chef de Partie" --cv-file /opt/data/profiles/resourcer/install-work/canary-cv.txt --no-shadow');
  const cvCanaryNo = at('canary-cv-no.txt --no-shadow');
  const resume = at('/opt/hermes/bin/hermes -p resourcer cron resume resourcer-tick');
  const report = at('scripts/cv-report.js --days 1 --mode shadow');
  assert.ok(pause < pull && pull < verify && verify < copy && copy < full && full < batch && batch < cvCanary && cvCanary < cvCanaryNo && cvCanaryNo < resume && resume < report,
    'order: pause, pull, verify, copy, full check, canaries, resume, report');
  assert.match(t, /rm \/opt\/data\/profiles\/resourcer\/install-work\/canary-cv\.txt/);
  assert.match(t, /rm \/opt\/data\/profiles\/resourcer\/install-work\/canary-cv-no\.txt/);
  assert.match(t, /never set `CV_SCREEN`/);
  assert.match(t, /start with `d60d917`/);
  const rollback = t.slice(at('## Rolling back'));
  assert.match(rollback, /reset --hard <OLD_COMMIT>/);
  assert.match(rollback, /check-manifest\.js --expect <OLD_DIGEST>/);
  assert.match(rollback, /nothing to set back/);
});

test('UPDATE-B.md canary commands and invented CVs are character for character those of INSTALL 7.3 and 7.6', () => {
  const note = fences(read('docs/UPDATE-B.md'));
  const install = fences(read('docs/INSTALL.md'));
  const canaries = note.filter((b) => /scripts\/(?:ai-review|cv-review)\.js/.test(b) || /^(Sam Sampleperson|Robin Roleplay)\n/.test(b));
  assert.equal(canaries.length, 6, 'batch, single, two CV files and two CV runs');
  for (const b of canaries) assert.ok(install.includes(b), `not in INSTALL: ${b.slice(0, 100)}`);
});

test('UPDATE-B.md copies exactly the installed files that changed since Update A, and says nothing else changed', (t) => {
  // The note describes Update B only: its range ends at the commit of Update B (later updates change other files and have their own notes).
  const changed = gitLines(['diff', '--name-only', 'd60d917', 'a7fc7be']);
  const added = changed ? [] : null;
  if (!changed || !added) { t.skip('no git history with Update A and B here'); return; }
  const files = changed.concat(added);
  const note = read('docs/UPDATE-B.md');
  const wrappers = files.filter((f) => /^hermes\/scripts\/resourcer-[a-z-]+\.sh$/.test(f) || f === 'hermes/SOUL.md' || f === 'hermes/cron/jobs.json');
  assert.deepEqual(wrappers, [], 'a cron wrapper, the job list or SOUL.md changed: the note says they did not');
  assert.deepEqual(files.filter((f) => f.startsWith('plugin/')), [], 'the dashboard plugin changed: the note says it did not');
  assert.ok(!files.includes('resourcer/package.json'), 'package.json changed: the note says no npm install');
  const installed = files.filter((f) => f.startsWith('hermes/') && f !== 'hermes/.env.example');
  assert.deepEqual(installed.sort(), ['hermes/AGENTS.md', 'hermes/skills/resourcer-ops/SKILL.md']);
  assert.ok(note.includes('cp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md /opt/data/profiles/resourcer/workspace/AGENTS.md'));
  assert.ok(note.includes('hermes/skills/resourcer-ops/. /opt/data/profiles/resourcer/skills/ops/resourcer-ops/'));
  assert.ok(note.split('cp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md').length >= 3, 'copied on update and again on rollback');
});

// ---- Update C, the release (Updates B, C and D installed together from d60d917) -------------------------------------------------------------

test('UPDATE-C.md: only commands this operator may run, code before checks before resume, no setting is changed, and a rollback that needs none', () => {
  const t = read('docs/UPDATE-C.md');
  const blocks = fences(t);
  assert.ok(blocks.length >= 40, `only ${blocks.length} command blocks`);
  for (const b of blocks) {
    if (/^(Sam Sampleperson|Robin Roleplay)\n/.test(b) || b.startsWith("'use strict'")) continue;
    const bare = noQuotes(b);
    assert.ok(!/(^|\s)(grep|head|sed|tail|awk|cat)(\s|$)/.test(bare), `a command the operator cannot run: ${b.slice(0, 80)}`);
    assert.ok(!bare.includes('|'), `a shell pipe: ${b.slice(0, 80)}`);
    assert.ok(!/config set/.test(b), `the update changes no setting: ${b.slice(0, 80)}`);
    if (/(^|\s)\S*hermes -p /.test(b)) assert.ok(b.startsWith('/opt/hermes/bin/hermes -p resourcer '), `Hermes command without its full path: ${b}`);
  }
  const prose = t.split('/opt/hermes/bin/hermes -p resourcer').join('').split('hermes -p resourcer config set CV_SCREEN on').join('');
  assert.ok(!/(^|[^/])hermes -p resourcer/.test(prose), 'a bare hermes command');
  const steps = t.indexOf('## 1. Before you start'); // the order is that of the steps, not of the summary above them
  const at = (needle, from) => { const i = t.indexOf(needle, from || steps); assert.ok(i >= 0, `missing: ${needle}`); return i; };
  const list = at('/opt/hermes/bin/hermes -p resourcer cron list');
  const pause = at('/opt/hermes/bin/hermes -p resourcer cron pause resourcer-tick');
  const pull = at('git -C /opt/data/profiles/resourcer/workspace pull --ff-only');
  const verify = at('check-manifest.js --installed off --expect <NEW_DIGEST>');
  const copy = at('cp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md /opt/data/profiles/resourcer/workspace/AGENTS.md');
  const plugin = at('cp /opt/data/profiles/resourcer/workspace/plugin/resourcer/dashboard/plugin_api.py /opt/data/plugins/resourcer/dashboard/plugin_api.py');
  const full = at('check-manifest.js --expect <NEW_DIGEST>');
  const selfTest = at('scripts/cv-review.js --self-test');
  const batch = at('scripts/ai-review.js --mode batch');
  const cvCanary = at('scripts/cv-review.js --job "Chef de Partie" --cv-file /opt/data/profiles/resourcer/install-work/canary-cv.txt --no-shadow');
  const cvCanaryNo = at('canary-cv-no.txt --no-shadow');
  const deep = at('RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node /opt/data/profiles/resourcer/install-work/deep-check.js');
  const resume = at('/opt/hermes/bin/hermes -p resourcer cron resume resourcer-tick');
  const report = at('scripts/cv-report.js --days 1 --mode shadow', resume);
  const catchup = at('tools/reed-catchup.js --queue <N> --per-day 10 --dry-run', resume);
  assert.ok(list < pause && pause < pull && pull < verify && verify < copy && copy < plugin && plugin < full && full < selfTest && selfTest < batch && batch < cvCanary && cvCanary < cvCanaryNo && cvCanaryNo < deep && deep < resume && resume < report && report < catchup,
    'order: list, pause, pull, verify, copy, plugin, full check, self-test, canaries, deep check, resume, watch');
  // the stale scratch files are removed, and the only place CV_SCREEN appears on a command line is the one-off live canary (nothing is written)
  assert.match(t, /rm \/opt\/data\/profiles\/resourcer\/install-work\/canary-cv\.txt/);
  assert.match(t, /rm \/opt\/data\/profiles\/resourcer\/install-work\/canary-cv-no\.txt/);
  assert.match(t, /rm \/opt\/data\/profiles\/resourcer\/install-work\/deep-check\.js/);
  const cvOnLines = blocks.flatMap((b) => b.split('\n')).filter((l) => /CV_SCREEN=/.test(l));
  assert.equal(cvOnLines.length, 1, 'CV_SCREEN appears in exactly one command: the optional one-off live canary');
  assert.match(cvOnLines[0], /^CV_SCREEN=on RESOURCER_ENV_FILE=\S+ node \S+deep-check\.js$/);
  assert.match(t, /never set `CV_SCREEN`/);
  assert.match(t, /`RESOURCER_SOURCES` stays as the owner set it, `both`/);
  assert.match(t, /start with `d60d917`/);
  assert.match(t, /fe1ca88206ff5e24325b5bd4378ce7a8d3e8d81329dec27a2823d689662ec4a0/);
  assert.match(t, /<NEW_DIGEST>/);
  assert.match(t, /prints on the owner's machine/);
  // no restart by the operator; the owner restarts the dashboard, and the order lets the tick resume first
  assert.match(t, /plugin_api\.py` \(the Python backend of the plugin\) is imported ONCE when the dashboard process starts/);
  assert.match(t, /HUMAN action in the Hermes Portal/);
  assert.match(t, /Both orders are safe/);
  assert.match(t, /env -u SCREEN_ENGINE/);
  const rollback = t.slice(at('## Rolling back'));
  assert.match(rollback, /reset --hard <OLD_COMMIT>/);
  assert.match(rollback, /check-manifest\.js --expect <OLD_DIGEST>/);
  assert.match(rollback, /nothing to set back/);
  assert.ok(rollback.includes('plugin_api.py /opt/data/plugins/resourcer/dashboard/plugin_api.py'), 'the rollback restores the plugin');
});

test('UPDATE-C.md: the snippet canaries are those of INSTALL 7.3 with --no-shadow, the CV canaries and invented CVs are those of INSTALL 7.6, the self-test is in both, the deep check is that of UPDATE-JEV-ONLY', () => {
  const note = fences(read('docs/UPDATE-C.md'));
  const install = fences(read('docs/INSTALL.md'));
  const snippet = note.filter((b) => /scripts\/ai-review\.js/.test(b));
  assert.equal(snippet.length, 2, 'batch and single');
  for (const b of snippet) assert.ok(install.includes(b.replace(' --with-codes --no-shadow', ' --with-codes')), `not INSTALL 7.3 plus --no-shadow: ${b.slice(0, 100)}`);
  const cv = note.filter((b) => /scripts\/cv-review\.js --job/.test(b) || /^(Sam Sampleperson|Robin Roleplay)\n/.test(b));
  assert.equal(cv.length, 4, 'two CV files and two CV runs');
  for (const b of cv) assert.ok(install.includes(b), `not in INSTALL: ${b.slice(0, 100)}`);
  const self = 'cd /opt/data/profiles/resourcer/workspace/resourcer && node scripts/cv-review.js --self-test';
  assert.ok(note.includes(self) && install.includes(self), 'the self-test command is the same in the note and in INSTALL 7.6');
  const jev = fences(read('docs/UPDATE-JEV-ONLY.md'));
  const scratch = note.find((b) => b.startsWith("'use strict'"));
  assert.ok(scratch && jev.includes(scratch), 'the deep-check file is character for character the one of UPDATE-JEV-ONLY');
  assert.ok(jev.includes('RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node /opt/data/profiles/resourcer/install-work/deep-check.js') && note.includes('RESOURCER_ENV_FILE=/opt/data/profiles/resourcer/.env node /opt/data/profiles/resourcer/install-work/deep-check.js'));
});

test('UPDATE-C.md copies exactly the installed files that changed since Update A, maps each the way check-manifest --installed does, and says nothing else changed', (t) => {
  // The release note: its range runs from Update A (d60d917) to the release. UPDATE-B.md describes d60d917..a7fc7be (tested above) and is superseded.
  const changed = gitLines(['diff', '--name-only', 'd60d917']);
  const added = gitLines(['ls-files', '--others', '--exclude-standard']);
  if (!changed || !added) { t.skip('no git history with Update A here'); return; }
  const files = changed.concat(added);
  const note = read('docs/UPDATE-C.md');
  const wrappers = files.filter((f) => /^hermes\/scripts\/resourcer-[a-z-]+\.sh$/.test(f) || f === 'hermes/SOUL.md' || f === 'hermes/cron/jobs.json');
  assert.deepEqual(wrappers, [], 'a cron wrapper, the job list or SOUL.md changed: the note says they did not');
  assert.ok(!files.includes('resourcer/package.json'), 'package.json changed: the note says no npm install');
  assert.ok(!files.includes('resourcer/scripts/migrate-schema.js'), 'the schema script changed: the note says no migration');
  const profile = files.filter((f) => f.startsWith('hermes/') && f !== 'hermes/.env.example');
  assert.deepEqual(profile.sort(), ['hermes/AGENTS.md', 'hermes/skills/resourcer-ops/SKILL.md']);
  assert.ok(note.includes('cp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md /opt/data/profiles/resourcer/workspace/AGENTS.md'));
  assert.ok(note.includes('hermes/skills/resourcer-ops/. /opt/data/profiles/resourcer/skills/ops/resourcer-ops/'));
  assert.ok(note.split('cp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md').length >= 3, 'copied on update and again on rollback');
  // the plugin: every changed file is copied to /opt/data/plugins/resourcer/<path below plugin/resourcer/> (the mapping of tools/check-manifest.js), compared, and put back on rollback
  const plugin = files.filter((f) => f.startsWith('plugin/'));
  assert.deepEqual(plugin.slice().sort(), ['plugin/resourcer/dashboard/dist/index.js', 'plugin/resourcer/dashboard/plugin_api.py']);
  // the number of installed files the note names is the number that changed (two profile files and the plugin files), spelled out
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];
  assert.ok(note.includes(`changes exactly ${words[profile.length + plugin.length]}: `), 'the note says how many installed files change, and the number is right');
  for (const f of plugin) {
    const rel = f.slice('plugin/resourcer/'.length);
    const cp = `cp /opt/data/profiles/resourcer/workspace/${f} /opt/data/plugins/resourcer/${rel}`;
    assert.ok(note.split(cp).length >= 3, `the note must copy ${f} on update and again on rollback`);
    assert.ok(note.includes(`cmp /opt/data/profiles/resourcer/workspace/${f} /opt/data/plugins/resourcer/${rel}`), `the note must compare ${f}`);
  }
  assert.ok(!/dashboard plugin (is|are) unchanged/.test(note), 'the plugin changed: the note may not say it did not');
});

test('UPDATE-B.md says it is superseded by UPDATE-C.md for an instance still at d60d917, and UPDATE-C.md says the same the other way round', () => {
  const b = read('docs/UPDATE-B.md');
  assert.match(b, /\*\*SUPERSEDED by `docs\/UPDATE-C\.md` for any instance that is still at `d60d917`\.\*\*/);
  assert.match(b, /Do not use this note for it/);
  const c = read('docs/UPDATE-C.md');
  assert.match(c, /so an instance still at `d60d917` does this note and NOT `docs\/UPDATE-B\.md`/);
  for (const f of ['docs/INSTALL.md', 'HANDOFF.md']) assert.ok(read(f).includes('docs/UPDATE-C.md'), `${f} points at the release note`);
});

test('Update C documents: a design default is never labelled an owner decision (it says "design default, not yet confirmed by the owner")', () => {
  for (const f of ['docs/UPDATE-C.md', 'docs/CV-SCREENING.md', 'docs/KNOWN-LIMITS.md']) {
    const t = read(f);
    for (const m of t.matchAll(/(owner decision|owner decided|decided by the owner)[^\n]{0,80}(K-CV1[3-9]|shadowMaxSeconds|cv-config-invalid|CV canary|phase2-held)/gi)) assert.fail(`${f} labels a design default an owner decision: ${m[0]}`);
  }
  assert.match(read('docs/DECISIONS.md'), /CVS-11[^\n]*design default, not yet confirmed by the owner/i);
});

test('release documents: "owner decision" is used only to say a choice is NOT one (an assistant-chosen rule or number is a "design default, not yet confirmed by the owner")', () => {
  const rows = (f, prefix) => read(f).split('\n').filter((l) => l.startsWith(prefix));
  const sources = [
    ['docs/UPDATE-C.md', read('docs/UPDATE-C.md').split('\n')],
    ['docs/UPDATE-RESCREEN.md', read('docs/UPDATE-RESCREEN.md').split('\n')],
    ['docs/RESCREEN.md', read('docs/RESCREEN.md').split('\n')],
    ['docs/OPERATIONS.md', read('docs/OPERATIONS.md').split('\n')],
    ['docs/parity/reed-first-page.md', read('docs/parity/reed-first-page.md').split('\n')],
    ['docs/parity/reed.md', read('docs/parity/reed.md').split('\n')],
    ['docs/CV-SCREENING.md', read('docs/CV-SCREENING.md').split('\n')],
    ['docs/parity/screening.md', read('docs/parity/screening.md').split('\n'), true],
    ['docs/SCREENING.md', read('docs/SCREENING.md').split('\n'), true],
    ['docs/ACCEPTANCE.md', rows('docs/ACCEPTANCE.md', '| [ ] | RE').concat(rows('docs/ACCEPTANCE.md', '| [ ] | SR1'))],
    ['docs/KNOWN-LIMITS.md', rows('docs/KNOWN-LIMITS.md', '| K-CV').concat(rows('docs/KNOWN-LIMITS.md', '| K-REED1'), rows('docs/KNOWN-LIMITS.md', '| K-RSC'))],
  ];
  const bad = [];
  for (const [f, lines, decidedOk] of sources) { // decidedOk: older documents that also report real instructions of the owner ("the owner decided that ...")
    for (const line of lines) {
      for (const m of line.matchAll(/owner decision/gi)) {
        const before = line.slice(Math.max(0, m.index - 16), m.index).toLowerCase();
        if (!/\bnot (an )?$/.test(before)) bad.push(`${f}: ${line.slice(Math.max(0, m.index - 60), m.index + 40)}`);
      }
      if (!decidedOk) for (const m of line.matchAll(/decided by the owner|owner decided/gi)) bad.push(`${f}: ${line.slice(Math.max(0, m.index - 60), m.index + 40)}`);
    }
  }
  assert.deepEqual(bad, []);
  // and the new defaults say what they are
  assert.match(read('docs/KNOWN-LIMITS.md'), /K-REED14[^\n]*design defaults that are not owner decisions/);
  assert.match(read('docs/KNOWN-LIMITS.md'), /K-REED17 \| OPEN \(release, design default, not yet confirmed by the owner\)/);
  assert.match(read('docs/OPERATIONS.md'), /What the tick allows a run to add \(design defaults, not yet confirmed by the owner;/);
});

test('CV_SCREEN defaults to shadow in the code and in every document that gives its default', () => {
  const { screenMode } = require(path.join(REPO, 'resourcer/scripts/lib/cv/config.js'));
  assert.equal(screenMode(undefined).mode, 'shadow');
  assert.equal(screenMode('').mode, 'shadow');
  assert.equal(screenMode('sahdow').mode, 'shadow');
  assert.equal(screenMode('off').mode, 'off');
  assert.equal(screenMode('on').mode, 'on');
  assert.match(read('docs/ENV.md'), /^\| `CV_SCREEN` \| `shadow` /m);
  assert.match(read('docs/CV-SCREENING.md'), /`CV_SCREEN` \(profile `\.env`\) \| `shadow` \(default/);
  for (const f of LIVE_DOCS.concat(['docs/CV-SCREENING.md', 'docs/DECISIONS.md', 'docs/parity/cv-stage.md'])) {
    assert.ok(!/CV_SCREEN[^\n]{0,40}(?:default `?off|\(default\) `?off|defaults to `?off)/i.test(read(f)), `${f} says CV_SCREEN defaults to off`);
  }
});

// ---- Update D (the re-screen tool, tools only) and docs/RESCREEN.md --------------------------------------------------------------------------

test('UPDATE-RESCREEN.md: only commands this operator may run, pause before pull before verify before the installed-copy check before resume, no setting is changed, nothing is copied, and a rollback that needs none', () => {
  const t = read('docs/UPDATE-RESCREEN.md');
  const blocks = fences(t);
  assert.ok(blocks.length >= 15, `only ${blocks.length} command blocks`);
  for (const b of blocks) {
    const bare = noQuotes(b);
    assert.ok(!/(^|\s)(grep|head|sed|tail|awk|cat)(\s|$)/.test(bare), `a command the operator cannot run: ${b.slice(0, 80)}`);
    assert.ok(!bare.includes('|'), `a shell pipe: ${b.slice(0, 80)}`);
    assert.ok(!/config set/.test(b), `the update changes no setting: ${b.slice(0, 80)}`);
    assert.ok(!/^cp /.test(b), `the update copies nothing: ${b.slice(0, 80)}`);
    if (/(^|\s)\S*hermes -p /.test(b)) assert.ok(b.startsWith('/opt/hermes/bin/hermes -p resourcer '), `Hermes command without its full path: ${b}`);
  }
  assert.ok(!/(^|[^/])hermes -p resourcer/.test(t.split('/opt/hermes/bin/hermes -p resourcer').join('')), 'a bare hermes command');
  const steps = t.indexOf('## 1. Before you start');
  const at = (needle, from) => { const i = t.indexOf(needle, from || steps); assert.ok(i >= 0, `missing: ${needle}`); return i; };
  const list = at('/opt/hermes/bin/hermes -p resourcer cron list');
  const pause = at('/opt/hermes/bin/hermes -p resourcer cron pause resourcer-tick');
  const status = at('pipeline-watchdog.js --status');
  const rev = at('git -C /opt/data/profiles/resourcer/workspace rev-parse HEAD');
  const old = at('check-manifest.js --installed off\n');
  const pull = at('git -C /opt/data/profiles/resourcer/workspace pull --ff-only');
  const verify = at('check-manifest.js --installed off --expect <NEW_DIGEST>');
  const full = at('check-manifest.js --installed auto --expect <NEW_DIGEST>');
  const help = at('tools/rescreen-policy-rejects.js --help');
  const resume = at('/opt/hermes/bin/hermes -p resourcer cron resume resourcer-tick');
  assert.ok(list < pause && pause < status && status < rev && rev < old && old < pull && pull < verify && verify < full && full < help && help < resume, 'order: list, pause, status, old commit, old digest, pull, verify, installed copies, help, resume');
  assert.match(t, /start with `315e99b`/);
  assert.match(t, /4bca8bb203613b5bd8c3e97669af3633efdbf5205cb2e3af246c1692e7797f26/);
  assert.match(t, /<NEW_DIGEST>/);
  assert.match(t, /never from `MANIFEST\.sha256` or from the checkout you are verifying/);
  assert.match(t, /no installed copy changes/i);
  assert.match(t, /no file under `resourcer\/`/);
  assert.match(t, /Idempotent: yes/);
  const rollback = t.slice(at('## Rolling back'));
  assert.match(rollback, /reset --hard <OLD_COMMIT>/);
  assert.match(rollback, /HUMAN-APPROVE/);
  assert.match(rollback, /check-manifest\.js --expect <OLD_DIGEST>/);
  assert.match(rollback, /nothing to set back/);
  assert.match(rollback, /undone FIRST|undone first|do that FIRST/);
});

test('UPDATE-RESCREEN.md says the commit is tools, tests and documents only: nothing under resourcer/, hermes/ or plugin/ changed in the commit that added it (or, before it is committed, since the release commit 315e99b), so there is nothing to install', (t) => {
  // pinned to ITS OWN commit once it exists, so a later legitimate commit (a change under resourcer/, another tool) does not fail this test for ever
  const own = gitLines(['log', '--diff-filter=A', '--format=%H', '--', 'docs/UPDATE-RESCREEN.md']);
  let files = null;
  if (own && own.length) files = gitLines(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', own[own.length - 1]]);
  else {
    const changed = gitLines(['diff', '--name-only', '315e99b']);
    const added = gitLines(['ls-files', '--others', '--exclude-standard']);
    if (changed && added) files = changed.concat(added);
  }
  if (!files || !files.length) { t.skip('no git history with the release commit here'); return; }
  const stray = files.filter((f) => !/^(tools|docs|tests)\//.test(f) && !['MANIFEST.sha256', 'README.md', 'HANDOFF.md'].includes(f));
  assert.deepEqual(stray, [], 'a file outside tools/, docs/ and tests/ changed: UPDATE-RESCREEN.md says nothing installed changes');
  assert.ok(files.includes('tools/rescreen-policy-rejects.js') && files.includes('docs/RESCREEN.md') && files.includes('docs/UPDATE-RESCREEN.md'));
  for (const f of files.filter((x) => x.startsWith('tools/'))) assert.ok(f === 'tools/rescreen-policy-rejects.js', `${f}: this update adds exactly one tool`);
});

test('RESCREEN.md: the runbook commands are hygienic and in order (pause, idle, dry run, owner gate, apply, check, resume, queue, undo), the owner numbers are placeholders, and the defaults it names are the ones in the code', () => {
  const t = read('docs/RESCREEN.md');
  const tool = require(path.join(REPO, 'tools/rescreen-policy-rejects.js'));
  const blocks = fences(t);
  assert.ok(blocks.length >= 15, `only ${blocks.length} command blocks`);
  for (const b of blocks) {
    const bare = noQuotes(b);
    assert.ok(!/(^|\s)(grep|head|sed|tail|awk|cat)(\s|$)/.test(bare), `a command the operator cannot run: ${b.slice(0, 80)}`);
    assert.ok(!bare.includes('|'), `a shell pipe: ${b.slice(0, 80)}`);
    assert.ok(!/config set/.test(b), `the procedure changes no setting: ${b.slice(0, 80)}`);
    if (/(^|\s)\S*hermes -p /.test(b)) assert.ok(b.startsWith('/opt/hermes/bin/hermes -p resourcer '), `Hermes command without its full path: ${b}`);
    if (/--confirm/.test(b)) assert.match(b, /--confirm <N>$/, `the owner's number is a placeholder: ${b}`);
    if (/--per-day/.test(b)) assert.match(b, /--per-day <M>( --dry-run)?$/, `the owner's number is a placeholder: ${b}`);
  }
  assert.ok(!/(^|[^/])hermes -p resourcer/.test(t.split('/opt/hermes/bin/hermes -p resourcer').join('')), 'a bare hermes command');
  const base = 'node /opt/data/profiles/resourcer/workspace/tools/rescreen-policy-rejects.js';
  const steps = t.indexOf('## 8. The apply');
  const at = (needle, from) => { const i = t.indexOf(needle, from || steps); assert.ok(i >= 0, `missing: ${needle}`); return i; };
  const list = at('/opt/hermes/bin/hermes -p resourcer cron list');
  const pause = at('/opt/hermes/bin/hermes -p resourcer cron pause resourcer-tick');
  const status = at('pipeline-watchdog.js --status');
  const dry = at(`${base}\n`);
  const dryReed = at(`${base} --reed-seen\n`);
  const gate = at('### 8.3 HUMAN decision gate (OWNER)');
  const apply = at(`${base} --apply --confirm <N>`);
  const applyReed = at(`${base} --reed-seen --apply --confirm <N>`);
  const resume = at('/opt/hermes/bin/hermes -p resourcer cron resume resourcer-tick');
  const queueDry = at(`${base} --queue --per-day <M> --dry-run`);
  const queue = at(`${base} --queue --per-day <M>\n`);
  const undoDry = at(`${base} --undo <LEDGER> --dry-run`);
  const undo = at(`${base} --undo <LEDGER>\n`);
  assert.ok(list < pause && pause < status && status < dry && dry < dryReed && dryReed < gate && gate < apply && apply < applyReed && applyReed < resume && resume < queueDry && queueDry < queue && queue < undoDry && undoDry < undo,
    'order: list, pause, status, dry run, dry run with Reed, owner gate, apply, apply with Reed, resume, queue dry run, queue, undo dry run, undo');
  assert.match(t, /Nobody but the owner gives these numbers/);
  assert.match(t, /\*\*The numbers come from the owner\.\*\*/);
  assert.ok(t.includes(`default ${tool.DEFAULT_SINCE}`), 'the default --since is the code default');
  assert.ok(t.includes(`If \`<N>\` is above ${tool.DEFAULT_MAX_ROWS}`), 'the --max-rows default is the code default');
  assert.ok(t.includes(`\`--per-day\` (default ${tool.DEFAULT_PER_DAY})`), 'the --per-day default is the code default');
  assert.ok(t.includes(`reserves ${tool.CV_RESERVE} views`), 'the Reed view reservation is the one of the code');
  assert.ok(t.includes(`a design default reserve of ${tool.CREDIT_RESERVE} credits`), 'the Caterer credit reserve is the one of the code');
  assert.ok(t.includes('(balance - 200) / 20') && tool.CREDIT_RESERVE === 200 && tool.CV_RESERVE === 20, 'the credit formula names the real constants');
  // the numbers the owner may name have a command the operator is allowed to run: a window and a higher limit, with placeholders only
  assert.ok(blocks.some((b) => b === `${base} --since <D> --until <D>`), 'a windowed dry run');
  assert.ok(blocks.some((b) => b === `${base} --since <D> --until <D> --max-rows <K> --apply --confirm <N>`), 'a windowed apply');
  assert.match(t, /leave both jobs paused\*\*, tell the owner/, 'a STOP leaves the jobs paused');
  assert.match(t, /Every `--queue` run needs the owner's message of that day/, 'no daily queue loop on its own');
  assert.match(t, /design default, not yet confirmed by the owner/);
  for (const f of ['docs/OPERATIONS.md', 'docs/KNOWN-LIMITS.md']) assert.ok(read(f).includes('docs/RESCREEN.md'), `${f} points at RESCREEN.md`);
  assert.ok(read('docs/KNOWN-LIMITS.md').includes('K-RSC3') && t.includes('K-RSC3'), 'the priority downgrade limit is documented in both');
  // the exit codes and files the documents name are the ones of the code
  const ops = read('docs/OPERATIONS.md');
  assert.match(ops, /\| `rescreen-policy-rejects\.js` \| 0 ok \(dry run, apply, queue, undo\), 1 unexpected, 2 usage, 3 refused with nothing written/);
  assert.match(tool.USAGE, /Exit codes: 0 ok, 1 unexpected error, 2 usage error, 3 refused \(nothing written\), 4 could not write\./);
  const src = read('tools/rescreen-policy-rejects.js');
  for (const name of ['rescreen-ledger-', 'rescreen-applied-', 'rescreen-undone-', 'rescreen-queue.json', 'zz-rescreen-']) {
    assert.ok(src.includes(name) && t.includes(name) && ops.includes(name.replace(/-$/, '')), `${name} is written by the code and named in RESCREEN.md and OPERATIONS.md`);
  }
});

test('the usage text of the re-screen tool lists exactly the options its parser accepts', () => {
  const tool = require(path.join(REPO, 'tools/rescreen-policy-rejects.js'));
  const src = read('tools/rescreen-policy-rejects.js');
  const parsed = new Set([...src.matchAll(/a === '(--[a-z-]+)'/g)].map((m) => m[1]));
  const usage = new Set([...tool.USAGE.matchAll(/(--[a-z-]+)/g)].map((m) => m[1]));
  parsed.delete('--help');
  assert.deepEqual([...usage].filter((f) => f !== '--help').sort(), [...parsed].sort());
});

test('the once-only guard and the catch-up view reservation are documented where an operator looks, with the names and reasons of the code', () => {
  const tool = require(path.join(REPO, 'tools/rescreen-policy-rejects.js'));
  const reasons = Object.keys(tool.EXCLUSION_LABELS);
  assert.ok(reasons.includes('cleared_before') && !reasons.includes('already_cleared'), 'the guard reason is cleared_before');
  for (const f of ['docs/RESCREEN.md', 'docs/OPERATIONS.md', 'docs/KNOWN-LIMITS.md', 'docs/DECISIONS.md']) {
    assert.ok(read(f).includes('cleared_before'), `${f} names cleared_before`);
    assert.ok(!/already_cleared/.test(read(f)), `${f} still names the old reason already_cleared`);
  }
  assert.match(read('docs/RESCREEN.md'), /\*\*The once-only guard \(owner requirement, 2026-10-01\)\.\*\*/);
  assert.match(read('docs/KNOWN-LIMITS.md'), /\| K-RSC8 \| ACCEPTED \(design; the once-only guard/);
  assert.match(read('docs/DECISIONS.md'), /\| RSC-7 \| Once-only guard/);
  assert.match(read('docs/OPERATIONS.md'), /Once only \(owner requirement\)/);
  // the retention claim of the documents is the code: nothing in the nightly jobs names a ledger or a marker
  for (const f of ['resourcer/scripts/maintenance.js', 'resourcer/scripts/retention-sweep.js', 'resourcer/scripts/backup-db.js', 'resourcer/scripts/lib/cv-retention.js']) assert.ok(!/rescreen/.test(read(f)), `${f} must not touch the ledgers`);
  // the catch-up tool reserves views for pending searches only, and says so
  const catchup = read('tools/reed-catchup.js');
  assert.ok(/pendingCatchups/.test(catchup) && !/floor\(remaining \/ CV_RESERVE\) - doneToday/.test(catchup), 'the old double count is gone');
  assert.match(read('docs/OPERATIONS.md'), /each catch-up search that is still PENDING/);
  assert.match(read('docs/KNOWN-LIMITS.md'), /K-REED15[^\n]*reserves 20 views only for the catch-up searches that are still pending/);
  assert.match(read('docs/DECISIONS.md'), /\| RSC-8 \| `tools\/reed-catchup\.js` reserves the 20 views/);
});

// ---- Update E: the role-scoped second look (docs/RESURFACE.md, docs/UPDATE-E.md) ----------------------------------------------------------------

test('RESURFACE.md: the traceability matrix names real tests, and the documents say plainly what the feature needs and costs', () => {
  const t = read('docs/RESURFACE.md');
  const from = t.indexOf('## 9. What was agreed and where it is proven');
  const to = t.indexOf('## 10. ');
  assert.ok(from > 0 && to > from, 'section 9 exists');
  const rows = t.slice(from, to).split('\n').filter((l) => /^\| C\d+ \|/.test(l)).map((l) => l.split(' | ').map((c) => c.replace(/^\|\s*|\s*\|$/g, '').trim()));
  assert.ok(rows.length >= 50, `${rows.length} matrix rows`);
  const lines = new Set();
  for (const r of rows) {
    assert.equal(r.length, 4, `a row has four cells: ${r[0]} ${String(r[1]).slice(0, 40)}`);
    lines.add(r[0]);
    const file = r[2].replace(/`/g, '');
    const name = r[3].replace(/^`|`$/g, '');
    if (/^\(not a repository test\)$/.test(file)) continue;
    assert.ok(exists(file), `${file} does not exist`);
    assert.ok(read(file).includes(name), `${file} has no test named: ${name}`);
  }
  for (let i = 1; i <= 11; i += 1) assert.ok(lines.has(`C${i}`), `no matrix row for C${i}`);
  // the matrix says what cannot be proven offline and names the first live signal
  assert.match(t, /## 10\. What cannot be proven offline, and the first live signal for each/);
  assert.match(t, /The first live signal/);
  // plain statements: it needs CV_SCREEN=on, it may cost a second credit, it is on by default, nothing is a kill switch
  assert.match(t, /Effective only while `CV_SCREEN` is `on`/);
  assert.match(t, /with the shipped `CV_SCREEN=shadow` this whole feature does nothing/);
  assert.match(t, /there is no kill switch on a charge/);
  assert.match(t, /never twice for the same role/i);
  assert.match(read('docs/ENV.md'), /^\| `CV_RESURFACE` \| `on` /m);
  assert.match(read('docs/ENV.md'), /^\| `CV_RESURFACE_MAX_PER_DAY` \| `40` /m);
  assert.match(read('docs/ENV.md'), /^\| `CV_RESURFACE_MIN_CREDITS` \| `1000` /m);
  const k = read('docs/KNOWN-LIMITS.md');
  assert.match(k, /\| K-RS1 \| OPEN, UNVERIFIED-LIVE\. Whether Caterer charges a second credit/);
  assert.match(k, /FIRST LIVE SIGNAL/);
  // the code defaults are the documented defaults
  const rs = require(path.join(REPO, 'resourcer/scripts/lib/resurface.js'));
  assert.equal(rs.DEFAULT_MAX_PER_DAY, 40);
  assert.equal(rs.DEFAULT_MIN_CREDITS, 1000);
  assert.equal(rs.ALERT_KEY, 'cv-resurface-cap-reached');
});

test('DECISIONS section 17: RS-1 to RS-4 are the instructions of the owner of 2026-10-01, every other row says it is a design default, not yet confirmed by the owner', () => {
  const d = read('docs/DECISIONS.md');
  const sec = d.slice(d.indexOf('## 17. The role-scoped second look'));
  const row = (id) => sec.split('\n').find((l) => l.startsWith(`| ${id} |`));
  for (const id of ['RS-1', 'RS-2', 'RS-3', 'RS-4']) assert.match(row(id), new RegExp(`^\\| ${id} \\| 2026-10-01, the owner[.,]`), id);
  assert.match(sec, /Every other row is a design default, not yet confirmed by the owner/);
  for (const id of ['RS-5', 'RS-6', 'RS-7', 'RS-8', 'RS-9', 'RS-10', 'RS-11', 'RS-12', 'RS-13', 'RS-14', 'RS-15']) {
    assert.ok(row(id), id);
    assert.ok(!/2026-10-01, the owner\./.test(row(id).slice(0, 60)), `${id} is not an instruction of the owner`);
  }
  assert.match(row('RS-5'), /The number 40 is the assistant's, not the owner's/);
  assert.match(row('RS-6'), /1000, the assistant's number/);
  assert.match(d, /CVS-8 \| 2026-09-30\.[^\n]*CHANGED on 2026-10-01 by `RS-1` to `RS-4`/);
});

test('UPDATE-E.md: only commands this operator may run, code before checks before resume, no setting is changed, and a rollback that needs none', () => {
  const t = read('docs/UPDATE-E.md');
  const blocks = fences(t);
  assert.ok(blocks.length >= 25, `only ${blocks.length} command blocks`);
  for (const b of blocks) {
    const bare = noQuotes(b);
    assert.ok(!/(^|\s)(grep|head|sed|tail|awk|cat)(\s|$)/.test(bare), `a command the operator cannot run: ${b.slice(0, 80)}`);
    assert.ok(!bare.includes('|'), `a shell pipe: ${b.slice(0, 80)}`);
    assert.ok(!/config set/.test(b), `the update changes no setting: ${b.slice(0, 80)}`);
    if (/(^|\s)\S*hermes -p /.test(b)) assert.ok(b.startsWith('/opt/hermes/bin/hermes -p resourcer '), `Hermes command without its full path: ${b}`);
  }
  const prose = t.split('/opt/hermes/bin/hermes -p resourcer').join('');
  assert.ok(!/(^|[^/])hermes -p resourcer/.test(prose), 'a bare hermes command');
  const steps = t.indexOf('## 1. Before you start');
  const at = (needle, from) => { const i = t.indexOf(needle, from || steps); assert.ok(i >= 0, `missing: ${needle}`); return i; };
  const list = at('/opt/hermes/bin/hermes -p resourcer cron list');
  const pause = at('/opt/hermes/bin/hermes -p resourcer cron pause resourcer-tick');
  const record = at('git -C /opt/data/profiles/resourcer/workspace rev-parse HEAD');
  const pull = at('git -C /opt/data/profiles/resourcer/workspace pull --ff-only');
  const verify = at('check-manifest.js --installed off --expect <NEW_DIGEST>');
  const copy = at('cp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md /opt/data/profiles/resourcer/workspace/AGENTS.md');
  const full = at('check-manifest.js --expect <NEW_DIGEST>');
  const selfTest = at('scripts/cv-review.js --self-test');
  const report = at('scripts/cv-report.js --days 1');
  const claim = at('candidates-db.js resurface-claim caterer 999999999999 Canary');
  const resume = at('/opt/hermes/bin/hermes -p resourcer cron resume resourcer-tick');
  assert.ok(list < pause && pause < record && record < pull && pull < verify && verify < copy && copy < full && full < selfTest && selfTest < report && report < claim && claim < resume,
    'order: list, pause, record, pull, verify, copy, full check, checks, resume');
  for (const ph of ['<NEW_DIGEST>', '<OLD_COMMIT>', '<OLD_DIGEST>']) assert.ok(t.includes(ph), ph);
  assert.match(t, /never set `CV_RESURFACE`/);
  assert.match(t, /It works only while `CV_SCREEN` is `on`/);
  assert.match(t, /There is no database migration/);
  assert.match(t, /THE FIRST LIVE SIGNAL/);
  const rollback = t.slice(at('## Rolling back'));
  assert.match(rollback, /reset --hard <OLD_COMMIT>/);
  assert.match(rollback, /check-manifest\.js --expect <OLD_DIGEST>/);
  assert.match(rollback, /nothing to set back/);
  assert.ok(read('docs/INSTALL.md').includes('docs/UPDATE-E.md') && read('HANDOFF.md').includes('docs/UPDATE-E.md'), 'INSTALL and HANDOFF point at the note');
});

test('UPDATE-E.md copies exactly the installed files that changed since the previous release, and says nothing else changed', (t) => {
  // pinned to the release that is installed on the instance (315e99b): the branch point from main stops working once main is fast-forwarded to this release
  const base = gitLines(['rev-parse', '--verify', '--quiet', '315e99b^{commit}']);
  if (!base || !base[0]) { t.skip('no git history with the release commit 315e99b here'); return; }
  const changed = gitLines(['diff', '--name-only', base[0]]);
  const added = gitLines(['ls-files', '--others', '--exclude-standard']);
  if (!changed || !added) { t.skip('no git history here'); return; }
  const files = changed.concat(added);
  const note = read('docs/UPDATE-E.md');
  const wrappers = files.filter((f) => /^hermes\/scripts\/resourcer-[a-z-]+\.sh$/.test(f) || f === 'hermes/SOUL.md' || f === 'hermes/cron/jobs.json');
  assert.deepEqual(wrappers, [], 'a cron wrapper, the job list or SOUL.md changed: the note says they did not');
  assert.deepEqual(files.filter((f) => f.startsWith('plugin/')), [], 'the dashboard plugin changed: the note says it did not');
  assert.ok(!files.includes('resourcer/package.json'), 'package.json changed: the note says no npm install');
  assert.ok(!files.includes('resourcer/scripts/migrate-schema.js'), 'the schema script changed: the note says no migration');
  const profile = files.filter((f) => f.startsWith('hermes/') && f !== 'hermes/.env.example');
  assert.deepEqual(profile.slice().sort(), ['hermes/AGENTS.md', 'hermes/skills/resourcer-ops/SKILL.md']);
  assert.ok(note.includes('cp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md /opt/data/profiles/resourcer/workspace/AGENTS.md'));
  assert.ok(note.includes('hermes/skills/resourcer-ops/. /opt/data/profiles/resourcer/skills/ops/resourcer-ops/'));
  assert.ok(note.split('cp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md').length >= 3, 'copied on update and again on rollback');
  const words = ['zero', 'one', 'two', 'three', 'four', 'five'];
  assert.ok(note.includes(`this release changes exactly ${words[profile.length]}: `), 'the note says how many installed files change, and the number is right');
});

// ---- Update F: the role scope (docs/ROLESCOPE.md, docs/UPDATE-F.md) ---------------------------------------------------------------------------------

test('ROLESCOPE.md: the traceability matrix names real tests (every line of the owner and of the brief has a row), and the documents say plainly what the setting controls and what cannot be proven offline', () => {
  const t = read('docs/ROLESCOPE.md');
  const from = t.indexOf('## 9. What was agreed and where it is proven');
  const to = t.indexOf('### 9b.');
  assert.ok(from > 0 && to > from, 'section 9 exists');
  const rows = t.slice(from, to).split('\n').filter((l) => /^\| (OD|R-C)\d+ \|/.test(l)).map((l) => l.split(' | ').map((c) => c.replace(/^\|\s*|\s*\|$/g, '').trim()));
  assert.ok(rows.length >= 60, `${rows.length} matrix rows`);
  const lines = new Set();
  for (const r of rows) {
    assert.equal(r.length, 4, `a row has four cells: ${r[0]} ${String(r[1]).slice(0, 40)}`);
    lines.add(r[0]);
    const file = r[2].replace(/`/g, '');
    const name = r[3].replace(/^`|`$/g, '');
    assert.ok(exists(file), `${file} does not exist`);
    if (/^\(not a repository test\)$/.test(name)) continue;
    assert.ok(read(file).includes(name), `${file} has no test named: ${name}`);
  }
  for (let i = 1; i <= 5; i += 1) assert.ok(lines.has(`OD${i}`), `no matrix row for OD${i}`);
  for (let i = 1; i <= 9; i += 1) assert.ok(lines.has(`R-C${i}`), `no matrix row for R-C${i}`);
  // the status table has a row for every line
  const status = t.slice(t.indexOf('### 9.0 Status of each line'), t.indexOf('| Line | What was agreed |'));
  for (const id of ['OD1', 'OD2', 'OD3', 'OD4', 'OD5', 'R-C1', 'R-C2', 'R-C3', 'R-C4', 'R-C5', 'R-C6', 'R-C7', 'R-C8', 'R-C9']) assert.ok(status.includes(`| **${id}** |`), `no status for ${id}`);
  // what cannot be proven offline names the first live signal
  assert.match(t, /## 10\. What cannot be proven offline, and the first live signal for each/);
  assert.match(t, /The first live signal/);
  // plain statements: what the setting controls, what has no switch, that it needs no CV_SCREEN, that the same role is never charged twice
  assert.match(t, /controls ONE thing/);
  assert.match(t, /has no switch/);
  assert.match(t, /independent of `CV_SCREEN`|does not depend on `CV_SCREEN`/);
  assert.match(t, /never screened \(or paid for\) again/);
  assert.match(t, /Reed was found to violate \(1\)/);
  // the settings are in ENV.md with the defaults of the code
  const env = read('docs/ENV.md');
  assert.match(env, /^\| `ROLE_SCOPE_LEGACY` \| `on` /m);
  assert.match(env, /^\| `ROLE_SCOPE_MIN_AGE_DAYS` \| `14` /m);
  assert.match(env, /^\| `ROLE_SCOPE_REED_MAX_PER_RUN` \| `100` /m);
  assert.match(read('resourcer/scripts/reed-phase1.js'), /ROLE_SCOPE_REED_MAX_PER_RUN', 100\)/);
  const rs = require(path.join(REPO, 'resourcer/scripts/lib/resurface.js'));
  assert.equal(rs.DEFAULT_MIN_AGE_DAYS, 14);
  assert.equal(rs.MIN_AGE_FLOOR_DAYS, 8);
  assert.equal(rs.ORIGIN_REED_SNIPPET, 'reed:snippet');
  assert.equal(rs.ORIGIN_REED_APPROVED, 'reed:approved');
  // the minimum age is beyond the stranded recovery window (7 days), as the document says
  assert.match(read('resourcer/scripts/recover-stranded-phase1.js'), /MAX_AGE_DAYS\s*=\s*7;/);
  assert.ok(rs.MIN_AGE_FLOOR_DAYS > 7 && rs.DEFAULT_MIN_AGE_DAYS > 7);
  // the limits the document names exist, and K-RS3 and K-RS7 say they are resolved
  const k = read('docs/KNOWN-LIMITS.md');
  for (let i = 1; i <= 13; i += 1) assert.match(k, new RegExp(`^\\| K-RL${i} \\|`, 'm'), `K-RL${i}`);
  assert.match(k, /^\| K-RS3 \| RESOLVED by Update F/m);
  assert.match(k, /^\| K-RS7 \| RESOLVED by Update F/m);
  assert.match(k, /K-RL1 \| OPEN, UNVERIFIED-LIVE\./);
  assert.match(k, /FIRST LIVE SIGNAL: the first day a legacy person is looked at/);
});

test('DECISIONS section 18: RL-1 to RL-5 are the instructions of the owner of 2026-10-01, every other row says it is a design default, not yet confirmed by the owner', () => {
  const d = read('docs/DECISIONS.md');
  const sec = d.slice(d.indexOf('## 18. The role scope'));
  assert.ok(sec.length > 1000);
  const row = (id) => sec.split('\n').find((l) => l.startsWith(`| ${id} |`));
  for (const id of ['RL-1', 'RL-2', 'RL-3', 'RL-4', 'RL-5']) assert.match(row(id), new RegExp(`^\\| ${id} \\| 2026-10-01, the owner[.,:( ]`), id);
  assert.match(sec, /Every other row is a design default, not yet confirmed by the owner/);
  for (let i = 6; i <= 17; i += 1) {
    const r = row(`RL-${i}`);
    assert.ok(r, `RL-${i}`);
    assert.ok(!/2026-10-01, the owner/.test(r.slice(0, 60)), `RL-${i} is not an instruction of the owner`);
  }
  assert.match(row('RL-7'), /the number 14 is the assistant's, not the owner's/);
  assert.match(row('RL-10'), /NOT counted against `CV_RESURFACE_MAX_PER_DAY`/);
});

test('UPDATE-F.md: only commands this operator may run, code before checks before resume, no setting is changed, nothing is copied, the old commit and digest are recorded, and a rollback that needs none', () => {
  const t = read('docs/UPDATE-F.md');
  const blocks = fences(t);
  assert.ok(blocks.length >= 20, `only ${blocks.length} command blocks`);
  for (const b of blocks) {
    const bare = noQuotes(b);
    assert.ok(!/(^|\s)(grep|head|sed|tail|awk|cat)(\s|$)/.test(bare), `a command the operator cannot run: ${b.slice(0, 80)}`);
    assert.ok(!bare.includes('|'), `a shell pipe: ${b.slice(0, 80)}`);
    assert.ok(!/config set/.test(b), `the update changes no setting: ${b.slice(0, 80)}`);
    // the update copies exactly two profile files: AGENTS.md and the resourcer-ops skill
    if (/(^|\s)cp\s/.test(b)) assert.ok(b.startsWith('cp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md /opt/data/profiles/resourcer/workspace/AGENTS.md') || b.startsWith('cp -r /opt/data/profiles/resourcer/workspace/hermes/skills/resourcer-ops/. /opt/data/profiles/resourcer/skills/ops/resourcer-ops/'), `the update copies only AGENTS.md and the skill: ${b.slice(0, 80)}`);
    if (/(^|\s)\S*hermes -p /.test(b)) assert.ok(b.startsWith('/opt/hermes/bin/hermes -p resourcer '), `Hermes command without its full path: ${b}`);
  }
  const prose = t.split('/opt/hermes/bin/hermes -p resourcer').join('');
  assert.ok(!/(^|[^/])hermes -p resourcer/.test(prose), 'a bare hermes command');
  const steps = t.indexOf('## 1. Before you start');
  const at = (needle, from) => { const i = t.indexOf(needle, from || steps); assert.ok(i >= 0, `missing: ${needle}`); return i; };
  const list = at('/opt/hermes/bin/hermes -p resourcer cron list');
  const pause = at('/opt/hermes/bin/hermes -p resourcer cron pause resourcer-tick');
  const record = at('git -C /opt/data/profiles/resourcer/workspace rev-parse HEAD');
  const pull = at('git -C /opt/data/profiles/resourcer/workspace pull --ff-only');
  const verify = at('check-manifest.js --installed off --expect <NEW_DIGEST>');
  const copyAgents = at('cp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md /opt/data/profiles/resourcer/workspace/AGENTS.md');
  const copySkill = at('cp -r /opt/data/profiles/resourcer/workspace/hermes/skills/resourcer-ops/. /opt/data/profiles/resourcer/skills/ops/resourcer-ops/');
  const full = at('check-manifest.js --expect <NEW_DIGEST>');
  const selfTest = at('scripts/cv-review.js --self-test');
  const report = at('scripts/cv-report.js --days 1');
  const claim = at('candidates-db.js resurface-claim caterer 999999999999 Canary');
  const dedupe = at('candidates-db.js check-batch-scoped 999999999999 Canary');
  const resume = at('/opt/hermes/bin/hermes -p resourcer cron resume resourcer-tick');
  assert.ok(list < pause && pause < record && record < pull && pull < verify && verify < copyAgents && copyAgents < copySkill && copySkill < full && full < selfTest && selfTest < report && report < claim && claim < dedupe && dedupe < resume,
    'order: list, pause, record, pull, verify, copy the two profile files, full check, checks, resume');
  for (const ph of ['<NEW_DIGEST>', '<OLD_COMMIT>', '<OLD_DIGEST>']) assert.ok(t.includes(ph), ph);
  // the release it starts from: the commit and the digest are recorded and compared
  assert.match(t, /START with `bc3e750`/);
  assert.match(t, /`8d33312998b1c90becf4779898517e69d9eeb8a9d2d0bef16599b3533c99b4ab`/);
  assert.match(t, /Updating bc3e750\.\.<new id>/);
  assert.match(t, /never set `ROLE_SCOPE_LEGACY`, `ROLE_SCOPE_MIN_AGE_DAYS`, `ROLE_SCOPE_REED_MAX_PER_RUN`/);
  // the owner's order to switch CV screening on: a step of its own, the owner's, after the resume, never in a command block and never the operator's
  const step10 = at('## 10. CV screening on');
  assert.ok(step10 > resume && step10 < at('## Rolling back'), 'step 10 comes after the resume and before the rollback');
  assert.match(t.slice(step10), /config set CV_SCREEN on/);
  assert.match(t.slice(step10), /HUMAN, never the operator/);
  assert.match(t, /It works with `CV_SCREEN` in any mode/);
  assert.match(t, /There is no database migration/);
  assert.match(t, /THE FIRST LIVE SIGNAL/);
  assert.match(t, /Reed profile views/);
  const rollback = t.slice(at('## Rolling back'));
  assert.match(rollback, /reset --hard <OLD_COMMIT>/);
  assert.match(rollback, /check-manifest\.js --expect <OLD_DIGEST>/);
  assert.match(rollback, /nothing to set back/);
  assert.ok(read('docs/INSTALL.md').includes('docs/UPDATE-F.md') && read('HANDOFF.md').includes('docs/UPDATE-F.md'), 'INSTALL and HANDOFF point at the note');
});

test('UPDATE-F.md copies exactly the installed files that changed since the release it starts from (AGENTS.md and the resourcer-ops skill), and says nothing else changed', (t) => {
  // pinned to the release that is installed on the instance (bc3e750): the branch point from main stops working once main is fast-forwarded to this release
  const base = gitLines(['rev-parse', '--verify', '--quiet', 'bc3e750^{commit}']);
  if (!base || !base[0]) { t.skip('no git history with the release commit bc3e750 here'); return; }
  const changed = gitLines(['diff', '--name-only', base[0]]);
  const added = gitLines(['ls-files', '--others', '--exclude-standard']);
  if (!changed || !added) { t.skip('no git history here'); return; }
  const files = changed.concat(added);
  const note = read('docs/UPDATE-F.md');
  const wrappers = files.filter((f) => /^hermes\/scripts\/resourcer-[a-z-]+\.sh$/.test(f) || f === 'hermes/SOUL.md' || f === 'hermes/cron/jobs.json');
  assert.deepEqual(wrappers, [], 'a cron wrapper, the job list or SOUL.md changed: the note says they did not');
  assert.deepEqual(files.filter((f) => f.startsWith('plugin/')), [], 'the dashboard plugin changed: the note says it did not');
  assert.ok(!files.includes('resourcer/package.json'), 'package.json changed: the note says no npm install');
  assert.ok(!files.includes('resourcer/scripts/migrate-schema.js'), 'the schema script changed: the note says no migration');
  const profile = files.filter((f) => f.startsWith('hermes/') && f !== 'hermes/.env.example').sort();
  assert.deepEqual(profile, ['hermes/AGENTS.md', 'hermes/skills/resourcer-ops/SKILL.md'], 'the files that the profile keeps a copy of and that changed: exactly the two the note copies');
  assert.ok(note.includes('this release changes exactly two'), 'the note says which installed copies change');
  assert.ok(note.includes('hermes/AGENTS.md') && note.includes('resourcer-ops'), 'the note names them');
  const ag = read('hermes/AGENTS.md');
  assert.ok(/`ROLE_SCOPE_LEGACY` and `ROLE_SCOPE_MIN_AGE_DAYS`/.test(ag), 'AGENTS.md lists the two settings as the owner\'s');
  assert.ok(ag.includes('it works in EVERY `CV_SCREEN` mode'), 'AGENTS.md says the role scope works in every CV_SCREEN mode');
  for (const f of ['resourcer/scripts/lib/resurface.js', 'docs/ROLESCOPE.md', 'resourcer/scripts/reed-phase1.js', 'resourcer/candidates-db.js']) assert.ok(files.includes(f), `${f}: the files the pull step names are in the release`);
});

test('no alert key and no exit code is added by the role scope: the code raises no key of its own', () => {
  const keys = [...codeAlertKeys()];
  assert.ok(keys.length > 40);
  assert.ok(!keys.some((k) => /role-?scope|legacy/i.test(k)), 'no alert key of the role scope');
  assert.ok(keys.includes('cv-resurface-cap-reached'), 'the one existing key is what the role scope raises');
});

// ---- Update G (the search window and the CV limit: docs/ACTIVITY.md, docs/UPDATE-G.md) ------------------------------------------------------------

test('UPDATE-G.md: only commands this operator may run, code before checks before the probe before resume, no setting is changed, and a rollback that needs none', () => {
  const t = read('docs/UPDATE-G.md');
  const blocks = fences(t);
  assert.ok(blocks.length >= 25, `only ${blocks.length} command blocks`);
  for (const b of blocks) {
    const bare = noQuotes(b);
    assert.ok(!/(^|\s)(grep|head|sed|tail|awk|cat)(\s|$)/.test(bare), `a command the operator cannot run: ${b.slice(0, 80)}`);
    assert.ok(!bare.includes('|'), `a shell pipe: ${b.slice(0, 80)}`);
    assert.ok(!/config set/.test(b), `the update changes no setting: ${b.slice(0, 80)}`);
    if (/(^|\s)\S*hermes -p /.test(b)) assert.ok(b.startsWith('/opt/hermes/bin/hermes -p resourcer '), `Hermes command without its full path: ${b}`);
  }
  const prose = t.split('/opt/hermes/bin/hermes -p resourcer').join('');
  assert.ok(!/(^|[^/])hermes -p resourcer/.test(prose), 'a bare hermes command');
  const steps = t.indexOf('## 1. Before you start');
  const at = (needle, from) => { const i = t.indexOf(needle, from || steps); assert.ok(i >= 0, `missing: ${needle}`); return i; };
  const list = at('/opt/hermes/bin/hermes -p resourcer cron list');
  const pause = at('/opt/hermes/bin/hermes -p resourcer cron pause resourcer-tick');
  const idle = at('pipeline-watchdog.js --status');
  const record = at('git -C /opt/data/profiles/resourcer/workspace rev-parse HEAD');
  const pull = at('git -C /opt/data/profiles/resourcer/workspace pull --ff-only');
  const verify = at('check-manifest.js --installed off --expect <NEW_DIGEST>');
  const copy = at('cp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md /opt/data/profiles/resourcer/workspace/AGENTS.md');
  const full = at('check-manifest.js --expect <NEW_DIGEST>');
  const url = at('build-caterer-results-url.js --job "Chef" --location FY4 --distance 20 --search-id probe --active-within "1 month"');
  const oneOff = at('--active-within "12 months" --manual');
  const unmapped = at('--active-within "3 months" --manual');
  const recent = at('tools/activity-probe.js --recent 3');
  const dry = at('tools/activity-probe.js --job "<TITLE>" --location FY4 --distance 20 --dry-run --extra-ids 6,10,14');
  const gate = at('## 8. The read-only probe (HUMAN gate');
  const probe = at('tools/activity-probe.js --job "<TITLE>" --location FY4 --distance 20 --extra-ids 6,10,14\n', gate);
  const resume = at('/opt/hermes/bin/hermes -p resourcer cron resume resourcer-tick', gate);
  assert.ok(list < pause && pause < idle && idle < record && record < pull && pull < verify && verify < copy && copy < full && full < url && url < oneOff && oneOff < unmapped && unmapped < recent && recent < dry && dry < gate && gate < probe && probe < resume,
    'order: list, pause, idle, record, pull, verify, copy, full check, offline checks, probe (HUMAN gate), resume');
  for (const ph of ['<NEW_DIGEST>', '<OLD_COMMIT>', '<OLD_DIGEST>']) assert.ok(t.includes(ph), ph);
  assert.match(t, /never set `CATERER_ACTIVITY_FILTER`/);
  assert.match(t, /never edit `config\/caterer-activity\.json`/);
  assert.match(t, /There is no database migration/);
  assert.match(t, /THE FIRST LIVE SIGNAL/);
  assert.match(t, /HUMAN gate: the owner reads the result/);
  assert.match(t, /STOP here\. Send the owner the printed lines exactly as they are/);
  assert.match(t, /START with `9a9362a`/);
  assert.match(t, /`ebf6a4b9382238795044b52823ae233c69b23058d6db35bc6638a0c2fd669114`/);
  assert.match(t, /Updating 9a9362a\.\.<new id>/);
  assert.match(t, /background terminal task/, 'the probe can outlast the foreground limit');
  const rollback = t.slice(at('## Rolling back'));
  assert.match(rollback, /reset --hard <OLD_COMMIT>/);
  assert.match(rollback, /HUMAN-APPROVE/);
  assert.match(rollback, /check-manifest\.js --expect <OLD_DIGEST>/);
  assert.match(rollback, /nothing to set back/);
  for (const f of ['docs/INSTALL.md', 'HANDOFF.md']) assert.ok(read(f).includes('docs/UPDATE-G.md'), `${f} points at the note`);
});

test('UPDATE-G.md copies exactly the installed files that changed since the previous release (9a9362a, the role scope), and says nothing else changed', (t) => {
  // pinned to the release that is installed on the instance (9a9362a, the release of Update F), not to the branch it was cut from: that branch moves
  const base = gitLines(['rev-parse', '--verify', '--quiet', '9a9362a^{commit}']);
  if (!base || !base[0]) { t.skip('no git history with the release commit 9a9362a here'); return; }
  const changed = gitLines(['diff', '--name-only', base[0]]);
  const added = gitLines(['ls-files', '--others', '--exclude-standard']);
  if (!changed || !added) { t.skip('no git history here'); return; }
  const files = changed.concat(added);
  const note = read('docs/UPDATE-G.md');
  const wrappers = files.filter((f) => /^hermes\/scripts\/resourcer-[a-z-]+\.sh$/.test(f) || f === 'hermes/SOUL.md' || f === 'hermes/cron/jobs.json');
  assert.deepEqual(wrappers, [], 'a cron wrapper, the job list or SOUL.md changed: the note says they did not');
  assert.deepEqual(files.filter((f) => f.startsWith('plugin/')), [], 'the dashboard plugin changed: the note says it did not');
  assert.ok(!files.includes('resourcer/package.json'), 'package.json changed: the note says no npm install');
  assert.ok(!files.includes('resourcer/scripts/migrate-schema.js'), 'the schema script changed: the note says no migration');
  const profile = files.filter((f) => f.startsWith('hermes/') && f !== 'hermes/.env.example');
  assert.deepEqual(profile.slice().sort(), ['hermes/AGENTS.md', 'hermes/skills/resourcer-ops/SKILL.md']);
  assert.ok(note.includes('cp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md /opt/data/profiles/resourcer/workspace/AGENTS.md'));
  assert.ok(note.includes('hermes/skills/resourcer-ops/. /opt/data/profiles/resourcer/skills/ops/resourcer-ops/'));
  assert.ok(note.split('cp /opt/data/profiles/resourcer/workspace/hermes/AGENTS.md').length >= 3, 'copied on update and again on rollback');
  const words = ['zero', 'one', 'two', 'three', 'four', 'five'];
  assert.ok(note.includes(`this release changes exactly ${words[profile.length]}: `), 'the note says how many installed files change, and the number is right');
  // the files the pull must bring, as step 3 names them
  for (const f of ['resourcer/scripts/lib/search-activity.js', 'resourcer/config/caterer-activity.json', 'tools/activity-probe.js', 'docs/ACTIVITY.md']) {
    assert.ok(files.includes(f), `${f} is new in this release`);
    assert.ok(note.includes(f), `step 3 names ${f}`);
  }
});

test('Update G: the alert key, the setting and the mapping the documents name are the ones of the code', () => {
  const sa = require(path.join(REPO, 'resourcer/scripts/lib/search-activity.js'));
  assert.equal(sa.ALERT_KEY, 'caterer-activity-mismatch');
  for (const f of ['hermes/AGENTS.md', 'docs/OPERATIONS.md']) assert.ok(read(f).includes('caterer-activity-mismatch'), `${f} registers the alert`);
  assert.equal(sa.DEFAULT_SETTING, 'manual');
  assert.match(read('docs/ENV.md'), /^\| `CATERER_ACTIVITY_FILTER` \| `manual` /m);
  assert.deepEqual(sa.readSetting(() => undefined), { value: 'manual', warn: null });
  // the table of docs/ACTIVITY.md is the table of the shipped config
  const cfg = JSON.parse(read('resourcer/config/caterer-activity.json'));
  const act = read('docs/ACTIVITY.md');
  for (const label of sa.LABELS) {
    const row = act.split('\n').find((l) => l.startsWith(`| ${label} |`));
    assert.ok(row, `ACTIVITY.md has a row for ${label}`);
    const id = cfg.labels[label].id;
    if (id === null) assert.match(row, /none known: no filter, a WARN/, label);
    else assert.ok(new RegExp(`^\\| ${label} \\| ${id}[ (|]`).test(row), `${label}: id ${id} is the one of the config`);
  }
  assert.match(act.split('\n').find((l) => l.startsWith('| 18 months |')), /two years \(the next wider one/);
  // the paths and the exit codes of the probe in OPERATIONS are the tool's
  const tool = require(path.join(REPO, 'tools/activity-probe.js'));
  assert.match(tool.USAGE, /Exit codes: 0 done, 1 unexpected error, 2 usage or validation error, 3 refused \(a pipeline run is in flight or the browser lock is held\),\n\s+4 not signed in \(Caterer\) or Reed token not refreshed, 5 some variants could not be read\./);
  assert.match(read('docs/OPERATIONS.md'), /\| `activity-probe\.js` \| 0 done \(also `--dry-run` and `--recent`\), 1 unexpected, 2 usage or invalid input, 3 refused \(a pipeline run is in flight or the browser lock is held\), 4 not signed in \(Caterer\) or Reed token not refreshed, 5 some variants could not be read \|/);
  const src = read('tools/activity-probe.js');
  const parsed = new Set([...src.matchAll(/a === '(--[a-z-]+)'/g)].map((m) => m[1]));
  const usage = new Set([...tool.USAGE.matchAll(/(--[a-z-]+)/g)].map((m) => m[1]));
  parsed.delete('--help');
  assert.deepEqual([...usage].filter((f) => f !== '--help').sort(), [...parsed].sort(), 'the usage text lists exactly the options the parser accepts');
});

test('Update G: the CV reject-rate ceiling is 0.20 in the shipped config, in the built-in defaults and in every document, and no document still says 10 percent', () => {
  assert.equal(JSON.parse(read('resourcer/config/cv-screening.json')).alerts.rejectRateCeiling, 0.2);
  assert.equal(JSON.parse(read('resourcer/scripts/lib/cv/defaults.json')).alerts.rejectRateCeiling, 0.2);
  assert.match(read('docs/OPERATIONS.md'), /`cv-reject-rate-high` \| WARN \| CV screening rejected \(shadow: would reject\) more than 20 percent of a queue of at least 10 CVs/);
  assert.match(read('hermes/AGENTS.md'), /\| cv-reject-rate-high \| [^\n]*more than 20 percent of a queue of at least 10 CVs/);
  const cvdoc = read('docs/CV-SCREENING.md');
  assert.match(cvdoc, /`alerts\.rejectRateCeiling`, `alerts\.rejectRateMinCandidates` \| 0\.20, 10 \|/);
  for (const f of ['docs/CV-SCREENING.md', 'docs/OPERATIONS.md', 'hermes/AGENTS.md']) {
    assert.ok(!/more than 10 percent of (a queue|at least 10 CVs)/.test(read(f)), `${f} still gives the old 10 percent ceiling`);
  }
  assert.match(read('docs/KNOWN-LIMITS.md'), /K-ACT8 \| The reject-rate ceiling[^\n]*design default, not yet confirmed by the owner/);
});

test('Update G: the Hermes cron history is read by job id in every document (the by-name form printed nothing on 2026-10-01), and the by-name form is only named to say so', () => {
  for (const f of ALL_DOCS) {
    const t = read(f);
    assert.ok(!/cron runs resourcer-[a-z-]+/.test(t), `${f} gives \`cron runs\` a job name`);
  }
  const ops = read('docs/OPERATIONS.md');
  assert.match(ops, /hermes -p resourcer cron runs <JOB_ID> --limit 5/);
  assert.match(ops, /No cron execution attempts recorded/);
  assert.match(ops, /The by-id form could not be tried offline/);
});

test('Update G: the documents keep design defaults apart from the owner\'s instruction (ACT-1 is the owner\'s; every other row says it is a design default, not yet confirmed by the owner)', () => {
  const d = read('docs/DECISIONS.md');
  const sec = d.slice(d.indexOf('## 19. The search window and the CV limit'));
  assert.ok(sec.length > 500);
  const row = (id) => sec.split('\n').find((l) => l.startsWith(`| ${id} |`));
  assert.match(row('ACT-1'), /^\| ACT-1 \| 2026-10-01, the owner\./);
  assert.match(sec, /Every number and mapping below is a design default, not yet confirmed by the owner, unless it says it is the owner's/);
  for (let i = 2; i <= 8; i += 1) { assert.ok(row(`ACT-${i}`), `ACT-${i}`); assert.ok(!/^\| ACT-\d \| 2026-10-01, the owner\./.test(row(`ACT-${i}`)), `ACT-${i} is not an instruction of the owner`); }
  assert.match(row('ACT-2'), /design default, not yet confirmed by the owner/);
  const k = read('docs/KNOWN-LIMITS.md');
  assert.match(k, /\| K-ACT1 \| OPEN, UNVERIFIED-LIVE\. The Caterer "active within" filter was silently dropped from 2026-06-02/);
  assert.match(k, /FIRST LIVE SIGNAL: the `ACTIVITY_FILTER` line/);
  assert.match(k, /\| K-ACT2 \| OPEN, awaiting the owner\. Standing territories are unchanged by default/);
  assert.match(k, /K-ACT3 \| 3 months and 18 months have NO known Caterer id/);
  const bad = [];
  for (const [f, lines] of [['docs/ACTIVITY.md', read('docs/ACTIVITY.md').split('\n')], ['docs/UPDATE-G.md', read('docs/UPDATE-G.md').split('\n')],
    ['docs/KNOWN-LIMITS.md', read('docs/KNOWN-LIMITS.md').split('\n').filter((l) => l.startsWith('| K-ACT'))], ['docs/DECISIONS.md', sec.split('\n')]]) {
    for (const line of lines) {
      for (const m of line.matchAll(/owner decision|decided by the owner|owner decided/gi)) {
        const before = line.slice(Math.max(0, m.index - 16), m.index).toLowerCase();
        if (!/\bnot (an )?$/.test(before)) bad.push(`${f}: ${line.slice(Math.max(0, m.index - 60), m.index + 40)}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('Update G: the contested Caterer id of 12 months is disclosed wherever the id is given, and the probe command that settles it is the one the documents run', () => {
  const act = read('docs/ACTIVITY.md');
  assert.match(act, /\| 12 months \| 15 \(CONTESTED, see below\) \|/);
  assert.match(act, /12 months = 14 and 18 months = 15/);
  assert.match(read('docs/DECISIONS.md'), /ACT-3 \|[^\n]*CONTESTED/);
  assert.match(read('docs/KNOWN-LIMITS.md'), /K-ACT1 \|[^\n]*SECOND legacy source[^\n]*12 months = 14/);
  assert.match(read('docs/UPDATE-G.md'), /an older source gives 14 for 12 months and 15 for 18 months/);
  assert.match(read('docs/OPERATIONS.md'), /12 months = 15 is CONTESTED/);
  assert.match(read('resourcer/config/caterer-activity.json'), /12 months = 15 is CONTESTED/);
  // the ids the notes pass to --extra-ids are the three the old skill table gives for 7 days, 3 months and 12 months
  for (const f of ['docs/UPDATE-G.md', 'docs/OPERATIONS.md']) assert.ok(read(f).includes('--extra-ids 6,10,14'), f);
  // no document claims a window is "never narrower" for Caterer: only Reed is
  for (const f of ['docs/ACTIVITY.md', 'docs/OPERATIONS.md', 'docs/DECISIONS.md', 'docs/KNOWN-LIMITS.md']) {
    for (const line of read(f).split('\n')) {
      if (/never narrower/i.test(line) && /Caterer/.test(line)) assert.match(line, /Reed[^.]*never narrower|never narrower[^.]*Reed|not widened|NOT widened/, `${f}: ${line.slice(0, 120)}`);
    }
  }
});
