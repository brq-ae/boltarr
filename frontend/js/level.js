// Boltarr — sets the view level (Basic / Intermediate / Advanced, S-15) before the
// page is drawn, so nothing hidden at this level flashes up first. Each browser
// keeps its own; one with none yet shows everything until the app asks the server
// which level to start on (js/app/levels.js).
(function () {
  var l = null;
  try { l = localStorage.getItem("boltarr.viewLevel"); } catch (e) {}
  document.documentElement.setAttribute("data-level",
    l === "basic" || l === "intermediate" || l === "advanced" ? l : "advanced");
  // Which features were set up last time (AI, public status page), so their buttons
  // don't flash up at Basic before the app checks again
  try {
    var r = JSON.parse(localStorage.getItem("boltarr.ready") || "{}");
    for (var f in r) document.documentElement.setAttribute("data-" + f, r[f] ? "on" : "off");
  } catch (e) {}
})();
