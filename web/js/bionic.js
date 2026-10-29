// AI_SCOPE dashboard - Bionic scope (LM Studio's Bionic): current request, requests (from its server logs), loaded and installed models.
// Data: /api/bionic (server log parser) and /api/bionic/models (the REST API of Bionic's local server).
// Every card/table is a lens (lens.js), so it can also be shown on custom scopes, more than once.

defineSource('bionic', '/api/bionic?limit=100');
defineSource('bionic.models', '/api/bionic/models', 'bionic');

// ---------- Hardware Mirror Lenses for Bionic (AI_SCOPE-077) ----------
// The family's first scope outside Strata: bionic.gpu / bionic.ram / bionic.cpu / bionic.io from the shared
// defineMirror() (web/js/mirror.js) — the rules and states are the family's (072 / 073 / 075 / 076), and the
// process rule is 049's: Bionic's model runs in a child llama-server.exe under its server port. Tile ids use
// 'b' prefixes (bgp*/ bram_* / bcpu / bio), so each tile hovers over Bionic's own history.
const BIONIC_MIRROR = defineMirror({ key: 'bionic', name: 'Bionic', letter: 'b' });

// ---------- Current request ----------
defineLens({
  id: 'bionic.current', scope: 'bionic', size: 'wide',
  name: 'Current request',
  description: 'What Bionic\'s local server is answering right now: prompt progress, speed, tokens and the model process\'s GPU, VRAM, CPU and RAM use.',
  settings: [PROC_STATS_FIELD],
  markup: nowCardMarkup([
    { box:'tpsBox', label:'Current gen tok/s', labelK:'tpsLabel', k:'tps' },
    { box:'tokBox', label:'Tokens so far', k:'tok', small:true },
    { box:'timeBox', label:'Elapsed', k:'time' },
  ]),
  render(L, data) {
    const $ = L.$, cur = data.current, avg = data.average;
    $('dot').className = 'dot' + (cur ? ' live' : '');
    if (cur) {
      // state line from Bionic's server log: starting -> reading prompt (n%) -> generating (no "thinking" or model loading in the log)
      const doing = cur.phase === 'gen' ? 'generating' : cur.progress > 0 && cur.progress < 1 ? 'reading prompt' : 'starting';   // the % is in the box below
      $('title').textContent = 'Running — ' + doing + (cur.othersRunning ? ' (+' + cur.othersRunning + ' more running)' : '');
      setName($('model'), cur.model);
      if (cur.phase === 'gen' && cur.genTps != null) {
        $('tpsLabel').textContent = 'Current gen tok/s';
        $('tps').textContent = fmtTps(cur.genTps);
      } else {
        const reading = cur.phase === 'prompt' && cur.progress < 1;
        $('tpsLabel').textContent = reading ? 'Prompt read' : 'Current gen tok/s';
        $('tps').textContent = reading ? Math.round(cur.progress * 100) + '%' : '…';   // the state ("starting") is on the state line
      }
      $('timeBox').hidden = false;
      $('time').textContent = fmtSec(cur.elapsedMs);
      $('tokBox').hidden = !(cur.phase === 'gen' && cur.genTokens);
      $('tok').textContent = fmtNum(cur.genTokens);
      $('foot').textContent = '';   // the state is on the top line (an empty foot line is hidden)
      // Bionic's model process when known (Windows). On Windows without one (the model was unloaded or its llama-server
      // ended mid-request) the row is hidden rather than showing whole-computer load; other systems show System load.
      setSysLoad($('load'), L.settings.procStats !== false && (!(data.processSupported && !data.process)), data.process, 'Bionic');
    } else {
      $('title').textContent = 'Idle — no request running';
      setName($('model'), avg ? avg.model : '—');
      $('tpsLabel').textContent = avg ? 'Avg gen tok/s (last ' + avg.requests + ' requests)' : 'Avg gen tok/s';
      $('tps').textContent = avg ? fmtTps(avg.genTps) : '—';
      $('timeBox').hidden = true;
      $('tokBox').hidden = true;
      // like Strata's card: a hint while no model is loaded (loaded models come from Bionic's API, the other source)
      const models = SOURCES['bionic.models'].data;
      // what to do to see live stats: start the server, load a model, then send a request
      $('foot').textContent = !models || !models.loaded ? ' '
        : !models.online ? 'Start Bionic\'s local server to see live stats.'
        : !models.loaded.length ? 'Load a model in Bionic to see live stats.'
        : 'Send a request to Bionic\'s local server to see live stats.';
      setSysLoad($('load'), false);
    }
  },
});

