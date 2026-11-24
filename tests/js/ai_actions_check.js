// v0.26.0 AI Tier 4 part 1: action cards in the chat.
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
let REPLY = "", checks = [], runs = [], RUN_REPLY = { ok: true, message: "Note on demo-nas (10.9.0.2) changed." }, chatBodies = [];
const CARDS = {
  set_note: { ok: true, kind: "change", title: "Change the note on demo-nas (10.9.0.2)", detail: [["From", "old <b>"], ["To", "Backup NAS"]] },
  open_host: { ok: true, kind: "open", title: "Open demo-nas (10.9.0.2)", target: { type: "host", ip: "10.9.0.2" } },
  explain: { ok: true, kind: "open", title: "Explain the latest outage of Demo SMB on demo-nas", target: { type: "service", id: 4, explain: true } },
  scan: { ok: true, kind: "change", title: "Scan Demo LAN (10.9.0.0/24) with Full", detail: [["Profile", "Full"], ["Command", "nmap -p- 10.9.0.0/24"]], then: { type: "scans" } },
  pause_monitor: { ok: true, kind: "change", title: "Pause monitoring of Demo SMB on demo-nas", detail: [["Until", "2026-11-13 18:00"]] },
};
let cancels = [], LOG = [];
let SVC = { id: 4, name: "Demo SMB", ip: "10.9.0.2", hostname: "demo-nas", monitored: 1, status: "up" }, statusCalls = 0;
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
    w.fetch = async (u, o) => { u = String(u); const m = (o && o.method) || "GET";
      if (u.endsWith("/api/chat/stream")) {
        chatBodies.push(JSON.parse(o.body));
        const parts = [REPLY.slice(0, 25), REPLY.slice(25, 60), REPLY.slice(60)];
        const stream = new ReadableStream({ start(c) { parts.forEach(p => c.enqueue(new TextEncoder().encode(p))); c.close(); } });
        return new Response(stream, { status: 200 });
      }
      if (u.endsWith("/api/ai-actions/check")) {
        const acts = JSON.parse(o.body).actions; checks.push(acts);
        return j({ cards: acts.map(a => { let p; try { const wd = a.match(/^([A-Za-z_]+)\s*(?=\{)/); p = JSON.parse(wd ? a.slice(wd[0].length) : a); if (wd && !p.do) p.do = wd[1]; } catch { return { ok: false, error: "Boltarr couldn't read this suggestion." }; }
          return CARDS[p.do] ? { ...CARDS[p.do], action: p } : { ok: false, error: "Boltarr can't do this: it isn't one of the actions the AI may suggest." }; }) });
      }
      if (u.endsWith("/api/ai-actions/run")) { runs.push(JSON.parse(o.body)); return j(RUN_REPLY); }
      if (u.endsWith("/api/ai-actions/cancel")) { cancels.push(JSON.parse(o.body)); return j({ ok: true }); }
      if (u.endsWith("/api/ai-actions/log")) return j({ actions: LOG });
      const hm = u.match(/\/api\/hosts\/(10\.9\.0\.\d+)$/);
      if (hm) return j({ id: 1, ip: hm[1], hostname: "demo-nas", ports: [], services: [], analyses: [] });
      if (u.endsWith("/api/services")) return j([SVC]);
      if (/\/api\/scan\/\d+\/status$/.test(u)) { statusCalls++; return j({ status: "scanning", progress: 10 }); }
      if (u.includes("/api/services/4/uptime")) return j({ uptime: { "24h": { pct: 99 }, "7d": { pct: 99 }, "30d": { pct: 99 } },
        outages: [{ start: "2026-11-12T02:11:00+00:00", end: "2026-11-12T02:23:00+00:00", seconds: 720 }] });
      if (u.includes("/api/explain")) return j({ explanation: { id: 1, summary: "Demo cause", facts: ["f"], created_at: "2026-11-12 10:00:00" }, earlier: [] });
      return u.includes("/api/models") ? j({ models: ["demo-a"], default: "demo-a" })
        : u.includes("/api/auth/status") ? j({ enabled: false })
        : u.includes("/api/settings") ? j({ llm: { configured: true } })
        : u.includes("/api/graph") ? j({ nodes: [], edges: [] })
        : u.includes("/api/dhcp-warnings") ? j({ hosts: {}, pools: [] })
        : j(u.includes("config") || u.includes("status") ? {} : []); };
  } });
