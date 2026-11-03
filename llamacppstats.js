// llama.cpp server stats (AI_SCOPE-006): `llama serve` (the llama launcher, default port 9931) or a plain
// `llama-server` build (default 8080). Read-only, no key, no relay. Two server modes:
//  - single model (`-m <gguf>`): /props (model, context, slots, build), /v1/models (size, parameters), /slots.
//  - router (`--models-dir <folder>`, /props role "router"): /models lists every GGUF in the folder with its state
//    (loaded / unloaded) and, when loaded, the port of the child server running it. Each loaded model's /props and
//    /slots are read from that child's own port (this PC), never through the router: asking the router about an
//    unloaded model (/props?model=, /slots?model=) makes it LOAD that model (seen on snow). A router on another
//    machine is asked with ?model=, only for models its /models answer called loaded in the same look.
//  - /slots (on by default; off with --no-slots), polled every 500 ms (250 ms while a slot is busy): what each slot
//    is doing. The server keeps no finished-request timings, so the request history is built from these looks (user's
//    decision): token counts are exact, tok/s, first token and duration are estimates; requests shorter than a look
//    may only be seen afterwards (by their task id) with fewer details.
//  - /metrics (only with --metrics; per model, its child's own in router mode): its counters move only when a request
//    ends, by exactly that request's numbers. So a request that ran alone on its model gets exact prompt / generation
//    times and speeds (the counters before and after it); overlapping requests keep the estimates. Also the queue
//    (requests waiting for a free slot) and since-load totals.
//  - finished requests are saved to ~/.ai_scope/llamacpp-requests.jsonl, with the whole-PC peak load.
// Settings (URL; empty = auto-detect 127.0.0.1:9931, then :8080) come from the scope's install settings in start().
// No dependencies; conservative JS.
'use strict';
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');            // AI_SCOPE-098: resolving unloaded router model files under --models-dir
const hwstats = require('./hwstats');
const procstats = require('./procstats');   // process stats: VRAM per card, GPU %, CPU, RAM (Windows)
// `llama serve` runs the model in llama.exe itself; in router mode each model is a child llama.exe. Plain builds:
// llama-server.exe. Watched by port, so Bionic's / Ollama's own llama-server.exe children (other ports) are not mixed in.
const MODEL_PROCS = ['llama.exe', 'llama-server.exe'];
const paths = require('./paths');

const CANDIDATES = ['http://127.0.0.1:9931', 'http://127.0.0.1:8080'];
const REQ_FILE = paths.file('llamacpp-requests.jsonl');
const reqstore = require('./reqstore');            // AI_SCOPE-094 slice 1: the shared history store
const reqstats = require('./reqstats');            // AI_SCOPE-094 slice 3: the shared average builder
const ggufmeta = require('./ggufmeta');            // AI_SCOPE-098 review: GGUF header provenance (HF repo, size label)
const POLL_MS = 500;           // all slots idle (a request's start is known to about ± ¼ s)
const POLL_BUSY_MS = 250;      // a slot busy: look more often for better speed / timing estimates
const PROPS_MS = 10000;

let configured = '';        // URL from the settings ('' = auto-detect)
let base = null;            // the server in use
let local = false;          // base is on this PC (model children reachable on 127.0.0.1)
let timer = null, busy = false, running = false;
let online = false, lastError = null;
let keyNeeded = null;       // URL of a llama.cpp server that answered 401 (needs --api-key's key)
let apiKey = '';            // token for --api-key servers (the scope's 'API key' setting), sent as Bearer
let scopeModelsDir = null;    // AI_SCOPE-098: the --models-dir folder from the scope card (settings)
let lensModelsDir = null;     // AI_SCOPE-098: per-poll override from the Installed lens setting (the ?md= param)
let modelsDir = null;         // the folder actually used this poll: lens value if set, else the scope's
let fileResCache = {};      // dir|id -> resolved GGUF path ('' = looked and not found), re-keyed when the dir changes
let rootProps = null, rootPropsAt = 0;
let router = null;          // router mode: { maxInstances, autoload } (null = single model)
let models = {};            // id -> { id, name, state, path, port, meta, props, propsAt, slots, slotsEnabled }
let order = [];             // model ids in the server's order
let modelsAt = 0;
const slotState = {};       // model id + '#' + slot id -> { busy, task, seenAt, rec, model }
// One store, one file, this scope's own 1000-row ring (AI_SCOPE-094 slice 1).
const store = reqstore.createStore({
  file: REQ_FILE,
  accept: function (r) { return !!r.end; },        // load filter: rows without an end time are unusable
  // AI_SCOPE-094 slice 2: rows saved before the explicit flags carried no `exact` at all, and the
  // old client read "absent" as estimated. Say so on read so those lines keep their ≈.
  mapRow: function (r) {
    // slice 4: the 59 lines saved before this change carry the old boolean dialect. Read them as
    // provenance instead, so the ≈ on an estimated line and the plain counter numbers on a settled
    // line both survive - the files themselves are never rewritten.
    const P = reqstats.PROV;
    if (r.exact === undefined && r.genExact === undefined && r.src === undefined) r.exact = false;
    if (r.src === undefined) {
      const settled = r.exact === true;
      if (settled) {
        reqstats.setProv(r, 'outputTokens', P.EXACT);
        if (r.genMs != null) reqstats.setProv(r, 'genMs', P.EXACT);
        if (r.promptMs != null) reqstats.setProv(r, 'promptMs', P.EXACT);
        if (r.genTps != null) reqstats.setProv(r, 'genTps', P.DERIVED);
        if (r.promptTps != null) reqstats.setProv(r, 'promptTps', P.DERIVED);
        if (r.durationMs != null) reqstats.setProv(r, 'durationMs', P.DERIVED);
        if (r.cachedTokens != null) reqstats.setProv(r, 'cachedTokens', P.EXACT);
      } else {
        if (r.genTps != null) reqstats.setProv(r, 'genTps', P.ESTIMATED);
        if (r.firstTokenMs != null) reqstats.setProv(r, 'firstTokenMs', P.ESTIMATED);
        if (r.durationMs != null) reqstats.setProv(r, 'durationMs', P.ESTIMATED);
      }
      if (r.outputEstimated) reqstats.setProv(r, 'outputTokens', P.ESTIMATED);
      if (r.firstTokenDerived) reqstats.setProv(r, 'firstTokenMs', P.SUBSTITUTE);
    }
    ['exact', 'genExact', 'outputEstimated', 'firstTokenDerived'].forEach(k => { delete r[k]; });
    return r;
  },
  onError: function (msg) { lastError = msg; }
});
const requests = store.rows();   // saved finished requests, oldest first — mutated in place by the store
let nextKey = 1;

