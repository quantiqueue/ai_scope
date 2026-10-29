// Per-process stats for the apps AI_SCOPE watches (AI_SCOPE-038; findings in AI_SCOPE-037): VRAM (dedicated + shared)
// and GPU % per card, CPU % and RAM of an app's own processes, instead of whole-computer totals.
// AI_SCOPE-084 item 3 (2026-10-29, the user's "one shared sampler" end state): the NUMBERS for every process come
// from proctop.js / proctop.ps1 - one all-process sample per cycle for the whole app (059's loop) - and this module
// only answers WHICH processes belong to each watched app, then aggregates those rows over the family. Before this,
// procstats ran a second all-process walk plus its own PDH query every 2 s: measured on snow, 8.0 % of one core for
// this child against proctop's 0.7 %. CPU % / I/O rates and the reused-PID protection (each process's creation time)
// are proctop's, so the per-cycle handle reading and CPU diffing that used to live here are gone, and
// procstats.ps1 no longer measures anything (its C# is the port table and the parent / name table only).
// Windows: the family comes from procstats.ps1 (port owner + children, or with the 080 tree flag the app-named
// anchors + their descendants + ancestry chains). Linux / macOS (AI_SCOPE-052): the same rules applied by
// nixResolve() to the procnix snapshot proctop.js already took, so neither platform samples twice.
// GPU numbers: Windows GPU performance counters read by proctop through ONE PDH query (same source as Task
// Manager); nvidia-smi can't report per-process memory under WDDM (037/038). On Linux, NVIDIA VRAM per process
// from nvidia-smi; macOS has no per-process GPU numbers. Elsewhere get() returns null and callers fall back to
// whole-computer load. No dependencies; conservative JS.
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const spawn = require('child_process').spawn;
const hwstats = require('./hwstats');
const proctop = require('./proctop');
const procnix = require('./procnix');
const NIX = procnix.supported() && process.platform !== 'win32';   // the same test proctop uses for its own sampler

const WATCH_FILE = path.join(os.tmpdir(), 'ai_scope-procwatch-' + process.pid + '.txt');
// The filled-in script is run from a temp file: passed with -EncodedCommand it outgrew Windows' 32,767-character
// command-line limit (spawn ENAMETOOLONG, which crashed the server - AI_SCOPE-051).
const SCRIPT_FILE = path.join(os.tmpdir(), 'ai_scope-procstats-' + process.pid + '.ps1');
const STALE_MS = 8000;
const MIRROR_MS = 2000;     // the pace the mirror lenses want (084): the family is aggregated once per proctop sample
const watches = {};     // key -> { ports, names, tree }  (what the app modules asked for)
const fams = {};        // key -> { at, pids: [{ pid, name }] }   (WHO the app owns right now)
const results = {};     // key -> { at, pids, luids: { luid: { vram, shared, util } }, cpu, ram, ramPrivate, ioRead, ioWrite }
let ps = null, restartTimer = null;

