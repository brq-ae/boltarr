// F-08 split: load index.html with every script as its own <script> (like a browser),
// and check the app boots with no errors and each file's functions work across files.
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
const SVCS = [{ id: 1, name: "Proxmox", ip: "10.9.0.20", port: 8006, status: "up" }];
const vc = new VirtualConsole();
vc.on("jsdomError", e => errors.push(String(e.message || e)));
vc.on("error", e => errors.push(String(e)));
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://x.test/", virtualConsole: vc,
  beforeParse(w) {
    w.TextDecoder = TextDecoder;
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
        : u.includes("/api/graph") ? j({ nodes: [], edges: [] })
        : j(u.includes("config") ? {} : []); };
  } });
const w = dom.window, d = w.document;
(async () => {
  await sleep(600);
  check(errors.length === 0, `no script errors while loading and booting${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  const fns = { core: "setTab", hosts: "renderHostsTable", "host-detail": "showHostDetail", scans: "loadScansTab",
    services: "renderServicesTable", "services-detail": "showSvcDetail", topology: "loadHierarchy",
    settings: "initAiStatus", ssh: "loadSshKeys", boot: "loadLoginState" };
  for (const [f, fn] of Object.entries(fns)) check(typeof w[fn] === "function", `${f}.js: ${fn} defined`);
  w.setTab("hosts"); await sleep(50);
  check(d.querySelectorAll("#hostsTable tbody tr").length === 1, "Hosts table renders from data loaded by core.js");
  w.setTab("services"); await sleep(80);
  check(d.getElementById("panel-services").classList.contains("active"), "Services tab opens");
  w.setTab("scans"); await sleep(50);
  check(d.getElementById("panel-scans").classList.contains("active"), "Scans tab opens");
  w.setTab("hierarchy"); await sleep(50); w.setTab("sshkeys"); await sleep(50);
  const inp = d.getElementById("gsInput"); inp.value = "pve"; inp.dispatchEvent(new w.Event("input"));
  check(d.getElementById("gsResults").textContent.includes("pve-box"), "global search sees app data (shared globals)");
  check(errors.length === 0, `still no errors after switching tabs${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
