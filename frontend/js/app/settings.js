// Boltarr — Settings: AI, Security (strict-mode check), Backup & Restore.
// Part of the app split from app.js (F-08); files share globals and load in order (see index.html).

// ── AI Settings ───────────────────────────────────────────────────────────────

const PROVIDER_URLS = {
  ollama:    "http://localhost:11434",
  openai:    "https://api.openai.com/v1",
  anthropic: "",
};

const PROVIDER_KEY_PLACEHOLDER = {
  openai:    "sk-…",
  anthropic: "sk-ant-…",
};

function populateTimezones() {
  const sel = document.getElementById("setTimezone");
  if (!sel || sel.dataset.filled) return;
  let zones = [];
  try { zones = Intl.supportedValuesOf("timeZone"); } catch { zones = []; }
  sel.innerHTML = `<option value="">Server default (UTC)</option>` +
    zones.map(z => `<option value="${z}">${z}</option>`).join("");
  sel.dataset.filled = "1";
}

function updateTzPreview() {
  const tz = document.getElementById("setTimezone").value;
  const el = document.getElementById("setTzPreview");
  try {
    const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: tz || undefined });
    el.textContent = `Current time: ${t}${tz ? " (" + tz + ")" : " (server)"}`;
  } catch { el.textContent = ""; }
}

// Load just the configured timezone at startup so all displayed times are right
// before Settings is ever opened.
async function loadAppTz() {
  try {
    const s = await api("GET", "/api/settings");
    APP_TZ = (s.general && s.general.timezone) || "";
  } catch (_) {}
}

async function openSettings() {
  renderLoginSettings();
  try {
    const { general, llm, notifications, statuspage, change_tracking, change_alerts, liveness, ip_history, security } = await api("GET", "/api/settings");
    document.getElementById("setFrameOrigins").value = (security && security.frame_origins) || "";
    loadCspReports();
    populateTimezones();
    APP_TZ = (general && general.timezone) || "";
    document.getElementById("setTimezone").value = APP_TZ;
    updateTzPreview();
    document.getElementById("setProvider").value     = llm.provider || "none";
    document.getElementById("setBaseUrl").value      = llm.base_url || "";
    document.getElementById("setApiKey").value       = llm.api_key  || "";
    document.getElementById("setModel").value        = llm.model    || "";
    document.getElementById("setTimeout").value      = llm.timeout      || 120;
    document.getElementById("setLongTimeout").value  = llm.long_timeout || 600;
    onSettingsProviderChange();
    document.getElementById("setTestResult").style.display = "none";

    const n = notifications || {};
    document.getElementById("setNtfyEnabled").checked = !!n.enabled;
    document.getElementById("setNtfyServer").value    = n.server || "";
    document.getElementById("setNtfyTopic").value     = n.topic  || "";
    document.getElementById("setNtfyToken").value     = n.token  || "";
    document.getElementById("setCheckSeconds").value  = n.check_seconds ?? 60;
    document.getElementById("setAlertAfter").value    = n.alert_after_minutes ?? 5;
    document.getElementById("setQuietEnabled").checked = !!n.quiet_enabled;
    document.getElementById("setSuppressHostDown").checked = n.suppress_when_host_down !== false;
    if (n.quiet_start) document.getElementById("setQuietStart").value = n.quiet_start;
    if (n.quiet_end)   document.getElementById("setQuietEnd").value   = n.quiet_end;
    onQuietToggle();
    document.getElementById("setNtfyTestResult").style.display = "none";

    const sp = statuspage || {};
    document.getElementById("setSpEnabled").checked = !!sp.enabled;
    document.getElementById("setSpUrl").value   = sp.url   || "";
    document.getElementById("setSpToken").value = sp.token || "";
    document.getElementById("setSpTestResult").style.display = "none";

    const ct = change_tracking || {};
    document.getElementById("setCtEnabled").checked          = !!ct.enabled;
    document.getElementById("setCtHostNew").checked          = ct.host_new         !== false;
    document.getElementById("setCtPortOpened").checked       = ct.port_opened      !== false;
    document.getElementById("setCtPortClosed").checked       = ct.port_closed      !== false;
    document.getElementById("setCtMacChanged").checked       = ct.mac_changed      !== false;
    document.getElementById("setCtHostnameChanged").checked  = ct.hostname_changed !== false;
    document.getElementById("setCtOffline").checked          = ct.host_offline     !== false;
    document.getElementById("setCtOnline").checked           = ct.host_online      !== false;
    document.getElementById("setCtRetention").value          = ct.retention_days ?? 90;

    const ih = ip_history || {};
    document.getElementById("setIphStale").value = ih.stale_days ?? 30;
    document.getElementById("setIphGone").value  = ih.gone_days ?? 60;

    const lv = liveness || {};
    document.getElementById("setLvEnabled").checked  = lv.enabled !== false;
    document.getElementById("setLvInterval").value   = lv.interval_minutes ?? 3;
    document.getElementById("setLvOfflineAfter").value = lv.offline_after ?? 3;

    const ca = change_alerts || {};
    document.getElementById("setCaEnabled").checked          = !!ca.enabled;
    document.getElementById("setCaScope").value              = ca.scope || "static";
    document.getElementById("setCaHostNew").checked          = ca.host_new         !== false;
    document.getElementById("setCaPortOpened").checked       = ca.port_opened      !== false;
    document.getElementById("setCaPortClosed").checked       = !!ca.port_closed;
    document.getElementById("setCaMacChanged").checked       = !!ca.mac_changed;
    document.getElementById("setCaHostnameChanged").checked  = !!ca.hostname_changed;
    document.getElementById("setCaOffline").checked          = ca.host_offline     !== false;
    document.getElementById("setCaOnline").checked           = ca.host_online      !== false;
    document.getElementById("setCaIncludeMac").checked       = !!ca.include_mac;
    document.getElementById("setCaIncludeAliases").checked   = ca.include_aliases !== false;
    document.getElementById("setCaOnScan").checked           = ca.on_scan          !== false;
    document.getElementById("setCaDigest").checked           = ca.digest_enabled   !== false;
    document.getElementById("setCaDigestTime").value         = ca.digest_time || "08:00";
  } catch (e) { console.warn("Settings load:", e.message); }
  document.getElementById("settingsModal").classList.add("open");
}

