// App logos for the tabs and Scopes page, read at runtime from the apps' own install folders. When an app's logo
// can't be read (app not installed here, moved, new format), a copy kept in assets/logos/ is used instead (see the
// README there); only if that is missing too -> 404, and the UI falls back to the scope's SVG icon.
// Override paths with OLLAMA_ICON / LMSTUDIO_ICON / COMFY_ASAR / STRATA_BRAND (folder). No dependencies; conservative JS.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROGRAMS = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs');
const SOURCES = {
  ollama:   { type: 'ico',  file: process.env.OLLAMA_ICON   || path.join(PROGRAMS, 'Ollama', 'app.ico') },
  lmstudio: { type: 'ico',  file: process.env.LMSTUDIO_ICON || path.join(PROGRAMS, 'Bionic', 'resources', 'icon.ico') },
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