// AI_SCOPE-072: ~5 minutes of per-app GPU numbers (the Strata scope's GPU / VRAM tiles), same cadence as the
// samples below, Hardware card order, newest last. Only cycles that found the app's processes add a point,
// so a stopped app leaves a gap instead of invented zeros.
// AI_SCOPE-073: each point also carries the process's ram / ramPrivate (bytes, whole family), for the Strata RAM
// lens, and AI_SCOPE-075 adds `cpu` (% of the whole CPU, same clamp as get()). AI_SCOPE-076 adds ioRead / ioWrite
// (file I/O bytes/sec; only the Windows / Linux counter paths fill them, so they are null on macOS).
const HIST = 150;
const hist = {};        // key -> [{ t, gpus: [{ vram, util }], ram, ramPrivate, cpu, ioRead, ioWrite }]
function pushHist(key) {
  const r = results[key];
  if (!r) return;
  const luids = hwstats.cardKeys();
  const h = hist[key] || (hist[key] = []);
  // 075 fix: the point is pushed even when the machine has no detectable graphics cards - the gpus list is
  // simply empty, so the CPU / RAM lenses keep their history there (073's notes already described this, the
  // old `if (luids.length)` guard meant it was not actually true).
  // 080 review: util defaults to 0 (a family sample with no engine activity on a card uses 0 % of it) - see the
  // G-line comment in proctop's rows; also covers cards the family never touched and the Linux AMD/Intel case,
  // matching get()'s documented rule.
  h.push({ t: r.at, gpus: luids.map(function (l) { const g = l && r.luids[l]; return g ? { vram: g.vram, util: g.util == null ? 0 : g.util } : { vram: 0, util: 0 }; }),
    ram: r.ram, ramPrivate: r.ramPrivate,
    cpu: r.cpu == null ? null : Math.min(100, r.cpu),
    ioRead: r.ioSeen ? r.ioRead || 0 : null, ioWrite: r.ioSeen ? r.ioWrite || 0 : null });   // AI_SCOPE-076
  if (h.length > HIST) h.shift();
}

// AI_SCOPE-077 (review batch): an offline app really uses nothing, so the mirror tiles should read 0 rather
// than freeze. The APP MODULES (stratastats / lmapi — not this sampler) attest their app's state every poll.
// 077's three values (review batch 2, user 2026-10-28):
//   'live' - app reachable and a model / engine instance is loaded: the samples are the only history writer;
//            a missed PID/port lookup (families are re-resolved every 10 s, sooner while an app has none) stays
//            a GAP - never a false zero dip.
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
// nothing" also says "nothing to measure", so the app leaves the watch file and the family resolution stops
// working for it. Strata open with no model loaded used to run the sampler loop around the clock (~0.7 s of work
// per ~2.7 s loop, ~25 % of one core, plus a netstat + snapshot every 4 s while it found no processes). The zero
// heartbeat above already writes the points for 'idle' / 'off' / 'loading' / 'unloading' / 'failed', so the tiles
// keep their wording and their zeros with no sampling at all. A key nobody attests (ComfyUI, Ollama, llama.cpp
// today) stays watched exactly as before. The app modules keep calling watch() every poll, so arming again - the
// first moment of a load - is immediate.
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
  if (!armed(key)) { delete results[key]; delete fams[key]; }
  writeWatchFile();
  syncPace();
  if (NIX) nixResolvedAt = 0;
  else if (armedKeys().length) startLoop();   // an already running loop just reads the shorter watch file (and idles)
}
// Ask proctop for its fastest honest pace while anything needs family numbers, and release it when nothing does
// (084: one sampler, one rate - the Processes lenses ride the same period rather than a separate display cadence).
function syncPace() {
  if (!armedKeys().length) { proctop.release('procstats'); return; }
  proctop.start();
  proctop.demand('procstats', MIRROR_MS);
}
function unattest(key) { delete attested[key]; }

// ---------- the family answer (Windows: procstats.ps1) ----------
// The PowerShell side lives in procstats.ps1 (output format described there).
const PS_FILE = path.join(__dirname, 'procstats.ps1');

function writeWatchFile() {
  // 084: only the armed apps go in the file - an app whose scope attests 'idle' / 'off' / 'failed' is not sampled
  const text = Object.keys(watches).filter(function (k) { return armed(k); }).sort().map(function (k) { return k + '|' + watches[k].ports.join(',') + '|' + watches[k].names.join(',') + '|' + (watches[k].tree ? '1' : '0'); }).join('\n');
  try { fs.writeFileSync(WATCH_FILE, text); } catch (e) { /* the loop just sees no apps */ }
}

