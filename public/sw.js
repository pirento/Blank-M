/**
 * Service worker: makes Blank installable, keeps static files available
 * offline and shows push notifications (price alerts).
 *
 * Pages and API responses are private and never cached; when the network is
 * down a page request gets a small offline notice instead.
 */
const VERSION = 'blank-static-v1';
const PRECACHE = [
  '/css/app.css',
  '/icons.svg',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/manifest.webmanifest',
];
const STATIC_PREFIXES = ['/css/', '/js/', '/shared/', '/vendor/', '/fonts/', '/icons/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline · Blank</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090b0c;color:#e8ecea;
font:16px system-ui,sans-serif;text-align:center;padding:24px}p{color:#9aa5a1}</style></head>
<body><main><h1>You are offline</h1><p>Blank needs a connection to load your journal.<br>
Reconnect and refresh.</p></main></body></html>`;

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(OFFLINE_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
      ),
    );
    return;
  }
  if (
    !STATIC_PREFIXES.some((prefix) => url.pathname.startsWith(prefix)) &&
    !PRECACHE.includes(url.pathname)
  ) {
    return;
  }
  // Static files: serve the cached copy at once and refresh it in the background.
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data?.text() };
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Blank', {
      body: payload.body || '',
      tag: payload.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: payload.url || '/dashboard' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/dashboard', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => client.url === target);
      return open ? open.focus() : self.clients.openWindow(target);
    }),
  );
});
