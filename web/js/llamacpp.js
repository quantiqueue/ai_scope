// AI_SCOPE dashboard - llama.cpp scope (AI_SCOPE-006): current request, loaded model, slots, requests.
// Data: /api/llamacpp (llamacppstats.js polls the server's /props and /slots; no relay). The request history is
// built from those slot polls, so tok/s and durations are estimates (marked "≈").
// Every card/table is a lens (lens.js), so it can also be shown on custom scopes, more than once.

const lcK = n => n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
const lcCtx = n => n == null ? '—' : n % 1024 === 0 ? (n / 1024) + 'K' : lcK(n);
const LC_EXACT = 'Exact: from the server\'s own counters (--metrics), the request ran alone on its model';
const LC_EST = 'Estimated from AI_SCOPE\'s looks at the server\'s slots (every ½ s, ¼ s while busy; llama.cpp keeps no per-request timings)';
// AI_SCOPE-098: the Models folder as a LENS setting. The router lists unloaded models but never
// sends their paths, and AI_SCOPE cannot ask for --models-dir (auto-detect from the process command
// line was weighed at review and skipped as over-built), so the lens that shows files asks for the
// folder itself. The value rides the source poll URL (?md=); the server reads GGUF headers there,
// local servers only, and it overrides the scope card's Models folder when both are set.
const MODELS_DIR_FIELD = { id: 'modelsDir', label: 'Models folder', type: 'text', default: '',
  help: 'The folder given to --models-dir, so unloaded rows can show their real size, fit and Hugging Face link. Read on this PC only; leave empty to use the scope card value.' };

defineSource('llamacpp', '/api/llamacpp?limit=100', 'llamacpp', 1000, null, 'processHistory', 'modelsDir');   // AI_SCOPE-082 / 084: the mirror history ring goes out as a delta (?since=)

// AI_SCOPE-082: the Hardware Mirror Lens family for llama.cpp (GPU / RAM Working / RAM Committed / CPU / I/O over
// llama.cpp's own processes) comes from the shared defineMirror factory - web/js/mirror.js (077). The watch shape is
// the one llamacppstats.js has run since 006 (decision 1A: the server process plus the model children it owns, in
// router mode; a generic launcher parent is excluded by the name filter). Attestation is live / idle / off read
// from the server's own answers (decision 2A); 'loading' / 'unloading' / 'failed' are absent from llama.cpp's API
// as far as AI_SCOPE can see them without making a router load something, so they are recorded, not invented.
// Tile-id letter 'l' (<letter>gp / <letter>ram_ / <letter>cpu / <letter>io), kept clear of 's' (Strata), 'b'
// (Bionic) and 'o' (Ollama) so saved layouts resolve.
const LLAMACPP_MIRROR = defineMirror({ key: 'llamacpp', name: 'llama.cpp', letter: 'l' });

