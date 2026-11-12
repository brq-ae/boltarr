// Boltarr — "Explain" on outages (AI Tier 3, v0.25.0): each outage line in the service
// and host panels gets an Explain link. Boltarr gathers the facts with simple rules;
// the AI (when set up) words a likely cause. Explanations are saved, so reopening one
// is instant; "Explain again" (optionally with another model) makes a fresh one.
// Saving follows Settings → AI → AI history (off: nothing saved, reopening asks again).
// Part of the app split (F-08); files share globals and load in order (see index.html).

// The outage list for a service or host panel, with an Explain link per outage
function outageListHtml(kind, id, outages) {
  if (!outages || !outages.length)
    return `<span style="font-size:10px;color:var(--text-3)">No outages recorded yet.</span>`;
  return `<div class="outage-list">${outages.map((o, i) => {
    const start = new Date(o.start).toLocaleString();
    const line = o.end
      ? `<span class="outage-item">▾ ${start} — down ${_fmtDur(o.seconds)}</span>`
      : `<span class="outage-item ongoing">▾ ${start} — down now (${_fmtDur(o.seconds)})</span>`;
    const box = _explainBoxId(kind, id, i);
    return `<div class="outage-row">${line}<button class="link-btn outage-explain" data-click="toggleExplain"
        data-args="${dargs(kind, id, o.start, i)}" title="What likely caused this outage">Explain</button></div>
      <div class="explain-box" id="${box}" hidden></div>`;
  }).join("")}</div>`;
}

function _explainBoxId(kind, id, i) { return `explain-${kind}-${id}-${i}`; }

async function toggleExplain(kind, id, start, i) {
  const box = document.getElementById(_explainBoxId(kind, id, i));
  if (!box) return;
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<div class="text-3">Loading…</div>`;
  try {
    const { explanation, earlier } = await api("GET",
      `/api/explain?kind=${encodeURIComponent(kind)}&id=${id}&start=${encodeURIComponent(start)}`);
    if (explanation) _renderExplain(box, kind, id, start, i, explanation, earlier);
    else runExplain(kind, id, start, i);
  } catch (e) {
    box.innerHTML = `<div class="explain-note">Couldn't load: ${escHtml(e.message)}</div>`;
  }
}

async function runExplain(kind, id, start, i) {
  const box = document.getElementById(_explainBoxId(kind, id, i));
  if (!box) return;
  const sel = box.querySelector(".explain-model");
  const model = sel ? sel.value : "";
  box.hidden = false;
  box.innerHTML = `<div class="text-3">Looking at what happened around then… the AI can take up to a minute.</div>`;
  try {
    const { explanation, earlier } = await api("POST", "/api/explain", { kind, id, start, model });
    _renderExplain(box, kind, id, start, i, explanation, earlier);
  } catch (e) {
    box.innerHTML = `<div class="explain-note">Explain failed: ${escHtml(e.message)}</div>`;
  }
}

function _renderExplain(box, kind, id, start, i, x, earlier) {
  const cause = x.summary
    ? `<div class="explain-head">🤖 Likely cause <span class="text-3">(AI — check it against the facts below)</span></div>
       <div class="explain-text">${escHtml(x.summary)}</div>`
    : `<div class="explain-note">${escHtml(x.ai_error || "No AI answer.")}</div>`;
  const facts = `<div class="explain-head">What Boltarr found</div>
    <ul class="explain-facts">${(x.facts || []).map(f => `<li>${escHtml(f)}</li>`).join("")}</ul>`;
  const models = AI_MODELS.length
    ? `<select class="explain-model" title="Model for Explain again"><option value="">Default model</option>${
        AI_MODELS.map(m => `<option value="${escHtml(m)}"${m === x.model ? " selected" : ""}>${escHtml(m.replace(":latest", ""))}</option>`).join("")}</select>`
    : "";
  const when = x.created_at ? fmtLocal(x.created_at) : "";
  const older = aiEarlierHtml(earlier, e => e.summary
    ? `<div class="explain-text">${escHtml(e.summary)}</div>`
    : `<div class="explain-note">${escHtml(e.ai_error || "No AI answer.")}</div>`);
  box.innerHTML = cause + facts + older + `<div class="explain-foot">
      <span class="text-3">${when ? `Explained ${escHtml(when)}` : ""}${x.model && x.summary ? ` · ${escHtml(x.model.replace(":latest", ""))}` : ""}</span>
      ${models}
      <button class="btn-ghost" data-click="runExplain" data-args="${dargs(kind, id, start, i)}">↻ Explain again</button>
    </div>`;
}

registerActions({ toggleExplain, runExplain });
