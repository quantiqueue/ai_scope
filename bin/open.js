// Open a URL in the default browser (Windows / macOS / Linux). Failure is silent: the URL is printed anyway.
'use strict';
const { spawn } = require('child_process');

module.exports = function open(url) {
  let cmd, args;
  if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', url]; }
  else if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
  else { cmd = 'xdg-open'; args = [url]; }
  try {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    p.on('error', function () { /* no browser opener available */ });
    p.unref();
  } catch (e) { /* ignore */ }
};
