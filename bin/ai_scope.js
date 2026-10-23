#!/usr/bin/env node
// AI_SCOPE command line: `npx ai_scope [options]`.
// Parses the flags, then runs server.js in this process (no auto-restart; dev.js is for development).
'use strict';
const path = require('path');
const pkg = require('../package.json');

const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 18) {
  console.log('AI_SCOPE needs Node.js 18 or newer (you have ' + process.version + '). Get the LTS version from https://nodejs.org');
  process.exit(1);
}

const HELP = [
  'AI_SCOPE ' + pkg.version + ' - local AI monitor (Bionic, Ollama, ComfyUI, Strata, CPU/GPU)',
  '',
  'Usage: ai_scope [options]      (or: npx ai_scope [options])',
  '',
  'Options:',
  '  -p, --port <n>          Port for the dashboard (default 9000)',
  '      --host <addr>       127.0.0.1 = this computer only (default)',
  '                          0.0.0.0   = also phones/PCs on your network',
  '  -o, --open              Open the dashboard in your browser',
  '      --app               Run in the background (no console window) and open the',
  '                          dashboard in its own window; if already running, just open it',
  '      --stop              Stop AI_SCOPE running in the background',
  '      --data-dir <path>   Where settings and history are kept (default ~/.ai_scope)',
  '      --install-startup   Start AI_SCOPE when you log in (uses the other flags you pass)',
  '      --uninstall-startup Stop starting AI_SCOPE at login',
  '      --uninstall         Remove AI_SCOPE (when installed with install.ps1 / install.sh)',
  '  -v, --version           Show the version',
  '  -h, --help              Show this help',
  '',
  'Examples:',
  '  ai_scope --open',
  '  ai_scope --app',
  '  ai_scope --stop',
  '  ai_scope --host 0.0.0.0 --port 9100',
  '  ai_scope --host 0.0.0.0 --install-startup'
].join('\n');

function fail(msg) { console.log('ai_scope: ' + msg + '\n\nRun "ai_scope --help" for the options.'); process.exit(1); }

const argv = process.argv.slice(2);
const opts = { port: null, host: null, open: false, app: false, stop: false, dataDir: null, install: false, uninstall: false };
const passOn = []; // flags written into the login item
for (let i = 0; i < argv.length; i++) {
  let a = argv[i], val = null;
  const eq = a.indexOf('=');
  if (a.indexOf('--') === 0 && eq > 0) { val = a.slice(eq + 1); a = a.slice(0, eq); }
  const next = function () {
    if (val !== null) return val;
    if (i + 1 >= argv.length || argv[i + 1].indexOf('-') === 0) fail(a + ' needs a value');
    return argv[++i];
  };
  switch (a) {
    case '-p': case '--port': {
      const p = parseInt(next(), 10);
      if (!(p >= 1 && p <= 65535)) fail('port must be a number from 1 to 65535');
      opts.port = p; passOn.push('--port', String(p)); break;
    }
    case '--host': opts.host = next(); passOn.push('--host', opts.host); break;
    case '-o': case '--open': opts.open = true; break;
    case '--app': opts.app = true; break;
    case '--stop': opts.stop = true; break;
    case '--data-dir': opts.dataDir = path.resolve(next()); passOn.push('--data-dir', opts.dataDir); break;
    case '--install-startup': opts.install = true; break;
    case '--uninstall-startup': opts.uninstall = true; break;
    case '--uninstall':
      // Normally handled by the ai_scope launcher before Node starts; we only get here when run another way.
      console.log(process.env.AI_SCOPE_LAUNCHER ? 'Uninstall failed to start - remove the AI_SCOPE folder by hand.'
        : 'This copy was not installed with install.ps1 / install.sh. With npx there is nothing to uninstall (npx keeps only a cache); a cloned folder can just be deleted.');
      process.exit(0); break;
    case '-v': case '--version': console.log(pkg.version); process.exit(0); break;
    case '-h': case '--help': console.log(HELP); process.exit(0); break;
    default: fail('unknown option ' + a);
  }
}

if (opts.install || opts.uninstall) {
  const startup = require('./startup');
  try { opts.install ? startup.install(passOn) : startup.uninstall(); }
  catch (e) { fail('could not ' + (opts.install ? 'add' : 'remove') + ' the login item: ' + e.message); }
  process.exit(0);
}

if (opts.stop) require('./app').stop(opts.port || 9000);
else if (opts.app) {
  if (opts.dataDir) process.env.AI_SCOPE_DATA = opts.dataDir;
  require('./app').app({ port: opts.port || 9000, flags: passOn, logFile: require('../paths').file('ai_scope.log') });
} else {

if (opts.port) process.env.AI_SCOPE_PORT = String(opts.port);
process.env.AI_SCOPE_HOST = opts.host || process.env.AI_SCOPE_HOST || '127.0.0.1'; // this PC only unless asked
if (opts.dataDir) process.env.AI_SCOPE_DATA = opts.dataDir;
if (opts.open) process.env.AI_SCOPE_OPEN = '1';
if (process.stdout.isTTY) process.title = 'AI_SCOPE';

console.log('AI_SCOPE ' + pkg.version + (process.env.AI_SCOPE_BACKGROUND ? '  (background, started ' + new Date().toLocaleString() + ')' : '  (Ctrl+C to stop)'));
require('../server.js');
}
