// Live hardware stats (the Hardware scope): CPU %, RAM, and GPU % + VRAM per graphics card. Samples in the background
// every 2 s and keeps ~5 minutes of history. Conservative JS for older Node versions.
//
// GPU sources:
//  - NVIDIA cards: nvidia-smi (ships with the driver): one detection call at start, then one long-running
//    '--query-gpu ... -lms 2000' loop feeds every card (AI_SCOPE-119; no spawn per poll).
//  - Other cards on Windows (AMD/Intel): DXGI lists the adapters (name, LUID, dedicated VRAM), and
//    the Windows GPU performance counters (same source as Task Manager) give usage per adapter LUID.
//  - Mixed PCs (NVIDIA + AMD/Intel) use both. If DXGI is unavailable, the old single combined
//    counter reading is used as a fallback.
//  - Other cards on Linux (AMD): the amdgpu driver's plain sysfs files under /sys/class/drm —
//    busy %, VRAM, junction temperature and board power with its cap. No ROCm or root needed.
'use strict';
const os = require('os');
const fs = require('fs');                 // /proc/meminfo on Linux (AI_SCOPE-073)
const execFile = require('child_process').execFile;
const spawn = require('child_process').spawn;
const diskstats = require('./diskstats');   // read / write per physical disk (AI_SCOPE-030)
const ramcommitstats = require('./ramcommitstats');   // committed memory on Windows (AI_SCOPE-118)

const INTERVAL_MS = 2000;
// AI_SCOPE-092: the history is sized in TIME, not in samples - HISTORY is only a safety cap. The ring keeps
// everything newer than (newest sample - HW_WINDOW) plus the ONE sample older than that, so a sparkline's leftmost
// segment enters from the edge of the board instead of starting partway in.
const HW_WINDOW = 300000;                                    // five minutes of Hardware history
const HISTORY = Math.ceil(HW_WINDOW / INTERVAL_MS) + 20;     // safety cap (150 + slack at the 2 s pace), not the trim rule
const GIB = 1073741824;
const NVIDIA = 0x10de, MICROSOFT = 0x1414;

const history = [];
let lastCpu = null;
let gpuMode = null;   // 'nvidia' | 'windows' | 'mixed' | 'amd' | 'none'
let nvCards = [];     // latest nvidia-smi readings: [{ id, name, vendor, source, util, vramUsed, vramTotal }]
let amdCards = [];    // AMD cards read from amdgpu sysfs (Linux): the nvidia card fields + dev/hm paths
let winCards = [];    // cards read from Windows counters: [{ id, luid, name, vendor, source, util, vramUsed, vramTotal }]
let dxgiList = [];    // every DXGI adapter (name, LUID, vendor) - also used to find the LUID of NVIDIA cards (procstats.js)
let winAggregate = false; // fallback: no DXGI, so all counter adapters are summed into one card

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
  // 119: cb also gets stderr - readNvidia's detection needs the whole output to tell a rejected field from a timeout.
  execFile(cmd, args, { timeout: timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, function (err, stdout, stderr) {
    cb(err, String(stdout || ''), String(stderr || ''));
  });
}
function numOrNull(x) { const n = parseFloat(x); return isFinite(n) ? n : null; }

function allCards() { return nvCards.concat(winCards, amdCards); }

// ---- NVIDIA: one detection call, then one long-running loop ----
// (AI_SCOPE-119, on the helper pattern of diskstats/ramcommitstats.) Detection (readNvidia) decides whether NVIDIA
// cards exist and builds the list the DXGI matching depends on; its readings also seed the first numbers. Per-card
// values then stream from one attached 'nvidia-smi --query-gpu=<set> -lms 2000' loop - no more spawn per 2 s poll.
// Field sets: temperature / power draw + limit are extra fields (very old drivers don't know them), the PCIe link
// (AI_SCOPE-065) even less so. The ladder steps down ONLY when nvidia-smi rejects a field (quick exit, no data,
// 'is not a valid field to query' - on snow that message lands on stdout, exit code 2). Timeouts and other
// failures never step down (the old bug).
const NV_BASIC = 'index,name,utilization.gpu,memory.used,memory.total';
const NV_FULL = NV_BASIC + ',temperature.gpu,power.draw,power.limit';
const NV_PCIE = NV_FULL + ',pcie.link.gen.current,pcie.link.gen.max,pcie.link.width.current,pcie.link.width.max';
const NV_LADDER = [NV_PCIE, NV_FULL, NV_BASIC];   // step down only on rejection, top to bottom
let nvQuery = NV_PCIE;   // what detection settled on; the loop starts with this and keeps it across restarts

// One '--query-gpu' csv line -> a card reading, or null for anything that is not a data line.
function parseNvLine(l, query) {
  const p = String(l).trim().split(',').map(function (x) { return x.trim(); });
  if (!/^\d+$/.test(p[0]) || !p[1]) return null;
  const used = numOrNull(p[3]), total = numOrNull(p[4]);
  return { id: 'nv' + p[0], name: p[1], vendor: 'NVIDIA', source: 'nvidia', util: numOrNull(p[2]),
           vramUsed: used == null ? null : used * 1048576, vramTotal: total == null ? null : total * 1048576,
           temp: numOrNull(p[5]), power: numOrNull(p[6]), powerLimit: numOrNull(p[7]),
           link: query === NV_PCIE ? { gen: numOrNull(p[8]), genMax: numOrNull(p[9]), width: numOrNull(p[10]), widthMax: numOrNull(p[11]) } : null };
}
function nvRejected(text) { return /is not a valid field to query/.test(String(text)); }

