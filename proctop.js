// Numbers for every process (AI_SCOPE-023, the Processes scope): CPU %, RAM (working set), and VRAM / GPU % per
// graphics card, for the "top 5 processes" lenses. Windows only, like procstats.js (AI_SCOPE-037/038): one long-running
// PowerShell (proctop.ps1) keeps a PDH query over all processes open and prints a block every SAMPLE_MS.
// It only runs while someone looks: started by the first get(), stopped after IDLE_MS without one, so AI_SCOPE costs
// nothing extra while no Processes lens is open. Other platforms: supported() is false (AI_SCOPE-052).
// No dependencies; conservative JS.
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const spawn = require('child_process').spawn;
const crypto = require('crypto');
const hwstats = require('./hwstats');

const SAMPLE_MS = 5000;          // a collect over ~340 processes took ~0.4 s on the test PC
const IDLE_MS = 30000;           // stop sampling this long after the last look
const STALE_MS = 3 * SAMPLE_MS;
const PS_FILE = path.join(__dirname, 'proctop.ps1');
// Run from a temp file, not -EncodedCommand (Windows' command-line limit, see AI_SCOPE-051).
const SCRIPT_FILE = path.join(os.tmpdir(), 'ai_scope-proctop-' + process.pid + '.ps1');

// Exe icons (AI_SCOPE-023): path -> { id, png }, id -> png; pid -> exe path (sent once per process by proctop.ps1)
const icons = {}, iconById = {}, pidPath = {};
let ps = null, lastLook = 0, idleTimer = null, startedAt = 0, latest = null, startError = null;

// One block of P / G lines -> { at, procs: [{ pid, name, cpu, ram, luids: { luid: { vram, shared, util } } }] }
function handleBlock(lines) {
  const byPid = {};
  const proc = pid => byPid[pid] || (byPid[pid] = { pid: pid, name: '', cpu: null, ram: null, luids: {} });
  const num = s => { if (s === '' || s == null) return null; const v = parseFloat(String(s).replace(',', '.')); return isFinite(v) ? v : null; };
  lines.forEach(function (l) {
    const p = l.split('|');
    if (p[0] === 'I' && p.length >= 3) {
      if (!icons[p[1].toLowerCase()]) {
        const id = crypto.createHash('sha1').update(p[1].toLowerCase()).digest('hex').slice(0, 12);
        try { const png = Buffer.from(p[2], 'base64'); if (png.length) { icons[p[1].toLowerCase()] = id; iconById[id] = png; } } catch (e) {}
      }
    } else if (p[0] === 'P' && p.length >= 5) {
      const r = proc(+p[1]);
      r.name = p[2]; r.cpu = num(p[3]); r.ram = num(p[4]);
      if (p[5]) pidPath[r.pid] = p[5];
      r.ioRead = num(p[6]); r.ioWrite = num(p[7]);   // all I/O bytes/s (disk, network, devices; AI_SCOPE-030)
    } else if (p[0] === 'G' && p.length >= 6) {
      const r = proc(+p[1]);
      r.luids[p[2].toLowerCase()] = { vram: num(p[3]) || 0, shared: num(p[4]) || 0, util: num(p[5]) };
    }
  });
  Object.keys(pidPath).forEach(function (pid) { if (!byPid[pid]) delete pidPath[pid]; });   // gone
  latest = { at: Date.now(), procs: Object.keys(byPid).map(function (k) { return byPid[k]; }).filter(function (r) { return r.pid > 0; }) };
}

function start() {
  if (ps || process.platform !== 'win32') return;
  let src; try { src = fs.readFileSync(PS_FILE, 'utf8'); } catch (e) { startError = 'proctop.ps1 is missing'; return; }
  const script = src.split('__PARENT__').join(String(process.pid)).split('__EVERY__').join(String(SAMPLE_MS));
  let child;
  try {
    fs.writeFileSync(SCRIPT_FILE, '﻿' + script, 'utf8');   // BOM: Windows PowerShell 5.1 reads BOM-less files as ANSI
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_FILE],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {   // never take the server down over process stats
    console.log('[proctop] could not start: ' + e.message);
    startError = 'Could not start the process sampler: ' + e.message;
    return;
  }
  ps = child; startedAt = Date.now(); startError = null;
  let buf = '', block = [];
  child.on('error', function (e) { if (ps === child) { ps = null; startError = 'Could not start the process sampler: ' + e.message; } });
  child.on('exit', function (code) {
    if (ps !== child) return;
    ps = null;
    if (code) startError = 'Windows performance counters are not available (sampler exited with code ' + code + ')';
  });
  child.stdout.on('data', function (d) {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    lines.forEach(function (l) {
      if (l.trim() === '---') { handleBlock(block); block = []; } else if (l.trim()) block.push(l.trim());
    });
  });
}
function stop() {
  if (ps) { try { ps.kill(); } catch (e) {} ps = null; }
  latest = null;
  // a new sampler sends every path and icon again
  Object.keys(pidPath).forEach(function (k) { delete pidPath[k]; });
  Object.keys(icons).forEach(function (k) { delete icons[k]; });
  Object.keys(iconById).forEach(function (k) { delete iconById[k]; });
}
process.on('exit', function () { stop(); try { fs.unlinkSync(SCRIPT_FILE); } catch (e) {} });

// Latest sample for the /api/processes endpoint. Each call counts as "someone is looking" (keeps the sampler running).
// gpus[] of each process follows the Hardware card order; a card the process doesn't use is left out (null).
function get() {
  if (process.platform !== 'win32') return { supported: false, procs: [] };
  lastLook = Date.now();
  if (!ps && !startError) start();
  if (!idleTimer) idleTimer = setInterval(function () {
    if (Date.now() - lastLook > IDLE_MS) { stop(); clearInterval(idleTimer); idleTimer = null; startError = null; }
  }, 5000);
  const luids = hwstats.cardLuids();
  const fresh = latest && Date.now() - latest.at < STALE_MS;
  // A process that didn't give its path (another user's, e.g. a second python.exe) borrows the icon of a same-named one that did
  const byName = {};
  if (fresh) latest.procs.forEach(function (r) { const p = pidPath[r.pid], id = p && icons[p.toLowerCase()]; if (id) byName[r.name.toLowerCase()] = id; });
  return {
    supported: true,
    every: SAMPLE_MS,
    at: fresh ? latest.at : null,
    warming: !fresh && !!ps,                       // started, first numbers not in yet (~4 s)
    since: ps ? startedAt : null,                  // when the sampler started (it stops 30 s after the last look)
    error: startError,
    cores: os.cpus().length,
    procs: fresh ? latest.procs.map(function (r) {
      const path = pidPath[r.pid];
      return { pid: r.pid, name: r.name, cpu: r.cpu, ram: r.ram, ioRead: r.ioRead, ioWrite: r.ioWrite, icon: path && icons[path.toLowerCase()] || byName[r.name.toLowerCase()] || null,
        gpus: luids.map(function (l) { const g = l && r.luids[l]; return g ? { vram: g.vram, shared: g.shared, util: g.util } : null; }) };
    }) : [],
  };
}
// An exe icon (PNG) by the id given in get(); only icons of exes that were running are known (no file paths from the page).
function icon(id) { return /^[0-9a-f]{12}$/.test(id) && iconById[id] || null; }
function supported() { return process.platform === 'win32'; }
module.exports = { get: get, icon: icon, supported: supported, _test: { handleBlock: handleBlock, latest: function () { return latest; } } };
