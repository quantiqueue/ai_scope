// AI_SCOPE dashboard - lenses: the building blocks of scope pages (and of custom scopes, AI_SCOPE-003).
// A lens is one card/table of a scope (e.g. Strata's "Requests"). A lens definition can draw any number of
// independent copies into any container: each copy finds its parts by data-k inside its own element (no
// page-wide ids), keeps its own state and its own table pager. Copies showing the same scope share one
// data fetch (a "source"), so a scope page plus a custom scope still poll each endpoint once.
// Loaded right after core.js; the scope files define their sources and lenses with it.

// ---------- Sources: one poll per endpoint, shared by every subscriber ----------
// A scope usually has one source named like the scope ('strata'); a scope with several endpoints names the
// others 'scope.part' (e.g. 'bionic.models'). Polling stops while the scope is not installed.
const SOURCES = {};   // source id -> { id, scope, url, every, visibleOnly, subs, els, data, error, busy, timer, kick }
// visibleOnly: poll only while one of its lenses is on screen (a shown tab, window not minimized) - for endpoints that
// cost something to keep fresh, e.g. the Processes scope (the server samples all processes only while it's asked).
function defineSource(id, url, scope, every, visibleOnly) {
  SOURCES[id] = { id, scope: scope || id, url, every: every || 2000, visibleOnly: !!visibleOnly, subs: new Set(), els: new Map(), data: null, error: null };
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
  try { src.data = await (await fetch(src.url, { cache:'no-store' })).json(); src.error = null; }
  catch (e) { src.error = e; }
  src.busy = false;
  src.subs.forEach(fn => fn(src.data, src.error));
}
// fn(data, error) runs after every poll. el (optional): the lens element, for visibleOnly sources. Returns an unsubscribe function.
function subscribeSource(id, fn, el) {
  const src = SOURCES[id];
  src.subs.add(fn);
  src.els.set(fn, el || null);
  if (!src.timer) src.timer = setInterval(() => pollSource(src), src.every);
  if (!src.kick) src.kick = setTimeout(() => { src.kick = null; pollSource(src); }, 0);   // first poll right away (once for a batch of subscribers)
  return () => {
    src.subs.delete(fn);
    src.els.delete(fn);
    if (!src.subs.size) { clearInterval(src.timer); src.timer = null; }
  };
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

// "Current request" card (wide; ComfyUI: title "Current job"). The header tab always shows the title; the card's
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
