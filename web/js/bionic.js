// AI_SCOPE dashboard - Bionic scope (LM Studio's Bionic): current request, requests (from its server logs), loaded and installed models.
// Data: /api/bionic (server log parser) and /api/bionic/models (the REST API of Bionic's local server).
// Every card/table is a lens (lens.js), so it can also be shown on custom scopes, more than once.

defineSource('bionic', '/api/bionic?limit=100', null, null, null, 'processHistory');   // AI_SCOPE-084: the history ring goes out as a delta (?since=)
defineSource('bionic.models', '/api/bionic/models', 'bionic');

// ---------- Hardware Mirror Lenses for Bionic (AI_SCOPE-077) ----------
// The family's first scope outside Strata: bionic.gpu / bionic.ram / bionic.cpu / bionic.io from the shared
// defineMirror() (web/js/mirror.js) — the rules and states are the family's (072 / 073 / 075 / 076), and the
// process rule is 049's: Bionic's model runs in a child llama-server.exe under its server port. Tile ids use
// 'b' prefixes (bgp*/ bram_* / bcpu / bio), so each tile hovers over Bionic's own history.
const BIONIC_MIRROR = defineMirror({ key: 'bionic', name: 'Bionic', letter: 'b' });

// ---------- Current request (AI_SCOPE-100: the shared card engine) ----------
// Four boxes: Bionic's log answers speed / generated / prompt-read / elapsed; it reports no live
// context use, so there is NO Context box on this card (D2 - never a box kept to be empty).
// The prompt-read % moved out of the Speed box into the Prompt box with its bar (it always
// belonged to the prompt). The offline state is new (D5): /api/bionic is log-based with no online
// flag of its own, so the card asks the models source (already read here for the foot) whether
// Bionic's local server is known down - never claims more than that source honestly knows.
const BIONIC_CARD = {
  title: 'Current request',
  boxes: ['speed', 'gen', 'prompt', 'time'],
  online: () => { const md = SOURCES['bionic.models'].data; return !(md && md.online === false); },
  offline: () => {
    const md = SOURCES['bionic.models'].data;
    return { title: 'Bionic is not running',
             foot: md && md.error ? 'Bionic\'s local server is not reachable (' + md.error + '). Start it on Bionic\'s Local Server screen.'
                                  : 'Bionic\'s local server is not reachable. Start it on Bionic\'s Local Server screen to see models.' };
  },
  idle: d => {
    const avg = d.average, models = SOURCES['bionic.models'].data;
    return { title: 'Idle \u2014 no request running', model: avg ? avg.model : null,
      foot: !models || !models.loaded ? ' '
        : !models.online ? 'Start Bionic\'s local server to see live stats.'
        : !models.loaded.length ? 'Load a model in Bionic to see live stats.'
        : 'Send a request to Bionic\'s local server to see live stats.' };
  },
  // 'starting' is Bionic's own honest state: the log line that launches a task carries no progress
  // yet, and its prompt-finish line only arrives with the completed request.
  doing: c => c.phase === 'generating' ? 'generating' : (c.progress > 0 && c.progress < 1 ? 'reading prompt' : 'starting'),
  run: (d, c) => ({
    speed: { text: c.phase === 'generating' && c.genTps != null ? fmtTps(c.genTps) : '…' },
    gen: c.phase === 'generating' && c.outputTokens ? { text: fmtNum(c.outputTokens) } : null,
    prompt: c.phase === 'reading'
      ? { label: 'Prompt read',
          text: c.progress > 0 ? (c.promptRead != null ? fmtNum(c.promptRead) + ' tokens \u00b7 ' : '') + Math.round(c.progress * 100) + '%' : '…',
          bar: 100 * c.progress }
      : null,   // Bionic's log carries no live prompt figure once generating starts - box hides
    time: { text: fmtSec(c.elapsedMs) },
  }),
  name: 'Bionic',
};
defineLens({
  id: 'bionic.current', scope: 'bionic', size: 'wide',
  name: 'Current request',
  description: 'What Bionic\'s local server is answering right now: speed, tokens, prompt progress and the model process\'s GPU, VRAM, CPU and RAM use.',
  settings: [PROC_STATS_FIELD],
  markup: nowCardMarkupFor(BIONIC_CARD),
  render(L, d) { nowCardRender(L, d, BIONIC_CARD); },
});

