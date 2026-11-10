// Parses LM Studio-format server logs (llama.cpp "print_timing" blocks) into per-request performance rows.
// Used by the Bionic scope (LM Studio's Bionic); the file name stays generic for the LM Studio desktop scope later (AI_SCOPE-036).
// Written in conservative JS so it runs on older Node versions.
'use strict';
const fs = require('fs');
const path = require('path');
const reqstats = require('./reqstats');            // AI_SCOPE-094 slice 3: the shared average builder
const hwstats = require('./hwstats');              // AI_SCOPE-094 slice 4: peakBetween for each request
const procstats = require('./procstats');          // AI_SCOPE-127: energyBetween - the family's energy trail (121)
const reqstore = require('./reqstore');            // AI_SCOPE-131: the saved request store (the 121/128 shape)
const paths = require('./paths');                  // AI_SCOPE-131: bionic-requests.jsonl lives in the data folder
const os = require('os');

// Where the logs are: <data folder>/apps/bionic/server-logs (Bionic), else <data folder>/server-logs (LM Studio desktop).
// The data folder (~/.lmstudio) comes from the scope's install settings (scopes.json -> data/installed.json).
let CANDIDATE_DIRS = [];
function start(settings) {
  const home = (settings && settings.home) || path.join(os.homedir(), '.lmstudio');
  CANDIDATE_DIRS = [path.join(home, 'apps', 'bionic', 'server-logs'), path.join(home, 'server-logs')];
}
function stop() { CANDIDATE_DIRS = []; for (const k in perfRings) delete perfRings[k]; }   // AI_SCOPE-103: an uninstalled scope drops its rings too (like procstats' unattest). 131: nothing else to clear - the saved store IS the memory, and its keys are namespaced by log folder, so a reinstall over a different home can never inherit the old one's figures.

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
// AI_SCOPE-103 (review): llama.cpp/Bionic closes every request with the slot's OWN token total —
// "stop processing: n_tokens = 11217" — which is the whole conversation context, not just what this
// request read. That line is the only honest source of a context number, and it is present on every
// request in the logs on this box (2026-10-04 .. 11-03: releases >= prompt-eval lines in all files).
const RE_SLOT_RELEASE = /task\s+(\d+)\s*\|\s*stop processing: n_tokens = (\d+)/;

function modelNameFromPath(p) {
  return path.basename(p.replace(/\\/g, '/')).replace(/\.gguf$/i, '');
}

function parseText(text, file, rows) {
  let ts = null;
  let model = null;
  let cur = null;
  const closed = {};       // task -> finished row, so the slot-release line (which follows the total line) can reach it
  text.split(/\r?\n/).forEach(function (line) {
    let m = RE_TS.exec(line);
    if (m) ts = m[1];
    if ((m = RE_RUN.exec(line))) model = m[1];
    else if ((m = RE_LOAD.exec(line))) model = modelNameFromPath(m[1]);

    if ((m = RE_PROMPT.exec(line))) {
      // AI_SCOPE-094 slice 2: Bionic's record uses the same field names as the other scopes
      // (outputTokens / durationMs / firstTokenMs) and carries a real end / start / key, so the
      // shared Requests table can draw it. Bionic's log has no first-token line at all, so
      // firstTokenMs is the prefill duration - the same convention llamacppstats uses - and it is
      // marked as standing in so the table never shows it as a measurement.
      // AI_SCOPE-103 (review): the prompt-eval line counts the tokens Bionic ACTUALLY READ, not the
      // prompt - its prompt cache carries the rest of the conversation (verified on this box: each
      // request's cached count equals the previous one's prompt total, e.g. task 11641 read 25 of a
      // 7353-token conversation). So that count lands in `promptRead`, exactly like Strata's rows
      // (stratastats.js:97), and promptTokens is filled from the slot total below. Until the release
      // line arrives, the read count stands in for Prompt and is MARKED as standing in (never silent).
      const endMs = tsToMs(ts);
      cur = {
        key: ts + '|' + m[1], timestamp: ts, model: model || 'unknown', task: +m[1],
        end: endMs, start: null,
        promptMs: +m[2], promptRead: +m[3], promptTokens: +m[3], promptTps: +m[4],
        cachedTokens: null, contextTokens: null,
        genMs: null, outputTokens: null, genTps: null, durationMs: null,
        firstTokenMs: +m[2],
      };
      reqstats.setProv(cur, 'firstTokenMs', reqstats.PROV.SUBSTITUTE);
      reqstats.setProv(cur, 'promptTokens', reqstats.PROV.SUBSTITUTE);
      rows.push(cur);
    } else if (cur && (m = RE_EVAL.exec(line)) && +m[1] === cur.task) {
      cur.genMs = +m[2]; cur.outputTokens = +m[3]; cur.genTps = +m[4];
    } else if (cur && (m = RE_TOTAL.exec(line)) && +m[1] === cur.task) {
      cur.durationMs = +m[2];
      if (cur.end != null) cur.start = cur.end - cur.durationMs;
      closed[cur.task] = cur;
      cur = null;
    } else if ((m = RE_SLOT_RELEASE.exec(line))) {
      const r = closed[+m[1]];
      if (r) { attachSlotTotal(r, +m[2]); delete closed[+m[1]]; }
    }
  });
}

