// AI_SCOPE dashboard - custom scopes (AI_SCOPE-003): user-named pages built from lenses of the app scopes and SYSTEM.
// Edit mode (pencil): add lenses (Add lens dialog), drag to reorder, remove, change lens settings (gear); save or cancel.
// Unsaved edits stay while switching tabs (kept in memory, lost on reload). Loaded last: uses shell.js (tabs, dialogs).

const ICON = {
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};
const CS = {};   // custom scope id -> { panel, editing, draft, savedJson, mounted: [lens instances] }
const clone = v => JSON.parse(JSON.stringify(v));

// Settings of a lens copy: the schema's defaults, then the saved values.
function lensSettings(def, saved) {
  const st = {};
  ((def && def.settings) || []).forEach(f => { st[f.id] = f.default; });
  return Object.assign(st, saved || {});
}
function lensSize(def, saved) {
  if (!def) return 'wide';
  return typeof def.size === 'function' ? def.size(lensSettings(def, saved)) : def.size;
}
function scopeName(id) { const sc = scopeById(id); return sc ? sc.name : id; }
// What a lens copy is, for the edit toolbar: "Strata · Requests", "SYSTEM · GPU 2 (VRAM)".
function lensLabel(item) {
  const def = LENSES[item.lens], sid = item.lens.split('.')[0];
  if (!def) return scopeName(sid) + ' · ' + item.lens.split('.').slice(1).join('.');
  let txt = scopeName(sid) + ' · ' + def.name;
  if (item.lens === 'system.gpu') {
    const st = lensSettings(def, item.settings);
    txt += ' ' + (st.card + 1) + (st.show === 'gpu' ? ' (usage)' : st.show === 'vram' ? ' (VRAM)' : '');
  }
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
      img.onload = () => { const ic = chip.querySelector('svg'); if (ic) ic.replaceWith(img); else chip.prepend(img); };
      img.src = logoUrl(sid);
    }
    t.appendChild(chip);
  });
}

