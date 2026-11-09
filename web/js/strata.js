// AI_SCOPE dashboard - Strata scope: current request, loaded model (experts in VRAM), requests, installed models.
// Data: /api/strata (stratastats.js reads the Strata desktop app's own monitor JSON).
// Every card/table is a lens (lens.js), so it can also be shown on custom scopes, more than once.

const fmtK = n => n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
// Context windows are powers of two: 65,536 -> "64K", like Strata shows them.
const fmtCtx = n => n == null ? '—' : n % 1024 === 0 ? (n / 1024) + 'K' : fmtK(n);
// fmtPct moved to core.js (AI_SCOPE-094 slice 2) — the shared Requests columns need it, and a
// top-level const declared twice across classic scripts is a runtime SyntaxError, not a shadow.

defineSource('strata', '/api/strata?limit=100', null, null, null, 'processHistory');   // AI_SCOPE-084: the history ring goes out as a delta (?since=)

// ---------- Current request (AI_SCOPE-100: the shared card engine) ----------
// All five boxes - Strata's engine reports every one of them live. phase/phaseText are Strata's own
// words (080): the engine lets her prose win the state line, and queued rides the normal tail.
// AI_SCOPE-109: the scope now answers from two faces of Strata - the desktop app, or a headless
// `strata launch` engine read directly. The server sends which one (`source`) and what it last told the
// Hardware Mirror Lenses (`state`); these are the words for a scope that is reachable-but-not-reading and
// for naming the source, so every lens says the same thing.
function strataSource(d) {
  if (d.source === 'cli') return 'CLI' + (d.port ? ' :' + d.port : '');
  if (d.source === 'app') return 'App';
  return null;
}
function strataDownTitle(d) {
  if (d.keyNeeded) return 'Strata needs its API key';
  if (d.state === 'loading') return 'Strata is loading its model';
  return 'Strata is not running';
}
function strataDownSub(d) {
  if (d.keyNeeded) return 'Strata needs a key';
  if (d.state === 'loading') return 'Strata Loading\u2026';
  return 'Strata Offline';
}
const STRATA_CARD = {
  title: 'Current request',
  boxes: ['speed', 'gen', 'prompt', 'context', 'time'],
  // AI_SCOPE-109 (option A): a running / idle title names the face of Strata it came from, so a swap
  // between the app and a CLI launch is visible where the numbers are. An offline title never gains one.
  suffix: d => { const s = strataSource(d); return s ? ' \u00b7 ' + s : ''; },
  offline: d => ({ title: strataDownTitle(d), foot: d.keyNeeded
      ? 'Strata\'s CLI is running, but its API wants a key. Put it in this scope\'s "Strata API key" setting.'
      : d.state === 'loading' ? 'A headless launch is setting its engine up: the port is not born yet, so there is nothing to read. The Hardware Mirror tiles show the load.'
      : '' }),
  idle: d => {
    const l = d.loaded, a = d.average;
    return { title: l && l.phase === 'unavailable' ? 'Engine not answering' : l ? 'Idle \u2014 no request running' : d.state === 'idle' ? 'Idle \u2014 no model loaded' : 'No model loaded',
             model: l ? l.label : a ? a.model : null,
             foot: !l ? (d.state === 'idle' ? 'Load a model in Strata (the app, or `strata chat --load` for a headless launch) to see live stats.' : 'Load a model in Strata to see live stats.')
               : l.phase === 'unavailable' ? 'Strata\'s engine isn\'t answering. Check the Strata app.'
               : 'Send a message in Strata (or a request to its API) to see live stats.' };
  },
  run: (d, c) => {
    const pr = c.promptRead, pt = c.promptTotal;
    return {
      speed: { label: c.phase === 'loading' ? 'Loading model' : c.phase === 'reading' ? 'Prompt tok/s'
                   : c.phase === 'thinking' ? 'Thinking \u00b7 tok/s' : 'Current gen tok/s',
               text: c.phase === 'loading' ? '…'
                   : c.phase === 'reading' ? (c.promptTps ? fmtTps(c.promptTps) : '…')
                   : (c.genTps != null ? fmtTps(c.genTps) : '…') },
      gen: { text: fmtNum(c.outputTokens) + (c.maxTokens ? ' / ' + fmtK(c.maxTokens) : '') },
      prompt: { label: pt ? 'Prompt read' : 'Prompt',
                text: pt ? fmtK(pr || 0) + ' / ' + fmtK(pt) : fmtK(c.promptTokens),
                bar: pt ? 100 * (pr || 0) / pt : (c.promptTokens ? 100 : 0) },
      context: { text: c.contextUsed != null ? fmtK(c.contextUsed) + (c.contextMax ? ' / ' + fmtCtx(c.contextMax) : '') : '…',
                 bar: c.contextUsed != null && c.contextMax ? 100 * c.contextUsed / c.contextMax : 0 },
      time: { text: fmtSec(c.elapsedMs) },
    };
  },
  // AI_SCOPE-109: a read-only telemetry key opens /v1/telemetry only, and that is a LOSSY re-shape of
  // /metrics. The faces it cannot answer are named on the card's detail line rather than left as
  // silent gaps the user has to discover.
  detail: d => d.telemetryOnly && d.na && d.na.length ? 'telemetry key \u2014 n/a: ' + d.na.join('; ') : '',
  name: 'Strata',
};
defineLens({
  id: 'strata.current', scope: 'strata', size: 'wide',
  name: 'Current request',
  description: 'What Strata is answering right now: speed, tokens, prompt, context and the model process\'s GPU, VRAM, CPU and RAM use.',
  settings: [PROC_STATS_FIELD],
  markup: nowCardMarkupFor(STRATA_CARD),
  render(L, d) { nowCardRender(L, d, STRATA_CARD); },
});

