// Boltarr — main application logic

let allHosts        = [];
let graphEdges      = [];
let subnets         = [];
let allServices     = [];
let allDependencies = [];
let allVlans        = [];
let hiddenSubnets   = new Set();
let activeRunId     = null;
let pollTimer       = null;
let sortCol         = "ip";
let sortDir         = 1;
let filterText      = "";
let activeDetailTab = "info";
let currentSvcTab   = "list";
let svcHostFilterVal = "";
let svcCy           = null;

// ── API ───────────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  await Promise.all([loadSubnets(), loadModels(), loadHosts(), loadServicesData(), loadVlans()]);
  renderHostsTable();
  await loadGraph();
  await loadScans();
  setTab("topology");
  api("GET", "/api/version").then(d => {
    const el = document.getElementById("appVersion");
    if (el && d.version) el.textContent = "v" + d.version;
  }).catch(() => {});
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function toggleSidebar() {
  document.getElementById("sidebar").classList.toggle("open");
  document.getElementById("sidebarOverlay").classList.toggle("visible");
}
function closeSidebar() {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("sidebarOverlay").classList.remove("visible");
}

// ── Subnets ───────────────────────────────────────────────────────────────────

async function loadSubnets() {
  subnets = await api("GET", "/api/subnets");
  window.subnets = subnets;
  renderSubnetList();
}

function renderSubnetList() {
  window.subnets = subnets; // expose for graph.js
  const list = document.getElementById("subnetList");
  if (!subnets.length) {
    list.innerHTML = `<div style="padding:10px 16px;font-size:11px;color:var(--text-3)">No subnets yet.<br>Click + to add one.</div>`;
    return;
  }
  list.innerHTML = subnets.map(s => {
    const hidden = hiddenSubnets.has(s.id);
    return `
    <div class="subnet-row${hidden ? " subnet-hidden" : ""}" id="subnet-row-${s.id}" onclick="selectSubnetNodes(${s.id})" title="Click to select all hosts in this subnet">
      <div class="subnet-dot" id="subnet-dot-${s.id}"></div>
      <div class="subnet-info">
        <div class="subnet-name">${s.name}</div>
        <div class="subnet-cidr mono">${s.cidr}</div>
      </div>
      <button class="btn-icon subnet-eye" onclick="event.stopPropagation(); toggleSubnetVisibility(${s.id})" title="${hidden ? "Show" : "Hide"} in topology">${hidden ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>` : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`}</button>
      <button class="btn-scan" onclick="event.stopPropagation(); triggerScan(${s.id})" title="Scan ${s.cidr}">▶</button>
    </div>`;
  }).join("");
}

function toggleSubnetVisibility(subnetId) {
  if (hiddenSubnets.has(subnetId)) hiddenSubnets.delete(subnetId);
  else hiddenSubnets.add(subnetId);
  renderSubnetList();
  if (typeof applySubnetVisibility === "function") applySubnetVisibility();
}

function selectSubnetNodes(subnetId) {
  if (typeof selectNodesInSubnet === "function") selectNodesInSubnet(subnetId);
}

function openAddSubnet() {
  closeSidebar();
  document.getElementById("subnetModal").classList.add("open");
  setTimeout(() => document.getElementById("subnetName").focus(), 50);
}
function closeAddSubnet() {
  document.getElementById("subnetModal").classList.remove("open");
}
async function saveSubnet() {
  const name = document.getElementById("subnetName").value.trim();
  const cidr = document.getElementById("subnetCidr").value.trim();
  const desc = document.getElementById("subnetDesc").value.trim();
  if (!name || !cidr) return alert("Name and CIDR are required.");
  try {
    await api("POST", "/api/subnets", { name, cidr, description: desc });
    ["subnetName","subnetCidr","subnetDesc"].forEach(id => document.getElementById(id).value = "");
    closeAddSubnet();
    await loadSubnets();
  } catch (e) { alert("Error: " + e.message); }
}

// ── Scanning ──────────────────────────────────────────────────────────────────

async function triggerScan(subnetId) {
  const dot = document.getElementById(`subnet-dot-${subnetId}`);
  if (dot) dot.className = "subnet-dot scanning";
  try {
    const { run_id } = await api("POST", `/api/scan/${subnetId}`);
    activeRunId = run_id;
    startPolling(subnetId);
  } catch (e) {
    if (dot) dot.className = "subnet-dot";
    alert("Scan error: " + e.message);
  }
}

async function stopScan() {
  if (!activeRunId) return;
  try {
    await api("POST", `/api/scan/${activeRunId}/cancel`);
  } catch (_) {}
}

async function probeHost(ip) {
  try {
    const { run_id } = await api("POST", `/api/hosts/${ip}/probe`);
    activeRunId = run_id;
    showToast(`Probing ${ip}…`);
    startProbePolling(run_id, ip);
  } catch (e) {
    alert("Probe error: " + e.message);
  }
}

function startProbePolling(run_id, ip) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const job = await api("GET", `/api/scan/${run_id}/status`);
    if (["completed", "error", "cancelled"].includes(job.status)) {
      clearInterval(pollTimer);
      activeRunId = null;
      if (job.status === "completed") {
        showToast(`Probe of ${ip} complete`);
        await loadHosts();
        renderHostsTable();
        await loadGraph();
        const detail = document.getElementById("hostDetail");
        if (detail.classList.contains("open")) await showHostDetail(ip);
        await loadScans();
      } else if (job.status === "error") {
        showToast("Probe failed: " + (job.error || "unknown error"));
      }
    }
  }, 1500);
}

function startPolling(subnetId) {
  const overlay = document.getElementById("scanProgress");
  overlay.classList.add("visible");
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const job = await api("GET", `/api/scan/${activeRunId}/status`);
    const pct = job.progress || 0;
    document.getElementById("progressBar").style.width = pct + "%";
    document.getElementById("progressLabel").textContent =
      job.status === "discovering" ? "Discovering…" :
      job.status === "scanning"    ? `Scanning ${pct}%` :
      job.status === "completed"   ? `Done — ${job.total || 0} hosts` :
      job.status === "cancelled"   ? "Scan stopped" :
      job.status === "error"       ? "Error: " + (job.error || "?") : job.status;

    if (["completed", "error", "cancelled"].includes(job.status)) {
      clearInterval(pollTimer);
      const dot = document.getElementById(`subnet-dot-${subnetId}`);
      if (dot) dot.className = "subnet-dot " + (job.status === "completed" ? "scanned" : "");
      setTimeout(() => overlay.classList.remove("visible"), 3000);
      await loadHosts();
      renderHostsTable();
      await loadGraph();
      await loadScans();
      activeRunId = null;
    }
  }, 1500);
}

// ── Hosts table ───────────────────────────────────────────────────────────────

async function loadHosts() {
  allHosts = await api("GET", "/api/hosts");
}

