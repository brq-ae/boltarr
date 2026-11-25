// v0.27.0 Part 3 batch 2a screens: F-38 local times, F-24 ports per address,
// F-34 scan list (waiting / problems / no delete while running), time limit
// field, separate scan + probe bars and Stop, F-42 auto-explain flag and
// topology placement of devices with no saved spot. Self-contained (fake API).
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const ROOT = `${BOLTARR}/frontend`;
let html = fs.readFileSync(`${ROOT}/index.html`, "utf8");
html = html.replace(/<script src="\/vendor\/[^"]+"><\/script>/g, "");
html = html.replace(/<script src="\/js\/([^"]+)"><\/script>/g, (_, f) =>
  `<script>${fs.readFileSync(`${ROOT}/js/${f}`, "utf8").replace(/<\/script>/g, "<\\/script>")}</script>`);
html = html.replace(/<link[^>]+stylesheet[^>]*>/g, "");
let fail = 0; const errors = [], calls = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const HOST = { id: 1, ip: "10.9.0.10", hostname: "demo-two-nics", device_type: "nas", online: 1,
  first_seen: "2026-03-01 23:30:00", last_seen: "2026-11-14 12:30:00",
  ports: [{ id: 11, port: 22, protocol: "tcp", state: "open", service: "ssh" },
          { id: 12, port: 80, protocol: "tcp", state: "open", service: "http", manual: 1 }],
  alias_ports: [{ addr: "10.9.0.11", port: 445, protocol: "tcp", state: "open", service: "smb" }],
  aliases: ["10.9.0.11"], alias_info: [{ ip: "10.9.0.11", online: 1 }], services: [], analyses: [] };
let SCANS = [];
const STATUS = {};
let UPTIME_FAILS = false;
const vc = new VirtualConsole();
vc.on("jsdomError", e => errors.push(String(e.message || e)));
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://x.test/", virtualConsole: vc,
  beforeParse(w) {
    w.TextDecoder = TextDecoder;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.Element.prototype.scrollIntoView = () => {};
    const P = new Proxy(function () {}, { get: (t, k) => k === Symbol.iterator ? function* () {} : k === "length" ? 0
      : k === "then" || k === Symbol.toPrimitive ? undefined : P, apply: () => P });
    w.cytoscape = P;
    w.ResizeObserver = class { observe() {} disconnect() {} };
    w.confirm = () => true; w.alert = m => errors.push("alert: " + m); w.CSS = { escape: s => String(s) };
    w.Response = Response;
    const j = (v, status = 200) => new w.Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    w.fetch = async (u, o = {}) => { u = String(u);
      const body = o.body ? JSON.parse(o.body) : null;
      if (o.method && o.method !== "GET") calls.push({ m: o.method, u, body });
      const st = u.match(/\/api\/scan\/(\d+)\/status$/);
      if (st) return j(STATUS[st[1]] || { status: "scanning", progress: 40 });
      if (/\/api\/scan\/\d+\/cancel$/.test(u)) return new w.Response(null, { status: 204 });
      if (/\/api\/hosts\/10\.9\.0\.10\/uptime/.test(u)) return UPTIME_FAILS ? j({ detail: "boom" }, 500)
        : j({ host_id: 1, uptime: {}, outages: [{ start: "2026-11-14T10:00:00+00:00", end: "2026-11-14T10:30:00+00:00", seconds: 1800 }] });
      if (/\/api\/hosts\/10\.9\.0\.10$/.test(u)) return j(HOST);
      if (u.endsWith("/api/hosts")) return j([HOST]);
      if (u.endsWith("/api/scans") && (!o.method || o.method === "GET")) return j(SCANS);
      if (u.endsWith("/api/scan-profiles")) return j([{ id: 1, name: "Standard", builtin: true, options: {} },
        { id: 2, name: "Demo slow", builtin: false, options: { host_timeout: 60 } }]);
      if (u.includes("/api/scan/preview")) return j({ command: "nmap demo" });
      if (o.method === "POST") return j({ ok: true });
      return u.endsWith("/api/settings") ? j({ general: { timezone: "America/New_York" }, llm: {}, notifications: {},
          statuspage: {}, change_tracking: {}, change_alerts: {}, liveness: {}, ip_history: {}, ai_history: {}, security: {} })
        : u.includes("/api/auth/status") ? j({ enabled: false })
        : u.includes("/api/graph") ? j({ nodes: [], edges: [] })
        : u.includes("/api/version") ? j({ version: "x" })
        : j(u.includes("config") || u.includes("/api/ai-history") ? {} : []); };
  } });
