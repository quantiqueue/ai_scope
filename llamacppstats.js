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
const hwstats = require('./hwstats');
const procstats = require('./procstats');   // process stats: VRAM per card, GPU %, CPU, RAM (Windows)
// `llama serve` runs the model in llama.exe itself; in router mode each model is a child llama.exe. Plain builds:
// llama-server.exe. Watched by port, so Bionic's / Ollama's own llama-server.exe children (other ports) are not mixed in.
const MODEL_PROCS = ['llama.exe', 'llama-server.exe'];
const paths = require('./paths');

const CANDIDATES = ['http://127.0.0.1:9931', 'http://127.0.0.1:8080'];
const REQ_FILE = paths.file('llamacpp-requests.jsonl');
const MAX_IN_MEMORY = 1000;
const POLL_MS = 500;           // all slots idle (a request's start is known to about ± ¼ s)
const POLL_BUSY_MS = 250;      // a slot busy: look more often for better speed / timing estimates
const PROPS_MS = 10000;

let configured = '';        // URL from the settings ('' = auto-detect)
let base = null;            // the server in use
let local = false;          // base is on this PC (model children reachable on 127.0.0.1)
let timer = null, busy = false, running = false;
let online = false, lastError = null;
let keyNeeded = null;       // URL of a llama.cpp server that answered 401 (needs --api-key's key)
let rootProps = null, rootPropsAt = 0;
let router = null;          // router mode: { maxInstances, autoload } (null = single model)
let models = {};            // id -> { id, name, state, path, port, meta, props, propsAt, slots, slotsEnabled }
let order = [];             // model ids in the server's order
let modelsAt = 0;
const slotState = {};       // model id + '#' + slot id -> { busy, task, seenAt, rec, model }
let requests = [];          // saved finished requests, oldest first
let requestsLoaded = false;
let nextKey = 1;

function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function baseName(p) { return p ? String(p).split(/[\\/]/).pop() : null; }

