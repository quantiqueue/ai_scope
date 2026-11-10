// ComfyUI stats: current job (queue + step progress from ComfyUI's terminal log) and
// completed runs (from /history), saved to ~/.ai_scope/comfy-runs.jsonl so they survive ComfyUI restarts.
// No dependencies; conservative JS for older Node versions.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const hwstats = require('./hwstats');
const vramFit = hwstats.vramFit;  // VRAM fit vs the largest card
const procstats = require('./procstats');   // ComfyUI's own GPU/VRAM/CPU/RAM (Windows; AI_SCOPE-038)
const reqstats = require('./reqstats');      // AI_SCOPE-130: the shared provenance vocabulary + the Days buckets (128's shape)

const AUTO_URLS = ['http://127.0.0.1:8188', 'http://127.0.0.1:8000'];
let CANDIDATES = AUTO_URLS;   // set from the scope's install settings in start()
const paths = require('./paths');                       // data folder: ~/.ai_scope
const RUNS_FILE = paths.file('comfy-runs.jsonl');
const MAX_RUNS_IN_MEMORY = 1000;

let base = null;            // detected ComfyUI URL
let online = false;
// AI_SCOPE-130 (128's D2, applied to this scope by 129 for Ollama): is that ComfyUI on THIS PC? Only a local one
// has processes AI_SCOPE can measure, so a reachable server on another machine is worded "on another PC - not
// measurable here" by the GPU cost lenses instead of "ComfyUI Offline" - and never shows a number.
let local = false;
let lastError = null;
let current = null;         // in-flight job
let pending = 0;
let runs = [];              // newest last
const known = {};           // prompt_id -> true (already saved)

