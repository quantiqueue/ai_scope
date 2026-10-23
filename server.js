'use strict';
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const lmstats = require('./lmstats');
const hwstats = require('./hwstats');
const logos = require('./logos');
const comfystats = require('./comfystats');
const ollamastats = require('./ollamastats');
const stratastats = require('./stratastats');
const lmapi = require('./lmapi');
const scopes = require('./scopes');
const customscopes = require('./customscopes');   // AI_SCOPE-003: user-made pages of lenses
hwstats.start();   // Hardware is built in (its VRAM total is also used by the other scopes)
scopes.init();      // starts the modules of every installed scope (scopes.json + data/installed.json)

// Port/host come from the command line (bin/ai_scope.js sets these) or the environment.
// 127.0.0.1 = this PC only; 0.0.0.0 = also other devices on your network.
// `npx ai_scope` defaults to 127.0.0.1; running server.js directly (dev.js / start.bat) defaults to 0.0.0.0.
const PORT = parseInt(process.env.AI_SCOPE_PORT, 10) || 9000;
const HOST = process.env.AI_SCOPE_HOST || '0.0.0.0';
const BOOT_ID = Date.now().toString(); // changes on every restart; the page uses it to auto-reload

// ---------- The dashboard page: web/index.html + web/app.css + web/js/*.js ----------
// Plain files (no build step). Read on each request - they're small - so they're never stale.
const WEB_DIR = path.join(__dirname, 'web');
const WEB_FILES = {
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
};
// Client scripts: /js/<name>.js -> web/js/<name>.js (plain names only, so nothing outside web/js can be asked for).
const WEB_JS = /^\/js\/([a-z0-9-]+)\.js$/;
function sendWebFile(res, name, type) {
  fs.readFile(path.join(WEB_DIR, name), (err, buf) => {
    if (err) { res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' }); return res.end('AI_SCOPE: missing web/' + name); }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// Which scope each data endpoint belongs to: endpoints of scopes that aren't installed answer 404.
// Peak whole-PC load per Bionic request. Its log rows are re-read on every poll, so peaks are cached
// in memory by row. The log timestamp is written when the request finishes (1 s resolution).
const lmPeaks = new Map();
function lmPeak(r) {
  const key = r.timestamp + '|' + r.task;
  if (lmPeaks.has(key)) return lmPeaks.get(key);
  const end = lmstats.tsToMs(r.timestamp);
  if (end == null || r.totalMs == null) return null;
  const oldest = hwstats.oldestSample();
  if (Date.now() - end < 4000) return null;          // let the samples after the end come in first
  const p = hwstats.peakBetween(end - r.totalMs - 1000, end + 2000);
  if (p || oldest == null || end < oldest) {          // final: found, or too old to ever find
    lmPeaks.set(key, p);
    if (lmPeaks.size > 5000) lmPeaks.delete(lmPeaks.keys().next().value);
  }
  return p;
}
const SCOPE_ROUTES = [['/api/bionic', 'bionic'], ['/api/comfy', 'comfyui'], ['/api/ollama', 'ollama'], ['/api/strata', 'strata']];
const PKG_VERSION = require('./package.json').version;
function isLocal(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
let iconBuf = null;
function sendIcon(res) {
  if (!iconBuf) { try { iconBuf = fs.readFileSync(path.join(__dirname, 'assets', 'ai_scope.ico')); } catch (e) { iconBuf = Buffer.alloc(0); } }
  if (!iconBuf.length) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'max-age=86400' });
  res.end(iconBuf);
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readJson(req, cb) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', d => { body += d; if (body.length > 65536) req.destroy(); });
  req.on('end', () => { let v = null; try { v = JSON.parse(body || '{}'); } catch (e) {} cb(v); });
}
// The installed scopes go into the page itself, so the first render already shows the right tabs.
function pageHtml() {
  const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
  const js = v => JSON.stringify(v).replace(/</g, '\\u003c');
  return html.split('/*__SCOPES__*/[]').join(js(scopes.list())).split('/*__CUSTOM__*/[]').join(js(customscopes.list()));
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__boot') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return res.end(BOOT_ID);
  }
  if (url.pathname === '/home') { res.writeHead(302, { Location: '/#home' }); return res.end(); }
  if (url.pathname === '/favicon.ico') return sendIcon(res);
  if (WEB_FILES[url.pathname]) return sendWebFile(res, WEB_FILES[url.pathname][0], WEB_FILES[url.pathname][1]);
  const js = WEB_JS.exec(url.pathname);
  if (js) return sendWebFile(res, 'js/' + js[1] + '.js', 'text/javascript; charset=utf-8');
  // "Is AI_SCOPE running here?" for `ai_scope --app` / `--stop`; `local` = request from this PC (shows the Stop button).
  if (url.pathname === '/api/ping') return sendJson(res, 200, { app: 'ai_scope', version: PKG_VERSION, pid: process.pid, port: PORT, local: isLocal(req) });
  // Stop AI_SCOPE (ai_scope --stop, or the Stop button). Only from this PC, and only with the custom header,
  // so other web pages can't trigger it (a cross-site request with that header needs CORS, which we never allow).
  if (url.pathname === '/api/stop' && req.method === 'POST') {
    if (!isLocal(req) || req.headers['x-ai-scope'] !== 'stop') return sendJson(res, 403, { ok: false, error: 'Only allowed from this computer' });
    console.log('[server] stop requested - exiting');
    sendJson(res, 200, { ok: true });
    return setTimeout(() => process.exit(0), 150);
  }
  if (url.pathname === '/api/scopes' && req.method === 'GET') return sendJson(res, 200, scopes.list());
  if ((url.pathname === '/api/scopes/install' || url.pathname === '/api/scopes/remove') && req.method === 'POST') {
    return readJson(req, body => {
      if (!body || !body.id) return sendJson(res, 400, { ok: false, error: 'Bad request' });
      const r = url.pathname.slice(-7) === 'install' ? scopes.install(String(body.id), body.settings || {}) : scopes.remove(String(body.id));
      r.scopes = scopes.list();
      sendJson(res, r.ok ? 200 : 400, r);
    });
  }
  // Custom scopes: list, create { name }, update { id, name?, lenses? }, remove { id }. Answers carry the new list.
  if (url.pathname === '/api/custom-scopes' && req.method === 'GET') return sendJson(res, 200, customscopes.list());
  const cAction = /^\/api\/custom-scopes\/(create|update|remove)$/.exec(url.pathname);
  if (cAction && req.method === 'POST') {
    return readJson(req, body => {
      if (!body) return sendJson(res, 400, { ok: false, error: 'Bad request' });
      const r = customscopes[cAction[1]](body);
      r.custom = customscopes.list();
      sendJson(res, r.ok ? 200 : 400, r);
    });
  }
  const owner = SCOPE_ROUTES.filter(r => url.pathname.indexOf(r[0]) === 0)[0];
  if (owner && !scopes.isInstalled(owner[1])) return sendJson(res, 404, { error: 'Scope not installed: ' + owner[1] });
  if (url.pathname === '/api/comfy') {
    const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 100, 1000);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(comfystats.getState(limit)));
  }
  if (url.pathname === '/api/comfy/models') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(comfystats.getModels(hwstats.vramInfo())));
  }
  if (url.pathname === '/api/comfy/view') {
    return comfystats.proxyImage(url.searchParams, res);
  }
  if (url.pathname === '/api/ollama') {
    const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 100, 1000);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(ollamastats.getState(limit, hwstats.vramInfo())));
  }
  if (url.pathname === '/api/strata') {
    const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 100, 1000);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(stratastats.getState(limit)));
  }
  if (url.pathname === '/api/bionic/models') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(lmapi.getState(hwstats.vramInfo())));
  }
  if (url.pathname === '/api/bionic/raw') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(lmapi.getRaw(), null, 2));
  }
  if (url.pathname === '/api/logo/strata') {   // Strata's mark (SVG): its install folder, else the running app, else our copy
    const theme = url.searchParams.get('theme');
    const svg = logos.getSvg('strata', theme) || stratastats.getLogo(theme) || logos.fallbackSvg('strata', theme);
    if (!svg) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no logo'); }
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=3600' });
    return res.end(svg);
  }
  if (url.pathname.indexOf('/api/logo/') === 0) {
    return logos.serve(url.pathname.slice('/api/logo/'.length), res);
  }
  if (url.pathname === '/api/hardware') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(hwstats.getStats()));
  }
  if (url.pathname === '/api/bionic') {   // Bionic's requests (from its server logs)
    const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 100, 1000);
    let body;
    try {
      body = lmstats.getLatestRequests(limit);
      body.rows.forEach(r => { r.peak = lmPeak(r); });
      body.current = lmstats.getCurrentRequest();
      body.average = lmstats.getAverage(body.rows);
    }
    catch (e) { body = { rows: [], error: String(e && e.message || e) }; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(body));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(pageHtml());
}).on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.log(`AI_SCOPE: port ${PORT} is already in use (is AI_SCOPE already running?). Try --port <another port>.`);
  else if (e.code === 'EACCES') console.log(`AI_SCOPE: no permission to use port ${PORT}. Try a port above 1024.`);
  else console.log('AI_SCOPE: could not start: ' + e.message);
  process.exit(1);
}).listen(PORT, HOST, () => {
  console.log(`AI_SCOPE running on port ${PORT}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs) {
        if (a.family === 'IPv4' && !a.internal) console.log(`  Network: http://${a.address}:${PORT}`);
      }
    }
  } else if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log(`  Network: http://${HOST}:${PORT}`);
  } else {
    console.log('  (this PC only - use --host 0.0.0.0 to open it from other devices)');
  }
  console.log(`  Data:    ${require('./paths').DATA_DIR}`);
  // --open (and so the Start Menu shortcut and the installer's first start) lands on the Home page.
  if (process.env.AI_SCOPE_OPEN === '1') require('./bin/open')(`http://localhost:${PORT}/#home`);
});