// Detection: ONE call, ladder at its side. A rejected field steps down; anything else is retried once at the
// same field set, and then means no NVIDIA cards. On success nvQuery holds the set it settled on.
function readNvidia(cb) {
  const attempt = function (qi, retried) {
    const query = NV_LADDER[qi];
    run('nvidia-smi', ['--query-gpu=' + query, '--format=csv,noheader,nounits'], 5000, function (err, out, errOut) {
      const cards = String(out).split(/\r?\n/).map(function (l) { return parseNvLine(l, query); }).filter(Boolean);
      if (cards.length) { nvQuery = query; cb(cards); return; }
      if (err && nvRejected(out + errOut) && qi + 1 < NV_LADDER.length) return attempt(qi + 1, false);   // field rejected
      if (!retried) return attempt(qi, true);   // timeout / hiccup: one retry at the SAME set, never step down
      cb(null);
    });
  };
  attempt(0, false);
}

// ---- the loop ----
// Each tick prints one line per card; lines group into a tick when the index comes back to 0, or after one line
// per known card, and the whole tick is applied at once, by id. The loop NEVER adds or removes cards (that stays
// detection's job). Exit handling: rejected field -> step down once and restart; anything else -> restart at the
// same set after 5 s, giving up after NV_MAX_BAD starts that delivered no data (the dmon policy of 065/071: a
// data line resets the count). While no tick is younger than NV_STALE_MS the live values go null (mergeNvidia),
// so a stalled loop shows gaps instead of frozen numbers - card facts (size, name, link) survive.
const NV_LOOP_MS = 2000;
const NV_STALE_MS = 3 * NV_LOOP_MS;
const NV_MAX_BAD = 4;
let nvProc = null, nvBad = 0, nvGaveUp = false, nvExitHooked = false;
let nvTickBuf = [], nvTickAt = 0;

