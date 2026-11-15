// Boltarr — Services tab: list, inline editing, columns, sub-tabs.
// Part of the app split from app.js (F-08); files share globals and load in order (see index.html).

// ── Services ──────────────────────────────────────────────────────────────────

// The URL Boltarr builds for a port: https for 443/8443, http otherwise.
function svcAutoUrl(ip, port) {
  const scheme = (port === 443 || port === 8443) ? "https" : "http";
  return `${scheme}://${ip}:${port}`;
}
// The IP in `url` if it is exactly the URL Boltarr builds for that port, else null.
// Such a URL follows port changes; one the user wrote never does.
function svcAutoUrlIp(url, ips, port) {
  port = parseInt(port);
  return (url && port && ips.find(ip => ip && url === svcAutoUrl(ip, port))) || null;
}

function autoFillSvcUrl(ip, portVal, urlFieldId) {
  const urlEl = document.getElementById(urlFieldId);
  if (!urlEl) return;
  if (urlEl.dataset.auto === undefined) urlEl.dataset.auto = "";
  if (urlEl.value && urlEl.value !== urlEl.dataset.auto) return;
  const port = parseInt(portVal);
  if (!port) { if (urlEl.value === urlEl.dataset.auto) { urlEl.value = ""; urlEl.dataset.auto = ""; } return; }
  const generated = svcAutoUrl(ip, port);
  urlEl.value = generated;
  urlEl.dataset.auto = generated;
}

function autoFillSvcUrlModal() {
  if (document.getElementById("svcCheckType").value !== "http") return;   // only web checks use the URL
  const ip   = document.getElementById("svcContainerIp").value.trim() || document.getElementById("svcHostIp")?.value;
  const port = document.getElementById("svcPort")?.value;
  if (ip) autoFillSvcUrl(ip, port, "svcUrl");
}

// Panel: same auto-fill when the port is typed.
function svcDetailPortTyped() {
  if (document.getElementById("svcDetailCheckType").value !== "http") return;
  const ip = document.getElementById("svcDetailContainerIp").value.trim() || document.getElementById("svcDetailHost").value;
  if (ip) autoFillSvcUrl(ip, document.getElementById("svcDetailPort").value, "svcDetailUrl");
  updateSvcDetailUrlBtn();
}

function svcIconHTML(name, size = 26) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0x7FFFFFFF;
  const hue = h % 360;
  const initials = name.replace(/[^a-z0-9]/gi, "").substring(0, 2).toUpperCase() || "??";
  return `<div class="svc-icon" style="width:${size}px;height:${size}px;background:hsl(${hue},40%,28%);color:hsl(${hue},60%,68%)">${initials}</div>`;
}

function svcRowHTML(s, hostIp) {
  const portBadge = s.port ? `<span class="port-badge mono">${escHtml(s.port)}/${escHtml(s.protocol||"tcp")}</span>` : "";
  return `<div class="svc-row" id="svc-row-${s.id}">
    ${svcIconHTML(s.name)}
    <span class="svc-name">${escHtml(s.name)}${s.description ? `<br><span class="svc-desc">${escHtml(s.description)}</span>` : ""}</span>
    <div class="svc-port-status" style="align-items:flex-end">
      ${portBadge}
      <button class="svc-status ${escHtml(s.status)}" data-click="cycleServiceStatus" data-args="${dargs(s.id, s.status, hostIp)}">${escHtml(s.status)}</button>
    </div>
    <div class="svc-actions">
      <button class="svc-kebab" data-click="toggleSvcMenu" data-args="${dargs("r" + s.id)}" title="Actions">⋮</button>
      <div class="svc-menu" id="svcmenu-r${s.id}">
        ${s.url ? `<a href="${safeUrl(s.url)}" target="_blank" rel="noopener" class="svc-menu-item">↗ Open URL</a>` : ""}
        <button class="svc-menu-item" data-click="svcMenuDeps" data-args="[${s.id}]">⊕ Dependencies</button>
        <button class="svc-menu-item" data-click="svcMenuEdit" data-args="[${s.id}]">✎ Edit</button>
        <button class="svc-menu-item danger" data-click="svcMenuDelete" data-args="${dargs(s.id, hostIp)}">✕ Delete</button>
      </div>
    </div>
  </div>`;
}

const STATUS_CYCLE = { running: "stopped", stopped: "unknown", unknown: "running" };

async function cycleServiceStatus(id, current, hostIp) {
  const next = STATUS_CYCLE[current] || "unknown";
  await saveSvcField(id, "status", next);
}

