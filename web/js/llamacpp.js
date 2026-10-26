// AI_SCOPE dashboard - llama.cpp scope (AI_SCOPE-006): current request, loaded model, slots, requests.
// Data: /api/llamacpp (llamacppstats.js polls the server's /props and /slots; no relay). The request history is
// built from those slot polls, so tok/s and durations are estimates (marked "≈").
// Every card/table is a lens (lens.js), so it can also be shown on custom scopes, more than once.

const lcK = n => n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
const lcCtx = n => n == null ? '—' : n % 1024 === 0 ? (n / 1024) + 'K' : lcK(n);
const LC_EXACT = 'Exact: from the server\'s own counters (--metrics), the request ran alone on its model';
const LC_EST = 'Estimated from AI_SCOPE\'s looks at the server\'s slots (every ½ s, ¼ s while busy; llama.cpp keeps no per-request timings)';

defineSource('llamacpp', '/api/llamacpp?limit=100', 'llamacpp', 1000);

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
// "GPU 1 4.0 · GPU 2 2.3 GB" for one model's process (Windows); shared (system) memory on hover.
const lcVram = pr => {
  const cards = pr && pr.gpus ? pr.gpus.map((g, i) => ({ n: i + 1, g })).filter(x => x.g.vram >= 64 * 1048576) : [];
  if (!cards.length) return ONONE;
  const shared = pr.gpus.reduce((a, g) => Math.max(a, g.shared || 0), 0);
  return '<span title="' + (shared >= 64 * 1048576 ? '+ ' + escH(fmtBytes(shared)) + ' in shared (system) memory' : '') + '">' +
    cards.map(x => (pr.gpus.length > 1 ? 'GPU ' + x.n + ' ' : '') + fmtBytes(x.g.vram)).join(' · ') + '</span>';
};
// "Since load" cell: the server's own counters (--metrics) since the model was loaded.
const lcTotals = m => {
  const x = m.metrics;
  if (!x) return '<td class="na" title="Start the server with --metrics to see totals since the model was loaded">—</td>';
  const tip = 'Since the model was loaded (server metrics): ' + fmtNum(x.predTokens) + ' tokens generated' + (x.genTps ? ' at ' + fmtTps(x.genTps) + ' tok/s' : '') +
    ' · ' + fmtNum(x.promptTokens) + ' prompt tokens read' + (x.promptTps ? ' at ' + fmtTps(x.promptTps) + ' tok/s' : '') + (x.cached ? ' · ' + fmtNum(x.cached) + ' reused from the cache' : '');
  return '<td title="' + escH(tip) + '">' + lcK(x.predTokens) + ' out' + (x.genTps ? ' · ' + fmtTps(x.genTps) + ' tok/s' : '') + '</td>';
};

