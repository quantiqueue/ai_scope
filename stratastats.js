// Strata stats (https://github.com/Niko1221/Strata), read from the Strata desktop app.
//  - The app's local host (default http://127.0.0.1:47831) polls its engine and hands the numbers to its own
//    Monitor screen as GET /api/native -> instances[].metrics. We read the same JSON: no key, read-only.
//    (It's the app's internal API, not a documented one, so every field is optional here.)
//  - live state (phase, tok/s, prompt progress, context), the loaded model (context, KV mode, experts in VRAM),
//    finished requests (prompt / reused / output tokens, tok/s, first token, expert hit rate, duration),
//    installed models with Strata's own "fits on this PC" verdict.
//  - finished requests are saved to ~/.ai_scope/strata-requests.jsonl (Strata keeps them only in memory),
//    with our whole-PC peak load while each ran.
// Settings (URL) come from the scope's install settings in start(). No dependencies; conservative JS.
'use strict';
const http = require('http');
const fs = require('fs');
const hwstats = require('./hwstats');
const procstats = require('./procstats');   // Strata's model process: VRAM per card, GPU %, CPU, RAM (Windows; AI_SCOPE-051)
// The engine (python, serve/server.py) listens on the instance's private port (e.g. 18500) and runs the model in a child
// strata.exe. AI_SCOPE only uses that port to find the process (netstat); it never talks to the key-protected engine.
// AI_SCOPE-080: strata-vision.exe joins as a second name, and the watch turns into TREE mode - the 078 capture
// showed a load starting a launcher python + an engine-manager python (parent of strata.exe AND strata-vision.exe)
// ~80 s before the runner appears; tree mode counts those workers' real CPU / RAM / I/O through the anchors'
// ancestry, so the mirror tiles show the load happening instead of sitting at zeros (078: the manager alone ran
// ~6 % CPU and read hundreds of MB/s before strata.exe existed).
const MODEL_PROCS = ['strata.exe', 'strata-vision.exe'];
const paths = require('./paths');                       // data folder: ~/.ai_scope

const DEFAULT_URL = 'http://127.0.0.1:47831';
const REQ_FILE = paths.file('strata-requests.jsonl');
const reqstore = require('./reqstore');            // AI_SCOPE-094 slice 1: the shared history store
const reqstats = require('./reqstats');            // AI_SCOPE-094 slice 3: the shared average builder

let base = DEFAULT_URL;
let timer = null;
let busy = false;
let online = false;
let lastError = null;
let native = null;          // last good /api/native response
let fetchedAt = 0;
const known = {};           // key -> true (saved)
const waiting = {};         // key -> raw request seen but not saved yet (waiting for the samples after it ended)
// One store, one file, this scope's own 1000-row ring. `requests` is the store's live array:
// the store mutates it in place, so every reader below keeps seeing the same array.
const store = reqstore.createStore({
  file: REQ_FILE,
  accept: function (r) { return !!r.key && !known[r.key]; },   // dedupe what the file already holds
  remember: function (r) { if (r.key) known[r.key] = true; },
  // AI_SCOPE-094 slice 2: old files are never rewritten, so every line saved before this rename
  // arrives with the old names. Map them on read (the map is permanent, not transitional).
  mapRow: function (r) {
    if (r.reused !== undefined) { r.cachedTokens = r.reused; delete r.reused; }
    if (r.decodeMs !== undefined) { r.genMs = r.decodeMs; delete r.decodeMs; }
    // slice 4: lines saved before the provenance vocabulary carry the old boolean instead.
    if (r.genDerived !== undefined) { if (r.genDerived) reqstats.setProv(r, 'genTps', reqstats.PROV.DERIVED); delete r.genDerived; }
    if (r.promptTps != null) reqstats.setProv(r, 'promptTps', reqstats.PROV.DERIVED);
    return r;
  },
  onError: function (msg) { lastError = msg; }
});
const requests = store.rows();
let logo = { tried: 0, light: null, dark: null };   // Strata's mark for light / dark backgrounds

function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

