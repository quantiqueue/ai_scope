// AI_SCOPE dashboard - lenses: the building blocks of scope pages (and of custom scopes, AI_SCOPE-003).
// A lens is one card/table of a scope (e.g. Strata's "Requests"). A lens definition can draw any number of
// independent copies into any container: each copy finds its parts by data-k inside its own element (no
// page-wide ids), keeps its own state and its own table pager. Copies showing the same scope share one
// data fetch (a "source"), so a scope page plus a custom scope still poll each endpoint once.
// Loaded right after core.js; the scope files define their sources and lenses with it.

// ---------- Sources: one poll per endpoint, shared by every subscriber ----------
// A scope usually has one source named like the scope ('strata'); a scope with several endpoints names the
// others 'scope.part' (e.g. 'bionic.models'). Polling stops while the scope is not installed.
const SOURCES = {};   // source id -> { id, scope, url, every, visibleOnly, deltaField, since, subs, els, data, error, busy, timer, kick }
// visibleOnly: poll only while one of its lenses is on screen (a shown tab, window not minimized) - for endpoints that
// cost something to keep fresh, e.g. the Processes scope (the server samples all processes only while it's asked).
// AI_SCOPE-084 (item 7) deltaField: name a field of the payload whose array the client already holds (the mirror
// family's processHistory ring, ~150 points). With it set, every poll after the first adds &since=<newest t seen>
// and the server answers with only the newer points - the first poll and any poll that follows a failed one ask
// for the whole ring, so a gap never has to be re-derived.
function defineSource(id, url, scope, every, visibleOnly, deltaField) {
  SOURCES[id] = { id, scope: scope || id, url, every: every || 2000, visibleOnly: !!visibleOnly, deltaField: deltaField || null, since: 0, subs: new Set(), els: new Map(), data: null, error: null };
}
function sourceSeen(src) {
  if (!src.visibleOnly) return true;
  if (document.hidden) return false;
  for (const el of src.els.values()) if (el && el.isConnected && el.offsetParent !== null) return true;
  return false;
}
async function pollSource(src) {
  if (src.busy || !src.subs.size || !isInstalled(src.scope) || !sourceSeen(src)) return;
  src.busy = true;
  let u = src.url;
  if (src.deltaField && src.since) u += (u.indexOf('?') >= 0 ? '&' : '?') + 'since=' + src.since;   // 084: only what came after
  try {
    const d = await (await fetch(u, { cache: 'no-store' })).json();
    src.data = d; src.error = null;
    // Remember the newest point we now hold. A poll that failed or was skipped while the tab was hidden asks for
    // the whole ring again (since = 0), so a gap is filled from the server instead of being re-derived.
    if (src.deltaField) { const a = d && d[src.deltaField]; if (Array.isArray(a)) for (const p of a) if (p && p.t > src.since) src.since = p.t; }
  }
  catch (e) { src.error = e; if (src.deltaField) src.since = 0; }
  src.busy = false;
  src.subs.forEach(fn => fn(src.data, src.error));
}
// fn(data, error) runs after every poll. el (optional): the lens element, for visibleOnly sources. Returns an unsubscribe function.
function subscribeSource(id, fn, el) {
  const src = SOURCES[id];
  src.subs.add(fn);
  src.els.set(fn, el || null);
  if (!src.timer) {
    if (src.deltaField) src.since = 0;   // 084: the first poll for a (re)mounted lens carries the whole ring
    src.timer = setInterval(() => pollSource(src), src.every);
  }
  if (!src.kick) src.kick = setTimeout(() => { src.kick = null; pollSource(src); }, 0);   // first poll right away (once for a batch of subscribers)
  return () => {
    src.subs.delete(fn);
    src.els.delete(fn);
    if (!src.subs.size) { clearInterval(src.timer); src.timer = null; }
  };
}

