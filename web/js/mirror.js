// AI_SCOPE-077: Hardware Mirror Lenses — the shared family of four lenses an app scope shows for its **own
// processes**: GPU / VRAM per card (AI_SCOPE-072), RAM Working / Committed (AI_SCOPE-073), CPU (AI_SCOPE-075)
// and file I/O (AI_SCOPE-076). Strata built them one ticket at a time in strata.js; defineMirror() lifts them
// into one source so every app scope gets the same tiles, rules and wording: quarter tiles in the Hardware tile
// style, 5-minute server-side history from procstats, hover from that history, stale sample => newest point +
// "Inactive", Width on all, GPU with a card picker, RAM with Show (Working / Committed, each with its own
// ceiling), CPU with no settings, I/O without a disk picker (one number per process, not per drive) — and no
// Power / PCIe mirrors, which have no per-process equivalent (see the Terminology section of the tasks doc).
// Call it after the scope's defineSource; the source payload must carry `process`, `processSupported`,
// `processHistory` and `processCards` (stratastats.js shape; the /api/bionic route adds them the same way).
// The full rules of the family, and the settled per-metric decisions, are in the v0.4 tasks doc (072 / 073 /
// 075 / 076); this module is their single implementation.

// Per-prefix hover handlers for the shared sparkline hover in hardware.js. Each mirror scope registers the
// prefix used by its tiles, so a Bionic tile hovers over Bionic's history, not Strata's (the pre-077
// branches read window.STRATA_PROC_HIST by name — one scope hardcoded into the shared handler).
// The MIRROR_HOVER array itself is declared in hardware.js (the hover handler lives there and classic scripts
// share one global lexical scope — declaring it twice would be a SyntaxError); mirror.js loads after it.

