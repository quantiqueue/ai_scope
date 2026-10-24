// Disk throughput per physical disk (AI_SCOPE-030), for the Hardware scope's Disk tiles: read / write bytes per second
// and active time % (like Task Manager). Sampled by hwstats.js with its other numbers (every 2 s, 5 min history).
//  - Windows: one long-running PowerShell (diskstats.ps1) with a PDH query over \PhysicalDisk(*) - instances are named
//    like "0 C: D:" (disk number + its drive letters). Always on, like the Hardware tiles.
//  - Linux: /proc/diskstats (whole disks only: sda, nvme0n1, vda, mmcblk0, …), with their mount points from /proc/mounts.
//  - Other systems: none (no Disk tiles).
// No dependencies; conservative JS.
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const spawn = require('child_process').spawn;

const SAMPLE_MS = 2000;
const STALE_MS = 3 * SAMPLE_MS;
const PS_FILE = path.join(__dirname, 'diskstats.ps1');
const SCRIPT_FILE = path.join(os.tmpdir(), 'ai_scope-diskstats-' + process.pid + '.ps1');

let ps = null, latest = null, restartTimer = null, failures = 0;

function num(s) { if (s === '' || s == null) return null; const v = parseFloat(String(s).replace(',', '.')); return isFinite(v) ? v : null; }

// ---------- Windows ----------
// "0 C: D:" -> { id: '0', name: 'Disk 0 (C: D:)' }
function winDisk(instance) {
  const m = /^(\d+)\s*(.*)$/.exec(String(instance).trim());
  if (!m) return { id: instance, name: instance };
  const letters = m[2].trim();
  return { id: m[1], name: 'Disk ' + m[1] + (letters ? ' (' + letters + ')' : '') };
}
function handleBlock(lines) {
  const disks = [];
  lines.forEach(function (l) {
    const p = l.split('|');
    if (p[0] !== 'D' || p.length < 5 || p[1] === '_Total') return;
    const d = winDisk(p[1]), idle = num(p[4]);
    d.read = Math.max(0, num(p[2]) || 0); d.write = Math.max(0, num(p[3]) || 0);
    d.active = idle == null ? null : Math.max(0, Math.min(100, 100 - idle));
    disks.push(d);
  });
  disks.sort(function (a, b) { return (+a.id) - (+b.id); });
  latest = { at: Date.now(), disks: disks };
}
function startWindows() {
  if (ps) return;
  let src; try { src = fs.readFileSync(PS_FILE, 'utf8'); } catch (e) { console.log('[diskstats] diskstats.ps1 is missing'); return; }
  const script = src.split('__PARENT__').join(String(process.pid)).split('__EVERY__').join(String(SAMPLE_MS));
  let child;
  try {
    fs.writeFileSync(SCRIPT_FILE, '﻿' + script, 'utf8');   // BOM: Windows PowerShell 5.1 reads BOM-less files as ANSI
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_FILE],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { console.log('[diskstats] could not start: ' + e.message); return; }   // never take the server down over disk stats
  ps = child;
  let buf = '', block = [];
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
    lines.forEach(function (l) {
      if (l.trim() === '---') { handleBlock(block); block = []; failures = 0; } else if (l.trim()) block.push(l.trim());
    });
  });
}
process.on('exit', function () { if (ps) { try { ps.kill(); } catch (e) {} } try { fs.unlinkSync(SCRIPT_FILE); } catch (e) {} });

// ---------- Linux ----------
const WHOLE_DISK = /^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;
let prevLinux = null;   // { t, byName: { name: { sectorsRead, sectorsWritten, ioMs } } }
// partition -> its disk (sda1 -> sda, nvme0n1p2 -> nvme0n1, mmcblk0p1 -> mmcblk0)
function diskOf(dev) {
  const m = /^(nvme\d+n\d+|mmcblk\d+)p\d+$/.exec(dev) || /^((?:sd|hd|vd|xvd)[a-z]+)\d+$/.exec(dev);
  return m ? m[1] : WHOLE_DISK.test(dev) ? dev : null;
}
function mountsByDisk() {
  const out = {};
  let text = '';
  try { text = fs.readFileSync('/proc/mounts', 'utf8'); } catch (e) { return out; }
  text.split('\n').forEach(function (l) {
    const p = l.split(' ');
    if (p.length < 2 || p[0].indexOf('/dev/') !== 0) return;
    const disk = diskOf(p[0].slice(5));
    if (!disk) return;
    const mp = p[1].replace(/\\040/g, ' ');
    (out[disk] = out[disk] || []).indexOf(mp) < 0 && out[disk].push(mp);
  });
  return out;
}
// /proc/diskstats text -> { name: { sectorsRead, sectorsWritten, ioMs } } for whole disks
function parseDiskstats(text) {
  const out = {};
  String(text).split('\n').forEach(function (l) {
    const p = l.trim().split(/\s+/);
    if (p.length < 13 || !WHOLE_DISK.test(p[2])) return;
    out[p[2]] = { sectorsRead: +p[5], sectorsWritten: +p[9], ioMs: +p[12] };
  });
  return out;
}
function sampleLinux() {
  let text;
  try { text = fs.readFileSync('/proc/diskstats', 'utf8'); } catch (e) { return; }
  const now = Date.now(), cur = parseDiskstats(text), prev = prevLinux;
  prevLinux = { t: now, byName: cur };
  if (!prev || now <= prev.t) return;
  const dt = (now - prev.t) / 1000, mounts = mountsByDisk();
  latest = { at: now, disks: Object.keys(cur).sort().filter(function (n) { return prev.byName[n]; }).map(function (n) {
    const a = prev.byName[n], b = cur[n], mp = mounts[n] || [];
    return { id: n, name: n + (mp.length ? ' (' + mp.slice(0, 3).join(' ') + (mp.length > 3 ? ' …' : '') + ')' : ''),
             read: Math.max(0, (b.sectorsRead - a.sectorsRead) * 512 / dt), write: Math.max(0, (b.sectorsWritten - a.sectorsWritten) * 512 / dt),
             active: Math.max(0, Math.min(100, (b.ioMs - a.ioMs) / (dt * 10))) };
  }) };
}

// ---------- API ----------
function start() {
  if (process.platform === 'win32') startWindows();
  else if (process.platform === 'linux') sampleLinux();   // first reading (rates need two)
}
// Latest disks [{ id, name, read, write (bytes/s), active (%) }] or null (not sampled yet / not supported). On Linux each
// call takes a new reading (hwstats calls it every 2 s).
function get() {
  if (process.platform === 'linux') sampleLinux();
  return latest && Date.now() - latest.at < STALE_MS ? latest.disks : null;
}
function supported() { return process.platform === 'win32' || process.platform === 'linux'; }

module.exports = { start: start, get: get, supported: supported, _test: { handleBlock: handleBlock, parseDiskstats: parseDiskstats, diskOf: diskOf, winDisk: winDisk } };
