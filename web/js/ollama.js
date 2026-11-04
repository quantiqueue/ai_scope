// AI_SCOPE dashboard - Ollama scope: current request, loaded models, requests, installed models.
// Data: /api/ollama (ollamastats.js; requests are recorded by AI_SCOPE's relay in front of Ollama).
// Every card/table is a lens (lens.js), so it can also be shown on custom scopes, more than once.

defineSource('ollama', '/api/ollama?limit=100', null, null, null, 'processHistory');   // AI_SCOPE-081 / 084: the mirror history ring goes out as a delta (?since=)

// AI_SCOPE-081: the Hardware Mirror Lens family for Ollama (GPU / RAM Working / RAM Committed / CPU / I/O over
// Ollama's own processes) comes from the shared defineMirror factory - web/js/mirror.js (077). The watch shape is
// Bionic's (model runners under the port owner, decision 1A: serve / tray overhead never counted), and the
// attestation is live / idle / off from /api/ps plus 'loading' only while the relay carries a request for a
// not-yet-loaded model (decision 2C2) - Ollama's API has no 'unloading' / 'failed' signal, recorded not invented.
// Tile-id letter 'o' (<letter>gp / <letter>ram_ / <letter>cpu / <letter>io), kept free of 's' (Strata) / 'b'
// (Bionic) so saved layouts resolve.
const OLLAMA_MIRROR = defineMirror({ key: 'ollama', name: 'Ollama', letter: 'o' });
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
    '</ul>' +
    '<p>More (making it permanent, checking it works, troubleshooting): ' +
    extLink('Configuring Ollama', 'https://github.com/quantiqueue/ai_scope/blob/main/manual/CONFIGURING_OLLAMA.md', 'The relay guide in the AI_SCOPE manual on GitHub') + '</p>');
}

// ---------- Current request (AI_SCOPE-100: the shared card engine) ----------
// Three boxes by design (D2): the relay only sees prompt sizes and context at request END, so no
// Prompt/Context box is put on the card to be empty. The relay's own endpoint rides the detail line.
// The direct-use warning foot stays Ollama's words (it names Ollama's behaviour, not a phase).
const OLLAMA_CARD = {
  title: 'Current request',
  boxes: ['speed', 'gen', 'time'],
  offline: () => ({ title: 'Ollama is not running' }),
  idle: d => {
    const a = d.average, u = ollamaDirectUse(d);
    return { title: 'Idle \u2014 no request running', model: a ? a.model : null,
      foot: u ? '\u26a0 Ollama answered a request at ' + fmtWhen(u.at) + ' (' + u.model + ') that didn\'t go through the AI_SCOPE relay, so it isn\'t recorded. Point apps at ' + ollamaProxyUrl(d) + ' (see ? in Requests).'
        : 'Send a request through the AI_SCOPE relay (' + ollamaProxyUrl(d) + ') to see live stats.',
      warn: !!u };
  },
  detail: (d, c) => c.endpoint + ' via AI_SCOPE relay',
  run: (d, c) => ({
    speed: { text: (c.phase === 'generating' || c.phase === 'thinking') && c.genTps != null ? fmtTps(c.genTps) : '…' },
    gen: { text: fmtNum(c.outputTokens) + (c.thinkTokens ? ' (' + fmtNum(c.thinkTokens) + ' thinking)' : '') },
    time: { text: fmtSec(c.elapsedMs) },
  }),
  name: 'Ollama',
};
defineLens({
  id: 'ollama.current', scope: 'ollama', size: 'wide',
  name: 'Current request',
  description: 'What Ollama is answering right now (through the AI_SCOPE relay): speed, tokens and the model process\'s GPU, VRAM, CPU and RAM use.',
  settings: [PROC_STATS_FIELD],
  markup: nowCardMarkupFor(OLLAMA_CARD),
  render(L, d) { nowCardRender(L, d, OLLAMA_CARD); },
});

