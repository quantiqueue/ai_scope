// AI_SCOPE dashboard - lenses: the building blocks of scope pages (and of custom scopes, AI_SCOPE-003).
// A lens is one card/table of a scope (e.g. Strata's "Requests"). A lens definition can draw any number of
// independent copies into any container: each copy finds its parts by data-k inside its own element (no
// page-wide ids), keeps its own state and its own table pager. Copies showing the same scope share one
// data fetch (a "source"), so a scope page plus a custom scope still poll each endpoint once.
// Loaded right after core.js; the scope files define their sources and lenses with it.

// ---------- Sources: one poll per scope, shared by every subscriber ----------
const SOURCES = {};   // scope id -> { scope, url, every, subs, data, error, busy, timer, kick }
function defineSource(scope, url, every) {
  SOURCES[scope] = { scope, url, every: every || 2000, subs: new Set(), data: null, error: null };
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
function subscribeSource(scope, fn) {
  const src = SOURCES[scope];
  src.subs.add(fn);
  if (!src.timer) src.timer = setInterval(() => pollSource(src), src.every);
  if (!src.kick) src.kick = setTimeout(() => { src.kick = null; pollSource(src); }, 0);   // first poll right away (once for a batch of subscribers)
  return () => {
    src.subs.delete(fn);
    if (!src.subs.size) { clearInterval(src.timer); src.timer = null; }
  };
}

// ---------- Lens definitions ----------
// def: { id ('strata.requests'), scope, name, description, size ('tile' | 'wide' | 'full'),
//        settings (optional schema, for later), markup (HTML string, parts marked data-k="..."),
//        init(lens) (optional, once after mounting), render(lens, data) (every poll with fresh data) }
const LENSES = {};
function defineLens(def) { LENSES[def.id] = def; }
function lensesOf(scope) { return Object.values(LENSES).filter(d => d.scope === scope); }

// ---------- Lens instances ----------
let lensSeq = 0;
function mountLens(id, container, settings) {
  const def = LENSES[id];
  if (!def) return null;
  const el = document.createElement('div');
  el.className = 'lens lens-' + def.size;
  el.dataset.lens = id;
  el.innerHTML = def.markup;
  container.appendChild(el);
  const lens = {
    def, el, settings: settings || {}, state: {}, data: null,
    key: id + '#' + (++lensSeq),                         // pager key: every copy pages on its own
    $: k => el.querySelector('[data-k="' + k + '"]'),
  };
  lens.redraw = () => { if (lens.data) def.render(lens, lens.data); };
  pagerReload[lens.key] = lens.redraw;
  if (def.init) def.init(lens);
  lens.unsub = subscribeSource(def.scope, (d, err) => { if (d && !err) { lens.data = d; def.render(lens, d); } });
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
