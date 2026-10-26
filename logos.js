// App logos for the tabs and Scopes page, read at runtime from the apps' own install folders. When an app's logo
// can't be read (app not installed here, moved, new format), a copy kept in assets/logos/ is used instead (see the
// README there); only if that is missing too -> 404, and the UI falls back to the scope's SVG icon.
// Override paths with OLLAMA_ICON / BIONIC_EXE / COMFY_ASAR / STRATA_BRAND (folder). No dependencies; conservative JS.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROGRAMS = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs');
const SOURCES = {
  ollama:   { type: 'ico',  file: process.env.OLLAMA_ICON   || path.join(PROGRAMS, 'Ollama', 'app.ico') },
  // Bionic's icon is the one inside Bionic.exe (its resources\icon.ico is still the old LM Studio icon).
  bionic:   { type: 'exe',  file: process.env.BIONIC_EXE    || path.join(PROGRAMS, 'Bionic', 'Bionic.exe') },
  comfyui:  { type: 'asar', file: process.env.COMFY_ASAR    || path.join(PROGRAMS, 'Comfy Desktop', 'resources', 'app.asar'),
              entry: ['assets', 'Comfy_Logo_x256.png'] },
  // Strata ships its mark as SVG in two versions: dark bars for light backgrounds, light bars for dark backgrounds.
  strata:   { type: 'svg', dir: process.env.STRATA_BRAND || path.join(PROGRAMS, 'Strata', 'host', 'dist', 'brand'),
              files: { light: 'strata-mark-light.svg', dark: 'strata-mark-dark.svg' } },
};
const cache = {};   // id -> { mtime, png } (png null = not available)
const FALLBACK_DIR = path.join(__dirname, 'assets', 'logos');   // bundled copies: <id>.png, strata-light/dark.svg
function fallback(name) { try { return fs.readFileSync(path.join(FALLBACK_DIR, name)); } catch (e) { return null; } }
function fallbackPng(id) { const b = fallback(id + '.png'); return b && b.length > 8 && b.readUInt32BE(0) === 0x89504e47 ? b : null; }
function fallbackSvg(id, theme) {
  const b = fallback(id + '-' + (theme === 'dark' ? 'dark' : 'light') + '.svg') || fallback(id + '-' + (theme === 'dark' ? 'light' : 'dark') + '.svg');
  return b && /<svg[\s>]/.test(String(b)) ? String(b) : null;
}

// Largest PNG image inside a .ico file (modern .ico files store the big sizes as PNG).
function pngFromIco(buf) {
  if (buf.length < 6 || buf.readUInt16LE(2) !== 1) return null;
  const n = buf.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < n; i++) {
    const e = 6 + 16 * i;
    if (e + 16 > buf.length) break;
    const w = buf[e] || 256, size = buf.readUInt32LE(e + 8), off = buf.readUInt32LE(e + 12);
    if (off + size > buf.length || buf.readUInt32BE(off) !== 0x89504e47) continue;   // PNG entries only
    if (!best || w > best.w || (w === best.w && size < best.size)) best = { w: w, size: size, off: off };
  }
  return best ? buf.slice(best.off, best.off + best.size) : null;
}

// Largest PNG icon embedded in a Windows .exe (its RT_ICON resources). Only the PE headers and the resource
// section are read, not the whole file (Bionic.exe is ~225 MB).
function pngFromExe(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const read = function (len, pos) { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return b.slice(0, n); };
    const dos = read(64, 0);
    if (dos.length < 64 || dos.toString('latin1', 0, 2) !== 'MZ') return null;
    const peOff = dos.readUInt32LE(0x3c);
    const hdr = read(4096, peOff);
    if (hdr.length < 248 || hdr.toString('latin1', 0, 4) !== 'PE\0\0') return null;
    const nSec = hdr.readUInt16LE(6), optSize = hdr.readUInt16LE(20), opt = 24;
    const magic = hdr.readUInt16LE(opt);
    const dd = opt + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1);
    if (dd < opt) return null;
    const rsrcRva = hdr.readUInt32LE(dd + 16);
    if (!rsrcRva) return null;
    let sec = null;
    for (let i = 0; i < nSec; i++) {
      const o = opt + optSize + 40 * i;
      if (o + 40 > hdr.length) break;
      const va = hdr.readUInt32LE(o + 12), vsize = Math.max(hdr.readUInt32LE(o + 8), hdr.readUInt32LE(o + 16));
      if (rsrcRva >= va && rsrcRva < va + vsize) sec = { va: va, raw: hdr.readUInt32LE(o + 20), size: hdr.readUInt32LE(o + 16) };
    }
    if (!sec || sec.size > 64 * 1024 * 1024) return null;
    const res = read(sec.size, sec.raw), root = rsrcRva - sec.va;
    const entries = function (off) {   // resource directory -> [{ id, off, dir }]
      const out = [], n = res.readUInt16LE(off + 12) + res.readUInt16LE(off + 14);
      for (let i = 0; i < n; i++) {
        const e = off + 16 + 8 * i, name = res.readUInt32LE(e), to = res.readUInt32LE(e + 4);
        out.push({ id: name & 0x80000000 ? null : name, off: root + (to & 0x7fffffff), dir: !!(to & 0x80000000) });
      }
      return out;
    };
    let best = null;
    entries(root).filter(function (t) { return t.id === 3 && t.dir; }).forEach(function (t) {          // RT_ICON
      entries(t.off).forEach(function (icon) {
        if (!icon.dir) return;
        const leaf = entries(icon.off)[0];                                                             // first language
        if (!leaf || leaf.dir) return;
        const start = res.readUInt32LE(leaf.off) - sec.va, size = res.readUInt32LE(leaf.off + 4);
        if (start < 0 || start + size > res.length || size < 24 || res.readUInt32BE(start) !== 0x89504e47) return;   // PNG icons only
        const w = res.readUInt32BE(start + 16);
        if (!best || w > best.w || (w === best.w && size < best.size)) best = { w: w, start: start, size: size };
      });
    });
    return best ? Buffer.from(res.slice(best.start, best.start + best.size)) : null;
  } catch (e) { return null; } finally { fs.closeSync(fd); }
}