// A pause (F-28) vs. monitoring off: a pause has monitor_paused_at (or an end time
// from an older AI pause), may carry a reason, and keeps a public service listed.
function svcPaused(s) { return !s.monitored && !!(s.monitor_paused_at || s.monitor_resume_at); }
function svcPauseText(s) {
  const bits = [];
  if (s.monitor_pause_reason) bits.push(s.monitor_pause_reason);
  bits.push(s.monitor_resume_at ? `until ${fmtLocal(s.monitor_resume_at)}` : "until you turn it back on");
  return (s.monitor_pause_reason ? "maintenance: " : "paused ") + bits.join(" · ");
}
function _svcResumedFields(on) {
  return { monitored: on ? 1 : 0, monitor_resume_at: null, monitor_paused_at: null, monitor_pause_reason: null };
}
function svcMonToggle(s) {
  const on = !!s.monitored, paused = svcPaused(s);
  const title = on ? 'Monitoring on — click to pause or turn off'
    : paused ? `Monitoring ${svcPauseText(s)} — click to turn it back on` : 'Monitoring off — click to turn it on';
  const label = on ? 'On' : paused ? (s.monitor_pause_reason ? 'Maint' : 'Paused') : 'Off';
  // A real switch: the knob shows the state, sliding it does the obvious thing
  // (on → the pause/off dialog; off, paused or maint → monitoring back on).
  const cls = (on ? ' on' : '') + (paused ? ' paused' : '') + (s.monitor_pause_reason ? ' maint' : '');
  return svcSwitch(on, cls, "svcRowToggleMonitor", s.id, title, label);
}
// The table's on/off switch (Monitor + Public columns)
function svcSwitch(on, cls, action, id, title, label) {
  return `<button class="mon-switch${cls}" role="switch" aria-checked="${on}" data-click="${action}" data-args="[${id}]" title="${escHtml(title)}"><span class="mon-switch-track"><span class="mon-switch-knob"></span></span><span class="mon-switch-label">${label}</span></button>`;
}
async function svcRowToggleMonitor(id) {
  const s = allServices.find(x => x.id === id);
  if (!s) return;
  if (s.monitored) return openPauseModal(id);     // On -> ask: pause (reason/until) or off
  return svcMonitorOn(id);
}
// Monitoring back on (table or panel switch). Both views flip at once; the first
// check can take a few seconds (a dead address), so its result fills in after.
async function svcMonitorOn(id) {
  const s = allServices.find(x => x.id === id);
  if (!s) return;
  Object.assign(s, _svcResumedFields(true), { monitor_status: "unknown" });   // by hand: ends any pause
  _afterMonitorChange(id);
  try {
    const r = await api("POST", `/api/services/${id}/monitor`, { enabled: true });
    const cur = allServices.find(x => x.id === id);   // the 20 s refresh may have replaced the list meanwhile
    if (cur && r && r.monitor_status !== undefined) Object.assign(cur, _svcResumedFields(true), { monitor_status: r.monitor_status });
  } catch (e) { showToast(e.message); await loadServicesData(); }
  _afterMonitorChange(id);
}

// ── Pause dialog (F-28) ───────────────────────────────────────────────────────
function openPauseModal(id) {
  const s = allServices.find(x => x.id === id);
  if (!s) return;
  document.getElementById("pauseSvcId").value = id;
  document.getElementById("pauseTitle").textContent = `Pause monitoring — ${s.name}`;
  document.getElementById("pauseReason").value = "";
  const until = document.getElementById("pauseUntil");
  until.value = "";
  const pad = n => String(n).padStart(2, "0"), d = new Date();
  until.min = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  document.getElementById("pauseModal").classList.add("open");
  document.getElementById("pauseReason").focus();
}
function closePauseModal() {
  document.getElementById("pauseModal").classList.remove("open");
}
// Every monitoring change ends here: refresh the table and, if open, the panel's
// monitor row + uptime only (re-filling the whole panel would wipe unsaved edits).
function _afterMonitorChange(id) {
  renderServicesTable();
  const s = allServices.find(x => x.id === id);
  if (s && svcDetailId === id && document.getElementById("svcDetailPanel").classList.contains("open")) {
    setSvcDetailMonState(s);
    loadSvcUptime(id, s.monitored || svcPaused(s));
  }
}
async function pauseSubmit() {
  const id = parseInt(document.getElementById("pauseSvcId").value);
  const reason = document.getElementById("pauseReason").value.trim();
  const untilVal = document.getElementById("pauseUntil").value;
  const body = { reason: reason || null, until: untilVal ? new Date(untilVal).toISOString() : null };
  try {
    const r = await api("POST", `/api/services/${id}/pause`, body);
    const s = allServices.find(x => x.id === id);
    if (s) Object.assign(s, r);
    closePauseModal();
    showToast(reason ? "Paused — the status page shows Maintenance" : "Monitoring paused");
    _afterMonitorChange(id);
  } catch (e) { showToast(e.message); }
}
async function pauseTurnOff() {
  const id = parseInt(document.getElementById("pauseSvcId").value);
  try {
    const r = await api("POST", `/api/services/${id}/monitor`, { enabled: false });
    const s = allServices.find(x => x.id === id);
    if (s) Object.assign(s, _svcResumedFields(false), { monitor_status: r.monitor_status });
    closePauseModal();
    _afterMonitorChange(id);
  } catch (e) { showToast(e.message); }
}

// Accepted replies "hints" popup (opens over the edit dialog too)
function openCodesHelp() {
  document.getElementById("codesHelpModal").classList.add("open");
}
function closeCodesHelp() {
  document.getElementById("codesHelpModal").classList.remove("open");
}

function svcPubToggle(s) {
  const on = !!s.public;
  return svcSwitch(on, on ? " on" : "", "svcRowTogglePublic", s.id,
    on ? "Shown on the public status page — click to hide it" : "Not public — click to show it on the status page", on ? "On" : "Off");
}
async function svcRowTogglePublic(id) {
  const s = allServices.find(x => x.id === id);
  if (s) return svcSetPublic(id, !s.public);
}
// Public on/off (table or panel switch): saved at once, both views follow.
async function svcSetPublic(id, on) {
  const s = allServices.find(x => x.id === id);
  if (!s) return;
  const name = s.public_name || s.name;
  s.public = on ? 1 : 0;
  if (on && !s.public_name) s.public_name = name;
  _afterPublicChange(id);
  try {
    await api("POST", `/api/services/${id}/public`, { enabled: on, name });
  } catch (e) { showToast(e.message); await loadServicesData(); _afterPublicChange(id); }
}
function _afterPublicChange(id) {
  renderServicesTable();
  const s = allServices.find(x => x.id === id);
  if (!s || svcDetailId !== id || !document.getElementById("svcDetailPanel").classList.contains("open")) return;
  document.getElementById("svcDetailPublic").checked = !!s.public;
  document.getElementById("svcDetailPublicNameRow").style.display = s.public ? "" : "none";
  const nameEl = document.getElementById("svcDetailPublicName");
  if (!nameEl.value.trim()) nameEl.value = s.public_name || "";   // never over typing that isn't saved yet
}