function renderHostsTable() {
  const tbody = document.querySelector("#hostsTable tbody");
  tbody.innerHTML = "";

  let visible = allHosts;
  if (filterText) {
    const q = filterText.toLowerCase();
    visible = allHosts.filter(h =>
      (h.ip||"").includes(q) ||
      (h.hostname||"").toLowerCase().includes(q) ||
      (h.vendor||"").toLowerCase().includes(q) ||
      (h.device_type||"").toLowerCase().includes(q) ||
      (h.ports||[]).some(p => (p.service||"").toLowerCase().includes(q))
    );
  }

  const count = document.getElementById("hostCount");
  if (count) count.textContent = `${visible.length} of ${allHosts.length}`;

  const sorted = [...visible].sort((a, b) => {
    let va = a[sortCol] ?? "", vb = b[sortCol] ?? "";
    if (sortCol === "ip") { va = ipToNum(va); vb = ipToNum(vb); }
    if (sortCol === "open_ports") {
      va = (a.ports||[]).filter(p => p.state === "open").length;
      vb = (b.ports||[]).filter(p => p.state === "open").length;
    }
    return va < vb ? -sortDir : va > vb ? sortDir : 0;
  });

  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--text-3);font-size:12px">${filterText ? "No matches." : "No hosts yet — add a subnet and scan."}</td></tr>`;
    return;
  }

  sorted.forEach(h => {
    const openPorts = (h.ports||[]).filter(p => p.state === "open");
    const portHtml = openPorts.slice(0,5).map(p =>
      `<span class="port-badge${p.manual ? ' manual' : ''}">${p.port}/${p.service||"?"}</span>`
    ).join("");
    const more = openPorts.length > 5 ? `<span class="port-badge">+${openPorts.length-5}</span>` : "";
    const dt = h.device_type || "unknown";

    const isSynthetic = h.ip.startsWith("node-");
    const aliasCount  = (h.aliases||[]).length;
    const aliasBadge  = aliasCount ? `<span class="port-badge" style="margin-left:4px" title="${(h.aliases||[]).join(', ')}">+${aliasCount} IP${aliasCount>1?'s':''}</span>` : "";
    const manualBadge = h.source === "manual" ? `<span class="port-badge" style="margin-left:4px;background:oklch(38% 0.1 280);color:oklch(78% 0.1 280)">manual</span>` : "";
    const displayIp   = isSynthetic ? `<span style="color:var(--text-3)">—</span>` : h.ip + aliasBadge;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="td-ip mono" style="color:var(--accent)">${displayIp}</td>
      <td class="td-host">${h.hostname || `<span style="color:var(--text-3)">—</span>`}</td>
      <td class="col-mac mono" style="color:var(--text-3)">${h.mac||"—"}</td>
      <td class="col-vendor" style="color:var(--text-2);font-size:11px">${h.vendor||"—"}</td>
      <td class="td-type"><span class="tag tag-${dt}">${dt}</span>${manualBadge}</td>
      <td class="col-os" style="font-size:11px;color:var(--text-3)">${(h.os_guess||"—").substring(0,34)}</td>
      <td><div class="port-list">${portHtml}${more}</div></td>
      <td class="td-seen mono" style="color:var(--text-3)">${(h.last_seen||"—").substring(0,16)}</td>
    `;
    tr.addEventListener("click", () => showHostDetail(h.ip));
    tbody.appendChild(tr);
  });
}

function ipToNum(ip) {
  return (ip||"").split(".").reduce((a, o) => a * 256 + parseInt(o||0), 0);
}
function sortTable(col) {
  sortDir = sortCol === col ? -sortDir : 1;
  sortCol = col;
  document.querySelectorAll("thead th").forEach(th => th.classList.remove("sort-active"));
  renderHostsTable();
}

function formatMacInput(e) {
  const input = e.target;
  const pos = input.selectionStart;
  const raw = input.value.replace(/[^0-9a-fA-F]/g, "").substring(0, 12);
  const formatted = raw.match(/.{1,2}/g)?.join(":") || "";
  input.value = formatted;
  // keep cursor roughly in place after formatting inserts colons
  const colonsAdded = (formatted.substring(0, pos).match(/:/g) || []).length;
  input.setSelectionRange(Math.min(pos + colonsAdded, formatted.length), Math.min(pos + colonsAdded, formatted.length));
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("tableFilter")?.addEventListener("input", e => {
    filterText = e.target.value;
    renderHostsTable();
  });
  document.getElementById("addHostMac")?.addEventListener("input", formatMacInput);
  document.getElementById("editMac")?.addEventListener("input", formatMacInput);
});

// ── Links tab helpers ─────────────────────────────────────────────────────────

const LINK_SPEEDS = ["","10Mbps","100Mbps","1Gbps","2.5Gbps","5Gbps","10Gbps",
                     "25Gbps","40Gbps","100Gbps","400Gbps"];
const LINK_TYPES  = ["wired","fiber","dac","wifi","virtual"];

function getHostLinks(ip) {
  return (graphEdges || []).filter(e => e.data.source === ip || e.data.target === ip);
}

function countLinks(ip) {
  return getHostLinks(ip).length;
}

function buildLinksTab(ip, myTier) {
  const links = getHostLinks(ip);
  const hostSelect = allHosts
    .filter(h => h.ip !== ip)
    .map(h => `<option value="${h.ip}">${h.ip.startsWith("node-") ? "" : h.ip + " — "}${h.hostname || h.device_type || "unknown"}</option>`)
    .join("");

  const rows = links.map(e => {
    const peerIp  = e.data.source === ip ? e.data.target : e.data.source;
    const peer    = allHosts.find(h => h.ip === peerIp);
    const peerLabel = peer ? (peer.hostname || peerIp) : peerIp;
    const peerDt  = peer?.device_type || "unknown";
    const peerTier = peer?.tier ?? null;

    let dir = "↔";
    if (myTier != null && peerTier != null) {
      dir = peerTier < myTier ? "↑" : peerTier > myTier ? "↓" : "↔";
    } else if (myTier == null && peerTier != null) {
      dir = "↑";
    }
    const dirColor = dir === "↑" ? "var(--text-3)" : dir === "↓" ? "var(--accent)" : "var(--text-2)";

    const speed    = e.data.speed    ? `<span class="port-badge mono">${e.data.speed}</span>` : "";
    const mode     = e.data.port_mode ? `<span class="port-badge">${e.data.port_mode}</span>` : "";
    const vlanBadges = (e.data.vlans || []).map(v =>
      `<span class="vlan-swatch-sm" style="background:${v.color};display:inline-block;width:8px;height:8px;border-radius:50%;vertical-align:middle"></span>`
    ).join("");

    return `<div class="link-peer-row">
      <span style="font-size:13px;font-weight:600;color:${dirColor};width:16px;flex-shrink:0">${dir}</span>
      <span class="tag tag-${peerDt}" style="font-size:10px;flex-shrink:0">${peerDt}</span>
      <span style="flex:1;font-size:12px;color:var(--text-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${peerIp}">${peerLabel}${peerIp.startsWith("node-") ? "" : `<br><span class="mono" style="font-size:10px;color:var(--text-3)">${peerIp}</span>`}</span>
      <div style="display:flex;gap:4px;align-items:center;flex-shrink:0">${speed}${mode}${vlanBadges}</div>
      <button class="btn-ghost" style="font-size:11px;padding:2px 6px;flex-shrink:0" onclick="openEditConnById(${e.data.connection_id})">✎</button>
    </div>`;
  }).join("") || `<div style="padding:14px 10px;font-size:12px;color:var(--text-3)">No connections yet.</div>`;

  return `
    <div class="link-peer-list" id="dtab-links-list-${ip.replace(/\./g,'_')}">${rows}</div>
    <div class="add-port-form" style="flex-wrap:wrap;gap:6px">
      <div class="field" style="flex:2;min-width:140px">
        <label>Connect to</label>
        <select id="newLinkPeer">${hostSelect}</select>
      </div>
      <div class="field">
        <label>Type</label>
        <select id="newLinkType">${LINK_TYPES.map(t => `<option value="${t}">${t}</option>`).join("")}</select>
      </div>
      <div class="field">
        <label>Speed</label>
        <select id="newLinkSpeed">${LINK_SPEEDS.map(s => `<option value="${s}">${s || "—"}</option>`).join("")}</select>
      </div>
      <div style="display:flex;gap:6px;align-items:flex-end;padding-bottom:1px">
        <button class="btn btn-primary" style="font-size:11px" onclick="addLinkFromDetail('${ip}')">+ Connect</button>
        <button class="btn" style="font-size:11px" onclick="openAddHost()">+ New Host</button>
      </div>
    </div>`;
}

async function addLinkFromDetail(ip) {
  const peer  = document.getElementById("newLinkPeer")?.value;
  const type  = document.getElementById("newLinkType")?.value  || "wired";
  const speed = document.getElementById("newLinkSpeed")?.value || null;
  if (!peer) return;
  try {
    await api("POST", "/api/connections", { src_ip: ip, dst_ip: peer, type, speed: speed || null });
    await loadGraph();
    // Refresh just the links list in-place
    const listEl = document.getElementById(`dtab-links-list-${ip.replace(/\./g,'_')}`);
    const host = allHosts.find(h => h.ip === ip);
    if (listEl) {
      const fresh = buildLinksTab(ip, host?.tier);
      const tmp = document.createElement("div");
      tmp.innerHTML = fresh;
      const newList = tmp.querySelector(`#dtab-links-list-${ip.replace(/\./g,'_')}`);
      if (newList) listEl.replaceWith(newList);
    }
  } catch (e) { alert("Error: " + e.message); }
}

// ── Host detail ───────────────────────────────────────────────────────────────

