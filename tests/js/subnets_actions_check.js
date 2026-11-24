// v0.24.0 Subnets page (S-16): rows, pool bar, hosts link + filter chip, map toggle saved,
// Scan → Stop on the row, ⋮ menu (Edit, Show on map, IP History, Delete with confirm).
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
  { id: 2, ip: "10.9.0.30", hostname: "nas-01", device_type: "nas", online: 0, ports: [], aliases: [], dhcp_warnings: [], services: [] },
  { id: 3, ip: "10.7.0.5", hostname: "elsewhere", device_type: "pc", online: 1, ports: [], aliases: [], dhcp_warnings: [], services: [] }];
const SUBNETS = [{ id: 1, name: "lab", cidr: "10.9.0.0/24", description: "Main test net", dhcp_start: "10.9.0.100", dhcp_end: "10.9.0.103", map_hidden: 0 },
  { id: 2, name: "cams", cidr: "10.8.0.0/24", map_hidden: 1 }];
const SUMMARY = [{ id: 1, hosts: 2, online: 1, pool: { used: 3, size: 4, pct: 75 }, last_scan: { started_at: "2026-01-01 00:00:00", completed_at: "2026-01-01 00:01:00", status: "completed", hosts_found: 5 }, running_run_id: null, schedules: 2 },
  { id: 2, hosts: 0, online: 0, pool: null, last_scan: null, running_run_id: 77, schedules: 0 }];
const IPH = { counts: { in_use: 0, recent: 0, stale: 0, gone: 0, never: 0 }, subnet: { cidr: "10.9.0.0/24" }, has_pool: true, stale_days: 30, gone_days: 90, ips: [] };
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
    w.fetch = async (u, o) => { u = String(u); const m = (o && o.method) || "GET";
      if (m !== "GET") sent.push([m, u.replace("http://x.test", ""), o.body ? JSON.parse(o.body) : null]);
      return u.endsWith("/api/hosts") ? j(HOSTS) : u.endsWith("/api/services") ? j(SVCS)
        : u.includes("/api/dhcp-warnings") ? j({ hosts: {}, pools: [] })
        : u.includes("/api/settings") ? j({ llm: { configured: false } })
        : u.includes("/api/auth/status") ? j({ enabled: false })
        : u.includes("/api/version") ? j({ version: "x" })
        : u.endsWith("/api/subnets/summary") ? j(SUMMARY)
        : u.endsWith("/api/subnets") ? j(SUBNETS)
        : u.includes("/ip-history") ? j(IPH)
        : /\/api\/scan\/\d+$/.test(u) && m === "POST" ? j({ run_id: 9, status: "started" })
        : /\/api\/scan\/9\/status/.test(u) ? j({ status: "scanning", progress: 40 })
        : u.includes("/api/graph") ? j({ nodes: [], edges: [] })
        : j(u.includes("config") ? {} : []); };
  } });
