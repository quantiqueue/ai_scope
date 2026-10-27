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
  cards.forEach((g, i) => { v['gpu' + i] = g.util; v['vram' + i] = pct(g.vramUsed, g.vramTotal); v['pow' + i] = pct(g.power, g.powerLimit); });
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

// ---------- Power (AI_SCOPE-027): one card's power draw vs its power limit, own quarter-size tile ----------
// NVIDIA only (Windows' GPU counters report no power for AMD / Intel cards) - those cards show "not available".
// The chart and meter are % of the card's power limit, so cards compare fairly; hover gives the watts.
defineLens({
  id: 'hardware.power', scope: 'hardware', size: 'tile',
  name: 'Power', description: "One graphics card's power draw vs its power limit, with a 5-minute history (NVIDIA cards report it; others don't).",
  settings: [
    { id:'card', label:'Graphics card', type:'gpu', default:0 },
  ],
  markup: st => tileHtml({ id:'pow' + st.card, label:'Power' + (st.card ? ' ' + (st.card + 1) : '') }),
  render(L, d) {
    const box = L.el.querySelector('[data-tile="pow' + L.settings.card + '"]'); if (!box) return;
    const info = d.info, gpus = info.gpus || [], i = L.settings.card;
    const num = gpus.length > 1 ? ' ' + (i + 1) : '';   // "Power 2" with several cards, plain "Power" with one
    if (box.querySelector('.ltitle').textContent !== 'Power' + num) box.querySelector('.ltitle').textContent = 'Power' + num;
    const s = hwLatest(d); if (!s) return;
    const g = (s.gpus && s.gpus[i]) || {};
    const name = gpus[i] ? gpus[i].name : (info.gpuSource === 'none' ? 'No GPU stats available' : gpus.length ? 'GPU ' + (i + 1) + ' not found' : 'detecting…');
    const big = g.power != null
      ? Math.round(g.power) + (g.powerLimit != null ? '<small> / ' + Math.round(g.powerLimit) + ' W</small>' : '<small> W</small>')
      : NA_HTML;
    const sub = g.power != null ? name : name + ' · power not available for this card';
    setTile(box, tileValues(s)['pow' + i], big, sub, hwSeries(d, 'pow' + i));
    box.querySelector('.spark').title = g.powerLimit != null ? 'Top of the chart = ' + Math.round(g.powerLimit) + ' W (the card\'s power limit)' : '';
  },
});

