// Tiny auto-restart runner (works on any Node version, no dependencies).
// - Restarts server.js whenever a .js/.html/.css/.json file in this folder, web/ or web/js/ changes
//   (the restart also makes open dashboards reload themselves).
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

function watch(dir, prefix) {
  try {
    fs.watch(dir, function (event, file) {
      if (file && /\.(js|html|css|json)$/.test(file) && file !== 'dev.js') restart(prefix + file);
    });
  } catch (e) { console.log('[dev] cannot watch ' + dir + ': ' + e.message); }
}
watch(__dirname, '');
watch(path.join(__dirname, 'web'), 'web/');
watch(path.join(__dirname, 'web', 'js'), 'web/js/');

start();
