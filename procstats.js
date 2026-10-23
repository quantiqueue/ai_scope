// Per-process stats for the apps AI_SCOPE watches (AI_SCOPE-038; findings in AI_SCOPE-037): VRAM (dedicated + shared)
// and GPU % per card, CPU % and RAM of an app's own processes, instead of whole-computer totals.
// Windows only: nvidia-smi can't report per-process memory under WDDM, so this uses the Windows GPU performance
// counters (same source as Task Manager), read through counter objects kept open in one long-running PowerShell
// (each read well under 1 ms), plus OpenProcess/GetProcessMemoryInfo/GetProcessTimes for RAM and CPU.
// An app's processes = the process listening on its port + all its child processes (e.g. Bionic's model runs
// in a child llama-server.exe). PIDs are looked up again every 15 s, because they change when the app restarts.
// Other platforms: get() returns null and callers fall back to whole-computer load. No dependencies; conservative JS.
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const spawn = require('child_process').spawn;
const hwstats = require('./hwstats');

const WATCH_FILE = path.join(os.tmpdir(), 'ai_scope-procwatch-' + process.pid + '.txt');
const STALE_MS = 8000;
const watches = {};     // key -> [ports]
const results = {};     // key -> { at, pids: [{ pid, name }], luids: { luid: { vram, shared, util } }, cpu, ram, ramPrivate }
const lastCpu = {};     // pid -> { t, cpu (100 ns units) }
let ps = null, luidsKey = null, restartTimer = null;

// The PowerShell side lives in procstats.ps1 (output format described there).
const PS_FILE = path.join(__dirname, 'procstats.ps1');

function writeWatchFile() {
  const text = Object.keys(watches).sort().map(function (k) { return k + '|' + watches[k].join(','); }).join('\n');
  try { fs.writeFileSync(WATCH_FILE, text); } catch (e) { /* the loop just sees no apps */ }
}

function handleBlock(lines) {
  const now = Date.now(), fresh = {};
  lines.forEach(function (l) {
    const p = l.split('|');
    const r = fresh[p[1]] || (fresh[p[1]] = { at: now, pids: [], luids: {}, cpu: null, ram: 0, ramPrivate: 0 });
    if (p[0] === 'P' && p.length >= 7) {
      const pid = +p[2], cpu = p[6] === '' ? null : +p[6];
      r.pids.push({ pid: pid, name: p[3] });
      r.ram += +p[4] || 0; r.ramPrivate += +p[5] || 0;
      const prev = lastCpu[pid];
      if (cpu != null) {
        if (prev && now > prev.t) {
          // CPU time used since the last sample, as % of the whole CPU (all cores), like Task Manager
          const pct = 100 * ((cpu - prev.cpu) / 10000) / (now - prev.t) / (os.cpus().length || 1);
          r.cpu = (r.cpu || 0) + Math.max(0, pct);
        }
        lastCpu[pid] = { t: now, cpu: cpu };
      }
    } else if (p[0] === 'G' && p.length >= 7) {
      const luid = p[3].toLowerCase();
      const g = r.luids[luid] || (r.luids[luid] = { vram: 0, shared: 0, util: null });
      g.vram += parseFloat(p[4].replace(',', '.')) || 0;
      g.shared += parseFloat(p[5].replace(',', '.')) || 0;
      if (p[6] !== '') g.util = Math.min(100, (g.util || 0) + (parseFloat(p[6].replace(',', '.')) || 0));
    }
  });
  Object.keys(results).forEach(function (k) { if (!fresh[k]) delete results[k]; });
  Object.keys(fresh).forEach(function (k) { if (fresh[k].pids.length) results[k] = fresh[k]; });
}

function startLoop() {
  if (ps || process.platform !== 'win32' || !Object.keys(watches).length) return;
  const luids = hwstats.cardLuids().filter(Boolean);
  if (!luids.length) { if (!restartTimer) restartTimer = setTimeout(function () { restartTimer = null; startLoop(); }, 5000); return; }  // cards not detected yet
  luidsKey = luids.join(',');
  let src; try { src = fs.readFileSync(PS_FILE, 'utf8'); } catch (e) { return; }
  const fill = function (text, k, v) { return text.split(k).join(v); };
  const script = fill(fill(fill(src, '__LUIDS__', luids.map(function (l) { return l.toUpperCase(); }).join(',')),
    '__FILE__', WATCH_FILE.replace(/'/g, "''")), '__PARENT__', String(process.pid));
  let buf = '', block = [];
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  ps = child;
  child.on('error', function () { if (ps === child) ps = null; });
  child.on('exit', function () {
    if (ps !== child) return;   // replaced by a newer loop (card list changed)
    ps = null;
    if (Object.keys(watches).length && !restartTimer) restartTimer = setTimeout(function () { restartTimer = null; startLoop(); }, 10000);
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
function stopLoop() { if (ps) { try { ps.kill(); } catch (e) {} ps = null; } }
process.on('exit', function () { stopLoop(); try { fs.unlinkSync(WATCH_FILE); } catch (e) {} });

// Watch an app's processes: key (e.g. 'comfyui') and the port(s) it listens on. Call again when the port changes.
function watch(key, ports) {
  ports = (ports || []).map(Number).filter(function (n) { return n > 0 && n < 65536; });
  if (watches[key] && watches[key].join(',') === ports.join(',')) return;
  watches[key] = ports;
  writeWatchFile();
  startLoop();
}
function unwatch(key) {
  if (!watches[key]) return;
  delete watches[key]; delete results[key];
  writeWatchFile();
  if (!Object.keys(watches).length) stopLoop();
}

// Latest numbers for an app, or null (not Windows, app not found, or no fresh sample). gpus[] follows the
// Hardware card order (info.gpus); a card the app doesn't use is { vram: 0, shared: 0, util: 0 }.
function get(key) {
  const r = results[key];
  if (!r || Date.now() - r.at > STALE_MS) return null;
  const luids = hwstats.cardLuids();
  if (ps && luids.filter(Boolean).join(',') !== luidsKey) { stopLoop(); startLoop(); }   // card list changed
  return {
    pids: r.pids,
    gpus: luids.map(function (l) { const g = l && r.luids[l]; return g ? { vram: g.vram, shared: g.shared, util: g.util } : { vram: 0, shared: 0, util: 0 }; }),
    cpu: r.cpu == null ? null : Math.min(100, r.cpu),
    ram: r.ram,
    ramPrivate: r.ramPrivate,
  };
}

module.exports = { watch: watch, unwatch: unwatch, get: get, _test: { handleBlock: handleBlock, results: results } };
