// Network-first for the app shell (so deploys show up), cache fallback for offline.
const C = 'swr-v2';
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(['/', '/style.css', '/app.js'])).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok || r.type === 'opaque') { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); }
    return r;
  }).catch(() => caches.match(e.request).then(hit => hit || caches.match('/'))));
});
