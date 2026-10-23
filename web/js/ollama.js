// AI_SCOPE dashboard - Ollama scope: current request, loaded models, requests, installed models.
// Data: /api/ollama (ollamastats.js; requests are recorded by AI_SCOPE's relay in front of Ollama).
// Every card/table is a lens (lens.js), so it can also be shown on custom scopes, more than once.

defineSource('ollama', '/api/ollama?limit=100');
const ollamaProxyUrl = d => 'http://127.0.0.1:' + d.proxy.port;
// Ollama answered requests that didn't go through the relay (seen by the server: a model loaded or its unload time
// renewed while the relay was idle). Shown for 15 minutes, or until a request comes through the relay again.
function ollamaDirectUse(d) {
  const u = d.directUse;
  if (!u || Date.now() - u.at > 15 * 60000) return null;
  if (d.rows && d.rows[0] && d.rows[0].end > u.at) return null;
  return u;
}
// Copy button for a command / address in the help ("Copy" -> "Copied").
const copyBtn = text => '<button type="button" class="copybtn" data-copy="' + escH(text) + '" title="Copy to clipboard">Copy</button>';
document.addEventListener('click', e => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const text = b.dataset.copy, done = ok => { b.textContent = ok ? 'Copied' : 'Copy failed'; b.classList.toggle('ok', ok); setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('ok'); }, 1500); };
  const viaTextBox = () => {   // no clipboard API (opened over the LAN on http) or it refused: hidden text box
    const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (err) {}
    t.remove(); done(ok);
  };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => done(true), viaTextBox);
  else viaTextBox();
});
// The relay setup help (the "?" in the page header and by Requests): why only some requests show, and how to
// point apps at the AI_SCOPE relay.
function ollamaHelpHtml(d) {
  const px = d.proxy, proxyUrl = ollamaProxyUrl(d);
  return (
    '<p>Ollama sends token stats (speed, token counts, load time) only back to the app that made the request, so AI_SCOPE can&#39;t see them. ' +
    'AI_SCOPE runs a relay at <code>' + proxyUrl + '</code> that forwards everything to Ollama (<code>' + escH(d.url) + '</code>) and records the stats on the way. ' +
    'Apps that talk to Ollama directly still work normally; they just don&#39;t appear in the Requests table.</p>' +
    '<ul>' +
    '<li><b>PowerShell</b>: <code>$env:OLLAMA_HOST=&quot;127.0.0.1:' + px.port + '&quot;</code>' + copyBtn('$env:OLLAMA_HOST="127.0.0.1:' + px.port + '"') + ' then <code>ollama run qwen3.5:4b</code> (applies to that window only)</li>' +
    '<li><b>cmd</b>: <code>set OLLAMA_HOST=127.0.0.1:' + px.port + '</code>' + copyBtn('set OLLAMA_HOST=127.0.0.1:' + px.port) + ' then <code>ollama run qwen3.5:4b</code> (applies to that window only)</li>' +
    '<li><b>Mac / Linux terminal</b>: <code>export OLLAMA_HOST=127.0.0.1:' + px.port + '</code>' + copyBtn('export OLLAMA_HOST=127.0.0.1:' + px.port) + ' then <code>ollama run qwen3.5:4b</code> (applies to that window only; add the line to <code>~/.zshrc</code> or <code>~/.bashrc</code> to make it permanent)</li>' +
    '<li><b>VS Code</b> (Continue, Cline, Copilot, …): in the extension&#39;s Ollama settings, change the address / API base from <code>http://localhost:11434</code> to <code>' + proxyUrl + '</code>' + copyBtn(proxyUrl) + '</li>' +
    '<li><b>Other apps and scripts</b>: set the Ollama URL to <code>' + proxyUrl + '</code>' + copyBtn(proxyUrl) + ', or <code>' + proxyUrl + '/v1</code>' + copyBtn(proxyUrl + '/v1') + ' for OpenAI-style clients (prompt speed and load time aren&#39;t available for those)</li>' +
    '</ul>');
}