function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function baseName(p) { return p ? String(p).split(/[\\/]/).pop() : null; }

// GET base+path -> cb(err, json, headers)
function getJson(b, path, timeout, cb) {
  let u;
  try { u = new URL(b + path); } catch (e) { return cb(e); }
  const headers = { accept: 'application/json' };   // a --api-key server gets the Bearer token when one is set
  if (apiKey) headers.authorization = 'Bearer ' + apiKey;
  const req = http.get({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, timeout: timeout,
                         headers: headers }, function (res) {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', function (d) { if (body.length < 4000000) body += d; });
    res.on('end', function () {
      if (res.statusCode !== 200) { const e = new Error('HTTP ' + res.statusCode); e.status = res.statusCode; return cb(e, null, res.headers); }
      try { cb(null, JSON.parse(body), res.headers); } catch (e) { cb(new Error('not JSON'), null, res.headers); }
    });
  });
  req.on('timeout', function () { req.destroy(new Error('timeout')); });
  req.on('error', function (e) { cb(e); });
}
// A llama.cpp server: its Server header, or a /props answer with llama.cpp's fields.
function isLlama(d, headers) {
  return /llama\.cpp/i.test(String(headers && headers.server || '')) ||
    !!(d && (d.build_info || d.default_generation_settings) && ('total_slots' in d || d.role === 'router'));
}
// Run fn over the items one after another, then done().
function series(items, fn, done) {
  let i = 0;
  (function next() { if (i >= items.length) return done(); fn(items[i++], next); })();
}
// procstats key for a model's own process (router mode)
function procKey(id) { return 'llamacpp-' + String(id).replace(/[^\w.-]/g, '_').slice(0, 80); }

// ---------- saved requests (the store does the read, parse, sort, trim, append, cap) ----------
function loadRequests() { store.load(); }
function saveRequest(r) { store.append(r); }
// ---------- requests from the slot looks ----------
function slotNums(s) {
  const nt = Array.isArray(s.next_token) ? s.next_token[0] || {} : s.next_token || {};
  // n_prompt_tokens counts every token in the slot: while generating that is prompt + output so far.
  const total = num(s.n_prompt_tokens), dec = s.is_processing ? num(nt.n_decoded) : null;
  return { task: num(s.id_task), total: total, prompt: total != null ? total - (dec || 0) : null, processed: num(s.n_prompt_tokens_processed),
           cached: num(s.n_prompt_tokens_cache), decoded: num(nt.n_decoded), remain: num(nt.n_remain), nCtx: num(s.n_ctx) };
}
// Finish a tracked request (idleAt = when the slot was first seen idle). `after` = the slot's numbers once idle (same
// task): its token count then holds prompt + the whole output, which also covers tokens made after our last look.
function finish(rec, idleAt, after) {
  let out = rec.maxDecoded || 0, outEst = false;
  // (the last token made is never fed back, so the slot holds prompt + output - 1: seen 308 for 9 + 300, 55 for 16 + 40)
  if (after && after.task === rec.task && after.total != null && rec.prompt != null && after.total - rec.prompt + 1 > out) {
    out = after.total - rec.prompt + 1; outEst = true;
  }
  const s = rec.samples.filter(function (x) { return x.decoded > 0; });
  let genTps = null;
  if (s.length >= 2) {
    const a = s[0], b = s[s.length - 1];
    if (b.t > a.t && b.decoded > a.decoded) genTps = (b.decoded - a.decoded) / ((b.t - a.t) / 1000);
  }
  // First token: between the last look still reading the prompt and the first one generating; without such a look,
  // back from the first generating look at the measured speed.
  let firstAt = null;
  if (s.length) {
    const z = rec.samples.filter(function (x) { return x.decoded === 0 && x.t < s[0].t; }).pop();
    firstAt = z ? (z.t + s[0].t) / 2 : genTps ? s[0].t - (s[0].decoded - 1) / genTps * 1000 : s[0].t;
    firstAt = Math.max(firstAt, rec.start);
  }
  // End: the last look plus the remaining tokens at the measured speed, kept between the last busy and first idle look.
  let end = (rec.lastAt + idleAt) / 2;
  if (genTps && s.length && out > s[s.length - 1].decoded) end = s[s.length - 1].t + (out - s[s.length - 1].decoded) / genTps * 1000;
  end = Math.min(Math.max(end, rec.lastAt), idleAt);
  const row = {
    key: Date.now().toString(36) + '-' + (nextKey++), slot: rec.slot, task: rec.task, model: rec.model,
    start: Math.round(rec.start), end: Math.round(end), durationMs: Math.round(end - rec.start),
    promptTokens: rec.prompt, cachedTokens: rec.cached || null, outputTokens: out || null,
    genTps: genTps, firstTokenMs: firstAt != null ? Math.round(firstAt - rec.start) : null,
    // AI_SCOPE-094 slice 4: these rows are reconstructed from ½ s (¼ s busy) looks at the slot
    // counters, so the speed, the end, the duration and the first token are ESTIMATED, not measured.
    // The token counts come straight off the slot, so they stay exact. settlePeriod() below promotes
    // a row to exact when the server's /metrics counters show it ran alone.
  };
  const P = reqstats.PROV;
  if (outEst) reqstats.setProv(row, 'outputTokens', P.ESTIMATED);
  if (row.genTps != null) reqstats.setProv(row, 'genTps', P.ESTIMATED);
  if (row.firstTokenMs != null) reqstats.setProv(row, 'firstTokenMs', P.ESTIMATED);
  reqstats.setProv(row, 'durationMs', P.ESTIMATED);
  later(row);
  const m = models[rec.model];
  if (m && m.period) m.period.rows.push(row);
  return row;
}
// A request that started and ended between two polls: only its task id moved. The slot's token count is all we know.
function quick(model, slotId, n, prevSeenAt, now) {
  later({ key: Date.now().toString(36) + '-' + (nextKey++), slot: slotId, task: n.task, model: model,
          start: null, end: Math.round((prevSeenAt + now) / 2), durationMs: null, promptTokens: null, cachedTokens: null,
          outputTokens: null, totalTokens: n.total, genTps: null, firstTokenMs: null, quick: true });
}
// Save a few seconds after the end so the 2 s system samples covering it exist (peak load).
function later(row) {
  setTimeout(function () {
    row.peak = row.start != null ? hwstats.peakBetween(row.start, row.end + 2000) : null;
    saveRequest(row);
  }, 3000);
}
function trackSlots(list, now, model) {
  const seen = {};
  list.forEach(function (s) {
    if (!s || s.id == null) return;
    const k = model + '#' + s.id;
    seen[k] = true;
    const n = slotNums(s), prev = slotState[k];
    let rec = prev ? prev.rec : null;
    if (s.is_processing) {
      if (rec && rec.task !== n.task) { finish(rec, now, null); rec = null; }
      if (!rec) {
        rec = { slot: s.id, task: n.task, model: model, start: prev && !prev.busy ? (prev.seenAt + now) / 2 : now,
                prompt: n.prompt, cached: n.cached, maxDecoded: 0, samples: [] };
        const mm = models[model];
        if (mm && mm.period) mm.period.count++;
      }
      // A reused slot can still show the previous conversation's count at the first look (seen: 55 for a 16-token
      // prompt), so prompt / cached are taken from the first look that is already generating; until then provisional.
      if (!rec.promptFixed && n.prompt != null) { rec.prompt = n.prompt; if (n.cached != null) rec.cached = n.cached; rec.promptFixed = n.decoded > 0; }
      rec.lastAt = now;
      rec.decoded = n.decoded; rec.processed = n.processed; rec.remain = n.remain; rec.nCtx = n.nCtx;
      if (n.decoded != null) { rec.maxDecoded = Math.max(rec.maxDecoded, n.decoded); rec.samples.push({ t: now, decoded: n.decoded }); }
      if (rec.samples.length > 600) rec.samples.splice(1, rec.samples.length - 600);   // keep the first one (first token time)
    } else {
      if (rec) { finish(rec, now, n); rec = null; }
      else if (prev && prev.task != null && n.task != null && n.task !== prev.task) quick(model, s.id, n, prev.seenAt, now);
    }
    slotState[k] = { busy: !!s.is_processing, task: n.task, seenAt: now, rec: rec, model: model };
  });
  Object.keys(slotState).forEach(function (k) { if (slotState[k].model === model && !seen[k]) delete slotState[k]; });
}
// Lost a model (unloaded, server gone) mid-request: end what was running at the last look. No model = all.
function dropSlots(model) {
  Object.keys(slotState).forEach(function (k) {
    const st = slotState[k];
    if (model != null && st.model !== model) return;
    if (st.rec) finish(st.rec, st.seenAt, null);   // lastAt = seenAt -> ends at the last look
    delete slotState[k];
  });
}

