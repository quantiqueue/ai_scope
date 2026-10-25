// Numbers for every process (AI_SCOPE-023, the Processes scope): CPU %, RAM (working set), and VRAM / GPU % per
// graphics card, for the "top 5 processes" lenses. Windows only, like procstats.js (AI_SCOPE-037/038): one long-running
// PowerShell (proctop.ps1) keeps a PDH query over all processes open and prints a block every few seconds.
// Always warm (AI_SCOPE-059): started with the server and never stopped (restarted after a crash), because its first
// sample costs 5-7 s; it samples every FAST_MS while a Processes lens is looked at and every SLOW_MS otherwise
// (Node tells it through a small control file), and keeps HIST_MS of samples so the lenses' 5-minute lines are full
// when a page opens. Other platforms: supported() is false (AI_SCOPE-052).
// No dependencies; conservative JS.
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const spawn = require('child_process').spawn;
const crypto = require('crypto');
const hwstats = require('./hwstats');

const FAST_MS = 5000;            // while someone looks (a collect over ~340 processes: ~0.4 s, ~1.9 % of a 16-thread CPU at this pace)
const SLOW_MS = 30000;           // while nobody looks: keeps the query open (no cold start) and a coarse history
const IDLE_MS = 30000;           // back to SLOW_MS this long after the last look
const STALE_MS = 3 * SLOW_MS;    // a sample this old is not shown (the sampler is gone or stuck)
const HIST_MS = 5 * 60 * 1000;   // samples kept for the lenses' 5-minute lines
// How often to sample, read by proctop.ps1 every 250 ms (a faster pace wakes it at once).
const CTL_FILE = path.join(os.tmpdir(), 'ai_scope-proctop-ctl-' + process.pid + '.txt');
const PS_FILE = path.join(__dirname, 'proctop.ps1');
// Run from a temp file, not -EncodedCommand (Windows' command-line limit, see AI_SCOPE-051).
const SCRIPT_FILE = path.join(os.tmpdir(), 'ai_scope-proctop-' + process.pid + '.ps1');
// The script's C# compiled once per version (AI_SCOPE-059): ai_scope-proctop-<hash of proctop.ps1>.dll in the temp folder.
// Compiling (Add-Type) on every start was part of the wait on "Starting..."; loading the DLL is quick.
const DLL_RE = /^ai_scope-proctop-([0-9a-f]{12})(?:-\d+)?\.dll$/;
function dllFor(src) {
  const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 12);
  // DLLs of other versions (and leftovers of an interrupted compile) are removed; a DLL still loaded by a running
  // sampler can't be deleted on Windows, so that one just stays until next time.
  try { fs.readdirSync(os.tmpdir()).forEach(function (f) { const m = DLL_RE.exec(f); if (m && (m[1] !== hash || f.indexOf(hash + '-') >= 0)) { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (e) {} } }); } catch (e) {}
  return path.join(os.tmpdir(), 'ai_scope-proctop-' + hash + '.dll');
}

// Exe icons (AI_SCOPE-023): path -> { id, png }, id -> png; pid -> exe path (sent once per process by proctop.ps1)
const icons = {}, iconById = {}, pidPath = {};
let ps = null, lastLook = 0, idleTimer = null, startedAt = 0, latest = null, startError = null;
let every = SLOW_MS, failures = 0, restartTimer = null, history = [];   // history: full (not partial) samples, oldest first
// Start-up timings of the current sampler (AI_SCOPE-059): Node's spawn / first output / first blocks + the script's T lines
let startup = null;

// One block of P / G lines -> { at, procs: [{ pid, name, cpu, ram, luids: { luid: { vram, shared, util } } }] }
function handleBlock(lines) {
  const byPid = {};
  let partial = false;
  const proc = pid => byPid[pid] || (byPid[pid] = { pid: pid, name: '', cpu: null, ram: null, luids: {} });
  const num = s => { if (s === '' || s == null) return null; const v = parseFloat(String(s).replace(',', '.')); return isFinite(v) ? v : null; };
  lines.forEach(function (l) {
    const p = l.split('|');
    if (p[0] === 'T' && p.length >= 3 && startup) { startup[p[1]] = +p[2]; if (p[3]) startup.how = p[3]; }
    else if (p[0] === 'W') partial = true;   // first block: memory only, no CPU % / GPU % / I/O yet (AI_SCOPE-059)
    else if (p[0] === 'I' && p.length >= 3) {
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
  if (startup && partial && !startup.partialAt) startup.partialAt = Date.now();
  if (startup && !partial && !startup.fullAt) startup.fullAt = Date.now();
  latest = { at: Date.now(), partial: partial, procs: Object.keys(byPid).map(function (k) { return byPid[k]; }).filter(function (r) { return r.pid > 0; }) };
  if (!partial) {
    history.push(latest);
    while (history.length && history[0].at < latest.at - HIST_MS) history.shift();
  }
}

function setEvery(ms) {
  if (ms === every && ps) return;
  every = ms;
  try { fs.writeFileSync(CTL_FILE, String(ms)); } catch (e) {}
}
function start() {
  if (ps || process.platform !== 'win32') return;
  if (!idleTimer) idleTimer = setInterval(function () { if (ps && every !== SLOW_MS && Date.now() - lastLook > IDLE_MS) setEvery(SLOW_MS); }, 5000);
  let src; try { src = fs.readFileSync(PS_FILE, 'utf8'); } catch (e) { startError = 'proctop.ps1 is missing'; return; }
  let child;
  try {
    try { fs.writeFileSync(CTL_FILE, String(every)); } catch (e) {}
    const script = src.split('__PARENT__').join(String(process.pid)).split('__EVERY__').join(String(every))
      .split('__DLL__').join(dllFor(src).replace(/'/g, "''")).split('__CTL__').join(CTL_FILE.replace(/'/g, "''"));
    fs.writeFileSync(SCRIPT_FILE, '﻿' + script, 'utf8');   // BOM: Windows PowerShell 5.1 reads BOM-less files as ANSI
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_FILE],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {   // never take the server down over process stats
    console.log('[proctop] could not start: ' + e.message);
    startError = 'Could not start the process sampler: ' + e.message;
    return;
  }
  ps = child; startedAt = Date.now(); startError = null;
  startup = { spawnAt: startedAt };
  let buf = '', block = [];
  child.on('error', function (e) { if (ps === child) { ps = null; startError = 'Could not start the process sampler: ' + e.message; } });
  child.on('exit', function (code) {
    if (ps !== child) return;
    ps = null; latest = null;
    // restart after a crash, like diskstats (give up after a few failures in a row)
    if (++failures <= 5) { if (!restartTimer) restartTimer = setTimeout(function () { restartTimer = null; start(); }, 10000); }
    else if (code) startError = 'Windows performance counters are not available (sampler exited with code ' + code + ')';
    else startError = 'The process sampler keeps stopping';
  });
  child.stdout.on('data', function (d) {
    if (startup && !startup.outAt) startup.outAt = Date.now();
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    lines.forEach(function (l) {
      if (l.trim() === '---') { handleBlock(block); block = []; failures = 0; } else if (l.trim()) block.push(l.trim());
    });
  });
}
function stop() {
  if (ps) { try { ps.kill(); } catch (e) {} ps = null; }
  latest = null; startup = null; history = [];
  // a new sampler sends every path and icon again
  Object.keys(pidPath).forEach(function (k) { delete pidPath[k]; });
  Object.keys(icons).forEach(function (k) { delete icons[k]; });
  Object.keys(iconById).forEach(function (k) { delete iconById[k]; });
}
process.on('exit', function () { stop(); [SCRIPT_FILE, CTL_FILE].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} }); });

