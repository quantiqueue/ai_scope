// AI_SCOPE-094 (slice 1): one shared store for the per-scope request / run histories.
//
// Each scope gets its OWN store instance: its own jsonl file, its own in-memory ring,
// its own on-disk cap. Nothing is shared between scopes except the code — a single
// common pool would let the busiest app (Strata) evict a quiet one's (Bionic's) history.
//
// What the store owns: the jsonl read, the per-line parse (a bad line is skipped, never
// fatal), the end-time sort, the in-memory trim, the append, and the on-disk compaction.
// What stays in the scope module: which rows it accepts (its own filter), what it does
// after a load (Ollama reseeds its id counter), the row identity, and how a save failure
// is reported (onError writes the module's own lastError, exactly as the old try/catch did).
//
// The field-name map (mapRow) is an identity map for now; slice 2 fills it when the
// canonical record names land. Old files are never renamed or rewritten in place, so the
// map is permanent, not transitional.

const fs = require('fs');
const paths = require('./paths');

const MEM_CAP = 1000;        // rows kept in memory per store
const DISK_MULTIPLE = 5;     // on-disk cap = 5 x memory cap (decision 2c)

// One store for one file.
//   o.file         full path to the jsonl file
//   o.memCap       optional override of MEM_CAP
//   o.diskCap      optional override of memCap * DISK_MULTIPLE
//   o.accept(r)    optional: keep this loaded row? (default: every parsed object)
//   o.remember(r)  optional: called for every kept row, loaded and saved (Strata's `known`)
//   o.mapRow(r)    optional: read-side field-name map (identity until slice 2)
//   o.resortOnAppend  default true: re-sort when a row lands out of end-time order
//   o.onError(msg) called when a write or compaction fails
//   o.onLoaded(rows) called once, after the first load
function createStore(o) {
  const file = o.file;
  const memCap = o.memCap > 0 ? o.memCap : MEM_CAP;
  // Hard rule from decision 2b: the on-disk cap can never sit below the memory cap,
  // or a restart would silently shorten history below what the lenses already show.
  const diskCap = Math.max(memCap, o.diskCap > 0 ? o.diskCap : memCap * DISK_MULTIPLE);
  // AI_SCOPE-106 (item 1): diskCap is the TRIGGER, not the landing height. compact() used to trim to exactly
  // diskCap, so lineCount rested on the trigger edge and EVERY later append re-read and re-wrote the whole
  // file - a few MB of sync I/O per request. Landing one ring-window lower leaves memCap appends of headroom
  // before the next compaction: one rewrite per memCap requests, not one per request.
  // For the 5x default this is the user's memCap * (DISK_MULTIPLE - 1) = 4000, written as diskCap - memCap so
  // it stays correct for any override. Two rules it must never break: it keeps at least memCap rows (the same
  // 2b rule as diskCap - history on disk can't fall under what the lenses show), and it stays below the
  // trigger whenever there is room to, so a compaction can never leave the file on the edge again.
  // The else branch is the no-room case (a caller whose diskCap sits at the memory cap): keep the whole ring,
  // compact() then finds nothing above diskCap to drop, and every row is on disk anyway.
  const compactTo = diskCap > memCap ? Math.min(diskCap - 1, Math.max(memCap, diskCap - memCap)) : diskCap;
  const accept = o.accept || function () { return true; };
  const mapRow = o.mapRow || function (r) { return r; };
  const resort = o.resortOnAppend !== false;
  const rows = [];
  let lineCount = 0;        // non-empty lines in the file, counted at load, bumped on append
  let loaded = false;

  function byEnd(a, b) { return (a.end || 0) - (b.end || 0); }

  function rewrite(keepLines) {
    // Compact through a temp file + rename, so a crash mid-write cannot truncate history.
    const tmp = file + '.tmp';
    paths.ensure();
    fs.writeFileSync(tmp, keepLines.join('\n') + (keepLines.length ? '\n' : ''));
    fs.renameSync(tmp, file);
    lineCount = keepLines.length;
  }

  function compact() {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
      if (lines.length > diskCap) rewrite(lines.slice(-compactTo));
    } catch (e) {
      if (o.onError) o.onError('compact failed: ' + e.message);
    }
  }

  function load() {
    if (loaded) return rows;
    loaded = true;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return rows; }   // no file yet: not an error
    text.split(/\r?\n/).forEach(function (l) {
      if (!l.trim()) return;
      lineCount++;
      let r = null;
      try { r = JSON.parse(l); } catch (e) { return; }                          // skip a bad line
      if (!r || typeof r !== 'object' || Array.isArray(r)) return;
      r = mapRow(r);
      if (!accept(r)) return;
      if (o.remember) o.remember(r);
      rows.push(r);
    });
    rows.sort(byEnd);
    if (rows.length > memCap) rows.splice(0, rows.length - memCap);
    if (lineCount > diskCap) compact();
    if (o.onLoaded) o.onLoaded(rows);
    return rows;
  }

  function append(r) {
    if (o.remember) o.remember(r);
    rows.push(r);
    if (resort && rows.length > 1 && byEnd(rows[rows.length - 2], r) > 0) rows.sort(byEnd);
    if (rows.length > memCap) rows.shift();
    try {
      paths.ensure();
      fs.appendFileSync(file, JSON.stringify(r) + '\n');
      lineCount++;
      if (lineCount > diskCap) compact();
    } catch (e) {
      if (o.onError) o.onError('save failed: ' + e.message);
    }
    return r;
  }

  return {
    rows: function () { return rows; },
    load: load,
    append: append,
    memCap: function () { return memCap; },
    diskCap: function () { return diskCap; },
    compactTo: function () { return compactTo; },   // 106: exposed so a test can assert the headroom, not re-derive it
    fileLines: function () { return lineCount; }
  };
}

module.exports = { createStore: createStore, MEM_CAP: MEM_CAP, DISK_MULTIPLE: DISK_MULTIPLE };
