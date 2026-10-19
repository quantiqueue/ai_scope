// Live system stats: CPU %, RAM, GPU % and VRAM. Samples in the background every 2 s
// and keeps ~5 minutes of history. Conservative JS for older Node versions.
'use strict';
const os = require('os');
const execFile = require('child_process').execFile;
const spawn = require('child_process').spawn;

const INTERVAL_MS = 2000;
const HISTORY = 150; // 150 x 2 s = 5 minutes

const history = [];
let lastCpu = null;
let gpuMode = null;      // 'nvidia' | 'windows' | 'none'
let gpuInfo = null;      // latest { name, util, vramUsed, vramTotal }
let gpuBusy = false;
let vramTotalWin = null; // bytes, from registry (Windows counters don't give a total)
let gpuNameWin = null;

// ---- CPU: % busy across all cores since the previous sample ----
function cpuTimes() {
  let idle = 0, total = 0;
  os.cpus().forEach(function (c) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  });
  return { idle: idle, total: total };
}
function cpuPercent() {
  const now = cpuTimes();
  let pct = null;
  if (lastCpu) {
    const dt = now.total - lastCpu.total;
    if (dt > 0) pct = 100 * (1 - (now.idle - lastCpu.idle) / dt);
  }
  lastCpu = now;
  return pct;
}

function run(cmd, args, timeout, cb) {
  execFile(cmd, args, { timeout: timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, function (err, stdout) {
    cb(err, err ? '' : String(stdout));
  });
}

// ---- GPU option 1: NVIDIA (nvidia-smi ships with the driver) ----
function readNvidia(cb) {
  run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], 5000,
    function (err, out) {
      if (err || !out.trim()) return cb(null);
      const gpus = out.trim().split(/\r?\n/).map(function (l) {
        const p = l.split(',').map(function (x) { return x.trim(); });
        return { name: p[0], util: +p[1], vramUsed: +p[2] * 1048576, vramTotal: +p[3] * 1048576 };
      });
      // Combine multiple GPUs into one tile; show the busiest util.
      cb({
        name: gpus.map(function (g) { return g.name; }).join(' + '),
        util: Math.max.apply(null, gpus.map(function (g) { return g.util; })),
        vramUsed: gpus.reduce(function (a, g) { return a + g.vramUsed; }, 0),
        vramTotal: gpus.reduce(function (a, g) { return a + g.vramTotal; }, 0),
      });
    });
}

// ---- GPU option 2: Windows performance counters (any vendor, same source as Task Manager) ----
// One long-running PowerShell prints a block of counter samples every ~2 s, ending with '---'.
// (Much cheaper than starting PowerShell on every poll.)
const PS_COUNTER_LOOP =
  "$ErrorActionPreference='SilentlyContinue';" +
  "while ($true) {" +
  " if (-not (Get-Process -Id __PARENT__ -ErrorAction SilentlyContinue)) { exit };" + // stop if Node is gone
  " $s=(Get-Counter '\\GPU Engine(*)\\Utilization Percentage','\\GPU Adapter Memory(*)\\Dedicated Usage').CounterSamples;" +
  " $s | ForEach-Object { $_.Path + '|' + $_.CookedValue }; '---'; Start-Sleep -Milliseconds 1000 }";

function parseCounterBlock(lines) {
  const byEngine = {}; // engtype -> summed %, like Task Manager
  let vram = 0, seen = false;
  lines.forEach(function (line) {
    const i = line.lastIndexOf('|');
    if (i < 0) return;
    const p = line.slice(0, i).toLowerCase();
    const v = parseFloat(line.slice(i + 1).replace(',', '.')) || 0;
    if (p.indexOf('utilization percentage') >= 0) {
      seen = true;
      const m = /engtype_([a-z0-9 ]+)\)/.exec(p);
      const k = m ? m[1] : 'other';
      byEngine[k] = (byEngine[k] || 0) + v;
    } else if (p.indexOf('dedicated usage') >= 0) {
      seen = true;
      vram += v;
    }
  });
  if (!seen) return null;
  const utils = Object.keys(byEngine).map(function (k) { return byEngine[k]; });
  return {
    name: gpuNameWin || 'GPU',
    util: utils.length ? Math.min(100, Math.max.apply(null, utils)) : 0,
    vramUsed: vram,
    vramTotal: vramTotalWin,
  };
}

