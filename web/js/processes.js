// AI_SCOPE dashboard - Processes scope (AI_SCOPE-023, built in): the top 5 processes by VRAM, GPU, CPU and RAM, one lens
// each. Lens settings (cog): per app (same program added together) or per process; VRAM / GPU: which graphics card.
// Data: /api/processes (proctop.js; Windows, Linux, macOS - AI_SCOPE-052). The server's sampler is always warm but samples slowly
// while nobody asks, so the source polls only while one of its lenses is on screen (that puts it on its fast pace).

defineSource('processes', '/api/processes', 'processes', 2500, true);

const TOP_N = 5;
// Values carry their unit: "3.4GB", "0.12GB", "30%", "4.1%"
const pctText = v => (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + '%';
const gb2 = b => { const g = b / 1073741824; return (g >= 1 ? g.toFixed(1) : g.toFixed(2)) + 'GB'; };
const rate2 = b => b >= 1e9 ? (b / 1e9).toFixed(1) + 'GB/s' : b >= 1e6 ? (b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + 'MB/s' : b >= 1e3 ? Math.round(b / 1e3) + 'KB/s' : '0';
// rate: needs two samples (CPU %, GPU %, I/O), so it isn't in the sampler's first block (AI_SCOPE-059).
// value(p, card) of one process; shown when at least min (GB columns: 0.005 GB, so nothing shows as 0.00). sum: how per-app rows add up (GPU % is capped at 100).
const PROC_METRICS = {
  vram: { floor: 0.5 * 1073741824, name: 'Top VRAM', col: 'VRAM', card: true, min: 0.005 * 1073741824, fmt: gb2,
    description: 'The 5 processes using the most VRAM (dedicated GPU memory) on one graphics card.',
    value: (p, c) => p.gpus[c] ? p.gpus[c].vram : 0,
    colTip: 'Memory shared between apps (e.g. window surfaces) counts under each app that uses it, so the rows can add up to more than the card\'s total on the Hardware page.',
    tip: (p, c) => p.gpus[c] && p.gpus[c].shared >= 1048576 ? '+ ' + fmtBytes(p.gpus[c].shared) + ' in shared (system) memory' : '' },
  shared: { floor: 0.5 * 1073741824, name: 'Top Shared VRAM', col: 'Shared', card: true, min: 0.005 * 1073741824, fmt: gb2,
    description: 'The 5 processes using the most shared GPU memory (system RAM the graphics card uses when its VRAM is full) on one graphics card. Spill here slows a model down.',
    colTip: 'System RAM used as GPU memory. Windows can report the same shared memory on every card a process uses.',
    value: (p, c) => p.gpus[c] ? p.gpus[c].shared : 0 },
  gpu: { rate: true, floor: 10, name: 'Top GPU', col: 'GPU', card: true, min: 0.05, fmt: pctText, cap: 100,
    description: 'The 5 processes using the most of one graphics card (busiest engine, like Task Manager).',
    value: (p, c) => p.gpus[c] && p.gpus[c].util || 0 },
  cpu: { rate: true, floor: 10, name: 'Top CPU', col: 'CPU', min: 0.05, fmt: pctText, cap: 100,
    description: 'The 5 processes using the most CPU (share of the whole CPU, all cores).',
    value: p => p.cpu || 0 },
  // AI_SCOPE-030: Windows' per-process I/O counters count ALL I/O (disk, network, devices), so it's "I/O", not "disk".
  // Ranked and drawn by read + write; split = the two columns shown.
  io: { rate: true, floor: 1e6, name: 'Top I/O', col: 'I/O', min: 1e3, fmt: rate2,
    description: 'The 5 processes reading and writing the most (MB/s): disk, but also network and devices — Windows counts all of a process\'s I/O together. Shows which app is loading a model.',
    colTip: SERVER_OS === 'linux' ? 'Disk reads and writes of the process. Other users\' processes show 0 unless AI_SCOPE runs as root.'
      : 'All I/O of the process: disk, network and devices together (Windows doesn\'t separate disk per process without admin rights).',
    value: p => (p.ioRead || 0) + (p.ioWrite || 0),
    split: [{ col: 'Read', value: p => p.ioRead || 0 }, { col: 'Write', value: p => p.ioWrite || 0 }] },
  ram: { floor: 0.5 * 1073741824, name: 'Top RAM', col: 'RAM', min: 0.005 * 1073741824, fmt: gb2,
    description: 'The 5 processes using the most RAM (working set, like Task Manager\'s Memory column).',
    value: p => p.ram || 0 },
};

// What this system can show (AI_SCOPE-052): per-process GPU numbers (Windows; Linux with an NVIDIA card), shared GPU
// memory (Windows only) and I/O (not macOS). The server says so in /api/processes (has); before its first answer, guess from the system and the cards.
// Lenses it can't fill are left off the default page and out of the Add lens dialog.
const PROC_NOSYS = 'Process stats aren\'t available on this system.';
function procHas(what) {
  const d = SOURCES.processes && SOURCES.processes.data;
  if (d && d.has) return !!d.has[what];
  if (SERVER_OS === 'win32') return true;
  if (what === 'io') return SERVER_OS === 'linux';
  if (what === 'shared') return false;
  const gpus = (SOURCES.hardware && SOURCES.hardware.data && SOURCES.hardware.data.info.gpus) || [];
  return SERVER_OS === 'linux' && gpus.some(g => g.source === 'nvidia');
}
const procNeeds = (key, m) => key === 'shared' ? 'shared' : m.card ? 'gpu' : key === 'io' ? 'io' : null;
// Rows for one metric: [{ name, pids: [], value, tip }], biggest first.
function topRows(procs, m, st) {
  const card = m.card ? st.card : 0;
  // dwm.exe (the Windows desktop) is hidden on the GPU lenses unless the lens says otherwise: Windows counts the window
  // surfaces it draws under dwm AND under the app that made them, so its number is mostly other apps' memory again.
  if (m.card && st.dwm !== 'show') procs = procs.filter(p => p.name.toLowerCase() !== 'dwm.exe');
  let rows = procs.map(p => ({ name: p.name, pids: [p.pid], icon: p.icon, value: m.value(p, card), tip: m.tip ? m.tip(p, card) : '',
    parts: m.split ? m.split.map(x => x.value(p)) : null }));
  if (st.group !== 'pid') {
    const by = {};
    rows.forEach(r => {
      const k = r.name.toLowerCase(), g = by[k];
      if (!g) { by[k] = { name: r.name, pids: r.pids.slice(), icon: r.icon, value: r.value, tip: '', parts: r.parts ? r.parts.slice() : null }; return; }
      g.pids.push(r.pids[0]); g.value += r.value;
      if (g.parts) r.parts.forEach((v, i) => { g.parts[i] += v; });
      if (!g.icon) g.icon = r.icon;
    });
    rows = Object.values(by);
    if (m.cap) rows.forEach(r => { r.value = Math.min(m.cap, r.value); });
  }
  return rows.filter(r => r.value >= m.min).sort((a, b) => b.value - a.value).slice(0, TOP_N);
}
// The exe's own icon (from the server, read from the exe), or a plain placeholder when Windows didn't give its path
// (system and protected processes) or it has none.
const PROC_ICON = '<svg class="picon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>';
function procIconHtml(r) {
  return r.icon ? '<img class="picon" src="/api/process-icon/' + r.icon + '" alt="" onerror="this.outerHTML=PROC_ICON">' : PROC_ICON;
}
// ---------- 5-minute history (sparkline per row, AI_SCOPE-023 item 6) ----------
// Kept in this browser from the samples it polls (the server samples only while a Processes lens is on screen anyway):
// the last 5 minutes of /api/processes samples, oldest first. Filled from the server's own history
// (/api/processes/history, AI_SCOPE-059) when the page opens or comes back after a gap (tab hidden), then from the polls.
const PROC_HIST_MS = SPARK_WIN;                 // 092: one window constant for every sparkline in the app (lens.js)
const PROC_HIST_MAX = Math.ceil(PROC_HIST_MS / 2000) + 20;   // safety cap only - time decides what is kept
let procHist = [], procHistLoading = false;     // [{ at, every, procs }] - each sample keeps the pace it was taken at (092)
function addProcSamples(samples) {
  const seen = new Set(procHist.map(h => h.at));
  samples.forEach(s => { if (s && s.at && !seen.has(s.at)) { procHist.push({ at: s.at, every: s.every, procs: s.procs }); seen.add(s.at); } });
  procHist.sort((a, b) => a.at - b.at);
  sparkPrune(procHist, PROC_HIST_MS);           // 092: prune by TIME (newest minus the window), keeping the one older sample at the left edge
  if (procHist.length > PROC_HIST_MAX) procHist.splice(0, procHist.length - PROC_HIST_MAX);
}
function recordProcSample(d) {
  if (!d || !d.at || d.partial || (procHist.length && procHist[procHist.length - 1].at >= d.at)) return;
  const prev = procHist.length ? procHist[procHist.length - 1] : null;
  // 092: the same pace-relative test the chart draws with, but judged by the stamps of the two samples (the old
  // version read d.every, i.e. the pace right now). A gap that big means samples went missing: refetch what the
  // server kept (the lines catch up on the next poll).
  const base = prev ? Math.max(prev.every || 0, d.every || 0) || 5000 : 0;
  const gap = !prev || d.at - prev.at > Math.min(120000, Math.max(1500, 3 * base));
  addProcSamples([d]);
  if (gap && !procHistLoading) {   // missing samples: fetch what the server kept (the lines catch up on the next poll)
    procHistLoading = true;
    fetch('/api/processes/history', { cache: 'no-store' }).then(r => r.json())
      .then(h => { if (h && h.samples) addProcSamples(h.samples); }).catch(() => {}).then(() => { procHistLoading = false; });
  }
}
// A row's value in every kept sample: the same process (per process) or all processes of that exe (per app); null = not running then.
// 092: the samples are passed in (a snapshot of the ring at render time) so the drawn values, the axis and the hover
// all read the same list - including each sample's `every` stamp, which is what decides whether a gap breaks a line.
function rowSeries(r, m, st, samples) {
  const card = m.card ? st.card : 0, lname = r.name.toLowerCase(), pid = r.pids[0];
  return (samples || procHist).map(h => {
    const ps = st.group === 'pid' ? h.procs.filter(p => p.pid === pid && p.name === r.name) : h.procs.filter(p => p.name.toLowerCase() === lname);
    if (!ps.length) return null;
    const v = ps.reduce((a, p) => a + m.value(p, card), 0);
    return m.cap ? Math.min(m.cap, v) : v;
  });
}
// Line scaled to the row's own highest value (+25 % headroom), but at least m.floor (so a process idling at 0.1 % isn't drawn as big swings).
// 092: x by time across the samples actually held, drawn with the same helpers every other lens uses - and a line now
// BREAKS where the wait between two samples exceeded the pace those samples owed, where before it was drawn straight
// across the hole. (Its own sparkX() is gone: classic scripts share one global lexical scope, and lens.js now owns that name.)
function sparkHtml(series, m, samples) {
  if (series.filter(v => v != null).length < 2) return '<td class="pspark"></td>';
  const top = Math.max(m.floor, 1.25 * Math.max(...series.filter(v => v != null)));   // headroom: a steady value sits at 80 %, not on the edge
  const pts = samples.map((s, i) => ({ t: s.at, every: s.every, v: series[i] }));
  const segs = sparkSegs(pts, p => (p.v == null ? null : 100 * p.v / top));
  return '<td class="pspark"><div class="pspk"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><path class="area" d="' + sparkArea(segs) + '"></path><path class="line" d="' + sparkPath(segs) + '"></path>' +
    '<line class="guide" y1="0" y2="100" style="display:none"></line></svg><div class="ptip" hidden></div></div></td>';
}
// Hover on a row's line: the value at that time (like the Hardware tiles). 092: the cursor picks a TIME on the
// span the row was drawn across, and the nearest sample answers - the same rule as the tiles and the mirrors.
document.addEventListener('mousemove', e => {
  const box = e.target.closest && e.target.closest('.pspk'); if (!box || !box._series) return;
  const s = box._series, samples = box._samples, r = box.getBoundingClientRect();
  const rng = sparkRange(samples); if (!rng) return;
  const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  const tc = rng.t0 + f * (rng.t1 - rng.t0);
  let i = 0;   // the sample nearest the cursor time
  for (let k = 1; k < samples.length; k++) if (Math.abs(samples[k].at - tc) < Math.abs(samples[i].at - tc)) i = k;
  const x = sparkX(samples[i].at, rng);
  const g = box.querySelector('.guide'), tip = box.querySelector('.ptip');
  g.setAttribute('x1', x); g.setAttribute('x2', x); g.style.display = '';
  tip.hidden = false; tip.style.left = x + '%';
  tip.textContent = (s[i] == null ? 'not running' : box._fmt(s[i])) + ' · ' + new Date(samples[i].at).toLocaleTimeString();
});
document.addEventListener('mouseout', e => {
  const box = e.target.closest && e.target.closest('.pspk');
  if (box && !box.contains(e.relatedTarget)) { box.querySelector('.ptip').hidden = true; box.querySelector('.guide').style.display = 'none'; }
});

function procNameHtml(r, st) {
  return '<span class="pname">' + procIconHtml(r) + '<span class="plabel">' + procLabelHtml(r, st) + '</span></span>';
}
function procLabelHtml(r, st) {
  if (st.group === 'pid') return nameHtml(r.name) + ' <span class="pn">(' + r.pids[0] + ')</span>';
  const n = r.pids.length;
  const pids = r.pids.slice().sort((a, b) => a - b);
  const tip = r.name + (n > 1 ? ' — ' + n + ' processes, PIDs ' : ' — PID ') + pids.slice(0, 20).join(', ') + (n > 20 ? ', …' : '');
  return '<span title="' + escH(tip) + '">' + escH(cutName(r.name)) + '</span>' + (n > 1 ? ' <span class="pn">×' + n + '</span>' : '');
}

Object.keys(PROC_METRICS).forEach(key => {
  const m = PROC_METRICS[key];
  const settings = [{ id: 'group', label: 'Rows', type: 'choice', default: 'app',
    options: [['app', 'Per app (processes of the same program added together)'], ['pid', 'Per process']] }];
  if (m.card) settings.push({ id: 'card', label: 'Graphics card', type: 'gpu', default: 0 });
  if (m.card) settings.push({ id: 'dwm', label: 'Show the Windows desktop process (dwm.exe)', type: 'choice', default: 'hide',
    options: [['hide', 'No — its number is mostly other apps\' window memory, counted twice'], ['show', 'Yes']], when: () => SERVER_OS === 'win32' });
  defineLens({
    id: 'processes.' + key, scope: 'processes', size: 'tile',
    available: () => !procNeeds(key, m) || procHas(procNeeds(key, m)),
    name: m.name, description: m.description, settings,
    markup: tableLensMarkup({ title: m.name, hint: '', cols: ['Process', '<span title="The samples held for this row while the page has been open (up to 5 minutes of them, whatever the pace); hover for values">History</span>']
      .concat((m.split ? m.split.map(x => x.col) : [m.col]).map(c => m.colTip ? '<span title="' + escH(m.colTip) + '">' + c + '</span>' : c)), foot: '' }),
    init(L) { L.el.classList.add('ptop'); if (m.split) L.el.classList.add('psplit'); },
    render(L, d) {
      recordProcSample(d);
      const st = L.settings;
      // Title: "Top VRAM · GPU 2" when the PC has several cards
      const gpus = (SOURCES.hardware.data && SOURCES.hardware.data.info.gpus) || [];
      const title = m.name + (m.card && gpus.length > 1 ? ' · GPU ' + (st.card + 1) : '');
      const t = L.el.querySelector('.ltitle');
      if (t.textContent !== title) t.textContent = title;
      let msg = '', rows = [];
      if (!d.supported) msg = PROC_NOSYS;
      else if (procNeeds(key, m) && !procHas(procNeeds(key, m))) msg = 'Not available on this system.';
      else if (d.error) msg = escH(d.error);
      else if (!d.at) msg = 'Starting…';
      else if (m.card && d.procs.length && d.procs[0].gpus.length <= st.card) msg = 'GPU ' + (st.card + 1) + ' not found on this computer.';
      else if (d.partial && m.rate) msg = 'Measuring…';   // first block: memory only (AI_SCOPE-059)
      else {
        rows = topRows(d.procs, m, st);
        if (!rows.length) msg = m.card ? 'No process is using ' + (gpus.length > 1 ? 'GPU ' + (st.card + 1) : 'the GPU') + ' right now.' : 'Nothing to show yet.';
      }
      // Always TOP_N rows tall (message and blank filler rows count), so lenses side by side keep the same height.
      const samples = procHist.slice();   // 092: one snapshot of the ring, shared by the values, the axis and the hover
      const series = rows.map(r => rowSeries(r, m, st, samples));
      const ncol = m.split ? 2 + m.split.length : 3;
      const valueCells = r => r.parts ? r.parts.map(v => '<td>' + m.fmt(v) + '</td>').join('') : '<td' + (r.tip ? ' title="' + escH(r.tip) + '"' : '') + '>' + m.fmt(r.value) + '</td>';
      const trs = msg ? ['<tr class="pmsg"><td colspan="' + ncol + '">' + msg + '</td></tr>']
        : rows.map((r, i) => '<tr><td>' + procNameHtml(r, st) + '</td>' + sparkHtml(series[i], m, samples) + valueCells(r) + '</tr>');
      while (trs.length < TOP_N) trs.push('<tr class="pfill" aria-hidden="true"><td colspan="' + ncol + '">&nbsp;</td></tr>');
      const html = trs.join('');
      const body = L.$('rows');
      if (body._html !== html) {
        body._html = html; body.innerHTML = html;
        [...body.rows].forEach((tr, i) => { const box = tr.querySelector('.pspk'); if (box) { box._series = series[i]; box._samples = samples; box._fmt = m.fmt; } });   // row i = rows[i] (a row without a line has no box)
      }
    },
  });
});

// ---------- AI processes (full width): the installed AI app scopes, each with its own process(es) ----------
// Same matching as their Current request cards (procstats): Bionic / Ollama / Strata = the model process, ComfyUI = its
// python. VRAM = all cards added up and GPU % = the busiest card; the hover shows each card.
function appCell(a) {
  const sc = scopeById(a.id);
  const ic = sc && sc.icon ? sc.icon.replace('<svg ', '<svg class="picon" ') : PROC_ICON;
  const img = sc && sc.logo ? '<img class="picon" src="' + logoUrl(a.id) + '" alt="" onerror="this.outerHTML=' + escH(JSON.stringify(ic)) + '">' : ic;
  const pr = a.process;
  const sub = pr ? pr.pids.map(p => p.name).filter((n, i, all) => all.indexOf(n) === i).join(', ') : (a.modelOnly ? 'no model loaded, or not running' : 'not running');
  const tip = pr ? a.name + ' — ' + pr.pids.map(p => p.name + ' ' + p.pid).join(', ') : '';
  return '<span class="pname"' + (tip ? ' title="' + escH(tip) + '"' : '') + '>' + img + '<span class="plabel">' + escH(a.name) + ' <span class="pn">' + escH(sub) + '</span></span></span>';
}
defineLens({
  id: 'processes.apps', scope: 'processes', size: 'full',
  name: 'AI processes', description: 'Your installed AI apps (Bionic, Ollama, ComfyUI, Strata, llama.cpp) with the VRAM, GPU, CPU and RAM of their own processes.',
  markup: tableLensMarkup({ title: 'AI processes', hint: '', cols: ['App', '<span title="All graphics cards added up; hover a value for each card">VRAM</span>',
    '<span title="The busiest graphics card; hover a value for each card">GPU</span>', 'CPU', 'RAM'], foot: '' }),
  init(L) { L.el.classList.add('ptop', 'papps'); },
  render(L, d) {
    if (!procHas('gpu') && !L.state.noGpu) { L.state.noGpu = true; hideColumns(L.el, '2,3'); }   // VRAM, GPU: not on this system (AI_SCOPE-052)
    const gpus = (SOURCES.hardware.data && SOURCES.hardware.data.info.gpus) || [];
    const card = i => gpus.length > 1 ? 'GPU ' + (i + 1) : 'GPU';
    const apps = (d.apps || []).slice().sort((a, b) => (b.process ? 1 : 0) - (a.process ? 1 : 0) ||
      (b.process ? b.process.gpus.reduce((s, g) => s + g.vram, 0) : 0) - (a.process ? a.process.gpus.reduce((s, g) => s + g.vram, 0) : 0));
    let msg = '';
    if (!d.supported) msg = PROC_NOSYS;
    else if (!apps.length) msg = 'No AI app scope installed. Add Bionic, Ollama, ComfyUI, Strata or llama.cpp on the Scopes page (+).';
    const trs = msg ? ['<tr class="pmsg"><td colspan="5">' + msg + '</td></tr>'] : apps.map(a => {
      const pr = a.process, dash = '<td class="na">—</td>';
      if (!pr) return '<tr class="poff"><td>' + appCell(a) + '</td>' + dash + dash + dash + dash + '</tr>';
      const vram = pr.gpus.reduce((s, g) => s + g.vram, 0);
      const vtip = pr.gpus.map((g, i) => g.vram >= 0.005 * 1073741824 ? card(i) + ' ' + gb2(g.vram) : '').filter(Boolean).join(' · ') + (pr.gpus.some(g => g.shared >= 1048576) ?
        ' · ' + gb2(pr.gpus.reduce((m, g) => Math.max(m, g.shared || 0), 0)) + ' in shared (system) memory' : '');
      const utils = pr.gpus.map(g => g.util).filter(u => u != null);
      const gtip = pr.gpus.map((g, i) => card(i) + ' ' + (g.util != null ? pctText(g.util) : '—')).join(' · ');
      return '<tr><td>' + appCell(a) + '</td><td title="' + escH(vtip) + '">' + gb2(vram) + '</td>' +
        '<td title="' + escH(gtip) + '">' + (utils.length ? pctText(Math.max.apply(null, utils)) : '—') + '</td>' +
        '<td>' + (pr.cpu != null ? pctText(pr.cpu) : '—') + '</td><td>' + (pr.ram != null ? gb2(pr.ram) : '—') + '</td></tr>';
    });
    const html = trs.join('');
    const body = L.$('rows');
    if (body._html !== html) { body._html = html; body.innerHTML = html; }
  },
});

// ---------- The Processes page (default layout; editable, AI_SCOPE-020): AI processes (full width), CPU, RAM,
// then GPU n + VRAM n per card, then shared GPU memory per card ----------
defineScopeLayout('processes', () => {
  const gpus = (SOURCES.hardware.data && SOURCES.hardware.data.info.gpus) || [];
  // GPU lenses per card where this system has per-process GPU numbers (AI_SCOPE-052); Windows always shows at least one
  const n = !procHas('gpu') ? 0 : SERVER_OS === 'win32' ? Math.max(1, gpus.length) : gpus.length;
  const items = layoutOf(['processes.apps', 'processes.cpu', 'processes.ram']);
  for (let i = 0; i < n; i++) items.push({ lens: 'processes.gpu', settings: { card: i } }, { lens: 'processes.vram', settings: { card: i } });
  if (procHas('shared')) for (let i = 0; i < n; i++) items.push({ lens: 'processes.shared', settings: { card: i } });
  if (procHas('io')) items.push({ lens: 'processes.io', settings: {} });   // AI_SCOPE-030
  return items;
});
// AI_SCOPE-088: the scope-header helper text is gone - the header shows only the title (user direction 2026-10-31).
// The subscription that fed it also carried the visibleOnly page hook; the page's own lenses now keep the source alive.