// AI_SCOPE-103 (review): the engine's own slot total at release = the whole conversation context
// (cached prefix + what it read + what it generated). From that, and only from it, the family's
// Prompt / Cached columns can be filled honestly: promptTokens = slot total - generated, and
// cachedTokens = promptTokens - promptRead. Both are one arithmetic step on two measured counts, so
// they carry the `derived` provenance (no ≈ - 094's rule marks only estimated/substitute faces).
// The read count is a floor on the prompt: the two counts differ by BOS-level slop (task 0: read
// 7329, slot total - generated = 7328), so the total is the larger of the two and cached floors at 0.
function attachSlotTotal(r, ctx) {
  r.contextTokens = ctx;                                        // exact: the engine's own number
  if (r.promptRead == null || r.outputTokens == null) return;   // no generation count: no derivation, leave the gap
  const total = Math.max(r.promptRead, ctx - r.outputTokens);
  r.promptTokens = total;
  r.cachedTokens = total - r.promptRead || 0;
  reqstats.setProv(r, 'promptTokens', reqstats.PROV.DERIVED);
  reqstats.setProv(r, 'cachedTokens', reqstats.PROV.DERIVED);
}

// ---------- Parsed files, cached (AI_SCOPE-057) ----------
// Every /api/bionic call (each open view polls it every 2 s) used to read the log files again - newest first until 100
// requests, often a whole 10 MB day, plus the newest file once more for the live card: ~10 MB per call, 5-23 MB/s of
// disk reads on the test PC. Now each file is parsed once and again only when its size or modification time changes
// (old days never; today's while Bionic writes). Kept per file: its request rows and the in-flight tasks at its end.
const parsed = {};   // path -> { size, mtimeMs, rows, active, lastTs }
function parseFile(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { delete parsed[file]; return null; }
  const c = parsed[file];
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  const rows = [];
  parseText(text, file, rows);
  const scan = scanActive(text);
  return (parsed[file] = { size: st.size, mtimeMs: st.mtimeMs, rows: rows, active: scan.active });
}
function forgetGone(files) {
  const keep = {};
  files.forEach(function (f) { keep[f] = true; });
  Object.keys(parsed).forEach(function (f) { if (!keep[f]) delete parsed[f]; });
}