// ---------- Sparkline time axis (AI_SCOPE-092: one rule for every lens) ----------
// x is mapped across the span of the samples actually held - oldest kept to newest - so the board is full whatever
// the pace is and the line never slides leftward between polls. The right edge is the NEWEST SAMPLE; the tile meta
// lines print that sample's own clock time, so the age is never hidden. A line BREAKS where the wait between two
// samples was far longer than the pace owed then, instead of drawing a straight lie across the hole or compressing it.
// The interval comes from each point's own `every` stamp (the server writes it when the sample is taken) - never
// from today's setting, or old segments would re-break every time someone changes the pace. Points with no stamp
// fall back to the series' own typical spacing.
const SPARK_WIN = 300000;                    // the history a sparkline keeps, sized in TIME (5 minutes), not in samples
const GAP_MIN_MS = 1500;                     // a jittery fast pace (2.0-2.9 s samples) must never break a line...
const GAP_MAX_MS = 120000;                   // ...and a stalled or dead sampler must always look like a hole
const spTime = p => (p && (p.t != null ? p.t : p.at)) || 0;      // hardware / procstats points carry .t, process samples .at
function sparkPrune(a, winMs) {              // keep everything newer than (newest - window), PLUS the one sample older
  const w = winMs || SPARK_WIN;              // than that, so the leftmost segment enters from the edge of the board
  if (!Array.isArray(a)) return [];          // a lens whose source has not answered yet must not take the render down
  while (a.length > 1 && spTime(a[1]) < spTime(a[a.length - 1]) - w) a.shift();
  return a;
}
function sparkWindow(a, winMs) { return sparkPrune(Array.isArray(a) ? a.slice() : [], winMs); }   // the same slice, without touching the caller's ring
// The render/hover cut for the 093 quartet (gate-sampled rings): points inside the last SPARK_WIN of the WALL
// CLOCK. (sparkPrune anchors to the newest point, so a burst that stopped being fed stayed the "newest" thing
// and sat on the board forever - user, 2026-11-01. The always-on tiles get clock freshness for free because
// they sample every cycle.) Since the clock-board revision this helper serves the y-scale inputs (window max)
// and the hover filter; the line itself is painted by sparkClockSegs, which boards the same window.
function sparkFresh(a, winMs) {
  const cut = Date.now() - (winMs || SPARK_WIN);
  return (Array.isArray(a) ? a : []).filter(function (p) { return spTime(p) >= cut; });
}
const sparkRange = a => (a && a.length) ? { t0: spTime(a[0]), t1: spTime(a[a.length - 1]) } : null;
const sparkX = (t, r) => r.t1 > r.t0 ? 100 * (t - r.t0) / (r.t1 - r.t0) : 100;
function sparkMed(a) {                        // typical spacing of a series - the fallback when its points carry no stamp
  const d = []; for (let i = 1; i < a.length; i++) d.push(spTime(a[i]) - spTime(a[i - 1]));
  if (!d.length) return SPARK_WIN / 150;
  d.sort((x, y) => x - y); return d[d.length >> 1];
}
function sparkBreaks(a, b, med) {             // is the gap between two consecutive samples a hole?
  const ea = a.every || med, eb = b.every || med;
  const base = ea !== eb ? Math.max(ea, eb) : ea;   // the pace changed across this boundary: a slowdown that was asked
  return spTime(b) - spTime(a) > Math.min(GAP_MAX_MS, Math.max(GAP_MIN_MS, 3 * base));   // for (091), not a dropout
}
function sparkSegs(pts, yOf) {                // -> one polyline per run of points: [ [x, y], ... ] (y in percent, 0-100)
  if (!pts || pts.length < 1) return [];
  const med = sparkMed(pts), r = sparkRange(pts), segs = []; let cur = [];
  for (let i = 0; i < pts.length; i++) {
    let y = null; try { y = yOf(pts[i]); } catch (e) { y = null; }
    if (y == null) { if (cur.length) { segs.push(cur); cur = []; } continue; }
    if (cur.length && sparkBreaks(pts[i - 1], pts[i], med)) { segs.push(cur); cur = []; }
    cur.push([sparkX(spTime(pts[i]), r), 100 - Math.max(0, Math.min(100, y))]);   // the SVG is flipped: 0 = top
  }
  if (cur.length) segs.push(cur);
  return segs;
}
const sparkPath = segs => segs.map(s => s.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join('')).join('');
const sparkArea = segs => segs.filter(s => s.length).map(s => sparkPath([s]) + ' L' + s[s.length - 1][0].toFixed(2) + ' 100 L' + s[0][0].toFixed(2) + ' 100 Z').join('');
// ---------- Edge caps: the border a segment end wears where it faces N/A (AI_SCOPE-097) ----------
// A segment end that stops in the MIDDLE of the board faces an honest N/A hole: the line broke there, so
// the run CLOSES with a border from that point down to the baseline, painted in the SAME stroke as its
// series (accent, or the amber-dashed wline style for the write / tx line). A one-sample breakless tick
// becomes a visible thin bar (it IS one real measurement). Ends that sit at the board's own left/right
// edges are NOT bordered (user, 2026-11-01): there the window merely cut a continuing series - a border
// would claim the run ended when the data did not. Pure string helper; sparkCapsInto applies it:
// primary list -> path.caps (under the first line), optional second list -> path.caps.wline.
const sparkCaps = segs => (segs || []).filter(s => s && s.length).map(s => {
  const cap = p => 'M' + p[0].toFixed(2) + ' 100 L' + p[0].toFixed(2) + ' ' + p[1].toFixed(2);
  const interior = x => x > 1e-6 && x < 100 - 1e-6;
  if (s.length === 1) return interior(s[0][0]) ? cap(s[0]) + cap(s[0]) : '';   // a lone sample: bar only away from the edges
  let d = '';
  if (interior(s[0][0])) d += cap(s[0]);                                        // left end faces a hole
  if (interior(s[s.length - 1][0])) d += cap(s[s.length - 1]);                  // right end faces a hole
  return d;
}).join('');
function sparkCapsInto(el, segs, wSegs, capsOverride) {   // el: anything holding the spark svg (.tile or .tilebox)
  const NS = 'http://www.w3.org/2000/svg';
  // The SPARK svg, never a header icon svg (a 24x24 icon once swallowed this search): prefer the .spark box.
  const svg = el && el.querySelector ? (el.querySelector('.spark svg') || el.querySelector('svg')) : null; if (!svg) return;
  const mk = cls => { const p = document.createElementNS(NS, 'path'); p.setAttribute('class', cls); return p; };
  const put = (cls, before, d) => {
    let cp = svg.querySelector('path.' + cls.replace(' ', '.'));
    if (!cp) { cp = mk(cls); const ref = svg.querySelector(before); if (!ref) return; ref.parentNode.insertBefore(cp, ref); }
    cp.setAttribute('d', d);
  };
  put('caps', 'path.line', capsOverride !== undefined ? capsOverride : sparkCaps(segs));
  if (wSegs) put('caps wline', 'path.wline', sparkCaps(wSegs));
  else { const cw = svg.querySelector('path.caps.wline'); if (cw) cw.setAttribute('d', ''); }
}
// ---------- The clock board (AI_SCOPE-093 quartet, user 2026-11-01 17:50) ----------
// "render data points within the scope of 5 minutes. It should shift left for every refresh." The board is the
// last SPARK_WIN of the WALL CLOCK: x=0 is (now - 5 min), x=100 is now, so every 2 s payload slides the data one
// pace left and points age off the left edge on their own - the newest-anchored stretch kept the board standing
// still. These rings are sampled only while their gate is open, so "an N/A occurs on refresh" = a poll produced
// no sample: detected when the wait since the PREVIOUS sampled point exceeds that point's own pace stamp (+ a
// 1 s jitter slack). The line breaks there, and BOTH faces of every such hole get an edge border (097, drawn in
// the series' own stroke) - a lone sample between holes renders as a bordered bar. Off-board neighbours decide
// the left faces: a run that merely enters the board (its predecessor was consecutive) wears no border - the
// window cut a living series; it did not run out. The newest run's right face borders when the LATEST refresh
// produced nothing (its last point is more than a slack behind the board's now edge).
// Returns { segs, caps } in the sparkSegs conventions so sparkPath / sparkArea serve unchanged.
const SPARK_NA_SLACK = 1000;
function sparkClockSegs(ring, t1, yOf, winMs) {
  const w = winMs || SPARK_WIN, t0 = t1 - w, a = Array.isArray(ring) ? ring : [];
  const P = [];
  let prev = null;
  for (let i = 0; i < a.length; i++) {
    const p = a[i], t = spTime(p);
    let y = null; try { y = yOf(p); } catch (e) { y = null; }
    if (y == null) { prev = p; continue; }                                   // valueless point: an N/A, never plotted
    if (t < t0) { prev = p; continue; }                                      // off-board: it still informs the left faces
    const gap = prev ? t - spTime(prev) : t - t0;
    const raw = prev ? prev.every : p.every;   // event lenses stamp every: 0 (an event IS the only non-N/A refresh) - null falls back to 2 s
    const base = (raw == null ? 2000 : raw) + SPARK_NA_SLACK;   // the wait expected across that gap
    P.push({ x: Math.max(0, Math.min(100, 100 * (t - t0) / w)),
             y: 100 - Math.max(0, Math.min(100, y)), t: t, capL: gap > base });
    prev = p;
  }
  const runs = [];
  for (const q of P) { if (!runs.length || q.capL) runs.push([q]); else runs[runs.length - 1].push(q); }
  const segs = runs.map(r => r.map(q => [q.x, q.y]));
  const cap = q => 'M' + q[0].toFixed(2) + ' 100 L' + q[0].toFixed(2) + ' ' + q[1].toFixed(2);
  const capD = [];
  for (let k = 0; k < runs.length; k++) {
    if (runs[k][0].capL) capD.push(cap(segs[k][0]));
    const last = runs[k][runs[k].length - 1];
    // right face: an interior hole (the next run starts broken) - or, for the newest run, the latest refresh was N/A.
    const rightHole = k + 1 < runs.length ? runs[k + 1][0].capL : t1 - last.t > SPARK_NA_SLACK;
    if (rightHole) capD.push(cap(segs[k][segs[k].length - 1]));
  }
  return { segs: segs, caps: capD.join('') };
}
// Hover on a clock board: the cursor's fraction maps to the BOARD's time (t0 + f*w); snap the guide to the
// nearest SAMPLE on the board and print that sample's own time - the shared sparkHover times the RING, which
// was the stretched-window assumption. textOf(point) builds the tip.
function sparkClockHover(spark, f, guide, tip, ring, textOf, t1, winMs) {
  if (!(t1 > 0)) t1 = Date.now();   // NaN-proof board edge: an omitted t1 used to park every tip at left: NaN% (invalid -> container's left edge)
  const w = winMs || SPARK_WIN, t0 = t1 - w, tc = t0 + f * w;
  const a = Array.isArray(ring) ? ring : [];
  let best = null;
  for (const p of a) {
    const t = spTime(p);
    if (t < t0 || t > t1) continue;
    if (!best || Math.abs(t - tc) < Math.abs(spTime(best) - tc)) best = p;
  }
  if (!best) return;
  const x = Math.max(0, Math.min(100, 100 * (spTime(best) - t0) / w));
  guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.style.display = '';
  tip.hidden = false; tip.style.left = x + '%';
  tip.textContent = textOf(best);
}
// Draw a tile's value, sub line, meter and time-mapped lines (the one tile painter for Hardware and the mirrors).
// capsOverride: precomputed caps string (the clock-board lenses paint adjacency-decided borders, not interior ones).
function sparkTile(el, value, big, sub, segs, capsOverride) {
  if (!el) return;
  el.querySelector('.v').innerHTML = big;
  el.querySelector('.sub').textContent = sub;
  el.querySelector('.sub').title = sub;
  el.querySelector('.meter > div').style.width = (value == null ? 0 : Math.max(0, Math.min(100, value))) + '%';
  el.querySelector('.line').setAttribute('d', sparkPath(segs));
  el.querySelector('.area').setAttribute('d', sparkArea(segs));
  sparkCapsInto(el, segs, null, capsOverride);   // edge caps: every spark tile closes its runs (2026-11-01 rule)
}
// Hover on a time-mapped line: the guide and tip sit at the CURSOR time; the value comes from the nearest sample
// in that series, within about two of its own intervals (and never closer than 4 s, never further than 60 s).
function sparkHover(spark, f, guide, tip, pts, textOf) {
  const r = sparkRange(pts); if (!r) return;
  const tc = r.t0 + f * (r.t1 - r.t0);
  let best = null;
  for (let i = 0; i < pts.length; i++) if (!best || Math.abs(spTime(pts[i]) - tc) < Math.abs(spTime(best) - tc)) best = pts[i];
  const tol = best ? Math.min(60000, Math.max(4000, 2 * (best.every || sparkMed(pts)))) : 4000;
  const x = 100 * f;
  guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.style.display = '';
  tip.hidden = false; tip.style.left = x + '%';
  tip.textContent = (best && Math.abs(spTime(best) - tc) <= tol ? textOf(best) : 'n/a') + ' · ' + new Date(tc).toLocaleTimeString();
}

