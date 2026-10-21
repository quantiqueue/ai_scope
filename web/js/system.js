// AI_SCOPE dashboard - SYSTEM tab: CPU/RAM/GPU/VRAM tiles, plus the "System load" row and "Peak load" cells
// that the other scopes use.

// ---------- System tab ----------
// One CPU and one RAM tile, then a GPU and a VRAM tile per graphics card (built once the card list is known).
let tileKey = null;
function tileHtml(t) {
  return `
  <div class="tile" id="t-${t.id}">
    <div class="k">${t.label}</div>
    <div class="v">—</div>
    <div class="sub">&nbsp;</div>
    <div class="meter"><div></div></div>
    <div class="spark"><svg viewBox="0 0 100 100" preserveAspectRatio="none">
      <path class="area"></path><path class="line"></path><line class="guide" y1="0" y2="100" style="display:none"></line></svg>
      <div class="tip" hidden></div></div>
    <div class="spark-axis"><span>5 min ago</span><span>now</span></div>
  </div>`;
}
function buildTiles(gpus) {
  const n = Math.max(1, gpus.length);
  const key = String(gpus.length) + '|' + gpus.map(g => g.id).join(',');
  if (key === tileKey) return;
  tileKey = key;
  const groups = [[{ id:'cpu', label:'CPU' }, { id:'ram', label:'RAM' }]];
  for (let i = 0; i < n; i++) {
    const num = gpus.length > 1 ? ' ' + (i + 1) : '';
    groups.push([{ id:'gpu' + i, label:'GPU' + num }, { id:'vram' + i, label:'VRAM' + num }]);
  }
  document.getElementById('tiles').innerHTML = groups.map(g => '<div class="tgroup">' + g.map(tileHtml).join('') + '</div>').join('');
}
buildTiles([]);

let sysHist = [];
function tileValues(s) {
  const pct = (u, t) => (u != null && t) ? 100 * u / t : null;
  const v = { cpu: s.cpu, ram: pct(s.ramUsed, s.ramTotal) };
  // Older samples (or no per-card data): fall back to the whole-PC numbers for the first card.
  const cards = s.gpus && s.gpus.length ? s.gpus : [{ util: s.gpu, vramUsed: s.vramUsed, vramTotal: s.vramTotal }];
  cards.forEach((g, i) => { v['gpu' + i] = g.util; v['vram' + i] = pct(g.vramUsed, g.vramTotal); });
  return v;
}
function setTile(id, value, big, sub, series) {
  const el = document.getElementById('t-' + id);
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

// GPU temperature badge on the GPU tile (top right). Amber from 80 °C, red from 90 °C. Hidden when unknown.
function setTemp(id, temp) {
  const el = document.getElementById('t-' + id);
  if (!el) return;
  let b = el.querySelector('.temp');
  if (temp == null) { if (b) b.hidden = true; return; }
  if (!b) { b = document.createElement('span'); b.className = 'temp'; b.title = 'GPU temperature'; el.querySelector('.k').appendChild(b); }
  b.hidden = false;
  b.textContent = Math.round(temp) + ' °C';
  b.className = 'temp' + (temp >= 90 ? ' hot' : temp >= 80 ? ' warm' : '');
}

async function loadSystem() {
  try {
    const data = await (await fetch('/api/system', { cache:'no-store' })).json();
    sysHist = data.history;
    const s = sysHist[sysHist.length - 1];
    const info = data.info;
    const gpus = info.gpus || [];
    buildTiles(gpus);
    document.getElementById('sysMeta').textContent = s ? 'updated ' + new Date(s.t).toLocaleTimeString() + ' · every 2 s' : 'warming up…';
    if (!s) return;
    const series = id => sysHist.map(h => tileValues(h)[id]);
    const v = tileValues(s);
    const na = '<span class="na">n/a</span>';
    setTile('cpu', v.cpu, v.cpu.toFixed(0) + '<small>%</small>', info.cpuModel + ' · ' + info.cores + ' threads', series('cpu'));
    setTile('ram', v.ram, GB(s.ramUsed) + '<small> / ' + GB(s.ramTotal) + ' GB</small>', v.ram.toFixed(0) + '% used', series('ram'));
    const n = Math.max(1, gpus.length);
    for (let i = 0; i < n; i++) {
      const g = (s.gpus && s.gpus[i]) || (i === 0 ? { util: s.gpu, vramUsed: s.vramUsed, vramTotal: s.vramTotal } : {});
      const name = gpus[i] ? gpus[i].name : (info.gpuSource === 'none' ? 'No GPU stats available' : 'detecting…');
      const util = v['gpu' + i], vram = v['vram' + i];
      // Sub line: card name, then power draw / limit when the card reports it (NVIDIA). Temperature is the badge.
      const extra = [g.power != null ? Math.round(g.power) + (g.powerLimit ? ' / ' + Math.round(g.powerLimit) : '') + ' W' : null].filter(Boolean);
      setTile('gpu' + i, util, util != null ? util.toFixed(0) + '<small>%</small>' : na, [name].concat(extra).join(' · '), series('gpu' + i));
      setTemp('gpu' + i, g.temp);
      let vramBig = na, vramSub = name;
      if (g.vramUsed != null) {
        vramBig = GB(g.vramUsed) + (g.vramTotal ? '<small> / ' + GB(g.vramTotal) + ' GB</small>' : '<small> GB</small>');
        vramSub = (vram != null ? vram.toFixed(0) + '% used' : 'total unknown') + (gpus.length > 1 ? ' · ' + name : '');
      }
      setTile('vram' + i, vram, vramBig, vramSub, series('vram' + i));
    }
  } catch (e) {
    document.getElementById('sysMeta').textContent = 'Could not reach server: ' + e.message;
  }
}

// ---- "System load" row on the Current request / Current job cards ----
// Whole-computer totals from the latest SYSTEM sample (all apps together, not this request alone).
// Shown only while something is running.
function setSysLoad(id, on) {
  const el = document.getElementById(id);
  if (!el) return;
  const s = on ? sysHist[sysHist.length - 1] : null;
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

// Hover on a sparkline: show the value at that point in time.
document.getElementById('tiles').addEventListener('mousemove', e => {
  const spark = e.target.closest('.spark'); if (!spark || !sysHist.length) return;
  const id = spark.closest('.tile').id.slice(2);
  const r = spark.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  const i = Math.round(f * (sysHist.length - 1));
  const h = sysHist[i], v = tileValues(h)[id];
  const tip = spark.querySelector('.tip'), guide = spark.querySelector('.guide');
  const x = sysHist.length < 2 ? 100 : 100 * i / (sysHist.length - 1);
  guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.style.display = '';
  tip.hidden = false; tip.style.left = x + '%';
  tip.textContent = (v == null ? 'n/a' : v.toFixed(0) + '%') + ' · ' + new Date(h.t).toLocaleTimeString();
});
document.getElementById('tiles').addEventListener('mouseleave', () => {
  document.querySelectorAll('.spark .tip').forEach(t => t.hidden = true);
  document.querySelectorAll('.spark .guide').forEach(g => g.style.display = 'none');
}, true);
document.getElementById('tiles').addEventListener('mouseout', e => {
  const spark = e.target.closest('.spark');
  if (spark && !spark.contains(e.relatedTarget)) { spark.querySelector('.tip').hidden = true; spark.querySelector('.guide').style.display = 'none'; }
});
loadSystem();
setInterval(loadSystem, 2000);