// ---------- Loaded in memory (AI_SCOPE-099: the shared Loaded lens) ----------
// Quant left the Model cell (uniform column now); Bionic's own gpuRatio claim rides the VRAM
// tooltip (D2 - the cell itself is only ever AI_SCOPE's measured reading). Flash attention and
// KV placement stay as Bionic's exclusives (D4). Parallel rides the uniform Slots column.
const BIONIC_LOAD = {
  title: 'Loaded in memory',
  nameOf: m => m.id || m.name,
  linkOf: m => m.modelUrl || null,
  slotsField: 'parallel',
  ctxTitle: 'The context this instance runs with / the model\'s maximum',
  slotTitle: 'Parallel slots Bionic runs this model in',
  unloadOf: m => m.ttlMs ? fmtDur(m.ttlMs) + ' idle' : 'off',
  loadedWhy: 'Bionic\'s API carries no load timestamp',
  vramWhy: 'No Bionic model process found right now - the API lags behind a load or unload by up to 10 s',
  extra: ['flash', 'kvWhere'],
  titleOf: (key, m) => key === 'vram' && m.gpuRatio != null
    ? 'Bionic\'s own claim: ' + Math.round(m.gpuRatio <= 1 ? m.gpuRatio * 100 : m.gpuRatio) + '% of the model offloaded to GPU'
    : null
};
defineLens({
  id: 'bionic.loaded', scope: 'bionic', source: 'bionic.models', size: 'full',
  name: 'Loaded in memory',
  description: 'Models Bionic has loaded: quantization, size, measured VRAM per card, context, slots, auto-unload, plus Bionic\'s flash attention and KV placement.',
  settings: [PER_PAGE_FIELD],
  markup: loadedTableMarkup(BIONIC_LOAD),
  render(L, d) {
    const $ = L.$;
    const opts = Object.assign({}, BIONIC_LOAD, { count: d.loaded.length, solo: d.loaded.length === 1, proc: d.process, multi: d.loaded.length > 1 });
    $('rows').innerHTML = paginate(L.key, d.loaded.map(m => loadedRow(m, opts)), $('pager'), L.settings.perPage).join('');
    $('empty').hidden = d.loaded.length > 0;
    $('empty').textContent = d.online ? 'No model loaded. Load one in Bionic, or it loads on the first request (JIT loading).'
      : 'Bionic\'s local server is not reachable' + (d.error ? ' (' + d.error + ')' : '') + '. Start it on Bionic\'s Local Server screen to see models.';
    // The family total stays in the hint (D2) - what the VRAM column shows per row is the same
    // reading when one model is loaded, and honest gaps when several are.
    const where = d.loaded.length ? procVramText(d.process) : '';
    if (where) { $('hint').textContent = '— ' + where; return; }
    // Windows: no model process (yet) - e.g. a model being unloaded or loaded; the API lags behind by up to 10 s
    if (d.processSupported) { $('hint').textContent = ''; return; }
    const vt = d.vramTotal;
    const big = vt ? d.loaded.filter(m => m.size && m.size > vt) : [];
    $('hint').textContent = big.length ? (d.vramCards > 1 ? '— larger than one card (' + fmtBytes(vt) + ' VRAM), so it is split across GPUs or partly in system RAM' : '— larger than ' + fmtBytes(vt) + ' VRAM, so part of it runs from system RAM') : (d.loaded.length ? '— Bionic does not report GPU offload; compare VRAM on the Hardware tab' : '');
  },
});

