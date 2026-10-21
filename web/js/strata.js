// AI_SCOPE dashboard - Strata tab: current request, loaded model (experts in VRAM), requests, installed models.
// Data: /api/strata (stratastats.js reads the Strata desktop app's own monitor JSON).

const fmtK = n => n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
// Context windows are powers of two: 65,536 -> "64K", like Strata shows them.
const fmtCtx = n => n == null ? '—' : n % 1024 === 0 ? (n / 1024) + 'K' : fmtK(n);
const fmtPct = f => f == null ? '—' : Math.round(f * 100) + '%';
let sSeen = new Set(), sFirst = true;
async function loadStrata() {
  if (!isInstalled('strata')) return;
  const $ = id => document.getElementById(id);
  let d;
  try { d = await (await fetch('/api/strata?limit=100', { cache:'no-store' })).json(); }
  catch (e) { $('sMeta').textContent = 'Could not reach AI_SCOPE server: ' + e.message; return; }
  $('sMeta').textContent = (d.online ? 'connected to ' + d.url + (d.version ? ' · Strata ' + d.version : '') + (d.engineVersion ? ' · engine ' + d.engineVersion : '')
    : 'Strata offline') + ' · ' + d.totalRequests + ' requests saved · updates every 2 s';

  // current request
  const cur = d.current, show = (id, on) => { $(id).hidden = !on; };
  const boxes = ['sTpsBox', 'sTokBox', 'sPromptBox', 'sCtxBox', 'sTimeBox'];
  $('sDot').className = 'dot' + (cur ? ' live' : d.online ? '' : ' off');
  if (!d.online) {
    $('sTitle').textContent = 'Strata is not running';
    $('sModel').textContent = ONONE;
    boxes.forEach(b => show(b, false));
    $('sFoot').textContent = d.error || '';
    setSysLoad('sLoad', false);
  } else if (cur) {
    $('sTitle').textContent = 'Current request' + (cur.queued ? ' (+' + cur.queued + ' queued)' : '');
    $('sModel').textContent = cur.model;
    boxes.forEach(b => show(b, true));
    const reading = cur.phase === 'reading' || cur.phase === 'loading';
    $('sTpsLabel').textContent = cur.phase === 'loading' ? 'Loading model' : reading ? 'Prompt tok/s' : cur.phase === 'thinking' ? 'Thinking · tok/s' : 'Current gen tok/s';
    $('sTps').textContent = reading ? (cur.prefillTokS ? fmtTps(cur.prefillTokS) : '…') : (cur.tokS != null ? fmtTps(cur.tokS) : '…');
    $('sTok').textContent = fmtNum(cur.generated) + (cur.maxTokens ? ' / ' + fmtK(cur.maxTokens) : '');
    // Prompt: read / total while reading; otherwise its size.
    const pr = cur.promptRead, pt = cur.promptTotal;
    $('sPromptLabel').textContent = pt ? 'Prompt read' : 'Prompt';
    $('sPrompt').textContent = pt ? fmtK(pr || 0) + ' / ' + fmtK(pt) : fmtK(cur.promptTokens);
    $('sPromptBar').style.width = pt ? Math.min(100, 100 * (pr || 0) / pt) + '%' : (cur.promptTokens ? '100%' : '0');
    $('sCtx').textContent = cur.contextUsed != null ? fmtK(cur.contextUsed) + (cur.contextMax ? ' / ' + fmtCtx(cur.contextMax) : '') : ONONE;
    $('sCtxBar').style.width = cur.contextUsed != null && cur.contextMax ? Math.min(100, 100 * cur.contextUsed / cur.contextMax) + '%' : '0';
    $('sTime').textContent = fmtSec(cur.elapsedMs);
    $('sFoot').textContent = cur.phaseText ? cur.phaseText.charAt(0).toUpperCase() + cur.phaseText.slice(1) : ' ';
    setSysLoad('sLoad', true);
  } else {
    const a = d.average, l = d.loaded;
    $('sTitle').textContent = l && l.phase === 'unavailable' ? 'Engine not answering' : l ? 'Idle — no request running' : 'No model loaded';
    $('sModel').textContent = l ? l.label : a ? a.model : ONONE;
    boxes.forEach(b => show(b, false));
    show('sTpsBox', !!a);
    $('sTpsLabel').textContent = a ? 'Avg gen tok/s (last ' + a.requests + ' requests)' : 'Avg gen tok/s';
    $('sTps').textContent = a ? fmtTps(a.genTps) : ONONE;
    $('sFoot').textContent = l ? ' ' : 'Load a model in Strata to see live stats.';
    setSysLoad('sLoad', false);
  }

  // loaded model
  const l = d.loaded;
  $('sLoaded').innerHTML = l ? '<tr><td class="model">' + escH(l.label) + '</td>' +
    '<td>' + escH(l.variant || ONONE) + '</td>' +
    '<td>' + (l.context ? fmtNum(l.context) : ONONE) + '</td>' +
    '<td>' + escH(l.kv ? l.kv.toUpperCase() : ONONE) + '</td>' +
    '<td>' + escH(l.gpus.length ? l.gpus.join(' + ') + ' + RAM' : 'CPU / RAM') + '</td>' +
    '<td title="Model experts kept in VRAM; the rest are read from RAM while answering">' +
      (l.expertSlots != null ? fmtNum(l.expertSlots) + (l.expertCacheMib != null ? '<span class="na"> · ' + fmtBytes(l.expertCacheMib * 1048576) + '</span>' : '') : ONONE) + '</td>' +
    '<td>' + (l.vramFreeMib != null ? fmtBytes(l.vramFreeMib * 1048576) : ONONE) + '</td>' +
    '<td>' + (l.speculation == null ? ONONE : l.speculation ? 'on' : 'off') + '</td>' +
    '<td title="' + escH(l.loadedAt || '') + '">' + (l.loadedAt ? escH(fmtWhen(Date.parse(l.loadedAt))) : ONONE) + '</td></tr>' : '';
  $('sLoadedEmpty').hidden = !!l;
  $('sLoadedEmpty').textContent = d.online ? 'No model loaded. Load one in Strata (Models).' : 'Strata is offline. Start the Strata app to see its model and requests.';
  $('sLoadedHint').textContent = l && l.error ? '— ' + l.error : '';

  // requests
  const t = d.totals;
  $('sReqHint').textContent = t && t.requests ? '— since load: ' + fmtNum(t.requests) + ' requests' +
    (t.promptTokens ? ' · ' + fmtNum(t.reused || 0) + ' of ' + fmtNum(t.promptTokens) + ' prompt tokens reused (' + Math.round(100 * (t.reused || 0) / t.promptTokens) + '%)' : '') +
    (t.draftsOffered ? ' · drafts ' + Math.round(100 * (t.draftsAccepted || 0) / t.draftsOffered) + '% accepted' : '') : '';
  $('sRowsEmpty').hidden = d.rows.length > 0;
  $('sRowsEmpty').textContent = 'No requests yet. Requests from Strata\'s chat and from apps using its API appear here once they finish.';
  $('sRows').innerHTML = paginate('strata', d.rows.map(r => {
    const isNew = !sFirst && !sSeen.has(r.key);
    sSeen.add(r.key);
    const genTip = [r.decodeMs != null ? 'decode ' + fmtSec(r.decodeMs) : null,
      r.draftsOffered ? 'drafts ' + fmtNum(r.draftsAccepted || 0) + ' of ' + fmtNum(r.draftsOffered) + ' accepted' : null].filter(Boolean).join(' · ');
    const promptTip = [r.promptRead != null ? fmtNum(r.promptRead) + ' tokens read' : null, r.promptMs != null ? 'in ' + fmtSec(r.promptMs) : null].filter(Boolean).join(' ');
    const status = r.finish && r.finish !== 'stop' && r.finish !== 'length' ? '<span class="status interrupted" title="finish: ' + escH(r.finish) + '">' + escH(r.finish) + '</span> ' : '';
    return '<tr' + (isNew ? ' class="new"' : '') + '>' +
      '<td>' + escH(fmtWhen(r.end)) + '</td>' +
      '<td class="model">' + status + escH(r.model) + '</td>' +
      '<td>' + fmtNum(r.promptTokens) + '</td>' +
      '<td title="Prompt tokens reused from the conversation cache (not read again)">' + fmtNum(r.reused) + '</td>' +
      '<td>' + fmtNum(r.outputTokens) + '</td>' +
      '<td class="tps" title="' + escH(genTip) + '">' + fmtTps(r.genTps) + '</td>' +
      '<td title="' + escH(promptTip) + '">' + (r.promptTps != null ? fmtTps(r.promptTps) : ONONE) + '</td>' +
      '<td>' + (r.firstTokenMs != null ? fmtSec(r.firstTokenMs) : ONONE) + '</td>' +
      '<td title="Share of needed experts already in VRAM (the rest came from RAM)">' + fmtPct(r.hitRate) + '</td>' +
      '<td>' + fmtSec(r.durationMs) + '</td>' + peakCell(r.peak) + '</tr>';
  }), 'sPager').join('');

  // installed models (Strata's own fit verdict: it keeps experts in RAM by design, so our VRAM fit doesn't apply)
  $('sInstHint').textContent = d.installed.length ? '— ' + d.installed.length + ' model' + (d.installed.length > 1 ? 's' : '') + ' · ' +
    fmtNum(Math.round(d.installed.reduce((a, m) => a + (m.diskGb || 0), 0))) + ' GB on disk · fit as judged by Strata for this PC' : '';
  $('sInst').innerHTML = d.installed.map(m =>
    '<tr><td class="model">' + escH(m.name) + (m.loaded ? '<span class="tag">loaded</span>' : '') + (m.images ? '<span class="tag">images</span>' : '') + '</td>' +
    '<td>' + escH(m.variant) + '</td>' +
    '<td>' + (m.diskGb != null ? m.diskGb.toFixed(1) + ' GB' : ONONE) + '</td>' +
    '<td>' + (m.context ? fmtNum(m.context) : ONONE) + '</td>' +
    '<td>' + (m.memoryGb != null ? m.memoryGb.toFixed(1) + ' GB' : ONONE) + '</td>' +
    '<td title="' + escH(m.fitSummary || '') + '">' + (m.onThisPc ? '<span class="fit ' + (m.onThisPc === 'fits' ? 'fits' : /does not fit/.test(m.onThisPc) ? 'spills' : 'tight') + '">' + escH(m.onThisPc) + '</span>' : ONONE) + '</td>' +
    '<td>' + (m.missingParts ? '<span class="status error">' + m.missingParts + ' parts missing</span>' : m.ready ? 'ready' : 'not ready') + '</td></tr>').join('');
  $('sInstEmpty').hidden = d.installed.length > 0;
  $('sInstEmpty').textContent = d.online ? 'No models installed in Strata.' : 'Strata is offline.';
  sFirst = false;
}
pagerReload.strata = loadStrata;
loadStrata();
setInterval(loadStrata, 2000);
