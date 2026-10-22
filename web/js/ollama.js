// AI_SCOPE dashboard - Ollama scope: current request, loaded models, requests, installed models.
// Data: /api/ollama (ollamastats.js; requests are recorded by AI_SCOPE's relay in front of Ollama).
// Every card/table is a lens (lens.js), so it can also be shown on custom scopes, more than once.

defineSource('ollama', '/api/ollama?limit=100');
const ollamaProxyUrl = d => 'http://127.0.0.1:' + d.proxy.port;

// ---------- Current request ----------
defineLens({
  id: 'ollama.current', scope: 'ollama', size: 'wide',
  name: 'Current request',
  description: 'What Ollama is answering right now (through the AI_SCOPE relay): speed, tokens and system load.',
  markup: nowCardMarkup([
    { box:'tpsBox', label:'Current gen tok/s', labelK:'tpsLabel', k:'tps' },
    { box:'tokBox', label:'Tokens so far', k:'tok', small:true },
    { box:'timeBox', label:'Elapsed', k:'time' },
  ]),
  render(L, d) {
    const $ = L.$, cur = d.current, show = (k, on) => { $(k).hidden = !on; };
    $('dot').className = 'dot' + (cur ? ' live' : d.online ? '' : ' off');
    if (!d.online) {
      $('title').textContent = 'Ollama is not running';
      $('model').textContent = ONONE;
      show('tpsBox', false); show('tokBox', false); show('timeBox', false);
      $('foot').textContent = d.error || '';
      setSysLoad($('load'), false);
    } else if (cur) {
      $('title').textContent = 'Current request' + (cur.othersRunning ? ' (+' + cur.othersRunning + ' more running)' : '');
      $('model').textContent = cur.model;
      show('tpsBox', true); show('tokBox', true); show('timeBox', true);
      const labels = { loading:'Loading model', prompt:'Reading prompt', thinking:'Thinking · tok/s', gen:'Current gen tok/s' };
      $('tpsLabel').textContent = labels[cur.phase] || 'Current gen tok/s';
      $('tps').textContent = (cur.phase === 'gen' || cur.phase === 'thinking') && cur.liveTps != null ? fmtTps(cur.liveTps) : '…';
      $('tok').textContent = fmtNum(cur.tokens) + (cur.thinkTokens ? ' (' + fmtNum(cur.thinkTokens) + ' thinking)' : '');
      $('time').textContent = fmtSec(cur.elapsedMs);
      $('foot').textContent = cur.endpoint + ' via AI_SCOPE proxy';
      setSysLoad($('load'), true);
    } else {
      const a = d.average;
      $('title').textContent = 'Idle — no request running';
      $('model').textContent = a ? a.model : ONONE;
      show('tpsBox', !!a); show('tokBox', false); show('timeBox', false);
      $('tpsLabel').textContent = a ? 'Avg gen tok/s (last ' + a.requests + ' requests)' : 'Avg gen tok/s';
      $('tps').textContent = a ? fmtTps(a.genTps) : ONONE;
      $('foot').textContent = 'Requests are recorded when apps talk to ' + ollamaProxyUrl(d) + ' (forwards to Ollama).';
      setSysLoad($('load'), false);
    }
  },
});

// ---------- Loaded in memory ----------
defineLens({
  id: 'ollama.loaded', scope: 'ollama', size: 'full',
  name: 'Loaded in memory',
  description: 'Models Ollama has in memory: size, context, how much runs on the GPU, when it unloads.',
  markup: tableLensMarkup({ title:'Loaded in memory',
    cols:['Model', 'Params', 'Size', 'Context', 'GPU', 'Auto-unload'] }),
  render(L, d) {
    const $ = L.$;
    $('rows').innerHTML = d.loaded.map(m => {
      const g = m.gpuPct;
      const proc = g == null ? ONONE : g >= 100 ? '100% GPU' : g <= 0 ? '100% CPU' : (100 - g) + '% CPU / ' + g + '% GPU';
      const until = fmtUntil(m.expiresAt);
      return '<tr><td class="model">' + escH(m.name) + (m.quant ? '<span class="na"> · ' + escH(m.quant) + '</span>' : '') + '</td>' +
        '<td>' + escH(m.params || ONONE) + '</td>' +
        '<td title="' + fmtBytes(m.sizeVram) + ' on GPU">' + fmtBytes(m.size) + '</td>' +
        '<td>' + (m.context ? fmtNum(m.context) + (m.maxContext ? '<span class="na"> / ' + fmtNum(m.maxContext) + '</span>' : '') : ONONE) + '</td>' +
        '<td><span class="split" title="' + fmtBytes(m.sizeVram) + ' of ' + fmtBytes(m.size) + ' on GPU (green = GPU, amber = CPU)"><span class="bar"><div style="width:' + (g || 0) + '%"></div></span>' + proc + '</span></td>' +
        '<td>' + (/^\d/.test(until) ? 'in ' + until : until) + '</td></tr>';
    }).join('');
    $('empty').hidden = d.loaded.length > 0;
    $('empty').textContent = d.online ? 'No model loaded. Ollama loads a model on the first request and unloads it after it has been idle (5 min by default).' : 'Ollama is offline.';
    const spill = d.loaded.some(m => m.gpuPct != null && m.gpuPct < 100);
    $('hint').textContent = spill ? '— part of a model is running on the CPU, so generation will be slower' : '';
  },
});

