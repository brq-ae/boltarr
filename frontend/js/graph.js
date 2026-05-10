// Cytoscape topology graph + connection drawing

const NODE_COLORS = {
  router:             "#e0721c",   // warm orange
  gateway:            "#e0721c",
  switch:             "#d45a20",   // red-orange
  "unmanaged-switch": "#b04018",   // darker red-orange
  firewall:           "#d45a20",
  server:             "#4a9ae0",   // steel blue
  nas:                "#4a9ae0",
  workstation:        "#42b86a",   // green
  pc:                 "#42b86a",
  laptop:             "#42b86a",
  iot:                "#d4a020",   // amber-yellow
  camera:             "#d4a020",
  printer:            "#d4a020",
  phone:              "#8855cc",   // purple
  tablet:             "#8855cc",
  container:          "#20a8c0",   // cyan
  vm:                 "#7068cc",   // indigo-violet
  ap:                 "#2ab8a0",   // teal
  unknown:            "#524c48",   // warm dark gray
};

const NODE_SIZES = {
  router: 44, gateway: 44, switch: 40, "unmanaged-switch": 38, firewall: 40,
  server: 38, nas: 36,
  workstation: 32, pc: 32, laptop: 32,
  iot: 28, camera: 28, printer: 28, phone: 26, tablet: 26,
  container: 34, vm: 36, ap: 30,
  unknown: 28,
};

function nodeColor(type) { return NODE_COLORS[type] || NODE_COLORS.unknown; }
function nodeSize(type)  { return NODE_SIZES[type]  || NODE_SIZES.unknown; }

let cy = null;
let connectMode        = false;
let connectSource      = null;
let multiConnectMode   = false;
let multiConnectSource = null;
let multiConnectTargets = [];