// ---------- Loaded in memory (AI_SCOPE-099: the shared Loaded lens) ----------
// The app's own offload split (size_vram) leaves the columns per D2: it lives in the VRAM cell's
// tooltip now, and the cell itself shows AI_SCOPE's measured per-card reading (the family
// aggregate - Ollama does not separate a process per model, so several loaded rows stay gaps).
// Auto-unload becomes a live countdown; Ollama has no exclusives of its own (D4).
const OLLAMA_LOAD = {
  title: 'Loaded in memory',
  nameOf: m => m.name,
  ctxTitle: 'The context this model runs with',
  slotTitle: 'Ollama does not report per-model parallel slots',
  unloadOf: m => { const u = fmtUntil(m.expiresAt); return /^\d/.test(u) ? 'in ' + u : u; },
  loadedWhy: 'Ollama\'s API carries no load timestamp',
  extra: [],
  titleOf: (key, m) => {
    if (key !== 'vram') return null;
    if (m.sizeVram == null) return 'Ollama does not report how much of this model is on the GPU';
    return 'Ollama\'s own claim: ' + fmtBytes(m.sizeVram) + ' of ' + fmtBytes(m.size) + ' on GPU (green = GPU, amber = CPU)';
  }
};
defineLens({
  id: 'ollama.loaded', scope: 'ollama', size: 'full',
  name: 'Loaded in memory',
  description: 'Models Ollama has in memory: quantization, size, measured VRAM per card, context, when it unloads. The app\'s own GPU/CPU split is in the VRAM tooltip.',
  settings: [PER_PAGE_FIELD],
  markup: loadedTableMarkup(OLLAMA_LOAD),
  render(L, d) {
    const $ = L.$;
    const opts = Object.assign({}, OLLAMA_LOAD, { count: d.loaded.length, solo: d.loaded.length === 1, proc: d.process, multi: d.loaded.length > 1 });
    $('rows').innerHTML = paginate(L.key, d.loaded.map(m => loadedRow(m, opts)), $('pager'), L.settings.perPage).join('');
    $('empty').hidden = d.loaded.length > 0;
    $('empty').textContent = d.online ? 'No model loaded. Ollama loads a model on the first request and unloads it after it has been idle (5 min by default).' : 'Ollama is offline.';
    const spill = d.loaded.some(m => m.gpuPct != null && m.gpuPct < 100);
    const where = d.loaded.length ? procVramText(d.process) : '';   // per-card VRAM of the model process (Windows, AI_SCOPE-050)
    $('hint').textContent = [where, spill ? 'part of a model is running on the CPU, so generation will be slower' : ''].filter(Boolean).map((t, i) => (i ? '' : '— ') + t).join(' · ');
  },
});

