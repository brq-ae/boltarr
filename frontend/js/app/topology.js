// Boltarr — Topology → Hierarchy, VLANs.
// Part of the app split from app.js (F-08); files share globals and load in order (see index.html).

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
    <div class="hier-node-row" onclick="showHostDetail(${jsq(ip)})">
      <span class="hier-tier-badge">${tierBadge}</span>
      <span class="hier-dot" style="background:${color}"></span>
      <span class="hier-ip mono">${escHtml(ip)}</span>
      <span class="hier-hostname">${host.hostname ? escHtml(host.hostname) : '<span style="color:var(--text-3)">—</span>'}</span>
      <span class="tag tag-${escHtml(dt)}" style="font-size:9px;padding:1px 5px;line-height:1.6">${escHtml(dt)}</span>
      ${pill}
      <span class="hier-node-actions">
        <button class="btn" style="font-size:10px;padding:2px 7px"
          onclick="event.stopPropagation();hierLinkFrom(${jsq(ip)})">Link</button>
        <button class="btn" style="font-size:10px;padding:2px 7px"
          onclick="event.stopPropagation();hierMultiLinkFrom(${jsq(ip)})">Multi</button>
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
      <div class="vlan-swatch" style="background:${escHtml(v.color)}"></div>
      <span class="vlan-tag mono">VLAN ${escHtml(v.tag)}</span>
      <span class="vlan-name">${escHtml(v.name)}</span>
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
              <span class="vlan-swatch-sm" style="background:${escHtml(v.color)}"></span>
              <span class="mono" style="font-size:10px">VLAN ${escHtml(v.tag)}</span>
              <span style="font-size:11px;color:var(--text-2)">${escHtml(v.name)}</span>
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

