// AI_SCOPE-077: Hardware Mirror Lenses — the shared family of four lenses an app scope shows for its **own
// processes**: GPU / VRAM per card (AI_SCOPE-072), RAM Working / Committed (AI_SCOPE-073), CPU (AI_SCOPE-075)
// and file I/O (AI_SCOPE-076). Strata built them one ticket at a time in strata.js; defineMirror() lifts them
// into one source so every app scope gets the same tiles, rules and wording: quarter tiles in the Hardware tile
// style, 5-minute server-side history from procstats, hover from that history, Width on all, GPU with a card
// picker, RAM with Show (Working / Committed, each with its own ceiling), CPU with no settings, I/O without a
// disk picker (one number per process, not per drive) — and no Power / PCIe mirrors, which have no per-process
// equivalent. The spec for this family is ~/ai-scope-terminology.md ("Hardware Mirror Lenses"); it moved out of
// the release docs on 2026-10-29, so the old pointer to "the v0.4 tasks doc" was stale - fixed under 092.
// State rules, set by 077 REVIEW BATCH (user decisions, 2026-10-28), extended by 080, and re-axied by 092:
//   - **Time-mapped chart and hover**: x spans the samples actually held - oldest kept to newest - so points age out of
//     the left edge, the board is full at any pace, and the axis stays honest even when the app stopped producing samples.
//     Rings are sized in TIME (lens.js SPARK_WIN) plus one older sample at the left edge (092).
//   - **Stale sample => big value n/a** — no frozen last value ("that represents reality most closely").
//   - **App attested OFFLINE ('off') or IDLE — its own API says nothing is loaded ('idle') => procstats
//     writes explicit zero points** ("it really should be 0 when offline because it's offline"; an unloaded
//     model is likewise genuinely 0 — user, review batch 2), marked `attest`, painted as 0 with the sub line
//     worded "<App> Offline" / "No Model Loaded". **Model loaded but the process lookup missed (a hiccup)
//     => gap + n/a, never zeros** — that lone case stays "Inactive".
// Call defineMirror() after the scope's defineSource; the source payload must carry `process`,
// `processSupported`, `processHistory` and `processCards` (stratastats.js shape; the /api/bionic route adds them).

// Per-prefix hover handlers for the shared sparkline hover in hardware.js. Each mirror scope registers the
// prefix used by its tiles, so a Bionic tile hovers over Bionic's history, not Strata's (the pre-077
// branches read window.STRATA_PROC_HIST by name). The MIRROR_HOVER array itself lives in hardware.js (the
// hover handler is there, and classic scripts share one global lexical scope); mirror.js only fills it.

// AI_SCOPE-092: the window is sized in TIME but measured from the NEWEST sample rather than from the clock, so the
// axis spans the samples actually held: the board is full at any pace, and the line no longer slides leftward
// between polls. The ring is pruned the same way (lens.js sparkPrune), keeping one sample older than the window so
// the leftmost segment enters from the edge instead of starting partway in.
// AI_SCOPE-092: the axis, the window, the pace-relative break test, the path builders, the tile painter and the
// hover all live once in web/js/lens.js - SPARK_WIN, sparkWindow, sparkSegs, sparkPath, sparkTile, sparkHover. The
// window is sized in TIME but measured from the NEWEST sample rather than from the clock, so the board is full at
// any pace and the line no longer slides leftward between polls; the rings are pruned by lens.js sparkPrune, keeping
// one sample older than the window so the leftmost segment enters from the edge instead of partway in. (The first
// 092 build kept the family's old names - winPts, segsOf, segPath, areaOf, xAt, setTileTime, hoverTime, MWIN - as
// thin wrappers with "(unused)" apologies; they are gone, and every call site reads the shared names exactly as
// hardware.js already did. The 240-point safety cap that winPts carried now lives only on the ring, at the append.)
// The value rule (review batches): the live process sample wins; otherwise the newest point in the window
// ONLY if it is an attested zero (`attest: 'off' | 'idle'` — the app is gone, or reachable with nothing
// loaded, and really uses nothing) — those paint as 0 with the state worded in the sub line; a stale real
// reading is n/a + "Inactive" (the only remaining gap case is a lookup hiccup while a model IS loaded).
function liveOrOff(d, pts) {
  if (d.process) return { p: d.process, inactive: false, state: null };
  const last = pts.length ? pts[pts.length - 1] : null;
  if (last && last.attest) return { p: last, inactive: true, state: last.attest };
  return { p: null, inactive: true, state: null };
}

