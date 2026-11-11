// Boltarr — Scans tab: Run / Scan Log, change-tracking feed, scan schedules.
// Part of the app split from app.js (F-08); files share globals and load in order (see index.html).

// ── Scans ─────────────────────────────────────────────────────────────────────

// ── Scan tab: Run/Scan Log sub-tabs + nmap builder ─────────────────────────────

async function loadScansTab() {
  populateScanTarget();
  await loadScanProfiles();
  applyScanProfile();          // apply the currently-selected profile → fills fields + preview
  await loadScans();
}

function setScanTab(tab) {
  currentScanTab = tab;
  document.getElementById("scan-panel-run").style.display       = tab === "run"       ? "" : "none";
  document.getElementById("scan-panel-schedules").style.display = tab === "schedules" ? "" : "none";
  document.getElementById("scan-panel-history").style.display   = tab === "history"   ? "" : "none";
  document.getElementById("scan-panel-changes").style.display   = tab === "changes"   ? "" : "none";
  document.querySelectorAll("#panel-scans .svc-subtab").forEach(b => b.classList.remove("active"));
  document.getElementById(`scanTabBtn-${tab}`)?.classList.add("active");
  if (tab === "changes")   loadChanges();
  if (tab === "schedules") loadSchedules();
  if (tab === "history")   loadScans();   // always refresh (picks up running scans/probes + starts the live poll)
}


// ── Change-tracking feed ──────────────────────────────────────────────────────

const _CHANGE_META = {
  host_new:         { icon: "✦", cls: "chg-new",    text: () => "New host discovered" },
  port_opened:      { icon: "▲", cls: "chg-open",   text: e => `Port ${escHtml(e.port)} opened` },
  port_closed:      { icon: "▼", cls: "chg-closed", text: e => `Port ${escHtml(e.port)} closed` },
  mac_changed:      { icon: "⇄", cls: "chg-id",     text: e => `MAC changed: ${escHtml(e.old_value||"?")} → ${escHtml(e.new_value||"?")}` },
  hostname_changed: { icon: "⇄", cls: "chg-id",     text: e => `Hostname: ${escHtml(e.old_value||"?")} → ${escHtml(e.new_value||"?")}` },
};

// A change row in the global feed: open that host, or say it's gone (deleted since)
async function openChangeHost(ip) {
  try { await showHostDetail(ip); }
  catch { showToast(`${ip} is no longer in Boltarr`); }
}

function changeEventHTML(e, showIp = true) {
  const m = _CHANGE_META[e.type] || { icon: "•", cls: "", text: () => e.type };
  const when = fmtLocal(e.ts);
  // In the global feed the row is clickable → jump to that host's panel.
  const click = showIp ? ` style="cursor:pointer" data-click="openChangeHost" data-args="${dargs(e.ip)}" title="Open ${escHtml(e.ip)}"` : "";
  const ipPart = showIp ? `<span style="color:var(--accent)">${escHtml(e.ip)}</span> · ` : "";
  return `<div class="chg-row"${click}>
    <span class="chg-icon ${m.cls}">${m.icon}</span>
    <div style="flex:1;min-width:0">
      <div style="font-size:12px">${m.text(e)}</div>
      <div class="mono" style="font-size:10px;color:var(--text-3);margin-top:1px">${ipPart}${when}</div>
    </div>
  </div>`;
}

async function loadChanges() {
  const el = document.getElementById("changesList");
  const cnt = document.getElementById("changesCount");
  try {
    const evs = await api("GET", "/api/change-events?limit=300");
    if (cnt) cnt.textContent = `${evs.length} change${evs.length === 1 ? "" : "s"}`;
    el.innerHTML = evs.length
      ? evs.map(e => changeEventHTML(e, true)).join("")
      : `<div style="padding:40px;text-align:center;color:var(--text-3);font-size:12px">No changes recorded yet — run a scan.</div>`;
  } catch { el.innerHTML = ""; }
}

async function clearChanges() {
  if (!confirm("Clear the entire change log?")) return;
  await api("DELETE", "/api/change-events");
  loadChanges();
}

