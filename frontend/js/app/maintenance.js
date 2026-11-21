// ── Planned maintenance (R-22) ────────────────────────────────────────────────
// Services → 🗓 Maintenance: plan work ahead. While a window runs, Boltarr pauses the
// services it covers (no alerts, no downtime), holds its devices' offline alerts,
// and the status page shows it. Times are in Boltarr's timezone (Settings → General),
// the same zone the server reads them in.

let maintWindows = [];
let maintEditing = null;                    // the window being edited (null = new)
const maintPicked = { host: new Set(), svc: new Set() };

const MAINT_STATE = { planned: ["Planned", ""], active: ["In progress", " active"], done: ["Done", " done"] };

// "2026-11-22T02:00" (a local time from the server) → "Sat 22 Nov 02:00"
function _maintWhen(local) {
  const [d, t] = local.split("T"), [y, m, day] = d.split("-").map(Number);
  const wd = new Date(y, m - 1, day).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return `${wd} ${t}`;
}
function _maintSpan(w) {
  const same = w.starts_local.slice(0, 10) === w.ends_local.slice(0, 10);
  return `${_maintWhen(w.starts_local)} – ${same ? w.ends_local.slice(11) : _maintWhen(w.ends_local)}`;
}
// Now (+ minutes) as "YYYY-MM-DDTHH:MM" in Boltarr's timezone, for the form
function _maintLocalIn(minutes) {
  return fmtLocalStamp(new Date(Date.now() + minutes * 60000)).replace(" ", "T");
}
// A form time moved by some minutes (no timezone maths: the wall clock moves)
function _maintShift(local, minutes) {
  const [d, t] = local.split("T"), [y, m, day] = d.split("-").map(Number), [hh, mm] = t.split(":").map(Number);
  const x = new Date(Date.UTC(y, m - 1, day, hh, mm + minutes));
  return x.toISOString().slice(0, 16);
}

async function loadMaintWindows() {
  try { maintWindows = (await api("GET", "/api/maintenance-windows")).windows || []; } catch { maintWindows = []; }
  levelInUse("maint", maintWindows.some(w => w.state !== "done"));
  renderMaintBanner();
}

// One line above the Services table: what's running now, or the next one this week
function renderMaintBanner() {
  const el = document.getElementById("svcMaintBanner");
  if (!el) return;
  const now = maintWindows.filter(w => w.state === "active");
  const soon = maintWindows.filter(w => w.state === "planned" &&
    new Date(w.starts_at) - Date.now() < 7 * 86400000);
  const pick = now[0] || soon[0];
  if (!pick) { el.style.display = "none"; return; }
  const more = now.length + soon.length - 1;
  el.innerHTML = `🗓 <b>${pick.state === "active" ? "Maintenance in progress" : "Maintenance planned"}:</b> ` +
    `${escHtml(pick.title)} · ${escHtml(pick.state === "active" ? "until " + _maintWhen(pick.ends_local) : _maintSpan(pick))}` +
    (more > 0 ? ` <span class="maint-more">+${more} more</span>` : "");
  el.style.display = "";
}

async function openMaintModal() {
  document.getElementById("maintTz").textContent = APP_TZ || "the server clock (set a timezone in Settings → General)";
  _maintShowList();
  document.getElementById("maintModal").classList.add("open");
  await loadMaintWindows();
  renderMaintList();
}
function closeMaintModal() {
  document.getElementById("maintModal").classList.remove("open");
}
function _maintShowList() {
  document.getElementById("maintListView").style.display = "";
  document.getElementById("maintFormView").style.display = "none";
  document.getElementById("maintModalTitle").textContent = "🗓 Planned maintenance";
}