// One file from an Electron .asar archive (header: 16 bytes + JSON index; file offsets are relative to the data start).
function fileFromAsar(file, entry) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4), jsonSize = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonSize);
    fs.readSync(fd, json, 0, jsonSize, 16);
    let node = JSON.parse(json.toString('utf8'));
    for (let i = 0; i < entry.length; i++) { node = node.files && node.files[entry[i]]; if (!node) return null; }
    if (node.unpacked || node.offset == null) return null;
    const out = Buffer.alloc(node.size);
    fs.readSync(fd, out, 0, node.size, 8 + headerSize + Number(node.offset));
    return out;
  } finally { fs.closeSync(fd); }
}

// SVG logo for a light or dark background (theme 'dark' = the version for dark backgrounds). Embedded metadata is
// dropped (Strata's files carry a large signed-provenance block). Returns a string or null.
function getSvg(id, theme) {
  const src = SOURCES[id];
  if (!src || src.type !== 'svg') return null;
  const want = theme === 'dark' ? ['dark', 'light'] : ['light', 'dark'];   // fall back to the other version
  for (let i = 0; i < want.length; i++) {
    const file = path.join(src.dir, src.files[want[i]]), key = id + ':' + want[i];
    let st;
    try { st = fs.statSync(file); } catch (e) { continue; }
    const c = cache[key];
    if (c && c.mtime === st.mtimeMs) { if (c.svg) return c.svg; continue; }
    let svg = null;
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (/<svg[\s>]/.test(text) && text.length < 500000) svg = text.replace(/<metadata>[\s\S]*?<\/metadata>/g, '');
    } catch (e) { svg = null; }
    cache[key] = { mtime: st.mtimeMs, svg: svg };
    if (svg) return svg;
  }
  return null;
}

function getLogo(id) { return liveLogo(id) || fallbackPng(id); }   // PNG: the app's own, else the bundled copy
function liveLogo(id) {
  const src = SOURCES[id];
  if (!src || src.type === 'svg') return null;
  let st;
  try { st = fs.statSync(src.file); } catch (e) { return null; }
  const c = cache[id];
  if (c && c.mtime === st.mtimeMs) return c.png;
  let png = null;
  try {
    if (src.type === 'ico') png = pngFromIco(fs.readFileSync(src.file));
    else if (src.type === 'exe') png = /\.ico$/i.test(src.file) ? pngFromIco(fs.readFileSync(src.file)) : pngFromExe(src.file);
    else png = fileFromAsar(src.file, src.entry);
    if (png && png.readUInt32BE(0) !== 0x89504e47) png = null;
  } catch (e) { png = null; }
  cache[id] = { mtime: st.mtimeMs, png: png };
  return png;
}

function serve(id, res, theme) {
  const src = SOURCES[id];
  if (src && src.type === 'svg') {
    const svg = getSvg(id, theme) || fallbackSvg(id, theme);
    if (!svg) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no logo'); }
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=3600' });
    return res.end(svg);
  }
  const png = getLogo(id);
  if (!png) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no logo'); }
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
  res.end(png);
}

module.exports = { serve: serve, getLogo: getLogo, getSvg: getSvg, fallbackSvg: fallbackSvg };
