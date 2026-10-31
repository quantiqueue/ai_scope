// AI_SCOPE dashboard - layout pages (AI_SCOPE-020): every page made of lenses - the scope pages (Hardware, Processes,
// Bionic, ...) and the custom scopes (custom.js) - is drawn and edited here, the same way everywhere.
// Edit mode (pencil): add lenses (Add lens dialog), drag to reorder, remove, change lens settings (the cog in each lens's
// edit bar, left of its ×); save or cancel. Scope pages: only their own lenses, and Reset to default.
// Unsaved edits stay while switching tabs (kept in memory, lost on reload). Loaded after shell.js, before custom.js.

const ICON = {
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>',
};
const clone = v => JSON.parse(JSON.stringify(v));

// A page: { id, kind ('scope' | 'custom'), scope (scope pages), panel, grid, editing, draft, shownJson, mounted: [lens instances],
//   items() -> the saved (or default) lens list, save(list) -> Promise<{ ok, error }>, reset() (scope pages), head(pg) (custom) }
const PAGES = {};

// Settings of a lens copy: the schema's defaults, then the saved values.
function lensSettings(def, saved) {
  const st = {};
  ((def && def.settings) || []).forEach(f => { st[f.id] = f.default; });
  return Object.assign(st, saved || {});
}
function lensSize(def, saved) {
  if (!def) return 'wide';
  return lensWidth(def, lensSettings(def, saved));
}
function scopeName(id) { const sc = scopeById(id); return sc ? sc.name : id; }
// What a lens copy is, for the edit toolbar: "Strata · Requests", "Hardware · GPU 2 (VRAM)", "Processes · Top VRAM 2".
function lensLabel(item) {
  const def = LENSES[item.lens], sid = item.lens.split('.')[0];
  if (!def) return scopeName(sid) + ' · ' + item.lens.split('.').slice(1).join('.');
  let txt = scopeName(sid) + ' · ' + def.name;
  const st = lensSettings(def, item.settings);
  if ((def.settings || []).some(f => f.type === 'gpu')) txt += ' ' + ((st.card || 0) + 1);
  if (item.lens === 'hardware.gpu') txt += st.show === 'gpu' ? ' (usage)' : st.show === 'vram' ? ' (VRAM)' : '';
  if ((def.settings || []).some(f => f.type === 'disk') && st.disk) txt += ' ' + st.disk;
  return txt;
}

// On a custom scope every lens header carries a chip with its scope's logo + name; clicking it opens that scope.
function scopeTag(box, sid) {
  const sc = scopeById(sid);
  if (!sc) return;
  box.querySelectorAll('.ltab').forEach(t => {
    const chip = document.createElement('a');
    chip.className = 'lchip';
    chip.href = '#' + sid;
    chip.dataset.openScope = sid;
    chip.title = 'Open ' + sc.name;
    chip.innerHTML = (sc.icon || '') + '<span>' + escH(sc.name) + '</span>';
    if (sc.logo) {   // the app's logo once it loads (Strata's only exists while Strata runs); the scope icon until then
      const img = new Image();
      img.alt = '';
      img.dataset.logo = sid;
      img.onload = () => { const ic = chip.querySelector('svg'); if (ic) ic.replaceWith(img); else chip.prepend(img); };
      img.src = logoUrl(sid);
    }
    t.appendChild(chip);
  });
}

