// Host check (AI_SCOPE-021), shared by the dashboard server and the Ollama relay: a DNS-rebinding guard. A malicious site
// can point its own name at 127.0.0.1 and then read or change local services from your browser; its requests carry that
// foreign name as Host. Only names of this machine are answered: localhost (and *.localhost), loopback addresses, this
// PC's network addresses, its computer name (also as e.g. snow.local / snow.lan), the --host address, and names listed
// in AI_SCOPE Settings (Server section, "Allowed host names" - comma-separated, e.g. for a reverse proxy; AI_SCOPE-069
// removed the old AI_SCOPE_ALLOWED_HOSTS env var). Requests without a Host header (old HTTP/1.0 tools)
// are let through. No dependencies; conservative JS.
'use strict';
const os = require('os');
let EXTRA_HOSTS = [];   // AI_SCOPE-069: no env source - the Settings dialog's "Allowed host names" is the only supplier
// AI_SCOPE-010: the "Allowed host names" setting, set at boot and on change.
function setExtraHosts(list) {
  EXTRA_HOSTS = (list || []).map(function (h) { return String(h || '').trim().toLowerCase(); }).filter(function (h) { return !!h; });
}
let ownAddrs = null, ownAddrsAt = 0;
function ownAddresses() {   // this PC's addresses (refreshed every 30 s: DHCP / VPN can change them)
  if (!ownAddrs || Date.now() - ownAddrsAt > 30000) {
    ownAddrs = new Set();
    const ifs = os.networkInterfaces();
    Object.keys(ifs).forEach(function (k) { (ifs[k] || []).forEach(function (a) { ownAddrs.add(String(a.address).toLowerCase().split('%')[0]); }); });
    ownAddrsAt = Date.now();
  }
  return ownAddrs;
}
function hostAllowed(req) {
  const raw = req.headers.host;
  if (!raw) return true;
  let h = String(raw).toLowerCase().trim();
  h = h[0] === '[' ? h.slice(1, h.indexOf(']')) : h.replace(/:\d+$/, '');   // drop the port ([::1]:9000, name:9000)
  if (!h) return false;
  if (h === 'localhost' || /\.localhost$/.test(h) || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '::1' || h === '::ffff:127.0.0.1') return true;
  if (ownAddresses().has(h) || h === String(process.env.AI_SCOPE_HOST || '').toLowerCase() || EXTRA_HOSTS.indexOf(h) >= 0) return true;
  const me = os.hostname().toLowerCase();
  return h === me || h.split('.')[0] === me;   // snow, snow.local, snow.lan, snow.home.arpa
}
module.exports = { hostAllowed: hostAllowed, setExtraHosts: setExtraHosts };