function initGraph() {
  cy = cytoscape({
    container: document.getElementById("cy"),
    style: [
      {
        selector: "node",
        style: {
          "background-color": (ele) => nodeColor(ele.data("device_type")),
          label: (ele) => {
            const base = ele.data("label") || "";
            const badges = [];
            if (ele.data("is_dns"))  badges.push("DNS");
            if (ele.data("is_dhcp")) badges.push("DHCP");
            return badges.length ? base + "\n" + badges.join(" · ") : base;
          },
          color:                "#e8e3de",
          "text-valign":        "bottom",
          "text-halign":        "center",
          "font-family":        "'JetBrains Mono', 'Cascadia Code', ui-monospace, monospace",
          "font-size":          "10px",
          "text-margin-y":      "5px",
          "text-outline-color": "#1a1714",
          "text-outline-width": "2px",
          width:  (ele) => nodeSize(ele.data("device_type")),
          height: (ele) => nodeSize(ele.data("device_type")),
          "border-width":   2,
          "border-color":   "#3c3530",
          "border-opacity": 0.9,
          "shadow-blur":     (ele) => ele.data("has_wifi") ? 14 : 0,
          "shadow-color":    "#42b86a",
          "shadow-opacity":  (ele) => ele.data("has_wifi") ? 0.65 : 0,
          "shadow-offset-x": 0,
          "shadow-offset-y": 0,
        },
      },
      {
        selector: "node.connect-src",
        style: { "border-color": "#d47c12", "border-width": 3, "border-opacity": 1 },
      },
      {
        selector: "node.connect-dst",
        style: { "border-color": "#42b86a", "border-width": 3, "border-opacity": 1 },
      },
      {
        selector: "node:selected",
        style: { "border-color": "#d47c12", "border-width": 3, "border-opacity": 1 },
      },
      // Base edge — white/neutral; VLAN colors applied via applyEdgeVlanStyle()
      {
        selector: "edge",
        style: {
          "line-color":             "#d4d0cc",
          "line-opacity":           0.75,
          width:                    2,
          "line-style":             "solid",
          "curve-style":            "bezier",
          "control-point-step-size": 10,  // tighter parallel-edge spread
          label: (ele) => ele.data("overlay_conn") ? "" : (ele.data("label") || ele.data("speed") || ""),
          "font-family":        "'JetBrains Mono', ui-monospace, monospace",
          "font-size":          "9px",
          color:                "#ffffff",
          "text-outline-color": "#1a1714",
          "text-outline-width": "2px",
          "text-rotation":      "autorotate",
        },
      },
      // Type selectors — only override line-style / width, not color
      { selector: "edge[type='wifi']",    style: { "line-style": "dashed", "line-dash-pattern": [6, 4] } },
      { selector: "edge[type='fiber']",   style: { "line-opacity": 0.85, width: 2.5 } },
      { selector: "edge[type='dac']",     style: { "line-style": "dashed", "line-dash-pattern": [10, 3], width: 2.5 } },
      { selector: "edge[type='virtual']", style: { "line-style": "dotted", "line-opacity": 0.55, width: 1.5 } },
      { selector: "edge[port_mode='trunk']",  style: { width: 3   } },
      { selector: "edge[port_mode='access']", style: { width: 1.5 } },
      // Overlay edges (pure visual, no label needed)
      { selector: "edge[overlay_conn]",   style: { label: "", "text-events": "no" } },
    ],
    layout:             { name: "grid" },
    userZoomingEnabled: true,
    userPanningEnabled: true,
    minZoom:            0.15,
    maxZoom:            5,
  });

  // Suppress native context menu using a position-based check (capture phase, before anything else).
  // Target-based checks (contains, querySelectorAll on canvas) fail when Cytoscape sets
  // pointer-events:none on canvas layers, causing e.target to resolve to document.body.
  document.addEventListener("contextmenu", function(e) {
    const cyEl = document.getElementById("cy");
    if (!cyEl) return;
    const r = cyEl.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right &&
        e.clientY >= r.top  && e.clientY <= r.bottom) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
  cy.on("cxttapstart", e => { if (e.originalEvent) e.originalEvent.preventDefault(); });

  cy.on("tap", "node", (evt) => {
    hideCtxMenu();
    if (multiConnectMode)    handleMultiConnectTap(evt.target);
    else if (connectMode)    handleConnectTap(evt.target);
    else                     window.showHostDetail(evt.target.data("ip"));
  });

  cy.on("cxttap", "node", (evt) => {
    if (connectMode || multiConnectMode) return;
    const node = evt.target;
    const ip   = node.data("ip");
    const rp   = evt.renderedPosition;
    const sid  = nodeSubnetId(ip);
    const snet = sid != null ? (window.subnets||[]).find(s => s.id === sid) : null;
    showCtxMenu(rp.x, rp.y, [
      { action: "edit",    label: "✎  Edit",    fn: () => window.openEditHost(ip) },
      { action: "analyze", label: "⬡  Analyze", fn: () => { window.showHostDetail(ip); setTimeout(() => window.analyzeHost(ip), 200); } },
      "---",
      ...(snet ? [{ action: "selsubnet", label: `◎  Select all in "${snet.name}"`, fn: () => selectNodesInSubnet(snet.id) }] : []),
      { action: "grid",    label: "⊞  Arrange selected in grid", fn: arrangeSelectedInGrid },
      "---",
      { action: "delete",  label: "✕  Delete host", fn: () => window.deleteHost(ip) },
    ]);
  });

  cy.on("cxttap", (evt) => {
    if (evt.target !== cy) return;
    if (connectMode || multiConnectMode) return;
    const rp = evt.renderedPosition;
    const hasSel = cy.$(':selected').filter('node').length > 1;
    const subnetItems = (window.subnets||[]).map(s => ({
      action: `sel_${s.id}`, label: `◎  Select "${s.name}" (${s.cidr})`,
      fn: () => selectNodesInSubnet(s.id),
    }));
    showCtxMenu(rp.x, rp.y, [
      { action: "unassigned", label: "◎  Select unassigned hosts", fn: selectUnassignedNodes },
      ...subnetItems,
      "---",
      ...(hasSel ? [{ action: "grid", label: "⊞  Arrange selected in grid", fn: arrangeSelectedInGrid }] : []),
      { action: "clear", label: "✕  Clear selection", fn: () => cy.$(':selected').unselect() },
    ]);
  });

  cy.on("tap", "edge", (evt) => {
    let tgt = evt.target;
    // If overlay edge, delegate to the main edge for correct data
    if (tgt.data("overlay_conn")) {
      const main = cy.getElementById(`e${tgt.data("connection_id")}`);
      if (main.length) tgt = main;
    }
    const d = tgt.data();
    if (d.connection_id) window.openEditConn(d.connection_id, tgt.id(), d);
  });

  cy.on("tap", (evt) => {
    if (evt.target !== cy) return;
    if (multiConnectMode) return;
    if (connectMode) clearConnectSource();
    else             window.hideHostDetail();
  });
}

// ── VLAN edge styling — parallel lines per VLAN ──────────────────────────────

function applyEdgeVlanStyle(edge) {
  const connId     = edge.data("connection_id");
  const portMode   = edge.data("port_mode");
  const vlans      = edge.data("vlans") || [];
  const taggedOnly = !!edge.data("tagged_only");

  // Remove old overlay edges for this connection
  if (connId != null) {
    cy.edges(`[overlay_conn="${connId}"]`).remove();
  }
  edge.removeStyle("line-color");

  if (!portMode) return;  // no port mode → keep default white

  if (portMode === "access") {
    if (vlans.length > 0) edge.style("line-color", vlans[0].color);
    return;
  }

  if (portMode === "trunk") {
    const src   = edge.data("source");
    const tgt   = edge.data("target");
    // Build ordered list of lines: native(null) first unless tagged-only
    const lines = taggedOnly ? [...vlans] : [null, ...vlans];
    if (!lines.length) return;

    // First line → style the main edge
    const first = lines[0];
    if (first === null) {
      edge.removeStyle("line-color");  // native = white
    } else {
      edge.style("line-color", first.color);
    }

    // Remaining lines → overlay edges (auto-paralleled by Cytoscape bezier)
    for (let i = 1; i < lines.length; i++) {
      const vlan = lines[i];
      const overlayEl = cy.add({
        group: "edges",
        data: {
          id:           `evlan_${connId}_${i}`,
          source:       src,
          target:       tgt,
          overlay_conn: String(connId),
          connection_id: connId,
        },
      });
      overlayEl.style({
        "line-color":   vlan ? vlan.color : "#d4d0cc",
        "line-opacity": 0.75,
        width:          2,
        label:          "",
      });
    }
  }
}

// ── Single connect mode ───────────────────────────────────────────────────────

function toggleConnectMode() {
  connectMode = !connectMode;
  const btn  = document.getElementById("connectBtn");
  const hint = document.getElementById("connectHint");
  const cyEl = document.getElementById("cy");

  if (connectMode) {
    if (multiConnectMode) toggleMultiConnectMode();
    btn.classList.add("btn-active-mode");
    btn.textContent = "◎ Link (on)";
    hint.classList.add("visible");
    hint.textContent = "Tap a device to start";
    cyEl.classList.add("connect-mode");
  } else {
    btn.classList.remove("btn-active-mode");
    btn.textContent = "◎ Link";
    hint.classList.remove("visible");
    cyEl.classList.remove("connect-mode");
    clearConnectSource();
  }
}

function clearConnectSource() {
  if (connectSource) {
    cy.getElementById(connectSource).removeClass("connect-src");
    connectSource = null;
  }
  const hint = document.getElementById("connectHint");
  if (connectMode && hint) hint.textContent = "Tap a device to start";
}

function handleConnectTap(node) {
  const ip = node.data("ip");
  if (!connectSource) {
    connectSource = ip;
    node.addClass("connect-src");
    const hint = document.getElementById("connectHint");
    if (hint) hint.textContent = `${ip} → tap destination`;
    return;
  }
  if (connectSource === ip) { clearConnectSource(); return; }

  document.getElementById("connSrc").textContent = connectSource;
  document.getElementById("connDst").textContent = ip;
  document.getElementById("connDstHidden").value = ip;
  document.getElementById("connLabel").value    = "";
  document.getElementById("connType").value     = "wired";
  document.getElementById("connPortMode").value = "";
  document.getElementById("connSpeed").value    = "";
  if (typeof updateConnVlans === "function") updateConnVlans("connVlanSection", "");
  document.getElementById("connModal").classList.add("open");
  clearConnectSource();
}

async function saveConnection() {
  const src      = document.getElementById("connSrc").textContent;
  const dst      = document.getElementById("connDstHidden").value;
  const type     = document.getElementById("connType").value;
  const label    = document.getElementById("connLabel").value.trim();
  const portMode = document.getElementById("connPortMode").value || null;
  const speed      = document.getElementById("connSpeed").value || null;
  const vlanIds    = typeof getSelectedVlanIds === "function" ? getSelectedVlanIds("connVlanSection") : [];
  const taggedOnly = typeof getTaggedOnly === "function" ? getTaggedOnly("connVlanSection") : false;
  try {
    const r = await fetch("/api/connections", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ src_ip: src, dst_ip: dst, type, label, port_mode: portMode,
                             speed, tagged_only: taggedOnly, vlan_ids: vlanIds }),
    });
    if (!r.ok) throw new Error(await r.text());
    const conn = await r.json();
    const edgeEl = cy.add({ group: "edges", data: {
      id: `e${conn.id}`, source: src, target: dst,
      type, label, port_mode: portMode || "", speed: speed || "",
      tagged_only: taggedOnly, vlans: conn.vlans || [], connection_id: conn.id,
    }});
    applyEdgeVlanStyle(edgeEl);
    closeConnModal();
  } catch (e) { alert("Error: " + e.message); }
}

