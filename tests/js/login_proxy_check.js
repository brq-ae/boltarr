// S-15: every setting survives the move to the Settings page. Loads one set of saved
// values (none at their default) into the page, saves without touching anything, and
// compares what is sent with what the old Settings dialog sends for the same values.
//   node settings_roundtrip_check.js [frontendRoot]  → prints the PUT body as JSON
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const ROOT = process.argv[2] || `${BOLTARR}/frontend`;
let html = fs.readFileSync(`${ROOT}/index.html`, "utf8");
html = html.replace(/<script src="\/vendor\/[^"]+"><\/script>/g, "");
html = html.replace(/<script src="\/js\/([^"]+)"><\/script>/g, (_, f) =>
  `<script>${fs.readFileSync(`${ROOT}/js/${f}`, "utf8").replace(/<\/script>/g, "<\\/script>")}</script>`);
html = html.replace(/<link[^>]+stylesheet[^>]*>/g, "");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SAVED = {
  general: { timezone: "Europe/Berlin" },
  llm: { provider: "ollama", base_url: "http://demo-ai:11434", api_key: "", model: "demo-model:7b", timeout: 77, long_timeout: 777, num_ctx: 4096, configured: true },
  notifications: { enabled: true, server: "https://ntfy.example", topic: "demo-topic", token: "••••••", check_seconds: 45,
    alert_after_minutes: 7, quiet_enabled: true, quiet_start: "01:30", quiet_end: "06:15", suppress_when_host_down: false },
  statuspage: { enabled: true, url: "http://demo-status:12102", token: "••••••", stale_minutes: 9 },
  change_tracking: { enabled: true, host_new: false, port_opened: true, port_closed: false, mac_changed: true, hostname_changed: false,
    host_offline: true, host_online: false, retention_days: 33 },
  change_alerts: { enabled: true, scope: "all", host_new: false, port_opened: false, port_closed: true, mac_changed: true,
    hostname_changed: true, host_offline: false, host_online: true, include_mac: true, include_aliases: false, on_scan: false,
    digest_enabled: false, digest_time: "07:45", digest_services: false, digest_ai: true, digest_ai_model: "demo-b:7b" },
  liveness: { enabled: false, interval_minutes: 4, offline_after: 5 },
  ip_history: { stale_days: 21, gone_days: 44 },
  ai_history: { enabled: false, keep_per_item: 6, keep_days: 12 },
  security: { frame_origins: "https://dash.example" },
};
let put = null; const authPuts = [];
const vc = new VirtualConsole(); const errors = [];
vc.on("jsdomError", e => errors.push(String(e.message || e)));
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://x.test/", virtualConsole: vc,
  beforeParse(w) {
    w.TextDecoder = TextDecoder; w.CSS = { escape: x => String(x) };
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.Element.prototype.scrollIntoView = () => {}; w.alert = m => errors.push("alert: " + m);
    const P = new Proxy(function () {}, { get: (t, k) => k === Symbol.iterator ? function* () {} : k === "length" ? 0
      : k === "then" || k === Symbol.toPrimitive ? undefined : P, apply: () => P });
    w.cytoscape = P; w.ResizeObserver = class { observe() {} disconnect() {} };
    const j = v => new w.Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    w.Response = Response;
    w.fetch = async (u, o) => { u = String(u);
      if (o && o.method === "PUT" && u.endsWith("/api/settings/all")) { put = JSON.parse(o.body); return j({}); }
      if (o && o.method === "PUT" && u.endsWith("/api/auth/settings")) { authPuts.push(JSON.parse(o.body)); return j({}); }
      if (u.endsWith("/api/auth/settings")) return j({ enabled: true, username: "admin", trust_proxy: false, trusted_proxies: "", proxy_header: "Remote-User" });
      return u.endsWith("/api/settings") ? j(SAVED)
        : u.includes("/api/models") ? j({ models: ["demo-a:latest", "demo-b:7b"], default: "demo-a:latest" })
        : u.includes("/api/auth/status") ? j({ enabled: false })
        : u.includes("/api/graph") ? j({ nodes: [], edges: [] })
        : u.includes("/api/dhcp-warnings") ? j({ hosts: {}, pools: [] })
        : u.includes("/api/ai-history") ? j({ count: 0 }) : u.includes("/api/digest/history") ? j({ digests: [] })
        : u.includes("/api/ai-actions/log") ? j({ actions: [] })
        : j(u.includes("config") || u.includes("status") || u.includes("health") || u.includes("context") ? {} : []); };
  } });
const w = dom.window;
(async () => {
  const check = (ok, m) => { console.log(`${ok ? "ok  " : "FAIL"}  ${m}`); if (!ok) process.exitCode = 1; };
  const $ = id => w.document.getElementById(id);
  await sleep(700);
  w.openSettings(); await sleep(400);
  await w.saveSettings(); await sleep(200);
  check(authPuts.length === 0, "login service not sent when unchanged");
  $("loginProxies").value = "172.18.0.5";
  $("loginProxies").dispatchEvent(new w.Event("input", { bubbles: true }));
  check(!$("settingsSaveBar").hidden, "changing the login service IP shows the save bar");
  await w.saveSettings(); await sleep(300);
  check(authPuts.length === 1 && authPuts[0].trusted_proxies === "172.18.0.5" && authPuts[0].proxy_header === "Remote-User",
        `Save sends it: ${JSON.stringify(authPuts[0])}`);
  check($("settingsSaveBar").hidden, "bar gone after Save");
  $("loginCurPw").value = "x"; $("loginCurPw").dispatchEvent(new w.Event("input", { bubbles: true }));
  check($("settingsSaveBar").hidden, "typing a password (an action) doesn't show the bar");
  check(!errors.length, "no errors " + errors.join(" | "));
  process.exit();
})();
