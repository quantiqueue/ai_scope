// AI_SCOPE dashboard - Strata scope: current request, loaded model (experts in VRAM), requests, installed models.
// Data: /api/strata (stratastats.js reads the Strata desktop app's own monitor JSON).
// Every card/table is a lens (lens.js), so it can also be shown on custom scopes, more than once.

const fmtK = n => n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
// Context windows are powers of two: 65,536 -> "64K", like Strata shows them.
const fmtCtx = n => n == null ? '—' : n % 1024 === 0 ? (n / 1024) + 'K' : fmtK(n);
const fmtPct = f => f == null ? '—' : Math.round(f * 100) + '%';

defineSource('strata', '/api/strata?limit=100');

// ---------- Current request ----------
defineLens({
  id: 'strata.current', scope: 'strata', size: 'wide',
  name: 'Current request',
  description: 'What Strata is answering right now: speed, tokens, prompt, context and the model process\'s GPU, VRAM, CPU and RAM use.',
  settings: [PROC_STATS_FIELD],
  markup: nowCardMarkup([
    { box:'tpsBox', label:'Current gen tok/s', labelK:'tpsLabel', k:'tps' },
    { box:'tokBox', label:'Tokens so far', k:'tok', small:true },
    { box:'promptBox', label:'Prompt', labelK:'promptLabel', k:'prompt', small:true, bar:'promptBar' },
    { box:'ctxBox', label:'Context', k:'ctx', small:true, bar:'ctxBar' },
    { box:'timeBox', label:'Elapsed', k:'time' },
  ]),
  render(L, d) {
    const $ = L.$, cur = d.current, show = (k, on) => { $(k).hidden = !on; };
    const boxes = ['tpsBox', 'tokBox', 'promptBox', 'ctxBox', 'timeBox'];
    $('dot').className = 'dot' + (cur ? ' live' : d.online ? '' : ' off');
    if (!d.online) {
      $('title').textContent = 'Strata is not running';
      setName($('model'), ONONE);
      boxes.forEach(b => show(b, false));
      $('foot').textContent = d.error || '';
      setSysLoad($('load'), false);
    } else if (cur) {
      // state line: what the request is doing (the lens title is in the header tab)
      // Strata's own wording when it has one ("reading the prompt", "writing a tool call: glob"), else from the phase
      const doing = cur.phaseText ? cur.phaseText.charAt(0).toLowerCase() + cur.phaseText.slice(1)
        : { loading:'loading model', reading:'reading prompt', thinking:'thinking', generating:'generating' }[cur.phase] || 'working';
      $('title').textContent = 'Running — ' + doing + (cur.queued ? ' (+' + cur.queued + ' queued)' : '');
      setName($('model'), cur.model);
      boxes.forEach(b => show(b, true));
      const reading = cur.phase === 'reading' || cur.phase === 'loading';
      $('tpsLabel').textContent = cur.phase === 'loading' ? 'Loading model' : reading ? 'Prompt tok/s' : cur.phase === 'thinking' ? 'Thinking · tok/s' : 'Current gen tok/s';
      $('tps').textContent = reading ? (cur.prefillTokS ? fmtTps(cur.prefillTokS) : '…') : (cur.tokS != null ? fmtTps(cur.tokS) : '…');
      $('tok').textContent = fmtNum(cur.generated) + (cur.maxTokens ? ' / ' + fmtK(cur.maxTokens) : '');
      // Prompt: read / total while reading; otherwise its size.
      const pr = cur.promptRead, pt = cur.promptTotal;
      $('promptLabel').textContent = pt ? 'Prompt read' : 'Prompt';
      $('prompt').textContent = pt ? fmtK(pr || 0) + ' / ' + fmtK(pt) : fmtK(cur.promptTokens);
      $('promptBar').style.width = pt ? Math.min(100, 100 * (pr || 0) / pt) + '%' : (cur.promptTokens ? '100%' : '0');
      $('ctx').textContent = cur.contextUsed != null ? fmtK(cur.contextUsed) + (cur.contextMax ? ' / ' + fmtCtx(cur.contextMax) : '') : ONONE;
      $('ctxBar').style.width = cur.contextUsed != null && cur.contextMax ? Math.min(100, 100 * cur.contextUsed / cur.contextMax) + '%' : '0';
      $('time').textContent = fmtSec(cur.elapsedMs);
      $('foot').textContent = '';   // the state is on the top line (an empty foot line is hidden)
      // Strata's model process (strata.exe) when known (Windows); hidden on Windows without one, whole-computer System load elsewhere
      setSysLoad($('load'), L.settings.procStats !== false && (!(d.processSupported && !d.process)), d.process, 'Strata');
    } else {
      const a = d.average, l = d.loaded;
      $('title').textContent = l && l.phase === 'unavailable' ? 'Engine not answering' : l ? 'Idle — no request running' : 'No model loaded';
      setName($('model'), l ? l.label : a ? a.model : ONONE);
      boxes.forEach(b => show(b, false));
      show('tpsBox', !!a);
      $('tpsLabel').textContent = a ? 'Avg gen tok/s (last ' + a.requests + ' requests)' : 'Avg gen tok/s';
      $('tps').textContent = a ? fmtTps(a.genTps) : ONONE;
      // what to do to see live stats: load a model, then send a message
      $('foot').textContent = !l ? 'Load a model in Strata to see live stats.'
        : l.phase === 'unavailable' ? 'Strata\'s engine isn\'t answering. Check the Strata app.'
        : 'Send a message in Strata (or a request to its API) to see live stats.';
      setSysLoad($('load'), false);
    }
  },
});