// ---------- Loaded model (AI_SCOPE-099: the shared Loaded lens) ----------
// Variant left the lens by the user's decision (D4). Quant/Size reach the row through Strata's
// OWN installed list, joined server-side by the same variant key that sets that row's loaded flag
// (review 2026-11-02 - one source, an identity match the app itself defines). Params stays an
// honest gap: her catalog carries no token count (098). Slots rides the uniform column via her
// parallel; Strata's exclusives are appended.
const STRATA_LOAD = {
  title: 'Loaded model',
  nameOf: l => l.label,
  slotsField: 'parallel',
  ctxTitle: 'The context window this engine instance is serving',
  slotTitle: 'Parallel slots this instance serves',
  unloadWhy: 'Strata reports no auto-unload setting',
  loadedOf: l => l.loadedAt ? escH(fmtWhen(Date.parse(l.loadedAt))) : null,
  sizeTitle: 'Strata\'s own figure for this variant, joined from her installed list (AI_SCOPE-099)',
  titleOf: (key, l) => key === 'loaded' ? (l.loadedAt || null)          // tattr escapes - return the raw stamp
    : key === 'quant' && l.quant ? 'The quant tag of the variant\'s own name - the same one her Installed lens shows'
    : null,
  extra: ['kvQuant', 'gpus', 'experts', 'vramFree', 'spec']
};
defineLens({
  id: 'strata.loaded', scope: 'strata', size: 'full',
  name: 'Loaded model',
  description: 'The model Strata has loaded: quant and size from her own installed list, measured VRAM per card, context, slots, plus Strata\'s KV cache, GPUs, experts in VRAM, free VRAM and speculation.',
  settings: [PER_PAGE_FIELD],
  markup: loadedTableMarkup(STRATA_LOAD),
  render(L, d) {
    const $ = L.$, l = d.loaded;
    const opts = Object.assign({}, STRATA_LOAD, { count: l ? 1 : 0, solo: !!l, proc: d.process, multi: false });
    $('rows').innerHTML = paginate(L.key, l ? [loadedRow(l, opts)] : [], $('pager'), L.settings.perPage).join('');
    $('empty').hidden = !!l;
    // AI_SCOPE-109: a headless launch has no (Models) screen to load one from.
    $('empty').textContent = d.online ? 'No model loaded. Load one in Strata' + (d.source === 'cli' ? ' (strata chat --load, or restart the launch with a model).' : ' (Models).')
      : 'Strata is offline. Start the Strata app, or a headless launch (strata launch), to see its model and requests.';
    const where = l ? procVramText(d.process) : '';   // per-card VRAM of the model process (Windows, AI_SCOPE-051)
    $('hint').textContent = [where, l && l.error ? l.error : ''].filter(Boolean).map((t, i) => (i ? '' : '— ') + t).join(' · ');
  },
});

// ---------- Requests ----------
// AI_SCOPE-094 slice 2: the shared Requests columns (lens.js) — the uniform set, then Strata's
// own Hit Rate appended. Strata reports no cache-reuse for other scopes and no slot; its `reused`
// number now arrives as cachedTokens, drawn by the shared Cached column.
function strataReqTitle(key, r) {
  if (key === 'genTps') return [r.genMs != null ? 'generation ' + fmtSec(r.genMs) : null,
    r.draftsOffered ? 'drafts ' + fmtNum(r.draftsAccepted || 0) + ' of ' + fmtNum(r.draftsOffered) + ' accepted' : null].filter(Boolean).join(' · ');
  if (key === 'prompt') return [r.promptRead != null ? fmtNum(r.promptRead) + ' tokens read' : null,
    r.promptMs != null ? 'in ' + fmtSec(r.promptMs) : null].filter(Boolean).join(' ');
  if (key === 'cached') return 'Prompt tokens reused from the conversation cache (not read again)';
  if (key === 'duration') return r.promptMs != null ? 'prompt ' + fmtSec(r.promptMs) + (r.genMs != null ? ' + generation ' + fmtSec(r.genMs) : '') : null;
  if (key === 'firstToken') return r.genMs != null ? 'measured to the first token from the engine' : null;
  return null;
}
// One option object drives BOTH the header and the rows, so the two can never drift apart
// (the probe caught exactly that class of bug: 11 headers over 10 cells).
const STRATA_REQ = {
  title: 'Requests', pager: true, extra: ['source', 'hitRate', 'energy', 'cost'],
  keyOf: r => r.key,
  titleOf: strataReqTitle,
  statusOf: r => r.finish && r.finish !== 'stop' && r.finish !== 'length'
    ? '<span class="status interrupted" title="finish: ' + escH(r.finish) + '">' + escH(r.finish) + '</span> ' : ''
};
defineLens({
  id: 'strata.requests', scope: 'strata', size: 'full',
  name: 'Requests',
  description: 'Finished requests: tokens, cached prompt, speeds, first token, duration, peak load, which Strata answered the request, expert hit rate, and the GPU energy each one cost with its price.',
  settings: [PER_PAGE_FIELD],
  markup: reqTableMarkup(STRATA_REQ),
  render(L, d) {
    const $ = L.$, t = d.totals;
    $('hint').textContent = t && t.requests ? '— since ' + (d.source === 'cli' ? 'start' : 'load') + ': ' + fmtNum(t.requests) + ' requests' +
      (t.promptTokens ? ' · ' + fmtNum(t.cachedTokens || 0) + ' of ' + fmtNum(t.promptTokens) + ' prompt tokens reused (' + Math.round(100 * (t.cachedTokens || 0) / t.promptTokens) + '%)' : '') +
      (t.draftsOffered ? ' · drafts ' + Math.round(100 * (t.draftsAccepted || 0) / t.draftsOffered) + '% accepted' : '') : '';
    $('empty').hidden = d.rows.length > 0;
    $('empty').textContent = 'No requests yet. Requests from Strata\'s chat and from apps using its API appear here once they finish.';
    $('rows').innerHTML = paginate(L.key, d.rows.map(r => reqRow(L, r, STRATA_REQ)), $('pager'), L.settings.perPage).join('');
    rowsDrawn(L);
  },
});

