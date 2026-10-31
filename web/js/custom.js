// AI_SCOPE dashboard - custom scopes (AI_SCOPE-003): user-named pages built from lenses of the app scopes and the built-in
// scopes. Drawing and edit mode are shared with the scope pages (layout.js, AI_SCOPE-020); this file creates the pages,
// keeps them in step with the list from the server and saves them. Loaded last: uses shell.js (tabs, dialogs) and layout.js.

function csPanel(cs) {
  const sec = document.createElement('section');
  sec.className = 'panel custom'; sec.dataset.panel = cs.id; sec.hidden = true;
  sec.innerHTML = '<div class="section-head"><h1></h1><span class="meta"></span>' + layoutTools('custom') +
    '</div><div class="wrap"><div class="cgrid" data-cgrid></div></div>';
  document.body.insertBefore(sec, document.body.querySelector('script'));
  return sec;
}
function customPage(cs) {
  const panel = csPanel(cs), id = cs.id;
  return addPage({
    id, kind: 'custom', panel, grid: panel.querySelector('[data-cgrid]'),
    items: () => (customById(id) || { lenses: [] }).lenses,
    // AI_SCOPE-088: helper text gone - the header carries only the custom scope's name.
    // The meta span stays as the save-error line (pageError in layout.js).
    head: pg => {
      const c = customById(id);
      if (!c) return;
      pg.panel.querySelector('h1').textContent = c.name;
      const m = pg.panel.querySelector('.section-head > .meta');
      if (m && !m.classList.contains('bad')) m.textContent = '';
    },
    save: async list => {
      const r = await postJson('/api/custom-scopes/update', { id: id, lenses: list });
      if (r.ok) r.apply = () => applyCustom(r.custom);
      return r;
    },
  });
}
// After the list changes (load, poll, create, rename, save, remove): add/update/remove pages.
function syncCustom() {
  CUSTOM.forEach(cs => {
    const pg = PAGES[cs.id] || customPage(cs);
    if (pg.editing && cs.lenses.length) setHead(pg);                      // keep unsaved edits; just update the name
    else if (pg.shownJson !== JSON.stringify(cs.lenses) || !pg.mounted.length && !pg.editing) renderPage(pg);
    else setHead(pg);
  });
  Object.keys(PAGES).forEach(id => {
    if (PAGES[id].kind !== 'custom' || customById(id)) return;
    const panel = PAGES[id].panel;
    removePage(id);
    panel.remove();
  });
  showTab();
}

// Theme switch: chips switch to the logo version for the new background (Strata has one per light/dark).
function refreshChipLogos() { document.querySelectorAll('.lchip img[data-logo]').forEach(img => { const u = logoUrl(img.dataset.logo); if (img.getAttribute('src') !== u) img.src = u; }); }
new MutationObserver(refreshChipLogos).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refreshChipLogos);

CUSTOM_HOOKS.push(syncCustom);
syncCustom();