// ---------- token-performance rings (AI_SCOPE-101: the llamacpp.tps / llamacpp.ctx lenses) ----------
// The 093 Strata shape: points { t, every, v, m, s } (s = the slot's id), a time-sized 5-minute ring
// (trim by time keeping one older sample; the count cap is a safety net only), and the constant 2000
// PACE stamp - a poll that found nothing is a visible N/A hole on the clock board, never a bridged
// guess (072/077; the 093 17:50 revision rule). llama.cpp is looked at every 500 ms (250 ms busy) for
// the request tracker, so the RINGS are wall-throttled to ~one push per 2 s per model: the fast look
// keeps feeding finish(), the board ticks at the family's pace.
// windowGenTps() is factored out of the current-row builder so the card and the ring compute the same
// number from the same samples - the rule 093 slice 3 set for Strata's ctx.
const PERF_WIN = 300000, PERF_CAP = 400, PERF_PUSH_MS = 1750;
let tpsHist = [], ctxHist = [];
const perfLast = {};   // model id -> wall time of its last ring push
function windowGenTps(samples) {
  const n = samples.length;
  // speed over the last few looks (about 2.5 s), so one slow look doesn't jump it around
  for (let i = n - 2; i >= 0; i--) {
    if (samples[n - 1].t - samples[i].t >= 2500 || i === 0) {
      if (samples[n - 1].t > samples[i].t && samples[n - 1].decoded > samples[i].decoded && samples[i].decoded > 0)
        return (samples[n - 1].decoded - samples[i].decoded) / ((samples[n - 1].t - samples[i].t) / 1000);
      break;
    }
  }
  return null;
}
function trimPerf(a) {
  const last = a[a.length - 1].t;
  while (a.length > 1 && a[1].t < last - PERF_WIN) a.shift();
  if (a.length > PERF_CAP) a.splice(0, a.length - PERF_CAP);
}
function samplePerf(modelId, now) {
  const last = perfLast[modelId] || 0;
  if (now - last < PERF_PUSH_MS) return;
  Object.keys(slotState).forEach(function (k) {
    const st = slotState[k];
    if (st.model !== modelId || !st.rec) return;
    const rec = st.rec, g = windowGenTps(rec.samples);
    if (g != null) tpsHist.push({ t: now, every: 2000, v: g, m: modelId, s: rec.slot });
    // the same contextUsed the current row reports (prompt + generated so far) - one formula, both faces
    const used = rec.prompt != null ? rec.prompt + (rec.decoded || 0) : null;
    if (used != null) ctxHist.push({ t: now, every: 2000, v: used, m: modelId, s: rec.slot });
  });
  if (tpsHist.length > 1) trimPerf(tpsHist);
  if (ctxHist.length > 1) trimPerf(ctxHist);
  perfLast[modelId] = now;
}