async function loadHostChanges(ip) {
  const el = document.getElementById(`hostChanges-${ip.replace(/\./g, "_")}`);
  if (!el) return;
  try {
    const evs = await api("GET", `/api/change-events?ip=${encodeURIComponent(ip)}&limit=30`);
    el.innerHTML = evs.length
      ? evs.map(e => changeEventHTML(e, false)).join("")
      : `<span style="font-size:11px;color:var(--text-3)">No changes recorded.</span>`;
  } catch { el.innerHTML = ""; }
}

function populateScanTarget() {
  const sel = document.getElementById("scanTarget");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = subnets.map(s => `<option value="${s.id}">${escHtml(s.name)} — ${escHtml(s.cidr)}</option>`).join("")
    || `<option value="">No subnets — add one first</option>`;
  if (cur && sel.querySelector(`option[value="${cur}"]`)) sel.value = cur;
  sel.onchange = updateScanPreview;
}

async function loadScanProfiles() {
  scanProfiles = await api("GET", "/api/scan-profiles");
  const sel = document.getElementById("scanProfile");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = scanProfiles.map(p => `<option value="${p.id}">${escHtml(p.name)}${p.builtin ? "" : " ·custom"}</option>`).join("");
  if (cur && sel.querySelector(`option[value="${cur}"]`)) sel.value = cur;
  else { const std = scanProfiles.find(p => p.name === "Standard"); if (std) sel.value = String(std.id); }
}

function _scanOptsFromFields() {
  return {
    ports:      document.getElementById("scanPorts").value,
    top_n:      parseInt(document.getElementById("scanTopN").value) || 100,
    port_range: document.getElementById("scanPortRange").value.trim(),
    sv:         document.getElementById("scanSv").checked,
    os:         document.getElementById("scanOs").checked,
    timing:     document.getElementById("scanTiming").value,
    pn:         document.getElementById("scanPn").checked,
    udp:        document.getElementById("scanUdp").checked,
    scripts:    document.getElementById("scanScripts").value.trim(),
  };
}

function _scanTargetCidr() {
  const id = parseInt(document.getElementById("scanTarget").value);
  const s = subnets.find(x => x.id === id);
  return s ? s.cidr : "TARGET";
}

function syncScanConditional() {
  const p = document.getElementById("scanPorts").value;
  document.getElementById("scanTopN").style.display      = p === "topN"   ? "" : "none";
  document.getElementById("scanPortRange").style.display = p === "custom" ? "" : "none";
}
function onScanFieldChange() { syncScanConditional(); updateScanPreview(); }

let _scanPreviewTimer = null;
function updateScanPreview() {
  clearTimeout(_scanPreviewTimer);
  _scanPreviewTimer = setTimeout(async () => {
    try {
      const { command } = await api("POST", `/api/scan/preview?target=${encodeURIComponent(_scanTargetCidr())}`, _scanOptsFromFields());
      document.getElementById("scanPreview").textContent = command;
    } catch { /* ignore */ }
  }, 120);
}

function applyScanProfile() {
  const sel = document.getElementById("scanProfile");
  const p = scanProfiles.find(x => String(x.id) === sel.value);
  document.getElementById("scanProfileDelete").style.display = (p && !p.builtin) ? "" : "none";
  if (!p) { updateScanPreview(); return; }
  const d = { ports:"top1000", top_n:100, port_range:"", sv:true, os:true, timing:"T4", pn:false, udp:false, scripts:"" };
  const o = { ...d, ...(p.options || {}) };
  document.getElementById("scanPorts").value     = o.ports;
  document.getElementById("scanTopN").value      = o.top_n;
  document.getElementById("scanPortRange").value = o.port_range || "";
  document.getElementById("scanSv").checked      = !!o.sv;
  document.getElementById("scanOs").checked      = !!o.os;
  document.getElementById("scanTiming").value    = o.timing || "T4";
  document.getElementById("scanPn").checked      = !!o.pn;
  document.getElementById("scanUdp").checked     = !!o.udp;
  document.getElementById("scanScripts").value   = o.scripts || "";
  syncScanConditional();
  updateScanPreview();
}