function applyNvTick() {
  if (!nvTickBuf.length) return;
  const tick = nvTickBuf; nvTickBuf = [];
  nvCards.forEach(function (c) {
    const x = tick.filter(function (t) { return t.id === c.id; })[0];
    if (!x) return;
    c.util = x.util; c.vramUsed = x.vramUsed; c.vramTotal = x.vramTotal;
    c.temp = x.temp; c.power = x.power; c.powerLimit = x.powerLimit;
    if (x.link) c.link = x.link;
  });
  nvTickAt = Date.now();
}
function nvFailLoop() {
  if (nvGaveUp) return;
  nvTickBuf = [];
  if (++nvBad >= NV_MAX_BAD) {
    nvGaveUp = true;
    console.log('[hwstats] nvidia-smi loop died ' + nvBad + ' times in a row - giving up; GPU numbers stay n/a');
    return;
  }
  setTimeout(startNvidiaLoop, 5000);
}
function startNvidiaLoop() {
  if (nvGaveUp || nvProc) return;
  let ps;
  try {
    ps = spawn('nvidia-smi', ['--query-gpu=' + nvQuery, '--format=csv,noheader,nounits', '-lms', String(NV_LOOP_MS)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { nvFailLoop(); return; }
  const startedAt = Date.now();
  let delivered = false, junk = '', buf = '';   // per child (111's lesson): a dying stream's flags must not leak
  ps.on('error', function () {});
  ps.stderr.on('data', function (d) { if (junk.length < 4000) junk += d; });
  ps.on('exit', function () {
    if (nvProc !== ps) return;
    nvProc = null; nvTickBuf = [];
    // rejected field only when this start never delivered data AND died quickly (119)
    if (!delivered && Date.now() - startedAt < 5000 && nvRejected(junk) && NV_LADDER.indexOf(nvQuery) + 1 < NV_LADDER.length) {
      nvQuery = NV_LADDER[NV_LADDER.indexOf(nvQuery) + 1];
      console.log('[hwstats] nvidia-smi rejected a query field - looping with: ' + nvQuery);
      setTimeout(startNvidiaLoop, 1000);
      return;
    }
    nvFailLoop();
  });
  ps.stdout.on('data', function (d) {
    buf += d;
    const lines = buf.split(/\r?\n/); buf = lines.pop();
    lines.forEach(function (l) {
      const c = parseNvLine(l, nvQuery);
      if (!c) { if (junk.length < 4000) junk += l; return; }   // the rejection message lands on stdout (snow)
      delivered = true; nvBad = 0;                             // data flowing - forget earlier dead starts (071)
      if (c.id === 'nv0' && nvTickBuf.length) applyNvTick();   // index back to 0 -> the previous tick is complete
      nvTickBuf.push(c);
      if (nvTickBuf.length >= nvCards.length) applyNvTick();   // or: one line per known card seen - apply now
    });
  });
  if (!nvExitHooked) {   // one exit hook for all time - it kills the CURRENT loop, not a captured one (071)
    nvExitHooked = true;
    process.on('exit', function () { if (nvProc) { try { nvProc.kill(); } catch (e) {} } });
  }
  nvProc = ps;
}

// Called by every 2 s sample (this is where pollGpu used to spawn): ticks stream in on their own, so this only
// drops the LIVE values when the loop went silent or was given up on - a gap in the charts, not frozen numbers.
// vramTotal is NOT blanked: card size is a fixed fact from detection (like name and the negotiated PCIe link),
// and the VRAM tile ceiling, info.gpus and the model Fit columns (vramInfo/vramFit) all depend on it.
function mergeNvidia() {
  if (!nvCards.length) return;
  if (nvGaveUp || Date.now() - nvTickAt > NV_STALE_MS) {
    nvCards.forEach(function (c) { c.util = null; c.vramUsed = null; c.temp = null; c.power = null; c.powerLimit = null; });
  }
}

// ---- Windows: list adapters with DXGI (name, LUID, dedicated VRAM; 64-bit sizes, unlike WMI) ----
const PS_DXGI =
  "$ErrorActionPreference='Stop';" +
  "Add-Type -TypeDefinition @'\n" +
  "using System; using System.Runtime.InteropServices; using System.Text;\n" +
  "public static class AiScopeDxgi {\n" +
  "  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]\n" +
  "  public struct Desc1 { [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;\n" +
  "    public uint VendorId, DeviceId, SubSysId, Revision; public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;\n" +
  "    public uint LuidLow; public int LuidHigh; public uint Flags; }\n" +
  "  [ComImport, Guid(\"770aae78-f26f-4dba-a829-253c83d1b387\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]\n" +
  "  public interface IFactory1 { void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();\n" +
  "    void EnumAdapters(); void MakeWindowAssociation(); void GetWindowAssociation(); void CreateSwapChain(); void CreateSoftwareAdapter();\n" +
  "    [PreserveSig] int EnumAdapters1(uint index, out IAdapter1 adapter); }\n" +
  "  [ComImport, Guid(\"29038f61-3839-4626-91fd-086879011a05\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]\n" +
  "  public interface IAdapter1 { void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();\n" +
  "    void EnumOutputs(); void GetDesc(); void CheckInterfaceSupport();\n" +
  "    [PreserveSig] int GetDesc1(out Desc1 desc); }\n" +
  "  [DllImport(\"dxgi.dll\")] static extern int CreateDXGIFactory1(ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IFactory1 factory);\n" +
  "  public static string List() {\n" +
  "    Guid g = new Guid(\"770aae78-f26f-4dba-a829-253c83d1b387\"); IFactory1 f;\n" +
  "    if (CreateDXGIFactory1(ref g, out f) != 0) return \"\";\n" +
  "    StringBuilder sb = new StringBuilder();\n" +
  "    for (uint i = 0; i < 16; i++) { IAdapter1 a; if (f.EnumAdapters1(i, out a) != 0) break; Desc1 d; if (a.GetDesc1(out d) != 0) continue;\n" +
  "      sb.AppendLine(String.Format(\"{0:x8}_{1:x8}|{2}|{3}|{4}|{5}\", (uint)d.LuidHigh, d.LuidLow, d.VendorId, d.DedicatedVideoMemory.ToUInt64(), d.Flags, d.Description)); }\n" +
  "    return sb.ToString(); } }\n" +
  "'@;" +
  "[AiScopeDxgi]::List()";

// NVIDIA cards come from nvidia-smi, which has no LUID. Match each to a DXGI adapter by name (in order, so two
// identical cards pair up by enumeration order), so per-process counters (keyed by LUID) map to the right card.
function matchNvidiaLuids() {
  const used = {};
  const nv = dxgiList.filter(function (a) { return a.vendorId === NVIDIA; });
  nvCards.forEach(function (c) {
    const want = String(c.name || '').trim().toLowerCase();
    let a = nv.filter(function (x) { return !used[x.luid] && x.name.trim().toLowerCase() === want; })[0];
    if (!a) a = nv.filter(function (x) { return !used[x.luid]; })[0];
    if (a) { used[a.luid] = true; c.luid = a.luid; }
  });
}
// LUID of each card, in the same order as info.gpus / samples' gpus[] ('<high8>_<low8>', or null if unknown).
function cardLuids() { return allCards().map(function (c) { return c.luid || null; }); }
// Per-process GPU numbers are keyed per card (AI_SCOPE-052): Windows by LUID (GPU counters), Linux by the NVIDIA card
// id 'nv<index>' (nvidia-smi); in the Hardware card order. null = no per-process numbers for that card.
function cardKeys() { return process.platform === 'win32' ? cardLuids() : allCards().map(function (c) { return c.source === 'nvidia' ? c.id : null; }); }

function readDxgi(cb) {
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_DXGI], 20000, function (err, out) {
    const list = [];
    out.split(/\r?\n/).forEach(function (l) {
      const p = l.split('|');
      if (p.length < 5) return;
      list.push({ luid: p[0].trim().toLowerCase(), vendorId: +p[1], vramTotal: +p[2], flags: +p[3], name: p.slice(4).join('|').trim() });
    });
    cb(list.length ? list : null);
  });
}
function vendorName(id) { return id === NVIDIA ? 'NVIDIA' : id === 0x1002 || id === 0x1022 ? 'AMD' : id === 0x8086 ? 'Intel' : null; }

// Graphics cards worth a tile: real hardware adapters with at least 1 GB of their own VRAM
// (skips Microsoft Basic Render and integrated GPUs with a token 128 MB carve-out). If there is
// no such card, fall back to every hardware adapter, so an iGPU-only PC still shows its GPU.
function pickCards(adapters) {
  const hw = adapters.filter(function (a) { return !(a.flags & 2) && a.vendorId !== MICROSOFT; });
  const big = hw.filter(function (a) { return a.vramTotal >= GIB; });
  return big.length ? big : hw;
}

// ---- Windows performance counters: one long-running PowerShell prints a block of samples every
// ~2 s, ending with '---'. (Much cheaper than starting PowerShell on every poll.)
const PS_COUNTER_LOOP =
  "$ErrorActionPreference='SilentlyContinue';" +
  "while ($true) {" +
  " if (-not (Get-Process -Id __PARENT__ -ErrorAction SilentlyContinue)) { exit };" + // stop if Node is gone
  " $s=(Get-Counter '\\GPU Engine(*)\\Utilization Percentage','\\GPU Adapter Memory(*)\\Dedicated Usage').CounterSamples;" +
  " $s | ForEach-Object { $_.Path + '|' + $_.CookedValue }; '---'; Start-Sleep -Milliseconds 1000 }";

// Counter paths name the adapter as luid_0x<high>_0x<low>; returns '<high8>_<low8>' to match DXGI.
function luidOf(path) {
  const m = /luid_0x([0-9a-f]+)_0x([0-9a-f]+)/.exec(path);
  if (!m) return null;
  const pad = function (h) { h = h.replace(/^0+/, ''); while (h.length < 8) h = '0' + h; return h; };
  return pad(m[1]) + '_' + pad(m[2]);
}

// Returns { '<luid>': { util, vram } } (util like Task Manager: busiest engine type, summed over processes),
// or null if the block had no GPU counters.
function parseCounterBlock(lines) {
  const by = {};
  let seen = false;
  lines.forEach(function (line) {
    const i = line.lastIndexOf('|');
    if (i < 0) return;
    const p = line.slice(0, i).toLowerCase();
    const v = parseFloat(line.slice(i + 1).replace(',', '.')) || 0;
    const luid = luidOf(p) || '?';
    const a = by[luid] || (by[luid] = { engines: {}, vram: 0 });
    if (p.indexOf('utilization percentage') >= 0) {
      seen = true;
      const m = /engtype_([a-z0-9 ]+)\)/.exec(p);
      const k = m ? m[1] : 'other';
      a.engines[k] = (a.engines[k] || 0) + v;
    } else if (p.indexOf('dedicated usage') >= 0) {
      seen = true;
      a.vram += v;
    }
  });
  if (!seen) return null;
  const out = {};
  Object.keys(by).forEach(function (k) {
    const utils = Object.keys(by[k].engines).map(function (e) { return by[k].engines[e]; });
    out[k] = { util: utils.length ? Math.min(100, Math.max.apply(null, utils)) : 0, vram: by[k].vram };
  });
  return out;
}

