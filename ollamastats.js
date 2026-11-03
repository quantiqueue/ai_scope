// Ollama stats:
//  - live status from Ollama's API: /api/ps (loaded models, GPU/CPU split, context, unload time),
//    /api/tags (installed models), /api/version
//  - per-request token stats, captured by a small pass-through proxy (default 127.0.0.1:11435 -> Ollama :11434).
//    Ollama only returns timing stats to the app that sent the request, so only requests sent to the
//    proxy port show up. Saved to ~/.ai_scope/ollama-requests.jsonl.
// Settings (Ollama URL, relay port) come from the scope's install settings in start().
// No dependencies; conservative JS for older Node versions.
'use strict';
const hostAllowed = require('./hostcheck').hostAllowed;
const http = require('http');
const fs = require('fs');
const path = require('path');
const hwstats = require('./hwstats');
const procstats = require('./procstats');   // Ollama's model process: VRAM per card, GPU %, CPU, RAM (Windows; AI_SCOPE-050)
// Ollama (0.40 on snow) runs each loaded model in a child llama-server.exe of `ollama serve`; older versions used ollama_llama_server.exe.
// 'ollama runner': newer Ollama builds run each model as `ollama runner …` (same binary) - matched by name + first
// argument on Linux / macOS (AI_SCOPE-052; not seen on a test machine yet). Exe names: Windows (.exe ignored elsewhere).
const MODEL_PROCS = ['llama-server.exe', 'ollama_llama_server.exe', 'ollama runner'];
const vramFit = hwstats.vramFit;  // VRAM fit vs the largest card
const StringDecoder = require('string_decoder').StringDecoder;

let OLLAMA_URL = 'http://127.0.0.1:11434';
let UP = new URL(OLLAMA_URL);
let PROXY_PORT = 11435;
const PROXY_HOST = '127.0.0.1';
const paths = require('./paths');                       // data folder: ~/.ai_scope
const REQ_FILE = paths.file('ollama-requests.jsonl');
const reqstore = require('./reqstore');            // AI_SCOPE-094 slice 1: the shared history store
const reqstats = require('./reqstats');            // AI_SCOPE-094 slice 3: the shared average builder
const MAX_BODY_CAPTURE = 4 * 1024 * 1024;                // request bodies bigger than this: model name via regex
const TRACKED = /^\/(api\/(generate|chat)|v1\/(chat\/)?completions)$/;

let online = false;
let version = null;
let lastError = null;
let loaded = [];
let installed = [];
let tagsAt = 0;
let proxy = { host: PROXY_HOST, port: PROXY_PORT, listening: false, error: null };
// One store, one file, this scope's own 1000-row ring. Ollama reports cached prompt tokens natively
// since 0.33.3 (prompt_eval_cached_count - AI_SCOPE-102 fills the 094 Cached/Prompt-read fields from it;
// there is no row-identity map to keep), so its store takes the default accept; the load only reseeds nextId.
const store = reqstore.createStore({
  file: REQ_FILE,
  accept: function (r) { return !isEmptyCall(r); },      // load filter: skip Ollama load/unload calls
  resortOnAppend: false,                                 // Ollama appends in arrival order (unchanged)
  onError: function (msg) { lastError = msg; },
  onLoaded: function (rows) { rows.forEach(function (r) { if (r.id >= nextId) nextId = r.id + 1; }); },
  // AI_SCOPE-094 slice 2: the saved lines from before the rename carry the old names; map them on read.
  mapRow: function (r) {
    const hadSrc = r.src !== undefined;                 // rows written after slice 4 need no back-fill
    if (r.genTokens !== undefined) { r.outputTokens = r.genTokens; delete r.genTokens; }
    if (r.totalMs !== undefined) { r.durationMs = r.totalMs; delete r.totalMs; }
    if (r.ttftMs !== undefined) { r.firstTokenMs = r.ttftMs; delete r.ttftMs; }
    // slice 4: the old boolean dialects become provenance entries on read.
    const P = reqstats.PROV;
    if (r.measured) {
      reqstats.setProv(r, 'genMs', P.DERIVED); reqstats.setProv(r, 'promptMs', P.DERIVED);
      reqstats.setProv(r, 'durationMs', P.DERIVED);
    }
    if (r.genDerived) reqstats.setProv(r, 'genTps', P.DERIVED);
    if (r.promptDerived) reqstats.setProv(r, 'promptTps', P.DERIVED);
    if (r.firstTokenDerived) reqstats.setProv(r, 'firstTokenMs', P.SUBSTITUTE);
    ['measured', 'genDerived', 'promptDerived', 'firstTokenDerived'].forEach(k => { delete r[k]; });
    // And lines saved before any of those flags existed: Ollama never reported a speed or a
    // first-token time, so every one of those numbers on an old line is ours.
    if (!hadSrc) {
      if (r.genTps != null) reqstats.setProv(r, 'genTps', P.DERIVED);
      if (r.promptTps != null) reqstats.setProv(r, 'promptTps', P.DERIVED);
      if (r.firstTokenMs != null) reqstats.setProv(r, 'firstTokenMs', P.DERIVED);
    }
    return r;
  }
});
const requests = store.rows();   // newest last — the store mutates this array in place
const inflight = {};
let nextId = 1;
// Ollama used without the relay (AI_SCOPE-018): a model gets loaded, or its unload time moves forward (Ollama resets
// it on every request), while no request was going through the relay -> those requests aren't recorded.
let prevLoaded = null;      // name -> expiresAt at the previous poll (null until the first poll after (re)connecting)
let lastRelayAt = 0;        // last time a request was going through the relay
let directUse = null;       // { at, model, count } - the latest use seen without the relay

