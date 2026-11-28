// F-46: map moves save to Boltarr on their own (no Save Layout button), the saved layout
// wins over the browser's, the last 20 moves can be undone (↶ Undo or Ctrl+Z), and an
// old browser-only layout is offered once, never written quietly. Uses the real map
// library in headless mode, with a fake API.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM } = require("jsdom");
const fs = require("fs");
const html = fs.readFileSync(`${BOLTARR}/frontend/index.html`, "utf8");
const body = html.slice(html.indexOf("<body"), html.indexOf("<script src=\"/js/graph.js\""));
const CY = fs.readFileSync(`${BOLTARR}/frontend/vendor/cytoscape.min.js`, "utf8");
const APP = ["graph", "markdown", "export", "chat", "peek", ...require("./appfiles"), "fitcols", "search"]
  .map(f => fs.readFileSync(`${BOLTARR}/frontend/js/${f}.js`, "utf8")).join("\n;\n")
  + "\n;window.__cy = () => cy;";   // the map, for the checks (top-level let stays inside this eval)
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const near = (p, q) => p && q && Math.abs(p.x - q.x) < 0.01 && Math.abs(p.y - q.y) < 0.01;

const node = (ip, pos) => ({ data: { id: ip, ip, label: ip, device_type: "server", ...(pos ? { pos_x: pos.x, pos_y: pos.y } : {}) } });