// ---------- Drawing a page ----------
// The edit buttons for a page header: pencil; in edit mode Reset (scope pages), Cancel and Save.
function layoutTools(kind) {
  return '<div class="cs-tools">' +
    '<span class="meta lhint" hidden></span>' +   // AI_SCOPE-088: no more edit-mode hint text - this span now only ever carries a save error
    (kind === 'scope' ? '<button type="button" class="cs-cancel" data-cs-reset title="Back to this scope\'s built-in layout">Reset to default</button>' : '') +
    '<button type="button" class="iconbtn" data-cs-edit title="Edit ' + (kind === 'scope' ? 'this page' : 'scope') + '">' + ICON.pencil + '</button>' +
    '<button type="button" class="cs-cancel" data-cs-cancel title="Cancel">Cancel</button>' +
    '<button type="button" class="iconbtn primary" data-cs-save title="Save changes">' + ICON.save + '</button>' +
    '</div>';
}
function setHead(pg) {
  const p = pg.panel;
  if (pg.head) pg.head(pg);   // custom scopes: just the name (AI_SCOPE-088 removed the meta line)
  p.classList.toggle('editing', pg.editing);
  p.querySelector('[data-cs-edit]').hidden = pg.editing;
  p.querySelector('[data-cs-save]').hidden = !pg.editing;
  const n = pg.items().length;
  p.querySelector('[data-cs-cancel]').hidden = !pg.editing || (pg.kind === 'custom' && !n);   // empty custom scope: nothing to go back to
  const reset = p.querySelector('[data-cs-reset]');
  if (reset) reset.hidden = !pg.editing;
  const hint = p.querySelector('.lhint');
  if (hint) hint.hidden = !hint.classList.contains('bad');   // AI_SCOPE-088: the lhint span shows only when it carries an error
}
function renderPage(pg) {
  pg.mounted.forEach(unmountLens);
  pg.mounted = [];
  if (pg.kind === 'custom' && !pg.items().length && !pg.editing) { pg.editing = true; pg.draft = []; }   // edit mode is always on while empty
  pg.shownJson = JSON.stringify(pg.items());
  setHead(pg);
  const grid = pg.grid, list = pg.editing ? pg.draft : pg.items();
  // "+ Add lens" (top) adds the new lens first on the page; the + on either side of a lens adds it right there.
  grid.innerHTML = pg.editing ? '<button type="button" class="addlens" data-add="0" title="Add a lens at the top of the page"><span>+</span>Add lens</button>' :
    (!list.length ? '<div class="card hintbox lf-full">No lenses on this page. Click the pencil to add some, or Reset to default.</div>' : '');
  list.forEach((item, i) => {
    const def = LENSES[item.lens], sid = item.lens.split('.')[0];
    const f = document.createElement('div');
    f.className = 'lframe lf-' + lensSize(def, item.settings) + (item.row && i > 0 ? ' lf-break' : '');   // row: starts a new row
    f.dataset.i = i;
    if (pg.editing) {
      f.innerHTML = '<div class="ltools"><span class="lgrip" title="Drag to reorder">&#8942;&#8942;</span><span class="lname">' + escH(lensLabel(item)) + '</span>' +
        (def && lensFields(def).length ? '<button type="button" class="lbtn" data-lgear="' + i + '" title="Lens settings">' + GEAR_ICON + '</button>' : '') +
        '<button type="button" class="lbtn" data-lremove="' + i + '" title="Remove lens">&times;</button></div>' +
        '<button type="button" class="lplus left" data-add="' + i + '" data-left title="Add a lens to the left">+</button>' +
        '<button type="button" class="lplus right" data-add="' + (i + 1) + '" title="Add a lens to the right">+</button>';
    }
    const body = document.createElement('div');
    body.className = 'lbody';
    f.appendChild(body);
    grid.appendChild(f);
    if (!def) body.innerHTML = '<div class="card hintbox">This lens (' + escH(item.lens) + ') is no longer available.</div>';
    else if (pg.kind === 'custom' && !isInstalled(def.scope)) body.innerHTML = '<div class="card hintbox"><b>' + escH(scopeName(sid)) + ' &middot; ' + escH(def.name) + '</b><br>' +
      escH(scopeName(sid)) + ' isn&#39;t installed. Install it on the Scopes page (<b>+</b>) to see this lens again.</div>';
    else {
      pg.mounted.push(mountLens(item.lens, body, item.settings));
      if (pg.kind === 'custom') scopeTag(body, sid);
    }
  });
}

