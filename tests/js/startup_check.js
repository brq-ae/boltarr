// F-43: a slow start-up must not pull you off the page you picked, and the map is still
// drawn only once your data has loaded (F-13). The server's start-up answers are held back
// until the check lets them through, as on a slow Pi.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM } = require("jsdom");
const fs = require("fs");
const html = fs.readFileSync(`${BOLTARR}/frontend/index.html`, "utf8");
const body = html.slice(html.indexOf("<body"), html.indexOf("<script src=\"/js/graph.js\""));
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
process.on("unhandledRejection", () => {});   // a browser only logs an error start-up leaves uncaught
const HELD = ["/api/subnets", "/api/hosts", "/api/scans"];   // what start-up waits for

async function boot({ welcome = { show: false }, failing = [] } = {}) {
  const dom = new JSDOM(body + "</body>", { runScripts: "outside-only", pretendToBeVisual: true, url: "http://x.test/" });
  const w = dom.window, d = w.document;
  if (d.readyState !== "complete") await new Promise(r => w.addEventListener("load", r));   // jsdom's own ready event first, so start-up runs once
  w.TextDecoder = TextDecoder; w.CSS = { escape: s => String(s) };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.localStorage.setItem("boltarr.viewLevel", "advanced");
  let release, released = false;
  const gate = new Promise(r => { release = () => { released = true; r(); }; });
  const calls = [], subnets = [];
  let confirms = 0;
  w.confirm = () => { confirms++; return true; };
  w.alert = () => {};
  w.fetch = async (u, o = {}) => {
    const m = o.method || "GET", path = u.replace(/^.*?(\/api)/, "$1").split("?")[0];
    if (m === "GET" && HELD.includes(path) && !released) await gate;
    calls.push({ call: `${m} ${path}`, released });
    if (m === "GET" && failing.includes(path)) return new Response('{"detail":"demo failure"}', { status: 500 });
    let r = [];
    if (path === "/api/ui/welcome") r = welcome;
    else if (path === "/api/subnets" && m === "POST") { subnets.push({ id: 1, ...JSON.parse(o.body) }); r = subnets[0]; }
    else if (path === "/api/subnets") r = subnets;
    else if (path === "/api/graph") r = { nodes: [], edges: [] };
    else if (path === "/api/settings") r = { general: {}, llm: {}, statuspage: {}, notifications: {}, change_tracking: {}, liveness: {}, ip_history: {}, ai_history: {}, security: {}, change_alerts: {} };
    else if (path === "/api/auth/status") r = { enabled: false };
    else if (path === "/api/version") r = { version: "9.9.9" };
    else if (path === "/api/ui/start-level") r = { level: "advanced" };
    else if (/\/(done|all)$/.test(path) || path === "/api/backup") r = { ok: true };
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
  };
  w.cytoscape = () => new Proxy({}, { get: () => () => ({}) });
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/level.js`, "utf8"));
  w.eval(["markdown", "export", "chat", "peek", ...require("./appfiles"), "fitcols", "search"].map(f => fs.readFileSync(`${BOLTARR}/frontend/js/${f}.js`, "utf8")).join("\n;\n"));
  d.dispatchEvent(new w.Event("DOMContentLoaded"));
  await sleep(150);                                      // scripts running, start-up still waiting
  const $ = s => d.querySelector(s);
  const finish = async () => { release(); await sleep(300); };
  const on = name => $("#panel-" + name).classList.contains("active");
  const graphLoads = () => calls.filter(c => c.call === "GET /api/graph");
  return { w, d, $, finish, on, graphLoads, calls, confirms: () => confirms };
}

(async () => {
  // 1. Nobody clicks: you land on Topology, and the map is drawn once, after the data
  let b = await boot();
  check(b.graphLoads().length === 0, "the map waits for your data before it is drawn");
  await b.finish();
  check(b.on("topology") && b.$("#topbarTitle").textContent === "Topology", "nothing clicked: Topology shows");
  check(b.graphLoads().length === 1 && b.graphLoads()[0].released, "…and the map is drawn once, after your data loaded (F-13)");

  // 2. Hosts clicked during start-up: you stay there
  b = await boot();
  b.w.setTab("hosts"); await sleep(50);
  await b.finish();
  check(b.on("hosts") && !b.on("topology"), "Hosts picked during start-up: you stay on Hosts");
  check(b.$("#topbarTitle").textContent !== "Topology", `…with its own title (${b.$("#topbarTitle").textContent})`);

  // 3. Settings edited during start-up: no "unsaved changes" question, still on Settings
  b = await boot();
  b.w.setTab("settings"); await sleep(100);
  const field = b.$("#set-pane-general input, #set-pane-general select");
  field.dispatchEvent(new b.w.Event("input", { bubbles: true })); field.dispatchEvent(new b.w.Event("change", { bubbles: true }));
  await sleep(50);
  await b.finish();
  check(b.on("settings"), "Settings open during start-up: you stay on Settings");
  check(b.confirms() === 0, `…and are never asked about unsaved changes (${b.confirms()} asked)`);

  // 4. Hierarchy open during start-up: it stays, and the map is drawn from the loaded data
  b = await boot();
  b.w.setTab("hierarchy"); await sleep(50);
  await b.finish();
  check(b.on("hierarchy") && !b.on("topology"), "Hierarchy open during start-up: it stays");

  // 5. Topology clicked during start-up: the map is drawn again once the data is in
  b = await boot();
  b.w.setTab("topology"); await sleep(50);
  await b.finish();
  check(b.on("topology") && b.graphLoads().some(c => c.released), "Topology clicked early: the map is redrawn with your data");

  // 6. The phone menu open during start-up stays open
  b = await boot();
  b.w.toggleSidebar();
  await b.finish();
  check(b.$("#sidebar").classList.contains("open"), "an open phone menu isn't closed by start-up");

  // 7. A new user's Add my network: they stay on Subnets
  b = await boot({ welcome: { show: true, network: "10.9.0.0/24", timezone: "UTC" } });
  b.$("#welcomeStartBtn").dispatchEvent(new b.w.MouseEvent("click", { bubbles: true })); await sleep(150);
  await b.finish();
  check(b.on("subnets"), "Add my network during start-up: the new user stays on Subnets");

  // 8. Backup works from the first moment
  b = await boot();
  const ev = new b.w.Event("submit", { bubbles: true, cancelable: true });
  b.$("#backupForm").dispatchEvent(ev);
  check(ev.defaultPrevented, "Backup pressed during start-up is handled by Boltarr (no page reload)");
  await b.finish();

  // 9. One start-up load fails (F-44): start-up still finishes and says so
  b = await boot({ failing: ["/api/hosts"] });
  await b.finish();
  const toast = b.$("#_toast");
  check(toast && /Couldn't load everything/.test(toast.textContent) && toast.classList.contains("toast-show"), "a failed load: you are told to refresh");
  check(toast && toast.getAttribute("role") === "status", "…and a screen reader announces it");
  check(b.$("#appVersion").textContent === "v9.9.9", "…the version still shows");
  check(!!b.$(".nopw-banner"), "…the no-password reminder still shows");
  const ev2 = new b.w.Event("submit", { bubbles: true, cancelable: true });
  b.$("#backupForm").dispatchEvent(ev2);
  check(ev2.defaultPrevented, "…and Backup still works");
  await sleep(3000);
  check(!!toast?.classList.contains("toast-show"), "…the message stays up long enough to read (3 s+)");

  // 10. Subnets fail: the map is not drawn without them (hidden subnets would show)
  b = await boot({ failing: ["/api/subnets"] });
  await b.finish();
  check(b.graphLoads().length === 0, "subnets failed: the map isn't drawn with missing data");
  check(/Couldn't load everything/.test(b.$("#_toast")?.textContent || ""), "…and you are told to refresh");

  // 11. Nothing fails: no message
  b = await boot();
  await b.finish();
  check(!b.$("#_toast")?.classList.contains("toast-show"), "nothing failed: no message");

  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
