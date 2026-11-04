// AI_SCOPE dashboard - llama.cpp scope (AI_SCOPE-006): current request, loaded model, slots, requests.
// Data: /api/llamacpp (llamacppstats.js polls the server's /props and /slots; no relay). The request history is
// built from those slot polls, so tok/s and durations are estimates (marked "≈").
// Every card/table is a lens (lens.js), so it can also be shown on custom scopes, more than once.

const lcK = n => n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
const lcCtx = n => n == null ? '—' : n % 1024 === 0 ? (n / 1024) + 'K' : lcK(n);
const LC_EXACT = 'Exact: from the server\'s own counters (--metrics), the request ran alone on its model';
const LC_EST = 'Estimated from AI_SCOPE\'s looks at the server\'s slots (every ½ s, ¼ s while busy; llama.cpp keeps no per-request timings)';
// AI_SCOPE-098: the Models folder the Installed lens needs. The router lists unloaded models but never
// sends their paths, and AI_SCOPE cannot ask for --models-dir (auto-detect from the process command line
// was weighed at review and skipped as over-built), so the folder is set on the scope card and the server
// reads GGUF headers from it there, local servers only.
// AI_SCOPE-106 item 4: this used to be a LENS setting riding the poll URL (?md=), which let any client -
// and any second tab with a different value - retarget the folder the server reads files from, on a
// listener that can be LAN-exposed. The lens-level field and the poll param are gone; the scope card is
// the only source.
defineSource('llamacpp', '/api/llamacpp?limit=100', 'llamacpp', 1000, null, 'processHistory');   // AI_SCOPE-082 / 084: the mirror history ring goes out as a delta (?since=)

// AI_SCOPE-082: the Hardware Mirror Lens family for llama.cpp (GPU / RAM Working / RAM Committed / CPU / I/O over
// llama.cpp's own processes) comes from the shared defineMirror factory - web/js/mirror.js (077). The watch shape is
// the one llamacppstats.js has run since 006 (decision 1A: the server process plus the model children it owns, in
// router mode; a generic launcher parent is excluded by the name filter). Attestation is live / idle / off read
// from the server's own answers (decision 2A); 'loading' / 'unloading' / 'failed' are absent from llama.cpp's API
// as far as AI_SCOPE can see them without making a router load something, so they are recorded, not invented.
// Tile-id letter 'l' (<letter>gp / <letter>ram_ / <letter>cpu / <letter>io), kept clear of 's' (Strata), 'b'
// (Bionic) and 'o' (Ollama) so saved layouts resolve.
const LLAMACPP_MIRROR = defineMirror({ key: 'llamacpp', name: 'llama.cpp', letter: 'l' });

