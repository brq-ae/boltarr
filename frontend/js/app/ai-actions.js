// Boltarr — AI actions in the chat (AI Tier 4, v0.26.0). The AI suggests an action
// by writing a line like [[action {"do":"set_note",…}]] in its reply. Here each such
// line becomes a card: the server checks the suggestion (/api/ai-actions/check) and
// says what it would do; "open" cards show something on screen with one click,
// "change" cards need Do it, and the server checks again before doing it.
// chat.js (loaded earlier) calls chatReplyHtml / attachActionCards at run time.
// Part of the app split (F-08); files share globals and load in order (see index.html).

// The forms the AI writes a suggestion in. Taught: [[action {...}]]. Also read, since
// models slip: [[set_host {...}]] (any word; the server uses it when "do" is missing),
// and JSON with a "do" in a code block or alone on a line. The server checks each one.
const AI_MARKER_RE = /\[\[\s*([A-Za-z_]+)?\s*(\{[\s\S]*?\})\s*\]\]/g;
const AI_FENCE_RE  = /```[A-Za-z]*[ \t]*\n?\s*(\{[\s\S]*?\})\s*```/g;
const AI_LINE_RE   = /^[ \t]*(\{[^\n]*\})[ \t]*$/gm;
const AI_HAS_DO    = /["']do["']\s*:/;
// Left over after that but still looks like a try ("[[action" with no end, "[[set_note {" …)
const AI_TRIED_RE  = /\[\[\s*[A-Za-z_]*\s*\{|\[\[\s*action\b/i;
const AI_CARDS = {};          // card id → { card, msgIndex }
let aiCardSeq = 0;

// The reply with each suggestion replaced by ⟦AIACTION n⟧, the suggestions (as text
// for the server) and whether something that looked like a suggestion couldn't be read.
function _aiExtract(text) {
  const raws = [];
  const slot = raw => { raws.push(raw); return `\n\n⟦AIACTION${raws.length - 1}⟧\n\n`; };
  let t = text.replace(AI_MARKER_RE, (m, word, json) =>
    slot(word && word.toLowerCase() !== "action" ? `${word} ${json}` : json));
  t = t.replace(/```[A-Za-z]*\s*(⟦AIACTION\d+⟧)\s*```/g, "$1");           // a marker inside a code block
  t = t.replace(AI_FENCE_RE, (m, json) => AI_HAS_DO.test(json) ? slot(json) : m);
  t = t.replace(AI_LINE_RE, (m, json) => AI_HAS_DO.test(json) ? slot(json) : m);
  return { marked: t, raws, tried: AI_TRIED_RE.test(t) };
}

// The reply as HTML, with each suggestion replaced by an empty slot for its card.
// While streaming, a line still being typed ("[[action {…") is hidden until it's complete.
function chatReplyHtml(text, done = false) {
  const { marked, raws } = _aiExtract(text);
  let html = renderMarkdown(done ? marked : marked.replace(/\[\[[^\]]*$/, ""));
  raws.forEach((_, i) => {
    const slot = `<div class="ai-action-slot" data-slot="${i}"><div class="ai-action ai-action-wait">Suggested action…</div></div>`;
    html = html.includes(`<p>⟦AIACTION${i}⟧</p>`)
      ? html.replace(`<p>⟦AIACTION${i}⟧</p>`, slot)
      : html.replace(`⟦AIACTION${i}⟧`, slot);
  });
  return html;
}

const _AI_TRIED_HTML = `<div class="ai-action ai-action-bad">⚠ The AI tried to suggest an action but wrote it in a way Boltarr can't read — ask again.</div>`;

// Once the reply is complete: ask the server about each suggestion and fill the slots.
async function attachActionCards(div, text, msgIndex) {
  const { raws, tried } = _aiExtract(text);
  if (tried) {           // show the reply in full (nothing hidden as "still being typed") + the note
    div.innerHTML = chatReplyHtml(text, true);
    div.insertAdjacentHTML("beforeend", _AI_TRIED_HTML);
  }
  if (!raws.length) return;
  let cards;
  try {
    ({ cards } = await api("POST", "/api/ai-actions/check", { actions: raws }));
  } catch (e) {
    cards = raws.map(() => ({ ok: false, error: "Boltarr couldn't check this suggestion: " + e.message }));
  }
  div.querySelectorAll(".ai-action-slot").forEach(slot => {
    const card = cards[+slot.dataset.slot];
    slot.innerHTML = card ? _aiCardHtml(card, msgIndex) : "";
  });
}

const _AI_ICONS = { open_host: "🖥", open_service: "⚙", explain: "🔍", set_note: "✎", set_host: "✎",
                    scan: "📡", probe: "🔎", pause_monitor: "⏸", resume_monitor: "▶" };

function _aiCardHtml(card, msgIndex) {
  if (!card.ok)
    return `<div class="ai-action ai-action-bad">⚠ Suggested action not possible: ${escHtml(card.error)}</div>`;
  const id = ++aiCardSeq;
  AI_CARDS[id] = { card, msgIndex };
  const detail = (card.detail || []).map(([k, v]) =>
    `<div class="ai-action-row"><span class="text-3">${escHtml(k)}</span><span>${escHtml(v)}</span></div>`).join("");
  const btns = card.kind === "open"
    ? `<button class="btn" data-click="aiActionDo" data-args="${dargs(id)}">Open</button>`
    : `<button class="btn btn-primary" data-click="aiActionDo" data-args="${dargs(id)}">Do it</button>
       <button class="btn" data-click="aiActionCancel" data-args="${dargs(id)}">Cancel</button>`;
  return `<div class="ai-action" id="aiCard-${id}">
      <div class="ai-action-title">${_AI_ICONS[card.action.do] || "▶"} ${escHtml(card.title)}</div>
      ${detail}
      <div class="ai-action-btns">${btns}<span class="ai-action-status text-3"></span></div>
    </div>`;
}

function _aiCardStatus(id, text, cls = "", done = false) {
  const el = document.getElementById(`aiCard-${id}`);
  if (!el) return;
  const st = el.querySelector(".ai-action-status");
  st.textContent = text;
  st.className = `ai-action-status ${cls || "text-3"}`;
  if (done) el.querySelectorAll(".ai-action-btns button").forEach(b => b.remove());
}

// Tell the AI what happened, so the rest of the conversation makes sense
function _aiNoteResult(msgIndex, text) {
  const m = chatHistory[msgIndex];
  if (m) m.content += `\n\n[Result: ${text}]`;
}

async function aiActionDo(id) {
  const entry = AI_CARDS[id];
  if (!entry) return;
  const { card, msgIndex } = entry;
  if (card.kind === "open") {
    await aiOpenTarget(card.target);
    _aiCardStatus(id, "Opened");
    return;
  }
  _aiCardStatus(id, "Working…");
  try {
    const r = await api("POST", "/api/ai-actions/run", _aiRecordBody(card, msgIndex));
    if (r.ok) {
      _aiCardStatus(id, "✓ " + r.message, "ai-action-ok", true);
      _aiNoteResult(msgIndex, `the user clicked Do it. ${r.message}`);
      if (card.then?.type === "scans") _aiAddOpenScans(id);
      await _aiAfterChange(card.action.do, r);
    } else {
      _aiCardStatus(id, "✕ " + r.error, "ai-action-fail", true);
      _aiNoteResult(msgIndex, `the user clicked Do it, but it failed: ${r.error}`);
    }
  } catch (e) {
    _aiCardStatus(id, "✕ " + e.message, "ai-action-fail");
  }
}

// Bring the screen up to date after a change, the same way the normal buttons do
async function _aiAfterChange(kind, r) {
  if (kind === "scan") {
    activeRunId = r.run_id; activeScanSubnet = r.subnet_id;
    renderSubnetList();            // the subnet's Scan turns into Stop
    startPolling(r.subnet_id);     // progress bar; reloads hosts when done
    loadScans();
  } else if (kind === "probe") {
    activeRunId = r.run_id;
    startProbePolling(r.run_id, r.ip);
    loadScans();
  } else if (kind === "pause_monitor" || kind === "resume_monitor") {
    await loadServicesData(); renderServicesTable();
    if (svcDetailId === r.service_id && document.getElementById("svcDetailPanel").classList.contains("open"))
      showSvcDetail(r.service_id);
  } else {
    await loadHosts(); renderHostsTable(); loadGraph();
  }
}

function _aiAddOpenScans(id) {
  const btns = document.querySelector(`#aiCard-${id} .ai-action-btns`);
  if (btns) btns.insertAdjacentHTML("afterbegin", `<button class="btn" data-click="aiOpenScans">Open Scans</button>`);
}

function aiOpenScans() { setTab("scans"); setScanTab("history"); }

function aiActionCancel(id) {
  const entry = AI_CARDS[id];
  if (!entry) return;
  _aiCardStatus(id, "Cancelled — nothing was changed.", "", true);
  _aiNoteResult(entry.msgIndex, `the user cancelled "${entry.card.title}".`);
  api("POST", "/api/ai-actions/cancel", _aiRecordBody(entry.card, entry.msgIndex)).catch(() => {});   // only recorded
}

// For the AI actions record (Settings → AI): the model and what the user asked
function _aiRecordBody(card, msgIndex) {
  const asked = chatHistory[msgIndex - 1];
  return { action: card.action, model: document.getElementById("chatModel")?.value || "",
           asked: asked && asked.role === "user" ? asked.content : "" };
}

// Show a host or service panel; with explain, open its latest outage's explanation
let aiAutoExplain = null;
async function aiOpenTarget(t) {
  aiAutoExplain = t.explain ? t.type : null;
  if (t.type === "host") {
    if (t.explain) activeDetailTab = "info";      // uptime + outages live on the Info tab
    await showHostDetail(t.ip);
  } else {
    if (!allServices.some(s => s.id === t.id)) await loadServicesData();
    showSvcDetail(t.id);
  }
}

// Called by the uptime loaders once the outage list is on screen
function maybeAutoExplain(kind, el) {
  if (aiAutoExplain !== kind) return;
  aiAutoExplain = null;
  const btn = el.querySelector(".outage-explain");
  if (btn) { btn.click(); btn.scrollIntoView({ block: "center", behavior: "smooth" }); }
}

registerActions({ aiActionDo, aiActionCancel, aiOpenScans });
