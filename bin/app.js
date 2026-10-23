// `ai_scope --app` / `ai_scope --stop`: AI_SCOPE as a desktop-style app.
//  --app : if AI_SCOPE isn't running yet, start it hidden in the background (no console window; output goes
//          to <data dir>/ai_scope.log), then open the dashboard in its own window: Edge or Chrome in app mode
//          (no address bar or tabs, own profile so the window remembers its size and position), else the
//          default browser. Closing the window leaves AI_SCOPE running.
//  --stop: stops the background AI_SCOPE (asks the server to exit).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const spawn = require('child_process').spawn;

// GET /api/ping on this PC. cb(state, info): 'ai_scope' (running), 'other' (port taken by another program) or 'down'.
function ping(port, cb) {
  const req = http.get({ host: '127.0.0.1', port: port, path: '/api/ping', timeout: 2000 }, function (res) {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', function (d) { if (body.length < 65536) body += d; });
    res.on('end', function () {
      try { const j = JSON.parse(body); if (j && (j.app === 'ai_scope' || j.app === 'ai-scope')) return cb('ai_scope', j); } catch (e) { /* not JSON */ }
      // AI_SCOPE v0.1 has no /api/ping but answers every path with the dashboard page.
      cb(body.indexOf('AI_SCOPE') >= 0 ? 'ai_scope' : 'other', null);
    });
  });
  req.on('timeout', function () { req.destroy(new Error('timeout')); });
  req.on('error', function () { cb('down', null); });
}

function waitUntilUp(port, ms, cb) {
  const until = Date.now() + ms;
  (function again() {
    ping(port, function (state) {
      if (state !== 'down') return cb(state);
      if (Date.now() > until) return cb('down');
      setTimeout(again, 300);
    });
  })();
}

// Start bin/ai_scope.js again, detached and without a window. flags = --port/--host/--data-dir to pass on.
function startBackground(flags, logFile) {
  let out = 'ignore';
  try {
    try { if (fs.statSync(logFile).size > 2 * 1048576) fs.renameSync(logFile, logFile + '.old'); } catch (e) { /* no log yet */ }
    out = fs.openSync(logFile, 'a');
  } catch (e) { /* run without a log */ }
  const env = Object.assign({}, process.env, { AI_SCOPE_BACKGROUND: '1' });
  delete env.AI_SCOPE_OPEN;
  const child = spawn(process.execPath, [path.join(__dirname, 'ai_scope.js')].concat(flags),
    { detached: true, windowsHide: true, stdio: ['ignore', out, out], env: env, cwd: os.homedir() });
  child.unref();
  return child.pid;
}

// Browsers that can open a page as an app window (--app=URL).
function appBrowsers() {
  const list = [];
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    roots.forEach(function (r) { list.push({ name: 'Edge', exe: path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe') }); });
    roots.forEach(function (r) { list.push({ name: 'Chrome', exe: path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe') }); });
  } else if (process.platform === 'darwin') {
    list.push({ name: 'Chrome', exe: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    list.push({ name: 'Edge', exe: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' });
  } else {
    ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
      .forEach(function (exe) { list.push({ name: path.basename(exe), exe: exe }); });
  }
  return list.filter(function (b) { try { return fs.statSync(b.exe).isFile(); } catch (e) { return false; } });
}

// The app window's own browser profile (keeps its size/position; separate from your normal browsing).
function profileDir(browser) {
  const base = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ai_scope')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'ai_scope')
    : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ai_scope');
  return path.join(base, browser === 'Edge' ? 'window' : 'window-' + browser.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
}

function openWindow(url) {
  const b = appBrowsers()[0];
  if (!b) { require('./open')(url); return 'your default browser'; }
  try {
    const p = spawn(b.exe, ['--app=' + url, '--user-data-dir=' + profileDir(b.name), '--no-first-run', '--no-default-browser-check'],
      { detached: true, stdio: 'ignore' });
    p.on('error', function () { require('./open')(url); });
    p.unref();
    return b.name;
  } catch (e) { require('./open')(url); return 'your default browser'; }
}

// opts: { port, flags, logFile }
function app(opts) {
  const url = 'http://localhost:' + opts.port + '/#home';
  ping(opts.port, function (state) {
    if (state === 'other') {
      console.log('ai_scope: port ' + opts.port + ' is used by another program. Use --port to pick another one.');
      process.exit(1);
    }
    if (state === 'ai_scope') {
      console.log('AI_SCOPE is already running - opening it in ' + openWindow(url) + '.');
      return setTimeout(function () { process.exit(0); }, 300);
    }
    startBackground(opts.flags, opts.logFile);
    console.log('Starting AI_SCOPE in the background (log: ' + opts.logFile + ')...');
    waitUntilUp(opts.port, 20000, function (s) {
      if (s !== 'ai_scope') {
        console.log('ai_scope: AI_SCOPE did not start' + (s === 'other' ? ' (port ' + opts.port + ' is used by another program)' : '') + '. See ' + opts.logFile);
        process.exit(1);
      }
      console.log('Opening it in ' + openWindow(url) + '. Stop it with: ai_scope --stop');
      setTimeout(function () { process.exit(0); }, 300);
    });
  });
}

function stop(port) {
  const req = http.request({ host: '127.0.0.1', port: port, path: '/api/stop', method: 'POST', timeout: 4000,
                             headers: { 'X-AI-Scope': 'stop', 'Content-Length': 0 } }, function (res) {
    res.resume();
    res.on('end', function () {
      if (res.statusCode === 200) console.log('AI_SCOPE (port ' + port + ') stopped.');
      else console.log('ai_scope: port ' + port + ' did not accept the stop request (HTTP ' + res.statusCode + ') - is it an older AI_SCOPE or another program?');
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
  });
  req.on('timeout', function () { req.destroy(new Error('timeout')); });
  req.on('error', function () { console.log('AI_SCOPE is not running on port ' + port + '.'); process.exit(0); });
  req.end();
}

module.exports = { app: app, stop: stop, ping: ping };
