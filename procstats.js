// Per-process stats for the apps AI_SCOPE watches (AI_SCOPE-038; findings in AI_SCOPE-037): VRAM (dedicated + shared)
// and GPU % per card, CPU % and RAM of an app's own processes, instead of whole-computer totals.
// Windows: nvidia-smi can't report per-process memory under WDDM, so the GPU numbers come from the Windows GPU
// performance counters (same source as Task Manager), read through one query kept open in a long-running PowerShell
// loop (procstats.ps1). AI_SCOPE-084 (2026-10-29): RAM / CPU time / I/O for every process come from the SAME
// mechanism proctop.ps1 proved in 059 - one NtQuerySystemInformation(SystemProcessInformation) call per cycle, with
// the I/O rates diffed inside the sampler and CPU % diffed here between two cycles - so no process handle is opened
// and the processes that refuse OpenProcess (strata.exe) are covered like the rest. Per-process fallback handles
// stay for the case where that call does not answer.
// An app's processes = the process listening on its port + all its child processes (e.g. Bionic's model runs
// in a child llama-server.exe). PIDs are looked up again every 10 s (every 4 s while an app has none yet), because
// they change when the app restarts. AI_SCOPE-084: an app whose scope attests 'idle' / 'off' / 'failed' is taken out
// of the watch file entirely - the sampler does no work for an app that is provably using nothing.
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
  // 080 review: util defaults to 0 (a family sample with no engine activity on a card uses 0 % of it) - see the
  // G-line comment in handleBlock; also covers cards the family never touched and the Linux AMD/Intel case,
  // matching get()'s documented rule.
  h.push({ t: r.at, gpus: luids.map(function (l) { const g = l && r.luids[l]; return g ? { vram: g.vram, util: g.util == null ? 0 : g.util } : { vram: 0, util: 0 }; }),
    ram: r.ramUnknown && !r.ram ? null : r.ram, ramPrivate: r.ramUnknown && !r.ramPrivate ? null : r.ramPrivate,
    cpu: r.cpu == null ? null : Math.min(100, r.cpu),
    ioRead: r.ioSeen ? r.ioRead || 0 : null, ioWrite: r.ioSeen ? r.ioWrite || 0 : null });   // AI_SCOPE-076
  if (h.length > HIST) h.shift();
}