// ---------- Requests ----------
// AI_SCOPE-094 slice 2: shared Requests columns. Bionic has no column of its own — everything it
// reports is in the uniform set. Its first-token number is the prefill duration (the log carries
// no TTFT line), which lmstats marks as a substitute, so the cell shows ≈ with the reason.
// AI_SCOPE-103 (review): Bionic's Prompt column was filling from the prompt-eval COUNT, which is
// only the tokens re-read after cache reuse — not the prompt. lmstats now takes the total from the
// engine's own slot release line and derives Cached from it (both `derived`, so plain per 094's
// marker rule); the titles below say where each number comes from, since the marker no longer does.
const BIONIC_REQ = {
  title: 'Requests', pager: true, keyOf: r => r.key, hint: '',
  foot: '\n      <div class="err" data-k="err" hidden></div>',
  titleOf: (key, r) => key === 'finished' ? r.timestamp
    : key === 'duration' ? 'from Bionic\'s log: total time for the task'
    : key === 'prompt' ? (r.contextTokens != null && r.outputTokens != null
        ? 'the whole prompt as the engine held it: its slot total at release minus what it generated that turn (' + r.contextTokens + ' - ' + r.outputTokens + ')'
        : 'Bionic reported no slot total for this request, so this is the prompt tokens it read - marked \u2248')
    : key === 'cached' ? (r.cachedTokens != null
        ? 'prompt already in the engine\'s cache, not read again this turn (' + fmtNum(r.promptTokens) + ' prompt - ' + fmtNum(r.promptRead) + ' read)'
        : 'Bionic reported no slot total for this request, so the reused share is unknown')
    : key === 'promptTps' ? 'Bionic\'s own rate over the tokens it actually read this turn (' + fmtNum(r.promptRead) + ' in ' + fmtDur(r.promptMs) + '); the rest of the prompt came from cache'
    : key === 'firstToken' && provOf(r, 'firstTokenMs') === 'substitute' ? 'Bionic\'s log carries no first-token line at all, so this is the prompt-eval time'
    : null
};
defineLens({
  id: 'bionic.requests', scope: 'bionic', size: 'full',
  name: 'Requests',
  description: 'Finished requests from Bionic\'s server logs: tokens, speeds, first token, duration, peak load.',
  settings: [PER_PAGE_FIELD],
  markup: reqTableMarkup(BIONIC_REQ),
  render(L, data) {
    const $ = L.$;
    $('err').hidden = !data.error; $('err').textContent = data.error || '';
    $('rows').innerHTML = paginate(L.key, data.rows.map(r => reqRow(L, r, BIONIC_REQ)), $('pager'), L.settings.perPage).join('');
    rowsDrawn(L);
  },
});

// ---------- Installed models (AI_SCOPE-098: the shared Installed lens) ----------
// Arch and Modified left the lens by the user's decision; the modified date Bionic shows is a
// catalog/HF lookup date, not a file mtime - one more reason it is not a column.
const BIONIC_INST = {
  title: 'Installed models', pager: true, contextField: 'maxContext',
  linkOf: m => m.modelUrl,
  linkTitle: m => (m.source ? m.source + ': ' : '') + (m.modelUrl || m.key),
  featOf: m => [m.vision ? 'vision' : null, m.tools ? 'tools' : null, m.reasoning ? 'reasoning' : null,
                m.type && m.type.indexOf('embed') === 0 ? 'embedding' : null].filter(Boolean),
  fitText: { fits: 'fits', tight: 'tight', spills: 'partly CPU' },
  sizeTitle: 'Weights on disk; AI_SCOPE compares this against VRAM for the Fit column (context adds more)'
};
defineLens({
  id: 'bionic.installed', scope: 'bionic', source: 'bionic.models', size: 'full',
  name: 'Installed models',
  description: 'Models downloaded in Bionic, with publisher, size, features, VRAM fit and context.',
  settings: [PER_PAGE_FIELD],
  markup: instTableMarkup(BIONIC_INST),
  render(L, d) {
    const $ = L.$, vt = d.vramTotal;
    const opts = Object.assign({}, BIONIC_INST, { fitNote: vt ? 'fit is weights vs ' + vramWord(d) + ' (context adds more)' : null });
    $('rows').innerHTML = paginate(L.key, d.installed.map(m => instRow(m, opts)), $('pager'), L.settings.perPage).join('');
    $('empty').hidden = d.installed.length > 0;
    $('empty').textContent = d.online ? 'No models found.' : (d.url ? 'Bionic\'s local server is not reachable.' : 'Bionic is not installed (set its folder on the Scopes page).');
    $('hint').textContent = instHint(opts, d.installed);
  },
});

// ---------- token-performance lenses (AI_SCOPE-103) ----------
// The 093/101 pattern for Bionic, D1-D5 as decided at kickoff. Bionic's facts differ from llama.cpp's
// in two ways that matter: the engine's OWN numbers are exact (the tg / prompt-eval lines it prints),
// and the log names no slots — so no Slot picker, and no ≈ on measured faces (101's LC_EST machinery
// is deliberately NOT copied here). The gen ring is server-side (lmstats.samplePerf), sampled from
// the SAME task the card shows, generating phase only (D3: reading is not generation — stratastats'
// phase gate is the precedent); prefill speed lives in Prompt tok/s instead, and every Bionic row
// carries it (no --metrics gate), so both row lenses are fully populated.
// Context (D10, restoring D6 after the D9 cut): the points are the engine's OWN slot totals, never
// arithmetic. The catch the user found: Bionic runs ONE slot and lets its helper calls (auto-title /
// suggestions: 65 read, 9 generated, 46 ms) borrow it ~20 ms after a real turn releases, resetting
// the slot from 7,574 to 74 - so "the newest row" is not "the chat". Their rule (2026-11-03): a
// request under B_CTX_FLOOR tokens is not plotted. Measured on this box, that floor also hides a
// dozen ordinary short chats (of 1,000 rows, 48 sit under 256 - e.g. 77 read / 82 generated over
// 4.7 s, ctx 158), so the rule is stated on the tile, never left invisible.
const BK = n => n == null ? '—' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
const BCX = n => n == null ? '—' : n % 1024 === 0 ? (n / 1024) + 'K' : BK(n);
const B_CTX_FLOOR = 256;
function bionicOffline() { const md = SOURCES['bionic.models'].data; return !!(md && md.online === false); }   // the card's own D5 guard, shared

