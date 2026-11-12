// Boltarr — Host detail panel, bottom sheet, panel resize, add/edit host, ports, AI analysis.
// Part of the app split from app.js (F-08); files share globals and load in order (see index.html).

// ── Host detail ───────────────────────────────────────────────────────────────

// DHCP warnings for one host, at the top of its Info tab.
function dhcpWarnBox(ip) {
  const w = (allHosts.find(h => h.ip === ip) || {}).dhcp_warnings || [];
  if (!w.length) return "";
  return `<div class="dhcp-warn-box">${w.map(x => `<div>⚠ ${escHtml(x.text)}</div>`).join("")}
    <button class="btn" data-dhcp-ignore="${escHtml(ip)}" style="font-size:11px;padding:4px 9px">Don't warn about this host</button></div>`;
}
document.addEventListener("click", async e => {
  const b = e.target.closest && e.target.closest("[data-dhcp-ignore]");
  if (!b) return;
  const ip = b.dataset.dhcpIgnore;
  await api("PUT", `/api/hosts/${ip}`, { no_dhcp_warn: true });
  b.closest(".dhcp-warn-box")?.remove();
  await loadHosts(); renderHostsTable();
  showToast("DHCP warnings off for this host (turn back on in Edit)");
});

async function showHostDetail(ip) {
  hideSvcDetail();
  const host = await api("GET", `/api/hosts/${ip}`);
  const panel = document.getElementById("hostDetail");
  const dt = host.device_type || "unknown";

  const sheetLabel = (host.hostname && !host.ip.startsWith('node-'))
    ? `${host.ip} · ${host.hostname}` : (host.ip.startsWith('node-') ? (host.hostname || '(no IP)') : host.ip);

  panel.innerHTML = `
    <div class="panel-resize-grip" title="Drag to resize"></div>
    <div class="sheet-handle" id="sheetHandle">
      <div class="sheet-pill"></div>
      <div class="sheet-handle-row">
        <span class="sheet-handle-label mono">${escHtml(sheetLabel)}</span>
        <span class="sheet-handle-hint" id="sheetHint">tap to expand</span>
        <button class="btn-ghost sheet-close" data-click="hideHostDetail" aria-label="Close" style="font-size:17px;padding:1px 6px;line-height:1;flex-shrink:0">×</button>
      </div>
    </div>
    <div class="detail-header">
      <div>
        <div class="detail-ip">${escHtml(host.ip.startsWith("node-") ? (host.hostname || "(no IP)") : host.ip)}</div>
        ${host.hostname && !host.ip.startsWith("node-") ? `<div class="detail-hostname">${escHtml(host.hostname)}</div>` : ""}
      </div>
      <span class="tag tag-${escHtml(dt)}" style="font-size:11px">${escHtml(dt)}</span>
      <div class="detail-header-right">
        <select id="analyzeModel" style="font-size:11px;padding:4px 7px;background:var(--surface2);border:1px solid var(--border);color:var(--text-2);border-radius:var(--radius-sm)"></select>
        <button class="btn btn-primary" style="font-size:11px;padding:5px 10px" data-click="analyzeHost" data-args="${dargs(ip)}">Analyze</button>
        <button class="btn" style="font-size:11px;padding:5px 10px" data-click="openEditHost" data-args="${dargs(ip)}">Edit</button>
        <button class="btn" style="font-size:11px;padding:5px 10px" data-click="openMergeHost" data-args="${dargs(ip)}">⇌ Merge</button>
        <select id="probeProfile" title="Scan profile for the probe" style="font-size:11px;padding:4px 6px;background:var(--surface2);border:1px solid var(--border);color:var(--text-2);border-radius:var(--radius-sm)">${_probeProfileOptions()}</select>
        <button class="btn" style="font-size:11px;padding:5px 10px" data-click="probeHost" data-args="${dargs(ip)}">⟳ Probe</button>
        <button class="btn btn-danger" style="font-size:11px;padding:5px 10px" data-click="deleteHost" data-args="${dargs(ip)}">Delete</button>
        <button class="btn-ghost" data-click="hideHostDetail" style="font-size:18px;padding:2px 8px">×</button>
      </div>
    </div>

    <div class="detail-tabs">
      <button class="detail-tab active" data-tab="info" data-click="switchDetailTab" data-args='["info"]'>Info</button>
      <button class="detail-tab" data-tab="links" data-click="switchDetailTab" data-args='["links"]'>Links (${countLinks(ip)})</button>
      <button class="detail-tab" data-tab="ports" data-click="switchDetailTab" data-args='["ports"]'>Ports (${(host.ports||[]).length})</button>
      <button class="detail-tab" data-tab="services" data-click="switchDetailTab" data-args='["services"]'>Services (${(host.services||[]).length})</button>
      <button class="detail-tab" data-tab="analysis" data-click="switchDetailTab" data-args='["analysis"]'>Analysis</button>
      <button class="detail-tab" data-tab="ssh" data-click="detailTabSsh" data-args="${dargs(ip)}">SSH</button>
      <button class="detail-tab" data-tab="changes" data-click="detailTabChanges" data-args="${dargs(ip)}">Changes</button>
    </div>

    <div class="detail-body">
      <!-- Info tab -->
      <div class="detail-tab-panel active" id="dtab-info">
        ${dhcpWarnBox(ip)}
        <div class="info-grid">
          <div class="info-field"><label>IP Address</label><span class="mono">${escHtml(host.ip)}</span></div>
          <div class="info-field"><label>MAC Address</label><span class="mono">${escHtml(host.mac||"—")}</span></div>
          <div class="info-field"><label>Vendor</label><span>${escHtml(host.vendor||"—")}</span></div>
          <div class="info-field"><label>Hostname</label><span>${escHtml(host.hostname||"—")}</span></div>
          <div class="info-field"><label>OS / Firmware</label><span>${escHtml(host.os_guess||"—")}</span></div>
          <div class="info-field"><label>Device Type</label><span>${escHtml(host.device_type||"unknown")}</span></div>
          <div class="info-field"><label>First Seen</label><span class="mono">${escHtml((host.first_seen||"—").substring(0,16))}</span></div>
          <div class="info-field"><label>Last Seen</label><span class="mono">${escHtml((host.last_seen||"—").substring(0,16))}</span></div>
        </div>
        ${host.ip.startsWith("node-") ? "" : `
        <div class="host-uptime-section">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3)">Liveness</span>
            <span style="font-size:11px">${livenessDot(host.online)}${host.online===1?"online":host.online===0?"offline":"unknown"}</span>
          </div>
          <div id="hostUptime-${ip.replace(/\./g,'_')}"><span style="font-size:11px;color:var(--text-3)">Loading…</span></div>
        </div>`}
        ${(host.aliases||[]).length ? `
        <div class="aliases-row" id="aliases-row-${ip.replace(/\./g,'_')}">
          <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3)">Additional IPs</span>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:5px">
            ${(host.aliases||[]).map(a => `
              <span class="alias-chip" title="${escHtml(aliasSeenTitle(host, a))}">
                ${aliasDot(host, a)}<span class="mono">${escHtml(a)}</span>
                <button class="btn-ghost" style="padding:0 3px;font-size:11px;line-height:1" data-click="removeAlias" data-args="${dargs(ip, a)}" title="Remove alias">×</button>
              </span>`).join("")}
          </div>
        </div>` : ""}
        ${host.notes ? `<div class="notes-box">${escHtml(host.notes)}</div>` : ""}
      </div>

      <!-- Links tab -->
      <div class="detail-tab-panel" id="dtab-links">
        ${buildLinksTab(ip, host.tier)}
      </div>

      <!-- Ports tab -->
      <div class="detail-tab-panel" id="dtab-ports">
        <div class="ports-list">
          ${(host.ports||[]).length
            ? (host.ports||[]).map(p => `
              <div class="port-row">
                <span class="port-num">${escHtml(p.port)}/${escHtml(p.protocol)}</span>
                <span class="port-svc">${escHtml(p.service||"unknown")}</span>
                <span class="port-ver">${escHtml(p.version||"")}</span>
                ${p.manual ? '<span class="port-manual-tag">manual</span>' : '<span></span>'}
                <button class="btn-ghost btn-danger" data-click="deletePort" data-args="${dargs(p.id, ip)}" style="font-size:12px;padding:2px 6px">✕</button>
              </div>`).join("")
            : `<div style="padding:16px 10px;font-size:12px;color:var(--text-3)">No ports detected.</div>`
          }
        </div>
        <div class="add-port-form">
          <div class="field"><label>Port</label><input type="number" id="newPort" placeholder="8080" class="mono"></div>
          <div class="field"><label>Proto</label><select id="newProto" class="sel-proto"><option>tcp</option><option>udp</option></select></div>
          <div class="field"><label>Service</label><input type="text" id="newService" placeholder="http" class="inp-svc"></div>
          <div class="field"><label>Version</label><input type="text" id="newVersion" placeholder="nginx 1.24" class="inp-ver"></div>
          <button class="btn btn-primary" style="font-size:11px;align-self:flex-end" data-click="addPort" data-args="${dargs(ip)}">+ Add</button>
        </div>
      </div>

      <!-- Services tab -->
      <div class="detail-tab-panel" id="dtab-services">
        <div class="svc-list" id="dtab-svc-list-${ip.replace(/\./g,'_')}">
          ${(host.services||[]).length ? (host.services||[]).map(s => svcRowHTML(s, ip)).join("") :
            `<div style="padding:14px 10px;font-size:12px;color:var(--text-3)">No services yet.</div>`}
        </div>
        <div class="add-port-form">
          <div class="field"><label>Name</label><input type="text" id="newSvcName" placeholder="e.g. Plex"></div>
          <div class="field"><label>Port</label><input type="number" id="newSvcPort" placeholder="8080" class="mono" data-input="hostSvcPortTyped" data-args="${dargs(ip)}"></div>
          <div class="field"><label>Status</label>
            <select id="newSvcStatus">
              <option value="unknown">Unknown</option>
              <option value="running">Running</option>
              <option value="stopped">Stopped</option>
            </select>
          </div>
          <div class="field" style="flex:2"><label>URL</label><input type="text" id="newSvcUrl" placeholder="http://…" data-input="svcUrlTyped"></div>
          <button class="btn btn-primary" style="font-size:11px;align-self:flex-end" data-click="addServiceToHost" data-args="${dargs(ip)}">+ Add</button>
        </div>
      </div>

      <!-- SSH tab -->
      <div class="detail-tab-panel" id="dtab-ssh" style="padding:10px 0"></div>

      <!-- Changes tab -->
      <div class="detail-tab-panel" id="dtab-changes" style="padding:10px 0">
        <div id="hostChanges-${ip.replace(/\./g,'_')}"><span style="font-size:11px;color:var(--text-3)">Loading…</span></div>
      </div>

      <!-- Analysis tab -->
      <div class="detail-tab-panel" id="dtab-analysis">
        <div id="analysisResult">
          ${host.analyses?.length
            ? _analysisHtml(host.analyses[0], host.analyses.slice(1))
            : `<div style="padding:16px 0;font-size:12px;color:var(--text-3)">No analysis yet. Click Analyze to run the LLM.</div>`
          }
        </div>
      </div>
    </div>
  `;

  fillModelSelect(document.getElementById("analyzeModel"));

  panel.classList.add("open");
  initSheetDrag();
  makeDesktopResizable(panel, "host");
  if (!host.ip.startsWith("node-")) loadHostUptime(ip);
  // Open on the tab last picked (until the page reloads), so switching hosts
  // keeps you on e.g. Analysis. SSH and Changes load their content on demand.
  if (activeDetailTab !== "info" && document.getElementById(`dtab-${activeDetailTab}`)) {
    if (activeDetailTab === "ssh") loadHostSshSection(ip);
    if (activeDetailTab === "changes") loadHostChanges(ip);
    switchDetailTab(activeDetailTab);
  }
}

