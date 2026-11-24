// S-15 step 5: table columns per level; your own Columns ▾ choices win at every level.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM } = require("jsdom");
const fs = require("fs");
const html = fs.readFileSync(`${BOLTARR}/frontend/index.html`, "utf8");
const body = html.slice(html.indexOf("<body"), html.indexOf("<script src=\"/js/graph.js\""));
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function boot(level, data = {}, store = {}) {
  const dom = new JSDOM(body + "</body>", { runScripts: "outside-only", pretendToBeVisual: true, url: "http://x.test/" });
  const w = dom.window, d = w.document;
  w.TextDecoder = TextDecoder; w.CSS = { escape: s => String(s) };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.localStorage.setItem("boltarr.viewLevel", level);
  for (const [k, v] of Object.entries(store)) w.localStorage.setItem(k, JSON.stringify(v));
  const D = { hosts: [{ id: 1, ip: "10.9.0.20", hostname: "demo-box", ports: [], aliases: [] }],
              services: [{ id: 7, name: "Demo web", host_ip: "10.9.0.20", port: 80, status: "up" }], ...data };
  w.fetch = async u => {
    let r = [];
    if (u.endsWith("/api/hosts")) r = D.hosts;
    else if (u.endsWith("/api/services")) r = D.services;
    else if (u.includes("/api/auth/status")) r = { enabled: true };
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
  };
  w.cytoscape = () => new Proxy({}, { get: () => () => ({}) });
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/level.js`, "utf8"));
  w.eval(["markdown", "export", "chat", "peek", ...require("./appfiles"), "fitcols", "search"].map(f => fs.readFileSync(`${BOLTARR}/frontend/js/${f}.js`, "utf8")).join("\n;\n"));
  await sleep(200);
  const ht = d.getElementById("hostsTable"), st = d.getElementById("servicesTable");
  const hid = (t, pre, ks) => ks.filter(k => t.classList.contains(pre + k));
  const menuOrder = id => [...d.getElementById(id).children].map(n => n.matches(".col-menu-head") ? "|" : n.querySelector("input").dataset.col).join(",");
  const ticked = (id, k) => d.querySelector(`#${id} input[data-col="${k}"]`).checked;
  const tick = (id, k, on) => { const cb = d.querySelector(`#${id} input[data-col="${k}"]`); cb.checked = on; cb.dispatchEvent(new w.Event("change", { bubbles: true })); };
  const H = ["host", "mac", "vendor", "type", "os", "ports", "seen", "notes"], S = ["icon", "desc", "host", "ps", "mon", "pub", "url"];
  return { w, d, D, hh: () => hid(ht, "hide-", H).join(","), sh: () => hid(st, "hide-svc-", S).join(","), menuOrder, ticked, tick };
}

(async () => {
  // Basic, a new browser
  let b = await boot("basic");
  check(b.hh() === "mac,os,ports,notes", `Basic Hosts: MAC, OS, Ports, Notes hidden (${b.hh()})`);
  check(b.sh() === "desc", `Basic Services: only the description line hidden (${b.sh()})`);
  check(b.menuOrder("colMenu") === "host,vendor,type,seen,|,mac,os,ports,notes", `Basic Columns ▾: hidden ones under a heading (${b.menuOrder("colMenu")})`);
  check(b.d.querySelector("#colMenu .col-menu-head").textContent === "More at Intermediate", "…the heading says More at Intermediate");
  check(!b.ticked("colMenu", "ports") && b.ticked("colMenu", "vendor"), "…unticked under it, ticked above");
  check(b.menuOrder("svcColMenu") === "icon,host,ps,mon,pub,url,|,desc", `Basic Services Columns ▾ (${b.menuOrder("svcColMenu")})`);

  b.w.setViewLevel("intermediate");
  check(b.hh() === "" && b.sh() === "", "Intermediate: every column shows");
  check(b.menuOrder("colMenu") === "host,mac,vendor,type,os,ports,seen,notes" && !b.d.querySelector(".col-menu-head"), "Intermediate: Columns ▾ back in its usual order, no heading");
  b.w.setViewLevel("advanced");
  check(b.hh() === "" && b.sh() === "" && b.ticked("colMenu", "mac"), "Advanced: every column shows, all ticked");

  // Your choices win (one set for all levels)
  b.w.setViewLevel("basic");
  b.tick("colMenu", "ports", true);
  check(b.hh() === "mac,os,notes" && b.ticked("colMenu", "ports"), "Basic: ticking Ports shows it straight away");
  check(b.menuOrder("colMenu").endsWith("|,mac,os,ports,notes"), "…it stays listed under the heading (ticked)");
  b.w.setViewLevel("advanced"); b.w.setViewLevel("basic");
  check(b.hh() === "mac,os,notes", "…and is still on after switching levels and back");
  b.w.setViewLevel("advanced");
  b.tick("colMenu", "vendor", false);
  check(b.hh() === "vendor", "Advanced: unticking Vendor hides it");
  b.w.setViewLevel("basic");
  check(b.hh() === "mac,vendor,os,notes" && !b.ticked("colMenu", "vendor"), "…and it stays off at Basic too");
  b.w.setViewLevel("advanced"); b.tick("colMenu", "ports", false); b.tick("colMenu", "ports", true);
  b.w.setViewLevel("basic");
  check(b.hh().includes("ports"), "untick + re-tick at Advanced (undoing) leaves Basic's default alone");

  // Upgraders: an old hidden list means exactly today at Advanced
  b = await boot("advanced", {}, { "boltarr.hostsHiddenCols": ["mac", "notes"], "boltarr.svcHiddenCols": ["icon"] });
  check(b.hh() === "mac,notes" && b.sh() === "icon", "Advanced: an existing Columns setup is exactly as before");
  check(!b.ticked("colMenu", "mac") && b.ticked("colMenu", "os"), "…ticks match");

  // In use: a note / a description shows its column at Basic, tagged
  b = await boot("basic", { hosts: [{ id: 1, ip: "10.9.0.20", hostname: "demo-box", notes: "Demo note", ports: [], aliases: [] }],
                            services: [{ id: 7, name: "Demo web", description: "Demo site", port: 80, status: "up" }] });
  b.w.setTab("hosts"); b.w.renderHostsTable(); b.w.renderServicesTable(); await sleep(20);
  check(b.hh() === "mac,os,ports", `Basic: Notes shows once a device has a note (${b.hh()})`);
  check(b.sh() === "", "Basic: the description line shows once a service has one");
  const tag = b.d.querySelector('#colMenu input[data-col="notes"]').parentElement.querySelector(".lvl-tag");
  check(tag && tag.textContent === "Intermediate" && !b.menuOrder("colMenu").endsWith("notes"), "…Notes is ticked above the heading, with the grey tag");
  b.D.hosts[0].notes = ""; await b.w.loadHosts(); b.w.renderHostsTable();
  check(b.hh() === "mac,os,ports,notes", "removing the last note hides Notes again at Basic");
  b.w.setViewLevel("intermediate");
  check(!b.d.querySelector("#colMenu .lvl-tag"), "no tag at Intermediate");

  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