async function showHostDetail(ip) {
  const host = await api("GET", `/api/hosts/${ip}`);
  const panel = document.getElementById("hostDetail");
  const dt = host.device_type || "unknown";

  const sheetLabel = (host.hostname && !host.ip.startsWith('node-'))
    ? `${host.ip} · ${host.hostname}` : (host.ip.startsWith('node-') ? (host.hostname || '(no IP)') : host.ip);

  panel.innerHTML = `
    <div class="sheet-handle" id="sheetHandle">
      <div class="sheet-pill"></div>
      <div class="sheet-handle-row">
        <span class="sheet-handle-label mono">${sheetLabel}</span>
        <span class="sheet-handle-hint" id="sheetHint">tap to expand</span>
        <button class="btn-ghost" onclick="hideHostDetail()" style="font-size:17px;padding:1px 6px;line-height:1;flex-shrink:0">×</button>
      </div>
    </div>
    <div class="detail-header">
      <div>
        <div class="detail-ip">${host.ip.startsWith("node-") ? (host.hostname || "(no IP)") : host.ip}</div>
        ${host.hostname && !host.ip.startsWith("node-") ? `<div class="detail-hostname">${host.hostname}</div>` : ""}
      </div>
      <span class="tag tag-${dt}" style="font-size:11px">${dt}</span>
      <div class="detail-header-right">
        <select id="analyzeModel" style="font-size:11px;padding:4px 7px;background:var(--surface2);border:1px solid var(--border);color:var(--text-2);border-radius:var(--radius-sm)"></select>
        <button class="btn btn-primary" style="font-size:11px;padding:5px 10px" onclick="analyzeHost('${ip}')">Analyze</button>
        <button class="btn" style="font-size:11px;padding:5px 10px" onclick="openEditHost('${ip}')">Edit</button>
        <button class="btn" style="font-size:11px;padding:5px 10px" onclick="openMergeHost('${ip}')">⇌ Merge</button>
        <button class="btn" style="font-size:11px;padding:5px 10px" onclick="probeHost('${ip}')">⟳ Probe</button>
        <button class="btn btn-danger" style="font-size:11px;padding:5px 10px" onclick="deleteHost('${ip}')">Delete</button>
        <button class="btn-ghost" onclick="hideHostDetail()" style="font-size:18px;padding:2px 8px">×</button>
      </div>
    </div>

    <div class="detail-tabs">
      <button class="detail-tab active" data-tab="info" onclick="switchDetailTab('info')">Info</button>
      <button class="detail-tab" data-tab="links" onclick="switchDetailTab('links')">Links (${countLinks(ip)})</button>
      <button class="detail-tab" data-tab="ports" onclick="switchDetailTab('ports')">Ports (${(host.ports||[]).length})</button>
      <button class="detail-tab" data-tab="services" onclick="switchDetailTab('services')">Services (${(host.services||[]).length})</button>
      <button class="detail-tab" data-tab="analysis" onclick="switchDetailTab('analysis')">Analysis</button>
      <button class="detail-tab" data-tab="ssh" onclick="switchDetailTab('ssh');loadHostSshSection('${ip}')">SSH</button>
    </div>

    <div class="detail-body">
      <!-- Info tab -->
      <div class="detail-tab-panel active" id="dtab-info">
        <div class="info-grid">
          <div class="info-field"><label>IP Address</label><span class="mono">${host.ip}</span></div>
          <div class="info-field"><label>MAC Address</label><span class="mono">${host.mac||"—"}</span></div>
          <div class="info-field"><label>Vendor</label><span>${host.vendor||"—"}</span></div>
          <div class="info-field"><label>Hostname</label><span>${host.hostname||"—"}</span></div>
          <div class="info-field"><label>OS / Firmware</label><span>${host.os_guess||"—"}</span></div>
          <div class="info-field"><label>Device Type</label><span>${host.device_type||"unknown"}</span></div>
          <div class="info-field"><label>First Seen</label><span class="mono">${(host.first_seen||"—").substring(0,16)}</span></div>
          <div class="info-field"><label>Last Seen</label><span class="mono">${(host.last_seen||"—").substring(0,16)}</span></div>
        </div>
        ${(host.aliases||[]).length ? `
        <div class="aliases-row" id="aliases-row-${ip.replace(/\./g,'_')}">
          <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3)">Additional IPs</span>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:5px">
            ${(host.aliases||[]).map(a => `
              <span class="alias-chip">
                <span class="mono">${a}</span>
                <button class="btn-ghost" style="padding:0 3px;font-size:11px;line-height:1" onclick="removeAlias('${ip}','${a}')" title="Remove alias">×</button>
              </span>`).join("")}
          </div>
        </div>` : ""}
        ${host.notes ? `<div class="notes-box">${host.notes}</div>` : ""}
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
                <span class="port-num">${p.port}/${p.protocol}</span>
                <span class="port-svc">${p.service||"unknown"}</span>
                <span class="port-ver">${p.version||""}</span>
                ${p.manual ? '<span class="port-manual-tag">manual</span>' : '<span></span>'}
                <button class="btn-ghost btn-danger" onclick="deletePort(${p.id},'${ip}')" style="font-size:12px;padding:2px 6px">✕</button>
              </div>`).join("")
            : `<div style="padding:16px 10px;font-size:12px;color:var(--text-3)">No ports detected.</div>`
          }
        </div>
        <div class="add-port-form">
          <div class="field"><label>Port</label><input type="number" id="newPort" placeholder="8080" class="mono"></div>
          <div class="field"><label>Proto</label><select id="newProto" class="sel-proto"><option>tcp</option><option>udp</option></select></div>
          <div class="field"><label>Service</label><input type="text" id="newService" placeholder="http" class="inp-svc"></div>
          <div class="field"><label>Version</label><input type="text" id="newVersion" placeholder="nginx 1.24" class="inp-ver"></div>
          <button class="btn btn-primary" style="font-size:11px;align-self:flex-end" onclick="addPort('${ip}')">+ Add</button>
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
          <div class="field"><label>Port</label><input type="number" id="newSvcPort" placeholder="8080" class="mono" oninput="autoFillSvcUrl('${ip}', this.value, 'newSvcUrl')"></div>
          <div class="field"><label>Status</label>
            <select id="newSvcStatus">
              <option value="unknown">Unknown</option>
              <option value="running">Running</option>
              <option value="stopped">Stopped</option>
            </select>
          </div>
          <div class="field" style="flex:2"><label>URL</label><input type="text" id="newSvcUrl" placeholder="http://…" oninput="if(this.value!==this.dataset.auto)this.dataset.auto=''"></div>
          <button class="btn btn-primary" style="font-size:11px;align-self:flex-end" onclick="addServiceToHost('${ip}')">+ Add</button>
        </div>
      </div>

      <!-- SSH tab -->
      <div class="detail-tab-panel" id="dtab-ssh" style="padding:10px 0"></div>

      <!-- Analysis tab -->
      <div class="detail-tab-panel" id="dtab-analysis">
        <div id="analysisResult">
          ${host.analyses?.length
            ? `<div class="analysis-meta">${host.analyses[0].model} · ${(host.analyses[0].created_at||"").substring(0,16)}</div>
               <div class="analysis-box">${host.analyses[0].analysis}</div>`
            : `<div style="padding:16px 0;font-size:12px;color:var(--text-3)">No analysis yet. Click Analyze to run the LLM.</div>`
          }
        </div>
      </div>
    </div>
  `;

  // Populate model selector
  const modelSel = document.getElementById("analyzeModel");
  const globalModel = document.getElementById("globalModel");
  if (globalModel) {
    Array.from(globalModel.options).forEach(o => {
      const opt = document.createElement("option");
      opt.value = o.value; opt.textContent = o.textContent; opt.selected = o.selected;
      modelSel.appendChild(opt);
    });
  }

  panel.classList.add("open");
  initSheetDrag();
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
  handle.addEventListener("touchstart", e => onDragStart(e.touches[0].clientY), { passive: true });
  handle.addEventListener("touchmove",  e => onDragMove(e.touches[0].clientY),  { passive: true });
  handle.addEventListener("touchend",   onDragEnd);

  // Mouse
  handle.addEventListener("mousedown", e => { e.preventDefault(); onDragStart(e.clientY); });
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
  "workstation","pc","laptop","iot","camera","printer","phone","tablet",
  "container","vm","ap","unknown"];

async function openEditHost(ip) {
  const host = await api("GET", `/api/hosts/${ip}`);
  document.getElementById("editIp").value         = ip;
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
    `<option value="${h.ip}">${h.ip.startsWith("node-") ? "" : h.ip + " — "}${h.hostname || h.device_type || "unknown"}</option>`
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
  const ip = document.getElementById("editIp").value;
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

async function analyzeHost(ip) {
  const model = document.getElementById("analyzeModel")?.value
             || document.getElementById("globalModel")?.value;
  const resultDiv = document.getElementById("analysisResult");
  resultDiv.innerHTML = '<div class="analysis-box" style="color:var(--text-3)">Analyzing…</div>';
  switchDetailTab("analysis");
  try {
    const data = await api("POST", `/api/hosts/${ip}/analyze`, { model });
    resultDiv.innerHTML = `
      <div class="analysis-meta">${data.model} · just now</div>
      <div class="analysis-box">${data.analysis}</div>`;
    await loadHosts(); renderHostsTable(); await loadGraph();
  } catch (e) {
    resultDiv.innerHTML = `<div class="analysis-box" style="color:var(--red)">Error: ${e.message}</div>`;
  }
}

function openNetworkAnalysis() {
  const modal = document.getElementById("networkAnalysisModal");
  const modelSel = document.getElementById("netAnalyzeModel");
  const globalModel = document.getElementById("globalModel");
  if (modelSel && globalModel && !modelSel.options.length) {
    Array.from(globalModel.options).forEach(o => {
      const opt = document.createElement("option");
      opt.value = o.value; opt.textContent = o.textContent; opt.selected = o.selected;
      modelSel.appendChild(opt);
    });
  }
  modal.classList.add("open");
}

function closeNetworkAnalysis() {
  document.getElementById("networkAnalysisModal").classList.remove("open");
}

async function runNetworkAnalysis() {
  const model = document.getElementById("netAnalyzeModel")?.value
             || document.getElementById("globalModel")?.value;
  const resultDiv = document.getElementById("networkAnalysisResult");
  resultDiv.innerHTML = '<div class="analysis-box" style="color:var(--text-3)">Analyzing full network… this may take a moment.</div>';
  try {
    const data = await api("POST", "/api/analyze/network", { model });
    const html = data.analysis
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/^(#{1,3} .+)$/gm, '<strong style="font-size:12px;color:var(--text-1)">$1</strong>')
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");
    resultDiv.innerHTML = `
      <div class="analysis-meta" style="margin-bottom:10px">${data.model} · just now</div>
      <div class="analysis-box" style="white-space:normal;line-height:1.6">${html}</div>`;
  } catch (e) {
    resultDiv.innerHTML = `<div class="analysis-box" style="color:var(--red)">Error: ${e.message}</div>`;
  }
}

// ── Graph ─────────────────────────────────────────────────────────────────────

async function loadGraph() {
  const { nodes, edges } = await api("GET", "/api/graph");
  graphEdges = edges || [];
  if (typeof renderGraph === "function") renderGraph(nodes, edges);
}

// ── Scans ─────────────────────────────────────────────────────────────────────

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
        <input type="checkbox" id="scansSelectAll" onchange="scansToggleAll(this.checked)" style="accent-color:var(--accent)">
        Select all
      </label>
      <button class="btn btn-danger" style="font-size:11px;padding:4px 10px" onclick="scansDeleteSelected()">Delete selected</button>
    </div>
    ${scans.map(s => {
      const isProbe = s.type === "probe";
      const target = isProbe
        ? `<span class="mono" style="color:var(--accent)">${s.host_ip || "?"}</span>`
        : `${s.subnet_name || "?"} <span class="mono" style="color:var(--text-3);font-weight:400">${s.cidr || ""}</span>`;
      const detail = isProbe
        ? `probe · ${(s.started_at||"").substring(0,16)}`
        : `${(s.started_at||"").substring(0,16)} · ${s.hosts_found||0} hosts`;
      const typeBadge = isProbe
        ? `<span class="tag" style="background:oklch(40% 0.1 280);color:oklch(80% 0.1 280);font-size:10px">probe</span>`
        : `<span class="tag" style="background:var(--surface2);color:var(--text-3);font-size:10px">scan</span>`;
      return `
        <div class="scan-card" id="scan-card-${s.id}">
          <input type="checkbox" class="scan-checkbox" data-id="${s.id}" style="accent-color:var(--accent);flex-shrink:0" onchange="scansUpdateBulkBtn()">
          <div class="scan-indicator ${s.status}"></div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:500;font-size:12px">${target}</div>
            <div class="mono" style="font-size:10px;color:var(--text-3);margin-top:2px">${detail}</div>
          </div>
          ${typeBadge}
          <span class="tag tag-${s.status}" style="font-size:10px">${s.status}</span>
          <button class="btn-ghost btn-danger" style="font-size:12px;padding:2px 7px;flex-shrink:0" onclick="deleteScanRun(${s.id})" title="Delete">✕</button>
        </div>`;
    }).join("")}`;
}

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

