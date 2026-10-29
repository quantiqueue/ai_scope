// AI_SCOPE-010: the "AI_SCOPE Settings" dialog, opened by the cog at the top-right (which replaced the theme
// palette button). A fixed dialog, not a page: the sections (General / Appearance / Engine / Server / About) are
// on the left, the section's settings on the right; on narrow screens the sections stack in one column instead.
// Every change saves as it is made (on blur) - one POST per change, { section, key, value }.
// Values live on the server (settings.js, one file per section in the data folder); this file only draws them.
// About has no settings: its text is static, plus the live line from /api/ping.
'use strict';

const settingsDlg = document.createElement('dialog');
settingsDlg.className = 'modal setdlg';
// The form holds and scrolls the settings; the Done button is a child of the dialog itself, outside the
// scrolled content, so it stays put in the bottom-right corner (user, 2026-10-27).
settingsDlg.innerHTML = '<form method="dialog" novalidate class="setForm"></form>' +
  '<div class="actions"><button type="button" class="btn" data-done>Done</button></div>';
document.body.appendChild(settingsDlg);
const setForm = settingsDlg.querySelector('form');

const SECTION_LABELS = { general: 'General', appearance: 'Appearance', engine: 'Engine', server: 'Server', about: 'About' };
let sections = [];                 // what the server last described (its schema + current values)
let currentSection = 'general';
const SETTINGS_INLINE = () => window.AI_SCOPE_SETTINGS || {};

// ---------- Options for the scope row: Home first, then the installed and custom scopes ----------
function scopeOptions() {
  const out = [{ value: 'home', label: 'Home' }];
  SCOPES.forEach(sc => { if (sc.installed) out.push({ value: sc.id, label: sc.name || sc.id }); });
  CUSTOM.forEach(cs => out.push({ value: cs.id, label: cs.name }));
  return out;
}
const THEME_LABEL = { default: 'Default (follows the OS)', dark: 'Dark', magenta: 'Magenta', neo: 'Neo', eva: 'EVA' };

// ---------- The current value of a row (the page has it inlined, so no fetch to show it) ----------
function rowValue(f) {
  const w = SETTINGS_INLINE();
  const v = w[f.key];
  return v === undefined || v === null ? f.def : v;
}

// ---------- Drawing ----------
function rowHtml(f) {
  const id = 'set-' + f.key;
  let ctl;
  if (f.kind === 'static') {   // AI_SCOPE-010: information row (the Server section's version), laid out like the
                               // setting fields above it - field name on top, the value underneath. No control.
    return '<div class="field"><label>' + escH(f.label) + '</label>' +
      '<div class="setstatic">' + escH(f.value === undefined || f.value === null ? '' : f.value) + '</div>' +
      (f.info ? '<div class="help">' + escH(f.info) + '</div>' : '') +
      '<div class="ferr" data-err="' + f.key + '" hidden></div></div>';
  }
  if (f.kind === 'bool') {
    const on = !!rowValue(f);
    ctl = '<select id="' + id + '" name="' + f.key + '" data-key="' + f.key + '" data-section="' + f.section +
      '" data-kind="bool" autocomplete="off"><option value="off"' + (on ? '' : ' selected') + '>Off</option>' +
      '<option value="on"' + (on ? ' selected' : '') + '>On</option></select>';
  } else if (f.kind === 'number') {
    ctl = '<input id="' + id + '" name="' + f.key + '" data-key="' + f.key + '" data-section="' + f.section +
      '" data-kind="number" type="number" spellcheck="false" autocomplete="off" min="' + f.min + '" max="' + f.max +
      '" value="' + escH(String(rowValue(f))) + '">';
  } else if (f.kind === 'choice' || f.kind === 'scope') {
    const opts = f.kind === 'scope' ? scopeOptions() : (f.options || []);
    const cur = rowValue(f);
    ctl = '<select id="' + id + '" name="' + f.key + '" data-key="' + f.key + '" data-section="' + f.section +
      '" data-kind="' + f.kind + '" autocomplete="off">' +
      opts.map(o => '<option value="' + escH(o.value) + '"' + (o.value === cur ? ' selected' : '') + '>' +
        escH(f.kind === 'choice' ? (THEME_LABEL[o.value] || o.label) : o.label) + '</option>').join('') + '</select>';
  } else {   // text
    ctl = '<input id="' + id + '" name="' + f.key + '" data-key="' + f.key + '" data-section="' + f.section +
      '" data-kind="text" type="text" spellcheck="false" autocomplete="off" value="' + escH(String(rowValue(f) || '')) + '">';
  }
  return '<div class="field"><label for="' + id + '">' + escH(f.label + (f.unit ? ' (' + f.unit.trim() + ')' : '')) + '</label>' + ctl +
    (f.info ? '<div class="help">' + escH(f.info) + '</div>' : '') +
    (f.restartPending ? '<div class="restartflag">Server Restart Required</div>' : '') +
    '<div class="ferr" data-err="' + f.key + '" hidden></div></div>';
}

