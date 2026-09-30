'use strict';
// The normal-LLM client: POST {origin}/v1/chat/completions on the AI Gateway with a strict
// json_schema response format. Model comes from configuration (SCREEN_LLM_MODEL). No temperature is
// sent to the 5.x models (the gateway catalog marks it unsupported); never logged: key, snippets.

const env = require('../env');
const http = require('./http');
const { HttpFailure, InvalidAnswer } = require('./errors');

const FOUR_X = /claude-(sonnet|opus|haiku)-4/i;

function apiKey() {
  const k = env.get('AI_GATEWAY_API_KEY');
  if (!k) throw new HttpFailure('auth', 'AI_GATEWAY_API_KEY is not set');
  return k;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : ''))).join('\n');
  }
  return null;
}

// Extract the first JSON value from model text: whole text, a fenced block, or the first balanced
// object/array inside surrounding prose. Throws InvalidAnswer when nothing parses.
function parseJsonLoose(text) {
  const t = String(text == null ? '' : text).replace(/^\uFEFF/, '').trim();
  if (!t) throw new InvalidAnswer('empty model output', 'empty');
  try { return JSON.parse(t); } catch (e) { /* fall through */ }
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (e) { /* fall through */ }
  }
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch !== '{' && ch !== '[') continue;
    const end = balancedEnd(t, i);
    if (end > i) {
      try { return JSON.parse(t.slice(i, end + 1)); } catch (e) { /* try the next opener */ }
    }
  }
  throw new InvalidAnswer('model output is not valid JSON', 'not_json');
}

function balancedEnd(t, start) {
  const open = t[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === String.fromCharCode(92)) esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

class LlmClient {
  /**
   * @param {{cfg:object, log?:(line:string)=>void, rng?:()=>number}} deps
   */
  constructor(deps) {
    // the one place every chat-completions request goes through: config.load already forces jev_only, this is the second lock
    if (!deps.cfg || !deps.cfg.allowLlm) throw new Error('a language model is not allowed through the AI Gateway (SCREEN_ALLOW_LLM is not set)');
    this.cfg = deps.cfg;
    this.log = deps.log || (() => {});
    this.rng = deps.rng;
  }

  /**
   * One chat completion with structured output. Transport retries happen inside; a 2xx answer that
   * is unusable (finish_reason not stop, refusal, no content) throws InvalidAnswer.
   * @returns {Promise<{content:string, model:string, usage:object|null, ms:number, attempts:number}>}
   */
  async chat({ model, messages, schemaName, schema, signal, maxAttempts, timeoutMs, maxTokens, label }) {
    const cfg = this.cfg;
    const body = {
      model,
      max_tokens: maxTokens || cfg.llm.maxTokens,
      messages,
      response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
    };
    if (FOUR_X.test(model)) body.temperature = 0;
    if (cfg.llm.reasoningEffort) body.reasoning = { effort: cfg.llm.reasoningEffort };
    if (cfg.llm.zeroDataRetention) body.providerOptions = { gateway: { zeroDataRetention: true } };

    const res = await http.request('POST', `${cfg.gateway.origin}/v1/chat/completions`, {
      headers: { Authorization: `Bearer ${apiKey()}`, 'User-Agent': 'chefsbay-resourcer-screening/1' },
      body,
      timeoutMs: timeoutMs || cfg.llm.timeoutMs,
      maxAttempts: maxAttempts || cfg.llm.maxAttempts,
      retry: cfg.retry,
      signal,
      log: this.log,
      label: label || 'LLM',
      rng: this.rng,
    });

    const choice = res.json && Array.isArray(res.json.choices) ? res.json.choices[0] : null;
    if (!choice) throw new InvalidAnswer('no choices in completion', 'no_choices');
    const msg = choice.message || {};
    if (msg.refusal) throw new InvalidAnswer('model refused', 'refusal');
    if (choice.finish_reason && choice.finish_reason !== 'stop') throw new InvalidAnswer(`finish_reason ${String(choice.finish_reason).slice(0, 30)}`, 'finish_reason');
    const content = textOf(msg.content);
    if (typeof content !== 'string' || !content.trim()) throw new InvalidAnswer('no content in completion', 'no_content');
    return { content, model: res.json.model || model, usage: res.json.usage || null, ms: res.ms, attempts: res.attempts };
  }
}

module.exports = { LlmClient, parseJsonLoose, apiKey };