// ---------- helpers ----------
function getJson(url, timeout, cb) {
  const req = http.get(url, { timeout: timeout || 4000 }, function (res) {
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

// AI_SCOPE-121 (D9), carried to this scope by AI_SCOPE-130: energyVer stamps WHICH measurement produced an energy
// figure, so a corrected apportionment can never leave half-numbers mixed into history. Every saved line whose
// stamp is not the current one loses its energy fields on read (the jsonl is never rewritten - 094's append-only
// rule), so raising the version retires yesterday's figures without a migration. Same number as Strata's (121),
// Bionic's (127) and llama.cpp's (128): the measurement is the same accrual, keyed to this scope's family.
const ENERGY_VER = 2;
// Read-side map for every line in comfy-runs.jsonl. ComfyUI's store predates reqstore (094) and never renamed a
// field, so today this map is the D9 retirement alone; it is NAMED anyway (the 121 / 128 / 129 precedent) so a
// probe can put saved lines through the shipped read path without the app, its routes or its file.
function mapRunRow(r) {
  if (r.energyWs != null && r.energyVer !== ENERGY_VER) { delete r.energyWs; delete r.energyPartial; }
  return r;
}

function loadRuns() {
  paths.ensure();
  let text = '';
  try { text = fs.readFileSync(RUNS_FILE, 'utf8'); } catch (e) { return; }
  text.split(/\r?\n/).forEach(function (l) {
    if (!l.trim()) return;
    // 130: the line goes through the named map before the identity check, so the D9 retirement runs on the
    // shipped load path for every scope that reads this file.
    try { const r = mapRunRow(JSON.parse(l)); if (!known[r.id]) { known[r.id] = true; runs.push(r); } } catch (e) { /* skip bad line */ }
  });
  runs.sort(function (a, b) { return (a.end || 0) - (b.end || 0); });
  // 130: trimmed IN PLACE, never re-assigned, so the array handed to a probe by the _test surface stays the live
  // ring - the same identity rule the shared 094 store follows. Keeps the newest rows, as the old slice did.
  if (runs.length > MAX_RUNS_IN_MEMORY) runs.splice(0, runs.length - MAX_RUNS_IN_MEMORY);
}

function saveRun(r) {
  known[r.id] = true;
  // Whole-PC peak GPU/VRAM/CPU/RAM while it ran (only if AI_SCOPE was sampling then).
  if (r.peak === undefined) r.peak = hwstats.peakBetween(r.start, r.end ? r.end + 2000 : null);
  runs.push(r);
  if (runs.length > MAX_RUNS_IN_MEMORY) runs.shift();
  try { fs.appendFileSync(RUNS_FILE, JSON.stringify(r) + '\n'); } catch (e) { lastError = 'save failed: ' + e.message; }
}

// AI_SCOPE-130 (121's save-time stamping, the 128 / 129 shape - not 127's read-time attach): the energy this run
// asked of the cards, integrated over the WHOLE run [start, end] (ComfyUI's own execution_start / execution_success
// stamps: sampling and every other node, never the checkpoint load that happened before the job was queued), from
// the SAME accrual the two Cost lenses and the mirror tiles ride, keyed to the app family 'comfyui'. 083's watch is
// one family (the python.exe owner of ComfyUI's port + its whole descendant tree), so there is no per-model split to
// choose - as in 129's Ollama note, one accrual prices the tiles, the two lenses and every Runs row.
// Stored as JOULES, priced at draw time; a run whose window no accrued chunk covers gets no field (a gap, never a
// zero); one reaching back past the trail is a floor and says so; provenance estimated (board power is a device
// measurement). A history item with no execution_start message has no window to integrate, so it stays a gap too.
function attachEnergy(row) {
  if (!row || row.start == null || row.end == null) return;
  const en = procstats.energyBetween('comfyui', row.start, row.end);
  if (!en || en.n <= 0) return;                     // nothing measured inside the window: no fields, a gap
  row.energyWs = Math.round(en.ws * 10) / 10;
  if (en.partial) row.energyPartial = true;
  row.energyVer = ENERGY_VER;                       // 121 D9: which measurement produced these joules
  reqstats.setProv(row, 'energyWs', reqstats.PROV.ESTIMATED);
}
// Save a few seconds after the run reaches /history so the 2 s samples covering its tail exist (the 121/128/129
// save rule). The wait is load-bearing here, not inherited decoration: a chunk is charged when procstats
// AGGREGATES the sample that ends it, which can land after ComfyUI wrote the history entry - integrating at that
// moment would lose up to one 2 s pace of the tail. ComfyUI has no save wait of its own today (fetchHistory used
// to append synchronously), so this adds one, exactly as 129's D3 did for Ollama. Accepted consequence: a finished
// run appears in the Runs table (and in the Installed models lens's Runs / Last used / Avg columns) about 3 s later
// than before. Equal-delay FIFO timers fire in creation order and fetchHistory schedules runs already sorted by end,
// so the ring still receives them in end order.
function later(row) {
  setTimeout(function () {
    attachEnergy(row);   // AI_SCOPE-130
    saveRun(row);
  }, 3000);
}

// ---------- workflow summary (model, sampler, size...) from the API-format graph ----------
function scalar(v) { return v != null && typeof v !== 'object' ? v : null; }
function baseName(p) { return p ? String(p).replace(/\\/g, '/').split('/').pop().replace(/\.(safetensors|ckpt|gguf|pt|pth|bin|sft)$/i, '') : null; }

function summarize(graph) {
  const s = { models: [], loras: [], steps: null, cfg: null, sampler: null, scheduler: null, seed: null,
              width: null, height: null, batch: null, nodes: 0 };
  if (!graph || typeof graph !== 'object') return s;
  Object.keys(graph).forEach(function (id) {
    const n = graph[id];
    if (!n || typeof n !== 'object') return;
    s.nodes++;
    const ct = String(n.class_type || '');
    const inp = n.inputs || {};
    ['ckpt_name', 'unet_name', 'model_name'].forEach(function (k) {
      const v = scalar(inp[k]);
      if (v && s.models.indexOf(baseName(v)) < 0) s.models.push(baseName(v));
    });
    if (scalar(inp.lora_name) && s.loras.indexOf(baseName(inp.lora_name)) < 0) s.loras.push(baseName(inp.lora_name));
    if (/sampler/i.test(ct) || inp.steps != null) {
      if (s.steps == null && typeof scalar(inp.steps) === 'number') s.steps = inp.steps;
      if (s.cfg == null && typeof scalar(inp.cfg) === 'number') s.cfg = inp.cfg;
      if (s.sampler == null && scalar(inp.sampler_name)) s.sampler = inp.sampler_name;
      if (s.scheduler == null && scalar(inp.scheduler)) s.scheduler = inp.scheduler;
      const seed = scalar(inp.seed) != null ? inp.seed : scalar(inp.noise_seed);
      if (s.seed == null && seed != null) s.seed = seed;
    }
    if (typeof scalar(inp.width) === 'number' && typeof scalar(inp.height) === 'number' &&
        (s.width == null || /latent/i.test(ct))) {
      s.width = inp.width; s.height = inp.height;
      if (typeof scalar(inp.batch_size) === 'number') s.batch = inp.batch_size;
    }
  });
  return s;
}

// History/queue items: [number, prompt_id, graph, extra_data, outputs_to_execute] (array) - be defensive.
function graphOf(promptField) {
  if (Array.isArray(promptField)) return promptField[2];
  if (promptField && typeof promptField === 'object') return promptField.prompt || promptField.graph || null;
  return null;
}

function historyToRun(id, h) {
  const st = h.status || {};
  const msgs = st.messages || [];
  let start = null, end = null, error = null, interrupted = false;
  msgs.forEach(function (m) {
    const type = m[0], d = m[1] || {};
    if (type === 'execution_start') start = d.timestamp;
    if (type === 'execution_success') end = d.timestamp;
    if (type === 'execution_error') { end = d.timestamp; error = (d.node_type ? d.node_type + ': ' : '') + (d.exception_message || 'error'); }
    if (type === 'execution_interrupted') { end = d.timestamp; interrupted = true; }
  });
  const images = [];
  const outputs = h.outputs || {};
  Object.keys(outputs).forEach(function (nid) {
    const o = outputs[nid] || {};
    (o.images || o.gifs || []).forEach(function (im) {
      if (im && im.filename) images.push({ filename: im.filename, subfolder: im.subfolder || '', type: im.type || 'output' });
    });
  });
  return {
    id: id,
    start: start, end: end,
    durationMs: start && end ? end - start : null,
    status: error ? 'error' : interrupted ? 'interrupted' : (st.status_str || (st.completed ? 'success' : 'unknown')),
    error: error,
    summary: summarize(graphOf(h.prompt)),
    images: images.slice(0, 8),
    imageCount: images.length,
  };
}

// ---------- step progress from ComfyUI's terminal log (tqdm bars) ----------
// e.g. " 45%|####5     | 9/20 [00:04<00:05,  2.10it/s]"  or  "Remesh DC:  10%|#  | 3/29 [00:02<00:14,  1.82it/s]"
const RE_TQDM = /(?:([A-Za-z][^\r\n%|]{0,40}?):\s*)?(\d+)%\|[^|\r\n]*\|\s*(\d+)\/(\d+)\s*\[([\d:]+)<([\d:?]+)(?:,\s*([\d.]+|\?)\s*(it\/s|s\/it))?/g;

function parseLogTime(t) {
  // Python isoformat() local time, maybe with microseconds: trim to milliseconds.
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?/.exec(t || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] || '0').padEnd(3, '0')).getTime() : null;
}

function readProgress(sinceMs, cb) {
  getJson(base + '/internal/logs/raw', 4000, function (err, data) {
    if (err || !data || !data.entries) return cb(null);
    const entries = data.entries.slice(-40);
    let best = null;
    for (let i = entries.length - 1; i >= 0 && !best; i--) {
      const e = entries[i];
      const t = parseLogTime(e.t);
      if (sinceMs && t && t < sinceMs - 2000) break; // older than this job
      let m, last = null;
      RE_TQDM.lastIndex = 0;
      while ((m = RE_TQDM.exec(e.m || ''))) last = m;
      if (last) {
        const rate = last[7] && last[7] !== '?' ? +last[7] : null;
        best = {
          label: last[1] ? last[1].trim() : null,
          value: +last[3], max: +last[4],
          itPerSec: rate == null ? null : (last[8] === 's/it' ? 1 / rate : rate),
          remaining: last[6] && last[6] !== '?' ? last[6] : null,
          at: t,
        };
      }
    }
    cb(best);
  });
}

// ---------- polling ----------
function detect(cb) {
  let i = 0;
  (function next() {
    if (i >= CANDIDATES.length) return cb(false);
    const url = CANDIDATES[i++].replace(/\/$/, '');
    getJson(url + '/queue', 2000, function (err) {
      if (!err) { base = url; applyLocal(url); procstats.watch('comfyui', portsOf([url])); return cb(true); }   // 130: local follows the URL actually chosen
      next();
    });
  })();
}

let busy = false;
// ---------- Hardware Mirror Lens attestation (AI_SCOPE-083; family rules: ~/ai-scope-terminology.md) ----------
// Kickoff decision 2A: two states, read straight from ComfyUI's own answers - nothing invented.
//  live - reachable. Deliberately also while no job runs: unlike every other app scope, an idle ComfyUI keeps
//         its last checkpoint resident in VRAM (its cache does not free when a job ends), so attesting 'idle'
//         would write heartbeat zeros over a real multi-GB holding - a false zero. procstats' real samples are
//         the only history writer then; a missed process lookup stays a gap + n/a, never a fake dip.
//  off  - unreachable (detect / /queue failure): zeros, sub "ComfyUI Offline". This finally unarms the key while
//         the app is down - the root fix 091 only patched around (the last never-attesting key until now).
// 'idle' is not attested (the residency above); 'loading' is invisible outside a running job - the load happens
// inside a prompt already in queue_running, where the real 2 s samples cover it; 'unloading' has no state API;
// 'failed' arrives only in /history after the job left the queue, so a one-cycle attestation would be synthetic.
// All recorded absent, not invented (the 081 / 082 precedent).
function mirrorState() { return online ? 'live' : 'off'; }
function poll() {
  if (busy) return;
  busy = true;
  const done = function () { busy = false; procstats.attest('comfyui', mirrorState()); };   // AI_SCOPE-083: attest each cycle (llamacppstats.js pattern)
  if (!base) {
    return detect(function (ok) {
      online = ok; if (!ok) { current = null; pending = 0; lastError = 'ComfyUI not reachable on ' + CANDIDATES.join(', '); }
      done();
    });
  }
  getJson(base + '/queue', 3000, function (err, q) {
    if (err) { online = false; base = null; current = null; pending = 0; lastError = 'ComfyUI not reachable (' + err.message + ')'; return done(); }
    online = true; lastError = null;
    if (Date.now() - modelsAt > 60000) fetchModels();   // installed models: refresh every minute
    const running = (q.queue_running || [])[0];
    pending = (q.queue_pending || []).length;
    const prevId = current && current.id;
    if (!running) {
      current = null;
      if (prevId) fetchHistory(); // a job just finished
      return done();
    }
    const id = running[1];
    if (!current || current.id !== id) {
      if (prevId) fetchHistory();
      current = { id: id, number: running[0], firstSeen: Date.now(), summary: summarize(graphOf(running)), progress: null };
    }
    readProgress(current.firstSeen, function (p) {
      if (current && current.id === id && p) current.progress = p;
      done();
    });
  });
}

let histBusy = false;
function fetchHistory() {
  if (!base || histBusy) return;
  histBusy = true;
  getJson(base + '/history?max_items=50', 8000, function (err, h) {
    histBusy = false;
    if (err || !h) return;
    const items = Object.keys(h).map(function (id) { return historyToRun(id, h[id]); })
      .filter(function (r) { return !known[r.id] && r.end; })
      .sort(function (a, b) { return a.end - b.end; });
    // AI_SCOPE-130: the run is claimed (known) BEFORE the 3 s wait is started, otherwise the 10 s /history timer
    // would schedule a second copy of the same run while the first is still waiting - saveRun used to be the only
    // place this id was claimed. Then each run goes through the shipped save wait.
    items.forEach(function (r) { known[r.id] = true; later(r); });
  });
}

// ---------- installed models (/experiment/models: name, size, dates per model folder) ----------
const SKIP_FOLDERS = { configs: 1, custom_nodes: 1, datasets: 1 };
const FIT_FOLDERS = { checkpoints: 1, diffusion_models: 1, text_encoders: 1 };
let models = [];
let modelsAt = 0;
let modelsBusy = false;
const metaCache = {};      // folder|file|modified -> { publisher } from the file's safetensors metadata

// Publisher from the safetensors header (via ComfyUI's /view_metadata). Most files have none.
function fillMetadata(list, done) {
  let i = 0;
  (function next() {
    while (i < list.length && (metaCache[list[i].metaKey] || !/\.safetensors$/i.test(list[i].file))) {
      const c = metaCache[list[i].metaKey];
      if (c) list[i].publisher = c.publisher;
      i++;
    }
    if (i >= list.length || !base) return done();
    const m = list[i++];
    getJson(base + '/view_metadata/' + encodeURIComponent(m.folder) + '?filename=' + encodeURIComponent(m.file), 5000, function (err, md) {
      const meta = (!err && md && typeof md === 'object') ? md : {};
      const pub = meta['modelspec.author'] || meta['modelspec.publisher'] || meta.author || meta.publisher || null;
      metaCache[m.metaKey] = { publisher: pub ? String(pub).slice(0, 80) : null };
      m.publisher = metaCache[m.metaKey].publisher;
      next();
    });
  })();
}

function fetchModels() {
  if (!base || modelsBusy) return;
  modelsBusy = true;
  modelsAt = Date.now();
  getJson(base + '/experiment/models', 5000, function (err, roots) {
    if (err || !Array.isArray(roots)) { modelsBusy = false; return; }
    const list = roots.filter(function (r) { return r && r.name && !SKIP_FOLDERS[r.name]; });
    const seen = {}, out = [];
    let i = 0;
    (function next() {
      if (i >= list.length) {
        models = out;   // show the list right away, then add publishers
        return fillMetadata(out, function () { modelsBusy = false; });
      }
      const root = list[i++];
      getJson(base + '/experiment/models/' + encodeURIComponent(root.name), 8000, function (e, files) {
        if (!e && Array.isArray(files)) files.forEach(function (f) {
          // Some folder types are aliases of others (e.g. unet_gguf = diffusion_models): keep each file once.
          const dir = (root.folders || [])[f.pathIndex] || String(f.pathIndex);
          const full = (dir + '\\' + f.name).replace(/\//g, '\\').toLowerCase();
          if (seen[full]) return;
          seen[full] = true;
          out.push({ file: f.name, name: baseName(f.name), folder: root.name, publisher: null,
                     metaKey: root.name + '|' + f.name + '|' + f.modified,
                     size: typeof f.size === 'number' ? f.size : null,
                     modified: typeof f.modified === 'number' ? f.modified * 1000 : null });
        });
        next();
      });
    })();
  });
}

// vram: hwstats.vramInfo() (card sizes). ComfyUI keeps a model on one card, so no 'fits across N GPUs'.
function getModels(vram) {
  // How often each model / LoRA was used in the saved runs.
  const use = {};
  runs.forEach(function (r) {
    const s = r.summary || {};
    (s.models || []).concat(s.loras || []).forEach(function (n) {
      const u = use[n] || (use[n] = { runs: 0, last: 0, okMs: 0, okN: 0 });
      u.runs++;
      if (r.end > u.last) u.last = r.end;
      if (r.status === 'success' && r.durationMs && (s.models || []).indexOf(n) >= 0) { u.okMs += r.durationMs; u.okN++; }
    });
  });
  return {
    online: online, refreshedAt: modelsAt || null, vramTotal: vram ? vram.largest : null, vramCards: vram ? vram.cards.length : 0,
    models: models.map(function (m) {
      const u = use[m.name];
      const f = FIT_FOLDERS[m.folder] ? vramFit(m.size, vram, false) : null;
      const fit = f ? f.fit : null;
      return { file: m.file, name: m.name, folder: m.folder, publisher: m.publisher, size: m.size, modified: m.modified, fit: fit,
               runs: u ? u.runs : 0, lastUsed: u ? u.last : null, avgMs: u && u.okN ? u.okMs / u.okN : null };
    }),
  };
}

// Port(s) ComfyUI listens on, for finding its process (procstats.js).
function portsOf(urls) {
  return urls.map(function (u) { try { const x = new URL(u); return +(x.port || (x.protocol === 'https:' ? 443 : 80)); } catch (e) { return 0; } })
    .filter(function (n) { return n > 0; });
}

// AI_SCOPE-130 (128's D2 rule, verbatim): is the URL we are talking to on this machine? Checked where `base` is
// chosen, so the flag can never disagree with the server a run came from. The same regex llamacppstats.js and
// ollamastats.js ship. (Named applyLocal, not setLocal: the _test setter at the foot of this file is setLocal.)
function applyLocal(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch (e) { /* ignore */ }
  local = /^(127\.|localhost$|\[?::1\]?$)/.test(host);
}

// settings: { url (empty = auto-detect 8188, then 8000) }
let timers = [];
let runsLoaded = false;
function start(settings) {
  stop();
  CANDIDATES = settings && settings.url ? [settings.url] : AUTO_URLS;
  if (!runsLoaded) { runsLoaded = true; loadRuns(); }
  procstats.watch('comfyui', portsOf(CANDIDATES));
  poll();
  timers.push(setInterval(poll, 2000));
  timers.push(setInterval(fetchHistory, 10000));
  timers.push(setTimeout(fetchHistory, 1500));
}
function stop() {
  timers.forEach(function (t) { clearInterval(t); clearTimeout(t); });
  timers = [];
  procstats.unwatch('comfyui');
  procstats.unattest('comfyui');   // AI_SCOPE-083: an uninstalled scope stops claiming history (like 081 / 082)
  base = null; online = false; current = null; pending = 0; lastError = null; local = false;   // 130: no base, no claim about where it was
}

// state for the page
// AI_SCOPE-083: since (AI_SCOPE-084 item 7) sends only processHistory points newer than it - the mirror lenses
// keep the ring on the client, so the 5-minute ring never rides the whole payload.
function getState(limit, since) {
  limit = limit || 100;
  const now = Date.now();
  // Avg seconds per run for the most recent model (successful runs only).
  let avg = null;
  const ok = runs.filter(function (r) { return r.status === 'success' && r.durationMs; });
  if (ok.length) {
    const lastModel = ok[ok.length - 1].summary.models.join(' + ');
    const same = ok.filter(function (r) { return r.summary.models.join(' + ') === lastModel; }).slice(-50);
    avg = { model: lastModel || 'unknown', avgMs: same.reduce(function (a, r) { return a + r.durationMs; }, 0) / same.length, runs: same.length };
  }
  return {
    online: online,
    url: base,
    local: local,          // AI_SCOPE-130 (the 128 D2 rule, as 129 applied it): another PC is reachable but unmeasurable
    error: lastError,
    pending: pending,
    current: current ? {
      id: current.id,
      summary: current.summary,
      elapsedMs: now - current.firstSeen,
      progress: current.progress,
    } : null,
    average: avg,
    // ComfyUI's own processes (Windows): VRAM / GPU % per card, CPU %, RAM; null elsewhere or if not found
    process: online ? procstats.get('comfyui') : null, processSupported: procstats.supported(),
    // AI_SCOPE-083: the Hardware Mirror Lens family - the 5-minute per-process ring (delta'd by since) and the
    // Hardware card names / totals, the shape ollamastats.js / llamacppstats.js send (081 / 082).
    processHistory: procstats.history('comfyui', since || 0),
    processCards: hwstats.getStats().info.gpus.map(function (g) { return { name: g.name, vramTotal: g.vramTotal, source: g.source }; }),
    // AI_SCOPE-130 (121's shape, as 128 / 129 send it): the session accrual for this family (the Activity tile's
    // live rate and the Total lens's "Session start") plus the per-day buckets built over the SAVED runs (the Total
    // lens's "Days"). Joules only - the $/kWh price is applied at draw time (121 D5), and the buckets count a run
    // with no energy as a miss, never as 0 Wh. This route has no offline early return, so both ride every payload.
    cost: procstats.cost('comfyui'),
    costDays: reqstats.costDayBuckets(runs),
    totalRuns: runs.length,
    runs: runs.slice(-limit).reverse(),
  };
}

// Proxy an output image (as a small webp preview) so remote browsers don't need direct access to ComfyUI.
function proxyImage(query, res) {
  if (!base) { res.writeHead(503); return res.end(); }
  const qs = 'filename=' + encodeURIComponent(query.get('filename') || '') +
             '&subfolder=' + encodeURIComponent(query.get('subfolder') || '') +
             '&type=' + encodeURIComponent(query.get('type') || 'output') +
             (query.get('full') ? '' : '&preview=' + encodeURIComponent('webp;70'));
  const req = http.get(base + '/view?' + qs, { timeout: 8000 }, function (r) {
    res.writeHead(r.statusCode, { 'Content-Type': r.headers['content-type'] || 'image/webp', 'Cache-Control': 'max-age=86400' });
    r.pipe(res);
  });
  req.on('timeout', function () { req.destroy(); });
  req.on('error', function () { try { res.writeHead(502); res.end(); } catch (e) {} });
}

module.exports = { start: start, stop: stop, getState: getState, getModels: getModels, proxyImage: proxyImage,
  _test: { summarize: summarize, historyToRun: historyToRun, RE_TQDM: RE_TQDM, parseLogTime: parseLogTime,
    // AI_SCOPE-130 (the 128 / 129 precedent): the energy stamp, the saved-run read map (the D9 retirement path),
    // the shipped save wait, the store and the live ring, plus the local flag - so a probe can put lines through
    // the real read/write path with no server, no ComfyUI and no timers left running. ComfyUI's store predates
    // reqstore (094) and its rows are RUNS, so the shipped names differ; mapReqRow / saveRequest are the aliases
    // the shared cost-shape suites drive.
    attachEnergy: attachEnergy, mapReqRow: mapRunRow, mapRunRow: mapRunRow, later: later, saveRequest: saveRun, saveRun: saveRun,
    loadRuns: loadRuns, energyVer: function () { return ENERGY_VER; },
    store: { load: loadRuns, append: saveRun, rows: function () { return runs; }, file: RUNS_FILE, max: MAX_RUNS_IN_MEMORY },
    requests: runs, runs: runs,
    isLocal: function () { return local; }, setLocal: function (v) { local = !!v; } } };
