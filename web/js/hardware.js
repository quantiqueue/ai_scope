// AI_SCOPE dashboard - Hardware scope: CPU, RAM and per-card GPU/VRAM tiles (as lenses), plus the "System load" row
// and "Peak load" cells that the other scopes use.

// ---------- Tiles ----------
// A tile: header tab (label; GPU temperature on the right), big value, sub line, meter and a 5-minute sparkline.
// data-tile = its key in tileValues(). AI_SCOPE-092: the axis prints only "now" — the line spans the samples actually
// held (up to five minutes of them) with the newest at the right edge, so a left-hand "5 min ago" would be a claim
// the ring does not always honour.
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
    <div class="spark-axis"><span></span><span>now</span></div>
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
const hwWin = d => sparkWindow((d && d.history) || []);   // 092: the ring windowed by TIME (5 min), keeping one sample older so the line enters from the edge
const hwSeries = (d, id) => sparkSegs(hwWin(d), h => tileValues(h)[id]);
const hwScaleHist = d => hwWin(d);   // the same slice the y-scales are computed over, so "top of the chart" is what you see
// The Hardware sample nearest a given time (092): anything that needs the system ceilings (a mirror tile's RAM
// ceiling, the System load row) must read them from the sample it is quoting, not from an index on a different axis.
function hwSampleAt(t) {
  if (!hwHist.length) return {};
  let best = hwHist[0];
  for (let i = 1; i < hwHist.length; i++) if (Math.abs(hwHist[i].t - t) < Math.abs(best.t - t)) best = hwHist[i];
  return best;
}
const NA_HTML = '<span class="na">n/a</span>';

// AI_SCOPE-077: hover registry for the Hardware Mirror Lens family (web/js/mirror.js). mirror.js pushes one
// entry per tile-id prefix ({ prefix, fn(spark, f, guide, tip) }) and the sparkline hover below dispatches to
// them, so each app scope's tiles read their own process history. Declared here (classic scripts share one
// global lexical scope) because mirror.js loads after this file and the hover handler reads it.
const MIRROR_HOVER = [];

defineLens({
  id: 'hardware.cpu', scope: 'hardware', size: 'tile',
  name: 'CPU', description: 'CPU usage with a 5-minute history.',
  markup: tileHtml({ id:'cpu', label:'CPU' }),
  render(L, d) {
    const s = hwLatest(d); if (!s) return;
    const v = tileValues(s), info = d.info;
    sparkTile(L.el.querySelector('.tile'), v.cpu, v.cpu.toFixed(0) + '<small>%</small>', info.cpuModel + ' · ' + info.cores + ' threads', hwSeries(d, 'cpu'));
  },
});
defineLens({
  id: 'hardware.ram', scope: 'hardware', size: 'tile',
  name: 'RAM', description: 'Memory in use with a 5-minute history; Show can switch it to committed memory over the commit limit.',
  settings: [
    { id:'show', label:'Show', type:'choice', default:'usage', options:[['usage', 'Usage'], ['committed', 'Committed']] },
  ],
  markup: st => tileHtml({ id:'ram' + (st.show === 'committed' ? 'C' : ''),
    label:'RAM' + (st.show === 'committed' ? ' (Committed)' : '') }),
  render(L, d) {
    const s = hwLatest(d); if (!s) return;
    const box = L.el.querySelector('[data-tile="ram' + (L.settings.show === 'committed' ? 'C' : '') + '"]'); if (!box) return;
    if (L.settings.show === 'committed') {
      // Committed (reserved against RAM + pagefile) - the numbers 073 / 074 read in one CIM / meminfo call.
      const lim = s.commitLimit;
      if (lim == null) { sparkTile(box, null, NA_HTML, 'Committed memory: not available on this system', []); return; }
      const pctC = b => (b != null && lim) ? Math.min(100, 100 * b / lim) : null;
      const val = pctC(s.commitUsed);
      sparkTile(box, val, (s.commitUsed != null ? GB(s.commitUsed) + '<small> / ' + GB(lim) + ' GB</small>' : NA_HTML),
        (val == null ? 'detecting…' : val.toFixed(0) + '% of commit limit'),
        sparkSegs(hwWin(d), h => h.commitLimit ? pctC(h.commitUsed) : null));   // samples before the field landed stay gaps
      return;
    }
    const v = tileValues(s);
    sparkTile(box, v.ram, GB(s.ramUsed) + '<small> / ' + GB(s.ramTotal) + ' GB</small>', v.ram.toFixed(0) + '% used', hwSeries(d, 'ram'));
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
      sparkTile(gEl, util, util != null ? util.toFixed(0) + '<small>%</small>' : NA_HTML, [name].concat(extra).join(' · '), hwSeries(d, 'gpu' + i));
      setTemp(gEl, g.temp);
    }
    if (vEl) {
      let vramBig = NA_HTML, vramSub = name;
      if (g.vramUsed != null) {
        vramBig = GB(g.vramUsed) + (g.vramTotal ? '<small> / ' + GB(g.vramTotal) + ' GB</small>' : '<small> GB</small>');
        vramSub = (vram != null ? vram.toFixed(0) + '% used' : 'total unknown') + (gpus.length > 1 ? ' · ' + name : '');
      }
      sparkTile(vEl, vram, vramBig, vramSub, hwSeries(d, 'vram' + i));
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
    sparkTile(box, tileValues(s)['pow' + i], big, sub, hwSeries(d, 'pow' + i));
    box.querySelector('.spark').title = g.powerLimit != null ? 'Top of the chart = ' + Math.round(g.powerLimit) + ' W (the card\'s power limit)' : '';
  },
});