// Brand marks for the About page (simple-icons paths, single colour, so the theme can colour them).
const GH_MARK = '<svg viewBox="0 0 24 24" role="img" aria-label="AI_SCOPE on GitHub"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>';
const COFFEE_MARK = '<svg viewBox="0 0 24 24" role="img" aria-label="Buy Quantiqueue a coffee"><path d="M20.216 6.415l-.132-.666c-.119-.598-.388-1.163-1.001-1.379-.197-.069-.42-.098-.57-.241-.152-.143-.196-.366-.231-.572-.065-.378-.125-.756-.192-1.133-.057-.325-.102-.69-.25-.987-.195-.4-.597-.634-.996-.788a5.723 5.723 0 00-.626-.194c-1-.263-2.05-.36-3.077-.416a25.834 25.834 0 00-3.7.062c-.915.083-1.88.184-2.75.5-.318.116-.646.256-.888.501-.297.302-.393.77-.177 1.146.154.267.415.456.692.58.36.162.737.284 1.123.366 1.075.238 2.189.331 3.287.37 1.218.05 2.437.01 3.65-.118.299-.033.598-.073.896-.119.352-.054.578-.513.474-.834-.124-.383-.457-.531-.834-.473-.466.074-.96.108-1.382.146-1.177.08-2.358.082-3.536.006a22.228 22.228 0 01-1.157-.107c-.086-.01-.18-.025-.258-.036-.243-.036-.484-.08-.724-.13-.111-.027-.111-.185 0-.212h.005c.277-.06.557-.108.838-.147h.002c.131-.009.263-.032.394-.048a25.076 25.076 0 013.426-.12c.674.019 1.347.067 2.017.144l.228.031c.267.04.533.088.798.145.392.085.895.113 1.07.542.055.137.08.288.111.431l.319 1.484a.237.237 0 01-.199.284h-.003c-.037.006-.075.01-.112.015a36.704 36.704 0 01-4.743.295 37.059 37.059 0 01-4.699-.304c-.14-.017-.293-.042-.417-.06-.326-.048-.649-.108-.973-.161-.393-.065-.768-.032-1.123.161-.29.16-.527.404-.675.701-.154.316-.199.66-.267 1-.069.34-.176.707-.135 1.056.087.753.613 1.365 1.37 1.502a39.69 39.69 0 0011.343.376.483.483 0 01.535.53l-.071.697-1.018 9.907c-.041.41-.047.832-.125 1.237-.122.637-.553 1.028-1.182 1.171-.577.131-1.165.2-1.756.205-.656.004-1.31-.025-1.966-.022-.699.004-1.556-.06-2.095-.58-.475-.458-.54-1.174-.605-1.793l-.731-7.013-.322-3.094c-.037-.351-.286-.695-.678-.678-.336.015-.718.3-.678.679l.228 2.185.949 9.112c.147 1.344 1.174 2.068 2.446 2.272.742.12 1.503.144 2.257.156.966.016 1.942.053 2.892-.122 1.408-.258 2.465-1.198 2.616-2.657.34-3.332.683-6.663 1.024-9.995l.215-2.087a.484.484 0 01.39-.426c.402-.078.787-.212 1.074-.518.455-.488.546-1.124.385-1.766zm-1.478.772c-.145.137-.363.201-.578.233-2.416.359-4.866.54-7.308.46-1.748-.06-3.477-.254-5.207-.498-.17-.024-.353-.055-.47-.18-.22-.236-.111-.71-.054-.995.052-.26.152-.609.463-.646.484-.057 1.046.148 1.526.22.577.088 1.156.159 1.737.212 2.48.226 5.002.19 7.472-.14.45-.06.899-.13 1.345-.21.399-.072.84-.206 1.08.206.166.281.188.657.162.974a.544.544 0 01-.169.364zm-6.159 3.9c-.862.37-1.84.788-3.109.788a5.884 5.884 0 01-1.569-.217l.877 9.004c.065.78.717 1.38 1.5 1.38 0 0 1.243.065 1.658.065.447 0 1.786-.065 1.786-.065.783 0 1.434-.6 1.499-1.38l.94-9.95a3.996 3.996 0 00-1.322-.238c-.826 0-1.491.284-2.26.613z"/></svg>';