// ---------- Pages ----------
function csPanel(cs) {
  const sec = document.createElement('section');
  sec.className = 'panel custom'; sec.dataset.panel = cs.id; sec.hidden = true;
  sec.innerHTML = '<div class="section-head"><h1></h1><span class="meta"></span>' +
    '<div class="cs-tools">' +
    '<button type="button" class="iconbtn" data-cs-edit title="Edit scope">' + ICON.pencil + '</button>' +
    '<button type="button" class="cs-cancel" data-cs-cancel title="Cancel">Cancel</button>' +
    '<button type="button" class="iconbtn primary" data-cs-save title="Save changes">' + ICON.save + '</button>' +
    '</div></div><div class="wrap"><div class="cgrid" data-cgrid></div></div>';
  document.body.insertBefore(sec, document.body.querySelector('script'));
  sec.addEventListener('click', e => onPanelClick(cs.id, e));
  wireDrag(cs.id, sec.querySelector('[data-cgrid]'));
  return sec;
}
function setHead(id) {
  const cs = customById(id), st = CS[id], p = st.panel;
  p.querySelector('h1').textContent = cs.name;
  const n = (st.editing ? st.draft : cs.lenses).length;
  p.querySelector('.meta').textContent = st.editing
    ? (n ? 'Editing · add, remove or drag lenses, then save' : 'Empty · add lenses to build this page')
    : 'Custom scope · ' + n + ' lens' + (n === 1 ? '' : 'es');
  p.classList.toggle('editing', st.editing);
  p.querySelector('[data-cs-edit]').hidden = st.editing;
  p.querySelector('[data-cs-save]').hidden = !st.editing;
  p.querySelector('[data-cs-cancel]').hidden = !st.editing || !cs.lenses.length;   // nothing to go back to while empty
}
function renderCustom(id) {
  const cs = customById(id), st = CS[id];
  if (!cs || !st) return;
  st.mounted.forEach(unmountLens);
  st.mounted = [];
  if (!cs.lenses.length && !st.editing) { st.editing = true; st.draft = []; }   // edit mode is always on while empty
  st.savedJson = JSON.stringify(cs.lenses);
  setHead(id);
  const grid = st.panel.querySelector('[data-cgrid]');
  // "+ Add lens" (top) adds the new lens first on the page; the + on either side of a lens adds it right there.
  grid.innerHTML = st.editing ? '<button type="button" class="addlens" data-add="0" title="Add a lens at the top of the page"><span>+</span>Add lens</button>' : '';
  (st.editing ? st.draft : cs.lenses).forEach((item, i) => {
    const def = LENSES[item.lens], sid = item.lens.split('.')[0];
    const f = document.createElement('div');
    f.className = 'lframe lf-' + lensSize(def, item.settings) + (item.row && i > 0 ? ' lf-break' : '');   // row: starts a new row
    f.dataset.i = i;
    if (st.editing) {
      f.innerHTML = '<div class="ltools"><span class="lgrip" title="Drag to reorder">&#8942;&#8942;</span><span class="lname">' + escH(lensLabel(item)) + '</span>' +
        (def && def.settings ? '<button type="button" class="lbtn" data-lgear="' + i + '" title="Lens settings">' + ICON.gear + '</button>' : '') +
        '<button type="button" class="lbtn" data-lremove="' + i + '" title="Remove lens">&times;</button></div>' +
        '<button type="button" class="lplus left" data-add="' + i + '" data-left title="Add a lens to the left">+</button>' +
        '<button type="button" class="lplus right" data-add="' + (i + 1) + '" title="Add a lens to the right">+</button>';
    }
    const body = document.createElement('div');
    body.className = 'lbody';
    f.appendChild(body);
    grid.appendChild(f);
    if (!def) body.innerHTML = '<div class="card hintbox">This lens (' + escH(item.lens) + ') is no longer available.</div>';
    else if (!isInstalled(def.scope)) body.innerHTML = '<div class="card hintbox"><b>' + escH(scopeName(sid)) + ' &middot; ' + escH(def.name) + '</b><br>' +
      escH(scopeName(sid)) + ' isn&#39;t installed. Install it on the Scopes page (<b>+</b>) to see this lens again.</div>';
    else { st.mounted.push(mountLens(item.lens, body, item.settings)); scopeTag(body, sid); }
  });
}
// After the list changes (load, poll, create, rename, save, remove): add/update/remove pages.
function syncCustom() {
  CUSTOM.forEach(cs => {
    let st = CS[cs.id];
    if (!st) st = CS[cs.id] = { panel: csPanel(cs), editing: false, draft: null, savedJson: null, mounted: [] };
    if (st.editing && cs.lenses.length) setHead(cs.id);                       // keep unsaved edits; just update the name
    else if (st.savedJson !== JSON.stringify(cs.lenses) || !st.mounted.length && !st.editing) renderCustom(cs.id);
    else setHead(cs.id);
  });
  Object.keys(CS).forEach(id => {
    if (customById(id)) return;
    CS[id].mounted.forEach(unmountLens);
    CS[id].panel.remove();
    delete CS[id];
  });
  showTab();
}

