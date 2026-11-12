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
let activeScanSubnet = null;   // subnet whose scan was started here (Subnets page shows Stop)
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

// ── Actions ───────────────────────────────────────────────────────────────────
// Replaces inline on…= handlers (F-08 part B) so the CSP can drop 'unsafe-inline'.
// An element names an action with data-click / data-change / data-input, plus
// optional data-args (a JSON array, see dargs()). The action runs with `this` = the
// element. data-self: run only when the click lands on the element itself (modal
// backdrops). data-stop: clicks on it never reach an action on an outer element
// (a checkbox or link inside a clickable row). The nearest action wins, so a button
// inside a clickable row runs only its own. Each app file registers its own
// actions with registerActions().
const ACTIONS = Object.create(null);
function registerActions(map) { Object.assign(ACTIONS, map); }
function dargs(...a) { return escHtml(JSON.stringify(a)); }   // for data-args="…"
for (const [type, attr] of [["click", "data-click"], ["change", "data-change"], ["input", "data-input"]]) {
  document.addEventListener(type, e => {
    const el = e.target.closest && e.target.closest(`[${attr}],[data-stop]`);
    if (!el || !el.hasAttribute(attr) || (el.hasAttribute("data-self") && e.target !== el)) return;
    const fn = ACTIONS[el.getAttribute(attr)];
    if (!fn) return console.warn("Boltarr: unknown action", el.getAttribute(attr));
    if (el.tagName === "A") e.preventDefault();
    fn.apply(el, el.dataset.args ? JSON.parse(el.dataset.args) : []);
  });
}

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
  hiddenSubnets = new Set(subnets.filter(s => s.map_hidden).map(s => s.id));   // saved per subnet
  renderSubnetList();
  loadSubnetSummary();
}

function toggleSubnetVisibility(subnetId) {
  const hide = !hiddenSubnets.has(subnetId);
  if (hide) hiddenSubnets.add(subnetId); else hiddenSubnets.delete(subnetId);
  renderSubnetList();
  if (typeof applySubnetVisibility === "function") applySubnetVisibility();
  api("PUT", `/api/subnets/${subnetId}`, { map_hidden: hide }).catch(() => {});   // remembered after a reload
}

async function deleteSubnet(id, name) {
  const n = (subnetSummary[id] || {}).schedules || 0;
  const scheds = n ? ` and its ${n} scan schedule${n === 1 ? "" : "s"}` : "";
  if (!confirm(`Delete subnet "${name}"?\n\nIts hosts stay in Boltarr. The subnet entry, its scan history${scheds} are deleted.`)) return;
  await api("DELETE", `/api/subnets/${id}`);
  subnets = subnets.filter(s => s.id !== id);
  hiddenSubnets.delete(id);
  renderSubnetList();
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
  try {
    const { run_id } = await api("POST", `/api/scan/${subnetId}`);
    activeRunId = run_id;
    activeScanSubnet = subnetId;
    renderSubnetList();           // the row's Scan turns into Stop
    startPolling(subnetId);
  } catch (e) {
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
    const prog = document.getElementById(`subnet-prog-${subnetId}`);
    if (prog) prog.textContent = job.status === "scanning" ? `${pct}%` : "";

    if (["completed", "error", "cancelled"].includes(job.status)) {
      clearInterval(pollTimer);
      activeScanSubnet = null;
      loadSubnetSummary();          // Stop turns back into Scan; last scan updates
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

// ── AI history ────────────────────────────────────────────────────────────────

// "Earlier (N) ▾" under an AI result: older saved runs (Settings → AI → AI history).
// renderItem(x) gives one entry's HTML; each entry gets a "when · model" line.
function aiEarlierHtml(items, renderItem) {
  if (!items || !items.length) return "";
  return `<details class="ai-earlier"><summary>Earlier (${items.length})</summary>${items.map(x =>
    `<div class="ai-earlier-item"><div class="analysis-meta">${escHtml(aiMeta(x))}</div>${renderItem(x)}</div>`
  ).join("")}</details>`;
}

// "12 Nov, 08:00 · qwen3:14b" for a saved AI result (created_at is UTC)
function aiMeta(x) {
  return [x.created_at ? fmtLocal(x.created_at) : "", (x.model || "").replace(":latest", "")]
    .filter(Boolean).join(" · ");
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

const TAB_TITLES = { topology: "Topology", hosts: "Hosts", subnets: "Subnets", scans: "Scans", hierarchy: "Topology", services: "Services", sshkeys: "SSH Keys", search: "Search" };
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
  if (name === "subnets")   loadSubnetSummary();
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


registerActions({
  openTopology, setTab, toggleSidebar, closeSidebar, toggleChat, toggleLegend, stopScan,
  openAddSubnet, closeAddSubnet, saveSubnet, toggleSubnetVisibility,
  openEditSubnet, triggerScan, deleteSubnet,
  printPage: () => window.print(),
});