// ---------- Requests (with the "?" relay setup help) ----------
// AI_SCOPE-094 slice 2: shared Requests columns; Ollama's own Load Time appended (its total
// includes that load, which is why it keeps a column of its own). AI_SCOPE-102 (D2): the Cached
// column fills from Ollama's prompt_eval_cached_count (0.33.3+) — the field the old comment said
// did not exist; pre-0.33.3 installs report no cached share, so the honest gap stays there.
// The derived faces also name their arithmetic in a tooltip, the same rule Bionic follows.
function ollamaReqTitle(key, r) {
  const pv = f => provOf(r, f);
  if (key === 'model') return r.endpoint;
  // AI_SCOPE-102 (D2): name the arithmetic on the faces that are ours (the rule Bionic follows).
  if (key === 'prompt') return r.cachedTokens != null ? 'Whole prompt: ' + fmtNum(r.promptTokens) + ' tokens, of which ' + fmtNum(r.cachedTokens) + ' came from the cache without being read' : null;
  if (key === 'cached') return r.cachedTokens != null ? 'Ollama\u2019s own prompt_eval_cached_count (0.33.3+); prompt seconds and speed cover the rest' : 'Not reported: Ollama 0.33.3 or earlier, or an OpenAI-style request \u2014 the cached share is unknowable here';
  if (key === 'promptTps') return r.promptRead != null ? 'Tokens re-read (' + fmtNum(r.promptRead) + ') \u00f7 Ollama\u2019s prompt seconds \u2014 the duration covers only the uncached share' : null;
  if (key === 'generated') return r.thinkTokens ? fmtNum(r.thinkTokens) + ' of these were thinking tokens' : null;
  if (key === 'genTps') return pv('genMs') === 'derived' ? 'generation time timed by the AI_SCOPE relay (OpenAI-style endpoint)' : null;
  if (key === 'firstToken') { const k = pv('firstTokenMs');
    return k === 'substitute' ? 'Substituted: no stream first-token stamp arrived, so this is model load + prompt eval time'
         : k === 'derived' ? 'Timed by the AI_SCOPE relay: when the first token of the stream arrived' : null; }
  if (key === 'duration') return 'whole request, model load included (see Load Time)';
  return null;
}
const OLLAMA_REQ = {
  title: 'Requests', pager: true, extra: ['loadMs'], keyOf: r => r.id, titleOf: ollamaReqTitle,
  headExtra: '\n      <button class="helpbtn" data-k="helpBtn" type="button" title="Why only these requests? How to set it up" aria-expanded="false">?</button>',
  before: '\n      <div class="relaywarn" data-k="warn" hidden><span data-k="warnText"></span> <button type="button" class="linkbtn" data-k="warnHelp">How to set up the relay</button></div>' +
    '\n      <div class="helpcard" data-k="help" hidden></div>',
  statusOf: r => r.status === 'ok' ? '' : '<span class="status ' + (r.status === 'aborted' ? 'interrupted' : 'error') + '" title="' + escH(r.error || '') + '">' + escH(r.status) + '</span> '
};
defineLens({
  id: 'ollama.requests', scope: 'ollama', size: 'full',
  name: 'Requests',
  description: 'Finished requests sent through the AI_SCOPE relay: tokens, speeds, first token, duration, peak load.',
  settings: [PER_PAGE_FIELD],
  markup: reqTableMarkup(OLLAMA_REQ),
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
    $('rows').innerHTML = paginate(L.key, d.rows.map(r => reqRow(L, r, OLLAMA_REQ)), $('pager'), L.settings.perPage).join('');
    rowsDrawn(L);
  },
});

// ---------- Installed models (AI_SCOPE-098: the shared Installed lens) ----------
// Arch and Modified left the lens by the user's decision; the Ollama library link stays, with the
// separate HF tag when the model also maps to a Hugging Face repo.
const OLLAMA_INST = {
  title: 'Installed models', pager: true, foot: '', contextField: 'maxContext',
  linkOf: m => m.libraryUrl || m.modelUrl,
  linkTitle: m => m.libraryUrl ? 'Ollama library page' : 'Hugging Face repo',
  tagOf: m => m.libraryUrl && m.modelUrl
    ? '<a class="tag" href="' + escH(m.modelUrl) + '" target="_blank" rel="noopener" title="Original model on Hugging Face' + (m.baseName ? ': ' + escH(m.baseName) : '') + ' (opens in a new tab)">HF' + EXT_ICON + '</a>'
    : '',
  fitText: { fits: 'fits', tight: 'tight', spills: 'partly CPU' },
  sizeTitle: 'Weights on disk; AI_SCOPE compares this against VRAM for the Fit column (context adds more)',
  fitNote: null   // composed below - it needs d.vramTotal, so the object cannot carry it
};
defineLens({
  id: 'ollama.installed', scope: 'ollama', size: 'full',
  name: 'Installed models',
  description: 'Models installed in Ollama, with publisher, size, features, VRAM fit and context.',
  settings: [PER_PAGE_FIELD],
  markup: instTableMarkup(OLLAMA_INST),
  render(L, d) {
    const $ = L.$, vt = d.vramTotal;
    const opts = Object.assign({}, OLLAMA_INST, { fitNote: vt ? 'fit is weights vs ' + vramWord(d) + ' (context adds more)' : null });
    $('hint').textContent = instHint(opts, d.installed);
    $('rows').innerHTML = paginate(L.key, d.installed.map(m => instRow(m, opts)), $('pager'), L.settings.perPage).join('');
  },
});

