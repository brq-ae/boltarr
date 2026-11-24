// F-08 part B (v0.23.5): sidebar, top bar, Topology, Hierarchy, VLANs, connection and
// subnet dialogs, phone bar use data-* actions; nothing in the whole page is inline.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const ROOT = `${BOLTARR}/frontend`;
let html = fs.readFileSync(`${ROOT}/index.html`, "utf8");
html = html.replace(/<script src="\/vendor\/[^"]+"><\/script>/g, "");
html = html.replace(/<script src="\/js\/([^"]+)"><\/script>/g, (_, f) =>
  `<script>${fs.readFileSync(`${ROOT}/js/${f}`, "utf8").replace(/<\/script>/g, "<\\/script>")}</script>`);
html = html.replace(/<link[^>]+stylesheet[^>]*>/g, "");
let fail = 0; const errors = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOSTS = [{ id: 1, ip: "10.9.0.20", hostname: "pve-box", device_type: "server", classification: "static", online: 1, notes: "https://wiki.example/pve", ports: [{ id: 41, port: 22, protocol: "tcp", state: "open", service: "ssh" }], aliases: ["10.9.0.21"], dhcp_warnings: [], services: [] },
  { id: 2, ip: "10.9.0.30", hostname: "nas-01", device_type: "nas", online: 0, ports: [], aliases: [], dhcp_warnings: [], services: [] }];
const SUBNETS = [{ id: 1, name: "lab", cidr: "10.9.0.0/24" }];
const VLANS = [{ id: 3, vlan_id: 30, name: "iot", color: "#888888" }];
const SVCS = [{ id: 1, name: "Proxmox", ip: "10.9.0.20", host_id: 1, port: 8006, protocol: "tcp", status: "up", url: "http://10.9.0.20:8006", monitored: 0 }];
const KEYS = [{ id: 7, name: "laptop", public_key: "ssh-ed25519 AAAA laptop", fingerprint: "SHA256:x" }];
const ACCESS = [{ id: 3, key_id: 7, name: "laptop", username: `o'brien"x`, fingerprint: "SHA256:x" }];
const SCHED = [{ id: 5, name: "Nightly", enabled: 1, target_type: "all", interval_hours: 24, profile_name: "Quick" }];
const SCANS = [{ id: 9, status: "done", target: "10.9.0.0/24", started_at: "2026-01-01 00:00:00" }];
const EVS = [{ id: 1, type: "new_host", ip: "10.9.0.20", ts: "2026-01-01 00:00:00" }];
const warns = [];
const vc = new VirtualConsole();
vc.on("warn", (...a) => warns.push(a.join(" ")));
vc.on("jsdomError", e => errors.push(String(e.message || e)));
vc.on("error", e => errors.push(String(e)));
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://x.test/", virtualConsole: vc,
  beforeParse(w) {
    w.TextDecoder = TextDecoder;
    w.CSS = { escape: x => String(x) };
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.Element.prototype.scrollIntoView = () => {};
    // Fake Cytoscape: every property/call returns itself (empty, iterable, never a promise)
    const P = new Proxy(function () {}, { get: (t, k) => k === Symbol.iterator ? function* () {} : k === "length" ? 0
      : k === "then" || k === Symbol.toPrimitive ? undefined : P, apply: () => P });
    w.cytoscape = P;
    w.ResizeObserver = class { observe() {} disconnect() {} };
    const j = v => new w.Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    w.Response = Response;
    w.fetch = async (u, o) => { u = String(u);
      return u.endsWith("/api/hosts") ? j(HOSTS) : u.endsWith("/api/services") ? j(SVCS)
        : /\/api\/hosts\/10\.9\.0\.20$/.test(u) ? j(HOSTS[0])
        : u.includes("/api/dhcp-warnings") ? j({ hosts: {}, pools: [] })
        : u.includes("/api/settings") ? j({ llm: { configured: false } })
        : u.includes("/api/auth/status") ? j({ enabled: false })
        : u.includes("/api/version") ? j({ version: "x" })
        : u.endsWith("/api/subnets") ? j(SUBNETS)
        : u.endsWith("/api/vlans") ? j(VLANS)
        : u.includes("/api/graph") ? j({ nodes: [], edges: [] })   // the fake Cytoscape can't draw real ones
        : j(u.includes("config") ? {} : []); };
  } });
