// AI_SCOPE dashboard - Strata scope: current request, loaded model (experts in VRAM), requests, installed models.
// Data: /api/strata (stratastats.js reads the Strata desktop app's own monitor JSON).
// Every card/table is a lens (lens.js), so it can also be shown on custom scopes, more than once.

const fmtK = n => n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
// Context windows are powers of two: 65,536 -> "64K", like Strata shows them.
const fmtCtx = n => n == null ? '—' : n % 1024 === 0 ? (n / 1024) + 'K' : fmtK(n);
const fmtPct = f => f == null ? '—' : Math.round(f * 100) + '%';

defineSource('strata', '/api/strata?limit=100', null, null, null, 'processHistory');   // AI_SCOPE-084: the history ring goes out as a delta (?since=)

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

// ---------- Strata Gen tok/s (AI_SCOPE-093 slice 1) ----------
// Big value: Strata's own live tok/s while a request runs; when it does not, the token-weighted average of the
// loaded model's last 20 saved requests (d.average - the same server-computed number the running card prints).
// The line covers ONLY time actually spent generating: idle polls write no points, so between requests the chart
// honestly breaks (092 reads each point's own `every` stamp) - no invented zeros, no fabricated history (077/072).
// Window: the shared 5 minutes (SPARK_WIN), and since 2026-11-01 the LINE is pinned to the clock (sparkFresh):
// a burst ages out of the chart five minutes after its last sample, like the always-on sparklines. The big value
// is NOT time-bound (D2 unchanged). The meter and chart scale to the (fresh) window max, and the spark's title
// says so. Hover rides hardware.js's MIRROR_HOVER dispatch (prefix 'stps').
const TPS_HIST = [];   // client ring merged from the payload - the append-and-prune shape mirror.js established
subscribeSource('strata', d => {
  const add = (d && d.tpsHistory) || [];
  if (add.length) {
    const last = TPS_HIST.length ? TPS_HIST[TPS_HIST.length - 1].t : 0;
    for (const p of add) if (p && p.t > last) TPS_HIST.push(p);
    sparkPrune(TPS_HIST);                                                      // 092: time-sized, one older sample kept
    if (TPS_HIST.length > 240) TPS_HIST.splice(0, TPS_HIST.length - 240);      // runaway-pace safety cap only
  }
});
const TPS_TIP = 'Generation speed of Strata\'s running request - the engine\'s own live tok/s. While nothing runs, the big number is the token-weighted average of the loaded model\'s last 20 saved requests. The line covers only time actually spent generating; the gaps between requests are breaks, not zeros.';
defineLens({
  id: 'strata.tps', scope: 'strata', size: 'tile',
  name: 'Gen tok/s',
  description: 'Strata generation speed with a 5-minute history: live tok/s while a request runs, the average of the last 20 requests when not.',
  markup: () => tileHtml({ id: 'stps', label: 'Strata Gen tok/s' }),
  render(L, d) {
    const box = L.el.querySelector('[data-tile="stps"]'); if (!box) return;
    box.querySelector('.ltitle').title = TPS_TIP;
    const pts = sparkFresh(TPS_HIST);
    const maxT = Math.max(10, 1.25 * pts.reduce(function (a, x) { return Math.max(a, x.v || 0); }, 0));   // window only: "top of the chart" is what you SEE
    const segs = sparkSegs(pts, h => h.v == null ? null : Math.min(100, 100 * h.v / maxT));
    const run = d.current && d.current.tokS != null ? d.current.tokS : null;
    const avg = d.average && d.average.genTps != null ? d.average.genTps : null;
    const v = run != null ? run : (d.current ? null : avg);   // active but Strata has not reported tok_s yet: n/a - never substitute the average
    const meter = v == null ? null : Math.min(100, 100 * v / maxT);
    sparkTile(box, meter, v == null ? NA_HTML : fmtTps(v),
      d.current ? (run != null ? 'live · ' + cutName(d.current.model) : 'no live tok/s yet')
        : avg != null ? 'avg last ' + d.average.requests + ' · ' + cutName(d.average.model)
        : d.online ? 'no requests recorded yet' : 'Strata Offline',
      segs);
    box.querySelector('.spark').title = 'Top of the chart = ' + fmtTps(maxT) + ' tok/s (window max)';
  },
});
MIRROR_HOVER.push({ prefix: 'stps', fn: (spark, f, guide, tip) => {   // tok/s at that time, model named - the axis rule is the shared one
  sparkHover(spark, f, guide, tip, sparkFresh(TPS_HIST), hs => (hs.v != null ? fmtTps(hs.v) + (hs.m ? ' · ' + cutName(hs.m) : '') : 'n/a'));
} });

