// AI_SCOPE dashboard - LM Studio tab: current request, requests (from its logs), loaded and installed models.

let seen = new Set(), first = true;

async function load() {
  if (!isInstalled('lmstudio')) return;
  try {
    const data = await (await fetch('/api/requests?limit=100', { cache: 'no-store' })).json();
    const err = document.getElementById('err');
    err.hidden = !data.error; err.textContent = data.error || '';
    const rows = data.rows.map(r => {
      const key = r.timestamp + '|' + r.task;
      const isNew = !first && !seen.has(key);
      seen.add(key);
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
    document.getElementById('rows').innerHTML = paginate('lmstudio', rows, 'lPager').join('');
    document.getElementById('meta').textContent =
      (lmApi ? (lmApi.online ? 'connected to ' + lmApi.url + ' (API ' + lmApi.apiVersion + ')' : 'LM Studio server offline') + ' · ' : '') +
      data.rows.length + ' latest requests · updated ' + new Date().toLocaleTimeString() + ' · updates every 2 s';
    renderCurrent(data.current, data.average);
    first = false;
  } catch (e) {
    document.getElementById('meta').textContent = 'Could not reach server: ' + e.message;
  }
}
function renderCurrent(cur, avg) {
  const $ = id => document.getElementById(id);
  $('nowDot').className = 'dot' + (cur ? ' live' : '');
  if (cur) {
    $('nowTitle').textContent = 'Current request' + (cur.othersRunning ? ' (+' + cur.othersRunning + ' more running)' : '');
    $('nowModel').textContent = cur.model;
    if (cur.phase === 'gen' && cur.genTps != null) {
      $('nowTpsLabel').textContent = 'Current gen tok/s';
      $('nowTps').textContent = fmtTps(cur.genTps);
    } else {
      const reading = cur.phase === 'prompt' && cur.progress < 1;
      $('nowTpsLabel').textContent = reading ? 'Reading prompt' : 'Current gen tok/s';
      $('nowTps').textContent = reading ? Math.round(cur.progress * 100) + '%' : 'starting…';
    }
    $('nowTimeBox').hidden = false;
    $('nowTime').textContent = fmtSec(cur.elapsedMs);
    $('nowTokBox').hidden = !(cur.phase === 'gen' && cur.genTokens);
    $('nowTok').textContent = fmtNum(cur.genTokens);
    setSysLoad('nowLoad', true);
  } else {
    $('nowTitle').textContent = 'Idle — no request running';
    $('nowModel').textContent = avg ? avg.model : '—';
    $('nowTpsLabel').textContent = avg ? 'Avg gen tok/s (last ' + avg.requests + ' requests)' : 'Avg gen tok/s';
    $('nowTps').textContent = avg ? fmtTps(avg.genTps) : '—';
    $('nowTimeBox').hidden = true;
    $('nowTokBox').hidden = true;
    setSysLoad('nowLoad', false);
  }
}

// ---- LM Studio models (REST API) ----
let lmApi = null;
async function loadLmModels() {
  if (!isInstalled('lmstudio')) return;
  const $ = id => document.getElementById(id);
  let d;
  try { d = await (await fetch('/api/lmstudio/models', { cache:'no-store' })).json(); } catch (e) { return; }
  lmApi = d;
  const onOff = v => v == null ? ONONE : v ? 'on' : 'off';
  $('lLoaded').innerHTML = d.loaded.map(m => {
    return '<tr><td class="model">' + extLink(m.id, m.modelUrl) + (m.quant ? '<span class="na"> · ' + escH(m.quant) + '</span>' : '') + '</td>' +
      '<td>' + escH(m.params || ONONE) + '</td>' +
      '<td>' + fmtBytes(m.size) + '</td>' +
      '<td>' + (m.context ? fmtNum(m.context) + (m.maxContext ? '<span class="na"> / ' + fmtNum(m.maxContext) + '</span>' : '') : ONONE) + '</td>' +
      '<td>' + onOff(m.flashAttention) + '</td>' +
      '<td>' + (m.kvOnGpu == null ? ONONE : m.kvOnGpu ? 'GPU' : 'CPU') + '</td>' +
      '<td>' + (m.parallel != null ? m.parallel : ONONE) + '</td>' +
      '<td>' + (m.ttlMs ? fmtDur(m.ttlMs) + ' idle' : 'off') + '</td></tr>';
  }).join('');
  $('lLoadedEmpty').hidden = d.loaded.length > 0;
  $('lLoadedEmpty').textContent = d.online ? 'No model loaded. Load one in LM Studio, or it loads on the first request (JIT loading).'
    : 'LM Studio server is not reachable' + (d.error ? ' (' + d.error + ')' : '') + '. Start the server in LM Studio (Developer tab) to see models.';
  const vt = d.vramTotal;
  const big = vt ? d.loaded.filter(m => m.size && m.size > vt) : [];
  $('lLoadedHint').textContent = big.length ? (d.vramCards > 1 ? '— larger than one card (' + fmtBytes(vt) + ' VRAM), so it is split across GPUs or partly in system RAM' : '— larger than ' + fmtBytes(vt) + ' VRAM, so part of it runs from system RAM') : (d.loaded.length ? '— LM Studio does not report GPU offload; compare VRAM on the SYSTEM tab' : '');

  const fitText = { fits:'fits', tight:'tight', spills:'partly CPU' };
  $('lInst').innerHTML = d.installed.map(m => {
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
  $('lInstEmpty').hidden = d.installed.length > 0;
  $('lInstEmpty').textContent = d.online ? 'No models found.' : 'LM Studio server is not reachable.';
  $('lInstHint').textContent = d.installed.length ? '— ' + d.installed.length + ' models · ' + fmtBytes(d.installed.reduce((a, m) => a + (m.size || 0), 0)) + ' on disk' +
    (vt ? ' · fit is weights vs ' + vramWord(d) + ' (context adds more)' : '') : '';
}
loadLmModels();
setInterval(loadLmModels, 2000);

pagerReload.lmstudio = load;
load();
setInterval(load, 2000);
