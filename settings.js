// App-wide settings (AI_SCOPE-010): the "AI_SCOPE Settings" dialog's values, saved by the server.
// One file per section in the data folder (settings-general.json, settings-appearance.json,
// settings-engine.json, settings-server.json); About has none - its text is static and lives in the page.
// A saved value beats the launch flags: the flags are the global default, the settings are local and win
// (user, 2026-10-27). Port and data dir stay CLI-only.
// Anything that changes who can reach AI_SCOPE or whether it runs (network access, start at login, allowed
// host names, Stop, Restart) is this-PC-only, like /api/stop (user decision, 2026-10-27).
// No dependencies; conservative JS.
'use strict';
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const startup = require('./bin/startup');
const PKG_VERSION = require('./package.json').version;   // shown by the Server section's static "AI_SCOPE Server Version" line

// Types: 'scope' = Home or an installed scope id, 'choice' (options), 'number' (seconds, with a unit), 'bool', 'text'.
// local: only this computer may change it. dyn(f) = the value shown when nothing was saved yet.
const SECTIONS = [
  { id: 'general', label: 'General', keys: [
    { key: 'landing', label: 'Default Page', type: 'scope', def: 'home',
      info: 'Which page opens when starting AI_SCOPE. The tabs stay in the same order.' },
  ] },
  { id: 'appearance', label: 'Appearance', keys: [
    { key: 'theme', label: 'Theme', type: 'choice', def: 'default',
      options: [{ value: 'default', label: 'Default (follows the OS)' }, { value: 'dark', label: 'Dark' },
                { value: 'magenta', label: 'Magenta' }, { value: 'neo', label: 'Neo' }, { value: 'eva', label: 'EVA' }],
      info: 'Default follows your OS light / dark setting. Saved for every device that opens AI_SCOPE, not just this browser.' },
  ] },
  { id: 'engine', label: 'Engine', keys: [
    { key: 'processEvery', label: 'Process Refresh Rate', type: 'number', def: 5, min: 2, max: 60, unit: ' s',
      info: 'How often AI_SCOPE samples the process-level numbers: Top CPU, Top RAM, Top GPU, Top VRAM, Top Shared VRAM and Top Disk I/O come from one sample, so this rate moves all of them together. Lower numbers refresh sooner and cost more CPU.' },
  ] },
  { id: 'server', label: 'Server', keys: [
    { key: 'networkAccess', label: 'Allow Network Access', type: 'bool', local: true,
      info: 'Allow other devices on your network to open AI_SCOPE. Takes effect when AI_SCOPE next starts.' },
    { key: 'startAtLogin', label: 'Start at login', type: 'bool', local: true,
      info: 'Starts AI_SCOPE when you log in to your computer, or removes it. Applies the next time you log in.' },
    { key: 'allowedHosts', label: 'Allowed host names', type: 'text', local: true, def: '',
      info: 'Extra names AI_SCOPE answers, comma-separated - only needed when something (a reverse proxy) stands in front of it. Leave empty for the usual setup.' },
  ] },
  { id: 'about', label: 'About', keys: [
    // Read-only row at the top of About (its text is static and lives in the page; only the version
    // travels through describe(), so it always reports the running server's package.json).
    { key: 'serverVersion', label: 'AI_SCOPE Server Version', type: 'static', def: PKG_VERSION },
  ] },
];
const FIELD_BY = {};
SECTIONS.forEach(function (s) { (s.keys || []).forEach(function (f) { f.section = s.id; FIELD_BY[s.id + '/' + f.key] = f; }); });

const FILE_OF = function (id) { return paths.file('settings-' + id + '.json'); };
const saved = {};   // section id -> object read from its file

