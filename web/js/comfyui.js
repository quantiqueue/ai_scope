// AI_SCOPE dashboard - ComfyUI scope: current job, runs, installed models.
// Data: /api/comfy (runs, live progress) and /api/comfy/models (model files, every 5 s).
// Every card/table is a lens (lens.js), so it can also be shown on custom scopes, more than once.

function imgUrl(im, full) {
  return '/api/comfy/view?filename=' + encodeURIComponent(im.filename) + '&subfolder=' + encodeURIComponent(im.subfolder) +
         '&type=' + encodeURIComponent(im.type) + (full ? '&full=1' : '');
}
defineSource('comfyui', '/api/comfy?limit=100');
defineSource('comfyui.models', '/api/comfy/models', 'comfyui', 5000);

// ---------- Current job ----------
defineLens({
  id: 'comfyui.current', scope: 'comfyui', size: 'wide',
  name: 'Current job',
  description: 'The workflow ComfyUI is running: model, step progress, speed, elapsed time and system load.',
  markup: nowCardMarkup([
    { box:'progBox', label:'Progress', labelK:'progLabel', k:'prog', bar:'bar' },
    { box:'rateBox', label:'Speed', k:'rate', small:true },
    { box:'timeBox', label:'Elapsed', labelK:'timeLabel', k:'time' },
  ], 'Current job'),
  render(L, d) {
    const $ = L.$, cur = d.current;
    $('dot').className = 'dot' + (cur ? ' live' : d.online ? '' : ' off');
    const show = (k, on) => { $(k).hidden = !on; };
    if (!d.online) {
      $('title').textContent = 'ComfyUI is not running';
      $('model').textContent = '—';
      show('progBox', false); show('rateBox', false); show('timeBox', false);
      $('foot').textContent = d.error || '';
      setSysLoad($('load'), false);
    } else if (cur) {
      $('title').textContent = 'Current job' + (d.pending ? ' (+' + d.pending + ' queued)' : '');
      $('model').textContent = cur.summary.models.join(' + ') || 'unknown';
      const p = cur.progress;
      show('progBox', true); show('rateBox', true); show('timeBox', true);
      $('progLabel').textContent = p && p.label ? p.label : 'Steps';
      $('prog').textContent = p ? p.value + ' / ' + p.max : 'starting…';
      $('bar').style.width = p && p.max ? (100 * p.value / p.max) + '%' : '0';
      $('rate').textContent = p && p.itPerSec ? (p.itPerSec >= 1 ? p.itPerSec.toFixed(2) + ' it/s' : (1 / p.itPerSec).toFixed(2) + ' s/it') + (p.remaining ? ' · ~' + p.remaining + ' left' : '') : '—';
      $('timeLabel').textContent = 'Elapsed';
      $('time').textContent = fmtDur(cur.elapsedMs);
      const sm = cur.summary;
      setSysLoad($('load'), true);
      $('foot').textContent = [sm.width ? sm.width + '×' + sm.height + (sm.batch > 1 ? ' ×' + sm.batch : '') : null,
        sm.steps ? sm.steps + ' steps' : null, sm.sampler, sm.loras.length ? 'LoRA: ' + sm.loras.join(', ') : null].filter(Boolean).join(' · ') || ' ';
    } else {
      const a = d.average;
      $('title').textContent = 'Idle — no workflow running' + (d.pending ? ' (' + d.pending + ' queued)' : '');
      $('model').textContent = a ? a.model : '—';
      show('progBox', false); show('rateBox', false); show('timeBox', !!a);
      $('timeLabel').textContent = a ? 'Avg run time (last ' + a.runs + ' runs)' : 'Avg run time';
      $('time').textContent = a ? fmtDur(a.avgMs) : '—';
      $('foot').textContent = ' ';
      setSysLoad($('load'), false);
    }
  },
});

// ---------- Runs ----------
defineLens({
  id: 'comfyui.runs', scope: 'comfyui', size: 'full',
  name: 'Runs',
  description: 'Finished workflow runs: model, size, steps, sampler, run time, peak load, status and images.',
  markup: tableLensMarkup({ title:'Runs', hint:'', pager:true,
    foot: '\n      <div class="err" data-k="err" hidden></div>',
    cols:['Finished', 'Model', 'Size', 'Steps', 'Sampler', 'Run time', 'Peak load', 'Status', 'Images'] }),
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
        '<td class="model" title="' + escH(s.loras.length ? 'LoRA: ' + s.loras.join(', ') : '') + '">' + escH(s.models.join(' + ') || '—') + '</td>' +
        '<td>' + (s.width ? s.width + '×' + s.height + (s.batch > 1 ? ' ×' + s.batch : '') : '—') + '</td>' +
        '<td>' + (s.steps != null ? s.steps : '—') + '</td>' +
        '<td>' + escH(s.sampler || '—') + '</td>' +
        '<td class="tps">' + fmtDur(r.durationMs) + '</td>' +
        peakCell(r.peak) +
        '<td><span class="status ' + escH(r.status) + '" title="' + escH(r.error || '') + '">' + escH(r.status) + '</span></td>' +
        '<td><div class="thumbs">' + (thumbs || '<span class="more">—</span>') + '</div></td></tr>';
    }), $('pager')).join('');
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
      '<tr><td class="model" title="' + escH(m.file) + '">' + escH(m.name) + '</td>' +
      '<td>' + escH(m.publisher || ONONE) + '</td>' +
      '<td>' + escH(cmType(m.folder)) + '</td>' +
      '<td>' + fmtBytes(m.size) + '</td>' +
      '<td>' + fitPill(m, fitText) + '</td>' +
      '<td>' + (m.runs ? fmtNum(m.runs) : ONONE) + '</td>' +
      '<td>' + (m.lastUsed ? escH(fmtWhen(m.lastUsed)) : ONONE) + '</td>' +
      '<td>' + (m.avgMs ? fmtDur(m.avgMs) : ONONE) + '</td>' +
      '<td>' + (m.modified ? new Date(m.modified).toLocaleDateString() : ONONE) + '</td></tr>');
    $('rows').innerHTML = paginate(L.key, rows, $('pager')).join('');
  },
});

// ---------- The ComfyUI scope page: header line + its lenses ----------
subscribeSource('comfyui', (d, err) => {
  const meta = document.getElementById('cMeta');
  if (err) { meta.textContent = 'Could not reach AI_SCOPE server: ' + err.message; return; }
  meta.textContent = (d.online ? 'connected to ' + d.url : 'ComfyUI offline') + ' · ' + d.totalRuns + ' runs saved · updates every 2 s';
});
mountScopePage('comfyui', ['comfyui.current', 'comfyui.runs', 'comfyui.installed']);
