// AI_SCOPE dashboard - the shell: tabs, theme, Home page, Scopes gallery (install/remove), dev reload.
// Loaded last. Stopping AI_SCOPE lives in the Settings dialog only - the Scopes page has no stop button (user, 2026-10-27).

// ---------- Scopes & tabs ----------
// The list of scopes comes from scopes.json (see SCOPES at the top). Each installed scope = one tab +
// a <section class="panel" data-panel="id">; a scope without its own section gets a placeholder page.
function ensurePanel(sc) {
  if (document.querySelector('.panel[data-panel="' + sc.id + '"]')) return;
  const sec = document.createElement('section');
  sec.className = 'panel'; sec.dataset.panel = sc.id; sec.hidden = true;
  sec.innerHTML = '<div class="section-head"><h1>' + escH(sc.name) + '</h1></div>' +
    '<div class="wrap"><div class="card hintbox">This scope has no page yet (add a <code>&lt;section class=&quot;panel&quot; data-panel=&quot;' +
    escH(sc.id) + '&quot;&gt;</code> to web/index.html).</div></div>';
  document.body.insertBefore(sec, document.body.querySelector('script'));
}
SCOPES.forEach(ensurePanel);

const DEFAULT_SCOPE = 'bionic';
const installedIds = () => SCOPES.filter(x => x.installed).map(x => x.id).concat(CUSTOM.map(c => c.id));   // + custom scopes
// AI_SCOPE-010 (General -> Default Scope): which page a bare address opens ('home' unless a scope is chosen).
// The value is inlined into the page by the server and refreshed when the setting changes; a removed scope
// falls back to Home. This is not DEFAULT_SCOPE below, which is the tab shown when a hash names a closed scope.
function landingScope() {
  const v = (window.AI_SCOPE_SETTINGS || {}).landing || 'home';
  return v === 'home' || canOpen(v) ? v : 'home';
}
// AI_SCOPE-022: the SYSTEM scope is now "hardware" - rename it in this browser's saved tabs, and follow old #system links.
['aiscope.openTabs', 'aiscope.seenScopes'].forEach(k => { const v = store.get(k, null); if (Array.isArray(v) && v.includes('system')) store.set(k, v.map(x => x === 'system' ? 'hardware' : x)); });
if (location.hash === '#system') history.replaceState(null, '', '#hardware');
// AI_SCOPE-035: the "LM Studio" scope is now "bionic" (it was watching LM Studio's Bionic). Same for saved tabs and old #lmstudio links.
// (Revisit when the LM Studio desktop app gets its own scope, AI_SCOPE-036.)
['aiscope.openTabs', 'aiscope.seenScopes'].forEach(k => { const v = store.get(k, null); if (Array.isArray(v) && v.includes('lmstudio')) store.set(k, v.map(x => x === 'lmstudio' ? 'bionic' : x)); });
if (location.hash === '#lmstudio') history.replaceState(null, '', '#bionic');
// Which tabs are open, in what order (per browser). Default: all installed scopes (and custom scopes).
let openTabs = store.get('aiscope.openTabs', installedIds()).filter(canOpen);
// Drop tabs of removed scopes; scopes installed since this browser last looked (e.g. from another device) open once.
function syncOpenTabs() {
  const ids = installedIds();
  const seen = store.get('aiscope.seenScopes', null);
  if (seen) ids.filter(id => !seen.includes(id) && !openTabs.includes(id)).forEach(id => openTabs.push(id));
  openTabs = openTabs.filter(canOpen);
  store.set('aiscope.seenScopes', ids);
  store.set('aiscope.openTabs', openTabs);
}
syncOpenTabs();

function accentColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2563eb';
}
function svgUri(svg) {
  return 'url(&quot;data:image/svg+xml,' + encodeURIComponent(svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ').replace(/currentColor/g, accentColor())) + '&quot;)';
}
// Home (landing) background: gently animated low-poly field, black -> blue.
// Fixed jittered triangle grid (no retriangulation, so nothing pops); vertices drift, a light slowly circles.
const homeAnim = (function () {
  const canvas = document.getElementById('homeBg');
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const STOPS_BY_THEME = {
    blue: [[2,4,10],[4,12,32],[8,34,84],[18,88,180],[60,160,255]],
    magenta: [[10,2,8],[30,4,24],[84,8,62],[184,24,128],[255,84,190]],
    neo: [[1,5,2],[3,16,7],[6,48,20],[14,128,58],[60,255,140]],
    eva: [[6,3,10],[24,10,40],[62,28,98],[118,70,168],[155,227,60]],
  };
  let STOPS = STOPS_BY_THEME.blue;
  let W = 0, H = 0, pts = [], tris = [], running = false;
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function mixStops(t) {
    t = Math.max(0, Math.min(1, t)) * (STOPS.length - 1);
    const i = Math.min(STOPS.length - 2, Math.floor(t)), f = t - i, a = STOPS[i], b = STOPS[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  function build() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const S = Math.max(70, Math.min(130, Math.sqrt(W * H) / 9)), rh = S * 0.866;
    const rows = Math.ceil(H / rh) + 3, cols = Math.ceil(W / S) + 3;
    pts = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      pts.push({
        bx: (c - 1) * S + (r % 2 ? S / 2 : 0) + rnd(-.22, .22) * S, by: (r - 1) * rh + rnd(-.22, .22) * S,
        ax: rnd(.08, .2) * S, ay: rnd(.08, .2) * S, sx: rnd(.00012, .00028), sy: rnd(.00012, .00028),
        px: rnd(0, 6.283), py: rnd(0, 6.283), zs: rnd(.0002, .0004), zp: rnd(0, 6.283), za: rnd(.25, .55) * S,
        x: 0, y: 0, z: 0
      });
    }
    const id = (r, c) => r * cols + c;
    tris = [];
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
      if (r % 2 === 0) { tris.push([id(r, c), id(r, c + 1), id(r + 1, c)]); tris.push([id(r, c + 1), id(r + 1, c), id(r + 1, c + 1)]); }
      else { tris.push([id(r, c), id(r + 1, c), id(r + 1, c + 1)]); tris.push([id(r, c), id(r, c + 1), id(r + 1, c + 1)]); }
    }
    tris = tris.map(t => ({ v: t, j: rnd(-.07, .07) }));
  }
  function draw(now) {
    if (!pts.length) return;
    for (const p of pts) {
      p.x = p.bx + Math.sin(now * p.sx + p.px) * p.ax;
      p.y = p.by + Math.cos(now * p.sy + p.py) * p.ay;
      p.z = Math.sin(now * p.zs + p.zp) * p.za;
    }
    const la = now * 0.00006;
    let lx = Math.cos(la) * .45, ly = -.55 + Math.sin(la) * .2, lz = .7;
    const ll = Math.hypot(lx, ly, lz); lx /= ll; ly /= ll; lz /= ll;
    const diag = W + H;
    ctx.fillStyle = 'rgb(' + STOPS[0].join(',') + ')'; ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = 1;
    for (const t of tris) {
      const a = pts[t.v[0]], b = pts[t.v[1]], c = pts[t.v[2]];
      const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const lit = (nx * lx + ny * ly + nz * lz) / (Math.hypot(nx, ny, nz) || 1);
      const g = ((a.x + b.x + c.x) / 3 + (H - (a.y + b.y + c.y) / 3)) / diag;
      const col = mixStops(Math.pow(Math.max(0, g), 1.35) + t.j), k = .35 + lit * .95;
      const fill = 'rgb(' + (col[0] * k | 0) + ',' + (col[1] * k | 0) + ',' + (col[2] * k | 0) + ')';
      ctx.fillStyle = fill; ctx.strokeStyle = fill;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath();
      ctx.fill(); ctx.stroke();
    }
  }
  function loop(now) {
    if (!running) return;
    draw(now);
    if (!reduce && !document.hidden) requestAnimationFrame(loop);
  }
  function start() {
    if (running) return;
    running = true;
    if (canvas.clientWidth !== W || canvas.clientHeight !== H || !pts.length) build();
    requestAnimationFrame(loop);
  }
  function stop() { running = false; }
  window.addEventListener('resize', () => { if (running) { build(); if (reduce) draw(performance.now()); } });
  document.addEventListener('visibilitychange', () => { if (running && !document.hidden && !reduce) requestAnimationFrame(loop); });
  function setPalette(name) {
    STOPS = STOPS_BY_THEME[name] || STOPS_BY_THEME.blue;
    if (running && reduce) draw(performance.now());
  }
  return { start, stop, setPalette };
})();

