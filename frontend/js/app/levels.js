// Boltarr — view levels (S-15): Basic / Intermediate / Advanced.
// Part of the app split from app.js (F-08); files share globals and load in order (see index.html).
//
// The level only changes what you see, never what Boltarr does. How it works:
//  - <html data-level="…"> is set early by js/level.js (from this browser's storage).
//  - An item that belongs to a higher level carries data-lvl="i" (Intermediate and up)
//    or data-lvl="a" (Advanced only); one CSS rule hides it below that level.
//  - .lvl-inuse on an item keeps it showing at every level (something you set up or
//    changed), with the small grey tag; .lvl-showall on a box shows all of it for now.
//  - .lvl-visit shows a hidden page or sub-tab for one visit, when a link or button
//    elsewhere opens it (nothing breaks just because its tab is hidden).
//  - data-more on a rare button: at Basic and Intermediate it leaves its toolbar and is
//    listed in that toolbar's ⋯ menu instead (.more-wrap, shown only below Advanced).
//  - data-needs="ai" / "sp" on a button for AI or the public status page: at Basic it
//    hides while that feature isn't set up (<html data-ai/data-sp="off">), unless it
//    holds something of yours (.lvl-inuse). Set up, it shows as usual, with no tag.
//  - Advanced shows everything, exactly as Boltarr looked before levels.

const VIEW_LEVELS = ["basic", "intermediate", "advanced"];
const LEVEL_NAMES = { basic: "Basic", intermediate: "Intermediate", advanced: "Advanced" };
const _LVL_KEY = "boltarr.viewLevel";
const _LVL_NOTE_KEY = "boltarr.levelNoteSeen";
const _READY_KEY = "boltarr.ready";
const _levelHooks = [];

function viewLevel() {
  const l = document.documentElement.getAttribute("data-level");
  return VIEW_LEVELS.includes(l) ? l : "advanced";
}

// Something that must react when the level changes (e.g. clear a filter whose box is now hidden)
function onLevelChange(fn) { _levelHooks.push(fn); }

// Is this element hidden by the level (not by anything else)?
function isLevelHidden(el) {
  const lvl = viewLevel();
  for (let n = el && el.closest("[data-lvl]"); n; n = n.parentElement && n.parentElement.closest("[data-lvl]")) {
    if (n.classList.contains("lvl-inuse") || n.classList.contains("lvl-visit") || n.closest(".lvl-showall")) continue;
    const need = n.getAttribute("data-lvl");
    if ((need === "i" && lvl === "basic") || (need === "a" && lvl !== "advanced")) return true;
  }
  const f = el && el.closest("[data-needs]");
  return !!f && lvl === "basic" && !featureReady(f.dataset.needs) && !f.classList.contains("lvl-inuse");
}

// Is a feature (ai, sp = public status page) set up? Unknown counts as yes.
function featureReady(f) { return document.documentElement.getAttribute("data-" + f) !== "off"; }

// Remembered in this browser too, so js/level.js can set it before the page draws
function setFeatureReady(f, on) {
  const was = featureReady(f);
  document.documentElement.setAttribute("data-" + f, on ? "on" : "off");
  try {
    const r = JSON.parse(localStorage.getItem(_READY_KEY) || "{}");
    r[f] = !!on; localStorage.setItem(_READY_KEY, JSON.stringify(r));
  } catch (_) {}
  if (was !== !!on) _afterLevelChange();
}

// Something an item holds of yours keeps it showing (e.g. a device's earlier AI results)
function needsInUse(el, on) { el?.closest("[data-needs]")?.classList.toggle("lvl-inuse", !!on); }

function setViewLevel(level) {
  if (!VIEW_LEVELS.includes(level)) return;
  try { localStorage.setItem(_LVL_KEY, level); } catch (_) {}
  const changed = level !== viewLevel();
  document.documentElement.setAttribute("data-level", level);
  _markLevelSwitches();
  if (!changed) return;
  document.querySelectorAll(".lvl-visit").forEach(b => b.classList.remove("lvl-visit"));   // a new level ends any visit
  _afterLevelChange();
}

// What shows has changed (a new level, or a feature was set up or turned off)
function _afterLevelChange() {
  _levelFallbacks();
  _tidySubtabBars();
  _levelHooks.forEach(fn => { try { fn(viewLevel()); } catch (e) { console.warn("Boltarr: level hook", e); } });
  window.fitColumns?.();
}