// ---------- Gen tok/s (clock board over the server ring) ----------
const B_TPS_HIST = [];
let BTPTS_T1 = Date.now();   // the board time of the last render - the hover snaps to the DRAWN board (the 093 18:16 lesson)
subscribeSource('bionic', d => {
  const add = (d && d.tpsHistory) || [];
  if (add.length) {
    const last = B_TPS_HIST.length ? B_TPS_HIST[B_TPS_HIST.length - 1].t : 0;
    for (const p of add) if (p && p.t > last) B_TPS_HIST.push(p);
    sparkPrune(B_TPS_HIST);                                                      // time-sized, one older sample (092)
    if (B_TPS_HIST.length > 240) B_TPS_HIST.splice(0, B_TPS_HIST.length - 240);  // runaway-pace safety cap only
  }
});
const B_TPS_TIP = 'Generation speed of the Bionic request the card follows - Bionic\'s OWN rate from its server log (the tg line, the 3-second figure when the engine offers one): a measurement, not an estimate. The line carries points only while a request generates; prefill shows a break, not the average (D3), and so do the gaps between requests. While nothing runs, the big number is AI_SCOPE\'s token-weighted average of the last 100 logged requests of the newest model.';
defineLens({
  id: 'bionic.tps', scope: 'bionic', size: 'tile',
  name: 'Gen tok/s',
  description: 'Bionic generation speed with a 5-minute history: Bionic\'s own logged tok/s while a request generates, the token-weighted average of recent requests when not.',
  markup: () => tileHtml({ id: 'btps', label: 'Bionic Gen tok/s' }),
  render(L, d) {
    const box = L.el.querySelector('[data-tile="btps"]'); if (!box) return;
    box.querySelector('.ltitle').title = B_TPS_TIP;
    const now = Date.now(); BTPTS_T1 = now;
    const pts = sparkFresh(B_TPS_HIST);
    const maxT = Math.max(10, 1.25 * pts.reduce((a, x) => Math.max(a, x.v || 0), 0));   // on-board only: "top" is what you SEE
    const clk = sparkClockSegs(B_TPS_HIST, now, h => h.v == null ? null : Math.min(100, 100 * h.v / maxT));
    const run = d.current && d.current.phase === 'generating' && d.current.genTps != null ? d.current.genTps : null;
    const avg = d.average && d.average.genTps != null ? d.average.genTps : null;
    const v = run != null ? run : avg;
    sparkTile(box, v == null ? null : Math.min(100, 100 * v / maxT), v == null ? NA_HTML : fmtTps(v),   // PLAIN: the engine measured it (D4)
      run != null ? 'live \u00b7 ' + cutName(d.current.model)
        : avg != null ? 'avg last ' + d.average.requests + ' \u00b7 ' + cutName(d.average.model)
        : bionicOffline() ? 'Bionic Offline' : 'no requests recorded yet',
      clk.segs, clk.caps);
    box.querySelector('.spark').title = 'Top of the chart = ' + fmtTps(maxT) + ' tok/s (5-minute board max) \u00b7 points are Bionic\'s own logged rates';
  }
});
MIRROR_HOVER.push({ prefix: 'btps', fn: (spark, f, guide, tip) => {   // nearest sample on the DRAWN board (parity var), its own time printed
  sparkClockHover(spark, f, guide, tip, B_TPS_HIST, hs => (hs.v != null ? fmtTps(hs.v) + ' tok/s \u00b7 ' + new Date(hs.t).toLocaleTimeString() + (hs.m ? ' \u00b7 ' + cutName(hs.m) : '') : 'n/a'), BTPTS_T1);
} });