async function loadHostUptime(ip) {
  const el = document.getElementById(`hostUptime-${ip.replace(/\./g, "_")}`);
  if (!el) return;
  try {
    const d = await api("GET", `/api/hosts/${ip}/uptime`);
    const stat = (label, u) =>
      !u ? `<div class="uptime-stat"><span class="val" style="color:var(--text-3)">—</span><span class="lbl">${escHtml(label)}</span></div>`
         : `<div class="uptime-stat"><span class="val ${_uptimeClass(u.pct)}">${u.pct.toFixed(2)}%</span><span class="lbl">${escHtml(label)}</span></div>`;
    const rows = `<div class="uptime-row">${stat("24 h", d.uptime["24h"])}${stat("7 days", d.uptime["7d"])}${stat("30 days", d.uptime["30d"])}</div>`;
    const outages = outageListHtml("host", d.host_id, d.outages);
    el.innerHTML = rows + outages + `<div class="uptime-reset"><button class="btn-ghost" data-click="resetHostUptime" data-args="${dargs(ip)}">↺ Reset uptime</button></div>`;
  } catch {
    el.innerHTML = `<span style="font-size:11px;color:var(--text-3)">No uptime data yet.</span>`;
  }
}

function switchDetailTab(name) {
  activeDetailTab = name;
  document.querySelectorAll(".detail-tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === name)
  );
  document.querySelectorAll(".detail-tab-panel").forEach(p =>
    p.classList.toggle("active", p.id === `dtab-${name}`)
  );
}

