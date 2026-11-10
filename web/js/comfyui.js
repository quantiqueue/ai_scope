// AI_SCOPE dashboard - ComfyUI scope: current run, run history, installed models.
// Data: /api/comfy (runs, live progress) and /api/comfy/models (model files, every 5 s).
// Every card/table is a lens (lens.js), so it can also be shown on custom scopes, more than once.

function imgUrl(im, full) {
  return '/api/comfy/view?filename=' + encodeURIComponent(im.filename) + '&subfolder=' + encodeURIComponent(im.subfolder) +
         '&type=' + encodeURIComponent(im.type) + (full ? '&full=1' : '');
}
defineSource('comfyui', '/api/comfy?limit=100', null, null, null, 'processHistory');   // AI_SCOPE-083 / 084: the mirror history ring goes out as a delta (?since=)

// AI_SCOPE-083: the Hardware Mirror Lens family for ComfyUI (GPU / RAM Working / RAM Committed / CPU / I/O over
// ComfyUI's own processes) comes from the shared defineMirror factory - web/js/mirror.js (077). Decision 1A: the
// watch is the aggregate the scope already runs - the python.exe owner of the detected port (8188 / 8000) plus its
// whole descendant tree. The VRAM holder is the owner; custom-node subprocesses ride along; a python.exe under
// another port can never be claimed here, because only the netstat owner of ComfyUI's own port roots the family
// (077 batch 3's generic-runner rule). Decision 2A: attestation is live / off only - an idle ComfyUI keeps its
// last checkpoint resident in VRAM, so the family's 'idle' attestation (heartbeat zeros) would paint a false 0
// over a real holding; 'loading' sits inside an already-live running job, and 'unloading' / 'failed' have no
// honest signal - all recorded absent, not invented. Tile-id letter 'c', distinct from 's' / 'b' / 'o' / 'l' so
// saved layouts resolve.
const COMFYUI_MIRROR = defineMirror({ key: 'comfyui', name: 'ComfyUI', letter: 'c' });
defineSource('comfyui.models', '/api/comfy/models', 'comfyui', 5000);

// ---------- GPU cost lenses (AI_SCOPE-130) ----------
// The pair 121 shipped for Strata, 127 for Bionic, 128 for llama.cpp and 129 for Ollama, on the shared
// defineGpuCost helper: comfyui.costact / comfyui.costtotal, riding the SAME server-side accrual keyed to the
// 'comfyui' family (procstats has charged that key since 083's history ran for it; the mirror tiles above already
// carry 122's gpus[i].w). ComfyUI keeps a real saved run history (comfy-runs.jsonl), so the per-run energy is
// stamped when the row is SAVED (121's way, not 127's read-time attach) and the figures outlive a restart:
// /api/comfy sends cost + costDays built over the saved 1000-run ring.
// Family choice needs no decision here the way 128's D1 did: 083's watch is one family (the python.exe owner of
// ComfyUI's port plus its whole descendant tree), so one accrual prices the tiles, the two lenses and every Runs row.
// The 'local' flag (128's D2, carried to a second scope by 129): the scope's url setting can point at another PC,
// whose processes this AI_SCOPE can never measure, so that reads "on another PC - not measurable here" honestly
// instead of calling a reachable server "ComfyUI Offline".
// stateWords carries only 'off', and that is not an oversight: 083's decision 2A attests live / off and nothing
// else - an idle-but-reachable ComfyUI keeps its last checkpoint resident in VRAM, so an 'idle' attestation would
// paint heartbeat zeros over a real holding, 'loading' sits inside a job that is already live, and 'unloading' /
// 'failed' have no honest signal in ComfyUI's API. All recorded absent, not invented (081 / 082's precedent), so
// the two states that can appear on this tile are the two that are worded here.
defineGpuCost({
  key: 'comfyui', name: 'ComfyUI', letter: 'c',
  stateWords: { off: 'ComfyUI Offline' },
  online: d => d.online && d.local !== false,
  downSub: d => d.online ? 'on another PC \u2014 not measurable here' : 'ComfyUI Offline',
  daysClause: 'Cost Range "Days" sums the SAVED ComfyUI runs whose end falls in the window - the only energy record that outlives a restart, and no more complete than the 1000-run ring AI_SCOPE keeps (a run becomes a row only when ComfyUI reports it in its own history) - so it counts run energy and nothing else, and rows whose window nothing was measured inside count as nothing.',
  daysShort: 'the saved ComfyUI runs of the last N days',
  rangeTip: 'Session start: every measured GPU watt this AI_SCOPE server has attributed to ComfyUI (its python.exe process tree) since it booted. Days: the saved ComfyUI runs within the last N days (runs persist across restarts; GPU work outside a run - a checkpoint held resident in VRAM between jobs - is not in that sum).',
  daysNumTip: 'How many days back to sum (calendar days, today included), from the saved ComfyUI runs AI_SCOPE still holds. Its ring keeps the last 1000 runs, so a long range can only reach back as far as they do.',
});

