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
const BIONIC_REQ = {
  title: 'Requests', pager: true, keyOf: r => r.key, hint: '',
  foot: '\n      <div class="err" data-k="err" hidden></div>',
  titleOf: (key, r) => key === 'finished' ? r.timestamp
    : key === 'duration' ? 'from Bionic\'s log: total time for the task'
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

// AI_SCOPE-088: the scope-header helper text is gone - the header shows only the title (user direction 2026-10-31).
// AI_SCOPE-077: the mirror rows (per-card GPU + VRAM pairs, not on macOS; then the bottom row
// Bionic CPU · Bionic RAM (Working) · Bionic RAM (Committed) · Bionic I/O on every OS) follow the loaded
// models, exactly like Strata's default (072 / 073 / 075 / 076 rules via mirror.js).
defineScopeLayout('bionic', () => layoutOf([{ lens: 'bionic.current', settings: { width: 'full' } }, 'bionic.loaded', 'bionic.requests', 'bionic.installed']).concat(BIONIC_MIRROR.layout()));