// ---------- Requests (with the "?" relay setup help) ----------
defineLens({
  id: 'ollama.requests', scope: 'ollama', size: 'full',
  name: 'Requests',
  description: 'Finished requests sent through the AI_SCOPE relay: speeds, tokens, load time, first token, peak load.',
  markup: tableLensMarkup({ title:'Requests', pager:true,
    headExtra: '\n      <button class="helpbtn" data-k="helpBtn" type="button" title="Why only these requests? How to set it up" aria-expanded="false">?</button>',
    before: '\n    <div class="card helpcard" data-k="help" hidden></div>',
    cols:['Timestamp', 'Model', 'Gen tok/s', 'Gen tokens', 'Prompt tok/s', 'Prompt tokens', 'Load time', 'Time to first token', 'Total time', 'Peak load'] }),
  init(L) {
    L.$('helpBtn').addEventListener('click', () => {
      const box = L.$('help');
      box.hidden = !box.hidden;
      L.$('helpBtn').setAttribute('aria-expanded', String(!box.hidden));
    });
  },
  render(L, d) {
    const $ = L.$, px = d.proxy, proxyUrl = ollamaProxyUrl(d);
    $('hint').textContent = '— only requests sent through ' + proxyUrl;
    const helpHtml =
      '<p>Ollama sends token stats (speed, token counts, load time) only back to the app that made the request, so AI_SCOPE can&#39;t see them. ' +
      'AI_SCOPE runs a relay at <code>' + proxyUrl + '</code> that forwards everything to Ollama (<code>' + escH(d.url) + '</code>) and records the stats on the way. ' +
      'Apps that talk to Ollama directly still work normally; they just don&#39;t appear in this table.</p>' +
      '<ul>' +
      '<li><b>PowerShell</b>: <code>$env:OLLAMA_HOST=&quot;127.0.0.1:' + px.port + '&quot;</code> then <code>ollama run qwen3.5:4b</code> (applies to that window only)</li>' +
      '<li><b>cmd</b>: <code>set OLLAMA_HOST=127.0.0.1:' + px.port + '</code> then <code>ollama run qwen3.5:4b</code> (applies to that window only)</li>' +
      '<li><b>Mac / Linux terminal</b>: <code>export OLLAMA_HOST=127.0.0.1:' + px.port + '</code> then <code>ollama run qwen3.5:4b</code> (applies to that window only; add the line to <code>~/.zshrc</code> or <code>~/.bashrc</code> to make it permanent)</li>' +
      '<li><b>VS Code</b> (Continue, Cline, Copilot, …): in the extension&#39;s Ollama settings, change the address / API base from <code>http://localhost:11434</code> to <code>' + proxyUrl + '</code></li>' +
      '<li><b>Other apps and scripts</b>: set the Ollama URL to <code>' + proxyUrl + '</code>, or <code>' + proxyUrl + '/v1</code> for OpenAI-style clients (prompt speed and load time aren&#39;t available for those)</li>' +
      '</ul>';
    if ($('help').innerHTML !== helpHtml) $('help').innerHTML = helpHtml;
    $('empty').hidden = d.rows.length > 0;
    $('empty').innerHTML = px.listening
      ? 'No requests captured yet. Click <b>?</b> above to see how to send requests through AI_SCOPE.'
      : 'The AI_SCOPE proxy could not start' + (px.error ? ': ' + escH(px.error) : '') + '. Pick another relay port in the Ollama scope&#39;s <b>Settings</b>.';
    $('rows').innerHTML = paginate(L.key, d.rows.map(r => {
      const isNew = isNewRow(L, r.id);
      const approx = r.measured ? ' title="measured by the proxy (OpenAI-style endpoint)"' : '';
      const statusTag = r.status === 'ok' ? '' : '<span class="status ' + (r.status === 'aborted' ? 'interrupted' : 'error') + '" title="' + escH(r.error || '') + '">' + escH(r.status) + '</span> ';
      return '<tr' + (isNew ? ' class="new"' : '') + '>' +
        '<td>' + escH(fmtWhen(r.start)) + '</td>' +
        '<td class="model" title="' + escH(r.endpoint) + '">' + statusTag + escH(r.model) + '</td>' +
        '<td class="tps"' + approx + '>' + fmtTps(r.genTps) + '</td>' +
        '<td title="' + (r.thinkTokens ? fmtNum(r.thinkTokens) + ' of these were thinking tokens' : '') + '">' + fmtNum(r.genTokens) + '</td>' +
        '<td>' + fmtTps(r.promptTps) + '</td>' +
        '<td>' + fmtNum(r.promptTokens) + '</td>' +
        '<td>' + (r.loadMs != null ? fmtSec(r.loadMs) : ONONE) + '</td>' +
        '<td>' + fmtSec(r.ttftMs) + '</td>' +
        '<td>' + fmtSec(r.totalMs) + '</td>' + peakCell(r.peak) + '</tr>';
    }), $('pager')).join('');
    rowsDrawn(L);
  },
});