// AI_SCOPE-094 slice 4 / 127 / 131: the saved request store.
//
// Bionic's rows ARE its server log - every other scope builds rows from its app's API and saves
// them (121/128); Bionic re-parses them on every read (094/057). Until 131 the figures the reads
// derived - the whole-PC peak (094 slice 4) and the per-request energy (127) - lived only in
// memory: procstats' one-hour trail plus read-time cache Maps. An ai_scope restart therefore
// blanked Peak / Power Usage / Total Cost on rows that had carried real numbers (the user's
// report). Bionic now keeps a saved store of its own, and the parse FEEDS it: every CLOSED row
// (its total line arrived, so it has a start) is appended exactly ONCE, with the peak and the
// energy stamped at save - 128's shape, not 127's read-time attach.
//   - the save waits 4 s past the row's end so the 2 s samples covering it have landed (094's
//     stricter peak wait covers 127's 3 s energy wait too); a waiting row rides the payload, it
//     is just not saved yet;
//   - an UNCLOSED row (in flight, or the engine died before its total line) rides the payload
//     from the parse and is never saved - once it closes it enters like any other;
//   - what was never measured stays unmeasured: no chunk inside the window -> no energy fields
//     (a gap, never a zero), and rows backfilled from before this session save peak: null exactly
//     as the read-time cache used to finalize them;
//   - row keys are Bionic's own `ts|task`: stable across reads and restarts, but unique only
//     inside one log folder, so the STORE key is <logDir>|<key> (`sk`): two Bionic homes can
//     repeat a timestamp. A response shows only the current folder's saved lines;
//   - the caps come with reqstore (1000 in memory, 5x on disk) - the same 1000-row bound the
//     Days buckets already name. The first scan backfills, so requests that closed before this
//     build entered the store too (measured only where this session can still measure them).
const REQ_FILE = paths.file('bionic-requests.jsonl');
const ENERGY_VER = 2;                    // the 121 D9 stamp: which measurement produced the joules
const known = {};                        // store key -> true (094's dedupe, fed by reqstore's `remember`)
let activeDir = null;                    // the log folder the current scan reads; the store-key namespace
function mapReqRow(r) {
  // 121 D9 (via 128): energy measured by a superseded apportionment is not history, it is a wrong
  // measurement - drop the fields and the row reads as a gap.
  if (r.energyWs != null && r.energyVer !== ENERGY_VER) { delete r.energyWs; delete r.energyPartial; }
  return r;
}
const store = reqstore.createStore({
  file: REQ_FILE,
  accept: function (r) { return !!r.sk && !known[r.sk]; },   // dedupe what the file already holds
  remember: function (r) { if (r.sk) known[r.sk] = true; },
  mapRow: mapReqRow,
  onError: function (msg) { console.log('[bionic] request store: ' + msg); }   // a failed write shows where it is honest: the server console
});
const requests = store.rows();           // saved closed requests, oldest first - the store mutates this array in place

// The 094 slice 4 window, unchanged: the log's `end` is a whole-second stamp and the inferred start
// can sit a beat before it, so the peak is asked over [start-1000, end+2000]. One shot at save.
function attachPeak(r) {
  r.peak = hwstats.peakBetween(r.start - 1000, r.end + 2000);
}
// 127's rules, 128's shape: the energy over the WHOLE request [start, end] from the family's trail;
// no chunk inside -> no fields (a gap, never a zero); reaching past coverage -> a floor that says
// so; provenance estimated (board power is a device measurement). The store keeps the answer forever.
function attachEnergy(r) {
  const en = procstats.energyBetween('bionic', r.start, r.end);
  if (!en || en.n <= 0) return;
  r.energyWs = Math.round(en.ws * 10) / 10;
  if (en.partial) r.energyPartial = true;
  r.energyVer = ENERGY_VER;
  reqstats.setProv(r, 'energyWs', reqstats.PROV.ESTIMATED);
}
function saveRequest(r) { r.sk = activeDir + '|' + r.key; store.append(r); }

// The 121 costDays shape over the stored rows (for bionic.costtotal's Days range): one bucket per LOCAL
// calendar day, oldest first { d, ws, n, miss } - n rows carry energy, miss rows count as nothing (a gap
// in the two Requests columns); the client picks the window and applies the price. The builder itself is the
// shared one (AI_SCOPE-128 settled it in reqstats.js, the same shape llama.cpp now uses); this stays as the
// name the /api/bionic route calls.
function costDayBuckets(rows) { return reqstats.costDayBuckets(rows); }