function closeSettings() {
  document.getElementById("settingsModal").classList.remove("open");
}

function onQuietToggle() {
  const on = document.getElementById("setQuietEnabled").checked;
  document.getElementById("setQuietRange").style.display = on ? "inline-flex" : "none";
}

function onSettingsProviderChange() {
  const p = document.getElementById("setProvider").value;
  const urlRow = document.getElementById("setUrlRow");
  const keyRow = document.getElementById("setKeyRow");
  const urlInput = document.getElementById("setBaseUrl");
  const keyInput = document.getElementById("setApiKey");

  urlRow.style.display = (p === "ollama" || p === "openai") ? "" : "none";
  keyRow.style.display = (p === "openai" || p === "anthropic") ? "" : "none";

  if (urlInput.value === "" || Object.values(PROVIDER_URLS).includes(urlInput.value)) {
    urlInput.value = PROVIDER_URLS[p] || "";
  }
  if (PROVIDER_KEY_PLACEHOLDER[p]) {
    keyInput.placeholder = PROVIDER_KEY_PLACEHOLDER[p];
  }
}

// ── Security: strict-mode check (CSP report-only findings) ────────────────────

async function loadCspReports() {
  const sum = document.getElementById("cspSummary"), list = document.getElementById("cspList");
  let rows = [];
  try { rows = await api("GET", "/api/security/reports"); } catch (_) { sum.textContent = "Couldn't load the report."; return; }
  // A frame block is the protection working (another site tried to embed Boltarr),
  // never a broken Boltarr page — so it gets its own calm line, not the red warning.
  const isFrame  = r => r.directive === "frame-ancestors";
  const framed   = rows.filter(r => r.mode === "enforced" && isFrame(r));
  const enforced = rows.filter(r => r.mode === "enforced" && !isFrame(r));
  const strict   = rows.filter(r => r.mode !== "enforced");
  const parts = [];
  if (enforced.length) parts.push(`<span style="color:var(--red)">⚠ ${enforced.length} thing${enforced.length === 1 ? "" : "s"} blocked by the current rules — something may not work</span>`);
  if (framed.length) {
    const times = framed.reduce((n, r) => n + r.count, 0);
    parts.push(`<span style="color:var(--text-2)">🛡 A site was stopped from showing Boltarr in a frame (×${times}). If that was your dashboard, add it under Allowed dashboards.</span>`);
  }
  parts.push(strict.length
    ? `${strict.length} place${strict.length === 1 ? "" : "s"} would be blocked in strict mode`
    : "Nothing reported yet — use Boltarr normally and check back.");
  sum.innerHTML = parts.join("<br>");
  list.innerHTML = rows.length ? rows.slice(0, 100).map(r => {
    const where = r.source ? `${r.source.replace(location.origin, "")}${r.line ? ":" + r.line : ""}` : "";
    return `<div class="csp-row${r.mode === "enforced" && !isFrame(r) ? " csp-enforced" : ""}">
      <span class="mono">${escHtml(r.directive)}</span>
      <span class="mono text-3">${escHtml(r.sample || r.blocked || "")}</span>
      <span class="text-3">${escHtml(where)} · ×${r.count}</span></div>`;
  }).join("") : "";
  document.getElementById("cspListBtn").hidden = !rows.length;
}