function svcPortProtoPencil(id) {
  return `<button class="cell-edit" title="Edit port / protocol" data-click="editSvcPortProtoBtn" data-args="[${id}]">✎</button>`;
}
function editSvcPortProto(id, btn) {
  const s = allServices.find(x => x.id === id);
  const cell = btn.closest(".svc-port-status");
  const target = cell && cell.querySelector(".svc-portproto");
  if (!target) return;
  const wrap = document.createElement("span");
  wrap.className = "type-edit";
  const pin = document.createElement("input");
  pin.type = "number"; pin.min = 1; pin.max = 65535; pin.className = "cell-input"; pin.placeholder = "port";
  pin.style.width = "62px";
  pin.value = (s && s.port) ? s.port : "";
  const psel = document.createElement("select");
  psel.className = "cell-select";
  psel.innerHTML = '<option value="tcp">tcp</option><option value="udp">udp</option>';
  psel.value = (s && s.protocol) || "tcp";
  let done = false;
  const finish = (save) => {
    if (done) return;
    if (save) {
      const pv = pin.value.trim();
      const port = pv === "" ? null : parseInt(pv, 10);
      if (port !== null && (isNaN(port) || port < 1 || port > 65535)) { pin.classList.add("invalid"); pin.focus(); return; }
      done = true; saveSvcPortProto(id, port, psel.value);
    } else { done = true; renderServicesTable(); }
  };
  pin.addEventListener("click", e => e.stopPropagation());
  psel.addEventListener("click", e => e.stopPropagation());
  pin.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  psel.addEventListener("change", () => finish(true));
  const away = (e) => { if (!wrap.contains(e.target)) { document.removeEventListener("click", away, true); finish(false); } };
  setTimeout(() => document.addEventListener("click", away, true), 0);
  wrap.appendChild(pin); wrap.appendChild(psel);
  target.replaceWith(wrap);
  pin.focus(); pin.select();
}
async function saveSvcPortProto(id, port, proto) {
  const s = allServices.find(x => x.id === id);
  const prevPort = s ? s.port : null, prevProto = s ? s.protocol : null;
  const prevUrl = s ? s.url : null;
  const payload = { port, protocol: proto };
  if (s && port) {   // a URL built from the old port (or none, on a web check) follows the new port
    const ip = svcAutoUrlIp(s.url, [s.container_ip, s.ip], prevPort);
    const ct = s.check_type || (s.url ? "http" : "tcp");
    if (ip) payload.url = svcAutoUrl(ip, port);
    else if (!s.url && ct === "http") payload.url = svcAutoUrl(s.container_ip || s.ip, port);
  }
  if (s) { s.port = port; s.protocol = proto; if ("url" in payload) s.url = payload.url; }
  renderServicesTable();
  try {
    await api("PUT", `/api/services/${id}`, payload);
  } catch (e) {
    if (s) { s.port = prevPort; s.protocol = prevProto; s.url = prevUrl; }
    await loadServicesData(); renderServicesTable();
  }
}

async function addServiceToHost(ip) {
  const name   = document.getElementById("newSvcName").value.trim();
  const port   = parseInt(document.getElementById("newSvcPort").value) || null;
  const status = document.getElementById("newSvcStatus").value;
  const url    = document.getElementById("newSvcUrl").value.trim() || null;
  if (!name) return alert("Service name is required.");
  try {
    const svc = await api("POST", `/api/hosts/${ip}/services`, { name, port, status, url });
    allServices.push(svc);
    ["newSvcName","newSvcPort","newSvcUrl"].forEach(id => { const el = document.getElementById(id); if (el) { el.value = ""; el.dataset.auto = ""; } });
    document.getElementById("newSvcStatus").value = "unknown";
    const listEl = document.getElementById(`dtab-svc-list-${ip.replace(/\./g,'_')}`);
    if (listEl) {
      const empty = listEl.querySelector("[style*='color:var(--text-3)']");
      if (empty) empty.remove();
      listEl.insertAdjacentHTML("beforeend", svcRowHTML(svc, ip));
    }
    renderServicesTable();
  } catch (e) { alert("Error: " + e.message); }
}

async function deleteSvc(id, hostIp) {
  if (!confirm("Delete this service?")) return;
  await api("DELETE", `/api/services/${id}`);
  allServices = allServices.filter(s => s.id !== id);
  document.getElementById(`svc-row-${id}`)?.remove();
  renderServicesTable();
}

// Fill a host <select> (regular hosts + a Containers group) and pre-select an
// IP if given. Shared by the Add/Edit modal and the detail panel.
function _fillHostSelect(sel, selectedIp) {
  if (!sel) return;
  const regularHosts   = allHosts.filter(h => h.device_type !== "container");
  const containerHosts = allHosts.filter(h => h.device_type === "container");
  const hostOpts = host => `<option value="${escHtml(host.ip)}">${escHtml(host.ip)}${host.hostname ? " — " + escHtml(host.hostname) : ""}</option>`;
  sel.innerHTML =
    regularHosts.map(hostOpts).join("") +
    (containerHosts.length ? `<optgroup label="── Containers ──">${containerHosts.map(hostOpts).join("")}</optgroup>` : "");
  if (selectedIp && sel.querySelector(`option[value="${CSS.escape ? CSS.escape(selectedIp) : selectedIp}"]`)) sel.value = selectedIp;
}
function populateSvcHostSelect(selectedIp) { _fillHostSelect(document.getElementById("svcHostIp"), selectedIp); }