// One sample's processes as sent to the page. gpus[] follows the Hardware card order; a card the process doesn't use is
// null. withIcons: a process that didn't give its path (another user's, e.g. a second python.exe) borrows the icon of a
// same-named one that did.
function shape(sample, withIcons) {
  const luids = hwstats.cardLuids(), byName = {};
  if (withIcons) sample.procs.forEach(function (r) { const p = pidPath[r.pid], id = p && icons[p.toLowerCase()]; if (id) byName[r.name.toLowerCase()] = id; });
  return sample.procs.map(function (r) {
    const o = { pid: r.pid, name: r.name, cpu: r.cpu, ram: r.ram, ioRead: r.ioRead, ioWrite: r.ioWrite,
      gpus: luids.map(function (l) { const g = l && r.luids[l]; return g ? { vram: g.vram, shared: g.shared, util: g.util } : null; }) };
    if (withIcons) { const path = pidPath[r.pid]; o.icon = path && icons[path.toLowerCase()] || byName[r.name.toLowerCase()] || null; }
    return o;
  });
}
// Latest sample for the /api/processes endpoint. Each call counts as "someone is looking": the sampler goes to FAST_MS.
function get() {
  if (process.platform !== 'win32') return { supported: false, procs: [] };
  lastLook = Date.now();
  if (!ps && !startError && !restartTimer) start();
  setEvery(FAST_MS);
  const fresh = latest && Date.now() - latest.at < STALE_MS;
  return {
    supported: true,
    every: every,
    at: fresh ? latest.at : null,
    warming: !fresh && !!ps,                       // started, first numbers not in yet
    partial: !!(fresh && latest.partial),          // first block: memory values only, CPU % / GPU % / I/O follow ~1.4 s later (AI_SCOPE-059)
    since: ps ? startedAt : null,                  // when the sampler started (with the server; again after a crash)
    samplerPid: ps ? ps.pid : null,                // the sampler's own powershell.exe (its cost shows in its own row)
    error: startError,
    startup: startupTimes(),                      // where a cold start's time went (AI_SCOPE-059)
    cores: os.cpus().length,
    procs: fresh ? shape(latest, true) : [],
  };
}
// The kept samples (last HIST_MS, full ones only) for /api/processes/history: the page fills its 5-minute lines from it
// when it opens or comes back after a gap. Doesn't count as a look.
function getHistory() {
  if (process.platform !== 'win32') return { supported: false, samples: [] };
  return { supported: true, every: every, lastLookAgo: lastLook ? Date.now() - lastLook : null, samples: history.map(function (h) { return { at: h.at, procs: shape(h, false) }; }) };
}
// ms after Node spawned PowerShell: psRunning (script began), firstOutput, partialBlock, fullBlock; and the script's own
// phase times: types (+ how), counters, collect1, cycle1. null while unknown.
function startupTimes() {
  const s = startup; if (!s) return null;
  const rel = t => t ? t - s.spawnAt : null;
  return { psRunning: s.begin ? s.begin - s.spawnAt : null, firstOutput: rel(s.outAt), types: s.types != null ? s.types : null, how: s.how || null,
    counters: s.counters != null ? s.counters : null, collect1: s.collect1 != null ? s.collect1 : null, cycle1: s.cycle1 != null ? s.cycle1 : null,
    partialBlock: rel(s.partialAt), fullBlock: rel(s.fullAt) };
}
// An exe icon (PNG) by the id given in get(); only icons of exes that were running are known (no file paths from the page).
function icon(id) { return /^[0-9a-f]{12}$/.test(id) && iconById[id] || null; }
function supported() { return process.platform === 'win32'; }
module.exports = { start: start, get: get, history: getHistory, icon: icon, supported: supported, _test: { handleBlock: handleBlock, latest: function () { return latest; } } };
