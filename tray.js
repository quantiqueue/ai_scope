// AI_SCOPE-111: the Windows system tray icon.
// server.js calls start() once its port is listening; tray.ps1 draws the icon and its menu.
// Rules this keeps:
//  - the tray belongs to the server process that started it: it appears whenever AI_SCOPE runs (installed
//    --app, a plain console run, the login item, or the dev copy) and it goes away when this process ends -
//    tray.ps1 holds a handle to this process and takes the icon down itself. Never hard-kill the shipped
//    helper from here: on Windows kill() is TerminateProcess, so the helper never reaches $notify.Dispose()
//    and Windows keeps showing an icon whose process is gone until the mouse crosses it. Only a stand-in
//    script (a probe pointing start() at its own helper) is killed, because a stand-in has no such watch;
//  - Windows only, and it never takes anything with it: every failure is one logged line and AI_SCOPE runs on
//    exactly as before (no interactive desktop, a restricted PowerShell, a missing file);
//  - the menu's two items are loopback calls to this same server, so no paths or command lines are handed to
//    PowerShell - nothing here can be quoted wrong.
// Not a user setting (user, 2026-11-06): AI_SCOPE_TRAY=0 exists for CI and for throwaway test instances only.
'use strict';
const path = require('path');
const fs = require('fs');
const spawn = require('child_process').spawn;

const SCRIPT = 'tray.ps1';
const ICON = path.join('assets', 'ai_scope.ico');

let child = null;

function log(msg) { console.log('[tray] ' + msg); }

// opts: { port, version, script?, icon? } - the last two exist so a probe can point at a stand-in.
function start(opts) {
  if (process.platform !== 'win32') return null;
  if (String(process.env.AI_SCOPE_TRAY || '') === '0') { log('off (AI_SCOPE_TRAY=0) - no icon'); return null; }
  if (child) return child.pid;   // one helper per AI_SCOPE process: a second start would draw a second icon
  const script = opts.script || path.join(__dirname, SCRIPT);
  if (!fs.existsSync(script)) { log('no ' + SCRIPT + ' in this copy - no icon'); return null; }
  const icon = opts.icon || path.join(__dirname, ICON);
  const args = ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
                '-File', script, '-Port', String(opts.port), '-Version', String(opts.version),
                '-Icon', icon, '-ParentPid', String(process.pid)];
  try {
    // Not detached on purpose: `detached: true` makes powershell.exe hand off to a grandchild that stays behind
    // after the child we can see reports exit 0, so the icon would outlive AI_SCOPE and could not be killed.
    // Attached + windowsHide is the same shape hwstats.js uses for its long-running PowerShell loops.
    child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { log('could not start: ' + e.message + ' - AI_SCOPE runs on without an icon'); return null; }
  const me = child;
  // A probe or test pointing start() at its own stand-in script: those have no parent watch in them, so only
  // they may be killed here. The shipped tray.ps1 takes its own icon down.
  me.standIn = !!opts.script;
  const note = function (line) { const s = String(line).replace(/\s+$/, ''); if (s) log(s); };
  if (me.stdout) me.stdout.setEncoding('utf8');
  if (me.stderr) me.stderr.setEncoding('utf8');
  if (me.stdout) me.stdout.on('data', note);
  if (me.stderr) me.stderr.on('data', note);
  me.on('error', function (e) { log('the tray helper could not run: ' + e.message); if (child === me) child = null; });
  me.on('exit', function (code) {
    if (child === me) child = null;
    // Per-child, not a module flag: a helper this process put down on purpose (an AI_SCOPE stop, a restart, a
    // new helper taking over) is silent; any other exit is worth the one line.
    if (me.putDown) return;
    log('the tray icon stopped (exit ' + code + ') - AI_SCOPE keeps running; start it again to get the icon back');
  });
  // Unref everything the helper holds open, so a helper that outlives its purpose can never be the reason an
  // AI_SCOPE process is still running (the server's own handles keep it alive, and that is the only reason).
  if (me.unref) me.unref();
  if (me.stdout && me.stdout.unref) me.stdout.unref();
  if (me.stderr && me.stderr.unref) me.stderr.unref();
  return me.pid;
}

// The icon goes down with this process (Ctrl+C, the Stop button, ai_scope --stop, Restart Now, a dev restart).
// No kill() for the shipped helper: a hard kill skips its Dispose call, and Windows then keeps showing an icon
// whose process is gone until the mouse crosses it. That helper holds a handle to this process and closes itself
// within 500 ms of us exiting. A stand-in helper (a probe) has no such watch, so only those get killed.
function stop() {
  if (!child) return false;
  const c = child; child = null;
  c.putDown = true;           // this exit is ours: the handler stays quiet about it
  if (!c.standIn) return true;
  try { c.kill(); } catch (e) { return false; }
  return true;
}

function state() { return child ? { on: true, pid: child.pid } : { on: false }; }

process.on('exit', stop);   // synchronous, and the only guaranteed hook on process.exit()

module.exports = { start: start, stop: stop, state: state };
