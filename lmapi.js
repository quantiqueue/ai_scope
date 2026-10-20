// LM Studio model status from its REST API: installed models + loaded instances.
// Uses /api/v1/models (LM Studio 0.4+), falls back to /api/v0/models.
// Port: LMSTUDIO_URL env, else tries 1234, then 1235. No dependencies; conservative JS.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------- where each model came from (Hugging Face repo / LM Studio hub) ----------
// LM Studio stores downloads as <models>/<publisher>/<repo>/<file>, where publisher/repo is the Hugging Face repo.
// Folders are set from the scope's install settings in start().
let MODEL_DIRS = [];
let HUB_DIR = null;
let repos = [];          // [{ owner, repo }]
let reposAt = 0;
function listDirs(d) {
  try { return fs.readdirSync(d).filter(function (n) { try { return fs.statSync(path.join(d, n)).isDirectory(); } catch (e) { return false; } }); }
  catch (e) { return []; }
}
function scanRepos() {
  reposAt = Date.now();
  const out = [];
  MODEL_DIRS.forEach(function (root) {
    listDirs(root).forEach(function (owner) {
      listDirs(path.join(root, owner)).forEach(function (repo) {
        let mtime = 0;   // newest model file in the repo folder = when it was downloaded
        try { fs.readdirSync(path.join(root, owner, repo)).forEach(function (f) {
          try { const st = fs.statSync(path.join(root, owner, repo, f)); if (st.isFile() && st.mtimeMs > mtime) mtime = st.mtimeMs; } catch (e) {}
        }); } catch (e) {}
        out.push({ owner: owner, repo: repo, modified: mtime || null });
      });
    });
  });
  repos = out;
}
function norm(s) { return String(s || '').toLowerCase().replace(/[-_.](gguf|mlx)(-\w+)?$/, ''); }
function sourceFor(m) {
  const pub = m.publisher || '';
  const keyName = String(m.key || '').split('/').pop();
  const hfPub = pub ? 'https://huggingface.co/' + encodeURIComponent(pub) : null;
  // Model from LM Studio's own catalog (hub): link to its page there.
  const manifest = HUB_DIR ? path.join(HUB_DIR, pub, keyName, 'manifest.json') : null;
  if (pub && manifest && fs.existsSync(manifest)) {
    let mod = null;
    try { mod = fs.statSync(manifest).mtimeMs; } catch (e) {}
    return { modified: mod, modelUrl: 'https://lmstudio.ai/models/' + encodeURIComponent(pub) + '/' + encodeURIComponent(keyName),
             publisherUrl: hfPub, source: 'LM Studio catalog' };
  }
  const mine = repos.filter(function (r) { return r.owner.toLowerCase() === pub.toLowerCase(); });
  const k = norm(keyName);
  let hit = mine.filter(function (r) { return norm(r.repo) === k; })[0] ||
            mine.filter(function (r) { const n = norm(r.repo); return n.indexOf(k) === 0 || k.indexOf(n) === 0; })[0] ||
            (mine.length === 1 ? mine[0] : null);
  if (hit) return { modified: hit.modified, modelUrl: 'https://huggingface.co/' + encodeURIComponent(hit.owner) + '/' + encodeURIComponent(hit.repo),
                    publisherUrl: 'https://huggingface.co/' + encodeURIComponent(hit.owner), source: 'Hugging Face' };
  return { modified: null, modelUrl: null, publisherUrl: hfPub, source: null };
}

const AUTO_URLS = ['http://127.0.0.1:1234', 'http://127.0.0.1:1235'];
let CANDIDATES = AUTO_URLS;

let base = null;
let online = false;
let apiVersion = null;
let lastError = null;
let models = [];          // installed models, normalized
let raw = null;           // last raw response (for /api/lmstudio/raw debugging)
let lastLoadedKeys = '';