function toggleCspList() {
  const list = document.getElementById("cspList");
  list.hidden = !list.hidden;
  document.getElementById("cspListBtn").textContent = list.hidden ? "Show details" : "Hide details";
}

async function clearCspReports() {
  await api("DELETE", "/api/security/reports");
  loadCspReports();
}

async function saveSettings() {
  const payload = {
    provider:     document.getElementById("setProvider").value,
    base_url:     document.getElementById("setBaseUrl").value.trim(),
    api_key:      document.getElementById("setApiKey").value,
    model:        document.getElementById("setModel").value.trim(),
    timeout:      parseInt(document.getElementById("setTimeout").value) || 120,
    long_timeout: parseInt(document.getElementById("setLongTimeout").value) || 600,
  };
  const ntfyPayload = {
    enabled: document.getElementById("setNtfyEnabled").checked,
    server:  document.getElementById("setNtfyServer").value.trim(),
    topic:   document.getElementById("setNtfyTopic").value.trim(),
    token:   document.getElementById("setNtfyToken").value,
    check_seconds: Math.max(15, Math.min(600, parseInt(document.getElementById("setCheckSeconds").value) || 60)),
    alert_after_minutes: parseInt(document.getElementById("setAlertAfter").value) || 0,
    quiet_enabled: document.getElementById("setQuietEnabled").checked,
    quiet_start:   document.getElementById("setQuietStart").value,
    quiet_end:     document.getElementById("setQuietEnd").value,
    suppress_when_host_down: document.getElementById("setSuppressHostDown").checked,
  };
  const spPayload = {
    enabled: document.getElementById("setSpEnabled").checked,
    url:     document.getElementById("setSpUrl").value.trim(),
    token:   document.getElementById("setSpToken").value,
  };
  const ctPayload = {
    enabled:          document.getElementById("setCtEnabled").checked,
    host_new:         document.getElementById("setCtHostNew").checked,
    port_opened:      document.getElementById("setCtPortOpened").checked,
    port_closed:      document.getElementById("setCtPortClosed").checked,
    mac_changed:      document.getElementById("setCtMacChanged").checked,
    hostname_changed: document.getElementById("setCtHostnameChanged").checked,
    host_offline:     document.getElementById("setCtOffline").checked,
    host_online:      document.getElementById("setCtOnline").checked,
    retention_days:   parseInt(document.getElementById("setCtRetention").value) || 90,
  };
  const lvPayload = {
    enabled:          document.getElementById("setLvEnabled").checked,
    interval_minutes: parseInt(document.getElementById("setLvInterval").value) || 3,
    offline_after:    parseInt(document.getElementById("setLvOfflineAfter").value) || 3,
  };
  const caPayload = {
    enabled:          document.getElementById("setCaEnabled").checked,
    scope:            document.getElementById("setCaScope").value,
    host_new:         document.getElementById("setCaHostNew").checked,
    port_opened:      document.getElementById("setCaPortOpened").checked,
    port_closed:      document.getElementById("setCaPortClosed").checked,
    mac_changed:      document.getElementById("setCaMacChanged").checked,
    hostname_changed: document.getElementById("setCaHostnameChanged").checked,
    host_offline:     document.getElementById("setCaOffline").checked,
    host_online:      document.getElementById("setCaOnline").checked,
    include_mac:      document.getElementById("setCaIncludeMac").checked,
    include_aliases:  document.getElementById("setCaIncludeAliases").checked,
    on_scan:          document.getElementById("setCaOnScan").checked,
    digest_enabled:   document.getElementById("setCaDigest").checked,
    digest_time:      document.getElementById("setCaDigestTime").value,
  };
  const generalPayload = { timezone: document.getElementById("setTimezone").value };
  try {
    // One request: the server checks every section and saves all or nothing
    await api("PUT", "/api/settings/all", {
      general:         generalPayload,
      llm:             payload,
      notifications:   ntfyPayload,
      statuspage:      spPayload,
      change_tracking: ctPayload,
      liveness:        lvPayload,
      ip_history: {
        stale_days: parseInt(document.getElementById("setIphStale").value, 10) || 30,
        gone_days:  parseInt(document.getElementById("setIphGone").value, 10)  || 60,
      },
      change_alerts:   caPayload,
      security:        { frame_origins: document.getElementById("setFrameOrigins").value.trim() },
    });
    APP_TZ = generalPayload.timezone;
    closeSettings();
    await loadModels();
    updateAiStatusDot(payload.provider !== "none");
    // times may now render in a different zone — refresh the visible time views
    if (document.getElementById("scan-panel-history")?.style.display !== "none") loadScans();
    if (document.getElementById("scan-panel-changes")?.style.display !== "none") loadChanges();
    if (document.getElementById("scan-panel-schedules")?.style.display !== "none") loadSchedules();
    if (currentHostsTab === "iphistory" && document.getElementById("panel-hosts").classList.contains("active")) loadIpHistory();
    showToast("Settings saved");
  } catch (e) {
    alert("Settings not saved — nothing was changed.\n\n" + e.message);
  }
}

function generateStatusToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  const el = document.getElementById("setSpToken");
  el.type = "text";                        // reveal so it can be copied
  el.value = "boltarr_status_" + hex;
  el.focus(); el.select();
  showToast("Token generated — Save here, and put the same value in the status app's .env");
}

async function testStatusPush() {
  const resultEl = document.getElementById("setSpTestResult");
  resultEl.style.display = "";
  resultEl.className = "settings-test-result";
  resultEl.textContent = "Saving & pushing…";
  try {
    // save current values first so the push uses what's typed
    await api("PUT", "/api/settings/statuspage", {
      enabled: document.getElementById("setSpEnabled").checked,
      url:     document.getElementById("setSpUrl").value.trim(),
      token:   document.getElementById("setSpToken").value,
    });
    const r = await api("POST", "/api/statuspage/test");
    if (r.ok) {
      resultEl.className = "settings-test-result ok";
      resultEl.textContent = "✓ Pushed to the status app";
    } else {
      resultEl.className = "settings-test-result err";
      resultEl.textContent = "✗ " + (r.error || "failed");
    }
  } catch (e) {
    resultEl.className = "settings-test-result err";
    resultEl.textContent = "✗ " + e.message;
  }
}

async function testNotification() {
  const resultEl = document.getElementById("setNtfyTestResult");
  resultEl.style.display = "";
  resultEl.className = "settings-test-result";
  resultEl.textContent = "Sending…";
  try {
    const result = await api("POST", "/api/notifications/test", {
      server: document.getElementById("setNtfyServer").value.trim(),
      topic:  document.getElementById("setNtfyTopic").value.trim(),
      token:  document.getElementById("setNtfyToken").value,
    });
    if (result.ok) {
      resultEl.className = "settings-test-result ok";
      resultEl.textContent = "✓ Sent — check your phone";
    } else {
      resultEl.className = "settings-test-result err";
      resultEl.textContent = "✗ " + (result.error || "failed");
    }
  } catch (e) {
    resultEl.className = "settings-test-result err";
    resultEl.textContent = "✗ " + e.message;
  }
}