// ---------- Edit mode ----------
function onPanelClick(id, e) {
  const st = CS[id], cs = customById(id);
  const chip = e.target.closest('[data-open-scope]');
  if (chip) { e.preventDefault(); openScope(chip.dataset.openScope); return; }   // the scope chip: open that scope's tab
  const b = e.target.closest('[data-cs-edit],[data-cs-save],[data-cs-cancel],[data-add],[data-lgear],[data-lremove]');
  if (!b || !cs) return;
  if (b.hasAttribute('data-cs-edit')) { st.editing = true; st.draft = clone(cs.lenses); renderCustom(id); }
  else if (b.hasAttribute('data-cs-cancel')) { st.editing = false; st.draft = null; renderCustom(id); }
  else if (b.hasAttribute('data-cs-save')) saveCustom(id, b);
  else if (b.dataset.add != null) { lensDlg.dataset.left = b.hasAttribute('data-left') ? '1' : ''; openAddLens(id, +b.dataset.add); }
  else if (b.dataset.lgear) openLensSettings(id, st.draft[+b.dataset.lgear].lens, +b.dataset.lgear);
  else if (b.dataset.lremove) { st.draft.splice(+b.dataset.lremove, 1); renderCustom(id); }
}
async function saveCustom(id, btn) {
  const st = CS[id];
  btn.disabled = true;
  let r;
  try {
    r = await (await fetch('/api/custom-scopes/update', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, lenses: st.draft }) })).json();
  } catch (e) { r = { ok: false, error: 'Could not reach AI_SCOPE: ' + e.message }; }
  btn.disabled = false;
  if (!r.ok) { const m = st.panel.querySelector('.meta'); m.textContent = 'Not saved: ' + (r.error || 'failed'); m.classList.add('bad'); return; }
  st.panel.querySelector('.meta').classList.remove('bad');
  st.editing = false; st.draft = null; st.savedJson = null;   // re-render from the saved layout
  applyCustom(r.custom);
}
// Drag a lens by its grip to move it (edit mode only). Nothing moves while dragging: the lens stays put (dimmed) and
// a 1px accent line shows where it will land:
//   - in the gap between two rows (or above the first / below the last): a horizontal line = a new row there;
//   - beside a lens or in the empty space at the end of a row: a vertical line the height of that lens = joins that row.
// On drop the lens moves once. Rows stay as they are on screen: every lens that starts a row keeps starting one
// (item.row = true), and if the moved lens started a row, the next lens of that row takes over.
function wireDrag(id, grid) {
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
    const st = CS[id];
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
      const it = Object.assign({}, st.draft[+x.dataset.i]);
      delete it.row;
      if (i > 0 && startsRow.get(x)) it.row = true;
      return it;
    });
    st.draft = next;
    renderCustom(id);
  });
}

// ---------- Add lens dialog + lens settings ----------
const lensDlg = document.createElement('dialog');
lensDlg.className = 'modal wide';
lensDlg.innerHTML = '<form method="dialog" novalidate></form>';
document.body.appendChild(lensDlg);
const lensForm = lensDlg.querySelector('form');
let lensSubmit = null;
lensForm.addEventListener('submit', e => { e.preventDefault(); if (lensSubmit) lensSubmit(); });