function hideHostDetail() {
  const panel = document.getElementById("hostDetail");
  panel.classList.remove("open", "sheet-half", "sheet-full");
}

// ── Bottom sheet (mobile host detail) ─────────────────────────────────────────

function setSheetState(state) {
  const panel = document.getElementById("hostDetail");
  const hint  = document.getElementById("sheetHint");
  panel.classList.remove("sheet-half", "sheet-full");
  if (state === "half") panel.classList.add("sheet-half");
  else if (state === "full") panel.classList.add("sheet-full");
  if (hint) hint.textContent = state === "peek" ? "tap to expand" : "";
}

function cycleSheetState() {
  const panel = document.getElementById("hostDetail");
  if (panel.classList.contains("sheet-full"))      setSheetState("peek");
  else if (panel.classList.contains("sheet-half")) setSheetState("full");
  else                                              setSheetState("half");
}

// ── Desktop: drag the top grip to resize a detail panel (remembered) ──────────
let _panelResize = null;
function makeDesktopResizable(panel, key, cssVar) {
  if (!panel || window.innerWidth <= 799) return;   // mobile has its own sheet drag
  const saved = localStorage.getItem("boltarr-panel-h-" + key);
  if (saved) panel.style.height = saved;
  const grip = panel.querySelector(".panel-resize-grip");
  if (!grip) return;
  grip.onmousedown = e => {
    e.preventDefault();
    _panelResize = { panel, key, startY: e.clientY, startH: panel.getBoundingClientRect().height };
    document.body.style.userSelect = "none";
  };
}
document.addEventListener("mousemove", e => {
  if (!_panelResize) return;
  const { panel, startY, startH } = _panelResize;
  const h = Math.max(220, Math.min(startH + (startY - e.clientY), window.innerHeight * 0.92));
  panel.style.height = h + "px";   // dragging up grows the panel
});
document.addEventListener("mouseup", () => {
  if (!_panelResize) return;
  localStorage.setItem("boltarr-panel-h-" + _panelResize.key, _panelResize.panel.style.height);
  _panelResize = null;
  document.body.style.userSelect = "";
});