// ---------- Installed models (AI_SCOPE-098: the shared Installed lens) ----------
// Strata's own fit verdict (D2): it keeps experts in RAM by design, so our VRAM fit doesn't apply.
// Variant / Status / Modified are out of the lens by the user's decision; Memory needed stays as
// Strata's own number, appended after the uniform block.
const STRATA_INST = {
  title: 'Installed models', pager: true, extra: ['memory'],
  linkOf: m => m.modelUrl || null,
  linkTitle: m => 'Model on Hugging Face (named by the model file itself)',
  fitOf: m => m.onThisPc
    ? '<span class="fit ' + (m.onThisPc === 'fits' ? 'fits' : /does not fit/.test(m.onThisPc) ? 'spills' : 'tight') + '">' + escH(m.onThisPc) + '</span>'
    : ONONE,
  titleOf: (k, m) => k === 'fit' ? (m.fitSummary || null) : null,
  sizeTitle: 'Weights on disk, as Strata reports it; memory Strata needs is the Memory column',
  fitNote: 'fit as judged by Strata for this PC'
};
defineLens({
  id: 'strata.installed', scope: 'strata', size: 'full',
  name: 'Installed models',
  description: 'Models installed in Strata, with size, features and Strata\'s own fit verdict; memory needed as Strata measures it.',
  settings: [PER_PAGE_FIELD],
  markup: instTableMarkup(STRATA_INST),
  render(L, d) {
    const $ = L.$;
    $('hint').textContent = instHint(STRATA_INST, d.installed);
    $('rows').innerHTML = paginate(L.key, d.installed.map(m => instRow(m, STRATA_INST)), $('pager'), L.settings.perPage).join('');
    $('empty').hidden = d.installed.length > 0;
    // AI_SCOPE-109 (kickoff decision 6): the installed list and Strata's fit verdict come from the desktop
    // app only - a headless engine has neither. The lens stays, and says so.
    $('empty').textContent = d.installedOnlyApp ? 'Only shown with the Strata desktop app'
      : (d.online ? 'No models installed in Strata.' : 'Strata is offline.');
  },
});

// ---------- Hardware Mirror Lenses for Strata (AI_SCOPE-072 / 073 / 075 / 076) ----------
// The four process tiles (strata.gpu / strata.ram / strata.cpu / strata.io) are the family's first members;
// since AI_SCOPE-077 they come from defineMirror() in web/js/mirror.js, which every app scope shares. The
// lens ids and tile ids are unchanged ('s' prefixes), so saved layouts and the hover keep working.
const STRATA_MIRROR = defineMirror({ key: 'strata', name: 'Strata', letter: 's' });

