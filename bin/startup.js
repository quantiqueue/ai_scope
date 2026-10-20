// Start AI_SCOPE when you log in: Windows Startup folder, macOS LaunchAgent, Linux XDG autostart.
// What the login item runs:
//  - installed with install.ps1 / install.sh: the `ai-scope` launcher (AI_SCOPE_LAUNCHER, set by it)
//  - run through npx: `npx -y ai-scope@latest`
//  - otherwise (a cloned folder): this Node.js + this folder's bin/ai-scope.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const NAME = 'ai-scope';

function npxPath() {
  // Absolute path: login items don't always have Node on their PATH.
  const dir = path.dirname(process.execPath);
  const p = path.join(dir, process.platform === 'win32' ? 'npx.cmd' : 'npx');
  return fs.existsSync(p) ? p : (process.platform === 'win32' ? 'npx.cmd' : 'npx');
}

// The command + first arguments to put in the login item.
function command() {
  const launcher = process.env.AI_SCOPE_LAUNCHER;
  if (launcher && fs.existsSync(launcher)) return [launcher];
  if (/[\\/]_npx[\\/]/.test(__dirname)) return [npxPath(), '-y', NAME + '@latest'];
  return [process.execPath, path.join(__dirname, 'ai-scope.js')];
}

function target() {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', NAME + '.cmd');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.' + NAME + '.plist');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', NAME + '.desktop');
}

function xmlEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function shQuote(s) { return /^[\w.\/:=@-]+$/.test(s) ? s : "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function winQuote(s) { return /^[\w.\\:=@-]+$/.test(s) ? s : '"' + s + '"'; }

function content(flags) {
  const full = command().concat(flags);
  const exe = full[0], args = full.slice(1);
  if (process.platform === 'win32') {
    // Minimized console window titled AI_SCOPE; close it to stop AI_SCOPE.
    return '@echo off\r\n' +
      'rem Created by "ai-scope --install-startup". Remove with "ai-scope --uninstall-startup".\r\n' +
      'start "AI_SCOPE" /min cmd /c "' + [exe].concat(args).map(winQuote).join(' ') + '"\r\n';
  }
  if (process.platform === 'darwin') {
    const log = path.join(os.homedir(), '.ai_scope', 'ai-scope.log');
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0"><dict>\n' +
      '  <key>Label</key><string>com.' + NAME + '</string>\n' +
      '  <key>ProgramArguments</key><array>' + [exe].concat(args).map(function (a) { return '<string>' + xmlEsc(a) + '</string>'; }).join('') + '</array>\n' +
      '  <key>EnvironmentVariables</key><dict><key>PATH</key><string>' + xmlEsc(path.dirname(process.execPath) + ':/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin') + '</string></dict>\n' +
      '  <key>RunAtLoad</key><true/>\n' +
      '  <key>StandardOutPath</key><string>' + xmlEsc(log) + '</string>\n' +
      '  <key>StandardErrorPath</key><string>' + xmlEsc(log) + '</string>\n' +
      '</dict></plist>\n';
  }
  return '[Desktop Entry]\nType=Application\nName=AI_SCOPE\nComment=Local AI monitor\n' +
    'Exec=' + [exe].concat(args).map(shQuote).join(' ') + '\nTerminal=false\nX-GNOME-Autostart-enabled=true\n';
}

function install(flags) {
  const file = target();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content(flags));
  console.log('AI_SCOPE will start when you log in.');
  console.log('  Login item: ' + file);
  console.log('  Remove it with: ai-scope --uninstall-startup');
}

function uninstall() {
  const file = target();
  if (!fs.existsSync(file)) { console.log('No AI_SCOPE login item found (' + file + ').'); return; }
  fs.unlinkSync(file);
  console.log('Removed the AI_SCOPE login item (' + file + ').');
}

module.exports = { install: install, uninstall: uninstall, target: target };