// ---------- Installed models ----------
defineLens({
  id: 'ollama.installed', scope: 'ollama', size: 'full',
  name: 'Installed models',
  description: 'Models installed in Ollama, with size, features, VRAM fit and max context.',
  markup: tableLensMarkup({ title:'Installed models', foot:'',
    cols:['Model', 'Publisher', 'Arch', 'Params', 'Quant', 'Size', 'Features', 'VRAM fit', 'Max context', 'Modified'] }),
  render(L, d) {
    const $ = L.$, vt = d.vramTotal;
    $('hint').textContent = d.installed.length ? '— ' + d.installed.length + ' models · ' + fmtBytes(d.installed.reduce((a, m) => a + (m.size || 0), 0)) + ' on disk' +
      (vt ? ' · fit is weights vs ' + vramWord(d) + ' (context adds more)' : '') : '';
    const fitText = { fits:'fits', tight:'tight', spills:'partly CPU' };
    $('rows').innerHTML = d.installed.map(m =>
      '<tr><td class="model">' + extLink(m.name, m.libraryUrl || m.modelUrl, m.libraryUrl ? 'Ollama library page' : 'Hugging Face repo') +
        (m.libraryUrl && m.modelUrl ? '<a class="tag" href="' + escH(m.modelUrl) + '" target="_blank" rel="noopener" title="Original model on Hugging Face' + (m.baseName ? ': ' + escH(m.baseName) : '') + ' (opens in a new tab)">HF' + EXT_ICON + '</a>' : '') +
        (m.loaded ? '<span class="tag">loaded</span>' : '') + '</td>' +
      '<td>' + (m.publisher ? extLink(m.publisher, m.publisherUrl, 'Publisher on Hugging Face') : ONONE) + '</td>' +
      '<td>' + escH(m.family || ONONE) + '</td><td>' + escH(m.params || ONONE) + '</td><td>' + escH(m.quant || ONONE) + '</td>' +
      '<td>' + fmtBytes(m.size) + '</td>' +
      '<td>' + featTags(m.features) + '</td>' +
      '<td>' + fitPill(m, fitText) + '</td>' +
      '<td>' + (m.maxContext ? fmtNum(m.maxContext) : ONONE) + '</td>' +
      '<td>' + (m.modified ? new Date(m.modified).toLocaleDateString() : ONONE) + '</td></tr>').join('');
  },
});

// ---------- The Ollama scope page: header line + its lenses ----------
subscribeSource('ollama', (d, err) => {
  const meta = document.getElementById('oMeta');
  if (err) { meta.textContent = 'Could not reach AI_SCOPE server: ' + err.message; return; }
  const px = d.proxy;
  meta.textContent = (d.online ? 'connected to ' + d.url + (d.version ? ' · v' + d.version : '') : 'Ollama offline') +
    ' · proxy ' + (px.listening ? 'on :' + px.port : 'not running' + (px.error ? ' (' + px.error + ')' : '')) +
    ' · ' + d.totalRequests + ' requests saved · updates every 2 s';
});
mountScopePage('ollama', ['ollama.current', 'ollama.loaded', 'ollama.requests', 'ollama.installed']);
