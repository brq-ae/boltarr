// Narrow screens (F-12): Hosts and Services tables hide their least useful
// columns automatically until the table fits, instead of squeezing text into
// neighbouring cells. A column pinned in Columns ▾ (📌) never auto-hides; if the
// pinned ones don't fit, the table scrolls sideways instead.
//
// Every column has a width it needs (px). The table gets table-layout: fixed with
// those widths; the "flex" column takes whatever is left. Cells stay on one line
// and end in "…"; hovering a cut-off cell shows its full text.
//
// State per browser: the existing hidden-columns lists (Columns ▾ checkboxes) plus
// a pinned list. Auto-hidden columns are only a display state, never saved.

(function () {
  const TABLES = {
    hostsTable: {
      menu: "colMenu", hiddenKey: "boltarr.hostsHiddenCols", pinKey: "boltarr.hostsPinnedCols",
      prefix: "hide-", flex: "host",
      // th selector per column key, and the width it needs
      cols: { check: [".td-check", 34], ip: [".td-ip", 180], host: [".col-host", 140], mac: [".col-mac", 150],
              vendor: [".col-vendor", 160], type: [".col-type", 170], os: [".col-os", 160],
              ports: [".col-ports", 190], seen: [".col-seen", 130], notes: [".col-notes", 180] },
      order: ["os", "vendor", "notes", "ports", "mac", "seen", "type"],   // first to hide → last
    },
    servicesTable: {
      menu: "svcColMenu", hiddenKey: "boltarr.svcHiddenCols", pinKey: "boltarr.svcPinnedCols",
      prefix: "hide-svc-", flex: "name",
      cols: { check: [".td-check", 34], icon: [".col-svc-icon", 52], name: [".col-svc-name", 220],
              host: [".col-svc-host", 160], ps: [".col-svc-ps", 190], mon: [".col-svc-mon", 90],
              pub: [".col-svc-pub", 80], url: [".col-svc-url", 200] },
      order: ["icon", "url", "pub", "mon", "ps"],
    },
  };
  const load = k => { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch (e) { return []; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const autoHidden = {};

  function fit(id) {
    const cfg = TABLES[id], table = document.getElementById(id);
    const wrap = table && table.parentElement;
    if (!wrap || !wrap.clientWidth) return;            // tab not visible: refit when it shows
    const cs = getComputedStyle(wrap);
    const avail = wrap.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const hidden = load(cfg.hiddenKey), pinned = load(cfg.pinKey);
    const shown = Object.keys(cfg.cols).filter(k => !hidden.includes(k));
    let need = shown.reduce((a, k) => a + cfg.cols[k][1], 0);
    const auto = [];
    for (const k of cfg.order) {
      if (need <= avail) break;
      if (shown.includes(k) && !pinned.includes(k)) { auto.push(k); need -= cfg.cols[k][1]; }
    }
    autoHidden[id] = auto;
    Object.keys(cfg.cols).forEach(k => table.classList.toggle("auto-" + k, auto.includes(k)));
    table.style.minWidth = need + "px";                 // pinned columns that don't fit → scroll sideways
    for (const [k, [sel, w]] of Object.entries(cfg.cols)) {
      const th = table.querySelector(`thead th${sel}`);
      if (th) th.style.width = k === cfg.flex ? "" : w + "px";
    }
    syncMenu(id);
  }

  function syncMenu(id) {
    const cfg = TABLES[id], menu = document.getElementById(cfg.menu);
    if (!menu) return;
    const pinned = load(cfg.pinKey), auto = autoHidden[id] || [];
    menu.querySelectorAll("label").forEach(l => {
      const k = l.querySelector("input[data-col]")?.dataset.col;
      const pin = l.querySelector(".col-pin");
      l.classList.toggle("auto-hidden", auto.includes(k));
      l.title = auto.includes(k) ? "Hidden for now: not enough room. Pin it (📌) to always show it." : "";
      if (pin) {
        const on = pinned.includes(k);
        pin.classList.toggle("on", on);
        pin.setAttribute("aria-pressed", on ? "true" : "false");
        pin.title = on ? "Pinned: always shown (unpin to let it hide on narrow screens)"
                       : "Pin: always show, even on narrow screens";
      }
    });
  }

  function init(id) {
    const cfg = TABLES[id], table = document.getElementById(id), menu = document.getElementById(cfg.menu);
    if (!table) return;
    table.classList.add("fit-cols");
    menu?.querySelectorAll("label").forEach(l => {
      const k = l.querySelector("input[data-col]")?.dataset.col;
      if (!cfg.order.includes(k)) return;                // never auto-hides → nothing to pin
      const b = document.createElement("button");
      b.type = "button"; b.className = "col-pin"; b.textContent = "📌";
      b.setAttribute("aria-label", "Pin column");
      b.addEventListener("click", e => {
        e.preventDefault(); e.stopPropagation();          // don't tick the label's checkbox
        const p = load(cfg.pinKey);
        save(cfg.pinKey, p.includes(k) ? p.filter(x => x !== k) : [...p, k]);
        fit(id);
      });
      l.appendChild(b);
    });
    // Checkbox changes (handled in app/hosts.js, app/services.js) → refit after they've been saved
    menu?.addEventListener("change", () => setTimeout(() => fit(id), 0));
    if (window.ResizeObserver) new ResizeObserver(() => fit(id)).observe(table.parentElement);
    else window.addEventListener("resize", () => fit(id));
    fit(id);
  }
  window.fitColumns = id => (id ? [id] : Object.keys(TABLES)).forEach(fit);

  // Full text of a cut-off cell on hover (Hosts, Services, IP History)
  document.addEventListener("mouseover", e => {
    const td = e.target.closest && e.target.closest("table.fit-cols td, #iphTable td");
    if (!td || td.querySelector("input, select, textarea")) return;
    if (td.scrollWidth > td.clientWidth + 1 || [...td.querySelectorAll("*")].some(x => x.scrollWidth > x.clientWidth + 1 && getComputedStyle(x).overflow === "hidden")) {
      if (!td.title) td.title = td.innerText.replace(/[✎＋]/g, "").replace(/\s+/g, " ").trim();
    }
  });

  // Drop-down menus (Columns ▾, Export ▾) open right-aligned to their button. On
  // a phone the button can sit near the left edge, pushing the menu off screen:
  // nudge any menu that just opened back inside the viewport.
  function keepOnScreen() {
    document.querySelectorAll(".col-menu.open").forEach(m => {
      m.style.right = ""; m.style.maxWidth = "";
      const vw = document.documentElement.clientWidth, gap = 8;
      m.style.maxWidth = (vw - 2 * gap) + "px";
      const r = m.getBoundingClientRect();
      if (r.left < gap) m.style.right = (r.left - gap) + "px";            // negative right → moves it right
      else if (r.right > vw - gap) m.style.right = (r.right - (vw - gap)) + "px";
    });
  }
  document.addEventListener("click", () => setTimeout(keepOnScreen, 0), true);   // capture: the Columns button stops propagation
  window.addEventListener("resize", keepOnScreen);

  document.addEventListener("DOMContentLoaded", () => Object.keys(TABLES).forEach(init));
})();