const ABOUT_TEXT = {
  made: 'Made by ',
  madeUrl: 'https://github.com/quantiqueue',
  support: 'Support Quantiqueue',
  repoUrl: 'https://github.com/quantiqueue/ai_scope',
  repoTip: 'AI_SCOPE on GitHub: releases, installers, report an issue.',
  coffeeUrl: 'https://buymeacoffee.com/quantiqueue',
  coffeeTip: 'Support AI_SCOPE: a coffee for the time spent on it.',
};
function aboutHtml() {
  // AI_SCOPE-010: the overview lead line was removed at the user's request (2026-10-28); About starts
  // under the server-described version row with the made-by line.
  return '<p class="setmade">Made by <a href="' + escH(ABOUT_TEXT.madeUrl) + '" target="_blank" rel="noopener" title="' + escH(ABOUT_TEXT.madeUrl) + '">Quantiqueue</a>.</p>' +
    '<h4 class="setsupport">' + escH(ABOUT_TEXT.support) + '</h4>' +
    '<div class="setbrand">' +
    '<a class="setbrand gh" href="' + escH(ABOUT_TEXT.repoUrl) + '" target="_blank" rel="noopener" title="' + escH(ABOUT_TEXT.repoTip) + '">' + GH_MARK + '<span class="sbn">AI_SCOPE on GitHub</span></a>' +
    '<a class="setbrand coffee" href="' + escH(ABOUT_TEXT.coffeeUrl) + '" target="_blank" rel="noopener" title="' + escH(ABOUT_TEXT.coffeeTip) + '">' + COFFEE_MARK + '<span class="sbn">Buy Quantiqueue a coffee</span></a>' +
    '</div>';
}

function bodyHtml(section) {
  // AI_SCOPE-010: About opens with the server-described read-only rows (the version), then its static text.
  if (section.id === 'about') return (section.keys || []).map(f => rowHtml(f)).join('') + aboutHtml();
  return (section.keys || []).map(f => rowHtml(f)).join('');
}

function renderDialog() {
  const narrow = window.innerWidth <= 640;
  const all = sections.concat([]);
  // AI_SCOPE-010 fix: the wide/narrow choice used to be baked into the markup (hidden="" on the other
  // sections at draw time), so shrinking the window while the dialog was open hid the tabs by CSS but
  // left the other sections display:none. Now every section is always in the DOM and the current one
  // carries .cur; the stylesheet decides - wide shows only .cur, narrow stacks all of them - so a
  // mid-session resize needs no rebuild.
  const blocks = all.map(s => '<section class="setsection' + (s.id === currentSection ? ' cur' : '') + '" data-section="' + s.id + '"><h3>' +
    escH(SECTION_LABELS[s.id] || s.label) + '</h3>' + bodyHtml(s) + '</section>');
  const tabs = narrow ? '' : '<nav class="settabs">' + all.map(s => '<button type="button" class="settab' +
    (s.id === currentSection ? ' active' : '') + '" data-tab="' + s.id + '">' + escH(SECTION_LABELS[s.id] || s.label) + '</button>').join('') + '</nav>';
  setForm.innerHTML = '<div class="sethead">' + GEAR_ICON + '<span>Settings</span></div>' +
    '<div class="setcols">' + tabs + '<div class="setbody">' + blocks.join('') + '</div></div>' +
    '<div class="formerr" hidden></div>';
  markClean();
  addServerActions();
}
// Remember what each control shows now, so blur / change only saves a real edit.
function markClean() {
  setForm.querySelectorAll('select,input').forEach(function (el) { el._cleanValue = el.value; });
}

// ---------- Opening / closing ----------
async function refresh() {
  try {
    const r = await fetch('/api/settings', { cache: 'no-store' });
    const j = await r.json();
    if (j && j.settings) {
      sections = j.settings.map(function (s) {
        return { id: s.id, label: s.label, keys: (s.keys || []).map(function (f) {
          const o = Object.assign({}, f); o.section = s.id;
          o.kind = f.type; if (o.value === undefined || o.value === null) o.def = o.value; else o.def = o.value;
          if (o.kind === 'choice' && o.options) o.options = o.options.map(function (x) { return { value: x.value, label: (THEME_LABEL[x.value] || x.label) }; });
          if (o.kind === 'scope') o.options = scopeOptions();
          return o;
        }) };
      });
    }
    if (!sections.some(function (s) { return s.id === 'about'; })) sections = sections.concat([{ id: 'about', label: 'About', keys: [] }]);
    return true;
  } catch (e) { return false; }
}