// ---------- Current request ----------
defineLens({
  id: 'ollama.current', scope: 'ollama', size: 'wide',
  name: 'Current request',
  description: 'What Ollama is answering right now (through the AI_SCOPE relay): speed, tokens and the model process\'s GPU, VRAM, CPU and RAM use.',
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
      setName($('model'), ONONE);
      show('tpsBox', false); show('tokBox', false); show('timeBox', false);
      $('foot').textContent = d.error || '';
      $('detail').textContent = '';
      $('foot').classList.remove('warn');
      setSysLoad($('load'), false);
    } else if (cur) {
      // state line: what the request is doing (the lens title is in the header tab)
      const doing = { loading:'loading model', prompt:'reading prompt', thinking:'thinking', gen:'generating' }[cur.phase] || 'working';
      $('title').textContent = 'Running — ' + doing + (cur.othersRunning ? ' (+' + cur.othersRunning + ' more running)' : '');
      setName($('model'), cur.model);
      show('tpsBox', true); show('tokBox', true); show('timeBox', true);
      $('tpsLabel').textContent = 'Current gen tok/s';   // the phase (loading / reading prompt / thinking) is on the state line
      $('tps').textContent = (cur.phase === 'gen' || cur.phase === 'thinking') && cur.liveTps != null ? fmtTps(cur.liveTps) : '…';
      $('tok').textContent = fmtNum(cur.tokens) + (cur.thinkTokens ? ' (' + fmtNum(cur.thinkTokens) + ' thinking)' : '');
      $('time').textContent = fmtSec(cur.elapsedMs);
      $('detail').textContent = cur.endpoint + ' via AI_SCOPE relay';   // details next to the state on the top line
      $('foot').textContent = '';
      $('foot').classList.remove('warn');
      // Ollama's model process when known (Windows); hidden on Windows without one, whole-computer System load elsewhere
      setSysLoad($('load'), !(d.processSupported && !d.process), d.process, 'Ollama');
    } else {
      const a = d.average;
      $('title').textContent = 'Idle — no request running';
      setName($('model'), a ? a.model : ONONE);
      show('tpsBox', !!a); show('tokBox', false); show('timeBox', false);
      $('tpsLabel').textContent = a ? 'Avg gen tok/s (last ' + a.requests + ' requests)' : 'Avg gen tok/s';
      $('tps').textContent = a ? fmtTps(a.genTps) : ONONE;
      const u = ollamaDirectUse(d);
      $('foot').textContent = u ? '⚠ Ollama answered a request at ' + fmtWhen(u.at) + ' (' + u.model + ') that didn\'t go through the AI_SCOPE relay, so it isn\'t recorded. Point apps at ' + ollamaProxyUrl(d) + ' (see ? in Requests).'
        : 'Send a request through the AI_SCOPE relay (' + ollamaProxyUrl(d) + ') to see live stats.';
      $('foot').classList.toggle('warn', !!u);
      $('detail').textContent = '';
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
      return '<tr><td class="model">' + nameHtml(m.name) + (m.quant ? '<span class="na"> · ' + escH(m.quant) + '</span>' : '') + '</td>' +
        '<td>' + escH(m.params || ONONE) + '</td>' +
        '<td title="' + fmtBytes(m.sizeVram) + ' on GPU">' + fmtBytes(m.size) + '</td>' +
        '<td>' + (m.context ? fmtNum(m.context) + (m.maxContext ? '<span class="na"> / ' + fmtNum(m.maxContext) + '</span>' : '') : ONONE) + '</td>' +
        '<td><span class="split" title="' + fmtBytes(m.sizeVram) + ' of ' + fmtBytes(m.size) + ' on GPU (green = GPU, amber = CPU)"><span class="bar"><div style="width:' + (g || 0) + '%"></div></span>' + proc + '</span></td>' +
        '<td>' + (/^\d/.test(until) ? 'in ' + until : until) + '</td></tr>';
    }).join('');
    $('empty').hidden = d.loaded.length > 0;
    $('empty').textContent = d.online ? 'No model loaded. Ollama loads a model on the first request and unloads it after it has been idle (5 min by default).' : 'Ollama is offline.';
    const spill = d.loaded.some(m => m.gpuPct != null && m.gpuPct < 100);
    const where = d.loaded.length ? procVramText(d.process) : '';   // per-card VRAM of the model process (Windows, AI_SCOPE-050)
    $('hint').textContent = [where, spill ? 'part of a model is running on the CPU, so generation will be slower' : ''].filter(Boolean).map((t, i) => (i ? '' : '— ') + t).join(' · ');
  },
});