function getJson(path, timeout, cb) {
  let u;
  try { u = new URL(base + path); } catch (e) { return cb(e); }
  const req = http.get({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, timeout: timeout,
                         headers: { accept: 'application/json' } }, function (res) {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', function (d) { body += d; });
    res.on('end', function () {
      if (res.statusCode !== 200) return cb(new Error('HTTP ' + res.statusCode));
      try { cb(null, JSON.parse(body)); } catch (e) { cb(new Error('not JSON - is this the Strata app?')); }
    });
  });
  req.on('timeout', function () { req.destroy(new Error('timeout')); });
  req.on('error', function (e) { cb(e); });
}

// ---------- saved requests (the store does the read, parse, sort, trim, append, cap) ----------
function loadRequests() { store.load(); }
function saveRequest(r) { store.append(r); }
// One finished request from the engine's metrics -> our row. `time` is when it finished (seconds).
function toRow(inst, x) {
  const end = num(x.time) != null ? x.time * 1000 : null;
  const dur = num(x.duration_s) != null ? x.duration_s * 1000 : null;
  const promptRead = num(x.prompt_read);
  const promptMs = num(x.prompt_ms), genMs = num(x.decode_ms), out = num(x.output_tokens);
  const row = {
    key: inst.id + ':' + x.id, id: String(x.id), instanceId: inst.id,
    model: inst.label || inst.model || 'unknown', variant: inst.model || null,
    start: end != null && dur != null ? end - dur : null, end: end, durationMs: dur, finish: x.finish || null,
    // AI_SCOPE-094 slice 2: canonical names — Strata's `reused` is the shared Cached column,
    // and its `decode_ms` is generation time (`genMs`), like every other scope.
    promptTokens: num(x.prompt_tokens), cachedTokens: num(x.reused), promptRead: promptRead, outputTokens: out,
    promptMs: promptMs, genMs: genMs,
    genTps: num(x.decode_tok_s) != null ? x.decode_tok_s : (out && genMs ? out / (genMs / 1000) : null),
    promptTps: promptRead && promptMs ? promptRead / (promptMs / 1000) : null,
    firstTokenMs: num(x.first_engine_token_s) != null ? x.first_engine_token_s * 1000 : null,
    hitRate: num(x.hit_rate),
    draftsOffered: num(x.drafts_offered), draftsAccepted: num(x.drafts_accepted),
  };
  // AI_SCOPE-094 slice 4: provenance. Every count and duration above is Strata's own reading, so it
  // needs no entry (no entry = exact). Speed is the exception: Strata reports decode_tok_s, and when
  // it does not we divide tokens by time ourselves; its prompt speed is always ours, since Strata
  // gives no prompt-token rate at all.
  if (num(x.decode_tok_s) == null) reqstats.setProv(row, 'genTps', reqstats.PROV.DERIVED);
  reqstats.setProv(row, 'promptTps', reqstats.PROV.DERIVED);
  return row;
}
function collectRequests(instances) {
  const now = Date.now();
  instances.forEach(function (inst) {
    // Strata lists them newest first; save oldest first so our list stays in time order.
    const list = (inst.metrics && Array.isArray(inst.metrics.requests) ? inst.metrics.requests.slice() : [])
      .sort(function (a, b) { return (num(a && a.time) || 0) - (num(b && b.time) || 0); });
    list.forEach(function (x) {
      if (!x || x.id == null) return;
      const key = inst.id + ':' + x.id;
      if (known[key]) return;
      const row = toRow(inst, x);
      // Wait a few seconds after it ended so the 2 s system samples covering its end exist (peak load).
      if (row.end != null && now < row.end + 3000) { waiting[key] = true; return; }
      delete waiting[key];
      row.peak = row.start != null ? hwstats.peakBetween(row.start, row.end + 2000) : null;
      saveRequest(row);
    });
  });
}