// ---------- token-performance lenses (AI_SCOPE-102) ----------
// The 093/101/103 pattern with Ollama's facts: the data path is AI_SCOPE's own RELAY, not app-API
// polling and not app logs, so the live gen rate is the relay's chunk-arrival observation — an
// estimate (≈ + OLLAMA_EST, the 101 shape), while the per-request rows carry Ollama's own counts
// divided by its own seconds (derived, PLAIN per 094's marker rule — Bionic-identical faces per the
// user's kickoff call). Three lenses now: D1 kept Gen + Prompt and skipped Context as unreportable; at
// review the user chose to build it anyway as an ARITHMETIC face (D11 below) - so the Ollama Context
// lens wears ≈ and says the sum on the tile, since Ollama reports no slot/context total anywhere.
// No Hit lens: parked as at 101. No slot machinery: Ollama reports no slots.
const OLLAMA_EST = 'Estimated by the AI_SCOPE relay from token-chunk arrivals (a sliding \u22643 s window; Ollama reports its own gen timings only in the final stream chunk)';
const oPerfOffline = d => d.online === false ? 'Ollama Offline' : null;   // shared by the three perf lenses

// ---------- Gen tok/s (clock board over the server ring, ollamastats.samplePerf) ----------
const O_TPS_HIST = [];
let OTPS_T1 = Date.now();   // the board time of the last render - the hover snaps to the DRAWN board (the 093 18:16 lesson)
subscribeSource('ollama', d => {
  const add = (d && d.tpsHistory) || [];
  if (add.length) {
    const last = O_TPS_HIST.length ? O_TPS_HIST[O_TPS_HIST.length - 1].t : 0;
    for (const p of add) if (p && p.t > last) O_TPS_HIST.push(p);
    sparkPrune(O_TPS_HIST);                                                      // time-sized, one older sample (092)
    if (O_TPS_HIST.length > 240) O_TPS_HIST.splice(0, O_TPS_HIST.length - 240);  // runaway-pace safety cap only
  }
});
const O_TPS_TIP = 'Generation speed of the Ollama request the card follows - estimated from the AI_SCOPE relay\u2019s look at the token chunks arriving (\u22643 s sliding window): Ollama reports its own timings only in the final chunk, so mid-stream this is the relay\u2019s counting, not the app\u2019s measurement. The line carries points only while a request generates or thinks; the reading phase and the gaps between requests show a break, never the average (D3). While nothing runs, the big number is AI_SCOPE\u2019s token-weighted average of recent relayed requests - Ollama\u2019s own eval_count \u00f7 eval_duration per request (for OpenAI-style requests the seconds are the relay\u2019s timing).';
defineLens({
  id: 'ollama.tps', scope: 'ollama', size: 'tile',
  name: 'Gen tok/s',
  description: 'Ollama generation speed with a 5-minute history: the relay\u2019s estimated tok/s (\u2248) while a request runs, the token-weighted average of recent requests (Ollama\u2019s own numbers) when not.',
  markup: () => tileHtml({ id: 'otps', label: 'Ollama Gen tok/s' }),
  render(L, d) {
    const box = L.el.querySelector('[data-tile="otps"]'); if (!box) return;
    box.querySelector('.ltitle').title = O_TPS_TIP;
    const now = Date.now(); OTPS_T1 = now;
    const pts = sparkFresh(O_TPS_HIST);
    const maxT = Math.max(10, 1.25 * pts.reduce((a, x) => Math.max(a, x.v || 0), 0));   // on-board only: "top" is what you SEE
    const clk = sparkClockSegs(O_TPS_HIST, now, h => h.v == null ? null : Math.min(100, 100 * h.v / maxT));
    const c = d.current;
    const run = c && (c.phase === 'generating' || c.phase === 'thinking') && c.genTps != null ? c.genTps : null;
    const avg = d.average && d.average.genTps != null ? d.average.genTps : null;
    const v = run != null ? run : avg;
    // D3 / terminology "provenance is per face": the LIVE rate is the relay's counting (≈), the average
    // face is Ollama's own eval_count / eval_duration per request, averaged (derived -> PLAIN, 094 rule).
    sparkTile(box, v == null ? null : Math.min(100, 100 * v / maxT),
      v == null ? NA_HTML : (run != null ? '\u2248 ' : '') + fmtTps(v),
      run != null ? 'live \u00b7 ' + cutName(c.model)
        : avg != null ? 'avg last ' + d.average.requests + ' \u00b7 ' + cutName(d.average.model)
        : oPerfOffline(d) || 'no requests through the relay yet',
      clk.segs, clk.caps);
    const vEl = box.querySelector('.v'); if (vEl && run != null) vEl.title = OLLAMA_EST;   // the estimate is the LIVE face's nature; the avg face is the app's own pair
    box.querySelector('.spark').title = 'Top of the chart = ' + fmtTps(maxT) + ' tok/s (5-minute board max) \u00b7 points are the relay\u2019s estimated rates';
  }
});
MIRROR_HOVER.push({ prefix: 'otps', fn: (spark, f, guide, tip) => {   // nearest sample on the DRAWN board (parity var), its own time printed
  sparkClockHover(spark, f, guide, tip, O_TPS_HIST, hs => (hs.v != null ? '\u2248 ' + fmtTps(hs.v) + ' tok/s \u00b7 ' + new Date(hs.t).toLocaleTimeString() + (hs.m ? ' \u00b7 ' + cutName(hs.m) : '') : 'n/a'), OTPS_T1);
} });

