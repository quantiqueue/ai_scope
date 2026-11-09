// Strata stats (https://github.com/Niko1221/Strata), read from the Strata desktop app OR from a headless CLI engine.
//  - The app's local host (default http://127.0.0.1:47831) polls its engine and hands the numbers to its own
//    Monitor screen as GET /api/native -> instances[].metrics. We read the same JSON: no key, read-only.
//    (It's the app's internal API, not a documented one, so every field is optional here.)
//  - AI_SCOPE-109: `strata launch` runs the same engine with no desktop host. Its OWN /metrics is the very object
//    the app stores as instances[].metrics, so the CLI path wraps /metrics in a synthetic instance and reuses
//    every mapping below: the request store, the rings, the Performance Mirror Lenses and the Hardware Mirror
//    Lenses are shared. Desktop-only faces (installed models, catalog fit, the Control version, the loading /
//    unloading status words) are recorded absent, never invented. Mode / CLI URL / key are scope settings.
//  - live state (phase, tok/s, prompt progress, context), the loaded model (context, KV mode, experts in VRAM),
//    finished requests (prompt / reused / output tokens, tok/s, first token, expert hit rate, duration),
//    installed models with Strata's own "fits on this PC" verdict.
//  - finished requests are saved to ~/.ai_scope/strata-requests.jsonl (Strata keeps them only in memory),
//    with our whole-PC peak load while each ran.
// Settings (app URL, CLI URL, key, mode) come from the scope's install settings in start(). No dependencies; conservative JS.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
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
// AI_SCOPE-109: `strata launch` serves its engine on 8080 unless the profile says otherwise
// (strata_cli/launch/settings.py: DEFAULT_PORT = 8080). A plain llama-server build defaults to the SAME port,
// so a CLI candidate is only ours when /health answers service: "strata" (see pickCli).
const DEFAULT_CLI = 'http://127.0.0.1:8080';
const DISCOVER_MS = 10000;    // re-read Strata's launch profiles / ready files on this clock, not every 2 s poll
const PROBE_MS = 10000;       // re-check /health (and look for another instance) while one is being used
const STATUS_MS = 10000;      // GET /v1/status (engine version, the run's `started` stamp)
const REQ_ALL_EVERY = 5;      // ?requests=all every Nth poll, like the desktop host's own habit
const LOAD_STALE_MS = 20 * 60 * 1000;   // a launch host's state file only words "Loading…" for this long (078's prep phase ran ~81 s; a big model can run minutes)
const MODES = ['auto', 'app', 'cli'];   // the scope's Source picker (scopes.json offers the same three words)
const REQ_FILE = paths.file('strata-requests.jsonl');
const reqstore = require('./reqstore');            // AI_SCOPE-094 slice 1: the shared history store
const reqstats = require('./reqstats');            // AI_SCOPE-094 slice 3: the shared average builder
const ggufmeta = require('./ggufmeta');            // AI_SCOPE-098 review: GGUF header provenance (HF repo, size label)

let appBase = DEFAULT_URL;   // the desktop app's own host (/api/native)
let base = DEFAULT_URL;      // whichever source answered last - the page shows it as `url`
let cliConfigured = '';      // the "Strata CLI URL" setting ('' = discover from Strata's own files, else :8080)
let apiKey = '';             // the optional key for a headless launch that has one (sent as Authorization: Bearer)
let mode = 'auto';           // the scope's Source picker: auto | app | cli
let timer = null;
let busy = false;
let online = false;
let keyNeeded = false;       // AI_SCOPE-109: reachable, but /metrics wants a key we were not given - not "off"
let lastError = null;
let native = null;          // last good answer in the app's container shape (the CLI path builds one synthetically)
let source = null;          // 'app' | 'cli' - which one fed `native`
let attestState = 'off';    // the last state told to procstats, so the page can word it ('needskey' is ours)
let fetchedAt = 0;
// ---------- the headless CLI's own state (AI_SCOPE-109) ----------
let cli = null;             // { url, port, health, metrics, status, stamp, proven, telemetryOnly }
let cliUrls = [];           // candidate origins, in probe order
let cliDiscoverAt = 0, cliProbeAt = 0, cliStatusAt = 0, reqPoll = 0;
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