// ---------- live generation-speed history (AI_SCOPE-093 slice 1, strata.tps lens) ----------
// One point per poll while Strata reports live.tok_s - the engine's own number; the field is optional, and an
// absent one is a gap, never a derived stand-in (the 072 no-invented-numbers rule). Time-sized like the procstats
// rings (092): keep the window plus one older sample so the leftmost segment enters from the edge; the count is a
// safety cap only. Each point carries `every` (the 2 s poll pace that made it) so a chart judges a gap by the pace
// of that moment, and `m` (the model) for the hover and any later per-model series. Idle polls add NOTHING:
// between requests the line breaks honestly - absence of a number is never a number (077).
const TPS_WINDOW = 300000, TPS_CAP = 170;
let tpsHist = [];
function pushTps(t, every, v, model) {
  tpsHist.push({ t: t, every: every, v: v, m: model });
  const last = tpsHist[tpsHist.length - 1].t;
  while (tpsHist.length > 1 && tpsHist[1].t < last - TPS_WINDOW) tpsHist.shift();
  if (tpsHist.length > TPS_CAP) tpsHist.splice(0, tpsHist.length - TPS_CAP);
}

// AI_SCOPE-093 slice 2 (strata.ptps lens): the same shape for prompt-processing speed. Strata reports
// live.prefill_tok_s_mean - a running mean of the CURRENT request's prefill. Only the prompt phases count
// ('reading' / 'thinking'): sampling during 'generating' would replay a finished mean as fresh history,
// which the 072 no-invented-numbers rule forbids. Idle polls again add nothing.
// REVISED AGAIN 2026-11-01 17:50 (user: "Gen, Prompt, and Context, and Hit should create an edge border if an
// N/A occurs on refresh"): the real-wait stamp from the neighbour-join revision (below the 12:09 note) is
// SUPERSEDED - it hid dropouts by making every gap equal its own stamp. ptps points carry the 2 s PACE stamp
// like tps / ctx, so a poll that found no mean is a visible N/A hole on the clock board, bordered at the faces
// that face it. Absence is information, not something to paper over.
let ptpsHist = [];
function pushPtps(t, every, v, model) {
  ptpsHist.push({ t: t, every: every, v: v, m: model });
  const last = ptpsHist[ptpsHist.length - 1].t;
  while (ptpsHist.length > 1 && ptpsHist[1].t < last - TPS_WINDOW) ptpsHist.shift();
  if (ptpsHist.length > TPS_CAP) ptpsHist.splice(0, ptpsHist.length - TPS_CAP);
}

// AI_SCOPE-093 slice 3 (strata.ctx lens): context fill sampled while a request runs (prompt + generated -
// the number the running card shows), so each run draws a rising ramp. ctxLast is the fill the engine was
// LAST SEEN holding: Strata keeps its KV cache between requests on the same loaded instance (that is what
// makes the next turn report millions of reused tokens), so an idle "current context" is a real claim only
// while the same instance is still loaded - an unload or a model switch makes it stale, and getState checks
// the instance id before returning it.
let ctxHist = [];
let ctxLast = null;   // { t, v, m, id }
function pushCtx(t, every, v, model, instId) {
  ctxHist.push({ t: t, every: every, v: v, m: model });
  const last = ctxHist[ctxHist.length - 1].t;
  while (ctxHist.length > 1 && ctxHist[1].t < last - TPS_WINDOW) ctxHist.shift();
  if (ctxHist.length > TPS_CAP) ctxHist.splice(0, ctxHist.length - TPS_CAP);
  ctxLast = { t: t, v: v, m: model, id: instId };
}