async function saveScanProfile() {
  const name = prompt("Save these settings as a profile named:");
  if (!name || !name.trim()) return;
  try {
    const p = await api("POST", "/api/scan-profiles", { name: name.trim(), options: _scanOptsFromFields() });
    await loadScanProfiles();
    document.getElementById("scanProfile").value = String(p.id);
    applyScanProfile();
    showToast("Profile saved");
  } catch (e) { alert("Error: " + e.message); }
}

async function deleteScanProfile() {
  const sel = document.getElementById("scanProfile");
  const p = scanProfiles.find(x => String(x.id) === sel.value);
  if (!p || p.builtin) return;
  if (!confirm(`Delete profile "${p.name}"?`)) return;
  try {
    await api("DELETE", `/api/scan-profiles/${p.id}`);
    await loadScanProfiles();
    applyScanProfile();
  } catch (e) { alert("Error: " + e.message); }
}

async function runScanFromBuilder() {
  const id = parseInt(document.getElementById("scanTarget").value);
  if (!id) return alert("Pick a target subnet.");
  try {
    const { run_id } = await api("POST", `/api/scan/${id}`, _scanOptsFromFields());
    activeRunId = run_id;
    startPolling(id);
    setScanTab("history");
    await loadScans();
    showToast("Scan started");
  } catch (e) { alert("Error: " + e.message); }
}

async function loadScans() {
  const scans = await api("GET", "/api/scans");
  const wrap = document.getElementById("scansWrap");
  if (!scans.length) {
    wrap.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-3);font-size:12px">No scans yet.</div>`;
    return;
  }
  wrap.innerHTML = `
    <div class="scans-toolbar">
      <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-2);cursor:pointer">
        <input type="checkbox" id="scansSelectAll" data-change="scansToggleAllBox" style="accent-color:var(--accent)">
        Select all
      </label>
      <button class="btn btn-danger" style="font-size:11px;padding:4px 10px" data-click="scansDeleteSelected">Delete selected</button>
    </div>
    ${scans.map(s => {
      const isProbe = s.type === "probe";
      const target = isProbe
        ? `<span class="mono" style="color:var(--accent)">${escHtml(s.host_ip || "?")}</span>`
        : `${escHtml(s.subnet_name || "?")} <span class="mono" style="color:var(--text-3);font-weight:400">${escHtml(s.cidr || "")}</span>`;
      const started = fmtLocal(s.started_at);
      const running = s.status === "running";
      const live = s.live_status || (running ? "starting" : s.status);
      const pct = s.progress || 0;
      const runLabel = live === "discovering" ? "discovering…"
        : live === "scanning" ? `scanning ${pct}%`
        : live === "starting" ? "starting…" : "running…";
      const bits = s.status === "skipped"
        ? [started, `<span style="color:var(--yellow)">skipped${s.note ? ": " + escHtml(s.note) : ""}</span>`]
        : running
        ? [started, `${runLabel} · <span class="scan-elapsed" data-started="${_ts(s.started_at)}">${fmtDur((Date.now() - _ts(s.started_at)) / 1000)}</span>`]
        : [started, `${s.hosts_found || 0} hosts`, scanDurationHTML(s)].filter(Boolean);
      const detail = (isProbe ? "probe · " : "") + bits.join(" · ");
      const progressBar = running
        ? `<div class="scan-progress"><div class="scan-progress-fill" style="width:${pct}%"></div></div>`
        : "";
      const typeBadge = isProbe
        ? `<span class="tag" style="background:oklch(40% 0.1 280);color:oklch(80% 0.1 280);font-size:10px">probe</span>`
        : s.schedule_name
        ? `<span class="tag" style="background:oklch(38% 0.09 200);color:oklch(82% 0.1 200);font-size:10px" title="Scheduled: ${escHtml(s.schedule_name)}">⏱ ${escHtml(s.schedule_name)}</span>`
        : `<span class="tag" style="background:var(--surface2);color:var(--text-3);font-size:10px">scan</span>`;
      const statusTag = running
        ? `<span class="tag tag-running" style="font-size:10px">${live === "scanning" ? "scanning" : "running"}</span>`
        : `<span class="tag tag-${escHtml(s.status)}" style="font-size:10px">${escHtml(s.status)}</span>`;
      const cancelBtn = running
        ? `<button class="btn-ghost" style="font-size:11px;padding:2px 7px;flex-shrink:0;color:var(--yellow)" data-click="cancelScanRun" data-args="[${s.id}]" title="Stop">■</button>`
        : "";
      return `
        <div class="scan-card" id="scan-card-${s.id}">
          <input type="checkbox" class="scan-checkbox" data-id="${s.id}" style="accent-color:var(--accent);flex-shrink:0" data-change="scansUpdateBulkBtn">
          <div class="scan-indicator ${live}"></div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:500;font-size:12px">${target}</div>
            <div class="mono" style="font-size:10px;color:var(--text-3);margin-top:2px">${detail}</div>
            ${progressBar}
          </div>
          ${typeBadge}
          ${statusTag}
          ${cancelBtn}
          <button class="btn-ghost btn-danger" style="font-size:12px;padding:2px 7px;flex-shrink:0" data-click="deleteScanRun" data-args="[${s.id}]" title="Delete">✕</button>
        </div>`;
    }).join("")}`;

  // Auto-refresh while any scan is still running so progress stays live.
  _scheduleScansPoll(scans.some(s => s.status === "running"));
}

