// AI_SCOPE dashboard - shared code: installed scopes, table paging, formatting helpers.
// Loaded first; the scope files (hardware, comfyui, ollama, bionic, strata) and shell.js build on it.

// ---------- Scopes (catalog: scopes.json; install state: data/installed.json) ----------
// Filled in by the server when it sends the page; refreshed from /api/scopes.
let SCOPES = window.AI_SCOPE_SCOPES || [];   // installed scopes, inlined into index.html by the server
function scopeById(id) { return SCOPES.find(x => x.id === id); }
function isInstalled(id) { const sc = scopeById(id); return !!(sc && sc.installed); }

// ---------- Custom scopes (AI_SCOPE-003): user-made pages of lenses, saved by the server (custom-scopes.json) ----------
let CUSTOM = window.AI_SCOPE_CUSTOM || [];   // [{ id: 'c-...', name, lenses: [{ lens, settings }] }], inlined into index.html
const CUSTOM_HOOKS = [];                     // called after the list changes (custom.js rebuilds the pages)
function customById(id) { return CUSTOM.find(x => x.id === id); }
function setCustom(list) { CUSTOM = list || []; CUSTOM_HOOKS.forEach(f => f()); }
// Saved layouts of the scope pages (AI_SCOPE-020): { scopeId: { lenses: [{ lens, settings, row? }] } } (scope-layouts.json).
// A scope without one shows its default (defineScopeLayout in lens.js). Inlined into index.html; refreshed by shell.js.
let SCOPE_LAYOUTS = window.AI_SCOPE_LAYOUTS || {};
const LAYOUT_HOOKS = [];                     // called after SCOPE_LAYOUTS changes (layout.js re-renders the pages)
function setScopeLayouts(v) { SCOPE_LAYOUTS = v || {}; LAYOUT_HOOKS.forEach(f => f()); }
// The server's system ('win32', 'linux', 'darwin'), for options that only apply on one system.
const SERVER_OS = window.AI_SCOPE_OS || '';
// A tab can show an installed scope or a custom scope.
function canOpen(id) { return isInstalled(id) || !!customById(id); }

// ---------- Paging for request tables ----------
const PAGE_SIZE_DEFAULT = 15;
const pages = {};      // table key -> current page (0-based)
const pagerReload = {}; // table key -> function that re-renders the table
// Returns the slice of row HTML for the current page and updates the pager below the table.
// key = which table (each lens copy has its own key, so its own page); pagerId = the pager's id or element;
// size = rows per page (the request / run / installed-model tables' "Rows per page" setting, AI_SCOPE-020), default PAGE_SIZE_DEFAULT.
function paginate(key, rowsHtml, pagerId, size) {
  const per = Math.max(1, Math.min(500, parseInt(size, 10) || PAGE_SIZE_DEFAULT));
  const n = Math.max(1, Math.ceil(rowsHtml.length / per));
  let p = Math.min(pages[key] || 0, n - 1);
  pages[key] = p;
  const el = typeof pagerId === 'string' ? document.getElementById(pagerId) : pagerId;   // id or element (lenses pass their own)
  el.hidden = rowsHtml.length <= per;
  if (!el.hidden) {
    const from = p * per + 1, to = Math.min(rowsHtml.length, (p + 1) * per);
    const html = '<span>' + from + '–' + to + ' of ' + rowsHtml.length + '</span>' +
      '<button type="button" data-pager="' + key + '" data-dir="-1"' + (p === 0 ? ' disabled' : '') + '>‹ Newer</button>' +
      '<span>Page ' + (p + 1) + ' / ' + n + '</span>' +
      '<button type="button" data-pager="' + key + '" data-dir="1"' + (p >= n - 1 ? ' disabled' : '') + '>Older ›</button>';
    if (el._html !== html) { el._html = html; el.innerHTML = html; }   // only redraw when it changes, so clicks aren't lost
  }
  return rowsHtml.slice(p * per, (p + 1) * per);
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-pager]');
  if (!b || b.disabled) return;
  const key = b.dataset.pager;
  pages[key] = Math.max(0, (pages[key] || 0) + Number(b.dataset.dir));
  if (pagerReload[key]) pagerReload[key]();
});