// Theme (AI_SCOPE-010): an app-wide setting shown in the settings dialog - no top-bar menu any more, so the
// value comes from the server ('default' follows the OS light / dark setting).
const THEMES = { default: 'Default', dark: 'Dark', magenta: 'Magenta', neo: 'Neo', eva: 'EVA' };
// Some apps ship a logo for light and one for dark backgrounds (Strata): ask for the one matching the theme.
let logosReady = false;   // set once the logo checks below have started (renderTabs needs LOGO_OK)
function darkTheme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t !== 'default';   // Dark, Magenta, Neo and EVA are all dark
  return !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
}
function logoUrl(id) { return '/api/logo/' + id + (darkTheme() ? '?theme=dark' : ''); }
function applyTheme(t) {
  if (!THEMES[t]) t = 'default';
  if (t === 'default') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  homeAnim.setPalette(t === 'magenta' || t === 'neo' || t === 'eva' ? t : 'blue');
  if (logosReady) renderTabs();   // logos that differ for light / dark backgrounds
}
if (window.matchMedia) {   // Default theme follows the OS: redraw the logos when it switches light / dark
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const redraw = () => { if (logosReady) renderTabs(); };
  if (mq.addEventListener) mq.addEventListener('change', redraw); else if (mq.addListener) mq.addListener(redraw);
}
(function () {
  const fromServer = (window.AI_SCOPE_SETTINGS || {}).theme;
  // Browsers that used the old top-bar menu move their choice into the setting once (it was per browser before).
  const old = store.get('aiscope.theme', null);
  if (old && THEMES[old] && !fromServer) {
    try { localStorage.removeItem('aiscope.theme'); } catch (e) {}
    postJson('/api/settings/change', { section: 'appearance', key: 'theme', value: old });
  }
  applyTheme(fromServer && THEMES[fromServer] ? fromServer : (old && THEMES[old] ? old : 'default'));
  if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderTabs());
})();

function renderTabs() {
  document.getElementById('tabs').innerHTML = openTabs.map(id => {
    const cs = customById(id);
    const sc = cs ? { name: cs.name, icon: CUSTOM_ICON } : scopeById(id);
    if (!sc) return '';
    // app logo, or the scope's own SVG icon (accent colored) when the app has none
    const bg = LOGO_OK[id] ? 'url(' + logoUrl(id) + ')' : sc.icon ? svgUri(sc.icon) : '';
    const logo = bg ? ' has-logo" style="--logo:' + bg : '';
    return '<a class="tab' + (cs ? ' custom' : '') + '" href="#' + id + '" data-tab="' + id + '" draggable="true" title="' + (cs ? 'Custom scope · ' : '') + 'Drag to reorder"><span class="tname' + logo + '">' + escH(sc.name) + '</span>' +
           '<span class="x" data-close="' + id + '" title="Close tab">&times;</span></a>';
  }).join('');
  showTab();
}

function showTab() {
  let want = location.hash.slice(1);
  if (!want) {   // plain http://localhost:<port>/ lands on the Default Scope (AI_SCOPE-010: General -> Default Scope)
    want = landingScope();
    history.replaceState(null, '', '#' + want);
  }
  const gallery = want === 'scopes';
  const home = want === 'home';
  const name = gallery ? 'scopes' : home ? 'home'
    : openTabs.includes(want) ? want : (openTabs.includes(DEFAULT_SCOPE) ? DEFAULT_SCOPE : openTabs[0]);
  if (gallery) renderGallery();
  document.getElementById('addBtn').classList.toggle('active', gallery);
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => { p.hidden = p.dataset.panel !== name; });
  if (gallery) equalizeSquares();   // needs the page shown to measure the cards
  document.getElementById('noTabs').hidden = gallery || home || openTabs.length > 0;
  // "Open dashboard" goes to the first open tab (or the Scopes gallery when none are open)
  document.getElementById('homeGo').setAttribute('href', '#' + (openTabs[0] || 'scopes'));
  if (home) homeAnim.start(); else homeAnim.stop();
}

function openScope(id) {
  if (!canOpen(id)) return openInstall(id);
  if (!openTabs.includes(id)) {
    openTabs.push(id);   // new tabs go on the right; the order is whatever the user dragged it to
    store.set('aiscope.openTabs', openTabs);
    renderTabs();
  }
  if (location.hash.slice(1) !== id) location.hash = id; else showTab();
}