function closeConnModal() {
  document.getElementById("connModal").classList.remove("open");
}

async function deleteConnection(connId, edgeId) {
  await fetch(`/api/connections/${connId}`, { method: "DELETE" });
  cy.edges(`[overlay_conn="${connId}"]`).remove();
  cy.remove(`#${edgeId}`);
}

// ── Multi-connect mode ────────────────────────────────────────────────────────

function toggleMultiConnectMode() {
  multiConnectMode = !multiConnectMode;
  const btn        = document.getElementById("multiConnBtn");
  const confirmBtn = document.getElementById("multiConfirmBtn");
  const hint       = document.getElementById("connectHint");
  const cyEl       = document.getElementById("cy");

  if (multiConnectMode) {
    if (connectMode) toggleConnectMode();
    btn.classList.add("btn-active-mode");
    btn.textContent = "⊕ Multi-Link (on)";
    hint.classList.add("visible");
    hint.textContent = "Tap source device";
    cyEl.classList.add("connect-mode");
  } else {
    btn.classList.remove("btn-active-mode");
    btn.textContent = "⊕ Multi-Link";
    confirmBtn.style.display = "none";
    hint.classList.remove("visible");
    cyEl.classList.remove("connect-mode");
    clearMultiConnect();
  }
}

function clearMultiConnect() {
  if (multiConnectSource) {
    cy.getElementById(multiConnectSource).removeClass("connect-src");
    multiConnectSource = null;
  }
  multiConnectTargets.forEach(ip => cy.getElementById(ip).removeClass("connect-dst"));
  multiConnectTargets = [];
  document.getElementById("multiConfirmBtn").style.display = "none";
}

