// Process data on Linux and macOS (AI_SCOPE-052), for procstats.js (an app's own processes) and proctop.js (every
// process, the Processes scope). Plain Node, no helper process:
//  - processes: Linux /proc/<pid>/stat, status, cmdline, io; macOS `ps` (CPU time, RSS, command line)
//  - who listens on a port: Linux /proc/net/tcp(6) socket inodes -> /proc/<pid>/fd links; macOS `lsof`. Both only see
//    other users' processes as root (Ollama's Linux installer runs it as its own `ollama` user), so callers fall back
//    to matching processes by name.
//  - NVIDIA per-process VRAM (and GPU % where `nvidia-smi pmon` works), by Hardware card key ('nv' + index); Linux only.
// No dependencies; conservative JS.
'use strict';
const fs = require('fs');
const path = require('path');
const execFile = require('child_process').execFile;

const LINUX = process.platform === 'linux', MAC = process.platform === 'darwin';
let ticks = 100;   // clock ticks per second for /proc CPU times (almost always 100; read once from getconf)
if (LINUX) execFile('getconf', ['CLK_TCK'], { timeout: 3000 }, function (err, out) { const n = parseInt(out, 10); if (!err && n > 0) ticks = n; });

function run(cmd, args, timeout, cb) {
  execFile(cmd, args, { timeout: timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, function (err, out) { cb(err ? null : String(out)); });
}
function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } }

// "Name matching": a process matches 'llama-server' / 'llama-server.exe' by its program name (argv[0] without the
// folder, or the kernel's name), case-insensitive, '.exe' ignored; 'ollama runner' also needs that first argument.
function normName(n) { return String(n || '').toLowerCase().replace(/\.exe$/, ''); }
function matches(p, names) {
  return names.some(function (n) {
    const parts = normName(n).split(' ');
    if (normName(p.name) !== parts[0] && normName(p.comm) !== parts[0]) return false;
    return parts.length < 2 || String(p.arg1 || '').toLowerCase() === parts[1];
  });
}

// ---------- every process ----------
// cb({ at, procs: { pid: { pid, ppid, name, comm, arg1, start, cpu (CPU seconds so far), rss, priv, ioR, ioW } } }).
// ioR / ioW: bytes so far, null when the system doesn't tell (another user's process on Linux; always on macOS).
function snapshot(cb) {
  if (LINUX) return cb(linuxSnapshot());
  if (MAC) return macSnapshot(cb);
  cb(null);
}
function linuxSnapshot() {
  const procs = {};
  let dir; try { dir = fs.readdirSync('/proc'); } catch (e) { return null; }
  dir.forEach(function (d) {
    if (!/^\d+$/.test(d)) return;
    const stat = readText('/proc/' + d + '/stat'); if (!stat) return;
    const close = stat.lastIndexOf(')');
    const comm = stat.slice(stat.indexOf('(') + 1, close);
    const f = stat.slice(close + 2).split(' ');   // f[0] = state (field 3), f[1] = ppid, f[6] = flags, f[11] / f[12] = utime / stime, f[19] = start time
    const pid = +d, ppid = +f[1];
    if ((+f[6] || 0) & 0x200000) return;          // PF_KTHREAD: a kernel thread (not "parent is PID 2" - in containers PID 2 is an ordinary process)
    const cmd = (readText('/proc/' + d + '/cmdline') || '').split('\0');
    const status = readText('/proc/' + d + '/status') || '';
    const kb = function (k) { const m = new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(status); return m ? +m[1] * 1024 : null; };
    const io = readText('/proc/' + d + '/io');
    const iob = function (k) { const m = io && new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(io); return m ? +m[1] : null; };
    procs[pid] = { pid: pid, ppid: ppid, comm: comm, name: cmd[0] ? path.basename(cmd[0]) : comm, arg1: cmd[1] || '', start: f[19],
      cpu: ((+f[11] || 0) + (+f[12] || 0)) / ticks, rss: kb('VmRSS') || 0, priv: kb('RssAnon'), ioR: iob('read_bytes'), ioW: iob('write_bytes') };
  });
  return { at: Date.now(), procs: procs };
}
// macOS: `ps` gives CPU time as [[dd-]hh:]mm:ss.ss and RSS in KB; the command line comes from a second `ps`.
function psTime(t) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(String(t).trim());
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3]) * 60 + parseFloat(m[4]) : 0;
}
function macSnapshot(cb) {
  run('ps', ['-axo', 'pid=,ppid=,rss=,time=,comm='], 5000, function (out) {
    if (!out) return cb(null);
    run('ps', ['-axo', 'pid=,args='], 5000, function (args) {
      const argv = {};
      (args || '').split('\n').forEach(function (l) { const m = /^\s*(\d+)\s+(.*)$/.exec(l); if (m) argv[m[1]] = m[2]; });
      const procs = {};
      out.split('\n').forEach(function (l) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l); if (!m) return;
        const comm = m[5].trim(), a = argv[m[1]] || '';
        // args = program path + arguments; the program path may contain spaces, comm is the same path
        const rest = a.indexOf(comm) === 0 ? a.slice(comm.length).trim() : a.split(/\s+/).slice(1).join(' ');
        procs[m[1]] = { pid: +m[1], ppid: +m[2], comm: path.basename(comm), name: path.basename(comm), arg1: rest.split(/\s+/)[0] || '', start: null,
          cpu: psTime(m[4]), rss: (+m[3] || 0) * 1024, priv: null, ioR: null, ioW: null };
      });
      cb({ at: Date.now(), procs: procs });
    });
  });
}
// The process and all its descendants, from a snapshot.
function family(snap, rootPids) {
  const kids = {};
  Object.keys(snap.procs).forEach(function (k) { const p = snap.procs[k]; (kids[p.ppid] = kids[p.ppid] || []).push(p.pid); });
  const out = [], seen = {}, todo = rootPids.slice();
  while (todo.length) { const pid = todo.shift(); if (seen[pid] || !snap.procs[pid]) continue; seen[pid] = true; out.push(pid); (kids[pid] || []).forEach(function (c) { todo.push(c); }); }
  return out;
}

