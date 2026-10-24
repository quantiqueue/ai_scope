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
const MODEL_PROCS = ['llama-server.exe', 'ollama_llama_server.exe'];
const vramFit = hwstats.vramFit;  // VRAM fit vs the largest card
const StringDecoder = require('string_decoder').StringDecoder;

let OLLAMA_URL = 'http://127.0.0.1:11434';
let UP = new URL(OLLAMA_URL);
let PROXY_PORT = 11435;
const PROXY_HOST = '127.0.0.1';
const paths = require('./paths');                       // data folder: ~/.ai_scope
const REQ_FILE = paths.file('ollama-requests.jsonl');
const MAX_IN_MEMORY = 1000;
const MAX_BODY_CAPTURE = 4 * 1024 * 1024;                // request bodies bigger than this: model name via regex
const TRACKED = /^\/(api\/(generate|chat)|v1\/(chat\/)?completions)$/;

let online = false;
let version = null;
let lastError = null;
let loaded = [];
let installed = [];
let tagsAt = 0;
let proxy = { host: PROXY_HOST, port: PROXY_PORT, listening: false, error: null };
let requests = [];          // newest last
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

function loadRequests() {
  paths.ensure();
  let text = '';
  try { text = fs.readFileSync(REQ_FILE, 'utf8'); } catch (e) { return; }
  text.split(/\r?\n/).forEach(function (l) {
    if (!l.trim()) return;
    try { const r = JSON.parse(l); if (!isEmptyCall(r)) requests.push(r); } catch (e) { /* skip bad line */ }
  });
  requests.sort(function (a, b) { return (a.end || 0) - (b.end || 0); });
  if (requests.length > MAX_IN_MEMORY) requests = requests.slice(-MAX_IN_MEMORY);
  requests.forEach(function (r) { if (r.id >= nextId) nextId = r.id + 1; });
}
// Ollama load/unload calls (e.g. the empty /api/generate that `ollama run` sends to load a model)
// finish OK with no prompt and no output - not a real request, so they are not recorded.
function isEmptyCall(r) {
  return r.status === 'ok' && !r.genTokens && !r.promptTokens && !r.thinkTokens;
}
function saveRequest(r) {
  requests.push(r);
  if (requests.length > MAX_IN_MEMORY) requests.shift();
  try { fs.appendFileSync(REQ_FILE, JSON.stringify(r) + '\n'); } catch (e) { lastError = 'save failed: ' + e.message; }
}

// ---------- polling Ollama's API ----------
function poll() {
  getJson('/api/ps', function (err, d) {
    if (err) {
      online = false; loaded = []; prevLoaded = null; lastError = 'Ollama not reachable at ' + OLLAMA_URL + ' (' + err.message + ')';
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
  const r = { id: rec.id, start: rec.start, end: end, model: rec.model || 'unknown', endpoint: rec.endpoint,
              status: aborted ? 'aborted' : (rec.status === 200 && !rec.error ? 'ok' : 'error'),
              error: rec.error || (rec.status && rec.status !== 200 ? 'HTTP ' + rec.status : null),
              genTokens: null, genMs: null, promptTokens: null, promptMs: null, loadMs: null,
              ttftMs: rec.firstAt ? rec.firstAt - rec.start : null, totalMs: end - rec.start,
              thinkTokens: rec.think || null, measured: false };
  if (f) {   // native API: Ollama's own timings (nanoseconds)
    r.genTokens = num(f.eval_count); r.genMs = nsToMs(f.eval_duration);
    r.promptTokens = num(f.prompt_eval_count); r.promptMs = nsToMs(f.prompt_eval_duration);
    r.loadMs = nsToMs(f.load_duration);
    if (num(f.total_duration)) r.totalMs = nsToMs(f.total_duration);
    if (r.ttftMs == null) r.ttftMs = (r.loadMs || 0) + (r.promptMs || 0);
  } else {   // OpenAI-compatible API or cut-off stream: timings measured by the proxy
    r.measured = true;
    r.genTokens = u && num(u.completion_tokens) != null ? u.completion_tokens : (rec.tokens || null);
    r.promptTokens = u ? num(u.prompt_tokens) : null;
    if (rec.firstAt && rec.lastAt > rec.firstAt) r.genMs = rec.lastAt - rec.firstAt;
  }
  r.genTps = r.genTokens && r.genMs ? r.genTokens / (r.genMs / 1000) : null;
  r.promptTps = r.promptTokens && r.promptMs ? r.promptTokens / (r.promptMs / 1000) : null;
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
      return res.end(JSON.stringify({ error: 'AI_SCOPE relay: unknown host name (see AI_SCOPE_ALLOWED_HOSTS)' }));
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

// ---------- state for the UI ----------
function currentRequest() {
  const ids = Object.keys(inflight);
  if (!ids.length) return null;
  const rec = inflight[ids[ids.length - 1]], now = Date.now();
  let liveTps = null;
  if (rec.times.length >= 2 && now - rec.lastAt < 3000) {
    const span = (rec.times[rec.times.length - 1] - rec.times[0]) / 1000;
    if (span > 0) liveTps = (rec.times.length - 1) / span;
  }
  let phase = rec.firstAt ? rec.phase : 'prompt';
  if (!rec.firstAt && rec.model && online && !loaded.some(function (m) { return m.name === rec.model; })) phase = 'loading';
  return { model: rec.model || 'unknown', endpoint: rec.endpoint, phase: phase, elapsedMs: now - rec.start,
           tokens: rec.tokens, thinkTokens: rec.think, liveTps: liveTps, othersRunning: ids.length - 1 };
}
function average() {
  const done = requests.filter(function (r) { return r.genTps; });
  if (!done.length) return null;
  const model = done[done.length - 1].model;
  const rs = done.filter(function (r) { return r.model === model; }).slice(-20);
  let tok = 0, ms = 0;
  rs.forEach(function (r) { tok += r.genTokens; ms += r.genMs; });
  return { model: model, requests: rs.length, genTps: ms ? tok / (ms / 1000) : null };
}
// vram: hwstats.vramInfo() (card sizes); Ollama can split a model across cards.
function getState(limit, vram) {
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
    current: currentRequest(), average: average(), directUse: directUse,
    // Ollama's model process(es) (Windows): VRAM / GPU % per card, CPU %, RAM; null elsewhere or with no model loaded
    process: online ? procstats.get('ollama') : null, processSupported: procstats.supported(),
    totalRequests: requests.length, rows: requests.slice(-(limit || 100)).reverse(),
  };
}

// settings: { url, proxyPort }
let timer = null;
let requestsLoaded = false;
function start(settings) {
  stop();
  settings = settings || {};
  OLLAMA_URL = String(settings.url || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  UP = new URL(OLLAMA_URL);
  PROXY_PORT = parseInt(settings.proxyPort, 10) || 11435;
  proxy = { host: PROXY_HOST, port: PROXY_PORT, listening: false, error: null };
  tagsAt = 0;
  if (!requestsLoaded) { requestsLoaded = true; loadRequests(); }
  startProxy();
  procstats.watch('ollama', [+(UP.port || (UP.protocol === 'https:' ? 443 : 80))], MODEL_PROCS);
  poll();
  timer = setInterval(poll, 2000);
}
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  procstats.unwatch('ollama');
  if (proxySrv) { try { proxySrv.close(); if (proxySrv.closeAllConnections) proxySrv.closeAllConnections(); } catch (e) {} proxySrv = null; }
  proxy = { host: PROXY_HOST, port: PROXY_PORT, listening: false, error: null };
  online = false; loaded = []; lastError = null;
}

module.exports = { start: start, stop: stop, getState: getState };