let _scansPollTimer = null;
function _scheduleScansPoll(anyRunning) {
  clearTimeout(_scansPollTimer);
  if (!anyRunning) return;
  _scansPollTimer = setTimeout(() => {
    // only keep polling while the Scan Log sub-tab is visible
    if (document.getElementById("scan-panel-history")?.style.display !== "none") loadScans();
  }, 2000);
}

async function cancelScanRun(id) {
  try { await api("POST", `/api/scan/${id}/cancel`); } catch (_) {}
  await loadScans();
}

// Parse a backend timestamp: ISO-with-offset as-is, or SQLite "Y-m-d H:M:S" (UTC).
function _toDate(ts) {
  if (!ts) return null;
  return new Date(/[TZ+]/.test(ts) ? ts : ts.replace(" ", "T") + "Z");
}
function _ts(s) { const d = _toDate(s); return d ? d.getTime() : null; }

// Relative time until a future timestamp, e.g. "in 8h 32m" / "due now".
function fmtRelFuture(ts) {
  const d = _toDate(ts);
  if (!d) return "";
  let s = (d.getTime() - Date.now()) / 1000;
  if (s <= 30) return "due now";
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return `in ${h}h${m ? " " + m + "m" : ""}`; }
  const days = Math.floor(s / 86400), h = Math.round((s % 86400) / 3600);
  return `in ${days}d${h ? " " + h + "h" : ""}`;
}

// Show a stored (UTC) timestamp in the configured timezone (APP_TZ), else browser-local.
function fmtLocal(ts) {
  const d = _toDate(ts);
  if (!d) return "";
  return d.toLocaleString([], {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: APP_TZ || undefined,
  });
}

function fmtDur(secs) {
  secs = Math.max(0, Math.round(secs));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60), s = secs % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function scanDurationHTML(s) {
  const start = _ts(s.started_at);
  if (!start) return "";
  if (s.status === "running") {
    return `<span class="scan-elapsed" data-started="${start}">running… ${fmtDur((Date.now() - start) / 1000)}</span>`;
  }
  const end = _ts(s.completed_at);
  if (!end || ["skipped", "cancelled", "error"].includes(s.status)) return "";
  return `took ${fmtDur((end - start) / 1000)}`;
}

// Tick the live elapsed timer on running Scan Log rows once a second. Only the
// elapsed span is updated; the "scanning N%" label is refreshed by the 2s poll.
setInterval(() => {
  document.querySelectorAll(".scan-elapsed[data-started]").forEach(el => {
    el.textContent = fmtDur((Date.now() - parseInt(el.dataset.started)) / 1000);
  });
}, 1000);