// ---------- logo ----------
// llama.cpp has no install folder to read a logo from, so take the icon of the server's own web UI (favicon.svg,
// a near-black mark). Its web UI files are only served gzip-compressed (415 without Accept-Encoding: gzip).
// For dark backgrounds the same mark with the near-black fill made light. Fallback copies: assets/logos/llamacpp-*.svg.
let logo = { tried: 0, light: null, dark: null };
function fetchLogo() {
  if (!base) return;
  logo.tried = Date.now();
  let u;
  try { u = new URL(base + '/favicon.svg'); } catch (e) { return; }
  http.get({ hostname: u.hostname, port: u.port || 80, path: u.pathname, timeout: 3000, headers: { 'accept-encoding': 'gzip' } }, function (res) {
    const parts = [];
    let size = 0;
    res.on('data', function (d) { size += d.length; if (size < 200000) parts.push(d); });
    res.on('end', function () {
      if (res.statusCode !== 200) return;
      let buf = Buffer.concat(parts);
      try { if (/gzip/i.test(String(res.headers['content-encoding'] || ''))) buf = zlib.gunzipSync(buf); } catch (e) { return; }
      const svg = buf.toString('utf8');
      if (!/<svg[\s>]/.test(svg)) return;
      logo.light = svg;
      logo.dark = svg.replace(/#111111\b/gi, '#E8E8E8').replace(/#111\b/gi, '#E8E8E8').replace(/#000000\b/gi, '#E8E8E8').replace(/#000\b/gi, '#E8E8E8');
    });
  }).on('error', function () {}).on('timeout', function () { this.destroy(); });
}
function getLogo(theme) { return theme === 'dark' ? (logo.dark || logo.light) : (logo.light || logo.dark); }

// ---------- polling ----------
// A server started with --api-key answers 401 without the key; llama.cpp's Server header still tells it apart.
function needsKey(err, h) { return !!err && err.status === 401 && /llama\.cpp/i.test(String(h && h.server || '')); }
const KEY_MSG = 'This llama.cpp server needs an API key (started with --api-key). Put it in this scope\'s "API key" setting, or start the server without --api-key.';
function detect(list, i, cb, locked) {
  if (i >= list.length) return cb(null, null, locked);
  getJson(list[i], '/props', 1500, function (err, d, h) {
    if (!err && isLlama(d, h)) return cb(list[i], d);
    detect(list, i + 1, cb, locked || (needsKey(err, h) ? list[i] : null));
  });
}
function goOnline(b, d) {
  keyNeeded = null;
  const wasOn = online && base === b;
  base = b; online = true; lastError = null;
  if (d) setRootProps(d);
  if (!wasOn) {
    let host = '';
    try { host = new URL(b).hostname; } catch (e) { /* ignore */ }
    local = /^(127\.|localhost$|\[?::1\]?$)/.test(host);
    // the server's process (+ in router mode every model's child process): the process row / AI processes total
    if (local) procstats.watch('llamacpp', [+new URL(b).port || 80], MODEL_PROCS); else procstats.unwatch('llamacpp');
    if ((!logo.light || !logo.dark) && Date.now() - logo.tried > 60000) fetchLogo();
  }
}
function forgetModels() {
  order.forEach(function (id) { procstats.unwatch(procKey(id)); });
  models = {}; order = []; modelsAt = 0;
}
function goOffline(msg, lockedAt) {
  keyNeeded = lockedAt || null;
  if (online) dropSlots();
  online = false; rootProps = null; rootPropsAt = 0; router = null;
  forgetModels();
  lastError = msg;
  procstats.unwatch('llamacpp');
  if (!configured) base = null;   // auto-detect again next time
}
function setRootProps(d) {
  rootProps = d; rootPropsAt = Date.now();
  const wasRouter = !!router;
  router = d.role === 'router' ? { maxInstances: num(d.max_instances), autoload: d.models_autoload !== false } : null;
  if (wasRouter !== !!router) { dropSlots(); forgetModels(); }   // mode changed (server restarted the other way)
  if (!router) {
    // single model: one entry, named by its alias (else the file name), read at the server's own address
    const id = d.model_alias && d.model_alias !== d.model_path ? d.model_alias : baseName(d.model_path) || 'model';
    if (order[0] !== id) {
      if (order.length) { dropSlots(); forgetModels(); }
      models[id] = { id: id, state: 'loaded', path: d.model_path || null, port: null, meta: null, props: d, propsAt: Date.now() };
      order = [id];
      getJson(base, '/v1/models', 3000, function (err, x) {
        const m = !err && x && Array.isArray(x.data) && x.data[0] ? x.data[0] : null;
        if (m && models[id]) models[id].meta = m.meta || null;
      });
    } else { models[id].props = d; models[id].propsAt = Date.now(); models[id].path = d.model_path || null; }
  }
}
// Router: the folder's models and which are loaded (and on which port).
function readRouterModels(cb) {
  getJson(base, '/models', 3000, function (err, d) {
    if (err || !d || !Array.isArray(d.data)) return cb(err || new Error('bad /models answer'));
    const seen = {};
    const ids = [];
    d.data.forEach(function (m) {
      if (!m || !m.id) return;
      const st = m.status || {}, args = Array.isArray(st.args) ? st.args : [];
      let port = null, path = null;
      for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === '--port') port = +args[i + 1] || null;
        if (args[i] === '--model' || args[i] === '-m') path = args[i + 1];
      }
      const state = String((typeof m.status === 'string' ? m.status : st.value) || 'unknown');
      const old = models[m.id];
      const e = old || { id: m.id };
      // unloaded models come without meta: keep what a load showed earlier (this session)
      e.state = state; e.path = path || e.path || null; e.meta = m.meta || e.meta || null;
      e.contextLength = num(m.context_length);
      e.inputs = m.architecture && Array.isArray(m.architecture.input_modalities) ? m.architecture.input_modalities : null;
      e.port = state === 'loaded' && port ? port : null;
      if (state !== 'loaded' && old && old.state === 'loaded') { dropSlots(m.id); e.props = null; e.slots = null; }
      if (local && e.port) procstats.watch(procKey(m.id), [e.port], MODEL_PROCS); else procstats.unwatch(procKey(m.id));
      models[m.id] = e; seen[m.id] = true; ids.push(m.id);
    });
    order.forEach(function (id) { if (!seen[id]) { dropSlots(id); procstats.unwatch(procKey(id)); delete models[id]; } });
    order = ids; modelsAt = Date.now();
    cb(null);
  });
}
// Where to ask a model: its child's own port (router on this PC), the router with ?model= (router elsewhere), or the
// server itself (single model).
function modelUrl(m, path) {
  if (!router) return { b: base, p: path };
  if (local && m.port) return { b: 'http://127.0.0.1:' + m.port, p: path };
  return { b: base, p: path + '?model=' + encodeURIComponent(m.id) };
}
function readModel(m, now, cb) {
  if (m.state !== 'loaded' || (router && local && !m.port)) return cb();
  // metrics: a busy period starts with a snapshot (still before its first request ends: the counters only move at the
  // end) and ends with one; in between every look (for the queue); while idle every 5 s (totals)
  const afterSlots = function () {
    const p = m.props || (!router ? rootProps : null);
    if (m.metricsOn == null && p) m.metricsOn = p.endpoint_metrics === true;
    if (!m.metricsOn) { m.period = null; return cb(); }
    const busyNow = (m.slots || []).some(function (s) { return s && s.is_processing; });
    if (busyNow && !m.period) {
      const period = m.period = { base: null, count: Object.keys(slotState).filter(function (k) { return slotState[k].model === m.id && slotState[k].rec; }).length, rows: [] };
      return readMetrics(m, function (x) { period.base = x; cb(); });
    }
    if (!busyNow && m.period) {
      const period = m.period; m.period = null;
      return readMetrics(m, function (x) { settlePeriod(m, period.base, x, period); cb(); });
    }
    if (busyNow || Date.now() - (m.metAt || 0) >= METRICS_IDLE_MS) return readMetrics(m, function () { cb(); });
    cb();
  };
  const slots = function () {
    const u = modelUrl(m, '/slots');
    getJson(u.b, u.p, 2000, function (err, d, h) {
      if (needsKey(err, h)) return cb(KEY_MSG);
      if (err && (err.status === 501 || err.status === 404)) { m.slotsEnabled = false; m.slots = []; dropSlots(m.id); return cb(); }
      if (err || !Array.isArray(d)) {
        if (!router) return cb('llama.cpp server not answering at ' + base + (err ? ' (' + err.message + ')' : ''));
        dropSlots(m.id); m.slots = null; return cb();   // a model going away: /models will say so next look
      }
      m.slotsEnabled = true; m.slots = d;
      const tnow = Date.now();
      trackSlots(d, tnow, m.id);
      samplePerf(m.id, tnow);   // AI_SCOPE-101: the ~2 s wall-throttled feed of the tps / ctx display rings
      afterSlots();
    });
  };
  if (!router || now - (m.propsAt || 0) < PROPS_MS) return slots();
  const u = modelUrl(m, '/props');
  getJson(u.b, u.p, 2000, function (err, d) {
    if (!err && d) { m.props = d; m.propsAt = now; }
    slots();
  });
}
// ---------- /metrics (--metrics) ----------
const METRICS_IDLE_MS = 5000;   // totals while idle; every look while a slot is busy (queue)
function getText(b, path, timeout, cb) {
  let u;
  try { u = new URL(b + path); } catch (e) { return cb(e); }
  const req = http.get({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, timeout: timeout,   // /metrics also carries the key
                         headers: apiKey ? { authorization: 'Bearer ' + apiKey } : {} }, function (res) {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', function (d) { if (body.length < 200000) body += d; });
    res.on('end', function () { if (res.statusCode !== 200) { const e = new Error('HTTP ' + res.statusCode); e.status = res.statusCode; return cb(e); } cb(null, body); });
  });
  req.on('timeout', function () { req.destroy(new Error('timeout')); });
  req.on('error', function (e) { cb(e); });
}
// Prometheus text -> { promptTokens, promptSec, cached, predTokens, predSec, processing, deferred, at }
function parseMetrics(text) {
  const v = {};
  String(text).split(/\r?\n/).forEach(function (l) {
    const m = /^llamacpp:(\w+)(?:\{[^}]*\})?\s+([-+0-9.eE]+|NaN)/.exec(l);
    if (m) v[m[1]] = parseFloat(m[2]);
  });
  if (!('tokens_predicted_total' in v)) return null;
  return { promptTokens: v.prompt_tokens_total, promptSec: v.prompt_seconds_total, cached: v.prompt_tokens_cached_total,
           predTokens: v.tokens_predicted_total, predSec: v.tokens_predicted_seconds_total,
           processing: num(v.requests_processing), deferred: num(v.requests_deferred), at: Date.now() };
}
function readMetrics(m, cb) {
  const u = modelUrl(m, '/metrics');
  getText(u.b, u.p, 2000, function (err, text) {
    const x = !err ? parseMetrics(text) : null;
    if (x) { m.met = x; m.metAt = x.at; }
    else if (err && (err.status === 501 || err.status === 404)) m.metricsOn = false;
    cb(x);
  });
}
// A busy period of a model ended (no slot busy): if exactly one request ran in it, its numbers are the counters'
// change - exact. The row is still waiting to be saved (later()), so it's corrected in place.
function settlePeriod(m, base, after, period) {
  if (!base || !after || period.count !== 1 || period.rows.length !== 1) return;
  const r = period.rows[0];
  const dp = after.predTokens - base.predTokens, ds = after.predSec - base.predSec;
  const pp = after.promptTokens - base.promptTokens, ps = after.promptSec - base.promptSec;
  const dc = after.cached - base.cached;
  if (!(dp > 0 && ds > 0) || (r.outputTokens && Math.abs(dp - r.outputTokens) > 2)) return;   // not this request's numbers
  // generation: the counters measured it, so the counts and the two durations are exact.
  const P = reqstats.PROV;
  r.outputTokens = dp; reqstats.setProv(r, 'outputTokens', P.EXACT);
  r.genTps = (dp > 1 ? dp - 1 : dp) / ds; r.genMs = Math.round(ds * 1000);
  reqstats.setProv(r, 'genMs', P.EXACT);
  reqstats.setProv(r, 'genTps', P.DERIVED);      // one step of arithmetic on two measured counters
  // prompt: only when the counters show its work (seen 0 for a request that was already running when AI_SCOPE
  // restarted) - else the first-token / duration estimates stay
  if (!(pp > 0 && ps > 0) && !(dc > 0)) return;
  if (pp > 0 && ps > 0) { r.promptTps = pp / ps; reqstats.setProv(r, 'promptTps', P.DERIVED); }
  r.promptMs = Math.round(ps * 1000); reqstats.setProv(r, 'promptMs', P.EXACT);
  if (dc >= 0) { r.cachedTokens = dc || null; reqstats.setProv(r, 'cachedTokens', P.EXACT); }
  // llama's metrics give the prefill duration, never a first-token time: the column is answered by a
  // SUBSTITUTE, which is exactly why it carries a marker (the same convention Bionic's log forces).
  r.firstTokenMs = r.promptMs; reqstats.setProv(r, 'firstTokenMs', P.SUBSTITUTE);
  r.durationMs = Math.round((ps + ds) * 1000); reqstats.setProv(r, 'durationMs', P.DERIVED);
  r.start = r.end - r.durationMs;
}
function anyBusy() { return Object.keys(slotState).some(function (k) { return slotState[k].busy; }); }
function schedule() {
  if (!running) return;
  timer = setTimeout(poll, anyBusy() ? POLL_BUSY_MS : POLL_MS);
}
function poll() {
  if (busy) return;
  busy = true;
  timer = null;
  const done = function () { busy = false; procstats.attest('llamacpp', mirrorState()); schedule(); };   // AI_SCOPE-082: attest each cycle
  if (!base) {
    const list = configured ? [configured] : CANDIDATES;
    return detect(list, 0, function (b, d, locked) {
      if (b) goOnline(b, d);
      else if (locked) goOffline(KEY_MSG, locked);
      else goOffline(configured ? 'No llama.cpp server at ' + configured : 'No llama.cpp server found at 127.0.0.1:9931 or :8080');
      done();
    });
  }
  const now = Date.now();
  const fail = function (msg) { goOffline(msg); done(); };
  const readAll = function () {
    series(order.map(function (id) { return models[id]; }), function (m, next) {
      if (!m) return next();
      readModel(m, now, function (errMsg) {
        if (errMsg) { if (errMsg === KEY_MSG) goOffline(KEY_MSG, base); else goOffline(errMsg); return done(); }
        next();
      });
    }, done);
  };
  const afterProps = function () {
    if (!router) return readAll();
    // a router on another PC: look at /models every time (only ask models it calls loaded right now); here every 2 s
    if (local && now - modelsAt < 2000) return readAll();
    readRouterModels(function (err) {
      if (err) return fail('llama.cpp router not answering at ' + base + ' (' + err.message + ')');
      readAll();
    });
  };
  if (online && now - rootPropsAt < PROPS_MS) return afterProps();
  getJson(base, '/props', 2000, function (err, d, h) {
    if (needsKey(err, h)) { goOffline(KEY_MSG, base); return done(); }
    if (err || !isLlama(d, h)) return fail('llama.cpp server not answering at ' + base + (err ? ' (' + err.message + ')' : ''));
    if (!online) goOnline(base, d); else setRootProps(d);
    afterProps();
  });
}

