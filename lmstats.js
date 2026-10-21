// Parses LM Studio server logs (llama.cpp "print_timing" blocks) into per-request performance rows.
// Written in conservative JS so it runs on older Node versions.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// Where LM Studio keeps server logs: <LM Studio folder>/apps/bionic/server-logs (newer) or /server-logs.
// The LM Studio folder comes from the scope's install settings (scopes.json -> data/installed.json).
let CANDIDATE_DIRS = [];
function start(settings) {
  const home = (settings && settings.home) || path.join(os.homedir(), '.lmstudio');
  CANDIDATE_DIRS = [path.join(home, 'apps', 'bionic', 'server-logs'), path.join(home, 'server-logs')];
}
function stop() { CANDIDATE_DIRS = []; }

function findLogDir() {
  for (const d of CANDIDATE_DIRS) {
    try { if (fs.statSync(d).isDirectory()) return d; } catch (e) { /* try next */ }
  }
  return null;
}

// All .log files (month subfolders included), oldest -> newest by name (names are dates).
function listLogFiles(dir) {
  const out = [];
  (function walk(d) {
    let entries = [];
    try { entries = fs.readdirSync(d); } catch (e) { return; }
    entries.forEach(function (name) {
      const p = path.join(d, name);
      let st;
      try { st = fs.statSync(p); } catch (e) { return; }
      if (st.isDirectory()) walk(p);
      else if (/\.log$/i.test(name)) out.push(p);
    });
  })(dir);
  return out.sort(function (a, b) { return path.basename(a).localeCompare(path.basename(b)); });
}

const RE_TS = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\]/;
const RE_LOAD = /load_model: loading model '([^']+)'/;
const RE_RUN = /^\[[^\]]+\]\[INFO\]\[([^\]]+)\] Running chat completion/;
const RE_PROMPT = /task\s+(\d+)\s*\|\s*prompt eval time =\s*([\d.]+) ms \/\s*(\d+) tokens.*?([\d.]+) tokens per second/;
const RE_EVAL = /task\s+(\d+)\s*\|\s*eval time =\s*([\d.]+) ms \/\s*(\d+) tokens.*?([\d.]+) tokens per second/;
const RE_TOTAL = /task\s+(\d+)\s*\|\s*total time =\s*([\d.]+) ms \/\s*(\d+) tokens/;

function modelNameFromPath(p) {
  return path.basename(p.replace(/\\/g, '/')).replace(/\.gguf$/i, '');
}

function parseText(text, file, rows) {
  let ts = null;
  let model = null;
  let cur = null;
  text.split(/\r?\n/).forEach(function (line) {
    let m = RE_TS.exec(line);
    if (m) ts = m[1];
    if ((m = RE_RUN.exec(line))) model = m[1];
    else if ((m = RE_LOAD.exec(line))) model = modelNameFromPath(m[1]);

    if ((m = RE_PROMPT.exec(line))) {
      cur = {
        timestamp: ts,
        model: model || 'unknown',
        task: +m[1],
        promptMs: +m[2],
        promptTokens: +m[3],
        promptTps: +m[4],
        genMs: null, genTokens: null, genTps: null, totalMs: null,
      };
      rows.push(cur);
    } else if (cur && (m = RE_EVAL.exec(line)) && +m[1] === cur.task) {
      cur.genMs = +m[2]; cur.genTokens = +m[3]; cur.genTps = +m[4];
    } else if (cur && (m = RE_TOTAL.exec(line)) && +m[1] === cur.task) {
      cur.totalMs = +m[2];
      cur = null;
    }
  });
}

// Returns the newest `limit` requests, newest first.
function getLatestRequests(limit) {
  limit = limit || 100;
  const dir = findLogDir();
  if (!dir) return { logDir: null, rows: [], error: 'LM Studio log folder not found. Looked in: ' + CANDIDATE_DIRS.join(', ') };
  const files = listLogFiles(dir);
  const rows = [];
  // Read newest files first until we have enough rows.
  for (let i = files.length - 1; i >= 0 && rows.length < limit; i--) {
    const fileRows = [];
    try { parseText(fs.readFileSync(files[i], 'utf8'), files[i], fileRows); } catch (e) { continue; }
    for (let j = fileRows.length - 1; j >= 0 && rows.length < limit; j--) rows.push(fileRows[j]);
  }
  return { logDir: dir, rows: rows };
}


