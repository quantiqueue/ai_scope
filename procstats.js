// Per-process stats for the apps AI_SCOPE watches (AI_SCOPE-038; findings in AI_SCOPE-037): VRAM (dedicated + shared)
// and GPU % per card, CPU % and RAM of an app's own processes, instead of whole-computer totals.
// Windows only: nvidia-smi can't report per-process memory under WDDM, so this uses the Windows GPU performance
// counters (same source as Task Manager), read through counter objects kept open in one long-running PowerShell
// (each read well under 1 ms), plus OpenProcess/GetProcessMemoryInfo/GetProcessTimes for RAM and CPU.
// An app's processes = the process listening on its port + all its child processes (e.g. Bionic's model runs
// in a child llama-server.exe). PIDs are looked up again every 15 s, because they change when the app restarts.
// Linux / macOS (AI_SCOPE-052): the same numbers from procnix.js - processes from /proc or `ps`, the port owner from
// /proc/net/tcp or `lsof` (falling back to the process name when the owner belongs to another user, e.g. Ollama's
// `ollama` service user), NVIDIA VRAM / GPU % per process from nvidia-smi on Linux; macOS has no per-process GPU numbers.
// Elsewhere get() returns null and callers fall back to whole-computer load. No dependencies; conservative JS.
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const spawn = require('child_process').spawn;
const hwstats = require('./hwstats');
const procnix = require('./procnix');
const NIX = procnix.supported();

const WATCH_FILE = path.join(os.tmpdir(), 'ai_scope-procwatch-' + process.pid + '.txt');
// The filled-in script is run from a temp file: passed with -EncodedCommand it outgrew Windows' 32,767-character
// command-line limit (spawn ENAMETOOLONG, which crashed the server - AI_SCOPE-051).
const SCRIPT_FILE = path.join(os.tmpdir(), 'ai_scope-procstats-' + process.pid + '.ps1');
const STALE_MS = 8000;
const watches = {};     // key -> [ports]
const results = {};     // key -> { at, pids: [{ pid, name }], luids: { luid: { vram, shared, util } }, cpu, ram, ramPrivate }
const lastCpu = {};     // pid -> { t, cpu (100 ns units) }
let ps = null, luidsKey = null, restartTimer = null;

// AI_SCOPE-072: ~5 minutes of per-app GPU numbers (the Strata scope's GPU / VRAM tiles), same cadence as the
// samples below, Hardware card order, newest last. Only cycles that found the app's processes add a point,
// so a stopped app leaves a gap instead of invented zeros.
// AI_SCOPE-073: each point also carries the process's ram / ramPrivate (bytes, whole family — same rule as
// get(): null when the process refused OpenProcess), for the Strata RAM lens, and AI_SCOPE-075 adds `cpu`
// (% of the whole CPU, same clamp as get()). AI_SCOPE-076 adds ioRead / ioWrite (file I/O bytes/sec; only the
// Windows counter path fills them, so they are null on Linux / macOS).
const HIST = 150;
const hist = {};        // key -> [{ t, gpus: [{ vram, util }], ram, ramPrivate, cpu }]
function pushHist(key) {
  const r = results[key];
  if (!r) return;
  const luids = hwstats.cardKeys();
  const h = hist[key] || (hist[key] = []);
  // 075 fix: the point is pushed even when the machine has no detectable graphics cards - the gpus list is
  // simply empty, so the CPU / RAM lenses keep their history there (073's notes already described this, the
  // old `if (luids.length)` guard meant it was not actually true).
  h.push({ t: r.at, gpus: luids.map(function (l) { const g = l && r.luids[l]; return g ? { vram: g.vram, util: g.util } : { vram: 0, util: null }; }),
    ram: r.ramUnknown && !r.ram ? null : r.ram, ramPrivate: r.ramUnknown && !r.ramPrivate ? null : r.ramPrivate,
    cpu: r.cpu == null ? null : Math.min(100, r.cpu),
    ioRead: r.ioSeen ? r.ioRead || 0 : null, ioWrite: r.ioSeen ? r.ioWrite || 0 : null });   // AI_SCOPE-076
  if (h.length > HIST) h.shift();
}

