// v0.25.0 AI Tier 3 part 3: AI history — Earlier lists, Settings section, Clean history, past digests.
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
const changesLoads = [];
let put = null, cleaned = 0, COUNT = 5;
const NET = [{ id: 3, model: "demo-a:latest", analysis: "Newest **net**", created_at: "2026-11-12 09:00:00" },
             { id: 2, model: "demo-b:7b", analysis: "Older net", created_at: "2026-11-11 09:00:00" }];
const DIG = [{ id: 1, title: "Daily digest: 2 network changes", body: "Services\n🟢 Demo <Web>", summary: "All fine.", model: "demo-a:latest", created_at: "2026-11-12 05:00:00" }];
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
    w.fetch = async (u, o) => { u = String(u); const m = (o && o.method) || "GET";
      if (m === "PUT" && u.endsWith("/api/settings/all")) { put = JSON.parse(o.body); return j({ ok: true }); }
      if (m === "POST" && u.endsWith("/api/ai-history/clean")) { cleaned++; const n = COUNT; COUNT = 0; return j({ ok: true, deleted: n }); }
      if (m === "POST" && u.endsWith("/api/analyze/network"))
        return j({ analysis: "Fresh net", model: "demo-a:latest", earlier: NET });
      if (m === "POST" && u.includes("/api/explain"))
        return j({ explanation: { id: 9, summary: "Now", facts: ["f"], model: "demo-a", created_at: "2026-11-12 10:00:00" },
                   earlier: [{ id: 8, summary: "Before <x>", model: "demo-b", created_at: "2026-11-11 10:00:00" },
                             { id: 7, summary: null, ai_error: "No AI model chosen", created_at: "2026-11-10 10:00:00" }] });
      const hm = u.match(/\/api\/hosts\/(10\.9\.0\.\d+)$/);
      if (hm) return j({ id: 1, ip: hm[1], hostname: "demo-" + hm[1].split(".")[3], ports: [], services: [],
        analyses: [{ id: 1, analysis: "Saved for " + hm[1], model: "demo-a", created_at: "2026-11-12 09:00:00" }] });
      if (u.includes("/api/change-events")) { changesLoads.push(u); return j([]); }
      return u.endsWith("/api/ai-history") ? j({ count: COUNT })
        : u.endsWith("/api/digest/history") ? j({ digests: COUNT ? DIG : [] })
        : u.endsWith("/api/analyze/network") ? j({ analyses: NET })
        : u.includes("/api/models") ? j({ models: ["demo-a:latest"], default: "demo-a:latest" })
        : u.endsWith("/api/settings") ? j({ general: {}, llm: { configured: true, provider: "ollama" }, notifications: {},
            statuspage: {}, change_tracking: {}, liveness: {}, ip_history: {}, security: {}, change_alerts: {},
            ai_history: { enabled: true, keep_per_item: 10, keep_days: 90 } })
        : u.includes("/api/auth/status") ? j({ enabled: false })
        : u.includes("/api/graph") ? j({ nodes: [], edges: [] })
        : u.includes("/api/dhcp-warnings") ? j({ hosts: {}, pools: [] })
        : j(u.includes("config") || u.includes("status") ? {} : []); };
  } });