const sent = [];
const w = dom.window, d = w.document;
(async () => {
  await sleep(700);
  check(errors.length === 0, `boots with no errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  const A = w.eval("ACTIONS");
  const calls = [];
  const spy = n => { const o = A[n]; A[n] = function (...a) { calls.push([n, this, ...a]); }; return () => (A[n] = o); };
  const one = () => { const c = calls.splice(0); return c.length === 1 ? c[0] : [`${c.length} calls: ${c.map(x => x[0])}`]; };
  const clickEl = el => { const ev = new w.MouseEvent("click", { bubbles: true, cancelable: true }); el.dispatchEvent(ev); return ev; };
  const q = s => d.querySelector(s);
  const row = id => q(`#subnet-tr-${id}`);

  w.setTab("subnets"); await sleep(80);
  check(row(1) && row(2), "Subnets page lists both subnets");
  check(q("#subnetCount").textContent === "2 subnets", "count shows 2 subnets");
  check(row(1).querySelector(".sub-desc").textContent === "Main test net", "description shows under the name");
  check(row(1).querySelector(".pool-bar.busy") && row(1).querySelector(".pool-pct").textContent === "75%", "pool bar: 75% (amber)");
  check(row(2).querySelector(".col-sub-pool").textContent.trim() === "—", "no pool → —");
  check(/2\s*1 online/.test(row(1).querySelector(".col-sub-hosts").textContent), "hosts: 2 · 1 online");
  check(/5 found/.test(row(1).querySelector(".col-sub-scan").textContent) && /never/.test(row(2).querySelector(".col-sub-scan").textContent), "last scan: 5 found / never");
  check(w.eval("hiddenSubnets.has(2) && !hiddenSubnets.has(1)") && row(2).querySelector(".sub-eye.off"), "saved map-hidden subnet shows as hidden after load");

  // Row opens Edit; things inside run only their own
  let u = spy("openEditSubnet"); clickEl(row(1).querySelector(".col-sub-cidr")); u();
  let c = one(); check(c[0] === "openEditSubnet" && JSON.stringify(c.slice(2)) === "[1]", "clicking the row opens Edit for subnet 1");
  clickEl(row(1).querySelector(".col-sub-name"));
  check(q("#subnetModal").classList.contains("open") && q("#subnetName").value === "lab" && q("#subnetDhcpStart").value === "10.9.0.100", "Edit dialog opens filled in");
  w.closeAddSubnet();
  sent.length = 0; u = spy("openEditSubnet");
  clickEl(row(1).querySelector(".sub-eye")); await sleep(30); u();
  check(!calls.length && sent.some(s => s[0] === "PUT" && s[1] === "/api/subnets/1" && s[2].map_hidden === true), "👁 hides subnet 1 and saves it (doesn't open Edit)"); calls.length = 0;
  check(row(1).querySelector(".sub-eye.off") && w.eval("hiddenSubnets.has(1)"), "row shows it hidden");
  clickEl(row(1).querySelector(".sub-eye")); await sleep(30);
  check(sent.some(s => s[2] && s[2].map_hidden === false), "clicking again shows it and saves");

  // Hosts link → Hosts page filtered, chip clears it
  u = spy("openEditSubnet"); clickEl(row(1).querySelector('[data-click="showSubnetHosts"]')); u(); await sleep(50);
  check(!calls.length && q("#panel-hosts").classList.contains("active"), "hosts number opens the Hosts page (not Edit)"); calls.length = 0;
  const ips = () => [...d.querySelectorAll("#hostsTable tbody tr[data-click]")].map(r => JSON.parse(r.dataset.args)[0]);
  check(!q("#hostsSubnetChip").hidden && /lab \(10\.9\.0\.0\/24\)/.test(q("#hostsSubnetChip").textContent) && ips().join() === "10.9.0.20,10.9.0.30",
    `Hosts shows only lab's hosts with a chip (${ips()})`);
  clickEl(q('#hostsSubnetChip [data-click="clearHostsSubnetFilter"]'));
  check(q("#hostsSubnetChip").hidden && ips().length === 3, "× on the chip shows all hosts again");

  // Scan → Stop on the row
  w.setTab("subnets"); await sleep(50);
  sent.length = 0; clickEl(row(1).querySelector('[data-click="triggerScan"]')); await sleep(50);
  check(sent.some(s => s[0] === "POST" && s[1] === "/api/scan/1"), "▶ Scan starts a scan of subnet 1");
  check(row(1).querySelector('[data-click="stopSubnetScan"]') && !row(1).querySelector('[data-click="triggerScan"]'), "the row's Scan turns into Stop");
  await sleep(1700);
  check(q("#subnet-prog-1") && q("#subnet-prog-1").textContent === "40%", `Stop shows progress (${q("#subnet-prog-1") && q("#subnet-prog-1").textContent})`);
  sent.length = 0; clickEl(row(1).querySelector('[data-click="stopSubnetScan"]')); await sleep(30);
  check(sent.some(s => s[1] === "/api/scan/9/cancel"), "Stop on the row stops that scan");
  w.eval("clearInterval(pollTimer); activeScanSubnet = null; activeRunId = null"); w.renderSubnetList();
  check(row(2).querySelector('[data-click="stopSubnetScan"]'), "a scan started by a schedule also shows Stop");
  sent.length = 0; clickEl(row(2).querySelector('[data-click="stopSubnetScan"]')); await sleep(30);
  check(sent.some(s => s[1] === "/api/scan/77/cancel"), "…and Stop cancels that run");

  // ⋮ menu
  const menu = () => q("#svcmenu-sub1");
  u = spy("openEditSubnet"); clickEl(row(1).querySelector(".svc-kebab")); u();
  check(menu().classList.contains("open") && !calls.length, "⋮ opens the menu (not Edit)"); calls.length = 0;
  clickEl(menu().querySelector('[data-click="subnetMenuEdit"]'));
  check(!menu().classList.contains("open") && q("#subnetModal").classList.contains("open"), "menu Edit closes the menu and opens Edit");
  w.closeAddSubnet();
  clickEl(row(1).querySelector(".svc-kebab")); clickEl(menu().querySelector('[data-click="subnetMenuMap"]')); await sleep(50);
  check(q("#panel-topology").classList.contains("active"), "Show on map goes to Topology");
  w.setTab("subnets"); await sleep(50);
  clickEl(row(1).querySelector(".svc-kebab")); clickEl(menu().querySelector('[data-click="subnetMenuIpHistory"]')); await sleep(100);
  check(q("#hosts-panel-iphistory").style.display === "" && q("#iphSubnet").value === "1", `IP History opens on this subnet (${q("#iphSubnet").value})`);
  w.setTab("subnets"); await sleep(50);
  let asked = ""; w.confirm = m => { asked = m; return false; };
  sent.length = 0; clickEl(row(1).querySelector(".svc-kebab")); clickEl(menu().querySelector('[data-click="subnetMenuDelete"]')); await sleep(30);
  check(/Delete subnet "lab"/.test(asked) && /hosts stay/i.test(asked) && /2 scan schedules/.test(asked), `Delete asks first, naming the subnet and its 2 schedules`);
  check(!sent.some(s => s[0] === "DELETE") && row(1), "Cancel keeps it");
  w.confirm = () => true;
  clickEl(row(1).querySelector(".svc-kebab")); clickEl(menu().querySelector('[data-click="subnetMenuDelete"]')); await sleep(50);
  check(sent.some(s => s[0] === "DELETE" && s[1] === "/api/subnets/1") && !row(1), "OK deletes it and the row goes");

  const inl = [...d.querySelectorAll("#panel-subnets *")].filter(x => [...x.attributes].some(a => /^on/.test(a.name)));
  check(!inl.length, "no inline handlers on the page");
  check(!warns.length, `no unknown-action warnings${warns.length ? ": " + warns : ""}`);
  check(errors.length === 0, `no errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