// ---------- Lens definitions ----------
// def: { id ('strata.requests'), scope, source (default: the scope's own), name, description,
//        size ('tile' | 'wide' | 'full', or a function of the settings),
//        settings (optional schema: [{ id, label, type, default, options, when }] — values per lens copy, e.g. which GPU;
//                  when() = false hides the field, e.g. a Windows-only option elsewhere),
//        markup (HTML string, or a function of the settings; parts marked data-k="..."),
//        init(lens) (optional, once after mounting), render(lens, data) (every poll with fresh data) }
const LENSES = {};
function defineLens(def) {
  // Table lenses (AI_SCOPE-020): their column headers, for the Columns setting (show / hide; the first always shows)
  if (def.columns == null && typeof def.markup === 'string' && def.markup.indexOf('<thead') >= 0) {
    const t = document.createElement('template');
    t.innerHTML = def.markup;
    const ths = t.content.querySelectorAll('thead th');
    def.columns = [...ths].map(th => th.textContent.replace(/\s+/g, ' ').trim() || '(no title)');
  }
  LENSES[def.id] = def;
}
function lensesOf(scope) { return Object.values(LENSES).filter(d => d.scope === scope); }

// A tab switch or the window coming back: poll the visibleOnly sources right away instead of at their next tick.
function kickVisibleSources() {
  Object.values(SOURCES).forEach(src => { if (src.visibleOnly && src.subs.size) setTimeout(() => pollSource(src), 0); });
}
window.addEventListener('hashchange', kickVisibleSources);
document.addEventListener('visibilitychange', () => { if (!document.hidden) kickVisibleSources(); });