// One block of F lines: the whole family set for every watched app, replacing what we had. A block with no lines
// for an app means nothing was found for it right now (the mirror keeps its attested wording, 072's rule).
function handleFamBlock(lines) {
  const at = Date.now(), fresh = {};
  lines.forEach(function (l) {
    const p = l.split('|');
    if (p[0] !== 'F' || p.length < 4) return;
    const f = fresh[p[1]] || (fresh[p[1]] = { at: at, pids: [] });
    f.pids.push({ pid: +p[2], name: p[3] });
  });
  Object.keys(fams).forEach(function (k) { if (!fresh[k]) delete fams[k]; });
  Object.keys(fresh).forEach(function (k) { fams[k] = fresh[k]; });
  Object.keys(results).forEach(function (k) { if (!fresh[k]) delete results[k]; });   // no family => no numbers
}

// ---------- the numbers: aggregate one proctop sample over the families (084 item 3) ----------
// One row per process from proctop: { pid, name, cpu (% of the whole CPU), ram (working set), priv (private
// bytes), ioRead / ioWrite (bytes/s), luids: { luid -> { vram, shared, util } } }. Rates and the reused-PID check
// are proctop's (each process's creation time), so nothing is diffed here.
function aggregate(sample) {
  if (!sample || sample.partial) return;   // proctop's first block carries no rates (059)
  const rows = {};
  sample.procs.forEach(function (r) { rows[r.pid] = r; });
  armedKeys().forEach(function (k) {
    const fam = fams[k];
    if (!fam || !fam.pids.length) { delete results[k]; return; }
    const r = { at: sample.at, pids: [], luids: {}, cpu: null, ram: 0, ramPrivate: 0, ioRead: 0, ioWrite: 0, ioSeen: false, privSeen: false };
    fam.pids.forEach(function (x) {
      const row = rows[x.pid];
      if (!row) return;   // gone between re-resolves: no invented numbers, and the tile keeps the family it did find
      r.pids.push({ pid: row.pid || x.pid, name: row.name || x.name });
      if (row.cpu != null) r.cpu = (r.cpu || 0) + row.cpu;
      if (row.ram != null) r.ram += row.ram;
      if (row.priv != null) { r.ramPrivate += row.priv; r.privSeen = true; }
      if (row.ioRead != null || row.ioWrite != null) { r.ioSeen = true; r.ioRead += row.ioRead || 0; r.ioWrite += row.ioWrite || 0; }
      Object.keys(row.luids || {}).forEach(function (l) {
        const g = row.luids[l], o = r.luids[l] || (r.luids[l] = { vram: 0, shared: 0, util: 0 });
        o.vram += g.vram || 0; o.shared += g.shared || 0;
        if (g.util != null) o.util = Math.min(100, o.util + g.util);   // summed over the family, capped like get()
      });
    });
    if (!r.pids.length) { delete results[k]; return; }
    if (!r.privSeen) r.ramPrivate = r.ram;   // macOS: no private / resident split (052)
    results[k] = r;
    pushHist(k);   // 072: a point for every sample that found the app's processes
  });
  Object.keys(results).forEach(function (k) { if (!watches[k] || !armed(k) || !fams[k]) delete results[k]; });
}
proctop.onSample(aggregate);

// ---------- family resolving on Linux / macOS (AI_SCOPE-052, now reading proctop's snapshot) ----------
const NIX_RESOLVE = 10000, NIX_RESOLVE_MISSING = 4000;
// Model runners that several apps start (Bionic, Ollama and a llama.cpp server all run llama-server): when an app is
// found by name only, these only count if one of their parent processes is named after the app.
const GENERIC = { 'llama-server': 1, 'python': 1, 'python3': 1, 'node': 1 };
let nixResolvedAt = 0;
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
function nixFamilies(sample) {
  const snap = proctop.snapshot();
  if (!snap || !sample) return;
  const now = Date.now(), keys = armedKeys();
  if (!keys.length) return;
  const missing = keys.some(function (k) { return !(fams[k] && fams[k].pids.length); });
  if (now - nixResolvedAt < (missing ? NIX_RESOLVE_MISSING : NIX_RESOLVE)) return;
  nixResolvedAt = now;
  let ports = [];
  keys.forEach(function (k) { watches[k].ports.forEach(function (p) { if (ports.indexOf(p) < 0) ports.push(p); }); });
  procnix.portOwners(ports, function (owners) {
    keys.forEach(function (k) {
      const pids = nixResolve(snap, owners, k, watches[k]);
      fams[k] = { at: now, pids: pids.map(function (pid) { return { pid: pid, name: String((snap.procs[pid] || {}).name || '') }; }) };
    });
  });
}