// ---------- Current request ----------
defineLens({
  id: 'llamacpp.current', scope: 'llamacpp', size: 'wide',
  name: 'Current request',
  description: 'What the llama.cpp server is answering right now: speed, tokens, prompt, context and the server process\'s GPU, VRAM, CPU and RAM use.',
  settings: [PROC_STATS_FIELD],
  markup: nowCardMarkup([
    { box:'tpsBox', label:'Current gen tok/s', labelK:'tpsLabel', k:'tps' },
    { box:'tokBox', label:'Tokens so far', k:'tok', small:true },
    { box:'promptBox', label:'Prompt', k:'prompt', small:true },
    { box:'ctxBox', label:'Context', k:'ctx', small:true, bar:'ctxBar' },
    { box:'timeBox', label:'Elapsed', k:'time' },
  ]),
  render(L, d) {
    const $ = L.$, list = d.current || [], show = (k, on) => { $(k).hidden = !on; };
    const boxes = ['tpsBox', 'tokBox', 'promptBox', 'ctxBox', 'timeBox'];
    // several slots can run at once: show the one that started last, count the others
    const cur = list.slice().sort((a, b) => a.elapsedMs - b.elapsedMs)[0] || null;
    $('dot').className = 'dot' + (cur ? ' live' : d.online ? '' : ' off');
    $('detail').textContent = '';
    if (!d.online) {
      $('title').textContent = d.needsKey ? 'llama.cpp server needs an API key' : 'llama.cpp server is not running';
      setName($('model'), ONONE);
      boxes.forEach(b => show(b, false));
      $('foot').textContent = d.error || '';
      setSysLoad($('load'), false);
    } else if (d.slotsEnabled === false) {
      $('title').textContent = 'Slots endpoint is off';
      setName($('model'), d.model ? d.model.name : ONONE);
      boxes.forEach(b => show(b, false));
      $('foot').textContent = 'The server was started with --no-slots, so AI_SCOPE can\'t see its requests. Start it without that option.';
      setSysLoad($('load'), false);
    } else if (cur) {
      const others = list.length - 1;
      $('title').textContent = 'Running — ' + (cur.phase === 'generating' ? 'generating' : 'reading prompt') +
        (others > 0 ? ' (+' + others + ' more slot' + (others > 1 ? 's' : '') + ' busy)' : '') +
        (cur.queued ? ' · ' + cur.queued + ' waiting for a free slot' : '');
      $('detail').textContent = 'slot ' + cur.slot;
      setName($('model'), cur.model);
      boxes.forEach(b => show(b, true));
      $('tpsLabel').textContent = cur.phase === 'generating' ? 'Current gen tok/s' : 'Reading prompt';
      $('tps').textContent = cur.phase === 'generating' ? (cur.tokS != null ? '≈ ' + fmtTps(cur.tokS) : '…') : '…';
      $('tps').title = cur.phase === 'generating' ? LC_EST : '';
      $('tok').textContent = fmtNum(cur.generated) + (cur.maxTokens ? ' / ' + lcK(cur.maxTokens) : '');
      $('prompt').textContent = lcK(cur.promptTokens) + (cur.cached ? ' (' + lcK(cur.cached) + ' cached)' : '');
      $('ctx').textContent = cur.contextUsed != null ? lcK(cur.contextUsed) + (cur.contextMax ? ' / ' + lcCtx(cur.contextMax) : '') : ONONE;
      $('ctxBar').style.width = cur.contextUsed != null && cur.contextMax ? Math.min(100, 100 * cur.contextUsed / cur.contextMax) + '%' : '0';
      $('time').textContent = fmtSec(cur.elapsedMs);
      $('foot').textContent = '';
      // the server's own process (llama.exe / llama-server.exe) when known (Windows); hidden on Windows without one
      // in router mode the busy model's own process, else the server's
      const pr = cur.process || d.process;
      setSysLoad($('load'), L.settings.procStats !== false && (!(d.processSupported && !pr)), pr, 'llama.cpp');
    } else {
      const a = d.average, m = d.model;
      $('title').textContent = !d.router && m && m.sleeping ? 'Sleeping — model unloaded until the next request' : 'Idle — no request running';
      const nLoaded = (d.models || []).filter(x => x.state === 'loaded').length;
      setName($('model'), d.router ? (nLoaded ? nLoaded + ' model' + (nLoaded > 1 ? 's' : '') + ' loaded' : 'no model loaded') : m ? m.name : ONONE);
      boxes.forEach(b => show(b, false));
      show('tpsBox', !!a);
      $('tpsLabel').textContent = a ? 'Avg gen tok/s (last ' + a.requests + ' requests)' : 'Avg gen tok/s';
      $('tps').textContent = a ? '≈ ' + fmtTps(a.genTps) : ONONE;
      $('tps').title = a ? LC_EST : '';
      $('foot').textContent = 'Send a message in the server\'s web chat (' + d.url + ') or a request to its API to see live stats.';
      setSysLoad($('load'), false);
    }
  },
});

// ---------- shared ----------
// lcVram lived here (050) - AI_SCOPE-099 moved the per-card VRAM cell into the shared Loaded
// engine as vramCell() in lens.js; the hint line uses the shared procVramText() like the others.
// ---------- Loaded in memory: the running model(s) (AI_SCOPE-099: the shared Loaded lens) ----------
// The uniform block plus llama.cpp's one exclusive (Since load). Rows carry their own measured
// process (082's per-model watch in router mode), so the VRAM column is per-model here by nature;
// lcVram / lcTotals moved into the shared engine (lens.js) and are gone from this file.
const LC_LOAD = {
  title: 'Loaded in memory',
  nameOf: m => m.name,
  plainCell: true,
  tipOf: m => m.path || null,
  tagOf: m => m.sleeping ? '<span class="tag">sleeping</span>' : '',
  quantField: 'ftype',
  slotsField: 'slots',
  sizeTitle: 'Weights on disk (the file size); the running context adds more',
  slotTitle: 'Parallel slots of this model',
  unloadWhy: 'llama.cpp keeps the model loaded until the server or router releases it',
  loadedWhy: 'The server reports no load timestamp',
  extra: ['since'],
  titleOf: (key, m) => key === 'context'
    ? (m.ctxTrain ? 'trained for ' + fmtNum(m.ctxTrain) + ' \u00b7 ' : '') + 'shared by all slots'
    : null
};
defineLens({
  id: 'llamacpp.loaded', scope: 'llamacpp', size: 'full',
  name: 'Loaded in memory',
  description: 'Models the llama.cpp server is running (in router mode, every loaded one): quantization, size, measured VRAM per card, context, slots, and since-load totals with --metrics.',
  settings: [PER_PAGE_FIELD],
  markup: loadedTableMarkup(LC_LOAD),
  render(L, d) {
    const $ = L.$, list = d.online ? (d.models || []).filter(m => m.state === 'loaded') : [];
    const opts = Object.assign({}, LC_LOAD, { count: list.length, solo: list.length === 1, proc: d.process, multi: list.length > 1 });
    $('rows').innerHTML = paginate(L.key, list.map(m => loadedRow(m, opts)), $('pager'), L.settings.perPage).join('');
    $('empty').hidden = list.length > 0;
    $('empty').textContent = !d.online ? (d.needsKey ? d.error : 'The llama.cpp server is offline. Start it (llama serve -m <model.gguf>, or llama-server) to see its model and requests.')
      : d.router ? 'No model loaded. The router loads one when a request names it' + (d.router.autoload ? '' : ' (autoload is off: load it in the web UI)') + '.' : 'No model information from the server.';
    $('hint').textContent = !d.online ? '' : d.router
      ? '— router · ' + list.length + ' of ' + (d.models || []).length + ' loaded' + (d.router.maxInstances ? ', up to ' + d.router.maxInstances + ' at once' : '') +
        (list.length > 1 && procVramText(d.process) ? ' \u00b7 ' + procVramText(d.process) : '')
      : (procVramText(d.process) ? '— ' + procVramText(d.process) : '');
  },
});