// ---------- Prompt tok/s (per-request rows; relayed native-API requests carry Ollama's own pair) ----------
let OPTPS_PTS = [];
const O_PTPS_TIP = 'Ollama prompt-processing speed, one point per finished relayed request \u2014 the tokens the engine actually re-read \u00f7 its prompt seconds (the Counts come from Ollama\u2019s own report, so the division is ours: the table\u2019s Prompt tok/s column shows the same numbers). Ollama reports the cached share since 0.33.3, and its duration covers only the tokens re-read, so the rate is a read rate \u2014 a continuing chat that re-reads 758 of an 11,217-token context reports the speed of those 758 (the Requests table\u2019s Cached column shows the rest). OpenAI-style relayed requests report no prompt seconds: they carry no point, and the line joins across them (never a zero \u2014 072). Big number = the latest request\u2019s; while none has run, the token-weighted average of recent requests, weighing the read tokens \u2014 exactly like Bionic and Strata.';
defineLens({
  id: 'ollama.ptps', scope: 'ollama', size: 'tile',
  name: 'Prompt tok/s',
  description: 'Ollama prompt speed per finished request (tokens re-read \u00f7 Ollama\u2019s prompt seconds): up to the last 100 relayed requests as one connected line; the big value is the latest request, or the read-weighted average when nothing has run.',
  markup: () => tileHtml({ id: 'optps', label: 'Ollama Prompt tok/s' }),
  render(L, d) {
    const box = L.el.querySelector('[data-tile="optps"]'); if (!box) return;
    box.querySelector('.ltitle').title = O_PTPS_TIP;
    const rows = Array.isArray(d.rows) ? d.rows : [];                     // newest first, the source's own order
    const rated = rows.filter(r => r && r.promptTps != null && r.end != null);
    OPTPS_PTS = rated.slice(0, 100).reverse().map((r, i) => ({ t: i, every: 1, v: r.promptTps, m: r.model, end: r.end }));
    const maxT = Math.max(100, 1.25 * OPTPS_PTS.reduce((a, x) => Math.max(a, x.v || 0), 0));   // prompt-scale floor like sptps/bptps
    const segs = sparkSegs(OPTPS_PTS, h => h.v == null ? null : Math.min(100, 100 * h.v / maxT));
    const last = rated[0];
    const pavg = d.promptAverage && d.promptAverage.promptTps != null ? d.promptAverage.promptTps : null;
    const v = last ? last.promptTps : pavg;   // Bionic parity (D4): latest row, else the read-weighted average
    sparkTile(box, v == null ? null : Math.min(100, 100 * v / maxT), v == null ? NA_HTML : fmtTps(v),   // PLAIN: derived from the app's own pair (094 marker rule)
      last ? 'last req \u00b7 ' + fmtWhen(last.end) + ' \u00b7 ' + cutName(last.model)
        : pavg != null ? 'avg last ' + d.promptAverage.requests + ' \u00b7 ' + cutName(d.promptAverage.model)
        : oPerfOffline(d) || 'no requests through the relay yet',
      segs);   // fully joined: the 097 interior rule draws no caps
    box.querySelector('.spark').title = 'Top of the chart = ' + fmtTps(maxT) + ' tok/s \u00b7 one step per request with a number, in order, up to the last 100';
  }
});
MIRROR_HOVER.push({ prefix: 'optps', fn: (spark, f, guide, tip) => {   // nearest REQUEST by index (the shrate/bptps form); its own end time, not the cursor's
  const n = OPTPS_PTS.length; if (!n) return;
  const ix = Math.max(0, Math.min(n - 1, Math.round(f * (n - 1))));
  const p = OPTPS_PTS[ix], x = n > 1 ? 100 * ix / (n - 1) : 100;
  guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.style.display = '';
  tip.hidden = false; tip.style.left = x + '%';
  tip.textContent = (p.v != null ? fmtTps(p.v) + ' tok/s \u00b7 ended ' + fmtWhen(p.end) : 'n/a') + (p.m ? ' \u00b7 ' + cutName(p.m) : '');
} });

