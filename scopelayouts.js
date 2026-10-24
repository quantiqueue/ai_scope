// Saved layouts of the scope pages (AI_SCOPE-020): every scope page (Hardware, Processes, Bionic, ...) can be edited like a
// custom scope - its lenses, their order, rows and settings. Saved in the data folder as scope-layouts.json, so every
// browser and the app window see the same; a scope without a saved layout shows its built-in default (web/js/<scope>.js).
// { "<scope id>": { "lenses": [{ "lens": "processes.cpu", "settings": {}, "row": true? }] } }. A scope page may only hold
// that scope's own lenses. No dependencies; conservative JS.
'use strict';
const fs = require('fs');
const paths = require('./paths');
const customscopes = require('./customscopes');
const FILE = paths.file('scope-layouts.json');
let layouts = {};

function load() {
  try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); layouts = d && typeof d === 'object' && !Array.isArray(d) ? d : {}; }
  catch (e) { layouts = {}; }
}
// Written to a temporary file first, then renamed over the old one (no half-written file after a crash).
function save() {
  paths.ensure();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(layouts, null, 2));
  fs.renameSync(tmp, FILE);
}
function list() { return layouts; }
// save { scope, lenses } - scopeIds: the catalog's scope ids (only real scopes get a layout)
function set(input, scopeIds) {
  const scope = input && String(input.scope || '');
  if (scopeIds.indexOf(scope) < 0) return { ok: false, error: 'Unknown scope' };
  const lenses = customscopes.cleanLenses(input.lenses);
  if (!lenses) return { ok: false, error: 'Bad lens list' };
  if (lenses.some(function (l) { return l.lens.split('.')[0] !== scope; })) return { ok: false, error: 'A scope page can only hold its own lenses' };
  layouts[scope] = { lenses: lenses };
  try { save(); } catch (e) { return { ok: false, error: 'Could not save: ' + e.message }; }
  return { ok: true };
}
// reset { scope }: back to the built-in default
function reset(input) {
  const scope = input && String(input.scope || '');
  if (!layouts[scope]) return { ok: true };
  delete layouts[scope];
  try { save(); } catch (e) { return { ok: false, error: 'Could not save: ' + e.message }; }
  return { ok: true };
}
load();
// AI_SCOPE-023 kept scope-page lens settings in lens-settings.json; the layouts above replace it (AI_SCOPE-020).
try { fs.unlinkSync(paths.file('lens-settings.json')); console.log('[layouts] removed the old lens-settings.json (now part of scope-layouts.json)'); } catch (e) { /* not there */ }
module.exports = { list: list, set: set, reset: reset };
