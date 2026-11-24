// S-15 step 3: which pages and sub-tabs show at each level, "in use", and one-visit opens.
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
  const D = { keys: [], schedules: [], deps: [], subnets: [], ...data };
  w.fetch = async (u, o = {}) => {
    let r = [];
    if (u.includes("/api/ssh-keys")) r = D.keys;
    else if (/\/api\/scan-schedules\/\d+/.test(u) && o.method === "DELETE") { D.schedules = []; r = {}; }
    else if (u.includes("/api/scan-schedules")) r = D.schedules;
    else if (u.includes("/api/service-dependencies")) r = D.deps;
    else if (u.endsWith("/api/subnets")) r = D.subnets;
    else if (u.includes("/api/auth/status")) r = { enabled: true };
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
  };
  w.cytoscape = () => new Proxy({}, { get: () => () => ({}) });
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/level.js`, "utf8"));
  w.eval(["markdown", "export", "chat", "peek", ...require("./appfiles"), "fitcols", "search"].map(f => fs.readFileSync(`${BOLTARR}/frontend/js/${f}.js`, "utf8")).join("\n;\n"));
  await sleep(150);
  const $ = sel => d.querySelector(sel);
  const el = {
    hier:   $('#panel-topology .svc-subtab[data-args=\'["hierarchy"]\']'),
    hier2:  $('#panel-hierarchy .svc-subtab[data-args=\'["hierarchy"]\']'),
    svcTop: $("#svcTabBtn-topology"), iph: $("#hostsTabBtn-iphistory"),
    sched:  $("#scanTabBtn-schedules"), ssh: $('.sidebar-nav-item[data-tab="sshkeys"]'),
    always: ["#svcTabBtn-list", "#hostsTabBtn-list", "#scanTabBtn-run", "#scanTabBtn-history", "#scanTabBtn-changes",
             '.sidebar-nav-item[data-tab="topology"]', '.sidebar-nav-item[data-tab="services"]', '.sidebar-nav-item[data-tab="hosts"]',
             '.sidebar-nav-item[data-tab="subnets"]', '.sidebar-nav-item[data-tab="scans"]', '.sidebar-nav-item[data-tab="settings"]'].map($),
  };
  const hidden = e => w.isLevelHidden(e);
  const tag = e => e.querySelector(".lvl-tag")?.textContent || "";
  return { w, d, el, hidden, tag };
}

(async () => {
  // Basic, nothing in use
  let { w, d, el, hidden, tag } = await boot("basic");
  check(el.always.every(e => !hidden(e)), "Basic: Topology, Services, Hosts, Subnets, Scans (Run, Scan Log, Changes) and Settings show");
  check(hidden(el.hier) && hidden(el.hier2), "Basic: Hierarchy hidden");
  check(hidden(el.svcTop), "Basic: Services → Topology hidden (no dependencies)");
  check(hidden(el.iph), "Basic: IP History hidden");
  check(hidden(el.sched), "Basic: Schedules hidden (no schedules)");
  check(hidden(el.ssh), "Basic: SSH Keys hidden (no keys)");
  check(el.hier.parentElement.classList.contains("lvl-onetab"), "Basic: the Graph/Hierarchy bar with one tab left is hidden");
  check(d.querySelector("#panel-hosts .svc-toolbar").classList.contains("lvl-emptybar"), "Basic: the empty Hosts tab strip is hidden");
  check(!d.querySelector("#panel-scans .svc-subtabs").classList.contains("lvl-onetab"), "Basic: the Scans tab bar still shows");

  // the level-change switch
  w.setViewLevel("intermediate");
  check(!hidden(el.hier) && !hidden(el.svcTop) && !hidden(el.sched), "Intermediate: Hierarchy, Services → Topology and Schedules show");
  check(hidden(el.iph) && hidden(el.ssh), "Intermediate: IP History (no DHCP range) and SSH Keys hidden");
  check(!el.hier.parentElement.classList.contains("lvl-onetab") && d.querySelector("#panel-hosts .svc-toolbar").classList.contains("lvl-emptybar"),
    "Intermediate: the Graph/Hierarchy bar shows again; the Hosts strip stays hidden until a second tab shows");
  w.setViewLevel("advanced");
  check([el.hier, el.hier2, el.svcTop, el.iph, el.sched, el.ssh, ...el.always].every(e => !hidden(e)), "Advanced: everything shows");
  check(!d.querySelector(".lvl-onetab, .lvl-emptybar"), "Advanced: no bar is hidden");
  check(!d.querySelector(".lvl-tag"), "Advanced: no grey tags (nothing is in use)");

  // Openings from elsewhere and fallbacks
  w.setViewLevel("advanced"); w.setTab("hierarchy"); await sleep(10);
  w.setViewLevel("basic"); await sleep(10);
  check(d.getElementById("panel-topology").classList.contains("active"), "on Hierarchy, switching to Basic lands on the Graph");
  w.setViewLevel("advanced"); w.setTab("hierarchy"); await sleep(10); w.setTab("hosts"); await sleep(10);
  w.setViewLevel("basic"); await sleep(10);
  check(d.getElementById("panel-hosts").classList.contains("active"), "changing level on Hosts stays on Hosts (after an earlier visit to Hierarchy)");
  w.setViewLevel("advanced"); await sleep(10);
  check(d.getElementById("panel-hosts").classList.contains("active"), "…and back to Advanced stays too");
  w.setViewLevel("basic");
  w.openTopology(); await sleep(10);
  check(d.getElementById("panel-topology").classList.contains("active"), "Topology button at Basic opens the Graph, not a hidden Hierarchy");
  w.setTab("hosts"); w.setHostsTab("iphistory"); await sleep(10);
  check(d.getElementById("hosts-panel-iphistory").style.display !== "none" && !hidden(el.iph) && el.iph.classList.contains("lvl-visit"),
    "a link to IP History at Basic opens it for that visit, its tab shown");
  check(!d.querySelector("#panel-hosts .svc-toolbar").classList.contains("lvl-emptybar"), "…with the Hosts tab strip back");
  w.setHostsTab("list");
  check(hidden(el.iph) && d.querySelector("#panel-hosts .svc-toolbar").classList.contains("lvl-emptybar"), "picking List ends the visit");
  w.setTab("sshkeys"); await sleep(10);
  check(!hidden(el.ssh) && d.getElementById("panel-sshkeys").classList.contains("active"), "opening SSH Keys from elsewhere shows it for the visit");
  w.setTab("hosts"); await sleep(10);
  check(hidden(el.ssh), "…and leaving ends the visit");
  w.setTab("hosts"); w.setHostsTab("iphistory"); w.setViewLevel("intermediate"); await sleep(10);
  check(d.getElementById("hostsTabBtn-list").classList.contains("active") && hidden(el.iph), "changing level ends a visit (back to a tab that shows)");

  // In use, Basic
  ({ w, d, el, hidden, tag } = await boot("basic", {
    keys: [{ id: 1, name: "demo-key", public_key: "ssh-ed25519 AAAA demo", fingerprint: "SHA256:demo" }],
    schedules: [{ id: 3, name: "Demo nightly", enabled: 0, cron: "0 3 * * *", target: "10.9.0.0/24", host_filter: "all", profile_id: null }],
    deps: [{ id: 1, from_service_id: 7, to_service_id: 8 }],
    subnets: [{ id: 1, name: "Demo LAN", cidr: "10.9.0.0/24", dhcp_start: "10.9.0.100", dhcp_end: "10.9.0.200" }],
  }));
  check(!hidden(el.ssh) && tag(el.ssh) === "Advanced", "Basic: SSH Keys shows once a key exists, tagged Advanced");
  check(!hidden(el.sched) && tag(el.sched) === "Intermediate", "Basic: Schedules shows once a schedule exists, tagged Intermediate");
  check(!hidden(el.svcTop) && tag(el.svcTop) === "Intermediate", "Basic: Services → Topology shows once a dependency exists, tagged");
  check(hidden(el.iph), "Basic: IP History stays hidden even with a DHCP range");
  check(d.querySelector("#panel-hosts .svc-toolbar").classList.contains("lvl-emptybar"), "Basic: Hosts strip still hidden");
  check(hidden(el.hier), "Basic: Hierarchy still hidden (no in-use rule)");
  w.setViewLevel("intermediate");
  check(!hidden(el.iph) && tag(el.iph) === "Advanced", "Intermediate: IP History shows once a subnet has a DHCP range, tagged Advanced");
  check(el.iph.getAttribute("data-lvl") === "i" && el.iph.dataset.lvlOwn === "a", "…by counting it as Intermediate while in use");
  w.setViewLevel("basic");

  // removing the last schedule while looking at it: stay on it
  w.setTab("scans"); await sleep(10); w.setScanTab("schedules"); await sleep(20);
  w.levelInUse("schedules", false);
  check(!hidden(el.sched) && el.sched.classList.contains("lvl-visit") && !tag(el.sched), "removing the last schedule while on it keeps you there, tag gone");
  w.setScanTab("run");
  check(hidden(el.sched), "…and leaving hides Schedules");
  w.levelInUse("sshkeys", false);
  check(hidden(el.ssh) && !tag(el.ssh), "removing the last key hides SSH Keys at Basic");
  w.levelInUse("dhcp", false); w.setViewLevel("intermediate");
  check(hidden(el.iph) && el.iph.getAttribute("data-lvl") === "a", "removing the DHCP range puts IP History back to Advanced");

  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