// Grey out (disable + dim) the fields a given check type ignores, keeping all
// fields visible. HTTP → uses URL; TCP → target IP + port; ICMP → target IP only.
function _applyCheckGrey(ct, ids) {
  const use = {
    http: { url: true,  target: false, port: true,  codes: true  },   // port stays usable: it fills in the URL
    tcp:  { url: false, target: true,  port: true,  codes: false },
    icmp: { url: false, target: true,  port: false, codes: false },
  }[ct] || { url: true, target: true, port: true, codes: true };
  const set = (id, active) => {
    const el = document.getElementById(id);
    if (!el) return;
    const row = el.closest(".form-row, .svc-detail-field") || el;
    el.disabled = !active;
    row.classList.toggle("field-dim", !active);
  };
  set(ids.url,    use.url);
  set(ids.target, use.target);
  set(ids.port,   use.port);
  if (ids.codes) set(ids.codes, use.codes);
}

// Modal: grey the unused fields when the check type changes.
// While monitored, the monitor sets the status: the dropdown is shown but locked.
function svcModalMonitorToggled() {
  const on = document.getElementById("svcModalMonitored").checked;
  const sel = document.getElementById("svcStatus");
  sel.disabled = on;
  document.getElementById("svcStatusAuto").hidden = !on;
}

function svcCheckTypeChanged() {
  const ct = document.getElementById("svcCheckType").value;
  _applyCheckGrey(ct, { url: "svcUrl", target: "svcContainerIp", port: "svcPort", codes: "svcCodes" });
}

// Detail panel: same grey-out for the panel's own fields.
function svcDetailCheckChanged() {
  const ct = document.getElementById("svcDetailCheckType").value;
  _applyCheckGrey(ct, { url: "svcDetailUrl", target: "svcDetailContainerIp", port: "svcDetailPort", codes: "svcDetailCodes" });
}

function svcModalPublicToggled() {
  document.getElementById("svcModalPublicNameRow").style.display =
    document.getElementById("svcModalPublic").checked ? "" : "none";
}

function openEditService(id) {
  const s = allServices.find(s => s.id === id);
  if (!s) return;
  document.getElementById("svcModalTitle").textContent = "Edit Service";
  document.getElementById("svcEditId").value    = id;
  document.getElementById("svcName").value      = s.name || "";
  document.getElementById("svcDesc").value      = s.description || "";
  document.getElementById("svcPort").value      = s.port || "";
  document.getElementById("svcProto").value     = s.protocol || "tcp";
  document.getElementById("svcStatus").value    = s.status || "unknown";
  const urlEl = document.getElementById("svcUrl");
  urlEl.value = s.url || "";
  urlEl.dataset.auto = svcAutoUrlIp(s.url, [s.container_ip, s.ip], s.port) ? s.url : "";
  document.getElementById("svcContainerIp").value = s.container_ip || "";
  document.getElementById("svcCheckType").value   = s.check_type || (s.url ? "http" : "tcp");
  document.getElementById("svcCodes").value       = s.accepted_codes || "";
  svcCheckTypeChanged();
  document.getElementById("svcModalMonitored").checked = !!s.monitored;
  svcModalMonitorToggled();
  document.getElementById("svcModalPublic").checked    = !!s.public;
  document.getElementById("svcModalPublicName").value  = s.public_name || "";
  svcModalPublicToggled();
  populateSvcHostSelect(s.ip);                                 // let the host be changed on edit too
  document.getElementById("svcHostRow").style.display        = "";
  document.getElementById("containerPickRow").style.display  = "none";
  document.getElementById("svcModalDeleteBtn").style.display = "";
  document.getElementById("serviceModal").classList.add("open");
}

function openAddService(presetIp) {
  document.getElementById("svcModalTitle").textContent = "Add Service";
  document.getElementById("svcEditId").value    = "";
  document.getElementById("svcName").value      = "";
  document.getElementById("svcDesc").value      = "";
  document.getElementById("svcPort").value      = "";
  document.getElementById("svcProto").value     = "tcp";
  document.getElementById("svcStatus").value    = "unknown";
  const svcUrlEl = document.getElementById("svcUrl");
  svcUrlEl.value = "";
  svcUrlEl.dataset.auto = "";
  document.getElementById("svcContainerIp").value = "";
  document.getElementById("svcCheckType").value   = "http";
  svcCheckTypeChanged();
  document.getElementById("svcModalMonitored").checked = false;
  svcModalMonitorToggled();
  document.getElementById("svcModalPublic").checked    = false;
  document.getElementById("svcModalPublicName").value  = "";
  svcModalPublicToggled();
  document.getElementById("svcModalDeleteBtn").style.display = "none";

  pickedContainerIp = null;
  // Container quick-pick
  const containerRow = document.getElementById("containerPickRow");
  containerRow.style.display = "";
  document.getElementById("containerPickList").style.display = "none";
  document.getElementById("containerPickChevron").textContent = "▸";
  renderContainerPick();

  document.getElementById("svcHostRow").style.display = "";
  // Pre-select: explicit preset → last used → first option
  const last   = localStorage.getItem("boltarr_last_svc_host");
  const preset = (presetIp && allHosts.some(h => h.ip === presetIp)) ? presetIp : (last || null);
  populateSvcHostSelect(preset);
  document.getElementById("serviceModal").classList.add("open");
}

