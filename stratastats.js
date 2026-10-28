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
const MODEL_PROCS = ['strata.exe'];
const paths = require('./paths');                       // data folder: ~/.ai_scope

const DEFAULT_URL = 'http://127.0.0.1:47831';
const REQ_FILE = paths.file('strata-requests.jsonl');
const MAX_IN_MEMORY = 1000;

let base = DEFAULT_URL;
let timer = null;
let busy = false;
let online = false;
let lastError = null;
let native = null;          // last good /api/native response
let fetchedAt = 0;
let requests = [];          // saved finished requests, oldest first
const known = {};           // key -> true (saved)
const waiting = {};         // key -> raw request seen but not saved yet (waiting for the samples after it ended)
let requestsLoaded = false;
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

// ---------- saved requests ----------
function loadRequests() {
  let text = '';
  try { text = fs.readFileSync(REQ_FILE, 'utf8'); } catch (e) { return; }
  text.split(/\r?\n/).forEach(function (l) {
    if (!l.trim()) return;
    try { const r = JSON.parse(l); if (r && r.key && !known[r.key]) { known[r.key] = true; requests.push(r); } } catch (e) { /* skip bad line */ }
  });
  requests.sort(function (a, b) { return (a.end || 0) - (b.end || 0); });
  if (requests.length > MAX_IN_MEMORY) requests = requests.slice(-MAX_IN_MEMORY);
}
function saveRequest(r) {
  known[r.key] = true;
  requests.push(r);
  if (requests.length > 1 && (requests[requests.length - 2].end || 0) > (r.end || 0)) requests.sort(function (a, b) { return (a.end || 0) - (b.end || 0); });
  if (requests.length > MAX_IN_MEMORY) requests.shift();
  try { paths.ensure(); fs.appendFileSync(REQ_FILE, JSON.stringify(r) + '\n'); } catch (e) { lastError = 'save failed: ' + e.message; }
}
// One finished request from the engine's metrics -> our row. `time` is when it finished (seconds).
function toRow(inst, x) {
  const end = num(x.time) != null ? x.time * 1000 : null;
  const dur = num(x.duration_s) != null ? x.duration_s * 1000 : null;
  const promptRead = num(x.prompt_read);
  const promptMs = num(x.prompt_ms), decodeMs = num(x.decode_ms), out = num(x.output_tokens);
  return {
    key: inst.id + ':' + x.id, id: String(x.id), instanceId: inst.id,
    model: inst.label || inst.model || 'unknown', variant: inst.model || null,
    start: end != null && dur != null ? end - dur : null, end: end, durationMs: dur, finish: x.finish || null,
    promptTokens: num(x.prompt_tokens), reused: num(x.reused), promptRead: promptRead, outputTokens: out,
    promptMs: promptMs, decodeMs: decodeMs,
    genTps: num(x.decode_tok_s) != null ? x.decode_tok_s : (out && decodeMs ? out / (decodeMs / 1000) : null),
    promptTps: promptRead && promptMs ? promptRead / (promptMs / 1000) : null,
    firstTokenMs: num(x.first_engine_token_s) != null ? x.first_engine_token_s * 1000 : null,
    hitRate: num(x.hit_rate),
    draftsOffered: num(x.drafts_offered), draftsAccepted: num(x.drafts_accepted),
  };
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

// ---------- polling ----------
function poll() {
  if (busy) return;
  busy = true;
  getJson('/api/native', 3000, function (err, d) {
    busy = false;
    if (err || !d || !Array.isArray(d.instances)) {
      online = false; native = null;
      lastError = err ? (err.code === 'ECONNREFUSED' ? 'Strata app not running at ' + base : err.message) : 'unexpected answer - is this the Strata app?';
      return;
    }
    online = true; lastError = null; native = d; fetchedAt = Date.now();
    const enginePorts = d.instances.map(function (i) { return +i.port; }).filter(function (p) { return p > 0 && p < 65536; });
    if (enginePorts.length) procstats.watch('strata', enginePorts, MODEL_PROCS); else procstats.unwatch('strata');
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

function getState(limit) {
  const d = native;
  const out = { online: online, url: base, error: lastError, fetchedAt: fetchedAt || null,
                version: null, engineVersion: null, updateNotice: null,
                current: null, loaded: null, totals: null, average: null, installed: [],
                totalRequests: requests.length, rows: requests.slice(-(limit || 100)).reverse() };
  // Strata's model process(es): VRAM / GPU % per card, CPU %, RAM; null elsewhere or with no model loaded.
  // AI_SCOPE-072: processCards (Hardware card names / totals for the tile labels) and processHistory (5 min,
  // newest last) join the answer, and all of it stays in the payload when Strata itself is offline - the GPU /
  // VRAM tiles draw their histories right through an "Inactive" stretch.
  out.process = procstats.get('strata'); out.processSupported = procstats.supported();
  out.processHistory = procstats.history('strata');
  out.processCards = hwstats.getStats().info.gpus.map(function (g) { return { name: g.name, vramTotal: g.vramTotal, source: g.source }; });
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
                          promptTokens: num(t.prompt_tokens), reused: num(t.reused), outputTokens: num(t.output_tokens),
                          draftsOffered: num(t.drafts_offered), draftsAccepted: num(t.drafts_accepted) };
  }
  // Token-weighted average generation speed for the loaded model's recent saved requests.
  const model = out.loaded ? out.loaded.label : (requests.length ? requests[requests.length - 1].model : null);
  const recent = requests.filter(function (r) { return r.model === model && r.outputTokens && r.decodeMs; }).slice(-20);
  if (recent.length) {
    let tok = 0, ms = 0;
    recent.forEach(function (r) { tok += r.outputTokens; ms += r.decodeMs; });
    out.average = { model: model, genTps: tok / (ms / 1000), requests: recent.length };
  }
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
  if (!requestsLoaded) { requestsLoaded = true; loadRequests(); }
  poll();
  timer = setInterval(poll, 2000);
}
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  procstats.unwatch('strata');
  online = false; native = null; lastError = null;
}

module.exports = { start: start, stop: stop, getState: getState, getLogo: getLogo };
