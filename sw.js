/* Cache only this app's public shell and assets. Account records stay in IndexedDB. */
const base = new URL('./', self.location.href);
const prefix = `ontime-shell:${base.pathname}:`;
const cacheName = `${prefix}v1`;
const shell = new URL('./', base).href;
const assets = new URL('./assets/', base).pathname;
const core = [shell, new URL('./assets/app.css', base).href,
  new URL('./assets/design.css?v=meal-photos-1', base).href, new URL('./assets/fonts/fonts.css', base).href];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(core.map(url => new Request(url, { cache: 'reload' })))));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith(prefix) && name !== cacheName) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') { event.waitUntil(self.skipWaiting()); return; }
  if (event.data?.type !== 'CACHE_ASSETS' || !Array.isArray(event.data.urls)) return;
  const urls = [...new Set(event.data.urls)].filter(value => {
    try { const url = new URL(value); return url.origin === base.origin && url.pathname.startsWith(assets) && /\.(css|woff2)$/.test(url.pathname); }
    catch { return false; }
  });
  event.waitUntil(caches.open(cacheName).then(cache => Promise.all(urls.map(url => cache.add(url).catch(() => {})))));
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== base.origin) return;
  if (request.mode === 'navigate' && (url.pathname === base.pathname || url.pathname === `${base.pathname}index.html`)) {
    event.respondWith((async () => {
      const cache = await caches.open(cacheName);
      try {
        const response = await fetch(request);
        if (response.ok) { await cache.put(shell, response.clone()); return response; }
        return (await cache.match(shell)) ?? response;
      } catch (error) { const cached = await cache.match(shell); if (cached) return cached; throw error; }
    })());
  } else if (url.pathname.startsWith(assets)) {
    event.respondWith((async () => {
      const cache = await caches.open(cacheName), cached = await cache.match(request);
      if (cached) return cached;
      try { const response = await fetch(request); if (response.ok) await cache.put(request, response.clone()); return response; }
      catch (error) { const fallback = await cache.match(request, { ignoreSearch: true }); if (fallback) return fallback; throw error; }
    })());
  }
});
