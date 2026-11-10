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
// external calls left are a netstat.exe port table on the re-resolve clock (18 ms) and, only when netstat names
// no owner for an armed watched port, ONE Get-NetTCPConnection -LocalPort lookup (~1.5 s, off the clock, at most
// once per re-resolve period - see portOwnersCim).
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
// AI_SCOPE-092: the ring is sized in TIME - PS_WINDOW is the five-minute window every sparkline draws, and HIST is
// only a safety cap. A 150-point cap is a count, so at a 30 s pace it would quietly hold 75 minutes while every
// chart window says five (the catch 089 flagged). Each point also carries `every`: the pace that produced it, so a
// chart judges a gap by the pace of that moment and never by today's setting.
const PS_WINDOW = 300000;
const HIST = Math.ceil(PS_WINDOW / 2000) + 20;
const hist = {};        // key -> [{ t, every, gpus: [{ vram, util, w }], ram, ramPrivate, cpu, ioRead, ioWrite }]   (w: 122 - the per-card estimated watts accrueCost charged for that sample, when it could compute one)
// The 092 trim, used by both writers (the sampler's real points and the zero heartbeat): keep everything newer
// than (newest - PS_WINDOW) plus the ONE sample older, so a chart's leftmost segment enters from the edge.
function pruneRing(h) {
  const last = h.length ? h[h.length - 1].t : 0;
  while (h.length > 1 && h[1].t < last - PS_WINDOW) h.shift();
  if (h.length > HIST) h.splice(0, h.length - HIST);
  return h;
}
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
  const pt = { t: r.at, every: r.every,   // 092: the stamp travels with the sample it was taken from (aggregate() copies it), not from the ambient sampler
    gpus: luids.map(function (l) { const g = l && r.luids[l]; return g ? { vram: g.vram, util: g.util == null ? 0 : g.util } : { vram: 0, util: 0 }; }),
    ram: r.ram, ramPrivate: r.ramPrivate,
    cpu: r.cpu == null ? null : Math.min(100, r.cpu),
    ioRead: r.ioSeen ? r.ioRead || 0 : null, ioWrite: r.ioSeen ? r.ioWrite || 0 : null };   // AI_SCOPE-076
  h.push(pt);
  pruneRing(h);   // 092: sized in time (plus one older sample at the edge), HIST is only the safety cap
  // AI_SCOPE-121: energy for this real family sample (see below). AI_SCOPE-122: accrueCost also returns the
  // same estimate PER CARD, and the point's gpus entry gets it as `w` - the GPU Power mirror tile is drawn
  // from there, so the watts on the tile and the joules in the cost can never come from two samples or two
  // formulas. A voided sample returns null: the point simply carries no w (an unknown, not a 0).
  const cw = accrueCost(key, r, luids);
  if (cw) for (let i = 0; i < cw.length; i++) if (pt.gpus[i] && cw[i] != null) pt.gpus[i].w = cw[i];
}