const settingsBtn = document.getElementById('settingsBtn');
if (settingsBtn) settingsBtn.addEventListener('click', function (e) {
  e.stopPropagation();
  currentSection = 'general';
  refresh().then(function () { renderDialog(); if (!settingsDlg.open) settingsDlg.showModal(); });
});
function openDialog() { if (!settingsDlg.open) settingsDlg.showModal(); }
function closeDialog() { if (settingsDlg.open) settingsDlg.close(); }

// ---------- One change, saved as it is made ----------
// A control is dirty when its current value differs from the value it was drawn with; a dirty control is
// committed on blur / change (the per-change save), and any that never blurred is flushed when the dialog closes.
function pendingField(el) {
  const kind = el.getAttribute('data-kind');
  const v = el.value;
  if (v === el._cleanValue) return undefined;
  if (kind === 'bool') return v === 'on';
  if (kind === 'number') {
    const n = parseInt(v, 10);
    if (!isFinite(n) || n < (+el.min) || n > (+el.max)) return null;      // typed but out of range
    return n;
  }
  return v;
}
function commitField(el) {
  const value = pendingField(el);
  if (value === undefined) { clearFieldError(el); return; }   // back to the value it was drawn with: a former error is over
  const key = el.getAttribute('data-key'), section = el.getAttribute('data-section');
  if (value === null) { fieldError(el, 'Pick a number from ' + el.min + ' to ' + el.max); return; }
  // One edit can be committed twice before the answer arrives: Tab fires the keydown commit AND the blur
  // commit, and a select fires change and then blur on the same edit. _cleanValue only updates on the
  // answer, so remember what this control already has in flight and ignore a second identical change.
  if (el._sendingValue !== undefined && String(el._sendingValue) === String(value)) return;
  el._sendingValue = value;
  postJson('/api/settings/change', { section: section, key: key, value: value }).then(function (r) {
    el._sendingValue = undefined;
    if (r && r.ok) {
      el._cleanValue = el.value;
      clearFieldError(el);
      if (r.settings) applyServerSections(r.settings);
      if (r.all) window.AI_SCOPE_SETTINGS = r.all;   // the page's inlined copy - the theme and landing read it
      afterChange(el, r);
      return;
    }
    fieldError(el, (r && r.error) || (r && r.errors && r.errors[key]) || 'Could not save');
  }).catch(function () { el._sendingValue = undefined; fieldError(el, 'Could not reach AI_SCOPE'); });
}
function flushPending() {
  setForm.querySelectorAll('select,input').forEach(function (el) {
    if (el.getAttribute('data-key') && pendingField(el) !== undefined) commitField(el);
  });
}
function applyServerSections(list) {
  sections = list.map(function (s) {
    return { id: s.id, label: s.label, keys: (s.keys || []).map(function (f) {
      const o = Object.assign({}, f); o.section = s.id; o.kind = f.type;
      o.def = (f.value === undefined || f.value === null) ? f.value : f.value;
      if (o.kind === 'scope') o.options = scopeOptions();
      return o;
    }) };
  });
  if (!sections.some(function (s) { return s.id === 'about'; })) sections = sections.concat([{ id: 'about', label: 'About', keys: [] }]);
}
function afterChange(el, r) {
  if (el.getAttribute('data-key') === 'theme') applyTheme((SETTINGS_INLINE()).theme || 'default');
  if (el.getAttribute('data-key') === 'landing') showTab();
  renderDialog();   // redraw from the fresh data, so a pending restart flag appears / clears where it belongs
}
function clearFieldError(el) {
  const box = setForm.querySelector('[data-err="' + el.getAttribute('data-key') + '"]');
  if (box) box.hidden = true;
  el.classList.remove('bad');
}
function fieldError(el, msg) {
  const box = setForm.querySelector('[data-err="' + el.getAttribute('data-key') + '"]');
  if (box) { box.textContent = msg; box.hidden = false; }
  el.classList.add('bad');
}
['blur', 'change'].forEach(function (evt) {
  setForm.addEventListener(evt, function (e) {
    const el = e.target;
    if (el && (el.tagName === 'SELECT' || el.tagName === 'INPUT') && el.getAttribute('data-key')) commitField(el);
  });
});
document.addEventListener('keydown', function (e) {
  if (!settingsDlg.open) return;
  if (e.key === 'Escape') { flushPending(); closeDialog(); if (settingsBtn) settingsBtn.focus(); return; }
  const el = e.target;
  if (el && (el.tagName === 'SELECT' || el.tagName === 'INPUT') && el.getAttribute('data-key')) {
    if (e.key === 'Enter' || e.key === 'Tab') commitField(el);
  }
});
setForm.addEventListener('click', function (e) {
  if (e.target.closest('[data-done]')) { closeDialog(); if (settingsBtn) settingsBtn.focus(); return; }
  const tab = e.target.closest('.settab');
  if (tab && tab.dataset.tab) { currentSection = tab.dataset.tab; renderDialog(); openDialog(); tab.focus(); return; }
  const act = e.target.closest('[data-act]');
  if (act) { serverAction(act.dataset.act); return; }
  const err = e.target.closest('.formerr') || e.target.closest('.seterr');
  if (err) err.hidden = true;
});
setForm.addEventListener('focus', function (e) {   // focus on the form itself: keyboard entry to the rows
  if (!e.target || e.target.getAttribute('data-key')) return;
}, true);