function initSheetDrag() {
  if (window.innerWidth > 799) return;
  const panel  = document.getElementById("hostDetail");
  const handle = document.getElementById("sheetHandle");
  if (!handle) return;

  let startY = 0, startTY = 0, moved = false, dragging = false;

  function getTY() {
    const t = getComputedStyle(panel).transform;
    if (!t || t === "none") return 0;
    const m = t.match(/matrix\([^)]+\)/);
    if (m) return parseFloat(t.split(",")[5]) || 0;
    return 0;
  }

  function onDragStart(clientY) {
    startY  = clientY;
    startTY = getTY();
    moved   = false;
    dragging = true;
    panel.style.transition = "none";
  }

  function onDragMove(clientY) {
    if (!dragging) return;
    const dy = clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    const h = window.innerHeight * 0.85;
    const clamped = Math.max(0, Math.min(startTY + dy, h - 48));
    panel.style.transform = `translateY(${clamped}px)`;
  }

  function onDragEnd() {
    if (!dragging) return;
    dragging = false;
    if (!moved) {
      panel.style.transition = "";
      panel.style.transform  = "";
      cycleSheetState();
      return;
    }
    const current = getTY();
    const h = window.innerHeight * 0.85;
    const snaps = [
      { y: 0,      state: "full" },
      { y: h / 2,  state: "half" },
      { y: h - 48, state: "peek" },
    ];
    const nearest = snaps.reduce((a, b) =>
      Math.abs(a.y - current) < Math.abs(b.y - current) ? a : b
    );
    panel.style.transition = "transform 0.35s cubic-bezier(0.32,0.72,0,1)";
    panel.style.transform  = `translateY(${nearest.y}px)`;
    setTimeout(() => {
      panel.style.transition = "";
      panel.style.transform  = "";
      setSheetState(nearest.state);
    }, 360);
  }

  // Touch
  // A tap on a button in the handle (the ×) is that button's, not "tap to expand".
  handle.addEventListener("touchstart", e => { if (!e.target.closest("button")) onDragStart(e.touches[0].clientY); }, { passive: true });
  handle.addEventListener("touchmove",  e => onDragMove(e.touches[0].clientY),  { passive: true });
  handle.addEventListener("touchend",   onDragEnd);

  // Mouse
  handle.addEventListener("mousedown", e => { if (e.target.closest("button")) return; e.preventDefault(); onDragStart(e.clientY); });
  document.addEventListener("mousemove", e => onDragMove(e.clientY));
  document.addEventListener("mouseup",   onDragEnd);
}