// ---------- polling ----------
function poll() {
  if (busy) return;
  busy = true;
  getJson('/api/native', 3000, function (err, d) {
    busy = false;
    if (err || !d || !Array.isArray(d.instances)) {
      online = false; native = null;
      procstats.attest('strata', 'off');   // AI_SCOPE-077 review: offline attestation lets procstats write honest zero history
      lastError = err ? (err.code === 'ECONNREFUSED' ? 'Strata app not running at ' + base : err.message) : 'unexpected answer - is this the Strata app?';
      return;
    }
    online = true; lastError = null; native = d; fetchedAt = Date.now();
    // AI_SCOPE-093: a generation-speed point for this cycle when Strata says a request is active and reports its
    // own live tok/s (same instance pick and phase gate as the running card - the two must agree).
    const tInst = pickInstance(d), tLive = tInst && tInst.metrics ? tInst.metrics.live : null;
    if (tInst && ACTIVE[tInst.phase] && tLive && num(tLive.tok_s) != null) pushTps(fetchedAt, 2000, num(tLive.tok_s), tInst.label || tInst.model || 'unknown');
    // AI_SCOPE-093 slice 2: the prefill mean, prompt phases only (the phase gate is the honest bit - see above).
    if (tInst && (tInst.phase === 'reading' || tInst.phase === 'thinking') && tLive && num(tLive.prefill_tok_s_mean) != null) pushPtps(fetchedAt, 2000, num(tLive.prefill_tok_s_mean), tInst.label || tInst.model || 'unknown');
    // AI_SCOPE-093 slice 3: context fill while a request is active - same computation as the running card's
    // contextUsed in getState (prompt + generated), so the tile and the card can never disagree.
    if (tInst && ACTIVE[tInst.phase] && tLive) {
      const cP = num(tLive.prompt_tokens), cG = num(tLive.generated);
      if (cP != null) pushCtx(fetchedAt, 2000, cP + (cG || 0), tInst.label || tInst.model || 'unknown', tInst.id);
    }
    const enginePorts = d.instances.map(function (i) { return +i.port; }).filter(function (p) { return p > 0 && p < 65536; });
    // 077 review batch 2: attestation from the app's own API - engine instances loaded => 'live' (a
    // missed process lookup stays a gap, never zeros); no instances => 'idle' (nothing is loaded, it
    // genuinely uses nothing - procstats writes zeros, the tile sub reads "No Model Loaded").
    // AI_SCOPE-080: Strata's instance status words the load window too - 'loading' / 'unloading' / an
    // error earn their own attestation (and its zero points get marked with them), so the tiles say
    // "Loading…" / "Unloading…" / "Load failed" instead of a stale "No Model Loaded" or a bare gap.
    // With the tree watch below, 'loading' zeros only stand until the load's own workers (engine
    // manager / launcher, anchored by strata-vision.exe) are measurable - usually ~5 s in.
    let state = 'idle';
    if (d.instances.length) {
      state = 'live';
      for (let i = 0; i < d.instances.length; i++) {
        const ins = d.instances[i];
        if (ins.error || ins.status === 'error' || ins.status === 'failed') { state = 'failed'; break; }
        if (ins.status === 'loading') state = 'loading';
        else if (ins.status === 'unloading' && state !== 'loading') state = 'unloading';
      }
    }
    procstats.attest('strata', state);
    // 077 review batch 3: always watch, even with no engine port - during a model LOAD (or unload) the
    // engine strata.exe is already running hot while the API reports no instance yet and the port is not
    // LISTENING either. procstats then finds strata.exe by its (app-specific) exe name, so the mirror
    // tiles show the real load-time I/O / CPU / RAM instead of idle zeros.
    // AI_SCOPE-080: tree mode extends that to the whole Strata process tree (anchors + descendants +
    // ancestry) - the 078 capture showed the runner process does not even exist for the first ~80 s of
    // a load; its parent chain is what works in that window, and it is safe to count because a
    // strata-named child proves the tree belongs to Strata.
    procstats.watch('strata', enginePorts, MODEL_PROCS, { tree: true });
    collectRequests(d.instances);
    if ((!logo.light || !logo.dark) && Date.now() - logo.tried > 60000) fetchLogos();
  });
}
// Strata's own mark for the tab, served by the running app (the UI falls back to its icon otherwise).
// strata-mark-light.svg has dark bars (for light backgrounds), strata-mark-dark.svg light bars (for dark ones).
function fetchLogos() {
  logo.tried = Date.now();
  [['light', '/brand/strata-mark-light.svg'], ['dark', '/brand/strata-mark-dark.svg']].forEach(function (v) {
    let u;
    try { u = new URL(base + v[1]); } catch (e) { return; }
    http.get({ hostname: u.hostname, port: u.port || 80, path: u.pathname, timeout: 3000 }, function (res) {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', function (d) { if (body.length < 200000) body += d; });
      res.on('end', function () { if (res.statusCode === 200 && /<svg[\s>]/.test(body)) logo[v[0]] = body; });
    }).on('error', function () {}).on('timeout', function () { this.destroy(); });
  });
}
function getLogo(theme) { return theme === 'dark' ? (logo.dark || logo.light) : (logo.light || logo.dark); }