// ---------- Current run ----------    (AI_SCOPE-088: the user's label rename - "Current job" → "Current run")
defineLens({
  id: 'comfyui.current', scope: 'comfyui', size: 'wide',
  name: 'Current run',
  description: 'The workflow ComfyUI is running: model, step progress, speed, elapsed time and ComfyUI\'s own GPU, VRAM, CPU and RAM use.',
  settings: [PROC_STATS_FIELD],
  markup: nowCardMarkup([
    { box:'progBox', label:'Progress', labelK:'progLabel', k:'prog', bar:'bar' },
    { box:'rateBox', label:'Speed', k:'rate', small:true },
    { box:'timeBox', label:'Elapsed', labelK:'timeLabel', k:'time' },
  ], 'Current run'),
  render(L, d) {
    const $ = L.$, cur = d.current;
    $('dot').className = 'dot' + (cur ? ' live' : d.online ? '' : ' off');
    const show = (k, on) => { $(k).hidden = !on; };
    if (!d.online) {
      $('title').textContent = 'ComfyUI is not running';
      setName($('model'), '—');
      show('progBox', false); show('rateBox', false); show('timeBox', false);
      $('foot').textContent = d.error || '';
      $('detail').textContent = '';
      setSysLoad($('load'), false);
    } else if (cur) {
      // state line: what the workflow is doing (the step count is in the Steps box below, so not repeated here):
      // "starting" until ComfyUI reports a progress bar, then "sampling", or the node's own label (e.g. "Remesh DC")
      const pr = cur.progress, doing = !pr ? 'starting' : pr.label && pr.label !== 'Steps' ? pr.label : 'sampling';
      $('title').textContent = 'Running — ' + doing + (d.pending ? ' (+' + d.pending + ' queued)' : '');
      setName($('model'), cur.summary.models.join(' + ') || 'unknown');
      const p = cur.progress;
      show('progBox', true); show('rateBox', true); show('timeBox', true);
      $('progLabel').textContent = p && p.label ? p.label : 'Steps';
      $('prog').textContent = p ? p.value + ' / ' + p.max : '…';   // "starting" is on the state line
      $('bar').style.width = p && p.max ? (100 * p.value / p.max) + '%' : '0';
      $('rate').textContent = p && p.itPerSec ? (p.itPerSec >= 1 ? p.itPerSec.toFixed(2) + ' it/s' : (1 / p.itPerSec).toFixed(2) + ' s/it') + (p.remaining ? ' · ~' + p.remaining + ' left' : '') : '—';
      $('timeLabel').textContent = 'Elapsed';
      $('time').textContent = fmtDur(cur.elapsedMs);
      const sm = cur.summary;
      setSysLoad($('load'), L.settings.procStats !== false, d.process, 'ComfyUI');   // ComfyUI's own GPU / VRAM / CPU / RAM when known (Windows), else whole computer
      // workflow details next to the state on the top line (the step count is already in the Steps box)
      $('detail').textContent = [sm.width ? sm.width + '×' + sm.height + (sm.batch > 1 ? ' ×' + sm.batch : '') : null,
        sm.sampler, sm.loras.length ? 'LoRA: ' + sm.loras.join(', ') : null].filter(Boolean).join(' · ');
      $('foot').textContent = '';
    } else {
      const a = d.average;
      $('title').textContent = 'Idle — no workflow running' + (d.pending ? ' (' + d.pending + ' queued)' : '');
      setName($('model'), a ? a.model : '—');
      show('progBox', false); show('rateBox', false); show('timeBox', !!a);
      $('timeLabel').textContent = a ? 'Avg run time (last ' + a.runs + ' runs)' : 'Avg run time';
      $('time').textContent = a ? fmtDur(a.avgMs) : '—';
      $('foot').textContent = 'Run a workflow in ComfyUI to see live stats.';
      $('detail').textContent = '';
      setSysLoad($('load'), false);
    }
  },
});

