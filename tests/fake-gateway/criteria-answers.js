'use strict';

const { answersFor, kindOf } = require('../screening/criteria-fake-answers');

const KIND_OF_TIER = {
  entry_kp: 'entry', commis: 'junior_cook', cdp_cook: 'cook', sous: 'senior_chef', head: 'head_chef',
  front_of_house: 'service_or_bar', management_non_kitchen: 'hospitality_management', unrelated: 'not_hospitality', not_stated: 'cannot_tell', unclear: 'cannot_tell',
};

const has = (toks, n) => toks.some(t => t.name === n);
const argOf = (toks, n) => { const t = toks.find(x => x.name === n); return t ? t.arg : undefined; };

function certain(options, main) {
  const p = {};
  for (const o of options) p[o] = 0;
  const m = options.includes(main) ? main : options[options.length - 1];
  p[m] = 0.97;
  const other = options.find(o => o !== m);
  if (other) p[other] = 0.03;
  return { type: 'choice', choice: m, probabilities: p, confidence: 0.95 };
}

function spread(options, weights) {
  const p = {};
  for (const o of options) p[o] = weights[o] || 0;
  const top = Object.entries(p).sort((a, b) => b[1] - a[1])[0][0];
  return { type: 'choice', choice: top, probabilities: p, confidence: 0.1 };
}

// the scenario tokens of the shared fake gateway, mapped onto the criteria-driven questions; the keyword answers are the default
function answersForTokens(body, toks) {
  const answers = answersFor(body);
  const q = body.questions || {};
  const cand = (body.state && body.state.candidate) || {};
  if (!cand.recent_work && !cand.current_title) return answers;
  const kindOpts = q.candidate_kind ? Object.keys(q.candidate_kind.criteria) : [];
  const senOpts = q.seniority ? Object.keys(q.seniority.criteria) : [];
  const titleOpts = q.title_seniority ? Object.keys(q.title_seniority.criteria) : [];
  const set = (key, v) => { if (q[key]) answers[key] = v; };
  const noul = v => ({ type: 'noul', noul: v });
  const policy = fit => { set('would_place', noul(fit)); set('would_place2', noul(fit)); set('clear_mismatch', noul(Math.round((1 - fit) * 1000) / 1000)); };

  const tier = argOf(toks, 'TIER');
  const rtier = argOf(toks, 'RTIER');
  if (has(toks, 'APPROVE')) {
    set('candidate_kind', certain(kindOpts, 'cook'));
    set('kind_work', certain(kindOpts, 'cook'));
    set('seniority', certain(senOpts, 'comparable'));
    set('hospitality_experience', noul(0.95));
    set('same_area_seen', noul(0.95));
    policy(0.9);
    set('too_junior', noul(0.03));
    set('overqualified', noul(0.03));
    set('title_seniority', certain(titleOpts, 'comparable'));
    set('title_consistent', noul(0.95));
    set('relevance', { type: 'score', probabilities: { 0: 0, 1: 0.02, 2: 0.1, 3: 0.88 }, confidence: 0.9 });
  } else if (has(toks, 'REJECT')) {
    set('candidate_kind', certain(kindOpts, 'not_hospitality'));
    set('kind_work', certain(kindOpts, 'not_hospitality'));
    set('seniority', certain(senOpts, 'not_comparable'));
    set('hospitality_experience', noul(0.03));
    set('same_area_seen', noul(0.02));
    set('title_seniority', certain(titleOpts, 'not_comparable'));
    set('title_consistent', noul(0.95));
    policy(0.05);
    set('relevance', { type: 'score', probabilities: { 0: 0.95, 1: 0.03, 2: 0.01, 3: 0.01 }, confidence: 0.9 });
  } else if (has(toks, 'LOWCONF')) {
    set('candidate_kind', spread(kindOpts, { entry: 0.4, cook: 0.3, service_or_bar: 0.3 }));
    set('kind_work', spread(kindOpts, { entry: 0.4, cook: 0.3, service_or_bar: 0.3 }));
    set('seniority', spread(senOpts, { much_more_junior: 0.4, comparable: 0.3, not_comparable: 0.3 }));
    set('relevance', { type: 'score', probabilities: { 0: 0.1, 1: 0.4, 2: 0.4, 3: 0.1 }, confidence: 0.1 });
    policy(0.5);
    set('same_area_seen', noul(0.5));
    set('title_seniority', spread(Object.keys((q.title_seniority || q.seniority).criteria), { much_more_junior: 0.4, comparable: 0.3, not_comparable: 0.3 }));
  } else if (tier && KIND_OF_TIER[tier]) {
    set('candidate_kind', certain(kindOpts, KIND_OF_TIER[tier]));
    set('kind_work', certain(kindOpts, KIND_OF_TIER[tier]));
  }
  if (rtier && KIND_OF_TIER[rtier] && q.title_seniority) {
    const asKind = KIND_OF_TIER[rtier];
    const probe = answersFor({ ...body, state: { ...body.state, candidate: { ...cand, confirmed_job_title: { entry: 'Kitchen Porter', junior_cook: 'Commis Chef', cook: 'Chef de Partie', senior_chef: 'Sous Chef', head_chef: 'Head Chef', service_or_bar: 'Waiter', hospitality_management: 'General Manager', not_hospitality: 'Retail Assistant', cannot_tell: 'Team Member' }[asKind] } } });
    answers.title_seniority = probe.title_seniority;
  }
  if (has(toks, 'INJECT')) set('injection', noul(0.9));
  if (has(toks, 'NOINFO')) {
    set('info_sufficient', noul(0.1));
    set('candidate_kind', certain(kindOpts, 'cannot_tell'));
    set('kind_work', certain(kindOpts, 'cannot_tell'));
  }
  if (has(toks, 'MISMATCH')) set('title_consistent', noul(0.1));
  if (has(toks, 'MALFORMED')) delete answers.relevance;
  if (has(toks, 'BADCHOICE') && answers.seniority) answers.seniority.choice = 'not_an_option';
  if (has(toks, 'NOPROBS') && answers.seniority) { answers.seniority.probabilities = {}; answers.seniority.confidence = 0; }
  return answers;
}

module.exports = { answersForTokens, kindOf };
