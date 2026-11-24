// v0.27.0 status page: F-27 "may be out of date" banner, F-28 Paused / Maintenance
// items (tag, note, bars), health banner ignores pauses. Self-contained (fake /data).
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const ROOT = `${BOLTARR}/statuspage`;
let html = fs.readFileSync(`${ROOT}/index.html`, "utf8");
html = html.replace(/<script src="\/static\/app.js"><\/script>/,
  `<script>${fs.readFileSync(`${ROOT}/static/app.js`, "utf8").replace(/<\/script>/g, "<\\/script>")}</script>`);
html = html.replace(/<link[^>]+stylesheet[^>]*>/g, "");
let fail = 0; const errors = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const bars = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ date: `Nov ${i + 1}`, pct: 100, ...(extra[i] || {}) }));
let DATA;
const base = () => ({
  updated_at: new Date().toISOString(), timezone: "UTC", display: { bar_period: "24h", uptime_window: "24h" },
  branding: {}, announcements: [], maintenance: { active: [], upcoming: [], tz: "UTC" }, incidents: [],
  services: [
    { key: "svc-1", name: "Demo Web", status: "up", uptime: { "24h": 100 }, ticks: { "24h": bars(24) } },
    { key: "svc-2", name: "Demo Media", status: "maintenance", note: "Demo: updating <b>v2</b>",
      until: "2026-11-20T17:00:00+00:00", uptime: { "24h": 100 },
      ticks: { "24h": bars(24, { 22: { pct: null, pause: "maint" }, 23: { pct: null, pause: "maint" } }) } },
    { key: "svc-3", name: "Demo DNS", status: "paused", uptime: { "24h": 100 },
      ticks: { "24h": bars(24, { 23: { pct: null, pause: "paused" } }) } },
  ], hosts: [], networking: [] });
const vc = new VirtualConsole();
vc.on("jsdomError", e => errors.push(String(e.message || e)));
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://sp.test/", virtualConsole: vc,
  beforeParse(w) {
    w.fetch = async (u) => new Response(JSON.stringify(String(u).includes("/data") ? DATA : {}),
      { headers: { "content-type": "application/json" } });
    w.alert = () => {}; w.confirm = () => true;
  } });
const w = dom.window, d = w.document, $ = id => d.getElementById(id);
(async () => {
  DATA = base();
  await sleep(300); await w.load(true); await sleep(100);
  const cards = [...d.querySelectorAll("#list .svc")];
  const media = cards.find(c => /Demo Media/.test(c.textContent)), dns = cards.find(c => /Demo DNS/.test(c.textContent));
  check(cards.length === 3, "paused + maintenance services stay listed");
  check(media && media.querySelector(".dot.maint") && /Maintenance/.test(media.querySelector(".svc-tag.maint").textContent),
    "maintenance: orange dot + Maintenance tag");
  check(media && /Demo: updating <b>v2<\/b>/.test(media.querySelector(".svc-note").textContent) && !media.querySelector(".svc-note b"),
    "the note is shown as text (escaped)");
  check(media && /until/.test(media.querySelector(".svc-note").textContent), "the end time is shown");
  check(dns && dns.querySelector(".dot.unknown") && /Paused/.test(dns.querySelector(".svc-tag").textContent)
    && !dns.querySelector(".svc-note"), "paused: grey dot + Paused tag, no note");
  const mBars = media ? [...media.querySelectorAll(".day")] : [];
  check(mBars.slice(-2).every(b => b.classList.contains("maint")) && /maintenance/.test(mBars[23].title), "maintenance bars are orange");
  const dBars = dns ? [...dns.querySelectorAll(".day")] : [];
  check(dBars[23] && dBars[23].classList.contains("unknown") && /paused/.test(dBars[23].title), "paused bar is grey, says paused");
  check($("banner").className === "banner maint" && /Maintenance in progress/.test($("banner").textContent),
    "health banner: Maintenance in progress (not 'down')");
  check($("stale").className === "hidden", "fresh data: no 'out of date' banner");

  DATA = base(); DATA.services[0].status = "down";
  await w.load(true); await sleep(50);
  check($("banner").className === "banner bad", "a real down still wins over maintenance");

  DATA = base(); DATA.services = DATA.services.filter(s => s.status !== "maintenance");
  await w.load(true); await sleep(50);
  check($("banner").className === "banner ok", "paused only: All systems operational");

  DATA = base(); DATA.stale = { minutes: 12 };
  await w.load(true); await sleep(50);
  check($("stale").className === "banner stale" && /may be out of date — last update 12 min ago/.test($("stale").textContent),
    "stale: yellow 'may be out of date' banner with minutes");
  DATA.stale = { minutes: 190 }; await w.load(true); await sleep(50);
  check(/3 h ago/.test($("stale").textContent), "long gaps in hours");
  DATA.stale = { minutes: 4320 }; await w.load(true); await sleep(50);
  check(/3 days ago/.test($("stale").textContent), "very long gaps in days");
  delete DATA.stale; await w.load(true); await sleep(50);
  check($("stale").className === "hidden", "banner goes away once updates come again");

  // Older Boltarr payloads (no pause fields) still render as before
  DATA = base(); DATA.services = [{ key: "svc-9", name: "Old", status: "up", uptime: { "24h": 99 }, ticks: { "24h": bars(24) } }];
  await w.load(true); await sleep(50);
  check(d.querySelectorAll("#list .svc").length === 1 && !d.querySelector(".svc-tag"), "older payload: unchanged");

  check(errors.length === 0, "no script errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
})();