// ---------- Prompt tok/s (per-request rows; every Bionic row has one) ----------
let BPTPS_PTS = [];
const B_PTPS_TIP = 'Bionic prompt-processing speed, one point per finished request - the prompt-eval line of Bionic\'s own log (tokens \u00f7 its seconds: the app\'s measurement, not an estimate; the table\'s Prompt tok/s column shows the same numbers). What it divides is the tokens the engine RE-READ this turn, not the whole prompt: Bionic\'s prompt cache carries the rest of the conversation (the Requests table\'s Cached column shows that share), so a turn reading 758 tokens of an 11,217-token context reports the speed of those 758. Small reads also carry per-request overhead, which is why the column spans 9 to 15,000+ tok/s honestly. Unlike llama.cpp there is no --metrics gate: EVERY logged request carries one. Big number = the latest request\'s; while none is recent, the token-weighted average of the last 100 logged requests (like Strata).';
defineLens({
  id: 'bionic.ptps', scope: 'bionic', size: 'tile',
  name: 'Prompt tok/s',
  description: 'Bionic prompt speed per finished request: up to the last 100 logged requests as one connected line; the big value is the latest request, or the token-weighted average when nothing has run.',
  markup: () => tileHtml({ id: 'bptps', label: 'Bionic Prompt tok/s' }),
  render(L, d) {
    const box = L.el.querySelector('[data-tile="bptps"]'); if (!box) return;
    box.querySelector('.ltitle').title = B_PTPS_TIP;
    const rows = Array.isArray(d.rows) ? d.rows : [];                     // newest first, the source's own order
    const rated = rows.filter(r => r && r.promptTps != null && r.end != null);
    BPTPS_PTS = rated.slice(0, 100).reverse().map((r, i) => ({ t: i, every: 1, v: r.promptTps, m: r.model, end: r.end }));
    const maxT = Math.max(100, 1.25 * BPTPS_PTS.reduce((a, x) => Math.max(a, x.v || 0), 0));   // prompt-scale floor like sptps
    const segs = sparkSegs(BPTPS_PTS, h => h.v == null ? null : Math.min(100, 100 * h.v / maxT));
    const last = rated[0];
    const pavg = d.promptAverage && d.promptAverage.promptTps != null ? d.promptAverage.promptTps : null;
    const v = last ? last.promptTps : pavg;   // D3 (user: "prompt idle is average just like strata")
    sparkTile(box, v == null ? null : Math.min(100, 100 * v / maxT), v == null ? NA_HTML : fmtTps(v),   // PLAIN: both faces are the app's own numbers averaged (D4)
      last ? 'last req \u00b7 ' + fmtWhen(last.end) + ' \u00b7 ' + cutName(last.model)
        : pavg != null ? 'avg last ' + d.promptAverage.requests + ' \u00b7 ' + cutName(d.promptAverage.model)
        : bionicOffline() ? 'Bionic Offline' : 'no requests recorded yet',
      segs);   // fully joined: the 097 interior rule draws no caps
    box.querySelector('.spark').title = 'Top of the chart = ' + fmtTps(maxT) + ' tok/s \u00b7 one step per request, in order, up to the last 100';
  }
});
MIRROR_HOVER.push({ prefix: 'bptps', fn: (spark, f, guide, tip) => {   // nearest REQUEST by index (the shrate form); its own end time, not the cursor's
  const n = BPTPS_PTS.length; if (!n) return;
  const ix = Math.max(0, Math.min(n - 1, Math.round(f * (n - 1))));
  const p = BPTPS_PTS[ix], x = n > 1 ? 100 * ix / (n - 1) : 100;
  guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.style.display = '';
  tip.hidden = false; tip.style.left = x + '%';
  tip.textContent = (p.v != null ? fmtTps(p.v) + ' tok/s \u00b7 ended ' + fmtWhen(p.end) : 'n/a') + (p.m ? ' \u00b7 ' + cutName(p.m) : '');
} });


