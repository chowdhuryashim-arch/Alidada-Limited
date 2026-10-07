/* ALIDADA Ledger Book — service worker for phone browser notifications.
   A push only wakes this worker; the message itself is fetched from the
   server over the user's own signed-in session and shown as a notification. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let n = { title: 'ALIDADA Ledger Book', body: 'You have a new message. Open the Ledger Book to see it.', url: '/#/messages', tag: 'ledger' };
      try {
        const res = await fetch('/api/notifications/latest', { credentials: 'include', cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (data && data.notification) n = data.notification;
        }
      } catch {
        /* offline or signed out: show the general message */
      }
      await self.registration.showNotification(n.title, {
        body: n.body,
        tag: n.tag,
        renotify: true,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { url: n.url || '/#/messages' },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of windows) {
        if (new URL(w.url).origin === self.location.origin) {
          await w.focus();
          if ('navigate' in w) await w.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