// Starts the counter loop; calls onFirst(ok) once the first block arrives (or after a timeout).
function startWindowsCounters(onFirst) {
  let buf = '', block = [], first = true;
  const done = function (ok) { if (first) { first = false; onFirst(ok); } };
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_COUNTER_LOOP.replace('__PARENT__', String(process.pid))], { windowsHide: true });
  ps.on('error', function () { done(false); });
  ps.on('exit', function () { done(false); if (gpuMode === 'windows') setTimeout(function () { startWindowsCounters(function () {}); }, 5000); });
  ps.stdout.on('data', function (d) {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    lines.forEach(function (l) {
      if (l.trim() === '---') {
        const g = parseCounterBlock(block);
        block = [];
        if (g) { gpuInfo = g; done(true); } else done(false);
      } else block.push(l);
    });
  });
  setTimeout(function () { done(false); }, 15000);
  process.on('exit', function () { try { ps.kill(); } catch (e) {} });
}

// Total VRAM + GPU name from the registry (WMI's AdapterRAM caps at 4 GB, so it's wrong for modern cards).
const PS_VRAM_TOTAL =
  "$ErrorActionPreference='SilentlyContinue';" +
  "Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' |" +
  " Where-Object { $_.'HardwareInformation.qwMemorySize' } |" +
  " ForEach-Object { $_.DriverDesc + '|' + $_.'HardwareInformation.qwMemorySize' }";

function detectGpu(cb) {
  readNvidia(function (n) {
    if (n) { gpuMode = 'nvidia'; gpuInfo = n; return cb(); }
    if (process.platform !== 'win32') { gpuMode = 'none'; return cb(); }
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_VRAM_TOTAL], 10000, function (err, out) {
      // Pick the adapter with the most memory (the discrete GPU).
      let best = null;
      out.split(/\r?\n/).forEach(function (l) {
        const i = l.lastIndexOf('|');
        if (i < 0) return;
        const size = +l.slice(i + 1);
        if (size && (!best || size > best.size)) best = { name: l.slice(0, i).trim(), size: size };
      });
      if (best) { gpuNameWin = best.name; vramTotalWin = best.size; }
      gpuMode = 'windows'; // set before start so the loop auto-restarts if it dies
      startWindowsCounters(function (ok) {
        if (!ok) gpuMode = 'none';
        cb();
      });
    });
  });
}

function pollGpu() {
  // Windows counters stream in on their own; only NVIDIA needs polling.
  if (gpuBusy || gpuMode !== 'nvidia') return;
  gpuBusy = true;
  readNvidia(function (g) { gpuBusy = false; if (g) gpuInfo = g; });
}

function sample() {
  const total = os.totalmem(), free = os.freemem();
  const s = {
    t: Date.now(),
    cpu: cpuPercent(),
    ramUsed: total - free,
    ramTotal: total,
    gpu: gpuInfo ? gpuInfo.util : null,
    vramUsed: gpuInfo ? gpuInfo.vramUsed : null,
    vramTotal: gpuInfo ? gpuInfo.vramTotal : null,
  };
  if (s.cpu != null) {
    history.push(s);
    if (history.length > HISTORY) history.shift();
  }
  pollGpu(); // async; result lands in the next sample
}

let started = false;
function start() {
  if (started) return;
  started = true;
  cpuPercent();
  detectGpu(function () { console.log('[system] GPU stats source: ' + gpuMode + (gpuInfo ? ' (' + gpuInfo.name + ')' : '')); });
  setInterval(sample, INTERVAL_MS);
}

function getStats() {
  const cpus = os.cpus();
  return {
    info: {
      cpuModel: cpus.length ? cpus[0].model.trim() : 'CPU',
      cores: cpus.length,
      gpuName: gpuInfo ? gpuInfo.name : null,
      gpuSource: gpuMode,
    },
    intervalMs: INTERVAL_MS,
    history: history,
  };
}

module.exports = { start: start, getStats: getStats };