const w = dom.window, d = w.document;
(async () => {
  await sleep(700);
  check(errors.length === 0, `boots with no errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  const A = w.eval("ACTIONS");
  const actionNames = () => [...d.querySelectorAll("[data-click],[data-change],[data-input]")].map(el => el.dataset.click || el.dataset.change || el.dataset.input);
  const inl = el => [...el.querySelectorAll("*")].filter(x => [...x.attributes].some(a => /^on/.test(a.name)));
  const calls = [];
  const spy = n => { const o = A[n]; A[n] = function (...a) { calls.push([n, this, ...a]); }; return () => (A[n] = o); };
  const one = () => { const c = calls.splice(0); return c.length === 1 ? c[0] : [`${c.length} calls: ${c.map(x => x[0])}`]; };
  const args = c => JSON.stringify(c.slice(2));
  const clickEl = el => { const ev = new w.MouseEvent("click", { bubbles: true, cancelable: true }); el.dispatchEvent(ev); return ev; };
  const q = s => d.querySelector(s);
  const spyClick = (sel, n, want = "[]") => {
    const el = q(sel); if (!el) return check(false, `${sel} exists`);
    const u = spy(n); clickEl(el); u(); const c = one();
    check(c[0] === n && args(c) === want, `${sel} → ${n} ${want}${c[0] !== n ? " (got " + c[0] + ")" : ""}`);
  };

  // Sidebar + phone bar tabs
  for (const tab of ["services", "hosts", "subnets", "scans", "sshkeys", "settings"]) {
    clickEl(q(`.sidebar-nav [data-tab="${tab}"]`)); await sleep(30);
    check(q(`#panel-${tab}`).classList.contains("active"), `sidebar → ${tab}`);
  }
  clickEl(q('.sidebar-nav [data-tab="topology"]')); await sleep(30);
  check(q("#panel-topology").classList.contains("active"), "sidebar → topology (openTopology)");
  clickEl(q('.bottom-nav [data-tab="hosts"]')); await sleep(30);
  check(q("#panel-hosts").classList.contains("active"), "phone bar → hosts");
  clickEl(q('.bottom-nav [data-tab="topology"]')); await sleep(30);
  spyClick("#menuBtn", "toggleSidebar");
  spyClick("#sidebarOverlay", "closeSidebar");
  spyClick("#aiSettingsBtn", "setTab", JSON.stringify(["settings"]));
  spyClick('.topbar [data-click="toggleChat"]', "toggleChat");
  spyClick('#chatPanel [data-click="toggleChat"]', "toggleChat");
  spyClick("#logoutBtn", "logout");

  // Subnets moved to their own page (v0.24.0): the sidebar only links to it
  check(!q("#subnetList") && !q(".sidebar .subnet-row"), "no subnet list left in the sidebar");
  clickEl(q('.sidebar-nav [data-tab="subnets"]')); await sleep(30);
  check(q("#panel-subnets").classList.contains("active"), "sidebar → Subnets page");
  clickEl(q('.bottom-nav [data-tab="subnets"]')); await sleep(30);
  check(q("#panel-subnets").classList.contains("active") && q('.bottom-nav [data-tab="subnets"]').classList.contains("active"), "phone bar → Subnets");
  clickEl(q('#panel-subnets [data-click="openAddSubnet"]'));
  check(q("#subnetModal").classList.contains("open"), "+ Add subnet opens the dialog");
  spyClick('#subnetModal [data-click="saveSubnet"]', "saveSubnet");
  clickEl(q('#subnetModal [data-click="closeAddSubnet"]'));
  check(!q("#subnetModal").classList.contains("open"), "Add subnet Cancel closes it");
  clickEl(q('.sidebar-nav [data-tab="topology"]')); await sleep(30);

  // Topology toolbar
  spyClick('#panel-topology [data-click="openNetworkAnalysis"]', "openNetworkAnalysis");
  for (const n of ["toggleConnectMode", "toggleMultiConnectMode", "openMultiConnModal", "saveLayoutToDb"]) {
    w.eval(`var __g_${n} = ${n}; ${n} = function () { window.__hit = "${n}" }`);
    w.__hit = null; clickEl(q(`#panel-topology [data-click="${n}"]`));
    check(w.__hit === n, `toolbar ${n} reaches graph.js`);
    w.eval(`${n} = __g_${n}`);
  }
  const legend = q("#legendItems"), was = legend.classList.contains("collapsed");
  clickEl(q('[data-click="toggleLegend"]'));
  check(legend.classList.contains("collapsed") !== was, "Legend toggles");
  spyClick("#stopScanBtn", "stopScan");
  const cm = new w.MouseEvent("contextmenu", { bubbles: true, cancelable: true }); q("#cy").dispatchEvent(cm);
  check(cm.defaultPrevented, "right-click on the graph shows no browser menu");
  spyClick('#panel-topology [data-click="setTab"][data-args=\'["hierarchy"]\']', "setTab", '["hierarchy"]');

  // Hierarchy
  w.setTab("hierarchy"); await w.loadHierarchy(); await sleep(50);
  const hrow = q(".hier-node-row");
  check(!!hrow, "hierarchy renders");
  spyClick(".hier-node-row .hier-ip", "showHostDetail", '["10.9.0.20"]');
  spyClick('.hier-node-row [data-click="hierLinkFrom"]', "hierLinkFrom", '["10.9.0.20"]');
  spyClick('.hier-node-row [data-click="hierMultiLinkFrom"]', "hierMultiLinkFrom", '["10.9.0.20"]');
  spyClick('#panel-hierarchy [data-click="loadHierarchy"]', "loadHierarchy");
  let printed = 0; w.print = () => printed++;
  clickEl(q('#panel-hierarchy [data-click="printPage"]'));
  check(printed === 1, "Print / PDF prints");
  clickEl(q('#panel-hierarchy [data-click="setTab"][data-args=\'["topology"]\']')); await sleep(30);
  check(q("#panel-topology").classList.contains("active"), "Hierarchy → Graph");

  // VLANs
  clickEl(q("#vlanBtn")); await sleep(50);
  check(q("#vlanModal").classList.contains("open"), "◈ VLANs opens the panel");
  spyClick('#vlanModal [data-click="openEditVlan"]', "openEditVlan", "[3]");
  spyClick('#vlanModal [data-click="deleteVlan"]', "deleteVlan", "[3]");
  spyClick('#vlanModal [data-click="addVlan"]', "addVlan");
  spyClick('#vlanModal [data-click="saveEditVlan"]', "saveEditVlan");
  spyClick('#vlanModal [data-click="cancelEditVlan"]', "cancelEditVlan");
  clickEl(q('#vlanModal [data-click="closeVlanPanel"]'));
  check(!q("#vlanModal").classList.contains("open"), "VLAN × closes it");

  // Connection dialogs: port mode shows the VLAN section; buttons
  for (const [sel, sec] of [["connPortMode", "connVlanSection"], ["editConnPortMode", "editConnVlanSection"], ["multiConnPortMode", "multiConnVlanSection"]]) {
    const s = q("#" + sel); s.value = [...s.options].map(o => o.value).find(v => v) || ""; s.dispatchEvent(new w.Event("change", { bubbles: true }));
    const shown = q("#" + sec).style.display !== "none";
    s.value = ""; s.dispatchEvent(new w.Event("change", { bubbles: true }));
    check(shown && q("#" + sec).style.display === "none", `${sel}: picking a port mode shows VLANs, none hides them`);
  }
  for (const [n, sel] of [["saveConnection", "#connModal"], ["closeConnModal", "#connModal"], ["saveConnEdit", "#editConnModal"],
                          ["closeEditConn", "#editConnModal"], ["deleteConnFromEdit", "#editConnModal"],
                          ["saveMultiConnections", "#multiConnModal"], ["closeMultiConnModal", "#multiConnModal"]])
    spyClick(`${sel} [data-click="${n}"]`, n);

  // Network analysis
  q("#networkAnalysisModal").classList.add("open");
  spyClick('#networkAnalysisModal [data-click="runNetworkAnalysis"]', "runNetworkAnalysis");
  clickEl(q('#networkAnalysisModal [data-click="closeNetworkAnalysis"]'));
  check(!q("#networkAnalysisModal").classList.contains("open"), "Network analysis × closes it");

  // No-password banner
  w.showNoPasswordBanner();
  spyClick('.nopw-banner [data-click="openLoginSettings"]', "openLoginSettings");
  clickEl(q('.nopw-banner [data-click="snoozeNoPwBanner"]'));
  check(!q(".nopw-banner"), "banner Not now hides it");

  // Whole page: no inline handlers left, every action registered
  w.setTab("hosts"); await sleep(30); await w.showHostDetail("10.9.0.20"); await sleep(50);
  const missing = actionNames().filter(n => typeof A[n] !== "function");
  check(!missing.length, `all ${actionNames().length} actions on the page are registered${missing.length ? ": missing " + missing : ""}`);
  check(!inl(d.documentElement).length, `no inline handlers anywhere in the page${inl(d.documentElement).length ? ": " + inl(d.documentElement).slice(0, 3).map(x => x.outerHTML.slice(0, 80)) : ""}`);
  check(!warns.length, `no unknown-action warnings${warns.length ? ": " + warns : ""}`);
  check(errors.length === 0, `no errors after all clicks${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