// ---------- Hardware Mirror Lens attestation (AI_SCOPE-082; family rules: ~/ai-scope-terminology.md) ----------
// Kickoff decision 2A: three states, each read straight from llama.cpp's own answers - nothing invented.
//  live - reachable and a model is loaded (router: /models calls one loaded; single: /props names a model and it
//         is not sleeping). procstats' real samples are then the only writer of the history; a missed process
//         lookup stays a gap + n/a, never a false zero.
//  idle - reachable, nothing loaded. In router mode the router's own process stays alive (44 MB on snow), but the
//         mirror counts the model-holding family, so zeros are honest, "No Model Loaded" is the wording (077),
//         and 084's arming gate releases the shared 2 s demand for an idle app (the cost 091 raised).
//         A single-model server started with --sleep-after-idle is idle too: the model is out of memory even
//         though the process lives (is_sleeping, already read for the model row at modelInfo()).
//  off  - unreachable (goOffline): zeros, sub "llama.cpp Offline".
// 'loading' is deliberately NOT attested: llama.cpp has no status AI_SCOPE can read that says a load is running
// without asking a router about an unloaded model - which LOADS it (006's gotcha). 'unloading' / 'failed' are
// recorded as absent from llama.cpp's API rather than invented (the 081 precedent for states the API lacks).
// Kickoff 2B stays open as a test: if a router's /models is ever seen to carry a loading status string, that is
// the honest moment to attest it - the router on snow has an empty models folder, so no load can be observed.
function mirrorState() {
  if (!online) return 'off';
  if (router) return order.some(function (id) { return models[id] && models[id].state === 'loaded'; }) ? 'live' : 'idle';
  const m = models[order[0]];
  return m && m.state === 'loaded' && !(m.props && m.props.is_sleeping) ? 'live' : 'idle';
}