// AI_SCOPE-077 (review batch): an offline app really uses nothing, so the mirror tiles should read 0 rather
// than freeze. The APP MODULES (stratastats / lmapi — not this sampler) attest their app's state every poll.
// 077's three values (review batch 2, user 2026-10-28):
//   'live' - app reachable and a model / engine instance is loaded: the sampler is the only history writer;
//            a missed PID/port lookup (PIDs are re-resolved every 15 s) stays a GAP - never a false zero dip.
//   'idle' - app reachable but its OWN API says nothing is loaded: it genuinely uses nothing, so zeros are
//            honest (the tiles sub reads "No Model Loaded").
//   'off'  - app not reachable at all: zeros likewise (sub "<App> Offline").
// AI_SCOPE-080 added three more, also from the app's OWN API (Strata's instance status; LM Studio's model
// state) - they word the load window instead of leaving stale zeros or lonely gaps:
//   'loading'   - a model load is in progress (sub "Loading…")
//   'unloading' - a model unload is in progress (sub "Unloading…")
//   'failed'    - the app's API reports the instance / model in error (sub "Load failed")
// While attested anything but 'live' this module writes explicit zero history points on its own 2 s heartbeat
// (a real reading always wins first), marked `attest` with the state so the tiles can word it; a stale real
// reading (no attestation) is what gives the n/a + draining chart. With 080's tree watch mode the loading
// zeros end early: the app's loading workers (engine manager, launcher - generic runner names) are found via
// their app-named anchors, so real tree numbers start while the runner itself is still being built.
const attested = {};    // key -> 'live' | 'idle' | 'off' | 'loading' | 'unloading' | 'failed', set by the app module each poll
// AI_SCOPE-084 (item 1 of the user's kickoff notes, 2026-10-29): an attestation that says "this app is using
// nothing" also says "nothing to measure", so the app leaves the watch file and the sampler stops working for it.
// Strata open with no model loaded used to run the PowerShell loop around the clock (~0.7 s of work per ~2.7 s
// loop, ~25 % of one core, plus a netstat + snapshot every 4 s while it found no processes). The zero heartbeat
// above already writes the points for 'idle' / 'off' / 'loading' / 'unloading' / 'failed', so the tiles keep their
// wording and their zeros with no sampling at all. A key nobody attests (ComfyUI, Ollama, llama.cpp today) stays
// watched exactly as before. The app modules keep calling watch() every poll, so arming again - the first moment of
// a load - is immediate; the sampler PROCESS is left running, because restarting it costs ~2 s (Add-Type compile +
// opening the PDH query, measured on snow 2026-10-29) and an idle loop costs nothing (procstats.ps1).
const WATCH_STATES = { live: 1, loading: 1, unloading: 1 };
function armed(key) { const s = attested[key]; return s === undefined ? true : !!WATCH_STATES[s]; }
function armedKeys() { return Object.keys(watches).filter(function (k) { return armed(k); }); }
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
  const wasArmed = armed(key);
  attested[key] = state;
  if (state !== 'live' && !zeroTimer) zeroTimer = setInterval(zeroTick, ZERO_EVERY);
  if (armed(key) !== wasArmed) refreshWatch(key);   // 084: idle / off / failed stop the sampling, live / loading / unloading resume it
}
// 084: taking an app out of the watch file (or putting it back). get() must answer null at once, so the tiles
// fall back to the attested zeros instead of freezing on the last real reading.
function refreshWatch(key) {
  if (!armed(key)) { delete results[key]; if (NIX) { delete nixFam[key]; nixResolvedAt = 0; } }
  writeWatchFile();
  if (NIX) { if (armedKeys().length) { if (!nixTimer) { nixTimer = setInterval(nixTick, NIX_EVERY); nixResolvedAt = 0; nixTick(); } } return; }
  if (armedKeys().length) startLoop();   // an already running loop just reads the shorter watch file (and idles)
}
function unattest(key) { delete attested[key]; }

// The PowerShell side lives in procstats.ps1 (output format described there).
const PS_FILE = path.join(__dirname, 'procstats.ps1');

function writeWatchFile() {
  // 084: only the armed apps go in the file - an app whose scope attests 'idle' / 'off' / 'failed' is not sampled
  const text = Object.keys(watches).filter(function (k) { return armed(k); }).sort().map(function (k) { return k + '|' + watches[k].ports.join(',') + '|' + watches[k].names.join(',') + '|' + (watches[k].tree ? '1' : '0'); }).join('\n');
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
        // 084: the diff only counts across a short gap. After an idle stretch (the app left the watch file,
        // item 2) the remembered CPU time is minutes old and dividing by that span would read as a dip; a
        // cycle's own spacing is ~2 s, so a gap over 8 s is not a sample - it is the resume. The point still
        // carries its real numbers (working set, private, I/O from the sampler's own diff); only CPU waits for
        // the next cycle, which is one 2 s gap in the chart.
        if (prev && now - prev.t > 200 && now - prev.t < 8000) {
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
      // AI_SCOPE-080 (review): when the FAMILY was found, its per-card utilization is known - a card with GPU
      // memory but no GPU Engine instances (allocating weights, idle on the card) is a real 0 %, not "no data".
      // Only whole cycles without a sample leave gaps; only the attested states word it. That also makes the
      // history agree with get()'s documented rule (card not used = { vram: 0, shared: 0, util: 0 }) instead of
      // drawing line breaks + "n/a" in the GPU% chart while the VRAM chart right beside it is rising.
      const g = r.luids[luid] || (r.luids[luid] = { vram: 0, shared: 0, util: 0 });
      g.vram += parseFloat(p[4].replace(',', '.')) || 0;
      g.shared += parseFloat(p[5].replace(',', '.')) || 0;
      if (p[6] !== '') g.util = Math.min(100, g.util + (parseFloat(p[6].replace(',', '.')) || 0));
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
  if (nixBusy || !armedKeys().length) return;
  nixBusy = true;
  procnix.snapshot(function (snap) {
    if (!snap) { nixBusy = false; return; }
    const now = Date.now(), keys = armedKeys();   // 084: an app that attests idle / off / failed is not sampled here either
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
        Object.keys(results).forEach(function (k) { if (!watches[k] || !armed(k)) delete results[k]; });   // 084: a disarmed app answers null at once
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
      Object.keys(nixFam).forEach(function (k) { if (!watches[k] || !armed(k)) delete nixFam[k]; });
      compute();
    });
  });
}