function renderMaintList() {
  const el = document.getElementById("maintList");
  if (!maintWindows.length) {
    el.innerHTML = `<div class="maint-empty">Nothing planned.</div>`;
    return;
  }
  el.innerHTML = maintWindows.map(w => {
    const [label, cls] = MAINT_STATE[w.state] || [w.state, ""];
    const covers = [...w.host_names.map(n => `${escHtml(n)} <span class="maint-dim">(all its services)</span>`),
                    ...w.service_names.map(escHtml)].join(", ");
    const btns = w.state === "active"
      ? `<button class="btn" data-click="maintExtend" data-args="${dargs(w.id, 30)}" title="End 30 minutes later">+30 min</button>
         <button class="btn" data-click="maintExtend" data-args="${dargs(w.id, 60)}" title="End an hour later">+1 h</button>
         <button class="btn" data-click="maintEdit" data-args="[${w.id}]">✎ Edit</button>
         <button class="btn btn-primary" data-click="maintDone" data-args="[${w.id}]" title="End it now: monitoring resumes">✓ Done</button>`
      : w.state === "planned"
      ? `<button class="btn" data-click="maintEdit" data-args="[${w.id}]">✎ Edit</button>
         <button class="btn btn-danger" data-click="maintDelete" data-args="[${w.id}]">Delete</button>`
      : `<button class="btn" data-click="maintDelete" data-args="[${w.id}]" title="Remove it from this list">Remove</button>`;
    return `<div class="maint-item${cls}">
      <div class="maint-item-head">
        <span class="maint-state${cls}">${label}</span>
        <span class="maint-title">${escHtml(w.title)}</span>
        <span class="maint-when">${escHtml(_maintSpan(w))}</span>
      </div>
      <div class="maint-covers">${covers || '<span class="maint-dim">Nothing left to cover</span>'}
        <span class="maint-dim">· ${w.covered_count} service${w.covered_count === 1 ? "" : "s"}</span></div>
      ${w.note ? `<div class="maint-note">${escHtml(w.note)}</div>` : ""}
      <div class="maint-btns">${btns}</div>
    </div>`;
  }).join("");
}

// ── The form ──────────────────────────────────────────────────────────────────

function maintNew() { _maintOpenForm(null); }
function maintEdit(id) { _maintOpenForm(maintWindows.find(w => w.id === id) || null); }

async function _maintOpenForm(w) {
  maintEditing = w;
  if (!allHosts.length) { try { allHosts = await api("GET", "/api/hosts"); } catch {} }
  if (!allServices.length) { try { allServices = await api("GET", "/api/services"); } catch {} }
  const active = w && w.state === "active";
  document.getElementById("maintModalTitle").textContent = w ? "🗓 Edit maintenance" : "🗓 Plan maintenance";
  document.getElementById("maintTitle").value = w ? w.title : "";
  document.getElementById("maintNote").value = w ? w.note : "";
  const start = Math.ceil(Date.now() / 3600000) * 3600000;           // the next full hour
  document.getElementById("maintStarts").value = w ? w.starts_local : _maintLocalIn((start - Date.now()) / 60000);
  document.getElementById("maintEnds").value = w ? w.ends_local : _maintLocalIn((start - Date.now()) / 60000 + 60);
  document.getElementById("maintStarts").disabled = active;
  maintPicked.host = new Set(w ? w.host_ids : []);
  maintPicked.svc = new Set(w ? w.service_ids : []);
  for (const kind of ["host", "svc"]) {
    document.getElementById(kind === "host" ? "maintHostFilter" : "maintSvcFilter").value = "";
    renderMaintPick(kind, active);
  }
  document.getElementById("maintActiveHint").style.display = active ? "" : "none";
  document.getElementById("maintListView").style.display = "none";
  document.getElementById("maintFormView").style.display = "";
  document.getElementById("maintTitle").focus();
}
function maintCancelForm() { _maintShowList(); }