// One entry per app scope:
//   key   — the scope id; lens ids become <key>.gpu / .ram / .cpu / .io, so saved layouts address them directly
//   name  — display name in labels ("Bionic RAM (Committed)"; the tile CSS upper-cases)
//   letter — starts the four data-tile prefixes (<letter>gp / <letter>ram_ / <letter>cpu / <letter>io); one
//            letter per scope, distinct from every other scope's (077 uses 's' for Strata, 'b' for Bionic)
function defineMirror(spec) {
  const key = spec.key, name = spec.name, p = spec.letter;
  // The scope's process history, newest last — kept for the hover handlers (same role window.STRATA_PROC_HIST
  // had before 077; the global stays for debugging and for anything that already reads it).
  const hist = [];   // 084: never replaced, only appended to and trimmed - the array identity is what the global and the hover handlers read
  window[name.toUpperCase().replace(/[^A-Z0-9]/g, '') + '_PROC_HIST'] = hist;   // e.g. STRATA_PROC_HIST, BIONIC_PROC_HIST
  const cards = [];   // per-card { name, vramTotal } from the payload, for the GPU tile labels and the hover ceiling
  // AI_SCOPE-084 (item 7): the payload now carries only the points newer than what the page holds (web/js/lens.js
  // asks with &since=, the server slices its ring), so APPEND rather than replace - into the same array the global
  // above and the hover handlers read, trimmed to the window the sparkline shows. A whole-ring answer (the first
  // poll, after a failed one, or when a mirror lens is re-mounted in edit mode) lands the same way: the merge keeps
  // only points newer than the newest one held, so nothing doubles and nothing older than the ring is invented.
  subscribeSource(key, d => {
    const add = (d && d.processHistory) || [];
    if (add.length) {
      const last = hist.length ? hist[hist.length - 1].t : 0;
      for (const p of add) if (p && p.t > last) hist.push(p);
      sparkPrune(hist);                                          // 092: sized in TIME from the newest point, keeping the one sample older so the line enters from the edge
      if (hist.length > 240) hist.splice(0, hist.length - 240);  // a runaway-pace safety cap only, never the trimming rule
    }
    cards.length = 0; (d && d.processCards || []).forEach(c => cards.push(c));
  });
  // Sub-line wording for the attested states (review batch 2, the user's own words): offline / no model;
  // the lone remaining gap (hiccup while a model is loaded) stays "Inactive".
  // AI_SCOPE-080: the load window got its own words - the app's own status attests 'loading' /
  // 'unloading' / 'failed' (zero points marked with them), so "0 GB · No Model Loaded" during a load
  // becomes "0 GB · Loading…" until the load's own workers are measurable (Strata's tree watch, 080).
  const stateText = st => st === 'off' ? name + ' Offline' : st === 'idle' ? 'No Model Loaded'
    : st === 'loading' ? 'Loading\u2026' : st === 'unloading' ? 'Unloading\u2026'
    : st === 'failed' ? 'Load failed' : 'Inactive';
  const stateTitle = st => st === 'off' ? name + ' is offline - it uses nothing'
    : st === 'idle' ? 'No model loaded - nothing is running'
    : st === 'loading' ? 'A model load is in progress - 0 until the loading processes are measurable'
    : st === 'unloading' ? 'A model unload is in progress'
    : st === 'failed' ? "The app reports its model load failed - use the app's own screen for the error"
    : 'Model process not found right now - the app is online with a model loaded, this is a lookup gap';

  // ---------- GPU / VRAM per card (AI_SCOPE-072) ----------
  // One metric per tile (Show picks GPU usage or VRAM); a card picker because VRAM is per card. "Not available
  // on this system" where per-process GPU stats cannot exist (macOS; Linux AMD / Intel cards).
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
        sparkTile(box, null, NA_HTML, 'Not available on this system', []);
        return;
      }
      const pts = sparkWindow(hist);
      const total = card.vramTotal || 0;
      const pct = g => !g ? null : show === 'gpu' ? (g.util == null ? null : g.util) : (total ? 100 * g.vram / total : null);
      const segs = sparkSegs(pts, h => pct(h.gpus && h.gpus[i]));
      const c = liveOrOff(d, pts);
      const cur = c.p && c.p.gpus ? c.p.gpus[i] : null;
      const v = pct(cur);
      let big;
      if (show === 'gpu') big = cur && cur.util != null ? Math.round(cur.util) + '<small>%</small>' : NA_HTML;
      else big = cur && cur.vram != null ? GB(cur.vram) + (total ? '<small> / ' + GB(total) + ' GB</small>' : '<small> GB</small>') : NA_HTML;
      sparkTile(box, v, big, (c.inactive ? stateText(c.state) + ' · ' : '') + cardName, segs);
    },
  });
  MIRROR_HOVER.push({ prefix: p + 'gp', fn: (spark, f, guide, tip) => {   // GPU % or GB of the card total at that time
    const id = spark.closest('[data-tile]').dataset.tile;   // "<p>gp<card>_<show>"
    const rest = id.slice((p + 'gp').length), iCard = parseInt(rest, 10), show = rest.slice(-3);
    sparkHover(spark, f, guide, tip, sparkWindow(hist), hs => {
      const g = hs.gpus && hs.gpus[iCard], tot = cards[iCard];
      return show === 'gpu'
        ? (g && g.util != null ? g.util.toFixed(0) + '%' : 'n/a')
        : (g && g.vram != null ? GB(g.vram) + ' GB' + (tot && tot.vramTotal ? ' of ' + GB(tot.vramTotal) + ' GB' : '') : 'n/a');
    });
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
      const pts = sparkWindow(hist);
      const segs = sparkSegs(pts, h => pct2(h[k2]));
      const c = liveOrOff(d, pts);
      const cur = c.p ? c.p[k2] : null;
      const v = pct2(cur);
      const big = cur != null ? GB(cur) + (limit ? '<small> / ' + GB(limit) + ' GB</small>' : '<small> GB</small>') : NA_HTML;
      // Sub line: like the Hardware RAM tile ("% used"), naming what the percentage is taken of (OS-aware —
      // Linux / macOS report resident rather than a Windows working set, and macOS has no commit limit).
      const of = committed
        ? (hs.commitLimit ? 'of commit limit' + (SERVER_OS === 'linux' ? ' (RAM + swap)' : '') : 'of RAM (no commit limit here)')
        : 'of system RAM';
      sparkTile(box, v, big, c.inactive ? stateText(c.state) : (v == null ? 'detecting\u2026' : v.toFixed(0) + '% ' + of), segs);
    },
  });
  MIRROR_HOVER.push({ prefix: p + 'ram_', fn: (spark, f, guide, tip) => {   // working / committed GB at that time, against the right ceiling
    const id = spark.closest('[data-tile]').dataset.tile, committed = id === p + 'ram_committed';
    sparkHover(spark, f, guide, tip, sparkWindow(hist), hs => {
      const b = hs[committed ? 'ramPrivate' : 'ram'];
      const h = hwSampleAt(hs.t);   // 092: the ceiling comes from the Hardware sample nearest the hovered time, not from an index on another axis
      const lim = committed ? (h.commitLimit || h.ramTotal) : h.ramTotal;
      return b != null ? GB(b) + ' GB' + (lim ? ' of ' + GB(lim) + ' GB' : '') : 'n/a';
    });
  } });

  // ---------- CPU of the model process (AI_SCOPE-075) ----------
  // Mirrors the Hardware CPU tile's style (big "NN%", sub line names the machine, meter = the same %, sparkline
  // from history) but shows the app's own process numbers from procstats — one number for the whole PC, so there
  // is no card picker and no Show choice, only Width.
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
      const pts = sparkWindow(hist);
      const segs = sparkSegs(pts, h => h.cpu == null ? null : Math.min(100, h.cpu));
      const c = liveOrOff(d, pts);
      const v = c.p && c.p.cpu != null ? Math.min(100, c.p.cpu) : null;
      sparkTile(box, v, v == null ? NA_HTML : v.toFixed(0) + '<small>%</small>',
        c.inactive ? stateText(c.state) : (info.cpuModel || 'CPU') + ' · ' + (info.cores || '?') + ' threads', segs);
    },
  });
  MIRROR_HOVER.push({ prefix: p + 'cpu', fn: (spark, f, guide, tip) => {   // % of all cores at that time
    sparkHover(spark, f, guide, tip, sparkWindow(hist), hs => (hs.cpu != null ? Math.min(100, hs.cpu).toFixed(0) + '%' : 'n/a'));
  } });

  // ---------- File I/O of the model process (AI_SCOPE-076) ----------
  // Layout and style mirror the Hardware Disk tile (two lines: read solid, write dashed, same legend and
  // chart scaling), with two differences on purpose: no disk picker (per-process I/O counters are one number per
  // process, not per physical drive) and no "% active" (a device counter). Big value = read + write, so the sub
  // line and the two chart lines always show the split — a read-then-write flow (unpacking a model, a copy)
  // legitimately counts its bytes twice, which the split makes readable. Windows counters only for now.
  const IO_TIP = 'Bytes per second ' + name + "'s model process reads and writes. One count per operation: a flow that reads then writes (unpacking a model, copying) counts those bytes twice. Sockets and pagefile traffic are not included, and this is why a download that is written to disk shows as a write only. Windows counters only.";
  const ioSegs = (pts, field, max) => sparkSegs(pts, h => (h.ioRead == null && h.ioWrite == null) ? null : Math.min(100, 100 * (h[field] || 0) / max));
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
      <div class="spark-axis"><span></span><span class="dlegend"><i class="rd"></i>read <i class="wr"></i>write</span><span>now</span></div>
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
      const pts = sparkWindow(hist);
      const c = liveOrOff(d, pts);
      const r = c.p ? c.p.ioRead : null, w = c.p ? c.p.ioWrite : null;
      const tot = r == null && w == null ? null : (r || 0) + (w || 0);
      const max = Math.max(1e6, 1.25 * pts.reduce((a, x) => Math.max(a, x.ioRead || 0, x.ioWrite || 0), 0));   // window only: "top of the chart" is what you SEE
      el.querySelector('.v').innerHTML = tot == null ? NA_HTML : fmtRate(tot);
      const sub = 'Read ' + fmtRate(r) + ' · Write ' + fmtRate(w);
      el.querySelector('.sub').textContent = c.inactive ? stateText(c.state) + ' · ' + sub : sub;
      el.querySelector('.sub').title = c.inactive ? stateTitle(c.state) : IO_TIP;
      el.querySelector('.meter > div').style.width = (tot == null ? 0 : Math.max(0, Math.min(100, 100 * tot / max))) + '%';
      el.querySelector('.line:not(.wline)').setAttribute('d', sparkPath(ioSegs(pts, 'ioRead', max)));
      el.querySelector('.wline').setAttribute('d', sparkPath(ioSegs(pts, 'ioWrite', max)));
      el.querySelector('.spark').title = 'Top of the chart = ' + fmtRate(max);
    },
  });
  MIRROR_HOVER.push({ prefix: p + 'io', fn: (spark, f, guide, tip) => {   // read / write at that time, like the Disk tile
    sparkHover(spark, f, guide, tip, sparkWindow(hist), hs => hs.ioRead == null && hs.ioWrite == null ? 'n/a'
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