// ---------- Energy attributed to an app's process family (AI_SCOPE-121, the Strata Cost lens) ----------
// Per real family sample: for each card, that card's live board power x the share of ITS OWN total device
// utilisation this app's family accounts for, summed over the cards = the watts this app is plausibly asking of
// its cards. Board power is a DEVICE measurement, so this is an estimate and the lens wears ≈ on every face and
// names the formula in its tooltip (user's plan, 2026-11-08). AI_SCOPE-122: the per-card figures are ALSO stamped
// onto the mirror history point as gpus[i].w (the GPU Power mirror tile draws them); TERMINOLOGY's mirror-family
// exclusion of Power was revised by that ticket - the estimate is measured per process, not invented.
// The share, not the percentage (AI_SCOPE-121 D7, refined by D8, user's calls 2026-11-09): the first version
// charged `board power x family util / 100`, which quietly assumes the card was 100 % busy. A card half busy
// draws its idle base power plus half the workload, so that formula billed Strata for a share of the load AND a
// share of nothing - it under-charged whenever anything else was awake on the card (measured on the user's own
// live two-card machine, 145 consecutive samples while Strata generated: 42.4 W mean against 67.0 W for exactly
// the same instants - 1.58x, and 1.5 - 1.6x every time it was measured). The share answers the actual question -
// of the power this card is drawing right now, how much is here because of us?
// Whose utilisation, though (D8)? D7 divided the Windows counters' per-process % by nvidia-smi's device %, and
// that numerator is BLIND for CUDA contexts on a second adapter: over 40 s on snow the 3060 Ti drew 59.7 W with
// Strata the only process holding it, and the counters attributed 2.0 W of it (3 %), reading 0 in 125 of 151
// samples and putting the process on the wrong card in two of the six where it lit up at all. Per-process GPU %
// therefore now comes from `nvidia-smi pmon` on Windows too (proctop.js stamps it, hwstats.js keeps the stream) -
// the same tool the Linux path has always used - and the share is
//     min(1, our family's pmon sm % on that card  /  the pmon sm % of every process on that card)
// both sides read out of the SAME averaged passes. Where pmon cannot speak (AMD / Intel cards, macOS, or a
// stream that died and was given up on) the card falls back to the counters over the device gauge - D7's math -
// and the tooltip says which source priced it. A card is never measured by both at once.
// Measured on the same 40 s, this machine: 5060 Ti 52.0 W of its 76.1 W (share 0.19-1.00, median 0.67 - chrome
// and the desktop composition genuinely hold SMs there) plus 3060 Ti 59.7 W of its 59.7 W (share exactly 1.00
// every second) = 111.7 W of the machine's 135.8 W, against D7's 68.5 W. The ~24 W left over is other
// processes' work on the display card, which is an honest remainder rather than a hole.
// The honest-accounting rules, same roots as the mirror family's:
//  - Energy, not money, is what accumulates: the $/kWh price lives in Settings → General and is applied at
//    draw time, so changing it re-prices the whole session - the joules were measured regardless.
//  - Only REAL family samples accrue energy. The attested-zero heartbeat adds 0 - it writes a w:0 point so the
//    rate face reads "≈$0.00 /h · Offline" exactly like the mirror tiles show real zeros (a family at 0 % asks
//    for 0 W whatever the card reports), but it can never change the total. The user kept that rule (D1) after
//    measuring the loaded-idle draw - 44 W + 54 W at 0-7 % device util, the model resident on both cards - so
//    the lens prices what Strata USES, not what it occupies. pmon reads 0 sm in exactly that state, so idle
//    still reads ≈$0.00 /h on the new source.
//  - A card the family USES (util > 0) with no power reading, or with no same-source total to divide by
//    (including a card whose device gauge reads 0 % while our counters-sourced family reads above 0 - the two
//    samplers cannot agree, so neither number can be trusted), makes the whole real sample unknown: no point,
//    no accrual, no time counted. A partial sum would under-count silently, and the D3 decision was n/a, never
//    a powerLimit stand-in and never a divided-by-zero guess. Cards the family does not use (util 0) add 0 W
//    regardless of what they report - a card's idle base power is charged to nobody.
//  - The share is clamped at 1. The two sides come from one stream on the pmon path, but the family's number is
//    summed across its processes and capped at 100 % by aggregate(), the card's is not, and the accrual and the
//    sample arrive from two samplers whose idea of "now" is a few hundred ms apart. Reading a hair over the
//    card's total is noise, not a claim that this app owns 120 % of a card.
//  - If the Hardware sampler is stale (cardGauges null), no REAL sample accrues for that stretch.
//  - dt between CONSECUTIVE accrued points, capped at 3 x that sample's stamp (the 092 break rule): a lookup
//    gap costs nothing rather than inventing energy across the hole.
//  - No cards at all, or cards we cannot key per-process numbers to (the no-DXGI fallback sums every adapter
//    into one card with no luid): the GPU cost is undefined here, so no points - never a $0.00 claim.
// The ring is the same time-sized shape as every other (PS_WINDOW + one older point; HIST a safety cap), and
// each charge also drops an energy CHUNK on a longer, unshipped trail so any window can be integrated (below).
const cost = {};   // key -> { t0, ws, lastT, hist: [{ t, every, w }] }   ws = watt-seconds (J)
// Returns the per-card estimated watts [w0, w1, ...] (AI_SCOPE-122: pushHist stamps them onto the family
// history point as gpus[i].w), or null when the whole sample is void (the D3/D7/D8 honesty rules below).
// The cost ring and the total keep using the summed w exactly as 121 proved them; cw is the same math
// broken out by card (each entry rounded to 0.1 W, so the rounded entries can differ from the rounded sum
// by a tenth - the two faces are not required to print the same rounding).
function accrueCost(key, r, luids) {
  luids = luids || hwstats.cardKeys();   // pushHist already has the list; probes may leave it out
  let keyed = false;
  luids.forEach(function (k) { if (k) keyed = true; });
  if (!keyed) return null;
  const g = hwstats.cardGauges();
  if (!g) return null;
  const src = r.gpuSrc || {}, totals = r.cardTotals || {};
  let w = 0;
  const cw = [];   // AI_SCOPE-122: the same estimate per card, for the GPU Power mirror tile
  for (let i = 0; i < luids.length; i++) {
    const ck = luids[i];
    const c = ck && r.luids[ck];
    const util = c && c.util != null ? c.util : 0;
    if (util <= 0) { cw[i] = 0; continue; }   // this card asks nothing of us (D7: idle base power is charged to nobody)
    const p = i < g.power.length ? g.power[i] : null;
    if (p == null) return null;   // used card, no power reading: whole sample unknown (D3)
    let d;
    if (src[ck] === 'pmon') {
      d = totals[ck];   // 121 D8: this card's total from the very same pmon passes - never the device gauge
      if (d == null || d <= 0) return null;   // our share with no denominator of the same scale: unknown, not a guess
    } else {
      d = i < g.util.length ? g.util[i] : null;   // counters-sourced numbers divide by the counters' device gauge (D7)
      if (d == null || d <= 0) return null;
    }
    const share = p * Math.min(1, util / d);
    w += share;
    cw[i] = Math.round(share * 10) / 10;
  }
  w = Math.round(w * 10) / 10;
  const c = cost[key] || (cost[key] = { t0: r.at, ws: 0, lastT: null, hist: [] });
  c.hist.push({ t: r.at, every: r.every, w: w });
  const last = c.hist[c.hist.length - 1].t;
  while (c.hist.length > 1 && c.hist[1].t < last - PS_WINDOW) c.hist.shift();
  if (c.hist.length > HIST) c.hist.splice(0, c.hist.length - HIST);
  if (c.lastT != null) {
    const dt = r.at - c.lastT;
    if (dt > 0 && dt <= 3 * (r.every || MIRROR_MS)) {   // W x s = J; no charging across a gap
      const e = w * dt / 1000;
      c.ws += e;
      pushCostChunk(key, r.at, e, c.lastT);   // AI_SCOPE-121: the window-queryable trail (the stretch is (lastT, r.at])
    }
  }
  c.lastT = r.at;
  return cw;
}
// AI_SCOPE-121 (Requests columns + the Total Cost lens's Days range): the same accrual also leaves a trail of
// ENERGY CHUNKS - every charged stretch as { t, ws }, the watt-seconds it added, ending at t. Chunks are
// additive, so integrating any window is a sum over whole chunks: what a request [start, end] cost, and (via
// the saved rows) what a stretch of days costs. A chunk is charged with the same rules as the total above, so
// a hole never contributes, and the price is never baked in - joules only.
// This is NOT the chart ring: it never rides the payload (the page asks for a window sum server-side, or takes
// the per-day buckets the saved rows give it), so it can be long while the wire stays short. Sized in TIME -
// a request is saved seconds after it ends, so what has to be covered is the longest request we will see -
// and count-capped only as a runaway-pace guard (same shape as the rings above).
const COSTLOG_MS = 3600000, COSTLOG_CAP = 4000;
const costLog = {};   // key -> { cov: <earliest time the trail can speak for>, a: [{ t, ws }] } oldest first
function pushCostChunk(key, t, ws, from) {
  const lg = costLog[key] || (costLog[key] = { cov: from, a: [] });
  lg.a.push({ t: t, ws: ws });
  const last = lg.a[lg.a.length - 1].t;
  // Dropping the oldest chunk moves the coverage line to where the NEXT chunk's stretch began - which is
  // exactly the time of the chunk being dropped (consecutive charges abut).
  while (lg.a.length > 1 && last - lg.a[0].t > COSTLOG_MS) lg.cov = lg.a.shift().t;
  if (lg.a.length > COSTLOG_CAP) lg.cov = lg.a.splice(0, lg.a.length - COSTLOG_CAP).pop().t;
}
// Energy attributed to this app's family over [t0, t1], or null when there is no trail at all (the app was
// never measurable this session - an unknown number, not a zero). `n` counts the chunks that landed in the
// window: n = 0 means nothing was ever MEASURED inside it, which the caller must treat as unknown (a gap),
// never as "0 Wh" - a real 0 Wh only exists when chunks are there and they read 0 W (the family was live and
// asked nothing of its cards). `partial` says the window reaches back further than the trail does, so the sum
// is a floor over the covered part only - the same honesty 072's peakBetween marks. Boundary rule: a chunk
// counts when its END lands in (t0, t1], which can over-count a stretch straddling t0 by at most one pace
// (2 s) - and never charges a hole.
function energyBetween(key, t0, t1) {
  const lg = costLog[key];
  if (!lg || !lg.a.length || t0 == null || t1 == null) return null;
  let ws = 0, n = 0;
  for (let i = 0; i < lg.a.length; i++) if (lg.a[i].t > t0 && lg.a[i].t <= t1) { ws += lg.a[i].ws; n++; }
  return { ws: ws, n: n, partial: t0 < lg.cov };
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
// 'failed', so the tiles keep their wording and their zeros with no sampling. A key nobody attests keeps being
// watched exactly as before - ComfyUI today; Ollama attests since 081 and llama.cpp since 082. The app modules
// keep calling watch() every poll, so arming again - the first moment of a load - is immediate, and the pace is
// asked back at once.
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
    h.push({ t: now, attest: attested[k], every: ZERO_EVERY,   // 092: the heartbeat's own interval, stamped like a real point's
      gpus: luids.map(function () { return { vram: 0, util: 0, w: 0 }; }),   // 122: w:0 too - an unmeasurable-at-the-moment family asks 0 W of every card (the tile's per-card powered check still words "no watts for this card" over it)
      ram: 0, ramPrivate: 0, cpu: 0, ioRead: win ? 0 : null, ioWrite: win ? 0 : null });
    pruneRing(h);   // 092: same time-sized ring as the sampler's real points
    // AI_SCOPE-121: the cost ring gets the same attested zero - an off / idle / loading family is
    // asking NOTHING of its cards, so the Cost lens's per-hour face honestly reads "≈$0.00 /h"
    // exactly like the mirror tiles show zeros (0 W x any dt is 0 J, no board power needed to
    // say so; the total never moves). Only keys that were ever measured have a cost ring at all -
    // an app that has not run since boot gets no "since X: $0" claim.
    const cc = cost[k];
    if (cc) {
      cc.hist.push({ t: now, every: ZERO_EVERY, w: 0, attest: attested[k] });
      const cl = cc.hist[cc.hist.length - 1].t;
      while (cc.hist.length > 1 && cc.hist[1].t < cl - PS_WINDOW) cc.hist.shift();
      if (cc.hist.length > HIST) cc.hist.splice(0, cc.hist.length - HIST);
      cc.lastT = now;   // back-to-live dt starts from the heartbeat, like the mirror ring's clock
    }
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
  // 2026-11-09 (rule 4 follow-up): an app that attests off / idle / failed also loses the port owner remembered
  // for it, so the pid of an app that closed can never come back through a recycled PID.
  if (!armed(key)) { delete results[key]; delete fams[key]; dropPortOwners((watches[key] || {}).ports); }
  resolveAt = 0;   // look the app up (or drop it) on the next sample
  syncPace();
}
// Ask proctop for its fastest honest pace while anything actually needs numbers, and release it when nothing does
// (084: one sampler, one rate - the Processes lenses ride the same period rather than a separate display cadence).
// AI_SCOPE-091: "armed" is not the same as "needs numbers". A scope that never attests a state (ComfyUI still;
// Ollama and llama.cpp attest since 081 and 082) is armed by definition, and armed-but-absent apps were holding
// the one shared sampler at 2 s around the clock - ~5.5 % of a core instead of the 0.7 % of the 30 s idle pace -
// and overriding Settings → Engine → Process Refresh Rate for anyone who chose a slower rate. The demand now
// follows what exists: an app that reported live / loading / unloading, a family we actually found, or a watched
// port seen listening.
function needsFastPace() {
  return armedKeys().some(function (k) {
    const s = attested[k];
    if (s && WATCH_STATES[s]) return true;                       // the app's own API says work is happening
    const f = fams[k];
    if (f && f.pids.length) return true;                         // we found its processes: keep the 2 s cadence
    return watches[k].ports.some(function (p) { return !!owners[p]; });   // its port is listening (the wake clock looks)
  });
}
function syncPace() {
  if (!needsFastPace()) { proctop.release('procstats'); updateWakeClock(); return; }
  proctop.start();
  proctop.demand('procstats', MIRROR_MS);
  updateWakeClock();
}
// The wake clock (091): with the demand released, proctop samples at its watched / idle pace (up to 30 s), and
// family resolution is driven by those samples - so an app that starts would go unnoticed for half a minute. This
// clock reads the port table on its own (netstat costs 18 ms) every WAKE_MS while anything is armed and nothing
// needs numbers; when a watched port appears listening, syncPace takes the 2 s demand again.
const WAKE_MS = 10000;
let wakeTimer = null;
function updateWakeClock() {
  const want = armedKeys().length > 0 && !needsFastPace();
  if (want && !wakeTimer) wakeTimer = setInterval(wakeTick, WAKE_MS);
  if (!want && wakeTimer) { clearInterval(wakeTimer); wakeTimer = null; }
}
function wakeTick() {
  const ports = [];
  armedKeys().forEach(function (k) { watches[k].ports.forEach(function (p) { if (ports.indexOf(p) < 0) ports.push(p); }); });
  if (!ports.length) return;                      // nothing to look for (a name-only watcher): the samples carry it
  portOwners(function () { syncPace(); });
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
// Get-NetTCPConnection took 1.5 s - 059's note, which is why that one is only the fallback below, never the
// first call). Only asked when an armed app actually declares ports.
// 2026-11-09 (user's diagnosis + spec, snow): after a Windows 11 update, netstat's LISTENING rows on this
// machine began reporting the owner as PID 0, and the port's row goes missing entirely even while the app
// answers on it (the CIM table reports the same socket inconsistently too - it returns State 0 where a
// listener belongs). Bionic/Ollama-style port-keyed watches died with it: the old `pid > 0` guard threw away
// the only row the port had. Fix inside the SAME one call:
//  1. a LISTENING row with a real pid is the owner (as before), and a pid-0 row can never overwrite one;
//  2. when a port's ONLY listener evidence is pid 0, fall back to the real pid on ESTABLISHED rows whose
//     LOCAL port is that port - the server side of an accepted connection names the owning process right;
//  3. no real pid from either source and nothing remembered: no owner from this table - the second source
//     (portOwnersCim, below) is asked once, off this callback;
//  4. follow-up (user's spec, 2026-11-09, replacing the first version of this rule): rules 1-2 only speak
//     WHILE a connection is open, so a pid-0 listener went ownerless between requests and Bionic's mirror
//     tiles flipped back to "Inactive" - the table is rebuilt from scratch on every call. A port an ARMED app
//     watches keeps the owner the previous table had for it until rules 1-2 see a fresher pid. NO pid-0 row
//     is required any more: on this machine the row itself comes and goes, so its absence is not evidence
//     that the app stopped listening. A pid that died or restarted in the meantime is filtered in
//     windowsFamilies(), which ignores a root proctop no longer has a row for; and the memory is DROPPED when
//     the app is unwatched or disarmed (it attests off / idle / failed), so a closed app never leaves a stale
//     pid in the table for a recycled PID to name.
// TIME_WAIT and every other state are ignored, and a port seen only as the REMOTE end (our side of a
// client connection) is never used - the port is read from the LOCAL address column only.
function portOwners(cb) {
  const ports = [];
  armedKeys().forEach(function (k) { watches[k].ports.forEach(function (p) { if (ports.indexOf(p) < 0) ports.push(p); }); });
  if (!ports.length || ownersBusy) return cb(owners);
  ownersBusy = true;
  execFile('netstat.exe', ['-ano'], { windowsHide: true, encoding: 'utf8' }, function (err, out) {
    ownersBusy = false;
    if (err || !out) return cb(owners);          // keep the previous table; the clock will ask again
    const m = {};      // port -> owner pid: a real listener, or the accepted-connection fallback below
    const zero = {};   // port -> true when its ONLY listener evidence so far is a pid-0 LISTENING row
    const est = {};    // port -> real pid on an ESTABLISHED row whose LOCAL end is that port
    String(out).split(/\r?\n/).forEach(function (l) {
      const p = l.trim().split(/\s+/);
      if (p[0] !== 'TCP' || p.length < 5) return;
      const st = String(p[3]).toUpperCase();
      if (st !== 'LISTENING' && st !== 'ESTABLISHED') return;   // TIME_WAIT, CLOSE_WAIT, ...: never consulted
      const ip = p[1] || '', i = ip.lastIndexOf(':'), port = i > 0 ? +ip.slice(i + 1) : 0, pid = +p[4];
      if (port > 0 && port < 65536) {
        if (st === 'LISTENING') {
          if (pid > 0) { m[port] = pid; zero[port] = false; }           // a real listener wins the port, whichever order the rows come in
          else if (zero[port] !== false) zero[port] = true;             // pid 0 only MARKS the port; it never owns anything
        } else if (pid > 0) {
          est[port] = pid;                                              // LOCAL end only: the REMOTE column is the client's view
        }
      }
    });
    Object.keys(zero).forEach(function (k) {
      if (zero[k] && m[k] == null && est[k] != null) m[k] = est[k];            // rule 2: pid-0 listener, rescued by the connection it accepted
    });
    // Rule 4: an armed watch still names this port, so it is ours to keep - carry over the owner the previous
    // table had for it, whether or not netstat printed anything for that port (rules 1-2 already replaced it as
    // soon as a fresher pid showed up). A port nobody armed-watches is not carried at all.
    const missing = [];
    ports.forEach(function (p) {
      if (m[p] != null) return;
      if (owners[p] > 0) m[p] = owners[p];
      else missing.push(p);                                                    // rule 3: the slow source below, at most once per clock
    });
    owners = m;
    cb(owners);
    if (missing.length) portOwnersCim(missing);
  });
}
// The second source (user's spec B, 2026-11-09): CIM (`Get-NetTCPConnection`) names the owner of a listener that
// netstat reports as PID 0, or has no row for at all - measured on snow, :1234 came back RemotePort 0 /
// OwningProcess 29668 with State 0 (not 2/Listen). It costs ~1.5 s (059's note), so it never rides the netstat
// callback above: the answer is merged into `owners` and the next resolve carries it by rule 4. Asked at most
// once per resolve clock (RESOLVE_MS) and never while a previous call is still running, so the 2 s sampler and
// the wake clock never stack PowerShell processes. State is NOT consulted (this machine reports 0 for a real
// listener); a row counts when its REMOTE end is 0 - the listening side, never our side of a client connection.
// PowerShell here cannot call .NET static methods (GOTCHAS), so the cmdlet prints its own three fields as plain
// text lines and Node parses them.
let cimAt = 0, cimBusy = false;
function portOwnersCim(ports) {
  if (cimBusy || Date.now() - cimAt < RESOLVE_MS) return;
  cimAt = Date.now(); cimBusy = true;
  const cmd = "$ErrorActionPreference='SilentlyContinue'; Get-NetTCPConnection -LocalPort " + ports.join(',') +
    " -ErrorAction SilentlyContinue | ForEach-Object { '{0} {1} {2}' -f $_.LocalPort, $_.RemotePort, $_.OwningProcess }";
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, encoding: 'utf8', timeout: 8000 }, function (err, out) {
    cimBusy = false;
    if (err || !out) return;                        // helper stderr is discarded: no trace, and the clock asks again
    let found = 0;
    String(out).split(/\r?\n/).forEach(function (l) {
      const p = l.trim().split(/\s+/);
      if (p.length < 3) return;
      const port = +p[0], remote = +p[1], pid = +p[2];
      if (ports.indexOf(port) < 0 || remote !== 0 || !(pid > 0)) return;   // watched ports only, listening end only, real pids only
      if (owners[port] > 0) return;                 // a netstat owner (or a carried one) is never overwritten by the slow source
      owners[port] = pid; found++;
    });
    if (!found) return;
    resolveAt = 0;                                  // the next proctop sample resolves the family with the owner it now has
    syncPace();                                     // and needsFastPace() wakes up, which judges the pace off this same table
  });
}
// Rule 4's memory only exists while an armed watch asks for the port, so it goes away with the watch. Dropping it
// (rather than only letting the carry-over stop) matters: the pid would otherwise sit in the table after the app
// closed, and Windows recycles pids. A port another armed watch still names is kept.
function dropPortOwners(ports) {
  if (!ports || !ports.length) return;
  const wanted = {};
  armedKeys().forEach(function (k) { watches[k].ports.forEach(function (p) { wanted[p] = 1; }); });
  ports.forEach(function (p) { if (!wanted[p]) delete owners[p]; });
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
    // Rule 4 hands over a pid remembered from an earlier table (including one the CIM second source named), and
    // it can have died or restarted since, so a port owner only becomes a root when proctop still has a row for
    // it. (familyOf / the name at the bottom read rows[pid], which throws on a missing pid; rules 1-2 replace
    // the remembered owner as soon as a fresher pid shows up, and disarm / unwatch drop it outright.)
    let root = 0;
    w.ports.forEach(function (p) { const o = tb[p]; if (!root && o && rows[o]) root = o; });
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
    const r = { at: sample.at, every: sample.every || proctop.everyMs(), pids: [], luids: {}, gpuSrc: sample.gpuSrc || {}, cardTotals: sample.cardTotals || {}, cpu: null, ram: 0, ramPrivate: 0, ioRead: 0, ioWrite: 0, ioSeen: false, privSeen: false };   // 092: the pace rides with the sample it came from (proctop.js stamps it); everyMs() is only the fallback. 121 D8: so does which source each card's GPU % came from, and that source's own card-wide total
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
  syncPace();   // 091: the pace follows what was found - an app that stopped (no family any more) releases the 2 s demand
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
  // A process counts as app-specific when EITHER its argv0 name or its kernel comm is not a shared runner: the
  // Studio launcher execs 'python' but sets comm 'unsloth', and that self-chosen comm is exactly the identity
  // underApp() looks for in ancestors - it should count for the process itself too.
  const specific = function (pid) { const p = snap.procs[pid];
    return !GENERIC[String(p.name).toLowerCase().replace(/\.exe$/, '')] || !GENERIC[String(p.comm || '').toLowerCase().replace(/\.exe$/, '')]; };
  // AI_SCOPE-080 in tree mode: a process found by name is an ANCHOR - count its whole family too, not just it
  // (Unsloth Studio's launcher holds the :8888 socket but runs with all caps dropped (CapEff = 0), so /proc/PID/fd
  // is unreadable even to its owner and the port owner stays invisible; only tree mode asks for this).
  const sel = all.filter(function (pid) { return specific(pid) || underApp(pid); });
  return w.tree ? procnix.family(snap, sel) : sel;
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
// AI_SCOPE-080 opts.tree (Windows; on nix it makes name-found processes ANCHORS of their family in the name
// fallback - see nixResolve): the names stop being a filter and become
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
  if (w) dropPortOwners(w.ports);   // a port this app no longer declares loses its remembered owner (rule 4)
  refreshWatch(key);   // 084: the resolution and the sampling only follow while the app's state asks for numbers
}
function unwatch(key) {
  if (!watches[key]) return;
  const ports = watches[key].ports;
  delete watches[key]; delete results[key]; delete fams[key];
  dropPortOwners(ports);   // rule 4: the memory goes with the watch
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
  // AI_SCOPE-121: the energy attributed to an app's family since this server booted (watt-seconds), plus the
  // 5-minute ring of per-cycle estimated watts the Cost lens draws. null until the first accrueable sample.
  cost: function (key) { return cost[key] || null; },
  // AI_SCOPE-121: integrate that same accrual over a window - what one request cost in joules. null = unknown.
  energyBetween: energyBetween,
  attest: attest, unattest: unattest,   // AI_SCOPE-077 review: offline attestation drives the zero heartbeat
  _test: { aggregate: aggregate, windowsFamilies: windowsFamilies, nixResolve: nixResolve, results: results, fams: fams,
    familyOf: familyOf, ancestryOf: ancestryOf, kidsIndex: kidsIndex,
    accrueCost: accrueCost, cost: cost, costLog: costLog, zeroTick: zeroTick,
    // 2026-11-09 port-owner follow-up: the lookup and its table for replay probes (a getter, because the
    // owners map is rebuilt as a new object on every call).
    portOwners: portOwners, owners: function () { return owners; } } };   // AI_SCOPE-121: the energy accumulator, probeable with a stubbed hwstats
