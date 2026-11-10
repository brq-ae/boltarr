// Boltarr — Hosts tab: table, inline editors, columns, links helpers, IP History.
// Part of the app split from app.js (F-08); files share globals and load in order (see index.html).

// ── Hosts table ───────────────────────────────────────────────────────────────

async function loadHosts() {
  allHosts = await api("GET", "/api/hosts");
  loadDhcpPoolWarnings();
}

// DHCP pools that are almost full: a warning chip on the Hosts toolbar.
async function loadDhcpPoolWarnings() {
  const el = document.getElementById("dhcpPoolWarn");
  if (!el) return;
  let pools = [];
  try { pools = (await api("GET", "/api/dhcp-warnings")).pools || []; } catch (e) {}
  el.hidden = !pools.length;
  el.textContent = pools.length === 1 ? `⚠ DHCP pool ${pools[0].pct}% full` : `⚠ ${pools.length} DHCP pools almost full`;
  el.title = pools.map(p => p.text).join("\n");
}

function escHtml(s) {
  return (s == null ? "" : String(s)).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// A value passed as a JS string argument inside an inline on*="…" handler.
// JSON-quote it (JS context) then HTML-escape it (attribute context).
function jsq(s) { return escHtml(JSON.stringify(s == null ? "" : String(s))); }
// Only http(s) links may be clickable — blocks javascript:/data: URLs.
function safeUrl(u) { return /^https?:\/\//i.test(String(u || "").trim()) ? escHtml(String(u).trim()) : "#"; }
function noteIsUrl(s) { return /^https?:\/\/\S+$/i.test((s || "").trim()); }

// hover-✎ that opens the inline editor for a field on this host
function editPencil(ip, field, label) {
  return `<button class="cell-edit" title="Edit ${escHtml(label)}" onclick="event.stopPropagation();editField(${jsq(ip)},${jsq(field)},this.closest('td'))">✎</button>`;
}

// scan/text cell: escaped value (or —) + hover pencil
function textCell(h, field, raw) {
  const val = raw ? escHtml(raw) : `<span style="color:var(--text-3)">—</span>`;
  return `${val}${editPencil(h.ip, field, field)}`;
}

// notes cell: link/text + pencil, or a ＋ note affordance when empty
function renderNoteCell(h) {
  const raw = h.notes || "";
  if (!raw) {
    return `<span class="note-add" onclick="event.stopPropagation();editField(${jsq(h.ip)},'notes',this.closest('td'))">＋ note</span>`;
  }
  const full = escHtml(raw);
  const trunc = escHtml(raw.length > 42 ? raw.slice(0, 42) + "…" : raw);
  const inner = noteIsUrl(raw)
    ? `<a class="note-link" href="${safeUrl(raw)}" target="_blank" rel="noopener" title="${full}" onclick="event.stopPropagation()">${trunc}</a>`
    : `<span class="note-text" title="${full}">${trunc}</span>`;
  return inner + editPencil(h.ip, "notes", "note");
}

// generic inline editor — swaps the cell for a text input
function editField(ip, field, td) {
  const h = allHosts.find(x => x.ip === ip);
  const inp = document.createElement("input");
  inp.type = "text"; inp.className = "cell-input"; inp.maxLength = 200;
  inp.value = (h && h[field]) || "";
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    if (save) saveField(ip, field, inp.value.trim()); else renderHostsTable();
  };
  inp.addEventListener("click", e => e.stopPropagation());
  inp.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  inp.addEventListener("blur", () => finish(true));
  td.innerHTML = "";
  td.appendChild(inp);
  inp.focus(); inp.select();
}

async function saveField(ip, field, value) {
  const h = allHosts.find(x => x.ip === ip);
  const prev = h ? h[field] : null;
  if (h) h[field] = value;             // optimistic ('' shows as —)
  renderHostsTable();
  const payload = { [field]: value };   // the server changes only the fields sent
  try {
    await api("PUT", `/api/hosts/${ip}`, payload);
  } catch (e) {
    if (h) h[field] = prev;            // revert on failure
    await loadHosts(); renderHostsTable();
  }
}

// ── Phase D: inline editors for structured fields (type, class, MAC) ─────────
function typePencil(ip) {
  return `<button class="cell-edit" title="Edit type" onclick="event.stopPropagation();editType(${jsq(ip)},this.closest('td'))">✎</button>`;
}
function macPencil(ip) {
  return `<button class="cell-edit" title="Edit MAC" onclick="event.stopPropagation();editMac(${jsq(ip)},this.closest('td'))">✎</button>`;
}

function editType(ip, td) {
  const h = allHosts.find(x => x.ip === ip);
  const wrap = document.createElement("div");
  wrap.className = "type-edit";
  const dsel = document.createElement("select");
  dsel.className = "cell-select";
  dsel.innerHTML = DEVICE_TYPES.map(t => `<option value="${t}">${t}</option>`).join("");
  dsel.value = (h && h.device_type) || "unknown";
  const csel = document.createElement("select");
  csel.className = "cell-select";
  csel.innerHTML = '<option value="">Auto</option><option value="static">Static</option><option value="dynamic">Dynamic</option>';
  csel.value = (h && h.static_override) || "";
  const commit = () => saveType(ip, dsel.value, csel.value);
  dsel.addEventListener("change", commit);
  csel.addEventListener("change", commit);
  wrap.addEventListener("click", e => e.stopPropagation());
  wrap.appendChild(dsel); wrap.appendChild(csel);
  td.innerHTML = ""; td.appendChild(wrap);
  const away = (e) => {
    if (!wrap.contains(e.target)) { document.removeEventListener("click", away, true); renderHostsTable(); }
  };
  setTimeout(() => document.addEventListener("click", away, true), 0);
  dsel.focus();
}

async function saveType(ip, deviceType, override) {
  const h = allHosts.find(x => x.ip === ip);
  if (h) { h.device_type = deviceType; h.static_override = override || null; }
  renderHostsTable();
  const payload = {
    device_type: deviceType,
    set_static_override: true,
    static_override: override || null,
  };
  try { await api("PUT", `/api/hosts/${ip}`, payload); } catch (e) { /* reload below */ }
  await loadHosts(); renderHostsTable();   // refresh recomputed classification badge
}

function editMac(ip, td) {
  const h = allHosts.find(x => x.ip === ip);
  const inp = document.createElement("input");
  inp.type = "text"; inp.className = "cell-input"; inp.maxLength = 17;
  inp.value = (h && h.mac) || "";
  inp.placeholder = "aa:bb:cc:dd:ee:ff";
  const macRe = /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/;
  let done = false;
  const commit = (strict) => {
    if (done) return;
    const v = inp.value.trim();
    if (v === "") { done = true; renderHostsTable(); return; }   // empty = cancel (endpoint can't clear MAC)
    if (!macRe.test(v)) {
      if (strict) { inp.classList.add("invalid"); inp.focus(); return; }  // Enter on invalid → keep editing
      done = true; renderHostsTable(); return;                            // blur on invalid → cancel
    }
    done = true; saveField(ip, "mac", v.toLowerCase());
  };
  inp.addEventListener("click", e => e.stopPropagation());
  inp.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); commit(true); }
    else if (e.key === "Escape") { e.preventDefault(); done = true; renderHostsTable(); }
  });
  inp.addEventListener("blur", () => commit(false));
  td.innerHTML = ""; td.appendChild(inp);
  inp.focus(); inp.select();
}