function handleMultiConnectTap(node) {
  const ip   = node.data("ip");
  const hint = document.getElementById("connectHint");

  if (!multiConnectSource) {
    multiConnectSource = ip;
    node.addClass("connect-src");
    if (hint) hint.textContent = `${ip} → tap targets`;
    return;
  }
  if (ip === multiConnectSource) {
    clearMultiConnect();
    if (hint) hint.textContent = "Tap source device";
    return;
  }

  const idx = multiConnectTargets.indexOf(ip);
  if (idx >= 0) {
    multiConnectTargets.splice(idx, 1);
    node.removeClass("connect-dst");
  } else {
    multiConnectTargets.push(ip);
    node.addClass("connect-dst");
  }

  const n = multiConnectTargets.length;
  const confirmBtn = document.getElementById("multiConfirmBtn");
  if (n > 0) {
    confirmBtn.style.display = "";
    confirmBtn.textContent = `Link (${n})`;
    if (hint) hint.textContent = `${multiConnectSource} → ${n} target${n > 1 ? "s" : ""} selected`;
  } else {
    confirmBtn.style.display = "none";
    if (hint) hint.textContent = `${multiConnectSource} → tap targets`;
  }
}

function openMultiConnModal() {
  if (!multiConnectSource || !multiConnectTargets.length) return;
  document.getElementById("multiConnSrc").textContent = multiConnectSource;
  document.getElementById("multiConnTargetList").innerHTML =
    multiConnectTargets.map(ip => `<span class="port-badge mono">${ip}</span>`).join("");
  document.getElementById("multiConnType").value     = "wired";
  document.getElementById("multiConnPortMode").value = "";
  document.getElementById("multiConnLabel").value    = "";
  document.getElementById("multiConnSpeed").value    = "";
  if (typeof updateConnVlans === "function") updateConnVlans("multiConnVlanSection", "");
  document.getElementById("multiConnModal").classList.add("open");
}