// ---------- Edit mode ----------
function onPageClick(pg, e) {
  const chip = e.target.closest('[data-open-scope]');
  if (chip) { e.preventDefault(); openScope(chip.dataset.openScope); return; }   // the scope chip: open that scope's tab
  const b = e.target.closest('[data-cs-edit],[data-cs-save],[data-cs-cancel],[data-cs-reset],[data-add],[data-lgear],[data-lremove]');
  if (!b || !pg.grid.closest('.panel').contains(b)) return;
  if (b.hasAttribute('data-cs-edit')) { pg.editing = true; pg.draft = clone(pg.items()); renderPage(pg); }
  else if (b.hasAttribute('data-cs-cancel')) { pg.editing = false; pg.draft = null; renderPage(pg); }
  else if (b.hasAttribute('data-cs-save')) savePage(pg, b);
  else if (b.hasAttribute('data-cs-reset')) resetPage(pg, b);
  else if (b.dataset.add != null) { lensDlg.dataset.left = b.hasAttribute('data-left') ? '1' : ''; openAddLens(pg, +b.dataset.add); }
  else if (b.dataset.lgear) openLensSettings(pg, pg.draft[+b.dataset.lgear].lens, +b.dataset.lgear);
  else if (b.dataset.lremove) { pg.draft.splice(+b.dataset.lremove, 1); renderPage(pg); }
}
function pageError(pg, msg) {
  const m = pg.panel.querySelector('.section-head .meta' + (pg.kind === 'custom' ? '' : '.lhint'));
  if (!m) return;
  m.hidden = false; m.textContent = msg; m.classList.add('bad');
}
async function savePage(pg, btn) {
  btn.disabled = true;
  let r;
  try { r = await pg.save(pg.draft); } catch (e) { r = { ok: false, error: 'Could not reach AI_SCOPE: ' + e.message }; }
  btn.disabled = false;
  if (!r.ok) { pageError(pg, 'Not saved: ' + (r.error || 'failed')); return; }
  pg.panel.querySelectorAll('.section-head .bad').forEach(m => m.classList.remove('bad'));
  const hint = pg.panel.querySelector('.lhint'); if (hint) { hint.textContent = ''; hint.hidden = true; }   // AI_SCOPE-088: a good save just clears the error line - no hint text to restore
  pg.editing = false; pg.draft = null; pg.shownJson = null;   // re-render from the saved layout
  if (r.apply) r.apply(); else renderPage(pg);
}
async function resetPage(pg, btn) {
  btn.disabled = true;
  let r;
  try { r = await pg.reset(); } catch (e) { r = { ok: false, error: 'Could not reach AI_SCOPE: ' + e.message }; }
  btn.disabled = false;
  if (!r.ok) { pageError(pg, 'Not reset: ' + (r.error || 'failed')); return; }
  pg.editing = false; pg.draft = null;
  renderPage(pg);
}
// Drag a lens by its grip to move it (edit mode only). Nothing moves while dragging: the lens stays put (dimmed) and
// a 1px accent line shows where it will land:
//   - in the gap between two rows (or above the first / below the last): a horizontal line = a new row there;
//   - beside a lens or in the empty space at the end of a row: a vertical line the height of that lens = joins that row.
// On drop the lens moves once. Rows stay as they are on screen: every lens that starts a row keeps starting one
// (item.row = true), and if the moved lens started a row, the next lens of that row takes over.
function wireDrag(pg) {
  const grid = pg.grid;
  let dragEl = null, frames = [], rows = [], target = null, dropped = false;
  const line = document.createElement('div');
  line.className = 'ldropline';
  line.hidden = true;
  const isRow = f => f.classList.contains('lf-break');
  grid.addEventListener('mousedown', e => { const g = e.target.closest('.lgrip'); if (g) g.closest('.lframe').draggable = true; });
  grid.addEventListener('mouseup', e => { const f = e.target.closest('.lframe'); if (f && f !== dragEl) f.draggable = false; });
  grid.addEventListener('dragstart', e => {
    const f = e.target.closest('.lframe');
    if (!f || !f.draggable) return;
    dragEl = f; target = null; dropped = false;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', f.dataset.i); } catch (err) {}
    // Snapshot the layout (it doesn't change during the drag). Rows = lenses sharing the same top edge.
    frames = [...grid.querySelectorAll('.lframe')];
    rows = [];
    frames.forEach((x, i) => {
      if (i === 0 || Math.abs(x.offsetTop - frames[i - 1].offsetTop) >= 4) rows.push({ frames: [], top: x.offsetTop, bottom: 0 });
      const r = rows[rows.length - 1];
      r.frames.push(x);
      r.bottom = Math.max(r.bottom, x.offsetTop + x.offsetHeight);
    });
    setTimeout(() => { if (dragEl === f) { f.classList.add('dragging'); grid.appendChild(line); } }, 0);   // not inside dragstart (Chrome)
  });
  const cols = () => getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
  const span = (x, n) => x.classList.contains('lf-full') ? n : x.classList.contains('lf-wide') ? Math.min(2, n) : 1;
  function showLine(x, y, w, h) {
    line.hidden = false;
    line.style.left = x + 'px'; line.style.top = y + 'px'; line.style.width = w + 'px'; line.style.height = h + 'px';
  }
  // Where would the lens land for this pointer position? Sets `target` and draws the line (or hides it).
  function aim(e) {
    const g = grid.getBoundingClientRect();
    const x = e.clientX - g.left + grid.scrollLeft, y = e.clientY - g.top;
    const gap = parseFloat(getComputedStyle(grid).rowGap) || 16, n = cols();
    target = null; line.hidden = true;
    const ri = rows.findIndex(r => y >= r.top && y <= r.bottom);
    if (ri < 0) {   // in a gap between rows (or above / below): new row
      let k = rows.findIndex(r => y < r.top);
      if (k < 0) k = rows.length;
      const ly = k === 0 ? rows[0].top - gap / 2 : k === rows.length ? rows[k - 1].bottom + gap / 2 : (rows[k - 1].bottom + rows[k].top) / 2;
      target = { kind: 'row', before: rows[k] ? rows[k].frames[0] : null };
      showLine(0, ly, grid.clientWidth, 1);
      return;
    }
    // inside a row: join it, if there's room for the lens
    const row = rows[ri], others = row.frames.filter(f => f !== dragEl);
    const used = others.reduce((a, f) => a + span(f, n), 0);
    if (!others.length || used + span(dragEl, n) > n) return;   // no room (or only itself): no drop here
    const before = others.find(f => x < f.offsetLeft + f.offsetWidth / 2);
    const ref = before || others[others.length - 1];
    const lx = before ? before.offsetLeft - gap / 2 : ref.offsetLeft + ref.offsetWidth + gap / 2;
    target = { kind: 'join', before: before || null, after: before ? null : ref };
    showLine(lx, ref.offsetTop, 1, ref.offsetHeight);
  }
  grid.addEventListener('dragover', e => {
    if (!dragEl) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    aim(e);
  });
  grid.addEventListener('dragleave', e => { if (dragEl && !grid.contains(e.relatedTarget)) { line.hidden = true; target = null; } });
  grid.addEventListener('drop', e => { if (dragEl) { e.preventDefault(); dropped = true; } });
  grid.addEventListener('dragend', () => {
    if (!dragEl) return;
    const f = dragEl, t = dropped ? target : null;
    dragEl = null;
    f.classList.remove('dragging'); f.draggable = false;
    line.hidden = true; line.remove();
    if (!t) return;
    // the layout as it is on screen, as items with explicit row starts
    const startsRow = new Map(frames.map((x, i) => [x, i > 0 && (isRow(x) || Math.abs(x.offsetTop - frames[i - 1].offsetTop) >= 4)]));
    const di = frames.indexOf(f), nx = frames[di + 1];
    if (nx && !startsRow.get(nx) && (di === 0 || startsRow.get(f))) startsRow.set(nx, true);   // its row-mate takes over
    const list = frames.filter(x => x !== f);
    if (t.kind === 'row' && t.before === f) t.before = nx || null;   // new row right where it is: before its old row-mate
    let at, row;
    if (t.kind === 'row') {
      at = t.before ? list.indexOf(t.before) : list.length; row = true;
      if (t.before) startsRow.set(t.before, true);   // the lens after the new row starts its own row (also when it was first)
    }
    else if (t.before) {
      at = list.indexOf(t.before);
      row = startsRow.get(t.before);            // takes over that row start
      startsRow.set(t.before, false);
    } else { at = list.indexOf(t.after) + 1; row = false; }
    list.splice(at, 0, f);
    startsRow.set(f, row);
    const next = list.map((x, i) => {
      const it = Object.assign({}, pg.draft[+x.dataset.i]);
      delete it.row;
      if (i > 0 && startsRow.get(x)) it.row = true;
      return it;
    });
    pg.draft = next;
    renderPage(pg);
  });
}

