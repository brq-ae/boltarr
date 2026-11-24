// F-08 part B (v0.23.1): Settings + SSH use data-click/data-change/data-input actions
// instead of inline on…= handlers. Same page load as split_check.js.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const ROOT = `${BOLTARR}/frontend`;
let html = fs.readFileSync(`${ROOT}/index.html`, "utf8");
html = html.replace(/<script src="\/vendor\/[^"]+"><\/script>/g, "");
html = html.replace(/<script src="\/js\/([^"]+)"><\/script>/g, (_, f) =>
  `<script>${fs.readFileSync(`${ROOT}/js/${f}`, "utf8").replace(/<\/script>/g, "<\\/script>")}</script>`);
html = html.replace(/<link[^>]+stylesheet[^>]*>/g, "");
let fail = 0; const errors = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOSTS = [{ id: 1, ip: "10.9.0.20", hostname: "pve-box", device_type: "server", classification: "static", online: 1, ports: [], aliases: [], dhcp_warnings: [] }];
const SVCS = [{ id: 1, name: "Proxmox", ip: "10.9.0.20", port: 8006, status: "up" }];
const KEYS = [{ id: 7, name: "laptop", public_key: "ssh-ed25519 AAAA laptop", fingerprint: "SHA256:x" }];
const ACCESS = [{ id: 3, key_id: 7, name: "laptop", username: `o'brien"x`, fingerprint: "SHA256:x" }];
const warns = [];
const vc = new VirtualConsole();
vc.on("warn", (...a) => warns.push(a.join(" ")));
vc.on("jsdomError", e => errors.push(String(e.message || e)));
vc.on("error", e => errors.push(String(e)));
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://x.test/", virtualConsole: vc,
  beforeParse(w) {
    w.TextDecoder = TextDecoder;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.Element.prototype.scrollIntoView = () => {};
    // Fake Cytoscape: every property/call returns itself (empty, iterable, never a promise)
    const P = new Proxy(function () {}, { get: (t, k) => k === Symbol.iterator ? function* () {} : k === "length" ? 0
      : k === "then" || k === Symbol.toPrimitive ? undefined : P, apply: () => P });
    w.cytoscape = P;
    w.ResizeObserver = class { observe() {} disconnect() {} };
    const j = v => new w.Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    w.Response = Response;
    w.fetch = async u => { u = String(u);
      return u.endsWith("/api/hosts") ? j(HOSTS) : u.endsWith("/api/services") ? j(SVCS)
        : u.includes("/api/dhcp-warnings") ? j({ hosts: {}, pools: [] })
        : u.includes("/api/settings") ? j({ llm: { configured: false } })
        : u.includes("/api/auth/status") ? j({ enabled: false })
        : u.includes("/api/version") ? j({ version: "x" })
        : u.includes("/api/ssh-keys") ? j(KEYS)
        : u.includes("/ssh-access") ? j(ACCESS)
        : u.includes("/api/graph") ? j({ nodes: [], edges: [] })
        : j(u.includes("config") ? {} : []); };
  } });
