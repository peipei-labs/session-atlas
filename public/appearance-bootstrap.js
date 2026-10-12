(function () {
  var theme = "dark";
  var shape = "hex";
  // Keep in sync with RETIRED_THEME_MAP in src/client/appearance.ts.
  var RETIRED = { midnight: "dark", sand: "light" };
  var THEMES = ["dark", "light", "emerald", "sakura"];
  function normalizeTheme(value) {
    if (THEMES.indexOf(value) !== -1) return value;
    if (typeof value === "string" && Object.prototype.hasOwnProperty.call(RETIRED, value)) {
      return RETIRED[value];
    }
    return null;
  }
  function normalizeShape(value) {
    return value === "hex" || value === "dot" ? value : null;
  }
  try {
    var saved = JSON.parse(localStorage.getItem("session-atlas.appearance.v2") || "{}");
    var resolvedTheme = normalizeTheme(saved.theme);
    var resolvedShape = normalizeShape(saved.shape);
    if (!resolvedTheme && !resolvedShape) {
      var legacy = JSON.parse(localStorage.getItem("session-atlas.appearance.v1") || "{}");
      resolvedTheme = normalizeTheme(legacy.theme);
      resolvedShape = normalizeShape(legacy.shape);
    }
    if (resolvedTheme) theme = resolvedTheme;
    if (resolvedShape) shape = resolvedShape;
  } catch (error) {}
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.shape = shape;
})();
