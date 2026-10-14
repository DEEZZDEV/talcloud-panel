/*
 * Applique le thème avant le premier rendu (aucun flash). La valeur mémorisée n'est qu'un cache d'affichage :
 * la préférence du compte, lue sur le serveur après la connexion, fait foi. Valeurs : dark | light | system.
 */
(function () {
  var preference = 'dark';
  try {
    var stored = window.localStorage.getItem('tc-theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') preference = stored;
  } catch (e) {
    /* stockage indisponible : thème sombre par défaut */
  }
  var theme = preference;
  if (preference === 'system') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  var root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0c0c0e' : '#fafafa');
})();
