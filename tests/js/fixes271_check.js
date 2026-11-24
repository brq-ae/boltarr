// v0.27.1: schedule Run now reports a queued scan; IP History points to the Subnets
// page; SSH Copy deploy cmd uses a one-time link and copies on plain HTTP (with a
// shown command when the browser won't copy).
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
let RUN_DELAY = 0, RUN = {}, SUBNETS = [];
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
      if (/\/api\/scan-schedules\/\d+\/run$/.test(u)) return j(RUN);
      if (u.endsWith("/deploy-link")) return j({ path: "/api/deploy-keys/Demo_code-123", expires_in: 600 });
      if (/\/ssh-access$/.test(u)) return j([{ id: 1, username: "root", name: "demo-laptop", fingerprint: "SHA256:demo" }]);
      if (u.endsWith("/api/ssh-keys")) return j([{ id: 1, name: "demo-laptop" }]);
      if (u.endsWith("/api/subnets")) return j(SUBNETS);
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
  const toasts = [];
  const realToast = w.showToast; w.showToast = m => { toasts.push(m); };
  // showToast is looked up by name inside the app's files, so wrap the shared one
  w.eval("showToast = m => window.__toasts.push(m)"); w.__toasts = toasts;

  // ── 1: Run now on a schedule ──
  RUN = { started: [], queued: [7], skipped: [] };
  await w.runScheduleNow(3); await sleep(30);
  check(/Queued 1 scan: waiting for the running scan to finish — see Scan Log/.test(toasts.at(-1)), "queued run says it's waiting: " + toasts.at(-1));
  check($("scan-panel-history").style.display !== "none", "…and switches to the Scan Log");
  RUN = { started: [4], queued: [7, 8], skipped: [9] };
  await w.runScheduleNow(3); await sleep(30);
  check(/^Started 1 scan, 2 waiting in line, 1 skipped .* — see Scan Log$/.test(toasts.at(-1)), "mixed result: " + toasts.at(-1));
  RUN = { started: [], queued: [], skipped: [] };
  await w.runScheduleNow(3); await sleep(30);
  check(toasts.at(-1) === "Nothing to run", "nothing at all still says Nothing to run");

  // ── 2: IP History points to the Subnets page ──
  SUBNETS = [];
  await w.loadIpHistory(true); await sleep(20);
  check(/add one on the Subnets page/.test($("iphNote").textContent) && !/Settings/.test($("iphNote").textContent), "IP History: no subnets → the Subnets page");
  const hostsJs = require("fs").readFileSync(`${BOLTARR}/frontend/js/app/hosts.js`, "utf8");
  check(!/Settings → Subnets/.test(hostsJs) && /Set the pool on the Subnets page/.test(hostsJs), "no 'Settings → Subnets' left in the pool hint");

  // ── 3: SSH Copy deploy cmd ──
  d.body.insertAdjacentHTML("beforeend", '<div id="dtab-ssh"></div>');
  await w.loadHostSshSection("10.9.1.10"); await sleep(20);
  let copied = null;
  w.copyText = t => { copied = t; return Promise.resolve(); };
  calls.length = 0;
  click(d.querySelector('[data-click="copySshCurl"]')); await sleep(40);
  const req = calls.find(c => c.u.endsWith("/api/hosts/10.9.1.10/deploy-link"));
  check(req && req.m === "POST" && req.body.user === "root", "asks the server for a one-time link");
  check(copied && copied.includes('curl -sfL "http://x.test/api/deploy-keys/Demo_code-123"') && !copied.includes("authorized-keys?user"),
    "the copied command uses the one-time link");
  check(/within 10 minutes/.test(toasts.at(-1)) && /works once/.test(toasts.at(-1)), "toast says 10 minutes, works once");
  w.copyText = () => Promise.reject(new Error("no"));
  click(d.querySelector('[data-click="copySshCurl"]')); await sleep(40);
  const box = d.querySelector(".ssh-cmd-box");
  check(box && !box.hidden && box.value.includes("/api/deploy-keys/Demo_code-123"), "browser won't copy → the command is shown to select");
  check(/Couldn't copy/.test(toasts.at(-1)), "…with a message saying so");
  check(/^https?:/.test("http://x") && (() => { try { w.sshDeployCmd("root", "http://evil.test/x; rm -rf /"); return false; } catch (e) { return true; } })(),
    "an odd link from the server is refused, never put in a command");

  check(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  console.log(fail ? `${fail} FAILED` : "all passed");
  process.exit(fail ? 1 : 0);
})();