function applyCounters(r) {
  if (winAggregate) {
    // Fallback (no DXGI): one combined card, like v0.1.
    const c = winCards[0];
    const keys = Object.keys(r);
    c.util = keys.length ? Math.max.apply(null, keys.map(function (k) { return r[k].util; })) : 0;
    c.vramUsed = keys.reduce(function (s, k) { return s + r[k].vram; }, 0);
    return;
  }
  winCards.forEach(function (c) {
    const x = r[c.luid];
    c.util = x ? x.util : 0;
    c.vramUsed = x ? x.vram : 0;
  });
}

// Starts the counter loop; calls onFirst(ok) once the first block arrives (or after a timeout).
function startWindowsCounters(onFirst) {
  let buf = '', block = [], first = true;
  const done = function (ok) { if (first) { first = false; onFirst(ok); } };
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_COUNTER_LOOP.replace('__PARENT__', String(process.pid))], { windowsHide: true });
  ps.on('error', function () { done(false); });
  ps.on('exit', function () { done(false); if (winCards.length) setTimeout(function () { startWindowsCounters(function () {}); }, 5000); });
  ps.stdout.on('data', function (d) {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    lines.forEach(function (l) {
      if (l.trim() === '---') {
        const r = parseCounterBlock(block);
        block = [];
        if (r) { applyCounters(r); done(true); } else done(false);
      } else block.push(l);
    });
  });
  setTimeout(function () { done(false); }, 15000);
  process.on('exit', function () { try { ps.kill(); } catch (e) {} });
}

// Fallback total VRAM + name from the registry, used only when DXGI is unavailable.
const PS_VRAM_TOTAL =
  "$ErrorActionPreference='SilentlyContinue';" +
  "Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' |" +
  " Where-Object { $_.'HardwareInformation.qwMemorySize' } |" +
  " ForEach-Object { $_.DriverDesc + '|' + $_.'HardwareInformation.qwMemorySize' }";