function closeTab(id) {
  const i = openTabs.indexOf(id);
  if (i < 0) return;
  const wasActive = document.querySelector('.tab.active') && document.querySelector('.tab.active').dataset.tab === id;
  openTabs.splice(i, 1);
  store.set('aiscope.openTabs', openTabs);
  renderTabs();
  if (wasActive && openTabs.length) location.hash = openTabs[Math.max(0, i - 1)];
}

// Drag tabs to reorder them; the order is saved per browser with the open tabs.
(function () {
  const bar = document.getElementById('tabs');
  let dragEl = null;
  bar.addEventListener('dragstart', e => {
    const t = e.target.closest('.tab');
    if (!t) return;
    dragEl = t;
    t.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', t.dataset.tab); } catch (err) {}
  });
  bar.addEventListener('dragover', e => {
    if (!dragEl) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const over = e.target.closest('.tab');
    if (!over || over === dragEl) return;
    const r = over.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    bar.insertBefore(dragEl, after ? over.nextSibling : over);
  });
  bar.addEventListener('drop', e => { if (dragEl) e.preventDefault(); });
  bar.addEventListener('dragend', () => {
    if (!dragEl) return;
    dragEl.classList.remove('dragging');
    dragEl = null;
    const order = [...bar.querySelectorAll('.tab')].map(t => t.dataset.tab);
    if (order.join() !== openTabs.join()) { openTabs = order; store.set('aiscope.openTabs', openTabs); }
  });
})();

document.getElementById('tabs').addEventListener('click', e => {
  const x = e.target.closest('[data-close]');
  if (x) { e.preventDefault(); e.stopPropagation(); closeTab(x.dataset.close); }
});

// ---- Scopes gallery (the "+" view): install / remove ----
function scopeIcon(sc, cls) {
  return (sc.logo && LOGO_OK[sc.id]) ? '<div class="' + cls + ' logo"><img src="' + logoUrl(sc.id) + '" alt=""></div>'
                                     : '<div class="' + cls + '">' + (sc.icon || '') + '</div>';
}
// Three sections: installable scopes (installed first), built-in scopes, custom scopes (+ "Create Custom Scope").
function scopeSquare(sc) {
  let foot;
  if (sc.builtin) foot = '<span class="badge builtin">Built in</span>';
  else if (sc.installed) foot = '<span class="badge">Installed</span><div class="row"><button class="removebtn" data-remove="' + sc.id + '">Remove</button>' +
    (sc.settings.length ? '<button class="linkbtn" data-settings="' + sc.id + '">Settings</button>' : '') + '</div>';
  else foot = '<span class="badge avail">Available</span><button class="installbtn" data-install="' + sc.id + '">Install</button>';
  if (sc.error) foot = '<span class="scerr" title="' + escH(sc.error) + '">Failed to start: ' + escH(sc.error) + '</span>' + foot;
  return '<div class="square' + (sc.installed ? '' : ' off') + '" data-scope="' + sc.id + '" title="' + (sc.installed ? 'Open ' : 'Install ') + escH(sc.name) + '">' +
    scopeIcon(sc, 'icon') +
    '<div class="name">' + escH(sc.name) + '</div>' +
    '<div class="desc" title="' + escH(sc.desc) + '">' + escH(sc.desc) + '</div>' +
    '<div class="foot">' + foot + '</div></div>';
}
// "3 lenses from Strata, Ollama" — names of the scopes a custom scope borrows from.
function customDesc(cs) {
  if (!cs.lenses.length) return 'Empty. Open it to add lenses.';
  const names = [];
  cs.lenses.forEach(l => {
    const sid = l.lens.split('.')[0], sc = scopeById(sid), n = sc ? sc.name : sid;
    if (!names.includes(n)) names.push(n);
  });
  return cs.lenses.length + ' lens' + (cs.lenses.length > 1 ? 'es' : '') + ' from ' + names.join(', ');
}
function customSquare(cs) {
  const desc = customDesc(cs);
  return '<div class="square custom" data-scope="' + cs.id + '" title="Open ' + escH(cs.name) + '">' +
    '<div class="icon">' + CUSTOM_ICON + '</div>' +
    '<div class="name">' + escH(cs.name) + '</div>' +
    '<div class="desc" title="' + escH(desc) + '">' + escH(desc) + '</div>' +
    '<div class="foot"><span class="badge custom">Custom</span><div class="row"><button class="removebtn" data-cs-remove="' + cs.id + '">Remove</button>' +
    '<button class="linkbtn" data-cs-settings="' + cs.id + '">Settings</button></div></div></div>';
}
function renderGallery() {
  const apps = SCOPES.filter(sc => !sc.builtin);
  const installable = apps.filter(sc => sc.installed).concat(apps.filter(sc => !sc.installed));
  const sect = (title, hint, cards) => '<div class="gsec"><h2>' + title + (hint ? ' <span class="hint">' + hint + '</span>' : '') + '</h2>' +
    '<div class="gallery">' + cards + '</div></div>';
  const create = '<div class="square create" data-create title="Create a custom scope"><div class="icon">+</div>' +
    '<div class="name">Create Custom Scope</div><div class="desc">Pick lenses from any scope and put them on one page.</div></div>';
  const html = sect('Installable scopes', 'Install a scope to add its tab', installable.map(scopeSquare).join('')) +
    sect('Built-in scopes', '', SCOPES.filter(sc => sc.builtin).map(scopeSquare).join('')) +
    sect('Custom scopes', CUSTOM.length ? '' : 'Combine lenses from any scope on one page', create + CUSTOM.map(customSquare).join(''));
  const g = document.getElementById('gallery');
  if (g._html !== html) { g._html = html; g.innerHTML = html; }   // only redraw when it changes, so clicks aren't lost
  equalizeSquares();
}
// Every card on the Scopes page as tall as the tallest one, across all three sections (each section is its own grid).
function equalizeSquares() {
  const sq = [...document.querySelectorAll('#gallery .square')];
  if (!sq.length || !sq[0].offsetParent) return;   // page not shown
  sq.forEach(x => { x.style.height = ''; });
  const h = Math.max(...sq.map(x => x.offsetHeight));
  sq.forEach(x => { x.style.height = h + 'px'; });
}
window.addEventListener('resize', equalizeSquares);
document.getElementById('gallery').addEventListener('click', e => {
  const b = e.target.closest('[data-install],[data-remove],[data-settings],[data-cs-remove],[data-cs-settings],[data-create]');
  if (b) {
    e.stopPropagation();
    if (b.dataset.install) openInstall(b.dataset.install);
    else if (b.dataset.remove) openRemove(b.dataset.remove);
    else if (b.dataset.settings) openInstall(b.dataset.settings, true);
    else if (b.dataset.csRemove) openCustomRemove(b.dataset.csRemove);
    else if (b.dataset.csSettings) openCustomName(b.dataset.csSettings);
    else openCustomName(null);
    return;
  }
  const sq = e.target.closest('[data-scope]');
  if (sq) openScope(sq.dataset.scope);
});

