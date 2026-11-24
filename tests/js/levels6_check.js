// S-15 step 6: "More options" fold in long forms; device panel SSH tab per level.
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
  const H = { id: 1, ip: "10.9.0.20", hostname: "demo-box", ports: [], aliases: [], services: [], port_count: 1, ...(data.host || {}) };
  const S = { id: 7, name: "Demo web", host_ip: "10.9.0.20", port: 80, protocol: "tcp", status: "running", check_type: "http", url: "http://10.9.0.20", ...(data.svc || {}) };
  w.fetch = async u => {
    let r = [];
    if (u.endsWith("/ssh-access")) r = data.access || [];
    else if (/\/api\/hosts\/10/.test(u)) r = H;
    else if (u.endsWith("/api/hosts")) r = [H];
    else if (u.endsWith("/api/services")) r = [S];
    else if (u.endsWith("/api/subnets")) r = [{ id: 1, name: "Demo LAN", cidr: "10.9.0.0/24" }];
    else if (u.includes("/api/auth/status")) r = { enabled: true };
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
  };
  w.cytoscape = () => new Proxy({}, { get: () => () => ({}) });
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/level.js`, "utf8"));
  w.eval(["markdown", "export", "chat", "peek", ...require("./appfiles"), "fitcols", "search"].map(f => fs.readFileSync(`${BOLTARR}/frontend/js/${f}.js`, "utf8")).join("\n;\n"));
  await sleep(200);
  const $ = s => d.querySelector(s);
  const folded = (modal, id) => !!$(`#${modal} .lvl-fold-body #${id}`);
  const fold = modal => $(`#${modal} .lvl-fold`);
  const open = modal => fold(modal) && !fold(modal).hidden && !fold(modal).querySelector(".lvl-fold-body").hidden;
  return { w, d, $, folded, fold, open };
}

(async () => {
  // Edit Host
  let b = await boot("basic");
  await b.w.openEditHost("10.9.0.20"); await sleep(30);
  check(!b.folded("editModal", "editHostname") && !b.folded("editModal", "editNotes") && !b.folded("editModal", "editMac"), "Basic Edit Host: name, MAC and Notes stay in view");
  check(["editPortCount", "editIsDhcp", "editStaticOverride", "editNoMacAlert", "editNoDhcpWarn", "editPublic", "editTierL1"].every(id => b.folded("editModal", id)),
    "Basic Edit Host: port count, DHCP, static/dynamic, alerts, Public and Gateway are in More options");
  check(!b.fold("editModal").hidden && !b.open("editModal"), "…the fold shows, closed (nothing in it set)");
  const order = [...b.d.querySelectorAll("#editModal .lvl-fold-body input, #editModal .lvl-fold-body select")].map(e => e.id).filter(Boolean);
  check(order.indexOf("editPortCount") < order.indexOf("editTierL1"), "…in their usual order");
  b.fold("editModal").querySelector(".lvl-fold-btn").click();
  check(b.open("editModal") && b.fold("editModal").querySelector("button").getAttribute("aria-expanded") === "true", "clicking More options opens it");
  b.w.setViewLevel("intermediate");
  check(!b.folded("editModal", "editIsDhcp") && !b.folded("editModal", "editTierL1") && b.folded("editModal", "editStaticOverride") && b.folded("editModal", "editNoDhcpWarn"),
    "Intermediate Edit Host: only static/dynamic and DHCP warnings stay folded");
  b.w.setViewLevel("advanced");
  check(b.fold("editModal").hidden && !b.d.querySelector("#editModal .lvl-fold-body").children.length, "Advanced Edit Host: no fold, every field in place");
  const kids = [...b.$("#editModal .modal").children];
  const at = id => kids.findIndex(k => k.querySelector?.("#" + id));
  check(at("editNotes") < at("editPortCount") && at("editStaticOverride") < at("editNoMacAlert") && at("editNoDhcpWarn") < at("editPublic"), "…back in exactly today's order");

  // Fold opens by itself when something in it is set
  b = await boot("basic", { host: { is_dhcp: 1, dhcp_pool: "10.9.0.100-10.9.0.200", tier: 1 } });
  await b.w.openEditHost("10.9.0.20"); await sleep(30);
  check(b.open("editModal"), "Basic Edit Host for a DHCP server / gateway: More options opens by itself");

  // Service window
  b = await boot("basic");
  await b.w.openAddService(); await sleep(30);
  check(["svcName", "svcPort", "svcUrl", "svcDesc", "svcModalMonitored"].every(id => !b.folded("serviceModal", id)), "Basic Service: Name, Port, URL, Description, Monitor in view");
  check(["svcStatus", "svcProto", "svcCheckType", "svcContainerIp", "svcCodes"].every(id => b.folded("serviceModal", id)), "Basic Service: Status, Protocol, check, target IP, replies folded");
  check(!b.open("serviceModal"), "…closed for a new service");
  b.w.closeServiceModal?.();
  b.w.openEditService(7); await sleep(30);
  check(!b.open("serviceModal"), "a monitored service (status set by monitoring) doesn't open the fold");
  b = await boot("intermediate", { svc: { check_type: "tcp", container_ip: "10.9.0.99" } });
  await b.w.loadServicesData?.(); b.w.openEditService(7); await sleep(30);
  check(!b.folded("serviceModal", "svcCheckType") && b.folded("serviceModal", "svcContainerIp") && b.folded("serviceModal", "svcCodes"), "Intermediate Service: only target IP and replies folded");
  check(b.open("serviceModal"), "…and it opens by itself when a target IP is set");

  // Schedule window
  b = await boot("intermediate");
  b.w.openScheduleEditor(null); await sleep(30);
  check(b.folded("scheduleModal", "schedWinStart") && b.folded("scheduleModal", "schedSilent") && !b.folded("scheduleModal", "schedEnabled"), "Schedule: Active window and Silent folded, Enabled in view");
  b.w.setViewLevel("advanced");
  check(b.fold("scheduleModal").hidden && !b.folded("scheduleModal", "schedSilent"), "Advanced Schedule: as today");

  // Device panel SSH tab
  b = await boot("basic");
  await b.w.showHostDetail("10.9.0.20"); await sleep(30);
  const ssh = () => b.$('.detail-tab[data-tab="ssh"]');
  check(b.w.isLevelHidden(ssh()) && ["info", "links", "ports", "services", "changes"].every(t => !b.w.isLevelHidden(b.$(`.detail-tab[data-tab="${t}"]`))),
    "Basic device panel: Info, Links, Ports, Services, Changes; no SSH");
  b.w.setViewLevel("advanced"); b.w.switchDetailTab("ssh"); b.w.setViewLevel("basic");
  check(b.$('.detail-tab[data-tab="info"]').classList.contains("active"), "on SSH, switching to Basic goes back to Info");
  b = await boot("basic", { access: [{ id: 1, ssh_key_id: 1, username: "root" }] });
  await b.w.showHostDetail("10.9.0.20"); await sleep(30);
  check(!b.w.isLevelHidden(ssh()) && ssh().querySelector(".lvl-tag")?.textContent === "Advanced", "Basic: SSH shows for a device with SSH access (asked from the server), tagged");
  b.w.switchDetailTab("ssh"); b.w.markSshTabInUse("10.9.0.20", false);
  check(!b.w.isLevelHidden(ssh()) && !ssh().querySelector(".lvl-tag"), "removing its last SSH access while on the tab keeps you there, tag gone");
  b.w.switchDetailTab("info"); b.w.setViewLevel("intermediate"); b.w.setViewLevel("basic");
  check(b.w.isLevelHidden(ssh()), "…and later the tab is hidden at Basic");

  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
