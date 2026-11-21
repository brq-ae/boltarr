// Boltarr — Welcome window (U-01, first version): one window on a brand-new install.
// Part of the app split from app.js (F-08); files share globals and load in order (see index.html).
//
// Shown once when Boltarr has no networks or devices yet (never on an upgrade); the
// server keeps "done", so other browsers don't show it again. Settings → General can
// open it again at any time.

const WIKI_URL = "https://github.com/brq-ae/boltarr/wiki";

async function initWelcome() {
  let w;
  try { w = await api("GET", "/api/ui/welcome"); } catch (_) { return; }
  if (w.show) openWelcome(w);
}

// `w` = the server's answer; Settings → General passes none and asks for it
async function openWelcome(w) {
  if (!w) { try { w = await api("GET", "/api/ui/welcome"); } catch (_) { w = {}; } }
  populateTimezones(document.getElementById("welcomeTz"));
  let guess = "";
  try { guess = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (_) {}
  const tz = document.getElementById("welcomeTz"), want = w.timezone || guess;
  // browsers don't list every name (e.g. "UTC"); add the one we want if it's missing
  if (want && ![...tz.options].some(o => o.value === want)) tz.add(new Option(want, want));
  tz.value = want;
  document.getElementById("welcomeNet").value = w.network || "";
  document.getElementById("welcomeNetHelp").hidden = true;
  document.getElementById("welcomeModal").classList.add("open");
}

function toggleWelcomeNetHelp() {
  const h = document.getElementById("welcomeNetHelp");
  h.hidden = !h.hidden;
}

async function _welcomeFinish() {
  try { await api("POST", "/api/ui/welcome/done"); } catch (_) {}
  document.getElementById("welcomeModal").classList.remove("open");
}

async function skipWelcome() { await _welcomeFinish(); }

// Save the timezone, add the network, then show it on the Subnets page ready to scan
async function welcomeStart() {
  const tz = document.getElementById("welcomeTz").value;
  const cidr = document.getElementById("welcomeNet").value.trim();
  const btn = document.getElementById("welcomeStartBtn");
  btn.disabled = true;
  try {
    if (tz !== (APP_TZ || "")) {
      await api("PUT", "/api/settings/all", { general: { timezone: tz } });
      APP_TZ = tz;
    }
    if (cidr && !subnets.some(s => s.cidr === cidr)) {
      await api("POST", "/api/subnets", { name: "My network", cidr });
      await loadSubnets();
    }
  } catch (e) {
    btn.disabled = false;
    return alert("Couldn't save: " + e.message);
  }
  btn.disabled = false;
  await _welcomeFinish();
  setTab("subnets");
  if (cidr) showToast("Network added. Press ▶ Scan to find your devices.");
}

registerActions({ openWelcome: () => openWelcome(), toggleWelcomeNetHelp, skipWelcome, welcomeStart });