// AI_SCOPE-077 (review batch): an offline app really uses nothing, so the mirror tiles should read 0 rather
// than freeze. The APP MODULES (stratastats / lmapi — not this sampler) attest their app's state every poll,
// three-valued (review batch 2, user 2026-10-28):
//   'live' - app reachable and a model / engine instance is loaded: the sampler is the only history writer;
//            a missed PID/port lookup (PIDs are re-resolved every 15 s) stays a GAP - never a false zero dip.
//   'idle' - app reachable but its OWN API says nothing is loaded: it genuinely uses nothing, so zeros are
//            honest (the tiles sub reads "No Model Loaded").
//   'off'  - app not reachable at all: zeros likewise (sub "<App> Offline").
// While attested 'idle' or 'off' this module writes explicit zero history points on its own 2 s heartbeat,
// marked `attest: 'idle' | 'off'` so the tiles can word the state; a stale real reading (no attestation) is
// what gives the n/a + draining chart.
const attested = {};    // key -> 'live' | 'idle' | 'off', set by the app module each poll
let zeroTimer = null;
const ZERO_EVERY = 2000;
function zeroTick() {
  const now = Date.now(), luids = hwstats.cardKeys(), win = process.platform === 'win32';
  let waiting = false;
  Object.keys(attested).forEach(function (k) {
    if (attested[k] === 'live') return;
    waiting = true;
    const r = results[k];
    if (r && now - r.at < 3000) return;                       // a real reading (model on its way out) still wins
    const h = hist[k] || (hist[k] = []);
    const last = h[h.length - 1];
    if (last && last.attest && now - last.t < ZERO_EVERY - 500) return;   // don't stack two zeros in one tick
    h.push({ t: now, attest: attested[k], gpus: luids.map(function () { return { vram: 0, util: 0 }; }),
      ram: 0, ramPrivate: 0, cpu: 0, ioRead: win ? 0 : null, ioWrite: win ? 0 : null });
    if (h.length > HIST) h.shift();
  });
  if (!waiting && zeroTimer) { clearInterval(zeroTimer); zeroTimer = null; }
}
function attest(key, state) {
  if (attested[key] === state) return;
  attested[key] = state;
  if (state !== 'live' && !zeroTimer) zeroTimer = setInterval(zeroTick, ZERO_EVERY);
}
function unattest(key) { delete attested[key]; }

// The PowerShell side lives in procstats.ps1 (output format described there).
const PS_FILE = path.join(__dirname, 'procstats.ps1');

function writeWatchFile() {
  const text = Object.keys(watches).sort().map(function (k) { return k + '|' + watches[k].ports.join(',') + '|' + watches[k].names.join(','); }).join('\n');
  try { fs.writeFileSync(WATCH_FILE, text); } catch (e) { /* the loop just sees no apps */ }
}

function handleBlock(lines) {
  const now = Date.now(), fresh = {};
  lines.forEach(function (l) {
    const p = l.split('|');
    const r = fresh[p[1]] || (fresh[p[1]] = { at: now, pids: [], luids: {}, cpu: null, ram: 0, ramPrivate: 0 });
    if (p[0] === 'P' && p.length >= 7) {
      const pid = +p[2], cpu = p[6] === '' ? null : +p[6];
      // 8th field: CPU % straight from the process counters (process refused OpenProcess, so no CPU time to diff)
      if (p.length >= 8 && p[7] !== '') { const c = parseFloat(p[7].replace(',', '.')); if (isFinite(c)) r.cpu = (r.cpu || 0) + Math.max(0, c); }
      r.pids.push({ pid: pid, name: p[3] });
      if (p[4] === '') r.ramUnknown = true;   // the process refused OpenProcess: GPU numbers only
      r.ram += +p[4] || 0; r.ramPrivate += +p[5] || 0;
      const ck = p[1] + ':' + pid;   // per key: one process can be watched under two keys (llama.cpp router + its model)
      const prev = lastCpu[ck];
      if (cpu != null) {
        if (prev && now > prev.t) {
          // CPU time used since the last sample, as % of the whole CPU (all cores), like Task Manager
          const pct = 100 * ((cpu - prev.cpu) / 10000) / (now - prev.t) / (os.cpus().length || 1);
          r.cpu = (r.cpu || 0) + Math.max(0, pct);
        }
        lastCpu[ck] = { t: now, cpu: cpu };
      }
    } else if (p[0] === 'I' && p.length >= 5) {   // AI_SCOPE-076: file I/O rates (bytes/sec) for one process
      r.ioRead = (r.ioRead || 0) + (p[3] === '' ? 0 : parseFloat(p[3].replace(',', '.')) || 0);
      r.ioWrite = (r.ioWrite || 0) + (p[4] === '' ? 0 : parseFloat(p[4].replace(',', '.')) || 0);
      if (p[3] !== '' || p[4] !== '') r.ioSeen = true;
    } else if (p[0] === 'G' && p.length >= 7) {
      const luid = p[3].toLowerCase();
      const g = r.luids[luid] || (r.luids[luid] = { vram: 0, shared: 0, util: null });
      g.vram += parseFloat(p[4].replace(',', '.')) || 0;
      g.shared += parseFloat(p[5].replace(',', '.')) || 0;
      if (p[6] !== '') g.util = Math.min(100, (g.util || 0) + (parseFloat(p[6].replace(',', '.')) || 0));
    }
  });
  Object.keys(results).forEach(function (k) { if (!fresh[k]) delete results[k]; });
  Object.keys(fresh).forEach(function (k) { if (fresh[k].pids.length) { results[k] = fresh[k]; pushHist(k); } });   // 072: history for every cycle that found the app
}

