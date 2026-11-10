// Export (S-03): Hosts, Services and IP History as CSV or JSON.
//
// Exports the rows the table shows right now (search, filters and sort
// applied) with every column, hidden ones included. Built in the browser from
// data already loaded, so there's no server side.
//
// CSV safety: a device can announce a name like "=HYPERLINK(...)". Spreadsheet
// apps run cells starting with = + - @ (or a tab/CR) as formulas, so those get a
// leading ' and stay plain text.

(function () {
  const pad = n => String(n).padStart(2, "0");

  // A saved file. Shared with the chat's Download button.
  function downloadFile(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  window.downloadFile = downloadFile;

  function csvCell(v) {
    if (v == null) return "";
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function toCSV(cols, rows) {
    const lines = [cols.map(c => csvCell(c[0]))];
    rows.forEach(r => lines.push(cols.map(c => csvCell(c[1](r)))));
    // BOM so Excel reads accents/Arabic correctly; CRLF is the CSV standard.
    return "﻿" + lines.map(l => l.join(",")).join("\r\n") + "\r\n";
  }

  // Timestamps in CSV: "2026-11-09 14:03" in Boltarr's time zone, which
  // spreadsheets read as a date. JSON keeps the stored values.
  function csvTime(ts) {
    const d = typeof _toDate === "function" ? _toDate(ts) : (ts ? new Date(ts) : null);
    if (!d || isNaN(d)) return "";
    try {
      return d.toLocaleString("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false, timeZone: (typeof APP_TZ !== "undefined" && APP_TZ) || undefined });
    } catch (e) { return d.toISOString().slice(0, 16).replace("T", " "); }
  }

  const yesNo = v => v ? "yes" : "no";
  const openPorts = h => (h.ports || []).filter(p => p.state === "open");

  const TABLES = {
    hosts: {
      file: "hosts",
      rows: () => hostsVisibleRows().filter(h => !String(h.ip).startsWith("node-")),
      csv: [
        ["IP", h => h.ip], ["Hostname", h => h.hostname], ["MAC", h => h.mac], ["Vendor", h => h.vendor],
        ["Type", h => h.device_type], ["OS", h => h.os_guess], ["IP type", h => h.classification],
        ["Online", h => h.online == null ? "" : yesNo(h.online)],
        ["Open ports", h => openPorts(h).map(p => `${p.port}/${p.protocol || "tcp"}${p.service ? " " + p.service : ""}`).join(", ")],
        ["Aliases", h => (h.aliases || []).join(", ")], ["Notes", h => h.notes], ["Source", h => h.source],
        ["First seen", h => csvTime(h.first_seen)], ["Last seen", h => csvTime(h.last_seen)],
      ],
      json: h => ({
        ip: h.ip, hostname: h.hostname, mac: h.mac, vendor: h.vendor, type: h.device_type, os: h.os_guess,
        ip_type: h.classification, online: h.online == null ? null : !!h.online,
        open_ports: openPorts(h).map(p => ({ port: p.port, protocol: p.protocol || "tcp",
                                              service: p.service || null, version: p.version || null })),
        aliases: h.aliases || [], notes: h.notes, source: h.source,
        first_seen: h.first_seen, last_seen: h.last_seen,
      }),
    },
    services: {
      file: "services",
      rows: () => servicesVisibleRows(),
      csv: [
        ["Name", s => s.name], ["Description", s => s.description], ["Host IP", s => s.ip],
        ["Hostname", s => s.hostname], ["Port", s => s.port], ["Protocol", s => s.port ? (s.protocol || "tcp") : ""],
        ["Status", s => s.status], ["Monitored", s => yesNo(s.monitored)], ["Check", s => s.check_type],
        ["Public", s => yesNo(s.public)], ["Public name", s => s.public_name], ["URL", s => s.url],
        ["Container IP", s => s.container_ip],
      ],
      json: s => ({
        name: s.name, description: s.description, host_ip: s.ip, hostname: s.hostname,
        port: s.port, protocol: s.port ? (s.protocol || "tcp") : null, status: s.status,
        monitored: !!s.monitored, check: s.check_type || null, public: !!s.public,
        public_name: s.public_name || null, url: s.url || null, container_ip: s.container_ip || null,
      }),
    },
    iphistory: {
      file: "ip-history",
      rows: () => iphVisibleRows(),
      csv: [
        ["Status", r => (_IPH_STATUS[r.status] || {}).label || r.status], ["IP", r => r.ip],
        ["Days since seen", r => r.status === "never" ? "" : r.days], ["Last seen", r => csvTime(r.last_seen)],
        ["Hostname", r => r.hostname], ["MAC", r => r.mac], ["Vendor", r => r.vendor],
        ["First seen", r => csvTime(r.first_seen)], ["Alias of", r => r.alias_of],
        ["Different device since", r => r.mac_change ? csvTime(r.mac_change.ts) : ""],
      ],
      json: r => ({
        status: r.status, ip: r.ip, days_since_seen: r.status === "never" ? null : r.days,
        last_seen: r.last_seen || null, hostname: r.hostname || null, mac: r.mac || null,
        vendor: r.vendor || null, first_seen: r.first_seen || null, alias_of: r.alias_of || null,
        different_device_since: r.mac_change ? r.mac_change.ts : null,
      }),
    },
  };

  function exportTable(kind, fmt) {
    const t = TABLES[kind];
    if (!t) return;
    const rows = t.rows();
    if (!rows.length) return typeof showToast === "function" && showToast("Nothing to export");
    const d = new Date();
    let name = `boltarr-${t.file}`;
    if (kind === "iphistory") {
      const sel = document.getElementById("iphSubnet");
      const label = sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent.split("·")[0] : "";
      const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (slug) name += `-${slug}`;
    }
    name += `-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (fmt === "json") downloadFile(name + ".json", JSON.stringify(rows.map(t.json), null, 2) + "\n", "application/json");
    else                downloadFile(name + ".csv", toCSV(t.csv, rows), "text/csv;charset=utf-8");
    if (typeof showToast === "function") showToast(`Exported ${rows.length} row${rows.length === 1 ? "" : "s"}`);
  }
  window.exportTable = exportTable;

  // ⤓ Export ▾ menus: <div class="export-wrap"><button data-export-btn> + .col-menu with data-export buttons
  document.addEventListener("click", e => {
    const btn = e.target.closest("[data-export-btn]");
    const item = e.target.closest("[data-export]");
    document.querySelectorAll(".export-wrap .col-menu.open").forEach(m => {
      if (!btn || !btn.parentElement.contains(m)) m.classList.remove("open");
    });
    if (btn) { btn.parentElement.querySelector(".col-menu").classList.toggle("open"); return; }
    if (item) {
      item.closest(".col-menu").classList.remove("open");
      exportTable(item.dataset.export, item.dataset.fmt);
    }
  });
})();