// ---------- Strata Prompt tok/s (AI_SCOPE-093 slice 2) ----------
// Same shape as the gen tile, its own ring (d.promptHistory) and its own honesty rule: the server only samples
// Strata's running prefill mean during the prompt phases, so points exist only while a prompt is being read.
// Big value: live prefill tok/s while reading; the token-weighted average of the loaded model's last 20 saved
// requests (d.promptAverage, built exactly like d.average) when it is not. While another request is GENERATING
// the big value is that historical average - never a replay of a finished prefill's mean as a live number.
// REVISED 2026-11-01 (user: "i think that should have the same neighbour treatment as hit rate"): Strata's
// prefill mean goes absent for 16-18 s in the MIDDLE of a continuing prompt, and the pace-stamped ring broke
// one run into clusters with hover "n/a" holes. The server now stamps each ptps point with the real wait
// since the previous sample, so the line joins neighbours across dropouts (no invented points); this hover
// snaps to the nearest SAMPLE and prints that sample's own time - never n/a while the ring holds points.
// Window: like gen, the LINE cuts at now - SPARK_WIN (sparkFresh, 2026-11-01); the big value is not time-bound.
const PTPS_HIST = [];
subscribeSource('strata', d => {
  const add = (d && d.promptHistory) || [];
  if (add.length) {
    const last = PTPS_HIST.length ? PTPS_HIST[PTPS_HIST.length - 1].t : 0;
    for (const p of add) if (p && p.t > last) PTPS_HIST.push(p);
    sparkPrune(PTPS_HIST);
    if (PTPS_HIST.length > 240) PTPS_HIST.splice(0, PTPS_HIST.length - 240);
  }
});
const PTPS_TIP = 'Prompt-processing speed of Strata\'s running request - the engine\'s own live prefill tok/s (tokens actually read into the context after cache reuse, over prefill time). While no prompt is being read, the big number is the token-weighted average of the loaded model\'s last 20 saved requests. The line covers only time actually spent reading prompts; the gaps between them are breaks, not zeros.';
const READ_PHASES = { reading: 1, thinking: 1 };   // the same phase gate the server ring samples under
defineLens({
  id: 'strata.ptps', scope: 'strata', size: 'tile',
  name: 'Prompt tok/s',
  description: 'Strata prompt-processing speed with a 5-minute history: live prefill tok/s while a prompt is read, the average of the last 20 requests when not.',
  markup: () => tileHtml({ id: 'sptps', label: 'Strata Prompt tok/s' }),
  render(L, d) {
    const box = L.el.querySelector('[data-tile="sptps"]'); if (!box) return;
    box.querySelector('.ltitle').title = PTPS_TIP;
    const pts = sparkFresh(PTPS_HIST);
    const maxT = Math.max(100, 1.25 * pts.reduce(function (a, x) { return Math.max(a, x.v || 0); }, 0));   // window only; floor is a prompt-scale 100 tok/s
    const segs = sparkSegs(pts, h => h.v == null ? null : Math.min(100, 100 * h.v / maxT));
    const read = d.current && READ_PHASES[d.current.phase];
    const live = read && d.current.prefillTokS != null ? d.current.prefillTokS : null;
    const avg = d.promptAverage && d.promptAverage.promptTps != null ? d.promptAverage.promptTps : null;
    const v = live != null ? live : avg;   // reading without a reported mean yet falls to the average too - the ring's absence is honest, a fake n/a between numbers is not
    const meter = v == null ? null : Math.min(100, 100 * v / maxT);
    sparkTile(box, meter, v == null ? NA_HTML : fmtTps(v),
      live != null ? 'live · ' + cutName(d.current.model)
        : read ? 'reading prompt - no live speed yet'
        : avg != null ? 'avg last ' + d.promptAverage.requests + ' · ' + cutName(d.promptAverage.model)
        : d.online ? 'no prompts recorded yet' : 'Strata Offline',
      segs);
    box.querySelector('.spark').title = 'Top of the chart = ' + fmtTps(maxT) + ' tok/s (window max)';
  },
});
MIRROR_HOVER.push({ prefix: 'sptps', fn: (spark, f, guide, tip) => {   // nearest sample by time, its OWN time printed (neighbour join, 2026-11-01)
  const pts = sparkFresh(PTPS_HIST); if (!pts.length) return;
  const r = sparkRange(pts), tc = r.t0 + f * (r.t1 - r.t0);
  let best = pts[0];
  for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].t - tc) < Math.abs(best.t - tc)) best = pts[i];
  const x = sparkX(best.t, r);
  guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.style.display = '';
  tip.hidden = false; tip.style.left = x + '%';
  tip.textContent = (best.v != null ? fmtTps(best.v) + ' tok/s' : 'n/a') + ' · ' + new Date(best.t).toLocaleTimeString() + (best.m ? ' · ' + cutName(best.m) : '');
} });

