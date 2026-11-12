// Boltarr — Subnets page (S-16, v0.24.0): one row per subnet with hosts, DHCP pool use,
// last scan and map visibility; Scan turns into Stop on the row while it runs.
// Part of the app split from app.js (F-08); files share globals and load in order (see index.html).

let subnetSummary = {};   // subnet id → { hosts, online, pool, last_scan, running_run_id, schedules }

async function loadSubnetSummary() {
  try {
    subnetSummary = Object.fromEntries((await api("GET", "/api/subnets/summary")).map(r => [r.id, r]));
  } catch (_) { subnetSummary = {}; }
  renderSubnetList();
}

// True while a scan of this subnet runs (started here, or by a schedule)
function _subnetScanning(id) {
  return activeScanSubnet === id || !!(subnetSummary[id] || {}).running_run_id;
}

function _poolCell(s, sum) {
  if (!s.dhcp_start || !s.dhcp_end) return `<span class="text-3">—</span>`;
  const range = `<span class="mono">${escHtml(s.dhcp_start)}–${escHtml(s.dhcp_end.split(".").pop())}</span>`;
  const p = sum && sum.pool;
  if (!p) return range;
  const cls = p.pct >= 90 ? " full" : p.pct >= 75 ? " busy" : "";
  return `${range}<div class="pool-bar${cls}" title="${p.used} of ${p.size} pool addresses seen in the last 7 days">
    <span style="width:${Math.min(100, p.pct)}%"></span></div><span class="pool-pct">${p.pct}%</span>`;
}

function _lastScanCell(sum) {
  const l = sum && sum.last_scan;
  if (!l) return `<span class="text-3">never</span>`;
  const when = escHtml(fmtLocal(l.completed_at || l.started_at));
  const what = l.status === "completed" ? `${l.hosts_found ?? 0} found`
    : l.status === "cancelled" ? "stopped" : escHtml(l.status);
  return `${when}<div class="text-3 sub-line2">${what}</div>`;
}

function renderSubnetList() {
  const tbody = document.querySelector("#subnetsTable tbody");
  if (!tbody) return;
  const count = document.getElementById("subnetCount");
  if (count) count.textContent = `${subnets.length} subnet${subnets.length === 1 ? "" : "s"}`;
  if (!subnets.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-3" style="text-align:center;padding:22px">
      No subnets yet. Click <b>+ Add subnet</b> to add your network, then Scan it.</td></tr>`;
    return;
  }
  tbody.innerHTML = subnets.map(s => {
    const sum = subnetSummary[s.id];
    const hidden = hiddenSubnets.has(s.id);
    const scanning = _subnetScanning(s.id);
    const hosts = sum ? `<button class="link-btn" data-click="showSubnetHosts" data-args="[${s.id}]" title="Show these hosts on the Hosts page">${sum.hosts}</button>
      <div class="text-3 sub-line2">${sum.online} online</div>` : `<span class="text-3">—</span>`;
    return `<tr id="subnet-tr-${s.id}" data-click="openEditSubnet" data-args="[${s.id}]" title="Click to edit">
      <td class="col-sub-name"><b>${escHtml(s.name)}</b>${s.description ? `<div class="text-3 sub-desc">${escHtml(s.description)}</div>` : ""}</td>
      <td class="col-sub-cidr mono">${escHtml(s.cidr)}</td>
      <td class="col-sub-pool">${_poolCell(s, sum)}</td>
      <td class="col-sub-hosts">${hosts}</td>
      <td class="col-sub-scan">${_lastScanCell(sum)}</td>
      <td class="col-sub-map"><button class="btn-icon sub-eye${hidden ? " off" : ""}" data-click="toggleSubnetVisibility" data-args="[${s.id}]"
        title="${hidden ? "Hidden on the map — click to show" : "Shown on the map — click to hide"}">${hidden ? "⊘" : "👁"}</button></td>
      <td class="col-sub-act">
        ${scanning
          ? `<button class="btn btn-danger sub-scan-btn" data-click="stopSubnetScan" data-args="[${s.id}]">■ Stop <span id="subnet-prog-${s.id}"></span></button>`
          : `<button class="btn sub-scan-btn" data-click="triggerScan" data-args="[${s.id}]" title="Scan ${escHtml(s.cidr)}">▶ Scan</button>`}
        <div class="svc-actions">
          <button class="svc-kebab" data-click="toggleSvcMenu" data-args="${dargs("sub" + s.id)}" title="More">⋮</button>
          <div class="svc-menu" id="svcmenu-sub${s.id}">
            <button class="svc-menu-item" data-click="subnetMenuEdit" data-args="[${s.id}]">✎ Edit</button>
            <button class="svc-menu-item" data-click="subnetMenuMap" data-args="[${s.id}]">⬡ Show on map</button>
            <button class="svc-menu-item" data-click="subnetMenuIpHistory" data-args="[${s.id}]">◷ IP History</button>
            <button class="svc-menu-item danger" data-click="subnetMenuDelete" data-args="[${s.id}]">✕ Delete subnet</button>
          </div>
        </div>
      </td>
    </tr>`;
  }).join("");
}

async function stopSubnetScan(id) {
  if (activeScanSubnet === id && activeRunId) return stopScan();
  const run = (subnetSummary[id] || {}).running_run_id;   // started by a schedule
  if (run) { try { await api("POST", `/api/scan/${run}/cancel`); } catch (_) {} }
  setTimeout(loadSubnetSummary, 1500);
}

// Hosts page, showing only this subnet's hosts
function showSubnetHosts(id) {
  hostsSubnetFilter = id;
  setTab("hosts");
  setHostsTab("list");
  renderHostsTable();
}

function subnetShowOnMap(id) {
  setTab("topology");
  setTimeout(() => { if (typeof selectNodesInSubnet === "function" && cy) selectNodesInSubnet(id); }, 300);
}

function subnetIpHistory(id) {
  setTab("hosts");
  setHostsTab("iphistory", id);
}

registerActions({
  loadSubnetSummary, stopSubnetScan, showSubnetHosts,
  subnetMenuEdit:      id => { closeSvcMenus(); openEditSubnet(id); },
  subnetMenuMap:       id => { closeSvcMenus(); subnetShowOnMap(id); },
  subnetMenuIpHistory: id => { closeSvcMenus(); subnetIpHistory(id); },
  subnetMenuDelete:    id => { closeSvcMenus(); const s = subnets.find(x => x.id === id); if (s) deleteSubnet(id, s.name); },
});
