// Numbers for every process (AI_SCOPE-023, the Processes scope): CPU %, RAM (working set), and VRAM / GPU % per
// graphics card, for the "top 5 processes" lenses. Windows only, like procstats.js (AI_SCOPE-037/038): one long-running
// PowerShell (proctop.ps1) keeps a PDH query over all processes open and prints a block every few seconds.
// Always warm (AI_SCOPE-059): started with the server and never stopped (restarted after a crash), because its first
// sample costs 5-7 s; it samples every FAST_MS while a Processes lens is looked at and every SLOW_MS otherwise
// (Node tells it through a small control file), and keeps HIST_MS of samples so the lenses' 5-minute lines are full
// when a page opens. Linux / macOS (AI_SCOPE-052): sampled in Node through procnix.js (processes from /proc or `ps`,
// NVIDIA VRAM / GPU % per process from nvidia-smi on Linux; no per-process GPU numbers or I/O on macOS), written as
// the same P / G lines the PowerShell sampler prints, so everything after handleBlock() is shared.
// No dependencies; conservative JS.
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const spawn = require('child_process').spawn;
const crypto = require('crypto');
const hwstats = require('./hwstats');
const procnix = require('./procnix');
const NIX = procnix.supported() && process.platform !== 'win32';

const FAST_MS = 5000;            // while someone looks (a collect over ~340 processes: ~0.4 s, ~1.9 % of a 16-thread CPU at this pace)
let fastMs = FAST_MS;            // AI_SCOPE-010: the settings' "Process Refresh Rate" (seconds), set through setFastMs
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
const sampleHandlers = [];   // AI_SCOPE-084: procstats.js aggregates its families from these samples
let ps = null, lastLook = 0, idleTimer = null, startedAt = 0, latest = null, startError = null;
let every = SLOW_MS, failures = 0, restartTimer = null, history = [];   // history: full (not partial) samples, oldest first
// Start-up timings of the current sampler (AI_SCOPE-059): Node's spawn / first output / first blocks + the script's T lines
let startup = null;

// One block of P / G lines -> { at, procs: [{ pid, name, cpu, ram, luids: { luid: { vram, shared, util } } }] }
function handleBlock(lines) {
  const byPid = {};
  let partial = false;
  const proc = pid => byPid[pid] || (byPid[pid] = { pid: pid, name: '', cpu: null, ram: null, priv: null, ppid: 0, luids: {} });
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
      if (p.length >= 9) r.priv = num(p[8]);         // AI_SCOPE-084: private bytes, for the mirror's RAM (Committed) lens
      if (p.length >= 10) r.ppid = num(p[9]) || 0;   // AI_SCOPE-084: the parent, so procstats.js can resolve an app's process family from this table
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
  // AI_SCOPE-084 (item 3): the app scopes' Hardware Mirror numbers (procstats.js) come from THIS sample rather
  // than a second all-process loop of their own. Subscribers aggregate their own families out of it; a handler
  // that throws never takes the sampler down.
  sampleHandlers.forEach(function (fn) { try { fn(latest); } catch (e) { console.log('[proctop] sample handler failed: ' + e.message); } });
}
// Subscribe to samples ({ at, partial, procs }). Partial blocks (the sampler's first one, CPU % / GPU % / I/O not
// in yet) are passed too - subscribers that need rates check .partial. Returns the unsubscribe function.
function onSample(fn) {
  sampleHandlers.push(fn);
  return function () { const i = sampleHandlers.indexOf(fn); if (i >= 0) sampleHandlers.splice(i, 1); };
}

// One sampler, one rate (AI_SCOPE-084 item 3, the user's rule): the period is the fastest pace anything needs, and
// every lens that shares this source is polled at THAT rate - no faked display cadence. uiEvery is 059's rule
// (fast while a Processes lens is looked at, SLOW_MS after IDLE_MS of nobody looking); demands come from the app
// scopes whose Hardware Mirror lenses sample their processes at 2 s (procstats.js). 060's configurable refresh
// rate will hang off the same two inputs.
let uiEvery = SLOW_MS;
const demands = {};        // key -> ms
function setEvery(ms) {
  if (ms === every && ps) return;
  const faster = ms < every;
  every = ms;
  if (NIX) { if (faster) nixKick(); return; }
  try { fs.writeFileSync(CTL_FILE, String(ms)); } catch (e) {}
}
function computeEvery() {
  let ms = uiEvery;
  Object.keys(demands).forEach(function (k) { if (demands[k] < ms) ms = demands[k]; });
  setEvery(ms);
}
function setLooked(ms) { uiEvery = ms; computeEvery(); }
// Ask for a pace while an app scope needs numbers; release it when its watchers go quiet.
function demand(key, ms) {
  const n = Math.max(500, Math.min(60000, Math.round(ms)));
  if (demands[key] === n) return;
  demands[key] = n;
  computeEvery();
}
function release(key) {
  if (demands[key] === undefined) return;
  delete demands[key];
  computeEvery();
}
// AI_SCOPE-010's "Process Refresh Rate": the watched pace, in ms (2-60 s). A sampler already on the fast pace
// moves to the new one at once; a cold one stays cold until someone looks.
function setFastMs(ms) {
  const n = Math.max(2000, Math.min(60000, Math.round(ms)));
  const wasOnFastPace = uiEvery === fastMs;
  fastMs = n;
  if (wasOnFastPace) setLooked(fastMs);
}

