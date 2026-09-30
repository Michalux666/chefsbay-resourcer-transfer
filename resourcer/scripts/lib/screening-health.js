// Is AI screening usable right now? Used by supervision (the halt logic), never by the pipeline itself.
//
//   check({ deep:false })  cheap: is the AI Gateway origin reachable (DNS + TCP, milliseconds) and is
//                          a key configured. Safe to run on every tick.
//   check({ deep:true })   a real check: GET /v1/credits (auth + balance, no tokens), then one tiny
//                          canary call to the ENGINE THAT DECIDES: in jev_only (the default) ONLY Jev
//                          (the LLM canary is skipped and no chat-completions request is made); otherwise
//                          the LLM, plus Jev when the engine is 'jev'. Costs a fraction of a cent and takes
//                          about a second (the legacy probe took 73-103 s). Run it only while halted, at
//                          most once a minute.
//
// Returns { ok, reason, ms, level, key, detail, engines, degraded }. reason is '' when ok, otherwise
// one of the FIXED strings in REASONS (put status codes and bodies in `detail`, never in `reason`, so
// the halt state does not churn when a status code changes).
'use strict';

const net = require('net');
const path = require('path');
const paths = require('./paths');
const env = require('./env');
const fsx = require('./fsx');
const screening = require('./screening');
const http = require('./screening/http');
const { LlmClient } = require('./screening/llm-client');
const { JevClient } = require('./screening/jev-client');
const { HttpFailure, InvalidAnswer, reasonKeyOf } = require('./screening/errors');
const { parseDecision } = require('./screening/engine');

const REASONS = {
  unreachable: 'screening gateway unreachable',
  auth: 'screening gateway auth failed',
  credits: 'screening credits exhausted',
  error: 'screening gateway error',
  unavailable: 'AI screening unavailable',
};

const REMEDIES = {
  unreachable: 'Check the instance network and DNS, and the AI Gateway status page. Screening resumes automatically once the gateway is reachable.',
  auth: 'Check AI_GATEWAY_API_KEY in the profile .env; create a new key in the Vercel AI Gateway dashboard if it was revoked. If the detail says the team has restricted access to a model, allow typesafe-ai/jev on the Vercel team (AI Gateway model access); the gateway carries only that model. Screening resumes automatically.',
  credits: 'Top up the Vercel AI Gateway credits (or raise the key budget). Screening resumes automatically.',
  error: 'The AI Gateway or the model is failing. Check the AI Gateway status page; if it persists, tell the owner (SCREEN_LLM_MODEL only matters for the engines llm, jev_shadow and jev; the default jev_only calls Jev alone). Screening resumes automatically.',
  unavailable: 'AI screening failed on several consecutive pages. Check the halt detail; it clears itself when the deep check passes.',
};

// A 403 that names a restricted model is the owner's Vercel team refusing the model, not a bad key.
const RESTRICTED_REMEDY = 'The Vercel team has restricted access to this model. Allow typesafe-ai/jev on the Vercel team (AI Gateway model access settings); Jev is the only model this system sends through the gateway. Screening resumes automatically once it is allowed.';
const RESTRICTED_RE = /restricted/i;
// Only reachable with SCREEN_ALLOW_LLM on: without it the engine is always jev_only and no chat model is called.
const LLM_RESTRICTED_REMEDY = 'The Vercel team has restricted access to the language model this engine calls, and the gateway carries Jev only. Run: hermes -p resourcer config set SCREEN_ALLOW_LLM 0 and hermes -p resourcer config set SCREEN_ENGINE jev_only (or allow the model on the Vercel team). Screening resumes automatically.';

// Legacy sentinel values other code matches on.
const SENTINELS = {
  REASONS,
  MODEL_LABELS: { UNKNOWN: 'unknown', UNAVAILABLE: 'unavailable', ERROR: 'error', NONE: 'none' },
  MARKERS: { API_UNAVAILABLE: 'API_UNAVAILABLE', SCREENING_MODEL: 'SCREENING_MODEL:' },
};

const DEGRADED_FILE = path.join(paths.RUNTIME, 'screening-degraded.json');

function tcpProbe(host, port, timeoutMs) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok, detail) => { if (!done) { done = true; sock.destroy(); resolve({ ok, detail }); } };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true, ''));
    sock.once('timeout', () => finish(false, `timeout after ${timeoutMs}ms connecting to ${host}:${port}`));
    sock.once('error', e => finish(false, `${e.code || 'error'} connecting to ${host}:${port}`));
    sock.connect(port, host);
  });
}

