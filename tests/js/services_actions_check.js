// F-08 part B (v0.23.3): the Services page, service panel, service/bulk/deps dialogs use
// data-click/data-change/data-input actions; data-stop keeps row clicks from leaking.
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
const HOSTS = [{ id: 1, ip: "10.9.0.20", hostname: "pve-box", device_type: "server", classification: "static", online: 1, ports: [], aliases: [], dhcp_warnings: [] }];
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
    w.fetch = async u => { u = String(u);
      return u.endsWith("/api/hosts") ? j(HOSTS) : u.endsWith("/api/services") ? j(SVCS)
        : u.includes("/api/dhcp-warnings") ? j({ hosts: {}, pools: [] })
        : u.includes("/api/settings") ? j({ llm: { configured: false } })
        : u.includes("/api/auth/status") ? j({ enabled: false })
        : u.includes("/api/version") ? j({ version: "x" })
        : (u.includes("/api/services/") && !u.includes("public")) ? j({ ...SVCS[0], name: "Proxmox 2" })
        : u.includes("/api/scan-schedules") ? j(SCHED)
        : u.endsWith("/api/scans") ? j(SCANS)
        : u.includes("/api/change-events") ? j(EVS)
        : u.includes("/api/ssh-keys") ? j(KEYS)
        : u.includes("/ssh-access") ? j(ACCESS)
        : u.includes("/api/graph") ? j({ nodes: [], edges: [] })
        : j(u.includes("config") ? {} : []); };
  } });