function closeMultiConnModal() {
  document.getElementById("multiConnModal").classList.remove("open");
}

async function saveMultiConnections() {
  const src      = document.getElementById("multiConnSrc").textContent;
  const type     = document.getElementById("multiConnType").value;
  const portMode = document.getElementById("multiConnPortMode").value || null;
  const label    = document.getElementById("multiConnLabel").value.trim();
  const speed      = document.getElementById("multiConnSpeed").value || null;
  const vlanIds    = typeof getSelectedVlanIds === "function" ? getSelectedVlanIds("multiConnVlanSection") : [];
  const taggedOnly = typeof getTaggedOnly === "function" ? getTaggedOnly("multiConnVlanSection") : false;
  const targets    = [...multiConnectTargets];
  const errors     = [];

  for (const dst of targets) {
    try {
      const r = await fetch("/api/connections", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ src_ip: src, dst_ip: dst, type, label, port_mode: portMode,
                               speed, tagged_only: taggedOnly, vlan_ids: vlanIds }),
      });
      if (!r.ok) {
        const txt = await r.text();
        if (!txt.includes("UNIQUE")) errors.push(`${dst}: ${txt}`);
        continue;
      }
      const conn = await r.json();
      const edgeEl = cy.add({ group: "edges", data: {
        id: `e${conn.id}`, source: src, target: dst,
        type, label, port_mode: portMode || "", speed: speed || "",
        tagged_only: taggedOnly, vlans: conn.vlans || [], connection_id: conn.id,
      }});
      applyEdgeVlanStyle(edgeEl);
    } catch (e) { errors.push(`${dst}: ${e.message}`); }
  }

  closeMultiConnModal();
  clearMultiConnect();
  if (multiConnectMode) toggleMultiConnectMode();
  if (errors.length) alert("Some links failed:\n" + errors.join("\n"));
}

// ── Layout persistence ────────────────────────────────────────────────────────

// ── IP / CIDR utilities ───────────────────────────────────────────────────────

function ipToInt(ip) {
  return ip.split(".").reduce((acc, o) => (acc << 8) | parseInt(o, 10), 0) >>> 0;
}
function ipInCidr(ip, cidr) {
  try {
    const [net, bits] = cidr.split("/");
    const mask = bits === "32" ? 0xFFFFFFFF : (~0 << (32 - parseInt(bits))) >>> 0;
    return (ipToInt(ip) & mask) === (ipToInt(net) & mask);
  } catch { return false; }
}
function nodeSubnetId(nodeIp) {
  if (!window.subnets) return null;
  const s = window.subnets.find(s => ipInCidr(nodeIp, s.cidr));
  return s ? s.id : null;
}

