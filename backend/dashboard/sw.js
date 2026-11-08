// Installable-app service worker (Chrome needs one with a fetch handler to offer "Install app").
// Network only, and ONLY for this site's own GET requests: requests to other origins (the fonts) and non-GETs (the Run
// and edit buttons) are left to the browser. A service worker's own fetch() obeys the site's CSP connect-src 'self',
// so passing other origins through here blocked them (fix 2026-11-07: "chart library not loaded"; the chart library
// is now served from this site too, vendor/chart.umd.min.js). Nothing is cached: the app always shows the latest data.
// Change VERSION whenever this file changes: a changed byte makes every installed copy pick up the new worker at once
// (skipWaiting + clients.claim; sw.js is served no-cache and registered with updateViaCache 'none').
const VERSION = '2026-11-07.3';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(fetch(e.request));
});