// ---------- Strata Context (AI_SCOPE-093 slice 3) ----------
// Context fill, same time axis: one point per 2 s poll while a request runs (prompt + generated - the number the
// running card shows, sampled with the identical computation so the two can never disagree). Each run is a rising
// ramp; between runs the line breaks. Window: the LINE cuts at now - SPARK_WIN (sparkFresh, 2026-11-01); an idle
// stretch ages the board out. Big value: live while running; while idle it is the fill the engine was
// LAST SEEN HOLDING - a real claim only while the same instance is still loaded (server-checked, d.contextState;
// Strata keeps its KV cache between requests, which is what makes the next turn reuse millions of tokens).
const CTX_HIST = [];
subscribeSource('strata', d => {
  const add = (d && d.contextHistory) || [];
  if (add.length) {
    const last = CTX_HIST.length ? CTX_HIST[CTX_HIST.length - 1].t : 0;
    for (const p of add) if (p && p.t > last) CTX_HIST.push(p);
    sparkPrune(CTX_HIST);
    if (CTX_HIST.length > 240) CTX_HIST.splice(0, CTX_HIST.length - 240);
  }
});
const CTX_TIP = 'How full the loaded model\'s context window is. While a request runs this is the live fill (the running card\'s Context number). While idle it is the fill the engine was last seen holding - Strata keeps its KV cache between requests on the same loaded model; an unload or a model change clears the claim and the tile says so.';
defineLens({
  id: 'strata.ctx', scope: 'strata', size: 'tile',
  name: 'Context',
  description: 'Strata context-window fill with a 5-minute history: live prompt + generated tokens while a request runs, the last-held fill when idle (same loaded model only).',
  markup: () => tileHtml({ id: 'sctx', label: 'Strata Context' }),
  render(L, d) {
    const box = L.el.querySelector('[data-tile="sctx"]'); if (!box) return;
    box.querySelector('.ltitle').title = CTX_TIP;
    const st = d.contextState;
    const pts = sparkFresh(CTX_HIST);
    const ceil = (st && st.max) || Math.max(1, pts.reduce(function (a, x) { return Math.max(a, x.v || 0); }, 0));   // the loaded window when known, else what the line reached
    const segs = sparkSegs(pts, h => h.v == null ? null : Math.min(100, 100 * h.v / ceil));
    const big = st && st.used != null ? fmtK(st.used) + (st.max ? '<small> / ' + fmtCtx(st.max) + '</small>' : '') : NA_HTML;
    const meter = st && st.used != null && st.max ? Math.min(100, 100 * st.used / st.max) : null;
    sparkTile(box, meter, big,
      st ? (st.live ? 'live · ' + cutName(st.model) : 'held since ' + fmtWhen(st.at) + ' · ' + cutName(st.model))
        : d.loaded ? 'no request has run yet'
        : d.online ? 'No Model Loaded' : 'Strata Offline',
      segs);
    box.querySelector('.spark').title = 'Top of the chart = ' + fmtCtx(ceil);
  },
});
MIRROR_HOVER.push({ prefix: 'sctx', fn: (spark, f, guide, tip) => {   // fill at that time
  sparkHover(spark, f, guide, tip, sparkFresh(CTX_HIST), hs => (hs.v != null ? fmtK(hs.v) + ' tok' + (hs.m ? ' · ' + cutName(hs.m) : '') : 'n/a'));
} });

