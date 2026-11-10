/* Light / dark choice for this device. "auto" (the default) follows the device setting.
   Loaded in <head> on every page so the right colours are applied before first paint. */
(function () {
  "use strict";
  var KEY = "mealPlanner.theme";
  function get() {
    try {
      var v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : "auto";
    } catch (e) {
      return "auto";
    }
  }
  function apply(v) {
    var el = document.documentElement;
    if (v === "auto") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", v);
  }
  window.MP_THEME = {
    get: get,
    set: function (v) {
      try {
        if (v === "light" || v === "dark") localStorage.setItem(KEY, v);
        else localStorage.removeItem(KEY);
      } catch (e) {
        /* storage blocked: the choice still applies until the page closes */
      }
      apply(v === "light" || v === "dark" ? v : "auto");
    },
  };
  apply(get());
})();