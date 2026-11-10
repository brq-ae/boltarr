// Formatting for AI replies (chat, Analyze, Analyze Network).
//
// Safe by construction: the whole reply is HTML-escaped first, then a small set
// of Markdown patterns is turned into a fixed set of tags (strong, em, code, pre,
// ul/ol/li, h4, table, hr, p, br). Nothing from the reply ever becomes an
// attribute, so it can't add links, images, scripts or event handlers. Links are
// shown as plain text ("label (url)"), never clickable: the AI reads text from
// the network (hostnames, banners) and could repeat a planted link.
//
// Works on half-finished text too, so replies can be re-rendered as they stream
// (an unclosed ``` block shows as code until it closes).

(function () {
  const escMd = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
                      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  function inline(s) {
    // s is already escaped. Pull code spans out first so nothing inside them is formatted.
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, t, u) => t === u ? u : `${t} (${u})`);
    // Bold tolerates a stray space after the opening ** ("** Note:**"), which some models write.
    s = s.replace(/\*\*\s?(?=[^\s*])([^*\n]*?\S)\*\*/g, "<strong>$1</strong>")
         .replace(/__(?=\S)([^_\n]*?\S)__/g, "<strong>$1</strong>")
         .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, "$1<em>$2</em>")
         .replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, "$1<em>$2</em>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  }

  const isTableSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(l);
  const cells = l => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => inline(c.trim()));

  function blocks(text) {
    const lines = text.split("\n"), out = [];
    let para = [], list = null;
    const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null; } };
    const flush = () => { flushPara(); flushList(); };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      let m;
      if (!l.trim()) { flush(); continue; }
      if (l.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flush();
        const head = cells(l), rows = [];
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
        i--;
        out.push(`<div class="md-table"><table><thead><tr>${head.map(c => `<th>${c}</th>`).join("")}</tr></thead>` +
                 `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }
      if ((m = l.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/))) { flush(); out.push(`<h4>${inline(m[1])}</h4>`); continue; }
      if (/^\s{0,3}&gt;\s?/.test(l)) {          // "> quote" (the ">" is already escaped)
        flush();
        const q = [];
        while (i < lines.length && /^\s{0,3}&gt;\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s{0,3}&gt;\s?/, ""));
        i--;
        out.push(`<blockquote>${blocks(q.join("\n"))}</blockquote>`);
        continue;
      }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out.push("<hr>"); continue; }
      const ul = l.match(/^\s*[-*+]\s+(.*)$/), ol = l.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        const tag = ul ? "ul" : "ol";
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        list.items.push((ul || ol)[1]);
        continue;
      }
      if (list && /^\s{2,}\S/.test(l)) { list.items[list.items.length - 1] += " " + l.trim(); continue; }
      flushList();
      para.push(l);
    }
    flush();
    return out.join("");
  }

  window.renderMarkdown = function (text) {
    const src = escMd(String(text ?? "").replace(/\u0000/g, "").replace(/\r\n?/g, "\n"));
    const parts = [];
    const re = /```[^\n`]*\n?([\s\S]*?)(?:```|$)/g;
    let last = 0, m;
    while ((m = re.exec(src))) {
      parts.push(blocks(src.slice(last, m.index)));
      parts.push(`<div class="md-code"><button type="button" class="md-copy" data-md-copy>Copy</button>` +
                 `<pre><code>${m[1].replace(/\n$/, "")}</code></pre></div>`);
      last = re.lastIndex;
      if (m[0].length === 0) break;
    }
    parts.push(blocks(src.slice(last)));
    return parts.join("");
  };

  // Copy buttons on code blocks. navigator.clipboard only exists on HTTPS or
  // localhost, so plain-HTTP LAN installs fall back to a hidden textarea.
  function copyText(t) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t);
    const ta = document.createElement("textarea");
    ta.value = t; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    ta.remove();
    return ok ? Promise.resolve() : Promise.reject(new Error("copy failed"));
  }
  window.copyText = copyText;
  document.addEventListener("click", e => {
    const btn = e.target.closest("[data-md-copy]");
    if (!btn) return;
    const code = btn.parentElement.querySelector("pre")?.textContent ?? "";
    copyText(code).then(() => { btn.textContent = "Copied ✓"; },
                        () => { btn.textContent = "Couldn't copy"; })
      .finally(() => setTimeout(() => { btn.textContent = "Copy"; }, 1500));
  });
})();