// New scope list from the server (after install/remove, or changed from another browser).
function applyScopes(list) {
  SCOPES = list;
  SCOPES.forEach(ensurePanel);
  syncOpenTabs();
  renderTabs();
}
// New custom scope list (after create/rename/remove/save, or changed from another browser).
function applyCustom(list) {
  setCustom(list);
  syncOpenTabs();
  renderTabs();
}
setInterval(async () => {
  if (dlg.open) return;
  try {
    const list = await (await fetch('/api/scopes', { cache: 'no-store' })).json();
    if (JSON.stringify(list) !== JSON.stringify(SCOPES)) applyScopes(list);
    const custom = await (await fetch('/api/custom-scopes', { cache: 'no-store' })).json();
    if (JSON.stringify(custom) !== JSON.stringify(CUSTOM)) applyCustom(custom);
    const layouts = await (await fetch('/api/scope-layouts', { cache: 'no-store' })).json();   // scope pages edited elsewhere (AI_SCOPE-020)
    if (JSON.stringify(layouts) !== JSON.stringify(SCOPE_LAYOUTS)) setScopeLayouts(layouts);
  } catch (e) {}
}, 5000);

// Install / settings / remove dialog
const dlg = document.getElementById('scopeDlg');
const dlgForm = document.getElementById('scopeForm');
let dlgSubmit = null;
dlgForm.addEventListener('submit', e => { e.preventDefault(); if (dlgSubmit) dlgSubmit(); });
dlgForm.addEventListener('click', e => { if (e.target.closest('[data-cancel]')) dlg.close(); });
function dlgTitle(sc, text) {
  const ic = (sc.logo && LOGO_OK[sc.id]) ? '<img src="' + logoUrl(sc.id) + '" alt="">' : (sc.icon || '');
  return '<h2>' + ic + '<span>' + escH(text) + '</span></h2>';
}
function dlgBusy(btnText) {
  const b = dlgForm.querySelector('[type=submit]');
  b.disabled = true; b.textContent = btnText;
}
async function postScope(action, body) {
  return postJson('/api/scopes/' + action, body);
}
function fieldHtml(f, edit) {
  const v = edit ? f.value : f.default;
  return '<div class="field"><label for="sf-' + f.key + '">' + escH(f.label) + (f.required ? '' : ' <span class="opt">(optional)</span>') + '</label>' +
    '<input id="sf-' + f.key + '" name="' + f.key + '" data-type="' + f.type + '" type="' + (f.type === 'number' ? 'number' : 'text') + '"' +
    ' value="' + escH(v == null ? '' : v) + '" placeholder="' + escH(f.placeholder) + '" spellcheck="false" autocomplete="off"' +
    (f.min != null ? ' min="' + f.min + '"' : '') + (f.max != null ? ' max="' + f.max + '"' : '') + '>' +
    (f.help ? '<div class="help">' + escH(f.help) + '</div>' : '') +
    '<div class="ferr" data-err="' + f.key + '" hidden></div></div>';
}
function openInstall(id, edit) {
  const sc = scopeById(id);
  if (!sc || sc.builtin) return;
  const fields = sc.settings || [];
  dlgForm.innerHTML = dlgTitle(sc, edit ? sc.name + ' settings' : 'Install ' + sc.name) +
    '<p class="lead">' + (edit ? 'Saving restarts this scope with the new settings.'
      : fields.length ? 'Check these settings, then install. A ' + escH(sc.name) + ' tab is added when it&#39;s done.' : 'Adds a ' + escH(sc.name) + ' tab.') + '</p>' +
    fields.map(f => fieldHtml(f, edit)).join('') +
    '<div class="formerr" hidden></div>' +
    '<div class="actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">' + (edit ? 'Save' : 'Install') + '</button></div>';
  dlgSubmit = async () => {
    const settings = {};
    dlgForm.querySelectorAll('input[name]').forEach(i => { settings[i.name] = i.value; });
    dlgForm.querySelectorAll('.ferr, .formerr').forEach(x => { x.hidden = true; });
    dlgForm.querySelectorAll('input').forEach(i => i.classList.remove('bad'));
    dlgBusy(edit ? 'Saving…' : 'Installing…');
    let r;
    try { r = await postScope('install', { id: id, settings: settings }); }
    catch (e) { r = { ok: false, error: 'Could not reach AI_SCOPE: ' + e.message }; }
    if (r.ok) {
      dlg.close();
      applyScopes(r.scopes);
      if (!edit) openScope(id);   // add the tab and switch to it
      return;
    }
    const b = dlgForm.querySelector('[type=submit]');
    b.disabled = false; b.textContent = edit ? 'Save' : 'Install';
    Object.keys(r.errors || {}).forEach(k => {
      const el = dlgForm.querySelector('[data-err="' + k + '"]'), inp = dlgForm.querySelector('[name="' + k + '"]');
      if (el) { el.textContent = r.errors[k]; el.hidden = false; }
      if (inp) inp.classList.add('bad');
    });
    if (r.error) { const fe = dlgForm.querySelector('.formerr'); fe.textContent = r.error; fe.hidden = false; }
  };
  dlg.showModal();
  const first = dlgForm.querySelector('input');
  if (first) first.focus(); else dlgForm.querySelector('[type=submit]').focus();
}
function openRemove(id) {
  const sc = scopeById(id);
  if (!sc || sc.builtin) return;
  dlgForm.innerHTML = dlgTitle(sc, 'Remove ' + sc.name + '?') +
    '<p class="lead">Its tab closes and AI_SCOPE stops collecting data for it. Saved history is kept, so it&#39;s still there if you install it again.</p>' +
    '<div class="formerr" hidden></div>' +
    '<div class="actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn danger">Remove</button></div>';
  dlgSubmit = async () => {
    dlgBusy('Removing…');
    let r;
    try { r = await postScope('remove', { id: id }); }
    catch (e) { r = { ok: false, error: 'Could not reach AI_SCOPE: ' + e.message }; }
    if (r.ok) { dlg.close(); applyScopes(r.scopes); return; }
    const b = dlgForm.querySelector('[type=submit]');
    b.disabled = false; b.textContent = 'Remove';
    const fe = dlgForm.querySelector('.formerr'); fe.textContent = r.error || 'Failed'; fe.hidden = false;
  };
  dlg.showModal();
  dlgForm.querySelector('[data-cancel]').focus();
}

