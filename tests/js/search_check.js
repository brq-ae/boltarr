// S-04 global search: real app.js + search.js in the full page.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM } = require("jsdom");
const fs = require("fs");
const html = fs.readFileSync(`${BOLTARR}/frontend/index.html`, "utf8");
const body = html.slice(html.indexOf("<body"), html.indexOf("<script src=\"/js/graph.js\""));
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOSTS = [
  { id: 1, ip: "10.9.0.20", hostname: "pve-box", mac: "AA:BB:CC:00:00:01", vendor: "Proxmox Demo Co", device_type: "server", online: 1,
    notes: "rack <b>2</b>", aliases: ["10.9.0.120"], ports: [{ port: 22, service: "ssh", state: "open" }, { port: 3306, service: "mysql", state: "closed" }] },
  { id: 2, ip: "10.9.0.2", hostname: "printer", vendor: "Brother", online: 0, ports: [], aliases: [] },
  { id: 3, ip: "node-7", hostname: "cloud-vps", ports: [], aliases: [] },
  ...Array.from({ length: 12 }, (_, i) => ({ id: 10 + i, ip: `10.9.1.${i + 1}`, hostname: `cam-${i + 1}`, vendor: "DemoCam", ports: [], aliases: [] })),
];
const SVCS = [{ id: 1, name: "Proxmox", ip: "10.9.0.20", hostname: "pve-box", port: 8006, status: "up" },
              { id: 2, name: "Grafana", ip: "10.9.0.2", port: 3000, url: "http://grafana.lan", status: "up" }];
