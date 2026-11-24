// DHCP warnings in the UI: row badge, filter, pool chip, host panel box + ignore button.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM } = require("jsdom");
const fs = require("fs");
const html = fs.readFileSync(`${BOLTARR}/frontend/index.html`, "utf8");
const body = html.slice(html.indexOf("<body"), html.indexOf("<script src=\"/js/graph.js\""));
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const W = [{ code: "infra_in_pool", text: "Important device (switch) on a DHCP pool address (10.9.0.100–10.9.0.199). <b>x</b>" }];
let HOSTS = [
  { id: 1, ip: "10.9.0.101", hostname: "core-sw", device_type: "switch", classification: "dynamic", ports: [], aliases: [], dhcp_warnings: W },
  { id: 2, ip: "10.9.0.150", hostname: "phone", classification: "dynamic", ports: [], aliases: [], dhcp_warnings: [] },
  { id: 3, ip: "10.9.0.5", hostname: "srv", classification: "static", ports: [], aliases: [], dhcp_warnings: [] },
];
const POOLS = [{ subnet_id: 1, pct: 93, text: "DHCP pool on Lab is 93% full (93 of 100 addresses seen in the last 7 days)." }];
const puts = [];
(async () => {
  const dom = new JSDOM(body + "</body>", { runScripts: "outside-only", pretendToBeVisual: true, url: "http://x.test/" });
  const w = dom.window, d = w.document;
  w.TextDecoder = TextDecoder;
  w.matchMedia = q => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.Element.prototype.scrollIntoView = () => {};
  const j = v => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
  w.fetch = async (u, o = {}) => {
    if (o.method === "PUT") { puts.push([u, JSON.parse(o.body)]); HOSTS[0].dhcp_warnings = []; return j({}); }
    return u.endsWith("/api/hosts") ? j(HOSTS) : u.endsWith("/api/dhcp-warnings") ? j({ hosts: {}, pools: POOLS })
      : /\/api\/hosts\/[^/]+$/.test(u) ? j({ ...HOSTS.find(h => u.endsWith(h.ip)), services: [], ssh_access: [] })
      : j(u.includes("config") || u.includes("settings") || u.includes("auth") ? {} : []);
  };
  w.cytoscape = () => new Proxy({}, { get: () => () => ({}) });
  w.eval(["markdown", "export", "chat", "peek", ...require("./appfiles"), "fitcols", "search"].map(f => fs.readFileSync(`${BOLTARR}/frontend/js/${f}.js`, "utf8")).join("\n;\n")
         + "\nwindow.__run = c => eval(c);");
  await sleep(300);
  await w.__run(`loadHosts().then(() => renderHostsTable())`); await sleep(50);
  const rows = () => [...d.querySelectorAll("#hostsTable tbody tr")];
  const badge = d.querySelector("#hostsTable .dhcp-warn");
  check(badge && badge.closest("tr").textContent.includes("core-sw"), "⚠ badge on the flagged host only");
  check(d.querySelectorAll("#hostsTable .dhcp-warn").length === 1, "one badge in total");
  check(badge.title.includes("<b>x</b>") && !badge.querySelector("b"), "reason on hover, as plain text");
  const chip = d.getElementById("dhcpPoolWarn");
  check(!chip.hidden && chip.textContent === "⚠ DHCP pool 93% full" && chip.title.includes("Lab"), `pool chip (${chip.textContent})`);
  const cf = d.getElementById("classFilter"); cf.value = "dhcpwarn"; cf.dispatchEvent(new w.Event("change"));
  await sleep(10);
  check(rows().length === 1 && rows()[0].textContent.includes("core-sw"), `filter shows only flagged hosts (${rows().length})`);
  await w.__run(`showHostDetail("10.9.0.101")`); await sleep(30);
  const box = d.querySelector("#hostDetail .dhcp-warn-box");
  check(box && box.textContent.includes("Important device") && !box.querySelector("b"), "warning box in the host panel, escaped");
  box.querySelector("[data-dhcp-ignore]").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await sleep(50);
  check(puts.length === 1 && puts[0][0].endsWith("/api/hosts/10.9.0.101") && puts[0][1].no_dhcp_warn === true, "ignore button saves no_dhcp_warn");
  check(!d.querySelector("#hostDetail .dhcp-warn-box") && !d.querySelector("#hostsTable .dhcp-warn"), "box and badge gone after ignoring");
  await w.__run(`showHostDetail("10.9.0.150")`); await sleep(30);
  check(!d.querySelector("#hostDetail .dhcp-warn-box"), "no box for a host without warnings");
  check(!!d.getElementById("editNoDhcpWarn"), "Edit host has the opt-out checkbox");
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
