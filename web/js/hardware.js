// AI_SCOPE dashboard - Hardware scope: CPU, RAM and per-card GPU/VRAM tiles (as lenses), plus the "System load" row
// and "Peak load" cells that the other scopes use.

// ---------- Tiles ----------
// A tile: header tab (label; GPU temperature on the right), big value, sub line, meter and a 5-minute sparkline.
// data-tile = its key in tileValues().
function tileHtml(t) {
  return `
  <div class="tilebox" data-tile="${t.id}">` + lensHeadMarkup(t.label, '<span class="temp" title="GPU temperature" hidden></span>') + `
  <div class="tile">
    <div class="v">—</div>
    <div class="sub">&nbsp;</div>
    <div class="meter"><div></div></div>
    <div class="spark"><svg viewBox="0 0 100 100" preserveAspectRatio="none">
      <path class="area"></path><path class="line"></path><line class="guide" y1="0" y2="100" style="display:none"></line></svg>
      <div class="tip" hidden></div></div>
    <div class="spark-axis"><span>5 min ago</span><span>now</span></div>
  </div></div>`;
}

let hwHist = [];   // latest 5 minutes of samples; also used by the "System load" row of the other scopes
function tileValues(s) {
  const pct = (u, t) => (u != null && t) ? 100 * u / t : null;
  const v = { cpu: s.cpu, ram: pct(s.ramUsed, s.ramTotal) };
  // Older samples (or no per-card data): fall back to the whole-PC numbers for the first card.
  const cards = s.gpus && s.gpus.length ? s.gpus : [{ util: s.gpu, vramUsed: s.vramUsed, vramTotal: s.vramTotal }];
  cards.forEach((g, i) => { v['gpu' + i] = g.util; v['vram' + i] = pct(g.vramUsed, g.vramTotal); });
  return v;
}
function setTile(el, value, big, sub, series) {
  if (!el) return;
  el.querySelector('.v').innerHTML = big;
  el.querySelector('.sub').textContent = sub;
  el.querySelector('.sub').title = sub;
  el.querySelector('.meter > div').style.width = (value == null ? 0 : Math.max(0, Math.min(100, value))) + '%';
  const pts = series.map((v, i) => v == null ? null : [series.length < 2 ? 100 : 100 * i / (series.length - 1), 100 - Math.max(0, Math.min(100, v))]);
  const valid = pts.filter(Boolean);
  const d = valid.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' ');
  el.querySelector('.line').setAttribute('d', d);
  el.querySelector('.area').setAttribute('d', valid.length ? d + ` L${valid[valid.length-1][0]} 100 L${valid[0][0]} 100 Z` : '');
}

// GPU temperature on the GPU tile's header (right). Amber from 80 °C, red from 90 °C. Hidden when unknown.
function setTemp(el, temp) {
  if (!el) return;
  const b = el.querySelector('.temp');
  if (!b) return;
  if (temp == null) { b.hidden = true; return; }
  b.hidden = false;
  b.textContent = Math.round(temp) + ' °C';
  b.className = 'temp' + (temp >= 90 ? ' hot' : temp >= 80 ? ' warm' : '');
}

// ---------- Source + lenses ----------
// /api/hardware: { info: { cpuModel, cores, gpus[], gpuSource }, history: [samples, oldest first] }.
defineSource('hardware', '/api/hardware');
subscribeSource('hardware', d => { if (d) hwHist = d.history; });   // always on: other scopes' "System load" rows need it
const hwLatest = d => d.history[d.history.length - 1];
const hwSeries = (d, id) => d.history.map(h => tileValues(h)[id]);
const NA_HTML = '<span class="na">n/a</span>';

