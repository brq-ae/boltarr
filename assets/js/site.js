// GitHub's "> [!NOTE]" boxes only render on github.com; show them as a labelled note here
document.querySelectorAll("blockquote > p:first-child").forEach(p => {
  const m = p.innerHTML.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(<br>)?/);
  if (!m) return;
  p.innerHTML = p.innerHTML.slice(m[0].length);
  const label = document.createElement("div");
  label.className = "note-label";
  label.textContent = m[1][0] + m[1].slice(1).toLowerCase();
  p.parentElement.prepend(label);
});