function startLoop() {
  if (NIX) {
    if (!nixTimer && armedKeys().length) { nixTimer = setInterval(nixTick, NIX_EVERY); nixResolvedAt = 0; nixTick(); }
    return;
  }
  if (ps || process.platform !== 'win32' || !armedKeys().length) return;
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
    if (armedKeys().length && !restartTimer) restartTimer = setTimeout(function () { restartTimer = null; startLoop(); }, 10000);
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
// Call again when the port changes. AI_SCOPE-077 batch 3: the port list may be EMPTY while the app's model
// process is already running (a Strata engine loading / unloading, port not listening yet) - the Windows and
// nix resolvers then match by exe NAME if the names are app-specific (never for shared runners like
// llama-server.exe / python.exe, which need a port to attribute them).
// AI_SCOPE-080 opts.tree (Windows; the nix path ignores it for now): the names stop being a filter and become
// ANCHORS - the app's family is its whole process tree: port owner + descendants, the anchor processes
// (e.g. Strata's strata.exe / strata-vision.exe) + their descendants, and the anchors' ANCESTRY chains (the
// engine manager and launcher pythons that do the loading work, found while the port is still unborn).
// Generically-named ancestors (python.exe) are safe here: the app-named child proves the tree is theirs.
// The previous instance's leftover idle engine (no named descendant, not the port owner) stays out.
function watch(key, ports, names, opts) {
  ports = (ports || []).map(Number).filter(function (n) { return n > 0 && n < 65536; });
  names = (names || []).map(String).filter(function (n) { return /^[\w .-]+$/.test(n); });
  const tree = !!(opts && opts.tree);
  const w = watches[key];
  if (w && w.ports.join(',') === ports.join(',') && w.names.join(',') === names.join(',') && !!w.tree === tree) return;
  watches[key] = { ports: ports, names: names, tree: tree };
  if (NIX) nixResolvedAt = 0;
  refreshWatch(key);   // AI_SCOPE-084: the watch file and the sampling only follow while the app's state asks for numbers
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
    gpus: luids.map(function (l) { const g = l && r.luids[l]; return g ? { vram: g.vram, shared: g.shared, util: g.util == null ? 0 : g.util } : { vram: 0, shared: 0, util: 0 }; }),   // 080 review: util 0 when no engine activity, never null (see handleBlock)
    cpu: r.cpu == null ? null : Math.min(100, r.cpu),
    ram: r.ramUnknown && !r.ram ? null : r.ram,
    ramPrivate: r.ramUnknown && !r.ramPrivate ? null : r.ramPrivate,
    ioRead: r.ioSeen ? r.ioRead || 0 : null,     // AI_SCOPE-076: file I/O bytes/sec (Windows counters only)
    ioWrite: r.ioSeen ? r.ioWrite || 0 : null,
  };
}

// Whether per-process stats can work here at all: Windows, Linux, macOS (AI_SCOPE-052).
function supported() { return process.platform === 'win32' || NIX; }
module.exports = { supported: supported, watch: watch, unwatch: unwatch, get: get,
  // 072: 5-min per-app GPU history. AI_SCOPE-084 (item 7): with since > 0 only the points newer than it are
  // sent - web/js/lens.js asks for exactly that, web/js/mirror.js appends what arrives to the ring it holds.
  history: function (key, since) { const h = hist[key] || []; return since ? h.filter(function (p) { return p.t > since; }) : h; },
  attest: attest, unattest: unattest,   // AI_SCOPE-077 review: offline attestation drives the zero heartbeat
  _test: { handleBlock: handleBlock, results: results, nixResolve: nixResolve, nixTick: nixTick } };