const w = dom.window, d = w.document, $ = id => d.getElementById(id);
async function ask(q, reply) {
  REPLY = reply; $("chatInput").value = q; w.sendChat(); await sleep(250);
  const msgs = d.querySelectorAll("#chatMessages .msg-assistant"); return msgs[msgs.length - 1];
}
(async () => {
  await sleep(700);
  check(errors.length === 0, `boots with no errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  // streaming: a half-typed marker is hidden
  check(!w.chatReplyHtml('Ok.\n[[action {"do":"set_no').includes("[[action"), "half-typed action line is hidden while streaming");
  check(w.chatReplyHtml('A\n[[action {"do":"x"}]]\nB').includes('class="ai-action-slot"'), "complete line becomes a slot");

  // the forms models slip into are read too (A+)
  const ex = t => w._aiExtract(t);
  check(JSON.stringify(ex('[[set_host {"host":"10.9.0.2","hostname":"r2"}]]').raws) === JSON.stringify(['set_host {"host":"10.9.0.2","hostname":"r2"}']), "[[set_host {...}]] is read, its word kept");
  check(ex('Here:\n```json\n{"do":"open_host","host":"10.9.0.2"}\n```\nok').raws.length === 1, "JSON with \"do\" in a code block is read");
  check(ex('```json\n[[action {"do":"open_host","host":"10.9.0.2"}]]\n```').raws.length === 1 && !ex('```json\n[[action {"do":"open_host","host":"10.9.0.2"}]]\n```').marked.includes("```"), "a marker inside a code block is read, the block dropped");
  check(ex('{"do":"open_host","host":"10.9.0.2"}').raws.length === 1, "a JSON line with \"do\" on its own is read");
  check(ex('```json\n{"name":"x"}\n```').raws.length === 0 && !ex('```json\n{"name":"x"}\n```').tried, "other code blocks are left alone");
  check(ex('[[action {"do":"open_host"').tried && ex('Try [[set_note {"host": 1}').tried && !ex("Plain answer.").tried, "an unreadable try is noticed");

  let msg = await ask("note it", 'I suggest this:\n[[action {"do":"set_note","host":"10.9.0.2","note":"Backup NAS"}]]\nClick Do it.');
  check(!msg.textContent.includes("[[action") && msg.textContent.includes("I suggest this") && msg.textContent.includes("Click Do it"), "marker hidden, text kept");
  check(checks.length === 1 && JSON.parse(checks[0][0]).note === "Backup NAS", "suggestion sent to the server to check");
  const card = msg.querySelector(".ai-action");
  check(card && card.textContent.includes("Change the note on demo-nas") && card.textContent.includes("old <b>"), "card shows the change, escaped");
  check(runs.length === 0, "nothing done before clicking");
  card.querySelector('[data-click="aiActionDo"]').click(); await sleep(150);
  check(runs.length === 1 && runs[0].action.note === "Backup NAS", "Do it sends the action");
  check(runs[0].asked === "note it" && runs[0].model === "demo-a", "Do it sends what was asked and the model, for the record");
  check(card.querySelector(".ai-action-ok").textContent.includes("changed") && !card.querySelector("button"), "shows ✓ and removes the buttons");

  // the AI hears about the result on the next message
  await ask("thanks", "You're welcome.");
  const hist = chatBodies[chatBodies.length - 1].messages;
  check(hist[1].content.includes("[Result: the user clicked Do it. Note on demo-nas"), "result is added to the chat history for the AI");

  // cancel + refused + failed
  msg = await ask("two things", '[[action {"do":"set_note","host":"10.9.0.2","note":"x"}]]\n[[action {"do":"delete_host","host":"10.9.0.2"}]]\n[[action {bad json}]]');
  const cards = msg.querySelectorAll(".ai-action");
  check(cards.length === 3 && cards[1].classList.contains("ai-action-bad") && cards[1].textContent.includes("isn't one of the actions")
        && cards[2].textContent.includes("couldn't read"), "unknown and unreadable suggestions show as not possible");
  cards[0].querySelector('[data-click="aiActionCancel"]').click(); await sleep(50);
  check(cards[0].textContent.includes("Cancelled") && runs.length === 1, "Cancel does nothing on the server");
  check(cancels.length === 1 && cancels[0].action.note === "x" && cancels[0].asked === "two things", "Cancel is sent to be recorded");
  msg = await ask("again", '[[action {"do":"set_note","host":"10.9.0.2","note":"y"}]]');
  RUN_REPLY = { ok: false, error: "There's no host '10.9.0.2' in Boltarr." };
  msg.querySelector('[data-click="aiActionDo"]').click(); await sleep(150);
  check(msg.querySelector(".ai-action-fail").textContent.includes("no host"), "a failed run shows why");

  msg = await ask("rename", 'I suggest:\n[[set_note {"host":"10.9.0.2","note":"broken" and the rest of my reply');
  check(msg.querySelector(".ai-action-bad")?.textContent.includes("wrote it in a way Boltarr can't read") && msg.textContent.includes("the rest of my reply"),
        "unreadable try: shows the full reply and a note to ask again");
  msg = await ask("rename2", 'Sure:\n[[set_note {"host":"10.9.0.2","note":"via slip"}]]');
  check(msg.querySelector('[data-click="aiActionDo"]') && checks[checks.length - 1][0].startsWith("set_note {"), "a [[set_note {...}]] slip still gives a working card");

  // open + explain
  msg = await ask("show", '[[action {"do":"open_host","host":"10.9.0.2"}]]');
  check(msg.querySelector('[data-click="aiActionDo"]').textContent === "Open" && !msg.querySelector('[data-click="aiActionCancel"]'), "open card has one Open button");
  msg.querySelector('[data-click="aiActionDo"]').click(); await sleep(200);
  check($("hostDetail").classList.contains("open") && $("hostDetail").textContent.includes("10.9.0.2"), "Open shows the host panel");
  msg = await ask("why", '[[action {"do":"explain","service":"Demo SMB","host":"10.9.0.2"}]]');
  msg.querySelector('[data-click="aiActionDo"]').click(); await sleep(300);
  const eb = d.querySelector(".explain-box");
  check(eb && !eb.hidden && eb.textContent.includes("Demo cause"), "Explain opens the service and its latest outage's explanation");

  // part 2: scan → progress + Open Scans; pause → services reloaded, panel says paused until
  RUN_REPLY = { ok: true, message: "Scan of 10.9.0.0/24 with Full started.", run_id: 77, subnet_id: 1 };
  msg = await ask("scan", '[[action {"do":"scan","subnet":"10.9.0.0/24","profile":"Full"}]]');
  check(msg.textContent.includes("nmap -p- 10.9.0.0/24"), "scan card shows the nmap command");
  msg.querySelector('[data-click="aiActionDo"]').click(); await sleep(1800);
  check(w.eval("activeRunId") === 77 && statusCalls > 0 && $("scanProgress").classList.contains("visible"), "Do it follows the scan's progress like the Scan button");
  const os = msg.querySelector('[data-click="aiOpenScans"]');
  check(os && !msg.querySelector('[data-click="aiActionDo"]'), "Open Scans button replaces Do it");
  os.click(); await sleep(100);
  check($("panel-scans").classList.contains("active") && $("scan-panel-history").style.display === "", "Open Scans shows the Scan Log");
  w.eval("clearInterval(pollTimer)");

  w.showSvcDetail(4); await sleep(100);
  RUN_REPLY = { ok: true, message: "Monitoring of Demo SMB on demo-nas paused until 2026-11-13 18:00.", service_id: 4 };
  SVC = { ...SVC, monitored: 0, monitor_resume_at: "2026-11-13T15:00:00+00:00" };
  msg = await ask("pause", '[[action {"do":"pause_monitor","service":"Demo SMB","until":"2026-11-13 18:00"}]]');
  msg.querySelector('[data-click="aiActionDo"]').click(); await sleep(250);
  check($("svcDetailMonitorText").textContent.startsWith("paused until") && !$("svcDetailMonitored").checked, "open service panel updates to 'paused until'");
  check(w.svcMonToggle(SVC).includes(">Paused<"), "services table shows Paused");

  // the pause ends: the screen reloads by itself at that time
  SVC = { ...SVC, monitor_resume_at: new Date(Date.now() + 300).toISOString() };
  await w.loadServicesData(); w.showSvcDetail(4); await sleep(50);
  check($("svcDetailMonitorText").textContent.startsWith("paused until"), "panel shows the timed pause");
  SVC = { ...SVC, monitored: 1, monitor_status: "up", monitor_resume_at: null };   // the server resumed it
  await sleep(2800);
  check($("svcDetailMonitored").checked && $("svcDetailMonitorText").textContent === "up", "open panel switches to On when the pause ends");
  // reopening a panel whose pause has already ended reloads first
  SVC = { ...SVC, monitored: 0, monitor_status: "unknown", monitor_resume_at: new Date(Date.now() - 60000).toISOString() };
  await w.loadServicesData(); w.eval("clearTimeout(svcResumeTimer)");
  SVC = { ...SVC, monitored: 1, monitor_status: "up", monitor_resume_at: null };
  w.hideSvcDetail?.(); w.showSvcDetail(4); await sleep(150);
  check($("svcDetailMonitored").checked, "reopening after the pause ended shows it On");


  // part 3: the record in Settings → AI
  LOG = [{ id: 2, title: "Change the note on demo-nas", result: "failed", message: "There's no <host>", detail: [["From", "a"], ["To", "b"]], model: "demo-a:latest", asked: "do <it>", created_at: "2026-11-13 10:00:00" },
         { id: 1, title: "Scan Demo LAN", result: "cancelled", detail: [], model: "", asked: "", created_at: "2026-11-13 09:00:00" }];
  await w.loadAiHistory();
  const lg = $("aiActionsLog");
  check(lg.querySelector("summary").textContent === "AI actions (2)" && lg.querySelectorAll(".ai-log-item").length === 2, "Settings lists the AI actions");
  check(lg.textContent.includes("✕ Failed") && lg.textContent.includes("There's no <host>") && lg.textContent.includes("You asked: “do <it>”")
        && lg.textContent.includes("Cancelled") && !lg.innerHTML.includes("<host>"), "shows result, why it failed and what was asked, escaped");
  LOG = []; await w.loadAiHistory();
  check(lg.textContent.includes("none recorded yet"), "empty record says so");

  check(errors.length === 0, `no errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
