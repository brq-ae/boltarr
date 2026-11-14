// Chat panel logic

const chatHistory = [];
let chatAbort = null;   // AbortController while a reply is streaming
let chatEpoch = 0;      // bumped by New chat, so a reply that was cut off doesn't land in the new chat

// While a reply streams, Send becomes Stop. Stopping closes the request; the
// server then drops its connection to the AI, which stops generating.
function setChatBusy(busy) {
  const btn = document.getElementById("chatSendBtn");
  if (!btn) return;
  btn.textContent = busy ? "■ Stop" : "Send";
  btn.classList.toggle("btn-primary", !busy);
  btn.classList.toggle("btn-danger", busy);
  btn.title = busy ? "Stop the reply (Esc)" : "";
}

function stopChat() {
  if (chatAbort) chatAbort.abort();
}

// ── Wide mode + export ──────────────────────────────────────────────────────
function setChatWide(wide) {
  document.getElementById("chatPanel").classList.toggle("wide", wide);
  const b = document.getElementById("chatWide");
  if (b) { b.textContent = wide ? "⤡" : "⤢"; b.title = wide ? "Narrower chat" : "Wider chat"; }
  try { localStorage.setItem("boltarr.chatWide", wide ? "1" : ""); } catch (e) {}
}

function chatAsMarkdown() {
  const when = new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  return `# Boltarr chat — ${when}\n\n` + chatHistory.map(m =>
    m.role === "user" ? `**You:** ${m.content}` : `**Assistant:**\n\n${m.content}`).join("\n\n---\n\n") + "\n";
}

function flashBtn(btn, text) {
  const old = btn.dataset.label || (btn.dataset.label = btn.textContent);
  btn.textContent = text;
  clearTimeout(btn._t); btn._t = setTimeout(() => { btn.textContent = old; }, 1400);
}

function chatCopyAll() {
  const b = document.getElementById("chatCopyAll");
  if (!chatHistory.length) return flashBtn(b, "–");
  copyText(chatAsMarkdown()).then(() => flashBtn(b, "✓"), () => flashBtn(b, "✕"));
}

function chatDownload() {
  const b = document.getElementById("chatDownload");
  if (!chatHistory.length) return flashBtn(b, "–");
  const d = new Date(), pad = n => String(n).padStart(2, "0");
  downloadFile(`boltarr-chat-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.md`,
               chatAsMarkdown(), "text/markdown");
  flashBtn(b, "✓");
}

// New chat: the first click arms the button ("Clear?") for a few seconds, the
// second clears the screen and what the AI is sent, so nothing is wiped by accident.
const CHAT_GREETING = "Hi. I have full context on your network. Ask me about devices, services, topology, or security posture.";

function chatNew() {
  const b = document.getElementById("chatNew");
  if (!chatHistory.length && !chatAbort) return flashBtn(b, "–");
  if (!b.classList.contains("armed")) {
    b.classList.add("armed");
    b.textContent = "Clear?";
    clearTimeout(b._t);
    b._t = setTimeout(() => { b.classList.remove("armed"); b.textContent = "＋"; }, 3000);
    return;
  }
  clearTimeout(b._t);
  b.classList.remove("armed");
  b.textContent = "＋";
  chatEpoch++;
  stopChat();
  chatHistory.length = 0;
  const msgs = document.getElementById("chatMessages");
  msgs.innerHTML = "";
  appendMsg("assistant", CHAT_GREETING);
  document.getElementById("chatInput").focus();
}

function toggleChat() {
  document.getElementById("chatPanel").classList.toggle("open");
}

function appendMsg(role, content) {
  const msgs = document.getElementById("chatMessages");
  const div = document.createElement("div");
  div.className = `msg msg-${role}`;
  div.textContent = content;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function removeThinking() {
  document.querySelectorAll(".msg-thinking").forEach((el) => el.remove());
}

async function sendChat() {
  if (chatAbort) return;   // one reply at a time
  const input = document.getElementById("chatInput");
  const text = input.value.trim();
  if (!text) return;

  const model = document.getElementById("chatModel").value;
  input.value = "";

  chatHistory.push({ role: "user", content: text });
  appendMsg("user", text);

  const thinking = appendMsg("thinking", "thinking…");
  const epoch = chatEpoch;
  chatAbort = new AbortController();
  setChatBusy(true);
  let div = null, full = "";

  try {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: chatHistory, model }),
      signal: chatAbort.signal,
    });
    if (!res.ok) {
      thinking.remove();
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch {}
      appendMsg("assistant", `Error: ${detail}`);
      chatHistory.pop();
      return;
    }
    // Stream tokens into a single assistant bubble as they arrive.
    thinking.remove();
    const msgs = document.getElementById("chatMessages");
    div = appendMsg("assistant", "");
    div.classList.add("md");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      full += decoder.decode(value, { stream: true });
      div.innerHTML = chatReplyHtml(full);    // markdown (escapes first) + action slots, see app/ai-actions.js
      msgs.scrollTop = msgs.scrollHeight;
    }
    if (!full) div.textContent = "(no response)";
    chatHistory.push({ role: "assistant", content: full });
    attachActionCards(div, full, chatHistory.length - 1);
  } catch (e) {
    thinking.remove();
    if (epoch !== chatEpoch) return;       // New chat was clicked: drop this reply
    if (e.name === "AbortError") {
      if (full) {
        // Keep what was written so far, so the conversation still makes sense.
        chatHistory.push({ role: "assistant", content: full });
        attachActionCards(div, full, chatHistory.length - 1);
        div.insertAdjacentHTML("beforeend", '<div class="msg-stopped">■ Stopped</div>');
      } else {
        // Nothing came back yet: forget the question, as if it was never asked.
        chatHistory.pop();
        if (div) div.remove();
        appendMsg("thinking", "Stopped.");
      }
    } else {
      appendMsg("assistant", "Error: " + e.message);
    }
  } finally {
    chatAbort = null;
    setChatBusy(false);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    } else if (e.key === "Escape" && chatAbort) {
      e.preventDefault();
      stopChat();
    }
  });
  document.getElementById("chatSendBtn")?.addEventListener("click", () => chatAbort ? stopChat() : sendChat());
  document.getElementById("chatNew")?.addEventListener("click", chatNew);
  document.getElementById("chatCopyAll")?.addEventListener("click", chatCopyAll);
  document.getElementById("chatDownload")?.addEventListener("click", chatDownload);
  document.getElementById("chatWide")?.addEventListener("click", () =>
    setChatWide(!document.getElementById("chatPanel").classList.contains("wide")));
  let wide = false;
  try { wide = localStorage.getItem("boltarr.chatWide") === "1"; } catch (e) {}
  if (wide) setChatWide(true);
});
