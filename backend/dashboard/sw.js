// Installable-app service worker (Chrome needs one with a fetch handler to offer "Install app").
// Network only: nothing is cached, so the app always shows the latest published data.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => { e.respondWith(fetch(e.request)); });