// ---- PCIe bus traffic (AI_SCOPE-065): one persistent 'nvidia-smi dmon -s t' stream ----
// RX / TX MB/s per NVIDIA card; a long-running process like the Windows counter loop (spawning
// per poll would cost). Latest block kept; values merge into the next 2 s sample.
// AI_SCOPE-071: give up after PCIE_MAX_BAD starts in a row that deliver no data - older drivers / WSL
// nvidia-smi print usage and exit 0, which used to restart the stream every 5 s forever; the exit hook
// is registered once and kills whatever stream is current (per-restart hooks piled listeners up until
// Node warned); and pcieLatest is cleared when a stream stops, so a dead stream never keeps painting
// its last reading. A stream that delivers data again resets the failure count.
let pcieLatest = {};   // device index ('0', '1') -> { rx, tx } MB/s
let pcieProc = null;   // the current stream process (null = none running)
let pcieBad = 0;       // consecutive starts that exited without delivering a data line
let pcieGaveUp = false;
let pcieExitHooked = false;
const PCIE_MAX_BAD = 4;
function pcieFail() {
  if (pcieGaveUp) return;
  pcieBad++;
  if (pcieBad >= PCIE_MAX_BAD) {
    pcieGaveUp = true; pcieLatest = {};
    console.log('[hwstats] PCIe stream died ' + pcieBad + ' times in a row - giving up (this driver\'s nvidia-smi may not support dmon); traffic stays n/a');
    return;
  }
  setTimeout(startPcie, 5000);
}
function startPcie() {
  if (pcieGaveUp) return;
  let buf = '';
  let ps;
  try { ps = spawn('nvidia-smi', ['dmon', '-s', 't'], { windowsHide: true }); } catch (e) { pcieFail(); return; }   // 1 s default delay; Windows calls it -d/--delay, Linux --sleep - pass neither
  ps.on('error', function () {});
  ps.on('exit', function () {
    if (pcieProc === ps) { pcieProc = null; pcieLatest = {}; }   // 071: stream stopped - drop its last reading (tile shows detecting / n/a, not frozen numbers)
    pcieFail();
  });
  ps.stdout.on('data', function (d) {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    lines.forEach(function (l) {
      const p = l.trim().split(/\s+/);
      if (p.length !== 3) return;   // data lines are '<idx> <rx> <tx>'; header lines have 4+ tokens
      const rx = numOrNull(p[1]), tx = numOrNull(p[2]);
      if (p[0].match(/^\d+$/) && rx != null && tx != null) { pcieLatest[p[0]] = { rx: rx, tx: tx }; pcieBad = 0; }   // data flowing - the stream works, forget earlier failures
    });
  });
  if (!pcieExitHooked) {   // 071: one exit hook for all time - it kills the CURRENT stream, not a captured one
    pcieExitHooked = true;
    process.on('exit', function () { if (pcieProc) { try { pcieProc.kill(); } catch (e) {} } });
  }
  pcieProc = ps;
}

// ---- AMD cards on Linux (amdgpu sysfs): GPU % + VRAM + junction temp + power draw / limit ----
// The amdgpu driver (ships with the kernel) exposes these cards as plain files under
// /sys/class/drm/cardN/device, no ROCm and no root needed:
//   gpu_busy_percent                    -> GPU % (what rocm-smi reports)
//   mem_info_vram_used / _total         -> dedicated VRAM in bytes
//   hwmon/hwmonN/temp*_label + _input   -> millidegrees; prefer 'junction' (the throttling sensor), else edge
//   hwmon/hwmonN/power1_average|_input  -> board power draw in microwatts
//   hwmon/hwmonN/power1_cap             -> the driver's power limit in microwatts (e.g. a 210 W cap)
// Cards with under 8 GiB of their own VRAM are skipped: an iGPU/APU 'VRAM' there is a carve-out of
// system RAM, not dedicated memory (this box's Granite Ridge iGPU reports exactly 2 GiB).
// Card names come from /usr/share/hwdata/pci.ids when hwdata is installed, else 'AMD GPU <PCI_ID>'.
function readSysfsNum(p) {
  try { const v = parseFloat(fs.readFileSync(p, 'utf8')); return isFinite(v) ? v : null; } catch (e) { return null; }
}
function amdCardName(devid) {   // '7551' -> 'AMD Radeon AI PRO R9700' via pci.ids, else a generic name
  try {
    const ids = fs.readFileSync('/usr/share/hwdata/pci.ids', 'utf8').split('\n');
    let i = 0;
    while (i < ids.length && !/^1002\s/.test(ids[i])) i++;   // AMD vendor section start
    for (i++; i < ids.length; i++) {
      const l = ids[i];
      if (/^[0-9a-fA-F]{4}\s/.test(l)) break;                // next vendor - not found
      const m = /^\t([0-9a-fA-F]{4})\s+(.+)$/.exec(l);      // one tab = a device (two tabs = subsystem)
      if (m && m[1].toLowerCase() === devid) {
        const name = m[2].trim();
        const br = /\[([^\]]+)\]/.exec(name);               // 'Navi 48 [Radeon AI PRO R9700]' -> the marketing name
        return 'AMD ' + (br ? br[1] : name).trim();
      }
    }
  } catch (e) {}
  return 'AMD GPU 1002:' + devid;
}
function findAmdCards() {
  let dirs = [];
  try { dirs = fs.readdirSync('/sys/class/drm'); } catch (e) { return []; }
  const cards = [];
  dirs.sort(function (a, b) { return (+a.replace(/\D/g, '')) - (+b.replace(/\D/g, '')); }).forEach(function (d) {
    if (!/^card\d+$/.test(d)) return;
    const dev = '/sys/class/drm/' + d + '/device';
    const total = readSysfsNum(dev + '/mem_info_vram_total');
    if (readSysfsNum(dev + '/gpu_busy_percent') == null || !(total >= 8 * GIB)) return;   // needs busy % + real dedicated VRAM
    let devid = '????';
    try {
      const m = /PCI_ID=1002:([0-9a-f]{4})/i.exec(fs.readFileSync(dev + '/uevent', 'utf8'));
      if (m) devid = m[1].toLowerCase();
    } catch (e) {}
    let hm = null;   // the hwmon dir holding the power / temp sensors
    try {
      fs.readdirSync(dev + '/hwmon').forEach(function (h) {
        const base = dev + '/hwmon/' + h;
        if (!hm && (fs.existsSync(base + '/power1_cap') || fs.existsSync(base + '/temp1_label'))) hm = base;
      });
    } catch (e) {}
    cards.push({ id: 'amd' + d.slice(4), dev: dev, hm: hm, name: amdCardName(devid), vendor: 'AMD', source: 'amd',
                 util: null, vramUsed: null, vramTotal: total, temp: null, power: null, powerLimit: null });
  });
  return cards;
}
// Refresh one card's live fields. Plain sysfs reads (a dozen small files per card) - cheap enough for the 2 s loop.
function readAmdCard(c) {
  c.util = readSysfsNum(c.dev + '/gpu_busy_percent');
  c.vramUsed = readSysfsNum(c.dev + '/mem_info_vram_used');
  const t = readSysfsNum(c.dev + '/mem_info_vram_total'); if (t) c.vramTotal = t;
  if (!c.hm) return;
  let junction = null, edge = null, hottest = null;
  try {
    fs.readdirSync(c.hm).forEach(function (f) {
      const m = /^temp(\d+)_label$/.exec(f); if (!m) return;
      let label = '';
      try { label = fs.readFileSync(c.hm + '/' + f, 'utf8').trim().toLowerCase(); } catch (e) {}
      const val0 = readSysfsNum(c.hm + '/temp' + m[1] + '_input');
      if (val0 == null) return;
      const val = Math.round(val0 / 1000);   // millidegrees -> degC
      if (label === 'junction') junction = val; else if (label === 'edge') edge = val;
      if (hottest == null || val > hottest) hottest = val;
    });
  } catch (e) {}
  c.temp = junction != null ? junction : edge != null ? edge : hottest;
  let pw = readSysfsNum(c.hm + '/power1_average');
  if (pw == null) pw = readSysfsNum(c.hm + '/power1_input');
  c.power = pw == null ? null : Math.round(pw / 100000) / 10;   // microwatts -> W, one decimal
  const cap = readSysfsNum(c.hm + '/power1_cap');
  c.powerLimit = cap == null ? null : Math.round(cap / 100000) / 10;
}

