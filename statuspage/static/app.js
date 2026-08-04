"use strict";
// Boltarr status page — client. Fetches the (server-gated) /data payload and
// renders it. Private sections never arrive here unless the server recognises an
// admin session, so there is nothing sensitive to hide client-side.

const $ = (id) => document.getElementById(id);
let CSRF = "";
let ANN = [];          // admin's full announcement list (for management)
let EDIT_ID = null;    // announcement being edited, or null when creating

const SEV = { info: "Info", maintenance: "Maintenance", critical: "Critical" };
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
// Whitelist status/tick values so only known classes can reach the DOM.
function cls(v){ return ["up","down"].includes(v) ? v : "unknown"; }

// datetime-local <-> UTC ISO
function toLocalInput(iso){
  if(!iso) return "";
  const d = new Date(iso);
  if(isNaN(d)) return "";
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(v){
  if(!v) return null;
  const d = new Date(v);           // interpreted in the visitor's local zone
  return isNaN(d) ? null : d.toISOString();
}

// ── rendering ────────────────────────────────────────────────────────────────
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
    .map(([label,key]) => [label, key, d[key] || []])
    .filter(g => g[2].length);
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
  const items = d.announcements || [];
  $("announce").innerHTML = items.map(a =>
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

function whenText(a){
  const parts = [ a.status.charAt(0).toUpperCase() + a.status.slice(1) ];
  if(a.starts_at) parts.push("from " + fmt(a.starts_at));
  if(a.ends_at)   parts.push("to " + fmt(a.ends_at));
  return parts.join(" · ");
}

function renderAdmin(d){
  const panel = $("adminPanel");
  const authbox = $("authbox");
  if(!d.admin){
    panel.classList.add("hidden");
    authbox.innerHTML = '<button id="loginBtn" class="btn">Login</button>';
    $("loginBtn").addEventListener("click", openLogin);
    return;
  }
  CSRF = d.csrf || "";
  ANN = d.announcements_all || [];
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
    `<div class="ann-item">
       <span class="chip ${sevClass(a.severity)}">${sevLabel(a.severity)}</span>
       <div class="ann-meta">
         <div class="ann-item-title">${esc(a.title)}</div>
         <div class="ann-when status-${esc(a.status)}">${esc(whenText(a))}</div>
       </div>
       <div class="ann-item-actions">
         <button class="btn small" data-toggle="${a.id}">${a.enabled ? "Disable" : "Enable"}</button>
         <button class="btn small" data-edit="${a.id}">Edit</button>
         <button class="btn small danger" data-del="${a.id}">Delete</button>
       </div>
     </div>`).join("") : '<div class="muted">No announcements yet.</div>';

  panel.innerHTML = `
    <h2>Visibility</h2>${visRows}
    <div class="admin-actions">
      <button class="btn small" id="allPublic">Make all Public</button>
      <button class="btn small" id="allPrivate">Make all Private</button>
      <span class="spacer"></span>
    </div>
    <h2 class="mt">Announcements</h2>
    <div class="ann-admin-actions"><button class="btn small" id="annNew">+ New announcement</button></div>
    <div class="ann-list">${annRows}</div>`;
  panel.classList.remove("hidden");

  panel.querySelectorAll(".seg button").forEach(btn => btn.addEventListener("click", () =>
    setVisibility({ [btn.parentElement.getAttribute("data-key")]: btn.getAttribute("data-set") })));
  $("allPublic").addEventListener("click", () =>
    setVisibility({ services:"public", hosts:"public", networking:"public" }));
  $("allPrivate").addEventListener("click", () =>
    setVisibility({ services:"private", hosts:"private", networking:"private" }));
  $("annNew").addEventListener("click", () => openAnnModal(null));
  panel.querySelectorAll("[data-edit]").forEach(b =>
    b.addEventListener("click", () => openAnnModal(Number(b.getAttribute("data-edit")))));
  panel.querySelectorAll("[data-toggle]").forEach(b =>
    b.addEventListener("click", () => toggleAnn(Number(b.getAttribute("data-toggle")))));
  panel.querySelectorAll("[data-del]").forEach(b =>
    b.addEventListener("click", () => deleteAnn(Number(b.getAttribute("data-del")))));
}

// ── mutations ────────────────────────────────────────────────────────────────
async function setVisibility(patch){
  try{
    const r = await fetch("/api/visibility", {
      method:"POST",
      headers:{ "Content-Type":"application/json", "X-CSRF": CSRF },
      body: JSON.stringify(patch)
    });
    if(r.ok) await load();
  }catch(e){ /* leave UI as-is on failure */ }
}

function annPayload(a){
  return { severity:a.severity, title:a.title, body:a.body,
           starts_at:a.starts_at, ends_at:a.ends_at, enabled:a.enabled };
}
async function postAnn(p){
  const r = await fetch("/api/announcements", {
    method:"POST", headers:{ "Content-Type":"application/json", "X-CSRF": CSRF },
    body: JSON.stringify(p) });
  return r.ok;
}
async function putAnn(id, p){
  const r = await fetch("/api/announcements/" + id, {
    method:"PUT", headers:{ "Content-Type":"application/json", "X-CSRF": CSRF },
    body: JSON.stringify(p) });
  return r.ok;
}
async function toggleAnn(id){
  const a = ANN.find(x => x.id === id); if(!a) return;
  if(await putAnn(id, { ...annPayload(a), enabled: !a.enabled })) await load();
}
async function deleteAnn(id){
  const a = ANN.find(x => x.id === id);
  if(a && !confirm(`Delete announcement "${a.title}"?`)) return;
  try{
    const r = await fetch("/api/announcements/" + id, { method:"DELETE", headers:{ "X-CSRF": CSRF } });
    if(r.ok) await load();
  }catch(e){}
}

// ── announcement editor modal ────────────────────────────────────────────────
function openAnnModal(id){
  EDIT_ID = id;
  const a = (id != null) ? ANN.find(x => x.id === id) : null;
  $("annModalTitle").textContent = a ? "Edit announcement" : "New announcement";
  $("annErr").textContent = "";
  $("annSeverity").value = a ? a.severity : "info";
  $("annTitle").value = a ? a.title : "";
  $("annBody").value = a ? a.body : "";
  $("annStarts").value = a ? toLocalInput(a.starts_at) : "";
  $("annEnds").value = a ? toLocalInput(a.ends_at) : "";
  $("annEnabled").checked = a ? a.enabled : true;
  $("annModal").classList.remove("hidden");
  $("annTitle").focus();
}
function closeAnnModal(){ $("annModal").classList.add("hidden"); EDIT_ID = null; }

async function saveAnn(){
  const err = $("annErr"); err.textContent = "";
  const title = $("annTitle").value.trim();
  if(!title){ err.textContent = "Title is required."; return; }
  const starts = fromLocalInput($("annStarts").value);
  const ends   = fromLocalInput($("annEnds").value);
  if(starts && ends && new Date(ends) <= new Date(starts)){
    err.textContent = "End must be after start."; return;
  }
  const payload = {
    severity: $("annSeverity").value,
    title,
    body: $("annBody").value.trim(),
    starts_at: starts,
    ends_at: ends,
    enabled: $("annEnabled").checked
  };
  try{
    const ok = (EDIT_ID == null) ? await postAnn(payload) : await putAnn(EDIT_ID, payload);
    if(!ok){ err.textContent = "Save failed."; return; }
    closeAnnModal();
    await load();
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
}

// ── login modal ──────────────────────────────────────────────────────────────
function openLogin(){
  $("loginErr").textContent = "";
  $("pw").value = "";
  $("loginModal").classList.remove("hidden");
  $("pw").focus();
}
function closeLogin(){ $("loginModal").classList.add("hidden"); }

async function doLogin(){
  const err = $("loginErr");
  err.textContent = "";
  try{
    const r = await fetch("/login", {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ password: $("pw").value })
    });
    if(r.ok){ closeLogin(); await load(); return; }
    if(r.status === 429){
      err.textContent = "Too many attempts — try again in " + (r.headers.get("Retry-After") || "?") + "s.";
    } else if(r.status === 403){
      err.textContent = "Admin login is disabled (no password set).";
    } else {
      err.textContent = "Incorrect password.";
    }
  }catch(e){ err.textContent = "Network error."; }
}

async function logout(){
  try{ await fetch("/logout", {method:"POST"}); }catch(e){}
  await load();
}

document.addEventListener("DOMContentLoaded", () => {
  $("loginSubmit").addEventListener("click", doLogin);
  $("loginCancel").addEventListener("click", closeLogin);
  $("pw").addEventListener("keydown", (e) => { if(e.key === "Enter") doLogin(); });
  $("annCancel").addEventListener("click", closeAnnModal);
  $("annSave").addEventListener("click", saveAnn);
  load();
  setInterval(load, 30000);
});