const w = dom.window, d = w.document;
(async () => {
  await sleep(600);
  check(errors.length === 0, `boots with no errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  const A = w.eval("ACTIONS");
  const names = [...d.querySelectorAll("[data-click],[data-change],[data-input]")].map(el => el.dataset.click || el.dataset.change || el.dataset.input);
  const missing = names.filter(n => typeof A[n] !== "function");
  check(!missing.length, `all ${names.length} actions in the page are registered${missing.length ? ": missing " + missing : ""}`);
  const inl = id => [...d.getElementById(id).querySelectorAll("*")].filter(el => [...el.attributes].some(a => /^on/.test(a.name)));
  check(["panel-services", "serviceModal", "svcDetailPanel", "bulkAddModal", "depsModal"].every(id => !inl(id).length), "no inline handlers in Services areas");
  const calls = [];
  const spy = n => { const o = A[n]; A[n] = function (...a) { calls.push([n, this, ...a]); }; return () => (A[n] = o); };
  const last = () => calls.pop() || [];
  const clickEl = el => el && el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  w.setTab("services"); await sleep(100);
  const tr = d.getElementById("svc-tr-1");
  check(!!tr, "services table renders");

  // Row vs. things inside the row
  let undo = spy("showSvcDetail"); clickEl(tr.querySelector("td:last-child")); undo();
  check(JSON.stringify(last().slice(2)) === "[1]", "clicking the row opens service 1");
  undo = spy("showSvcDetail"); const u2 = spy("svcUpdateBulkBtn");
  const cb = tr.querySelector(".svc-checkbox"); cb.click(); undo(); u2();
  check(calls.length === 1 && calls[0][0] === "svcUpdateBulkBtn", "ticking the row checkbox updates the bulk button and does NOT open the panel"); calls.length = 0;
  undo = spy("showSvcDetail"); const u3 = spy("cycleServiceStatus");
  clickEl(tr.querySelector('[data-click="cycleServiceStatus"]')); undo(); u3();
  check(calls.length === 1 && JSON.stringify(calls[0].slice(2)) === '[1,"up","10.9.0.20"]', "status button cycles (id, status, ip) without opening the panel"); calls.length = 0;
  undo = spy("showSvcDetail"); const link = tr.querySelector("a.svc-url-txt"); const ev = new w.MouseEvent("click", { bubbles: true, cancelable: true });
  link.dispatchEvent(ev); undo();
  check(!calls.length && !ev.defaultPrevented, "URL link opens normally and doesn't open the panel (data-stop)"); calls.length = 0;
  undo = spy("showSvcDetail"); const u4 = spy("svcRowToggleMonitor");
  clickEl(tr.querySelector('[data-click="svcRowToggleMonitor"]')); undo(); u4();
  check(calls.length === 1 && calls[0][0] === "svcRowToggleMonitor", "Monitor toggle runs alone"); calls.length = 0;
  w.eval("var __ef = editSvcField; editSvcField = (id, f, btn) => { window.__ef = [id, f, btn && btn.tagName] }");
  undo = spy("showSvcDetail"); clickEl(tr.querySelector('[data-click="editSvcFieldBtn"][data-args*="url"]')); undo();
  check(!calls.length && JSON.stringify(w.__ef) === '[1,"url","BUTTON"]', "✎ pencil edits the URL field and gets its button (this)");
  w.eval("editSvcField = __ef");
  const all = d.getElementById("svcSelectAll"); all.checked = true; all.dispatchEvent(new w.Event("change", { bubbles: true }));
  check(cb.checked, "select-all ticks the rows (this.checked passed)");

  // Sub-tabs
  d.querySelector('#panel-services [data-click="setSvcTab"][data-args=\'["topology"]\']').click(); await sleep(50);
  d.querySelector('#panel-services [data-click="setSvcTab"][data-args=\'["list"]\']').click(); await sleep(50);
  check(errors.length === 0, "List / Topology sub-tabs switch");

  // Service panel
  await w.showSvcDetail(1); await sleep(60);
  check(d.getElementById("svcDetailPanel").classList.contains("open"), "service panel opens");
  w.eval("var __oeFn = openEditService; openEditService = id => { window.__oe = id }");
  d.querySelector('[data-click="editSvcDetail"]').click();
  check(w.__oe === 1, "✎ Edit in the panel opens the editor for this service");
  w.eval("openEditService = __oeFn");
  w.alert = m => errors.push("alert: " + m);
  d.getElementById("svcDetailName").value = "Proxmox 2";
  d.querySelector('#svcDetailPanel [data-click="saveSvcDetail"]').click(); await sleep(80);
  check(!errors.some(e => e.startsWith("alert")), `Save in the panel works${errors.length ? ": " + errors.slice(-1) : ""}`);
  d.querySelector('#svcDetailPanel [data-click="hideSvcDetail"]').click(); await sleep(20);
  check(!d.getElementById("svcDetailPanel").classList.contains("open"), "× closes the panel");

  // Add/edit dialog
  w.openAddService(); await sleep(50);
  check(d.getElementById("serviceModal").classList.contains("open"), "+ Service opens the dialog");
  const port = d.getElementById("svcPort");
  check(d.getElementById("svcCheckType").value === "http" && !port.disabled, "new service: HTTP check, and the Port field can be typed in");
  port.value = "8080"; port.dispatchEvent(new w.Event("input", { bubbles: true }));
  check(d.getElementById("svcUrl").value === "http://10.9.0.20:8080", "typing port 8080 fills the URL in");
  const mon = d.getElementById("svcModalMonitored"), st = d.getElementById("svcStatus");
  check(!st.disabled && d.getElementById("svcStatusAuto").hidden, "Status can be picked while not monitored");
  mon.checked = true; mon.dispatchEvent(new w.Event("change", { bubbles: true }));
  check(st.disabled && !d.getElementById("svcStatusAuto").hidden, "ticking Monitor locks Status ('set automatically')");
  mon.checked = false; mon.dispatchEvent(new w.Event("change", { bubbles: true }));
  const url = d.getElementById("svcUrl"); url.dataset.auto = "http://x"; url.value = "http://mine";
  url.dispatchEvent(new w.Event("input", { bubbles: true }));
  check(url.dataset.auto === "", "typing your own URL stops the auto-fill");
  undo = spy("autoFillSvcUrlModal"); d.getElementById("svcPort").dispatchEvent(new w.Event("input", { bubbles: true })); undo();
  check(last()[0] === "autoFillSvcUrlModal", "port typing auto-fills the URL");
  d.querySelector('#serviceModal [data-click="closeServiceModal"]').click();
  check(!d.getElementById("serviceModal").classList.contains("open"), "Cancel closes the dialog");

  w.openEditService(1); await sleep(60);
  d.getElementById("svcName").value = "Proxmox 3";
  d.querySelector('#serviceModal [data-click="saveServiceModal"]').click(); await sleep(80);
  check(!errors.some(e => e.startsWith("alert")) && !d.getElementById("serviceModal").classList.contains("open"),
    `Save in the edit dialog works${errors.length ? ": " + errors.slice(-1) : ""}`);
  // Bulk add
  d.getElementById("bulkAddModal").classList.add("open");
  d.querySelector('[data-click="closeBulkAdd"]').click();
  check(!d.getElementById("bulkAddModal").classList.contains("open"), "Bulk add Cancel closes it");

  // Card list (host panel Services tab) kebab menu
  const box = d.createElement("div"); box.innerHTML = w.svcRowHTML(SVCS[0], "10.9.0.20"); d.body.append(box);
  box.querySelector('[data-click="toggleSvcMenu"]').click();
  check(d.getElementById("svcmenu-r1").classList.contains("open"), "⋮ opens the service menu");
  w.eval("var __dl = deleteSvc; deleteSvc = (id, ip) => { window.__dl = [id, ip] }");
  box.querySelector('[data-click="svcMenuDelete"]').click();
  check(JSON.stringify(w.__dl) === '[1,"10.9.0.20"]' && !d.getElementById("svcmenu-r1").classList.contains("open"), "menu Delete closes the menu and deletes service 1 on 10.9.0.20");
  w.eval("deleteSvc = __dl");

  // URL follows port changes: in the list, the panel and the edit dialog (own URLs are never touched)
  const puts = []; const realFetch = w.fetch;
  w.fetch = (u, o) => { if (o && o.method === "PUT") puts.push(JSON.parse(o.body)); return realFetch(u, o); };
  const typeIn = (id, v) => { const el = d.getElementById(id); el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); };
  await w.showSvcDetail(1); await sleep(60);
  typeIn("svcDetailPort", "9000");
  check(d.getElementById("svcDetailUrl").value === "http://10.9.0.20:9000", "panel: changing the port updates a Boltarr-built URL");
  typeIn("svcDetailUrl", "https://pve.lan/"); typeIn("svcDetailPort", "9001");
  check(d.getElementById("svcDetailUrl").value === "https://pve.lan/", "panel: a URL you typed stays as it is");
  d.querySelector('#svcDetailPanel [data-click="hideSvcDetail"]').click();
  w.openEditService(1); await sleep(50);
  check(!d.getElementById("svcPort").disabled, "edit dialog: Port can be typed in");
  typeIn("svcPort", "443");
  check(d.getElementById("svcUrl").value === "https://10.9.0.20:443", "edit dialog: changing the port updates a Boltarr-built URL (443 → https)");
  w.closeServiceModal();
  const inlinePort = async (port, setup) => {
    w.eval(`(${setup})(allServices.find(s => s.id === 1))`); w.renderServicesTable(); puts.length = 0;
    clickEl(d.querySelector('#svc-tr-1 [data-click="editSvcPortProtoBtn"]'));
    const pin = d.querySelector("#svc-tr-1 .type-edit input");
    pin.value = String(port); pin.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(60);
    return puts[0] || {};
  };
  let body = await inlinePort(9100, 's => { s.url = "http://10.9.0.20:8006"; s.port = 8006; s.check_type = null; }');
  check(body.port === 9100 && body.url === "http://10.9.0.20:9100", "list: inline port change also updates a Boltarr-built URL");
  body = await inlinePort(9200, 's => { s.url = "https://pve.lan/"; s.port = 9100; }');
  check(body.port === 9200 && !("url" in body), "list: a URL you typed stays as it is");
  body = await inlinePort(8080, 's => { s.url = null; s.check_type = "http"; }');
  check(body.url === "http://10.9.0.20:8080", "list: an empty URL on a web check gets filled in");
  body = await inlinePort(22, 's => { s.url = null; s.check_type = "tcp"; }');
  check(body.port === 22 && !("url" in body), "list: a TCP check with no URL doesn't get one");
  w.fetch = realFetch;

  check(!warns.length, `no unknown-action warnings${warns.length ? ": " + warns : ""}`);
  check(errors.length === 0, `no errors after all clicks${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