// pos = index in the draft where the new lens goes (0 = first on the page).
function addLens(id, item) {
  const st = CS[id], pos = Math.max(0, Math.min(st.draft.length, +lensDlg.dataset.pos || 0));
  // added left of a lens that starts a row: the new lens starts that row instead
  if (lensDlg.dataset.left && st.draft[pos] && st.draft[pos].row) { item.row = true; delete st.draft[pos].row; }
  st.draft.splice(pos, 0, item);
  lensDlg.close();
  renderCustom(id);
}
// Grouped by scope, in the Scopes page order: installed app scopes, then SYSTEM. One lens per click.
function openAddLens(id, pos) {
  const cs = customById(id), st = CS[id];
  const where = pos <= 0 ? 'It goes first on the page.'
    : pos >= st.draft.length ? 'It goes after ' + lensLabel(st.draft[st.draft.length - 1]) + ', last on the page.'
    : 'It goes between ' + lensLabel(st.draft[pos - 1]) + ' and ' + lensLabel(st.draft[pos]) + '.';
  const groups = SCOPES.filter(sc => !sc.builtin && sc.installed).concat(SCOPES.filter(sc => sc.builtin));
  lensForm.innerHTML = '<h2>' + CUSTOM_ICON + '<span>Add lens</span></h2>' +
    '<p class="lead">Click a lens to add it to ' + escH(cs.name) + '. ' + escH(where) + '</p>' +
    groups.map(sc => {
      const ls = lensesOf(sc.id);
      if (!ls.length) return '';
      const src = SOURCES[sc.id], off = src && src.data && src.data.online === false;
      return '<div class="lgroup"><div class="lghead">' + scopeIcon(sc, 'licon') + '<span>' + escH(sc.name) + '</span>' +
        (off ? '<span class="offline">offline</span>' : '') + '</div><div class="lpick">' +
        ls.map(d => '<button type="button" class="lcard" data-pick="' + d.id + '"><b>' + escH(d.name) + '</b><span>' + escH(d.description) + '</span></button>').join('') +
        '</div></div>';
    }).join('') +
    '<div class="actions"><button type="button" class="btn" data-lcancel>Cancel</button></div>';
  lensSubmit = null;
  lensDlg.dataset.cs = id;   // which custom scope the picked lens goes to, and where
  lensDlg.dataset.pos = pos;
  if (!lensDlg.open) lensDlg.showModal();
}
lensForm.addEventListener('click', e => {
  if (e.target.closest('[data-lcancel]')) { lensDlg.close(); return; }
  const back = e.target.closest('[data-lback]');
  if (back) { openAddLens(back.dataset.lback, +lensDlg.dataset.pos); return; }
  const p = e.target.closest('[data-pick]');
  if (!p) return;
  const id = lensDlg.dataset.cs, def = LENSES[p.dataset.pick];
  if (def.settings) openLensSettings(id, def.id, null);
  else addLens(id, { lens: def.id, settings: {} });
});
// Settings step: when adding a lens that has settings (index null), or from its gear in edit mode.
function openLensSettings(id, lensId, index) {
  const def = LENSES[lensId], st = CS[id];
  const cur = lensSettings(def, index == null ? {} : st.draft[index].settings);
  const field = f => {
    let opts = f.options;
    if (f.type === 'gpu') {
      const gpus = (SOURCES.system.data && SOURCES.system.data.info.gpus) || [];
      const n = Math.max(1, gpus.length, (cur[f.id] || 0) + 1);
      opts = [];
      for (let i = 0; i < n; i++) opts.push([String(i), 'GPU ' + (i + 1) + (gpus[i] ? ' · ' + gpus[i].name : '')]);
    }
    const val = String(cur[f.id]);
    return '<div class="field"><label for="lf-' + f.id + '">' + escH(f.label) + '</label>' +
      (opts ? '<select id="lf-' + f.id + '" name="' + f.id + '" data-type="' + f.type + '">' +
        opts.map(o => '<option value="' + escH(o[0]) + '"' + (String(o[0]) === val ? ' selected' : '') + '>' + escH(o[1]) + '</option>').join('') + '</select>'
        : '<input id="lf-' + f.id + '" name="' + f.id + '" data-type="' + f.type + '" type="' + (f.type === 'number' ? 'number' : 'text') + '" value="' + escH(val) + '">') +
      '</div>';
  };
  lensForm.innerHTML = '<h2>' + CUSTOM_ICON + '<span>' + escH(scopeName(def.scope) + ' · ' + def.name) + '</span></h2>' +
    '<p class="lead">' + escH(def.description) + '</p>' + def.settings.map(field).join('') +
    '<div class="actions">' + (index == null ? '<button type="button" class="btn" data-lback="' + id + '">Back</button>' : '<button type="button" class="btn" data-lcancel>Cancel</button>') +
    '<button type="submit" class="btn primary">' + (index == null ? 'Add lens' : 'Save') + '</button></div>';
  lensSubmit = () => {
    const vals = {};
    def.settings.forEach(f => {
      const v = lensForm.querySelector('[name="' + f.id + '"]').value;
      vals[f.id] = f.type === 'gpu' || f.type === 'number' ? parseInt(v, 10) || 0 : v;
    });
    if (index == null) addLens(id, { lens: def.id, settings: vals });
    else { st.draft[index].settings = vals; lensDlg.close(); renderCustom(id); }
  };
  lensDlg.dataset.cs = id;
  if (!lensDlg.open) lensDlg.showModal();
  lensForm.querySelector('[type=submit]').focus();
}

CUSTOM_HOOKS.push(syncCustom);
syncCustom();
