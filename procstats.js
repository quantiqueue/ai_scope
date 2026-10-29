// Per-process stats for the apps AI_SCOPE watches (AI_SCOPE-038; findings in AI_SCOPE-037): VRAM (dedicated + shared)
// and GPU % per card, CPU % and RAM of an app's own processes, instead of whole-computer totals.
// AI_SCOPE-084 item 3 (2026-10-29, the user's "one shared sampler" end state, shape D): this module measures
// NOTHING of its own. The numbers for every process (CPU %, working set, private bytes, I/O rates, VRAM / GPU %
// per card) and the parent pid of each process all come from ONE proctop.js / proctop.ps1 sample per cycle -
// 059's all-process loop - and the families each app scope owns are resolved here in JS against that table.
// Before this, procstats ran its own PowerShell loop with its own NtQuerySystemInformation walk, PDH query and
// rate diffing (8.0 % of one core on snow against proctop's 0.7 %), and slimming it to membership-only still cost
// 3.3 % because re-resolving a family meant a second CreateToolhelp32Snapshot (125-240 ms) every 4 s for apps
// that are simply not running. That script is gone: Windows now does what the Linux / macOS path has done since
// 052 - resolve families from the sample's own process table - so both platforms share one mechanism, and the
// only external call left is a netstat.exe port table on the re-resolve clock (18 ms).
// The rules themselves are unchanged: the port owner + its children, or with the 080 tree flag the app-named
// anchors + their descendants + ancestry chains, never attributing a shared runner (llama-server / python / node)
// to an app without a port to prove it (077 batch 3, 052's GENERIC list).
// GPU numbers: Windows GPU performance counters read by proctop through ONE PDH query (same source as Task
// Manager); nvidia-smi can't report per-process memory under WDDM (037/038). Linux: NVIDIA VRAM per process from
// nvidia-smi; macOS has no per-process GPU numbers. Elsewhere get() returns null and callers fall back to
// whole-computer load. No dependencies; conservative JS.
'use strict';
const os = require('os');
const execFile = require('child_process').execFile;
const hwstats = require('./hwstats');
const proctop = require('./proctop');
const procnix = require('./procnix');
const NIX = procnix.supported() && process.platform !== 'win32';   // the same test proctop uses for its own sampler

const STALE_MS = 8000;
const MIRROR_MS = 2000;     // the pace the mirror lenses want (084): the family is aggregated once per proctop sample
const RESOLVE_MS = 10000;          // re-resolve families on this clock (PIDs change when an app restarts)
const RESOLVE_MISSING_MS = 4000;   // and faster only while a load may be in progress - see maybeResolveFamilies
const watches = {};     // key -> { ports, names, tree }  (what the app modules asked for)
const fams = {};        // key -> { at, pids: [{ pid, name }] }   (WHO the app owns right now)
const results = {};     // key -> { at, pids, luids: { luid: { vram, shared, util } }, cpu, ram, ramPrivate, ioRead, ioWrite }