let buf = '', block = [];   // the stdout line buffer of the membership loop
function startLoop() {
  if (NIX || ps || process.platform !== 'win32' || !armedKeys().length) return;
  let src; try { src = fs.readFileSync(PS_FILE, 'utf8'); } catch (e) { return; }
  const fill = function (text, k, v) { return text.split(k).join(v); };
  // __FILE__ is the watch file, __PARENT__ this process (the script exits when we die, so a server crash can't
  // leave a sampler running). 084 slimmed the script down to membership, so it no longer takes __LUIDS__.
  const script = fill(fill(src, '__FILE__', WATCH_FILE.replace(/'/g, "''")), '__PARENT__', String(process.pid));
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
    if (ps !== child) return;   // replaced by a newer loop
    ps = null;
    if (armedKeys().length && !restartTimer) restartTimer = setTimeout(function () { restartTimer = null; startLoop(); }, 10000);
  });
  child.stdout.on('data', function (d) {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    lines.forEach(function (l) {
      if (l.trim() === '---') { handleFamBlock(block); block = []; } else if (l.trim()) block.push(l.trim());
    });
  });
}
function stopLoop() { if (ps) { try { ps.kill(); } catch (e) {} ps = null; } }
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
  delete watches[key]; delete results[key]; delete fams[key];
  if (!NIX) writeWatchFile(); else nixResolvedAt = 0;
  syncPace();
}
// The family for a key (mostly for diagnostics / tests).
function family(key) { return fams[key] || null; }

// Latest numbers for an app, or null (unsupported system, app not found, or no fresh sample). gpus[] follows the
// Hardware card order (info.gpus); a card the app doesn't use, or one without per-process numbers (Linux AMD / Intel
// for now), is { vram: 0, shared: 0, util: 0 }.
function get(key) {
  const r = results[key];
  if (!r || Date.now() - r.at > STALE_MS) return null;
  const luids = hwstats.cardKeys();
  return {
    pids: r.pids,
    gpus: luids.map(function (l) { const g = l && r.luids[l]; return g ? { vram: g.vram, shared: g.shared, util: g.util == null ? 0 : g.util } : { vram: 0, shared: 0, util: 0 }; }),   // 080 review: util 0 when no engine activity, never null (see aggregate)
    cpu: r.cpu == null ? null : Math.min(100, r.cpu),
    ram: r.ram, ramPrivate: r.ramPrivate,
    ioRead: r.ioSeen ? r.ioRead || 0 : null,     // AI_SCOPE-076: file I/O bytes/sec (not on macOS)
    ioWrite: r.ioSeen ? r.ioWrite || 0 : null,
  };
}

// Whether per-process stats can work here at all: Windows, Linux, macOS (AI_SCOPE-052).
function supported() { return process.platform === 'win32' || procnix.supported(); }
module.exports = { supported: supported, watch: watch, unwatch: unwatch, get: get, family: family,
  // 072: 5-min per-app GPU history. AI_SCOPE-084 (item 7): with since > 0 only the points newer than it are
  // sent - web/js/lens.js asks for exactly that, web/js/mirror.js appends what arrives to the ring it holds.
  history: function (key, since) { const h = hist[key] || []; return since ? h.filter(function (p) { return p.t > since; }) : h; },
  attest: attest, unattest: unattest,   // AI_SCOPE-077 review: offline attestation drives the zero heartbeat
  _test: { handleFamBlock: handleFamBlock, aggregate: aggregate, results: results, fams: fams, nixResolve: nixResolve } };