// ---------- Linux / macOS (AI_SCOPE-052) ----------
const NIX_EVERY = 2000, NIX_RESOLVE = 10000, NIX_RESOLVE_MISSING = 4000;
// Model runners that several apps start (Bionic, Ollama and a llama.cpp server all run llama-server): when an app is
// found by name only, these only count if one of their parent processes is named after the app.
const GENERIC = { 'llama-server': 1, 'python': 1, 'python3': 1, 'node': 1 };
let nixTimer = null, nixBusy = false, nixResolvedAt = 0;
const nixFam = {};    // key -> [pids] (looked up again every NIX_RESOLVE, sooner while an app has none)
const nixPrev = {};   // key:pid -> { t, cpu (s), start } for CPU % between two looks
function nixResolve(snap, owners, key, w) {
  let roots = [];
  w.ports.forEach(function (p) { roots = roots.concat(owners[p] || []); });
  let fam = procnix.family(snap, roots);
  if (w.names.length) fam = fam.filter(function (pid) { return procnix.matches(snap.procs[pid], w.names); });
  if (roots.length || !w.names.length) return fam;
  // Port owner not visible (another user's process): match by name
  const all = Object.keys(snap.procs).map(Number).filter(function (pid) { return procnix.matches(snap.procs[pid], w.names); });
  const app = key.split('-')[0].toLowerCase();
  const underApp = function (pid) {
    for (let p = snap.procs[snap.procs[pid].ppid], n = 0; p && n < 20; p = snap.procs[p.ppid], n++) if (String(p.name).toLowerCase().indexOf(app) >= 0) return true;
    return false;
  };
  return all.filter(function (pid) { return !GENERIC[String(snap.procs[pid].name).toLowerCase().replace(/\.exe$/, '')] || underApp(pid); });
}
function nixTick() {
  if (nixBusy || !Object.keys(watches).length) return;
  nixBusy = true;
  procnix.snapshot(function (snap) {
    if (!snap) { nixBusy = false; return; }
    const now = Date.now(), keys = Object.keys(watches);
    const compute = function () {
      procnix.nvidia(function (gpu) {
        const cores = os.cpus().length || 1;
        keys.forEach(function (k) {
          const pids = (nixFam[k] || []).filter(function (pid) { return snap.procs[pid]; });
          if (!pids.length) { delete results[k]; return; }
          const r = { at: now, pids: [], luids: {}, cpu: null, ram: 0, ramPrivate: null };
          pids.forEach(function (pid) {
            const p = snap.procs[pid], ck = k + ':' + pid, prev = nixPrev[ck];
            r.pids.push({ pid: pid, name: p.name });
            r.ram += p.rss || 0;
            if (p.priv != null) r.ramPrivate = (r.ramPrivate || 0) + p.priv;
            if (prev && prev.start === p.start && now > prev.t) r.cpu = (r.cpu || 0) + Math.max(0, 100 * (p.cpu - prev.cpu) / ((now - prev.t) / 1000) / cores);
            nixPrev[ck] = { t: now, cpu: p.cpu, start: p.start };
            const g = gpu && gpu[pid];
            if (g) Object.keys(g).forEach(function (card) {
              const x = r.luids[card] || (r.luids[card] = { vram: 0, shared: 0, util: null });
              x.vram += g[card].vram; if (g[card].util != null) x.util = Math.min(100, (x.util || 0) + g[card].util);
            });
          });
          if (r.ramPrivate == null) r.ramPrivate = r.ram;   // macOS: no private / resident split
          results[k] = r;
          pushHist(k);   // 072
        });
        Object.keys(results).forEach(function (k) { if (!watches[k]) delete results[k]; });
        Object.keys(nixPrev).forEach(function (ck) { if (!snap.procs[ck.split(':').pop()]) delete nixPrev[ck]; });
        nixBusy = false;
      });
    };
    const missing = keys.some(function (k) { return !(nixFam[k] && nixFam[k].length); });
    if (now - nixResolvedAt < (missing ? NIX_RESOLVE_MISSING : NIX_RESOLVE)) return compute();
    let ports = [];
    keys.forEach(function (k) { watches[k].ports.forEach(function (p) { if (ports.indexOf(p) < 0) ports.push(p); }); });
    procnix.portOwners(ports, function (owners) {
      nixResolvedAt = now;
      keys.forEach(function (k) { nixFam[k] = nixResolve(snap, owners, k, watches[k]); });
      Object.keys(nixFam).forEach(function (k) { if (!watches[k]) delete nixFam[k]; });
      compute();
    });
  });
}