// ---------- Strata Gen tok/s (AI_SCOPE-093 slice 1) ----------
// Big value (user spec 2026-11-01 17:50, = D2 extended): live tok/s while Strata reports one on this refresh;
// ANY refresh without it (idle, or active-but-unreported) shows the token-weighted average of the loaded
// model's last 20 saved requests (d.average - the same server-computed number the running card prints).
// Sparkline: the CLOCK BOARD (sparkClockSegs) - x is the last SPARK_WIN wall-clock window, so every 2 s refresh
// shifts the data left and old samples fall off the edge. Points exist only while a request generates; a poll
// with no sample is an N/A refresh: the line BREAKS there and both hole-facing ends get an edge border (097).
// Gaps are information - never invented zeros (072). Hover rides hardware.js's MIRROR_HOVER dispatch (prefix 'stps').
const TPS_HIST = [];   // client ring merged from the payload - the append-and-prune shape mirror.js established
let STPS_T1 = Date.now();   // the board time of the last render - the hover must snap on the SAME board the line was drawn on
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
    const now = Date.now(); STPS_T1 = now;   // remember the board this render drew
    const pts = sparkFresh(TPS_HIST);
    const maxT = Math.max(10, 1.25 * pts.reduce(function (a, x) { return Math.max(a, x.v || 0); }, 0));   // on-board only: "top of the chart" is what you SEE
    const clk = sparkClockSegs(TPS_HIST, now, h => h.v == null ? null : Math.min(100, 100 * h.v / maxT));
    const run = d.current && d.current.genTps != null ? d.current.genTps : null;   // AI_SCOPE-100 (D4): tokS -> genTps
    const avg = d.average && d.average.genTps != null ? d.average.genTps : null;
    const v = run != null ? run : avg;   // an N/A refresh shows the last-20 average (user spec 2026-11-01 17:50) - D2's "active-but-unreported = n/a" superseded
    const meter = v == null ? null : Math.min(100, 100 * v / maxT);
    sparkTile(box, meter, v == null ? NA_HTML : fmtTps(v),
      run != null ? 'live · ' + cutName(d.current.model)
        : avg != null ? 'avg last ' + d.average.requests + ' · ' + cutName(d.average.model)
        : d.online ? 'no requests recorded yet' : strataDownSub(d),
      clk.segs, clk.caps);
    box.querySelector('.spark').title = 'Top of the chart = ' + fmtTps(maxT) + ' tok/s (5-minute board max)';
  },
});
MIRROR_HOVER.push({ prefix: 'stps', fn: (spark, f, guide, tip) => {   // nearest sample to the cursor's BOARD time, its own time printed
  sparkClockHover(spark, f, guide, tip, TPS_HIST, hs => (hs.v != null ? fmtTps(hs.v) + ' tok/s · ' + new Date(hs.t).toLocaleTimeString() + (hs.m ? ' · ' + cutName(hs.m) : '') : 'n/a'), STPS_T1);
} });

// ---------- Strata Prompt tok/s (AI_SCOPE-093 slice 2) ----------
// Same shape as the gen tile, its own ring (d.promptHistory) and its own honesty rule: the server only samples
// Strata's running prefill mean during the prompt phases, so points exist only while a prompt is being read.
// Big value (user spec 2026-11-01 17:50): live prefill tok/s while a refresh reports one; ANY refresh without it
// shows the token-weighted average of the loaded model's last 20 saved requests (d.promptAverage, built exactly
// like d.average). While another request GENERATES the big value is that historical average - never a replay of
// a finished prefill's mean as a live number.
// CLOCK BOARD like gen (sparkClockSegs): the 12:29 neighbour-join is SUPERSEDED. Strata's prefill mean goes
// absent for 16-18 s in the MIDDLE of a continuing prompt, and the 17:50 rule says that absence is an N/A
// refresh to SHOW, not to bridge: pace-stamped points again (server reverted), the line breaks at every
// dropout, and edge borders close the hole-facing faces. Hover snaps to the nearest sample, printing its own
// time - honest placement on the board, not n/a inside a dropout.
const PTPS_HIST = [];
let SPTPS_T1 = Date.now();   // the board time of the last render (hover parity) - see STPS_T1
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
    const now = Date.now(); SPTPS_T1 = now;   // remember the board this render drew
    const pts = sparkFresh(PTPS_HIST);
    const maxT = Math.max(100, 1.25 * pts.reduce(function (a, x) { return Math.max(a, x.v || 0); }, 0));   // on-board only; floor is a prompt-scale 100 tok/s
    const clk = sparkClockSegs(PTPS_HIST, now, h => h.v == null ? null : Math.min(100, 100 * h.v / maxT));
    const read = d.current && READ_PHASES[d.current.phase];
    const live = read && d.current.promptTps != null ? d.current.promptTps : null;   // AI_SCOPE-100 (D4): prefillTokS -> promptTps
    const avg = d.promptAverage && d.promptAverage.promptTps != null ? d.promptAverage.promptTps : null;
    const v = live != null ? live : avg;   // an N/A refresh (reading without a reported mean, or not reading) shows the last-20 average - 17:50 spec
    const meter = v == null ? null : Math.min(100, 100 * v / maxT);
    sparkTile(box, meter, v == null ? NA_HTML : fmtTps(v),
      live != null ? 'live · ' + cutName(d.current.model)
        : avg != null ? 'avg last ' + d.promptAverage.requests + ' · ' + cutName(d.promptAverage.model)
        : d.online ? 'no prompts recorded yet' : strataDownSub(d),
      clk.segs, clk.caps);
    box.querySelector('.spark').title = 'Top of the chart = ' + fmtTps(maxT) + ' tok/s (5-minute board max)';
  },
});
MIRROR_HOVER.push({ prefix: 'sptps', fn: (spark, f, guide, tip) => {   // nearest sample to the cursor's BOARD time, its own time printed
  sparkClockHover(spark, f, guide, tip, PTPS_HIST, hs => (hs.v != null ? fmtTps(hs.v) + ' tok/s · ' + new Date(hs.t).toLocaleTimeString() + (hs.m ? ' · ' + cutName(hs.m) : '') : 'n/a'), SPTPS_T1);
} });