// ---------- Context (AI_SCOPE-102 D11: the per-request TURN TOTAL, our arithmetic, marked ≈) ----------
// The user's call at review: Ollama reports no slot/context figure anywhere, but prompt + generated IS
// computable from two numbers the app does report - so the lens ships, wearing ≈ and saying in its own
// text that it is our sum, not the engine's holding. What it means: the tokens that request ended with.
// What it is NOT: what the slot carries into the next turn - measured on this box, the next turn reuses
// the PREVIOUS PROMPT minus Ollama's NumKeep 4 (4499 of a 4503-token prompt; the same turn had
// generated 2,186 more, so prompt + gen = 6,689 would have claimed 2,190 too many), and after the
// 5-minute auto-unload the reuse drops to 0 while the history was long. The ceiling IS Ollama's own
// number (/api/ps context_length), so the fill bar is honest even where the value is ours.
const olK = n => n == null ? '\u2014' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
const olCtx = n => n == null ? '\u2014' : n % 1024 === 0 ? (n / 1024) + 'K' : olK(n);
let OCTX_PTS = [];
const O_CTX_TIP = 'Context of each finished Ollama request - AI_SCOPE\'s OWN sum of that request\'s prompt tokens and generated tokens (marked \u2248 because it is arithmetic, not a figure Ollama reports: the two counts are the app\'s, the addition is ours). It reads "how much the model was asked to hold for that turn, including what its cache carried". It is NOT a claim about the next turn: Ollama is stateless per request, the client resends whatever it chooses, and what the engine actually reuses tracks the PREVIOUS PROMPT minus its NumKeep (4), not prompt + generated - measured on this box a turn that ended at 6,689 tokens (4,503 + 2,186) was followed 8 s later by a request reusing 4,499 of them, and after the 5-minute auto-unload the reuse reads 0. llama.cpp and Bionic can show a Context lens the app reports (their /slots and their log print the slot total); Ollama reports none, so this lens exists by the user\'s decision at 102\'s review, with the sum stated on the tile. Top of the chart is Ollama\'s own window for the loaded model (that part IS reported); where none is loaded it is what the board reached, labelled "(board max)". Rows missing either count carry no point - never a zero (072).';
defineLens({
  id: 'ollama.ctx', scope: 'ollama', size: 'tile',
  name: 'Context',
  description: 'Ollama context per finished request - \u2248 our sum of that request\'s prompt + generated tokens (Ollama reports no slot total), up to the last 100 requests as one connected line, against Ollama\'s own context window.',
  markup: () => tileHtml({ id: 'octx', label: 'Ollama Context' }),
  render(L, d) {
    const box = L.el.querySelector('[data-tile="octx"]'); if (!box) return;
    box.querySelector('.ltitle').title = O_CTX_TIP;
    const rows = Array.isArray(d.rows) ? d.rows : [];                     // newest first, the source's own order
    const filled = rows.filter(r => r && r.end != null && r.promptTokens != null && r.outputTokens != null);
    OCTX_PTS = filled.slice(0, 100).reverse().map((r, i) => ({ t: i, every: 1, v: r.promptTokens + r.outputTokens, m: r.model, end: r.end, prompt: r.promptTokens, gen: r.outputTokens, cached: r.cachedTokens }));
    // The ceiling is the app's own figure (context_length from /api/ps), else the board max.
    const ld = Array.isArray(d.loaded) ? d.loaded : [];
    const win = Math.max(0, ...ld.map(m => m.context || 0));
    const ceil = win || Math.max(1, OCTX_PTS.reduce((a, x) => Math.max(a, x.v || 0), 0));
    const segs = sparkSegs(OCTX_PTS, h => h.v == null ? null : Math.min(100, 100 * h.v / ceil));
    const last = filled[0];
    const sum = last ? last.promptTokens + last.outputTokens : null;
    sparkTile(box, sum != null ? Math.min(100, 100 * sum / ceil) : null,
      sum == null ? NA_HTML : '\u2248 ' + olK(sum) + (win ? '<small> / ' + olCtx(win) + '</small>' : ''),   // \u2248 = our sum (D11); the window is Ollama's own
      last ? 'last req \u00b7 ' + fmtWhen(last.end) + ' \u00b7 ' + cutName(last.model)
        : oPerfOffline(d) || 'no request with both counts yet',
      segs);   // joined: the 097 interior rule draws no caps
    const vEl2 = box.querySelector('.v'); if (vEl2 && sum != null) vEl2.title = '\u2248 AI_SCOPE\'s sum: prompt ' + fmtNum(last.promptTokens) + ' + generated ' + fmtNum(last.outputTokens) + ' (Ollama reports no slot/context total - the family rule that context comes from the app\'s own figure has no source here)';
    box.querySelector('.spark').title = 'Top of the chart = ' + olCtx(ceil) + (win ? ' (Ollama\'s own window for the loaded model)' : ' (board max)') + ' \u00b7 one step per request with both counts, in order, up to the last 100 \u00b7 each point is our \u2248 sum, not a reported figure';
  }
});
MIRROR_HOVER.push({ prefix: 'octx', fn: (spark, f, guide, tip) => {   // nearest REQUEST by index; the sum spelled out so the arithmetic is visible
  const n = OCTX_PTS.length; if (!n) return;
  const ix = Math.max(0, Math.min(n - 1, Math.round(f * (n - 1))));
  const p = OCTX_PTS[ix], x = n > 1 ? 100 * ix / (n - 1) : 100;
  guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.style.display = '';
  tip.hidden = false; tip.style.left = x + '%';
  tip.textContent = (p.v != null ? '\u2248 ' + olK(p.v) + ' tok = ' + fmtNum(p.prompt) + ' prompt + ' + fmtNum(p.gen) + ' generated' + (p.cached ? ' \u00b7 ' + fmtNum(p.cached) + ' came from the cache' : '') + ' \u00b7 ended ' + fmtWhen(p.end) : 'n/a') + (p.m ? ' \u00b7 ' + cutName(p.m) : '');
} });