async function testLLMConnection() {
  const resultEl = document.getElementById("setTestResult");
  resultEl.style.display = "";
  resultEl.className = "settings-test-result";
  resultEl.textContent = "Saving and testing…";
  try {
    // Save current form values first so the test uses what the user typed
    const payload = {
      provider:     document.getElementById("setProvider").value,
      base_url:     document.getElementById("setBaseUrl").value.trim(),
      api_key:      document.getElementById("setApiKey").value,
      model:        document.getElementById("setModel").value.trim(),
      timeout:      parseInt(document.getElementById("setTimeout").value) || 120,
      long_timeout: parseInt(document.getElementById("setLongTimeout").value) || 600,
    };
    await api("PUT", "/api/settings", payload);
    const result = await api("POST", "/api/settings/test");
    if (result.ok) {
      resultEl.classList.add("test-ok");
      const mList = result.models?.length ? result.models.slice(0,5).join(", ") : "no models listed";
      resultEl.textContent = `✓ Connected. Models: ${mList}`;
      await loadModels();
      updateAiStatusDot(true);
    } else {
      resultEl.classList.add("test-fail");
      resultEl.textContent = `✗ ${result.error}`;
    }
  } catch (e) {
    resultEl.classList.add("test-fail");
    resultEl.textContent = `✗ ${e.message}`;
  }
}

function updateAiStatusDot(configured) {
  const dot = document.getElementById("aiStatusDot");
  if (!dot) return;
  dot.className = "ai-status-dot " + (configured ? "ai-status-ok" : "ai-status-none");
}

function showToast(msg) {
  let t = document.getElementById("_toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "_toast";
    t.className = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("toast-show");
  setTimeout(() => t.classList.remove("toast-show"), 2500);
}


// ── Backup & Restore ─────────────────────────────────────────────────────────

function downloadBackup() { openBackupModal(); }

function openBackupModal() {
  const $ = id => document.getElementById(id);
  $("backupProtect").checked = true;
  $("backupPw").value = ""; $("backupPw2").value = "";
  $("backupErr").textContent = "";
  onBackupProtectChange();
  $("backupModal").classList.add("open");
  $("backupPw").focus();
}

function closeBackupModal() { document.getElementById("backupModal").classList.remove("open"); }

function onBackupProtectChange() {
  const on = document.getElementById("backupProtect").checked;
  document.getElementById("backupPwRows").hidden = !on;
  document.getElementById("backupNoPwWarn").hidden = on;
}

async function doBackup(e) {
  e?.preventDefault();
  const $ = id => document.getElementById(id);
  const protect = $("backupProtect").checked, pw = $("backupPw").value;
  $("backupErr").textContent = "";
  if (protect) {
    if (pw.length < 8) return void ($("backupErr").textContent = "Password must be at least 8 characters.");
    if (pw !== $("backupPw2").value) return void ($("backupErr").textContent = "The two passwords don't match.");
  }
  $("backupGoBtn").disabled = true;
  try {
    const r = await fetch("/api/backup", { method: "POST", headers: { "Content-Type": "application/json" },
                                           body: JSON.stringify({ password: protect ? pw : null }) });
    if (!r.ok) throw new Error(apiErrorText(await r.text()));
    const name = (r.headers.get("content-disposition") || "").match(/filename=([^;]+)/)?.[1] || "boltarr-backup.zip";
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    closeBackupModal();
    showToast(protect ? "Protected backup downloaded" : "Backup downloaded");
  } catch (err) {
    $("backupErr").textContent = "Backup failed: " + err.message;
  } finally {
    $("backupGoBtn").disabled = false;
  }
}

// Restore is two steps: upload + check (nothing changes, the summary is shown),
// then apply. The apply runs in place on the server — no restart — and the
// page reloads itself afterwards, then shows a "restored" banner.
let restoreToken = null;

function _uploadWithProgress(url, file, onPct, password) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("X-Boltarr", "1");
    xhr.upload.onprogress = e => { if (e.lengthComputable) onPct(Math.round(e.loaded / e.total * 100)); };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch (_) {}
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
      const d = body && body.detail;
      const err = new Error(d && d.message ? d.message : (apiErrorText(xhr.responseText) || `Upload failed (${xhr.status})`));
      err.code = d && d.code;
      reject(err);
    };
    xhr.onerror = () => reject(new Error("Upload failed — check the connection"));
    const form = new FormData();
    form.append("file", file);
    if (password) form.append("password", password);
    xhr.send(form);
  });
}