// Returns the newest `limit` requests, newest first: the saved store, fed from the log.
function getLatestRequests(limit) {  limit = limit || 100;
  const dir = findLogDir();
  if (!dir) return { logDir: null, rows: [], error: 'Bionic server log folder not found. Looked in: ' + CANDIDATE_DIRS.join(', ') };
  if (activeDir !== dir) { activeDir = dir; store.load(); }   // the file is read once; switching log folder only re-marks the keys
  const files = listLogFiles(dir);
  forgetGone(files);
  // Feed the store. The scan runs to the store's memory cap whatever the caller asked, so the Days
  // bound keeps its "last 1000 rows" shape; parseFile caches whole files, so this is a loop over kept
  // rows, not fresh disk reads (057).
  const riding = [];   // shown from the parse, not saved: unclosed rows + closed rows inside the 4 s wait
  const fresh = [];
  let seen = 0;
  for (let i = files.length - 1; i >= 0 && seen < store.memCap(); i--) {
    const c = parseFile(files[i]);
    if (!c) continue;
    for (let j = c.rows.length - 1; j >= 0 && seen < store.memCap(); j--) {
      const r = c.rows[j]; seen++;
      if (r.start == null) { riding.push(r); continue; }             // no total line yet (or ever)
      if (known[activeDir + '|' + r.key]) continue;                  // already in the store
      if (Date.now() - r.end < 4000) { riding.push(r); continue; }   // the samples covering the end may not have landed - retry on the next read
      attachPeak(r); attachEnergy(r); fresh.push(r);
    }
  }
  for (let i = fresh.length - 1; i >= 0; i--) saveRequest(fresh[i]);  // oldest first, so rows land in end order (129's save-order note)
  const mark = activeDir + '|';
  const rows = [];
  for (let i = requests.length - 1; i >= 0 && rows.length < limit; i--) {
    const r = requests[i];
    if (r.sk.slice(0, mark.length) === mark) rows.push(r);           // only the current log folder's saved lines
  }
  if (riding.length) {
    const all = rows.concat(riding);
    all.sort(function (a, b) { return (b.end || 0) - (a.end || 0); });   // newest first, whatever the source
    return { logDir: dir, rows: all.slice(0, limit) };
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

// The tasks still in flight at the end of a log text: task id -> state.
function scanActive(text) {
  const active = {}; // task id -> state
  let ts = null, model = null;
  text.split(/\r?\n/).forEach(function (line) {
    let m = RE_TS.exec(line);
    if (m) ts = m[1];
    if ((m = RE_RUN.exec(line))) model = m[1];
    else if ((m = RE_LOAD.exec(line))) model = modelNameFromPath(m[1]);

    if ((m = RE_LAUNCH.exec(line))) {
      active[m[1]] = { task: +m[1], model: model || 'unknown', start: ts, last: ts, phase: 'prompt',
                       progress: 0, promptTps: null, promptRead: null, genTokens: 0, genTps: null };
    } else if ((m = RE_PROGRESS.exec(line)) && active[m[1]]) {
      const a = active[m[1]];
      a.last = ts; a.phase = 'prompt'; a.progress = +m[3]; a.promptTps = +m[4];
      a.promptRead = +m[2];   // AI_SCOPE-100: Bionic's own n_tokens on the progress line
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

  return { active: active };
}

function getCurrentRequest() {
  const dir = findLogDir();
  if (!dir) return null;
  const files = listLogFiles(dir);
  if (!files.length) return null;
  const c = parseFile(files[files.length - 1]);   // cached: read again only when the file changed
  if (!c) return null;
  const active = c.active;
  const now = Date.now();
  const running = Object.keys(active).map(function (k) { return active[k]; })
    .filter(function (a) { const t = tsToMs(a.last); return t != null && now - t < STALE_MS; })
    .sort(function (a, b) { return b.task - a.task; });
  if (!running.length) return null;
  const cur = running[0];
  const startMs = tsToMs(cur.start);
  // AI_SCOPE-100 (D4): the wire words join 094's canonical vocabulary - the log's internal states
  // stay Bionic's own ('prompt'/'gen' in scanActive), only the record spells them like the family.
  // promptRead is Bionic's own n_tokens count from the progress line: present only while the log
  // carries it (never invented into the generating phase).
  return {
    model: cur.model, task: cur.task,
    phase: cur.phase === 'gen' ? 'generating' : 'reading',
    progress: cur.progress,
    promptTps: cur.promptTps, promptRead: cur.promptRead,
    outputTokens: cur.genTokens, genTps: cur.genTps,
    elapsedMs: startMs != null ? Math.max(0, now - startMs) : null,
    othersRunning: running.length - 1,
  };
}

// ---------- Perf rings (AI_SCOPE-103) ----------
// Token-speed boards for Bionic, the D3/D5 shape 101 established for llama.cpp, with Bionic's
// facts: the numbers are the engine's OWN log rates (the tg/tg_3s line a task prints while it
// generates), so no estimation machinery is needed, and the log names no slots, so rings key by
// model only. Sampled per /api/bionic call (the page's ~2 s cadence) but wall-throttled, so a
// faster poll (or several views) cannot flood a time-sized ring. A reading/starting stretch
// pushes NO gen point: generation speed during prefill does not exist (stratastats.js:198 is the
// phase-gate precedent) — the board shows a break + 097 border there, never the average.
const PERF_WIN = 300000, PERF_CAP = 400, PERF_PUSH_MS = 1750, PERF_EVERY = 2000;
const perfRings = {};   // model key -> { tps: [], next: 0 }
function trimPerf(a) {
  if (a.length < 2) return;
  const cut = a[a.length - 1].t - PERF_WIN;
  let i = 0;
  while (i < a.length - 2 && a[i].t < cut) i++;   // newest - window, plus ONE older sample (092)
  if (i) a.splice(0, i);
}
// cur = the record getCurrentRequest just built (the task the CARD shows: the highest live task
// id), or null. now is injectable so a probe can test the throttle / trim without real waits
// (the 098 ggufmeta precedent; the route calls it without the argument). One shared pick for
// card and rings: the two can never disagree (the 093 rule).
function samplePerf(cur, now) {
  if (now == null) now = Date.now();
  if (!cur || cur.phase !== 'generating' || cur.genTps == null) return;   // reading/starting/idle: no gen point (D3)
  const ring = perfRings[cur.model] || (perfRings[cur.model] = { tps: [], next: 0 });
  if (now < ring.next) return;
  ring.next = now + PERF_PUSH_MS;
  ring.tps.push({ t: now, every: PERF_EVERY, v: cur.genTps, m: cur.model });
  if (ring.tps.length > 1) trimPerf(ring.tps);
  if (ring.tps.length > PERF_CAP) ring.tps.splice(0, ring.tps.length - PERF_CAP);   // safety cap only
}
// The delta payload (084 item 7): only points newer than `since`, merged across models, oldest first.
function tpsHistorySince(since) {
  const out = [];
  Object.keys(perfRings).forEach(function (k) {
    const a = perfRings[k].tps;
    for (let i = 0; i < a.length; i++) if (a[i].t > since) out.push(a[i]);
  });
  out.sort(function (x, y) { return x.t - y.t; });
  return out;
}

// Token-weighted average generation speed for the most recently used model.
// AI_SCOPE-094 slice 3: one shared builder (reqstats); Bionic passes limit: null because its rows
// are read from the log with no saved ring, and they arrive newest-first.
function getAverage(rows) {
  if (!rows.length) return null;
  const model = rows[0].model;
  const a = reqstats.avgSpeed(rows, model, { timeField: 'genMs', limit: null });
  return a ? { model: model, genTps: a.value, requests: a.requests } : null;
}

// AI_SCOPE-103 (D3): the prompt twin of getAverage — stratastats.js:385's promptAverage shape over
// Bionic's log rows. The tokens weighed are `promptRead` (what the seconds cover), not promptTokens:
// Strata's builder does the same (stratastats.js:384), and it is why the average is a read rate.
function getPromptAverage(rows) {
  if (!rows.length) return null;
  const model = rows[0].model;
  const a = reqstats.avgSpeed(rows, model, { tokensField: 'promptRead', timeField: 'promptMs', limit: null });
  return a ? { model: model, promptTps: a.value, requests: a.requests } : null;
}

module.exports = { start: start, stop: stop, getLatestRequests: getLatestRequests, getCurrentRequest: getCurrentRequest, getAverage: getAverage, getPromptAverage: getPromptAverage, samplePerf: samplePerf, tpsHistorySince: tpsHistorySince, tsToMs: tsToMs,
  costDayBuckets: costDayBuckets,
  // AI_SCOPE-131: the route reads costDayBuckets(getLatestRequests(1000).rows); the suites/probes drive the
  // 128 surface (attachEnergy / mapReqRow / saveRequest / energyVer / store / requests). Bionic has no later()
  // (the log feed saves on the next read) and no local flag, so those two names stay absent on purpose.
  _test: { attachEnergy: attachEnergy, attachPeak: attachPeak, mapReqRow: mapReqRow, saveRequest: saveRequest,
    store: store, requests: requests, known: known, energyVer: function () { return ENERGY_VER; } } };
