'use strict';
const http = require('http');
const os = require('os');
const lmstats = require('./lmstats');
const sysstats = require('./sysstats');
const logos = require('./logos');
const comfystats = require('./comfystats');
const ollamastats = require('./ollamastats');
const lmapi = require('./lmapi');
const scopes = require('./scopes');
sysstats.start();   // SYSTEM is built in (its VRAM total is also used by the other scopes)
scopes.init();      // starts the modules of every installed scope (scopes.json + data/installed.json)

// Port/host come from the command line (bin/ai-scope.js sets these) or the environment.
// 127.0.0.1 = this PC only; 0.0.0.0 = also other devices on your network.
// `npx ai-scope` defaults to 127.0.0.1; running server.js directly (dev.js / start.bat) defaults to 0.0.0.0.
const PORT = parseInt(process.env.AI_SCOPE_PORT, 10) || 9000;
const HOST = process.env.AI_SCOPE_HOST || '0.0.0.0';
const BOOT_ID = Date.now().toString(); // changes on every restart; the page uses it to auto-reload

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI_SCOPE</title>
<script>try { var t = JSON.parse(localStorage.getItem('aiscope.theme')); if (t === 'dark' || t === 'magenta') document.documentElement.dataset.theme = t; } catch (e) {}</script>
<style>
  :root { --bg:#f6f6f7; --card:#fff; --text:#18181b; --muted:#71717a; --line:#e4e4e7; --accent:#2563eb; --good:#16a34a; --mid:#ca8a04; --bad:#dc2626; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme]) { --bg:#0f0f11; --card:#18181b; --text:#f4f4f5; --muted:#a1a1aa; --line:#27272a; --accent:#60a5fa; color-scheme:dark; } }
  /* Theme picker (top-right): no data-theme = Default (follows the OS light/dark setting) */
  :root[data-theme="dark"] { --bg:#0f0f11; --card:#18181b; --text:#f4f4f5; --muted:#a1a1aa; --line:#27272a; --accent:#60a5fa; color-scheme:dark; }
  :root[data-theme="magenta"] { --bg:#13080f; --card:#1f0d19; --text:#fdeaf5; --muted:#c79ab7; --line:#3d1d33; --accent:#ff3fa4;
    --good:#34d399; --mid:#fbbf24; --bad:#f43f5e; color-scheme:dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--text); }
  .topbar { position:sticky; top:0; z-index:10; display:flex; align-items:stretch; gap:28px; padding:0 24px;
            background:var(--card); border-bottom:1px solid var(--line); height:52px; }
  .brand { display:flex; align-items:center; font-family: ui-monospace, Consolas, monospace; font-weight:800;
           font-size:1.05rem; letter-spacing:.12em; color:var(--text); text-decoration:none; }
  .brand span { color:var(--accent); }
  .tabs { display:flex; gap:4px; overflow-x:auto; overflow-y:hidden; scrollbar-width:none; }
  .tabs::-webkit-scrollbar { display:none; }
  .tab { display:flex; align-items:center; padding:0 14px; color:var(--muted); text-decoration:none; font-size:.9rem;
         font-weight:550; white-space:nowrap; }
  .tab:hover { color:var(--text); }
  .tab.dragging { opacity:.35; }
  .tab[draggable="true"] { -webkit-user-drag: element; user-select:none; }
  .tab.active { color:var(--text); box-shadow: inset 0 -2px 0 var(--accent); }
  .panel[hidden] { display:none; }
  /* Home (landing) panel: animated black/blue low-poly field under the top bar */
  .home { position:fixed; top:52px; left:0; right:0; bottom:0; overflow:hidden; background:#02040a; color:#e8f0ff; }
  .home canvas { position:absolute; inset:0; width:100%; height:100%; display:block; }
  .home .vignette { position:absolute; inset:0; pointer-events:none;
    background: radial-gradient(ellipse at 50% 50%, rgba(2,4,10,0) 35%, rgba(2,4,10,.55) 100%); }
  .home .hero { position:relative; height:100%; display:grid; place-content:center; justify-items:center; gap:22px;
    text-align:center; padding:0 16px; }
  .home .mark { margin:0; font-family:"JetBrains Mono", ui-monospace, Consolas, monospace; font-weight:800; letter-spacing:.14em;
    font-size:clamp(2.6rem, 9vw, 6.5rem); line-height:1; color:#e8f0ff;
    text-shadow:0 0 40px rgba(74,168,255,.35), 0 2px 18px rgba(0,0,0,.6); }
  .home .mark span { color:#4aa8ff; animation: homeBlink 2.4s steps(1) infinite; }
  @keyframes homeBlink { 50% { opacity:.25; } }
  .home .sub { margin:0; font-family:"JetBrains Mono", ui-monospace, Consolas, monospace; font-weight:500; font-size:.85rem;
    letter-spacing:.28em; text-transform:uppercase; color:#8ea3c7; }
  .home .go { font-family:"JetBrains Mono", ui-monospace, Consolas, monospace; font-size:.9rem; letter-spacing:.08em; color:#e8f0ff;
    text-decoration:none; padding:10px 20px; border:1px solid rgba(142,163,199,.28); border-radius:4px;
    background:rgba(2,4,10,.45); backdrop-filter:blur(4px); transition:border-color .2s, background .2s; }
  .home .go:hover, .home .go:focus-visible { border-color:#4aa8ff; background:rgba(10,40,90,.5); outline:none; }
  @media (prefers-reduced-motion: reduce) { .home .mark span { animation:none; } }
  .tab .x { margin-left:8px; width:18px; height:18px; display:inline-grid; place-items:center; border-radius:4px;
            font-size:.95rem; line-height:1; color:var(--muted); opacity:0; }
  .tab:hover .x, .tab.active .x { opacity:.7; }
  .tab .x:hover { opacity:1; background:var(--line); color:var(--text); }
  .addwrap { position:relative; display:flex; align-items:center; margin-left:-20px; }
  .addbtn { text-decoration:none; width:30px; height:30px; border-radius:6px; border:1px solid transparent; background:none; color:var(--muted);
            font-size:1.25rem; line-height:1; cursor:pointer; display:grid; place-items:center; }
  .addbtn:hover, .addbtn[aria-expanded="true"] { background:var(--bg); border-color:var(--line); color:var(--text); }
  .addbtn.active { background:var(--bg); border-color:var(--line); color:var(--text); box-shadow: inset 0 -2px 0 var(--accent); }
  .themewrap { position:relative; display:flex; align-items:center; margin-left:auto; }
  .themebtn { display:flex; align-items:center; gap:7px; height:30px; padding:0 10px; border-radius:6px; border:1px solid transparent;
              background:none; color:var(--muted); font:inherit; font-size:.82rem; cursor:pointer; }
  .themebtn:hover, .themebtn[aria-expanded="true"] { background:var(--bg); border-color:var(--line); color:var(--text); }
  .themebtn svg { width:16px; height:16px; }
  .thememenu { position:absolute; top:calc(100% + 4px); right:0; min-width:170px; padding:5px; background:var(--card);
               border:1px solid var(--line); border-radius:8px; box-shadow:0 10px 30px rgba(0,0,0,.18); z-index:20; }
  .thememenu[hidden] { display:none; }
  .thememenu button { display:flex; align-items:center; gap:10px; width:100%; padding:7px 9px; border:none; border-radius:5px;
                      background:none; color:var(--text); font:inherit; font-size:.85rem; text-align:left; cursor:pointer; }
  .thememenu button:hover, .thememenu button:focus-visible { background:var(--bg); outline:none; }
  .thememenu .sw { width:16px; height:16px; border-radius:50%; border:1px solid rgba(128,128,128,.35); flex:none; }
  .thememenu .ck { margin-left:auto; color:var(--accent); visibility:hidden; }
  .thememenu button[aria-checked="true"] .ck { visibility:visible; }
  /* Magenta theme: landing page wordmark/button follow the theme */
  [data-theme="magenta"] .home { background:#0a0208; color:#fdeaf5; }
  [data-theme="magenta"] .home .vignette { background: radial-gradient(ellipse at 50% 50%, rgba(10,2,8,0) 35%, rgba(10,2,8,.55) 100%); }
  [data-theme="magenta"] .home .mark { color:#fdeaf5; text-shadow:0 0 40px rgba(255,63,164,.38), 0 2px 18px rgba(0,0,0,.6); }
  [data-theme="magenta"] .home .mark span { color:#ff4fb0; }
  [data-theme="magenta"] .home .sub { color:#c79ab7; }
  [data-theme="magenta"] .home .go { color:#fdeaf5; border-color:rgba(199,154,183,.28); background:rgba(10,2,8,.45); }
  [data-theme="magenta"] .home .go:hover, [data-theme="magenta"] .home .go:focus-visible { border-color:#ff4fb0; background:rgba(90,10,60,.5); }
  .gallery { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); grid-auto-rows:1fr; gap:16px; } /* every card the same size */
  .square { min-height:200px; /* height comes from the grid row (tallest card), so all match */ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px;
            display:flex; flex-direction:column; cursor:pointer; transition:border-color .15s, transform .15s, box-shadow .15s; min-width:0; }
  .square:hover { border-color:var(--accent); transform:translateY(-2px); box-shadow:0 8px 24px rgba(0,0,0,.08); }
  .square .icon { width:44px; height:44px; border-radius:10px; display:grid; place-items:center;
                  background:color-mix(in srgb, var(--accent) 10%, transparent); color:var(--accent); }
  .square .icon svg { width:24px; height:24px; }
  .square .icon.logo { background:none; }
  .square .icon.logo img { width:44px; height:44px; object-fit:contain; display:block; }
  /* app logo dimmed behind the tab name */
  .tab { position:relative; padding:0 22px; }   /* equal padding both sides; the × sits in the right padding */
  .tab .x { position:absolute; right:2px; top:50%; transform:translateY(-50%); margin:0; }
  .tab .tname { position:relative; isolation:isolate; }
  /* centered on the tab name, not the whole tab */
  .tab .tname.has-logo::before { content:''; position:absolute; left:50%; top:50%; width:34px; height:34px;
                          transform:translate(-50%, -50%); z-index:-1; pointer-events:none;
                          background:var(--logo) center / contain no-repeat; opacity:.18; transition:opacity .15s; }
  .tab:hover .tname.has-logo::before, .tab.active:hover .tname.has-logo::before { opacity:1; }   /* full color on hover */
  .tab.active .tname.has-logo::before { opacity:.3; }
  .square .name { font-weight:650; font-size:1.05rem; margin-top:14px; }
  .square .desc { font-size:.82rem; color:var(--muted); margin-top:4px; line-height:1.35;
                  display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
  .square .foot { padding-top:10px; }
  .square .foot { margin-top:auto; display:flex; flex-direction:column; align-items:flex-start; gap:8px; }
  .badge { font-size:.7rem; font-weight:600; color:var(--good); background:rgba(22,163,74,.12); padding:2px 8px; border-radius:999px; white-space:nowrap; }
  .removebtn { font-size:.75rem; font-weight:600; color:#fff; background:var(--bad); border:none; border-radius:5px; padding:3px 10px; cursor:pointer; }
  .removebtn:hover { filter:brightness(1.1); }
  .installbtn { font-size:.75rem; font-weight:600; color:#fff; background:var(--accent); border:none; border-radius:5px; padding:3px 12px; cursor:pointer; }
  .installbtn:hover { filter:brightness(1.1); }
  .linkbtn { font:inherit; font-size:.75rem; color:var(--muted); background:none; border:none; padding:0; cursor:pointer; text-decoration:underline; }
  .linkbtn:hover { color:var(--accent); }
  .square .row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .badge.builtin { color:var(--muted); background:var(--line); }
  .square.off .icon, .square.off .name { opacity:.55; }
  .square.off .icon.logo img { filter:grayscale(1); }
  .square .scerr { font-size:.72rem; color:var(--bad); }
  dialog.modal { border:1px solid var(--line); border-radius:12px; padding:0; background:var(--card); color:var(--text);
                 width:min(480px, calc(100vw - 32px)); box-shadow:0 20px 60px rgba(0,0,0,.3); }
  dialog.modal::backdrop { background:rgba(0,0,0,.45); }
  .modal form { padding:20px 22px 18px; margin:0; }
  .modal h2 { font-size:1.1rem; margin:0 0 4px; display:flex; align-items:center; gap:10px; }
  .modal h2 img, .modal h2 svg { width:26px; height:26px; color:var(--accent); }
  .modal .lead { color:var(--muted); font-size:.85rem; margin:0 0 16px; line-height:1.45; }
  .modal .field { margin-bottom:14px; }
  .modal label { display:block; font-size:.8rem; font-weight:600; margin-bottom:5px; }
  .modal label .opt { font-weight:400; color:var(--muted); }
  .modal input { width:100%; font:inherit; font-size:.88rem; color:var(--text); background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:7px 10px; }
  .modal input[data-type="folder"], .modal input[data-type="url"] { font-family: ui-monospace, Consolas, monospace; font-size:.82rem; }
  .modal input:focus { outline:none; border-color:var(--accent); }
  .modal input.bad { border-color:var(--bad); }
  .modal .help { font-size:.76rem; color:var(--muted); margin-top:4px; line-height:1.4; }
  .modal .ferr { font-size:.76rem; color:var(--bad); margin-top:4px; }
  .modal .actions { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }
  .modal .btn { font:inherit; font-size:.85rem; font-weight:600; border-radius:6px; padding:6px 14px; cursor:pointer; border:1px solid var(--line); background:var(--card); color:var(--text); }
  .modal .btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  .modal .btn.danger { background:var(--bad); border-color:var(--bad); color:#fff; }
  .modal .btn:disabled { opacity:.6; cursor:default; }
  .modal .formerr { font-size:.8rem; color:var(--bad); margin-top:10px; }
  .empty { padding:60px 24px; text-align:center; color:var(--muted); }
  .section-head { padding:20px 24px 8px; display:flex; flex-wrap:wrap; align-items:baseline; gap:12px; }
  h1 { font-size:1.3rem; margin:0; }
  .meta { color:var(--muted); font-size:.85rem; }
  .wrap { padding:8px 24px 24px; }
  .card { --row-h:36px; background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:auto;
          max-height: calc(var(--row-h) * 26 + 2px); /* header + 25 rows, then scroll */ }
  thead tr, tbody tr { height: var(--row-h); }
  table { width:100%; border-collapse:collapse; font-size:.9rem; }
  th, td { padding:8px 12px; text-align:right; white-space:nowrap; border-bottom:1px solid var(--line); }
  th { position:sticky; top:0; background:var(--card); font-weight:600; color:var(--muted); font-size:.78rem; text-transform:uppercase; letter-spacing:.03em; }
  th:nth-child(-n+2), td:nth-child(-n+2) { text-align:left; }
  td.model { font-family: ui-monospace, Consolas, monospace; font-size:.82rem; }
  tr:last-child td { border-bottom:none; }
  tr.new td { animation: flash 2s ease-out; }
  @keyframes flash { from { background: color-mix(in srgb, var(--accent) 18%, transparent); } to { background: transparent; } }
  .tps { font-weight:600; font-variant-numeric: tabular-nums; }
  td { font-variant-numeric: tabular-nums; }
  .err { color:var(--bad); padding:16px; }
  .now { padding:16px 20px; margin-bottom:16px; overflow:visible; }
  .now-label { font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); font-weight:600; display:flex; align-items:center; gap:8px; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--muted); }
  .dot.live { background:var(--good); box-shadow:0 0 0 0 rgba(22,163,74,.6); animation:pulse 1.5s infinite; }
  @keyframes pulse { 70% { box-shadow:0 0 0 8px rgba(22,163,74,0); } 100% { box-shadow:0 0 0 0 rgba(22,163,74,0); } }
  .now-grid { display:flex; flex-wrap:wrap; gap:12px 40px; margin-top:10px; align-items:baseline; }
  .now-grid .k { font-size:.78rem; color:var(--muted); }
  .now-grid .v { font-size:1.6rem; font-weight:650; font-variant-numeric:tabular-nums; }
  .now-grid .v.model { font-size:1.05rem; font-family: ui-monospace, Consolas, monospace; font-weight:600; }
  .tiles { display:grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 496px), 1fr)); gap:16px; }
  .tgroup { display:grid; grid-template-columns: 1fr 1fr; gap:16px; min-width:0; } /* CPU+RAM, then GPU n + VRAM n side by side */
  @media (max-width: 560px) { .tgroup { grid-template-columns: 1fr; } }
  .tile { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 18px 12px; min-width:0; }
  .tile .k { font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); font-weight:600; }
  .tile .v { font-size:2rem; font-weight:650; font-variant-numeric:tabular-nums; margin-top:4px; }
  .tile .v small { font-size:1rem; color:var(--muted); font-weight:500; }
  .tile .sub { font-size:.8rem; color:var(--muted); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .meter { height:6px; background:var(--line); border-radius:3px; margin-top:10px; overflow:hidden; }
  .meter > div { height:100%; width:0; background:var(--accent); border-radius:3px; transition:width .4s; }
  .spark { position:relative; margin-top:10px; height:48px; }
  .spark svg { width:100%; height:100%; display:block; overflow:visible; }
  .spark .line { fill:none; stroke:var(--accent); stroke-width:2; stroke-linejoin:round; vector-effect:non-scaling-stroke; }
  .spark .area { fill:var(--accent); opacity:.12; }
  .spark .guide { stroke:var(--muted); stroke-width:1; opacity:.6; vector-effect:non-scaling-stroke; }
  .spark .tip { position:absolute; top:-26px; transform:translateX(-50%); background:var(--text); color:var(--bg);
                font-size:.72rem; padding:2px 6px; border-radius:4px; white-space:nowrap; pointer-events:none; }
  .spark-axis { display:flex; justify-content:space-between; font-size:.68rem; color:var(--muted); margin-top:2px; }
  .na { color:var(--muted); }
  .thumbs { display:flex; gap:4px; justify-content:flex-end; }
  .thumbs img { width:28px; height:28px; object-fit:cover; border-radius:4px; border:1px solid var(--line); display:block; background:var(--line); }
  .thumbs .more { font-size:.72rem; color:var(--muted); align-self:center; }
  .status { font-size:.72rem; font-weight:600; padding:2px 8px; border-radius:999px; }
  .status.success { color:var(--good); background:rgba(22,163,74,.12); }
  .status.error { color:var(--bad); background:rgba(220,38,38,.12); }
  .status.interrupted { color:var(--mid); background:rgba(202,138,4,.14); }
  .pbar { height:6px; width:180px; background:var(--line); border-radius:3px; overflow:hidden; margin-top:8px; }
  .pbar > div { height:100%; background:var(--accent); width:0; transition:width .4s; }
  .now-grid .v.small { font-size:1.05rem; }
  .dot.off { background:var(--bad); }
  .countdown { margin-top:10px; font-size:.78rem; color:var(--muted); }
  .sysload { display:flex; flex-wrap:wrap; align-items:flex-start; gap:6px 18px; margin-top:12px; padding-top:10px; border-top:1px solid var(--line); font-size:.8rem; }
  .sysload[hidden] { display:none; }
  .sysload .sl-label { font-size:.72rem; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); font-weight:600; cursor:help; }
  .sysload .sl-items { display:grid; grid-auto-flow:row; gap:6px 22px; max-width:100%; overflow-x:auto; } /* row 1: GPU % + CPU %, row 2: VRAM + RAM */
  .sl-item { display:inline-flex; align-items:center; gap:6px; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .sl-k { color:var(--muted); min-width:4.3em; } /* same label width in both rows, so the meters line up */
  .sl-meter { width:46px; height:5px; background:var(--line); border-radius:3px; overflow:hidden; }
  .sl-meter > div { height:100%; background:var(--accent); border-radius:3px; transition:width .4s; }
  .sl-v { font-weight:600; }
  td.peak { cursor:help; }
  .blockhead { font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); font-weight:600;
               margin:22px 2px 8px; display:flex; flex-wrap:wrap; gap:10px; align-items:baseline; }
  .blockhead .hint { text-transform:none; letter-spacing:0; font-weight:400; }
  .split { display:inline-flex; align-items:center; gap:8px; }
  .split .bar { width:70px; height:6px; border-radius:3px; background:var(--mid); overflow:hidden; }
  .split .bar > div { height:100%; background:var(--good); }
  .fit { font-size:.72rem; font-weight:600; padding:2px 8px; border-radius:999px; }
  .fit.fits { color:var(--good); background:rgba(22,163,74,.12); }
  .fit.tight { color:var(--mid); background:rgba(202,138,4,.14); }
  .fit.spills { color:var(--bad); background:rgba(220,38,38,.12); }
  .fit.multi { color:var(--accent); background:color-mix(in srgb, var(--accent) 14%, transparent); }
  .hintbox { color:var(--muted); padding:16px; font-size:.88rem; line-height:1.6; white-space:normal; }
  .hintbox code { font-family: ui-monospace, Consolas, monospace; font-size:.82rem; background:var(--bg); border:1px solid var(--line); padding:1px 6px; border-radius:4px; color:var(--text); }
  .helpbtn { width:18px; height:18px; border-radius:50%; border:1px solid var(--line); background:var(--card); color:var(--muted);
             font-size:.7rem; font-weight:700; line-height:1; padding:0; cursor:pointer; display:inline-grid; place-items:center; align-self:center; }
  .helpbtn:hover, .helpbtn[aria-expanded="true"] { color:var(--accent); border-color:var(--accent); }
  .helpcard { margin-bottom:12px; padding:14px 18px; font-size:.86rem; line-height:1.6; max-height:none; }
  .helpcard p { margin:0 0 8px; }
  .helpcard ul { margin:0; padding-left:18px; }
  .helpcard li { margin:4px 0; }
  .helpcard code { font-family: ui-monospace, Consolas, monospace; font-size:.8rem; background:var(--bg); border:1px solid var(--line); padding:1px 6px; border-radius:4px; }
  .pager { display:flex; justify-content:flex-end; align-items:center; gap:10px; margin-top:8px; font-size:.8rem; color:var(--muted); }
  .pager button { font:inherit; color:var(--text); background:var(--card); border:1px solid var(--line); border-radius:6px; padding:3px 10px; cursor:pointer; }
  .pager button:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); }
  .pager button:disabled { opacity:.4; cursor:default; }
  .chips { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 10px; }
  .chip { font:inherit; font-size:.78rem; color:var(--muted); background:var(--card); border:1px solid var(--line); border-radius:999px; padding:3px 10px; cursor:pointer; }
  .chip:hover { color:var(--text); }
  .chip.on { color:var(--accent); border-color:var(--accent); background:color-mix(in srgb, var(--accent) 8%, transparent); }
  a.ext { color:inherit; text-decoration:none; white-space:nowrap; }
  a.ext:hover { color:var(--accent); }
  .extico { width:11px; height:11px; margin-left:4px; vertical-align:-1px; color:var(--muted); flex:none; }
  a.ext:hover .extico, a.tag:hover .extico { color:var(--accent); }
  a.tag .extico { width:9px; height:9px; margin-left:3px; color:inherit; }
  a.tag { text-decoration:none; }
  a.tag:hover { filter:brightness(1.15); }
  .tag { font-size:.68rem; font-weight:600; color:var(--accent); background:color-mix(in srgb, var(--accent) 10%, transparent); padding:1px 6px; border-radius:999px; margin-left:6px; }
</style>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;800&display=swap">
</head>
<body>
<nav class="topbar">
  <a class="brand" href="#home">AI<span>_</span>SCOPE</a>
  <div class="tabs" id="tabs"><!-- rendered from SCOPES in the script below --></div>
  <div class="addwrap">
    <a class="addbtn" id="addBtn" href="#scopes" title="Scopes">+</a>
  </div>
  <div class="themewrap">
    <button class="themebtn" id="themeBtn" type="button" aria-haspopup="menu" aria-expanded="false" title="Theme">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="13.5" cy="6.5" r="1.2"/><circle cx="17.5" cy="10.5" r="1.2"/><circle cx="8.5" cy="7.5" r="1.2"/><circle cx="6.5" cy="12.5" r="1.2"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16c3.1 0 5.6-2.5 5.6-5.6C21.6 6 17.3 2 12 2z"/></svg>
      <span id="themeName">Default</span>
    </button>
    <div class="thememenu" id="themeMenu" role="menu" hidden>
      <button type="button" role="menuitemradio" data-theme-opt="default" aria-checked="false"><span class="sw" style="background:linear-gradient(135deg,#f6f6f7 50%,#18181b 50%)"></span>Default<span class="ck">&#10003;</span></button>
      <button type="button" role="menuitemradio" data-theme-opt="dark" aria-checked="false"><span class="sw" style="background:#18181b"></span>Dark<span class="ck">&#10003;</span></button>
      <button type="button" role="menuitemradio" data-theme-opt="magenta" aria-checked="false"><span class="sw" style="background:linear-gradient(135deg,#1f0d19 50%,#ff3fa4 50%)"></span>Magenta<span class="ck">&#10003;</span></button>
    </div>
  </div>
</nav>
<div class="empty" id="noTabs" hidden>No scopes open. Click <b>+</b> to open one.</div>

<section class="panel home" data-panel="home" hidden>
  <canvas id="homeBg" aria-hidden="true"></canvas>
  <div class="vignette"></div>
  <div class="hero">
    <h1 class="mark">AI<span>_</span>SCOPE</h1>
    <p class="sub">Local AI monitor</p>
    <a class="go" id="homeGo" href="#scopes">Open dashboard &rarr;</a>
  </div>
</section>

<section class="panel" data-panel="scopes">
  <div class="section-head">
    <h1>Scopes</h1>
    <span class="meta">Install a scope to add its tab &middot; click an installed scope to open it</span>
  </div>
  <div class="wrap"><div class="gallery" id="gallery"></div></div>
</section>
<dialog class="modal" id="scopeDlg"><form method="dialog" id="scopeForm" novalidate></form></dialog>

<section class="panel" data-panel="comfyui">
  <div class="section-head">
    <h1>ComfyUI &mdash; Workflow Runs</h1>
    <span class="meta" id="cMeta">Loading&hellip;</span>
  </div>
  <div class="wrap">
    <div class="card now">
      <div class="now-label"><span class="dot" id="cDot"></span><span id="cTitle">Current job</span></div>
      <div class="now-grid">
        <div><div class="k">Model</div><div class="v model" id="cModel">—</div></div>
        <div id="cProgBox"><div class="k" id="cProgLabel">Progress</div><div class="v" id="cProg">—</div>
          <div class="pbar"><div id="cBar"></div></div></div>
        <div id="cRateBox"><div class="k">Speed</div><div class="v small" id="cRate">—</div></div>
        <div id="cTimeBox"><div class="k" id="cTimeLabel">Elapsed</div><div class="v" id="cTime">—</div></div>
      </div>
      <div class="sysload" id="cLoad" hidden><span class="sl-label" title="Whole-computer totals (all apps together), not only this request">System load</span><span class="sl-items"></span></div>
      <div class="countdown" id="cFoot">&nbsp;</div>
    </div>
    <div class="blockhead">Runs</div>
    <div class="card">
      <table>
        <thead><tr>
          <th>Finished</th><th>Model</th><th>Size</th><th>Steps</th><th>Sampler</th>
          <th>Run time</th><th>Peak load</th><th>Status</th><th>Images</th>
        </tr></thead>
        <tbody id="cRows"></tbody>
      </table>
      <div class="err" id="cErr" hidden></div>
    </div>

    <div class="blockhead">Installed models <span class="hint" id="cmHint"></span></div>
    <div class="chips" id="cmChips"></div>
    <div class="card">
      <table>
        <thead><tr><th>Model</th><th>Publisher</th><th>Type</th><th>Size</th><th>VRAM fit</th><th>Runs</th><th>Last used</th><th>Avg run time</th><th>Added</th></tr></thead>
        <tbody id="cmRows"></tbody>
      </table>
      <div class="hintbox" id="cmEmpty" hidden></div>
    </div>
    <div class="pager" id="cmPager" hidden></div>
  </div>
</section>

<section class="panel" data-panel="ollama">
  <div class="section-head">
    <h1>Ollama &mdash; Models &amp; Requests</h1>
    <span class="meta" id="oMeta">Loading&hellip;</span>
  </div>
  <div class="wrap">
    <div class="card now">
      <div class="now-label"><span class="dot" id="oDot"></span><span id="oTitle">Current request</span></div>
      <div class="now-grid">
        <div><div class="k">Model</div><div class="v model" id="oModel">—</div></div>
        <div id="oTpsBox"><div class="k" id="oTpsLabel">Current gen tok/s</div><div class="v" id="oTps">—</div></div>
        <div id="oTokBox"><div class="k">Tokens so far</div><div class="v small" id="oTok">—</div></div>
        <div id="oTimeBox"><div class="k">Elapsed</div><div class="v" id="oTime">—</div></div>
      </div>
      <div class="sysload" id="oLoad" hidden><span class="sl-label" title="Whole-computer totals (all apps together), not only this request">System load</span><span class="sl-items"></span></div>
      <div class="countdown" id="oFoot">&nbsp;</div>
    </div>

    <div class="blockhead">Loaded in memory <span class="hint" id="oLoadedHint"></span></div>
    <div class="card">
      <table>
        <thead><tr><th>Model</th><th>Params</th><th>Size</th><th>Context</th><th>GPU</th><th>Auto-unload</th></tr></thead>
        <tbody id="oLoaded"></tbody>
      </table>
      <div class="hintbox" id="oLoadedEmpty" hidden></div>
    </div>

    <div class="blockhead">Requests <span class="hint" id="oReqHint"></span>
      <button class="helpbtn" id="oHelpBtn" type="button" title="Why only these requests? How to set it up" aria-expanded="false">?</button></div>
    <div class="card helpcard" id="oHelp" hidden></div>
    <div class="card">
      <table>
        <thead><tr>
          <th>Timestamp</th><th>Model</th><th>Gen tok/s</th><th>Gen tokens</th><th>Prompt tok/s</th><th>Prompt tokens</th>
          <th>Load time</th><th>Time to first token</th><th>Total time</th><th>Peak load</th>
        </tr></thead>
        <tbody id="oRows"></tbody>
      </table>
      <div class="hintbox" id="oRowsEmpty" hidden></div>
    </div>
    <div class="pager" id="oPager" hidden></div>

    <div class="blockhead">Installed models <span class="hint" id="oInstHint"></span></div>
    <div class="card">
      <table>
        <thead><tr><th>Model</th><th>Publisher</th><th>Arch</th><th>Params</th><th>Quant</th><th>Size</th><th>Features</th><th>VRAM fit</th><th>Max context</th><th>Modified</th></tr></thead>
        <tbody id="oInst"></tbody>
      </table>
    </div>
  </div>
</section>

<section class="panel" data-panel="system">
  <div class="section-head">
    <h1>System</h1>
    <span class="meta" id="sysMeta">Loading&hellip;</span>
  </div>
  <div class="wrap">
    <div class="tiles" id="tiles"></div>
  </div>
</section>

<section class="panel" data-panel="lmstudio">
<div class="section-head">
  <h1>LM Studio &mdash; Models &amp; Requests</h1>
  <span class="meta" id="meta">Loading&hellip;</span>
</div>
<div class="wrap">
  <div class="card now">
    <div class="now-label"><span class="dot" id="nowDot"></span><span id="nowTitle">Current request</span></div>
    <div class="now-grid">
      <div><div class="k">Model</div><div class="v model" id="nowModel">—</div></div>
      <div><div class="k" id="nowTpsLabel">Current gen tok/s</div><div class="v" id="nowTps">—</div></div>
      <div id="nowTokBox"><div class="k">Tokens so far</div><div class="v small" id="nowTok">—</div></div>
      <div id="nowTimeBox"><div class="k">Elapsed</div><div class="v" id="nowTime">—</div></div>
    </div>
    <div class="sysload" id="nowLoad" hidden><span class="sl-label" title="Whole-computer totals (all apps together), not only this request">System load</span><span class="sl-items"></span></div>
    <div class="countdown" id="countdown">&nbsp;</div>
  </div>

  <div class="blockhead">Loaded in memory <span class="hint" id="lLoadedHint"></span></div>
  <div class="card">
    <table>
      <thead><tr><th>Model</th><th>Params</th><th>Size</th><th>Context</th><th>Flash attention</th><th>KV cache</th><th>Parallel</th><th>Auto-unload</th></tr></thead>
      <tbody id="lLoaded"></tbody>
    </table>
    <div class="hintbox" id="lLoadedEmpty" hidden></div>
  </div>

  <div class="blockhead">Requests <span class="hint">— from LM Studio&#39;s server logs</span></div>
  <div class="card">
    <table>
      <thead><tr>
        <th>Timestamp</th><th>Model</th>
        <th>Gen tok/s</th><th>Gen tokens</th>
        <th>Prompt tok/s</th><th>Prompt tokens</th>
        <th>Time to first token</th><th>Total time</th><th>Peak load</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="err" id="err" hidden></div>
  </div>
  <div class="pager" id="lPager" hidden></div>

  <div class="blockhead">Installed models <span class="hint" id="lInstHint"></span></div>
  <div class="card">
    <table>
      <thead><tr><th>Model</th><th>Publisher</th><th>Arch</th><th>Params</th><th>Quant</th><th>Size</th><th>Features</th><th>VRAM fit</th><th>Max context</th><th>Modified</th></tr></thead>
      <tbody id="lInst"></tbody>
    </table>
    <div class="hintbox" id="lInstEmpty" hidden></div>
  </div>
</div>
</section>
<script>
// ---------- Scopes (catalog: scopes.json; install state: data/installed.json) ----------
// Filled in by the server when it sends the page; refreshed from /api/scopes.
let SCOPES = /*__SCOPES__*/[];
function scopeById(id) { return SCOPES.find(x => x.id === id); }
function isInstalled(id) { const sc = scopeById(id); return !!(sc && sc.installed); }

// ---------- Paging for request tables ----------
const PAGE_SIZE = 15;
const pages = {};      // table key -> current page (0-based)
const pagerReload = {}; // table key -> function that re-renders the table
// Returns the slice of row HTML for the current page and updates the pager below the table.
function paginate(key, rowsHtml, pagerId) {
  const n = Math.max(1, Math.ceil(rowsHtml.length / PAGE_SIZE));
  let p = Math.min(pages[key] || 0, n - 1);
  pages[key] = p;
  const el = document.getElementById(pagerId);
  el.hidden = rowsHtml.length <= PAGE_SIZE;
  if (!el.hidden) {
    const from = p * PAGE_SIZE + 1, to = Math.min(rowsHtml.length, (p + 1) * PAGE_SIZE);
    const html = '<span>' + from + '–' + to + ' of ' + rowsHtml.length + '</span>' +
      '<button type="button" data-pager="' + key + '" data-dir="-1"' + (p === 0 ? ' disabled' : '') + '>‹ Newer</button>' +
      '<span>Page ' + (p + 1) + ' / ' + n + '</span>' +
      '<button type="button" data-pager="' + key + '" data-dir="1"' + (p >= n - 1 ? ' disabled' : '') + '>Older ›</button>';
    if (el._html !== html) { el._html = html; el.innerHTML = html; }   // only redraw when it changes, so clicks aren't lost
  }
  return rowsHtml.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-pager]');
  if (!b || b.disabled) return;
  const key = b.dataset.pager;
  pages[key] = Math.max(0, (pages[key] || 0) + Number(b.dataset.dir));
  if (pagerReload[key]) pagerReload[key]();
});

// ---------- System tab ----------
// One CPU and one RAM tile, then a GPU and a VRAM tile per graphics card (built once the card list is known).
const GB = b => (b / 1073741824).toFixed(1);
let tileKey = null;
function tileHtml(t) {
  return \`
  <div class="tile" id="t-\${t.id}">
    <div class="k">\${t.label}</div>
    <div class="v">—</div>
    <div class="sub">&nbsp;</div>
    <div class="meter"><div></div></div>
    <div class="spark"><svg viewBox="0 0 100 100" preserveAspectRatio="none">
      <path class="area"></path><path class="line"></path><line class="guide" y1="0" y2="100" style="display:none"></line></svg>
      <div class="tip" hidden></div></div>
    <div class="spark-axis"><span>5 min ago</span><span>now</span></div>
  </div>\`;
}
function buildTiles(gpus) {
  const n = Math.max(1, gpus.length);
  const key = String(gpus.length) + '|' + gpus.map(g => g.id).join(',');
  if (key === tileKey) return;
  tileKey = key;
  const groups = [[{ id:'cpu', label:'CPU' }, { id:'ram', label:'RAM' }]];
  for (let i = 0; i < n; i++) {
    const num = gpus.length > 1 ? ' ' + (i + 1) : '';
    groups.push([{ id:'gpu' + i, label:'GPU' + num }, { id:'vram' + i, label:'VRAM' + num }]);
  }
  document.getElementById('tiles').innerHTML = groups.map(g => '<div class="tgroup">' + g.map(tileHtml).join('') + '</div>').join('');
}
buildTiles([]);

let sysHist = [];
function tileValues(s) {
  const pct = (u, t) => (u != null && t) ? 100 * u / t : null;
  const v = { cpu: s.cpu, ram: pct(s.ramUsed, s.ramTotal) };
  // Older samples (or no per-card data): fall back to the whole-PC numbers for the first card.
  const cards = s.gpus && s.gpus.length ? s.gpus : [{ util: s.gpu, vramUsed: s.vramUsed, vramTotal: s.vramTotal }];
  cards.forEach((g, i) => { v['gpu' + i] = g.util; v['vram' + i] = pct(g.vramUsed, g.vramTotal); });
  return v;
}
function setTile(id, value, big, sub, series) {
  const el = document.getElementById('t-' + id);
  if (!el) return;
  el.querySelector('.v').innerHTML = big;
  el.querySelector('.sub').textContent = sub;
  el.querySelector('.sub').title = sub;
  el.querySelector('.meter > div').style.width = (value == null ? 0 : Math.max(0, Math.min(100, value))) + '%';
  const pts = series.map((v, i) => v == null ? null : [series.length < 2 ? 100 : 100 * i / (series.length - 1), 100 - Math.max(0, Math.min(100, v))]);
  const valid = pts.filter(Boolean);
  const d = valid.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' ');
  el.querySelector('.line').setAttribute('d', d);
  el.querySelector('.area').setAttribute('d', valid.length ? d + \` L\${valid[valid.length-1][0]} 100 L\${valid[0][0]} 100 Z\` : '');
}

async function loadSystem() {
  try {
    const data = await (await fetch('/api/system', { cache:'no-store' })).json();
    sysHist = data.history;
    const s = sysHist[sysHist.length - 1];
    const info = data.info;
    const gpus = info.gpus || [];
    buildTiles(gpus);
    document.getElementById('sysMeta').textContent = s ? 'updated ' + new Date(s.t).toLocaleTimeString() + ' · every 2 s' : 'warming up…';
    if (!s) return;
    const series = id => sysHist.map(h => tileValues(h)[id]);
    const v = tileValues(s);
    const na = '<span class="na">n/a</span>';
    setTile('cpu', v.cpu, v.cpu.toFixed(0) + '<small>%</small>', info.cpuModel + ' · ' + info.cores + ' threads', series('cpu'));
    setTile('ram', v.ram, GB(s.ramUsed) + '<small> / ' + GB(s.ramTotal) + ' GB</small>', v.ram.toFixed(0) + '% used', series('ram'));
    const n = Math.max(1, gpus.length);
    for (let i = 0; i < n; i++) {
      const g = (s.gpus && s.gpus[i]) || (i === 0 ? { util: s.gpu, vramUsed: s.vramUsed, vramTotal: s.vramTotal } : {});
      const name = gpus[i] ? gpus[i].name : (info.gpuSource === 'none' ? 'No GPU stats available' : 'detecting…');
      const util = v['gpu' + i], vram = v['vram' + i];
      setTile('gpu' + i, util, util != null ? util.toFixed(0) + '<small>%</small>' : na, name, series('gpu' + i));
      let vramBig = na, vramSub = name;
      if (g.vramUsed != null) {
        vramBig = GB(g.vramUsed) + (g.vramTotal ? '<small> / ' + GB(g.vramTotal) + ' GB</small>' : '<small> GB</small>');
        vramSub = (vram != null ? vram.toFixed(0) + '% used' : 'total unknown') + (gpus.length > 1 ? ' · ' + name : '');
      }
      setTile('vram' + i, vram, vramBig, vramSub, series('vram' + i));
    }
  } catch (e) {
    document.getElementById('sysMeta').textContent = 'Could not reach server: ' + e.message;
  }
}

// ---- "System load" row on the Current request / Current job cards ----
// Whole-computer totals from the latest SYSTEM sample (all apps together, not this request alone).
// Shown only while something is running.
function setSysLoad(id, on) {
  const el = document.getElementById(id);
  if (!el) return;
  const s = on ? sysHist[sysHist.length - 1] : null;
  el.hidden = !s;
  if (!s) return;
  const pct = (u, t) => (u != null && t) ? 100 * u / t : null;
  const item = (k, p, txt) => '<span class="sl-item"><span class="sl-k">' + k + '</span><span class="sl-meter"><div style="width:' +
    (p == null ? 0 : Math.max(0, Math.min(100, p))) + '%"></div></span><span class="sl-v">' + txt + '</span></span>';
  // Two rows, one column per card (+ one for the CPU): usage % on top, memory below.
  const top = [], mem = [];
  const blank = '<span></span>';
  const cards = s.gpus && s.gpus.length ? s.gpus : (s.gpu != null ? [{ util: s.gpu, vramUsed: s.vramUsed, vramTotal: s.vramTotal }] : []);
  cards.forEach((g, i) => {
    const n = cards.length > 1 ? ' ' + (i + 1) : '';
    top.push(g.util != null ? item('GPU' + n, g.util, g.util.toFixed(0) + '%') : blank);
    mem.push(g.vramUsed != null ? item('VRAM' + n, pct(g.vramUsed, g.vramTotal), GB(g.vramUsed) + (g.vramTotal ? ' / ' + GB(g.vramTotal) : '') + ' GB') : blank);
  });
  top.push(s.cpu != null ? item('CPU', s.cpu, s.cpu.toFixed(0) + '%') : blank);
  mem.push(item('MEM', pct(s.ramUsed, s.ramTotal), GB(s.ramUsed) + ' / ' + GB(s.ramTotal) + ' GB'));
  const html = top.concat(mem).join('');
  const box = el.querySelector('.sl-items');
  if (box._html !== html) { box._html = html; box.innerHTML = html; box.style.gridTemplateColumns = 'repeat(' + top.length + ', max-content)'; }
}
// "Peak load" cell in the history tables: highest whole-PC GPU % and VRAM while it ran; details on hover.
function peakCell(p) {
  if (!p) return '<td class="na" title="No peak recorded (AI_SCOPE was not sampling while this ran, or it ran before v0.2)">—</td>';
  const parts = [];
  if (p.gpu != null) parts.push('GPU ' + p.gpu + '%');
  if (p.vramUsed != null) parts.push('VRAM ' + GB(p.vramUsed) + (p.vramTotal ? ' / ' + GB(p.vramTotal) : '') + ' GB');
  if (p.cpu != null) parts.push('CPU ' + p.cpu + '%');
  if (p.ramUsed != null) parts.push('RAM ' + GB(p.ramUsed) + (p.ramTotal ? ' / ' + GB(p.ramTotal) : '') + ' GB');
  const tip = 'Peak system load while this ran (whole computer, all apps): ' + parts.join(' · ') + (p.partial ? ' (last 5 minutes only)' : '');
  const short = [p.gpu != null ? p.gpu + '%' : null, p.vramUsed != null ? GB(p.vramUsed) + ' GB' : null].filter(Boolean).join(' · ') || '—';
  return '<td class="peak" title="' + tip + '">' + short + '</td>';
}

// Hover on a sparkline: show the value at that point in time.
document.getElementById('tiles').addEventListener('mousemove', e => {
  const spark = e.target.closest('.spark'); if (!spark || !sysHist.length) return;
  const id = spark.closest('.tile').id.slice(2);
  const r = spark.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  const i = Math.round(f * (sysHist.length - 1));
  const h = sysHist[i], v = tileValues(h)[id];
  const tip = spark.querySelector('.tip'), guide = spark.querySelector('.guide');
  const x = sysHist.length < 2 ? 100 : 100 * i / (sysHist.length - 1);
  guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.style.display = '';
  tip.hidden = false; tip.style.left = x + '%';
  tip.textContent = (v == null ? 'n/a' : v.toFixed(0) + '%') + ' · ' + new Date(h.t).toLocaleTimeString();
});
document.getElementById('tiles').addEventListener('mouseleave', () => {
  document.querySelectorAll('.spark .tip').forEach(t => t.hidden = true);
  document.querySelectorAll('.spark .guide').forEach(g => g.style.display = 'none');
}, true);
document.getElementById('tiles').addEventListener('mouseout', e => {
  const spark = e.target.closest('.spark');
  if (spark && !spark.contains(e.relatedTarget)) { spark.querySelector('.tip').hidden = true; spark.querySelector('.guide').style.display = 'none'; }
});
loadSystem();
setInterval(loadSystem, 2000);

// ---------- ComfyUI tab ----------
function fmtDur(ms) {
  if (ms == null) return '—';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + ' s';
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  if (m < 60) return m + 'm ' + (r < 10 ? '0' : '') + r + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
function fmtWhen(ms) {
  if (!ms) return '—';
  const d = new Date(ms), today = new Date().toDateString() === d.toDateString();
  return (today ? '' : d.toLocaleDateString() + ' ') + d.toLocaleTimeString();
}
const escH = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function imgUrl(im, full) {
  return '/api/comfy/view?filename=' + encodeURIComponent(im.filename) + '&subfolder=' + encodeURIComponent(im.subfolder) +
         '&type=' + encodeURIComponent(im.type) + (full ? '&full=1' : '');
}
let cSeen = new Set(), cFirst = true;
async function loadComfy() {
  if (!isInstalled('comfyui')) return;
  const $ = id => document.getElementById(id);
  let d;
  try { d = await (await fetch('/api/comfy?limit=100', { cache:'no-store' })).json(); }
  catch (e) { $('cMeta').textContent = 'Could not reach AI_SCOPE server: ' + e.message; return; }

  $('cMeta').textContent = (d.online ? 'connected to ' + d.url : 'ComfyUI offline') + ' · ' + d.totalRuns + ' runs saved · updates every 2 s';
  const cur = d.current;
  $('cDot').className = 'dot' + (cur ? ' live' : d.online ? '' : ' off');
  const show = (id, on) => { $(id).hidden = !on; };
  if (!d.online) {
    $('cTitle').textContent = 'ComfyUI is not running';
    $('cModel').textContent = '—';
    show('cProgBox', false); show('cRateBox', false); show('cTimeBox', false);
    $('cFoot').textContent = d.error || '';
    setSysLoad('cLoad', false);
  } else if (cur) {
    $('cTitle').textContent = 'Current job' + (d.pending ? ' (+' + d.pending + ' queued)' : '');
    $('cModel').textContent = cur.summary.models.join(' + ') || 'unknown';
    const p = cur.progress;
    show('cProgBox', true); show('cRateBox', true); show('cTimeBox', true);
    $('cProgLabel').textContent = p && p.label ? p.label : 'Steps';
    $('cProg').textContent = p ? p.value + ' / ' + p.max : 'starting…';
    $('cBar').style.width = p && p.max ? (100 * p.value / p.max) + '%' : '0';
    $('cRate').textContent = p && p.itPerSec ? (p.itPerSec >= 1 ? p.itPerSec.toFixed(2) + ' it/s' : (1 / p.itPerSec).toFixed(2) + ' s/it') + (p.remaining ? ' · ~' + p.remaining + ' left' : '') : '—';
    $('cTimeLabel').textContent = 'Elapsed';
    $('cTime').textContent = fmtDur(cur.elapsedMs);
    const sm = cur.summary;
    setSysLoad('cLoad', true);
    $('cFoot').textContent = [sm.width ? sm.width + '×' + sm.height + (sm.batch > 1 ? ' ×' + sm.batch : '') : null,
      sm.steps ? sm.steps + ' steps' : null, sm.sampler, sm.loras.length ? 'LoRA: ' + sm.loras.join(', ') : null].filter(Boolean).join(' · ') || ' ';
  } else {
    const a = d.average;
    $('cTitle').textContent = 'Idle — no workflow running' + (d.pending ? ' (' + d.pending + ' queued)' : '');
    $('cModel').textContent = a ? a.model : '—';
    show('cProgBox', false); show('cRateBox', false); show('cTimeBox', !!a);
    $('cTimeLabel').textContent = a ? 'Avg run time (last ' + a.runs + ' runs)' : 'Avg run time';
    $('cTime').textContent = a ? fmtDur(a.avgMs) : '—';
    $('cFoot').textContent = ' ';
    setSysLoad('cLoad', false);
  }

  $('cErr').hidden = d.runs.length > 0;
  $('cErr').style.color = 'var(--muted)';
  $('cErr').textContent = 'No runs recorded yet. Run a workflow in ComfyUI and it will appear here.';
  $('cRows').innerHTML = d.runs.map(r => {
    const s = r.summary, isNew = !cFirst && !cSeen.has(r.id);
    cSeen.add(r.id);
    const thumbs = r.images.slice(0, 3).map(im => '<a href="' + imgUrl(im, true) + '" target="_blank"><img loading="lazy" src="' + imgUrl(im) + '" alt=""></a>').join('') +
      (r.imageCount > 3 ? '<span class="more">+' + (r.imageCount - 3) + '</span>' : '');
    return '<tr' + (isNew ? ' class="new"' : '') + '>' +
      '<td>' + escH(fmtWhen(r.end)) + '</td>' +
      '<td class="model" title="' + escH(s.loras.length ? 'LoRA: ' + s.loras.join(', ') : '') + '">' + escH(s.models.join(' + ') || '—') + '</td>' +
      '<td>' + (s.width ? s.width + '×' + s.height + (s.batch > 1 ? ' ×' + s.batch : '') : '—') + '</td>' +
      '<td>' + (s.steps != null ? s.steps : '—') + '</td>' +
      '<td>' + escH(s.sampler || '—') + '</td>' +
      '<td class="tps">' + fmtDur(r.durationMs) + '</td>' +
      peakCell(r.peak) +
      '<td><span class="status ' + escH(r.status) + '" title="' + escH(r.error || '') + '">' + escH(r.status) + '</span></td>' +
      '<td><div class="thumbs">' + (thumbs || '<span class="more">—</span>') + '</div></td></tr>';
  }).join('');
  cFirst = false;
}
loadComfy();
setInterval(loadComfy, 2000);

// ---------- Ollama tab ----------
function fmtBytes(b) {
  if (b == null) return '—';
  return b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB';
}
// VRAM fit (installed-model tables): measured against the largest single card.
function vramWord(d) {
  return fmtBytes(d.vramTotal) + ' VRAM' + (d.vramCards > 1 ? ' (largest of ' + d.vramCards + ' GPUs)' : '');
}
function fitPill(m, fitText) {
  if (!m.fit) return ONONE;
  if (m.fit === 'multi') return '<span class="fit multi" title="Too big for one card, but fits when split across ' + m.fitGpus + ' GPUs">fits across ' + m.fitGpus + ' GPUs</span>';
  return '<span class="fit ' + m.fit + '">' + fitText[m.fit] + '</span>';
}
function fmtUntil(ms) {
  if (!ms) return '—';
  const left = ms - Date.now();
  if (left > 365 * 864e5) return 'never';
  if (left <= 0) return 'unloading…';
  return fmtDur(left);
}
const ONONE = '—';
const featTags = f => f && f.length ? f.map(x => '<span class="tag">' + escH(x) + '</span>').join('') : ONONE;
// LM Studio log timestamps are local "YYYY-MM-DD HH:MM:SS"
function lmTs(ts) {
  const m = /^(\\d+)-(\\d+)-(\\d+) (\\d+):(\\d+):(\\d+)$/.exec(ts || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}
// Text wrapped in an external link (with an "opens in new tab" icon) when a URL is known.
const EXT_ICON = '<svg class="extico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
function extLink(text, url, title) {
  return url ? '<a class="ext" href="' + escH(url) + '" target="_blank" rel="noopener" title="' + escH(title || url) + ' (opens in a new tab)">' + escH(text) + EXT_ICON + '</a>' : escH(text);
}
let oSeen = new Set(), oFirst = true;
async function loadOllama() {
  if (!isInstalled('ollama')) return;
  const $ = id => document.getElementById(id);
  let d;
  try { d = await (await fetch('/api/ollama?limit=100', { cache:'no-store' })).json(); }
  catch (e) { $('oMeta').textContent = 'Could not reach AI_SCOPE server: ' + e.message; return; }
  const px = d.proxy;
  const proxyUrl = 'http://127.0.0.1:' + px.port;
  $('oMeta').textContent = (d.online ? 'connected to ' + d.url + (d.version ? ' · v' + d.version : '') : 'Ollama offline') +
    ' · proxy ' + (px.listening ? 'on :' + px.port : 'not running' + (px.error ? ' (' + px.error + ')' : '')) +
    ' · ' + d.totalRequests + ' requests saved · updates every 2 s';

  // current request
  const cur = d.current, show = (id, on) => { $(id).hidden = !on; };
  $('oDot').className = 'dot' + (cur ? ' live' : d.online ? '' : ' off');
  if (!d.online) {
    $('oTitle').textContent = 'Ollama is not running';
    $('oModel').textContent = ONONE;
    show('oTpsBox', false); show('oTokBox', false); show('oTimeBox', false);
    $('oFoot').textContent = d.error || '';
    setSysLoad('oLoad', false);
  } else if (cur) {
    $('oTitle').textContent = 'Current request' + (cur.othersRunning ? ' (+' + cur.othersRunning + ' more running)' : '');
    $('oModel').textContent = cur.model;
    show('oTpsBox', true); show('oTokBox', true); show('oTimeBox', true);
    const labels = { loading:'Loading model', prompt:'Reading prompt', thinking:'Thinking · tok/s', gen:'Current gen tok/s' };
    $('oTpsLabel').textContent = labels[cur.phase] || 'Current gen tok/s';
    $('oTps').textContent = (cur.phase === 'gen' || cur.phase === 'thinking') && cur.liveTps != null ? fmtTps(cur.liveTps) : '…';
    $('oTok').textContent = fmtNum(cur.tokens) + (cur.thinkTokens ? ' (' + fmtNum(cur.thinkTokens) + ' thinking)' : '');
    $('oTime').textContent = fmtSec(cur.elapsedMs);
    $('oFoot').textContent = cur.endpoint + ' via AI_SCOPE proxy';
    setSysLoad('oLoad', true);
  } else {
    const a = d.average;
    $('oTitle').textContent = 'Idle — no request running';
    $('oModel').textContent = a ? a.model : ONONE;
    show('oTpsBox', !!a); show('oTokBox', false); show('oTimeBox', false);
    $('oTpsLabel').textContent = a ? 'Avg gen tok/s (last ' + a.requests + ' requests)' : 'Avg gen tok/s';
    $('oTps').textContent = a ? fmtTps(a.genTps) : ONONE;
    $('oFoot').textContent = 'Requests are recorded when apps talk to ' + proxyUrl + ' (forwards to Ollama).';
    setSysLoad('oLoad', false);
  }

  // loaded models
  $('oLoaded').innerHTML = d.loaded.map(m => {
    const g = m.gpuPct;
    const proc = g == null ? ONONE : g >= 100 ? '100% GPU' : g <= 0 ? '100% CPU' : (100 - g) + '% CPU / ' + g + '% GPU';
    const until = fmtUntil(m.expiresAt);
    return '<tr><td class="model">' + escH(m.name) + (m.quant ? '<span class="na"> · ' + escH(m.quant) + '</span>' : '') + '</td>' +
      '<td>' + escH(m.params || ONONE) + '</td>' +
      '<td title="' + fmtBytes(m.sizeVram) + ' on GPU">' + fmtBytes(m.size) + '</td>' +
      '<td>' + (m.context ? fmtNum(m.context) + (m.maxContext ? '<span class="na"> / ' + fmtNum(m.maxContext) + '</span>' : '') : ONONE) + '</td>' +
      '<td><span class="split" title="' + fmtBytes(m.sizeVram) + ' of ' + fmtBytes(m.size) + ' on GPU (green = GPU, amber = CPU)"><span class="bar"><div style="width:' + (g || 0) + '%"></div></span>' + proc + '</span></td>' +
      '<td>' + (/^\\d/.test(until) ? 'in ' + until : until) + '</td></tr>';
  }).join('');
  $('oLoadedEmpty').hidden = d.loaded.length > 0;
  $('oLoadedEmpty').textContent = d.online ? 'No model loaded. Ollama loads a model on the first request and unloads it after it has been idle (5 min by default).' : 'Ollama is offline.';
  const spill = d.loaded.some(m => m.gpuPct != null && m.gpuPct < 100);
  $('oLoadedHint').textContent = spill ? '— part of a model is running on the CPU, so generation will be slower' : '';

  // requests
  $('oReqHint').textContent = '— only requests sent through ' + proxyUrl;
  const helpHtml =
    '<p>Ollama sends token stats (speed, token counts, load time) only back to the app that made the request, so AI_SCOPE can&#39;t see them. ' +
    'AI_SCOPE runs a relay at <code>' + proxyUrl + '</code> that forwards everything to Ollama (<code>' + escH(d.url) + '</code>) and records the stats on the way. ' +
    'Apps that talk to Ollama directly still work normally; they just don&#39;t appear in this table.</p>' +
    '<ul>' +
    '<li><b>PowerShell</b>: <code>$env:OLLAMA_HOST=&quot;127.0.0.1:' + px.port + '&quot;</code> then <code>ollama run qwen3.5:4b</code> (applies to that window only)</li>' +
    '<li><b>cmd</b>: <code>set OLLAMA_HOST=127.0.0.1:' + px.port + '</code> then <code>ollama run qwen3.5:4b</code> (applies to that window only)</li>' +
    '<li><b>Mac / Linux terminal</b>: <code>export OLLAMA_HOST=127.0.0.1:' + px.port + '</code> then <code>ollama run qwen3.5:4b</code> (applies to that window only; add the line to <code>~/.zshrc</code> or <code>~/.bashrc</code> to make it permanent)</li>' +
    '<li><b>VS Code</b> (Continue, Cline, Copilot, …): in the extension&#39;s Ollama settings, change the address / API base from <code>http://localhost:11434</code> to <code>' + proxyUrl + '</code></li>' +
    '<li><b>Other apps and scripts</b>: set the Ollama URL to <code>' + proxyUrl + '</code>, or <code>' + proxyUrl + '/v1</code> for OpenAI-style clients (prompt speed and load time aren&#39;t available for those)</li>' +
    '</ul>';
  if ($('oHelp').innerHTML !== helpHtml) $('oHelp').innerHTML = helpHtml;
  $('oRowsEmpty').hidden = d.rows.length > 0;
  $('oRowsEmpty').innerHTML = px.listening
    ? 'No requests captured yet. Click <b>?</b> above to see how to send requests through AI_SCOPE.'
    : 'The AI_SCOPE proxy could not start' + (px.error ? ': ' + escH(px.error) : '') + '. Pick another relay port in the Ollama scope&#39;s <b>Settings</b>.';
  $('oRows').innerHTML = paginate('ollama', d.rows.map(r => {
    const isNew = !oFirst && !oSeen.has(r.id);
    oSeen.add(r.id);
    const approx = r.measured ? ' title="measured by the proxy (OpenAI-style endpoint)"' : '';
    const statusTag = r.status === 'ok' ? '' : '<span class="status ' + (r.status === 'aborted' ? 'interrupted' : 'error') + '" title="' + escH(r.error || '') + '">' + escH(r.status) + '</span> ';
    return '<tr' + (isNew ? ' class="new"' : '') + '>' +
      '<td>' + escH(fmtWhen(r.start)) + '</td>' +
      '<td class="model" title="' + escH(r.endpoint) + '">' + statusTag + escH(r.model) + '</td>' +
      '<td class="tps"' + approx + '>' + fmtTps(r.genTps) + '</td>' +
      '<td title="' + (r.thinkTokens ? fmtNum(r.thinkTokens) + ' of these were thinking tokens' : '') + '">' + fmtNum(r.genTokens) + '</td>' +
      '<td>' + fmtTps(r.promptTps) + '</td>' +
      '<td>' + fmtNum(r.promptTokens) + '</td>' +
      '<td>' + (r.loadMs != null ? fmtSec(r.loadMs) : ONONE) + '</td>' +
      '<td>' + fmtSec(r.ttftMs) + '</td>' +
      '<td>' + fmtSec(r.totalMs) + '</td>' + peakCell(r.peak) + '</tr>';
  }), 'oPager').join('');

  // installed models
  const vt = d.vramTotal;
  $('oInstHint').textContent = d.installed.length ? '— ' + d.installed.length + ' models · ' + fmtBytes(d.installed.reduce((a, m) => a + (m.size || 0), 0)) + ' on disk' +
    (vt ? ' · fit is weights vs ' + vramWord(d) + ' (context adds more)' : '') : '';
  const fitText = { fits:'fits', tight:'tight', spills:'partly CPU' };
  $('oInst').innerHTML = d.installed.map(m =>
    '<tr><td class="model">' + extLink(m.name, m.libraryUrl || m.modelUrl, m.libraryUrl ? 'Ollama library page' : 'Hugging Face repo') +
      (m.libraryUrl && m.modelUrl ? '<a class="tag" href="' + escH(m.modelUrl) + '" target="_blank" rel="noopener" title="Original model on Hugging Face' + (m.baseName ? ': ' + escH(m.baseName) : '') + ' (opens in a new tab)">HF' + EXT_ICON + '</a>' : '') +
      (m.loaded ? '<span class="tag">loaded</span>' : '') + '</td>' +
    '<td>' + (m.publisher ? extLink(m.publisher, m.publisherUrl, 'Publisher on Hugging Face') : ONONE) + '</td>' +
    '<td>' + escH(m.family || ONONE) + '</td><td>' + escH(m.params || ONONE) + '</td><td>' + escH(m.quant || ONONE) + '</td>' +
    '<td>' + fmtBytes(m.size) + '</td>' +
    '<td>' + featTags(m.features) + '</td>' +
    '<td>' + fitPill(m, fitText) + '</td>' +
    '<td>' + (m.maxContext ? fmtNum(m.maxContext) : ONONE) + '</td>' +
    '<td>' + (m.modified ? new Date(m.modified).toLocaleDateString() : ONONE) + '</td></tr>').join('');
  oFirst = false;
}
document.getElementById('oHelpBtn').addEventListener('click', e => {
  const box = document.getElementById('oHelp'), btn = e.currentTarget;
  box.hidden = !box.hidden;
  btn.setAttribute('aria-expanded', String(!box.hidden));
});
pagerReload.ollama = loadOllama;
loadOllama();
setInterval(loadOllama, 2000);

// ---- ComfyUI installed models ----
const CM_TYPES = { checkpoints:'Checkpoint', diffusion_models:'Diffusion model', loras:'LoRA', vae:'VAE', text_encoders:'Text encoder',
  clip_vision:'CLIP vision', controlnet:'ControlNet', upscale_models:'Upscaler', latent_upscale_models:'Latent upscaler', diffusers:'Diffusers',
  embeddings:'Embedding', ipadapter:'IP-Adapter', ip_adapter:'IP-Adapter', vae_approx:'VAE approx', style_models:'Style model' };
const cmType = f => CM_TYPES[f] || f.replace(/_/g, ' ');
let cmData = null, cmFilter = 'all';
function renderComfyModels() {
  const $ = id => document.getElementById(id);
  const d = cmData;
  if (!d) return;
  const all = d.models;
  // filter chips (redrawn only when they change, so clicks aren't lost)
  const counts = {}, order = [];
  all.forEach(m => { if (!counts[m.folder]) { counts[m.folder] = 0; order.push(m.folder); } counts[m.folder]++; });
  if (cmFilter !== 'all' && !counts[cmFilter]) cmFilter = 'all';
  const chipHtml = (all.length ? ['<button type="button" class="chip' + (cmFilter === 'all' ? ' on' : '') + '" data-cmfilter="all">All (' + all.length + ')</button>'] : [])
    .concat(order.map(f => '<button type="button" class="chip' + (cmFilter === f ? ' on' : '') + '" data-cmfilter="' + escH(f) + '">' + escH(cmType(f)) + ' (' + counts[f] + ')</button>')).join('');
  const chips = $('cmChips');
  if (chips._html !== chipHtml) { chips._html = chipHtml; chips.innerHTML = chipHtml; }

  const list = all.filter(m => cmFilter === 'all' || m.folder === cmFilter);
  const total = list.reduce((a, m) => a + (m.size || 0), 0);
  $('cmHint').textContent = all.length ? '— ' + list.length + ' files · ' + fmtBytes(total) + ' on disk' +
    (d.vramTotal ? ' · fit is file size vs ' + vramWord(d) + ' (ComfyUI can offload, so bigger models still run, slower)' : '') : '';
  $('cmEmpty').hidden = all.length > 0;
  $('cmEmpty').textContent = d.online ? 'Loading model list…' : 'ComfyUI is offline.';
  const fitText = { fits:'fits', tight:'tight', spills:'offloads' };
  const rows = list.map(m =>
    '<tr><td class="model" title="' + escH(m.file) + '">' + escH(m.name) + '</td>' +
    '<td>' + escH(m.publisher || ONONE) + '</td>' +
    '<td>' + escH(cmType(m.folder)) + '</td>' +
    '<td>' + fmtBytes(m.size) + '</td>' +
    '<td>' + fitPill(m, fitText) + '</td>' +
    '<td>' + (m.runs ? fmtNum(m.runs) : ONONE) + '</td>' +
    '<td>' + (m.lastUsed ? escH(fmtWhen(m.lastUsed)) : ONONE) + '</td>' +
    '<td>' + (m.avgMs ? fmtDur(m.avgMs) : ONONE) + '</td>' +
    '<td>' + (m.modified ? new Date(m.modified).toLocaleDateString() : ONONE) + '</td></tr>');
  $('cmRows').innerHTML = paginate('comfyModels', rows, 'cmPager').join('');
}
async function loadComfyModels() {
  if (!isInstalled('comfyui')) return;
  try { cmData = await (await fetch('/api/comfy/models', { cache:'no-store' })).json(); } catch (e) { return; }
  renderComfyModels();
}
document.getElementById('cmChips').addEventListener('click', e => {
  const b = e.target.closest('[data-cmfilter]');
  if (!b) return;
  cmFilter = b.dataset.cmfilter;
  pages.comfyModels = 0;
  renderComfyModels();
});
pagerReload.comfyModels = renderComfyModels;
loadComfyModels();
setInterval(loadComfyModels, 5000);

// ---------- Scopes & tabs ----------
// The list of scopes comes from scopes.json (see SCOPES at the top). Each installed scope = one tab +
// a <section class="panel" data-panel="id">; a scope without its own section gets a placeholder page.
function ensurePanel(sc) {
  if (document.querySelector('.panel[data-panel="' + sc.id + '"]')) return;
  const sec = document.createElement('section');
  sec.className = 'panel'; sec.dataset.panel = sc.id; sec.hidden = true;
  sec.innerHTML = '<div class="section-head"><h1>' + escH(sc.name) + '</h1></div>' +
    '<div class="wrap"><div class="card hintbox">This scope has no page yet (add a <code>&lt;section class=&quot;panel&quot; data-panel=&quot;' +
    escH(sc.id) + '&quot;&gt;</code> to server.js).</div></div>';
  document.body.insertBefore(sec, document.querySelector('script'));
}
SCOPES.forEach(ensurePanel);

const DEFAULT_SCOPE = 'lmstudio';
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
const installedIds = () => SCOPES.filter(x => x.installed).map(x => x.id);
// Which tabs are open, in what order (per browser). Default: all installed scopes.
let openTabs = store.get('aiscope.openTabs', installedIds()).filter(isInstalled);
// Drop tabs of removed scopes; scopes installed since this browser last looked (e.g. from another device) open once.
function syncOpenTabs() {
  const ids = installedIds();
  const seen = store.get('aiscope.seenScopes', null);
  if (seen) ids.filter(id => !seen.includes(id) && !openTabs.includes(id)).forEach(id => openTabs.push(id));
  openTabs = openTabs.filter(isInstalled);
  store.set('aiscope.seenScopes', ids);
  store.set('aiscope.openTabs', openTabs);
}
syncOpenTabs();

function accentColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2563eb';
}
function svgUri(svg) {
  return 'url(&quot;data:image/svg+xml,' + encodeURIComponent(svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ').replace(/currentColor/g, accentColor())) + '&quot;)';
}
// Home (landing) background: gently animated low-poly field, black -> blue.
// Fixed jittered triangle grid (no retriangulation, so nothing pops); vertices drift, a light slowly circles.
const homeAnim = (function () {
  const canvas = document.getElementById('homeBg');
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const STOPS_BY_THEME = {
    blue: [[2,4,10],[4,12,32],[8,34,84],[18,88,180],[60,160,255]],
    magenta: [[10,2,8],[30,4,24],[84,8,62],[184,24,128],[255,84,190]],
  };
  let STOPS = STOPS_BY_THEME.blue;
  let W = 0, H = 0, pts = [], tris = [], running = false;
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function mixStops(t) {
    t = Math.max(0, Math.min(1, t)) * (STOPS.length - 1);
    const i = Math.min(STOPS.length - 2, Math.floor(t)), f = t - i, a = STOPS[i], b = STOPS[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  function build() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const S = Math.max(70, Math.min(130, Math.sqrt(W * H) / 9)), rh = S * 0.866;
    const rows = Math.ceil(H / rh) + 3, cols = Math.ceil(W / S) + 3;
    pts = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      pts.push({
        bx: (c - 1) * S + (r % 2 ? S / 2 : 0) + rnd(-.22, .22) * S, by: (r - 1) * rh + rnd(-.22, .22) * S,
        ax: rnd(.08, .2) * S, ay: rnd(.08, .2) * S, sx: rnd(.00012, .00028), sy: rnd(.00012, .00028),
        px: rnd(0, 6.283), py: rnd(0, 6.283), zs: rnd(.0002, .0004), zp: rnd(0, 6.283), za: rnd(.25, .55) * S,
        x: 0, y: 0, z: 0
      });
    }
    const id = (r, c) => r * cols + c;
    tris = [];
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
      if (r % 2 === 0) { tris.push([id(r, c), id(r, c + 1), id(r + 1, c)]); tris.push([id(r, c + 1), id(r + 1, c), id(r + 1, c + 1)]); }
      else { tris.push([id(r, c), id(r + 1, c), id(r + 1, c + 1)]); tris.push([id(r, c), id(r, c + 1), id(r + 1, c + 1)]); }
    }
    tris = tris.map(t => ({ v: t, j: rnd(-.07, .07) }));
  }
  function draw(now) {
    if (!pts.length) return;
    for (const p of pts) {
      p.x = p.bx + Math.sin(now * p.sx + p.px) * p.ax;
      p.y = p.by + Math.cos(now * p.sy + p.py) * p.ay;
      p.z = Math.sin(now * p.zs + p.zp) * p.za;
    }
    const la = now * 0.00006;
    let lx = Math.cos(la) * .45, ly = -.55 + Math.sin(la) * .2, lz = .7;
    const ll = Math.hypot(lx, ly, lz); lx /= ll; ly /= ll; lz /= ll;
    const diag = W + H;
    ctx.fillStyle = 'rgb(' + STOPS[0].join(',') + ')'; ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = 1;
    for (const t of tris) {
      const a = pts[t.v[0]], b = pts[t.v[1]], c = pts[t.v[2]];
      const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const lit = (nx * lx + ny * ly + nz * lz) / (Math.hypot(nx, ny, nz) || 1);
      const g = ((a.x + b.x + c.x) / 3 + (H - (a.y + b.y + c.y) / 3)) / diag;
      const col = mixStops(Math.pow(Math.max(0, g), 1.35) + t.j), k = .35 + lit * .95;
      const fill = 'rgb(' + (col[0] * k | 0) + ',' + (col[1] * k | 0) + ',' + (col[2] * k | 0) + ')';
      ctx.fillStyle = fill; ctx.strokeStyle = fill;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath();
      ctx.fill(); ctx.stroke();
    }
  }
  function loop(now) {
    if (!running) return;
    draw(now);
    if (!reduce && !document.hidden) requestAnimationFrame(loop);
  }
  function start() {
    if (running) return;
    running = true;
    if (canvas.clientWidth !== W || canvas.clientHeight !== H || !pts.length) build();
    requestAnimationFrame(loop);
  }
  function stop() { running = false; }
  window.addEventListener('resize', () => { if (running) { build(); if (reduce) draw(performance.now()); } });
  document.addEventListener('visibilitychange', () => { if (running && !document.hidden && !reduce) requestAnimationFrame(loop); });
  function setPalette(name) {
    STOPS = STOPS_BY_THEME[name] || STOPS_BY_THEME.blue;
    if (running && reduce) draw(performance.now());
  }
  return { start, stop, setPalette };
})();

// Theme picker (top-right). Saved per browser; 'default' follows the OS light/dark setting.
const THEMES = { default: 'Default', dark: 'Dark', magenta: 'Magenta' };
function applyTheme(t) {
  if (!THEMES[t]) t = 'default';
  if (t === 'default') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  store.set('aiscope.theme', t);
  document.getElementById('themeName').textContent = THEMES[t];
  document.querySelectorAll('[data-theme-opt]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.themeOpt === t)));
  homeAnim.setPalette(t === 'magenta' ? 'magenta' : 'blue');
}
(function () {
  const btn = document.getElementById('themeBtn'), menu = document.getElementById('themeMenu');
  function setOpen(open) { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); }
  btn.addEventListener('click', e => { e.stopPropagation(); setOpen(menu.hidden); });
  menu.addEventListener('click', e => {
    const b = e.target.closest('[data-theme-opt]'); if (!b) return;
    applyTheme(b.dataset.themeOpt); renderTabs(); setOpen(false); btn.focus();
  });
  document.addEventListener('click', e => { if (!menu.hidden && !e.target.closest('.themewrap')) setOpen(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { setOpen(false); btn.focus(); } });
  // Default theme follows the OS; re-tint the SYSTEM tab icon when the OS switches.
  if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderTabs());
  applyTheme(store.get('aiscope.theme', 'default'));
})();

function renderTabs() {
  document.getElementById('tabs').innerHTML = openTabs.map(id => {
    const sc = scopeById(id);
    if (!sc) return '';
    // app logo, or the scope's own SVG icon (accent colored) when the app has none
    const bg = LOGO_OK[id] ? 'url(/api/logo/' + id + ')' : sc.icon ? svgUri(sc.icon) : '';
    const logo = bg ? ' has-logo" style="--logo:' + bg : '';
    return '<a class="tab" href="#' + id + '" data-tab="' + id + '" draggable="true" title="Drag to reorder"><span class="tname' + logo + '">' + escH(sc.name) + '</span>' +
           '<span class="x" data-close="' + id + '" title="Close tab">&times;</span></a>';
  }).join('');
  showTab();
}

function showTab() {
  let want = location.hash.slice(1);
  if (!want) {   // plain http://localhost:<port>/ (no hash) lands on Home, like the launchers
    want = 'home';
    history.replaceState(null, '', '#home');
  }
  const gallery = want === 'scopes';
  const home = want === 'home';
  const name = gallery ? 'scopes' : home ? 'home'
    : openTabs.includes(want) ? want : (openTabs.includes(DEFAULT_SCOPE) ? DEFAULT_SCOPE : openTabs[0]);
  if (gallery) renderGallery();
  document.getElementById('addBtn').classList.toggle('active', gallery);
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => { p.hidden = p.dataset.panel !== name; });
  document.getElementById('noTabs').hidden = gallery || home || openTabs.length > 0;
  // "Open dashboard" goes to the first open tab (or the Scopes gallery when none are open)
  document.getElementById('homeGo').setAttribute('href', '#' + (openTabs[0] || 'scopes'));
  if (home) homeAnim.start(); else homeAnim.stop();
}

function openScope(id) {
  if (!isInstalled(id)) return openInstall(id);
  if (!openTabs.includes(id)) {
    openTabs.push(id);   // new tabs go on the right; the order is whatever the user dragged it to
    store.set('aiscope.openTabs', openTabs);
    renderTabs();
  }
  if (location.hash.slice(1) !== id) location.hash = id; else showTab();
}

function closeTab(id) {
  const i = openTabs.indexOf(id);
  if (i < 0) return;
  const wasActive = document.querySelector('.tab.active') && document.querySelector('.tab.active').dataset.tab === id;
  openTabs.splice(i, 1);
  store.set('aiscope.openTabs', openTabs);
  renderTabs();
  if (wasActive && openTabs.length) location.hash = openTabs[Math.max(0, i - 1)];
}

// Drag tabs to reorder them; the order is saved per browser with the open tabs.
(function () {
  const bar = document.getElementById('tabs');
  let dragEl = null;
  bar.addEventListener('dragstart', e => {
    const t = e.target.closest('.tab');
    if (!t) return;
    dragEl = t;
    t.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', t.dataset.tab); } catch (err) {}
  });
  bar.addEventListener('dragover', e => {
    if (!dragEl) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const over = e.target.closest('.tab');
    if (!over || over === dragEl) return;
    const r = over.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    bar.insertBefore(dragEl, after ? over.nextSibling : over);
  });
  bar.addEventListener('drop', e => { if (dragEl) e.preventDefault(); });
  bar.addEventListener('dragend', () => {
    if (!dragEl) return;
    dragEl.classList.remove('dragging');
    dragEl = null;
    const order = [...bar.querySelectorAll('.tab')].map(t => t.dataset.tab);
    if (order.join() !== openTabs.join()) { openTabs = order; store.set('aiscope.openTabs', openTabs); }
  });
})();

document.getElementById('tabs').addEventListener('click', e => {
  const x = e.target.closest('[data-close]');
  if (x) { e.preventDefault(); e.stopPropagation(); closeTab(x.dataset.close); }
});

// ---- Scopes gallery (the "+" view): install / remove ----
function scopeIcon(sc, cls) {
  return (sc.logo && LOGO_OK[sc.id]) ? '<div class="' + cls + ' logo"><img src="/api/logo/' + sc.id + '" alt=""></div>'
                                     : '<div class="' + cls + '">' + (sc.icon || '') + '</div>';
}
function renderGallery() {
  const html = SCOPES.map(sc => {
    let foot;
    if (sc.builtin) foot = '<span class="badge builtin">Built in</span>';
    else if (sc.installed) foot = '<span class="badge">Installed</span><div class="row"><button class="removebtn" data-remove="' + sc.id + '">Remove</button>' +
      (sc.settings.length ? '<button class="linkbtn" data-settings="' + sc.id + '">Settings</button>' : '') + '</div>';
    else foot = '<button class="installbtn" data-install="' + sc.id + '">Install</button>';
    if (sc.error) foot = '<span class="scerr" title="' + escH(sc.error) + '">Failed to start: ' + escH(sc.error) + '</span>' + foot;
    return '<div class="square' + (sc.installed ? '' : ' off') + '" data-scope="' + sc.id + '" title="' + (sc.installed ? 'Open ' : 'Install ') + escH(sc.name) + '">' +
      scopeIcon(sc, 'icon') +
      '<div class="name">' + escH(sc.name) + '</div>' +
      '<div class="desc" title="' + escH(sc.desc) + '">' + escH(sc.desc) + '</div>' +
      '<div class="foot">' + foot + '</div></div>';
  }).join('');
  const g = document.getElementById('gallery');
  if (g._html !== html) { g._html = html; g.innerHTML = html; }   // only redraw when it changes, so clicks aren't lost
}
document.getElementById('gallery').addEventListener('click', e => {
  const b = e.target.closest('[data-install],[data-remove],[data-settings]');
  if (b) {
    e.stopPropagation();
    if (b.dataset.install) openInstall(b.dataset.install);
    else if (b.dataset.remove) openRemove(b.dataset.remove);
    else openInstall(b.dataset.settings, true);
    return;
  }
  const sq = e.target.closest('[data-scope]');
  if (sq) openScope(sq.dataset.scope);
});

// New scope list from the server (after install/remove, or changed from another browser).
function applyScopes(list) {
  SCOPES = list;
  SCOPES.forEach(ensurePanel);
  syncOpenTabs();
  renderTabs();
}
setInterval(async () => {
  if (dlg.open) return;
  try {
    const list = await (await fetch('/api/scopes', { cache: 'no-store' })).json();
    if (JSON.stringify(list) !== JSON.stringify(SCOPES)) applyScopes(list);
  } catch (e) {}
}, 5000);

// Install / settings / remove dialog
const dlg = document.getElementById('scopeDlg');
const dlgForm = document.getElementById('scopeForm');
let dlgSubmit = null;
dlgForm.addEventListener('submit', e => { e.preventDefault(); if (dlgSubmit) dlgSubmit(); });
dlgForm.addEventListener('click', e => { if (e.target.closest('[data-cancel]')) dlg.close(); });
function dlgTitle(sc, text) {
  const ic = (sc.logo && LOGO_OK[sc.id]) ? '<img src="/api/logo/' + sc.id + '" alt="">' : (sc.icon || '');
  return '<h2>' + ic + '<span>' + escH(text) + '</span></h2>';
}
function dlgBusy(btnText) {
  const b = dlgForm.querySelector('[type=submit]');
  b.disabled = true; b.textContent = btnText;
}
async function postScope(action, body) {
  const r = await fetch('/api/scopes/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
function fieldHtml(f, edit) {
  const v = edit ? f.value : f.default;
  return '<div class="field"><label for="sf-' + f.key + '">' + escH(f.label) + (f.required ? '' : ' <span class="opt">(optional)</span>') + '</label>' +
    '<input id="sf-' + f.key + '" name="' + f.key + '" data-type="' + f.type + '" type="' + (f.type === 'number' ? 'number' : 'text') + '"' +
    ' value="' + escH(v == null ? '' : v) + '" placeholder="' + escH(f.placeholder) + '" spellcheck="false" autocomplete="off"' +
    (f.min != null ? ' min="' + f.min + '"' : '') + (f.max != null ? ' max="' + f.max + '"' : '') + '>' +
    (f.help ? '<div class="help">' + escH(f.help) + '</div>' : '') +
    '<div class="ferr" data-err="' + f.key + '" hidden></div></div>';
}
function openInstall(id, edit) {
  const sc = scopeById(id);
  if (!sc || sc.builtin) return;
  const fields = sc.settings || [];
  dlgForm.innerHTML = dlgTitle(sc, edit ? sc.name + ' settings' : 'Install ' + sc.name) +
    '<p class="lead">' + (edit ? 'Saving restarts this scope with the new settings.'
      : fields.length ? 'Check these settings, then install. A ' + escH(sc.name) + ' tab is added when it&#39;s done.' : 'Adds a ' + escH(sc.name) + ' tab.') + '</p>' +
    fields.map(f => fieldHtml(f, edit)).join('') +
    '<div class="formerr" hidden></div>' +
    '<div class="actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn primary">' + (edit ? 'Save' : 'Install') + '</button></div>';
  dlgSubmit = async () => {
    const settings = {};
    dlgForm.querySelectorAll('input[name]').forEach(i => { settings[i.name] = i.value; });
    dlgForm.querySelectorAll('.ferr, .formerr').forEach(x => { x.hidden = true; });
    dlgForm.querySelectorAll('input').forEach(i => i.classList.remove('bad'));
    dlgBusy(edit ? 'Saving…' : 'Installing…');
    let r;
    try { r = await postScope('install', { id: id, settings: settings }); }
    catch (e) { r = { ok: false, error: 'Could not reach AI_SCOPE: ' + e.message }; }
    if (r.ok) {
      dlg.close();
      applyScopes(r.scopes);
      if (!edit) openScope(id);   // add the tab and switch to it
      return;
    }
    const b = dlgForm.querySelector('[type=submit]');
    b.disabled = false; b.textContent = edit ? 'Save' : 'Install';
    Object.keys(r.errors || {}).forEach(k => {
      const el = dlgForm.querySelector('[data-err="' + k + '"]'), inp = dlgForm.querySelector('[name="' + k + '"]');
      if (el) { el.textContent = r.errors[k]; el.hidden = false; }
      if (inp) inp.classList.add('bad');
    });
    if (r.error) { const fe = dlgForm.querySelector('.formerr'); fe.textContent = r.error; fe.hidden = false; }
  };
  dlg.showModal();
  const first = dlgForm.querySelector('input');
  if (first) first.focus(); else dlgForm.querySelector('[type=submit]').focus();
}
function openRemove(id) {
  const sc = scopeById(id);
  if (!sc || sc.builtin) return;
  dlgForm.innerHTML = dlgTitle(sc, 'Remove ' + sc.name + '?') +
    '<p class="lead">Its tab closes and AI_SCOPE stops collecting data for it. Saved history is kept, so it&#39;s still there if you install it again.</p>' +
    '<div class="formerr" hidden></div>' +
    '<div class="actions"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn danger">Remove</button></div>';
  dlgSubmit = async () => {
    dlgBusy('Removing…');
    let r;
    try { r = await postScope('remove', { id: id }); }
    catch (e) { r = { ok: false, error: 'Could not reach AI_SCOPE: ' + e.message }; }
    if (r.ok) { dlg.close(); applyScopes(r.scopes); return; }
    const b = dlgForm.querySelector('[type=submit]');
    b.disabled = false; b.textContent = 'Remove';
    const fe = dlgForm.querySelector('.formerr'); fe.textContent = r.error || 'Failed'; fe.hidden = false;
  };
  dlg.showModal();
  dlgForm.querySelector('[data-cancel]').focus();
}

// App logos (read by the server from each app's install folder). Tabs/cards switch to them once they load.
const LOGO_OK = {};
SCOPES.filter(sc => sc.logo).forEach(sc => {
  const img = new Image();
  img.onload = () => { LOGO_OK[sc.id] = true; renderTabs(); };
  img.src = '/api/logo/' + sc.id;
});

window.addEventListener('hashchange', showTab);
renderTabs();

const fmtSec = ms => ms == null ? '—' : (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s';
const fmtNum = n => n == null ? '—' : n.toLocaleString();
const fmtTps = n => n == null ? '—' : n.toFixed(1);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let seen = new Set(), first = true;

async function load() {
  if (!isInstalled('lmstudio')) return;
  try {
    const data = await (await fetch('/api/requests?limit=100', { cache: 'no-store' })).json();
    const err = document.getElementById('err');
    err.hidden = !data.error; err.textContent = data.error || '';
    const rows = data.rows.map(r => {
      const key = r.timestamp + '|' + r.task;
      const isNew = !first && !seen.has(key);
      seen.add(key);
      return '<tr' + (isNew ? ' class="new"' : '') + '>' +
        '<td title="' + esc(r.timestamp || '') + '">' + esc(lmTs(r.timestamp) ? fmtWhen(lmTs(r.timestamp)) : (r.timestamp || '—')) + '</td>' +
        '<td class="model">' + esc(r.model) + '</td>' +
        '<td class="tps">' + fmtTps(r.genTps) + '</td>' +
        '<td>' + fmtNum(r.genTokens) + '</td>' +
        '<td>' + fmtTps(r.promptTps) + '</td>' +
        '<td>' + fmtNum(r.promptTokens) + '</td>' +
        '<td>' + fmtSec(r.promptMs) + '</td>' +
        '<td>' + fmtSec(r.totalMs) + '</td>' + peakCell(r.peak) + '</tr>';
    });
    document.getElementById('rows').innerHTML = paginate('lmstudio', rows, 'lPager').join('');
    document.getElementById('meta').textContent =
      (lmApi ? (lmApi.online ? 'connected to ' + lmApi.url + ' (API ' + lmApi.apiVersion + ')' : 'LM Studio server offline') + ' · ' : '') +
      data.rows.length + ' latest requests · updated ' + new Date().toLocaleTimeString() + ' · updates every 2 s';
    renderCurrent(data.current, data.average);
    first = false;
  } catch (e) {
    document.getElementById('meta').textContent = 'Could not reach server: ' + e.message;
  }
}
function renderCurrent(cur, avg) {
  const $ = id => document.getElementById(id);
  $('nowDot').className = 'dot' + (cur ? ' live' : '');
  if (cur) {
    $('nowTitle').textContent = 'Current request' + (cur.othersRunning ? ' (+' + cur.othersRunning + ' more running)' : '');
    $('nowModel').textContent = cur.model;
    if (cur.phase === 'gen' && cur.genTps != null) {
      $('nowTpsLabel').textContent = 'Current gen tok/s';
      $('nowTps').textContent = fmtTps(cur.genTps);
    } else {
      const reading = cur.phase === 'prompt' && cur.progress < 1;
      $('nowTpsLabel').textContent = reading ? 'Reading prompt' : 'Current gen tok/s';
      $('nowTps').textContent = reading ? Math.round(cur.progress * 100) + '%' : 'starting…';
    }
    $('nowTimeBox').hidden = false;
    $('nowTime').textContent = fmtSec(cur.elapsedMs);
    $('nowTokBox').hidden = !(cur.phase === 'gen' && cur.genTokens);
    $('nowTok').textContent = fmtNum(cur.genTokens);
    setSysLoad('nowLoad', true);
  } else {
    $('nowTitle').textContent = 'Idle — no request running';
    $('nowModel').textContent = avg ? avg.model : '—';
    $('nowTpsLabel').textContent = avg ? 'Avg gen tok/s (last ' + avg.requests + ' requests)' : 'Avg gen tok/s';
    $('nowTps').textContent = avg ? fmtTps(avg.genTps) : '—';
    $('nowTimeBox').hidden = true;
    $('nowTokBox').hidden = true;
    setSysLoad('nowLoad', false);
  }
}

// ---- LM Studio models (REST API) ----
let lmApi = null;
async function loadLmModels() {
  if (!isInstalled('lmstudio')) return;
  const $ = id => document.getElementById(id);
  let d;
  try { d = await (await fetch('/api/lmstudio/models', { cache:'no-store' })).json(); } catch (e) { return; }
  lmApi = d;
  const onOff = v => v == null ? ONONE : v ? 'on' : 'off';
  $('lLoaded').innerHTML = d.loaded.map(m => {
    return '<tr><td class="model">' + extLink(m.id, m.modelUrl) + (m.quant ? '<span class="na"> · ' + escH(m.quant) + '</span>' : '') + '</td>' +
      '<td>' + escH(m.params || ONONE) + '</td>' +
      '<td>' + fmtBytes(m.size) + '</td>' +
      '<td>' + (m.context ? fmtNum(m.context) + (m.maxContext ? '<span class="na"> / ' + fmtNum(m.maxContext) + '</span>' : '') : ONONE) + '</td>' +
      '<td>' + onOff(m.flashAttention) + '</td>' +
      '<td>' + (m.kvOnGpu == null ? ONONE : m.kvOnGpu ? 'GPU' : 'CPU') + '</td>' +
      '<td>' + (m.parallel != null ? m.parallel : ONONE) + '</td>' +
      '<td>' + (m.ttlMs ? fmtDur(m.ttlMs) + ' idle' : 'off') + '</td></tr>';
  }).join('');
  $('lLoadedEmpty').hidden = d.loaded.length > 0;
  $('lLoadedEmpty').textContent = d.online ? 'No model loaded. Load one in LM Studio, or it loads on the first request (JIT loading).'
    : 'LM Studio server is not reachable' + (d.error ? ' (' + d.error + ')' : '') + '. Start the server in LM Studio (Developer tab) to see models.';
  const vt = d.vramTotal;
  const big = vt ? d.loaded.filter(m => m.size && m.size > vt) : [];
  $('lLoadedHint').textContent = big.length ? (d.vramCards > 1 ? '— larger than one card (' + fmtBytes(vt) + ' VRAM), so it is split across GPUs or partly in system RAM' : '— larger than ' + fmtBytes(vt) + ' VRAM, so part of it runs from system RAM') : (d.loaded.length ? '— LM Studio does not report GPU offload; compare VRAM on the SYSTEM tab' : '');

  const fitText = { fits:'fits', tight:'tight', spills:'partly CPU' };
  $('lInst').innerHTML = d.installed.map(m => {
    const feats = [m.vision ? 'vision' : null, m.tools ? 'tools' : null, m.reasoning ? 'reasoning' : null,
                   m.type && m.type.indexOf('embed') === 0 ? 'embedding' : null].filter(Boolean);
    return '<tr><td class="model">' + extLink(m.name, m.modelUrl, (m.source ? m.source + ': ' : '') + (m.modelUrl || m.key)) + (m.loaded ? '<span class="tag">loaded</span>' : '') + '</td>' +
      '<td>' + (m.publisher ? extLink(m.publisher, m.publisherUrl, 'Publisher on Hugging Face') : ONONE) + '</td><td>' + escH(m.arch || ONONE) + '</td><td>' + escH(m.params || ONONE) + '</td>' +
      '<td>' + escH(m.quant || ONONE) + '</td><td>' + fmtBytes(m.size) + '</td>' +
      '<td>' + featTags(feats) + '</td>' +
      '<td>' + fitPill(m, fitText) + '</td>' +
      '<td>' + (m.maxContext ? fmtNum(m.maxContext) : ONONE) + '</td>' +
      '<td>' + (m.modified ? new Date(m.modified).toLocaleDateString() : ONONE) + '</td></tr>';
  }).join('');
  $('lInstEmpty').hidden = d.installed.length > 0;
  $('lInstEmpty').textContent = d.online ? 'No models found.' : 'LM Studio server is not reachable.';
  $('lInstHint').textContent = d.installed.length ? '— ' + d.installed.length + ' models · ' + fmtBytes(d.installed.reduce((a, m) => a + (m.size || 0), 0)) + ' on disk' +
    (vt ? ' · fit is weights vs ' + vramWord(d) + ' (context adds more)' : '') : '';
}
loadLmModels();
setInterval(loadLmModels, 2000);

pagerReload.lmstudio = load;
load();
setInterval(load, 2000);

// Dev auto-reload: when the server restarts after a code change, refresh the page.
let boot;
setInterval(async () => {
  try {
    const id = await (await fetch('/__boot', { cache: 'no-store' })).text();
    if (boot && id !== boot) location.reload();
    boot = id;
  } catch (e) {}
}, 1000);
</script>
</body>
</html>`;

// Which scope each data endpoint belongs to: endpoints of scopes that aren't installed answer 404.
// Peak whole-PC load per LM Studio request. Its log rows are re-read on every poll, so peaks are cached
// in memory by row. The log timestamp is written when the request finishes (1 s resolution).
const lmPeaks = new Map();
function lmPeak(r) {
  const key = r.timestamp + '|' + r.task;
  if (lmPeaks.has(key)) return lmPeaks.get(key);
  const end = lmstats.tsToMs(r.timestamp);
  if (end == null || r.totalMs == null) return null;
  const oldest = sysstats.oldestSample();
  if (Date.now() - end < 4000) return null;          // let the samples after the end come in first
  const p = sysstats.peakBetween(end - r.totalMs - 1000, end + 2000);
  if (p || oldest == null || end < oldest) {          // final: found, or too old to ever find
    lmPeaks.set(key, p);
    if (lmPeaks.size > 5000) lmPeaks.delete(lmPeaks.keys().next().value);
  }
  return p;
}
const SCOPE_ROUTES = [['/api/requests', 'lmstudio'], ['/api/lmstudio/', 'lmstudio'], ['/api/comfy', 'comfyui'], ['/api/ollama', 'ollama']];
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readJson(req, cb) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', d => { body += d; if (body.length > 65536) req.destroy(); });
  req.on('end', () => { let v = null; try { v = JSON.parse(body || '{}'); } catch (e) {} cb(v); });
}
// Scope list goes into the page itself so the first render already shows the right tabs.
function pageHtml() {
  return html.split('/*__SCOPES__*/[]').join(JSON.stringify(scopes.list()).replace(/</g, '\\u003c'));
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__boot') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return res.end(BOOT_ID);
  }
  if (url.pathname === '/home') { res.writeHead(302, { Location: '/#home' }); return res.end(); }
  if (url.pathname === '/api/scopes' && req.method === 'GET') return sendJson(res, 200, scopes.list());
  if ((url.pathname === '/api/scopes/install' || url.pathname === '/api/scopes/remove') && req.method === 'POST') {
    return readJson(req, body => {
      if (!body || !body.id) return sendJson(res, 400, { ok: false, error: 'Bad request' });
      const r = url.pathname.slice(-7) === 'install' ? scopes.install(String(body.id), body.settings || {}) : scopes.remove(String(body.id));
      r.scopes = scopes.list();
      sendJson(res, r.ok ? 200 : 400, r);
    });
  }
  const owner = SCOPE_ROUTES.filter(r => url.pathname.indexOf(r[0]) === 0)[0];
  if (owner && !scopes.isInstalled(owner[1])) return sendJson(res, 404, { error: 'Scope not installed: ' + owner[1] });
  if (url.pathname === '/api/comfy') {
    const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 100, 1000);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(comfystats.getState(limit)));
  }
  if (url.pathname === '/api/comfy/models') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(comfystats.getModels(sysstats.vramInfo())));
  }
  if (url.pathname === '/api/comfy/view') {
    return comfystats.proxyImage(url.searchParams, res);
  }
  if (url.pathname === '/api/ollama') {
    const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 100, 1000);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(ollamastats.getState(limit, sysstats.vramInfo())));
  }
  if (url.pathname === '/api/lmstudio/models') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(lmapi.getState(sysstats.vramInfo())));
  }
  if (url.pathname === '/api/lmstudio/raw') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(lmapi.getRaw(), null, 2));
  }
  if (url.pathname.indexOf('/api/logo/') === 0) {
    return logos.serve(url.pathname.slice('/api/logo/'.length), res);
  }
  if (url.pathname === '/api/system') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(sysstats.getStats()));
  }
  if (url.pathname === '/api/requests') {
    const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 100, 1000);
    let body;
    try {
      body = lmstats.getLatestRequests(limit);
      body.rows.forEach(r => { r.peak = lmPeak(r); });
      body.current = lmstats.getCurrentRequest();
      body.average = lmstats.getAverage(body.rows);
    }
    catch (e) { body = { rows: [], error: String(e && e.message || e) }; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(body));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(pageHtml());
}).on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.log(`AI_SCOPE: port ${PORT} is already in use (is AI_SCOPE already running?). Try --port <another port>.`);
  else if (e.code === 'EACCES') console.log(`AI_SCOPE: no permission to use port ${PORT}. Try a port above 1024.`);
  else console.log('AI_SCOPE: could not start: ' + e.message);
  process.exit(1);
}).listen(PORT, HOST, () => {
  console.log(`AI_SCOPE running on port ${PORT}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs) {
        if (a.family === 'IPv4' && !a.internal) console.log(`  Network: http://${a.address}:${PORT}`);
      }
    }
  } else if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log(`  Network: http://${HOST}:${PORT}`);
  } else {
    console.log('  (this PC only - use --host 0.0.0.0 to open it from other devices)');
  }
  console.log(`  Data:    ${require('./paths').DATA_DIR}`);
  // --open (and so the Start Menu shortcut and the installer's first start) lands on the Home page.
  if (process.env.AI_SCOPE_OPEN === '1') require('./bin/open')(`http://localhost:${PORT}/#home`);
});