defineLens({
  id: 'hardware.cpu', scope: 'hardware', size: 'tile',
  name: 'CPU', description: 'CPU usage with a 5-minute history.',
  markup: tileHtml({ id:'cpu', label:'CPU' }),
  render(L, d) {
    const s = hwLatest(d); if (!s) return;
    const v = tileValues(s), info = d.info;
    setTile(L.el.querySelector('.tile'), v.cpu, v.cpu.toFixed(0) + '<small>%</small>', info.cpuModel + ' · ' + info.cores + ' threads', hwSeries(d, 'cpu'));
  },
});
defineLens({
  id: 'hardware.ram', scope: 'hardware', size: 'tile',
  name: 'RAM', description: 'Memory in use with a 5-minute history.',
  markup: tileHtml({ id:'ram', label:'RAM' }),
  render(L, d) {
    const s = hwLatest(d); if (!s) return;
    const v = tileValues(s);
    setTile(L.el.querySelector('.tile'), v.ram, GB(s.ramUsed) + '<small> / ' + GB(s.ramTotal) + ' GB</small>', v.ram.toFixed(0) + '% used', hwSeries(d, 'ram'));
  },
});
// One graphics card: GPU usage (with temperature and power), VRAM, or both side by side.
// Settings: card (0-based index into info.gpus), show ('both' | 'gpu' | 'vram').
defineLens({
  id: 'hardware.gpu', scope: 'hardware',
  size: st => st.show === 'both' ? 'wide' : 'tile',
  name: 'GPU', description: 'One graphics card: usage, temperature and power, and/or VRAM, with a 5-minute history.',
  settings: [
    { id:'card', label:'Graphics card', type:'gpu', default:0 },
    { id:'show', label:'Show', type:'choice', default:'both', options:[['both', 'GPU usage and VRAM'], ['gpu', 'GPU usage'], ['vram', 'VRAM']] },
  ],
  markup: st => {
    const i = st.card, num = i ? ' ' + (i + 1) : '';   // fixed up on render: "GPU 1" once there are several cards
    const tiles = (st.show !== 'vram' ? tileHtml({ id:'gpu' + i, label:'GPU' + num }) : '') + (st.show !== 'gpu' ? tileHtml({ id:'vram' + i, label:'VRAM' + num }) : '');
    return st.show === 'both' ? '<div class="tgroup">' + tiles + '</div>' : tiles;
  },
  render(L, d) {
    const info = d.info, gpus = info.gpus || [], i = L.settings.card;
    const num = gpus.length > 1 ? ' ' + (i + 1) : '';
    const gEl = L.el.querySelector('[data-tile="gpu' + i + '"]'), vEl = L.el.querySelector('[data-tile="vram' + i + '"]');
    // labels: "GPU 2" with several cards, plain "GPU" with one (keep the temperature badge)
    if (gEl && gEl.querySelector('.ltitle').textContent !== 'GPU' + num) gEl.querySelector('.ltitle').textContent = 'GPU' + num;
    if (vEl && vEl.querySelector('.ltitle').textContent !== 'VRAM' + num) vEl.querySelector('.ltitle').textContent = 'VRAM' + num;
    const s = hwLatest(d); if (!s) return;
    const v = tileValues(s);
    const g = (s.gpus && s.gpus[i]) || (i === 0 ? { util: s.gpu, vramUsed: s.vramUsed, vramTotal: s.vramTotal } : {});
    const name = gpus[i] ? gpus[i].name : (info.gpuSource === 'none' ? 'No GPU stats available' : gpus.length ? 'GPU ' + (i + 1) + ' not found' : 'detecting…');
    const util = v['gpu' + i], vram = v['vram' + i];
    // Sub line: card name, then power draw / limit when the card reports it (NVIDIA). Temperature is the badge.
    const extra = [g.power != null ? Math.round(g.power) + (g.powerLimit ? ' / ' + Math.round(g.powerLimit) : '') + ' W' : null].filter(Boolean);
    if (gEl) {
      setTile(gEl, util, util != null ? util.toFixed(0) + '<small>%</small>' : NA_HTML, [name].concat(extra).join(' · '), hwSeries(d, 'gpu' + i));
      setTemp(gEl, g.temp);
    }
    if (vEl) {
      let vramBig = NA_HTML, vramSub = name;
      if (g.vramUsed != null) {
        vramBig = GB(g.vramUsed) + (g.vramTotal ? '<small> / ' + GB(g.vramTotal) + ' GB</small>' : '<small> GB</small>');
        vramSub = (vram != null ? vram.toFixed(0) + '% used' : 'total unknown') + (gpus.length > 1 ? ' · ' + name : '');
      }
      setTile(vEl, vram, vramBig, vramSub, hwSeries(d, 'vram' + i));
    }
  },
});