// ---------- Strata Context (AI_SCOPE-093 slice 3) ----------
// Context fill on the CLOCK BOARD like gen: one point per 2 s poll while a request runs (prompt + generated -
// the number the running card shows, sampled with the identical computation so the two can never disagree).
// Each run is a rising ramp; a poll with no sample is an N/A refresh - the line breaks there and the
// hole-facing ends border. Big value (user spec 2026-11-01 17:50): live while running; an N/A refresh shows
// the fill the engine was LAST SEEN HOLDING - a real claim only while the same instance is still loaded
// (server-checked, d.contextState; Strata keeps its KV cache between requests, which is what makes the next
// turn reuse millions of tokens).
const CTX_HIST = [];
let SCTX_T1 = Date.now();   // the board time of the last render (hover parity) - see STPS_T1
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
    const now = Date.now(); SCTX_T1 = now;   // remember the board this render drew
    const pts = sparkFresh(CTX_HIST);
    const ceil = (st && st.max) || Math.max(1, pts.reduce(function (a, x) { return Math.max(a, x.v || 0); }, 0));   // the loaded window when known, else what the board reached
    const clk = sparkClockSegs(CTX_HIST, now, h => h.v == null ? null : Math.min(100, 100 * h.v / ceil));
    const big = st && st.used != null ? fmtK(st.used) + (st.max ? '<small> / ' + fmtCtx(st.max) + '</small>' : '') : NA_HTML;
    const meter = st && st.used != null && st.max ? Math.min(100, 100 * st.used / st.max) : null;
    sparkTile(box, meter, big,
      st ? (st.live ? 'live · ' + cutName(st.model) : 'held since ' + fmtWhen(st.at) + ' · ' + cutName(st.model))
        : d.loaded ? 'no request has run yet'
        : d.online ? 'No Model Loaded' : 'Strata Offline',
      clk.segs, clk.caps);
    box.querySelector('.spark').title = 'Top of the chart = ' + fmtCtx(ceil) + ' · last 5 minutes';
  },
});
MIRROR_HOVER.push({ prefix: 'sctx', fn: (spark, f, guide, tip) => {   // nearest sample to the cursor's BOARD time, its own time printed
  sparkClockHover(spark, f, guide, tip, CTX_HIST, hs => (hs.v != null ? fmtK(hs.v) + ' tok · ' + new Date(hs.t).toLocaleTimeString() + (hs.m ? ' · ' + cutName(hs.m) : '') : 'n/a'), SCTX_T1);
} });

// ---------- Strata Hit rate (AI_SCOPE-093 slice 4) ----------
// The expert-VRAM hit rate of FINISHED requests - Strata's own hit_rate, the exact number the Requests table's
// Hit rate column shows (share of needed experts already in VRAM; the rest came from RAM). The point is the
// request, not the poll (Q3): no new server ring, no new payload field - d.rows (the saved requests the source
// already sends) ARE the series, persisted in strata-requests.jsonl, so the lens keeps history across reloads
// and model switches; 094 inherits one copy rather than a fifth. A request that reports no hit rate carries
// no point at all (never a zero - 072 no-invented-numbers rule).
// AXIS, REVISED AGAIN 2026-11-01 ~18:35 (user: "i want it to be per request instead of per refresh. i want
// to show up to the last 100 data points from requests"): the 17:50 clock-board comb is SUPERSEDED for this
// lens - on a per-request axis a "refresh without data" does not exist; the data points ARE the requests.
// Up to the last 100 saved requests that carry a hit rate, one point each, evenly stepped along the request
// sequence (t = index, every: 1 for the 092 painter: no gap can break, x spans 0-100, neighbours always
// connected - the line joins across a request that reports no rate, never a zero (072)). History of the
// answer, superseded in order: (a) 092 clock axis + 3x breaks - an overnight ~12 h span squashed bursts and
// stranded the newest request as an invisible lone point; (b) 11:56 index axis, joined; (c) 15:53 index axis
// cut to a 5-min clock window; (d) 17:50 clock-board bordered event bars. Back to (b), now with the 100-point
// cap explicit. "Shift left" survives in its per-request form: each finished request steps the whole series
// one slot left. The axis has no clock face, so times live in the labels (the sub names the newest request's
// end time, the hover names each point's).
// BIG VALUE: the latest finished request's rate, sub "last req · <end time> · <model>" (H2; the 17:50 stale-
// board avg fallback is MOOT on this axis - it had no off state: the line is non-empty whenever any saved
// request carries a rate, and that fallback was built from the very same rows).
// Scale (H3): a bounded share, so chart and meter sit on a fixed 0-100%.
let HIT_PTS = [];   // the series the last render drew (oldest first, t = index; end = the request's own end time); the hover reads it
const HIT_TIP = 'Share of the model\'s needed experts already in VRAM at each finished request (the rest came from RAM) - Strata\'s own number, the same the Requests table shows. One point per finished request, in order and evenly spaced (the axis is the request sequence, not the clock; up to the last 100 saved requests; the line joins across requests that report no rate, never a zero); the hover names each request\'s end time. The big number is the latest finished request.';
defineLens({
  id: 'strata.hit', scope: 'strata', size: 'tile',
  name: 'Hit rate',
  description: 'Strata expert-VRAM hit rate per finished request: up to the last 100 saved requests as one connected line, the latest request\'s number as the big value.',
  markup: () => tileHtml({ id: 'shrate', label: 'Strata Hit rate' }),
  render(L, d) {
    const box = L.el.querySelector('[data-tile="shrate"]'); if (!box) return;
    box.querySelector('.ltitle').title = HIT_TIP;
    const rows = Array.isArray(d.rows) ? d.rows : [];                     // newest first, the source's own order
    const finished = rows.filter(r => r && r.hitRate != null && r.end != null);   // no rate / no end time: no point
    HIT_PTS = finished.slice(0, 100).reverse().map((r, i) => ({ t: i, every: 1, v: r.hitRate, m: r.model, end: r.end }));   // per-request axis (18:35): up to the last 100 data points, oldest first
    const segs = sparkSegs(HIT_PTS, h => h.v == null ? null : 100 * h.v); // fixed scale: the share IS the percent
    const last = finished[0];
    const v = last ? last.hitRate : null;
    sparkTile(box, v == null ? null : 100 * v, v == null ? NA_HTML : fmtPct(v),
      last ? 'last req · ' + fmtWhen(last.end) + ' · ' + cutName(last.model)
        : d.online ? 'no requests recorded yet' : strataDownSub(d),
      segs);   // interior caps rule: one fully joined run edge-to-edge draws no borders
    box.querySelector('.spark').title = 'Top of the chart = 100% (fixed) · one step per request, in order, up to the last 100';
  },
});
MIRROR_HOVER.push({ prefix: 'shrate', fn: (spark, f, guide, tip) => {   // nearest REQUEST by index; its own end time, not the cursor's
  const n = HIT_PTS.length; if (!n) return;
  const ix = Math.max(0, Math.min(n - 1, Math.round(f * (n - 1))));
  const p = HIT_PTS[ix], x = n > 1 ? 100 * ix / (n - 1) : 100;
  guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.style.display = '';
  tip.hidden = false; tip.style.left = x + '%';
  tip.textContent = (p.v != null ? fmtPct(p.v) + ' · ended ' + fmtWhen(p.end) : 'n/a') + (p.m ? ' · ' + cutName(p.m) : '');
} });