function renderContainerPick() {
  const containers = _unusedContainerIps();
  const list        = document.getElementById("containerPickList");

  if (containers.length === 0) {
    list.innerHTML = `<div style="font-size:11px;color:var(--text-3)">No container hosts available to import.</div>`;
    return;
  }
  list.innerHTML = `<div class="container-pick-grid">` +
    containers.map(h => {
      const label = h.hostname || h.ip;
      const sub   = h.hostname ? h.ip : "";
      return `<div class="container-chip" data-click="pickContainer" data-args="${dargs(h.ip, label)}">
        <span class="container-chip-name">${escHtml(label)}</span>
        ${sub ? `<span class="container-chip-ip">${escHtml(sub)}</span>` : ""}
      </div>`;
    }).join("") +
  `</div>`;
}

function toggleContainerPick() {
  const list     = document.getElementById("containerPickList");
  const chevron  = document.getElementById("containerPickChevron");
  const isOpen   = list.style.display !== "none";
  list.style.display  = isOpen ? "none" : "block";
  chevron.textContent = isOpen ? "▸" : "▾";
}

function pickContainer(ip, name) {
  pickedContainerIp = ip;
  document.getElementById("svcName").value = name;
  document.getElementById("svcContainerIp").value = ip;   // also the monitor target
  const urlEl = document.getElementById("svcUrl");
  const port  = document.getElementById("svcPort").value;
  const auto  = port ? `http://${ip}:${port}` : `http://${ip}`;
  urlEl.value = auto;
  urlEl.dataset.auto = auto;
  // Close the pick panel
  document.getElementById("containerPickList").style.display = "none";
  document.getElementById("containerPickChevron").textContent = "▸";
  // Focus the host dropdown so user picks the parent
  document.getElementById("svcHostIp").focus();
}

function closeServiceModal() {
  document.getElementById("serviceModal").classList.remove("open");
}

async function saveServiceModal() {
  const editId  = document.getElementById("svcEditId").value;
  const name    = document.getElementById("svcName").value.trim();
  const desc    = document.getElementById("svcDesc").value.trim() || null;
  const port    = parseInt(document.getElementById("svcPort").value) || null;
  const proto   = document.getElementById("svcProto").value;
  const status  = document.getElementById("svcStatus").value;
  const url     = document.getElementById("svcUrl").value.trim() || null;
  const checkType   = document.getElementById("svcCheckType").value;
  const containerIp = document.getElementById("svcContainerIp").value.trim();
  const codes       = document.getElementById("svcCodes").value.trim();
  const monitored   = document.getElementById("svcModalMonitored").checked;
  const isPublic    = document.getElementById("svcModalPublic").checked;
  const publicName  = document.getElementById("svcModalPublicName").value.trim();
  if (!name) return alert("Service name is required.");

  try {
    let svcId;
    if (editId) {
      const svc = await api("PUT", `/api/services/${editId}`, {
        name, description: desc, port, protocol: proto, status, url,
        check_type: checkType, container_ip: containerIp,   // "" clears the override
        accepted_codes: codes || null,
        host_ip: document.getElementById("svcHostIp").value // allow moving to another host
      });
      svcId = parseInt(editId);
      allServices = allServices.map(s => s.id === svcId ? { ...s, ...svc } : s);
    } else {
      const hostIp = document.getElementById("svcHostIp").value;
      const svc = await api("POST", `/api/hosts/${hostIp}/services`, {
        name, description: desc, port, protocol: proto, status, url,
        check_type: checkType, container_ip: containerIp || null, accepted_codes: codes || null
      });
      svcId = svc.id;
      allServices.push(svc);
      pickedContainerIp = null;
      localStorage.setItem("boltarr_last_svc_host", hostIp);
    }
    // Monitor + public go through their dedicated endpoints (same as the panel).
    const cur = allServices.find(s => s.id === svcId) || {};
    if (!!cur.monitored !== monitored) {
      const r = await api("POST", `/api/services/${svcId}/monitor`, { enabled: monitored });
      Object.assign(cur, _svcResumedFields(monitored), { monitor_status: r.monitor_status });
    }
    if (!!cur.public !== isPublic || (isPublic && (cur.public_name || "") !== publicName)) {
      await api("POST", `/api/services/${svcId}/public`, { enabled: isPublic, name: publicName });
      cur.public = isPublic ? 1 : 0; cur.public_name = publicName;
    }
    renderServicesTable();
    closeServiceModal();
  } catch (e) { alert("Error: " + e.message); }
}

async function deleteServiceFromModal() {
  const editId = document.getElementById("svcEditId").value;
  if (!editId || !confirm("Delete this service?")) return;
  await api("DELETE", `/api/services/${editId}`);
  allServices = allServices.filter(s => s.id !== parseInt(editId));
  document.getElementById(`svc-row-${editId}`)?.remove();
  renderServicesTable();
  closeServiceModal();
}

// ── Services tab ──────────────────────────────────────────────────────────────

let svcFilterText = "";
let svcSortCol    = "name";
let svcSortDir    = 1;

async function loadServicesData() {
  try { allServices = await api("GET", "/api/services"); } catch { allServices = []; }
  try { allDependencies = await api("GET", "/api/service-dependencies"); } catch { allDependencies = []; }
  populateSvcHostFilter();
  scheduleSvcResumeRefresh();
}

