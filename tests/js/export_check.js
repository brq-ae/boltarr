// S-03 Export: real app.js filters + export.js, in the full page.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM } = require("jsdom");
const fs = require("fs");
const html = fs.readFileSync(`${BOLTARR}/frontend/index.html`, "utf8");
const body = html.slice(html.indexOf("<body"), html.indexOf("<script src=\"/js/graph.js\""));
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOSTS = [
  { id: 1, ip: "10.9.0.20", hostname: "=cmd|' /C calc'!A0", mac: "aa:bb:cc:00:00:01", vendor: "Acme, \"Inc\"", device_type: "server",
    classification: "static", online: 1, notes: "line1\nline2", source: "scan", first_seen: "2026-11-01 08:00:00", last_seen: "2026-11-09 10:30:00",
    aliases: ["10.9.0.21"], ports: [{ port: 22, protocol: "tcp", service: "ssh", state: "open" }, { port: 80, protocol: "tcp", service: "http", state: "open" }, { port: 23, state: "closed" }] },
  { id: 2, ip: "10.9.0.3", hostname: "printer", classification: "dynamic", online: 0, ports: [], aliases: [] },
  { id: 3, ip: "node-7", hostname: "cloud", ports: [], aliases: [] },
];
const SVCS = [{ id: 1, name: "Web", ip: "10.9.0.20", hostname: "box", port: 443, protocol: "tcp", status: "up", monitored: 1, public: 0 },
              { id: 2, name: "DNS", ip: "10.9.0.3", port: 53, status: "down", monitored: 0, public: 1, public_name: "Resolver" }];
const IPH = { subnet: { cidr: "10.9.0.0/24" }, has_pool: false, stale_days: 7, gone_days: 30, counts: { in_use: 1, recent: 0, stale: 0, gone: 1, never: 1 },
  ips: [{ ip: "10.9.0.5", status: "gone", days: 40, last_seen: "2026-09-30 12:00:00", hostname: "old" },
        { ip: "10.9.0.20", status: "in_use", days: 0, last_seen: "2026-11-09 10:30:00", host_ip: "10.9.0.20", mac_change: { ts: "2026-11-02 09:00:00" } },
        { ip: "10.9.0.9", status: "never" }] };
