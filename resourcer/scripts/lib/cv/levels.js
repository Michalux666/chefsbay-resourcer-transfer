'use strict';
// The level of the SEARCHED role, inferred by Jev from its title with one question (a Choice) and remembered per distinct
// title in state/cv-search-levels.json, so a new title costs one request and every later CV of that search costs none. The
// probabilities are stored, not a verdict, and the gate uses the whole distribution (an unsure level is a mixture of the rules
// of the levels it might be, not a guess), so no threshold is needed and no new request is needed to change anything. An owner
// override in config (searchLevelOverrides) wins over Jev. An answer of 'unclear' is the level 'unknown', for which the rules
// that need a level (over- and under-qualification) are off.

const Q = require('./questions');
const { ask } = require('./jev');
const { titleKey } = require('./cache');

const r3 = x => Math.round(x * 1000) / 1000;

function argmax(p) {
  let best = null;
  for (const [k, v] of Object.entries(p)) if (best === null || v > p[best]) best = k;
  return best;
}

/** @returns {{level:string, p:number, dist:Object<string,number>}} the most likely level, its probability and the whole distribution */
function decideLevel(cfg, probs) {
  const dist = {};
  let total = 0;
  for (const [k, v] of Object.entries(probs || {})) {
    const key = k === 'unclear' || !cfg.levels[k] ? 'unknown' : k;
    const p = Number(v) || 0;
    dist[key] = (dist[key] || 0) + p;
    total += p;
  }
  if (total <= 0) return { level: 'unknown', p: 0, dist: { unknown: 1 } };
  for (const k of Object.keys(dist)) dist[k] = r3(dist[k] / total);
  const top = argmax(dist);
  return { level: top, p: dist[top], dist };
}

/**
 * @param {{cfg:object, jev:object, searchRole:string, store:object, signal?:AbortSignal, log?:Function}} o
 * @returns {Promise<{level:string, p:number, dist:object, source:'override'|'cache'|'jev'|'invalid', model:string|null, calls:number}>}
 * @throws ScreeningUnavailable when Jev cannot answer
 */
async function resolveSearchLevel(o) {
  const { cfg, jev, searchRole, store } = o;
  const override = cfg.searchLevelOverrides[titleKey(searchRole)];
  if (override) return { level: override, p: 1, dist: { [override]: 1 }, source: 'override', model: null, calls: 0 };

  const hit = store.get(searchRole);
  if (hit && hit.p) return { ...decideLevel(cfg, hit.p), source: 'cache', model: hit.model || null, calls: 0 };

  const req = Q.buildSearchLevelRequest(cfg, searchRole);
  const shape = Q.expectedShape(req.questions);
  const r = await ask(jev, { state: req.state, questions: req.questions, shape }, cfg, o.signal, 'search level');
  if (!r.ok) return { level: 'unknown', p: 0, dist: { unknown: 1 }, source: 'invalid', model: null, calls: 1 };
  const probs = {};
  for (const [k, v] of Object.entries(r.answers.search_level.p)) probs[k] = r3(v);
  store.put(searchRole, { p: probs, model: r.meta.model });
  return { ...decideLevel(cfg, probs), source: 'jev', model: r.meta.model, calls: 1 };
}

module.exports = { resolveSearchLevel, decideLevel };
