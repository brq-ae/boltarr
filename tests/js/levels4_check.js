// S-15 step 4: buttons and toolbars per level, the ⋯ menu, and Run's safety rule.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM } = require("jsdom");
const fs = require("fs");
const html = fs.readFileSync(`${BOLTARR}/frontend/index.html`, "utf8");
const body = html.slice(html.indexOf("<body"), html.indexOf("<script src=\"/js/graph.js\""));
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function boot(level, data = {}) {
  const dom = new JSDOM(body + "</body>", { runScripts: "outside-only", pretendToBeVisual: true, url: "http://x.test/" });
  const w = dom.window, d = w.document;
  w.TextDecoder = TextDecoder; w.CSS = { escape: s => String(s) };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.localStorage.setItem("boltarr.viewLevel", level);
  const D = { vlans: [], windows: [], posted: [], ...data };
  const H = { id: 1, ip: "10.9.0.20", hostname: "demo-box", ports: [], aliases: [], services: [], ssh_access: [] };
  const profiles = [{ id: 1, name: "Standard", builtin: 1, options: { ports: "top1000", sv: true, os: false, timing: "T3", host_timeout: 15 } }];
  w.fetch = async (u, o = {}) => {
    let r = [];
    if (u.includes("/api/vlans")) r = D.vlans;
    else if (u.includes("/api/maintenance-windows")) r = { windows: D.windows };
    else if (u.includes("/api/scan-profiles")) r = profiles;
    else if (u.endsWith("/api/subnets")) r = [{ id: 1, name: "Demo LAN", cidr: "10.9.0.0/24" }];
    else if (/\/api\/scan\/1$/.test(u) && o.method === "POST") { D.posted.push(JSON.parse(o.body)); r = { run_id: 5 }; }
    else if (u.endsWith("/api/scans")) r = [{ id: 5, subnet_id: 1, cidr: "10.9.0.0/24", status: "completed", started_at: "2026-11-18T10:00:00Z", finished_at: "2026-11-18T10:01:00Z", hosts_found: 3 }];
    else if (/\/api\/hosts\/10/.test(u)) r = H;
    else if (u.endsWith("/api/hosts")) r = [H];
    else if (u.includes("/api/auth/status")) r = { enabled: true };
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
  };
  w.cytoscape = () => new Proxy({}, { get: () => () => ({}) });
  w.downloadFile = () => {}; w.exported = [];
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/level.js`, "utf8"));
  w.eval(["markdown", "export", "chat", "peek", ...require("./appfiles"), "fitcols", "search"].map(f => fs.readFileSync(`${BOLTARR}/frontend/js/${f}.js`, "utf8")).join("\n;\n"));
  w.URL.createObjectURL = blob => { w.exported.push(blob.type); return "blob:demo"; };
  w.URL.revokeObjectURL = () => {};
  await sleep(200);
  return { w, d, D, hidden: e => !!e && w.isLevelHidden(e), $: s => d.querySelector(s) };
}
const moreOf = (w, sel) => w.document.querySelector(sel).parentElement.querySelector(":scope > .more-wrap");

(async () => {
  let { w, d, D, hidden, $ } = await boot("basic");
  // Topology
  check(!hidden($("#connectBtn")) && !hidden($("#saveLayoutBtn")), "Basic: ◎ Link and Save Layout show");
  check(hidden($("#multiConnBtn")) && hidden($("#vlanBtn")), "Basic: Multi-Link and VLANs hidden (no VLANs)");
  // Services
  check(hidden($("#svcMaintBtn")) && hidden($('[data-click="openBulkAddContainers"]')), "Basic: Maintenance (none planned) and Bulk hidden");
  check(!hidden($('[data-click="openAddService"]')) && !hidden($("#svcColMenuBtn")), "Basic: + Service and Columns show");
  // Scans
  check(hidden($("#scanPorts")) && hidden($("#scanSv")) && hidden($("#scanTiming")), "Basic: Run hides Ports, Options, Timing");
  check(hidden($("#scanHostTimeout")) && hidden($("#scanScripts")) && hidden($("#scanPreview")) && hidden($('[data-click="saveScanProfile"]')),
    "Basic: Run hides time limit, NSE scripts, command preview, Save as profile");
  check(!hidden($("#scanTarget")) && !hidden($("#scanProfile")) && !hidden($("#scanRunBtn")), "Basic: Target, Profile and Run scan show");
  check(hidden($('[data-click="clearChanges"]')), "Basic: Changes' Clear all hidden");

  // Run safety: hidden fields carry old values; Basic sends the profile's own
  w.setTab("scans"); await sleep(20);
  d.getElementById("scanTarget").value = "1";
  d.getElementById("scanProfile").value = "1"; w.applyScanProfile();
  d.getElementById("scanPorts").value = "all"; d.getElementById("scanUdp").checked = true;
  d.getElementById("scanTiming").value = "T0"; d.getElementById("scanScripts").value = "demo-script";
  d.getElementById("scanHostTimeout").value = "0";
  await w.runScanFromBuilder(); await sleep(30);
  let p = D.posted.pop() || {};
  check(p.ports === "top1000" && p.udp === false && p.timing === "T3" && p.scripts === "" && p.host_timeout === 15 && p.os === false,
    `Basic: a scan uses the profile's settings, not hidden leftovers (${JSON.stringify(p)})`);
  w.setViewLevel("intermediate"); w.setScanTab("run");
  d.getElementById("scanPorts").value = "all"; d.getElementById("scanTiming").value = "T2";
  await w.runScanFromBuilder(); await sleep(30);
  p = D.posted.pop() || {};
  check(p.ports === "all" && p.timing === "T2" && p.scripts === "" && p.host_timeout === 15,
    "Intermediate: Ports/Timing you set are used; hidden time limit and scripts come from the profile");
  w.setViewLevel("advanced");
  await w.runScanFromBuilder(); await sleep(30);
  p = D.posted.pop() || {};
  check(p.scripts === "demo-script" && p.host_timeout === 0, "Advanced: every field is used exactly as today");

  // Scan Log
  w.setViewLevel("basic"); w.setScanTab("history"); await sleep(30);
  check(hidden($("#scansWrap .scans-toolbar")) && hidden($(".scan-checkbox")), "Basic: Scan Log has no select / Delete selected");
  check(hidden($('#scansWrap [data-click="deleteScanRun"]')), "Basic: Scan Log is view only (no ✕)");
  w.setViewLevel("intermediate");
  check(!hidden($('#scansWrap [data-click="deleteScanRun"]')) && hidden($(".scan-checkbox")), "Intermediate: ✕ per run shows; bulk select still hidden");
  check(!hidden($('[data-click="clearChanges"]')) && !hidden($("#svcMaintBtn")) && !hidden($('[data-click="openBulkAddContainers"]')),
    "Intermediate: Clear all, Maintenance and Bulk show");
  check(hidden($("#multiConnBtn")) && hidden($("#vlanBtn")), "Intermediate: Multi-Link and VLANs still hidden");
  w.setViewLevel("advanced");
  check(!hidden($(".scan-checkbox")) && !hidden($("#scansWrap .scans-toolbar")) && !hidden($("#multiConnBtn")) && !hidden($("#vlanBtn")),
    "Advanced: everything shows");

  // ⋯ menu (Hosts)
  w.setViewLevel("basic"); w.setTab("hosts"); await sleep(20);
  const wrap = moreOf(w, '#hosts-panel-list .export-wrap');
  check(!!wrap, "Hosts toolbar has a ⋯ menu");
  wrap.querySelector(".more-btn").click();
  const items = [...wrap.querySelectorAll(".col-menu button")].map(b => b.textContent);
  check(wrap.querySelector(".col-menu").classList.contains("open") && items.join("|") === "⤓ Export CSV|⤓ Export JSON", `⋯ lists Export CSV and JSON (${items.join(", ")})`);
  wrap.querySelectorAll(".col-menu button")[1].click(); await sleep(10);
  check(String(w.exported.pop()).startsWith("application/json") && !wrap.querySelector(".col-menu").classList.contains("open"), "⋯ → Export JSON exports and closes the menu");
  wrap.querySelector(".more-btn").click(); d.body.click();
  check(!wrap.querySelector(".col-menu").classList.contains("open"), "a click elsewhere closes ⋯");

  // Host panel: Delete in ⋯, Probe / Merge / Reset uptime per level
  await w.showHostDetail("10.9.0.20"); await sleep(30);
  const hp = d.querySelector('.detail-header-right');
  check(hidden(hp.querySelector('[data-click="probeHost"]')) && hidden(hp.querySelector("#probeProfile")) && hidden(hp.querySelector('[data-click="openMergeHost"]')),
    "Basic host panel: Probe and Merge hidden");
  check(!hidden(hp.querySelector('[data-click="openEditHost"]')), "Basic host panel: Edit shows");
  hp.querySelector(".more-btn").click();
  const del = hp.querySelector(".more-wrap .col-menu button");
  check(del && del.textContent === "Delete host" && del.classList.contains("more-danger"), "Basic host panel: Delete host is in ⋯ (in red)");
  let asked = null; w.confirm = m => { asked = m; return false; };
  del.click(); await sleep(10);
  check(asked !== null, "⋯ → Delete host runs the real Delete (asks first)");
  w.setViewLevel("intermediate");
  check(!hidden(hp.querySelector('[data-click="probeHost"]')) && hidden(hp.querySelector('[data-click="openMergeHost"]')), "Intermediate host panel: Probe shows, Merge hidden");

  // In use: VLANs and maintenance windows
  ({ w, d, D, hidden, $ } = await boot("basic", { vlans: [{ id: 1, tag: 10, name: "Demo", color: "#888" }], windows: [{ id: 1, state: "planned" }] }));
  check(!hidden($("#vlanBtn")) && $("#vlanBtn .lvl-tag")?.textContent === "Advanced", "Basic: VLANs shows once a VLAN exists, tagged");
  check(!hidden($("#svcMaintBtn")) && $("#svcMaintBtn .lvl-tag")?.textContent === "Intermediate", "Basic: Maintenance shows while a window is planned, tagged");
  ({ w, d, D, hidden, $ } = await boot("basic", { windows: [{ id: 1, state: "done" }] }));
  check(hidden($("#svcMaintBtn")), "Basic: only finished windows → Maintenance stays hidden");

  // Advanced: no ⋯ anywhere, all rare buttons in place
  ({ w, d, D, hidden, $ } = await boot("advanced"));
  check([...d.querySelectorAll("[data-more]")].every(e => !hidden(e)), "Advanced: rare buttons stay in their toolbars (⋯ is hidden there by CSS)");

  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
