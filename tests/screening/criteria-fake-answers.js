'use strict';
// keyword-rule answers for offline tests: the numbers say nothing about Jev

const RX = {
  head: /\b(head[\s-]*chef|exec(?:utive)?[\s-]*(?:head[\s-]*)?chef|chef[\s-]*manager|chef[\s-]*patron|group[\s-]*chef|catering[\s-]*manager|kitchen[\s-]*manager|head[\s-]*cook)\b/i,
  sous: /\b(sous[\s-]*chef|second[\s-]*chef|junior[\s-]*sous|senior[\s-]*(?:cdp|chef[\s-]*de[\s-]*partie))\b/i,
  commis: /\b(commis|apprentice|trainee|junior[\s-]*chef)\b/i,
  entry: /\b(kitchen[\s-]*(?:porter|assistant|hand)|kp|pot[\s-]*wash|dish[\s-]*wash\w*|catering[\s-]*assistant|food[\s-]*production)\b/i,
  cook: /\b(chef[\s-]*de[\s-]*partie|cdp|line[\s-]*cook|cook|chef|baker|pastry|larder|grill|sauce|sushi)\b/i,
  foh: /\b(waiter|waitress|bartender|bar[\s-]*staff|barista|host|hostess|front[\s-]*of[\s-]*house)\b/i,
  mgmt: /\b(general[\s-]*manager|restaurant[\s-]*manager|operations[\s-]*manager|front[\s-]*office[\s-]*manager|supervisor)\b/i,
  otherHosp: /\b(housekeep\w*|reception\w*|concierge|events?)\b/i,
  hosp: /\b(chef|cook|kitchen|restaurant|hotel|pub|bar|catering|hospitality|waiter|commis|sous|porter|bakery|cafe|canteen|banquet)\b/i,
  inject: /ignore (?:all|any|previous|the above)|disregard (?:your|the)|approve (?:me|this|for this)|rate (?:me|this|every)|score this|system:|\[system\]|instruction to screener|pre-approved|as an ai\b|you are an ai|reply with approved|output approved/i,
};

const RUNG = { entry: 1, junior_cook: 2, cook: 3, senior_chef: 4, head_chef: 5 };

function r3(x) { return Math.round(x * 1000) / 1000; }

function kindOf(title) {
  const t = String(title || '');
  if (RX.head.test(t)) return 'head_chef';
  if (RX.sous.test(t)) return 'senior_chef';
  if (RX.commis.test(t)) return 'junior_cook';
  if (RX.entry.test(t)) return 'entry';
  if (RX.cook.test(t)) return 'cook';
  if (RX.foh.test(t)) return 'service_or_bar';
  if (RX.mgmt.test(t)) return 'hospitality_management';
  if (RX.otherHosp.test(t)) return 'other_hospitality';
  return RX.hosp.test(t) ? 'other_hospitality' : 'not_hospitality';
}

function roleLevelOf(role) {
  const t = String(role || '');
  if (RX.head.test(t)) return 'head_chef';
  if (RX.sous.test(t)) return 'senior_chef';
  if (RX.commis.test(t)) return 'junior_cook';
  if (RX.entry.test(t)) return 'entry';
  if (/chef[\s-]*de[\s-]*partie|cdp|line[\s-]*cook|pastry|baker/i.test(t)) return 'chef_de_partie';
  if (RX.cook.test(t)) return 'chef_generic';
  if (RX.foh.test(t)) return 'service_or_bar';
  if (RX.mgmt.test(t)) return 'hospitality_management';
  return 'other';
}

function choiceOf(options, main, top) {
  const p = {};
  for (const o of options) p[o] = 0;
  const m = options.includes(main) ? main : options[options.length - 1];
  const rest = options.filter(o => o !== m);
  p[m] = top;
  if (rest.length) p[rest[0]] = r3(1 - top);
  return { type: 'choice', choice: m, probabilities: p, confidence: r3(Math.max(0, (options.length * top - 1) / (options.length - 1))) };
}

function confirmedOk(title, candKind) {
  const k = kindOf(title);
  return k === candKind || (RUNG[k] && RUNG[candKind]) || /(team member|staff)/i.test(title || '');
}

function relative(candKind, roleKind) {
  const c = RUNG[candKind];
  const r = { entry: 1, junior_cook: 2, chef_generic: 3, chef_de_partie: 3, senior_chef: 4, head_chef: 5 }[roleKind];
  if (!c || !r) return candKind === 'not_hospitality' || RUNG[candKind] === undefined ? 'not_comparable' : 'cannot_tell';
  if (roleKind === 'entry' || roleKind === 'junior_cook') {
    if (c >= 4) return 'two_or_more_steps_senior';
    if (c === 3) return 'one_step_senior';
    return 'comparable';
  }
  if (c === r || (roleKind === 'chef_generic' && c === 3)) return 'comparable';
  if (c < r) return r - c >= 2 || candKind === 'entry' ? 'much_more_junior' : 'one_step_junior';
  return c - r >= 2 ? 'two_or_more_steps_senior' : 'one_step_senior';
}