// ── Hosts column show/hide (persisted per browser) ───────────────────────────
const HOST_COLS = ["host", "mac", "vendor", "type", "os", "ports", "seen", "notes"];
function getHiddenCols() {
  try { return JSON.parse(localStorage.getItem("boltarr.hostsHiddenCols") || "[]"); }
  catch (e) { return []; }
}
function applyHiddenCols() {
  const t = document.getElementById("hostsTable");
  if (!t) return;
  const hidden = getHiddenCols();
  HOST_COLS.forEach(c => t.classList.toggle("hide-" + c, hidden.includes(c)));
}
function setColumn(key, visible) {
  let hidden = getHiddenCols();
  if (visible) hidden = hidden.filter(k => k !== key);
  else if (!hidden.includes(key)) hidden.push(key);
  localStorage.setItem("boltarr.hostsHiddenCols", JSON.stringify(hidden));
  applyHiddenCols();
}
function initColumnMenu() {
  const btn = document.getElementById("colMenuBtn");
  const menu = document.getElementById("colMenu");
  if (!btn || !menu) return;
  const hidden = getHiddenCols();
  menu.querySelectorAll("input[data-col]").forEach(cb => {
    cb.checked = !hidden.includes(cb.getAttribute("data-col"));
    cb.addEventListener("change", () => setColumn(cb.getAttribute("data-col"), cb.checked));
  });
  btn.addEventListener("click", e => { e.stopPropagation(); menu.classList.toggle("open"); });
  document.addEventListener("click", e => {
    if (!menu.contains(e.target) && e.target !== btn) menu.classList.remove("open");
  });
  applyHiddenCols();
}
document.addEventListener("DOMContentLoaded", initColumnMenu);