const w = dom.window, d = w.document, $ = id => d.getElementById(id);
(async () => {
  await sleep(700);
  check(errors.length === 0, `boots with no errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);

  // Settings → AI → AI history
  await w.openSettings(); await sleep(250);
  check($("setAiHistEnabled").checked && $("setAiHistKeep").value === "10" && $("setAiHistDays").value === "90", "loads the saved values");
  check($("aiHistOffNote").hidden, "no warning while saving is on");
  check($("aiHistCount").textContent === "5 saved results", `count shown: ${$("aiHistCount").textContent}`);
  $("setAiHistEnabled").click(); await sleep(50);
  check(!$("aiHistOffNote").hidden && $("aiHistOffNote").textContent.includes("deleted after 90 days"), "turning it off shows the 90-day warning at once");
  $("setAiHistDays").value = "30"; $("setAiHistDays").dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(50);
  check($("aiHistOffNote").textContent.includes("after 30 days"), "warning follows the days box");
  $("setAiHistDays").value = "0"; $("setAiHistDays").dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(50);
  check($("aiHistOffNote").textContent.includes("kept until you click Clean history"), "0 days = kept until cleaned");
  $("setAiHistKeep").value = "3";
  d.querySelector('#settingsSaveBar [data-click="saveSettings"]').click(); await sleep(250);
  check(put && JSON.stringify(put.ai_history) === JSON.stringify({ enabled: false, keep_per_item: 3, keep_days: 0 }), `saved: ${JSON.stringify(put && put.ai_history)}`);

  // past digests
  const past = $("pastDigests");
  check(past.textContent.includes("Past digests (1)") && past.textContent.includes("All fine.") && past.querySelector("pre").textContent.includes("Demo <Web>"),
        "past digests listed under Preview, text escaped");

  // Clean history: asks first, on the page
  check($("aiHistConfirm").hidden, "confirm box starts hidden");
  d.querySelector('[data-click="askCleanAiHistory"]').click(); await sleep(50);
  check(!$("aiHistConfirm").hidden && $("aiHistConfirmText").textContent.includes("Delete all 5"), "asks first, naming the count");
  d.querySelector('[data-click="cancelCleanAiHistory"]').click(); await sleep(50);
  check($("aiHistConfirm").hidden && cleaned === 0, "Cancel deletes nothing");
  d.querySelector('[data-click="askCleanAiHistory"]').click();
  d.querySelector('[data-click="cleanAiHistory"]').click(); await sleep(250);
  check(cleaned === 1 && $("aiHistConfirm").hidden, "Delete cleans and closes the box");
  check($("aiHistCount").textContent === "Nothing saved" && past.innerHTML === "", "count and past digests refresh");
  w.setTab("topology"); await sleep(50);

  // Analyze Network shows the saved one + Earlier
  COUNT = 2;
  await w.openNetworkAnalysis(); await sleep(150);
  const net = $("networkAnalysisResult");
  check(net.querySelector(".analysis-box").innerHTML.includes("<strong>net</strong>"), "network window opens on the newest saved analysis");
  check(net.querySelector("details.ai-earlier summary").textContent === "Earlier (1)", "one earlier network analysis");
  await w.runNetworkAnalysis(); await sleep(100);
  check(net.textContent.includes("Fresh net") && net.querySelector("details.ai-earlier summary").textContent === "Earlier (2)", "a new run puts the others under Earlier");

  // Explain shows earlier runs
  const box = d.createElement("div"); d.body.appendChild(box);
  box.innerHTML = w.outageListHtml("service", 4, [{ start: "2026-11-12T02:11:00+00:00", end: "2026-11-12T02:23:00+00:00", seconds: 720 }]);
  await w.runExplain("service", 4, "2026-11-12T02:11:00+00:00", 0); await sleep(50);
  const eb = $("explain-service-4-0");
  const items = eb.querySelectorAll(".ai-earlier-item");
  check(items.length === 2 && items[0].textContent.includes("Before <x>") && items[1].textContent.includes("No AI model chosen"), "Explain lists earlier runs, escaped");
  check(items[0].querySelector(".analysis-meta").textContent.includes("demo-b"), "each earlier run shows its model");

  // aiEarlierHtml: nothing earlier → nothing shown
  check(w.aiEarlierHtml([], x => "x") === "" && w.aiEarlierHtml(null, x => "x") === "", "no Earlier link when there's nothing earlier");
  // host panel keeps the last tab when switching hosts
  await w.showHostDetail("10.9.0.1"); await sleep(50);
  check(d.querySelector(".detail-tab.active").dataset.tab === "info", "first host opens on Info");
  w.switchDetailTab("analysis");
  await w.showHostDetail("10.9.0.2"); await sleep(50);
  check(d.querySelector(".detail-tab.active").dataset.tab === "analysis" && $("dtab-analysis").classList.contains("active")
        && $("analysisResult").textContent.includes("Saved for 10.9.0.2"), "switching host stays on Analysis");
  d.querySelector('.detail-tab[data-tab="changes"]').click(); await sleep(50);
  const before = changesLoads.length;
  await w.showHostDetail("10.9.0.3"); await sleep(100);
  check(d.querySelector(".detail-tab.active").dataset.tab === "changes" && changesLoads.length > before, "Changes tab is kept and loads for the new host");
  w.switchDetailTab("info");
  check(errors.length === 0, `no errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
