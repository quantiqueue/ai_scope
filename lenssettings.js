// Lens settings on the built-in / app scope pages (AI_SCOPE-023, the pattern for AI_SCOPE-020): the values chosen with a
// lens's cog, saved in the data folder as lens-settings.json so every browser and the app window see the same.
// { "processes.vram": { "group": "app", "card": 1 }, ... } - key = the lens's slot on its page ("<page>.<slot>").
// (Lenses on custom scopes keep their settings in custom-scopes.json instead.) No dependencies; conservative JS.
'use strict';
const fs = require('fs');
const paths = require('./paths');
const FILE = paths.file('lens-settings.json');
const MAX_SLOTS = 200;
let slots = {};

function load() {
  try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); slots = d && typeof d === 'object' && !Array.isArray(d) ? d : {}; }
  catch (e) { slots = {}; }
}
function save() {
  paths.ensure();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(slots, null, 2));
  fs.renameSync(tmp, FILE);
}
// Small flat objects only (same rules as custom scopes' lens settings).
function clean(st) {
  const out = {};
  if (!st || typeof st !== 'object') return out;
  Object.keys(st).slice(0, 20).forEach(function (k) {
    const v = st[k];
    if (/^[a-zA-Z0-9_]+$/.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) out[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  });
  return out;
}
function list() { return slots; }
// set { slot, settings }
function set(input) {
  const slot = input && String(input.slot || '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(slot)) return { ok: false, error: 'Bad lens slot' };
  if (!slots[slot] && Object.keys(slots).length >= MAX_SLOTS) return { ok: false, error: 'Too many saved lens settings' };
  slots[slot] = clean(input.settings);
  try { save(); } catch (e) { return { ok: false, error: 'Could not save: ' + e.message }; }
  return { ok: true };
}
load();
module.exports = { list: list, set: set };