function scansToggleAll(checked) {
  document.querySelectorAll(".scan-checkbox").forEach(cb => cb.checked = checked);
  scansUpdateBulkBtn();
}

function scansUpdateBulkBtn() {
  const allCbs = document.querySelectorAll(".scan-checkbox");
  const allSelectAll = document.getElementById("scansSelectAll");
  if (allSelectAll) {
    const checkedCount = document.querySelectorAll(".scan-checkbox:checked").length;
    allSelectAll.checked = checkedCount === allCbs.length && allCbs.length > 0;
    allSelectAll.indeterminate = checkedCount > 0 && checkedCount < allCbs.length;
  }
}

async function deleteScanRun(id) {
  if (!confirm("Delete this scan/probe record?")) return;
  await api("DELETE", `/api/scans/${id}`);
  document.getElementById(`scan-card-${id}`)?.remove();
  if (!document.querySelector(".scan-card")) await loadScans();
}

async function scansDeleteSelected() {
  const ids = Array.from(document.querySelectorAll(".scan-checkbox:checked")).map(cb => parseInt(cb.dataset.id));
  if (!ids.length) return showToast("Nothing selected");
  if (!confirm(`Delete ${ids.length} record${ids.length > 1 ? "s" : ""}?`)) return;
  await api("DELETE", "/api/scans", { ids });
  await loadScans();
}

// ── Scan schedules ────────────────────────────────────────────────────────────

const _DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
let scanSchedules = [];

function _schedTimingText(s) {
  const win = s.window_start && s.window_end ? ` · only ${s.window_start}–${s.window_end}` : "";
  if (s.timing_type === "interval") {
    const h = s.interval_hours;
    const base = `every ${h === 1 ? "hour" : h + " hours"}`;
    return (s.at_time ? `${base} from ${s.at_time}` : base) + win;
  }
  const days = (s.days_of_week || "").split(",").filter(d => d !== "");
  const label = days.length === 7 ? "daily"
    : days.map(d => _DAY_NAMES[+d]).join(", ");
  return `${escHtml(label)} at ${s.at_time || "?"}${win}`;
}

function _schedTargetText(s) {
  const where = s.subnet_id ? escHtml(s.subnet_name || `subnet ${s.subnet_id}`) : "All subnets";
  const filt = s.host_filter === "all" ? "whole range" : `${s.host_filter} only`;
  return `${where} · ${filt}`;
}

async function loadSchedules() {
  const wrap = document.getElementById("schedulesWrap");
  if (!scanProfiles || !scanProfiles.length) { try { await loadScanProfiles(); } catch {} }
  scanSchedules = await api("GET", "/api/scan-schedules");
  if (!scanSchedules.length) {
    wrap.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-3);font-size:12px">No schedules yet — create one to run scans automatically.</div>`;
    return;
  }
  wrap.innerHTML = scanSchedules.map(s => {
    const last = s.last_run ? `last run ${fmtLocal(s.last_run)}` : "never run yet";
    const next = !s.enabled ? `<span style="color:var(--text-3)">next run — paused</span>`
      : s.next_run ? `next run <span style="color:var(--accent)">${fmtLocal(s.next_run)} · ${fmtRelFuture(s.next_run)}</span>`
      : (s.window_start && s.window_end) ? `<span style="color:var(--yellow)">never — active window excludes all run times</span>`
      : `next run —`;
    return `
      <div class="scan-card" style="align-items:center">
        <label class="switch" title="${s.enabled ? "Enabled" : "Disabled"}" style="flex-shrink:0">
          <input type="checkbox" ${s.enabled ? "checked" : ""} data-change="toggleScheduleBox" data-args="[${s.id}]">
          <span class="switch-slider"></span>
        </label>
        <div style="flex:1;min-width:0">
          <div style="font-weight:500;font-size:12px">${escHtml(s.name)}${s.silent ? ` <span title="Silent: records changes, sends no alert (still in the daily digest)">🔕</span>` : ""}${s.enabled ? "" : ` <span style="color:var(--text-3);font-weight:400">(paused)</span>`}</div>
          <div class="mono" style="font-size:10px;color:var(--text-3);margin-top:2px">
            ${_schedTargetText(s)} · ${escHtml(s.profile_name || "no profile")} · ${_schedTimingText(s)}
          </div>
          <div style="font-size:10px;color:var(--text-3);margin-top:1px">${last} · ${next}</div>
        </div>
        <button class="btn" style="font-size:11px;padding:3px 9px;flex-shrink:0" data-click="runScheduleNow" data-args="[${s.id}]" title="Run now">▶ Run now</button>
        <button class="btn-ghost" style="font-size:12px;padding:2px 7px;flex-shrink:0" data-click="editSchedule" data-args="[${s.id}]" title="Edit">✎</button>
        <button class="btn-ghost btn-danger" style="font-size:12px;padding:2px 7px;flex-shrink:0" data-click="deleteSchedule" data-args="[${s.id}]" title="Delete">✕</button>
      </div>`;
  }).join("");
}

