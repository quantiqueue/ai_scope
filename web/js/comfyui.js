// AI_SCOPE dashboard - ComfyUI tab: current job, runs, installed models.

function imgUrl(im, full) {
  return '/api/comfy/view?filename=' + encodeURIComponent(im.filename) + '&subfolder=' + encodeURIComponent(im.subfolder) +
         '&type=' + encodeURIComponent(im.type) + (full ? '&full=1' : '');
}
let cSeen = new Set(), cFirst = true;
async function loadComfy() {
  if (!isInstalled('comfyui')) return;
  const $ = id => document.getElementById(id);
  let d;
  try { d = await (await fetch('/api/comfy?limit=100', { cache:'no-store' })).json(); }
  catch (e) { $('cMeta').textContent = 'Could not reach AI_SCOPE server: ' + e.message; return; }

  $('cMeta').textContent = (d.online ? 'connected to ' + d.url : 'ComfyUI offline') + ' · ' + d.totalRuns + ' runs saved · updates every 2 s';
  const cur = d.current;
  $('cDot').className = 'dot' + (cur ? ' live' : d.online ? '' : ' off');
  const show = (id, on) => { $(id).hidden = !on; };
  if (!d.online) {
    $('cTitle').textContent = 'ComfyUI is not running';
    $('cModel').textContent = '—';
    show('cProgBox', false); show('cRateBox', false); show('cTimeBox', false);
    $('cFoot').textContent = d.error || '';
    setSysLoad('cLoad', false);
  } else if (cur) {
    $('cTitle').textContent = 'Current job' + (d.pending ? ' (+' + d.pending + ' queued)' : '');
    $('cModel').textContent = cur.summary.models.join(' + ') || 'unknown';
    const p = cur.progress;
    show('cProgBox', true); show('cRateBox', true); show('cTimeBox', true);
    $('cProgLabel').textContent = p && p.label ? p.label : 'Steps';
    $('cProg').textContent = p ? p.value + ' / ' + p.max : 'starting…';
    $('cBar').style.width = p && p.max ? (100 * p.value / p.max) + '%' : '0';
    $('cRate').textContent = p && p.itPerSec ? (p.itPerSec >= 1 ? p.itPerSec.toFixed(2) + ' it/s' : (1 / p.itPerSec).toFixed(2) + ' s/it') + (p.remaining ? ' · ~' + p.remaining + ' left' : '') : '—';
    $('cTimeLabel').textContent = 'Elapsed';
    $('cTime').textContent = fmtDur(cur.elapsedMs);
    const sm = cur.summary;
    setSysLoad('cLoad', true);
    $('cFoot').textContent = [sm.width ? sm.width + '×' + sm.height + (sm.batch > 1 ? ' ×' + sm.batch : '') : null,
      sm.steps ? sm.steps + ' steps' : null, sm.sampler, sm.loras.length ? 'LoRA: ' + sm.loras.join(', ') : null].filter(Boolean).join(' · ') || ' ';
  } else {
    const a = d.average;
    $('cTitle').textContent = 'Idle — no workflow running' + (d.pending ? ' (' + d.pending + ' queued)' : '');
    $('cModel').textContent = a ? a.model : '—';
    show('cProgBox', false); show('cRateBox', false); show('cTimeBox', !!a);
    $('cTimeLabel').textContent = a ? 'Avg run time (last ' + a.runs + ' runs)' : 'Avg run time';
    $('cTime').textContent = a ? fmtDur(a.avgMs) : '—';
    $('cFoot').textContent = ' ';
    setSysLoad('cLoad', false);
  }

  $('cErr').hidden = d.runs.length > 0;
  $('cErr').style.color = 'var(--muted)';
  $('cErr').textContent = 'No runs recorded yet. Run a workflow in ComfyUI and it will appear here.';
  $('cRows').innerHTML = paginate('comfyui', d.runs.map(r => {
    const s = r.summary, isNew = !cFirst && !cSeen.has(r.id);
    cSeen.add(r.id);
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
  }), 'cPager').join('');
  cFirst = false;
}
pagerReload.comfyui = loadComfy;
loadComfy();
setInterval(loadComfy, 2000);

// ---- ComfyUI installed models ----
const CM_TYPES = { checkpoints:'Checkpoint', diffusion_models:'Diffusion model', loras:'LoRA', vae:'VAE', text_encoders:'Text encoder',
  clip_vision:'CLIP vision', controlnet:'ControlNet', upscale_models:'Upscaler', latent_upscale_models:'Latent upscaler', diffusers:'Diffusers',
  embeddings:'Embedding', ipadapter:'IP-Adapter', ip_adapter:'IP-Adapter', vae_approx:'VAE approx', style_models:'Style model' };
const cmType = f => CM_TYPES[f] || f.replace(/_/g, ' ');
let cmData = null, cmFilter = 'all';
function renderComfyModels() {
  const $ = id => document.getElementById(id);
  const d = cmData;
  if (!d) return;
  const all = d.models;
  // filter chips (redrawn only when they change, so clicks aren't lost)
  const counts = {}, order = [];
  all.forEach(m => { if (!counts[m.folder]) { counts[m.folder] = 0; order.push(m.folder); } counts[m.folder]++; });
  if (cmFilter !== 'all' && !counts[cmFilter]) cmFilter = 'all';
  const chipHtml = (all.length ? ['<button type="button" class="chip' + (cmFilter === 'all' ? ' on' : '') + '" data-cmfilter="all">All (' + all.length + ')</button>'] : [])
    .concat(order.map(f => '<button type="button" class="chip' + (cmFilter === f ? ' on' : '') + '" data-cmfilter="' + escH(f) + '">' + escH(cmType(f)) + ' (' + counts[f] + ')</button>')).join('');
  const chips = $('cmChips');
  if (chips._html !== chipHtml) { chips._html = chipHtml; chips.innerHTML = chipHtml; }

  const list = all.filter(m => cmFilter === 'all' || m.folder === cmFilter);
  const total = list.reduce((a, m) => a + (m.size || 0), 0);
  $('cmHint').textContent = all.length ? '— ' + list.length + ' files · ' + fmtBytes(total) + ' on disk' +
    (d.vramTotal ? ' · fit is file size vs ' + vramWord(d) + ' (ComfyUI can offload, so bigger models still run, slower)' : '') : '';
  $('cmEmpty').hidden = all.length > 0;
  $('cmEmpty').textContent = d.online ? 'Loading model list…' : 'ComfyUI is offline.';
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
  $('cmRows').innerHTML = paginate('comfyModels', rows, 'cmPager').join('');
}
async function loadComfyModels() {
  if (!isInstalled('comfyui')) return;
  try { cmData = await (await fetch('/api/comfy/models', { cache:'no-store' })).json(); } catch (e) { return; }
  renderComfyModels();
}
document.getElementById('cmChips').addEventListener('click', e => {
  const b = e.target.closest('[data-cmfilter]');
  if (!b) return;
  cmFilter = b.dataset.cmfilter;
  pages.comfyModels = 0;
  renderComfyModels();
});
pagerReload.comfyModels = renderComfyModels;
loadComfyModels();
setInterval(loadComfyModels, 5000);