// ---------- Runs ----------
// AI_SCOPE-130: the two cost columns. The CELLS are the shared ones (lens.js REQ_COLS.energy / .cost), not a
// ComfyUI copy - same ≈ marker from the row's own provenance, same Wh / $ formatting priced at draw time, same
// honesty note - with this spec object naming the scope (127's o.app) and the subject (130's o.unit / o.span:
// a diffusion run, not a token request). The Runs table keeps its own columns, because a workflow run has no
// tokens to sit in the 094 uniform block, so only these two cells are borrowed and the note is never written twice.
// A ComfyUI row always closes its own window when ComfyUI stamps execution_start; the one gap reason that is NOT
// the shared note's is a history item without that stamp, so titleOf names only that (the reqTip rule: a scope's
// own title adds to the honesty notes, it can never silence them).
const COMFY_RUNS = {
  app: 'ComfyUI', unit: 'run',
  span: 'ComfyUI\u2019s own execution_start \u2192 execution_success stamps, steps and every other node alike \u2014 a checkpoint loaded before the job was queued is not included',
  titleOf: (key, r) => key === 'energy' && r.energyWs == null && r.start == null
    ? energyNote(r, COMFY_RUNS) + ' This run carries no execution_start stamp in ComfyUI\u2019s history, so its window is not known and nothing was integrated.'
    : null
};
defineLens({
  id: 'comfyui.runs', scope: 'comfyui', size: 'full',
  name: 'Runs',
  description: 'Finished workflow runs: model, size, steps, sampler, run time, peak load, status and images.',
  settings: [PER_PAGE_FIELD],
  markup: tableLensMarkup({ title:'Runs', hint:'', pager:true,
    foot: '\n      <div class="err" data-k="err" hidden></div>',
    cols:['Finished', 'Model', 'Size', 'Steps', 'Sampler', 'Run time', 'Peak load', 'Status', 'Images', 'Power Usage', 'Total Cost'] }),
  render(L, d) {
    const $ = L.$;
    $('err').hidden = d.runs.length > 0;
    $('err').style.color = 'var(--muted)';
    $('err').textContent = 'No runs recorded yet. Run a workflow in ComfyUI and it will appear here.';
    $('rows').innerHTML = paginate(L.key, d.runs.map(r => {
      const s = r.summary, isNew = isNewRow(L, r.id);
      const thumbs = r.images.slice(0, 3).map(im => '<a href="' + imgUrl(im, true) + '" target="_blank"><img loading="lazy" src="' + imgUrl(im) + '" alt=""></a>').join('') +
        (r.imageCount > 3 ? '<span class="more">+' + (r.imageCount - 3) + '</span>' : '');
      return '<tr' + (isNew ? ' class="new"' : '') + '>' +
        '<td>' + escH(fmtWhen(r.end)) + '</td>' +
        '<td class="model" title="' + escH(s.loras.length ? 'LoRA: ' + s.loras.join(', ') : '') + '">' + nameHtml(s.models.join(' + ') || '—') + '</td>' +
        '<td>' + (s.width ? s.width + '×' + s.height + (s.batch > 1 ? ' ×' + s.batch : '') : '—') + '</td>' +
        '<td>' + (s.steps != null ? s.steps : '—') + '</td>' +
        '<td>' + escH(s.sampler || '—') + '</td>' +
        '<td class="tps">' + fmtDur(r.durationMs) + '</td>' +
        peakCell(r.peak) +
        '<td><span class="status ' + escH(r.status) + '" title="' + escH(r.error || '') + '">' + escH(r.status) + '</span></td>' +
        '<td><div class="thumbs">' + (thumbs || '<span class="more">—</span>') + '</div></td>' +
        // AI_SCOPE-130: the two shared cost cells, last, exactly as 127-129 place them in their tables
        REQ_COLS.energy.td(r, COMFY_RUNS) + REQ_COLS.cost.td(r, COMFY_RUNS) + '</tr>';
    }), $('pager'), L.settings.perPage).join('');
    rowsDrawn(L);
  },
});

// ---------- Installed models (with type filter chips; each copy has its own filter) ----------
const CM_TYPES = { checkpoints:'Checkpoint', diffusion_models:'Diffusion model', loras:'LoRA', vae:'VAE', text_encoders:'Text encoder',
  clip_vision:'CLIP vision', controlnet:'ControlNet', upscale_models:'Upscaler', latent_upscale_models:'Latent upscaler', diffusers:'Diffusers',
  embeddings:'Embedding', ipadapter:'IP-Adapter', ip_adapter:'IP-Adapter', vae_approx:'VAE approx', style_models:'Style model' };