// ---------- Strata GPU cost: two lenses over one energy (AI_SCOPE-121, split 2026-11-09) ----------
// The user's split: ACTIVITY is the live rate - what an hour at this moment would cost, with the 5-minute
// history and the meter; TOTAL is the money spent over a range, the number only, no chart and no bar. Both
// draw the SAME server-side accrual (procstats: per card, live board power x the share of that card's total
// device util that is Strata's, summed and integrated over consecutive family samples - D7), so the energy keeps
// growing while nobody is looking, and both price it at DRAW time with the Settings → General $/kWh (D5): the
// joules were measured regardless of what the settings box says, so correcting a wrong price re-prices history
// honestly. Board power is a
// whole-device measurement, so every number here is an ESTIMATE and wears ≈ (the 072 no-invented-numbers
// rule is why Hardware's Power lens has no mirror twin - the user asked for an apportionment, and it is
// labeled as one). Energy shows in Wh, not kWh (D6, the user's words: "let's display as Wh instead of kWh").
// The two windows differ on purpose (D5 - "if I input Days: 3, it will fetch Strata requests that AI_SCOPE has
// within the last 3 days; requests are already persisted across restarts"):
//  - Activity: this session's 5-minute ring (d.cost.hist).
//  - Total, Cost Range = Session start: everything this server has measured since it booted (d.cost.ws, and
//    the sub line says since when). That includes GPU work outside any request - a model load, or a loaded
//    model whose family still asks something of its cards between requests.
//  - Total, Cost Range = Days: the SAVED request rows, bucketed per day by the server (d.costDays), because
//    a session ring cannot cover last week. That sums REQUEST energy only, and a row saved before this feature
//    (or one whose window nothing was measured inside) carries no energy and counts as nothing. The face names
//    how many requests it summed, so the two ranges can never be mistaken for the same number.
const COST_HIST = [];   // {t, every, w} - estimated Strata-attributable watts, newest last
let SCOST_T1 = Date.now();   // the board time of the last render (hover parity) - see STPS_T1
subscribeSource('strata', d => {
  const add = (d && d.cost && d.cost.hist) || [];
  if (add.length) {
    const last = COST_HIST.length ? COST_HIST[COST_HIST.length - 1].t : 0;
    for (const p of add) if (p && p.t > last) COST_HIST.push(p);
    sparkPrune(COST_HIST);
    if (COST_HIST.length > 240) COST_HIST.splice(0, COST_HIST.length - 240);
  }
});
// kwhPrice() / fmtUsd() / fmtWh() live in core.js now: the shared Requests columns (lens.js) draw the same
// two numbers, and a helper that lives in one scope file cannot serve the other three.
// The mirror tiles' state wording (mirror.js keeps its own copy inside defineMirror), in Strata's words.
const COST_STATE = { off: 'Strata Offline', idle: 'No Model Loaded', loading: 'Loading\u2026',
  unloading: 'Unloading\u2026', failed: 'Load failed' };
