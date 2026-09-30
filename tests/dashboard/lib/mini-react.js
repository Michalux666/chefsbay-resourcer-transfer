'use strict';
/**
 * A tiny React-compatible renderer for tests: createElement + hooks (useState, useEffect, useRef, useMemo,
 * useCallback) + a synchronous "render to a plain tree". No DOM. Not a general React clone: just enough to drive
 * the dashboard plugin and inspect what it would put on the page.
 */

function flatten(list, out) {
  for (const c of list) {
    if (Array.isArray(c)) flatten(c, out);
    else if (c !== null && c !== undefined && c !== false && c !== true) out.push(c);
  }
  return out;
}

function createElement(type, props, ...children) {
  const p = props || {};
  return { $$el: true, type, props: p, children: flatten(children, []), key: p.key };
}

function depsChanged(a, b) {
  if (!a || !b) return true;
  if (a.length !== b.length) return true;
  return a.some((v, i) => !Object.is(v, b[i]));
}

function create() {
  let current = null; // instance being rendered
  let hookIndex = 0;
  let pendingEffects = [];
  const instances = new Map();
  const root = { dirty: false, tree: null, mounted: true, renders: 0 };
  let rootFn = null;
  let rootProps = null;

  function inst(key) {
    let i = instances.get(key);
    if (!i) { i = { key, state: [], effects: [], refs: [], memo: [], mounted: true }; instances.set(key, i); }
    i.seen = true;
    return i;
  }

  const hooks = {
    useState(initial) {
      const i = current; const idx = hookIndex++;
      if (!(idx in i.state)) i.state[idx] = typeof initial === 'function' ? initial() : initial;
      const set = (v) => {
        if (!i.mounted) return;
        const next = typeof v === 'function' ? v(i.state[idx]) : v;
        if (!Object.is(next, i.state[idx])) { i.state[idx] = next; root.dirty = true; }
      };
      return [i.state[idx], set];
    },
    useEffect(fn, deps) {
      const i = current; const idx = hookIndex++;
      const prev = i.effects[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        pendingEffects.push(() => {
          if (prev && prev.cleanup) prev.cleanup();
          const rec = { deps, cleanup: null };
          i.effects[idx] = rec;
          const c = fn();
          if (typeof c === 'function') rec.cleanup = c;
        });
        if (!prev) i.effects[idx] = { deps, cleanup: null };
      }
    },
    useRef(initial) {
      const i = current; const idx = hookIndex++;
      if (!(idx in i.refs)) i.refs[idx] = { current: initial };
      return i.refs[idx];
    },
    useMemo(fn, deps) {
      const i = current; const idx = hookIndex++;
      const prev = i.memo[idx];
      if (!prev || depsChanged(prev.deps, deps)) i.memo[idx] = { deps, value: fn() };
      return i.memo[idx].value;
    },
    useCallback(fn, deps) {
      return hooks.useMemo(() => fn, deps);
    },
  };

  function expand(node, path) {
    if (node === null || node === undefined || node === false || node === true) return [];
    if (typeof node === 'string' || typeof node === 'number') return [String(node)];
    if (Array.isArray(node)) return node.flatMap((n, i) => expand(n, `${path}[${i}]`));
    if (typeof node.type === 'function') {
      const key = `${path}/${node.type.name || 'anon'}${node.key !== undefined ? `#${node.key}` : ''}`;
      const i = inst(key);
      const prevCurrent = current; const prevIndex = hookIndex;
      current = i; hookIndex = 0;
      let out;
      try { out = node.type({ ...node.props, children: node.children }); } finally { current = prevCurrent; hookIndex = prevIndex; }
      return expand(out, key);
    }
    const kids = node.children.flatMap((c, idx) => expand(c, `${path}/${node.type}${node.key !== undefined ? `#${node.key}` : ''}.${idx}`));
    return [{ type: node.type, props: node.props, children: kids }];
  }

  function renderOnce() {
    for (const i of instances.values()) i.seen = false;
    pendingEffects = [];
    root.dirty = false;
    root.renders++;
    const out = expand({ $$el: true, type: rootFn, props: rootProps || {}, children: [] }, 'root');
    root.tree = out.length === 1 ? out[0] : { type: 'fragment', props: {}, children: out };
    for (const [k, i] of [...instances]) {
      if (!i.seen) {
        i.mounted = false;
        for (const e of i.effects) if (e && e.cleanup) e.cleanup();
        instances.delete(k);
      }
    }
    const effects = pendingEffects; pendingEffects = [];
    for (const run of effects) run();
  }

  root.render = renderOnce;
  root.mount = (fn, props) => { rootFn = fn; rootProps = props; renderOnce(); return root; };
  root.settle = async () => {
    let quiet = 0;
    for (let n = 0; n < 60 && quiet < 3; n++) {
      await new Promise((r) => setImmediate(r));
      if (root.dirty) { renderOnce(); quiet = 0; } else quiet++;
    }
    if (root.dirty) renderOnce();
  };
  root.unmount = () => {
    root.mounted = false;
    for (const i of instances.values()) { i.mounted = false; for (const e of i.effects) if (e && e.cleanup) e.cleanup(); }
    instances.clear();
  };
  root.hooks = hooks;
  root.React = { createElement };
  return root;
}

// ------------------------------------------------------------------ inspection helpers

function walk(node, fn) {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') { fn(node); return; }
  fn(node);
  for (const c of node.children || []) walk(c, fn);
}

function textOf(node) {
  const parts = [];
  walk(node, (n) => { if (typeof n === 'string') parts.push(n); });
  return parts.join('');
}

function findAll(node, pred) {
  const out = [];
  walk(node, (n) => { if (typeof n !== 'string' && pred(n)) out.push(n); });
  return out;
}

function find(node, pred) {
  return findAll(node, pred)[0] || null;
}

const byText = (type, text) => (n) => n.type === type && textOf(n).includes(text);

module.exports = { create, createElement, walk, textOf, findAll, find, byText };
