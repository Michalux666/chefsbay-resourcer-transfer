'use strict';
// Small concurrency helpers (no dependencies).

// At most `n` functions in flight; the rest wait in FIFO order. Tracks the high-water mark for tests.
class Limiter {
  constructor(n) {
    this.n = Math.max(1, n | 0);
    this.active = 0;
    this.maxActive = 0;
    this.queue = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      const go = () => {
        this.active++;
        if (this.active > this.maxActive) this.maxActive = this.active;
        Promise.resolve().then(fn).then(resolve, reject).finally(() => {
          this.active--;
          const next = this.queue.shift();
          if (next) next();
        });
      };
      if (this.active < this.n) go();
      else this.queue.push(go);
    });
  }
}

// Run fn(i) for i in [0, count) with `concurrency` workers. Stops taking new indexes once
// shouldStop() is true. fn must not throw (it should record its own outcome).
async function mapPool(count, concurrency, fn, shouldStop) {
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (shouldStop && shouldStop()) return;
      const i = next++;
      if (i >= count) return;
      await fn(i);
    }
  };
  const workers = [];
  for (let w = 0; w < Math.min(Math.max(1, concurrency), Math.max(1, count)); w++) workers.push(worker());
  await Promise.all(workers);
}

// Resolves when `promise` settles or after `ms`, whichever is first. Never rejects; clears its timer.
function settleWithin(promise, ms) {
  return new Promise(resolve => {
    const t = setTimeout(resolve, Math.max(0, ms));
    Promise.resolve(promise).then(() => { clearTimeout(t); resolve(); }, () => { clearTimeout(t); resolve(); });
  });
}

module.exports = { Limiter, mapPool, settleWithin };