const COST_TIP = 'Active GPU Usage Cost: what a whole hour of GPU work at THIS moment would cost Strata. Per card: the card\'s live power draw × Strata\'s share of that card\'s GPU usage, summed over the cards — so a card that is also busy with something else is only charged for the part Strata is asking of it. Share of what, measured how: on an NVIDIA card both sides come from nvidia-smi\'s per-process SM (shader) time — Strata\'s processes\' SM % over the SM % of every process on that card, from one 1 Hz stream averaged over the moment being priced. On Windows that replaces the GPU Engine performance counters Task Manager uses, which never report CUDA work on a second graphics card: on the machine this was measured on, a card drawing 60 W with Strata as the only process on it read 0 % there. Where nvidia-smi cannot speak for a card (AMD / Intel, macOS, or that stream dying) the counters\' numbers and the card\'s own device usage are used instead, and one card is never measured by both at once. Board power is a whole-device measurement, so this is an estimate and every face wears ≈. The chart is the same rate over the last five minutes. The price per kWh comes from Settings → General; the total spent is the other lens ("Strata GPU Total Cost"). Strata holding a model resident on a card without using it is not charged — this prices work, not occupancy. Where a card Strata is using reports no power, or no same-source usage to divide by, nothing is recorded for that moment rather than guessed - the tile says so.';
defineLens({
  id: 'strata.costact', scope: 'strata', size: 'tile',
  name: 'GPU Cost Activity',
  description: "Active GPU Usage Cost — the live hourly rate for Strata's GPU work (each card's watts × Strata's share of that card's GPU usage, measured per process by nvidia-smi on NVIDIA cards, priced at the Settings electricity rate), with the last five minutes of that rate.",
  markup: () => tileHtml({ id: 'scostact', label: 'Strata GPU Cost Activity' }),
  render(L, d) {
    const box = L.el.querySelector('[data-tile="scostact"]'); if (!box) return;
    box.querySelector('.ltitle').title = COST_TIP;
    const price = kwhPrice();
    const now = Date.now(); SCOST_T1 = now;   // remember the board this render drew
    const pts = sparkFresh(COST_HIST);
    const maxW = Math.max(10, 1.25 * pts.reduce(function (a, x) { return Math.max(a, x.w || 0); }, 0));   // on-board only: "top of the chart" is what you SEE
    const clk = sparkClockSegs(COST_HIST, now, h => h.w == null ? null : Math.min(100, 100 * h.w / maxW));
    // Do these cards report board power at all? nvidia-smi (both OSes) and Linux's amdgpu sysfs do;
    // Windows' own GPU counters do not (the source field mirrors hwstats card.source, as the GPU tiles' do).
    const powered = (d.processCards || []).some(x => x.source === 'nvidia' || x.source === 'amd');
    const last = pts.length ? pts[pts.length - 1] : null;
    // The rate face follows the mirror family's value rule (077/080): an attested zero point is an honest 0
    // ("≈$0.00 /h · Strata Offline", exactly like the GPU tiles' zeros - live or idle, the user asked);
    // a FRESH real point is the apportioned watts; a stale real point (a lookup hiccup while a model is
    // loaded) is n/a, never a false 0. Absence of a number is not a number.
    let rate = null;
    if (last) {
      if (last.attest) rate = 0;                         // attested zero heartbeat point (off / idle / …)
      else if (now - last.t <= Math.min(120000, Math.max(1500, 3 * (last.every || 2000))))   // 092 break window
        rate = last.w / 1000 * price;                    // wattage per hour = Wh/h
    }
    const big = !powered || rate == null ? NA_HTML : '\u2248' + fmtUsd(rate) + '<small> /h</small>';
    const meter = rate == null ? null : Math.min(100, 100 * last.w / maxW);
    let sub;
    if (!powered) sub = (d.processCards || []).length ? 'power not reported for these cards' : 'detecting cards\u2026';
    else if (!last) sub = d.online ? 'no GPU use in the last 5 min' : strataDownSub(d);
    else if (last.attest) sub = COST_STATE[last.attest] || 'Inactive';
    else if (rate == null) sub = 'Inactive';   // the newest point is a stale real reading
    else sub = Math.round(last.w) + ' W asked of the cards \u00b7 $' + price + '/kWh';
    sparkTile(box, meter, big, sub, clk.segs, clk.caps);
    box.querySelector('.spark').title = 'Top of the chart = \u2248' + fmtUsd(maxW / 1000 * price) + ' /h (5-minute board max)';
  },
});
MIRROR_HOVER.push({ prefix: 'scostact', fn: (spark, f, guide, tip) => {   // nearest sample to the cursor's BOARD time: the rate at that moment
  sparkClockHover(spark, f, guide, tip, COST_HIST, hs => (hs.w != null
    ? '\u2248' + fmtUsd(hs.w / 1000 * kwhPrice()) + '/h \u00b7 ' + Math.round(hs.w) + ' W \u00b7 ' + new Date(hs.t).toLocaleTimeString()
    : 'n/a'), SCOST_T1);
} });

