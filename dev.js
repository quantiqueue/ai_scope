// Tiny auto-restart runner (works on any Node version, no dependencies).
// - Restarts server.js whenever a .js/.html/.css/.json file in this folder changes.
// - If server.js crashes, it is restarted automatically after 2 seconds.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let child = null;
let changeTimer = null;
let crashTimer = null;
let restarting = false;

function start() {
  clearTimeout(crashTimer);
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { stdio: 'inherit' });
  const me = child;
  me.on('exit', function (code) {
    if (child !== me) return; // an old process we replaced on purpose
    child = null;
    if (restarting) { restarting = false; start(); return; }
    if (code === 0) { console.log('[dev] server stopped (ai-scope --stop / Stop button) - exiting'); process.exit(0); }
    console.log('[dev] server exited (code ' + code + ') - restarting in 2s...');
    crashTimer = setTimeout(start, 2000);
  });
}

function restart(file) {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(function () {
    console.log('\n[dev] ' + (file || 'file') + ' changed - restarting...');
    if (child) { restarting = true; child.kill(); }
    else start(); // not running (e.g. crashed) - start right away
  }, 300); // debounce: editors often fire several events per save
}

fs.watch(__dirname, function (event, file) {
  if (file && /\.(js|html|css|json)$/.test(file) && file !== 'dev.js') restart(file);
});

start();