// ---------- Lens instances ----------
// Gear icon: the lens settings button in edit mode (layout.js) and the settings dialog's title.
const GEAR_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
// Width of a lens copy (AI_SCOPE-020): every lens has a Width setting - Quarter / Half / Full of the 4-column grid
// ('tile' / 'wide' / 'full'); without one it keeps the lens's own size (def.size, which may depend on its settings).
const LENS_WIDTHS = [['tile', 'Quarter'], ['wide', 'Half'], ['full', 'Full']];
function naturalWidth(def, st) { return typeof def.size === 'function' ? def.size(st) : def.size; }
function lensWidth(def, st) { return st && LENS_WIDTHS.some(w => w[0] === st.width) ? st.width : naturalWidth(def, st || {}); }

// Rows per page of the request / run / installed-model tables (AI_SCOPE-020): 5 unless changed with the lens's cog.
const PER_PAGE_FIELD = { id: 'perPage', label: 'Rows per page', type: 'number', default: 5, min: 1, max: 500 };

// Hidden table columns of a lens copy (settings.cols = "2,5": 1-based column numbers; the first can't be hidden).
// A <style> inside the lens hides those cells in every row, so the lens's own render code doesn't need to know.
let colSeq = 0;
function hideColumns(el, cols) {
  const nums = String(cols || '').split(',').map(Number).filter(n => n > 1);
  if (!nums.length) return;
  const cls = 'lcols' + (++colSeq);
  el.classList.add(cls);
  const style = document.createElement('style');
  style.textContent = nums.map(n => '.' + cls + ' th:nth-child(' + n + '), .' + cls + ' td:nth-child(' + n + ')').join(', ') + ' { display:none; }';
  el.appendChild(style);
}