// ---------- Loaded model ----------
defineLens({
  id: 'strata.loaded', scope: 'strata', size: 'full',
  name: 'Loaded model',
  description: 'The model Strata has loaded: variant, context, KV cache, GPUs, experts in VRAM, free VRAM.',
  markup: tableLensMarkup({ title:'Loaded model',
    cols:['Model', 'Variant', 'Context', 'KV cache', 'GPUs', 'Experts in VRAM', 'Free VRAM', 'Speculation', 'Loaded'] }),
  render(L, d) {
    const $ = L.$, l = d.loaded;
    $('rows').innerHTML = l ? '<tr><td class="model">' + nameHtml(l.label) + '</td>' +
      '<td>' + escH(l.variant || ONONE) + '</td>' +
      '<td>' + (l.context ? fmtNum(l.context) : ONONE) + '</td>' +
      '<td>' + escH(l.kv ? l.kv.toUpperCase() : ONONE) + '</td>' +
      '<td>' + escH(l.gpus.length ? l.gpus.join(' + ') + ' + RAM' : 'CPU / RAM') + '</td>' +
      '<td title="Model experts kept in VRAM; the rest are read from RAM while answering">' +
        (l.expertSlots != null ? fmtNum(l.expertSlots) + (l.expertCacheMib != null ? '<span class="na"> · ' + fmtBytes(l.expertCacheMib * 1048576) + '</span>' : '') : ONONE) + '</td>' +
      '<td>' + (l.vramFreeMib != null ? fmtBytes(l.vramFreeMib * 1048576) : ONONE) + '</td>' +
      '<td>' + (l.speculation == null ? ONONE : l.speculation ? 'on' : 'off') + '</td>' +
      '<td title="' + escH(l.loadedAt || '') + '">' + (l.loadedAt ? escH(fmtWhen(Date.parse(l.loadedAt))) : ONONE) + '</td></tr>' : '';
    $('empty').hidden = !!l;
    $('empty').textContent = d.online ? 'No model loaded. Load one in Strata (Models).' : 'Strata is offline. Start the Strata app to see its model and requests.';
    const where = l ? procVramText(d.process) : '';   // per-card VRAM of the model process (Windows, AI_SCOPE-051)
    $('hint').textContent = [where, l && l.error ? l.error : ''].filter(Boolean).map((t, i) => (i ? '' : '— ') + t).join(' · ');
  },
});