function renderMaintPick(kind, locked = maintEditing && maintEditing.state === "active") {
  const box = document.getElementById(kind === "host" ? "maintHostPick" : "maintSvcPick");
  const q = document.getElementById(kind === "host" ? "maintHostFilter" : "maintSvcFilter").value.trim().toLowerCase();
  const perHost = {};
  allServices.forEach(s => { perHost[s.host_id] = (perHost[s.host_id] || 0) + 1; });
  const items = kind === "host"
    ? allHosts.filter(h => !String(h.ip).startsWith("node-")).sort((a, b) => cmpIp(a.ip, b.ip)).map(h => ({
        id: h.id, text: `${h.hostname || h.ip} ${h.ip}`,
        html: `${escHtml(h.hostname || h.ip)} <span class="maint-dim mono">${escHtml(h.ip)}</span>` +
              (perHost[h.id] ? ` <span class="maint-dim">· ${perHost[h.id]} service${perHost[h.id] === 1 ? "" : "s"}</span>` : "") }))
    : [...allServices].sort((a, b) => a.name.localeCompare(b.name)).map(s => ({
        id: s.id, text: `${s.name} ${s.hostname || ""} ${s.ip}`,
        html: `${escHtml(s.name)} <span class="maint-dim">on ${escHtml(s.hostname || s.ip)}</span>` }));
  const set = maintPicked[kind];
  // picked ones first, so they stay in view
  const shown = items.filter(i => set.has(i.id) || !q || i.text.toLowerCase().includes(q))
                     .sort((a, b) => set.has(b.id) - set.has(a.id));
  box.innerHTML = shown.length ? shown.map(i => `<label class="maint-pick-row">
      <input type="checkbox" ${set.has(i.id) ? "checked" : ""} ${locked ? "disabled" : ""}
             data-change="maintPickToggle" data-args="${dargs(kind, i.id)}"> ${i.html}</label>`).join("")
    : `<div class="maint-dim" style="padding:6px 8px">No matches.</div>`;
  document.getElementById(kind === "host" ? "maintHostCount" : "maintSvcCount").textContent =
    set.size ? `${set.size} picked` : "";
}

async function maintSave() {
  const body = {
    title: document.getElementById("maintTitle").value,
    note: document.getElementById("maintNote").value,
    starts: document.getElementById("maintStarts").value,
    ends: document.getElementById("maintEnds").value,
    host_ids: [...maintPicked.host],
    service_ids: [...maintPicked.svc],
  };
  try {
    const r = maintEditing
      ? await api("PUT", `/api/maintenance-windows/${maintEditing.id}`, body)
      : await api("POST", "/api/maintenance-windows", body);
    maintWindows = r.windows || [];
  } catch (e) {
    alert("Not saved.\n\n" + e.message);
    return;
  }
  showToast(maintEditing ? "Maintenance saved" : "Maintenance planned");
  _maintShowList();
  renderMaintList();
  _maintAfterChange();
}

// ── List buttons ──────────────────────────────────────────────────────────────

async function _maintAct(promise, toast) {
  try { maintWindows = (await promise).windows || []; }
  catch (e) { alert(e.message); return; }
  if (toast) showToast(toast);
  renderMaintList();
  _maintAfterChange();
}
function maintExtend(id, minutes) {
  const w = maintWindows.find(x => x.id === id);
  if (!w) return;
  _maintAct(api("PUT", `/api/maintenance-windows/${id}`, {
    title: w.title, note: w.note, starts: w.starts_local, ends: _maintShift(w.ends_local, minutes),
    host_ids: w.host_ids, service_ids: w.service_ids }), `Now ends ${minutes === 60 ? "an hour" : minutes + " minutes"} later`);
}
function maintDone(id) {
  _maintAct(api("POST", `/api/maintenance-windows/${id}/done`), "Maintenance ended — monitoring resumes");
}
function maintDelete(id) {
  const w = maintWindows.find(x => x.id === id);
  if (w && w.state === "planned" && !confirm(`Delete the planned maintenance "${w.title}"?`)) return;
  _maintAct(api("DELETE", `/api/maintenance-windows/${id}`), w && w.state === "planned" ? "Deleted" : "");
}

// Services start/stop pausing with a window: refresh the table and the banner
async function _maintAfterChange() {
  renderMaintBanner();
  if (document.getElementById("panel-services")?.classList.contains("active")) {
    await loadServicesData();
    renderServicesTable();
  }
}

registerActions({
  openMaintModal, closeMaintModal, maintNew, maintEdit, maintCancelForm, maintSave,
  maintExtend, maintDone, maintDelete,
  maintFilterPick: kind => renderMaintPick(kind),
  maintPickToggle: function (kind, id) {
    maintPicked[kind][this.checked ? "add" : "delete"](id);
    document.getElementById(kind === "host" ? "maintHostCount" : "maintSvcCount").textContent =
      maintPicked[kind].size ? `${maintPicked[kind].size} picked` : "";
  },
});
