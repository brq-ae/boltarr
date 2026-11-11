// Boltarr — Services tab: list, inline editing, columns, sub-tabs.
// Part of the app split from app.js (F-08); files share globals and load in order (see index.html).

// ── Services ──────────────────────────────────────────────────────────────────

function autoFillSvcUrl(ip, portVal, urlFieldId) {
  const urlEl = document.getElementById(urlFieldId);
  if (!urlEl) return;
  if (urlEl.dataset.auto === undefined) urlEl.dataset.auto = "";
  if (urlEl.value && urlEl.value !== urlEl.dataset.auto) return;
  const port = parseInt(portVal);
  if (!port) { if (urlEl.value === urlEl.dataset.auto) { urlEl.value = ""; urlEl.dataset.auto = ""; } return; }
  const scheme = (port === 443 || port === 8443) ? "https" : "http";
  const generated = `${scheme}://${ip}:${port}`;
  urlEl.value = generated;
  urlEl.dataset.auto = generated;
}

function autoFillSvcUrlModal() {
  const ip   = document.getElementById("svcHostIp")?.value;
  const port = document.getElementById("svcPort")?.value;
  if (ip) autoFillSvcUrl(ip, port, "svcUrl");
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
      <button class="svc-status ${escHtml(s.status)}" onclick="cycleServiceStatus(${s.id},${jsq(s.status)},${jsq(hostIp)})">${escHtml(s.status)}</button>
    </div>
    <div class="svc-actions">
      <button class="svc-kebab" onclick="toggleSvcMenu('r${s.id}')" title="Actions">⋮</button>
      <div class="svc-menu" id="svcmenu-r${s.id}">
        ${s.url ? `<a href="${safeUrl(s.url)}" target="_blank" rel="noopener" class="svc-menu-item">↗ Open URL</a>` : ""}
        <button class="svc-menu-item" onclick="closeSvcMenus();openManageDeps(${s.id})">⊕ Dependencies</button>
        <button class="svc-menu-item" onclick="closeSvcMenus();openEditService(${s.id})">✎ Edit</button>
        <button class="svc-menu-item danger" onclick="closeSvcMenus();deleteSvc(${s.id},${jsq(hostIp)})">✕ Delete</button>
      </div>
    </div>
  </div>`;
}

const STATUS_CYCLE = { running: "stopped", stopped: "unknown", unknown: "running" };

async function cycleServiceStatus(id, current, hostIp) {
  const next = STATUS_CYCLE[current] || "unknown";
  await saveSvcField(id, "status", next);
}

function svcMonToggle(s) {
  const on = !!s.monitored;
  return `<button class="svc-toggle ${on ? 'on' : ''}" onclick="event.stopPropagation();svcRowToggleMonitor(${s.id})" title="${on ? 'Monitoring on — status is set automatically' : 'Monitoring off — status is manual'}">${on ? 'On' : 'Off'}</button>`;
}
async function svcRowToggleMonitor(id) {
  const s = allServices.find(x => x.id === id);
  if (!s) return;
  const on = !s.monitored;
  s.monitored = on ? 1 : 0;
  renderServicesTable();
  try {
    const r = await api("POST", `/api/services/${id}/monitor`, { enabled: on });
    if (r && r.monitor_status !== undefined) s.monitor_status = r.monitor_status;
    renderServicesTable();
  } catch (e) { await loadServicesData(); renderServicesTable(); }
}

function svcPubToggle(s) {
  const on = !!s.public;
  return `<button class="svc-toggle ${on ? 'on' : ''}" onclick="event.stopPropagation();svcRowTogglePublic(${s.id})" title="${on ? 'Shown on the public status page' : 'Not public'}">${on ? 'On' : 'Off'}</button>`;
}
async function svcRowTogglePublic(id) {
  const s = allServices.find(x => x.id === id);
  if (!s) return;
  const on = !s.public;
  const name = s.public_name || s.name;
  s.public = on ? 1 : 0;
  if (on && !s.public_name) s.public_name = name;
  renderServicesTable();
  try {
    await api("POST", `/api/services/${id}/public`, { enabled: on, name });
  } catch (e) { await loadServicesData(); renderServicesTable(); }
}

function svcPortProtoPencil(id) {
  return `<button class="cell-edit" title="Edit port / protocol" onclick="event.stopPropagation();editSvcPortProto(${id},this)">✎</button>`;
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
  if (s) { s.port = port; s.protocol = proto; }
  renderServicesTable();
  const payload = { port, protocol: proto };
  try {
    await api("PUT", `/api/services/${id}`, payload);
  } catch (e) {
    if (s) { s.port = prevPort; s.protocol = prevProto; }
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
    http: { url: true,  target: false, port: false },
    tcp:  { url: false, target: true,  port: true  },
    icmp: { url: false, target: true,  port: false },
  }[ct] || { url: true, target: true, port: true };
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
}

// Modal: grey the unused fields when the check type changes.
function svcCheckTypeChanged() {
  const ct = document.getElementById("svcCheckType").value;
  _applyCheckGrey(ct, { url: "svcUrl", target: "svcContainerIp", port: "svcPort" });
}

// Detail panel: same grey-out for the panel's own fields.
function svcDetailCheckChanged() {
  const ct = document.getElementById("svcDetailCheckType").value;
  _applyCheckGrey(ct, { url: "svcDetailUrl", target: "svcDetailContainerIp", port: "svcDetailPort" });
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
  urlEl.dataset.auto = "";
  document.getElementById("svcContainerIp").value = s.container_ip || "";
  document.getElementById("svcCheckType").value   = s.check_type || (s.url ? "http" : "tcp");
  svcCheckTypeChanged();
  document.getElementById("svcModalMonitored").checked = !!s.monitored;
  document.getElementById("svcModalPublic").checked    = !!s.public;
  document.getElementById("svcModalPublicName").value  = s.public_name || "";
  svcModalPublicToggled();
  populateSvcHostSelect(s.ip);                                 // let the host be changed on edit too
  document.getElementById("svcHostRow").style.display        = "";
  document.getElementById("containerPickRow").style.display  = "none";
  document.getElementById("svcDeleteBtn").style.display      = "";
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
  document.getElementById("svcModalPublic").checked    = false;
  document.getElementById("svcModalPublicName").value  = "";
  svcModalPublicToggled();
  document.getElementById("svcDeleteBtn").style.display = "none";

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
      return `<div class="container-chip" onclick="pickContainer(${jsq(h.ip)},${jsq(label)})">
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
        host_ip: document.getElementById("svcHostIp").value // allow moving to another host
      });
      svcId = parseInt(editId);
      allServices = allServices.map(s => s.id === svcId ? { ...s, ...svc } : s);
    } else {
      const hostIp = document.getElementById("svcHostIp").value;
      const svc = await api("POST", `/api/hosts/${hostIp}/services`, {
        name, description: desc, port, protocol: proto, status, url,
        check_type: checkType, container_ip: containerIp || null
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
      cur.monitored = monitored ? 1 : 0; cur.monitor_status = r.monitor_status;
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
    <tr id="svc-tr-${s.id}" style="cursor:pointer" onclick="showSvcDetail(${s.id})">
      <td class="td-check"><input type="checkbox" class="svc-checkbox" data-id="${s.id}" style="accent-color:var(--accent)" onclick="event.stopPropagation()" onchange="svcUpdateBulkBtn()"></td>
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
            : `<button class="svc-status ${escHtml(s.status)}" onclick="event.stopPropagation();cycleServiceStatus(${s.id},${jsq(s.status)},${jsq(s.ip)})">${escHtml(s.status)}</button>`}
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
  return `<button class="cell-edit" title="Edit ${field}" onclick="event.stopPropagation();editSvcField(${id},${jsq(field)},this)">✎</button>`;
}

function svcUrlCell(s) {
  const raw = s.url || "";
  if (!raw) return `<span class="note-add">＋ url</span>${svcEditPencil(s.id, 'url')}`;
  const full = escHtml(raw);
  const trunc = escHtml(raw.length > 40 ? raw.slice(0, 40) + "…" : raw);
  return `<a class="note-link svc-url-txt" href="${safeUrl(raw)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="${full}">${trunc}</a>${svcEditPencil(s.id, 'url')}`;
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
  if (!s.monitored) return "";
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
async function refreshMonitorStatus() {
  if (!allServices.some(s => s.monitored)) return;
  try {
    const fresh = await api("GET", "/api/services");
    const byId = new Map(fresh.map(s => [s.id, s]));
    let changed = false;
    allServices = allServices.map(s => {
      const f = byId.get(s.id);
      if (f && (f.monitor_status !== s.monitor_status || f.monitored !== s.monitored)) changed = true;
      return f ? { ...s, monitored: f.monitored, monitor_status: f.monitor_status, monitor_last_check: f.monitor_last_check } : s;
    });
    if (changed) {
      renderServicesTable();
      if (svcDetailId) {
        const cur = allServices.find(s => s.id === svcDetailId);
        if (cur) setSvcDetailMonDot(cur.monitored ? (cur.monitor_status || "unknown") : "off");
      }
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