// AI_SCOPE-088: the scope-header helper text is gone - the header shows only the title and the "?" button.
// The subscription stays for the help wiring: the "?" and its relay-setup card need fresh data.
subscribeSource('ollama', (d, err) => {
  if (err) return;
  const btn = document.getElementById('oHeadHelpBtn');
  btn.hidden = false;
  const box = document.getElementById('oHeadHelp'), html = ollamaHelpHtml(d);
  if (box.innerHTML !== html) box.innerHTML = html;
});
document.getElementById('oHeadHelpBtn').addEventListener('click', e => {
  const box = document.getElementById('oHeadHelp');
  box.hidden = !box.hidden;
  e.currentTarget.setAttribute('aria-expanded', String(!box.hidden));
});
// AI_SCOPE-107: default = the user's saved page (2026-11-04): requests, loaded and installed rows
// below the card, then the token row (102) above the mirror tail (081) - no extra saved settings on these rows.
defineScopeLayout('ollama', () => layoutOf([{ lens: 'ollama.current', settings: { width: 'full' } }, { lens: 'ollama.requests', settings: {}, row: true }, { lens: 'ollama.loaded', settings: {}, row: true }, { lens: 'ollama.installed', settings: {}, row: true }, { lens: 'ollama.tps', settings: {}, row: true }, 'ollama.ptps', 'ollama.ctx']).concat(OLLAMA_MIRROR.layout()));