// ---- "System load" row on the Current request / Current job cards ----
// Whole-computer totals from the latest Hardware sample (all apps together, not this request alone).
// Shown only while something is running.
function setSysLoad(id, on) {   // id or element (lenses pass their own)
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if (!el) return;
  const s = on ? hwHist[hwHist.length - 1] : null;
  el.hidden = !s;
  if (!s) return;
  const pct = (u, t) => (u != null && t) ? 100 * u / t : null;
  const item = (k, p, txt) => '<span class="sl-item"><span class="sl-k">' + k + '</span><span class="sl-meter"><div style="width:' +
    (p == null ? 0 : Math.max(0, Math.min(100, p))) + '%"></div></span><span class="sl-v">' + txt + '</span></span>';
  // Two rows, one column per card (+ one for the CPU): usage % on top, memory below.
  const top = [], mem = [];
  const blank = '<span></span>';
  const cards = s.gpus && s.gpus.length ? s.gpus : (s.gpu != null ? [{ util: s.gpu, vramUsed: s.vramUsed, vramTotal: s.vramTotal }] : []);
  cards.forEach((g, i) => {
    const n = cards.length > 1 ? ' ' + (i + 1) : '';
    top.push(g.util != null ? item('GPU' + n, g.util, g.util.toFixed(0) + '%') : blank);
    mem.push(g.vramUsed != null ? item('VRAM' + n, pct(g.vramUsed, g.vramTotal), GB(g.vramUsed) + (g.vramTotal ? ' / ' + GB(g.vramTotal) : '') + ' GB') : blank);
  });
  top.push(s.cpu != null ? item('CPU', s.cpu, s.cpu.toFixed(0) + '%') : blank);
  mem.push(item('MEM', pct(s.ramUsed, s.ramTotal), GB(s.ramUsed) + ' / ' + GB(s.ramTotal) + ' GB'));
  const html = top.concat(mem).join('');
  const box = el.querySelector('.sl-items');
  if (box._html !== html) { box._html = html; box.innerHTML = html; box.style.gridTemplateColumns = 'repeat(' + top.length + ', max-content)'; }
}
// "Peak load" cell in the history tables: highest whole-PC GPU % and VRAM while it ran; details on hover.
function peakCell(p) {
  if (!p) return '<td class="na" title="No peak recorded (AI_SCOPE was not sampling while this ran, or it ran before v0.2)">—</td>';
  const parts = [];
  if (p.gpu != null) parts.push('GPU ' + p.gpu + '%');
  if (p.vramUsed != null) parts.push('VRAM ' + GB(p.vramUsed) + (p.vramTotal ? ' / ' + GB(p.vramTotal) : '') + ' GB');
  if (p.cpu != null) parts.push('CPU ' + p.cpu + '%');
  if (p.ramUsed != null) parts.push('RAM ' + GB(p.ramUsed) + (p.ramTotal ? ' / ' + GB(p.ramTotal) : '') + ' GB');
  const tip = 'Peak system load while this ran (whole computer, all apps): ' + parts.join(' · ') + (p.partial ? ' (last 5 minutes only)' : '');
  const short = [p.gpu != null ? p.gpu + '%' : null, p.vramUsed != null ? GB(p.vramUsed) + ' GB' : null].filter(Boolean).join(' · ') || '—';
  return '<td class="peak" title="' + tip + '">' + short + '</td>';
}

// Hover on a sparkline (any tile, on any page): show the value at that point in time.
document.addEventListener('mousemove', e => {
  const spark = e.target.closest && e.target.closest('[data-tile] .spark'); if (!spark || !hwHist.length) return;
  const id = spark.closest('[data-tile]').dataset.tile;
  const r = spark.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  const i = Math.round(f * (hwHist.length - 1));
  const h = hwHist[i], v = tileValues(h)[id];
  const tip = spark.querySelector('.tip'), guide = spark.querySelector('.guide');
  const x = hwHist.length < 2 ? 100 : 100 * i / (hwHist.length - 1);
  guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.style.display = '';
  tip.hidden = false; tip.style.left = x + '%';
  tip.textContent = (v == null ? 'n/a' : v.toFixed(0) + '%') + ' · ' + new Date(h.t).toLocaleTimeString();
});
document.addEventListener('mouseout', e => {
  const spark = e.target.closest && e.target.closest('.spark');
  if (spark && !spark.contains(e.relatedTarget)) { spark.querySelector('.tip').hidden = true; spark.querySelector('.guide').style.display = 'none'; }
});

// ---------- The Hardware scope page: CPU + RAM side by side, then one GPU lens (GPU + VRAM) per card ----------
const hwBox = document.querySelector('[data-panel="hardware"] [data-lenses]');
const hwPair = document.createElement('div');
hwPair.className = 'tgroup';
hwBox.appendChild(hwPair);
let hwGpuKey = null, hwGpuLenses = [];
function buildHardwarePage(gpus) {   // (re)built once the card list is known or when it changes
  const key = String(gpus.length) + '|' + gpus.map(g => g.id).join(',');
  if (key === hwGpuKey) return;
  hwGpuKey = key;
  hwGpuLenses.forEach(unmountLens);
  hwGpuLenses = [];
  for (let i = 0; i < Math.max(1, gpus.length); i++) hwGpuLenses.push(mountLens('hardware.gpu', hwBox, { card: i, show: 'both' }));
}
subscribeSource('hardware', (d, err) => {
  const meta = document.getElementById('hwMeta');
  if (err) { meta.textContent = 'Could not reach server: ' + err.message; return; }
  buildHardwarePage(d.info.gpus || []);
  const s = hwLatest(d);
  meta.textContent = s ? 'updated ' + new Date(s.t).toLocaleTimeString() + ' · every 2 s' : 'warming up…';
});
mountLens('hardware.cpu', hwPair);
mountLens('hardware.ram', hwPair);
buildHardwarePage([]);