// ---------- Requests (with the "?" relay setup help) ----------
defineLens({
  id: 'ollama.requests', scope: 'ollama', size: 'full',
  name: 'Requests',
  description: 'Finished requests sent through the AI_SCOPE relay: speeds, tokens, load time, first token, peak load.',
  markup: tableLensMarkup({ title:'Requests', pager:true,
    headExtra: '\n      <button class="helpbtn" data-k="helpBtn" type="button" title="Why only these requests? How to set it up" aria-expanded="false">?</button>',
    before: '\n      <div class="relaywarn" data-k="warn" hidden><span data-k="warnText"></span> <button type="button" class="linkbtn" data-k="warnHelp">How to set up the relay</button></div>' +
      '\n      <div class="helpcard" data-k="help" hidden></div>',
    cols:['Timestamp', 'Model', 'Gen tok/s', 'Gen tokens', 'Prompt tok/s', 'Prompt tokens', 'Load time', 'Time to first token', 'Total time', 'Peak load'] }),
  init(L) {
    const toggle = open => {
      const box = L.$('help');
      box.hidden = open == null ? !box.hidden : !open;
      L.$('helpBtn').setAttribute('aria-expanded', String(!box.hidden));
    };
    L.$('helpBtn').addEventListener('click', () => toggle());
    L.$('warnHelp').addEventListener('click', () => toggle(true));
  },
  render(L, d) {
    const $ = L.$, px = d.proxy, proxyUrl = ollamaProxyUrl(d);
    $('hint').textContent = '— only requests sent through ' + proxyUrl;
    const helpHtml = ollamaHelpHtml(d);
    if ($('help').innerHTML !== helpHtml) $('help').innerHTML = helpHtml;
    const u = ollamaDirectUse(d);
    $('warn').hidden = !u;
    if (u) {
      const t = '⚠ Ollama answered a request at ' + fmtWhen(u.at) + ' (' + u.model + ') that didn\'t go through the AI_SCOPE relay, so it isn\'t in this table.';
      if ($('warnText').textContent !== t) $('warnText').textContent = t;
    }
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
        '<td class="model" title="' + escH(r.endpoint) + '">' + statusTag + nameHtml(r.model) + '</td>' +
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
      '<tr><td class="model">' + nameLink(m.name, m.libraryUrl || m.modelUrl, m.libraryUrl ? 'Ollama library page' : 'Hugging Face repo') +
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
// Header line, with a "?" right after the proxy status that opens the relay setup help under the header.
subscribeSource('ollama', (d, err) => {
  const a = document.getElementById('oMetaA'), b = document.getElementById('oMetaB'), btn = document.getElementById('oHeadHelpBtn');
  if (err) { a.textContent = 'Could not reach AI_SCOPE server: ' + err.message; b.textContent = ''; btn.hidden = true; return; }
  const px = d.proxy;
  a.textContent = (d.online ? 'connected to ' + d.url + (d.version ? ' · v' + d.version : '') : 'Ollama offline') +
    ' · proxy ' + (px.listening ? 'on :' + px.port : 'not running' + (px.error ? ' (' + px.error + ')' : ''));
  b.textContent = ' · ' + d.totalRequests + ' requests saved · updates every 2 s';
  btn.hidden = false;
  const box = document.getElementById('oHeadHelp'), html = ollamaHelpHtml(d);
  if (box.innerHTML !== html) box.innerHTML = html;
});
document.getElementById('oHeadHelpBtn').addEventListener('click', e => {
  const box = document.getElementById('oHeadHelp');
  box.hidden = !box.hidden;
  e.currentTarget.setAttribute('aria-expanded', String(!box.hidden));
});
mountScopePage('ollama', ['ollama.current', 'ollama.loaded', 'ollama.requests', 'ollama.installed']);
