self.addEventListener('push', event => {
  let data = {};
  try { data = event.data.json(); } catch (e) { data = { title: 'Reminder', body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'Standard Work Tracker';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'sw-reminder',
    data: { url: '/' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