const w = dom.window, d = w.document, $ = id => d.getElementById(id);
const click = el => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));

(async () => {
  await sleep(700);
  w.eval('APP_TZ = "America/New_York"');

  // ── F-38: Last seen / First seen in Boltarr's timezone ──
  check(w.fmtLocalStamp("2026-11-14 12:30:00") === "2026-11-14 07:30", "stamp: UTC → New York (07:30)");
  check(w.fmtLocalStamp("2026-07-01T23:30:00+00:00") === "2026-07-01 19:30", "stamp: summer offset (19:30)");
  check(w.fmtLocalStamp(null) === "", "stamp: empty stays empty");
  await w.loadHosts(); w.renderHostsTable(); await sleep(30);
  const row = d.querySelector("#hostsTable tbody tr");
  check(row && /2026-11-14 07:30/.test(row.querySelector(".col-seen").textContent), "Hosts table: Last seen in local time");
  check(row && !/12:30/.test(row.querySelector(".col-seen").textContent), "…not the raw UTC time");

  // ── F-24: second-address ports ──
  const badges = [...row.querySelectorAll(".port-badge")];
  const ab = badges.find(b => /445/.test(b.textContent));
  check(ab && ab.classList.contains("alias") && /second address 10\.9\.0\.11/.test(ab.title), "Hosts table: second address's port shown, dashed, says which address");
  check(badges.filter(b => /^(22|80|445)\//.test(b.textContent)).length === 3, "Hosts table: main + second ports together");
  check(w.hostOpenPorts(HOST).length === 3, "hostOpenPorts: all addresses");

  await w.showHostDetail("10.9.0.10"); await sleep(50);
  const info = $("hostDetail").textContent;
  check(/2026-03-01 18:30/.test(info) && /2026-11-14 07:30/.test(info), "host panel: First/Last seen in local time");
  check(/Ports \(3\)/.test($("hostDetail").textContent), "Ports tab counts both addresses");
  const heads = [...d.querySelectorAll("#dtab-ports .ports-addr-head")].map(h => h.textContent.replace(/\s+/g, " ").trim());
  check(heads.length === 2 && /Main address 10\.9\.0\.10/.test(heads[0]) && /Second address 10\.9\.0\.11/.test(heads[1]),
    "Ports tab: grouped under Main address / Second address");
  const rows = [...d.querySelectorAll("#dtab-ports .port-row")];
  check(rows.length === 3 && rows[2].textContent.includes("445") && !rows[2].querySelector('[data-click="deletePort"]'),
    "second address's ports listed without a delete button (they come from scans)");
  check(rows[0].querySelector('[data-click="deletePort"]'), "main address's ports keep their delete button");

  // ── F-42: auto-explain only for the panel it was meant for ──
  UPTIME_FAILS = true;
  await w.aiOpenTarget({ type: "host", ip: "10.9.0.10", explain: true }); await sleep(60);
  check(w.eval("aiAutoExplain") === null, "uptime failed to load → the explain request is dropped (not left waiting)");
  UPTIME_FAILS = false;
  w.eval('aiAutoExplain = { kind: "host", key: "10.9.0.99" }');
  let explained = false;
  const realExplain = w.eval("typeof explainOutage === 'function' ? explainOutage : null");
  await w.loadHostUptime("10.9.0.10"); await sleep(30);
  check(w.eval("aiAutoExplain") === null && !d.querySelector(".explain-loading, .explain-result"),
    "a request for another host doesn't explain this one");

  // ── F-42: a new device's one event lists its ports ──
  check(/New host discovered — open ports 22, 80, 443/.test(w.eval('_CHANGE_META.host_new.text({ new_value: "22,80,443" })')),
    "Changes list: new device shows its open ports");
  check(w.eval('_CHANGE_META.host_new.text({})') === "New host discovered", "…and older events read as before");

  // ── F-34: scan list states ──
  SCANS = [
    { id: 1, type: "scan", subnet_name: "Demo LAN", cidr: "10.9.0.0/24", status: "queued", started_at: "2026-11-14 12:00:00", schedule_name: "Demo nightly" },
    { id: 2, type: "scan", subnet_name: "Demo LAN", cidr: "10.9.0.0/24", status: "running", live_status: "scanning", progress: 40,
      started_at: "2026-11-14 11:59:00", problem_count: 1 },
    { id: 3, type: "scan", subnet_name: "Demo LAN", cidr: "10.9.0.0/24", status: "completed", hosts_found: 5, started_at: "2026-11-14 10:00:00",
      completed_at: "2026-11-14 10:05:00", note: "completed with problems — 2 of 5 hosts couldn't be scanned",
      problems: [{ ip: "10.9.0.7", error: "took longer than 15 min, so it was skipped" }, { ip: "10.9.0.8", error: "QUITTING! <b>x</b>" }] },
    { id: 4, type: "scan", subnet_name: "Demo LAN", cidr: "10.9.0.0/24", status: "completed", hosts_found: 5, started_at: "2026-11-13 10:00:00",
      completed_at: "2026-11-13 10:05:00", problems: [] },
    { id: 5, type: "scan", subnet_name: "Demo LAN", cidr: "10.9.0.0/24", status: "error", note: "nmap failed: Failed to open device eth9",
      started_at: "2026-11-12 10:00:00", problems: [] },
  ];
  await w.loadScans(); await sleep(20);
  const card = id => $(`scan-card-${id}`);
  check(/waiting/.test(card(1).querySelector(".tag-queued").textContent) && /waiting for the scan before it/.test(card(1).textContent),
    "waiting scan: 'waiting' tag + explanation");
  check(card(1).querySelector('[data-click="cancelScanRun"]'), "waiting scan can be stopped before it starts");
  for (const id of [1, 2]) {
    const del = card(id).querySelector('button[title*="Stop it first"]');
    check(del && del.disabled && !card(id).querySelector('[data-click="deleteScanRun"]'), `scan ${id} (live): delete is disabled`);
  }
  check(/1 host couldn't be scanned so far/.test(card(2).textContent), "running scan shows problems so far");
  check(/completed with problems/.test(card(3).querySelector(".tag-problems").textContent), "'completed with problems' tag");
  const det = card(3).querySelector("details.scan-problems");
  check(det && /2 hosts couldn't be scanned/.test(det.querySelector("summary").textContent), "problem list (collapsed) with a count");
  check(det && /10\.9\.0\.7.*took longer than 15 min/.test(det.textContent) && !det.querySelector("b"), "each host + reason, shown as text");
  check(card(4).querySelector(".tag-completed") && !card(4).querySelector("details"), "clean scan: plain 'completed'");
  check(/nmap failed: Failed to open device eth9/.test(card(5).textContent), "failed scan shows nmap's words");
  check(card(4).querySelector('[data-click="deleteScanRun"]'), "finished scans can still be deleted");

  // bulk delete that keeps running ones says so
  const shown = [];
  w.eval("showToast = m => window.__toasts.push(m)"); w.__toasts = shown;
  const realFetch = w.fetch;
  w.fetch = async (u, o = {}) => String(u).endsWith("/api/scans") && o.method === "DELETE"
    ? new w.Response(JSON.stringify({ ok: true, deleted: 1, kept_running: 1 }), { headers: { "content-type": "application/json" } })
    : realFetch(u, o);
  card(2).querySelector(".scan-checkbox").checked = true; card(4).querySelector(".scan-checkbox").checked = true;
  const delSel = w.scansDeleteSelected(); $("askOk").click(); await delSel; await sleep(20);   // answer Boltarr's window (S-34)
  check(shown.some(m => /1 running scan was kept — stop it first/.test(m)), "bulk delete: running scan kept, toast says so");
  w.fetch = realFetch;

  // ── F-34: time limit field ──
  await w.loadScanProfiles(); await sleep(20);
  $("scanProfile").value = "2"; w.applyScanProfile();
  check($("scanHostTimeout").value === "60", "profile's time limit fills the field");
  $("scanProfile").value = "1"; w.applyScanProfile();
  check($("scanHostTimeout").value === "15", "built-in profile: 15 minutes");
  $("scanHostTimeout").value = "0";  check(w._scanOptsFromFields().host_timeout === 0, "0 = no limit is sent as 0");
  $("scanHostTimeout").value = "";   check(w._scanOptsFromFields().host_timeout === 15, "empty box falls back to 15");
  $("scanHostTimeout").value = "9999"; check(w._scanOptsFromFields().host_timeout === 1440, "kept at most 1440");

  // ── F-34: a probe has its own bar and Stop ──
  STATUS[50] = { status: "scanning", progress: 30, problems: 0 };
  STATUS[60] = { status: "scanning" };
  w.eval("activeRunId = 50"); w.startPolling(7);
  w.startProbePolling(60, "10.9.0.10");
  await sleep(1700);
  check($("scanProgress").classList.contains("visible") && $("probeProgress").classList.contains("visible"), "scan and probe bars both shown");
  check(/Scanning 30%/.test($("progressLabel").textContent) && /Probing 10\.9\.0\.10/.test($("probeLabel").textContent),
    "each bar shows its own job");
  calls.length = 0;
  click($("stopProbeBtn")); await sleep(20);
  check(calls.some(c => c.u.endsWith("/api/scan/60/cancel")) && !calls.some(c => c.u.endsWith("/api/scan/50/cancel")),
    "probe's Stop stops the probe, not the scan");
  calls.length = 0;
  click($("stopScanBtn")); await sleep(20);
  check(calls.some(c => c.u.endsWith("/api/scan/50/cancel")) && !calls.some(c => c.u.endsWith("/api/scan/60/cancel")),
    "scan's Stop stops the scan, not the probe");
  STATUS[60] = { status: "completed" }; STATUS[50] = { status: "scanning", progress: 55, problems: 2 };
  await sleep(1700);
  check(w.eval("activeRunId") === 50 && /Scanning 55% — 2 with problems/.test($("progressLabel").textContent),
    "probe finishing leaves the scan's bar alone (and it shows problems)");
  STATUS[50] = { status: "completed", total: 5, problems: 2 };
  await sleep(1700);
  check(/Done — 5 hosts — 2 with problems/.test($("progressLabel").textContent), "scan done: count + problems");
  w.eval("clearInterval(pollTimer); clearInterval(probePollTimer)");

  // ── F-42: topology devices with no saved spot get one ──
  const mk = (id, x, y, nbrs = []) => {
    let pos = x == null ? { x: 0, y: 0 } : { x, y };
    return { _id: id, _n: nbrs, id: () => id, position: p => (p ? (pos = p) : pos) };
  };
  const nodes = [mk("a", 100, 100), mk("b", 300, 100), mk("c"), mk("d"), mk("e")];
  nodes[2]._n = ["a"]; nodes[3]._n = ["a"];
  const coll = arr => Object.assign(arr.slice(), {
    filter: f => coll(arr.filter(f)), map: f => arr.map(f),
    boundingBox: () => ({ x1: Math.min(...arr.map(n => n.position().x)), x2: Math.max(...arr.map(n => n.position().x)),
      y1: Math.min(...arr.map(n => n.position().y)), y2: Math.max(...arr.map(n => n.position().y)) }) });
  nodes.forEach(n => { n.neighborhood = () => coll(nodes.filter(m => n._n.includes(m._id))); });
  w.__fakeCy = { nodes: () => coll(nodes) };
  w.eval("cy = window.__fakeCy");
  w.placeUnpositioned([nodes[2], nodes[3], nodes[4]]);
  const p = n => n.position(), dist = (a, b) => Math.hypot(p(a).x - p(b).x, p(a).y - p(b).y);
  check(dist(nodes[2], nodes[0]) > 50 && dist(nodes[2], nodes[0]) < 200, "a new device sits next to the device it's linked to");
  check(dist(nodes[2], nodes[3]) > 20, "two new devices on the same neighbour don't overlap");
  check(p(nodes[4]).y > 100 && !(p(nodes[4]).x === 0 && p(nodes[4]).y === 0), "an unlinked new device goes in a row under the map");
  w.eval("cy = null");

  check(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