// ---------- helpers ----------
function getJson(p, cb) {
  const req = http.get({ hostname: UP.hostname, port: UP.port || 80, path: p, timeout: 4000 }, function (res) {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', function (d) { body += d; });
    res.on('end', function () {
      if (res.statusCode !== 200) return cb(new Error('HTTP ' + res.statusCode));
      try { cb(null, JSON.parse(body)); } catch (e) { cb(e); }
    });
  });
  req.on('timeout', function () { req.destroy(new Error('timeout')); });
  req.on('error', function (e) { cb(e); });
}
function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function nsToMs(v) { return typeof v === 'number' ? v / 1e6 : null; }
function details(m) { return m.details || {}; }

// ---------- saved requests (the store does the read, parse, sort, trim, append, cap) ----------
function loadRequests() { store.load(); }
// Ollama load/unload calls (e.g. the empty /api/generate that `ollama run` sends to load a model)
// finish OK with no prompt and no output - not a real request, so they are not recorded.
function isEmptyCall(r) {
  return r.status === 'ok' && !r.outputTokens && !r.promptTokens && !r.thinkTokens;
}
function saveRequest(r) { store.append(r); }

// ---------- polling Ollama's API ----------
function poll() {
  getJson('/api/ps', function (err, d) {
    if (err) {
      online = false; loaded = []; prevLoaded = null; lastError = 'Ollama not reachable at ' + OLLAMA_URL + ' (' + err.message + ')';
      procstats.attest('ollama', 'off');   // AI_SCOPE-081: unreachable attests off, procstats writes the zero heartbeat
      return;
    }
    const wasOffline = !online;
    online = true; lastError = null;
    loaded = (d.models || []).map(function (m) {
      const size = num(m.size) || 0, vram = num(m.size_vram) || 0;
      return {
        name: m.name || m.model, size: size, sizeVram: vram,
        gpuPct: size ? Math.round(100 * vram / size) : null,
        context: num(m.context_length),
        expiresAt: m.expires_at ? Date.parse(m.expires_at) : null,
        params: details(m).parameter_size || null, quant: details(m).quantization_level || null,
      };
    });
    if (wasOffline || Date.now() - tagsAt > 30000) refreshTags();
    detectDirectUse();
    // AI_SCOPE-081: attestation for the Hardware Mirror Lens family (web/js/mirror.js). live / idle / off come
    // straight from Ollama's own /api/ps answer. 'loading' is the narrow observation (the user's 2C2): an inflight
    // RELAY request naming a model /api/ps does not list yet - the same check currentRequest() uses for its
    // "loading model" phase - so it words the load window without inventing an API signal Ollama does not have.
    // A direct (non-relay) load stays unattested-'live'-until-loaded: 'idle' zeros cover it until /api/ps lists the
    // model, and Ollama's API offers no 'unloading' / 'failed' to attest (recorded decision, ticket line 11).
    const cur = currentRequest();
    procstats.attest('ollama', loaded.length ? 'live' : (cur && cur.phase === 'loading') ? 'loading' : 'idle');
  });
}
function detectDirectUse() {
  const now = Date.now(), prev = prevLoaded;
  prevLoaded = {};
  loaded.forEach(function (m) { prevLoaded[m.name] = m.expiresAt; });
  if (!prev) return;                                                           // first look: nothing to compare with
  if (Object.keys(inflight).length || now - lastRelayAt < 8000) return;        // the relay was busy: that explains it
  const used = loaded.filter(function (m) {
    if (!(m.name in prev)) return true;                                        // newly loaded
    return m.expiresAt != null && prev[m.name] != null && m.expiresAt - prev[m.name] > 1500;   // unload time renewed
  });
  if (used.length) directUse = { at: now, model: used[0].name, count: (directUse ? directUse.count : 0) + 1 };
}
// Where a model comes from: Ollama library page + original model on Hugging Face (from the GGUF metadata via /api/show).
const showCache = {};   // name|modified -> { org, baseName, repoUrl }
function postJson(p, body, cb) {
  const data = JSON.stringify(body);
  const req = http.request({ hostname: UP.hostname, port: UP.port || 80, path: p, method: 'POST', timeout: 5000,
                             headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, function (res) {
    let b = '';
    res.setEncoding('utf8');
    res.on('data', function (d) { b += d; });
    res.on('end', function () { if (res.statusCode !== 200) return cb(new Error('HTTP ' + res.statusCode)); try { cb(null, JSON.parse(b)); } catch (e) { cb(e); } });
  });
  req.on('timeout', function () { req.destroy(new Error('timeout')); });
  req.on('error', function (e) { cb(e); });
  req.end(data);
}
function fillSources(list) {
  let i = 0;
  (function next() {
    while (i < list.length && showCache[list[i].name + '|' + list[i].modified]) i++;
    if (i >= list.length) return;
    const m = list[i++];
    postJson('/api/show', { model: m.name }, function (err, s) {
      const mi = (!err && s && s.model_info) || {};
      const arch = mi['general.architecture'];
      showCache[m.name + '|' + m.modified] = {
        caps: (!err && s && Array.isArray(s.capabilities)) ? s.capabilities : [],
        maxContext: arch && typeof mi[arch + '.context_length'] === 'number' ? mi[arch + '.context_length'] : null,
        org: mi['general.base_model.0.organization'] || mi['general.organization'] || null,
        baseName: mi['general.base_model.0.name'] || mi['general.basename'] || null,
        repoUrl: mi['general.base_model.0.repo_url'] || mi['general.repo_url'] || null,
      };
      next();
    });
  })();
}
function sourceOf(m) {
  const name = m.name || '';
  const bare = name.split(':')[0];
  // pulled straight from Hugging Face: hf.co/<user>/<repo>:<quant>
  const hf = /^(?:hf\.co|huggingface\.co)\/([^\/]+)\/([^\/:]+)/i.exec(name);
  if (hf) return { modelUrl: 'https://huggingface.co/' + hf[1] + '/' + hf[2], libraryUrl: null,
                   publisher: hf[1], publisherUrl: 'https://huggingface.co/' + hf[1], baseName: null };
  const libraryUrl = 'https://ollama.com/' + (bare.indexOf('/') >= 0 ? bare : 'library/' + bare);
  const c = showCache[m.name + '|' + m.modified] || {};
  let publisherUrl = null, publisher = c.org;
  const r = c.repoUrl && /^https?:\/\/(?:huggingface\.co|hf\.co)\/([^\/]+)/i.exec(c.repoUrl);
  if (r) { publisherUrl = 'https://huggingface.co/' + r[1]; if (!publisher) publisher = r[1]; }
  const capMap = { vision: 'vision', tools: 'tools', thinking: 'reasoning', embedding: 'embedding' };
  const features = (c.caps || []).map(function (x) { return capMap[x]; }).filter(Boolean);
  return { modelUrl: c.repoUrl || null, libraryUrl: libraryUrl, publisher: publisher || null, publisherUrl: publisherUrl,
           baseName: c.baseName || null, features: features, maxContext: c.maxContext || null };
}

function refreshTags() {
  tagsAt = Date.now();
  getJson('/api/tags', function (err, d) {
    if (err) return;
    installed = (d.models || []).map(function (m) {
      return {
        name: m.name || m.model, size: num(m.size), modified: m.modified_at ? Date.parse(m.modified_at) : null,
        family: details(m).family || null, params: details(m).parameter_size || null,
        quant: details(m).quantization_level || null, format: details(m).format || null,
      };
    }).sort(function (a, b) { return (b.modified || 0) - (a.modified || 0); });
    fillSources(installed);
  });
  getJson('/api/version', function (err, d) { if (!err) version = d.version || null; });
}

// ---------- proxy: forwards everything, records generate/chat requests ----------
function tick(rec, thinking) {
  const now = Date.now();
  if (!rec.firstAt) rec.firstAt = now;
  rec.lastAt = now;
  rec.tokens++;
  if (thinking) rec.think++;
  rec.phase = thinking ? 'thinking' : 'gen';
  rec.times.push(now);
  while (rec.times.length && now - rec.times[0] > 3000) rec.times.shift();
}
function handleLine(rec, line) {
  line = line.trim();
  if (!line) return;
  let payload = line;
  if (rec.openai) {
    if (line.indexOf('data:') === 0) payload = line.slice(5).trim();
    if (payload === '[DONE]' || payload.charAt(0) !== '{') return;
  }
  let o;
  try { o = JSON.parse(payload); } catch (e) { return; }
  if (!rec.model && o.model) rec.model = o.model;
  if (o.error) rec.error = typeof o.error === 'string' ? o.error : (o.error.message || 'error');
  if (rec.openai) {
    if (o.usage) rec.usage = o.usage;
    const c = o.choices && o.choices[0];
    const dl = c && c.delta;
    if (dl) {
      const content = dl.content, think = dl.reasoning || dl.reasoning_content || dl.thinking;
      if (content || think) tick(rec, !!think && !content);
    }
    return;
  }
  const msg = o.message || {};
  const content = o.response || msg.content, think = o.thinking || msg.thinking;
  if (o.done) { rec.final = o; return; }
  if (content || think || (msg.tool_calls && msg.tool_calls.length)) tick(rec, !!think && !content);
}
function onResponseData(rec, chunk) {
  rec.buf += rec.decoder.write(chunk);
  const lines = rec.buf.split('\n');
  rec.buf = lines.pop();
  lines.forEach(function (l) { handleLine(rec, l); });
}
function finish(rec, aborted) {
  if (rec.done) return;
  rec.done = true;
  lastRelayAt = Date.now();
  delete inflight[rec.id];
  rec.buf += rec.decoder.end();
  if (rec.buf) { handleLine(rec, rec.buf); rec.buf = ''; }
  const end = Date.now(), f = rec.final, u = rec.usage;
  // AI_SCOPE-094 slice 2: canonical record names — outputTokens / durationMs / firstTokenMs, the
  // same fields the other scopes carry. Old saved lines are mapped back on read by the store.
  const r = { id: rec.id, start: rec.start, end: end, model: rec.model || 'unknown', endpoint: rec.endpoint,
              status: aborted ? 'aborted' : (rec.status === 200 && !rec.error ? 'ok' : 'error'),
              error: rec.error || (rec.status && rec.status !== 200 ? 'HTTP ' + rec.status : null),
              outputTokens: null, genMs: null, promptTokens: null, promptMs: null, promptRead: null, loadMs: null,
              firstTokenMs: rec.firstAt ? rec.firstAt - rec.start : null, durationMs: end - rec.start,
              thinkTokens: rec.think || null };
  // AI_SCOPE-094 slice 4: provenance, one rule - Ollama's own API numbers are exact (no entry
  // needed), anything the relay timed or divided out is derived.
  const P = reqstats.PROV;
  if (f) {   // native API: Ollama's own timings (nanoseconds)
    r.outputTokens = num(f.eval_count); r.genMs = nsToMs(f.eval_duration);
    r.promptTokens = num(f.prompt_eval_count); r.promptMs = nsToMs(f.prompt_eval_duration);
    r.loadMs = nsToMs(f.load_duration);
    if (num(f.total_duration)) r.durationMs = nsToMs(f.total_duration);
    else reqstats.setProv(r, 'durationMs', P.DERIVED);            // our clock, not Ollama's total
    // AI_SCOPE-102 (D2): the native done-chunk reports the CACHED share of the prompt since Ollama 0.33.3
    // (docs.ollama.com/api/usage). Exact where reported; pre-0.33.3 the field simply never arrives, so
    // Cached / Prompt-read stay honest gaps there (provably unfillable - the 103 terminology rule).
    const cached = num(f.prompt_eval_cached_count);
    if (cached != null) r.cachedTokens = cached;
    // No stream first-token stamp: load + prefill answers a DIFFERENT question from the column's,
    // so it is a substitute, not merely a derived figure.
    if (r.firstTokenMs == null) r.firstTokenMs = (r.loadMs || 0) + (r.promptMs || 0);
  } else {   // OpenAI-compatible API or cut-off stream: timings measured by the relay
    r.outputTokens = u && num(u.completion_tokens) != null ? u.completion_tokens : (rec.tokens || null);
    if (!(u && num(u.completion_tokens) != null)) reqstats.setProv(r, 'outputTokens', P.DERIVED);
    r.promptTokens = u ? num(u.prompt_tokens) : null;
    // AI_SCOPE-102: the OpenAI-compat path reports no cached share (rec.usage is kept whole but the
    // field is not part of the answer), so promptRead / cachedTokens stay null - honest gaps.
    if (rec.firstAt && rec.lastAt > rec.firstAt) r.genMs = rec.lastAt - rec.firstAt;
    reqstats.setProv(r, 'genMs', P.DERIVED);
    reqstats.setProv(r, 'promptMs', P.DERIVED);                   // never reported on this path
    reqstats.setProv(r, 'durationMs', P.DERIVED);
  }
  // The relay's own first-token observation is derived (a clock reading, not an Ollama number);
  // where no stamp arrived at all, the column carries load + prefill instead - a substitute.
  if (r.firstTokenMs != null) reqstats.setProv(r, 'firstTokenMs', rec.firstAt ? P.DERIVED : P.SUBSTITUTE);
  // genTps / promptTps are always ours (tokens ÷ time), so both carry the derived marker.
  r.genTps = r.outputTokens && r.genMs ? r.outputTokens / (r.genMs / 1000) : null;
  if (r.genTps != null) reqstats.setProv(r, 'genTps', P.DERIVED);
  // AI_SCOPE-102 (D2): promptRead = the tokens actually re-read (whole prompt minus the cached share),
  // the basis Ollama's prompt_eval_duration covers. max() floors the off-by-a-few slop the way 103's
  // lmstats did; no cached count reported (pre-0.33.3, or the OpenAI path) ⇒ null, never a fake whole.
  if (r.promptTokens != null && r.cachedTokens != null) {
    r.promptRead = Math.max(0, r.promptTokens - r.cachedTokens);
    reqstats.setProv(r, 'promptRead', P.DERIVED);
  }
  // promptTps is a READ rate: Ollama's duration covers the uncached tokens only (since 0.33.3), so
  // dividing the whole prompt by it inflated every cache-heavy request - the bug the 102 grounding found.
  // Where no cached share exists the whole prompt WAS read, so the old division stands as its fallback.
  const pDiv = r.promptRead != null ? r.promptRead : r.promptTokens;
  r.promptTps = pDiv && r.promptMs ? pDiv / (r.promptMs / 1000) : null;
  if (r.promptTps != null) reqstats.setProv(r, 'promptTps', P.DERIVED);
  r.peak = hwstats.peakBetween(r.start, end + 2000);   // whole-PC peak GPU/VRAM/CPU/RAM while it ran
  if ((r.status === 'ok' || rec.tokens || r.error) && !isEmptyCall(r)) saveRequest(r);
  if (r.model !== 'unknown' && !installed.some(function (m) { return m.name === r.model; })) tagsAt = 0;
}

let proxySrv = null;
function startProxy() {
  const srv = proxySrv = http.createServer(function (req, res) {
    // DNS-rebinding guard (AI_SCOPE-021): the relay rewrites Host for Ollama, which would hide a foreign name from
    // Ollama's own check - so check it here first.
    if (!hostAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'AI_SCOPE relay: unknown host name (add it in AI_SCOPE Settings - Server - Allowed host names)' }));
    }
    const ep = req.url.split('?')[0];
    let rec = null;
    if (req.method === 'POST') { lastRelayAt = Date.now(); res.on('close', function () { lastRelayAt = Date.now(); }); }   // any model call (also embeddings)
    if (req.method === 'POST' && TRACKED.test(ep)) {
      rec = { id: nextId++, endpoint: ep, openai: ep.indexOf('/v1/') === 0, start: Date.now(), model: null,
              body: [], bodyLen: 0, firstAt: null, lastAt: null, tokens: 0, think: 0, times: [], phase: 'prompt',
              buf: '', decoder: new StringDecoder('utf8'), final: null, usage: null, status: null, error: null, done: false };
      inflight[rec.id] = rec;
      req.on('data', function (d) { if (rec.bodyLen < MAX_BODY_CAPTURE) rec.body.push(d); rec.bodyLen += d.length; });
      req.on('end', function () {
        const text = Buffer.concat(rec.body).toString('utf8');
        rec.body = null;
        try { rec.model = JSON.parse(text).model || null; }
        catch (e) { const m = /"model"\s*:\s*"([^"]+)"/.exec(text); rec.model = m ? m[1] : null; }
      });
    }
    const headers = Object.assign({}, req.headers);
    headers.host = UP.host;
    delete headers['accept-encoding'];   // keep responses uncompressed so they can be read
    const up = http.request({ hostname: UP.hostname, port: UP.port || 80, path: req.url, method: req.method, headers: headers }, function (ures) {
      if (rec) rec.status = ures.statusCode;
      res.writeHead(ures.statusCode, ures.headers);
      if (rec) ures.on('data', function (d) { onResponseData(rec, d); });
      ures.on('end', function () { if (rec) finish(rec, false); });
      ures.pipe(res);
    });
    up.on('error', function (e) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'AI_SCOPE proxy: Ollama not reachable at ' + OLLAMA_URL + ' (' + e.message + ')' }));
      } else res.destroy();
      if (rec) { rec.status = 502; rec.error = 'Ollama not reachable'; finish(rec, false); }
    });
    res.on('close', function () {   // client went away before the answer finished
      if (rec && !rec.done) { finish(rec, true); up.destroy(); }
    });
    req.pipe(up);
  });
  srv.on('error', function (e) { proxy.listening = false; proxy.error = e.code === 'EADDRINUSE' ? 'port ' + PROXY_PORT + ' already in use' : e.message; });
  srv.listen(PROXY_PORT, PROXY_HOST, function () { proxy.listening = true; proxy.error = null; });
}