// ── Add host ──────────────────────────────────────────────────────────────────

function openAddHost() {
  ["addHostIp","addHostHostname","addHostMac","addHostVendor","addHostOs","addHostNotes"]
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
  const sel = document.getElementById("addHostDeviceType");
  if (sel) {
    sel.innerHTML = DEVICE_TYPES.map(t => `<option value="${t}"${t === "unknown" ? " selected" : ""}>${t}</option>`).join("");
  }
  document.getElementById("addHostModal").classList.add("open");
}
function closeAddHost() {
  document.getElementById("addHostModal").classList.remove("open");
}
async function saveAddHost() {
  const payload = {
    ip:          document.getElementById("addHostIp").value.trim() || null,
    hostname:    document.getElementById("addHostHostname").value.trim() || null,
    mac:         document.getElementById("addHostMac").value.trim() || null,
    vendor:      document.getElementById("addHostVendor").value.trim() || null,
    os_guess:    document.getElementById("addHostOs").value.trim() || null,
    device_type: document.getElementById("addHostDeviceType").value,
    notes:       document.getElementById("addHostNotes").value.trim() || null,
  };
  if (!payload.ip && !payload.hostname) return alert("Enter at least an IP or hostname.");
  try {
    await api("POST", "/api/hosts", payload);
    closeAddHost();
    await loadHosts();
    renderHostsTable();
    await loadGraph();
  } catch (e) { alert("Error: " + e.message); }
}

// ── Edit host ─────────────────────────────────────────────────────────────────

const DEVICE_TYPES = ["router","gateway","switch","unmanaged-switch","firewall","server","nas",
  "workstation","pc","laptop","iot","camera","printer","phone","tablet","tv",
  "container","vm","ap","unknown"];

