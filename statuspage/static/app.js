"use strict";
// Boltarr status page — client. Fetches the (server-gated) /data payload and
// renders it. Private sections never arrive here unless the server recognises an
// admin session, so there is nothing sensitive to hide client-side.

const $ = (id) => document.getElementById(id);
let CSRF = "";
let ANN = [];              // admin announcements list
let EV = [];               // admin events list
let ANN_EDIT = null;       // announcement being edited
let EV_EDIT = null;        // event being edited
let TZ = "UTC";            // configured status-page timezone
let LAST_MAINT = { active: [], upcoming: [] };
let MVIEW = "month";       // 'agenda' | 'month' — calendar shown by default
let MMONTH = null;         // {y, m} for the month grid

const SEV = { info: "Info", maintenance: "Maintenance", critical: "Critical" };
const WD = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];  // Mon=0 (matches backend)
function sevClass(s){ return SEV[s] ? "sev-" + s : "sev-info"; }
function sevLabel(s){ return SEV[s] || "Info"; }

function ago(iso){
  if(!iso) return "never";
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if(s < 60) return s + "s ago";
  if(s < 3600) return Math.floor(s/60) + "m ago";
  return Math.floor(s/3600) + "h ago";
}
function esc(s){
  return (s||"").replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmt(iso){ const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString(); }
function cls(v){ return ["up","down"].includes(v) ? v : "unknown"; }
function toLocalInput(iso){
  if(!iso) return "";
  const d = new Date(iso);
  if(isNaN(d)) return "";
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(v){ if(!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); }

// ── status list + banners ────────────────────────────────────────────────────
function card(x){
  const up = (x.uptime_24h == null) ? "—" : Number(x.uptime_24h).toFixed(2) + "%";
  const ticks = (x.ticks||[]).map(t => `<div class="tick ${cls(t)}"></div>`).join("");
  return `<div class="svc"><div class="svc-head"><span class="dot ${cls(x.status)}"></span>
    <span class="svc-name">${esc(x.name)}</span>
    <span class="uptime">${up} <span class="u24">24h</span></span></div>
    <div class="ticks">${ticks}</div></div>`;
}
function renderList(d){
  const privates = new Set(d.private_sections || []);
  const groups = [["Services","services"],["Hosts","hosts"],["Networking","networking"]]
    .map(([label,key]) => [label, key, d[key] || []]).filter(g => g[2].length);
  const list = $("list");
  if(!groups.length){ list.innerHTML = '<div class="empty">Nothing to display yet.</div>'; return; }
  const multi = groups.length > 1;
  list.innerHTML = groups.map(([label,key,items]) => {
    const lock = privates.has(key) ? '<span class="lock">PRIVATE</span>' : "";
    const head = (multi || lock) ? `<div class="section-label">${esc(label)} ${lock}</div>` : "";
    return head + items.map(card).join("");
  }).join("");
}
function renderAnnouncements(d){
  $("announce").innerHTML = (d.announcements || []).map(a =>
    `<div class="banner ann ${sevClass(a.severity)}">
       <div class="ann-title">${esc(a.title)}</div>
       ${a.body ? `<div class="ann-body">${esc(a.body)}</div>` : ""}
     </div>`).join("");
}
function renderHealth(d){
  const all = (d.services||[]).concat(d.hosts||[], d.networking||[]);
  const b = $("banner");
  if(!all.length){ b.className = "hidden"; b.textContent = ""; return; }
  const down = all.some(x => x.status === "down");
  b.className = "banner " + (down ? "bad" : "ok");
  b.textContent = down ? "Some systems are down" : "All systems operational";
}

// ── maintenance (public agenda + month grid) ─────────────────────────────────
function renderMaintenance(d){
  LAST_MAINT = d.maintenance || { active: [], upcoming: [], tz: "UTC" };
  const wrap = $("maintenance");
  if(!LAST_MAINT.active.length && !LAST_MAINT.upcoming.length){ wrap.innerHTML = ""; return; }
  wrap.innerHTML = `
    <div class="maint-head">
      <div class="section-label">Maintenance <span class="tz-badge">${esc(LAST_MAINT.tz || "")}</span></div>
      <div class="seg view-seg">
        <button data-view="agenda" class="${MVIEW==='agenda'?'on-public':''}">Agenda</button>
        <button data-view="month" class="${MVIEW==='month'?'on-public':''}">Month</button>
      </div>
    </div>
    <div id="maintBody"></div>`;
  wrap.querySelectorAll(".view-seg button").forEach(b =>
    b.addEventListener("click", () => { MVIEW = b.getAttribute("data-view"); renderMaintBody(); }));
  renderMaintBody();
}
function renderMaintBody(){
  const body = $("maintBody");
  if(!body) return;
  if(MVIEW === "month"){ loadMonth(0); return; }
  const m = LAST_MAINT;
  const active = m.active.map(a =>
    `<div class="agenda-item active"><span class="dot-sev ${sevClass(a.severity)}"></span>
       <div><div class="ag-title">${esc(a.title)} <span class="ag-now">in progress</span></div>
       <div class="ag-when">until ${esc(a.ends)}</div></div></div>`).join("");
  const up = m.upcoming.map(u =>
    `<div class="agenda-item"><span class="dot-sev ${sevClass(u.severity)}"></span>
       <div><div class="ag-title">${esc(u.title)}</div>
       <div class="ag-when">${esc(u.when)}</div></div></div>`).join("");
  body.innerHTML = active + (up || (active ? "" : '<div class="muted">Nothing scheduled.</div>'));
}
async function loadMonth(delta){
  const now = new Date();
  if(!MMONTH) MMONTH = { y: now.getFullYear(), m: now.getMonth() + 1 };
  if(delta){
    let idx = MMONTH.y * 12 + (MMONTH.m - 1) + delta;
    MMONTH = { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
  }
  const mm = `${MMONTH.y}-${String(MMONTH.m).padStart(2,"0")}`;
  let data;
  try{ data = await (await fetch("/api/calendar?month=" + mm, {cache:"no-store"})).json(); }
  catch(e){ return; }
  renderMonth(data);
}
function renderMonth(data){
  const body = $("maintBody");
  if(!body) return;
  const [y, m] = data.month.split("-").map(Number);
  const monthName = new Date(y, m-1, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
  const first = new Date(y, m-1, 1);
  const offset = (first.getDay() + 6) % 7;         // Mon=0
  const daysIn = new Date(y, m, 0).getDate();
  let cells = "";
  for(let i = 0; i < offset; i++) cells += '<div class="cal-cell empty"></div>';
  for(let day = 1; day <= daysIn; day++){
    const key = `${y}-${String(m).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
    const evs = (data.days && data.days[key]) || [];
    const chips = evs.map(e =>
      `<div class="cal-ev ${sevClass(e.severity)}" title="${esc(e.when)} ${esc(e.title)}">${esc(e.title)}</div>`).join("");
    cells += `<div class="cal-cell"><div class="cal-day">${day}</div>${chips}</div>`;
  }
  body.innerHTML = `
    <div class="cal-nav">
      <button class="btn small" id="calPrev">‹</button>
      <span class="cal-month">${esc(monthName)}</span>
      <button class="btn small" id="calNext">›</button>
    </div>
    <div class="cal-grid">
      ${WD.map(w => `<div class="cal-wd">${w}</div>`).join("")}
      ${cells}
    </div>`;
  $("calPrev").addEventListener("click", () => loadMonth(-1));
  $("calNext").addEventListener("click", () => loadMonth(1));
}

// ── admin panel ──────────────────────────────────────────────────────────────
function whenText(a){
  const parts = [ a.status.charAt(0).toUpperCase() + a.status.slice(1) ];
  if(a.starts_at) parts.push("from " + fmt(a.starts_at));
  if(a.ends_at)   parts.push("to " + fmt(a.ends_at));
  return parts.join(" · ");
}
function renderAdmin(d){
  const panel = $("adminPanel"), authbox = $("authbox");
  if(!d.admin){
    panel.classList.add("hidden");
    authbox.innerHTML = '<button id="loginBtn" class="btn">Login</button>';
    $("loginBtn").addEventListener("click", openLogin);
    return;
  }
  CSRF = d.csrf || "";
  ANN = d.announcements_all || [];
  EV = d.events_all || [];
  TZ = d.timezone || "UTC";
  authbox.innerHTML = '<button id="logoutBtn" class="btn small">Log out</button>';
  $("logoutBtn").addEventListener("click", logout);

  const vis = d.visibility || {};
  const visRows = [["Services","services"],["Hosts","hosts"],["Networking","networking"]]
    .map(([label,key]) => {
      const v = vis[key] || "private";
      return `<div class="vis-row"><span class="vis-name">${label}</span>
        <span class="seg" data-key="${key}">
          <button data-set="public" class="${v==='public'?'on-public':''}">Public</button>
          <button data-set="private" class="${v==='private'?'on-private':''}">Private</button>
        </span></div>`;
    }).join("");

  const annRows = ANN.length ? ANN.map(a =>
    `<div class="ann-item"><span class="chip ${sevClass(a.severity)}">${sevLabel(a.severity)}</span>
       <div class="ann-meta"><div class="ann-item-title">${esc(a.title)}</div>
         <div class="ann-when status-${esc(a.status)}">${esc(whenText(a))}</div></div>
       <div class="ann-item-actions">
         <button class="btn small" data-atoggle="${a.id}">${a.enabled ? "Disable" : "Enable"}</button>
         <button class="btn small" data-aedit="${a.id}">Edit</button>
         <button class="btn small danger" data-adel="${a.id}">Delete</button></div></div>`).join("")
    : '<div class="muted">No announcements yet.</div>';

  const evRows = EV.length ? EV.map(e =>
    `<div class="ann-item"><span class="chip ${sevClass(e.severity)}">${sevLabel(e.severity)}</span>
       <div class="ann-meta"><div class="ann-item-title">${esc(e.title)}${e.enabled ? "" : ' <span class="muted">(disabled)</span>'}</div>
         <div class="ann-when">${esc(e.summary)}${e.next ? " · next " + esc(e.next) : ""}</div></div>
       <div class="ann-item-actions">
         <button class="btn small" data-etoggle="${e.id}">${e.enabled ? "Disable" : "Enable"}</button>
         <button class="btn small" data-eedit="${e.id}">Edit</button>
         <button class="btn small danger" data-edel="${e.id}">Delete</button></div></div>`).join("")
    : '<div class="muted">No maintenance events yet.</div>';

  panel.innerHTML = `
    <h2>Visibility</h2>${visRows}
    <div class="admin-actions">
      <button class="btn small" id="allPublic">Make all Public</button>
      <button class="btn small" id="allPrivate">Make all Private</button><span class="spacer"></span>
    </div>
    <h2 class="mt">Announcements</h2>
    <div class="ann-admin-actions"><button class="btn small" id="annNew">+ New announcement</button></div>
    <div class="ann-list">${annRows}</div>
    <h2 class="mt">Maintenance schedule</h2>
    <div class="tz-row">Times in <strong>${esc(TZ)}</strong>
      <button class="btn small" id="tzEdit">Change zone</button></div>
    <div class="ann-admin-actions"><button class="btn small" id="evNew">+ New event</button></div>
    <div class="ann-list">${evRows}</div>`;
  panel.classList.remove("hidden");

  panel.querySelectorAll(".seg button").forEach(btn => btn.addEventListener("click", () =>
    setVisibility({ [btn.parentElement.getAttribute("data-key")]: btn.getAttribute("data-set") })));
  $("allPublic").addEventListener("click", () => setVisibility({ services:"public", hosts:"public", networking:"public" }));
  $("allPrivate").addEventListener("click", () => setVisibility({ services:"private", hosts:"private", networking:"private" }));
  $("annNew").addEventListener("click", () => openAnnModal(null));
  $("evNew").addEventListener("click", () => openEventModal(null));
  $("tzEdit").addEventListener("click", changeTimezone);
  panel.querySelectorAll("[data-aedit]").forEach(b => b.addEventListener("click", () => openAnnModal(+b.getAttribute("data-aedit"))));
  panel.querySelectorAll("[data-atoggle]").forEach(b => b.addEventListener("click", () => toggleAnn(+b.getAttribute("data-atoggle"))));
  panel.querySelectorAll("[data-adel]").forEach(b => b.addEventListener("click", () => deleteAnn(+b.getAttribute("data-adel"))));
  panel.querySelectorAll("[data-eedit]").forEach(b => b.addEventListener("click", () => openEventModal(+b.getAttribute("data-eedit"))));
  panel.querySelectorAll("[data-etoggle]").forEach(b => b.addEventListener("click", () => toggleEvent(+b.getAttribute("data-etoggle"))));
  panel.querySelectorAll("[data-edel]").forEach(b => b.addEventListener("click", () => deleteEvent(+b.getAttribute("data-edel"))));
}

// ── mutations: visibility / timezone ─────────────────────────────────────────
async function setVisibility(patch){
  try{ const r = await fetch("/api/visibility", { method:"POST",
      headers:{ "Content-Type":"application/json", "X-CSRF": CSRF }, body: JSON.stringify(patch) });
    if(r.ok) await load(); }catch(e){}
}
async function changeTimezone(){
  const name = prompt("IANA timezone (e.g. Asia/Dubai, Europe/London, UTC):", TZ);
  if(!name) return;
  try{ const r = await fetch("/api/timezone", { method:"POST",
      headers:{ "Content-Type":"application/json", "X-CSRF": CSRF }, body: JSON.stringify({ timezone: name.trim() }) });
    if(r.ok) await load(); else alert("That timezone wasn't recognised.");
  }catch(e){}
}

// ── announcements CRUD (Phase 2) ─────────────────────────────────────────────
function annPayload(a){ return { severity:a.severity, title:a.title, body:a.body,
  starts_at:a.starts_at, ends_at:a.ends_at, enabled:a.enabled }; }
async function postAnn(p){ return (await fetch("/api/announcements", { method:"POST",
  headers:{ "Content-Type":"application/json", "X-CSRF": CSRF }, body: JSON.stringify(p) })).ok; }
async function putAnn(id, p){ return (await fetch("/api/announcements/" + id, { method:"PUT",
  headers:{ "Content-Type":"application/json", "X-CSRF": CSRF }, body: JSON.stringify(p) })).ok; }
async function toggleAnn(id){ const a = ANN.find(x => x.id === id); if(!a) return;
  if(await putAnn(id, { ...annPayload(a), enabled: !a.enabled })) await load(); }
async function deleteAnn(id){ const a = ANN.find(x => x.id === id);
  if(a && !confirm(`Delete announcement "${a.title}"?`)) return;
  try{ const r = await fetch("/api/announcements/" + id, { method:"DELETE", headers:{ "X-CSRF": CSRF } });
    if(r.ok) await load(); }catch(e){} }
function openAnnModal(id){
  ANN_EDIT = id; const a = (id != null) ? ANN.find(x => x.id === id) : null;
  $("annModalTitle").textContent = a ? "Edit announcement" : "New announcement";
  $("annErr").textContent = "";
  $("annSeverity").value = a ? a.severity : "info";
  $("annTitle").value = a ? a.title : "";
  $("annBody").value = a ? a.body : "";
  $("annStarts").value = a ? toLocalInput(a.starts_at) : "";
  $("annEnds").value = a ? toLocalInput(a.ends_at) : "";
  $("annEnabled").checked = a ? a.enabled : true;
  $("annModal").classList.remove("hidden"); $("annTitle").focus();
}
function closeAnnModal(){ $("annModal").classList.add("hidden"); ANN_EDIT = null; }
async function saveAnn(){
  const err = $("annErr"); err.textContent = "";
  const title = $("annTitle").value.trim();
  if(!title){ err.textContent = "Title is required."; return; }
  const starts = fromLocalInput($("annStarts").value), ends = fromLocalInput($("annEnds").value);
  if(starts && ends && new Date(ends) <= new Date(starts)){ err.textContent = "End must be after start."; return; }
  const payload = { severity:$("annSeverity").value, title, body:$("annBody").value.trim(),
    starts_at:starts, ends_at:ends, enabled:$("annEnabled").checked };
  try{
    const ok = (ANN_EDIT == null) ? await postAnn(payload) : await putAnn(ANN_EDIT, payload);
    if(!ok){ err.textContent = "Save failed."; return; }
    closeAnnModal(); await load();
  }catch(e){ err.textContent = "Network error."; }
}

// ── events CRUD (Phase 3) ────────────────────────────────────────────────────
async function postEvent(p){ return (await fetch("/api/events", { method:"POST",
  headers:{ "Content-Type":"application/json", "X-CSRF": CSRF }, body: JSON.stringify(p) })).ok; }
async function putEvent(id, p){ return (await fetch("/api/events/" + id, { method:"PUT",
  headers:{ "Content-Type":"application/json", "X-CSRF": CSRF }, body: JSON.stringify(p) })).ok; }
function eventPayload(e){
  return { title:e.title, body:e.body, severity:e.severity, recurrence:e.recurrence,
    start_time:e.start_time, end_time:e.end_time, once_date:e.once_date, weekdays:e.weekdays,
    month_days:e.month_days, nth:e.nth, nth_weekday:e.nth_weekday, until_date:e.until_date, enabled:e.enabled };
}
async function toggleEvent(id){ const e = EV.find(x => x.id === id); if(!e) return;
  if(await putEvent(id, { ...eventPayload(e), enabled: !e.enabled })) await load(); }
async function deleteEvent(id){ const e = EV.find(x => x.id === id);
  if(e && !confirm(`Delete event "${e.title}"?`)) return;
  try{ const r = await fetch("/api/events/" + id, { method:"DELETE", headers:{ "X-CSRF": CSRF } });
    if(r.ok) await load(); }catch(e){} }

function showRecFields(rec){
  const map = { once:"recOnce", weekly:"recWeekly", monthly_date:"recMonthDate", monthly_nth:"recMonthNth" };
  ["recOnce","recWeekly","recMonthDate","recMonthNth"].forEach(id => $(id).classList.add("hidden"));
  if(map[rec]) $(map[rec]).classList.remove("hidden");
}
function openEventModal(id){
  EV_EDIT = id; const e = (id != null) ? EV.find(x => x.id === id) : null;
  $("evModalTitle").textContent = e ? "Edit maintenance event" : "New maintenance event";
  $("evErr").textContent = "";
  $("evTitle").value = e ? e.title : "";
  $("evSeverity").value = e ? e.severity : "maintenance";
  $("evBody").value = e ? e.body : "";
  $("evRec").value = e ? e.recurrence : "once";
  $("evOnceDate").value = e ? (e.once_date || "") : "";
  document.querySelectorAll("#evWeekdays input").forEach(c => {
    c.checked = e && e.weekdays ? e.weekdays.split(",").includes(c.value) : false; });
  $("evMonthDays").value = e ? (e.month_days || "") : "";
  $("evNth").value = e && e.nth != null ? String(e.nth) : "1";
  $("evNthWeekday").value = e && e.nth_weekday != null ? String(e.nth_weekday) : "4";
  $("evStart").value = e ? e.start_time : "02:00";
  $("evEnd").value = e ? e.end_time : "06:00";
  $("evUntil").value = e ? (e.until_date || "") : "";
  $("evEnabled").checked = e ? e.enabled : true;
  showRecFields($("evRec").value);
  $("evModal").classList.remove("hidden"); $("evTitle").focus();
}
function closeEventModal(){ $("evModal").classList.add("hidden"); EV_EDIT = null; }
function collectEvent(){
  const rec = $("evRec").value;
  const p = { title:$("evTitle").value.trim(), severity:$("evSeverity").value, body:$("evBody").value.trim(),
    recurrence:rec, start_time:$("evStart").value || "00:00", end_time:$("evEnd").value || "00:00",
    until_date:$("evUntil").value || null, enabled:$("evEnabled").checked,
    once_date:null, weekdays:null, month_days:null, nth:null, nth_weekday:null };
  if(rec === "once") p.once_date = $("evOnceDate").value || null;
  if(rec === "weekly") p.weekdays = [...document.querySelectorAll("#evWeekdays input:checked")].map(c => c.value).join(",");
  if(rec === "monthly_date") p.month_days = $("evMonthDays").value;
  if(rec === "monthly_nth"){ p.nth = $("evNth").value; p.nth_weekday = $("evNthWeekday").value; }
  return p;
}
async function saveEvent(){
  const err = $("evErr"); err.textContent = "";
  const p = collectEvent();
  if(!p.title){ err.textContent = "Title is required."; return; }
  if(p.recurrence === "once" && !p.once_date){ err.textContent = "Pick a date."; return; }
  if(p.recurrence === "weekly" && !p.weekdays){ err.textContent = "Pick at least one weekday."; return; }
  if(p.recurrence === "monthly_date" && !p.month_days.trim()){ err.textContent = "Enter day(s) of the month."; return; }
  try{
    const ok = (EV_EDIT == null) ? await postEvent(p) : await putEvent(EV_EDIT, p);
    if(!ok){ err.textContent = "Save failed — check the fields."; return; }
    closeEventModal(); await load();
  }catch(e){ err.textContent = "Network error."; }
}

// ── load loop ────────────────────────────────────────────────────────────────
async function load(){
  let d;
  try{ d = await (await fetch("/data", {cache:"no-store"})).json(); }
  catch(e){ return; }
  $("title").textContent = d.title || "Service Status";
  document.title = d.title || "Service Status";
  $("updated").textContent = "Updated " + ago(d.updated_at);
  renderAdmin(d);
  renderAnnouncements(d);
  renderHealth(d);
  renderList(d);
  renderMaintenance(d);
}

// ── login modal ──────────────────────────────────────────────────────────────
function openLogin(){ $("loginErr").textContent = ""; $("pw").value = "";
  $("loginModal").classList.remove("hidden"); $("pw").focus(); }
function closeLogin(){ $("loginModal").classList.add("hidden"); }
async function doLogin(){
  const err = $("loginErr"); err.textContent = "";
  try{
    const r = await fetch("/login", { method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ password: $("pw").value }) });
    if(r.ok){ closeLogin(); await load(); return; }
    if(r.status === 429) err.textContent = "Too many attempts — try again in " + (r.headers.get("Retry-After") || "?") + "s.";
    else if(r.status === 403) err.textContent = "Admin login is disabled (no password set).";
    else err.textContent = "Incorrect password.";
  }catch(e){ err.textContent = "Network error."; }
}
async function logout(){ try{ await fetch("/logout", {method:"POST"}); }catch(e){} await load(); }

document.addEventListener("DOMContentLoaded", () => {
  // build weekday checkboxes for the event editor
  $("evWeekdays").innerHTML = WD.map((w,i) =>
    `<label class="wd"><input type="checkbox" value="${i}"> ${w}</label>`).join("");
  $("loginSubmit").addEventListener("click", doLogin);
  $("loginCancel").addEventListener("click", closeLogin);
  $("pw").addEventListener("keydown", (e) => { if(e.key === "Enter") doLogin(); });
  $("annCancel").addEventListener("click", closeAnnModal);
  $("annSave").addEventListener("click", saveAnn);
  $("evCancel").addEventListener("click", closeEventModal);
  $("evSave").addEventListener("click", saveEvent);
  $("evRec").addEventListener("change", () => showRecFields($("evRec").value));
  load();
  setInterval(load, 30000);
});
