"use strict";
// Boltarr status page — client. Fetches the (server-gated) /data payload and
// renders it. Private sections never arrive here unless the server recognises an
// admin session, so there is nothing sensitive to hide client-side.

const $ = (id) => document.getElementById(id);
let CSRF = "";

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
// Whitelist status/tick values so only known classes can reach the DOM.
function cls(v){ return ["up","down"].includes(v) ? v : "unknown"; }

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

function renderBanner(d){
  const all = (d.services||[]).concat(d.hosts||[], d.networking||[]);
  const b = $("banner");
  if(!all.length){ b.className = "hidden"; b.textContent = ""; return; }
  const down = all.some(x => x.status === "down");
  b.className = "banner " + (down ? "bad" : "ok");
  b.textContent = down ? "Some systems are down" : "All systems operational";
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
  authbox.innerHTML = '<button id="logoutBtn" class="btn small">Log out</button>';
  $("logoutBtn").addEventListener("click", logout);
  const vis = d.visibility || {};
  const rows = [["Services","services"],["Hosts","hosts"],["Networking","networking"]]
    .map(([label,key]) => {
      const v = vis[key] || "private";
      return `<div class="vis-row"><span class="vis-name">${label}</span>
        <span class="seg" data-key="${key}">
          <button data-set="public" class="${v==='public'?'on-public':''}">Public</button>
          <button data-set="private" class="${v==='private'?'on-private':''}">Private</button>
        </span></div>`;
    }).join("");
  panel.innerHTML = `<h2>Visibility</h2>${rows}
    <div class="admin-actions">
      <button class="btn small" id="allPublic">Make all Public</button>
      <button class="btn small" id="allPrivate">Make all Private</button>
      <span class="spacer"></span>
    </div>`;
  panel.classList.remove("hidden");
  panel.querySelectorAll(".seg button").forEach(btn => {
    btn.addEventListener("click", () => {
      const key = btn.parentElement.getAttribute("data-key");
      setVisibility({ [key]: btn.getAttribute("data-set") });
    });
  });
  $("allPublic").addEventListener("click", () =>
    setVisibility({ services:"public", hosts:"public", networking:"public" }));
  $("allPrivate").addEventListener("click", () =>
    setVisibility({ services:"private", hosts:"private", networking:"private" }));
}

async function setVisibility(patch){
  try{
    const r = await fetch("/api/visibility", {
      method:"POST",
      headers:{ "Content-Type":"application/json", "X-CSRF": CSRF },
      body: JSON.stringify(patch)
    });
    if(!r.ok) throw new Error();
    await load();
  }catch(e){ /* leave UI as-is on failure */ }
}

async function load(){
  let d;
  try{ d = await (await fetch("/data", {cache:"no-store"})).json(); }
  catch(e){ return; }
  $("title").textContent = d.title || "Service Status";
  document.title = d.title || "Service Status";
  $("updated").textContent = "Updated " + ago(d.updated_at);
  renderAdmin(d);
  renderBanner(d);
  renderList(d);
}

// ── login modal ────────────────────────────────────────────────────────────
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
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ password: $("pw").value })
    });
    if(r.ok){ closeLogin(); await load(); return; }
    if(r.status === 429){
      const ra = r.headers.get("Retry-After") || "?";
      err.textContent = "Too many attempts — try again in " + ra + "s.";
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
  load();
  setInterval(load, 30000);
});
