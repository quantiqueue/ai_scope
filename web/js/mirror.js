// AI_SCOPE-077: Hardware Mirror Lenses — the shared family of four lenses an app scope shows for its **own
// processes**: GPU / VRAM per card (AI_SCOPE-072), RAM Working / Committed (AI_SCOPE-073), CPU (AI_SCOPE-075)
// and file I/O (AI_SCOPE-076). Strata built them one ticket at a time in strata.js; defineMirror() lifts them
// into one source so every app scope gets the same tiles, rules and wording: quarter tiles in the Hardware tile
// style, 5-minute server-side history from procstats, hover from that history, Width on all, GPU with a card
// picker, RAM with Show (Working / Committed, each with its own ceiling), CPU with no settings, I/O without a
// disk picker (one number per process, not per drive) — and no PCIe mirror, which has no per-process equivalent.
// A GPU Power mirror exists since AI_SCOPE-122 but is OPT-IN per scope ({ power: true } in the spec; Strata
// first) - it shows 121's measured per-card apportionment (board watts x the family's share of that card),
// an estimate that wears ≈; TERMINOLOGY's mirror-family section was revised for it. The spec for this family
// is ~/ai-scope-terminology.md ("Hardware Mirror Lenses"); it moved out of the release docs on 2026-10-29, so
// the old pointer to "the v0.4 tasks doc" was stale - fixed under 092.
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
  // AI_SCOPE-121 D8: on an NVIDIA card the GPU % number is nvidia-smi's per-process SM utilisation (pmon), on
  // Windows too - the Windows GPU Engine counters this used to read are blind for CUDA work on a second card,
  // which is why a tile could say 0 % while the cost lens charged that card's full watts. The counters keep
  // supplying VRAM and shared memory (nvidia-smi gives no per-process memory figures on Windows) and the GPU %
  // for cards pmon cannot speak for. The tile says which, so a number that no longer matches Task Manager is
  // explained where it is read.
  const GPU_TIP = name + "'s share of one graphics card. GPU usage is per-process SM (shader) time from nvidia-smi - on Windows too, because Windows' own GPU counters, the ones Task Manager's GPU column uses, never report CUDA work on a second graphics card. Where nvidia-smi cannot speak for a card the counters stand instead, and then the number is Task Manager's busiest-engine measure. The two are different measurements, never mixed on one card. VRAM and shared memory always come from the counters (nvidia-smi reports no per-process memory on Windows).";
  defineLens({
    id: key + '.gpu', scope: key, size: 'tile',
    name: name + ' GPU',
    description: "One graphics card's GPU usage or VRAM used by " + name + "'s model process, with a 5-minute history. GPU usage is nvidia-smi's per-process SM time on an NVIDIA card (Windows included), the Windows GPU counters elsewhere.",
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
      box.querySelector('.ltitle').title = GPU_TIP;   // 121 D8: the tile says what its GPU % number is measured by
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

  // ---------- GPU Power per card (AI_SCOPE-122, opt-in: spec { power: true }) ----------
  // The GPU tile above says WHAT FRACTION of a card this app uses; this tile says what that fraction is worth
  // in watts - the very same per-card apportionment the cost math accrues (121 D7/D8: the card's live board
  // power x this family's share of that card's GPU usage), stamped onto the history point by pushHist as
  // gpus[i].w. One sample, one number: the watts here, the GPU % beside it and the cost lenses' money can
  // never come from different samples or different formulas. Board power is a DEVICE measurement, so this is
  // an ESTIMATE and wears ≈ on every face - the reason TERMINOLOGY kept Power out of this family until 122;
  // the user's decision to fold it in rests on the measured share, never an invented apportionment (072's
  // no-invented-numbers rule still decides the gaps: a used card whose watts cannot be computed reads n/a
  // for that moment; a card the family does not use reads 0 W).
  // "Separate, just like hardware, you can choose which card" (user, 2026-11-09 kickoff): the same card picker
  // as the GPU tile, and the default page gets one power tile per detected card. The state rules are the cost
  // face's (121 D1/D3): attested zero heartbeats read 0 W, fresh real points the apportioned watts, a stale
  // real reading n/a + "Inactive", and a card that reports no board power is n/a with the reason named.
  if (spec.power) {
    const POWER_TIP = name + "'s estimated power use on one graphics card: that card's live board watts × " + name + "'s share of the card's GPU usage — the very number the electric cost lenses accrue, so watts and money never disagree. Share of what, measured how: on an NVIDIA card both sides come from nvidia-smi's per-process SM (shader) time — " + name + "'s processes' SM % over the SM % of every process on that card, from one 1 Hz stream averaged over the moment being read. Where nvidia-smi cannot speak for a card (AMD / Intel, macOS, or that stream dying) the counters and the card's own device usage stand instead, and one card is never measured by both at once. Board power is a whole-device measurement, so this is an estimate and it wears ≈. A card the family is not using reads 0 W - idle base power belongs to nobody. Where a card the family IS using reports no board power, or no same-source total to divide by, the moment is n/a rather than guessed.";
    defineLens({
      id: key + '.power', scope: key, size: 'tile',
      name: name + ' GPU Power',
      description: "One graphics card's power use estimated for " + name + "'s processes, with a 5-minute history: the card's live watts × " + name + "'s share of that card's GPU usage. An estimate from a device measurement — it wears ≈.",
      settings: [
        { id:'card', label:'Graphics card', type:'gpu', default:0 },
      ],
      markup: st => tileHtml({ id: p + 'pw' + st.card,
        label: name + ' GPU Power' + (st.card ? ' ' + (st.card + 1) : '') }),
      render(L, d) {
        const i = L.settings.card;
        const box = L.el.querySelector('[data-tile="' + p + 'pw' + i + '"]'); if (!box) return;
        const num = cards.length > 1 ? ' ' + (i + 1) : '';
        const label = name + ' GPU Power' + num;   // "Strata GPU Power 2" with several cards, plain with one
        if (box.querySelector('.ltitle').textContent !== label) box.querySelector('.ltitle').textContent = label;
        box.querySelector('.ltitle').title = POWER_TIP;
        if (!d.processSupported) { sparkTile(box, null, NA_HTML, 'Not available on this system', []); return; }
        const card = cards[i] || {};
        const cardName = card.name || (cards.length ? 'GPU ' + (i + 1) + ' not found' : 'detecting…');
        const powered = card.source === 'nvidia' || card.source === 'amd';   // the cost lens' test: nvidia-smi / amdgpu report board watts, Windows' counters do not
        const pts = sparkWindow(hist);
        const watt = h => { const gp = h.gpus && h.gpus[i]; return gp && gp.w != null ? gp.w : null; };
        const maxW = Math.max(10, 1.25 * pts.reduce(function (a, x) { return Math.max(a, watt(x) || 0); }, 0));   // on-board only: "top of the chart" is what you SEE
        const segs = sparkSegs(pts, h => { const v = watt(h); return v == null ? null : Math.min(100, 100 * v / maxW); });
        // Value rule = the cost face (the family's): an attested zero point is an honest 0 W, a fresh real point
        // the apportioned watts, a stale real reading n/a + "Inactive". Absence of a number is not a number.
        const last = pts.length ? pts[pts.length - 1] : null;
        let v = null;
        if (last) {
          const w0 = watt(last);
          if (w0 != null && (last.attest || Date.now() - last.t <= Math.min(120000, Math.max(1500, 3 * (last.every || 2000))))) v = w0;
        }
        const big = !powered || v == null ? NA_HTML : '\u2248' + Math.round(v) + '<small> W</small>';
        let sub;
        if (!powered) sub = card.name ? cardName + ' · power not reported for this card' : 'detecting cards\u2026';
        else if (last && last.attest) sub = stateText(last.attest) + ' \u00b7 ' + cardName;
        else if (v != null) sub = cardName;
        else if (!last) sub = 'no GPU use in the last 5 min \u00b7 ' + cardName;
        else sub = 'Inactive \u00b7 ' + cardName;
        sparkTile(box, !powered || v == null ? null : Math.min(100, 100 * v / maxW), big, sub, segs);
        box.querySelector('.spark').title = 'Top of the chart = \u2248' + Math.round(maxW) + ' W (5-minute board max)';
      },
    });
    MIRROR_HOVER.push({ prefix: p + 'pw', fn: (spark, f, guide, tip) => {   // apportioned watts of that tile's card at that time
      const iCard = parseInt(spark.closest('[data-tile]').dataset.tile.slice((p + 'pw').length), 10);
      sparkHover(spark, f, guide, tip, sparkWindow(hist), hs => {
        const gp = hs.gpus && hs.gpus[iCard];
        return gp && gp.w != null ? '\u2248' + Math.round(gp.w) + ' W' : 'n/a';
      });
    } });
  }

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
      const rdSegs = ioSegs(pts, 'ioRead', max), wrSegs = ioSegs(pts, 'ioWrite', max);
      el.querySelector('.line:not(.wline)').setAttribute('d', sparkPath(rdSegs));
      el.querySelector('.wline').setAttribute('d', sparkPath(wrSegs));
      sparkCapsInto(el, rdSegs, wrSegs);   // edge caps (2026-11-01 rule)
      el.querySelector('.spark').title = 'Top of the chart = ' + fmtRate(max);
    },
  });
  MIRROR_HOVER.push({ prefix: p + 'io', fn: (spark, f, guide, tip) => {   // read / write at that time, like the Disk tile
    sparkHover(spark, f, guide, tip, sparkWindow(hist), hs => hs.ioRead == null && hs.ioWrite == null ? 'n/a'
      : 'R ' + fmtRate(hs.ioRead || 0) + ' · W ' + fmtRate(hs.ioWrite || 0));
  } });

  return {
    // The family's default layout tail (used by defineScopeLayout): per-card GPU + VRAM pairs (not on macOS —
    // no per-process GPU there until 062), then the CPU · RAM (Working) · RAM (Committed) · I/O row.
    // AI_SCOPE-107 (2026-11-04): the pairs row and the CPU row each start a row (row: true), matching the user's saved pages.
    layout: () => {
      const items = [];
      if (SERVER_OS !== 'darwin') {
        const d = (SOURCES[key] && SOURCES[key].data) || {};
        for (let i = 0; i < Math.max(1, (d.processCards || []).length); i++) {
          if (i === 0) items.push({ lens: key + '.gpu', settings: { card: i, show: 'gpu' }, row: true });
          else items.push({ lens: key + '.gpu', settings: { card: i, show: 'gpu' } });
          items.push({ lens: key + '.gpu', settings: { card: i, show: 'vram' } });
        }
      }
      items.push({ lens: key + '.cpu', row: true });
      items.push({ lens: key + '.ram', settings: { show: 'working' } });
      items.push({ lens: key + '.ram', settings: { show: 'committed' } });
      items.push({ lens: key + '.io' });
      return items;
    },
  };
}