// What the launch handed us (bin/ai_scope.js / dev.js), as fallbacks when nothing is saved yet.
// AI_SCOPE-069: the old AI_SCOPE_ALLOWED_HOSTS env is gone - the allowedHosts setting's own file is the only source.
let launch = { host: null, port: null };
let scopeOk = function () { return true; };   // server.js fills this from the installed scopes
let procsPace = null;                          // engine.processEvery applies through this
let pending = [];   // keys changed this boot that still need AI_SCOPE to restart (cleared by a restart or a revert)
function read(id) {
  try {
    const v = JSON.parse(fs.readFileSync(FILE_OF(id), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) { return {}; }
}
function write(id) {
  paths.ensure();
  try { fs.writeFileSync(FILE_OF(id), JSON.stringify(saved[id], null, 2)); return true; }
  catch (e) { console.log('[settings] could not save ' + id + ': ' + e.message); return false; }
}
function load() { SECTIONS.forEach(function (s) { saved[s.id] = read(s.id); }); }

function sectionOf(id) { const s = SECTIONS.filter(function (x) { return x.id === id; })[0]; return s; }
function find(section, key) {
  const s = sectionOf(section);
  if (!s) return null;
  return (s.keys || []).filter(function (f) { return f.key === key; })[0];
}
// The saved value, or the launch / built-in default.
function value(field) {
  const s = saved[field.section];
  const v = s && s[field.key] !== undefined ? s[field.key] : undefined;
  if (v !== undefined) return v;
  if (field.launch != null) return field.launch;
  return field.def;
}
function current(field) {
  if (field.dyn) return field.dyn();
  return value(field);
}

// ---------- The dialog's data ----------
function describe() {
  return SECTIONS.map(function (s) {
    return { id: s.id, label: s.label, keys: (s.keys || []).map(function (f) {
      const v = current(f);
      return { key: f.key, label: f.label, type: f.type, unit: f.unit || null, info: f.info || null,
               local: !!f.local, options: f.options || null,
               min: f.min, max: f.max, value: v, savedValue: (saved[s.id] || {})[f.key],
               restartPending: pending.indexOf(f.section + '.' + f.key) >= 0 || needsRestart(f, v) };
    }) };
  });
}
function list() {
  const out = {};
  SECTIONS.forEach(function (s) {
    (s.keys || []).forEach(function (f) {
      const v = current(f);
      out[f.key] = v;
    });
  });
  return out;
}

// ---------- Changing one value (on blur, one change at a time) ----------
function change(section, key, v, local) {
  const f = find(section, key);
  if (!f) return { ok: false, error: 'Unknown setting: ' + section + '/' + key };
  if (f.local && !local) return { ok: false, error: 'Only allowed from this computer' };
  const got = prepare(f, v);
  if (got.error) return { ok: false, errors: { [key]: got.error } };
  if (!saved[section]) saved[section] = {};
  saved[section][key] = got.value;
  if (!write(section)) return { ok: false, error: 'Could not save ' + section + ' (check the folder is writable)' };
  const restart = apply(f, got.value);
  f.pending = restart;                 // stays with the setting until AI_SCOPE restarts or the value is reverted
  return { ok: true, restart: restart, settings: describe(), all: list() };
}
function prepare(f, v) {
  if (f.type === 'static') return { value: null, error: 'This row is information only - nothing to change' };
  if (f.type === 'bool') return { value: v === true || v === 1 || v === 'true' || v === 'on', error: null };
  if (f.type === 'number') {
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    if (!(n >= f.min && n <= f.max)) return { value: null, error: 'Pick a whole number from ' + f.min + ' to ' + f.max + ' seconds' };
    return { value: Math.round(n), error: null };
  }
  if (f.type === 'choice') {
    const ok = (f.options || []).filter(function (o) { return o.value === v; })[0];
    if (!ok) return { value: null, error: 'Pick one of the listed values' };
    return { value: ok.value, error: null };
  }
  if (f.type === 'scope') {
    const s = String(v || '');
    if (s !== 'home' && !scopeOk(s)) return { value: null, error: 'Pick Home or a scope that is installed' };
    return { value: s, error: null };
  }
  // text (the allowed host names)
  const s = String(v || '').slice(0, 500);
  if (/[^A-Za-z0-9.,: \-]/.test(s)) return { value: null, error: 'Names and commas only' };
  return { value: s.trim(), error: null };
}
// What a change needs right away; true = AI_SCOPE has to restart for it to take effect.
// Compared against the host this process is BOUND to (not the launch flag), so both directions of the
// Network Access switch ask the same way. The answer is remembered on the setting (f.pending) so the
// row keeps its Restart Required line across re-opens until AI_SCOPE actually restarts (or is reverted).
function needsRestart(f, v) {
  if (f.key === 'networkAccess') return (!!v) !== (launch.host === '0.0.0.0' || launch.host === '::');
  return false;
}
function apply(f, v) {
  if (f.key === 'processEvery') { if (procsPace) procsPace(v * 1000); return false; }
  if (f.key === 'allowedHosts') { hostcheck.setExtraHosts(splitHosts(v)); return false; }
  if (f.key === 'startAtLogin') {
    try { v ? startup.install([]) : startup.uninstall(); } catch (e) { console.log('[settings] start at login: ' + e.message); }
    return false;
  }
  return needsRestart(f, v);
}
function splitHosts(s) {
  return String(s || '').split(',').map(function (h) { return h.trim().toLowerCase(); }).filter(Boolean);
}

// ---------- Boot: read the files and hand the values out ----------
const hostcheck = require('./hostcheck');
function boot(launchHost, launchPort) {   // AI_SCOPE-069: no launchHosts anymore - settings-only for allowed names
  load();
  launch = { host: launchHost, port: launchPort };
  SECTIONS.forEach(function (s) { (s.keys || []).forEach(function (f) { f.pending = false; }); });  // a new boot cleared any owed restart
  const na = SECTIONS.filter(function (s) { return s.id === 'server'; })[0].keys.filter(function (f) { return f.key === 'networkAccess'; })[0];
  na.launch = launchHost === '0.0.0.0' || launchHost === '::';
  // "Start at login" shows what the login item actually is, until someone changes it.
  const sl = find('server', 'startAtLogin');
  sl.dyn = function () { if ((saved.server || {})[sl.key] !== undefined) return saved.server[sl.key]; try { return fs.existsSync(startup.target()); } catch (e) { return false; } };
  const pe = find('engine', 'processEvery');
  if (pe && procsPace) procsPace(current(pe) * 1000);
  hostcheck.setExtraHosts(splitHosts(current(find('server', 'allowedHosts'))));
}
function setScopeChecker(fn) { if (fn) scopeOk = fn; }
function setBound(host) { launch.host = host; }   // server.js calls this once the bind is decided
function setPaceApplier(fn) { procsPace = fn; }
function savedValue(key) {   // the value a file saved, or undefined when that setting was never changed
  for (var i = 0; i < SECTIONS.length; i++) {
    const s = saved[SECTIONS[i].id];
    if (s && s[key] !== undefined) return s[key];
  }
  return undefined;
}
module.exports = { boot: boot, describe: describe, list: list, change: change, sections: SECTIONS, find: find,
  setScopeChecker: setScopeChecker, setPaceApplier: setPaceApplier, setBound: setBound, savedValue: savedValue };