// GET base+path -> cb(err, json, headers)
function getJson(b, path, timeout, cb) {
  let u;
  try { u = new URL(b + path); } catch (e) { return cb(e); }
  const req = http.get({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, timeout: timeout,
                         headers: { accept: 'application/json' } }, function (res) {
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

// ---------- saved requests ----------
function loadRequests() {
  let text = '';
  try { text = fs.readFileSync(REQ_FILE, 'utf8'); } catch (e) { return; }
  text.split(/\r?\n/).forEach(function (l) {
    if (!l.trim()) return;
    try { const r = JSON.parse(l); if (r && r.end) requests.push(r); } catch (e) { /* skip bad line */ }
  });
  requests.sort(function (a, b) { return (a.end || 0) - (b.end || 0); });
  if (requests.length > MAX_IN_MEMORY) requests = requests.slice(-MAX_IN_MEMORY);
}
function saveRequest(r) {
  requests.push(r);
  if (requests.length > 1 && (requests[requests.length - 2].end || 0) > (r.end || 0)) requests.sort(function (a, b) { return (a.end || 0) - (b.end || 0); });
  if (requests.length > MAX_IN_MEMORY) requests.shift();
  try { paths.ensure(); fs.appendFileSync(REQ_FILE, JSON.stringify(r) + '\n'); } catch (e) { lastError = 'save failed: ' + e.message; }
}
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
    promptTokens: rec.prompt, cachedTokens: rec.cached || null, outputTokens: out || null, outputEstimated: outEst || undefined,
    genTps: genTps, firstTokenMs: firstAt != null ? Math.round(firstAt - rec.start) : null,
  };
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
const KEY_MSG = 'This llama.cpp server needs an API key (started with --api-key), which AI_SCOPE can\'t send yet. Start it without --api-key to watch it.';
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
      trackSlots(d, Date.now(), m.id);
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
  const req = http.get({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, timeout: timeout }, function (res) {
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
  // generation: exact. llama counts its speed over the gaps between tokens (n - 1), as in its own timings.
  r.outputTokens = dp; delete r.outputEstimated;
  r.genTps = (dp > 1 ? dp - 1 : dp) / ds; r.genMs = Math.round(ds * 1000); r.genExact = true;
  // prompt: only when the counters show its work (seen 0 for a request that was already running when AI_SCOPE
  // restarted) - else the first-token / duration estimates stay
  if (!(pp > 0 && ps > 0) && !(dc > 0)) return;
  if (pp > 0 && ps > 0) r.promptTps = pp / ps;
  r.promptMs = Math.round(ps * 1000);
  if (dc >= 0) r.cachedTokens = dc || null;
  r.firstTokenMs = r.promptMs;
  r.durationMs = Math.round((ps + ds) * 1000);
  r.start = r.end - r.durationMs;
  r.exact = true;
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
  const done = function () { busy = false; schedule(); };
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

// ---------- state for the page ----------
// Size on disk of a model file (router models that aren't loaded have no meta), read once per path.
const fileSizes = {};
function fileSize(p) {
  if (!p || !local) return null;
  if (!(p in fileSizes)) { try { fileSizes[p] = fs.statSync(p).size; } catch (e) { fileSizes[p] = null; } }
  return fileSizes[p];
}
// From a GGUF file name / model id: quantization ("Q4_K_M", "IQ3_XXS", "BF16") and parameter count ("35B", "26B")
function quantFromName(s) { const m = /(?:^|[-_.])((?:I?Q\d+(?:_[A-Z0-9]+)*)|BF16|F16|F32)(?=[-_.]|$)/i.exec(baseName(s) || ''); return m ? m[1].toUpperCase() : null; }
function paramsFromName(s) { const m = /(?:^|[-_.])(\d+(?:\.\d+)?)B(?=[-_.]|$)/i.exec(String(s || '')); return m ? +m[1] * 1e9 : null; }
function modelInfo(m) {
  const p = m.props || {}, dgs = p.default_generation_settings || {}, meta = m.meta || {};
  const path = m.path || p.model_path || null;
  return {
    id: m.id, name: m.id, state: m.state, path: path,
    ftype: p.model_ftype || meta.ftype || quantFromName(path), size: num(meta.size) || fileSize(path),
    params: num(meta.n_params), paramsGuess: num(meta.n_params) ? null : paramsFromName(m.id) || paramsFromName(baseName(path)),
    context: num(dgs.n_ctx) || m.contextLength || null, ctxTrain: num(meta.n_ctx_train) || m.contextLength || null,
    slots: num(p.total_slots), sleeping: !!p.is_sleeping, port: m.port || null,
    // what it takes besides text: image / video / audio (router: /models; single: /props modalities)
    inputs: (m.inputs || (p.modalities ? Object.keys(p.modalities).filter(function (k) { return p.modalities[k]; }).map(function (k) { return k === 'vision' ? 'image' : k; }) : []))
      .filter(function (x) { return x !== 'text'; }),
    process: router ? procstats.get(procKey(m.id)) : procstats.get('llamacpp'),
    metrics: m.metricsOn && m.met ? { promptTokens: m.met.promptTokens, cached: m.met.cached, predTokens: m.met.predTokens,
      genTps: m.met.predSec > 0 ? m.met.predTokens / m.met.predSec : null, promptTps: m.met.promptSec > 0 ? m.met.promptTokens / m.met.promptSec : null,
      processing: m.met.processing, deferred: m.met.deferred } : null,
    metricsOn: m.metricsOn === true,
  };
}
function getState(limit) {
  const out = { online: online, url: base || keyNeeded || configured || null, error: lastError, needsKey: !!keyNeeded,
                router: router, build: rootProps && rootProps.build_info || null, slotsEnabled: null,
                model: null, models: [], slots: [], current: [], average: null,
                totalRequests: requests.length, rows: requests.slice(-(limit || 100)).reverse(),
                process: procstats.get('llamacpp'), processSupported: procstats.supported() };
  if (!online) return out;
  // loaded models first, then the rest in the server's order
  const list = order.map(function (id) { return models[id]; }).filter(Boolean);
  out.models = list.filter(function (m) { return m.state === 'loaded'; }).concat(list.filter(function (m) { return m.state !== 'loaded'; })).map(modelInfo);
  out.model = out.models.filter(function (m) { return m.state === 'loaded'; })[0] || null;
  const loaded = list.filter(function (m) { return m.state === 'loaded' && m.slots; });
  out.slotsEnabled = loaded.length ? loaded.some(function (m) { return m.slotsEnabled !== false; }) : null;
  const now = Date.now();
  loaded.forEach(function (m) {
    (m.slots || []).forEach(function (s) {
      const n = slotNums(s), st = slotState[m.id + '#' + s.id], rec = st && st.rec;
      out.slots.push({ model: m.id, id: s.id, busy: !!s.is_processing, task: n.task, nCtx: n.nCtx, promptTokens: n.prompt, cached: n.cached,
                       decoded: s.is_processing ? n.decoded : null, used: n.total, since: rec ? Math.round(rec.start) : null });
    });
  });
  Object.keys(slotState).forEach(function (k) {
    const rec = slotState[k].rec;
    if (!rec) return;
    const s = rec.samples, n = s.length;
    let tokS = null;
    // speed over the last few looks (about 2.5 s), so one slow look doesn't jump it around
    for (let i = n - 2; i >= 0; i--) {
      if (s[n - 1].t - s[i].t >= 2500 || i === 0) {
        if (s[n - 1].t > s[i].t && s[n - 1].decoded > s[i].decoded && s[i].decoded > 0) tokS = (s[n - 1].decoded - s[i].decoded) / ((s[n - 1].t - s[i].t) / 1000);
        break;
      }
    }
    const gen = rec.decoded || 0, mi = models[rec.model];
    out.current.push({
      model: rec.model, slot: rec.slot, task: rec.task, phase: gen > 0 ? 'generating' : 'reading',
      promptTokens: rec.prompt, cached: rec.cached, generated: gen,
      maxTokens: rec.remain != null && rec.remain >= 0 ? gen + rec.remain : null,
      tokS: tokS, elapsedMs: now - rec.start,
      contextUsed: rec.prompt != null ? rec.prompt + gen : null,
      contextMax: rec.nCtx || (mi && mi.props && mi.props.default_generation_settings ? num(mi.props.default_generation_settings.n_ctx) : null),
      process: router ? procstats.get(procKey(rec.model)) : null,
      queued: mi && mi.metricsOn && mi.met && Date.now() - mi.met.at < 3000 ? mi.met.deferred || 0 : null,
    });
  });
  out.current.sort(function (a, b) { return a.elapsedMs - b.elapsedMs; });
  // token-weighted average generation speed of the recent requests (the loaded model's, or any in router mode)
  const recent = requests.filter(function (r) { return r.genTps && r.outputTokens && (router || !out.model || r.model === out.model.name); }).slice(-20);
  if (recent.length) {
    let tok = 0, sec = 0;
    recent.forEach(function (r) { tok += r.outputTokens; sec += r.outputTokens / r.genTps; });
    if (sec > 0) out.average = { model: router ? null : out.model && out.model.name, genTps: tok / sec, requests: recent.length };
  }
  return out;
}

function start(settings) {
  stop();
  settings = settings || {};
  configured = String(settings.url || '').trim().replace(/\/+$/, '');
  base = configured || null;
  if (!requestsLoaded) { requestsLoaded = true; loadRequests(); }
  running = true;
  poll();
}
function stop() {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (online) dropSlots();
  forgetModels();
  procstats.unwatch('llamacpp');
  online = false; rootProps = null; router = null; lastError = null; base = null;
}

module.exports = { start: start, stop: stop, getState: getState, getLogo: getLogo, _test: { trackSlots: trackSlots, isLlama: isLlama } };