// ---------- Installed models: a router's models folder (AI_SCOPE-098: the shared Installed lens) ----------
// Gains the uniform Publisher (model ids are normally HF repo paths) and Fit (vramFit on the server,
// canSplit=false - one model per card); the params name-guess now wears the ≈ marker (D4).
const LC_INST = {
  title: 'Installed models', pager: true,
  quantField: 'ftype', contextField: 'ctxTrain',
  featOf: m => m.inputs,
  nameOf: m => m.name,
  plainCell: true,
  tipOf: m => m.path || null,
  linkOf: m => m.modelUrl || null,
  linkTitle: m => 'Model on Hugging Face',
  tagOf: m => (m.state && m.state !== 'loaded' && m.state !== 'unloaded') ? '<span class="tag">' + escH(m.state) + '</span>' : '',
  ctxTitle: 'The architecture\'s trained context length',
  sizeTitle: 'Weights on disk; AI_SCOPE compares this against VRAM for the Fit column (context adds more)',
  fitTitle: 'AI_SCOPE: weights vs the largest GPU card; a model loads onto one card'
};
defineLens({
  id: 'llamacpp.installed', scope: 'llamacpp', size: 'full',
  name: 'Installed models',
  description: 'In router mode (--models-dir), every model in the router\'s folder: publisher, size, parameters, quantization, context, features, fit, loaded or not.',
  settings: [PER_PAGE_FIELD, MODELS_DIR_FIELD],
  markup: instTableMarkup(LC_INST),
  render(L, d) {
    const $ = L.$, list = d.online && d.router ? d.models || [] : [];
    $('rows').innerHTML = paginate(L.key, list.map(m => instRow(m, LC_INST)), $('pager'), L.settings.perPage).join('');
    $('empty').hidden = list.length > 0;
    $('empty').textContent = !d.online ? 'The llama.cpp server is offline.'
      : d.router ? 'The router\'s models folder is empty.'
      : 'This server runs a single model (started with -m). Start it with --models-dir <folder> (router mode) to list and load the models in a folder.';
    $('hint').textContent = instHint(LC_INST, list);
  },
});

