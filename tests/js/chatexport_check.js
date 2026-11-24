// Chat: Wide toggle (remembered), Copy all, Download .md, quotes + no-squash tables.
const BOLTARR = require("path").resolve(__dirname, "../..");   // the repo root (tests/js/..)
const { JSDOM } = require("jsdom");
const fs = require("fs");
const html = fs.readFileSync(`${BOLTARR}/frontend/index.html`, "utf8");
const panel = html.slice(html.indexOf('<div class="chat-panel"'), html.indexOf("<!-- Host detail panel"));
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function boot(store) {
  const dom = new JSDOM(`<body>${panel}</body>`, { runScripts: "outside-only", pretendToBeVisual: true, url: "http://x.test/" });
  const w = dom.window;
  if (store) Object.entries(store).forEach(([k, v]) => w.localStorage.setItem(k, v));
  w.TextDecoder = TextDecoder;
  w.fetch = async () => new Response("Here:\n\n> **Note:** quoted <b>x</b>\n\n| OS | Vendor |\n|---|---|\n| Linux 5.0 - 5.14 | Demo Server Co |");
  const clip = {}; w.document.execCommand = () => { clip.text = w.document.querySelector("textarea[readonly]")?.value; return true; };
  const dl = {}; w.URL.createObjectURL = b => { dl.blob = b; return "blob:x"; }; w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { dl.name = this.download; dl.href = this.href; };
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/markdown.js`, "utf8"));
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/export.js`, "utf8"));
  w.eval("var registerActions = () => {}; var api = async () => ({ cards: [] }); var escHtml = s => String(s); var dargs = (...a) => JSON.stringify(a);"); w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/app/ai-actions.js`, "utf8"));  // chat.js uses its chatReplyHtml (v0.26.0)
  w.eval(fs.readFileSync(`${BOLTARR}/frontend/js/chat.js`, "utf8"));
  w.toggleChat = () => w.document.getElementById("chatPanel").classList.toggle("open");
  return { w, d: w.document, clip, dl };
}
(async () => {
  let { w, d, clip, dl } = await boot(); await sleep(50);
  const P = d.getElementById("chatPanel"), wideBtn = d.getElementById("chatWide");
  d.getElementById("chatCopyAll").click(); await sleep(10);
  check(clip.text === undefined, "Copy all with an empty chat copies nothing");
  wideBtn.click();
  check(P.classList.contains("wide") && wideBtn.textContent === "⤡", "⤢ makes the chat wide");
  check(w.localStorage.getItem("boltarr.chatWide") === "1", "wide choice remembered");
  ({ w, d, clip, dl } = await boot({ "boltarr.chatWide": "1" })); await sleep(50);
  check(d.getElementById("chatPanel").classList.contains("wide"), "reopening Boltarr keeps it wide");
  d.getElementById("chatWide").click();
  check(!d.getElementById("chatPanel").classList.contains("wide") && w.localStorage.getItem("boltarr.chatWide") === "", "⤡ back to normal, remembered");

  d.getElementById("chatInput").value = "list my servers";
  await w.sendChat();
  const b = d.querySelector(".msg-assistant.md");
  check(b.querySelector("blockquote strong")?.textContent === "Note:", "> quote renders as a quote");
  check(!b.querySelector("blockquote b") && /&lt;b&gt;/.test(b.innerHTML), "quote content still escaped");
  check(b.querySelector(".md-table td")?.textContent === "Linux 5.0 - 5.14", "table cell intact");

  d.getElementById("chatCopyAll").click(); await sleep(10);
  check(/^# Boltarr chat — /.test(clip.text) && clip.text.includes("**You:** list my servers") && clip.text.includes("**Assistant:**") && clip.text.includes("| Linux 5.0 - 5.14 |"), "Copy all copies the conversation as Markdown");
  check(d.getElementById("chatCopyAll").textContent === "✓", "Copy all shows ✓");
  d.getElementById("chatDownload").click(); await sleep(10);
  check(/^boltarr-chat-\d{4}-\d\d-\d\d-\d{4}\.md$/.test(dl.name || ""), `Download file name (${dl.name})`);
  const text = await new Promise(r => { const fr = new w.FileReader(); fr.onload = () => r(fr.result); fr.readAsText(dl.blob); });
  check(text === clip.text && text.includes("> **Note:** quoted <b>x</b>"), "download has the same Markdown (raw, as the AI wrote it)");
  console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
  process.exit(fail ? 1 : 0);
})();
