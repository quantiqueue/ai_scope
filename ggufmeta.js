// GGUF header reader (AI_SCOPE-098 review): the model file's own KV metadata.
// AI_SCOPE cannot know a model's Hugging Face repo from an app's catalog (Strata's /api/native
// carries none), but the GGUF itself says it: general.repo_url / general.quantized_by /
// general.basename / general.size_label, written by whoever quantized the file. llama.cpp's
// router /v1/models exposes the same fields for LOADED models; unloaded ones we read from disk,
// the way llamacppstats already statSync's the GGUF for its size (same local-file convention).
//
// Rules: read-only; never throw; a missing/short/corrupt header yields null (the column shows a
// gap - never an invented link). Results are cached by path + size + mtime, refreshed only when
// the file changed. No dependencies; conservative JS for older Node versions.
'use strict';
const fs = require('fs');

const CHUNK = 2 * 1024 * 1024;
const MAXLEN = 48 * 1024 * 1024;   // vocabularies push the metadata past 30 MB on big models
const cache = new Map();           // path -> { key, meta }

function parse(buf, len) {
  // returns { meta } on a complete read, { more: true, meta } when the buffer ran out mid-KV (106:
  //   meta carries every key parsed up to that point),
  // { bad: reason } when it is not a readable GGUF header
  if (len < 24 || buf.slice(0, 4).toString('latin1') !== 'GGUF') return { bad: 'not GGUF' };
  const version = buf.readUInt32LE(4);
  if (version < 2) return { bad: 'old GGUF v' + version };
  let o = 8;
  const u64 = () => { const v = buf.readBigUInt64LE(o); o += 8; return Number(v); };
  u64();                                  // n_tensors (the tensor table comes AFTER the KV section)
  const nkv = u64();
  if (nkv <= 0 || nkv > 10000) return { bad: 'absurd kv count' };
  const TYPESZ = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
  const meta = {};
  // 106 item 3: a truncated read used to report { more: true } with NO meta, so every key already
  // parsed was thrown away and header() returned null for any model whose metadata outruns the
  // buffer - exactly the big-vocabulary case MAXLEN is sized for. general.* keys come first in a GGUF.
  const partial = function () { return { more: true, meta: meta }; };
  for (let i = 0; i < nkv; i++) {
    if (o + 8 > len) return partial();
    const kl = Number(buf.readBigUInt64LE(o)); o += 8;
    if (kl <= 0 || kl > 4096) return { bad: 'bad key length' };
    if (o + kl + 4 > len) return partial();
    const key = buf.slice(o, o + kl).toString('utf8'); o += kl;
    const t = buf.readUInt32LE(o); o += 4;
    if (t === 8) {                        // string
      if (o + 8 > len) return partial();
      const sl = Number(buf.readBigUInt64LE(o)); o += 8;
      if (sl < 0 || o + sl > len) return partial();
      if (key.startsWith('general.')) meta[key] = buf.slice(o, o + sl).toString('utf8');
      o += sl;
    } else if (TYPESZ[t]) {               // scalar: value only wanted for the interesting keys
      const sz = TYPESZ[t];
      if (o + sz > len) return partial();
      if (key.startsWith('general.')) {
        meta[key] = t === 4 ? buf.readUInt32LE(o) : t === 5 ? buf.readInt32LE(o) : t === 6 ? buf.readFloatLE(o)
          : t === 7 ? !!buf[o] : t === 0 ? buf[o] : t === 1 ? buf.readInt8(o)
          : t === 2 ? buf.readUInt16LE(o) : t === 3 ? buf.readInt16LE(o)
          : t === 10 ? Number(buf.readBigUInt64LE(o)) : t === 11 ? Number(buf.readBigInt64LE(o)) : buf.readDoubleLE(o);
      }
      o += sz;
    } else if (t === 9) {                 // array
      if (o + 12 > len) return partial();
      const at = buf.readUInt32LE(o); o += 4;
      const n = Number(buf.readBigUInt64LE(o)); o += 8;
      if (at === 8) {                     // strings: skip per element (never materialise a 150k vocab)
        for (let j = 0; j < n; j++) {
          if (o + 8 > len) return partial();
          const sl = Number(buf.readBigUInt64LE(o)); o += 8 + sl;
        }
      } else if (TYPESZ[at] && n * TYPESZ[at] >= 0) {
        const skip = n * TYPESZ[at];
        if (o + skip > len) return partial();
        o += skip;
      } else return { bad: 'unknown array type' };
    } else return { bad: 'unknown type ' + t };
  }
  return { meta: meta };
}

// file: absolute path to a GGUF (shard 1 of a split set holds the metadata).
// Returns { repoUrl, quantizedBy, basename, sizeLabel, name } or null.
function header(file) {
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    const key = st.size + '|' + st.mtimeMs;
    const hit = cache.get(file);
    if (hit && hit.key === key) return hit.meta;
    const want = Math.min(st.size, MAXLEN);
    const buf = Buffer.alloc(want);
    const fd = fs.openSync(file, 'r');
    let got = 0;
    while (got < want) {
      const r = fs.readSync(fd, buf, got, Math.min(CHUNK, want - got), got);
      if (!r) break;
      got += r;
      const p = parse(buf, got);          // re-parse as it grows: usually finishes at the first pass
      if (!p.more) { fs.closeSync(fd); const m = pick(p.meta || {}); cache.set(file, { key: key, meta: m }); return m; }
      if (got >= MAXLEN) break;
    }
    fs.closeSync(fd);
    const p = parse(buf, got);
    const m = p.meta ? pick(p.meta) : null;   // partial header: still use what was read
    cache.set(file, { key: key, meta: m });
    return m;
  } catch (e) { return null; }
}

function pick(g) {
  const m = {
    repoUrl: g['general.repo_url'] || null,
    quantizedBy: g['general.quantized_by'] || null,
    basename: g['general.basename'] || null,
    sizeLabel: g['general.size_label'] || null,
    name: g['general.name'] || null
  };
  if (!m.repoUrl && !m.quantizedBy && !m.basename && !m.sizeLabel) return null;
  return m;
}

module.exports = { header: header };
