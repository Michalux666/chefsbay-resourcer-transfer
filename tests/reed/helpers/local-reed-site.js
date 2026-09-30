'use strict';

// A tiny local stand-in for secure-recruiter.reed.co.uk (login page with real HTML inputs) and www.reed.co.uk (recruiter pages that
// call the API with a Bearer token). It is meant for a REAL Chromium started with
//   --host-resolver-rules="MAP *.reed.co.uk 127.0.0.1, MAP * ~NOTFOUND"
// so hostnames resolve locally and nothing can leave the machine. The API side is the fake Reed API from fake-reed.js.

const http = require('http');
const crypto = require('crypto');

// opts: {fake, mode: ok|turnstile|twostep|react}
async function startLocalReedSite(opts) {
  const fake = opts.fake;
  const site = { mode: opts.mode || 'ok', sessions: new Set(), hits: [] };
  let port = 0;
  const host = (req) => String(req.headers.host || '').split(':')[0].toLowerCase();
  const cookieOk = (req) => {
    const m = /(?:^|;\s*)reed_sess=([a-f0-9]+)/.exec(req.headers.cookie || '');
    return !!m && site.sessions.has(m[1]);
  };
  const page = (res, html) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); };
  const redirect = (res, to) => { res.writeHead(302, { location: to }); res.end(); };

  const loginHtml = () => `<!doctype html><html><head><title>Sign in</title></head><body>
<form id="f" onsubmit="return false">
  <input type="email" name="email" id="email" autocomplete="username">
  ${site.mode === 'twostep' ? '' : '<input type="password" name="password" id="password">'}
  ${site.mode === 'turnstile' ? '<div class="cf-turnstile"></div><input type="hidden" name="cf-turnstile-response" value="">' : ''}
  <button type="submit" id="go">Continue</button>
  <p id="err"></p>
</form>
<script>
var mode = ${JSON.stringify(site.mode)};
var state = { email: '', password: '' };
document.getElementById('email').addEventListener('input', function (e) { state.email = e.target.value; });
function bindPw() { var p = document.getElementById('password'); if (p) p.addEventListener('input', function (e) { state.password = e.target.value; }); }
bindPw();
document.getElementById('go').addEventListener('click', function () {
  var f = document.getElementById('f');
  if (mode === 'twostep' && !document.getElementById('password')) {
    var i = document.createElement('input'); i.type = 'password'; i.name = 'password'; i.id = 'password';
    f.insertBefore(i, document.getElementById('go')); bindPw(); return;
  }
  var ts = document.querySelector('[name="cf-turnstile-response"]');
  if (ts && !ts.value) return;
  var email = mode === 'react' ? state.email : document.getElementById('email').value;
  var password = mode === 'react' ? state.password : document.getElementById('password').value;
  fetch('/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email, password: password }) })
    .then(function (r) { return r.json(); })
    .then(function (j) { if (j.ok) { location.href = 'http://www.reed.co.uk:${port}/recruiter/v2/home'; } else { document.getElementById('err').textContent = 'Wrong email or password'; } });
});
</script></body></html>`;

  const searchHtml = () => `<!doctype html><html><head><title>Candidate search</title></head><body><h1>Search</h1>
<script>
fetch('http://api.reed.co.uk:${fake.apiPort}/api-bff-recruiter-candidates/user/context', { headers: { 'Authorization': 'Bearer ${fake.site.issueToken()}', 'Content-Type': 'application/json' } }).catch(function () {});
</script></body></html>`;

  const server = http.createServer((req, res) => {
    const h = host(req);
    const u = new URL(req.url, 'http://x');
    site.hits.push(`${h}${u.pathname}`);
    if (h === 'secure-recruiter.reed.co.uk') {
      if (req.method === 'GET' && u.pathname === '/login') return page(res, loginHtml());
      if (req.method === 'POST' && u.pathname === '/auth') {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
          let j = {};
          try { j = JSON.parse(body); } catch { /* bad json */ }
          const ok = j.email === fake.site.creds.email && j.password === fake.site.creds.password;
          const headers = { 'content-type': 'application/json' };
          if (ok) {
            const id = crypto.randomBytes(8).toString('hex');
            site.sessions.add(id);
            headers['set-cookie'] = `reed_sess=${id}; Domain=reed.co.uk; Path=/${opts.persistentCookie ? '; Max-Age=86400' : ''}`;
          }
          res.writeHead(ok ? 200 : 401, headers);
          res.end(JSON.stringify({ ok }));
        });
        return undefined;
      }
    }
    if (h === 'www.reed.co.uk' && u.pathname.startsWith('/recruiter/')) {
      if (!cookieOk(req)) return redirect(res, `http://secure-recruiter.reed.co.uk:${port}/login?state=redirect`);
      if (u.pathname.includes('candidates/search')) return page(res, searchHtml());
      return page(res, '<!doctype html><title>Home</title><h1>Recruiter home</h1>');
    }
    res.writeHead(404);
    res.end('not found');
    return undefined;
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  return {
    port, site,
    hostBase: `http://www.reed.co.uk:${port}`,
    loginUrl: `http://secure-recruiter.reed.co.uk:${port}/login`,
    targetUrl: `http://www.reed.co.uk:${port}/recruiter/v2/candidates/search/results`,
    apiBase: `http://api.reed.co.uk:${fake.apiPort}/api-bff-recruiter-candidates`,
    logout() { site.sessions.clear(); },
    async close() { server.closeAllConnections(); await new Promise((r) => server.close(r)); },
  };
}

module.exports = { startLocalReedSite };