// AI_SCOPE-072: ~5 minutes of per-app GPU numbers (the Strata scope's GPU / VRAM tiles), same cadence as the
// samples below, Hardware card order, newest last. Only cycles that found the app's processes add a point,
// so a stopped app leaves a gap instead of invented zeros.
// AI_SCOPE-073: each point also carries the process's ram / ramPrivate (bytes, whole family), for the RAM lens,
// and AI_SCOPE-075 adds `cpu` (% of the whole CPU, same clamp as get()). AI_SCOPE-076 adds ioRead / ioWrite
// (file I/O bytes/sec; not filled on macOS, so they are null there).
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
  // 080 review: util defaults to 0 (a family sample with no engine activity on a card uses 0 % of it) - the
  // sample says which cards a process is on; also covers cards the family never touched and the Linux AMD /
  // Intel case, matching get()'s documented rule.
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
//            a missed PID/port lookup stays a GAP - never a false zero dip.
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
// reading (no attestation) is what gives the n/a + draining chart. With 080's tree mode the loading zeros end
// early: the app's loading workers (engine manager, launcher - generic runner names) are found through their
// app-named anchors, so real tree numbers start while the runner itself is still being built.
const attested = {};    // key -> 'live' | 'idle' | 'off' | 'loading' | 'unloading' | 'failed', set by the app module each poll
// AI_SCOPE-084 (item 2 of the user's kickoff notes, 2026-10-29): an attestation that says "this app is using
// nothing" also says "nothing to measure", so the app stops being resolved at all and the sampler work for it
// stops. The zero heartbeat above already writes the points for 'idle' / 'off' / 'loading' / 'unloading' /
// 'failed', so the tiles keep their wording and their zeros with no sampling. A key nobody attests (ComfyUI,
// Ollama, llama.cpp today) keeps being watched exactly as before. The app modules keep calling watch() every
// poll, so arming again - the first moment of a load - is immediate, and the pace is asked back at once.
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
// 084: taking an app out of the resolution (or putting it back). get() must answer null at once, so the tiles
// fall back to the attested zeros instead of freezing on the last real reading.
function refreshWatch(key) {
  if (!armed(key)) { delete results[key]; delete fams[key]; }
  resolveAt = 0;   // look the app up (or drop it) on the next sample
  syncPace();
}
// Ask proctop for its fastest honest pace while anything needs family numbers, and release it when nothing does
// (084: one sampler, one rate - the Processes lenses ride the same period rather than a separate display cadence).
function syncPace() {
  if (!armedKeys().length) { proctop.release('procstats'); return; }
  proctop.start();
  proctop.demand('procstats', MIRROR_MS);
}
function unattest(key) { delete attested[key]; }

