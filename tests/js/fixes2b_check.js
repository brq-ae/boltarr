// v0.27.0 batch 2b owner-test fixes: a name cleared in the Hosts table shows the
// network name at once (the table takes back what the server saved); Edit Host
// shows the network name under Hostname; Analyze updates the open panel's type.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const ROOT = `${BOLTARR}/frontend`;
let html = fs.readFileSync(`${ROOT}/index.html`, "utf8");
html = html.replace(/<script src="\/vendor\/[^"]+"><\/script>/g, "");
html = html.replace(/<script src="\/js\/([^"]+)"><\/script>/g, (_, f) =>
  `<script>${fs.readFileSync(`${ROOT}/js/${f}`, "utf8").replace(/<\/script>/g, "<\\/script>")}</script>`);
html = html.replace(/<link[^>]+stylesheet[^>]*>/g, "");
let fail = 0; const errors = [], calls = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const HOSTS = [
  { id: 1, ip: "10.9.1.10", hostname: "Living room TV", net_hostname: "lgwebos-7731.lan", device_type: "tv", online: 1,
    vendor: "LG", os_guess: "webOS", ports: [], alias_ports: [], aliases: [], alias_info: [], services: [], analyses: [] },
  { id: 2, ip: "10.9.1.11", hostname: "same.lan", net_hostname: null, device_type: "unknown", online: 1,
    ports: [], alias_ports: [], aliases: [], alias_info: [], services: [], analyses: [] },
];
let RUN_DELAY = 0;
let CTX = { model: "demo-model", max: 262144, loaded: { context: 8192, size: 8.8e9, vram: 8.8e9 } };
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
    w.confirm = () => true; w.alert = m => errors.push("alert: " + m); w.CSS = { escape: s => String(s) };
    w.Response = Response;
    const j = v => new w.Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    w.fetch = async (u, o = {}) => { u = String(u);
      const body = o.body ? JSON.parse(o.body) : null;
      if (o.method && o.method !== "GET") calls.push({ m: o.method, u, body });
      if (u.endsWith("/api/ai-actions/run")) { await new Promise(r => setTimeout(r, RUN_DELAY)); return j({ ok: true, message: "Done (demo)." }); }
      if (u.endsWith("/api/ai-actions/cancel")) return j({ ok: true });
      const hm = u.match(/\/api\/hosts\/(10\.9\.1\.\d+)$/);
      if (hm && (!o.method || o.method === "GET")) return j(HOSTS.find(h => h.ip === hm[1]));
      if (hm && o.method === "PUT") {          // like the server: an empty name goes back to the network's
        const h = HOSTS.find(x => x.ip === hm[1]);
        if ("hostname" in body) h.hostname = (body.hostname || "").trim() || h.net_hostname;
        return j({ ...h });
      }
      if (/\/api\/hosts\/10\.9\.1\.\d+\/analyze$/.test(u)) return j({ analysis: "Device type: camera\nA camera.", model: "demo", device_type: "camera", earlier: [] });
      if (u.includes("/api/ai/context")) return j(CTX);
      if (u.endsWith("/api/hosts")) return j(HOSTS);
      if (/\/uptime/.test(u)) return j({ host_id: 1, uptime: {}, outages: [] });
      if (o.method === "POST" || o.method === "PUT") return j({ ok: true });
      return u.endsWith("/api/settings") ? j({ general: {}, llm: {}, notifications: {}, statuspage: {}, change_tracking: {},
          change_alerts: {}, liveness: {}, ip_history: {}, ai_history: {}, security: {} })
        : u.includes("/api/auth/status") ? j({ enabled: false })
        : u.includes("/api/graph") ? j({ nodes: [], edges: [] })
        : u.includes("/api/version") ? j({ version: "x" })
        : j(u.includes("config") || u.includes("/api/ai-history") ? {} : []); };
  } });
const w = dom.window, d = w.document, $ = id => d.getElementById(id);
const click = el => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));

