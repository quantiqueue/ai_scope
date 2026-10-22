// Custom scopes (AI_SCOPE-003): user-named pages built from lenses of the app scopes and SYSTEM.
// Saved in the data folder as custom-scopes.json, so every browser and the app window see the same ones.
// Only the layout is stored: [{ id, name, createdAt, lenses: [{ lens: 'strata.requests', settings: {}, row: true? }] }].
// No dependencies; conservative JS for older Node versions.
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const paths = require('./paths');
const FILE = paths.file('custom-scopes.json');

const MAX_NAME = 40, MAX_LENSES = 60;
let scopes = [];

// A file that exists but can't be read (half-written, edited by hand) is kept as custom-scopes.json.bad-<time>
// before anything overwrites it, so the layouts in it can still be recovered.
function load() {
  let text;
  try { text = fs.readFileSync(FILE, 'utf8'); } catch (e) { scopes = []; return; }   // no file yet
  try {
    const d = JSON.parse(text);
    if (!d || !Array.isArray(d.scopes)) throw new Error('no "scopes" list');
    scopes = d.scopes.filter(function (s) { return s && /^c-[a-z0-9]+$/.test(s.id) && typeof s.name === 'string' && Array.isArray(s.lenses); });
  } catch (e) {
    scopes = [];
    const bad = FILE + '.bad-' + new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.copyFileSync(FILE, bad); console.log('[custom] could not read ' + FILE + ' (' + e.message + '); kept a copy as ' + bad); }
    catch (e2) { console.log('[custom] could not read ' + FILE + ' (' + e.message + ') and could not back it up: ' + e2.message); }
  }
}
// Written to a temporary file first, then renamed over the old one, so a crash mid-write never leaves half a file.
function save() {
  paths.ensure();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ scopes: scopes }, null, 2));
  fs.renameSync(tmp, FILE);
}
function find(id) { return scopes.filter(function (s) { return s.id === id; })[0] || null; }

function checkName(name, selfId) {
  name = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  if (!name) return { error: 'Required' };
  if (name.length > MAX_NAME) return { error: 'At most ' + MAX_NAME + ' characters' };
  const lower = name.toLowerCase();
  if (scopes.some(function (s) { return s.id !== selfId && s.name.toLowerCase() === lower; })) return { error: 'There is already a custom scope with this name' };
  return { name: name };
}
// Lens list from the page: keep only well-formed entries (lens id + small flat settings object).
function cleanLenses(list) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, MAX_LENSES).filter(function (l) {
    return l && typeof l.lens === 'string' && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(l.lens);
  }).map(function (l) {
    const st = {};
    if (l.settings && typeof l.settings === 'object') {
      Object.keys(l.settings).slice(0, 20).forEach(function (k) {
        const v = l.settings[k];
        if (/^[a-zA-Z0-9_]+$/.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) st[k] = typeof v === 'string' ? v.slice(0, 200) : v;
      });
    }
    const out = { lens: l.lens, settings: st };
    if (l.row === true) out.row = true;   // starts a new row in the grid
    return out;
  });
}

function create(input) {
  const n = checkName(input && input.name);
  if (n.error) return { ok: false, errors: { name: n.error } };
  let id;
  do { id = 'c-' + crypto.randomBytes(5).toString('hex'); } while (find(id));
  const sc = { id: id, name: n.name, createdAt: Date.now(), lenses: [] };
  scopes.push(sc);
  save();
  console.log('[custom] created ' + id + ' "' + n.name + '"');
  return { ok: true, id: id };
}
function update(input) {
  const sc = find(input && input.id);
  if (!sc) return { ok: false, error: 'This custom scope no longer exists' };
  if (input.name !== undefined) {
    const n = checkName(input.name, sc.id);
    if (n.error) return { ok: false, errors: { name: n.error } };
    sc.name = n.name;
  }
  if (input.lenses !== undefined) {
    const l = cleanLenses(input.lenses);
    if (!l) return { ok: false, error: 'Bad lens list' };
    sc.lenses = l;
  }
  save();
  return { ok: true };
}
function remove(input) {
  const sc = find(input && input.id);
  if (!sc) return { ok: true };
  scopes = scopes.filter(function (s) { return s !== sc; });
  save();
  console.log('[custom] removed ' + sc.id + ' "' + sc.name + '"');
  return { ok: true };
}
function list() { return scopes; }

load();
module.exports = { list: list, create: create, update: update, remove: remove };