// ---------- Strata Hit rate (AI_SCOPE-093 slice 4) ----------
// The expert-VRAM hit rate of FINISHED requests - Strata's own hit_rate, the exact number the Requests table's
// Hit rate column shows (share of needed experts already in VRAM; the rest came from RAM). First EVENT-keyed
// series in 093 (open question 3): the point is the request, not the poll.
// No new server ring, no new payload field - d.rows (the last 100 saved requests the source already sends) ARE
// the series: requests persist in strata-requests.jsonl, so the lens keeps history across reloads and model
// switches, and 094 inherits one copy to unify rather than a fifth. A request that reports no hit rate carries
// no point at all - the line joins its neighbours across it (never a zero - 072 no-invented-numbers rule).
// H1 REVISED (user, 2026-11-01: "it should be connected"): the x axis is the REQUEST SEQUENCE, not the clock.
// One even step per kept request, every neighbour joined by the line; the clock survives in the labels (the
// sub prints the newest request's end time, the hover names each point's). The 092 time axis compressed the
// same 100 events into their real span, so one idle night stretched x over ~12 h: a dense burst squashed to
// a left sliver and the newest request stood alone at the right edge - a 1-point polyline draws nothing, so
// the latest hit rate was on the board but invisible. A flat stretch here means "requests kept coming out
// like this", never "a number during idle". The ring lenses (tps/ptps/ctx) KEEP the clock axis and its
// breaks: their gaps are the information; a per-request share has no clock face to gap across.
// sparkSegs is still the painter: points carry t = sequence index and every: 1, so no gap can ever break
// (the 1.5 s floor dwarfs 1) and x spans 0-100 across the kept requests. Hover cannot use the shared
// sparkHover (it reads cursor time against point times and prints the cursor's clock) - an index series
// picks the nearest REQUEST by index and prints that request's own end time, same guide/tip painting.
// The count rule (last 100 saved requests, no time cut) is SUPERSEDED 2026-11-01 (user: "i want the window to be
// 5 min, just like other similar sparklines"): the LINE rides the same 5-minute window as the ring lenses, pinned
// to the clock - only requests that ENDED inside the last SPARK_WIN draw, and an idle stretch ages the line out.
// Big value (H2, = the user's spec: live AND idle both the latest finished request): NOT time-bound; the sub line
// names when it ended, so an empty line still answers honestly. Scale (H3): a bounded share, so chart and meter
// sit on a fixed 0-100%.
let HIT_PTS = [];   // the series the last render drew; the hover reads it - no separate ring, the rows ARE the data
const HIT_TIP = 'Share of the model\'s needed experts already in VRAM at each finished request (the rest came from RAM) - Strata\'s own number, the same the Requests table shows. Each step is one finished request, in order and evenly spaced (the axis is the request sequence, not the clock); the hover names each request\'s end time. The big number is the latest finished request, however old; the line covers the requests that ended in the last 5 minutes.';
defineLens({
  id: 'strata.hit', scope: 'strata', size: 'tile',
  name: 'Hit rate',
  description: 'Strata expert-VRAM hit rate per finished request: the requests of the last 5 minutes as a line, the latest request\'s number as the big value.',
  markup: () => tileHtml({ id: 'shrate', label: 'Strata Hit rate' }),
  render(L, d) {
    const box = L.el.querySelector('[data-tile="shrate"]'); if (!box) return;
    box.querySelector('.ltitle').title = HIT_TIP;
    const rows = Array.isArray(d.rows) ? d.rows : [];                     // newest first, the source's own order
    const finished = rows.filter(r => r && r.hitRate != null && r.end != null);   // no rate / no end time: no point
    const kept = finished.filter(r => r.end >= Date.now() - SPARK_WIN);   // 5-minute line window, pinned to the clock (2026-11-01)
    HIT_PTS = kept.slice().reverse().map((r, i) => ({ t: i, every: 1, v: r.hitRate, m: r.model, end: r.end }));   // index axis, oldest first
    const segs = sparkSegs(HIT_PTS, h => h.v == null ? null : 100 * h.v); // fixed scale: the share IS the percent
    const last = finished[0];
    const v = last ? last.hitRate : null;
    sparkTile(box, v == null ? null : 100 * v, v == null ? NA_HTML : fmtPct(v),
      last ? 'last req · ' + fmtWhen(last.end) + ' · ' + cutName(last.model)
        : d.online ? 'no requests recorded yet' : 'Strata Offline',
      segs);
    box.querySelector('.spark').title = 'Top of the chart = 100% (fixed) · one step per request, in order';
  },
});
MIRROR_HOVER.push({ prefix: 'shrate', fn: (spark, f, guide, tip) => {   // nearest REQUEST by index; its own end time, not the cursor's
  const n = HIT_PTS.length; if (!n) return;
  const ix = Math.max(0, Math.min(n - 1, Math.round(f * (n - 1))));
  const p = HIT_PTS[ix], x = n > 1 ? 100 * ix / (n - 1) : 100;
  guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.style.display = '';
  tip.hidden = false; tip.style.left = x + '%';
  tip.textContent = (p.v != null ? fmtPct(p.v) : 'n/a') + ' · ended ' + fmtWhen(p.end) + (p.m ? ' · ' + cutName(p.m) : '');
} });