// ── Models ────────────────────────────────────────────────────────────────────

async function loadModels() {
  try {
    const { models } = await api("GET", "/api/models");
    ["globalModel","chatModel"].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = "";
      models.forEach(m => {
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent = m.replace(":latest","");
        el.appendChild(opt);
      });
    });
  } catch (e) { console.warn("Models:", e.message); }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

const TAB_TITLES = { topology: "Topology", hosts: "Hosts", scans: "Scans", hierarchy: "Hierarchy", services: "Services", sshkeys: "SSH Keys" };

function setTab(name) {
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".sidebar-nav-item").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".bottom-nav-btn").forEach(t => t.classList.remove("active"));

  document.getElementById("panel-" + name).classList.add("active");
  document.querySelector(`.sidebar-nav-item[data-tab="${name}"]`)?.classList.add("active");
  document.querySelector(`.bottom-nav-btn[data-tab="${name}"]`)?.classList.add("active");

  const title = document.getElementById("topbarTitle");
  if (title) title.textContent = TAB_TITLES[name] || name;

  closeSidebar();
  if (name === "topology")  loadGraph();
  if (name === "scans")     loadScans();
  if (name === "hierarchy") loadHierarchy();
  if (name === "services")  loadServicesTab();
  if (name === "sshkeys")   loadSshKeys();
}

// ── Chat toggle ───────────────────────────────────────────────────────────────

function toggleChat() {
  document.getElementById("chatPanel").classList.toggle("open");
}

// ── Legend toggle ─────────────────────────────────────────────────────────────

function toggleLegend() {
  const items    = document.getElementById("legendItems");
  const chevron  = document.getElementById("legendChevron");
  const collapsed = items.classList.toggle("collapsed");
  chevron.textContent = collapsed ? "▾" : "▴";
}

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
  const portBadge = s.port ? `<span class="port-badge mono">${s.port}/${s.protocol||"tcp"}</span>` : "";
  return `<div class="svc-row" id="svc-row-${s.id}">
    ${svcIconHTML(s.name)}
    <span class="svc-name">${s.name}${s.description ? `<br><span class="svc-desc">${s.description}</span>` : ""}</span>
    <div class="svc-port-status" style="align-items:flex-end">
      ${portBadge}
      <button class="svc-status ${s.status}" onclick="cycleServiceStatus(${s.id},'${s.status}','${hostIp}')">${s.status}</button>
    </div>
    <div class="svc-actions">
      <button class="svc-kebab" onclick="toggleSvcMenu('r${s.id}')" title="Actions">⋮</button>
      <div class="svc-menu" id="svcmenu-r${s.id}">
        ${s.url ? `<a href="${s.url}" target="_blank" class="svc-menu-item">↗ Open URL</a>` : ""}
        <button class="svc-menu-item" onclick="closeSvcMenus();openManageDeps(${s.id})">⊕ Dependencies</button>
        <button class="svc-menu-item" onclick="closeSvcMenus();openEditService(${s.id})">✎ Edit</button>
        <button class="svc-menu-item danger" onclick="closeSvcMenus();deleteSvc(${s.id},'${hostIp}')">✕ Delete</button>
      </div>
    </div>
  </div>`;
}

const STATUS_CYCLE = { running: "stopped", stopped: "unknown", unknown: "running" };