// ── Subnet visibility ─────────────────────────────────────────────────────────

function applySubnetVisibility() {
  if (!cy) return;
  cy.nodes().forEach(n => {
    const ip = n.data("ip") || "";
    if (ip.startsWith("node-")) { n.show(); return; }
    const sid = nodeSubnetId(ip);
    // Node is in a hidden subnet → hide; also hide its non-overlay edges
    if (sid != null && hiddenSubnets.has(sid)) {
      n.hide();
      n.connectedEdges().not("[overlay_conn]").hide();
    } else {
      n.show();
      // Only show edges whose BOTH endpoints are visible
      n.connectedEdges().not("[overlay_conn]").forEach(e => {
        const src = cy.getElementById(e.data("source"));
        const tgt = cy.getElementById(e.data("target"));
        if (!src.hidden() && !tgt.hidden()) e.show();
      });
    }
  });
}

// ── Grid arrange ──────────────────────────────────────────────────────────────

function arrangeSelectedInGrid(spacing = 90) {
  const sel = cy.$(':selected').filter('node').not('[overlay_conn]');
  if (sel.length < 2) { alert("Select at least 2 nodes first."); return; }
  const n    = sel.length;
  const cols = Math.ceil(Math.sqrt(n));
  // Centroid of current positions
  let cx = 0, cy_ = 0;
  sel.forEach(node => { cx += node.position("x"); cy_ += node.position("y"); });
  cx /= n; cy_ /= n;
  const startX = cx - ((cols - 1) * spacing) / 2;
  const startY = cy_ - (Math.ceil(n / cols) - 1) * spacing / 2;
  sel.forEach((node, i) => {
    node.position({ x: startX + (i % cols) * spacing, y: startY + Math.floor(i / cols) * spacing });
  });
  saveLayoutLocally();
}

// ── Context menu ──────────────────────────────────────────────────────────────

let _ctxMenu = null;
function _ensureCtxMenu() {
  if (_ctxMenu) return _ctxMenu;
  _ctxMenu = document.createElement("div");
  _ctxMenu.id = "cyContextMenu";
  _ctxMenu.className = "cy-context-menu";
  document.body.appendChild(_ctxMenu);
  document.addEventListener("mousedown", e => {
    if (_ctxMenu && !_ctxMenu.contains(e.target)) hideCtxMenu();
  });
  return _ctxMenu;
}

function showCtxMenu(x, y, items) {
  const menu = _ensureCtxMenu();
  menu.innerHTML = items.map(item =>
    item === "---"
      ? `<div class="ctx-sep"></div>`
      : `<button class="ctx-item" data-action="${item.action}">${item.label}</button>`
  ).join("");
  menu.querySelectorAll(".ctx-item").forEach(btn => {
    const item = items.find(i => i !== "---" && i.action === btn.dataset.action);
    if (item) btn.addEventListener("click", () => { hideCtxMenu(); item.fn(); });
  });
  // Position — keep inside viewport
  menu.style.display = "block";
  const vw = window.innerWidth, vh = window.innerHeight;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = (x + mw > vw ? x - mw : x) + "px";
  menu.style.top  = (y + mh > vh ? y - mh : y) + "px";
}

function hideCtxMenu() {
  if (_ctxMenu) _ctxMenu.style.display = "none";
}

const LAYOUT_KEY   = "boltarr:layout";
const VIEWPORT_KEY = "boltarr:viewport";

let _vpTimer = null;
function saveViewportLocally() {
  localStorage.setItem(VIEWPORT_KEY, JSON.stringify({ pan: cy.pan(), zoom: cy.zoom() }));
}
function _scheduleVpSave() {
  clearTimeout(_vpTimer);
  _vpTimer = setTimeout(saveViewportLocally, 250);
}

function saveLayoutLocally() {
  const positions = {};
  cy.nodes().forEach(n => { positions[n.id()] = n.position(); });
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(positions));
  saveViewportLocally();
}

