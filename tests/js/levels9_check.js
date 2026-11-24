// S-15 step 9a: search finds what your level hides (Features group) and opens it for one visit.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM } = require("jsdom");
const fs = require("fs");
const html = fs.readFileSync(`${BOLTARR}/frontend/index.html`, "utf8");
const body = html.slice(html.indexOf("<body"), html.indexOf("<script src=\"/js/graph.js\""));
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function boot(level, data = {}) {
  const dom = new JSDOM(body + "</body>", { runScripts: "outside-only", pretendToBeVisual: true, url: "http://x.test/" });
  const w = dom.window, d = w.document;
  w.TextDecoder = TextDecoder; w.CSS = { escape: s => String(s) };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.localStorage.setItem("boltarr.viewLevel", level);
  const H = { id: 1, ip: "10.9.0.20", hostname: "demo-box", ports: [], aliases: [], services: [], analyses: [] };
  const settings = {
    general: { timezone: "UTC" }, notifications: { check_seconds: 60 }, llm: { provider: data.ai ? "ollama" : "none", configured: !!data.ai },
    statuspage: { enabled: false }, change_tracking: { enabled: true }, liveness: { enabled: true, interval_minutes: 3 }, ip_history: {}, ai_history: {},
    security: { frame_origins: "" }, change_alerts: { enabled: true, scope: "static", include_aliases: true },
  };
  w.fetch = async u => {
    let r = [];
    if (u.endsWith("/api/settings")) r = settings;
    else if (u.endsWith("/ssh-access")) r = [];
    else if (/\/api\/hosts\/10/.test(u)) r = H;
    else if (u.endsWith("/api/hosts")) r = [H];
    else if (u.endsWith("/api/services")) r = [{ id: 7, name: "Demo web", host_ip: "10.9.0.20", port: 80, status: "up" }];
    else if (u.includes("/api/auth/status")) r = { enabled: true };
    else if (u.includes("/api/auth/settings")) r = { enabled: true };
    else if (u.includes("/api/maintenance-windows")) r = { windows: [] };
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
  };
  w.cytoscape = () => new Proxy({}, { get: () => () => ({}) });
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/level.js`, "utf8"));
  w.eval(["markdown", "export", "chat", "peek", ...require("./appfiles"), "fitcols", "search"].map(f => fs.readFileSync(`${BOLTARR}/frontend/js/${f}.js`, "utf8")).join("\n;\n"));
  await sleep(200);
  await w.initAiStatus(); await sleep(20);
  const $ = s => d.querySelector(s);
  const type = async q => { const i = $("#gsInput"); i.value = q; i.dispatchEvent(new w.Event("input")); await sleep(10); };
  const feats = () => [...d.querySelectorAll("#gsResults .gs-item")].filter(e => e.querySelector(".gs-feat-ico")).map(e => e.querySelector(".gs-title").textContent.trim());
  const pick = async name => {
    const el = [...d.querySelectorAll("#gsResults .gs-item")].find(e => e.querySelector(".gs-title").textContent.includes(name));
    el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await sleep(60);
  };
  const hid = e => w.isLevelHidden(e);
  return { w, d, $, type, feats, pick, hid };
}

(async () => {
  let b = await boot("basic");
  await b.type("vlan");
  check(b.feats().length === 1 && b.feats()[0].startsWith("VLANs") && b.feats()[0].includes("Advanced"), `Basic: "vlan" finds VLANs, tagged Advanced (${b.feats()})`);
  check(b.$("#gsResults").textContent.includes("Features"), "…under a Features group");
  check(b.$("#gsResults").textContent.includes("See 1 result on the Search page"), "one match: \"See 1 result\" (not \"1 results\")");
  await b.type("v");
  check(b.feats().length === 0, "one letter doesn't list features");
  await b.type("ssh");
  check(b.feats().some(f => f.startsWith("SSH Keys")) && b.feats().some(f => f.startsWith("SSH access for a device")), `"ssh": SSH Keys page and a device's SSH (${b.feats()})`);
  await b.pick("SSH Keys");
  check(b.$("#panel-sshkeys").classList.contains("active") && !b.hid(b.$('.sidebar-nav-item[data-tab="sshkeys"]')), "picking SSH Keys opens the page for this visit");
  b.w.setTab("hosts");
  check(b.hid(b.$('.sidebar-nav-item[data-tab="sshkeys"]')), "…and it hides again after you leave");

  await b.type("danger");
  await b.pick("Danger zone");
  check(b.$("#panel-settings").classList.contains("active") && !b.$("#set-pane-data").hidden && !b.hid(b.$(".set-danger")), "Danger zone: Settings → Data opens, the card shows");
  check(b.$(".set-danger").classList.contains("lvl-flash"), "…and is pointed out");
  b.w.setTab("hosts");
  check(b.hid(b.$(".set-danger")), "…hidden again after leaving Settings");

  await b.type("check interval");
  await b.pick("Service check interval");
  const fold = b.$("#setCheckSeconds").closest(".lvl-fold");
  check(!b.$("#set-pane-monitoring").hidden && fold && !fold.querySelector(".lvl-fold-body").hidden, "a folded setting: its tab opens with More options open");
  await b.w.loadSettings(); await sleep(20);
  check(!fold.querySelector(".lvl-fold-body").hidden, "…stays open when the settings finish loading");

  await b.type("schedule");
  await b.pick("Scan schedules");
  check(b.$("#scan-panel-schedules").style.display !== "none" && !b.hid(b.$("#scanTabBtn-schedules")), "Scan schedules: Scans → Schedules opens");

  await b.type("timing");
  check(b.feats().some(f => f.startsWith("Scan timing")) && b.feats().some(f => f.startsWith("Device up/down sweep timing")), `"timing": scan timing and liveness timing (${b.feats()})`);
  await b.pick("Scan timing");
  check(!b.hid(b.$("#scanTiming")), "Scan timing: the row shows in Scans → Run");

  await b.type("multi");
  await b.pick("Multi-Link");
  check(b.$("#panel-topology").classList.contains("active") && !b.hid(b.$("#multiConnBtn")), "Multi-Link: Topology opens, the button shows");

  await b.type("merge");
  check(b.$("#gsResults").textContent.includes("On a device's panel"), "Merge is marked as on a device's panel");
  await b.pick("Merge");
  check(b.$("#panel-hosts").classList.contains("active"), "…with no device open: goes to Hosts (and says open a device first)");
  await b.w.showHostDetail("10.9.0.20"); await sleep(30);
  await b.type("probe"); await b.pick("Probe");
  check(!b.hid(b.$('#hostDetail [data-click="probeHost"]')), "with a device open: Probe shows on its panel");

  await b.type("chat");
  check(b.feats().some(f => f.startsWith("Chat") && f.includes("Set up AI")), `no AI: "chat" finds Chat, tagged Set up AI (${b.feats()})`);
  await b.pick("Chat");
  check(!b.$("#set-pane-ai").hidden, "…opens Settings → AI");

  await b.type("scan log");
  await b.pick("Delete scans");
  check(b.$("#scan-panel-history").classList.contains("lvl-showall"), "Delete scans: the Scan Log shows its delete controls");

  // Intermediate / Advanced
  b.w.setViewLevel("intermediate");
  await b.type("vlan");
  check(b.feats().length === 1, "Intermediate: VLANs still found");
  await b.type("schedule");
  check(b.feats().length === 0, "…Schedules isn't (it shows at Intermediate)");
  await b.type("chat");
  check(b.feats().length === 0, "…Chat isn't (not set up hides only at Basic)");
  b.w.setViewLevel("advanced");
  for (const q of ["vlan", "ssh", "danger", "timing", "chat", "merge"]) { await b.type(q); if (b.feats().length) { check(false, `Advanced: "${q}" lists features`); break; } }
  check(true, "Advanced: no Features group at all (as today)");
  check(!b.$("#gsResults").textContent.includes("Features"), "…no Features heading");

  // Something in use isn't listed (it isn't hidden)
  b = await boot("basic", { ai: true });
  await b.type("chat");
  check(b.feats().length === 0, "AI set up: Chat isn't listed (it's on screen)");

  // Search page lists them too
  await b.type("vlan");
  b.w.renderSearchPage && (b.$("#spInput").value = "vlan", b.w.renderSearchPage());
  check(b.$("#spResults").textContent.includes("VLANs") && b.$("#spCount").textContent.includes("1 feature"), "Search page lists features too");

  // Every entry points at something real, and opens without an error
  b = await boot("basic");
  const src = fs.readFileSync(`${BOLTARR}/frontend/js/app/levels.js`, "utf8");
  const list = src.slice(src.indexOf("const LEVEL_FEATURES"), src.indexOf("const _NEEDS"));
  const F = [...list.matchAll(/\{ name: "([^"]+)".*?\n/g)].map(m => ({ name: m[1], needs: /needs: "/.test(m[0]),
    at: (m[0].match(/at: (?:'([^']+)'|"([^"]+)")/) || []).slice(1).find(Boolean) }));
  const missing = F.filter(f => f.at && !f.needs && !b.d.querySelector(f.at)).map(f => f.name);
  check(!missing.length, `every feature's item exists (${missing})`);
  await b.w.showHostDetail("10.9.0.20"); await sleep(30);
  const errs = [];
  for (let i = 0; i < F.length; i++) { try { b.w.openLevelFeature(i); await sleep(15); } catch (e) { errs.push(F[i].name + ": " + e.message); } }
  check(!errs.length, `all ${F.length} open without an error (${errs})`);
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
