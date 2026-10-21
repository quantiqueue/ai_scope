// AI_SCOPE dashboard - Ollama tab: current request, loaded models, requests, installed models.

let oSeen = new Set(), oFirst = true;
async function loadOllama() {
  if (!isInstalled('ollama')) return;
  const $ = id => document.getElementById(id);
  let d;
  try { d = await (await fetch('/api/ollama?limit=100', { cache:'no-store' })).json(); }
  catch (e) { $('oMeta').textContent = 'Could not reach AI_SCOPE server: ' + e.message; return; }
  const px = d.proxy;
  const proxyUrl = 'http://127.0.0.1:' + px.port;
  $('oMeta').textContent = (d.online ? 'connected to ' + d.url + (d.version ? ' · v' + d.version : '') : 'Ollama offline') +
    ' · proxy ' + (px.listening ? 'on :' + px.port : 'not running' + (px.error ? ' (' + px.error + ')' : '')) +
    ' · ' + d.totalRequests + ' requests saved · updates every 2 s';

  // current request
  const cur = d.current, show = (id, on) => { $(id).hidden = !on; };
  $('oDot').className = 'dot' + (cur ? ' live' : d.online ? '' : ' off');
  if (!d.online) {
    $('oTitle').textContent = 'Ollama is not running';
    $('oModel').textContent = ONONE;
    show('oTpsBox', false); show('oTokBox', false); show('oTimeBox', false);
    $('oFoot').textContent = d.error || '';
    setSysLoad('oLoad', false);
  } else if (cur) {
    $('oTitle').textContent = 'Current request' + (cur.othersRunning ? ' (+' + cur.othersRunning + ' more running)' : '');
    $('oModel').textContent = cur.model;
    show('oTpsBox', true); show('oTokBox', true); show('oTimeBox', true);
    const labels = { loading:'Loading model', prompt:'Reading prompt', thinking:'Thinking · tok/s', gen:'Current gen tok/s' };
    $('oTpsLabel').textContent = labels[cur.phase] || 'Current gen tok/s';
    $('oTps').textContent = (cur.phase === 'gen' || cur.phase === 'thinking') && cur.liveTps != null ? fmtTps(cur.liveTps) : '…';
    $('oTok').textContent = fmtNum(cur.tokens) + (cur.thinkTokens ? ' (' + fmtNum(cur.thinkTokens) + ' thinking)' : '');
    $('oTime').textContent = fmtSec(cur.elapsedMs);
    $('oFoot').textContent = cur.endpoint + ' via AI_SCOPE proxy';
    setSysLoad('oLoad', true);
  } else {
    const a = d.average;
    $('oTitle').textContent = 'Idle — no request running';
    $('oModel').textContent = a ? a.model : ONONE;
    show('oTpsBox', !!a); show('oTokBox', false); show('oTimeBox', false);
    $('oTpsLabel').textContent = a ? 'Avg gen tok/s (last ' + a.requests + ' requests)' : 'Avg gen tok/s';
    $('oTps').textContent = a ? fmtTps(a.genTps) : ONONE;
    $('oFoot').textContent = 'Requests are recorded when apps talk to ' + proxyUrl + ' (forwards to Ollama).';
    setSysLoad('oLoad', false);
  }

  // loaded models
  $('oLoaded').innerHTML = d.loaded.map(m => {
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
  $('oLoadedEmpty').hidden = d.loaded.length > 0;
  $('oLoadedEmpty').textContent = d.online ? 'No model loaded. Ollama loads a model on the first request and unloads it after it has been idle (5 min by default).' : 'Ollama is offline.';
  const spill = d.loaded.some(m => m.gpuPct != null && m.gpuPct < 100);
  $('oLoadedHint').textContent = spill ? '— part of a model is running on the CPU, so generation will be slower' : '';

  // requests
  $('oReqHint').textContent = '— only requests sent through ' + proxyUrl;
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
  if ($('oHelp').innerHTML !== helpHtml) $('oHelp').innerHTML = helpHtml;
  $('oRowsEmpty').hidden = d.rows.length > 0;
  $('oRowsEmpty').innerHTML = px.listening
    ? 'No requests captured yet. Click <b>?</b> above to see how to send requests through AI_SCOPE.'
    : 'The AI_SCOPE proxy could not start' + (px.error ? ': ' + escH(px.error) : '') + '. Pick another relay port in the Ollama scope&#39;s <b>Settings</b>.';
  $('oRows').innerHTML = paginate('ollama', d.rows.map(r => {
    const isNew = !oFirst && !oSeen.has(r.id);
    oSeen.add(r.id);
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
  }), 'oPager').join('');

  // installed models
  const vt = d.vramTotal;
  $('oInstHint').textContent = d.installed.length ? '— ' + d.installed.length + ' models · ' + fmtBytes(d.installed.reduce((a, m) => a + (m.size || 0), 0)) + ' on disk' +
    (vt ? ' · fit is weights vs ' + vramWord(d) + ' (context adds more)' : '') : '';
  const fitText = { fits:'fits', tight:'tight', spills:'partly CPU' };
  $('oInst').innerHTML = d.installed.map(m =>
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
  oFirst = false;
}
document.getElementById('oHelpBtn').addEventListener('click', e => {
  const box = document.getElementById('oHelp'), btn = e.currentTarget;
  box.hidden = !box.hidden;
  btn.setAttribute('aria-expanded', String(!box.hidden));
});
pagerReload.ollama = loadOllama;
loadOllama();
setInterval(loadOllama, 2000);
