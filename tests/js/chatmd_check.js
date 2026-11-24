// R-05: chat bubble formats a streamed reply; Copy button copies the code.  node chatmd_check.js
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM } = require("jsdom");
const fs = require("fs");
const dom = new JSDOM(`<body><div id="chatPanel"><div id="chatMessages"></div><select id="chatModel"><option>m</option></select><textarea id="chatInput"></textarea></div></body>`,
  { runScripts: "outside-only", pretendToBeVisual: true });
const w = dom.window, d = w.document;
const reply = "Here's what I found:\n\n- **3 hosts** offline\n- port `22` open\n\n```\nssh root@10.0.0.5\n```\n| Host | State |\n|---|---|\n| nas | up |";
const chunks = reply.match(/.{1,7}/gs);
let seenPartial = false;
w.fetch = async () => new Response(new ReadableStream({ async pull(c) {
  const n = chunks.shift();
  if (n === undefined) return c.close();
  c.enqueue(new TextEncoder().encode(n));
  await new Promise(r => setTimeout(r, 2));
  if (d.querySelector(".msg-assistant pre")) seenPartial = true;
} }), { status: 200 });
w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
let copied = null;
w.document.execCommand = cmd => { copied = d.querySelector("textarea[readonly]")?.value; return cmd === "copy"; };
w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/markdown.js`, "utf8"));
w.eval("var registerActions = () => {}; var api = async () => ({ cards: [] }); var escHtml = s => String(s); var dargs = (...a) => JSON.stringify(a);"); w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/app/ai-actions.js`, "utf8"));  // chat.js uses its chatReplyHtml (v0.26.0)
w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/chat.js`, "utf8"));
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
(async () => {
  d.getElementById("chatInput").value = "what's down?";
  await w.sendChat();
  const b = d.querySelector(".msg-assistant.md");
  check(!!b, "assistant bubble is formatted");
  check(b.querySelector("li strong")?.textContent === "3 hosts", "bold inside list");
  check(b.querySelector("table td")?.textContent === "nas", "table rendered");
  check(seenPartial, "formatting appears while still streaming");
  check(d.querySelector(".msg-user").innerHTML === "what's down?", "your own message stays plain text");
  b.querySelector("[data-md-copy]").click(); await new Promise(r => setTimeout(r, 20));
  check(copied === "ssh root@10.0.0.5", `Copy puts the code on the clipboard (${copied})`);
  check(b.querySelector("[data-md-copy]").textContent === "Copied ✓", "button says Copied ✓");
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