let restoreFile = null;

async function restoreBackup(input) {
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  closeSettings();
  restoreToken = null;
  restoreFile = file;
  document.getElementById("restoreFileName").textContent = file.name;
  document.getElementById("restoreModal").classList.add("open");
  await _checkRestoreFile();
}

async function _checkRestoreFile(password) {
  const $ = id => document.getElementById(id);
  $("restoreUpload").hidden = false;
  $("restorePwBox").hidden = true;
  $("restoreSummary").hidden = true;
  $("restoreGoBtn").disabled = true;
  const setPct = p => { $("restoreUploadBar").style.width = p + "%"; $("restoreUploadPct").textContent = p < 100 ? `${p}%` : "Checking backup…"; };
  setPct(0);
  try {
    const chk = await _uploadWithProgress("/api/restore/check", restoreFile, setPct, password);
    restoreToken = chk.token;
    showRestoreSummary(chk);
  } catch (e) {
    if (e.code === "password_required" || e.code === "wrong_password") {
      $("restoreUpload").hidden = true;
      $("restorePwMsg").textContent = e.code === "wrong_password"
        ? "That password didn't work — try again." : "This backup is password-protected.";
      $("restorePwBox").hidden = false;
      $("restorePw").value = "";
      $("restorePw").focus();
      return;
    }
    $("restoreModal").classList.remove("open");
    alert("This backup can't be restored — nothing was changed.\n\n" + e.message);
  }
}

