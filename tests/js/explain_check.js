// v0.25.0 AI Tier 3 part 2: Explain link on outages (service + host panels).
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
const OUT = [{ start: "2026-11-12T02:11:00+00:00", end: "2026-11-12T02:23:00+00:00", seconds: 720 },
             { start: "2026-11-11T04:04:42+00:00", end: null, seconds: 99999 }];
let SAVED = null; const posts = []; const gets = [];
const X = (over = {}) => ({ id: 7, kind: "service", target_id: 4, outage_start: OUT[0].start, summary: "The <b>switch</b> restarted.",
  facts: ["Outage: Demo SMB on demo-nas", "demo-switch <i>was</i> offline"], model: "demo-a:latest", ai_error: null,
  created_at: "2026-11-12 10:00:00", ...over });
let POST_REPLY = X();
const vc = new VirtualConsole();
vc.on("jsdomError", e => errors.push(String(e.message || e)));
vc.on("error", e => errors.push(String(e)));
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://x.test/", virtualConsole: vc,
  beforeParse(w) {
    w.TextDecoder = TextDecoder; w.CSS = { escape: x => String(x) };
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.Element.prototype.scrollIntoView = () => {};
    const P = new Proxy(function () {}, { get: (t, k) => k === Symbol.iterator ? function* () {} : k === "length" ? 0
      : k === "then" || k === Symbol.toPrimitive ? undefined : P, apply: () => P });
    w.cytoscape = P; w.ResizeObserver = class { observe() {} disconnect() {} };
    const j = v => new w.Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    w.Response = Response;
    w.fetch = async (u, o) => { u = String(u);
      if (u.includes("/api/explain")) {
        if (o && o.method === "POST") { posts.push(JSON.parse(o.body)); return j({ explanation: POST_REPLY }); }
        gets.push(u); return j({ explanation: SAVED });
      }
      return u.includes("/uptime") ? j({ uptime: { "24h": { pct: 99 }, "7d": { pct: 99 }, "30d": { pct: 99 } }, outages: OUT, host_id: 92652 })
        : u.includes("/api/models") ? j({ models: ["demo-a:latest", "demo-b:7b"], default: "demo-a:latest" })
        : u.includes("/api/auth/status") ? j({ enabled: false })
        : u.includes("/api/settings") ? j({ llm: { configured: true } })
        : u.includes("/api/graph") ? j({ nodes: [], edges: [] })
        : u.includes("/api/dhcp-warnings") ? j({ hosts: {}, pools: [] })
        : j(u.includes("config") || u.includes("status") ? {} : []); };
  } });
const w = dom.window, d = w.document;
(async () => {
  await sleep(700);
  check(errors.length === 0, `boots with no errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  // render a service outage list into a scratch element, as loadSvcUptime does
  const host = d.createElement("div"); d.body.appendChild(host);
  host.innerHTML = w.outageListHtml("service", 4, OUT);
  const links = host.querySelectorAll('[data-click="toggleExplain"]');
  check(links.length === 2, "one Explain link per outage");
  check(host.querySelectorAll(".explain-box[hidden]").length === 2, "explanation boxes start hidden");
  check(w.outageListHtml("host", 1, []).includes("No outages recorded yet"), "empty list message kept");

  // 1. nothing saved → runs a new explanation
  links[0].click(); await sleep(150);
  check(gets.length === 1 && gets[0].includes("kind=service") && gets[0].includes("id=4") && gets[0].includes(encodeURIComponent(OUT[0].start)), "looks for a saved one first");
  check(posts.length === 1 && posts[0].kind === "service" && posts[0].id === 4 && posts[0].start === OUT[0].start && posts[0].model === "", `nothing saved → explains (default model): ${JSON.stringify(posts[0])}`);
  const box = d.getElementById("explain-service-4-0");
  check(!box.hidden && box.querySelector(".explain-text").textContent === "The <b>switch</b> restarted.", "AI text shown, escaped");
  check(box.querySelectorAll(".explain-facts li").length === 2 && !box.querySelector(".explain-facts i"), "facts listed, escaped");
  check(box.querySelector(".explain-head").textContent.includes("AI"), "AI text is labelled as AI");
  check(box.querySelector(".explain-model").value === "demo-a:latest", "model list shows the model used");

  // 2. toggle closes, reopening uses the saved one (no new POST)
  links[0].click(); await sleep(50);
  check(box.hidden, "second click closes it");
  SAVED = X({ summary: "Saved one." });
  links[0].click(); await sleep(150);
  check(posts.length === 1 && box.querySelector(".explain-text").textContent === "Saved one.", "reopen shows the saved explanation instantly");

  // 3. Explain again with another model
  box.querySelector(".explain-model").value = "demo-b:7b";
  POST_REPLY = X({ summary: "Fresh one.", model: "demo-b:7b" });
  box.querySelector('[data-click="runExplain"]').click(); await sleep(150);
  check(posts.length === 2 && posts[1].model === "demo-b:7b", "Explain again sends the picked model");
  check(box.querySelector(".explain-text").textContent === "Fresh one.", "fresh explanation shown");

  // 4. no AI → facts only with the reason
  SAVED = null; POST_REPLY = X({ summary: null, ai_error: "No AI is set up (Settings → AI), so only the facts are shown." });
  links[1].click(); await sleep(150);
  const box2 = d.getElementById("explain-service-4-1");
  check(!box2.querySelector(".explain-text") && box2.querySelector(".explain-note").textContent.includes("No AI is set up"), "no AI → reason shown");
  check(box2.querySelectorAll(".explain-facts li").length === 2, "…and the facts still shown");
  check(!box.hidden, "boxes are independent");

  // 5. the real panels use it
  const sd = fs.readFileSync(`${ROOT}/js/app/services-detail.js`, "utf8"), hd = fs.readFileSync(`${ROOT}/js/app/host-detail.js`, "utf8");
  check(sd.includes('outageListHtml("service", id, d.outages)') && hd.includes('outageListHtml("host", d.host_id, d.outages)'), "service + host panels use the shared list");
  check(errors.length === 0, `no errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
