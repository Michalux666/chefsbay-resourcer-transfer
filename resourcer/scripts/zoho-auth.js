'use strict';
/**
 * zoho-auth.js - shared Zoho OAuth credential manager
 */

const fs = require('fs');
const fsx = require('./lib/fsx');
const env = require('./lib/env');
const { fetchWithTimeout } = require('./fetch-with-timeout');
const { CREDS_PATH, RECRUIT_BASE } = require('./constants');

const TOKEN_URL = 'https://accounts.zoho.eu/oauth/v2/token';

let _creds = null;
let _refreshing = null;

function loadCreds() {
  if (!_creds) _creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  return _creds;
}

async function refreshToken() {
  if (_refreshing) return _refreshing;

  _refreshing = (async () => {
    const c = loadCreds();
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: c.client_id,
      client_secret: c.client_secret,
      refresh_token: c.refresh_token,
    });

    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetchWithTimeout(TOKEN_URL, { method: 'POST', body: params }, 30000);
        const data = await res.json();
        // only the error name: an error body may echo the request (client secret, refresh token)
        if (!data.access_token) throw new Error(`No access_token: ${String((data && (data.error || data.code || data.message)) || 'unknown error').slice(0, 80)}`);
        _creds.access_token = data.access_token;
        // Atomic + owner-only: several processes refresh and read this file.
        fsx.writeJsonAtomic(CREDS_PATH, _creds, 0o600);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < 3) {
          const delay = attempt * 3000;
          console.log(`    [auth] Token refresh attempt ${attempt} failed - retrying in ${delay / 1000}s: ${env.redact(err.message)}`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    throw lastErr;
  })();

  try {
    await _refreshing;
  } finally {
    _refreshing = null;
  }
}

async function zohoRequestRaw(method, urlPath, opts = {}) {
  const { body, headers = {}, retry = true, timeoutMs = 30000, absoluteUrl = false } = opts;
  const c = loadCreds();
  const url = absoluteUrl ? urlPath : `${RECRUIT_BASE}/recruit/v2${urlPath}`;
  const req = {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${c.access_token}`,
      ...headers,
    },
  };

  if (body !== undefined) req.body = body;

  const res = await fetchWithTimeout(url, req, timeoutMs);
  if (res.status === 401 && retry) {
    await refreshToken();
    return zohoRequestRaw(method, urlPath, { ...opts, retry: false });
  }
  return res;
}

async function zohoRequest(method, urlPath, body, retry = true, timeoutMs = 30000) {
  const headers = body === undefined ? {} : { 'Content-Type': 'application/json' };
  const rawBody = body === undefined ? undefined : JSON.stringify(body);
  const res = await zohoRequestRaw(method, urlPath, { body: rawBody, headers, retry, timeoutMs });
  return res.json();
}

module.exports = { loadCreds, refreshToken, zohoRequest, zohoRequestRaw, RECRUIT_BASE };