(async () => {
  const dom = new JSDOM(body + "</body>", { runScripts: "outside-only", pretendToBeVisual: true, url: "http://x.test/" });
  const w = dom.window, d = w.document;
  w.TextDecoder = TextDecoder;
  w.matchMedia = q => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.Element.prototype.scrollIntoView = () => {};
  const j = v => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
  w.fetch = async (u) => u.endsWith("/api/hosts") ? j(HOSTS) : u.endsWith("/api/services") ? j(SVCS)
    : /\/api\/hosts\/[^/]+$/.test(u) ? j({ ...HOSTS.find(h => u.endsWith(h.ip)), services: [], ssh_access: [] })
    : j(u.includes("config") || u.includes("settings") || u.includes("auth") ? {} : []);
  w.cytoscape = () => new Proxy({}, { get: () => () => ({}) });
  w.eval(["markdown", "export", "chat", "peek", ...require("./appfiles"), "search"].map(f => fs.readFileSync(`${BOLTARR}/frontend/js/${f}.js`, "utf8")).join("\n;\n")
         + "\nwindow.__run = c => eval(c);");
  await sleep(300);
  w.__run(`allHosts = ${JSON.stringify(HOSTS)}; allServices = ${JSON.stringify(SVCS)};`);
  const inp = d.getElementById("gsInput"), box = d.getElementById("gsResults");
  const type = v => { inp.value = v; inp.dispatchEvent(new w.Event("input")); };
  const key = (k, o = {}, el = inp) => el.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o }));
  const titles = () => [...box.querySelectorAll(".gs-item .gs-title")].map(e => e.textContent.trim());

  type("10.9.0.2");
  check(!box.hidden && titles()[0] === "10.9.0.2 · printer", `exact IP first (${titles()[0]})`);
  check(titles().includes("10.9.0.20 · pve-box"), "prefix IP also listed");
  type("aabbcc"); check(titles()[0] === "10.9.0.20 · pve-box" && /MAC/.test(box.textContent), "MAC without separators finds the host");
  type("aa-bb-cc"); check(titles()[0] === "10.9.0.20 · pve-box", "MAC with dashes too");
  type("10.9.0.120"); check(titles()[0] === "10.9.0.20 · pve-box" && box.textContent.includes("alias"), "alias IP → its host, says 'alias'");
  type("proxmox");
  const groups = [...box.querySelectorAll(".gs-group")].map(g => g.textContent.replace(/\s+/g, " ").trim());
  check(groups.join("|") === "Hosts 1|Services 1", `grouped Hosts + Services (${groups.join("|")})`);
  type("ssh"); check(titles()[0] === "10.9.0.20 · pve-box" && box.textContent.includes("port 22"), "open-port service finds the host");
  type("mysql"); check(box.textContent.includes("No host or service matches"), "closed port service not matched");
  type("rack"); check(box.innerHTML.includes("&lt;b&gt;") && !box.querySelector(".gs-why b b"), "notes shown escaped");
  type("cloud"); check(titles()[0].startsWith("cloud-vps") && titles()[0].includes("no IP"), "host without IP found by name");
  type("8006"); check(titles()[0] === "Proxmox", "service by port");
  type("grafana.lan"); check(titles()[0] === "Grafana", "service by URL");
  type("<img src=x onerror=alert(1)>"); check(!box.querySelector("img") && box.textContent.includes("No host"), "typed HTML stays text");

  // +N more, keyboard
  type("democam");
  check(box.querySelectorAll(".gs-item:not(.gs-more)").length === 8 && box.textContent.includes("+4 more hosts"), "8 per group, then +N more");
  check(box.querySelector(".gs-item.active") === box.querySelector(".gs-item"), "first result highlighted");
  key("ArrowUp"); check(box.querySelector(".gs-item.active")?.classList.contains("gs-all"), "↑ wraps to the last (See all results)");
  check(/See all 12 results/.test(box.textContent), "See all shows the full count");
  key("ArrowUp"); check(box.querySelector(".gs-item.active")?.textContent.includes("+4 more"), "↑ again → +N more");
  w.__run(`classFilterVal = "static"; document.getElementById("classFilter").value = "static";`);
  key("Enter"); await sleep(20);
  check(d.getElementById("panel-hosts").classList.contains("active"), "+N more opens Hosts");
  check(d.getElementById("tableFilter").value === "democam" && d.getElementById("classFilter").value === "", "Hosts filtered by the text, IP filter cleared");
  check(d.getElementById("hostCount").textContent === `12 of ${HOSTS.length}`, `table shows the same 12 (${d.getElementById("hostCount").textContent})`);
  check(box.hidden && inp.value === "", "search closes and clears after picking");

  // Pick a host / a service
  let opened = null; w.__run(`showHostDetail = ip => { window.__opened = "host " + ip; }; showSvcDetail = id => { window.__opened = "svc " + id; };`);
  type("printer"); key("Enter"); check(w.__opened === "host 10.9.0.2", "Enter opens the host panel");
  type("grafana"); box.querySelector(".gs-item").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  check(w.__opened === "svc 2", "click opens the service panel");

  // Shortcuts
  d.body.focus(); key("/", {}, d.body); check(d.activeElement === inp, "/ focuses the search");
  inp.blur();
  const other = d.getElementById("tableFilter"); other.focus(); key("/", {}, other);
  check(d.activeElement === other, "/ ignored while typing in another box");
  key("k", { ctrlKey: true }, other); check(d.activeElement === inp, "Ctrl+K focuses the search");
  type("pve"); key("Escape"); check(box.hidden && inp.value === "pve", "Esc closes the list (text kept)");
  check(inp.getAttribute("aria-expanded") === "false", "aria-expanded follows");

  // Search page
  w.__run(`showHostDetail = ip => { window.__opened = "host " + ip; }; showSvcDetail = id => { window.__opened = "svc " + id; };`);
  type("democam"); key("Enter", { shiftKey: true }); await sleep(10);
  const sp = d.getElementById("spResults");
  check(d.getElementById("panel-search").classList.contains("active"), "Shift+Enter opens the Search page");
  check(d.getElementById("spInput").value === "democam" && inp.value === "" && box.hidden, "query moved to the page, drop-down closed");
  check(sp.querySelectorAll(".gs-item").length === 12, `all 12 hosts listed, no limit (${sp.querySelectorAll(".gs-item").length})`);
  check(d.getElementById("spCount").textContent === "12 hosts · 0 services", `count line (${d.getElementById("spCount").textContent})`);
  check(d.getElementById("topbarTitle").textContent === "Search", "title says Search");
  const spi = d.getElementById("spInput"); spi.value = "proxmox"; spi.dispatchEvent(new w.Event("input"));
  check(sp.querySelectorAll(".sp-group").length === 2 && sp.querySelector(".tag-server"), "typing on the page: hosts + services, type tag shown");
  sp.querySelectorAll(".sp-group")[1].querySelector(".gs-item").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  check(w.__opened === "svc 1", "click a service row opens it");
  const row = sp.querySelector(".gs-item"); row.focus();
  row.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  check(w.__opened === "host 10.9.0.20", "Enter on a focused row opens it");
  spi.value = "<img src=x onerror=alert(1)>"; spi.dispatchEvent(new w.Event("input"));
  check(!sp.querySelector("img") && sp.textContent.includes("No host"), "page: typed HTML stays text");
  spi.value = ""; spi.dispatchEvent(new w.Event("input")); check(sp.textContent.includes("Type to search"), "empty page shows a hint");
  type("printer"); key("ArrowUp"); key("Enter"); await sleep(10);
  check(d.getElementById("spInput").value === "printer" && sp.textContent.includes("10.9.0.2"), "clicking See all opens the page too");
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
