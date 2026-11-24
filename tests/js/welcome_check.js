// U-01 v1: the welcome window on a brand-new install (one window, Skip, Add my network).
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM } = require("jsdom");
const fs = require("fs");
const html = fs.readFileSync(`${BOLTARR}/frontend/index.html`, "utf8");
const body = html.slice(html.indexOf("<body"), html.indexOf("<script src=\"/js/graph.js\""));
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function boot(welcome) {
  const dom = new JSDOM(body + "</body>", { runScripts: "outside-only", pretendToBeVisual: true, url: "http://x.test/" });
  const w = dom.window, d = w.document;
  w.TextDecoder = TextDecoder; w.CSS = { escape: s => String(s) };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.localStorage.setItem("boltarr.viewLevel", "basic");
  const calls = [], subnets = [];
  w.fetch = async (u, o = {}) => {
    const m = o.method || "GET";
    calls.push(`${m} ${u.replace(/^.*\/api/, "/api")}${o.body ? " " + o.body : ""}`);
    let r = [];
    if (u.endsWith("/api/ui/welcome")) r = welcome;
    else if (u.endsWith("/api/ui/welcome/done")) r = { ok: true };
    else if (u.endsWith("/api/subnets") && m === "POST") { const b = JSON.parse(o.body); subnets.push({ id: 1, ...b }); r = subnets[0]; }
    else if (u.endsWith("/api/subnets")) r = subnets;
    else if (u.endsWith("/api/settings/all")) r = { ok: true };
    else if (u.endsWith("/api/settings")) r = { general: { timezone: welcome.timezone || "" }, llm: {}, statuspage: {}, notifications: {}, change_tracking: {}, liveness: {}, ip_history: {}, ai_history: {}, security: {}, change_alerts: {} };
    else if (u.includes("/api/auth/status")) r = { enabled: true };
    else if (u.includes("/api/ui/start-level")) r = { level: "basic" };
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
  };
  w.cytoscape = () => new Proxy({}, { get: () => () => ({}) });
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/level.js`, "utf8"));
  w.eval(["markdown", "export", "chat", "peek", ...require("./appfiles"), "fitcols", "search"].map(f => fs.readFileSync(`${BOLTARR}/frontend/js/${f}.js`, "utf8")).join("\n;\n"));
  d.dispatchEvent(new w.Event("DOMContentLoaded"));
  await sleep(250);
  const $ = s => d.querySelector(s);
  const click = async s => { $(s).dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await sleep(80); };
  return { w, d, $, click, calls };
}

(async () => {
  // A brand-new install
  let b = await boot({ show: true, network: "10.9.0.0/24", timezone: "" });
  const modal = () => b.$("#welcomeModal").classList.contains("open");
  check(modal(), "a new install opens the welcome window");
  check(b.$("#welcomeNet").value === "10.9.0.0/24", "…with the network filled in");
  const guess = Intl.DateTimeFormat().resolvedOptions().timeZone;
  check(b.$("#welcomeTz").options.length > 10 && b.$("#welcomeTz").value === guess, `…and the browser's timezone picked (${b.$("#welcomeTz").value})`);
  check(b.$('#welcomeModal [data-level-pick="basic"]').classList.contains("active") || b.$('#welcomeModal [data-level-pick="basic"]').getAttribute("aria-pressed") === "true", "…with Basic shown as chosen");
  check(b.$('#welcomeModal a[href*="/wiki"]') && b.$('#welcomeModal a[href*="/wiki"]').target === "_blank", "a link to the wiki, opening in a new tab");
  check(b.$("#welcomeNetHelp").hidden, "the (?) help starts closed");
  await b.click('#welcomeModal [data-click="toggleWelcomeNetHelp"]');
  check(!b.$("#welcomeNetHelp").hidden && /every address/.test(b.$("#welcomeNetHelp").textContent), "(?) shows what the network field means");
  await b.click('#welcomeModal [data-level-pick="intermediate"]');
  check(b.d.documentElement.dataset.level === "intermediate", "picking a level applies it straight away");
  b.$("#welcomeTz").value = "Europe/Berlin";
  await b.click("#welcomeStartBtn");
  const has = s => b.calls.some(c => c.includes(s));
  check(has('PUT /api/settings/all {"general":{"timezone":"Europe/Berlin"}}'), "Add my network saves the timezone");
  check(has('POST /api/subnets {"name":"My network","cidr":"10.9.0.0/24"}'), "…adds the network");
  check(has("POST /api/ui/welcome/done"), "…marks the welcome done");
  check(!modal() && b.$("#panel-subnets").classList.contains("active"), "…closes and shows the Subnets page");

  // Skip
  b = await boot({ show: true, network: "10.9.0.0/24", timezone: "UTC" });
  check(b.$("#welcomeTz").value === "UTC", "a saved timezone wins over the browser's guess");
  await b.click('#welcomeModal [data-click="skipWelcome"]');
  check(!b.$("#welcomeModal").classList.contains("open") && b.calls.some(c => c.includes("POST /api/ui/welcome/done"))
        && !b.calls.some(c => c.startsWith("POST /api/subnets")), "Skip closes it, marks it done, adds nothing");

  // Not a new install; Settings can open it again
  b = await boot({ show: false, network: null, timezone: "" });
  check(!b.$("#welcomeModal").classList.contains("open"), "an install with data doesn't open it");
  b.w.setTab("settings"); await sleep(50);
  await b.click('#set-pane-general [data-click="openWelcome"]');
  check(b.$("#welcomeModal").classList.contains("open"), "Settings → General → Show the welcome again opens it");
  check(b.$("#welcomeNet").value === "", "…with an empty network when none could be guessed");
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