// ---------- gen tok/s perf ring (AI_SCOPE-102 D3) ----------
// The 103 machinery (lmstats.js) with Ollama's facts: the live rate is the RELAY's own chunk-arrival
// observation (currentRequest's ≤3 s window) - an estimate, so its faces will say so client-side -
// and there are no slots to separate, so rings key by model only (Bionic's shape). Sampled per
// /api/ollama call (the page's ~2 s cadence), wall-throttled so a faster poll cannot flood a
// time-sized ring. Phase gate: only generating/thinking stretches push (D3; the reading phase has
// no generation rate - stratastats' gate is the precedent, 103's D3 answer to "does reading count
// as gen tok?" was NO and stands here too). No in-flight relay request ⇒ no points.
const PERF_WIN = 300000, PERF_CAP = 400, PERF_PUSH_MS = 1750, PERF_EVERY = 2000;
const perfRings = {};   // model key -> { tps: [], next: 0 }
function trimPerf(a) {
  if (a.length < 2) return;
  const cut = a[a.length - 1].t - PERF_WIN;
  let i = 0;
  while (i < a.length - 2 && a[i].t < cut) i++;   // newest - window, plus ONE older sample (092)
  if (i) a.splice(0, i);
}
// cur = currentRequest()'s pick — the SAME object the card shows (one shared pick, card and rings
// can never disagree: the 093 rule). now injectable for the probe (the 098/103 precedent).
function samplePerf(cur, now) {
  if (now == null) now = Date.now();
  if (!cur || (cur.phase !== 'generating' && cur.phase !== 'thinking') || cur.genTps == null) return;
  const ring = perfRings[cur.model] || (perfRings[cur.model] = { tps: [], next: 0 });
  if (now < ring.next) return;
  ring.next = now + PERF_PUSH_MS;
  ring.tps.push({ t: now, every: PERF_EVERY, v: cur.genTps, m: cur.model });
  if (ring.tps.length > 1) trimPerf(ring.tps);
  if (ring.tps.length > PERF_CAP) ring.tps.splice(0, ring.tps.length - PERF_CAP);   // safety cap only
}
// The delta payload (084 item 7): only points newer than `since`, merged across models, oldest first.
function tpsHistorySince(since) {
  const out = [];
  Object.keys(perfRings).forEach(function (k) {
    const a = perfRings[k].tps;
    for (let i = 0; i < a.length; i++) if (a[i].t > since) out.push(a[i]);
  });
  out.sort(function (x, y) { return x.t - y.t; });
  return out;
}
// AI_SCOPE-102 (D4): the prompt twin of average(), Bionic's getPromptAverage shape (reqstats' builder
// weighing `promptRead`, the tokens the seconds cover). Rows are the store's own ring, OLDEST last —
// unlike Bionic's newest-first log rows — so the newest model is taken explicitly (the store's last).
function getPromptAverage(rows) {
  if (!rows.length) return null;
  const model = rows[rows.length - 1].model;
  const a = reqstats.avgSpeed(rows, model, { tokensField: 'promptRead', timeField: 'promptMs' });
  return a ? { model: model, promptTps: a.value, requests: a.requests } : null;
}

