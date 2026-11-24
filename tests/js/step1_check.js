// S-15 step 1 fixes: Changes offline/online words, Dependencies button, sub-tab
// highlight stays per page, Escape closes the top window, Edit Service tick boxes.
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
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.TextDecoder = TextDecoder; w.CSS = { escape: s => String(s) };
  const H = { id: 1, ip: "10.9.0.20", hostname: "box", ports: [], aliases: [], services: [], ssh_access: [] };
  const S = [{ id: 7, name: "Demo web", ip: "10.9.0.20", host_id: 1, port: 80, protocol: "tcp", status: "running" },
             { id: 8, name: "Demo db",  ip: "10.9.0.20", host_id: 1, port: 5432, protocol: "tcp", status: "running" }];
  const deps = [];
  w.fetch = async (u, o = {}) => {
    let r = [];
    if (/\/api\/hosts\/10/.test(u)) r = H;
    else if (u.endsWith("/api/hosts")) r = [H];
    else if (/\/api\/services(\?|$)/.test(u)) r = S;
    else if (u.includes("/api/service-dependencies")) {
      if (o.method === "POST") { const b = JSON.parse(o.body); r = { id: deps.length + 1, ...b }; deps.push(r); }
      else r = deps;
    }
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
  };
  w.cytoscape = () => new Proxy({}, { get: () => () => ({}) });
  w.eval(["markdown", "export", "chat", "peek", ...require("./appfiles"), "fitcols", "search"].map(f => fs.readFileSync(`${BOLTARR}/frontend/js/${f}.js`, "utf8")).join("\n;\n"));
  await sleep(200);

  // 1. Changes feed words
  const off = w.changeEventHTML({ type: "host_offline", ip: "10.9.0.20", ts: "2026-11-17T10:00:00Z" });
  const on  = w.changeEventHTML({ type: "host_online",  ip: "10.9.0.20", ts: "2026-11-17T10:05:00Z" });
  check(off.includes("Went offline") && !off.includes("host_offline"), "offline event reads 'Went offline'");
  check(on.includes("Back online") && on.includes("chg-new"), "online event reads 'Back online' (green)");
  const odd = w.changeEventHTML({ type: "some_<b>new", ip: "10.9.0.20", ts: "2026-11-17T10:05:00Z" });
  check(odd.includes("some &lt;b&gt;new"), "an unknown event type is shown in words and escaped");

  // 2. Dependencies button in the service panel
  w.setTab("services"); await sleep(50);
  await w.showSvcDetail(7); await sleep(20);
  const box = d.getElementById("svcDetailDeps");
  check(!box.textContent.includes("Topology view"), "wrong 'Topology view' hint is gone");
  const btn = box.querySelector('[data-click="openManageDeps"]');
  check(!!btn, "service panel has a ⊕ Dependencies button");
  btn.click(); await sleep(5);
  check(d.getElementById("depsModal").classList.contains("open"), "the button opens the Dependencies window");
  d.getElementById("depsAddSelect").value = "8";
  await w.addSvcDep(); await sleep(10);
  check(box.textContent.includes("Demo db"), "panel shows the new dependency straight away");

  // 6. Escape closes the top window
  d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  check(!d.getElementById("depsModal").classList.contains("open"), "Escape closes the Dependencies window");
  w.openEditService(7); await sleep(10);
  check(d.getElementById("serviceModal").classList.contains("open"), "Edit Service open");
  d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  check(!d.getElementById("serviceModal").classList.contains("open"), "Escape closes Edit Service");
  await w.showHostDetail("10.9.0.20"); await sleep(20);
  await w.openEditHost("10.9.0.20"); await sleep(20);
  const em = d.getElementById("editModal");
  if (em.classList.contains("open")) {
    d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    check(!em.classList.contains("open"), "Escape closes Edit Host");
  } else check(false, "could not open Edit Host to test Escape");
  const ev = new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  d.dispatchEvent(ev);
  check(!ev.defaultPrevented, "Escape with no window open does nothing");

  // 4. Edit Service tick boxes use the plain style
  const lab = d.getElementById("svcModalMonitored").closest("label");
  check(lab.classList.contains("form-check"), "Monitor tick box label uses .form-check");

  // 3. sub-tab highlight stays per page
  w.setTab("hosts"); await sleep(20); w.setHostsTab("list");
  w.setTab("services"); await sleep(20); w.setSvcTab("topology"); w.setSvcTab("list");
  check(d.getElementById("hostsTabBtn-list").classList.contains("active"), "Hosts 'List' still highlighted after switching Services sub-tabs");
  check(d.getElementById("scanTabBtn-run").classList.contains("active"), "Scans 'Run' still highlighted");
  check(d.getElementById("svcTabBtn-list").classList.contains("active"), "Services 'List' highlighted");

  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
