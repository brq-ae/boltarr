// F-16 (v0.26.2): changing an address while its saved secret is hidden shows a
// "send my saved … to this new address" tick box, and Save sends move_secret.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const ROOT = `${BOLTARR}/frontend`;
let html = fs.readFileSync(`${ROOT}/index.html`, "utf8");
html = html.replace(/<script src="\/vendor\/[^"]+"><\/script>/g, "");
html = html.replace(/<script src="\/js\/([^"]+)"><\/script>/g, (_, f) =>
  `<script>${fs.readFileSync(`${ROOT}/js/${f}`, "utf8").replace(/<\/script>/g, "<\\/script>")}</script>`);
html = html.replace(/<link[^>]+stylesheet[^>]*>/g, "");
let fail = 0; const errors = [], puts = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const M = "••••••••";
const SETTINGS = { general: {}, llm: { provider: "openai", base_url: "http://10.9.0.5/v1", api_key: M, model: "m", configured: true },
  notifications: { server: "http://10.9.0.6", topic: "demo", token: M }, statuspage: { url: "http://10.9.0.7:12102", token: M },
  change_tracking: {}, change_alerts: {}, liveness: {}, ip_history: {}, ai_history: {}, security: {} };
const vc = new VirtualConsole();
vc.on("jsdomError", e => errors.push(String(e.message || e)));
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://x.test/", virtualConsole: vc,
  beforeParse(w) {
    w.TextDecoder = TextDecoder;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.Element.prototype.scrollIntoView = () => {};
    const P = new Proxy(function () {}, { get: (t, k) => k === Symbol.iterator ? function* () {} : k === "length" ? 0
      : k === "then" || k === Symbol.toPrimitive ? undefined : P, apply: () => P });
    w.cytoscape = P;
    w.ResizeObserver = class { observe() {} disconnect() {} };
    const j = v => new w.Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    w.Response = Response;
    w.fetch = async (u, o = {}) => { u = String(u);
      if (o.method === "DELETE") return new w.Response(null, { status: 204 });
      if (o.method === "PUT") {
        const body = JSON.parse(o.body || "{}"); puts.push({ u, body });
        if (u.endsWith("/api/auth/settings")) return j({ trusted_proxies: body.trusted_proxies });
        // like the server: what was sent is now saved (secrets come back hidden)
        if (body.llm) Object.assign(SETTINGS.llm, { provider: body.llm.provider, base_url: body.llm.base_url });
        if (body.notifications) SETTINGS.notifications.server = body.notifications.server;
        if (body.statuspage) SETTINGS.statuspage.url = body.statuspage.url;
        return j({ ok: true, ...SETTINGS });
      }
      return u.endsWith("/api/settings") ? j(SETTINGS)
        : u.includes("/api/auth/status") ? j({ enabled: false })
        : u.includes("/api/dhcp-warnings") ? j({ hosts: {}, pools: [] })
        : u.includes("/api/graph") ? j({ nodes: [], edges: [] })
        : u.includes("/api/version") ? j({ version: "x" })
        : j(u.includes("config") || u.includes("/api/ai-history") ? {} : []); };
  } });
const w = dom.window, d = w.document, $ = id => d.getElementById(id);
const type = (id, v) => { $(id).value = v; $(id).dispatchEvent(new w.Event("input", { bubbles: true })); };
(async () => {
  await sleep(600);
  await w.openSettings(); await sleep(50);
  check($("setKeyMoveRow").hidden && $("setNtfyMoveRow").hidden && $("setSpMoveRow").hidden, "no warnings when nothing changed");
  type("setBaseUrl", "http://evil.example/v1");
  check(!$("setKeyMoveRow").hidden, "AI address changed with key hidden → warning + tick box");
  type("setBaseUrl", "http://10.9.0.5/v1/");
  check($("setKeyMoveRow").hidden, "back to the saved address (trailing / ignored) → warning gone");
  type("setBaseUrl", "http://evil.example/v1"); type("setApiKey", "a-new-key");
  check($("setKeyMoveRow").hidden, "key retyped → no warning");
  type("setApiKey", M);
  $("setProvider").value = "anthropic"; $("setProvider").dispatchEvent(new w.Event("change", { bubbles: true }));
  check(!$("setKeyMoveRow").hidden, "switching provider to Anthropic → warning");
  $("setProvider").value = "none"; $("setProvider").dispatchEvent(new w.Event("change", { bubbles: true }));
  check($("setKeyMoveRow").hidden, "provider None (AI off) → no warning");
  $("setProvider").value = "openai"; $("setProvider").dispatchEvent(new w.Event("change", { bubbles: true }));
  type("setBaseUrl", "http://evil.example/v1");
  type("setNtfyServer", "http://evil.example");
  type("setSpUrl", "http://evil.example");
  check(!$("setNtfyMoveRow").hidden && !$("setSpMoveRow").hidden, "ntfy and status page warnings too");
  $("setKeyMoveOk").checked = true;
  await w.saveSettings(true); await sleep(30);
  const all = puts.find(p => p.u.endsWith("/api/settings/all"));
  check(all && all.body.llm.move_secret === true && all.body.notifications.move_secret === false
        && all.body.statuspage.move_secret === false, "Save sends move_secret only for the ticked one");
  // After the save the new address is the saved one: going back to the old one warns again
  check($("setKeyMoveRow").hidden, "after Apply: the new AI address is the saved one → no warning");
  type("setBaseUrl", "http://10.9.0.5/v1");
  check(!$("setKeyMoveRow").hidden, "changing it back to the old address → warning again (as the server expects)");
  // 204 answers (deletes) no longer break the caller
  check((await w.api("DELETE", "/api/ssh-access/1")) === null, "api() returns null for an empty 204 answer");
  // Trusted proxy range: yellow warning under the box while typing
  type("loginProxies", "172.18.0.5");
  check($("loginProxiesWarn").hidden, "single proxy IP → no warning");
  type("loginProxies", "172.18.0.5, 172.18.0.0/16");
  check(!$("loginProxiesWarn").hidden && /172\.18\.0\.0\/16 is a whole range/.test($("loginProxiesWarn").textContent),
        "a range → yellow warning under the box");
  type("loginProxies", "10.0.0.5/32");
  check($("loginProxiesWarn").hidden, "a /32 is one address → no warning");
  check(errors.length === 0, `no script errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