function restoreViewport() {
  try {
    const vp = JSON.parse(localStorage.getItem(VIEWPORT_KEY) || "null");
    if (vp && vp.pan && vp.zoom) {
      cy.zoom(vp.zoom);
      cy.pan(vp.pan);
    }
  } catch {}
}

function restoreLayout(dbNodes) {
  try {
    const local = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
    if (Object.keys(local).length > 0) {
      cy.nodes().forEach(n => { if (local[n.id()]) n.position(local[n.id()]); });
      restoreViewport();
      return true;
    }
    // Fall back to DB positions
    const dbPos = {};
    (dbNodes || []).forEach(n => {
      if (n.data.pos_x != null && n.data.pos_y != null)
        dbPos[n.data.id] = { x: n.data.pos_x, y: n.data.pos_y };
    });
    if (Object.keys(dbPos).length > 0) {
      cy.nodes().forEach(n => { if (dbPos[n.id()]) n.position(dbPos[n.id()]); });
      restoreViewport();
      return true;
    }
    return false;
  } catch { return false; }
}

async function saveLayoutToDb() {
  const positions = {};
  cy.nodes().forEach(n => { positions[n.id()] = n.position(); });
  const btn = document.getElementById("saveLayoutBtn");
  try {
    btn.disabled = true;
    btn.textContent = "Saving…";
    await fetch("/api/layout", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positions }),
    });
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(positions));
    saveViewportLocally();
    btn.textContent = "✓ Saved";
    setTimeout(() => { btn.textContent = "⊙ Save Layout"; btn.disabled = false; }, 1800);
  } catch (e) {
    btn.textContent = "Error";
    btn.disabled = false;
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderGraph(nodes, edges) {
  if (!cy) initGraph();

  const incomingNodes = new Set(nodes.map(n => n.data.id));
  const incomingEdges = new Set((edges||[]).map(e => e.data.id));

  // Purge all overlay edges first; applyEdgeVlanStyle recreates them
  cy.edges("[overlay_conn]").remove();

  cy.nodes().forEach(n => { if (!incomingNodes.has(n.id())) cy.remove(n); });
  cy.edges().forEach(e => { if (!incomingEdges.has(e.id())) cy.remove(e); });

  const wasEmpty = cy.nodes().length === 0 && nodes.length > 0;

  nodes.forEach(n => {
    const ex = cy.getElementById(n.data.id);
    if (ex.length) ex.data(n.data);
    else cy.add({ group: "nodes", data: n.data });
  });

  (edges||[]).forEach(e => {
    const ex = cy.getElementById(e.data.id);
    if (ex.length) {
      ex.data(e.data);
      applyEdgeVlanStyle(ex);
    } else {
      cy.add({ group: "edges", data: e.data });
      applyEdgeVlanStyle(cy.getElementById(e.data.id));
    }
  });

  if (wasEmpty) {
    const hadSaved = restoreLayout(nodes);
    if (!hadSaved) {
      cy.layout({
        name:             "cose",
        animate:          true,
        animationDuration: 700,
        nodeRepulsion:    () => 12000,
        idealEdgeLength:  () => 130,
        padding:          60,
      }).run();
    }
  }

  cy.off("dragfree").on("dragfree", "node", saveLayoutLocally);
  cy.off("viewport").on("viewport", _scheduleVpSave);

  applySubnetVisibility();
}

function selectNodesInSubnet(subnetId) {
  const s = (window.subnets||[]).find(s => s.id === subnetId);
  if (!s) return;
  cy.$(':selected').unselect();
  cy.nodes().forEach(n => {
    if (!n.data("ip").startsWith("node-") && ipInCidr(n.data("ip"), s.cidr)) n.select();
  });
}

function selectUnassignedNodes() {
  cy.$(':selected').unselect();
  cy.nodes().forEach(n => {
    const ip = n.data("ip");
    if (ip.startsWith("node-")) return;
    if (nodeSubnetId(ip) === null) n.select();
  });
}
