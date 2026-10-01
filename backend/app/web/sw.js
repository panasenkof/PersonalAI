// Only a public offline page is cached. Conversations, tokens, API responses and
// application scripts always come from the network: no stale app or private data.
const CACHE = 'pia-offline-v1';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.add('./offline.html')));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('pia-offline-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || event.request.mode !== 'navigate' || !new URL(event.request.url).pathname.startsWith('/app/')) return;
  event.respondWith(fetch(event.request).catch(() => caches.match('./offline.html')));
});
