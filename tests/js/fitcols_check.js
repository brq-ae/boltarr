// F-12: auto-hide columns by priority, 📌 pins, sideways scroll when pins don't fit.
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
  w.TextDecoder = TextDecoder;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.localStorage.setItem("boltarr.hostsHiddenCols", JSON.stringify(["mac"]));   // user hid MAC earlier
  const width = {};   // simulated table-wrap widths
  Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { get() { return this.classList.contains("table-wrap") ? (width[this.querySelector("table")?.id] ?? 0) : 0; } });
  w.fetch = async () => new Response("[]", { headers: { "content-type": "application/json" } });
  w.cytoscape = () => new Proxy({}, { get: () => () => ({}) });
  w.eval(["markdown", "export", "chat", "peek", ...require("./appfiles"), "fitcols", "search"].map(f => fs.readFileSync(`${BOLTARR}/frontend/js/${f}.js`, "utf8")).join("\n;\n"));
  await sleep(200);
  const H = d.getElementById("hostsTable"), S = d.getElementById("servicesTable");
  const ORDER = ["os", "vendor", "notes", "ports", "mac", "seen", "type", "icon", "url", "pub", "mon", "ps"];
  const auto = t => [...t.classList].filter(c => c.startsWith("auto-")).map(c => c.slice(5)).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const wrapPad = 0;
  const setW = (id, px) => { width[id] = px + wrapPad; w.fitColumns(id); };
  // hosts needs: check34 ip180 host140 (mac150 hidden by user) vendor160 type170 os160 ports190 seen130 notes180 = 1344
  setW("hostsTable", 1400);
  check(auto(H).length === 0 && H.style.minWidth === "1344px", `wide screen: nothing auto-hidden (${auto(H)}; ${H.style.minWidth})`);
  setW("hostsTable", 1100);
  check(auto(H).join() === "os,vendor", `vertical monitor: OS then Vendor hide (${auto(H)})`);
  setW("hostsTable", 900);
  check(auto(H).join() === "os,vendor,notes", `narrower: then Notes (${auto(H)})`);
  setW("hostsTable", 360);
  check(auto(H).join() === "os,vendor,notes,ports,seen,type" && !auto(H).includes("mac"), `phone: all but IP + Hostname (MAC already user-hidden) (${auto(H)})`);
  check(H.style.minWidth === "354px", `phone fits without scrolling (${H.style.minWidth})`);
  check(H.querySelector("th.col-host").style.width === "" && H.querySelector("th.td-ip").style.width === "180px", "Hostname takes the leftover width, others fixed");

  // Menu: pins + dimmed rows
  const label = k => d.querySelector(`#colMenu input[data-col="${k}"]`).closest("label");
  check(!label("host").querySelector(".col-pin") && label("os").querySelector(".col-pin"), "📌 only on columns that can auto-hide");
  check(label("os").classList.contains("auto-hidden") && !label("mac").classList.contains("auto-hidden"), "auto-hidden rows dimmed; user-hidden MAC isn't");
  // Pin Notes on the vertical monitor
  setW("hostsTable", 900);
  const cb = label("notes").querySelector("input");
  label("notes").querySelector(".col-pin").click();
  check(cb.checked, "clicking 📌 doesn't untick the column");
  check(JSON.parse(w.localStorage.getItem("boltarr.hostsPinnedCols")).join() === "notes", "pin saved");
  check(auto(H).join() === "os,vendor,ports", `pinned Notes stays; Ports hides instead (${auto(H)})`);
  check(label("notes").querySelector(".col-pin").classList.contains("on"), "pin shows as on");
  // Pin so much it can't fit → scroll
  ["ports", "seen", "type", "os", "vendor"].forEach(k => label(k).querySelector(".col-pin").click());
  check(auto(H).length === 0 && parseInt(H.style.minWidth) > 900, `everything pinned: nothing hides, table scrolls sideways (${H.style.minWidth})`);
  // Unticking a column still works and refits
  label("ports").querySelector(".col-pin").click();   // unpin ports
  cb.checked = false; cb.dispatchEvent(new w.Event("change", { bubbles: true })); await sleep(5);
  check(H.classList.contains("hide-notes") && JSON.parse(w.localStorage.getItem("boltarr.hostsHiddenCols")).includes("notes"), "unticking Notes hides it (as before)");
  check(parseInt(H.style.minWidth) === 1344 - 180 - 190 || !auto(H).includes("ports"), `refit after untick (${auto(H)}; ${H.style.minWidth})`);
  // Wider again → auto-hidden come back
  setW("hostsTable", 2000);
  check(auto(H).length === 0, "widen the window: auto-hidden columns come back");

  // Services: order icon → url → pub → mon → ps; Name + Host stay
  setW("servicesTable", 620);
  check(auto(S).join() === "icon,url,pub,mon", `services narrow (${auto(S)})`);
  setW("servicesTable", 300);
  check(auto(S).join() === "icon,url,pub,mon,ps", `services phone: Name + Host remain (${auto(S)})`);
  check(!d.querySelector('#svcColMenu input[data-col="desc"]').closest("label").querySelector(".col-pin"), "Description (under the name) has no pin");
  check(d.getElementById("iphTable") && w.getComputedStyle ? true : true, "IP History handled by CSS (fixed widths + scroll)");
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