function setMode() {
  gpuMode = nvCards.length && winCards.length ? 'mixed' : nvCards.length ? 'nvidia' : winCards.length ? 'windows' : amdCards.length ? 'amd' : 'none';
}

function startCounters(cb) {
  startWindowsCounters(function (ok) {
    if (!ok) winCards = [];
    setMode();
    cb();
  });
}

// Set AI_SCOPE_GPU_SOURCE=windows to ignore nvidia-smi (to test the Windows counter path on an NVIDIA PC).
function detectGpu(cb) {
  const forceWin = String(process.env.AI_SCOPE_GPU_SOURCE || '').toLowerCase() === 'windows';
  const afterNvidia = function (nv) {
    nvCards = nv || [];
    if (nvCards.length) { nvTickAt = Date.now(); startPcie(); startNvidiaLoop(); }   // PCIe traffic stream (065) + the per-card loop (119); detection's seed counts fresh until the first tick
    if (process.platform !== 'win32') {
      if (process.platform === 'linux' && !nvCards.length) {   // AMD cards via amdgpu sysfs
        amdCards = findAmdCards();
        amdCards.forEach(readAmdCard);                          // first numbers before the first sample tick
      }
      setMode(); return cb();
    }
    readDxgi(function (adapters) {
      if (adapters) {
        dxgiList = adapters;
        matchNvidiaLuids();
        const cards = pickCards(adapters).filter(function (a) { return !nvCards.length || a.vendorId !== NVIDIA; });
        winCards = cards.map(function (a, i) {
          return { id: 'win' + i, luid: a.luid, name: a.name, vendor: vendorName(a.vendorId), source: 'windows',
                   util: null, vramUsed: null, vramTotal: a.vramTotal || null };
        });
        if (!winCards.length) { setMode(); return cb(); }
        return startCounters(cb);
      }
      if (nvCards.length) { setMode(); return cb(); }
      // No DXGI and no NVIDIA: v0.1 behaviour (one combined card, total = biggest registry adapter).
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_VRAM_TOTAL], 10000, function (err, out) {
        let best = null;
        out.split(/\r?\n/).forEach(function (l) {
          const i = l.lastIndexOf('|');
          if (i < 0) return;
          const size = +l.slice(i + 1);
          if (size && (!best || size > best.size)) best = { name: l.slice(0, i).trim(), size: size };
        });
        winAggregate = true;
        winCards = [{ id: 'win0', luid: null, name: best ? best.name : 'GPU', vendor: null, source: 'windows',
                      util: null, vramUsed: null, vramTotal: best ? best.size : null }];
        startCounters(cb);
      });
    });
  };
  if (forceWin) afterNvidia(null); else readNvidia(afterNvidia);
}