function openScheduleEditor(sched) {
  // Subnet dropdown: All + each subnet
  document.getElementById("schedSubnet").innerHTML =
    `<option value="">All subnets</option>` +
    subnets.map(s => `<option value="${s.id}">${escHtml(s.name)} — ${escHtml(s.cidr)}</option>`).join("");
  // Profile dropdown (built-ins + custom)
  document.getElementById("schedProfile").innerHTML =
    (scanProfiles || []).map(p => `<option value="${p.id}">${escHtml(p.name)}${p.builtin ? "" : " ·custom"}</option>`).join("");
  // Day checkboxes
  document.getElementById("schedDays").innerHTML = _DAY_NAMES.map((d, i) =>
    `<label><input type="checkbox" class="sched-day" value="${i}"> ${d}</label>`).join("");

  const s = sched || {};
  document.getElementById("scheduleModalTitle").textContent = sched ? "Edit schedule" : "New schedule";
  document.getElementById("schedSaveBtn").textContent       = sched ? "Save" : "Create";
  document.getElementById("schedEditId").value  = sched ? s.id : "";
  document.getElementById("schedName").value    = s.name || "";
  document.getElementById("schedSubnet").value  = s.subnet_id || "";
  document.getElementById("schedFilter").value  = s.host_filter || "all";
  if (s.profile_id) document.getElementById("schedProfile").value = String(s.profile_id);
  document.getElementById("schedEnabled").checked = sched ? !!s.enabled : true;
  document.getElementById("schedSilent").checked  = !!s.silent;

  const timing = s.timing_type || "interval";
  document.querySelector(`input[name="schedTiming"][value="${timing}"]`).checked = true;
  document.getElementById("schedInterval").value = s.interval_hours || 6;
  document.getElementById("schedAnchor").value = (s.timing_type === "interval" ? s.at_time : "") || "";
  const days = (s.days_of_week || "").split(",").filter(d => d !== "");
  document.querySelectorAll(".sched-day").forEach(cb => { cb.checked = days.includes(cb.value); });
  document.getElementById("schedAtTime").value = s.at_time || "03:00";
  document.getElementById("schedWinStart").value = s.window_start || "";
  document.getElementById("schedWinEnd").value   = s.window_end || "";

  onSchedFilterChange();
  onSchedTimingChange();
  document.getElementById("scheduleModal").classList.add("open");
}

function editSchedule(id) {
  openScheduleEditor(scanSchedules.find(s => s.id === id));
}

function closeScheduleEditor() {
  document.getElementById("scheduleModal").classList.remove("open");
}

function onSchedFilterChange() {
  const filtered = document.getElementById("schedFilter").value !== "all";
  document.getElementById("schedFilterNote").style.display = filtered ? "" : "none";
}