// Legacy helper kept for callers that probe a local port.
function portOpen(port, timeoutMs, host) {
  return tcpProbe(host || '127.0.0.1', port, timeoutMs || 3000).then(r => r.ok);
}

function originParts(origin) {
  try {
    const u = new URL(origin);
    return { host: u.hostname, port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80) };
  } catch (e) {
    return null;
  }
}

const CANARY_SNIPPET = '1. Zed Canary Retail Cashier | Testville, <PC> Unlock candidate 0 applications in last 30 days Updated 2 days ago Recent experience Other CV snippets Retail Cashier Jan 2021 - Current Test Store Ltd Key Responsibilities Till operation, stock replenishment';

async function llmCanary(cfg, log, timeoutMs) {
  const client = new LlmClient({ cfg, log: () => {} });
  const models = [cfg.llm.model, cfg.llm.backupModel].filter(Boolean);
  const opts = { tierMode: cfg.tierMode, staleProfileClause: cfg.rubric.staleProfileClause, insufficientEvidence: cfg.rubric.insufficientEvidence, output: 'object' };
  const prompt = screening.rubric.buildBatchPrompt('Chef', 'M1', 20, [{ id: 'canary', snippet: CANARY_SNIPPET }], opts);
  const messages = [{ role: 'system', content: screening.rubric.SYSTEM_MESSAGE }, { role: 'user', content: prompt }];
  let lastErr = null;
  for (const model of models) {
    try {
      const r = await client.chat({ model, messages, schemaName: 'screening_decision', schema: screening.rubric.DECISION_SCHEMA, maxAttempts: 1, timeoutMs });
      const d = parseDecision(r.content);
      if (d.approved) return { ok: false, err: new InvalidAnswer('canary: an unrelated retail candidate was approved', 'canary_approved'), model };
      return { ok: true, model };
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpFailure && e.hard) break;
    }
  }
  return { ok: false, err: lastErr };
}

async function jevCanary(cfg, timeoutMs) {
  const client = new JevClient({ cfg, log: () => {} });
  const r = await client.evaluate({ searchRole: 'Chef', searchTier: screening.tiers.getRoleTier('Chef', cfg.tierMode), snippet: CANARY_SNIPPET, stage: 1, maxAttempts: 1, timeoutMs });
  if (!r.ok) return { ok: false, err: r.kind === 'invalid' ? new InvalidAnswer(r.message, r.code) : new HttpFailure(r.kind, r.message, { status: r.status }) };
  const dec = screening.decide.decide({ answers: r.answers, searchRole: 'Chef', searchTier: screening.tiers.getRoleTier('Chef', cfg.tierMode), stage: 1 }, cfg);
  if (dec.lane === 'approve') return { ok: false, err: new InvalidAnswer('canary: an unrelated retail candidate was approved', 'canary_approved') };
  return { ok: true };
}

function failFrom(err, fallbackKey) {
  const key = err instanceof HttpFailure ? reasonKeyOf(err) : (fallbackKey || 'error');
  return { key, detail: env.redact(String(err && err.message ? err.message : err)).slice(0, 300), status: (err && err.status) || null };
}

/**
 * @param {{deep?:boolean, timeoutMs?:number, cfg?:object}} [opts]
 * @returns {Promise<{ok:boolean, reason:string, ms:number, level:string, key:string|null, detail:string, engines:object, degraded:boolean}>}
 */
