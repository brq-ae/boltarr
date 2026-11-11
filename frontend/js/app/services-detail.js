// Boltarr — Services topology, dependencies, service detail panel, bulk add, edit connection.
// Part of the app split from app.js (F-08); files share globals and load in order (see index.html).

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
  document.getElementById("svcTopoEdgeActions").style.display = "none";

  // Unique hosts from visible services
  const hostMap = new Map();
  services.forEach(s => {
    if (!hostMap.has(s.ip)) {
      const h = allHosts.find(h => h.ip === s.ip);
      hostMap.set(s.ip, { label: s.hostname || s.ip, device_type: h?.device_type || "unknown" });
    }
  });

  const elements = [];

  // Host nodes — colored by device_type like IP topology
  hostMap.forEach(({ label, device_type }, ip) => {
    elements.push({ group: "nodes", data: { id: `host-${ip}`, label, type: "host", ip, device_type } });
  });

  // Service nodes + runs-on edges
  const svcIdSet = new Set(services.map(s => s.id));
  services.forEach(s => {
    elements.push({ group: "nodes", data: {
      id: `svc-${s.id}`, label: s.name, type: "service", status: s.status, svcId: s.id
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

  // Host-link edges (manual "nested in" connections)
  (graphEdges || []).forEach(e => {
    if (e.data.type === "host-link") {
      const srcId = `host-${e.data.source}`;
      const dstId = `host-${e.data.target}`;
      if (hostMap.has(e.data.source) && hostMap.has(e.data.target)) {
        elements.push({ group: "edges", data: {
          id: `hl-${e.data.connection_id}`, source: srcId, target: dstId,
          type: "host-link", connId: e.data.connection_id, label: e.data.label || ""
        }});
      }
    }
  });

  if (svcCy) { svcCy.destroy(); svcCy = null; }

  svcCy = cytoscape({
    container,
    elements,
    style: [
      { selector: 'node[type="host"]', style: {
        "background-color": ele => NODE_COLORS[ele.data("device_type")] || NODE_COLORS.unknown,
        "background-opacity": 0.25,
        "border-width": 2,
        "border-color": ele => NODE_COLORS[ele.data("device_type")] || NODE_COLORS.unknown,
        "label": "data(label)", "color": "#e8e3de",
        "text-outline-color": "#0d1117", "text-outline-width": 2,
        "font-size": "11px", "text-valign": "center", "text-halign": "center",
        "width": 80, "height": 80, "shape": "roundrectangle",
        "text-wrap": "wrap", "text-max-width": "72px"
      }},
      { selector: 'node[type="service"]', style: {
        "background-color": "#131c28",
        "border-width": 1.5, "border-color": "#2a3a4e",
        "label": "data(label)", "color": "#8aafcc",
        "text-outline-color": "#0d1117", "text-outline-width": 1,
        "font-size": "9px", "text-valign": "bottom", "text-halign": "center",
        "text-margin-y": "4px", "width": 32, "height": 32, "shape": "ellipse",
        "text-wrap": "wrap", "text-max-width": "64px"
      }},
      { selector: 'node[status="running"]', style: { "border-color": "#42b86a", "border-width": 2 }},
      { selector: 'node[status="stopped"]', style: { "border-color": "#d94f3d", "border-width": 2 }},
      { selector: 'edge[type="runs-on"]', style: {
        "width": 1, "line-color": "#1e2e3e",
        "line-style": "dashed", "line-dash-pattern": [4, 4],
        "target-arrow-shape": "none", "curve-style": "straight"
      }},
      { selector: 'edge[type="depends-on"]', style: {
        "width": 2, "line-color": "#e8c517",
        "target-arrow-color": "#e8c517",
        "target-arrow-shape": "triangle", "curve-style": "bezier", "arrow-scale": 1.2
      }},
      { selector: 'edge[type="host-link"]', style: {
        "width": 2, "line-color": "#20a8c0",
        "target-arrow-color": "#20a8c0",
        "target-arrow-shape": "triangle", "curve-style": "bezier",
        "line-style": "solid", "arrow-scale": 1.3,
        "label": "data(label)", "font-size": "9px", "color": "#20a8c0",
        "text-rotation": "autorotate"
      }},
      { selector: ":selected", style: { "border-color": "#e8c517", "border-width": 3 }},
      { selector: 'edge:selected', style: { "line-color": "#e8c517", "target-arrow-color": "#e8c517" }},
    ],
    layout: {
      name: "cose", animate: false, randomize: true, fit: true, padding: 50,
      componentSpacing: 120, nodeOverlap: 10,
      nodeRepulsion: () => 8000,
      idealEdgeLength: e => e.data("type") === "depends-on" ? 55 : 140,
      edgeElasticity:  e => e.data("type") === "depends-on" ? 1500 : 100,
      gravity: 1.2, numIter: 1200, initialTemp: 1000, coolingFactor: 0.99, minTemp: 1
    }
  });

  // ── Drag host → services follow in real time (delta approach) ───────────────
  let _lastHostPos = null;
  let _dragSvcs    = [];

  svcCy.on("grab", 'node[type="host"]', e => {
    _lastHostPos = { ...e.target.position() };
    _dragSvcs    = svcCy.edges(`[type="runs-on"][source="${e.target.id()}"]`).targets().toArray();
  });

  svcCy.on("drag", 'node[type="host"]', e => {
    if (!_lastHostPos) return;
    const cur = e.target.position();
    const dx  = cur.x - _lastHostPos.x;
    const dy  = cur.y - _lastHostPos.y;
    _dragSvcs.forEach(svc => {
      const p = svc.position();
      svc.position({ x: p.x + dx, y: p.y + dy });
    });
    _lastHostPos = { x: cur.x, y: cur.y };
  });

  svcCy.on("free", 'node[type="host"]', () => {
    _lastHostPos = null;
    _dragSvcs    = [];
  });
  // ─────────────────────────────────────────────────────────────────────────────

  svcCy.on("tap", 'node[type="host"]',    e => showHostDetail(e.target.data("ip")));
  svcCy.on("tap", 'node[type="service"]', e => showSvcDetail(e.target.data("svcId")));
  svcCy.on("tap", 'edge[type="host-link"]', e => {
    const d = e.target.data();
    const actions = document.getElementById("svcTopoEdgeActions");
    const lbl     = document.getElementById("svcTopoEdgeLabel");
    actions.style.display = "flex";
    lbl.textContent = d.label ? `"${d.label}"` : `${d.source.replace("host-","")} → ${d.target.replace("host-","")}`;
    actions.dataset.connId = d.connId;
  });
  svcCy.on("tap", e => {
    if (e.target === svcCy) document.getElementById("svcTopoEdgeActions").style.display = "none";
  });
}

// ── Host-link (nested) connections in services topology ───────────────────────

function toggleLinkHostsForm() {
  const form = document.getElementById("linkHostsForm");
  const visible = form.style.display !== "none";
  form.style.display = visible ? "none" : "flex";
  if (!visible) {
    // populate selects from hosts visible in current topology
    const ips = [...new Set(allServices.map(s => s.ip))];
    const opts = ips.map(ip => {
      const h = allHosts.find(h => h.ip === ip);
      return `<option value="${escHtml(ip)}">${escHtml(ip)}${h?.hostname ? " — " + escHtml(h.hostname) : ""}</option>`;
    }).join("");
    document.getElementById("linkSrc").innerHTML = opts;
    document.getElementById("linkDst").innerHTML = opts;
  }
}

async function saveHostLink() {
  const src = document.getElementById("linkSrc").value;
  const dst = document.getElementById("linkDst").value;
  if (!src || !dst || src === dst) return alert("Pick two different hosts.");
  try {
    await api("POST", "/api/connections", { src_ip: src, dst_ip: dst, type: "host-link" });
    await loadGraph();
    toggleLinkHostsForm();
    renderSvcTopology();
  } catch (e) { alert("Error: " + e.message); }
}

async function deleteSelectedHostLink() {
  const actions = document.getElementById("svcTopoEdgeActions");
  const connId  = actions.dataset.connId;
  if (!connId || !confirm("Remove this host link?")) return;
  await api("DELETE", `/api/connections/${connId}`);
  await loadGraph();
  actions.style.display = "none";
  renderSvcTopology();
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
        <span style="flex:1;font-size:12px">${t ? escHtml(t.name) : `#${d.to_service_id}`}
          ${t ? `<span style="font-size:10px;color:var(--text-3)"> — ${escHtml(t.hostname || t.ip)}</span>` : ""}
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
      available.map(s => `<option value="${s.id}">${escHtml(s.name)} (${escHtml(s.hostname || s.ip)})</option>`).join("");
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

// ── Service detail panel ──────────────────────────────────────────────────────

function _setSvcDetailIcon(name) {
  const el = document.getElementById("svcDetailIcon");
  if (!el) return;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0x7FFFFFFF;
  const hue = h % 360;
  el.style.background = `hsl(${hue},40%,28%)`;
  el.style.color       = `hsl(${hue},60%,68%)`;
  el.textContent       = name.replace(/[^a-z0-9]/gi, "").substring(0, 2).toUpperCase() || "??";
}

function showSvcDetail(id) {
  const s = allServices.find(s => s.id === id);
  if (!s) return;
  hideHostDetail();
  svcDetailId     = id;
  svcDetailStatus = s.status || "unknown";

  _setSvcDetailIcon(s.name);

  document.getElementById("svcDetailName").value        = s.name || "";
  _fillHostSelect(document.getElementById("svcDetailHost"), s.ip);
  document.getElementById("svcDetailPort").value        = s.port || "";
  const proto = document.getElementById("svcDetailProto");
  if (proto) proto.value = s.protocol || "tcp";
  document.getElementById("svcDetailUrl").value         = s.url || "";
  document.getElementById("svcDetailContainerIp").value = s.container_ip || "";
  document.getElementById("svcDetailCheckType").value   = s.check_type || (s.url ? "http" : "tcp");
  svcDetailCheckChanged();
  document.getElementById("svcDetailDesc").value        = s.description || "";

  const btn = document.getElementById("svcDetailStatusBtn");
  btn.textContent = svcDetailStatus;
  btn.className   = `svc-status ${svcDetailStatus}`;

  updateSvcDetailUrlBtn();
  renderSvcDetailDeps(id);

  document.getElementById("svcDetailMonitored").checked = !!s.monitored;
  setSvcDetailMonDot(s.monitored ? (s.monitor_status || "unknown") : "off");

  document.getElementById("svcDetailPublic").checked = !!s.public;
  document.getElementById("svcDetailPublicName").value = s.public_name || "";
  document.getElementById("svcDetailPublicNameRow").style.display = s.public ? "" : "none";

  loadSvcUptime(id, !!s.monitored);

  document.getElementById("svcDetailPanel").classList.add("open");
  makeDesktopResizable(document.getElementById("svcDetailPanel"), "svc");
}

function _uptimeClass(pct) {
  return pct >= 99.5 ? "uptime-good" : pct >= 95 ? "uptime-mid" : "uptime-bad";
}
function _fmtDur(sec) {
  if (sec < 60) return sec + "s";
  const m = Math.floor(sec / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

async function loadSvcUptime(id, monitored) {
  const wrap = document.getElementById("svcDetailUptimeWrap");
  const el   = document.getElementById("svcDetailUptime");
  if (!monitored) { wrap.style.display = "none"; return; }
  wrap.style.display = "";
  el.innerHTML = `<span style="font-size:11px;color:var(--text-3)">Loading…</span>`;
  try {
    const d = await api("GET", `/api/services/${id}/uptime`);
    const stat = (label, u) => {
      if (!u) return `<div class="uptime-stat"><span class="val" style="color:var(--text-3)">—</span><span class="lbl">${escHtml(label)}</span></div>`;
      return `<div class="uptime-stat"><span class="val ${_uptimeClass(u.pct)}">${u.pct.toFixed(2)}%</span><span class="lbl">${escHtml(label)}</span></div>`;
    };
    const rows = `<div class="uptime-row">${stat("24 h", d.uptime["24h"])}${stat("7 days", d.uptime["7d"])}${stat("30 days", d.uptime["30d"])}</div>`;
    let outages = "";
    if (d.outages && d.outages.length) {
      outages = `<div class="outage-list">${d.outages.map(o => {
        const start = new Date(o.start).toLocaleString();
        return o.end
          ? `<span class="outage-item">▾ ${start} — down ${_fmtDur(o.seconds)}</span>`
          : `<span class="outage-item ongoing">▾ ${start} — down now (${_fmtDur(o.seconds)})</span>`;
      }).join("")}</div>`;
    } else {
      outages = `<span style="font-size:10px;color:var(--text-3)">No outages recorded yet.</span>`;
    }
    el.innerHTML = rows + outages + `<div class="uptime-reset"><button class="btn-ghost" onclick="resetSvcUptime(${id})">↺ Reset uptime</button></div>`;
  } catch (e) {
    el.innerHTML = `<span style="font-size:11px;color:var(--text-3)">No uptime data yet.</span>`;
  }
}

async function resetSvcUptime(id) {
  if (!confirm("Reset uptime history for this service? Clears its outages and restarts the % from now.")) return;
  try { await api("POST", `/api/services/${id}/uptime/reset`); await loadSvcUptime(id, true); }
  catch (e) { alert("Error: " + (e.message || e)); }
}
async function resetHostUptime(ip) {
  if (!confirm("Reset uptime history for this host? Clears its outages and restarts the % from now.")) return;
  try { await api("POST", `/api/hosts/${ip}/uptime/reset`); await loadHostUptime(ip); }
  catch (e) { alert("Error: " + (e.message || e)); }
}
async function resetAllUptime() {
  if (!confirm("Reset uptime history for ALL services and hosts? Clears every outage record and restarts all percentages from now. This can't be undone.")) return;
  try { await api("POST", "/api/uptime/reset-all"); alert("Uptime history reset for all services and hosts."); }
  catch (e) { alert("Error: " + (e.message || e)); }
}

// Paint the monitor dot + label in the detail panel. status: up|down|unknown|off|checking
function setSvcDetailMonDot(status) {
  const dot  = document.getElementById("svcDetailMonitorDot");
  const text = document.getElementById("svcDetailMonitorText");
  if (!dot || !text) return;
  const label = { up: "up", down: "down", unknown: "checking…", checking: "checking…", off: "off" }[status] || "off";
  const cls   = status === "up" ? "mon-up" : status === "down" ? "mon-down" : "mon-unknown";
  dot.className  = "mon-dot " + cls + (status === "checking" || status === "unknown" ? " checking" : "");
  text.textContent = label;
}

function toggleSvcPublicName() {
  const on = document.getElementById("svcDetailPublic").checked;
  document.getElementById("svcDetailPublicNameRow").style.display = on ? "" : "none";
}

// Saves the public toggle + public name via the dedicated endpoint (never
// touches other service fields). Called from the detail panel Save.
async function saveSvcPublic() {
  if (!svcDetailId) return;
  const enabled = document.getElementById("svcDetailPublic").checked;
  const name    = document.getElementById("svcDetailPublicName").value.trim();
  const r = await api("POST", `/api/services/${svcDetailId}/public`, { enabled, name });
  allServices = allServices.map(s => s.id === svcDetailId
    ? { ...s, public: enabled ? 1 : 0, public_name: name } : s);
  return r;
}

async function toggleSvcMonitor() {
  if (!svcDetailId) return;
  const on = document.getElementById("svcDetailMonitored").checked;
  setSvcDetailMonDot(on ? "checking" : "off");
  try {
    // Dedicated endpoint — only touches the `monitored` flag, never other fields
    const r = await api("POST", `/api/services/${svcDetailId}/monitor`, { enabled: on });
    allServices = allServices.map(s => s.id === svcDetailId
      ? { ...s, monitored: on ? 1 : 0, monitor_status: r.monitor_status } : s);
    setSvcDetailMonDot(on ? (r.monitor_status || "unknown") : "off");
    loadSvcUptime(svcDetailId, on);
    renderServicesTable();
  } catch (e) {
    alert("Error: " + e.message);
    document.getElementById("svcDetailMonitored").checked = !on;
    setSvcDetailMonDot(!on ? "unknown" : "off");
  }
}

function hideSvcDetail() {
  document.getElementById("svcDetailPanel")?.classList.remove("open");
  svcDetailId = null;
}

function cycleSvcDetailStatus() {
  svcDetailStatus = STATUS_CYCLE[svcDetailStatus] || "unknown";
  const btn = document.getElementById("svcDetailStatusBtn");
  btn.textContent = svcDetailStatus;
  btn.className   = `svc-status ${svcDetailStatus}`;
}

function updateSvcDetailUrlBtn() {
  const val = document.getElementById("svcDetailUrl")?.value.trim();
  const btn = document.getElementById("svcDetailUrlBtn");
  if (!btn) return;
  if (val && /^https?:\/\//i.test(val)) {   // only real web links are clickable
    btn.href    = val;
    btn.style.display = "";
  } else {
    btn.style.display = "none";
  }
}

async function saveSvcDetail() {
  if (!svcDetailId) return;
  const name  = document.getElementById("svcDetailName").value.trim();
  if (!name) return alert("Service name is required.");
  const port  = parseInt(document.getElementById("svcDetailPort").value) || null;
  const proto = document.getElementById("svcDetailProto")?.value || "tcp";
  const url   = document.getElementById("svcDetailUrl").value.trim() || null;
  const desc  = document.getElementById("svcDetailDesc").value.trim() || null;
  const checkType   = document.getElementById("svcDetailCheckType").value;
  const containerIp = document.getElementById("svcDetailContainerIp").value.trim();
  const hostIp      = document.getElementById("svcDetailHost").value;
  try {
    const svc = await api("PUT", `/api/services/${svcDetailId}`, {
      name, port, protocol: proto, url, description: desc, status: svcDetailStatus,
      check_type: checkType, container_ip: containerIp, host_ip: hostIp,
    });
    await saveSvcPublic();   // public toggle + public name (dedicated, safe endpoint)
    allServices = allServices.map(s => s.id === svcDetailId ? { ...s, ...svc } : s);
    const hostIp = allServices.find(s => s.id === svcDetailId)?.ip;
    const row = document.getElementById(`svc-row-${svcDetailId}`);
    if (row) row.outerHTML = svcRowHTML(svc, hostIp || svc.ip);
    renderServicesTable();
    if (currentSvcTab === "topology") renderSvcTopology();
    _setSvcDetailIcon(name);
    showToast("Service saved");
  } catch (e) { alert("Error: " + e.message); }
}

async function deleteSvcDetail() {
  if (!svcDetailId) return;
  if (!confirm("Delete this service?")) return;
  try {
    await api("DELETE", `/api/services/${svcDetailId}`);
    allServices = allServices.filter(s => s.id !== svcDetailId);
    document.getElementById(`svc-row-${svcDetailId}`)?.remove();
    renderServicesTable();
    if (currentSvcTab === "topology") renderSvcTopology();
    hideSvcDetail();
  } catch (e) { alert("Error: " + e.message); }
}

function renderSvcDetailDeps(svcId) {
  const container = document.getElementById("svcDetailDeps");
  if (!container) return;
  const outgoing = allDependencies.filter(d => d.from_service_id === svcId);
  const incoming = allDependencies.filter(d => d.to_service_id   === svcId);
  const chips = [
    ...outgoing.map(d => {
      const target = allServices.find(s => s.id === d.to_service_id);
      return `<span class="dep-chip outgoing">→ ${escHtml(target ? target.name : d.to_service_id)}</span>`;
    }),
    ...incoming.map(d => {
      const src = allServices.find(s => s.id === d.from_service_id);
      return `<span class="dep-chip incoming">← ${escHtml(src ? src.name : d.from_service_id)}</span>`;
    }),
  ];
  const hint = `<span style="font-size:11px;color:var(--text-3)">Manage dependencies from the Topology view.</span>`;
  container.innerHTML = chips.length ? chips.join("") + `<div style="flex-basis:100%">${hint}</div>` : hint;
}

// ── Bulk add containers ───────────────────────────────────────────────────────

function _unusedContainerIps() {
  const used = new Set([
    ...allServices.map(s => s.ip),
    ...allServices.map(s => s.container_ip).filter(Boolean),
    ...allServices.map(s => { try { return new URL(s.url || "").hostname; } catch { return null; } }).filter(Boolean),
  ]);
  return allHosts.filter(h => h.device_type === "container" && !used.has(h.ip));
}

function openBulkAddContainers() {
  const containers = _unusedContainerIps();
  if (containers.length === 0) {
    alert("No container hosts available to import.");
    return;
  }
  bulkSelectedIps = new Map();
  const grid = document.getElementById("bulkContainerGrid");
  grid.innerHTML = containers.map(h => {
    const label = h.hostname || h.ip;
    const sub   = h.hostname ? h.ip : "";
    return `<div class="container-chip" id="bulk-chip-${h.ip.replace(/\./g,'_')}" onclick="toggleBulkChip(${jsq(h.ip)},${jsq(label)})">
      <span class="container-chip-name">${escHtml(label)}</span>
      ${sub ? `<span class="container-chip-ip">${escHtml(sub)}</span>` : ""}
    </div>`;
  }).join("");
  const sel = document.getElementById("bulkHostIp");
  const regularH   = allHosts.filter(h => h.device_type !== "container");
  const containerH = allHosts.filter(h => h.device_type === "container");
  const bulkOpt = h => `<option value="${escHtml(h.ip)}">${escHtml(h.ip)}${h.hostname ? " — " + escHtml(h.hostname) : ""}</option>`;
  sel.innerHTML = regularH.map(bulkOpt).join("") +
    (containerH.length ? `<optgroup label="── Containers ──">${containerH.map(bulkOpt).join("")}</optgroup>` : "");
  const last = localStorage.getItem("boltarr_last_svc_host");
  if (last && sel.querySelector(`option[value="${last}"]`)) sel.value = last;
  updateBulkAddBtn();
  document.getElementById("bulkAddModal").classList.add("open");
}

function toggleBulkChip(ip, name) {
  if (bulkSelectedIps.has(ip)) bulkSelectedIps.delete(ip);
  else bulkSelectedIps.set(ip, name);
  document.getElementById(`bulk-chip-${ip.replace(/\./g,'_')}`)?.classList.toggle("selected", bulkSelectedIps.has(ip));
  updateBulkAddBtn();
}

function bulkSelectAll() {
  _unusedContainerIps().forEach(h => {
    bulkSelectedIps.set(h.ip, h.hostname || h.ip);
    document.getElementById(`bulk-chip-${h.ip.replace(/\./g,'_')}`)?.classList.add("selected");
  });
  updateBulkAddBtn();
}

function updateBulkAddBtn() {
  const n   = bulkSelectedIps.size;
  const btn = document.getElementById("bulkAddBtn");
  if (!btn) return;
  btn.textContent = n === 0 ? "Add selected" : `Add ${n} container${n > 1 ? "s" : ""}`;
  btn.disabled    = n === 0;
}

async function bulkAddContainers() {
  const hostIp = document.getElementById("bulkHostIp").value;
  if (!hostIp || bulkSelectedIps.size === 0) return;
  localStorage.setItem("boltarr_last_svc_host", hostIp);
  for (const [ip, name] of bulkSelectedIps) {
    try {
      const svc = await api("POST", `/api/hosts/${hostIp}/services`, {
        name, url: `http://${ip}`, container_ip: ip, status: "unknown"
      });
      allServices.push(svc);
    } catch { /* skip failed ones silently */ }
  }
  populateSvcHostFilter();
  renderServicesTable();
  if (currentSvcTab === "topology") renderSvcTopology();
  document.getElementById("bulkAddModal").classList.remove("open");
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

registerActions({ resetAllUptime });