// ---------- whose processes are these? (084 item 3: resolved here, from proctop's own table) ----------
// Runners several apps start: without a listening port to attribute them to, a generic name cannot be counted
// for any app (077 review batch 3; the same list the Linux / macOS path has had since 052).
const GENERIC_WIN = ['llama-server.exe', 'python.exe', 'python3.exe', 'node.exe'];
// 080's ancestry stop list: these parents own arbitrary things, so an app-named child does not attribute them
// to the app (the chain is Windows' / the shell's, not the app's). Compared lower-case, like PowerShell's
// -contains did in the script this replaces.
const STOP_PARENTS = ['explorer.exe', 'services.exe', 'svchost.exe', 'wininit.exe', 'csrss.exe', 'conhost.exe', 'taskhostw.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'wmiprvse.exe', 'memory compression', 'system'];
const lname = r => String((r && r.name) || '').toLowerCase();
let owners = {}, resolveAt = 0, ownersBusy = false;
// port -> pid. netstat.exe is the cheap way in (18 ms; the old script shelled out the same way, and
// Get-NetTCPConnection took 1.5 s - 059's note). Only asked when an armed app actually declares ports.
function portOwners(cb) {
  const ports = [];
  armedKeys().forEach(function (k) { watches[k].ports.forEach(function (p) { if (ports.indexOf(p) < 0) ports.push(p); }); });
  if (!ports.length || ownersBusy) return cb(owners);
  ownersBusy = true;
  execFile('netstat.exe', ['-ano'], { windowsHide: true, encoding: 'utf8' }, function (err, out) {
    ownersBusy = false;
    if (err || !out) return cb(owners);          // keep the previous table; the clock will ask again
    const m = {};
    String(out).split(/\r?\n/).forEach(function (l) {
      const p = l.trim().split(/\s+/);
      if (p[0] !== 'TCP' || p.length < 5 || String(p[3]).toUpperCase() !== 'LISTENING') return;
      const ip = p[1] || '', i = ip.lastIndexOf(':'), port = i > 0 ? +ip.slice(i + 1) : 0, pid = +p[4];
      if (port > 0 && port < 65536 && pid > 0) m[port] = pid;
    });
    owners = m;
    cb(owners);
  });
}
// root + descendants. The C# this replaces scanned the whole parent table for every queued process; an index
// makes it linear and it runs on every re-resolve.
function kidsIndex(rows) {
  const k = {};
  Object.keys(rows).forEach(function (pid) {
    const pp = rows[pid].ppid;
    if (pp > 0) (k[pp] || (k[pp] = [])).push(+pid);
  });
  return k;
}
function familyOf(root, kids) {
  const out = [], seen = {}, q = [root];
  while (q.length) {
    const x = q.shift();
    if (seen[x]) continue;
    seen[x] = 1; out.push(x);
    (kids[x] || []).forEach(function (c) { if (c !== x && !seen[c]) q.push(c); });
  }
  return out;
}
function ancestryOf(pid, rows) {
  const chain = [];
  let cur = pid;
  for (let n = 0; n < 10; n++) {
    const me = rows[cur];
    if (!me || !me.ppid || me.ppid <= 4 || !rows[me.ppid]) break;   // System / Idle / already exited
    if (STOP_PARENTS.indexOf(lname(rows[me.ppid])) >= 0) break;
    chain.push(me.ppid); cur = me.ppid;
  }
  return chain;
}
// The family rules, ported from the old procstats.ps1 Resolve-Apps - same order (sorted keys), same claiming
// (a pid already owned by another key is skipped), same tree / legacy split.
function tableOf(procs) { const t = {}; procs.forEach(function (r) { t[r.pid] = r; }); return t; }
function windowsFamilies(rows, kids, tb) {
  const now = Date.now(), fresh = {};
  let claimed = [];
  Object.keys(watches).filter(armed).sort().forEach(function (key) {
    const w = watches[key];
    let root = 0;
    w.ports.forEach(function (p) { if (!root && tb[p]) root = tb[p]; });
    let fam = root ? familyOf(root, kids) : [];
    const want = w.names.map(String);
    if (w.tree) {
      // 080 (Strata): family = port owner + descendants, the app-named anchors + their descendants, and the
      // ancestry chains of anchors and port owner - that captures the engine manager / launcher workers doing
      // the model-load I/O and CPU while the runner is still being built (078's capture: ~6 % CPU and hundreds
      // of MB ~80 s before strata.exe appeared), while leaving a previous instance's leftover idle engine out.
      const spec = want.filter(function (n) { return GENERIC_WIN.indexOf(n.toLowerCase()) < 0; }).map(function (n) { return n.toLowerCase(); });
      const anchors = Object.keys(rows).map(Number).filter(function (pid) { return spec.indexOf(lname(rows[pid])) >= 0; }).sort(function (a, b) { return a - b; });
      let allf = fam.concat(anchors);
      anchors.forEach(function (a) { allf = allf.concat(familyOf(a, kids), ancestryOf(a, rows)); });
      if (root) allf = allf.concat(ancestryOf(root, rows));
      fam = allf.filter(function (pid, i) { return allf.indexOf(pid) === i && claimed.indexOf(pid) < 0; });
    } else {
      if (want.length) fam = fam.filter(function (pid) { return want.some(function (n) { return n.toLowerCase() === lname(rows[pid]); }); });
      // 077 batch 3: no listening port yet (a model LOAD/UNLOAD - the engine process runs before its port
      // exists) - find the app's processes by exe NAME, but only app-specific names: a shared runner like
      // llama-server.exe without its port would misattribute another app's process. PIDs already claimed by
      // another key are skipped.
      if (!root && want.length) {
        const spec = want.filter(function (n) { return GENERIC_WIN.indexOf(n.toLowerCase()) < 0; }).map(function (n) { return n.toLowerCase(); });
        if (spec.length) fam = Object.keys(rows).map(Number).filter(function (pid) { return spec.indexOf(lname(rows[pid])) >= 0 && claimed.indexOf(pid) < 0; });
      }
    }
    if (fam.length) {
      fresh[key] = { at: now, pids: fam.map(function (pid) { return { pid: pid, name: String(rows[pid].name || '') }; }) };
      claimed = claimed.concat(fam);
    }
  });
  applyFamilies(fresh);
}
// A fresh family set replaces the old one; an app with nothing found drops out (its tiles keep the attested
// wording, 072's rule - no invented zeros).
function applyFamilies(fresh) {
  Object.keys(fams).forEach(function (k) { if (!fresh[k]) delete fams[k]; });
  Object.keys(fresh).forEach(function (k) { fams[k] = fresh[k]; });
  Object.keys(results).forEach(function (k) { if (!fresh[k]) delete results[k]; });
}
// The clock, and 084's folded-in refinement of it (the user's option A): the fast 4 s re-resolve only runs while
// a TREE watcher has nothing yet - that is the case of a load in progress, where the app-named anchors appear
// seconds after the click and their tree is what the mirror tiles need (077 batch 3, 080). An app that is simply
// DOWN (ComfyUI / Ollama / llama.cpp closed: no listening port, no app-named process, nothing attesting a load)
// waits for the ordinary 10 s clock instead. Measured on snow, the fast clock for absent apps was the whole cost
// of the membership loop: ~7.5 re-resolves every 30 s, each paying a 125-240 ms process snapshot.
function maybeResolveFamilies(sample) {
  const keys = armedKeys();
  if (!keys.length) return;
  const missing = keys.filter(function (k) { const f = fams[k]; return !f || !f.pids.length; });
  const loadMayBeRunning = missing.some(function (k) { return watches[k] && watches[k].tree; });
  const period = loadMayBeRunning ? RESOLVE_MISSING_MS : RESOLVE_MS;
  if (Date.now() - resolveAt < period) return;
  resolveAt = Date.now();
  if (NIX) return nixFamilies(sample);
  const rows = tableOf(sample.procs), kids = kidsIndex(rows);
  const needPorts = keys.some(function (k) { return watches[k].ports.length > 0; });
  if (!needPorts) return windowsFamilies(rows, kids, owners);   // a load with no port yet: name anchors are enough
  portOwners(function (tb) { windowsFamilies(rows, kids, tb); });
}

// ---------- the numbers: aggregate one proctop sample over the families (084 item 3) ----------
// One row per process from proctop: { pid, name, ppid, cpu (% of the whole CPU), ram (working set), priv (private
// bytes), ioRead / ioWrite (bytes/s), luids: { luid -> { vram, shared, util } } }. Rates and the reused-PID guard
// are proctop's (each process's creation time), so nothing is diffed here.
function aggregate(sample) {
  if (!sample || sample.partial) return;   // proctop's first block carries no rates (059)
  maybeResolveFamilies(sample);
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

// ---------- family resolving on Linux / macOS (AI_SCOPE-052; unchanged rules, now on the same clock) ----------
// Model runners that several apps start (Bionic, Ollama and a llama.cpp server all run llama-server): when an app is
// found by name only, these only count if one of their parent processes is named after the app.
const GENERIC = { 'llama-server': 1, 'python': 1, 'python3': 1, 'node': 1 };
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
  let ports = [];
  keys.forEach(function (k) { watches[k].ports.forEach(function (p) { if (ports.indexOf(p) < 0) ports.push(p); }); });
  procnix.portOwners(ports, function (tb) {
    const fresh = {};
    keys.forEach(function (k) {
      const pids = nixResolve(snap, tb, k, watches[k]);
      if (pids.length) fresh[k] = { at: now, pids: pids.map(function (pid) { return { pid: pid, name: String((snap.procs[pid] || {}).name || '') }; }) };
    });
    applyFamilies(fresh);   // an app with no family found drops out, same as the Windows path
  });
}

// Watch an app's processes: key (e.g. 'comfyui'), the port(s) it listens on, and optionally the exe names to count
// (e.g. ['llama-server.exe'] for Bionic, whose model runs in a child process; default: the port owner + all children).
// Call again when the port changes. AI_SCOPE-077 batch 3: the port list may be EMPTY while the app's model
// process is already running (a Strata engine loading / unloading, port not listening yet) - the resolvers then
// match by exe NAME if the names are app-specific (never for shared runners like llama-server.exe / python.exe,
// which need a port to attribute them).
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
  refreshWatch(key);   // 084: the resolution and the sampling only follow while the app's state asks for numbers
}
function unwatch(key) {
  if (!watches[key]) return;
  delete watches[key]; delete results[key]; delete fams[key];
  resolveAt = 0;
  syncPace();
}
// The family for a key (diagnostics, tests, and the manual's troubleshooting notes).
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
  _test: { aggregate: aggregate, windowsFamilies: windowsFamilies, nixResolve: nixResolve, results: results, fams: fams,
    familyOf: familyOf, ancestryOf: ancestryOf, kidsIndex: kidsIndex } };