// ---------- Requests ----------
defineLens({
  id: 'strata.requests', scope: 'strata', size: 'full',
  name: 'Requests',
  description: 'Finished requests: tokens, reused prompt, speeds, first token, hit rate, duration, peak load.',
  settings: [PER_PAGE_FIELD],
  markup: tableLensMarkup({ title:'Requests', pager:true,
    cols:['Finished', 'Model', 'Prompt', 'Reused', 'Output', 'Gen tok/s', 'Prompt tok/s', 'First token', 'Hit rate', 'Duration', 'Peak load'] }),
  render(L, d) {
    const $ = L.$, t = d.totals;
    $('hint').textContent = t && t.requests ? '— since load: ' + fmtNum(t.requests) + ' requests' +
      (t.promptTokens ? ' · ' + fmtNum(t.reused || 0) + ' of ' + fmtNum(t.promptTokens) + ' prompt tokens reused (' + Math.round(100 * (t.reused || 0) / t.promptTokens) + '%)' : '') +
      (t.draftsOffered ? ' · drafts ' + Math.round(100 * (t.draftsAccepted || 0) / t.draftsOffered) + '% accepted' : '') : '';
    $('empty').hidden = d.rows.length > 0;
    $('empty').textContent = 'No requests yet. Requests from Strata\'s chat and from apps using its API appear here once they finish.';
    $('rows').innerHTML = paginate(L.key, d.rows.map(r => {
      const isNew = isNewRow(L, r.key);
      const genTip = [r.decodeMs != null ? 'decode ' + fmtSec(r.decodeMs) : null,
        r.draftsOffered ? 'drafts ' + fmtNum(r.draftsAccepted || 0) + ' of ' + fmtNum(r.draftsOffered) + ' accepted' : null].filter(Boolean).join(' · ');
      const promptTip = [r.promptRead != null ? fmtNum(r.promptRead) + ' tokens read' : null, r.promptMs != null ? 'in ' + fmtSec(r.promptMs) : null].filter(Boolean).join(' ');
      const status = r.finish && r.finish !== 'stop' && r.finish !== 'length' ? '<span class="status interrupted" title="finish: ' + escH(r.finish) + '">' + escH(r.finish) + '</span> ' : '';
      return '<tr' + (isNew ? ' class="new"' : '') + '>' +
        '<td>' + escH(fmtWhen(r.end)) + '</td>' +
        '<td class="model">' + status + nameHtml(r.model) + '</td>' +
        '<td>' + fmtNum(r.promptTokens) + '</td>' +
        '<td title="Prompt tokens reused from the conversation cache (not read again)">' + fmtNum(r.reused) + '</td>' +
        '<td>' + fmtNum(r.outputTokens) + '</td>' +
        '<td class="tps" title="' + escH(genTip) + '">' + fmtTps(r.genTps) + '</td>' +
        '<td title="' + escH(promptTip) + '">' + (r.promptTps != null ? fmtTps(r.promptTps) : ONONE) + '</td>' +
        '<td>' + (r.firstTokenMs != null ? fmtSec(r.firstTokenMs) : ONONE) + '</td>' +
        '<td title="Share of needed experts already in VRAM (the rest came from RAM)">' + fmtPct(r.hitRate) + '</td>' +
        '<td>' + fmtSec(r.durationMs) + '</td>' + peakCell(r.peak) + '</tr>';
    }), $('pager'), L.settings.perPage).join('');
    rowsDrawn(L);
  },
});

