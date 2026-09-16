self.addEventListener('install', event => {
  // Activate the new service worker as soon as it's installed, don't wait for old tabs to close
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  // Take control of any already-open pages immediately
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data.json(); } catch (e) { data = { title: 'Reminder', body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'Leadership Standard Work';
  const hasIds = data.data && data.data.ids && data.data.ids.length;

  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'lsw-reminder',
    data: { url: '/', ids: hasIds ? data.data.ids : null, date: hasIds ? data.data.date : null },
    actions: hasIds ? [
      { action: 'mark-done', title: '✓ Mark all done' },
      { action: 'open', title: 'Open app' }
    ] : []
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const { ids, date, url } = event.notification.data || {};

  if (event.action === 'mark-done' && ids && ids.length) {
    event.waitUntil(
      fetch('/api/completions/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_ids: ids, date })
      }).then(() => {
        return self.registration.showNotification('Marked done ✓', {
          body: `${ids.length} activities marked complete`,
          icon: '/icon-192.png',
          tag: 'lsw-confirm'
        });
      }).catch(() => {})
    );
    return;
  }

  // Default click, or "Open app" action: focus/open the app
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url || '/');
    })
  );
});