// Show the chosen level on both switches (sidebar + Settings → General)
function _markLevelSwitches() {
  const lvl = viewLevel();
  document.querySelectorAll("[data-level-pick]").forEach(b => {
    const on = b.getAttribute("data-level-pick") === lvl;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

// No dead ends: if the page or a sub-tab you're on is now hidden, move to one that shows
function _levelFallbacks() {
  const nav = document.querySelector(".sidebar-nav-item.active");
  if (nav && isLevelHidden(nav)) setTab("topology");
  document.querySelectorAll(".svc-subtabs").forEach(bar => {
    const on = bar.querySelector(".svc-subtab.active");
    if (!on || !isLevelHidden(on)) return;
    const to = [...bar.querySelectorAll(".svc-subtab")].find(b => !isLevelHidden(b));
    // a bar on a page you're not on may tidy itself, but never take you to another page
    // (Hierarchy's own bar has a Graph tab that opens Topology)
    if (to && to.dataset.click === "setTab" && bar.closest(".tab-panel:not(.active)")) return;
    to?.click();
  });
}

// A sub-tab bar left with one tab is hidden (a lone tab does nothing), and so is a
// toolbar left with nothing in it.
function _tidySubtabBars() {
  document.querySelectorAll(".svc-subtabs").forEach(bar => {
    const shown = [...bar.querySelectorAll(".svc-subtab")].filter(b => !isLevelHidden(b)).length;
    bar.classList.toggle("lvl-onetab", shown < 2);
    const tb = bar.closest(".svc-toolbar");
    if (tb) tb.classList.toggle("lvl-emptybar", [...tb.children].every(c => c.classList.contains("lvl-onetab")));
  });
}

// A page or sub-tab you open from elsewhere (a link, the AI, search) shows for that visit
// even if your level hides it; picking another tab in the same bar ends the visit.
function levelVisit(el) {
  if (!el) return;
  el.parentElement?.querySelectorAll(":scope > .lvl-visit").forEach(b => b.classList.remove("lvl-visit"));
  if (isLevelHidden(el)) el.classList.add("lvl-visit");
  _tidySubtabBars();
}

// "In use": something you've set up keeps its page or tab showing below its level,
// with the small grey tag naming the level it belongs to. `from` is the lowest level
// it shows at once in use ("basic" for most; IP History only from Intermediate).
const _IN_USE = {
  sshkeys:   { sel: '.sidebar-nav-item[data-tab="sshkeys"]', from: "basic" },        // a key exists
  schedules: { sel: "#scanTabBtn-schedules",                 from: "basic" },        // a schedule exists
  deps:      { sel: "#svcTabBtn-topology",                   from: "basic" },        // a dependency exists
  dhcp:      { sel: "#hostsTabBtn-iphistory, #setIphCard",   from: "intermediate" }, // a subnet has a DHCP range
  vlans:     { sel: "#vlanBtn",                              from: "basic" },        // a VLAN exists
  maint:     { sel: "#svcMaintBtn",                          from: "basic" },        // a maintenance window is planned or running
  proxy:     { sel: "#loginProxyPart",                       from: "basic" },        // a login service in front is trusted
  frames:    { sel: "#setSecuritySection",                   from: "basic" },        // a dashboard is allowed to frame Boltarr
};

function levelInUse(key, on) {
  const def = _IN_USE[key];
  if (!def) return;
  document.querySelectorAll(def.sel).forEach(el => {
    const own = el.dataset.lvlOwn || (el.dataset.lvlOwn = el.getAttribute("data-lvl"));
    if (def.from === "basic") el.classList.toggle("lvl-inuse", !!on);
    else el.setAttribute("data-lvl", on ? "i" : own);
    // a Settings card or part carries the tag in its heading
    const at = el.querySelector(":scope > .set-card-title, :scope > .settings-sub") || el;
    at.querySelector(":scope > .lvl-tag")?.remove();
    if (on) at.appendChild(levelTag(own));
    // you just removed the last one while looking at it: stay, as a visit
    if (!on && el.classList.contains("active") && isLevelHidden(el)) el.classList.add("lvl-visit");
  });
  _tidySubtabBars();
}

// The small grey tag on something shown because you use it
function levelTag(own) {
  const tag = document.createElement("span");
  tag.className = "lvl-tag";
  tag.dataset.tagFor = own;
  tag.textContent = own === "a" ? LEVEL_NAMES.advanced : LEVEL_NAMES.intermediate;
  tag.title = "Shown because you use it. It belongs to the " + tag.textContent + " level.";
  return tag;
}

// SSH keys and schedules aren't loaded until you open their page, so ask once at start
async function _loadLevelInUse() {
  try { levelInUse("sshkeys",   (await api("GET", "/api/ssh-keys")).length > 0); } catch (_) {}
  try { levelInUse("schedules", (await api("GET", "/api/scan-schedules")).length > 0); } catch (_) {}
  try { levelInUse("maint", ((await api("GET", "/api/maintenance-windows")).windows || []).some(w => w.state !== "done")); } catch (_) {}
}

// Table columns per level. The level only sets defaults: a column you tick or untick
// in Columns ▾ keeps your choice at every level. Unticks live in the old hidden list
// (so Advanced is exactly as before); ticks that go against the level live in a
// "shown" list. A column the level hides is listed under a heading in Columns ▾.
const _LEVEL_COLS = {
  hostsTable: {
    hiddenKey: "boltarr.hostsHiddenCols", shownKey: "boltarr.hostsShownCols", menu: "colMenu",
    basic: ["mac", "os", "ports", "notes"],
    inUse: { notes: () => (typeof allHosts !== "undefined" ? allHosts : []).some(h => (h.notes || "").trim()) },
  },
  servicesTable: {
    hiddenKey: "boltarr.svcHiddenCols", shownKey: "boltarr.svcShownCols", menu: "svcColMenu",
    basic: ["desc", "pub"],
    inUse: { desc: () => (typeof allServices !== "undefined" ? allServices : []).some(s => (s.description || "").trim()),
             pub:  () => (typeof allServices !== "undefined" ? allServices : []).some(s => s.public) },
    ready: { pub: "sp" },   // shown as usual (no tag) once the status page is on
  },
};
const _colList = k => { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch (_) { return []; } };
const _colSave = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

const _colReady = (c, k) => !!(c.ready && c.ready[k] && featureReady(c.ready[k]));
// Columns the level hides right now (before your own choices); ones holding data you set show
function levelHiddenCols(table) {
  const c = _LEVEL_COLS[table];
  if (!c || viewLevel() !== "basic") return [];
  return c.basic.filter(k => !_colReady(c, k) && !(c.inUse[k] && c.inUse[k]()));
}

// The columns hidden in the end: your unticks, plus the level's defaults you didn't tick
function hiddenColsFor(table) {
  const c = _LEVEL_COLS[table];
  const shown = _colList(c.shownKey), hidden = _colList(c.hiddenKey);
  return [...new Set([...hidden, ...levelHiddenCols(table).filter(k => !shown.includes(k))])];
}

function chooseColumn(table, key, visible) {
  const c = _LEVEL_COLS[table];
  let hidden = _colList(c.hiddenKey), shown = _colList(c.shownKey);
  if (visible) {
    hidden = hidden.filter(k => k !== key);
    if (levelHiddenCols(table).includes(key) && !shown.includes(key)) shown.push(key);
  } else {
    if (!hidden.includes(key)) hidden.push(key);
    shown = shown.filter(k => k !== key);
  }
  _colSave(c.hiddenKey, hidden); _colSave(c.shownKey, shown);
}

// Columns ▾ follows: ticks match what shows; the level's hidden ones sit under a
// heading; a Basic column shown only because it holds your data gets the grey tag.
function syncLevelColMenu(table) {
  const c = _LEVEL_COLS[table], menu = document.getElementById(c.menu);
  if (!menu) return;
  const hidden = hiddenColsFor(table), byLevel = levelHiddenCols(table);
  const labels = [...menu.querySelectorAll(":scope > label")];
  labels.forEach((l, i) => { if (l.dataset.i === undefined) l.dataset.i = i; });
  labels.sort((a, b) => a.dataset.i - b.dataset.i);
  let head = menu.querySelector(":scope > .col-menu-head");
  if (!head) {
    head = document.createElement("div");
    head.className = "col-menu-head";
    head.textContent = "More at " + LEVEL_NAMES.intermediate;
  }
  const main = labels.filter(l => !byLevel.includes(l.querySelector("input").dataset.col));
  const more = labels.filter(l => byLevel.includes(l.querySelector("input").dataset.col));
  [...main, ...(more.length ? [head] : []), ...more].forEach(n => menu.appendChild(n));
  if (!more.length) head.remove();
  labels.forEach(l => {
    const k = l.querySelector("input").dataset.col;
    l.querySelector("input").checked = !hidden.includes(k);
    l.querySelector(":scope > .lvl-tag")?.remove();
    const inUse = viewLevel() === "basic" && c.basic.includes(k) && !byLevel.includes(k) && !_colReady(c, k);
    if (inUse) {
      const tag = document.createElement("span");
      tag.className = "lvl-tag"; tag.dataset.tagFor = "i";
      tag.textContent = LEVEL_NAMES.intermediate;
      tag.title = "Shown because you use it. It belongs to the " + LEVEL_NAMES.intermediate + " level.";
      l.querySelector("input").nextSibling.after(tag);
    }
  });
}
onLevelChange(() => { window.applyHiddenCols?.(); window.applySvcHiddenCols?.(); });

// Long forms: a field marked data-fold="i" (shown from Intermediate) or "a" (Advanced)
// moves into a "More options ▸" fold at the bottom of its form below that level, and
// goes back to its own place at a level that shows it. The fold opens by itself when
// a field in it is already set (not its default), so nothing you set up is out of sight.
// Called by each window's open function, after it has filled the fields.
const _foldHome = new WeakMap();
function levelFoldForm(form) {
  if (!form) return;
  const lvl = viewLevel();
  const fold = form.querySelector(":scope > .lvl-fold") || _makeFold(form);
  const body = fold.querySelector(".lvl-fold-body");
  form.querySelectorAll("[data-fold]").forEach(el => {
    if (!_foldHome.has(el)) { const home = document.createComment("fold"); el.before(home); _foldHome.set(el, home); }
    const need = el.getAttribute("data-fold");
    const folded = (need === "i" && lvl === "basic") || (need === "a" && lvl !== "advanced");
    if (folded) body.appendChild(el);
    else _foldHome.get(el).after(el);
  });
  fold.hidden = !body.children.length;
  _setFold(fold, fold.dataset.keepOpen === "1" || [...body.children].some(_foldIsSet));   // keepOpen: opened from search
}

function _makeFold(form) {
  const fold = document.createElement("div");
  fold.className = "lvl-fold";
  fold.innerHTML = `<button type="button" class="lvl-fold-btn" aria-expanded="false">More options</button><div class="lvl-fold-body" hidden></div>`;
  fold.querySelector("button").addEventListener("click", () => _setFold(fold, fold.querySelector(".lvl-fold-body").hidden));
  form.insertBefore(fold, [...form.children].filter(c => c.classList.contains("modal-actions")).pop() || null);
  return fold;
}

function _setFold(fold, open) {
  fold.querySelector(".lvl-fold-body").hidden = !open;
  fold.querySelector("button").setAttribute("aria-expanded", open ? "true" : "false");
}

// Is a field in this row set to something other than its default?
function _foldIsSet(row) {
  return [...row.querySelectorAll("input, select, textarea")].some(f => {
    if (f.closest("[data-fold-ignore]")) return false;
    const def = f.dataset.foldDefault;   // the app's own default, where the page's differs
    if (def !== undefined) return f.type === "checkbox" ? f.checked !== (def === "1") : f.value.trim() !== def;
    if (f.type === "checkbox" || f.type === "radio") return f.checked !== f.defaultChecked;
    if (f.tagName === "SELECT") {
      const def = [...f.options].find(o => o.defaultSelected) || f.options[0];
      return !!def && f.value !== def.value;
    }
    return f.value.trim() !== f.defaultValue.trim();
  });
}
onLevelChange(() => document.querySelectorAll("[data-fold-form]").forEach(levelFoldForm));

// ⋯ menu: lists the rare buttons (data-more) of its own toolbar; each entry clicks the
// real button, so it works exactly the same. An Export ▾ is listed as its two formats.
function toggleMoreMenu() {
  const wrap = this.closest(".more-wrap"), menu = wrap.querySelector(".col-menu");
  const opening = !menu.classList.contains("open");
  _closeMoreMenus();
  if (!opening) return;
  menu.innerHTML = "";
  wrap.parentElement.querySelectorAll(":scope > [data-more]").forEach(src => {
    if (isLevelHidden(src) || src.style.display === "none") return;
    const items = src.matches(".export-wrap")
      ? [...src.querySelectorAll("[data-export]")].map(b => [b, "⤓ Export " + b.dataset.fmt.toUpperCase()])
      : [[src, src.dataset.more || src.textContent.trim()]];
    items.forEach(([real, label]) => {
      const it = document.createElement("button");
      it.type = "button";
      it.textContent = label;
      if (real.classList.contains("btn-danger")) it.classList.add("more-danger");
      it.addEventListener("click", () => { _closeMoreMenus(); real.click(); });
      menu.appendChild(it);
    });
  });
  menu.classList.add("open");
}

function _closeMoreMenus() {
  document.querySelectorAll(".more-wrap .col-menu.open").forEach(m => m.classList.remove("open"));
}
document.addEventListener("click", e => { if (!e.target.closest?.(".more-wrap")) _closeMoreMenus(); });

// A browser with no level of its own asks the server which one to start on (decided
// once per install: upgrades start on Advanced, new installs on Basic).
async function initViewLevel() {
  _markLevelSwitches();
  _tidySubtabBars();
  _loadLevelInUse();
  let saved = null;
  try { saved = localStorage.getItem(_LVL_KEY); } catch (_) {}
  if (VIEW_LEVELS.includes(saved)) return;
  let start = "advanced";
  try { start = (await api("GET", "/api/ui/start-level")).level || "advanced"; } catch (_) {}
  setViewLevel(start);
  if (start === "advanced") showLevelNote();
}

// One-time note for people who already used Boltarr before levels came in
function showLevelNote() {
  try { if (localStorage.getItem(_LVL_NOTE_KEY)) return; } catch (_) {}
  if (document.querySelector(".level-banner")) return;
  const bar = document.createElement("div");
  bar.className = "restored-banner level-banner";
  bar.setAttribute("role", "status");
  bar.innerHTML = `<span>✨ New: view levels. You're on <b>Advanced</b>, so everything looks as before.
    Try <b>Basic</b> for a simpler view. Change it any time under <b>View</b> at the bottom of the side menu
    (☰ on a phone), or in Settings → General.</span>
    <button class="btn btn-primary" data-click="dismissLevelNote">Got it</button>`;
  document.body.prepend(bar);
}

function dismissLevelNote() {
  try { localStorage.setItem(_LVL_NOTE_KEY, "1"); } catch (_) {}
  document.querySelector(".level-banner")?.remove();
}

// ── Search finds what your level hides (S-15 step 9) ─────────────────────────
// Each entry: its name, other words people may type, the element your level hides
// (or `lvl` for a device panel's own buttons, which only exist while one is open),
// and how to open it. Search lists only what is hidden right now, with the grey tag;
// picking one opens it for this visit (.lvl-found), until you go to another page.
const _devIp = () => { const p = document.getElementById("hostDetail"); return p?.classList.contains("open") ? p.dataset.ip : null; };
const LEVEL_FEATURES = [
  // Pages and tabs
  { name: "SSH Keys", words: "ssh keys authorized_keys deploy", at: '.sidebar-nav-item[data-tab="sshkeys"]', go: () => setTab("sshkeys") },
  { name: "Hierarchy view", words: "tree parents children", at: "#panel-topology .topo-subtabs [data-lvl]", go: () => setTab("hierarchy") },
  { name: "IP History", words: "dhcp leases address changes", at: "#hostsTabBtn-iphistory", go: () => { setTab("hosts"); setHostsTab("iphistory"); } },
  { name: "Scan schedules", words: "scheduled scans automatic timer", at: "#scanTabBtn-schedules", go: () => { setTab("scans"); setScanTab("schedules"); } },
  { name: "Service dependencies", words: "depends on service topology map", at: "#svcTabBtn-topology", go: () => { setTab("services"); setSvcTab("topology"); } },
  // Buttons and windows
  { name: "VLANs", words: "vlan network segments", at: "#vlanBtn", go: () => { setTab("topology"); openVlanPanel(); } },
  { name: "Multi-Link", words: "link several devices connections", at: "#multiConnBtn", go: () => setTab("topology"), show: true },
  { name: "Planned maintenance", words: "maintenance window downtime", at: "#svcMaintBtn", go: () => { setTab("services"); setSvcTab("list"); openMaintModal(); } },
  { name: "Bulk add containers", words: "bulk import docker containers services", at: '[data-click="openBulkAddContainers"]', go: () => { setTab("services"); setSvcTab("list"); openBulkAddContainers(); } },
  { name: "Clear all changes", words: "delete changes history feed", at: '[data-click="clearChanges"]', go: () => { setTab("scans"); setScanTab("changes"); }, show: true },
  { name: "Delete scans from the Scan Log", words: "scan log select remove", lvl: "i", go: () => { setTab("scans"); setScanTab("history"); _found(document.getElementById("scan-panel-history"), true); } },
  // Scan options (Scans → Run)
  { name: "Scan ports", words: "ports top 1000 all ports range", at: "#scanPorts", go: () => _goScan("#scanPorts") },
  { name: "Scan options", words: "service version os detection skip discovery udp -sV -O -Pn", at: "#scanSv", go: () => _goScan("#scanSv") },
  { name: "Scan timing", words: "speed timing T4 polite aggressive", at: "#scanTiming", go: () => _goScan("#scanTiming") },
  { name: "Time limit per host", words: "scan timeout minutes", at: "#scanHostTimeout", go: () => _goScan("#scanHostTimeout") },
  { name: "NSE scripts", words: "nmap scripts", at: "#scanScripts", go: () => _goScan("#scanScripts") },
  { name: "nmap command preview", words: "command line", at: "#scanPreview", go: () => _goScan("#scanPreview") },
  { name: "Save scan as profile", words: "scan profiles presets", at: '[data-click="saveScanProfile"]', go: () => _goScan('[data-click="saveScanProfile"]') },
  // A device's panel
  { name: "Merge two devices", words: "merge combine duplicate same device", lvl: "a", dev: ip => openMergeHost(ip) },
  { name: "Probe a device", words: "probe rescan one device", lvl: "i", dev: () => { _found(document.querySelector("#hostDetail #probeProfile")); _found(document.querySelector('#hostDetail [data-click="probeHost"]')); } },
  { name: "SSH access for a device", words: "ssh access user key", lvl: "a", dev: ip => { _found(document.querySelector('#hostDetail .detail-tab[data-tab="ssh"]')); switchDetailTab("ssh"); loadHostSshSection(ip); } },
  { name: "Reset uptime", words: "uptime reset start again", lvl: "i", dev: () => _found(document.querySelector("#hostDetail .uptime-reset")) },
  // Settings
  { name: "IP History settings", words: "dhcp leases keep days", at: "#setIphCard", go: () => _goSetting("#setIphCard") },
  { name: "Login service in front", words: "proxy authelia authentik sso trusted", at: "#loginProxyPart", go: () => _goSetting("#loginProxyPart") },
  { name: "Allowed dashboards", words: "frame embed iframe homepage dashboard", at: "#setSecuritySection", go: () => _goSetting("#setSecuritySection") },
  { name: "Strict mode", words: "csp security blocked reports", at: "#cspListBtn", go: () => _goSetting("#cspListBtn") },
  { name: "Danger zone", words: "delete everything reset wipe", at: ".set-danger", go: () => _goSetting(".set-danger") },
  { name: "Alert for static or dynamic devices", words: "device alerts scope all hosts", at: "#setCaScope", go: () => _goSetting("#setCaScope") },
  { name: "Attach device MAC to alerts", words: "mac alerts roaming", at: "#setCaIncludeMac", go: () => _goSetting("#setCaIncludeMac") },
  { name: "Alerts for alias IPs", words: "extra ips alias offline online", at: "#setCaIncludeAliases", go: () => _goSetting("#setCaIncludeAliases") },
  { name: "Device up/down sweep timing", words: "liveness interval ping minutes offline after", at: "#setLvInterval", go: () => _goSetting("#setLvInterval") },
  { name: "Which changes are recorded", words: "changes history events port opened closed", at: "#setCtHostNew", go: () => _goSetting("#setCtHostNew") },
  { name: "Service check interval", words: "how often check seconds monitoring", at: "#setCheckSeconds", go: () => _goSetting("#setCheckSeconds") },
  // Not set up yet: picking one opens where it's set up
  { name: "Chat", words: "ai assistant ask", needs: "ai", at: '[data-click="toggleChat"]' },
  { name: "Analyze Network", words: "ai analysis whole network", needs: "ai", at: '[data-click="openNetworkAnalysis"]' },
  { name: "Analyze a device", words: "ai analysis device", needs: "ai", at: '[data-click="analyzeHost"]' },
  { name: "AI summary in the daily digest", words: "ai digest summary", needs: "ai", at: "#setCaDigestAi" },
  { name: "Show services publicly", words: "public status page", needs: "sp", at: "#svcModalPublic" },
];
const _NEEDS = { ai: { tab: "ai", what: "AI", tag: "Set up AI" }, sp: { tab: "statuspage", what: "the public status page", tag: "Set up status page" } };

// Hidden right now? A device-panel entry goes by its level, a "needs" one by its set-up.
function _featureHidden(f) {
  const lvl = viewLevel();
  if (f.needs) return lvl === "basic" && !featureReady(f.needs) && !document.querySelector(f.at)?.closest(".lvl-inuse");
  if (f.lvl) return (f.lvl === "i" && lvl === "basic") || (f.lvl === "a" && lvl !== "advanced");
  const el = document.querySelector(f.at);
  if (!el) return false;
  if (isLevelHidden(el)) return true;
  const fold = el.closest("[data-fold]");   // a folded setting (its fold may not be built yet)
  if (!fold) return false;
  const need = fold.getAttribute("data-fold");
  return (need === "i" && lvl === "basic") || (need === "a" && lvl !== "advanced");
}
function _featureLevel(f) {
  if (f.needs || f.lvl) return f.lvl || "";
  const el = document.querySelector(f.at);
  const m = el && (el.closest("[data-lvl]") || el.closest("[data-fold]"));
  return m ? (m.dataset.lvlOwn || m.getAttribute("data-lvl") || m.getAttribute("data-fold")) : "";
}

// Features hidden at your level that match the text (2+ letters)
function levelFeatureMatches(q) {
  q = (q || "").trim().toLowerCase();
  if (q.length < 2) return [];
  return LEVEL_FEATURES.map((f, i) => ({ ...f, i }))
    .filter(f => (f.name + " " + f.words).toLowerCase().includes(q) && _featureHidden(f))
    .map(f => ({
      i: f.i, name: f.name,
      tag: f.needs ? _NEEDS[f.needs].tag : (_featureLevel(f) === "a" ? LEVEL_NAMES.advanced : LEVEL_NAMES.intermediate),
      where: f.needs ? `Not set up yet: opens Settings → ${_NEEDS[f.needs].tab === "ai" ? "AI" : "Status page"}`
           : f.dev ? "On a device's panel" : "",
    }));
}

function openLevelFeature(i) {
  const f = LEVEL_FEATURES[i];
  if (!f) return;
  if (f.needs) {
    setTab("settings"); setSettingsTab(_NEEDS[f.needs].tab);
    showToast(`Set up ${_NEEDS[f.needs].what} here first`);
    return;
  }
  if (f.dev) {
    const ip = _devIp();
    if (!ip) { setTab("hosts"); showToast("Open a device first, then search again"); return; }
    f.dev(ip);
    return;
  }
  f.go();
  if (f.show) _found(document.querySelector(f.at));
}

// Show a hidden item for this visit, and point it out
function _found(el, all) {
  if (!el) return;
  for (let n = el.closest("[data-lvl]"); n; n = n.parentElement?.closest("[data-lvl]")) n.classList.add("lvl-visit", "lvl-found");
  el.classList.add("lvl-found");
  if (all) el.classList.add("lvl-showall");
  _tidySubtabBars();
  el.scrollIntoView?.({ block: "center" });
  el.classList.remove("lvl-flash"); void el.offsetWidth; el.classList.add("lvl-flash");
}

function _goScan(sel) {
  setTab("scans"); setScanTab("run");
  _found(document.querySelector(sel));
}

// A Settings card or field: its tab, shown for this visit, its fold opened
function _goSetting(sel) {
  setTab("settings");
  const el = document.querySelector(sel);
  if (!el) return;
  setSettingsTab(el.closest(".set-pane").id.replace("set-pane-", ""));
  const form = el.closest("[data-fold-form]");
  if (form && el.closest("[data-fold]")) {
    levelFoldForm(form);
    const fold = el.closest(".lvl-fold");
    if (fold) { fold.dataset.keepOpen = "1"; _setFold(fold, true); }
  }
  _found(el);
}

// Going to another page (or level) ends the visit
function endLevelFound() {
  document.querySelectorAll(".lvl-found").forEach(e => e.classList.remove("lvl-found", "lvl-visit", "lvl-showall", "lvl-flash"));
  document.querySelectorAll(".lvl-fold[data-keep-open]").forEach(f => delete f.dataset.keepOpen);
}
onLevelChange(endLevelFound);

registerActions({ setViewLevel, dismissLevelNote, toggleMoreMenu });