(async () => {
  const dom = new JSDOM(body + "</body>", { runScripts: "outside-only", pretendToBeVisual: true, url: "http://x.test/" });
  const w = dom.window, d = w.document;
  w.TextDecoder = TextDecoder;
  w.fetch = async (u) => {
    const j = v => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    if (u.includes("/ip-history")) return j(IPH);
    if (u.endsWith("/api/subnets")) return j([{ id: 1, name: "Lab", cidr: "10.9.0.0/24" }]);
    if (u.endsWith("/api/hosts")) return j(HOSTS);
    if (u.endsWith("/api/services")) return j(SVCS);
    return j(u.includes("config") || u.includes("settings") || u.includes("auth") ? {} : []);
  };
  const dl = []; w.URL.createObjectURL = b => b; w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { if (this.download) dl.push({ name: this.download, blob: this.href_blob }); };
  w.URL.createObjectURL = b => { w.__lastBlob = b; return "blob:x"; };
  w.HTMLAnchorElement.prototype.click = function () { if (this.download) dl.push({ name: this.download, blob: w.__lastBlob }); };
  w.cytoscape = () => new Proxy({}, { get: () => () => ({}) });
  w.onerror = () => {};
  // One eval for all files: like the browser, they then share top-level let/const.
  w.eval(["markdown", "export", "chat", "peek", ...require("./appfiles")].map(f => fs.readFileSync(`${BOLTARR}/frontend/js/${f}.js`, "utf8")).join("\n;\n")
         + "\nwindow.__run = c => eval(c);");
  await sleep(300);
  const read = b => new Promise(r => { const fr = new w.FileReader(); fr.onload = () => r(fr.result); fr.readAsText(b); });
  w.__run(`allHosts = ${JSON.stringify(HOSTS)}; allServices = ${JSON.stringify(SVCS)}; sortCol = "ip"; sortDir = 1; renderHostsTable();`);

  // Menu opens, and picking CSV downloads + closes it
  const btn = d.querySelector('[data-export-btn]'), menu = btn.parentElement.querySelector(".col-menu");
  btn.click(); check(menu.classList.contains("open"), "⤓ Export ▾ opens its menu");
  d.querySelector('[data-export="hosts"][data-fmt="csv"]').click(); await sleep(10);
  check(!menu.classList.contains("open"), "menu closes after picking");
  let f = dl.pop(); check(/^boltarr-hosts-\d{4}-\d\d-\d\d\.csv$/.test(f.name), `hosts CSV name (${f.name})`);
  let csv = await read(f.blob);
  const lines = csv.replace(/^\uFEFF/, "").split("\r\n");
  check(csv.charCodeAt(0) === 0xFEFF || csv.startsWith("IP,"), "CSV header first (BOM for Excel)");
  check(lines[0] === "IP,Hostname,MAC,Vendor,Type,OS,IP type,Online,Open ports,Aliases,Notes,Source,First seen,Last seen", "all columns, hidden ones too");
  check(lines[1].startsWith("10.9.0.3,printer,") && lines[2].startsWith("10.9.0.20,"), "rows in the table's sort order (IP numeric)");
  check(!csv.includes("node-7"), "synthetic topology nodes left out");
  check(csv.includes(",'=cmd|' /C calc'!A0,"), "formula-looking name made plain text with '");
  check(csv.includes(`"Acme, ""Inc"""`) && csv.includes(`"line1\nline2"`), "commas, quotes, newlines quoted properly");
  check(csv.includes(`"22/tcp ssh, 80/tcp http"`) && !csv.includes("23/"), "only open ports, in one cell");

  // Filter applies
  w.__run(`classFilterVal = "static"; renderHostsTable();`);
  w.exportTable("hosts", "json"); f = dl.pop();
  const js = JSON.parse(await read(f.blob));
  check(f.name.endsWith(".json") && js.length === 1 && js[0].ip === "10.9.0.20", "export follows the filter (static only → 1 host)");
  check(Array.isArray(js[0].open_ports) && js[0].open_ports[0].service === "ssh" && js[0].aliases[0] === "10.9.0.21" && js[0].online === true, "JSON keeps lists and true/false");
  check(js[0].hostname === HOSTS[0].hostname, "JSON keeps raw values (no ' prefix)");
  check(d.getElementById("hostCount").textContent === "1 of 3", "table count still right after refactor");
  check(d.querySelectorAll("#hostsTable tbody tr").length === 1, "table still renders filtered rows");

  // Services
  w.__run(`svcFilterText = "dns"; renderServicesTable();`);
  w.exportTable("services", "csv"); f = dl.pop(); csv = await read(f.blob);
  check(/^boltarr-services-/.test(f.name) && csv.includes("DNS,") && !csv.includes("Web,"), "services export follows the search");
  check(csv.includes(",no,") && csv.includes("Resolver"), "services yes/no + public name");
  check(d.getElementById("serviceCount").textContent === "1 of 2", "services count still right");

  // IP History
  w.__run(`_iphData = ${JSON.stringify(IPH)};`);
  d.getElementById("iphSubnet").innerHTML = `<option value="1">Lab · 10.9.0.0/24</option>`;
  w.__run(`renderIpHistory();`);
  w.exportTable("iphistory", "csv"); f = dl.pop(); csv = await read(f.blob);
  check(/^boltarr-ip-history-lab-\d{4}/.test(f.name), `IP history name includes subnet (${f.name})`);
  check(csv.includes("Gone,10.9.0.5,40,") && csv.includes("In use,10.9.0.20,0,") && !csv.includes("10.9.0.9"), "IP history: shown rows only (never-seen hidden)");
  check(/2026-11-02 \d\d:\d\d/.test(csv), "CSV dates as YYYY-MM-DD HH:MM");
  w.__run(`setIpHistoryStatus("never");`);
  w.exportTable("iphistory", "json"); f = dl.pop();
  const ij = JSON.parse(await read(f.blob));
  check(ij.length === 1 && ij[0].ip === "10.9.0.9" && ij[0].days_since_seen === null, "IP history follows the status chip");

  // Empty view
  w.__run(`svcFilterText = "zzz"; renderServicesTable();`); const n = dl.length;
  w.exportTable("services", "csv"); check(dl.length === n, "nothing downloaded when no rows shown");
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