// Search text against a host / a service. Shared by the table filters and the
// top-bar search, so "+N more" there opens the same matches here. A MAC can be
// typed with any separators (aabbcc, aa-bb-cc, aa:bb:cc).
const _hexOnly = v => String(v || "").toLowerCase().replace(/[^0-9a-f]/g, "");
function hostMatches(h, q) {
  q = q.toLowerCase();
  const qHex = _hexOnly(q);
  return (h.ip || "").includes(q) ||
    (h.aliases || []).some(a => a.includes(q)) ||
    ["hostname", "vendor", "device_type", "os_guess", "notes", "mac"].some(k => (h[k] || "").toLowerCase().includes(q)) ||
    (qHex.length >= 4 && /^[0-9a-f:.\-\s]+$/.test(q) && _hexOnly(h.mac).includes(qHex)) ||
    (h.ports || []).some(p => p.state === "open" && (p.service || "").toLowerCase().includes(q));
}
function svcMatches(s, q) {
  q = q.toLowerCase();
  return ["name", "description", "hostname", "url", "public_name"].some(k => (s[k] || "").toLowerCase().includes(q)) ||
    (s.ip || "").includes(q) || String(s.port || "") === q || String(s.port || "").startsWith(q);
}

// The hosts the table shows (search + IP filter, in the current sort order).
// Export uses the same list, so a download matches the screen.
function hostsVisibleRows() {
  let visible = allHosts;
  if (filterText) visible = visible.filter(h => hostMatches(h, filterText));
  if (classFilterVal) {
    visible = classFilterVal === "unknown"
      ? visible.filter(h => (h.classification || "unknown") === "unknown")
      : classFilterVal === "dhcpwarn"
      ? visible.filter(h => (h.dhcp_warnings || []).length)
      : visible.filter(h => h.classification === classFilterVal);
  }
  return [...visible].sort((a, b) => {
    let va = a[sortCol] ?? "", vb = b[sortCol] ?? "";
    if (sortCol === "ip") { va = ipToNum(va); vb = ipToNum(vb); }
    if (sortCol === "open_ports") {
      va = (a.ports||[]).filter(p => p.state === "open").length;
      vb = (b.ports||[]).filter(p => p.state === "open").length;
    }
    return va < vb ? -sortDir : va > vb ? sortDir : 0;
  });
}

