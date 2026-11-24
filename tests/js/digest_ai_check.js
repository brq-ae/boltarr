// v0.25.0 AI Tier 3 part 1: Settings → Alerts digest AI switch, model list, preview box.
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
let SAVED = { digest_ai: true, digest_ai_model: "demo-old:1b" };
let PREVIEW = null; const urls = [], previews = []; let put = null;
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
    w.fetch = async (u, o) => { u = String(u); urls.push(u);
      if (u.includes("/api/digest/preview")) previews.push({ method: (o && o.method) || "GET", body: o && o.body ? JSON.parse(o.body) : null });
      if (o && o.method === "PUT" && u.endsWith("/api/settings/all")) { put = JSON.parse(o.body); return j({ ok: true }); }
      return u.includes("/api/digest/preview") ? j(PREVIEW)
        : u.includes("/api/models") ? j({ models: ["demo-a:latest", "demo-b:7b"], default: "demo-a:latest" })
        : u.endsWith("/api/settings") ? j({ general: {}, llm: { configured: true, provider: "ollama" }, notifications: {},
            statuspage: {}, change_tracking: {}, liveness: {}, ip_history: {}, security: {},
            change_alerts: { enabled: true, digest_enabled: true, ...SAVED } })
        : u.includes("/api/auth/status") ? j({ enabled: false })
        : u.includes("/api/graph") ? j({ nodes: [], edges: [] })
        : u.includes("/api/dhcp-warnings") ? j({ hosts: {}, pools: [] })
        : j(u.includes("config") || u.includes("status") ? {} : []); };
  } });
const w = dom.window, d = w.document, $ = id => d.getElementById(id);
(async () => {
  await sleep(700);
  check(errors.length === 0, `boots with no errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  await w.openSettings(); await sleep(200);
  const sel = $("setCaDigestAiModel");
  const opts = [...sel.options].map(o => [o.value, o.textContent]);
  check($("setCaDigestAi").checked, "switch shows the saved value");
  check($("setCaDigestServices").checked, "services tick on when not set");
  check(opts[0][0] === "" && opts[0][1] === "Default model (demo-a)", `first option is the default: ${JSON.stringify(opts[0])}`);
  check(opts.some(o => o[0] === "demo-old:1b"), "a saved model the server no longer lists is kept");
  const sugg = [...d.querySelectorAll("#setModelList option")].map(o => o.value);
  check($("setModel").getAttribute("list") === "setModelList" && sugg.join() === "demo-a:latest,demo-b:7b",
        `Default Model box suggests the server's models: ${sugg.join()}`);
  $("setModel").value = "demo-unlisted:3b";
  check($("setModel").value === "demo-unlisted:3b", "an unlisted name can still be typed");
  check(sel.value === "demo-old:1b", "saved model is selected");
  check($("digestPreview").hidden, "preview box hidden at open");

  // preview with on-screen (unsaved) choices
  sel.value = "demo-b:7b";
  PREVIEW = { title: "Daily digest: 1 network change", body: "🤖 AI summary\nDemo <b>bold</b> summary.\n\n🆕 1 new device", ai_error: null };
  d.querySelector('[data-click="previewDigest"]').click(); await sleep(150);
  const pu = previews[previews.length - 1];
  check(pu && pu.method === "POST" && pu.body.ai === true && pu.body.model === "demo-b:7b",
    `preview uses on-screen settings (a POST, F-42): ${JSON.stringify(pu)}`);
  const box = $("digestPreview");
  check(!box.hidden && box.querySelector(".digest-preview-title").textContent === PREVIEW.title, "preview shows the title");
  check(box.querySelector("pre").textContent === PREVIEW.body && !box.querySelector("pre b"), "body shown as text (escaped)");
  check(box.textContent.includes("nothing was sent"), "says nothing was sent");

  PREVIEW = { title: "Daily digest: 1 network change", body: "🆕 1 new device", ai_error: "The AI took longer than 60 seconds." };
  $("setCaDigestAi").checked = false;
  d.querySelector('[data-click="previewDigest"]').click(); await sleep(150);
  check(previews[previews.length - 1].body.ai === false, "switch off → ai false");
  check(box.querySelector(".digest-preview-note").textContent.includes("longer than 60"), "AI-left-out reason shown");

  PREVIEW = { title: null, body: null, ai_error: null };
  d.querySelector('[data-click="previewDigest"]').click(); await sleep(150);
  check(box.textContent.includes("Nothing to report"), "nothing-to-report message");

  // save sends both fields
  $("setCaDigestAi").checked = true; sel.value = "";
  await w.saveSettings(); await sleep(200);
  const ca = put && put.change_alerts;
  check(ca && ca.digest_ai === true && ca.digest_ai_model === "" && ca.digest_services === true, `save sends switch + model: ${JSON.stringify(ca && { a: ca.digest_ai, m: ca.digest_ai_model })}`);
  check($("settingsSaveBar").hidden, "Save hides the save bar");

  // A change shows the save bar; Save saves and stays on the page (S-15)
  w.setTab("settings"); await sleep(200); put = null;
  $("setCaDigestServices").checked = false;
  $("setCaDigestServices").dispatchEvent(new w.Event("change", { bubbles: true }));
  check(!$("settingsSaveBar").hidden, "the change shows the save bar");
  d.querySelector('#settingsSaveBar [data-click="saveSettings"]').click(); await sleep(200);
  check(put && put.change_alerts.digest_services === false, "Save saves");
  check($("panel-settings").classList.contains("active") && $("settingsSaveBar").hidden, "stays on the page, bar gone");

  // Preview follows the on-screen services tick
  PREVIEW = { title: "x", body: "y", ai_error: null };
  d.querySelector('[data-click="previewDigest"]').click(); await sleep(150);
  check(previews[previews.length - 1].body.services === false, "preview sends services false when unticked");
  check(errors.length === 0, `no errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