function onSchedTimingChange() {
  const t = document.querySelector('input[name="schedTiming"]:checked').value;
  document.getElementById("schedIntervalRow").style.display = t === "interval" ? "" : "none";
  document.getElementById("schedAnchorRow").style.display   = t === "interval" ? "" : "none";
  document.getElementById("schedWeeklyRows").style.display  = t === "weekly"   ? "" : "none";
}

async function saveSchedule() {
  const id = document.getElementById("schedEditId").value;
  const timing = document.querySelector('input[name="schedTiming"]:checked').value;
  const days = Array.from(document.querySelectorAll(".sched-day:checked")).map(cb => cb.value);
  const payload = {
    name:           document.getElementById("schedName").value.trim(),
    enabled:        document.getElementById("schedEnabled").checked,
    subnet_id:      document.getElementById("schedSubnet").value ? parseInt(document.getElementById("schedSubnet").value) : null,
    host_filter:    document.getElementById("schedFilter").value,
    profile_id:     document.getElementById("schedProfile").value ? parseInt(document.getElementById("schedProfile").value) : null,
    timing_type:    timing,
    interval_hours: timing === "interval" ? parseFloat(document.getElementById("schedInterval").value) : null,
    days_of_week:   timing === "weekly" ? days.join(",") : null,
    at_time:        timing === "weekly" ? document.getElementById("schedAtTime").value
                                        : (document.getElementById("schedAnchor").value || null),
    window_start:   document.getElementById("schedWinStart").value || null,
    window_end:     document.getElementById("schedWinEnd").value || null,
    silent:         document.getElementById("schedSilent").checked,
  };
  if (!payload.name) return showToast("Give the schedule a name");
  if (timing === "interval" && !(payload.interval_hours > 0)) return showToast("Interval must be greater than 0");
  if (timing === "weekly" && !days.length) return showToast("Pick at least one day");
  if (!!payload.window_start !== !!payload.window_end) return showToast("Set both window times, or leave both empty");
  try {
    if (id) await api("PUT", `/api/scan-schedules/${id}`, payload);
    else    await api("POST", "/api/scan-schedules", payload);
    closeScheduleEditor();
    await loadSchedules();
    showToast(id ? "Schedule saved" : "Schedule created");
  } catch (e) { showToast("Failed: " + e.message); }
}

async function toggleSchedule(id, enabled) {
  const s = scanSchedules.find(x => x.id === id);
  if (!s) return;
  await api("PUT", `/api/scan-schedules/${id}`, { ...s, enabled,
    subnet_id: s.subnet_id, profile_id: s.profile_id });
  await loadSchedules();
}

async function deleteSchedule(id) {
  if (!confirm("Delete this schedule?")) return;
  await api("DELETE", `/api/scan-schedules/${id}`);
  await loadSchedules();
}

async function runScheduleNow(id) {
  try {
    const r = await api("POST", `/api/scan-schedules/${id}/run`);
    const started = (r.started || []).length, skipped = (r.skipped || []).length;
    showToast(started ? `Started ${started} scan${started > 1 ? "s" : ""}${skipped ? `, ${skipped} skipped` : ""} — see Scan Log`
                      : (skipped ? `Skipped ${skipped} (already running or no matching hosts)` : "Nothing to run"));
    if (started) {
      setScanTab("history");     // jump to Scan Log so progress is visible
      await loadScans();
    } else {
      await loadSchedules();
    }
  } catch (e) { showToast("Failed: " + e.message); }
}


registerActions({
  setScanTab, applyScanProfile, deleteScanProfile, onScanFieldChange, updateScanPreview,
  saveScanProfile, runScanFromBuilder, openScheduleEditor, clearChanges,
  onSchedFilterChange, onSchedTimingChange, closeScheduleEditor, saveSchedule,
  scansDeleteSelected, scansUpdateBulkBtn, cancelScanRun, deleteScanRun,
  runScheduleNow, editSchedule, deleteSchedule, openChangeHost,
  scansToggleAllBox: function () { scansToggleAll(this.checked); },
  toggleScheduleBox: function (id) { toggleSchedule(id, this.checked); },
});