// A timed pause (AI action) ends on the server at its resume time. Reload then, so the
// table and an open panel switch back to On without a click. Long pauses re-check hourly
// (setTimeout can't wait more than ~24 days).
let svcResumeTimer = null;
function scheduleSvcResumeRefresh() {
  clearTimeout(svcResumeTimer);
  const next = Math.min(...allServices.filter(s => !s.monitored && s.monitor_resume_at).map(s => _ts(s.monitor_resume_at) ?? Infinity));
  if (!isFinite(next)) return;
  svcResumeTimer = setTimeout(refreshServicesAfterResume, Math.min(Math.max(0, next - Date.now()) + 2000, 3600000));
}
async function refreshServicesAfterResume() {
  const before = allServices.find(s => s.id === svcDetailId);
  await loadServicesData();
  renderServicesTable();
  const after = allServices.find(s => s.id === svcDetailId);
  // Only redraw an open panel when its monitoring changed, so nothing being typed is lost
  if (after && before && after.monitored !== before.monitored
      && document.getElementById("svcDetailPanel").classList.contains("open")) showSvcDetail(after.id);
}

function populateSvcHostFilter() {
  const sel = document.getElementById("svcHostFilter");
  if (!sel) return;
  const current = sel.value;
  const hosts = [...new Map(allServices.map(s => [s.ip, {ip: s.ip, hostname: s.hostname}])).values()]
    .sort((a, b) => (a.hostname || a.ip).localeCompare(b.hostname || b.ip));
  sel.innerHTML = `<option value="">All hosts</option>` +
    hosts.map(h => `<option value="${escHtml(h.ip)}"${h.ip === current ? " selected" : ""}>${escHtml(h.hostname || h.ip)}</option>`).join("");
}

async function loadServicesTab() {
  await loadServicesData();
  renderServicesTable();
}

// The services the table shows (host filter + search, in the current sort).
function servicesVisibleRows() {
  let rows = svcHostFilterVal ? allServices.filter(s => s.ip === svcHostFilterVal) : allServices;
  if (svcFilterText) rows = rows.filter(s => svcMatches(s, svcFilterText));
  rows = [...rows].sort((a, b) => {
    const va = (a[svcSortCol] ?? "").toString().toLowerCase();
    const vb = (b[svcSortCol] ?? "").toString().toLowerCase();
    return va < vb ? -svcSortDir : va > vb ? svcSortDir : 0;
  });
  return rows;
}

