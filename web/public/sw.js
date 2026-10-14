/*
 * Service worker de TalCloud Panel — notifications push UNIQUEMENT.
 * Aucun gestionnaire « fetch » : aucune réponse (API ou autre) n'est interceptée ni mise en cache.
 */
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

/** N'accepte qu'un chemin relatif de la même origine ; sinon renvoie la racine. */
function safeUrl(raw) {
  try {
    if (typeof raw !== 'string' || raw.charAt(0) !== '/' || raw.charAt(1) === '/' || raw.charAt(1) === '\\') return '/';
    var url = new URL(raw, self.location.origin);
    if (url.origin !== self.location.origin) return '/';
    return url.pathname + url.search + url.hash;
  } catch (e) {
    return '/';
  }
}

self.addEventListener('push', function (event) {
  var payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = {};
  }
  if (!payload || typeof payload !== 'object') payload = {};
  var title = typeof payload.title === 'string' && payload.title ? payload.title.slice(0, 120) : 'TalCloud Panel';
  var options = {
    body: typeof payload.body === 'string' ? payload.body.slice(0, 300) : '',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    data: { url: safeUrl(payload.url) },
  };
  if (typeof payload.tag === 'string' && payload.tag) options.tag = payload.tag.slice(0, 64);
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windows) {
      for (var i = 0; i < windows.length; i++) {
        var client = windows[i];
        if (new URL(client.url).origin !== self.location.origin) continue;
        if ('navigate' in client) {
          return client
            .navigate(target)
            .catch(function () {
              return client;
            })
            .then(function (navigated) {
              return (navigated || client).focus();
            });
        }
        return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