let lensSeq = 0;
function mountLens(id, container, settings) {
  const def = LENSES[id];
  if (!def) return null;
  // settings: the lens's own values over the defaults of its settings schema
  const st = {};
  (def.settings || []).forEach(f => { st[f.id] = f.default; });
  Object.assign(st, settings || {});
  const el = document.createElement('div');
  el.className = 'lens lens-' + lensWidth(def, st);
  el.dataset.lens = id;
  el.innerHTML = typeof def.markup === 'function' ? def.markup(st) : def.markup;
  container.appendChild(el);
  hideColumns(el, st.cols);
  const lens = {
    def, el, settings: st, state: {}, data: null,
    key: id + '#' + (++lensSeq),                         // pager key: every copy pages on its own
    $: k => el.querySelector('[data-k="' + k + '"]'),
  };
  lens.redraw = () => { if (lens.data) def.render(lens, lens.data); };
  pagerReload[lens.key] = lens.redraw;
  if (def.init) def.init(lens);
  lens.unsub = subscribeSource(def.source || def.scope, (d, err) => { if (d && !err) { lens.data = d; def.render(lens, d); } }, el);
  return lens;
}
function unmountLens(lens) {
  lens.unsub();
  delete pagerReload[lens.key];
  delete pages[lens.key];
  lens.el.remove();
}
// A scope page's default layout (AI_SCOPE-020): fn() returns the lens list [{ lens, settings, row? }] shown until the
// page is edited and saved (scope-layouts.json). It may depend on what's detected (e.g. one GPU lens per card), so it is
// asked again when the hardware info changes. layout.js draws the pages and their edit mode.
const SCOPE_DEFAULTS = {};
function defineScopeLayout(scope, fn) { SCOPE_DEFAULTS[scope] = fn; }
// Shorthand: lens ids -> layout items
const layoutOf = ids => ids.map(id => typeof id === 'string' ? { lens: id, settings: {} } : id);