// ---------- Current (in-flight) request ----------
const RE_LAUNCH = /task\s+(\d+)\s*\|\s*processing task/;
const RE_PROGRESS = /task\s+(\d+)\s*\|\s*prompt processing, n_tokens =\s*(\d+), progress =\s*([\d.]+).*?([\d.]+) tokens per second/;
const RE_GEN = /task\s+(\d+)\s*\|\s*n_gen =\s*(\d+), tg =\s*([\d.]+) t\/s(?:, tg_3s =\s*([\d.]+) t\/s)?/;
const RE_RELEASE = /task\s+(\d+)\s*\|\s*stop processing/;
const STALE_MS = 120000; // no log activity for this long => assume the request died

// Log timestamps are local time ("YYYY-MM-DD HH:MM:SS").
function tsToMs(ts) {
  if (!ts) return null;
  const m = /^(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)$/.exec(ts);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}

function getCurrentRequest() {
  const dir = findLogDir();
  if (!dir) return null;
  const files = listLogFiles(dir);
  if (!files.length) return null;
  let text;
  try { text = fs.readFileSync(files[files.length - 1], 'utf8'); } catch (e) { return null; }

  const active = {}; // task id -> state
  let ts = null, model = null;
  text.split(/\r?\n/).forEach(function (line) {
    let m = RE_TS.exec(line);
    if (m) ts = m[1];
    if ((m = RE_RUN.exec(line))) model = m[1];
    else if ((m = RE_LOAD.exec(line))) model = modelNameFromPath(m[1]);

    if ((m = RE_LAUNCH.exec(line))) {
      active[m[1]] = { task: +m[1], model: model || 'unknown', start: ts, last: ts, phase: 'prompt',
                       progress: 0, promptTps: null, genTokens: 0, genTps: null };
    } else if ((m = RE_PROGRESS.exec(line)) && active[m[1]]) {
      const a = active[m[1]];
      a.last = ts; a.phase = 'prompt'; a.progress = +m[3]; a.promptTps = +m[4];
    } else if ((m = RE_GEN.exec(line)) && active[m[1]]) {
      const a = active[m[1]];
      a.last = ts; a.phase = 'gen'; a.genTokens = +m[2];
      a.genTps = m[4] != null ? +m[4] : +m[3]; // prefer the recent 3-second rate
    } else if ((m = RE_PROMPT.exec(line)) && active[m[1]]) {
      // prompt finished; generation running (only reported here once the request is done)
      delete active[m[1]];
    } else if ((m = RE_RELEASE.exec(line)) && active[m[1]]) {
      delete active[m[1]];
    }
  });

  const now = Date.now();
  const running = Object.keys(active).map(function (k) { return active[k]; })
    .filter(function (a) { const t = tsToMs(a.last); return t != null && now - t < STALE_MS; })
    .sort(function (a, b) { return b.task - a.task; });
  if (!running.length) return null;
  const cur = running[0];
  const startMs = tsToMs(cur.start);
  return {
    model: cur.model, task: cur.task, phase: cur.phase, progress: cur.progress,
    promptTps: cur.promptTps, genTokens: cur.genTokens, genTps: cur.genTps,
    elapsedMs: startMs != null ? Math.max(0, now - startMs) : null,
    othersRunning: running.length - 1,
  };
}

// Token-weighted average generation speed for the most recently used model.
function getAverage(rows) {
  if (!rows.length) return null;
  const model = rows[0].model;
  let tokens = 0, ms = 0, n = 0;
  rows.forEach(function (r) {
    if (r.model === model && r.genTokens && r.genMs) { tokens += r.genTokens; ms += r.genMs; n++; }
  });
  return ms ? { model: model, genTps: tokens / (ms / 1000), requests: n } : null;
}

module.exports = { start: start, stop: stop, getLatestRequests: getLatestRequests, getCurrentRequest: getCurrentRequest, getAverage: getAverage, tsToMs: tsToMs };