function renderServicesTable() {
  const tbody = document.querySelector("#servicesTable tbody");
  if (!tbody) return;
  const rows = servicesVisibleRows();

  const count = document.getElementById("serviceCount");
  if (count) count.textContent = `${rows.length} of ${allServices.length}`;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-3);font-size:12px">${svcFilterText ? "No matches." : "No services yet — add one with + Service."}</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(s => `
    <tr id="svc-tr-${s.id}" style="cursor:pointer" data-click="showSvcDetail" data-args="[${s.id}]">
      <td class="td-check"><input type="checkbox" class="svc-checkbox" data-id="${s.id}" style="accent-color:var(--accent)" data-stop data-change="svcUpdateBulkBtn"></td>
      <td class="col-svc-icon" style="padding:6px 8px 6px 16px">${svcIconHTML(s.name, 28)}</td>
      <td>
        <div style="font-size:12px;font-weight:500" class="svc-mon-cell">${monDotHTML(s)}<span class="svc-name-txt">${escHtml(s.name)}</span>${svcHostDownTag(s)}${svcEditPencil(s.id,'name')}</div>
        <div class="svc-desc-line">${s.description ? `<span class="svc-desc-txt">${escHtml(s.description)}</span>` : '<span class="note-add">＋ description</span>'}${svcEditPencil(s.id,'description')}</div>
      </td>
      <td class="svc-host-cell col-svc-host">
        <span class="svc-host-ip">${livenessDot(s.host_online)}${escHtml(s.ip)}</span>
        ${s.hostname ? `<span class="svc-host-name">${escHtml(s.hostname)}</span>` : ""}
      </td>
      <td class="col-svc-ps">
        <div class="svc-port-status">
          <span class="svc-portproto">${s.port ? `<span class="port-badge mono">${escHtml(s.port)}/${escHtml(s.protocol||"tcp")}</span>` : `<span style="color:var(--text-3);font-size:11px">—</span>`}</span>
          ${s.monitored
            ? `<span class="svc-status ${escHtml(s.status)} locked" title="Set automatically by the monitor">${escHtml(s.status)}</span>`
            : `<button class="svc-status ${escHtml(s.status)}" data-click="cycleServiceStatus" data-args="${dargs(s.id, s.status, s.ip)}">${escHtml(s.status)}</button>`}
          ${svcPortProtoPencil(s.id)}
        </div>
      </td>
      <td class="col-svc-mon">${svcMonToggle(s)}</td>
      <td class="col-svc-pub">${svcPubToggle(s)}</td>
      <td class="col-svc-url">${svcUrlCell(s)}</td>
    </tr>
  `).join("");
  svcUpdateBulkBtn();
}

function svcToggleAll(checked) {
  document.querySelectorAll(".svc-checkbox").forEach(cb => cb.checked = checked);
  svcUpdateBulkBtn();
}

// ── Services inline editing (mirrors the Hosts table) ────────────────────────
function svcEditPencil(id, field) {
  return `<button class="cell-edit" title="Edit ${field}" data-click="editSvcFieldBtn" data-args="${dargs(id, field)}">✎</button>`;
}

function svcUrlCell(s) {
  const raw = s.url || "";
  if (!raw) return `<span class="note-add">＋ url</span>${svcEditPencil(s.id, 'url')}`;
  const full = escHtml(raw);
  const trunc = escHtml(raw.length > 40 ? raw.slice(0, 40) + "…" : raw);
  return `<a class="note-link svc-url-txt" href="${safeUrl(raw)}" target="_blank" rel="noopener" data-stop title="${full}">${trunc}</a>${svcEditPencil(s.id, 'url')}`;
}

function editSvcField(id, field, btn) {
  const s = allServices.find(x => x.id === id);
  const cell = btn.closest("td");
  const target =
    field === "name" ? cell.querySelector(".svc-name-txt")
    : field === "url" ? (cell.querySelector(".svc-url-txt") || cell.querySelector(".note-add"))
    : (cell.querySelector(".svc-desc-txt") || cell.querySelector(".note-add"));
  if (!target) return;
  const inp = document.createElement("input");
  inp.type = "text"; inp.className = "cell-input"; inp.maxLength = field === "name" ? 80 : 200;
  inp.value = (s && s[field]) || "";
  let done = false;
  const finish = (save) => {
    if (done) return;
    if (save) {
      const v = inp.value.trim();
      if (field === "name" && !v) { done = true; renderServicesTable(); return; }  // name can't be empty
      done = true; saveSvcField(id, field, v);
    } else { done = true; renderServicesTable(); }
  };
  inp.addEventListener("click", e => e.stopPropagation());
  inp.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  inp.addEventListener("blur", () => finish(true));
  target.replaceWith(inp);
  inp.focus(); inp.select();
}

async function saveSvcField(id, field, value) {
  const s = allServices.find(x => x.id === id);
  const prev = s ? s[field] : null;
  if (s) s[field] = value;
  renderServicesTable();
  const payload = { [field]: value };   // the server changes only the fields sent
  try {
    await api("PUT", `/api/services/${id}`, payload);
  } catch (e) {
    if (s) s[field] = prev;
    await loadServicesData(); renderServicesTable();
  }
}

// ── Services column show/hide (persisted per browser) ────────────────────────
const SVC_COLS = ["icon", "desc", "host", "ps", "mon", "pub", "url"];
function getSvcHiddenCols() {
  try { return JSON.parse(localStorage.getItem("boltarr.svcHiddenCols") || "[]"); }
  catch (e) { return []; }
}
function applySvcHiddenCols() {
  const t = document.getElementById("servicesTable");
  if (!t) return;
  const hidden = getSvcHiddenCols();
  SVC_COLS.forEach(c => t.classList.toggle("hide-svc-" + c, hidden.includes(c)));
}
function setSvcColumn(key, visible) {
  let hidden = getSvcHiddenCols();
  if (visible) hidden = hidden.filter(k => k !== key);
  else if (!hidden.includes(key)) hidden.push(key);
  localStorage.setItem("boltarr.svcHiddenCols", JSON.stringify(hidden));
  applySvcHiddenCols();
}
function initSvcColumnMenu() {
  const btn = document.getElementById("svcColMenuBtn");
  const menu = document.getElementById("svcColMenu");
  if (!btn || !menu) return;
  const hidden = getSvcHiddenCols();
  menu.querySelectorAll("input[data-col]").forEach(cb => {
    cb.checked = !hidden.includes(cb.getAttribute("data-col"));
    cb.addEventListener("change", () => setSvcColumn(cb.getAttribute("data-col"), cb.checked));
  });
  btn.addEventListener("click", e => { e.stopPropagation(); menu.classList.toggle("open"); });
  document.addEventListener("click", e => {
    if (!menu.contains(e.target) && e.target !== btn) menu.classList.remove("open");
  });
  applySvcHiddenCols();
}
document.addEventListener("DOMContentLoaded", initSvcColumnMenu);

function svcUpdateBulkBtn() {
  const boxes = document.querySelectorAll(".svc-checkbox");
  const checked = document.querySelectorAll(".svc-checkbox:checked").length;
  const btn = document.getElementById("svcDeleteBtn");
  if (btn) btn.style.display = checked ? "" : "none";
  const all = document.getElementById("svcSelectAll");
  if (all) {
    all.checked = checked === boxes.length && boxes.length > 0;
    all.indeterminate = checked > 0 && checked < boxes.length;
  }
}

async function svcDeleteSelected() {
  const ids = Array.from(document.querySelectorAll(".svc-checkbox:checked")).map(cb => parseInt(cb.dataset.id));
  if (!ids.length) return showToast("Nothing selected");
  if (!confirm(`Delete ${ids.length} service${ids.length > 1 ? "s" : ""}?`)) return;
  await api("DELETE", "/api/services", { ids });
  allServices = allServices.filter(s => !ids.includes(s.id));
  renderServicesTable();
  showToast(`Deleted ${ids.length} service${ids.length > 1 ? "s" : ""}`);
}

// Small up/down dot shown in the services table for monitored services.
function monDotHTML(s) {
  if (svcPaused(s)) return `<span class="mon-dot mon-paused${s.monitor_pause_reason ? " maint" : ""}" title="${escHtml("Monitoring " + svcPauseText(s))}"></span>`;
  if (!s.monitored) return "";
  if (s.monitor_not_set_up)
    return `<span class="mon-dot mon-unknown" title="Not set up — add a web address or port"></span>`;
  const st  = s.monitor_status || "unknown";
  const cls = st === "up" ? "mon-up" : st === "down" ? "mon-down" : "mon-unknown";
  const title = st === "up" ? "Monitored — up" : st === "down" ? "Monitored — down" : "Monitored — checking…";
  return `<span class="mon-dot ${cls}" title="${escHtml(title)}"></span>`;
}

// Root-cause chip: a monitored service that's down while its host is offline.
function svcHostDownTag(s) {
  if (s.host_online === 0 && s.monitored && (s.monitor_status || "") === "down")
    return ` <span class="host-down-chip" title="This service is down because its host is offline">host offline</span>`;
  return "";
}

async function deleteSvcFromTable(id) {
  if (!confirm("Delete this service?")) return;
  await api("DELETE", `/api/services/${id}`);
  allServices = allServices.filter(s => s.id !== id);
  renderServicesTable();
}

// Periodically refresh live monitor status while viewing the Services tab.
let _monPollTimer = null;
// F-30: the whole row is refreshed (label, host-offline chip, pause end), not only the dot.
const _SVC_LIVE_KEYS = ["monitored", "monitor_status", "status", "host_online", "monitor_resume_at",
  "monitor_paused_at", "monitor_pause_reason", "monitor_not_set_up"];
async function refreshMonitorStatus() {
  if (!allServices.some(s => s.monitored || svcPaused(s))) return;
  try {
    const fresh = await api("GET", "/api/services");
    const byId = new Map(fresh.map(s => [s.id, s]));
    let changed = false, openChanged = false;
    allServices = allServices.map(s => {
      const f = byId.get(s.id);
      if (!f) return s;
      if (_SVC_LIVE_KEYS.some(k => (f[k] ?? null) !== (s[k] ?? null))) {
        changed = true;
        if (s.id === svcDetailId) openChanged = true;
      }
      return { ...s, ...f };
    });
    if (changed) {
      renderServicesTable();
      scheduleSvcResumeRefresh();
      const cur = openChanged && allServices.find(s => s.id === svcDetailId);
      if (cur) setSvcDetailMonState(cur);
    }
  } catch {}
}
function startMonitorPolling() {
  if (_monPollTimer) return;
  _monPollTimer = setInterval(refreshMonitorStatus, 20000);  // every 20s while tab open
}
function stopMonitorPolling() {
  if (_monPollTimer) { clearInterval(_monPollTimer); _monPollTimer = null; }
}

function sortServices(col) {
  svcSortDir = svcSortCol === col ? -svcSortDir : 1;
  svcSortCol = col;
  renderServicesTable();
}

function closeSvcMenus() {
  document.querySelectorAll(".svc-menu.open").forEach(m => m.classList.remove("open"));
}

function toggleSvcMenu(key) {
  const menu = document.getElementById(`svcmenu-${key}`);
  if (!menu) return;
  const wasOpen = menu.classList.contains("open");
  closeSvcMenus();
  if (!wasOpen) menu.classList.add("open");
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("serviceFilter")?.addEventListener("input", e => {
    svcFilterText = e.target.value;
    renderServicesTable();
  });
  document.getElementById("svcHostFilter")?.addEventListener("change", e => {
    svcHostFilterVal = e.target.value;
    renderServicesTable();
    if (currentSvcTab === "topology") renderSvcTopology();
  });
  document.addEventListener("click", e => {
    if (!e.target.closest(".svc-actions, .ssh-key-kebab-wrap")) closeSvcMenus();
    if (!e.target.closest(".ssh-key-kebab-wrap")) closeSshKeyMenus();
  });
});

// ── Services sub-tabs ─────────────────────────────────────────────────────────

function setSvcTab(tab) {
  currentSvcTab = tab;
  document.getElementById("svc-panel-list").style.display      = tab === "list"     ? ""     : "none";
  document.getElementById("svc-panel-topology").style.display  = tab === "topology" ? "flex" : "none";
  document.getElementById("serviceFilter").style.display       = tab === "list"     ? ""     : "none";
  document.getElementById("serviceCount").style.display        = tab === "list"     ? ""     : "none";
  document.querySelectorAll(".svc-subtab").forEach(b => b.classList.remove("active"));
  document.getElementById(`svcTabBtn-${tab}`)?.classList.add("active");
  if (tab === "topology") renderSvcTopology();
}

registerActions({
  addServiceToHost,   // host panel → Services tab
  setSvcTab, sortServices, svcDeleteSelected, openAddService, svcUpdateBulkBtn,
  autoFillSvcUrlModal, svcCheckTypeChanged, svcModalMonitorToggled, svcModalPublicToggled, toggleContainerPick, pickContainer,
  deleteServiceFromModal, closeServiceModal, saveServiceModal, svcDetailCheckChanged,
  openPauseModal, closePauseModal, pauseSubmit, pauseTurnOff,
  cycleServiceStatus, toggleSvcMenu, svcRowToggleMonitor, openCodesHelp, closeCodesHelp, svcRowTogglePublic,
  svcToggleAllBox:     function () { svcToggleAll(this.checked); },
  svcUrlTyped:         function () { if (this.value !== this.dataset.auto) this.dataset.auto = ""; },
  svcDetailUrlTyped:   function () { ACTIONS.svcUrlTyped.call(this); updateSvcDetailUrlBtn(); },
  svcDetailPortTyped,
  svcMenuDeps:         id => { closeSvcMenus(); openManageDeps(id); },
  svcMenuEdit:         id => { closeSvcMenus(); openEditService(id); },
  svcMenuDelete:       (id, ip) => { closeSvcMenus(); deleteSvc(id, ip); },
  editSvcPortProtoBtn: function (id) { editSvcPortProto(id, this); },
  editSvcFieldBtn:     function (id, field) { editSvcField(id, field, this); },
});