// One app page. graph(): what /api/graph returns; local: the old browser-only layout, if any
async function page({ graph, local = null, failSaves = () => false, view = null }) {
  const dom = new JSDOM(body + "</body>", { runScripts: "outside-only", pretendToBeVisual: true, url: "http://x.test/" });
  const w = dom.window, d = w.document;
  if (d.readyState !== "complete") await new Promise(r => w.addEventListener("load", r));
  w.TextDecoder = TextDecoder; w.CSS = { escape: s => String(s) };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.alert = () => {};
  w.localStorage.setItem("boltarr.viewLevel", "advanced");
  if (local) w.localStorage.setItem("boltarr:layout", JSON.stringify(local));
  if (view) w.localStorage.setItem("boltarr:viewport", JSON.stringify(view));
  const saves = [];
  w.fetch = async (u, o = {}) => {
    const m = o.method || "GET", path = String(u).replace(/^.*?(\/api)/, "$1").split("?")[0];
    const j = (r, status = 200) => new Response(JSON.stringify(r), { status, headers: { "content-type": "application/json" } });
    if (path === "/api/layout" && m === "PUT") {
      const b = JSON.parse(o.body); saves.push(b.positions);
      return failSaves() ? j({ detail: "down" }, 503) : j({ ok: true, saved: Object.keys(b.positions).length });
    }
    if (path === "/api/graph") return j(graph());
    if (path === "/api/settings") return j({ general: {}, llm: {}, statuspage: {}, notifications: {}, telegram: {}, change_tracking: {}, liveness: {}, ip_history: {}, ai_history: {}, security: {}, change_alerts: {}, monitoring: {} });
    if (path === "/api/auth/status") return j({ enabled: true });
    if (path === "/api/ui/welcome") return j({ show: false });
    return j([]);
  };
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/level.js`, "utf8"));
  w.eval(CY);
  // headless (no drawing in jsdom); made inside the page, where the library expects to be called
  w.eval("window.cytoscape = (real => opts => real({ ...opts, container: undefined, headless: true, styleEnabled: true }))(window.cytoscape);");
  // headless has no size; give it a screen's worth so "fit the whole map" can be checked
  w.eval("window.cytoscape = (make => opts => { const c = make(opts); c.width = () => 1200; c.height = () => 800; return c; })(window.cytoscape);");
  w.console.warn = () => {};   // the library's notes about styles it can't draw headless
  w.eval(APP);
  d.dispatchEvent(new w.Event("DOMContentLoaded"));
  await sleep(300);
  w.setTab("topology"); await sleep(200);
  const at = ip => ({ ...w.__cy().getElementById(ip).position() });
  const drag = (ips, dx, dy) => {
    const cy = w.__cy();
    ips.forEach(ip => cy.getElementById(ip).emit("grab"));
    ips.forEach(ip => { const p = at(ip); cy.getElementById(ip).position(w.JSON.parse(JSON.stringify({ x: p.x + dx, y: p.y + dy }))); });   // a spot made inside the page (the library ignores outside objects)
    ips.forEach(ip => cy.getElementById(ip).emit("free"));
  };
  const key = (target, k = "z", extra = {}) =>
    target.dispatchEvent(new w.KeyboardEvent("keydown", { key: k, ctrlKey: true, bubbles: true, cancelable: true, ...extra }));
  return { w, d, get cy() { return w.__cy(); }, at, drag, key, saves, $: id => d.getElementById(id) };
}

(async () => {
  const A = { x: 100, y: 100 }, B = { x: 300, y: 100 };

  // ── The saved layout wins; moves save on their own ──────────────────────────
  {
    const p = await page({ graph: () => ({ nodes: [node("10.62.1.1", A), node("10.62.1.2", B), node("10.62.1.3")], edges: [] }) });
    const { $, at, drag, key, saves, w, d } = p;
    check(!$("saveLayoutBtn") && $("undoMoveBtn"), "the Save Layout button is gone; ↶ Undo is there");
    check(near(at("10.62.1.1"), A) && near(at("10.62.1.2"), B), "devices sit where Boltarr saved them");
    check($("undoMoveBtn").disabled, "Undo is greyed out with nothing to undo");
    check($("undoMoveBtn").getAttribute("aria-label") && /Ctrl\+Z/.test($("undoMoveBtn").title), "Undo has a label for screen readers and shows Ctrl+Z on hover");
    await sleep(900);
    const placed = saves.find(s => s["10.62.1.3"]);
    check(placed && !placed["10.62.1.1"], "a device with no saved spot gets one, and that spot is saved (not the others)");
    saves.length = 0;

    drag(["10.62.1.1"], 50, 20);
    check(saves.length === 0, "nothing is sent while you're still moving things");
    await sleep(900);
    check(saves.length === 1 && near(saves[0]["10.62.1.1"], { x: 150, y: 120 }) && Object.keys(saves[0]).length === 1,
      "a moment after letting go, only the moved device is saved");
    check(!$("undoMoveBtn").disabled, "Undo is now available");

    saves.length = 0;
    drag(["10.62.1.1", "10.62.1.2"], 10, 10);
    await sleep(900);
    check(saves.length === 1 && Object.keys(saves[0]).length === 2, "dragging two selected devices: one save with both");

    // Ctrl+Z: the two-device move goes back together, and that is saved too
    saves.length = 0;
    key(d.body);
    check(near(at("10.62.1.1"), { x: 150, y: 120 }) && near(at("10.62.1.2"), B), "Ctrl+Z puts both devices back in one step");
    await sleep(900);
    check(saves.length === 1 && near(saves[0]["10.62.1.2"], B), "the undo is saved, so other browsers see it");

    // Ctrl+Z while typing keeps its normal meaning
    const box = $("gsInput");
    key(box);
    check(near(at("10.62.1.1"), { x: 150, y: 120 }), "Ctrl+Z in a text box doesn't touch the map");
    // …and not on another page
    w.setTab("hosts"); await sleep(50);
    key(d.body);
    check(near(at("10.62.1.1"), { x: 150, y: 120 }), "Ctrl+Z on another page doesn't touch the map");
    w.setTab("topology"); await sleep(100);
    // …nor with a window open
    w.askConfirm("Demo question"); await sleep(10);
    key(d.body);
    check(near(at("10.62.1.1"), { x: 150, y: 120 }), "Ctrl+Z with a window open doesn't touch the map");
    w.closeAsk(); await sleep(10);
    key(d.body, "z", { ctrlKey: false, metaKey: true });
    check(near(at("10.62.1.1"), A), "⌘Z (Mac) works too");
    check($("undoMoveBtn").disabled, "back to the start: Undo greyed out again");

    // The button, and the 20-step limit
    for (let i = 0; i < 22; i++) { drag(["10.62.1.2"], 5, 0); await sleep(5); }   // separate drags, as a person makes them
    await sleep(50);
    $("undoMoveBtn").click();
    check(near(at("10.62.1.2"), { x: B.x + 105, y: B.y }), "the ↶ Undo button undoes the last move");
    let n = 0; while (!$("undoMoveBtn").disabled && n < 50) { $("undoMoveBtn").click(); n++; }
    check(n === 19 && near(at("10.62.1.2"), { x: B.x + 10, y: B.y }), `only the last 20 moves can be undone (${n + 1})`);

    // Arrange in grid is one move
    p.cy.getElementById("10.62.1.1").select(); p.cy.getElementById("10.62.1.3").select();
    const before = at("10.62.1.3");
    w.arrangeSelectedInGrid();
    check(!$("undoMoveBtn").disabled, "Arrange in grid can be undone");
    $("undoMoveBtn").click();
    check(near(at("10.62.1.3"), before), "…and Undo puts them back");

    // Moving a device that was deleted since: skipped, no error
    drag(["10.62.1.3"], 5, 5);
    p.cy.getElementById("10.62.1.3").remove();
    let err = null; try { $("undoMoveBtn").click(); } catch (e) { err = e; }
    check(!err, "undoing the move of a device deleted since doesn't break");
  }

  // ── A failed save says so, keeps trying, and loses nothing ───────────────────
  {
    let down = true;
    const p = await page({ graph: () => ({ nodes: [node("10.62.2.1", A), node("10.62.2.2", B)], edges: [] }), failSaves: () => down });
    const toast = () => p.d.getElementById("_toast")?.textContent || "";
    p.drag(["10.62.2.1"], 30, 0); await sleep(900);
    check(/Couldn't save the map layout/.test(toast()), `a failed save shows a message ("${toast()}")`);
    down = false;
    p.saves.length = 0;
    p.drag(["10.62.2.2"], 30, 0); await sleep(900);
    check(p.saves.length === 1 && p.saves[0]["10.62.2.1"] && p.saves[0]["10.62.2.2"], "the next save also sends the move that failed");
    check(/Map layout saved/.test(toast()), "…and says when saving works again");
  }

  // ── An old browser-only layout is offered once ───────────────────────────────
  const OLD = { "10.62.3.1": { x: 900, y: 900 } };
  {
    const p = await page({ graph: () => ({ nodes: [node("10.62.3.1", A)], edges: [] }), local: OLD });
    const ask = p.$("askModal");
    check(ask.classList.contains("open") && /isn't saved in Boltarr/.test(p.$("askText").textContent), "a layout only in this browser: Boltarr asks before saving it");
    check(near(p.at("10.62.3.1"), A), "…and shows Boltarr's saved layout until you answer");
    p.$("askOk").click(); await sleep(900);
    check(near(p.at("10.62.3.1"), OLD["10.62.3.1"]) && p.saves.some(s => near(s["10.62.3.1"], OLD["10.62.3.1"])), "Save it: this browser's layout is used and saved");
    check(p.w.localStorage.getItem("boltarr:layout") === null, "…and the browser's copy is gone (asked only once)");
    check(!p.$("undoMoveBtn").disabled, "…and it can be undone");
  }
  {
    const p = await page({ graph: () => ({ nodes: [node("10.62.3.1", A)], edges: [] }), local: OLD });
    p.$("askCancel").click(); await sleep(900);
    check(near(p.at("10.62.3.1"), A) && !p.saves.some(s => s["10.62.3.1"]), "Cancel: Boltarr's layout stays, nothing is overwritten");
    check(p.w.localStorage.getItem("boltarr:layout") === null, "…and it isn't asked again");
  }
  {
    const p = await page({ graph: () => ({ nodes: [node("10.62.3.1", A)], edges: [] }), local: { "10.62.3.1": A } });
    check(!p.$("askModal").classList.contains("open") && p.w.localStorage.getItem("boltarr:layout") === null,
      "the browser's copy matches Boltarr's: no question, the copy is just dropped");
  }

  // ── The view: this browser's last view, or the whole map if it has none ──────
  {
    const far = { x: 3000, y: 2000 };
    const p = await page({ graph: () => ({ nodes: [node("10.62.5.1", { x: -2000, y: -1000 }), node("10.62.5.2", far)], edges: [] }) });
    const bb = p.cy.extent(), inView = q => q.x >= bb.x1 && q.x <= bb.x2 && q.y >= bb.y1 && q.y <= bb.y2;
    check(inView({ x: -2000, y: -1000 }) && inView(far) && p.cy.zoom() < 1, "a browser with no saved view sees the whole map (not a corner at 100%)");
  }
  {
    const view = { pan: { x: 37, y: 52 }, zoom: 1.7 };
    const p = await page({ graph: () => ({ nodes: [node("10.62.5.1", { x: -2000, y: -1000 }), node("10.62.5.2", { x: 3000, y: 2000 })], edges: [] }), view });
    check(Math.abs(p.cy.zoom() - 1.7) < 1e-6 && near(p.cy.pan(), view.pan), "a browser with a saved view keeps it");
  }

  // ── A new install: the first layout is saved, so every browser shows the same ─
  {
    const p = await page({ graph: () => ({ nodes: [node("10.62.4.1"), node("10.62.4.2"), node("10.62.4.3")], edges: [] }) });
    await sleep(1800);
    const all = p.saves.find(s => s["10.62.4.1"] && s["10.62.4.2"] && s["10.62.4.3"]);
    check(all && near(all["10.62.4.2"], p.at("10.62.4.2")), "with nothing saved yet, the first automatic layout is saved");
    check(p.$("undoMoveBtn").disabled, "…and isn't an undo step");
  }

  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