// ---------- PCIe (AI_SCOPE-065): one card's bus traffic (RX / TX MB/s, chart like the disk tile) + link ----------
// NVIDIA only (dmon stream); "link" = current vs max negotiated PCIe link from nvidia-smi (info.gpus[].link).
// Sub line: link text then the card name (AI_SCOPE-068) — "Gen 5 ×8 of Gen 5 ×16 · NVIDIA GeForce RTX 5060 Ti".
// MB/s values; chart scaled to the busiest moment of the 5 minutes (+25 %), minimum 1 MB/s.
const pcieOf = (s, i) => { const g = s && s.gpus && s.gpus[i]; return g && g.pcieRx != null ? g : null; };
const pcieScale = (hist, i) => Math.max(1, 1.25 * hist.reduce((a, s) => { const g = pcieOf(s, i); return g ? Math.max(a, g.pcieRx || 0, g.pcieTx || 0) : a; }, 0));
// 092: both PCIe lines share the one time-mapped axis; a card that stops reporting breaks its line rather than
// stretching the gap. The scale is computed over the same window the chart draws, so the ceiling matches what is on screen.
function pciePath(pts, i, key, max) {
  return sparkPath(sparkSegs(pts, s => { const g = s.gpus && s.gpus[i]; return g && g[key] != null ? Math.min(100, 100 * (g[key] || 0) / max) : null; }));
}
const fmtMb = m => m == null ? '—' : m >= 1024 ? (m / 1024).toFixed(2) + ' GB/s' : Math.round(m) + ' MB/s';
function linkText(l) {
  if (!l) return '';
  const cur = 'Gen ' + l.gen + ' ×' + l.width, max = 'Gen ' + l.genMax + ' ×' + l.widthMax;
  return cur === max ? max : cur + ' of ' + max;
}
defineLens({
  id: 'hardware.pcie', scope: 'hardware', size: 'tile',
  name: 'PCIe', description: "One graphics card's PCIe bus traffic (RX / TX MB/s; model loads spike it) and its link vs what the card can use at most. NVIDIA cards only.",
  settings: [
    { id:'card', label:'Graphics card', type:'gpu', default:0 },
  ],
  markup: st => `
  <div class="tilebox" data-tile="pcie${st.card}">` + lensHeadMarkup('PCIe') + `
  <div class="tile">
    <div class="v">—</div>
    <div class="sub">&nbsp;</div>
    <div class="meter"><div></div></div>
    <div class="spark"><svg viewBox="0 0 100 100" preserveAspectRatio="none">
      <path class="line"></path><path class="line wline"></path><line class="guide" y1="0" y2="100" style="display:none"></line></svg>
      <div class="tip" hidden></div></div>
    <div class="spark-axis"><span></span><span class="dlegend"><i class="rd"></i>rx <i class="wr"></i>tx</span><span>now</span></div>
  </div></div>`,
  render(L, d) {
    const info = d.info, gpus = info.gpus || [], i = L.settings.card;
    const box = L.el.querySelector('[data-tile="pcie' + i + '"]'); if (!box) return;
    const num = gpus.length > 1 ? ' ' + (i + 1) : '';   // "PCIe 2" with several cards, plain with one
    if (box.querySelector('.ltitle').textContent !== 'PCIe' + num) box.querySelector('.ltitle').textContent = 'PCIe' + num;
    const s = hwLatest(d); if (!s) return;
    const v = box.querySelector('.tile');
    const name = gpus[i] ? gpus[i].name : (info.gpuSource === 'none' ? 'No GPU stats available' : gpus.length ? 'GPU ' + (i + 1) + ' not found' : 'detecting…');
    const g = (s.gpus && s.gpus[i]) || {};
    if (g.pcieRx == null) {
      v.querySelector('.v').innerHTML = NA_HTML;
      v.querySelector('.sub').textContent = name + ' · ' + (gpus[i] && gpus[i].source !== 'nvidia' ? 'PCIe traffic: NVIDIA cards only' : 'detecting…');
      v.querySelector('.meter > div').style.width = '0%';
      v.querySelector('.spark').title = '';
      return;
    }
    const rx = g.pcieRx || 0, tx = g.pcieTx || 0, both = rx + tx;
    const scale = pcieScale(hwScaleHist(d), i);
    v.querySelector('.v').innerHTML = both + '<small> MB/s</small>';
    const lt = linkText(gpus[i] && gpus[i].link);
    v.querySelector('.sub').textContent = lt ? lt + ' · ' + name : name;   // 068: name the card next to the link text
    if (lt) v.querySelector('.sub').title = 'PCIe link between card and PC: Gen sets the per-lane speed, × the lanes (Gen 4 ×16 = 16 GB/s). Showing current vs what the card could use at most — current can drop while the card is idle; below max explains slow model loads.';
    v.querySelector('.meter > div').style.width = Math.max(0, Math.min(100, 100 * both / scale)) + '%';
    v.querySelector('.line').setAttribute('d', pciePath(hwWin(d), i, 'pcieRx', scale));
    v.querySelector('.wline').setAttribute('d', pciePath(hwWin(d), i, 'pcieTx', scale));
    v.querySelector('.spark').title = 'Top of the chart = ' + fmtMb(scale) + ' (rx / tx MB/s)';
  },
});