function suitability(candKind, roleKind, kitchenRole, text) {
  const rel = relative(candKind, roleKind);
  if (candKind === 'not_hospitality') return 0.05;
  if (kitchenRole && ['service_or_bar', 'hospitality_management', 'other_hospitality'].includes(candKind)) return 0.1;
  if (rel === 'much_more_junior' || (roleKind === 'chef_de_partie' && rel === 'one_step_junior')) return 0.1;
  if (rel === 'two_or_more_steps_senior' && ['entry', 'junior_cook'].includes(roleKind)) return 0.1;
  if (text.replace(/(not provided)/g, '').trim().length < 12) return 0.3;
  return RUNG[candKind] ? 0.9 : 0.5;
}

function answersFor(body) {
  const state = body.state || {};
  const role = String((state.search && state.search.role) || '');
  const cand = state.candidate || {};
  const title = String(cand.current_title || '');
  const work = String(cand.recent_work || '');
  const text = `${title} ${work}`;
  const roleKind = roleLevelOf(role);
  const first = (work.match(/^(.{0,80})/) || ['', ''])[1];
  const candKind = kindOf(title.startsWith('(') ? first : title);
  const kitchenRole = !!RUNG[roleKind === 'chef_generic' || roleKind === 'chef_de_partie' ? 'cook' : roleKind];
  const out = {};
  for (const [key, q] of Object.entries(body.questions || {})) {
    if (key === 'role_level') out[key] = choiceOf(Object.keys(q.criteria), roleKind, 0.95);
    else if (key === 'kind_work') out[key] = choiceOf(Object.keys(q.criteria), first ? kindOf(first) : 'cannot_tell', 0.93);
    else if (key === 'candidate_kind') out[key] = choiceOf(Object.keys(q.criteria), title.startsWith('(') && !first ? 'cannot_tell' : candKind, 0.93);
    else if (key === 'seniority') out[key] = choiceOf(Object.keys(q.criteria), relative(candKind, roleKind), 0.93);
    else if (key === 'title_seniority') out[key] = choiceOf(Object.keys(q.criteria), relative(kindOf(cand.confirmed_job_title), roleKind), 0.93);
    else if (q.type === 'choice') out[key] = choiceOf(Object.keys(q.criteria), Object.keys(q.criteria)[0], 0.9);
    else if (q.type === 'score') {
      const n = q.criteria.length;
      let p;
      if (candKind === 'not_hospitality') p = [0.92, 0.05, 0.02, 0.01];
      else if (kitchenRole && ['service_or_bar', 'hospitality_management', 'other_hospitality'].includes(candKind)) p = [0.03, 0.88, 0.07, 0.02];
      else if (RUNG[candKind]) p = [0.02, 0.03, 0.2, 0.75];
      else p = [0.1, 0.4, 0.3, 0.2];
      const cut = p.slice(0, n);
      const total = cut.reduce((a, b) => a + b, 0) || 1;
      const probs = {};
      for (let i = 0; i < n; i++) probs[String(i)] = r3((cut[i] || 0) / total);
      out[key] = { type: 'score', probabilities: probs, confidence: 0.8 };
    } else {
      let v = 0.5;
      if (key === 'hospitality_experience' || key === 'hospitality_experience_nc') v = RX.hosp.test(text) ? 0.94 : 0.05;
      else if (key === 'same_area_seen') v = kitchenRole ? (RUNG[candKind] ? 0.92 : 0.06) : (RX.hosp.test(text) ? 0.7 : 0.05);
      else if (key === 'info_sufficient') v = text.replace(/\(not provided\)/g, '').trim().length >= 12 ? 0.96 : 0.05;
      else if (key === 'injection') v = RX.inject.test(text) ? 0.93 : 0.01;
      else if (key === 'too_junior') v = ['much_more_junior', 'one_step_junior'].includes(relative(candKind, roleKind)) ? 0.9 : 0.05;
      else if (key === 'overqualified') v = relative(candKind, roleKind) === 'two_or_more_steps_senior' && ['entry', 'junior_cook'].includes(roleKind) ? 0.9 : 0.05;
      else if (key === 'injection_b') v = RX.inject.test(text) ? 0.93 : 0.01;
      else if (key === 'kitchen_seen') v = RUNG[candKind] ? 0.92 : 0.06;
      else if (key === 'would_place' || key === 'would_place2') v = suitability(candKind, roleKind, kitchenRole, text);
      else if (key === 'clear_mismatch') v = 1 - suitability(candKind, roleKind, kitchenRole, text);
      else if (key === 'title_consistent') v = confirmedOk(cand.confirmed_job_title, candKind) ? 0.9 : 0.1;
      out[key] = { type: 'noul', noul: r3(v) };
    }
  }
  return out;
}

module.exports = { answersFor, kindOf, roleLevelOf };