function _cmpVersion(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function showRestoreSummary(chk) {
  const $ = id => document.getElementById(id);
  const b = chk.backup, cur = chk.current;
  $("restoreDate").textContent = fmtLocal(b.created_at) || b.created_at;
  $("restoreVersion").textContent = b.version ? `v${b.version}` : "unknown (older backup)";
  $("restoreSettings").textContent = b.has_settings ? "Yes — settings are replaced too" : "No — current settings are kept";
  $("restoreProtected").textContent = b.protected ? "Yes 🔒" : "No";
  const rows = [["Hosts", "hosts"], ["Services", "services"], ["Subnets", "subnets"], ["Links", "connections"]];
  $("restoreCompare").innerHTML = rows.map(([label, k]) => {
    const now = cur[k] ?? "—", after = b.counts[k] ?? "—";
    const diff = typeof now === "number" && typeof after === "number" && now !== after ? " restore-diff" : "";
    return `<tr><td>${label}</td><td class="mono">${now}</td><td class="mono${diff}">${after}</td></tr>`;
  }).join("");
  let note = "";
  if (chk.scan_running) note = "⏳ A scan is running. Wait for it to finish (or cancel it) before restoring.";
  else if (b.version && _cmpVersion(b.version, chk.current_version) > 0)
    note = `This backup was made by a newer Boltarr (v${b.version}) than this one (v${chk.current_version}). It will usually work, but update Boltarr first if you can.`;
  else if (b.version && _cmpVersion(b.version, chk.current_version) < 0)
    note = `Made by an older Boltarr (v${b.version}) — it's upgraded automatically while restoring.`;
  $("restoreNote").textContent = note;
  $("restoreNote").hidden = !note;
  $("restoreUpload").hidden = true;
  $("restoreSummary").hidden = false;
  $("restoreGoBtn").disabled = !!chk.scan_running;
}

function cancelRestore() {
  if (restoreToken) api("DELETE", `/api/restore/${restoreToken}`).catch(() => {});
  restoreToken = null;
  restoreFile = null;
  document.getElementById("restoreModal").classList.remove("open");
}

function _restoreStep(name, state) {   // state: active | done | fail
  const li = document.querySelector(`#restoreSteps [data-step="${name}"]`);
  if (li) li.className = state;
}

async function applyRestore() {
  if (!restoreToken) return;
  const $ = id => document.getElementById(id);
  const token = restoreToken;
  $("restoreModal").classList.remove("open");
  $("restoreSteps").querySelectorAll("li").forEach(li => li.className = "");
  $("restoreOverlayTitle").textContent = "Restoring…";
  $("restoreOverlayMsg").textContent = "";
  $("restoreOverlayClose").hidden = true;
  $("restoreOverlay").hidden = false;
  _restoreStep("upload", "done");
  _restoreStep("restore", "active");
  window.onbeforeunload = () => "A restore is in progress.";
  try {
    const res = await api("POST", `/api/restore/${token}`);
    restoreToken = null;
    _restoreStep("restore", "done");
    _restoreStep("monitor", "active");
    await new Promise(r => setTimeout(r, 600));   // loops resume as the request returns
    _restoreStep("monitor", "done");
    _restoreStep("reload", "active");
    $("restoreOverlayTitle").textContent = "✅ Restore complete";
    try { sessionStorage.setItem("boltarrRestored", res.backup.created_at); } catch (_) {}
    window.onbeforeunload = null;
    for (let n = 3; n > 0; n--) {
      $("restoreOverlayMsg").textContent = `Reloading in ${n}…`;
      await new Promise(r => setTimeout(r, 1000));
    }
    location.reload();
  } catch (e) {
    window.onbeforeunload = null;
    _restoreStep("restore", "fail");
    $("restoreOverlayTitle").textContent = "Restore didn't happen";
    $("restoreOverlayMsg").textContent = e.message + " Your data is unchanged.";
    $("restoreOverlayClose").hidden = false;
  }
}

function closeRestoreOverlay() {
  document.getElementById("restoreOverlay").hidden = true;
}

// After the post-restore reload: a banner saying which backup is now loaded
function showRestoredBanner() {
  let ts = null;
  try { ts = sessionStorage.getItem("boltarrRestored"); sessionStorage.removeItem("boltarrRestored"); } catch (_) {}
  if (!ts) return;
  const bar = document.createElement("div");
  bar.className = "restored-banner";
  bar.setAttribute("role", "status");
  bar.innerHTML = `<span>✅ Restored from the backup made <strong>${escHtml(fmtLocal(ts) || ts)}</strong>.</span>
    <button class="btn-ghost" aria-label="Dismiss" onclick="this.parentElement.remove()">×</button>`;
  document.body.prepend(bar);
}

function openFactoryReset() {
  document.getElementById("resetKeepSettings").checked = true;
  document.getElementById("resetConfirm").value = "";
  onResetConfirmInput();
  document.getElementById("factoryResetModal").classList.add("open");
}
function closeFactoryReset() {
  document.getElementById("factoryResetModal").classList.remove("open");
}
function onResetConfirmInput() {
  document.getElementById("resetConfirmBtn").disabled =
    document.getElementById("resetConfirm").value.trim() !== "DELETE";
}
async function doFactoryReset() {
  if (document.getElementById("resetConfirm").value.trim() !== "DELETE") return;
  const keep = document.getElementById("resetKeepSettings").checked;
  try {
    await api("POST", "/api/factory-reset", { keep_settings: keep });
    closeFactoryReset();
    alert("Factory reset complete." + (keep ? "" : " Settings were reset to defaults too."));
    location.reload();
  } catch (e) { alert("Reset failed: " + e.message); }
}

