// F-45: a change that worked, followed by a refresh that failed, must not say "Error".
// It says the change was done and to refresh; a change that really failed still says Error.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM } = require("jsdom");
const fs = require("fs");
const html = fs.readFileSync(`${BOLTARR}/frontend/index.html`, "utf8");
const body = html.slice(html.indexOf("<body"), html.indexOf("<script src=\"/js/graph.js\""));
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
process.on("unhandledRejection", () => {});   // a browser only logs an error nothing catches

async function boot() {
  const dom = new JSDOM(body + "</body>", { runScripts: "outside-only", pretendToBeVisual: true, url: "http://x.test/" });
  const w = dom.window, d = w.document;
  if (d.readyState !== "complete") await new Promise(r => w.addEventListener("load", r));
  w.TextDecoder = TextDecoder; w.CSS = { escape: s => String(s) };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.localStorage.setItem("boltarr.viewLevel", "advanced");
  const st = { failRefresh: false, failSave: false, alerts: [] };
  w.alert = m => st.alerts.push(String(m));
  w.confirm = () => true;
  const hosts = [{ id: 1, ip: "10.45.0.1", hostname: "demo-nas", online: 1, ports: [] }];
  w.fetch = async (u, o = {}) => {
    const m = o.method || "GET", path = u.replace(/^.*?(\/api)/, "$1").split("?")[0];
    const j = (r, status = 200) => new Response(JSON.stringify(r), { status, headers: { "content-type": "application/json" } });
    if (m !== "GET") return st.failSave ? j({ detail: "demo save refused" }, 400) : j({ ok: true, id: 9 });
    if (st.failRefresh && ["/api/hosts", "/api/subnets", "/api/graph"].includes(path)) return j({ detail: "demo refresh failed" }, 500);
    if (path === "/api/hosts") return j(hosts);
    if (path === "/api/graph") return j({ nodes: [], edges: [] });
    if (path === "/api/settings") return j({ general: {}, llm: {}, statuspage: {}, notifications: {}, change_tracking: {}, liveness: {}, ip_history: {}, ai_history: {}, security: {}, change_alerts: {} });
    if (path === "/api/auth/status") return j({ enabled: true });
    if (path === "/api/ui/welcome") return j({ show: false });
    if (path === "/api/ui/start-level") return j({ level: "advanced" });
    return j([]);
  };
  w.cytoscape = () => new Proxy({}, { get: () => () => ({}) });
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/level.js`, "utf8"));
  w.eval(["markdown", "export", "chat", "peek", ...require("./appfiles"), "fitcols", "search"].map(f => fs.readFileSync(`${BOLTARR}/frontend/js/${f}.js`, "utf8")).join("\n;\n"));
  d.dispatchEvent(new w.Event("DOMContentLoaded"));
  await sleep(300);
  return { w, d, st, toast: () => d.getElementById("_toast")?.textContent || "" };
}

const DONE = /Done, but couldn't refresh the page/;

(async () => {
  const cases = [
    ["adding a device", b => { b.d.getElementById("addHostIp").value = "10.45.0.2"; return b.w.saveAddHost(); }],
    ["deleting a device", b => { const p = b.w.deleteHost("10.45.0.1"); b.d.getElementById("askOk").click(); return p; }],
    ["saving a subnet", b => { b.d.getElementById("subnetName").value = "Demo LAN"; b.d.getElementById("subnetCidr").value = "10.45.0.0/24"; return b.w.saveSubnet(); }],
  ];
  for (const [what, act] of cases) {
    // The change works, the refresh after it fails
    let b = await boot();
    b.st.failRefresh = true;
    await act(b); await sleep(100);
    check(b.st.alerts.length === 0, `${what} worked, refresh failed: no "Error" (${JSON.stringify(b.st.alerts)})`);
    check(DONE.test(b.toast()), `…you are told it was done and to refresh ("${b.toast()}")`);
    // The change itself fails
    b = await boot();
    b.st.failSave = true;
    await act(b); await sleep(100);
    check(b.st.alerts.some(a => /demo save refused/.test(a)) && !DONE.test(b.toast()), `${what} refused: it still says Error`);
    // All works: no message about refreshing
    b = await boot();
    await act(b); await sleep(100);
    check(b.st.alerts.length === 0 && !DONE.test(b.toast()), `${what} worked: no error and no refresh message`);
  }
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
