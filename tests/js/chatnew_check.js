// New chat button (v0.26.1): first click arms "Clear?", second clears screen + history; a reply cut off by it doesn't come back.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM } = require("jsdom");
const fs = require("fs");
function setup() {
  const dom = new JSDOM(`<body><div id="chatPanel"><button id="chatNew" class="chat-hbtn">＋</button><div id="chatMessages"><div class="msg msg-assistant">Hi.</div></div><select id="chatModel"><option>m</option></select>
    <input id="chatInput"><button id="chatSendBtn" class="btn btn-primary">Send</button></div></body>`, { runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.TextDecoder = TextDecoder;
  w.fetch = (u, o) => new Promise((resolve, reject) => {
    o.signal.addEventListener("abort", () => reject(new w.DOMException("aborted", "AbortError")));
    let i = 0;
    resolve(new Response(new ReadableStream({ async pull(c) {
      if (o.signal.aborted) return c.error(new w.DOMException("aborted", "AbortError"));
      if (i > 2 && !w.__slow) return c.close();
      c.enqueue(new TextEncoder().encode(`w${i++} `)); await new Promise(r => setTimeout(r, 30)); } })));
  });
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/markdown.js`, "utf8"));
  w.eval("var registerActions = () => {}; var api = async () => ({ cards: [] }); var escHtml = s => String(s); var dargs = (...a) => JSON.stringify(a);");
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/app/ai-actions.js`, "utf8"));
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/chat.js`, "utf8") + "\n;window.__hist = () => chatHistory;");
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  return w;
}
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let w = setup(), d = w.document, nb = d.getElementById("chatNew"), msgs = d.getElementById("chatMessages");
  nb.click();
  check(nb.textContent === "–" && !nb.classList.contains("armed"), "empty chat: nothing to clear");
  await sleep(1500);
  d.getElementById("chatInput").value = "q1"; await w.sendChat();
  check(w.__hist().length === 2, "one exchange in the conversation");
  nb.click();
  check(nb.textContent === "Clear?" && nb.classList.contains("armed") && w.__hist().length === 2, "first click only asks Clear?");
  await sleep(3200);
  check(nb.textContent === "＋" && !nb.classList.contains("armed") && w.__hist().length === 2, "un-arms after 3 s, nothing cleared");
  nb.click(); nb.click();
  check(w.__hist().length === 0, "second click clears what the AI is sent");
  check(msgs.querySelectorAll(".msg").length === 1 && /full context/.test(msgs.textContent), "screen back to the greeting");
  check(nb.textContent === "＋" && !nb.classList.contains("armed"), "button back to ＋");
  // Clear while a reply streams
  w.__slow = true;
  d.getElementById("chatInput").value = "q2"; const p = w.sendChat(); await sleep(120);
  nb.click(); nb.click(); await p; await sleep(50);
  check(w.__hist().length === 0, "cut-off reply not added to the new chat");
  check(msgs.querySelectorAll(".msg").length === 1 && !/Stopped|w0/.test(msgs.textContent), "nothing from the old reply on screen");
  check(d.getElementById("chatSendBtn").textContent === "Send", "Send button back");
  d.getElementById("chatInput").value = "q3"; w.__slow = false;
  await w.sendChat();
  check(w.__hist().length === 2 && w.__hist()[0].content === "q3", "new chat works afterwards");
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
