// Scope manager: which scopes exist (scopes.json), which are installed (~/.ai_scope/installed.json),
// and starting/stopping the server modules that collect each scope's data.
// No dependencies; conservative JS for older Node versions.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const CATALOG_FILE = path.join(__dirname, 'scopes.json');
const paths = require('./paths');                       // data folder: ~/.ai_scope
const STATE_FILE = paths.file('installed.json');

let catalog = [];        // scope definitions from scopes.json
let state = {};          // id -> { installedAt, settings }
const errors = {};       // id -> start error message

function loadCatalog() {
  try {
    const d = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    catalog = (d.scopes || []).filter(function (s) { return s && s.id && s.name; });
  } catch (e) {
    console.log('[scopes] could not read scopes.json: ' + e.message);
    catalog = [{ id: 'hardware', name: 'Hardware', desc: 'Live CPU, RAM, GPU and VRAM usage', builtin: true, modules: [], settings: [] }];
  }
}
function loadState() {
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch (e) { state = {}; }
}
function saveState() {
  paths.ensure();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function find(id) { return catalog.filter(function (s) { return s.id === id; })[0] || null; }
function isInstalled(id) { const sc = find(id); return !!sc && (!!sc.builtin || !!state[id]); }

// "~" -> home folder, %NAME% -> environment variable
function expand(v) {
  v = String(v == null ? '' : v).trim();
  if (v === '~' || v.indexOf('~/') === 0 || v.indexOf('~\\') === 0) v = path.join(os.homedir(), v.slice(1));
  return v.replace(/%([^%]+)%/g, function (m, n) { return process.env[n] != null ? process.env[n] : m; });
}
function defaultOf(f) {
  if (f.default == null) return '';
  return f.type === 'folder' && f.default !== '' ? path.normalize(expand(f.default)) : f.default;
}

// Check the values from the install form. Returns { settings, errors } (errors: key -> message).
function validate(sc, input) {
  input = input || {};
  const out = {}, errs = {};
  (sc.settings || []).forEach(function (f) {
    let v = input[f.key] !== undefined ? input[f.key] : defaultOf(f);
    v = v == null ? '' : String(v).trim();
    if (v === '') {
      if (f.required) errs[f.key] = 'Required';
      out[f.key] = f.type === 'number' ? null : '';
      return;
    }
    if (f.type === 'url') {
      let u = null;
      try { u = new URL(/^[a-z]+:\/\//i.test(v) ? v : 'http://' + v); } catch (e) { /* invalid */ }
      if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) errs[f.key] = 'Not a valid http:// address';
      else v = u.origin + u.pathname.replace(/\/+$/, '');
    } else if (f.type === 'folder') {
      v = path.normalize(expand(v));
      if (f.mustExist) {
        let ok = false;
        try { ok = fs.statSync(v).isDirectory(); } catch (e) { /* missing */ }
        if (!ok) errs[f.key] = 'Folder not found';
      }
    } else if (f.type === 'number') {
      const n = Number(v);
      if (!isFinite(n) || Math.floor(n) !== n) errs[f.key] = 'Must be a whole number';
      else if ((f.min != null && n < f.min) || (f.max != null && n > f.max)) errs[f.key] = 'Must be between ' + f.min + ' and ' + f.max;
      v = n;
    }
    out[f.key] = v;
  });
  return { settings: out, errors: errs };
}

function modulesOf(sc) {
  return (sc.modules || []).map(function (name) { return require('./' + String(name).replace(/[^\w-]/g, '')); });
}
function startScope(id) {
  const sc = find(id);
  if (!sc) return;
  delete errors[id];
  const settings = (state[id] && state[id].settings) || {};
  try { modulesOf(sc).forEach(function (m) { if (m.start) m.start(settings); }); console.log('[scopes] started ' + id); }
  catch (e) { errors[id] = e.message; console.log('[scopes] ' + id + ' failed to start: ' + e.message); }
}
function stopScope(id) {
  const sc = find(id);
  if (!sc) return;
  try { modulesOf(sc).forEach(function (m) { if (m.stop) m.stop(); }); } catch (e) { console.log('[scopes] ' + id + ' stop: ' + e.message); }
}

// Install (or re-install with new settings).
function install(id, input) {
  const sc = find(id);
  if (!sc) return { ok: false, error: 'Unknown scope: ' + id };
  if (sc.builtin) return { ok: false, error: sc.name + ' is built in' };
  const v = validate(sc, input);
  if (Object.keys(v.errors).length) return { ok: false, errors: v.errors };
  if (state[id]) stopScope(id);
  state[id] = { installedAt: (state[id] && state[id].installedAt) || Date.now(), settings: v.settings };
  saveState();
  startScope(id);
  console.log('[scopes] installed ' + id + ' ' + JSON.stringify(v.settings));
  return { ok: true };
}
function remove(id) {
  const sc = find(id);
  if (!sc) return { ok: false, error: 'Unknown scope: ' + id };
  if (sc.builtin) return { ok: false, error: sc.name + " is built in and can't be removed" };
  if (!state[id]) return { ok: true };
  stopScope(id);
  delete state[id];
  delete errors[id];
  saveState();
  console.log('[scopes] removed ' + id);
  return { ok: true };
}

// What the page gets: the catalog + install state (defaults resolved, current values for installed scopes).
function list() {
  return catalog.map(function (sc) {
    const st = state[sc.id];
    return {
      id: sc.id, name: sc.name, desc: sc.desc || '', icon: sc.icon || '', logo: !!sc.logo, builtin: !!sc.builtin,
      installed: isInstalled(sc.id), installedAt: st ? st.installedAt : null, error: errors[sc.id] || null,
      settings: (sc.settings || []).map(function (f) {
        return { key: f.key, label: f.label || f.key, type: f.type || 'text', placeholder: f.placeholder || '', help: f.help || '',
                 required: !!f.required, min: f.min, max: f.max, default: defaultOf(f),
                 value: st && st.settings && st.settings[f.key] != null ? st.settings[f.key] : defaultOf(f) };
      }),
    };
  });
}

function init() {
  loadCatalog();
  loadState();
  catalog.forEach(function (sc) { if (!sc.builtin && state[sc.id]) startScope(sc.id); });
  const ids = catalog.filter(function (sc) { return isInstalled(sc.id); }).map(function (sc) { return sc.id; });
  console.log('[scopes] installed: ' + ids.join(', '));
}

module.exports = { init: init, list: list, install: install, remove: remove, isInstalled: isInstalled };
