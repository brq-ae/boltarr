// F-08 part B (v0.23.2): the Scans page (Run, Schedules, Scan Log, Changes, schedule editor)
// uses data-click/data-change/data-input actions. Same page load as split_check.js.
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
const KEYS = [{ id: 7, name: "laptop", public_key: "ssh-ed25519 AAAA laptop", fingerprint: "SHA256:x" }];
const ACCESS = [{ id: 3, key_id: 7, name: "laptop", username: `o'brien"x`, fingerprint: "SHA256:x" }];
const SCHED = [{ id: 5, name: "Nightly", enabled: 1, target_type: "all", interval_hours: 24, profile_name: "Quick" }];
const SCANS = [{ id: 9, status: "done", target: "10.9.0.0/24", started_at: "2026-01-01 00:00:00" }];
const EVS = [{ id: 1, type: "new_host", ip: "10.9.0.20", ts: "2026-01-01 00:00:00" }];
const warns = [];
const vc = new VirtualConsole();
vc.on("warn", (...a) => warns.push(a.join(" ")));
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
        : u.includes("/api/scan-schedules") ? j(SCHED)
        : u.endsWith("/api/scans") ? j(SCANS)
        : u.includes("/api/change-events") ? j(EVS)
        : u.includes("/api/ssh-keys") ? j(KEYS)
        : u.includes("/ssh-access") ? j(ACCESS)
        : u.includes("/api/graph") ? j({ nodes: [], edges: [] })
        : j(u.includes("config") ? {} : []); };
  } });
const w = dom.window, d = w.document;
(async () => {
  await sleep(600);
  check(errors.length === 0, `boots with no errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  const A = w.eval("ACTIONS");
  const names = [...d.querySelectorAll("[data-click],[data-change],[data-input]")]
    .map(el => el.dataset.click || el.dataset.change || el.dataset.input);
  const missing = names.filter(n => typeof A[n] !== "function");
  check(!missing.length, `all ${names.length} actions in the page are registered${missing.length ? ": missing " + missing : ""}`);
  const inl = id => [...d.getElementById(id).querySelectorAll("*")].filter(el => [...el.attributes].some(a => /^on/.test(a.name)));
  check(!inl("panel-scans").length && !inl("scheduleModal").length, "no inline handlers in the Scans page or schedule editor");
  const calls = [];
  const spy = (n, f) => { const o = A[n]; A[n] = f || function (...a) { calls.push([n, this, ...a]); }; return () => (A[n] = o); };
  w.setTab("scans"); await sleep(50);

  // Sub-tabs (string argument via data-args)
  for (const [tab, panel] of [["schedules", "scan-panel-schedules"], ["history", "scan-panel-history"], ["changes", "scan-panel-changes"], ["run", "scan-panel-run"]]) {
    d.getElementById(`scanTabBtn-${tab}`).click(); await sleep(60);
    check(d.getElementById(panel).style.display === "" && d.getElementById(`scanTabBtn-${tab}`).classList.contains("active"), `${tab} sub-tab opens`);
  }
  // Run builder: field changes update the command preview
  let undo = spy("onScanFieldChange");
  const sv = d.getElementById("scanSv"); sv.dispatchEvent(new w.Event("change", { bubbles: true })); undo();
  check(calls.pop()?.[0] === "onScanFieldChange", "ticking -sV runs onScanFieldChange (data-change)");
  undo = spy("updateScanPreview");
  const sc = d.getElementById("scanScripts"); sc.dispatchEvent(new w.Event("input", { bubbles: true })); undo();
  check(calls.pop()?.[0] === "updateScanPreview", "typing NSE scripts refreshes the preview (data-input)");
  undo = spy("runScanFromBuilder"); d.getElementById("scanRunBtn").click(); undo();
  check(calls.pop()?.[0] === "runScanFromBuilder", "▶ Run scan runs its action");

  // Schedules list
  d.getElementById("scanTabBtn-schedules").click(); await sleep(80);
  undo = spy("runScheduleNow"); d.querySelector('[data-click="runScheduleNow"]').click(); undo();
  check(JSON.stringify(calls.pop()?.slice(2)) === "[5]", "▶ Run now gets schedule id 5");
  undo = spy("deleteSchedule"); d.querySelector('[data-click="deleteSchedule"]').click(); undo();
  check(JSON.stringify(calls.pop()?.slice(2)) === "[5]", "✕ delete gets schedule id 5");
  let tog; w.eval("var __ts = toggleSchedule; toggleSchedule = (id, on) => { window.__tog = [id, on] }");
  const sw = d.querySelector('[data-change="toggleScheduleBox"]'); sw.checked = false; sw.dispatchEvent(new w.Event("change", { bubbles: true }));
  check(JSON.stringify(w.__tog) === "[5,false]", "enable switch passes id + checked state");
  w.eval("toggleSchedule = __ts");
  d.querySelector('[data-click="openScheduleEditor"]').click(); await sleep(50);
  check(d.getElementById("scheduleModal").classList.contains("open"), "＋ New schedule opens the editor");
  const wk = d.querySelector('input[name="schedTiming"][value="weekly"]'); wk.checked = true;
  undo = spy("onSchedTimingChange"); wk.dispatchEvent(new w.Event("change", { bubbles: true })); undo();
  check(calls.pop()?.[0] === "onSchedTimingChange", "timing radio runs its action");
  d.querySelector('#scheduleModal [data-click="closeScheduleEditor"]').click(); await sleep(20);
  check(!d.getElementById("scheduleModal").classList.contains("open"), "Cancel closes the editor");

  // Scan Log: checkboxes + select all
  d.getElementById("scanTabBtn-history").click(); await sleep(80);
  const all = d.getElementById("scansSelectAll");
  check(!!all, "Scan Log renders with a select-all box");
  if (all) { all.checked = true; all.dispatchEvent(new w.Event("change", { bubbles: true }));
    check([...d.querySelectorAll(".scan-checkbox")].every(c => c.checked), "select-all ticks every scan (this.checked passed)"); }
  undo = spy("deleteScanRun"); d.querySelector('[data-click="deleteScanRun"]')?.click(); undo();
  check(JSON.stringify(calls.pop()?.slice(2)) === "[9]", "✕ delete gets scan id 9");

  // Changes feed: a row opens that host
  d.getElementById("scanTabBtn-changes").click(); await sleep(80);
  undo = spy("openChangeHost"); d.querySelector('#scan-panel-changes [data-click="openChangeHost"]')?.click(); undo();
  check(JSON.stringify(calls.pop()?.slice(2)) === '["10.9.0.20"]', "a change row opens host 10.9.0.20");
  w.eval("var __shd = showHostDetail; showHostDetail = async () => { throw new Error('Host not found') }");
  d.querySelector('#scan-panel-changes [data-click="openChangeHost"]').click(); await sleep(30);
  check((d.getElementById("toast")?.textContent || d.body.textContent).includes("10.9.0.20 is no longer in Boltarr"), "a deleted host shows 'no longer in Boltarr'");
  w.eval("showHostDetail = __shd");

  check(!warns.length, `no unknown-action warnings${warns.length ? ": " + warns : ""}`);
  check(errors.length === 0, `no errors after all clicks${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
