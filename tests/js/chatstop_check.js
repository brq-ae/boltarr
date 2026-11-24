// Chat Stop button: Send ↔ Stop, keeps partial text, Esc works, early stop drops the question.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM } = require("jsdom");
const fs = require("fs");
function setup(slowFirst) {
  const dom = new JSDOM(`<body><div id="chatPanel"><div id="chatMessages"></div><select id="chatModel"><option>m</option></select>
    <input id="chatInput"><button id="chatSendBtn" class="btn btn-primary">Send</button></div></body>`, { runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.TextDecoder = TextDecoder;
  w.fetch = (u, o) => new Promise((resolve, reject) => {
    o.signal.addEventListener("abort", () => reject(new w.DOMException("aborted", "AbortError")));
    const start = () => { let i = 0;
      resolve(new Response(new ReadableStream({ async pull(c) {
        if (o.signal.aborted) return c.error(new w.DOMException("aborted", "AbortError"));
        c.enqueue(new TextEncoder().encode(`**w${i++}** `)); await new Promise(r => setTimeout(r, 30)); } })));
    };
    slowFirst ? setTimeout(start, 5000) : start();
  });
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/markdown.js`, "utf8"));
  w.eval("var registerActions = () => {}; var api = async () => ({ cards: [] }); var escHtml = s => String(s); var dargs = (...a) => JSON.stringify(a);"); w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/app/ai-actions.js`, "utf8"));  // chat.js uses its chatReplyHtml (v0.26.0)
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/chat.js`, "utf8") + "\n;window.__hist = () => chatHistory;");
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  return w;
}
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  // 1. Stop mid-reply with the button
  let w = setup(false), d = w.document, btn = d.getElementById("chatSendBtn");
  d.getElementById("chatInput").value = "long question";
  const p = w.sendChat(); await sleep(150);
  check(btn.textContent === "■ Stop" && btn.classList.contains("btn-danger"), "Send turns into ■ Stop while replying");
  btn.click(); await p; await sleep(20);
  const bubble = d.querySelector(".msg-assistant");
  check(bubble && /w0/.test(bubble.textContent) && bubble.querySelector("strong"), "partial reply stays, still formatted");
  check(/Stopped/.test(bubble.querySelector(".msg-stopped")?.textContent || ""), "shows ■ Stopped");
  check(btn.textContent === "Send" && btn.classList.contains("btn-primary"), "button back to Send");
  check(w.__hist().length === 2 && w.__hist()[1].role === "assistant", "partial reply kept in the conversation");
  // 2. Stop with Esc before anything arrives
  w = setup(true); d = w.document; btn = d.getElementById("chatSendBtn");
  const inp = d.getElementById("chatInput"); inp.value = "wrong question";
  const p2 = w.sendChat(); await sleep(50);
  inp.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await p2; await sleep(20);
  check(!d.querySelector(".msg-assistant") && /Stopped/.test(d.getElementById("chatMessages").textContent), "Esc stops; no empty bubble left");
  check(w.__hist().length === 0, "wrong question dropped from the conversation");
  check(!d.querySelector(".msg-thinking:not(:last-child)") && !/thinking…/.test(d.getElementById("chatMessages").textContent), "no 'thinking…' left behind");
  // 3. Can ask again afterwards
  inp.value = "next"; const p3 = w.sendChat(); await sleep(100);
  check(btn.textContent === "■ Stop", "new question works after stopping");
  btn.click(); await p3;
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