// ---------- who listens on these ports ----------
// cb({ port: [pids] }); a port whose owner can't be seen (another user's process, not root) is missing.
function portOwners(ports, cb) {
  if (!ports.length) return cb({});
  if (LINUX) return cb(linuxPortOwners(ports));
  if (MAC) return run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], 5000, function (out) {
    const res = {}; let pid = null;
    (out || '').split('\n').forEach(function (l) {
      if (l[0] === 'p') pid = +l.slice(1);
      else if (l[0] === 'n' && pid) { const port = +l.slice(l.lastIndexOf(':') + 1); if (ports.indexOf(port) >= 0) { (res[port] = res[port] || []).indexOf(pid) < 0 && res[port].push(pid); } }
    });
    cb(res);
  });
  cb({});
}
function linuxPortOwners(ports) {
  const inodes = {};   // socket inode -> port
  ['/proc/net/tcp', '/proc/net/tcp6'].forEach(function (f) {
    (readText(f) || '').split('\n').slice(1).forEach(function (l) {
      const p = l.trim().split(/\s+/); if (p.length < 10 || p[3] !== '0A') return;   // 0A = LISTEN
      const port = parseInt(p[1].split(':')[1], 16);
      if (ports.indexOf(port) >= 0) inodes[p[9]] = port;
    });
  });
  const res = {};
  if (!Object.keys(inodes).length) return res;
  let dir; try { dir = fs.readdirSync('/proc'); } catch (e) { return res; }
  dir.forEach(function (d) {
    if (!/^\d+$/.test(d)) return;
    let fds; try { fds = fs.readdirSync('/proc/' + d + '/fd'); } catch (e) { return; }   // another user's process (not root)
    fds.forEach(function (fd) {
      let link; try { link = fs.readlinkSync('/proc/' + d + '/fd/' + fd); } catch (e) { return; }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m && inodes[m[1]] != null) { const port = inodes[m[1]]; (res[port] = res[port] || []).indexOf(+d) < 0 && res[port].push(+d); }
    });
  });
  return res;
}

// ---------- NVIDIA per process (Linux) ----------
// cb({ pid: { cardKey: { vram (bytes), util (% or null) } } }) or null without nvidia-smi. VRAM from
// --query-compute-apps (CUDA processes; graphics-only processes aren't listed), GPU % from `pmon -c 1` (one sample,
// ~1 s; not on every driver / card - then util stays null).
let uuidIndex = null, uuidAt = 0;
function nvidia(cb) {
  if (!LINUX) return cb(null);
  const withMap = function (next) {
    if (uuidIndex && Date.now() - uuidAt < 60000) return next();
    run('nvidia-smi', ['--query-gpu=index,uuid', '--format=csv,noheader'], 5000, function (out) {
      if (!out) { uuidIndex = null; return cb(null); }
      uuidIndex = {}; uuidAt = Date.now();
      out.trim().split('\n').forEach(function (l) { const p = l.split(',').map(function (x) { return x.trim(); }); if (p[1]) uuidIndex[p[1]] = 'nv' + p[0]; });
      next();
    });
  };
  withMap(function () {
    let apps = null, pmon = null, left = 2;
    const done = function () {
      if (--left) return;
      if (apps == null) return cb(null);
      const res = {};
      apps.trim().split('\n').forEach(function (l) {
        const p = l.split(',').map(function (x) { return x.trim(); }); const key = uuidIndex[p[1]];
        if (!key || !(+p[0])) return;
        const r = res[p[0]] = res[p[0]] || {}; const g = r[key] = r[key] || { vram: 0, util: null };
        g.vram += (parseFloat(p[2]) || 0) * 1048576;
      });
      (pmon || '').split('\n').forEach(function (l) {   // "# gpu pid type sm mem ..." then "    0  12345  C  45  10 ..."
        const p = l.trim().split(/\s+/); if (!/^\d+$/.test(p[0]) || !/^\d+$/.test(p[1])) return;
        const sm = parseFloat(p[3]); if (!isFinite(sm)) return;
        const r = res[p[1]] = res[p[1]] || {}; const g = r['nv' + p[0]] = r['nv' + p[0]] || { vram: 0, util: null };
        g.util = Math.min(100, (g.util || 0) + sm);
      });
      cb(res);
    };
    run('nvidia-smi', ['--query-compute-apps=pid,gpu_uuid,used_memory', '--format=csv,noheader,nounits'], 5000, function (out) { apps = out == null ? null : out; done(); });
    run('nvidia-smi', ['pmon', '-c', '1', '-s', 'u'], 5000, function (out) { pmon = out; done(); });
  });
}

function supported() { return LINUX || MAC; }
module.exports = { supported: supported, snapshot: snapshot, family: family, portOwners: portOwners, nvidia: nvidia, matches: matches,
  _test: { linuxSnapshot: linuxSnapshot, psTime: psTime, linuxPortOwners: linuxPortOwners } };