// ---------- state for the page ----------
// Size on disk of a model file (router models that aren't loaded have no meta), read once per path.
const fileSizes = {};
function fileSize(p) {
  if (!p || !local) return null;
  if (!(p in fileSizes)) { try { fileSizes[p] = fs.statSync(p).size; } catch (e) { fileSizes[p] = null; } }
  return fileSizes[p];
}
// AI_SCOPE-098 review: resolve an UNLOADED router model to its file under the configured
// --models-dir folder (the scope's 'Models folder' setting; local servers only). The router's
// /models id IS the file stem relative to that folder. Exact stems win; a unique prefix match
// covers quant-tagged files ("qwen2.5-coder-3b" -> Q4_K_M / Q8_0 siblings - each gets its own
// file, never the same one twice); an ambiguous prefix is left as a gap, never guessed.
// Split GGUFs (…-00001-of-00002) live in a subfolder named after the stem, like Hugging Face.
function resolveModelFile(id) {
  if (!modelsDir || !local || !id) return null;
  const ck = modelsDir + '|' + id;
  if (ck in fileResCache) return fileResCache[ck] || null;
  let found = null;
  try {
    const key = String(id).split(':')[0];          // "repo/name:quant" -> the quant is the file's own tag
    const stem = key.toLowerCase().replace(/[\\/]/g, '\u0000');   // an HF-style id nests folders
    const direct = pathIsFile(path.join(modelsDir, key)) ? path.join(modelsDir, key) : null;
    if (direct) found = direct;
    if (!found) {
      const q = String(id).split(':')[1];
      const nest = path.join(modelsDir, key.replace(/[\\/]/g, path.sep));
      if (q && dirExists(nest)) found = pickSplitOrTagged(nest, q);
    }
    if (!found) found = scanStem(modelsDir, stem, id);
  } catch (e) { found = null; }
  fileResCache[ck] = found || '';
  return found;
}
// The Installed lens can set the folder per poll (AI_SCOPE-098); the lens value overrides the
// scope card's, and an empty poll param means no lens is asking, so the scope setting stands.
function setModelsDir(v) {
  const d = String(v || '').trim() || null;
  modelsDir = d || scopeModelsDir;             // recomputed every call: the scope card may have changed since the last lens param (the bug this line guards)
  if (d === lensModelsDir) return;
  lensModelsDir = d;
  fileResCache = {};
}
function pathIsFile(p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }
function dirExists(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }
function pickSplitOrTagged(dir, quant) {
  let files = [];
  try { files = fs.readdirSync(dir); } catch (e) { return null; }
  const first = files.filter(function (f) { return /-00001-of-\d+\.gguf$/i.test(f); })[0];
  if (first) return path.join(dir, first);
  const tagged = files.filter(function (f) { return /\.gguf$/i.test(f) && new RegExp('[-_.]' + quant.replace(/[^A-Za-z0-9_]/g, '') + '(?:[-_.]|$)', 'i').test(f); });
  return tagged.length === 1 ? path.join(dir, tagged[0]) : null;
}
function scanStem(dir, stem, id) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  const ggufs = names.filter(function (f) { return /\.gguf$/i.test(f); });
  const exact = ggufs.filter(function (f) { return baseName(f).toLowerCase().replace(/\.gguf$/i, '') === stem; });
  if (exact.length === 1) return path.join(dir, exact[0]);
  if (exact.length > 1) return null;                        // several exact stems: no guessing
  const pref = ggufs.filter(function (f) { return baseName(f).toLowerCase().replace(/\.gguf$/i, '').indexOf(stem) === 0; });
  if (pref.length === 1) return path.join(dir, pref[0]);
  if (pref.length > 1) {                                    // quant-tagged siblings: one per quant, never shared
    const q = String(id).split(':')[1];
    const t = q ? pref.filter(function (f) { return new RegExp('[-_.]' + q.replace(/[^A-Za-z0-9_]/g, '') + '(?:[-_.]|$)', 'i').test(baseName(f)); }) : [];
    if (t.length === 1) return path.join(dir, t[0]);
  }
  return null;
}
// From a GGUF file name / model id: quantization ("Q4_K_M", "IQ3_XXS", "BF16") and parameter count ("35B", "26B")
// Quant tags are their own tokens (UD-?I?Q<digits> with _suffixes, or BF16/F16/F32); the LAST one
// in the name is the file's own quant. This fixes a live-test catch: the old bounded-prefix version
// stopped at "_K" boundaries, so the compound tag Q8_0 / Q4_K_M came out truncated ("Q8").
// Family tokens like "0.6B" never match the pattern, so they cannot confuse it.
function quantFromName(s) {
  const all = String(baseName(s) || '').match(/(?:UD-)?I?Q\d+(?:_[A-Za-z0-9]+)*|BF16|F16|F32/gi);
  return all ? all[all.length - 1].toUpperCase() : null;
}
function paramsFromName(s) { const m = /(?:^|[-_.])(\d+(?:\.\d+)?)B(?=[-_.]|$)/i.exec(String(s || '')); return m ? +m[1] * 1e9 : null; }
// split a huggingface.co repo_url from a GGUF header into { org, repo } (null if it is not HF)
function hfRepo(hm) {
  const u = hm && hm.repoUrl ? String(hm.repoUrl).trim().split(/\s+/)[0] : null;
  const m = /^https?:\/\/huggingface\.co\/([^/\s]+)(?:\/([^/\s]+))?/i.exec(u || '');
  if (!m) return null;
  return { org: decodeURIComponent(m[1]), repo: m[2] ? decodeURIComponent(m[2]) : null };
}
function modelInfo(m) {
  const p = m.props || {}, dgs = p.default_generation_settings || {}, meta = m.meta || {};
  // 098 review: an unloaded router model has no path from /models; resolve it from the scope's
  // 'Models folder' setting so Size / Fit / header provenance stop being gaps (local servers only).
  const path = m.path || p.model_path || resolveModelFile(m.id);
  // AI_SCOPE-098 review: the GGUF's own header names its HF repo when /models did not
  // (an unloaded model with a local path - same local-file rule as fileSize() above).
  // The header's size_label is deliberately NOT rendered as Params: it is the packager's
  // family-wide label (the user's point at review), not this variant's count.
  let hfile = path;
  const sm = path ? /(-0000)(\d)(-of-\d+\.gguf)$/i.exec(path) : null;   // metadata lives in shard 1
  if (sm && sm[2] !== '1') hfile = path.slice(0, sm.index + 6) + '1' + path.slice(sm.index + 7);
  const hm = local && hfile ? ggufmeta.header(hfile) : null;
  return {
    id: m.id, name: m.id, state: m.state, path: path,
    // an unloaded router model's id IS its file stem ("Qwen2.5-Coder-3B-Q4_K_M"), so the quant
    // reads from the id when the path is unknown; loaded models answer with props / meta.
    ftype: p.model_ftype || meta.ftype || quantFromName(m.id) || quantFromName(path), size: num(meta.size) || fileSize(path),
    params: num(meta.n_params), paramsGuess: num(meta.n_params) ? null : paramsFromName(m.id) || paramsFromName(baseName(path)),
    context: num(dgs.n_ctx) || m.contextLength || null, ctxTrain: num(meta.n_ctx_train) || m.contextLength || null,
    slots: num(p.total_slots), sleeping: !!p.is_sleeping, port: m.port || null,
    // what it takes besides text: image / video / audio (router: /models; single: /props modalities)
    inputs: (m.inputs || (p.modalities ? Object.keys(p.modalities).filter(function (k) { return p.modalities[k]; }).map(function (k) { return k === 'vision' ? 'image' : k; }) : []))
      .filter(function (x) { return x !== 'text'; }),
    // AI_SCOPE-098 (D3): the model id is normally an HF repo path ("Qwen/Qwen3-0.6B-GGUF"), so the
    // publisher falls out of it; when the id is a plain local name, the GGUF header's repo_url
    // names it instead. Neither: an honest gap.
    publisher: (function () {
      const s = String(m.id || '').split(':')[0].split('/');   // the ":quant" tag is not part of the HF repo name (live-test catch)
      if (s.length > 1) return s[0];
      const r = hfRepo(hm);
      return r ? r.org : null;
    })(),
    publisherUrl: (function () {
      const s = String(m.id || '').split(':')[0].split('/');   // the ":quant" tag is not part of the HF repo name (live-test catch)
      if (s.length > 1) return 'https://huggingface.co/' + s[0];
      const r = hfRepo(hm);
      return r ? 'https://huggingface.co/' + r.org : null;
    })(),
    modelUrl: (function () {
      const s = String(m.id || '').split(':')[0].split('/');   // the ":quant" tag is not part of the HF repo name (live-test catch)
      if (s.length > 1) return 'https://huggingface.co/' + s.join('/');
      const r = hfRepo(hm);
      return r && r.repo ? 'https://huggingface.co/' + r.org + '/' + r.repo : null;
    })(),
    process: router ? procstats.get(procKey(m.id)) : procstats.get('llamacpp'),
    metrics: m.metricsOn && m.met ? { promptTokens: m.met.promptTokens, cached: m.met.cached, predTokens: m.met.predTokens,
      genTps: m.met.predSec > 0 ? m.met.predTokens / m.met.predSec : null, promptTps: m.met.promptSec > 0 ? m.met.promptTokens / m.met.promptSec : null,
      processing: m.met.processing, deferred: m.met.deferred } : null,
    metricsOn: m.metricsOn === true,
  };
}
// AI_SCOPE-082: since (AI_SCOPE-084 item 7) sends only processHistory points newer than it - the mirror lenses keep
// the ring on the client (web/js/mirror.js appends what arrives), so the 5-minute ring never rides the whole payload.
// The two family fields sit in the object BEFORE the offline return: an uninstalled or unreachable server still has
// to deliver the attested 'off' zeros (ollamastats.js / stratastats.js are the pattern; 077's review batch rule).
// AI_SCOPE-098 (D2): the fit verdict for the Installed models lens. llama.cpp puts one model on
// one card (router mode spawns an instance per model), so canSplit=false: never "fits across N GPUs".
function withFit(x) {
  if (x) { const f = hwstats.vramFit(x.size, hwstats.vramInfo(), false); x.fit = f ? f.fit : null; }
  return x;
}
function getState(limit, since) {
  const out = { online: online, url: base || keyNeeded || configured || null, error: lastError, needsKey: !!keyNeeded,
                router: router, build: rootProps && rootProps.build_info || null, slotsEnabled: null,
                model: null, models: [], slots: [], current: [], average: null, contextStates: [],
                totalRequests: requests.length, rows: requests.slice(-(limit || 100)).reverse(),
                process: procstats.get('llamacpp'), processSupported: procstats.supported(),
                // the Hardware Mirror Lens family: the 5-minute per-process ring and the Hardware card names / totals
                processHistory: procstats.history('llamacpp', since || 0),
                // AI_SCOPE-101: the token-performance rings ride every answer, offline included (082/093 rule)
                tpsHistory: tpsHist, contextHistory: ctxHist,
                processCards: hwstats.getStats().info.gpus.map(function (g) { return { name: g.name, vramTotal: g.vramTotal, source: g.source }; }) };
  if (!online) return out;
  // loaded models first, then the rest in the server's order
  const list = order.map(function (id) { return models[id]; }).filter(Boolean);
  out.models = list.filter(function (m) { return m.state === 'loaded'; }).concat(list.filter(function (m) { return m.state !== 'loaded'; })).map(modelInfo).map(withFit);
  out.model = out.models.filter(function (m) { return m.state === 'loaded'; })[0] || null;
  const loaded = list.filter(function (m) { return m.state === 'loaded' && m.slots; });
  out.slotsEnabled = loaded.length ? loaded.some(function (m) { return m.slotsEnabled !== false; }) : null;
  const now = Date.now();
  loaded.forEach(function (m) {
    const sleeping = m.props && m.props.is_sleeping;   // 101: a sleeping model's held fill is void - the claim goes
    (m.slots || []).forEach(function (s) {
      const n = slotNums(s), st = slotState[m.id + '#' + s.id], rec = st && st.rec;
      out.slots.push({ model: m.id, id: s.id, busy: !!s.is_processing, task: n.task, nCtx: n.nCtx, promptTokens: n.prompt, cached: n.cached,
                       decoded: s.is_processing ? n.decoded : null, used: n.total, since: rec ? Math.round(rec.start) : null });
      // AI_SCOPE-101 (D3): per-slot fill state for the Context lens - live while processing, held while idle,
      // the whole slot token count straight off the app (n_prompt_tokens counts prompt + output so far).
      if (!sleeping && n.total != null)
        out.contextStates.push({ slot: s.id, model: m.id, used: n.total, max: n.nCtx, live: !!s.is_processing, at: now });
    });
  });
  Object.keys(slotState).forEach(function (k) {
    const rec = slotState[k].rec;
    if (!rec) return;
    const genTps = windowGenTps(rec.samples);   // AI_SCOPE-101: shared with samplePerf - card and ring compute the same number
    const gen = rec.decoded || 0, mi = models[rec.model];
    // AI_SCOPE-100 (D4): canonical live names (cached -> cachedTokens, generated -> outputTokens,
    // tokS -> genTps); the phase words here have been the family's since 082.
    out.current.push({
      model: rec.model, slot: rec.slot, task: rec.task, phase: gen > 0 ? 'generating' : 'reading',
      promptTokens: rec.prompt, cachedTokens: rec.cached, outputTokens: gen,
      maxTokens: rec.remain != null && rec.remain >= 0 ? gen + rec.remain : null,
      genTps: genTps, elapsedMs: now - rec.start,
      contextUsed: rec.prompt != null ? rec.prompt + gen : null,
      contextMax: rec.nCtx || (mi && mi.props && mi.props.default_generation_settings ? num(mi.props.default_generation_settings.n_ctx) : null),
      process: router ? procstats.get(procKey(rec.model)) : null,
      queued: mi && mi.metricsOn && mi.met && Date.now() - mi.met.at < 3000 ? mi.met.deferred || 0 : null,
    });
  });
  out.current.sort(function (a, b) { return a.elapsedMs - b.elapsedMs; });
  // token-weighted average generation speed of the recent requests (the loaded model's, or any in router mode)
  // AI_SCOPE-094 slice 3: the shared builder, with the rate-implied seconds this scope needs
  // (llama.cpp gives per-request speed from the slot counters, never a duration to sum).
  const anyModel = !!(router || !out.model);
  const a = reqstats.avgSpeed(requests, anyModel ? null : out.model.name, { anyModel: anyModel, rateField: 'genTps' });
  if (a) out.average = { model: router ? null : out.model && out.model.name, genTps: a.value, requests: a.requests };
  return out;
}