// ---------- Current request (AI_SCOPE-100: the shared card engine) ----------
// The one scope whose current is a LIST (one per busy slot): o.cur picks the youngest starter and
// hands the rest to the normal tail as othersRunning, and slot K rides the detail line. --no-slots
// is a blocked state (o.blocked): no requests are visible at all, so no box pretends otherwise.
// Estimated numbers keep their ≈ + the LC_EST tooltip - the honesty rule, not decoration.
const LC_CARD = {
  title: 'Current request',
  boxes: ['speed', 'gen', 'prompt', 'context', 'time'],
  cur: d => {
    const c = lcCurrentPick(d);
    return c ? Object.assign({}, c, { othersRunning: (d.current || []).length - 1 }) : null;
  },
  blocked: d => d.slotsEnabled === false
    ? { title: 'Slots endpoint is off', model: d.model ? d.model.name : null,
        foot: 'The server was started with --no-slots, so AI_SCOPE can\'t see its requests. Start it without that option.' }
    : null,
  offline: d => ({ title: d.needsKey ? 'llama.cpp server needs an API key' : 'llama.cpp server is not running' }),
  idle: d => {
    const a = d.average, m = d.model;
    const nLoaded = (d.models || []).filter(x => x.state === 'loaded').length;
    return { title: !d.router && m && m.sleeping ? 'Sleeping \u2014 model unloaded until the next request' : 'Idle \u2014 no request running',
             model: d.router ? (nLoaded ? nLoaded + ' model' + (nLoaded > 1 ? 's' : '') + ' loaded' : 'no model loaded') : (m ? m.name : null),
             foot: 'Send a message in the server\'s web chat (' + d.url + ') or a request to its API to see live stats.',
             avgMark: true, avgTitle: LC_EST };
  },
  doing: c => c.phase === 'generating' ? 'generating' : 'reading prompt',
  detail: (d, c) => 'slot ' + c.slot,
  run: (d, c) => ({
    speed: { label: c.phase === 'generating' ? 'Current gen tok/s' : 'Reading prompt',
             text: c.phase === 'generating' && c.genTps != null ? '\u2248 ' + fmtTps(c.genTps) : '…',
             title: c.phase === 'generating' && c.genTps != null ? LC_EST : '' },
    gen: { text: fmtNum(c.outputTokens) + (c.maxTokens ? ' / ' + lcK(c.maxTokens) : '') },
    prompt: { text: lcK(c.promptTokens) + (c.cachedTokens ? ' (' + lcK(c.cachedTokens) + ' cached)' : '') },
    context: { text: c.contextUsed != null ? lcK(c.contextUsed) + (c.contextMax ? ' / ' + lcCtx(c.contextMax) : '') : '…',
               bar: c.contextUsed != null && c.contextMax ? 100 * c.contextUsed / c.contextMax : 0 },
    time: { text: fmtSec(c.elapsedMs) },
  }),
  proc: (d, c) => c.process || d.process,   // router mode: the busy model's own family (082's watch)
  name: 'llama.cpp',
};
defineLens({
  id: 'llamacpp.current', scope: 'llamacpp', size: 'wide',
  name: 'Current request',
  description: 'What the llama.cpp server is answering right now: speed, tokens, prompt, context and the server process\'s GPU, VRAM, CPU and RAM use.',
  settings: [PROC_STATS_FIELD],
  markup: nowCardMarkupFor(LC_CARD),
  render(L, d) { nowCardRender(L, d, LC_CARD); },
});

// ---------- shared ----------
// lcVram lived here (050) - AI_SCOPE-099 moved the per-card VRAM cell into the shared Loaded
// engine as vramCell() in lens.js; the hint line uses the shared procVramText() like the others.
// ---------- Loaded in memory: the running model(s) (AI_SCOPE-099: the shared Loaded lens) ----------
// The uniform block plus llama.cpp's one exclusive (Since load). Rows carry their own measured
// process (082's per-model watch in router mode), so the VRAM column is per-model here by nature;
// lcVram / lcTotals moved into the shared engine (lens.js) and are gone from this file.
const LC_LOAD = {
  title: 'Loaded in memory',
  nameOf: m => m.name,
  plainCell: true,
  tipOf: m => m.path || null,
  tagOf: m => m.sleeping ? '<span class="tag">sleeping</span>' : '',
  quantField: 'ftype',
  slotsField: 'slots',
  sizeTitle: 'Weights on disk (the file size); the running context adds more',
  slotTitle: 'Parallel slots of this model',
  unloadWhy: 'llama.cpp keeps the model loaded until the server or router releases it',
  loadedWhy: 'The server reports no load timestamp',
  extra: ['since'],
  titleOf: (key, m) => key === 'context'
    ? (m.ctxTrain ? 'trained for ' + fmtNum(m.ctxTrain) + ' \u00b7 ' : '') + 'shared by all slots'
    : null
};
defineLens({
  id: 'llamacpp.loaded', scope: 'llamacpp', size: 'full',
  name: 'Loaded in memory',
  description: 'Models the llama.cpp server is running (in router mode, every loaded one): quantization, size, measured VRAM per card, context, slots, and since-load totals with --metrics.',
  settings: [PER_PAGE_FIELD],
  markup: loadedTableMarkup(LC_LOAD),
  render(L, d) {
    const $ = L.$, list = d.online ? (d.models || []).filter(m => m.state === 'loaded') : [];
    const opts = Object.assign({}, LC_LOAD, { count: list.length, solo: list.length === 1, proc: d.process, multi: list.length > 1 });
    $('rows').innerHTML = paginate(L.key, list.map(m => loadedRow(m, opts)), $('pager'), L.settings.perPage).join('');
    $('empty').hidden = list.length > 0;
    $('empty').textContent = !d.online ? (d.needsKey ? d.error : 'The llama.cpp server is offline. Start it (llama serve -m <model.gguf>, or llama-server) to see its model and requests.')
      : d.router ? 'No model loaded. The router loads one when a request names it' + (d.router.autoload ? '' : ' (autoload is off: load it in the web UI)') + '.' : 'No model information from the server.';
    $('hint').textContent = !d.online ? '' : d.router
      ? '— router · ' + list.length + ' of ' + (d.models || []).length + ' loaded' + (d.router.maxInstances ? ', up to ' + d.router.maxInstances + ' at once' : '') +
        (list.length > 1 && procVramText(d.process) ? ' \u00b7 ' + procVramText(d.process) : '')
      : (procVramText(d.process) ? '— ' + procVramText(d.process) : '');
  },
});