async function openEditHost(ip) {
  const host = await api("GET", `/api/hosts/${ip}`);
  document.getElementById("editIp").value         = ip;   // original IP (the key)
  const ipNew = document.getElementById("editIpNew");
  const synthetic = ip.startsWith("node-");
  ipNew.value = synthetic ? "" : ip;
  ipNew.disabled = synthetic;                             // placeholder nodes have no real IP
  ipNew.placeholder = synthetic ? "(placeholder node)" : "192.168.1.50";
  document.getElementById("editHostname").value   = host.hostname || "";
  document.getElementById("editMac").value        = host.mac || "";
  document.getElementById("editVendor").value     = host.vendor || "";
  document.getElementById("editOs").value         = host.os_guess || "";
  document.getElementById("editNotes").value      = host.notes || "";
  document.getElementById("editTierL1").checked   = host.tier === 1;
  document.getElementById("editPortCount").value  = host.port_count || 1;
  document.getElementById("editHasWifi").checked  = !!host.has_wifi;
  document.getElementById("editIsDns").checked    = !!host.is_dns;
  document.getElementById("editIsDhcp").checked   = !!host.is_dhcp;
  document.getElementById("editDhcpPool").value   = host.dhcp_pool || "";
  document.getElementById("editStaticOverride").value = host.static_override || "";
  document.getElementById("editNoMacAlert").checked   = !!host.no_mac_alert;
  document.getElementById("editNoOfflineAlert").checked = !!host.no_offline_alert;
  document.getElementById("editNoDhcpWarn").checked = !!host.no_dhcp_warn;
  document.getElementById("editPublic").checked = !!host.public;
  document.getElementById("editPublicName").value = host.public_name || "";
  onEditPublicToggle();
  document.getElementById("editDhcpPoolRow").style.display = host.is_dhcp ? "" : "none";
  const sel = document.getElementById("editDeviceType");
  sel.innerHTML = DEVICE_TYPES.map(t =>
    `<option value="${t}"${t === host.device_type ? " selected" : ""}>${t}</option>`
  ).join("");
  document.getElementById("editModal").classList.add("open");
}
function closeEditHost() {
  document.getElementById("editModal").classList.remove("open");
}

function onEditPublicToggle() {
  document.getElementById("editPublicNameRow").style.display =
    document.getElementById("editPublic").checked ? "" : "none";
}
async function deleteHost(ip) {
  const label = ip.startsWith("node-") ? "this device" : ip;
  if (!confirm(`Delete ${label} and all its connections?`)) return;
  try {
    await api("DELETE", `/api/hosts/${ip}`);
    hideHostDetail();
    await loadHosts(); renderHostsTable(); await loadGraph();
  } catch (e) { alert("Error: " + e.message); }
}

function openMergeHost(ip) {
  const others = allHosts.filter(h => h.ip !== ip);
  if (!others.length) return alert("No other hosts to merge with.");
  const sel = document.getElementById("mergeTargetIp");
  sel.innerHTML = others.map(h =>
    `<option value="${escHtml(h.ip)}">${h.ip.startsWith("node-") ? "" : escHtml(h.ip) + " — "}${escHtml(h.hostname || h.device_type || "unknown")}</option>`
  ).join("");
  document.getElementById("mergePrimaryIp").value = ip;
  const primaryLabel = document.getElementById("mergePrimaryLabel");
  const me = allHosts.find(h => h.ip === ip);
  primaryLabel.textContent = (me?.hostname || ip) + (me?.hostname ? ` (${ip})` : "");
  document.getElementById("mergeModal").classList.add("open");
}

function closeMergeHost() {
  document.getElementById("mergeModal").classList.remove("open");
}

async function saveMergeHost() {
  const ip      = document.getElementById("mergePrimaryIp").value;
  const mergeIp = document.getElementById("mergeTargetIp").value;
  if (!confirm(`Merge ${mergeIp} into ${ip}?\n\nThe host at ${mergeIp} will be deleted. Its connections, ports, and services will transfer to ${ip}.`)) return;
  try {
    const host = await api("POST", `/api/hosts/${ip}/merge`, { merge_ip: mergeIp });
    closeMergeHost();
    await loadHosts(); renderHostsTable(); await loadGraph();
    await showHostDetail(ip);
  } catch (e) { alert("Error: " + e.message); }
}