// ---------- Disk (AI_SCOPE-030): one physical disk - active time %, read and write lines ----------
// bytes/s -> "12.3 MB/s" ("850 KB/s" below 1 MB/s)
const fmtRate = b => b == null ? '—' : b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB/s' : b >= 1e6 ? (b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + ' MB/s' : Math.round(b / 1e3) + ' KB/s';
const diskOf = (s, id) => s && s.disks ? (id ? s.disks.find(x => x.id === id) : s.disks[0]) || null : null;
// The lines are scaled to the busiest moment of the last 5 minutes (+25 %), at least 1 MB/s.
const diskScale = (hist, id) => Math.max(1e6, 1.25 * hist.reduce((a, s) => { const x = diskOf(s, id); return x ? Math.max(a, x.read || 0, x.write || 0) : a; }, 0));
// 092: same time-mapped axis and the same break rule as every other lens; a disk that stops reporting is a hole, not a slope.
function diskPath(pts, id, key, max) {
  return sparkPath(sparkSegs(pts, s => { const x = diskOf(s, id); return x ? Math.min(100, 100 * (x[key] || 0) / max) : null; }));
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
    <div class="spark-axis"><span></span><span class="dlegend"><i class="rd"></i>read <i class="wr"></i>write</span><span>now</span></div>
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
    const max = diskScale(hwScaleHist(d), id);
    el.querySelector('.line:not(.wline)').setAttribute('d', diskPath(hwWin(d), id, 'read', max));
    el.querySelector('.wline').setAttribute('d', diskPath(hwWin(d), id, 'write', max));
    el.querySelector('.spark').title = 'Top of the chart = ' + fmtRate(max);
  },
});

// Setting of the Current request / Current run lenses (AI_SCOPE-020): show the process stats row (below) or not.
const PROC_STATS_FIELD = { id: 'procStats', label: 'Show process stats', type: 'toggle', default: true,
  tip: 'While a request or job runs: the row with GPU, VRAM, CPU and RAM use — of the app\'s own process where known, otherwise of the whole computer.' };