// ---------- Linux / macOS sampler (AI_SCOPE-052) ----------
// Every `every` ms: one snapshot of all processes (+ nvidia-smi on Linux), turned into P / G lines for handleBlock().
// The first block comes at once with the plain values (W|partial, like AI_SCOPE-059's first block), the rates 1 s later.
let nixTimer = null, nixPrev = null, nixSnap = null, nixLast = 0, nixBusy = false;
function nixCycle(first) {
  nixTimer = null;
  if (!ps || nixBusy) return;
  nixBusy = true;
  procnix.snapshot(function (snap) {
    const finish = function (gpu) {
      nixBusy = false;
      if (!ps) return;
      nixLast = Date.now();
      if (snap) {
        const cores = os.cpus().length || 1, prev = nixPrev, dt = prev ? (snap.at - prev.at) / 1000 : 0, lines = [];
        if (first || !prev) lines.push('W|partial');
        Object.keys(snap.procs).forEach(function (k) {
          const p = snap.procs[k], o = prev && dt > 0.2 && prev.procs[k] && prev.procs[k].start === p.start ? prev.procs[k] : null;
          const rate = function (a, b) { return o && a != null && b != null ? String(Math.max(0, (a - b) / dt)) : ''; };
          lines.push('P|' + p.pid + '|' + String(p.name).replace(/\|/g, '/') + '|' + (o ? String(Math.max(0, 100 * (p.cpu - o.cpu) / dt / cores)) : '') + '|' +
            (p.rss || 0) + '||' + rate(p.ioR, o && o.ioR) + '|' + rate(p.ioW, o && o.ioW) + '|' +
            (p.priv == null ? '' : String(p.priv)) + '|' + (p.ppid || 0));   // 084: the same 9th / 10th fields the Windows sampler sends
          const g = gpu && gpu[k];
          if (g) Object.keys(g).forEach(function (card) { lines.push('G|' + p.pid + '|' + card + '|' + g[card].vram + '|0|' + (g[card].util == null ? '' : g[card].util)); });
        });
        if (first && startup) { startup.begin = startup.spawnAt; startup.how = 'node'; }
        handleBlock(lines);
        nixPrev = snap;
        nixSnap = snap;   // AI_SCOPE-084: procstats.js resolves families out of THIS snapshot instead of taking its own
      }
      nixTimer = setTimeout(function () { nixCycle(false); }, first ? 1000 : every);
    };
    if (!snap) return finish(null);
    procnix.nvidia(finish);   // Linux: VRAM per process at once; GPU % from a ~1 s sample
  });
}
// A faster pace (someone opened a Processes lens): take the next sample now (at least 1 s after the last one).
function nixKick() {
  if (!ps || nixBusy) return;
  if (nixTimer) clearTimeout(nixTimer);
  nixTimer = setTimeout(function () { nixCycle(false); }, Math.max(0, 1000 - (Date.now() - nixLast)));
}
function startNix() {
  ps = { pid: process.pid, kill: function () { if (nixTimer) clearTimeout(nixTimer); nixTimer = null; } };   // sampled in this process
  startedAt = Date.now(); startError = null; startup = { spawnAt: startedAt }; nixPrev = null;
  nixCycle(true);
}

function start() {
  if (ps) return;
  if (NIX) {
    if (!idleTimer) idleTimer = setInterval(function () { if (ps && uiEvery !== SLOW_MS && Date.now() - lastLook > IDLE_MS) setLooked(SLOW_MS); }, 5000);
    return startNix();
  }
  if (process.platform !== 'win32') return;
  if (!idleTimer) idleTimer = setInterval(function () { if (ps && uiEvery !== SLOW_MS && Date.now() - lastLook > IDLE_MS) setLooked(SLOW_MS); }, 5000);
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
  const luids = hwstats.cardKeys(), byName = {};
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
  if (!supported()) return { supported: false, procs: [] };
  lastLook = Date.now();
  if (!ps && !startError && !restartTimer) start();
  setLooked(fastMs);   // AI_SCOPE-084: a look sets the UI pace; a demand from an app scope can still be faster
  const fresh = latest && Date.now() - latest.at < STALE_MS;
  return {
    supported: true,
    every: every,
    at: fresh ? latest.at : null,
    warming: !fresh && !!ps,                       // started, first numbers not in yet
    partial: !!(fresh && latest.partial),          // first block: memory values only, CPU % / GPU % / I/O follow ~1.4 s later (AI_SCOPE-059)
    since: ps ? startedAt : null,                  // when the sampler started (with the server; again after a crash)
    samplerPid: ps ? ps.pid : null,                // the sampler's own process (powershell.exe; on Linux / macOS AI_SCOPE's own node)
    // which lenses this system can fill (AI_SCOPE-052): per-process GPU numbers (Windows; Linux with NVIDIA), shared GPU memory
    // (Windows only: nvidia-smi has no such number) and I/O (not macOS)
    has: { gpu: hwstats.cardKeys().some(Boolean), shared: process.platform === 'win32', io: process.platform !== 'darwin' },
    error: startError,
    startup: startupTimes(),                      // where a cold start's time went (AI_SCOPE-059)
    cores: os.cpus().length,
    procs: fresh ? shape(latest, true) : [],
  };
}
// The kept samples (last HIST_MS, full ones only) for /api/processes/history: the page fills its 5-minute lines from it
// when it opens or comes back after a gap. Doesn't count as a look.
function getHistory() {
  if (!supported()) return { supported: false, samples: [] };
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
function supported() { return process.platform === 'win32' || NIX; }
module.exports = { start: start, get: get, history: getHistory, icon: icon, supported: supported, setFastMs: setFastMs,
  onSample: onSample, demand: demand, release: release,   // AI_SCOPE-084 item 3: shared samples and the shared pace
  snapshot: function () { return NIX ? nixSnap : null; },   // the procnix snapshot behind the last sample (family resolving)
  _test: { handleBlock: handleBlock, latest: function () { return latest; } } };
