/* Service Worker — handles Web Push notifications */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  if (!e.data) return;
  let data = {};
  try { data = e.data.json(); } catch { data = { title: 'RouteOut Alert', body: e.data.text() }; }

  const title = data.title || 'EMERGENCY ALERT';
  const options = {
    body: data.body || 'Open the app for evacuation instructions.',
    icon: '/icon.png',
    badge: '/icon.png',
    tag: 'routeout-alert',
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 400],
    data: { url: self.registration.scope },
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      if (list.length > 0) return list[0].focus();
      return clients.openWindow(e.notification.data?.url || '/');
    })
  );
});
