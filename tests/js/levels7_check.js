// S-15 step 7: Settings cards per level, "More options" folds in cards, in-use cards.
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
  w.localStorage.setItem("boltarr.viewLevel", level);
  const settings = {
    general: { timezone: "UTC" }, notifications: { check_seconds: 60 }, statuspage: {}, llm: {}, ai_history: {},
    change_tracking: { enabled: true, retention_days: 90 }, liveness: { enabled: true, interval_minutes: 3, offline_after: 3 },
    change_alerts: { enabled: true, scope: "static", include_mac: false, include_aliases: true },
    ip_history: {}, security: { frame_origins: "" }, ...(data.settings || {}),
  };
  w.fetch = async u => {
    let r = [];
    if (u.endsWith("/api/settings")) r = settings;
    else if (u.endsWith("/api/subnets")) r = data.subnets || [];
    else if (u.includes("/api/auth/status")) r = { enabled: true };
    else if (u.includes("/api/auth/settings")) r = { enabled: true, username: "admin", trust_proxy: !!data.proxy, trusted_proxies: data.proxy ? "10.9.0.5" : "" };
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
  };
  w.cytoscape = () => new Proxy({}, { get: () => () => ({}) });
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/level.js`, "utf8"));
  w.eval(["markdown", "export", "chat", "peek", ...require("./appfiles"), "fitcols", "search"].map(f => fs.readFileSync(`${BOLTARR}/frontend/js/${f}.js`, "utf8")).join("\n;\n"));
  await sleep(150);
  w.setTab("settings"); await w.loadSettings(); await sleep(50);
  const $ = s => d.querySelector(s);
  const card = id => $("#" + id).closest(".set-card");
  const folded = id => !!$("#" + id).closest(".lvl-fold-body");
  const foldOpen = id => { const f = card(id).querySelector(":scope > .lvl-fold"); return !!f && !f.hidden && !f.querySelector(".lvl-fold-body").hidden; };
  const hidden = e => w.isLevelHidden(e);
  return { w, d, $, card, folded, foldOpen, hidden };
}

(async () => {
  let b = await boot("basic");
  check(["general", "alerts", "monitoring", "security", "data"].every(t => !b.hidden(b.$("#setTabBtn-" + t))), "Basic: General, Alerts, Monitoring, Login & Security, Data tabs show");
  // Alerts
  check(!b.folded("setCaEnabled") && !b.folded("setCaHostNew") && !b.folded("setCaDigest"), "Basic Device alerts: Enabled, events, digest in view");
  check(b.folded("setCaScope") && b.folded("setCaIncludeMac") && b.folded("setCaIncludeAliases"), "…Alert for, attach MAC, alias IPs folded");
  check(!b.foldOpen("setCaScope"), "…closed when they're at their defaults");
  // Monitoring
  check(!b.folded("setLvEnabled") && b.folded("setLvInterval"), "Basic liveness: Enabled shows, sweep timing folded");
  check(!b.folded("setCtEnabled") && !b.folded("setCtRetention") && b.folded("setCtHostNew") && !b.foldOpen("setCtHostNew"), "Basic Changes history: events folded (all on = default, closed)");
  check(b.folded("setCheckSeconds") && !b.foldOpen("setCheckSeconds"), "Basic Service checks: interval folded");
  check(b.hidden(b.$("#setIphCard")), "Basic: IP History card hidden");
  // Security / Data
  check(!b.hidden(b.$("#setLoginSection")) && b.hidden(b.$("#loginProxyPart")) && !b.hidden(b.$("#loginOffPw")), "Basic Login: login shows, login service in front hidden, Turn off shows");
  check(b.hidden(b.$("#setSecuritySection")) && b.hidden(b.$("#cspListBtn")), "Basic: Allowed dashboards and Strict mode hidden");
  check(!b.hidden(b.$("#backupForm")) && b.hidden(b.$(".set-danger")), "Basic Data: Backup shows, Danger zone hidden");

  b.w.setViewLevel("intermediate");
  check(!b.folded("setCaScope") && !b.folded("setLvInterval") && !b.folded("setCtHostNew") && !b.folded("setCheckSeconds"), "Intermediate: Alert for, sweep, events, check interval in view");
  check(b.folded("setCaIncludeMac") && b.folded("setCaIncludeAliases") && !b.foldOpen("setCaIncludeMac"), "Intermediate Device alerts: attach MAC and alias IPs still folded, closed");
  check(b.hidden(b.$("#setIphCard")) && b.hidden(b.$(".set-danger")) && b.hidden(b.$("#setSecuritySection")), "Intermediate: IP History (no DHCP), dashboards, Danger zone still hidden");
  b.w.setViewLevel("advanced");
  check(!b.d.querySelector("#settingsPage .lvl-fold:not([hidden])"), "Advanced: no folds");
  check(["#setIphCard", ".set-danger", "#setSecuritySection", "#loginProxyPart", "#cspListBtn"].every(s => !b.hidden(b.$(s))), "Advanced: every card shows");
  const kids = [...b.card("setCtEnabled").children].map(c => c.tagName + (c.className ? "." + c.className.split(" ")[0] : ""));
  check(kids.indexOf("DIV.scan-checks") < kids.indexOf("DIV.form-row"), "Advanced: fields back in today's order");

  // Fold opens by itself when a setting isn't at its default
  b = await boot("basic", { settings: { change_alerts: { enabled: true, scope: "all", include_aliases: true }, change_tracking: { enabled: true, port_closed: false }, notifications: { check_seconds: 30 } } });
  check(b.foldOpen("setCaScope"), "Basic: 'Alert for: all hosts' set → Device alerts fold opens by itself");
  check(b.foldOpen("setCtHostNew"), "…a Changes event turned off → that fold opens");
  check(b.foldOpen("setCheckSeconds") && !b.foldOpen("setLvInterval"), "…a changed check interval opens its fold; default sweep stays closed");
  b = await boot("basic", { settings: { change_alerts: { enabled: true, include_aliases: false } } });
  check(b.foldOpen("setCaScope"), "alias IP alerts turned off (default on) → opens");
  b.w.setViewLevel("intermediate");
  check(b.foldOpen("setCaIncludeAliases"), "…and at Intermediate too");

  // In use
  b = await boot("basic", { proxy: true, settings: { security: { frame_origins: "https://demo.lan" } } });
  check(!b.hidden(b.$("#loginProxyPart")) && b.$("#loginProxyPart .settings-sub .lvl-tag")?.textContent === "Advanced", "Basic: Login service in front shows when trusted, tagged");
  check(!b.hidden(b.$("#setSecuritySection")) && b.$("#setSecuritySection .set-card-title .lvl-tag")?.textContent === "Advanced", "Basic: Allowed dashboards shows when one is set, tagged");
  b = await boot("intermediate", { subnets: [{ id: 1, name: "Demo LAN", cidr: "10.9.0.0/24", dhcp_start: "10.9.0.100", dhcp_end: "10.9.0.200" }] });
  await b.w.loadSubnets?.(); await sleep(30);
  check(!b.hidden(b.$("#setIphCard")) && !b.hidden(b.$("#hostsTabBtn-iphistory")), "Intermediate with a DHCP range: IP History card and tab show");
  b.w.setViewLevel("basic");
  check(b.hidden(b.$("#setIphCard")), "…not at Basic");

  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