// ---------- Slots ----------
defineLens({
  id: 'llamacpp.slots', scope: 'llamacpp', size: 'full',
  name: 'Slots',
  description: 'The server\'s parallel slots (in router mode, of every loaded model): busy or idle, the request in each and how much of its context is used.',
  settings: [PER_PAGE_FIELD],
  markup: tableLensMarkup({ title:'Slots', pager:true,
    cols:['Slot', 'Model', 'State', 'Task', 'Prompt', 'Cached', 'Generated', 'Context used', 'Running for'] }),
  render(L, d) {
    const $ = L.$, list = d.online ? d.slots || [] : [];
    $('rows').innerHTML = paginate(L.key, list.map(s => {
      const pct = s.used != null && s.nCtx ? Math.min(100, 100 * s.used / s.nCtx) : null;
      return '<tr><td>' + s.id + '</td>' +
        '<td class="model">' + nameHtml(s.model) + '</td>' +
        '<td>' + (s.busy ? '<span class="status success">busy</span>' : s.task != null ? 'idle' : '<span class="na">unused</span>') + '</td>' +
        '<td>' + (s.task != null ? s.task : ONONE) + '</td>' +
        '<td>' + (s.task != null && s.busy ? fmtNum(s.promptTokens) : ONONE) + '</td>' +
        '<td>' + (s.busy && s.cached ? fmtNum(s.cached) : ONONE) + '</td>' +
        '<td>' + (s.busy ? fmtNum(s.decoded) : ONONE) + '</td>' +
        '<td title="Tokens held in this slot (the conversation it last worked on) of its context">' +
          (s.used != null ? '<span class="split"><span class="bar"><div style="width:' + (pct || 0) + '%"></div></span>' + lcK(s.used) + ' / ' + lcCtx(s.nCtx) + '</span>' : ONONE) + '</td>' +
        '<td>' + (s.busy && s.since ? fmtSec(Date.now() - s.since) : ONONE) + '</td></tr>';
    }), $('pager'), L.settings.perPage).join('');
    $('empty').hidden = list.length > 0;
    $('empty').textContent = !d.online ? (d.needsKey ? 'The llama.cpp server needs an API key.' : 'The llama.cpp server is offline.') : d.router && !(d.models || []).some(m => m.state === 'loaded') ? 'No model loaded. The router loads one when a request names it.' : d.slotsEnabled === false ? 'The server was started with --no-slots.' : 'No slots reported yet.';
    $('hint').textContent = list.length ? '— ' + list.filter(s => s.busy).length + ' of ' + list.length + ' busy' : '';
  },
});

// ---------- Requests ----------
// AI_SCOPE-094 slice 2: shared Requests columns; llama.cpp's own Slot column appended last.
// Its numbers keep their honesty markers: `exact` rows come from the server's /metrics counters,
// everything else is slot arithmetic (≈), and `quick` rows know only the combined token total -
// so Generated stays a gap there rather than showing a prompt+generation sum (decision: gap + tag).
function llamacppReqTitle(key, r) {
  const pv = f => provOf(r, f);
  if (key === 'duration') return pv('durationMs') === 'derived' ? 'prompt ' + fmtSec(r.promptMs) + ' + generation ' + fmtSec(r.genMs) : null;
  if (key === 'prompt') return r.promptTps ? 'read at ' + fmtTps(r.promptTps) + ' tok/s in ' + fmtSec(r.promptMs) : null;
  if (key === 'generated') return r.quick ? 'this server saw the request start and finish between two looks: only its combined prompt + generation token count is known' : (pv('outputTokens') === 'estimated' ? 'From the slot\u2019s token count after it finished' : null);
  if (key === 'genTps') return pv('genTps') === 'derived' ? LC_EXACT : LC_EST;
  if (key === 'firstToken') return pv('firstTokenMs') === 'substitute' ? 'Substituted: the server\u2019s metrics give the prompt-eval time, not a first-token time' : null;
  return null;
}
const LLAMACPP_REQ = {
  title: 'Requests', pager: true, extra: ['slot'], keyOf: r => r.key, titleOf: llamacppReqTitle,
  tagOf: r => r.quick ? '<span class="tag" title="Started and finished between two looks at the server, so only its size is known (prompt + output tokens together)">quick</span>' : ''
};
defineLens({
  id: 'llamacpp.requests', scope: 'llamacpp', size: 'full',
  name: 'Requests',
  description: 'Finished requests seen in the server\'s slots: tokens, speeds, first token, duration, peak load.',
  settings: [PER_PAGE_FIELD],
  markup: reqTableMarkup(LLAMACPP_REQ),
  render(L, d) {
    const $ = L.$;
    $('hint').innerHTML = '— <span title="' + escH(LC_EST) + '">≈ = estimated</span>' + ((d.models || []).some(m => m.metricsOn) ? '; requests that ran alone are exact (server metrics)' : ' · start the server with --metrics for exact numbers');
    $('empty').hidden = d.rows.length > 0;
    $('empty').textContent = 'No requests yet. Requests from the server\'s web chat and from apps using its API appear here once they finish.';
    $('rows').innerHTML = paginate(L.key, d.rows.map(r => reqRow(L, r, LLAMACPP_REQ)), $('pager'), L.settings.perPage).join('');
    rowsDrawn(L);
  },
});

// AI_SCOPE-088: the scope-header helper text is gone - the header shows only the title (user direction 2026-10-31).
defineScopeLayout('llamacpp', () => layoutOf([{ lens: 'llamacpp.current', settings: { width: 'full' } }, 'llamacpp.loaded', 'llamacpp.requests', 'llamacpp.installed', 'llamacpp.slots']).concat(LLAMACPP_MIRROR.layout()));   // AI_SCOPE-082: mirror family tail
