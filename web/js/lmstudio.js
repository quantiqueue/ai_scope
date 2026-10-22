// AI_SCOPE dashboard - LM Studio scope: current request, requests (from its logs), loaded and installed models.
// Data: /api/requests (server log parser) and /api/lmstudio/models (LM Studio's REST API).
// Every card/table is a lens (lens.js), so it can also be shown on custom scopes, more than once.

defineSource('lmstudio', '/api/requests?limit=100');
defineSource('lmstudio.models', '/api/lmstudio/models', 'lmstudio');

// ---------- Current request ----------
defineLens({
  id: 'lmstudio.current', scope: 'lmstudio', size: 'wide',
  name: 'Current request',
  description: 'What LM Studio is answering right now: prompt progress, speed, tokens and system load.',
  markup: nowCardMarkup([
    { box:'tpsBox', label:'Current gen tok/s', labelK:'tpsLabel', k:'tps' },
    { box:'tokBox', label:'Tokens so far', k:'tok', small:true },
    { box:'timeBox', label:'Elapsed', k:'time' },
  ]),
  render(L, data) {
    const $ = L.$, cur = data.current, avg = data.average;
    $('dot').className = 'dot' + (cur ? ' live' : '');
    if (cur) {
      $('title').textContent = 'Current request' + (cur.othersRunning ? ' (+' + cur.othersRunning + ' more running)' : '');
      $('model').textContent = cur.model;
      if (cur.phase === 'gen' && cur.genTps != null) {
        $('tpsLabel').textContent = 'Current gen tok/s';
        $('tps').textContent = fmtTps(cur.genTps);
      } else {
        const reading = cur.phase === 'prompt' && cur.progress < 1;
        $('tpsLabel').textContent = reading ? 'Reading prompt' : 'Current gen tok/s';
        $('tps').textContent = reading ? Math.round(cur.progress * 100) + '%' : 'starting…';
      }
      $('timeBox').hidden = false;
      $('time').textContent = fmtSec(cur.elapsedMs);
      $('tokBox').hidden = !(cur.phase === 'gen' && cur.genTokens);
      $('tok').textContent = fmtNum(cur.genTokens);
      $('foot').textContent = ' ';
      setSysLoad($('load'), true);
    } else {
      $('title').textContent = 'Idle — no request running';
      $('model').textContent = avg ? avg.model : '—';
      $('tpsLabel').textContent = avg ? 'Avg gen tok/s (last ' + avg.requests + ' requests)' : 'Avg gen tok/s';
      $('tps').textContent = avg ? fmtTps(avg.genTps) : '—';
      $('timeBox').hidden = true;
      $('tokBox').hidden = true;
      // like Strata's card: a hint while no model is loaded (loaded models come from LM Studio's API, the other source)
      const models = SOURCES['lmstudio.models'].data;
      $('foot').textContent = models && models.loaded && !models.loaded.length ? 'Load a model in LM Studio to see live stats.' : ' ';
      setSysLoad($('load'), false);
    }
  },
});

// ---------- Loaded in memory ----------
defineLens({
  id: 'lmstudio.loaded', scope: 'lmstudio', source: 'lmstudio.models', size: 'full',
  name: 'Loaded in memory',
  description: 'Models LM Studio has loaded: size, context, flash attention, KV cache, parallel slots, auto-unload.',
  markup: tableLensMarkup({ title:'Loaded in memory',
    cols:['Model', 'Params', 'Size', 'Context', 'Flash attention', 'KV cache', 'Parallel', 'Auto-unload'] }),
  render(L, d) {
    const $ = L.$;
    const onOff = v => v == null ? ONONE : v ? 'on' : 'off';
    $('rows').innerHTML = d.loaded.map(m => {
      return '<tr><td class="model">' + extLink(m.id, m.modelUrl) + (m.quant ? '<span class="na"> · ' + escH(m.quant) + '</span>' : '') + '</td>' +
        '<td>' + escH(m.params || ONONE) + '</td>' +
        '<td>' + fmtBytes(m.size) + '</td>' +
        '<td>' + (m.context ? fmtNum(m.context) + (m.maxContext ? '<span class="na"> / ' + fmtNum(m.maxContext) + '</span>' : '') : ONONE) + '</td>' +
        '<td>' + onOff(m.flashAttention) + '</td>' +
        '<td>' + (m.kvOnGpu == null ? ONONE : m.kvOnGpu ? 'GPU' : 'CPU') + '</td>' +
        '<td>' + (m.parallel != null ? m.parallel : ONONE) + '</td>' +
        '<td>' + (m.ttlMs ? fmtDur(m.ttlMs) + ' idle' : 'off') + '</td></tr>';
    }).join('');
    $('empty').hidden = d.loaded.length > 0;
    $('empty').textContent = d.online ? 'No model loaded. Load one in LM Studio, or it loads on the first request (JIT loading).'
      : 'LM Studio server is not reachable' + (d.error ? ' (' + d.error + ')' : '') + '. Start the server in LM Studio (Developer tab) to see models.';
    const vt = d.vramTotal;
    const big = vt ? d.loaded.filter(m => m.size && m.size > vt) : [];
    $('hint').textContent = big.length ? (d.vramCards > 1 ? '— larger than one card (' + fmtBytes(vt) + ' VRAM), so it is split across GPUs or partly in system RAM' : '— larger than ' + fmtBytes(vt) + ' VRAM, so part of it runs from system RAM') : (d.loaded.length ? '— LM Studio does not report GPU offload; compare VRAM on the Hardware tab' : '');
  },
});

