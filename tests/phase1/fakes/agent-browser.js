#!/usr/bin/env node
'use strict';
// Fake agent-browser: `--session caterer <open|wait|eval|get|state> ...`, driven by per-page fixtures
// from the scenario file. Output shapes follow research/agent-browser-linux.md section 3.1.
const fs = require('fs');
const vm = require('vm');
const { scenario, readState, writeState, logCall, sleepMs } = require('./common');

const OK = String.fromCharCode(0x2713);
const ERR = String.fromCharCode(0x2717);
const HANG_MS = Number(process.env.P1_HANG_MS || 15000);

function pageNumber(url) {
  const m = String(url || '').match(/[?&]PageNumber=(\d+)/i);
  return m ? Number(m[1]) : 1;
}

function pageFixture(sc, n) {
  const pages = sc.pages || {};
  return pages[String(n)] || sc.defaultPage || { cards: [] };
}

// Runs the real probe source against a fake document so the regexes are genuinely exercised.
function evalProbe(js, text) {
  const ctx = { document: { body: { innerText: text || '' } } };
  return vm.runInNewContext(js, ctx);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--session') argv.splice(0, 2);
  const cmd = argv[0];
  const sc = scenario();
  const st = readState('browser.json', { url: '', page: 1 });
  const sess = readState('session.json', sc.session || { cookieValid: true, browserOnLogin: false });
  const page = pageFixture(sc, st.page);

  if (cmd === 'open') {
    const url = argv[1];
    const n = pageNumber(url);
    logCall('agent-browser', { cmd: 'open', url, page: n });
    const fx = pageFixture(sc, n);
    if (fx.openHang) await sleepMs(HANG_MS);
    if (fx.openError) { process.stderr.write(ERR + ' navigation failed: net::ERR_FAKE\n'); writeState('browser.json', { url, page: n }); process.exit(1); }
    writeState('browser.json', { url, page: n });
    process.stdout.write(`${OK} Fake results page ${n}\n${url}\n`);
    return;
  }
  if (cmd === 'wait') {
    logCall('agent-browser', { cmd: 'wait', args: argv.slice(1), page: st.page });
    if (page.waitHang) await sleepMs(HANG_MS);
    process.stdout.write(OK + ' Load state: networkidle\n');
    return;
  }
  if (cmd === 'eval') {
    const b64 = argv[argv.indexOf('-b') + 1];
    const js = Buffer.from(b64 || '', 'base64').toString('utf8');
    const isProbe = js.includes('EMPTY');
    logCall('agent-browser', { cmd: 'eval', probe: isProbe, page: st.page, jsMarker: js.includes('FAKE-EXTRACT') });
    if (isProbe) {
      if (page.probeHang) await sleepMs(HANG_MS);
      const result = evalProbe(js, page.text || '');
      process.stdout.write(JSON.stringify(result) + '\n');
      return;
    }
    if (!js.includes('FAKE-EXTRACT')) { process.stderr.write(ERR + ' unexpected script\n'); process.exit(1); }
    if (page.evalHang) await sleepMs(HANG_MS);
    if (page.evalError) { process.stderr.write(String(page.evalError) + '\n'); process.exit(1); }
    if (page.rawEval !== undefined) { process.stdout.write(String(page.rawEval) + '\n'); return; }
    process.stdout.write(JSON.stringify(JSON.stringify(page.cards || [])) + '\n');
    return;
  }
  if (cmd === 'get' && argv[1] === 'url') {
    const counters = readState('browser-calls.json', { getUrl: 0 });
    counters.getUrl++;
    writeState('browser-calls.json', counters);
    logCall('agent-browser', { cmd: 'get url', n: counters.getUrl });
    if (sess.urlHang) await sleepMs(HANG_MS);
    if (sess.urlEmpty || (sess.urlEmptyFromCall && counters.getUrl >= sess.urlEmptyFromCall)) return;
    if (sess.urlFromCall && sess.urlFromCall[String(counters.getUrl)]) { process.stdout.write(sess.urlFromCall[String(counters.getUrl)] + '\n'); return; }
    const loginNow = sess.browserOnLogin || (sess.loginFromGetUrlCall && counters.getUrl >= sess.loginFromGetUrlCall);
    process.stdout.write((loginNow ? 'https://recruiter.caterer.com/login?ReturnUrl=%2F' : (st.url || 'https://recruiter.caterer.com/Home/1')) + '\n');
    return;
  }
  if (cmd === 'state' && argv[1] === 'save') {
    logCall('agent-browser', { cmd: 'state save', file: argv[2] });
    if (sess.saveHang) await sleepMs(HANG_MS);
    if (sess.saveFail) { process.stderr.write(ERR + ' save failed\n'); process.exit(1); }
    fs.writeFileSync(argv[2], JSON.stringify({ cookies: [], origins: [] }));
    process.stdout.write(`${OK} State saved to ${argv[2]}\n`);
    return;
  }
  if (cmd === 'state' && argv[1] === 'load') {
    logCall('agent-browser', { cmd: 'state load', file: argv[2] });
    process.stdout.write(`${OK} State path set to ${argv[2]}\n`);
    return;
  }
  process.stderr.write(`${ERR} unknown command: ${argv.join(' ')}\n`);
  process.exit(1);
}

main().catch((e) => { process.stderr.write(`${ERR} ${e.message}\n`); process.exit(1); });