// ---------- Add lens dialog + lens settings ----------
const lensDlg = document.createElement('dialog');
lensDlg.className = 'modal wide';
lensDlg.innerHTML = '<form method="dialog" novalidate></form>';
document.body.appendChild(lensDlg);
const lensForm = lensDlg.querySelector('form');
let lensSubmit = null, lensPage = null;
lensForm.addEventListener('submit', e => { e.preventDefault(); if (lensSubmit) lensSubmit(); });

// pos = index in the draft where the new lens goes (0 = first on the page).
function addLens(pg, item) {
  const pos = Math.max(0, Math.min(pg.draft.length, +lensDlg.dataset.pos || 0));
  // added left of a lens that starts a row: the new lens starts that row instead
  if (lensDlg.dataset.left && pg.draft[pos] && pg.draft[pos].row) { item.row = true; delete pg.draft[pos].row; }
  pg.draft.splice(pos, 0, item);
  lensDlg.close();
  renderPage(pg);
}
// Custom scopes: grouped by scope, in the Scopes page order (installed app scopes, then the built-in ones).
// A scope page: only its own lenses. One lens per click; a lens can be added more than once.
function openAddLens(pg, pos) {
  const where = pos <= 0 ? 'It goes first on the page.'
    : pos >= pg.draft.length ? 'It goes after ' + lensLabel(pg.draft[pg.draft.length - 1]) + ', last on the page.'
    : 'It goes between ' + lensLabel(pg.draft[pos - 1]) + ' and ' + lensLabel(pg.draft[pos]) + '.';
  const groups = pg.kind === 'scope' ? [scopeById(pg.scope)].filter(Boolean)
    : SCOPES.filter(sc => !sc.builtin && sc.installed).concat(SCOPES.filter(sc => sc.builtin));
  const name = pg.kind === 'scope' ? scopeName(pg.scope) : customById(pg.id).name;
  lensForm.innerHTML = '<h2>' + CUSTOM_ICON + '<span>Add lens</span></h2>' +
    '<p class="lead">Click a lens to add it to ' + escH(name) + '. ' + escH(where) + '</p>' +
    groups.map(sc => {
      const ls = lensesOf(sc.id).filter(d => !d.available || d.available());   // lenses this system can't fill are left out (AI_SCOPE-052)
      if (!ls.length) return '';
      const src = SOURCES[sc.id], off = src && src.data && src.data.online === false;
      return '<div class="lgroup"><div class="lghead">' + scopeIcon(sc, 'licon') + '<span>' + escH(sc.name) + '</span>' +
        (off ? '<span class="offline">offline</span>' : '') + '</div><div class="lpick">' +
        ls.map(d => '<button type="button" class="lcard" data-pick="' + d.id + '"><b>' + escH(d.name) + '</b><span>' + escH(d.description) + '</span></button>').join('') +
        '</div></div>';
    }).join('') +
    '<div class="actions"><button type="button" class="btn" data-lcancel>Cancel</button></div>';
  lensSubmit = null;
  lensPage = pg;              // which page the picked lens goes to, and where
  lensDlg.dataset.pos = pos;
  if (!lensDlg.open) lensDlg.showModal();
}
lensForm.addEventListener('click', e => {
  if (e.target.closest('[data-lcancel]')) { lensDlg.close(); return; }
  if (e.target.closest('[data-lback]')) { openAddLens(lensPage, +lensDlg.dataset.pos); return; }
  const p = e.target.closest('[data-pick]');
  if (!p) return;
  const def = LENSES[p.dataset.pick];
  if (ownFields(def).length) openLensSettings(lensPage, def.id, null);   // its own settings first (Width can wait for the cog)
  else addLens(lensPage, { lens: def.id, settings: {} });
});
// Fields that apply here: a field with when() shows only when it returns true (e.g. only on Windows, AI_SCOPE-023),
// plus Width for every lens (AI_SCOPE-020).
function ownFields(def) { return (def.settings || []).filter(f => !f.when || f.when()); }
function lensFields(def) {
  const f = ownFields(def).concat([{ id: 'width', label: 'Width', type: 'choice', options: LENS_WIDTHS }]);
  if (def.columns && def.columns.length > 1) f.push({ id: 'cols', label: 'Columns', type: 'columns' });   // table lenses
  return f;
}
// Settings form fields for a lens (schema: def.settings) with the current values.
function lensFieldsHtml(def, cur) {
  const field = f => {
    if (f.type === 'toggle') {    // a checkbox; f.tip = what it's for (hover)
      return '<div class="field"><label class="lcol ltoggle"' + (f.tip ? ' title="' + escH(f.tip) + '"' : '') + '><input type="checkbox" name="' + f.id + '"' +
        (cur[f.id] !== false ? ' checked' : '') + '><span>' + escH(f.label) + '</span></label></div>';
    }
    if (f.type === 'columns') {   // a checkbox per column; the first is always shown (checked, greyed out)
      const hidden = String(cur.cols || '').split(',').map(Number);
      return '<div class="field"><span class="flabel">' + escH(f.label) + '</span><div class="lcols">' + def.columns.map((c, i) =>
        '<label class="lcol' + (i ? '' : ' fixed') + '"' + (i ? '' : ' title="The first column is always shown"') + '><input type="checkbox" name="col" value="' + (i + 1) + '"' +
        (i === 0 || hidden.indexOf(i + 1) < 0 ? ' checked' : '') + (i ? '' : ' disabled') + '><span>' + escH(c) + '</span></label>').join('') + '</div></div>';
    }
    let opts = f.options;
    if (f.type === 'gpu') {
      const gpus = (SOURCES.hardware.data && SOURCES.hardware.data.info.gpus) || [];
      const n = Math.max(1, gpus.length, (cur[f.id] || 0) + 1);
      opts = [];
      for (let i = 0; i < n; i++) opts.push([String(i), 'GPU ' + (i + 1) + (gpus[i] ? ' · ' + gpus[i].name : '')]);
    }
    if (f.type === 'disk') {   // physical disks (AI_SCOPE-030); '' = the first one
      const disks = (SOURCES.hardware.data && SOURCES.hardware.data.info.disks) || [];
      opts = [['', 'First disk' + (disks[0] ? ' · ' + disks[0].name : '')]].concat(disks.map(x => [x.id, x.name]));
      if (cur[f.id] && !disks.some(x => x.id === cur[f.id])) opts.push([cur[f.id], 'Disk ' + cur[f.id] + ' (not found)']);
    }
    const val = String(f.id === 'width' ? lensWidth(def, cur) : cur[f.id]);
    return '<div class="field"><label for="lf-' + f.id + '">' + escH(f.label) + '</label>' +
      (opts ? '<select id="lf-' + f.id + '" name="' + f.id + '" data-type="' + f.type + '">' +
        opts.map(o => '<option value="' + escH(o[0]) + '"' + (String(o[0]) === val ? ' selected' : '') + '>' + escH(o[1]) + '</option>').join('') + '</select>'
        : '<input id="lf-' + f.id + '" name="' + f.id + '" data-type="' + f.type + '" type="' + (f.type === 'number' ? 'number' : 'text') + '"' +
          (f.min != null ? ' min="' + f.min + '"' : '') + (f.max != null ? ' max="' + f.max + '"' : '') + ' value="' + escH(val) + '">') +
      '</div>';
  };
  return lensFields(def).map(field).join('');
}
// Values from the form; fields not shown keep their current value (cur).
function lensFieldsRead(def, cur) {
  const vals = {};
  (def.settings || []).forEach(f => { if (cur && f.id in cur) vals[f.id] = cur[f.id]; });
  lensFields(def).forEach(f => {
    if (f.type === 'toggle') { vals[f.id] = lensForm.querySelector('input[name="' + f.id + '"]').checked; return; }
    if (f.type === 'columns') {
      const off = [...lensForm.querySelectorAll('input[name="col"]')].filter(c => !c.checked && !c.disabled).map(c => c.value);
      if (off.length) vals.cols = off.join(','); else delete vals.cols;
      return;
    }
    const v = lensForm.querySelector('[name="' + f.id + '"]').value;
    vals[f.id] = f.type === 'gpu' ? parseInt(v, 10) || 0 : v;
    if (f.type === 'number') {   // a whole number within min..max; empty or not a number = the default
      const n = parseInt(v, 10);
      vals[f.id] = isNaN(n) ? f.default : Math.max(f.min != null ? f.min : -Infinity, Math.min(f.max != null ? f.max : Infinity, n));
    }
  });
  if (vals.width === naturalWidth(def, vals)) delete vals.width;   // only kept when it differs from the lens's own size
  return vals;
}
// Settings step: when adding a lens that has settings (index null), or from its cog in edit mode (changes the draft).
function openLensSettings(pg, lensId, index) {
  const def = LENSES[lensId];
  const cur = lensSettings(def, index == null ? {} : pg.draft[index].settings);
  lensForm.innerHTML = '<h2>' + GEAR_ICON + '<span>' + escH(scopeName(def.scope) + ' · ' + def.name) + '</span></h2>' +
    '<p class="lead">' + escH(def.description) + '</p>' + lensFieldsHtml(def, cur) +
    '<div class="actions">' + (index == null ? '<button type="button" class="btn" data-lback>Back</button>' : '<button type="button" class="btn" data-lcancel>Cancel</button>') +
    '<button type="submit" class="btn primary">' + (index == null ? 'Add lens' : 'Save') + '</button></div>';
  lensSubmit = () => {
    const vals = lensFieldsRead(def, cur);
    if (index == null) addLens(pg, { lens: def.id, settings: vals });
    else { pg.draft[index].settings = vals; lensDlg.close(); renderPage(pg); }
  };
  lensPage = pg;
  if (!lensDlg.open) lensDlg.showModal();
  lensForm.querySelector('[type=submit]').focus();
}

