// Boltarr — Shared state, API wrapper, boot, sidebar, subnets, scan polling, models, tabs.
// Part of the app split from app.js (F-08); files share globals and load in order (see index.html).

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
let classFilterVal  = "";   // "" | static | dynamic | unknown
let currentScanTab  = "run";
let scanProfiles    = [];
let APP_TZ          = "";   // configured IANA timezone (empty = browser-local)
let activeDetailTab = "info";
let currentSvcTab     = "list";
let svcHostFilterVal  = "";
let svcCy             = null;
let pickedContainerIp = null;
let bulkSelectedIps   = new Map();
let svcDetailId       = null;
let svcDetailStatus   = "unknown";
let expandedAliases   = new Set();

// ── API ───────────────────────────────────────────────────────────────────────

// Every same-origin request carries X-Boltarr (the server refuses changes
// without it, which blocks forged requests from other sites), and a 401 means
// the login expired — go to the login page. Wraps window.fetch so graph.js and
// chat.js are covered too.
(() => {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, opts = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (url.origin === location.origin) {
      opts = { ...opts, headers: new Headers(opts.headers || {}) };
      opts.headers.set("X-Boltarr", "1");
    }
    const r = await realFetch(input, opts);
    if (r.status === 401 && url.origin === location.origin && url.pathname.startsWith("/api/")
        && !url.pathname.startsWith("/api/auth/")) {
      location.href = "/login.html";
    }
    return r;
  };
})();

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(apiErrorText(await r.text()));
  return r.json();
}

