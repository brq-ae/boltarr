// S-27: the app shows the short name the server sends (display_name), keeps the full one
// in the device panel, the hover, editing and search, and Settings → General → Short names
// is saved and redraws every name.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM } = require("jsdom");
const fs = require("fs");
const html = fs.readFileSync(`${BOLTARR}/frontend/index.html`, "utf8");
const body = html.slice(html.indexOf("<body"), html.indexOf("<script src=\"/js/graph.js\""));
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const dom = new JSDOM(body + "</body>", { runScripts: "outside-only", pretendToBeVisual: true, url: "http://x.test/" });
  const w = dom.window, d = w.document;
  if (d.readyState !== "complete") await new Promise(r => w.addEventListener("load", r));
  w.TextDecoder = TextDecoder; w.CSS = { escape: s => String(s) };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.localStorage.setItem("boltarr.viewLevel", "advanced");
  w.alert = () => {};
  let short = true, hostLoads = 0;
  const sent = [];
  const FULL = "phone-1.lan.example.com";
  const hosts = () => [
    { id: 1, ip: "10.62.0.5", hostname: FULL, net_hostname: FULL, hostname_set: 0, display_name: short ? "phone-1" : FULL, online: 1, ports: [] },
    { id: 2, ip: "10.62.0.6", hostname: "Work.Laptop", net_hostname: "laptop.lan.example.com", hostname_set: 1, display_name: "Work.Laptop", online: 1, ports: [] }];
  const SETTINGS = () => ({ general: { timezone: "", short_names: short }, llm: {}, statuspage: {}, notifications: {}, telegram: {}, change_tracking: {}, liveness: {}, ip_history: {}, ai_history: {}, security: {}, change_alerts: {}, monitoring: {} });
  w.fetch = async (u, o = {}) => {
    const m = o.method || "GET", path = u.replace(/^.*?(\/api)/, "$1").split("?")[0];
    const j = r => new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
    if (m !== "GET") {
      const b = o.body ? JSON.parse(o.body) : null; sent.push([m, path, b]);
      if (path === "/api/settings/all") { short = b.general.short_names; return j({ ok: true, ...SETTINGS() }); }
      return j({ ok: true });
    }
    if (path === "/api/hosts") { hostLoads++; return j(hosts()); }
    if (path === "/api/hosts/10.62.0.5") return j({ ...hosts()[0], services: [], analyses: [], aliases: [], alias_info: [], alias_ports: [] });
    if (path === "/api/services") return j([{ id: 7, name: "Demo web", ip: "10.62.0.5", host_id: 1, hostname: FULL, host_display_name: short ? "phone-1" : FULL, port: 80 }]);
    if (path === "/api/graph") return j({ nodes: [], edges: [] });
    if (path === "/api/settings") return j(SETTINGS());
    if (path === "/api/auth/status") return j({ enabled: true });
    if (path === "/api/ui/welcome") return j({ show: false });
    return j([]);
  };
  w.cytoscape = () => new Proxy({}, { get: () => () => ({}) });
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/level.js`, "utf8"));
  w.eval(["markdown", "export", "chat", "peek", ...require("./appfiles"), "fitcols", "search"].map(f => fs.readFileSync(`${BOLTARR}/frontend/js/${f}.js`, "utf8")).join("\n;\n"));
  d.dispatchEvent(new w.Event("DOMContentLoaded"));
  await sleep(300);
  const $ = id => d.getElementById(id);
  const row = ip => [...d.querySelectorAll("#hostsTable tbody tr, #hostsTbody tr, tr")].find(tr => tr.textContent.includes(ip));

  // Hosts table
  w.setTab("hosts"); await sleep(50);
  const cell = row("10.62.0.5")?.querySelector(".col-host span");
  check(cell && /^phone-1\b/.test(cell.textContent.trim()) && !cell.textContent.includes("example.com"), `Hosts list shows the short name ("${cell && cell.textContent.trim()}")`);
  check(cell && cell.title === `Network name: ${FULL}`, `…and hovering it shows the full name ("${cell && cell.title}")`);
  const mineCell = row("10.62.0.6")?.querySelector(".col-host span");
  check(mineCell && mineCell.textContent.includes("Work.Laptop"), "a name you set is shown as you typed it, dots and all");
  // Editing starts from the full stored name
  const pencil = row("10.62.0.5").querySelector('.col-host [data-click="editFieldBtn"]');
  pencil.click(); await sleep(10);
  const inp = row("10.62.0.5").querySelector(".col-host input");
  check(inp && inp.value === FULL, `editing the name starts from the full name ("${inp && inp.value}")`);
  if (inp) inp.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  // Device panel: short in the header, full under it and in the Hostname field
  await w.showHostDetail("10.62.0.5"); await sleep(50);
  const panel = $("hostDetail");
  check(/phone-1/.test(panel.querySelector(".detail-hostname")?.textContent || "") && !/example/.test(panel.querySelector(".detail-hostname")?.textContent || ""),
    "device panel header: the short name");
  check(new RegExp(`Network name: ${FULL.replace(/\./g, "\\.")}`).test(panel.textContent), "device panel: 'Network name' line with the full name");
  check($("detailNameField")?.textContent === FULL, "device panel Hostname field: the full stored name");
  // Search finds it by either name
  const gs = $("gsInput");
  gs.value = "example.com"; gs.dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(250);
  const res = $("gsResults").textContent;
  check(/10\.62\.0\.5/.test(res) && /phone-1/.test(res), `search for the domain part still finds it, shown short ("${res.slice(0, 80)}")`);
  gs.value = ""; gs.dispatchEvent(new w.Event("input", { bubbles: true }));
  // Services list
  w.setTab("services"); await sleep(80);
  const svcHost = d.querySelector(".svc-host-name");
  check(svcHost && svcHost.textContent === "phone-1", `Services list: short host name ("${svcHost && svcHost.textContent}")`);

  // Settings → General → Short names (Advanced)
  w.setTab("settings"); await sleep(80);
  check($("setShortNames").checked === true && !w.isLevelHidden($("setNamesCard")), "Settings shows Short names, on");
  $("setShortNames").checked = false; $("setShortNames").dispatchEvent(new w.Event("change", { bubbles: true }));
  const before = hostLoads;
  await w.saveSettings(); await sleep(150);
  const put = sent.find(s => s[1] === "/api/settings/all");
  check(put && put[2].general.short_names === false, "Save sends short_names: false");
  check(hostLoads > before, "after the change every name is redrawn (devices reloaded)");
  w.setTab("hosts"); await sleep(50);
  check(row("10.62.0.5")?.querySelector(".col-host span")?.textContent.includes(FULL), "full names now shown in the Hosts list");
  const n = hostLoads; await w.saveSettings(); await sleep(100);
  check(hostLoads === n, "saving again without changing it doesn't reload the devices");
  w.setViewLevel("basic"); await sleep(20);
  check(w.isLevelHidden($("setNamesCard")), "below Advanced the setting is hidden (good default)");
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