// ---------- Disk (AI_SCOPE-030): one physical disk - active time %, read and write lines ----------
// bytes/s -> "12.3 MB/s" ("850 KB/s" below 1 MB/s)
const fmtRate = b => b == null ? '—' : b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB/s' : b >= 1e6 ? (b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + ' MB/s' : Math.round(b / 1e3) + ' KB/s';
const diskOf = (s, id) => s && s.disks ? (id ? s.disks.find(x => x.id === id) : s.disks[0]) || null : null;
// The lines are scaled to the busiest moment of the last 5 minutes (+25 %), at least 1 MB/s.
const diskScale = (hist, id) => Math.max(1e6, 1.25 * hist.reduce((a, s) => { const x = diskOf(s, id); return x ? Math.max(a, x.read || 0, x.write || 0) : a; }, 0));
function diskPath(hist, id, key, max) {
  const n = hist.length;
  return hist.map((s, i) => { const x = diskOf(s, id); return x ? [n < 2 ? 100 : 100 * i / (n - 1), 100 - Math.min(100, 100 * (x[key] || 0) / max)] : null; })
    .filter(Boolean).map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' ');
}
defineLens({
  id: 'hardware.disk', scope: 'hardware', size: 'tile',
  name: 'Disk', description: 'One physical disk: active time, and read / write speed with a 5-minute history (e.g. while a model loads).',
  settings: [{ id:'disk', label:'Disk', type:'disk', default:'' }],
  markup: st => `
  <div class="tilebox" data-tile="disk:${escH(st.disk || '')}">` + lensHeadMarkup('Disk') + `
  <div class="tile disk">
    <div class="v">—</div>
    <div class="sub">&nbsp;</div>
    <div class="meter"><div></div></div>
    <div class="spark"><svg viewBox="0 0 100 100" preserveAspectRatio="none">
      <path class="line"></path><path class="line wline"></path><line class="guide" y1="0" y2="100" style="display:none"></line></svg>
      <div class="tip" hidden></div></div>
    <div class="spark-axis"><span>5 min ago</span><span class="dlegend"><i class="rd"></i>read <i class="wr"></i>write</span><span>now</span></div>
  </div></div>`,
  render(L, d) {
    const info = d.info, disks = info.disks || [], want = L.settings.disk || '';
    const meta = want ? disks.find(x => x.id === want) : disks[0];
    const id = meta ? meta.id : want;
    const box = L.el.querySelector('.tilebox'), el = L.el.querySelector('.tile');
    if (box.dataset.tile !== 'disk:' + id) box.dataset.tile = 'disk:' + id;   // the hover finds the disk by this
    const title = meta ? meta.name : want ? 'Disk ' + want : 'Disk';
    if (box.querySelector('.ltitle').textContent !== title) box.querySelector('.ltitle').textContent = title;
    const x = diskOf(hwLatest(d), id);
    if (!x) {
      el.querySelector('.v').innerHTML = NA_HTML;
      el.querySelector('.sub').textContent = !info.disksSupported ? 'Disk stats: Windows and Linux only for now' : want && disks.length ? 'Disk ' + want + ' not found' : 'detecting…';
      return;
    }
    el.querySelector('.v').innerHTML = (x.active != null ? x.active.toFixed(0) : '—') + '<small>% active</small>';
    const sub = 'Read ' + fmtRate(x.read) + ' · Write ' + fmtRate(x.write);
    el.querySelector('.sub').textContent = sub; el.querySelector('.sub').title = 'Active time = how busy the disk was (like Task Manager)';
    el.querySelector('.meter > div').style.width = Math.max(0, Math.min(100, x.active || 0)) + '%';
    const max = diskScale(d.history, id);
    el.querySelector('.line:not(.wline)').setAttribute('d', diskPath(d.history, id, 'read', max));
    el.querySelector('.wline').setAttribute('d', diskPath(d.history, id, 'write', max));
    el.querySelector('.spark').title = 'Top of the chart = ' + fmtRate(max);
  },
});

// Setting of the Current request / Current job lenses (AI_SCOPE-020): show the process stats row (below) or not.
const PROC_STATS_FIELD = { id: 'procStats', label: 'Show process stats', type: 'toggle', default: true,
  tip: 'While a request or job runs: the row with GPU, VRAM, CPU and RAM use — of the app\'s own process where known, otherwise of the whole computer.' };