// The range a day number means: local midnight N days back through now, which is what the server's per-day
// buckets are keyed by (same machine, same clock - the dashboard is local by design, ARCHITECTURE.md).
const dayStart = ms => { const x = new Date(ms); x.setHours(0, 0, 0, 0); return x.getTime(); };
function fmtDay(ms) {
  if (!ms) return '—';
  const x = new Date(ms), now = new Date();
  const s = x.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return x.getFullYear() === now.getFullYear() ? s : s + ', ' + x.getFullYear();
}
const TOTAL_TIP = 'Total electric cost of Strata\'s GPU work over a range, from the same per-card estimate as the activity lens (each card\'s live power draw × Strata\'s share of that card\'s GPU usage, summed — per-process usage measured by nvidia-smi on an NVIDIA card, the Windows GPU counters where it cannot speak): every face wears ≈ because board power is a whole-device measurement. Cost Range "Session start" is everything AI_SCOPE has measured since it booted, requests and GPU work between them alike. Cost Range "Days" sums the SAVED Strata requests whose end falls in the window - the only energy record that outlives a restart, and no more complete than the 1000-request ring AI_SCOPE keeps - so it counts request energy and nothing else, and rows whose window nothing was measured inside count as nothing. Rows also count as nothing when their energy was measured by a superseded version of this formula: each saved figure carries which measurement produced it, so a corrected model never leaves the old numbers mixed into the total. Money is computed from the Settings → General price every time the tile draws, never stored, so a corrected price re-prices the whole range.';
defineLens({
  id: 'strata.costtotal', scope: 'strata', size: 'tile',
  name: 'GPU Total Cost',
  description: "Total GPU electric cost over a range: since AI_SCOPE started, or the saved Strata requests of the last N days. One number, priced at the Settings electricity rate; no chart.",
  markup: () => '<div class="tilebox" data-tile="scosttot">' + lensHeadMarkup('Strata GPU Total Cost') +
    '<div class="tile bignum"><div class="v">\u2014</div><div class="sub">&nbsp;</div></div></div>',
  settings: [
    { id: 'costRange', label: 'Cost range', type: 'choice', default: 'session',
      options: [['session', 'Session start'], ['days', 'Days']],
      tip: 'Session start: every measured GPU watt this AI_SCOPE server has attributed to Strata since it booted. Days: the saved Strata requests within the last N days (requests persist across restarts; GPU work outside a request is not in that sum).' },
    { id: 'days', label: 'Days', type: 'number', default: 30, min: 1, max: 365, cascade: true,
      when: cur => cur.costRange === 'days',
      tip: 'How many days back to sum (calendar days, today included), from the saved Strata requests AI_SCOPE still holds. Its ring keeps the last 1000 requests, so a long range can only reach back as far as they do.' },
  ],
  render(L, d) {
    const box = L.el.querySelector('[data-tile="scosttot"]'); if (!box) return;
    box.querySelector('.ltitle').title = TOTAL_TIP;
    const price = kwhPrice();
    let ws = null, sub;
    if (L.settings.costRange === 'days') {
      const n = Math.max(1, Math.min(365, +L.settings.days || 30));
      const from = dayStart(Date.now()) - (n - 1) * 864e5;   // calendar days, today included
      const b = (d.costDays || []).filter(x => x.d >= from);
      const have = b.reduce(function (a, x) { return a + x.n; }, 0);
      const gone = b.reduce(function (a, x) { return a + (x.miss || 0); }, 0);
      if (!have && !gone) sub = 'no saved requests in the last ' + n + ' day' + (n > 1 ? 's' : '');
      else {
        if (have) ws = b.reduce(function (a, x) { return a + x.ws; }, 0);
        sub = (have ? fmtWh(ws) + ' \u00b7 ' : 'no energy recorded \u00b7 ') + have + ' of ' + (have + gone) +
          ' requests since ' + fmtDay(from);
      }
    } else {
      const c = d.cost;
      if (c) { ws = c.ws; sub = fmtWh(ws) + ' \u00b7 since AI_SCOPE started, ' + fmtWhen(c.t0); }
      else sub = d.online ? 'no GPU use recorded yet' : strataDownSub(d);
    }
    box.querySelector('.v').innerHTML = ws == null ? NA_HTML : '\u2248' + fmtUsd(ws / 3.6e6 * price);   // watt-seconds -> kWh: /3.6e6
    box.querySelector('.sub').textContent = sub;
  },
});

// AI_SCOPE-088: the scope-header helper text is gone - the header shows only the title (user direction 2026-10-31).
// AI_SCOPE-072: default gets one row of Strata GPU + VRAM tiles per card after Installed Models; on macOS the
// tiles stay out of the default (no per-process GPU stats there) but remain addable - they answer
// "Not available on this system" until 062 changes that.
// AI_SCOPE-073: a new row at the very bottom, "Strata RAM (Working)" + "Strata RAM (Committed)" - on every OS,
// since per-process RAM exists on Linux / macOS too. AI_SCOPE-075: "Strata CPU" leads that same row, also on
// every OS (procstats reports CPU % on Windows, Linux and macOS). AI_SCOPE-076: "Strata I/O" closes that row
// (the tile answers "Windows only for now" where the counters do not exist).
// AI_SCOPE-077: the mirror rows come from the shared family helper - same items, same order, same ids.
// AI_SCOPE-107: default = the user's saved page (2026-11-04): requests first below the card, loaded
// (cols "3,8") and installed (cols "3") after it, then the 093 token row (tps ptps ctx hit) above the mirror tail.
// AI_SCOPE-121: "Strata Cost" starts its own row after the token row (the 093/107 rows stay untouched); the
// 2026-11-09 split puts the two cost lenses side by side on it (GPU work is the row's subject, so the rate
// tile leads and the range tile follows - the user's numbering).
defineScopeLayout('strata', () => layoutOf([{ lens: 'strata.current', settings: { width: 'full' } }, { lens: 'strata.requests', settings: {}, row: true }, { lens: 'strata.loaded', settings: { perPage: 5, cols: '3,8' }, row: true }, { lens: 'strata.installed', settings: { perPage: 5, cols: '3' }, row: true }, { lens: 'strata.tps', settings: {}, row: true }, 'strata.ptps', 'strata.ctx', 'strata.hit', { lens: 'strata.costact', row: true }, 'strata.costtotal']).concat(STRATA_MIRROR.layout()));