// GET <base><p> -> cb(err, json, headers). AI_SCOPE-109: the headless engine only answers /metrics and
// /v1/status with its key, so the bearer token rides when one is set, and a non-200 keeps its status code
// (401 is the "Strata needs a key" signal, not an offline one). Every call here is a GET: AI_SCOPE never
// writes to Strata.
function getJson(b, p, timeout, auth, cb) {
  let u;
  try { u = new URL(b + p); } catch (e) { return cb(e); }
  const headers = { accept: 'application/json' };
  if (auth) headers.authorization = 'Bearer ' + auth;
  const req = http.get({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, timeout: timeout,
                         headers: headers }, function (res) {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', function (d) { if (body.length < 4000000) body += d; });
    res.on('end', function () {
      if (res.statusCode !== 200) { const e = new Error('HTTP ' + res.statusCode); e.status = res.statusCode; return cb(e, null, res.headers); }
      try { cb(null, JSON.parse(body), res.headers); } catch (e) { cb(new Error('not JSON - is this Strata?'), null, res.headers); }
    });
  });
  req.on('timeout', function () { req.destroy(new Error('timeout')); });
  req.on('error', function (e) { cb(e); });
}
function portOf(u) {
  try { const x = new URL(String(u)); return +x.port || (x.protocol === 'https:' ? 443 : 80); } catch (e) { return 0; }
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
    // AI_SCOPE-109: which face of Strata answered - the Requests lens shows it as its own Source column.
    // Rows saved before this ticket carry neither, so that column reads a gap for them (never a guess).
    source: inst.source || 'app', srcPort: num(inst.port) || null,
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

// ---------- headless CLI: candidate discovery and the claim test (AI_SCOPE-109) ----------
// Only what Strata's own CLI files say about PORTS and STATES. Two of its files are never opened here: the
// runtime state file (it carries the runtime control token) and a profile's source_config run config (a run
// config can carry an api_key). A ready file carries no secret: instance id, pid, bound host/port, model id.
function strataAppData() { return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'); }
function strataLocalData() { return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'); }
function readJsonFile(f) {
  try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); return d && typeof d === 'object' ? d : null; } catch (e) { return null; }
}
// A wildcard or loopback bind host is reached on loopback (AI_SCOPE runs on the same PC as `strata launch`);
// an explicit LAN host is used as given (that is a launch the user pointed at their network, and its key is
// the user's to enter in this scope's settings).
function cliOrigin(host, port) {
  const h = String(host == null ? '' : host).trim().replace(/^\[(.*)\]$/, '$1');
  const local = !h || h === '::' || h === '0.0.0.0' || h === '*' || h === 'localhost' || h === '::1' || /^127\./.test(h);
  return 'http://' + (local ? '127.0.0.1' : h) + ':' + port;
}
const cliReady = {};          // url -> { stamp, instanceId } from Strata's ready files (the port it really bound)
function discoverCli() {
  const urls = [], seen = {};
  const add = function (u) { if (u && !seen[u]) { seen[u] = 1; urls.push(u); } };
  if (cliConfigured) { add(cliConfigured); return urls; }   // an explicit CLI URL is the user's answer: no guessing
  try {
    const dir = path.join(strataLocalData(), 'Strata', 'runtime');
    fs.readdirSync(dir).forEach(function (n) {
      if (!/^launch-.*\.ready\.json$/.test(n)) return;   // launch profiles only: the desktop app's engine rides the app path
      const r = readJsonFile(path.join(dir, n));
      const p = num(r && r.bound_port) || portOf(r && r.api_url);
      if (!p) return;
      const u = (r.api_url && /^https?:\/\//.test(r.api_url) && !/^0\.0\.0\.0|::$/.test(String(r.bound_host || '')))
        ? String(r.api_url).replace(/\/+$/, '') : cliOrigin(r.bound_host, p);
      if (num(r.created_at) != null) cliReady[u] = { stamp: Math.round(r.created_at), instanceId: r.instance_id || null };
      add(u);
    });
  } catch (e) { /* no runtime folder: nothing discovered */ }
  try {
    const dir = path.join(strataAppData(), 'Strata', 'profiles');
    fs.readdirSync(dir).forEach(function (n) {
      if (!/^launch-.*\.json$/.test(n)) return;
      const p = readJsonFile(path.join(dir, n));
      const o = p && p.overrides;
      const port = num(o && o.port);
      if (!port || port < 1 || port > 65535) return;
      add(cliOrigin(o.host, port));
    });
  } catch (e) { /* no profiles folder */ }
  add(DEFAULT_CLI);   // a plain `strata launch` with no saved profile
  return urls;
}
// The one claim test: llama.cpp answers /health too, so ONLY its own words make a server ours.
// (The mirror rule on the other side is in llamacppstats.js: isLlama refuses a server whose /props names Strata.)
function pickCli(cb) {
  const now = Date.now();
  if (!cliUrls.length || now - cliDiscoverAt > DISCOVER_MS) { cliUrls = discoverCli(); cliDiscoverAt = now; }
  if (cli && now - cliProbeAt < PROBE_MS) { cb(true); return; }   // still fresh: no /health probe this cycle
  const list = cliUrls.slice(0, 6);
  const at = cli ? list.indexOf(cli.url) : -1;
  if (at > 0) { list.splice(at, 1); list.unshift(cli.url); }      // keep the one we use at the front
  const use = function (u, health) {
    cli = { url: u, port: portOf(u) || 80, health: health, metrics: cli && cli.url === u ? cli.metrics : null,
            status: cli && cli.url === u ? cli.status : null, stamp: cli && cli.url === u ? cli.stamp : null,
            proven: true, telemetryOnly: false };
    cliProbeAt = Date.now();
    base = u;
    return true;
  };
  let i = 0;
  (function next() {
    if (i >= list.length) { cli = null; return cb(false); }
    const u = list[i++];
    getJson(u, '/health', 1500, null, function (err, d) {
      if (!err && d && d.service === 'strata') { use(u, d); return cb(true); }
      next();
    });
  })();
}
// The run's stamp, for a request-dedupe id that survives a poll but changes when the server restarts.
// /metrics' totals.since is set once, in Service.__init__ ("since the server started", server.py:4826-4827),
// so it is already in the FIRST answer: the id can never change underneath the rows we have saved.
// /v1/status' started and the ready file's created_at are the fallbacks (the telemetry shape carries since too).
function cliStamp() {
  if (cli.stamp != null) return cli.stamp;
  const t = cli.metrics && cli.metrics.totals ? num(cli.metrics.totals.since) : null;
  const s = cli.status ? num(cli.status.started) : null;
  const r = cliReady[cli.url];
  const v = t != null ? Math.round(t) : (s != null ? Math.round(s) : (r ? r.stamp : null));
  if (v != null) cli.stamp = v;
  return v;
}
function cliInstanceId() {
  const s = cliStamp();
  return 'cli-' + cli.port + '-' + (s != null ? s : 'unknown');
}
// /v1/telemetry is the shape a read-only telemetry key opens; it is a LOSSY re-shape of /metrics
// (serve/server.py:7871-7874 -> strata_cli/client.py normalize_legacy): no per-request hit rate, no drafts,
// no prompt progress or context fill for the live request, no engine.info fields. The faces it cannot answer
// are recorded n/a here so the page can say which, instead of inventing them (the 072 rule).
const TEL_NA_LIST = ['Current request: prompt read / prompt total / generated / elapsed / context',
  'Context tile: live and held fill', 'Hit rate tile', 'Requests: Cached (partial), First token, Hit Rate',
  'Loaded model: KV cache, experts in VRAM, free VRAM, speculation', 'Drafts', 'Installed models'];
function telToMetrics(t) {
  const model = t.model || {}, work = t.work || {}, rates = t.rates || {}, inst = t.instance || {};
  const slots = Array.isArray(work.slots) ? work.slots.filter(function (s) { return s && s.state !== 'idle'; })[0] || null : null;
  const live = { state: !model.loaded ? 'unloaded'
      : work.active ? (rates.answer_tok_s != null ? 'generating' : 'reading')
      : 'idle',
    queued: num(work.queued), phase: null, running: num(work.active),
    prompt_tokens: slots ? num(slots.prompt_tokens) : null, prompt_read: slots ? num(slots.prompt_read) : null,
    prompt_total: null, generated: slots ? num(slots.generated) : null, max_tokens: null,
    elapsed_s: slots ? num(slots.elapsed_s) : null, tok_s: rates.answer_tok_s, prefill_tok_s_mean: rates.prefill_tok_s_mean };
  const totals = t.totals || {};
  return { engine: { model: model.id || null, max_context: num(model.context), version: null },
           live: live, requests: Array.isArray(t.recent) ? t.recent : [],
           totals: { since: num(totals.since), requests: num(totals.requests), prompt_tokens: num(totals.prompt_tokens),
                     reused: null, output_tokens: num(totals.output_tokens), drafts_offered: null, drafts_accepted: null },
           started: num(inst.boot_time) };
}
function cliContainer() {
  const m = cli.metrics || {};
  const eng = m.engine || {}, live = m.live || {}, h = cli.health || {};
  const model = eng.model || h.model || null;
  const loaded = h.loaded === true || (live.state && live.state !== 'unloaded');
  const inst = {
    id: cliInstanceId(), source: 'cli', port: cli.port,
    label: model || 'Strata CLI', model: model,
    status: loaded ? 'ready' : 'unloaded', phase: live.state || (loaded ? 'idle' : 'unloaded'),
    metrics: m, context: num(eng.max_context) || num(h.max_context), parallel: num(m.engine && m.engine.batch),
    loadedAt: null, error: null, gpus: null,   // null = this face never names devices (AI_SCOPE-120); NOT "no GPU"
  };
  return { instances: [inst], defaultId: inst.id, source: 'cli',
           engineInfo: { version: (cli.status && cli.status.engine) || eng.version || null },
           installed: null };
}
function cliFetchMetrics(done) {
  reqPoll++;
  const p = '/metrics' + (reqPoll % REQ_ALL_EVERY === 0 ? '?requests=all' : '');
  getJson(cli.url, p, 3000, apiKey || null, function (err, d) {
    if (!err && d && typeof d === 'object' && (d.live || d.engine || d.requests)) {
      keyNeeded = false; cli.telemetryOnly = false; cli.metrics = d;
      return applyContainer(cliContainer(), 'cli', done);
    }
    if (err && err.status === 401) {
      if (!apiKey) { keyNeeded = true; return cliKeyNeeded(done); }
      return cliFetchTelemetry(done);        // our key may be the read-only telemetry key
    }
    if (cli.status && num(cli.status.started) != null && cli.stamp == null) cli.stamp = Math.round(cli.status.started);
    cliUnreachable(err, done);
  });
}
function cliFetchTelemetry(done) {
  getJson(cli.url, '/v1/telemetry', 3000, apiKey, function (err, d) {
    if (!err && d && typeof d === 'object' && d.rates) {
      cli.telemetryOnly = true; keyNeeded = false; cli.metrics = telToMetrics(d);
      if (num(cli.metrics.started) != null && cli.stamp == null) cli.stamp = Math.round(cli.metrics.started);
      return applyContainer(cliContainer(), 'cli', done);
    }
    keyNeeded = true;                        // a key is set and neither endpoint opens: say so plainly
    cliKeyNeeded(done);
  });
}
// Reachable, but the key we need was not given: a clear state of its own, never "Strata is not running",
// and no attested zeros (the model may well be loaded - we simply cannot read it). The watch stays armed,
// so the Hardware Mirror Lenses still answer with real readings wherever the process family is findable.
function cliKeyNeeded(done) {
  online = false; native = null; source = null;
  attestState = 'needskey';
  procstats.unattest('strata');
  procstats.watch('strata', cliWatchPorts(), MODEL_PROCS, { tree: true });
  lastError = 'Strata\'s CLI is running at ' + cli.url + ' but its API needs a key. Put it in this scope\'s "Strata API key" setting.';
  done();
}
function cliWatchPorts() {
  const out = [];
  if (cli && cli.proven) out.push(cli.port);
  Object.keys(cliReady).forEach(function (u) { const p = portOf(u); if (p) out.push(p); });
  return out;
}
function cliUnreachable(err, done) {
  const fam = procstats.family('strata');
  const wasOn = online;
  online = false; native = null; source = null; keyNeeded = false;
  const ports = cliWatchPorts();
  procstats.watch('strata', ports, MODEL_PROCS, { tree: true });   // name anchors: the load window
  cli = null;
  // Nothing answers on the port, yet Strata is at work. Two honest readings, both made WITHOUT asking
  // Strata to do anything (the 082 rule: a state we could only learn by making the app work is recorded
  // absent, never probed):
  //  - a Strata-named process family exists (procstats' tree watch anchors on strata.exe /
  //    strata-vision.exe, which work while the port is still unborn);
  //  - Strata's OWN supervisor says a `launch-<name>` host is up and has not written a ready file yet,
  //    which is exactly the load window: the port is bound only after the engine is set up
  //    (serve/server.py:10387). Read as file names and mtimes only - never its contents, which hold the
  //    runtime control token.
  if ((fam && fam.pids.length) || launchStarting()) {
    attestState = 'loading';
    procstats.attest('strata', 'loading');
    lastError = wasOn ? 'Strata\'s CLI stopped answering at ' + (base || 'its port') : null;
    return done();
  }
  attestState = 'off';
  procstats.attest('strata', 'off');
  lastError = err && err.status ? 'Strata CLI: HTTP ' + err.status : err ? err.message : 'no Strata server answered';
  done();
}
// The load-window signal above. True only while a fresh state file exists with no ready file beside it:
// a leftover from a host killed long ago ages out (LOAD_STALE_MS) instead of saying "Loading…" forever.
function launchStarting() {
  const dir = path.join(strataLocalData(), 'Strata', 'runtime');
  const now = Date.now();
  let names = null;
  try { names = fs.readdirSync(dir); } catch (e) { return false; }
  for (let i = 0; i < names.length; i++) {
    const m = /^(launch-[^.]+)\.json$/.exec(names[i]);
    if (!m) continue;                                     // only launch profiles: the app's own engines ride the app path
    let st;
    try { st = fs.statSync(path.join(dir, names[i])); } catch (e) { continue; }
    if (now - st.mtimeMs > LOAD_STALE_MS) continue;       // an old leftover of a lost host
    const pre = m[1] + '-';
    if (names.some(function (k) { return k.indexOf(pre) === 0 && /\.ready\.json$/.test(k); })) continue;   // already serving
    return true;
  }
  return false;
}
function cliStatusFetch() {
  if (!cli || Date.now() - cliStatusAt < STATUS_MS) return;
  cliStatusAt = Date.now();
  getJson(cli.url, '/v1/status', 2000, apiKey || null, function (err, d) {
    if (err || !d || typeof d !== 'object') return;
    cli.status = d;
    cli.proven = true;
    const s = num(d.started);
    // The stamp is set ONCE and never revised: request rows are keyed by it, and a stamp that moved
    // between /metrics' totals.since and /v1/status' started (they are taken a second apart in the
    // server's own startup) would save the same requests twice.
    if (s != null && cli.stamp == null) cli.stamp = Math.round(s);
  });
}
function pollCli(done) {
  if (!cli || Date.now() - cliProbeAt > PROBE_MS) {
    return pickCli(function (found) {
      if (!found) return cliUnreachable(null, done);
      cli.proven = true;
      cliStatusFetch();
      cliFetchMetrics(done);
    });
  }
  cliStatusFetch();
  cliFetchMetrics(done);
}

// ---------- polling ----------
// One cycle answers from one source (AI_SCOPE-109). mode 'app' = the desktop host only, 'cli' = the headless
// engine only, 'auto' (default) = the desktop host first, the CLI if nothing answers there - so a user who
// runs only one face never has to choose, and one who swaps between them sees whichever is up.
function poll() {
  if (busy) return;
  busy = true;
  const done = function () { busy = false; };
  if (mode === 'cli') return pollCli(done);
  getJson(appBase, '/api/native', 3000, null, function (err, d) {
    if (!err && d && Array.isArray(d.instances)) { base = appBase; source = 'app'; return applyContainer(d, 'app', done); }
    if (mode === 'app') {
      online = false; native = null; source = null; keyNeeded = false; attestState = 'off';
      procstats.attest('strata', 'off');   // AI_SCOPE-077 review: offline attestation lets procstats write honest zero history
      lastError = err ? (err.code === 'ECONNREFUSED' ? 'Strata app not running at ' + appBase : err.message) : 'unexpected answer - is this the Strata app?';
      return done();
    }
    lastError = err ? (err.code === 'ECONNREFUSED' ? 'Strata app not running at ' + appBase : err.message) : 'unexpected answer - is this the Strata app?';
    pollCli(done);
  });
}
function applyContainer(d, src, done) {
  fetchedAt = Date.now();
  online = true; lastError = null; native = d; keyNeeded = false; source = src;
  if (src === 'cli') cli.proven = true;
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
      // AI_SCOPE-109: a headless engine that is up with NO model loaded answers /metrics and /health
      // (loaded:false, live.state 'unloaded') - the honest word is 'idle', the desktop's own word for
      // "nothing loaded" (its app lists no instance then). Never 'live' with an empty engine.
      else if (ins.status === 'unloaded' && state === 'live') state = 'idle';
    }
  }
  attestState = state;
  procstats.attest('strata', state);
  // 077 review batch 3: always watch, even with no engine port - during a model LOAD (or unload) the
  // engine strata.exe is already running hot while the API reports no instance yet and the port is not
  // LISTENING either. procstats then finds strata.exe by its (app-specific) exe name, so the mirror
  // tiles show the real load-time I/O / CPU / RAM instead of idle zeros.
  // AI_SCOPE-080: tree mode extends that to the whole Strata process tree (anchors + descendants +
  // ancestry) - the 078 capture showed the runner process does not even exist for the first ~80 s of
  // a load; its parent chain is what works in that window, and it is safe to count because a
  // strata-named child proves the tree belongs to Strata.
  // AI_SCOPE-109 headless: the same rule. The port joins the watch only once /health or one of Strata's
  // own ready files proved it, so an unrelated llama-server on 8080 is never claimed as ours (105's
  // router lesson: a port is only attribution when the app itself named it).
  procstats.watch('strata', src === 'cli' ? cliWatchPorts() : enginePorts, MODEL_PROCS, { tree: true });
  collectRequests(d.instances);
  cliStatusFetch();
  if ((!logo.light || !logo.dark) && Date.now() - logo.tried > 60000) fetchLogos();
  done();
}
// Strata's own mark for the tab, served by the running app (the UI falls back to its icon otherwise).
// strata-mark-light.svg has dark bars (for light backgrounds), strata-mark-dark.svg light bars (for dark ones).
// AI_SCOPE-109: /brand is the desktop host's, not the headless engine's - ask the app URL whatever the
// scope is currently reading numbers from, and stay on the catalog icon when the app is not running.
function fetchLogos() {
  logo.tried = Date.now();
  [['light', '/brand/strata-mark-light.svg'], ['dark', '/brand/strata-mark-dark.svg']].forEach(function (v) {
    let u;
    try { u = new URL(appBase + v[1]); } catch (e) { return; }
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
// AI_SCOPE-098 review: find the model's GGUF shard 1 under Strata's own data folder, so the
// Installed lens can show the Hugging Face repo the FILE names (general.repo_url). Strata lays
// models out as <dataFolder>\models\<DIR>\*.gguf; DIR matched to the variant id by suffix run,
// and a shard 1 is only accepted when a GGUF name confirms the same quant tail - the mmproj
// sidecar lives in the same folder and carries the ORG's repo_url, never the model's.
const shardCache = {};
function modelShard(dataFolder, variant) {
  if (!dataFolder || !variant) return null;
  const ck = String(dataFolder).toLowerCase() + '|' + String(variant).toLowerCase();
  if (ck in shardCache) return shardCache[ck];
  let found = null;
  try {
    const v = String(variant).toLowerCase();
    const root = path.join(String(dataFolder), 'models');
    const dirs = fs.readdirSync(root, { withFileTypes: true }).filter(function (e) { return e.isDirectory(); });
    for (const d0 of dirs) {
      const dl = d0.name.toLowerCase();
      const tail = v.slice(Math.max(0, v.lastIndexOf('-') + 1));
      const head = v.slice(0, Math.max(0, v.lastIndexOf('-')));
      let okDir = dl === v || dl === tail || dl === head || (tail.length >= 4 && dl.slice(-tail.length) === tail);
      if (!okDir) continue;
      let files = [];
      try { files = fs.readdirSync(path.join(root, d0.name)); } catch (e) { continue; }
      const ggufs = files.filter(function (f) { return /\.gguf$/i.test(f); });
      // quant must appear as its own token in the file name (an IQ1_M folder must not accept a mmproj BF16)
      const qm = /((?:UD-)?(?:I?Q\d+(?:_[A-Z0-9]+)+|I?Q\d+|BF16|F16|F32))$/i.exec(tail);
      if (qm) {
        const qre = new RegExp('(?:^|[-_.])' + qm[1] + '(?:[-_.]|$)', 'i');
        if (!qre.test(ggufs.join(' '))) continue;
      }
      const first = ggufs.filter(function (f) { return /-00001-of-\d+\.gguf$/i.test(f); })[0];
      const whole = first || (dl === v && ggufs.length === 1 ? ggufs[0] : null);   // lone un-split file only on an exact folder match
      if (!whole) continue;
      found = path.join(root, d0.name, whole);
      break;
    }
  } catch (e) { found = null; }
  shardCache[ck] = found;
  return found;
}
// AI_SCOPE-120: three answers, not two. null = this Strata face reports no device list at all (the headless
// CLI: /metrics and /v1/telemetry name no cards) - the cell must not claim CPU placement. An empty array is
// Strata's own answer, "this model uses no card", so it stays a real list.
function gpuNames(d, indexes) {
  if (indexes == null) return null;
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
  // AI_SCOPE-109: which face of Strata answered. `state` is the same word the mirror tiles were told, so
  // the card and the tiles can never disagree about what Strata is doing; `na` names the lens faces the
  // telemetry key cannot answer, instead of the page guessing.
  out.mode = mode;
  out.source = source;
  out.state = keyNeeded ? 'needskey' : (online ? attestState : (attestState === 'loading' || attestState === 'needskey' ? attestState : 'off'));
  out.keyNeeded = keyNeeded;
  out.appUrl = appBase;
  out.cliUrl = cliConfigured || (cli ? cli.url : null);
  out.port = source === 'cli' && cli ? cli.port : null;
  out.telemetryOnly = !!(cli && cli.telemetryOnly);
  if (out.telemetryOnly) out.na = TEL_NA_LIST;
  out.installedOnlyApp = source === 'cli';   // installed models / catalog fit are the desktop app's, never the engine's
  // Strata's model process(es): VRAM / GPU % per card, CPU %, RAM; null elsewhere or with no model loaded.
  // AI_SCOPE-072: processCards (Hardware card names / totals for the tile labels) and processHistory (5 min,
  // newest last) join the answer, and all of it stays in the payload when Strata itself is offline - the GPU /
  // VRAM tiles draw their histories right through an "Inactive" stretch. AI_SCOPE-073: the history points also
  // carry the process's ram / ramPrivate for the Strata RAM lens (per-process RAM exists on macOS / Linux too,
  // so that lens is not gated on per-process GPU support).
  out.process = procstats.get('strata'); out.processSupported = procstats.supported();
  out.processHistory = procstats.history('strata', since);   // AI_SCOPE-084: ?since=<t> sends only the new points
  out.processCards = hwstats.getStats().info.gpus.map(function (g) { return { name: g.name, vramTotal: g.vramTotal, source: g.source }; });
  // AI_SCOPE-121 (strata.cost lens): the GPU energy attributed to Strata's process family since this server
  // booted (watt-seconds) and the 5-minute ring of estimated watts. The whole (small) ring rides every answer,
  // like the 093 rings; the $/kWh price is NOT baked in here - it is a Settings → General number the page
  // applies at draw time, so re-pricing re-prices the session honestly.
  out.cost = procstats.cost('strata');
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
  // AI_SCOPE-109: a headless engine answering with NO model loaded (before the first load, or after an
  // idle unload) is not a loaded model - its row stays out of the Loaded / Current / Context faces,
  // while its finished requests and totals still come from the same instance. The desktop app never
  // reports this status, so the app path is untouched.
  const shown = !!inst && inst.status !== 'unloaded';
  if (shown) {
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
      // AI_SCOPE-100 (D4): the live record joins 094's canonical names - generated -> outputTokens,
      // tok_s -> genTps, prefill mean -> promptTps. phase / phaseText stay Strata's own words (080).
      out.current = {
        model: out.loaded.label, phase: inst.phase, phaseText: live.phase || null, queued: num(live.queued),
        promptTokens: prompt, promptRead: num(live.prompt_read), promptTotal: num(live.prompt_total),
        outputTokens: gen, maxTokens: num(live.max_tokens), elapsedMs: num(live.elapsed_s) != null ? live.elapsed_s * 1000 : null,
        genTps: num(live.tok_s), promptTps: num(live.prefill_tok_s_mean),
        contextUsed: prompt != null ? prompt + (gen || 0) : null, contextMax: ctxMax,
      };
    }
  }
  if (inst) {
    const t = m.totals;
    if (t) out.totals = { since: num(t.since) != null ? t.since * 1000 : null, requests: num(t.requests),
                          promptTokens: num(t.prompt_tokens), cachedTokens: num(t.reused), outputTokens: num(t.output_tokens),
                          draftsOffered: num(t.drafts_offered), draftsAccepted: num(t.drafts_accepted) };
    // AI_SCOPE-093 slice 3: the context tile's big number. Live while a request runs (the card's own contextUsed);
    // idle is the last-seen held fill, claimed ONLY while the same instance id is still loaded - Strata keeps its
    // KV cache between requests (that is why the next one reuses millions of tokens), but an unload or a loaded
    // model change makes the held number stale, and then the honest answer is no answer.
    const cMax = num(eng.max_context) || num(inst.context);
    if (shown && out.current && out.current.contextUsed != null) out.contextState = { used: out.current.contextUsed, max: cMax || null, model: out.current.model, at: fetchedAt, live: true };
    else if (shown && ctxLast && ctxLast.id === inst.id) out.contextState = { used: ctxLast.v, max: cMax || null, model: inst.label || ctxLast.m, at: ctxLast.t, live: false };
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
    // AI_SCOPE-098 (D3): publisher = the catalog family title as the floor; the model file's own
    // GGUF header (general.repo_url / quantized_by / size_label) overrides it with the real HF
    // repo and gives an honest params label - Strata's catalog carries none of that itself.
    const q = /(?:^|[-_.])((?:UD-)?(?:I?Q\d+(?:_[A-Z0-9]+)*|BF16|F16|F32))(?:[-_.]|$)/i.exec(String(x.model || ''));
    const dispName = c ? c.family.title + ' ' + c.size.model : (x.model_name || x.model);
    const shard = modelShard(x.dataFolder, x.model);
    const hm = shard ? ggufmeta.header(shard) : null;
    const repo = hm && hm.repoUrl ? String(hm.repoUrl).trim().split(/\s+/)[0] : null;   // repo_url can list several space-separated
    const hf = repo && /huggingface\.co\//i.test(repo) ? repo : null;
    const pub = hf ? decodeURIComponent(hf.replace(/^https?:\/\/huggingface\.co\//i, '').split('/')[0]) : (c ? (c.family.title || null) : null);
    return {
      variant: x.model, name: dispName,
      publisher: pub || null,
      publisherUrl: (function () { const om = hf ? /^https?:\/\/[^/]+\/[^/]+/i.exec(hf) : null; return om ? om[0] : null; })(),
      modelUrl: hf || null,
      quant: q ? q[1].replace(/^UD-/, '').toUpperCase() : null,
      features: x.images === 'yes' ? ['vision'] : [],   // 098: the shared Features cell reads records, not per-scope flags
      diskGb: num(x.diskGb), size: Math.round((num(x.diskGb) || 0) * 1e9) || null,
      context: num(x.context), ready: !!x.ready, images: x.images === 'yes',
      loaded: (d.instances || []).some(function (i) { return i.model === x.model && i.status === 'ready'; }),
      memoryGb: c ? num(c.size.memory_gb) : null, onThisPc: c ? c.size.on_this_pc || null : null,
      fitSummary: rec ? rec.summary || null : null, missingParts: num(x.partsMissing),
      gguf: shard || null
    };
  });
  // AI_SCOPE-099 (user review 2026-11-02): Strata's engine-instances answer carries no quant and no
  // size, but her installed list does - for this exact variant, matched by the same model key that
  // sets that row's own loaded flag (:407). Copy HER numbers onto the loaded record: one source, an
  // identity join the app itself defines, no second measurement and no guessing. Params stays a gap:
  // her catalog carries no token count (the 098 rule).
  if (out.loaded && inst) {
    const row = out.installed.find(function (x) { return x.variant === inst.model; });
    if (row) { out.loaded.quant = row.quant; out.loaded.size = row.size; }
  }
  return out;
}

function start(settings) {
  stop();
  settings = settings || {};
  // AI_SCOPE-109: the desktop host URL stays `url`; the headless launch gets its own URL, its own optional
  // key, and the scope's Source picker (auto / app / cli). A key is the user's to give: this scope never
  // reads one out of Strata's own files.
  appBase = String(settings.url || DEFAULT_URL).replace(/\/+$/, '');
  cliConfigured = String(settings.cliUrl || '').trim().replace(/\/+$/, '');
  apiKey = String(settings.apiKey || '').trim();
  mode = MODES.indexOf(settings.mode) >= 0 ? settings.mode : 'auto';
  base = appBase;
  cli = null; cliUrls = []; cliDiscoverAt = 0; cliProbeAt = 0; cliStatusAt = 0; reqPoll = 0;
  source = null; attestState = 'off'; keyNeeded = false;
  Object.keys(cliReady).forEach(function (k) { delete cliReady[k]; });
  loadRequests();          // the store ignores a second load (AI_SCOPE-094 slice 1)
  poll();
  timer = setInterval(poll, 2000);
}
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  procstats.unwatch('strata');
  procstats.unattest('strata');   // 077 review: an uninstalled scope stops claiming history
  online = false; native = null; lastError = null; keyNeeded = false; source = null; cli = null;
}

module.exports = { start: start, stop: stop, getState: getState, getLogo: getLogo,
  // the llama.cpp precedent (098 review): _test exposes the shipped helpers for probes
  // AI_SCOPE-109: the headless pieces too - the mock Strata probe drives discoverCli / telToMetrics /
  // cliContainer without any Strata running.
  _test: { modelShard: modelShard, catalogEntry: catalogEntry, discoverCli: discoverCli, cliOrigin: cliOrigin,
    portOf: portOf, telToMetrics: telToMetrics, cliContainer: cliContainer, cliInstanceId: cliInstanceId,
    gpuNames: gpuNames,   // AI_SCOPE-120: the three-state device mapping, probeable without a running app
    setConfig: function (s) { start(s); }, setApiKey: function (v) { apiKey = String(v || '').trim(); },
    setCliConfigured: function (v) { cliConfigured = String(v || '').trim().replace(/\/+$/, ''); },
    setCli: function (v) { cli = v; }, setUrls: function (v) { cliUrls = v.slice(); cliDiscoverAt = Date.now(); },
    setMode: function (v) { mode = MODES.indexOf(v) >= 0 ? v : 'auto'; },
    live: function () { return { source: source, state: attestState, keyNeeded: keyNeeded, cli: cli, urls: cliUrls.slice(), online: online, error: lastError }; } } };