function getJson(url, cb) {
  const req = http.get(url, { timeout: 3000 }, function (res) {
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

// Pull a value out of an instance config whatever its exact shape ({key: v} or [{key, value}]).
function cfgValue(cfg, names) {
  if (!cfg) return null;
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (cfg[n] != null && typeof cfg[n] !== 'object') return cfg[n];
  }
  const fields = Array.isArray(cfg) ? cfg : Array.isArray(cfg.fields) ? cfg.fields : null;
  if (fields) for (let j = 0; j < fields.length; j++) {
    const f = fields[j] || {};
    const k = String(f.key || '');
    for (let i = 0; i < names.length; i++) if (k === names[i] || k.split('.').pop() === names[i]) return f.value;
  }
  return null;
}

function normV1(d) {
  return (d.models || []).map(function (m) {
    const caps = m.capabilities || {};
    const q = m.quantization;
    return {
      key: m.key, name: m.display_name || m.key, publisher: m.publisher || null, type: m.type || null,
      arch: m.architecture || null, params: m.params_string || null,
      quant: q ? (typeof q === 'string' ? q : q.name) : null, size: num(m.size_bytes),
      maxContext: num(m.max_context_length), format: m.format || null,
      vision: !!caps.vision, tools: !!caps.trained_for_tool_use, reasoning: !!caps.reasoning,
      instances: (m.loaded_instances || []).map(function (ins) {
        const cfg = ins.config || ins.load_config || ins;
        let gpu = cfgValue(cfg, ['gpu_offload_ratio', 'gpuOffloadRatio', 'gpu_offload', 'ratio', 'offload_ratio']);
        if (gpu && typeof gpu === 'object') gpu = num(gpu.ratio);
        return {
          id: ins.id || ins.identifier || ins.instance_id || m.key,
          context: num(cfgValue(cfg, ['context_length', 'contextLength', 'n_ctx'])),
          gpuRatio: typeof gpu === 'number' ? gpu : (gpu === 'max' ? 1 : null),
          ttlMs: num(ins.ttl_ms || ins.ttlMs),
          flashAttention: typeof cfg.flash_attention === 'boolean' ? cfg.flash_attention : null,
          kvOnGpu: typeof cfg.offload_kv_cache_to_gpu === 'boolean' ? cfg.offload_kv_cache_to_gpu : null,
          parallel: num(cfg.parallel),
        };
      }),
    };
  });
}
function normV0(d) {
  return (d.data || []).map(function (m) {
    return {
      key: m.id, name: m.id, publisher: m.publisher || null, type: m.type || null, arch: m.arch || null,
      params: null, quant: m.quantization || null, size: null, maxContext: num(m.max_context_length),
      format: m.compatibility_type || null, vision: m.type === 'vlm',
      tools: (m.capabilities || []).indexOf('tool_use') >= 0, reasoning: false,
      instances: m.state === 'loaded' ? [{ id: m.id, context: num(m.loaded_context_length), gpuRatio: null, ttlMs: null }] : [],
    };
  });
}

function tryBase(list, i, cb) {
  if (i >= list.length) return cb(new Error('LM Studio server not reachable (tried ' + list.join(', ') + ')'));
  getJson(list[i] + '/api/v1/models', function (err, d) {
    if (!err && d && d.models) return cb(null, list[i], 'v1', d);
    getJson(list[i] + '/api/v0/models', function (err2, d2) {
      if (!err2 && d2 && d2.data) return cb(null, list[i], 'v0', d2);
      tryBase(list, i + 1, cb);
    });
  });
}

function poll() {
  const list = base ? [base].concat(CANDIDATES.filter(function (c) { return c !== base; })) : CANDIDATES;
  tryBase(list, 0, function (err, b, ver, d) {
    if (err) { online = false; lastError = err.message; models = []; return; }
    base = b; online = true; apiVersion = ver; lastError = null; raw = d;
    models = ver === 'v1' ? normV1(d) : normV0(d);
    if (Date.now() - reposAt > 60000) scanRepos();
    models.forEach(function (m) { const s = sourceFor(m); m.modelUrl = s.modelUrl; m.publisherUrl = s.publisherUrl; m.source = s.source; m.modified = s.modified; });
    const keys = models.filter(function (m) { return m.instances.length; }).map(function (m) { return m.key; }).join(',');
    if (keys !== lastLoadedKeys) { lastLoadedKeys = keys; console.log('[lmstudio] loaded: ' + (keys || 'none')); }
  });
}

function getState(vramTotal) {
  const loaded = [];
  models.forEach(function (m) {
    m.instances.forEach(function (ins) {
      loaded.push({ id: ins.id, key: m.key, name: m.name, modelUrl: m.modelUrl, params: m.params, quant: m.quant, size: m.size,
                    context: ins.context, maxContext: m.maxContext, gpuRatio: ins.gpuRatio, ttlMs: ins.ttlMs, type: m.type,
                    flashAttention: ins.flashAttention, kvOnGpu: ins.kvOnGpu, parallel: ins.parallel });
    });
  });
  return {
    online: online, url: base, apiVersion: apiVersion, error: lastError, vramTotal: vramTotal || null,
    loaded: loaded,
    installed: models.map(function (m) {
      let fit = null;
      if (vramTotal && m.size) fit = m.size <= vramTotal * 0.8 ? 'fits' : m.size <= vramTotal ? 'tight' : 'spills';
      return { key: m.key, name: m.name, publisher: m.publisher, modelUrl: m.modelUrl, publisherUrl: m.publisherUrl, source: m.source, modified: m.modified, type: m.type, arch: m.arch, params: m.params,
               quant: m.quant, size: m.size, maxContext: m.maxContext, vision: m.vision, tools: m.tools,
               reasoning: m.reasoning, loaded: m.instances.length > 0, fit: fit };
    }).sort(function (a, b) { return (b.loaded - a.loaded) || ((b.size || 0) - (a.size || 0)); }),
  };
}
function getRaw() { return raw; }

// settings: { url (empty = auto-detect), home (LM Studio folder), modelsDir (empty = <home>/models) }
let timer = null;
function start(settings) {
  settings = settings || {};
  const home = settings.home || path.join(os.homedir(), '.lmstudio');
  MODEL_DIRS = [settings.modelsDir || path.join(home, 'models'), path.join(home, 'apps', 'bionic', '.internal', 'bundled-models')];
  HUB_DIR = path.join(home, 'hub', 'models');
  CANDIDATES = settings.url ? [settings.url] : AUTO_URLS;
  base = null; reposAt = 0;
  stopTimer();
  poll(); timer = setInterval(poll, 10000); // each poll adds 2 lines to LM Studio's server log
}
function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
function stop() { stopTimer(); online = false; base = null; models = []; raw = null; lastError = null; lastLoadedKeys = ''; }

module.exports = { start: start, stop: stop, getState: getState, getRaw: getRaw };