// ---------- Installed models ----------
// Strata's own fit verdict: it keeps experts in RAM by design, so our VRAM fit doesn't apply.
defineLens({
  id: 'strata.installed', scope: 'strata', size: 'full',
  name: 'Installed models',
  description: 'Models installed in Strata, with size on disk, memory needed and Strata\'s own fit verdict.',
  settings: [PER_PAGE_FIELD],
  markup: tableLensMarkup({ title:'Installed models', pager:true,
    cols:['Model', 'Variant', 'On disk', 'Context', 'Memory needed', 'On this PC (Strata)', 'Status'] }),
  render(L, d) {
    const $ = L.$;
    $('hint').textContent = d.installed.length ? '— ' + d.installed.length + ' model' + (d.installed.length > 1 ? 's' : '') + ' · ' +
      fmtNum(Math.round(d.installed.reduce((a, m) => a + (m.diskGb || 0), 0))) + ' GB on disk · fit as judged by Strata for this PC' : '';
    $('rows').innerHTML = paginate(L.key, d.installed.map(m =>
      '<tr><td class="model">' + nameHtml(m.name) + (m.loaded ? '<span class="tag">loaded</span>' : '') + (m.images ? '<span class="tag">images</span>' : '') + '</td>' +
      '<td>' + escH(m.variant) + '</td>' +
      '<td>' + (m.diskGb != null ? m.diskGb.toFixed(1) + ' GB' : ONONE) + '</td>' +
      '<td>' + (m.context ? fmtNum(m.context) : ONONE) + '</td>' +
      '<td>' + (m.memoryGb != null ? m.memoryGb.toFixed(1) + ' GB' : ONONE) + '</td>' +
      '<td title="' + escH(m.fitSummary || '') + '">' + (m.onThisPc ? '<span class="fit ' + (m.onThisPc === 'fits' ? 'fits' : /does not fit/.test(m.onThisPc) ? 'spills' : 'tight') + '">' + escH(m.onThisPc) + '</span>' : ONONE) + '</td>' +
      '<td>' + (m.missingParts ? '<span class="status error">' + m.missingParts + ' parts missing</span>' : m.ready ? 'ready' : 'not ready') + '</td></tr>'), $('pager'), L.settings.perPage).join('');
    $('empty').hidden = d.installed.length > 0;
    $('empty').textContent = d.online ? 'No models installed in Strata.' : 'Strata is offline.';
  },
});

// ---------- Hardware Mirror Lenses for Strata (AI_SCOPE-072 / 073 / 075 / 076) ----------
// The four process tiles (strata.gpu / strata.ram / strata.cpu / strata.io) are the family's first members;
// since AI_SCOPE-077 they come from defineMirror() in web/js/mirror.js, which every app scope shares. The
// lens ids and tile ids are unchanged ('s' prefixes), so saved layouts and the hover keep working.
const STRATA_MIRROR = defineMirror({ key: 'strata', name: 'Strata', letter: 's' });

// ---------- The Strata scope page: header line + its lenses ----------
subscribeSource('strata', (d, err) => {
  const meta = document.getElementById('sMeta');
  if (err) { meta.textContent = 'Could not reach AI_SCOPE server: ' + err.message; return; }
  meta.textContent = (d.online ? 'connected to ' + d.url + (d.version ? ' · Strata ' + d.version : '') + (d.engineVersion ? ' · engine ' + d.engineVersion : '')
    : 'Strata offline') + ' · ' + d.totalRequests + ' requests saved · updates every 2 s';
});
// AI_SCOPE-072: default gets one row of Strata GPU + VRAM tiles per card after Installed Models; on macOS the
// tiles stay out of the default (no per-process GPU stats there) but remain addable - they answer
// "Not available on this system" until 062 changes that.
// AI_SCOPE-073: a new row at the very bottom, "Strata RAM (Working)" + "Strata RAM (Committed)" - on every OS,
// since per-process RAM exists on Linux / macOS too. AI_SCOPE-075: "Strata CPU" leads that same row, also on
// every OS (procstats reports CPU % on Windows, Linux and macOS). AI_SCOPE-076: "Strata I/O" closes that row
// (the tile answers "Windows only for now" where the counters do not exist).
// AI_SCOPE-077: the mirror rows come from the shared family helper - same items, same order, same ids.
defineScopeLayout('strata', () => layoutOf([{ lens: 'strata.current', settings: { width: 'full' } }, 'strata.loaded', 'strata.requests', 'strata.installed']).concat(STRATA_MIRROR.layout()));
