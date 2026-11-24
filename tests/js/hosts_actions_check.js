// F-08 part B (v0.23.4): the Hosts page, host panel and Add/Edit/Merge host dialogs use
// data-click/data-change/data-input actions; the row opens the panel, things inside run only their own.
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
const IPH = { counts: { in_use: 1, recent: 1, stale: 0, gone: 0, never: 0 }, subnet: { cidr: "10.9.0.0/24" }, has_pool: false, stale_days: 30, gone_days: 90,
  ips: [{ ip: "10.9.0.20", status: "in_use", host_ip: "10.9.0.20", online: 1 }, { ip: "10.9.0.30", status: "recent", host_ip: "10.9.0.30", days: 3, last_seen: "2026-01-01 00:00:00" }] };
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
    w.fetch = async (u, o) => { u = String(u); if (o && o.method && o.method !== "GET") sent.push([o.method, u, o.body ? JSON.parse(o.body) : null]);
      return u.endsWith("/api/hosts") ? j(HOSTS) : u.endsWith("/api/services") ? j(SVCS)
        : /\/api\/hosts\/10\.9\.0\.20$/.test(u) ? j(HOSTS[0])
        : u.includes("/api/dhcp-warnings") ? j({ hosts: {}, pools: [] })
        : u.includes("/api/settings") ? j({ llm: { configured: false } })
        : u.includes("/api/auth/status") ? j({ enabled: false })
        : u.includes("/api/version") ? j({ version: "x" })
        : u.endsWith("/api/subnets") ? j([{ id: 1, name: "lab", cidr: "10.9.0.0/24" }])
        : u.includes("/ip-history") ? j(IPH)
        : u.includes("/api/ssh-keys") ? j(KEYS)
        : u.includes("/api/graph") ? j({ nodes: [], edges: [] })
        : j(u.includes("config") ? {} : []); };
  } });