// Done is a child of the dialog (not of the scrolling form), so its handler sits on the dialog.
settingsDlg.addEventListener('click', function (e) {
  if (!e.target.closest('[data-done]')) return;
  flushPending();
  closeDialog();
  if (settingsBtn) settingsBtn.focus();
});
// AI_SCOPE-010: crossing the 640px line while the dialog is open needs one rebuild - the left-side
// section tabs only exist in the markup for wide screens (the stacked sections themselves are pure CSS).
let wasNarrow = window.innerWidth <= 640;
window.addEventListener('resize', function () {
  const narrow = window.innerWidth <= 640;
  if (narrow === wasNarrow) return;
  wasNarrow = narrow;
  if (settingsDlg.open) { renderDialog(); openDialog(); }
});
function addServerActions() {
  const s = setForm.querySelector('.setsection[data-section="server"]');
  if (!s || s.querySelector('[data-act="stop"]')) return;
  s.insertAdjacentHTML('beforeend', '<div class="seterr" hidden></div>' +
    '<div class="setactions"><button type="button" class="btn danger" data-act="stop">Stop AI_SCOPE</button>' +
    '<button type="button" class="btn" data-act="restart">Restart Now</button></div>');
}
function serverAction(act) {
  const btn = setForm.querySelector('[data-act="' + act + '"]');
  if (btn) btn.disabled = true;
  const url = act === 'stop' ? '/api/stop' : '/api/settings/restart';
  const opts = act === 'stop'
    ? { method: 'POST', headers: { 'X-AI-Scope': 'stop' } }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Scope': '1' }, body: '{}' };
  fetch(url, opts).then(function (r) { return r.json().catch(function () { return { ok: r.ok }; }); })
    .then(function (j) {
      if (j && j.ok) {
        if (act === 'restart') { closeDialog(); return; }   // AI_SCOPE comes back; the page reloads on its new boot id
        closeDialog();
        documentStopped();
        return;
      }
      if (btn) { btn.disabled = false; }
      const fe = setForm.querySelector('.seterr') || setForm.querySelector('.formerr');
      if (fe) { fe.textContent = (j && j.error) || 'AI_SCOPE did not accept this - ' + (act === 'stop' ? 'stop it from this computer, or use ai_scope --stop.' : 'start AI_SCOPE again from the command line.'); fe.hidden = false; }
    })
    .catch(function () {
      if (btn) btn.disabled = false;
      const fe = setForm.querySelector('.seterr') || setForm.querySelector('.formerr');
      if (fe) { fe.textContent = 'Could not reach AI_SCOPE.'; fe.hidden = false; }
    });
}
function documentStopped() {
  window.aiScopeStopped = true;
  const d = document.createElement('div');
  d.className = 'stopped';
  d.innerHTML = '<div><h2>AI_SCOPE has stopped</h2><p>You can close this window.<br>Start it again from the Start Menu, or with <code>ai_scope --app</code>.</p></div>';
  document.body.appendChild(d);
}

// The dialog's rows are drawn from the server's schema, so they stay in step with scopes installed / removed
// while it is open.
function resync() { if (!settingsDlg.open) return; refresh().then(function () { renderDialog(); openDialog(); }); }
CUSTOM_HOOKS.push(resync);
LAYOUT_HOOKS.push(resync);
refresh().then(renderDialog);   // draw the rows at load (the dialog itself stays closed until the cog is clicked)