// ---------- Loaded in memory ----------
defineLens({
  id: 'bionic.loaded', scope: 'bionic', source: 'bionic.models', size: 'full',
  name: 'Loaded in memory',
  description: 'Models Bionic has loaded: size, context, flash attention, KV cache, parallel slots, auto-unload.',
  markup: tableLensMarkup({ title:'Loaded in memory',
    cols:['Model', 'Params', 'Size', 'Context', 'Flash attention', 'KV cache', 'Parallel', 'Auto-unload'] }),
  render(L, d) {
    const $ = L.$;
    const onOff = v => v == null ? ONONE : v ? 'on' : 'off';
    $('rows').innerHTML = d.loaded.map(m => {
      return '<tr><td class="model">' + nameLink(m.id, m.modelUrl) + (m.quant ? '<span class="na"> · ' + escH(m.quant) + '</span>' : '') + '</td>' +
        '<td>' + escH(m.params || ONONE) + '</td>' +
        '<td>' + fmtBytes(m.size) + '</td>' +
        '<td>' + (m.context ? fmtNum(m.context) + (m.maxContext ? '<span class="na"> / ' + fmtNum(m.maxContext) + '</span>' : '') : ONONE) + '</td>' +
        '<td>' + onOff(m.flashAttention) + '</td>' +
        '<td>' + (m.kvOnGpu == null ? ONONE : m.kvOnGpu ? 'GPU' : 'CPU') + '</td>' +
        '<td>' + (m.parallel != null ? m.parallel : ONONE) + '</td>' +
        '<td>' + (m.ttlMs ? fmtDur(m.ttlMs) + ' idle' : 'off') + '</td></tr>';
    }).join('');
    $('empty').hidden = d.loaded.length > 0;
    $('empty').textContent = d.online ? 'No model loaded. Load one in Bionic, or it loads on the first request (JIT loading).'
      : 'Bionic\'s local server is not reachable' + (d.error ? ' (' + d.error + ')' : '') + '. Start it on Bionic\'s Local Server screen to see models.';
    // Where the model actually sits: per-card VRAM of Bionic's model process(es) (Windows, AI_SCOPE-049) - Bionic's API doesn't say
    const where = d.loaded.length ? procVramText(d.process) : '';
    if (where) { $('hint').textContent = '— ' + where; return; }
    // Windows: no model process (yet) - e.g. a model being unloaded or loaded; the API lags behind by up to 10 s
    if (d.processSupported) { $('hint').textContent = ''; return; }
    const vt = d.vramTotal;
    const big = vt ? d.loaded.filter(m => m.size && m.size > vt) : [];
    $('hint').textContent = big.length ? (d.vramCards > 1 ? '— larger than one card (' + fmtBytes(vt) + ' VRAM), so it is split across GPUs or partly in system RAM' : '— larger than ' + fmtBytes(vt) + ' VRAM, so part of it runs from system RAM') : (d.loaded.length ? '— Bionic does not report GPU offload; compare VRAM on the Hardware tab' : '');
  },
});

// ---------- Requests ----------
defineLens({
  id: 'bionic.requests', scope: 'bionic', size: 'full',
  name: 'Requests',
  description: 'Finished requests from Bionic\'s server logs: speeds, tokens, first token, total time, peak load.',
  settings: [PER_PAGE_FIELD],
  markup: tableLensMarkup({ title:'Requests', pager:true,
    hint: '',
    foot: '\n      <div class="err" data-k="err" hidden></div>',
    cols:['Timestamp', 'Model', 'Gen tok/s', 'Gen tokens', 'Prompt tok/s', 'Prompt tokens', 'Time to first token', 'Total time', 'Peak load'] }),
  render(L, data) {
    const $ = L.$;
    $('err').hidden = !data.error; $('err').textContent = data.error || '';
    const rows = data.rows.map(r => {
      const isNew = isNewRow(L, r.timestamp + '|' + r.task);
      return '<tr' + (isNew ? ' class="new"' : '') + '>' +
        '<td title="' + esc(r.timestamp || '') + '">' + esc(lmTs(r.timestamp) ? fmtWhen(lmTs(r.timestamp)) : (r.timestamp || '—')) + '</td>' +
        '<td class="model">' + nameHtml(r.model) + '</td>' +
        '<td class="tps">' + fmtTps(r.genTps) + '</td>' +
        '<td>' + fmtNum(r.genTokens) + '</td>' +
        '<td>' + fmtTps(r.promptTps) + '</td>' +
        '<td>' + fmtNum(r.promptTokens) + '</td>' +
        '<td>' + fmtSec(r.promptMs) + '</td>' +
        '<td>' + fmtSec(r.totalMs) + '</td>' + peakCell(r.peak) + '</tr>';
    });
    $('rows').innerHTML = paginate(L.key, rows, $('pager'), L.settings.perPage).join('');
    rowsDrawn(L);
  },
});

