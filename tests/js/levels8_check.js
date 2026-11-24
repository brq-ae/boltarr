// S-15 step 8: at Basic, AI and public status page controls hide while that feature isn't set up.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM } = require("jsdom");
const fs = require("fs");
const html = fs.readFileSync(`${BOLTARR}/frontend/index.html`, "utf8");
const body = html.slice(html.indexOf("<body"), html.indexOf("<script src=\"/js/graph.js\""));
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function boot(level, data = {}, store = {}) {
  const dom = new JSDOM(body + "</body>", { runScripts: "outside-only", pretendToBeVisual: true, url: "http://x.test/" });
  const w = dom.window, d = w.document;
  w.TextDecoder = TextDecoder; w.CSS = { escape: s => String(s) };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.localStorage.setItem("boltarr.viewLevel", level);
  for (const [k, v] of Object.entries(store)) w.localStorage.setItem(k, JSON.stringify(v));
  const H = { id: 1, ip: "10.9.0.20", hostname: "demo-box", ports: [], aliases: [], services: [], analyses: data.analyses || [], public: data.hostPublic ? 1 : 0 };
  const S = [{ id: 7, name: "Demo web", host_ip: "10.9.0.20", port: 80, status: "up", public: data.svcPublic ? 1 : 0 }];
  const settings = {
    general: { timezone: "UTC" }, notifications: {}, llm: { provider: data.ai ? "ollama" : "none", configured: !!data.ai },
    statuspage: { enabled: !!data.sp }, change_tracking: {}, liveness: {}, ip_history: {}, ai_history: {}, security: {},
    change_alerts: { enabled: true, digest_ai: !!data.digestAi },
  };
  w.fetch = async u => {
    let r = [];
    if (u.endsWith("/api/settings")) r = settings;
    else if (u.endsWith("/ssh-access")) r = [];
    else if (/\/api\/hosts\/10/.test(u)) r = H;
    else if (u.endsWith("/api/hosts")) r = [H];
    else if (u.endsWith("/api/services")) r = S;
    else if (u.includes("/api/auth/status")) r = { enabled: true };
    else if (u.includes("/api/auth/settings")) r = { enabled: true };
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
  };
  w.cytoscape = () => new Proxy({}, { get: () => () => ({}) });
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/level.js`, "utf8"));
  w.eval(["markdown", "export", "chat", "peek", ...require("./appfiles"), "fitcols", "search"].map(f => fs.readFileSync(`${BOLTARR}/frontend/js/${f}.js`, "utf8")).join("\n;\n"));
  await sleep(200);
  await w.initAiStatus(); await sleep(20);
  const $ = s => d.querySelector(s);
  const hid = e => w.isLevelHidden(e);
  const chat = () => $('header [data-click="toggleChat"]'), anet = () => $('[data-click="openNetworkAnalysis"]');
  const svcHidden = () => d.getElementById("servicesTable").classList.contains("hide-svc-pub");
  const panel = async () => { await w.showHostDetail("10.9.0.20"); await sleep(30); };
  const tab = t => $(`.detail-tab[data-tab="${t}"]`);
  return { w, d, $, hid, chat, anet, svcHidden, panel, tab };
}

(async () => {
  // Nothing set up
  let b = await boot("basic");
  check(b.d.documentElement.dataset.ai === "off" && b.d.documentElement.dataset.sp === "off", "the app knows AI and the status page aren't set up");
  check(b.hid(b.chat()) && b.hid(b.anet()), "Basic, no AI: Chat and Analyze Network hidden");
  await b.panel();
  check(b.hid(b.$('[data-click="analyzeHost"]')) && b.hid(b.$("#analyzeModel")) && b.hid(b.tab("analysis")), "…device panel: Analyze, its model list and the Analysis tab hidden");
  check(!b.hid(b.tab("info")) && !b.hid(b.$('[data-click="openEditHost"]')), "…Info and Edit still there");
  b.w.setTab("settings"); await b.w.loadSettings(); await sleep(20);
  check(b.hid(b.$("#setCaDigestAi")) && b.hid(b.$("#setCaDigestAiModel")) && !b.hid(b.$('[data-click="previewDigest"]')), "…digest: AI summary line hidden, Preview digest stays");
  check(!b.hid(b.$("#setTabBtn-ai")) && !b.hid(b.$("#setTabBtn-statuspage")), "…Settings AI and Status page tabs still show (to set them up)");
  check(b.svcHidden(), "Basic, status page off: Services Public column hidden");
  const order = [...b.d.getElementById("svcColMenu").children].map(n => n.matches(".col-menu-head") ? "|" : n.querySelector("input").dataset.col).join(",");
  check(order === "icon,host,ps,mon,url,|,desc,pub", `…listed under More at Intermediate in Columns ▾ (${order})`);
  await b.w.openAddService(); await sleep(20);
  check(b.hid(b.$("#svcModalPublic")), "…Service window: Show publicly hidden");
  await b.w.openEditHost("10.9.0.20"); await sleep(20);
  check(b.hid(b.$("#editPublic")), "…Edit Host: Public hidden");

  b.w.setViewLevel("intermediate");
  check(!b.hid(b.chat()) && !b.hid(b.anet()) && !b.hid(b.tab("analysis")) && !b.hid(b.$("#editPublic")) && !b.svcHidden(), "Intermediate: all of it shows, as today");
  b.w.setViewLevel("advanced");
  check(!b.hid(b.chat()) && !b.svcHidden() && !b.hid(b.$("#setCaDigestAi")), "Advanced: as today");

  // Set up
  b = await boot("basic", { ai: true, sp: true });
  await b.panel();
  check(!b.hid(b.chat()) && !b.hid(b.anet()) && !b.hid(b.$('[data-click="analyzeHost"]')) && !b.hid(b.tab("analysis")), "Basic, AI set up: Chat, Analyze Network, Analyze, Analysis show");
  check(!b.chat().querySelector(".lvl-tag") && !b.tab("analysis").querySelector(".lvl-tag"), "…with no grey tag");
  check(!b.svcHidden() && !b.d.querySelector('#svcColMenu .lvl-tag'), "Basic, status page on: Public column shows, no tag");
  check(JSON.parse(b.w.localStorage.getItem("boltarr.ready")).ai === true, "remembered in this browser");

  // Turned on / off without a reload
  b = await boot("basic");
  b.w.updateAiStatusDot(true); b.w.setFeatureReady("sp", true);
  check(!b.hid(b.chat()) && !b.svcHidden(), "setting AI and the status page up shows them straight away");
  b.w.updateAiStatusDot(false);
  check(b.hid(b.chat()), "…turning AI off hides them again");

  // Yours keeps showing
  b = await boot("basic", { analyses: [{ id: 1, model: "demo", result: "Demo result", created_at: "2026-11-01T10:00:00Z" }], hostPublic: true, svcPublic: true, digestAi: true });
  await b.panel();
  check(!b.hid(b.tab("analysis")) && b.hid(b.$('[data-click="analyzeHost"]')), "Basic, no AI: a device with earlier AI results keeps its Analysis tab (Analyze still hidden)");
  check(!b.svcHidden(), "…a public service keeps the Public column");
  await b.w.openEditHost("10.9.0.20"); await sleep(20);
  check(!b.hid(b.$("#editPublic")), "…a public device keeps Public in Edit Host");
  b.w.openEditService(7); await sleep(20);
  check(!b.hid(b.$("#svcModalPublic")), "…a public service keeps Show publicly");
  b.w.setTab("settings"); await b.w.loadSettings(); await sleep(20);
  check(!b.hid(b.$("#setCaDigestAi")), "…an AI summary that's ticked stays in view");

  // On Analysis without AI and no results: Basic goes back to Info
  b = await boot("advanced");
  await b.panel(); b.w.switchDetailTab("analysis"); b.w.setViewLevel("basic");
  check(b.tab("info").classList.contains("active"), "on Analysis, switching to Basic (no AI) goes back to Info");

  // Before the app checks: what this browser last saw
  b = await boot("basic", { ai: true }, { "boltarr.ready": { ai: false, sp: false } });
  check(!b.hid(b.chat()), "the app's check wins over what this browser remembered");

  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