async function check(opts) {
  const o = opts || {};
  const t0 = Date.now();
  const res = (ok, key, detail, extra) => ({
    ok,
    reason: ok ? '' : REASONS[key],
    ms: Date.now() - t0,
    level: o.deep ? 'auth' : 'network',
    key: ok ? null : key,
    detail: ok ? '' : String(detail || ''),
    engines: {},
    degraded: false,
    ...(extra || {}),
  });
  try {
    const cfg = o.cfg || screening.loadConfig();
    if (!env.get('AI_GATEWAY_API_KEY')) return res(false, 'auth', 'AI_GATEWAY_API_KEY is not set');

    const parts = originParts(cfg.gateway.origin);
    if (!parts) return res(false, 'error', `invalid SCREEN_GATEWAY_ORIGIN ${String(cfg.gateway.origin).slice(0, 60)}`);
    const probeMs = Math.min(o.timeoutMs || cfg.health.probeTimeoutMs, cfg.health.probeTimeoutMs * 4);
    const reach = await tcpProbe(parts.host, parts.port, probeMs);
    if (!reach.ok) return res(false, 'unreachable', reach.detail);
    if (!o.deep) return res(true);

    // deep 1: key + balance
    try {
      await http.request('GET', `${cfg.gateway.origin}${cfg.health.creditsPath}`, {
        headers: { Authorization: `Bearer ${env.get('AI_GATEWAY_API_KEY')}` },
        timeoutMs: probeMs * 2, maxAttempts: 1, retry: cfg.retry,
      });
    } catch (e) {
      if (e instanceof HttpFailure && e.kind === 'request') {
        // the credits endpoint is not available for this key type: rely on the canary
      } else {
        const f = failFrom(e, 'unreachable');
        return res(false, f.key, f.detail);
      }
    }

    // deep 2: canary against the engine(s) that decide
    const canaryMs = o.timeoutMs && o.timeoutMs > probeMs ? o.timeoutMs : cfg.health.canaryTimeoutMs;
    const eff = cfg.engineEffective;
    const engines = {};
    if (eff === 'jev_only') {
      // the LLM is never contacted in this engine: not for the canary either
      const jevOnly = await jevCanary(cfg, canaryMs);
      engines.jev = jevOnly.ok ? { ok: true } : { ok: false, ...failFrom(jevOnly.err) };
      if (jevOnly.ok) return res(true, null, '', { engines, degraded: false });
      const restricted = engines.jev.key === 'auth' && engines.jev.status === 403 && RESTRICTED_RE.test(engines.jev.detail);
      return res(false, engines.jev.key, `jev canary failed: ${engines.jev.detail}`, { engines, ...(restricted ? { remedy: RESTRICTED_REMEDY } : {}) });
    }
    // both canaries at once: the supervisor gives the deep check 90 s in total
    const [llm, jev] = await Promise.all([
      llmCanary(cfg, () => {}, canaryMs),
      eff === 'jev' ? jevCanary(cfg, canaryMs) : Promise.resolve(null),
    ]);
    engines.llm = llm.ok ? { ok: true, model: llm.model } : { ok: false, ...failFrom(llm.err) };
    if (jev) engines.jev = jev.ok ? { ok: true } : { ok: false, ...failFrom(jev.err) };

    const decideOk = eff === 'jev' ? (llm.ok || jev.ok) : llm.ok;
    const degraded = eff === 'jev' && decideOk && !(llm.ok && jev.ok);
    try {
      if (degraded) fsx.writeJsonAtomic(DEGRADED_FILE, { degraded: true, engine: 'jev', since: new Date().toISOString(), detail: jev.ok ? 'LLM canary failing' : 'Jev canary failing; the LLM is deciding' });
      else if (eff === 'jev' && decideOk) fsx.safeUnlink(DEGRADED_FILE);
    } catch (e) { /* best effort */ }

    if (decideOk) return res(true, null, '', { engines, degraded });
    const bad = !llm.ok ? engines.llm : engines.jev;
    const llmRestricted = !llm.ok && bad.key === 'auth' && bad.status === 403 && RESTRICTED_RE.test(bad.detail);
    return res(false, bad.key, `${eff === 'jev' ? 'jev and llm' : 'llm'} canary failed: ${bad.detail}`, { engines, ...(llmRestricted ? { remedy: LLM_RESTRICTED_REMEDY } : {}) });
  } catch (e) {
    return res(false, 'error', `health check crashed: ${env.redact(String(e && e.message)).slice(0, 200)}`);
  }
}

// Legacy shape: { ok, level:'port'|'auth', reason:string|null, detail:string|null }. Default is deep,
// as before; new code should call check() and choose.
async function checkScreening(opts) {
  const o = opts || {};
  const r = await check({ deep: o.deep !== false, timeoutMs: o.timeoutMs });
  return { ok: r.ok, level: r.level === 'network' ? 'port' : 'auth', reason: r.ok ? null : r.reason, detail: r.ok ? null : r.detail };
}

module.exports = { check, checkScreening, portOpen, REASONS, REMEDIES, RESTRICTED_REMEDY, LLM_RESTRICTED_REMEDY, SENTINELS, CANARY_SNIPPET, DEGRADED_FILE };