// AI_SCOPE-088: the scope-header helper text is gone - the header shows only the title (user direction 2026-10-31).
// AI_SCOPE-072: default gets one row of Strata GPU + VRAM tiles per card after Installed Models; on macOS the
// tiles stay out of the default (no per-process GPU stats there) but remain addable - they answer
// "Not available on this system" until 062 changes that.
// AI_SCOPE-073: a new row at the very bottom, "Strata RAM (Working)" + "Strata RAM (Committed)" - on every OS,
// since per-process RAM exists on Linux / macOS too. AI_SCOPE-075: "Strata CPU" leads that same row, also on
// every OS (procstats reports CPU % on Windows, Linux and macOS). AI_SCOPE-076: "Strata I/O" closes that row
// (the tile answers "Windows only for now" where the counters do not exist).
// AI_SCOPE-077: the mirror rows come from the shared family helper - same items, same order, same ids.
// AI_SCOPE-093: the TPS + Prompt-TPS + Context + Hit-rate row leads its own row right after the current-request card
// (user placement 2026-10-31; the loaded / requests / installed cards are full-width, so the tile row is theirs alone).
defineScopeLayout('strata', () => layoutOf([{ lens: 'strata.current', settings: { width: 'full' } }, 'strata.tps', 'strata.ptps', 'strata.ctx', 'strata.hit', 'strata.loaded', 'strata.requests', 'strata.installed']).concat(STRATA_MIRROR.layout()));
