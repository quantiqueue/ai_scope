// Committed memory on Windows (AI_SCOPE-118): committed bytes, the commit limit (RAM + pagefile) and the peak
// commit charge since the last boot, for the Hardware scope's RAM (Committed) tile and the Mirror RAM (Committed)
// lens. Sampled by hwstats.js with its other numbers (every 2 s, 5 min history).
//  - Windows: one long-running PowerShell (ramcommitstats.ps1) calling GetPerformanceInfo per sample. This replaces
//    the per-60-s CIM route (Win32_OperatingSystem cost 9-11 s on snow and timed out - AI_SCOPE-118).
//  - Linux / macOS: not used - hwstats.js reads /proc/meminfo itself (cheap fs read), and macOS has no commit limit.
// No dependencies; conservative JS.
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const spawn = require('child_process').spawn;

const SAMPLE_MS = 2000;
const STALE_MS = 3 * SAMPLE_MS;
const PS_FILE = path.join(__dirname, 'ramcommitstats.ps1');
const SCRIPT_FILE = path.join(os.tmpdir(), 'ai_scope-ramcommitstats-' + process.pid + '.ps1');

let ps = null, latest = null, restartTimer = null, failures = 0;

// "M|CommitTotalBytes|CommitLimitBytes|CommitPeakBytes" (int64 as decimal). Bytes fit Number exactly to 2^53.
function handleLine(line) {
  const p = line.split('|');
  if (p[0] !== 'M' || p.length < 4) return;
  const used = parseInt(p[1], 10), limit = parseInt(p[2], 10), peak = parseInt(p[3], 10);
  if (!(limit > 0) || !(used >= 0) || !(peak >= 0)) return;
  latest = { at: Date.now(), used: used, limit: limit, peak: peak };
  failures = 0;   // data flowing - the helper works, forget earlier failures
}
function startWindows() {
  if (ps) return;
  let src; try { src = fs.readFileSync(PS_FILE, 'utf8'); } catch (e) { console.log('[ramcommitstats] ramcommitstats.ps1 is missing'); return; }
  const script = src.split('__PARENT__').join(String(process.pid)).split('__EVERY__').join(String(SAMPLE_MS));
  let child;
  try {
    fs.writeFileSync(SCRIPT_FILE, '﻿' + script, 'utf8');   // BOM: Windows PowerShell 5.1 reads BOM-less files as ANSI
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_FILE],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { console.log('[ramcommitstats] could not start: ' + e.message); return; }   // never take the server down over commit numbers
  ps = child;
  let buf = '';
  child.on('error', function () { if (ps === child) ps = null; });
  child.on('exit', function () {
    if (ps !== child) return;
    ps = null;
    // restart after a crash (not too often: give up after a few quick failures in a row)
    if (++failures <= 5 && !restartTimer) restartTimer = setTimeout(function () { restartTimer = null; startWindows(); }, 10000);
  });
  child.stdout.on('data', function (d) {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    lines.forEach(function (l) { if (l.trim()) handleLine(l.trim()); });
  });
}
process.on('exit', function () { if (ps) { try { ps.kill(); } catch (e) {} } try { fs.unlinkSync(SCRIPT_FILE); } catch (e) {} });

// ---------- API ----------
function start() {
  if (process.platform === 'win32') startWindows();
}
// Latest { used, limit, peak } in bytes, or null (not sampled yet / reading stale after STALE_MS without a line).
function get() {
  return latest && Date.now() - latest.at < STALE_MS ? latest : null;
}
function supported() { return process.platform === 'win32'; }

module.exports = { start: start, get: get, supported: supported, _test: { handleLine: handleLine } };
