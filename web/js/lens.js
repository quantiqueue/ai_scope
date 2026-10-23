// AI_SCOPE dashboard - lenses: the building blocks of scope pages (and of custom scopes, AI_SCOPE-003).
// A lens is one card/table of a scope (e.g. Strata's "Requests"). A lens definition can draw any number of
// independent copies into any container: each copy finds its parts by data-k inside its own element (no
// page-wide ids), keeps its own state and its own table pager. Copies showing the same scope share one
// data fetch (a "source"), so a scope page plus a custom scope still poll each endpoint once.
// Loaded right after core.js; the scope files define their sources and lenses with it.

// ---------- Sources: one poll per endpoint, shared by every subscriber ----------
// A scope usually has one source named like the scope ('strata'); a scope with several endpoints names the
// others 'scope.part' (e.g. 'bionic.models'). Polling stops while the scope is not installed.
const SOURCES = {};   // source id -> { id, scope, url, every, subs, data, error, busy, timer, kick }
function defineSource(id, url, scope, every) {
  SOURCES[id] = { id, scope: scope || id, url, every: every || 2000, subs: new Set(), data: null, error: null };
}
async function pollSource(src) {
  if (src.busy || !src.subs.size || !isInstalled(src.scope)) return;
  src.busy = true;
  try { src.data = await (await fetch(src.url, { cache:'no-store' })).json(); src.error = null; }
  catch (e) { src.error = e; }
  src.busy = false;
  src.subs.forEach(fn => fn(src.data, src.error));
}
// fn(data, error) runs after every poll. Returns an unsubscribe function.
function subscribeSource(id, fn) {
  const src = SOURCES[id];
  src.subs.add(fn);
  if (!src.timer) src.timer = setInterval(() => pollSource(src), src.every);
  if (!src.kick) src.kick = setTimeout(() => { src.kick = null; pollSource(src); }, 0);   // first poll right away (once for a batch of subscribers)
  return () => {
    src.subs.delete(fn);
    if (!src.subs.size) { clearInterval(src.timer); src.timer = null; }
  };
}

// ---------- Lens definitions ----------
// def: { id ('strata.requests'), scope, source (default: the scope's own), name, description,
//        size ('tile' | 'wide' | 'full', or a function of the settings),
//        settings (optional schema: [{ id, label, type, default, options }] — values per lens copy, e.g. which GPU),
//        markup (HTML string, or a function of the settings; parts marked data-k="..."),
//        init(lens) (optional, once after mounting), render(lens, data) (every poll with fresh data) }
const LENSES = {};
function defineLens(def) { LENSES[def.id] = def; }
function lensesOf(scope) { return Object.values(LENSES).filter(d => d.scope === scope); }

// ---------- Lens instances ----------
let lensSeq = 0;
function mountLens(id, container, settings) {
  const def = LENSES[id];
  if (!def) return null;
  // settings: the lens's own values over the defaults of its settings schema
  const st = {};
  (def.settings || []).forEach(f => { st[f.id] = f.default; });
  Object.assign(st, settings || {});
  const el = document.createElement('div');
  el.className = 'lens lens-' + (typeof def.size === 'function' ? def.size(st) : def.size);
  el.dataset.lens = id;
  el.innerHTML = typeof def.markup === 'function' ? def.markup(st) : def.markup;
  container.appendChild(el);
  const lens = {
    def, el, settings: st, state: {}, data: null,
    key: id + '#' + (++lensSeq),                         // pager key: every copy pages on its own
    $: k => el.querySelector('[data-k="' + k + '"]'),
  };
  lens.redraw = () => { if (lens.data) def.render(lens, lens.data); };
  pagerReload[lens.key] = lens.redraw;
  if (def.init) def.init(lens);
  lens.unsub = subscribeSource(def.source || def.scope, (d, err) => { if (d && !err) { lens.data = d; def.render(lens, d); } });
  return lens;
}
function unmountLens(lens) {
  lens.unsub();
  delete pagerReload[lens.key];
  delete pages[lens.key];
  lens.el.remove();
}
// A scope's own page: its lenses, in the order given, inside the panel's [data-lenses] container.
function mountScopePage(scope, ids) {
  const box = document.querySelector('[data-panel="' + scope + '"] [data-lenses]');
  return ids.map(id => mountLens(id, box));
}

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