// ---------- Installed models: a router's models folder (AI_SCOPE-098: the shared Installed lens) ----------
// Gains the uniform Publisher (model ids are normally HF repo paths) and Fit (vramFit on the server,
// canSplit=false - one model per card); the params name-guess now wears the ≈ marker (D4).
const LC_INST = {
  title: 'Installed models', pager: true,
  quantField: 'ftype', contextField: 'ctxTrain',
  featOf: m => m.inputs,
  nameOf: m => m.name,
  plainCell: true,
  tipOf: m => m.path || null,
  linkOf: m => m.modelUrl || null,
  linkTitle: m => 'Model on Hugging Face',
  tagOf: m => (m.state && m.state !== 'loaded' && m.state !== 'unloaded') ? '<span class="tag">' + escH(m.state) + '</span>' : '',
  ctxTitle: 'The architecture\'s trained context length',
  sizeTitle: 'Weights on disk; AI_SCOPE compares this against VRAM for the Fit column (context adds more)',
  fitTitle: 'AI_SCOPE: weights vs the largest GPU card; a model loads onto one card'
};
defineLens({
  id: 'llamacpp.installed', scope: 'llamacpp', size: 'full',
  name: 'Installed models',
  description: 'In router mode (--models-dir), every model in the router\'s folder: publisher, size, parameters, quantization, context, features, fit, loaded or not.',
  settings: [PER_PAGE_FIELD],
  markup: instTableMarkup(LC_INST),
  render(L, d) {
    const $ = L.$, list = d.online && d.router ? d.models || [] : [];
    $('rows').innerHTML = paginate(L.key, list.map(m => instRow(m, LC_INST)), $('pager'), L.settings.perPage).join('');
    $('empty').hidden = list.length > 0;
    $('empty').textContent = !d.online ? 'The llama.cpp server is offline.'
      : d.router ? 'The router\'s models folder is empty.'
      : 'This server runs a single model (started with -m). Start it with --models-dir <folder> (router mode) to list and load the models in a folder.';
    $('hint').textContent = instHint(LC_INST, list);
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
// AI_SCOPE-094 slice 2: shared Requests columns; llama.cpp's own Slot column appended last.
// Its numbers keep their honesty markers: `exact` rows come from the server's /metrics counters,
// everything else is slot arithmetic (≈), and `quick` rows know only the combined token total -
// so Generated stays a gap there rather than showing a prompt+generation sum (decision: gap + tag).
function llamacppReqTitle(key, r) {
  const pv = f => provOf(r, f);
  if (key === 'duration') return pv('durationMs') === 'derived' ? 'prompt ' + fmtSec(r.promptMs) + ' + generation ' + fmtSec(r.genMs) : null;
  if (key === 'prompt') return r.promptTps ? 'read at ' + fmtTps(r.promptTps) + ' tok/s in ' + fmtSec(r.promptMs) : null;
  if (key === 'generated') return r.quick ? 'this server saw the request start and finish between two looks: only its combined prompt + generation token count is known' : (pv('outputTokens') === 'estimated' ? 'From the slot\u2019s token count after it finished' : null);
  if (key === 'genTps') return pv('genTps') === 'derived' ? LC_EXACT : LC_EST;
  if (key === 'firstToken') return pv('firstTokenMs') === 'substitute' ? 'Substituted: the server\u2019s metrics give the prompt-eval time, not a first-token time' : null;
  return null;
}
const LLAMACPP_REQ = {
  title: 'Requests', pager: true, extra: ['slot'], keyOf: r => r.key, titleOf: llamacppReqTitle,
  tagOf: r => r.quick ? '<span class="tag" title="Started and finished between two looks at the server, so only its size is known (prompt + output tokens together)">quick</span>' : ''
};
defineLens({
  id: 'llamacpp.requests', scope: 'llamacpp', size: 'full',
  name: 'Requests',
  description: 'Finished requests seen in the server\'s slots: tokens, speeds, first token, duration, peak load.',
  settings: [PER_PAGE_FIELD],
  markup: reqTableMarkup(LLAMACPP_REQ),
  render(L, d) {
    const $ = L.$;
    $('hint').innerHTML = '— <span title="' + escH(LC_EST) + '">≈ = estimated</span>' + ((d.models || []).some(m => m.metricsOn) ? '; requests that ran alone are exact (server metrics)' : ' · start the server with --metrics for exact numbers');
    $('empty').hidden = d.rows.length > 0;
    $('empty').textContent = 'No requests yet. Requests from the server\'s web chat and from apps using its API appear here once they finish.';
    $('rows').innerHTML = paginate(L.key, d.rows.map(r => reqRow(L, r, LLAMACPP_REQ)), $('pager'), L.settings.perPage).join('');
    rowsDrawn(L);
  },
});

// ---------- token-performance lenses (AI_SCOPE-101) ----------
// The 093 pattern for llama.cpp, with the user's kickoff decisions:
//  - Gen tok/s + Context ride the SERVER rings (tpsHistory / contextHistory): clock boards,
//    constant 2 s pace stamps (an N/A refresh = a visible bordered hole - 077/097), and the
//    rings ride offline answers. windowGenTps in llamacppstats.js is shared by the card rows and
//    the ring points, so the two can never disagree (the 093 slice-3 rule).
//  - Prompt tok/s is a PER-REQUEST lens in the shape strata.hit finally took: the rows are the
//    series, up to the last 100 that carry a promptTps (llama.cpp reports one only for requests
//    the /metrics counters settled), one connected line, rateless requests carry NO point and the
//    line joins across them (never a zero - 072). No live face, no invented average.
//  - NO Hit rate lens: llama.cpp reports no VRAM/expert hit, and cache-hit % is another family
//    the user kept out of this ticket.
// Slot picker (D2): every lens here follows ONE slot. Auto (default) = the card's pick
// (youngest-started busy slot); fixed 0..7 pins a physical slot. Slot ids are the server's 0-based
// indices - slot 0 always exists, but with --parallel a request lands on any idle slot, which is
// why Auto is the default: a pinned slot honestly shows nothing while the work runs elsewhere.
// Hover parity (the 093 18:16 lesson): each hover reads the SAME drawn set + board time the line
// was built with (module vars), never a fresh pick.
function lcCurrentPick(d) {
  const list = d.current || [];
  return list.slice().sort((a, b) => a.elapsedMs - b.elapsedMs)[0] || null;
}
const LC_SLOT_FIELD = { id: 'slot', label: 'Slot', type: 'choice', default: '', options:
  [['', 'Auto (the running slot)'], ['0', 'Slot 0'], ['1', 'Slot 1'], ['2', 'Slot 2'], ['3', 'Slot 3'],
   ['4', 'Slot 4'], ['5', 'Slot 5'], ['6', 'Slot 6'], ['7', 'Slot 7']],
  help: 'Slot ids are the server\u2019s 0-based slot indexes - slot 0 always exists, but with --parallel a request runs on any idle slot. Auto follows the same slot the Current-request card shows.' };
function lcSlotSetting(L) { const v = L.settings.slot; return v === '' || v == null || isNaN(+v) ? null : +v; }
function lcRingPts(ring, want, follow) { return ring.filter(p => (want != null ? p.s === want : p.s === follow)); }

// ---------- Gen tok/s ----------
const LC_TPS_HIST = [];
let LTPS_T1 = Date.now(), LTPS_FOLLOW = null, LTPS_PTS = [];   // drawn-board parity for the hover
subscribeSource('llamacpp', d => {
  const add = (d && d.tpsHistory) || [];
  if (add.length) {
    const last = LC_TPS_HIST.length ? LC_TPS_HIST[LC_TPS_HIST.length - 1].t : 0;
    for (const p of add) if (p && p.t > last) LC_TPS_HIST.push(p);
    sparkPrune(LC_TPS_HIST);                                                       // time-sized, one older sample
    if (LC_TPS_HIST.length > 400) LC_TPS_HIST.splice(0, LC_TPS_HIST.length - 400);  // safety cap only
  }
});
const LC_TPS_TIP = 'Generation speed of the llama.cpp request this lens follows - estimated from AI_SCOPE\u2019s looks at the server\u2019s slots (every \u00bd s, \u00bc s while busy; llama.cpp keeps no per-request timings). While nothing runs, the big number is AI_SCOPE\u2019s average of recent saved requests (also estimated). The line covers only time actually spent generating; the gaps between requests are breaks, not zeros.';
defineLens({
  id: 'llamacpp.tps', scope: 'llamacpp', size: 'tile',
  name: 'Gen tok/s',
  description: 'llama.cpp generation speed with a 5-minute history: the followed slot\u2019s estimated tok/s while a request runs, the average of recent requests when not. A Slot setting follows one server slot.',
  settings: [LC_SLOT_FIELD],
  markup: () => tileHtml({ id: 'ltps', label: 'llama.cpp Gen tok/s' }),
  render(L, d) {
    const box = L.el.querySelector('[data-tile="ltps"]'); if (!box) return;
    box.querySelector('.ltitle').title = LC_TPS_TIP;
    const now = Date.now(); LTPS_T1 = now;
    const want = lcSlotSetting(L), pick = lcCurrentPick(d);
    if (want == null && pick) LTPS_FOLLOW = pick.slot;      // Auto follows the card's slot
    LTPS_PTS = lcRingPts(LC_TPS_HIST, want, LTPS_FOLLOW);
    const fresh = sparkFresh(LTPS_PTS);
    const maxT = Math.max(10, 1.25 * fresh.reduce((a, x) => Math.max(a, x.v || 0), 0));   // on-board only: "top" is what you SEE
    const clk = sparkClockSegs(LTPS_PTS, now, h => h.v == null ? null : Math.min(100, 100 * h.v / maxT));
    const live = want != null ? (d.current || []).find(r => r.slot === want) : pick;
    const run = live && live.genTps != null ? live.genTps : null;
    const avg = d.average && d.average.genTps != null ? d.average.genTps : null;
    const v = run != null ? run : avg;
    sparkTile(box, v == null ? null : Math.min(100, 100 * v / maxT), v == null ? NA_HTML : '\u2248 ' + fmtTps(v),
      run != null ? 'live \u00b7 ' + cutName(live.model) + ' \u00b7 slot ' + live.slot
        : avg != null ? 'avg last ' + d.average.requests + ' \u00b7 ' + (d.average.model ? cutName(d.average.model) : 'any model')
        : d.online ? (d.router ? 'no model loaded' : 'no request has run yet') : 'llama.cpp Offline',
      clk.segs, clk.caps);
    const vEl = box.querySelector('.v'); if (vEl) vEl.title = LC_EST;   // the estimate is the number's own nature
    box.querySelector('.spark').title = 'Top of the chart = ' + fmtTps(maxT) + ' tok/s (5-minute board max) \u00b7 slot-estimated';
  },
});
MIRROR_HOVER.push({ prefix: 'ltps', fn: (spark, f, guide, tip) => {   // nearest sample on the DRAWN board (parity vars), its own time printed
  sparkClockHover(spark, f, guide, tip, LTPS_PTS, hs => (hs.v != null ? '\u2248 ' + fmtTps(hs.v) + ' tok/s \u00b7 ' + new Date(hs.t).toLocaleTimeString() + ' \u00b7 ' + cutName(hs.m) + ' \u00b7 slot ' + hs.s : 'n/a'), LTPS_T1);
} });

// ---------- Prompt tok/s (per-request; --metrics-settled rows only) ----------
let LPTPS_PTS = [];
const LC_PTPS_TIP = 'llama.cpp prompt-processing speed, one point per finished request. The server reports a prompt speed only when run with --metrics (counter deltas), so requests settled without it carry no point - the line joins across them, never a zero. Big number = the latest request that has one. Each point: prompt tokens read \u00f7 the server\u2019s prompt seconds.';
defineLens({
  id: 'llamacpp.ptps', scope: 'llamacpp', size: 'tile',
  name: 'Prompt tok/s',
  description: 'llama.cpp prompt speed per finished request (the ones --metrics could settle): up to the last 100 as one connected line, the latest settled request as the big value.',
  settings: [LC_SLOT_FIELD],
  markup: () => tileHtml({ id: 'lptps', label: 'llama.cpp Prompt tok/s' }),
  render(L, d) {
    const box = L.el.querySelector('[data-tile="lptps"]'); if (!box) return;
    box.querySelector('.ltitle').title = LC_PTPS_TIP;
    const want = lcSlotSetting(L);
    const rows = Array.isArray(d.rows) ? d.rows : [];
    const rated = rows.filter(r => r && r.promptTps != null && r.end != null && (want == null || r.slot === want));
    LPTPS_PTS = rated.slice(0, 100).reverse().map((r, i) => ({ t: i, every: 1, v: r.promptTps, m: r.model, s: r.slot, end: r.end }));
    const maxT = Math.max(100, 1.25 * LPTPS_PTS.reduce((a, x) => Math.max(a, x.v || 0), 0));   // prompt-scale floor like sptps
    const segs = sparkSegs(LPTPS_PTS, h => h.v == null ? null : Math.min(100, 100 * h.v / maxT));
    const last = rated[0];
    sparkTile(box, last ? Math.min(100, 100 * last.promptTps / maxT) : null, last ? fmtTps(last.promptTps) : NA_HTML,
      last ? 'last req \u00b7 ' + fmtWhen(last.end) + ' \u00b7 ' + cutName(last.model) + ' \u00b7 slot ' + last.slot
        : d.online ? 'no --metrics-settled request yet (start the server with --metrics)' : 'llama.cpp Offline',
      segs);   // fully joined: the 097 interior rule draws no caps
    box.querySelector('.spark').title = 'Top of the chart = ' + fmtTps(maxT) + ' tok/s \u00b7 one step per request with a number, in order, up to the last 100';
  },
});
MIRROR_HOVER.push({ prefix: 'lptps', fn: (spark, f, guide, tip) => {   // nearest REQUEST by index (the shrate form); its own end time, not the cursor's
  const n = LPTPS_PTS.length; if (!n) return;
  const ix = Math.max(0, Math.min(n - 1, Math.round(f * (n - 1))));
  const p = LPTPS_PTS[ix], x = n > 1 ? 100 * ix / (n - 1) : 100;
  guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.style.display = '';
  tip.hidden = false; tip.style.left = x + '%';
  tip.textContent = (p.v != null ? fmtTps(p.v) + ' tok/s \u00b7 ended ' + fmtWhen(p.end) + ' \u00b7 slot ' + p.s : 'n/a') + (p.m ? ' \u00b7 ' + cutName(p.m) : '');
} });

// ---------- Context (followed slot; live + held fill, per-slot states from the server) ----------
const LC_CTX_HIST = [];
let LCTX_T1 = Date.now(), LCTX_FOLLOW = null, LCTX_PTS = [];
subscribeSource('llamacpp', d => {
  const add = (d && d.contextHistory) || [];
  if (add.length) {
    const last = LC_CTX_HIST.length ? LC_CTX_HIST[LC_CTX_HIST.length - 1].t : 0;
    for (const p of add) if (p && p.t > last) LC_CTX_HIST.push(p);
    sparkPrune(LC_CTX_HIST);
    if (LC_CTX_HIST.length > 400) LC_CTX_HIST.splice(0, LC_CTX_HIST.length - 400);
  }
});
const LC_CTX_TIP = 'How full the followed slot\u2019s context window is - the server\u2019s own slot token count (prompt + generated so far, exact from the slot view). While a request runs this is the live fill; while idle it is the fill the slot still holds (llama.cpp keeps the conversation in its slot). An unload or a sleeping model voids the claim, and the lens says so.';
defineLens({
  id: 'llamacpp.ctx', scope: 'llamacpp', size: 'tile',
  name: 'Context',
  description: 'llama.cpp context fill for the followed slot on a 5-minute board: live prompt + generated while a request runs, the fill the slot is holding when idle (same loaded model only).',
  settings: [LC_SLOT_FIELD],
  markup: () => tileHtml({ id: 'lctx', label: 'llama.cpp Context' }),
  render(L, d) {
    const box = L.el.querySelector('[data-tile="lctx"]'); if (!box) return;
    box.querySelector('.ltitle').title = LC_CTX_TIP;
    const now = Date.now(); LCTX_T1 = now;
    const want = lcSlotSetting(L), pick = lcCurrentPick(d);
    if (want == null && pick) LCTX_FOLLOW = pick.slot;
    LCTX_PTS = lcRingPts(LC_CTX_HIST, want, LCTX_FOLLOW);
    const follow = want != null ? want : LCTX_FOLLOW;
    const st = (d.contextStates || []).find(x => x.slot === follow && (x.live || x.used > 0)) || null;   // an empty slot's 0 is not a conversation claim
    const ceil = (st && st.max) || Math.max(1, sparkFresh(LCTX_PTS).reduce((a, x) => Math.max(a, x.v || 0), 0));
    const clk = sparkClockSegs(LCTX_PTS, now, h => h.v == null ? null : Math.min(100, 100 * h.v / ceil));
    const big = st && st.used != null ? lcK(st.used) + (st.max ? '<small> / ' + lcCtx(st.max) + '</small>' : '') : NA_HTML;
    const meter = st && st.used != null && st.max ? Math.min(100, 100 * st.used / st.max) : null;
    sparkTile(box, meter, big,
      st ? (st.live ? 'live \u00b7 ' + cutName(st.model) + ' \u00b7 slot ' + st.slot
                    : 'held \u00b7 ' + cutName(st.model) + ' \u00b7 slot ' + st.slot + ' \u00b7 since ' + fmtWhen(st.at))
        : !d.online ? 'llama.cpp Offline'
        : d.slotsEnabled === false ? 'Slots endpoint is off'
        : (d.models || []).some(m => m.state === 'loaded') ? 'no request has run yet on that slot'
        : 'no model loaded (or it is sleeping - then the held fill is void)',
      clk.segs, clk.caps);
    box.querySelector('.spark').title = 'Top of the chart = ' + lcCtx(ceil) + ' \u00b7 last 5 minutes';
  },
});
MIRROR_HOVER.push({ prefix: 'lctx', fn: (spark, f, guide, tip) => {   // nearest sample on the DRAWN board (parity vars), its own time printed
  sparkClockHover(spark, f, guide, tip, LCTX_PTS, hs => (hs.v != null ? lcK(hs.v) + ' tok \u00b7 ' + new Date(hs.t).toLocaleTimeString() + ' \u00b7 ' + cutName(hs.m) + ' \u00b7 slot ' + hs.s : 'n/a'), LCTX_T1);
} });

// AI_SCOPE-088: the scope-header helper text is gone - the header shows only the title (user direction 2026-10-31).
// AI_SCOPE-101: the Gen tok/s + Prompt tok/s + Context row leads right after the current-request card
// (093 D5 placement pattern; loaded / requests / installed / slots are the full-width cards).
defineScopeLayout('llamacpp', () => layoutOf([{ lens: 'llamacpp.current', settings: { width: 'full' } }, 'llamacpp.tps', 'llamacpp.ptps', 'llamacpp.ctx', 'llamacpp.loaded', 'llamacpp.requests', 'llamacpp.installed', 'llamacpp.slots']).concat(LLAMACPP_MIRROR.layout()));   // AI_SCOPE-082: mirror family tail
