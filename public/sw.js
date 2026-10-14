/* Service worker: szybki start i działanie powłoki offline. API i WebSocket zawsze idą przez sieć. */
const V = 'nakartce-v8';
const SHELL = ['/', '/css/base.css', '/css/app.css', '/js/app.js', '/js/api.js', '/js/boards.js', '/js/extras.js', '/js/forum.js', '/js/offline.js', '/js/offline-worker.js', '/shared/engines.js', '/shared/bbcode.js', '/config.js', '/manifest.webmanifest'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return;
  /* nic prywatnego ani dynamicznego nie trafia do cache: API, WebSocket, panel admina, wgrane pliki, pluginy, healthcheck */
  if (/^\/(api\/|ws$|admin|uploads\/|plugins\/|health$)/.test(u.pathname)) return;
  e.respondWith(fetch(req).then((r) => {
    if (r.ok && r.type === 'basic') { const c = r.clone(); caches.open(V).then((ch) => ch.put(req, c)); }   // tylko poprawne odpowiedzi własnej domeny
    return r;
  }).catch(() => caches.match(req).then((m) => m || (req.mode === 'navigate' ? caches.match('/') : undefined) || new Response('Brak połączenia', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))));
});
