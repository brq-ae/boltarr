// Boltarr login / first-run setup page
(async () => {
  const $ = id => document.getElementById(id);
  const post = async (path, body) => {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Boltarr": "1" },
                                  body: JSON.stringify(body || {}) });
    let d = {};
    try { d = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(typeof d.detail === "string" ? d.detail : "Something went wrong");
    return d;
  };
  const home = () => { location.href = "/"; };

  let st;
  try { st = await (await fetch("/api/auth/status")).json(); } catch (_) { st = {}; }
  if (st.setup_pending) {
    $("setupForm").hidden = false;
    $("suPw").focus();
  } else if (st.enabled && !st.logged_in) {
    $("loginForm").hidden = false;
    $("lgPw").focus();
  } else {
    return home();      // already in, or login is off
  }

  $("loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    $("lgErr").textContent = "";
    $("lgBtn").disabled = true;
    try {
      await post("/api/auth/login", { username: $("lgUser").value, password: $("lgPw").value });
      home();
    } catch (err) {
      $("lgErr").textContent = err.message;
      $("lgPw").select();
    } finally {
      $("lgBtn").disabled = false;
    }
  });

  $("setupForm").addEventListener("submit", async e => {
    e.preventDefault();
    $("suErr").textContent = "";
    if ($("suPw").value !== $("suPw2").value) { $("suErr").textContent = "The two passwords don't match."; return; }
    $("suBtn").disabled = true;
    try {
      await post("/api/auth/setup", { username: $("suUser").value.trim() || "admin", password: $("suPw").value });
      home();
    } catch (err) {
      $("suErr").textContent = err.message;
    } finally {
      $("suBtn").disabled = false;
    }
  });

  $("suSkip").addEventListener("click", async () => {
    try { await post("/api/auth/skip-setup"); } catch (_) {}
    home();
  });
})();