function start(settings) {
  stop();
  settings = settings || {};
  configured = String(settings.url || '').trim().replace(/\/+$/, '');
  apiKey = String(settings.apiKey || '').trim();   // optional key for a --api-key server
  // AI_SCOPE-098 review: the router's --models-dir folder, set on the scope card when the server
  // runs on this PC. The router never sends a path for UNLOADED models, so folder + file stem is
  // the only way their Size / Fit / header provenance can be honest instead of gaps.
  scopeModelsDir = String(settings.modelsDir || '').trim() || null;
  lensModelsDir = null;
  modelsDir = scopeModelsDir;
  fileResCache = {};
  base = configured || null;
  loadRequests();          // the store ignores a second load (AI_SCOPE-094 slice 1)
  running = true;
  poll();
}
function stop() {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (online) dropSlots();
  forgetModels();
  procstats.unwatch('llamacpp');
  procstats.unattest('llamacpp');   // AI_SCOPE-082: an uninstalled scope stops claiming history (like 081 / strata / bionic)
  online = false; rootProps = null; router = null; lastError = null; base = null;
  scopeModelsDir = null; lensModelsDir = null; modelsDir = null; fileResCache = {};
}

module.exports = { start: start, stop: stop, getState: getState, getLogo: getLogo, setModelsDir: setModelsDir,   // the route passes the lens's ?md= value through this
  // _test exposes the shipped helpers for probes (098); the setters exist because `let` module
  // bindings are not writable from a vm harness script (the 094 peak-attach precedent).
  _test: { trackSlots: trackSlots, isLlama: isLlama, modelInfo: modelInfo, hfRepo: hfRepo, withFit: withFit, resolveModelFile: resolveModelFile, setModelsDir: setModelsDir, effectiveDir: function () { return modelsDir; },
           setLocal: function (v) { local = !!v; },
           clearFileSizes: function () { Object.keys(fileSizes).forEach(function (k) { delete fileSizes[k]; }); } } };
