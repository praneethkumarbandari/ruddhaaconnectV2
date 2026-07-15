// FIX: every page in this app used to carry its own copy-pasted inline
// <script> reading portalTheme from localStorage and applying it —
// meaning adding a new theme variable (text/heading/card/menu/menu-text
// colors) meant editing that same snippet in dozens of files by hand,
// with every missed copy silently staying un-themed. One shared file,
// loaded the same way as any other /js/*.js include, fixes that for
// good: add a variable here once, every page picks it up.
//
// Runs synchronously, as early as possible (include this <script> tag
// before your stylesheets, same position the old inline snippet used),
// so the theme is set before first paint — no flash of default colors.
(function () {
  function hexToRgba(hex, alpha) {
    var h = (hex || '#ffffff').replace('#', '');
    var full = h.length === 3 ? h.split('').map(function (c) { return c + c; }).join('') : h;
    var r = parseInt(full.substring(0, 2), 16); if (isNaN(r)) r = 255;
    var g = parseInt(full.substring(2, 4), 16); if (isNaN(g)) g = 255;
    var b = parseInt(full.substring(4, 6), 16); if (isNaN(b)) b = 255;
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
  }

  try {
    var raw = localStorage.getItem('portalTheme');
    if (!raw) return;
    var t = JSON.parse(raw);
    var root = document.documentElement.style;
    if (t.primary_color) root.setProperty('--primary-color', t.primary_color);
    if (t.secondary_color) root.setProperty('--secondary-color', t.secondary_color);
    if (t.background_color) root.setProperty('--background-color', t.background_color);
    if (t.font_family) root.setProperty('--font-family', t.font_family);
    if (t.text_color) root.setProperty('--text-color', t.text_color);
    if (t.heading_color) root.setProperty('--heading-color', t.heading_color);
    if (t.card_color) root.setProperty('--card-color', hexToRgba(t.card_color, 0.55));
    if (t.kpi_title_color) root.setProperty('--kpi-title-color', t.kpi_title_color);
    if (t.kpi_content_color) root.setProperty('--kpi-content-color', t.kpi_content_color);
    if (t.menu_color) root.setProperty('--menu-color', t.menu_color);
    if (t.menu_text_color) root.setProperty('--menu-text-color', t.menu_text_color);
  } catch (e) {
    // Corrupt localStorage value — fall back to variables.css defaults,
    // same as every page already did before this existed.
  }
})();
