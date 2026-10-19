// Where AI_SCOPE keeps its own files (installed scopes + saved history).
// Outside the app folder, so updates (npx downloads a fresh copy) never touch them.
// Default: ~/.ai_scope (C:\Users\<you>\.ai_scope on Windows). Override with AI_SCOPE_DATA or --data-dir.
// No dependencies; conservative JS for older Node versions.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.resolve(process.env.AI_SCOPE_DATA || path.join(os.homedir(), '.ai_scope'));
const LEGACY_DIR = path.join(__dirname, 'data'); // where older versions kept it

function ensure() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* exists */ }
}

// One-time move: copy files from the old <app>/data folder if the new folder doesn't have them yet.
function migrate() {
  let names = [];
  try { names = fs.readdirSync(LEGACY_DIR); } catch (e) { return; }
  ensure();
  names.forEach(function (n) {
    const from = path.join(LEGACY_DIR, n);
    const to = path.join(DATA_DIR, n);
    try {
      if (!fs.statSync(from).isFile() || fs.existsSync(to)) return;
      fs.copyFileSync(from, to);
      console.log('[data] copied ' + n + ' from ' + LEGACY_DIR);
    } catch (e) { console.log('[data] could not copy ' + n + ': ' + e.message); }
  });
}

ensure();
migrate();

module.exports = { DATA_DIR: DATA_DIR, file: function (n) { return path.join(DATA_DIR, n); }, ensure: ensure };