// ---- "System load" row on the Current request / Current job cards ----
// Whole-computer totals from the latest Hardware sample (all apps together, not this request alone).
// Shown only while something is running.
// The "System load" row on the running-request cards: whole-computer GPU / VRAM / CPU / RAM.
// With proc (an app's own processes, from procstats.js on Windows; AI_SCOPE-038) and app (its name), the row shows
// that app's own use instead and is labelled "<app> process"; without proc it falls back to whole-computer load.
const SYSLOAD_TIP = 'Whole-computer totals (all apps together), not only this request';
function setSysLoad(id, on, proc, app) {   // id or element (lenses pass their own)
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if (!el) return;
  const s = on ? hwHist[hwHist.length - 1] : null;
  el.hidden = !s;
  if (!s) return;
  const pct = (u, t) => (u != null && t) ? 100 * u / t : null;
  const item = (k, p, txt, tip) => '<span class="sl-item"' + (tip ? ' title="' + esc(tip) + '"' : '') + '><span class="sl-k">' + k + '</span><span class="sl-meter"><div style="width:' +
    (p == null ? 0 : Math.max(0, Math.min(100, p))) + '%"></div></span><span class="sl-v">' + txt + '</span></span>';
  // Two rows, one column per card (+ one for the CPU): usage % on top, memory below.
  const top = [], mem = [];
  const blank = '<span></span>';
  const cards = s.gpus && s.gpus.length ? s.gpus : (s.gpu != null ? [{ util: s.gpu, vramUsed: s.vramUsed, vramTotal: s.vramTotal }] : []);
  const mine = proc && proc.gpus && proc.gpus.length === cards.length ? proc : null;
  cards.forEach((g, i) => {
    const n = cards.length > 1 ? ' ' + (i + 1) : '';
    if (mine) {
      const p = mine.gpus[i];
      top.push(item('GPU' + n, p.util, p.util != null ? p.util.toFixed(0) + '%' : '—', p.util != null ? null : 'GPU % not available for this card'));
      mem.push(item('VRAM' + n, pct(p.vram, g.vramTotal), GB(p.vram) + (g.vramTotal ? ' / ' + GB(g.vramTotal) : '') + ' GB',
        p.shared > 0 ? '+ ' + GB(p.shared) + ' GB in shared (system) memory' : null));
      return;
    }
    top.push(g.util != null ? item('GPU' + n, g.util, g.util.toFixed(0) + '%') : blank);
    mem.push(g.vramUsed != null ? item('VRAM' + n, pct(g.vramUsed, g.vramTotal), GB(g.vramUsed) + (g.vramTotal ? ' / ' + GB(g.vramTotal) : '') + ' GB') : blank);
  });
  if (mine) {
    const noAccess = 'The system did not allow reading this process\'s CPU and RAM';
    top.push(mine.cpu != null ? item('CPU', mine.cpu, mine.cpu.toFixed(0) + '%', 'Share of the whole CPU (all cores)') : mine.ram == null ? item('CPU', null, '—', noAccess) : blank);
    mem.push(mine.ram != null ? item('MEM', pct(mine.ram, s.ramTotal), GB(mine.ram) + ' / ' + GB(s.ramTotal) + ' GB', (SERVER_OS === 'win32' ? 'RAM in use (working set); committed: ' : SERVER_OS === 'linux' ? 'RAM in use (resident); private: ' : 'RAM in use (resident): ') + GB(mine.ramPrivate) + ' GB')
      : item('MEM', null, '—', noAccess));
  } else {
    top.push(s.cpu != null ? item('CPU', s.cpu, s.cpu.toFixed(0) + '%') : blank);
    mem.push(item('MEM', pct(s.ramUsed, s.ramTotal), GB(s.ramUsed) + ' / ' + GB(s.ramTotal) + ' GB'));
  }
  const label = el.querySelector('.sl-label');
  const ltext = mine ? app + ' process' : 'System load';
  const ltip = mine ? 'Used by ' + app + '\'s own process' + (mine.pids.length > 1 ? 'es' : '') + ' (' +
    mine.pids.map(p => p.name + ' ' + p.pid).join(', ') + ')' : SYSLOAD_TIP;
  if (label.textContent !== ltext) label.textContent = ltext;
  if (label.title !== ltip) label.title = ltip;
  const html = top.concat(mem).join('');
  const box = el.querySelector('.sl-items');
  if (box._html !== html) { box._html = html; box.innerHTML = html; box.style.gridTemplateColumns = 'repeat(' + top.length + ', max-content)'; }
}
// "in VRAM: GPU 1 4.0 GB · GPU 2 2.3 GB" for an app's model process(es) (procstats, Windows) - where a model actually sits
// on the cards, for the Loaded in memory lenses (AI_SCOPE-049 / 050). '' when there's nothing on a card.
function procVramText(pr) {
  const cards = pr && pr.gpus ? pr.gpus.map((g, i) => ({ n: i + 1, g })).filter(x => x.g.vram >= 64 * 1048576) : [];
  if (!cards.length) return '';
  // Shared (system) memory: Windows can report the same shared allocation on every card (seen with Strata), so take the
  // largest rather than adding them up.
  const shared = pr.gpus.reduce((a, g) => Math.max(a, g.shared || 0), 0);
  return 'in VRAM: ' + cards.map(x => (pr.gpus.length > 1 ? 'GPU ' + x.n : 'GPU') + ' ' + fmtBytes(x.g.vram)).join(' · ') +
    (shared >= 64 * 1048576 ? ' · ' + fmtBytes(shared) + ' in shared (system) memory' : '') +
    (pr.pids.length > 1 ? ' (' + pr.pids.length + ' model processes together)' : '');
}
// "Peak load" cell in the history tables: highest whole-PC GPU % and VRAM while it ran; details on hover.
function peakCell(p) {
  if (!p) return '<td class="na" title="No peak recorded (AI_SCOPE was not sampling while this ran, or it ran before v0.2)">—</td>';
  const parts = [];
  if (p.gpu != null) parts.push('GPU ' + p.gpu + '%');
  if (p.vramUsed != null) parts.push('VRAM ' + GB(p.vramUsed) + (p.vramTotal ? ' / ' + GB(p.vramTotal) : '') + ' GB');
  if (p.cpu != null) parts.push('CPU ' + p.cpu + '%');
  if (p.ramUsed != null) parts.push('RAM ' + GB(p.ramUsed) + (p.ramTotal ? ' / ' + GB(p.ramTotal) : '') + ' GB');
  if (p.diskRead != null) parts.push('disk read ' + fmtRate(p.diskRead));   // AI_SCOPE-030: all disks together
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
  const h = hwHist[i], v = id.indexOf('disk:') === 0 ? null : tileValues(h)[id];
  const tip = spark.querySelector('.tip'), guide = spark.querySelector('.guide');
  const x = hwHist.length < 2 ? 100 : 100 * i / (hwHist.length - 1);
  guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.style.display = '';
  tip.hidden = false; tip.style.left = x + '%';
  if (id.indexOf('disk:') === 0) {   // disk tile: read / write / active at that time
    const x = diskOf(h, id.slice(5));
    tip.textContent = (x ? 'R ' + fmtRate(x.read) + ' · W ' + fmtRate(x.write) + ' · ' + (x.active != null ? x.active.toFixed(0) : '—') + '%' : 'n/a') + ' · ' + new Date(h.t).toLocaleTimeString();
    return;
  }
  if (id.indexOf('pow') === 0) {   // power tile (AI_SCOPE-027): watts at that time
    const g = h.gpus && h.gpus[+id.slice(3)];
    tip.textContent = (g && g.power != null ? Math.round(g.power) + ' W' + (g.powerLimit ? ' of ' + Math.round(g.powerLimit) + ' W limit' : '') : 'n/a') + ' · ' + new Date(h.t).toLocaleTimeString();
    return;
  }
  tip.textContent = (v == null ? 'n/a' : v.toFixed(0) + '%') + ' · ' + new Date(h.t).toLocaleTimeString();
});
document.addEventListener('mouseout', e => {
  const spark = e.target.closest && e.target.closest('.spark');
  if (spark && !spark.contains(e.relatedTarget)) { spark.querySelector('.tip').hidden = true; spark.querySelector('.guide').style.display = 'none'; }
});

// ---------- The Hardware scope page: CPU + RAM, then one GPU lens (GPU + VRAM) per card (default layout; editable, AI_SCOPE-020) ----------
defineScopeLayout('hardware', () => {
  const gpus = (SOURCES.hardware.data && SOURCES.hardware.data.info.gpus) || [];
  const items = layoutOf(['hardware.cpu', 'hardware.ram']);
  for (let i = 0; i < Math.max(1, gpus.length); i++) {   // power tile per card (AI_SCOPE-027)
    items.push({ lens: 'hardware.gpu', settings: { card: i, show: 'both' } });
    items.push({ lens: 'hardware.power', settings: { card: i } });
  }
  const disks = (SOURCES.hardware.data && SOURCES.hardware.data.info.disks) || [];
  disks.forEach(x => items.push({ lens: 'hardware.disk', settings: { disk: x.id } }));   // AI_SCOPE-030
  return items;
});
subscribeSource('hardware', (d, err) => {
  const meta = document.getElementById('hwMeta');
  if (err) { meta.textContent = 'Could not reach server: ' + err.message; return; }
  const s = hwLatest(d);
  meta.textContent = s ? 'updated ' + new Date(s.t).toLocaleTimeString() + ' · every 2 s' : 'warming up…';
});
