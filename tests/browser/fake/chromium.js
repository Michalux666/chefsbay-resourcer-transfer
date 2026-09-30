#!/usr/bin/env node
'use strict';
/*
 * FAKE chromium for tests (not a browser). Stands in for /usr/bin/chromium so launcher code
 * (for example a Reed CDP launcher run under xvfb-run) can be tested without a real browser.
 *
 *   node chromium.js --remote-debugging-port=<n> --user-data-dir=<dir> [flags] [url]
 *   node chromium.js --version            -> "Chromium 153.0.8010.50 fake"
 *
 * Serves on 127.0.0.1:<port>: GET /json/version, GET /json and /json/list (one about:blank page),
 * PUT/GET /json/new?<url> (adds a page), GET /json/protocol (Network domain with requestWillBeSent and
 * no setRequestInterception, as Chrome 153). No websocket endpoint is provided.
 *
 * Env: FAKE_CHROMIUM_LOG=<file>  append one JSON line with argv/DISPLAY at start
 *      FAKE_CHROMIUM_START_MS=<n> delay before the port starts listening (default 300)
 *      FAKE_NO_CDP=1              never listen (simulates a wedged browser)
 * It writes DevToolsActivePort into --user-data-dir like the real browser and removes it on SIGTERM.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stdout.write('Chromium 153.0.8010.50 fake\n'); process.exit(0); }

const arg = (name) => { const a = argv.find((x) => x.startsWith(name + '=')); return a ? a.slice(name.length + 1) : null; };
const port = Number(arg('--remote-debugging-port') || 9222);
const udd = arg('--user-data-dir');
const startMs = Number(process.env.FAKE_CHROMIUM_START_MS || 300);

if (process.env.FAKE_CHROMIUM_LOG) {
  try { fs.appendFileSync(process.env.FAKE_CHROMIUM_LOG, JSON.stringify({ pid: process.pid, argv, display: process.env.DISPLAY || null }) + '\n'); } catch { /* ignore */ }
}
if (process.env.FAKE_NO_CDP) { setInterval(() => {}, 1e6); return; }

const pages = [{ id: 'PAGE1', type: 'page', title: '', url: 'about:blank', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/PAGE1` }];
let nextId = 2;
const send = (res, code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };

setTimeout(() => {
  const srv = http.createServer((req, res) => {
    const u = req.url || '';
    if (u === '/json/version') return send(res, 200, { Browser: 'Chrome/153.0.8010.50', 'Protocol-Version': '1.3', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/FAKE` });
    if (u === '/json' || u === '/json/list') return send(res, 200, pages);
    if (u.startsWith('/json/new')) {
      const id = 'PAGE' + (nextId++);
      const p = { id, type: 'page', title: '', url: decodeURIComponent(u.split('?')[1] || 'about:blank'), webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${id}` };
      pages.push(p);
      return send(res, 200, p);
    }
    if (u === '/json/protocol') return send(res, 200, { version: { major: '1', minor: '3' }, domains: [{ domain: 'Network', commands: [{ name: 'enable' }], events: [{ name: 'requestWillBeSent' }] }] });
    return send(res, 404, { error: 'not found' });
  });
  srv.listen(port, '127.0.0.1', () => {
    if (udd) { try { fs.mkdirSync(udd, { recursive: true }); fs.writeFileSync(path.join(udd, 'DevToolsActivePort'), `${port}\n/devtools/browser/FAKE\n`); } catch { /* ignore */ } }
  });
  const stop = () => {
    if (udd) { try { fs.unlinkSync(path.join(udd, 'DevToolsActivePort')); } catch { /* ignore */ } }
    srv.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}, startMs);