(async () => {
  await sleep(700);
  await w.loadHosts(); w.renderHostsTable(); await sleep(20);
  const row = ip => [...d.querySelectorAll("#hostsTable tbody tr")].find(r => r.textContent.includes(ip));

  // ── 2: clearing the name in the table ──
  const cell = row("10.9.1.10").querySelector(".col-host");
  click(cell.querySelector('[data-click="editFieldBtn"]')); await sleep(20);
  const inp = cell.querySelector("input.cell-input");
  check(!!inp, "table pen opens the name box");
  inp.value = "";
  inp.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(60);
  const c2 = row("10.9.1.10").querySelector(".col-host");
  check(/lgwebos-7731\.lan/.test(c2.textContent), "cleared name shows the network name at once");
  check(!c2.querySelector(".has-net-name"), "…with no dotted line (the names now match)");
  check(!calls.some(c => c.m === "GET" && /\/api\/hosts$/.test(c.u)), "…without reloading the whole list");
  HOSTS[0].hostname = "Living room TV";
  await w.showHostDetail("10.9.1.10"); await sleep(40);
  const pc = row("10.9.1.10").querySelector(".col-host");
  click(pc.querySelector('[data-click="editFieldBtn"]')); await sleep(20);
  const pin = pc.querySelector("input.cell-input"); pin.value = "";
  pin.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(60);
  const box = $("detailNameBox");
  check(/lgwebos-7731\.lan/.test(box.textContent) && !box.querySelector(".has-net-name") && !box.querySelector(".net-name-line"),
    "open panel heading changes back to the network name at once");
  check($("detailNameField").textContent === "lgwebos-7731.lan" && !$("detailNameField").classList.contains("has-net-name"),
    "…and its Info tab Hostname too");
  const pc2 = row("10.9.1.10").querySelector(".col-host");
  click(pc2.querySelector('[data-click="editFieldBtn"]')); await sleep(20);
  const pin2 = pc2.querySelector("input.cell-input"); pin2.value = "Living room TV";
  pin2.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(60);
  check(/Living room TV/.test($("detailNameBox").textContent) && $("detailNameBox").querySelector(".has-net-name"),
    "typing a name in the table shows it in the panel with the dotted line");

  // ── 3: Edit Host shows the network name ──
  HOSTS[0].hostname = "Living room TV";
  w.openEditHost("10.9.1.10"); await sleep(40);
  const hint = $("editNetName");
  check(hint && /Network name: lgwebos-7731\.lan/.test(hint.textContent) && hint.querySelector("b"), "Edit Host: grey 'Network name' line");
  const q = hint.querySelector(".hint-q"), why = hint.querySelector(".net-name-why");
  check(q && /dotted underline/.test(q.title) && /Leave the box empty/.test(q.title), "…a (?) whose hover shows the explainer");
  check(why && why.hidden, "…the explainer is hidden at first");
  click(q); await sleep(10);
  check(!why.hidden, "…a tap/click on (?) shows it (phones have no hover)");
  w.closeEditHost?.();
  w.openEditHost("10.9.1.11"); await sleep(40);
  check(/hasn't reported a name/.test($("editNetName").textContent), "…says so when the network has no name");
  w.closeEditHost?.();

  // ── 5: Analyze updates the open panel's type ──
  await w.showHostDetail("10.9.1.11"); await sleep(40);
  check($("detailTypeTag").textContent === "unknown", "panel starts as unknown");
  await w.analyzeHost("10.9.1.11"); await sleep(40);
  check($("detailTypeTag").textContent === "camera" && $("detailTypeTag").className === "tag tag-camera", "header badge turns to camera at once");
  check($("detailTypeField").textContent === "camera", "Info tab type turns to camera at once");

  // ── Settings → AI: what the model can read ──
  $("setProvider").value = "ollama"; $("setModel").value = "demo-model"; $("setNumCtx").value = "8192";
  await w.loadCtxInfo(); await sleep(20);
  const ci = $("setCtxInfo");
  check(!ci.hidden && /up to 262,144 tokens/.test(ci.textContent) && /8,192 tokens, using 8\.8 GB, all on the GPU/.test(ci.textContent),
    "Settings: shows the model's maximum and that it's all on the GPU");
  check(!ci.classList.contains("ctx-warn"), "…no warning when it fits");
  CTX = { model: "demo-model", max: 32768, loaded: { context: 16384, size: 10e9, vram: 7e9 } };
  $("setNumCtx").value = "65536";
  await w.loadCtxInfo(); await sleep(20);
  check(/more than that, so Ollama will use 32,768/.test(ci.textContent) && /70% on the GPU/.test(ci.textContent) && ci.classList.contains("ctx-warn"),
    "…warns above the model's maximum and when part runs on the CPU");
  $("setNumCtx").value = "8192"; $("setNumCtx").dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(10);
  check(!/more than that/.test(ci.textContent) && /takes effect with the next question/.test(ci.textContent), "…updates as you type a new size");
  CTX = { model: "demo-model", max: 262144, loaded: null };
  await w.loadCtxInfo(); await sleep(20);
  check(/isn't loaded right now/.test(ci.textContent), "…says when the model isn't loaded");
  $("setProvider").value = "anthropic"; w.onSettingsProviderChange(); await sleep(10);
  check(ci.hidden, "…hidden for providers other than Ollama");

  check(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  console.log(fail ? `${fail} FAILED` : "all passed");
  process.exit(fail ? 1 : 0);
})();