// ---------- The GPU cost lens PAIR (AI_SCOPE-127; the shape AI_SCOPE-121 shipped for Strata) ----------
// defineGpuCost({ key, name, letter, stateWords, online, downSub, daysClause, daysShort, rangeTip, daysNumTip })
// builds <key>.costact (live hourly rate: big number, 5-minute board, meter, hover) and <key>.costtotal
// (range total: one number, Session start | Days with a cascaded days field, no chart), riding the scope's
// procstats family accrual (d.cost ring + session total, d.costDays per-day buckets) and the global $/kWh
// from Settings → General priced at DRAW time (D5) - the joules were measured regardless of the price.
// Everything here is an ESTIMATE (board power is a device measurement): every face wears ≈ and the tooltips
// name the formula (121 D7/D8). The energy rules - attested zeros read 0 W / ≈$0.00, a used card with no
// watts or no same-source denominator voids the moment to n/a, Days sums only rows that carry energy, and
// rows measured by a superseded formula count as nothing (D9) - are 121's, settled once for every scope;
// the per-scope arguments are only WORDING (state words, the offline sub, and how the Days range describes
// that app's request history - Strata sums its SAVED requests, Bionic sums the log rows AI_SCOPE measured
// this session). Strata's shipped lens ids, tile ids (scostact / scosttot), settings fields and strings are
// passed through verbatim; a scope opts in by calling this (127 does Bionic; 128-130 follow).
function defineGpuCost(spec) {
  const key = spec.key, name = spec.name, p = spec.letter;
  const CHIST = [];   // {t, every, w} - estimated watts attributed to this app's family, newest last
  let CT1 = Date.now();   // the board time of the last render (hover parity) - the 093 lesson
  subscribeSource(key, d => {
    const add = (d && d.cost && d.cost.hist) || [];
    if (add.length) {
      const last = CHIST.length ? CHIST[CHIST.length - 1].t : 0;
      for (const q of add) if (q && q.t > last) CHIST.push(q);
      sparkPrune(CHIST);
      if (CHIST.length > 240) CHIST.splice(0, CHIST.length - 240);
    }
  });
  const COST_STATE = spec.stateWords;   // the mirror tiles' state wording (080 vocabulary), in this app's words
  const COST_TIP = 'Active GPU Usage Cost: what a whole hour of GPU work at THIS moment would cost ' + name + '. Per card: the card\'s live power draw × ' + name + '\'s share of that card\'s GPU usage, summed over the cards — so a card that is also busy with something else is only charged for the part ' + name + ' is asking of it. Share of what, measured how: on an NVIDIA card both sides come from nvidia-smi\'s per-process SM (shader) time — ' + name + '\'s processes\' SM % over the SM % of every process on that card, from one 1 Hz stream averaged over the moment being priced. On Windows that replaces the GPU Engine performance counters Task Manager uses, which never report CUDA work on a second graphics card: on the machine this was measured on, a card drawing 60 W with ' + name + ' as the only process on it read 0 % there. Where nvidia-smi cannot speak for a card (AMD / Intel, macOS, or that stream dying) the counters\' numbers and the card\'s own device usage are used instead, and one card is never measured by both at once. Board power is a whole-device measurement, so this is an estimate and every face wears ≈. The chart is the same rate over the last five minutes. The price per kWh comes from Settings → General; the total spent is the other lens ("' + name + ' GPU Total Cost"). ' + name + ' holding a model resident on a card without using it is not charged — this prices work, not occupancy. Where a card ' + name + ' is using reports no power, or no same-source usage to divide by, nothing is recorded for that moment rather than guessed - the tile says so.';
  defineLens({
    id: key + '.costact', scope: key, size: 'tile',
    name: 'GPU Cost Activity',
    description: "Active GPU Usage Cost — the live hourly rate for " + name + "'s GPU work (each card's watts × " + name + "'s share of that card's GPU usage, measured per process by nvidia-smi on NVIDIA cards, priced at the Settings electricity rate), with the last five minutes of that rate.",
    markup: () => tileHtml({ id: p + 'costact', label: name + ' GPU Cost Activity' }),
    render(L, d) {
      const box = L.el.querySelector('[data-tile="' + p + 'costact"]'); if (!box) return;
      box.querySelector('.ltitle').title = COST_TIP;
      const price = kwhPrice();
      const now = Date.now(); CT1 = now;   // remember the board this render drew
      const pts = sparkFresh(CHIST);
      const maxW = Math.max(10, 1.25 * pts.reduce(function (a, x) { return Math.max(a, x.w || 0); }, 0));   // on-board only: "top of the chart" is what you SEE
      const clk = sparkClockSegs(CHIST, now, h => h.w == null ? null : Math.min(100, 100 * h.w / maxW));
      // Do these cards report board power at all? nvidia-smi (both OSes) and Linux's amdgpu sysfs do;
      // Windows' own GPU counters do not (the source field mirrors hwstats card.source, as the GPU tiles' do).
      const powered = (d.processCards || []).some(x => x.source === 'nvidia' || x.source === 'amd');
      const last = pts.length ? pts[pts.length - 1] : null;
      // The rate face follows the mirror family's value rule (077/080): an attested zero point is an honest 0
      // ("≈$0.00 /h · Offline", exactly like the GPU tiles' zeros - live or idle, the user asked);
      // a FRESH real point is the apportioned watts; a stale real point (a lookup hiccup while a model is
      // loaded) is n/a, never a false 0. Absence of a number is not a number.
      let rate = null;
      if (last) {
        if (last.attest) rate = 0;                         // attested zero heartbeat point (off / idle / …)
        else if (now - last.t <= Math.min(120000, Math.max(1500, 3 * (last.every || 2000))))   // 092 break window
          rate = last.w / 1000 * price;                    // wattage per hour = Wh/h
      }
      const big = !powered || rate == null ? NA_HTML : '\u2248' + fmtUsd(rate) + '<small> /h</small>';
      const meter = rate == null ? null : Math.min(100, 100 * last.w / maxW);
      let sub;
      if (!powered) sub = (d.processCards || []).length ? 'power not reported for these cards' : 'detecting cards\u2026';
      else if (!last) sub = spec.online(d) ? 'no GPU use in the last 5 min' : spec.downSub(d);
      else if (last.attest) sub = COST_STATE[last.attest] || 'Inactive';
      else if (rate == null) sub = 'Inactive';   // the newest point is a stale real reading
      else sub = Math.round(last.w) + ' W asked of the cards \u00b7 $' + price + '/kWh';
      sparkTile(box, meter, big, sub, clk.segs, clk.caps);
      box.querySelector('.spark').title = 'Top of the chart = \u2248' + fmtUsd(maxW / 1000 * price) + ' /h (5-minute board max)';
    },
  });
  MIRROR_HOVER.push({ prefix: p + 'costact', fn: (spark, f, guide, tip) => {   // nearest sample to the cursor's BOARD time: the rate at that moment
    sparkClockHover(spark, f, guide, tip, CHIST, hs => (hs.w != null
      ? '\u2248' + fmtUsd(hs.w / 1000 * kwhPrice()) + '/h \u00b7 ' + Math.round(hs.w) + ' W \u00b7 ' + new Date(hs.t).toLocaleTimeString()
      : 'n/a'), CT1);
  } });

  const TOTAL_TIP = 'Total electric cost of ' + name + '\'s GPU work over a range, from the same per-card estimate as the activity lens (each card\'s live power draw × ' + name + '\'s share of that card\'s GPU usage, summed — per-process usage measured by nvidia-smi on an NVIDIA card, the Windows GPU counters where it cannot speak): every face wears ≈ because board power is a whole-device measurement. Cost Range "Session start" is everything AI_SCOPE has measured since it booted, requests and GPU work between them alike. ' + spec.daysClause + ' Rows also count as nothing when their energy was measured by a superseded version of this formula: each saved figure carries which measurement produced it, so a corrected model never leaves the old numbers mixed into the total. Money is computed from the Settings → General price every time the tile draws, never stored, so a corrected price re-prices the whole range.';
  defineLens({
    id: key + '.costtotal', scope: key, size: 'tile',
    name: 'GPU Total Cost',
    description: "Total GPU electric cost over a range: since AI_SCOPE started, or " + spec.daysShort + ". One number, priced at the Settings electricity rate; no chart.",
    markup: () => '<div class="tilebox" data-tile="' + p + 'costtot">' + lensHeadMarkup(name + ' GPU Total Cost') +
      '<div class="tile bignum"><div class="v">\u2014</div><div class="sub">&nbsp;</div></div></div>',
    settings: [
      { id: 'costRange', label: 'Cost range', type: 'choice', default: 'session',
        options: [['session', 'Session start'], ['days', 'Days']],
        tip: spec.rangeTip },
      { id: 'days', label: 'Days', type: 'number', default: 30, min: 1, max: 365, cascade: true,
        when: cur => cur.costRange === 'days',
        tip: spec.daysNumTip },
    ],
    render(L, d) {
      const box = L.el.querySelector('[data-tile="' + p + 'costtot"]'); if (!box) return;
      box.querySelector('.ltitle').title = TOTAL_TIP;
      const price = kwhPrice();
      let ws = null, sub;
      if (L.settings.costRange === 'days') {
        const n = Math.max(1, Math.min(365, +L.settings.days || 30));
        const from = dayStart(Date.now()) - (n - 1) * 864e5;   // calendar days, today included
        const b = (d.costDays || []).filter(x => x.d >= from);
        const have = b.reduce(function (a, x) { return a + x.n; }, 0);
        const gone = b.reduce(function (a, x) { return a + (x.miss || 0); }, 0);
        if (!have && !gone) sub = 'no saved requests in the last ' + n + ' day' + (n > 1 ? 's' : '');
        else {
          if (have) ws = b.reduce(function (a, x) { return a + x.ws; }, 0);
          sub = (have ? fmtWh(ws) + ' \u00b7 ' : 'no energy recorded \u00b7 ') + have + ' of ' + (have + gone) +
            ' requests since ' + fmtDay(from);
        }
      } else {
        const c = d.cost;
        if (c) { ws = c.ws; sub = fmtWh(ws) + ' \u00b7 since AI_SCOPE started, ' + fmtWhen(c.t0); }
        else sub = spec.online(d) ? 'no GPU use recorded yet' : spec.downSub(d);
      }
      box.querySelector('.v').innerHTML = ws == null ? NA_HTML : '\u2248' + fmtUsd(ws / 3.6e6 * price);   // watt-seconds -> kWh: /3.6e6
      box.querySelector('.sub').textContent = sub;
    },
  });
}