// One entry per app scope:
//   key   — the scope id; lens ids become <key>.gpu / .ram / .cpu / .io, so saved layouts address them directly
//   name  — display name in labels ("Bionic RAM (Committed)"; the tile CSS upper-cases)
//   letter — starts the four data-tile prefixes (<letter>gp / <letter>ram / <letter>cp / <letter>io); one letter
//            per scope, distinct from every other scope's (077 uses 's' for Strata, 'b' for Bionic)
function defineMirror(spec) {
  const key = spec.key, name = spec.name, p = spec.letter;
  // The scope's process history, newest last — kept for the hover handlers (same role window.STRATA_PROC_HIST
  // had before 077; the global stays for debugging and for anything that already reads it).
  let hist = [];
  window[name.toUpperCase().replace(/[^A-Z0-9]/g, '') + '_PROC_HIST'] = hist;   // e.g. STRATA_PROC_HIST, BIONIC_PROC_HIST
  const cards = [];   // per-card { name, vramTotal } from the payload, for the GPU tile labels and the hover ceiling
  subscribeSource(key, d => { hist = (d && d.processHistory) || []; cards.length = 0; (d && d.processCards || []).forEach(c => cards.push(c)); });

  // ---------- GPU / VRAM per card (AI_SCOPE-072) ----------
  // One metric per tile (Show picks GPU usage or VRAM); a card picker because VRAM is per card. "Inactive ·
  // <card>" when the process sample is stale (big value = newest history point); "Not available on this system"
  // where per-process GPU stats cannot exist (macOS; Linux AMD / Intel cards) — no invented fallback numbers.
  defineLens({
    id: key + '.gpu', scope: key, size: 'tile',
    name: name + ' GPU',
    description: "One graphics card's GPU usage or VRAM used by " + name + "'s model process, with a 5-minute history.",
    settings: [
      { id:'card', label:'Graphics card', type:'gpu', default:0 },
      { id:'show', label:'Show', type:'choice', default:'gpu', options:[['gpu', 'GPU usage'], ['vram', 'VRAM']] },
    ],
    markup: st => tileHtml({ id: p + 'gp' + st.card + '_' + st.show,
      label: name + ' ' + (st.show === 'vram' ? 'VRAM' : 'GPU') + (st.card ? ' ' + (st.card + 1) : '') }),
    render(L, d) {
      const i = L.settings.card, show = L.settings.show;
      const box = L.el.querySelector('[data-tile="' + p + 'gp' + i + '_' + show + '"]'); if (!box) return;
      const num = cards.length > 1 ? ' ' + (i + 1) : '';
      const label = name + ' ' + (show === 'vram' ? 'VRAM' : 'GPU') + num;   // "Bionic GPU 2" with several cards, plain with one
      if (box.querySelector('.ltitle').textContent !== label) box.querySelector('.ltitle').textContent = label;
      const card = cards[i] || {}, cardName = card.name || (cards.length ? 'GPU ' + (i + 1) + ' not found' : 'detecting…');
      if (!d.processSupported) {   // macOS has no per-process GPU source (and none is coming without 062); Linux AMD / Intel cards lack it too
        setTile(box, null, NA_HTML, 'Not available on this system', []);
        return;
      }
      const total = card.vramTotal || 0;
      const pct = g => !g ? null : show === 'gpu' ? (g.util == null ? null : g.util) : (total ? 100 * g.vram / total : null);
      const series = hist.map(h => pct(h.gpus && h.gpus[i]));
      let cur = d.process && d.process.gpus ? d.process.gpus[i] : null;
      let inactive = false;
      if (!cur) {                                  // no fresh process - show the newest point history has, and say Inactive
        const last = hist.length ? hist[hist.length - 1] : null;
        cur = last && last.gpus ? last.gpus[i] : null;
        inactive = true;
      }
      const v = pct(cur);
      let big;
      if (show === 'gpu') big = cur && cur.util != null ? Math.round(cur.util) + '<small>%</small>' : NA_HTML;
      else big = cur && cur.vram != null ? GB(cur.vram) + (total ? '<small> / ' + GB(total) + ' GB</small>' : '<small> GB</small>') : NA_HTML;
      setTile(box, v, big, (inactive ? 'Inactive · ' : '') + cardName, series);
    },
  });
  MIRROR_HOVER.push({ prefix: p + 'gp', fn: (spark, f, guide, tip) => {   // GPU % or GB of the card total at that time
    if (!hist.length) return;
    const id = spark.closest('[data-tile]').dataset.tile;   // "<p>gp<card>_<show>"
    const rest = id.slice((p + 'gp').length), iCard = parseInt(rest, 10), show = rest.slice(-3);
    const k = Math.max(0, Math.min(hist.length - 1, Math.round(f * (hist.length - 1)))), hs = hist[k];
    const g = hs.gpus && hs.gpus[iCard], tot = cards[iCard];
    const text = show === 'gpu'
      ? (g && g.util != null ? g.util.toFixed(0) + '%' : 'n/a')
      : (g && g.vram != null ? GB(g.vram) + ' GB' + (tot && tot.vramTotal ? ' of ' + GB(tot.vramTotal) + ' GB' : '') : 'n/a');
    hoverAt(spark, f, guide, tip, hist, k, text);
  } });

  // ---------- RAM of the model process (AI_SCOPE-073) ----------
  // Working (working set / resident) or Committed (private), one metric per tile (Show picks it); no card
  // setting — process RAM is one system-wide number. Value + ceiling: Working is a fraction of system RAM,
  // Committed a fraction of the commit limit (RAM + pagefile, from the always-subscribed Hardware source —
  // macOS has no such limit, so there it falls back to system RAM and the sub line says so). Works on every
  // OS where procstats works (Windows / Linux / macOS).
  const RAM_TIP = {
    working: 'RAM in use by the process now (working set on Windows, resident on Linux / macOS), against the system total',
    committed: 'Private memory reserved for the process (must fit in RAM + pagefile), against the system commit limit; on Windows it counts the large-page / driver-pinned RAM that working sets never show (AI_SCOPE-063)',
  };
  defineLens({
    id: key + '.ram', scope: key, size: 'tile',
    name: name + ' RAM',
    description: name + "'s model process RAM — working set over system RAM, or committed private memory over the commit limit — with a 5-minute history.",
    settings: [
      { id:'show', label:'Show', type:'choice', default:'working', options:[['working', 'Working'], ['committed', 'Committed']] },
    ],
    markup: st => tileHtml({ id: p + 'ram_' + st.show,
      label: name + ' RAM (' + (st.show === 'committed' ? 'Committed' : 'Working') + ')' }),
    render(L, d) {
      const show = L.settings.show, committed = show === 'committed', k2 = committed ? 'ramPrivate' : 'ram';
      const box = L.el.querySelector('[data-tile="' + p + 'ram_' + show + '"]'); if (!box) return;
      const label = name + ' RAM (' + (committed ? 'Committed' : 'Working') + ')';
      if (box.querySelector('.ltitle').textContent !== label) box.querySelector('.ltitle').textContent = label;
      box.querySelector('.ltitle').title = RAM_TIP[show];
      // The ceiling: system RAM for Working, the commit limit for Committed. The Hardware source is always
      // subscribed (other scopes' System load rows need it), so its latest sample carries both.
      const hw = (SOURCES.hardware && SOURCES.hardware.data) || {};
      const hs = (hw.history && hw.history[hw.history.length - 1]) || {};
      const limit = committed ? (hs.commitLimit || hs.ramTotal || 0) : (hs.ramTotal || 0);
      const pct2 = b => (b != null && limit) ? Math.min(100, 100 * b / limit) : null;
      const series = hist.map(h => pct2(h[k2]));
      let cur = d.process ? d.process[k2] : null, inactive = false;
      if (cur == null) {                                           // no fresh process - newest point history has, and say Inactive
        for (let i = hist.length - 1; i >= 0; i--) if (hist[i][k2] != null) { cur = hist[i][k2]; break; }
        inactive = true;
      }
      const v = pct2(cur);
      const big = cur != null ? GB(cur) + (limit ? '<small> / ' + GB(limit) + ' GB</small>' : '<small> GB</small>') : NA_HTML;
      // Sub line: like the Hardware RAM tile ("% used"), naming what the percentage is taken of (OS-aware —
      // Linux / macOS report resident rather than a Windows working set, and macOS has no commit limit).
      const of = committed
        ? (hs.commitLimit ? 'of commit limit' + (SERVER_OS === 'linux' ? ' (RAM + swap)' : '') : 'of RAM (no commit limit here)')
        : 'of system RAM';
      setTile(box, v, big, inactive ? 'Inactive' : (v == null ? 'detecting\u2026' : v.toFixed(0) + '% ' + of), series);
    },
  });
  MIRROR_HOVER.push({ prefix: p + 'ram_', fn: (spark, f, guide, tip) => {   // working / committed GB at that time, against the right ceiling
    if (!hist.length) return;
    const k = Math.max(0, Math.min(hist.length - 1, Math.round(f * (hist.length - 1))));
    const hs = hist[k], id = spark.closest('[data-tile]').dataset.tile, committed = id === p + 'ram_committed';
    const b = hs[committed ? 'ramPrivate' : 'ram'];
    const h = (hwHist && hwHist.length) ? hwHist[Math.max(0, Math.min(hwHist.length - 1, Math.round(f * (hwHist.length - 1))))] : {};
    const lim = committed ? (h.commitLimit || h.ramTotal) : h.ramTotal;
    hoverAt(spark, f, guide, tip, hist, k, b != null ? GB(b) + ' GB' + (lim ? ' of ' + GB(lim) + ' GB' : '') : 'n/a');
  } });

  // ---------- CPU of the model process (AI_SCOPE-075) ----------
  // Mirrors the Hardware CPU tile's style (big "NN%", sub line names the machine, meter = the same %, sparkline
  // from history) but shows the app's own process numbers from procstats — one number for the whole PC, so there
  // is no card picker and no Show choice, only Width. No fresh process sample => newest history point + Inactive.
  const CPU_TIP = 'Share of the whole CPU (all cores) used by ' + name + "'s model process";
  defineLens({
    id: key + '.cpu', scope: key, size: 'tile',
    name: name + ' CPU',
    description: "CPU share of " + name + "'s model process across all cores, with a 5-minute history.",
    markup: () => tileHtml({ id: p + 'cpu', label: name + ' CPU' }),
    render(L, d) {
      const box = L.el.querySelector('[data-tile="' + p + 'cpu"]'); if (!box) return;
      box.querySelector('.ltitle').title = CPU_TIP;
      // Machine line exactly like hardware.cpu (the tile label already says which app this is).
      const hw = (SOURCES.hardware && SOURCES.hardware.data) || {};
      const info = hw.info || {};
      const series = hist.map(h => h.cpu == null ? null : Math.min(100, h.cpu));
      let cur = d.process ? d.process.cpu : null, inactive = false;
      if (cur == null) {                                            // stale process - newest point history has
        for (let i = hist.length - 1; i >= 0; i--) if (hist[i].cpu != null) { cur = hist[i].cpu; break; }
        inactive = true;
      }
      const v = cur == null ? null : Math.min(100, cur);
      setTile(box, v, v == null ? NA_HTML : v.toFixed(0) + '<small>%</small>',
        inactive ? 'Inactive' : (info.cpuModel || 'CPU') + ' · ' + (info.cores || '?') + ' threads', series);
    },
  });
  MIRROR_HOVER.push({ prefix: p + 'cpu', fn: (spark, f, guide, tip) => {   // % of all cores at that time
    if (!hist.length) return;
    const k = Math.max(0, Math.min(hist.length - 1, Math.round(f * (hist.length - 1)))), c = hist[k].cpu;
    hoverAt(spark, f, guide, tip, hist, k, c != null ? Math.min(100, c).toFixed(0) + '%' : 'n/a');
  } });

  // ---------- File I/O of the model process (AI_SCOPE-076) ----------
  // Layout and style mirror the Hardware Disk tile (two lines: read solid, write dashed, same legend and chart
  // scaling), with two differences on purpose: no disk picker (per-process I/O counters are one number per
  // process, not per physical drive) and no "% active" (a device counter). Big value = read + write, so the sub
  // line and the two chart lines always show the split — a read-then-write flow (unpacking a model, a copy)
  // legitimately counts its bytes twice, which the split makes readable. Windows counters only for now.
  const IO_TIP = 'Bytes per second ' + name + "'s model process reads and writes. One count per operation: a flow that reads then writes (unpacking a model, copying) counts those bytes twice. Sockets and pagefile traffic are not included, and this is why a download that is written to disk shows as a write only. Windows counters only.";
  const ioScale = h => Math.max(1e6, 1.25 * h.reduce((a, x) => Math.max(a, x.ioRead || 0, x.ioWrite || 0), 0));
  const ioPath = (h, field, max) => {
    const n = h.length;
    return h.map((x, i) => x.ioRead == null && x.ioWrite == null ? null
        : [n < 2 ? 100 : 100 * i / (n - 1), 100 - Math.min(100, 100 * (x[field] || 0) / max)])
      .filter(Boolean).map((pt, i) => (i ? 'L' : 'M') + pt[0].toFixed(2) + ' ' + pt[1].toFixed(2)).join(' ');
  };
  defineLens({
    id: key + '.io', scope: key, size: 'tile',
    name: name + ' I/O',
    description: "File read / write speed of " + name + "'s model process with a 5-minute history (one count per operation; sockets and pagefile traffic are not included).",
    markup: () => `
    <div class="tilebox" data-tile="` + p + 'io">' + lensHeadMarkup(name + ' I/O') + `
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
      const box = L.el.querySelector('[data-tile="' + p + 'io"]'); if (!box) return;
      box.querySelector('.ltitle').title = IO_TIP;
      const el = box.querySelector('.tile');
      if (SERVER_OS !== 'win32') {   // the counters come from PDH; the Linux / macOS path has no per-process I/O yet
        el.querySelector('.v').innerHTML = NA_HTML;
        el.querySelector('.sub').textContent = 'I/O stats: Windows only for now';
        return;
      }
      let r = d.process ? d.process.ioRead : null, w = d.process ? d.process.ioWrite : null, inactive = false;
      if (r == null && w == null) {                       // stale process - newest history point that has them
        for (let i = hist.length - 1; i >= 0; i--) if (hist[i].ioRead != null || hist[i].ioWrite != null) { r = hist[i].ioRead || 0; w = hist[i].ioWrite || 0; break; }
        inactive = true;
      }
      const tot = r == null && w == null ? null : (r || 0) + (w || 0);
      const max = ioScale(hist);
      el.querySelector('.v').innerHTML = tot == null ? NA_HTML : fmtRate(tot);
      const sub = 'Read ' + fmtRate(r) + ' · Write ' + fmtRate(w);
      el.querySelector('.sub').textContent = inactive ? 'Inactive · ' + sub : sub;
      el.querySelector('.sub').title = inactive ? 'No live process sample - the newest reading in the history' : IO_TIP;
      el.querySelector('.meter > div').style.width = (tot == null ? 0 : Math.max(0, Math.min(100, 100 * tot / max))) + '%';
      el.querySelector('.line:not(.wline)').setAttribute('d', ioPath(hist, 'ioRead', max));
      el.querySelector('.wline').setAttribute('d', ioPath(hist, 'ioWrite', max));
      el.querySelector('.spark').title = 'Top of the chart = ' + fmtRate(max);
    },
  });
  MIRROR_HOVER.push({ prefix: p + 'io', fn: (spark, f, guide, tip) => {   // read / write at that time, like the Disk tile
    if (!hist.length) return;
    const k = Math.max(0, Math.min(hist.length - 1, Math.round(f * (hist.length - 1)))), hs = hist[k];
    hoverAt(spark, f, guide, tip, hist, k, hs.ioRead == null && hs.ioWrite == null ? 'n/a'
      : 'R ' + fmtRate(hs.ioRead || 0) + ' · W ' + fmtRate(hs.ioWrite || 0));
  } });

  return {
    // The family's default layout tail (used by defineScopeLayout): per-card GPU + VRAM pairs after the scope's
    // own lenses (not on macOS — no per-process GPU there until 062), then the bottom row CPU · RAM (Working) ·
    // RAM (Committed) · I/O, on every OS (each tile shows its own honest state where a number cannot exist).
    layout: () => {
      const items = [];
      if (SERVER_OS !== 'darwin') {
        const d = (SOURCES[key] && SOURCES[key].data) || {};
        for (let i = 0; i < Math.max(1, (d.processCards || []).length); i++) {
          items.push({ lens: key + '.gpu', settings: { card: i, show: 'gpu' } });
          items.push({ lens: key + '.gpu', settings: { card: i, show: 'vram' } });
        }
      }
      items.push({ lens: key + '.cpu' });
      items.push({ lens: key + '.ram', settings: { show: 'working' } });
      items.push({ lens: key + '.ram', settings: { show: 'committed' } });
      items.push({ lens: key + '.io' });
      return items;
    },
  };
}

// Shared hover drawing for the mirror branches (guide line + tip re-indexed to the scope's own history, as the
// per-scope branches in hardware.js did before 077).
function hoverAt(spark, f, guide, tip, hist, k, text) {
  const x = hist.length < 2 ? 100 : 100 * k / (hist.length - 1);
  guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.style.display = '';
  tip.hidden = false; tip.style.left = x + '%';
  tip.textContent = text + ' · ' + new Date(hist[k].t).toLocaleTimeString();
}