function sample() {
  if (amdCards.length) amdCards.forEach(readAmdCard);   // refresh amdgpu sysfs values each tick (AMD cards on Linux)
  sampleCommit();   // committed memory at the 2 s pace (AI_SCOPE-118)
  mergeNvidia();    // NVIDIA fold BEFORE building the sample, so a stale stream gaps this entry, not next (119)
  const total = os.totalmem(), free = os.freemem();
  const cards = allCards();
  const has = function (k) { return cards.some(function (c) { return c[k] != null; }); };
  const sum = function (k) { return cards.reduce(function (a, c) { return a + (c[k] || 0); }, 0); };
  const s = {
    t: Date.now(),
    cpu: cpuPercent(),
    ramUsed: total - free,
    ramTotal: total,
    commitLimit: commitLimit,   // AI_SCOPE-073/074: RAM + pagefile ceiling for committed memory (null where it has no meaning)
    commitUsed: commitUsed,     // AI_SCOPE-074: committed in use (same reading, above)
    commitPeak: commitPeak,     // AI_SCOPE-118: peak commit charge since the last boot (Windows only; no UI yet, old samples lack the field)
    // Whole-PC GPU numbers (busiest card, VRAM summed over all cards)...
    gpu: has('util') ? Math.max.apply(null, cards.map(function (c) { return c.util || 0; })) : null,
    vramUsed: has('vramUsed') ? sum('vramUsed') : null,
    vramTotal: has('vramTotal') ? sum('vramTotal') : null,
    // ...and per card, in the same order as info.gpus.
    // temp °C, power / powerLimit W: NVIDIA only (null for AMD/Intel - Windows' counters don't report them).
    // pcieRx / pcieTx MB/s: NVIDIA only, from the dmon stream (null until the first block arrives).
    gpus: cards.map(function (c) { const px = c.source === 'nvidia' ? pcieLatest[c.id.replace(/^nv/, '')] : null; return { util: c.util, vramUsed: c.vramUsed, vramTotal: c.vramTotal,
                                            temp: c.temp == null ? null : c.temp, power: c.power == null ? null : c.power,
                                            powerLimit: c.powerLimit == null ? null : c.powerLimit,
                                            pcieRx: px ? px.rx : null, pcieTx: px ? px.tx : null }; }),
  };
  // Disks (AI_SCOPE-030): read / write bytes per second and active time % per physical disk; names in info.disks
  const disks = diskstats.get();
  if (disks) {
    s.disks = disks.map(function (d) { return { id: d.id, read: Math.round(d.read), write: Math.round(d.write), active: d.active == null ? null : Math.round(d.active * 10) / 10 }; });
    diskNames = {}; disks.forEach(function (d) { diskNames[d.id] = d.name; }); diskOrder = disks.map(function (d) { return d.id; });
  }
  if (s.cpu != null) {
    s.every = INTERVAL_MS;   // AI_SCOPE-092: stamp the interval this sample was OWED at, so a chart judges a gap by the pace that applied then, never by today's setting
    history.push(s);
    while (history.length > 1 && history[1].t < s.t - HW_WINDOW) history.shift();   // 092: prune by time, keeping one older sample at the left edge
    if (history.length > HISTORY) history.splice(0, history.length - HISTORY);      // safety cap only
  }
}

let diskNames = {}, diskOrder = [];
let started = false;

// ---- Committed memory: what is reserved and the ceiling it must fit in (AI_SCOPE-073 / 074; AI_SCOPE-118 moved
// Windows off WMI) ----
// The "Committed" RAM tile needs both numbers, sampled like every other number - every 2 s.
// Windows: GetPerformanceInfo from one long-running PowerShell (ramcommitstats.js / ramcommitstats.ps1), the same
// helper pattern as diskstats.js. (The old route was Get-CimInstance Win32_OperatingSystem every 60 s; on snow that
// class costs 9-11 s and blew the 10 s timeout, so the reads failed silently.) CommitLimit is the ceiling (RAM plus
// pagefile) and CommitTotal the reservation; commitPeak is the high-water mark since the last boot - kept in the
// sample, no UI yet. When the helper is stale, commitUsed (and commitPeak) go null so the chart shows a gap, but the last good
// commitLimit is kept: the ceiling rarely moves, and without it the Mirror lens falls back to the RAM ceiling.
// Linux: /proc/meminfo (cheap fs read) - CommitLimit is the ceiling, Committed_AS the reservation (an accounting
// estimate: with default overcommit it can exceed the limit, which the tile shows as a full meter).
// macOS has no commit-limit concept, so both stay null and the tile says so; 074 also leaves it out of the macOS
// default layout.
let commitLimit = null, commitUsed = null, commitPeak = null;
function readCommitLinux() {
  let text = '';
  try { text = fs.readFileSync('/proc/meminfo', 'utf8'); } catch (e) { return; }
  const kb = function (name) { const m = new RegExp('^' + name + ':\\s+(\\d+)', 'm').exec(text); return m ? +m[1] * 1024 : null; };
  const total = kb('MemTotal'), cl = kb('CommitLimit');
  if (total) commitLimit = cl != null ? cl : total + (kb('SwapTotal') || 0);
  commitUsed = kb('Committed_AS');
}
// One reading into the module-level values. Called from every 2 s sample (and once at start, so the first
// sample already carries numbers wherever the source is immediate).
function sampleCommit() {
  if (process.platform === 'win32') {
    const c = ramcommitstats.get();
    if (c) { commitLimit = c.limit; commitUsed = c.used; commitPeak = c.peak; }
    else { commitUsed = null; commitPeak = null; }   // stale: chart gap; commitLimit keeps its last good value
    return;
  }
  if (process.platform === 'linux') { readCommitLinux(); return; }
  commitLimit = null; commitUsed = null; commitPeak = null;    // macOS
}