const sent = [];
const w = dom.window, d = w.document;
(async () => {
  await sleep(600);
  check(errors.length === 0, `boots with no errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  const A = w.eval("ACTIONS");
  const names = [...d.querySelectorAll("[data-click],[data-change],[data-input]")].map(el => el.dataset.click || el.dataset.change || el.dataset.input);
  const missing = names.filter(n => typeof A[n] !== "function");
  check(!missing.length, `all ${names.length} actions in the page are registered${missing.length ? ": missing " + missing : ""}`);
  const inl = el => [...el.querySelectorAll("*")].filter(x => [...x.attributes].some(a => /^on/.test(a.name)));
  check(["panel-hosts", "mergeModal", "addHostModal", "editModal"].every(id => !inl(d.getElementById(id)).length), "no inline handlers in the Hosts areas");
  const calls = [];
  const spy = n => { const o = A[n]; A[n] = function (...a) { calls.push([n, this, ...a]); }; return () => (A[n] = o); };
  const one = () => { const c = calls.splice(0); return c.length === 1 ? c[0] : [`${c.length} calls: ${c.map(x => x[0])}`]; };
  const args = c => JSON.stringify(c.slice(2));
  const clickEl = el => { const ev = new w.MouseEvent("click", { bubbles: true, cancelable: true }); el.dispatchEvent(ev); return ev; };

  w.setTab("hosts"); await sleep(100);
  const tr = [...d.querySelectorAll("#hostsTable tbody tr")].find(r => r.dataset.click === "showHostDetail");
  check(!!tr, "hosts table renders");
  // Row vs. things inside the row: each runs only its own action
  let undo = spy("showHostDetail"); clickEl(tr.querySelector(".td-seen")); undo();
  let c = one(); check(c[0] === "showHostDetail" && args(c) === '["10.9.0.20"]', "clicking the row opens host 10.9.0.20");
  for (const [sel, name, want] of [
    ['.td-host [data-click="editFieldBtn"]', "editFieldBtn", '["10.9.0.20","hostname"]'],
    ['.col-notes [data-click="editFieldBtn"]', "editFieldBtn", '["10.9.0.20","notes"]'],
    ['[data-click="editTypeBtn"]', "editTypeBtn", '["10.9.0.20"]'],
    ['[data-click="editMacBtn"]', "editMacBtn", '["10.9.0.20"]'],
    ['[data-click="toggleAliasRow"]', "toggleAliasRow", '["10.9.0.20"]']]) {
    const u1 = spy("showHostDetail"), u2 = spy(name); clickEl(tr.querySelector(sel)); u1(); u2();
    c = one(); check(c[0] === name && args(c) === want, `${sel.split(" ")[0]} ${name} ${want} runs without opening the panel`);
  }
  // the pencil hands the cell to the real editor
  w.eval("var __efFn = editField; editField = (ip, f, td) => { window.__ef = [ip, f, td && td.tagName] }");
  clickEl(tr.querySelector('.td-host [data-click="editFieldBtn"]'));
  check(JSON.stringify(w.__ef) === '["10.9.0.20","hostname","TD"]', "✎ passes its table cell to the editor");
  w.eval("editField = __efFn");
  w.renderHostsTable();
  const row = () => [...d.querySelectorAll("#hostsTable tbody tr")].find(r => r.dataset.click === "showHostDetail");
  clickEl(row().querySelector('.td-host [data-click="editFieldBtn"]'));
  const inp = row().querySelector(".td-host input.cell-input");
  undo = spy("showHostDetail"); clickEl(inp); undo();
  check(inp && !calls.length, "clicking into the open hostname editor doesn't open the panel"); calls.length = 0;
  w.renderHostsTable();
  undo = spy("showHostDetail"); const u5 = spy("hostsUpdateBulkBtn"); row().querySelector(".host-checkbox").click(); undo(); u5();
  c = one(); check(c[0] === "hostsUpdateBulkBtn", "ticking the row checkbox updates the bulk button and does NOT open the panel");
  undo = spy("showHostDetail"); const ev = clickEl(row().querySelector("a.note-link")); undo();
  check(!calls.length && !ev.defaultPrevented, "note link opens normally and doesn't open the panel (data-stop)"); calls.length = 0;
  w.renderHostsTable();
  const all = d.getElementById("hostsSelectAll"); all.checked = true; all.dispatchEvent(new w.Event("change", { bubbles: true }));
  check([...d.querySelectorAll(".host-checkbox")].every(b => b.checked) && d.getElementById("hostsDeleteBtn").style.display === "", "select-all ticks every row and shows Delete selected");
  undo = spy("sortTable"); d.querySelector('#hostsTable th[data-args=\'["hostname"]\']').click(); undo();
  c = one(); check(args(c) === '["hostname"]', "clicking a column header sorts by it");
  undo = spy("openAddHost"); d.querySelector('#panel-hosts [data-click="openAddHost"]').click(); undo();
  check(one()[0] === "openAddHost", "+ Add Host opens the dialog");

  // IP History sub-tab
  d.querySelector('#panel-hosts [data-click="setHostsTab"][data-args=\'["iphistory"]\']').click(); await sleep(80);
  check(d.getElementById("hosts-panel-iphistory").style.display === "" && d.querySelectorAll("#iphTable tbody tr").length === 2, "IP History tab opens and lists 2 IPs");
  d.querySelector('#iphChips [data-click="setIpHistoryStatus"][data-args=\'["recent"]\']').click();
  check(d.querySelectorAll("#iphTable tbody tr").length === 1, "a status chip filters the list");
  const f = d.getElementById("iphFilter"); f.value = "nothing-matches"; f.dispatchEvent(new w.Event("input", { bubbles: true }));
  check(d.getElementById("iphCount").textContent === "0 IPs", "typing in the filter re-filters");
  f.value = ""; f.dispatchEvent(new w.Event("input", { bubbles: true }));
  undo = spy("sortIpHistory"); d.querySelector('#iphTable th[data-click="sortIpHistory"]').click(); undo();
  check(args(one()) === '["ip"]', "IP History header sorts");
  undo = spy("loadIpHistory"); d.getElementById("iphSubnet").dispatchEvent(new w.Event("change", { bubbles: true })); undo();
  check(one()[0] === "loadIpHistory", "changing the subnet reloads IP History");
  d.querySelector('#panel-hosts [data-click="setHostsTab"][data-args=\'["list"]\']').click();
  check(d.getElementById("hosts-panel-list").style.display === "", "List tab comes back");

  // Host panel
  w.eval('graphEdges = [{ data: { source: "10.9.0.20", target: "10.9.0.30", connection_id: 77 } }]');
  await w.showHostDetail("10.9.0.20"); await sleep(80);
  const P = d.getElementById("hostDetail");
  check(P.classList.contains("open") && !inl(P).length, "host panel opens with no inline handlers");
  for (const n of ["analyzeHost", "openEditHost", "openMergeHost", "probeHost", "deleteHost"]) {
    undo = spy(n); P.querySelector(`[data-click="${n}"]`).click(); undo();
    c = one(); check(c[0] === n && args(c) === '["10.9.0.20"]', `panel ${n} button gets the host IP`);
  }
  for (const tab of ["links", "ports", "services", "analysis", "info"]) {
    P.querySelector(`.detail-tab[data-tab="${tab}"]`).click();
    check(P.querySelector(".detail-tab.active").dataset.tab === tab, `${tab} tab switches`);
  }
  w.eval("var __sshFn = loadHostSshSection, __chgFn = loadHostChanges; loadHostSshSection = ip => window.__ssh = ip; loadHostChanges = ip => window.__chg = ip");
  P.querySelector('.detail-tab[data-tab="ssh"]').click(); P.querySelector('.detail-tab[data-tab="changes"]').click();
  check(w.__ssh === "10.9.0.20" && w.__chg === "10.9.0.20" && P.querySelector(".detail-tab.active").dataset.tab === "changes", "SSH and Changes tabs switch and load for this host");
  w.eval("loadHostSshSection = __sshFn; loadHostChanges = __chgFn");
  for (const [n, want] of [["removeAlias", '["10.9.0.20","10.9.0.21"]'], ["deletePort", '[41,"10.9.0.20"]'], ["addPort", '["10.9.0.20"]'],
                           ["openEditConnById", "[77]"], ["addLinkFromDetail", '["10.9.0.20"]'], ["addServiceToHost", '["10.9.0.20"]']]) {
    undo = spy(n); P.querySelector(`[data-click="${n}"]`).click(); undo();
    c = one(); check(c[0] === n && args(c) === want, `${n} gets ${want}`);
  }
  const np = d.getElementById("newSvcPort"); np.value = "8080"; np.dispatchEvent(new w.Event("input", { bubbles: true }));
  check(d.getElementById("newSvcUrl").value === "http://10.9.0.20:8080", "quick-add service: typing a port fills in the URL");
  const nu = d.getElementById("newSvcUrl"); nu.value = "https://pve.lan/"; nu.dispatchEvent(new w.Event("input", { bubbles: true }));
  np.value = "8443"; np.dispatchEvent(new w.Event("input", { bubbles: true }));
  check(nu.value === "https://pve.lan/", "quick-add service: a URL you typed stays");
  P.querySelector('[data-click="hideHostDetail"]').click();
  check(!P.classList.contains("open"), "× closes the host panel");

  // Edit host dialog
  await w.openEditHost("10.9.0.20"); await sleep(60);
  const E = d.getElementById("editModal");
  check(E.classList.contains("open"), "Edit host opens");
  const dh = d.getElementById("editIsDhcp"); dh.checked = true; dh.dispatchEvent(new w.Event("change", { bubbles: true }));
  check(d.getElementById("editDhcpPoolRow").style.display === "", "ticking DHCP server shows the pool fields");
  dh.checked = false; dh.dispatchEvent(new w.Event("change", { bubbles: true }));
  check(d.getElementById("editDhcpPoolRow").style.display === "none", "unticking hides them");
  undo = spy("onEditPublicToggle"); d.getElementById("editPublic").dispatchEvent(new w.Event("change", { bubbles: true })); undo();
  check(one()[0] === "onEditPublicToggle", "Public toggle runs");
  w.alert = m => errors.push("alert: " + m);
  sent.length = 0; E.querySelector('[data-click="saveHostEdit"]').click(); await sleep(100);
  check(sent.some(s => s[0] === "PUT" && s[1].endsWith("/api/hosts/10.9.0.20")) && !errors.length, `Save sends the edit${errors.length ? ": " + errors.slice(-1) : ""}`);
  w.openEditHost("10.9.0.20"); await sleep(60);
  E.querySelector('[data-click="closeEditHost"]').click();
  check(!E.classList.contains("open"), "Edit host Cancel closes it");
  // Add / Merge dialogs
  w.openAddHost(); await sleep(20);
  check(d.getElementById("addHostModal").classList.contains("open"), "Add host opens");
  undo = spy("saveAddHost"); d.querySelector('#addHostModal [data-click="saveAddHost"]').click(); undo();
  check(one()[0] === "saveAddHost", "Add host button runs saveAddHost");
  d.querySelector('#addHostModal [data-click="closeAddHost"]').click();
  check(!d.getElementById("addHostModal").classList.contains("open"), "Add host Cancel closes it");
  w.openMergeHost("10.9.0.20"); await sleep(20);
  check(d.getElementById("mergeModal").classList.contains("open"), "Merge opens");
  undo = spy("saveMergeHost"); d.querySelector('#mergeModal [data-click="saveMergeHost"]').click(); undo();
  check(one()[0] === "saveMergeHost", "Merge & Delete runs saveMergeHost");
  d.querySelector('#mergeModal [data-click="closeMergeHost"]').click();
  check(!d.getElementById("mergeModal").classList.contains("open"), "Merge Cancel closes it");

  check(!warns.length, `no unknown-action warnings${warns.length ? ": " + warns : ""}`);
  check(errors.length === 0, `no errors after all clicks${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