// ---------- state for the page ----------
function pickInstance(d) {
  const list = d.instances || [];
  return list.filter(function (i) { return i.id === d.defaultId; })[0] ||
         list.filter(function (i) { return i.status === 'ready'; })[0] || list[0] || null;
}
function catalogEntry(d, variant) {
  const fams = d.catalog && Array.isArray(d.catalog.families) ? d.catalog.families : [];
  for (let i = 0; i < fams.length; i++) {
    const sizes = fams[i].sizes || [];
    for (let j = 0; j < sizes.length; j++) if (sizes[j].id === variant) return { family: fams[i], size: sizes[j] };
  }
  return null;
}
function gpuNames(d, indexes) {
  const gpus = d.hardware && Array.isArray(d.hardware.gpus) ? d.hardware.gpus : [];
  return (indexes || []).map(function (ix) {
    const g = gpus.filter(function (x) { return x.index === ix; })[0];
    return g ? g.name.replace(/^NVIDIA GeForce /, '') : 'GPU ' + ix;
  });
}
const ACTIVE = { loading: 1, reading: 1, thinking: 1, generating: 1 };

function getState(limit, since) {
  const d = native;
  const out = { online: online, url: base, error: lastError, fetchedAt: fetchedAt || null,
                version: null, engineVersion: null, updateNotice: null,
                current: null, loaded: null, totals: null, average: null, promptAverage: null, installed: [],
                totalRequests: requests.length, rows: requests.slice(-(limit || 100)).reverse() };
  // Strata's model process(es): VRAM / GPU % per card, CPU %, RAM; null elsewhere or with no model loaded.
  // AI_SCOPE-072: processCards (Hardware card names / totals for the tile labels) and processHistory (5 min,
  // newest last) join the answer, and all of it stays in the payload when Strata itself is offline - the GPU /
  // VRAM tiles draw their histories right through an "Inactive" stretch. AI_SCOPE-073: the history points also
  // carry the process's ram / ramPrivate for the Strata RAM lens (per-process RAM exists on macOS / Linux too,
  // so that lens is not gated on per-process GPU support).
  out.process = procstats.get('strata'); out.processSupported = procstats.supported();
  out.processHistory = procstats.history('strata', since);   // AI_SCOPE-084: ?since=<t> sends only the new points
  out.processCards = hwstats.getStats().info.gpus.map(function (g) { return { name: g.name, vramTotal: g.vramTotal, source: g.source }; });
  out.tpsHistory = tpsHist;   // AI_SCOPE-093: the whole (small) ring rides every answer - the client appends only newer points
  out.promptHistory = ptpsHist;   // AI_SCOPE-093 slice 2
  out.contextHistory = ctxHist;   // AI_SCOPE-093 slice 3
  if (!d) return out;
  out.version = d.version || null;
  out.engineVersion = (d.engineInfo && d.engineInfo.version) || (d.engine && d.engine.version) || null;
  out.updateNotice = (d.engine && d.engine.updateNotice) || null;
  const inst = pickInstance(d);
  const m = inst && inst.metrics ? inst.metrics : {};
  const eng = m.engine || {}, live = m.live || {};
  if (inst) {
    const ctxMax = num(eng.max_context) || num(inst.context);
    out.loaded = {
      id: inst.id, label: inst.label || inst.model, variant: inst.model, status: inst.status, phase: inst.phase,
      context: ctxMax, kv: eng.kv || null, gpus: gpuNames(d, inst.gpus), parallel: num(inst.parallel),
      expertSlots: num(eng.expert_slots), expertCacheMib: num(eng.expert_cache_mib), vramFreeMib: num(eng.vram_free_mib),
      speculation: num(eng.spec) != null ? eng.spec > 0 : null, engineVersion: eng.version || null,
      loadedAt: inst.loadedAt || null, resourceProfile: inst.resourceProfile || null, error: inst.error || null,
    };
    if (ACTIVE[inst.phase]) {
      const prompt = num(live.prompt_tokens), gen = num(live.generated);
      out.current = {
        model: out.loaded.label, phase: inst.phase, phaseText: live.phase || null, queued: num(live.queued),
        promptTokens: prompt, promptRead: num(live.prompt_read), promptTotal: num(live.prompt_total),
        generated: gen, maxTokens: num(live.max_tokens), elapsedMs: num(live.elapsed_s) != null ? live.elapsed_s * 1000 : null,
        tokS: num(live.tok_s), prefillTokS: num(live.prefill_tok_s_mean),
        contextUsed: prompt != null ? prompt + (gen || 0) : null, contextMax: ctxMax,
      };
    }
    const t = m.totals;
    if (t) out.totals = { since: num(t.since) != null ? t.since * 1000 : null, requests: num(t.requests),
                          promptTokens: num(t.prompt_tokens), cachedTokens: num(t.reused), outputTokens: num(t.output_tokens),
                          draftsOffered: num(t.drafts_offered), draftsAccepted: num(t.drafts_accepted) };
    // AI_SCOPE-093 slice 3: the context tile's big number. Live while a request runs (the card's own contextUsed);
    // idle is the last-seen held fill, claimed ONLY while the same instance id is still loaded - Strata keeps its
    // KV cache between requests (that is why the next one reuses millions of tokens), but an unload or a loaded
    // model change makes the held number stale, and then the honest answer is no answer.
    const cMax = num(eng.max_context) || num(inst.context);
    if (out.current && out.current.contextUsed != null) out.contextState = { used: out.current.contextUsed, max: cMax || null, model: out.current.model, at: fetchedAt, live: true };
    else if (ctxLast && ctxLast.id === inst.id) out.contextState = { used: ctxLast.v, max: cMax || null, model: inst.label || ctxLast.m, at: ctxLast.t, live: false };
  }
  // AI_SCOPE-094 slice 3: both idle numbers come from one shared token-weighted builder; what stays
  // here is what only Strata knows - which label the loaded model carries, and that its prompt
  // speed is the tokens ACTUALLY READ after cache reuse, not the whole prompt.
  const model = out.loaded ? out.loaded.label : (requests.length ? requests[requests.length - 1].model : null);
  const a = reqstats.avgSpeed(requests, model, { timeField: 'genMs' });
  if (a) out.average = { model: model, genTps: a.value, requests: a.requests };
  const pa = reqstats.avgSpeed(requests, model, { tokensField: 'promptRead', timeField: 'promptMs' });
  if (pa) out.promptAverage = { model: model, promptTps: pa.value, requests: pa.requests };
  const inst2 = d.installed && Array.isArray(d.installed.models) ? d.installed.models : [];
  out.installed = inst2.map(function (x) {
    const c = catalogEntry(d, x.model);
    const rec = c && c.size.gpu_options ? (c.size.gpu_options.options || []).filter(function (o) { return o.key === c.size.gpu_options.recommended; })[0] : null;
    return {
      variant: x.model, name: c ? c.family.title + ' ' + c.size.model : (x.model_name || x.model),
      diskGb: num(x.diskGb), context: num(x.context), ready: !!x.ready, images: x.images === 'yes',
      loaded: (d.instances || []).some(function (i) { return i.model === x.model && i.status === 'ready'; }),
      memoryGb: c ? num(c.size.memory_gb) : null, onThisPc: c ? c.size.on_this_pc || null : null,
      fitSummary: rec ? rec.summary || null : null, missingParts: num(x.partsMissing),
    };
  });
  return out;
}

function start(settings) {
  stop();
  settings = settings || {};
  base = String(settings.url || DEFAULT_URL).replace(/\/+$/, '');
  loadRequests();          // the store ignores a second load (AI_SCOPE-094 slice 1)
  poll();
  timer = setInterval(poll, 2000);
}
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  procstats.unwatch('strata');
  procstats.unattest('strata');   // 077 review: an uninstalled scope stops claiming history
  online = false; native = null; lastError = null;
}

module.exports = { start: start, stop: stop, getState: getState, getLogo: getLogo };
