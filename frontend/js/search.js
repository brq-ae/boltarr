// Global search (S-04): the top-bar box. Finds hosts (IP, alias IPs, hostname,
// MAC, vendor, type, OS, notes, open-port services) and services (name,
// description, port, URL, host) in the data already loaded, and opens the match.
// "+N more" opens that tab filtered by the same text (same matching rules).
// Shortcuts: "/" (not while typing in a field) and Ctrl/⌘+K.

(function () {
  const PER_GROUP = 8;
  let items = [], active = -1, lastQ = "";

  const $ = id => document.getElementById(id);
  const isPhone = () => window.matchMedia("(max-width: 799px)").matches;
  const ipNum = ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip || "") ? ip.split(".").reduce((a, o) => a * 256 + (+o), 0) : Infinity;

  // Show where the text matched, with the matching part bold.
  function mark(text, q) {
    const t = String(text ?? ""), i = t.toLowerCase().indexOf(q);
    if (i < 0 || !q) return escHtml(t);
    return escHtml(t.slice(0, i)) + "<b>" + escHtml(t.slice(i, i + q.length)) + "</b>" + escHtml(t.slice(i + q.length));
  }

  // Lower = better: exact IP / name, then starts-with, then anywhere.
  function hostRank(h, q) {
    const ip = (h.ip || "").toLowerCase(), name = (h.hostname || "").toLowerCase();
    if (ip === q || name === q || (h.aliases || []).includes(q)) return 0;
    if (ip.startsWith(q) || name.startsWith(q)) return 1;
    if (ip.includes(q) || name.includes(q)) return 2;
    return 3;
  }
  function svcRank(s, q) {
    const n = (s.name || "").toLowerCase();
    if (n === q || String(s.port || "") === q) return 0;
    if (n.startsWith(q)) return 1;
    return n.includes(q) ? 2 : 3;
  }

  // The field that matched, shown under the name ("MAC aa:bb…", "alias 10.0.0.5").
  function hostWhy(h, q) {
    const alias = (h.aliases || []).find(a => a.includes(q));
    if (alias && !(h.ip || "").includes(q)) return `alias ${mark(alias, q)}`;
    for (const [k, label] of [["mac", "MAC"], ["vendor", ""], ["device_type", ""], ["os_guess", "OS"], ["notes", "note"]]) {
      if ((h[k] || "").toLowerCase().includes(q)) return (label ? label + " " : "") + mark(h[k], q);
    }
    const p = (h.ports || []).find(p => p.state === "open" && (p.service || "").toLowerCase().includes(q));
    if (p) return `port ${escHtml(p.port)} ${mark(p.service, q)}`;
    if (h.mac && typeof _hexOnly === "function" && _hexOnly(h.mac).includes(_hexOnly(q))) return `MAC ${escHtml(h.mac)}`;
    return [h.vendor, h.device_type].filter(Boolean).map(escHtml).join(" · ");
  }

  function results(q) {
    const hosts = allHosts.filter(h => hostMatches(h, q))
      .sort((a, b) => hostRank(a, q) - hostRank(b, q) || ipNum(a.ip) - ipNum(b.ip) || (a.hostname || "").localeCompare(b.hostname || ""));
    const svcs = allServices.filter(s => svcMatches(s, q))
      .sort((a, b) => svcRank(a, q) - svcRank(b, q) || (a.name || "").localeCompare(b.name || ""));
    return { hosts, svcs };
  }

  function render() {
    const box = $("gsResults"), raw = $("gsInput").value.trim(), q = raw.toLowerCase();
    lastQ = raw;
    items = []; active = -1;
    if (!q) { box.hidden = true; box.innerHTML = ""; $("gsInput").setAttribute("aria-expanded", "false"); return; }
    const { hosts, svcs } = results(q);
    let html = "";
    if (hosts.length) {
      html += `<div class="gs-group">Hosts <span>${hosts.length}</span></div>`;
      hosts.slice(0, PER_GROUP).forEach(h => {
        const synthetic = String(h.ip).startsWith("node-");
        const title = synthetic ? `${mark(h.hostname || "(no IP)", q)} <span class="gs-dim">no IP</span>`
          : `<span class="mono">${mark(h.ip, q)}</span>${h.hostname ? ` · ${mark(h.hostname, q)}` : ""}`;
        items.push({ kind: "host", ip: h.ip });
        html += `<div class="gs-item" role="option" data-i="${items.length - 1}">${synthetic ? "" : livenessDot(h.online)}
          <div class="gs-text"><div class="gs-title">${title}</div><div class="gs-why">${hostWhy(h, q)}</div></div></div>`;
      });
      if (hosts.length > PER_GROUP) {
        items.push({ kind: "more-hosts" });
        html += `<div class="gs-item gs-more" role="option" data-i="${items.length - 1}">+${hosts.length - PER_GROUP} more hosts — show all in Hosts</div>`;
      }
    }
    if (svcs.length) {
      html += `<div class="gs-group">Services <span>${svcs.length}</span></div>`;
      svcs.slice(0, PER_GROUP).forEach(s => {
        items.push({ kind: "svc", id: s.id });
        const where = `${mark(s.ip, q)}${s.port ? ":" + mark(String(s.port), q) : ""}${s.hostname ? " · " + mark(s.hostname, q) : ""}`;
        html += `<div class="gs-item" role="option" data-i="${items.length - 1}">${svcIconHTML(s.name, 18)}
          <div class="gs-text"><div class="gs-title">${mark(s.name, q)}</div><div class="gs-why mono">${where}</div></div></div>`;
      });
      if (svcs.length > PER_GROUP) {
        items.push({ kind: "more-svcs" });
        html += `<div class="gs-item gs-more" role="option" data-i="${items.length - 1}">+${svcs.length - PER_GROUP} more services — show all in Services</div>`;
      }
    }
    box.innerHTML = html || `<div class="gs-empty">No host or service matches “${escHtml(raw)}”.</div>`;
    box.hidden = false;
    $("gsInput").setAttribute("aria-expanded", "true");
    if (items.length) setActive(0);
  }

  function setActive(i) {
    const els = $("gsResults").querySelectorAll(".gs-item");
    els.forEach(e => e.classList.remove("active"));
    active = i;
    const el = els[i];
    if (el) { el.classList.add("active"); el.scrollIntoView({ block: "nearest" }); }
  }

  function close(clear) {
    $("gsResults").hidden = true;
    $("gsInput").setAttribute("aria-expanded", "false");
    if (clear) $("gsInput").value = "";
    document.querySelector(".gsearch").classList.remove("open");
    $("gsInput").blur();
  }

  function pick(i) {
    const it = items[i];
    if (!it) return;
    const q = lastQ;
    close(true);
    if (it.kind === "host") showHostDetail(it.ip);
    else if (it.kind === "svc") showSvcDetail(it.id);
    else if (it.kind === "more-hosts") {
      setTab("hosts"); setHostsTab("list");
      $("classFilter").value = ""; classFilterVal = "";
      $("tableFilter").value = q; filterText = q;
      renderHostsTable();
    } else if (it.kind === "more-svcs") {
      setTab("services"); setSvcTab("list");
      $("svcHostFilter").value = ""; svcHostFilterVal = "";
      $("serviceFilter").value = q; svcFilterText = q;
      renderServicesTable();
    }
  }

  function openBox() {
    document.querySelector(".gsearch").classList.add("open");
    const inp = $("gsInput");
    inp.focus(); inp.select();
    if (inp.value.trim()) render();
  }

  document.addEventListener("DOMContentLoaded", () => {
    const inp = $("gsInput"), box = $("gsResults");
    if (!inp) return;
    inp.addEventListener("input", render);
    inp.addEventListener("focus", () => { if (inp.value.trim()) render(); });
    inp.addEventListener("keydown", e => {
      if (e.key === "ArrowDown" && items.length) { e.preventDefault(); setActive((active + 1) % items.length); }
      else if (e.key === "ArrowUp" && items.length) { e.preventDefault(); setActive((active - 1 + items.length) % items.length); }
      else if (e.key === "Enter") { e.preventDefault(); if (active >= 0) pick(active); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(!box.hidden ? false : true); }
    });
    box.addEventListener("mousedown", e => e.preventDefault());     // keep focus in the box
    box.addEventListener("click", e => {
      const el = e.target.closest(".gs-item");
      if (el) pick(+el.dataset.i);
    });
    $("gsOpenBtn").addEventListener("click", openBox);
    document.addEventListener("click", e => {
      if (!e.target.closest(".gsearch")) { box.hidden = true; if (isPhone()) document.querySelector(".gsearch").classList.remove("open"); }
    });
    document.addEventListener("keydown", e => {
      const t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); openBox(); }
      else if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); openBox(); }
    });
  });
})();