// ---------- Loaded in memory: the running model(s) ----------
defineLens({
  id: 'llamacpp.loaded', scope: 'llamacpp', size: 'full',
  name: 'Loaded in memory',
  description: 'Models the llama.cpp server is running (in router mode, every loaded one): quantization, size, context, slots, VRAM per card.',
  settings: [PER_PAGE_FIELD],
  markup: tableLensMarkup({ title:'Loaded in memory', pager:true,
    cols:['Model', 'Quant', 'Params', 'Size', 'Context', 'Slots', 'VRAM', 'Since load'] }),
  render(L, d) {
    const $ = L.$, list = d.online ? (d.models || []).filter(m => m.state === 'loaded') : [];
    $('rows').innerHTML = paginate(L.key, list.map(m =>
      '<tr><td class="model"><span title="' + escH(m.path || m.name) + '">' + escH(cutName(m.name)) + '</span>' +
        (m.sleeping ? '<span class="tag">sleeping</span>' : '') + '</td>' +
      '<td>' + escH(m.ftype || ONONE) + '</td>' +
      '<td>' + (m.params ? (m.params / 1e9).toFixed(m.params >= 1e10 ? 0 : 1) + ' B' : ONONE) + '</td>' +
      '<td>' + (m.size ? fmtBytes(m.size) : ONONE) + '</td>' +
      '<td title="' + (m.ctxTrain ? 'trained for ' + fmtNum(m.ctxTrain) + ' · ' : '') + 'shared by all slots">' + (m.context ? fmtNum(m.context) : ONONE) + '</td>' +
      '<td>' + (m.slots != null ? m.slots : ONONE) + '</td>' +
      '<td>' + lcVram(m.process) + '</td>' + lcTotals(m) + '</tr>'), $('pager'), L.settings.perPage).join('');
    $('empty').hidden = list.length > 0;
    $('empty').textContent = !d.online ? (d.needsKey ? d.error : 'The llama.cpp server is offline. Start it (llama serve -m <model.gguf>, or llama-server) to see its model and requests.')
      : d.router ? 'No model loaded. The router loads one when a request names it' + (d.router.autoload ? '' : ' (autoload is off: load it in the web UI)') + '.' : 'No model information from the server.';
    $('hint').textContent = !d.online ? '' : d.router
      ? '— router · ' + list.length + ' of ' + (d.models || []).length + ' loaded' + (d.router.maxInstances ? ', up to ' + d.router.maxInstances + ' at once' : '') +
        (list.length > 1 && lcVram(d.process) !== ONONE ? ' · all together ' + lcVram(d.process).replace(/<[^>]*>/g, '') : '')
      : (procVramText(d.process) ? '— ' + procVramText(d.process) : '');
  },
});