// ---------- Requests ----------
defineLens({
  id: 'lmstudio.requests', scope: 'lmstudio', size: 'full',
  name: 'Requests',
  description: 'Finished requests from LM Studio\'s server logs: speeds, tokens, first token, total time, peak load.',
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
        '<td class="model">' + esc(r.model) + '</td>' +
        '<td class="tps">' + fmtTps(r.genTps) + '</td>' +
        '<td>' + fmtNum(r.genTokens) + '</td>' +
        '<td>' + fmtTps(r.promptTps) + '</td>' +
        '<td>' + fmtNum(r.promptTokens) + '</td>' +
        '<td>' + fmtSec(r.promptMs) + '</td>' +
        '<td>' + fmtSec(r.totalMs) + '</td>' + peakCell(r.peak) + '</tr>';
    });
    $('rows').innerHTML = paginate(L.key, rows, $('pager')).join('');
    rowsDrawn(L);
  },
});

// ---------- Installed models ----------
defineLens({
  id: 'lmstudio.installed', scope: 'lmstudio', source: 'lmstudio.models', size: 'full',
  name: 'Installed models',
  description: 'Models downloaded in LM Studio, with size, features, VRAM fit and max context.',
  markup: tableLensMarkup({ title:'Installed models',
    cols:['Model', 'Publisher', 'Arch', 'Params', 'Quant', 'Size', 'Features', 'VRAM fit', 'Max context', 'Modified'] }),
  render(L, d) {
    const $ = L.$, vt = d.vramTotal;
    const fitText = { fits:'fits', tight:'tight', spills:'partly CPU' };
    $('rows').innerHTML = d.installed.map(m => {
      const feats = [m.vision ? 'vision' : null, m.tools ? 'tools' : null, m.reasoning ? 'reasoning' : null,
                     m.type && m.type.indexOf('embed') === 0 ? 'embedding' : null].filter(Boolean);
      return '<tr><td class="model">' + extLink(m.name, m.modelUrl, (m.source ? m.source + ': ' : '') + (m.modelUrl || m.key)) + (m.loaded ? '<span class="tag">loaded</span>' : '') + '</td>' +
        '<td>' + (m.publisher ? extLink(m.publisher, m.publisherUrl, 'Publisher on Hugging Face') : ONONE) + '</td><td>' + escH(m.arch || ONONE) + '</td><td>' + escH(m.params || ONONE) + '</td>' +
        '<td>' + escH(m.quant || ONONE) + '</td><td>' + fmtBytes(m.size) + '</td>' +
        '<td>' + featTags(feats) + '</td>' +
        '<td>' + fitPill(m, fitText) + '</td>' +
        '<td>' + (m.maxContext ? fmtNum(m.maxContext) : ONONE) + '</td>' +
        '<td>' + (m.modified ? new Date(m.modified).toLocaleDateString() : ONONE) + '</td></tr>';
    }).join('');
    $('empty').hidden = d.installed.length > 0;
    $('empty').textContent = d.online ? 'No models found.' : 'LM Studio server is not reachable.';
    $('hint').textContent = d.installed.length ? '— ' + d.installed.length + ' models · ' + fmtBytes(d.installed.reduce((a, m) => a + (m.size || 0), 0)) + ' on disk' +
      (vt ? ' · fit is weights vs ' + vramWord(d) + ' (context adds more)' : '') : '';
  },
});

// ---------- The LM Studio scope page: header line + its lenses ----------
subscribeSource('lmstudio', (data, err) => {
  const meta = document.getElementById('meta');
  if (err) { meta.textContent = 'Could not reach server: ' + err.message; return; }
  const lmApi = SOURCES['lmstudio.models'].data;
  meta.textContent =
    (lmApi ? (lmApi.online ? 'connected to ' + lmApi.url + ' (API ' + lmApi.apiVersion + ')' : 'LM Studio server offline') + ' · ' : '') +
    data.rows.length + ' latest requests · updated ' + new Date().toLocaleTimeString() + ' · updates every 2 s';
});
mountScopePage('lmstudio', ['lmstudio.current', 'lmstudio.loaded', 'lmstudio.requests', 'lmstudio.installed']);
