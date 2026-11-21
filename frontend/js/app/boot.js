// Boltarr — Start-up and login state. Loads last: its DOMContentLoaded runs after the others.
// Part of the app split from app.js (F-08); files share globals and load in order (see index.html).

// ── Init ──────────────────────────────────────────────────────────────────────

async function initAiStatus() {
  try {
    const { llm, statuspage } = await api("GET", "/api/settings");
    updateAiStatusDot(llm.configured);
    setFeatureReady("sp", !!statuspage?.enabled);
  } catch (_) {}
}

document.addEventListener("DOMContentLoaded", () => { boot(); initAiStatus(); initViewLevel(); initWelcome(); });


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
    <button class="btn" style="font-size:12px" data-click="openLoginSettings">Set a password</button>
    <button class="btn-ghost" style="font-size:12px" data-click="snoozeNoPwBanner">Not now</button>`;
  document.body.prepend(bar);
}

function snoozeNoPwBanner() {
  try { localStorage.setItem("boltarrNoPwSnooze", String(Date.now() + 30 * 86400000)); } catch (_) {}
  document.querySelector(".nopw-banner")?.remove();
}

async function openLoginSettings() {
  document.querySelector(".nopw-banner")?.remove();
  setTab("settings");
  setSettingsTab("security");
  document.getElementById("loginNewPw")?.focus();
}

// The login-service fields are settings (saved with the Settings save bar); the rest of
// the Login part are actions with their own buttons. After an action (keepEdits) the
// login-service fields keep any change not saved yet.
let _loginProxySaved = null;
function loginProxyValues() {
  const $ = id => document.getElementById(id);
  return { trust_proxy: $("loginTrustProxy").checked, trusted_proxies: $("loginProxies").value,
           proxy_header: $("loginProxyHeader").value };
}
function loginProxyChanged() {
  return !!_loginProxySaved && JSON.stringify(loginProxyValues()) !== JSON.stringify(_loginProxySaved);
}

async function renderLoginSettings(keepEdits = false) {
  let s;
  try { s = await api("GET", "/api/auth/settings"); } catch (_) { return; }
  const $ = id => document.getElementById(id);
  $("loginOff").hidden = !!s.enabled;
  $("loginOn").hidden = !s.enabled;
  $("loginUserName").textContent = s.username || "admin";
  const edited = keepEdits && loginProxyChanged();
  _loginProxySaved = { trust_proxy: !!s.trust_proxy, trusted_proxies: s.trusted_proxies || "",
                       proxy_header: s.proxy_header || "Remote-User" };
  levelInUse("proxy", _loginProxySaved.trust_proxy);
  if (!edited) {
    $("loginTrustProxy").checked = _loginProxySaved.trust_proxy;
    $("loginProxies").value = _loginProxySaved.trusted_proxies;
    $("loginProxyHeader").value = _loginProxySaved.proxy_header;
  }
  loginProxyCheck();
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
  await renderLoginSettings(true);
  await loadLoginState();
}

async function changeLoginPassword() {
  const $ = id => document.getElementById(id);
  if ($("loginChgPw").value !== $("loginChgPw2").value) return alert("The two new passwords don't match.");
  try {
    await api("POST", "/api/auth/password", { current: $("loginCurPw").value, new: $("loginChgPw").value });
  } catch (e) { return alert("Password not changed: " + e.message); }
  showToast("Password changed");
  await renderLoginSettings(true);
}

// F-35: a whole range (e.g. 172.18.0.0/16) trusts every device in it — say so under the box.
function loginProxyCheck() {
  const box = document.getElementById("loginProxies"), warn = document.getElementById("loginProxiesWarn");
  if (!box || !warn) return;
  const wide = box.value.split(/[,\n]/).map(x => x.trim()).filter(x => {
    const m = x.match(/\/(\d+)$/);
    return m && +m[1] < (x.includes(":") ? 128 : 32);
  });
  warn.textContent = wide.length ? `${wide.join(", ")} ${wide.length > 1 ? "are whole ranges" : "is a whole range"}: every device ` +
    `or container in it is trusted to say who is logged in. Use the login service's own IP (e.g. 172.18.0.5) if you can.` : "";
  warn.hidden = !wide.length;
}

// Saved by the Settings save bar (saveSettings), only when changed
async function saveLoginProxy() {
  if (!loginProxyChanged()) return;
  await api("PUT", "/api/auth/settings", loginProxyValues());
  await renderLoginSettings();
}

async function disableLogin() {
  try {
    await api("POST", "/api/auth/disable", { password: document.getElementById("loginOffPw").value });
  } catch (e) { return alert("Login is still on: " + e.message); }
  showToast("Login is off");
  await renderLoginSettings(true);
  await loadLoginState();
}

async function logout() {
  try { await api("POST", "/api/auth/logout"); } catch (_) {}
  location.href = "/login.html";
}

registerActions({ enableLogin, changeLoginPassword, loginProxyCheck, disableLogin, logout, openLoginSettings, snoozeNoPwBanner });