// ---------- state for the UI ----------
function currentRequest() {
  const ids = Object.keys(inflight);
  if (!ids.length) return null;
  const rec = inflight[ids[ids.length - 1]], now = Date.now();
  let genTps = null;
  if (rec.times.length >= 2 && now - rec.lastAt < 3000) {
    const span = (rec.times[rec.times.length - 1] - rec.times[0]) / 1000;
    if (span > 0) genTps = (rec.times.length - 1) / span;
  }
  let phase = rec.firstAt ? rec.phase : 'prompt';
  if (!rec.firstAt && rec.model && online && !loaded.some(function (m) { return m.name === rec.model; })) phase = 'loading';
  // AI_SCOPE-100 (D4): the relay's internal states (prompt / thinking / gen, set from the stream) map
  // to the family's live words at the wire edge - outputTokens / genTps are 094's canonical names.
  const PH = { prompt: 'reading', gen: 'generating', thinking: 'thinking', loading: 'loading' };
  return { model: rec.model || 'unknown', endpoint: rec.endpoint, phase: PH[phase] || 'reading', elapsedMs: now - rec.start,
           outputTokens: rec.tokens, thinkTokens: rec.think, genTps: genTps, othersRunning: ids.length - 1 };
}
function average() {
  const done = requests.filter(function (r) { return r.genTps; });
  if (!done.length) return null;
  const model = done[done.length - 1].model;
  // AI_SCOPE-094 slice 3: the shared token-weighted builder. The old copy summed r.genTokens here,
  // which slice 2 had renamed to outputTokens - the sum went NaN and the payload silently answered
  // genTps: null. Fixed and covered by ai-scope-094-slice1\094-avg-parity.js.
  const a = reqstats.avgSpeed(done, model, { timeField: 'genMs' });
  return { model: model, requests: a ? a.requests : 0, genTps: a ? a.value : null };
}
// vram: hwstats.vramInfo() (card sizes); Ollama can split a model across cards.
// AI_SCOPE-081: since (AI_SCOPE-084 item 7) sends only processHistory points newer than it - the mirror
// lenses' client ring asks with &since=, so the 5-min ring never rides the whole payload; stratastats.js
// (072) is the pattern for the fields. AI_SCOPE-102: the same since now feeds the gen tpsHistory delta too.
function getState(limit, vram, since, cur) {
  if (cur === undefined) cur = currentRequest();   // AI_SCOPE-102: the route passes the pick it just sampled; card and ring share one look
  return {
    online: online, url: OLLAMA_URL, version: version, error: lastError, proxy: proxy, vramTotal: vram ? vram.largest : null, vramCards: vram ? vram.cards.length : 0,
    loaded: loaded.map(function (l) {
      const inst = installed.filter(function (m) { return m.name === l.name; })[0];
      return Object.assign({ maxContext: inst ? sourceOf(inst).maxContext : null }, l);
    }),
    installed: installed.map(function (m) {
      const f = vramFit(m.size, vram, true);
      return Object.assign({ fit: f ? f.fit : null, fitGpus: f ? f.gpus || null : null, loaded: loaded.some(function (l) { return l.name === m.name; }) }, m, sourceOf(m));
    }).sort(function (a, b) { return (b.loaded - a.loaded) || ((b.size || 0) - (a.size || 0)); }),
    current: cur, average: average(), directUse: directUse,
    // AI_SCOPE-102 (D4/D5): the prompt idle face (Bionic/Strata's shape) and the gen ring's delta.
    promptAverage: getPromptAverage(requests), tpsHistory: tpsHistorySince(since || 0),
    // Ollama's model process(es) (Windows): VRAM / GPU % per card, CPU %, RAM; null elsewhere or with no model loaded
    process: online ? procstats.get('ollama') : null, processSupported: procstats.supported(),
    // AI_SCOPE-081: the Hardware Mirror Lens family (web/js/mirror.js) also needs the 5-minute process history
    // and the Hardware card names / totals, like stratastats / the /api/bionic route send for Strata / Bionic.
    processHistory: procstats.history('ollama', since || 0),
    processCards: hwstats.getStats().info.gpus.map(function (g) { return { name: g.name, vramTotal: g.vramTotal, source: g.source }; }),
    totalRequests: requests.length, rows: requests.slice(-(limit || 100)).reverse(),
  };
}