// ---------- Layout pages: wiring ----------
function addPage(pg) {
  pg.editing = false; pg.draft = null; pg.shownJson = null; pg.mounted = [];
  pg.panel.addEventListener('click', e => onPageClick(pg, e));
  wireDrag(pg);
  PAGES[pg.id] = pg;
  return pg;
}
function removePage(id) {
  const pg = PAGES[id];
  if (!pg) return;
  pg.mounted.forEach(unmountLens);
  delete PAGES[id];
}
async function postLayout(action, body) {
  const r = await postJson('/api/scope-layouts/' + action, body);
  if (r.layouts) SCOPE_LAYOUTS = r.layouts;
  return r;
}
// Scope pages: one per scope with a default layout (defineScopeLayout) and a page in index.html.
function scopePage(scope) {
  const panel = document.querySelector('.panel[data-panel="' + scope + '"]');
  const grid = panel && panel.querySelector('[data-cgrid]');
  if (!grid) return null;
  panel.querySelector('.section-head').insertAdjacentHTML('beforeend', layoutTools('scope'));
  return addPage({
    id: scope, kind: 'scope', scope, panel, grid,
    items: () => (SCOPE_LAYOUTS[scope] ? SCOPE_LAYOUTS[scope].lenses : SCOPE_DEFAULTS[scope]()),
    save: list => postLayout('save', { scope, lenses: list }),
    reset: () => postLayout('reset', { scope }),
  });
}
// Draw the scope pages whose layout changed (saved elsewhere, reset, or the default changed with the detected cards).
// Pages being edited keep their draft.
function syncScopePages() {
  Object.keys(SCOPE_DEFAULTS).forEach(scope => {
    const pg = PAGES[scope] || scopePage(scope);
    if (!pg || pg.editing) return;
    if (pg.shownJson !== JSON.stringify(pg.items())) renderPage(pg);
  });
}
LAYOUT_HOOKS.push(syncScopePages);
subscribeSource('hardware', () => syncScopePages());   // Hardware / Processes defaults follow the detected cards
syncScopePages();
