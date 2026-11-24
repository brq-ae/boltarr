// v0.27.0 Part 3 batch 2b screens: F-20 network name on hover (Hosts table, host
// panel, search, map) + Edit Host sends only what you changed; F-31 card buttons
// grey out on click (no double Do it); F-33 note card Add to note / Replace note;
// F-32 chat keeps error/empty replies out of the conversation.
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
  { id: 2, ip: "10.9.1.11", hostname: "same.lan", net_hostname: "same.lan", device_type: "pc", online: 1,
    ports: [], alias_ports: [], aliases: [], alias_info: [], services: [], analyses: [] },
];
let RUN_DELAY = 0;
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
      if (hm && o.method === "PUT") return j({ ok: true });
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

  // ── F-20: the network's name on hover ──
  await w.loadHosts(); w.renderHostsTable(); await sleep(20);
  const rows = [...d.querySelectorAll("#hostsTable tbody tr")];
  const tv = rows.find(r => /Living room TV/.test(r.textContent)), same = rows.find(r => /same\.lan/.test(r.textContent));
  const tip = tv && tv.querySelector(".col-host .has-net-name");
  check(tip && tip.title === "Network name: lgwebos-7731.lan", "Hosts table: hover shows the network's name");
  check(same && !same.querySelector(".has-net-name"), "…no hint when the names are the same");

  await w.showHostDetail("10.9.1.10"); await sleep(40);
  const panel = $("hostDetail");
  check(panel.querySelector(".detail-hostname .has-net-name")?.title === "Network name: lgwebos-7731.lan", "host panel heading: hover hint");
  check(/Network name: lgwebos-7731\.lan/.test(panel.querySelector(".net-name-line")?.textContent || ""), "phones: a grey 'Network name' line");
  check([...panel.querySelectorAll(".info-field")].some(f => /Hostname/.test(f.textContent) && f.querySelector(".has-net-name")),
    "Info tab Hostname field: hover hint");

  // search
  const items = () => [...d.querySelectorAll("#gsResults .gs-item, .gs-item")];
  const gs = $("gsInput");
  if (gs) {
    gs.value = "lgwebos"; gs.dispatchEvent(new w.Event("input", { bubbles: true })); await sleep(250);
    const hit = items().find(i => /10\.9\.1\.10/.test(i.textContent));
    check(hit && /network name/.test(hit.textContent) && hit.querySelector(".has-net-name"), "search finds the network name and shows the hint");
  } else check(false, "search box found");

  // Edit Host: only changed fields are sent
  w.openEditHost("10.9.1.10"); await sleep(40);
  check(/empty = the network's name \(lgwebos-7731\.lan\)/.test($("editHostname").placeholder), "Edit Host: says empty = the network's name");
  $("editDeviceType").value = "server";
  calls.length = 0;
  await w.saveHostEdit(); await sleep(40);
  const put = calls.find(c => c.m === "PUT" && /\/api\/hosts\/10\.9\.1\.10$/.test(c.u));
  check(put && !("hostname" in put.body) && !("vendor" in put.body) && !("os_guess" in put.body) && put.body.device_type === "server",
    "changing only the type doesn't send (and freeze) name/vendor/OS");
  w.openEditHost("10.9.1.10"); await sleep(40);
  $("editHostname").value = "";
  calls.length = 0;
  await w.saveHostEdit(); await sleep(40);
  const put2 = calls.find(c => c.m === "PUT" && /\/api\/hosts\/10\.9\.1\.10$/.test(c.u));
  check(put2 && put2.body.hostname === null && !("vendor" in put2.body), "clearing the name sends it (back to the network's)");

  // ── F-31 / F-33: AI cards ──
  const cardsDiv = d.createElement("div"); d.body.appendChild(cardsDiv);
  const show = card => { cardsDiv.innerHTML = w._aiCardHtml(card, 0); return cardsDiv.querySelector(".ai-action"); };
  w.eval('chatHistory.length = 0; chatHistory.push({ role: "user", content: "note it" }, { role: "assistant", content: "x" })');
  let el = show({ ok: true, kind: "change", title: "Change the note on demo", action: { do: "set_note", host: "demo", host_id: 3, note: "Two" },
    detail: [["Now", "One"], ["Add to note →", "One\nTwo"], ["Replace note →", "Two"]],
    choices: [{ mode: "add", label: "Add to note" }, { mode: "replace", label: "Replace note" }] });
  const btns = [...el.querySelectorAll(".ai-action-btns button")].map(b => b.textContent);
  check(btns.join("|") === "Add to note|Replace note|Cancel", "note card: Add to note / Replace note / Cancel");
  check(el.querySelector(".ai-action-val") && /One\nTwo/.test(el.textContent), "shows the full resulting note");
  calls.length = 0; RUN_DELAY = 1500;   // long enough that a busy machine still clicks while it works (F-39)
  const addBtn = el.querySelector(".ai-action-btns button");
  click(addBtn); await sleep(10);
  check([...el.querySelectorAll(".ai-action-btns button")].every(b => b.disabled), "F-31: all buttons grey out at once");
  click(addBtn); click(el.querySelectorAll(".ai-action-btns button")[1]); await sleep(RUN_DELAY + 500);
  const runs = calls.filter(c => c.u.endsWith("/api/ai-actions/run"));
  check(runs.length === 1 && runs[0].body.action.mode === "add" && runs[0].body.action.host_id === 3,
    "one click = one Do it, sends the chosen mode and the pinned host");
  check(!calls.some(c => c.u.endsWith("/api/ai-actions/cancel")), "a click on Cancel while working does nothing");

  el = show({ ok: true, kind: "change", title: "Scan Demo LAN", action: { do: "scan", subnet_id: 1, profile_options: {} }, detail: [] });
  calls.length = 0; RUN_DELAY = 1500;
  const doIt = el.querySelector(".btn-primary");
  check(doIt.textContent === "Do it", "other cards keep a single Do it");
  click(doIt); click(doIt); click(doIt); await sleep(RUN_DELAY + 500);
  check(calls.filter(c => c.u.endsWith("/api/ai-actions/run")).length === 1, "triple click starts one scan");

  check(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));

  // ── F-32: chat (its own small page) ──
  const chatPage = body => {
    const cd = new JSDOM(`<body><div id="chatPanel"><div id="chatMessages"></div><select id="chatModel"><option>m</option></select>
      <input id="chatInput"><button id="chatSendBtn" class="btn btn-primary">Send</button></div></body>`, { runScripts: "outside-only", pretendToBeVisual: true });
    const cw = cd.window;
    cw.TextDecoder = TextDecoder;
    cw.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }));
    cw.eval(fs.readFileSync(`${ROOT}/js/markdown.js`, "utf8"));
    cw.eval("var registerActions = () => {}; var api = async () => ({ cards: [] }); var escHtml = s => String(s).replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c])); var dargs = (...a) => JSON.stringify(a);");
    cw.eval(fs.readFileSync(`${ROOT}/js/app/ai-actions.js`, "utf8"));
    cw.eval(fs.readFileSync(`${ROOT}/js/chat.js`, "utf8") + "\n;window.__hist = () => chatHistory;");
    cw.document.dispatchEvent(new cw.Event("DOMContentLoaded"));
    return cw;
  };
  const ask = async (cw, q) => { cw.document.getElementById("chatInput").value = q; await cw.sendChat(); await sleep(30); };

  let cw = chatPage("\n\n[AI error: Anthropic refused the request (HTTP 400): messages: text content blocks must be non-empty]");
  await ask(cw, "hello");
  const last = () => [...cw.document.querySelectorAll(".msg-assistant")].pop();
  check(/AI error: Anthropic refused the request \(HTTP 400\): messages/.test(last().textContent) && last().classList.contains("msg-error"),
    "an error shows the provider's words");
  check(cw.__hist().length === 0, "…and neither the error nor the question is kept");

  cw = chatPage("");
  await ask(cw, "hello");
  check(/empty reply — nothing was kept/.test(last().textContent) && cw.__hist().length === 0, "an empty reply isn't kept");

  cw = chatPage("The NAS is **up**\n\n[AI error: Ollama stopped with an error: model runner stopped]");
  await ask(cw, "hello");
  check(last().querySelector("strong") && /model runner stopped/.test(last().querySelector(".msg-error-line").textContent),
    "a cut-off reply keeps its text and says why it stopped");
  const h = cw.__hist();
  check(h.length === 2 && h[1].content === "The NAS is **up**", "only the real text is kept in the conversation");

  cw = chatPage("All fine.");
  await ask(cw, "hello");
  check(cw.__hist().length === 2 && cw.__hist()[1].content === "All fine.", "a normal reply is kept as before");

  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