async function removeAlias(ip, aliasIp) {
  if (!confirm(`Remove alias ${aliasIp} from ${ip}?\n\nFuture scans of ${aliasIp} will create a new host record.`)) return;
  try {
    await api("DELETE", `/api/hosts/${ip}/aliases/${aliasIp}`);
    await loadHosts(); renderHostsTable();
    await showHostDetail(ip);
  } catch (e) { alert("Error: " + e.message); }
}
async function saveHostEdit() {
  const originalIp = document.getElementById("editIp").value;
  const ipField    = document.getElementById("editIpNew");
  const newIp      = ipField.disabled ? originalIp : ipField.value.trim();
  // If the IP was changed, rename first (cascades everywhere); abort save on failure.
  if (newIp && newIp !== originalIp) {
    try {
      await api("POST", `/api/hosts/${encodeURIComponent(originalIp)}/rename`, { new_ip: newIp });
    } catch (e) {
      alert("Couldn't change the IP: " + e.message);
      return;
    }
  }
  const ip = (newIp && newIp !== originalIp) ? newIp : originalIp;
  const payload = {
    hostname:    document.getElementById("editHostname").value.trim() || null,
    mac:         document.getElementById("editMac").value.trim() || null,
    device_type: document.getElementById("editDeviceType").value,
    vendor:      document.getElementById("editVendor").value.trim() || null,
    os_guess:    document.getElementById("editOs").value.trim() || null,
    notes:       document.getElementById("editNotes").value.trim() || null,
    set_tier:    true,
    tier:        document.getElementById("editTierL1").checked ? 1 : null,
    port_count:  parseInt(document.getElementById("editPortCount").value) || 1,
    has_wifi:    document.getElementById("editHasWifi").checked,
    is_dns:      document.getElementById("editIsDns").checked,
    is_dhcp:     document.getElementById("editIsDhcp").checked,
    set_dhcp:    true,
    dhcp_pool:   document.getElementById("editDhcpPool").value.trim() || null,
    set_static_override: true,
    static_override:     document.getElementById("editStaticOverride").value || null,
    no_mac_alert:        document.getElementById("editNoMacAlert").checked,
    no_offline_alert:    document.getElementById("editNoOfflineAlert").checked,
    no_dhcp_warn:        document.getElementById("editNoDhcpWarn").checked,
    set_public:          true,
    public:              document.getElementById("editPublic").checked,
    public_name:         document.getElementById("editPublicName").value.trim() || null,
  };
  try {
    await api("PUT", `/api/hosts/${ip}`, payload);
    closeEditHost();
    await loadHosts();
    renderHostsTable();
    await loadGraph();
    await showHostDetail(ip);
  } catch (e) { alert("Error: " + e.message); }
}

// ── Ports ─────────────────────────────────────────────────────────────────────

async function addPort(ip) {
  const port    = parseInt(document.getElementById("newPort").value);
  const proto   = document.getElementById("newProto").value;
  const service = document.getElementById("newService").value.trim() || null;
  const version = document.getElementById("newVersion").value.trim() || null;
  if (!port || port < 1 || port > 65535) return alert("Enter a valid port (1–65535).");
  try {
    await api("POST", `/api/hosts/${ip}/ports`, { port, protocol: proto, service, version });
    await loadHosts(); renderHostsTable();
    await showHostDetail(ip);
    switchDetailTab("ports");
  } catch (e) { alert("Error: " + e.message); }
}

async function deletePort(portId, ip) {
  if (!confirm("Delete this port?")) return;
  await api("DELETE", `/api/ports/${portId}`);
  await loadHosts(); renderHostsTable();
  await showHostDetail(ip);
  switchDetailTab("ports");
}

// ── LLM analysis ─────────────────────────────────────────────────────────────