// ---- "System load" row on the Current request / Current run cards ----
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
// AI_SCOPE-092: the pointer picks a TIME on the axis the chart actually drew (lens.js sparkHover), then the nearest
// sample to that time answers — the guide, the value and the clock label agree even when samples are missing or the
// pace changed, which index math could not promise. Mirror tiles are dispatched first: they carry their own history
// and can be hovered before the Hardware sampler has produced any (077).
document.addEventListener('mousemove', e => {
  const spark = e.target.closest && e.target.closest('[data-tile] .spark'); if (!spark) return;
  const id = spark.closest('[data-tile]').dataset.tile;
  const rect = spark.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const guide = spark.querySelector('.guide'), tip = spark.querySelector('.tip');
  if (typeof MIRROR_HOVER !== 'undefined') {
    for (let mi = 0; mi < MIRROR_HOVER.length; mi++) {
      if (id.indexOf(MIRROR_HOVER[mi].prefix) === 0) { MIRROR_HOVER[mi].fn(spark, f, guide, tip); return; }
    }
  }
  const pts = sparkWindow(hwHist);
  if (!pts.length) return;
  sparkHover(spark, f, guide, tip, pts, h => hwTipText(h, id));
});

// The value the Hardware hover prints for one sample, by data-tile key ('cpu', 'ram', 'ramC', 'gpu<i>', 'vram<i>',
// 'pow<i>', 'pcie<i>', 'disk:<id>'). The clock time is appended by sparkHover, same as the mirror tiles.
function hwTipText(h, id) {
  if (id.indexOf('disk:') === 0) {   // disk tile: read / write / active at that time
    const d = diskOf(h, id.slice(5));
    return d ? 'R ' + fmtRate(d.read) + ' · W ' + fmtRate(d.write) + ' · ' + (d.active != null ? d.active.toFixed(0) : '—') + '%' : 'n/a';
  }
  if (id.indexOf('pcie') === 0) {   // PCIe tile (AI_SCOPE-065): rx / tx at that time
    const g = h.gpus && h.gpus[+id.slice(4)];
    return g && g.pcieRx != null ? 'RX ' + g.pcieRx + ' · TX ' + (g.pcieTx || 0) + ' MB/s' : 'n/a';
  }
  if (id === 'ramC') {   // Committed RAM tile (AI_SCOPE-074): reserved memory against the commit limit at that time
    const lim = h.commitLimit;
    return (lim != null && h.commitUsed != null)
      ? GB(h.commitUsed) + ' / ' + GB(lim) + ' GB (' + Math.min(100, Math.round(100 * h.commitUsed / lim)) + '%)' : 'n/a';
  }
  if (id.indexOf('pow') === 0) {   // power tile (AI_SCOPE-027): watts at that time
    const g = h.gpus && h.gpus[+id.slice(3)];
    return g && g.power != null ? Math.round(g.power) + ' W' + (g.powerLimit ? ' of ' + Math.round(g.powerLimit) + ' W limit' : '') : 'n/a';
  }
  const v = tileValues(h)[id];
  return v == null ? 'n/a' : v.toFixed(0) + '%';
}
document.addEventListener('mouseout', e => {
  const spark = e.target.closest && e.target.closest('.spark');
  if (spark && !spark.contains(e.relatedTarget)) { spark.querySelector('.tip').hidden = true; spark.querySelector('.guide').style.display = 'none'; }
});

// ---------- The Hardware scope page: CPU + RAM, then one GPU lens (GPU + VRAM) per card (default layout; editable, AI_SCOPE-020) ----------
defineScopeLayout('hardware', () => {
  const gpus = (SOURCES.hardware.data && SOURCES.hardware.data.info.gpus) || [];
  const items = layoutOf(['hardware.cpu', 'hardware.ram']);
  // AI_SCOPE-074: a second RAM tile showing committed memory over the commit limit - left out of the macOS
  // default (no commit-limit concept there); still addable by hand, where it answers "not available".
  if (SERVER_OS !== 'darwin') items.push({ lens: 'hardware.ram', settings: { show: 'committed' } });
  for (let i = 0; i < Math.max(1, gpus.length); i++) {   // power + PCIe tile per card (027 / 065)
    items.push({ lens: 'hardware.gpu', settings: { card: i, show: 'both' } });
    items.push({ lens: 'hardware.power', settings: { card: i } });
    items.push({ lens: 'hardware.pcie', settings: { card: i } });
  }
  const disks = (SOURCES.hardware.data && SOURCES.hardware.data.info.disks) || [];
  disks.forEach(x => items.push({ lens: 'hardware.disk', settings: { disk: x.id } }));   // AI_SCOPE-030
  return items;
});
// AI_SCOPE-088: the scope-header helper text is gone - the header shows only the title (user direction 2026-10-31).
