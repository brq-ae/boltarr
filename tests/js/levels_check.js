// S-15 step 2: the view-level switch (hides nothing yet) and its safety parts.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM } = require("jsdom");
const fs = require("fs");
const html = fs.readFileSync(`${BOLTARR}/frontend/index.html`, "utf8");
const body = html.slice(html.indexOf("<body"), html.indexOf("<script src=\"/js/graph.js\""));
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function boot(start, stored) {
  const dom = new JSDOM(body + "</body>", { runScripts: "outside-only", pretendToBeVisual: true, url: "http://x.test/" });
  const w = dom.window, d = w.document;
  w.TextDecoder = TextDecoder; w.CSS = { escape: s => String(s) };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  if (stored) w.localStorage.setItem("boltarr.viewLevel", stored);
  let asked = 0;
  w.fetch = async u => {
    let r = [];
    if (u.includes("/api/ui/start-level")) { asked++; r = { level: start }; }
    else if (u.includes("/api/auth/status")) r = { enabled: true };
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
  };
  w.cytoscape = () => new Proxy({}, { get: () => () => ({}) });
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/level.js`, "utf8"));
  w.eval(["markdown", "export", "chat", "peek", ...require("./appfiles"), "fitcols", "search"].map(f => fs.readFileSync(`${BOLTARR}/frontend/js/${f}.js`, "utf8")).join("\n;\n"));
  await sleep(150);
  return { w, d, asked: () => asked };
}

(async () => {
  check(/data-lvl=/.test(html), "step 3 marks pages and sub-tabs (their checks are in levels3_check.js)");

  // Upgrade: no level in this browser, server says advanced → advanced + one-time note
  let { w, d, asked } = await boot("advanced");
  check(asked() === 1, `a browser with no level asks the server (asked ${asked()})`);
  check(d.documentElement.getAttribute("data-level") === "advanced", "upgrade starts on Advanced");
  check(w.localStorage.getItem("boltarr.viewLevel") === "advanced", "…and remembers it on this browser");
  check(!!d.querySelector(".level-banner"), "upgraders get the one-time note");
  d.querySelector('.level-banner [data-click="dismissLevelNote"]').click();
  check(!d.querySelector(".level-banner") && w.localStorage.getItem("boltarr.levelNoteSeen") === "1", "Got it hides the note for good");
  const sb = d.querySelector('.sidebar-level [data-level-pick="advanced"]');
  check(sb.classList.contains("active"), "sidebar shows Advanced as chosen");
  check(d.querySelector('#set-pane-general [data-level-pick="advanced"]').classList.contains("active"), "Settings → General shows it too");

  // Switching from the sidebar updates both, and the Settings save bar stays off
  w.setTab("settings"); await sleep(50);
  d.querySelector('.sidebar-level [data-level-pick="basic"]').click();
  check(d.documentElement.getAttribute("data-level") === "basic", "clicking Basic switches level");
  check(d.querySelector('#set-pane-general [data-level-pick="basic"]').classList.contains("active"), "Settings card follows the sidebar");
  d.querySelector('#set-pane-general [data-level-pick="intermediate"]').click();
  check(d.querySelector('.sidebar-level [data-level-pick="intermediate"]').classList.contains("active"), "sidebar follows the Settings card");
  check(d.getElementById("settingsSaveBar").hidden, "changing level never shows the Settings save bar (it isn't a server setting)");

  // Safety parts: fallbacks from a hidden page / sub-tab, hooks, in-use, show-all
  w.setViewLevel("advanced");
  d.getElementById("hostsTabBtn-iphistory").setAttribute("data-lvl", "a");
  d.querySelector('.sidebar-nav-item[data-tab="sshkeys"]').setAttribute("data-lvl", "a");
  w.setTab("hosts"); await sleep(20); w.setHostsTab("iphistory");
  let hooked = null; w.onLevelChange(l => hooked = l);
  w.setViewLevel("intermediate");
  check(hooked === "intermediate", "level-change hooks run");
  check(d.getElementById("hostsTabBtn-list").classList.contains("active"), "a hidden sub-tab you're on falls back to a visible one");
  w.setViewLevel("advanced"); w.setTab("sshkeys"); await sleep(20);
  w.setViewLevel("basic"); await sleep(20);
  check(d.getElementById("panel-topology").classList.contains("active"), "a hidden page you're on falls back to Topology");
  const ip = d.getElementById("hostsTabBtn-iphistory");
  check(w.isLevelHidden(ip), "an Advanced item is hidden at Basic");
  ip.classList.add("lvl-inuse");
  check(!w.isLevelHidden(ip), "…but not when it's in use");
  ip.classList.remove("lvl-inuse"); ip.parentElement.classList.add("lvl-showall");
  check(!w.isLevelHidden(ip), "…or when its box is opened for now");
  ip.parentElement.classList.remove("lvl-showall");
  ip.setAttribute("data-lvl", "i");
  w.setViewLevel("intermediate");
  check(!w.isLevelHidden(ip), "an Intermediate item shows at Intermediate");

  // New install: server says basic → basic, no note
  ({ w, d, asked } = await boot("basic"));
  check(d.documentElement.getAttribute("data-level") === "basic", "new install starts on Basic");
  check(!d.querySelector(".level-banner"), "new installs get no upgrade note");

  // A browser that already chose keeps it and doesn't ask
  ({ w, d, asked } = await boot("basic", "intermediate"));
  check(asked() === 0 && d.documentElement.getAttribute("data-level") === "intermediate", "a browser's own choice wins, server not asked");
  ({ w, d, asked } = await boot("basic", "bogus"));
  check(asked() === 1, `a broken saved value is replaced by the server start level (asked ${asked()})`);

  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