// ---------- Formatting helpers (shared by all scope tabs) ----------
const GB = b => (b / 1073741824).toFixed(1);
function fmtDur(ms) {
  if (ms == null) return '—';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + ' s';
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  if (m < 60) return m + 'm ' + (r < 10 ? '0' : '') + r + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
function fmtWhen(ms) {
  if (!ms) return '—';
  const d = new Date(ms), today = new Date().toDateString() === d.toDateString();
  return (today ? '' : d.toLocaleDateString() + ' ') + d.toLocaleTimeString();
}
const escH = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function fmtBytes(b) {
  if (b == null) return '—';
  return b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB';
}
// VRAM fit (installed-model tables): measured against the largest single card.
function vramWord(d) {
  return fmtBytes(d.vramTotal) + ' VRAM' + (d.vramCards > 1 ? ' (largest of ' + d.vramCards + ' GPUs)' : '');
}
function fitPill(m, fitText) {
  if (!m.fit) return ONONE;
  if (m.fit === 'multi') return '<span class="fit multi" title="Too big for one card, but fits when split across ' + m.fitGpus + ' GPUs">fits across ' + m.fitGpus + ' GPUs</span>';
  return '<span class="fit ' + m.fit + '">' + fitText[m.fit] + '</span>';
}
function fmtUntil(ms) {
  if (!ms) return '—';
  const left = ms - Date.now();
  if (left > 365 * 864e5) return 'never';
  if (left <= 0) return 'unloading…';
  return fmtDur(left);
}
const ONONE = '—';
const featTags = f => f && f.length ? f.map(x => '<span class="tag">' + escH(x) + '</span>').join('') : ONONE;
// Bionic (LM Studio-format) log timestamps are local "YYYY-MM-DD HH:MM:SS"
function lmTs(ts) {
  const m = /^(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)$/.exec(ts || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}
// Text wrapped in an external link (with an "opens in new tab" icon) when a URL is known.
const EXT_ICON = '<svg class="extico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
function extLink(text, url, title) {
  return url ? '<a class="ext" href="' + escH(url) + '" target="_blank" rel="noopener" title="' + escH(title || url) + ' (opens in a new tab)">' + escH(text) + EXT_ICON + '</a>' : escH(text);
}
// Model names are shown at most NAME_MAX characters long (AI_SCOPE-053): longer ones end in "…" and show in full on hover.
const NAME_MAX = 30;
function cutName(s) { s = String(s == null ? '' : s); return s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1) + '…' : s; }
// HTML for a model name in a table cell (escaped; a span with the full name as its tooltip when cut).
// tip: tooltip to use instead of the full name (e.g. ComfyUI's file name, which includes it).
function nameHtml(s, tip) { s = String(s == null ? '' : s); const c = cutName(s); return c === s ? escH(s) : '<span title="' + escH(tip || s) + '">' + escH(c) + '</span>'; }
// Same for an element filled with textContent (the cards' Model box).
function setName(el, s) { s = String(s == null ? '' : s); const c = cutName(s); el.textContent = c; el.title = c === s ? '' : s; }
// A model name that links somewhere (extLink with the name cut; the full name goes first in the link's tooltip).
function nameLink(s, url, title) { s = String(s == null ? '' : s); const c = cutName(s); return c === s ? extLink(s, url, title) : extLink(c, url, s + ' — ' + (title || url)); }
// Per-browser preferences (open tabs, theme, chosen filters).
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};

const fmtSec = ms => ms == null ? '—' : (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s';
const fmtNum = n => n == null ? '—' : n.toLocaleString();
const fmtTps = n => n == null ? '—' : n.toFixed(1);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// Icon of custom scopes (tabs, Scopes page, dialogs): four tiles.
const CUSTOM_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>' +
  '<rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';