function startLoop() {
  if (NIX) {
    if (!nixTimer && Object.keys(watches).length) { nixTimer = setInterval(nixTick, NIX_EVERY); nixResolvedAt = 0; nixTick(); }
    return;
  }
  if (ps || process.platform !== 'win32' || !Object.keys(watches).length) return;
  const luids = hwstats.cardLuids().filter(Boolean);
  if (!luids.length) { if (!restartTimer) restartTimer = setTimeout(function () { restartTimer = null; startLoop(); }, 5000); return; }  // cards not detected yet
  luidsKey = luids.join(',');
  let src; try { src = fs.readFileSync(PS_FILE, 'utf8'); } catch (e) { return; }
  const fill = function (text, k, v) { return text.split(k).join(v); };
  const script = fill(fill(fill(src, '__LUIDS__', luids.map(function (l) { return l.toUpperCase(); }).join(',')),
    '__FILE__', WATCH_FILE.replace(/'/g, "''")), '__PARENT__', String(process.pid));
  let buf = '', block = [];
  let child;
  try {
    fs.writeFileSync(SCRIPT_FILE, '\ufeff' + script, 'utf8');   // BOM: Windows PowerShell 5.1 reads BOM-less files as ANSI
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_FILE],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {   // never take the server down over per-process stats
    console.log('[procstats] could not start: ' + e.message);
    return;
  }
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
function stopLoop() { if (ps) { try { ps.kill(); } catch (e) {} ps = null; } if (nixTimer) { clearInterval(nixTimer); nixTimer = null; } }
process.on('exit', function () { stopLoop(); try { fs.unlinkSync(WATCH_FILE); } catch (e) {} try { fs.unlinkSync(SCRIPT_FILE); } catch (e) {} });

// Watch an app's processes: key (e.g. 'comfyui'), the port(s) it listens on, and optionally the exe names to count
// (e.g. ['llama-server.exe'] for Bionic, whose model runs in a child process; default: the port owner + all children).
// Call again when the port changes.
function watch(key, ports, names) {
  ports = (ports || []).map(Number).filter(function (n) { return n > 0 && n < 65536; });
  names = (names || []).map(String).filter(function (n) { return /^[\w .-]+$/.test(n); });
  const w = watches[key];
  if (w && w.ports.join(',') === ports.join(',') && w.names.join(',') === names.join(',')) return;
  watches[key] = { ports: ports, names: names };
  if (NIX) nixResolvedAt = 0; else writeWatchFile();   // look the app up again now
  startLoop();
}
function unwatch(key) {
  if (!watches[key]) return;
  delete watches[key]; delete results[key];
  if (!NIX) writeWatchFile();
  if (!Object.keys(watches).length) stopLoop();
}

// Latest numbers for an app, or null (unsupported system, app not found, or no fresh sample). gpus[] follows the
// Hardware card order (info.gpus); a card the app doesn't use, or one without per-process numbers (Linux AMD / Intel
// for now), is { vram: 0, shared: 0, util: 0 }.
function get(key) {
  const r = results[key];
  if (!r || Date.now() - r.at > STALE_MS) return null;
  const luids = hwstats.cardKeys();
  if (ps && luids.filter(Boolean).join(',') !== luidsKey) { stopLoop(); startLoop(); }   // card list changed (Windows)
  return {
    pids: r.pids,
    gpus: luids.map(function (l) { const g = l && r.luids[l]; return g ? { vram: g.vram, shared: g.shared, util: g.util } : { vram: 0, shared: 0, util: 0 }; }),
    cpu: r.cpu == null ? null : Math.min(100, r.cpu),
    ram: r.ramUnknown && !r.ram ? null : r.ram,
    ramPrivate: r.ramUnknown && !r.ramPrivate ? null : r.ramPrivate,
    ioRead: r.ioSeen ? r.ioRead || 0 : null,     // AI_SCOPE-076: file I/O bytes/sec (Windows counters only)
    ioWrite: r.ioSeen ? r.ioWrite || 0 : null,
  };
}

// Whether per-process stats can work here at all: Windows, Linux, macOS (AI_SCOPE-052).
function supported() { return process.platform === 'win32' || NIX; }
module.exports = { supported: supported, watch: watch, unwatch: unwatch, get: get, history: function (key) { return hist[key] || []; },   // 072: 5-min per-app GPU history
  attest: attest, unattest: unattest,   // AI_SCOPE-077 review: offline attestation drives the zero heartbeat
  _test: { handleBlock: handleBlock, results: results, nixResolve: nixResolve, nixTick: nixTick } };