// settings: { url, proxyPort }
let timer = null;
function start(settings) {
  stop();
  settings = settings || {};
  OLLAMA_URL = String(settings.url || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  UP = new URL(OLLAMA_URL);
  PROXY_PORT = parseInt(settings.proxyPort, 10) || 11435;
  proxy = { host: PROXY_HOST, port: PROXY_PORT, listening: false, error: null };
  tagsAt = 0;
  loadRequests();          // the store ignores a second load (AI_SCOPE-094 slice 1)
  startProxy();
  procstats.watch('ollama', [+(UP.port || (UP.protocol === 'https:' ? 443 : 80))], MODEL_PROCS);
  poll();
  timer = setInterval(poll, 2000);
}
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  for (const k in perfRings) delete perfRings[k];   // AI_SCOPE-102: an uninstalled scope drops its rings too (103's lmstats lesson)
  procstats.unwatch('ollama');
  procstats.unattest('ollama');   // AI_SCOPE-081: an uninstalled scope stops claiming history (like strata / bionic)
  if (proxySrv) { try { proxySrv.close(); if (proxySrv.closeAllConnections) proxySrv.closeAllConnections(); } catch (e) {} proxySrv = null; }
  proxy = { host: PROXY_HOST, port: PROXY_PORT, listening: false, error: null };
  online = false; loaded = []; lastError = null;
}

module.exports = { start: start, stop: stop, getState: getState, currentRequest: currentRequest, samplePerf: samplePerf, tpsHistorySince: tpsHistorySince, getPromptAverage: getPromptAverage };