function start() {
  if (started) return;
  started = true;
  diskstats.start();
  ramcommitstats.start();   // committed memory on Windows comes from this helper, at the 2 s pace (AI_SCOPE-118)
  sampleCommit();           // immediate on Linux / trivially null on macOS; the first 2 s sample carries values
  cpuPercent();
  detectGpu(function () {
    const cards = allCards();
    console.log('[hardware] GPU stats source: ' + gpuMode + (cards.length ? ' (' + cards.map(function (c) { return c.name; }).join(', ') + ')' : ''));
  });
  setInterval(sample, INTERVAL_MS);
}

function getStats() {
  const cpus = os.cpus();
  const cards = allCards();
  return {
    info: {
      cpuModel: cpus.length ? cpus[0].model.trim() : 'CPU',
      cores: cpus.length,
      gpuName: cards.length ? cards.map(function (c) { return c.name; }).join(' + ') : null,
      gpuSource: gpuMode,
      gpus: cards.map(function (c) { return { id: c.id, name: c.name, vendor: c.vendor, source: c.source, vramTotal: c.vramTotal, link: c.link || null }; }),
      disks: diskOrder.map(function (id) { return { id: id, name: diskNames[id] }; }),   // physical disks (AI_SCOPE-030)
      disksSupported: diskstats.supported(),
    },
    intervalMs: INTERVAL_MS,
    history: history,
  };
}

// ---- VRAM fit for the model lists (Bionic, Ollama, ComfyUI) ----
// Card sizes, biggest first, e.g. { cards: [16 GB, 8 GB], largest: 16 GB, total: 24 GB }; null if unknown.
function vramInfo() {
  const sizes = allCards().map(function (c) { return c.vramTotal; }).filter(function (v) { return v > 0; })
    .sort(function (a, b) { return b - a; });
  if (!sizes.length) return null;
  return { cards: sizes, largest: sizes[0], total: sizes.reduce(function (a, b) { return a + b; }, 0) };
}
// A model "fits" when it fits on the largest single card. If it only fits split across cards
// (and the app can split, like llama.cpp-based Bionic / Ollama), returns fit 'multi' with the
// number of cards needed. Returns { fit, gpus } or null.
function vramFit(size, vram, canSplit) {
  if (!vram || !size) return null;
  if (size <= vram.largest * 0.8) return { fit: 'fits' };
  if (size <= vram.largest) return { fit: 'tight' };
  if (canSplit && vram.cards.length > 1) {
    let acc = 0;
    for (let i = 0; i < vram.cards.length; i++) {
      acc += vram.cards[i];
      if (i > 0 && size <= acc) return { fit: 'multi', gpus: i + 1 };
    }
  }
  return { fit: 'spills' };
}

// ---- Peak whole-PC load while a request/run was going (from the 2 s samples, last 5 minutes) ----
// Returns { gpu, vramUsed, vramTotal, cpu, ramUsed, ramTotal, diskRead (bytes/s, all disks), partial } or null when no sample falls in
// [t0, t1]. partial = the request started before the oldest kept sample, so only its last 5 min count.
function peakBetween(t0, t1) {
  if (t0 == null || t1 == null || !history.length) return null;
  let p = null;
  const mx = function (a, b) { return b == null ? a : a == null ? b : Math.max(a, b); };
  history.forEach(function (s) {
    if (s.t < t0 || s.t > t1) return;
    if (!p) p = { gpu: null, vramUsed: null, vramTotal: s.vramTotal, cpu: null, ramUsed: null, ramTotal: s.ramTotal };
    p.gpu = mx(p.gpu, s.gpu); p.vramUsed = mx(p.vramUsed, s.vramUsed); p.cpu = mx(p.cpu, s.cpu); p.ramUsed = mx(p.ramUsed, s.ramUsed);
    // disk read (AI_SCOPE-030): all disks together, bytes per second
    if (s.disks) p.diskRead = mx(p.diskRead, s.disks.reduce(function (a, d) { return a + (d.read || 0); }, 0));
  });
  if (!p) return null;
  ['gpu', 'cpu'].forEach(function (k) { if (p[k] != null) p[k] = Math.round(p[k]); });
  p.partial = t0 < history[0].t;
  return p;
}
function oldestSample() { return history.length ? history[0].t : null; }

module.exports = { start: start, getStats: getStats, cardLuids: cardLuids, cardKeys: cardKeys, vramInfo: vramInfo, vramFit: vramFit, peakBetween: peakBetween, oldestSample: oldestSample,
                   _test: { parseCounterBlock: parseCounterBlock, luidOf: luidOf, pickCards: pickCards, parseNvLine: parseNvLine, nvRejected: nvRejected } };
