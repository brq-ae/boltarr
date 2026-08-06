// Chat panel logic

const chatHistory = [];

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
  const input = document.getElementById("chatInput");
  const text = input.value.trim();
  if (!text) return;

  const model = document.getElementById("chatModel").value;
  input.value = "";

  chatHistory.push({ role: "user", content: text });
  appendMsg("user", text);

  const thinking = appendMsg("thinking", "thinking…");

  try {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: chatHistory, model }),
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
    const div = appendMsg("assistant", "");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      full += decoder.decode(value, { stream: true });
      div.textContent = full;
      msgs.scrollTop = msgs.scrollHeight;
    }
    if (!full) div.textContent = "(no response)";
    chatHistory.push({ role: "assistant", content: full });
  } catch (e) {
    thinking.remove();
    appendMsg("assistant", "Error: " + e.message);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });
});