// ---------- Context (per-request slot totals; helper-call floor - D10) ----------
let BCTX_PTS = [];
const B_CTX_TIP = 'How much context Bionic\'s engine held at the end of each finished request - the token total its own slot reports in the log (exact, from that request\'s release line), INCLUDING the conversation carried in the prompt cache, so it is never prompt + generated. One point per request, up to the last 100, in order. Bionic gives no session id, and its slot is shared: after a real turn its helper calls (auto-title / suggestions) take the same slot and reset it, which is why requests under ' + B_CTX_FLOOR + ' tokens are NOT plotted here - the trade-off is that genuinely short chats are hidden too, so the Requests table keeps every row.';
defineLens({
  id: 'bionic.ctx', scope: 'bionic', size: 'tile',
  name: 'Context',
  description: 'Bionic context per finished request - the token total the engine\'s own slot reported at that request\'s end (prompt cache included), up to the last 100 requests as one connected line. Requests under ' + B_CTX_FLOOR + ' tokens (Bionic\'s helper calls) are not plotted.',
  markup: () => tileHtml({ id: 'bctx', label: 'Bionic Context' }),
  render(L, d) {
    const box = L.el.querySelector('[data-tile="bctx"]'); if (!box) return;
    box.querySelector('.ltitle').title = B_CTX_TIP;
    const rows = Array.isArray(d.rows) ? d.rows : [];
    // no slot total: no point; under the floor: Bionic's own helper call, not the chat (D10)
    const filled = rows.filter(r => r && r.end != null && r.contextTokens != null && r.contextTokens >= B_CTX_FLOOR);
    BCTX_PTS = filled.slice(0, 100).reverse().map((r, i) => ({ t: i, every: 1, v: r.contextTokens, m: r.model, end: r.end, cached: r.cachedTokens, task: r.task }));
    // Ceiling: the loaded instance's context window when known (lmapi 'context'), else what the board reached.
    const md = SOURCES['bionic.models'].data;
    const win = md && md.loaded ? Math.max(0, ...md.loaded.map(m => m.context || 0)) : 0;
    const ceil = win || Math.max(1, BCTX_PTS.reduce((a, x) => Math.max(a, x.v || 0), 0));
    const segs = sparkSegs(BCTX_PTS, h => h.v == null ? null : Math.min(100, 100 * h.v / ceil));
    const last = filled[0];
    const ctx = last ? last.contextTokens : null;   // exact - the engine's own number (D4)
    sparkTile(box, ctx != null ? Math.min(100, 100 * ctx / ceil) : null,
      ctx == null ? NA_HTML : BK(ctx) + (win ? '<small> / ' + BCX(win) + '</small>' : ''),
      last ? 'last req \u00b7 ' + fmtWhen(last.end) + ' \u00b7 ' + cutName(last.model)
        : bionicOffline() ? 'Bionic Offline' : 'no request over ' + B_CTX_FLOOR + ' tokens in the logs',
      segs);   // joined like the hit lens
    box.querySelector('.spark').title = 'Top of the chart = ' + BCX(ceil) + (win ? ' (the loaded window)' : ' (board max)') + ' \u00b7 one step per plotted request, in order, up to the last 100 \u00b7 floor ' + B_CTX_FLOOR + ' tokens';
  }
});
MIRROR_HOVER.push({ prefix: 'bctx', fn: (spark, f, guide, tip) => {   // nearest REQUEST by index; its own end time, not the cursor's
  const n = BCTX_PTS.length; if (!n) return;
  const ix = Math.max(0, Math.min(n - 1, Math.round(f * (n - 1))));
  const p = BCTX_PTS[ix], x = n > 1 ? 100 * ix / (n - 1) : 100;
  guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.style.display = '';
  tip.hidden = false; tip.style.left = x + '%';
  tip.textContent = (p.v != null ? BK(p.v) + ' tok' + (p.cached ? ' \u00b7 ' + BK(p.cached) + ' cached' : '') + ' \u00b7 ended ' + fmtWhen(p.end) + ' \u00b7 task ' + p.task : 'n/a') + (p.m ? ' \u00b7 ' + cutName(p.m) : '');
} });

// AI_SCOPE-088: the scope-header helper text is gone - the header shows only the title (user direction 2026-10-31).
// AI_SCOPE-077: the mirror rows (per-card GPU + VRAM pairs, not on macOS; then the bottom row
// Bionic CPU · Bionic RAM (Working) · Bionic RAM (Committed) · Bionic I/O on every OS) follow the loaded
// models, exactly like Strata's default (072 / 073 / 075 / 076 rules via mirror.js).
// AI_SCOPE-103: the Gen tok/s + Prompt tok/s + Context row leads right after the current-request card
// (093 D5 / 101 D6 placement); loaded / requests / installed are full-width, so the tile row is theirs alone.
defineScopeLayout('bionic', () => layoutOf([{ lens: 'bionic.current', settings: { width: 'full' } }, 'bionic.tps', 'bionic.ptps', 'bionic.ctx', 'bionic.loaded', 'bionic.requests', 'bionic.installed']).concat(BIONIC_MIRROR.layout()));