async function cycleServiceStatus(id, current, hostIp) {
  const next = STATUS_CYCLE[current] || "unknown";
  const svc  = await api("PUT", `/api/services/${id}`, { status: next });
  allServices = allServices.map(s => s.id === id ? { ...s, ...svc } : s);
  const row = document.getElementById(`svc-row-${id}`);
  if (row) {
    const btn = row.querySelector(".svc-status");
    if (btn) { btn.className = `svc-status ${next}`; btn.textContent = next; btn.onclick = () => cycleServiceStatus(id, next, hostIp); }
  }
  renderServicesTable();
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
  document.getElementById("svcHostRow").style.display = "none";
  document.getElementById("svcDeleteBtn").style.display = "";
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
  document.getElementById("svcDeleteBtn").style.display = "none";
  const hostRow = document.getElementById("svcHostRow");
  hostRow.style.display = "";
  const sel = document.getElementById("svcHostIp");
  sel.innerHTML = allHosts.map(h =>
    `<option value="${h.ip}"${h.ip === presetIp ? " selected" : ""}>${h.ip}${h.hostname ? " — " + h.hostname : ""}</option>`
  ).join("");
  document.getElementById("serviceModal").classList.add("open");
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
  if (!name) return alert("Service name is required.");

  try {
    if (editId) {
      const svc = await api("PUT", `/api/services/${editId}`, { name, description: desc, port, protocol: proto, status, url });
      allServices = allServices.map(s => s.id === parseInt(editId) ? { ...s, ...svc } : s);
      const row = document.getElementById(`svc-row-${editId}`);
      if (row) row.outerHTML = svcRowHTML(svc, svc.ip);
    } else {
      const hostIp = document.getElementById("svcHostIp").value;
      const svc = await api("POST", `/api/hosts/${hostIp}/services`, { name, description: desc, port, protocol: proto, status, url });
      allServices.push(svc);
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
    hosts.map(h => `<option value="${h.ip}"${h.ip === current ? " selected" : ""}>${h.hostname || h.ip}</option>`).join("");
}

async function loadServicesTab() {
  await loadServicesData();
  renderServicesTable();
}

function renderServicesTable() {
  const tbody = document.querySelector("#servicesTable tbody");
  if (!tbody) return;

  let rows = svcHostFilterVal ? allServices.filter(s => s.ip === svcHostFilterVal) : allServices;
  if (svcFilterText) {
    const q = svcFilterText.toLowerCase();
    rows = rows.filter(s =>
      (s.name||"").toLowerCase().includes(q) ||
      (s.ip||"").includes(q) ||
      (s.hostname||"").toLowerCase().includes(q) ||
      (s.description||"").toLowerCase().includes(q) ||
      String(s.port||"").includes(q)
    );
  }
  rows = [...rows].sort((a, b) => {
    const va = (a[svcSortCol] ?? "").toString().toLowerCase();
    const vb = (b[svcSortCol] ?? "").toString().toLowerCase();
    return va < vb ? -svcSortDir : va > vb ? svcSortDir : 0;
  });

  const count = document.getElementById("serviceCount");
  if (count) count.textContent = `${rows.length} of ${allServices.length}`;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:40px;color:var(--text-3);font-size:12px">${svcFilterText ? "No matches." : "No services yet — add one with + Service."}</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(s => `
    <tr id="svc-tr-${s.id}">
      <td style="padding:6px 8px 6px 16px">${svcIconHTML(s.name, 28)}</td>
      <td>
        <div style="font-size:12px;font-weight:500">${s.name}</div>
        ${s.description ? `<div style="font-size:10px;color:var(--text-3)">${s.description}</div>` : ""}
      </td>
      <td class="svc-host-cell">
        <span class="svc-host-ip">${s.ip}</span>
        ${s.hostname ? `<span class="svc-host-name">${s.hostname}</span>` : ""}
      </td>
      <td>
        <div class="svc-port-status">
          ${s.port ? `<span class="port-badge mono">${s.port}/${s.protocol||"tcp"}</span>` : `<span style="color:var(--text-3);font-size:11px">—</span>`}
          <button class="svc-status ${s.status}" onclick="cycleServiceStatus(${s.id},'${s.status}','${s.ip}')">${s.status}</button>
        </div>
      </td>
      <td style="padding:4px 8px 4px 4px">
        <div class="svc-actions">
          <button class="svc-kebab" onclick="toggleSvcMenu('t${s.id}')" title="Actions">⋮</button>
          <div class="svc-menu" id="svcmenu-t${s.id}">
            ${s.url ? `<a href="${s.url}" target="_blank" class="svc-menu-item">↗ Open URL</a>` : ""}
            <button class="svc-menu-item" onclick="closeSvcMenus();openManageDeps(${s.id})">⊕ Dependencies</button>
            <button class="svc-menu-item" onclick="closeSvcMenus();openEditService(${s.id})">✎ Edit</button>
            <button class="svc-menu-item danger" onclick="closeSvcMenus();deleteSvcFromTable(${s.id})">✕ Delete</button>
          </div>
        </div>
      </td>
    </tr>
  `).join("");
}

async function deleteSvcFromTable(id) {
  if (!confirm("Delete this service?")) return;
  await api("DELETE", `/api/services/${id}`);
  allServices = allServices.filter(s => s.id !== id);
  renderServicesTable();
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
    if (!e.target.closest(".svc-actions")) closeSvcMenus();
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

// ── Services topology ─────────────────────────────────────────────────────────

function renderSvcTopology() {
  const container = document.getElementById("svcTopoCanvas");
  if (!container) return;

  const services = svcHostFilterVal
    ? allServices.filter(s => s.ip === svcHostFilterVal)
    : allServices;

  if (services.length === 0) {
    container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-3);font-size:13px">No services to display.</div>`;
    if (svcCy) { svcCy.destroy(); svcCy = null; }
    return;
  }
  container.innerHTML = "";

  // Unique hosts from visible services
  const hostMap = new Map();
  services.forEach(s => { if (!hostMap.has(s.ip)) hostMap.set(s.ip, s.hostname || s.ip); });

  const elements = [];

  // Host nodes
  hostMap.forEach((label, ip) => {
    elements.push({ group: "nodes", data: { id: `host-${ip}`, label, type: "host", ip } });
  });

  // Service nodes + runs-on edges
  const svcIdSet = new Set(services.map(s => s.id));
  services.forEach(s => {
    const depCount = allDependencies.filter(d => d.from_service_id === s.id && svcIdSet.has(d.to_service_id)).length;
    elements.push({ group: "nodes", data: {
      id: `svc-${s.id}`, label: s.name, type: "service",
      status: s.status, svcId: s.id, deps: depCount
    }});
    elements.push({ group: "edges", data: {
      id: `runs-${s.id}`, source: `host-${s.ip}`, target: `svc-${s.id}`, type: "runs-on"
    }});
  });

  // Dependency edges (only between visible services)
  allDependencies.forEach(d => {
    if (svcIdSet.has(d.from_service_id) && svcIdSet.has(d.to_service_id)) {
      elements.push({ group: "edges", data: {
        id: `dep-${d.id}`, source: `svc-${d.from_service_id}`, target: `svc-${d.to_service_id}`, type: "depends-on"
      }});
    }
  });

  if (svcCy) { svcCy.destroy(); svcCy = null; }

  svcCy = cytoscape({
    container,
    elements,
    style: [
      { selector: 'node[type="host"]', style: {
        "background-color": "oklch(20% 0.025 240)",
        "border-width": 2, "border-color": "#1a6fa8",
        "label": "data(label)", "color": "#9ab0c8",
        "font-size": "11px", "text-valign": "center", "text-halign": "center",
        "width": 76, "height": 76, "shape": "roundrectangle",
        "text-wrap": "wrap", "text-max-width": "68px"
      }},
      { selector: 'node[type="service"]', style: {
        "background-color": "oklch(17% 0.02 240)",
        "border-width": 1.5, "border-color": "oklch(33% 0.03 240)",
        "label": "data(label)", "color": "#7a90a4",
        "font-size": "9px", "text-valign": "bottom", "text-halign": "center",
        "text-margin-y": "4px", "width": 34, "height": 34, "shape": "ellipse",
        "text-wrap": "wrap", "text-max-width": "64px"
      }},
      { selector: 'node[status="running"]', style: { "border-color": "oklch(70% 0.165 145)", "border-width": 2 }},
      { selector: 'node[status="stopped"]', style: { "border-color": "oklch(58% 0.21 25)",  "border-width": 2 }},
      { selector: 'edge[type="runs-on"]', style: {
        "width": 1, "line-color": "oklch(26% 0.02 240)",
        "line-style": "dashed", "line-dash-pattern": [4, 4],
        "target-arrow-shape": "none", "curve-style": "straight"
      }},
      { selector: 'edge[type="depends-on"]', style: {
        "width": 2, "line-color": "oklch(72% 0.15 55)",
        "target-arrow-color": "oklch(72% 0.15 55)",
        "target-arrow-shape": "triangle", "curve-style": "bezier", "arrow-scale": 1.2
      }},
      { selector: ":selected", style: { "border-color": "var(--accent)", "border-width": 3 }}
    ],
    layout: {
      name: "cose", animate: false, randomize: true, fit: true, padding: 50,
      componentSpacing: 100, nodeOverlap: 10,
      nodeRepulsion: () => 12000, edgeElasticity: () => 200,
      gravity: 1.2, numIter: 1000, initialTemp: 1000, coolingFactor: 0.99, minTemp: 1
    }
  });

  svcCy.on("tap", 'node[type="host"]',    e => showHostDetail(e.target.data("ip")));
  svcCy.on("tap", 'node[type="service"]', e => {
    const svc = allServices.find(s => s.id === e.target.data("svcId"));
    if (svc) showHostDetail(svc.ip);
  });
}

// ── Dependency modal ──────────────────────────────────────────────────────────

function openManageDeps(svcId) {
  const svc = allServices.find(s => s.id === svcId);
  if (!svc) return;
  document.getElementById("depsModalSvcId").value    = svcId;
  document.getElementById("depsModalSvcName").textContent = svc.name;
  renderDepsModal(svcId);
  document.getElementById("depsModal").classList.add("open");
}

function closeDepsModal() {
  document.getElementById("depsModal").classList.remove("open");
}

function renderDepsModal(svcId) {
  const id     = parseInt(svcId);
  const myDeps = allDependencies.filter(d => d.from_service_id === id);
  const myDepIds = new Set(myDeps.map(d => d.to_service_id));

  const list = document.getElementById("depsList");
  if (myDeps.length === 0) {
    list.innerHTML = `<div style="font-size:12px;color:var(--text-3);padding:6px 0">None yet.</div>`;
  } else {
    list.innerHTML = myDeps.map(d => {
      const t = allServices.find(s => s.id === d.to_service_id);
      return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
        <span style="flex:1;font-size:12px">${t ? t.name : `#${d.to_service_id}`}
          ${t ? `<span style="font-size:10px;color:var(--text-3)"> — ${t.hostname || t.ip}</span>` : ""}
        </span>
        <button class="btn-ghost btn-danger" style="font-size:11px;padding:2px 6px" onclick="removeSvcDep(${d.id},${id})">✕</button>
      </div>`;
    }).join("");
  }

  const sel       = document.getElementById("depsAddSelect");
  const available = allServices.filter(s => s.id !== id && !myDepIds.has(s.id));
  sel.disabled    = available.length === 0;
  sel.innerHTML   = available.length === 0
    ? `<option value="">No other services</option>`
    : `<option value="">Pick a service…</option>` +
      available.map(s => `<option value="${s.id}">${s.name} (${s.hostname || s.ip})</option>`).join("");
}

async function addSvcDep() {
  const fromId = parseInt(document.getElementById("depsModalSvcId").value);
  const toId   = parseInt(document.getElementById("depsAddSelect").value);
  if (!toId) return;
  try {
    const dep = await api("POST", "/api/service-dependencies", { from_service_id: fromId, to_service_id: toId });
    allDependencies.push(dep);
    renderDepsModal(fromId);
    if (currentSvcTab === "topology") renderSvcTopology();
  } catch (e) { alert("Error: " + e.message); }
}

async function removeSvcDep(depId, svcId) {
  await api("DELETE", `/api/service-dependencies/${depId}`);
  allDependencies = allDependencies.filter(d => d.id !== depId);
  renderDepsModal(svcId);
  if (currentSvcTab === "topology") renderSvcTopology();
}

// ── Edit connection ───────────────────────────────────────────────────────────

function openEditConnById(connId) {
  const edge = (graphEdges || []).find(e => e.data.connection_id === connId);
  if (edge) openEditConn(connId, edge.data.id, edge.data);
}

function openEditConn(connId, edgeId, d) {
  document.getElementById("editConnId").value        = connId;
  document.getElementById("editConnEdgeId").value    = edgeId;
  document.getElementById("editConnSrc").textContent = d.source;
  document.getElementById("editConnDst").textContent = d.target;
  document.getElementById("editConnType").value      = d.type || "wired";
  document.getElementById("editConnLabel").value     = d.label || "";
  document.getElementById("editConnPortMode").value  = d.port_mode || "";
  document.getElementById("editConnSpeed").value     = d.speed || "";
  updateConnVlans("editConnVlanSection", d.port_mode || "");
  // Restore VLAN checkbox state
  const assignedIds = (d.vlans || []).map(v => v.id);
  document.querySelectorAll(`#editConnVlanSection input[name="vlan_editConnVlanSection"]`).forEach(el => {
    el.checked = assignedIds.includes(parseInt(el.value));
  });
  // Restore tagged_only checkbox
  const taggedOnlyCb = document.getElementById("taggedOnly_editConnVlanSection");
  if (taggedOnlyCb) taggedOnlyCb.checked = !!d.tagged_only;
  document.getElementById("editConnModal").classList.add("open");
}
function closeEditConn() {
  document.getElementById("editConnModal").classList.remove("open");
}
async function saveConnEdit() {
  const connId   = document.getElementById("editConnId").value;
  const edgeId   = document.getElementById("editConnEdgeId").value;
  const type     = document.getElementById("editConnType").value;
  const label    = document.getElementById("editConnLabel").value.trim() || null;
  const portMode = document.getElementById("editConnPortMode").value || null;
  const speed      = document.getElementById("editConnSpeed").value || null;
  const vlanIds    = getSelectedVlanIds("editConnVlanSection");
  const taggedOnly = getTaggedOnly("editConnVlanSection");
  try {
    const conn = await api("PUT", `/api/connections/${connId}`,
      { type, label, port_mode: portMode, speed, tagged_only: taggedOnly, vlan_ids: vlanIds, set_vlans: true });
    const edge = cy.getElementById(edgeId);
    edge.data({
      type: conn.type, label: conn.label || "", port_mode: conn.port_mode || "",
      speed: conn.speed || "", tagged_only: conn.tagged_only || false, vlans: conn.vlans || [],
    });
    applyEdgeVlanStyle(edge);
    closeEditConn();
  } catch (e) { alert("Error: " + e.message); }
}
async function deleteConnFromEdit() {
  const connId = document.getElementById("editConnId").value;
  const edgeId = document.getElementById("editConnEdgeId").value;
  if (!confirm("Delete this link?")) return;
  await api("DELETE", `/api/connections/${connId}`);
  cy.edges(`[overlay_conn="${connId}"]`).remove();
  cy.remove(`#${edgeId}`);
  closeEditConn();
}

// ── Hierarchy ─────────────────────────────────────────────────────────────────

function computeTiers(hosts, edges) {
  const adj = {};
  edges.forEach(e => {
    const s = e.data.source, t = e.data.target;
    if (!adj[s]) adj[s] = []; if (!adj[t]) adj[t] = [];
    adj[s].push(t); adj[t].push(s);
  });
  const tiers = {}, queue = [];
  hosts.forEach(h => { if (h.tier === 1) { tiers[h.ip] = 1; queue.push(h.ip); } });
  while (queue.length) {
    const ip = queue.shift();
    (adj[ip] || []).forEach(n => {
      if (tiers[n] === undefined) { tiers[n] = tiers[ip] + 1; queue.push(n); }
    });
  }
  return tiers;
}

function buildParentMap(hosts, edges, tiers) {
  const adj = {};
  edges.forEach(e => {
    const s = e.data.source, t = e.data.target;
    if (!adj[s]) adj[s] = []; if (!adj[t]) adj[t] = [];
    adj[s].push({ ip: t, edge: e.data }); adj[t].push({ ip: s, edge: e.data });
  });
  const parentOf = {};
  hosts.forEach(h => {
    const myTier = tiers[h.ip];
    if (!myTier || myTier === 1) return;
    const up = (adj[h.ip] || [])
      .filter(n => tiers[n.ip] === myTier - 1)
      .sort((a, b) => ipToNum(a.ip) - ipToNum(b.ip))[0];
    if (up) parentOf[h.ip] = up;
  });
  return parentOf;
}

function hierNodeHTML(ip, childrenMap, hostMap, tiers, connEdge, depth) {
  const host  = hostMap[ip] || { ip, device_type: "unknown" };
  const dt    = host.device_type || "unknown";
  const color = typeof nodeColor === "function" ? nodeColor(dt) : "#524c48";
  const tier  = tiers[ip];
  const tierBadge = tier ? `L${tier}` : "—";
  const pill  = connEdge ? (() => {
    const parts = [connEdge.type];
    if (connEdge.port_mode) parts.push(connEdge.port_mode);
    return `<span class="hier-conn-pill">${parts.join("·")}</span>`;
  })() : "";
  const children = (childrenMap[ip] || []).sort((a, b) => ipToNum(a.ip) - ipToNum(b.ip));

  return `<div class="hier-node">
    <div class="hier-node-row" onclick="showHostDetail('${ip}')">
      <span class="hier-tier-badge">${tierBadge}</span>
      <span class="hier-dot" style="background:${color}"></span>
      <span class="hier-ip mono">${ip}</span>
      <span class="hier-hostname">${host.hostname || '<span style="color:var(--text-3)">—</span>'}</span>
      <span class="tag tag-${dt}" style="font-size:9px;padding:1px 5px;line-height:1.6">${dt}</span>
      ${pill}
      <span class="hier-node-actions">
        <button class="btn" style="font-size:10px;padding:2px 7px"
          onclick="event.stopPropagation();hierLinkFrom('${ip}')">Link</button>
        <button class="btn" style="font-size:10px;padding:2px 7px"
          onclick="event.stopPropagation();hierMultiLinkFrom('${ip}')">Multi</button>
      </span>
    </div>
    ${children.length ? `<div class="hier-children">${children.map(c =>
      hierNodeHTML(c.ip, childrenMap, hostMap, tiers, c.edge, depth + 1)
    ).join("")}</div>` : ""}
  </div>`;
}

function renderHierarchy() {
  const wrap = document.getElementById("hierarchyWrap");
  if (!wrap) return;
  if (!allHosts.length) {
    wrap.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-3);font-size:12px">No hosts yet.</div>`;
    return;
  }

  const tiers    = computeTiers(allHosts, graphEdges);
  const parentOf = buildParentMap(allHosts, graphEdges, tiers);
  const hostMap  = Object.fromEntries(allHosts.map(h => [h.ip, h]));

  const childrenMap = {};
  Object.entries(parentOf).forEach(([ip, p]) => {
    if (!childrenMap[p.ip]) childrenMap[p.ip] = [];
    childrenMap[p.ip].push({ ip, edge: p.edge });
  });

  const l1ips      = allHosts.filter(h => h.tier === 1).map(h => h.ip);
  const unassigned = allHosts.filter(h => tiers[h.ip] === undefined).map(h => h.ip).sort();

  let html = "";
  if (!l1ips.length) {
    html += `<div class="hier-no-l1">No <strong>Gateway (L1)</strong> nodes set.
      Edit any host and check <em>Gateway (L1)</em> to root the hierarchy.</div>`;
  }
  html += l1ips.map(ip => hierNodeHTML(ip, childrenMap, hostMap, tiers, null, 0)).join("");
  if (unassigned.length) {
    html += `<div class="hier-unassigned">
      <div class="hier-section-label">Unassigned — no path from gateway (${unassigned.length})</div>
      ${unassigned.map(ip => hierNodeHTML(ip, childrenMap, hostMap, {}, null, 0)).join("")}
    </div>`;
  }
  wrap.innerHTML = html;
}

async function loadHierarchy() {
  await Promise.all([loadHosts(), loadGraph()]);
  renderHierarchy();
}

function hierLinkFrom(ip) {
  setTab("topology");
  setTimeout(() => {
    if (!connectMode) toggleConnectMode();
    if (cy) {
      connectSource = ip;
      cy.getElementById(ip).addClass("connect-src");
      const hint = document.getElementById("connectHint");
      if (hint) hint.textContent = `${ip} → tap destination`;
    }
  }, 120);
}

function hierMultiLinkFrom(ip) {
  setTab("topology");
  setTimeout(() => {
    if (!multiConnectMode) toggleMultiConnectMode();
    if (cy) {
      multiConnectSource = ip;
      cy.getElementById(ip).addClass("connect-src");
      const hint = document.getElementById("connectHint");
      if (hint) hint.textContent = `${ip} → tap targets`;
    }
  }, 120);
}

// ── VLANs ─────────────────────────────────────────────────────────────────────

async function loadVlans() {
  try { allVlans = await api("GET", "/api/vlans"); } catch { allVlans = []; }
}

function openVlanPanel() {
  renderVlans();
  document.getElementById("vlanModal").classList.add("open");
}
function closeVlanPanel() {
  document.getElementById("vlanModal").classList.remove("open");
  cancelEditVlan();
}

function renderVlans() {
  const list = document.getElementById("vlanList");
  if (!allVlans.length) {
    list.innerHTML = `<div style="padding:10px 2px;font-size:11px;color:var(--text-3)">No VLANs yet. Add one below.</div>`;
    return;
  }
  list.innerHTML = allVlans.map(v => `
    <div class="vlan-row" id="vlan-row-${v.id}">
      <div class="vlan-swatch" style="background:${v.color}"></div>
      <span class="vlan-tag mono">VLAN ${v.tag}</span>
      <span class="vlan-name">${v.name}</span>
      <button class="btn-ghost" onclick="openEditVlan(${v.id})" style="font-size:11px;padding:2px 5px" title="Edit">✎</button>
      <button class="btn-ghost btn-danger" onclick="deleteVlan(${v.id})" style="font-size:11px;padding:2px 5px" title="Delete">✕</button>
    </div>
  `).join("");
}

async function addVlan() {
  const tag   = parseInt(document.getElementById("newVlanTag").value);
  const name  = document.getElementById("newVlanName").value.trim();
  const color = document.getElementById("newVlanColor").value;
  if (!tag || tag < 1 || tag > 4094) return alert("VLAN tag must be 1–4094.");
  if (!name) return alert("VLAN name is required.");
  try {
    const v = await api("POST", "/api/vlans", { tag, name, color });
    allVlans.push(v);
    allVlans.sort((a, b) => a.tag - b.tag);
    document.getElementById("newVlanTag").value   = "";
    document.getElementById("newVlanName").value  = "";
    document.getElementById("newVlanColor").value = "#888888";
    renderVlans();
  } catch (e) { alert("Error: " + e.message); }
}

function openEditVlan(id) {
  const v = allVlans.find(v => v.id === id);
  if (!v) return;
  document.getElementById("editVlanId").value    = id;
  document.getElementById("editVlanTag").value   = v.tag;
  document.getElementById("editVlanName").value  = v.name;
  document.getElementById("editVlanColor").value = v.color;
  document.getElementById("vlanEditSection").style.display = "";
  document.getElementById("vlanAddSection").style.display  = "none";
}

function cancelEditVlan() {
  document.getElementById("vlanEditSection").style.display = "none";
  document.getElementById("vlanAddSection").style.display  = "";
}

async function saveEditVlan() {
  const id    = parseInt(document.getElementById("editVlanId").value);
  const tag   = parseInt(document.getElementById("editVlanTag").value);
  const name  = document.getElementById("editVlanName").value.trim();
  const color = document.getElementById("editVlanColor").value;
  if (!tag || tag < 1 || tag > 4094) return alert("VLAN tag must be 1–4094.");
  if (!name) return alert("VLAN name is required.");
  try {
    const v = await api("PUT", `/api/vlans/${id}`, { tag, name, color });
    allVlans = allVlans.map(v2 => v2.id === id ? v : v2);
    allVlans.sort((a, b) => a.tag - b.tag);
    cancelEditVlan();
    renderVlans();
    await loadGraph();
  } catch (e) { alert("Error: " + e.message); }
}

async function deleteVlan(id) {
  if (!confirm("Delete this VLAN? It will be removed from all connections.")) return;
  await api("DELETE", `/api/vlans/${id}`);
  allVlans = allVlans.filter(v => v.id !== id);
  renderVlans();
  await loadGraph();
}

// ── VLAN selection helpers (used in connection modals) ─────────────────────────

function updateConnVlans(sectionId, portMode) {
  const section = document.getElementById(sectionId);
  if (!section) return;
  if (!portMode) { section.style.display = "none"; return; }
  section.style.display = "";
  const isTrunk = portMode === "trunk";
  section.innerHTML = `
    <div class="form-row" style="margin-bottom:6px">
      ${isTrunk ? `
        <label style="display:flex;align-items:center;gap:7px;cursor:pointer;text-transform:none;font-weight:400;margin-bottom:8px">
          <input type="checkbox" id="taggedOnly_${sectionId}" style="accent-color:var(--accent);width:13px;height:13px">
          <span style="color:var(--text-2);font-size:11px">Tagged only — no native/untagged VLAN (hides white line)</span>
        </label>
      ` : ""}
      <label>${isTrunk ? "VLANs — trunk (one line per VLAN, white line = native)" : "VLAN — access"}</label>
      <div class="vlan-checklist">
        ${allVlans.length
          ? allVlans.map(v => `
            <label class="vlan-check-item">
              <input type="${isTrunk ? "checkbox" : "radio"}" name="vlan_${sectionId}" value="${v.id}">
              <span class="vlan-swatch-sm" style="background:${v.color}"></span>
              <span class="mono" style="font-size:10px">VLAN ${v.tag}</span>
              <span style="font-size:11px;color:var(--text-2)">${v.name}</span>
            </label>`).join("")
          : `<span style="font-size:11px;color:var(--text-3)">No VLANs defined — add via ◈ VLANs button</span>`
        }
      </div>
    </div>`;
}

function getSelectedVlanIds(sectionId) {
  const section = document.getElementById(sectionId);
  if (!section) return [];
  // Only read vlan radio/checkbox inputs, not the taggedOnly checkbox
  return Array.from(section.querySelectorAll(`input[name="vlan_${sectionId}"]:checked`))
    .map(el => parseInt(el.value));
}

function getTaggedOnly(sectionId) {
  const cb = document.getElementById(`taggedOnly_${sectionId}`);
  return cb ? cb.checked : false;
}

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

async function openSettings() {
  try {
    const { llm } = await api("GET", "/api/settings");
    document.getElementById("setProvider").value     = llm.provider || "none";
    document.getElementById("setBaseUrl").value      = llm.base_url || "";
    document.getElementById("setApiKey").value       = llm.api_key  || "";
    document.getElementById("setModel").value        = llm.model    || "";
    document.getElementById("setTimeout").value      = llm.timeout      || 120;
    document.getElementById("setLongTimeout").value  = llm.long_timeout || 600;
    onSettingsProviderChange();
    document.getElementById("setTestResult").style.display = "none";
  } catch (e) { console.warn("Settings load:", e.message); }
  document.getElementById("settingsModal").classList.add("open");
}

function closeSettings() {
  document.getElementById("settingsModal").classList.remove("open");
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

async function saveSettings() {
  const payload = {
    provider:     document.getElementById("setProvider").value,
    base_url:     document.getElementById("setBaseUrl").value.trim(),
    api_key:      document.getElementById("setApiKey").value,
    model:        document.getElementById("setModel").value.trim(),
    timeout:      parseInt(document.getElementById("setTimeout").value) || 120,
    long_timeout: parseInt(document.getElementById("setLongTimeout").value) || 600,
  };
  try {
    await api("PUT", "/api/settings", payload);
    closeSettings();
    await loadModels();
    updateAiStatusDot(payload.provider !== "none");
    showToast("AI settings saved");
  } catch (e) {
    alert("Failed to save settings: " + e.message);
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

// ── SSH Key Management ────────────────────────────────────────────────────────

let sshKeys = [];

async function loadSshKeys() {
  sshKeys = await api("GET", "/api/ssh-keys");
  renderSshKeys();
}

function renderSshKeys() {
  const el = document.getElementById("sshKeysList");
  if (!el) return;
  if (!sshKeys.length) {
    el.innerHTML = `<div style="font-size:12px;color:var(--text-3);padding:8px 0">No keys registered yet.</div>`;
    return;
  }
  el.innerHTML = sshKeys.map(k => `
    <div style="display:flex;align-items:center;gap:10px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 10px">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--text)">${k.name}</div>
        <div style="font-size:10px;font-family:monospace;color:var(--text-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${k.fingerprint || k.public_key.substring(0,40) + "…"}</div>
      </div>
      <button class="btn btn-danger" style="font-size:11px;padding:3px 8px;flex-shrink:0" onclick="deleteSshKey(${k.id})">Remove</button>
    </div>
  `).join("");
}

async function addSshKey() {
  const name = document.getElementById("sshKeyName").value.trim();
  const public_key = document.getElementById("sshKeyValue").value.trim();
  if (!name || !public_key) return showToast("Name and public key are required");
  try {
    await api("POST", "/api/ssh-keys", { name, public_key });
    document.getElementById("sshKeyName").value = "";
    document.getElementById("sshKeyValue").value = "";
    await loadSshKeys();
    showToast("Key added");
  } catch (e) {
    showToast("Failed to add key: " + (e.message || "invalid format"));
  }
}

async function deleteSshKey(id) {
  if (!confirm("Remove this key? It will also remove all host access assignments for it.")) return;
  await api("DELETE", `/api/ssh-keys/${id}`);
  await loadSshKeys();
  showToast("Key removed");
}

// ── SSH Access section inside host detail panel ───────────────────────────────

async function loadHostSshSection(ip) {
  const [access, keys] = await Promise.all([
    api("GET", `/api/hosts/${ip}/ssh-access`),
    api("GET", `/api/ssh-keys`),
  ]);

  const el = document.getElementById("dtab-ssh");
  if (!el) return;

  // Group existing access by username
  const byUser = {};
  for (const a of access) {
    if (!byUser[a.username]) byUser[a.username] = [];
    byUser[a.username].push(a);
  }

  const usersHTML = Object.entries(byUser).map(([user, entries]) => {
    const rows = entries.map(a => `
      <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border)">
        <div style="flex:1;font-size:12px;color:var(--text)">${a.name}</div>
        <div style="font-size:10px;font-family:monospace;color:var(--text-3);flex:2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.fingerprint || ""}</div>
        <button class="btn-ghost btn-danger" style="font-size:11px;padding:2px 6px" onclick="removeHostSshAccess(${a.id},'${ip}')">✕</button>
      </div>`).join("");

    const curlCmd = `curl -sfL "${location.protocol}//${location.host}/api/hosts/${ip}/authorized-keys?user=${user}" | tee -a ~/.ssh/authorized_keys`;
    return `
      <div style="margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span style="font-size:11px;font-weight:600;color:var(--accent);font-family:monospace">${user}</span>
          <button class="btn" style="font-size:10px;padding:2px 8px" onclick="copySshCurl('${ip}','${user}')">Copy curl</button>
          <button class="btn" style="font-size:10px;padding:2px 8px" onclick="downloadAuthorizedKeys('${ip}','${user}')">Download</button>
        </div>
        ${rows}
      </div>`;
  }).join("");

  const keyOptions = keys.map(k => `<option value="${k.id}">${k.name}</option>`).join("");

  el.innerHTML = `
    ${usersHTML || `<div style="font-size:12px;color:var(--text-3);padding:8px 0;margin-bottom:12px">No SSH access configured for this host yet.</div>`}
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px;display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
      <div class="field" style="flex:2;min-width:120px">
        <label style="font-size:10px">Key</label>
        <select id="sshAccessKey" style="width:100%">
          ${keyOptions || '<option value="">— no keys registered —</option>'}
        </select>
      </div>
      <div class="field" style="flex:1;min-width:80px">
        <label style="font-size:10px">Username</label>
        <input type="text" id="sshAccessUser" value="root" placeholder="root" style="width:100%">
      </div>
      <button class="btn btn-primary" style="font-size:11px;padding:5px 10px;white-space:nowrap" onclick="addHostSshAccess('${ip}')">+ Grant Access</button>
    </div>
  `;
}

async function addHostSshAccess(ip) {
  const keyEl = document.getElementById("sshAccessKey");
  const userEl = document.getElementById("sshAccessUser");
  const ssh_key_id = parseInt(keyEl?.value);
  const username = userEl?.value.trim();
  if (!ssh_key_id || !username) return showToast("Select a key and enter a username");
  try {
    await api("POST", `/api/hosts/${ip}/ssh-access`, { ssh_key_id, username });
    await loadHostSshSection(ip);
  } catch (e) {
    showToast("Already assigned");
  }
}

async function removeHostSshAccess(accessId, ip) {
  await api("DELETE", `/api/ssh-access/${accessId}`);
  await loadHostSshSection(ip);
}

async function copySshCurl(ip, user) {
  const base = `${location.protocol}//${location.host}`;
  const cmd = `curl -sfL "${base}/api/hosts/${ip}/authorized-keys?user=${user}" | tee -a ~/.ssh/authorized_keys`;
  await navigator.clipboard.writeText(cmd);
  showToast("Copied curl command");
}

async function downloadAuthorizedKeys(ip, user) {
  const text = await fetch(`/api/hosts/${ip}/authorized-keys?user=${user}`).then(r => r.text());
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = "authorized_keys";
  a.click();
}

// ── Backup & Restore ─────────────────────────────────────────────────────────

function downloadBackup() {
  const a = document.createElement("a");
  a.href = "/api/backup";
  a.download = "";
  a.click();
}

async function restoreBackup(input) {
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  if (!confirm(`Restore from "${file.name}"?\n\nThis will replace ALL current data. This cannot be undone.`)) return;
  try {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/restore", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Restore failed");
    showToast("Restore complete — reloading…");
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    alert("Restore failed: " + e.message);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function initAiStatus() {
  try {
    const { llm } = await api("GET", "/api/settings");
    updateAiStatusDot(llm.configured);
  } catch (_) {}
}

document.addEventListener("DOMContentLoaded", () => { boot(); initAiStatus(); });
