/* Applique le thème mémorisé avant le premier rendu (aucun flash). Seule la préférence de thème est stockée. */
(function () {
  var theme = 'dark';
  try {
    var stored = window.localStorage.getItem('tc-theme');
    if (stored === 'light' || stored === 'dark') theme = stored;
  } catch (e) {
    /* stockage indisponible : thème sombre par défaut */
  }
  var root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0c0c0e' : '#fafafa');
})();