// ---------- Installed models ----------
defineLens({
  id: 'bionic.installed', scope: 'bionic', source: 'bionic.models', size: 'full',
  name: 'Installed models',
  description: 'Models downloaded in Bionic, with size, features, VRAM fit and max context.',
  settings: [PER_PAGE_FIELD],
  markup: tableLensMarkup({ title:'Installed models', pager:true,
    cols:['Model', 'Publisher', 'Arch', 'Params', 'Quant', 'Size', 'Features', 'VRAM fit', 'Max context', 'Modified'] }),
  render(L, d) {
    const $ = L.$, vt = d.vramTotal;
    const fitText = { fits:'fits', tight:'tight', spills:'partly CPU' };
    $('rows').innerHTML = paginate(L.key, d.installed.map(m => {
      const feats = [m.vision ? 'vision' : null, m.tools ? 'tools' : null, m.reasoning ? 'reasoning' : null,
                     m.type && m.type.indexOf('embed') === 0 ? 'embedding' : null].filter(Boolean);
      return '<tr><td class="model">' + nameLink(m.name, m.modelUrl, (m.source ? m.source + ': ' : '') + (m.modelUrl || m.key)) + (m.loaded ? '<span class="tag">loaded</span>' : '') + '</td>' +
        '<td>' + (m.publisher ? extLink(m.publisher, m.publisherUrl, 'Publisher on Hugging Face') : ONONE) + '</td><td>' + escH(m.arch || ONONE) + '</td><td>' + escH(m.params || ONONE) + '</td>' +
        '<td>' + escH(m.quant || ONONE) + '</td><td>' + fmtBytes(m.size) + '</td>' +
        '<td>' + featTags(feats) + '</td>' +
        '<td>' + fitPill(m, fitText) + '</td>' +
        '<td>' + (m.maxContext ? fmtNum(m.maxContext) : ONONE) + '</td>' +
        '<td>' + (m.modified ? new Date(m.modified).toLocaleDateString() : ONONE) + '</td></tr>';
    }), $('pager'), L.settings.perPage).join('');
    $('empty').hidden = d.installed.length > 0;
    $('empty').textContent = d.online ? 'No models found.' : 'Bionic\'s local server is not reachable.';
    $('hint').textContent = d.installed.length ? '— ' + d.installed.length + ' models · ' + fmtBytes(d.installed.reduce((a, m) => a + (m.size || 0), 0)) + ' on disk' +
      (vt ? ' · fit is weights vs ' + vramWord(d) + ' (context adds more)' : '') : '';
  },
});

// ---------- The Bionic scope page: header line + its lenses ----------
subscribeSource('bionic', (data, err) => {
  const meta = document.getElementById('meta');
  if (err) { meta.textContent = 'Could not reach server: ' + err.message; return; }
  const lmApi = SOURCES['bionic.models'].data;
  meta.textContent =
    (lmApi ? (lmApi.online ? 'connected to ' + lmApi.url + ' (API ' + lmApi.apiVersion + ')' : 'Bionic\'s local server offline') + ' · ' : '') +
    data.rows.length + ' latest requests · updated ' + new Date().toLocaleTimeString() + ' · updates every 2 s';
});
// AI_SCOPE-077: the mirror rows (per-card GPU + VRAM pairs, not on macOS; then the bottom row
// Bionic CPU · Bionic RAM (Working) · Bionic RAM (Committed) · Bionic I/O on every OS) follow the loaded
// models, exactly like Strata's default (072 / 073 / 075 / 076 rules via mirror.js).
defineScopeLayout('bionic', () => layoutOf([{ lens: 'bionic.current', settings: { width: 'full' } }, 'bionic.loaded', 'bionic.requests', 'bionic.installed']).concat(BIONIC_MIRROR.layout()));