const cmType = f => CM_TYPES[f] || f.replace(/_/g, ' ');
defineLens({
  id: 'comfyui.installed', scope: 'comfyui', source: 'comfyui.models', size: 'full',
  name: 'Installed models',
  description: 'Model files in ComfyUI\'s folders, filterable by type, with VRAM fit, runs, last used and average run time.',
  settings: [PER_PAGE_FIELD],
  markup: tableLensMarkup({ title:'Installed models', pager:true,
    before: '\n    <div class="chips" data-k="chips"></div>',
    cols:['Model', 'Publisher', 'Type', 'Size', 'VRAM fit', 'Runs', 'Last used', 'Avg run time', 'Added'] }),
  init(L) {
    L.state.filter = 'all';
    L.$('chips').addEventListener('click', e => {
      const b = e.target.closest('[data-cmfilter]');
      if (!b) return;
      L.state.filter = b.dataset.cmfilter;
      pages[L.key] = 0;
      L.redraw();
    });
  },
  render(L, d) {
    const $ = L.$;
    const all = d.models;
    // filter chips (redrawn only when they change, so clicks aren't lost)
    const counts = {}, order = [];
    all.forEach(m => { if (!counts[m.folder]) { counts[m.folder] = 0; order.push(m.folder); } counts[m.folder]++; });
    if (L.state.filter !== 'all' && !counts[L.state.filter]) L.state.filter = 'all';
    const cmFilter = L.state.filter;
    const chipHtml = (all.length ? ['<button type="button" class="chip' + (cmFilter === 'all' ? ' on' : '') + '" data-cmfilter="all">All (' + all.length + ')</button>'] : [])
      .concat(order.map(f => '<button type="button" class="chip' + (cmFilter === f ? ' on' : '') + '" data-cmfilter="' + escH(f) + '">' + escH(cmType(f)) + ' (' + counts[f] + ')</button>')).join('');
    const chips = $('chips');
    if (chips._html !== chipHtml) { chips._html = chipHtml; chips.innerHTML = chipHtml; }

    const list = all.filter(m => cmFilter === 'all' || m.folder === cmFilter);
    const total = list.reduce((a, m) => a + (m.size || 0), 0);
    $('hint').textContent = all.length ? '— ' + list.length + ' files · ' + fmtBytes(total) + ' on disk' +
      (d.vramTotal ? ' · fit is file size vs ' + vramWord(d) + ' (ComfyUI can offload, so bigger models still run, slower)' : '') : '';
    $('empty').hidden = all.length > 0;
    $('empty').textContent = d.online ? 'Loading model list…' : 'ComfyUI is offline.';
    const fitText = { fits:'fits', tight:'tight', spills:'offloads' };
    const rows = list.map(m =>
      '<tr><td class="model" title="' + escH(m.file) + '">' + nameHtml(m.name, m.file) + '</td>' +
      '<td>' + escH(m.publisher || ONONE) + '</td>' +
      '<td>' + escH(cmType(m.folder)) + '</td>' +
      '<td>' + fmtBytes(m.size) + '</td>' +
      '<td>' + fitPill(m, fitText) + '</td>' +
      '<td>' + (m.runs ? fmtNum(m.runs) : ONONE) + '</td>' +
      '<td>' + (m.lastUsed ? escH(fmtWhen(m.lastUsed)) : ONONE) + '</td>' +
      '<td>' + (m.avgMs ? fmtDur(m.avgMs) : ONONE) + '</td>' +
      '<td>' + (m.modified ? new Date(m.modified).toLocaleDateString() : ONONE) + '</td></tr>');
    $('rows').innerHTML = paginate(L.key, rows, $('pager'), L.settings.perPage).join('');
  },
});

// AI_SCOPE-088: the scope-header helper text is gone - the header shows only the title (user direction 2026-10-31).
// AI_SCOPE-130 (user, 2026-11-10): the cost pair takes a NEW ROW after the Installed models lens, not a place at
// the end of an existing one - the mirror tail keeps breaking after it, as 083 left it.
defineScopeLayout('comfyui', () => layoutOf([{ lens: 'comfyui.current', settings: { width: 'full' } }, 'comfyui.runs', 'comfyui.installed', { lens: 'comfyui.costact', settings: {}, row: true }, 'comfyui.costtotal']).concat(COMFYUI_MIRROR.layout()));   // AI_SCOPE-083: mirror family tail
