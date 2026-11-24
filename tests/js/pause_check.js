// v0.27.0 Boltarr screens: F-28 pause dialog (reason/until/off), toggle labels,
// panel; F-29 "Not set up" dot + Accepted replies field; F-30 whole-row refresh;
// F-27 Settings health lines + "out of date" minutes.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const ROOT = `${BOLTARR}/frontend`;
let html = fs.readFileSync(`${ROOT}/index.html`, "utf8");
html = html.replace(/<script src="\/vendor\/[^"]+"><\/script>/g, "");
html = html.replace(/<script src="\/js\/([^"]+)"><\/script>/g, (_, f) =>
  `<script>${fs.readFileSync(`${ROOT}/js/${f}`, "utf8").replace(/<\/script>/g, "<\\/script>")}</script>`);
html = html.replace(/<link[^>]+stylesheet[^>]*>/g, "");
let fail = 0, SLOW_ON = 0; const errors = [], calls = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const svc = (o) => ({ id: 1, name: "Demo Web", ip: "10.9.0.20", hostname: "demo-box", port: 80, protocol: "tcp",
  url: "http://10.9.0.20", check_type: "http", status: "running", monitored: 1, monitor_status: "up", host_online: 1,
  monitor_resume_at: null, monitor_paused_at: null, monitor_pause_reason: null, monitor_not_set_up: false,
  accepted_codes: null, public: 1, ...o });
let SERVICES = [svc({}), svc({ id: 2, name: "Demo Empty", url: null, port: null, monitor_status: "unknown", monitor_not_set_up: true })];
let HEALTH = { notify: { last_ok: "2026-11-20T10:00:00+00:00", last_error: "demo: connection refused",
  last_error_at: "2026-11-20T11:00:00+00:00" }, push: { last_ok: "2026-11-20T11:30:00+00:00", last_error: null }, held_alerts: 2 };
const SETTINGS = { general: {}, llm: { provider: "none" }, notifications: {}, statuspage: { url: "", token: "", stale_minutes: 15 },
  change_tracking: {}, change_alerts: {}, liveness: {}, ip_history: {}, ai_history: {}, security: {} };
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
    const j = v => new w.Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    w.fetch = async (u, o = {}) => { u = String(u);
      const body = o.body ? JSON.parse(o.body) : null;
      if (o.method && o.method !== "GET") calls.push({ m: o.method, u, body });
      const pm = u.match(/\/api\/services\/(\d+)\/pause$/);
      if (pm) { const s = SERVICES.find(x => x.id === +pm[1]);
        Object.assign(s, { monitored: 0, monitor_status: "unknown", monitor_resume_at: body.until,
          monitor_paused_at: "2026-11-20T12:00:00+00:00", monitor_pause_reason: body.reason });
        return j({ id: s.id, monitored: 0, monitor_status: "unknown", monitor_resume_at: s.monitor_resume_at,
          monitor_paused_at: s.monitor_paused_at, monitor_pause_reason: s.monitor_pause_reason }); }
      const mm = u.match(/\/api\/services\/(\d+)\/monitor$/);
      if (mm) { const s = SERVICES.find(x => x.id === +mm[1]);
        if (body.enabled && SLOW_ON) await new Promise(r => setTimeout(r, SLOW_ON));   // the first check of a dead address
        Object.assign(s, { monitored: body.enabled ? 1 : 0, monitor_paused_at: null, monitor_pause_reason: null, monitor_resume_at: null });
        return j({ id: s.id, monitored: body.enabled, monitor_status: body.enabled ? "up" : "unknown" }); }
      const um = o.method === "PUT" && u.match(/\/api\/services\/(\d+)$/);
      if (um) { const s = SERVICES.find(x => x.id === +um[1]); Object.assign(s, body); return j(s); }
      if (o.method === "PUT") return j({ ok: true, ...SETTINGS });
      if (o.method === "POST") return j({ ok: true });
      return u.endsWith("/api/settings") ? j(SETTINGS)
        : u.includes("/api/monitor/health") ? j(HEALTH)
        : u.endsWith("/api/services") ? j(JSON.parse(JSON.stringify(SERVICES)))
        : u.includes("/api/auth/status") ? j({ enabled: false })
        : u.includes("/api/dhcp-warnings") ? j({ hosts: {}, pools: [] })
        : u.includes("/api/graph") ? j({ nodes: [], edges: [] })
        : u.includes("/api/version") ? j({ version: "x" })
        : j(u.includes("config") || u.includes("/api/ai-history") ? {} : []); };
  } });
