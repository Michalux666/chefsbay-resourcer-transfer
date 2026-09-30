'use strict';
// Error classes shared by the screening modules. Classification is by CLASS, never by message regex.

// kind: 'auth' (401/403), 'credits' (402), 'transient' (network, timeout, 408, 429, 5xx after
// retries), 'request' (400/404/422: our request is wrong), 'invalid' (a 2xx answer we cannot use),
// 'aborted' (the caller cancelled).
class HttpFailure extends Error {
  constructor(kind, message, extra) {
    super(message);
    this.name = 'HttpFailure';
    this.kind = kind;
    this.status = (extra && extra.status) || null;
    this.attempts = (extra && extra.attempts) || 0;
    this.retryAfterMs = (extra && extra.retryAfterMs) || null;
  }
  get hard() { return this.kind === 'auth' || this.kind === 'credits'; }
}

// A model answer that arrived but cannot be used (malformed JSON, wrong shape, missing fields).
class InvalidAnswer extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'InvalidAnswer';
    this.kind = 'invalid';
    this.code = code || 'invalid';
  }
}

// No engine could answer. The CLI turns this into API_UNAVAILABLE / exit 3.
class ScreeningUnavailable extends Error {
  constructor(detail, extra) {
    super(detail);
    this.name = 'ScreeningUnavailable';
    this.detail = detail;
    this.reasonKey = (extra && extra.reasonKey) || 'error';
    this.engines = (extra && extra.engines) || [];
    this.status = (extra && extra.status) || null;
  }
}

// Bad CLI flags, unreadable input: exit 1.
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

// The fixed reason key (see screening-health.js REASONS) for a failure.
function reasonKeyOf(err) {
  if (!err) return 'error';
  if (err.kind === 'auth') return 'auth';
  if (err.kind === 'credits') return 'credits';
  if (err.kind === 'transient') return err.status ? 'error' : 'unreachable';
  return 'error';
}

module.exports = { HttpFailure, InvalidAnswer, ScreeningUnavailable, UsageError, reasonKeyOf };
