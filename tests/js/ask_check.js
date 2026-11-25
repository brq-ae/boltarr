// S-34: Boltarr's own ask window replaces the browser's confirm()/prompt(). It answers
// true/false (or the typed text / null), keeps focus inside, gives focus back, and shows
// text as text. The browser's popups are never used.
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
  if (d.readyState !== "complete") await new Promise(r => w.addEventListener("load", r));
  w.TextDecoder = TextDecoder; w.CSS = { escape: s => String(s) };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.localStorage.setItem("boltarr.viewLevel", "advanced");
  let popups = 0;
  w.alert = () => {}; w.confirm = () => { popups++; return true; }; w.prompt = () => { popups++; return "x"; };
  const sent = [];
  w.fetch = async (u, o = {}) => {
    const m = o.method || "GET", path = u.replace(/^.*?(\/api)/, "$1").split("?")[0];
    if (m !== "GET") sent.push([m, path]);
    const j = r => new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
    if (path === "/api/hosts") return j([{ id: 1, ip: "10.46.0.1", hostname: "demo-nas", online: 1, ports: [] }]);
    if (path === "/api/graph") return j({ nodes: [], edges: [] });
    if (path === "/api/settings") return j({ general: {}, llm: {}, statuspage: {}, notifications: {}, change_tracking: {}, liveness: {}, ip_history: {}, ai_history: {}, security: {}, change_alerts: {} });
    if (path === "/api/auth/status") return j({ enabled: true });
    if (path === "/api/ui/welcome") return j({ show: false });
    return j([]);
  };
  w.cytoscape = () => new Proxy({}, { get: () => () => ({}) });
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/level.js`, "utf8"));
  w.eval(["markdown", "export", "chat", "peek", ...require("./appfiles"), "fitcols", "search"].map(f => fs.readFileSync(`${BOLTARR}/frontend/js/${f}.js`, "utf8")).join("\n;\n"));
  d.dispatchEvent(new w.Event("DOMContentLoaded"));
  await sleep(300);
  const $ = id => d.getElementById(id), win = $("askModal");
  const key = (k, shift = false) => d.activeElement.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true }));

  // Yes / No, and where focus goes
  const opener = d.createElement("button"); d.body.appendChild(opener); opener.focus();
  let p = w.askConfirm("Delete <b>this</b>?", { text: "Line one\nLine two", button: "Delete", danger: true });
  check(win.classList.contains("open") && $("askTitle").textContent === "Delete <b>this</b>?" && !$("askTitle").querySelector("b"),
    "opens, and the question is shown as text (no HTML)");
  check($("askText").textContent === "Line one\nLine two" && $("askInput").hidden, "details shown; no text box for a yes/no");
  check($("askOk").textContent === "Delete" && $("askOk").classList.contains("btn-danger"), "button says Delete, in red");
  check(d.activeElement === $("askCancel"), "a delete starts on Cancel, so Enter can't delete by accident");
  // (moving between buttons is the browser's own; Boltarr wraps at the ends)
  $("askOk").focus(); key("Tab"); check(d.activeElement === $("askCancel"), "Tab past the last button wraps round, staying inside the window");
  key("Tab", true); check(d.activeElement === $("askOk"), "Shift+Tab past the first wraps the other way");
  opener.focus(); key("Tab"); check(d.activeElement === $("askCancel"), "Tab from outside comes back into the window");
  $("askOk").click();
  check(await p === true && !win.classList.contains("open") && d.activeElement === opener, "Delete answers yes, closes, focus goes back");
  p = w.askConfirm("Sure?");
  check(d.activeElement === $("askOk") && $("askOk").classList.contains("btn-primary") && $("askOk").textContent === "OK", "a plain question starts on OK");
  key("Escape");
  check(await p === false && !win.classList.contains("open"), "Escape answers no");
  p = w.askConfirm("First?");
  const p2 = w.askConfirm("Second?");
  check(await p === false && $("askTitle").textContent === "Second?", "a new question replaces one still open (the old one answers no)");
  $("askCancel").click(); check(await p2 === false, "Cancel answers no");

  // The name box
  p = w.askText("Name this scan profile", { button: "Save", input: { placeholder: "e.g. Quick ports" } });
  check(!$("askInput").hidden && d.activeElement === $("askInput") && $("askInput").value === "", "the name box shows, empty, with focus");
  $("askInput").value = "Demo ports"; key("Enter");
  check(await p === "Demo ports" && !win.classList.contains("open"), "Enter saves the typed name");
  p = w.askText("Name?"); $("askInput").value = "typed"; $("askCancel").click();
  check(await p === null, "Cancel gives nothing, even with text typed");

  // A real action uses it, and answering no sends nothing
  sent.length = 0;
  const del = w.deleteHost("10.46.0.1");
  check(win.classList.contains("open") && /Delete .*demo-nas|Delete .*10\.46\.0\.1/.test($("askTitle").textContent), `Delete host asks in Boltarr's window ("${$("askTitle").textContent}")`);
  $("askCancel").click(); await del; await sleep(20);
  check(!sent.length, "No: nothing deleted");
  const del2 = w.deleteHost("10.46.0.1"); $("askOk").click(); await del2; await sleep(20);
  check(sent.some(s => s[0] === "DELETE" && s[1] === "/api/hosts/10.46.0.1"), "Yes: the device is deleted");
  check(popups === 0, `the browser's own popups were never used (${popups})`);
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