function renderHostsTable() {
  const tbody = document.querySelector("#hostsTable tbody");
  tbody.innerHTML = "";
  const sorted = hostsVisibleRows();

  const count = document.getElementById("hostCount");
  if (count) count.textContent = `${sorted.length} of ${allHosts.length}`;

  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--text-3);font-size:12px">${filterText ? "No matches." : "No hosts yet — add a subnet and scan."}</td></tr>`;
    return;
  }

  sorted.forEach(h => {
    const openPorts = (h.ports||[]).filter(p => p.state === "open");
    const portHtml = openPorts.slice(0,5).map(p =>
      `<span class="port-badge${p.manual ? ' manual' : ''}">${escHtml(p.port)}/${escHtml(p.service||"?")}</span>`
    ).join("");
    const more = openPorts.length > 5 ? `<span class="port-badge">+${openPorts.length-5}</span>` : "";
    const dt = h.device_type || "unknown";

    const isSynthetic = h.ip.startsWith("node-");
    const aliases     = h.aliases || [];
    const expanded    = expandedAliases.has(h.ip);
    const aliasToggle = aliases.length
      ? `<button class="alias-toggle${expanded ? " open" : ""}" onclick="event.stopPropagation();toggleAliasRow(${jsq(h.ip)})" title="${expanded ? "Hide" : "Show"} aliases">${expanded ? "▼" : "▶"} +${aliases.length}</button>`
      : "";
    const manualBadge = h.source === "manual" ? `<span class="port-badge" style="margin-left:4px;background:oklch(38% 0.1 280);color:oklch(78% 0.1 280)">manual</span>` : "";
    const ov = h.static_override ? " ·set" : "";
    const clsBadge = h.classification === "static"
      ? `<span class="cls-badge cls-static" title="Static IP${ov}">static</span>`
      : h.classification === "dynamic"
      ? `<span class="cls-badge cls-dynamic" title="Dynamic — in DHCP range${ov}">dynamic</span>`
      : "";
    const dhcpWarn = (h.dhcp_warnings || []).length
      ? `<span class="dhcp-warn" title="${escHtml(h.dhcp_warnings.map(w => w.text).join("\n"))}">⚠</span>` : "";
    const displayIp   = isSynthetic ? `<span style="color:var(--text-3)">—</span>` : escHtml(h.ip);
    const dot = isSynthetic ? "" : livenessDot(h.online);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="td-check"><input type="checkbox" class="host-checkbox" data-ip="${escHtml(h.ip)}" style="accent-color:var(--accent)" onclick="event.stopPropagation()" onchange="hostsUpdateBulkBtn()"></td>
      <td class="td-ip mono" style="color:var(--accent)">${dot}${displayIp}${aliasToggle}</td>
      <td class="td-host col-host">${textCell(h, 'hostname', h.hostname)}</td>
      <td class="col-mac mono" style="color:var(--text-3)">${h.mac ? escHtml(h.mac) : '<span style="color:var(--text-3)">—</span>'}${macPencil(h.ip)}</td>
      <td class="col-vendor" style="color:var(--text-2);font-size:11px">${textCell(h, 'vendor', h.vendor)}</td>
      <td class="td-type col-type"><span class="tag tag-${escHtml(dt)}">${escHtml(dt)}</span>${manualBadge}${clsBadge}${dhcpWarn}${typePencil(h.ip)}</td>
      <td class="col-os" style="font-size:11px;color:var(--text-3)">${textCell(h, 'os_guess', (h.os_guess||"").substring(0,34))}</td>
      <td class="col-ports"><div class="port-list">${portHtml}${more}</div></td>
      <td class="td-seen col-seen mono" style="color:var(--text-3)">${escHtml((h.last_seen||"—").substring(0,16))}</td>
      <td class="col-notes">${renderNoteCell(h)}</td>
    `;
    tr.addEventListener("click", () => showHostDetail(h.ip));
    tbody.appendChild(tr);
    if (aliases.length && expanded) {
      const subTr = document.createElement("tr");
      subTr.className = "alias-sub-row";
      subTr.innerHTML = `<td colspan="10" class="alias-sub-cell">
        <div class="alias-chips-row">
          <span style="font-size:10px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-right:4px">Aliases</span>
          ${aliases.map(a => `<span class="alias-chip-inline mono" title="${escHtml(aliasSeenTitle(h, a))}">${aliasDot(h, a)}${escHtml(a)}</span>`).join("")}
        </div>
      </td>`;
      tbody.appendChild(subTr);
    }
  });
  hostsUpdateBulkBtn();   // re-render clears selection → sync the toolbar button
}

function hostsToggleAll(checked) {
  document.querySelectorAll(".host-checkbox").forEach(cb => cb.checked = checked);
  hostsUpdateBulkBtn();
}

function hostsUpdateBulkBtn() {
  const boxes = document.querySelectorAll(".host-checkbox");
  const checked = document.querySelectorAll(".host-checkbox:checked").length;
  const btn = document.getElementById("hostsDeleteBtn");
  if (btn) btn.style.display = checked ? "" : "none";
  const all = document.getElementById("hostsSelectAll");
  if (all) {
    all.checked = checked === boxes.length && boxes.length > 0;
    all.indeterminate = checked > 0 && checked < boxes.length;
  }
}

async function hostsDeleteSelected() {
  const ips = Array.from(document.querySelectorAll(".host-checkbox:checked")).map(cb => cb.dataset.ip);
  if (!ips.length) return showToast("Nothing selected");
  if (!confirm(`Delete ${ips.length} host${ips.length > 1 ? "s" : ""}? This can't be undone.`)) return;
  await api("DELETE", "/api/hosts", { ips });
  await loadHosts(); renderHostsTable(); await loadGraph();
  showToast(`Deleted ${ips.length} host${ips.length > 1 ? "s" : ""}`);
}

function livenessDot(online) {
  const s = online === 1 ? ["online",  "var(--ok, #3fb950)",  "Online"]
          : online === 0 ? ["offline", "var(--bad, #f85149)", "Offline"]
          :                ["unknown", "var(--text-3)",       "Liveness unknown"];
  return `<span class="live-dot live-${s[0]}" title="${s[2]}" style="background:${s[1]}"></span>`;
}

// Alias IPs are pinged on their own; alias_info carries each one's status.
function _aliasInfo(h, ip) { return (h.alias_info || []).find(x => x.ip === ip) || {}; }
function aliasDot(h, ip) { return livenessDot(_aliasInfo(h, ip).online ?? null); }
function aliasSeenTitle(h, ip) {
  const i = _aliasInfo(h, ip);
  const state = i.online === 1 ? "Online" : i.online === 0 ? "Offline" : "Not pinged yet";
  return i.last_seen ? `${state} · last seen ${fmtLocal(i.last_seen)}` : state;
}

function toggleAliasRow(ip) {
  if (expandedAliases.has(ip)) expandedAliases.delete(ip);
  else expandedAliases.add(ip);
  renderHostsTable();
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
  document.getElementById("classFilter")?.addEventListener("change", e => {
    classFilterVal = e.target.value;
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
    .map(h => `<option value="${escHtml(h.ip)}">${h.ip.startsWith("node-") ? "" : escHtml(h.ip) + " — "}${escHtml(h.hostname || h.device_type || "unknown")}</option>`)
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

    const speed    = e.data.speed    ? `<span class="port-badge mono">${escHtml(e.data.speed)}</span>` : "";
    const mode     = e.data.port_mode ? `<span class="port-badge">${escHtml(e.data.port_mode)}</span>` : "";
    const vlanBadges = (e.data.vlans || []).map(v =>
      `<span class="vlan-swatch-sm" style="background:${escHtml(v.color)};display:inline-block;width:8px;height:8px;border-radius:50%;vertical-align:middle"></span>`
    ).join("");

    return `<div class="link-peer-row">
      <span style="font-size:13px;font-weight:600;color:${dirColor};width:16px;flex-shrink:0">${dir}</span>
      <span class="tag tag-${escHtml(peerDt)}" style="font-size:10px;flex-shrink:0">${escHtml(peerDt)}</span>
      <span style="flex:1;font-size:12px;color:var(--text-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(peerIp)}">${escHtml(peerLabel)}${peerIp.startsWith("node-") ? "" : `<br><span class="mono" style="font-size:10px;color:var(--text-3)">${escHtml(peerIp)}</span>`}</span>
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
        <button class="btn btn-primary" style="font-size:11px" onclick="addLinkFromDetail(${jsq(ip)})">+ Connect</button>
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


// ── Hosts sub-tabs + IP History ──────────────────────────────────────────────

let currentHostsTab = "list";
let _iphData = null;
let _iphStatus = "all";              // chip filter; "all" leaves never-seen out
let _iphSort = { key: "days", dir: -1 };

function setHostsTab(tab) {
  currentHostsTab = tab;
  document.getElementById("hosts-panel-list").style.display      = tab === "list"      ? "" : "none";
  document.getElementById("hosts-panel-iphistory").style.display = tab === "iphistory" ? "" : "none";
  document.querySelectorAll("#panel-hosts .svc-subtab").forEach(b => b.classList.remove("active"));
  document.getElementById(`hostsTabBtn-${tab}`)?.classList.add("active");
  if (tab === "iphistory") loadIpHistory(true);
}

const _IPH_STATUS = {
  in_use: { label: "In use",     cls: "iph-in_use" },
  recent: { label: "Recent",     cls: "iph-recent" },
  stale:  { label: "Stale",      cls: "iph-stale"  },
  gone:   { label: "Gone",       cls: "iph-gone"   },
  never:  { label: "Never seen", cls: "iph-never"  },
};

async function loadIpHistory(refreshSubnets = false) {
  const sel = document.getElementById("iphSubnet");
  if (refreshSubnets || !sel.options.length) {
    const prev = sel.value;
    const subnets = await api("GET", "/api/subnets");
    if (!subnets.length) {
      document.getElementById("iphNote").textContent = "No subnets yet — add one in Settings → Subnets.";
      return;
    }
    sel.innerHTML = subnets.map(s =>
      `<option value="${s.id}">${escHtml(s.name || s.cidr)} · ${escHtml(s.cidr)}</option>`).join("");
    const withPool = subnets.find(s => s.dhcp_start && s.dhcp_end);
    if (prev && subnets.some(s => String(s.id) === prev)) sel.value = prev;
    else if (withPool) sel.value = withPool.id;
  }
  try {
    _iphData = await api("GET", `/api/subnets/${sel.value}/ip-history`);
  } catch (e) {
    _iphData = null;
    document.getElementById("iphChips").innerHTML = "";
    document.getElementById("iphNote").textContent = e.message;
    document.querySelector("#iphTable tbody").innerHTML = "";
    document.getElementById("iphCount").textContent = "";
    return;
  }
  renderIpHistory();
}

function setIpHistoryStatus(st) { _iphStatus = st; renderIpHistory(); }

function sortIpHistory(key) {
  _iphSort = _iphSort.key === key ? { key, dir: -_iphSort.dir } : { key, dir: key === "days" ? -1 : 1 };
  renderIpHistory();
}

function _iphDaysText(d) {
  if (d == null) return "—";
  if (d === 0) return "today";
  return d === 1 ? "1 day ago" : `${d} days ago`;
}

// The IP History rows on screen (status chip + filter box, in the current sort).
function iphVisibleRows() {
  const data = _iphData;
  if (!data) return [];
  const q = (document.getElementById("iphFilter").value || "").trim().toLowerCase();
  let rows = data.ips.filter(r => _iphStatus === "all" ? r.status !== "never" : r.status === _iphStatus);
  if (q) rows = rows.filter(r =>
    [r.ip, r.hostname, r.mac, r.vendor, r.alias_of].some(v => v && String(v).toLowerCase().includes(q)));

  const ipNum = ip => ip.split(".").reduce((a, o) => a * 256 + (+o), 0);
  const { key, dir } = _iphSort;
  rows.sort((a, b) => {
    if (key === "days") {
      const da = a.status === "never" ? -1 : (a.days ?? 0);
      const db = b.status === "never" ? -1 : (b.days ?? 0);
      if (da !== db) return (da - db) * dir;
    } else {
      return (ipNum(a.ip) - ipNum(b.ip)) * dir;
    }
    return ipNum(a.ip) - ipNum(b.ip);
  });

  return rows;
}

function renderIpHistory() {
  const data = _iphData;
  if (!data) return;
  const c = data.counts;
  const shown = c.in_use + c.recent + c.stale + c.gone;
  const chip = (st, label, n) =>
    `<button class="iph-chip ${st !== "all" ? _IPH_STATUS[st].cls : ""}${_iphStatus === st ? " active" : ""}" onclick="setIpHistoryStatus(${jsq(st)})">${escHtml(label)} <b>${n}</b></button>`;
  document.getElementById("iphChips").innerHTML =
    chip("all", "All seen", shown) +
    ["in_use", "recent", "stale", "gone", "never"].map(st => chip(st, _IPH_STATUS[st].label, c[st])).join("");

  const s = data.subnet;
  const notes = [];
  notes.push(data.has_pool
    ? `Static range = ${escHtml(s.cidr)} outside the DHCP pool ${escHtml(s.dhcp_start)}–${escHtml(s.dhcp_end)}.`
    : `No DHCP pool set for this subnet, so every IP is shown. Set the pool in Settings → Subnets to limit this to the static range.`);
  notes.push(`Stale after ${data.stale_days} days, gone after ${data.gone_days} (Settings → IP History).`);
  if (data.tracking_since) notes.push(`Tracking since ${escHtml(fmtLocal(data.tracking_since))} — "never seen" means not since then.`);
  if (_iphStatus === "all" && c.never) notes.push(`${c.never} never-seen IPs hidden — pick "Never seen" to list them.`);
  document.getElementById("iphNote").innerHTML = notes.join(" ");

  const rows = iphVisibleRows();
  document.getElementById("iphCount").textContent = `${rows.length} IP${rows.length === 1 ? "" : "s"}`;
  const tbody = document.querySelector("#iphTable tbody");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-3" style="text-align:center;padding:18px">Nothing here.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const st = _IPH_STATUS[r.status];
    const note = [];
    if (r.alias_of) note.push(`alias of ${escHtml(r.alias_of)}`);
    if (r.mac_change) note.push(`different device since ${escHtml(fmtLocal(r.mac_change.ts))}`);
    const seen = r.status === "never" ? "—"
      : r.status === "in_use" ? (r.online === 1 ? "online now" : "today")
      : `<span title="${escHtml(fmtLocal(r.last_seen))}">${_iphDaysText(r.days)}</span>`;
    return `<tr class="${r.host_ip ? "iph-row-link" : "iph-row-never"}" ${r.host_ip ? `data-host="${escHtml(r.host_ip)}"` : ""}>
      <td><span class="iph-badge ${st.cls}">${st.label}</span></td>
      <td class="td-ip">${escHtml(r.ip)}</td>
      <td>${seen}</td>
      <td>${escHtml(r.hostname || "")}</td>
      <td class="td-mac">${escHtml(r.mac || "")}</td>
      <td>${escHtml(r.vendor || "")}</td>
      <td>${r.first_seen ? escHtml(fmtLocal(r.first_seen)) : ""}</td>
      <td class="text-3">${note.join(" · ")}</td>
    </tr>`;
  }).join("");
  tbody.querySelectorAll("tr[data-host]").forEach(tr =>
    tr.addEventListener("click", () => showHostDetail(tr.dataset.host)));
}

