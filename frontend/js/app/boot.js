// Boltarr — Start-up and login state. Loads last: its DOMContentLoaded runs after the others.
// Part of the app split from app.js (F-08); files share globals and load in order (see index.html).

// ── Init ──────────────────────────────────────────────────────────────────────

async function initAiStatus() {
  try {
    const { llm } = await api("GET", "/api/settings");
    updateAiStatusDot(llm.configured);
  } catch (_) {}
}

document.addEventListener("DOMContentLoaded", () => { boot(); initAiStatus(); });


// ── Login ─────────────────────────────────────────────────────────────────────

let loginState = { enabled: false };

async function loadLoginState() {
  try { loginState = await api("GET", "/api/auth/status"); } catch (_) { return; }
  // Log out makes no sense when an outside login service signed you in
  document.getElementById("logoutBtn").hidden = !(loginState.enabled && !loginState.via_proxy);
  if (!loginState.enabled) showNoPasswordBanner();
}

// Reminder while login is off; "Not now" hides it for 30 days on this browser
function showNoPasswordBanner() {
  try {
    const until = +localStorage.getItem("boltarrNoPwSnooze") || 0;
    if (Date.now() < until) return;
  } catch (_) {}
  if (document.querySelector(".nopw-banner")) return;
  const bar = document.createElement("div");
  bar.className = "restored-banner nopw-banner";
  bar.setAttribute("role", "status");
  bar.innerHTML = `<span>🔓 Boltarr has no password — anyone on your network can change it.</span>
    <button class="btn" style="font-size:12px" onclick="openLoginSettings()">Set a password</button>
    <button class="btn-ghost" style="font-size:12px" onclick="snoozeNoPwBanner()">Not now</button>`;
  document.body.prepend(bar);
}

function snoozeNoPwBanner() {
  try { localStorage.setItem("boltarrNoPwSnooze", String(Date.now() + 30 * 86400000)); } catch (_) {}
  document.querySelector(".nopw-banner")?.remove();
}

async function openLoginSettings() {
  document.querySelector(".nopw-banner")?.remove();
  await openSettings();
  const sec = document.getElementById("setLoginSection");
  sec.open = true;
  sec.scrollIntoView({ block: "start" });
  document.getElementById("loginNewPw")?.focus();
}

async function renderLoginSettings() {
  let s;
  try { s = await api("GET", "/api/auth/settings"); } catch (_) { return; }
  const $ = id => document.getElementById(id);
  $("loginOff").hidden = !!s.enabled;
  $("loginOn").hidden = !s.enabled;
  $("loginUserName").textContent = s.username || "admin";
  $("loginTrustProxy").checked = !!s.trust_proxy;
  $("loginProxies").value = s.trusted_proxies || "";
  $("loginProxyHeader").value = s.proxy_header || "Remote-User";
  ["loginNewPw", "loginNewPw2", "loginCurPw", "loginChgPw", "loginChgPw2", "loginOffPw"].forEach(id => { $(id).value = ""; });
}

async function enableLogin() {
  const $ = id => document.getElementById(id);
  const pw = $("loginNewPw").value;
  if (pw !== $("loginNewPw2").value) return alert("The two passwords don't match.");
  try {
    await api("POST", "/api/auth/setup", { username: $("loginNewUser").value.trim() || "admin", password: pw });
  } catch (e) { return alert("Login not turned on: " + e.message); }
  showToast("Login is on — this browser stays signed in");
  await renderLoginSettings();
  await loadLoginState();
}

async function changeLoginPassword() {
  const $ = id => document.getElementById(id);
  if ($("loginChgPw").value !== $("loginChgPw2").value) return alert("The two new passwords don't match.");
  try {
    await api("POST", "/api/auth/password", { current: $("loginCurPw").value, new: $("loginChgPw").value });
  } catch (e) { return alert("Password not changed: " + e.message); }
  showToast("Password changed");
  await renderLoginSettings();
}

async function saveLoginProxy() {
  const $ = id => document.getElementById(id);
  try {
    await api("PUT", "/api/auth/settings", { trusted_proxies: $("loginProxies").value,
      proxy_header: $("loginProxyHeader").value, trust_proxy: $("loginTrustProxy").checked });
  } catch (e) { return alert("Not saved: " + e.message); }
  showToast("Saved");
  await renderLoginSettings();
}

async function disableLogin() {
  try {
    await api("POST", "/api/auth/disable", { password: document.getElementById("loginOffPw").value });
  } catch (e) { return alert("Login is still on: " + e.message); }
  showToast("Login is off");
  await renderLoginSettings();
  await loadLoginState();
}

async function logout() {
  try { await api("POST", "/api/auth/logout"); } catch (_) {}
  location.href = "/login.html";
}

registerActions({ enableLogin, changeLoginPassword, saveLoginProxy, disableLogin });