const w = dom.window, d = w.document;
(async () => {
  await sleep(600);
  check(errors.length === 0, `boots with no errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  const A = w.eval("ACTIONS");
  const names = [...d.querySelectorAll("[data-click],[data-change],[data-input]")]
    .map(el => el.dataset.click || el.dataset.change || el.dataset.input);
  const missing = names.filter(n => typeof A[n] !== "function");
  check(names.length >= 32 && !missing.length, `all ${names.length} actions in the page are registered${missing.length ? ": missing " + missing : ""}`);
  const sec = ["panel-settings", "restoreOverlay", "panel-sshkeys"];
  const left = sec.flatMap(id => [...d.getElementById(id).querySelectorAll("*")].filter(el =>
    [...el.attributes].some(a => /^on/.test(a.name))).map(el => id));
  check(!left.length, `no inline handlers left in Settings / backup / SSH${left.length ? ": " + left : ""}`);

  // Calls go to the right function with the right arguments
  const calls = [];
  const spy = n => { const orig = A[n]; A[n] = function (...a) { calls.push([n, ...a]); }; return () => (A[n] = orig); };
  w.openSettings(); await sleep(80);
  check(d.getElementById("panel-settings").classList.contains("active"), "Settings opens as a page (S-15)");
  const bar = d.getElementById("settingsSaveBar");
  check(bar.hidden, "no save bar before a change");
  d.querySelector('[data-click="setSettingsTab"][data-args=\'["data"]\']').click();
  check(!d.getElementById("set-pane-data").hidden && d.getElementById("set-pane-general").hidden, "Data tab shows only Data");
  d.getElementById("backupProtect").dispatchEvent(new w.Event("change", { bubbles: true }));
  check(bar.hidden, "Data tab changes don't show the save bar (they act at once)");
  d.querySelector('[data-click="setSettingsTab"][data-args=\'["alerts"]\']').click();
  d.getElementById("setAlertAfter").dispatchEvent(new w.Event("input", { bubbles: true }));
  check(!bar.hidden, "a change shows the save bar");
  w.confirm = () => false; w.setTab("hosts");
  check(d.getElementById("panel-settings").classList.contains("active"), "leaving with unsaved changes asks; No stays");
  w.confirm = () => true; w.setTab("hosts"); await sleep(80);
  check(d.getElementById("panel-hosts").classList.contains("active"), "Yes leaves");
  w.setTab("settings"); await sleep(80);
  check(bar.hidden, "coming back starts clean");
  let undo = spy("testLLMConnection");
  d.querySelector('[data-click="testLLMConnection"]').click(); undo();
  check(calls.pop()?.[0] === "testLLMConnection", "⚡ Test AI button runs its action");
  undo = spy("onSettingsProviderChange");
  d.getElementById("setProvider").dispatchEvent(new w.Event("change", { bubbles: true })); undo();
  check(calls.pop()?.[0] === "onSettingsProviderChange", "provider <select> change runs its action");
  d.getElementById("resetConfirm").value = "DELETE";
  d.getElementById("resetConfirm").dispatchEvent(new w.Event("input", { bubbles: true }));
  check(!d.getElementById("resetConfirmBtn").disabled, "typing DELETE enables Factory reset (data-input)");
  let picked = 0; d.getElementById("restoreInput").click = () => picked++;
  d.querySelector('[data-click="pickRestoreFile"]').click();
  check(picked === 1, "⬆ Restore opens the file picker");
  w.eval("var __origRB = restoreBackup; restoreBackup = el => { window.__rb = el }");
  d.getElementById("restoreInput").dispatchEvent(new w.Event("change", { bubbles: true }));
  check(w.__rb === d.getElementById("restoreInput"), "choosing a file passes the input to restoreBackup");
  w.eval("restoreBackup = __origRB");
  const a = d.querySelector('#restoreBox a[data-click="focusBackup"]');
  d.getElementById("backupForm").scrollIntoView = () => {};
  const ev = new w.MouseEvent("click", { bubbles: true, cancelable: true }); a.dispatchEvent(ev);
  check(ev.defaultPrevented && d.activeElement === d.getElementById("backupPw"), "backup link goes to Backup and doesn't follow href=#");

  // SSH keys page + kebab menu
  w.setTab("sshkeys"); await sleep(80);
  check(d.querySelectorAll(".ssh-key-row").length === 1, "SSH keys list renders");
  d.querySelector('[data-click="toggleSshKeyView"]').click(); await sleep(20);
  check(d.getElementById("sshkprev-7").textContent.includes("AAAA laptop"), "👁 shows the full key (id passed via data-args)");
  d.querySelector('[data-click="toggleSshKeyMenu"]').click();
  check(d.getElementById("sshkmenu-7").classList.contains("open"), "⋮ opens the menu");
  w.eval("copySshKey = id => { window.__copied = id }");
  d.querySelector('[data-click="sshKeyMenuCopy"]').click(); await sleep(10);
  check(w.__copied === 7 && !d.getElementById("sshkmenu-7").classList.contains("open"), "menu Copy closes the menu and copies key 7");

  // Host SSH access: an awkward username survives the round trip through data-args
  A.copySshCurl = (ip, user) => { w.__curl = [ip, user]; };
  if (!d.getElementById("dtab-ssh")) { const t = d.createElement("div"); t.id = "dtab-ssh"; d.body.append(t); }
  await w.loadHostSshSection("10.9.0.20");
  const btn = d.querySelector('[data-click="copySshCurl"]');
  if (btn) { btn.click(); check(JSON.stringify(w.__curl) === JSON.stringify(["10.9.0.20", `o'brien"x`]), `deploy cmd gets ip + user with quotes intact`); }
  else check(false, "host SSH access section rendered (see function names)");
  check(!warns.length, `no unknown-action warnings${warns.length ? ": " + warns : ""}`);
  check(errors.length === 0, `no errors after all clicks${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