// ---------- Installed models: a router's models folder ----------
defineLens({
  id: 'llamacpp.installed', scope: 'llamacpp', size: 'full',
  name: 'Installed models',
  description: 'In router mode (--models-dir), every model in the router\'s folder: size, parameters, quantization, trained context, features, loaded or not.',
  settings: [PER_PAGE_FIELD],
  markup: tableLensMarkup({ title:'Installed models', pager:true,
    cols:['Model', 'Params', 'Quant', 'Size', 'Trained context', 'Features'] }),
  render(L, d) {
    const $ = L.$, list = d.online && d.router ? d.models || [] : [];
    $('rows').innerHTML = paginate(L.key, list.map(m =>
      '<tr><td class="model"><span title="' + escH(m.path || m.name) + '">' + escH(cutName(m.name)) + '</span>' +
        (m.state === 'loaded' ? '<span class="tag">loaded</span>' : m.state !== 'unloaded' ? '<span class="tag">' + escH(m.state) + '</span>' : '') + '</td>' +
      '<td' + (m.paramsGuess ? ' title="From the model name (the exact count shows once it has been loaded)"' : '') + '>' +
        (m.params || m.paramsGuess ? ((m.params || m.paramsGuess) / 1e9).toFixed((m.params || m.paramsGuess) >= 1e10 ? 0 : 1) + ' B' : ONONE) + '</td>' +
      '<td>' + escH(m.ftype || ONONE) + '</td>' +
      '<td>' + (m.size ? fmtBytes(m.size) : ONONE) + '</td>' +
      '<td>' + (m.ctxTrain ? fmtNum(m.ctxTrain) : ONONE) + '</td>' +
      '<td>' + ((m.inputs || []).map(x => '<span class="tag">' + escH(x) + '</span>').join('') || ONONE) + '</td></tr>'), $('pager'), L.settings.perPage).join('');
    $('empty').hidden = list.length > 0;
    $('empty').textContent = !d.online ? 'The llama.cpp server is offline.'
      : d.router ? 'The router\'s models folder is empty.'
      : 'This server runs a single model (started with -m). Start it with --models-dir <folder> (router mode) to list and load the models in a folder.';
    const total = list.reduce((a, m) => a + (m.size || 0), 0);
    $('hint').textContent = list.length ? '— ' + list.length + ' model' + (list.length > 1 ? 's' : '') + (total ? ' · ' + fmtBytes(total) + ' on disk' : '') : '';
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
defineLens({
  id: 'llamacpp.requests', scope: 'llamacpp', size: 'full',
  name: 'Requests',
  description: 'Finished requests seen in the server\'s slots: tokens, estimated speed, first token, duration, peak load.',
  settings: [PER_PAGE_FIELD],
  markup: tableLensMarkup({ title:'Requests', pager:true,
    cols:['Finished', 'Model', 'Slot', 'Prompt', 'Cached', 'Output', 'Gen tok/s', 'First token', 'Duration', 'Peak load'] }),
  render(L, d) {
    const $ = L.$;
    $('hint').innerHTML = '— <span title="' + escH(LC_EST) + '">≈ = estimated</span>' + ((d.models || []).some(m => m.metricsOn) ? '; requests that ran alone are exact (server metrics)' : ' · start the server with --metrics for exact numbers');
    $('empty').hidden = d.rows.length > 0;
    $('empty').textContent = 'No requests yet. Requests from the server\'s web chat and from apps using its API appear here once they finish.';
    $('rows').innerHTML = paginate(L.key, d.rows.map(r => {
      const isNew = isNewRow(L, r.key);
      const approx = r.exact ? '' : '≈ ';
      const quick = r.quick ? '<span class="tag" title="Started and finished between two looks at the server, so only its size is known (prompt + output tokens together)">quick</span>' : '';
      return '<tr' + (isNew ? ' class="new"' : '') + '>' +
        '<td>' + escH(fmtWhen(r.end)) + '</td>' +
        '<td class="model">' + nameHtml(r.model || ONONE) + quick + '</td>' +
        '<td>' + (r.slot != null ? r.slot : ONONE) + '</td>' +
        '<td' + (r.promptTps ? ' title="read at ' + fmtTps(r.promptTps) + ' tok/s in ' + fmtSec(r.promptMs) + '"' : '') + '>' + fmtNum(r.promptTokens) + '</td>' +
        '<td title="Prompt tokens reused from the slot\'s cache">' + (r.cachedTokens ? fmtNum(r.cachedTokens) : ONONE) + '</td>' +
        '<td' + (r.quick ? ' title="prompt + output together"' : r.outputEstimated ? ' title="From the slot\'s token count after it finished"' : '') + '>' +
          fmtNum(r.quick ? r.totalTokens : r.outputTokens) + '</td>' +
        '<td class="tps" title="' + escH(r.exact || r.genExact ? LC_EXACT : LC_EST) + '">' + (r.genTps != null ? (r.genExact ? '' : approx) + fmtTps(r.genTps) : ONONE) + '</td>' +
        '<td>' + (r.firstTokenMs == null ? ONONE : r.exact ? fmtSec(r.firstTokenMs) : r.firstTokenMs < 1000 ? '< 1 s' : '≈ ' + fmtSec(r.firstTokenMs)) + '</td>' +
        '<td' + (r.exact ? ' title="prompt ' + fmtSec(r.promptMs) + ' + generation ' + fmtSec(r.genMs) + '"' : '') + '>' +
          (r.durationMs != null ? approx + fmtSec(r.durationMs) : r.quick ? '< 1 s' : ONONE) + '</td>' + peakCell(r.peak) + '</tr>';
    }), $('pager'), L.settings.perPage).join('');
    rowsDrawn(L);
  },
});

// ---------- The llama.cpp scope page: header line + its lenses ----------
subscribeSource('llamacpp', (d, err) => {
  const meta = document.getElementById('lcMeta');
  if (err) { meta.textContent = 'Could not reach AI_SCOPE server: ' + err.message; return; }
  meta.textContent = (d.online ? 'connected to ' + d.url + (d.router ? ' (router)' : '') + (d.build ? ' · build ' + d.build : '') : d.needsKey ? 'llama.cpp server at ' + d.url + ' needs an API key' : 'llama.cpp server offline') +
    ' · ' + d.totalRequests + ' requests saved · updates every ½ s';
});
defineScopeLayout('llamacpp', () => layoutOf([{ lens: 'llamacpp.current', settings: { width: 'full' } }, 'llamacpp.loaded', 'llamacpp.requests', 'llamacpp.installed', 'llamacpp.slots']));
