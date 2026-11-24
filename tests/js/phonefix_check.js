// Phone fixes: menus stay on screen; × in the host sheet's handle closes it.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM } = require("jsdom");
const fs = require("fs");
const html = fs.readFileSync(`${BOLTARR}/frontend/index.html`, "utf8");
const body = html.slice(html.indexOf("<body"), html.indexOf("<script src=\"/js/graph.js\""));
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const dom = new JSDOM(body + "</body>", { runScripts: "outside-only", pretendToBeVisual: true, url: "http://x.test/" });
  const w = dom.window, d = w.document;
  w.TextDecoder = TextDecoder; w.innerWidth = 390;
  w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(d.documentElement, "clientWidth", { get: () => 390 });
  // Menu box: 210px wide, right edge at the button's right (x=150) unless style.right moves it
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    if (!this.classList.contains("col-menu")) return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    const shift = parseFloat(this.style.right) || 0, right = 150 - shift;
    return { left: right - 210, right, top: 0, bottom: 0, width: 210, height: 200 };
  };
  const H = { ip: "10.9.0.20", hostname: "box", ports: [], aliases: [], services: [], ssh_access: [] };
  w.fetch = async u => new Response(JSON.stringify(/\/api\/hosts\/10/.test(u) ? H : u.endsWith("/api/hosts") ? [H] : []), { headers: { "content-type": "application/json" } });
  w.cytoscape = () => new Proxy({}, { get: () => () => ({}) });
  w.eval(["markdown", "export", "chat", "peek", ...require("./appfiles"), "fitcols", "search"].map(f => fs.readFileSync(`${BOLTARR}/frontend/js/${f}.js`, "utf8")).join("\n;\n"));
  await sleep(200);
  d.getElementById("colMenuBtn").click(); await sleep(5);
  const m = d.getElementById("colMenu"), r = m.getBoundingClientRect();
  check(m.classList.contains("open") && r.left >= 8 && r.right <= 382, `Columns menu inside the screen (left ${r.left}, right ${r.right})`);
  d.querySelector('[data-export-btn]').click(); await sleep(5);
  const e = d.querySelector(".export-wrap .col-menu"), er = e.getBoundingClientRect();
  check(e.classList.contains("open") && er.left >= 8, `Export menu inside the screen (left ${er.left})`);

  await w.showHostDetail("10.9.0.20"); await sleep(20);
  const panel = d.getElementById("hostDetail");
  check(panel.classList.contains("open"), "host sheet open");
  const x = d.querySelector("#sheetHandle .sheet-close");
  const before = panel.className;
  const t = { clientY: 300, identifier: 1, target: x };
  x.dispatchEvent(new w.TouchEvent("touchstart", { bubbles: true, touches: [t], changedTouches: [t] }));
  x.dispatchEvent(new w.TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: [t] }));
  check(panel.className === before, `tapping × doesn't trigger "tap to expand" (${before} → ${panel.className})`);
  x.click();   // data-click="hideHostDetail" (v0.23.4)
  check(!panel.classList.contains("open"), "× closes the host sheet");
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