// ---- Custom scopes: create / settings (name) / remove, in the same dialog ----
async function postCustom(action, body) {
  return postJson('/api/custom-scopes/' + action, body);
}
// id = null: create a new custom scope (then open it, in edit mode since it's empty); else rename it.
function openCustomName(id) {
  const cs = id ? customById(id) : null;
  if (id && !cs) return;
  const title = cs ? cs.name + ' settings' : 'Create Custom Scope';
  dlgForm.innerHTML = dlgTitle({ icon: CUSTOM_ICON }, title) +
    '<p class="lead">' + (cs ? 'The name shows on its tab and on the Scopes page.'
      : 'Name your scope, then add lenses from any installed scope to it. It opens as a new tab.') + '</p>' +
    fieldHtml({ key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'e.g. My LLMs', value: cs ? cs.name : '', default: '' }, !!cs) +
    '<div class="formerr" hidden></div>' +
    '<div class="actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">' + (cs ? 'Save' : 'Create') + '</button></div>';
  dlgSubmit = async () => {
    const name = dlgForm.querySelector('[name=name]').value;
    dlgForm.querySelectorAll('.ferr, .formerr').forEach(x => { x.hidden = true; });
    dlgForm.querySelectorAll('input').forEach(i => i.classList.remove('bad'));
    dlgBusy(cs ? 'Saving…' : 'Creating…');
    let r;
    try { r = await postCustom(cs ? 'update' : 'create', cs ? { id: id, name: name } : { name: name }); }
    catch (e) { r = { ok: false, error: 'Could not reach AI_SCOPE: ' + e.message }; }
    if (r.ok) {
      dlg.close();
      applyCustom(r.custom);
      if (!cs) openScope(r.id);   // add the tab and switch to it
      else renderGallery();
      return;
    }
    const b = dlgForm.querySelector('[type=submit]');
    b.disabled = false; b.textContent = cs ? 'Save' : 'Create';
    if (r.errors && r.errors.name) {
      const el = dlgForm.querySelector('[data-err="name"]');
      el.textContent = r.errors.name; el.hidden = false;
      dlgForm.querySelector('[name=name]').classList.add('bad');
    }
    if (r.error) { const fe = dlgForm.querySelector('.formerr'); fe.textContent = r.error; fe.hidden = false; }
  };
  dlg.showModal();
  const inp = dlgForm.querySelector('[name=name]');
  inp.focus(); inp.select();
}
function openCustomRemove(id) {
  const cs = customById(id);
  if (!cs) return;
  dlgForm.innerHTML = dlgTitle({ icon: CUSTOM_ICON }, 'Remove ' + cs.name + '?') +
    '<p class="lead">Its tab closes and its layout is deleted. The scopes it borrows lenses from aren&#39;t affected.</p>' +
    '<div class="formerr" hidden></div>' +
    '<div class="actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn danger">Remove</button></div>';
  dlgSubmit = async () => {
    dlgBusy('Removing…');
    let r;
    try { r = await postCustom('remove', { id: id }); }
    catch (e) { r = { ok: false, error: 'Could not reach AI_SCOPE: ' + e.message }; }
    if (r.ok) { dlg.close(); applyCustom(r.custom); renderGallery(); return; }
    const b = dlgForm.querySelector('[type=submit]');
    b.disabled = false; b.textContent = 'Remove';
    const fe = dlgForm.querySelector('.formerr'); fe.textContent = r.error || 'Failed'; fe.hidden = false;
  };
  dlg.showModal();
  dlgForm.querySelector('[data-cancel]').focus();
}

// App logos (read by the server from each app's install folder). Tabs/cards switch to them once they load.
const LOGO_OK = {};
SCOPES.filter(sc => sc.logo).forEach(sc => {
  const img = new Image();
  img.onload = () => { LOGO_OK[sc.id] = true; renderTabs(); };
  img.src = '/api/logo/' + sc.id;
});
logosReady = true;

window.addEventListener('hashchange', showTab);
renderTabs();

// Dev auto-reload: when the server restarts after a code change, refresh the page.
let boot;
setInterval(async () => {
  try {
    const id = await (await fetch('/__boot', { cache: 'no-store' })).text();
    if (boot && id !== boot) location.reload();
    boot = id;
  } catch (e) {}
}, 1000);