// ---------- Shared building blocks (markup) ----------
// The LLM scopes (Strata, Ollama, Bionic, later llama.cpp) and ComfyUI draw the same kinds of cards;
// these build their markup so every lens looks alike. Parts are marked data-k for lens.$().

// Lens header (every lens): a tab docked to the top edge of the lens card with the lens title; on custom scopes
// custom.js adds the scope chip (logo + name) to the tab. extra = HTML on the same line after the tab (hints, buttons).
function lensHeadMarkup(title, extra) {
  return '<div class="lhead"><span class="ltab"><span class="ltitle">' + title + '</span></span>' + (extra || '') + '</div>';
}

// "Current request" card (wide; ComfyUI: title "Current run"). The header tab always shows the title; the card's
// first line shows the state (dot + "Idle — no request running" / "Strata is not running" / …). boxes after "Model": { box, label, labelK, k, small, bar }
//   box = data-k of the whole box (to hide it), labelK = data-k of the label (when it changes), bar = data-k of a progress bar.
function nowCardMarkup(boxes, title) {
  const box = b => '\n        <div' + (b.box ? ' data-k="' + b.box + '"' : '') + '><div class="k"' + (b.labelK ? ' data-k="' + b.labelK + '"' : '') + '>' + b.label + '</div>' +
    '<div class="v' + (b.small ? ' small' : '') + '" data-k="' + b.k + '">—</div>' +
    (b.bar ? '\n          <div class="pbar"><div data-k="' + b.bar + '"></div></div>' : '') + '</div>';
  return `
    ` + lensHeadMarkup(title || 'Current request') + `
    <div class="card now">
      <div class="now-label"><span class="dot" data-k="dot"></span><span data-k="title">` + (title || 'Current request') + `</span><span class="now-detail" data-k="detail"></span></div>
      <div class="now-grid">
        <div><div class="k">Model</div><div class="v model" data-k="model">—</div></div>` + boxes.map(box).join('') + `
      </div>
      <div class="sysload" data-k="load" hidden><span class="sl-label" title="Whole-computer totals (all apps together), not only this request">System load</span><span class="sl-items"></span></div>
      <div class="countdown" data-k="foot">&nbsp;</div>
    </div>`;
}
// Table lens (full width): heading + card with a table (+ empty-state box) (+ pager).
//   o = { title, hint (static HTML; '' = none; default an empty data-k="hint"), headExtra (HTML after the hint, e.g. a ? button),
//         before (HTML at the top of the card, above the table: filter chips, help box), cols ([header HTML]), foot (HTML under the table;
//         default an empty-state box data-k="empty"), pager (bool) }
function tableLensMarkup(o) {
  return `
    ` + lensHeadMarkup(o.title, (o.hint === '' ? '' : o.hint != null ? o.hint : '<span class="hint" data-k="hint"></span>') + (o.headExtra || '')) + `
    <div class="card">` + (o.before || '') + `
      <table>
        <thead><tr>` + o.cols.map(c => '<th>' + c + '</th>').join('') + `</tr></thead>
        <tbody data-k="rows"></tbody>
      </table>` + (o.foot != null ? o.foot : '\n      <div class="hintbox" data-k="empty" hidden></div>') + `
    </div>` + (o.pager ? '\n    <div class="pager" data-k="pager" hidden></div>' : '');
}
// Rows that arrived since the previous poll get class "new" (highlight); the first draw marks none.
function isNewRow(L, key) {
  const st = L.state;
  if (!st.seen) st.seen = new Set();
  if (st.first === undefined) st.first = true;
  const isNew = !st.first && !st.seen.has(key);
  st.seen.add(key);
  return isNew;
}
function rowsDrawn(L) { L.state.first = false; }   // call at the end of every render