const w = dom.window, d = w.document, $ = id => d.getElementById(id);
const toggle = id => d.querySelector(`#svc-row-${id} .col-svc-mon .mon-switch, tr[data-id="${id}"] .mon-switch`)
  || [...d.querySelectorAll("#servicesTable tbody tr")].find(tr => tr.innerHTML.includes(`data-args="[${id}]"`))?.querySelector(".col-svc-mon .mon-switch");
const rowOf = id => toggle(id)?.closest("tr");
const click = el => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
(async () => {
  await sleep(700);
  await w.loadServicesData(); w.renderServicesTable(); await sleep(30);

  // F-29: monitoring on, nothing to check
  const dot2 = rowOf(2)?.querySelector(".mon-dot");
  check(dot2 && /Not set up/.test(dot2.title), "nothing to check → dot says 'Not set up'");

  // F-28: On → the pause dialog (not straight off)
  check(toggle(1) && toggle(1).textContent === "On", "monitored service shows On");
  click(toggle(1)); await sleep(30);
  check($("pauseModal").classList.contains("open") && /Demo Web/.test($("pauseTitle").textContent), "clicking On opens the pause dialog");
  check(!calls.some(c => /monitor$/.test(c.u)), "…and doesn't turn monitoring off by itself");
  $("pauseReason").value = "Demo: updating to v2";
  $("pauseUntil").value = "2026-11-20T17:00";
  await w.pauseSubmit(); await sleep(30);
  const pc = calls.find(c => /\/pause$/.test(c.u));
  check(pc && pc.body.reason === "Demo: updating to v2" && pc.body.until === new Date("2026-11-20T17:00").toISOString(),
    "Pause sends the reason + the end time (UTC)");
  check(!$("pauseModal").classList.contains("open"), "dialog closes");
  check(toggle(1).textContent === "Maint" && toggle(1).classList.contains("maint") && /updating to v2/.test(toggle(1).title),
    "with a reason: toggle reads Maint, tooltip has the reason");
  check(rowOf(1).querySelector(".mon-dot.mon-paused.maint"), "orange hollow dot while in maintenance");

  // Panel shows it too
  w.showSvcDetail(1); await sleep(30);
  check(/maintenance: Demo: updating to v2/.test($("svcDetailMonitorText").textContent) && $("svcDetailPauseBtn").hidden,
    "panel: 'maintenance: …' text, no Pause button while paused");

  // Paused → click turns it back on
  click(toggle(1)); await sleep(40);
  check(calls.some(c => /\/1\/monitor$/.test(c.u) && c.body.enabled === true) && toggle(1).textContent === "On", "clicking Maint turns monitoring back on");
  check(!/maintenance/.test($("svcDetailMonitorText").textContent) && !$("svcDetailPauseBtn").hidden
    && !$("svcDetailMonitorDot").classList.contains("mon-paused"), "open panel updates too (no longer says maintenance)");

  // No reason → Paused; panel button opens the same dialog
  w.showSvcDetail(1); await sleep(20);
  check(!$("svcDetailPauseBtn").hidden, "panel: Pause button while monitored");
  click($("svcDetailPauseBtn")); await sleep(20);
  check($("pauseModal").classList.contains("open") && $("pauseReason").value === "" && $("pauseUntil").value === "",
    "panel button opens a clean dialog");
  await w.pauseSubmit(); await sleep(30);
  check(toggle(1).textContent === "Paused" && !toggle(1).classList.contains("maint"), "no reason → Paused");
  check(/paused until you turn it back on/.test($("svcDetailMonitorText").textContent), "open panel updates to 'paused'");

  // Turn monitoring off from the dialog
  click(toggle(1)); await sleep(30);                    // back on
  click(toggle(1)); await sleep(20);                    // dialog
  await w.pauseTurnOff(); await sleep(30);
  check(calls.some(c => /\/1\/monitor$/.test(c.u) && c.body.enabled === false) && toggle(1).textContent === "Off",
    "'Turn monitoring off' really turns it off");
  click(toggle(1)); await sleep(30);                    // on again for the next part

  // F-30: the 20 s refresh updates the whole row
  Object.assign(SERVICES[0], { monitor_status: "down", status: "stopped", host_online: 0 });
  await w.refreshMonitorStatus(); await sleep(20);
  check(rowOf(1).querySelector(".svc-status.stopped") && /host offline/.test(rowOf(1).textContent),
    "refresh updates the status label and the host-offline chip");
  Object.assign(SERVICES[0], { monitored: 0, monitor_paused_at: "2026-11-20T12:00:00+00:00", monitor_pause_reason: "Demo: AI pause",
    monitor_resume_at: "2026-11-20T18:00:00+00:00" });
  await w.refreshMonitorStatus(); await sleep(20);
  check(toggle(1).textContent === "Maint" && /until/.test(toggle(1).title), "a pause made elsewhere (e.g. AI) shows after refresh");

  // F-29: Accepted replies field
  Object.assign(SERVICES[0], { monitored: 1, monitor_paused_at: null, monitor_pause_reason: null, monitor_resume_at: null,
    accepted_codes: "200-299" });
  await w.loadServicesData(); w.renderServicesTable();
  w.openEditService(1); await sleep(20);
  check($("svcCodes").value === "200-299" && !$("svcCodes").disabled, "edit dialog shows the accepted replies (HTTP check)");
  check($("svcModalDeleteBtn").style.display === "" && $("svcDeleteBtn").style.display === "none",
    "F-26: Edit Service shows its own Delete button (toolbar 'Delete selected' stays hidden)");
  $("svcCheckType").value = "tcp"; w.svcCheckTypeChanged();
  check($("svcCodes").disabled, "greyed out for a TCP check");
  $("svcCheckType").value = "http"; w.svcCheckTypeChanged();
  $("svcCodes").value = "200,404";
  await w.saveServiceModal(); await sleep(30);
  const put = calls.filter(c => c.m === "PUT" && /\/api\/services\/1$/.test(c.u)).pop();
  check(put && put.body.accepted_codes === "200,404", "Save sends accepted_codes");
  w.showSvcDetail(1); await sleep(20);
  check($("svcDetailCodes").value === "200,404", "panel shows it too");
  $("svcDetailCodes").value = "";
  await w.saveSvcDetail(); await sleep(30);
  const put2 = calls.filter(c => c.m === "PUT" && /\/api\/services\/1$/.test(c.u)).pop();
  check(put2 && put2.body.accepted_codes === null, "panel: emptied = back to the default rule");

  // F-27: Settings
  await w.openSettings(); await sleep(60);
  check($("setSpStale").value === "15", "status page 'out of date' minutes loaded");
  const nh = $("setNtfyHealth"), sh = $("setSpHealth");
  check(!nh.hidden && nh.classList.contains("bad") && /Last send failed .*demo: connection refused/.test(nh.textContent)
    && /2 alerts waiting/.test(nh.textContent), "Notifications: last failure + waiting alerts shown in red");
  check(!sh.hidden && !sh.classList.contains("bad") && /Last push OK/.test(sh.textContent), "Status page: last push OK");
  $("setSpStale").value = "9999";
  await w.saveSettings(true); await sleep(40);
  const all = calls.filter(c => /\/api\/settings\/all$/.test(c.u)).pop();
  check(all && all.body.statuspage.stale_minutes === 1440, "minutes are kept within 1–1440 on save");

  // A real switch (owner: "Off" as a button wasn't intuitive)
  check(toggle(1).getAttribute("role") === "switch" && toggle(1).querySelector(".mon-switch-knob"), "monitor column is a switch");
  check(toggle(1).getAttribute("aria-checked") === "true" && toggle(1).classList.contains("on"), "monitored: switch on");
  click(toggle(1)); await sleep(20); await w.pauseTurnOff(); await sleep(30);
  check(toggle(1).getAttribute("aria-checked") === "false" && /click to turn it on/.test(toggle(1).title), "off: switch off, tooltip says click to turn it on");
  click(toggle(1)); await sleep(30);
  check(toggle(1).getAttribute("aria-checked") === "true", "sliding it turns monitoring on");
  const pubBtn = () => toggle(1).closest("tr, .svc-row").querySelector('.col-svc-pub .mon-switch');
  check(pubBtn() && pubBtn().getAttribute("role") === "switch", "Public column is a switch too");
  const wasPub = pubBtn().getAttribute("aria-checked");
  click(pubBtn()); await sleep(30);
  check(pubBtn().getAttribute("aria-checked") !== wasPub && calls.some(c => /\/1\/public$/.test(c.u)), "sliding Public flips it");
  click(pubBtn()); await sleep(30);

  // Panel: Monitor + show publicly are switches; sliding Monitor off asks first
  w.showSvcDetail(1); await sleep(30);
  const mon = $("svcDetailMonitored");
  check(mon.closest(".mon-switch") && $("svcDetailPublic").closest(".mon-switch"), "panel: both tick boxes are switches");
  check(mon.checked && !/^off$/.test($("svcDetailMonitorText").textContent), "panel: on, shows the live state");
  const nMon = calls.filter(c => /\/1\/monitor$/.test(c.u)).length;
  mon.checked = false; mon.dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(30);
  check($("pauseModal").classList.contains("open") && mon.checked && calls.filter(c => /\/1\/monitor$/.test(c.u)).length === nMon,
    "panel: sliding off opens the pause box (nothing turned off yet)");
  await w.pauseTurnOff(); await sleep(40);
  check(!$("svcDetailMonitored").checked && $("svcDetailMonitorText").textContent === "monitoring off", "panel: off reads 'monitoring off'");
  $("svcDetailMonitored").checked = true; $("svcDetailMonitored").dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(40);
  check(calls.some(c => /\/1\/monitor$/.test(c.u) && c.body.enabled === true) && toggle(1).getAttribute("aria-checked") === "true",
    "panel: sliding on turns monitoring on (table follows)");
  click(toggle(1)); await sleep(20); $("pauseReason").value = "Demo: panel maint"; await w.pauseSubmit(); await sleep(40);
  check($("svcDetailMonSwitch").classList.contains("maint") && /maintenance: Demo: panel maint/.test($("svcDetailMonitorText").textContent),
    "panel: maintenance shows orange switch + reason");
  click(toggle(1)); await sleep(40);
  check(!$("svcDetailMonSwitch").classList.contains("maint") && $("svcDetailMonitored").checked, "resuming clears the orange");

  // Owner: the switches must reflect a change at once, even while the first check is slow
  SLOW_ON = 400;
  w.showSvcDetail(1); await sleep(30);
  if ($("svcDetailMonitored").checked) { click(toggle(1)); await sleep(20); await w.pauseTurnOff(); await sleep(30); }
  $("svcDetailName").value = "Demo unsaved edit";
  $("svcDetailMonitored").checked = true; $("svcDetailMonitored").dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(40);
  check(toggle(1).getAttribute("aria-checked") === "true", "panel on → table switch flips at once (check still running)");
  check($("svcDetailMonitorText").textContent === "checking…", "…panel says 'checking…' meanwhile");
  await sleep(500);
  check($("svcDetailMonitorText").textContent === "up", "…and shows the result when the check finishes");
  check($("svcDetailName").value === "Demo unsaved edit", "a monitoring change keeps unsaved edits in the panel");
  click(toggle(1)); await sleep(20); await w.pauseTurnOff(); await sleep(30);
  check(!$("svcDetailMonitored").checked && $("svcDetailMonitorText").textContent === "monitoring off", "table off → panel flips at once");
  click(toggle(1)); await sleep(40);
  check($("svcDetailMonitored").checked && $("svcDetailMonitorText").textContent === "checking…", "table on → panel flips at once");
  await sleep(500);
  check($("svcDetailMonitorText").textContent === "up" && $("svcDetailName").value === "Demo unsaved edit", "…result fills in, edits kept");
  SLOW_ON = 0;

  // Owner: the Public switches in the table and the panel must move together
  w.showSvcDetail(1); await sleep(30);
  const pubT = () => toggle(1).closest("tr, .svc-row").querySelector('.col-svc-pub .mon-switch');
  const pubP = $("svcDetailPublic");
  check(pubP.checked === (pubT().getAttribute("aria-checked") === "true"), "Public: table and panel agree when opened");
  const before = pubP.checked, nPub = calls.filter(c => /\/1\/public$/.test(c.u)).length;
  click(pubT()); await sleep(30);
  check(pubP.checked === !before && pubT().getAttribute("aria-checked") === String(!before), "table Public switch → panel switch moves too");
  check(($("svcDetailPublicNameRow").style.display === "none") === before, "…and the public-name box shows/hides with it");
  pubP.checked = before; pubP.dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(30);
  check(pubT().getAttribute("aria-checked") === String(before), "panel Public switch → table switch moves too");
  const last = calls.filter(c => /\/1\/public$/.test(c.u));
  check(last.length === nPub + 2 && last[last.length - 1].body.enabled === before, "panel switch saves at once (no Save needed)");
  if (!pubP.checked) { pubP.checked = true; pubP.dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(30); }
  $("svcDetailPublicName").value = "Demo typed name";
  click(pubT()); await sleep(30); click(pubT()); await sleep(30);
  check($("svcDetailPublicName").value === "Demo typed name", "an unsaved public name isn't overwritten");

  // Pause button look + Accepted replies hints popup
  check($("svcDetailPauseBtn").querySelector(".pause-ico") && !/⏸/.test(d.body.innerHTML.replace(/<script[\s\S]*?<\/script>/g, "")),
    "pause buttons use the drawn bars, not the ⏸ symbol");
  const hints = [...d.querySelectorAll('.hint-link[data-click="openCodesHelp"]')];
  check(hints.length === 2, "a 'hints' link next to both Accepted replies boxes");
  click(hints[0]); await sleep(10);
  check($("codesHelpModal").classList.contains("open") && /502, 503/.test($("codesHelpModal").textContent), "hints popup opens and explains the numbers");
  check([...d.querySelectorAll(".modal-overlay")].pop() === $("codesHelpModal"), "popup sits above the edit dialog");
  click($("codesHelpModal").querySelector(".codes-table")); await sleep(10);
  check($("codesHelpModal").classList.contains("open"), "clicking inside the popup keeps it open");
  click($("codesHelpModal")); await sleep(10);
  check(!$("codesHelpModal").classList.contains("open"), "clicking outside closes it");
  click(hints[1]); await sleep(10);
  click($("codesHelpModal").querySelector(".btn-primary")); await sleep(10);
  check(!$("codesHelpModal").classList.contains("open"), "'Got it' closes it (panel link works too)");

  check(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