// One analysis (host or network) plus its earlier saved runs
function _analysisHtml(a, earlier) {
  return `<div class="analysis-meta">${escHtml(aiMeta(a))}</div>
    <div class="analysis-box md">${renderMarkdown(a.analysis)}</div>
    ${aiEarlierHtml(earlier, x => `<div class="analysis-box md">${renderMarkdown(x.analysis)}</div>`)}`;
}

async function analyzeHost(ip) {
  const model = document.getElementById("analyzeModel")?.value
             || AI_DEFAULT_MODEL;
  const resultDiv = document.getElementById("analysisResult");
  resultDiv.innerHTML = '<div class="analysis-box" style="color:var(--text-3)">Analyzing…</div>';
  switchDetailTab("analysis");
  try {
    const data = await api("POST", `/api/hosts/${ip}/analyze`, { model });
    resultDiv.innerHTML = _analysisHtml({ ...data, created_at: new Date().toISOString() }, data.earlier);
    await loadHosts(); renderHostsTable(); await loadGraph();
  } catch (e) {
    resultDiv.innerHTML = `<div class="analysis-box" style="color:var(--red)">Error: ${escHtml(e.message)}</div>`;
  }
}

async function openNetworkAnalysis() {
  const modal = document.getElementById("networkAnalysisModal");
  const modelSel = document.getElementById("netAnalyzeModel");
  if (modelSel && !modelSel.options.length) fillModelSelect(modelSel);
  modal.classList.add("open");
  // Show the last saved analysis (AI history), unless one is running or showing
  const resultDiv = document.getElementById("networkAnalysisResult");
  if (resultDiv.dataset.state) return;
  try {
    const { analyses } = await api("GET", "/api/analyze/network");
    if (analyses.length && !resultDiv.dataset.state) {
      resultDiv.dataset.state = "shown";
      resultDiv.innerHTML = _analysisHtml(analyses[0], analyses.slice(1));
    }
  } catch (e) { /* keep the "Click Run Analysis" hint */ }
}

function closeNetworkAnalysis() {
  document.getElementById("networkAnalysisModal").classList.remove("open");
}

async function runNetworkAnalysis() {
  const model = document.getElementById("netAnalyzeModel")?.value
             || AI_DEFAULT_MODEL;
  const resultDiv = document.getElementById("networkAnalysisResult");
  resultDiv.dataset.state = "running";
  resultDiv.innerHTML = '<div class="analysis-box" style="color:var(--text-3)">Analyzing full network… this may take a moment.</div>';
  try {
    const data = await api("POST", "/api/analyze/network", { model });
    resultDiv.dataset.state = "shown";
    resultDiv.innerHTML = _analysisHtml({ ...data, created_at: new Date().toISOString() }, data.earlier);
  } catch (e) {
    delete resultDiv.dataset.state;
    resultDiv.innerHTML = `<div class="analysis-box" style="color:var(--red)">Error: ${escHtml(e.message)}</div>`;
  }
}

// ── Graph ─────────────────────────────────────────────────────────────────────

async function loadGraph() {
  const { nodes, edges } = await api("GET", "/api/graph");
  graphEdges = edges || [];
  if (typeof renderGraph === "function") renderGraph(nodes, edges);
}


// Edit host: the DHCP pool fields only show for a DHCP server.
function editDhcpToggled() {
  document.getElementById("editDhcpPoolRow").style.display = this.checked ? "" : "none";
}

registerActions({
  openNetworkAnalysis, runNetworkAnalysis, closeNetworkAnalysis,
  showHostDetail, hideHostDetail, analyzeHost, openEditHost, openMergeHost, probeHost, deleteHost,
  switchDetailTab, removeAlias, deletePort, addPort,
  openAddHost, closeAddHost, saveAddHost, closeMergeHost, saveMergeHost,
  closeEditHost, saveHostEdit, onEditPublicToggle, editDhcpToggled,
  detailTabSsh:     ip => { switchDetailTab("ssh"); loadHostSshSection(ip); },
  detailTabChanges: ip => { switchDetailTab("changes"); loadHostChanges(ip); },
  hostSvcPortTyped: function (ip) { autoFillSvcUrl(ip, this.value, "newSvcUrl"); },
});
