#!/usr/bin/env node
'use strict';

// Browser-proxy for Reed BFF API calls. api.reed.co.uk needs the Cloudflare cf_clearance cookie and a live logged-in tab, so
// every request runs inside that tab via CDP Runtime.evaluate on the persistent Reed browser (127.0.0.1:<REED_CDP_PORT>).
// Usage: const { reedBrowserFetch, reedBrowserFetchPost, reedBrowserFetchBinary } = require('./reed-browser-fetch');

const { API_BASE } = require('./reed-api-client');
const { CdpConn, getCdpTabs, pickReedTab } = require('./reed-refresh-token');
const launcher = require('./ensure-chrome-cdp');
const env = require('./lib/env');

const SEND_TIMEOUT_MS = 60000;

function log(msg) { process.stderr.write(`[reed-browser-fetch] ${msg}\n`); }

// ---------------------------------------------------------------- tab discovery

async function findReedTab() {
  const tab = pickReedTab(await getCdpTabs());
  return tab ? tab.webSocketDebuggerUrl : null;
}

// One relaunch attempt per process when the browser died mid-run (for example killed by the OOM killer).
let relaunchAttempted = false;
async function locateReedTab() {
  let lastErr = null;
  try {
    const url = await findReedTab();
    if (url) return url;
  } catch (e) {
    lastErr = e;
  }
  if (!relaunchAttempted && env.get('REED_AUTO_RELAUNCH', '1') !== '0') {
    relaunchAttempted = true;
    const r = await launcher.ensureChrome({ ensureReedTab: true });
    log(`Reed browser relaunch: ${r.marker}`);
    if (r.ok) {
      try {
        const url = await findReedTab();
        if (url) return url;
      } catch (e) {
        lastErr = e;
      }
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

// ---------------------------------------------------------------- persistent CDP connection

let conn = null;
let connUrl = null;

async function connectCdp(wsUrl) {
  if (conn && connUrl === wsUrl && conn.ws && conn.ws.readyState === 1) return;
  closeCdp();
  const c = new CdpConn(wsUrl);
  await c.open(5000);
  conn = c;
  connUrl = wsUrl;
  log('CDP connected');
}

async function cdpEvaluate(expression) {
  if (!conn || !conn.ws || conn.ws.readyState !== 1) throw new Error('CDP not connected');
  const result = await conn.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, timeout: 30000,
  }, SEND_TIMEOUT_MS);
  if (result && result.exceptionDetails) {
    const exc = result.exceptionDetails;
    throw new Error(`JS exception: ${(exc.exception && exc.exception.description) || exc.text || 'unknown'}`);
  }
  return result && result.result ? result.result.value : undefined;
}

function closeCdp() {
  if (conn) {
    conn.close();
    conn = null;
    connUrl = null;
  }
}

// ---------------------------------------------------------------- session

// Token priority: window.__capturedReedToken, then reed-session.json if valid, then a fresh navigate-capture via getToken().
// (Not refreshToken(): Reed issues no refresh token. Bug fix 2026-06-17, recurring Pool-0.)
async function ensureBrowserSession() {
  const wsUrl = await locateReedTab();
  if (!wsUrl) {
    throw new Error('No Reed browser tab found. Run: node scripts/ensure-chrome-cdp.js --ensure-reed-tab and make sure the Reed session is logged in.');
  }
  await connectCdp(wsUrl);
  const tokenCheck = await cdpEvaluate("window.__capturedReedToken ? 'ok' : 'missing'");
  if (tokenCheck === 'ok') return true;

  const { isTokenValid, loadSession, getToken } = require('./reed-api-client');
  const session = loadSession();
  if (session && isTokenValid(session)) {
    await cdpEvaluate(`window.__capturedReedToken = ${JSON.stringify(session.accessToken)}`);
    log('Token seeded from reed-session.json');
    return true;
  }

  log('Session file token expired or missing - capturing fresh token via getToken (browser CDP)...');
  try {
    const freshToken = await getToken();
    await cdpEvaluate(`window.__capturedReedToken = ${JSON.stringify(freshToken)}`);
    log('Token refreshed and seeded into browser');
    return true;
  } catch (e) {
    log(`Token refresh failed: ${e.message}`);
  }

  const tokenCheck2 = await cdpEvaluate("window.__capturedReedToken ? 'ok' : 'missing'");
  if (tokenCheck2 !== 'ok') {
    log('WARNING: No valid token available. Log in again with: node scripts/cdp-reed-full-login.js');
  }
  return true;
}

// ---------------------------------------------------------------- public API

async function browserJson(url, method, bodyJson, label) {
  const expression = `
    (function() {
      const tok = window.__capturedReedToken || '';
      ${bodyJson ? `const bodyStr = ${JSON.stringify(bodyJson)};` : ''}
      return fetch(${JSON.stringify(url)}, {
        ${method === 'POST' ? "method: 'POST'," : ''}
        headers: {
          'Authorization': 'Bearer ' + tok,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }${bodyJson ? ',\n        body: bodyStr' : ''}
      }).then(function(r) {
        return r.text().then(function(t) {
          return JSON.stringify({status: r.status, body: t});
        });
      }).catch(function(e) {
        return JSON.stringify({error: e.message});
      });
    })()
  `;
  const raw = await cdpEvaluate(expression);
  if (!raw) throw new Error(`Empty ${label}response from browser for ${url.replace(API_BASE, '')}`);
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (parsed.error) throw new Error(`Browser ${label ? 'POST' : 'fetch'} error: ${parsed.error}`);
  if (parsed.status >= 400) {
    if (parsed.status === 401 || parsed.status === 403) {
      const e = new Error(`REED_RELOGIN_NEEDED: HTTP ${parsed.status}. Re-login with: node scripts/cdp-reed-full-login.js`);
      e.status = parsed.status;
      throw e;
    }
    const e = new Error(`Reed API ${label ? 'POST ' : ''}HTTP ${parsed.status}: ${(parsed.body || '').slice(0, 200)}`);
    e.status = parsed.status;
    throw e;
  }
  return JSON.parse(parsed.body);
}

async function reedBrowserFetch(endpoint) {
  await ensureBrowserSession();
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
  return browserJson(url, 'GET', null, '');
}

async function reedBrowserFetchPost(endpoint, body) {
  await ensureBrowserSession();
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
  return browserJson(url, 'POST', JSON.stringify(body), 'POST ');
}

// Binary fetch (CV downloads). Returns {buffer, contentType, contentDisposition}.
async function reedBrowserFetchBinary(endpoint, body) {
  await ensureBrowserSession();
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
  const method = body ? 'POST' : 'GET';
  const bodyJson = body ? JSON.stringify(body) : null;

  const expression = `
    (function() {
      const tok = window.__capturedReedToken || '';
      const opts = {
        method: '${method}',
        headers: {
          'Authorization': 'Bearer ' + tok,
          'Content-Type': 'application/json'
        }
      };
      ${bodyJson ? `opts.body = ${JSON.stringify(bodyJson)};` : ''}
      return fetch(${JSON.stringify(url)}, opts)
        .then(function(r) {
          const ct = r.headers.get('content-type') || '';
          const cd = r.headers.get('content-disposition') || '';
          return r.arrayBuffer().then(function(buf) {
            const bytes = new Uint8Array(buf);
            let binStr = '';
            const chunkSize = 8192;
            for (let i = 0; i < bytes.length; i += chunkSize) {
              binStr += String.fromCharCode.apply(null, bytes.slice(i, i + chunkSize));
            }
            const b64 = btoa(binStr);
            return JSON.stringify({status: r.status, contentType: ct, contentDisposition: cd, base64: b64, size: bytes.length});
          });
        })
        .catch(function(e) {
          return JSON.stringify({error: e.message});
        });
    })()
  `;

  const raw = await cdpEvaluate(expression);
  if (!raw) throw new Error('Empty binary response from browser');
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (parsed.error) throw new Error(`Browser binary error: ${parsed.error}`);
  if (parsed.status >= 400) {
    const e = new Error(`Reed binary API HTTP ${parsed.status}`);
    e.status = parsed.status;
    throw e;
  }
  return {
    buffer: Buffer.from(parsed.base64, 'base64'),
    contentType: parsed.contentType,
    contentDisposition: parsed.contentDisposition,
  };
}

process.once('beforeExit', closeCdp);

module.exports = {
  reedBrowserFetch,
  reedBrowserFetchPost,
  reedBrowserFetchBinary,
  ensureBrowserSession,
  findReedTab,
  cdpEvaluate,
  closeCdp,
  API_BASE,
};