// FastAPI errors arrive as {"detail": "..."} or a list of field errors — show
// the readable part, not the raw JSON.
function apiErrorText(text) {
  try {
    const d = JSON.parse(text).detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d)) return d.map(x => `${(x.loc || []).slice(1).join(".")}: ${x.msg}`).join("\n");
  } catch (_) {}
  return text;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  // The AI model list can be slow (it asks the AI provider), so it loads in the
  // background instead of holding up the first screen.
  loadModels();
  await Promise.all([loadAppTz(), loadSubnets(), loadHosts(), loadServicesData(), loadVlans(), loadScanProfiles()]);
  renderHostsTable();
  await loadScans();
  setTab("topology");          // draws the graph (once)
  document.getElementById("backupForm").addEventListener("submit", doBackup);
  document.getElementById("restorePwBox").addEventListener("submit", e => {
    e.preventDefault();
    _checkRestoreFile(document.getElementById("restorePw").value);
  });
  showRestoredBanner();
  loadLoginState();
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
        <div class="subnet-name">${escHtml(s.name)}</div>
        <div class="subnet-cidr mono">${escHtml(s.cidr)}</div>
      </div>
      <button class="btn-icon subnet-eye" onclick="event.stopPropagation(); toggleSubnetVisibility(${s.id})" title="${hidden ? "Show" : "Hide"} in topology">${hidden ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>` : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`}</button>
      <button class="btn-icon" onclick="event.stopPropagation(); openEditSubnet(${s.id})" title="Edit subnet (name, DHCP range)" style="color:var(--text-3);font-size:12px;padding:2px 5px">✎</button>
      <button class="btn-scan" onclick="event.stopPropagation(); triggerScan(${s.id})" title="Scan ${escHtml(s.cidr)}">▶</button>
      <button class="btn-icon" onclick="event.stopPropagation(); deleteSubnet(${s.id},${jsq(s.name)})" title="Remove subnet" style="color:var(--text-3);font-size:13px;padding:2px 5px">✕</button>
    </div>`;
  }).join("");
}

function toggleSubnetVisibility(subnetId) {
  if (hiddenSubnets.has(subnetId)) hiddenSubnets.delete(subnetId);
  else hiddenSubnets.add(subnetId);
  renderSubnetList();
  if (typeof applySubnetVisibility === "function") applySubnetVisibility();
}

async function deleteSubnet(id, name) {
  if (!confirm(`Remove subnet "${name}"?\n\nThis will not delete any scanned hosts — only the subnet entry and its scan history.`)) return;
  await api("DELETE", `/api/subnets/${id}`);
  subnets = subnets.filter(s => s.id !== id);
  hiddenSubnets.delete(id);
  renderSubnetList();
}

function selectSubnetNodes(subnetId) {
  if (typeof selectNodesInSubnet === "function") selectNodesInSubnet(subnetId);
}

function _subnetFields(s) {
  document.getElementById("subnetEditId").value    = s ? s.id : "";
  document.getElementById("subnetName").value      = s ? (s.name || "") : "";
  document.getElementById("subnetCidr").value      = s ? (s.cidr || "") : "";
  document.getElementById("subnetDesc").value      = s ? (s.description || "") : "";
  document.getElementById("subnetDhcpStart").value = s ? (s.dhcp_start || "") : "";
  document.getElementById("subnetDhcpEnd").value   = s ? (s.dhcp_end || "") : "";
  document.getElementById("subnetModalTitle").textContent = s ? "Edit Subnet" : "Add Subnet";
  document.getElementById("subnetSaveBtn").textContent    = s ? "Save" : "Add Subnet";
}

function openAddSubnet() {
  closeSidebar();
  _subnetFields(null);
  document.getElementById("subnetModal").classList.add("open");
  setTimeout(() => document.getElementById("subnetName").focus(), 50);
}
function openEditSubnet(id) {
  const s = subnets.find(x => x.id === id);
  if (!s) return;
  closeSidebar();
  _subnetFields(s);
  document.getElementById("subnetModal").classList.add("open");
}
function closeAddSubnet() {
  document.getElementById("subnetModal").classList.remove("open");
}
async function saveSubnet() {
  const id   = document.getElementById("subnetEditId").value;
  const name = document.getElementById("subnetName").value.trim();
  const cidr = document.getElementById("subnetCidr").value.trim();
  const desc = document.getElementById("subnetDesc").value.trim();
  const dhcp_start = document.getElementById("subnetDhcpStart").value.trim();
  const dhcp_end   = document.getElementById("subnetDhcpEnd").value.trim();
  if (!name || !cidr) return alert("Name and CIDR are required.");
  if ((dhcp_start && !dhcp_end) || (!dhcp_start && dhcp_end))
    return alert("Enter both ends of the DHCP range, or leave both empty.");
  try {
    if (id) {
      await api("PUT", `/api/subnets/${id}`, { name, cidr, description: desc, dhcp_start, dhcp_end });
    } else {
      await api("POST", "/api/subnets", { name, cidr, description: desc, dhcp_start, dhcp_end });
    }
    closeAddSubnet();
    await loadSubnets();
    await loadHosts(); renderHostsTable();   // classification may have changed
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

// Options for the per-host probe profile picker (excludes discovery-only "Quick").
function _probeProfileOptions() {
  const usable = scanProfiles.filter(p => (p.options || {}).ports !== "none");
  return usable.map(p =>
    `<option value="${p.id}"${p.name === "Standard" ? " selected" : ""}>${escHtml(p.name)}</option>`
  ).join("") || `<option value="">Standard</option>`;
}

async function probeHost(ip) {
  try {
    const sel = document.getElementById("probeProfile");
    const p = scanProfiles.find(x => String(x.id) === (sel ? sel.value : ""));
    const opts = p ? (p.options || {}) : {};
    const { run_id } = await api("POST", `/api/hosts/${ip}/probe`, opts);
    activeRunId = run_id;
    showToast(`Probing ${ip}…`);
    startProbePolling(run_id, ip);
    loadScans();   // show the probe in Scan Log live (like a scan), not only when done
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


// ── Models ────────────────────────────────────────────────────────────────────

// Every model picker (chat, host Analyze, Analyze Network) starts on the
// default model from Settings → AI and can be changed per use.
let AI_MODELS = [], AI_DEFAULT_MODEL = "";

function fillModelSelect(el) {
  if (!el) return;
  el.innerHTML = "";
  AI_MODELS.forEach(m => {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m.replace(":latest","");
    opt.selected = m === AI_DEFAULT_MODEL;
    el.appendChild(opt);
  });
}

async function loadModels() {
  try {
    const { models, default: def } = await api("GET", "/api/models");
    AI_MODELS = models || [];
    AI_DEFAULT_MODEL = def || "";
    fillModelSelect(document.getElementById("chatModel"));
    const net = document.getElementById("netAnalyzeModel");
    if (net) net.innerHTML = "";     // refilled next time Analyze Network opens
  } catch (e) { console.warn("Models:", e.message); }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

const TAB_TITLES = { topology: "Topology", hosts: "Hosts", scans: "Scans", hierarchy: "Topology", services: "Services", sshkeys: "SSH Keys", search: "Search" };
// Hierarchy is a sub-tab of Topology (Graph | Hierarchy): its own panel, but the
// nav highlights Topology, and Topology reopens whichever view was used last.
const NAV_TAB = { hierarchy: "topology" };
let lastTopoView = "topology";

function openTopology() {
  setTab(lastTopoView);
}

function setTab(name) {
  if (name === "topology" || name === "hierarchy") lastTopoView = name;
  const nav = NAV_TAB[name] || name;
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".sidebar-nav-item").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".bottom-nav-btn").forEach(t => t.classList.remove("active"));

  document.getElementById("panel-" + name).classList.add("active");
  document.querySelector(`.sidebar-nav-item[data-tab="${nav}"]`)?.classList.add("active");
  document.querySelector(`.bottom-nav-btn[data-tab="${nav}"]`)?.classList.add("active");

  const title = document.getElementById("topbarTitle");
  if (title) title.textContent = TAB_TITLES[name] || name;

  closeSidebar();
  if (name === "topology")  loadGraph();
  if (name === "scans")     loadScansTab();
  if (name === "hierarchy") loadHierarchy();
  if (name === "services")  loadServicesTab();
  if (name === "sshkeys")   loadSshKeys();
  if (name === "search")    window.renderSearchPage?.();

  // Live monitor dots only need refreshing while the Services tab is open
  if (name === "services") startMonitorPolling();
  else stopMonitorPolling();
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

